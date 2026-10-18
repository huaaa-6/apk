import { api } from './api.js';
import { icon, logoMark } from './icons.js';
import {
  esc, coverHtml, sourceName, sourceClass, formatPercent, timeAgo, dayLabel,
  debounce, clamp, safeNext
} from './util.js';
import {
  toast, confirmDialog, emptyState, loadingView, skeletonCards, sectionHead,
  pageHeader, sourceBadge, avatar, bookCard, bookRow, progressBar, statPill,
  setBusy, brandBlock
} from './ui.js';
import { Reader } from './reader.js';

const DEFAULT_PREFS = {
  uiTheme: 'light',
  readerTheme: 'paper',
  fontFamily: 'serif',
  fontSize: 20,
  lineHeight: 2,
  readerWidth: 'normal'
};

const PREFS_KEY = 'moyue.prefs.v1';
const RECENT_KEY = 'moyue.recent.v1';
const HOT_WORDS = ['剑来', '凡人修仙传', '诡秘之主', '庆余年', '大奉打更人', '雪中悍刀行', '深空彼岸', '光阴之外'];
const NAV_ITEMS = [
  { name: 'home', label: '首页', icon: 'home', href: '/home' },
  { name: 'search', label: '寻书', icon: 'search', href: '/search' },
  { name: 'shelf', label: '书架', icon: 'library', href: '/shelf' },
  { name: 'history', label: '足迹', icon: 'clock', href: '/history' },
  { name: 'bookmarks', label: '书签', icon: 'bookmark', href: '/bookmarks' },
  { name: 'sources', label: '源体检', icon: 'globe', href: '/sources' },
  { name: 'settings', label: '设置', icon: 'settings', href: '/settings' }
];

const app = {
  status: null,
  user: null,
  sources: [],
  library: [],
  history: [],
  bookmarks: [],
  prefs: loadLocalPrefs(),
  route: null,
  routeSeq: 0,
  ready: false,
  currentBook: null,
  bookState: null,
  chaptersExpanded: false,
  introExpanded: false,
  authTab: 'login',
  suppressReaderExit: false,
  lastReadRoute: null,
  prefsTimer: null,
  themeToastAt: 0
};

const reader = new Reader({
  api,
  getPrefs: () => app.prefs,
  savePrefs: prefs => savePrefs(prefs),
  getUser: () => app.user,
  onExit: () => {
    if (app.suppressReaderExit) return;
    const route = app.lastReadRoute;
    if (route?.source && route?.bookId) {
      navigate(`/book/${encodeURIComponent(route.source)}/${encodeURIComponent(route.bookId)}`);
    } else {
      navigate('/home');
    }
  },
  onRequireLogin: next => {
    app.suppressReaderExit = true;
    reader.close();
    app.suppressReaderExit = false;
    navigate(`/login?next=${encodeURIComponent(next)}`);
  },
  onProgress: record => {
    if (!record) return;
    const index = app.history.findIndex(item => item.key === record.key);
    if (index >= 0) app.history[index] = record;
    else app.history.unshift(record);
  }
});

/* --------------------------------- 偏好与工具 -------------------------------- */

function loadLocalPrefs() {
  try {
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
    return { ...DEFAULT_PREFS, ...(stored || {}) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function applyUiTheme() {
  document.documentElement.dataset.uiTheme = app.prefs.uiTheme === 'dark' ? 'dark' : 'light';
}

function savePrefs(patch, { remote = true } = {}) {
  app.prefs = { ...app.prefs, ...(patch || {}) };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(app.prefs));
  } catch {}
  applyUiTheme();
  if (remote && app.user) {
    clearTimeout(app.prefsTimer);
    app.prefsTimer = setTimeout(() => {
      api.savePrefs(app.prefs).catch(() => {});
    }, 500);
  }
}

function currentPath() {
  return location.hash.replace(/^#/, '') || '/home';
}

function navigate(path) {
  const target = path.startsWith('/') ? path : `/${path}`;
  if (currentPath() === target) {
    renderRoute();
    return;
  }
  location.hash = `#${target}`;
}

function readHref(book, chapterId, percent = 0) {
  const base = `#/read/${encodeURIComponent(book.source)}/${encodeURIComponent(book.bookId)}/${encodeURIComponent(chapterId)}`;
  const value = Number(percent);
  return value > 0.005 ? `${base}?p=${value.toFixed(3)}` : base;
}

function bookHref(book) {
  if (!book?.source || !book?.bookId) return '#/search';
  return `#/book/${encodeURIComponent(book.source)}/${encodeURIComponent(book.bookId)}`;
}

function searchHref(query, sources = '') {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (sources) params.set('sources', sources);
  return `#/search${params.toString() ? `?${params.toString()}` : ''}`;
}

function recentSearches() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(list) ? list.filter(Boolean).slice(0, 8) : [];
  } catch {
    return [];
  }
}

function rememberSearch(query) {
  const word = String(query || '').trim();
  if (!word) return;
  const list = [word, ...recentSearches().filter(item => item !== word)].slice(0, 8);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch {}
}

