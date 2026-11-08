/**
 * A story project: a folder with chapter notes, `World/` (one note per piece) and `story-engine.json`
 * (definitions, named moments, where pieces are, map positions, book look). All reads and writes go through here.
 */
import { App, Events, MarkdownView, Notice, TFile, TFolder, normalizePath, parseYaml, stringifyYaml } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { Transaction } from '@codemirror/state';
import * as M from './model';
import { toLinePerParagraph } from './manuscript';

export const DATA_FILE = 'story-engine.json';
/** One step of undo: the map and timeline data before it, and how to undo/redo what it did to files. */
interface UndoStep { s: string; undo?: () => Promise<void>; redo?: () => Promise<void>; what?: string /* “moving Mara”: said when it's undone */; keys?: UndoKey[] }
/**
 * The parts of the story's data a step can put back. A step puts back only what it changed: undoing a move
 * must never also undo a moment renamed since. Most steps change where things are on the map.
 */
type UndoKey = 'track' | 'places' | 'areas' | 'roofs' | 'maps' | 'icons' | 'map' | 'moments' | 'types' | 'styles' | 'themes';
const MAP_KEYS: UndoKey[] = ['track', 'places', 'areas', 'roofs', 'maps', 'icons', 'map'];

export interface SceneEntry {
  file: TFile;
  chapter: string;        // chapter title (its heading) or file name
  index: number;          // scene number within the chapter (0-based)
  span: M.SceneSpan;
  order: number;          // 1-based reading order across the whole story
  label: string;          // e.g. "Bran · 2"
  id?: string;
  pov: string | null;
  where: string | null;
  slot: number;
  kind: M.TimelineScene['kind'];
  ref?: number;           // order of the scene it runs alongside / flashes back to
  band?: M.MomentBand;
  snippet: string;        // its opening words, to find it again if its settings comment is lost
}
export interface StoryTimeline { scenes: SceneEntry[]; t: M.Timeline }

const FALLBACK_TYPE: M.PieceType = { id: 'other', label: 'Other', plural: 'Other', color: '#9a96a0', behaviour: 'token', folder: 'Other' };

export class Project extends Events {
  data: M.ProjectData = M.blankData();
  pieces = new Map<string, M.Piece>();
  private byName = new Map<string, string>();
  private saveTimer: number | null = null;
  private cache: StoryTimeline | null = null;
  private building: Promise<StoryTimeline> | null = null;
  match: (text: string) => M.NameHit[] = () => [];

  constructor(public app: App, public folder: string) { super(); }

