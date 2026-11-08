// Drives the real Story Engine code (real CodeMirror, Obsidian stand-in) through the 2.1 workflows.
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path'); const assert = require('assert/strict');
const SHOTS = process.argv[2];
const fx = n => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const FILES = { 'ASOIAF Sample/01 Prologue.md': fx('01 Prologue.md'), 'ASOIAF Sample/02 Bran.md': fx('02 Bran.md'), 'ASOIAF Sample/03 Catelyn.md': fx('03 Catelyn.md'), 'ASOIAF Sample/ASOIAF Sample.md': fx('ASOIAF Sample.md'), 'Maps/World map.png': 'png' };

(async () => {
  const b = await chromium.launch();
  const errors = [];
  const open = async files => {
    const page = await b.newPage({ viewport: { width: 1700, height: 1050 } });
    page.on('pageerror', e => errors.push(e.message)); page.on('console', m => m.type() === 'error' && errors.push(m.text()));
    await page.goto('file://' + path.join(__dirname, 'harness.html'));
    await page.evaluate(async files => boot(files), files);
    return page;
  };
  let page = await open(FILES);
  const step = async (n, f) => { try { await f(); console.log('✓', n); } catch (e) { console.log('✗', n, '\n ', e.message.split('\n').slice(0, 12).join('\n  ')); console.log('  notices:', await page.evaluate(() => __notices.slice(-5))); if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'v21-fail.png') }); throw e; } };
  const file = p => page.evaluate(p => app.vault.files.get(p)?.data, p);
  const fm = p => page.evaluate(p => app.metadataCache.cache.get(p)?.frontmatter, p);
  const data = async () => JSON.parse(await file('ASOIAF Sample/story-engine.json'));
  const wait = ms => page.waitForTimeout(ms);
  const cm = () => 'app.workspace.getLeavesOfType("markdown")[0].view.cm';
  const cursorAt = async (needle, nth = 0) => page.evaluate(([needle, nth]) => { const v = app.workspace.getLeavesOfType('markdown')[0].view.cm; const d = v.state.doc.toString(); let i = -1; for (let k = 0; k <= nth; k++) i = d.indexOf(needle, i + 1); v.focus(); v.dispatch({ selection: { anchor: i }, scrollIntoView: true }); return i; }, [needle, nth]);
  // Select text in the open editor and release the mouse, like a user highlighting.
  const highlight = async (needle, nth = 0) => {
    const ok = await page.evaluate(([needle, nth]) => {
      const v = app.workspace.getLeavesOfType('markdown')[0].view.cm; const doc = v.state.doc.toString();
      let i = -1; for (let k = 0; k <= nth; k++) i = doc.indexOf(needle, i + 1); if (i < 0) return false;
      v.dispatch({ selection: { anchor: i, head: i + needle.length }, scrollIntoView: true }); return true;
    }, [needle, nth]);
    if (!ok) throw new Error('text not found: ' + needle);
    await wait(80);
    await page.evaluate(() => { const v = app.workspace.getLeavesOfType('markdown')[0].view.cm; v.contentDOM.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 })); });
    await wait(250);
  };
  const pop = () => page.locator('.se-pop');
  const world = () => page.locator('.se-world');
  const sceneBar = n => page.locator(`.se-scenebar:has(.se-scenebar-label:text-is("Scene ${n}"))`);
  const view = async () => (await page.evaluate(() => plugin.activeProject().data.view));
  const readout = () => page.locator('.se-maptag').textContent();
  const mapBox = () => page.locator('.se-map').boundingBox();

  await step('no story yet: World shows set-up; set up "ASOIAF Sample" from its folder', async () => {
    await page.evaluate(() => plugin.openWorld()); await wait(200);
    assert.ok(await page.isVisible('text=No story yet'));
    await page.click('text=Set up a story…');
    await page.evaluate(() => __fuzzy.choose('ASOIAF Sample')); await wait(400);
    assert.ok(await file('ASOIAF Sample/story-engine.json'), 'data file created');
    assert.equal(await page.inputValue('.se-story-pick'), 'ASOIAF Sample');
    for (const sel of ['.se-map', '.se-side', '.se-dock', '.se-overview']) assert.ok(await page.isVisible(sel), sel);
    const m = await mapBox(); assert.ok(Math.abs(m.width - m.height) < 2, 'the map is square');
  });

  await step('open chapter 02: book look, Aa fold, scene bars; timeline has all 6 scenes in reading order', async () => {
    await page.evaluate(async () => { const l = app.workspace.getLeaf(); await l.openFile(app.vault.getAbstractFileByPath('ASOIAF Sample/02 Bran.md')); });
    await wait(300);
    assert.ok(await page.$('.manuscript .cm-line.mm-dropcap'));
    assert.ok(await page.isVisible('.se-look-aa'), 'Aa fold');
    assert.equal(await page.evaluate(() => { const v = app.workspace.getLeavesOfType('markdown')[0].view; const m = v.contentEl.querySelector('.manuscript').createDiv('metadata-container'); m.textContent = 'Properties'; const shown = m.offsetHeight > 0; m.remove(); return shown; }), false, 'Properties hidden in chapters');
    const bars = await page.$$eval('.se-scenebar', e => e.map(x => x.textContent));
    assert.match(bars[0], /^Scene 2/, bars[0]);
    assert.match(bars[0], /When: continues/);
    assert.equal(await page.$$eval('.se-clip', e => e.length), 6);
    assert.equal(await page.$$eval('.se-clip', e => new Set(e.map(c => c.style.left)).size), 6, 'one slot each');
  });

  await step('follow cursor: the playhead follows the scene the cursor is in', async () => {
    await cursorAt('The young boy noticed'); await wait(500);
    assert.equal(await view(), 3);
    assert.match(await readout(), /Scene 3 of 6/);
    await cursorAt('Excited as the boy'); await wait(500);
    assert.equal(await view(), 2);
  });

  await step('capture: highlight "Bran" → Character → description → connection → Where (no When step)', async () => {
    await highlight('Bran was on the cusp'.slice(0, 5));
    await pop().locator('text=Add to your world').waitFor();
    assert.equal(await pop().locator('.se-namefield').inputValue(), 'Bran');
    await pop().locator('[data-type="character"]').click(); await wait(250);
    assert.ok(await file('ASOIAF Sample/World/Characters/Bran.md'), 'piece note created');
    assert.equal(await view(), 2, 'follow cursor is paused while the box is open');
    await highlight('Small for his age, he climbed the old towers every day.');
    assert.match(await file('ASOIAF Sample/World/Characters/Bran.md'), /> Small for his age[^\n]*\n> — \[\[(ASOIAF Sample\/)?02 Bran\]\]/);
    await pop().locator('button:has-text("Next")').click(); await wait(150);
    await pop().locator('.se-or input').fill('Gared'); await pop().locator('.se-or button').click(); await wait(150);
    await pop().locator('[data-type="character"]').click(); await wait(250);
    await pop().locator('.se-preset:has-text("Sibling")').click(); await wait(250);
    assert.deepEqual((await fm('ASOIAF Sample/World/Characters/Bran.md')).connections, ['[[Gared]] · Sibling']);
    await pop().locator('button:has-text("Next")').click(); await wait(150);
    assert.match(await pop().textContent(), /This scene has no location yet/);
    const mini = await pop().locator('.se-mini').boundingBox();
    await page.mouse.click(mini.x + mini.width * .7, mini.y + mini.height * .55);
    await pop().locator('.se-newplace input').fill('Farmhouse'); await pop().locator('.se-newplace input').press('Enter'); await wait(600);
    assert.equal(await pop().isVisible(), false, 'box closed');
    const ch = await file('ASOIAF Sample/02 Bran.md'); assert.match(ch, /✦ ✦ ✦\n%% se-scene id=\w+ where=\w+ %%\n/, 'the pick became the scene\'s place: ' + ch.slice(0, 160));
    assert.ok(await page.isVisible('.notice .se-undo-link'), 'Undo in the notice');
    const tokens = await page.$$eval('.se-tok .se-n', e => e.map(x => x.textContent));
    assert.ok(tokens.includes('Bran') && tokens.includes('Gared'), 'tokens: ' + tokens);
    assert.ok(await page.$('.se-pin:has-text("Farmhouse")'));
    assert.equal(await page.$$eval('.se-lines line', e => e.length), 1, 'sibling line');
    assert.equal(await page.isVisible('.se-legend'), false, 'the legend is off until you turn it on');
    await page.locator('.se-hud button[aria-label^="Legend"]').click(); await wait(200);
    assert.ok(await page.isVisible('.se-legend:has-text("Sibling")'), 'legend shows the visible line');
    assert.ok(await page.isVisible('.se-card-title:has-text("Bran")'), 'card shown');
    assert.match(await page.locator('.se-card .se-conn').first().textContent(), /Sibling of Gared/);
  });

  await step('card: × removes a quote; “+ Add” then highlight adds one; incoming connections read clearly', async () => {
    assert.equal(await page.$$eval('.se-card .se-quote', e => e.length), 1);
    await page.locator('.se-card .se-quote').first().hover(); await page.locator('.se-card .se-quote .se-x').first().click(); await wait(300);
    assert.equal(await page.$$eval('.se-card .se-quote', e => e.length), 0);
    assert.doesNotMatch(await file('ASOIAF Sample/World/Characters/Bran.md'), /Small for his age/);
    await page.locator('.se-card .se-grp-row:has-text("Description") .se-add').click(); await wait(200);
    assert.ok(await pop().isVisible(), 'capture box waits for a highlight');
    await highlight('His father had taught him to watch and listen');
    await wait(300);
    assert.match(await file('ASOIAF Sample/World/Characters/Bran.md'), /> His father had taught him/);
    assert.equal(await page.$$eval('.se-card .se-quote', e => e.length), 1);
    await page.locator('.se-row:has-text("Gared")').click(); await wait(300);
    assert.match(await page.locator('.se-card .se-conn.is-incoming').textContent(), /Bran — sibling of Gared/);
  });

  await step('clicking away closes the capture box', async () => {
    await page.locator('.se-card .se-grp-row:has-text("Connections") .se-add').click(); await wait(200);
    assert.ok(await pop().isVisible());
    await page.mouse.click(5, 5); await wait(150);
    assert.equal(await pop().isVisible(), false);
  });

  await step('a new piece in the same scene: the capture box suggests joining the others', async () => {
    await page.evaluate(() => plugin.activeProject().setView(4)); await wait(300);
    await page.click('.se-catalog .se-new-piece'); await wait(150);
    await pop().locator('.se-namefield').fill('Farm dog'); await pop().locator('[data-type="creature"]').click(); await wait(250);
    await pop().locator('button:has-text("Next")').click(); await wait(150);
    await pop().locator('button:has-text("Next")').click(); await wait(250);
    assert.match(await pop().locator('.se-suggest').textContent(), /With Bran and Gared at Farmhouse/);
    assert.ok(await pop().isVisible('.se-mini'), 'mini-map right under it');
    if (SHOTS) await pop().screenshot({ path: path.join(SHOTS, 'capture-where.png') });
    await pop().locator('.se-suggest').click(); await wait(500);
    const d = await data(), dog = await page.evaluate(() => [...plugin.activeProject().pieces.values()].find(p => p.name === 'Farm dog').id);
    const farm = await page.evaluate(() => [...plugin.activeProject().pieces.values()].find(p => p.name === 'Farmhouse').id);
    assert.equal(d.track[dog][0].place, farm);
  });

  await step('When: time skip, same time as, flashback; the timeline shows them', async () => {
    await cursorAt('✦ ✦ ✦', 0); await wait(400);
    await sceneBar(4).locator('.se-chip:has-text("When")').waitFor({ timeout: 2000 }).catch(() => cursorAt('✦ ✦ ✦', 1));
    await wait(300);
    await sceneBar(4).locator('.se-chip:has-text("When")').click(); await wait(200);
    await pop().locator('.se-bigchoice:has-text("Time skip")').click();
    await pop().locator('.se-newmoment .se-namefield').first().fill('Two years later'); await pop().locator('.se-newmoment .se-namefield').first().press('Enter'); await wait(800);
    assert.ok(await page.isVisible('.se-skiplabel:has-text("Two years later")'), 'skip break on the timeline');
    assert.equal((await data()).moments.find(m => m.skipText === 'Two years later')?.skip, true, 'the skip text is kept with the moment');
    // Catelyn's chapter runs alongside Bran's first scene; its second scene is a flashback to scene 3.
    await page.evaluate(async () => { const l = app.workspace.getLeavesOfType('markdown')[0]; await l.openFile(app.vault.getAbstractFileByPath('ASOIAF Sample/03 Catelyn.md')); });
    await wait(400);
    await cursorAt('# CATELYN'); await wait(300);
    await sceneBar(5).locator('.se-chip:has-text("When")').click(); await wait(200);
    await pop().locator('.se-bigchoice:has-text("Same time as")').click(); await wait(100);
    await pop().locator('.se-menu button:has-text("Bran · 1")').click(); await wait(800);
    await cursorAt('✦ ✦ ✦'); await wait(400);
    await sceneBar(6).locator('.se-chip:has-text("When")').click(); await wait(200);
    await pop().locator('.se-bigchoice:has-text("Flashback to")').click(); await wait(100);
    await pop().locator('.se-menu button:has-text("Bran · 2")').click(); await wait(800);
    const tl = await page.evaluate(async () => (await plugin.activeProject().timeline()).scenes.map(s => [s.order, s.slot, s.kind]));
    assert.deepEqual(tl, [[1, 0, 'next'], [2, 1, 'next'], [3, 2, 'next'], [4, 3, 'next'], [5, 1, 'parallel'], [6, 2, 'flashback']]);
    assert.match(await file('ASOIAF Sample/03 Catelyn.md'), /%% se-scene with=\w+ %%/);
    assert.match(await sceneBar(6).textContent(), /flashback/i);
  });

  await step('editing a scene bar keeps the page where it is', async () => {
    await cursorAt('✦ ✦ ✦'); await wait(400);
    const scroller = () => page.evaluate(() => app.workspace.getLeavesOfType('markdown')[0].view.cm.scrollDOM.scrollTop);
    const before = await scroller();
    assert.ok(before > 150, 'scrolled down: ' + before);
    await sceneBar(6).locator('.se-chip-pov').click(); await wait(200);
    await pop().locator('.se-menu button:has-text("Bran")').click(); await wait(1500);
    assert.match(await sceneBar(6).textContent(), /POV: Bran/);
    assert.ok(Math.abs(await scroller() - before) < 60, `stayed put: ${before} → ${await scroller()}`);
  });

  await step('timeline arrows and keys: readout explains jumps; flashback turns the map sepia', async () => {
    await page.evaluate(() => plugin.activeProject().setView(4)); await wait(300);
    await page.locator('.se-bar button[data-step="next"]').click(); await wait(300);
    assert.equal(await view(), 5);
    assert.match(await readout(), /↶ Earlier · alongside Bran · 1/);
    await page.locator('.se-world').focus();
    await page.keyboard.press('ArrowRight'); await wait(300);
    assert.equal(await view(), 6);
    assert.match(await readout(), /↶ Flashback/);
    assert.ok(await page.$('.se-map.is-flashback'), 'sepia');
    assert.match(await page.locator('.se-flashbanner').textContent(), /FLASHBACK.*first told in Bran · 2/);
    await page.keyboard.press('Shift+ArrowLeft'); await wait(300);
    assert.ok([1, 2].includes(await view()), 'moment/chapter step back: ' + await view());
    await page.evaluate(() => plugin.activeProject().setView(2)); await wait(300);
    await page.locator('.se-bar button[data-step="next-moment"]').click(); await wait(300);
    assert.equal(await view(), 4, 'next named moment is the time skip');
    assert.match(await readout(), /Two years later/);
  });

  await step('moments on the ruler: click to rename; drag the edge to move where it starts', async () => {
    await page.locator('.se-band').first().click(); await wait(150);
    assert.ok(await page.isVisible('.se-momentbox'));
    await page.locator('.se-momentbox .se-namefield').fill('Two years on'); await page.locator('.se-momentbox .se-namefield').press('Enter'); await wait(500);
    assert.equal(await page.isVisible('.se-momentbox'), false);
    assert.ok((await data()).moments.some(m => m.label === 'Two years on'));
    const ed = await page.locator('.se-edge').first().boundingBox(), c3 = await page.locator('.se-clip[data-scene="3"]').boundingBox();
    await page.mouse.move(ed.x + 4, ed.y + 8); await page.mouse.down(); await page.mouse.move(c3.x, ed.y + 8, { steps: 6 }); await page.mouse.up(); await wait(800);
    const tl = await page.evaluate(async () => { const t = await plugin.activeProject().timeline(); return t.t.bands.map(b => [b.moment.label, b.start, b.end]); });
    assert.deepEqual(tl, [['Two years on', 2, 4]], 'starts one scene earlier now');
    assert.match(await file('ASOIAF Sample/02 Bran.md'), /%% se-scene id=\w+ moment=\w+ %%\nThe young boy/);
    // The hatched time-skip gap can be dragged wider; only the drawing changes.
    const slotsBefore = await page.evaluate(async () => (await plugin.activeProject().timeline()).scenes.map(s => s.slot));
    const gap = await page.locator('.se-skip').first().boundingBox(), c3a = await page.locator('.se-clip[data-scene="3"]').boundingBox();
    await page.mouse.move(gap.x + gap.width / 2, gap.y + 5); await page.mouse.down(); await page.mouse.move(gap.x + gap.width / 2 + 80, gap.y + 5, { steps: 8 }); await page.mouse.up(); await wait(500);
    assert.ok(Math.abs((await page.locator('.se-skip').first().boundingBox()).width - (gap.width + 80)) < 3, 'gap is wider');
    assert.ok(Math.abs((await page.locator('.se-clip[data-scene="3"]').boundingBox()).x - (c3a.x + 80)) < 3, 'scenes after it move right');
    assert.equal((await data()).moments[0].gap, 34 + 80, 'saved with the moment');
    assert.deepEqual(await page.evaluate(async () => (await plugin.activeProject().timeline()).scenes.map(s => s.slot)), slotsBefore, 'story time unchanged');
    await page.locator('.se-skip').first().dblclick(); await wait(300);
    assert.ok(Math.abs((await page.locator('.se-skip').first().boundingBox()).width - 34) < 2, 'double-click resets it');
  });

  await step('map: right-click → new place and new character here; place mode; box select + group move', async () => {
    await page.evaluate(() => plugin.activeProject().setView(4)); await wait(300);
    const m = await mapBox();
    await page.mouse.click(m.x + m.width * .3, m.y + m.height * .3, { button: 'right' }); await wait(100);
    await page.locator('.se-ctx button:has-text("New location here")').click();
    await page.locator('.se-namebox input').fill('Sept'); await page.locator('.se-namebox input').press('Enter'); await wait(400);
    assert.ok(await page.$('.se-pin:has-text("Sept")'));
    await page.mouse.click(m.x + m.width * .55, m.y + m.height * .25, { button: 'right' }); await wait(100);
    await page.locator('.se-ctx button:has-text("New character here")').click();
    await page.locator('.se-namebox input').fill('Catelyn'); await page.locator('.se-namebox input').press('Enter'); await wait(500);
    assert.ok(await page.$('.se-tok:has-text("Catelyn")'), 'Catelyn token');
    const cate = await page.evaluate(() => [...plugin.activeProject().pieces.values()].find(p => p.name === 'Catelyn').id);
    assert.ok((await data()).track[cate]?.length === 1, 'placed in the current scene');
    await page.locator('.se-hud button[aria-label^="Location mode"]').click();
    await page.mouse.click(m.x + m.width * .2, m.y + m.height * .75); await wait(100);
    await page.locator('.se-namebox input').fill('Old Tree'); await page.locator('.se-namebox input').press('Enter'); await wait(400);
    await page.keyboard.press('Escape');
    assert.ok(await page.$('.se-pin:has-text("Old Tree")'));
    // Box-select the two tokens at the farmhouse and drag them together.
    const fst = page.locator('.se-group').filter({ hasText: 'Farmhouse' });
    if (await fst.count()) { await fst.click(); await wait(400); }   // zoomed out it's a stack: one click zooms in until they fit
    const farm = await page.locator('.se-pin:has-text("Farmhouse") i').boundingBox();
    await page.mouse.move(farm.x - 170, farm.y + 160); await page.mouse.down(); await page.mouse.move(farm.x + 170, farm.y - 150, { steps: 5 }); await page.mouse.up(); await wait(200);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'box.png') });
    const picked = await page.$$eval('.se-tok.is-sel .se-n', e => e.map(x => x.textContent));
    assert.ok(picked.includes('Bran') && picked.includes('Gared'), 'box-selected: ' + picked);
    const eri = await page.locator('.se-tok:has-text("Bran") .se-f').boundingBox(), shu = await page.locator('.se-tok:has-text("Gared") .se-f').boundingBox();
    await page.mouse.move(eri.x + 10, eri.y + 10); await page.mouse.down(); await page.mouse.move(eri.x - 80, eri.y + 60, { steps: 6 }); await page.mouse.up(); await wait(500);
    const eri2 = await page.locator('.se-tok:has-text("Bran") .se-f').boundingBox(), shu2 = await page.locator('.se-tok:has-text("Gared") .se-f').boundingBox();
    for (const [a, b2] of [[eri, eri2], [shu, shu2]]) assert.ok(Math.abs(b2.x - (a.x - 90)) < 3 && Math.abs(b2.y - (a.y + 50)) < 3, `landed exactly where dropped: ${JSON.stringify([a, b2])}`);
    const d = await data();
    const s2 = (await page.evaluate(async () => (await plugin.activeProject().timeline()).scenes[3].id));
    const ids = await page.evaluate(() => [...plugin.activeProject().pieces.values()].filter(p => ['Bran', 'Gared'].includes(p.name)).map(p => p.id));
    assert.ok(ids.every(id => d.track[id].some(e => e.s === s2)), 'moved in this scene');
    // Space + drag pans; wheel zooms.
    const before = await page.$eval('.se-stage', s => s.style.transform);
    await page.mouse.move(m.x + m.width / 2, m.y + m.height / 2); await page.mouse.wheel(0, -300); await wait(100);
    assert.notEqual(await page.$eval('.se-stage', s => s.style.transform), before, 'wheel zooms');
  });

  await step('Setup tab: bulk add types, connection types and themes', async () => {
    await page.locator('.se-tab:has-text("Setup")').click(); await wait(200);
    const bulks = page.locator('.se-bulk textarea');
    await bulks.nth(0).fill('Spirit, Ship'); await bulks.nth(0).press('Enter'); await wait(100);
    await page.locator('.se-bulk textarea').nth(1).fill('Mentor\nRival'); await page.locator('.se-bulk button').nth(1).click(); await wait(100);
    await page.locator('.se-bulk textarea').nth(2).fill('Eyes; Blood debt'); await page.locator('.se-bulk button').nth(2).click(); await wait(500);
    const d = await data();
    assert.ok(['spirit', 'ship'].every(id => d.types.some(t => t.id === id)), 'types');
    assert.ok(['Mentor', 'Rival'].every(l => d.styles.some(s => s.label === l)), 'connection types');
    assert.deepEqual(Object.keys(d.themes), ['Eyes', 'Blood debt']);
    await page.locator('.se-def-theme').first().locator('.se-meaning').fill('Seeing what others cannot.'); await page.locator('.se-def-theme').first().locator('.se-meaning').blur(); await wait(500);
    assert.equal((await data()).themes.Eyes.meaning, 'Seeing what others cannot.');
    await page.locator('.se-tab:has-text("Pieces")').click(); await wait(200);
  });

  await step('book look: the Aa fold changes the story\'s typography live', async () => {
    await page.locator('.se-look-aa').click(); await wait(100);
    const size = page.getByRole('spinbutton', { name: 'Size px', exact: true });
    await size.fill('20'); await wait(500);
    assert.equal((await data()).look.size, 20);
    assert.equal(await page.evaluate(() => app.workspace.getLeavesOfType('markdown')[0].view.containerEl.style.getPropertyValue('--se-size')), '20px');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.manuscript .cm-content')).fontSize), '20px');
    assert.match(await page.evaluate(() => document.getElementById('story-engine-print-look').textContent), /--se-size: 20px/, 'print/PDF gets it too');
    await page.locator('.se-look-acts button:has-text("Done")').click();
  });

  await step('a book-look strip left by an older version is replaced (no stray button)', async () => {
    await page.evaluate(() => { const v = app.workspace.getLeavesOfType('markdown')[0].view; v.contentEl.querySelector('.se-lookbar').remove(); const old = v.contentEl.createDiv('se-lookbar'); old.createEl('button', { cls: 'se-look-aa', text: 'Aa' }); old.createDiv('se-look-panel'); v.contentEl.prepend(old); });
    await page.evaluate(() => plugin.applyLooks()); await wait(100);
    assert.equal(await page.$$eval('.se-lookbar button.se-look-aa', e => e.length), 0);
  });

  await step('delete asks again in place; the Aa strip pushes the text down', async () => {
    await page.locator('.se-row:has-text("Sept")').click(); await wait(300);
    const del = page.locator('.se-card-acts button:has-text("Delete")'); await del.scrollIntoViewIfNeeded(); const before = await del.boundingBox();
    await del.click(); await wait(100);
    const armed = page.locator('.se-card-acts button.is-sure'); assert.match(await armed.textContent(), /Sure\? Click again/);
    assert.ok(Math.abs((await armed.boundingBox()).y - before.y) < 2, 'stays in place');
    await wait(4200); assert.equal(await page.$$eval('.se-card-acts .is-sure', e => e.length), 0, 'disarms by itself');
    await page.locator('.se-look-aa').click(); await wait(150);
    const bar = await page.locator('.se-lookbar').boundingBox(), text = await page.locator('.markdown-source-view').boundingBox();
    assert.ok(text.y >= bar.y + bar.height - 1, 'text starts below the strip');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'look.png') });
    await page.locator('.se-look-aa').click();
  });

  await step('+ New piece, typed description, Finish, then Undo from the notice', async () => {
    await page.click('.se-catalog .se-new-piece'); await wait(150);
    await pop().locator('.se-namefield').fill('The Others'); await pop().locator('[data-type="faction"]').click(); await wait(250);
    await pop().locator('.se-or textarea').fill('Feared beings named in the farm family\'s prayer.'); await pop().locator('.se-or button').click(); await wait(250);
    await pop().locator('button:has-text("Finish")').click(); await wait(300);
    assert.match(await file('ASOIAF Sample/World/Factions/The Others.md'), /Feared beings/);
    await page.locator('.notice:has-text("The Others") .se-undo-link').click(); await wait(300);
    assert.equal(await file('ASOIAF Sample/World/Factions/The Others.md'), undefined, 'undone');
  });

  await step('Enter splits into a new paragraph; Tab at start does nothing', async () => {
    const before = await page.evaluate(() => app.workspace.getLeavesOfType('markdown')[0].view.cm.state.doc.toString());
    await cursorAt('Catelyn');
    const at = await page.evaluate(() => { const v = app.workspace.getLeavesOfType('markdown')[0].view.cm; const d = v.state.doc.toString(); const i = d.indexOf('. ', d.indexOf('\n', d.indexOf('# CATELYN') + 8) + 2) + 2; v.dispatch({ selection: { anchor: i } }); return d.slice(i, i + 20); });
    await page.keyboard.press('Enter'); await page.keyboard.press('Tab');
    const after = await page.evaluate(() => app.workspace.getLeavesOfType('markdown')[0].view.cm.state.doc.toString());
    assert.ok(after.includes('.\n' + at), 'new paragraph: one line break, no stray space');
    assert.equal(after.length, before.length, 'the space became the line break; no tab inserted');
  });

  await step('the column toggle sits in the header; collapsing lets the map use the space', async () => {
    const w0 = (await mapBox()).width;
    await page.locator('.se-side-toggle').click(); await wait(300);
    assert.equal(await page.isVisible('.se-side'), false);
    const w1 = (await mapBox()).width; assert.ok(w1 > w0 + 20, `map grows: ${w0} → ${w1}`);
    const btn = await page.locator('.se-side-toggle').boundingBox();
    await page.locator('.se-side-toggle').click(); await wait(300);
    assert.ok(await page.isVisible('.se-side'));
    const btn2 = await page.locator('.se-side-toggle').boundingBox();
    assert.ok(Math.abs(btn.x - btn2.x) < 1 && Math.abs(btn.y - btn2.y) < 1, 'the button does not move');
  });

  await step('Chapters list: new chapter at the end; drag to reorder renumbers the files', async () => {
    await page.locator('.se-chapters-btn').click(); await wait(300);
    assert.deepEqual(await page.$$eval('.se-ch-t', e => e.map(x => x.textContent)), ['Prologue', 'Bran', 'Catelyn']);
    await page.locator('.se-ch-add').click(); await page.locator('.se-ch-new input').fill('Epilogue'); await page.locator('.se-ch-new input').press('Enter'); await wait(500);
    assert.ok(await file('ASOIAF Sample/04 Epilogue.md'), 'created at the end');
    assert.equal(await page.evaluate(() => app.workspace.getLeavesOfType('markdown')[0].view.file.path), 'ASOIAF Sample/04 Epilogue.md', 'and opened');
    assert.ok(await page.isVisible('.se-chapters'), 'stays open while you move between chapters');
    await page.locator('.se-ch-row:has-text("Epilogue")').dragTo(page.locator('.se-ch-row:has-text("Bran")'), { targetPosition: { x: 20, y: 3 } }); await wait(800);
    assert.deepEqual(await page.$$eval('.se-ch-t', e => e.map(x => x.textContent)), ['Prologue', 'Epilogue', 'Bran', 'Catelyn']);
    const names = await page.evaluate(() => [...app.vault.files.keys()].filter(p => /^ASOIAF Sample\/\d/.test(p)).sort());
    assert.deepEqual(names, ['ASOIAF Sample/01 Prologue.md', 'ASOIAF Sample/02 Epilogue.md', 'ASOIAF Sample/03 Bran.md', 'ASOIAF Sample/04 Catelyn.md']);
    assert.match(await file('ASOIAF Sample/World/Characters/Bran.md'), /\[\[(ASOIAF Sample\/)?03 Bran\]\]/, 'quote links follow the rename');
    assert.equal(await page.$$eval('.se-clip', e => e.length), 7, 'timeline follows the new order');
    await page.mouse.click(5, 300); await wait(100);
    assert.ok(await page.isVisible('.se-chapters'), 'clicking elsewhere leaves it open');
    const btnBox = await page.locator('.se-chapters-btn').boundingBox(), list = await page.locator('.se-ch-list').boundingBox(), text = await page.locator('.markdown-source-view').boundingBox();
    assert.ok(list.x < btnBox.x + 20 && list.y > btnBox.y, 'opens under the button, at the left');
    await page.locator('.se-chapters-btn').click(); await wait(200);
    assert.deepEqual(await page.locator('.markdown-source-view').boundingBox(), text, 'the page does not move');
    await page.locator('.se-chapters-btn').click(); await wait(200);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'chapters.png') });
    await page.locator('.se-chapters-btn').click(); await wait(200);
    assert.equal(await page.isVisible('.se-chapters'), false, 'the button closes it');
  });

  await step('the map icon opens and closes the World view', async () => {
    await page.evaluate(() => plugin.toggleWorld()); await wait(200);
    assert.equal(await page.evaluate(() => app.workspace.getLeavesOfType('story-engine-world').length), 0);
    await page.evaluate(() => plugin.toggleWorld()); await wait(400);
    assert.ok(await page.isVisible('.se-map'));
  });

  if (SHOTS) {
    await page.evaluate(() => { const p = plugin.activeProject(); const w = app.workspace.getLeavesOfType('story-engine-world')[0].view; w.focusPiece([...p.pieces.values()].find(x => x.name === 'Bran').id); p.setView(2); });
    await wait(600);
    await page.screenshot({ path: path.join(SHOTS, 'v21.png') });
  }

  // A story saved by 2.0 is upgraded automatically.
  await step('2.9 styles: right-click a paragraph → New style… → it turns that colour; Aa lists it; paper; exports', async () => {
    await page.evaluate(async () => { const l = app.workspace.getLeaf(); await l.openFile(app.vault.getAbstractFileByPath('ASOIAF Sample/01 Prologue.md')); }); await wait(400);
    const menuAt = async needle => page.evaluate(needle => {
      const v = app.workspace.getLeavesOfType('markdown').map(l => l.view).find(v => v.file?.path.endsWith('01 Prologue.md'));
      const d = v.cm.state.doc.toString(); v.cm.dispatch({ selection: { anchor: d.indexOf(needle) + 5 } });
      const m = new __Menu(); app.workspace.trigger('editor-menu', m, v.editor, v); window.__menu = m; return m.items.map(i => i.title + (i.checked ? ' ✓' : ''));
    }, needle);
    // Cursor in the italic opening paragraph (no highlighting): the menu offers New style…
    assert.deepEqual(await menuAt('Pale shapes'), ['New style…']);
    await page.evaluate(() => __menu.click('New style…')); await wait(150);
    await page.locator('.se-style-modal input').first().fill('Epigraph');
    await page.locator('.se-style-modal input[type=color]').nth(0).fill('#d4a24c');
    await page.locator('.se-style-modal input[type=color]').nth(1).fill('#7a3b2e');
    await page.locator('.se-style-modal button:has-text("Create")').click(); await wait(400);
    const text = await file('ASOIAF Sample/01 Prologue.md');
    assert.match(text, /\n%%style:epigraph%% \*~Pale shapes/, 'a hidden marker at the paragraph start');
    const line = page.locator('.cm-line.se-st-epigraph').first();
    assert.equal(await line.evaluate(e => getComputedStyle(e).color), 'rgb(212, 162, 76)', 'the writing colour');
    assert.doesNotMatch(await line.textContent(), /%%/, 'the marker is hidden');
    assert.deepEqual((await data()).look.styles.map(s => [s.id, s.name, s.color, s.paperColor]), [['epigraph', 'Epigraph', '#d4a24c', '#7a3b2e']]);
    // Typing at the very start keeps the style (it goes after the hidden marker).
    await page.evaluate(() => { const v = app.workspace.getLeavesOfType('markdown').map(l => l.view).find(v => v.file?.path.endsWith('01 Prologue.md')); const d = v.cm.state.doc.toString(); const at = d.indexOf('%%style:epigraph%%'); v.cm.dispatch({ changes: { from: at, insert: 'X' }, selection: { anchor: at + 1 }, userEvent: 'input.type' }); });
    assert.match(await file('ASOIAF Sample/01 Prologue.md'), /\n%%style:epigraph%% X\*~Pale/);
    await page.evaluate(() => { const v = app.workspace.getLeavesOfType('markdown').map(l => l.view).find(v => v.file?.path.endsWith('01 Prologue.md')); const d = v.cm.state.doc.toString(); const at = d.indexOf('X*~Pale'); v.cm.dispatch({ changes: { from: at, to: at + 1 } }); });
    // Another paragraph: the style is offered by name, ticked where it's on.
    assert.deepEqual(await menuAt('Cold and tired'), ['Style: Epigraph', 'New style…']);
    assert.deepEqual(await menuAt('Pale shapes'), ['Style: Epigraph ✓', 'New style…', 'No style']);
    const leaf = '.workspace-leaf:has(.cm-line.mm-heading:text-is("# PROLOGUE"), .cm-line.mm-heading:text-is("PROLOGUE"))';
    // Paper: the page turns light and the style uses its paper colour.
    await page.locator(`${leaf} .se-paper-btn`).click(); await wait(300);
    assert.ok(await page.$('.view-content-wrap.se-paper'));
    assert.equal(await page.$eval('.manuscript .cm-content', e => getComputedStyle(e).color), 'rgb(35, 31, 26)');
    assert.equal(await line.evaluate(e => getComputedStyle(e).color), 'rgb(122, 59, 46)', 'the paper colour');
    if (SHOTS) await page.locator(`${leaf} .view-content-wrap`).screenshot({ path: path.join(SHOTS, 'paper.png') });
    // The Aa strip lists the style; changing it there changes every Epigraph paragraph.
    await page.locator(`${leaf} .se-look-aa`).click(); await wait(200);
    const row = page.locator('.se-look-style[data-style="epigraph"]');
    await row.locator('.se-look-si').click(); await wait(200);
    assert.equal(await line.evaluate(e => getComputedStyle(e).fontStyle), 'italic');
    await page.locator('.se-look-style[data-style="epigraph"] select').selectOption('center'); await wait(200);
    assert.equal(await line.evaluate(e => getComputedStyle(e).textAlign), 'center');
    if (SHOTS) await page.locator(`${leaf} .se-lookbar`).screenshot({ path: path.join(SHOTS, 'aa-styles.png') });
    // Exports land in the story's Exports folder.
    await page.locator(`${leaf} .se-look-ex:has-text("EPUB")`).click(); await wait(150);
    await page.locator('.se-export-modal input').nth(1).fill('A. Writer');
    await page.locator('.se-export-modal button:has-text("Export")').click(); await wait(500);
    const epub = await page.evaluate(() => [...(__binaries.get('ASOIAF Sample/Exports/ASOIAF Sample.epub') ?? [])].slice(0, 58));
    assert.equal(String.fromCharCode(...epub.slice(30, 38)), 'mimetype');
    assert.equal(String.fromCharCode(...epub.slice(38, 58)), 'application/epub+zip');
    assert.equal((await data()).book.author, 'A. Writer', 'remembered for next time');
    await page.locator(`${leaf} .se-look-ex:has-text("Word")`).click(); await wait(150);
    assert.equal(await page.locator('.se-export-modal input').nth(1).inputValue(), 'A. Writer');
    await page.locator('.se-export-modal button:has-text("Export")').click(); await wait(500);
    assert.ok(await page.evaluate(() => __binaries.has('ASOIAF Sample/Exports/ASOIAF Sample.docx')));
    // Copy for web: the chapter as HTML, the style written on its paragraph.
    const web = await page.evaluate(async () => { const v = app.workspace.getLeavesOfType('markdown').map(l => l.view).find(v => v.file?.path.endsWith('01 Prologue.md')); const { copyChapterForWeb } = window.__seExport; return copyChapterForWeb(plugin.activeProject(), v.editor.getValue(), 'Prologue'); });
    assert.match(web.html, /^<h1>PROLOGUE<\/h1>\n<p style="color:#7a3b2e;font-style:italic;text-align:center;"><em><em>~Pale shapes/);
    // No style: the marker goes.
    await menuAt('Pale shapes'); await page.evaluate(() => __menu.click('No style')); await wait(200);
    assert.doesNotMatch(await file('ASOIAF Sample/01 Prologue.md'), /%%style:/);
    await page.locator(`${leaf} .se-paper-btn`).first().click(); await wait(200);
  });
  await step('2.11 one line = one paragraph: Enter makes a paragraph, an empty line is a line of space, nothing moves when you click or select', async () => {
    await page.evaluate(async () => { const l = app.workspace.getLeaf(); await l.openFile(app.vault.getAbstractFileByPath('ASOIAF Sample/01 Prologue.md')); }); await wait(400);
    const pv = "app.workspace.getLeavesOfType('markdown').map(l => l.view).filter(v => v.file?.path.endsWith('01 Prologue.md')).pop()";
    const doc = () => page.evaluate(pv => eval(pv).cm.state.doc.toString(), pv);
    const end = 'in the falling snow.';
    const put = at => page.evaluate(([pv, at]) => { const v = eval(pv); v.cm.focus(); v.cm.dispatch({ selection: { anchor: at }, scrollIntoView: true }); }, [pv, at]);
    const pos = needle => page.evaluate(([pv, needle]) => eval(pv).cm.state.doc.toString().indexOf(needle), [pv, needle]);
    const nextTop = () => page.evaluate(pv => { const v = eval(pv); const d = v.cm.state.doc.toString(); return v.cm.coordsAtPos(d.indexOf('On the ridge')).top - v.cm.coordsAtPos(d.indexOf('falling snow.')).top; }, pv);
    const lineH = await page.$eval('.manuscript .cm-line.mm-para', e => parseFloat(getComputedStyle(e).lineHeight));
    const original = await doc();
    assert.match(original, /falling snow\.\nOn the ridge/, 'converted: no empty line between paragraphs');
    await put((await pos(end)) + end.length); await wait(80);
    const t0 = await nextTop();
    assert.ok(t0 < lineH * 4, 'the next paragraph follows right on');
    await page.keyboard.press('Enter'); await wait(80);
    const t1 = await nextTop();
    assert.ok(Math.abs(t1 - t0 - lineH) < 4, `Enter: one new line (${t0} → ${t1})`);
    await page.keyboard.type('Then the bells rang.'); await wait(80);
    assert.ok(Math.abs((await nextTop()) - t1) < 2, 'typing on it moves nothing');
    assert.match(await doc(), /falling snow\.\nThen the bells rang\.\nOn the ridge/, 'one line, one paragraph');
    assert.ok(await page.$('.manuscript .cm-line.mm-para:text-is("Then the bells rang.")'), 'an indented paragraph of its own');
    // An empty line: Enter twice. It's a full line of space, and clicking or selecting around it changes nothing.
    await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); await page.keyboard.type('After a pause.'); await wait(80);
    assert.match(await doc(), /Then the bells rang\.\n\nAfter a pause\.\nOn the ridge/);
    const gapH = await page.$$eval('.manuscript .cm-line.mm-gap', e => e.map(x => x.getBoundingClientRect().height));
    assert.ok(gapH.some(h => Math.abs(h - lineH) < 2), 'the empty line is one full line');
    const t2 = await nextTop();
    const gapAt = (await pos('rang.\n\nAfter')) + 'rang.\n'.length;
    await put(gapAt); await wait(80); assert.ok(Math.abs((await nextTop()) - t2) < 1, 'clicking on the empty line moves nothing');
    await put(await pos('After a pause')); await wait(80); assert.ok(Math.abs((await nextTop()) - t2) < 1, 'clicking at the start of the next paragraph moves nothing');
    await page.evaluate(([pv, a, b]) => eval(pv).cm.dispatch({ selection: { anchor: a, head: b } }), [pv, gapAt - 3, gapAt + 4]); await wait(80);
    assert.ok(Math.abs((await nextTop()) - t2) < 1, 'selecting across the empty line moves nothing');
    await put((await pos('Then the bells rang.')) + 'Then the bells rang.'.length); await wait(80);
    assert.ok(Math.abs((await nextTop()) - t2) < 1, 'the cursor at the end of a paragraph moves nothing');
    // Backspace on the empty line: one press, gone.
    await put(gapAt); await page.keyboard.press('Backspace'); await wait(80);
    assert.match(await doc(), /Then the bells rang\.\nAfter a pause\./);
    await page.evaluate(([pv, text]) => { const v = eval(pv); v.cm.dispatch({ changes: { from: 0, to: v.cm.state.doc.length, insert: text } }); }, [pv, original]); await wait(150);
    // A style with one line of space after it.
    await page.evaluate(pv => { const p = plugin.activeProject(); p.setLook({ styles: [{ id: 'epigraph', name: 'Epigraph', color: '#d4a24c', paperColor: '#7a3b2e', italic: false, align: 'left', size: 1, spaceBefore: 0, spaceAfter: 1 }] });
      const v = eval(pv); const d = v.cm.state.doc.toString(); v.cm.dispatch({ changes: { from: d.indexOf('*~Pale'), insert: '%%style:epigraph%% ' } }); }, pv); await wait(300);
    const pad = await page.$eval('.manuscript .cm-line.se-st-epigraph', e => parseFloat(getComputedStyle(e).paddingBottom));
    assert.ok(Math.abs(pad - lineH) < 2, `one line after the epigraph (${pad} vs ${lineH})`);
    if (SHOTS) await page.locator('.workspace-leaf:has(.cm-line.se-st-epigraph) .view-content-wrap').last().screenshot({ path: path.join(SHOTS, 'lines.png') });
    await page.evaluate(([pv, text]) => { const v = eval(pv); v.cm.dispatch({ changes: { from: 0, to: v.cm.state.doc.length, insert: text } }); }, [pv, original]); await wait(150);
  });
  await step('2.11 a new chapter starts below its title, ready to write', async () => {
    const leaf = '.workspace-leaf:has(.cm-line.mm-heading:text-is("# PROLOGUE"), .cm-line.mm-heading:text-is("PROLOGUE"))';
    await page.locator(`${leaf} .se-chapters-btn`).last().click(); await wait(200);
    await page.locator(`${leaf} .se-ch-add`).last().click(); await wait(100);
    await page.locator(`${leaf} .se-ch-new input`).last().fill('The Bells'); await page.locator(`${leaf} .se-ch-new input`).last().press('Enter'); await wait(600);
    const nv = await page.evaluate(() => { const v = app.workspace.getLeavesOfType('markdown').map(l => l.view).find(v => /The Bells\.md$/.test(v.file?.path ?? '')); const s = v.cm.state, h = s.selection.main.head; return { line: s.doc.lineAt(h).number, text: s.doc.toString() }; });
    assert.equal(nv.text, '---\ncssclasses: manuscript\n---\n# THE BELLS\n');
    assert.equal(nv.line, 5, 'cursor on the line below the title');
  });
  await step('2.11 opening a chapter: the cursor waits at the start of the first paragraph; the book look is on the editor from the first frame', async () => {
    const r = await page.evaluate(async () => {
      const f = app.vault.getMarkdownFiles().find(f => /Bran\.md$/.test(f.path) && f.path.startsWith('ASOIAF Sample/0')); const l = app.workspace.getLeaf(); await l.openFile(f);
      const ed = l.view.cm.dom, sync = { cls: ed.classList.contains('manuscript'), size: ed.style.getPropertyValue('--se-size') };
      await new Promise(res => setTimeout(res, 250));
      const s = l.view.cm.state, line = s.doc.lineAt(s.selection.main.head);
      return { sync, line: line.text.slice(0, 30), at: s.selection.main.head - line.from };
    });
    assert.ok(r.sync.cls && r.sync.size, 'book look on the editor immediately: ' + JSON.stringify(r.sync));
    assert.equal(r.at, 0); assert.match(r.line, /^Excited as the boy was/, 'the first paragraph, not the title');
  });
  await step('2.12 Ctrl + wheel zooms the chapter (screen only); the text stays centred in the writing view at any size', async () => {
    await page.evaluate(async () => { const l = app.workspace.getLeaf(); await l.openFile(app.vault.getAbstractFileByPath('ASOIAF Sample/01 Prologue.md')); }); await wait(400);
    const leaf = '.workspace-leaf:has(.cm-line.mm-heading)';
    const measure = () => page.evaluate(leaf => {
      const L = [...document.querySelectorAll(leaf)].pop(), ed = L.querySelector('.cm-editor'), sizer = L.querySelector('.cm-sizer') ?? ed.querySelector('.cm-scroller'), line = L.querySelector('.cm-line.mm-para');
      const scr = ed.querySelector('.cm-scroller').getBoundingClientRect(), c = L.querySelector('.cm-content').getBoundingClientRect();
      return { size: parseFloat(getComputedStyle(line).fontSize), left: c.left - scr.left, right: scr.right - c.right, width: c.width };
    }, leaf);
    await page.evaluate(() => { const p = plugin.activeProject(); p.setLook({ size: 13, pageWidth: 44 }); }); await wait(300);
    const a = await measure();
    assert.ok(Math.abs(a.width - 44 * 13) < 30, `page width follows the text size (${a.width})`);
    assert.ok(Math.abs(a.left - a.right) < 30, `centred while writing: ${a.left} | ${a.right}`);
    // The page width is in pixels, so Obsidian's own text size (16px) in the writing view can't stretch it.
    assert.equal(await page.evaluate(leaf => getComputedStyle([...document.querySelectorAll(leaf)].pop().querySelector('.cm-editor')).getPropertyValue('--se-page-width').trim(), leaf), `${44 * 13}px`);
    const box = await page.locator(`${leaf} .cm-content`).last().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    await page.keyboard.down('Control'); for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -120); await wait(40); } await page.keyboard.up('Control'); await wait(300);
    const b = await measure(), z = await page.evaluate(() => plugin.settings.draftZoom);
    assert.ok(z > 1.5 && Math.abs(b.size - 13 * z) < 0.6, `zoomed: ${z} → ${b.size}px`);
    assert.ok(Math.abs(b.left - b.right) < 30 || b.left < 40, `still centred (or filling the window): ${b.left} | ${b.right}`);
    assert.ok(await page.isVisible('.se-zoom-toast'), 'the new size shows for a moment');
    assert.equal((await data()).look.size, 13, 'the book itself is unchanged (exports use 13px)');
    await page.evaluate(() => plugin.setDraftZoom(1)); await wait(200);
    assert.equal((await measure()).size, 13);
  });
  await step('2.13 PDF export: the Aa strip\'s PDF… prints the laid-out book with Obsidian\'s engine, at the chosen page size', async () => {
    // Stand-in for the desktop app: a hidden window that "prints" and reports what it was given.
    await page.evaluate(() => {
      const files = new Map(); window.__printed = null;
      window.require = m => m === 'electron' ? { remote: { BrowserWindow: class { constructor() { this.webContents = { executeJavaScript: async () => true, printToPDF: async o => { window.__printed = { opts: o, html: this.html }; return new TextEncoder().encode('%PDF-1.7 fake'); } }; }
        async loadFile(f) { this.html = files.get(f); } destroy() {} } } }
        : m === 'fs' ? { writeFileSync: (f, d) => files.set(f, d), unlinkSync: f => files.delete(f) } : m === 'os' ? { tmpdir: () => '/tmp' } : m === 'path' ? { join: (...a) => a.join('/') } : null;
    });
    const leaf = '.workspace-leaf:has(.cm-line.mm-heading)';
    if (!(await page.locator(`${leaf} .se-look-ex`).last().isVisible())) { await page.locator(`${leaf} .se-look-aa`).last().click(); await wait(200); }
    await page.locator(`${leaf} .se-look-ex:has-text("PDF")`).last().click(); await wait(150);
    assert.ok(await page.isVisible('.se-export-modal select'), 'page size choice');
    await page.locator('.se-export-modal select').selectOption('5.5x8.5');
    await page.locator('.se-export-modal button:has-text("Export")').click(); await wait(600);
    const r = await page.evaluate(() => ({ printed: window.__printed, saved: [...__binaries.keys()].filter(k => k.endsWith('.pdf')), book: plugin.activeProject().data.book }));
    assert.equal(r.printed.opts.preferCSSPageSize, true);
    assert.match(r.printed.html, /@page \{ size: 5\.5in 8\.5in;/);
    assert.match(r.printed.html, /<h1>PROLOGUE<\/h1>/);
    assert.deepEqual(r.saved, ['ASOIAF Sample/Exports/ASOIAF Sample.pdf']);
    assert.equal(r.book.pageSize, '5.5x8.5', 'remembered, and used by the Word export too');
    await page.evaluate(() => { delete window.require; });
  });
  await step('2.14 the World button sits in every note\'s header, left of ⋮ (not only chapters), and opens and closes the World view', async () => {
    await page.evaluate(async () => { for (const l of app.workspace.getLeavesOfType('story-engine-world')) l.detach(); const l = app.workspace.getLeaf(); await l.openFile(app.vault.getAbstractFileByPath('ASOIAF Sample/ASOIAF Sample.md')); }); await wait(400);
    const note = '.workspace-leaf:has(.markdown-source-view:not(.manuscript)) .se-world-btn';
    assert.ok(await page.locator(note).last().isVisible(), 'on a note that is not a chapter');
    assert.equal(await page.locator('.workspace-leaf:has(.markdown-source-view:not(.manuscript)) .se-look-aa').count(), 0, 'chapter buttons stay on chapters only');
    await page.locator(note).last().click(); await wait(500);
    assert.equal(await page.evaluate(() => app.workspace.getLeavesOfType('story-engine-world').length), 1, 'opens the World view');
    assert.ok(await page.locator(`${note}.is-active`).last().isVisible(), 'lit while it is open');
    await page.locator(note).last().click(); await wait(400);
    assert.equal(await page.evaluate(() => app.workspace.getLeavesOfType('story-engine-world').length), 0, 'and closes it');
    await page.evaluate(() => plugin.openWorld()); await wait(400);
  });
  await step('2.15 picking another story in the World view opens its first chapter for writing (in the writing tab, not the World view)', async () => {
    await page.evaluate(async () => {
      await app.vault.create('Other Tale/story-engine.json', JSON.stringify({ version: 3, format: 2 }));
      await app.vault.create('Other Tale/01 Beginning.md', '---\ncssclasses: manuscript\n---\n# BEGINNING\nThe first line of the other tale.\n');
      await app.vault.create('Other Tale/02 Middle.md', '---\ncssclasses: manuscript\n---\n# MIDDLE\nLater.\n');
      await plugin.discover(); plugin.openWorld();
    }); await wait(600);
    const before = await page.evaluate(() => app.workspace.getLeavesOfType('markdown').length);
    await page.locator('.se-story-pick').selectOption('Other Tale'); await wait(600);
    const r = await page.evaluate(() => ({ files: app.workspace.getLeavesOfType('markdown').map(l => l.view.file?.path), world: app.workspace.getLeavesOfType('story-engine-world').length, active: plugin.settings.active }));
    assert.equal(r.active, 'Other Tale'); assert.equal(r.world, 1, 'the World view stays');
    assert.ok(r.files.includes('Other Tale/01 Beginning.md'), 'its first chapter: ' + r.files);
    assert.equal(r.files.length, before, 'reused a writing tab rather than opening another');
    await page.locator('.se-story-pick').selectOption('ASOIAF Sample'); await wait(500);
    assert.ok((await page.evaluate(() => app.workspace.getLeavesOfType('markdown').map(l => l.view.file?.path))).some(f => /^ASOIAF Sample\/\d+ .*\.md$/.test(f)), 'and back');
  });
  await step('upgrade a 2.0 story: when= becomes moments/parallel scenes, positions move to scenes', async () => {
    const old = { ...FILES };
    old['ASOIAF Sample/02 Bran.md'] = FILES['ASOIAF Sample/02 Bran.md'].replace('# BRAN\n', '# BRAN\n\n%% se-scene pov=eri when=m0 %%\n').replace('✦ ✦ ✦\n\nThe young boy', '✦ ✦ ✦\n\n%% se-scene when=m1 %%\n\nThe young boy');
    old['ASOIAF Sample/03 Catelyn.md'] = FILES['ASOIAF Sample/03 Catelyn.md'].replace('# CATELYN\n', '# CATELYN\n\n%% se-scene when=m0 %%\n');
    old['ASOIAF Sample/World/Characters/Bran.md'] = '---\nse-id: eri\nse-type: character\n---\n';
    old['ASOIAF Sample/World/Places/Tree.md'] = '---\nse-id: tree\nse-type: place\n---\n';
    old['ASOIAF Sample/story-engine.json'] = JSON.stringify({ version: 2, moments: [{ id: 'm0', label: 'Moment 1', note: '' }, { id: 'm1', label: 'Later that day', note: '' }], track: { eri: [{ m: 'm0', place: 'tree' }, { m: 'm1', gone: true }] }, places: { tree: { x: .3, y: .6 } }, persist: true, view: 'm0', themes: { Eyes: '#e9d36b' }, styles: [], map: null, lines: 'all' });
    await page.close();
    page = await open(old);
    await wait(500);
    const d = await data();
    assert.equal(d.version, 3); assert.ok(!d.legacy);
    const eri = await file('ASOIAF Sample/02 Bran.md'), cate = await file('ASOIAF Sample/03 Catelyn.md');
    const pro = await file('ASOIAF Sample/01 Prologue.md');
    assert.doesNotMatch(pro + eri + cate, /when=/);
    const first = /%% se-scene id=(\w+) moment=m0 %%/.exec(pro)?.[1];
    assert.ok(first, 'Moment 1 starts at the first scene (the prologue)');
    assert.match(eri, /%% se-scene pov=eri %%/);
    assert.match(eri, /%% se-scene id=\w+ moment=m1 %%/, '“Later that day” starts at Bran scene 2');
    assert.match(cate, new RegExp(`%% se-scene with=${first} %%`), 'going back to Moment 1 runs alongside its first scene');
    assert.equal(d.track.eri[0].s, first);
    assert.deepEqual(d.track.eri.map(e => Object.keys(e).sort().join()), ['place,s', 'gone,s']);
    assert.ok((await page.evaluate(() => __notices)).some(n => /upgraded/.test(n)));
    await page.evaluate(() => plugin.openWorld()); await wait(400);
    assert.equal(await page.$$eval('.se-clip', e => e.length), 6);
  });

  assert.deepEqual(errors, [], 'no page errors');
  console.log('\nAll checks passed.');
  await b.close();
})().catch(async e => { console.error(e.message); process.exitCode = 1; process.exit(1); });
