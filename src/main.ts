import { App, Events, MarkdownPostProcessorContext, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, normalizePath, setIcon } from 'obsidian';
import { Project, DATA_FILE } from './project';
import * as M from './model';
import { Capture } from './capture';
import { tip } from './tip';
import { storyEditorExtensions, refreshEditors, setCaretReady, toggleWrap } from './editor';
import { WorldView, WORLD_VIEW, FolderPicker } from './world';
import { classify, classesFor, gapBefore, LineKind, STYLE_MARK, stylesOf, toLinePerParagraph } from './manuscript';
import { EditorView } from '@codemirror/view';
import { applyVars, ensureLookbar, LookActions, lookVars, SCREEN_SCALE, printCss, removeLookbar, styleRules, toggleLookbar } from './look';
import { addStyleItems } from './styles';
import { BookExportModal, copyChapterForWeb } from './export';
import { placeCaret, removeChapters, startWriting, syncChapters, syncZoom } from './chapters';

interface Settings { active: string | null; sceneBars: boolean; follow: boolean; statusFolded: boolean; draftZoom: number; /** 2: draftZoom is measured from the larger 100% (SCREEN_SCALE) */ zoomBase?: number }
const DEFAULTS: Settings = { active: null, sceneBars: true, follow: true, statusFolded: false, draftZoom: 1, zoomBase: 2 };

export default class StoryEnginePlugin extends Plugin {
  settings: Settings = { ...DEFAULTS };
  projects = new Map<string, Project>();
  events = new Events();
  capture!: Capture;
  private scenesTimer: number | null = null;

