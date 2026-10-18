import { api } from './api.js';
import { icon } from './icons.js';
import { esc, debounce, formatPercent, clamp, excerptOf } from './util.js';
import { toast } from './ui.js';

const DEFAULT_PREFS = {
  readerTheme: 'paper',
  fontFamily: 'serif',
  fontSize: 20,
  lineHeight: 2,
  readerWidth: 'normal'
};

const THEME_LABELS = {
  paper: '宣纸',
  sepia: '米黄',
  green: '豆绿',
  night: '夜读'
};

const FONT_LABELS = {
  serif: '宋体',
  kai: '楷体',
  sans: '黑体'
};

const WIDTH_LABELS = {
  narrow: '窄',
  normal: '适中',
  wide: '宽'
};

export class Reader {
  constructor(options) {
    this.api = options.api;
    this.getPrefs = options.getPrefs;
    this.savePrefs = options.savePrefs;
    this.getUser = options.getUser;
    this.onExit = options.onExit;
    this.onRequireLogin = options.onRequireLogin;
    this.onProgress = options.onProgress;
    this.root = document.getElementById('reader-root');
    this.isOpen = false;
    this.source = '';
    this.bookId = '';
    this.chapterId = '';
    this.bookData = null;
    this.chapterData = null;
    this.prefs = { ...DEFAULT_PREFS };
    this.loadToken = 0;
    this.scrollFrame = 0;
    this.panel = '';
    this.bookPromise = null;
    this.boundKeydown = event => this.handleKeydown(event);
    this.boundFullscreen = () => this.updateFullscreenButton();
    this.saveCurrent = debounce(() => this.persistProgress(), 1400);
    this.persistPrefsLater = debounce(() => this.persistPrefs(), 450);
  }

  async open({ source, bookId, chapterId, progress = null }) {
    if (!source || !bookId || !chapterId) {
      toast('章节地址不完整', 'error');
      this.onExit?.();
      return;
    }
    const sameBook = this.isOpen && this.source === source && this.bookId === bookId;
    if (!sameBook) {
      this.reset();
      this.isOpen = true;
      this.source = source;
      this.bookId = bookId;
      document.body.classList.add('reader-open');
      this.prefs = { ...DEFAULT_PREFS, ...(this.getPrefs() || {}) };
      this.buildShell();
      this.bookPromise = this.loadBook();
      document.addEventListener('keydown', this.boundKeydown);
      document.addEventListener('fullscreenchange', this.boundFullscreen);
    }
    this.initialProgress = progress && progress.chapterId === chapterId ? progress : null;
    await this.loadChapter(chapterId, { restore: Boolean(this.initialProgress) });
  }

  reset() {
    this.loadToken += 1;
    this.saveCurrent.cancel();
    this.persistPrefsLater.cancel();
    this.chapterData = null;
    this.bookData = null;
    this.bookPromise = null;
    this.chapterId = '';
    this.panel = '';
    this.root.innerHTML = '';
    document.body.classList.remove('reader-open');
    document.removeEventListener('keydown', this.boundKeydown);
    document.removeEventListener('fullscreenchange', this.boundFullscreen);
  }

  close() {
    if (!this.isOpen) return;
    this.persistProgress({ silent: true });
    this.reset();
    this.isOpen = false;
    this.onExit?.();
  }

  async loadBook() {
    try {
      const data = await this.api.book(this.source, this.bookId);
      this.bookData = data.book;
      this.updateBookTitle();
      if (this.panel === 'chapters') this.renderChapterPanel();
    } catch {
      this.bookData = null;
    }
  }

