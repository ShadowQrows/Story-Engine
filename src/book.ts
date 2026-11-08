/**
 * Turns chapters into a book: blocks (titles, paragraphs, scene breaks) with their styles,
 * then an EPUB e-book, a Word document, or HTML to paste into a webnovel site.
 * Pure functions: no Obsidian imports, so they can be tested on their own.
 */
import * as M from './model';
import { classify, STYLE_MARK, stylesOf } from './manuscript';
import { zip, ZipEntry } from './zip';

/* ───────── chapters → blocks ───────── */

export interface Run { t: string; b?: boolean; i?: boolean; s?: boolean; h?: boolean }
export type Block =
  | { type: 'title'; runs: Run[] }
  | { type: 'break'; text: string; space?: number }
  | { type: 'p'; lines: Run[][]; indent: boolean; dropcap: boolean; interlude: boolean; quote: boolean; style: string | null; space?: number /* lines of space before it (extra empty lines) */ };
export interface Chapter { title: string; blocks: Block[] }

/** Markdown emphasis and Obsidian links → runs of text with bold / italic / strike / highlight. */
export function inline(src: string): Run[] {
  let s = src
    .replace(/%%[\s\S]*?%%/g, '')                                  // comments
    .replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/g, '')          // embeds and images
    .replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?\|([^\]]*)\]\]/g, '$2')  // [[note|shown text]]
    .replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?\]\]/g, '$1')            // [[note]]
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')                       // [text](url)
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\\([\\*_~=`[\]#])/g, (_, c) => `\u0007${c.charCodeAt(0)}\u0007`);   // escaped characters stay literal
  // Mark emphasis with private characters, innermost last, then split into runs.
  const mark = (re: RegExp, on: string, off: string) => { s = s.replace(re, (_m, inner) => `${on}${inner}${off}`); };
  mark(/\*\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*\*/g, '\u0001\u0003', '\u0004\u0002');
  mark(/___(?=\S)([\s\S]+?)(?<=\S)___/g, '\u0001\u0003', '\u0004\u0002');
  mark(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, '\u0001', '\u0002');
  mark(/__(?=\S)([\s\S]+?)(?<=\S)__/g, '\u0001', '\u0002');
  mark(/(?<![*\w])\*(?=[^\s*])([\s\S]+?)(?<=[^\s*])\*(?![*\w])/g, '\u0003', '\u0004');
  mark(/(?<![\w])_(?=[^\s_])([\s\S]+?)(?<=[^\s_])_(?![\w])/g, '\u0003', '\u0004');
  mark(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, '\u0005', '\u0006');
  mark(/==(?=\S)([\s\S]+?)(?<=\S)==/g, '\u000e', '\u000f');
  s = s.replace(/\u0007(\d+)\u0007/g, (_, n) => String.fromCharCode(Number(n)));
  const out: Run[] = []; let b = 0, i = 0, st = 0, h = 0, buf = '';
  const flush = () => { if (buf) out.push({ t: buf, ...(b > 0 ? { b: true } : {}), ...(i > 0 ? { i: true } : {}), ...(st > 0 ? { s: true } : {}), ...(h > 0 ? { h: true } : {}) }); buf = ''; };
  for (const ch of s) {
    switch (ch) {
      case '\u0001': flush(); b++; break; case '\u0002': flush(); b--; break;
      case '\u0003': flush(); i++; break; case '\u0004': flush(); i--; break;
      case '\u0005': flush(); st++; break; case '\u0006': flush(); st--; break;
      case '\u000e': flush(); h++; break; case '\u000f': flush(); h--; break;
      default: buf += ch;
    }
  }
  flush();
  return out;
}
export const plain = (runs: Run[]) => runs.map(r => r.t).join('');

/** One chapter's text → its title and blocks, laid out like the book look. */
export function chapterBlocks(text: string, fallbackTitle: string): Chapter {
  const lines = text.split(/\r?\n/), kinds = classify(lines), styles = stylesOf(lines, kinds);
  const blocks: Block[] = []; let title: string | null = null;
  let cur: Extract<Block, { type: 'p' }> | null = null, inComment = false, gap = 0;
  const add = <T extends Block>(b: T): T => { if (gap && b.type !== 'title') (b as { space?: number }).space = gap; gap = 0; blocks.push(b); return b; };
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n], k = kinds[n], t = raw.trim();
    if (inComment) { if (t.endsWith('%%')) inComment = false; continue; }
    if (k === 'frontmatter') continue;
    // One line is one paragraph; only a quote (> …) runs on over several lines.
    const keeps = k === 'cont' || (k === 'other' && cur?.quote && /^\s*>/.test(raw));
    if (!keeps) cur = null;
    if (!STYLE_MARK.test(raw) && t.startsWith('%%')) { if (!(t.length > 2 && t.endsWith('%%'))) inComment = true; continue; }   // a comment (e.g. the scene's settings)
    if (k === 'blank') continue;
    if (k === 'gap') { gap++; continue; }
    if (k === 'heading') {
      const runs = inline(raw.replace(/^#{1,6}\s+/, ''));
      if (title == null) title = plain(runs).trim();
      gap = 0; blocks.push({ type: 'title', runs });
      continue;
    }
    if (k === 'break') { add({ type: 'break', text: t.replace(/^-{3,}$|^_{3,}$|^\*{3}$/, '✦ ✦ ✦') }); continue; }
    const body = raw.replace(STYLE_MARK, '');
    if (k === 'other') {
      if (/^\s*!\[|^\s*\||^\s*(```|~~~)/.test(raw)) continue;   // images, tables and code blocks aren't part of the book
      const quote = /^\s*>/.test(raw), txt = body.replace(/^\s*>\s?/, '').replace(/^\s*(?:[-+*]|\d+[.)])\s+/, '');
      if (!txt.trim()) continue;
      if (quote && cur?.quote) { cur.lines.push(inline(txt)); continue; }
      cur = add({ type: 'p', lines: [inline(txt)], indent: false, dropcap: false, interlude: false, quote, style: null }); continue;
    }
    if (cur && k === 'cont') { cur.lines.push(inline(body)); continue; }
    cur = add({ type: 'p', lines: [inline(body)], indent: k === 'para' || k === 'first', dropcap: k === 'dropcap', interlude: k === 'interlude', quote: false, style: styles[n] });
  }
  if (title == null) { title = fallbackTitle; blocks.unshift({ type: 'title', runs: [{ t: fallbackTitle }] }); }
  return { title, blocks };
}

