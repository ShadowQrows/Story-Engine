/**
 * Chapters, Google Docs style: a button at the top left of a chapter, and a borderless list that opens
 * underneath it over the empty margin (the page doesn't move). Jump to any chapter, add one at the end,
 * or drag chapters into a new order (their files are renumbered). It stays open until the button is clicked again.
 */
import { MarkdownView, Menu, Modal, Notice, TFile, setIcon } from 'obsidian';
import { NameModal } from './world';
import type { Project } from './project';
import * as M from './model';
import { classify, STYLE_MARK } from './manuscript';

const stripOf = (view: MarkdownView) => view.contentEl.querySelector(':scope > .se-chapters') as HTMLElement | null;

/** The button and (when open) the list in a chapter view, refreshed unless you're typing or dragging in it. */
export function syncChapters(view: MarkdownView, project: Project, open: boolean, toggle: () => void) {
  const host = view.contentEl;
  let btn = host.querySelector(':scope > .se-chapters-btn') as HTMLElement | null;
  if (!btn) {
    btn = host.createEl('button', { cls: 'se-chapters-btn clickable-icon' });
    setIcon(btn, 'list'); btn.setAttribute('aria-label', 'Chapters');
    host.append(btn);
  }
  btn.onclick = toggle;
  btn.toggleClass('is-active', open);
  // Sit below the book-look strip when it's open.
  const look = host.querySelector(':scope > .se-lookbar.is-open') as HTMLElement | null;
  const top = look ? look.offsetHeight : 0;
  btn.style.top = `${top + 8}px`;
  let strip = stripOf(view);
  watchFit(view);
  if (!open) { strip?.remove(); fitPage(view); return; }
  if (!strip) strip = host.createDiv('se-chapters');
  strip.style.top = `${top + 44}px`;
  fitPage(view);
  if (strip.contains(document.activeElement) || strip.hasClass('is-dragging-list')) return;
  void draw(strip, view, project);
}
export function removeChapters(view: MarkdownView) { stripOf(view)?.remove(); view.contentEl.querySelector(':scope > .se-chapters-btn')?.remove(); fitPage(view); }

/**
 * The chapter list floats over the left of the page. Only when it would cover the text does the page move right
 * (just far enough, narrowing if there isn't room); with room to spare, the page stays exactly where it is.
 */
export function fitPage(view: MarkdownView) {
  const host = view.contentEl, strip = stripOf(view);
  for (const [sc, sz] of [['.cm-scroller', '.cm-sizer'], ['.markdown-preview-view', '.markdown-preview-sizer']] as const) {
    const scroller = host.querySelector(sc) as HTMLElement | null, sizer = scroller?.querySelector(`:scope > ${sz}, :scope ${sz}`) as HTMLElement | null;
    if (!scroller || !sizer) continue;
    for (const k of ['margin-left', 'margin-right', 'max-width']) sizer.style.removeProperty(k);
    if (!strip || !scroller.offsetParent) continue;
    const cs = getComputedStyle(scroller), r = scroller.getBoundingClientRect();
    const left = r.left + parseFloat(cs.paddingLeft), right = r.left + scroller.clientWidth - parseFloat(cs.paddingRight), width = right - left;
    const max = parseFloat(getComputedStyle(sizer).maxWidth) || width, natural = left + Math.max(0, (width - Math.min(max, width)) / 2);
    const target = strip.getBoundingClientRect().right + 16;
    if (natural >= target) continue;
    sizer.style.setProperty('margin-left', `${Math.max(0, target - left)}px`, 'important');
    sizer.style.setProperty('margin-right', '0px', 'important');
    sizer.style.setProperty('max-width', `${Math.max(240, Math.min(max, right - target))}px`, 'important');
  }
}
/** Fit the page again whenever the note's pane changes size (dragging the World view's edge, say). */
function watchFit(view: MarkdownView) {
  const v = view as unknown as { __seFit?: ResizeObserver };
  if (v.__seFit) return;
  let raf = 0;
  v.__seFit = new ResizeObserver(() => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; fitPage(view); }); });
  v.__seFit.observe(view.contentEl);
  view.register(() => v.__seFit?.disconnect());
}

