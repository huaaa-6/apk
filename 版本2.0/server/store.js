'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AppError, bookKey, parseBookKey, randomId, clamp } = require('./util');

const DATA_DIR = process.env.MOYUE_DATA_DIR
  ? path.resolve(process.env.MOYUE_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SESSION_DAYS = 30;
const MAX_HISTORY = 150;
const MAX_BOOKMARKS = 300;

const DEFAULT_DATA = {
  version: 1,
  createdAt: Date.now(),
  settings: {
    autoDisable: false,
    allowRegister: true
  },
  sources: [
    {
      id: 'qimao',
      name: '七猫中文网',
      adapter: 'qimao',
      baseUrl: 'https://www.qimao.com',
      enabled: true,
      note: '正版免费 · 搜索、封面、目录与全文',
      alternates: [],
      health: { status: 'unknown', latency: 0, checkedAt: 0, message: '', consecutiveFailures: 0 }
    },
    {
      id: 'biquge365',
      name: '笔趣阁 365',
      adapter: 'biquge365',
      baseUrl: 'https://www.biquge365.net',
      enabled: true,
      note: '镜像站 · 搜索约 15 秒一次，目录与全文',
      alternates: [],
      health: { status: 'unknown', latency: 0, checkedAt: 0, message: '', consecutiveFailures: 0 }
    }
  ],
  users: [],
  sessions: {}
};

let data;
let saveTimer = null;
let dirty = false;

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function normalizeUser(user) {
  const base = {
    id: user.id || randomId(12),
    username: user.username || '',
    displayName: user.displayName || user.username || '',
    passwordHash: user.passwordHash || '',
    salt: user.salt || '',
    createdAt: user.createdAt || Date.now(),
    prefs: {
      readerTheme: 'paper',
      fontSize: 19,
      lineHeight: 1.9,
      fontFamily: 'serif',
      readerWidth: 'normal',
      uiTheme: 'light',
      ...(user.prefs || {})
    },
    library: user.library && typeof user.library === 'object' ? user.library : {},
    history: user.history && typeof user.history === 'object' ? user.history : {},
    bookmarks: Array.isArray(user.bookmarks) ? user.bookmarks : []
  };
  return base;
}

function normalizeData(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const result = {
    ...DEFAULT_DATA,
    ...raw,
    settings: { ...DEFAULT_DATA.settings, ...(raw.settings || {}) },
    sources: Array.isArray(raw.sources) && raw.sources.length
      ? raw.sources.map(source => ({
          ...source,
          enabled: source.enabled !== false,
          alternates: Array.isArray(source.alternates) ? source.alternates : [],
          health: { ...DEFAULT_DATA.sources[0].health, ...(source.health || {}) }
        }))
      : DEFAULT_DATA.sources.map(source => structuredClone(source)),
    users: Array.isArray(raw.users) ? raw.users.map(normalizeUser) : [],
    sessions: raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {}
  };
  // 兼容旧版本或缺失内置源
  for (const source of DEFAULT_DATA.sources) {
    if (!result.sources.some(item => item.id === source.id)) {
      result.sources.push(structuredClone(source));
    }
  }
  return result;
}

function load() {
  ensureDataDir();
  if (!fs.existsSync(DB_FILE)) {
    data = normalizeData(DEFAULT_DATA);
    writeNow();
    return;
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    data = normalizeData(JSON.parse(raw));
  } catch (error) {
    console.error('[store] 数据文件读取失败，已备份并重建：', error.message);
    try {
      fs.copyFileSync(DB_FILE, path.join(DATA_DIR, `db.corrupt-${Date.now()}.json`));
    } catch {}
    data = normalizeData(DEFAULT_DATA);
  }
  pruneSessions();
}

function writeNow() {
  ensureDataDir();
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
  dirty = false;
}

function save() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      writeNow();
    } catch (error) {
      console.error('[store] 数据写入失败：', error.message);
      saveTimer = setTimeout(save, 2000);
    }
  }, 120);
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (dirty) {
    try { writeNow(); } catch (error) { console.error('[store] 最终写入失败：', error.message); }
  }
}

