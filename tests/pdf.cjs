// The PDF export's pages, printed by Chromium (the engine inside Obsidian): page size, title page, chapters, fonts, numbers.
const B = require('./build/book.cjs'), M = require('./build/model.cjs'), fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { chromium } = require('playwright'); const { execFileSync } = require('child_process');
const out = path.join(__dirname, 'build', 'pdf'); fs.mkdirSync(out, { recursive: true });
const fonts = { text: fs.readFileSync(path.join(__dirname, '../fonts/LibreBaskerville.woff2')), italic: fs.readFileSync(path.join(__dirname, '../fonts/LibreBaskerville-Italic.woff2')), blackletter: fs.readFileSync(path.join(__dirname, '../fonts/UnifrakturMaguntia.woff2')) };
const look = { ...M.DEFAULT_LOOK, size: 15, styles: [{ id: 'epigraph', name: 'Epigraph', color: '#c9b98f', paperColor: '#7a3b2e', italic: false, align: 'left', size: 1, spaceBefore: 0, spaceAfter: 1 }] };
const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}. ` + 'The bells rang over the chamber while the girls waited by the door. '.repeat(4)).join('\n');
const chapters = [
  B.chapterBlocks(`# PROLOGUE\n%%style:epigraph%% *~Hearing nothing but the wind.~*\nCold and tired, looking up at the darkening sky.\n✦ ✦ ✦\n${long}\n`, 'Prologue'),
  B.chapterBlocks(`# BRAN\nExcited as the boy was, riding out through the snow.\n${long}\n`, 'Bran'),
];
(async () => {
  const b = await chromium.launch(); let failed = 0;
  const check = async (name, f) => { try { await f(); console.log('✓', name); } catch (e) { failed++; console.log('✗', name, '\n ', e.message.split('\n').slice(0, 6).join('\n  ')); } };
  for (const size of ['6x9', 'A4']) await check(`PDF on ${M.PAGE_SIZES[size].label} pages`, async () => {
    const html = B.buildPrintHtml({ title: 'ASOIAF Sample', author: 'A. Writer', language: 'en', id: 'x', modified: new Date(), pageSize: size }, chapters, look, fonts);
    const p = await b.newPage(); await p.setContent(html); await p.evaluate(() => document.fonts.ready);
    const file = path.join(out, `book-${size}.pdf`); await p.pdf({ path: file, preferCSSPageSize: true, printBackground: true }); await p.close();
    const info = execFileSync('pdfinfo', [file]).toString(), pg = M.PAGE_SIZES[size];
    const [, w, h] = /Page size:\s+([\d.]+) x ([\d.]+) pts/.exec(info);
    assert.ok(Math.abs(w - pg.w * 72) < 1 && Math.abs(h - pg.h * 72) < 1, `${w} × ${h} pt`);
    const pages = Number(/Pages:\s+(\d+)/.exec(info)[1]); assert.ok(pages >= 4, `${pages} pages`);
    const fontsUsed = execFileSync('pdffonts', [file]).toString();
    assert.match(fontsUsed, /LibreBaskerville-Regular/); assert.match(fontsUsed, /LibreBaskerville-Italic/); assert.match(fontsUsed, /UnifrakturMaguntia/, 'the drop cap font');
    const text = n => execFileSync('pdftotext', ['-f', String(n), '-l', String(n), '-layout', file, '-']).toString();
    assert.match(text(1), /ASOIAF Sample[\s\S]*A\. Writer/); assert.doesNotMatch(text(1), /^\s*1\s*$/m, 'no number on the title page');
    assert.match(text(2), /PROLOGUE[\s\S]*Hearing nothing but the wind/); assert.match(text(3), /^\s*3\s*$/m, 'page numbers at the foot');
    const bran = [...Array(pages).keys()].map(i => i + 1).find(n => /BRAN/.test(text(n)));
    assert.ok(bran && !/Paragraph 40\./.test(text(bran).split('BRAN')[0]), 'a chapter starts on a new page');
  });
  await b.close();
  if (failed) { console.log(`\n${failed} PDF check(s) failed.`); process.exit(1); }
  console.log('\nPDF checks passed.');
})();
