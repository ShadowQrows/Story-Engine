/**
 * Everything Story Engine adds inside Obsidian's editor:
 *  - the manuscript look (line classes for indents, drop caps, breaks, collapsed blank lines),
 *  - Enter = new paragraph, Tab does nothing at the start of a paragraph (manuscript notes only),
 *  - known names underlined (click = same as highlighting it),
 *  - a slim scene bar (POV · When · Where) at the start of each scene, in place of the hidden scene comment,
 *  - highlight → capture box.
 */
import { editorInfoField, TFile } from 'obsidian';
import { tip } from './tip';
import { Prec, RangeSetBuilder, StateEffect, StateField, EditorState, Extension, Transaction } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType, keymap } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { classify, classesFor, LineKind, STYLE_MARK, stylesOf } from './manuscript';
import * as M from './model';
import type { Project, SceneEntry } from './project';
import { lookVars } from './look';

export interface EditorHost {
  projectFor(path: string): Project | null;
  isChapter(file: TFile): boolean;
  sceneBars(): boolean;
  onSelect(view: EditorView, file: TFile, project: Project, sel: { from: number; to: number; text: string; rect: DOMRect }): void;
  onNameClick(view: EditorView, file: TFile, project: Project, id: string, at: { from: number; to: number; text: string; rect: DOMRect }): void;
  onSceneChip(file: TFile, project: Project, sceneIndex: number, key: 'pov' | 'when' | 'where', rect: DOMRect): void;
  /** The cursor moved in a chapter (0-based line). */
  onCursor(file: TFile, project: Project, line: number): void;
  /** Chapter zoom on screen (1 = 100%). */
  zoom(): number;
}

/** Dispatched to every editor when story data changes, so underlines and scene bars refresh. */
export const refreshEffect = StateEffect.define<null>();
export const editors = new Set<EditorView>();

const fileOf = (state: EditorState): TFile | null => state.field(editorInfoField, false)?.file ?? null;
const inManuscript = (view: EditorView) => !!view.dom.closest('.manuscript');

/* ───────── manuscript look ───────── */

const lineDeco = new Map<string, Decoration>();
const deco = (cls: string) => { let d = lineDeco.get(cls); if (!d) { d = Decoration.line({ class: cls }); lineDeco.set(cls, d); } return d; };
function docLines(state: EditorState, upto = state.doc.lines) { const out: string[] = []; for (let n = 1; n <= upto; n++) out.push(state.doc.line(n).text); return out; }

const dropLetter = Decoration.mark({ class: 'mm-dc' });
/** Each line gets its look (indent, drop cap, title, break, empty line, style) from what it is. The text and the page match one-to-one. */
const manuscriptLines = ViewPlugin.fromClass(class {
  decorations: DecorationSet; kinds: LineKind[] = []; styles: (string | null)[] = [];
  constructor(view: EditorView) { this.compute(view.state); this.decorations = this.build(view); editors.add(view); }
  compute(state: EditorState) { const l = docLines(state); this.kinds = classify(l); this.styles = stylesOf(l, this.kinds); }
  update(u: ViewUpdate) {
    if (u.docChanged) this.compute(u.state);
    if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
  }
  destroy() { /* view removal is handled by the names plugin */ }
  build(view: EditorView) {
    const out: import('@codemirror/state').Range<Decoration>[] = [];
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to;) {
        const line = view.state.doc.lineAt(pos), i = line.number - 1, st = this.styles[i];
        const cls = classesFor(this.kinds[i]) + (st ? ` se-st se-st-${st} se-st-top se-st-end` : '');
        // A drop cap paragraph that starts with something hidden (a style marker, ** / * / ~~) can't use the browser's
        // first-letter look, so the plugin marks the first letter you can see instead. Otherwise first-letter does it
        // (that keeps the cursor its normal height at the start of the paragraph).
        const lead = this.kinds[i] === 'dropcap' ? /^(%%style:[a-z0-9-]+%%[ \t]?)?[*_~]*/.exec(line.text)![0].length : 0;
        const m = lead ? /^[“"‘'(\[]*\S/u.exec(line.text.slice(lead)) : null;
        if (cls.trim()) out.push(deco(cls.trim() + (m ? ' mm-dc-line' : '')).range(line.from));
        if (m) out.push(dropLetter.range(line.from + lead, line.from + lead + m[0].length));
        pos = line.to + 1;
      }
    }
    return Decoration.set(out, true);
  }
}, { decorations: v => v.decorations });

