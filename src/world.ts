/**
 * World view: the whole story in one tab.
 *   map (square, left)      where everything is in the scene under the playhead; zoom, pan, select, move, add
 *   column (right)          Pieces tab (catalog + card) · Setup tab (types, connection types, themes, moments, map)
 *   timeline dock (bottom)  scenes in story time, named moments, time skips, events, story lines, playhead
 */
import { FuzzySuggestModal, ItemView, MarkdownView, Modal, Notice, TFile, TFolder, WorkspaceLeaf, setIcon } from 'obsidian';
import { BUILTIN_ICONS, BUILTIN_PREFIX, builtinSrc } from './icons';
import * as M from './model';
import type { Project, SceneEntry, StoryTimeline } from './project';
import { mapSrc } from './capture';
import type StoryEnginePlugin from './main';

export const WORLD_VIEW = 'story-engine-world';
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const svgNs = 'http://www.w3.org/2000/svg';
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'avif']);
const POV_COLORS = ['#f2c94c', '#6ea2f0', '#ff7a8a', '#5fd4a2', '#c792ea', '#ff9f43', '#4dd0e1', '#e57373', '#aed581', '#f48fb1', '#90caf9', '#ffd180'];
/** The right-hand column never gets narrower than this (narrower, its rows would spill sideways). */
const SIDE_MIN = 380;
const LEFT = 120, GAP = 34, ROWS = 3, ROW_H = 20;
/** Drawn width of a time skip's break (you can drag it wider; it's only how the timeline looks). */
const gapOf = (m: M.Moment) => m.gap ?? GAP;
/** Make a connection read as a phrase: “Sibling” → “sibling of”, “Serves” stays “serves”. */
export const phrase = (label: string) => { const l = (label || 'connected to').trim().toLowerCase(); if (l === 'other') return 'connected to'; return /\b(of|in|to|with|for|by|from|at|on)$/.test(l) || /(s|ed)$/.test(l) ? l : `${l} of`; };
/** Two-step button: the first click arms it (red, in place), the second does it. It disarms after a few seconds. */
function confirmClick(btn: HTMLButtonElement, armed: string, run: () => void) {
  const idle = btn.textContent ?? ''; let timer = 0;
  btn.onclick = e => {
    e.stopPropagation();
    if (btn.hasClass('is-sure')) { window.clearTimeout(timer); run(); return; }
    btn.addClass('is-sure'); btn.textContent = armed;
    timer = window.setTimeout(() => { btn.removeClass('is-sure'); btn.textContent = idle; }, 4000);
  };
}
/** A heading that folds what's under it. `closed` holds the keys of folded ones; `force` shows everything (e.g. while searching). */
function foldable(parent: HTMLElement, cls: string, key: string, closed: Set<string>, save: () => void, force = false) {
  const shut = !force && closed.has(key);
  const h = parent.createDiv(`${cls} se-fold`); h.dataset.fold = key;
  const tw = h.createSpan({ cls: 'se-fold-tw', text: shut ? '▸' : '▾' });
  const body = parent.createDiv(`se-fold-body ${shut ? 'is-closed' : ''}`);
  h.onclick = e => {
    if ((e.target as HTMLElement).closest('button, input, select')) return;
    const now = !body.hasClass('is-closed'); body.toggleClass('is-closed', now); tw.textContent = now ? '▸' : '▾';
    if (now) closed.add(key); else closed.delete(key);
    save();
  };
  return { h, body };
}
/** An Obsidian icon, trying newer and older names; falls back to a character if none exists. */
function icon(el: HTMLElement, names: string[], fallback: string) {
  for (const n of names) { setIcon(el, n); if (el.querySelector('svg')) return; }
  el.setText(fallback);
}
const HELP_HTML = `<h4>Controls</h4><ul>
      <li><b>Map:</b> wheel zooms · <kbd>Space</kbd>+drag pans · drag empty map to select · right-click to add · click the zoom % to fit · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes.</li>
      <li><b>Toolbar:</b> location mode · all lines, show pieces, legend · follow scene, follow cursor.</li>
      <li><b>Inside maps:</b> ← goes out one level, ⌂ to the world.</li>
      <li><b>Timeline:</b> <kbd>←</kbd> <kbd>→</kbd> step scenes · <kbd>Shift</kbd>+<kbd>←</kbd> <kbd>→</kbd> jump moments · <kbd>Shift</kbd>+wheel scrolls sideways · <kbd>Ctrl</kbd>+wheel zooms · click “Scene” or “Moment” to rename them.</li>
      <li><b>Caption:</b> double-click it to focus on the POV.</li></ul>`;
const SECTION_LABEL: Record<string, string> = { scenes: 'Scenes (numbered in reading order)', events: 'Events', storylines: 'Story lines' };

interface Member { piece: M.Piece; exact?: { x: number; y: number } }
interface Group { key: string; x: number; y: number; place?: string; projected?: boolean; members: Member[] }
type Drag =
  | { kind: 'pan'; x: number; y: number; tx: number; ty: number }
  | { kind: 'move'; x: number; y: number; moved: boolean; id: string; nodes: { n: HTMLElement; left: string; top: string }[] }
  | { kind: 'box'; x: number; y: number; box: HTMLElement; add: boolean }
  | { kind: 'click'; x: number; y: number }
  | { kind: 'vertex'; i: number }
  | { kind: 'body'; start: M.Point; orig: M.Point[] }
  | { kind: 'scale'; c: M.Point; d0: number; orig: M.Point[] }
  | { kind: 'stack'; key: string; x: number; y: number }
  | { kind: 'roofclick'; id: string; x: number; y: number };

export class WorldView extends ItemView {
  private sel = new Set<string>();
  card: string | null = null;
  private query = '';
  private zoom = 1; private tx = 0; private ty = 0; private SW = 1000; private SH = 1000; private lastMapW = 0; private mapKey = '';
  private px = 0;
  private placing = false;
  private putting: string | null = null;   // a piece waiting to be put on the map with the next click
  private lastSlot: number | null = null; private jump = ''; private lastOrder = 0;
  private space = false; private hover = false; private overView = false; private drag: Drag | null = null;
  private newPin: string | null = null;
  private renderTimer: number | null = null;
  private tl: StoryTimeline | null = null;
  private povColor = new Map<string, string>();
  private mapId: string = M.MAIN_MAP;                 // the map on screen
  private views = new Map<string, { zoom: number; tx: number; ty: number; sw: number; sh: number }>();
  private expanded = new Set<string>();               // crowds spread out by a click
  private openRoofs = new Set<string>();              // roofs opened by a click
  private edit: { kind: 'area' | 'roof'; pid: string; pts: M.Point[]; mode: 'edit' | 'draw' } | null = null;   // a shape being edited
  private editCursor: M.Point | null = null; private snapped: number | null = null;
  private hoverPlace: string | null = null;           // area shown under the pointer
  private areasAll = false;                           // show every area (while dragging a piece)
  private dragShift: M.Point | null = null; private dragPlaces = new Set<string>();   // places being dragged: their areas preview at the new spot
  private r!: {
    head: HTMLElement; upper: HTMLElement; mapcol: HTMLElement; map: HTMLElement; stage: HTMLElement; img: HTMLImageElement; blank: HTMLElement; areas: SVGSVGElement; lines: SVGSVGElement; trail: SVGSVGElement;
    hud: HTMLElement; zoomPct: HTMLElement; piecesBtn: HTMLButtonElement; legendBtn: HTMLButtonElement; crumbs: HTMLElement; placeBtn: HTMLButtonElement; linesBtn: HTMLButtonElement; banner: HTMLElement; tag: HTMLElement; legend: HTMLElement; offmap: HTMLElement;
    splitV: HTMLElement; side: HTMLElement; tabs: HTMLElement; q: HTMLInputElement; pieces: HTMLElement; catPanel: HTMLElement; cat: HTMLElement; splitH: HTMLElement; cardPanel: HTMLElement; cardEl: HTMLElement; setup: HTMLElement;
    splitDock: HTMLElement; dock: HTMLElement; bar: HTMLElement; followMap: HTMLButtonElement; followCur: HTMLButtonElement; ov: HTMLElement; ovc: HTMLCanvasElement; ovWin: HTMLElement; ovHead: HTMLElement; wrap: HTMLElement; tlEl: HTMLElement; help: HTMLElement;
  };

  constructor(leaf: WorkspaceLeaf, private plugin: StoryEnginePlugin) { super(leaf); }
  getViewType() { return WORLD_VIEW; }
  getDisplayText() { return this.project ? `World · ${this.project.name}` : 'World'; }
  getIcon() { return 'map'; }
  get project(): Project | null { return this.plugin.activeProject(); }
  /** The story's words for scene / moment (Setup or the timeline labels change them). */
  private get words() { return M.wordsOf(this.project?.data ?? {}); }
  private say(text: string) { return M.say(this.words, text); }

  /* ───────── skeleton (built once) ───────── */

