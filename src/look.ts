/**
 * Book look: an “Aa” fold at the top of every chapter note, with the story's typography.
 * The settings live in the story's story-engine.json (one look per story) and apply live.
 * Book settings also apply to reading view, printing and PDF export; page width and text colour are screen-only.
 */
import { MarkdownView } from 'obsidian';
import * as M from './model';
import type { Project } from './project';

const FONTS = ['Libre Baskerville', 'Georgia', 'Garamond', 'EB Garamond', 'Times New Roman', 'Palatino Linotype', 'Book Antiqua', 'Cambria', 'Baskerville', 'Merriweather', 'Crimson Text', 'Iowan Old Style'];
const DROPCAP_FONTS = ['Old English Text MT', 'Blackletter (built in)', 'Same as the text'];
const q = (s: string) => `"${s.replace(/["\\]/g, '')}"`;

/** CSS variables for a look. `screen` adds the screen-only ones; `zoom` enlarges the page on screen only (Ctrl+wheel). */
export function lookVars(l: M.BookLook, screen: boolean, zoom = 1): Record<string, string> {
  const z = screen ? zoom : 1;
  const text = `${q(l.font || 'Libre Baskerville')}, "MM Baskerville", Georgia, serif`;
  const drop = l.dropcapFont === 'Same as the text' ? text : l.dropcapFont === 'Blackletter (built in)' ? '"MM Blackletter", serif' : `${q(l.dropcapFont || 'Old English Text MT')}, "MM Blackletter", serif`;
  const v: Record<string, string> = {
    '--se-font': text, '--se-size': `${+(l.size * z).toFixed(2)}px`, '--se-line-height': String(l.lineHeight), '--se-para-space': `${l.paraSpace}em`,
    '--se-indent': `${+(l.indent * z).toFixed(3)}in`, '--se-title-size': `${l.titleSize}em`, '--se-dropcap-font': drop, '--se-dropcap-size': `${l.dropcapSize}em`,
  };
  // The page width in pixels (not em), so the writing view and reading view agree: em would be measured against
  // whichever element uses it, and in the writing view that's Obsidian's own text size, pushing the text off centre.
  if (screen) { v['--se-page-width'] = `${Math.round(l.pageWidth * l.size * z)}px`; if (l.color) v['--se-color'] = l.color; }
  v['--se-paper-bg'] = l.paperBg; v['--se-paper-text'] = l.paperText;
  // Each paragraph style: its colours (dark look / paper), italic, alignment and size.
  for (const st of l.styles) {
    const k = `--se-st-${st.id}`;
    v[`${k}-c`] = st.color; v[`${k}-pc`] = st.paperColor; v[`${k}-a`] = st.align; v[`${k}-s`] = `${st.size}em`;
    if (st.italic) v[`${k}-i`] = 'italic';
    v[`${k}-sb`] = String(st.spaceBefore); v[`${k}-sa`] = String(st.spaceAfter);
  }
  return v;
}
/** One rule per paragraph style (the values come from each story's variables, so two stories can share a style name). */
export function styleRules(ids: Iterable<string>) {
  let css = '';
  for (const id of new Set(ids)) {
    const k = `--se-st-${id}`, sel = `.manuscript .se-st-${id}`;
    css += `${sel} { color: var(${k}-c); font-style: var(${k}-i, inherit); text-align: var(${k}-a, inherit); font-size: var(${k}-s, inherit); }\n`;
    // Space before / after, in lines of the book's text, on the paragraph's first and last line.
    css += `${sel}.se-st-top { padding-top: calc(var(${k}-sb, 0) * var(--mm-line-height, 1.5) * var(--se-size, 1em)); }\n${sel}.se-st-end { padding-bottom: calc(var(${k}-sa, 0) * var(--mm-line-height, 1.5) * var(--se-size, 1em)); }\n`;
    css += `.se-paper ${sel}, .se-paper-ed .se-st-${id}, body.se-printing ${sel} { color: var(${k}-pc); }\n@media print { ${sel} { color: var(${k}-pc); } }\n`;
  }
  return css;
}
export function applyVars(target: HTMLElement, vars: Record<string, string> | null) {
  for (const k of Array.from(target.style)) if (k.startsWith('--se-')) target.style.removeProperty(k);
  if (vars) for (const [k, v] of Object.entries(vars)) target.style.setProperty(k, v);
}
/** The active story's book settings for printing and PDF export (those render outside the editor). */
export function printCss(l: M.BookLook | null) {
  if (!l) return '';
  return `body { ${Object.entries(lookVars(l, false)).map(([k, v]) => `${k}: ${v};`).join(' ')} }`;
}

