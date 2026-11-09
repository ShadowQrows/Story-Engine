/**
 * Story Engine — data model (pure; no Obsidian imports so it can be unit tested).
 *
 * A story ("project") is a folder holding chapter notes, a `World/` folder with one note per piece,
 * and `story-engine.json` (types, connection types, themes, named moments, where pieces are, map positions, book look).
 *
 * Story time is measured in scenes. Every scene (a chapter opening or a ✦ break) gets one slot, in reading order.
 * A scene's hidden comment can change that:
 *   moment=<id>   this scene starts a named moment (a band on the timeline; may be a time skip)
 *   with=<scene>  it happens at the same time as another scene (a parallel chapter: same slot)
 *   flash=<scene or moment>  it's a flashback to that point (same slot as the target, marked as a flashback)
 * Where pieces are is recorded per scene ("from this scene on"), so the map can change scene by scene.
 */
import { classify, STYLE_MARK } from './manuscript';

/* ───────── Definitions: piece types, connection types, themes ───────── */

export type Behaviour = 'token' | 'place' | 'event';
export interface PieceType { id: string; label: string; plural: string; color: string; behaviour: Behaviour; folder: string }
export const DEFAULT_TYPES: PieceType[] = [
  { id: 'character', label: 'Character', plural: 'Characters', color: '#6ea2f0', behaviour: 'token', folder: 'Characters' },
  { id: 'place', label: 'Location', plural: 'Locations', color: '#4fae84', behaviour: 'place', folder: 'Places' },
  { id: 'faction', label: 'Faction', plural: 'Factions', color: '#d0884a', behaviour: 'token', folder: 'Factions' },
  { id: 'item', label: 'Item', plural: 'Items', color: '#c2a83a', behaviour: 'token', folder: 'Items' },
  { id: 'creature', label: 'Creature', plural: 'Creatures', color: '#a77ad8', behaviour: 'token', folder: 'Creatures' },
  { id: 'event', label: 'Event', plural: 'Events', color: '#d8607a', behaviour: 'event', folder: 'Events' },
];
/** What a piece type does, as the dropdowns say it. */
export const BEHAVIOURS: [Behaviour, string][] = [['token', 'Movable'], ['place', 'Location'], ['event', 'Event']];
export interface LineStyle { id: string; label: string; color: string; dash: 'solid' | 'dashed' | 'dotted'; width: number; arrow: 'none' | 'end' | 'both' }
export const DEFAULT_STYLES: LineStyle[] = [
  { id: 'sibling', label: 'Sibling', color: '#f2f2f2', dash: 'dotted', width: 1.5, arrow: 'none' },
  { id: 'parent', label: 'Parent of', color: '#9ad0ff', dash: 'solid', width: 2, arrow: 'end' },
  { id: 'serves', label: 'Serves', color: '#e2c26b', dash: 'solid', width: 2, arrow: 'end' },
  { id: 'ally', label: 'Ally', color: '#7fc29b', dash: 'solid', width: 2, arrow: 'both' },
  { id: 'enemy', label: 'Enemy', color: '#e07a86', dash: 'dashed', width: 2, arrow: 'both' },
  { id: 'betrayed', label: 'Betrayed', color: '#ff5a6a', dash: 'dashed', width: 2.2, arrow: 'end' },
  { id: 'killed', label: 'Killed', color: '#c0162f', dash: 'solid', width: 3, arrow: 'end' },
  { id: 'lover', label: 'Lover', color: '#f29bd0', dash: 'solid', width: 1.8, arrow: 'both' },
  { id: 'owns', label: 'Owns', color: '#b8a98a', dash: 'dashed', width: 1.5, arrow: 'end' },
  { id: 'member', label: 'Member of', color: '#d0884a', dash: 'dotted', width: 1.4, arrow: 'end' },
  { id: 'involved', label: 'Involved in', color: '#c8b6ff', dash: 'dotted', width: 1.5, arrow: 'none' },
  { id: 'other', label: 'Other', color: '#9a96a0', dash: 'dashed', width: 1.4, arrow: 'none' },
];
/** “Member of” (any capitalisation) makes a piece part of a faction: the catalog groups members under it. */
export const isMembership = (label: string) => /^\s*member\s+of\s*$/i.test(label || '');
export interface Theme { color: string; meaning: string }
export const PALETTE = ['#e9d36b', '#6fd3e0', '#ff8a5c', '#9cf07a', '#f07ad8', '#ffffff', '#8ab4f8', '#ffb86b', '#c3a6ff', '#7fe0b8', '#ff7a9c', '#d4d48a'];
export const DASH: Record<LineStyle['dash'], string> = { solid: '', dashed: '7 4', dotted: '1.5 4' };

/* ───────── Book look ───────── */

/** A paragraph style (like Word's): marked on a paragraph with a hidden `%%style:id%%` at its start. */
export interface ParaStyle { id: string; name: string; color: string /* on your dark writing look */; paperColor: string /* on paper, and in exports */; italic: boolean; align: 'left' | 'center' | 'right'; size: number /* 1 = body size */; spaceBefore: number; spaceAfter: number /* lines of space */ }
export interface BookLook {
  font: string; size: number; lineHeight: number; paraSpace: number; indent: number;
  titleSize: number; dropcapFont: string; dropcapSize: number; pageWidth: number; color: string;
  /** A large first letter at the start of each chapter (off: the first paragraph is like any other opening paragraph). */
  dropcap: boolean;
  /** Paper: the chapter shown as a book page (light background, dark text). */
  paper: boolean; paperBg: string; paperText: string;
  styles: ParaStyle[];
}
export const DEFAULT_LOOK: BookLook = { font: 'Libre Baskerville', size: 11, lineHeight: 1.2, paraSpace: 0, indent: 0.5, titleSize: 2, dropcapFont: 'Old English Text MT', dropcapSize: 6, dropcap: true, pageWidth: 45, color: '', paper: false, paperBg: '#f3ecdc', paperText: '#323232', styles: [] };
/** Book details for exports. */
export interface BookInfo { title: string; author: string; language: string; pageSize?: string; /** PDF: wider margin on the binding side, alternating left/right (for a printed book) */ mirror?: boolean; /** pictures inside chapters go into the book (on unless turned off) */ images?: boolean }
/** Page sizes for the PDF and Word exports (inches), with margins that suit them. */
export const PAGE_SIZES: Record<string, { label: string; w: number; h: number; top: number; bottom: number; inner: number; outer: number }> = {
  '6x9': { label: '6 × 9 in, Trade Paperback', w: 6, h: 9, top: 0.75, bottom: 0.8, inner: 0.8, outer: 0.6 },
  '5.5x8.5': { label: '5.5 × 8.5 in', w: 5.5, h: 8.5, top: 0.7, bottom: 0.75, inner: 0.75, outer: 0.55 },
  '5x8': { label: '5 × 8 in', w: 5, h: 8, top: 0.65, bottom: 0.7, inner: 0.7, outer: 0.5 },
  'A5': { label: 'A5', w: 5.83, h: 8.27, top: 0.7, bottom: 0.75, inner: 0.75, outer: 0.55 },
  'Letter': { label: 'US Letter, Manuscript', w: 8.5, h: 11, top: 1, bottom: 1, inner: 1, outer: 1 },
  'A4': { label: 'A4, Manuscript', w: 8.27, h: 11.69, top: 1, bottom: 1, inner: 1, outer: 1 },
};
export const pageOf = (id?: string) => PAGE_SIZES[id ?? ''] ?? PAGE_SIZES['6x9'];
const HEX = /^#[0-9a-f]{6}$/i;
export const styleId = (name: string, taken: string[]) => { const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'style'; let id = base, n = 2; while (taken.includes(id)) id = `${base}-${n++}`; return id; };
function readStyles(v: unknown): ParaStyle[] {
  if (!Array.isArray(v)) return [];
  const out: ParaStyle[] = [];
  for (const x of v as any[]) {
    if (!x || typeof x.id !== 'string' || !/^[a-z0-9-]+$/.test(x.id) || out.some(o => o.id === x.id)) continue;
    out.push({ id: x.id, name: String(x.name || x.id), color: HEX.test(x.color) ? x.color : '#c9b98f', paperColor: HEX.test(x.paperColor) ? x.paperColor : '#6b4f2a', italic: !!x.italic, align: ['left', 'center', 'right'].includes(x.align) ? x.align : 'left', size: num(x.size, 1, 0.5, 3), spaceBefore: num(x.spaceBefore, 0, 0, 10), spaceAfter: num(x.spaceAfter, 0, 0, 10) });
  }
  return out;
}

