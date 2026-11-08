/**
 * Paragraph styles in a chapter: right-click a paragraph → Style → Epigraph (or New style…, or None).
 * A style is a hidden `%%style:id%% ` at the start of the paragraph; the book look, reading view and exports read it.
 */
import { App, Editor, Menu, Modal } from 'obsidian';
import * as M from './model';
import { classify, STYLE_MARK, styleMark } from './manuscript';
import type { Project } from './project';

const PROSE = new Set(['para', 'first', 'dropcap', 'cont', 'interlude']);

/** The first line of the paragraph the cursor is in (or -1 if it isn't in a prose paragraph). */
export function paragraphStart(lines: string[], line: number): number {
  const kinds = classify(lines);
  if (!PROSE.has(kinds[line])) return -1;
  let i = line;
  while (i > 0 && (kinds[i] === 'cont' || (kinds[i] === 'interlude' && kinds[i - 1] === 'interlude'))) i--;
  return i;
}
/** Put a style on the paragraph starting at `line` (or take it off with null). */
export function setParagraphStyle(editor: Editor, line: number, id: string | null) {
  const text = editor.getLine(line), m = STYLE_MARK.exec(text);
  const old = m ? m[0].length : 0, add = id ? styleMark(id) : '';
  editor.replaceRange(add, { line, ch: 0 }, { line, ch: old });
}
export function styleOfLine(text: string) { return STYLE_MARK.exec(text)?.[1] ?? null; }

/** The right-click menu items for the paragraph under the cursor. */
export function addStyleItems(app: App, menu: Menu, editor: Editor, project: Project) {
  const cur = editor.getCursor().line;
  const lines = editor.getValue().split('\n');
  const start = paragraphStart(lines, cur);
  if (start < 0) return;
  const now = styleOfLine(lines[start]), styles = project.data.look.styles;
  menu.addSeparator();
  for (const st of styles) menu.addItem(i => i.setTitle(`Style: ${st.name}`).setIcon('palette').setChecked(now === st.id).setSection('story-engine-style').onClick(() => setParagraphStyle(editor, start, st.id)));
  menu.addItem(i => i.setTitle('New style…').setIcon('plus').setSection('story-engine-style').onClick(() => new NewStyleModal(app, project, st => setParagraphStyle(editor, start, st.id)).open()));
  if (now) menu.addItem(i => i.setTitle('No style').setIcon('eraser').setSection('story-engine-style').onClick(() => setParagraphStyle(editor, start, null)));
}

/** Name it and pick its colours; the paragraph takes it right away. More settings live in the Aa strip. */
export class NewStyleModal extends Modal {
  constructor(app: App, private project: Project, private done: (st: M.ParaStyle) => void) { super(app); }
  onOpen() {
    this.modalEl.addClass('se-style-modal');
    this.titleEl.setText('New style');
    const c = this.contentEl; c.empty();
    const row = (label: string) => { const r = c.createDiv('se-style-row'); r.createSpan({ text: label }); return r; };
    const name = row('Name').createEl('input'); name.placeholder = 'Epigraph';
    const dark = row('Colour while writing').createEl('input'); dark.type = 'color'; dark.value = '#c9b98f';
    const paper = row('Colour on paper and in exports').createEl('input'); paper.type = 'color'; paper.value = '#6b4f2a';
    const acts = c.createDiv('se-style-acts');
    const ok = acts.createEl('button', { cls: 'mod-cta', text: 'Create' });
    const go = () => {
      const n = name.value.trim() || 'Style', look = this.project.data.look;
      const st: M.ParaStyle = { id: M.styleId(n, look.styles.map(s => s.id)), name: n, color: dark.value, paperColor: paper.value, italic: false, align: 'left', size: 1, spaceBefore: 0, spaceAfter: 0 };
      this.project.setLook({ styles: [...look.styles, st] });
      this.close(); this.done(st);
    };
    ok.onclick = go;
    name.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
    window.setTimeout(() => name.focus(), 0);
  }
  onClose() { this.contentEl.empty(); }
}