/* ───────── paragraph style markers (hidden) ───────── */

const hiddenMark = Decoration.replace({});
function styleMarks(state: EditorState): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n), m = STYLE_MARK.exec(line.text);
    if (m) b.add(line.from, line.from + m[0].length, hiddenMark);
  }
  return b.finish();
}
const styleMarkField = StateField.define<DecorationSet>({
  create: styleMarks,
  update: (v, tr) => tr.docChanged ? styleMarks(tr.state) : v,
  provide: f => [EditorView.decorations.from(f), EditorView.atomicRanges.of(view => view.state.field(f))],
});
/** Typing at the very start of a styled paragraph goes after its (hidden) marker, so the style stays. */
const keepMarks = EditorState.transactionFilter.of(tr => {
  if (!tr.docChanged || !tr.isUserEvent('input')) return tr;
  const start = tr.startState;
  let moved = false; const changes: { from: number; to: number; insert: string }[] = [];
  tr.changes.iterChanges((fromA, toA, _fb, _tb, ins) => {
    let from = fromA, to = toA;
    const line = start.doc.lineAt(fromA), m = STYLE_MARK.exec(line.text);
    if (m && fromA === line.from && toA <= line.from + m[0].length) { from = to = line.from + m[0].length; moved = true; }
    changes.push({ from, to, insert: ins.toString() });
  });
  if (!moved) return tr;
  const end = changes[changes.length - 1];
  return { changes, selection: { anchor: end.from + end.insert.length }, userEvent: tr.annotation(Transaction.userEvent), scrollIntoView: true };
});

const PROSE = new Set<LineKind>(['para', 'first', 'dropcap', 'interlude']);

/* ───────── formatting marks (# ** *): never shown in a chapter; the Aa panel's Title, Bold and Italic (or Ctrl+B / Ctrl+I) make them ───────── */

type FmtMark = { from: number; to: number; kind: 'header' | 'strong' | 'em' | 'strike'; partner: number };   // partner: index of the other half, -1 for a title's #
const FMT = /formatting-(header|strong|em|strikethrough)(?:_|$|\s)/;
/** The formatting marks on lines from..to (only titles and paragraphs; lists, code and the rest keep Obsidian's own behaviour). */
function fmtMarks(state: EditorState, from: number, to: number): FmtMark[] {
  const a = state.doc.lineAt(from).number, z = state.doc.lineAt(to).number;
  const kinds = classify(docLines(state, z)), out: FmtMark[] = [];
  syntaxTree(state).iterate({ from: state.doc.line(a).from, to: state.doc.line(z).to, enter: n => {
    const m = FMT.exec(n.type.name); if (!m || n.from === n.to) return;
    const line = state.doc.lineAt(n.from), k = kinds[line.number - 1];
    if (!(k === 'heading' || PROSE.has(k))) return;
    const kind = m[1] === 'strikethrough' ? 'strike' : m[1] as FmtMark['kind'];
    let end = n.to; if (kind === 'header') while (end < line.to && state.doc.sliceString(end, end + 1) === ' ') end++;
    if (out.some(x => x.from === n.from)) return;
    out.push({ from: n.from, to: end, kind, partner: -1 });
  } });
  // Opening and closing halves alternate within a line.
  const open = new Map<string, number>();
  out.forEach((x, i) => {
    if (x.kind === 'header') return;
    const key = `${state.doc.lineAt(x.from).number}:${x.kind}`, j = open.get(key);
    if (j === undefined) open.set(key, i); else { x.partner = j; out[j].partner = i; open.delete(key); }
  });
  return out;
}
const hideFmt = Decoration.replace({});
/**
 * Whether this editor shows a chapter is checked again on every update (not only when the text changes): a brand-new
 * chapter's editor opens a moment before the story knows the file is one of its chapters.
 */