  async onOpen() {
    const c = this.contentEl;
    c.empty(); c.addClass('se-world'); c.tabIndex = -1;
    const head = c.createDiv('se-w-head');
    const upper = c.createDiv('se-upper');
    const mapcol = upper.createDiv('se-mapcol');
    // The map's toolbar sits on its own row above the map, so it never covers it.
    const hud = mapcol.createDiv('se-hud');
    const map = mapcol.createDiv('se-map'); map.tabIndex = 0;
    const stage = map.createDiv('se-stage');
    const img = stage.createEl('img', { cls: 'se-map-img' }); img.draggable = false; img.alt = '';
    const blank = stage.createDiv('se-map-blank');
    const lines = document.createElementNS(svgNs, 'svg'); lines.classList.add('se-lines');
    const trail = document.createElementNS(svgNs, 'svg'); trail.classList.add('se-trail');
    const areas = document.createElementNS(svgNs, 'svg'); areas.classList.add('se-areas');
    stage.append(areas, lines, trail);
    // Toolbar: icon toggles in three groups (adding · what's shown · following), purple when on.
    const grpL = hud.createDiv('se-hgrp se-hgrp-l'), grpC = hud.createDiv('se-hgrp se-hgrp-c'), grpR = hud.createDiv('se-hgrp se-hgrp-r');
    const tg = (g: HTMLElement, names: string[], label: string, fn: () => void) => {
      const b = g.createEl('button', { cls: 'se-hb se-tg se-ib' }); icon(b, names, label.charAt(0));
      b.setAttribute('aria-label', label); b.onclick = fn; return b;
    };
    const placeBtn = tg(grpL, ['map-pin-plus', 'map-pin'], 'Location mode', () => this.setPlacing(!this.placing));
    const linesBtn = tg(grpC, ['waypoints', 'git-commit'], 'All lines', () => { const p = this.project; if (!p) return; p.data.lines = p.data.lines === 'all' ? 'selected' : 'all'; p.saveSoon(); });
    const piecesBtn = tg(grpC, ['users'], 'Show pieces', () => { const p = this.project; if (!p) return; p.data.ui.showPieces = !p.data.ui.showPieces; p.saveQuiet(); this.renderMap(p); });
    const legendBtn = tg(grpC, ['list'], 'Legend', () => { const p = this.project; if (!p) return; p.data.ui.legend = !p.data.ui.legend; p.saveQuiet(); this.renderMap(p); });
    const followMap = tg(grpR, ['locate-fixed', 'crosshair'], 'Follow scene', () => this.setFollowMap(!this.followMap)); followMap.addClass('se-follow-map');
    const followCur = tg(grpR, ['text-cursor-input', 'text-cursor'], 'Follow cursor', () => { this.plugin.settings.follow = !this.plugin.settings.follow; void this.plugin.saveSettings(); this.renderToggles(); });
    // On the map: where you are (World, or ← ⌂ Winterfell) at the top, the zoom in a corner (click it to fit).
    const crumbs = map.createDiv('se-nav');
    const zoomPct = map.createDiv({ cls: 'se-zoom-pct', text: '100%' }); 
    zoomPct.onclick = () => { this.fit(); this.restackSoon(); this.renderOverlay(); this.renderAreas(); };
    const banner = map.createDiv('se-flashbanner'); banner.hidden = true;
    const tag = map.createDiv('se-maptag');
    tag.addEventListener('dblclick', () => this.focusPov());
    const legend = map.createDiv('se-legend');
    const offmap = map.createDiv('se-offmap');
    const splitV = upper.createDiv('se-split-v');
    const side = upper.createDiv('se-side');
    const tabs = side.createDiv('se-tabs');
    const pieces = side.createDiv('se-pane se-pieces');
    const catPanel = pieces.createDiv('se-panel se-catalog');
    const ph = catPanel.createDiv('se-ph');
    const q = ph.createEl('input', { cls: 'se-q' }); q.placeholder = 'Search'; 
    q.oninput = () => { this.query = q.value.trim().toLowerCase(); const p = this.project; if (p) this.renderCatalog(p); };
    const cat = catPanel.createDiv('se-scroll');
    // “+ New”: a piece that isn't named in the text yet. Top right of the catalog, on its own (not part of a section).
    const nb = catPanel.createEl('button', { cls: 'se-new-piece', text: '+ New' });
    nb.onclick = () => { const p = this.project; if (p) void this.plugin.capture.startManual(p, null, p.current(this.tl), nb.getBoundingClientRect()); };
    const splitH = pieces.createDiv('se-split-h');
    const cardPanel = pieces.createDiv('se-panel se-card');
    const cardEl = cardPanel.createDiv('se-scroll');
    const setup = side.createDiv('se-pane se-setup se-scroll');
    const splitDock = c.createDiv('se-split-dock'); 
    const dock = c.createDiv('se-dock');
    const bar = dock.createDiv('se-bar');
    // The “Scene” and “Moment” labels are your words for them: click one to rename it everywhere.
    const grp = (key: 'scene' | 'moment') => { const g = bar.createDiv('se-grp'); const i = g.createEl('button', { cls: 'se-lbl se-word' }); i.dataset.word = key; i.onclick = () => this.wordBox(i, key); return g; };
    const sg = grp('scene'), mg = grp('moment');
    const db = (g: HTMLElement, text: string, title: string, fn: () => void) => { const b = g.createEl('button', { cls: 'se-hb is-icon', text }); b.dataset.step = title; b.onclick = fn; return b; };
    db(sg, '⏴', 'prev', () => this.stepScene(-1)); db(sg, '⏵', 'next', () => this.stepScene(1));
    db(mg, '⏮', 'prev-moment', () => this.stepMoment(-1)); db(mg, '⏭', 'next-moment', () => this.stepMoment(1));
    const ov = dock.createDiv('se-overview'); 
    const ovc = ov.createEl('canvas'); const ovWin = ov.createDiv('se-ov-window'); const ovHead = ov.createDiv('se-ov-head');
    const wrap = dock.createDiv('se-tlwrap');
    const tlEl = wrap.createDiv('se-tlc');
    const help = c.createDiv('se-help'); help.hidden = true;

    this.r = { head, upper, mapcol, map, stage, img, blank, areas, lines, trail, hud, zoomPct, piecesBtn, legendBtn, crumbs, placeBtn, linesBtn, banner, tag, legend, offmap, splitV, side, tabs, q, pieces, catPanel, cat, splitH, cardPanel, cardEl, setup, splitDock, dock, bar, followMap, followCur, ov, ovc, ovWin, ovHead, wrap, tlEl, help };
    img.onload = () => { const w = img.naturalWidth || 1, h = img.naturalHeight || 1; this.SW = w >= h ? 1000 : 1000 * w / h; this.SH = w >= h ? 1000 * h / w : 1000; this.noteAspect(w / h); this.layoutStage(); this.restoreOrFit(); void this.render(); };

    // The same map button as in the notes' headers: here it closes the World view.
    const close = this.addAction('map', 'Close World', () => this.leaf.detach()); close.addClass('se-world-btn', 'is-active');
    this.plugin.applyLooksSoon();   // light up the World buttons in the notes' headers
    this.wireMap(); this.wireTimeline(); this.wirePanels();
    this.registerDomEvent(document, 'keydown', e => this.onKey(e));
    this.registerDomEvent(document, 'pointerdown', e => { const b = this.contentEl.querySelector('.se-momentbox'); if (b && !b.contains(e.target as Node) && !(e.target as HTMLElement).closest('.se-band')) b.remove(); }, { capture: true });
    c.addEventListener('pointerenter', () => { this.overView = true; }); c.addEventListener('pointerleave', () => { this.overView = false; });
    this.registerDomEvent(document, 'keyup', e => { if (e.code === 'Space') { this.space = false; map.removeClass('is-space'); } });
    this.registerEvent(this.plugin.events.on('changed', () => this.renderSoon()));
    const ro = new ResizeObserver(() => this.onResize());
    ro.observe(c); this.register(() => ro.disconnect());
    this.render();
  }
  onResize() { this.sizeMap(); this.drawOverview(); }
  async onClose() { window.setTimeout(() => this.plugin.applyLooksSoon(), 0); }
  private toggleHelp() {
    const h = this.r.help; h.hidden = !h.hidden; if (h.hidden) return;
    h.innerHTML = this.say(HELP_HTML);
    h.createEl('button', { cls: 'se-hb', text: 'Got it' }).onclick = () => { h.hidden = true; };
  }
  /** Rename “scene” or “moment” everywhere: a small box right under the label (one · more than one · reset). */
  private wordBox(anchor: HTMLElement, key: 'scene' | 'moment') {
    const p = this.project; if (!p) return;
    this.contentEl.querySelector('.se-wordbox')?.remove();
    const many = key === 'scene' ? 'scenes' : 'moments', w = this.words;
    const box = this.contentEl.createDiv('se-wordbox');
    const r = anchor.getBoundingClientRect(), host = this.contentEl.getBoundingClientRect();
    box.style.left = `${r.left - host.left}px`; box.style.top = `${r.bottom - host.top + 4}px`;
    const one = box.createEl('input', { cls: 'se-wb-one' }); one.value = w[key]; 
    const pl = box.createEl('input', { cls: 'se-wb-many' }); pl.value = w[many]; 
    const rs = box.createEl('button', { cls: 'se-x', text: '↺' }); 
    let plTouched = false;
    pl.oninput = () => { plTouched = true; };
    one.oninput = () => { if (!plTouched) pl.value = one.value.trim() ? M.pluralOf(one.value.trim()) : ''; };
    const save = () => {
      const a = one.value.trim(), b = pl.value.trim(), nw = { ...(p.data.words ?? {}) };
      nw[key] = a ? a.charAt(0).toUpperCase() + a.slice(1) : M.DEFAULT_WORDS[key];
      nw[many] = b ? b.charAt(0).toUpperCase() + b.slice(1) : M.pluralOf(nw[key]!);
      if (nw[key] === M.DEFAULT_WORDS[key]) delete nw[key];
      if (nw[many] === M.DEFAULT_WORDS[many]) delete nw[many];
      p.data.words = nw; p.saveSoon();
    };
    const close = (keep: boolean) => { if (keep) save(); box.remove(); document.removeEventListener('pointerdown', outside, true); };
    const outside = (e: PointerEvent) => { if (!box.contains(e.target as Node)) close(true); };
    document.addEventListener('pointerdown', outside, true);
    for (const i of [one, pl]) i.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); close(true); } if (e.key === 'Escape') { e.preventDefault(); close(false); } };
    rs.onclick = () => { one.value = M.DEFAULT_WORDS[key]; pl.value = M.DEFAULT_WORDS[many]; close(true); };
    one.focus(); one.select();
  }

  /** Show a piece's card without stealing focus from the editor. */
  focusPiece(id: string) { this.card = id; this.sel = new Set([id]); this.newPin = id; if (this.project?.data.ui.tab !== 'pieces') this.setTab('pieces'); this.setSideOpen(true, false); this.render(); }

  renderSoon() {
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => { this.renderTimer = null; this.render(); }, 50);
  }
  private shownTitle = '';
  async render() {
    const p = this.project;
    // The tab's title names the story: Obsidian only reads it again when asked.
    const title = this.getDisplayText();
    if (title !== this.shownTitle) { this.shownTitle = title; (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.(); }
    this.renderHead(p);
    this.contentEl.toggleClass('is-empty', !p);
    if (!p) { this.r.upper.style.display = 'none'; this.r.dock.style.display = 'none'; this.r.splitDock.style.display = 'none'; this.r.head.append(this.emptyState()); return; }
    this.r.upper.style.display = ''; this.r.dock.style.display = ''; this.r.splitDock.style.display = '';
    this.tl = await p.timeline();
    if (this.project !== p) return;
    this.applyUi(p);
    this.povColor.clear();
    for (const s of this.tl.scenes) if (s.pov && p.get(s.pov) && !this.povColor.has(s.pov)) this.povColor.set(s.pov, POV_COLORS[this.povColor.size % POV_COLORS.length]);
    const cur = p.current(this.tl);
    // Explain jumps in story time only when reading forward; stepping back is just rewinding.
    if (cur && cur.slot !== this.lastSlot) { this.jump = this.lastSlot == null || cur.order < this.lastOrder ? '' : this.describeJump(this.lastSlot, cur); }
    else if (cur && cur.order !== this.lastOrder && cur.kind === 'flashback') this.jump = '↶ Flashback';
    const moved = !!cur && cur.order !== this.lastOrder;
    this.lastSlot = cur?.slot ?? null; this.lastOrder = cur?.order ?? 0;
    // The map follows the scene (the place it's set in, or where the POV is) unless you've chosen one by hand.
    if (moved) { this.openRoofs.clear(); this.expanded.clear(); }
    // Following the scene: the map the scene is on. Staying: whichever map you're on.
    let want = this.followMap ? p.sceneMap(cur) : this.mapId;
    if (want !== M.MAIN_MAP && !M.subMap(p.data, want)) want = M.MAIN_MAP;
    this.switchMap(want);
    this.renderMapImage(p);
    this.renderMap(p);
    this.renderCatalog(p);
    void this.renderCard(p);
    if (p.data.ui.tab === 'setup' && !this.r.setup.contains(document.activeElement)) this.renderSetup(p);
    this.renderTimeline(p);
    if (moved) this.keepVisible();
  }
  private emptyState() {
    const e = el('div', 'se-empty-state');
    e.append(el('h3', '', 'No story yet'), el('p', '', 'A story is a folder with your chapter notes. Story Engine adds a World folder (one note per piece) and a story-engine.json file next to them.'));
    const b = el('button', 'mod-cta', 'Set up a story…'); b.onclick = () => this.plugin.newStory();
    e.append(b);
    return e;
  }
  private renderHead(p: Project | null) {
    const h = this.r.head; h.empty();
    h.createEl('h2', { cls: 'se-w-title', text: 'World' });
    const pick = h.createEl('select', { cls: 'dropdown se-story-pick' });
    
    for (const pr of this.plugin.projects.values()) { const o = pick.createEl('option', { text: pr.name }); o.value = pr.folder; if (pr === p) o.selected = true; }
    const add = pick.createEl('option', { text: '+ Set up another story…' }); add.value = '__new';
    if (!p) { const o = pick.createEl('option', { text: 'No story' }); o.value = ''; o.selected = true; }
    pick.onchange = () => {
      if (pick.value === '__new') { this.plugin.newStory(); void this.render(); return; }
      this.plugin.setActive(pick.value);
      // Switching stories here also opens the new story's first chapter for writing.
      const p2 = this.plugin.projects.get(pick.value); if (p2) void this.plugin.openFirstChapter(p2);
    };
    const help = h.createEl('button', { cls: 'se-hb is-icon', text: '?' }); help.onclick = () => this.toggleHelp();
    h.createDiv('se-spacer');
    if (!p) return;
    // One button, always in the same place, folds the right-hand column away and back.
    const open = p.data.ui.sideOpen;
    const tb = h.createEl('button', { cls: 'se-hb is-icon se-side-toggle', text: open ? '›' : '‹' });
    tb.onclick = () => this.setSideOpen(!this.project?.data.ui.sideOpen);
  }

  /* ───────── layout: sizes, split bars, tabs ───────── */

  private applyUi(p: Project) {
    const ui = p.data.ui;
    this.r.dock.style.height = `${ui.dock}px`;
    this.r.dock.toggleClass('is-small', ui.dock <= this.minDock() + 4);
    this.r.side.style.width = `${Math.max(SIDE_MIN, ui.side)}px`;
    this.r.side.toggleClass('is-collapsed', !ui.sideOpen);
    this.r.upper.toggleClass('is-side-collapsed', !ui.sideOpen);
    this.r.catPanel.style.flex = `1 1 ${ui.split * 100}%`; this.r.cardPanel.style.flex = `1 1 ${(1 - ui.split) * 100}%`;
    this.r.pieces.toggle(ui.tab === 'pieces'); this.r.setup.toggle(ui.tab === 'setup');
    const w = M.wordsOf(p.data);
    this.r.bar.querySelectorAll<HTMLElement>('.se-word').forEach(i => { i.textContent = w[i.dataset.word as 'scene' | 'moment']; });
    this.r.tabs.empty();
    for (const [k, label] of [['pieces', 'Pieces'], ['setup', 'Setup']] as const) {
      const b = this.r.tabs.createEl('button', { cls: `se-tab ${ui.tab === k ? 'is-on' : ''}`, text: label });
      b.onclick = () => this.setTab(k);
    }
    this.r.tabs.createDiv('se-spacer');
    if (ui.tab === 'pieces') this.r.tabs.append(this.r.q);
    this.sizeMap();
  }
  private setTab(tab: 'pieces' | 'setup') { const p = this.project; if (!p) return; p.data.ui.tab = tab; p.saveQuiet(); this.applyUi(p); if (tab === 'setup') this.renderSetup(p); }
  private setSideOpen(open: boolean, redraw = true) { const p = this.project; if (!p || p.data.ui.sideOpen === open) return; p.data.ui.sideOpen = open; p.saveQuiet(); this.renderHead(p); if (redraw) this.applyUi(p); }
  /** The smallest timeline: the arrows, the strip, and the ruler with the moments and time skips. */
  private minDock() { return (this.r.bar.offsetHeight || 34) + (this.r.ov.offsetHeight || 13) + 7 + 36 + 4; }
  private setDock(h: number) {
    const p = this.project; if (!p) return;
    const total = this.contentEl.clientHeight;
    h = Math.round(Math.max(this.minDock(), Math.min(h, total - 200)));
    p.data.ui.dock = h;
    this.r.dock.style.height = `${h}px`;
    this.r.dock.toggleClass('is-small', h <= this.minDock() + 4);
    requestAnimationFrame(() => { this.sizeMap(); this.drawOverview(); });
  }
  private wirePanels() {
    let lastDock = 0;
    const dragSplit = (h: HTMLElement, onMove: (e: PointerEvent) => void) => {
      h.addEventListener('pointerdown', e => {
        h.setPointerCapture(e.pointerId);
        const mv = (ev: PointerEvent) => onMove(ev);
        const up = () => { h.removeEventListener('pointermove', mv); h.removeEventListener('pointerup', up); this.project?.saveQuiet(); this.sizeMap(); this.drawOverview(); };
        h.addEventListener('pointermove', mv); h.addEventListener('pointerup', up);
      });
    };
    // Remember the size from before a drag or a shrink, so double-click can bring it back.
    this.r.splitDock.addEventListener('pointerdown', () => { if (!this.r.dock.hasClass('is-small')) lastDock = this.r.dock.offsetHeight; });
    this.r.splitDock.addEventListener('dblclick', () => {
      const p = this.project; if (!p) return;
      if (this.r.dock.hasClass('is-small')) this.setDock(lastDock > this.minDock() + 4 ? lastDock : 300);
      else { lastDock = this.r.dock.offsetHeight; this.setDock(0); }
      p.saveQuiet();
    });
    dragSplit(this.r.splitDock, e => { const r = this.contentEl.getBoundingClientRect(); this.setDock(r.bottom - e.clientY - 12); });
    dragSplit(this.r.splitV, e => {
      const p = this.project; if (!p) return;
      const r = this.r.upper.getBoundingClientRect();
      p.data.ui.side = Math.round(Math.max(SIDE_MIN, Math.min(r.right - e.clientX - 5, r.width * 0.6)));
      this.r.side.style.width = `${p.data.ui.side}px`; this.sizeMap();
    });
    dragSplit(this.r.splitH, e => {
      const p = this.project; if (!p) return;
      const r = this.r.pieces.getBoundingClientRect();
      p.data.ui.split = Math.max(0.12, Math.min(0.88, (e.clientY - r.top) / r.height));
      this.r.catPanel.style.flex = `1 1 ${p.data.ui.split * 100}%`; this.r.cardPanel.style.flex = `1 1 ${(1 - p.data.ui.split) * 100}%`;
    });
  }
  private onKey(e: KeyboardEvent) {
    if (!this.r || !this.project) return;
    const t = document.activeElement as HTMLElement | null;
    const typing = !!t && (/INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable);
    if (typing || !(this.contentEl.contains(t) || this.overView)) return;
    if (e.code === 'Space' && this.hover) { if (!e.repeat) { this.space = true; this.r.map.addClass('is-space'); } e.preventDefault(); return; }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const d = e.key === 'ArrowRight' ? 1 : -1; if (e.shiftKey) this.stepMoment(d); else this.stepScene(d); }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
      // Undo / redo changes on the map (moves, areas, roofs). Chapters keep their own undo.
      e.preventDefault(); e.stopPropagation();
      const p = this.project; if (!p || this.edit) return;
      const redo = e.key.toLowerCase() === 'y' || e.shiftKey;
      const ok = redo ? p.redoMap() : p.undoMap();
      new Notice(ok ? (redo ? 'Redone.' : 'Undone.') : (redo ? 'Nothing to redo.' : 'Nothing to undo on the map.'));
      return;
    }
    if (e.key === 'Escape' && this.edit) { this.finishEdit(false); return; }
    if (e.key === 'Escape') { this.closeFloat(); this.setPlacing(false); this.putting = null; this.edit = null; this.expanded.clear(); this.openRoofs.clear(); this.sel.clear(); this.renderMap(this.project); }
  }

  /* ───────── map ───────── */

  private sizeMap() {
    const col = this.r.mapcol, bar = this.r.hud.offsetHeight + 6;
    if (!col.clientWidth || !col.clientHeight) return;
    const s = Math.max(120, Math.floor(Math.min(col.clientWidth, col.clientHeight - bar)));
    this.r.map.style.width = `${s}px`; this.r.map.style.height = `${s}px`; this.r.hud.style.width = `${s}px`;
    if (Math.abs(s - this.lastMapW) > 1) {
      if (this.lastMapW) { const k = s / this.lastMapW; this.zoom *= k; this.tx *= k; this.ty *= k; this.applyView(); } else this.fit();
      this.lastMapW = s; this.renderOverlay(); this.restackSoon();
    }
  }
  private layoutStage() { this.r.stage.style.width = `${this.SW}px`; this.r.stage.style.height = `${this.SH}px`; for (const s of [this.r.areas, this.r.lines, this.r.trail]) s.setAttribute('viewBox', `0 0 ${this.SW} ${this.SH}`); }
  /** How big pieces look: they grow and shrink with the map, within limits, so crowds stay near their place. */
  /** On the world map, below this zoom (% of Fit, set in Setup), every place with people in it folds into its marker. */
  private zoomedOut() { const p = this.project; return this.mapId === M.MAIN_MAP && this.zoomRel() * 100 < (p?.data.ui.groupBelow ?? 200) - 0.5; }
  /** Hovering a folded place (its marker or its area) shows everyone inside at their real spots. */
  private applyPeek() {
    const st = this.r.stage, key = this.hoverPlace ? `p${this.hoverPlace}` : null;
    st.querySelectorAll('.is-peek').forEach(n => n.removeClass('is-peek'));
    if (!key) return;
    st.querySelectorAll(`[data-group="${key}"]`).forEach(n => n.addClass('is-peek'));
  }
  /** A place's icon: a built-in drawing, an image from the vault, or '' (a plain dot in its type's colour). */
  private iconSrc(p: Project, placeId: string) { const ref = p.data.icons[placeId]; return builtinSrc(ref) || (ref ? mapSrc(this.app, ref) : ''); }
  private hotFlag: string | null = null;
  /**
   * Event flags step aside (see-through, and clicks go through them) while the pointer is over a place or a piece,
   * so they never block moving something. A flag answers only when the pointer is on the flag itself and nothing else is under it.
   */
  private quietFlags(cx: number, cy: number) {
    const map = this.r.map;
    const under = document.elementsFromPoint(cx, cy) as HTMLElement[];
    // Only the things you grab (a token's face, a location's icon, a marker's icon) beat a flag; names under a flag don't.
    const busy = under.some(n => n.matches?.('.se-tok:not(.is-folded) .se-f, .se-tok.is-peek .se-f, .se-pin:not(.is-folded-pin) i, .se-group:not(.is-peek) .se-group-icon'));
    let hot: string | null = null;
    if (!busy) for (const fl of Array.from(this.r.stage.querySelectorAll<HTMLElement>('.se-flag'))) {
      const r = fl.querySelector('.se-flag-text')!.getBoundingClientRect();
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) hot = fl.dataset.id!;
    }
    this.hotFlag = hot;
    map.toggleClass('is-flags-quiet', !hot && (busy || !!this.hoverPlace));
    this.r.stage.querySelectorAll('.se-flag').forEach(n => n.toggleClass('is-hot', (n as HTMLElement).dataset.id === hot));
  }
  /** How far in, relative to Fit (1 = the whole map fits). */
  private zoomRel() { return this.zoom / (this.fitZoom() || 1); }
  /** Token size: tiny dots zoomed right out (on the world map), full size when zoomed in. Inside maps start a bit bigger. */
  private tokenScale() { const rel = this.zoomRel() * (this.mapId === M.MAIN_MAP ? 1 : 3); return Math.min(1.3, Math.max(0.22, 0.25 * Math.pow(rel, 0.8))); }
  private applyView() {
    this.r.stage.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.zoom})`;
    this.r.stage.style.setProperty('--inv', String(this.tokenScale() / this.zoom));
    this.r.stage.style.setProperty('--zinv', String(1 / this.zoom));
    // Places (their icons and names) stay readable: a little smaller zoomed out, never tiny.
    // Inside maps are crowded with rooms, so there they grow and shrink with the map more.
    const ts = this.tokenScale(), pin = this.mapId === M.MAIN_MAP ? Math.min(1.15, Math.max(0.8, ts * 2.2)) : Math.min(1.1, Math.max(0.55, ts * 1.1));
    this.r.stage.style.setProperty('--pinv', String(pin / this.zoom));
    this.r.stage.toggleClass('is-tiny', this.tokenScale() < 0.45);
    this.r.zoomPct.textContent = `${Math.round(this.zoomRel() * 100)}%`;
  }
  private fitZoom() { const w = this.r.map.clientWidth || 600, h = this.r.map.clientHeight || 600; return Math.min(w / this.SW, h / this.SH); }
  private fit() { const w = this.r.map.clientWidth || 600, h = this.r.map.clientHeight || 600; this.zoom = this.fitZoom(); this.tx = (w - this.SW * this.zoom) / 2; this.ty = (h - this.SH * this.zoom) / 2; this.applyView(); }
  private zoomAt(next: number, mx: number, my: number) {
    next = Math.min(this.fitZoom() * 24, Math.max(this.fitZoom() * 0.8, next));
    this.tx = mx - (mx - this.tx) * next / this.zoom; this.ty = my - (my - this.ty) * next / this.zoom; this.zoom = next; this.applyView();
    this.restackSoon();
  }
  private restackTimer: number | null = null;
  /** Crowds stack or open up depending on zoom: redraw the pieces once zooming settles. */
  private restackSoon() {
    if (this.restackTimer !== null) window.clearTimeout(this.restackTimer);
    this.restackTimer = window.setTimeout(() => { this.restackTimer = null; const p = this.project; if (p && this.tl) this.renderMap(p); }, 140);
  }
  private zoomBy(f: number) { this.zoomAt(this.zoom * f, this.r.map.clientWidth / 2, this.r.map.clientHeight / 2); this.renderOverlay(); }
  private toStage(cx: number, cy: number) { const r = this.r.map.getBoundingClientRect(); return { x: (cx - r.left - this.tx) / this.zoom, y: (cy - r.top - this.ty) / this.zoom }; }
  /** Stage point → map fraction, kept on the image. */
  private frac(pt: { x: number; y: number }): M.Point { return { x: Math.min(1, Math.max(0, pt.x / this.SW)), y: Math.min(1, Math.max(0, pt.y / this.SH)) }; }
  private onImage(pt: { x: number; y: number }) { return pt.x >= 0 && pt.y >= 0 && pt.x <= this.SW && pt.y <= this.SH; }
  private setPlacing(v: boolean) { this.placing = v; this.r.map.toggleClass('is-placing', v); this.r.placeBtn.toggleClass('is-on', v); }
  private closeFloat() { this.r.map.querySelectorAll('.se-ctx, .se-namebox').forEach(n => n.remove()); }

  /* ── which map is on screen ── */

  /** Switch the map on screen, remembering where you were on the old one. */
  private switchMap(id: string) {
    if (id === this.mapId) return;
    this.views.set(this.mapId, { zoom: this.zoom, tx: this.tx, ty: this.ty, sw: this.SW, sh: this.SH });
    this.mapId = id; this.mapKey = ''; this.openRoofs.clear(); this.expanded.clear();
    this.r.map.addClass('is-switching'); window.setTimeout(() => this.r.map.removeClass('is-switching'), 260);
  }
  private restoreOrFit() {
    const v = this.views.get(this.mapId);
    if (v && v.sw === this.SW && v.sh === this.SH) { this.zoom = v.zoom; this.tx = v.tx; this.ty = v.ty; this.applyView(); } else this.fit();
  }
  /** Open a map by hand (breadcrumb, double-click a place). It stays until the scene changes. */
  openMap(id: string) {
    const p = this.project; if (!p) return;
    // Choosing a map yourself means: stay on it while stepping through scenes.
    if (id !== p.sceneMap(p.current(this.tl)) && this.followMap) { p.data.ui.followMap = false; p.saveQuiet(); }
    this.switchMap(id); void this.render();
  }
  private renderMapImage(p: Project) {
    const src = mapSrc(this.app, p.mapImage(this.mapId));
    const key = `${this.mapId}|${src}`;
    if (key === this.mapKey) return;
    this.mapKey = key;
    this.r.img.toggle(!!src); this.r.blank.toggle(!src);
    this.r.blank.empty();
    if (src) { if (this.r.img.getAttribute('src') !== src) this.r.img.src = src; else this.r.img.onload?.(new Event('load')); }
    else {
      this.SW = this.SH = 1000; this.noteAspect(1); this.layoutStage(); this.restoreOrFit();
      const b = this.r.blank.createDiv('se-blank-hint');
      b.createDiv({ text: this.mapId === M.MAIN_MAP ? 'No map image yet' : `No image for the ${p.mapName(this.mapId)} map yet` });
      const btn = b.createEl('button', { cls: 'se-hb', text: 'Choose a map image…' }); btn.onclick = () => this.pickMap(p, this.mapId);
      b.createDiv({ cls: 'se-small', text: 'Or use this blank sheet.' });
    }
  }
  private pickMap(p: Project, mapId = M.MAIN_MAP) {
    new ImagePicker(this.app, f => { if (mapId === M.MAIN_MAP) p.data.map = f.path; else { const m = M.subMap(p.data, mapId); if (m) m.image = f.path; } p.saveSoon(); }).open();
  }

  /* ── where everything is on this map ── */

  private layout(p: Project) {
    const d = p.data, tl = this.tl!, cur = p.current(tl), slot = cur?.slot ?? 0, map = this.mapId;
    const pins: { piece: M.Piece; x: number; y: number }[] = [];
    const groups = new Map<string, Group>();
    const flags: { piece: M.Piece; x: number; y: number; place?: string; inside?: boolean }[] = [];
    const unplaced: M.Piece[] = [];
    for (const x of p.all()) {
      const b = p.behaviour(x);
      if (b === 'place') { const pt = d.places[x.id]; if (pt && M.mapOfPlace(d, x.id) === map) pins.push({ piece: x, x: pt.x * this.SW, y: pt.y * this.SH }); continue; }
      if (!tl.scenes.length) continue;
      const w = p.where(x, slot); if (!w) continue;
      if (!w.place && !w.pt) { if (b !== 'event') unplaced.push(x); continue; }
      const e = M.entryOn(d, w as M.TrackEntry, map); if (!e) continue;   // somewhere not shown on this map
      // Events are headlines (flags), not pieces.
      if (b === 'event') { flags.push({ piece: x, x: e.pt.x * this.SW, y: e.pt.y * this.SH, place: e.place, inside: e.inside }); continue; }
      const center = e.place ? M.placeOn(d, e.place, map) ?? e.pt : e.pt;
      // A spot of its own (or a loose spot on the map) is exact; otherwise it gets a stable spot inside its place.
      const key = e.place ? `p${e.place}` : `x${x.id}`;
      const g = groups.get(key) ?? groups.set(key, { key, x: center.x * this.SW, y: center.y * this.SH, place: e.place, projected: e.inside, members: [] }).get(key)!;
      g.members.push({ piece: x, exact: e.exact ? { x: e.pt.x * this.SW, y: e.pt.y * this.SH } : undefined });
    }
    // Roofs over buildings on this map. Open when the POV (or the scene's place) is inside, when chosen, or opened by a click.
    const pov = cur?.pov ? p.get(cur.pov) : undefined, povW = pov ? p.where(pov, slot) : null;
    const povAt = povW ? M.entryOn(d, povW as M.TrackEntry, map) : null;
    const sceneAt = cur?.where && d.places[cur.where] ? M.entryOn(d, { place: cur.where }, map) : null;
    const roofs = Object.entries(d.roofs).filter(([pid]) => d.places[pid] && M.mapOfPlace(d, pid) === map && p.get(pid)).map(([pid, r]) => {
      const inside = (pt: M.Point | null | undefined, place?: string) => !!pt && (place === pid || M.inRoof(r, pt));
      const open = this.openRoofs.has(pid) || this.card === pid || this.roofing === pid || inside(povAt?.pt, povAt?.place) || inside(sceneAt?.pt, sceneAt?.place);
      return { pid, r, open, inside };
    });
    const roofOver = (pt: M.Point, place?: string) => roofs.find(o => !o.open && o.inside(pt, place));
    return { pins, groups: [...groups.values()], flags, unplaced, cur, roofs, roofOver };
  }
  /** Fixed spots (stage px) for a group: own spots as they are, the rest at a stable spot inside the place's area. */
  private spotsOf(p: Project, g: Group): Map<string, { x: number; y: number }> {
    const out = new Map<string, { x: number; y: number }>();
    for (const m of g.members) if (m.exact) out.set(m.piece.id, m.exact);
    const autos = g.members.filter(m => !m.exact).map(m => m.piece.id);
    if (autos.length) {
      const c = { x: g.x / this.SW, y: g.y / this.SH };
      const poly = (g.place && M.areaOf(p.data, g.place)) || M.circlePoly(c, M.DEFAULT_RADIUS, 16, this.SW / this.SH);
      const used = g.members.filter(m => m.exact).map(m => ({ x: m.exact!.x / this.SW, y: m.exact!.y / this.SH }));
      for (const [id, q] of M.autoSpots(poly, c, autos, used)) out.set(id, { x: q.x * this.SW, y: q.y * this.SH });
    }
    return out;
  }
  /** At this zoom, would this group's tokens overlap each other or poke out of their place's area? Then it stacks. */
  private crowded(p: Project, g: Group, at: Map<string, { x: number; y: number }>, scale: number) {
    const pts = [...at.values()], r = 12 * scale / this.zoom;   // token radius, in stage px
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) < r * 2.5) return true;
    if (!g.place) return false;
    const poly = M.areaOf(p.data, g.place); if (!poly) return false;
    const inside = (x: number, y: number) => M.inPolygon(poly, { x: x / this.SW, y: y / this.SH });
    return pts.some(q => !inside(q.x - r, q.y) || !inside(q.x + r, q.y) || !inside(q.x, q.y - r) || !inside(q.x, q.y + r));
  }
  private renderMap(p: Project) {
    const st = this.r.stage, tl = this.tl!, d = p.data;
    st.querySelectorAll('.se-pin, .se-tok, .se-stack, .se-group, .se-roof, .se-roof-label, .se-flag').forEach(n => n.remove());
    const { pins, groups, flags, unplaced, cur, roofs, roofOver } = this.layout(p);
    const povId = cur?.pov ?? null, scale = this.tokenScale();
    const at = new Map<string, { x: number; y: number }>();
    const under = new Map<string, string[]>();   // roof place → names hidden under it
    const covered = (sx: number, sy: number, place: string | undefined, name: string) => { const r = roofOver({ x: sx / this.SW, y: sy / this.SH }, place); if (r && name) (under.get(r.pid) ?? under.set(r.pid, []).get(r.pid)!).push(name); return !!r; };
    // Every place always shows (its icon and name), see-through while nobody is there, so nothing pops in and out.
    // A place counts as occupied if anyone is in it, or in a smaller place inside its area (the hall inside the castle).
    const occupied = new Set<string>();
    const busy = groups.filter(g => g.members.length).map(g => ({ place: g.place, pt: { x: g.x / this.SW, y: g.y / this.SH } }));
    for (const { piece } of pins) {
      const poly = M.areaOf(d, piece.id);
      if (busy.some(b => b.place === piece.id || (!!poly && M.inPolygon(poly, b.pt)))) occupied.add(piece.id);
    }
    for (const { piece, x, y } of pins) {
      const hidden = covered(x, y, piece.id, '');   // under a closed roof (its own included: the roof shows the name)
      const door = p.insideMapOf(piece.id), src = this.iconSrc(p, piece.id);
      const el = st.createDiv(`se-pin ${this.sel.has(piece.id) || this.card === piece.id ? 'is-sel' : ''} ${this.newPin === piece.id ? 'is-new' : ''} ${door ? 'is-door' : ''} ${hidden ? 'is-under-roof' : ''} ${src ? 'has-icon' : ''} ${occupied.has(piece.id) ? '' : 'is-empty'}`);
      el.dataset.id = piece.id; el.style.left = `${x}px`; el.style.top = `${y}px`; el.style.setProperty('--c', p.type(piece.type).color);
      const ic = el.createEl('i'); if (src) ic.style.backgroundImage = `url("${src}")`;
      el.createEl('b', { text: piece.name + (door ? ' ⤵' : '') });
      if (door) el.dataset.door = door.id;
      if (!hidden) at.set(piece.id, { x, y });
    }
    // Pieces: each at its fixed spot on the map (zooming only changes their size). Order never changes on click.
    for (const g of groups) {
      g.members.sort((a, b) => Number(b.piece.id === povId) - Number(a.piece.id === povId) || a.piece.name.localeCompare(b.piece.name));
      const spots = this.spotsOf(p, g), n = g.members.length;
      // A place folds into its marker (icon, name, count) when the world map is zoomed out, or when its pieces would
      // overlap or spill out of its area. Hovering it shows everyone at their real spots. Selected pieces stay out.
      const fold = !!g.place && !d.ui.showPieces && !this.expanded.has(g.key) && !covered(g.x, g.y, g.place, '') && (this.zoomedOut() || (n > 2 && this.crowded(p, g, spots, scale)));
      const keep = (m: Member) => this.sel.has(m.piece.id) || this.card === m.piece.id;
      for (const m of g.members) {
        const x = m.piece, isPov = x.id === povId, { x: sx, y: sy } = spots.get(x.id)!, folded = fold && !keep(m);
        // Hidden if its own spot (or, without one, its place) is under a closed roof.
        const hidden = m.exact ? covered(sx, sy, undefined, x.name) : covered(g.x, g.y, g.place, x.name);
        const el = st.createDiv(`se-tok ${this.sel.has(x.id) || this.card === x.id ? 'is-sel' : ''} ${isPov ? 'is-pov' : ''} ${this.newPin === x.id ? 'is-new' : ''} ${hidden ? 'is-under-roof' : ''} ${m.exact ? 'is-exact' : ''} ${folded ? 'is-folded' : ''}`);
        el.dataset.id = x.id; el.dataset.group = g.key;
        if (g.place && !g.projected) el.dataset.place = g.place;
        el.style.setProperty('--c', isPov ? (this.povColor.get(x.id) ?? p.type(x.type).color) : p.type(x.type).color);
        el.style.left = `${sx}px`; el.style.top = `${sy}px`;
        const f = el.createDiv('se-f'); f.createSpan({ text: M.initials(x.name) });
        const rings = x.themes.map(t => d.themes[t]?.color).filter(Boolean).slice(0, 3).map((c, k) => `0 0 0 ${3 + k * 3}px ${c}`);
        if (rings.length) f.style.setProperty('--rings', rings.join(', '));
        el.createDiv({ cls: 'se-n', text: x.name });
        // Folded pieces connect their lines to the place's marker.
        if (!hidden) at.set(x.id, folded ? { x: g.x, y: g.y } : { x: sx, y: sy });
      }
      if (fold) {
        const inside = g.members.filter(m => !keep(m));
        if (!inside.length) continue;
        const pl = p.get(g.place!)!, hasPov = inside.some(m => m.piece.id === povId);
        st.querySelector(`.se-pin[data-id="${g.place}"]`)?.addClass('is-folded-pin');
        const el = st.createDiv(`se-group ${hasPov ? 'is-pov' : ''}`); el.dataset.group = g.key; el.dataset.place = g.place!;
        el.style.left = `${g.x}px`; el.style.top = `${g.y}px`;
        if (hasPov) el.style.setProperty('--c', this.povColor.get(povId!) ?? '#f2c94c');
        el.style.setProperty('--tc', p.type(pl.type).color);
        const icon = el.createDiv('se-group-icon'), src = this.iconSrc(p, g.place!);
        if (src) icon.style.backgroundImage = `url("${src}")`; else icon.addClass('is-default');
        const lbl = el.createDiv('se-group-label'); lbl.createSpan({ text: pl.name }); lbl.createSpan({ cls: 'se-group-n', text: ` +${inside.length}` });
      }
    }
    // Events: a flag with its headline, readable at any zoom. Selecting one rings everyone involved.
    for (const fl of flags) {
      const x = fl.piece;
      const el = st.createDiv(`se-flag ${this.card === x.id || this.sel.has(x.id) ? 'is-sel' : ''} ${this.hotFlag === x.id ? 'is-hot' : ''}`);
      el.dataset.id = x.id; if (fl.place) el.dataset.place = fl.place;
      // An event further inside (e.g. in Winterfell's hall, seen from the world map) flies its flag beside the place's pin.
      if (fl.inside) { el.addClass('is-inside'); el.style.left = `calc(${fl.x}px + 9px * var(--zinv))`; el.style.top = `calc(${fl.y}px - 6px * var(--zinv))`; }
      else { el.style.left = `${fl.x}px`; el.style.top = `${fl.y}px`; }
      el.style.setProperty('--c', p.type(x.type).color);
      el.createDiv({ cls: 'se-flag-text', text: `⚑ ${x.name}` }); el.createDiv('se-flag-stem');
      at.set(x.id, { x: fl.x, y: fl.y });
    }
    const ev = p.get(this.card);
    if (ev && p.behaviour(ev) === 'event') for (const c of ev.connections) { const t = p.find(c.target); if (t) st.querySelector(`.se-tok[data-id="${t.id}"]`)?.addClass('is-involved'); }
    // Roofs over buildings (any shape).
    for (const { pid, r, open } of roofs) {
      const shape = M.roofShape(r), xs = shape.map(q => q.x), ys = shape.map(q => q.y);
      const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(...xs) - x0 || 0.001, h = Math.max(...ys) - y0 || 0.001;
      const el = st.createDiv(`se-roof ${open ? 'is-open' : ''} ${r.image ? 'has-image' : ''} ${this.roofing === pid ? 'is-editing' : ''}`);
      el.dataset.roof = pid;
      Object.assign(el.style, { left: `${x0 * this.SW}px`, top: `${y0 * this.SH}px`, width: `${w * this.SW}px`, height: `${h * this.SH}px` });
      if (r.pts) el.style.clipPath = `polygon(${shape.map(q => `${((q.x - x0) / w * 100).toFixed(2)}% ${((q.y - y0) / h * 100).toFixed(2)}%`).join(', ')})`;
      const src = r.image ? mapSrc(this.app, r.image) : '';
      if (src) el.style.backgroundImage = `url("${src}")`;
      const who = under.get(pid) ?? [];
      // The name sits on top of the roof, outside its shape (so a round roof doesn't clip it).
      const lbl = st.createDiv(`se-roof-label ${open ? 'is-open' : ''}`); lbl.createSpan({ text: p.get(pid)!.name });
      Object.assign(lbl.style, { left: `${(x0 + w / 2) * this.SW}px`, top: `${(y0 + h / 2) * this.SH}px` });
      lbl.dataset.roofLabel = pid;
      if (who.length) lbl.createSpan({ cls: 'se-roof-n', text: ` · ${who.length} inside` });
    }
    this.positions = at;
    this.newPin = null;
    // Where you are: “World”, or ← (one level out) · ⌂ (the world) · the map's name.
    const nav = this.r.crumbs; nav.empty();
    const path = M.mapPath(d, this.mapId);
    if (path.length > 1) {
      const out = nav.createEl('button', { cls: 'se-nav-b' }); icon(out, ['arrow-left'], '←'); out.setAttribute('aria-label', 'Out one level');
      out.onclick = () => this.openMap(path[path.length - 2]);
      const home = nav.createEl('button', { cls: 'se-nav-b' }); icon(home, ['house', 'home'], '⌂'); home.setAttribute('aria-label', 'World map'); home.onclick = () => this.openMap(M.MAIN_MAP);
    }
    nav.createSpan({ cls: 'se-nav-name', text: path.length > 1 ? p.mapName(this.mapId) : 'World' });
    // Flashback: the map turns sepia (except the POV piece) and says where in time we are.
    const flash = cur?.kind === 'flashback';
    this.r.map.toggleClass('is-flashback', !!flash);
    const bn = this.r.banner; bn.empty(); bn.hidden = !flash;
    if (flash && cur) {
      const ref = cur.ref ? tl.scenes[cur.ref - 1] : tl.scenes.filter(s => s.slot === cur.slot && s.kind !== 'flashback').sort((a, b) => a.order - b.order)[0];
      bn.createEl('b', { text: 'FLASHBACK' });
      bn.appendText(` to ${cur.band?.moment.label ?? (ref ? 'the time of ' + ref.label : 'an earlier time')}`);
      if (ref) { bn.appendText(' · first told in '); const a = bn.createEl('a', { text: `${ref.label}${ref.pov && p.get(ref.pov) ? ` (${p.get(ref.pov)!.name}'s POV)` : ''}` }); a.onclick = () => p.setView(ref.order); }
      if (cur.pov && p.get(cur.pov)) { bn.createEl('br'); bn.createSpan({ cls: 'se-mut', text: `Now seen through ${p.get(cur.pov)!.name}'s eyes` }); }
    }
    this.renderHint(p, unplaced);
    this.applyPeek();
    this.renderCaption(p);
    this.renderToggles();
    this.renderOverlay();
  }
  /** Toolbar toggles: purple when on. */
  private renderToggles() {
    const p = this.project; if (!p) return;
    const d = p.data, follow = this.followMap;
    const set = (b: HTMLElement, on: boolean, label: string) => { b.toggleClass('is-on', on); b.setAttribute('aria-label', label); };
    set(this.r.followMap, follow, this.say('Follow scene'));
    this.r.followMap.toggle(d.maps.length > 0);
    set(this.r.followCur, this.plugin.settings.follow, 'Follow cursor');
    set(this.r.linesBtn, d.lines === 'all', 'All lines');
    set(this.r.piecesBtn, !!d.ui.showPieces, 'Show pieces');
    set(this.r.legendBtn, !!d.ui.legend, 'Legend');
  }
  /** The strip at the bottom-left of the map: what's waiting (a piece to put down, a shape being edited). */
  private renderHint(p: Project, unplaced: M.Piece[] = []) {
    const off = this.r.offmap; off.empty();
    const ed = this.edit;
    off.toggle(unplaced.length > 0 || !!this.putting || !!ed);
    this.r.map.toggleClass('is-putting', !!this.putting || ed?.mode === 'draw');
    this.r.map.toggleClass('is-editing', !!ed);
    if (ed) {
      const name = p.get(ed.pid)?.name ?? 'it', what = ed.kind === 'roof' ? `${name}'s roof` : `${name}'s area`;
      off.createEl('b', { text: what });
      off.appendText(ed.mode === 'draw' ? ' · click around the border, then click the first point to close it' : ' · drag points · click ＋ on an edge to add one · right-click a point to remove it · drag inside to move · Shift: no snapping');
      const acts = off.createDiv('se-hint-acts');
      const btn = (t: string, fn: () => void, cls = '') => { const b = acts.createEl('button', { cls: `se-hb ${cls}`, text: t }); b.onclick = ev => { ev.stopPropagation(); fn(); }; };
      if (ed.mode === 'edit' || ed.pts.length >= 3) btn('Done', () => this.finishEdit(true), 'is-on');
      btn('Cancel', () => this.finishEdit(false));
      if (ed.kind === 'area') btn('Reset to a circle', () => { p.checkpoint(); p.setArea(ed.pid, null); this.edit = null; this.renderMap(p); });
      return;
    }
    if (this.putting) off.appendText(`Click the map to put ${p.get(this.putting)?.name ?? 'it'} there · Esc to cancel`);
    else if (unplaced.length) {
      off.appendText(this.say('In this scene, not on the map: '));
      unplaced.forEach((u, i) => { const b = off.createEl('b', { text: u.name }); b.onclick = () => { this.putting = u.id; this.renderMap(p); }; if (i < unplaced.length - 1) off.appendText(', '); });
    }
  }
  /** Remember the picture's shape, so default place circles are round on it. */
  private noteAspect(a: number) {
    const p = this.project; if (!p || !Number.isFinite(a)) return;
    const d = p.data, had = d.aspects?.[this.mapId];
    if (had && Math.abs(had - a) < 0.001) return;
    d.aspects = { ...(d.aspects ?? {}), [this.mapId]: a }; p.saveQuiet();
  }
  private positions = new Map<string, { x: number; y: number }>();

  /** Place areas: shown while dragging a piece, in Place mode, on hover and for the selected place; and the shape being edited. */
  private renderAreas() {
    const p = this.project, svg = this.r.areas; if (!p) return;
    svg.replaceChildren();
    const d = p.data, map = this.mapId, z = 1 / this.zoom;
    const mk = (tag: string, attrs: Record<string, string | number>) => { const n = document.createElementNS(svgNs, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); svg.append(n); return n; };
    const ptsAttr = (pts: M.Point[]) => pts.map(q => `${(q.x * this.SW).toFixed(1)},${(q.y * this.SH).toFixed(1)}`).join(' ');
    const ed = this.edit;
    const all = ed || this.areasAll || this.placing;
    const ids = Object.keys(d.places).filter(id => M.mapOfPlace(d, id) === map && p.isPlaceId(id));
    for (const id of ids) {
      if (ed && ed.kind === 'area' && ed.pid === id) continue;
      const moving = !!this.dragShift && this.dragPlaces.has(id);
      const focus = id === this.hoverPlace || id === this.card || moving;
      if (!all && !focus) continue;
      const sh = moving ? this.dragShift! : { x: 0, y: 0 };
      const poly = M.areaOf(d, id)!.map(q => ({ x: q.x + sh.x, y: q.y + sh.y }));
      const c = p.type(p.get(id)!.type).color;
      mk('polygon', { points: ptsAttr(poly), fill: c, 'fill-opacity': focus ? 0.16 : 0.06, stroke: c, 'stroke-opacity': focus ? 0.9 : 0.45, 'stroke-width': (focus ? 2 : 1.2) * z, 'stroke-dasharray': d.areas[id] ? '' : `${5 * z} ${4 * z}` });
      if (focus && this.areasAll) { const t = mk('text', { x: d.places[id].x * this.SW, y: d.places[id].y * this.SH - 22 * z, 'font-size': 12 * z, 'text-anchor': 'middle', class: 'se-area-label' }); t.textContent = p.get(id)!.name; }
    }
    if (ed && ed.kind === 'roof') for (const [pid, r] of Object.entries(d.roofs)) if (pid !== ed.pid && M.mapOfPlace(d, pid) === map) mk('polygon', { points: ptsAttr(M.roofShape(r)), fill: 'none', stroke: '#c9a46b', 'stroke-opacity': .6, 'stroke-width': 1.2 * z });
    if (!ed) return;
    // The shape being edited, with handles.
    const pts = ed.pts, open = ed.mode === 'draw';
    if (pts.length) {
      const line = open ? [...pts, ...(this.editCursor ? [this.editCursor] : [])] : pts;
      mk(open ? 'polyline' : 'polygon', { points: ptsAttr(line), fill: open ? 'none' : '#f2c94c', 'fill-opacity': .14, stroke: '#f2c94c', 'stroke-width': 2.2 * z, class: open ? '' : 'se-edit-body' });
    }
    if (!open) pts.forEach((a, i) => {
      const b = pts[(i + 1) % pts.length];
      const m = mk('g', { 'data-mi': i, class: 'se-h se-hm', transform: `translate(${((a.x + b.x) / 2 * this.SW).toFixed(1)} ${((a.y + b.y) / 2 * this.SH).toFixed(1)})` });
      m.append(Object.assign(document.createElementNS(svgNs, 'circle'), {}));
      (m.firstChild as SVGCircleElement).setAttribute('r', String(6 * z));
      const plus = document.createElementNS(svgNs, 'path'); plus.setAttribute('d', `M${-3 * z} 0 H${3 * z} M0 ${-3 * z} V${3 * z}`); m.append(plus);
    });
    pts.forEach((q, i) => mk('circle', { cx: q.x * this.SW, cy: q.y * this.SH, r: (i === 0 && open ? 8 : 6.5) * z, 'data-vi': i, class: `se-h se-hv ${this.snapped === i ? 'is-snapped' : ''} ${i === 0 && open ? 'is-first' : ''}`, 'stroke-width': 2 * z }));
    if (!open && pts.length >= 3) {
      const xs = pts.map(q => q.x), ys = pts.map(q => q.y);
      mk('rect', { x: Math.max(...xs) * this.SW + 6 * z, y: Math.max(...ys) * this.SH + 6 * z, width: 11 * z, height: 11 * z, 'data-scale': 1, class: 'se-h se-hs', 'stroke-width': 2 * z });
    }
  }

  /** Connection lines, the selected piece's journey, and the legend (only what's visible). Redrawn on zoom. */
  private renderOverlay() {
    const p = this.project; if (!p || !this.tl) return;
    const inv = 1 / this.zoom, at = this.positions, d = p.data;
    const lines = this.r.lines; lines.replaceChildren();
    const defs = document.createElementNS(svgNs, 'defs'); lines.append(defs);
    const used = new Map<string, M.LineStyle>();
    const mk = (tag: string, attrs: Record<string, string | number>) => { const n = document.createElementNS(svgNs, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); return n; };
    for (const a of p.all()) for (const c of a.connections) {
      const b = p.find(c.target); if (!b) continue;
      if (d.lines === 'selected' && this.card !== a.id && this.card !== b.id && !this.sel.has(a.id) && !this.sel.has(b.id)) continue;
      const pa = at.get(a.id), pb = at.get(b.id); if (!pa || !pb) continue;
      const st = p.style(c.label);
      if (!used.has(st.id)) {
        used.set(st.id, st);
        const m = mk('marker', { id: `se-ar-${st.id}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
        m.append(mk('path', { d: 'M0,0 L10,5 L0,10 z', fill: st.color })); defs.append(m);
      }
      if (Math.hypot(pb.x - pa.x, pb.y - pa.y) < 0.5) continue;
      const len = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1, r = 15 * this.tokenScale() * inv, ux = (pb.x - pa.x) / len, uy = (pb.y - pa.y) / len;
      const line = mk('line', { x1: pa.x + ux * r, y1: pa.y + uy * r, x2: pb.x - ux * r, y2: pb.y - uy * r, stroke: st.color, 'stroke-width': st.width * inv, 'stroke-linecap': 'round', opacity: 0.92 });
      if (M.DASH[st.dash]) line.setAttribute('stroke-dasharray', M.DASH[st.dash].split(' ').map(v => String(Number(v) * inv)).join(' '));
      if (st.arrow !== 'none') line.setAttribute('marker-end', `url(#se-ar-${st.id})`);
      if (st.arrow === 'both') line.setAttribute('marker-start', `url(#se-ar-${st.id})`);
      lines.append(line);
      if (len / inv > 80) { const tx = mk('text', { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 - 5 * inv, 'font-size': 10.5 * inv, 'stroke-width': 3 * inv }); tx.textContent = c.label || st.label; lines.append(tx); }
    }
    // Journey of the selected piece on this map: past solid, future faint.
    const trail = this.r.trail; trail.replaceChildren();
    const x = p.get(this.card), tl = this.tl, cur = p.current(tl);
    if (x && p.behaviour(x) === 'token' && tl.scenes.length) {
      const pts: { s: number; x: number; y: number }[] = []; let last = '';
      for (let s = 0; s < tl.t.slots; s++) {
        const w = p.where(x, s); if (!w) continue;
        const e = M.entryOn(d, w as M.TrackEntry, this.mapId); if (!e) continue;
        const key = e.place ?? `${e.pt.x},${e.pt.y}`; if (key === last) continue; last = key;
        pts.push({ s, x: e.pt.x * this.SW, y: e.pt.y * this.SH });
      }
      if (pts.length > 1) {
        const color = p.type(x.type).color, now = cur?.slot ?? 0;
        let past = '', fut = '';
        for (let k = 1; k < pts.length; k++) { const seg = `M${pts[k - 1].x} ${pts[k - 1].y} L${pts[k].x} ${pts[k].y}`; if (pts[k].s <= now) past += seg; else fut += seg; }
        trail.append(mk('path', { d: fut || 'M0 0', fill: 'none', stroke: color, 'stroke-width': 1.6 * inv, 'stroke-dasharray': `${4 * inv} ${6 * inv}`, opacity: 0.4 }));
        trail.append(mk('path', { d: past || 'M0 0', fill: 'none', stroke: color, 'stroke-width': 3.2 * inv, opacity: 0.95 }));
        const firstFuture = pts.findIndex(q => q.s > now);
        pts.forEach((q, k) => {
          if (firstFuture >= 0 && k > firstFuture + 2) return;
          const isPast = q.s <= now;
          trail.append(mk('circle', { cx: q.x, cy: q.y, r: 8 * inv, fill: isPast ? color : '#000a', stroke: color, 'stroke-width': 2 * inv }));
          const t = mk('text', { x: q.x, y: q.y + 3.5 * inv, 'text-anchor': 'middle', 'font-size': 9.5 * inv, 'font-weight': 700, fill: isPast ? '#111' : color }); t.textContent = String(k + 1); trail.append(t);
        });
      }
    }
    // Legend: only what's on the map now.
    const lg = this.r.legend; lg.empty();
    for (const st of used.values()) {
      const r = lg.createDiv('se-lg-row');
      const sv = mk('svg', { width: 22, height: 8 }); const l = mk('line', { x1: 2, y1: 4, x2: 20, y2: 4, stroke: st.color, 'stroke-width': 2, 'stroke-linecap': 'round' });
      if (M.DASH[st.dash]) l.setAttribute('stroke-dasharray', M.DASH[st.dash]); sv.append(l); r.append(sv); r.appendText(st.label);
    }
    const themes = new Set<string>();
    for (const id of at.keys()) for (const t of p.get(id)?.themes ?? []) themes.add(t);
    for (const t of themes) { const r = lg.createDiv('se-lg-row'); const i = r.createEl('i', { cls: 'se-lg-theme' }); i.style.setProperty('--c', d.themes[t]?.color ?? '#fff'); r.appendText(t); if (d.themes[t]?.meaning) r.title = d.themes[t].meaning; }
    lg.toggle(lg.childElementCount > 0 && !!d.ui.legend);
  }

  private wireMap() {
    const map = this.r.map;
    map.addEventListener('pointerenter', () => { this.hover = true; });
    map.addEventListener('pointerleave', () => { this.hover = false; map.removeClass('is-flags-quiet'); if (this.hoverPlace) { this.hoverPlace = null; this.renderAreas(); this.applyPeek(); } });
    let raf = 0;
    map.addEventListener('wheel', e => {
      e.preventDefault();
      const r = map.getBoundingClientRect();
      this.zoomAt(this.zoom * Math.exp(-e.deltaY * 0.0016), e.clientX - r.left, e.clientY - r.top);
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; this.renderOverlay(); this.renderAreas(); });
    }, { passive: false });
    map.addEventListener('pointerdown', e => {
      const t = e.target as HTMLElement;
      if (t.closest('.se-hud, .se-ctx, .se-namebox, .se-flashbanner, .se-offmap, .se-legend, .se-maptag, .se-follow-map, .se-zoom-pct, .se-nav-b')) return;
      this.closeFloat();
      map.focus({ preventScroll: true });
      if (e.button === 2) return;
      map.setPointerCapture(e.pointerId);
      if (this.space || e.button === 1) { this.drag = { kind: 'pan', x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty }; map.addClass('is-panning'); e.preventDefault(); return; }
      if (this.edit) { e.preventDefault(); this.editDown(e, t); return; }
      if (this.putting || this.placing) { this.drag = { kind: 'click', x: e.clientX, y: e.clientY }; return; }
      const stack = t.closest('.se-group') as HTMLElement | null;
      if (stack) { this.drag = { kind: 'stack', key: stack.dataset.group!, x: e.clientX, y: e.clientY }; return; }
      const roof = t.closest('.se-roof:not(.is-open)') as HTMLElement | null;
      if (roof) { this.drag = { kind: 'roofclick', id: roof.dataset.roof!, x: e.clientX, y: e.clientY }; return; }
      const node = t.closest('.se-tok, .se-pin, .se-flag') as HTMLElement | null;
      if (node?.dataset.id) {
        const id = node.dataset.id;
        if (e.shiftKey) { if (this.sel.has(id)) this.sel.delete(id); else this.sel.add(id); this.refreshSelection(); return; }
        if (!this.sel.has(id)) this.sel = new Set([id]);
        // A dragged place takes its people, its events and its roof along (shown live).
        const places = new Set([...this.sel].filter(x => this.project?.isPlaceId(x)));
        this.dragPlaces = places;
        const nodes = [...this.r.stage.querySelectorAll<HTMLElement>('.se-tok, .se-pin, .se-flag, .se-roof, .se-roof-label')]
          .filter(n => this.sel.has(n.dataset.id!) || places.has(n.dataset.place!) || places.has(n.dataset.roof!) || places.has(n.dataset.roofLabel!))
          .map(n => ({ n, left: n.style.left, top: n.style.top }));
        this.drag = { kind: 'move', x: e.clientX, y: e.clientY, moved: false, id, nodes };
        return;
      }
      const r = map.getBoundingClientRect(), box = map.createDiv('se-marquee');
      this.drag = { kind: 'box', x: e.clientX - r.left, y: e.clientY - r.top, box, add: e.shiftKey };
    });
    map.addEventListener('pointermove', e => {
      const d = this.drag;
      const f = () => { const s = this.toStage(e.clientX, e.clientY); return { x: s.x / this.SW, y: s.y / this.SH }; };
      if (!d) {
        if (this.edit?.mode === 'draw') { this.editCursor = this.snap(f(), e.shiftKey).pt; this.renderAreas(); return; }
        const p = this.project; if (!p || this.edit) return;
        const mk = (e.target as HTMLElement).closest?.('.se-group') as HTMLElement | null;
        const h = mk?.dataset.place ?? M.placeAt(p.data, this.mapId, f(), p.isPlaceId);
        if (h !== this.hoverPlace) { this.hoverPlace = h; this.renderAreas(); this.applyPeek(); }
        this.quietFlags(e.clientX, e.clientY);
        return;
      }
      if (d.kind === 'pan') { this.tx = d.tx + e.clientX - d.x; this.ty = d.ty + e.clientY - d.y; this.applyView(); return; }
      if (d.kind === 'vertex' && this.edit) { const s = this.snap(f(), e.shiftKey, d.i); this.edit.pts[d.i] = s.pt; this.snapped = s.snapped ? d.i : null; this.renderAreas(); return; }
      if (d.kind === 'body' && this.edit) { const q = f(), dx = q.x - d.start.x, dy = q.y - d.start.y; this.edit.pts = d.orig.map(o => ({ x: o.x + dx, y: o.y + dy })); this.renderAreas(); return; }
      if (d.kind === 'scale' && this.edit) { const q = f(), k = Math.max(0.1, Math.hypot(q.x - d.c.x, q.y - d.c.y) / d.d0); this.edit.pts = d.orig.map(o => ({ x: d.c.x + (o.x - d.c.x) * k, y: d.c.y + (o.y - d.c.y) * k })); this.renderAreas(); return; }
      if (d.kind === 'move') {
        const dx = (e.clientX - d.x) / this.zoom, dy = (e.clientY - d.y) / this.zoom;
        if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) {
          d.moved = true; this.areasAll = true; this.r.map.addClass('is-moving');
          const n = [...this.sel].length;
          if (n > 1) { this.r.offmap.empty(); this.r.offmap.toggle(true); this.r.offmap.createEl('b', { text: `Moving ${n} pieces` }); this.r.offmap.appendText(' (everything selected). Click one piece first to move just that one.'); }
        }
        if (d.moved) {
          this.dragShift = { x: dx / this.SW, y: dy / this.SH };
          for (const o of d.nodes) { o.n.style.left = `calc(${o.left} + ${dx}px)`; o.n.style.top = `calc(${o.top} + ${dy}px)`; }
          const p = this.project, h = p ? M.placeAt(p.data, this.mapId, f(), p.isPlaceId, d.id) : null;
          if (h !== this.hoverPlace || this.areasAll) { this.hoverPlace = h; this.renderAreas(); }
        }
        return;
      }
      if (d.kind === 'box') { const r = map.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top; Object.assign(d.box.style, { left: `${Math.min(x, d.x)}px`, top: `${Math.min(y, d.y)}px`, width: `${Math.abs(x - d.x)}px`, height: `${Math.abs(y - d.y)}px` }); }
    });
    map.addEventListener('pointerup', e => void this.mapUp(e));
    map.addEventListener('contextmenu', e => {
      e.preventDefault(); this.closeFloat();
      const p = this.project; if (!p) return;
      if (this.edit) {
        // Right-click a point to remove it (a shape keeps at least three).
        const vi = (e.target as Element).closest?.('[data-vi]')?.getAttribute('data-vi');
        if (vi != null && this.edit.pts.length > 3) { this.edit.pts.splice(Number(vi), 1); this.renderAreas(); }
        return;
      }
      const pt = this.toStage(e.clientX, e.clientY);
      if (!this.onImage(pt)) return;
      const r = map.getBoundingClientRect(), m = map.createDiv('se-ctx');
      m.style.left = `${Math.min(e.clientX - r.left, r.width - 250)}px`; m.style.top = `${Math.min(e.clientY - r.top, r.height - 240)}px`;
      const item = (text: string, fn: () => void) => { const b = m.createEl('button', { text }); b.onclick = () => { m.remove(); fn(); }; };
      const hit = (e.target as HTMLElement).closest('.se-pin, .se-roof, .se-group') as HTMLElement | null;
      const pid = hit?.dataset.id ?? hit?.dataset.roof ?? hit?.dataset.place ?? M.placeAt(p.data, this.mapId, { x: pt.x / this.SW, y: pt.y / this.SH }, p.isPlaceId);
      const pl = pid ? p.get(pid) : undefined;
      if (pl) {
        // A place: its area, its inside map and its roof.
        m.createDiv({ cls: 'se-ctx-h', text: pl.name });
        item(p.data.icons[pl.id] ? 'Change its icon…' : 'Choose an icon…', () => this.pickIcon(p, pl.id));
        item('Edit its area', () => this.startEdit('area', pl.id, 'edit'));
        item('Draw a new area…', () => this.startEdit('area', pl.id, 'draw'));
        if (p.data.areas[pl.id]) item('Reset its area to a circle', () => { p.checkpoint(); p.setArea(pl.id, null); });
        const inside = p.insideMapOf(pl.id);
        if (inside) item(`⤵ Go inside (${inside.name})`, () => this.openMap(inside.id));
        else item(`＋ Make an inside map for ${pl.name}…`, () => this.makeInsideMap(pl));
        const roof = p.data.roofs[pl.id];
        if (roof) {
          item('Edit the roof\'s shape', () => this.startEdit('roof', pl.id, 'edit'));
          item('Roof picture…', () => new ImagePicker(this.app, f => { const rf = p.data.roofs[pl.id]; if (rf) p.setRoof(pl.id, { ...rf, image: f.path }); }).open());
          item('Remove the roof', () => { p.checkpoint(); p.setRoof(pl.id, null); });
        } else item(`Draw a roof over ${pl.name}…`, () => this.startEdit('roof', pl.id, 'draw'));
        m.createEl('hr');
      }
      const placeType = p.data.types.find(t => t.behaviour === 'place');
      const charType = p.data.types.find(t => t.id === 'character') ?? p.data.types.find(t => t.behaviour === 'token');
      if (placeType) item(`＋ New ${placeType.label.toLowerCase()} here`, () => this.askName(e.clientX, e.clientY, placeType.id));
      if (charType) item(`＋ New ${charType.label.toLowerCase()} here`, () => this.askName(e.clientX, e.clientY, charType.id));
      item('＋ Something else here…', () => this.askName(e.clientX, e.clientY, null));
      m.createEl('hr');
      item(this.placing ? 'Leave location mode' : 'Location mode: add a location with every click', () => this.setPlacing(!this.placing));
    });
  }

  /* ── editing a place's area or a roof ── */

  private get roofing() { return this.edit?.kind === 'roof' ? this.edit.pid : null; }
  /** Clicking a stack zooms onto its place until everyone fits; if they still don't at the closest zoom, it spreads them out there. */
  private openStack(p: Project, key: string) {
    const pid = key.startsWith('p') ? key.slice(1) : null;
    const poly = pid && M.mapOfPlace(p.data, pid) === this.mapId ? M.areaOf(p.data, pid) : null;
    if (!poly) { this.expanded.add(key); this.renderMap(p); return; }
    const xs = poly.map(q => q.x * this.SW), ys = poly.map(q => q.y * this.SH);
    const bw = Math.max(...xs) - Math.min(...xs) || 1, bh = Math.max(...ys) - Math.min(...ys) || 1;
    const W = this.r.map.clientWidth, H = this.r.map.clientHeight, max = this.fitZoom() * 24;
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    const g = this.layout(p).groups.find(x => x.key === key);
    const spots = g ? this.spotsOf(p, g) : new Map<string, { x: number; y: number }>();
    // Zoom in until they stop overlapping (the same test that stacked them), or as far as the map goes.
    let z = Math.min(max, Math.max(this.zoom * 1.2, Math.min(W / (bw * 1.8), H / (bh * 1.8))));
    for (let i = 0; i < 30; i++) { this.zoom = z; if (!g || ((!this.crowded(p, g, spots, this.tokenScale()) || (g.members.length <= 2)) && !this.zoomedOut()) || z >= max) break; z = Math.min(max, z * 1.2); }
    this.tx = W / 2 - cx * z; this.ty = H / 2 - cy * z; this.applyView();
    if (g && (this.zoomedOut() || (g.members.length > 2 && this.crowded(p, g, spots, this.tokenScale())))) this.expanded.add(key);
    this.renderMap(p); this.renderAreas();
  }
  /** Start editing (or drawing) an area or a roof. Opens the map the place is on. */
  startEdit(kind: 'area' | 'roof', pid: string, mode: 'edit' | 'draw') {
    const p = this.project; if (!p || !p.data.places[pid]) return;
    const home = M.mapOfPlace(p.data, pid);
    if (home !== this.mapId) this.openMap(home);
    const r = p.data.roofs[pid];
    const pts = mode === 'draw' ? [] : kind === 'area' ? M.areaOf(p.data, pid)!.map(q => ({ ...q })) : r ? M.roofShape(r).map(q => ({ ...q })) : [];
    this.edit = { kind, pid, pts, mode: mode === 'edit' && pts.length < 3 ? 'draw' : mode };
    this.card = pid; this.editCursor = null; this.snapped = null;
    this.renderMap(p); this.renderAreas();
  }
  private finishEdit(save: boolean) {
    const p = this.project, ed = this.edit; this.edit = null; this.editCursor = null; this.snapped = null;
    if (!p || !ed) return;
    if (save && ed.pts.length >= 3) {
      p.checkpoint();
      const pts = ed.pts.map(q => ({ x: Math.min(1, Math.max(0, q.x)), y: Math.min(1, Math.max(0, q.y)) }));
      if (ed.kind === 'area') p.setArea(ed.pid, pts);
      else {
        const xs = pts.map(q => q.x), ys = pts.map(q => q.y), x = Math.min(...xs), y = Math.min(...ys);
        p.setRoof(ed.pid, { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, pts, image: p.data.roofs[ed.pid]?.image ?? null });
      }
      new Notice(`${p.get(ed.pid)?.name}'s ${ed.kind === 'area' ? 'area' : 'roof'} is set.`);
    }
    this.renderMap(p); this.renderAreas();
  }
  /** Snap to neighbouring shapes' corners and edges (Shift turns it off). */
  private snap(pt: M.Point, free: boolean, skip?: number): { pt: M.Point; snapped: 'corner' | 'edge' | null } {
    const p = this.project, ed = this.edit; if (!p || !ed || free) return { pt, snapped: null };
    const d = p.data, shapes: M.Point[][] = [];
    for (const id of Object.keys(d.places)) if (M.mapOfPlace(d, id) === this.mapId && p.isPlaceId(id) && !(ed.kind === 'area' && id === ed.pid)) shapes.push(M.areaOf(d, id)!);
    for (const [id, r] of Object.entries(d.roofs)) if (M.mapOfPlace(d, id) === this.mapId && !(ed.kind === 'roof' && id === ed.pid)) shapes.push(M.roofShape(r));
    const own = ed.pts.filter((_, i) => i !== skip);
    if (ed.mode === 'draw' && own.length >= 3) shapes.push([own[0]]);   // closing on the first point
    return M.snapPoint(pt, shapes, 10 / (this.zoom * Math.max(this.SW, this.SH)));
  }
  private editDown(e: PointerEvent, t: HTMLElement) {
    const ed = this.edit!, s = this.toStage(e.clientX, e.clientY), f = { x: s.x / this.SW, y: s.y / this.SH };
    const vi = t.closest?.('[data-vi]')?.getAttribute('data-vi'), mi = (t as Element).closest?.('[data-mi]')?.getAttribute('data-mi'), sc = (t as Element).closest?.('[data-scale]');
    if (ed.mode === 'draw') {
      const first = ed.pts[0], tol = 12 / (this.zoom * Math.max(this.SW, this.SH));
      if (ed.pts.length >= 3 && (vi === '0' || Math.hypot(first.x - f.x, first.y - f.y) < tol)) { ed.mode = 'edit'; this.editCursor = null; }
      else ed.pts.push(this.snap(f, e.shiftKey).pt);
      this.renderAreas(); const p = this.project; if (p) this.renderHint(p);
      return;
    }
    if (vi != null) { this.drag = { kind: 'vertex', i: Number(vi) }; return; }
    if (mi != null) { const i = Number(mi), a = ed.pts[i], b = ed.pts[(i + 1) % ed.pts.length]; ed.pts.splice(i + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }); this.drag = { kind: 'vertex', i: i + 1 }; this.renderAreas(); return; }
    if (sc) { const c = { x: ed.pts.reduce((a, q) => a + q.x, 0) / ed.pts.length, y: ed.pts.reduce((a, q) => a + q.y, 0) / ed.pts.length }; this.drag = { kind: 'scale', c, d0: Math.hypot(f.x - c.x, f.y - c.y) || 1e-6, orig: ed.pts.map(q => ({ ...q })) }; return; }
    if (M.inPolygon(ed.pts, f)) { this.drag = { kind: 'body', start: f, orig: ed.pts.map(q => ({ ...q })) }; return; }
  }

  /** Choose a place's icon: the built-in set, an image from the vault, or none (a plain dot). */
  pickIcon(p: Project, pid: string) {
    new IconPicker(this.app, p.get(pid)?.name ?? 'this location', p.data.icons[pid] ?? null, ref => {
      if (ref) p.data.icons[pid] = ref; else delete p.data.icons[pid];
      p.saveSoon();
    }).open();
  }
  private makeInsideMap(pl: M.Piece) {
    const p = this.project; if (!p) return;
    const m = p.addMap(pl.name, pl.id);
    new Notice(`Made an inside map for ${pl.name}. Pick its picture, or close the picker to use a blank sheet.`);
    new ImagePicker(this.app, f => { m.image = f.path; p.saveSoon(); }).open();
    this.openMap(m.id);
  }
  private refreshSelection() {
    for (const n of Array.from(this.r.stage.querySelectorAll<HTMLElement>('.se-tok, .se-pin'))) n.toggleClass('is-sel', this.sel.has(n.dataset.id!) || this.card === n.dataset.id);
    const p = this.project; if (p) { this.renderCatalog(p); this.renderOverlay(); this.renderAreas(); }
  }
  private lastTap: { id: string; at: number } | null = null;
  private markerTimer: number | null = null;
  /** Two quick clicks on a place with an inside map go inside. (The map holds the pointer while you press, so the browser's own double-click never arrives.) */
  private doubleTap(id: string) {
    const now = Date.now(), prev = this.lastTap;
    this.lastTap = { id, at: now };
    if (!prev || prev.id !== id || now - prev.at > 450) return false;
    const inside = this.project?.insideMapOf(id); if (!inside) return false;
    this.lastTap = null; this.openMap(inside.id); return true;
  }
  private async mapUp(e: PointerEvent) {
    const d = this.drag; this.drag = null; this.r.map.removeClass('is-panning'); this.r.map.removeClass('is-moving');
    const p = this.project; if (!d || !p) return;
    if (this.areasAll) { this.areasAll = false; }
    if (d.kind === 'pan') { this.renderOverlay(); this.renderAreas(); return; }
    if (d.kind === 'vertex' || d.kind === 'body' || d.kind === 'scale') { this.snapped = null; this.renderAreas(); return; }
    if (d.kind === 'stack') {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) >= 5) return;
      // One click zooms in; two quick clicks on a place with an inside map go inside.
      const pid = d.key.startsWith('p') ? d.key.slice(1) : '';
      if (pid && p.insideMapOf(pid)) {
        if (this.markerTimer !== null) { window.clearTimeout(this.markerTimer); this.markerTimer = null; this.openMap(p.insideMapOf(pid)!.id); return; }
        this.markerTimer = window.setTimeout(() => { this.markerTimer = null; this.openStack(p, d.key); }, 280);
        return;
      }
      this.openStack(p, d.key); return;
    }
    if (d.kind === 'roofclick') { if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) { if (this.doubleTap(d.id)) return; this.openRoofs.add(d.id); this.card = d.id; void this.render(); } return; }
    if (d.kind === 'click') {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
      const pt = this.toStage(e.clientX, e.clientY);
      if (!this.onImage(pt)) { new Notice('That spot is off the map.'); return; }
      if (this.putting) {
        const x = p.get(this.putting); this.putting = null;
        if (x) await this.putToken(p, x, pt);
        void this.render(); return;
      }
      const placeType = p.data.types.find(t => t.behaviour === 'place');
      if (placeType) this.askName(e.clientX, e.clientY, placeType.id);
      return;
    }
    if (d.kind === 'move') {
      const shifted = this.dragPlaces; this.dragShift = null; this.dragPlaces = new Set(); this.renderAreas();
      // A plain click selects just that one piece.
      if (!d.moved) { if (this.doubleTap(d.id)) return; this.sel = new Set([d.id]); this.card = d.id; void this.render(); return; }
      void shifted;
      p.checkpoint();
      const dx = (e.clientX - d.x) / this.zoom, dy = (e.clientY - d.y) / this.zoom;
      const cur = p.current(this.tl);
      let blocked = false, landed: string | null = null;
      for (const id of this.sel) {
        const x = p.get(id); if (!x) continue;
        const b = p.behaviour(x), base = this.positions.get(id) ?? this.toStage(e.clientX, e.clientY);
        if (b === 'place') { p.setPlacePoint(x, this.frac({ x: base.x + dx, y: base.y + dy })); continue; }
        if (!cur) { blocked = true; continue; }
        // Wherever it lands: inside a place's area (kept at that exact spot) or just on the map.
        const target = p.spot(this.mapId, this.frac({ x: base.x + dx, y: base.y + dy }));
        if (id === d.id) landed = target.place ?? null;
        await p.place(x, cur, { ...target, ...(b === 'event' ? { only: true } : {}) });
      }
      if (blocked) new Notice(this.say('Add a chapter first: pieces move scene by scene.'));
      if (landed && this.sel.size === 1) new Notice(this.say(`${p.get(d.id)?.name} is at ${p.get(landed)?.name} from scene ${cur?.order} on.`));
      this.card = d.id; this.hoverPlace = null;
      p.saveSoon();
      return;
    }
    d.box.remove();
    const r = this.r.map.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (Math.abs(x - d.x) < 4 && Math.abs(y - d.y) < 4) { if (!d.add) { this.sel.clear(); this.card = null; this.expanded.clear(); this.openRoofs.clear(); void this.render(); } return; }
    const a = { x: Math.min(x, d.x), y: Math.min(y, d.y) }, b = { x: Math.max(x, d.x), y: Math.max(y, d.y) };
    if (!d.add) this.sel.clear();
    for (const n of Array.from(this.r.stage.querySelectorAll<HTMLElement>('.se-tok:not(.is-under-roof), .se-pin:not(.is-under-roof)'))) {
      const rr = (n.querySelector('.se-f, i') as HTMLElement).getBoundingClientRect(), cx = rr.left + rr.width / 2 - r.left, cy = rr.top + rr.height / 2 - r.top;
      if (cx >= a.x && cx <= b.x && cy >= a.y && cy <= b.y) this.sel.add(n.dataset.id!);
    }
    this.refreshSelection();
    void this.renderCard(p);
  }
  private async putToken(p: Project, x: M.Piece, pt: { x: number; y: number }) {
    const cur = p.current(this.tl);
    p.checkpoint();
    if (p.behaviour(x) === 'place') { p.setPlacePoint(x, this.frac(pt), this.mapId); return; }
    if (!cur) { new Notice(this.say('Add a chapter first: pieces move scene by scene.')); return; }
    await p.place(x, cur, { ...p.spot(this.mapId, this.frac(pt)), ...(p.behaviour(x) === 'event' ? { only: true } : {}) });
    this.card = x.id; this.sel = new Set([x.id]); this.newPin = x.id;
  }
  /** Name box for something new at a spot on the map. */
  private askName(cx: number, cy: number, typeId: string | null) {
    const p = this.project; if (!p) return;
    this.closeFloat();
    const r = this.r.map.getBoundingClientRect(), pt = this.toStage(cx, cy), box = this.r.map.createDiv('se-namebox');
    box.style.left = `${Math.min(cx - r.left + 8, r.width - 240)}px`; box.style.top = `${Math.min(cy - r.top + 8, r.height - 110)}px`;
    const type = typeId ? p.type(typeId) : null;
    const inp = box.createEl('input'); inp.placeholder = type ? `Name this ${type.label.toLowerCase()}` : 'Name';
    let sel: HTMLSelectElement | null = null;
    if (!type) { sel = box.createEl('select', { cls: 'dropdown' }); for (const t of p.data.types) sel.createEl('option', { text: t.label, value: t.id }); }
    box.createEl('small', { text: `Enter to add · Esc to cancel${this.placing ? ' · location mode is on' : ''}` });
    inp.focus();
    inp.onkeydown = async ev => {
      if (ev.key === 'Escape') { ev.stopPropagation(); box.remove(); this.r.map.focus({ preventScroll: true }); return; }
      if (ev.key !== 'Enter' || !inp.value.trim()) return;
      const t = p.type(type?.id ?? sel!.value);
      box.remove(); this.r.map.focus({ preventScroll: true });
      try {
        const x = await p.createPiece({ name: inp.value.trim(), type: t.id });
        if (t.behaviour === 'place') { p.setPlacePoint(x, this.frac(pt), this.mapId); this.newPin = x.id; this.card = x.id; }
        else await this.putToken(p, x, pt);
        p.saveSoon();
      } catch (err) { new Notice((err as Error).message); }
    };
  }

  /* ───────── catalog and card ───────── */

  private renderCatalog(p: Project) {
    const c = this.r.cat; const scroll = c.scrollTop; c.empty();
    this.r.q.placeholder = 'Search'; 
    if (!p.pieces.size) { c.createDiv({ cls: 'se-empty', text: 'Nothing yet. Highlight a name in a chapter to add one.' }); return; }
    const q = this.query;
    const all = p.all().filter(x => !q || [x.name, ...x.aliases, ...x.themes].some(n => n.toLowerCase().includes(q)));
    const cur = p.current(this.tl), tl = this.tl, slot = cur?.slot ?? 0;
    // Where everything is now, worked out once.
    const at = new Map<string, M.TrackEntry | null>(), here = new Map<string, number>();
    for (const x of p.all()) { if (p.behaviour(x) === 'place') continue; const w = p.where(x); at.set(x.id, w); if (w?.place) here.set(w.place, (here.get(w.place) ?? 0) + 1); }
    const died = new Map<string, string>();   // piece → scene id of its death (by the scene on screen)
    if (tl?.scenes.length) for (const x of all) { const s = M.deathAt(p.data, x.id, slot, tl.t.slotOfScene); if (s) died.set(x.id, s); }
    // Sections fold (remembered); while searching, everything shows.
    const closed = new Set(p.data.ui.catClosed ?? []);
    const save = () => { p.data.ui.catClosed = [...closed]; p.saveQuiet(); };
    const fold = (parent: HTMLElement, cls: string, key: string, label: string, n: number) => {
      const f = foldable(parent, cls, key, closed, save, !!q);
      f.h.createSpan({ text: label }); f.h.createSpan({ cls: 'se-fold-n', text: ` · ${n}` });
      return f.body;
    };
    const row = (parent: HTMLElement, x: M.Piece, t: M.PieceType) => {
      const b = t.behaviour;
      const r = parent.createDiv(`se-row ${this.card === x.id || this.sel.has(x.id) ? 'is-sel' : ''}`);
      r.dataset.id = x.id;
      r.style.setProperty('--c', (cur?.pov === x.id ? this.povColor.get(x.id) : null) ?? t.color);
      r.createSpan('se-d'); r.createSpan({ cls: 'se-row-name', text: x.name });
      if (this.povColor.has(x.id)) r.createSpan({ cls: 'se-faint', text: 'POV' });
      let meta = '';
      if (died.has(x.id)) {
        const sc = tl!.scenes.find(s => s.id === died.get(x.id));
        meta = sc ? `✝ ${this.words.scene.toLowerCase()} ${sc.order}` : '✝';
        r.addClass('is-dead');
        if (sc) r.ondblclick = () => p.setView(sc.order);
      } else if (b === 'place') meta = p.data.places[x.id] ? String(here.get(x.id) || '') : 'not on map';
      else if (tl?.scenes.length) {
        const w = at.get(x.id);
        const started = (p.data.track[x.id] ?? []).some(e => (tl.t.slotOfScene.get(e.s) ?? Infinity) <= slot);
        meta = w ? (w.place ? p.get(w.place)?.name ?? '' : w.pt ? 'on the map' : 'here') : b === 'event' || !p.data.track[x.id]?.length ? '' : started ? 'gone' : 'not yet';
        if (!w) r.addClass('is-dead');
      }
      r.createSpan({ cls: 'se-m', text: meta });
      r.onclick = () => { this.card = x.id; this.sel = new Set([x.id]); void this.render(); };
    };
    // Faction members: a “Member of” connection to another piece.
    const factionsOf = (x: M.Piece) => x.connections.filter(cn => M.isMembership(cn.label)).map(cn => p.find(cn.target)).filter((f): f is M.Piece => !!f && f.id !== x.id);
    const types = [...p.data.types, ...[...new Set(all.map(x => x.type))].filter(id => !p.data.types.some(t => t.id === id)).map(id => p.type(id))];
    for (const t of types) {
      const list = all.filter(x => x.type === t.id && !died.has(x.id)); if (!list.length) continue;
      const body = fold(c, 'se-grp', `t:${t.id}`, t.plural, list.length);
      const groups = new Map<string, { f: M.Piece; list: M.Piece[] }>(), loose: M.Piece[] = [];
      for (const x of list) { const fs = factionsOf(x); if (!fs.length) loose.push(x); for (const f of fs) (groups.get(f.id) ?? groups.set(f.id, { f, list: [] }).get(f.id)!).list.push(x); }
      if (!groups.size) { for (const x of list) row(body, x, t); continue; }
      // Sub-groups by faction (someone in two factions shows in both), then everyone else.
      for (const g of [...groups.values()].sort((a, b) => a.f.name.localeCompare(b.f.name))) {
        const sub = fold(body, 'se-grp se-subgrp', `f:${t.id}:${g.f.id}`, g.f.name, g.list.length);
        sub.addClass('se-subbody'); for (const x of g.list) row(sub, x, t);
      }
      if (loose.length) { const sub = fold(body, 'se-grp se-subgrp', `f:${t.id}:`, 'No faction', loose.length); sub.addClass('se-subbody'); for (const x of loose) row(sub, x, t); }
    }
    if (died.size) {
      const body = fold(c, 'se-grp se-dead-grp', 'dead', 'Dead', died.size);
      const sorted = all.filter(x => died.has(x.id)).sort((a, b) => (tl!.t.slotOfScene.get(died.get(a.id)!) ?? 0) - (tl!.t.slotOfScene.get(died.get(b.id)!) ?? 0));
      for (const x of sorted) row(body, x, p.type(x.type));
    }
    if (!c.childElementCount) c.createDiv({ cls: 'se-empty', text: 'Nothing matches.' });
    c.scrollTop = scroll;
  }
  private async renderCard(p: Project) {
    const root = this.r.cardEl;
    let c: HTMLElement = root;
    const x = p.get(this.card);
    const scroll = root.scrollTop;
    root.empty();
    if (!x) {
      c.createDiv({ cls: 'se-empty', text: 'Click a piece to see its card.' });
      if (this.sel.size > 1) c.createDiv({ cls: 'se-sub', text: `${this.sel.size} selected · drag one to move them all` });
      return;
    }
    const t = p.type(x.type), b = t.behaviour, tl = this.tl!;
    root.style.setProperty('--c', t.color);
    const title = c.createDiv('se-card-title');
    const a = title.createEl('a', { cls: 'se-t', text: x.name }); a.onclick = () => void this.app.workspace.openLinkText(x.path, '', 'tab');
    const ts = title.createEl('select', { cls: 'dropdown se-card-type' }); 
    for (const ty of p.data.types) ts.createEl('option', { text: ty.label, value: ty.id });
    if (!p.data.types.some(ty => ty.id === x.type)) ts.createEl('option', { text: t.label, value: x.type });
    ts.value = x.type; ts.onchange = () => void p.setType(x, ts.value);
    const sub: string[] = [];
    if (x.aliases.length) sub.push(`Also: ${x.aliases.join(', ')}`);
    const povN = tl.scenes.filter(s => s.pov === x.id).length;
    if (povN) sub.push(this.say(`POV in ${povN} scene${povN > 1 ? 's' : ''}`));
    if (sub.length) c.createDiv({ cls: 'se-sub', text: sub.join(' · ') });

    // Each section folds; the same sections stay folded for every card.
    const closed = new Set(p.data.ui.cardClosed ?? []);
    const save = () => { p.data.ui.cardClosed = [...closed]; p.saveQuiet(); };
    const section = (label: string, add?: { text: string; title: string; what: 'desc' | 'conn' }, key = label) => {
      const f = foldable(root, 'se-grp se-grp-row', key, closed, save);
      f.h.createSpan({ text: label });
      if (add) { const btn = f.h.createEl('button', { cls: 'se-add', text: add.text }); btn.dataset.wait = '1'; btn.onclick = () => void this.plugin.capture.waitFor(p, x, add.what, btn.getBoundingClientRect()); }
      c = f.body;
    };
    section('Description', { text: '+ Add', title: 'Click, then highlight the text in a chapter (or type it)', what: 'desc' });
    const desc = await p.readDescription(x);
    if (this.card !== x.id) return;
    if (!desc.length) c.createDiv({ cls: 'se-empty', text: 'None yet.' });
    for (const d of desc) {
      const q = c.createDiv(`se-quote ${d.source ? '' : 'is-typed'}`);
      q.createSpan({ text: d.text });
      if (d.source) { q.title = `From ${d.source}`; q.onclick = ev => { if (!(ev.target as HTMLElement).closest('.se-x')) void this.jumpToQuote(p, d.source!, d.text); }; }
      const del = q.createEl('button', { cls: 'se-x', text: '×' }); 
      del.onclick = ev => { ev.stopPropagation(); void p.removeDescription(x, d.raw); };
    }
    section('Connections', { text: '+ Add', title: 'Click, then click or highlight a name in a chapter (or type it)', what: 'conn' });
    const incoming = p.all().flatMap(o => o.connections.filter(cn => p.find(cn.target)?.id === x.id).map(cn => ({ o, cn })));
    if (!x.connections.length && !incoming.length) c.createDiv({ cls: 'se-empty', text: 'None yet.' });
    for (const cn of x.connections) {
      const row = c.createDiv('se-conn'); row.append(this.plugin.capture.swatchFor(p, cn.label));
      const tgt = p.find(cn.target);
      const ph = phrase(cn.label);
      row.appendText(`${ph.charAt(0).toUpperCase()}${ph.slice(1)} `);
      const nm = row.createEl('b', { text: tgt?.name ?? cn.target });
      if (tgt) { nm.addClass('se-link'); nm.onclick = () => { this.card = tgt.id; this.sel = new Set([tgt.id]); void this.render(); }; }
      const del = row.createEl('button', { cls: 'se-x', text: '×' }); del.onclick = () => void p.removeConnection(x, cn);
    }
    for (const { o, cn } of incoming) {
      // Read the other way round: “Gared — sibling of Bran”.
      const row = c.createDiv('se-conn is-incoming'); row.append(this.plugin.capture.swatchFor(p, cn.label));
      const nm = row.createEl('b', { text: o.name, cls: 'se-link' }); nm.onclick = () => { this.card = o.id; this.sel = new Set([o.id]); void this.render(); };
      row.appendText(` — ${phrase(cn.label)} `);
      row.createSpan({ cls: 'se-mut', text: x.name });
      
    }

    const cur = p.current(tl);
    if (b === 'place') {
      section('On the map', undefined, 'Map');
      const here = p.all().filter(o => p.where(o)?.place === x.id);
      c.createDiv({ cls: 'se-sub', text: p.data.places[x.id] ? `${here.length ? 'Here now: ' + here.map(o => o.name).join(', ') + '. ' : ''}Drag its pin to move it.` : 'Not on the map yet.' });
      if (!p.data.places[x.id]) { const put = c.createEl('button', { cls: 'se-hb', text: 'Put it on the map' }); put.onclick = () => { this.putting = x.id; this.renderMap(p); }; }
      const scenesHere = tl.scenes.filter(s => s.where === x.id);
      if (scenesHere.length) c.createDiv({ cls: 'se-sub', text: this.say(`Scenes set here: ${scenesHere.map(s => s.order).join(', ')}`) });
      if (p.data.places[x.id]) {
        const onMap = M.mapOfPlace(p.data, x.id);
        if (onMap !== M.MAIN_MAP) c.createDiv({ cls: 'se-sub', text: `On the ${p.mapName(onMap)} map.` });
        const acts = c.createDiv('se-acts se-start');
        const inside = p.insideMapOf(x.id);
        if (inside) { const go = acts.createEl('button', { cls: 'se-hb', text: `⤵ Go inside (${inside.name})` }); go.onclick = () => this.openMap(inside.id); }
        else { const mk = acts.createEl('button', { cls: 'se-hb', text: '+ Inside map…' }); mk.onclick = () => this.makeInsideMap(x); }
        const ic = acts.createEl('button', { cls: 'se-hb', text: p.data.icons[x.id] ? 'Change icon…' : 'Icon…' });
        
        ic.onclick = () => this.pickIcon(p, x.id);
        const area = acts.createEl('button', { cls: 'se-hb', text: 'Edit area' });
        
        area.onclick = () => this.startEdit('area', x.id, 'edit');
        const draw = acts.createEl('button', { cls: 'se-hb', text: 'Draw area' }); draw.onclick = () => this.startEdit('area', x.id, 'draw');
        const roof = p.data.roofs[x.id];
        const rb = acts.createEl('button', { cls: 'se-hb', text: roof ? 'Edit roof' : '+ Roof' });
        
        rb.onclick = () => this.startEdit('roof', x.id, roof ? 'edit' : 'draw');
        if (roof) {
          const pic = acts.createEl('button', { cls: 'se-hb', text: 'Roof picture…' }); pic.onclick = () => new ImagePicker(this.app, f => p.setRoof(x.id, { ...roof, image: f.path })).open();
          const rm = acts.createEl('button', { cls: 'se-hb se-ghost', text: 'Remove roof' }); confirmClick(rm, 'Sure?', () => { p.checkpoint(); p.setRoof(x.id, null); });
        }
      }
    } else if (tl.scenes.length) {
      // Journey: every change of place, in story time.
      const stops: { slot: number; text: string }[] = []; let last: string | null = null;
      for (let s = 0; s < tl.t.slots; s++) {
        const w = p.where(x, s);
        const dead = !w && !!M.deathAt(p.data, x.id, s, tl.t.slotOfScene);
        const key = w ? (w.place ?? (w.pt ? `${w.pt.x},${w.pt.y}` : 'here')) : dead ? 'dead' : 'gone';
        if (key === last || ((key === 'gone' || key === 'dead') && last === null)) continue;
        last = key;
        stops.push({ slot: s, text: w ? (w.place ? p.get(w.place)?.name ?? '?' : w.pt ? 'Moved on the map' : 'Present, not placed') : b === 'event' ? 'Over' : dead ? '✝ Died' : 'Gone' });
      }
      section(b === 'event' ? 'When' : `Journey${stops.length ? ` (${stops.length} stop${stops.length > 1 ? 's' : ''})` : ''}`, undefined, 'Map');
      if (!stops.length) c.createDiv({ cls: 'se-empty', text: 'Not on the map yet.' });
      const jl = c.createDiv('se-jl');
      stops.forEach((st, k) => {
        const next = stops[k + 1]?.slot ?? tl.t.slots;
        const btn = jl.createEl('button', { cls: cur && cur.slot >= st.slot && cur.slot < next ? 'is-now' : '' });
        const sc = this.sceneAtSlot(st.slot);
        btn.createSpan({ cls: 'se-w', text: `${M.bandAt(tl.t, st.slot)?.moment.label ?? ''}${sc ? ` · ${this.words.scene.toLowerCase()} ${sc.order}` : ''}`.replace(/^ · /, '') });
        btn.createSpan({ text: st.text });
        btn.onclick = () => { if (sc) p.setView(sc.order); };
      });
      if (cur && b === 'token') {
        const acts = c.createDiv('se-acts se-start');
        const w = p.where(x), sc = this.words.scene.toLowerCase();
        const deathId = M.deathAt(p.data, x.id, cur.slot, tl.t.slotOfScene);
        if (deathId) {
          const ds = tl.scenes.find(s2 => s2.id === deathId);
          c.createDiv({ cls: 'se-sub', text: `Dead from ${sc} ${ds?.order ?? '?'} on${ds ? ` (${ds.label})` : ''}.` });
          const un = acts.createEl('button', { cls: 'se-hb', text: 'Not dead after all' }); 
          un.onclick = () => { p.data.track[x.id] = (p.data.track[x.id] ?? []).filter(e => e.s !== deathId); p.saveSoon(); };
        } else if (w) {
          const dh = acts.createEl('button', { cls: 'se-hb', text: `Dead from ${sc} ${cur.order} on` }); 
          dh.onclick = () => void p.place(x, cur, { gone: true, dead: true });
          const g = acts.createEl('button', { cls: 'se-hb', text: `Gone from ${sc} ${cur.order} on` }); g.onclick = () => void p.place(x, cur, { gone: true });
        }
        if (!w) { const h = acts.createEl('button', { cls: 'se-hb', text: `Put it in ${sc} ${cur.order}` }); h.onclick = () => { this.putting = x.id; this.renderMap(p); }; }
      }
    }
    section('Themes & rules');
    const tags = c.createDiv('se-tags');
    for (const th of x.themes) {
      const s = tags.createSpan({ cls: 'se-tag', text: th }); s.style.setProperty('--c', p.data.themes[th]?.color ?? '#fff');
      if (p.data.themes[th]?.meaning) s.title = p.data.themes[th].meaning;
      const del = s.createEl('button', { cls: 'se-x', text: '×' }); del.onclick = () => void p.setThemes(x, x.themes.filter(y => y !== th));
    }
    const ti = tags.createEl('input', { cls: 'se-tag-input' }); ti.placeholder = '+ theme or rule';
    const dl = tags.createEl('datalist'); dl.id = `se-themes-${x.id}`; for (const th of Object.keys(p.data.themes)) dl.createEl('option').value = th; ti.setAttribute('list', dl.id);
    ti.onkeydown = e => { if (e.key === 'Enter' && ti.value.trim()) void p.setThemes(x, [...new Set([...x.themes, ti.value.trim()])]); };

    const acts = root.createDiv('se-acts se-start se-card-acts');
    const open = acts.createEl('button', { cls: 'se-hb', text: 'Open note' }); open.onclick = () => void this.app.workspace.openLinkText(x.path, '', 'tab');
    const del = acts.createEl('button', { cls: 'se-hb se-ghost', text: 'Delete…' }); 
    confirmClick(del, 'Sure? Click again', () => void p.deletePiece(x).then(() => { this.card = null; this.sel.delete(x.id); void this.render(); }));
    root.scrollTop = scroll;
  }
  private async jumpToQuote(p: Project, source: string, text: string) {
    const f = this.app.metadataCache.getFirstLinkpathDest(source, p.folder);
    if (!(f instanceof TFile)) { new Notice(`Couldn't find the chapter “${source}”.`); return; }
    const v = await this.openInEditor(f); if (!v) return;
    const body = v.editor.getValue();
    const at = body.indexOf(text.split('\n')[0].slice(0, 80));
    if (at < 0) { new Notice('That passage has changed since it was captured.'); return; }
    const a = v.editor.offsetToPos(at), b = v.editor.offsetToPos(at + text.length);
    v.editor.setSelection(a, b); v.editor.scrollIntoView({ from: a, to: b }, true);
  }
  private async openInEditor(f: TFile): Promise<MarkdownView | null> {
    const leaf = this.app.workspace.getLeavesOfType('markdown').find(l => (l.view as MarkdownView).file?.path === f.path) ?? this.app.workspace.getLeaf(false);
    if (leaf === this.leaf) return null;
    await leaf.openFile(f);
    return leaf.view instanceof MarkdownView ? leaf.view : null;
  }
  private async openScene(s: SceneEntry) {
    const v = await this.openInEditor(s.file); if (!v) return;
    const line = Math.max(0, s.span.metaLine ?? s.span.startLine + 1);
    v.editor.setCursor({ line, ch: 0 }); v.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
  }

  /* ───────── setup tab ───────── */

  private renderSetup(p: Project) {
    const root = this.r.setup; const scroll = root.scrollTop; root.empty();
    let c: HTMLElement = root;
    // Each section folds: click its title. Which ones are folded is remembered.
    const closed = new Set(p.data.ui.setupClosed ?? []);
    const head = (title: string, hint: string, key = title) => {
      const shut = closed.has(key);
      const h = root.createDiv('se-grp se-fold'); const tw = h.createSpan({ cls: 'se-fold-tw', text: shut ? '▸' : '▾' }); h.appendText(title);
      c = root.createDiv(`se-fold-body ${shut ? 'is-closed' : ''}`);
      const bodyEl = c;
      h.onclick = () => {
        const now = !bodyEl.hasClass('is-closed'); bodyEl.toggleClass('is-closed', now); tw.textContent = now ? '▸' : '▾';
        if (now) closed.add(key); else closed.delete(key);
        p.data.ui.setupClosed = [...closed]; p.saveQuiet();
      };
      if (hint) c.createDiv({ cls: 'se-sub', text: hint });
    };
    const bulk = (placeholder: string, onAdd: (labels: string[], extra: string) => void, extra?: [string, string][]) => {
      const row = c.createDiv('se-bulk');
      const ta = row.createEl('textarea'); ta.placeholder = placeholder; ta.rows = 1; 
      let sel: HTMLSelectElement | null = null;
      if (extra) { sel = row.createEl('select', { cls: 'dropdown' }); for (const [v, l] of extra) sel.createEl('option', { text: l, value: v }); }
      const go = () => { const l = M.splitList(ta.value); if (!l.length) return; onAdd(l, sel?.value ?? ''); ta.value = ''; this.renderSetup(p); };
      ta.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } };
      row.createEl('button', { cls: 'se-hb', text: 'Add' }).onclick = go;
    };
    const delBtn = (row: HTMLElement, used: number, what: string, fn: () => void) => {
      const d = row.createEl('button', { cls: 'se-x', text: '×' });
      const go = () => { fn(); this.renderSetup(p); p.saveSoon(); };
      if (used) confirmClick(d, 'Sure?', go); else d.onclick = go;
    };
    const BEH = M.BEHAVIOURS;

    head('Piece types', '');
    for (const t of p.data.types) {
      const row = c.createDiv('se-def');
      const col = row.createEl('input', { cls: 'se-color' }); col.type = 'color'; col.value = t.color; col.onchange = () => { t.color = col.value; p.saveSoon(); };
      const name = row.createEl('input', { cls: 'se-def-name' }); name.value = t.label;
      name.onchange = () => { const v = name.value.trim(); if (!v) { name.value = t.label; return; } t.label = v; t.plural = v.endsWith('s') ? v : v + 's'; p.saveSoon(); };
      const beh = row.createEl('select', { cls: 'dropdown se-beh' }); for (const [v, l] of BEH) beh.createEl('option', { text: l, value: v }); beh.value = t.behaviour;
      beh.onchange = () => { t.behaviour = beh.value as M.Behaviour; p.saveSoon(); };
      const used = p.usage('type', t.id);
      row.createSpan({ cls: 'se-count', text: used ? String(used) : '' });
      delBtn(row, used, 'type', () => { p.data.types = p.data.types.filter(x => x !== t); });
    }
    bulk('Add: Spirit, Ship…', (l, beh) => p.addTypes(l, beh as M.Behaviour), BEH);

    head('Connection types', '');
    for (const s of p.data.styles) {
      const row = c.createDiv('se-def');
      row.append(this.plugin.capture.swatch(s));
      const name = row.createEl('input', { cls: 'se-def-name' }); name.value = s.label;
      name.onchange = () => { const v = name.value.trim(); if (!v || v === s.label) { name.value = s.label; return; } void p.renameStyle(s, v); };
      const col = row.createEl('input', { cls: 'se-color' }); col.type = 'color'; col.value = s.color; col.onchange = () => { s.color = col.value; p.saveSoon(); this.renderSetup(p); };
      const dash = row.createEl('select', { cls: 'dropdown se-dash' }); for (const [d, t] of [['solid', '──'], ['dashed', '╌╌'], ['dotted', '┈┈']]) dash.createEl('option', { text: t, value: d }); dash.value = s.dash; dash.onchange = () => { s.dash = dash.value as M.LineStyle['dash']; p.saveSoon(); this.renderSetup(p); };
      const arrow = row.createEl('select', { cls: 'dropdown se-arrow' }); for (const [v, l] of [['none', '—'], ['end', '→'], ['both', '↔']]) arrow.createEl('option', { text: l, value: v }); arrow.value = s.arrow; arrow.onchange = () => { s.arrow = arrow.value as M.LineStyle['arrow']; p.saveSoon(); };
      const used = p.usage('style', s.label);
      row.createSpan({ cls: 'se-count', text: used ? String(used) : '' });
      delBtn(row, used, 'connection type', () => { p.data.styles = p.data.styles.filter(x => x !== s); });
    }
    bulk('Add: Rival, Mentor…', l => p.addStyles(l));

    head('Themes & rules', '');
    for (const [k, th] of Object.entries(p.data.themes)) {
      const row = c.createDiv('se-def se-def-theme');
      const col = row.createEl('input', { cls: 'se-color' }); col.type = 'color'; col.value = th.color; col.onchange = () => { th.color = col.value; p.saveSoon(); };
      const name = row.createEl('input', { cls: 'se-def-name' }); name.value = k;
      name.onchange = () => { const v = name.value.trim(); if (!v || v === k || p.data.themes[v]) { name.value = k; return; } void p.renameTheme(k, v); };
      const used = p.usage('theme', k);
      row.createSpan({ cls: 'se-count', text: used ? String(used) : '' });
      delBtn(row, used, 'theme', () => { void p.renameTheme(k, null); });
      const mean = row.createEl('textarea', { cls: 'se-meaning' }); mean.rows = 1; mean.placeholder = 'What it means…'; mean.value = th.meaning;
      mean.onchange = () => { th.meaning = mean.value.trim(); p.saveSoon(); };
      const fit = () => { mean.style.height = 'auto'; mean.style.height = `${Math.max(26, mean.scrollHeight + 2)}px`; };
      if (!CSS.supports('field-sizing', 'content')) { mean.addEventListener('input', fit); requestAnimationFrame(fit); }
    }
    bulk('Add: Eyes, Blood debt…', l => p.addThemes(l));

    head(this.words.moments, '', 'Moments');
    if (!p.data.moments.length) c.createDiv({ cls: 'se-empty', text: 'None yet.' });
    for (const m of p.data.moments) {
      const row = c.createDiv('se-def');
      const name = row.createEl('input', { cls: 'se-def-name' }); name.value = m.label; name.onchange = () => { m.label = name.value.trim() || m.label; p.invalidateScenes(); p.saveSoon(); };
      const sk = row.createEl('input', { cls: 'se-skip-text' }); sk.value = m.skipText ?? ''; sk.placeholder = 'time skip before it?'; 
      sk.onchange = () => { const v = sk.value.trim(); m.skip = !!v; if (v) m.skipText = v; else delete m.skipText; p.invalidateScenes(); p.saveSoon(); };
      const used = (this.tl?.scenes ?? []).filter(s => s.span.meta.moment === m.id || s.span.meta.flash === m.id).length;
      row.createSpan({ cls: 'se-count', text: used ? String(used) : '' });
      delBtn(row, used, 'moment', () => { void p.deleteMoment(m.id); });
    }

    head('Maps', '');
    // One row per map: its name and picture on the left, its buttons on the right.
    const mapRow = (label: string, sub: string, image: string | null, pick: () => void, clear: (() => void) | null, extra?: (acts: HTMLElement) => void) => {
      const row = c.createDiv('se-maprow');
      const info = row.createDiv('se-maprow-info');
      info.createDiv({ cls: 'se-map-name', text: label });
      info.createDiv({ cls: 'se-map-file', text: `${image ? image.split('/').pop()! : 'blank sheet'}${sub ? ' · ' + sub : ''}` });
      const acts = row.createDiv('se-maprow-acts');
      acts.createEl('button', { cls: 'se-hb', text: image ? 'Change…' : 'Choose…' }).onclick = pick;
      if (image && clear) { const cl = acts.createEl('button', { cls: 'se-hb se-ghost', text: 'Clear' }); cl.onclick = clear; }
      extra?.(acts);
    };
    mapRow('World', '', p.data.map, () => this.pickMap(p), () => { p.data.map = null; p.saveSoon(); this.renderSetup(p); });
    for (const m of p.data.maps) {
      mapRow(m.name, `inside ${p.get(m.anchor)?.name ?? '?'}`, m.image, () => this.pickMap(p, m.id), () => { m.image = null; p.saveSoon(); this.renderSetup(p); }, acts => {
        acts.createEl('button', { cls: 'se-hb', text: 'Open' }).onclick = () => this.openMap(m.id);
        const d2 = acts.createEl('button', { cls: 'se-x', text: '×' }); 
        confirmClick(d2, 'Sure?', () => { if (this.mapId === m.id) this.openMap(M.MAIN_MAP); p.removeMap(m.id); this.renderSetup(p); });
      });
    }
    if (!p.data.maps.length) c.createDiv({ cls: 'se-sub', text: 'Inside maps: right-click a location.' });
    const gr = c.createDiv('se-maprow se-fold-at');
    gr.createDiv({ cls: 'se-map-name', text: 'Fold locations below' });
    const ga = gr.createDiv('se-maprow-acts');
    const gi = ga.createEl('input', { cls: 'se-num' }); gi.type = 'number'; gi.min = '0'; gi.max = '2400'; gi.step = '25'; gi.value = String(p.data.ui.groupBelow ?? 200);
    ga.createSpan({ cls: 'se-faint', text: '% zoom' });
    gi.onchange = () => { const v = Number(gi.value); if (Number.isFinite(v) && v >= 0) { p.data.ui.groupBelow = v; p.saveQuiet(); this.renderMap(p); } };

    const others = [...this.plugin.projects.values()].filter(o => o !== p);
    if (others.length) {
      head('Copy from another story', 'Adds the types and themes this story doesn’t have.');
      const r = c.createDiv('se-acts se-start');
      const s = r.createEl('select', { cls: 'dropdown' }); for (const o of others) s.createEl('option', { text: o.name, value: o.folder });
      r.createEl('button', { cls: 'se-hb', text: 'Copy' }).onclick = () => { const o = this.plugin.projects.get(s.value); if (o) { p.copyDefinitionsFrom(o); new Notice(`Copied definitions from “${o.name}”.`); this.renderSetup(p); } };
    }
    root.scrollTop = scroll;
  }

  /* ───────── timeline ───────── */

  private xOf(s: number) { const bands = this.tl?.t.bands ?? []; let x = LEFT + s * this.px; for (const b of bands) if (b.moment.skip && b.start <= s && b.start > 0) x += gapOf(b.moment); return x; }
  private totalW() { return this.xOf(this.tl?.t.slots ?? 0) + 40; }
  private sceneAtSlot(slot: number) { const l = this.tl?.scenes.filter(s => s.slot === slot) ?? []; return l.filter(s => s.kind !== 'flashback').sort((a, b) => a.order - b.order)[0] ?? l[0]; }
  private renderTimeline(p: Project) {
    const tl = this.tl!, t = tl.t, el2 = this.r.tlEl;
    if (!tl.scenes.length) {
      el2.style.width = ''; el2.innerHTML = `<div class="se-empty se-pad">No chapters yet. Chapters are notes with the book look inside this story's folder. Use “Story Engine: New chapter”, or turn the book look on for a note.</div>`;
      this.drawOverview(); return;
    }
    if (!this.px) { const w = this.r.wrap.clientWidth || 800; this.px = Math.max(6, Math.min(30, (w - LEFT - 50) / t.slots)); }
    const W = this.totalW(), cur = p.current(tl), ui = p.data.ui, px = this.px;
    let h = `<div class="se-ruler" style="width:${W}px">`;
    for (const b of t.bands) {
      const nextSkip = t.bands.find(o => o.moment.skip && o.start === b.end && o.start > 0);
      const a = this.xOf(b.start), w = this.xOf(b.end) - a - (nextSkip ? gapOf(nextSkip.moment) : 0), g = gapOf(b.moment), mid = esc(b.moment.id);
      if (b.moment.skip && b.start > 0) h += `<div class="se-skip" data-gap="${mid}" style="left:${a - g}px;width:${g}px"></div><div class="se-skiplabel" data-gap="${mid}" style="left:${a - g / 2}px">⤳ ${esc(M.skipLabel(b.moment))}</div>`;
      h += `<div class="se-band" data-moment="${esc(b.moment.id)}" style="left:${a}px;width:${w}px">${w > 30 ? esc(b.moment.label) : ''}</div>`;
      h += `<div class="se-edge" data-moment="${esc(b.moment.id)}" style="left:${a - 4}px"></div>`;
    }
    if (px >= 6) for (let s = 0; s < t.slots; s++) h += `<div class="se-tick" style="left:${this.xOf(s)}px"></div>`;
    h += `</div>`;
    for (const b of t.bands) if (b.moment.skip && b.start > 0) h += `<div class="se-skipline" style="left:${this.xOf(b.start) - gapOf(b.moment)}px;width:${gapOf(b.moment)}px"></div>`;
    const head = (key: string, label: string) => `<div class="se-sec"><span class="se-grip" draggable="true" data-grip="${key}">⋮⋮</span><span class="se-tw" data-tw="${key}">${ui.open[key] ? '▾' : '▸'} ${esc(label)}</span></div>`;
    const order = [...ui.order.filter(k => k in SECTION_LABEL), ...Object.keys(SECTION_LABEL).filter(k => !ui.order.includes(k))];
    for (const key of order) {
      h += `<div class="se-section" data-section="${key}">`;
      if (key === 'scenes') {
        h += head(key, this.say(SECTION_LABEL[key]));
        if (ui.open[key]) {
          h += `<div class="se-track" style="width:${W}px;height:${ROWS * ROW_H + 8}px">`;
          const bySlot = new Map<number, SceneEntry[]>();
          for (const s of tl.scenes) (bySlot.get(s.slot) ?? bySlot.set(s.slot, []).get(s.slot)!).push(s);
          for (const [slot, list] of bySlot) {
            const vis = list.slice(0, ROWS); if (cur && list.includes(cur) && !vis.includes(cur)) vis[ROWS - 1] = cur;
            vis.forEach((s, k) => {
              const pov = s.pov ? p.get(s.pov) : undefined;
              const kind = s.kind === 'flashback' ? ' · flashback' : s.kind === 'parallel' ? ` · same time as ${this.words.scene.toLowerCase()} ${s.ref ?? ''}` : '';
              h += `<div class="se-clip ${s === cur ? 'is-cur' : ''} ${s.kind === 'flashback' ? 'is-flash' : ''} ${pov ? '' : 'is-nopov'}" data-scene="${s.order}" style="--c:${pov ? this.povColor.get(pov.id) : '#8a8794'};left:${this.xOf(slot) + 1}px;top:${4 + k * ROW_H}px;width:${Math.max(5, px - 2)}px" title="Scene ${s.order} · ${esc(s.label)}${pov ? ' · ' + esc(pov.name) : ' · no POV set'}${kind}\nClick: show on the map · double-click: open it">${px >= 22 ? s.order : ''}</div>`;
            });
            if (list.length > ROWS) h += `<div class="se-more" style="left:${this.xOf(slot) + 1}px;top:${4 + ROWS * ROW_H - 2}px">+${list.length - ROWS}</div>`;
          }
          h += `</div>`;
        }
      } else if (key === 'events') {
        const evs = this.events(p);
        h += head(key, `${this.say(SECTION_LABEL[key])}${evs.length ? ' · ' + evs.length : ''}`);
        if (ui.open[key]) h += `<div class="se-track" style="width:${W}px;height:22px">` + evs.map(ev => `<div class="se-ev" data-id="${esc(ev.p.id)}" data-scene="${ev.order}" data-t="${esc(ev.p.name)}${ev.place ? ' · ' + esc(ev.place) : ''}" style="left:${this.xOf(ev.slot) + px / 2}px"></div>`).join('') + `</div>`;
      } else {
        const sel = p.get(this.card);
        const who = [...this.povColor.keys(), ...(sel && p.behaviour(sel) === 'token' && !this.povColor.has(sel.id) ? [sel.id] : [])].filter(id => p.get(id));
        h += head(key, `${this.say(SECTION_LABEL[key])} (POV characters${who.length > this.povColor.size ? ' + selected' : ''})`);
        if (ui.open[key]) {
          const at = new Map<string, (string | null)[]>();
          for (const id of who) { const x = p.get(id)!; at.set(id, Array.from({ length: t.slots }, (_, s) => p.where(x, s)?.place ?? null)); }
          const used = [...new Set([...at.values()].flat().filter((v): v is string => !!v && !!p.get(v)))].sort((a, b) => p.get(a)!.name.localeCompare(p.get(b)!.name));
          if (!used.length) h += `<div class="se-empty se-pad">Story lines appear once POV characters are at places.</div>`;
          else {
            const laneH = 16, H = used.length * laneH + 10, yOf = (pl: string) => 6 + used.indexOf(pl) * laneH + laneH / 2;
            h += `<div class="se-sl" style="width:${W}px;height:${H}px">`;
            used.forEach((pl, k) => { h += `<div class="se-lane" style="top:${6 + k * laneH + laneH / 2}px"></div><div class="se-pl" style="top:${6 + k * laneH + 1}px">${esc(p.get(pl)!.name)}</div>`; });
            let paths = '';
            who.forEach((id, k) => {
              const off = (k - who.length / 2) * 0.9; let d = '', pen = false;
              const list = at.get(id)!;
              for (let s = 0; s < t.slots; s++) {
                const pl = list[s]; const skipHere = t.bands.some(b => b.moment.skip && b.start === s && s > 0);
                if (!pl || skipHere) pen = false; if (!pl) continue;
                d += `${pen ? ' L' : ' M'}${(this.xOf(s) + px / 2).toFixed(1)} ${(yOf(pl) + off).toFixed(1)}`; pen = true;
              }
              if (!d) return;
              const strong = cur?.pov === id || this.card === id;
              paths += `<path d="${d}" fill="none" stroke="${this.povColor.get(id) ?? '#fff'}" stroke-width="${strong ? 3 : 1.4}" opacity="${strong ? 1 : 0.5}" stroke-linejoin="round"><title>${esc(p.get(id)!.name)}</title></path>`;
            });
            h += `<svg width="${W}" height="${H}">${paths}</svg></div>`;
          }
        }
      }
      h += `</div>`;
    }
    el2.style.width = `${W}px`;
    el2.innerHTML = h;
    if (cur) { const ph = el2.createDiv('se-playhead'); ph.style.left = `${this.xOf(cur.slot) + px / 2 - 1}px`; ph.style.height = `${el2.scrollHeight}px`; }
    this.renderCaption(p);
    this.drawOverview();
  }
  /** The scene that moves story time on at a slot (the only kind that can start a moment). */
  private startSceneAt(slot: number) { return this.tl?.scenes.find(s => s.slot === slot && s.kind === 'next'); }
  private closeMomentBox() { this.contentEl.querySelector('.se-momentbox')?.remove(); }
  /** Small editor under a moment on the ruler: name, note, time skip, delete. */
  private editMoment(id: string, anchor: HTMLElement) {
    const p = this.project, m = p?.moment(id); if (!p || !m) return;
    this.closeMomentBox();
    const box = this.contentEl.createDiv('se-momentbox');
    const r = anchor.getBoundingClientRect(), c = this.contentEl.getBoundingClientRect();
    box.style.left = `${Math.max(8, Math.min(r.left - c.left, c.width - 300))}px`;
    const changed = () => { p.invalidateScenes(); p.saveSoon(); };
    const name = box.createEl('input', { cls: 'se-namefield' }); name.value = m.label; name.placeholder = this.say('Moment name');
    name.oninput = () => { const v = name.value.trim(); if (v) { m.label = v; changed(); } };
    const note = box.createEl('input'); note.value = m.note; note.placeholder = 'Note (optional)';
    note.oninput = () => { m.note = note.value.trim(); changed(); };
    const skl = box.createDiv({ cls: 'se-sub', text: 'Time skip before it (optional)' }); skl.style.margin = '2px 0 -3px';
    const sk = box.createEl('input'); sk.value = m.skipText ?? ''; sk.placeholder = 'e.g. Two years later';
    sk.oninput = () => { const v = sk.value.trim(); m.skip = !!v; if (v) m.skipText = v; else delete m.skipText; changed(); };
    const band = this.tl?.t.bands.find(b => b.moment.id === id), start = band && this.startSceneAt(band.start);
    if (band && start) box.createDiv({ cls: 'se-sub', text: this.say(`Starts at scene ${start.order} · ${band.end - band.start} scene${band.end - band.start > 1 ? 's' : ''} long. Drag its left edge on the ruler to change that.`) });
    const acts = box.createDiv('se-acts');
    const del = acts.createEl('button', { cls: 'se-hb se-ghost se-left', text: this.say('Delete moment') });
    
    confirmClick(del, 'Sure? Click again', () => { this.closeMomentBox(); void p.deleteMoment(id); });
    const done = acts.createEl('button', { cls: 'se-hb mod-cta', text: 'Done' }); done.onclick = () => this.closeMomentBox();
    box.onkeydown = e => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeMomentBox(); } };
    box.style.top = `${r.bottom - c.top + 6}px`;
    if (box.offsetTop + box.offsetHeight > c.height - 8) box.style.top = `${r.top - c.top - box.offsetHeight - 6}px`;
    name.focus(); name.select();
  }
  private events(p: Project) {
    const tl = this.tl!, out: { p: M.Piece; slot: number; order: number; place: string }[] = [];
    for (const x of p.all()) {
      if (p.behaviour(x) !== 'event') continue;
      for (const e of p.data.track[x.id] ?? []) {
        const sc = tl.scenes.find(s => s.id === e.s); if (!sc) continue;
        out.push({ p: x, slot: sc.slot, order: sc.order, place: e.place ? p.get(e.place)?.name ?? '' : '' });
      }
    }
    return out;
  }
  /** The caption at the bottom of the map: the jump (if any), whose POV, where they are, the scene and the moment. Double-click: focus on their place. */
  private renderCaption(p: Project) {
    const tag = this.r.tag; tag.empty();
    const tl = this.tl, cur = tl ? p.current(tl) : undefined;
    if (!tl?.scenes.length) { tag.setText('No chapters yet'); return; }
    if (!cur) return;
    if (this.jump) { tag.createSpan({ cls: 'se-jump', text: this.jump }); tag.appendText(' · '); }
    const pv = cur.pov ? p.get(cur.pov) : undefined;
    const w = pv ? p.where(pv, cur.slot) : null, at = w?.place ? p.get(w.place) : undefined;
    if (pv) {
      const s = tag.createSpan('se-pv'); s.style.setProperty('--c', this.povColor.get(pv.id) ?? '#fff'); s.createEl('i'); s.createEl('b', { text: pv.name });
      tag.appendText(`'s POV${at ? ` · at ${at.name}` : ''} · `);
    }
    tag.appendText(`${this.words.scene} ${cur.order} of ${tl.scenes.length} · ${cur.label}${cur.band ? ' · ' + cur.band.moment.label : ''}`);
    tag.toggleClass('is-focusable', !!pv);
  }
  get followMap() { return this.project?.data.ui.followMap !== false; }
  private setFollowMap(on: boolean) {
    const p = this.project; if (!p) return;
    p.data.ui.followMap = on; p.saveQuiet();
    if (on) this.switchMap(p.sceneMap(p.current(this.tl)));
    void this.render();
  }
  /** Zoom the map so this shape fills a good part of it. */
  private zoomToShape(poly: M.Point[]) {
    const xs = poly.map(q => q.x * this.SW), ys = poly.map(q => q.y * this.SH);
    const bw = Math.max(...xs) - Math.min(...xs) || 1, bh = Math.max(...ys) - Math.min(...ys) || 1;
    const W = this.r.map.clientWidth, H = this.r.map.clientHeight;
    const z = Math.min(this.fitZoom() * 24, Math.max(this.fitZoom(), Math.min(W / (bw * 1.8), H / (bh * 1.8))));
    this.zoom = z; this.tx = W / 2 - (Math.max(...xs) + Math.min(...xs)) / 2 * z; this.ty = H / 2 - (Math.max(...ys) + Math.min(...ys)) / 2 * z; this.applyView();
  }
  /** Double-click the caption: go to the POV's place (on whichever map it is) and follow the scene again. */
  focusPov() {
    const p = this.project, tl = this.tl; if (!p || !tl) return;
    const cur = p.current(tl), pv = cur?.pov ? p.get(cur.pov) : undefined; if (!cur || !pv) return;
    const w = p.where(pv, cur.slot) as M.TrackEntry | null; if (!w) { new Notice(this.say(`${pv.name} isn't on the map in this scene.`)); return; }
    const map = w.place ? M.mapOfPlace(p.data, w.place) : w.m || M.MAIN_MAP;
    p.data.ui.followMap = true; p.saveQuiet();
    const go = () => {
      const poly = w.place ? M.areaOf(p.data, w.place) : w.pt ? M.circlePoly(w.pt, M.DEFAULT_RADIUS * 2, 16, M.aspectOf(p.data, map)) : null;
      if (poly) this.zoomToShape(poly);
      this.renderMap(p); this.renderAreas();
    };
    if (map !== this.mapId) { this.switchMap(map); void this.render().then(() => window.setTimeout(go, 60)); } else go();
  }
  private describeJump(from: number, to: SceneEntry) {
    const tl = this.tl!, p = this.project!;
    if (to.slot === from) return to.kind === 'flashback' ? '↶ Flashback' : '';
    if (to.kind === 'flashback') return '↶ Flashback';
    const skip = tl.t.bands.find(b => b.moment.skip && to.slot >= b.start && from < b.start);
    if (skip) return `⤳ ${M.skipLabel(skip.moment)}`;
    if (to.slot < from) {
      const par = to.ref ? tl.scenes[to.ref - 1] : tl.scenes.filter(s => s.slot === to.slot && s.order < to.order).pop();
      const pov = par?.pov ? p.get(par.pov)?.name.split(' ')[0] : '';
      return `↶ Earlier · ${par ? `alongside ${par.label}${pov ? ` (${pov})` : ''}` : 'parallel chapter'}`;
    }
    if (to.slot > from + 1) return '⤳ Later';
    return '';
  }
  private stepScene(d: number) { const p = this.project, tl = this.tl; if (!p || !tl?.scenes.length) return; const cur = p.current(tl); p.setView(Math.max(1, Math.min(tl.scenes.length, (cur?.order ?? 1) + d))); }
  private stepMoment(d: number) {
    const p = this.project, tl = this.tl; if (!p || !tl?.scenes.length) return;
    const cur = p.current(tl)!;
    const bands = tl.t.bands;
    if (!bands.length) {
      // No named moments yet: jump chapter by chapter.
      const firsts = tl.scenes.filter(s => s.index === 0);
      const i = firsts.findIndex(s => s.file === cur.file);
      const target = d > 0 ? firsts[i + 1] : cur.index > 0 ? firsts[i] : firsts[i - 1];
      if (target) p.setView(target.order);
      return;
    }
    const ci = bands.findIndex(b => b.start <= cur.slot && cur.slot < b.end);
    let target: M.MomentBand | undefined;
    if (d > 0) target = ci < 0 ? bands.find(b => b.start > cur.slot) : bands[ci + 1];
    else target = ci < 0 ? [...bands].reverse().find(b => b.end <= cur.slot) : cur.slot > bands[ci].start ? bands[ci] : bands[ci - 1];
    // Before the first named moment, going back means the start of the story.
    const sc = target ? this.sceneAtSlot(target.start) : d < 0 ? this.sceneAtSlot(0) : undefined;
    if (sc) p.setView(sc.order);
  }
  private keepVisible() {
    if (this.r.dock.hasClass('is-small') || !this.tl) return;
    const cur = this.project?.current(this.tl); if (!cur) return;
    const x = this.xOf(cur.slot), w = this.r.wrap, L = w.scrollLeft, R = L + w.clientWidth;
    if (x < L + LEFT + 10 || x > R - 60) w.scrollLeft = x - w.clientWidth / 2;
    this.drawOverview();
  }
  private ovX(s: number) { const w = this.r.ov.clientWidth, total = this.totalW() - 40 - LEFT; return total > 0 ? (this.xOf(s) - LEFT) / total * w : 0; }
  private drawOverview() {
    const tl = this.tl, p = this.project; if (!tl || !p || !this.r) return;
    const ov = this.r.ov, cv = this.r.ovc, w = ov.clientWidth, h = ov.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!w || !h) return;
    cv.width = w * dpr; cv.height = h * dpr;
    const g = cv.getContext('2d'); if (!g) return;
    g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
    for (const b of tl.t.bands) { const a = this.ovX(b.start); g.fillStyle = '#ffffff0a'; g.fillRect(a, 0, this.ovX(b.end) - a - 1, h); if (b.moment.skip && b.start > 0) { g.fillStyle = '#f2c94c66'; g.fillRect(a - 3, 0, 3, h); } }
    for (const s of tl.scenes) { g.fillStyle = s.kind === 'flashback' ? '#b8a27a' : (s.pov && this.povColor.get(s.pov)) || '#8a8794'; g.globalAlpha = 0.8; g.fillRect(this.ovX(s.slot), 4, Math.max(1, this.ovX(s.slot + 1) - this.ovX(s.slot) - 0.5), h - 12); }
    g.globalAlpha = 1; g.fillStyle = '#e07a86';
    for (const ev of this.events(p)) g.fillRect(this.ovX(ev.slot), h - 5, 2, 4);
    const cur = p.current(tl);
    this.r.ovHead.style.left = `${this.ovX((cur?.slot ?? 0) + 0.5)}px`;
    const win = this.r.ovWin;
    win.style.display = '';
    const total = this.totalW() - 40 - LEFT, wr = this.r.wrap;
    const a = Math.max(0, wr.scrollLeft / total * w), b = Math.min(w, (wr.scrollLeft + wr.clientWidth - LEFT) / total * w);
    win.style.left = `${a}px`; win.style.width = `${Math.max(6, b - a)}px`;
  }
  private slotFromOverview(cx: number) {
    const r = this.r.ov.getBoundingClientRect(), x = cx - r.left; let best = 0, d = Infinity;
    for (let s = 0; s < (this.tl?.t.slots ?? 0); s++) { const dd = Math.abs(this.ovX(s + 0.5) - x); if (dd < d) { d = dd; best = s; } }
    return best;
  }
  private slotAt(cx: number) { const r = this.r.tlEl.getBoundingClientRect(), x = cx - r.left; let best = 0; for (let s = 0; s < (this.tl?.t.slots ?? 0); s++) if (this.xOf(s) <= x) best = s; return best; }
  private goSlot(slot: number) { const p = this.project, sc = this.sceneAtSlot(slot); if (p && sc && sc.order !== p.current(this.tl)?.order) p.setView(sc.order); }
  private tlZoom(f: number, cx?: number) {
    if (!this.tl?.scenes.length) return;
    const wr = this.r.wrap, r = wr.getBoundingClientRect(), at = cx ?? r.left + wr.clientWidth / 2;
    const s = this.slotAt(at), onScreen = this.xOf(s) - wr.scrollLeft;
    this.px = Math.max(2, Math.min(80, this.px * f));
    const p = this.project; if (p) this.renderTimeline(p);
    wr.scrollLeft = this.xOf(s) - onScreen; this.drawOverview();
  }
  private tlFit() {
    const tl = this.tl; if (!tl?.scenes.length) return;
    const skips = tl.t.bands.filter(b => b.moment.skip && b.start > 0).reduce((n, b) => n + gapOf(b.moment), 0);
    this.px = Math.max(2, (this.r.wrap.clientWidth - LEFT - 50 - skips) / tl.t.slots);
    const p = this.project; if (p) this.renderTimeline(p);
    this.r.wrap.scrollLeft = 0; this.drawOverview();
  }
  private wireTimeline() {
    const tl = this.r.tlEl, wrap = this.r.wrap, ov = this.r.ov;
    tl.addEventListener('click', e => {
      const p = this.project; if (!p) return;
      const t = e.target as HTMLElement;
      const clip = t.closest('.se-clip') as HTMLElement | null; if (clip) { p.setView(Number(clip.dataset.scene)); return; }
      const ev = t.closest('.se-ev') as HTMLElement | null; if (ev) { this.card = ev.dataset.id ?? null; p.setView(Number(ev.dataset.scene)); return; }
      const tw = t.closest('[data-tw]') as HTMLElement | null; if (tw) { const k = tw.dataset.tw!; p.data.ui.open[k] = !p.data.ui.open[k]; p.saveQuiet(); this.renderTimeline(p); }
    });
    tl.addEventListener('dblclick', e => {
      const clip = (e.target as HTMLElement).closest('.se-clip') as HTMLElement | null;
      const s = clip && this.tl?.scenes[Number(clip.dataset.scene) - 1];
      if (s) void this.openScene(s);
    });
    let dragKey: string | null = null;
    tl.addEventListener('dragstart', e => { const g = (e.target as HTMLElement).closest('[data-grip]') as HTMLElement | null; if (!g) return; dragKey = g.dataset.grip!; e.dataTransfer?.setData('text/plain', dragKey); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; g.closest('.se-section')?.addClass('is-dragging'); });
    tl.addEventListener('dragover', e => { if (!dragKey) return; e.preventDefault(); tl.querySelectorAll('.is-drop-before').forEach(n => n.removeClass('is-drop-before')); (e.target as HTMLElement).closest('.se-section')?.addClass('is-drop-before'); });
    tl.addEventListener('drop', e => {
      e.preventDefault();
      const p = this.project, t = ((e.target as HTMLElement).closest('.se-section') as HTMLElement | null)?.dataset.section;
      if (p && dragKey && t && t !== dragKey) { const o = p.data.ui.order.filter(k => k !== dragKey); o.splice(o.indexOf(t), 0, dragKey); p.data.ui.order = o; p.saveQuiet(); }
      dragKey = null; if (p) this.renderTimeline(p);
    });
    tl.addEventListener('dragend', () => { dragKey = null; const p = this.project; if (p) this.renderTimeline(p); });
    // On the ruler: drag to scrub, click a moment to edit it, drag a moment's edge to move where it starts.
    let scrub = false, band: { id: string; x: number; el: HTMLElement } | null = null, gap: { m: M.Moment; x: number; g0: number } | null = null, lastGap: { id: string; at: number } | null = null;
    let edge: { id: string; el: HTMLElement; min: number; max: number; slot: number; start: number } | null = null;
    tl.addEventListener('pointerdown', e => {
      const t = e.target as HTMLElement;
      if (!t.closest('.se-ruler')) return;
      tl.setPointerCapture(e.pointerId);
      const ed = t.closest('.se-edge') as HTMLElement | null;
      if (ed && this.tl) {
        const bands = this.tl.t.bands, i = bands.findIndex(x => x.moment.id === ed.dataset.moment); if (i < 0) return;
        edge = { id: bands[i].moment.id, el: ed, min: i > 0 ? bands[i - 1].start + 1 : 0, max: bands[i].end - 1, slot: bands[i].start, start: bands[i].start };
        ed.addClass('is-dragging'); e.preventDefault(); return;
      }
      const gp = t.closest('[data-gap]') as HTMLElement | null, gm = gp && this.project?.moment(gp.dataset.gap);
      if (gm) {
        // Two quick presses on the gap put it back to its normal width.
        const now = Date.now();
        if (lastGap?.id === gm.id && now - lastGap.at < 400) { lastGap = null; delete gm.gap; this.project?.saveQuiet(); const p = this.project; if (p) this.renderTimeline(p); return; }
        lastGap = { id: gm.id, at: now };
        gap = { m: gm, x: e.clientX, g0: gapOf(gm) }; e.preventDefault(); return;
      }
      const bd = t.closest('.se-band') as HTMLElement | null;
      if (bd) { band = { id: bd.dataset.moment!, x: e.clientX, el: bd }; return; }
      scrub = true; this.goSlot(this.slotAt(e.clientX));
    });
    tl.addEventListener('pointermove', e => {
      if (gap) {
        const g = Math.round(Math.min(800, Math.max(16, gap.g0 + e.clientX - gap.x)));
        if (g !== gapOf(gap.m)) { gap.m.gap = g; const p = this.project; if (p) this.renderTimeline(p); }
        return;
      }
      if (edge) {
        const x = e.clientX - tl.getBoundingClientRect().left; let best = edge.min;
        for (let s = edge.min; s <= edge.max; s++) if (Math.abs(this.xOf(s) - x) < Math.abs(this.xOf(best) - x)) best = s;
        edge.slot = best; edge.el.style.left = `${this.xOf(best) - 4}px`;
        const sc = this.startSceneAt(best); edge.el.dataset.tip = sc ? `starts at ${this.words.scene.toLowerCase()} ${sc.order}` : '';
        return;
      }
      if (band && Math.abs(e.clientX - band.x) > 4) { band = null; scrub = true; }
      if (scrub) this.goSlot(this.slotAt(e.clientX));
    });
    tl.addEventListener('pointerup', () => {
      const p = this.project;
      if (gap) { gap = null; p?.saveQuiet(); return; }
      if (edge && p) {
        const ed = edge; edge = null; ed.el.removeClass('is-dragging');
        const sc = this.startSceneAt(ed.slot);
        if (ed.slot !== ed.start && sc) void p.startMoment(sc, ed.id);
      }
      if (band) this.editMoment(band.id, band.el);
      band = null; scrub = false;
    });
    // Wheel: up/down by default, Shift = sideways (both native), Ctrl = zoom.
    wrap.addEventListener('wheel', e => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); this.tlZoom(e.deltaY < 0 ? 1.25 : 0.8, e.clientX); }, { passive: false });
    wrap.addEventListener('scroll', () => this.drawOverview());
    let ovDrag = false;
    ov.addEventListener('pointerdown', e => { ovDrag = true; ov.setPointerCapture(e.pointerId); this.goSlot(this.slotFromOverview(e.clientX)); });
    ov.addEventListener('pointermove', e => { if (ovDrag) this.goSlot(this.slotFromOverview(e.clientX)); });
    ov.addEventListener('pointerup', () => { ovDrag = false; });
    ov.addEventListener('dblclick', () => this.tlFit());
    // Hover a scene on the strip: what it is, and what happens in it.
    ov.addEventListener('pointermove', e => {
      const p = this.project, tl = this.tl; if (!p || !tl?.scenes.length || ovDrag) return;
      const slot = this.slotFromOverview(e.clientX), here = tl.scenes.filter(x => x.slot === slot);
      const evs = this.events(p).filter(ev => ev.slot === slot).map(ev => ev.p.name);
      ov.title = here.map(sc => `${this.words.scene} ${sc.order} · ${sc.label}${sc.pov && p.get(sc.pov) ? ' · ' + p.get(sc.pov)!.name : ''}${sc.kind === 'flashback' ? ' (flashback)' : ''}`).join('\n')
        + (evs.length ? `\n⚑ ${evs.join('\n⚑ ')}` : '') + '\n(click or drag to go there · double-click to fit the timeline)';
    });
  }
}

