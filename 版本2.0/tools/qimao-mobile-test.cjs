'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createCipheriv } = require('node:crypto');
const { AppError } = require('../server/util');

const source = { id: 'qimao', baseUrl: 'https://www.qimao.com' };

function adapterWith(fetchJson) {
  function load(name, overrides) {
    const filename = path.join(__dirname, '../server/sources', name);
    const mod = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module: mod, console, URL, URLSearchParams, Intl, Buffer, TextDecoder,
      require(id) {
        if (Object.hasOwn(overrides, id)) return overrides[id];
        return require(id.startsWith('.') ? path.resolve(path.dirname(filename), id) : id);
      }
    }, { filename });
    return mod.exports;
  }
  const mobile = load('qimao-mobile.js', { '../http': { fetchJson } });
  return load('qimao.js', { './qimao-mobile': mobile });
}

function encryptedChapter(text, id = '101') {
  const iv = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  const cipher = createCipheriv('aes-128-cbc', Buffer.from('242ccb8230d709e1'), iv);
  return { data: { id, content: Buffer.concat([iv, cipher.update(text), cipher.final()]).toString('base64') } };
}

test('search uses signed mobile requests and preserves keyword, IDs and title text', async () => {
  const adapter = adapterWith(async (rawUrl, options) => {
    const url = new URL(rawUrl);
    assert.equal(url.origin, 'https://api-bc.wtzw.com');
    assert.equal(url.pathname, '/search/v1/words');
    assert.equal(url.searchParams.get('wd'), '中文 & + search');
    assert.equal(url.searchParams.get('page'), '1');
    assert.match(url.searchParams.get('sign'), /^[a-f0-9]{32}$/);
    assert.match(options.headers.sign, /^[a-f0-9]{32}$/);
    assert.notEqual(url.searchParams.get('sign'), options.headers.sign);
    assert.equal(options.headers.platform, 'android');
    assert.equal(options.headers.AUTHORIZATION, '');
    return { data: { books: [{ id: '12345678901234567', title: '<b>测试</b>', author: '<i>作者</i>', image_link: '//cdn.example/cover.jpg', sub_title: '连载・25万字', is_over: '0' }] } };
  });
  const result = await adapter.search('中文 & + search', source);
  assert.equal(result[0].bookId, '12345678901234567');
  assert.equal(result[0].source, 'qimao');
  assert.equal(result[0].title, '测试');
  assert.equal(result[0].author, '作者');
  assert.equal(result[0].cover, 'https://cdn.example/cover.jpg');
  assert.equal(result[0].words, '25万字');
  assert.equal(result[0].status, '连载中');
});

test('mobile book and catalog run together and retain the existing reader data format', async () => {
  const pending = new Map();
  const adapter = adapterWith((url, options) => new Promise(resolve => pending.set(new URL(url).pathname, { url: new URL(url), options, resolve })));
  const result = adapter.detail('123', source);
  assert.equal(pending.size, 2);
  const main = pending.get('/api/v4/book/detail');
  const catalog = pending.get('/api/v1/chapter/chapter-list');
  assert.equal(main.url.hostname, 'api-bc.wtzw.com');
  assert.equal(catalog.url.hostname, 'api-ks.wtzw.com');
  assert.equal(main.url.searchParams.get('id'), '123');
  assert.equal(catalog.url.searchParams.get('id'), '123');
  catalog.resolve({ data: { chapter_lists: [
    { id: '102', title: '第二章', chapter_sort: 2, words: '2000', is_vip: '1' },
    { id: '101', title: '第一章', chapter_sort: 1, words: '1000', is_vip: '0' }
  ] } });
  main.resolve({ data: { book: { id: '123', title: '测试', author: '作者', intro: '<p>简介</p>', category2_name: '分类', words_num: '13059574', update_time: '1704038400', is_over: '1' } } });
  const book = await result;
  assert.equal(book.source, 'qimao');
  assert.equal(book.bookId, '123');
  assert.equal(book.intro, '简介');
  assert.equal(book.category, '分类');
  assert.equal(book.words, '1305.96 万字');
  assert.equal(book.updatedAt, '2024-01-01');
  assert.equal(book.status, '已完结');
  assert.equal(book.chapters.length, 2);
  assert.equal(book.chapters[0].id, '101');
  assert.equal(book.chapters[0].index, 1);
  assert.equal(book.chapters[0].words, 1000);
  assert.equal(book.chapters[0].vip, false);
  assert.equal(book.chapters[1].vip, true);
});

test('invalid search response is an error instead of a successful empty result', async () => {
  const adapter = adapterWith(async () => ({ data: { books: {} } }));
  await assert.rejects(adapter.search('test', source), error => error.code === 'BAD_UPSTREAM_DATA');
});