function shortError(message, max = 26) {
  const text = String(message || '未知错误');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function requireLogin(next = currentPath(), message = '请先登录，再继续这一步。') {
  if (app.user) return true;
  toast(message, 'info');
  navigate(`/login?next=${encodeURIComponent(next)}`);
  return false;
}

/* --------------------------------- 页面骨架 -------------------------------- */

function renderChrome(route) {
  const sidebar = document.getElementById('sidebar');
  const topbar = document.getElementById('topbar');
  const mobileNav = document.getElementById('mobile-nav');
  if (!sidebar || !topbar) return;
  const active = route?.name || 'home';
  const shelfCount = app.library.length;
  sidebar.innerHTML = `<div class="sidebar-inner">
    ${brandBlock()}
    <div class="sidebar-rule"><span></span><em>一页山水 · 万卷江湖</em></div>
    <nav class="side-nav" aria-label="主导航">
      ${NAV_ITEMS.map(item => `<a class="nav-link ${active === item.name ? 'is-active' : ''}" href="#${item.href}" data-nav="${item.name}">
        <span class="nav-icon">${icon(item.icon, 18)}</span>
        <span class="nav-text">${item.label}</span>
        ${item.name === 'shelf' && shelfCount ? `<span class="nav-badge">${shelfCount}</span>` : ''}
      </a>`).join('')}
    </nav>
    <div class="sidebar-scroll-quote">
      <p>「读书不觉已春深，</p><p>一寸光阴一寸金。」</p>
      <span>— 王贞白</span>
    </div>
    <div class="sidebar-foot">
      ${app.user ? `<div class="side-user">
        ${avatar(app.user, 'sm')}
        <div class="side-user-text"><strong>${esc(app.user.displayName || app.user.username)}</strong><span>@${esc(app.user.username)}</span></div>
        <a class="icon-btn" href="#/settings" aria-label="账号设置">${icon('settings', 17)}</a>
      </div>` : `<div class="side-guest">
        <p>登录后，把读过的江湖<br>收进自己的书架。</p>
        <a class="btn btn-primary btn-sm" href="#/login?next=${encodeURIComponent(currentPath())}">登录 / 注册</a>
      </div>`}
      <p class="side-version">墨阅 v${esc(app.status?.version || '1.0.0')} · 本地运行</p>
    </div>
  </div>`;

  const enabled = app.sources.filter(item => item.enabled).length;
  const online = app.sources.filter(item => item.health?.status === 'ok').length;
  const crumb = {
    home: '首页', search: '寻书', book: '书目', read: '阅读', shelf: '书架',
    history: '阅读足迹', bookmarks: '书签', sources: '源体检', settings: '设置', login: '登录'
  }[active] || '墨阅';
  topbar.innerHTML = `<div class="topbar-left">
      <button class="icon-btn mobile-menu" data-action="toggle-drawer" aria-label="打开导航">${icon('menu', 20)}</button>
      <a class="mobile-brand" href="#/home">${logoMark(28)}<span>墨阅</span></a>
      <p class="topbar-crumb"><span>墨阅</span><i>/</i><strong>${crumb}</strong></p>
    </div>
    <form class="top-search" data-search-form role="search">
      ${icon('search', 17)}
      <input name="q" type="search" placeholder="搜书名、作者…" value="${esc(active === 'search' ? route?.query?.q || '' : '')}" aria-label="搜索书名或作者" autocomplete="off">
      <kbd>/</kbd>
    </form>
    <div class="topbar-actions">
      <a class="topbar-status ${online ? 'is-online' : ''}" href="#/sources" title="数据源状态">
        <i></i><span>${enabled || 0} 源</span>
      </a>
      <button class="icon-btn theme-toggle" data-action="toggle-ui-theme" aria-label="切换明暗" title="切换明暗">${icon(app.prefs.uiTheme === 'dark' ? 'sun' : 'moon', 18)}</button>
      ${app.user
        ? `<a class="topbar-user" href="#/settings" aria-label="账号设置">${avatar(app.user, 'xs')}<span>${esc(app.user.displayName || app.user.username)}</span></a>`
        : `<a class="topbar-login" href="#/login?next=${encodeURIComponent(currentPath())}">${icon('user', 16)}<span>登录</span></a>`}
    </div>`;

  if (mobileNav) {
    mobileNav.innerHTML = ['home', 'search', 'shelf', 'history'].map(name => {
      const item = NAV_ITEMS.find(entry => entry.name === name);
      return `<a class="mobile-nav-link ${active === name ? 'is-active' : ''}" href="#${item.href}">
        ${icon(item.icon, 19)}<span>${item.label}</span>
      </a>`;
    }).join('') + `<button class="mobile-nav-link" data-action="toggle-drawer">${icon('menu', 19)}<span>更多</span></button>`;
  }
  applyUiTheme();
}

function setView(html) {
  const view = document.getElementById('view');
  if (!view) return;
  view.innerHTML = `<div class="page">${html}</div>`;
}

function closeDrawer() {
  document.getElementById('sidebar')?.classList.remove('is-open');
  document.getElementById('drawer-scrim')?.classList.remove('is-open');
}

function toggleDrawer() {
  const sidebar = document.getElementById('sidebar');
  const scrim = document.getElementById('drawer-scrim');
  const open = !sidebar?.classList.contains('is-open');
  sidebar?.classList.toggle('is-open', open);
  scrim?.classList.toggle('is-open', open);
}

/* --------------------------------- 路由解析 -------------------------------- */

function parseRoute() {
  const raw = location.hash.replace(/^#/, '') || '/home';
  const [pathname, queryString = ''] = raw.split('?');
  let segments = pathname.split('/').filter(Boolean);
  try { segments = segments.map(decodeURIComponent); } catch {}
  const query = Object.fromEntries(new URLSearchParams(queryString));
  const name = segments[0] || 'home';
  return { name, segments, query, path: pathname };
}

async function renderRoute() {
  if (!app.ready) return;
  const route = parseRoute();
  app.route = route;
  app.routeSeq += 1;
  const token = app.routeSeq;
  closeDrawer();
  if (reader.isOpen && route.name !== 'read') {
    app.suppressReaderExit = true;
    reader.close();
    app.suppressReaderExit = false;
  }
  renderChrome(route);
  if (route.name === 'read') {
    openReader(route);
    return;
  }
  window.scrollTo({ top: 0, left: 0 });
  switch (route.name) {
    case 'home': renderHome(); break;
    case 'search': await renderSearch(route, token); break;
    case 'book': await renderBook(route, token); break;
    case 'shelf': await renderShelf(); break;
    case 'history': await renderHistory(); break;
    case 'bookmarks': await renderBookmarks(route); break;
    case 'sources': renderSources(); break;
    case 'settings': await renderSettings(); break;
    case 'login': renderLogin(route); break;
    default: renderNotFound(); break;
  }
}

function openReader(route) {
  const source = route.segments[1];
  const bookId = route.segments[2];
  const chapterId = route.segments[3];
  if (!source || !bookId || !chapterId) {
    navigate('/home');
    return;
  }
  app.lastReadRoute = { source, bookId };
  const p = Number(route.query.p);
  const progress = Number.isFinite(p) && p > 0
    ? { chapterId, chapterPercent: clamp(p, 0, 1), percent: clamp(p, 0, 1) }
    : null;
  if (reader.isOpen && reader.source === source && reader.bookId === bookId && reader.chapterId === chapterId && !progress) {
    return;
  }
  reader.open({ source, bookId, chapterId, progress }).catch(error => {
    toast(error?.message || '阅读器打开失败', 'error');
  });
}

/* ---------------------------------- 首页 ---------------------------------- */

function landscapeSvg() {
  return `<svg class="hero-landscape" viewBox="0 0 560 470" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>
      <linearGradient id="sunWash" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#b04638" stop-opacity=".92"/>
        <stop offset="1" stop-color="#8f3328" stop-opacity=".72"/>
      </linearGradient>
      <linearGradient id="mountainWash" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#37463f" stop-opacity=".42"/>
        <stop offset="1" stop-color="#37463f" stop-opacity=".02"/>
      </linearGradient>
      <linearGradient id="nearWash" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#202924" stop-opacity=".82"/>
        <stop offset="1" stop-color="#202924" stop-opacity=".15"/>
      </linearGradient>
    </defs>
    <circle cx="378" cy="132" r="64" fill="url(#sunWash)"/>
    <path d="M24 328C92 250 144 236 193 272C232 301 263 300 304 253C340 212 376 206 414 244C451 281 485 287 540 262V378H24V328Z" fill="url(#mountainWash)"/>
    <path d="M-10 372C58 320 118 311 163 336C206 360 242 358 279 326C319 291 352 291 391 322C430 354 479 356 570 318V470H-10V372Z" fill="url(#mountainWash)"/>
    <path d="M-20 438C55 384 113 377 162 402C219 431 267 426 312 393C355 362 402 366 447 398C483 424 528 429 590 405V486H-20V438Z" fill="url(#nearWash)"/>
    <g stroke="#3f4d45" stroke-width="1.4" stroke-linecap="round" opacity=".55">
      <path d="M86 124c8-6 15-6 23 0"/><path d="M118 106c6-5 12-5 18 0"/>
      <path d="M72 154c10-7 19-7 29 0"/><path d="M446 96c8-6 15-6 23 0"/>
    </g>
    <g opacity=".78">
      <path d="M70 404c0-34 7-62 22-86" stroke="#28332d" stroke-width="3" stroke-linecap="round"/>
      <path d="M92 318c-18-2-31-10-38-24 18-2 31 3 41 14" fill="#2f3d35"/>
      <path d="M87 348c17-5 32-15 43-31-21-1-36 7-46 21" fill="#37473e"/>
      <path d="M96 374c-16-2-29-9-37-21 16-3 29 1 39 10" fill="#2b3931"/>
      <path d="M482 414c1-28 8-51 21-70" stroke="#28332d" stroke-width="2.6" stroke-linecap="round"/>
      <path d="M503 348c-15-1-26-7-33-18 15-2 26 2 35 11" fill="#2f3d35"/>
      <path d="M497 374c14-4 26-12 35-25-17-1-30 5-38 17" fill="#37473e"/>
    </g>
    <g opacity=".9">
      <path d="M368 366h64v64h-64z" fill="#a43c31" rx="2"/>
      <text x="400" y="411" text-anchor="middle" font-size="38" fill="#f4ead8" font-family="KaiTi,STKaiti,serif">阅</text>
    </g>
    <path d="M24 112h108" stroke="#8d8271" stroke-width="1" opacity=".5"/>
    <text x="24" y="98" fill="#6e6557" font-size="12" letter-spacing="5" font-family="serif" opacity=".82">MOUNTAINS &amp; RIVERS</text>
  </svg>`;
}

function heroSearchForm(value = '') {
  return `<form class="hero-search" data-search-form role="search">
    <span class="hero-search-icon">${icon('search', 20)}</span>
    <input name="q" type="search" value="${esc(value)}" placeholder="输入书名或作者，去万卷中寻一本" aria-label="搜索书名或作者" autocomplete="off">
    <button type="submit" class="btn btn-primary">寻书 ${icon('arrow-right', 17)}</button>
  </form>`;
}

function renderHome() {
  const enabled = app.sources.filter(item => item.enabled);
  const available = enabled.length;
  const history = app.user ? app.history.slice(0, 3) : [];
  const shelf = app.user ? app.library.slice(0, 4) : [];
  const recent = recentSearches();
  const html = `
    <section class="hero">
      <div class="hero-copy">
        <p class="hero-kicker"><span class="kicker-rule"></span>一页山水，万卷江湖</p>
        <h1>把江湖，<br><em>收进一盏灯里。</em></h1>
        <p class="hero-desc">墨阅聚合七猫中文网与笔趣阁。<br>搜一本书，续一页未完的夜读。</p>
        ${heroSearchForm(app.route?.query?.q || '')}
        <div class="hot-words">
          <span>今日可寻</span>
          ${HOT_WORDS.map(word => `<a href="${searchHref(word)}">${word}</a>`).join('')}
        </div>
        ${recent.length ? `<div class="recent-words"><span>最近</span>${recent.slice(0, 4).map(word => `<a href="${searchHref(word)}">${esc(word)}</a>`).join('')}</div>` : ''}
      </div>
      <div class="hero-art">
        ${landscapeSvg()}
        <div class="hero-art-note"><span>墨</span><p>纸短情长<br>读至夜深</p></div>
      </div>
      <div class="hero-stats">
        ${statPill('藏书源', `${enabled.length || app.sources.length} 处`)}
        ${statPill('今日可读', `${available} 源待命`)}
        ${statPill('我的书架', app.user ? `${app.library.length} 本` : '未登录')}
      </div>
    </section>

    ${!app.user ? `<section class="welcome-note">
      <div class="welcome-seal">${logoMark(42)}</div>
      <div><h3>客人，先喝一盏茶。</h3><p>登录后可以收藏书架、记录足迹、夹书签，并在换设备时找回进度。</p></div>
      <div class="welcome-actions">
        <a class="btn btn-primary" href="#/login?next=${encodeURIComponent(currentPath())}">登录 / 注册</a>
        <a class="btn btn-ghost" href="${searchHref('剑来')}">先随便看看</a>
      </div>
    </section>` : ''}

    ${history.length ? `<section class="home-section">
      ${sectionHead({ index: '壹', title: '续读', desc: '上一次翻到的页码，还替你留着。', action: '<a class="text-link" href="#/history">全部足迹 ' + icon('arrow-right', 14) + '</a>' })}
      <div class="continue-list">
        ${history.map(record => `<article class="continue-card">
          <a class="continue-cover" href="${bookHref(record.book)}">${coverHtml(record.book)}</a>
          <div class="continue-info">
            <a class="continue-title" href="${bookHref(record.book)}">${esc(record.book.title)}</a>
            <p>${esc(record.book.author || '佚名')} · 第 ${record.chapterIndex || 1} 章</p>
            <p class="continue-chapter">${esc(record.chapterTitle || '')}</p>
            ${progressBar(record.percent, `已读 ${formatPercent(record.percent)}`)}
          </div>
          <a class="continue-go" href="${readHref(record.book, record.chapterId, record.chapterPercent)}" aria-label="继续阅读">${icon('play', 18)}</a>
        </article>`).join('')}
      </div>
    </section>` : ''}

    ${shelf.length ? `<section class="home-section">
      ${sectionHead({ index: '贰', title: '书架一隅', desc: '收着的书，等一个有空的夜晚。', action: '<a class="text-link" href="#/shelf">去书架 ' + icon('arrow-right', 14) + '</a>' })}
      <div class="book-grid">${shelf.map(item => bookCard(item, { progress: item.progress, compact: true })).join('')}</div>
    </section>` : ''}

    <section class="home-section">
      ${sectionHead({ index: shelf.length || history.length ? '叁' : '贰', title: '藏书源', desc: '可插拔的数据源，体检后再入席。', action: '<a class="text-link" href="#/sources">查看源体检 ' + icon('arrow-right', 14) + '</a>' })}
      <div class="source-ribbon">
        ${(app.sources.length ? app.sources : []).map(source => `<a class="source-ribbon-card" href="#/sources">
          <span class="source-ribbon-icon">${icon(source.adapter === 'qimao' ? 'feather' : 'book-open', 20)}</span>
          <span class="source-ribbon-text"><strong>${esc(source.name)}</strong><em>${source.enabled ? (source.health?.status === 'ok' ? '在线' : '待体检') : '已停用'}</em></span>
          <i class="status-dot ${source.enabled ? (source.health?.status === 'ok' ? 'is-ok' : 'is-idle') : 'is-off'}"></i>
        </a>`).join('') || `<p class="muted">还没有数据源。</p>`}
      </div>
    </section>

    <section class="home-quote">
      <span class="quote-mark">“</span>
      <p>闭门即是深山，读书随处净土。</p>
      <em>— 陈继儒《小窗幽记》</em>
    </section>`;
  setView(html);
  document.title = '墨阅 · 一页山水，万卷江湖';
}

/* ---------------------------------- 搜索 ---------------------------------- */

function sourceFilterRow(query, selected) {
  const options = [{ id: '', label: '全部源', name: '全部' }, ...app.sources.filter(item => item.enabled).map(item => ({ id: item.id, label: item.name, name: item.name }))];
  return `<div class="source-filter" aria-label="搜索源筛选">
    ${options.map(option => `<a class="filter-chip ${String(selected || '') === option.id ? 'is-active' : ''}" href="${searchHref(query, option.id)}">${esc(option.label)}</a>`).join('')}
  </div>`;
}

function renderSearchLanding(route) {
  const recent = recentSearches();
  setView(`${pageHeader({
    kicker: 'SEARCH THE STACKS',
    title: '寻一本书',
    desc: '书名、作者皆可。会同时叩响所有启用的书源。'
  })}
    <section class="search-stage">
      ${heroSearchForm(route.query.q || '')}
      ${sourceFilterRow(route.query.q || '', route.query.sources || '')}
      <div class="search-suggest">
        <h3>不妨从这些开始</h3>
        <div class="word-cloud">${HOT_WORDS.map(word => `<a href="${searchHref(word, route.query.sources || '')}">${word}</a>`).join('')}</div>
      </div>
      ${recent.length ? `<div class="recent-searches">
        <div class="recent-head"><h3>最近寻找</h3><button class="text-button" data-action="clear-recent">清空</button></div>
        <div class="recent-list">${recent.map(word => `<a href="${searchHref(word, route.query.sources || '')}">${icon('clock', 14)}${esc(word)}</a>`).join('')}</div>
      </div>` : ''}
      <div class="search-source-note">
        <p>${icon('info', 15)} 七猫中文网通常可读全文；笔趣阁有约 15 秒的搜索冷却，请耐心些。</p>
      </div>
    </section>`);
  document.title = '寻书 · 墨阅';
}

async function renderSearch(route, token) {
  const query = String(route.query.q || '').trim();
  if (!query) {
    renderSearchLanding(route);
    return;
  }
  rememberSearch(query);
  const sourcesParam = route.query.sources || '';
  setView(`${pageHeader({ kicker: 'SEARCH RESULTS', title: `寻「${query}」`, desc: '正在替你把每一处书源翻一遍。' })}
    <div class="search-toolbar">${heroSearchForm(query)}${sourceFilterRow(query, sourcesParam)}</div>
    ${skeletonCards(8)}`);
  document.title = `寻「${query}」· 墨阅`;
  let result;
  try {
    result = await api.search(query, sourcesParam);
  } catch (error) {
    if (token !== app.routeSeq) return;
    setView(`${pageHeader({ kicker: 'SEARCH RESULTS', title: `寻「${query}」`, desc: '这一趟没有走成。' })}
      <div class="search-toolbar">${heroSearchForm(query)}${sourceFilterRow(query, sourcesParam)}</div>
      ${emptyState({ symbol: 'alert', title: '书源暂时没有应声', text: error.message, action: `<button class="btn btn-primary" data-action="retry-route">再寻一次</button>` })}`);
    return;
  }
  if (token !== app.routeSeq) return;
  const groups = Array.isArray(result.groups) ? result.groups : [];
  const runList = Array.isArray(result.sources) ? result.sources : [];
  const failed = runList.filter(item => !item.ok);
  const body = groups.length
    ? `<div class="result-grid">${groups.map(resultCard).join('')}</div>`
    : emptyState({
      symbol: 'search',
      title: '没有寻到这本书',
      text: failed.length ? '有书源没有回应，可以换一个关键词，或稍后再试。' : '不妨换一个书名，或者只写作者姓名。',
      action: `<a class="btn btn-ghost" href="${searchHref(query)}">换关键词</a>`
    });
  setView(`${pageHeader({
    kicker: 'SEARCH RESULTS',
    title: `寻「${query}」`,
    desc: `共 ${groups.length} 本，来自 ${runList.filter(item => item.ok).length} 处书源。`
  })}
    <div class="search-toolbar">${heroSearchForm(query)}${sourceFilterRow(query, sourcesParam)}</div>
    <div class="search-runbar">
      <p class="search-run-summary">${icon('spark', 15)} 翻检完毕</p>
      <div class="run-chips">${runList.map(item => `<span class="run-chip ${item.ok ? 'is-ok' : 'is-fail'}" title="${esc(item.error || '')}">
        <i></i>${esc(item.name)}${item.ok ? `<em>${item.count} 条 · ${item.ms}ms${item.cached ? ' · 缓存' : ''}</em>` : `<em>${esc(shortError(item.error, 18))}</em>`}
      </span>`).join('')}</div>
    </div>
    ${failed.length ? `<div class="run-warning">${icon('alert', 15)}<span>${failed.map(item => `${item.name}：${item.error}`).join('；')}</span></div>` : ''}
    ${body}`);
  document.title = `寻「${query}」· 墨阅`;
}

function resultCard(group) {
  const primarySource = group.primarySource || group.source || group.sources?.[0]?.source || '';
  const primaryId = group.primaryBookId || group.bookId || group.sources?.[0]?.bookId || '';
  const book = { ...group, source: primarySource, bookId: primaryId };
  const href = primarySource && primaryId ? bookHref(book) : searchHref(group.title);
  const meta = [group.category, group.status, group.words].filter(Boolean);
  return `<article class="result-card">
    <a class="result-cover" href="${href}" aria-label="${esc(group.title)}">${coverHtml(book)}</a>
    <div class="result-body">
      <div class="result-title-row">
        <h3><a href="${href}">${esc(group.title)}</a></h3>
        <span class="result-count">${group.sourceCount || group.sources?.length || 1} 源可读</span>
      </div>
      <p class="result-author">${esc(group.author || '佚名')}${meta.length ? ` <span>·</span> ${esc(meta.join(' · '))}` : ''}</p>
      <p class="result-intro">${esc(group.intro || '暂无简介，点开看看这本书。')}</p>
      ${group.latestChapter ? `<p class="result-latest">${icon('book-open', 13)} 最新：${esc(group.latestChapter)}</p>` : ''}
      <div class="result-foot">
        <div class="result-sources">${(group.sources || []).map(entry => `<a class="source-badge ${sourceClass(entry.source)}" href="${bookHref({ source: entry.source, bookId: entry.bookId })}">${esc(entry.sourceName || sourceName(entry.source))}</a>`).join('')}</div>
        <a class="btn btn-ghost btn-sm" href="${href}">翻开看看 ${icon('arrow-right', 14)}</a>
      </div>
    </div>
  </article>`;
}

/* --------------------------------- 书籍详情 -------------------------------- */

function shelfButton(inLibrary) {
  return `<button class="btn ${inLibrary ? 'btn-ghost is-shelved' : 'btn-primary'}" data-action="toggle-shelf">
    ${icon(inLibrary ? 'check' : 'plus', 16)}<span>${inLibrary ? '已在书架' : '加入书架'}</span>
  </button>`;
}

function chapterHref(book, chapter) {
  return readHref(book, chapter.id, 0);
}

function bookStartPoint(book) {
  const progress = app.bookState?.progress;
  const chapters = book.chapters || [];
  if (!chapters.length) return null;
  if (progress?.chapterId && Number(progress.percent) < 0.999) {
    const found = chapters.find(item => String(item.id) === String(progress.chapterId));
    if (found) return { chapter: found, percent: progress.chapterPercent || 0, progress };
  }
  return { chapter: chapters[0], percent: 0, progress: null };
}

function paintBook(book, state) {
  app.currentBook = book;
  app.bookState = state;
  const chapters = Array.isArray(book.chapters) ? book.chapters : [];
  const start = bookStartPoint(book);
  const progress = state?.progress;
  const inLibrary = Boolean(state?.inLibrary);
  const startHref = start ? readHref(book, start.chapter.id, start.percent) : '';
  const visibleChapters = app.chaptersExpanded ? chapters : chapters.slice(0, 48);
  const introLong = (book.intro || '').length > 200;
  const meta = [book.category, book.status, book.words, book.updatedAt && `更新 ${book.updatedAt}`].filter(Boolean);
  const readLabel = progress && Number(progress.percent) < 0.999 ? '继续阅读' : '开始阅读';
  const html = `<div class="book-page">
    <div class="book-back-row">
      <a class="text-link" href="${searchHref(book.title)}">${icon('arrow-left', 14)} 回到寻书</a>
      <span class="book-back-rule"></span>
      <p>${sourceBadge(book.source, book.sourceName || '')}</p>
    </div>
    <section class="book-hero">
      <div class="book-hero-cover">${coverHtml(book, { eager: true })}<div class="book-cover-shadow"></div></div>
      <div class="book-hero-body">
        <p class="book-kicker">${esc(book.category || '未分类')} · ${esc(book.status || '连载中')}</p>
        <h1>${esc(book.title)}</h1>
        <p class="book-author">${esc(book.author || '佚名')} <span>著</span></p>
        <div class="book-meta">${meta.map(item => `<span>${esc(item)}</span>`).join('')}</div>
        ${book.latestChapter ? `<p class="book-latest">${icon('book-open', 14)} 最新章：${esc(book.latestChapter)}</p>` : ''}
        <div class="book-actions">
          ${start ? `<a class="btn btn-primary btn-lg" href="${startHref}">${icon('play', 17)} ${readLabel}${progress?.chapterTitle ? ` · ${esc(progress.chapterTitle)}` : ''}</a>` : ''}
          ${shelfButton(inLibrary)}
          <a class="btn btn-ghost" href="#/bookmarks${state?.bookmarkCount ? `?key=${encodeURIComponent(book.key || '')}` : ''}">${icon('bookmark', 16)} 书签 ${state?.bookmarkCount || 0}</a>
        </div>
        ${progress ? `<div class="book-progress-card">${progressBar(progress.percent, `已读 ${formatPercent(progress.percent)} · 第 ${progress.chapterIndex || 1} 章`)}<span class="book-progress-time">${timeAgo(progress.updatedAt)}</span></div>` : ''}
      </div>
    </section>
    <section class="book-detail-grid">
      <div class="book-main">
        <div class="paper-card intro-card">
          <div class="card-head"><h2>内容简介</h2><span class="card-mark">INTRO</span></div>
          <p class="book-intro ${app.introExpanded ? 'is-expanded' : ''}">${esc(book.intro || '这本书还没有简介，翻开正文便知分晓。')}</p>
          ${introLong ? `<button class="text-button" data-action="toggle-intro">${app.introExpanded ? '收起' : '展开全文'}</button>` : ''}
        </div>
        <div class="paper-card chapter-card">
          <div class="card-head">
            <h2>目录 <span class="chapter-total">${chapters.length} 章</span></h2>
            <span class="card-mark">CONTENTS</span>
          </div>
          ${chapters.length ? `<div class="chapter-grid">${visibleChapters.map(chapter => `<a class="chapter-chip ${progress?.chapterId === chapter.id ? 'is-current' : ''} ${chapter.vip ? 'is-vip' : ''}" href="${chapterHref(book, chapter)}">
            ${chapter.vip ? icon('lock', 12) : ''}<span>${esc(chapter.title)}</span>
          </a>`).join('')}</div>` : `<p class="muted">目录暂时没有取到，可以尝试直接阅读。</p>`}
          ${chapters.length > 48 ? `<div class="chapter-more"><button class="btn btn-ghost btn-sm" data-action="toggle-chapters">${app.chaptersExpanded ? '收起目录' : `展开全部 ${chapters.length} 章`} ${icon(app.chaptersExpanded ? 'arrow-up' : 'chevron-down', 15)}</button></div>` : ''}
        </div>
      </div>
      <aside class="book-side">
        <div class="paper-card side-card">
          <p class="side-card-kicker">READING</p>
          <h3>${progress && Number(progress.percent) < 0.999 ? '接着上次的读' : '从第一页开始'}</h3>
          ${progress ? progressBar(progress.percent, `${formatPercent(progress.percent)} · ${progress.chapterTitle || ''}`) : '<p class="muted">还没有留下足迹。</p>'}
          ${start ? `<a class="btn btn-primary side-read-btn" href="${startHref}">${readLabel} ${icon('arrow-right', 16)}</a>` : ''}
        </div>
        <div class="paper-card side-card">
          <p class="side-card-kicker">SOURCE</p>
          <h3>${esc(book.sourceName || sourceName(book.source))}</h3>
          <dl class="side-dl">
            <div><dt>书号</dt><dd>${esc(book.bookId)}</dd></div>
            <div><dt>状态</dt><dd>${esc(book.status || '未知')}</dd></div>
            <div><dt>字数</dt><dd>${esc(book.words || '未知')}</dd></div>
            <div><dt>书签</dt><dd>${state?.bookmarkCount || 0} 枚</dd></div>
          </dl>
          <a class="text-link" href="#/sources">查看书源状态 ${icon('arrow-right', 14)}</a>
        </div>
        <div class="side-quote">「书卷多情似故人，晨昏忧乐每相亲。」</div>
      </aside>
    </section>
  </div>`;
  setView(html);
  document.title = `${book.title} · 墨阅`;
}

async function renderBook(route, token) {
  const source = route.segments[1];
  const bookId = route.segments[2];
  if (!source || !bookId) {
    renderNotFound();
    return;
  }
  setView(`<div class="book-loading">${loadingView('正在取书')}</div>`);
  let data;
  try {
    data = await api.book(source, bookId);
  } catch (error) {
    if (token !== app.routeSeq) return;
    setView(`${pageHeader({ kicker: 'BOOK', title: '这本书没有取到', desc: error.message })}
      ${emptyState({ symbol: 'alert', title: '书目暂时不可见', text: '书源可能正在休息，或这本书已经下架。', action: `<button class="btn btn-primary" data-action="retry-route">再试一次</button><a class="btn btn-ghost" href="#/search">回到寻书</a>` })}`);
    return;
  }
  if (token !== app.routeSeq) return;
  app.chaptersExpanded = false;
  app.introExpanded = false;
  paintBook(data.book, data.state);
}

/* ---------------------------------- 书架 ---------------------------------- */

function loginGate(title = '请先登录', text = '登录后，书架与阅读进度会替你留着。') {
  return `<div class="gate-wrap">
    <div class="gate-card">
      <div class="gate-seal">${logoMark(46)}</div>
      <h2>${esc(title)}</h2>
      <p>${esc(text)}</p>
      <div class="gate-actions">
        <a class="btn btn-primary" href="#/login?next=${encodeURIComponent(currentPath())}">登录 / 注册</a>
        <a class="btn btn-ghost" href="#/search">先去寻书</a>
      </div>
      <p class="gate-note">所有账号与记录只保存在这台电脑上。</p>
    </div>
  </div>`;
}

async function refreshLibrary() {
  if (!app.user) {
    app.library = [];
    return;
  }
  try {
    const data = await api.library();
    app.library = data.items || [];
  } catch {}
}

async function renderShelf() {
  if (!app.user) {
    setView(pageHeader({ kicker: 'MY SHELF', title: '我的书架', desc: '把想读的书放在手边。' }) + loginGate('书架还没有主人', '登录后，收藏的书会一本本排在这里。'));
    document.title = '书架 · 墨阅';
    return;
  }
  await refreshLibrary();
  const html = `${pageHeader({
    kicker: 'MY SHELF',
    title: '我的书架',
    desc: app.library.length ? `共 ${app.library.length} 本，最近翻过的排在前头。` : '空着也好，正好去寻一本。',
    actions: `<a class="btn btn-primary" href="#/search">${icon('search', 16)} 去寻书</a>`
  })}
    ${app.library.length ? `<div class="book-grid shelf-grid">${app.library.map(item => {
      const progress = item.progress;
      const actions = `<div class="shelf-actions">
        ${progress ? `<a class="btn btn-primary btn-sm" href="${readHref(item, progress.chapterId, progress.chapterPercent)}">${icon('play', 14)} 继续</a>` : ''}
        <a class="btn btn-ghost btn-sm" href="${bookHref(item)}">详情</a>
        <button class="icon-btn shelf-remove" data-action="remove-library" data-key="${esc(item.key)}" data-title="${esc(item.title)}" aria-label="移出书架" title="移出书架">${icon('trash', 15)}</button>
      </div>`;
      return bookCard(item, { progress, actions });
    }).join('')}</div>` : emptyState({
      symbol: 'library',
      title: '书架还空着',
      text: '寻到喜欢的书，点一下「加入书架」，它就会在这里等你。',
      action: `<a class="btn btn-primary" href="#/search">去寻一本</a>`
    })}
    ${app.library.length ? `<div class="shelf-foot-note">${icon('info', 14)} 移出书架不会删除阅读足迹和书签。</div>` : ''}`;
  setView(html);
  document.title = '书架 · 墨阅';
}

/* ---------------------------------- 足迹 ---------------------------------- */

async function renderHistory() {
  if (!app.user) {
    setView(pageHeader({ kicker: 'READING TRAIL', title: '阅读足迹', desc: '翻过的每一页，都算数。' }) + loginGate('足迹还没有开始', '登录后，读过的章节会在这里留下页码。'));
    document.title = '足迹 · 墨阅';
    return;
  }
  try {
    const data = await api.history();
    app.history = data.items || [];
  } catch {}
  const groups = [];
  for (const record of app.history) {
    const label = dayLabel(record.updatedAt);
    let group = groups.find(item => item.label === label);
    if (!group) {
      group = { label, items: [] };
      groups.push(group);
    }
    group.items.push(record);
  }
  setView(`${pageHeader({
    kicker: 'READING TRAIL',
    title: '阅读足迹',
    desc: app.history.length ? `共 ${app.history.length} 本书记得你读到过哪里。` : '还没有翻开的书页。',
    actions: app.history.length ? `<button class="btn btn-ghost btn-sm" data-action="clear-history">${icon('trash', 15)} 清空足迹</button>` : ''
  })}
    ${app.history.length ? groups.map(group => `<section class="history-group">
      <div class="history-day"><span>${esc(group.label)}</span><i></i></div>
      <div class="history-list">${group.items.map(record => `<article class="history-item">
        <a class="history-cover" href="${bookHref(record.book)}">${coverHtml(record.book)}</a>
        <div class="history-body">
          <div class="history-title"><a href="${bookHref(record.book)}">${esc(record.book.title)}</a><span class="history-time">${timeAgo(record.updatedAt)}</span></div>
          <p>${esc(record.book.author || '佚名')} · 第 ${record.chapterIndex || 1} 章 ${esc(record.chapterTitle || '')}</p>
          ${progressBar(record.percent, `已读 ${formatPercent(record.percent)}`)}
        </div>
        <div class="history-actions">
          <a class="btn btn-primary btn-sm" href="${readHref(record.book, record.chapterId, record.chapterPercent)}">${icon('play', 14)} 续读</a>
          <button class="icon-btn" data-action="remove-history" data-key="${esc(record.key)}" data-title="${esc(record.book.title)}" aria-label="删除足迹" title="删除这条足迹">${icon('x', 15)}</button>
        </div>
      </article>`).join('')}</div>
    </section>`).join('') : emptyState({
      symbol: 'clock',
      title: '足迹还是空白',
      text: '翻开一本书，读上几页，这里就会记下你的来路。',
      action: `<a class="btn btn-primary" href="#/search">去寻一本书</a>`
    })}`);
  document.title = '足迹 · 墨阅';
}

/* ---------------------------------- 书签 ---------------------------------- */

async function renderBookmarks(route) {
  if (!app.user) {
    setView(pageHeader({ kicker: 'BOOKMARKS', title: '书签', desc: '夹在书页间的一枚朱砂。' }) + loginGate('还没有书签', '登录后，读到心动处，按 B 就能夹一枚书签。'));
    document.title = '书签 · 墨阅';
    return;
  }
  const key = String(route.query.key || '');
  try {
    const data = await api.bookmarks(key);
    app.bookmarks = data.items || [];
  } catch {}
  const items = app.bookmarks;
  const filterBook = key && items[0]?.book;
  setView(`${pageHeader({
    kicker: 'BOOKMARKS',
    title: filterBook ? `《${filterBook.title}》的书签` : '书签',
    desc: items.length ? `共 ${items.length} 枚书签，记着当时的句子。` : '读到心动处，按 B 夹一枚。',
    actions: filterBook ? `<a class="btn btn-ghost btn-sm" href="#/bookmarks">${icon('arrow-left', 14)} 全部书签</a>` : ''
  })}
    ${items.length ? `<div class="bookmark-grid">${items.map(item => `<article class="bookmark-card">
      <div class="bookmark-quote">${icon('quote', 18)}<p>${esc(item.excerpt || '这一页没有留下摘句。')}</p></div>
      ${item.note ? `<p class="bookmark-note">${esc(item.note)}</p>` : ''}
      <div class="bookmark-book">
        <a class="bookmark-thumb" href="${bookHref(item.book)}">${coverHtml(item.book)}</a>
        <div><a class="bookmark-title" href="${bookHref(item.book)}">${esc(item.book.title)}</a><p>${esc(item.chapterTitle || `第 ${item.chapterIndex || 1} 章`)} · ${formatPercent(item.percent)}</p></div>
      </div>
      <div class="bookmark-foot">
        <span>${timeAgo(item.createdAt)}</span>
        <div>
          <a class="btn btn-ghost btn-sm" href="${readHref(item.book, item.chapterId, item.percent)}">${icon('play', 13)} 翻到这里</a>
          <button class="icon-btn" data-action="remove-bookmark" data-id="${esc(item.id)}" data-title="${esc(item.book.title)}" aria-label="删除书签" title="删除书签">${icon('trash', 14)}</button>
        </div>
      </div>
    </article>`).join('')}</div>` : emptyState({
      symbol: 'bookmark',
      title: '还没有夹书签',
      text: '阅读时按 B，或点顶部的书签按钮，把喜欢的句子留下。',
      action: `<a class="btn btn-primary" href="#/shelf">去书架</a>`
    })}`);
  document.title = '书签 · 墨阅';
}

/* --------------------------------- 源体检 --------------------------------- */

function healthInfo(source) {
  const health = source.health || {};
  const status = health.status === 'ok' ? 'ok' : health.status === 'down' ? 'down' : 'unknown';
  return {
    status,
    label: status === 'ok' ? '运行正常' : status === 'down' ? '无法访问' : '尚未体检',
    latency: health.latency ? `${health.latency}ms` : '—',
    checkedAt: health.checkedAt ? timeAgo(health.checkedAt) : '未体检',
    message: health.message || '还没有敲过这扇门。',
    failures: health.consecutiveFailures || 0
  };
}

function renderSources() {
  const enabled = app.sources.filter(item => item.enabled);
  const down = enabled.filter(item => item.health?.status === 'down');
  const ok = enabled.filter(item => item.health?.status === 'ok');
  setView(`${pageHeader({
    kicker: 'SOURCE CLINIC',
    title: '源体检',
    desc: '书源是墨阅的根。开卷之前，先替它们把一次脉。',
    actions: app.user
      ? `<button class="btn btn-ghost btn-sm" data-action="health-all">${icon('refresh', 15)} 全源体检</button>
         <button class="btn btn-primary btn-sm" data-action="health-all" data-repair="1">${icon('spark', 15)} 体检并修复</button>`
      : `<a class="btn btn-primary btn-sm" href="#/login?next=${encodeURIComponent(currentPath())}">登录后管理</a>`
  })}
    <div class="clinic-summary">
      <div class="clinic-stat"><strong>${app.sources.length}</strong><span>接入书源</span></div>
      <div class="clinic-stat"><strong>${enabled.length}</strong><span>已启用</span></div>
      <div class="clinic-stat ${ok.length ? 'is-good' : ''}"><strong>${ok.length}</strong><span>体检正常</span></div>
      <div class="clinic-stat ${down.length ? 'is-bad' : ''}"><strong>${down.length}</strong><span>需要照看</span></div>
      <p class="clinic-note">${icon('info', 14)} 检测只会轻触各源首页或搜索接口，不会消耗搜索限流。</p>
    </div>
    <div class="source-list">${app.sources.map(source => {
      const info = healthInfo(source);
      const cooldown = Number(source.cooldownMs) || 0;
      return `<article class="source-card status-${info.status} ${source.enabled ? '' : 'is-disabled'}">
        <div class="source-card-head">
          <div class="source-avatar ${sourceClass(source.id)}">${icon(source.adapter === 'qimao' ? 'feather' : 'book-open', 22)}</div>
          <div class="source-head-text">
            <div class="source-name-row"><h2>${esc(source.name)}</h2><span class="health-pill health-${info.status}"><i></i>${info.label}</span></div>
            <p class="source-url">${esc(source.baseUrl)}</p>
          </div>
          <button class="switch ${source.enabled ? 'is-on' : ''}" data-action="toggle-source" data-id="${esc(source.id)}" aria-pressed="${source.enabled}" aria-label="${source.enabled ? '停用' : '启用'}${esc(source.name)}"><span></span></button>
        </div>
        <div class="source-health-line"><span>${icon('wifi', 13)} ${esc(info.message)}</span></div>
        <dl class="source-facts">
          <div><dt>适配器</dt><dd>${esc(source.adapter)}</dd></div>
          <div><dt>延迟</dt><dd>${info.latency}</dd></div>
          <div><dt>上次体检</dt><dd>${info.checkedAt}</dd></div>
          <div><dt>连续失败</dt><dd>${info.failures} 次</dd></div>
        </dl>
        ${cooldown ? `<p class="source-cooldown">${icon('clock', 13)} 搜索冷却约 ${Math.ceil(cooldown / 1000)} 秒，连搜时请稍候。</p>` : ''}
        <div class="source-card-foot">
          <span class="source-note">${esc(source.note || (source.enabled ? '已入席' : '暂时离席'))}</span>
          <div>
            <button class="btn btn-ghost btn-sm" data-action="test-source" data-id="${esc(source.id)}">${icon('refresh', 14)} 测试</button>
            <button class="btn btn-ghost btn-sm" data-action="test-source" data-id="${esc(source.id)}" data-repair="1">${icon('spark', 14)} 体检修复</button>
          </div>
        </div>
      </article>`;
    }).join('')}</div>
    ${!app.user ? `<div class="clinic-login-note">${icon('lock', 15)} 体检、修复与启停书源需要登录。 <a class="text-link" href="#/login?next=${encodeURIComponent(currentPath())}">现在登录</a></div>` : ''}`);
  document.title = '源体检 · 墨阅';
}

async function handleTestSource(button) {
  if (!requireLogin()) return;
  const id = button.dataset.id;
  const repair = button.dataset.repair === '1';
  setBusy(button, true, repair ? '修复中' : '体检中');
  try {
    const data = await api.testSource(id, repair);
    const index = app.sources.findIndex(item => item.id === data.source.id);
    if (index >= 0) app.sources[index] = { ...app.sources[index], ...data.source };
    renderChrome(app.route);
    renderSources();
    toast(data.source.repaired ? `${data.source.name} 已换到可用域名` : `${data.source.name}：${data.source.health?.message || '体检完成'}`, 'success');
  } catch (error) {
    setBusy(button, false);
    toast(error.message || '体检失败', 'error');
  }
}

async function handleHealthAll(button) {
  if (!requireLogin()) return;
  const repair = button.dataset.repair === '1';
  setBusy(button, true, repair ? '正在修复' : '正在体检');
  try {
    const data = await api.healthAll(repair);
    for (const item of data.items || []) {
      const index = app.sources.findIndex(source => source.id === item.id);
      if (index >= 0) app.sources[index] = { ...app.sources[index], ...item };
    }
    renderChrome(app.route);
    renderSources();
    const down = (data.items || []).filter(item => item.health?.status !== 'ok').length;
    toast(down ? `体检完成，${down} 处书源需要照看` : '全源体检完成，皆可开卷', down ? 'info' : 'success');
  } catch (error) {
    setBusy(button, false);
    toast(error.message || '全源体检失败', 'error');
  }
}

/* ---------------------------------- 设置 ---------------------------------- */

const THEME_OPTIONS = [
  { value: 'paper', label: '宣纸', color: '#f6f0e3' },
  { value: 'sepia', label: '米黄', color: '#efe0c3' },
  { value: 'green', label: '豆绿', color: '#dfe6d3' },
  { value: 'night', label: '夜读', color: '#222925' }
];
const FONT_OPTIONS = [{ value: 'serif', label: '宋体' }, { value: 'kai', label: '楷体' }, { value: 'sans', label: '黑体' }];
const WIDTH_OPTIONS = [{ value: 'narrow', label: '窄' }, { value: 'normal', label: '适中' }, { value: 'wide', label: '宽' }];

function prefButtons(name, options, current) {
  return options.map(option => `<button class="pref-chip ${String(current) === String(option.value) ? 'is-active' : ''}" data-pref="${name}" data-value="${option.value}">
    ${option.color ? `<i style="background:${option.color}"></i>` : ''}<span>${option.label}</span>
  </button>`).join('');
}

async function renderSettings() {
  if (!app.user) {
    setView(pageHeader({ kicker: 'SETTINGS', title: '设置', desc: '账号与阅读偏好。' }) + loginGate('设置需要一个账号', '登录后可以修改密码、保存阅读偏好，并管理这座小小的书房。'));
    document.title = '设置 · 墨阅';
    return;
  }
  const user = app.user;
  setView(`${pageHeader({
    kicker: 'SETTINGS',
    title: '设置',
    desc: '把灯调暗一些，把字放大一些。'
  })}
    <div class="settings-grid">
      <section class="paper-card settings-account">
        <div class="card-head"><h2>账号</h2><span class="card-mark">ACCOUNT</span></div>
        <div class="account-row">
          ${avatar(user, 'lg')}
          <div><h3>${esc(user.displayName || user.username)}</h3><p>@${esc(user.username)} · ${new Date(user.createdAt).toLocaleDateString('zh-CN')} 入住</p></div>
          <button class="btn btn-ghost btn-sm" data-action="logout">${icon('log-out', 15)} 退出登录</button>
        </div>
        <div class="settings-stats">
          <div><strong>${app.library.length}</strong><span>书架</span></div>
          <div><strong>${app.history.length}</strong><span>足迹</span></div>
          <div><strong>${app.bookmarks.length}</strong><span>书签</span></div>
        </div>
      </section>

      <section class="paper-card settings-prefs">
        <div class="card-head"><h2>阅读偏好</h2><span class="card-mark">READING</span></div>
        <div class="pref-row"><label>界面明暗</label><div class="pref-chips">${prefButtons('uiTheme', [{ value: 'light', label: '日间' }, { value: 'dark', label: '夜间' }], app.prefs.uiTheme)}</div></div>
        <div class="pref-row"><label>护眼纸色</label><div class="pref-chips">${prefButtons('readerTheme', THEME_OPTIONS, app.prefs.readerTheme)}</div></div>
        <div class="pref-row"><label>正文字体</label><div class="pref-chips">${prefButtons('fontFamily', FONT_OPTIONS, app.prefs.fontFamily)}</div></div>
        <div class="pref-row"><label>字号 <em data-pref-label="fontSize">${app.prefs.fontSize}px</em></label>
          <input class="pref-range" type="range" min="15" max="30" step="1" value="${app.prefs.fontSize}" data-pref-range="fontSize" aria-label="字号"></div>
        <div class="pref-row"><label>行距 <em data-pref-label="lineHeight">${Number(app.prefs.lineHeight).toFixed(1)}</em></label>
          <input class="pref-range" type="range" min="1.4" max="2.6" step="0.1" value="${app.prefs.lineHeight}" data-pref-range="lineHeight" aria-label="行距"></div>
        <div class="pref-row"><label>版心</label><div class="pref-chips">${prefButtons('readerWidth', WIDTH_OPTIONS, app.prefs.readerWidth)}</div></div>
        <p class="pref-hint">${icon('info', 14)} 偏好会立即保存，阅读器里也会同步。</p>
      </section>

      <section class="paper-card settings-password">
        <div class="card-head"><h2>修改密码</h2><span class="card-mark">PASSWORD</span></div>
        <form id="password-form" class="stack-form">
          <label><span>当前密码</span><input type="password" name="current" autocomplete="current-password" required placeholder="输入现在的密码"></label>
          <label><span>新密码</span><input type="password" name="next" autocomplete="new-password" minlength="6" maxlength="64" required placeholder="至少 6 位"></label>
          <label><span>再输一次</span><input type="password" name="confirm" autocomplete="new-password" minlength="6" maxlength="64" required placeholder="与新密码一致"></label>
          <button class="btn btn-primary" type="submit">保存新密码</button>
        </form>
      </section>

      <section class="paper-card settings-about">
        <div class="card-head"><h2>关于墨阅</h2><span class="card-mark">ABOUT</span></div>
        <p>墨阅是一间开在本地的小书房。书源、账号、书架与书签，都只存放在这台电脑的 <code>data</code> 目录里。</p>
        <dl class="about-list">
          <div><dt>版本</dt><dd>v${esc(app.status?.version || '1.0.0')}</dd></div>
          <div><dt>书源</dt><dd>${app.sources.length} 处</dd></div>
          <div><dt>服务</dt><dd>127.0.0.1:${esc(location.port || '8737')}</dd></div>
        </dl>
        <p class="about-quote">愿你在字里行间，遇见自己的山水。</p>
      </section>
    </div>`);
  document.title = '设置 · 墨阅';
  const view = document.getElementById('view');
  view.querySelectorAll('[data-pref]').forEach(button => {
    button.addEventListener('click', () => {
      const key = button.dataset.pref;
      let value = button.dataset.value;
      if (key === 'fontSize') value = Number(value);
      savePrefs({ [key]: value });
      view.querySelectorAll(`[data-pref="${key}"]`).forEach(item => item.classList.toggle('is-active', item === button));
      if (key === 'uiTheme') {
        renderChrome(app.route);
        applyUiTheme();
      }
    });
  });
  view.querySelectorAll('[data-pref-range]').forEach(input => {
    input.addEventListener('input', () => {
      const key = input.dataset.prefRange;
      const value = key === 'fontSize' ? Number(input.value) : Number(input.value);
      savePrefs({ [key]: value });
      const label = view.querySelector(`[data-pref-label="${key}"]`);
      if (label) label.textContent = key === 'fontSize' ? `${value}px` : Number(value).toFixed(1);
    });
  });
  const form = document.getElementById('password-form');
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    const data = new FormData(form);
    const current = String(data.get('current') || '');
    const next = String(data.get('next') || '');
    const confirm = String(data.get('confirm') || '');
    if (next.length < 6) {
      toast('新密码至少 6 位', 'error');
      return;
    }
    if (next !== confirm) {
      toast('两次输入的新密码不一致', 'error');
      return;
    }
    const button = form.querySelector('button[type="submit"]');
    setBusy(button, true, '保存中');
    try {
      await api.changePassword(current, next);
      form.reset();
      toast('密码已更新', 'success');
    } catch (error) {
      toast(error.message || '密码修改失败', 'error');
    } finally {
      setBusy(button, false);
    }
  });
}