  buildShell() {
    const prefs = this.prefs;
    this.root.innerHTML = `<div class="reader" data-reader-theme="${esc(prefs.readerTheme)}" data-reader-font="${esc(prefs.fontFamily)}" data-reader-width="${esc(prefs.readerWidth)}" style="--reader-font-size:${clamp(prefs.fontSize, 15, 30)}px;--reader-line-height:${clamp(prefs.lineHeight, 1.4, 2.6)}">
      <div class="reader-top-progress"><span data-top-progress></span></div>
      <header class="reader-bar">
        <button class="icon-btn reader-back" data-back aria-label="返回书籍详情" title="返回详情">${icon('arrow-left', 20)}</button>
        <div class="reader-bar-title">
          <strong data-book-title>正在取书</strong>
          <span data-bar-chapter></span>
        </div>
        <div class="reader-bar-actions">
          <button class="icon-btn" data-bookmark aria-label="添加书签" title="添加书签（B）">${icon('bookmark', 19)}</button>
          <button class="icon-btn" data-chapters aria-label="目录" title="目录">${icon('list', 19)}</button>
          <button class="icon-btn" data-settings aria-label="阅读设置" title="阅读设置">${icon('type', 19)}</button>
          <button class="icon-btn reader-fullscreen" data-fullscreen aria-label="全屏" title="全屏（F）">${icon('maximize', 18)}</button>
        </div>
      </header>
      <div class="reader-scroll" data-scroll>
        <article class="reader-article">
          <p class="reader-overline" data-overline></p>
          <h1 class="reader-chapter-title" data-chapter-title>正在取书</h1>
          <div class="reader-chapter-meta" data-chapter-meta></div>
          <div class="reader-content" data-content></div>
          <div class="reader-end" data-end></div>
        </article>
      </div>
      <footer class="reader-footer">
        <button class="reader-nav-btn" data-prev disabled>${icon('chevron-left', 17)}<span>上一章</span></button>
        <div class="reader-location">
          <div class="reader-location-track"><span data-location-fill></span></div>
          <p><span data-location-text>第 1 章</span><span data-percent-text>0%</span></p>
        </div>
        <button class="reader-nav-btn" data-next disabled><span>下一章</span>${icon('chevron-right', 17)}</button>
      </footer>
      <div class="reader-scrim" data-scrim></div>
      <aside class="reader-panel reader-settings-panel" data-settings-panel aria-hidden="true">
        <div class="reader-panel-head">
          <div><p>READING</p><h2>阅读设置</h2></div>
          <button class="icon-btn" data-close-panel aria-label="关闭">${icon('x', 18)}</button>
        </div>
        <div class="settings-section">
          <h3>护眼模式</h3>
          <div class="theme-grid">
            ${Object.entries(THEME_LABELS).map(([key, label]) => `<button class="theme-chip theme-chip-${key}" data-theme="${key}" aria-pressed="false"><span class="theme-dot"></span>${label}</button>`).join('')}
          </div>
        </div>
        <div class="settings-section">
          <h3>字体</h3>
          <div class="segmented" data-font-group>
            ${Object.entries(FONT_LABELS).map(([key, label]) => `<button data-font="${key}">${label}</button>`).join('')}
          </div>
        </div>
        <div class="settings-section">
          <h3>字号 <em data-font-size-label>${prefs.fontSize}px</em></h3>
          <div class="stepper">
            <button data-font-size="-1" aria-label="减小字号">A−</button>
            <input type="range" min="15" max="30" step="1" value="${prefs.fontSize}" data-font-size-range aria-label="字号">
            <button data-font-size="1" aria-label="增大字号">A＋</button>
          </div>
        </div>
        <div class="settings-section">
          <h3>行距 <em data-line-height-label>${Number(prefs.lineHeight).toFixed(1)}</em></h3>
          <div class="stepper">
            <button data-line-height="-0.1" aria-label="减小行距">−</button>
            <input type="range" min="1.4" max="2.6" step="0.1" value="${prefs.lineHeight}" data-line-height-range aria-label="行距">
            <button data-line-height="0.1" aria-label="增大行距">＋</button>
          </div>
        </div>
        <div class="settings-section">
          <h3>版心</h3>
          <div class="segmented" data-width-group>
            ${Object.entries(WIDTH_LABELS).map(([key, label]) => `<button data-width="${key}">${label}</button>`).join('')}
          </div>
        </div>
        <div class="settings-tip">${icon('eye', 15)}<span>长时间阅读请适当休息，让眼睛望向远处。</span></div>
        <button class="btn btn-ghost settings-reset" data-reset-prefs>恢复默认</button>
      </aside>
      <aside class="reader-panel reader-chapter-panel" data-chapter-panel aria-hidden="true">
        <div class="reader-panel-head">
          <div><p>CONTENTS</p><h2>目录</h2></div>
          <button class="icon-btn" data-close-panel aria-label="关闭">${icon('x', 18)}</button>
        </div>
        <div class="chapter-filter"><input type="search" placeholder="查找章节名…" data-chapter-filter aria-label="查找章节"></div>
        <p class="chapter-count" data-chapter-count></p>
        <div class="chapter-list" data-chapter-list></div>
      </aside>
    </div>`;
    this.el = {
      reader: this.root.querySelector('.reader'),
      scroll: this.root.querySelector('[data-scroll]'),
      content: this.root.querySelector('[data-content]'),
      overline: this.root.querySelector('[data-overline]'),
      chapterTitle: this.root.querySelector('[data-chapter-title]'),
      chapterMeta: this.root.querySelector('[data-chapter-meta]'),
      bookTitle: this.root.querySelector('[data-book-title]'),
      barChapter: this.root.querySelector('[data-bar-chapter]'),
      topProgress: this.root.querySelector('[data-top-progress]'),
      locationFill: this.root.querySelector('[data-location-fill]'),
      locationText: this.root.querySelector('[data-location-text]'),
      percentText: this.root.querySelector('[data-percent-text]'),
      end: this.root.querySelector('[data-end]'),
      prev: this.root.querySelector('[data-prev]'),
      next: this.root.querySelector('[data-next]'),
      settingsPanel: this.root.querySelector('[data-settings-panel]'),
      chapterPanel: this.root.querySelector('[data-chapter-panel]'),
      scrim: this.root.querySelector('[data-scrim]'),
      chapterList: this.root.querySelector('[data-chapter-list]'),
      chapterCount: this.root.querySelector('[data-chapter-count]'),
      chapterFilter: this.root.querySelector('[data-chapter-filter]')
    };
    this.applyPrefs();
    this.bindEvents();
    this.el.scroll.addEventListener('scroll', () => this.onScroll(), { passive: true });
    setTimeout(() => this.refreshPanels(), 0);
  }