/** What the Aa strip's Export buttons do (main.ts provides them). */
export interface LookActions { exportBook(format: 'epub' | 'docx' | 'pdf'): void; copyForWeb(view: MarkdownView): void; zoom(): number; setZoom(z: number): void }
/** Put (or refresh) the book-look strip in a chapter's view. It opens from the “Aa” button in the note's header. */
export function ensureLookbar(view: MarkdownView, project: Project, actions?: LookActions) {
  const host = view.contentEl;
  let bar = host.querySelector(':scope > .se-lookbar') as HTMLElement | null;
  // A strip left behind by an older version (it had its own Aa button inside) is replaced.
  if (bar && bar.dataset.v !== '2') { bar.remove(); bar = null; }
  if (!bar) { bar = host.createDiv('se-lookbar'); bar.dataset.v = '2'; host.prepend(bar); bar.createDiv('se-look-panel'); }
  (bar as any).__project = project; (bar as any).__actions = actions; (bar as any).__view = view;
  if (bar.hasClass('is-open') && !bar.contains(document.activeElement)) fill(bar, project);
}
export function toggleLookbar(view: MarkdownView, open?: boolean) {
  const bar = view.contentEl.querySelector(':scope > .se-lookbar') as HTMLElement | null; if (!bar) return;
  bar.toggleClass('is-open', open ?? !bar.hasClass('is-open'));
  fill(bar, (bar as any).__project);
  view.containerEl.querySelector('.se-look-aa')?.toggleClass('is-active', bar.hasClass('is-open'));
}
export function removeLookbar(view: MarkdownView) { view.contentEl.querySelector(':scope > .se-lookbar')?.remove(); }

