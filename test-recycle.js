/*
 * test-recycle.js — 校验「滚动回收 + 回看自动补回」功能
 *
 * 用 jsdom 注入真实脚本，stub 掉 IntersectionObserver / fetch /
 * requestAnimationFrame / getBoundingClientRect，模拟布局与滚动，
 * 覆盖三种情形：
 *   1) 回收：整页滑出上方后被换成等高占位块（DOM 中节点消失、占位块高度相等）
 *   2) 回看补回（缓存命中）：往上翻，占位块被真实节点替换回来
 *   3) 缓存驱逐 + 回看重新拉取：maxCachedPages 限制下，被驱逐的页回看时走网络
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

const ITEMS_PER_PAGE = 5;
const ITEM_H = 100;

function itemHTML(owner, repo) {
  return `<div class="col-12 d-flex width-full py-4 border-bottom">
    <div class="col-10"><h3><a href="/${owner}/${repo}">${owner}/${repo}</a></h3></div>
  </div>`;
}

// 生成「第 pageNum 页」的完整 HTML（含 turbo-frame 与分页区）
function pageHTML(pageNum, hasNext) {
  let items = '';
  for (let i = 0; i < ITEMS_PER_PAGE; i++) {
    const n = (pageNum - 1) * ITEMS_PER_PAGE + i + 1;
    items += itemHTML('owner', 'repo' + n);
  }
  const pag = hasNext
    ? `<div class="paginate-container"><a href="https://github.com/someuser?after=${pageNum + 1}&tab=stars">Next</a></div>`
    : '';
  return `<!doctype html><html><body><main>
    <turbo-frame id="user-starred-repos">${items}${pag}</turbo-frame>
  </main></body></html>`;
}

function makeDom(maxCachedPages) {
  const initial = pageHTML(1, true);
  const dom = new JSDOM(initial, {
    url: 'https://github.com/someuser?tab=stars',
    pretendToBeVisual: true,
    runScripts: 'outside-only'
  });
  const w = dom.window;

  // --- 基础 stub ---
  w.requestAnimationFrame = (cb) => { cb(0); return 0; };
  w.cancelAnimationFrame = () => {};
  w.requestIdleCallback = (cb) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 0 }), 0);
  w.MutationObserver = class { constructor() {} observe() {} disconnect() {} };
  w.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; this.els = new Set(); }
    observe(e) { this.els.add(e); }
    unobserve(e) { this.els.delete(e); }
    disconnect() { this.els.clear(); }
  };

  // 可控布局：默认在视口内；测试用 __rect 覆盖
  const defaultRect = { top: 0, bottom: 500, height: ITEM_H, left: 0, right: 100, width: 100, x: 0, y: 0 };
  w.Element.prototype.getBoundingClientRect = function () {
    return this.__rect || defaultRect;
  };

  // 可控滚动
  Object.defineProperty(w, 'scrollY', { value: 0, writable: true, configurable: true });
  Object.defineProperty(w, 'pageYOffset', { value: 0, writable: true, configurable: true });

  // fetch stub：按 after 游标返回对应页
  let fetchCalls = [];
  w.fetch = async (url) => {
    fetchCalls.push(String(url));
    const u = new URL(url, 'https://github.com');
    const after = u.searchParams.get('after');
    const pageNum = after ? parseInt(after, 10) : 1;
    const hasNext = pageNum < 6; // 总共 6 页
    return { ok: true, status: 200, text: async () => pageHTML(pageNum, hasNext) };
  };
  w.__fetchCalls = fetchCalls;

  // 注入脚本
  w.eval(SRC);

  // 调成测试友好配置
  const cfg = w.GHStarsInfinite.config;
  cfg.minIntervalMs = 0;
  cfg.prefetchPx = 0;
  cfg.recycle = true;
  cfg.recycleAbovePx = 1400;
  cfg.maxCachedPages = (maxCachedPages == null ? 0 : maxCachedPages);

  return dom;
}

// 把某页所有节点标记为「已在视口上方」
function pushPageAbove(w, pageIdx) {
  const nodes = w.document.querySelectorAll(`[data-gh-star-page="${pageIdx}"]`);
  nodes.forEach(n => { n.__rect = { top: -2100, bottom: -2000, height: ITEM_H, left: 0, right: 100, width: 100, x: 0, y: -2100 }; });
}

// 等待一次加载完成
async function loadOne(w) {
  const st = w.GHStarsInfinite.state;
  if (st.done) return;
  w.GHStarsInfinite.loadMore();
  for (let i = 0; i < 200; i++) {
    await tick();
    if (!st.loading) break;
  }
}

// 触发一次「向上滚」并让 rAF 回收逻辑跑完
async function scrollUp(w) {
  const st = w.GHStarsInfinite.state;
  st.lastScrollY = 200;            // 假装之前在下方
  w.scrollY = 0;                   // 现在回到顶部 => 向上滚
  w.dispatchEvent(new w.Event('scroll'));
  await tick(); await tick();
}

async function run() {
  /* ============ 情形 1 & 2：回收 + 缓存命中补回 ============ */
  console.log('\n[情形 1/2] 回收 + 回看补回（缓存命中）');
  {
    const dom = makeDom(0);
    const w = dom.window;
    const st = w.GHStarsInfinite.state;

    ok('启动后首页（第1页）已入缓存', st.pages.length === 1 && st.pages[0].index === 1);
    ok('首页 5 个节点已在 DOM', w.document.querySelectorAll('[data-gh-star-page="1"]').length === 5);

    // 再加载一页，凑成两页
    await loadOne(w);
    ok('加载后共 2 页', st.pages.length === 2, st.pages.length);
    ok('第2页 5 个节点已在 DOM', w.document.querySelectorAll('[data-gh-star-page="2"]').length === 5);

    // 把第1页推到视口上方并回收
    pushPageAbove(w, 1);
    w.GHStarsInfinite.recycleNow();
    await tick();

    const p1 = st.pages[0];
    ok('第1页被标记为已回收', p1.recycled === true);
    ok('第1页节点已从 DOM 摘除', w.document.querySelectorAll('[data-gh-star-page="1"]').length === 0);
    const ph = w.document.querySelector('.ghsi-pholder[data-gh-page="1"]');
    ok('出现了第1页的占位块', !!ph);
    ok('占位块高度 = 5×100 = 500px', ph && ph.style.height === '500px', ph && ph.style.height);
    ok('第2页仍在 DOM（未被误回收）', w.document.querySelectorAll('[data-gh-star-page="2"]').length === 5);

    // 回看：把占位块放进缓冲距离内，向上滚
    ph.__rect = { top: -600, bottom: -500, height: 500, left: 0, right: 100, width: 100, x: 0, y: -600 };
    await scrollUp(w);

    ok('回看后第1页节点已补回 DOM', w.document.querySelectorAll('[data-gh-star-page="1"]').length === 5);
    ok('占位块已移除', !w.document.querySelector('.ghsi-pholder[data-gh-page="1"]'));
    ok('第1页回收标记已清除', p1.recycled === false);

    dom.window.close();
  }

  /* ============ 情形 3：缓存驱逐 + 回看重新拉取 ============ */
  console.log('\n[情形 3] 缓存驱逐（maxCachedPages=1）+ 回看重新拉取');
  {
    const dom = makeDom(1);
    const w = dom.window;
    const st = w.GHStarsInfinite.state;

    // 加载到第 4 页（首页 + 3 次加载）
    await loadOne(w);
    await loadOne(w);
    await loadOne(w);
    ok('共 4 页', st.pages.length === 4, st.pages.length);

    // 把全部 4 页推到上方并回收
    for (let p = 1; p <= 4; p++) pushPageAbove(w, p);
    w.GHStarsInfinite.recycleNow();
    await tick();

    ok('四页全部回收', st.pages.every(p => p.recycled === true));
    // maxCachedPages=1 => 只保留最新 1 页（第4页）的节点
    ok('第1~3页节点缓存被驱逐', st.pages.slice(0, 3).every(p => p.nodes.length === 0), st.pages.map(p => p.nodes.length));
    ok('第4页节点缓存保留', st.pages[3].nodes.length === 5);

    const callsBefore = w.__fetchCalls.length;

    // 回看第1页：缓存已空，应走网络重新拉取
    const ph1 = w.document.querySelector('.ghsi-pholder[data-gh-page="1"]');
    ph1.__rect = { top: -600, bottom: -500, height: 500, left: 0, right: 100, width: 100, x: 0, y: -600 };
    await scrollUp(w);

    // 异步补回，轮询等待
    for (let i = 0; i < 200; i++) {
      await tick();
      if (st.pages[0].recycled === false && st.pages[0].nodes.length === 5) break;
    }
    ok('第1页通过重新拉取补回', st.pages[0].nodes.length === 5 && st.pages[0].recycled === false);
    ok('第1页节点已回 DOM', w.document.querySelectorAll('[data-gh-star-page="1"]').length === 5);
    ok('占位块已移除', !w.document.querySelector('.ghsi-pholder[data-gh-page="1"]'));
    ok('触发了重新拉取（含首页 URL）', w.__fetchCalls.length > callsBefore);

    dom.window.close();
  }

  console.log(`\n结果：通过 ${passed}，失败 ${failed}`);
  process.exit(failed ? 1 : 0);
}

run().catch(e => { console.error('测试异常：', e); process.exit(2); });