/* ───────── HTML (EPUB pages and the web) ───────── */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function runsHtml(runs: Run[]) {
  return runs.map(r => {
    let h = esc(r.t);
    if (r.h) h = `<mark>${h}</mark>`; if (r.s) h = `<del>${h}</del>`; if (r.i) h = `<em>${h}</em>`; if (r.b) h = `<strong>${h}</strong>`;
    return h;
  }).join('');
}
const linesHtml = (lines: Run[][]) => lines.map(runsHtml).join('<br/>');
const pClass = (b: Extract<Block, { type: 'p' }>) => [b.indent ? 'indent' : 'noindent', b.dropcap && 'dropcap', b.interlude && 'interlude', b.quote && 'quote', b.style && `st-${b.style}`].filter(Boolean).join(' ');

/** The e-book's stylesheet: the book look (font, spacing, indent, titles, drop cap, styles). Readers may still override some of it. */
export function bookCss(l: M.BookLook, fonts: { text: boolean; dropcap: boolean }, url: (file: string) => string = f => `fonts/${f}`) {
  const font = l.font || 'Libre Baskerville', em = (inches: number) => `${(inches * 6).toFixed(2)}em`;
  const drop = l.dropcapFont === 'Same as the text' ? `"${font}", serif` : l.dropcapFont === 'Blackletter (built in)' ? '"MM Blackletter", serif' : `"${l.dropcapFont}", "MM Blackletter", serif`;
  let css = '';
  if (fonts.text) css += `@font-face { font-family: "Libre Baskerville"; src: url(${url('LibreBaskerville.woff2')}); font-style: normal; font-weight: normal; }\n@font-face { font-family: "Libre Baskerville"; src: url(${url('LibreBaskerville-Italic.woff2')}); font-style: italic; font-weight: normal; }\n`;
  if (fonts.dropcap) css += `@font-face { font-family: "MM Blackletter"; src: url(${url('Blackletter.woff2')}); }\n`;
  css += `body { font-family: "${font}", Georgia, serif; line-height: ${l.lineHeight}; margin: 0 4%; }
h1 { font-size: ${l.titleSize}em; font-weight: bold; text-align: center; margin: 2.5em 0 1.6em; line-height: 1.3; page-break-before: always; break-before: page; }
.title-page h1 { margin-top: 30%; font-size: 2.2em; }
.title-page .author { text-align: center; text-indent: 0; margin-top: 2em; font-size: 1.15em; }
p { margin: 0 0 ${l.paraSpace}em; text-indent: 0; orphans: 2; widows: 2; }
p.indent { text-indent: ${em(l.indent)}; }
p.dropcap::first-letter { float: left; font-family: ${drop}; font-size: ${l.dropcapSize}em; line-height: 0.82; margin: 0.04em 0.08em 0 0; font-style: normal; font-weight: normal; }
p.break { text-align: center; text-indent: 0; letter-spacing: 0.5em; margin: 0.9em 0; }
p.interlude { text-indent: 0; font-size: 0.92em; margin: 0.4em 0; }
p.quote { margin: 0.6em 2em; text-indent: 0; }
`;
  const lines = (n: number, size = 1) => `${+(n * l.lineHeight / size).toFixed(3)}em`;
  for (const st of l.styles) css += `p.st-${st.id} { color: ${st.paperColor};${st.italic ? ' font-style: italic;' : ''}${st.align !== 'left' ? ` text-align: ${st.align}; text-indent: 0;` : ''}${st.size !== 1 ? ` font-size: ${st.size}em;` : ''}${st.spaceBefore ? ` margin-top: ${lines(st.spaceBefore, st.size)};` : ''}${st.spaceAfter ? ` margin-bottom: calc(${lines(st.spaceAfter, st.size)} + ${l.paraSpace}em);` : ''} }\n`;
  return css;
}
/** Extra empty lines before a paragraph become space above it (added to its style's own space before). */
function spaceAttr(b: Block, look: M.BookLook) {
  if (b.type === 'title' || !b.space) return '';
  const st = b.type === 'p' && b.style ? look.styles.find(s => s.id === b.style) : undefined, size = st?.size ?? 1;
  return ` style="margin-top: ${+((b.space + (st?.spaceBefore ?? 0)) * look.lineHeight / size).toFixed(3)}em"`;
}
function blockXhtml(b: Block, look: M.BookLook) {
  if (b.type === 'title') return `<h1>${runsHtml(b.runs)}</h1>`;
  if (b.type === 'break') return `<p class="break"${spaceAttr(b, look)}>${esc(b.text)}</p>`;
  return `<p class="${pClass(b)}"${spaceAttr(b, look)}>${linesHtml(b.lines)}</p>`;
}
const xhtml = (title: string, lang: string, body: string, cls = '') => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${esc(lang)}" xml:lang="${esc(lang)}">
<head><meta charset="utf-8"/><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body${cls ? ` class="${cls}"` : ''}>
${body}
</body>
</html>`;

export interface Fonts { text: Uint8Array; italic: Uint8Array; blackletter: Uint8Array }
export interface BookMeta { title: string; author: string; language: string; id: string; modified: Date; pageSize?: string }

/** An EPUB 3 e-book (with a table of contents that older readers understand too). */
export function buildEpub(meta: BookMeta, chapters: Chapter[], look: M.BookLook, fonts?: Fonts): Uint8Array {
  const lang = meta.language || 'en';
  const useText = !!fonts && (look.font || 'Libre Baskerville') === 'Libre Baskerville';
  const useDrop = !!fonts && look.dropcapFont !== 'Same as the text';
  const files: ZipEntry[] = [{ name: 'mimetype', data: 'application/epub+zip' }];
  files.push({ name: 'META-INF/container.xml', data: `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>` });
  const pages = chapters.map((c, i) => ({ id: `ch${String(i + 1).padStart(3, '0')}`, file: `ch${String(i + 1).padStart(3, '0')}.xhtml`, c }));
  files.push({ name: 'OEBPS/style.css', data: bookCss(look, { text: useText, dropcap: useDrop }) });
  files.push({ name: 'OEBPS/title.xhtml', data: xhtml(meta.title, lang, `<section epub:type="titlepage"><h1>${esc(meta.title)}</h1>${meta.author ? `<p class="author">${esc(meta.author)}</p>` : ''}</section>`, 'title-page') });
  for (const p of pages) files.push({ name: `OEBPS/${p.file}`, data: xhtml(p.c.title, lang, `<section epub:type="chapter">\n${p.c.blocks.map(b => blockXhtml(b, look)).join('\n')}\n</section>`) });
  files.push({ name: 'OEBPS/nav.xhtml', data: xhtml('Contents', lang, `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>\n${pages.map(p => `<li><a href="${p.file}">${esc(p.c.title)}</a></li>`).join('\n')}\n</ol></nav>`) });
  files.push({ name: 'OEBPS/toc.ncx', data: `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:uuid:${meta.id}"/></head><docTitle><text>${esc(meta.title)}</text></docTitle><navMap>
