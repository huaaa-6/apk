#!/usr/bin/env node
/**
 * 墨阅 UI 冒烟测试
 * 用无头 Edge + CDP 走一遍真实用户路径：首页、寻书、详情、阅读、注册、书架、书签、书源、设置、移动端。
 * 运行：node tools/ui-test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE = process.env.MOYUE_URL || 'http://127.0.0.1:8899';
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DEBUG_PORT = Number(process.env.CDP_PORT || 9333);
const SHOTS = path.join(ROOT, 'screenshots');
const PROFILE = path.join(os.tmpdir(), `moyue-ui-${Date.now()}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

fs.mkdirSync(SHOTS, { recursive: true });

const failures = [];
const notes = [];
const consoleErrors = [];
const networkErrors = [];

function record(name, error) {
  failures.push({ name, error: error?.stack || String(error) });
  process.stdout.write(`  ✗ ${name}\n    ${error?.message || error}\n`);
}
function pass(name, detail = '') {
  process.stdout.write(`  ✓ ${name}${detail ? ` — ${detail}` : ''}\n`);
  notes.push(`${name}${detail ? `: ${detail}` : ''}`);
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', event => reject(new Error(`CDP 连接失败：${event.message || 'unknown'}`)), { once: true });
    });
    this.ws.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
        else resolve(message.result);
        return;
      }
      if (message.method) {
        for (const fn of this.listeners.get(message.method) || []) fn(message.params);
      }
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, 45000);
    });
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}

async function waitJson(url, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {}
    await sleep(220);
  }
  throw new Error(`无法连接浏览器调试端口：${url}`);
}

async function main() {
  if (!fs.existsSync(EDGE)) throw new Error(`没有找到 Edge：${EDGE}`);
  const browser = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--window-size=1440,1000',
    'about:blank'
  ], { stdio: 'ignore', windowsHide: true });

  let cdp;
  try {
    await waitJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    const targets = await waitJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
    const page = targets.find(target => target.type === 'page');
    assert(page, '没有找到浏览器页面');
    cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.ready;

    cdp.on('Runtime.exceptionThrown', params => {
      consoleErrors.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || '未知异常');
    });
    cdp.on('Runtime.consoleAPICalled', params => {
      if (params.type !== 'error') return;
      const text = (params.args || []).map(arg => arg.value || arg.description || '').join(' ');
      if (text) consoleErrors.push(text);
    });
    cdp.on('Log.entryAdded', params => {
      const entry = params.entry;
      if (!entry) return;
      if (entry.level === 'error') {
        if (entry.source === 'network') networkErrors.push(`${entry.url || ''} ${entry.text || ''}`);
        else consoleErrors.push(entry.text || '');
      }
    });

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

    const evaluate = async (expression) => {
      const result = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || '页面脚本异常');
      }
      return result.result?.value;
    };

    const waitFor = async (expression, timeout = 20000, label = expression) => {
      const deadline = Date.now() + timeout;
      let lastError = null;
      while (Date.now() < deadline) {
        try {
          if (await evaluate(expression)) return true;
        } catch (error) {
          lastError = error;
        }
        await sleep(200);
      }
      throw new Error(`等待超时：${label}${lastError ? `（${lastError.message}）` : ''}`);
    };

    const navigate = async (hash, readyExpression, timeout = 25000) => {
      await evaluate(`location.hash = ${JSON.stringify(hash)}`);
      if (readyExpression) await waitFor(readyExpression, timeout, `${hash} 渲染`);
      await sleep(180);
    };

    const click = async (selector) => {
      const clicked = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return false;
        element.click();
        return true;
      })()`);
      assert(clicked, `找不到可点击元素：${selector}`);
      await sleep(160);
    };

    const text = selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText || ''`);
    const count = selector => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);

    const shot = async name => {
      await evaluate('document.fonts.ready.then(() => true)').catch(() => {});
      await sleep(250);
      const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const file = path.join(SHOTS, `${name}.png`);
      fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
      return file;
    };

    const run = async (name, fn) => {
      process.stdout.write(`• ${name}\n`);
      try {
        const detail = await fn();
        pass(name, detail || '');
      } catch (error) {
        record(name, error);
      }
    };

    await run('打开首页', async () => {
      await cdp.send('Page.navigate', { url: `${BASE}/` });
      await waitFor(`!!document.querySelector('.hero-copy h1')`, 30000, '首页 hero');
      const heading = await text('.hero-copy h1');
      assert(heading.includes('一盏灯'), `首页标题异常：${heading}`);
      const navs = await count('.side-nav .nav-link');
      assert(navs >= 5, `侧栏入口不足：${navs}`);
      assert(await count('.fatal-card') === 0, '出现致命错误页');
      await shot('01-home');
      return `「${heading.replace(/\n/g, ' ')}」 · ${navs} 个入口`;
    });

    await run('聚合并展示搜索结果', async () => {
      await navigate('#/search?q=' + encodeURIComponent('剑来'), `document.querySelectorAll('.result-card').length > 0`, 45000);
      const cards = await count('.result-card');
      const title = await text('.result-card .result-title-row h3');
      assert(cards > 0, '没有搜索结果');
      await shot('02-search');
      return `${cards} 组结果，首条《${title}》`;
    });

    let bookHash = '';
    let bookTitle = '';
    await run('打开书籍详情', async () => {
      await click('.result-card .result-title-row h3 a');
      await waitFor(`!!document.querySelector('.book-hero h1')`, 30000, '书籍详情');
      bookTitle = await text('.book-hero h1');
      const chapters = await count('.chapter-chip');
      assert(bookTitle.length > 0, '书名为空');
      assert(chapters > 0, '目录为空');
      bookHash = await evaluate('location.hash');
      await shot('03-book');
      return `《${bookTitle}》 · ${chapters} 个章节入口`;
    });

    await run('游客进入阅读器并切换护眼主题', async () => {
      assert(bookHash, '前置详情未成功');
      await click('.book-actions a.btn-primary');
      await waitFor(`!!document.querySelector('.reader')`, 20000, '阅读器');
      await waitFor(`document.querySelectorAll('.reader-content p').length > 3
        && document.querySelector('.reader-chapter-title')?.innerText !== '正在取书'`, 30000, '章节正文');
      const paragraphs = await count('.reader-content p');
      const title = await text('.reader-chapter-title');
      await shot('04-reader-paper');
      assert(paragraphs > 3, `正文段落过少：${paragraphs}`);
      await click('[data-settings]');
      await waitFor(`document.querySelector('.reader-settings-panel').classList.contains('is-open')`, 4000, '设置面板');
      await click('.theme-chip-night');
      await sleep(350);
      const theme = await evaluate(`document.querySelector('.reader').dataset.readerTheme`);
      assert(theme === 'night', `主题未切换：${theme}`);
      await shot('05-reader-night');
      await click('[data-close-panel]');
      return `${paragraphs} 段 · ${title}`;
    });

    await run('阅读器翻到下一章', async () => {
      const before = await text('.reader-chapter-title');
      const beforeMeta = await text('.reader-chapter-meta');
      const disabled = await evaluate(`document.querySelector('[data-next]').disabled`);
      assert(!disabled, '下一章按钮不可用');
      await click('[data-next]');
      await waitFor(`(() => {
        const title = document.querySelector('.reader-chapter-title')?.innerText || '';
        return title && title !== '正在取书' && title !== ${JSON.stringify(before)}
          && document.querySelectorAll('.reader-content p').length > 0
          && document.querySelector('.reader-chapter-meta')?.innerText !== ${JSON.stringify(beforeMeta)};
      })()`, 30000, '下一章正文加载');
      const after = await text('.reader-chapter-title');
      const meta = await text('.reader-chapter-meta');
      assert(after && after !== before, '章节没有变化');
      assert(meta.includes('第 2 /'), `章节序号异常：${meta}`);
      return `${before} → ${after}（${meta.split('·')[0].trim()}）`;
    });

    await run('游客收藏触发登录门槛', async () => {
      await click('[data-back]');
      await waitFor(`!!document.querySelector('.book-hero h1')`, 15000, '返回详情');
      await click('[data-action="toggle-shelf"]');
      await waitFor(`location.hash.startsWith('#/login')`, 8000, '跳转登录');
      await shot('06-login');
      return await evaluate('location.hash');
    });

    const username = `阅友${String(Date.now()).slice(-7)}`;
    const password = 'moyue123';
    await run('注册新账号并回到书籍', async () => {
      const nextPath = bookHash.replace(/^#/, '');
      await navigate('#/login?tab=register&next=' + encodeURIComponent(nextPath), `!!document.querySelector('#auth-form')`, 12000);
      await evaluate(`(() => {
        const form = document.querySelector('#auth-form');
        const set = (name, value) => {
          const input = form.elements[name];
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set('username', ${JSON.stringify(username)});
        set('displayName', '试读者');
        set('password', ${JSON.stringify(password)});
        set('confirm', ${JSON.stringify(password)});
        form.requestSubmit();
        return true;
      })()`);
      await waitFor(`location.hash.startsWith('#/book/')`, 20000, '注册后返回书籍');
      await waitFor(`!!document.querySelector('.book-hero h1')`, 20000, '书籍重绘');
      const signed = await evaluate(`!!document.querySelector('.topbar-user')`);
      assert(signed, '注册后未显示登录状态');
      await shot('07-book-signed-in');
      return username;
    });

    await run('收入书架并查看书架', async () => {
      await click('[data-action="toggle-shelf"]');
      await waitFor(`document.querySelector('[data-action="toggle-shelf"]')?.innerText.includes('已在书架')`, 12000, '书架状态');
      await navigate('#/shelf', `document.querySelectorAll('.book-card').length > 0`, 12000);
      const shelfTitle = await text('.book-card .book-card-top h3');
      assert(shelfTitle.includes(bookTitle.slice(0, 4)), `书架书目异常：${shelfTitle}`);
      await shot('08-shelf');
      return shelfTitle;
    });

    await run('阅读并断点续读', async () => {
      await navigate(bookHash, `!!document.querySelector('.book-actions a.btn-primary')`, 25000);
      await click('.book-actions a.btn-primary');
      await waitFor(`document.querySelectorAll('.reader-content p').length > 3
        && document.querySelector('.reader-chapter-title')?.innerText !== '正在取书'`, 30000, '正文');
      await evaluate(`(() => { const scroller = document.querySelector('.reader-scroll'); scroller.scrollTop = scroller.scrollHeight * 0.5; scroller.dispatchEvent(new Event('scroll')); return scroller.scrollTop; })()`);
      await sleep(2400);
      const savedPercent = await evaluate(`document.querySelector('[data-percent-text]').innerText`);
      await click('[data-back]');
      await waitFor(`!!document.querySelector('.book-hero h1')`, 15000, '返回详情');
      await waitFor(`document.querySelector('.book-actions a.btn-primary')?.innerText.includes('继续阅读')`, 12000, '继续阅读按钮');
      await click('.book-actions a.btn-primary');
      await waitFor(`document.querySelectorAll('.reader-content p').length > 0`, 30000, '续读正文');
      await sleep(700);
      const scrollTop = await evaluate(`document.querySelector('.reader-scroll').scrollTop`);
      assert(scrollTop > 80, `续读位置未恢复：${scrollTop}`);
      await shot('09-reader-resume');
      return `保存进度 ${savedPercent}，恢复位置 ${Math.round(scrollTop)}px`;
    });

    await run('添加书签并查看', async () => {
      await click('[data-bookmark]');
      await waitFor(`[...document.querySelectorAll('.toast')].some(item => item.innerText.includes('书签'))`, 10000, '书签提示');
      await navigate('#/bookmarks', `document.querySelectorAll('.bookmark-card').length > 0`, 12000);
      const quote = await text('.bookmark-quote p');
      await shot('10-bookmarks');
      return (quote || '书签').slice(0, 18);
    });

    await run('源体检与单源测试', async () => {
      await navigate('#/sources', `document.querySelectorAll('.source-card').length > 0`, 12000);
      const cards = await count('.source-card');
      assert(cards >= 2, `书源卡片不足：${cards}`);
      await click('.source-card [data-action="test-source"]');
      await waitFor(`[...document.querySelectorAll('.toast')].some(item => item.innerText.includes('七猫'))`, 15000, '单源体检提示');
      await shot('11-sources');
      return `${cards} 处书源`;
    });

    await run('设置页与阅读偏好', async () => {
      await navigate('#/settings', `!!document.querySelector('.settings-grid')`, 10000);
      const account = await text('.settings-account h3');
      assert(account.includes('试读者') || account.length > 0, '账号信息缺失');
      await click('[data-pref="readerTheme"][data-value="green"]');
      await sleep(400);
      const active = await evaluate(`document.querySelector('[data-pref="readerTheme"][data-value="green"]').classList.contains('is-active')`);
      assert(active, '偏好未选中');
      await shot('12-settings');
      return `账号 ${account} · 豆绿主题`;
    });

    await run('足迹与移动端布局', async () => {
      await navigate('#/history', `!!document.querySelector('.history-list')`, 12000);
      const items = await count('.history-item');
      assert(items > 0, '足迹为空');
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await navigate('#/home', `!!document.querySelector('.hero-copy h1')`, 15000);
      const mobileNav = await evaluate(`getComputedStyle(document.querySelector('.mobile-nav')).display`);
      assert(mobileNav !== 'none', '移动端底栏未显示');
      await shot('13-mobile-home');
      const overflow = await evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
      assert(overflow <= 2, `移动端横向溢出 ${overflow}px`);
      return `${items} 条足迹 · 底栏 ${mobileNav}`;
    });

    const jsErrors = consoleErrors.filter(item => !/favicon|ERR_INTERNET|net::/i.test(item));
    if (jsErrors.length) {
      failures.push({ name: '浏览器脚本无报错', error: jsErrors.join('\n---\n') });
      process.stdout.write(`  ✗ 浏览器脚本无报错\n    ${jsErrors.slice(0, 6).join('\n    ')}\n`);
    } else {
      pass('浏览器脚本无报错');
    }
    if (networkErrors.length) {
      process.stdout.write(`  · 网络请求告警 ${networkErrors.length} 条（封面/外部资源常见，不计入失败）\n`);
    }

    process.stdout.write('\n');
    if (failures.length) {
      process.stdout.write(`结果：${notes.length} 项通过，${failures.length} 项失败\n`);
      process.stdout.write(`截图目录：${SHOTS}\n`);
      for (const failure of failures) process.stdout.write(`\n[${failure.name}]\n${failure.error}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`结果：全部 ${notes.length} 项通过\n截图目录：${SHOTS}\n`);
    }
  } finally {
    cdp?.close();
    try { browser.kill(); } catch {}
    await sleep(600);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  }
}

main().catch(error => {
  process.stdout.write(`\n测试无法继续：${error.message}\n${error.stack || ''}\n`);
  process.exitCode = 1;
});
