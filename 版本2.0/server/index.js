'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const store = require('./store');
const auth = require('./auth');
const sources = require('./sources');
const {
  AppError,
  fail,
  ok,
  err,
  json,
  readJson,
  cookie,
  hashCode,
  assertPublicUrl,
  parseBookKey
} = require('./util');
const { request } = require('./http');

const ROOT = path.join(__dirname, '..');
const WEB_ROOT = path.join(ROOT, 'web');
const IMAGE_CACHE = path.join(store.DATA_DIR, 'cache', 'img');
const HOST = process.env.MOYUE_HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || process.env.MOYUE_PORT || 8737);
const SESSION_MAX_AGE = 30 * 86400;
const STARTED_AT = Date.now();

let version = '1.0.0';
try {
  version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || version;
} catch {}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

const gzipCache = new Map();
const IMAGE_HOSTS = ['qimao.com', 'wtzw.com', 'biquge365.net', 'biquge365.com'];

function log(message) {
  console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`);
}

function setCommonHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
}

function setSessionCookie(res, sid) {
  res.setHeader('Set-Cookie', cookie(auth.COOKIE_NAME, sid, {
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: SESSION_MAX_AGE,
    path: '/'
  }));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', cookie(auth.COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: 0,
    path: '/'
  }));
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const host = req.headers.host;
  if (!host) return;
  if (origin !== `http://${host}` && origin !== `https://${host}`) {
    throw new AppError(403, '跨站请求已被拒绝', 'BAD_ORIGIN');
  }
}

function clientIp(req) {
  return String(req.socket.remoteAddress || 'local').replace(/^::ffff:/, '');
}

function truthy(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function sourceView(source) {
  const adapter = sources.adapters[source.adapter];
  return {
    ...sources.publicSource(source),
    cooldownMs: typeof adapter?.searchCooldown === 'number' ? adapter.searchCooldown : 0
  };
}

function optionalUser(req) {
  return auth.sessionFromRequest(req).user;
}

function requireUser(req) {
  return auth.requireUser(req).user;
}

function alignProgress(progress, book) {
  if (!progress || !Array.isArray(book?.chapters) || !book.chapters.length) return progress;
  const known = book.chapters.some(item => String(item.id) === String(progress.chapterId));
  if (known) return progress;
  // 书源轮换章节 ID 后，用原章节序号/标题把旧进度接回新目录。
  const byIndex = book.chapters[Number(progress.chapterIndex) - 1];
  const byTitle = book.chapters.find(item => item.title && item.title === progress.chapterTitle);
  const target = byIndex || byTitle;
  if (!target) return progress;
  return {
    ...progress,
    chapterId: String(target.id),
    chapterTitle: target.title || progress.chapterTitle,
    chapterIndex: Number(target.index) || progress.chapterIndex
  };
}

function publicBookState(user, book) {
  if (!user) return { signedIn: false, inLibrary: false, progress: null, bookmarkCount: 0 };
  return {
    signedIn: true,
    inLibrary: store.inLibrary(user.id, book.key),
    progress: alignProgress(store.getProgress(user.id, book.key), book),
    bookmarkCount: store.getBookmarks(user.id, book.key).length
  };
}

/* ---------------------------------- 图片代理 --------------------------------- */

function imageHostAllowed(hostname) {
  const host = String(hostname || '').toLowerCase();
  return IMAGE_HOSTS.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
}

async function readCachedImage(hash) {
  try {
    const [buffer, metaRaw] = await Promise.all([
      fsp.readFile(path.join(IMAGE_CACHE, `${hash}.bin`)),
      fsp.readFile(path.join(IMAGE_CACHE, `${hash}.json`), 'utf8')
    ]);
    const meta = JSON.parse(metaRaw);
    if (!meta.type || !meta.type.startsWith('image/')) return null;
    return { buffer, type: meta.type };
  } catch {
    return null;
  }
}

async function storeCachedImage(hash, buffer, type) {
  try {
    await fsp.mkdir(IMAGE_CACHE, { recursive: true });
    const binPath = path.join(IMAGE_CACHE, `${hash}.bin`);
    const metaPath = path.join(IMAGE_CACHE, `${hash}.json`);
    await fsp.writeFile(`${binPath}.tmp`, buffer);
    await fsp.rename(`${binPath}.tmp`, binPath);
    await fsp.writeFile(`${metaPath}.tmp`, JSON.stringify({ type, at: Date.now() }));
    await fsp.rename(`${metaPath}.tmp`, metaPath);
  } catch (error) {
    log(`图片缓存写入失败：${error.message}`);
  }
}

async function handleImage(req, res, url) {
  let raw = String(url.searchParams.get('u') || '').trim();
  if (!raw) fail(400, '缺少图片地址', 'BAD_URL');
  if (!/^https?:\/\//i.test(raw) && /^https?%3a/i.test(raw)) raw = decodeURIComponent(raw);
  const target = await assertPublicUrl(raw);
  if (!imageHostAllowed(target.hostname)) fail(403, '该图片域名不在允许范围内', 'IMAGE_HOST_DENIED');
  const source = url.searchParams.get('s') || '';
  const cacheKey = hashCode(target.href);
  const cached = await readCachedImage(cacheKey);
  if (cached) {
    res.writeHead(200, {
      'Content-Type': cached.type,
      'Content-Length': cached.buffer.length,
      'Cache-Control': 'public, max-age=604800, immutable'
    });
    res.end(req.method === 'HEAD' ? undefined : cached.buffer);
    return;
  }
  const configured = source ? store.getSource(source) : null;
  const referer = configured?.baseUrl ? `${configured.baseUrl}/` : `https://${target.hostname}/`;
  const upstream = await request(target.href, {
    binary: true,
    maxBytes: 6 * 1024 * 1024,
    timeout: 16000,
    headers: {
      Referer: referer,
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
    }
  });
  const type = String(upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/')) fail(502, '目标地址不是图片', 'NOT_IMAGE');
  await storeCachedImage(cacheKey, upstream.buffer, type);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': upstream.buffer.length,
    'Cache-Control': 'public, max-age=604800, immutable'
  });
  res.end(req.method === 'HEAD' ? undefined : upstream.buffer);
}

/* ---------------------------------- 静态文件 --------------------------------- */

function securityHeadersForHtml(res) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; '));
}