  bindEvents() {
    this.root.addEventListener('click', event => {
      const target = event.target.closest('button, [data-cid]');
      if (!target || !this.root.contains(target)) return;
      if (target.dataset.back !== undefined) {
        this.close();
        return;
      }
      if (target.dataset.settings !== undefined) {
        this.openPanel('settings');
        return;
      }
      if (target.dataset.chapters !== undefined) {
        this.openPanel('chapters');
        return;
      }
      if (target.dataset.closePanel !== undefined) {
        this.closePanel();
        return;
      }
      if (target.dataset.scrim !== undefined) {
        this.closePanel();
        return;
      }
      if (target.dataset.fullscreen !== undefined) {
        this.toggleFullscreen();
        return;
      }
      if (target.dataset.prev !== undefined) {
        this.goRelative(-1);
        return;
      }
      if (target.dataset.next !== undefined) {
        this.goRelative(1);
        return;
      }
      if (target.dataset.bookmark !== undefined) {
        this.addBookmark();
        return;
      }
      if (target.dataset.retry !== undefined) {
        this.loadChapter(this.chapterId, { restore: true });
        return;
      }
      if (target.dataset.theme) {
        this.updatePrefs({ readerTheme: target.dataset.theme });
        return;
      }
      if (target.dataset.font) {
        this.updatePrefs({ fontFamily: target.dataset.font });
        return;
      }
      if (target.dataset.width) {
        this.updatePrefs({ readerWidth: target.dataset.width });
        return;
      }
      if (target.dataset.fontSize) {
        const delta = Number(target.dataset.fontSize);
        this.updatePrefs({ fontSize: clamp(this.prefs.fontSize + delta, 15, 30) });
        return;
      }
      if (target.dataset.lineHeight) {
        const delta = Number(target.dataset.lineHeight);
        this.updatePrefs({ lineHeight: Math.round(clamp(this.prefs.lineHeight + delta, 1.4, 2.6) * 10) / 10 });
        return;
      }
      if (target.dataset.resetPrefs !== undefined) {
        this.updatePrefs({ ...DEFAULT_PREFS });
        return;
      }
      if (target.dataset.cid) {
        this.goToChapter(target.dataset.cid);
      }
    });
    this.el.settingsPanel.addEventListener('input', event => {
      if (event.target.matches('[data-font-size-range]')) {
        this.updatePrefs({ fontSize: Number(event.target.value) });
      } else if (event.target.matches('[data-line-height-range]')) {
        this.updatePrefs({ lineHeight: Number(event.target.value) });
      }
    });
    this.el.chapterFilter.addEventListener('input', () => this.renderChapterList(this.el.chapterFilter.value));
    this.root.querySelector('.reader-settings-panel').addEventListener('change', () => {});
  }

