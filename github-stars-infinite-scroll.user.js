// ==UserScript==
// @name         GitHub Stars 无限滚动
// @name:zh-CN   GitHub Stars 无限滚动
// @namespace    https://github.com/
// @version      1.3.0
// @description  在任意 GitHub 用户的 Stars 标签页实现无限滚动：滚动接近底部自动加载下一页并追加到列表末尾，隐藏原生分页按钮，加载完给出「已到底」提示，失败后滚动即可重试；支持滚动回收——把视口上方已浏览的整页换成等高占位块，回看时再补回，长列表（几百上千个星标）不再卡顿。
// @author       zopdems
// @license      MIT
// @homepageURL  https://github.com/zopdems/github-stars-infinite-scroll
// @supportURL   https://github.com/zopdems/github-stars-infinite-scroll/issues
// @downloadURL  https://raw.githubusercontent.com/zopdems/github-stars-infinite-scroll/main/github-stars-infinite-scroll.user.js
// @updateURL    https://raw.githubusercontent.com/zopdems/github-stars-infinite-scroll/main/github-stars-infinite-scroll.user.js
// @match        https://github.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * ──────────────────────────────────────────────────────────────
 *  GitHub Stars 无限滚动
 *
 *  实测（2026-10）GitHub Stars 标签页的真实行为：
 *   1. 分页不是 ?page=N，而是游标 ?after=<cursor>&tab=stars
 *      —— 实测 ?page=2 返回的是第一页，完全无效。
 *   2. 下一页地址必须取自分页区 "Next" 链接的 href，
 *      它会同时带上排序参数（user_lists_sort / direction）。
 *   3. 仓库列表位于 <turbo-frame id="user-starred-repos">，
 *      每个条目是它的直接子元素 div.col-12 ... border-bottom。
 *   4. 请求时带 Turbo-Frame: user-starred-repos 请求头，
 *      GitHub 会只返回该帧的 HTML 片段（约 193KB，整页是 328KB）。
 *   5. 最后一页根本没有 .paginate-container —— 这就是终止信号。
 * ──────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ============================ 配置 ============================ */
  const CONFIG = {
    frameId: 'user-starred-repos', // Stars 列表所在的 turbo-frame id
    preloadPx: 900,                // 距底部还有多少像素就开始预加载
    minIntervalMs: 350,            // 两次请求的最小间隔（ms），防抖/防风控
    maxRetry: 3,                   // 同一页自动重试次数
    backoffMs: 1500,               // 失败重试的基础退避（ms），实际 = backoffMs * 失败次数
    maxPages: 500,                 // 安全阀：最多加载多少页
    debug: false,                  // 打开后会在控制台打印日志

    /* ---- 长列表性能（几百上千条时的卡顿/白屏）---- */
    contentVisibility: true, // 视口外的条目跳过布局与绘制，卡顿和回滚白屏的主要解法
    itemHeight: 128,         // 条目占位高度估计（px），仅用于滚动条，实际渲染后会自动校正
    chunkSize: 8,            // 每帧最多挂载几个条目，避免一次性 30 条造成长任务
    prefetchPx: 3000,        // 空闲时提前预取的距离（消掉下滑时的"等待期"）
    maxBurstPages: 3,        // 一轮连续自动加载几页就停（0 = 不限）。停下后滚动或点「继续」再加载下一轮
    softCap: 0,              // 0 = 不限；>0 表示加载到该数量后改为手动点「继续」

    /* ---- 滚动回收：解决"加载全了之后继续浏览卡顿" ---- */
    recycle: true,           // 开启后，视口上方已翻过去的整页会被摘成等高占位块，回看时再补回
    recycleAbovePx: 1400,    // 整页滑出视口上方超过这个距离（px）就回收；回看时占位块进入该距离内即补回
    maxCachedPages: 0        // 0=缓存所有已加载页（回看瞬时补回）；>0=只保留最近 N 页的节点，更久远的回看会重新拉取
  };

  // GitHub 保留路径，避免把 /topics/xxx 之类误认为用户名
  const RESERVED = new Set([
    'about', 'account', 'apps', 'collections', 'contact', 'codespaces', 'customer-stories',
    'dashboard', 'discussions', 'enterprise', 'events', 'explore', 'features', 'fluidicon',
    'git-guides', 'industries', 'issues', 'join', 'login', 'logout', 'logos', 'manifest',
    'marketplace', 'new', 'notifications', 'opensearch', 'orgs', 'organizations', 'premium-support',
    'pricing', 'pulls', 'readme', 'resources', 'robots.txt', 'search', 'security', 'sessions',
    'settings', 'signup', 'site', 'skills', 'solutions', 'sponsors', 'team', 'topics', 'trending',
    'users', 'watching'
  ]);

  const REPO_PATH = /^\/([^/]+)\/([^/]+)\/?$/;
  const STYLE_ID = 'gh-stars-infinite-style';
  const SENTINEL_ID = 'gh-stars-infinite-sentinel';
  const END_ID = 'gh-stars-infinite-end';
  const STATUS_ID = 'gh-stars-infinite-status';
  const HTML_FLAG = 'gh-stars-infinite';

  const log = (...args) => { if (CONFIG.debug) console.log('[GH-Stars-Infinite]', ...args); };
  const warn = (...args) => console.warn('[GH-Stars-Infinite]', ...args);

  /* ============================ 状态 ============================ */
  const state = {
    frame: null,
    sentinel: null,
    endMarker: null,
    statusEl: null,
    observer: null,
    nextUrl: null,
    seen: new Set(),
    pages: [],              // 按加载顺序：每页一个对象 {index,nodes,url,nextUrl,realHeight,recycled,placeholder,fetching}
    pageMap: {},            // index -> pages 中的对象，O(1) 查找
    loadedUrl: null,        // 当前正在/刚加载这一页用的请求 URL（供回看重新拉取）
    page: 1,
    loading: false,
    done: false,
    fails: 0,
    lastLoad: 0,
    scheduled: null,
    retryHandler: null,
    moTimer: null,
    capReleased: false,
    prefetching: false,
    burst: 0,
    burstPaused: false,
    recycleScheduled: false,
    lastScrollY: 0
  };

  /* ======================= 主线程让出工具 ======================= */

  // 让出一帧：把长任务切成小块，滚动时不再被 append 卡住
  const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));

  // 空闲时再做：requestIdleCallback 不可用就退化成 setTimeout
  function onIdle(fn, timeout) {
    if (typeof window.requestIdleCallback === 'function') {
      return window.requestIdleCallback(fn, { timeout: timeout || 1000 });
    }
    return setTimeout(fn, 1);
  }

  /** 给条目打标记，使其享受 content-visibility 优化 */
  function markItem(node) {
    if (CONFIG.contentVisibility) node.classList.add('ghsi-item');
  }

  /* ======================= 滚动回收 / 回看补回 =======================
   * 思路：把"已加载的每一页"整块缓存下来（state.pages）。
   *   - 整页滑出视口上方超过 recycleAbovePx  -> 把这一页的真实节点从 DOM 摘掉，
   *     换成唯一一个等高占位块（高度 = 该页真实高度）。滚动位置不跳变，
   *     因为占位块高度与摘掉的节点总高一致。
   *   - 往上回看，占位块重新进入 recycleAbovePx 距离内 -> 把缓存的真实节点插回原位。
   *     缓存被驱逐时（maxCachedPages>0）才走网络重新拉取。
   * 这样无论加载多少页，DOM 里始终只保留"视口附近几页"，长列表不再卡顿。
   * ================================================================== */

  /** 把一页整块回收成等高占位块（节点已不在 DOM 里，仅留占位块） */
  function recyclePage(page) {
    if (page.recycled || !page.nodes || !page.nodes.length) return;
    const lastNode = page.nodes[page.nodes.length - 1];
    const nextSib = lastNode.nextSibling; // 记录插入点，回收后占位块插在这儿

    // 测量真实高度（只测一次并缓存）：content-visibility:auto 下离屏节点仍占其固有高度
    let h = page.realHeight;
    if (h == null) {
      h = 0;
      for (const n of page.nodes) h += (n.getBoundingClientRect().height || CONFIG.itemHeight);
      page.realHeight = h || CONFIG.itemHeight * page.nodes.length;
    }

    const ph = document.createElement('div');
    ph.className = 'ghsi-pholder';
    ph.style.height = page.realHeight + 'px';
    ph.dataset.ghPage = String(page.index);
    state.frame.insertBefore(ph, nextSib);
    page.nodes.forEach(n => n.remove());
    page.placeholder = ph;
    page.recycled = true;
    log('回收第', page.index, '页（', page.nodes.length, '条 -> 占位块', Math.round(page.realHeight), 'px）');
  }

  /** 把占位块补回成真实节点（优先用缓存，缓存被驱逐则重新拉取） */
  function rehydratePage(page) {
    if (!page.recycled) return;
    const ph = page.placeholder;
    if (!ph || !ph.isConnected) return;

    if (page.nodes && page.nodes.length) {
      const nextSib = ph.nextSibling;
      const frag = document.createDocumentFragment();
      for (const n of page.nodes) frag.appendChild(n);
      state.frame.insertBefore(frag, nextSib);
      ph.remove();
      page.placeholder = null;
      page.recycled = false;
      log('补回第', page.index, '页（缓存，', page.nodes.length, '条）');
    } else {
      rehydratePageAsync(page);   // 缓存没了，走网络
    }
  }

  /** 缓存被驱逐时的异步补回：用这一页当初的 URL 重新拉取并插回 */
  async function rehydratePageAsync(page) {
    if (page.fetching) return;
    page.fetching = true;
    const ph = state.frame.querySelector('.ghsi-pholder[data-gh-page="' + page.index + '"]');
    try {
      if (!ph) { page.fetching = false; return; }
      const html = await fetchPage(page.url, true);
      const doc = parseDoc(html);
      const frame = findFrame(doc);
      const items = extractItems(frame);
      const nodes = [];
      for (const el of items) {
        const key = itemKey(el);
        if (!key) continue;
        const node = document.importNode(el, true);
        node.setAttribute('data-gh-star-page', String(page.index));
        markItem(node);
        nodes.push(node);
      }
      page.nodes = nodes;
      if (!nodes.length) { page.fetching = false; return; }
      const frag = document.createDocumentFragment();
      for (const n of nodes) frag.appendChild(n);
      const phNow = state.frame.querySelector('.ghsi-pholder[data-gh-page="' + page.index + '"]');
      if (phNow) state.frame.insertBefore(frag, phNow.nextSibling);
      if (phNow) phNow.remove();
      page.placeholder = null;
      page.recycled = false;
      log('补回第', page.index, '页（重新拉取，', nodes.length, '条）');
    } catch (e) {
      warn('回看补回失败（第 ' + page.index + ' 页）：', (e && e.message) || e);
      // 占位块保留，下次滚动到它附近再试
    } finally {
      page.fetching = false;
    }
  }

  /** 驱逐过多缓存：只回收过的页里，除最近 maxCachedPages 页外，清掉节点缓存 */
  function maybeEvictCache() {
    if (CONFIG.maxCachedPages <= 0) return;
    const cached = state.pages.filter(p => p.recycled && p.nodes && p.nodes.length);
    if (cached.length <= CONFIG.maxCachedPages) return;
    const toEvict = cached.slice(0, cached.length - CONFIG.maxCachedPages);
    for (const p of toEvict) p.nodes = [];   // 占位块仍在，节点交还给 GC
  }

  /** rAF 节流：根据滚动方向分别做回收 / 补回，避免每帧强制布局 */
  function scheduleRecycle() {
    if (state.recycleScheduled || !CONFIG.recycle) return;
    state.recycleScheduled = true;
    requestAnimationFrame(() => {
      state.recycleScheduled = false;
      if (!CONFIG.recycle || !state.frame || !state.pages.length) return;
      const y = window.scrollY || window.pageYOffset || 0;
      const goingDown = y >= state.lastScrollY;
      state.lastScrollY = y;
      if (goingDown) recycleAbove();
      else rehydrateAbove();
    });
  }

  /** 向下滚：把整页滑出视口上方的页回收成占位块 */
  function recycleAbove() {
    const line = -CONFIG.recycleAbovePx; // 视口顶之上 this px 处为回收线
    for (const page of state.pages) {
      if (page.recycled || !page.nodes || !page.nodes.length) continue;
      const firstNode = page.nodes[0];
      if (!firstNode.isConnected) continue;
      // 取这一页最底部节点的下沿，若它都在回收线之上 => 整页已离开视口
      const lastNode = page.nodes[page.nodes.length - 1];
      const bottom = lastNode.getBoundingClientRect().bottom;
      if (bottom < line) {
        recyclePage(page);
        maybeEvictCache();
      } else {
        break; // 后面的页更靠下，肯定还没离开，停止扫描
      }
    }
  }

  /** 向上滚：把重新进入缓冲距离的占位块补回真实节点 */
  function rehydrateAbove() {
    const band = -CONFIG.recycleAbovePx; // 占位块下沿进入该线内即补回
    for (const page of state.pages) {
      if (!page.recycled || !page.placeholder || !page.placeholder.isConnected) continue;
      const r = page.placeholder.getBoundingClientRect();
      if (r.bottom >= band) rehydratePage(page);
    }
  }

  /* ======================= 页面识别与工具 ======================= */

  /** 当前是否是某个用户的 Stars 标签页（对任意用户名生效） */
  function isStarsPage() {
    if (location.hostname !== 'github.com') return false;
    if (new URLSearchParams(location.search).get('tab') !== 'stars') return false;
    const seg = location.pathname.split('/').filter(Boolean);
    if (seg.length !== 1) return false;              // 只认 /{user} 这种单段路径
    return !RESERVED.has(seg[0].toLowerCase());
  }

  /** 取列表容器：优先 turbo-frame#user-starred-repos，逐级降级 */
  function findFrame(doc) {
    return doc.getElementById(CONFIG.frameId) ||
           doc.querySelector('turbo-frame#' + CONFIG.frameId) ||
           doc.querySelector('main') ||
           doc.body;
  }

  /** 条目的唯一 key = owner/repo（小写）。不是仓库条目则返回 null */
  function itemKey(el) {
    if (!el || el.nodeType !== 1) return null;
    const a = el.querySelector('h3 a[href]');
    if (!a) return null;
    let pathname;
    try {
      pathname = new URL(a.getAttribute('href'), location.href).pathname;
    } catch (e) { return null; }
    const m = REPO_PATH.exec(pathname);
    if (!m) return null;
    if (RESERVED.has(m[1].toLowerCase())) return null;
    return (m[1] + '/' + m[2]).toLowerCase();
  }

  /**
   * 从容器里抽出仓库条目。
   * 注意：条目外层有一层 wrapper，不能直接取 frame.children
   * （那样会把整个 wrapper 当成一个条目），必须深度查找后再
   * 剔除「包含其它候选元素」的父级，只保留最内层的条目节点。
   */
  const ITEM_SELECTORS = [
    'div[class*="col-12"][class*="border-bottom"]',
    'div[class*="border-bottom"]',
    'div[class*="width-full"]'
  ];

  function extractItems(frame) {
    for (const sel of ITEM_SELECTORS) {
      const cands = Array.from(frame.querySelectorAll(sel)).filter(el => itemKey(el));
      const top = cands.filter(el => !cands.some(o => o !== el && o.contains(el)));
      if (top.length) return top;
    }
    return Array.from(frame.children).filter(el => itemKey(el));
  }

  /** 从分页区取下一页 URL（游标地址）。没有分页区 / 没有 Next 链接 => null */
  function extractNextUrl(scope) {
    const root = scope || document;
    const boxes = root.querySelectorAll('.paginate-container, [data-test-selector="pagination"]');
    for (const box of boxes) {
      const links = Array.from(box.querySelectorAll('a[href]'));
      const next =
        links.find(a => /^\s*(next|下一页|下页)\s*$/i.test((a.textContent || '').trim())) ||
        links.find(a => /next|下一页/i.test(a.getAttribute('aria-label') || '')) ||
        links.find(a => /next|下一页/i.test((a.textContent || '')));
      if (!next) continue;
      try {
        const url = new URL(next.getAttribute('href'), location.href);
        if (url.origin !== location.origin) continue;
        return url.href;
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  /* ============================ 样式 ============================ */

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
/* 1) 隐藏原生分页按钮（只作用于 Stars 列表所在区域） */
html.${HTML_FLAG} main .paginate-container,
html.${HTML_FLAG} main [data-test-selector="pagination"] { display: none !important; }

/* 2) 触发哨兵 */
#${SENTINEL_ID} { height: 1px; width: 100%; }

/* 2.5) 长列表性能：视口外的条目跳过布局与绘制。
   条目真实渲染过一次后浏览器会记住实际高度（auto 关键字），
   所以滚动条长度不会跑偏；这里给的高度只是首次出现前的占位估计。 */
html.${HTML_FLAG} .ghsi-item {
  content-visibility: auto;
  contain-intrinsic-height: auto var(--ghsi-item-h, 128px);
}

/* 3) 状态提示胶囊 */
#${STATUS_ID} {
  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
  z-index: 2147483000; display: flex; align-items: center; gap: 8px;
  max-width: 88vw; padding: 8px 14px; border-radius: 999px;
  font: 400 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
  color: var(--fgColor-default, #1f2328);
  background: var(--bgColor-default, #ffffff);
  border: 1px solid var(--borderColor-default, #d1d9e0);
  box-shadow: 0 4px 14px rgba(31, 35, 40, .18);
  user-select: none;
}
#${STATUS_ID}[data-state="idle"]  { opacity: .78; }
#${STATUS_ID}[data-state="done"]  { opacity: .92; }
#${STATUS_ID}[data-state="error"] {
  color: var(--fgColor-danger, #cf222e);
  border-color: var(--borderColor-danger-emphasis, #cf222e);
}
#${STATUS_ID} .ghsi-spin {
  width: 12px; height: 12px; border-radius: 50%; flex: none;
  border: 2px solid var(--borderColor-default, #d1d9e0);
  border-top-color: var(--fgColor-accent, #0969da);
  animation: ghsi-rotate .7s linear infinite;
}
@keyframes ghsi-rotate { to { transform: rotate(360deg); } }
#${STATUS_ID} .ghsi-btn {
  flex: none; cursor: pointer; padding: 2px 8px; border-radius: 999px;
  font: inherit; color: inherit;
  background: var(--bgColor-muted, #f6f8fa);
  border: 1px solid var(--borderColor-default, #d1d9e0);
}
#${STATUS_ID} .ghsi-btn:hover { background: var(--bgColor-neutral-muted, #eaeef2); }
@media (prefers-reduced-motion: reduce) {
  #${STATUS_ID} .ghsi-spin { animation-duration: 2s; }
}
`;
    // 条目占位高度由 CONFIG.itemHeight 决定，用 CSS 变量传给样式表
    document.documentElement.style.setProperty('--ghsi-item-h', CONFIG.itemHeight + 'px');
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  /* ========================== 状态提示 ========================== */

  function ensureStatusEl() {
    if (state.statusEl && state.statusEl.isConnected) return state.statusEl;
    const el = document.createElement('div');
    el.id = STATUS_ID;
    el.dataset.state = 'idle';
    document.body.appendChild(el);
    state.statusEl = el;
    return el;
  }

  /** kind: idle | loading | error | done；action: { label, onClick } 可选 */
  function setStatus(kind, text, action) {
    const el = ensureStatusEl();
    el.dataset.state = kind;
    el.innerHTML = '';
    if (kind === 'loading') {
      const sp = document.createElement('span');
      sp.className = 'ghsi-spin';
      el.appendChild(sp);
    }
    const t = document.createElement('span');
    t.textContent = text;
    el.appendChild(t);
    if (kind === 'error' && !action) {
      action = {
        label: '重试',
        onClick: () => {
          state.fails = 0;
          unbindRetryOnScroll();
          maybeLoad(true);
        }
      };
    }
    if (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ghsi-btn';
      btn.textContent = action.label;
      btn.addEventListener('click', action.onClick);
      el.appendChild(btn);
    }
  }

  /* ========================== 请求与解析 ========================== */

  async function fetchPage(url, useTurboFrame) {
    const headers = {
      'Accept': 'text/html,application/xhtml+xml',
      'X-Requested-With': 'XMLHttpRequest'
    };
    if (useTurboFrame) headers['Turbo-Frame'] = CONFIG.frameId;
    const res = await fetch(url, {
      method: 'GET',
      headers: headers,
      credentials: 'same-origin',
      redirect: 'follow'
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  }

  function parseDoc(html) {
    return new DOMParser().parseFromString(html, 'text/html');
  }

  /* ============================ 加载 ============================ */

  function maybeLoad(force) {
    if (state.done || state.loading) return;
    loadNext(force);
  }

  /** 软上限：加载太多条目会让页面变重，到量后改为手动点「继续」 */
  function atSoftCap() {
    return CONFIG.softCap > 0 && !state.capReleased && state.seen.size >= CONFIG.softCap;
  }

  function showCapStatus() {
    setStatus('idle', '已加载 ' + state.seen.size + ' 个仓库 · 已达软上限', {
      label: '继续',
      onClick: () => {
        state.capReleased = true;
        maybeLoad(true);
      }
    });
  }

  /** 一轮加载够了：停下，等用户继续滚动或点「继续」再开下一轮 */
  function showBurstPause() {
    state.burstPaused = true;
    setStatus('idle', '已加载 ' + state.seen.size + ' 个仓库 · 继续向下滚动', {
      label: '继续',
      onClick: () => {
        state.burst = 0;
        state.burstPaused = false;
        maybeLoad(true);
      }
    });
  }

  /** 用户真的滚动了 -> 重置一轮的计数，并让 IO 重新判断是否继续加载 */
  function onUserScroll() {
    if (!state.burstPaused || state.done || state.loading) return;
    state.burstPaused = false;
    state.burst = 0;
    afterAppend();   // 重新 observe：由 IntersectionObserver 判断哨兵是否还在范围内
  }

  async function loadNext(force) {
    if (state.done || state.loading) return;

    if (!state.nextUrl) { finish(); return; }
    if (state.page >= CONFIG.maxPages) { finish(); return; }
    if (atSoftCap()) { showCapStatus(); return; }
    // 一轮最多加载 maxBurstPages 页，别一口气把几十页全灌进 DOM。
    // 只约束「自动」路径（哨兵/预取）；手动点继续、控制台调用、失败重试不受限。
    if (CONFIG.maxBurstPages > 0 && !force && state.burst >= CONFIG.maxBurstPages) {
      showBurstPause();
      return;
    }

    // 节流：两次请求之间至少间隔 minIntervalMs
    const wait = CONFIG.minIntervalMs - (Date.now() - state.lastLoad);
    if (!force && wait > 0) {
      if (state.scheduled) return;
      state.scheduled = setTimeout(() => { state.scheduled = null; loadNext(); }, wait);
      return;
    }

    state.loading = true;
    state.lastLoad = Date.now();
    state.page += 1;
    setStatus('loading', '正在加载第 ' + state.page + ' 页…');

    const url = state.nextUrl;
    let doc, frame, items;
    try {
      // 首选：带 Turbo-Frame 头，只拿片段
      doc = parseDoc(await fetchPage(url, true));
      frame = findFrame(doc);
      items = extractItems(frame);

      // 兜底：拿不到条目就不带头重抓整页再解析一次
      if (!items.length) {
        log('片段解析为空，改用整页解析');
        doc = parseDoc(await fetchPage(url, false));
        frame = findFrame(doc);
        items = extractItems(frame);
      }

      if (!items.length) {
        warn('未解析到仓库条目，终止加载（GitHub 结构可能已变化）');
        state.loading = false;
        finish();
        return;
      }

      // 先让出一帧再动手挂载，别和正在进行的滚动抢主线程
      state.loadedUrl = url;
      await nextFrame();
      const added = await appendItems(items);
      state.nextUrl = extractNextUrl(doc);
      if (state.pageMap[state.page]) state.pageMap[state.page].nextUrl = state.nextUrl;
      state.fails = 0;
      state.loading = false;
      if (added > 0) state.burst += 1;   // 只有真的加进了新条目才算这一轮用掉一页

      if (!state.nextUrl || added === 0) {
        finish();
        return;
      }
      if (atSoftCap()) { showCapStatus(); return; }
      setStatus('idle', '已加载 ' + state.seen.size + ' 个仓库 · 继续向下滚动');
      afterAppend();
      schedulePrefetch();
    } catch (err) {
      state.loading = false;
      state.page -= 1;
      state.fails += 1;
      const msg = (err && err.message) ? err.message : String(err);
      warn('第 ' + (state.page + 1) + ' 页加载失败：', msg);

      if (state.fails >= CONFIG.maxRetry) {
        setStatus('error', '加载失败：' + msg + '（已重试 ' + state.fails + ' 次，滚动页面可再试）');
      } else {
        const delay = CONFIG.backoffMs * state.fails;
        setStatus('error', '加载失败：' + msg + '，' + Math.round(delay / 1000) + 's 后重试…');
        setTimeout(() => {
          if (state.done || state.loading) return;
          maybeLoad(true);
        }, delay);
      }
      bindRetryOnScroll();
    }
  }

  /**
   * 追加条目（按 owner/repo 去重），返回新增数量。
   * 分块挂载：每块最多 chunkSize 条，块与块之间让出一帧。
   * 一次性挂载 30 条（每条含内联 SVG）会形成一个几十毫秒的长任务，
   * 正好卡在滚动帧上 —— 这就是"下滑卡顿"的来源。
   */
  async function appendItems(items) {
    const pending = [];
    for (const el of items) {
      const key = itemKey(el);
      if (!key || state.seen.has(key)) continue;
      state.seen.add(key);
      pending.push(el);
    }
    if (!pending.length) return 0;

    const nodes = [];
    let added = 0;
    const size = Math.max(1, CONFIG.chunkSize);
    for (let i = 0; i < pending.length; i += size) {
      const frag = document.createDocumentFragment();
      for (const el of pending.slice(i, i + size)) {
        const node = document.importNode(el, true);
        node.setAttribute('data-gh-star-page', String(state.page));
        markItem(node);
        frag.appendChild(node);
        nodes.push(node);
        added += 1;
      }
      // 插到哨兵之前，保证哨兵恒定在列表最底部（这样自动加载才能一路触发）
      if (state.sentinel && state.sentinel.parentNode === state.frame) {
        state.frame.insertBefore(frag, state.sentinel);
      } else {
        state.frame.appendChild(frag);
      }
      if (i + size < pending.length) await nextFrame();  // 留出渲染机会
    }

    // 按页缓存：把这一页的节点整块记下来，供滚动回收 / 回看补回
    const pageObj = {
      index: state.page,
      nodes: nodes,
      url: state.loadedUrl,     // 这一页当初用的请求 URL（回看重新拉取用）
      nextUrl: null,            // 解析后由 loadNext 补上
      realHeight: null,
      recycled: false,
      placeholder: null,
      fetching: false
    };
    state.pages.push(pageObj);
    state.pageMap[state.page] = pageObj;

    log('追加', added, '条（第', state.page, '页），累计', state.seen.size);
    return added;
  }

  /**
   * 追加后重新观察哨兵：若它仍在预取范围内，IntersectionObserver 会再次回调。
   * 用重新 observe 代替 getBoundingClientRect —— 后者会在一个已经很长的
   * 列表上触发一次强制同步布局，滚一次卡一次。
   */
  function afterAppend() {
    if (state.done || state.loading || !state.sentinel || !state.observer) return;
    state.observer.unobserve(state.sentinel);
    state.observer.observe(state.sentinel);
    scheduleRecycle();   // 新页加载后，顺手把已经滑出上方的旧页回收掉
  }

  /** 空闲时提前多取一页，消掉下滑到 Boundary 时的那段"等待期" */
  function schedulePrefetch() {
    if (state.done || state.prefetching || !CONFIG.prefetchPx || !state.sentinel) return;
    state.prefetching = true;
    onIdle(() => {
      state.prefetching = false;
      if (state.done || state.loading || !state.sentinel) return;
      const r = state.sentinel.getBoundingClientRect();
      if (r.top < window.innerHeight + CONFIG.prefetchPx) maybeLoad();
    }, 2000);
  }

  function finish() {
    state.done = true;
    state.loading = false;
    state.nextUrl = null;
    if (state.observer && state.sentinel) {
      try { state.observer.unobserve(state.sentinel); } catch (e) { /* ignore */ }
    }
    if (state.sentinel) {
      try { state.sentinel.remove(); } catch (e) { /* ignore */ }
      state.sentinel = null;
    }
    // 在列表末尾留一个「到底」标记。
    // 关键：到底后哨兵会被移除，MutationObserver 若因此判定"脚本没初始化"
    // 就会重新 reset()，导致 done 被清掉、反复重启加载。这个标记用来挡住它。
    if (state.frame) {
      let marker = state.frame.querySelector('#' + END_ID);
      if (!marker) {
        marker = document.createElement('div');
        marker.id = END_ID;
        state.frame.appendChild(marker);
      }
      state.endMarker = marker;
    }
    setStatus('done', '已到底 · 共 ' + state.seen.size + ' 个仓库 / ' + state.page + ' 页');
  }

  /* ========================== 失败重试 ========================== */

  // 失败后 IO 不会因为「哨兵一直在视口里」而再次触发，
  // 所以额外挂一个滚动监听：下次滚动即重试。
  function bindRetryOnScroll() {
    if (state.retryHandler) return;
    const handler = () => {
      if (state.done || state.loading) return;
      unbindRetryOnScroll();
      state.fails = 0;
      maybeLoad(true);
    };
    state.retryHandler = handler;
    window.addEventListener('scroll', handler, { passive: true });
    document.addEventListener('scroll', handler, { passive: true, capture: true });
  }

  function unbindRetryOnScroll() {
    if (!state.retryHandler) return;
    window.removeEventListener('scroll', state.retryHandler, { passive: true });
    document.removeEventListener('scroll', state.retryHandler, { capture: true });
    state.retryHandler = null;
  }

  /* ========================== 初始化 ========================== */

  function createSentinel(frame) {
    const s = document.createElement('div');
    s.id = SENTINEL_ID;
    frame.appendChild(s);
    return s;
  }

  function reset(frame) {
    teardown(false);

    state.frame = frame;
    state.seen = new Set();
    state.page = 1;
    state.done = false;
    state.loading = false;
    state.fails = 0;
    state.pages = [];
    state.pageMap = {};
    state.loadedUrl = null;
    state.lastScrollY = window.scrollY || window.pageYOffset || 0;

    // 用页面上已有的条目铺底，避免重复；同时给它们打上优化标记
    // （首页那 30 条同样参与长列表渲染，不标记的话第一屏之后照样卡）
    const firstNodes = [];
    for (const el of extractItems(frame)) {
      const k = itemKey(el);
      if (!k) continue;
      state.seen.add(k);
      markItem(el);
      el.setAttribute('data-gh-star-page', '1');   // 与后续加载的页保持一致，方便回收/查询
      firstNodes.push(el);
    }
    state.nextUrl = extractNextUrl(frame);

    // 首页（第 1 页）同样是"按页缓存"的一部分，方便回看时也能回收/补回
    const firstPage = {
      index: 1,
      nodes: firstNodes,
      url: location.href,
      nextUrl: state.nextUrl,
      realHeight: null,
      recycled: false,
      placeholder: null,
      fetching: false
    };
    state.pages.push(firstPage);
    state.pageMap[1] = firstPage;

    document.documentElement.classList.add(HTML_FLAG);
    injectStyle();
    state.sentinel = createSentinel(frame);
    ensureStatusEl();

    state.observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) maybeLoad();
    }, { rootMargin: '0px 0px ' + CONFIG.preloadPx + 'px 0px', threshold: 0 });
    state.observer.observe(state.sentinel);

    if (!state.nextUrl) {
      finish();
    } else {
      setStatus('idle', '已加载 ' + state.seen.size + ' 个仓库 · 向下滚动加载更多');
    }
    scheduleRecycle();
    log('已启用 ->', location.href, '| 首页条目', state.seen.size, '| next:', state.nextUrl);
  }

  function teardown(full) {
    if (state.observer) { try { state.observer.disconnect(); } catch (e) { /* ignore */ } state.observer = null; }
    if (state.sentinel) { try { state.sentinel.remove(); } catch (e) { /* ignore */ } state.sentinel = null; }
    if (state.endMarker) { try { state.endMarker.remove(); } catch (e) { /* ignore */ } state.endMarker = null; }
    unbindRetryOnScroll();
    if (state.statusEl) { try { state.statusEl.remove(); } catch (e) { /* ignore */ } state.statusEl = null; }
    if (state.scheduled) { clearTimeout(state.scheduled); state.scheduled = null; }
    if (full) document.documentElement.classList.remove(HTML_FLAG);
    state.frame = null;
    state.endMarker = null;
    state.nextUrl = null;
    state.loading = false;
    state.done = false;
    state.page = 1;
    state.fails = 0;
    state.seen = new Set();
    state.pages = [];
    state.pageMap = {};
    state.loadedUrl = null;
    state.capReleased = false;
    state.prefetching = false;
    state.burst = 0;
    state.burstPaused = false;
    state.recycleScheduled = false;
    state.lastScrollY = 0;
  }

  function boot() {
    if (!isStarsPage()) { teardown(true); return; }

    const frame = document.getElementById(CONFIG.frameId) ||
                  document.querySelector('turbo-frame#' + CONFIG.frameId);
    if (!frame) { teardown(true); return; }

    // 已经初始化过：哨兵还在（内容没被 Turbo 换掉）-> 不动
    if (state.frame === frame && state.sentinel && frame.contains(state.sentinel)) return;
    // 已经到底：结束标记还在 -> 不动
    if (state.frame === frame && state.endMarker && frame.contains(state.endMarker)) return;

    // 内容还没渲染完（条目为 0 且也不是明确的空状态）-> 等下一次变化
    const hasItems = extractItems(frame).length > 0;
    const emptyState = /hasn't starred|doesn't have any starred|no starred|haven't starred/i
      .test(frame.textContent || '');
    if (!hasItems && !emptyState) return;

    reset(frame);
  }

  /* ===================== Turbo / 导航兼容 ===================== */

  // Turbo 无刷新跳转 + 浏览器前进后退
  ['turbo:load', 'turbo:render', 'turbo:frame-load'].forEach(evt => {
    document.addEventListener(evt, () => setTimeout(boot, 60), true);
  });
  window.addEventListener('popstate', () => setTimeout(boot, 60));
  window.addEventListener('load', boot);
  document.addEventListener('DOMContentLoaded', boot);

  // 兜底：DOM 变化时（含 Turbo 换掉帧内容、切换排序）重新检查
  const mo = new MutationObserver(() => {
    if (state.moTimer) return;
    state.moTimer = setTimeout(() => {
      state.moTimer = null;
      if (!isStarsPage()) { if (state.frame) teardown(true); return; }
      if (state.frame && state.sentinel && state.frame.contains(state.sentinel)) return;
      if (state.frame && state.endMarker && state.frame.contains(state.endMarker)) return;
      boot();
    }, 250);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // 用户滚动时解除"一轮加载够了"的暂停（只在暂停时才有动作，平时零开销）
  window.addEventListener('scroll', onUserScroll, { passive: true });
  // 滚动时做回收 / 回看补回（rAF 节流，按方向分流，平时几乎零开销）
  window.addEventListener('scroll', scheduleRecycle, { passive: true });
  window.addEventListener('resize', scheduleRecycle);

  boot();

  // 方便在控制台排查 / 手动触发
  window.GHStarsInfinite = {
    config: CONFIG,
    state: state,
    pages: () => state.pages.map(p => ({
      index: p.index, recycled: p.recycled,
      cached: !!(p.nodes && p.nodes.length), count: p.nodes ? p.nodes.length : 0,
      height: p.realHeight
    })),
    loadMore: () => maybeLoad(true),
    recycleNow: () => { recycleAbove(); }
  };
})();
