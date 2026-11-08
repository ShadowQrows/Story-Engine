const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
const dir = process.argv[2], out = process.argv[3];
const files = {};
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else files[path.relative(path.dirname(dir), p).split(path.sep).join('/')] = fs.readFileSync(p, 'utf8'); } })(dir);
(async () => {
  const b = await chromium.launch(); const page = await b.newPage({ viewport: { width: 1800, height: 1100 } });
  await page.goto('file://' + path.join(__dirname, 'harness.html'));
  await page.evaluate(async f => boot(f), files);
  await page.evaluate(() => plugin.openWorld()); await page.waitForTimeout(600);
  for (const v of [1, 2, 4, 6, 7, 9]) {
    await page.evaluate(v => plugin.activeProject().setView(v), v); await page.waitForTimeout(500);
    await page.locator('.se-map').screenshot({ path: path.join(out, `map-${v}.png`) });
  }
  await page.evaluate(() => plugin.activeProject().setView(7)); await page.waitForTimeout(400);
  const h = await page.locator('.se-pin:has-text("The Great Hall") i').boundingBox();
  for (let i = 0; i < 3; i++) { await page.mouse.move(h.x, h.y + 40); await page.mouse.wheel(0, -250); await page.waitForTimeout(60); }
  await page.waitForTimeout(500);
  await page.locator('.se-map').screenshot({ path: path.join(out, 'map-7-zoom.png') });
  await b.close();
})();