/* ---------------------------------- 登录 ---------------------------------- */

function renderLogin(route) {
  if (app.user) {
    navigate('/settings');
    return;
  }
  const next = safeNext(route.query.next || '/home');
  const tab = route.query.tab === 'register' && app.status?.allowRegister ? 'register' : app.authTab;
  app.authTab = tab;
  const register = tab === 'register';
  setView(`<div class="auth-page">
    <div class="auth-art">
      <div class="auth-art-inner">
        ${logoMark(64)}
        <p class="auth-art-kicker">MOYUE · 墨阅</p>
        <h1>一盏灯，<br>半卷书。</h1>
        <p class="auth-art-desc">登录后，书架、足迹与书签都会替你收好。<br>夜里读到的句子，不会丢在风里。</p>
        <div class="auth-quote">「粗缯大布裹生涯，腹有诗书气自华。」<span>— 苏轼</span></div>
      </div>
      <div class="auth-art-mountains" aria-hidden="true"></div>
    </div>
    <div class="auth-card">
      <div class="auth-card-head">
        <p class="auth-kicker">${register ? 'JOIN THE LIBRARY' : 'WELCOME BACK'}</p>
        <h2>${register ? '新开一间书房' : '欢迎回来'}</h2>
        <p>${register ? '只需一个名字与一串密码。' : '输入账号，继续昨夜的书。'}</p>
      </div>
      <div class="auth-tabs" role="tablist">
        <button class="auth-tab ${!register ? 'is-active' : ''}" data-action="auth-tab" data-tab="login" role="tab" aria-selected="${!register}">登录</button>
        ${app.status?.allowRegister ? `<button class="auth-tab ${register ? 'is-active' : ''}" data-action="auth-tab" data-tab="register" role="tab" aria-selected="${register}">注册</button>` : ''}
      </div>
      <form id="auth-form" class="auth-form" novalidate>
        <label><span>账号</span><input name="username" type="text" autocomplete="username" required minlength="2" maxlength="20" placeholder="2–20 位中文、字母或数字"></label>
        ${register ? `<label><span>称呼 <em>可选</em></span><input name="displayName" type="text" maxlength="20" placeholder="想让我怎么称呼你"></label>` : ''}
        <label><span>密码</span><div class="password-field"><input name="password" type="password" autocomplete="${register ? 'new-password' : 'current-password'}" required minlength="6" maxlength="64" placeholder="至少 6 位"><button type="button" class="password-eye" data-action="toggle-password" aria-label="显示密码">${icon('eye', 16)}</button></div></label>
        ${register ? `<label><span>确认密码</span><input name="confirm" type="password" autocomplete="new-password" required minlength="6" maxlength="64" placeholder="再输一次"></label>` : ''}
        <button class="btn btn-primary btn-block auth-submit" type="submit">${register ? '开一间书房' : '推门进去'} ${icon('arrow-right', 16)}</button>
      </form>
      ${app.status?.allowRegister ? `<p class="auth-switch">${register ? '已经有账号？' : '第一次来？'}<button class="text-button" data-action="auth-tab" data-tab="${register ? 'login' : 'register'}">${register ? '直接登录' : '注册一个'}</button></p>` : '<p class="auth-switch">这台电脑暂未开放注册，请使用已有账号。</p>'}
      <p class="auth-note">${icon('lock', 13)} 账号与本机数据，只留在这台电脑。</p>
    </div>
  </div>`);
  document.title = register ? '注册 · 墨阅' : '登录 · 墨阅';
  const form = document.getElementById('auth-form');
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    const data = new FormData(form);
    const username = String(data.get('username') || '').trim();
    const password = String(data.get('password') || '');
    const displayName = String(data.get('displayName') || '').trim();
    const confirm = String(data.get('confirm') || '');
    if (!username || !password) {
      toast('请填写账号和密码', 'error');
      return;
    }
    if (register && password !== confirm) {
      toast('两次输入的密码不一致', 'error');
      return;
    }
    const button = form.querySelector('button[type="submit"]');
    setBusy(button, true, register ? '开户中' : '推门中');
    try {
      const payload = register ? await api.register({ username, password, displayName }) : await api.login(username, password);
      await afterAuth(payload, next);
    } catch (error) {
      toast(error.message || '登录失败', 'error');
      setBusy(button, false);
    }
  });
}