const fmtHidden = (host: EditorHost) => ViewPlugin.fromClass(class {
  decorations: DecorationSet = Decoration.none; chapter = false;
  constructor(view: EditorView) { this.chapter = this.isChapter(view); this.decorations = this.build(view); }
  isChapter(view: EditorView) { const f = fileOf(view.state); return !!(f && host.isChapter(f) && host.projectFor(f.path)) || inManuscript(view); }
  update(u: ViewUpdate) {
    const now = this.isChapter(u.view), was = this.chapter; this.chapter = now;
    if (now !== was || u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)
      || u.transactions.some(t => t.effects.some(e => e.is(refreshEffect)))) this.decorations = this.build(u.view);
  }
  build(view: EditorView) {
    if (!this.chapter) return Decoration.none;
    const b = new RangeSetBuilder<Decoration>();
    for (const { from, to } of view.visibleRanges) for (const m of fmtMarks(view.state, from, to)) b.add(m.from, m.to, hideFmt);
    return b.finish();
  }
}, { decorations: v => v.decorations, provide: p => EditorView.atomicRanges.of(view => view.plugin(p)?.decorations ?? Decoration.none) });

/**
 * Hidden marks can't be broken by accident: Backspace or Delete next to one removes the letter beyond it instead,
 * deleting a selection keeps half of a pair whose other half stays, and typing at the very start of a title goes after its #.
 */
