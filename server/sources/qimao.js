'use strict';

const { request, fetchJson } = require('../http');
const { AppError, absoluteUrl, cleanLine, htmlToText, stripTags, toParagraphs } = require('../util');

function wordsText(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  if (/[万字]/.test(text)) return text;
  const number = Number(text);
  return Number.isFinite(number) ? `${text} 万字` : text;
}

function normalizeCover(value, base) {
  const cover = String(value || '').trim();
  if (!cover) return '';
  if (cover.startsWith('//')) return `https:${cover}`;
  return absoluteUrl(base, cover);
}

function cleanIntro(value) {
  return htmlToText(value || '', { keepParagraphs: false })
    .replace(/^简介[:：]\s*/, '')
    .trim();
}

function mapSearchItem(item, base) {
  const id = String(item.book_id || item.id || '');
  return {
    source: 'qimao',
    bookId: id,
    title: stripTags(item.title || '').trim(),
    author: stripTags(item.author || '').trim() || '佚名',
    cover: normalizeCover(item.image_link || item.cover, base),
    intro: cleanIntro(item.intro || ''),
    category: stripTags(item.category2_name || item.category_1_name || '').trim(),
    status: item.is_over_txt || (String(item.is_over) === '1' ? '已完结' : '连载中'),
    words: wordsText(item.words_num),
    latestChapter: stripTags(item.latest_chapter_title || '').trim(),
    updatedAt: String(item.update_time || '').trim()
  };
}

function parseChapterLinks(html, bookId) {
  const links = {};
  const pattern = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const href = match[1];
    const text = stripTags(match[2]).trim();
    if (!href.includes(`/shuku/${bookId}-`)) continue;
    if (text.includes('上一章')) links.prev = href;
    if (text.includes('下一章')) links.next = href;
  }
  const idFromUrl = (href) => {
    const m = /\/shuku\/\d+-(\d+)\/?/.exec(href || '');
    return m ? m[1] : '';
  };
  return { prev: idFromUrl(links.prev), next: idFromUrl(links.next) };
}

