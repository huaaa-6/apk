'use strict';

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const { AppError } = require('./util');

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function normalizeCharset(value) {
  const charset = String(value || '').toLowerCase().trim();
  if (!charset) return 'utf-8';
  if (['gb2312', 'gbk', 'gb-2312', 'cp936'].includes(charset)) return 'gb18030';
  return charset;
}

function detectCharset(buffer) {
  const head = buffer.subarray(0, 4096).toString('latin1');
  const meta = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i);
  if (meta) return normalizeCharset(meta[1]);
  return 'utf-8';
}

function isLenientNeeded(error) {
  const name = error?.cause?.name || error?.name || '';
  const message = `${error?.message || ''} ${error?.cause?.message || ''}`;
  return name === 'HTTPParserError' || /Unexpected whitespace|HPE_|protocol/i.test(message);
}

function decodeNativeBody(buffer, encoding) {
  const value = String(encoding || '').toLowerCase().trim();
  if (!value || value === 'identity') return buffer;
  try {
    if (value === 'gzip' || value === 'x-gzip') return zlib.gunzipSync(buffer);
    if (value === 'br') return zlib.brotliDecompressSync(buffer);
    if (value === 'deflate') {
      try { return zlib.inflateSync(buffer); } catch { return zlib.inflateRawSync(buffer); }
    }
  } catch {
    throw new AppError(502, '目标站点响应解压失败', 'BAD_ENCODING');
  }
  return buffer;
}

/**
 * 部分中文站点会返回不符合 RFC 的响应头（如头字段前多出空格），
 * undici/fetch 会直接拒绝；这里用 Node 原生客户端并开启宽松解析作为兜底。
 */
function nativeRequest(rawUrl, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeout = 18000,
    maxBytes = 10 * 1024 * 1024,
    charset,
    binary = false,
    allowHttpError = false
  } = options;

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const go = (target, redirects, requestMethod) => {
      let parsed;
      try {
        parsed = new URL(target);
      } catch {
        done(reject, new AppError(502, '目标地址不正确', 'BAD_URL'));
        return;
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        done(reject, new AppError(502, '目标地址不正确', 'BAD_URL'));
        return;
      }
      const transport = parsed.protocol === 'https:' ? https : http;
      const req = transport.request(parsed, {
        method: requestMethod,
        headers: {
          'User-Agent': DEFAULT_UA,
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
          'Accept-Encoding': 'gzip, deflate, br',
          ...headers
        },
        insecureHTTPParser: true
      }, response => {
        const status = response.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location && redirects < 5) {
          const location = new URL(response.headers.location, target).href;
          response.resume();
          const nextMethod = status === 303 || ((status === 301 || status === 302) && requestMethod === 'POST') ? 'GET' : requestMethod;
          go(location, redirects + 1, nextMethod);
          return;
        }
        const chunks = [];
        let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new AppError(502, '目标页面内容过大', 'TOO_LARGE'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', () => done(reject, new AppError(502, '读取目标内容失败', 'READ_FAILED')));
        response.on('end', () => {
          try {
            const buffer = decodeNativeBody(Buffer.concat(chunks), response.headers['content-encoding']);
            if (buffer.length > maxBytes) throw new AppError(502, '目标页面内容过大', 'TOO_LARGE');
            const contentType = String(response.headers['content-type'] || '');
            let text = '';
            if (!binary) {
              const headerCharset = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1];
              const encoding = normalizeCharset(charset || headerCharset || detectCharset(buffer));
              try {
                text = new TextDecoder(encoding).decode(buffer);
              } catch {
                text = buffer.toString('utf8');
              }
            }
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(response.headers)) {
              if (value == null) continue;
              responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : String(value));
            }
            if (status >= 400 && !allowHttpError) {
              const message = status === 404 ? '目标页面不存在'
                : status === 403 ? '目标站点拒绝访问（403）'
                  : `目标站点返回 HTTP ${status}`;
              done(reject, new AppError(status === 404 ? 404 : 502, message, 'UPSTREAM_STATUS'));
              return;
            }
            done(resolve, {
              status,
              ok: status >= 200 && status < 300,
              url: target,
              headers: responseHeaders,
              text,
              buffer
            });
          } catch (error) {
            done(reject, error instanceof AppError ? error : new AppError(502, '读取目标内容失败', 'READ_FAILED'));
          }
        });
      });
      const timer = setTimeout(() => {
        req.destroy(new AppError(504, '目标站点响应超时', 'TIMEOUT'));
      }, timeout);
      if (typeof timer.unref === 'function') timer.unref();
      req.on('close', () => clearTimeout(timer));
      req.on('error', error => {
        clearTimeout(timer);
        if (error instanceof AppError) done(reject, error);
        else if (error?.code === 'ECONNRESET' || error?.code === 'ETIMEDOUT') {
          done(reject, new AppError(504, '目标站点响应超时', 'TIMEOUT'));
        } else {
          done(reject, new AppError(502, '无法连接目标站点', 'NETWORK'));
        }
      });
      if (body != null && requestMethod !== 'GET' && requestMethod !== 'HEAD') req.write(body);
      req.end();
    };

    go(rawUrl, 0, method);
  });
}