  async onload() {
    const saved = (await this.loadData()) ?? {};
    this.settings = { ...DEFAULTS, ...saved };
    // 100% got larger (it's what 182% used to be): keep a saved zoom looking the same size.
    if (saved.zoomBase !== 2 && typeof saved.draftZoom === 'number') { this.settings.draftZoom = Math.max(0.3, Math.round(saved.draftZoom / SCREEN_SCALE * 100) / 100); this.settings.zoomBase = 2; void this.saveSettings(); }
    this.capture = new Capture({
      app: this.app,
      openPiece: (p, id) => void this.showPiece(p, id),
      sceneAt: async (p, file, pos) => {
        const view = this.app.workspace.getLeavesOfType('markdown').map(l => l.view).find((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === file.path);
        const line = pos != null && view ? view.editor.offsetToPos(pos).line : 0;
        return p.sceneFor(file, line);
      },
      currentScene: async p => p.current(await p.timeline()),
    });
    this.register(() => this.capture.destroy());

    this.registerView(WORLD_VIEW, leaf => new WorldView(leaf, this));
    this.registerEditorExtension(storyEditorExtensions({
      projectFor: path => this.projectFor(path),
      isChapter: f => !!this.projectFor(f.path)?.isChapter(f),
      sceneBars: () => this.settings.sceneBars,
      onSelect: (view, file, project, sel) => void this.capture.onSelect(project, file, sel.from, { text: sel.text, rect: sel.rect, file }),
      onNameClick: (view, file, project, id, at) => void this.capture.onNameClick(project, file, at.from, id, at.rect),
      onSceneChip: (file, project, index, key, rect) => key === 'where' ? void this.showSceneOnMap(project, file, index) : void this.capture.openScene(project, file, index, key, rect),
      onCursor: (file, project, line) => this.followCursor(file, project, line),
      zoom: () => this.settings.draftZoom,
    }));
    // Clicking somewhere else closes the capture box.
    this.registerDomEvent(document, 'pointerdown', e => this.capture.onOutsidePointer(e.target as HTMLElement), { capture: true });
    this.printStyle = document.head.createEl('style', { attr: { id: 'story-engine-print-look' } });
    this.styleSheet = document.head.createEl('style', { attr: { id: 'story-engine-styles' } });
    this.register(() => { this.printStyle?.remove(); this.styleSheet?.remove(); });
    // Ctrl + mouse wheel (or a trackpad pinch) over a chapter zooms the page, on screen only.
    this.registerDomEvent(document, 'wheel', (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      const t = e.target as HTMLElement | null, page = t?.closest?.('.cm-editor.manuscript, .markdown-preview-view.manuscript, .markdown-source-view.manuscript');
      if (!page) return;
      e.preventDefault(); e.stopPropagation();
      this.setDraftZoom(this.settings.draftZoom * Math.exp(-e.deltaY * 0.0015), page.closest('.workspace-leaf-content, .view-content-wrap') as HTMLElement | null);
    }, { capture: true, passive: false });
    this.addCommand({ id: 'draft-zoom-in', name: 'Zoom in on chapters', callback: () => this.setDraftZoom(this.settings.draftZoom * 1.1) });
    this.addCommand({ id: 'draft-zoom-out', name: 'Zoom out on chapters', callback: () => this.setDraftZoom(this.settings.draftZoom / 1.1) });
    this.addCommand({ id: 'draft-zoom-reset', name: 'Reset chapter zoom', callback: () => this.setDraftZoom(DEFAULTS.draftZoom) });
    // Right-click a paragraph in a chapter: Style → …
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, info) => {
      const f = info.file, p = f && this.projectFor(f.path);
      if (f && p?.isChapter(f)) addStyleItems(this.app, menu, editor, p);
      // A long highlight doesn't open the capture box by itself (so it can be formatted); this does.
      const sel = editor.getSelection();
      if (f && p && sel.trim()) menu.addItem(i => i.setTitle('Add to World…').setIcon('plus').onClick(() => void this.capture.onSelect(p, f, editor.posToOffset(editor.getCursor('from')), { text: sel, rect: this.cursorRect(), file: f }, true)));
    }));
    for (const ev of ['layout-change', 'active-leaf-change', 'file-open'] as const) this.registerEvent(this.app.workspace.on(ev as 'layout-change', () => this.applyLooksSoon()));

    // Reading view and PDF export get the same book layout.
    let lastText = '', lastKinds: LineKind[] = [], lastStyles: (string | null)[] = [];
    this.registerMarkdownPostProcessor((el, ctx) => {
      const info = ctx.getSectionInfo(el);
      const block = el.firstElementChild as HTMLElement | null;
      if (!block) return;
      if (info) {
        if (info.text !== lastText) { lastText = info.text; const l = info.text.split('\n'); lastKinds = classify(l); lastStyles = stylesOf(l, lastKinds); }
        // The lines of this block that are on the page (hidden notes like the scene settings aren't).
        const src = info.text.split('\n'), lines: number[] = [];
        for (let n = info.lineStart; n <= info.lineEnd; n++) if (src[n]?.trim() && !/^\s*%%(?!style:).*%%\s*$/.test(src[n])) lines.push(n);
        const look = (node: HTMLElement, n: number) => {
          const cls = classesFor(lastKinds[n]); if (cls) node.addClass(...cls.split(' '));
          const st = lastStyles[n]; if (st) node.addClass('se-st', `se-st-${st}`, 'se-st-top', 'se-st-end');
        };
        // Reading view joins lines that follow each other into one paragraph with line breaks; here each line is its own paragraph.
        if (block.tagName === 'P' && lines.length > 1) {
          const groups: Node[][] = [[]];
          for (const node of Array.from(block.childNodes)) { if (node.nodeName === 'BR') groups.push([]); else groups[groups.length - 1].push(node); }
          const parts = groups.filter(g => g.some(n => n.nodeType !== Node.TEXT_NODE || (n.textContent ?? '').trim()));
          if (parts.length === lines.length) {
            const out = parts.map((g, k) => { const p = document.createElement('p'); for (const n of g) p.appendChild(n); look(p, lines[k]); return p; });
            block.replaceWith(...out);
          } else look(block, lines[0]);
        } else if (lines.length) {
          // A hidden note on the line above (the scene settings) leaves a line break in front of the text: take it out,
          // or the paragraph starts one line down and its drop cap can't find its first letter.
          if (block.tagName === 'P') for (const end of ['firstChild', 'lastChild'] as const) {
            let n = block[end];
            while (n && (n.nodeName === 'BR' || (n.nodeType === Node.TEXT_NODE && !(n.textContent ?? '').trim()))) { const next = end === 'firstChild' ? n.nextSibling : n.previousSibling; n.remove(); n = next; }
            if (n?.nodeType === Node.TEXT_NODE && end === 'firstChild') n.textContent = (n.textContent ?? '').replace(/^\s+/, '');
          }
          look(block, lines[0]);
        }
        // Empty lines above it: that many lines of space, kept up to date (reading view doesn't redraw a block when only the empty lines around it change).
        this.gapEls.set(el, ctx); this.applyGap(el, ctx);
      } else if (block.tagName === 'P' && /^[\s✦⁂]+$/.test(block.textContent ?? '')) block.addClass('mm-line', 'mm-break');
    });

    this.app.workspace.onLayoutReady(() => { void this.discover(); this.takeOverFormatting(); });
    // Obsidian reads notes in the background at start-up (every note, after its index is rebuilt). A story looked at too early
    // seems empty, so look again once Obsidian has finished: always the first time, later only if a story still looks empty.
    let firstResolve = true;
    this.registerEvent(this.app.metadataCache.on('resolved', () => {
      let redid = false;
      for (const p of this.projects.values()) if (firstResolve || !p.pieces.size || !p.chapters().length) { p.refresh(); redid = true; }
      if (this.projects.size) firstResolve = false;
      if (redid) { refreshEditors(); this.applyLooks(); this.redrawReading(); }
    }));
    this.registerEvent(this.app.metadataCache.on('changed', f => { for (const p of this.projects.values()) if (p.contains(f.path)) p.indexFile(f); this.applyLooksSoon(); }));
    this.registerEvent(this.app.vault.on('create', f => { if (f instanceof TFile && f.name === DATA_FILE) void this.discover(); }));
    // A story's data file changed on disk (sync, another device, a restored backup): use that version rather than saving over it.
    this.registerEvent(this.app.vault.on('modify', f => { if (f instanceof TFile && f.name === DATA_FILE) void this.projects.get(f.parent && f.parent.path !== '/' ? f.parent.path : '')?.reloadIfChanged(); }));
    this.registerEvent(this.app.vault.on('delete', f => {
      if (f instanceof TFile && f.name === DATA_FILE) { const k = f.parent?.path === '/' ? '' : f.parent?.path ?? ''; this.projects.get(k)?.dispose(); this.projects.delete(k); this.changed(); return; }
      for (const p of this.projects.values()) if (p.contains(f.path)) p.forget(f.path);
    }));
    this.registerEvent(this.app.vault.on('rename', (f, old) => {
      // Every move is noted; once they stop arriving (a folder move sends one per file inside it), the stories are
      // found again if a folder moved, and the paths they keep (map pictures, icons) follow every move.
      this.moves.push([old, f.path, !(f instanceof TFile)]);
      if (this.movesTimer !== null) window.clearTimeout(this.movesTimer);
      this.movesTimer = window.setTimeout(() => { this.movesTimer = null; void this.settleMoves(); }, 400);
      if (!(f instanceof TFile)) return;
      for (const p of this.projects.values()) { if (p.contains(old)) p.forget(old); if (p.contains(f.path)) { p.indexFile(f); void p.onRename(f, old); void p.syncChapterTitle(f, old); } }
    }));
    this.registerEvent(this.app.workspace.on('editor-change', (_e, info) => {
      const f = info.file; if (!f) return;
      const p = this.projectFor(f.path); if (!p?.isChapter(f)) return;
      if (this.scenesTimer !== null) window.clearTimeout(this.scenesTimer);
      this.scenesTimer = window.setTimeout(() => { this.scenesTimer = null; p.invalidateScenes(); }, 700);
    }));
    this.registerEvent(this.app.workspace.on('file-open', f => {
      const p = f && this.projectFor(f.path); if (p && this.settings.active !== p.folder) this.setActive(p.folder);
      if (!f || !p?.isChapter(f)) return;
      // The book look straight away (not a moment later), and the cursor at the first paragraph.
      this.applyLooks();
      for (const l of this.app.workspace.getLeavesOfType('markdown')) if (l.view instanceof MarkdownView && l.view.file?.path === f.path) placeCaret(l.view);
    }));
    this.registerDomEvent(document, 'keydown', e => { if (e.key === 'Escape' && this.capture.onEscape()) { e.preventDefault(); e.stopPropagation(); } }, { capture: true });

    // An arrow on Obsidian's status bar (word count, backlinks…) folds it away and back.
    const fold = this.addStatusBarItem(); fold.addClass('se-status-toggle', 'mod-clickable');
    const showFold = () => { document.body.toggleClass('se-status-folded', this.settings.statusFolded); fold.setText(this.settings.statusFolded ? '‹' : '›'); };
    fold.onclick = () => { this.settings.statusFolded = !this.settings.statusFolded; showFold(); void this.saveSettings(); };
    showFold();
    this.register(() => document.body.removeClass('se-status-folded'));
    // The World view's button lives in every note's header (just left of ⋮), not in the left ribbon.
    this.addCommand({ id: 'toggle-world', name: 'Open/close World view', callback: () => void this.toggleWorld() });
    this.register(() => { for (const l of this.app.workspace.getLeavesOfType('markdown')) if (l.view instanceof MarkdownView) { this.removeHeaderButtons(l.view); (l.view as unknown as { __seWorld?: HTMLElement }).__seWorld?.remove(); } });
    this.addCommand({ id: 'open-world', name: 'Open World view', callback: () => void this.openWorld() });
    this.addCommand({ id: 'new-piece', name: 'New piece', callback: () => this.newPieceFromCommand() });
    this.addCommand({ id: 'add-selection', name: 'Add selection to world', editorCallback: (editor, view) => {
      const f = view.file, p = f && this.projectFor(f.path);
      if (!f || !p) { new Notice('This note isn\'t part of a story. Run “Story Engine: Set up a story” first.'); return; }
      const sel = editor.getSelection(); if (!sel.trim()) { this.newPieceFromCommand(); return; }
      void this.capture.onSelect(p, f, editor.posToOffset(editor.getCursor('from')), { text: sel, rect: this.cursorRect(), file: f }, true);
    } });
    this.addCommand({ id: 'new-story', name: 'Set up a story', callback: () => this.newStory() });
    this.addCommand({ id: 'new-chapter', name: 'New Chapter', callback: () => this.newChapter() });
    this.addCommand({ id: 'toggle-manuscript', name: 'Turn book look on/off for this note', checkCallback: checking => {
      const f = this.app.workspace.getActiveViewOfType(MarkdownView)?.file; if (!f) return false;
      if (!checking) void this.toggleManuscript(f).then(on => new Notice(on ? 'Book look on.' : 'Book look off.'));
      return true;
    } });
    this.addCommand({ id: 'export-epub', name: 'Export e-book (EPUB)', callback: () => { const p = this.activeProject(); if (p) new BookExportModal(this.app, p, 'epub').open(); else new Notice('Set up a story first: “Story Engine: Set up a story”.'); } });
    this.addCommand({ id: 'export-pdf', name: 'Export PDF', callback: () => { const p = this.activeProject(); if (p) new BookExportModal(this.app, p, 'pdf').open(); else new Notice('Set up a story first: “Story Engine: Set up a story”.'); } });
    this.addCommand({ id: 'export-docx', name: 'Export Word document', callback: () => { const p = this.activeProject(); if (p) new BookExportModal(this.app, p, 'docx').open(); else new Notice('Set up a story first: “Story Engine: Set up a story”.'); } });
    this.addCommand({ id: 'copy-chapter-web', name: 'Copy this chapter for web', checkCallback: checking => {
      const v = this.app.workspace.getActiveViewOfType(MarkdownView), f = v?.file, p = f && this.projectFor(f.path);
      if (!v || !f || !p?.isChapter(f)) return false;
      if (!checking) void copyChapterForWeb(p, v.editor.getValue(), p.chapterTitle(f));
      return true;
    } });
    this.addCommand({ id: 'toggle-paper', name: 'Paper: show chapters as a book page', callback: () => { const p = this.activeProject(); if (p) p.setLook({ paper: !p.data.look.paper }); else new Notice('Set up a story first: “Story Engine: Set up a story”.'); } });
    this.addCommand({ id: 'toggle-scene-bars', name: 'Show/hide scene bars', callback: async () => { this.settings.sceneBars = !this.settings.sceneBars; await this.saveSettings(); refreshEditors(); } });
    this.addSettingTab(new SettingsTab(this.app, this));
  }

  /* ───────── projects ───────── */

  private moves: [string, string, boolean][] = [];
  private movesTimer: number | null = null;
  private async settleMoves() {
    const moves = this.moves.splice(0);
    let active = this.settings.active;
    for (const [from, to] of moves) if (active !== null && (active === from || active.startsWith(from + '/'))) active = to + active.slice(from.length);
    if (moves.some(m => m[2])) await this.discover();
    for (const p of this.projects.values()) for (const [from, to] of moves) p.followMove(from, to);
    if (active !== this.settings.active && active !== null && this.projects.has(active)) this.setActive(active);
  }
  private discovering: Promise<void> | null = null;
  private rediscover = false;
  /** Find the stories (folders with a data file). Never two at once: a second call waits for the first, then looks again. */
  async discover(): Promise<void> {
    if (this.discovering) { this.rediscover = true; return this.discovering; }
    this.discovering = (async () => {
      try { do { this.rediscover = false; await this.discoverOnce(); } while (this.rediscover); }
      finally { this.discovering = null; }
    })();
    return this.discovering;
  }
  private async discoverOnce() {
    const found = new Set<string>();
    // A story's own Backups and Exports folders never hold another story (a copy of a data file is just a copy).
    for (const f of this.app.vault.getFiles()) if (f.name === DATA_FILE && !f.path.split('/').slice(0, -1).some(d => d === 'Backups' || d === 'Exports')) found.add(f.parent && f.parent.path !== '/' ? f.parent.path : '');
    for (const folder of found) {
      if (this.projects.has(folder)) continue;
      const p = new Project(this.app, folder);
      await p.load();
      p.on('changed', () => { this.changed(); this.refreshEditorsSoon(); });
      p.on('scenes', () => void p.timeline().then(() => { refreshEditors(); this.changed(); this.applyLooksSoon(); }));
      p.on('view', () => this.changed());
      p.on('look', () => { this.applyLooks(); this.refreshEditorsSoon(); });
      this.projects.set(folder, p);
      // A story from before 2.11 (an empty line between paragraphs): convert it once to one line per paragraph.
      if (p.data.format < 2) {
        const n = await p.convertToLinePerParagraph();
        if (n) new Notice(`Story Engine: “${p.name}” now uses one line per paragraph (${n} chapter${n > 1 ? 's' : ''} updated). The originals are in ${p.folder ? p.folder + '/' : ''}Backups/Before 2.11.`, 12000);
      }
      void p.timeline().then(() => refreshEditors());
    }
    for (const k of [...this.projects.keys()]) if (!found.has(k)) { this.projects.get(k)?.dispose(); this.projects.delete(k); }
    if (this.settings.active && !this.projects.has(this.settings.active)) this.settings.active = null;
    refreshEditors();
    this.changed();
    this.applyLooks();
    this.redrawReading();
  }
  /** Chapters open in Reading view: draw them again, so a page drawn before the plugin was ready gets the book look. */
  redrawReading() {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      // Chapters open in editing too: their hidden reading page was drawn without the book look while the plugin was off.
      const v = leaf.view; if (!(v instanceof MarkdownView)) continue;
      const f = v.file, p = f && this.projectFor(f.path);
      if (!f || !p?.isChapter(f)) continue;
      // rerender() alone keeps the page it drew before; clearing it first makes it draw (and style) every paragraph again.
      const r = (v.previewMode as unknown as { renderer?: { clear?: () => void; set?: (text: string) => void } }).renderer, top = v.previewMode.getScroll();
      if (r?.clear && r.set) { r.clear(); r.set(v.data); } else v.previewMode.rerender(true);
      if (v.getMode() === 'preview') window.setTimeout(() => v.previewMode.applyScroll(top), 50);
    }
  }
  projectFor(path: string): Project | null {
    let best: Project | null = null;
    for (const p of this.projects.values()) if (p.contains(path) && (!best || p.folder.length > best.folder.length)) best = p;
    return best;
  }
  activeProject(): Project | null {
    const a = this.settings.active && this.projects.get(this.settings.active);
    return a || this.projects.values().next().value || null;
  }
  setActive(folder: string) { this.settings.active = folder; void this.saveSettings(); this.changed(); this.applyLooks(); }

  /* ───────── book look and follow cursor ───────── */

  /** Reading-view sections, so their space from extra empty lines can be worked out again after an edit. */
  private gapEls = new Map<HTMLElement, MarkdownPostProcessorContext>();
  private gapKinds = { text: '', kinds: [] as LineKind[] };
  private applyGap(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    const info = ctx.getSectionInfo(el); if (!info) return;
    if (info.text !== this.gapKinds.text) this.gapKinds = { text: info.text, kinds: classify(info.text.split('\n')) };
    const gap = gapBefore(this.gapKinds.kinds, info.lineStart);
    el.toggleClass('se-gap-before', gap > 0);
    el.style.paddingTop = gap ? `calc(${gap} * var(--mm-line-height, 1.5) * var(--se-size, 1em))` : '';
  }
  private refreshGaps() {
    for (const [el, ctx] of this.gapEls) { if (!el.isConnected && this.gapEls.size > 4000) { this.gapEls.delete(el); continue; } if (el.isConnected) this.applyGap(el, ctx); }
  }
  private printStyle: HTMLStyleElement | null = null;
  private styleSheet: HTMLStyleElement | null = null;
  /** The Aa strip's Export buttons. */
  private lookActions(p: Project): LookActions {
    return {
      exportBook: format => new BookExportModal(this.app, p, format).open(),
      copyForWeb: v => { if (v.file) void copyChapterForWeb(p, v.editor.getValue(), p.chapterTitle(v.file)); },
      zoom: () => this.settings.draftZoom,
      setZoom: z => this.setDraftZoom(z),
    };
  }
  private lookTimer: number | null = null;
  applyLooksSoon() { if (this.lookTimer !== null) return; this.lookTimer = window.setTimeout(() => { this.lookTimer = null; this.applyLooks(); }, 60); }
  /** The Aa fold and the story's typography on every open chapter; the active story's book settings for print/PDF. */
  applyLooks() {
    const worldOpen = this.app.workspace.getLeavesOfType(WORLD_VIEW).length > 0;
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const v = leaf.view; if (!(v instanceof MarkdownView)) continue;
      this.worldButton(v, worldOpen);
      const f = v.file, p = f && this.projectFor(f.path);
      if (f && p?.isChapter(f)) {
        ensureLookbar(v, p, this.lookActions(p)); this.addHeaderButtons(v, p); syncChapters(v, p, this.chaptersOpen, () => { this.chaptersOpen = !this.chaptersOpen; this.applyLooks(); }, () => this.newScene(v, p));
        // Switching from reading to editing: the cursor where you were reading.
        const vm = v as unknown as { __seMode?: string }, mode = v.getMode();
        if (vm.__seMode === 'preview' && mode === 'source') this.caretAtReading(v);
        if (mode === 'preview') this.watchReading(v);
        vm.__seMode = mode;
        syncZoom(v, this.settings.draftZoom, () => this.setDraftZoom(1));
        applyVars(v.containerEl, lookVars(p.data.look, true, this.settings.draftZoom));
        v.containerEl.toggleClass('se-paper', p.data.look.paper);
        v.containerEl.toggleClass('se-no-dropcap', p.data.look.dropcap === false);
        (v as unknown as { __sePaper?: HTMLElement }).__sePaper?.toggleClass('is-active', p.data.look.paper);
      }
      else { removeLookbar(v); this.removeHeaderButtons(v); applyVars(v.containerEl, null); v.containerEl.removeClass('se-paper', 'se-no-dropcap'); }
    }
    if (this.printStyle) this.printStyle.textContent = printCss(this.activeProject()?.data.look ?? null);
    // Reading view re-reads the note a moment after it changes; check the space then.
    window.setTimeout(() => this.refreshGaps(), 120);
    if (this.styleSheet) this.styleSheet.textContent = styleRules([...this.projects.values()].flatMap(p => p.data.look.styles.map(s => s.id)));
  }
  /** The Chapters fold-out stays open (in every chapter) until its button is clicked again. */
  private chaptersOpen = false;
  /** Aa, as a real button in the note's header (next to Obsidian's own). */
  /** The World button in every note's header, just left of Obsidian's ⋮ menu. Lit while the World view is open. */
  private worldButton(v: MarkdownView, open: boolean) {
    const k = v as unknown as { __seWorld?: HTMLElement };
    let b = k.__seWorld;
    if (!b || !b.isConnected) {
      b = v.addAction('map', 'World', () => void this.toggleWorld());
      b.addClass('se-world-btn');
      const bar = b.parentElement;
      const more = bar ? Array.from(bar.children).find(c => c !== b && (c.matches('[aria-label="More options"], .mod-more-options') || !!c.querySelector('svg.lucide-more-vertical, svg.lucide-ellipsis-vertical'))) : null;
      if (bar && more) bar.insertBefore(b, more); else bar?.appendChild(b);
      k.__seWorld = b;
    }
    b.toggleClass('is-active', open);
  }
  private addHeaderButtons(v: MarkdownView, p: Project) {
    const k = v as unknown as { __seButtons?: HTMLElement[]; __sePaper?: HTMLElement };
    if (k.__seButtons?.every(b => b.isConnected)) return;
    k.__seButtons?.forEach(b => b.remove());
    // Paper: see the chapter as a book page (light page, dark text). One switch for the whole story.
    const paper = v.addAction('scroll-text', 'Paper', () => { const q = this.projectFor(v.file?.path ?? '') ?? p; q.setLook({ paper: !q.data.look.paper }); });
    paper.addClass('se-paper-btn');
    const look = v.addAction('type', 'Book look', () => { toggleLookbar(v); this.applyLooks(); });
    look.addClass('se-look-aa'); look.empty(); look.setText('Aa');
    // Bold, Italic, Strikethrough: always in the middle of the header (the marks themselves are hidden in chapters).
    const header = (v as unknown as { headerEl?: HTMLElement }).headerEl ?? v.containerEl.querySelector('.view-header') as HTMLElement;
    const fmt = header.createDiv('se-fmt-bar');
    for (const [ic, label, keys, mark] of [['bold', 'Bold', 'Ctrl+B', '**'], ['italic', 'Italic', 'Ctrl+I', '*'], ['strikethrough', 'Strikethrough', '', '~~']] as const) {
      const b = fmt.createEl('button', { cls: 'clickable-icon se-fmt' }); setIcon(b, ic); b.setAttribute('aria-label', label);
      tip(b, keys ? `${label}\n${keys}` : label);
      b.addEventListener('mousedown', e => e.preventDefault());   // keep the selection in the chapter
      b.onclick = e => { e.preventDefault(); this.formatIn(v, mark); };
    }
    k.__seButtons = [look, paper, fmt]; k.__sePaper = paper;
  }
  /** Bold, italic or strikethrough on the selection (or the word at the cursor). In reading view, it switches to editing first. */
  private formatIn(v: MarkdownView, mark: '**' | '*' | '~~') {
    if (v.getMode() !== 'source') { void v.setState({ ...v.getState(), mode: 'source' }, { history: false }); return; }
    const cm = (v.editor as unknown as { cm?: EditorView }).cm; if (cm) toggleWrap(cm, mark);
  }
  private removeHeaderButtons(v: MarkdownView) {
    const k = v as unknown as { __seButtons?: HTMLElement[] };
    k.__seButtons?.forEach(b => b.remove()); k.__seButtons = undefined;
    removeChapters(v); removeLookbar(v);
  }
  /**
   * Open a story's first chapter in the writing tab: the tab already showing a chapter (or any note) is reused,
   * never the World view's. Nothing happens if a chapter of that story is already open.
   */
  async openFirstChapter(p: Project) {
    const first = p.chapters()[0]; if (!first) return;
    const notes = this.app.workspace.getLeavesOfType('markdown');
    if (notes.some(l => l.view instanceof MarkdownView && l.view.file && p.isChapter(l.view.file))) return;
    const leaf = notes.find(l => l.view instanceof MarkdownView && l.view.file && this.projectFor(l.view.file.path)?.isChapter(l.view.file)) ?? notes[0] ?? this.app.workspace.getLeaf('tab');
    await leaf.openFile(first);
    if (leaf.view instanceof MarkdownView) placeCaret(leaf.view, true);
  }
  /**
   * New Scene: a scene break at the cursor (splitting the paragraph if the cursor is inside one), the cursor on the
   * line after it, then the new scene's POV picker.
   */
  newScene(v: MarkdownView, p: Project) {
    // In reading view it switches to editing, where the cursor says where the new scene starts.
    if (v.getMode() !== 'source') { void v.setState({ ...v.getState(), mode: 'source' }, { history: false }); return; }
    const f = v.file, cm = (v.editor as unknown as { cm?: EditorView }).cm; if (!f || !cm) return;
    const st = cm.state, head = st.selection.main.head, line = st.doc.lineAt(head);
    const before = st.doc.sliceString(line.from, head), after = st.doc.sliceString(head, line.to), BREAK = '✦ ✦ ✦';
    // Already at the start of a scene (nothing written in it above the cursor): a break here would leave an empty scene.
    const all = st.doc.toString().split('\n'), here = M.scenesOf(all).filter(s => s.startLine < line.number - 1).pop();
    const textAbove = here ? all.slice(here.startLine + 1, line.number - 1).some((l, i) => l.trim() && here.startLine + 1 + i !== here.metaLine) : true;
    const kindHere = classify(all)[line.number - 1];
    if (kindHere === 'heading' || kindHere === 'break' || kindHere === 'frontmatter' || (!textAbove && !before.replace(STYLE_MARK, '').trim())) { new Notice(`This is already the start of a ${M.wordsOf(p.data).scene.toLowerCase()}.`); cm.focus(); return; }
    let change: { from: number; to: number; insert: string }, cursor: number, breakLine: number;
    if (!line.text.trim()) {
      // An empty line: the break goes on it, and a fresh line below for the text.
      change = { from: line.from, to: line.to, insert: `${BREAK}\n` }; cursor = line.from + BREAK.length + 1; breakLine = line.number - 1;
    } else if (!after.trim()) {
      change = { from: line.from + before.trimEnd().length, to: line.to, insert: `\n${BREAK}\n` }; cursor = change.from + BREAK.length + 2; breakLine = line.number;
    } else if (!before.trim() || STYLE_MARK.exec(before)?.[0] === before) {
      change = { from: line.from, to: line.from, insert: `${BREAK}\n` }; cursor = line.from + BREAK.length + 1 + before.length; breakLine = line.number - 1;
    } else {
      const from = line.from + before.trimEnd().length, to = head + (after.length - after.trimStart().length);
      change = { from, to, insert: `\n${BREAK}\n` }; cursor = from + BREAK.length + 2; breakLine = line.number;
    }
    cm.dispatch({ changes: change, selection: { anchor: cursor }, scrollIntoView: true, userEvent: 'input' });
    cm.focus();
    const lines = cm.state.doc.toString().split('\n'), scene = M.scenesOf(lines).find(s => s.startLine === breakLine);
    if (!scene) return;
    // Once its scene bar is drawn, open the POV picker on it.
    window.setTimeout(() => {
      const at = cm.domAtPos(cm.state.doc.line(breakLine + 1).from).node, el = (at instanceof HTMLElement ? at : at.parentElement)?.closest('.cm-line');
      const chip = (el?.nextElementSibling as HTMLElement | null)?.querySelector('.se-chip-pov') as HTMLElement | null;
      this.capture.openScene(p, f, scene.index, 'pov', (chip ?? el ?? cm.contentDOM).getBoundingClientRect());
    }, 120);
  }
  /**
   * In chapters the formatting marks are hidden, which confuses Obsidian's own Bold and Italic (Ctrl+B / Ctrl+I, or
   * whatever keys you gave them): there they do the plugin's version instead. Everywhere else they're untouched.
   */
  private takeOverFormatting() {
    const cmds = (this.app as unknown as { commands?: { commands?: Record<string, { checkCallback?: (checking: boolean) => boolean | void }> } }).commands?.commands;
    for (const [id, mark] of [['editor:toggle-bold', '**'], ['editor:toggle-italics', '*']] as const) {
      const c = cmds?.[id], orig = c?.checkCallback; if (!c || !orig) continue;
      c.checkCallback = (checking: boolean) => {
        const v = this.app.workspace.getActiveViewOfType(MarkdownView), cm = v && (v.editor as unknown as { cm?: EditorView }).cm;
        if (v?.file && cm && v.getMode() === 'source' && this.projectFor(v.file.path)?.isChapter(v.file)) { if (!checking) toggleWrap(cm, mark); return true; }
        return orig.call(c, checking);
      };
      this.register(() => { c.checkCallback = orig; });
    }
  }
  /** Remember how far down reading view is (Obsidian forgets it when you switch to editing). */
  private watchReading(v: MarkdownView) {
    const vm = v as unknown as { __seReadLine?: number; __seReadEl?: HTMLElement };
    const el = v.contentEl.querySelector('.markdown-preview-view') as HTMLElement | null;
    if (!el || vm.__seReadEl === el) return;
    vm.__seReadEl = el;
    const note = () => { if (v.getMode() === 'preview') vm.__seReadLine = v.previewMode.getScroll(); };
    el.addEventListener('scroll', note, { passive: true }); note();
  }
  /**
   * Back from reading: the page stays where you were reading, and the cursor goes to the start of the first paragraph
   * that begins on screen. At the top of the chapter, that's the first paragraph under the title.
   */
  caretAtReading(v: MarkdownView) {
    const cm = (v.editor as unknown as { cm?: EditorView }).cm; if (!cm) return;
    const read = (v as unknown as { __seReadLine?: number }).__seReadLine ?? 0;
    setCaretReady(cm, false);
    const prose = (k: LineKind) => k === 'dropcap' || k === 'first' || k === 'para' || k === 'interlude';
    const go = () => {
      if (v.getMode() !== 'source') return;
      const st = cm.state, kinds = classify(st.doc.toString().split('\n'));
      const firstProse = kinds.findIndex(prose); if (firstProse < 0) return;
      let at = firstProse;
      if (read > firstProse) {
        // The same spot as in reading view: the line that was at the top, as far into it as it was.
        const n = Math.min(st.doc.lines, Math.floor(read) + 1), block = cm.lineBlockAt(st.doc.line(n).from);
        const docOffset = cm.documentTop - cm.scrollDOM.getBoundingClientRect().top + cm.scrollDOM.scrollTop;
        cm.scrollDOM.scrollTop = docOffset + block.top + (read - Math.floor(read)) * block.height;
        const top = cm.scrollDOM.getBoundingClientRect().top;
        at = kinds.findIndex((k, i) => i >= n - 1 && prose(k) && cm.documentTop + cm.lineBlockAt(st.doc.line(i + 1).from).top >= top - 2);
        if (at < 0) at = firstProse;
      }
      const line = st.doc.line(at + 1);
      cm.dispatch({ selection: { anchor: line.from + (STYLE_MARK.exec(line.text)?.[0].length ?? 0) } });
    };
    window.setTimeout(go, 30); window.setTimeout(() => { go(); setCaretReady(cm, true); }, 160);
  }
  /** The ribbon's map icon opens the World view, and closes it if it's already open. */
  async toggleWorld() {
    const leaves = this.app.workspace.getLeavesOfType(WORLD_VIEW);
    if (leaves.length) { for (const l of leaves) l.detach(); return; }
    await this.openWorld();
  }
  private followTimer: number | null = null;
  /** “Follow cursor”: the timeline's playhead goes to the scene the cursor is in (not while a capture box is open). */
  private followCursor(file: TFile, project: Project, line: number) {
    if (!this.settings.follow) return;
    if (this.followTimer !== null) window.clearTimeout(this.followTimer);
    this.followTimer = window.setTimeout(async () => {
      this.followTimer = null;
      if (this.capture.open) return;
      const s = await project.sceneFor(file, line);
      if (s && s.order !== project.data.view) { if (this.settings.active !== project.folder) this.setActive(project.folder); project.setView(s.order); }
    }, 250);
  }
  private zoomSave: number | null = null;
  /** Chapter zoom (screen only, this computer): 30%–300%. Shows the new size for a moment where you zoomed. */
  setDraftZoom(z: number, _where?: HTMLElement | null) {
    const next = Math.min(3, Math.max(0.3, Math.round(z * 100) / 100));
    if (next === this.settings.draftZoom) return;
    this.settings.draftZoom = next;
    this.applyLooks(); refreshEditors();
    if (this.zoomSave !== null) window.clearTimeout(this.zoomSave);
    this.zoomSave = window.setTimeout(() => { this.zoomSave = null; void this.saveSettings(); }, 400);
  }
  private refreshTimer: number | null = null;
  /** Re-draw underlines and scene bars in open chapters (batched: many changes can arrive at once). */
  refreshEditorsSoon() {
    if (this.refreshTimer !== null) return;
    this.refreshTimer = window.setTimeout(() => { this.refreshTimer = null; refreshEditors(); }, 80);
  }
  changed() { this.events.trigger('changed'); for (const l of this.app.workspace.getLeavesOfType(WORLD_VIEW)) (l.view as WorldView).renderSoon(); }
  async saveSettings() { await this.saveData(this.settings); }

  newStory() {
    new FolderPicker(this.app, async folder => {
      // A story is one folder: never the whole vault, never inside another story or around one (their notes would mix).
      if (folder.isRoot() || !folder.path || folder.path === '/') { new Notice('Choose a folder for the story, not the whole vault.'); return; }
      const clash = [...this.projects.keys()].find(k => k !== folder.path && (k === '' || folder.path.startsWith(k + '/') || k.startsWith(folder.path + '/')));
      if (clash !== undefined) { new Notice(`That folder ${clash === '' || folder.path.startsWith(clash + '/') ? 'is inside' : 'holds'} the story “${clash || 'vault'}”. Choose a folder of its own.`); return; }
      const p = new Project(this.app, folder.path);
      if (this.app.vault.getAbstractFileByPath(p.dataPath)) { this.setActive(folder.path); void this.openWorld(); return; }
      // Notes written before (an empty line between paragraphs) are converted to one line per paragraph when the story is found.
      p.data.format = 1;
      await p.saveNow();
      await p.ensureFolder(p.worldFolder);
      await this.discover();
      this.setActive(folder.path);
      // Offer the book look only to plain notes; anything already styled (a cover page, say) is left alone.
      const plain = this.app.vault.getMarkdownFiles().filter(f => { const fm = this.app.metadataCache.getFileCache(f)?.frontmatter; return p.contains(f.path) && !p.inWorld(f.path) && !p.isChapter(f) && !(fm?.cssclasses ?? fm?.cssclass); });
      if (plain.length) new ConfirmModal(this.app, `Make ${plain.length === 1 ? 'this note a chapter' : `these ${plain.length} notes chapters`}?`,
        `${plain.slice(0, 6).map(f => f.basename).join(', ')}${plain.length > 6 ? '…' : ''}. Each one gets the book look, with one line per paragraph. A copy of the original goes to ${p.folder}/Backups first.`,
        'Make chapters', async () => { for (const f of plain) await this.toggleManuscript(f, true); window.setTimeout(() => { const np = this.projects.get(folder.path); if (np) void this.openFirstChapter(np); }, 600); }).open();
      else window.setTimeout(() => { const np = this.projects.get(folder.path); if (np) void this.openFirstChapter(np); }, 600);
      new Notice(`“${p.name}” is set up as a story.`);
      void this.openWorld();
    }).open();
  }
  /** Stop using a folder as a story: its data file (and, if asked, its World folder) go to the trash. Chapters are never touched. */
  async removeStory(p: Project, world: boolean) {
    const data = this.app.vault.getAbstractFileByPath(p.dataPath), w = this.app.vault.getAbstractFileByPath(p.worldFolder);
    if (data instanceof TFile) await this.app.fileManager.trashFile(data);
    if (world && w) await this.app.fileManager.trashFile(w);
    p.dispose(); this.projects.delete(p.folder);
    if (this.settings.active === p.folder) this.settings.active = [...this.projects.keys()][0] ?? null;
    await this.saveSettings();
    this.changed(); this.applyLooks();
    new Notice(`“${p.name}” is no longer a story. Its chapters are still in ${p.folder}.${world ? ' The World folder is in the trash.' : ''}`);
  }
  newChapter() {
    const p = this.activeProject();
    if (!p) { this.newStory(); return; }
    new PromptModal(this.app, 'New Chapter', 'Chapter title', async title => {
      const f = await p.createChapter(title);
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(f);
      if (leaf.view instanceof MarkdownView) startWriting(leaf.view);
    }).open();
  }
  async toggleManuscript(f: TFile, force?: boolean): Promise<boolean> {
    let on = false;
    await this.app.fileManager.processFrontMatter(f, fm => {
      const raw = fm.cssclasses ?? fm.cssclass;
      const list: string[] = Array.isArray(raw) ? raw.map(String) : raw ? String(raw).split(/[\s,]+/).filter(Boolean) : [];
      on = force ?? !list.includes('manuscript');
      const next = on ? [...new Set([...list, 'manuscript'])] : list.filter(c => c !== 'manuscript');
      delete fm.cssclass;
      if (next.length) fm.cssclasses = next; else delete fm.cssclasses;
    });
    // A note turning into a chapter switches to one line per paragraph (the original is kept in Backups).
    const p = this.projectFor(f.path);
    if (on && p) {
      // A chapter's title is its “# ” line: a note without one (a new “Untitled” note, say) gets one from its file name.
      const text = await this.app.vault.read(f), next = M.withTitle(toLinePerParagraph(text), p.chapterTitle(f));
      if (next !== text) { await p.backup(`${p.folder ? p.folder + '/' : ''}Backups/Before book look`, f, text); await this.app.vault.modify(f, next); }
    }
    return on;
  }

  /* ───────── views ───────── */

  async openWorld(): Promise<WorldView | null> {
    let leaf = this.app.workspace.getLeavesOfType(WORLD_VIEW)[0];
    if (!leaf) { leaf = this.app.workspace.getLeaf('split', 'vertical'); await leaf.setViewState({ type: WORLD_VIEW, active: false }); }
    await this.app.workspace.revealLeaf(leaf);
    return leaf.view instanceof WorldView ? leaf.view : null;
  }
  /** “Where” in a scene bar: the World view on that scene, zoomed to where its POV character is (as the line under the map does). */
  private async showSceneOnMap(p: Project, file: TFile, index: number) {
    if (this.settings.active !== p.folder) this.setActive(p.folder);
    const scene = (await p.timeline()).scenes.find(s => s.file.path === file.path && s.index === index);
    if (scene) p.setView(scene.order);
    const leaf = this.app.workspace.getLeavesOfType(WORLD_VIEW)[0];
    const view = leaf?.view instanceof WorldView ? leaf.view : await this.openWorld();
    if (leaf) await this.app.workspace.revealLeaf(leaf);
    window.setTimeout(() => view?.focusPov(), 120);
  }
  private async showPiece(p: Project, id: string) {
    if (this.settings.active !== p.folder) this.setActive(p.folder);
    const leaf = this.app.workspace.getLeavesOfType(WORLD_VIEW)[0];
    const view = leaf?.view instanceof WorldView ? leaf.view : await this.openWorld();
    view?.focusPiece(id);
  }
  private newPieceFromCommand() {
    const p = this.activeProject();
    if (!p) { this.newStory(); return; }
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const f = view?.file && p.isChapter(view.file) ? view.file : null;
    const rect = this.cursorRect();
    if (f && view) void p.sceneFor(f, view.editor.getCursor().line).then(s => this.capture.startManual(p, f, s, rect));
    else void this.capture.startManual(p, null, undefined, rect);
  }
  private cursorRect(): DOMRect {
    const s = window.getSelection();
    if (s?.rangeCount) { const r = s.getRangeAt(0).getBoundingClientRect(); if (r.width || r.height) return r; }
    return new DOMRect(window.innerWidth / 2 - 160, 120, 0, 0);
  }
}