  async loadChapter(chapterId, { restore = false } = {}) {
    if (!chapterId) return;
    const token = ++this.loadToken;
    this.chapterId = chapterId;
    this.el.chapterTitle.textContent = '正在取书';
    this.el.chapterMeta.textContent = '';
    this.el.overline.textContent = this.bookData?.title || '';
    this.el.content.innerHTML = `<div class="reader-inline-loading"><div class="ink-loader"><span></span><span></span><span></span></div><p>正在翻页…</p></div>`;
    this.el.end.innerHTML = '';
    this.el.prev.disabled = true;
    this.el.next.disabled = true;
    this.el.barChapter.textContent = '取书中';
    this.root.querySelector('[data-chapter-list]')?.classList.remove('is-ready');
    try {
      const data = await this.api.chapter(this.source, this.bookId, chapterId);
      if (token !== this.loadToken) return;
      this.chapterData = data;
      if (data.chapter?.id && String(data.chapter.id) !== String(this.chapterId)) {
        this.chapterId = String(data.chapter.id);
        this.replaceChapterHash(this.chapterId);
      }
      let resume = restore;
      const saved = data.state?.progress;
      if (!resume && !this.initialProgress && saved
        && String(saved.chapterId) === String(this.chapterId)
        && Number(saved.chapterPercent) > 0.01) {
        this.initialProgress = saved;
        resume = true;
      }
      this.renderChapter(data, { restore: resume });
      setTimeout(() => this.persistProgress({ silent: true }), 900);
    } catch (error) {
      if (token !== this.loadToken) return;
      this.renderError(error);
    }
  }

  renderChapter(data, { restore = false } = {}) {
    const chapter = data.chapter;
    const book = data.book || {};
    this.el.overline.textContent = book.title || this.bookData?.title || '';
    this.el.chapterTitle.textContent = chapter.title || '未命名章节';
    this.el.chapterMeta.textContent = `第 ${data.index} / ${data.total} 章 · ${chapter.words ? `${chapter.words} 字` : '正文'}`;
    this.el.bookTitle.textContent = book.title || this.bookData?.title || '墨阅';
    this.el.barChapter.textContent = `第 ${data.index} 章`;
    const paragraphs = Array.isArray(chapter.paragraphs) && chapter.paragraphs.length
      ? chapter.paragraphs
      : String(chapter.text || '').split(/\n+/).filter(Boolean);
    this.el.content.innerHTML = paragraphs.map(text => `<p>${esc(text)}</p>`).join('') || '<p class="reader-empty">这一章暂时没有正文。</p>';
    this.el.end.innerHTML = `<div class="end-mark"><span>本章完</span></div>
      <div class="end-actions">
        ${data.prev ? `<button class="btn btn-ghost" data-cid="${esc(data.prev.id)}">${icon('chevron-left', 15)} ${esc(data.prev.title || '上一章')}</button>` : '<span></span>'}
        ${data.next ? `<button class="btn btn-primary" data-cid="${esc(data.next.id)}">${esc(data.next.title || '下一章')} ${icon('chevron-right', 15)}</button>` : '<span class="end-last">已是最后一章</span>'}
      </div>`;
    this.el.prev.disabled = !data.prev;
    this.el.next.disabled = !data.next;
    this.el.prev.dataset.cid = data.prev?.id || '';
    this.el.next.dataset.cid = data.next?.id || '';
    this.currentIndex = data.index;
    this.totalChapters = data.total;
    this.el.scroll.scrollTop = 0;
    this.updateProgressDisplay(0);
    this.highlightChapter();
    if (restore) {
      const progress = this.initialProgress;
      if (progress && progress.chapterId === this.chapterId && Number(progress.chapterPercent) > 0.01) {
        requestAnimationFrame(() => {
          const max = Math.max(0, this.el.scroll.scrollHeight - this.el.scroll.clientHeight);
          this.el.scroll.scrollTop = Math.min(max, max * Number(progress.chapterPercent));
          this.onScroll();
        });
      }
    }
    this.root.querySelector('[data-chapter-list]')?.classList.add('is-ready');
    document.title = `${chapter.title || '阅读'} · ${book.title || '墨阅'}`;
  }