const keepFmt = EditorState.transactionFilter.of(tr => {
  if (!tr.docChanged) return tr;
  const del = tr.isUserEvent('delete'), input = tr.isUserEvent('input') && !tr.isUserEvent('input.format');
  if (!del && !input) return tr;
  const st = tr.startState; let touched = false;
  // Joining two paragraphs whose formatting Enter had split (…**  +  **…): the pair becomes one again.
  let join: [number, number] | null = null, count = 0;
  tr.changes.iterChanges((a, b, _fa, _fb, ins) => { count++; if (!ins.length && st.doc.sliceString(a, b) === '\n') join = [a, b]; });
  if (del && count === 1 && join) {
    const [a, b] = join as [number, number], prev = st.doc.lineAt(a).text, next = st.doc.lineAt(b).text;
    const x = /(\*\*\*|\*\*|~~|\*)$/.exec(prev)?.[1], y = /^(\*\*\*|\*\*|~~|\*)/.exec(next)?.[1];
    if (x && x === y && fmtMarks(st, a - x.length, a).some(m => m.to === a))
      return { changes: { from: a - x.length, to: b + x.length }, selection: { anchor: a - x.length }, userEvent: tr.annotation(Transaction.userEvent), scrollIntoView: true };
  }
  const changes: { from: number; to: number; insert: string }[] = [];
  tr.changes.iterChanges((a, b, _fb, _tb, ins) => {
    const text = ins.toString(), marks = fmtMarks(st, a, b);
    if (a === b) {
      // Typing at the start of a title: after its hidden #.
      const h = marks.find(m => m.kind === 'header' && m.from === a);
      if (input && h) { touched = true; changes.push({ from: h.to, to: h.to, insert: text }); } else changes.push({ from: a, to: b, insert: text });
      return;
    }
    const inside = (m: FmtMark) => m.from >= a && m.to <= b;
    const keep = marks.filter(m => m.to > a && m.from < b && (m.kind === 'header' ? !(inside(m) && b >= st.doc.lineAt(m.from).to) : !(inside(m) && m.partner >= 0 && inside(marks[m.partner]))));
    if (!keep.length) { changes.push({ from: a, to: b, insert: text }); return; }
    touched = true;
    // What's left once the kept marks are cut out.
    const pieces: [number, number][] = []; let at = a;
    for (const m of keep.sort((x, y) => x.from - y.from)) { if (m.from > at) pieces.push([at, Math.min(m.from, b)]); at = Math.max(at, m.to); }
    if (at < b) pieces.push([at, b]);
    if (!pieces.length && del && !text) {
      // Only a hidden mark was in the way: remove the letter beyond it (never a line break).
      const back = tr.isUserEvent('delete.backward'), pos = back ? Math.min(...keep.map(m => m.from)) : Math.max(...keep.map(m => m.to));
      const c = back ? [pos - 1, pos] : [pos, pos + 1];
      if (c[0] < 0 || c[1] > st.doc.length) return;
      if (!/\n/.test(st.doc.sliceString(c[0], c[1]))) { changes.push({ from: c[0], to: c[1], insert: '' }); return; }
      // A line break beyond a bold/italic mark: join the paragraphs as usual (merging a pair Enter had split). Never a title's #.
      if (keep.some(m => m.kind === 'header')) return;
      const mk = st.doc.sliceString(Math.min(...keep.map(m => m.from)), Math.max(...keep.map(m => m.to)));
      const other = back ? st.doc.sliceString(Math.max(0, c[0] - mk.length), c[0]) : st.doc.sliceString(c[1], c[1] + mk.length);
      if (other === mk) { if (back) changes.push({ from: c[0] - mk.length, to: pos + mk.length, insert: '' }); else changes.push({ from: pos - mk.length, to: c[1] + mk.length, insert: '' }); }
      else changes.push({ from: c[0], to: c[1], insert: '' });
      return;
    }
    if (!pieces.length) pieces.push([b, b]);
    pieces.forEach(([f, t], i) => changes.push({ from: f, to: t, insert: i === 0 ? text : '' }));
  });
  if (!touched) return tr;
  if (!changes.length) return [];
  const first = changes[0], last = changes[changes.length - 1];
  const anchor = del ? first.from : last.from + last.insert.length;
  return { changes, selection: { anchor }, userEvent: tr.annotation(Transaction.userEvent), scrollIntoView: true };
});