async function afterAuth(payload, next) {
  app.user = payload.user;
  app.prefs = { ...DEFAULT_PREFS, ...(payload.prefs || payload.user?.prefs || {}) };
  savePrefs(app.prefs, { remote: false });
  await loadUserData();
  renderChrome(app.route);
  toast(`欢迎，${app.user.displayName || app.user.username}`, 'success');
  navigate(safeNext(next || '/home'));
}

async function loadUserData() {
  if (!app.user) {
    app.library = [];
    app.history = [];
    app.bookmarks = [];
    return;
  }
  const [library, history, bookmarks] = await Promise.allSettled([api.library(), api.history(), api.bookmarks()]);
  app.library = library.status === 'fulfilled' ? library.value.items || [] : [];
  app.history = history.status === 'fulfilled' ? history.value.items || [] : [];
  app.bookmarks = bookmarks.status === 'fulfilled' ? bookmarks.value.items || [] : [];
}

/* --------------------------------- 其他页面 -------------------------------- */

function renderNotFound() {
  setView(pageHeader({ kicker: 'LOST PAGE', title: '这一页走丢了', desc: '或许是翻错了页，或许是书签被风吹走了。' })
    + emptyState({ symbol: 'book-open', title: '没有找到这一页', text: '回到首页，重新泡一盏茶。', action: '<a class="btn btn-primary" href="#/home">回到首页</a>' }));
  document.title = '未找到 · 墨阅';
}