  replaceChapterHash(chapterId) {
    const hash = location.hash || '';
    if (!hash.startsWith('#/read/')) return;
    const [path, query] = hash.split('?');
    const parts = path.split('/');
    if (parts.length < 5) return;
    parts[parts.length - 1] = encodeURIComponent(chapterId);
    const nextHash = parts.join('/') + (query ? `?${query}` : '');
    try {
      history.replaceState(history.state, '', nextHash);
    } catch {
      /* 地址栏不可写时不影响阅读 */
    }
  }

  renderError(error) {
    const message = error?.message || '章节加载失败';
    const vip = error?.code === 'VIP_CHAPTER';
    this.el.chapterTitle.textContent = vip ? '本章暂不可读' : '翻页未成';
    this.el.chapterMeta.textContent = '';
    this.el.barChapter.textContent = '出错了';
    this.el.content.innerHTML = `<div class="reader-error">
      <div class="reader-error-mark">${icon(vip ? 'lock' : 'alert', 30)}</div>
      <h2>${vip ? '这一章需要付费' : '正文没有取到'}</h2>
      <p>${esc(message)}</p>
      <div class="reader-error-actions">
        <button class="btn btn-ghost" data-retry>再试一次</button>
        <button class="btn btn-primary" data-back>返回详情</button>
      </div>
    </div>`;
    this.el.end.innerHTML = '';
  }

