// Exports: chapters → book blocks, EPUB and Word files, the web copy, and the ZIP writer underneath.
const test = require('node:test'); const assert = require('assert/strict');
const B = require('./build/book.cjs'); const Z = require('./build/zip.cjs'); const M = require('./build/model.cjs');
const { execFileSync } = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path');
const PY = process.platform === 'win32' ? 'python' : 'python3'; // on Windows, python3 is a Store shortcut

// Since 2.11 one line is one paragraph; the empty line before "She stood up." is a line of space.
const PROLOGUE = `---
cssclasses: manuscript
---
# PROLOGUE
%% se-scene id=s1 pov=bran where=farm %%
%%style:epigraph%% *~Pale shapes moved between the trees, silent as the dead.~*
Cold and tired, looking up at the **darkening** sky. She saw [[Gared|her sister]] by the [[Farmhouse]].
The hail started.

She stood up.
✦ ✦ ✦
Later, the field was quiet. \\*Not\\* a sound.
`;

test('inline Markdown becomes runs: italic, bold, links, escapes, comments', () => {
  assert.deepEqual(B.inline('*~Pale shapes~*'), [{ t: '~Pale shapes~', i: true }]);
  assert.deepEqual(B.inline('a **b** c'), [{ t: 'a ' }, { t: 'b', b: true }, { t: ' c' }]);
  assert.deepEqual(B.inline('***both***'), [{ t: 'both', b: true, i: true }]);
  assert.equal(B.plain(B.inline('[[Gared|her sister]] and [[Farmhouse#Barn]]')), 'her sister and Farmhouse');
  assert.equal(B.plain(B.inline('\\*Not\\* a %%hidden%%sound')), '*Not* a sound');
  assert.deepEqual(B.inline('~~gone~~ ==hi=='), [{ t: 'gone', s: true }, { t: ' ' }, { t: 'hi', h: true }]);
  assert.equal(B.plain(B.inline('snake_case_word stays')), 'snake_case_word stays');
});

test('a chapter becomes title, styled interlude, drop-cap paragraph, paragraphs and a scene break', () => {
  const ch = B.chapterBlocks(PROLOGUE, 'Prologue');
  assert.equal(ch.title, 'PROLOGUE');
  const types = ch.blocks.map(b => b.type === 'p' ? `p${b.style ? ':' + b.style : ''}${b.dropcap ? ':drop' : ''}${b.interlude ? ':interlude' : ''}${b.indent ? ':indent' : ''}` : b.type);
  assert.deepEqual(types, ['title', 'p:epigraph:interlude', 'p:drop', 'p:indent', 'p:indent', 'break', 'p:indent']);
  assert.deepEqual(ch.blocks.map(b => b.space ?? 0), [0, 0, 0, 0, 1, 0, 0], 'the empty line is a line of space');
  assert.equal(B.plain(ch.blocks[1].lines[0]), '~Pale shapes moved between the trees, silent as the dead.~');
  assert.ok(ch.blocks.every(b => b.type !== 'p' || b.lines.length === 1), 'one line, one paragraph');
  assert.equal(B.plain(ch.blocks[2].lines[0]), 'Cold and tired, looking up at the darkening sky. She saw her sister by the Farmhouse.');
  assert.equal(B.chapterBlocks('Just text.', 'Chapter Two').title, 'Chapter Two', 'no heading: the file name');
});

const look = () => ({ ...M.DEFAULT_LOOK, styles: [{ id: 'epigraph', name: 'Epigraph', color: '#c9b98f', paperColor: '#6b4f2a', italic: true, align: 'center', size: 0.95 }] });
const meta = { title: 'ASOIAF Sample', author: 'A. Writer', language: 'en', id: '1b4e28ba-2fa1-11d2-883f-0016d3cca427', modified: new Date('2026-11-05T10:00:00Z') };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'se-book-'));
function unzip(bytes) { const f = path.join(tmp, 'x.zip'); fs.writeFileSync(f, bytes); const out = execFileSync(PY, ['-c', `
import zipfile, sys, json
z = zipfile.ZipFile(sys.argv[1]); bad = z.testzip()
print(json.dumps({'names': z.namelist(), 'bad': bad, 'first': z.infolist()[0].filename, 'first_compress': z.infolist()[0].compress_type, 'files': {n: z.read(n).decode('utf-8', 'replace') for n in z.namelist() if not n.endswith('.woff2')}}))`, f]); return JSON.parse(out); }