function renderFatal(error) {
  const view = document.getElementById('view');
  view.innerHTML = `<div class="page"><div class="fatal-card">
    ${logoMark(54)}
    <h1>墨阅没有醒过来</h1>
    <p>${esc(error?.message || '无法连接本地服务')}</p>
    <p class="fatal-hint">请确认启动窗口仍在运行，然后刷新这一页。</p>
    <button class="btn btn-primary" data-action="reload-page">${icon('refresh', 16)} 重新连接</button>
  </div></div>`;
}

/* --------------------------------- 交互动作 -------------------------------- */

async function handleToggleShelf(button) {
  if (!requireLogin(currentPath(), '登录后就能把书收进书架。')) return;
  const book = app.currentBook;
  if (!book) return;
  const inLibrary = Boolean(app.bookState?.inLibrary);
  if (inLibrary) {
    const confirmed = await confirmDialog({
      title: '移出书架？',
      message: `《${book.title}》会从书架移走，但阅读足迹和书签仍会保留。`,
      confirmText: '移出',
      danger: true
    });
    if (!confirmed) return;
  }
  setBusy(button, true, inLibrary ? '移出中' : '收藏中');
  try {
    if (inLibrary) await api.removeLibrary(book.key);
    else await api.addLibrary(book);
    app.bookState = { ...(app.bookState || {}), inLibrary: !inLibrary };
    await refreshLibrary();
    updateShelfButton();
    toast(inLibrary ? '已移出书架' : '已收入书架', 'success');
  } catch (error) {
    setBusy(button, false);
    toast(error.message || '操作失败', 'error');
  }
}

