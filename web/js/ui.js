import { icon, logoMark } from './icons.js';
import { esc, coverHtml, sourceName, sourceClass, formatPercent, timeAgo } from './util.js';

let toastRoot = null;

function ensureToastRoot() {
  if (!toastRoot) {
    toastRoot = document.getElementById('toast-root');
    if (!toastRoot) {
      toastRoot = document.createElement('div');
      toastRoot.id = 'toast-root';
      toastRoot.className = 'toast-root';
      document.body.appendChild(toastRoot);
    }
  }
  return toastRoot;
}

export function toast(message, type = 'info', duration = 2800) {
  const root = ensureToastRoot();
  [...root.children].forEach(item => {
    if (item.dataset.message === message) item.remove();
  });
  while (root.children.length >= 2) root.firstElementChild.remove();
  const node = document.createElement('div');
  node.className = `toast toast-${type}`;
  node.dataset.message = message;
  const symbol = type === 'success' ? 'check' : type === 'error' ? 'alert' : 'info';
  node.innerHTML = `${icon(symbol, 17)}<span>${esc(message)}</span>`;
  root.appendChild(node);
  requestAnimationFrame(() => node.classList.add('is-visible'));
  setTimeout(() => {
    node.classList.remove('is-visible');
    setTimeout(() => node.remove(), 220);
  }, duration);
}

export function confirmDialog({ title = '请确认', message = '', confirmText = '确定', cancelText = '取消', danger = false } = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal-card confirm-card" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <div class="modal-corner tl"></div><div class="modal-corner tr"></div>
      <div class="modal-corner bl"></div><div class="modal-corner br"></div>
      <h2 id="confirm-title">${esc(title)}</h2>
      <p class="confirm-message">${esc(message)}</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-cancel>${esc(cancelText)}</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-confirm>${esc(confirmText)}</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('is-visible'));
    const close = value => {
      overlay.classList.remove('is-visible');
      setTimeout(() => overlay.remove(), 180);
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = event => {
      if (event.key === 'Escape') close(false);
      if (event.key === 'Enter') close(true);
    };
    overlay.querySelector('[data-cancel]').addEventListener('click', () => close(false));
    overlay.querySelector('[data-confirm]').addEventListener('click', () => close(true));
    overlay.addEventListener('click', event => {
      if (event.target === overlay) close(false);
    });
    document.addEventListener('keydown', onKey);
    setTimeout(() => overlay.querySelector('[data-confirm]')?.focus(), 30);
  });
}

export function emptyState({ symbol = 'book-open', title = '这里还是空的', text = '', action = '' } = {}) {
  return `<div class="empty-state">
    <div class="empty-symbol">${icon(symbol, 34)}</div>
    <h3>${esc(title)}</h3>
    ${text ? `<p>${esc(text)}</p>` : ''}
    ${action ? `<div class="empty-action">${action}</div>` : ''}
  </div>`;
}

export function loadingView(label = '正在取书') {
  return `<div class="loading-view" role="status" aria-live="polite">
    <div class="ink-loader"><span></span><span></span><span></span></div>
    <p>${esc(label)}</p>
  </div>`;
}

export function skeletonCards(count = 6) {
  return `<div class="skeleton-grid">${Array.from({ length: count }, () => `
    <div class="skeleton-card">
      <div class="skeleton-cover shimmer"></div>
      <div class="skeleton-line w80 shimmer"></div>
      <div class="skeleton-line w50 shimmer"></div>
    </div>`).join('')}</div>`;
}

export function sectionHead({ index = '', title = '', desc = '', action = '' } = {}) {
  return `<div class="section-head">
    <div class="section-title-wrap">
      ${index ? `<span class="section-index">${esc(index)}</span>` : '<span class="section-rule"></span>'}
      <div>
        <h2>${esc(title)}</h2>
        ${desc ? `<p>${esc(desc)}</p>` : ''}
      </div>
    </div>
    ${action ? `<div class="section-action">${action}</div>` : ''}
  </div>`;
}

export function pageHeader({ kicker = '', title = '', desc = '', actions = '' } = {}) {
  return `<header class="page-header">
    <div class="page-heading">
      ${kicker ? `<p class="page-kicker">${esc(kicker)}</p>` : ''}
      <h1>${esc(title)}</h1>
      ${desc ? `<p class="page-desc">${esc(desc)}</p>` : ''}
    </div>
    ${actions ? `<div class="page-actions">${actions}</div>` : ''}
  </header>`;
}