test('the ZIP writer makes archives other tools can read (CRCs check out)', () => {
  const z = unzip(Z.zip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.bin', data: new Uint8Array([0, 1, 2, 255]) }]));
  assert.deepEqual(z.names, ['a.txt', 'dir/b.bin']); assert.equal(z.bad, null); assert.equal(z.files['a.txt'], 'hello');
  assert.equal(Z.crc32(new TextEncoder().encode('The quick brown fox jumps over the lazy dog')), 0x414fa339);
});

test('EPUB: mimetype first and stored, the book look in its stylesheet, the style kept on the paragraph', () => {
  const fonts = { text: new Uint8Array([1]), italic: new Uint8Array([2]), blackletter: new Uint8Array([3]) };
  const z = unzip(B.buildEpub(meta, [B.chapterBlocks(PROLOGUE, 'Prologue')], look(), fonts));
  assert.equal(z.first, 'mimetype'); assert.equal(z.first_compress, 0); assert.equal(z.files.mimetype, 'application/epub+zip');
  for (const n of ['META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/nav.xhtml', 'OEBPS/toc.ncx', 'OEBPS/style.css', 'OEBPS/ch001.xhtml', 'OEBPS/fonts/LibreBaskerville.woff2', 'OEBPS/fonts/Blackletter.woff2']) assert.ok(z.names.includes(n), n);
  const ch = z.files['OEBPS/ch001.xhtml'];
  assert.match(ch, /<h1>PROLOGUE<\/h1>/);
  assert.match(ch, /<p class="noindent interlude st-epigraph"><em>~Pale shapes[^<]*~<\/em><\/p>/);
  assert.match(ch, /<p class="noindent dropcap">Cold and tired, looking up at the <strong>darkening<\/strong> sky\. She saw her sister by the Farmhouse\.<\/p>\n<p class="indent">The hail started\.<\/p>\n<p class="indent" style="margin-top: 1\.5em">She stood up\.<\/p>/);
  assert.match(ch, /<p class="break">✦ ✦ ✦<\/p>/);
  assert.doesNotMatch(ch, /se-scene|%%/, 'hidden notes stay hidden');
  const css = z.files['OEBPS/style.css'];
  assert.match(css, /p\.st-epigraph \{ color: #6b4f2a; font-style: italic; text-align: center; text-indent: 0; font-size: 0\.95em; \}/);
  assert.match(css, /p\.indent \{ text-indent: 3\.00em; \}/);
  assert.match(css, /p\.dropcap::first-letter \{ float: left; font-family: "Old English Text MT", "MM Blackletter", serif; font-size: 3\.9em;/);
  assert.match(z.files['OEBPS/content.opf'], /<dc:creator>A\. Writer<\/dc:creator>/);
  // Every XML file is well-formed.
  for (const [n, txt] of Object.entries(z.files)) if (/\.(xhtml|opf|ncx|xml)$/.test(n)) execFileSync(PY, ['-c', 'import sys, xml.dom.minidom; xml.dom.minidom.parseString(sys.stdin.read().encode())'], { input: txt });
});

test('Word: real styles (Heading 1 chapters, body text, the Epigraph style with its colour), readable by python-docx', () => {
  const f = path.join(tmp, 'book.docx'); fs.writeFileSync(f, B.buildDocx(meta, [B.chapterBlocks(PROLOGUE, 'Prologue')], look()));
  const out = JSON.parse(execFileSync(PY, ['-c', `
import docx, sys, json
d = docx.Document(sys.argv[1])
ps = [{'style': p.style.name, 'text': p.text, 'italic': [r.italic for r in p.runs], 'bold': [r.bold for r in p.runs]} for p in d.paragraphs]
st = d.styles['Epigraph']
print(json.dumps({'ps': ps, 'color': str(st.font.color.rgb), 'italic': st.font.italic, 'align': str(st.paragraph_format.alignment)}))`, f]));
  const styles = out.ps.map(p => p.style);
  assert.deepEqual(styles, ['Title', 'Subtitle', 'Heading 1', 'Epigraph', 'Body Text First', 'Body Text First', 'Body Text', 'Body Text', 'Scene Break', 'Body Text']);
  assert.equal(out.ps[4].text, 'C', 'the drop cap: the first letter in its own box'); assert.match(out.ps[5].text, /^old and tired/);
  assert.equal(out.ps[3].text, '~Pale shapes moved between the trees, silent as the dead.~');
  assert.equal(out.color, '6B4F2A'); assert.equal(out.italic, true); assert.match(out.align, /CENTER/);
  assert.deepEqual(out.ps[5].bold, [null, true, null], 'bold kept');
});

test('web copy: plain paragraphs, the style written on its paragraph, and a plain-text version', () => {
  const w = B.webChapter(B.chapterBlocks(PROLOGUE, 'Prologue'), look());
  assert.match(w.html, /^<h1>PROLOGUE<\/h1>/);
  assert.match(w.html, /<p style="color:#6b4f2a;font-style:italic;text-align:center;"><em><em>~Pale shapes/);
  assert.match(w.html, /<p style="text-align:center">✦ ✦ ✦<\/p>/);
  assert.match(w.text, /^PROLOGUE\n\n~Pale shapes[^\n]*~\n\nCold and tired/);
});

test('styles survive loading: ids, colours, alignment; unknown values fall back', () => {
  const d = M.normalizeData({ look: { styles: [{ id: 'epigraph', name: 'Epigraph', color: '#112233', paperColor: 'nope', italic: 1, align: 'middle', size: 9 }, { id: 'Bad Id' }], paper: true, paperBg: '#ffffff' } });
  assert.deepEqual(d.look.styles, [{ id: 'epigraph', name: 'Epigraph', color: '#112233', paperColor: '#6b4f2a', italic: true, align: 'left', size: 3, spaceBefore: 0, spaceAfter: 0 }]);
  assert.equal(d.look.paper, true); assert.equal(d.look.paperBg, '#ffffff'); assert.equal(d.look.paperText, M.DEFAULT_LOOK.paperText);
  assert.equal(M.styleId('Epigraph!', ['epigraph']), 'epigraph-2');
});

test('empty lines are space: the line kind, the blocks, EPUB margin, Word spacing, web blank paragraphs', () => {
  const S = require('./build/manuscript.cjs');
  const text = '# ONE\nFirst paragraph.\n\n\nAfter two lines of space.\n✦ ✦ ✦\n\nAfter one more.\n';
  assert.deepEqual(S.classify(text.split('\n')), ['heading', 'dropcap', 'gap', 'gap', 'para', 'break', 'gap', 'first', 'gap']);
  const ch = B.chapterBlocks(text, 'One');
  assert.deepEqual(ch.blocks.map(b => b.space ?? 0), [0, 0, 2, 0, 1]);
  const l = { ...M.DEFAULT_LOOK, lineHeight: 1.5 };
  const z = unzip(B.buildEpub(meta, [ch], l));
  assert.match(z.files['OEBPS/ch001.xhtml'], /<p class="indent" style="margin-top: 3em">After two lines of space\.<\/p>/);
  const w = B.webChapter(ch, l);
  assert.match(w.html, /First paragraph\.<\/p>\n<p>&nbsp;<\/p>\n<p>&nbsp;<\/p>\n<p>After two/);
  const f = path.join(tmp, 'gap.docx'); fs.writeFileSync(f, B.buildDocx(meta, [ch], l));
  const before = JSON.parse(execFileSync(PY, ['-c', `
import docx, sys, json
d = docx.Document(sys.argv[1]); print(json.dumps([[p.text, p.paragraph_format.space_before.pt if p.paragraph_format.space_before is not None else None] for p in d.paragraphs]))`, f]));
  const sb = before.find(x => x[0] === 'After two lines of space.')[1];
  assert.ok(Math.abs(sb - 2 * 17 * 0.75 * 1.5) < 0.06, `two lines before (${sb}pt)`);
});

test('2.10 a style can carry space before and after (lines), in every export', () => {
  const l = { ...M.DEFAULT_LOOK, lineHeight: 1.5, styles: [{ id: 'epigraph', name: 'Epigraph', color: '#c9b98f', paperColor: '#6b4f2a', italic: false, align: 'left', size: 1, spaceBefore: 0, spaceAfter: 1 }] };
  assert.match(B.bookCss(l, { text: false, dropcap: false }), /p\.st-epigraph \{ color: #6b4f2a; margin-bottom: calc\(1\.5em \+ 0em\); \}/);
  const ch = B.chapterBlocks('# T\n%%style:epigraph%% *~Bells.~*\nThe chamber.\n', 'T');
  assert.match(B.webChapter(ch, l).html, /~Bells\.~<\/em><\/p>\n<p>&nbsp;<\/p>\n<p>The chamber/);
  const f = path.join(tmp, 'st.docx'); fs.writeFileSync(f, B.buildDocx(meta, [ch], l));
  const after = execFileSync(PY, ['-c', 'import docx, sys; d = docx.Document(sys.argv[1]); print(d.styles["Epigraph"].paragraph_format.space_after.pt)', f]).toString().trim();
  assert.ok(Math.abs(Number(after) - 17 * 0.75 * 1.5) < 0.06, `one line after (${after}pt)`);
  assert.equal(M.normalizeData({ look: { styles: [{ id: 'a', spaceBefore: 2, spaceAfter: 99 }] } }).look.styles[0].spaceAfter, 10);
});

test('Word drop cap: a box the text flows around, lines tall, with the letter at the drop cap size; fonts embedded', () => {
  const ttf = { text: fs.readFileSync(path.join(__dirname, '../fonts/LibreBaskerville.ttf')), italic: fs.readFileSync(path.join(__dirname, '../fonts/LibreBaskerville-Italic.ttf')), blackletter: fs.readFileSync(path.join(__dirname, '../fonts/UnifrakturMaguntia.ttf')) };
  const l = { ...M.DEFAULT_LOOK, size: 16, lineHeight: 1.5, dropcapSize: 3.9 };
  const fit = { font: 'UnifrakturMaguntia', embedded: true, lines: 3, ascent: 0.75, descent: 0.2, width: 0.8 };
  const z = unzip(B.buildDocx(meta, [B.chapterBlocks(PROLOGUE, 'Prologue')], l, ttf, fit));
  const doc = z.files['word/document.xml'];
  assert.match(doc, /<w:framePr w:w="\d+" w:h="1080" w:hRule="exact" w:wrap="around"/, 'three lines of 12pt × 1.5 = 54pt = 1080 twips');
  assert.match(doc, /w:ascii="UnifrakturMaguntia"[^>]*\/><w:i w:val="0"\/><w:b w:val="0"\/><w:sz w:val="94"\/>/, '3.9 × 12pt ≈ 47pt');
  assert.ok(z.names.includes('word/fonts/font3.odttf') && z.names.includes('word/fontTable.xml'));
  assert.match(z.files['word/fontTable.xml'], /<w:font w:name="UnifrakturMaguntia">.*<w:embedRegular r:id="rIdF3" w:fontKey="\{[0-9A-F-]+\}"\/>/);
  // The embedded font is the real one, scrambled only in its first 32 bytes (as Word expects).
  const raw = execFileSync(PY, ['-c', 'import zipfile,sys; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read("word/fonts/font3.odttf"))', path.join(tmp, 'x.zip')]);
  assert.equal(raw.length, ttf.blackletter.length); assert.ok(raw.subarray(32).equals(ttf.blackletter.subarray(32))); assert.ok(!raw.subarray(0, 32).equals(ttf.blackletter.subarray(0, 32)));
  // Without a measured fit (or with your own font installed) nothing is embedded for the drop cap.
  const z2 = unzip(B.buildDocx(meta, [B.chapterBlocks(PROLOGUE, 'Prologue')], l, ttf, { ...fit, font: 'Old English Text MT', embedded: false }));
  assert.match(z2.files['word/document.xml'], /w:ascii="Old English Text MT"/); assert.doesNotMatch(z2.files['word/fontTable.xml'], /Unifraktur/);
});

test('the Word file uses the chosen page size and margins', () => {
  const z = unzip(B.buildDocx({ ...meta, pageSize: 'A4' }, [B.chapterBlocks(PROLOGUE, 'Prologue')], look()));
  assert.match(z.files['word/document.xml'], /<w:pgSz w:w="11909" w:h="16834"\/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/);
  const z2 = unzip(B.buildDocx(meta, [B.chapterBlocks(PROLOGUE, 'Prologue')], look()));
  assert.match(z2.files['word/document.xml'], /<w:pgSz w:w="8640" w:h="12960"\/>/, '6 × 9 when none is chosen');
});