function pruneSessions() {
  const now = Date.now();
  let changed = false;
  for (const [sid, session] of Object.entries(data.sessions)) {
    if (!session || session.expiresAt <= now) {
      delete data.sessions[sid];
      changed = true;
    }
  }
  if (changed) save();
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    createdAt: user.createdAt,
    prefs: { ...user.prefs }
  };
}

function findUserByName(username) {
  const needle = String(username || '').trim().toLowerCase();
  return data.users.find(user => user.username.toLowerCase() === needle) || null;
}

function findUserById(id) {
  return data.users.find(user => user.id === id) || null;
}

function createUser({ username, displayName, passwordHash, salt }) {
  const user = normalizeUser({
    id: randomId(12),
    username,
    displayName: displayName || username,
    passwordHash,
    salt,
    createdAt: Date.now()
  });
  data.users.push(user);
  save();
  return user;
}

function createSession(userId) {
  const sid = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const sessions = data.sessions;
  // 单用户最多保留 12 个会话
  const own = Object.entries(sessions)
    .filter(([, session]) => session.userId === userId)
    .sort((a, b) => b[1].createdAt - a[1].createdAt);
  for (const [oldSid] of own.slice(11)) delete sessions[oldSid];
  sessions[sid] = { userId, createdAt: now, expiresAt: now + SESSION_DAYS * 86400000 };
  save();
  return sid;
}

function getSession(sid) {
  if (!sid) return null;
  const session = data.sessions[sid];
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    delete data.sessions[sid];
    save();
    return null;
  }
  return session;
}

function destroySession(sid) {
  if (sid && data.sessions[sid]) {
    delete data.sessions[sid];
    save();
  }
}

function userFromSession(sid) {
  const session = getSession(sid);
  return session ? findUserById(session.userId) : null;
}

function prefDefaults() {
  return normalizeUser({}).prefs;
}

function sanitizeText(value, max = 300) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function sanitizeBook(book = {}) {
  const source = sanitizeText(book.source, 40);
  const bookId = sanitizeText(book.bookId, 80);
  if (!source || !bookId) throw new AppError(400, '书籍信息不完整', 'BAD_BOOK');
  if (!/^[A-Za-z0-9_-]+$/.test(source) || !/^[A-Za-z0-9_-]+$/.test(bookId)) {
    throw new AppError(400, '书籍标识不正确', 'BAD_BOOK');
  }
  const title = sanitizeText(book.title, 160);
  if (!title) throw new AppError(400, '缺少书名', 'BAD_BOOK');
  return {
    source,
    bookId,
    key: bookKey(source, bookId),
    title,
    author: sanitizeText(book.author, 80) || '佚名',
    cover: sanitizeText(book.cover, 600),
    intro: sanitizeText(book.intro, 3000),
    category: sanitizeText(book.category, 60),
    status: sanitizeText(book.status, 30),
    words: sanitizeText(book.words, 30),
    latestChapter: sanitizeText(book.latestChapter, 160),
    updatedAt: sanitizeText(book.updatedAt, 40)
  };
}

function getLibrary(userId) {
  const user = findUserById(userId);
  if (!user) throw new AppError(401, '请先登录', 'UNAUTHORIZED');
  return Object.values(user.library)
    .sort((a, b) => (b.lastReadAt || b.addedAt) - (a.lastReadAt || a.addedAt))
    .map(item => ({ ...item }));
}

function inLibrary(userId, key) {
  const user = findUserById(userId);
  return Boolean(user && user.library[key]);
}

function addToLibrary(userId, rawBook) {
  const user = findUserById(userId);
  if (!user) throw new AppError(401, '请先登录', 'UNAUTHORIZED');
  const book = sanitizeBook(rawBook);
  const existing = user.library[book.key];
  if (existing) {
    user.library[book.key] = { ...existing, ...book, addedAt: existing.addedAt };
  } else {
    user.library[book.key] = { ...book, addedAt: Date.now(), lastReadAt: 0 };
  }
  save();
  return user.library[book.key];
}