test('a valid no-match response returns no books', async () => {
  const adapter = adapterWith(async () => ({ data: { books: null } }));
  assert.equal((await adapter.search('no matching book', source)).length, 0);
});

test('missing mobile data is rejected rather than cached as an empty result', async () => {
  const adapter = adapterWith(async () => ({ message: 'access denied' }));
  await assert.rejects(adapter.search('test', source), error => error.code === 'BAD_UPSTREAM_DATA');
});

test('invalid catalog does not turn into a book with an empty chapter list', async () => {
  const adapter = adapterWith(async url => new URL(url).hostname === 'api-bc.wtzw.com'
    ? { data: { book: { id: '123', title: 'Test' } } }
    : { data: { chapter_lists: null } });
  await assert.rejects(adapter.detail('123', source), error => error.code === 'BAD_UPSTREAM_DATA');
});

test('missing book remains NO_BOOK', async () => {
  const adapter = adapterWith(async url => new URL(url).hostname === 'api-bc.wtzw.com'
    ? { data: { book: null } } : { data: { chapter_lists: [] } });
  await assert.rejects(adapter.detail('123', source), error => error.code === 'NO_BOOK');
});

test('health checks the mobile search and identifies the mobile source', async () => {
  const adapter = adapterWith(async (url, options) => {
    assert.equal(new URL(url).hostname, 'api-bc.wtzw.com');
    assert.equal(options.timeout, 12000);
    return { data: { books: [{ id: '123', title: 'Test' }] } };
  });
  const result = await adapter.probe(source);
  assert.match(result.message, /移动端搜索接口正常/);
  assert.equal(result.detail, '七猫移动端');
});

test('chapter reading decodes a single mobile chapter into reader paragraphs', async () => {
  let requests = 0;
  const adapter = adapterWith(async (rawUrl, options) => {
    requests++;
    const url = new URL(rawUrl);
    assert.equal(url.origin, 'https://api-ks.wtzw.com');
    assert.equal(url.pathname, '/api/v1/chapter/content');
    assert.equal(url.searchParams.get('id'), '123');
    assert.equal(url.searchParams.get('chapterId'), '101');
    assert.match(url.searchParams.get('sign'), /^[a-f0-9]{32}$/);
    assert.equal(options.timeout, 20000);
    assert.equal(options.maxBytes, 2 * 1024 * 1024);
    return encryptedChapter('第一段，中文。\r\n\r\n第二段。');
  });
  const result = await adapter.chapter('123', '101', source);
  assert.equal(requests, 1);
  assert.equal(result.id, '101');
  assert.equal(result.paragraphs.length, 2);
  assert.equal(result.paragraphs[0], '第一段，中文。');
  assert.equal(result.paragraphs[1], '第二段。');
  assert.equal(result.text, '第一段，中文。\n\n第二段。');
  assert.equal(result.words, '第一段，中文。第二段。'.length);
});

test('an upstream chapter rejection propagates without retrying the website', async () => {
  const adapter = adapterWith(async () => {
    throw new AppError(502, '目标站点返回 HTTP 403', 'UPSTREAM_STATUS');
  });
  await assert.rejects(adapter.chapter('123', '101', source), error => error.code === 'UPSTREAM_STATUS');
});

test('a response for the wrong chapter cannot be returned under the requested ID', async () => {
  const adapter = adapterWith(async () => encryptedChapter('正文', '999'));
  await assert.rejects(adapter.chapter('123', '101', source), error => error.code === 'BAD_UPSTREAM_DATA');
});

test('invalid encrypted content is rejected instead of rendering unreadable text', async () => {
  for (const content of ['not-base64!!', Buffer.alloc(16).toString('base64')]) {
    const adapter = adapterWith(async () => ({ data: { id: '101', content } }));
    await assert.rejects(adapter.chapter('123', '101', source), error => error.code === 'BAD_CHAPTER_CONTENT');
  }
  const invalidUtf8 = adapterWith(async () => encryptedChapter(Buffer.from([0xff, 0xfe, 0x00])));
  await assert.rejects(invalidUtf8.chapter('123', '101', source), error => error.code === 'BAD_CHAPTER_CONTENT');
});

test('empty decrypted content remains an empty chapter error', async () => {
  const adapter = adapterWith(async () => encryptedChapter(' \n\t'));
  await assert.rejects(adapter.chapter('123', '101', source), error => error.code === 'EMPTY_CHAPTER');
});

test('payment and login requirements remain explicit errors', async () => {
  const paid = adapterWith(async () => ({ errors: { details: '本章需要购买或订阅' } }));
  await assert.rejects(paid.chapter('123', '101', source), error => error.code === 'VIP_CHAPTER' && error.status === 402);
  const login = adapterWith(async () => ({ errors: { details: '请先登录' } }));
  await assert.rejects(login.chapter('123', '101', source), error => error.code === 'UPSTREAM_AUTH');
});