/** Bold or italic on and off: around the selection, or the word under the cursor. */
export function toggleWrap(view: EditorView, mark: '**' | '*' | '~~') {
  const st = view.state; let { from, to } = st.selection.main;
  if (from === to) {
    // The word at the cursor, looking past hidden marks right beside it.
    let w = st.wordAt(from);
    for (let k = 1; !w && k <= 3; k++) {
      const l = st.doc.sliceString(Math.max(0, from - k), from), r = st.doc.sliceString(from, from + k);
      if (/^[*_~]+$/.test(l)) w = st.wordAt(from - k); if (!w && /^[*_~]+$/.test(r)) w = st.wordAt(from + k);
    }
    if (!w) return false; from = w.from; to = w.to;
  }
  const before = st.doc.sliceString(Math.max(0, from - 3), from), after = st.doc.sliceString(to, to + 3);
  const has = mark !== '*' ? before.endsWith(mark) && after.startsWith(mark)
    : /(^|[^*])\*$|\*\*\*$/.test(before) && /^\*($|[^*])|^\*\*\*/.test(after);
  const n = mark.length;
  if (has) view.dispatch({ changes: [{ from: from - n, to: from, insert: '' }, { from: to, to: to + n, insert: '' }], selection: { anchor: from - n, head: to - n }, userEvent: 'input.format' });
  else view.dispatch({ changes: [{ from, insert: mark }, { from: to, insert: mark }], selection: { anchor: from + n, head: to + n }, userEvent: 'input.format' });
  view.focus(); return true;
}
/** The line with the cursor becomes a chapter title (or back to a paragraph). */
export function toggleTitle(view: EditorView) {
  const st = view.state, line = st.doc.lineAt(st.selection.main.head), h = /^#{1,6} +/.exec(line.text), sm = STYLE_MARK.exec(line.text);
  if (h) view.dispatch({ changes: { from: line.from, to: line.from + h[0].length, insert: '' }, userEvent: 'input.format' });
  else view.dispatch({ changes: { from: line.from, to: line.from + (sm?.[0].length ?? 0), insert: '# ' }, userEvent: 'input.format' });
  view.focus(); return true;
}
function kindAtCursor(state: EditorState): LineKind | undefined {
  const line = state.doc.lineAt(state.selection.main.head);
  return classify(docLines(state, line.number))[line.number - 1];
}
const manuscriptKeys = Prec.highest(keymap.of([
  {
    // Enter: a new paragraph is just a new line. Splitting a styled paragraph keeps the style on both halves.
    key: 'Enter',
    run: view => {
      if (!inManuscript(view) || !view.state.selection.main.empty) return false;
      const head = view.state.selection.main.head, line = view.state.doc.lineAt(head);
      const kind = kindAtCursor(view.state);
      if (!kind || !PROSE.has(kind) || !line.text.trim()) return false;
      // Spaces either side of the split go (no stray space at the end of one paragraph or the start of the next).
      const before = line.text.slice(0, head - line.from), after = line.text.slice(head - line.from);
      const from = line.from + before.trimEnd().length, to = head + (after.length - after.trimStart().length);
      const m = STYLE_MARK.exec(line.text), carry = m && after.trim() && head - line.from >= m[0].length ? m[0] : '';
      // Bold, italic or strikethrough running across the split is closed before it and opened again after it,
      // so each paragraph keeps whole pairs (half a pair would show up as stray * in an export).
      const marks = fmtMarks(view.state, line.from, line.to);
      const spans = marks.filter(x => x.kind !== 'header' && x.partner >= 0 && x.to <= from && marks[x.partner].from >= to).sort((a, b) => a.from - b.from);
      if (!spans.length) {
        view.dispatch({ changes: { from, to, insert: '\n' + carry }, selection: { anchor: from + 1 + carry.length }, scrollIntoView: true, userEvent: 'input' });
        return true;
      }
      const opens = spans.map(x => view.state.sliceDoc(x.from, x.to)), rest = view.state.sliceDoc(to, line.to);
      let one = view.state.sliceDoc(line.from, from) + [...opens].reverse().join(''), two = opens.join('') + rest;
      for (const o of opens) { if (one.endsWith(o + o)) one = one.slice(0, -2 * o.length); if (two.startsWith(o + o)) two = two.slice(2 * o.length); }
      const reopened = Math.max(0, two.length - rest.length);
      view.dispatch({ changes: { from: line.from, to: line.to, insert: one + '\n' + carry + two }, selection: { anchor: line.from + one.length + 1 + carry.length + reopened }, scrollIntoView: true, userEvent: 'input' });
      return true;
    },
  },
  {
    key: 'Tab',
    run: view => {
      if (!inManuscript(view)) return false;
      const sel = view.state.selection.main, line = view.state.doc.lineAt(sel.head);
      const kind = kindAtCursor(view.state);
      return sel.empty && sel.head === line.from && (!kind || PROSE.has(kind) || kind === 'blank' || kind === 'gap');
    },
  },
]));

/* ───────── known names ───────── */