async function draw(strip: HTMLElement, view: MarkdownView, project: Project) {
  const files = project.chapters();
  const tl = await project.timeline();
  const scroll = strip.querySelector('.se-ch-list')?.scrollTop ?? 0;
  strip.empty();
  const inner = strip.createDiv('se-ch-inner');
  const list = inner.createDiv('se-ch-list');
  let dragged: TFile | null = null;
  const clearMarks = () => list.querySelectorAll('.is-drop-before, .is-drop-after').forEach(x => x.removeClass('is-drop-before', 'is-drop-after'));
  files.forEach((f, i) => {
    const row = list.createDiv(`se-ch-row ${view.file?.path === f.path ? 'is-cur' : ''}`);
    row.draggable = true;
    row.createSpan({ cls: 'se-ch-grip', text: '⋮⋮' });
    row.createSpan({ cls: 'se-ch-n', text: String(i + 1) });
    row.createSpan({ cls: 'se-ch-t', text: project.chapterTitle(f) });
    const n = tl.scenes.filter(s => s.file.path === f.path).length;
    row.createSpan({ cls: 'se-ch-s', text: `${n} ${(n === 1 ? M.wordsOf(project.data).scene : M.wordsOf(project.data).scenes).toLowerCase()}` });
    row.onclick = async () => { if (view.file?.path !== f.path) await view.leaf.openFile(f); };
    row.oncontextmenu = e => {
      e.preventDefault();
      const menu = new Menu();
      menu.addItem(it => it.setTitle('Rename…').onClick(() => new NameModal(view.app, 'Rename chapter', project.chapterTitle(f), async v => {
        try { await project.renameChapter(f, v); } catch (err) { new Notice((err as Error).message); return false; }
        return true;
      }).open()));
      menu.addSeparator();
      menu.addItem(it => it.setTitle('Delete').onClick(() => {
        const m = new Modal(view.app); m.titleEl.setText(`Delete “${project.chapterTitle(f)}”?`);
        m.contentEl.createEl('p', { text: 'It goes to the trash. Ctrl+Z in the World panel brings it back.' });
        const acts = m.contentEl.createDiv('se-acts');
        acts.createEl('button', { text: 'Cancel' }).onclick = () => m.close();
        acts.createEl('button', { cls: 'mod-warning', text: 'Delete' }).onclick = () => { m.close(); void project.deleteChapter(f).then(() => draw(strip, view, project)); };
        m.open();
      }));
      menu.showAtMouseEvent(e);
    };
    row.addEventListener('dragstart', e => { dragged = f; strip.addClass('is-dragging-list'); row.addClass('is-dragging'); e.dataTransfer?.setData('text/plain', f.path); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; });
    row.addEventListener('dragend', () => { dragged = null; strip.removeClass('is-dragging-list'); row.removeClass('is-dragging'); clearMarks(); });
    row.addEventListener('dragover', e => {
      if (!dragged) return; e.preventDefault();
      const r = row.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
      clearMarks(); row.addClass(after ? 'is-drop-after' : 'is-drop-before');
    });
    row.addEventListener('drop', async e => {
      e.preventDefault();
      if (!dragged || dragged === f) return;
      const after = row.hasClass('is-drop-after');
      const order = files.filter(x => x !== dragged);
      order.splice(order.indexOf(f) + (after ? 1 : 0), 0, dragged);
      dragged = null;
      strip.addClass('is-busy');
      const before = project.chapters();
      project.checkpoint({ undo: () => project.reorderChapters(before), redo: () => project.reorderChapters(order) });
      try { await project.reorderChapters(order); } catch (err) { new Notice(`Couldn't reorder: ${(err as Error).message}`); }
      strip.removeClass('is-busy', 'is-dragging-list');
      await draw(strip, view, project);
    });
  });
  if (!files.length) list.createDiv({ cls: 'se-empty', text: 'No chapters yet.' });
  list.scrollTop = scroll;
  const add = inner.createEl('button', { cls: 'se-ch-add', text: 'New chapter' });
  add.onclick = () => {
    const box = inner.createDiv('se-ch-new'); add.remove();
    const input = box.createEl('input'); input.placeholder = 'Chapter title, then Enter (Esc to cancel)';
    input.onkeydown = async e => {
      if (e.key === 'Escape') { input.blur(); void draw(strip, view, project); return; }
      if (e.key !== 'Enter' || !input.value.trim()) return;
      const f = await project.createChapter(input.value.trim());
      input.blur();
      await view.leaf.openFile(f);
      startWriting(view);
    };
    input.focus();
  };
}

/**
 * Where the cursor waits when a chapter opens: the start of its first paragraph (after a hidden style marker).
 * A new chapter with no text yet: the line below the title. Only moves a cursor that's in the hidden properties or on the title.
 */
export function placeCaret(view: MarkdownView, always = false) {
  const go = () => {
    const ed = view.editor; if (!ed || (view.getMode?.() ?? 'source') !== 'source') return;
    const lines = ed.getValue().split('\n'), kinds = classify(lines);
    let first = kinds.findIndex(k => k === 'dropcap' || k === 'first' || k === 'para' || k === 'interlude');
    if (first < 0) first = lines.length - 1;
    const cur = ed.getCursor().line;
    if (!always && cur >= first) return;
    if (!always && !(kinds[cur] === 'frontmatter' || kinds[cur] === 'heading' || kinds[cur] === 'other' || kinds[cur] === 'gap' || cur === 0)) return;
    ed.setCursor({ line: first, ch: STYLE_MARK.exec(lines[first] ?? '')?.[0].length ?? 0 });
  };
  // Obsidian puts back its own idea of the cursor a moment after opening; go after that.
  window.setTimeout(go, 30); window.setTimeout(go, 160);
}
/** A new chapter opens ready to write: the cursor below its title and scene bar, not above the title. */
export function startWriting(view: MarkdownView) { placeCaret(view, true); window.setTimeout(() => view.editor?.focus?.(), 170); }
