/* A small stand-in for the Obsidian API, enough to run Story Engine 2 in a browser with the real CodeMirror editor.
   It is not Obsidian: it exists to exercise the plugin's own code end to end. */
import { StateField, EditorState, Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';

// ── DOM helpers Obsidian adds to elements ──
type Opts = string | { cls?: string; text?: string; value?: string; attr?: Record<string, string> };
function apply(n: HTMLElement, o?: Opts) { if (!o) return n; if (typeof o === 'string') { n.className = o; return n; } if (o.cls) n.className = o.cls; if (o.text != null) n.textContent = o.text; if (o.value != null) (n as HTMLInputElement).value = o.value; if (o.attr) for (const [k, v] of Object.entries(o.attr)) n.setAttribute(k, v); return n; }
const P = HTMLElement.prototype as any;
P.createEl = function (tag: string, o?: Opts) { const n = apply(document.createElement(tag), o); this.append(n); return n; };
P.createDiv = function (o?: Opts) { return this.createEl('div', o); };
P.createSpan = function (o?: Opts) { return this.createEl('span', o); };
P.empty = function () { this.replaceChildren(); };
P.addClass = function (...c: string[]) { this.classList.add(...c.flatMap(x => x.split(' ').filter(Boolean))); };
P.removeClass = function (...c: string[]) { this.classList.remove(...c); };
P.toggleClass = function (c: string, v?: boolean) { this.classList.toggle(c, v); };
P.hasClass = function (c: string) { return this.classList.contains(c); };
P.toggle = function (v: boolean) { this.style.display = v ? '' : 'none'; };
P.setText = function (t: string) { this.textContent = t; };
P.appendText = function (t: string) { this.append(document.createTextNode(t)); };
P.hide = function () { this.style.display = 'none'; };
P.show = function () { this.style.display = ''; };

export const notices: string[] = ((window as any).__notices = []);
export class Notice {
  constructor(m: string | DocumentFragment) {
    const box = document.getElementById('notices') ?? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'notices' }));
    box.style.cssText = 'position:fixed;left:0;bottom:0;z-index:999;max-height:40vh;overflow:hidden;pointer-events:none';
    const n = box.appendChild(document.createElement('div')); n.className = 'notice';
    if (typeof m === 'string') n.textContent = m; else n.append(m);
    notices.push(n.textContent ?? '');
  }
}
import * as Lucide from 'lucide-static';
/** Like Obsidian: draws the Lucide icon of that name, or nothing if there's no such icon. */
export function setIcon(el: HTMLElement, name: string) {
  el.dataset.icon = name;
  const svg = (Lucide as Record<string, string>)[name.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase())];
  el.querySelector('svg')?.remove();
  if (svg) el.insertAdjacentHTML('afterbegin', svg);
}
export function normalizePath(p: string) { return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, ''); }

// ── tiny YAML (enough for frontmatter written by Story Engine and by hand) ──
export function stringifyYaml(o: Record<string, unknown>) {
  let s = '';
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) { s += `${k}:\n`; for (const x of v) s += `  - ${JSON.stringify(x)}\n`; }
    else s += `${k}: ${typeof v === 'string' && /^[\w -]+$/.test(v) ? v : JSON.stringify(v)}\n`;
  }
  return s;
}
export function parseYaml(s: string): Record<string, any> {
  const o: Record<string, any> = {}; let key = '';
  for (const line of s.split('\n')) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && key) { (o[key] = Array.isArray(o[key]) ? o[key] : []).push(val(item[1])); continue; }
    const m = /^([\w-]+):\s*(.*)$/.exec(line);
    if (m) { key = m[1]; o[key] = m[2] === '' ? [] : val(m[2]); }
  }
  return o;
}
function val(v: string): any { try { return JSON.parse(v); } catch { if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(',').map(x => x.trim()).filter(Boolean); return v; } }
function splitFm(text: string) { const m = /^---\n([\s\S]*?)\n?---\n?/.exec(text); return m ? { fm: parseYaml(m[1]), body: text.slice(m[0].length) } : { fm: null as any, body: text }; }

