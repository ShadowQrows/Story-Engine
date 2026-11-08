/**
 * A story project: a folder with chapter notes, `World/` (one note per piece) and `story-engine.json`
 * (definitions, named moments, where pieces are, map positions, book look). All reads and writes go through here.
 */
import { App, Events, MarkdownView, Notice, TFile, TFolder, normalizePath, stringifyYaml } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import * as M from './model';
import { toLinePerParagraph } from './manuscript';

export const DATA_FILE = 'story-engine.json';

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
      if (!/^---\r?\n[\s\S]*?\bmanuscript\b[\s\S]*?\r?\n---/.test(text)) continue;
      const next = toLinePerParagraph(text);
      if (next === text) continue;
      await this.backup(dir, f, text);
      await this.app.vault.modify(f, next); n++;
    }
    this.data.format = 2; await this.saveNow(); this.invalidateScenes();
    return n;
  }
  /** Copy a note's text into a backup folder (never overwriting an older backup). */
  async backup(dir: string, f: TFile, text: string) {
    for (let i = 1, path = ''; ; i++) {
      for (const part of dir.split('/').reduce<string[]>((a, p) => [...a, a.length ? `${a[a.length - 1]}/${p}` : p], [])) if (!this.app.vault.getAbstractFileByPath(part)) await this.app.vault.createFolder(part);
      path = normalizePath(`${dir}/${i > 1 ? f.basename + ' ' + i : f.basename}.${f.extension}`);
      if (!this.app.vault.getAbstractFileByPath(path)) { await this.app.vault.create(path, text); return path; }
    }
  }
  /** The story's Exports and Backups folders: never chapters. */
  inSpare(path: string) { const base = this.folder ? this.folder + '/' : ''; return path.startsWith(base + 'Exports/') || path.startsWith(base + 'Backups/'); }

  async load() {
    const f = this.app.vault.getAbstractFileByPath(this.dataPath);
    if (f instanceof TFile) {
      try { this.data = M.normalizeData(JSON.parse(await this.app.vault.read(f))); }
      catch { new Notice(`Story Engine: ${this.dataPath} could not be read, so a fresh timeline is used. The file was not changed.`); this.data = M.blankData(); }
    }
    this.indexAll();
    if (this.data.legacy) await this.upgradeFrom20();
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
    const text = JSON.stringify(this.data, null, 1);
    const f = this.app.vault.getAbstractFileByPath(this.dataPath);
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
    const old = s.label.toLowerCase();
    s.label = label;
    for (const p of this.all()) {
      if (!p.connections.some(c => c.label.toLowerCase() === old)) continue;
      await this.editFrontmatter(p, fm => { fm.connections = (Array.isArray(fm.connections) ? fm.connections.map(String) : []).map((x: string) => { const c = M.parseConnection(x); return c && c.label.toLowerCase() === old ? M.formatConnection({ ...c, label }) : x; }); });
      p.connections = p.connections.map(c => c.label.toLowerCase() === old ? { ...c, label } : c);
    }
    this.saveSoon();
  }
  /** Rename a theme on every piece that carries it (null removes it). */
  async renameTheme(from: string, to: string | null) {
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
  }
  setLook(patch: Partial<M.BookLook>) { this.data.look = { ...this.data.look, ...patch }; this.saveSoon(); this.trigger('look'); }

  /* ───────── pieces ───────── */

  indexAll() {
    this.pieces.clear();
    for (const f of this.app.vault.getMarkdownFiles()) if (this.contains(f.path)) this.indexFile(f, false);
    this.reindexNames();
  }
  indexFile(f: TFile, notify = true) {
    const had = [...this.pieces.values()].find(p => p.path === f.path);
    if (had) this.pieces.delete(had.id);
    const p = this.contains(f.path) ? M.parsePiece(f.path, f.basename, this.app.metadataCache.getFileCache(f)?.frontmatter) : null;
    if (p) this.pieces.set(p.id, p);
    if (p || had) { this.reindexNames(); if (notify) this.trigger('changed'); }
    if (this.isChapter(f)) { this.cache = null; if (notify) this.trigger('scenes'); }
  }
  forget(path: string) {
    const had = [...this.pieces.values()].find(p => p.path === path);
    if (had) { this.pieces.delete(had.id); this.reindexNames(); this.trigger('changed'); }
    this.cache = null;
  }
  private reindexNames() {
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
    const file = await this.app.vault.create(path, `---\n${stringifyYaml(fm)}---\n${body ? '\n' + body + '\n' : ''}`);
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
  async editFrontmatter(p: M.Piece, fn: (fm: Record<string, any>) => void) {
    const f = this.file(p);
    if (!f) throw new Error(`${p.name}'s note is missing.`);
    await this.app.fileManager.processFrontMatter(f, fn);
  }
  async addAlias(p: M.Piece, alias: string) {
    await this.editFrontmatter(p, fm => { const l: string[] = Array.isArray(fm.aliases) ? fm.aliases.map(String) : fm.aliases ? [String(fm.aliases)] : []; if (!l.some(a => a.toLowerCase() === alias.toLowerCase())) l.push(alias.trim()); fm.aliases = l; });
    p.aliases = [...new Set([...p.aliases, alias.trim()])]; this.reindexNames(); this.trigger('changed');
  }
  async setType(p: M.Piece, type: string) { await this.editFrontmatter(p, fm => { fm['se-type'] = type; }); p.type = type; this.trigger('changed'); }
  async addConnection(p: M.Piece, target: M.Piece, label: string) {
    const c = { target: target.name, label };
    await this.editFrontmatter(p, fm => {
      const l: string[] = Array.isArray(fm.connections) ? fm.connections.map(String) : fm.connections ? [String(fm.connections)] : [];
      if (!l.some(s => M.parseConnection(s)?.target.toLowerCase() === target.name.toLowerCase() && (M.parseConnection(s)?.label ?? '') === label)) l.push(M.formatConnection(c));
      fm.connections = l;
    });
    if (!p.connections.some(x => x.target === c.target && x.label === c.label)) p.connections.push(c);
    this.trigger('changed');
  }
  async removeConnection(p: M.Piece, c: M.Connection) {
    await this.editFrontmatter(p, fm => { fm.connections = (Array.isArray(fm.connections) ? fm.connections.map(String) : []).filter((s: string) => { const x = M.parseConnection(s); return !(x && x.target === c.target && x.label === c.label); }); });
    p.connections = p.connections.filter(x => !(x.target === c.target && x.label === c.label)); this.trigger('changed');
  }
  async setThemes(p: M.Piece, themes: string[]) {
    this.addThemes(themes.filter(t => !this.data.themes[t]));
    await this.editFrontmatter(p, fm => { if (themes.length) fm.themes = themes; else delete fm.themes; });
    p.themes = themes; this.saveSoon();
  }
  async addDescription(p: M.Piece, text: string, source: string | null) {
    const f = this.file(p); if (!f) return;
    const block = source ? M.quoteBlock(text, this.chapterLink(source)) : text.trim();
    await this.app.vault.process(f, data => `${data.replace(/\s*$/, '')}\n\n${block}\n`);
    this.trigger('changed');
  }
  async removeDescription(p: M.Piece, raw: string) {
    const f = this.file(p); if (!f) return;
    await this.app.vault.process(f, data => M.removeBlock(data, raw));
    this.trigger('changed');
  }
  async readDescription(p: M.Piece) { const f = this.file(p); return f ? M.descriptionBlocks(await this.app.vault.cachedRead(f)) : []; }
  async deletePiece(p: M.Piece) {
    const f = this.file(p);
    if (f) await this.app.fileManager.trashFile(f);
    this.pieces.delete(p.id); delete this.data.track[p.id]; delete this.data.places[p.id]; delete this.data.roofs[p.id]; delete this.data.areas[p.id]; delete this.data.icons[p.id];
    this.reindexNames(); this.saveSoon();
  }
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
  chapterTitle(f: TFile) { return f.basename.replace(/^\d+\s*[-.·]?\s*/, '') || f.basename; }
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
  /** Put chapters in a new order by renumbering their file names (01, 02, …). Links to them are updated by Obsidian. */
  async reorderChapters(order: TFile[]) {
    const width = Math.max(2, String(order.length).length);
    const plan = order.map((f, i) => ({ f, dir: f.parent && f.parent.path !== '/' ? f.parent.path + '/' : '', name: `${String(i + 1).padStart(width, '0')} ${this.chapterTitle(f)}` })).filter(x => x.name !== x.f.basename);
    // Two passes, so a new name never collides with a file that hasn't moved yet.
    const tag = M.uid();
    for (const [i, x] of plan.entries()) await this.app.fileManager.renameFile(x.f, normalizePath(`${x.dir}zz-reorder-${tag}-${i}.md`));
    for (const x of plan) await this.app.fileManager.renameFile(x.f, normalizePath(`${x.dir}${x.name}.md`));
    this.invalidateScenes();
  }
  chapters(): TFile[] { return this.app.vault.getMarkdownFiles().filter(f => this.isChapter(f)).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true })); }
  private openEditor(f: TFile) { return this.app.workspace.getLeavesOfType('markdown').map(l => l.view).find((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === f.path); }
  /** Text of a chapter, preferring an open editor (it may hold changes not yet saved). */
  async chapterText(f: TFile): Promise<string> { return this.openEditor(f)?.editor.getValue() ?? this.app.vault.cachedRead(f); }
  cachedTimeline(): StoryTimeline | null { return this.cache; }
  invalidateScenes() { this.cache = null; this.trigger('scenes'); }
  async timeline(): Promise<StoryTimeline> {
    if (this.cache) return this.cache;
    if (this.building) return this.building;
    this.building = (async () => {
      const raw: { file: TFile; chapter: string; span: M.SceneSpan; count: number }[] = [];
      for (const f of this.chapters()) {
        const lines = (await this.chapterText(f)).split('\n');
        const spans = M.scenesOf(lines);
        const heading = lines.find(l => /^#\s/.test(l))?.replace(/^#\s+/, '').trim() || f.basename.replace(/^\d+\s*/, '');
        const chapter = heading.split(/(\s+)/).map((w, i) => /^[IVXLC]+$/.test(w) && i > 0 ? w : w.charAt(0) + w.slice(1).toLowerCase()).join(''); // “BRAN II” → “Bran II”
        for (const span of spans) raw.push({ file: f, chapter, span, count: spans.length });
      }
      const t = M.buildTimeline(raw.map(r => r.span.meta), this.data.moments);
      const scenes: SceneEntry[] = raw.map((r, i) => {
        const ts = t.scenes[i];
        return { file: r.file, chapter: r.chapter, index: r.span.index, span: r.span, order: i + 1, label: r.count > 1 ? `${r.chapter} · ${r.span.index + 1}` : r.chapter, id: r.span.meta.id, pov: r.span.meta.pov ?? null, where: r.span.meta.where ?? null, slot: ts.slot, kind: ts.kind, ref: ts.ref, band: M.bandAt(t, ts.slot) };
      });
      this.cache = { scenes, t };
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
  private undoStack: string[] = []; private redoStack: string[] = [];
  private mapState() { const d = this.data; return JSON.stringify({ track: d.track, places: d.places, areas: d.areas, roofs: d.roofs, maps: d.maps }); }
  checkpoint() { this.undoStack.push(this.mapState()); if (this.undoStack.length > 80) this.undoStack.shift(); this.redoStack = []; }
  private restore(from: string[], to: string[]) {
    const s = from.pop(); if (!s) return false;
    to.push(this.mapState());
    Object.assign(this.data, JSON.parse(s));
    this.saveSoon(); return true;
  }
  undoMap() { return this.restore(this.undoStack, this.redoStack); }
  redoMap() { return this.restore(this.redoStack, this.undoStack); }
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
      if (cm?.scrollSnapshot) {
        // Edit through CodeMirror directly, keeping the page exactly where it is.
        const top = cm.scrollDOM.scrollTop, changes = cm.state.changes(change), snap = cm.scrollSnapshot().map(changes);
        cm.dispatch({ changes, effects: snap ?? [] });
        keepScroll(cm, top);
      } else ed.replaceRange(change.insert, ed.offsetToPos(change.from), ed.offsetToPos(change.to));
    } else {
      await this.app.vault.process(f, data => {
        const ls = data.split('\n');
        if (s.metaLine != null) ls[s.metaLine] = comment;
        else if (s.startLine < 0) ls.splice(0, 0, comment);
        else ls.splice(s.startLine + 1, 0, comment);
        return ls.join('\n');
      });
    }
    this.invalidateScenes();
  }
  /** Delete a moment. Flashbacks to it now point at the scene that started it, so they keep their place in time. */
  async deleteMoment(id: string) {
    const tl = await this.timeline();
    const start = tl.scenes.find(s => s.span.meta.moment === id);
    const flashers = tl.scenes.filter(s => s.span.meta.flash === id);
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

/** If anything after a scene edit throws the page back to the top, put it back. */
function keepScroll(cm: EditorView, top: number) {
  if (top < 40) return;
  for (const ms of [0, 60, 200, 600, 1200]) window.setTimeout(() => { if (cm.scrollDOM.isConnected && cm.scrollDOM.scrollTop < top / 3) cm.scrollDOM.scrollTop = top; }, ms);
}
