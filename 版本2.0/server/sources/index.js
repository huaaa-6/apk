'use strict';

const store = require('../store');
const { AppError, bookKey, normalizeText } = require('../util');
const adapters = {
  qimao: require('./qimao'),
  biquge365: require('./biquge365')
};

const searchCache = new Map();
const detailCache = new Map();
const chapterCache = new Map();
const SEARCH_TTL = 90 * 1000;
const DETAIL_TTL = 10 * 60 * 1000;
const CHAPTER_TTL = 10 * 60 * 1000;

function cacheGet(map, key) {
  const entry = map.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    map.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(map, key, value, ttl, max) {
  map.set(key, { value, expiresAt: Date.now() + ttl });
  while (map.size > max) {
    map.delete(map.keys().next().value);
  }
}

function adapterFor(source) {
  const adapter = adapters[source.adapter];
  if (!adapter) throw new AppError(500, `数据源适配器缺失：${source.adapter}`, 'NO_ADAPTER');
  return adapter;
}

function validateBookId(id) {
  const value = String(id || '');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw new AppError(400, '书籍标识不正确', 'BAD_BOOK_ID');
  return value;
}

function validateChapterId(id) {
  const value = String(id || '');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw new AppError(400, '章节标识不正确', 'BAD_CHAPTER_ID');
  return value;
}

function publicSource(source) {
  return {
    id: source.id,
    name: source.name,
    adapter: source.adapter,
    baseUrl: source.baseUrl,
    enabled: source.enabled,
    note: source.note,
    health: { ...source.health }
  };
}

function mergeResults(batches) {
  const groups = [];
  const index = new Map();
  for (const batch of batches) {
    if (!batch.ok) continue;
    for (const item of batch.items) {
      const titleKey = normalizeText(item.title);
      const authorKey = normalizeText(item.author || '');
      const key = `${titleKey}|${authorKey}`;
      let group = index.get(key);
      if (!group) {
        group = {
          ...item,
          sources: [],
          sourceCount: 0
        };
        index.set(key, group);
        groups.push(group);
      }
      if (group.sources.some(entry => entry.source === item.source && entry.bookId === item.bookId)) continue;
      group.sources.push({
        source: item.source,
        sourceName: batch.source.name,
        bookId: item.bookId,
        cover: item.cover || ''
      });
      group.sourceCount = group.sources.length;
      if (!group.cover && item.cover) group.cover = item.cover;
      if ((item.intro || '').length > (group.intro || '').length) group.intro = item.intro;
      if (!group.category && item.category) group.category = item.category;
      if (!group.status && item.status) group.status = item.status;
      if (!group.words && item.words) group.words = item.words;
      if (!group.latestChapter && item.latestChapter) group.latestChapter = item.latestChapter;
      if (!group.updatedAt && item.updatedAt) group.updatedAt = item.updatedAt;
      if (!group.score && item.score) group.score = item.score;
    }
  }
  for (const group of groups) {
    group.sources.sort((a, b) => (a.source === 'qimao' ? -1 : b.source === 'qimao' ? 1 : 0));
    const primary = group.sources.find(entry => entry.source === 'qimao') || group.sources[0];
    group.primarySource = primary.source;
    group.primaryBookId = primary.bookId;
    group.source = primary.source;
    group.bookId = primary.bookId;
    group.id = `${primary.source}:${primary.bookId}`;
  }
  return groups;
}

async function searchSource(source, query) {
  const cacheKey = `${source.id}:${normalizeText(query)}`;
  const cached = cacheGet(searchCache, cacheKey);
  if (cached) return { ...cached, cached: true };
  const started = Date.now();
  try {
    const items = await adapterFor(source).search(query, source);
    const result = {
      source: publicSource(source),
      ok: true,
      items: Array.isArray(items) ? items : [],
      ms: Date.now() - started,
      error: '',
      code: ''
    };
    cacheSet(searchCache, cacheKey, result, SEARCH_TTL, 80);
    return result;
  } catch (error) {
    return {
      source: publicSource(source),
      ok: false,
      items: [],
      ms: Date.now() - started,
      error: error.message || '搜索失败',
      code: error.code || 'SEARCH_FAILED'
    };
  }
}

async function searchAll(query, options = {}) {
  const keyword = String(query || '').trim().slice(0, 60);
  if (!keyword) throw new AppError(400, '请输入要搜索的书名或作者', 'EMPTY_QUERY');
  let sources = store.enabledSources();
  const filter = Array.isArray(options.sourceIds)
    ? options.sourceIds.filter(Boolean)
    : String(options.sourceIds || '').split(',').map(item => item.trim()).filter(Boolean);
  if (filter.length) sources = sources.filter(source => filter.includes(source.id));
  if (!sources.length) throw new AppError(400, '没有可用的数据源，请先在「源体检」中启用', 'NO_SOURCE');

  const batches = await Promise.all(sources.map(source => searchSource(source, keyword)));
  const groups = mergeResults(batches);
  return {
    query: keyword,
    groups,
    sources: batches.map(batch => ({
      id: batch.source.id,
      name: batch.source.name,
      ok: batch.ok,
      ms: batch.ms,
      count: batch.items.length,
      error: batch.error,
      code: batch.code,
      cached: Boolean(batch.cached)
    })),
    total: groups.length
  };
}

async function getBook(sourceId, bookId) {
  const source = store.getSource(sourceId);
  if (!source) throw new AppError(404, '数据源不存在', 'NO_SOURCE');
  const id = validateBookId(bookId);
  const key = `${sourceId}:${id}`;
  const cached = cacheGet(detailCache, key);
  if (cached) return cached;
  const book = await adapterFor(source).detail(id, source);
  book.source = sourceId;
  book.bookId = id;
  book.key = key;
  book.sourceName = source.name;
  if (!Array.isArray(book.chapters)) book.chapters = [];
  cacheSet(detailCache, key, book, DETAIL_TTL, 16);
  return book;
}

async function getChapter(sourceId, bookId, chapterId) {
  const source = store.getSource(sourceId);
  if (!source) throw new AppError(404, '数据源不存在', 'NO_SOURCE');
  const id = validateBookId(bookId);
  let cid = validateChapterId(chapterId);
  let book = await getBook(sourceId, id);
  const cacheKey = `${sourceId}:${id}:${cid}`;
  let chapter = cacheGet(chapterCache, cacheKey);
  if (!chapter) {
    const adapter = adapterFor(source);
    const position = book.chapters.findIndex(item => String(item.id) === cid);
    try {
      chapter = await adapter.chapter(id, cid, source);
    } catch (error) {
      // 部分源会轮换章节 ID。旧链接/旧缓存取不到正文时，刷新目录后按原书序重试一次。
      if (error.code !== 'EMPTY_CHAPTER' || position < 0) throw error;
      try {
        const fresh = await adapter.detail(id, source);
        const target = Array.isArray(fresh.chapters) ? fresh.chapters[position] : null;
        if (!target || String(target.id) === cid) throw error;
        fresh.source = sourceId;
        fresh.bookId = id;
        fresh.key = `${sourceId}:${id}`;
        fresh.sourceName = source.name;
        if (!Array.isArray(fresh.chapters)) fresh.chapters = [];
        chapter = await adapter.chapter(id, String(target.id), source);
        cid = String(target.id);
        book = fresh;
        cacheSet(detailCache, `${sourceId}:${id}`, fresh, DETAIL_TTL, 16);
        chapterCache.delete(cacheKey);
      } catch (retryError) {
        if (retryError === error) throw error;
        throw retryError;
      }
    }
    cacheSet(chapterCache, `${sourceId}:${id}:${cid}`, chapter, CHAPTER_TTL, 80);
  }
  const position = book.chapters.findIndex(item => String(item.id) === cid);
  const index = position >= 0 ? position + 1 : 1;
  const total = book.chapters.length || 1;
  let prev = null;
  let next = null;
  if (position >= 0) {
    if (position > 0) prev = book.chapters[position - 1];
    if (position < book.chapters.length - 1) next = book.chapters[position + 1];
  } else {
    if (chapter.prevId) prev = { id: chapter.prevId, title: '上一章' };
    if (chapter.nextId) next = { id: chapter.nextId, title: '下一章' };
  }
  const fallbackTitle = position >= 0 ? book.chapters[position].title : '';
  return {
    chapter: {
      ...chapter,
      title: chapter.title || fallbackTitle,
      index,
      total
    },
    book: {
      source: book.source,
      sourceName: book.sourceName,
      bookId: book.bookId,
      key: book.key,
      title: book.title,
      author: book.author,
      cover: book.cover,
      category: book.category,
      status: book.status
    },
    index,
    total,
    prev: prev ? { id: String(prev.id), title: prev.title } : null,
    next: next ? { id: String(next.id), title: next.title } : null
  };
}

async function checkSource(source, { repair = false } = {}) {
  const adapter = adapterFor(source);
  const started = Date.now();
  try {
    const result = await adapter.probe(source);
    const latency = Date.now() - started;
    const health = {
      status: 'ok',
      latency,
      checkedAt: Date.now(),
      message: result.message || '访问正常',
      consecutiveFailures: 0
    };
    store.updateSourceHealth(source.id, health);
    return { ...publicSource(store.getSource(source.id)), health };
  } catch (error) {
    if (repair && Array.isArray(source.alternates) && source.alternates.length) {
      for (const alternate of source.alternates) {
        if (!alternate || alternate === source.baseUrl) continue;
        const candidate = { ...source, baseUrl: alternate };
        try {
          const result = await adapter.probe(candidate);
          const latency = Date.now() - started;
          store.updateSourceBaseUrl(source.id, alternate);
          const health = {
            status: 'ok',
            latency,
            checkedAt: Date.now(),
            message: `已切换到候选域名 ${alternate}（${result.message || '访问正常'}）`,
            consecutiveFailures: 0
          };
          store.updateSourceHealth(source.id, health);
          searchCache.clear();
          detailCache.clear();
          chapterCache.clear();
          return { ...publicSource(store.getSource(source.id)), health, repaired: true };
        } catch {}
      }
    }
    const current = store.getSource(source.id);
    const failures = (current.health?.consecutiveFailures || 0) + 1;
    const health = {
      status: 'down',
      latency: Date.now() - started,
      checkedAt: Date.now(),
      message: error.message || '无法访问',
      consecutiveFailures: failures
    };
    store.updateSourceHealth(source.id, health);
    if (store.settings().autoDisable && failures >= 3 && source.enabled) {
      store.setSourceEnabled(source.id, false);
      health.message += '；连续失败，已自动停用';
    }
    return { ...publicSource(store.getSource(source.id)), health };
  }
}

async function healthAll({ repair = false } = {}) {
  const sources = store.getSources();
  const results = await Promise.all(sources.map(source => checkSource(source, { repair })));
  return results;
}

function clearCaches() {
  searchCache.clear();
  detailCache.clear();
  chapterCache.clear();
}

module.exports = {
  searchAll,
  getBook,
  getChapter,
  checkSource,
  healthAll,
  clearCaches,
  publicSource,
  adapters
};
