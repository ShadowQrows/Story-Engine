/**
 * Works out what each line of a chapter is, from the text alone, so the look never depends on
 * which part of the note happens to be on screen. Pure function; no Obsidian imports.
 *
 * Since 2.11 the text matches the page, like a word processor: ONE LINE IS ONE PARAGRAPH, and an
 * empty line is an empty line on the page. (Stories written before 2.11 are converted once; see toLinePerParagraph.)
 *
 *   heading     "# PROLOGUE"
 *   dropcap     the first paragraph after a chapter title (gets the drop cap)
 *   first       the first paragraph after a scene break
 *   para        any other paragraph (gets the first-line indent)
 *   interlude   a paragraph that starts with ~ (optionally inside * or _), e.g. *~A voice in the dark…~*
 *   break       a scene break: ✦ ✦ ✦, ***, * * *, ---, ⁂
 *   gap         an empty line: one line of space
 *   other       anything else Markdown (lists, quotes, images, tables, code, hidden notes): left alone
 *   frontmatter the properties block at the top
 * ('cont' and 'blank' are no longer produced; they stay in the type for older callers.)
 */
export type LineKind = 'heading' | 'first' | 'dropcap' | 'para' | 'cont' | 'interlude' | 'break' | 'blank' | 'gap' | 'other' | 'frontmatter';

/** A paragraph style marker at the very start of a paragraph: `%%style:epigraph%% `. Hidden in the book look. */
export const STYLE_MARK = /^%%style:([a-z0-9-]+)%%[ \t]?/;
export const styleMark = (id: string) => `%%style:${id}%% `;
const BREAK = /^\s*(?:(?:[✦⁂∗*•·]\s*){1,7}|(?:-\s*){3,}|(?:_\s*){3,})$/u;
const HEADING = /^#{1,6}\s/;
const INTERLUDE = /^\s*(?:\*{1,3}|_{1,3})?\s*~/;
const OTHER = /^\s*(?:[-+*]\s|\d+[.)]\s|>|!\[|\||```|~~~|<|%%|\$\$)/;

export function classify(lines: string[]): LineKind[] {
  const out: LineKind[] = new Array(lines.length);
  let i = 0;
  if (lines[0]?.trim() === '---') {
    out[0] = 'frontmatter';
    for (i = 1; i < lines.length; i++) {
      out[i] = 'frontmatter';
      if (lines[i].trim() === '---' || lines[i].trim() === '...') { i++; break; }
    }
  }
  let mode: 'chapter' | 'scene' | 'none' = 'none';
  let inFence = false;
  for (; i < lines.length; i++) {
    const l = lines[i].replace(STYLE_MARK, '');
    if (/^\s*(```|~~~)/.test(l)) { inFence = !inFence; out[i] = 'other'; continue; }
    if (inFence) { out[i] = 'other'; continue; }
    // An empty line is an empty line on the page.
    if (!l.trim()) { out[i] = 'gap'; continue; }
    if (HEADING.test(l)) { out[i] = 'heading'; mode = 'chapter'; continue; }
    if (BREAK.test(l) && !/^\s*[*•·]\s*$/.test(l)) { out[i] = 'break'; mode = 'scene'; continue; }
    if (INTERLUDE.test(l)) { out[i] = 'interlude'; continue; }
    if (OTHER.test(l)) { out[i] = 'other'; continue; }
    out[i] = mode === 'chapter' ? 'dropcap' : mode === 'scene' ? 'first' : 'para';
    mode = 'none';
  }
  return out;
}

/** CSS classes for a line kind. Kept short and prefixed so they never clash with themes. */
export function classesFor(kind: LineKind): string {
  switch (kind) {
    case 'dropcap': return 'mm-line mm-first mm-dropcap';
    case 'first': return 'mm-line mm-first';
    case 'para': return 'mm-line mm-para';
    case 'cont': return 'mm-line mm-cont';
    case 'interlude': return 'mm-line mm-interlude';
    case 'break': return 'mm-line mm-break';
    case 'blank': return 'mm-line mm-blank';
    case 'gap': return 'mm-line mm-gap';
    case 'heading': return 'mm-line mm-heading';
    default: return '';
  }
}

/** Which paragraph style each line has (null for none). A style marked at a paragraph's start covers the lines that continue it. */
export function stylesOf(lines: string[], kinds: LineKind[]): (string | null)[] {
  return lines.map((l, i) => { const k = kinds[i]; return k === 'para' || k === 'first' || k === 'dropcap' || k === 'interlude' ? STYLE_MARK.exec(l)?.[1] ?? null : null; });
}

/** How many empty lines come right before line i (each is a line of space). */
export function gapBefore(kinds: LineKind[], i: number) { let n = 0; for (let k = i - 1; k >= 0 && kinds[k] === 'gap'; k--) n++; return n; }

/**
 * Stories written before 2.11 used Markdown's rule: an empty line between paragraphs. Now one line is one
 * paragraph, so each run of empty lines between two lines of text loses one (deliberate extra space stays).
 */
export function toLinePerParagraph(text: string): string {
  const lines = text.split('\n'), kinds = classify(lines), out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (kinds[i] === 'frontmatter' || lines[i].trim()) { out.push(lines[i]); i++; continue; }
    let j = i; while (j < lines.length && !lines[j].trim()) j++;
    const between = out.length > 0 && j < lines.length;
    for (let k = between ? i + 1 : i; k < j; k++) out.push('');
    i = j;
  }
  return out.join('\n');
}
