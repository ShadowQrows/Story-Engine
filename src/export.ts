/**
 * Exports from the Aa strip (or the command palette): the whole story as an EPUB e-book or a Word file,
 * saved in the story's Exports folder; and one chapter copied for pasting into a webnovel site.
 */
import { App, Modal, Notice, TFile, normalizePath } from 'obsidian';
import * as M from './model';
import type { Project } from './project';
import { tip } from './tip';
import { buildDocx, buildEpub, buildPrintHtml, chapterBlocks, Chapter, DOCX_IMAGE, DropCapFit, imageSize, Media, webChapter } from './book';
import baskerville from '../fonts/LibreBaskerville.woff2';
import baskervilleItalic from '../fonts/LibreBaskerville-Italic.woff2';
import blackletter from '../fonts/UnifrakturMaguntia.woff2';
import baskervilleTtf from '../fonts/LibreBaskerville.ttf';
import baskervilleItalicTtf from '../fonts/LibreBaskerville-Italic.ttf';
import blackletterTtf from '../fonts/UnifrakturMaguntia.ttf';

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp' };
/** What didn't make it into the book, counted for the message after an export. */
export interface Missed { images: number; missing: number; unsupported: number; tables: number; code: number }

/** Every chapter, parsed for the book; with `images`, the pictures they show are read from the vault. */
export async function storyChapters(app: App, p: Project, images = false): Promise<{ chapters: Chapter[]; media: Map<string, Media>; missed: Missed }> {
  const chapters: Chapter[] = [], media = new Map<string, Media>();
  const missed: Missed = { images: 0, missing: 0, unsupported: 0, tables: 0, code: 0 };
  for (const f of p.chapters()) {
    const ch = chapterBlocks(await app.vault.cachedRead(f), p.chapterTitle(f), { images });
    if (ch.left) { missed.images += ch.left.images; missed.tables += ch.left.tables; missed.code += ch.left.code; }
    const kept: typeof ch.blocks = [];
    for (const b of ch.blocks) {
      if (b.type !== 'image') { kept.push(b); continue; }
      let ref = b.ref; try { ref = decodeURIComponent(ref); } catch { /* keep as written */ }
      const file = app.metadataCache.getFirstLinkpathDest(ref.split('#')[0], f.path);
      if (!file) { missed.missing++; continue; }
      if (!media.has(file.path)) {
        const data = new Uint8Array(await app.vault.readBinary(file)), ext = file.extension.toLowerCase();
        const size = imageSize(data) ?? { w: 800, h: 600 };
        media.set(file.path, { data, mime: MIME[ext] ?? 'image/png', ext, w: size.w, h: size.h });
      }
      kept.push({ ...b, ref: file.path });
    }
    chapters.push({ ...ch, blocks: kept });
  }
  return { chapters, media, missed };
}
/** "3 pictures, 1 table" — the parts left out, in plain words, or '' when nothing was. */
function missedText(m: Missed, imagesOn: boolean) {
  const n = (k: number, one: string, many: string) => k ? `${k} ${k === 1 ? one : many}` : '';
  const parts = [
    imagesOn ? '' : n(m.images, 'picture (Include images is off)', 'pictures (Include images is off)'),
    n(m.missing, 'picture not found in the vault', 'pictures not found in the vault'),
    n(m.unsupported, 'picture of a kind Word can’t show (use PNG, JPG or GIF)', 'pictures of a kind Word can’t show (use PNG, JPG or GIF)'),
    n(m.tables, 'table', 'tables'), n(m.code, 'code block', 'code blocks'),
  ].filter(Boolean);
  return parts.join(', ');
}
const uuid = () => (crypto as Crypto & { randomUUID?: () => string }).randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
const safeName = (s: string) => s.replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Book';

