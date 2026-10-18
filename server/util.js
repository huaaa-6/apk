'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const dns = require('node:dns').promises;

class AppError extends Error {
  constructor(status, message, code = 'ERROR') {
    super(message);
    this.status = status;
    this.code = code;
    this.expose = status < 500;
  }
}

function fail(status, message, code) {
  throw new AppError(status, message, code);
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, Number(n) || 0));
}

function hashCode(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

function ok(res, data, status = 200) {
  json(res, status, { ok: true, data });
}

function err(res, status, message, code = 'ERROR') {
  json(res, status, { ok: false, error: message, code });
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, '请求内容过大', 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req, limit = 1024 * 1024) {
  const raw = await readBody(req, limit);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    fail(400, '请求格式不正确', 'BAD_JSON');
  }
}

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

function cookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge != null) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  parts.push(`Path=${options.path || '/'}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  parts.push(`SameSite=${options.sameSite || 'Lax'}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', middot: '·', times: '×',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', copy: '©', reg: '®'
};

function decodeEntities(input = '') {
  return String(input).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] && body[1].toLowerCase() === 'x';
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return match; }
      }
      return match;
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : match;
  });
}

function stripTags(input = '') {
  return decodeEntities(String(input).replace(/<[^>]*>/g, ''));
}

function cleanLine(input = '') {
  return decodeEntities(String(input))
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\t\f\v\u3000 ]+/g, ' ')
    .trim();
}

function htmlToText(html = '', { keepParagraphs = true } = {}) {
  let text = String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|section|article|tr)>/gi, '\n')
    .replace(/<(p|div|h[1-6]|li|blockquote|section|article|tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  text = decodeEntities(text).replace(/\r\n?/g, '\n');
  const lines = text.split('\n').map(cleanLine).filter(line => line.length > 0);
  return keepParagraphs ? lines.join('\n') : lines.join(' ');
}

function toParagraphs(html = '') {
  return htmlToText(html)
    .split('\n')
    .map(cleanLine)
    .filter(Boolean);
}

function normalizeText(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[《》〈〉「」『』【】\s\u3000·•:：,，。.!！?？;；'"“”‘’\-—_～~()（）\[\]]/g, '');
}

function bookKey(source, bookId) {
  return `${source}:${bookId}`;
}

function parseBookKey(key = '') {
  const index = String(key).indexOf(':');
  if (index <= 0) return null;
  return { source: key.slice(0, index), bookId: key.slice(index + 1) };
}

function absoluteUrl(base, path) {
  if (!path) return '';
  try {
    return new URL(path, base).toString();
  } catch {
    return path;
  }
}

function isPrivateIp(ip) {
  if (!ip) return true;
  const version = net.isIP(ip);
  if (version === 4) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 192 && b === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }
  if (version === 6) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    if (v.startsWith('fc') || v.startsWith('fd')) return true;
    if (v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true;
    if (v.startsWith('ff')) return true;
    if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
    return false;
  }
  return true;
}

async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(400, '图片地址不正确', 'BAD_URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) fail(400, '图片地址不正确', 'BAD_URL');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    fail(400, '该地址不可访问', 'PRIVATE_URL');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) fail(400, '该地址不可访问', 'PRIVATE_URL');
    return url;
  }
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    fail(502, '图片地址解析失败', 'DNS_FAILED');
  }
  if (!addresses.length || addresses.some(item => isPrivateIp(item.address))) {
    fail(400, '该地址不可访问', 'PRIVATE_URL');
  }
  return url;
}

function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value || '');
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)} 亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`;
  return String(Math.round(n));
}

function pick(obj, keys, fallback = '') {
  for (const key of keys) {
    const value = key.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return fallback;
}

module.exports = {
  AppError,
  fail,
  clamp,
  hashCode,
  randomId,
  sleep,
  json,
  ok,
  err,
  readBody,
  readJson,
  parseCookies,
  cookie,
  decodeEntities,
  stripTags,
  cleanLine,
  htmlToText,
  toParagraphs,
  normalizeText,
  bookKey,
  parseBookKey,
  absoluteUrl,
  assertPublicUrl,
  formatNumber,
  pick
};
