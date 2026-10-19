#!/usr/bin/env node
'use strict';

/**
 * 墨阅启动器
 * ------------
 * 找一处空闲的门牌（端口），点起书房的灯（启动服务），
 * 再替你把门推开（打开浏览器）。零依赖，双击即可。
 */

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = __dirname;
const HOST = process.env.MOYUE_HOST || '127.0.0.1';
const PREFERRED = Number(process.env.MOYUE_PORT || process.env.PORT || 8737);
const NO_OPEN = process.env.MOYUE_NO_OPEN === '1';
const FROM_BAT = process.env.MOYUE_BAT === '1';
const DATA_DIR = path.join(ROOT, 'data');
const PORT_FILE = path.join(DATA_DIR, 'port.txt');
const START_AT = Date.now();

let child = null;
let exiting = false;

function line(message = '') {
  process.stdout.write(`${message}\n`);
}

function getJson(port, pathname, timeout = 1200) {
  return new Promise(resolve => {
    const req = http.request({ host: HOST, port, path: pathname, method: 'GET', timeout }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function existingStudy(port) {
  const payload = await getJson(port, '/api/status');
  return Boolean(payload && payload.ok && payload.data && payload.data.name === '墨阅');
}

function recordedPort() {
  try {
    const port = Number(fs.readFileSync(PORT_FILE, 'utf8').trim());
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : 0;
  } catch {
    return 0;
  }
}

async function findExistingStudy() {
  const candidates = [recordedPort(), PREFERRED].filter((port, index, list) => port && list.indexOf(port) === index);
  for (const port of candidates) {
    if (await existingStudy(port)) return port;
  }
  return 0;
}

function portFree(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, HOST);
  });
}

async function findPort(start) {
  for (let port = start; port < start + 40; port += 1) {
    if (port > 65535) break;
    if (await portFree(port)) return port;
  }
  throw new Error('没有找到空闲端口，请关闭占用 8737–8776 的程序后重试。');
}

function openBrowser(url) {
  if (NO_OPEN) return;
  try {
    if (process.platform === 'win32') {
      const opener = spawn('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true, detached: true });
      opener.unref();
    } else if (process.platform === 'darwin') {
      const opener = spawn('open', [url], { stdio: 'ignore', detached: true });
      opener.unref();
    } else {
      const opener = spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
      opener.unref();
    }
  } catch {
    line(`请手动在浏览器打开：${url}`);
  }
}

function cleanupPortFile(port) {
  try {
    const recorded = fs.readFileSync(PORT_FILE, 'utf8').trim();
    if (recorded === String(port)) fs.unlinkSync(PORT_FILE);
  } catch {}
}

async function waitUntilReady(port, timeoutMs = 22000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) return false;
    const payload = await getJson(port, '/api/status', 900);
    if (payload && payload.ok && payload.data && payload.data.name === '墨阅') return true;
    await new Promise(resolve => setTimeout(resolve, 320));
  }
  return false;
}

function shutdown(signal = 'SIGINT') {
  if (exiting) return;
  exiting = true;
  if (child && child.exitCode === null) {
    line('\n正在合上书页…');
    child.kill(signal === 'SIGBREAK' ? 'SIGINT' : signal);
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, 3500);
    if (typeof timer.unref === 'function') timer.unref();
  } else {
    process.exit(0);
  }
}

async function main() {
  line('');
  line('  墨 阅 · MOYUE');
  line('  一盏灯，半卷书');
  line('');

  const runningPort = await findExistingStudy();
  if (runningPort) {
    const url = `http://${HOST}:${runningPort}`;
    line(`  书房已经开着：${url}`);
    line('  为你再推一次门。');
    openBrowser(url);
    if (FROM_BAT) process.exitCode = 2;
    return;
  }

  const port = await findPort(PREFERRED);
  const url = `http://${HOST}:${port}`;
  const serverEntry = path.join(ROOT, 'server', 'index.js');

  if (!fs.existsSync(serverEntry)) {
    throw new Error('没有找到 server/index.js，请确认文件完整。');
  }

  child = spawn(process.execPath, [serverEntry], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), MOYUE_PORT: String(port), MOYUE_HOST: HOST },
    stdio: 'inherit',
    windowsHide: false
  });

  child.on('error', error => {
    line(`\n启动失败：${error.message}`);
    process.exitCode = 1;
  });

  child.on('exit', code => {
    cleanupPortFile(port);
    const seconds = ((Date.now() - START_AT) / 1000).toFixed(1);
    line(`\n墨阅已合上（运行 ${seconds}s，退出码 ${code ?? 0}）。`);
    process.exit(code ?? 0);
  });

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGTERM'));
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));

  line('  正在点灯…');
  const ready = await waitUntilReady(port);
  if (!ready) {
    line('\n书房的门没有打开。请检查上方日志，或运行 node server/index.js 查看详细错误。');
    try { child.kill('SIGINT'); } catch {}
    setTimeout(() => process.exit(1), 600);
    return;
  }

  line('');
  line(`  墨阅已开卷  →  ${url}`);
  line('  按 Ctrl+C 或关闭这个窗口，即可合上书页。');
  line('');
  openBrowser(url);
}

main().catch(error => {
  line(`\n启动遇到问题：${error.message}`);
  process.exitCode = 1;
});
