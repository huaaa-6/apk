export class ApiError extends Error {
  constructor(message, code = 'ERROR', status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

async function request(path, options = {}) {
  const { method = 'GET', body, query, timeout = 40000 } = options;
  const params = new URLSearchParams();
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') params.set(key, value);
    }
  }
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let response;
  try {
    response = await fetch(`/api${path}${suffix}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timer);
    if (error?.name === 'AbortError') throw new ApiError('请求超时，请稍后重试', 'TIMEOUT_CLIENT', 0);
    throw new ApiError('无法连接本地服务，请确认墨阅仍在运行', 'OFFLINE', 0);
  }
  clearTimeout(timer);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(`服务返回了异常响应（HTTP ${response.status}）`, 'BAD_RESPONSE', response.status);
  }
  if (!payload || payload.ok !== true) {
    throw new ApiError(payload?.error || `请求失败（HTTP ${response.status}）`, payload?.code || 'ERROR', response.status);
  }
  return payload.data;
}

export const api = {
  status: () => request('/status', { timeout: 12000 }),
  me: () => request('/me', { timeout: 12000 }),
  login: (username, password) => request('/auth/login', { method: 'POST', body: { username, password }, timeout: 20000 }),
  register: (payload) => request('/auth/register', { method: 'POST', body: payload, timeout: 20000 }),
  logout: () => request('/auth/logout', { method: 'POST', body: {} }),
  changePassword: (current, next) => request('/auth/password', { method: 'POST', body: { current, next }, timeout: 20000 }),

  sources: () => request('/sources', { timeout: 12000 }),
  toggleSource: (id, enabled) => request('/sources/toggle', { method: 'POST', body: { id, enabled } }),
  testSource: (id, repair = false) => request('/sources/test', { method: 'POST', body: { id, repair }, timeout: 45000 }),
  healthAll: (repair = false) => request('/sources/health', { method: 'POST', body: { repair }, timeout: 90000 }),

  search: (q, sources = '') => request('/search', { query: { q, sources }, timeout: 50000 }),
  book: (source, id) => request('/book', { query: { source, id }, timeout: 60000 }),
  chapter: (source, book, id) => request('/chapter', { query: { source, book, id }, timeout: 45000 }),

  library: () => request('/library', { timeout: 20000 }),
  addLibrary: (book) => {
    // 目录可能有上千章，书架只需要书目信息，避免请求体超出服务端限制。
    const { chapters, ...info } = book || {};
    return request('/library', { method: 'POST', body: { book: info }, timeout: 20000 });
  },
  removeLibrary: (key) => request('/library', { method: 'DELETE', query: { key }, timeout: 20000 }),

  history: () => request('/history', { timeout: 20000 }),
  saveHistory: (record) => request('/history', { method: 'POST', body: record, timeout: 20000 }),
  removeHistory: (key) => request('/history', { method: 'DELETE', query: { key }, timeout: 20000 }),
  clearHistory: () => request('/history', { method: 'DELETE', query: { all: 1 }, timeout: 20000 }),

  bookmarks: (key = '') => request('/bookmarks', { query: { key }, timeout: 20000 }),
  addBookmark: (payload) => request('/bookmarks', { method: 'POST', body: payload, timeout: 20000 }),
  removeBookmark: (id) => request('/bookmarks', { method: 'DELETE', query: { id }, timeout: 20000 }),

  savePrefs: (prefs) => request('/prefs', { method: 'POST', body: prefs, timeout: 15000 })
};
