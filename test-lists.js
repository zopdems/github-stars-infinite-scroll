/*
 * test-lists.js — 校验「多种可翻页列表」的识别、key 解析、翻页与回收
 *
 * 每种列表的 HTML 结构都对齐 2026-10 的实测结果：
 *   followers/following  #user-profile-frame   div.d-table.table-fixed…  key=user   分页 ?page=N (.paginate-container)
 *   forks/stargazers/watchers #repo-content-turbo-frame  ul>li.Box-row  key=repo/user  a.next_page ?page=N
 *   issues/pulls         #repo-content-turbo-frame  ul>li             key=issue/pr   nav.prc-Pagination… ?page=N
 *   commits              #repo-content-turbo-frame  li[data-commit-link] key=commit   nav.prc-Pagination… ?after=
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

const O = 'acme', R = 'widget';   // owner / repo

/* ---------- 各种条目的 HTML ---------- */
const ITEMS = {
  user: (i) => `<div class="d-table table-fixed col-12 width-full py-4 border-bottom color-border-muted">
      <div class="d-table-cell col-2"><a class="d-inline-block" data-hovercard-type="user"
        data-hovercard-url="/users/u${i}/hovercard" href="/u${i}">u${i}</a></div>
      <div class="d-table-cell col-9">some bio</div></div>`,
  // 星标者/关注者：用户条目装在 ul > li.Box-row 里（与 forks 同构）
  userLi: (i) => `<li class="Box-row"><div><a class="d-inline-block" data-hovercard-type="user"
      href="/u${i}">u${i}</a></div></li>`,
  repo: (i) => `<li class="Box-row"><div><h2 class="f4"><a href="/forkowner${i}/${R}">forkowner${i}/${R}</a></h2>
      <p>a fork</p></div></li>`,
  issue: (i) => `<li><div><h3 class="heading"><a href="/${O}/${R}/issues/${i}">Issue ${i}</a></h3></div></li>`,
  pr: (i) => `<li><div><h3 class="heading"><a href="/${O}/${R}/pull/${i}">PR ${i}</a></h3></div></li>`,
  commit: (i) => `<li data-testid="commit-row-item" data-commit-link="/${O}/${R}/commit/${String(i).padStart(40, 'a')}">
      <div><a href="/${O}/${R}/commit/${String(i).padStart(40, 'a')}">commit ${i}</a></div></li>`
};

/* ---------- 各列表的分页区 ---------- */
function pagination(listId, pageNum, hasNext) {
  if (!hasNext) {
    return listId === 'followers' || listId === 'following'
      ? `<div class="paginate-container"></div>`
      : `<nav class="prc-Pagination-PaginationContainer-x1" aria-label="Pagination"></nav>`;
  }
  const n = pageNum + 1;
  switch (listId) {
    case 'followers':
      return `<div class="paginate-container"><div class="pagination"><span class="previous_page disabled">Previous</span>
        <a href="/${O}?page=${n}&amp;tab=followers">Next</a></div></div>`;
    case 'forks':
      return `<div class="pagination"><span class="previous_page disabled">Previous</span>
        <a class="next_page" rel="next" aria-label="Next page" href="/${O}/${R}/forks?page=${n}">Next</a></div>`;
    case 'commits':
      return `<nav class="prc-Pagination-PaginationContainer-x1" aria-label="Pagination">
        <div class="prc-Pagination-TablePaginationSteps-y2"><a class="prc-Pagination-Page-z3" aria-label="Next Page"
        href="/${O}/${R}/commits/master?after=cursor${n}">Next</a></div></nav>`;
    default: // issues / pulls / stargazers / watchers 都用 React 分页（?page=N）
      return `<nav class="prc-Pagination-PaginationContainer-x1" aria-label="Pagination">
        <div class="prc-Pagination-TablePaginationSteps-y2"><a class="prc-Pagination-Page-z3" aria-label="Next Page"
        href="/${O}/${R}/${listId}?page=${n}">Next</a></div></nav>`;
  }
}

/* ---------- 整页 ---------- */
function pageHTML(listId, pageNum, hasNext, per, gen) {
  let body = '';
  for (let i = 1; i <= per; i++) {
    const n = (pageNum - 1) * per + i;
    body += gen(n);
  }
  const frameId = (listId === 'followers' || listId === 'following') ? 'user-profile-frame'
                : (listId === 'forks' || listId === 'issues' || listId === 'pulls' ||
                   listId === 'commits' || listId === 'stargazers' || listId === 'watchers')
                  ? 'repo-content-turbo-frame' : 'user-starred-repos';
  const inner = /^(user)$/.test(listId) ? body : `<ul>${body}</ul>`;   // 用户列表是 div，其余装在 ul 里
  const items = (listId === 'followers' || listId === 'following') ? body : `<ul>${body}</ul>`;
  return `<!doctype html><html><body><main>
    <turbo-frame id="${frameId}"><div class="position-relative">${items}</div>${pagination(listId, pageNum, hasNext)}</turbo-frame>
  </main></body></html>`;
}