/** The built-in icons in a grid (grouped), plus an image from the vault, or none. */
class IconPicker extends Modal {
  constructor(app: import('obsidian').App, private name: string, private current: string | null, private chosen: (ref: string | null) => void) { super(app); }
  onOpen() {
    this.modalEl.addClass('se-icon-modal');
    this.titleEl.setText(`Icon for ${this.name}`);
    const c = this.contentEl; c.empty();
    for (const group of ['Buildings', 'Inside', 'Outside'] as const) {
      c.createDiv({ cls: 'se-icon-h', text: group === 'Inside' ? 'Inside buildings' : group === 'Outside' ? 'Land and water' : 'Buildings and settlements' });
      const grid = c.createDiv('se-icon-grid');
      for (const ic of BUILTIN_ICONS.filter(i => i.group === group)) {
        const ref = BUILTIN_PREFIX + ic.id;
        const b = grid.createEl('button', { cls: `se-icon-opt ${this.current === ref ? 'is-on' : ''}` }); b.dataset.icon = ic.id;
        const im = b.createEl('img'); im.src = builtinSrc(ref); im.alt = '';
        b.createSpan({ text: ic.label });
        b.onclick = () => { this.close(); this.chosen(ref); };
      }
    }
    const acts = c.createDiv('se-acts se-start');
    const vault = acts.createEl('button', { cls: 'se-hb', text: 'An image from your vault…' });
    vault.onclick = () => { this.close(); new ImagePicker(this.app, f => this.chosen(f.path)).open(); };
    if (this.current) { const none = acts.createEl('button', { cls: 'se-hb se-ghost', text: 'No icon (a plain dot)' }); none.onclick = () => { this.close(); this.chosen(null); }; }
  }
  onClose() { this.contentEl.empty(); }
}
class ImagePicker extends FuzzySuggestModal<TFile> {
  constructor(app: import('obsidian').App, private chosen: (f: TFile) => void) { super(app); this.setPlaceholder('Choose your map image…'); }
  getItems() { return this.app.vault.getFiles().filter(f => IMAGE_EXT.has(f.extension.toLowerCase())); }
  getItemText(f: TFile) { return f.path; }
  onChooseItem(f: TFile) { this.chosen(f); }
}

export class FolderPicker extends FuzzySuggestModal<TFolder> {
  constructor(app: import('obsidian').App, private chosen: (f: TFolder) => void) { super(app); this.setPlaceholder('Which folder holds this story\'s chapters?'); }
  getItems() { return this.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder && f.path !== '/' && !f.path.split('/').includes('World')); }
  getItemText(f: TFolder) { return f.path; }
  onChooseItem(f: TFolder) { this.chosen(f); }
}
