'use strict';

// Mobile protocol adapted from shing-yu / StarEdge Studio's swiftcat-downloader-flutter.
// Reference commit: 1aad711316d065ac08dd6ec6b53c2c388b9b9529, lib/core/api_client.dart.
// Modified 2026-10-18: Node client for search, metadata, catalog and single chapters.
// This component is licensed under SSLA v1.0; see qimao-mobile.LICENSE.txt.
const { createHash, createDecipheriv } = require('node:crypto');
const { fetchJson } = require('../http');
const { AppError } = require('../util');

const BOOK_API = 'https://api-bc.wtzw.com';
const CATALOG_API = 'https://api-ks.wtzw.com';
const SIGN_KEY = 'd3dGiJc651gSQ8w1';
const CONTENT_KEY = Buffer.from('32343263636238323330643730396531', 'hex');

function signature(values) {
  const input = Object.keys(values).sort().map(key => `${key}=${values[key]}`).join('');
  return createHash('md5').update(input + SIGN_KEY, 'utf8').digest('hex');
}

async function get(base, pathname, params, options = {}) {
  const headers = {
    AUTHORIZATION: '',
    'app-version': '73720',
    'application-id': 'com.****.reader',
    channel: 'unknown',
    'net-env': '1',
    platform: 'android',
    'qm-params': '',
    reg: '0'
  };
  headers.sign = signature(headers);
  const url = new URL(pathname, base);
  url.search = new URLSearchParams({ ...params, sign: signature(params) }).toString();
  const payload = await fetchJson(url.href, {
    timeout: options.timeout || 15000,
    maxBytes: options.maxBytes || 8 * 1024 * 1024,
    headers
  });
  if (!payload?.data || typeof payload.data !== 'object') {
    const message = String(payload?.errors?.details || payload?.message || '');
    if (options.chapter && /付费|订阅|购买|VIP/i.test(message)) {
      throw new AppError(402, '这一章需要付费，暂时无法免费阅读', 'VIP_CHAPTER');
    }
    if (options.chapter && /登录|授权|认证/.test(message)) {
      throw new AppError(502, '七猫要求登录后才能读取这一章', 'UPSTREAM_AUTH');
    }
    throw new AppError(502, '七猫移动端接口未返回有效数据', 'BAD_UPSTREAM_DATA');
  }
  return payload.data;
}

async function search(keyword, options) {
  const data = await get(BOOK_API, '/search/v1/words', {
    extend: '', tab: '0', gender: '0', refresh_state: '8', page: '1',
    wd: keyword, is_short_story_user: '0'
  }, options);
  if (data.books == null) return [];
  if (!Array.isArray(data.books)) {
    throw new AppError(502, '七猫返回的搜索结果格式异常', 'BAD_UPSTREAM_DATA');
  }
  return data.books;
}

async function book(id) {
  const data = await get(BOOK_API, '/api/v4/book/detail', { id, imei_ip: '2937357107', teeny_mode: '0' });
  if (!data.book || typeof data.book !== 'object' || !data.book.id) {
    throw new AppError(404, '没有找到这本书', 'NO_BOOK');
  }
  return data.book;
}

async function catalog(id) {
  const data = await get(CATALOG_API, '/api/v1/chapter/chapter-list', { chapter_ver: '0', id }, { timeout: 25000 });
  if (!Array.isArray(data.chapter_lists)) {
    throw new AppError(502, '七猫返回的目录格式异常', 'BAD_UPSTREAM_DATA');
  }
  return data.chapter_lists;
}

async function chapter(bookId, chapterId) {
  const data = await get(CATALOG_API, '/api/v1/chapter/content', { id: bookId, chapterId }, {
    timeout: 20000, maxBytes: 2 * 1024 * 1024, chapter: true
  });
  if (data.id != null && String(data.id) !== String(chapterId)) {
    throw new AppError(502, '七猫返回的章节标识不匹配', 'BAD_UPSTREAM_DATA');
  }
  if (typeof data.content !== 'string' || !data.content.trim()) {
    throw new AppError(502, '这一章的正文暂时没有取到，请稍后重试', 'EMPTY_CHAPTER');
  }
  let text;
  try {
    const encoded = data.content.replace(/\s/g, '');
    if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Invalid base64');
    const packed = Buffer.from(encoded, 'base64');
    if (packed.length < 32 || (packed.length - 16) % 16 !== 0) throw new Error('Invalid encrypted content');
    const decipher = createDecipheriv('aes-128-cbc', CONTENT_KEY, packed.subarray(0, 16));
    const decoded = Buffer.concat([decipher.update(packed.subarray(16)), decipher.final()]);
    text = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
    if (text.includes('\u0000')) throw new Error('Unsupported chapter content');
  } catch {
    throw new AppError(502, '七猫正文解码失败，请稍后重试', 'BAD_CHAPTER_CONTENT');
  }
  return { id: String(chapterId), title: data.title || data.chapter_title || '', text };
}

module.exports = { search, book, catalog, chapter };