function cleanParagraphs(paragraphs, chapterTitle) {
  const drop = [
    /^一秒记住/,
    /^请记住本书/,
    /^笔趣阁/,
    /biquge/i,
    /qimao\.com/i,
    /七猫中文网/,
    /^手机版/,
    /^加入书签/,
    /^推荐票/,
    /^本章未完/,
    /点击下一页/,
    /^第\d+\/\d+页$/,
    /^（第\d+\/\d+页）$/,
    /^本章为?VIP/,
    /^登录后/,
    /^下载七猫/,
    /^上一章/,
    /^下一章/,
    /^目录$/,
    /^投推荐票/,
    /^求月票/
  ];
  return paragraphs
    .map(cleanLine)
    .map(line => line.replace(/^第[一二三四五六七八九十百千万零两\d]+章[^（(]{0,40}[（(]第\d+\/\d+页[)）]$/, '').trim())
    .filter(line => line && !drop.some(regex => regex.test(line)))
    .filter(line => line !== chapterTitle);
}

async function search(keyword, source) {
  const base = source.baseUrl;
  const url = `${base}/qimaoapi/api/search/result?keyword=${encodeURIComponent(keyword)}&page=1`;
  const payload = await fetchJson(url, {
    timeout: 15000,
    headers: {
      Referer: `${base}/`,
      'X-Requested-With': 'XMLHttpRequest'
    }
  });
  const list = payload?.data?.search_list;
  if (!Array.isArray(list)) {
    throw new AppError(502, '七猫返回的搜索结果格式异常', 'BAD_UPSTREAM_DATA');
  }
  return list
    .map(item => mapSearchItem(item, base))
    .filter(item => item.bookId && item.title);
}

async function detail(bookId, source) {
  const base = source.baseUrl;
  const headers = { Referer: `${base}/shuku/${bookId}/` };
  const [mainResult, introResult, catalogResult] = await Promise.allSettled([
    fetchJson(`${base}/qimaoapi/api/book-detail/main-info?book_id=${encodeURIComponent(bookId)}`, { timeout: 15000, headers }),
    fetchJson(`${base}/qimaoapi/api/book-detail/intro?book_id=${encodeURIComponent(bookId)}`, { timeout: 15000, headers }),
    fetchJson(`${base}/qimaoapi/api/book/chapter-list?book_id=${encodeURIComponent(bookId)}`, { timeout: 25000, headers, maxBytes: 8 * 1024 * 1024 })
  ]);
  if (mainResult.status === 'rejected') throw mainResult.reason;
  const main = mainResult.value?.data?.book_detail;
  if (!main) throw new AppError(404, '没有找到这本书', 'NO_BOOK');
  const introData = introResult.status === 'fulfilled' ? introResult.value?.data || {} : {};
  const catalogData = catalogResult.status === 'fulfilled' ? catalogResult.value?.data || {} : {};
  const rawChapters = Array.isArray(catalogData.chapters) ? catalogData.chapters : [];
  const chapters = rawChapters.map((chapter, index) => ({
    id: String(chapter.id),
    title: stripTags(chapter.title || '').trim() || `第 ${index + 1} 章`,
    index: Number(chapter.index) || index + 1,
    words: Number(chapter.words) || 0,
    vip: String(chapter.is_vip) === '1'
  })).filter(chapter => chapter.id);
  chapters.sort((a, b) => a.index - b.index);
  const book = {
    source: 'qimao',
    bookId: String(bookId),
    title: stripTags(main.title || '').trim() || '无题',
    author: stripTags(main.author || '').trim() || '佚名',
    cover: normalizeCover(main.image_link || main.free_image_link, base),
    intro: cleanIntro(introData.intro || ''),
    category: stripTags(main.category_2_name || main.category_1_name || '').trim(),
    status: String(main.is_over) === '1' ? '已完结' : '连载中',
    words: wordsText(main.words_num),
    latestChapter: stripTags(main.latest_chapter_title || '').trim(),
    updatedAt: String(main.update_time || '').trim(),
    score: String(main.score || '').trim(),
    chapters
  };
  if (!book.intro && introData.first_chapter_title) {
    book.firstChapterTitle = stripTags(introData.first_chapter_title).trim();
  }
  return book;
}

async function chapter(bookId, chapterId, source) {
  const base = source.baseUrl;
  const url = `${base}/shuku/${encodeURIComponent(bookId)}-${encodeURIComponent(chapterId)}/`;
  const res = await request(url, {
    timeout: 20000,
    maxBytes: 6 * 1024 * 1024,
    headers: { Referer: `${base}/shuku/${bookId}/` }
  });
  const html = res.text;
  const titleMatch = /<h2[^>]*class="[^"]*chapter-title[^"]*"[^>]*>([\s\S]*?)<\/h2>/i.exec(html)
    || /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const title = titleMatch ? stripTags(titleMatch[1]).trim() : '';

  const marker = html.indexOf('chapter-detail-article');
  const scope = marker >= 0 ? html.slice(marker, marker + 500000) : html;
  const articleMatch = /<div[^>]*class="[^"]*\barticle\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(scope);
  let paragraphs = articleMatch ? toParagraphs(articleMatch[1]) : [];
  paragraphs = cleanParagraphs(paragraphs, title);

  if (!paragraphs.length) {
    if (/付费|VIP|订阅/.test(html) && /本章|章节/.test(html)) {
      throw new AppError(402, '这一章需要付费，暂时无法免费阅读', 'VIP_CHAPTER');
    }
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
  const base = source.baseUrl;
  const payload = await fetchJson(`${base}/qimaoapi/api/search/result?keyword=${encodeURIComponent('剑来')}&page=1`, {
    timeout: 12000,
    headers: { Referer: `${base}/`, 'X-Requested-With': 'XMLHttpRequest' }
  });
  const count = Array.isArray(payload?.data?.search_list) ? payload.data.search_list.length : 0;
  if (!count) throw new AppError(502, '搜索接口无返回结果', 'PROBE_EMPTY');
  return { message: `搜索接口正常，命中 ${count} 条`, detail: '七猫中文网' };
}

module.exports = { id: 'qimao', name: '七猫中文网', search, detail, chapter, probe };