// ── events, files, vault ──
export class Events {
  private h: Record<string, Function[]> = {};
  on(n: string, cb: Function) { (this.h[n] ??= []).push(cb); return { n, cb, src: this }; }
  off(n: string, cb: Function) { this.h[n] = (this.h[n] ?? []).filter(x => x !== cb); }
  offref(r: any) { r?.src?.off(r.n, r.cb); }
  trigger(n: string, ...a: unknown[]) { for (const cb of this.h[n] ?? []) cb(...a); }
}
export class TAbstractFile { name: string; parent: TFolder | null = null; constructor(public path: string) { this.name = path.split('/').pop()!; } }
export class TFile extends TAbstractFile { basename: string; extension: string; constructor(path: string) { super(path); const i = this.name.lastIndexOf('.'); this.basename = this.name.slice(0, i); this.extension = this.name.slice(i + 1); } }
export class TFolder extends TAbstractFile { children: TAbstractFile[] = []; }

class Vault extends Events {
  files = new Map<string, { file: TFile; data: string }>();
  folders = new Map<string, TFolder>([['/', new TFolder('/')]]);
  private parentOf(path: string) { const d = path.split('/').slice(0, -1).join('/'); return d ? this.folders.get(d) ?? null : this.folders.get('/')!; }
  getAbstractFileByPath(p: string) { return this.files.get(p)?.file ?? this.folders.get(p) ?? null; }
  getFiles() { return [...this.files.values()].map(x => x.file); }
  getMarkdownFiles() { return this.getFiles().filter(f => f.extension === 'md'); }
  getAllLoadedFiles() { return [...this.folders.values(), ...this.getFiles()]; }
  async createFolder(p: string) { if (this.folders.has(p)) throw new Error('exists'); this.folders.set(p, new TFolder(p)); }
  async create(p: string, data: string) { if (this.files.has(p)) throw new Error('exists ' + p); for (let i = 1; i < p.split('/').length; i++) { const d = p.split('/').slice(0, i).join('/'); if (!this.folders.has(d)) this.folders.set(d, new TFolder(d)); } const f = new TFile(p); f.parent = this.parentOf(p); this.files.set(p, { file: f, data }); app.metadataCache.update(f); this.trigger('create', f); return f; }
  async read(f: TFile) { return this.files.get(f.path)!.data; }
  async cachedRead(f: TFile) { return this.read(f); }
  binaries = ((window as any).__binaries = new Map<string, Uint8Array>());
  async createBinary(p: string, data: ArrayBuffer) { const f = new TFile(p); f.parent = this.parentOf(p); this.files.set(p, { file: f, data: '' }); this.binaries.set(p, new Uint8Array(data)); this.trigger('create', f); return f; }
  async modifyBinary(f: TFile, data: ArrayBuffer) { this.binaries.set(f.path, new Uint8Array(data)); this.trigger('modify', f); }
  async modify(f: TFile, data: string) { this.write(f, data); }
  async process(f: TFile, fn: (d: string) => string) { const d = fn(this.files.get(f.path)!.data); this.write(f, d); return d; }
  write(f: TFile, data: string) { this.files.get(f.path)!.data = data; app.metadataCache.update(f); app.workspace.syncOpen(f, data); this.trigger('modify', f); }
  getResourcePath(f: TFile) { const d = this.files.get(f.path)?.data ?? ''; if (d.trimStart().startsWith('<svg')) return 'data:image/svg+xml;utf8,' + encodeURIComponent(d); return 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="1600" height="1000" fill="#2a3326"/><path d="M0 300 C 400 380 600 120 1000 260 S 1400 400 1600 300" stroke="#6a8ab0" stroke-width="18" fill="none"/></svg>'); }
}
class MetadataCache extends Events {
  cache = new Map<string, any>();
  update(f: TFile) { if (f.extension !== 'md') return; const { fm } = splitFm(app.vault.files.get(f.path)!.data); this.cache.set(f.path, { frontmatter: fm ?? undefined }); setTimeout(() => this.trigger('changed', f), 5); }
  getFileCache(f: TFile) { return this.cache.get(f.path) ?? null; }
  getFirstLinkpathDest(link: string) { const base = link.split('/').pop(); return app.vault.getMarkdownFiles().find(f => f.basename === base) ?? null; }
}
class FileManager {
  async processFrontMatter(f: TFile, fn: (fm: any) => void) { const e = app.vault.files.get(f.path)!; const { fm, body } = splitFm(e.data); const o = fm ?? {}; fn(o); app.vault.write(f, `---\n${stringifyYaml(o)}---\n${body}`); }
  async trashFile(f: TFile) { app.vault.files.delete(f.path); app.vault.trigger('delete', f); }
  async renameFile(f: TFile, to: string) {
    const v = app.vault, e = v.files.get(f.path)!, old = f.path, oldBase = f.basename;
    if (v.files.has(to)) throw new Error('exists ' + to);
    v.files.delete(old); f.path = to; f.name = to.split('/').pop()!; f.basename = f.name.replace(/\.[^.]+$/, ''); v.files.set(to, e);
    app.metadataCache.cache.set(to, app.metadataCache.cache.get(old)); app.metadataCache.cache.delete(old);
    const oldFull = old.replace(/\.md$/, ''), newFull = to.replace(/\.md$/, '');
    for (const x of v.files.values()) if (x.data.includes(`[[${oldFull}]]`)) { x.data = x.data.split(`[[${oldFull}]]`).join(`[[${newFull}]]`); app.metadataCache.update(x.file); }
    for (const x of v.files.values()) if (x.data.includes(`[[${oldBase}]]`) || x.data.includes(`[[${oldBase}|`)) { x.data = x.data.split(`[[${oldBase}]]`).join(`[[${f.basename}]]`).split(`[[${oldBase}|`).join(`[[${f.basename}|`); app.metadataCache.update(x.file); }
    v.trigger('rename', f, old);
  }
}

// ── editor ──
export const editorInfoField = StateField.define<{ file: TFile | null }>({ create: () => ({ file: null }), update: v => v });
export const registeredExtensions: Extension[] = [];

export class Component {
  _cleanup: (() => void)[] = [];
  registerEvent(r: any) { this._cleanup.push(() => r?.src?.offref(r)); }
  registerDomEvent(el: EventTarget, n: string, cb: any, o?: any) { el.addEventListener(n, cb, o); this._cleanup.push(() => el.removeEventListener(n, cb, o)); }
  register(fn: () => void) { this._cleanup.push(fn); }
  load() { (this as any).onload?.(); }
  unload() { this._cleanup.forEach(f => f()); }
}
export class View extends Component {
  app = app; containerEl = document.createElement('div'); contentEl = document.createElement('div'); actionsEl = document.createElement('div');
  constructor(public leaf: WorkspaceLeaf) { super(); this.containerEl.className = 'view-content-wrap'; this.contentEl.className = 'view-content'; this.actionsEl.className = 'view-actions'; this.containerEl.append(this.actionsEl, this.contentEl); }
  addAction(icon: string, title: string, cb: () => void) { const b = document.createElement('button'); b.className = 'clickable-icon view-action'; b.dataset.icon = icon; b.setAttribute('aria-label', title); b.textContent = icon; b.onclick = cb; this.actionsEl.prepend(b); return b; }
  async onOpen() {} async onClose() {} onResize() {}
  getViewType() { return ''; }
}
export class ItemView extends View {}
export class MarkdownView extends View {
  file: TFile | null = null; cm!: EditorView; editor!: any;
  getViewType() { return 'markdown'; }
  async openFile(f: TFile) {
    this.file = f;
    const text = app.vault.files.get(f.path)!.data;
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    const cls = [].concat(fm?.cssclasses ?? []).map(String);
    this.contentEl.className = 'view-content';
    this.contentEl.empty();
    const src = this.contentEl.createDiv('markdown-source-view mod-cm6 is-live-preview ' + cls.join(' '));
    const sizer = src.createDiv('cm-sizer');
    const self = this;
    this.cm = new EditorView({
      parent: sizer,
      state: EditorState.create({ doc: text, extensions: [editorInfoField.init(() => ({ file: f })), history(), keymap.of([...defaultKeymap, ...historyKeymap]), EditorView.lineWrapping, ...registeredExtensions,
        EditorView.updateListener.of(u => { if (u.docChanged) { const d = u.state.doc.toString(); app.vault.files.get(f.path)!.data = d; app.metadataCache.update(f); app.workspace.trigger('editor-change', self.editor, self); } })] }),
    });
    const cm = this.cm;
    const pos = (o: number) => { const l = cm.state.doc.lineAt(o); return { line: l.number - 1, ch: o - l.from }; };
    const off = (p: { line: number; ch: number }) => cm.state.doc.line(p.line + 1).from + p.ch;
    this.editor = {
      cm, getValue: () => cm.state.doc.toString(), getSelection: () => cm.state.sliceDoc(cm.state.selection.main.from, cm.state.selection.main.to),
      offsetToPos: pos, posToOffset: off, getCursor: (w?: string) => pos(w === 'from' ? cm.state.selection.main.from : cm.state.selection.main.head),
      setCursor: (p: any) => cm.dispatch({ selection: { anchor: off(p) } }), setSelection: (a: any, b: any) => cm.dispatch({ selection: { anchor: off(a), head: off(b) } }),
      replaceRange: (t: string, a: any, b?: any) => cm.dispatch({ changes: { from: off(a), to: b ? off(b) : off(a), insert: t } }), scrollIntoView() {},
      getLine: (n: number) => cm.state.doc.line(n + 1).text, lineCount: () => cm.state.doc.lines, focus: () => cm.focus(),
    };
    (this as any).file = f;
  }
}
export class WorkspaceLeaf {
  view: any = null; containerEl: HTMLElement;
  constructor(host: HTMLElement) { this.containerEl = host.appendChild(document.createElement('div')); this.containerEl.className = 'workspace-leaf'; }
  async setViewState(s: { type: string }) { const f = app.workspace.factories[s.type]; this.view?.unload(); this.containerEl.empty(); this.view = s.type === 'markdown' ? new MarkdownView(this) : f(this); this.containerEl.append(this.view.containerEl); this.view.load(); await this.view.onOpen(); }
  detach() { void this.view?.onClose?.(); this.view?.unload(); this.containerEl.remove(); app.workspace.leaves = app.workspace.leaves.filter(l => l !== this); }
  async openFile(f: TFile) { if (!(this.view instanceof MarkdownView)) await this.setViewState({ type: 'markdown' }); await this.view.openFile(f); app.workspace.active = this; app.workspace.trigger('file-open', f); }
}
class Workspace extends Events {
  factories: Record<string, (l: WorkspaceLeaf) => any> = {}; leaves: WorkspaceLeaf[] = []; active: WorkspaceLeaf | null = null;
  getLeaf(_a?: any, _b?: any) { const host = document.getElementById(_a === 'split' ? 'side' : 'main')!; const l = new WorkspaceLeaf(host); this.leaves.push(l); return l; }
  getLeavesOfType(t: string) { return this.leaves.filter(l => l.view?.getViewType() === t); }
  async revealLeaf() {}
  getActiveViewOfType(C: any) { const v = this.active?.view; return v instanceof C ? v : null; }
  onLayoutReady(cb: () => void) { setTimeout(cb, 0); }
  async openLinkText(p: string) { const f = app.vault.getAbstractFileByPath(p); if (f instanceof TFile) await this.getLeaf().openFile(f); }
  syncOpen(f: TFile, data: string) { for (const l of this.getLeavesOfType('markdown')) { const v = l.view as MarkdownView; if (v.file?.path === f.path && v.cm.state.doc.toString() !== data) v.cm.dispatch({ changes: { from: 0, to: v.cm.state.doc.length, insert: data } }); } }
}
export class App { vault = new Vault(); metadataCache = new MetadataCache(); fileManager = new FileManager(); workspace = new Workspace(); }
export const app: App = ((window as any).app = new App());

export class Plugin extends Component {
  commands: Record<string, any> = {}; settingTab: any; manifest: any;
  constructor(public app: App, manifest: any) { super(); this.manifest = manifest; }
  async loadData() { return null; } async saveData(d: unknown) { (window as any).__saved = d; }
  registerView(t: string, f: (l: WorkspaceLeaf) => any) { app.workspace.factories[t] = f; }
  registerEditorExtension(e: Extension | Extension[]) { registeredExtensions.push(e); }
  registerMarkdownPostProcessor() {}
  addRibbonIcon() { return document.createElement('div'); }
  addStatusBarItem() { const bar = document.querySelector('.status-bar') ?? document.body.appendChild(Object.assign(document.createElement('div'), { className: 'status-bar' })); const i = document.createElement('div'); i.className = 'status-bar-item'; bar.append(i); const w = document.createElement('div'); w.className = 'status-bar-item'; w.textContent = '134 words'; bar.append(w); return i; }
  addCommand(c: any) { this.commands[c.id] = c; }
  addSettingTab(t: any) { this.settingTab = t; }
}
/** Obsidian's menu: items with a title, an icon, a tick and a click. Tests read `items` and call `click(title)`. */
export class MenuItem { title = ''; icon = ''; checked: boolean | null = null; section = ''; cb: (() => void) | null = null;
  setTitle(t: string) { this.title = t; return this; } setIcon(i: string) { this.icon = i; return this; } setChecked(c: boolean | null) { this.checked = c; return this; }
  setSection(s: string) { this.section = s; return this; } setDisabled() { return this; } setIsLabel() { return this; } onClick(cb: () => void) { this.cb = cb; return this; } }
export class Menu { items: MenuItem[] = []; addItem(cb: (i: MenuItem) => void) { const i = new MenuItem(); cb(i); this.items.push(i); return this; } addSeparator() { return this; }
  click(title: string) { const i = this.items.find(x => x.title === title); if (!i) throw new Error('no menu item ' + title + ' in ' + this.items.map(x => x.title).join(', ')); i.cb?.(); } showAtMouseEvent() {} }
(window as any).__Menu = Menu;
export class Modal {
  modalEl = document.createElement('div'); titleEl = document.createElement('div'); contentEl = document.createElement('div');
  constructor(public app: App) { this.modalEl.className = 'modal'; this.titleEl.className = 'modal-title'; this.contentEl.className = 'modal-content'; this.modalEl.append(this.titleEl, this.contentEl); }
  open() { document.body.append(this.modalEl); this.onOpen(); }
  close() { this.onClose(); this.modalEl.remove(); }
  onOpen() {} onClose() {}
}
export class FuzzySuggestModal<T> extends Modal {
  setPlaceholder() {}
  getItems(): T[] { return []; } getItemText(_t: T) { return ''; } onChooseItem(_t: T) {}
  onOpen() { (window as any).__fuzzy = this; this.contentEl.textContent = this.getItems().map(i => this.getItemText(i)).join('\n'); }
  choose(text: string) { const i = this.getItems().find(x => this.getItemText(x) === text); this.close(); if (i) this.onChooseItem(i); }
}
export class PluginSettingTab { containerEl = document.createElement('div'); constructor(public app: App, public plugin: any) {} }
export class Setting { constructor(_c: HTMLElement) {} setName() { return this; } setDesc() { return this; } addToggle() { return this; } addButton() { return this; } }
