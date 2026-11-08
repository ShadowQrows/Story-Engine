/**
 * The capture box: a small panel next to the cursor that turns a highlight into a piece of the world.
 *
 *  New name   → pick a type → description (highlight or type) → connections (click/highlight a name, or type)
 *               → where, only if the scene has no place yet → done. Time is the scene you're in.
 *  Known name → quick actions: add description, add connection, here in this scene, gone, make POV, show card.
 *  Scene bar  → POV / When / Where menus.
 *  Card       → "click, then highlight" for descriptions and connections.
 * Finish (or Esc, or clicking elsewhere) keeps what's there. Undo removes what this box just created.
 */
import { App, Notice, TFile } from 'obsidian';
import * as M from './model';
import type { Project, SceneEntry } from './project';

type Sel = { text: string; rect: DOMRect; file: TFile | null };
interface Ctx { project: Project; file: TFile | null; scene: SceneEntry | undefined; anchor: DOMRect }
type Await = 'desc' | 'conn' | 'pov' | 'quick-desc' | 'quick-conn' | null;

export interface CaptureHost {
  app: App;
  openPiece(project: Project, id: string): void;
  sceneAt(project: Project, file: TFile, pos: number | null): Promise<SceneEntry | undefined>;
  currentScene(project: Project): Promise<SceneEntry | undefined>;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

export class Capture {
  pop: HTMLDivElement;
  private ctx: Ctx | null = null;
  private await: Await = null;
  private piece: M.Piece | null = null;
  private steps: string[] = [];
  private step = -1;
  private pendingTarget: M.Piece | null = null;
  private pendingNew: string | null = null;
  private where: Omit<M.TrackEntry, 's'> | null = null;
  private quickTarget: M.Piece | null = null;
  private created: M.Piece[] = [];

  constructor(private host: CaptureHost) {
    this.pop = el('div', 'se-pop');
    this.pop.hidden = true;
    document.body.append(this.pop);
    this.pop.addEventListener('mousedown', e => { if (!(e.target as HTMLElement).closest('input,textarea,select')) e.preventDefault(); });
  }
  destroy() { this.pop.remove(); }
  get open() { return !this.pop.hidden; }

  /* ───────── entry points ───────── */

  async onSelect(project: Project, file: TFile, pos: number, sel: Sel) {
    const text = sel.text.replace(/\s+/g, ' ').trim();
    const clean = text.replace(/^[“"'‘(]+|[”"'’),.;:!?]+$/g, '').replace(/['’]s$/, '');
    if (this.await && this.ctx?.project === project) return this.handleHighlight(clean, text, file, sel.rect);
    const known = project.find(clean);
    const scene = await this.host.sceneAt(project, file, pos);
    if (known) return this.openQuick(project, file, scene, known, sel.rect);
    this.startNew(project, file, scene, sel.rect, M.looksLikeName(clean) ? clean : '', M.looksLikeName(clean) ? null : text);
  }
  async onNameClick(project: Project, file: TFile, pos: number, id: string, rect: DOMRect) {
    const p = project.get(id); if (!p) return;
    if (this.await === 'desc' || this.await === 'quick-desc') return; // clicks on names don't count as a description
    if (this.await && this.ctx?.project === project) return this.handleHighlight(p.name, p.name, file, rect);
    this.openQuick(project, file, await this.host.sceneAt(project, file, pos), p, rect);
  }
  /** “+ New piece” from a button or command: nothing highlighted. */
  async startManual(project: Project, file: TFile | null, scene: SceneEntry | undefined, rect: DOMRect) { this.startNew(project, file, scene ?? await this.host.currentScene(project), rect, '', null, true); }
  /** From the card: click “+ from text”, then highlight in a chapter (or type). */
  async waitFor(project: Project, p: M.Piece, what: 'desc' | 'conn', rect: DOMRect) {
    this.reset({ project, file: null, scene: await this.host.currentScene(project), anchor: rect });
    this.quickTarget = p;
    if (what === 'desc') this.quickDesc(p); else this.quickConn(p);
  }

  /** Clicking somewhere else closes the box (keeping whatever was made). Clicks in chapter text are allowed while it waits for a highlight. */
  onOutsidePointer(target: HTMLElement) {
    if (!this.open || this.pop.contains(target)) return;
    if (this.await && target.closest('.cm-content, .se-scenebar')) return;
    if (target.closest('.se-scenebar, .se-card [data-wait], .modal-container, .menu')) return;
    if (this.piece && this.step >= 0) void this.finish(); else this.close();
  }
  close() { this.pop.hidden = true; this.pop.style.width = ''; this.ctx = null; this.piece = null; this.created = []; this.setAwait(null); }
  onEscape() { if (!this.open) return false; if (this.piece && this.step >= 0) void this.finish(); else this.close(); return true; }

  /* ───────── helpers ───────── */