/* ───────── The story file ───────── */

export interface Point { x: number; y: number }
export interface TrackEntry { s: string; place?: string; off?: Point /* exact spot, relative to the place */; pt?: Point; m?: string /* map of pt (default: main) */; gone?: boolean; dead?: boolean /* gone because they died */; only?: boolean }
/** A place's spot: on the main map unless `map` names one of the inside maps. */
export interface PlacePos extends Point { map?: string }
/** An inside map (a castle, a city…) opened from a place on another map: its anchor. */
export interface SubMap { id: string; name: string; image: string | null; anchor: string }
/** A roof over a building place, drawn on the map the place is on. Hides what's inside until the POV is in there. */
export interface Roof { x: number; y: number; w: number; h: number; pts?: Point[] /* custom shape; else the rectangle */; image: string | null }
export const MAIN_MAP = 'main';
export interface Moment { id: string; label: string; note: string; skip: boolean; skipText?: string /* how much time passed before it, e.g. “Two years later” (a time skip) */; gap?: number /* drawn width of a time skip's break on the timeline (looks only) */; until?: string /* id of its last scene, when it ends before the next moment starts */ }
/** What a time skip's break says: its own text, or the moment's name for skips made before 2.5. */
export const skipLabel = (m: Moment) => m.skipText || m.label;
export interface ProjectData {
  version: 3;
  /** 2 = one line per paragraph (2.11 on). Older stories (1) are converted once when they open. */
  format: number;
  types: PieceType[];
  styles: LineStyle[];
  themes: Record<string, Theme>;
  moments: Moment[];
  track: Record<string, TrackEntry[]>;   // pieceId → where it is from each scene on
  places: Record<string, PlacePos>;       // place pieces: position on their map (0–1)
  map: string | null;                     // the main map's image
  maps: SubMap[];                         // inside maps
  roofs: Record<string, Roof>;            // building place id → its roof
  areas: Record<string, Point[]>;         // place id → its area's shape on its map (default: a circle around it)
  aspects?: Record<string, number>;       // map id → its picture's width / height (so circles stay round)
  /** What each id was last known as, so a link that breaks (a note that lost its id, a deleted scene setting) can be found again. */
  names?: Record<string, { n: string; t: string }>;            // piece id → its name and type
  sceneKeys?: Record<string, { f: string; i: number; t: string; m?: SceneMeta }>;   // scene id → its chapter file, its number in it, its opening words
  icons: Record<string, string>;          // place id → picture shown when the place folds into its marker
  lines: 'all' | 'selected';
  look: BookLook;
  view: number;                           // reading-order number of the scene the playhead is on (1-based)
  ui: { dock: number; side: number; split: number; order: string[]; open: Record<string, boolean>; sideOpen: boolean; tab: 'pieces' | 'setup'; followMap?: boolean; setupClosed?: string[]; showPieces?: boolean; legend?: boolean; groupBelow?: number; catClosed?: string[]; cardClosed?: string[]; blankOk?: string[] /* maps kept as a blank sheet on purpose */ };
  /** Your own words for “scene” and “moment” (singular and plural), used everywhere in the plugin. */
  words?: Partial<Words>;
  book?: Partial<BookInfo>;
  /** Present only while a story saved by 2.0 is being upgraded. */
  legacy?: { moments: string[]; track: Record<string, { m: string; place?: string; pt?: Point; gone?: boolean; only?: boolean }[]> };
}