function updateShelfButton() {
  const button = document.querySelector('[data-action="toggle-shelf"]');
  if (!button) return;
  const inLibrary = Boolean(app.bookState?.inLibrary);
  button.outerHTML = shelfButton(inLibrary);
}

async function handleStartRead() {
  const book = app.currentBook;
  if (!book) return;
  const start = bookStartPoint(book);
  if (!start) {
    toast('这本书还没有可读的章节', 'error');
    return;
  }
  navigate(readHref(book, start.chapter.id, start.percent).replace(/^#/, ''));
}

async function handleRemoveLibrary(button) {
  if (!requireLogin()) return;
  const key = button.dataset.key;
  const title = button.dataset.title || '这本书';
  const confirmed = await confirmDialog({ title: '移出书架？', message: `《${title}》会从书架移走，阅读足迹仍会保留。`, confirmText: '移出', danger: true });
  if (!confirmed) return;
  try {
    await api.removeLibrary(key);
    app.library = app.library.filter(item => item.key !== key);
    renderChrome(app.route);
    await renderShelf();
    toast('已移出书架', 'success');
  } catch (error) {
    toast(error.message || '移出失败', 'error');
  }
}

async function handleRemoveHistory(button) {
  const key = button.dataset.key;
  if (!key) return;
  const title = button.dataset.title || '这本书';
  const confirmed = await confirmDialog({ title: '删掉这条足迹？', message: `《${title}》的阅读位置会被删除，书签不会受影响。`, confirmText: '删除', danger: true });
  if (!confirmed) return;
  try {
    await api.removeHistory(key);
    app.history = app.history.filter(item => item.key !== key);
    await renderHistory();
    toast('足迹已删除', 'success');
  } catch (error) {
    toast(error.message || '删除失败', 'error');
  }
}

async function handleClearHistory(button) {
  const confirmed = await confirmDialog({ title: '清空全部足迹？', message: '所有阅读位置都会被清除，书架和书签会留下。', confirmText: '全部清空', danger: true });
  if (!confirmed) return;
  setBusy(button, true, '清空中');
  try {
    await api.clearHistory();
    app.history = [];
    await renderHistory();
    toast('足迹已清空', 'success');
  } catch (error) {
    setBusy(button, false);
    toast(error.message || '清空失败', 'error');
  }
}

async function handleRemoveBookmark(button) {
  const id = button.dataset.id;
  if (!id) return;
  try {
    await api.removeBookmark(id);
    app.bookmarks = app.bookmarks.filter(item => item.id !== id);
    await renderBookmarks(app.route);
    toast('书签已取下', 'success');
  } catch (error) {
    toast(error.message || '删除失败', 'error');
  }
}

async function handleToggleSource(button) {
  if (!requireLogin()) return;
  const id = button.dataset.id;
  const source = app.sources.find(item => item.id === id);
  if (!source) return;
  button.disabled = true;
  try {
    const data = await api.toggleSource(id, !source.enabled);
    Object.assign(source, data.source);
    renderChrome(app.route);
    renderSources();
    toast(`${source.name} 已${source.enabled ? '启用' : '停用'}`, 'success');
  } catch (error) {
    button.disabled = false;
    toast(error.message || '切换失败', 'error');
  }
}

async function handleLogout() {
  const confirmed = await confirmDialog({ title: '退出登录？', message: '书架和足迹会留在本机，下次登录还能找回。', confirmText: '退出' });
  if (!confirmed) return;
  try {
    await api.logout();
  } catch {}
  app.user = null;
  app.library = [];
  app.history = [];
  app.bookmarks = [];
  app.prefs = loadLocalPrefs();
  applyUiTheme();
  renderChrome(app.route);
  navigate('/home');
  toast('已退出登录', 'success');
}

function handleToggleUiTheme() {
  const next = app.prefs.uiTheme === 'dark' ? 'light' : 'dark';
  savePrefs({ uiTheme: next });
  renderChrome(app.route);
  applyUiTheme();
  if (Date.now() - app.themeToastAt > 1200) {
    app.themeToastAt = Date.now();
    toast(next === 'dark' ? '夜色已落下' : '天光照进来了', 'info', 1500);
  }
}

/* --------------------------------- 事件绑定 -------------------------------- */

function bindGlobalEvents() {
  window.addEventListener('hashchange', renderRoute);

  document.addEventListener('click', event => {
    const actionEl = event.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    switch (action) {
      case 'toggle-drawer': toggleDrawer(); break;
      case 'close-drawer': closeDrawer(); break;
      case 'toggle-ui-theme': handleToggleUiTheme(); break;
      case 'toggle-shelf': handleToggleShelf(actionEl); break;
      case 'start-read': handleStartRead(); break;
      case 'show-all-chapters': break;
      case 'remove-library': handleRemoveLibrary(actionEl); break;
      case 'remove-history': handleRemoveHistory(actionEl); break;
      case 'clear-history': handleClearHistory(actionEl); break;
      case 'remove-bookmark': handleRemoveBookmark(actionEl); break;
      case 'toggle-source': handleToggleSource(actionEl); break;
      case 'test-source': handleTestSource(actionEl); break;
      case 'health-all': handleHealthAll(actionEl); break;
      case 'logout': handleLogout(); break;
      case 'reload-page': location.reload(); break;
      case 'retry-route': renderRoute(); break;
      case 'toggle-chapters':
        app.chaptersExpanded = !app.chaptersExpanded;
        if (app.currentBook && app.bookState) paintBook(app.currentBook, app.bookState);
        break;
      case 'toggle-intro':
        app.introExpanded = !app.introExpanded;
        if (app.currentBook && app.bookState) paintBook(app.currentBook, app.bookState);
        break;
      case 'clear-recent':
        try { localStorage.removeItem(RECENT_KEY); } catch {}
        renderSearchLanding(app.route);
        toast('最近寻找已清空', 'info');
        break;
      case 'auth-tab':
        app.authTab = actionEl.dataset.tab === 'register' ? 'register' : 'login';
        renderLogin({ ...app.route, query: { ...app.route.query, tab: app.authTab } });
        break;
      case 'toggle-password': {
        const field = actionEl.closest('.password-field')?.querySelector('input');
        if (field) {
          field.type = field.type === 'password' ? 'text' : 'password';
          actionEl.innerHTML = icon(field.type === 'password' ? 'eye' : 'lock', 16);
        }
        break;
      }
      default: break;
    }
  });

  document.addEventListener('submit', event => {
    const form = event.target.closest('[data-search-form]');
    if (!form) return;
    event.preventDefault();
    const data = new FormData(form);
    const query = String(data.get('q') || '').trim();
    if (!query) {
      toast('先写一个书名或作者吧', 'info');
      form.querySelector('input[name="q"]')?.focus();
      return;
    }
    const sources = app.route?.name === 'search' ? app.route.query.sources || '' : '';
    navigate(searchHref(query, sources).replace(/^#/, ''));
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeDrawer();
    const tag = event.target?.tagName;
    if (event.key === '/' && !!document.querySelector('.top-search input')
      && !['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      document.querySelector('.top-search input')?.focus();
    }
  });

  document.getElementById('drawer-scrim')?.addEventListener('click', closeDrawer);
}

/* --------------------------------- 启动 ---------------------------------- */

async function init() {
  applyUiTheme();
  renderChrome(parseRoute());
  setView(`<div class="boot-screen">${logoMark(58)}<div class="ink-loader"><span></span><span></span><span></span></div><p>正在扫榻煮茶…</p></div>`);
  document.title = '墨阅';
  try {
    const [status, sources] = await Promise.all([api.status(), api.sources()]);
    app.status = status;
    app.sources = Array.isArray(sources.items) ? sources.items : [];
    app.user = status.user || null;
    if (app.user) {
      app.prefs = { ...DEFAULT_PREFS, ...(app.user.prefs || app.prefs) };
      savePrefs(app.prefs, { remote: false });
      await loadUserData();
    }
    app.ready = true;
    if (!location.hash) history.replaceState(null, '', '#/home');
    renderChrome(parseRoute());
    await renderRoute();
  } catch (error) {
    renderFatal(error);
  }
}

bindGlobalEvents();
init();