function fill(bar: HTMLElement, project: Project) {
  const panel = bar.querySelector('.se-look-panel') as HTMLElement;
  panel.empty();
  if (!bar.hasClass('is-open')) return;
  const l = project.data.look;
  const set = (patch: Partial<M.BookLook>) => project.setLook(patch);
  const group = (title: string, hint: string) => { const g = panel.createDiv('se-look-group'); const h = g.createDiv({ cls: 'se-look-h', text: title }); return g; };
  const num = (g: HTMLElement, label: string, key: keyof M.BookLook, step: number, min: number, max: number, unit: string) => {
    const w = g.createEl('label', { cls: 'se-look-f' }); w.createSpan({ text: label });
    const i = w.createEl('input'); i.type = 'number'; i.step = String(step); i.min = String(min); i.max = String(max); i.value = String(l[key]);
    i.oninput = () => { const v = Number(i.value); if (Number.isFinite(v) && v >= min && v <= max) set({ [key]: v } as Partial<M.BookLook>); };
    if (unit) w.createSpan({ cls: 'se-look-u', text: unit });
  };
  const font = (g: HTMLElement, label: string, key: 'font' | 'dropcapFont', list: string[]) => {
    const w = g.createEl('label', { cls: 'se-look-f se-look-font' }); w.createSpan({ text: label });
    const i = w.createEl('input'); i.value = String(l[key]); i.placeholder = 'Any installed font';
    const dl = w.createEl('datalist'); dl.id = `se-fonts-${key}-${Math.random().toString(36).slice(2)}`; for (const f of list) dl.createEl('option').value = f; i.setAttribute('list', dl.id);
    i.onchange = () => set({ [key]: i.value.trim() || M.DEFAULT_LOOK[key] } as Partial<M.BookLook>);
    
  };
  const book = group('Book', 'These go into reading view, printing and PDF export too.');
  font(book, 'Font', 'font', FONTS);
  num(book, 'Size', 'size', 0.5, 8, 40, 'px');
  num(book, 'Line spacing', 'lineHeight', 0.05, 1, 3, '');
  num(book, 'Paragraph gap', 'paraSpace', 0.1, 0, 3, 'em');
  num(book, 'Indent', 'indent', 0.05, 0, 2, 'in');
  num(book, 'Title size', 'titleSize', 0.1, 0.8, 5, 'em');
  // Drop cap: on or off for the whole story; its font and size only matter when it's on.
  const dcw = book.createEl('label', { cls: 'se-look-f se-look-check' });
  const dc = dcw.createEl('input'); dc.type = 'checkbox'; dc.checked = l.dropcap; dcw.createSpan({ text: 'Drop cap' });
  const before = book.childElementCount;
  font(book, 'Font', 'dropcapFont', DROPCAP_FONTS);
  num(book, 'Size', 'dropcapSize', 0.1, 1, 8, 'em');
  const dcRows = Array.from(book.children).slice(before) as HTMLElement[];
  const showDc = (on: boolean) => dcRows.forEach(r => { r.toggleClass('is-off', !on); r.querySelectorAll('input').forEach(i => { i.disabled = !on; }); });
  showDc(l.dropcap);
  dc.onchange = () => { set({ dropcap: dc.checked }); showDc(dc.checked); };
  const scr = group('Screen only', 'Only how it looks while you write.');
  num(scr, 'Page width', 'pageWidth', 1, 20, 120, 'em');
  const za = (bar as any).__actions as LookActions | undefined;
  if (za) {
    const w = scr.createEl('label', { cls: 'se-look-f' }); w.createSpan({ text: 'Zoom' });
    const i = w.createEl('input', { cls: 'se-look-zoom' }); i.type = 'number'; i.step = '10'; i.min = '50'; i.max = '300'; i.value = String(Math.round(za.zoom() * 100));
    i.oninput = () => { const v = Number(i.value); if (Number.isFinite(v) && v >= 50 && v <= 300) za.setZoom(v / 100); };
    w.createSpan({ cls: 'se-look-u', text: '%' });
  }
  const cw = scr.createEl('label', { cls: 'se-look-f' }); cw.createSpan({ text: 'Text colour' });
  const ci = cw.createEl('input'); ci.type = 'color'; ci.value = l.color || '#dcddde'; ci.oninput = () => set({ color: ci.value });
  if (l.color) { const r = cw.createEl('button', { cls: 'se-look-reset', text: 'theme' }); r.onclick = e => { e.preventDefault(); set({ color: '' }); fill(bar, project); }; }
  const paper = group('Paper', '');
  const colour = (g: HTMLElement, label: string, key: 'paperBg' | 'paperText') => {
    const w = g.createEl('label', { cls: 'se-look-f' }); w.createSpan({ text: label });
    const i = w.createEl('input'); i.type = 'color'; i.value = l[key]; i.oninput = () => set({ [key]: i.value } as Partial<M.BookLook>);
  };
  colour(paper, 'Page', 'paperBg');
  colour(paper, 'Text', 'paperText');
  // Paragraph styles: right-click a paragraph → Style to use one.
  const sg = group('Styles', '');
  sg.addClass('se-look-styles');
  const save = (st: M.ParaStyle, patch: Partial<M.ParaStyle>) => set({ styles: l.styles.map(x => x.id === st.id ? { ...x, ...patch } : x) });
  if (!l.styles.length) sg.createSpan({ cls: 'se-look-u', text: 'None yet. Right-click a paragraph → New style…' });
  for (const st of l.styles) {
    const row = sg.createDiv('se-look-style'); row.dataset.style = st.id;
    const name = row.createEl('input', { cls: 'se-look-sname' }); name.value = st.name;
    name.onchange = () => { const v = name.value.trim(); if (v) save(st, { name: v }); else name.value = st.name; };
    const c1 = row.createEl('input', { cls: 'se-look-sc' }); c1.type = 'color'; c1.value = st.color; c1.oninput = () => save(st, { color: c1.value });
    const c2 = row.createEl('input', { cls: 'se-look-spc' }); c2.type = 'color'; c2.value = st.paperColor; c2.oninput = () => save(st, { paperColor: c2.value });
    const it = row.createEl('button', { cls: `se-look-si ${st.italic ? 'is-on' : ''}`, text: 'I' }); it.onclick = () => { save(st, { italic: !st.italic }); fill(bar, project); };
    const al = row.createEl('select', { cls: 'dropdown se-look-sa' }); for (const [v, t] of [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']]) al.createEl('option', { text: t, value: v }); al.value = st.align;
    al.onchange = () => save(st, { align: al.value as M.ParaStyle['align'] });
    const sz = row.createEl('input', { cls: 'se-look-ss' }); sz.type = 'number'; sz.step = '0.05'; sz.min = '0.5'; sz.max = '3'; sz.value = String(st.size);
    sz.oninput = () => { const v = Number(sz.value); if (Number.isFinite(v) && v >= 0.5 && v <= 3) save(st, { size: v }); };
    row.createSpan({ cls: 'se-look-u', text: '×' }).addClass('se-look-ssu');
    const space = (key: 'spaceBefore' | 'spaceAfter', mark: string) => {
      const w = row.createEl('label', { cls: 'se-look-sp' }); w.createSpan({ cls: 'se-look-u', text: mark });
      const i = w.createEl('input', { cls: 'se-look-ss' }); i.type = 'number'; i.step = '0.5'; i.min = '0'; i.max = '10'; i.value = String(st[key]);
      i.oninput = () => { const v = Number(i.value); if (Number.isFinite(v) && v >= 0 && v <= 10) save(st, { [key]: v }); };
    };
    space('spaceBefore', '↑'); space('spaceAfter', '↓');
    const del = row.createEl('button', { cls: 'se-look-reset se-look-sdel', text: 'Delete' });
    del.onclick = () => { if (!del.hasClass('is-sure')) { del.addClass('is-sure'); del.setText('Confirm'); window.setTimeout(() => { if (del.isConnected) { del.removeClass('is-sure'); del.setText('Delete'); } }, 4000); return; } set({ styles: l.styles.filter(x => x.id !== st.id) }); fill(bar, project); };
  }
  if (l.styles.length) { const k = sg.createDiv('se-look-skey'); k.setText('Name · writing colour · paper colour · italic · alignment · size · lines of space before ↑ and after ↓'); }
  const actions = (bar as any).__actions as LookActions | undefined;
  if (actions) {
    const ex = group('Export', '');
    ex.createEl('button', { cls: 'se-look-ex', text: 'E-book (EPUB)…' }).onclick = () => actions.exportBook('epub');
    ex.createEl('button', { cls: 'se-look-ex', text: 'Word (.docx)…' }).onclick = () => actions.exportBook('docx');
    ex.createEl('button', { cls: 'se-look-ex', text: 'PDF…' }).onclick = () => actions.exportBook('pdf');
    ex.createEl('button', { cls: 'se-look-ex', text: 'Copy chapter for web' }).onclick = () => actions.copyForWeb((bar as any).__view);
  }
  const acts = panel.createDiv('se-look-acts');
  const reset = acts.createEl('button', { text: 'Reset all' }); reset.onclick = () => {
    // A second click within a few seconds: the font, sizes and spacing go back to the defaults (styles and colours stay).
    if (!reset.hasClass('is-sure')) { reset.addClass('is-sure'); reset.setText('Confirm'); window.setTimeout(() => { if (reset.isConnected) { reset.removeClass('is-sure'); reset.setText('Reset all'); } }, 4000); return; } const { styles: _s, paper: _p, paperBg: _b, paperText: _t, ...type } = M.DEFAULT_LOOK; set(type); fill(bar, project); };   // typography only: styles and paper stay
  const close = acts.createEl('button', { text: 'Done' }); close.onclick = () => { bar.removeClass('is-open'); fill(bar, project); bar.closest('.workspace-leaf-content, .view-content-wrap')?.querySelector('.se-look-aa')?.removeClass('is-active'); };
}