${pages.map((p, i) => `<navPoint id="n${i + 1}" playOrder="${i + 1}"><navLabel><text>${esc(p.c.title)}</text></navLabel><content src="${p.file}"/></navPoint>`).join('\n')}
</navMap></ncx>` });
  const fontItems: string[] = [];
  if (useText) { files.push({ name: 'OEBPS/fonts/LibreBaskerville.woff2', data: fonts!.text }, { name: 'OEBPS/fonts/LibreBaskerville-Italic.woff2', data: fonts!.italic }); fontItems.push('<item id="f1" href="fonts/LibreBaskerville.woff2" media-type="font/woff2"/>', '<item id="f2" href="fonts/LibreBaskerville-Italic.woff2" media-type="font/woff2"/>'); }
  if (useDrop) { files.push({ name: 'OEBPS/fonts/Blackletter.woff2', data: fonts!.blackletter }); fontItems.push('<item id="f3" href="fonts/Blackletter.woff2" media-type="font/woff2"/>'); }
  const modified = meta.modified.toISOString().replace(/\.\d+Z$/, 'Z');
  files.push({ name: 'OEBPS/content.opf', data: `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${esc(lang)}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">urn:uuid:${meta.id}</dc:identifier>
<dc:title>${esc(meta.title)}</dc:title>
${meta.author ? `<dc:creator>${esc(meta.author)}</dc:creator>\n` : ''}<dc:language>${esc(lang)}</dc:language>
<meta property="dcterms:modified">${modified}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="css" href="style.css" media-type="text/css"/>
<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>
${pages.map(p => `<item id="${p.id}" href="${p.file}" media-type="application/xhtml+xml"/>`).join('\n')}
${fontItems.join('\n')}
</manifest>
<spine toc="ncx">
<itemref idref="title"/>
${pages.map(p => `<itemref idref="${p.id}"/>`).join('\n')}
</spine>
</package>` });
  return zip(files, meta.modified);
}

/* ───────── PDF (book pages, printed by the browser engine) ───────── */

function base64(bytes: Uint8Array) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }
/**
 * The whole book as one page-laid-out HTML document: real page size and margins, the book look (fonts inside it),
 * each chapter on a new page, page numbers at the foot (none on the title page), inner and outer margins mirrored.
 * Printed to PDF by Obsidian's own browser engine.
 */
export function buildPrintHtml(meta: BookMeta, chapters: Chapter[], look: M.BookLook, fonts?: Fonts): string {
  const pg = M.pageOf(meta.pageSize), lang = meta.language || 'en', font = look.font || 'Libre Baskerville';
  const useText = !!fonts && font === 'Libre Baskerville', useDrop = !!fonts && look.dropcapFont !== 'Same as the text';
  const files: Record<string, Uint8Array | undefined> = { 'LibreBaskerville.woff2': fonts?.text, 'LibreBaskerville-Italic.woff2': fonts?.italic, 'Blackletter.woff2': fonts?.blackletter };
  const css = bookCss(look, { text: useText, dropcap: useDrop }, f => `data:font/woff2;base64,${base64(files[f] ?? new Uint8Array())}`) + `