class ConfirmModal extends Modal {
  constructor(app: App, private heading: string, private body: string, private ok: string, private run: () => Promise<void>) { super(app); }
  onOpen() {
    this.titleEl.setText(this.heading);
    this.contentEl.createEl('p', { text: this.body });
    const row = this.contentEl.createDiv('se-acts');
    row.createEl('button', { text: 'Not Now' }).onclick = () => this.close();
    row.createEl('button', { cls: 'mod-cta', text: this.ok }).onclick = async () => { await this.run(); this.close(); };
  }
  onClose() { this.contentEl.empty(); }
}
class PromptModal extends Modal {
  constructor(app: App, private heading: string, private placeholder: string, private done: (v: string) => Promise<void>) { super(app); }
  onOpen() {
    this.titleEl.setText(this.heading);
    const input = this.contentEl.createEl('input', { cls: 'se-namefield' }); input.type = 'text'; input.placeholder = this.placeholder;
    const ok = async () => { const v = input.value.trim(); if (!v) return; await this.done(v); this.close(); };
    input.onkeydown = e => { if (e.key === 'Enter') void ok(); };
    const row = this.contentEl.createDiv('se-acts');
    row.createEl('button', { cls: 'mod-cta', text: 'Create' }).onclick = () => void ok();
    input.focus();
  }
  onClose() { this.contentEl.empty(); }
}

class SettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: StoryEnginePlugin) { super(app, plugin); }
  display() {
    const c = this.containerEl; c.empty();
    new Setting(c).setName('Scene bars').setDesc('Show the POV · When · Where bar at the start of each scene in your chapters.')
      .addToggle(t => t.setValue(this.plugin.settings.sceneBars).onChange(async v => { this.plugin.settings.sceneBars = v; await this.plugin.saveSettings(); refreshEditors(); }));
    new Setting(c).setName('Stories').setDesc(this.plugin.projects.size ? [...this.plugin.projects.values()].map(p => p.name).join(', ') : 'None yet.')
      .addButton(b => b.setButtonText('Set Up a Story…').onClick(() => this.plugin.newStory()));
    new Setting(c).setName('Follow cursor').setDesc('The World view\'s timeline follows the scene your cursor is in.')
      .addToggle(t => t.setValue(this.plugin.settings.follow).onChange(async v => { this.plugin.settings.follow = v; await this.plugin.saveSettings(); this.plugin.changed(); }));
    new Setting(c).setName('Capture hotkey').setDesc('Highlighting text opens the capture box automatically. You can also give “Story Engine: Add selection to world” a hotkey in Settings → Hotkeys.');
  }
}

