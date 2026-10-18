'use strict';

const { request, formBody } = require('../http');
const {
  AppError, absoluteUrl, cleanLine, decodeEntities, htmlToText, normalizeText, stripTags, toParagraphs
} = require('../util');

const SEARCH_COOLDOWN = 15500;
let lastSearchAt = 0;

function metaMap(html) {
  const map = {};
  const pattern = /<meta\b[^>]*>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const tag = match[0];
    const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (key && content != null) map[key.toLowerCase()] = decodeEntities(content);
  }
  return map;
}

function textOf(html, regex) {
  const match = regex.exec(html);
  return match ? stripTags(match[1]).trim() : '';
}

function wordsText(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/[万字]/.test(text)) return text;
  return /^\d+(\.\d+)?$/.test(text) ? `${text} 万字` : text;
}

function normalizeCover(value, base) {
  const cover = String(value || '').trim();
  if (!cover || /zanwu\.jpg/i.test(cover)) return '';
  return absoluteUrl(base, cover);
}

function cleanIntro(raw) {
  const lines = htmlToText(raw, { keepParagraphs: true })
    .split('\n')
    .map(line => line.replace(/^简介[:：]\s*/, '').trim())
    .filter(line => line && !/^--/.test(line) && !/^(本站|笔趣阁)/.test(line));
  return lines.join('\n').trim();
}

function chapterNumber(title) {
  const text = String(title || '');
  const arabic = /第\s*(\d+)\s*[章节回]/.exec(text);
  if (arabic) return Number(arabic[1]);
  const chinese = /第\s*([零一二三四五六七八九十百千万两]+)\s*[章节回]/.exec(text);
  if (!chinese) return 0;
  const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
  let total = 0;
  let section = 0;
  let number = 0;
  for (const char of chinese[1]) {
    if (digits[char] != null) {
      number = digits[char];
    } else if (units[char]) {
      const unit = units[char];
      if (unit === 10000) {
        section = (section + number) * unit;
        total += section;
        section = 0;
      } else {
        section += (number || 1) * unit;
      }
      number = 0;
    }
  }
  return total + section + number;
}

async function search(keyword, source) {
  const now = Date.now();
  if (now - lastSearchAt < SEARCH_COOLDOWN) {
    const wait = Math.ceil((SEARCH_COOLDOWN - (now - lastSearchAt)) / 1000);
    throw new AppError(429, `笔趣阁搜索限流，请约 ${wait} 秒后再试`, 'RATE_LIMIT');
  }
  lastSearchAt = now;
  const base = source.baseUrl;
  const res = await request(`${base}/s.php`, {
    method: 'POST',
    timeout: 20000,
    maxBytes: 4 * 1024 * 1024,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: `${base}/`,
      Origin: base
    },
    body: formBody({ type: 'articlename', s: keyword, submit: '' })
  });
  const html = res.text;
  const block = /<ul[^>]*class="[^"]*\bsearch\b[^"]*"[^>]*>([\s\S]*?)<\/ul>/i.exec(html)?.[1];
  if (!block) {
    throw new AppError(502, '笔趣阁返回的搜索页面格式异常', 'BAD_UPSTREAM_DATA');
  }
  const items = [];
  const rowPattern = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let match;
  while ((match = rowPattern.exec(block))) {
    const row = match[1];
    if (/class="fen"/i.test(row)) continue;
    const idMatch = /href="\/book\/(\d+)\/"/i.exec(row);
    if (!idMatch) continue;
    const titleLink = /<span[^>]*class="name"[^>]*>([\s\S]*?)<\/span>/i.exec(row)?.[1] || '';
    let title = textOf(titleLink, /<a\b[^>]*>([\s\S]*?)<\/a>/i);
    if (!title) {
      title = decodeEntities(/<a\b[^>]*title="([^"]*)"[^>]*>/i.exec(titleLink)?.[1] || '');
      title = title.replace(/文章列表$/, '').trim();
    }
    if (!title) continue;
    const category = textOf(/<span[^>]*class="lei"[^>]*>([\s\S]*?)<\/span>/i.exec(row)?.[1] || '', /<a\b[^>]*>([\s\S]*?)<\/a>/i)
      .replace(/^\[|\]$/g, '')
      .trim();
    const author = textOf(row, /<span[^>]*class="zuo"[^>]*>([\s\S]*?)<\/span>/i) || '佚名';
    const latestChapter = textOf(row, /<span[^>]*class="jie"[^>]*>([\s\S]*?)<\/span>/i);
    const updatedAt = textOf(row, /<span[^>]*class="time"[^>]*>([\s\S]*?)<\/span>/i);
    items.push({
      source: 'biquge365',
      bookId: idMatch[1],
      title,
      author,
      cover: '',
      intro: '',
      category,
      status: '',
      words: '',
      latestChapter,
      updatedAt
    });
  }
  return items;
}