  onScroll() {
    if (this.scrollFrame) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = 0;
      const percent = this.chapterPercent();
      this.updateProgressDisplay(percent);
      this.saveCurrent();
    });
  }

  chapterPercent() {
    if (!this.el?.scroll) return 0;
    const max = this.el.scroll.scrollHeight - this.el.scroll.clientHeight;
    if (max <= 20) return 1;
    return clamp(this.el.scroll.scrollTop / max, 0, 1);
  }

  updateProgressDisplay(chapterPercent) {
    const index = this.currentIndex || 1;
    const total = this.totalChapters || 1;
    const overall = clamp(((index - 1) + chapterPercent) / total, 0, 1);
    if (this.el.topProgress) this.el.topProgress.style.width = `${(overall * 100).toFixed(2)}%`;
    if (this.el.locationFill) this.el.locationFill.style.width = `${(chapterPercent * 100).toFixed(2)}%`;
    if (this.el.locationText) this.el.locationText.textContent = `第 ${index} / ${total} 章`;
    if (this.el.percentText) this.el.percentText.textContent = formatPercent(overall);
  }

  async persistProgress({ silent = false } = {}) {
    if (!this.isOpen || !this.chapterData || !this.getUser()) return;
    const chapterPercent = this.chapterPercent();
    const index = this.currentIndex || 1;
    const total = this.totalChapters || 1;
    const percent = clamp(((index - 1) + chapterPercent) / total, 0, 1);
    const book = this.chapterData.book || {};
    const payload = {
      book,
      chapterId: this.chapterId,
      chapterTitle: this.chapterData.chapter.title || '',
      chapterIndex: index,
      chapterPercent,
      percent
    };
    if (this.lastSaved && Math.abs(this.lastSaved.percent - percent) < 0.002
      && this.lastSaved.chapterId === payload.chapterId) return;
    this.lastSaved = { percent, chapterId: payload.chapterId };
    try {
      const result = await this.api.saveHistory(payload);
      this.onProgress?.(result.record);
    } catch (error) {
      if (!silent && !this.saveErrorShown) {
        this.saveErrorShown = true;
        toast('阅读进度暂时未能保存', 'error');
      }
    }
  }

  goRelative(delta) {
    const data = this.chapterData;
    if (!data) return;
    const target = delta < 0 ? data.prev : data.next;
    if (!target) {
      toast(delta < 0 ? '已经是第一章' : '已经是最后一章', 'info');
      return;
    }
    this.goToChapter(target.id);
  }

  goToChapter(cid) {
    if (!cid || cid === this.chapterId) {
      this.closePanel();
      return;
    }
    this.closePanel();
    location.hash = `#/read/${encodeURIComponent(this.source)}/${encodeURIComponent(this.bookId)}/${encodeURIComponent(cid)}`;
  }

  handleKeydown(event) {
    if (!this.isOpen) return;
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (event.key === 'Escape') {
      if (this.panel) {
        this.closePanel();
      } else {
        this.close();
      }
      return;
    }
    if (event.key === 'ArrowRight' || event.key === 'PageDown') {
      event.preventDefault();
      this.goRelative(1);
    } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault();
      this.goRelative(-1);
    } else if (event.key.toLowerCase() === 'f') {
      this.toggleFullscreen();
    } else if (event.key.toLowerCase() === 'b') {
      this.addBookmark();
    } else if (event.key === ' ') {
      event.preventDefault();
      this.el.scroll.scrollBy({ top: this.el.scroll.clientHeight * 0.85, behavior: 'smooth' });
    }
  }

  openPanel(name) {
    this.panel = name;
    const panel = name === 'settings' ? this.el.settingsPanel : this.el.chapterPanel;
    this.el.settingsPanel.classList.remove('is-open');
    this.el.chapterPanel.classList.remove('is-open');
    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    this.el.scrim.classList.add('is-open');
    if (name === 'chapters') {
      this.renderChapterPanel();
      const current = this.el.chapterList.querySelector('.is-current');
      if (current) current.scrollIntoView({ block: 'center' });
      setTimeout(() => this.el.chapterFilter.focus(), 120);
    }
    this.refreshPanels();
  }

  closePanel() {
    this.panel = '';
    this.el.settingsPanel.classList.remove('is-open');
    this.el.chapterPanel.classList.remove('is-open');
    this.el.settingsPanel.setAttribute('aria-hidden', 'true');
    this.el.chapterPanel.setAttribute('aria-hidden', 'true');
    this.el.scrim.classList.remove('is-open');
  }

  refreshPanels() {
    if (!this.el) return;
    const { readerTheme, fontFamily, readerWidth, fontSize, lineHeight } = this.prefs;
    this.el.settingsPanel.querySelectorAll('[data-theme]').forEach(button => {
      button.classList.toggle('is-active', button.dataset.theme === readerTheme);
      button.setAttribute('aria-pressed', String(button.dataset.theme === readerTheme));
    });
    this.el.settingsPanel.querySelectorAll('[data-font]').forEach(button => {
      button.classList.toggle('is-active', button.dataset.font === fontFamily);
    });
    this.el.settingsPanel.querySelectorAll('[data-width]').forEach(button => {
      button.classList.toggle('is-active', button.dataset.width === readerWidth);
    });
    const sizeRange = this.el.settingsPanel.querySelector('[data-font-size-range]');
    if (sizeRange) sizeRange.value = String(fontSize);
    const sizeLabel = this.el.settingsPanel.querySelector('[data-font-size-label]');
    if (sizeLabel) sizeLabel.textContent = `${fontSize}px`;
    const lineRange = this.el.settingsPanel.querySelector('[data-line-height-range]');
    if (lineRange) lineRange.value = String(lineHeight);
    const lineLabel = this.el.settingsPanel.querySelector('[data-line-height-label]');
    if (lineLabel) lineLabel.textContent = Number(lineHeight).toFixed(1);
  }

  applyPrefs() {
    if (!this.el) return;
    const { readerTheme, fontFamily, readerWidth, fontSize, lineHeight } = this.prefs;
    this.el.reader.dataset.readerTheme = readerTheme;
    this.el.reader.dataset.readerFont = fontFamily;
    this.el.reader.dataset.readerWidth = readerWidth;
    this.el.reader.style.setProperty('--reader-font-size', `${fontSize}px`);
    this.el.reader.style.setProperty('--reader-line-height', String(lineHeight));
    this.refreshPanels();
  }

  updatePrefs(patch) {
    this.prefs = { ...this.prefs, ...patch };
    this.applyPrefs();
    this.persistPrefsLater();
  }

  persistPrefs() {
    this.savePrefs?.(this.prefs, { fromReader: true });
  }

  renderChapterPanel() {
    if (!this.el) return;
    const chapters = this.bookData?.chapters || [];
    this.el.chapterCount.textContent = chapters.length ? `共 ${chapters.length} 章` : '目录加载中…';
    this.renderChapterList(this.el.chapterFilter.value);
  }

  renderChapterList(filter = '') {
    if (!this.el) return;
    const chapters = this.bookData?.chapters || [];
    const needle = String(filter || '').trim().toLowerCase();
    const filtered = needle ? chapters.filter(chapter => chapter.title.toLowerCase().includes(needle)) : chapters;
    if (!filtered.length) {
      this.el.chapterList.innerHTML = `<p class="chapter-empty">${chapters.length ? '没有匹配的章节' : '目录暂时没有取到'}</p>`;
      return;
    }
    this.el.chapterList.innerHTML = filtered.map(chapter => `<button class="chapter-item ${String(chapter.id) === this.chapterId ? 'is-current' : ''}" data-cid="${esc(chapter.id)}">
      <span>${esc(chapter.title)}</span>
      ${String(chapter.id) === this.chapterId ? '<em>在读</em>' : ''}
    </button>`).join('');
    const current = this.el.chapterList.querySelector('.is-current');
    if (current && this.panel === 'chapters') current.scrollIntoView({ block: 'center' });
  }

  highlightChapter() {
    if (!this.el) return;
    this.el.chapterList?.querySelectorAll('.chapter-item').forEach(item => {
      item.classList.toggle('is-current', item.dataset.cid === this.chapterId);
    });
  }

  async addBookmark() {
    if (!this.getUser()) {
      toast('登录后可以保存书签', 'info');
      this.onRequireLogin?.(`/read/${this.source}/${this.bookId}/${this.chapterId}`);
      return;
    }
    if (!this.chapterData) return;
    const percent = this.chapterPercent();
    const paragraphs = [...this.el.content.querySelectorAll('p')];
    let index = 0;
    if (paragraphs.length) {
      const scrollTop = this.el.scroll.scrollTop;
      index = Math.max(0, paragraphs.findIndex(p => p.offsetTop + p.offsetHeight / 2 >= scrollTop));
      if (index < 0) index = paragraphs.length - 1;
    }
    const excerpt = excerptOf(paragraphs.map(p => p.textContent), Math.max(0, index - 1), 100);
    const book = this.chapterData.book || {};
    try {
      const result = await this.api.addBookmark({
        book,
        chapterId: this.chapterId,
        chapterTitle: this.chapterData.chapter.title || '',
        chapterIndex: this.currentIndex || 1,
        percent,
        excerpt
      });
      toast(result.duplicate ? '这一页已有书签' : '书签已夹入书页', result.duplicate ? 'info' : 'success');
    } catch (error) {
      toast(error.message || '书签保存失败', 'error');
    }
  }

  async toggleFullscreen() {
    try {
      if (!document.fullscreenElement) {
        await this.root.requestFullscreen?.();
      } else {
        await document.exitFullscreen?.();
      }
    } catch {
      toast('当前浏览器不支持全屏', 'info');
    }
    setTimeout(() => this.updateFullscreenButton(), 80);
  }

  updateFullscreenButton() {
    const button = this.root.querySelector('[data-fullscreen]');
    if (!button) return;
    button.innerHTML = icon(document.fullscreenElement ? 'minimize' : 'maximize', 18);
  }

  updateBookTitle() {
    if (!this.el) return;
    const title = this.bookData?.title || this.chapterData?.book?.title || '';
    if (title) {
      this.el.bookTitle.textContent = title;
      this.el.overline.textContent = title;
    }
    document.title = `${this.el.chapterTitle.textContent || '阅读'} · ${title || '墨阅'}`;
  }
}
