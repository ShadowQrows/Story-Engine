// Rough timing of the World view on a big story: 200 chapters × 3 scenes, 80 pieces with positions in many scenes.
const { chromium } = require('playwright'); const path = require('path');
(async () => {
  const b = await chromium.launch(); const page = await b.newPage({ viewport: { width: 1700, height: 1050 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('file://' + path.join(__dirname, 'harness.html'));
  const files = {}; const ids = [];
  for (let i = 0; i < 80; i++) { const id = 'p' + i; ids.push(id); files[`Big/World/${i < 10 ? 'Places' : 'Characters'}/Piece ${i}.md`] = `---\nse-id: ${id}\nse-type: ${i < 10 ? 'place' : 'character'}\n---\n`; }
  const track = {}, places = {};
  for (let i = 0; i < 10; i++) places['p' + i] = { x: Math.random(), y: Math.random() };
  for (let c = 1; c <= 200; c++) {
    let t = `---\ncssclasses: manuscript\n---\n\n# CHAPTER ${c}\n\n`;
    for (let s = 0; s < 3; s++) { const sid = `c${c}s${s}`; t += `%% se-scene id=${sid} pov=p${10 + (c % 12)}${c % 9 === 0 && s === 0 ? ` with=c${c - 1}s0` : ''} %%\n\n${'Words go here. '.repeat(40)}\n\n${s < 2 ? '✦ ✦ ✦\n\n' : ''}`;
      for (let k = 10; k < 80; k += 7) if ((c + s + k) % 11 === 0) (track['p' + k] ??= []).push({ s: sid, place: 'p' + ((c + k) % 10) }); }
    files[`Big/${String(c).padStart(3, '0')} Chapter.md`] = t;
  }
  files['Big/story-engine.json'] = JSON.stringify({ version: 3, track, places, moments: [], view: 300 });
  await page.evaluate(async f => boot(f), files);
  const t0 = Date.now(); await page.evaluate(() => plugin.openWorld()); await page.waitForSelector('.se-clip'); const t1 = Date.now();
  const step = await page.evaluate(async () => { const p = plugin.activeProject(); const w = app.workspace.getLeavesOfType('story-engine-world')[0].view; const a = performance.now(); for (let i = 0; i < 10; i++) { p.data.view = 300 + i; await w.render(); } return (performance.now() - a) / 10; });
  console.log(`scenes: ${await page.$$eval('.se-clip', e => e.length)} clips · first open ${t1 - t0} ms · one step ${step.toFixed(0)} ms · errors: ${errors.length ? errors : 'none'}`);
  await b.close();
})();