export interface Words { scene: string; scenes: string; moment: string; moments: string }
export const DEFAULT_WORDS: Words = { scene: 'Scene', scenes: 'Scenes', moment: 'Moment', moments: 'Moments' };
export const wordsOf = (d: Pick<ProjectData, 'words'>): Words => ({ ...DEFAULT_WORDS, ...Object.fromEntries(Object.entries(d.words ?? {}).filter(([, v]) => typeof v === 'string' && v.trim())) });
/** Put the story's own words for scene(s) / moment(s) into a piece of interface text, keeping its capitalisation. */
export function say(w: Words, text: string): string {
  if (w.scene === 'Scene' && w.scenes === 'Scenes' && w.moment === 'Moment' && w.moments === 'Moments') return text;
  return text.replace(/\b(scenes?|moments?)\b/gi, m => {
    const k = m.toLowerCase() as keyof Words, v = w[k];
    if (m === m.toUpperCase()) return v.toUpperCase();
    if (m[0] === m[0].toUpperCase()) return v.charAt(0).toUpperCase() + v.slice(1);
    return v.toLowerCase();
  });
}
/** A guess at the plural of a word (the user can correct it in Setup). */
export const pluralOf = (w: string) => /[^aeiou]y$/i.test(w) ? w.slice(0, -1) + 'ies' : /(s|x|z|ch|sh)$/i.test(w) ? w + 'es' : w + 's';
export const blankUi = (): ProjectData['ui'] => ({ dock: 300, side: 330, split: 0.55, order: ['scenes', 'events', 'storylines'], open: { scenes: true, events: true, storylines: false }, sideOpen: true, tab: 'pieces' });
export function blankData(): ProjectData {
  return { version: 3, format: 2, types: DEFAULT_TYPES.map(t => ({ ...t })), styles: DEFAULT_STYLES.map(s => ({ ...s })), themes: {}, moments: [], track: {}, places: {}, map: null, maps: [], roofs: {}, areas: {}, icons: {}, lines: 'all', look: { ...DEFAULT_LOOK }, view: 1, ui: blankUi() };
}
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const ptsOk = (v: any): v is Point[] => Array.isArray(v) && v.length >= 3 && v.every((q: any) => q && Number.isFinite(q.x) && Number.isFinite(q.y));
const cp = (q: Point): Point => ({ x: clamp01(q.x), y: clamp01(q.y) });
const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** Accept whatever is on disk (2.0 or 2.1, or hand-edited) and fill in anything missing. */
export function normalizeData(raw: unknown): ProjectData {
  const d = blankData();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, any>;
  d.format = typeof r.format === 'number' ? r.format : 1;
  if (Array.isArray(r.types) && r.types.length) d.types = r.types.filter((t: any) => t && t.id && t.label).map((t: any) => ({ id: String(t.id), label: String(t.label), plural: String(t.plural || t.label + 's'), color: String(t.color || '#999'), behaviour: (['token', 'place', 'event'].includes(t.behaviour) ? t.behaviour : 'token') as Behaviour, folder: String(t.folder || t.plural || t.label) }));
  // 2.7 calls the built-in place type “Location” (only if it still has its old default name).
  for (const t of d.types) if (t.id === 'place' && t.label === 'Place' && (t.plural === 'Places' || !t.plural)) { t.label = 'Location'; t.plural = 'Locations'; }
  if (Array.isArray(r.styles) && r.styles.length) d.styles = r.styles.filter((s: any) => s && s.id && s.label);
  // “Member of” is built in since 2.7 (it groups faction members): add it to older stories that don't have it.
  if (!d.styles.some(s => isMembership(s.label))) d.styles.push({ ...DEFAULT_STYLES.find(s => s.id === 'member')! });
  if (r.book && typeof r.book === 'object') { const bk: Partial<BookInfo> = {}; for (const k of ['title', 'author', 'language', 'pageSize'] as const) if (typeof r.book[k] === 'string') bk[k] = r.book[k]; if (r.book.mirror === true) bk.mirror = true; if (r.book.images === false) bk.images = false; d.book = bk; }
  if (r.words && typeof r.words === 'object') { const w: Partial<Words> = {}; for (const k of ['scene', 'scenes', 'moment', 'moments'] as const) if (typeof r.words[k] === 'string' && r.words[k].trim()) w[k] = r.words[k].trim(); if (Object.keys(w).length) d.words = w; }
  if (r.themes && typeof r.themes === 'object') for (const [k, v] of Object.entries(r.themes)) d.themes[k] = typeof v === 'string' ? { color: v, meaning: '' } : { color: String((v as any)?.color ?? '#fff'), meaning: String((v as any)?.meaning ?? '') };
  if (r.places && typeof r.places === 'object') for (const [k, v] of Object.entries(r.places as Record<string, any>)) if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) d.places[k] = { x: clamp01(v.x), y: clamp01(v.y), ...(typeof v.map === 'string' && v.map !== MAIN_MAP ? { map: v.map } : {}) };
  if (Array.isArray(r.maps)) d.maps = r.maps.filter((m: any) => m && typeof m.id === 'string' && typeof m.anchor === 'string').map((m: any) => ({ id: m.id, name: String(m.name ?? 'Map'), image: typeof m.image === 'string' ? m.image : null, anchor: m.anchor }));
  if (r.roofs && typeof r.roofs === 'object') for (const [k, v] of Object.entries(r.roofs as Record<string, any>)) if (v && [v.x, v.y, v.w, v.h].every(Number.isFinite) && v.w > 0 && v.h > 0) d.roofs[k] = { x: clamp01(v.x), y: clamp01(v.y), w: Math.min(1, v.w), h: Math.min(1, v.h), image: typeof v.image === 'string' ? v.image : null, ...(ptsOk(v.pts) ? { pts: v.pts.map(cp) } : {}) };
  if (r.icons && typeof r.icons === 'object') for (const [k, v] of Object.entries(r.icons as Record<string, any>)) if (typeof v === 'string' && v) d.icons[k] = v;
  if (r.aspects && typeof r.aspects === 'object') { const a: Record<string, number> = {}; for (const [k, v] of Object.entries(r.aspects as Record<string, any>)) if (typeof v === 'number' && v > 0 && Number.isFinite(v)) a[k] = v; if (Object.keys(a).length) d.aspects = a; }
  if (r.names && typeof r.names === 'object') { const n: NonNullable<ProjectData['names']> = {}; for (const [k, v] of Object.entries(r.names as Record<string, any>)) if (v && typeof v.n === 'string') n[k] = { n: v.n, t: String(v.t ?? '') }; d.names = n; }
  if (r.sceneKeys && typeof r.sceneKeys === 'object') { const s: NonNullable<ProjectData['sceneKeys']> = {}; for (const [k, v] of Object.entries(r.sceneKeys as Record<string, any>)) if (v && typeof v.f === 'string' && Number.isFinite(v.i)) s[k] = { f: v.f, i: v.i, t: String(v.t ?? ''), ...(v.m && typeof v.m === 'object' ? { m: Object.fromEntries(Object.entries(v.m).filter(([, x]) => typeof x === 'string')) as SceneMeta } : {}) }; d.sceneKeys = s; }
  if (r.areas && typeof r.areas === 'object') for (const [k, v] of Object.entries(r.areas as Record<string, any>)) if (ptsOk(v)) d.areas[k] = (v as any[]).map(cp);
  if (typeof r.map === 'string') d.map = r.map;
  if (r.lines === 'selected') d.lines = 'selected';
  if (r.look && typeof r.look === 'object') {
    const l = r.look;
    d.look = {
      font: typeof l.font === 'string' && l.font.trim() ? l.font : DEFAULT_LOOK.font, size: num(l.size, DEFAULT_LOOK.size, 8, 40), lineHeight: num(l.lineHeight, DEFAULT_LOOK.lineHeight, 1, 3),
      paraSpace: num(l.paraSpace, 0, 0, 3), indent: num(l.indent, DEFAULT_LOOK.indent, 0, 2), titleSize: num(l.titleSize, DEFAULT_LOOK.titleSize, 1, 4), dropcapFont: typeof l.dropcapFont === 'string' ? l.dropcapFont : DEFAULT_LOOK.dropcapFont,
      dropcapSize: num(l.dropcapSize, DEFAULT_LOOK.dropcapSize, 0, 8), dropcap: l.dropcap !== false, pageWidth: num(l.pageWidth, DEFAULT_LOOK.pageWidth, 20, 120), color: typeof l.color === 'string' ? l.color : DEFAULT_LOOK.color,
      paper: !!l.paper, paperBg: HEX.test(l.paperBg) ? l.paperBg : DEFAULT_LOOK.paperBg, paperText: HEX.test(l.paperText) ? l.paperText : DEFAULT_LOOK.paperText,
      styles: readStyles(l.styles),
    };
  }
  if (r.ui && typeof r.ui === 'object') d.ui = { ...d.ui, ...r.ui, open: { ...d.ui.open, ...(r.ui.open ?? {}) } };
  d.view = num(r.view, 1, 1, 1e6);
  if (r.version === 3 || r.version === undefined && Array.isArray(r.moments) && r.moments.every((m: any) => 'skip' in m)) {
    if (Array.isArray(r.moments)) d.moments = r.moments.filter((m: any) => m && typeof m.id === 'string').map((m: any) => { const label = String(m.label ?? 'Moment'), skipText = typeof m.skipText === 'string' && m.skipText.trim() ? m.skipText.trim() : m.skip ? label : ''; return { id: m.id, label, note: String(m.note ?? ''), skip: !!skipText, ...(skipText ? { skipText } : {}), ...(typeof m.gap === 'number' && m.gap > 0 ? { gap: Math.min(800, Math.max(16, m.gap)) } : {}), ...(typeof m.until === 'string' && m.until ? { until: m.until } : {}) }; });
    if (r.track && typeof r.track === 'object') for (const [k, v] of Object.entries(r.track)) if (Array.isArray(v)) d.track[k] = (v as any[]).filter(e => e && typeof e.s === 'string');
  } else {
    // A 2.0 story: moments were columns and positions were per moment. Keep them for the upgrade step.
    if (Array.isArray(r.moments)) d.moments = r.moments.filter((m: any) => m && typeof m.id === 'string').map((m: any) => ({ id: m.id, label: String(m.label ?? 'Moment'), note: String(m.note ?? ''), skip: false }));
    const legacyTrack: NonNullable<ProjectData['legacy']>['track'] = {};
    if (r.track && typeof r.track === 'object') for (const [k, v] of Object.entries(r.track)) if (Array.isArray(v)) legacyTrack[k] = (v as any[]).filter(e => e && typeof e.m === 'string');
    d.legacy = { moments: d.moments.map(m => m.id), track: legacyTrack };
  }
  // Anything this version doesn't know (written by a newer one) is kept as it was, so saving never drops it.
  const known = new Set([...Object.keys(d), 'book', 'words', 'aspects', 'legacy', 'version', 'names', 'sceneKeys']);
  for (const [k, v] of Object.entries(r)) if (!known.has(k)) (d as unknown as Record<string, unknown>)[k] = v;
  return d;
}