  get name() { return this.folder.split('/').pop() || this.folder || 'Story'; }
  get dataPath() { return normalizePath(`${this.folder}/${DATA_FILE}`); }
  get worldFolder() { return normalizePath(`${this.folder}/World`); }
  contains(path: string) { return this.folder === '' || path.startsWith(this.folder + '/'); }
  inWorld(path: string) { return path.startsWith(this.worldFolder + '/'); }
  /**
   * 2.11: one line is one paragraph. Chapters written the old way (an empty line between paragraphs) are converted once;
   * the originals are copied to Backups/Before 2.11 first. Reads the files directly, so it doesn't wait for Obsidian's index.
   */
  async convertToLinePerParagraph(): Promise<number> {
    const base = this.folder ? this.folder + '/' : '', dir = normalizePath(`${base}Backups/Before 2.11`);
    let n = 0;
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!this.contains(f.path) || this.inWorld(f.path) || this.inSpare(f.path)) continue;
      const text = await this.app.vault.read(f);
      if (!hasBookLook(text)) continue;
      const next = toLinePerParagraph(text);
      if (next === text) continue;
      await this.backup(dir, f, text);
      await this.app.vault.modify(f, next); n++;
    }
    this.data.format = 2; await this.saveNow(); this.invalidateScenes();
    return n;
  }
  /** Copy a note's text into a backup folder (never overwriting an older backup). */
  async backup(dir: string, f: TFile, text: string, name = f.basename) {
    for (let i = 1, path = ''; ; i++) {
      for (const part of dir.split('/').reduce<string[]>((a, p) => [...a, a.length ? `${a[a.length - 1]}/${p}` : p], [])) if (!this.app.vault.getAbstractFileByPath(part)) await this.app.vault.createFolder(part);
      path = normalizePath(`${dir}/${i > 1 ? name + ' ' + i : name}.${f.extension}`);
      if (!this.app.vault.getAbstractFileByPath(path)) { await this.app.vault.create(path, text); return path; }
    }
  }
  /** The story's Exports and Backups folders: never chapters. */
  inSpare(path: string) { const base = this.folder ? this.folder + '/' : ''; return path.startsWith(base + 'Exports/') || path.startsWith(base + 'Backups/'); }

  async load() {
    const f = this.app.vault.getAbstractFileByPath(this.dataPath);
    // Just after a folder is renamed, Obsidian's list of files can lag behind the disk: read it from the disk then.
    const onDisk = !(f instanceof TFile) && await this.app.vault.adapter.exists(this.dataPath).catch(() => false);
    if (f instanceof TFile || onDisk) {
      const text = f instanceof TFile ? await this.app.vault.read(f) : await this.app.vault.adapter.read(this.dataPath);
      try { this.data = M.normalizeData(JSON.parse(text)); this.written = text; this.readOk = true; }
      catch {
        if (!(f instanceof TFile)) { this.readOk = false; this.indexAll(); return; }   // not settled yet: never save over it
        // Keep a copy before anything can save over it (a half-synced file can often be repaired by hand).
        const copy = await this.backup(normalizePath(`${this.folder ? this.folder + '/' : ''}Backups`), f, text, 'story-engine (unreadable)').catch(() => null);   // never named story-engine.json: that would look like a story
        new Notice(`Story Engine: ${this.dataPath} could not be read, so “${this.name}” starts with an empty map and timeline.${copy ? ` A copy of the old file is in ${copy}.` : ''}`, 0);
        this.data = M.blankData(); this.readOk = !!copy;   // only once a copy is safe may the empty story be saved over it
      }
    }
    this.indexAll();
    if (this.data.legacy) await this.upgradeFrom20();
  }
  /** The data file as this plugin last read or wrote it: anything else in it came from outside (sync, another device). */
  private written = '';
  /** Whether this story's data came from its file (or there was no file yet). Until then, saving would wipe the file. */
  private readOk = false;
  /** The data file changed on disk: if someone else changed it, take their version instead of saving over it. */
  async reloadIfChanged() {
    const f = this.app.vault.getAbstractFileByPath(this.dataPath);
    if (!(f instanceof TFile)) return;
    const text = await this.app.vault.read(f);
    if (text === this.written) return;
    let next: M.ProjectData;
    try { next = M.normalizeData(JSON.parse(text)); } catch { return; }   // half-written: the next change event brings the rest
    if (this.saveTimer !== null) { window.clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.data = next; this.written = text; this.readOk = true;
    this.undoStack = []; this.redoStack = [];
    this.invalidateScenes(); this.trigger('changed'); this.trigger('look');
  }
  /** This story is gone (its folder moved, its data file deleted): a save still waiting must not write it back. */
  disposed = false;
  dispose() { this.disposed = true; if (this.saveTimer !== null) { window.clearTimeout(this.saveTimer); this.saveTimer = null; } }
  /** A file or folder moved: the paths this story keeps (map pictures, roof pictures, image icons, where scenes are) follow it. */
  followMove(from: string, to: string) {
    const mv = (x: string | null | undefined) => x && (x === from || x.startsWith(from + '/')) ? to + x.slice(from.length) : x ?? null;
    const d = this.data; let changed = false;
    const keep = <T>(was: T, now: T) => { if (was !== now) changed = true; return now; };
    d.map = keep(d.map, mv(d.map));
    for (const m of d.maps) m.image = keep(m.image, mv(m.image));
    for (const r of Object.values(d.roofs)) r.image = keep(r.image, mv(r.image));
    for (const [k, v] of Object.entries(d.icons)) d.icons[k] = keep(v, mv(v) ?? v);
    for (const v of Object.values(d.sceneKeys ?? {})) v.f = keep(v.f, mv(v.f) ?? v.f);
    if (changed) this.saveSoon();
  }
  saveSoon() {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => { this.saveTimer = null; void this.saveNow(); }, 300);
    this.trigger('changed');
  }
  /** Save layout changes (panel sizes, open sections) without re-drawing anything. */
  saveQuiet() {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => { this.saveTimer = null; void this.saveNow(); }, 400);
  }
  async saveNow() {
    if (this.disposed) return;
    const text = JSON.stringify(this.data, null, 1);
    if (text === this.written) return;
    const f = this.app.vault.getAbstractFileByPath(this.dataPath);
    // A data file this story had and that is now gone was moved or deleted on purpose: never write it back.
    if (!(f instanceof TFile) && this.written) return;
    // A data file this story never managed to read must never be saved over (that would wipe the map and timeline).
    if (f instanceof TFile && !this.readOk) return;
    if (!(f instanceof TFile) && await this.app.vault.adapter.exists(this.dataPath).catch(() => false)) return;
    this.readOk = true;
    this.written = text;
    if (f instanceof TFile) await this.app.vault.modify(f, text); else await this.app.vault.create(this.dataPath, text);
  }

  /* ───────── definitions ───────── */

  type(id: string | undefined): M.PieceType { return this.data.types.find(t => t.id === id) ?? { ...FALLBACK_TYPE, id: id ?? 'other', label: id ? id.charAt(0).toUpperCase() + id.slice(1) : 'Other' }; }
  behaviour(p: M.Piece): M.Behaviour { return this.type(p.type).behaviour; }
  style(label: string): M.LineStyle { return this.data.styles.find(s => s.label.toLowerCase() === label.toLowerCase()) ?? this.data.styles.find(s => s.id === 'other') ?? M.DEFAULT_STYLES[M.DEFAULT_STYLES.length - 1]; }
  usage(kind: 'type' | 'style' | 'theme', key: string): number {
    const k = key.toLowerCase();
    return this.all().filter(p => kind === 'type' ? p.type === key : kind === 'style' ? p.connections.some(c => c.label.toLowerCase() === k) : p.themes.some(t => t.toLowerCase() === k)).length;
  }
  addTypes(labels: string[], behaviour: M.Behaviour = 'token'): M.PieceType[] {
    const made: M.PieceType[] = [];
    for (const label of labels) {
      const id = M.typeId(label)!;
      if (this.data.types.some(t => t.id === id)) continue;
      const t: M.PieceType = { id, label, plural: label.endsWith('s') ? label : label + 's', color: M.nextColor(this.data.types.map(x => x.color)), behaviour, folder: label.endsWith('s') ? label : label + 's' };
      this.data.types.push(t); made.push(t);
    }
    this.saveSoon(); return made;
  }
  addStyles(labels: string[]): M.LineStyle[] {
    const made: M.LineStyle[] = [];
    const before = this.data.styles.findIndex(s => s.id === 'other');
    for (const label of labels) {
      if (this.data.styles.some(s => s.label.toLowerCase() === label.toLowerCase())) continue;
      const s: M.LineStyle = { id: M.uid(), label, color: M.nextColor(this.data.styles.map(x => x.color)), dash: 'solid', width: 2, arrow: 'none' };
      this.data.styles.splice(before < 0 ? this.data.styles.length : before + made.length, 0, s); made.push(s);
    }
    this.saveSoon(); return made;
  }
  addThemes(labels: string[]): string[] {
    const made: string[] = [];
    for (const label of labels) { if (this.data.themes[label]) continue; this.data.themes[label] = { color: M.nextColor(Object.values(this.data.themes).map(t => t.color)), meaning: '' }; made.push(label); }
    this.saveSoon(); return made;
  }
  copyDefinitionsFrom(other: Project) {
    for (const t of other.data.types) if (!this.data.types.some(x => x.id === t.id)) this.data.types.push({ ...t });
    for (const s of other.data.styles) if (!this.data.styles.some(x => x.label.toLowerCase() === s.label.toLowerCase())) this.data.styles.push({ ...s, id: M.uid() });
    for (const [k, v] of Object.entries(other.data.themes)) if (!this.data.themes[k]) this.data.themes[k] = { ...v };
    this.saveSoon();
  }
  /** Rename a connection type everywhere it is used. */
  async renameStyle(s: M.LineStyle, label: string) {
    const old = s.label.toLowerCase(), using = this.all().filter(p => p.connections.some(c => c.label.toLowerCase() === old));
    await this.notesStep(using, async () => {
    s.label = label;
    for (const p of using) {
      if (!p.connections.some(c => c.label.toLowerCase() === old)) continue;
      await this.editFrontmatter(p, fm => { fm.connections = (Array.isArray(fm.connections) ? fm.connections.map(String) : []).map((x: string) => { const c = M.parseConnection(x); return c && c.label.toLowerCase() === old ? M.formatConnection({ ...c, label }) : x; }); });
      p.connections = p.connections.map(c => c.label.toLowerCase() === old ? { ...c, label } : c);
    }
    this.saveSoon();
    }, `renaming the ${s.label === label ? old : s.label} connection type`, ['styles']);
  }
  /** Rename a theme on every piece that carries it (null removes it). */
  async renameTheme(from: string, to: string | null) {
    const using = this.all().filter(p => p.themes.includes(from));
    await this.notesStep(using, async () => {
    const t = this.data.themes[from];
    delete this.data.themes[from];
    if (to && t) this.data.themes[to] = t;
    for (const p of this.all()) {
      if (!p.themes.includes(from)) continue;
      const next = [...new Set(p.themes.flatMap(x => x === from ? (to ? [to] : []) : [x]))];
      await this.editFrontmatter(p, fm => { if (next.length) fm.themes = next; else delete fm.themes; });
      p.themes = next;
    }
    this.saveSoon();
    }, to ? `renaming the theme ${from}` : `deleting the theme ${from}`, ['themes']);
  }
  /**
   * A change to several pieces' notes at once (renaming a theme everywhere, say), as one undo step.
   * Undo puts back only the notes nobody has written in since; the rest are left as they are, and that is said.
   */
  private async notesStep(list: M.Piece[], change: () => Promise<void>, what: string, keys: UndoKey[] = MAP_KEYS) {
    const files = list.map(p => this.file(p)).filter((f): f is TFile => !!f);
    const before = new Map<string, string>(), after = new Map<string, string>();
    for (const f of files) before.set(f.path, await this.app.vault.read(f));
    const swap = async (from: Map<string, string>, to: Map<string, string>) => {
      let kept = 0;
      for (const f of files) {
        if (!(this.app.vault.getAbstractFileByPath(f.path) instanceof TFile)) continue;
        const now = await this.app.vault.read(f), was = from.get(f.path), next = to.get(f.path);
        if (was === undefined || next === undefined || now === next) continue;
        if (now !== was) { kept++; continue; }
        await this.app.vault.modify(f, next);
      }
      if (kept) new Notice(`${kept} note${kept > 1 ? 's have' : ' has'} changed since, so ${kept > 1 ? 'they were' : 'it was'} left as ${kept > 1 ? 'they are' : 'it is'}.`);
    };
    this.checkpoint({ undo: () => swap(after, before), redo: () => swap(before, after), what, keys });
    await change();
    for (const f of files) after.set(f.path, await this.app.vault.read(f));
  }
  setLook(patch: Partial<M.BookLook>) { this.data.look = { ...this.data.look, ...patch }; this.saveSoon(); this.trigger('look'); }

  /* ───────── pieces ───────── */

  indexAll() {
    this.pieces.clear();
    for (const f of this.app.vault.getMarkdownFiles()) if (this.contains(f.path)) this.indexFile(f, false);
    this.reindexNames();
  }
  private fixingTwins = false;
  indexFile(f: TFile, notify = true) {
    const had = [...this.pieces.values()].find(p => p.path === f.path);
    if (had) this.pieces.delete(had.id);
    const p = this.contains(f.path) ? M.parsePiece(f.path, f.basename, this.app.metadataCache.getFileCache(f)?.frontmatter) : null;
    // Two notes with one id: one is a copy (“Make a copy”, a duplicated file). The newer one gets an id of its own.
    const twin = p && this.pieces.get(p.id), twinFile = twin && twin.path !== f.path ? this.file(twin) : null;
    if (p && twinFile) { void this.splitTwin(twinFile, f); return; }
    if (p) this.pieces.set(p.id, p);
    if (p || had) { this.reindexNames(); if (notify) this.trigger('changed'); }
    if (this.isChapter(f)) { this.cache = null; if (notify) this.trigger('scenes'); }
  }
  private splitting = new Set<string>();
  private async splitTwin(a: TFile, b: TFile) {
    const copy = a.stat.ctime > b.stat.ctime ? a : b, original = copy === a ? b : a;
    if (this.splitting.has(copy.path)) return;
    this.splitting.add(copy.path);
    try {
      await this.app.fileManager.processFrontMatter(copy, fm => { fm['se-id'] = M.uid(); });
      new Notice(`Story Engine: “${copy.basename}” was a copy of “${original.basename}”, so it now has its own place in the world.`);
    } finally { this.splitting.delete(copy.path); }
    // The copy is read again (with its new id) when Obsidian sees the change; the original takes the old id.
    const stale = [...this.pieces.values()].find(x => x.path === copy.path); if (stale) this.pieces.delete(stale.id);
    this.indexFile(original);
  }
  forget(path: string) {
    const had = [...this.pieces.values()].find(p => p.path === path);
    if (had) { this.pieces.delete(had.id); this.reindexNames(); this.trigger('changed'); }
    this.cache = null;
  }
  /** Remember every piece's name and type next to its id (kept after a link breaks, so it can be found again). */
  private rememberNames() {
    const n = this.data.names ??= {}; let changed = false;
    for (const p of this.pieces.values()) if (n[p.id]?.n !== p.name || n[p.id]?.t !== p.type) { n[p.id] = { n: p.name, t: p.type }; changed = true; }
    if (changed && this.written) this.saveQuiet();
  }
  /** Remember where each scene is and how it opens, for the same reason. */
  private rememberScenes(scenes: SceneEntry[]) {
    const k = this.data.sceneKeys ??= {}; let changed = false;
    for (const s of scenes) {
      if (!s.id) continue;
      const { id: _id, ...m } = s.span.meta; void _id;
      const v = { f: s.file.path, i: s.index, t: s.snippet, m };
      if (JSON.stringify(k[s.id]) !== JSON.stringify(v)) { k[s.id] = v; changed = true; }
    }
    if (changed) this.saveQuiet();
  }
  private reindexNames() {
    this.rememberNames();
    this.byName.clear();
    for (const p of this.pieces.values()) for (const n of [p.name, ...p.aliases]) { const k = n.trim().toLowerCase(); if (k && !this.byName.has(k)) this.byName.set(k, p.id); }
    this.match = M.nameMatcher([...this.pieces.values()]);
  }
  all(): M.Piece[] { return [...this.pieces.values()].sort((a, b) => a.name.localeCompare(b.name)); }
  get(id: string | null | undefined) { return id ? this.pieces.get(id) : undefined; }
  find(name: string): M.Piece | undefined { const id = this.byName.get(M.linkTarget(name).split('/').pop()!.trim().toLowerCase()); return id ? this.pieces.get(id) : undefined; }
  file(p: M.Piece) { const f = this.app.vault.getAbstractFileByPath(p.path); return f instanceof TFile ? f : null; }

  async createPiece(input: { name: string; type: string; aliases?: string[]; descriptions?: { text: string; source: string | null }[]; connections?: M.Connection[] }): Promise<M.Piece> {
    const name = input.name.trim();
    if (!name) throw new Error('Give it a name first.');
    if (this.find(name)) throw new Error(`“${name}” is already in this story.`);
    const type = this.type(input.type);
    const folder = normalizePath(`${this.worldFolder}/${M.safeFileName(type.folder)}`);
    await this.ensureFolder(folder);
    let path = normalizePath(`${folder}/${M.safeFileName(name)}.md`);
    for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${folder}/${M.safeFileName(name)} ${i}.md`);
    const id = M.uid();
    const base = path.split('/').pop()!.replace(/\.md$/, '');
    const aliases = [...(base !== name ? [name] : []), ...(input.aliases ?? []).filter(a => a.trim() && a.trim() !== name)];
    const fm = M.newPieceFrontmatter(id, type.id, aliases, input.connections ?? []);
    const body = (input.descriptions ?? []).map(d => d.source ? M.quoteBlock(d.text, this.chapterLink(d.source)) : d.text.trim()).join('\n\n');
    const text = `---\n${stringifyYaml(fm)}---\n${body ? '\n' + body + '\n' : ''}`;
    const file = await this.app.vault.create(path, text);
    // Ctrl+Z in the World view takes a new piece away again (with what was done to it on the map in the same step).
    this.checkpoint({ undo: () => this.removeNote(id, text), redo: () => this.restoreNote(path, text), what: `adding ${name}` });
    const p: M.Piece = { id, path: file.path, name: file.basename, type: type.id, aliases, connections: input.connections ?? [], themes: [] };
    this.pieces.set(id, p);
    this.reindexNames();
    this.trigger('changed');
    return p;
  }
  /**
   * The link to a chapter for a quote's source: just its name, or its full path when another note in the vault has the
   * same name (two stories can both have a "01 Prologue"), so the link can only ever mean this story's chapter.
   */
  chapterLink(name: string) {
    const f = this.chapters().find(c => c.basename === name); if (!f) return name;
    const same = this.app.vault.getMarkdownFiles().filter(x => x.basename === f.basename).length;
    return same > 1 ? f.path.replace(/\.md$/, '') : f.basename;
  }
  /** A change to a piece's note, as one undo step in the World view (Ctrl+Z puts the note's text back). */
  private async noteStep(p: M.Piece, change: () => Promise<void>) {
    const f = this.file(p); if (!f) return change();
    const before = await this.app.vault.read(f); let after = before;
    // Only ever put the note back if nobody has written in it since; otherwise say so and leave it alone.
    const swap = async (from: string, to: string) => {
      if (!(this.app.vault.getAbstractFileByPath(f.path) instanceof TFile)) return;
      if (await this.app.vault.read(f) !== from) { new Notice(`${f.basename} has changed since, so it was left as it is.`); return; }
      await this.app.vault.modify(f, to);
    };
    this.checkpoint({ undo: () => swap(after, before), redo: () => swap(before, after), what: `the change to ${p.name}` });
    await change(); after = await this.app.vault.read(f);
  }
  async editFrontmatter(p: M.Piece, fn: (fm: Record<string, any>) => void) {
    const f = this.file(p);
    if (!f) throw new Error(`${p.name}'s note is missing.`);
    await this.app.fileManager.processFrontMatter(f, fn);
  }
  async addAlias(p: M.Piece, alias: string) {
    await this.noteStep(p, async () => {
      await this.editFrontmatter(p, fm => { const l: string[] = Array.isArray(fm.aliases) ? fm.aliases.map(String) : fm.aliases ? [String(fm.aliases)] : []; if (!l.some(a => a.toLowerCase() === alias.toLowerCase())) l.push(alias.trim()); fm.aliases = l; });
      p.aliases = [...new Set([...p.aliases, alias.trim()])]; this.reindexNames(); this.trigger('changed');
    });
  }
  async setType(p: M.Piece, type: string) {
    await this.noteStep(p, async () => {
      await this.editFrontmatter(p, fm => { fm['se-type'] = type; }); p.type = type; this.trigger('changed');
    });
  }
  async addConnection(p: M.Piece, target: M.Piece, label: string) {
    await this.noteStep(p, async () => {
      const c = { target: target.name, label };
      await this.editFrontmatter(p, fm => {
        const l: string[] = Array.isArray(fm.connections) ? fm.connections.map(String) : fm.connections ? [String(fm.connections)] : [];
        if (!l.some(s => M.parseConnection(s)?.target.toLowerCase() === target.name.toLowerCase() && (M.parseConnection(s)?.label ?? '') === label)) l.push(M.formatConnection(c));
        fm.connections = l;
      });
      if (!p.connections.some(x => x.target === c.target && x.label === c.label)) p.connections.push(c);
      this.trigger('changed');
    });
  }
  async removeConnection(p: M.Piece, c: M.Connection) {
    await this.noteStep(p, async () => {
      await this.editFrontmatter(p, fm => { const next = (Array.isArray(fm.connections) ? fm.connections.map(String) : []).filter((s: string) => { const x = M.parseConnection(s); return !(x && x.target === c.target && x.label === c.label); }); if (next.length) fm.connections = next; else delete fm.connections; });
      p.connections = p.connections.filter(x => !(x.target === c.target && x.label === c.label)); this.trigger('changed');
    });
  }
  async setThemes(p: M.Piece, themes: string[]) {
    await this.noteStep(p, async () => {
      this.addThemes(themes.filter(t => !this.data.themes[t]));
      await this.editFrontmatter(p, fm => { if (themes.length) fm.themes = themes; else delete fm.themes; });
      p.themes = themes; this.saveSoon();
    });
  }
  async addDescription(p: M.Piece, text: string, source: string | null) {
    await this.noteStep(p, async () => {
      const f = this.file(p); if (!f) return;
      const block = source ? M.quoteBlock(text, this.chapterLink(source)) : text.trim();
      await this.app.vault.process(f, data => `${data.replace(/\s*$/, '')}\n\n${block}\n`);
      this.trigger('changed');
    });
  }
  async removeDescription(p: M.Piece, raw: string) {
    await this.noteStep(p, async () => {
      const f = this.file(p); if (!f) return;
      await this.app.vault.process(f, data => M.removeBlock(data, raw));
      this.trigger('changed');
    });
  }
  /** Rewrite one typed description, where it stands in the note. */
  async editDescription(p: M.Piece, raw: string, text: string) {
    if (!text.trim() || text.trim() === raw) return;
    await this.noteStep(p, async () => {
      const f = this.file(p); if (!f) return;
      await this.app.vault.process(f, data => M.replaceBlock(data, raw, text));
      this.trigger('changed');
    });
  }
  /** Change what a connection is called (“Sibling” → “Twin”), keeping who it's with. */
  async relabelConnection(p: M.Piece, c: M.Connection, label: string) {
    const next = label.trim(); if (next === c.label) return;
    await this.noteStep(p, async () => {
      await this.editFrontmatter(p, fm => { fm.connections = (Array.isArray(fm.connections) ? fm.connections.map(String) : []).map((s: string) => { const x = M.parseConnection(s); return x && x.target === c.target && x.label === c.label ? M.formatConnection({ target: c.target, label: next }) : s; }); });
      p.connections = p.connections.map(x => x.target === c.target && x.label === c.label ? { target: c.target, label: next } : x);
      if (next && !this.data.styles.some(s => s.label.toLowerCase() === next.toLowerCase())) this.addStyles([next]);
      this.trigger('changed');
    });
  }
  async readDescription(p: M.Piece) { const f = this.file(p); return f ? M.descriptionBlocks(await this.app.vault.cachedRead(f)) : []; }
  /** A note put back by undo (at its old path, or beside it if that's taken). */
  private async restoreNote(path: string, text: string) {
    let to = path;
    for (let n = 2; this.app.vault.getAbstractFileByPath(to); n++) to = path.replace(/\.md$/, ` (${n}).md`);
    const dir = to.split('/').slice(0, -1).join('/');
    if (dir && !this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
    await this.app.vault.create(to, text);
  }
  /** A piece's note taken away again by undo/redo. */
  private async removeNote(id: string, text: string) {
    const x = this.get(id), g = x && this.file(x);
    if (!x || !g) return;
    // Never take away a note that has been written in since: that writing would go with it.
    if (await this.app.vault.read(g) !== text) { new Notice(`${x.name}'s note has changed since, so it was kept.`); return; }
    await this.app.fileManager.trashFile(g);
    this.pieces.delete(id); this.reindexNames(); this.trigger('changed');
  }
  /** Is it anywhere on a map: a place's pin, or a character/item/event's stops? */
  onMap(p: M.Piece) { return this.behaviour(p) === 'place' ? !!this.data.places[p.id] : (this.data.track[p.id] ?? []).some(e => e.place || e.pt); }
  /** Take a piece off the map altogether (a place's pin, area and roof; anything else's whole journey). Undoable. */
  takeOffMap(...list: M.Piece[]) {
    if (!list.length) return;
    this.checkpoint({ what: `removing ${list.length === 1 ? list[0].name : list.length + ' pieces'} from the map` });
    for (const p of list) {
      if (this.behaviour(p) === 'place') { delete this.data.places[p.id]; delete this.data.areas[p.id]; delete this.data.roofs[p.id]; }
      else {
        // Off the map, but a death stays a death (only where it happened is forgotten).
        const deaths = (this.data.track[p.id] ?? []).filter(e => e.dead).map(e => ({ s: e.s, gone: true, dead: true }));
        if (deaths.length) this.data.track[p.id] = deaths; else delete this.data.track[p.id];
      }
    }
    this.invalidateScenes(); this.saveSoon();
  }
  /** Rename a piece (its note), keeping links to it. Undoable. */
  async renamePiece(p: M.Piece, name: string) {
    const f = this.file(p), clean = M.safeFileName(name);
    if (!f) throw new Error(`${p.name}'s note is missing.`);
    if (clean === f.basename) return;
    const other = this.find(name); if (other && other.id !== p.id) throw new Error(`“${name}” is already in this story.`);
    const dir = f.parent && f.parent.path !== '/' ? f.parent.path + '/' : '', to = normalizePath(`${dir}${clean}.md`), from = f.path;
    if (this.app.vault.getAbstractFileByPath(to)) throw new Error(`There's already a note called “${clean}”.`);
    this.checkpoint({ undo: () => this.app.fileManager.renameFile(f, from), redo: () => this.app.fileManager.renameFile(f, to), what: `renaming ${p.name}` });
    await this.app.fileManager.renameFile(f, to);
  }
  /** Delete a piece's note and its spots. `undoable`: Ctrl+Z in the World view brings the note and its spots back. */
  async deletePiece(p: M.Piece, undoable = false) {
    const f = this.file(p), id = p.id, d = this.data;
    // Scenes it was the POV or the location of let go of it (undo puts that back too).
    const tl = await this.timeline().catch(() => null);
    const sceneRefs = (tl?.scenes ?? []).filter(s => s.span.meta.pov === id || s.span.meta.where === id).map(s => ({ s, pov: s.span.meta.pov === id, where: s.span.meta.where === id }));
    const unsetScenes = async () => { for (const r of sceneRefs) await this.setSceneMeta(r.s.file, r.s.index, { ...(r.pov ? { pov: undefined } : {}), ...(r.where ? { where: undefined } : {}) }); };
    if (undoable && f) {
      const path = f.path, text = await this.app.vault.read(f);
      this.checkpoint({
        undo: async () => { await this.restoreNote(path, text); for (const r of sceneRefs) await this.setSceneMeta(r.s.file, r.s.index, { ...(r.pov ? { pov: id } : {}), ...(r.where ? { where: id } : {}) }); },
        redo: async () => { await this.removeNote(id, text); await unsetScenes(); },
        what: `deleting ${p.name}`,
      });
    }
    // Anyone who was at a location being deleted stays exactly where they stood on the map.
    if (d.places[id]) for (const list of Object.values(d.track)) for (const e of list) {
      if (e.place !== id) continue;
      const map = M.mapOfPlace(d, id), at = M.entryOn(d, e, map);
      delete e.place; delete e.off;
      if (at) { e.pt = at.pt; if (map !== M.MAIN_MAP) e.m = map; }
    }
    // Its inside map can only be opened from it: it goes too (undo brings both back).
    for (const m of d.maps.filter(m => m.anchor === id)) this.removeMap(m.id);
    if (f) await this.app.fileManager.trashFile(f);
    await unsetScenes();
    this.pieces.delete(id); delete d.track[id]; delete d.places[id]; delete d.roofs[id]; delete d.areas[id]; delete d.icons[id];
    this.reindexNames(); this.saveSoon();
  }
  /** A chapter's file was renamed: its “# ” title follows (not while chapters are being renumbered). */
  async syncChapterTitle(f: TFile, oldPath: string) {
    if (this.reordering || !this.isChapter(f)) return;
    const oldBase = oldPath.split('/').pop()!.replace(/\.md$/, '');
    const oldTitle = oldBase.replace(/^\d{1,3}(?=[\s\-.·])\s*[-.·]?\s*/, '') || oldBase, title = this.chapterTitle(f);
    if (/^zz-reorder-/.test(oldBase) || /^zz-reorder-/.test(f.basename)) return;
    await this.app.vault.process(f, data => M.retitle(data, oldTitle, title));
  }
  private reordering = false;
  /** Keep `[[Old name]]` connections pointing at a renamed piece. */
  async onRename(f: TFile, oldPath: string) {
    const oldName = oldPath.split('/').pop()!.replace(/\.md$/, '');
    if (oldName === f.basename) return;
    for (const p of this.all()) {
      if (!p.connections.some(c => c.target === oldName)) continue;
      await this.editFrontmatter(p, fm => { fm.connections = (Array.isArray(fm.connections) ? fm.connections : []).map((s: string) => String(s).replace(`[[${oldName}]]`, `[[${f.basename}]]`).replace(`[[${oldName}|`, `[[${f.basename}|`)); });
    }
  }

  /* ───────── chapters, scenes and story time ───────── */

  isChapter(f: TFile) {
    if (f.extension !== 'md' || !this.contains(f.path) || this.inWorld(f.path) || this.inSpare(f.path)) return false;
    const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
    const raw = fm?.cssclasses ?? fm?.cssclass;
    const list = Array.isArray(raw) ? raw.map(String) : raw ? String(raw).split(/[\s,]+/) : [];
    return list.includes('manuscript');
  }
  /** A chapter's title without its number: “02 Bran” → “Bran”. */
  chapterTitle(f: TFile) { return f.basename.replace(/^\d{1,3}(?=[\s\-.·])\s*[-.·]?\s*/, '') || f.basename; }
  /** A new chapter at the end of the story, numbered after the last one. */
  async createChapter(title: string): Promise<TFile> {
    const list = this.chapters();
    const last = list.length ? Number(/^(\d+)/.exec(list[list.length - 1].basename)?.[1] ?? list.length) : 0;
    const n = Math.max(list.length, last) + 1, width = Math.max(2, String(n).length);
    const clean = M.safeFileName(title);
    let path = normalizePath(`${this.folder}/${String(n).padStart(width, '0')} ${clean}.md`);
    for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${this.folder}/${String(n).padStart(width, '0')} ${clean} ${i}.md`);
    return this.app.vault.create(path, `---\ncssclasses: manuscript\n---\n# ${title.trim().toUpperCase()}\n`);
  }
  /* ───────── broken links ───────── */

  /** What the story's data points at that no piece or scene has any more, and what each most likely is now. */
  broken(): M.Broken | null {
    const tl = this.cache; if (!tl) return null;
    const scenes: M.SceneRef[] = tl.scenes.map(s => ({ id: s.id, file: s.file.path, index: s.index, text: s.snippet, meta: s.span.meta }));
    const known = new Set([...this.pieces.values()].map(p => p.path));
    const loose = this.app.vault.getMarkdownFiles().filter(f => this.inWorld(f.path) && !known.has(f.path)).map(f => ({ path: f.path, name: f.basename }));
    return M.brokenLinks(this.data, this.all(), scenes, loose);
  }
  /**
   * Reconnect what can be matched: a scene gets its old id back in its settings comment; a note that lost its id gets
   * it back; a piece that has a new id takes over everything that pointed at the old one.
   */
  async reconnect(b: M.Broken): Promise<number> {
    const tl = await this.timeline();
    let n = 0;
    this.checkpoint({ what: 'reconnecting' });
    for (const x of b.scenes) {
      const s = x.to !== undefined ? tl.scenes[x.to] : undefined; if (!s || s.id) continue;
      // Its whole settings line comes back (POV, location, timing), except anything set on it since.
      const was = this.data.sceneKeys?.[x.id]?.m ?? {}, now = s.span.meta;
      const back = Object.fromEntries(Object.entries(was).filter(([k]) => !(now as Record<string, string | undefined>)[k]));
      await this.setSceneMeta(s.file, s.index, { ...back, id: x.id }); n++;
    }
    for (const x of b.pieces) {
      if (x.note) {
        const f = this.app.vault.getAbstractFileByPath(x.note); if (!(f instanceof TFile)) continue;
        await this.app.fileManager.processFrontMatter(f, fm => { fm['se-id'] = x.id; if (!fm['se-type']) fm['se-type'] = x.type || 'character'; });
        n++; continue;
      }
      if (!x.to) continue;
      // Everything that pointed at the old id now points at the piece's id (a spot it already has in a scene wins).
      const d = this.data, to = x.to, from = x.id;
      if (d.track[from]) { const mine = d.track[to] ?? []; d.track[to] = [...mine, ...d.track[from].filter(e => !mine.some(m => m.s === e.s))]; delete d.track[from]; }
      for (const list of Object.values(d.track)) for (const e of list) if (e.place === from) e.place = to;
      for (const key of ['places', 'icons', 'areas', 'roofs'] as const) { const rec = d[key] as Record<string, unknown>; if (rec[from] !== undefined) { if (rec[to] === undefined) rec[to] = rec[from]; delete rec[from]; } }
      for (const m of d.maps) if (m.anchor === from) m.anchor = to;
      for (const s of tl.scenes) {
        const patch: Partial<M.SceneMeta> = {};
        if (s.span.meta.pov === from) patch.pov = to;
        if (s.span.meta.where === from) patch.where = to;
        if (Object.keys(patch).length) await this.setSceneMeta(s.file, s.index, patch);
      }
      n++;
    }
    this.invalidateScenes(); this.saveSoon();
    return n;
  }
  /** Let go of what can't be found any more: its spots, and scene settings pointing at it. */
  async forgetBroken(b: M.Broken) {
    const tl = await this.timeline(), d = this.data;
    this.checkpoint({ what: 'clearing broken links', keys: [...MAP_KEYS, 'moments'] });
    for (const x of b.pieces.filter(x => !x.to && !x.note)) {
      for (const key of ['track', 'places', 'icons', 'areas', 'roofs'] as const) delete (d[key] as Record<string, unknown>)[x.id];
      for (const list of Object.values(d.track)) for (const e of list) if (e.place === x.id) delete e.place;
      for (const s of tl.scenes) {
        const patch: Partial<M.SceneMeta> = {};
        if (s.span.meta.pov === x.id) patch.pov = undefined;
        if (s.span.meta.where === x.id) patch.where = undefined;
        if (Object.keys(patch).length) await this.setSceneMeta(s.file, s.index, patch);
      }
    }
    const lost = new Set(b.scenes.filter(x => x.to === undefined).map(x => x.id));
    if (lost.size) {
      for (const [id, list] of Object.entries(d.track)) { d.track[id] = list.filter(e => !lost.has(e.s)); if (!d.track[id].length) delete d.track[id]; }
      for (const m of d.moments) if (m.until && lost.has(m.until)) delete m.until;
      for (const s of tl.scenes) if ((s.span.meta.with && lost.has(s.span.meta.with)) || (s.span.meta.flash && lost.has(s.span.meta.flash))) await this.setSceneMeta(s.file, s.index, { with: undefined, flash: undefined });
    }
    this.invalidateScenes(); this.saveSoon();
  }
  /** Give a chapter a new name, keeping its number (“03 Old” → “03 New”); its title follows. Undoable. */
  async renameChapter(f: TFile, title: string) {
    const num = /^(\d{1,3})(?=[\s\-.·])/.exec(f.basename)?.[1], clean = M.safeFileName(title);
    const dir = f.parent && f.parent.path !== '/' ? f.parent.path + '/' : '', to = normalizePath(`${dir}${num ? num + ' ' : ''}${clean}.md`), from = f.path;
    // Same name: nothing to rename, but a chapter that has no title yet gets this one.
    if (to === from) { await this.app.vault.process(f, data => M.withTitle(data, title)); return; }
    if (this.app.vault.getAbstractFileByPath(to)) throw new Error(`There's already a chapter called “${clean}”.`);
    this.checkpoint({ undo: () => this.app.fileManager.renameFile(f, from), redo: () => this.app.fileManager.renameFile(f, to), what: `renaming ${this.chapterTitle(f)}` });
    await this.app.fileManager.renameFile(f, to);
  }
  /** Move a chapter to the trash (Ctrl+Z in the World view brings it back). */
  async deleteChapter(f: TFile) {
    const path = f.path, text = await this.app.vault.read(f), name = this.chapterTitle(f);
    this.checkpoint({ undo: () => this.restoreNote(path, text), redo: async () => { const g = this.app.vault.getAbstractFileByPath(path); if (g instanceof TFile && await this.app.vault.read(g) === text) await this.app.fileManager.trashFile(g); }, what: `deleting ${name}` });
    await this.app.fileManager.trashFile(f);
    this.invalidateScenes();
  }
  /** Put chapters in a new order by renumbering their file names (01, 02, …). Links to them are updated by Obsidian. */
  async reorderChapters(order: TFile[]) {
    const width = Math.max(2, String(order.length).length);
    const plan = order.map((f, i) => ({ f, dir: f.parent && f.parent.path !== '/' ? f.parent.path + '/' : '', name: `${String(i + 1).padStart(width, '0')} ${this.chapterTitle(f)}` })).filter(x => x.name !== x.f.basename);
    // Two passes, so a new name never collides with a file that hasn't moved yet.
    const tag = M.uid(), was = plan.map(x => x.f.path);
    this.reordering = true;
    try {
      for (const [i, x] of plan.entries()) await this.app.fileManager.renameFile(x.f, normalizePath(`${x.dir}zz-reorder-${tag}-${i}.md`));
      for (const x of plan) await this.app.fileManager.renameFile(x.f, normalizePath(`${x.dir}${x.name}.md`));
    } catch (err) {
      // Something got in the way half-way: put every chapter back under its old name.
      for (const [i, x] of plan.entries()) if (x.f.path !== was[i] && !this.app.vault.getAbstractFileByPath(was[i])) await this.app.fileManager.renameFile(x.f, was[i]).catch(() => undefined);
      this.invalidateScenes(); throw err;
    } finally { window.setTimeout(() => { this.reordering = false; }, 500); }
    this.invalidateScenes();
  }
  chapters(): TFile[] { return this.app.vault.getMarkdownFiles().filter(f => this.isChapter(f)).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true })); }
  private openEditor(f: TFile) { return this.app.workspace.getLeavesOfType('markdown').map(l => l.view).find((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === f.path); }
  /** Text of a chapter, preferring an open editor (it may hold changes not yet saved). */
  async chapterText(f: TFile): Promise<string> { return this.openEditor(f)?.editor.getValue() ?? this.app.vault.cachedRead(f); }
  cachedTimeline(): StoryTimeline | null { return this.cache; }
  invalidateScenes() { this.cache = null; this.trigger('scenes'); }
  /** Read every piece and chapter again and redraw. */
  refresh() { this.indexAll(); this.trigger('changed'); this.invalidateScenes(); }
  async timeline(): Promise<StoryTimeline> {
    if (this.cache) return this.cache;
    if (this.building) return this.building;
    this.building = (async () => {
      const raw: { file: TFile; chapter: string; span: M.SceneSpan; count: number; snippet: string }[] = [];
      for (const f of this.chapters()) {
        const lines = (await this.chapterText(f)).split('\n');
        const spans = M.scenesOf(lines);
        const heading = lines.find(l => /^#\s/.test(l))?.replace(/^#\s+/, '').trim() || f.basename.replace(/^\d+\s*/, '');
        const chapter = heading.split(/(\s+)/).map((w, i) => /^[IVXLC]+$/.test(w) && i > 0 ? w : w.charAt(0) + w.slice(1).toLowerCase()).join(''); // “BRAN II” → “Bran II”
        for (const span of spans) raw.push({ file: f, chapter, span, count: spans.length, snippet: M.sceneSnippet(lines.slice(span.startLine + 1, span.endLine + 1)) });
      }
      // A copied chapter carries its scenes' ids along: the copy's scenes get ids of their own (positions stay with the original).
      const seen = new Set<string>(), twins: typeof raw = [];
      for (const r of raw) { const id = r.span.meta.id; if (!id) continue; if (seen.has(id)) { twins.push(r); r.span = { ...r.span, meta: { ...r.span.meta, id: undefined } }; } else seen.add(id); }
      if (twins.length && !this.fixingTwins) {
        this.fixingTwins = true;
        window.setTimeout(() => void (async () => {
          try { for (const r of twins) await this.setSceneMeta(r.file, r.span.index, { id: M.uid() }); }
          finally { this.fixingTwins = false; }
          new Notice(`Story Engine: ${[...new Set(twins.map(r => r.file.basename))].join(', ')} had scenes copied from another chapter; they now have their own.`);
        })(), 0);
      }
      const t = M.buildTimeline(raw.map(r => r.span.meta), this.data.moments);
      const scenes: SceneEntry[] = raw.map((r, i) => {
        const ts = t.scenes[i];
        return { file: r.file, chapter: r.chapter, index: r.span.index, span: r.span, order: i + 1, label: r.count > 1 ? `${r.chapter} · ${r.span.index + 1}` : r.chapter, id: r.span.meta.id, pov: r.span.meta.pov ?? null, where: r.span.meta.where ?? null, slot: ts.slot, kind: ts.kind, ref: ts.ref, band: M.bandAt(t, ts.slot), snippet: r.snippet };
      });
      this.cache = { scenes, t };
      this.rememberScenes(scenes);
      return this.cache;
    })();
    try { return await this.building; } finally { this.building = null; }
  }
  async sceneFor(f: TFile, line: number): Promise<SceneEntry | undefined> {
    const all = (await this.timeline()).scenes.filter(s => s.file.path === f.path);
    let found = all[0];
    for (const s of all) if (s.span.startLine <= line) found = s;
    return found;
  }
  /** The scene the playhead is on. */
  current(tl = this.cache): SceneEntry | undefined { if (!tl?.scenes.length) return undefined; return tl.scenes[Math.min(tl.scenes.length, Math.max(1, this.data.view)) - 1]; }
  setView(order: number) { this.data.view = Math.max(1, order); this.saveSoon(); this.trigger('view'); }
  where(p: M.Piece, slot?: number): M.TrackEntry | null {
    const tl = this.cache; if (!tl) return null;
    return M.whereAt(this.data, p, this.behaviour(p), slot ?? this.current(tl)?.slot ?? 0, tl.t.slotOfScene) as M.TrackEntry | null;
  }
  /** Scenes need a stable id once anything refers to them (positions, parallel scenes, flashbacks). */
  async ensureSceneId(s: SceneEntry): Promise<string> {
    if (s.id) return s.id;
    const id = M.uid();
    await this.setSceneMeta(s.file, s.index, { id });
    s.id = id;
    return id;
  }
  async place(p: M.Piece, s: SceneEntry, val: Omit<M.TrackEntry, 's'>) {
    const id = await this.ensureSceneId(s);
    M.setTrack(this.data, p.id, id, val);
    if (this.cache && !this.cache.t.slotOfScene.has(id)) this.cache.t.slotOfScene.set(id, s.slot);
    this.saveSoon();
  }
  /**
   * Gone (or dead) from this scene on. If it was put somewhere in this very scene, that spot is kept with it:
   * a death in the scene someone arrives in still happens somewhere (and stays on the map as a landmark).
   */
  async markGone(x: M.Piece, s: SceneEntry, dead = false) {
    const id = await this.ensureSceneId(s), here = (this.data.track[x.id] ?? []).find(e => e.s === id);
    const pos: Omit<M.TrackEntry, 's'> = here && !here.gone ? { ...(here.place ? { place: here.place } : {}), ...(here.off ? { off: here.off } : {}), ...(here.pt ? { pt: here.pt } : {}), ...(here.m ? { m: here.m } : {}) } : {};
    await this.place(x, s, { ...pos, gone: true, ...(dead ? { dead: true } : {}) });
  }
  /** Not dead after all: the death goes, but the spot it happened at (if it was recorded there) stays. */
  undoDeath(x: M.Piece, sceneId: string) {
    this.data.track[x.id] = (this.data.track[x.id] ?? []).flatMap(e => {
      if (e.s !== sceneId) return [e];
      const { gone: _g, dead: _d, ...rest } = e; void _g; void _d;
      return rest.place || rest.pt ? [rest] : [];
    });
    this.invalidateScenes(); this.saveSoon();
  }
  /** Put a place on a map (keeps the map it's on unless one is given). */
  setPlacePoint(p: M.Piece, pt: M.Point, map?: string) {
    const m = map ?? this.data.places[p.id]?.map ?? M.MAIN_MAP, old = this.data.places[p.id];
    const nx = Math.min(1, Math.max(0, pt.x)), ny = Math.min(1, Math.max(0, pt.y));
    // Its area and roof travel with it (pieces inside are stored relative to it, so they follow too).
    if (old && (old.map ?? M.MAIN_MAP) === m) {
      const dx = nx - old.x, dy = ny - old.y, mv = (q: M.Point) => ({ x: q.x + dx, y: q.y + dy });
      if (this.data.areas[p.id]) this.data.areas[p.id] = this.data.areas[p.id].map(mv);
      const r = this.data.roofs[p.id]; if (r) this.data.roofs[p.id] = { ...r, x: r.x + dx, y: r.y + dy, ...(r.pts ? { pts: r.pts.map(mv) } : {}) };
    } else delete this.data.areas[p.id];
    this.data.places[p.id] = { x: nx, y: ny, ...(m !== M.MAIN_MAP ? { map: m } : {}) };
    this.saveSoon();
  }

  /* ───────── maps inside maps, roofs ───────── */

  mapName(id: string) { return id === M.MAIN_MAP ? 'World' : M.subMap(this.data, id)?.name ?? 'Map'; }
  mapImage(id: string) { return id === M.MAIN_MAP ? this.data.map : M.subMap(this.data, id)?.image ?? null; }
  /** The inside map that opens from a place, if it has one. */
  insideMapOf(placeId: string) { return this.data.maps.find(m => m.anchor === placeId); }
  addMap(name: string, anchor: string, image: string | null = null): M.SubMap {
    const m: M.SubMap = { id: 'map-' + M.uid(), name: name.trim() || 'Inside', image, anchor };
    this.data.maps.push(m); this.saveSoon(); return m;
  }
  removeMap(id: string) {
    this.data.maps = this.data.maps.filter(m => m.id !== id);
    // Places on it move to the map it opened from, at the anchor's spot.
    for (const [pid, pos] of Object.entries(this.data.places)) if (pos.map === id) delete this.data.places[pid];
    this.saveSoon();
  }
  /* Undo for the map: snapshots of where everything is, taken before each change on the map. */
  // A step can also change files (a deleted note, renamed chapters): `undo` and `redo` do that part.
  private undoStack: UndoStep[] = []; private redoStack: UndoStep[] = [];
  private mapState(keys: UndoKey[] = MAP_KEYS) { const d = this.data as unknown as Record<string, unknown>; return JSON.stringify(Object.fromEntries(keys.map(k => [k, d[k] ?? null]))); }
  checkpoint(files: Pick<UndoStep, 'undo' | 'redo' | 'what' | 'keys'> = {}) { this.undoStack.push({ s: this.mapState(files.keys), ...files }); if (this.undoStack.length > 80) this.undoStack.shift(); this.redoStack = []; }
  private async restore(from: UndoStep[], to: UndoStep[], undo: boolean) {
    const step = from.pop(); if (!step) return null;
    to.push({ ...step, s: this.mapState(step.keys) });
    Object.assign(this.data, JSON.parse(step.s));
    await (undo ? step.undo : step.redo)?.();
    this.invalidateScenes(); this.saveSoon(); return step.what ?? 'the last change';
  }
  undoMap() { return this.restore(this.undoStack, this.redoStack, true); }
  redoMap() { return this.restore(this.redoStack, this.undoStack, false); }
  isPlaceId = (id: string) => { const p = this.get(id); return !!p && this.behaviour(p) === 'place'; };
  /** Set a place's area (null: back to the default circle). */
  setArea(placeId: string, pts: M.Point[] | null) { if (pts && pts.length >= 3) this.data.areas[placeId] = pts; else delete this.data.areas[placeId]; this.saveSoon(); }
  /** What a spot on a map means: inside a place's area, or just a spot. */
  spot(mapId: string, pt: M.Point) { return M.spotEntry(this.data, mapId, pt, this.isPlaceId); }
  setRoof(placeId: string, roof: M.Roof | null) { if (roof) this.data.roofs[placeId] = roof; else delete this.data.roofs[placeId]; this.saveSoon(); }
  /** Which map a scene is best shown on: its place's map, else where its POV is, else the main map. */
  sceneMap(s: SceneEntry | undefined): string {
    if (!s) return M.MAIN_MAP;
    const where = this.get(s.where);
    if (where && this.data.places[where.id]) return M.mapOfPlace(this.data, where.id);
    const pov = this.get(s.pov), w = pov ? this.where(pov, s.slot) : null;
    if (w?.place) return M.mapOfPlace(this.data, w.place);
    if (w?.pt) return (w as M.TrackEntry).m || M.MAIN_MAP;
    return M.MAIN_MAP;
  }
  moment(id: string | null | undefined) { return this.data.moments.find(m => m.id === id); }
  /** A new named moment; `skipText` (“Two years later”) makes it start with a time skip. */
  addMoment(label: string, note = '', skipText = ''): string {
    const id = 'm' + M.uid();
    this.data.moments.push({ id, label: label.trim() || skipText.trim(), note: note.trim(), skip: !!skipText.trim(), ...(skipText.trim() ? { skipText: skipText.trim() } : {}) });
    this.saveSoon();
    return id;
  }
  /** Change a scene's hidden settings comment, through the open editor when there is one (keeps undo). */
  async setSceneMeta(f: TFile, sceneIndex: number, patch: Partial<M.SceneMeta>) {
    const lines = (await this.chapterText(f)).split('\n');
    const s = M.scenesOf(lines)[sceneIndex];
    if (!s) return;
    const meta: M.SceneMeta = { ...s.meta };
    for (const [k, v] of Object.entries(patch) as [keyof M.SceneMeta, string | undefined][]) { if (v) meta[k] = v; else delete meta[k]; }
    const comment = M.formatSceneComment(meta);
    const view = this.openEditor(f);
    if (view) {
      const ed = view.editor;
      const at = (line: number, ch: number) => ed.posToOffset({ line, ch });
      const change = s.metaLine != null ? { from: at(s.metaLine, 0), to: at(s.metaLine, lines[s.metaLine].length), insert: comment }
        : s.startLine < 0 ? { from: 0, to: 0, insert: `${comment}\n` }
        : { from: at(s.startLine, lines[s.startLine].length), to: at(s.startLine, lines[s.startLine].length), insert: `\n${comment}` };
      const cm = (ed as unknown as { cm?: EditorView }).cm;
      // A scene's id is how map positions find it: undoing your typing must never take it away again.
      const idOnly = Object.keys(patch).every(k => k === 'id');
      if (cm?.scrollSnapshot) {
        // Edit through CodeMirror directly, keeping the page exactly where it is.
        const top = cm.scrollDOM.scrollTop, changes = cm.state.changes(change), snap = cm.scrollSnapshot().map(changes);
        cm.dispatch({ changes, effects: snap ?? [], ...(idOnly ? { annotations: Transaction.addToHistory.of(false) } : {}) });
        keepScroll(cm, top);
      } else ed.replaceRange(change.insert, ed.offsetToPos(change.from), ed.offsetToPos(change.to));
    } else {
      // Work the lines out again from the file as it is now (the cached copy may be older), and only ever
      // replace a line that is a scene's settings comment: never a line of the text.
      await this.app.vault.process(f, data => {
        const ls = data.split('\n'), cr = /\r$/.test(ls[0] ?? '') ? '\r' : '';
        const now = M.scenesOf(ls.map(l => l.replace(/\r$/, '')))[sceneIndex];
        if (!now) return data;
        const merged: M.SceneMeta = { ...now.meta };
        for (const [k, v] of Object.entries(patch) as [keyof M.SceneMeta, string | undefined][]) { if (v) merged[k] = v; else delete merged[k]; }
        const line = M.formatSceneComment(merged) + cr;
        if (now.metaLine != null) { if (!M.parseSceneComment(ls[now.metaLine].replace(/\r$/, ''))) return data; ls[now.metaLine] = line; }
        else if (now.startLine < 0) ls.splice(0, 0, line);
        else ls.splice(now.startLine + 1, 0, line);
        return ls.join('\n');
      });
    }
    this.invalidateScenes();
  }
  /** Delete a moment. Flashbacks to it now point at the scene that started it, so they keep their place in time. */
  async deleteMoment(id: string, undoable = true) {
    const tl = await this.timeline();
    const start = tl.scenes.find(s => s.span.meta.moment === id);
    const flashers = tl.scenes.filter(s => s.span.meta.flash === id);
    if (undoable) this.checkpoint({
      undo: async () => { if (start) await this.setSceneMeta(start.file, start.index, { moment: id }); for (const f of flashers) await this.setSceneMeta(f.file, f.index, { flash: id }); this.invalidateScenes(); },
      redo: () => this.deleteMoment(id, false),
      what: `deleting the ${this.moment(id)?.label ?? 'moment'} moment`, keys: [...MAP_KEYS, 'moments'],
    });
    if (start && flashers.length) { const sid = await this.ensureSceneId(start); for (const f of flashers) await this.setSceneMeta(f.file, f.index, { flash: sid }); }
    if (start) await this.setSceneMeta(start.file, start.index, { moment: undefined });
    this.data.moments = this.data.moments.filter(m => m.id !== id);
    this.invalidateScenes(); this.saveSoon();
  }
  /** Make a scene start a named moment (removing that moment from any other scene). */
  async startMoment(s: SceneEntry, momentId: string) {
    const tl = await this.timeline();
    for (const o of tl.scenes) if (o !== s && o.span.meta.moment === momentId) await this.setSceneMeta(o.file, o.index, { moment: undefined });
    await this.setSceneMeta(s.file, s.index, { moment: momentId, with: undefined, flash: undefined });
  }

  /** One-time upgrade of a story saved by 2.0: rewrite scene comments and move positions onto scenes. */
  private async upgradeFrom20() {
    const legacy = this.data.legacy!;
    const files = this.chapters();
    const perFile: { f: TFile; lines: string[]; spans: M.SceneSpan[] }[] = [];
    for (const f of files) { const lines = (await this.chapterText(f)).split('\n'); perFile.push({ f, lines, spans: M.scenesOf(lines) }); }
    const metas = perFile.flatMap(x => x.spans.map(s => s.meta));
    const { metas: next, track } = M.upgradeLegacy(metas, legacy, M.uid);
    let k = 0;
    for (const { f, spans } of perFile) {
      const mine = spans.map(() => next[k++]);
      if (mine.every((m, i) => M.formatSceneComment(m) === M.formatSceneComment(spans[i].meta))) continue;
      await this.app.vault.process(f, data => {
        const ls = data.split('\n');
        const cur = M.scenesOf(ls);
        for (let i = cur.length - 1; i >= 0; i--) {
          const s = cur[i], meta = mine[i]; if (!meta) continue;
          const has = Object.keys(meta).length > 0, comment = M.formatSceneComment(meta);
          if (s.metaLine != null) { if (has) ls[s.metaLine] = comment; else ls.splice(s.metaLine, 1); }
          else if (has) { if (s.startLine < 0) ls.splice(0, 0, comment, ''); else ls.splice(s.startLine + 1, 0, '', comment); }
        }
        return ls.join('\n');
      });
    }
    this.data.track = track;
    delete this.data.legacy;
    await this.saveNow();
    this.cache = null;
    new Notice(`Story Engine: “${this.name}” was upgraded to scene-by-scene story time.`);
  }

  async ensureFolder(folder: string) {
    const parts = normalizePath(folder).split('/');
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join('/');
      if (!(this.app.vault.getAbstractFileByPath(p) instanceof TFolder)) await this.app.vault.createFolder(p).catch(() => undefined);
    }
  }
}

/** Does this note's text switch the book look on (`cssclasses: manuscript`)? A tag or a word in another property doesn't count. */
function hasBookLook(text: string): boolean {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text); if (!fm) return false;
  let y: Record<string, unknown> | null = null;
  try { y = parseYaml(fm[1]) as Record<string, unknown> | null; } catch { return false; }
  const raw = y?.cssclasses ?? y?.cssclass;
  const list = Array.isArray(raw) ? raw.map(String) : raw ? String(raw).split(/[\s,]+/) : [];
  return list.includes('manuscript');
}
/** If anything after a scene edit throws the page back to the top, put it back. */
function keepScroll(cm: EditorView, top: number) {
  if (top < 40) return;
  for (const ms of [0, 60, 200, 600, 1200]) window.setTimeout(() => { if (cm.scrollDOM.isConnected && cm.scrollDOM.scrollTop < top / 3) cm.scrollDOM.scrollTop = top; }, ms);
}
