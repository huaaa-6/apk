const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

export function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ESCAPES[ch]);
}

export function hashCode(value) {
  let hash = 0;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function toneFor(value) {
  return (hashCode(value) % 6) + 1;
}

export function proxyImage(url, source = '') {
  if (!url) return '';
  const raw = String(url).trim();
  if (!raw) return '';
  if (raw.startsWith('/api/img')) return raw;
  return `/api/img?u=${encodeURIComponent(raw)}&s=${encodeURIComponent(source)}`;
}

export function coverHtml(book, options = {}) {
  const title = book.title || '无题';
  const author = book.author || '佚名';
  const tone = toneFor(`${title}|${author}`);
  const src = proxyImage(book.cover, book.source || '');
  const loading = options.eager ? 'eager' : 'lazy';
  return `<div class="book-cover tone-${tone}" data-cover-wrap>
    ${src ? `<img src="${esc(src)}" alt="${esc(title)}封面" loading="${loading}" decoding="async" data-cover>` : ''}
    <div class="cover-art" aria-hidden="true">
      <span class="cover-seal">墨</span>
      <span class="cover-title">${esc(title)}</span>
      <span class="cover-author">${esc(author)}</span>
    </div>
  </div>`;
}

export function sourceName(id) {
  return ({ qimao: '七猫', biquge365: '笔趣阁' })[id] || id || '未知源';
}

export function sourceClass(id) {
  return id === 'qimao' ? 'source-qimao' : id === 'biquge365' ? 'source-biquge' : 'source-custom';
}

export function formatCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value || '');
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)} 亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`;
  return String(n);
}

export function formatPercent(value) {
  const n = Number(value) || 0;
  if (n <= 0) return '0%';
  if (n >= 1) return '100%';
  return `${Math.max(1, Math.round(n * 100))}%`;
}

export function timeAgo(timestamp) {
  const value = Number(timestamp) || 0;
  if (!value) return '';
  const diff = Date.now() - value;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
  return new Date(value).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

export function dayLabel(timestamp) {
  if (!timestamp) return '更早';
  const date = new Date(timestamp);
  const today = new Date();
  const startOf = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(date)) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

export function debounce(fn, wait = 300) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return wrapped;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

export function safeNext(value, fallback = '/home') {
  let next = String(value || '');
  if (next.startsWith('#')) next = next.slice(1);
  if (!next.startsWith('/') || next.startsWith('//')) return fallback;
  return next;
}

export function excerptOf(paragraphs, index = 0, length = 90) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  const text = list.slice(Math.max(0, index), Math.max(0, index) + 4).join(' ');
  return text.replace(/\s+/g, ' ').trim().slice(0, length);
}

export function isMobile() {
  return window.matchMedia('(max-width: 900px)').matches;
}