/* ───────── Piece notes ───────── */

export interface Connection { target: string; label: string }
export interface Piece { id: string; path: string; name: string; type: string; aliases: string[]; connections: Connection[]; themes: string[] }

const LINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/;
export const linkTarget = (s: string) => (LINK.exec(s)?.[1] ?? s).trim();
export function parseConnection(s: string): Connection | null {
  const m = LINK.exec(s);
  if (!m) return null;
  const label = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).replace(/^[\s·:—–\-(),]+|[\s·:—–\-(),]+$/g, '').trim();
  return { target: m[1].trim(), label };
}
export const formatConnection = (c: Connection) => c.label ? `[[${c.target}]] · ${c.label}` : `[[${c.target}]]`;
function list(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter(x => x != null && typeof x !== 'object').map(x => String(x).trim()).filter(Boolean);
  return typeof v === 'object' ? [] : String(v).split('\n').map(s => s.trim()).filter(Boolean);
}
/** Type ids are lower-case words; old spellings ("Location", "Characters") map onto the built-in ones. */
export function typeId(v: unknown): string | null {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  const alias: Record<string, string> = { location: 'place', places: 'place', person: 'character', characters: 'character', organization: 'faction', organisation: 'faction', house: 'faction', factions: 'faction', object: 'item', items: 'item', beast: 'creature', creatures: 'creature', events: 'event' };
  return alias[s] ?? s.replace(/\s+/g, '-');
}
export function parsePiece(path: string, basename: string, fm: Record<string, unknown> | null | undefined): Piece | null {
  if (!fm) return null;
  const type = typeId(fm['se-type']);
  const id = typeof fm['se-id'] === 'string' ? fm['se-id'] : null;
  if (!type || !id) return null;
  return { id, path, name: basename, type, aliases: list(fm.aliases ?? fm.alias), connections: list(fm.connections).map(parseConnection).filter((c): c is Connection => !!c), themes: list(fm.themes) };
}
export function newPieceFrontmatter(id: string, type: string, aliases: string[], connections: Connection[]): Record<string, unknown> {
  const fm: Record<string, unknown> = { 'se-id': id, 'se-type': type };
  if (aliases.length) fm.aliases = aliases;
  if (connections.length) fm.connections = connections.map(formatConnection);
  return fm;
}
export function quoteBlock(text: string, source: string | null): string {
  const q = text.trim().split(/\r?\n/).map(l => `> ${l}`).join('\n');
  return source ? `${q}\n> — [[${source}]]` : q;
}
export interface DescBlock { text: string; source: string | null; raw: string }
/** Description blocks of a piece note body: quotes (with their source chapter) and typed paragraphs. */
export function descriptionBlocks(body: string): DescBlock[] {
  const out: DescBlock[] = [];
  for (const block of body.replace(/^---[\s\S]*?\n---\s*/, '').split(/\n\s*\n/)) {
    const b = block.trim();
    if (!b) continue;
    if (b.startsWith('>')) {
      const lines = b.split('\n').map(l => l.replace(/^>\s?/, ''));
      const src = /^—\s*\[\[([^\]|#]+)/.exec(lines[lines.length - 1]);
      out.push({ text: (src ? lines.slice(0, -1) : lines).join('\n').trim(), source: src ? src[1].trim() : null, raw: b });
    } else out.push({ text: b, source: null, raw: b });
  }
  return out;
}
/** Remove one description block (by its exact text) from a note, leaving everything else as it was. */
/** Replace one description block with new text (it stays where it was; same rules as removing one). */
export function replaceBlock(note: string, raw: string, text: string): string {
  const fm = /^---\r?\n[\s\S]*?\r?\n---[^\n]*(?:\n|$)/.exec(note), start = fm ? fm[0].length : 0;
  if (!text.trim()) return note;
  for (let i = note.indexOf(raw, start); i >= 0; i = note.indexOf(raw, i + 1)) {
    const before = note.slice(start, i), after = note.slice(i + raw.length);
    if ((!before.trim() || /\n[ \t]*\r?\n[ \t]*$/.test(before)) && /^[ \t]*(?:\r?\n[ \t]*\r?\n|\s*$)/.test(after)) return note.slice(0, i) + text.trim() + after;
  }
  return note;
}
export function removeBlock(note: string, raw: string): string {
  // Only in the note's text (never its properties), and only where it stands as a whole block of its own.
  const fm = /^---\r?\n[\s\S]*?\r?\n---[^\n]*(?:\n|$)/.exec(note), start = fm ? fm[0].length : 0;
  for (let i = note.indexOf(raw, start); i >= 0; i = note.indexOf(raw, i + 1)) {
    const before = note.slice(start, i), after = note.slice(i + raw.length);
    if ((!before.trim() || /\n[ \t]*\r?\n[ \t]*$/.test(before)) && /^[ \t]*(?:\r?\n[ \t]*\r?\n|\s*$)/.test(after)) {
      const head = before.replace(/\s+$/, ''), rest = after.replace(/^\s+/, '');
      return note.slice(0, start) + (head ? head + (rest ? '\n\n' : '\n') : before) + rest;
    }
  }
  return note;
}

/* ───────── Chapter titles ───────── */

/** Where a note's text starts: the line after its properties block (0 if it has none). */
export function bodyStart(lines: string[]): number {
  if (lines[0]?.trim() !== '---') return 0;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---' || lines[i].trim() === '...') return i + 1;
  return lines.length;
}
/** The note with a “# TITLE” line at the top of its text, if it has no heading yet. */
export function withTitle(text: string, title: string): string {
  const lines = text.split('\n'), at = bodyStart(lines);
  if (lines.slice(at).some(l => /^#\s/.test(l)) || !title.trim()) return text;
  lines.splice(at, 0, `# ${title.trim().toUpperCase()}`);
  return lines.join('\n');
}
/**
 * A chapter's file was renamed: its title follows, if the title was the old name (or it had none).
 * A title written differently from the file name is the writer's own and stays.
 */
export function retitle(text: string, oldTitle: string, title: string): string {
  const lines = text.split('\n'), at = bodyStart(lines), h = lines.findIndex((l, k) => k >= at && /^#\s/.test(l));
  if (h < 0) return withTitle(text, title);
  const cur = lines[h].replace(/^#\s+/, '').trim();
  if (cur.toLowerCase() !== oldTitle.trim().toLowerCase() || cur === title) return text;
  lines[h] = `# ${cur === cur.toUpperCase() ? title.toUpperCase() : title}`;
  return lines.join('\n');
}

/* ───────── Scenes inside a chapter ───────── */

export interface SceneMeta { id?: string; pov?: string; where?: string; moment?: string; with?: string; flash?: string; when?: string }
export interface SceneSpan { index: number; startLine: number; metaLine: number | null; meta: SceneMeta; endLine: number }
const SCENE_COMMENT = /^\s*%%\s*se-scene\b([^%]*)%%\s*$/;
const KEYS = ['id', 'pov', 'where', 'moment', 'with', 'flash', 'when'] as const;
export function parseSceneComment(line: string): SceneMeta | null {
  const m = SCENE_COMMENT.exec(line);
  if (!m) return null;
  const meta: SceneMeta = {};
  for (const [, k, v] of m[1].matchAll(/(\w+)=([\w-]+)/g)) if ((KEYS as readonly string[]).includes(k)) (meta as Record<string, string>)[k] = v;
  return meta;
}
export function formatSceneComment(meta: SceneMeta): string {
  return `%% se-scene ${KEYS.filter(k => meta[k]).map(k => `${k}=${meta[k]}`).join(' ')} %%`;
}
export function scenesOf(lines: string[]): SceneSpan[] {
  const kinds = classify(lines);
  const starts: number[] = [];
  let firstContent = kinds.findIndex(k => k !== 'frontmatter');
  if (firstContent < 0) firstContent = lines.length;
  kinds.forEach((k, i) => { if (k === 'heading' || k === 'break') starts.push(i); });
  const hasEarlyText = lines.slice(firstContent, starts[0] ?? lines.length).some(l => l.trim() && !SCENE_COMMENT.test(l));
  if (!starts.length || hasEarlyText) starts.unshift(firstContent - 1);
  return starts.map((s, i) => {
    const end = (starts[i + 1] ?? lines.length) - 1;
    let metaLine: number | null = null, j = s + 1;
    while (j <= end && !lines[j].trim()) j++;
    if (j <= end && SCENE_COMMENT.test(lines[j])) metaLine = j;
    return { index: i, startLine: s, metaLine, meta: metaLine != null ? parseSceneComment(lines[metaLine])! : {}, endLine: end };
  });
}

/* ───────── The timeline: scenes → slots ───────── */

export interface TimelineScene { order: number; id?: string; meta: SceneMeta; slot: number; kind: 'next' | 'parallel' | 'flashback'; ref?: number /* order of the scene it runs alongside / flashes back to */ }
export interface MomentBand { moment: Moment; start: number; end: number /* exclusive */ }
export interface Timeline { scenes: TimelineScene[]; slots: number; bands: MomentBand[]; slotOfScene: Map<string, number>; bySlot: Map<number, TimelineScene[]> }

/** Work out each scene's slot. Plain scenes move time on by one slot; parallel scenes and flashbacks reuse the slot they point at. */
export function buildTimeline(metas: SceneMeta[], moments: Moment[]): Timeline {
  const n = metas.length, slot: (number | undefined)[] = new Array(n), kind: TimelineScene['kind'][] = new Array(n).fill('next'), ref: (number | undefined)[] = new Array(n);
  const byId = new Map<string, number>();
  metas.forEach((m, i) => { if (m.id) byId.set(m.id, i); });
  const momentStart = new Map<string, number>();
  let cursor = -1;
  const deferred: number[] = [];
  metas.forEach((m, i) => {
    if (m.with || m.flash) { deferred.push(i); return; }
    slot[i] = ++cursor;
    if (m.moment && !momentStart.has(m.moment)) momentStart.set(m.moment, cursor);
  });
  // Resolve parallel scenes and flashbacks (they may point at each other, so repeat until nothing changes).
  for (let pass = 0; pass < n + 1 && deferred.some(i => slot[i] === undefined); pass++) {
    for (const i of deferred) {
      if (slot[i] !== undefined) continue;
      const m = metas[i], target = m.with ?? m.flash!;
      const j = byId.get(target);
      if (j !== undefined && slot[j] !== undefined) { slot[i] = slot[j]; ref[i] = j + 1; kind[i] = m.flash ? 'flashback' : 'parallel'; }
      else if (m.flash && momentStart.has(target)) { slot[i] = momentStart.get(target)!; kind[i] = 'flashback'; }
    }
  }
  // Anything still unresolved (its target was deleted) sits alongside the scene before it.
  for (let i = 0; i < n; i++) if (slot[i] === undefined) { slot[i] = i ? slot[i - 1]! : 0; kind[i] = 'parallel'; ref[i] = i || undefined; }
  if (cursor < 0 && n) cursor = 0;
  const slots = Math.max(cursor + 1, n ? 1 : 0);
  const scenes: TimelineScene[] = metas.map((meta, i) => ({ order: i + 1, id: meta.id, meta, slot: slot[i]!, kind: kind[i], ref: ref[i] }));
  const starts = moments.filter(m => momentStart.has(m.id)).map(m => ({ moment: m, start: momentStart.get(m.id)! })).sort((a, b) => a.start - b.start);
  // A moment runs until the next one starts, or ends sooner after its last scene (`until`).
  const bands: MomentBand[] = starts.map((s, k) => {
    let end = starts[k + 1]?.start ?? slots;
    const u = s.moment.until ? byId.get(s.moment.until) : undefined, last = u !== undefined ? slot[u] : undefined;
    if (last !== undefined && last >= s.start && last + 1 < end) end = last + 1;
    return { ...s, end };
  });
  const slotOfScene = new Map<string, number>();
  for (const s of scenes) if (s.id) slotOfScene.set(s.id, s.slot);
  const bySlot = new Map<number, TimelineScene[]>();
  for (const s of scenes) (bySlot.get(s.slot) ?? bySlot.set(s.slot, []).get(s.slot)!).push(s);
  return { scenes, slots, bands, slotOfScene, bySlot };
}
export const bandAt = (t: Timeline, slot: number): MomentBand | undefined => { let found: MomentBand | undefined; for (const b of t.bands) if (b.start <= slot && slot < b.end) found = b; return found; };

/* ───────── Where pieces are ───────── */

/** Where a piece is at a slot: its latest entry at or before the slot. Places never move; events only show on their own scene. */
export function whereAt(d: ProjectData, p: Piece, behaviour: Behaviour, slot: number, slotOfScene: Map<string, number>): TrackEntry | { pt: Point } | null {
  if (behaviour === 'place') return d.places[p.id] ? { pt: d.places[p.id] } : null;
  let best: TrackEntry | null = null, bestSlot = -1;
  for (const e of d.track[p.id] ?? []) {
    const s = slotOfScene.get(e.s);
    if (s === undefined || s > slot) continue;
    if ((behaviour === 'event' || e.only) && s !== slot) continue;
    if (s >= bestSlot) { best = e; bestSlot = s; }
  }
  return best && !best.gone ? best : null;
}
/** Where a piece died, if it has died by this slot: the spot of its death, else the last spot it had (a landmark on the map). */
export function deathSpot(d: ProjectData, pieceId: string, slot: number, slotOfScene: Map<string, number>): TrackEntry | null {
  const sid = deathAt(d, pieceId, slot, slotOfScene); if (!sid) return null;
  const list = d.track[pieceId] ?? [], death = list.find(e => e.s === sid), ds = slotOfScene.get(sid) ?? -1;
  if (death && (death.place || death.pt)) return death;
  let best: TrackEntry | null = null, bestSlot = -1;
  for (const e of list) { const s = slotOfScene.get(e.s); if (s === undefined || s > ds || e.only || !(e.place || e.pt)) continue; if (s >= bestSlot) { best = e; bestSlot = s; } }
  return best;
}
/** If the piece has died by this slot: the scene id of its death (the latest entry is a death). */
export function deathAt(d: ProjectData, pieceId: string, slot: number, slotOfScene: Map<string, number>): string | null {
  let best: TrackEntry | null = null, bestSlot = -1;
  for (const e of d.track[pieceId] ?? []) { const s = slotOfScene.get(e.s); if (s === undefined || s > slot || e.only) continue; if (s >= bestSlot) { best = e; bestSlot = s; } }
  return best?.dead ? best.s : null;
}
export function setTrack(d: ProjectData, pieceId: string, sceneId: string, val: Omit<TrackEntry, 's'>) {
  d.track[pieceId] = [...(d.track[pieceId] ?? []).filter(e => e.s !== sceneId), { s: sceneId, ...val }];
}

/* ───────── Maps inside maps ───────── */

export const mapOfPlace = (d: ProjectData, placeId: string | undefined | null): string => (placeId && d.places[placeId]?.map) || MAIN_MAP;
export const subMap = (d: ProjectData, id: string) => d.maps.find(m => m.id === id);
/** The map an inside map opens from (main has none). */
export function parentMap(d: ProjectData, mapId: string): string | null { if (mapId === MAIN_MAP) return null; const m = subMap(d, mapId); return m ? mapOfPlace(d, m.anchor) : MAIN_MAP; }
/** Maps from the main map down to this one: e.g. [main, winterfell]. */
export function mapPath(d: ProjectData, mapId: string): string[] {
  const out = [mapId]; let cur: string | null = mapId;
  for (let i = 0; i < 20 && (cur = parentMap(d, cur)); i++) { if (out.includes(cur)) break; out.unshift(cur); }
  return out[0] === MAIN_MAP ? out : [MAIN_MAP, ...out];
}
/** A point on `from`, as seen on `to`: the same point if they're the same map; the anchor's spot if `from` is inside `to`; otherwise null (not visible there). */
export function project(d: ProjectData, from: string, pt: Point, to: string): Point | null {
  let map = from, cur: Point = pt;
  for (let i = 0; i < 20; i++) {
    if (map === to) return cur;
    const m = subMap(d, map); if (!m) return null;
    const a = d.places[m.anchor]; if (!a) return null;
    cur = { x: a.x, y: a.y }; map = mapOfPlace(d, m.anchor);
  }
  return null;
}
export const placeOn = (d: ProjectData, placeId: string, mapId: string): Point | null => { const p = d.places[placeId]; return p ? project(d, mapOfPlace(d, placeId), p, mapId) : null; };
/** Where a track entry shows on a map, and the place it counts as being at there (the anchor if it's further inside). */
export function entryOn(d: ProjectData, e: { place?: string; off?: Point; pt?: Point; m?: string }, mapId: string): { pt: Point; place?: string; inside: boolean; exact?: boolean } | null {
  if (e.place) {
    const home = mapOfPlace(d, e.place), pos = d.places[e.place]; if (!pos) return null;
    if (home === mapId) return e.off ? { pt: { x: clamp01(pos.x + e.off.x), y: clamp01(pos.y + e.off.y) }, place: e.place, inside: false, exact: true } : { pt: pos, place: e.place, inside: false };
    const p = project(d, home, pos, mapId); if (!p) return null;
    return { pt: p, place: anchorOn(d, home, mapId) ?? undefined, inside: true };
  }
  if (e.pt) { const home = e.m || MAIN_MAP; const p = project(d, home, e.pt, mapId); return p ? { pt: p, place: home === mapId ? undefined : anchorOn(d, home, mapId) ?? undefined, inside: home !== mapId, exact: home === mapId } : null; }
  return null;
}
/** The place on `mapId` that leads (eventually) into `inner`. */
export function anchorOn(d: ProjectData, inner: string, mapId: string): string | null {
  let map = inner;
  for (let i = 0; i < 20; i++) { const m = subMap(d, map); if (!m) return null; const home = mapOfPlace(d, m.anchor); if (home === mapId) return m.anchor; map = home; }
  return null;
}
export const roofShape = (r: Roof): Point[] => r.pts ?? [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];
export const inRoof = (r: Roof, pt: Point) => inPolygon(roofShape(r), pt);

/* ───────── Place areas ───────── */

export const DEFAULT_RADIUS = 0.035;
/** A circle on a map whose picture is `aspect` (width / height): positions are fractions of each side, so the
 *  radius across is shrunk on a wide picture (or the radius down on a tall one) to stay round on screen. */
export function circlePoly(c: Point, r = DEFAULT_RADIUS, n = 16, aspect = 1): Point[] {
  const rx = r * Math.min(1, 1 / aspect), ry = r * Math.min(1, aspect);
  return Array.from({ length: n }, (_, i) => ({ x: c.x + Math.cos(i / n * Math.PI * 2) * rx, y: c.y + Math.sin(i / n * Math.PI * 2) * ry }));
}
export const aspectOf = (d: ProjectData, mapId: string) => d.aspects?.[mapId] || 1;
/** A place's area on its map: its own shape, or a circle around it. */
export function areaOf(d: ProjectData, pid: string): Point[] | null { const p = d.places[pid]; if (!p) return null; return d.areas[pid] ?? circlePoly(p, DEFAULT_RADIUS, 16, aspectOf(d, mapOfPlace(d, pid))); }
export function inPolygon(poly: Point[], pt: Point): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
export function polyArea(poly: Point[]): number { let s = 0; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y); return Math.abs(s / 2); }
/** The place whose area contains a spot (the smallest one when areas overlap or nest). */
export function placeAt(d: ProjectData, mapId: string, pt: Point, isPlace: (id: string) => boolean, exclude?: string): string | null {
  let best: string | null = null, bestA = Infinity;
  for (const id of Object.keys(d.places)) {
    if (id === exclude || mapOfPlace(d, id) !== mapId || !isPlace(id)) continue;
    const poly = areaOf(d, id)!; if (!inPolygon(poly, pt)) continue;
    const a = polyArea(poly); if (a < bestA) { bestA = a; best = id; }
  }
  return best;
}
/** Where a spot on a map belongs: inside a place (kept as an offset, so it moves with the place) or just on the map. */
export function spotEntry(d: ProjectData, mapId: string, pt: Point, isPlace: (id: string) => boolean): Omit<TrackEntry, 's'> {
  const pid = placeAt(d, mapId, pt, isPlace);
  if (pid) { const c = d.places[pid]; return { place: pid, off: { x: pt.x - c.x, y: pt.y - c.y } }; }
  return { pt, ...(mapId !== MAIN_MAP ? { m: mapId } : {}) };
}
/** The largest circle around `c` that stays inside the area (roughly: the distance to the nearest edge). */
export function innerRadius(poly: Point[], c: Point): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / L));
    best = Math.min(best, Math.hypot(a.x + t * dx - c.x, a.y + t * dy - c.y));
  }
  return inPolygon(poly, c) && Number.isFinite(best) ? best : DEFAULT_RADIUS;
}
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
export const SPOT_SLOTS = 48;
/**
 * Spots for pieces that are at a place but were never given a spot of their own. Each piece gets a slot in a fixed
 * pattern inside the area, chosen from its id, so it lands in the same spot every time, whoever else is there.
 * Nothing is saved: dragging the piece gives it a real spot.
 */
export function autoSpots(poly: Point[], c: Point, ids: string[], used: Point[] = []): Map<string, Point> {
  // 16 well-spaced slots (more only for a big crowd), so pieces sit apart even in a small place.
  const N = ids.length <= 16 ? 16 : SPOT_SLOTS;
  const R = innerRadius(poly, c) * 0.9, out = new Map<string, Point>(), taken = new Set<number>();
  const slot = (k: number): Point => { const r = R * Math.sqrt((k + 1.6) / (N + 1.6)), a = k * 2.39996 + 0.6; return { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r }; };
  // Slots too close to a spot someone was given by hand are skipped.
  const near = (q: Point) => used.some(u => Math.hypot(u.x - q.x, u.y - q.y) < R * 0.12);
  for (const id of [...ids].sort()) {
    const start = hash(id) % N;
    for (let j = 0; j < N; j++) {
      const k = (start + j) % N; if (taken.has(k)) continue;
      const q = slot(k); if (near(q) && j < N - 1) continue;
      taken.add(k); out.set(id, q); break;
    }
    if (!out.has(id)) out.set(id, c);
  }
  return out;
}
/** Snap a point onto other shapes' corners, then edges, when it's within `tol` (map fractions). */
export function snapPoint(pt: Point, shapes: Point[][], tol: number): { pt: Point; snapped: 'corner' | 'edge' | null } {
  let best: Point | null = null, bd = tol;
  for (const s of shapes) for (const q of s) { const dd = Math.hypot(q.x - pt.x, q.y - pt.y); if (dd < bd) { bd = dd; best = q; } }
  if (best) return { pt: { ...best }, snapped: 'corner' };
  bd = tol;
  for (const s of shapes) for (let i = 0; i < s.length; i++) {
    const a = s[i], b = s[(i + 1) % s.length], dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / L)), q = { x: a.x + t * dx, y: a.y + t * dy };
    const dd = Math.hypot(q.x - pt.x, q.y - pt.y); if (dd < bd) { bd = dd; best = q; }
  }
  return best ? { pt: best, snapped: 'edge' } : { pt, snapped: null };
}

