const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
const dir = process.argv[2], out = process.argv[3];
const files = {};
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else files[path.relative(path.dirname(dir), p).split(path.sep).join('/')] = fs.readFileSync(p, 'utf8'); } })(dir);
(async () => {
  const b = await chromium.launch();
  for (const [w, name] of [[1800, 'wide'], [1150, 'narrow']]) {
    const page = await b.newPage({ viewport: { width: w, height: 1000 } });
    await page.goto('file://' + path.join(__dirname, 'harness.html'));
    await page.evaluate(async f => boot(f), files);
    await page.evaluate(() => plugin.openWorld()); await page.waitForTimeout(500);
    await page.evaluate(() => plugin.activeProject().setView(2)); await page.waitForTimeout(500);
    await page.locator('#side').screenshot({ path: path.join(out, `world-${name}.png`) });
    if (name === 'wide') { await page.locator('.se-tab:has-text("Setup")').click(); await page.waitForTimeout(200); await page.locator('.se-fold:has-text("Piece types")').click(); await page.locator('.se-fold:has-text("Connection types")').click(); await page.waitForTimeout(200); await page.locator('.se-side').screenshot({ path: path.join(out, 'setup.png') }); }
    await page.close();
  }
  await b.close();
})();