  private setAwait(a: Await) { this.await = a; document.body.toggleClass('se-awaiting', !!a); }
  private place(rect: DOMRect) {
    const p = this.pop;
    p.hidden = false;
    const w = p.offsetWidth || 320, h = p.offsetHeight || 240, vw = window.innerWidth, vh = window.innerHeight;
    let x = rect.right + 12, y = rect.top - 8;
    if (x + w > vw - 12) x = rect.left - w - 12;
    if (x < 12) { x = Math.min(vw - w - 12, Math.max(12, rect.left)); y = rect.bottom + 10; }
    y = Math.min(Math.max(12, y), vh - h - 12);
    p.style.left = `${x}px`; p.style.top = `${y}px`;
  }
  private header(title: string, opts: { steps?: boolean; finish?: boolean; undo?: boolean } = {}) {
    const hd = el('div', 'se-pop-hd');
    hd.append(el('span', 'se-pop-title', title));
    if (opts.steps) { const dots = el('span', 'se-steps'); this.steps.forEach((_, i) => dots.append(el('i', i < this.step ? 'done' : i === this.step ? 'on' : ''))); hd.append(dots); }
    if (opts.undo && this.piece) { const u = this.button('Undo', () => void this.undo(), 'se-btn se-btn-ghost se-btn-small'); hd.append(u); }
    const x = this.button(opts.finish ? 'Finish' : '✕', () => { if (opts.finish) void this.finish(); else this.close(); }, opts.finish ? 'se-btn se-btn-ghost se-btn-small' : 'se-btn se-btn-ghost se-x');
    hd.append(x);
    return hd;
  }
  private button(text: string, fn: () => void, cls = 'se-btn') { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', e => { e.preventDefault(); fn(); }); return b; }
  private render(nodes: (Node | null | false)[]) {
    this.pop.replaceChildren(...nodes.filter((n): n is Node => !!n));
    if (this.ctx) this.place(this.ctx.anchor);
  }
  private typeGrid(project: Project, pick: (t: M.PieceType) => void, opts: { exclude?: M.Behaviour[] } = {}) {
    const grid = el('div', 'se-grid');
    for (const t of project.data.types.filter(x => !opts.exclude?.includes(x.behaviour))) {
      const b = this.button('', () => pick(t), 'se-tbtn');
      b.dataset.type = t.id; b.style.setProperty('--se-c', t.color);
      b.append(el('span', 'se-sw'), document.createTextNode(t.label)); grid.append(b);
    }
    const add = this.button('+ New type', () => {
      if (grid.querySelector('.se-inline')) return;
      const row = el('div', 'se-inline'); const input = el('input'); input.placeholder = 'Type name, e.g. Spirit';
      const kind = el('select', 'dropdown'); for (const [v, l] of M.BEHAVIOURS) { const o = el('option', '', l); o.value = v; kind.append(o); }
      const ok = () => { const v = input.value.trim(); if (!v) return; const [t] = project.addTypes([v], kind.value as M.Behaviour); if (t) pick(t); else { const ex = project.data.types.find(x => x.label.toLowerCase() === v.toLowerCase()); if (ex) pick(ex); } };
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); ok(); } });
      row.append(input, kind, this.button('Add', ok, 'se-btn mod-cta se-btn-small'));
      grid.after(row); input.focus(); if (this.ctx) this.place(this.ctx.anchor);
    }, 'se-tbtn se-tbtn-add');
    grid.append(add);
    return grid;
  }
  private orInput(placeholder: string, onUse: (v: string) => void, multiline = false, withNames = false) {
    const row = el('div', 'se-or');
    const input = multiline ? el('textarea') : el('input');
    input.placeholder = placeholder;
    if (input instanceof HTMLTextAreaElement) input.rows = 2;
    if (withNames && input instanceof HTMLInputElement && this.ctx) {
      const id = `se-names-${Math.random().toString(36).slice(2)}`;
      const dl = el('datalist'); dl.id = id;
      for (const p of this.ctx.project.all()) { const o = el('option'); o.value = p.name; dl.append(o); }
      input.setAttribute('list', id); row.append(dl);
    }
    const use = () => { const v = input.value.trim(); if (v) onUse(v); };
    (input as HTMLElement).addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); use(); } });
    row.append(input, this.button(multiline ? 'Add' : 'Use', use, 'se-btn se-btn-small'));
    return row;
  }
  swatch(s: M.LineStyle) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('width', '22'); svg.setAttribute('height', '8'); svg.classList.add('se-swatch');
    const l = document.createElementNS(ns, 'line'); l.setAttribute('x1', '2'); l.setAttribute('y1', '4'); l.setAttribute('x2', '20'); l.setAttribute('y2', '4');
    l.setAttribute('stroke', s.color); l.setAttribute('stroke-width', '2'); l.setAttribute('stroke-linecap', 'round'); if (M.DASH[s.dash]) l.setAttribute('stroke-dasharray', M.DASH[s.dash]);
    svg.append(l); return svg;
  }
  swatchFor(project: Project, label: string) { return this.swatch(project.style(label)); }
  private styleChips(project: Project, styles: M.LineStyle[], pick: (s: M.LineStyle) => void) {
    const wrap = el('div', 'se-presets');
    for (const s of styles) { const b = this.button('', () => pick(s), 'se-preset'); b.append(this.swatch(s), document.createTextNode(s.label)); wrap.append(b); }
    const add = this.button('+ New connection type', () => {
      if (wrap.querySelector('.se-inline')) return;
      const row = el('div', 'se-inline'); const input = el('input'); input.placeholder = 'e.g. Sworn sword';
      const ok = () => { const v = input.value.trim(); if (!v) return; const [s] = project.addStyles([v]); pick(s ?? project.style(v)); };
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); ok(); } });
      row.append(input, this.button('Add', ok, 'se-btn mod-cta se-btn-small')); wrap.append(row); input.focus();
    }, 'se-preset se-preset-add');
    wrap.append(add);
    return wrap;
  }
  private waitBox(text: string) { return el('div', 'se-waiting', text); }
  private ask(...parts: (string | [string])[]) { const a = el('div', 'se-ask'); for (const p of parts) a.append(typeof p === 'string' ? document.createTextNode(p) : el('b', '', p[0])); return a; }

  /* ───────── new piece ───────── */

  private reset(ctx: Ctx) {
    this.ctx = ctx; this.piece = null; this.step = -1; this.steps = []; this.pendingTarget = null; this.pendingNew = null; this.where = null; this.quickTarget = null; this.created = []; this.setAwait(null);
  }
  private startNew(project: Project, file: TFile | null, scene: SceneEntry | undefined, rect: DOMRect, name: string, passage: string | null, manual = false) {
    this.reset({ project, file, scene, anchor: rect });
    const nameInput = el('input', 'se-namefield');
    nameInput.placeholder = 'Name'; nameInput.value = name;
    const grid = this.typeGrid(project, t => {
      const n = nameInput.value.trim();
      if (!n) { new Notice('Give it a name first.'); nameInput.focus(); return; }
      void this.create(n, t, name && name !== n && !manual ? [name] : [], passage);
    });
    const nodes: (Node | false)[] = [this.header(manual ? 'New piece' : passage ? 'Add this passage as…' : 'Add to your world'), nameInput];
    if (name && !manual) nodes.push(el('div', 'se-small', `Change the name if the text uses a nickname. “${name}” is kept as another name for it.`));
    if (passage) nodes.push(el('div', 'se-small', 'The highlighted passage becomes its description.'));
    nodes.push(grid);
    if (name && !manual && project.pieces.size) { const row = el('div', 'se-acts'); row.append(this.button('It\'s another name for…', () => this.aliasMenu(name), 'se-btn se-btn-ghost se-btn-small se-left')); nodes.push(row); }
    this.render(nodes);
    if (!name || manual) window.setTimeout(() => nameInput.focus(), 0);
  }
  private aliasMenu(alias: string) {
    const c = this.ctx!, menu = el('div', 'se-menu');
    for (const p of c.project.all()) {
      const b = this.button('', async () => { await c.project.addAlias(p, alias); new Notice(`“${alias}” is now another name for ${p.name}.`); this.host.openPiece(c.project, p.id); this.close(); });
      const dot = el('span', 'se-dot'); dot.style.setProperty('--se-c', c.project.type(p.type).color); b.append(dot, document.createTextNode(p.name)); menu.append(b);
    }
    this.render([this.header(`“${alias}” is another name for…`), menu]);
  }
  private async create(name: string, type: M.PieceType, aliases: string[], passage: string | null) {
    const c = this.ctx!;
    try { this.piece = await c.project.createPiece({ name, type: type.id, aliases, descriptions: passage ? [{ text: passage, source: c.file?.basename ?? null }] : [] }); }
    catch (e) { new Notice((e as Error).message); return; }
    const sceneHasPlace = !!c.project.get(c.scene?.where);
    void sceneHasPlace;
    this.steps = type.behaviour === 'place' ? ['desc', 'where'] : type.behaviour === 'event' ? ['desc', 'involves', 'where'] : ['desc', 'conn', 'where'];
    this.step = 0;
    await this.drawStep();
  }
  private async drawStep() {
    const c = this.ctx!, p = this.piece!, s = this.steps[this.step], t = c.project.type(p.type);
    const title = `${p.name} · ${t.label}`;
    const nav = el('div', 'se-acts');
    if (this.step > 0) nav.append(this.button('Back', () => { this.step--; this.pendingTarget = null; this.pendingNew = null; void this.drawStep(); }, 'se-btn se-btn-ghost se-left'));
    nav.append(this.button('Skip', () => this.next(true), 'se-btn se-btn-ghost'), this.button(this.step === this.steps.length - 1 ? 'Done' : 'Next', () => this.next(), 'se-btn mod-cta'));
    const head = this.header(title, { steps: true, finish: true, undo: true });
    this.setAwait(null);
    if (s === 'desc') {
      this.setAwait('desc');
      const list = el('div', 'se-collected');
      for (const d of await c.project.readDescription(p)) { const q = el('div', `se-quote${d.source ? '' : ' is-typed'}`, d.text); q.style.setProperty('--se-c', t.color); list.append(q); }
      this.render([head, this.ask(['Description. '], `Highlight the text that describes ${p.name} (more than one passage is fine), or type it.`), list, this.waitBox('Waiting for you to highlight…'),
        this.orInput('…or type a description', async v => { await c.project.addDescription(p, v, null); void this.drawStep(); }, true), nav]);
    } else if (s === 'conn' || s === 'involves') {
      const styles = s === 'involves' ? c.project.data.styles.filter(x => x.id === 'involved') : c.project.data.styles.filter(x => x.id !== 'involved');
      if (this.pendingTarget) {
        const tg = this.pendingTarget;
        this.render([head, this.ask('How is ', [p.name], ' connected to ', [tg.name], '?'), this.styleChips(c.project, styles.length ? styles : c.project.data.styles, async st => { await c.project.addConnection(p, tg, st.label); this.pendingTarget = null; void this.drawStep(); }), nav]);
      } else if (this.pendingNew) {
        const n = this.pendingNew;
        this.render([head, this.ask([n], ' isn\'t in your world yet. Add it as:'), this.typeGrid(c.project, async ty => {
          try { const np = await c.project.createPiece({ name: n, type: ty.id }); this.created.push(np); this.pendingNew = null; this.pendingTarget = np; void this.drawStep(); }
          catch (err) { new Notice((err as Error).message); }
        }, { exclude: ['event'] }), nav]);
      } else {
        this.setAwait('conn');
        const done = el('div', 'se-collected');
        for (const cn of p.connections) { const row = el('div', 'se-conn'); row.append(this.swatch(c.project.style(cn.label)), document.createTextNode(`${cn.label || 'Connected to'} `), el('b', '', cn.target)); done.append(row); }
        this.render([head, this.ask([s === 'involves' ? 'Who is involved? ' : 'Connections. '], s === 'involves' ? 'Click or highlight each person or thing involved, or type a name.' : `Click or highlight who or what ${p.name} is connected to, or type a name.`), done, this.waitBox('Waiting for you to click or highlight a name…'), this.orInput('…or type a name', v => this.pickTarget(v), false, true), nav]);
      }
    } else if (s === 'where') {
      if (t.behaviour === 'place') {
        this.render([head, this.ask(['Where '], `is ${p.name}? Click the spot on your map.`),
          this.miniMap({ mode: 'point', exclude: p.id, onPick: r => { if (r.pt) { c.project.setPlacePoint(p, r.pt, r.m); this.next(); } } }), nav]);
        return;
      }
      // One panel: the suggestion on top, the mini-map under it. Click the suggestion (or Done) to accept it, or click your own spot.
      const sug = this.suggest();
      this.sug = sug;
      const noPlace = !c.scene?.where;
      const nodes: (Node | false)[] = [head, this.ask(['Where '], M.say(M.wordsOf(c.project.data), `is ${p.name} in this scene?${noPlace ? ' This scene has no location yet: pick or name one and it becomes the scene\'s location too.' : ''}`))];
      if (sug) { const b = this.button('', () => { this.where = sug.entry; this.next(); }, 'se-suggest'); b.append(el('span', 'se-suggest-k', 'Suggested'), document.createTextNode(sug.label)); nodes.push(b); }
      nodes.push(this.miniMap({ mode: 'spot', exclude: p.id, focus: sug?.place ?? null, onPick: async r => {
        this.where = r.entry ?? null;
        if (r.entry?.place && noPlace && c.scene && c.file) await c.project.setSceneMeta(c.file, c.scene.index, { where: r.entry.place });
        this.next();
      } }));
      nodes.push(nav);
      this.render(nodes);
    }
  }
  private sug: { label: string; entry: Omit<M.TrackEntry, 's'>; place: string } | null = null;
  private next(skip = false) {
    if (this.steps[this.step] === 'where' && !this.where) this.where = skip || !this.sug ? {} : this.sug.entry;
    this.pendingTarget = null; this.pendingNew = null;
    if (this.step >= this.steps.length - 1) { void this.finish(); return; }
    this.step++; void this.drawStep();
  }
  /** Put what was made on the map from this scene on, then close. */
  private async finish() {
    const c = this.ctx, p = this.piece;
    if (!c || !p) { this.close(); return; }
    const made = [p, ...this.created];
    const scene = c.scene ?? await this.host.currentScene(c.project);
    if (scene) {
      const where = this.where ?? (scene.where ? { place: scene.where } : {});
      const loose: Omit<M.TrackEntry, 's'> = where.place ? { place: where.place } : scene.where ? { place: scene.where } : {};
      for (const x of made) {
        const b = c.project.behaviour(x);
        if (b === 'place' || (x !== p && (c.project.data.track[x.id] ?? []).length)) continue;
        await c.project.place(x, scene, { ...(x === p ? where : loose), ...(b === 'event' ? { only: true } : {}) });
      }
      c.project.setView(scene.order);
    }
    this.toastUndo(c.project, made);
    this.host.openPiece(c.project, p.id);
    this.close();
  }
  private toastUndo(project: Project, made: M.Piece[]) {
    const frag = document.createDocumentFragment();
    frag.append(`Added ${made.map(x => x.name).join(', ')}. `);
    const u = el('a', 'se-undo-link', 'Undo'); u.href = '#';
    u.addEventListener('click', e => { e.preventDefault(); void Promise.all(made.map(x => project.deletePiece(x))).then(() => new Notice('Removed.')); });
    frag.append(u);
    new Notice(frag as unknown as string, 8000);
  }
  private async undo() {
    const c = this.ctx; if (!c) return;
    for (const x of [this.piece, ...this.created]) if (x) await c.project.deletePiece(x);
    new Notice('Removed.');
    this.close();
  }
  private pickTarget(text: string) {
    const c = this.ctx!, t = c.project.find(text);
    if (t && t.id === (this.piece ?? this.quickTarget)?.id) return;
    if (t) this.pendingTarget = t; else this.pendingNew = text;
    if (this.quickTarget) this.drawQuickConn(); else void this.drawStep();
  }
  private async handleHighlight(clean: string, raw: string, file: TFile, rect: DOMRect) {
    const c = this.ctx!;
    c.anchor = rect;
    if (this.await === 'desc' && this.piece) { await c.project.addDescription(this.piece, raw, file.basename); void this.drawStep(); }
    else if (this.await === 'conn') this.pickTarget(clean);
    else if (this.await === 'pov') { const t = c.project.find(clean); if (t && c.file && c.scene) { await c.project.setSceneMeta(c.file, c.scene.index, { pov: t.id }); this.close(); } }
    else if (this.await === 'quick-desc' && this.quickTarget) { await c.project.addDescription(this.quickTarget, raw, file.basename); new Notice(`Added to ${this.quickTarget.name}'s description.`); this.host.openPiece(c.project, this.quickTarget.id); this.close(); }
    else if (this.await === 'quick-conn') this.pickTarget(clean);
  }

  /* ───────── existing piece: quick actions ───────── */

  private quickDesc(p: M.Piece) {
    const c = this.ctx!;
    this.setAwait('quick-desc');
    this.render([this.header(`${p.name} · description`), this.waitBox('Highlight the text in a chapter…'), this.orInput('…or type it', async v => { await c.project.addDescription(p, v, null); this.host.openPiece(c.project, p.id); this.close(); }, true)]);
  }
  private quickConn(p: M.Piece) {
    this.pendingTarget = null; this.pendingNew = null; this.setAwait('quick-conn');
    this.render([this.header(`${p.name} · connection`), this.waitBox(`Click or highlight who ${p.name} is connected to…`), this.orInput('…or type a name', v => this.pickTarget(v), false, true)]);
  }
  private async openQuick(project: Project, file: TFile, scene: SceneEntry | undefined, p: M.Piece, rect: DOMRect) {
    this.reset({ project, file, scene, anchor: rect });
    this.quickTarget = p;
    this.host.openPiece(project, p.id);
    const pl = project.get(scene?.where), b = project.behaviour(p), sc = M.wordsOf(project.data).scene.toLowerCase();
    const menu = el('div', 'se-menu');
    const item = (icon: string, text: string, fn: () => void) => { const bt = this.button('', fn); bt.append(el('span', 'se-mi', icon), document.createTextNode(text)); menu.append(bt); };
    item('✎', 'Add to description', () => this.quickDesc(p));
    item('⟷', 'Add a connection', () => this.quickConn(p));
    if (b !== 'place' && scene) {
      item('◎', `Here in this ${sc}${pl ? ': ' + pl.name : ''}`, async () => {
        const prev = project.where(p, scene.slot);
        await project.place(p, scene, pl ? { place: pl.id } : prev?.place ? { place: prev.place } : prev?.pt ? { pt: prev.pt } : {});
        project.setView(scene.order); new Notice(`${p.name} is in ${sc} ${scene.order}${pl ? ' at ' + pl.name : ''}.`); this.close();
      });
      if (b === 'token') item('✝', `Dead from this ${sc} on`, async () => { await project.place(p, scene, { gone: true, dead: true }); project.setView(scene.order); new Notice(`${p.name} is dead from ${sc} ${scene.order} on, and listed under Dead.`); this.close(); });
      item('✕', `Gone from this ${sc} on`, async () => { await project.place(p, scene, { gone: true }); project.setView(scene.order); new Notice(`${p.name} is off the map from ${sc} ${scene.order} on.`); this.close(); });
    } else if (scene) item('◎', `This ${sc} takes place here`, () => { void project.setSceneMeta(file, scene.index, { where: p.id }); this.close(); });
    if (p.type === 'character' && scene) item('👁', `This ${sc} is ${p.name}'s POV`, () => { void project.setSceneMeta(file, scene.index, { pov: p.id }); this.close(); });
    this.render([this.header(`${p.name} · ${project.type(p.type).label}`), menu]);
  }
  private drawQuickConn() {
    const c = this.ctx!, p = this.quickTarget!;
    this.setAwait(null);
    if (this.pendingNew) {
      const n = this.pendingNew;
      this.render([this.header(`${p.name} · connection`), this.ask([n], ' isn\'t in your world yet. Add it as:'), this.typeGrid(c.project, async ty => {
        try { this.pendingTarget = await c.project.createPiece({ name: n, type: ty.id }); this.pendingNew = null; this.drawQuickConn(); } catch (err) { new Notice((err as Error).message); }
      }, { exclude: ['event'] })]);
      return;
    }
    const t = this.pendingTarget!;
    this.render([this.header(`${p.name} → ${t.name}`), this.ask('How is ', [p.name], ' connected to ', [t.name], '?'), this.styleChips(c.project, c.project.data.styles, async st => { await c.project.addConnection(p, t, st.label); new Notice(`${p.name} → ${st.label} → ${t.name}`); this.host.openPiece(c.project, p.id); this.close(); })]);
  }

  /* ───────── scene bar menus ───────── */

  async openScene(project: Project, file: TFile, sceneIndex: number, key: 'pov' | 'when' | 'where', rect: DOMRect) {
    const tl = await project.timeline();
    const scene = tl.scenes.find(s => s.file.path === file.path && s.index === sceneIndex);
    this.reset({ project, file, scene, anchor: rect });
    if (!scene) return;
    const n = scene.order, say = (t: string) => M.say(M.wordsOf(project.data), t);
    if (key === 'pov') {
      this.setAwait('pov');
      const menu = el('div', 'se-menu');
      for (const p of project.all().filter(x => project.behaviour(x) === 'token')) { const b = this.button('', async () => { await project.setSceneMeta(file, sceneIndex, { pov: p.id }); this.close(); }); const dot = el('span', 'se-dot'); dot.style.setProperty('--se-c', project.type(p.type).color); b.append(dot, document.createTextNode(p.name)); menu.append(b); }
      if (!menu.childElementCount) menu.append(el('div', 'se-empty', 'No characters yet.'));
      const clear = el('div', 'se-acts'); if (scene.pov) clear.append(this.button('No POV', async () => { await project.setSceneMeta(file, sceneIndex, { pov: undefined }); this.close(); }, 'se-btn se-btn-ghost se-left'));
      this.render([this.header(say('Scene POV')), el('div', 'se-ask', say(`Whose eyes is scene ${n} through? Pick one, or highlight their name in the text.`)), menu, clear]);
    } else if (key === 'when') this.whenMenu(project, tl.scenes, scene);
    else {
      const nodes: Node[] = [this.header(say('Scene location')), el('div', 'se-ask', say(`Where does scene ${n} happen? Pieces you add in this scene go there automatically.`)), this.miniMap({ mode: 'place', focus: scene.where, onPick: async r => { if (r.place) { await project.setSceneMeta(file, sceneIndex, { where: r.place }); this.close(); } } })];
      if (scene.where) { const r = el('div', 'se-acts'); r.append(this.button('No location', async () => { await project.setSceneMeta(file, sceneIndex, { where: undefined }); this.close(); }, 'se-btn se-btn-ghost se-left')); nodes.push(r); }
      this.render(nodes);
    }
  }
  /** Story time for a scene: continue, start a named moment or a time skip, run alongside another scene, or flash back. */
  private whenMenu(project: Project, all: SceneEntry[], scene: SceneEntry) {
    const f = scene.file, i = scene.index, meta = scene.span.meta;
    const say = (t: string) => M.say(M.wordsOf(project.data), t);
    const set = async (patch: Partial<M.SceneMeta>) => { await project.setSceneMeta(f, i, patch); project.setView(scene.order); this.close(); };
    const big = (title: string, sub: string, fn: () => void, on = false) => { const b = this.button('', fn, `se-bigchoice ${on ? 'is-current' : ''}`); b.append(document.createTextNode(title), el('small', '', sub)); return b; };
    const named = el('div', 'se-newmoment');
    const nameRow = (placeholder: string, skip: boolean) => {
      named.replaceChildren();
      // A time skip says how much time passed; the stretch after it can have its own name (or just use that).
      const name = el('input', 'se-namefield'); name.placeholder = skip ? 'How much time passed? e.g. Two years later' : placeholder;
      const label = skip ? el('input', 'se-namefield se-light') : null; if (label) label.placeholder = 'Name of what follows (optional), e.g. The king\'s visit';
      const note = el('input', 'se-namefield se-light'); note.placeholder = 'Note (optional)';
      const go = async () => {
        const v = name.value.trim(); if (!v) { name.focus(); return; }
        const id = skip ? project.addMoment(label!.value.trim() || v, note.value, v) : project.addMoment(v, note.value);
        await project.startMoment(scene, id); project.setView(scene.order); this.close();
      };
      const row = el('div', 'se-acts'); row.append(note, this.button('Set', () => void go(), 'se-btn mod-cta se-btn-small'));
      named.append(name); if (label) named.append(label); named.append(row);
      named.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); void go(); } };
      if (this.ctx) this.place(this.ctx.anchor); name.focus();
    };
    const earlier = all.filter(s => s.order < scene.order).slice(-12).reverse();
    const pick = (title: string, onPick: (s: SceneEntry) => void) => {
      const menu = el('div', 'se-menu');
      for (const s of earlier) { const b = this.button('', () => onPick(s)); b.append(el('span', 'se-mi', String(s.order)), document.createTextNode(`${s.label}${s.pov ? ' · ' + (project.get(s.pov)?.name ?? '') : ''}`)); menu.append(b); }
      if (!earlier.length) menu.append(el('div', 'se-empty', say('No earlier scenes.')));
      return [el('div', 'se-small', title), menu];
    };
    const view = (mode: 'main' | 'with' | 'flash') => {
      if (mode === 'with') { this.render([this.header('Same time as…'), ...pick(say('Scene ' + scene.order + ' happens at the same time as:'), async s => set({ with: await project.ensureSceneId(s), flash: undefined, moment: undefined }))]); return; }
      if (mode === 'flash') {
        const chips = el('div', 'se-presets');
        for (const b of (project.cachedTimeline()?.t.bands ?? [])) chips.append(this.button(b.moment.label, () => void set({ flash: b.moment.id, with: undefined, moment: undefined }), 'se-preset'));
        this.render([this.header('Flashback to…'), el('div', 'se-small', say('A named moment:')), chips, ...pick(say('…or the time of an earlier scene:'), async s => set({ flash: await project.ensureSceneId(s), with: undefined, moment: undefined }))]);
        return;
      }
      const plain = !meta.moment && !meta.with && !meta.flash;
      const existing = el('div', 'se-presets');
      for (const m of project.data.moments) existing.append(this.button(m.skip ? `⤳ ${M.skipLabel(m)}${M.skipLabel(m) !== m.label ? ' · ' + m.label : ''}` : m.label, async () => { await project.startMoment(scene, m.id); project.setView(scene.order); this.close(); }, `se-preset ${meta.moment === m.id ? 'is-current' : ''}`));
      this.render([this.header(say(`Scene ${scene.order} · when`)),
        big('Continues', say('A little after the scene before (the default).'), () => void set({ moment: undefined, with: undefined, flash: undefined }), plain),
        big(say('Starts a new moment…'), 'Give this point in time a name: “Day 2”, “The Siege”, “Spring 298”.', () => nameRow(say('Moment name, e.g. Day 2'), false), !!meta.moment && !project.moment(meta.moment)?.skip),
        big('Time skip…', 'Jumps ahead: “Two years later”. Shown as a break on the timeline.', () => nameRow('e.g. Two years later', true), !!project.moment(meta.moment)?.skip),
        named,
        big('Same time as…', say('A parallel chapter: happens alongside an earlier scene.'), () => view('with'), !!meta.with),
        big('Flashback to…', say('Goes back to an earlier moment or scene. The map turns sepia.'), () => view('flash'), !!meta.flash),
        ...(project.data.moments.length ? [el('div', 'se-small', say('Or start an existing moment here:')), existing] : []),
      ]);
    };
    view('main');
  }

  /* ───────── shared UI ───────── */

  /** Where most of this scene's people are: the suggested spot for a new piece. */
  private suggest(): { label: string; entry: Omit<M.TrackEntry, 's'>; place: string } | null {
    const c = this.ctx; if (!c?.scene) return null;
    const pr = c.project, sc = c.scene, groups = new Map<string, string[]>();
    for (const x of pr.all()) {
      if (x === this.piece || this.created.includes(x) || pr.behaviour(x) !== 'token') continue;
      const inScene = (sc.id && (pr.data.track[x.id] ?? []).some(e => e.s === sc.id)) || x.id === sc.pov;
      const w = inScene ? pr.where(x, sc.slot) : null;
      if (w?.place) (groups.get(w.place) ?? groups.set(w.place, []).get(w.place)!).push(x.name);
    }
    const best = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    if (best && pr.get(best[0])) {
      const names = best[1], more = names.length > 2 ? ` and ${names.length - 2} more` : '';
      return { label: `With ${names.slice(0, 2).join(' and ')}${more} at ${pr.get(best[0])!.name}`, entry: { place: best[0] }, place: best[0] };
    }
    if (sc.where && pr.get(sc.where) && pr.data.places[sc.where]) return { label: M.say(M.wordsOf(pr.data), `At ${pr.get(sc.where)!.name} (this scene's location)`), entry: { place: sc.where }, place: sc.where };
    return null;
  }

  /**
   * Mini-map. Modes: 'place' picks a place (its pin or anywhere in its area; empty ground names a new one),
   * 'spot' picks where a piece is (inside a place's area or just a spot), 'point' picks a raw point (to put a place).
   * Shows place areas faintly; zooms in on `focus` with a button to see the whole map.
   */
  miniMap(opts: { mode: 'place' | 'spot' | 'point'; onPick: (r: { place?: string; entry?: Omit<M.TrackEntry, 's'>; pt?: M.Point; m: string }) => void | Promise<void>; exclude?: string; focus?: string | null }) {
    const c = this.ctx!, pr = c.project, d = pr.data;
    const mapId = opts.focus && d.places[opts.focus] ? M.mapOfPlace(d, opts.focus) : pr.sceneMap(c.scene);
    const host = el('div', 'se-mini');
    const stage = el('div', 'se-mini-stage'); host.append(stage);
    const img = el('img'); img.alt = '';
    const src = mapSrc(this.host.app, pr.mapImage(mapId)); if (src) img.src = src; else host.addClass('is-blank');
    img.onload = () => { if (img.naturalWidth && img.naturalHeight) host.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`; };
    stage.append(img);
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 1000 1000'); svg.setAttribute('preserveAspectRatio', 'none'); svg.classList.add('se-mini-areas');
    stage.append(svg);
    for (const p of pr.all()) {
      if (pr.behaviour(p) !== 'place' || !d.places[p.id] || p.id === opts.exclude || M.mapOfPlace(d, p.id) !== mapId) continue;
      const poly = document.createElementNS(ns, 'polygon');
      poly.setAttribute('points', M.areaOf(d, p.id)!.map(q => `${q.x * 1000},${q.y * 1000}`).join(' '));
      poly.setAttribute('class', p.id === opts.focus ? 'is-focus' : '');
      svg.append(poly);
      const pin = el('div', `se-mp ${p.id === opts.focus ? 'is-focus' : ''}`); pin.dataset.place = p.id; pin.style.left = `${d.places[p.id].x * 100}%`; pin.style.top = `${d.places[p.id].y * 100}%`;
      pin.append(el('span', '', p.name)); stage.append(pin);
    }
    host.append(el('span', 'se-mini-hint', `${mapId !== M.MAIN_MAP ? pr.mapName(mapId) + ' · ' : ''}${opts.mode === 'point' ? 'Click the spot' : 'Click a location, or anywhere'}`));
    // Zoomed in on the suggested place, with a way out to the whole map.
    const f = opts.focus && d.places[opts.focus] ? d.places[opts.focus] : null;
    let zoomed = !!f;
    const apply = () => {
      const k = zoomed && f ? 3 : 1;
      const tx = Math.min(0, Math.max(1 - k, 0.5 - (f?.x ?? .5) * k)), ty = Math.min(0, Math.max(1 - k, 0.5 - (f?.y ?? .5) * k));
      stage.style.transform = k === 1 ? '' : `translate(${tx * 100}%, ${ty * 100}%) scale(${k})`;
      stage.style.setProperty('--k', String(k));
      if (toggle) toggle.textContent = zoomed ? 'Whole map' : 'Zoom in';
    };
    let toggle: HTMLButtonElement | null = null;
    if (f) { toggle = this.button('', () => { zoomed = !zoomed; apply(); }, 'se-btn se-btn-small se-mini-zoom'); host.append(toggle); }
    apply();
    host.addEventListener('click', e => {
      if ((e.target as HTMLElement).closest('.se-mini-zoom')) return;
      const r = stage.getBoundingClientRect(), pt = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
      if (pt.x < 0 || pt.y < 0 || pt.x > 1 || pt.y > 1) return;
      const pinPlace = ((e.target as HTMLElement).closest('.se-mp') as HTMLElement | null)?.dataset.place;
      if (opts.mode === 'point') { void opts.onPick({ pt, m: mapId }); return; }
      const inArea = pinPlace ?? M.placeAt(d, mapId, pt, pr.isPlaceId, opts.exclude);
      if (opts.mode === 'place' && inArea) { void opts.onPick({ place: inArea, m: mapId }); return; }
      if (opts.mode === 'spot' && (inArea || c.scene?.where)) { void opts.onPick({ entry: pinPlace ? { place: pinPlace } : pr.spot(mapId, pt), m: mapId }); return; }
      // Empty ground: name a new place here (or, for a piece, just leave it at this spot).
      this.pop.querySelector('.se-newplace')?.remove();
      const row = el('div', 'se-acts se-newplace');
      const input = el('input', 'se-namefield'); input.placeholder = opts.mode === 'spot' ? 'Name a new location here (optional)' : 'Name this location (e.g. Farmhouse)';
      const placeType = d.types.find(t => t.behaviour === 'place')?.id ?? 'place';
      const ok = async () => {
        const v = input.value.trim(); if (!v) return;
        try { const np = await pr.createPiece({ name: v, type: placeType }); pr.setPlacePoint(np, pt, mapId); await opts.onPick({ place: np.id, entry: { place: np.id }, m: mapId }); }
        catch (err) { new Notice((err as Error).message); }
      };
      input.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); void ok(); } });
      row.append(input, this.button('Add', () => void ok(), 'se-btn mod-cta se-btn-small'));
      if (opts.mode === 'spot') row.append(this.button('Just this spot', () => void opts.onPick({ entry: { pt, ...(mapId !== M.MAIN_MAP ? { m: mapId } : {}) }, m: mapId }), 'se-btn se-btn-small'));
      host.after(row); input.focus();
      if (this.ctx) this.place(this.ctx.anchor);
    });
    return host;
  }
}

export function mapSrc(app: App, path: string | null): string {
  if (!path) return '';
  const f = app.vault.getAbstractFileByPath(path);
  return f instanceof TFile ? app.vault.getResourcePath(f) : '';
}