@page { size: ${pg.w}in ${pg.h}in; margin: ${pg.top}in ${pg.outer}in ${pg.bottom}in ${pg.inner}in;
  @bottom-center { content: counter(page); font-family: "${font}", Georgia, serif; font-size: 8.5pt; color: #333; vertical-align: top; padding-top: 0.12in; } }
@page :left { margin-left: ${pg.outer}in; margin-right: ${pg.inner}in; }
@page :right { margin-left: ${pg.inner}in; margin-right: ${pg.outer}in; }
@page front { @bottom-center { content: none; } }
html, body { margin: 0; padding: 0; background: #fff; }
body { font-size: ${+(look.size * 0.75).toFixed(2)}pt; color: #000; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.title-page { page: front; height: ${+(pg.h - pg.top - pg.bottom - 0.1).toFixed(2)}in; display: flex; flex-direction: column; justify-content: center; break-after: page; }
.title-page h1 { margin: 0 0 0.6em; break-before: auto; page-break-before: auto; }
.chapter { break-before: page; }
.chapter > h1:first-child { break-before: auto; page-break-before: auto; margin-top: ${+(pg.h * 0.18).toFixed(2)}in; }
p { orphans: 2; widows: 2; }
h1 { break-after: avoid; }
`;
  const body = chapters.map(c => `<section class="chapter">\n${c.blocks.map(b => blockXhtml(b, look)).join('\n')}\n</section>`).join('\n');
  return `<!DOCTYPE html><html lang="${esc(lang)}"><head><meta charset="utf-8"><title>${esc(meta.title)}</title><style>${css}</style></head><body>
<section class="title-page"><h1>${esc(meta.title)}</h1>${meta.author ? `<p class="author">${esc(meta.author)}</p>` : ''}</section>
${body}
</body></html>`;
}

/* ───────── Word (.docx) ───────── */

const xesc = (s: string) => esc(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const wStyleId = (id: string) => 'SE' + id.replace(/[^a-z0-9]/gi, '');
function wRuns(runs: Run[]) {
  return runs.map(r => {
    const pr = `${r.b ? '<w:b/>' : ''}${r.i ? '<w:i/>' : ''}${r.s ? '<w:strike/>' : ''}${r.h ? '<w:highlight w:val="yellow"/>' : ''}`;
    return `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ''}<w:t xml:space="preserve">${xesc(r.t)}</w:t></w:r>`;
  }).join('');
}
const wPara = (style: string, body: string) => `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${body}</w:p>`;
/** A Word document with real styles (Normal, Heading 1 for chapter titles, the book's paragraph styles), so layout tools can import it. */
/** The drop cap as drawn in the book look, measured on this computer (font, how many lines it takes, its size). */
export interface DropCapFit { font: string; embedded: boolean; lines: number; ascent: number; descent: number; width: number /* fractions of the letter's font size */ }
export function buildDocx(meta: BookMeta, chapters: Chapter[], look: M.BookLook, ttf?: Fonts, fit?: DropCapFit): Uint8Array {
  const pt = look.size * 0.75, half = Math.round(pt * 2), font = xesc(look.font || 'Libre Baskerville');
  // Fonts travel inside the file (when given), so the book and its drop cap look the same on any computer.
  const embedText = !!ttf && (look.font || 'Libre Baskerville') === 'Libre Baskerville';
  const blackletter = look.dropcapFont !== 'Same as the text';
  const dropFont = fit ? xesc(fit.font) : !blackletter ? font : ttf ? 'UnifrakturMaguntia' : xesc(look.dropcapFont === 'Blackletter (built in)' ? 'UnifrakturMaguntia' : look.dropcapFont);
  const embedDrop = !!ttf && blackletter && (fit ? fit.embedded : true);
  const lineTw = Math.round(look.lineHeight * 240), afterTw = Math.round(look.paraSpace * pt * 20), indentTw = Math.round(look.indent * 1440);
  const lineSpaceTw = pt * look.lineHeight * 20;   // one line of the book's text, in twentieths of a point
  const pg = M.pageOf(meta.pageSize), tw = (inches: number) => Math.round(inches * 1440);
  /** The chapter's first letter as Word's own drop cap (a frame N lines tall), then the rest of the paragraph. */
  const capPt = look.dropcapSize * pt, linePt = pt * look.lineHeight;
  const ascent = fit?.ascent ?? 0.72, descent = fit?.descent ?? 0.22, width = fit?.width ?? 0.8;
  const lines = fit?.lines ?? Math.max(2, Math.min(6, Math.ceil(capPt * (ascent + descent) / linePt - 0.15)));
  const dropCap = (b: Extract<Block, { type: 'p' }>) => {
    const [head, ...rest] = b.lines, first = head[0], ch = [...first.t][0];
    const remaining: Run[] = [{ ...first, t: first.t.slice(ch.length) }, ...head.slice(1)].filter(r => r.t);
    // A box exactly `lines` lines tall that the text flows around, holding the letter at the book look's drop cap size
    // (a plain drop cap would be stretched to fill its lines, and the blackletter tail would then poke into the next one).
    const boxH = Math.round(lines * linePt * 20), boxW = Math.round(capPt * width * 20);
    const before = b.space ? `<w:spacing w:before="${Math.round(b.space * lineSpaceTw)}"/>` : '';
    const cap = `<w:p><w:pPr><w:pStyle w:val="BodyFirst"/><w:keepNext/><w:framePr w:w="${boxW}" w:h="${boxH}" w:hRule="exact" w:wrap="around" w:hSpace="${Math.round(pt * 0.4 * 20)}" w:vAnchor="text" w:hAnchor="text"/><w:spacing w:before="0" w:after="0" w:line="${Math.round(capPt * (ascent + descent) * 20)}" w:lineRule="exact"/><w:ind w:firstLine="0"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="${dropFont}" w:hAnsi="${dropFont}" w:cs="${dropFont}"/><w:i w:val="0"/><w:b w:val="0"/><w:sz w:val="${Math.round(capPt * 2)}"/><w:szCs w:val="${Math.round(capPt * 2)}"/></w:rPr><w:t>${xesc(ch)}</w:t></w:r></w:p>`;
    const restPara = `<w:p><w:pPr><w:pStyle w:val="BodyFirst"/>${before}</w:pPr>${[remaining, ...rest].map(wRuns).join('<w:r><w:br/></w:r>')}</w:p>`;
    return cap + restPara;
  };
  let body = '';
  body += wPara('Title', wRuns([{ t: meta.title }]));
  if (meta.author) body += wPara('Subtitle', wRuns([{ t: meta.author }]));
  for (const c of chapters) for (const b of c.blocks) {
    if (b.type === 'title') body += wPara('Heading1', wRuns(b.runs));
    else if (b.type === 'break') body += `<w:p><w:pPr><w:pStyle w:val="SceneBreak"/>${b.space ? `<w:spacing w:before="${Math.round(240 + b.space * lineSpaceTw)}"/>` : ''}</w:pPr>${wRuns([{ t: b.text }])}</w:p>`;
    else if (b.dropcap && !b.style && /^\p{L}/u.test(b.lines[0]?.[0]?.t ?? '')) body += dropCap(b);
    else {
      const ps = b.style ? look.styles.find(s => s.id === b.style) : undefined;
      const style = ps ? wStyleId(ps.id) : b.interlude ? 'Interlude' : b.quote ? 'Quote' : b.indent ? 'BodyText' : 'BodyFirst';
      // A styled paragraph is indented only where the book look indents it (an ordinary paragraph, left-aligned).
      const ind = ps && b.indent && ps.align === 'left' ? `<w:ind w:firstLine="${indentTw}"/>` : '';
      const before = b.space ? `<w:spacing w:before="${Math.round((b.space + (ps?.spaceBefore ?? 0)) * lineSpaceTw)}"/>` : '';
      body += `<w:p><w:pPr><w:pStyle w:val="${style}"/>${before}${ind}</w:pPr>${b.lines.map(wRuns).join('<w:r><w:br/></w:r>')}</w:p>`;
    }
  }
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="${tw(pg.w)}" w:h="${tw(pg.h)}"/><w:pgMar w:top="${tw(pg.top)}" w:right="${tw(pg.outer)}" w:bottom="${tw(pg.bottom)}" w:left="${tw(pg.inner)}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const st = (id: string, name: string, ppr: string, rpr = '', extra = '') => `<w:style w:type="paragraph"${id === 'Normal' ? ' w:default="1"' : ''} w:styleId="${id}"><w:name w:val="${name}"/>${id !== 'Normal' ? '<w:basedOn w:val="Normal"/><w:next w:val="BodyText"/>' : ''}${extra}<w:qFormat/>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}</w:style>`;
  const custom = look.styles.map(s => st(wStyleId(s.id), xesc(s.name), `${s.spaceBefore || s.spaceAfter ? `<w:spacing w:before="${Math.round(s.spaceBefore * lineSpaceTw)}" w:after="${Math.round(s.spaceAfter * lineSpaceTw + afterTw)}"/>` : ''}${s.align !== 'left' ? `<w:jc w:val="${s.align}"/>` : ''}<w:ind w:firstLine="0"/>`, `<w:color w:val="${s.paperColor.replace('#', '')}"/>${s.italic ? '<w:i/>' : ''}${s.size !== 1 ? `<w:sz w:val="${Math.round(half * s.size)}"/>` : ''}`)).join('');
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}" w:eastAsia="${font}"/><w:sz w:val="${half}"/><w:szCs w:val="${half}"/><w:lang w:val="${xesc(meta.language || 'en')}"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="${afterTw}" w:line="${lineTw}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
${st('Normal', 'Normal', '')}
${st('BodyText', 'Body Text', `<w:ind w:firstLine="${indentTw}"/>`)}
${st('BodyFirst', 'Body Text First', '<w:ind w:firstLine="0"/>')}
${st('Interlude', 'Interlude', '<w:spacing w:before="80" w:after="80"/><w:ind w:firstLine="0"/>', `<w:sz w:val="${Math.round(half * 0.92)}"/>`)}
${st('Quote', 'Quote', '<w:ind w:left="720" w:right="720" w:firstLine="0"/><w:spacing w:before="120" w:after="120"/>')}
${st('SceneBreak', 'Scene Break', '<w:jc w:val="center"/><w:spacing w:before="240" w:after="240"/><w:ind w:firstLine="0"/>')}
${st('Heading1', 'heading 1', '<w:keepNext/><w:pageBreakBefore/><w:jc w:val="center"/><w:spacing w:before="1440" w:after="600"/><w:ind w:firstLine="0"/><w:outlineLvl w:val="0"/>', `<w:b/><w:sz w:val="${Math.round(half * look.titleSize)}"/>`)}
${st('Title', 'Title', '<w:jc w:val="center"/><w:spacing w:before="3600" w:after="480"/><w:ind w:firstLine="0"/>', `<w:b/><w:sz w:val="${half * 2}"/>`)}
${st('Subtitle', 'Subtitle', '<w:jc w:val="center"/><w:ind w:firstLine="0"/>', `<w:sz w:val="${Math.round(half * 1.2)}"/>`)}
${custom}
</w:styles>`;
  const created = meta.modified.toISOString().replace(/\.\d+Z$/, 'Z');
  // Embedded fonts: Word's format scrambles the first 32 bytes of each font with a key (its GUID), per the Office Open XML rules.
  const fonts: { name: string; kind: 'Regular' | 'Italic'; data: Uint8Array }[] = [];
  if (ttf && embedText) fonts.push({ name: 'Libre Baskerville', kind: 'Regular', data: ttf.text }, { name: 'Libre Baskerville', kind: 'Italic', data: ttf.italic });
  if (ttf && embedDrop) fonts.push({ name: 'UnifrakturMaguntia', kind: 'Regular', data: ttf.blackletter });
  const fontParts: ZipEntry[] = [];
  if (fonts.length) {
    const keyOf = (i: number) => { const hex = (i + 1).toString(16).padStart(2, '0'); return `{${'5E1F0A7C'}-${'2D3B'}-${'4C5D'}-${'8E9F'}-${'A0B1C2D3E4' + hex}}`; };
    const byName = new Map<string, string[]>();
    fonts.forEach((f, i) => {
      const key = keyOf(i), bytes = key.replace(/[{}-]/g, '').match(/../g)!.reverse().map(h => parseInt(h, 16));
      const data = new Uint8Array(f.data); for (let k = 0; k < 32 && k < data.length; k++) data[k] ^= bytes[k % 16];
      fontParts.push({ name: `word/fonts/font${i + 1}.odttf`, data });
      (byName.get(f.name) ?? byName.set(f.name, []).get(f.name)!).push(`<w:embed${f.kind} r:id="rIdF${i + 1}" w:fontKey="${key}"/>`);
    });
    fontParts.push({ name: 'word/fontTable.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:fonts ${W}>${[...byName].map(([n, e]) => `<w:font w:name="${xesc(n)}"><w:charset w:val="00"/><w:family w:val="${n === 'UnifrakturMaguntia' ? 'decorative' : 'roman'}"/><w:pitch w:val="variable"/>${e.join('')}</w:font>`).join('')}</w:fonts>` });
    fontParts.push({ name: 'word/_rels/fontTable.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${fonts.map((_, i) => `<Relationship Id="rIdF${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/font${i + 1}.odttf"/>`).join('')}</Relationships>` });
    fontParts.push({ name: 'word/settings.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings ${W}><w:embedTrueTypeFonts/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>` });
  }
  return zip([
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${fonts.length ? '<Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/><Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' : ''}</Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>` },
    { name: 'word/_rels/document.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${fonts.length ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>' : ''}</Relationships>` },
    ...fontParts,
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: styles },
    { name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xesc(meta.title)}</dc:title><dc:creator>${xesc(meta.author)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created></cp:coreProperties>` },
  ], meta.modified);
}

/* ───────── the web (paste into Royal Road, Wattpad, AO3…) ───────── */

/** One chapter as simple HTML with the styling written on each paragraph (sites keep what they support), plus plain text. */
export function webChapter(ch: Chapter, look: M.BookLook): { html: string; text: string } {
  const html: string[] = [], text: string[] = [];
  // Sites drop CSS margins, so space is written as empty paragraphs (rounded to whole lines).
  const blankLines = (n: number) => { for (let k = 0; k < Math.round(n); k++) { html.push('<p>&nbsp;</p>'); text.push(''); } };
  for (const b of ch.blocks) {
    if (b.type === 'title') { html.push(`<h1>${runsHtml(b.runs)}</h1>`); text.push(plain(b.runs)); continue; }
    const st0 = b.type === 'p' && b.style ? look.styles.find(s => s.id === b.style) : undefined;
    blankLines((b.space ?? 0) + (st0?.spaceBefore ?? 0));
    if (b.type === 'break') { html.push(`<p style="text-align:center">${esc(b.text)}</p>`); text.push(b.text); continue; }
    const st = b.style ? look.styles.find(s => s.id === b.style) : undefined;
    const css = st ? `color:${st.paperColor};${st.italic ? 'font-style:italic;' : ''}${st.align !== 'left' ? `text-align:${st.align};` : ''}` : '';
    const inner = b.lines.map(runsHtml).join('<br>');
    html.push(css ? `<p style="${css}">${st!.italic ? `<em>${inner}</em>` : inner}</p>` : `<p>${inner}</p>`);
    text.push(b.lines.map(plain).join('\n'));
    blankLines(st?.spaceAfter ?? 0);
  }
  return { html: html.join('\n'), text: text.join('\n\n') };
}