/** Is this font installed? (Draw the same text in it and in two fallbacks; a real font changes the width.) */
function installed(name: string) {
  const c = document.createElement('canvas').getContext('2d'); if (!c) return false;
  const t = 'abcdefghijklmnopqrstuvwxyzHAWQ', w = (f: string) => { c.font = `40px ${f}`; return c.measureText(t).width; };
  return ['monospace', 'serif'].some(base => w(`"${name}", ${base}`) !== w(base));
}
/** The drop cap the book look draws, measured: its font (Old English Text MT if it's on this computer, else the bundled blackletter), and how tall and wide its letter is. */
function fitDropCap(look: M.BookLook, letter: string): DropCapFit | undefined {
  if (look.dropcapFont === 'Same as the text') return undefined;
  const wanted = look.dropcapFont === 'Blackletter (built in)' ? '' : look.dropcapFont || 'Old English Text MT';
  const own = !!wanted && installed(wanted);
  const c = document.createElement('canvas').getContext('2d'); if (!c) return undefined;
  const px = 200; c.font = `${px}px ${own ? `"${wanted}"` : '"MM Blackletter"'}`;
  const m = c.measureText(letter || 'H');
  const ascent = m.actualBoundingBoxAscent / px, descent = Math.max(0, m.actualBoundingBoxDescent) / px, width = (m.actualBoundingBoxRight + Math.max(0, m.actualBoundingBoxLeft)) / px;
  if (!(ascent > 0.2)) return undefined;
  const lines = Math.max(2, Math.min(6, Math.ceil(look.dropcapSize * (ascent + descent) / look.lineHeight - 0.15)));
  return { font: own ? wanted : 'UnifrakturMaguntia', embedded: !own, lines, ascent, descent, width: width + 0.04 };
}
/** Write the file into "<story>/Exports/", replacing an older export of the same name. */
async function save(app: App, p: Project, name: string, data: Uint8Array): Promise<string> {
  const dir = normalizePath(`${p.folder ? p.folder + '/' : ''}Exports`);
  if (!app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
  const path = normalizePath(`${dir}/${name}`);
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const old = app.vault.getAbstractFileByPath(path);
  if (old instanceof TFile) await app.vault.modifyBinary(old, buf); else await app.vault.createBinary(path, buf);
  return path;
}

/** Title, author and language (remembered for next time), then Export. */
export class BookExportModal extends Modal {
  constructor(app: App, private p: Project, private format: 'epub' | 'docx' | 'pdf') { super(app); }
  onOpen() {
    const p = this.p, book = p.data.book ?? {};
    this.modalEl.addClass('se-export-modal');
    this.titleEl.setText(this.format === 'epub' ? 'Export e-book (EPUB)' : this.format === 'pdf' ? 'Export PDF' : 'Export Word document');
    const c = this.contentEl; c.empty();
    const field = (label: string, value: string, ph = '') => { const r = c.createDiv('se-style-row'); r.createSpan({ text: label }); const i = r.createEl('input'); i.type = 'text'; i.value = value; i.placeholder = ph; return i; };
    const title = field('Title', book.title || p.name);
    const author = field('Author', book.author || '', 'Your name');
    const lang = field('Language', book.language || 'en', 'en');
    // Page size: the printed book's (an e-book has none: e-readers make their own pages).
    let size: HTMLSelectElement | null = null;
    if (this.format !== 'epub') {
      const r = c.createDiv('se-style-row'); r.createSpan({ text: 'Page Size' });
      size = r.createEl('select', { cls: 'dropdown' });
      for (const [id, s] of Object.entries(M.PAGE_SIZES)) size.createEl('option', { text: s.label, value: id });
      size.value = M.PAGE_SIZES[book.pageSize ?? ''] ? book.pageSize! : '6x9';
    }
    // PDF or Word for a printed book: a wider margin on the binding side, which alternates between left and right pages.
    let mirror: HTMLInputElement | null = null;
    if (this.format !== 'epub') {
      const r = c.createEl('label', { cls: 'se-style-row se-check' });
      mirror = r.createEl('input'); mirror.type = 'checkbox'; mirror.checked = !!book.mirror;
      r.appendText(' Mirrored Margins');
      tip(r, 'Leave off for reading on screen: every page lines up. On for printing: room for the binding, on alternating sides.');
    }
    const ir = c.createEl('label', { cls: 'se-style-row se-check' });
    const images = ir.createEl('input'); images.type = 'checkbox'; images.checked = book.images !== false;
    ir.appendText(' Include Images');
    const acts = c.createDiv('se-style-acts');
    const go = acts.createEl('button', { cls: 'mod-cta', text: 'Export' });
    tip(go, `${p.chapters().length} chapters, saved in ${p.folder ? p.folder + '/' : ''}Exports`);
    go.onclick = async () => {
      const info: M.BookInfo = { title: title.value.trim() || p.name, author: author.value.trim(), language: lang.value.trim() || 'en', pageSize: size?.value ?? book.pageSize, ...(mirror ? (mirror.checked ? { mirror: true } : {}) : book.mirror ? { mirror: true } : {}), ...(images.checked ? {} : { images: false }) };
      p.data.book = info; p.saveQuiet();
      go.disabled = true; go.setText('Exporting…');
      try {
        const done = await exportBook(this.app, p, this.format, info);
        if (done) new Notice(done.left ? `Saved ${done.path}
Left out: ${done.left}.` : `Saved ${done.path}`, done.left ? 10000 : 5000);
        this.close();
      } catch (e) { new Notice(exportError(e, `${safeName(info.title)}.${this.format}`), 10000); go.disabled = false; go.setText('Export'); }
    };
  }
  onClose() { this.contentEl.empty(); }
}
/** An export error in plain words: the usual one is the old copy still open in Word, LibreOffice or a PDF reader. */
function exportError(e: unknown, file: string) {
  const msg = (e as Error)?.message ?? String(e);
  if (/EBUSY|EPERM|EACCES|locked|being used/i.test(msg)) return `Couldn't replace “${file}”: it's open in another program. Close it there and export again.`;
  if (/ENOSPC/i.test(msg)) return `Couldn't save “${file}”: the disk is full.`;
  return `Export failed: ${msg}`;
}
const firstLetter = (chapters: Chapter[]) => { for (const c of chapters) for (const b of c.blocks) if (b.type === 'p' && b.dropcap) return [...(b.lines[0]?.[0]?.t ?? '')][0] ?? ''; return ''; };
export async function exportBook(app: App, p: Project, format: 'epub' | 'docx' | 'pdf', info: M.BookInfo): Promise<{ path: string; left: string } | null> {
  const imagesOn = info.images !== false;
  const { chapters, media, missed } = await storyChapters(app, p, imagesOn);
  if (format === 'docx') for (const c of chapters) for (const b of c.blocks) if (b.type === 'image' && !DOCX_IMAGE.test(media.get(b.ref)?.mime ?? '')) missed.unsupported++;
  const left = missedText(missed, imagesOn);
  const meta = { ...info, id: uuid(), modified: new Date() };
  if (format === 'pdf') {
    const html = buildPrintHtml(meta, chapters, p.data.look, { text: baskerville, italic: baskervilleItalic, blackletter }, media);
    const pdf = await printToPdf(html);
    if (!pdf) return null;   // no print engine here (e.g. on a phone): the print dialog was shown instead
    return { path: await save(app, p, `${safeName(info.title)}.pdf`, pdf), left };
  }
  const data = format === 'epub' ? buildEpub(meta, chapters, p.data.look, { text: baskerville, italic: baskervilleItalic, blackletter }, media) : buildDocx(meta, chapters, p.data.look, { text: baskervilleTtf, italic: baskervilleItalicTtf, blackletter: blackletterTtf }, fitDropCap(p.data.look, firstLetter(chapters)), media);
  return { path: await save(app, p, `${safeName(info.title)}.${format}`, data), left };
}

/**
 * Print the book's pages to PDF with Obsidian's own browser engine (desktop): a hidden window loads the laid-out book
 * and prints it at its real page size. Where that isn't available, the system print dialog opens instead (choose "Save as PDF").
 */
async function printToPdf(html: string): Promise<Uint8Array | null> {
  const req = (window as unknown as { require?: (m: string) => any }).require;
  let remote: any = null;
  try { remote = req?.('electron')?.remote ?? null; } catch { /* not on desktop */ }
  if (!remote) try { remote = req?.('@electron/remote') ?? null; } catch { /* not available */ }
  if (remote?.BrowserWindow && req) {
    const fs = req('fs'), os = req('os'), path = req('path');
    const file = path.join(os.tmpdir(), `story-engine-book-${Date.now()}.html`);
    fs.writeFileSync(file, html, 'utf8');
    const win = new remote.BrowserWindow({ show: false, width: 900, height: 1200 });
    try {
      await win.loadFile(file);
      await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
      const data = await win.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true });
      return new Uint8Array(data);
    } finally { win.destroy(); try { fs.unlinkSync(file); } catch { /* already gone */ } }
  }
  // Fallback: the print dialog, on the laid-out book.
  const frame = document.body.createEl('iframe', { attr: { style: 'position:fixed;width:0;height:0;border:0;right:0;bottom:0' } });
  frame.srcdoc = html;
  await new Promise<void>(res => { frame.onload = () => res(); });
  await (frame.contentDocument?.fonts?.ready ?? Promise.resolve());
  new Notice('Choose “Save as PDF” in the print dialog.');
  frame.contentWindow?.print();
  window.setTimeout(() => frame.remove(), 60000);
  return null;
}
/** The chapter as formatted text on the clipboard: paste it into the site's editor. */
export async function copyChapterForWeb(p: Project, text: string, fallbackTitle = '') {
  const { html, text: plainText } = webChapter(chapterBlocks(text, fallbackTitle || 'Chapter'), p.data.look);
  try {
    const W = window as unknown as { ClipboardItem?: new (d: Record<string, Blob>) => unknown };
    if (W.ClipboardItem && navigator.clipboard?.write) await navigator.clipboard.write([new W.ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([plainText], { type: 'text/plain' }) }) as ClipboardItem]);
    else await navigator.clipboard.writeText(plainText);
    new Notice('Chapter copied. Paste it into the site\'s editor.');
  } catch (e) { new Notice(`Couldn't copy: ${(e as Error).message}`); }
  return { html, text: plainText };
}