/* ───────── Recognising known names in prose ───────── */

export interface NameHit { id: string; from: number; to: number }
export function nameMatcher(pieces: Piece[]): (text: string) => NameHit[] {
  const map = new Map<string, string>();
  for (const p of pieces) for (const n of [p.name, ...p.aliases]) if (n && n.trim().length > 1 && !map.has(n.trim())) map.set(n.trim(), p.id);
  if (!map.size) return () => [];
  const names = [...map.keys()].sort((a, b) => b.length - a.length).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${names.join('|')})(?![\\p{L}\\p{N}])`, 'gu');
  return text => [...text.matchAll(re)].map(m => ({ id: map.get(m[1])!, from: m.index!, to: m.index! + m[1].length }));
}

export const uid = () => Math.random().toString(36).slice(2, 10);
export const safeFileName = (name: string) => name.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled';
export const looksLikeName = (t: string) => t.trim().length > 0 && t.length <= 60 && t.trim().split(/\s+/).length <= 6 && !/[.!?]/.test(t);
export const initials = (n: string) => { const w = n.replace(/[^\p{L}\s]/gu, '').split(/\s+/).filter(Boolean); return ((w[0]?.[0] ?? '') + (w.length > 1 ? w[w.length - 1][0] : (w[0]?.[1] ?? ''))).toUpperCase(); };
/** A colour for a new definition that isn't already used. */
export function nextColor(used: string[]): string { return PALETTE.find(c => !used.includes(c)) ?? PALETTE[used.length % PALETTE.length]; }
/** Split a pasted list ("Sister, Brother\nMentor") into clean, unique names. */
export function splitList(text: string): string[] { return [...new Set(text.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean))]; }

/* ───────── Upgrading a 2.0 story ───────── */

/**
 * 2.0 stored each scene's moment as `when=` and positions per moment. Turn that into 2.1's scene-based form:
 * the first scene of each moment starts it (`moment=`); a scene that goes back to an earlier moment runs alongside
 * that moment's first scene (`with=`); positions recorded on a moment move to the moment's first scene.
 * Returns the new metas (ids added where needed) and the converted positions.
 */
export function upgradeLegacy(metas: SceneMeta[], legacy: NonNullable<ProjectData['legacy']>, newId: () => string): { metas: SceneMeta[]; track: ProjectData['track'] } {
  const out = metas.map(m => ({ ...m }));
  const starter = new Map<string, number>();
  let current: string | undefined = legacy.moments[0];
  out.forEach((m, i) => {
    const eff = m.when ?? current;
    delete m.when;
    if (!eff) return;
    if (!starter.has(eff)) { starter.set(eff, i); m.moment = eff; }
    else if (eff !== current) { const j = starter.get(eff)!; out[j].id ??= newId(); m.with = out[j].id; }
    current = eff;
  });
  const track: ProjectData['track'] = {};
  for (const [pid, entries] of Object.entries(legacy.track)) for (const e of entries) {
    const i = starter.get(e.m) ?? (legacy.moments.indexOf(e.m) >= 0 ? 0 : undefined);
    if (i === undefined || !out[i]) continue;
    out[i].id ??= newId();
    const { m: _drop, ...rest } = e;
    track[pid] = [...(track[pid] ?? []).filter(x => x.s !== out[i].id), { s: out[i].id!, ...rest }];
  }
  return { metas: out, track };
}

/* ───────── Broken links: finding them, and what they most likely belong to ───────── */

/** A scene as the repair needs it: where it is, its opening words, its settings. */
export interface SceneRef { id?: string; file: string; index: number; text: string; meta: SceneMeta }
/** A note in the World folder that has no id (it lost it, or was made outside the plugin). */
export interface LooseNote { path: string; name: string }
export interface BrokenPiece { id: string; name: string | null; type: string | null; uses: number; to?: string /* a piece id */; note?: string /* a loose note's path */ }
export interface BrokenScene { id: string; label: string | null; uses: number; to?: number /* index into the scenes given */ }
export interface Broken { pieces: BrokenPiece[]; scenes: BrokenScene[] }

/** The opening words of a scene, the way they're compared: first line of text, lower-case, spacing evened out. */
export const sceneSnippet = (lines: string[]) => {
  const l = lines.find(x => x.trim() && !/^\s*%%/.test(x) && !/^#{1,6}\s/.test(x) && !/^\s*(?:[✦⁂∗*•·]\s*){1,7}$/.test(x) && !/^\s*-{3,}\s*$/.test(x)) ?? '';
  return l.replace(STYLE_MARK, '').replace(/[*_~=`>\[\]]/g, '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
};

