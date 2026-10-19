'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const dns = require('node:dns');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { request } = require('../server/http');

async function serve(handler, check, host = '127.0.0.1') {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, host, resolve));
  try {
    await check(server.address().port);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('IPv4 search POST has an exact Content-Length and is sent once', async () => {
  let count = 0;
  const body = 's=%E5%89%91%E6%9D%A5&type=articlename';
  await serve(async (req, res) => {
    count += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.headers['content-length'], String(Buffer.byteLength(body)));
    assert.equal(Buffer.concat(chunks).toString(), body);
    res.end('search results');
  }, async port => {
    const result = await request(`http://127.0.0.1:${port}/`, { ipv4: true, method: 'POST', body });
    assert.equal(result.text, 'search results');
    assert.equal(count, 1);
  });
});

test('lenient upstream headers do not cause a duplicate search POST', async () => {
  let count = 0;
  const server = net.createServer(socket => {
    let input = '';
    let answered = false;
    socket.on('data', chunk => {
      input += chunk;
      if (answered || !input.includes('\r\n\r\n')) return;
      answered = true;
      count += 1;
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nX-Test: value\x01\r\nConnection: close\r\n\r\nok');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await request(`http://127.0.0.1:${server.address().port}/`, { ipv4: true, method: 'POST', body: 's=test' });
    assert.equal(result.text, 'ok');
    assert.equal(count, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('read-only request can recover from a stalled response on one IPv4 route', async () => {
  const original = dns.promises.lookup;
  dns.promises.lookup = async () => [{ address: '127.0.0.1', family: 4 }, { address: '127.0.0.2', family: 4 }];
  let count = 0;
  try {
    await serve((req, res) => {
      count += 1;
      if (req.socket.localAddress === '127.0.0.1') { res.writeHead(200); res.flushHeaders(); }
      else res.end('second route works');
    }, async port => {
      const result = await request(`http://route-test.invalid:${port}/`, { ipv4: true, readOnly: true, timeout: 2400 });
      assert.equal(result.text, 'second route works');
      assert.equal(count, 2);
    }, '0.0.0.0');
  } finally {
    dns.promises.lookup = original;
  }
});

test('failed TCP connection falls back to another DNS IPv4 address', async () => {
  const original = dns.promises.lookup;
  dns.promises.lookup = async host => {
    assert.equal(host, 'source-test.invalid');
    return [{ address: '127.0.0.2', family: 4 }, { address: '127.0.0.1', family: 4 }];
  };
  try {
    await serve((req, res) => res.end('reachable'), async port => {
      const result = await request(`http://source-test.invalid:${port}/`, { ipv4: true, timeout: 1000 });
      assert.equal(result.text, 'reachable');
    });
  } finally {
    dns.promises.lookup = original;
  }
});

test('upstream HTTP rejection is not retried as another search POST', async () => {
  let count = 0;
  await serve((req, res) => { count += 1; res.writeHead(405); res.end('blocked'); }, async port => {
    await assert.rejects(request(`http://127.0.0.1:${port}/`, { ipv4: true, method: 'POST', body: 's=test' }), error => error.code === 'UPSTREAM_STATUS');
    assert.equal(count, 1);
  });
});

test('search POST body timeout does not resubmit the processed search', async () => {
  const original = dns.promises.lookup;
  dns.promises.lookup = async () => [{ address: '127.0.0.1', family: 4 }, { address: '127.0.0.2', family: 4 }];
  let count = 0;
  try {
    await serve((req, res) => { count += 1; res.writeHead(200); res.flushHeaders(); }, async port => {
      await assert.rejects(request(`http://post-timeout.invalid:${port}/`, { ipv4: true, method: 'POST', body: 's=test', timeout: 180 }), error => error.code === 'TIMEOUT' || error.code === 'READ_FAILED');
      assert.equal(count, 1);
    }, '0.0.0.0');
  } finally {
    dns.promises.lookup = original;
  }
});

test('response body is covered by the native request timeout', async () => {
  await serve((req, res) => { res.writeHead(200); res.flushHeaders(); }, async port => {
    await assert.rejects(request(`http://127.0.0.1:${port}/`, { ipv4: true, timeout: 120 }), error => error.code === 'TIMEOUT' || error.code === 'READ_FAILED');
  });
});

function adapterReturning(html) {
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../server/sources/biquge365.js'), 'utf8');
  vm.runInNewContext(source, {
    require(name) {
      if (name === '../http') return {
        formBody: values => new URLSearchParams(values).toString(),
        request: async (url, options) => {
          assert.equal(options.ipv4, true);
          assert.equal(options.tlsMaxVersion, 'TLSv1.2');
          if (options.method === 'POST') {
            assert.equal(options.readOnly, false);
            assert.equal(options.attemptTimeout, undefined);
          }
          return typeof html === 'function' ? html(url, options) : { text: html };
        }
      };
      return require(path.join(__dirname, '../server', name.replace('../', '')));
    },
    module, console, URLSearchParams
  });
  return module.exports;
}

test('site rate-limit page reports RATE_LIMIT instead of empty results', async () => {
  const adapter = adapterReturning('<script>alert("搜索间隔15秒,请稍后重新搜索！")</script><ul class="search"><li class="fen">header</li></ul>');
  await assert.rejects(adapter.search('test', { baseUrl: 'https://source.invalid' }), error => error.code === 'RATE_LIMIT' && error.status === 429);
});

test('normal search results still return the original book IDs and titles', async () => {
  const adapter = adapterReturning('<ul class="search"><li><span class="name"><a href="/book/123/">Test book</a></span><span class="zuo">Writer</span></li></ul>');
  const books = await adapter.search('test', { baseUrl: 'https://source.invalid' });
  assert.equal(books.length, 1);
  assert.equal(books[0].bookId, '123');
  assert.equal(books[0].title, 'Test book');
});

test('book metadata and full catalog start together and retain their IDs', async () => {
  const pending = new Map();
  const adapter = adapterReturning((url, options) => new Promise(resolve => pending.set(url, { resolve, options })));
  const result = adapter.detail('123', { baseUrl: 'https://source.invalid' });
  assert.equal(pending.size, 2, 'catalog should not wait for metadata to finish');
  const main = pending.get('https://source.invalid/book/123/');
  const catalog = pending.get('https://source.invalid/newbook/123/');
  assert.equal(main.options.timeout, 40000);
  assert.equal(catalog.options.timeout, 45000);
  catalog.resolve({ text: '<a href="/chapter/123/11.html">第1章</a><a href="/chapter/123/12.html">第2章</a>' });
  main.resolve({ text: '<meta property="og:novel:book_name" content="Test book">' });
  const book = await result;
  assert.equal(book.title, 'Test book');
  assert.equal(book.chapters.length, 2);
  assert.equal(book.chapters[0].id, '11');
});

test('unavailable full catalog still falls back to detail page chapter links', async () => {
  const adapter = adapterReturning(async url => {
    if (url.includes('/newbook/')) throw new Error('catalog unavailable');
    return { text: '<meta property="og:novel:book_name" content="Test book"><a href="/chapter/123/11.html">第1章</a>' };
  });
  const book = await adapter.detail('123', { baseUrl: 'https://source.invalid' });
  assert.equal(book.chapters.length, 1);
  assert.equal(book.chapters[0].id, '11');
});