function namesPlugin(host: EditorHost) {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet = Decoration.none;
    constructor(view: EditorView) { editors.add(view); this.decorations = this.build(view); }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.transactions.some(t => t.effects.some(e => e.is(refreshEffect)))) this.decorations = this.build(u.view);
    }
    destroy() { /* the view is going away */ }
    build(view: EditorView): DecorationSet {
      const file = fileOf(view.state);
      const project = file && host.isChapter(file) ? host.projectFor(file.path) : null;
      if (!project) return Decoration.none;
      const b = new RangeSetBuilder<Decoration>();
      for (const { from, to } of view.visibleRanges) {
        const start = view.state.doc.lineAt(from).from, end = view.state.doc.lineAt(to).to;
        const text = view.state.sliceDoc(start, end);
        for (const h of project.match(text)) {
          const p = project.get(h.id); if (!p) continue;
          b.add(start + h.from, start + h.to, Decoration.mark({ class: `se-name se-type-${p.type}`, attributes: { 'data-se-id': p.id } }));
        }
      }
      return b.finish();
    }
  }, {
    decorations: v => v.decorations,
    eventHandlers: {
      mouseup(e: MouseEvent, view: EditorView) {
        if (e.button !== 0) return;
        window.setTimeout(() => {
          const file = fileOf(view.state);
          const project = file && host.isChapter(file) ? host.projectFor(file.path) : null;
          if (!file || !project) return;
          const sel = view.state.selection.main;
          if (!sel.empty) {
            const text = view.state.sliceDoc(sel.from, sel.to);
            if (!text.trim()) return;
            const a = view.coordsAtPos(sel.from), z = view.coordsAtPos(sel.to);
            const rect = new DOMRect(Math.min(a?.left ?? 0, z?.left ?? 0), Math.min(a?.top ?? 0, z?.top ?? 0), Math.abs((z?.right ?? 0) - (a?.left ?? 0)), Math.max(a?.bottom ?? 0, z?.bottom ?? 0) - Math.min(a?.top ?? 0, z?.top ?? 0));
            host.onSelect(view, file, project, { from: sel.from, to: sel.to, text, rect });
            return;
          }
          const mark = (e.target as HTMLElement).closest?.('.se-name') as HTMLElement | null;
          if (mark?.dataset.seId) {
            const pos = view.posAtDOM(mark);
            host.onNameClick(view, file, project, mark.dataset.seId, { from: pos, to: pos + (mark.textContent?.length ?? 0), text: mark.textContent ?? '', rect: mark.getBoundingClientRect() });
          }
        }, 0);
      },
    },
  });
}

/* ───────── scene bars ───────── */

class SceneBar extends WidgetType {
  constructor(readonly host: EditorHost, readonly file: TFile, readonly project: Project, readonly index: number, readonly label: string, readonly pov: string, readonly when: string, readonly whenCls: string, readonly where: string, readonly afterBreak = false) { super(); }
  eq(o: SceneBar) { return o.index === this.index && o.label === this.label && o.pov === this.pov && o.when === this.when && o.whenCls === this.whenCls && o.where === this.where && o.afterBreak === this.afterBreak && o.file.path === this.file.path; }
  toDOM() {
    // The editor measures a block by its box, not its margins: the wrapper's padding is the space around the bar.
    const wrap = document.createElement('div');
    wrap.className = `se-scenebar-wrap${this.afterBreak ? ' is-after-break' : ''}`;
    wrap.contentEditable = 'false';
    const bar = wrap.createDiv('se-scenebar');
    const lbl = bar.createSpan({ cls: 'se-scenebar-label', text: this.label });
    const chip = (key: 'pov' | 'when' | 'where', text: string, unset: boolean, extra = '') => {
      const b = bar.createEl('button', { cls: `se-chip ${unset ? 'is-unset' : ''} ${extra}`, text });
      b.type = 'button';
      b.addEventListener('mousedown', e => e.preventDefault());
      b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); this.host.onSceneChip(this.file, this.project, this.index, key, b.getBoundingClientRect()); });
    };
    chip('pov', this.pov ? `POV: ${this.pov}` : 'POV: set…', !this.pov, 'se-chip-pov');
    chip('when', `When: ${this.when}`, false, this.whenCls);
    // Where: read from the map (where the POV character is), shown only when known; not a button.
    if (this.where) {
      // A link, not a field: shows the scene on the map, zoomed to where the POV character is.
      const w = bar.createSpan({ cls: 'se-where-link', text: `Where: ${this.where}` }); tip(w, 'Show on the Map');
      w.addEventListener('mousedown', e => e.preventDefault());
      w.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); this.host.onSceneChip(this.file, this.project, this.index, 'where', w.getBoundingClientRect()); });
    }
    return wrap;
  }
  ignoreEvent() { return true; }
}