function parseCatalog(html, bookId, latestChapter) {
  const list = [];
  const byCid = new Map();
  const pattern = /<a\b[^>]*href="\/chapter\/(\d+)\/(\d+)\.html"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    if (match[1] !== String(bookId)) continue;
    const cid = match[2];
    const rawText = stripTags(match[3]).trim();
    const isStart = /开始阅读/.test(rawText);
    let title = rawText.replace(/^开始阅读$/, '').trim();
    if (!title && isStart) title = '';
    let item = byCid.get(cid);
    if (!item) {
      item = { id: cid, title, isStart, order: list.length + 1 };
      byCid.set(cid, item);
      list.push(item);
    } else {
      if (title.length > item.title.length) item.title = title;
      item.isStart = item.isStart || isStart;
    }
  }
  if (!list.length) return [];

  // 目录页顶部常混入「最新章节」倒序块与「开始阅读」入口，不能只靠整体反转。
  // 章节名带序号时，直接按序号升序排；这是最稳的书序。
  const numbered = list.filter(item => chapterNumber(item.title) > 0).length;
  if (numbered >= Math.max(3, Math.ceil(list.length * 0.6))) {
    list.sort((a, b) => {
      const left = chapterNumber(a.title);
      const right = chapterNumber(b.title);
      if (left !== right) {
        if (!left) return -1;
        if (!right) return 1;
        return left - right;
      }
      return a.order - b.order;
    });
  } else {
    const firstNumber = chapterNumber(list[0].title);
    const lastNumber = chapterNumber(list[list.length - 1].title);
    const normalizedLatest = normalizeText(latestChapter || '');
    const firstIsLatest = normalizedLatest && normalizeText(list[0].title) === normalizedLatest;
    const lastIsLatest = normalizedLatest && normalizeText(list[list.length - 1].title) === normalizedLatest;
    const startIndex = list.findIndex(item => item.isStart);

    let reverse = false;
    if (firstNumber && lastNumber && firstNumber > lastNumber) {
      reverse = true;
    } else if (firstIsLatest && !lastIsLatest) {
      reverse = true;
    } else if (lastIsLatest && !firstIsLatest) {
      reverse = false;
    } else if (startIndex === 0 && list.length > 1) {
      reverse = true;
    } else if (startIndex > 0) {
      reverse = false;
    }

    if (reverse) list.reverse();
  }

  return list
    .map((item, index) => ({
      id: item.id,
      title: item.title || `第 ${index + 1} 章`,
      index: index + 1
    }))
    .filter(item => item.id);
}

