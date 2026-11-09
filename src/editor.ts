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
    const b = new RangeSetBuilder<Decoration>();
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to;) {
        const line = view.state.doc.lineAt(pos), i = line.number - 1, st = this.styles[i];
        const cls = classesFor(this.kinds[i]) + (st ? ` se-st se-st-${st} se-st-top se-st-end` : '');
        if (cls.trim()) b.add(line.from, line.from, deco(cls.trim()));
        pos = line.to + 1;
      }
    }
    return b.finish();
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
      view.dispatch({ changes: { from, to, insert: '\n' + carry }, selection: { anchor: from + 1 + carry.length }, scrollIntoView: true, userEvent: 'input' });
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
  constructor(readonly host: EditorHost, readonly file: TFile, readonly project: Project, readonly index: number, readonly label: string, readonly pov: string, readonly when: string, readonly whenCls: string, readonly where: string) { super(); }
  eq(o: SceneBar) { return o.index === this.index && o.label === this.label && o.pov === this.pov && o.when === this.when && o.whenCls === this.whenCls && o.where === this.where && o.file.path === this.file.path; }
  toDOM() {
    const bar = document.createElement('div');
    bar.className = 'se-scenebar';
    bar.contentEditable = 'false';
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
    return bar;
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
  const spans = M.scenesOf(docLines(state));
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
    const widget = show ? new SceneBar(host, file, project, s.index, label, pov, when, whenCls, where) : null;
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
const editorLook = (host: EditorHost) => EditorView.editorAttributes.of(view => {
  const f = fileOf(view.state), p = f && host.isChapter(f) ? host.projectFor(f.path) : null;
  if (!p) return null;
  const vars = lookVars(p.data.look, true, host.zoom());
  return { class: `manuscript se-chapter-ed${p.data.look.paper ? ' se-paper-ed' : ''}`, style: Object.entries(vars).map(([k, v]) => `${k}: ${v}`).join('; ') };
});

export function storyEditorExtensions(host: EditorHost): Extension[] {
  return [editorLook(host), manuscriptLines, manuscriptKeys, styleMarkField, keepMarks, pasteAsLines(host), namesPlugin(host), sceneBarsField(host), tracker(host)];
}
export function refreshEditors() { for (const v of editors) { v.dispatch({ effects: v.scrollSnapshot ? [refreshEffect.of(null), v.scrollSnapshot()] : refreshEffect.of(null) }); } }
