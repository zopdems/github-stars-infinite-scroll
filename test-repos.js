/*
 * test-repos.js — 校验「仓库 / Repositories」标签页的无限滚动 + 滚动回收
 *
 * 结构与实测一致（2026-10）：
 *   - 容器 turbo-frame#user-profile-frame > div.position-relative > div > ul > li.col-12…
 *   - 分页是经典 ?page=N（Next = a.next_page[rel=next]），最后一页无 next 链接
 *   - 追加容器是那个 <ul>（不是帧本身），回收占位块是 <li>
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, 'github-stars-infinite-scroll.user.js'), 'utf8');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✅', name); }
  else { failed++; console.log('  ❌', name, extra != null ? '-> ' + JSON.stringify(extra) : ''); }
}
const tick = () => new Promise(r => setTimeout(r, 0));

const PER_PAGE = 3;
const TOTAL_PAGES = 5;

function repoLi(owner, repo) {
  return `<li class="col-12 d-flex flex-justify-between width-full py-4 border-bottom color-border-muted public source">
    <div class="col-10 col-lg-9 d-inline-block">
      <div class="d-inline-block mb-1"><h3 class="wb-break-all"><a href="/${owner}/${repo}" itemprop="name codeRepository">${repo}</a></h3></div>
      <div><p class="color-fg-muted" itemprop="description">desc of ${repo}</p></div>
    </div>
    <div class="col-2 d-flex flex-column"><a href="/${owner}/${repo}/stargazers">stars</a></div>
  </li>`;
}

function pageHTML(pageNum, hasNext, owner) {
  let items = '';
  for (let i = 0; i < PER_PAGE; i++) {
    const n = (pageNum - 1) * PER_PAGE + i + 1;
    items += repoLi(owner, 'repo' + n);
  }
  const pag = hasNext
    ? `<div class="paginate-container"><div role="navigation" class="pagination"><span class="previous_page disabled">Previous</span> <a class="next_page" rel="next" href="/${owner}?page=${pageNum + 1}&amp;tab=repositories">Next</a></div></div>`
    : `<div class="paginate-container"></div>`;   // 最后一页：空分页区（终止信号）
  return `<!doctype html><html><body><main>
    <turbo-frame id="user-profile-frame"><div class="position-relative">
      <div><form class="width-full"><input placeholder="Find a repository…"></form></div>
      <div><ul>${items}</ul>${pag}</div>
    </div></turbo-frame>
  </main></body></html>`;
}

function makeDom() {
  const initial = pageHTML(1, true, 'someuser');
  const dom = new JSDOM(initial, {
    url: 'https://github.com/someuser?tab=repositories',
    pretendToBeVisual: true,
    runScripts: 'outside-only'
  });
  const w = dom.window;
  w.requestAnimationFrame = (cb) => { cb(0); return 0; };
  w.requestIdleCallback = (cb) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 0 }), 0);
  w.MutationObserver = class { constructor() {} observe() {} disconnect() {} };
  w.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; this.e = new Set(); }
    observe(e) { this.e.add(e); } unobserve(e) { this.e.delete(e); } disconnect() { this.e.clear(); }
  };
  const defaultRect = { top: 0, bottom: 500, height: 160, left: 0, right: 100, width: 100, x: 0, y: 0 };
  w.Element.prototype.getBoundingClientRect = function () { return this.__rect || defaultRect; };
  Object.defineProperty(w, 'scrollY', { value: 0, writable: true, configurable: true });
  Object.defineProperty(w, 'pageYOffset', { value: 0, writable: true, configurable: true });

  const fetchCalls = [];
  w.fetch = async (url) => {
    fetchCalls.push(String(url));
    const u = new URL(url, 'https://github.com');
    const pageNum = parseInt(u.searchParams.get('page') || '1', 10);
    const hasNext = pageNum < TOTAL_PAGES;
    return { ok: true, status: 200, text: async () => pageHTML(pageNum, hasNext, 'someuser') };
  };
  w.__fetchCalls = fetchCalls;

  w.eval(SRC);
  const cfg = w.GHStarsInfinite.config;
  cfg.minIntervalMs = 0; cfg.prefetchPx = 0; cfg.recycle = true; cfg.recycleAbovePx = 1400; cfg.maxCachedPages = 0;
  return dom;
}

function liCount(w, page) { return w.document.querySelectorAll(`[data-gh-star-page="${page}"]`).length; }
function pushPageAbove(w, page) {
  w.document.querySelectorAll(`[data-gh-star-page="${page}"]`).forEach(n => {
    n.__rect = { top: -2100, bottom: -2000, height: 160, left: 0, right: 100, width: 100, x: 0, y: -2100 };
  });
}
async function loadOne(w) {
  const st = w.GHStarsInfinite.state;
  if (st.done) return;
  w.GHStarsInfinite.loadMore();
  for (let i = 0; i < 200; i++) { await tick(); if (!st.loading) break; }
}
async function scrollUp(w) {
  const st = w.GHStarsInfinite.state;
  st.lastScrollY = 200; w.scrollY = 0;
  w.dispatchEvent(new w.Event('scroll'));
  await tick(); await tick();
}

async function run() {
  console.log('\n[仓库标签页] 无限滚动 + 滚动回收');
  const dom = makeDom();
  const w = dom.window;
  const st = w.GHStarsInfinite.state;

  // --- 识别与结构 ---
  ok('activeList = repositories', st.listId === 'repositories');
  ok('frameId = user-profile-frame', st.frameId === 'user-profile-frame');
  ok('追加容器是 <ul>（不是帧）', st.list && st.list.tagName === 'UL');
  ok('占位块标签 = li', st.placeholderTag === 'li');
  ok('首页 3 个 <li> 已在 DOM', liCount(w, 1) === 3);
  ok('哨兵在帧内、位于 <ul> 之后', st.sentinel && st.sentinel.parentNode === st.frame);

  // --- 加载第 2 页 ---
  await loadOne(w);
  ok('加载后共 2 页', st.pages.length === 2);
  ok('第2页 3 个 <li> 已追加到 <ul>', liCount(w, 2) === 3);
  ok('新 <li> 确实在 <ul> 里（不在帧直属层）', st.list.querySelectorAll('[data-gh-star-page="2"]').length === 3);
  ok('nextUrl 指向 page=3', /page=3/.test(st.nextUrl || ''));
  ok('哨兵仍在帧内且位于内容之后', st.sentinel.parentNode === st.frame &&
     st.frame.lastElementChild === st.sentinel);

  // --- 回收第 1 页 ---
  pushPageAbove(w, 1);
  w.GHStarsInfinite.recycleNow();
  await tick();
  ok('第1页 <li> 已从 DOM 摘除', liCount(w, 1) === 0);
  const ph = st.list.querySelector('.ghsi-pholder[data-gh-page="1"]');
  ok('占位块出现在 <ul> 内且是 <li>', !!ph && ph.tagName === 'LI' && ph.parentNode === st.list);
  ok('占位块高度 = 3×160 = 480px', ph && ph.style.height === '480px', ph && ph.style.height);
  ok('第2页未被误回收', liCount(w, 2) === 3);

  // --- 回看补回（缓存命中）---
  ph.__rect = { top: -600, bottom: -500, height: 480, left: 0, right: 100, width: 100, x: 0, y: -600 };
  await scrollUp(w);
  ok('回看后第1页 <li> 已补回 <ul>', liCount(w, 1) === 3 && st.list.querySelectorAll('[data-gh-star-page="1"]').length === 3);
  ok('占位块已移除', !st.list.querySelector('.ghsi-pholder[data-gh-page="1"]'));

  // --- 一路加载到底（终止信号）---
  await loadOne(w); // page 3
  await loadOne(w); // page 4
  await loadOne(w); // page 5 (last, no next)
  for (let i = 0; i < 50; i++) { await tick(); if (st.done) break; }
  ok('加载到最后一页后 done=true', st.done === true);
  ok('累计去重 = 5 页 × 3 = 15', st.seen.size === 15, st.seen.size);
  ok('结束标记已插入帧内', !!(st.frame && st.frame.querySelector('#gh-stars-infinite-end')));
  const callsBefore = w.__fetchCalls.length;
  w.GHStarsInfinite.loadMore();
  await tick(); await tick();
  ok('到底后手动 loadMore 不再发起请求', w.__fetchCalls.length === callsBefore);

  dom.window.close();
  console.log(`\n结果：通过 ${passed}，失败 ${failed}`);
  process.exit(failed ? 1 : 0);
}
run().catch(e => { console.error('测试异常：', e); process.exit(2); });
