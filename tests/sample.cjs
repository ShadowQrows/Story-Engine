// The ASOIAF sample world loaded into the real plugin: inside maps, roofs, crowd stacks and scaling pieces.
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path'); const assert = require('assert/strict');
const dir = process.argv[2], SHOTS = process.argv[3];
const files = {};
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else files[path.relative(path.dirname(dir), p).split(path.sep).join('/')] = fs.readFileSync(p, 'utf8'); } })(dir);
(async () => {
  const b = await chromium.launch(); const page = await b.newPage({ viewport: { width: 1800, height: 1100 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  await page.goto('file://' + path.join(__dirname, 'harness.html'));
  await page.evaluate(async f => boot(f), files);
  await page.evaluate(() => plugin.openWorld()); await page.waitForTimeout(600);
  const wait = ms => page.waitForTimeout(ms);
  // Most steps want the map following the scene; the steps that test staying put switch it off themselves.
  const view = v => page.evaluate(v => { const p = plugin.activeProject(); p.data.ui.followMap = true; p.setView(v); }, v).then(() => wait(450));
  // Where the map is: ["World"], or ["World", "Winterfell"] when inside (the overlay shows ← ⌂ and the name).
  const crumbs = () => page.evaluate(() => { const n = document.querySelector('.se-nav-name').textContent; return document.querySelector('.se-nav-b') ? ['World', n] : [n]; });
  const step = async (n, f) => { try { await f(); console.log('✓', n); } catch (e) { console.log('✗', n, '\n ', e.message.split('\n').slice(0, 14).join('\n  ')); if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'sample-fail.png') }); process.exit(1); } };

  await step('the sample loads: 81 pieces, 10 scenes, every connection resolves', async () => {
    const info = await page.evaluate(async () => { const p = plugin.activeProject(); const tl = await p.timeline(); return { n: p.pieces.size, s: tl.scenes.length, bad: p.all().flatMap(x => x.connections.filter(c => !p.find(c.target)).map(c => x.name + '→' + c.target)) }; });
    assert.deepEqual(info, { n: 81, s: 10, bad: [] });
  });
  await step('Prologue on the world map; Winterfell\'s household collapses into a stack', async () => {
    await view(1);
    assert.deepEqual(await crumbs(), ['World']);
    const st = page.locator('.se-group').filter({ hasText: 'Winterfell' });
    const visible = () => page.$$eval('.se-tok', e => e.filter(x => getComputedStyle(x).display !== 'none').length);
    const before = await visible();
    assert.match(await st.textContent(), /Winterfell \+\d+/);
    // Hover: everyone inside shows at their real spots.
    const box = await st.locator('.se-group-icon').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await wait(200);
    assert.ok(await visible() >= before + 5, 'hovering shows the pieces inside');
    assert.ok(await page.$('.se-tok.is-peek[data-id="ned"]'), 'Eddard among them');
    await page.mouse.move(5, 5); await wait(150);
    await st.click(); await wait(300);
    assert.equal(await page.locator('.se-group').filter({ hasText: 'Winterfell' }).count(), 0, 'zoomed in until they fit');
    assert.ok(await visible() > before + 5);
    await page.keyboard.press('Escape'); await page.locator('.se-zoom-pct').click(); await wait(300);
  });
  await step('pieces shrink and grow with the map, within limits; zooming in opens a crowd', async () => {
    await view(2); await view(1);
    const inv = () => page.$eval('.se-stage', s => Number(s.style.getPropertyValue('--inv')) * Number(s.style.transform.match(/scale\(([\d.]+)\)/)[1]));
    const s0 = await inv();
    const wf = await page.locator('.se-pin:has-text("Winterfell") i').boundingBox();
    for (let i = 0; i < 8; i++) { await page.mouse.move(wf.x + 6, wf.y + 6); await page.mouse.wheel(0, -400); await wait(60); }
    await wait(500);
    const s1 = await inv();
    assert.ok(s1 > s0 * 1.3 && s1 <= 1.3001, `scale ${s0} → ${s1}`);
    assert.equal(await page.locator('.se-group').filter({ hasText: 'Winterfell' }).count(), 0, 'zoomed in: no stack');
    await page.locator('.se-zoom-pct').click();
  });
  await step('a scene in the godswood opens the Winterfell map by itself', async () => {
    await view(4);
    assert.deepEqual(await crumbs(), ['World', 'Winterfell']);
    assert.ok(await page.$('.se-tok.is-pov:has-text("Catelyn Stark")'));
    await view(5);
    assert.deepEqual(await crumbs(), ['World'], 'Daenerys I: back out to the world (Pentos)');
  });
  await step('roofs: closed with a count; open when the POV is inside; click to open', async () => {
    await view(7);
    assert.ok(await page.$('.se-roof.is-open[data-roof="greathall"]'), 'Jon is in the Great Hall');
    await view(8);
    assert.ok(await page.$('.se-roof.is-open[data-roof="greatkeep"]'), 'Catelyn II is in the Great Keep');
    assert.ok(await page.$('.se-roof:not(.is-open)[data-roof="guesthouse"]'));
    assert.match(await page.locator('[data-roof-label="guesthouse"]').textContent(), /9 inside/);
    assert.match(await page.locator('[data-roof-label="guesthouse"]').textContent(), /inside/);
    await page.locator('[data-roof="guesthouse"]').click(); await wait(400);
    assert.ok(await page.$('.se-roof.is-open[data-roof="guesthouse"]'), 'opened by a click');
    assert.ok(await page.isVisible('.se-card-title:has-text("The guest house")'));
  });
  await step('breadcrumb out to the world; double-click Winterfell to go back in', async () => {
    await page.locator('.se-nav-b[aria-label="World map"]').click(); await wait(400);
    assert.deepEqual(await crumbs(), ['World']);
    const wfm = page.locator('.se-group').filter({ hasText: 'Winterfell' });
    await (await wfm.count() ? wfm.locator('.se-group-icon') : page.locator('.se-pin:has-text("Winterfell") i')).dblclick(); await wait(500);
    assert.deepEqual(await crumbs(), ['World', 'Winterfell']);
  });
  await step('Bran II: the hunters are out in the Wolfswood; the broken tower has no roof', async () => {
    await view(10);
    assert.ok(await page.$('.se-tok.is-pov:has-text("Bran Stark")'));
    const tower = page.locator('.se-group').filter({ hasText: 'broken tower' });
    if (await tower.count()) { await tower.click(); await wait(400); }
    assert.ok(await page.$('.se-tok:not(.is-under-roof):has-text("Jaime Lannister")'), 'one click on the stack zooms in until they fit');
    for (const n of ['Jaime Lannister', 'Cersei Lannister']) assert.ok(await page.$(`.se-tok:not(.is-under-roof):has-text("${n}")`), n);
    assert.equal(await page.$('.se-tok:has-text("Robert Baratheon")'), null, 'Robert is not in the castle');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'sample-fall.png') });
    await page.locator('.se-nav-b[aria-label="World map"]').click(); await wait(400);
    const wood = page.locator('.se-group').filter({ hasText: 'Wolfswood' });
    if (await wood.count()) { await wood.click(); await wait(400); }
    assert.ok(await page.$('.se-tok:has-text("Robert Baratheon")'), 'but he is on the world map');
    await page.locator('.se-zoom-pct').click(); await wait(200);
  });
  await step('clicking pieces one after another never reshuffles them', async () => {
    await view(4);
    await page.locator('.se-zoom-pct').click(); await wait(300);
    const st = page.locator('.se-group').filter({ hasText: 'kennels' });
    if (await st.count()) { await st.click(); await wait(300); }
    const pos = () => page.$$eval('.se-tok', e => e.map(x => `${x.dataset.id}@${x.style.left},${x.style.top}`).sort());
    const before = await pos();
    for (const n of ['Grey Wind', 'Lady', 'Nymeria', 'Summer']) { await page.locator(`.se-tok:has-text("${n}") .se-f`).click(); await wait(250); }
    const after = await pos(), common = after.filter(x => before.some(b => b.split('@')[0] === x.split('@')[0]));
    assert.ok(common.length >= 6, 'the pups are all there');
    assert.deepEqual(common, before.filter(b => common.some(x => x.split('@')[0] === b.split('@')[0])), 'nobody moved');
    await page.locator('.se-zoom-pct').click(); await wait(300);
  });
  await step('the feast is a seating plan, not a pile: high table, benches, Jon among the squires', async () => {
    await view(7);
    const hall = page.locator('.se-group').filter({ hasText: 'Great Hall' });
    if (await hall.count()) { await hall.click(); await wait(400); }   // zoomed out it's a stack; one click zooms in until it fits
    assert.equal(await page.locator('.se-group').filter({ hasText: 'Great Hall' }).count(), 0);
    const y = async n => (await page.locator(`.se-tok:has-text("${n}") .se-f`).boundingBox()).y;
    assert.ok(await y('Robert Baratheon') < await y('Jon Snow') - 40, 'Robert at the high table, Jon far down the hall');
    const xs = await Promise.all(['Cersei Lannister', 'Eddard Stark', 'Robert Baratheon', 'Catelyn Stark'].map(async n => (await page.locator(`.se-tok:has-text("${n}") .se-f`).boundingBox()).x));
    assert.deepEqual([...xs].sort((a, b) => a - b), xs, 'Cersei, Ned, Robert, Catelyn in that order');
    await page.locator('.se-zoom-pct').click(); await wait(300);
  });
  await step('areas show on hover; dropping a piece inside one puts it there, at that spot', async () => {
    await view(9);
    await page.locator('.se-zoom-pct').click(); await wait(300);
    await page.locator('.se-hud button[aria-label^="Show pieces"]').click(); await wait(300);   // every piece shown, even in a crowded yard
    const gw = await page.locator('.se-pin:has-text("The godswood") i').boundingBox();
    await page.mouse.move(gw.x + 30, gw.y + 12); await wait(150);
    assert.ok(await page.$('.se-areas polygon'), 'area outline on hover');
    const arya = await page.locator('.se-tok:has-text("Arya Stark") .se-f').boundingBox();
    await page.mouse.move(arya.x + 8, arya.y + 8); await page.mouse.down(); await page.mouse.move(gw.x + 40, gw.y + 10, { steps: 8 }); await page.mouse.up(); await wait(500);
    const e = await page.evaluate(() => { const p = plugin.activeProject(); const a = [...p.pieces.values()].find(x => x.name === 'Arya Stark'); return p.data.track[a.id].at(-1); });
    assert.equal(e.place, 'godswood'); assert.ok(e.off && Math.abs(e.off.x) > 0.001, JSON.stringify(e));
    await page.locator('.se-hud button[aria-label^="Show pieces"]').click(); await wait(200);
    assert.equal(e.s, await page.evaluate(async () => (await plugin.activeProject().timeline()).scenes[8].id));
  });
  await step('edit an area: a dragged corner snaps onto the neighbour\'s corner', async () => {
    await page.locator('.se-pin:has-text("The main courtyard") i').click({ button: 'right' }); await wait(100);
    await page.locator('.se-ctx button:has-text("Edit its area")').click(); await wait(200);
    const corner = await page.locator('.se-hv[data-vi="0"]').boundingBox();   // the courtyard's top-left corner
    const hall = await page.evaluate(() => plugin.activeProject().data.areas.greathall[1]);   // the Great Hall's top-right corner
    const map = await page.locator('.se-stage').boundingBox();
    const target = { x: map.x + hall.x * map.width, y: map.y + hall.y * map.height };
    await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2); await page.mouse.down();
    await page.mouse.move(target.x + 4, target.y + 3, { steps: 8 }); await page.mouse.up(); await wait(200);
    await page.locator('.se-offmap button:has-text("Done")').click(); await wait(300);
    const c0 = await page.evaluate(() => plugin.activeProject().data.areas.courtyard[0]);
    assert.ok(Math.abs(c0.x - hall.x) < 1e-6 && Math.abs(c0.y - hall.y) < 1e-6, `snapped: ${JSON.stringify(c0)} vs ${JSON.stringify(hall)}`);
  });
  await step('draw a roof shape over the First Keep; the turret\'s roof is round', async () => {
    assert.ok(await page.$eval('[data-roof="turret"]', e => e.style.clipPath.startsWith('polygon')), 'round turret roof');
    const fk = await page.locator('.se-pin:has-text("The First Keep") i').boundingBox();
    await page.mouse.click(fk.x + 6, fk.y + 6, { button: 'right' }); await wait(100);
    await page.locator('.se-ctx button:has-text("Draw a roof")').click(); await wait(150);
    const c = { x: fk.x + 6, y: fk.y + 6 };
    for (const [dx, dy] of [[0, -45], [42, 0], [0, 45], [-42, 0]]) { await page.mouse.click(c.x + dx, c.y + dy, { modifiers: ['Shift'] }); await wait(60); }
    await page.mouse.click(c.x, c.y - 45); await wait(150);   // back on the first point closes the shape
    await page.locator('.se-offmap button:has-text("Done")').click(); await wait(400);
    const roof = await page.evaluate(() => plugin.activeProject().data.roofs.firstkeep);
    assert.ok(roof && roof.pts && roof.pts.length === 4, JSON.stringify(roof));
    assert.match(await page.locator('[data-roof-label="firstkeep"]').textContent(), /The First Keep/);
  });
  await step('zooming never moves pieces: each keeps its place on the map, only its size changes', async () => {
    await view(2); await view(1);
    await page.locator('.se-nav-b[aria-label="World map"]').click().catch(() => {}); await wait(200);
    const spots = () => page.$$eval('.se-tok', e => e.map(x => `${x.dataset.id}@${x.style.left},${x.style.top}`).sort());
    const zoomIn = async k => { const pt = await page.locator('.se-pin:has-text("Pentos") i').boundingBox(); for (let i = 0; i < k; i++) { await page.mouse.move(pt.x + 4, pt.y + 4); await page.mouse.wheel(0, -300); await wait(60); } await wait(400); };
    await zoomIn(4);
    const before = await spots();
    assert.ok(before.some(x => x.startsWith('dany@')), 'Pentos is open at this zoom');
    await zoomIn(3);
    await wait(400);
    const after = await spots();
    for (const id of ['dany', 'viserys', 'illyrio', 'drogo']) assert.equal(after.find(x => x.startsWith(id + '@')), before.find(x => x.startsWith(id + '@')), id);
    await page.locator('.se-zoom-pct').click(); await wait(200);
  });
  await step('on the world map, Winterfell still stacks when the POV is inside it', async () => {
    await view(6);
    await page.locator('.se-nav-b[aria-label="World map"]').click(); await wait(400);
    assert.equal(await page.locator('.se-group').filter({ hasText: 'Winterfell' }).count(), 1);
    await page.locator('.se-group').filter({ hasText: 'Winterfell' }).locator('.se-group-icon').dblclick(); await wait(500);
  });
  await step('events are headline flags; clicking one rings everyone involved', async () => {
    await view(2);
    const flag = page.locator('.se-flag-text:has-text("Gared\'s execution")');
    assert.ok(await flag.isVisible(), 'flag with its headline');
    assert.equal(await page.$('.se-tok[data-id="ev-execution"]'), null, 'not a token any more');
    // Flags step aside while the pointer is over a place; moving onto the flag itself wakes it.
    const fb = await flag.boundingBox(); await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2); await wait(50);
    assert.ok(!(await page.$('.se-map.is-flags-quiet')), 'the flag answers when the pointer is on it');
    await page.mouse.click(fb.x + fb.width / 2, fb.y + fb.height / 2); await wait(300);
    assert.ok(await page.isVisible('.se-card-title:has-text("Gared\'s execution")'));
    assert.ok(await page.$('.se-tok.is-involved[data-id="bran"]'), 'Bran (involved) is ringed');
  });
  await step('dragging a place shows its area and brings its people along; Ctrl+Z puts it back', async () => {
    await view(2);
    await page.locator('.se-hud button[aria-label^="Show pieces"]').click(); await wait(300);
    for (let i = 0; i < 6; i++) { const b = await page.locator('.se-pin:has-text("Old holdfast") b').boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.wheel(0, -200); await wait(150); }
    await wait(300);
    const before = await page.evaluate(() => ({ ...plugin.activeProject().data.places.holdfast }));
    const bran0 = await page.locator('.se-tok[data-id="bran"] .se-f').boundingBox();
    const pin = await page.locator('.se-pin:has-text("Old holdfast") i').boundingBox();
    await page.mouse.move(pin.x + pin.width / 2, pin.y + pin.height / 2); await page.mouse.down(); await page.mouse.move(pin.x + pin.width / 2 + 40, pin.y + pin.height / 2 + 30, { steps: 8 }); await wait(100);
    assert.ok(await page.$('.se-areas polygon'), 'its area shows while dragging');
    const bran1 = await page.locator('.se-tok[data-id="bran"] .se-f').boundingBox();
    assert.ok(Math.abs(bran1.x - bran0.x - 40) < 3, 'its people move with it, live ' + JSON.stringify([bran0, bran1, pin]));
    await page.mouse.up(); await wait(500);
    const moved = await page.evaluate(() => plugin.activeProject().data.places.holdfast);
    assert.ok(moved.x > before.x);
    const bran2 = await page.locator('.se-tok[data-id="bran"] .se-f').boundingBox();
    assert.ok(Math.abs(bran2.x - bran0.x - 40) < 3, 'and stay with it');
    await page.locator('.se-map').focus(); await page.keyboard.press('Control+z'); await wait(400);
    assert.deepEqual(await page.evaluate(() => plugin.activeProject().data.places.holdfast), before, 'undone');
    await page.keyboard.press('Control+Shift+z'); await wait(400);
    assert.ok((await page.evaluate(() => plugin.activeProject().data.places.holdfast)).x > before.x, 'redone');
    await page.keyboard.press('Control+z'); await wait(300);
    await page.locator('.se-hud button[aria-label^="Show pieces"]').click(); await wait(200);
  });
  await step('a plain click selects just one piece, so a drag moves only that one', async () => {
    await view(9);
    await page.locator('.se-zoom-pct').click(); await wait(300);
    const ys = page.locator('.se-group').filter({ hasText: 'practice yard' });
    if (await ys.count()) { await ys.click(); await wait(400); }
    const yard = await page.locator('.se-pin:has-text("The practice yard") i').boundingBox();
    await page.mouse.move(yard.x - 160, yard.y + 120); await page.mouse.down(); await page.mouse.move(yard.x + 160, yard.y - 110, { steps: 5 }); await page.mouse.up(); await wait(200);
    assert.ok(await page.$$eval('.se-tok.is-sel', e => e.length) >= 2, 'box-selected several');
    const theon = page.locator('.se-tok[data-id="theon"] .se-f');
    await theon.click(); await wait(300);
    assert.equal(await page.$$eval('.se-tok.is-sel', e => e.length), 1, 'a click selects only that one');
    const jon0 = await page.locator('.se-tok[data-id="jon"] .se-f').boundingBox(), t0 = await theon.boundingBox();
    await page.mouse.move(t0.x + 6, t0.y + 6); await page.mouse.down(); await page.mouse.move(t0.x - 20, t0.y + 30, { steps: 5 }); await page.mouse.up(); await wait(400);
    const jon1 = await page.locator('.se-tok[data-id="jon"] .se-f').boundingBox(), t1 = await theon.boundingBox();
    assert.deepEqual([Math.round(jon1.x), Math.round(jon1.y)], [Math.round(jon0.x), Math.round(jon0.y)], 'Jon stays put');
    assert.ok(Math.abs(t1.x - (t0.x - 26)) < 3 && Math.abs(t1.y - (t0.y + 24)) < 3, 'Theon lands right under the cursor');
  });
  await step('the caption says where the POV is; double-click it to focus on their place', async () => {
    await view(4);
    assert.match(await page.locator('.se-maptag').textContent(), /Catelyn Stark's POV · at The godswood · Scene 4 of 10/);
    await page.locator('.se-nav-b[aria-label="World map"]').click(); await wait(300);
    assert.deepEqual(await crumbs(), ['World']);
    await page.locator('.se-maptag').dblclick(); await wait(500);
    assert.deepEqual(await crumbs(), ['World', 'Winterfell'], 'back on the map where the POV is');
    const gw = await page.locator('.se-pin:has-text("The godswood") i').boundingBox(), map = await page.locator('.se-map').boundingBox();
    assert.ok(Math.abs(gw.x - (map.x + map.width / 2)) < 60 && Math.abs(gw.y - (map.y + map.height / 2)) < 60, 'zoomed onto the godswood');
    assert.ok(await page.$('.se-follow-map.is-on'), 'following the scene again');
  });
  await step('"Staying on this map": stepping through scenes keeps the map you chose', async () => {
    await view(4);
    await page.locator('.se-nav-b[aria-label="World map"]').click(); await wait(300);
    assert.ok(await page.$('.se-follow-map:not(.is-on)'), 'choosing a map yourself means staying on it');
    await page.evaluate(() => plugin.activeProject().setView(6)); await wait(400);
    assert.deepEqual(await crumbs(), ['World'], 'still on the world map although Eddard I is in the crypts');
    await page.locator('.se-follow-map').click(); await wait(400);
    assert.deepEqual(await crumbs(), ['World', 'Winterfell'], 'following again');
  });
  await step('the timeline bar is just the arrows; the strip shows each scene and its events on hover', async () => {
    assert.equal(await page.$$eval('.se-bar button:not(.se-word)', e => e.length), 4);
    assert.equal(await page.$('.se-readout'), null);
    await view(2);
    const ov = await page.locator('.se-overview').boundingBox();
    assert.ok(ov.height <= 14, 'thin strip');
    const x = await page.evaluate(() => { const w = app.workspace.getLeavesOfType('story-engine-world')[0].view; return w.ovX(1.5); });
    await page.mouse.move(ov.x + x, ov.y + ov.height / 2); await wait(100);
    assert.match(await page.locator('.se-overview').getAttribute('title'), /Scene 2 · Bran I · 1[\s\S]*⚑ Gared's execution/);
  });
  await step('Setup sections fold (and stay folded); the status bar folds away', async () => {
    await page.locator('.se-tab:has-text("Setup")').click(); await wait(200);
    await page.locator('.se-fold:has-text("Connection Types")').click(); await wait(100);
    assert.equal(await page.isVisible('.se-fold-body.is-closed'), false);
    assert.equal(await page.locator('.se-fold:has-text("Connection Types") + .se-fold-body').getAttribute('class'), 'se-fold-body is-closed');
    assert.deepEqual(await page.evaluate(() => plugin.activeProject().data.ui.setupClosed), ['Connection Types']);
    const h = await page.locator('.se-def-theme').first().locator('.se-meaning').boundingBox();
    assert.ok(h.height > 26, 'the meaning box grows to show its text');
    await page.locator('.se-tab:has-text("Pieces")').click(); await wait(100);
    await page.locator('.se-status-toggle').click(); await wait(100);
    assert.ok(await page.evaluate(() => document.body.classList.contains('se-status-folded')));
    assert.equal(await page.isVisible('.status-bar-item:has-text("134 words")'), false);
    await page.locator('.se-status-toggle').click(); await wait(100);
    assert.ok(await page.isVisible('.status-bar-item:has-text("134 words")'));
  });
  await step('make an inside map for Pentos', async () => {
    if (await page.$('.se-nav-b')) { await page.locator('.se-nav-b[aria-label="World map"]').click(); await wait(300); }
    await page.locator('.se-row:has(.se-row-name:text-is("Pentos"))').click(); await wait(300);
    await page.locator('.se-card button:has-text("Inside map")').click(); await wait(200);
    await page.evaluate(() => __fuzzy.choose('ASOIAF Sample/Attachments/Winterfell.svg')); await wait(500);
    assert.deepEqual(await crumbs(), ['World', 'Pentos']);
    assert.equal(await page.evaluate(() => plugin.activeProject().data.maps.length), 2);
  });
  await step('2.7 flags step aside while the pointer is over a place, and answer when it is on them', async () => {
    await view(2); await page.locator('.se-zoom-pct').click(); await wait(300);
    const icon = await page.locator('.se-group').filter({ hasText: 'Winterfell' }).locator('.se-group-icon').boundingBox();
    await page.mouse.move(icon.x + icon.width / 2, icon.y + icon.height / 2); await wait(80);
    assert.ok(await page.$('.se-map.is-flags-quiet'), 'flags are quiet over a place');
    assert.equal(await page.$eval('.se-flag-text', e => getComputedStyle(e).pointerEvents), 'none', 'clicks go through them');
    const fb = await page.locator('.se-flag-text').first().boundingBox();
    await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2); await wait(80);
    assert.ok(await page.$('.se-flag.is-hot'), 'the flag under the pointer wakes up');
    await page.mouse.move(5, 5);
  });
  await step('2.7 catalog: sections fold, characters group by faction, the dead get their own section', async () => {
    await view(3);
    const sub = page.locator('.se-catalog .se-subgrp:has-text("House Stark")');
    assert.ok(await sub.isVisible(), 'House Stark sub-group');
    assert.ok(await page.isVisible('.se-catalog .se-subgrp:has-text("House Stark") + .se-fold-body .se-row-name:text-is("Eddard Stark")'));
    assert.ok(await page.isVisible('.se-catalog .se-subgrp:has-text("Night\'s Watch") + .se-fold-body .se-row-name:text-is("Benjen Stark")'), 'in two factions: shows in both');
    const dead = await page.$$eval('.se-dead-grp + .se-fold-body .se-row-name', e => e.map(x => x.textContent));
    assert.deepEqual(dead.sort(), ['Gared', 'Waymar Royce', 'Will']);
    await view(1);
    assert.equal(await page.$('.se-dead-grp'), null, 'alive again in the prologue');
    await page.locator('.se-catalog .se-fold:has-text("Characters")').first().click(); await wait(100);
    assert.equal(await page.isVisible('.se-row-name:text-is("Arya Stark")'), false, 'folded');
    assert.deepEqual(await page.evaluate(() => plugin.activeProject().data.ui.catClosed), ['t:character']);
    await page.locator('.se-q').fill('arya'); await wait(150);
    assert.ok(await page.isVisible('.se-row-name:text-is("Arya Stark")'), 'searching shows everything');
    await page.locator('.se-q').fill(''); await wait(100);
    await page.locator('.se-catalog .se-fold:has-text("Characters")').first().click(); await wait(100);
  });
  await step('2.7 card sections fold for every card; “Dead from scene N on”', async () => {
    await view(4);
    await page.locator('.se-row:has(.se-row-name:text-is("Theon Greyjoy"))').click(); await wait(400);
    await page.locator('.se-card .se-fold:has-text("Description")').click(); await wait(100);
    await page.locator('.se-row:has(.se-row-name:text-is("Jon Snow"))').click(); await wait(400);
    assert.equal(await page.locator('.se-card .se-fold:has-text("Description") + .se-fold-body').getAttribute('class'), 'se-fold-body is-closed', 'stays folded on the next card');
    await page.locator('.se-card .se-fold:has-text("Description")').click(); await wait(100);
    await page.locator('.se-card button:has-text("Dead from scene 4 on")').click(); await wait(400);
    assert.ok(await page.isVisible('.se-dead-grp + .se-fold-body .se-row-name:text-is("Jon Snow")'), 'listed under Dead');
    assert.equal(await page.$('.se-tok[data-id="jon"]'), null, 'off the map');
    await page.locator('.se-card button:has-text("Not dead after all")').click(); await wait(400);
    assert.equal(await page.$('.se-dead-grp + .se-fold-body .se-row-name:text-is("Jon Snow")'), null, 'back');
  });
  await step('2.7 every location shows its icon, see-through when empty; right-click a marker to change it', async () => {
    await view(2); await page.locator('.se-zoom-pct').click(); await wait(300);
    const pins = await page.$$eval('.se-pin', e => e.map(x => ({ n: x.dataset.id, icon: x.classList.contains('has-icon'), empty: x.classList.contains('is-empty') })));
    assert.ok(pins.every(x => x.icon), 'all sample locations have icons');
    assert.ok(pins.find(x => x.n === 'casterly').empty, 'Casterly Rock is empty');
    assert.ok(!pins.find(x => x.n === 'kingslanding').empty, "Stark's Landing is not");
    const mk = await page.locator('.se-group').filter({ hasText: 'Winterfell' }).locator('.se-group-icon').boundingBox();
    await page.mouse.click(mk.x + mk.width / 2, mk.y + mk.height / 2, { button: 'right' }); await wait(150);
    await page.locator('.se-ctx button:has-text("Change its icon")').click(); await wait(200);
    assert.ok(await page.isVisible('.se-icon-modal .se-icon-opt.is-on[data-icon="castle"]'), 'the current one is marked');
    assert.ok(await page.locator('.se-icon-opt').count() >= 40);
    await page.locator('.se-icon-opt[data-icon="keep"]').click(); await wait(400);
    assert.equal(await page.evaluate(() => plugin.activeProject().data.icons.winterfell), 'builtin:keep');
    assert.match(await page.locator('.se-group').filter({ hasText: 'Winterfell' }).locator('.se-group-icon').getAttribute('style'), /data:image\/svg/);
  });
  await step('2.7 call scenes and moments your own words, everywhere', async () => {
    await view(2);
    const w = page.locator('.se-bar .se-word[data-word="scene"]');
    assert.equal(await w.textContent(), 'Scene');
    await w.click(); await wait(100);
    await page.locator('.se-wordbox .se-wb-one').fill('Chapter');
    assert.equal(await page.locator('.se-wordbox .se-wb-many').inputValue(), 'Chapters', 'plural guessed as you type');
    await page.locator('.se-wordbox .se-wb-one').press('Enter'); await wait(500);
    assert.deepEqual(await page.evaluate(() => plugin.activeProject().data.words), { scene: 'Chapter', scenes: 'Chapters' });
    assert.match(await page.locator('.se-maptag').textContent(), /Chapter 2 of 10/);
    assert.match(await page.locator('.se-tlc').innerHTML(), /CHAPTERS \(NUMBERED|Chapters \(numbered/);
    assert.match(await page.locator('.se-follow-map').getAttribute('aria-label'), /Follow chapter/);
    assert.equal(await w.textContent(), 'Chapter');
    await w.click(); await wait(100);
    await page.locator('.se-wordbox button').click(); await wait(300);
    assert.deepEqual(await page.evaluate(() => plugin.activeProject().data.words), {}, 'reset');
    assert.equal(await page.$('.se-wordbox'), null);
  });
  await step('2.7 types say Movable / Location / Event; the Add row lines up at any width', async () => {
    await page.locator('.se-tab:has-text("Setup")').click(); await wait(200);
    assert.deepEqual(await page.$$eval('.se-def select.se-beh >> nth=0', e => [...e[0].options].map(o => o.text)), ['Movable', 'Location', 'Event']);
    assert.equal(await page.evaluate(() => plugin.activeProject().data.types.find(t => t.id === 'place').label), 'Location');
    for (const side of [330, 520]) {
      await page.evaluate(s => { const p = plugin.activeProject(); p.data.ui.side = s; }, side); await page.evaluate(() => plugin.activeProject().saveSoon()); await wait(400);
      const name = await page.locator('.se-def .se-def-name').first().boundingBox(), sel = await page.locator('.se-def select.se-beh').first().boundingBox();
      const ta = await page.locator('.se-bulk textarea').first().boundingBox(), bs = await page.locator('.se-bulk select').first().boundingBox();
      assert.ok(Math.abs(ta.x - name.x) < 2, `textarea lines up with the names (${ta.x} vs ${name.x})`);
      assert.ok(Math.abs(bs.x - sel.x) < 2 && Math.abs(bs.width - sel.width) < 2, `dropdown lines up (${bs.x},${bs.width} vs ${sel.x},${sel.width})`);
      if (SHOTS) await page.locator('.se-side').screenshot({ path: path.join(SHOTS, `setup-${side}.png`) });
    }
    await page.locator('.se-tab:has-text("Pieces")').click(); await wait(100);
  });
  await step('2.8 map navigation: ← one level out, ⌂ the world; zoom % fits; side column has a minimum', async () => {
    await view(9);
    assert.equal(await page.locator('.se-nav-name').textContent(), 'Winterfell');
    assert.equal(await page.locator('.se-nav-b').count(), 2, '← and ⌂');
    await page.locator('.se-nav-b').first().click(); await wait(400);
    assert.equal(await page.locator('.se-nav-name').textContent(), 'World');
    assert.equal(await page.locator('.se-nav-b').count(), 0, 'on the world map: just its name');
    const wf = await page.locator('.se-group, .se-pin').filter({ hasText: 'Winterfell' }).first().boundingBox();
    await page.mouse.move(wf.x + wf.width / 2, wf.y + wf.height / 2); await page.mouse.wheel(0, -600); await wait(300);
    assert.notEqual(await page.locator('.se-zoom-pct').textContent(), '100%');
    await page.locator('.se-zoom-pct').click(); await wait(200);
    assert.equal(await page.locator('.se-zoom-pct').textContent(), '100%', 'clicking the zoom fits');
    assert.equal(await page.$('.se-w-head .se-toggle'), null, 'Follow cursor moved to the toolbar');
    await page.locator('.se-hud button[aria-label^="Follow cursor"]').click(); await wait(100);
    assert.equal(await page.evaluate(() => plugin.settings.follow), false);
    await page.locator('.se-hud button[aria-label^="Follow cursor"]').click(); await wait(100);
    const split = await page.locator('.se-split-v').boundingBox();
    await page.mouse.move(split.x + 2, split.y + 40); await page.mouse.down(); await page.mouse.move(split.x + 600, split.y + 40, { steps: 5 }); await page.mouse.up(); await wait(200);
    assert.ok((await page.locator('.se-side').boundingBox()).width >= 379, 'the column stops at its minimum');
  });
  await step('2.8.1 tooltips only where needed: icon buttons, scene clips, the strip, quote sources, theme meanings', async () => {
    await view(2);
    await page.locator('.se-row:has(.se-row-name:text-is("Bran Stark"))').click(); await wait(400);
    const stray = await page.evaluate(() => [...document.querySelectorAll('.se-world [title], .se-world [aria-label]')]
      .filter(n => !n.matches('.se-ib, .se-nav-b, .se-clip, .se-overview, .se-quote, .se-tag, .se-lg-row'))
      .map(n => `${n.className} → ${n.getAttribute('title') ?? n.getAttribute('aria-label')}`));
    assert.deepEqual(stray, []);
    assert.equal(await page.$('.se-hud [title]'), null, 'no double tooltips on the toolbar');
    assert.equal(await page.locator('.se-hud button[aria-label="All lines"]').count(), 1, 'just the name');
  });
  assert.deepEqual(errors, [], 'no page errors');
  console.log('\nSample checks passed.');
  await b.close();
})();