function removeFromLibrary(userId, key) {
  const user = findUserById(userId);
  if (!user) throw new AppError(401, '请先登录', 'UNAUTHORIZED');
  delete user.library[key];
  save();
  return true;
}

function getProgress(userId, key) {
  const user = findUserById(userId);
  const record = user && user.history[key];
  if (!record) return null;
  return {
    chapterId: record.chapterId,
    chapterTitle: record.chapterTitle,
    chapterIndex: record.chapterIndex,
    chapterPercent: record.chapterPercent,
    percent: record.percent,
    updatedAt: record.updatedAt
  };
}

function saveHistory(userId, payload = {}) {
  const user = findUserById(userId);
  if (!user) throw new AppError(401, '请先登录', 'UNAUTHORIZED');
  const book = sanitizeBook(payload.book);
  const chapterId = sanitizeText(payload.chapterId, 80);
  if (!chapterId) throw new AppError(400, '缺少章节信息', 'BAD_CHAPTER');
  const chapterIndex = Math.max(1, Number(payload.chapterIndex) || 1);
  const chapterPercent = clamp(payload.chapterPercent, 0, 1);
  const percent = clamp(payload.percent, 0, 1);
  const now = Date.now();
  const record = {
    key: book.key,
    book,
    chapterId,
    chapterTitle: sanitizeText(payload.chapterTitle, 160),
    chapterIndex,
    chapterPercent,
    percent,
    updatedAt: now
  };
  user.history[book.key] = record;
  if (user.library[book.key]) {
    user.library[book.key].lastReadAt = now;
    user.library[book.key].latestChapter = book.latestChapter || user.library[book.key].latestChapter;
  }
  const entries = Object.entries(user.history).sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  for (const [key] of entries.slice(MAX_HISTORY)) delete user.history[key];
  save();
  return record;
}

function getHistory(userId) {
  const user = findUserById(userId);
  if (!user) throw new AppError(401, '请先登录', 'UNAUTHORIZED');
  return Object.values(user.history).sort((a, b) => b.updatedAt - a.updatedAt);
}

function removeHistory(userId, key) {
  const user = findUserById(userId);
  if (!user) throw new AppError(401, '请先登录', 'UNAUTHORIZED');
  delete user.history[key];
  save();
  return true;
}

function clearHistory(userId) {
  const user = findUserById(userId);
  if (!user) throw new AppError(401, '请先登录', 'UNAUTHORIZED');
  user.history = {};
  save();
  return true;
}

