/**
 * Exports from the Aa strip (or the command palette): the whole story as an EPUB e-book or a Word file,
 * saved in the story's Exports folder; and one chapter copied for pasting into a webnovel site.
 */
import { App, Modal, Notice, TFile, normalizePath } from 'obsidian';
import * as M from './model';
import type { Project } from './project';
import { buildDocx, buildEpub, buildPrintHtml, chapterBlocks, Chapter, DropCapFit, webChapter } from './book';
import baskerville from '../fonts/LibreBaskerville.woff2';
import baskervilleItalic from '../fonts/LibreBaskerville-Italic.woff2';
import blackletter from '../fonts/UnifrakturMaguntia.woff2';
import baskervilleTtf from '../fonts/LibreBaskerville.ttf';
import baskervilleItalicTtf from '../fonts/LibreBaskerville-Italic.ttf';
import blackletterTtf from '../fonts/UnifrakturMaguntia.ttf';

export async function storyChapters(app: App, p: Project): Promise<Chapter[]> {
  const out: Chapter[] = [];
  for (const f of p.chapters()) out.push(chapterBlocks(await app.vault.cachedRead(f), p.chapterTitle(f)));
  return out;
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
    const field = (label: string, value: string, ph = '') => { const r = c.createDiv('se-style-row'); r.createSpan({ text: label }); const i = r.createEl('input'); i.value = value; i.placeholder = ph; return i; };
    const title = field('Title', book.title || p.name);
    const author = field('Author', book.author || '', 'Your name');
    const lang = field('Language', book.language || 'en', 'en');
    // Page size: the printed book's (an e-book has none: e-readers make their own pages).
    let size: HTMLSelectElement | null = null;
    if (this.format !== 'epub') {
      const r = c.createDiv('se-style-row'); r.createSpan({ text: 'Page size' });
      size = r.createEl('select', { cls: 'dropdown' });
      for (const [id, s] of Object.entries(M.PAGE_SIZES)) size.createEl('option', { text: s.label, value: id });
      size.value = M.PAGE_SIZES[book.pageSize ?? ''] ? book.pageSize! : '6x9';
    }
    c.createDiv({ cls: 'se-export-where', text: `${p.chapters().length} chapters · saved in ${p.folder ? p.folder + '/' : ''}Exports` });
    const acts = c.createDiv('se-style-acts');
    const go = acts.createEl('button', { cls: 'mod-cta', text: 'Export' });
    go.onclick = async () => {
      const info: M.BookInfo = { title: title.value.trim() || p.name, author: author.value.trim(), language: lang.value.trim() || 'en', pageSize: size?.value ?? book.pageSize };
      p.data.book = info; p.saveQuiet();
      go.disabled = true; go.setText('Exporting…');
      try {
        const path = await exportBook(this.app, p, this.format, info);
        if (path) new Notice(`Saved ${path}`);
        this.close();
      } catch (e) { new Notice(`Export failed: ${(e as Error).message}`); go.disabled = false; go.setText('Export'); }
    };
  }
  onClose() { this.contentEl.empty(); }
}
const firstLetter = (chapters: Chapter[]) => { for (const c of chapters) for (const b of c.blocks) if (b.type === 'p' && b.dropcap) return [...(b.lines[0]?.[0]?.t ?? '')][0] ?? ''; return ''; };
export async function exportBook(app: App, p: Project, format: 'epub' | 'docx' | 'pdf', info: M.BookInfo): Promise<string | null> {
  const chapters = await storyChapters(app, p);
  const meta = { ...info, id: uuid(), modified: new Date() };
  if (format === 'pdf') {
    const html = buildPrintHtml(meta, chapters, p.data.look, { text: baskerville, italic: baskervilleItalic, blackletter });
    const pdf = await printToPdf(html);
    if (!pdf) return null;   // no print engine here (e.g. on a phone): the print dialog was shown instead
    return save(app, p, `${safeName(info.title)}.pdf`, pdf);
  }
  const data = format === 'epub' ? buildEpub(meta, chapters, p.data.look, { text: baskerville, italic: baskervilleItalic, blackletter }) : buildDocx(meta, chapters, p.data.look, { text: baskervilleTtf, italic: baskervilleItalicTtf, blackletter: blackletterTtf }, fitDropCap(p.data.look, firstLetter(chapters)));
  return save(app, p, `${safeName(info.title)}.${format}`, data);
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
