// Since 2.11: one line is one paragraph, and an empty line is a line of space.
const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, toLinePerParagraph, gapBefore, stylesOf } = require('./build/manuscript.cjs');
const k = s => classify(s.split('\n'));

test('chapter: frontmatter, heading, interlude, drop cap, paragraphs, empty lines', () => {
  const r = k(`---\ncssclasses: manuscript\n---\n# PROLOGUE\n*~Pale shapes~*\nCold and tired up.\n\nOn the ridge.\nThe haze.`);
  assert.deepEqual(r, ['frontmatter', 'frontmatter', 'frontmatter', 'heading', 'interlude', 'dropcap', 'gap', 'para', 'para']);
});
test('scene breaks in several spellings, and the paragraph after them', () => {
  for (const br of ['✦ ✦ ✦', '✦✦✦', '***', '* * *', '⁂']) {
    assert.deepEqual(k(`# A\nOne.\n${br}\nTwo.\nThree.`), ['heading', 'dropcap', 'break', 'first', 'para'], br);
  }
});
test('lists, quotes, images and hidden notes are left alone; every other line is its own paragraph', () => {
  assert.deepEqual(k(`# A\n%% se-scene id=a %%\nFirst para\nSecond para.\n- a list\n> quote\n![[map.png]]\nText.`), ['heading', 'other', 'dropcap', 'para', 'other', 'other', 'other', 'para']);
  assert.equal(k('* lone bullet')[0], 'other');
});
test('notes without a heading are just paragraphs', () => {
  assert.deepEqual(k('One.\nTwo.'), ['para', 'para']);
});
test('empty lines: each is a line of space; gapBefore counts them', () => {
  const kinds = k('# A\nOne.\n\n\nTwo.');
  assert.deepEqual(kinds, ['heading', 'dropcap', 'gap', 'gap', 'para']);
  assert.equal(gapBefore(kinds, 4), 2); assert.equal(gapBefore(kinds, 1), 0);
});
test('styles belong to the line they are marked on', () => {
  const lines = ['# A', '%%style:epigraph%% *~Bells~*', 'The chamber.'];
  assert.deepEqual(stylesOf(lines, classify(lines)), [null, 'epigraph', null]);
});
test('converting a story written the old way: one empty line less between lines of text, nothing else changes', () => {
  const old = '---\ncssclasses: manuscript\n---\n\n# PROLOGUE\n\n%% se-scene id=a %%\n\n*~Pale shapes~*\n\nCold and tired up.\n\n\nOn the ridge.\n\n✦ ✦ ✦\n\nLater.\n';
  assert.equal(toLinePerParagraph(old), '---\ncssclasses: manuscript\n---\n# PROLOGUE\n%% se-scene id=a %%\n*~Pale shapes~*\nCold and tired up.\n\nOn the ridge.\n✦ ✦ ✦\nLater.\n');
  const once = toLinePerParagraph(old);
  assert.equal(toLinePerParagraph(old.replace(/\n\n(?!\n)/g, '\n\n')), once, 'same input, same result');
  assert.equal(toLinePerParagraph('No frontmatter\n\nTwo'), 'No frontmatter\nTwo');
});