function gzipBuffer(filePath, stat, buffer) {
  const key = `${filePath}:${stat.mtimeMs}:${stat.size}`;
  const cached = gzipCache.get(key);
  if (cached) return cached;
  const compressed = zlib.gzipSync(buffer, { level: 6 });
  gzipCache.set(key, compressed);
  if (gzipCache.size > 60) gzipCache.delete(gzipCache.keys().next().value);
  return compressed;
}

async function serveStatic(req, res, pathname) {
  if (!['GET', 'HEAD'].includes(req.method)) {
    err(res, 405, '请求方法不支持', 'METHOD_NOT_ALLOWED');
    return;
  }
  let relative;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    err(res, 400, '地址不正确', 'BAD_PATH');
    return;
  }
  if (relative === '/' || relative === '') relative = '/index.html';
  relative = relative.replace(/^\/+/, '');
  if (relative.includes('\0')) {
    err(res, 400, '地址不正确', 'BAD_PATH');
    return;
  }
  const filePath = path.resolve(WEB_ROOT, relative);
  if (filePath !== WEB_ROOT && !filePath.startsWith(`${WEB_ROOT}${path.sep}`)) {
    err(res, 403, '禁止访问', 'FORBIDDEN');
    return;
  }
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    err(res, 404, '页面不存在', 'NOT_FOUND');
    return;
  }
  if (!stat.isFile()) {
    err(res, 404, '页面不存在', 'NOT_FOUND');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const etag = `"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
    res.end();
    return;
  }
  let body;
  try {
    body = await fsp.readFile(filePath);
  } catch {
    err(res, 500, '读取页面失败', 'READ_FAILED');
    return;
  }
  const compressible = /^(text\/|application\/(json|javascript)|image\/svg)/.test(type) && body.length > 1200;
  const acceptsGzip = String(req.headers['accept-encoding'] || '').includes('gzip');
  const headers = {
    'Content-Type': type,
    ETag: etag,
    'Cache-Control': 'no-cache',
    Vary: 'Accept-Encoding'
  };
  if (ext === '.html') securityHeadersForHtml(res);
  if (compressible && acceptsGzip) {
    body = gzipBuffer(filePath, stat, body);
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

/* ----------------------------------- API ----------------------------------- */

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const method = req.method;
  const q = url.searchParams;

  if (method !== 'GET' && method !== 'HEAD') assertSameOrigin(req);

  if (pathname === '/api/status' && method === 'GET') {
    const user = optionalUser(req);
    ok(res, {
      name: '墨阅',
      version,
      now: Date.now(),
      startedAt: STARTED_AT,
      sourceCount: store.getSources().length,
      enabledCount: store.enabledSources().length,
      allowRegister: Boolean(store.settings().allowRegister),
      signedIn: Boolean(user),
      user: user ? store.publicUser(user) : null
    });
    return;
  }

  if (pathname === '/api/me' && method === 'GET') {
    const user = optionalUser(req);
    ok(res, { user: user ? store.publicUser(user) : null });
    return;
  }

  if (pathname === '/api/auth/register' && method === 'POST') {
    const body = await readJson(req, 32 * 1024);
    const { user, sid } = auth.register({ ...body, ip: clientIp(req) });
    setSessionCookie(res, sid);
    ok(res, { user: store.publicUser(user), prefs: user.prefs });
    return;
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readJson(req, 32 * 1024);
    const { user, sid } = auth.login({ ...body, ip: clientIp(req) });
    setSessionCookie(res, sid);
    ok(res, { user: store.publicUser(user), prefs: user.prefs });
    return;
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    const { sid } = auth.sessionFromRequest(req);
    auth.logout(sid);
    clearSessionCookie(res);
    ok(res, { loggedOut: true });
    return;
  }

  if (pathname === '/api/auth/password' && method === 'POST') {
    const body = await readJson(req, 32 * 1024);
    const result = auth.changePassword(req, { current: body.current, next: body.next });
    setSessionCookie(res, result.sid);
    ok(res, { changed: true });
    return;
  }

  if (pathname === '/api/sources' && method === 'GET') {
    ok(res, { items: store.getSources().map(sourceView) });
    return;
  }

  if (pathname === '/api/sources/toggle' && method === 'POST') {
    requireUser(req);
    const body = await readJson(req, 32 * 1024);
    const source = store.setSourceEnabled(body.id, truthy(body.enabled));
    sources.clearCaches();
    ok(res, { source: sourceView(store.getSource(source.id)) });
    return;
  }

  if (pathname === '/api/sources/test' && method === 'POST') {
    requireUser(req);
    const body = await readJson(req, 32 * 1024);
    const source = store.getSource(body.id);
    if (!source) fail(404, '数据源不存在', 'NO_SOURCE');
    const result = await sources.checkSource(source, { repair: truthy(body.repair) });
    ok(res, { source: { ...result, cooldownMs: sourceView(result).cooldownMs } });
    return;
  }

  if (pathname === '/api/sources/health' && method === 'POST') {
    requireUser(req);
    const body = await readJson(req, 16 * 1024);
    const results = await sources.healthAll({ repair: truthy(body.repair) });
    ok(res, { items: results.map(item => ({ ...item, cooldownMs: sourceView(item).cooldownMs })) });
    return;
  }

  if (pathname === '/api/search' && method === 'GET') {
    const query = q.get('q') || q.get('keyword') || '';
    const result = await sources.searchAll(query, { sourceIds: q.get('sources') || '' });
    ok(res, result);
    return;
  }

  if (pathname === '/api/book' && method === 'GET') {
    const sourceId = q.get('source') || '';
    const bookId = q.get('id') || '';
    const book = await sources.getBook(sourceId, bookId);
    const user = optionalUser(req);
    ok(res, { book, state: publicBookState(user, book) });
    return;
  }

  if (pathname === '/api/chapter' && method === 'GET') {
    const sourceId = q.get('source') || '';
    const bookId = q.get('book') || '';
    const chapterId = q.get('id') || '';
    const result = await sources.getChapter(sourceId, bookId, chapterId);
    const user = optionalUser(req);
    ok(res, {
      ...result,
      state: publicBookState(user, { key: result.book.key })
    });
    return;
  }

  if (pathname === '/api/library' && method === 'GET') {
    const user = requireUser(req);
    const items = store.getLibrary(user.id).map(item => ({
      ...item,
      progress: store.getProgress(user.id, item.key)
    }));
    ok(res, { items });
    return;
  }

  if (pathname === '/api/library' && method === 'POST') {
    const user = requireUser(req);
    const body = await readJson(req, 64 * 1024);
    const item = store.addToLibrary(user.id, body.book);
    ok(res, { item, inLibrary: true });
    return;
  }

  if (pathname === '/api/library' && method === 'DELETE') {
    const user = requireUser(req);
    const key = String(q.get('key') || '');
    if (!parseBookKey(key)) fail(400, '书籍标识不正确', 'BAD_BOOK_KEY');
    store.removeFromLibrary(user.id, key);
    ok(res, { removed: true });
    return;
  }

  if (pathname === '/api/history' && method === 'GET') {
    const user = requireUser(req);
    ok(res, { items: store.getHistory(user.id) });
    return;
  }

  if (pathname === '/api/history' && method === 'POST') {
    const user = requireUser(req);
    const body = await readJson(req, 64 * 1024);
    const record = store.saveHistory(user.id, body);
    ok(res, { record });
    return;
  }

  if (pathname === '/api/history' && method === 'DELETE') {
    const user = requireUser(req);
    if (truthy(q.get('all'))) {
      store.clearHistory(user.id);
      ok(res, { cleared: true });
      return;
    }
    const key = String(q.get('key') || '');
    if (!parseBookKey(key)) fail(400, '书籍标识不正确', 'BAD_BOOK_KEY');
    store.removeHistory(user.id, key);
    ok(res, { removed: true });
    return;
  }

  if (pathname === '/api/bookmarks' && method === 'GET') {
    const user = requireUser(req);
    const key = String(q.get('key') || '');
    ok(res, { items: store.getBookmarks(user.id, key || undefined) });
    return;
  }

  if (pathname === '/api/bookmarks' && method === 'POST') {
    const user = requireUser(req);
    const body = await readJson(req, 64 * 1024);
    ok(res, store.addBookmark(user.id, body));
    return;
  }

  if (pathname === '/api/bookmarks' && method === 'DELETE') {
    const user = requireUser(req);
    const id = String(q.get('id') || '');
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) fail(400, '书签标识不正确', 'BAD_BOOKMARK');
    store.removeBookmark(user.id, id);
    ok(res, { removed: true });
    return;
  }

  if (pathname === '/api/prefs' && (method === 'POST' || method === 'PATCH')) {
    const user = requireUser(req);
    const body = await readJson(req, 32 * 1024);
    const prefs = store.updatePrefs(user.id, body);
    ok(res, { prefs });
    return;
  }

  if (pathname === '/api/img' && (method === 'GET' || method === 'HEAD')) {
    await handleImage(req, res, url);
    return;
  }

  err(res, 404, '接口不存在', 'NOT_FOUND');
}

/* ---------------------------------- 服务器 ---------------------------------- */

const server = http.createServer((req, res) => {
  const started = Date.now();
  setCommonHeaders(res);
  let parsed;
  try {
    parsed = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  } catch {
    err(res, 400, '请求地址不正确', 'BAD_REQUEST');
    return;
  }
  res.on('finish', () => {
    if (parsed.pathname.startsWith('/api/')) {
      log(`${req.method} ${parsed.pathname}${parsed.search ? '?…' : ''} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });
  const work = parsed.pathname.startsWith('/api/')
    ? handleApi(req, res, parsed)
    : serveStatic(req, res, parsed.pathname);
  Promise.resolve(work).catch(error => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof AppError) {
      err(res, error.status, error.message, error.code);
    } else {
      console.error('[server] 未处理异常：', error);
      err(res, 500, '服务器内部错误', 'INTERNAL');
    }
  });
});

