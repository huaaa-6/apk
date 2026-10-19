'use strict';

const mobile = require('./qimao-mobile');
const { AppError, absoluteUrl, cleanLine, htmlToText, stripTags, toParagraphs } = require('../util');

function wordsText(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  if (/[万字]/.test(text)) return text;
  const number = Number(text);
  if (!Number.isFinite(number)) return text;
  return number >= 10000 ? `${Number((number / 10000).toFixed(2))} 万字` : `${number} 字`;
}

function updateDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{10}$/.test(text)) return text;
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(Number(text) * 1000));
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
    category: stripTags(item.category2_name || item.category_2_name || item.category1_name || item.category_1_name || '').trim(),
    status: item.is_over_txt || (String(item.is_over) === '1' ? '已完结' : '连载中'),
    words: item.words_num == null ? (/[\d.]+\s*万?字/.exec(item.sub_title || '')?.[0] || '') : wordsText(item.words_num),
    latestChapter: stripTags(item.latest_chapter_title || '').trim(),
    updatedAt: updateDate(item.update_time)
  };
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
  const list = await mobile.search(keyword);
  return list
    .map(item => mapSearchItem(item, base))
    .filter(item => item.bookId && item.title);
}

async function detail(bookId, source) {
  const base = source.baseUrl;
  const [main, rawChapters] = await Promise.all([mobile.book(bookId), mobile.catalog(bookId)]);
  const chapters = rawChapters.map((chapter, index) => ({
    id: String(chapter.id || ''),
    title: stripTags(chapter.title || '').trim() || `第 ${index + 1} 章`,
    index: Number(chapter.chapter_sort) || Number(chapter.index) || index + 1,
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
    intro: cleanIntro(main.intro || ''),
    category: stripTags(main.category2_name || main.category_2_name || main.category1_name || main.category_1_name || '').trim(),
    status: String(main.is_over) === '1' ? '已完结' : '连载中',
    words: wordsText(main.words_num),
    latestChapter: stripTags(main.latest_chapter_title || '').trim(),
    updatedAt: updateDate(main.update_time),
    score: String(main.score || '').trim(),
    chapters
  };
  if (!book.intro && main.first_chapter_title) {
    book.firstChapterTitle = stripTags(main.first_chapter_title).trim();
  }
  return book;
}

async function chapter(bookId, chapterId, source) {
  const content = await mobile.chapter(bookId, chapterId);
  const title = stripTags(content.title || '').trim();
  const paragraphs = cleanParagraphs(toParagraphs(content.text), title);
  if (!paragraphs.length) {
    throw new AppError(502, '这一章的正文暂时没有取到，请稍后重试', 'EMPTY_CHAPTER');
  }
  return {
    id: String(chapterId),
    title,
    paragraphs,
    text: paragraphs.join('\n\n'),
    words: paragraphs.join('').length,
    prevId: '',
    nextId: ''
  };
}

async function probe(source) {
  const items = await mobile.search('剑来', { timeout: 12000 });
  const count = items.length;
  if (!count) throw new AppError(502, '搜索接口无返回结果', 'PROBE_EMPTY');
  return { message: `移动端搜索接口正常，命中 ${count} 条`, detail: '七猫移动端' };
}

module.exports = { id: 'qimao', name: '七猫中文网', search, detail, chapter, probe };