function getBookmarks(userId, key) {
  const user = findUserById(userId);
  if (!user) throw new AppError(401, '请先登录', 'UNAUTHORIZED');
  return user.bookmarks
    .filter(item => !key || item.key === key)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function addBookmark(userId, payload = {}) {
  const user = findUserById(userId);
  if (!user) throw new AppError(401, '请先登录', 'UNAUTHORIZED');
  const book = sanitizeBook(payload.book);
  const chapterId = sanitizeText(payload.chapterId, 80);
  if (!chapterId) throw new AppError(400, '缺少章节信息', 'BAD_CHAPTER');
  const percent = clamp(payload.percent, 0, 1);
  const bucket = Math.round(percent * 20);
  const existing = user.bookmarks.find(item => item.key === book.key && item.chapterId === chapterId
    && Math.round((item.percent || 0) * 20) === bucket);
  if (existing) {
    if (payload.note != null) existing.note = sanitizeText(payload.note, 500);
    if (payload.excerpt != null) existing.excerpt = sanitizeText(payload.excerpt, 500);
    existing.updatedAt = Date.now();
    save();
    return { bookmark: existing, duplicate: true };
  }
  const bookmark = {
    id: randomId(8),
    key: book.key,
    book,
    chapterId,
    chapterTitle: sanitizeText(payload.chapterTitle, 160),
    chapterIndex: Math.max(1, Number(payload.chapterIndex) || 1),
    percent,
    excerpt: sanitizeText(payload.excerpt, 500),
    note: sanitizeText(payload.note, 500),
    createdAt: Date.now()
  };
  user.bookmarks.unshift(bookmark);
  if (user.bookmarks.length > MAX_BOOKMARKS) user.bookmarks.length = MAX_BOOKMARKS;
  save();
  return { bookmark, duplicate: false };
}

function removeBookmark(userId, id) {
  const user = findUserById(userId);
  if (!user) throw new AppError(401, '请先登录', 'UNAUTHORIZED');
  const before = user.bookmarks.length;
  user.bookmarks = user.bookmarks.filter(item => item.id !== id);
  if (user.bookmarks.length === before) throw new AppError(404, '书签不存在', 'NOT_FOUND');
  save();
  return true;
}

function updatePrefs(userId, patch = {}) {
  const user = findUserById(userId);
  if (!user) throw new AppError(401, '请先登录', 'UNAUTHORIZED');
  const next = { ...user.prefs };
  const themes = ['paper', 'sepia', 'green', 'night'];
  const families = ['serif', 'kai', 'sans'];
  const widths = ['narrow', 'normal', 'wide'];
  if (themes.includes(patch.readerTheme)) next.readerTheme = patch.readerTheme;
  if (families.includes(patch.fontFamily)) next.fontFamily = patch.fontFamily;
  if (widths.includes(patch.readerWidth)) next.readerWidth = patch.readerWidth;
  if (['light', 'dark'].includes(patch.uiTheme)) next.uiTheme = patch.uiTheme;
  if (patch.fontSize != null) next.fontSize = clamp(Math.round(patch.fontSize), 15, 30);
  if (patch.lineHeight != null) next.lineHeight = clamp(Number(patch.lineHeight), 1.4, 2.6);
  user.prefs = next;
  save();
  return next;
}

function setUserPassword(userId, passwordHash, salt) {
  const user = findUserById(userId);
  if (!user) throw new AppError(401, '请先登录', 'UNAUTHORIZED');
  user.passwordHash = passwordHash;
  user.salt = salt;
  // 修改密码后使其它会话失效
  for (const [sid, session] of Object.entries(data.sessions)) {
    if (session.userId === userId) delete data.sessions[sid];
  }
  save();
}

function getSources({ includeSecrets = false } = {}) {
  return data.sources.map(source => {
    const copy = {
      id: source.id,
      name: source.name,
      adapter: source.adapter,
      baseUrl: source.baseUrl,
      enabled: source.enabled,
      note: source.note,
      alternates: [...(source.alternates || [])],
      health: { ...source.health }
    };
    if (includeSecrets) copy.internal = true;
    return copy;
  });
}

function getSource(id) {
  return data.sources.find(source => source.id === id) || null;
}

function setSourceEnabled(id, enabled) {
  const source = getSource(id);
  if (!source) throw new AppError(404, '数据源不存在', 'NO_SOURCE');
  source.enabled = Boolean(enabled);
  save();
  return source;
}

function updateSourceHealth(id, health) {
  const source = getSource(id);
  if (!source) return null;
  source.health = { ...source.health, ...health };
  save();
  return source;
}

function updateSourceBaseUrl(id, baseUrl) {
  const source = getSource(id);
  if (!source) return null;
  source.baseUrl = baseUrl;
  save();
  return source;
}

function enabledSources() {
  return data.sources.filter(source => source.enabled);
}

function settings() {
  return { ...data.settings };
}

load();
const pruneTimer = setInterval(pruneSessions, 3600000);
if (typeof pruneTimer.unref === 'function') pruneTimer.unref();

module.exports = {
  DATA_DIR,
  DB_FILE,
  get data() { return data; },
  save,
  flush,
  publicUser,
  findUserByName,
  findUserById,
  createUser,
  createSession,
  getSession,
  destroySession,
  userFromSession,
  prefDefaults,
  sanitizeBook,
  getLibrary,
  inLibrary,
  addToLibrary,
  removeFromLibrary,
  getProgress,
  saveHistory,
  getHistory,
  removeHistory,
  clearHistory,
  getBookmarks,
  addBookmark,
  removeBookmark,
  updatePrefs,
  setUserPassword,
  getSources,
  getSource,
  setSourceEnabled,
  updateSourceHealth,
  updateSourceBaseUrl,
  enabledSources,
  settings
};