async function detail(bookId, source) {
  const base = source.baseUrl;
  const res = await request(`${base}/book/${encodeURIComponent(bookId)}/`, {
    timeout: 20000,
    headers: { Referer: `${base}/` }
  });
  const html = res.text;
  const meta = metaMap(html);
  const title = meta['og:novel:book_name'] || textOf(html, /<div[^>]*class="right"[^>]*>[\s\S]*?<h1[^>]*>([\s\S]*?)<\/h1>/i) || '无题';
  const author = meta['og:novel:author'] || textOf(html, /<span[^>]*class="x1"[^>]*>作者[:：][\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a>/i) || '佚名';
  const category = meta['og:novel:category'] || (/类型[:：]\s*([^<\n]+)/.exec(html)?.[1] || '').trim();
  const status = meta['og:novel:status'] || (/状态[:：]\s*([^<\n]+)/.exec(html)?.[1] || '').trim();
  const latestChapter = meta['og:novel:latest_chapter_name']
    || textOf(html, /<span[^>]*class="x2"[^>]*>最新章节[:：]([\s\S]*?)<\/span>/i);
  const updatedAt = meta['og:novel:update_time']
    || (/更新时间[:：]\s*([0-9: -]+)/.exec(html)?.[1] || '').trim();
  const coverTag = /<div[^>]*class="zhutu"[^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1] || '';
  const coverSrc = /<img\b[^>]*src="([^"]+)"/i.exec(coverTag)?.[1] || meta['og:image'] || '';
  const introRaw = /<div[^>]*class="x3"[^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1] || '';
  const intro = cleanIntro(introRaw);

  let chapters = [];
  try {
    const catalog = await request(`${base}/newbook/${encodeURIComponent(bookId)}/`, {
      timeout: 25000,
      maxBytes: 12 * 1024 * 1024,
      headers: { Referer: `${base}/book/${encodeURIComponent(bookId)}/` }
    });
    chapters = parseCatalog(catalog.text, bookId, latestChapter);
  } catch (error) {
    console.warn(`[biquge365] 目录获取失败 ${bookId}: ${error.message}`);
  }

  if (!chapters.length) {
    // 退回到详情页展示的最新章节（通常 10 条），至少保证可以开始阅读
    const fallback = [];
    const pattern = /<a\b[^>]*href="\/chapter\/(\d+)\/(\d+)\.html"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    const seen = new Set();
    while ((match = pattern.exec(html))) {
      if (match[1] !== String(bookId) || seen.has(match[2])) continue;
      seen.add(match[2]);
      fallback.push({ id: match[2], title: stripTags(match[3]).trim() || '最新章节' });
    }
    fallback.reverse();
    chapters = fallback.map((item, index) => ({ ...item, index: index + 1 }));
  }

  return {
    source: 'biquge365',
    bookId: String(bookId),
    title,
    author,
    cover: normalizeCover(coverSrc, base),
    intro,
    category,
    status,
    words: '',
    latestChapter,
    updatedAt,
    chapters
  };
}

function parseChapterLinks(html, bookId) {
  const links = {};
  const pattern = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const text = stripTags(match[2]).trim();
    const chapterId = new RegExp(`/chapter/${bookId}/(\\d+)\\.html`).exec(match[1])?.[1];
    if (!chapterId) continue;
    if (text.includes('上一章')) links.prev = chapterId;
    if (text.includes('下一章')) links.next = chapterId;
  }
  return links;
}

async function chapter(bookId, chapterId, source) {
  const base = source.baseUrl;
  const res = await request(`${base}/chapter/${encodeURIComponent(bookId)}/${encodeURIComponent(chapterId)}.html`, {
    timeout: 20000,
    maxBytes: 6 * 1024 * 1024,
    headers: { Referer: `${base}/book/${encodeURIComponent(bookId)}/` }
  });
  const html = res.text;
  const title = textOf(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i) || '';
  const body = /<div[^>]*id="txt"[^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1] || '';
  let paragraphs = toParagraphs(body).map(line => line
    .replace(/\(\s*第\d+\/\d+页\s*\)/g, '')
    .replace(/（\s*第\d+\/\d+页\s*）/g, '')
    .trim());
  const drop = [
    /^一秒记住/,
    /^请记住本书/,
    /^笔趣阁/,
    /biquge/i,
    /^手机版/,
    /^加入书签/,
    /^推荐票/,
    /^本章未完/,
    /点击下一页/,
    /^上一章/,
    /^下一章/,
    /^目录$/,
    /^投推荐票/,
    /^求月票/
  ];
  paragraphs = paragraphs
    .filter(line => line && !drop.some(regex => regex.test(line)))
    .filter(line => line !== title);
  if (!paragraphs.length) {
    throw new AppError(502, '这一章的正文暂时没有取到，请稍后重试', 'EMPTY_CHAPTER');
  }
  const links = parseChapterLinks(html, bookId);
  return {
    id: String(chapterId),
    title,
    paragraphs,
    text: paragraphs.join('\n\n'),
    words: paragraphs.join('').length,
    prevId: links.prev,
    nextId: links.next
  };
}

async function probe(source) {
  const res = await request(`${source.baseUrl}/`, { timeout: 12000, maxBytes: 2 * 1024 * 1024 });
  if (!/笔趣阁|biquge/i.test(res.text)) {
    throw new AppError(502, '首页内容异常', 'PROBE_CONTENT');
  }
  return { message: '首页可访问', detail: '笔趣阁 365' };
}

module.exports = {
  id: 'biquge365',
  name: '笔趣阁 365',
  search,
  detail,
  chapter,
  probe,
  searchCooldown: SEARCH_COOLDOWN
};
