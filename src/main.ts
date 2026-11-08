import { App, Events, MarkdownPostProcessorContext, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, normalizePath } from 'obsidian';
import { Project, DATA_FILE } from './project';
import { Capture } from './capture';
import { storyEditorExtensions, refreshEditors } from './editor';
import { WorldView, WORLD_VIEW, FolderPicker } from './world';
import { classify, classesFor, gapBefore, LineKind, stylesOf, toLinePerParagraph } from './manuscript';
import { applyVars, ensureLookbar, LookActions, lookVars, printCss, removeLookbar, styleRules, toggleLookbar } from './look';
import { addStyleItems } from './styles';
import { BookExportModal, copyChapterForWeb } from './export';
import { placeCaret, removeChapters, startWriting, syncChapters } from './chapters';

interface Settings { active: string | null; sceneBars: boolean; follow: boolean; statusFolded: boolean; draftZoom: number }
const DEFAULTS: Settings = { active: null, sceneBars: true, follow: true, statusFolded: false, draftZoom: 1 };

export default class StoryEnginePlugin extends Plugin {
  settings: Settings = { ...DEFAULTS };
  projects = new Map<string, Project>();
  events = new Events();
  capture!: Capture;
  private scenesTimer: number | null = null;

  async onload() {
    this.settings = { ...DEFAULTS, ...((await this.loadData()) ?? {}) };
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
      onSceneChip: (file, project, index, key, rect) => void this.capture.openScene(project, file, index, key, rect),
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
    this.addCommand({ id: 'draft-zoom-reset', name: 'Reset chapter zoom', callback: () => this.setDraftZoom(1) });
    // Right-click a paragraph in a chapter: Style → …
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, info) => {
      const f = info.file, p = f && this.projectFor(f.path);
      if (f && p?.isChapter(f)) addStyleItems(this.app, menu, editor, p);
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
        } else if (lines.length) look(block, lines[0]);
        // Empty lines above it: that many lines of space, kept up to date (reading view doesn't redraw a block when only the empty lines around it change).
        this.gapEls.set(el, ctx); this.applyGap(el, ctx);
      } else if (block.tagName === 'P' && /^[\s✦⁂]+$/.test(block.textContent ?? '')) block.addClass('mm-line', 'mm-break');
    });

    this.app.workspace.onLayoutReady(() => void this.discover());
    this.registerEvent(this.app.metadataCache.on('changed', f => { for (const p of this.projects.values()) if (p.contains(f.path)) p.indexFile(f); this.applyLooksSoon(); }));
    this.registerEvent(this.app.vault.on('create', f => { if (f instanceof TFile && f.name === DATA_FILE) void this.discover(); }));
    this.registerEvent(this.app.vault.on('delete', f => {
      if (f instanceof TFile && f.name === DATA_FILE) { this.projects.delete(f.parent?.path === '/' ? '' : f.parent?.path ?? ''); this.changed(); return; }
      for (const p of this.projects.values()) if (p.contains(f.path)) p.forget(f.path);
    }));
    this.registerEvent(this.app.vault.on('rename', (f, old) => {
      if (!(f instanceof TFile)) { void this.discover(); return; }
      for (const p of this.projects.values()) { if (p.contains(old)) p.forget(old); if (p.contains(f.path)) { p.indexFile(f); void p.onRename(f, old); } }
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
      void this.capture.onSelect(p, f, editor.posToOffset(editor.getCursor('from')), { text: sel, rect: this.cursorRect(), file: f });
    } });
    this.addCommand({ id: 'new-story', name: 'Set up a story', callback: () => this.newStory() });
    this.addCommand({ id: 'new-chapter', name: 'New chapter', callback: () => this.newChapter() });
    this.addCommand({ id: 'toggle-manuscript', name: 'Turn book look on/off for this note', checkCallback: checking => {
      const f = this.app.workspace.getActiveViewOfType(MarkdownView)?.file; if (!f) return false;
      if (!checking) void this.toggleManuscript(f).then(on => new Notice(on ? 'Book look on.' : 'Book look off.'));
      return true;
    } });
    this.addCommand({ id: 'export-epub', name: 'Export e-book (EPUB)', callback: () => { const p = this.activeProject(); if (p) new BookExportModal(this.app, p, 'epub').open(); } });
    this.addCommand({ id: 'export-pdf', name: 'Export PDF', callback: () => { const p = this.activeProject(); if (p) new BookExportModal(this.app, p, 'pdf').open(); } });
    this.addCommand({ id: 'export-docx', name: 'Export Word document', callback: () => { const p = this.activeProject(); if (p) new BookExportModal(this.app, p, 'docx').open(); } });
    this.addCommand({ id: 'copy-chapter-web', name: 'Copy this chapter for web', checkCallback: checking => {
      const v = this.app.workspace.getActiveViewOfType(MarkdownView), f = v?.file, p = f && this.projectFor(f.path);
      if (!v || !f || !p?.isChapter(f)) return false;
      if (!checking) void copyChapterForWeb(p, v.editor.getValue(), p.chapterTitle(f));
      return true;
    } });
    this.addCommand({ id: 'toggle-paper', name: 'Paper: show chapters as a book page', callback: () => { const p = this.activeProject(); if (p) p.setLook({ paper: !p.data.look.paper }); } });
    this.addCommand({ id: 'toggle-scene-bars', name: 'Show/hide scene bars', callback: async () => { this.settings.sceneBars = !this.settings.sceneBars; await this.saveSettings(); refreshEditors(); } });
    this.addSettingTab(new SettingsTab(this.app, this));
  }

  /* ───────── projects ───────── */

  async discover() {
    const found = new Set<string>();
    for (const f of this.app.vault.getFiles()) if (f.name === DATA_FILE) found.add(f.parent && f.parent.path !== '/' ? f.parent.path : '');
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
    for (const k of [...this.projects.keys()]) if (!found.has(k)) this.projects.delete(k);
    if (this.settings.active && !this.projects.has(this.settings.active)) this.settings.active = null;
    refreshEditors();
    this.changed();
    this.applyLooks();
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
        ensureLookbar(v, p, this.lookActions(p)); this.addHeaderButtons(v, p); syncChapters(v, p, this.chaptersOpen, () => { this.chaptersOpen = !this.chaptersOpen; this.applyLooks(); });
        applyVars(v.containerEl, lookVars(p.data.look, true, this.settings.draftZoom));
        v.containerEl.toggleClass('se-paper', p.data.look.paper);
        (v as unknown as { __sePaper?: HTMLElement }).__sePaper?.toggleClass('is-active', p.data.look.paper);
      }
      else { removeLookbar(v); this.removeHeaderButtons(v); applyVars(v.containerEl, null); v.containerEl.removeClass('se-paper'); }
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
    k.__seButtons = [look, paper]; k.__sePaper = paper;
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
  /** Chapter zoom (screen only, this computer): 50%–300%. Shows the new size for a moment where you zoomed. */
  setDraftZoom(z: number, where?: HTMLElement | null) {
    const next = Math.min(3, Math.max(0.5, Math.round(z * 100) / 100));
    if (next === this.settings.draftZoom) return;
    this.settings.draftZoom = next;
    this.applyLooks(); refreshEditors();
    if (this.zoomSave !== null) window.clearTimeout(this.zoomSave);
    this.zoomSave = window.setTimeout(() => { this.zoomSave = null; void this.saveSettings(); }, 400);
    const host = where ?? this.app.workspace.getActiveViewOfType(MarkdownView)?.containerEl;
    if (host) {
      let toast = host.querySelector(':scope > .se-zoom-toast') as HTMLElement | null;
      if (!toast) toast = host.createDiv('se-zoom-toast');
      toast.setText(`${Math.round(next * 100)}%`); toast.removeClass('is-gone');
      window.clearTimeout(Number(toast.dataset.t ?? 0));
      toast.dataset.t = String(window.setTimeout(() => toast!.addClass('is-gone'), 900));
    }
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
      if (plain.length) new ConfirmModal(this.app, `Use the book look for ${plain.length} note${plain.length > 1 ? 's' : ''} in “${p.name}”?`,
        `Chapters need the book look to get scene bars and capture: ${plain.slice(0, 6).map(f => f.basename).join(', ')}${plain.length > 6 ? '…' : ''}. Skip any that aren't chapters (cover pages, notes) and switch them on later with “Turn book look on/off for this note”.`,
        'Use the book look', async () => { for (const f of plain) await this.toggleManuscript(f, true); }).open();
      new Notice(`“${p.name}” is set up as a story.`);
      void this.openWorld();
    }).open();
  }
  newChapter() {
    const p = this.activeProject();
    if (!p) { this.newStory(); return; }
    new PromptModal(this.app, 'New chapter', 'Chapter title', async title => {
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
      const text = await this.app.vault.read(f), next = toLinePerParagraph(text);
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
    row.createEl('button', { text: 'Not now' }).onclick = () => this.close();
    row.createEl('button', { cls: 'mod-cta', text: this.ok }).onclick = async () => { await this.run(); this.close(); };
  }
  onClose() { this.contentEl.empty(); }
}
class PromptModal extends Modal {
  constructor(app: App, private heading: string, private placeholder: string, private done: (v: string) => Promise<void>) { super(app); }
  onOpen() {
    this.titleEl.setText(this.heading);
    const input = this.contentEl.createEl('input', { cls: 'se-namefield' }); input.placeholder = this.placeholder;
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
      .addButton(b => b.setButtonText('Set up a story…').onClick(() => this.plugin.newStory()));
    new Setting(c).setName('Follow cursor').setDesc('The World view\'s timeline follows the scene your cursor is in.')
      .addToggle(t => t.setValue(this.plugin.settings.follow).onChange(async v => { this.plugin.settings.follow = v; await this.plugin.saveSettings(); this.plugin.changed(); }));
    new Setting(c).setName('Capture hotkey').setDesc('Highlighting text opens the capture box automatically. You can also give “Story Engine: Add selection to world” a hotkey in Settings → Hotkeys.');
  }
}