/**
 * Ids the story's data points at that no piece or scene has any more, each with what it most likely is now:
 * a piece by its remembered name (a piece of that name, or a note of that name that lost its id), a scene by its
 * opening words (or, failing that, the same place in the same chapter).
 */
export function brokenLinks(d: ProjectData, pieces: Piece[], scenes: SceneRef[], loose: LooseNote[]): Broken {
  const have = new Set(pieces.map(p => p.id)), uses = new Map<string, number>();
  const use = (id: string | undefined) => { if (id && !have.has(id)) uses.set(id, (uses.get(id) ?? 0) + 1); };
  for (const [id, list] of Object.entries(d.track)) { use(id); for (const e of list) use(e.place); }
  for (const id of [...Object.keys(d.places), ...Object.keys(d.icons), ...Object.keys(d.areas), ...Object.keys(d.roofs)]) use(id);
  for (const m of d.maps) use(m.anchor);
  for (const s of scenes) { use(s.meta.pov); use(s.meta.where); }
  const referenced = (id: string) => !!d.track[id] || !!d.places[id] || scenes.some(s => s.meta.pov === id || s.meta.where === id);
  const out: Broken = { pieces: [], scenes: [] };
  for (const [id, n] of uses) {
    const known = d.names?.[id], name = known?.n ?? null, low = name?.toLowerCase();
    const b: BrokenPiece = { id, name, type: known?.t ?? null, uses: n };
    if (low) {
      // A piece of that name now (with a new id nothing points at yet), else a note of that name with no id.
      const same = pieces.filter(p => p.name.toLowerCase() === low || p.aliases.some(a => a.toLowerCase() === low));
      const fresh = same.find(p => !referenced(p.id)) ?? same[0];
      if (fresh) b.to = fresh.id;
      else { const note = loose.find(x => x.name.toLowerCase() === low); if (note) b.note = note.path; }
    }
    out.pieces.push(b);
  }
  const sceneIds = new Set(scenes.map(s => s.id).filter(Boolean));
  const sUses = new Map<string, number>();
  const sUse = (id: string | undefined) => { if (id && !sceneIds.has(id) && !d.moments.some(m => m.id === id)) sUses.set(id, (sUses.get(id) ?? 0) + 1); };
  for (const list of Object.values(d.track)) for (const e of list) sUse(e.s);
  for (const m of d.moments) sUse(m.until);
  for (const s of scenes) { sUse(s.meta.with); sUse(s.meta.flash); }
  const taken = new Set<number>();
  for (const [id, n] of sUses) {
    const key = d.sceneKeys?.[id], b: BrokenScene = { id, label: key ? `${key.f.split('/').pop()!.replace(/\.md$/, '')} · ${key.i + 1}` : null, uses: n };
    if (key) {
      // A scene with no id of its own (its settings were deleted): first by its opening words, then by its place in the chapter.
      const free = scenes.map((s, k) => ({ s, k })).filter(({ s, k }) => !s.id && !taken.has(k));
      const hit = (key.t && free.find(({ s }) => s.text && (s.text === key.t || s.text.startsWith(key.t.slice(0, 30)) || key.t.startsWith(s.text.slice(0, 30))) && s.file === key.f))
        ?? (key.t && free.find(({ s }) => s.text && s.text === key.t))
        ?? free.find(({ s }) => s.file === key.f && s.index === key.i);
      if (hit) { b.to = hit.k; taken.add(hit.k); }
    }
    out.scenes.push(b);
  }
  return out;
}