server.headersTimeout = 65000;
server.requestTimeout = 120000;
server.keepAliveTimeout = 5000;

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请关闭已运行的墨阅，或设置环境变量 MOYUE_PORT 使用其它端口。`);
    process.exit(1);
  }
  console.error('[server] 监听失败：', error);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : PORT;
  log(`墨阅已启动：http://${HOST}:${actualPort}`);
  if (process.env.MOYUE_PORT_FILE !== '0') {
    try {
      fs.mkdirSync(store.DATA_DIR, { recursive: true });
      fs.writeFileSync(path.join(store.DATA_DIR, 'port.txt'), String(actualPort), 'utf8');
    } catch {}
  }
  if (process.env.MOYUE_SKIP_HEALTH !== '1') {
    const timer = setTimeout(() => {
      sources.healthAll().then(results => {
        const summary = results.map(item => `${item.name}:${item.health.status}`).join(' ');
        log(`数据源自检完成 ${summary}`);
      }).catch(error => log(`数据源自检失败：${error.message}`));
    }, 2500);
    if (typeof timer.unref === 'function') timer.unref();
  }
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  log(`收到 ${signal}，正在退出…`);
  sources.clearCaches();
  store.flush();
  server.close(() => process.exit(0));
  setTimeout(() => {
    try { server.closeAllConnections(); } catch {}
    process.exit(0);
  }, 1200).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', error => {
  console.error('[server] uncaughtException：', error);
});
process.on('unhandledRejection', error => {
  console.error('[server] unhandledRejection：', error);
});
