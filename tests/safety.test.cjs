// Safety rules: the plugin must never damage the text or data of a novel it is given.
const test = require('node:test'); const assert = require('assert/strict');
const M = require('./build/model.cjs');
const { toLinePerParagraph } = require('./build/manuscript.cjs');

test('removing a description never touches the properties, and only removes a whole block', () => {
  const note = '---\nse-id: x\naliases:\n  - Ned\n---\n\nNed\n\nNed is grave.\n';
  const out = M.removeBlock(note, 'Ned');
  assert.equal(out, '---\nse-id: x\naliases:\n  - Ned\n---\n\nNed is grave.\n', 'the property line stays');
  assert.equal(M.removeBlock('---\nse-id: x\n---\n\nNed is grave.\n', 'Ned'), '---\nse-id: x\n---\n\nNed is grave.\n', 'part of a paragraph is not a block');
  assert.equal(M.removeBlock('---\nse-id: x\n---\n\nOne.\n\nTwo.\n', 'Two.'), '---\nse-id: x\n---\n\nOne.\n', 'the last block');
});

test('converting to one line per paragraph leaves code, tables and lists as Markdown needs them', () => {
  const code = 'Before.\n\n```\nline 1\n\nline 2\n```\n\nAfter.';
  assert.match(toLinePerParagraph(code), /line 1\n\nline 2/, 'empty lines inside code stay');
  assert.equal(toLinePerParagraph('Text.\n\n| a | b |\n|---|---|\n| 1 | 2 |'), 'Text.\n\n| a | b |\n|---|---|\n| 1 | 2 |', 'a table keeps the empty line before it');
  assert.equal(toLinePerParagraph('Text.\n\n- one\n- two'), 'Text.\n\n- one\n- two', 'so does a list');
  assert.equal(toLinePerParagraph('One.\n\nTwo.\n\n\nThree.'), 'One.\nTwo.\n\nThree.', 'paragraphs still lose one empty line');
});

test('data written by a newer version is kept, not dropped', () => {
  const d = M.normalizeData({ version: 3, moments: [], futureThing: { a: 1 }, track: {} });
  assert.deepEqual(d.futureThing, { a: 1 });
  assert.equal(JSON.parse(JSON.stringify(d)).futureThing.a, 1);
});

test('a moment can end before the next one starts', () => {
  const t = M.buildTimeline([{ id: 'a', moment: 'm1' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], [{ id: 'm1', label: 'Day 1', note: '', skip: false, until: 'b' }]);
  assert.deepEqual(t.bands.map(b => [b.start, b.end]), [[0, 2]]);
  assert.equal(M.bandAt(t, 3), undefined, 'scenes after it are in no moment');
});

test('a chapter without a title gets one, and its title follows a file rename', () => {
  assert.equal(M.withTitle('---\ncssclasses: manuscript\n---\nText.', 'Untitled'), '---\ncssclasses: manuscript\n---\n# UNTITLED\nText.');
  assert.equal(M.withTitle('# Mine\nText.', 'Untitled'), '# Mine\nText.', 'an existing title stays');
  assert.equal(M.retitle('---\na: 1\n---\n# UNTITLED\nText.', 'Untitled', 'Prologue'), '---\na: 1\n---\n# PROLOGUE\nText.');
  assert.equal(M.retitle('# The Long Night\nText.', 'Untitled', 'Prologue'), '# The Long Night\nText.', 'a title of your own is never replaced');
  assert.equal(M.retitle('Text.', 'Untitled', 'Prologue'), '# PROLOGUE\nText.', 'no title yet: one is added');
});

test('broken links are found and matched to what they most likely are now', () => {
  const d = M.normalizeData({ version: 3, moments: [], track: {
    old1: [{ s: 'sA', place: 'plc' }],          // a piece whose note lost its id (now a new piece of the same name)
    gone2: [{ s: 'sB' }],                        // a piece nobody can find
    ok3: [{ s: 'sGone', pt: { x: 0.5, y: 0.5 } }], // a scene whose settings comment was deleted
  }, places: { plc: { x: 0.2, y: 0.2 } } });
  d.names = { old1: { n: 'Mara', t: 'character' }, gone2: { n: 'Nobody', t: 'character' } };
  d.sceneKeys = { sGone: { f: 'Story/02 Two.md', i: 1, t: 'the rain had stopped by the time she reached the bridge' } };
  const pieces = [{ id: 'new1', path: 'Story/World/Characters/Mara.md', name: 'Mara', type: 'character', aliases: [], connections: [], themes: [] },
                  { id: 'ok3', path: 'x', name: 'Ok', type: 'character', aliases: [], connections: [], themes: [] },
                  { id: 'plc', path: 'y', name: 'Bridge', type: 'place', aliases: [], connections: [], themes: [] }];
  const scenes = [{ id: 'sA', file: 'Story/01 One.md', index: 0, text: 'x', meta: {} }, { id: 'sB', file: 'Story/02 Two.md', index: 0, text: 'y', meta: {} },
                  { file: 'Story/02 Two.md', index: 1, text: 'the rain had stopped by the time she reached the bridge', meta: {} }];
  const b = M.brokenLinks(d, pieces, scenes, []);
  assert.deepEqual(b.pieces.map(x => [x.id, x.name, x.to ?? null]), [['old1', 'Mara', 'new1'], ['gone2', 'Nobody', null]]);
  assert.deepEqual(b.scenes.map(x => [x.id, x.to ?? null]), [['sGone', 2]]);
  const loose = M.brokenLinks(d, pieces.slice(1), scenes, [{ path: 'Story/World/Characters/Mara.md', name: 'Mara' }]);
  assert.equal(loose.pieces.find(x => x.id === 'old1').note, 'Story/World/Characters/Mara.md', 'a note that lost its id is found by its name');
});

test('the drop cap can be switched off, in exports too', () => {
  const B = require('./build/book.cjs');
  const on = B.bookCss({ ...M.DEFAULT_LOOK }, { text: false, dropcap: false }), off = B.bookCss({ ...M.DEFAULT_LOOK, dropcap: false }, { text: false, dropcap: false });
  assert.match(on, /p\.dropcap::first-letter/);
  assert.doesNotMatch(off, /p\.dropcap::first-letter/);
  assert.equal(M.normalizeData({ look: { dropcap: false } }).look.dropcap, false);
  assert.equal(M.normalizeData({ look: {} }).look.dropcap, true, 'on unless switched off');
});

test('PDF margins: the same on every page unless mirrored for a printed book', () => {
  const B = require('./build/book.cjs');
  const meta = { title: 'T', author: '', language: 'en', id: 'x', modified: new Date(), pageSize: '6x9' };
  const flat = B.buildPrintHtml(meta, [], { ...M.DEFAULT_LOOK }), mirrored = B.buildPrintHtml({ ...meta, mirror: true }, [], { ...M.DEFAULT_LOOK });
  assert.doesNotMatch(flat, /@page :left/);
  assert.match(mirrored, /@page :left/);
  const pg = M.pageOf('6x9'), side = (pg.inner + pg.outer) / 2;
  assert.match(flat, new RegExp(`margin: ${pg.top}in ${side}in ${pg.bottom}in ${side}in`));
});