const SPECS = [
  { id: 'followers',  url: `https://github.com/${O}?tab=followers`,       kind: 'user',   gen: ITEMS.user,   per: 4 },
  { id: 'following',  url: `https://github.com/${O}?tab=following`,       kind: 'user',   gen: ITEMS.user,   per: 4 },
  { id: 'forks',      url: `https://github.com/${O}/${R}/forks`,          kind: 'repo',   gen: ITEMS.repo,   per: 4 },
  { id: 'stargazers', url: `https://github.com/${O}/${R}/stargazers`,     kind: 'user',   gen: ITEMS.userLi, per: 4 },
  { id: 'watchers',   url: `https://github.com/${O}/${R}/watchers`,       kind: 'user',   gen: ITEMS.userLi, per: 4 },
  { id: 'issues',     url: `https://github.com/${O}/${R}/issues`,         kind: 'issue',  gen: ITEMS.issue,  per: 4 },
  { id: 'pulls',      url: `https://github.com/${O}/${R}/pulls`,          kind: 'pr',     gen: ITEMS.pr,     per: 4 },
  { id: 'commits',    url: `https://github.com/${O}/${R}/commits/master`, kind: 'commit', gen: ITEMS.commit, per: 4 }
];

function makeDom(spec, page1Html) {
  const dom = new JSDOM(page1Html, { url: spec.url, pretendToBeVisual: true, runScripts: 'outside-only' });
  const w = dom.window;
  w.requestAnimationFrame = (cb) => { cb(0); return 0; };
  w.requestIdleCallback = (cb) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 0 }), 0);
  w.MutationObserver = class { constructor() {} observe() {} disconnect() {} };
  w.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; this.e = new Set(); }
    observe(e) { this.e.add(e); } unobserve(e) { this.e.delete(e); } disconnect() { this.e.clear(); }
  };
  const def = { top: 0, bottom: 500, height: 100, left: 0, right: 100, width: 100, x: 0, y: 0 };
  w.Element.prototype.getBoundingClientRect = function () { return this.__rect || def; };
  Object.defineProperty(w, 'scrollY', { value: 0, writable: true, configurable: true });
  Object.defineProperty(w, 'pageYOffset', { value: 0, writable: true, configurable: true });

  const calls = [];
  w.fetch = async (url) => {
    calls.push(String(url));
    const u = new URL(url, 'https://github.com');
    const page = parseInt(u.searchParams.get('page') || (u.searchParams.get('after') ? '2' : '2'), 10);
    const hasNext = page < 3;   // 共 3 页
    return { ok: true, status: 200, text: async () => pageHTML(spec.id, page, hasNext, spec.per, spec.gen) };
  };
  w.__calls = calls;
  w.eval(SRC);
  const c = w.GHStarsInfinite.config;
  c.minIntervalMs = 0; c.prefetchPx = 0; c.maxBurstPages = 0; c.recycle = true; c.recycleAbovePx = 1400;
  return dom;
}

async function run() {
  for (const spec of SPECS) {
    console.log(`\n[${spec.id}]`);
    const html = pageHTML(spec.id, 1, true, spec.per, spec.gen);
    const dom = makeDom(spec, html);
    const w = dom.window;
    const st = w.GHStarsInfinite.state;

    ok(`识别为 ${spec.id}`, st.listId === spec.id, st.listId);
    ok(`keyKind = ${spec.kind}`, st.keyKind === spec.kind, st.keyKind);
    ok(`首页解析出 ${spec.per} 条`, st.seen.size === spec.per, st.seen.size);

    const keys = [...st.seen];
    const expectPrefix = { user: 'user:', issue: 'issue:', pr: 'pr:', commit: 'commit:', repo: '' }[spec.kind];
    ok(`key 前缀正确（${expectPrefix || '无'}）`, keys.every(k => k.startsWith(expectPrefix)), keys.slice(0, 2));
    ok('nextUrl 已取到', !!st.nextUrl, st.nextUrl);

    // 翻到第 2 页
    w.GHStarsInfinite.loadMore();
    for (let i = 0; i < 200; i++) { await tick(); if (!st.loading) break; }
    ok(`第2页追加 ${spec.per} 条`, w.document.querySelectorAll('[data-gh-star-page="2"]').length === spec.per);
    ok(`累计 = ${spec.per * 2}`, st.seen.size === spec.per * 2, st.seen.size);

    // 回收 + 回看补回（按该列表的占位块标签）
    const first = w.document.querySelectorAll('[data-gh-star-page="1"]');
    first.forEach(n => { n.__rect = { top: -2100, bottom: -2000, height: 100, left: 0, right: 100, width: 100, x: 0, y: -2100 }; });
    w.GHStarsInfinite.recycleNow();
    await tick();
    ok('第1页已回收', st.pages[0].recycled === true);
    const ph = st.list.querySelector('.ghsi-pholder[data-gh-page="1"]');
    ok(`占位块标签 = ${st.placeholderTag.toUpperCase()}`, !!ph && ph.tagName === st.placeholderTag.toUpperCase(), ph && ph.tagName);

    ph.__rect = { top: -600, bottom: -500, height: 400, left: 0, right: 100, width: 100, x: 0, y: -600 };
    st.lastScrollY = 200; w.scrollY = 0;
    w.dispatchEvent(new w.Event('scroll'));
    await tick(); await tick();
    ok('回看补回第1页', w.document.querySelectorAll('[data-gh-star-page="1"]').length === spec.per);

    dom.window.close();
  }

  console.log(`\n结果：通过 ${passed}，失败 ${failed}`);
  process.exit(failed ? 1 : 0);
}
run().catch(e => { console.error('测试异常：', e); process.exit(2); });