/** How the scene bar describes a scene's place in story time. */
function whenText(project: Project, meta: M.SceneMeta, entry: SceneEntry | undefined): [string, string] {
  const m = project.moment(meta.moment);
  if (meta.flash) return [`↶ flashback to ${project.moment(meta.flash)?.label ?? (entry?.ref ? M.wordsOf(project.data).scene.toLowerCase() + ' ' + entry.ref : '…')}`, 'is-flash'];
  if (meta.with) return [`alongside ${M.wordsOf(project.data).scene.toLowerCase()} ${entry?.ref ?? '…'}`, 'is-parallel'];
  if (m) return [m.skip ? `⤳ ${M.skipLabel(m)}${M.skipLabel(m) !== m.label ? ' · ' + m.label : ''}` : `★ ${m.label} starts`, 'is-start'];
  return [entry?.band ? `${entry.band.moment.label} · continues` : 'continues', 'is-inherited'];
}

function buildSceneBars(host: EditorHost, state: EditorState): DecorationSet {
  const file = fileOf(state);
  const project = file && host.isChapter(file) ? host.projectFor(file.path) : null;
  if (!file || !project) return Decoration.none;
  const all = docLines(state), spans = M.scenesOf(all), kinds = classify(all);
  const tl = project.cachedTimeline();
  const cached = tl?.scenes.filter(s => s.file.path === file.path) ?? [];
  const show = host.sceneBars();
  const b = new RangeSetBuilder<Decoration>();
  for (const s of spans) {
    const entry: SceneEntry | undefined = cached[s.index];
    const pov = project.get(s.meta.pov)?.name ?? '';
    const where = project.get(entry?.where)?.name ?? '';   // where the POV character is on the map
    const label = `${M.wordsOf(project.data).scene} ${entry?.order ?? s.index + 1}`;
    const [when, whenCls] = whenText(project, s.meta, entry);
    const widget = show ? new SceneBar(host, file, project, s.index, label, pov, when, whenCls, where, s.startLine >= 0 && kinds[s.startLine] === 'break') : null;
    if (s.metaLine != null) {
      const line = state.doc.line(s.metaLine + 1);
      b.add(line.from, line.to, widget ? Decoration.replace({ widget, block: true }) : Decoration.replace({ block: true }));
    } else if (widget) {
      if (s.startLine < 0) b.add(0, 0, Decoration.widget({ widget, block: true, side: -1 }));
      else { const line = state.doc.line(s.startLine + 1); b.add(line.to, line.to, Decoration.widget({ widget, block: true, side: 1 })); }
    }
  }
  return b.finish();
}
function sceneBarsField(host: EditorHost) {
  return StateField.define<DecorationSet>({
    create: state => buildSceneBars(host, state),
    update: (value, tr) => (tr.docChanged || tr.effects.some(e => e.is(refreshEffect))) ? buildSceneBars(host, tr.state) : value,
    provide: f => [EditorView.decorations.from(f), EditorView.atomicRanges.of(view => view.state.field(f))],
  });
}

/** Forget editors that have been closed. */
const tracker = (host: EditorHost) => ViewPlugin.fromClass(class {
  constructor(readonly view: EditorView) { editors.add(view); }
  update(u: ViewUpdate) {
    if (!u.selectionSet || !u.view.hasFocus) return;
    const file = fileOf(u.state); if (!file || !host.isChapter(file)) return;
    const project = host.projectFor(file.path); if (!project) return;
    host.onCursor(file, project, u.state.doc.lineAt(u.state.selection.main.head).number - 1);
  }
  destroy() { editors.delete(this.view); }
});