export function sourceBadge(sourceId, extra = '') {
  return `<span class="source-badge ${sourceClass(sourceId)}"><i></i>${esc(sourceName(sourceId))}${extra ? ` · ${esc(extra)}` : ''}</span>`;
}

export function avatar(user, size = 'md') {
  const initial = user?.displayName?.slice(0, 1) || user?.username?.slice(0, 1) || '客';
  return `<span class="avatar avatar-${size}" aria-hidden="true"><span>${esc(initial)}</span></span>`;
}

export function bookCard(book, { progress = null, actions = '', compact = false, eager = false } = {}) {
  const source = book.source || '';
  const bookId = book.bookId || '';
  const href = source && bookId ? `#/book/${encodeURIComponent(source)}/${encodeURIComponent(bookId)}` : '#/search';
  const author = book.author || '佚名';
  const category = book.category || '未分类';
  return `<article class="book-card ${compact ? 'is-compact' : ''}">
    <a class="book-card-link" href="${href}" aria-label="${esc(book.title)}">
      ${coverHtml(book, { eager })}
      <div class="book-card-info">
        <div class="book-card-top">
          <h3>${esc(book.title)}</h3>
          ${source ? sourceBadge(source) : ''}
        </div>
        <p class="book-author">${esc(author)} <span>·</span> ${esc(category)}</p>
        ${book.intro ? `<p class="book-intro">${esc(book.intro)}</p>` : ''}
        ${progress ? progressBar(progress.percent, `读到 ${progress.chapterTitle || `第 ${progress.chapterIndex || 1} 章`}`) : ''}
      </div>
    </a>
    ${actions ? `<div class="book-card-actions">${actions}</div>` : ''}
  </article>`;
}

export function bookRow(book, { meta = '', actions = '', progress = null } = {}) {
  const source = book.source || '';
  const bookId = book.bookId || '';
  const href = source && bookId ? `#/book/${encodeURIComponent(source)}/${encodeURIComponent(bookId)}` : '#/search';
  return `<article class="book-row">
    <a class="book-row-main" href="${href}">
      ${coverHtml(book)}
      <div class="book-row-info">
        <div class="book-row-title"><h3>${esc(book.title)}</h3>${source ? sourceBadge(source) : ''}</div>
        <p>${esc(book.author || '佚名')}${meta ? ` <span class="dot">·</span> ${esc(meta)}` : ''}</p>
        ${progress ? progressBar(progress.percent, `已读 ${formatPercent(progress.percent)}${progress.chapterTitle ? ` · ${progress.chapterTitle}` : ''}`) : ''}
      </div>
    </a>
    ${actions ? `<div class="book-row-actions">${actions}</div>` : ''}
  </article>`;
}

export function progressBar(percent, label = '') {
  const value = Math.max(0, Math.min(100, (Number(percent) || 0) * 100));
  return `<div class="reading-progress">
    <div class="progress-track"><span style="width:${value.toFixed(1)}%"></span></div>
    ${label ? `<p class="progress-label">${esc(label)}</p>` : ''}
  </div>`;
}

export function statPill(label, value) {
  return `<div class="stat-pill"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`;
}

export function timestamp(value) {
  return value ? timeAgo(value) : '';
}

export function setBusy(button, busy, busyText = '请稍候') {
  if (!button) return;
  if (busy) {
    if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
    button.disabled = true;
    button.classList.add('is-busy');
    button.innerHTML = `<span class="btn-spinner"></span>${esc(busyText)}`;
  } else {
    button.disabled = false;
    button.classList.remove('is-busy');
    if (button.dataset.originalHtml) {
      button.innerHTML = button.dataset.originalHtml;
      delete button.dataset.originalHtml;
    }
  }
}

export function brandBlock() {
  return `<a class="brand" href="#/home" aria-label="墨阅首页">
    ${logoMark(38)}
    <span class="brand-text"><strong>墨阅</strong><em>MOYUE</em></span>
  </a>`;
}

export function initUi() {
  document.addEventListener('error', event => {
    const image = event.target;
    if (!image || image.tagName !== 'IMG' || !image.matches('[data-cover]')) return;
    const wrap = image.closest('[data-cover-wrap]');
    if (wrap) wrap.classList.add('is-broken');
    image.removeAttribute('src');
  }, true);
  const root = document.getElementById('toast-root');
  if (root) toastRoot = root;
}