/**
 * 轻量 HTTP 客户端：伪装 UA、超时、限制体积、自动识别 GBK 编码。
 * @returns {Promise<{status:number, ok:boolean, url:string, headers:Headers, text:string, buffer:Buffer}>}
 */
async function request(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeout = 18000,
    maxBytes = 10 * 1024 * 1024,
    charset,
    binary = false,
    allowHttpError = false
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeout);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        'User-Agent': DEFAULT_UA,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
        ...headers
      },
      body,
      redirect: 'follow',
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timer);
    if (isLenientNeeded(error)) return nativeRequest(url, options);
    if (error?.name === 'AbortError' || /timeout/i.test(error?.message || '') || error?.cause?.code === 'ETIMEDOUT') {
      throw new AppError(504, '目标站点响应超时', 'TIMEOUT');
    }
    throw new AppError(502, '无法连接目标站点', 'NETWORK');
  }
  clearTimeout(timer);

  const length = Number(response.headers.get('content-length') || 0);
  if (length && length > maxBytes) {
    throw new AppError(502, '目标页面内容过大', 'TOO_LARGE');
  }

  let buffer;
  try {
    buffer = Buffer.from(await response.arrayBuffer());
  } catch {
    throw new AppError(502, '读取目标内容失败', 'READ_FAILED');
  }
  if (buffer.length > maxBytes) {
    throw new AppError(502, '目标页面内容过大', 'TOO_LARGE');
  }

  const contentType = response.headers.get('content-type') || '';
  let text = '';
  if (!binary) {
    const headerCharset = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1];
    const encoding = normalizeCharset(charset || headerCharset || detectCharset(buffer));
    try {
      text = new TextDecoder(encoding).decode(buffer);
    } catch {
      text = buffer.toString('utf8');
    }
  }

  if (!response.ok && !allowHttpError) {
    const status = response.status;
    const message = status === 404 ? '目标页面不存在' : status === 403 ? '目标站点拒绝访问（403）' : `目标站点返回 HTTP ${status}`;
    throw new AppError(status === 404 ? 404 : 502, message, 'UPSTREAM_STATUS');
  }

  return {
    status: response.status,
    ok: response.ok,
    url: response.url,
    headers: response.headers,
    text,
    buffer
  };
}

async function fetchJson(url, options = {}) {
  const res = await request(url, {
    ...options,
    headers: {
      Accept: 'application/json, text/plain, */*',
      ...(options.headers || {})
    }
  });
  const text = res.text.replace(/^\uFEFF/, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(502, '目标站点返回了无法解析的数据', 'BAD_UPSTREAM_JSON');
  }
}

function formBody(data) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) params.append(key, value == null ? '' : String(value));
  return params.toString();
}

module.exports = { request, fetchJson, formBody, DEFAULT_UA, normalizeCharset };