/** Text pasted into a chapter (from a document, a website…) arrives with an empty line between paragraphs: drop one per gap, so it reads the same here. */
const pasteAsLines = (host: EditorHost) => EditorState.transactionFilter.of(tr => {
  if (!tr.docChanged || !tr.isUserEvent('input.paste')) return tr;
  const file = fileOf(tr.startState); if (!file || !host.isChapter(file)) return tr;
  let changed = false; const changes: { from: number; to: number; insert: string }[] = [];
  tr.changes.iterChanges((from, to, _a, _b, ins) => {
    const text = ins.toString(), next = /\n\s*\n/.test(text) ? text.replace(/\r/g, '').replace(/\n([ \t]*\n)+/g, m => '\n'.repeat(Math.max(1, m.split('\n').length - 2))) : text;
    if (next !== text) changed = true;
    changes.push({ from, to, insert: next });
  });
  if (!changed) return tr;
  const end = changes[changes.length - 1];
  return { changes, selection: { anchor: end.from + end.insert.length }, userEvent: 'input.paste', scrollIntoView: true };
});

/**
 * The book look is attached to the editor itself, so a chapter is never drawn even for a moment as a plain note
 * (Obsidian adds the note's own classes a little later when you switch chapters).
 */
/**
 * The cursor of a chapter that has just opened stays out of sight until it's been put where it belongs (the first
 * paragraph, or where you were reading), so it never shows on the title first. Clicking or typing shows it at once;
 * a quarter of a second is the most it ever waits.
 */
export const caretReady = StateEffect.define<boolean>();
const caretField = StateField.define<boolean>({
  create: () => false,
  update: (v, tr) => { for (const e of tr.effects) if (e.is(caretReady)) return e.value; return v; },
});
const caretFallback = ViewPlugin.fromClass(class {
  timer: number | null = null;
  constructor(readonly view: EditorView) { this.arm(); }
  update(u: ViewUpdate) { if (u.state.field(caretField, false) === false) this.arm(); }
  arm() {
    if (this.timer !== null) return;
    this.timer = window.setTimeout(() => { this.timer = null; if (this.view.state.field(caretField, false) === false) this.view.dispatch({ effects: caretReady.of(true) }); }, 250);
  }
  destroy() { if (this.timer !== null) window.clearTimeout(this.timer); }
}, {
  eventHandlers: {
    mousedown(_e, view) { if (!view.state.field(caretField, false)) window.setTimeout(() => view.dispatch({ effects: caretReady.of(true) })); },
    keydown(_e, view) { if (!view.state.field(caretField, false)) view.dispatch({ effects: caretReady.of(true) }); },
  },
});
/** Show (or hide again) the cursor of the editor in a view. */
export function setCaretReady(view: EditorView, on: boolean) { if (view.state.field(caretField, false) !== on) view.dispatch({ effects: caretReady.of(on) }); }

const editorLook = (host: EditorHost) => EditorView.editorAttributes.of(view => {
  const f = fileOf(view.state), p = f && host.isChapter(f) ? host.projectFor(f.path) : null;
  if (!p) return null;
  const vars = lookVars(p.data.look, true, host.zoom());
  return { class: `manuscript se-chapter-ed${p.data.look.paper ? ' se-paper-ed' : ''}${view.state.field(caretField, false) ? ' se-caret-ready' : ''}`, style: Object.entries(vars).map(([k, v]) => `${k}: ${v}`).join('; ') };
});

export function storyEditorExtensions(host: EditorHost): Extension[] {
  return [caretField, caretFallback, editorLook(host), manuscriptLines, manuscriptKeys, styleMarkField, keepMarks, fmtHidden(host), keepFmt, pasteAsLines(host), namesPlugin(host), sceneBarsField(host), tracker(host)];
}
export function refreshEditors() { for (const v of editors) { v.dispatch({ effects: v.scrollSnapshot ? [refreshEffect.of(null), v.scrollSnapshot()] : refreshEffect.of(null) }); } }
