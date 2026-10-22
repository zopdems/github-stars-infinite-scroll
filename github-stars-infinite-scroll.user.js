// ==UserScript==
// @name         GitHub 列表无限滚动
// @name:zh-CN   GitHub Stars 无限滚动
// @namespace    https://github.com/
// @version      1.6.0
// @description  给 GitHub 上所有可翻页的列表加自动翻页：Stars、仓库、关注者/正在关注、Fork、星标者、关注者、Issues、Pull requests、Releases、提交。滚动接近底部自动加载并追加到末尾，隐藏原生分页，到底给出提示，失败滚动重试；支持滚动回收（上方整页换等高占位块、回看补回），长列表不卡顿。
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
 *  GitHub 列表无限滚动（Stars + 仓库 / Repositories）
 *
 *  实测（2026-10）GitHub 两个标签页的真实行为：
 *
 *  ★ Stars 标签页 /{user}?tab=stars
 *   1. 分页不是 ?page=N，而是游标 ?after=<cursor>&tab=stars
 *      —— 实测 ?page=2 返回的是第一页，完全无效。
 *   2. 下一页地址必须取自分页区 "Next" 链接的 href，
 *      它会同时带上排序参数（user_lists_sort / direction）。
 *   3. 仓库列表位于 <turbo-frame id="user-starred-repos">，
 *      每个条目是它的后代 div.col-12 ... border-bottom。
 *   4. 请求时带 Turbo-Frame: user-starred-repos 请求头，
 *      GitHub 会只返回该帧的 HTML 片段（约 193KB，整页是 328KB）。
 *   5. 最后一页根本没有 .paginate-container —— 这就是终止信号。
 *
 *  ★ 仓库标签页 /{user}?tab=repositories（含 &type=source 等过滤）
 *   1. 分页是经典的 ?page=N&tab=repositories（Next 链接 a.next_page[rel=next]）。
 *      —— 注意：仓库页与 Stars 相反，?page=2 是有效的。
 *   2. 列表位于 <turbo-frame id="user-profile-frame">（整个 profile 都在这个帧里），
 *      条目是 ul > li.col-12 ... border-bottom（在 <ul> 中，不是帧的直接子元素）。
 *   3. Next 链接 href 会带上当前过滤参数（type=source / sort / q 等），复用即自动保留。
 *   4. 带 Turbo-Frame: user-profile-frame 请求头同样只返回帧片段（400KB → 270KB）。
 *   5. 最后一页的 .paginate-container 里没有 next_page 链接 —— 终止信号同上。
 *
 *  下一页 URL 一律复用分页区 Next 链接的 href，因此两套分页机制都能正确处理，
 *  排序/过滤参数也自动带上。容器、条目选择器、占位块标签按列表类型在 LISTS 里分流。
 * ──────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ============================ 配置 ============================ */
  const CONFIG = {
    // frameId / 条目选择器 / 占位块标签 / key 类型 现按列表类型在下方 LISTS 里配置
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

  /* ======================= 可翻页列表注册表 =======================
   * 每类列表的容器、条目选择器、追加容器、占位块标签、条目 key 类型都不同，
   * 全部实测（2026-10）后登记在此；加载/去重/回收/补回/重试等逻辑完全复用。
   *
   *   keyKind：repo(仓库) / user(用户) / issue / pr / commit
   *   listMode：frame=追加到帧本身；list=追加到条目的父 <ul>/<ol>；parent=追加到条目的父元素
   *
   * 分页机制有三套（游标 ?after= / 页码 ?page=N / 搜索 ?p=N），
   * 但下一页地址一律复用 Next 链接的 href，所以不用区分，过滤参数也自动带上。
   * ============================================================== */
  const LISTS = {
    /* ---------- 个人主页标签页 ---------- */
    stars: {
      label: '星标',
      match: (seg, q) => seg.length === 1 && q.get('tab') === 'stars',
      frameId: 'user-starred-repos',
      itemSelectors: [
        'div[class*="col-12"][class*="border-bottom"]',
        'div[class*="border-bottom"]',
        'div[class*="width-full"]'
      ],
      listMode: 'frame', placeholderTag: 'div', keyKind: 'repo'
    },
    repositories: {
      label: '仓库',
      match: (seg, q) => seg.length === 1 && q.get('tab') === 'repositories',
      frameId: 'user-profile-frame',
      itemSelectors: [
        'li[class*="col-12"][class*="border-bottom"]',
        'li[class*="col-12"][class*="flex-justify-between"]',
        'li[class*="col-12"]'
      ],
      listMode: 'list', placeholderTag: 'li', keyKind: 'repo'
    },
    followers: {
      label: '关注者',
      match: (seg, q) => seg.length === 1 && q.get('tab') === 'followers',
      frameId: 'user-profile-frame',
      itemSelectors: [
        'div[class*="d-table"][class*="table-fixed"]',
        'div[class*="col-12"][class*="border-bottom"]'
      ],
      listMode: 'parent', placeholderTag: 'div', keyKind: 'user'
    },
    following: {
      label: '正在关注',
      match: (seg, q) => seg.length === 1 && q.get('tab') === 'following',
      frameId: 'user-profile-frame',
      itemSelectors: [
        'div[class*="d-table"][class*="table-fixed"]',
        'div[class*="col-12"][class*="border-bottom"]'
      ],
      listMode: 'parent', placeholderTag: 'div', keyKind: 'user'
    },

    /* ---------- 仓库子页面 ---------- */
    forks: {
      label: 'Fork 分支',
      match: (seg) => seg.length === 3 && seg[2] === 'forks',
      frameId: 'repo-content-turbo-frame',
      itemSelectors: ['li.Box-row', 'ul > li'],
      listMode: 'parent', placeholderTag: 'li', keyKind: 'repo'
    },
    stargazers: {
      label: '星标者',
      match: (seg) => seg.length === 3 && seg[2] === 'stargazers',
      frameId: 'repo-content-turbo-frame',
      itemSelectors: ['li.Box-row', 'ul > li'],
      listMode: 'parent', placeholderTag: 'li', keyKind: 'user'
    },
    watchers: {
      label: '关注者',
      match: (seg) => seg.length === 3 && seg[2] === 'watchers',
      frameId: 'repo-content-turbo-frame',
      itemSelectors: ['li.Box-row', 'ul > li'],
      listMode: 'parent', placeholderTag: 'li', keyKind: 'user'
    },
    issues: {
      label: 'Issues',
      match: (seg) => seg.length === 3 && seg[2] === 'issues',
      frameId: 'repo-content-turbo-frame',
      itemSelectors: ['ul > li'],
      listMode: 'parent', placeholderTag: 'li', keyKind: 'issue'
    },
    pulls: {
      label: 'Pull requests',
      match: (seg) => seg.length === 3 && seg[2] === 'pulls',
      frameId: 'repo-content-turbo-frame',
      itemSelectors: ['ul > li'],
      listMode: 'parent', placeholderTag: 'li', keyKind: 'pr'
    },
    releases: {
      label: 'Releases',
      match: (seg) => seg.length === 3 && seg[2] === 'releases',
      frameId: 'repo-content-turbo-frame',
      itemSelectors: ['div.Box'],
      listMode: 'parent', placeholderTag: 'div', keyKind: 'release'
    },
    commits: {
      label: '提交',
      match: (seg) => seg.length >= 3 && seg[2] === 'commits',
      frameId: 'repo-content-turbo-frame',
      itemSelectors: ['li[data-testid="commit-row-item"]', 'li[data-commit-link]', 'ul > li'],
      listMode: 'parent', placeholderTag: 'li', keyKind: 'commit'
    }
  };
  const FALLBACK_ITEM_SELECTORS = LISTS.stars.itemSelectors; // state.listId 未定时兜底

  /* ---- 条目唯一 key：按 keyKind 从条目内的链接里解析 ---- */
  const KEY_PATTERNS = {
    repo:    /^\/([^/]+)\/([^/]+)\/?$/,                     // /owner/repo
    user:    /^\/([^/]+)\/?$/,                              // /username
    issue:   /^\/([^/]+)\/([^/]+)\/issues\/(\d+)/,          // /owner/repo/issues/123
    pr:      /^\/([^/]+)\/([^/]+)\/pull\/(\d+)/,            // /owner/repo/pull/123
    commit:  /^\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]{7,40})/,
    release: /^\/([^/]+)\/([^/]+)\/releases\/tag\/([^/]+)/  // /owner/repo/releases/tag/{tag}
  };

  /** 当前处于哪个受支持的列表页，返回 LISTS 的 key 或 null */
  function activeList() {
    if (location.hostname !== 'github.com') return null;
    const seg = location.pathname.split('/').filter(Boolean);
    if (seg.length && RESERVED.has(seg[0].toLowerCase())) return null;   // /topics 等保留路径
    const q = new URLSearchParams(location.search);
    for (const id of Object.keys(LISTS)) {
      try { if (LISTS[id].match(seg, q)) return id; } catch (e) { /* ignore */ }
    }
    return null;
  }

  const STYLE_ID = 'gh-stars-infinite-style';
  const SENTINEL_ID = 'gh-stars-infinite-sentinel';
  const END_ID = 'gh-stars-infinite-end';
  const STATUS_ID = 'gh-stars-infinite-status';
  const HTML_FLAG = 'gh-stars-infinite';

  const log = (...args) => { if (CONFIG.debug) console.log('[GH-Stars-Infinite]', ...args); };
  const warn = (...args) => console.warn('[GH-Stars-Infinite]', ...args);

  /* ============================ 状态 ============================ */
  const state = {
    listId: null,           // 当前列表类型（LISTS 的 key）
    keyKind: 'repo',        // 当前列表的条目 key 类型
    itemSelectors: null,    // 当前列表的条目选择器
    frame: null,
    frameId: null,          // 当前列表的 turbo-frame id（来自 LISTS）
    list: null,             // 追加/回收的容器（帧 / <ul> / 条目的父元素）
    placeholderTag: 'div',  // 回收占位块的标签
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

    const ph = document.createElement(state.placeholderTag || 'div');
    ph.className = 'ghsi-pholder';
    ph.style.height = page.realHeight + 'px';
    ph.dataset.ghPage = String(page.index);
    state.list.insertBefore(ph, nextSib);
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
      state.list.insertBefore(frag, nextSib);
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
    const ph = state.list.querySelector('.ghsi-pholder[data-gh-page="' + page.index + '"]');
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
      const phNow = state.list.querySelector('.ghsi-pholder[data-gh-page="' + page.index + '"]');
      if (phNow) state.list.insertBefore(frag, phNow.nextSibling);
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

  /** 取列表容器：优先当前列表类型的 turbo-frame，逐级降级（main → body） */
  function findFrame(doc) {
    const id = state.frameId;
    return (id && doc.getElementById(id)) ||
           (id && doc.querySelector('turbo-frame#' + id)) ||
           doc.querySelector('main') ||
           doc.body;
  }

  /**
   * 条目的唯一 key，按 keyKind 从条目内部的链接里解析；解析不到返回 null。
   * 只认路径形态，不依赖 h2/h3 之类的包装标签，所以 fork 列表（仓库名在 h2 里）、
   * issue/PR/提交列表都能用同一套逻辑；仓库条目里的 stargazers/forks 链接
   * 是三段路径，不会被误当成 key。
   */
  function itemKey(el) {
    if (!el || el.nodeType !== 1) return null;
    const kind = state.keyKind || 'repo';

    // 提交行带稳定的 data-commit-link，优先用它（比解析链接更稳）
    if (kind === 'commit') {
      const cl = el.getAttribute && el.getAttribute('data-commit-link');
      if (cl) {
        const cm = /\/commit\/([0-9a-f]{7,40})/i.exec(cl);
        if (cm) return 'commit:' + cm[1].toLowerCase();
      }
    }

    const re = KEY_PATTERNS[kind];
    if (!re) return null;
    const links = el.querySelectorAll('a[href]');
    for (const a of links) {
      let pathname;
      try { pathname = new URL(a.getAttribute('href'), location.href).pathname; }
      catch (e) { continue; }
      const m = re.exec(pathname);
      if (!m) continue;
      if (RESERVED.has(m[1].toLowerCase())) continue;   // /topics/xxx 之类
      const o = m[1].toLowerCase();
      switch (kind) {
        case 'repo':    return o + '/' + m[2].toLowerCase();
        case 'user':    return 'user:' + o;
        case 'issue':   return 'issue:' + o + '/' + m[2].toLowerCase() + '#' + m[3];
        case 'pr':      return 'pr:' + o + '/' + m[2].toLowerCase() + '#' + m[3];
        case 'commit':  return 'commit:' + m[3].toLowerCase();
        case 'release': {
          let tag = m[3];
          try { tag = decodeURIComponent(tag); } catch (e) { /* 保持原样 */ }
          return 'release:' + o + '/' + m[2].toLowerCase() + '@' + tag.toLowerCase();
        }
      }
      return null;
    }
    return null;
  }

  /**
   * 从容器里抽出条目（选择器按当前列表类型取）。
   * 两道过滤保证只拿到真正的列表条目：
   *   1) 条目外层可能还有 wrapper —— 剔除「包含其它候选元素」的父级，只留最内层；
   *   2) 页面角落（侧栏、页脚）里可能有同标签、同样带链接的元素 —— 按父容器分组，
   *      只保留「候选项最多的那个容器」，其余丢弃。
   */
  function extractItems(frame) {
    const sels = state.itemSelectors || FALLBACK_ITEM_SELECTORS;
    for (const sel of sels) {
      const cands = Array.from(frame.querySelectorAll(sel)).filter(el => itemKey(el));
      const top = cands.filter(el => !cands.some(o => o !== el && o.contains(el)));
      if (!top.length) continue;
      const best = dominantGroup(top);
      if (best && best.length) return best;
    }
    const fallback = Array.from(frame.children).filter(el => itemKey(el));
    return dominantGroup(fallback) || [];
  }

  /**
   * 给每个条目找它"第一个能装下至少 2 个条目"的祖先（= 这个条目认定的列表容器）。
   * 同时统计每个容器拿到多少票、以及它一共装着多少条目。
   */
  function voteContainers(items) {
    const votes = new Map();   // container -> { votes, n, depth }
    const voteOf = new Map();  // item -> 它投票的容器
    for (const el of items) {
      let a = el.parentElement, depth = 1;
      while (a && a.nodeType === 1 && a !== document.body) {
        let n = 0;
        for (const o of items) if (o === a || a.contains(o)) n++;
        if (n >= 2) {
          const cur = votes.get(a) || { votes: 0, n: n, depth: depth };
          cur.votes += 1;
          votes.set(a, cur);
          voteOf.set(el, a);
          break;
        }
        a = a.parentElement;
        depth++;
      }
    }
    return { votes: votes, voteOf: voteOf };
  }

  /**
   * 找"真正的列表容器"：按**得票多少**选（并列时取装得更多的、再并列取更深的）。
   *   - 多数列表条目同级（ul > li），一级就命中那个 <ul>，票数一边倒；
   *   - Releases 每个 div.Box 外还套了「div + div.tmp-my-5」两层且每个 release 各一份，
   *     于是一路爬到包含全部 10 条的那个容器，10 条都投它；
   *   - 侧栏/页脚里混进来的单个同类元素，只能爬到高层容器，得票永远只有 1，竞争不过。
   */
  function dominantContainer(items) {
    if (!items || !items.length) return null;
    if (items.length === 1) return { el: items[0].parentElement, n: 1, depth: 1, votes: 1 };
    const v = voteContainers(items);
    let best = null;
    for (const [el, info] of v.votes) {
      if (!best || info.votes > best.votes ||
          (info.votes === best.votes && info.n > best.n) ||
          (info.votes === best.votes && info.n === best.n && info.depth > best.depth)) {
        best = { el: el, n: info.n, depth: info.depth, votes: info.votes };
      }
    }
    return best;
  }

  /** 只保留"投票给列表容器"的条目（把侧栏/页脚里的同类元素剔掉） */
  function dominantGroup(items) {
    if (!items.length) return items;
    if (items.length === 1) return items;
    const v = voteContainers(items);
    const best = dominantContainer(items);
    if (!best || !best.el) return items;
    const out = items.filter(el => v.voteOf.get(el) === best.el);
    return out.length ? out : items;
  }

  /** 一个链接是不是「上一页」，是就排除 */
  function isPrevLink(a) {
    if ((a.getAttribute('rel') || '') === 'prev') return true;
    const cls = a.className || '';
    if (/previous_page|prev_page/i.test(cls)) return true;
    const al = (a.getAttribute('aria-label') || '') + ' ' + (a.textContent || '');
    return /previous|上一页|上页/i.test(al);
  }

  /** 把一个「下一页」链接转成绝对地址；不可用则返回 null */
  function absNextUrl(a) {
    if (!a || !a.getAttribute) return null;
    const href = a.getAttribute('href');
    if (!href) return null;
    try {
      const url = new URL(href, location.href);
      if (url.origin !== location.origin) return null;
      return url.href;
    } catch (e) { return null; }
  }

  /** 在给定范围内挑「下一页」链接（Next / Older / Newer / 下一页） */
  function pickNext(scope) {
    const links = Array.from(scope.querySelectorAll('a[href]')).filter(a => !isPrevLink(a));
    return links.find(a => /^\s*(next|older|newer|下一页|下页)\s*$/i.test((a.textContent || '').trim())) ||
           links.find(a => /next|older|newer/i.test(a.getAttribute('aria-label') || '')) ||
           links.find(a => (a.getAttribute('rel') || '') === 'next') ||
           links.find(a => /next|下一页/i.test((a.textContent || '')));
  }

  /**
   * 取下一页 URL。GitHub 有三套分页 UI，这里从最规范到最宽松依次尝试：
   *   1) 分页容器内（.paginate-container / [data-test-selector=pagination] /
   *      nav[aria-label*=Pagination] —— 新版 React 分页）
   *   2) 全文档里找 rel="next" / aria-label 含 Next / .next_page / 文案 Next
   * 拿不到就返回 null（= 最后一页）。
   */
  function extractNextUrl(scope) {
    const root = scope || document;

    // 1) 分页容器优先
    const boxes = Array.from(root.querySelectorAll('.paginate-container, [data-test-selector="pagination"], nav'))
      .filter(b => /paginate-container|pagination/i.test(b.className || '') ||
                   /pagination/i.test(b.getAttribute('aria-label') || '') ||
                   /PaginationContainer/i.test(b.className || ''));
    for (const box of boxes) {
      const url = absNextUrl(pickNext(box));
      if (url) return url;
    }

    // 2) 放宽到整个文档
    const all = Array.from(root.querySelectorAll('a[href]')).filter(a => !isPrevLink(a));
    const link =
      all.find(a => (a.getAttribute('rel') || '') === 'next') ||
      all.find(a => /\bnext\b/i.test(a.getAttribute('aria-label') || '')) ||
      all.find(a => /(^|\s)next_page(\s|$)/i.test(a.className || '')) ||
      all.find(a => /^\s*(next|older|newer|下一页|下页)\s*$/i.test((a.textContent || '').trim()));
    return absNextUrl(link);
  }

  /* ============================ 样式 ============================ */

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
/* 1) 隐藏原生分页按钮。
   三套分页 UI 都要盖住：经典 .paginate-container、Stars 的
   [data-test-selector=pagination]、新版（issues/PR/提交/搜索）的
   nav.prc-Pagination-* —— 后者的类名带哈希后缀，所以用类名前缀匹配。 */
html.${HTML_FLAG} main .paginate-container,
html.${HTML_FLAG} main [data-test-selector="pagination"],
html.${HTML_FLAG} main nav[class*="PaginationContainer"],
html.${HTML_FLAG} main div[class*="paginationWrapper"] { display: none !important; }

/* 2) 触发哨兵 */
#${SENTINEL_ID} { height: 1px; width: 100%; }

/* 2.4) 滚动回收占位块：高度由 JS 按该页真实高度内联设置；
   这里重置列表样式，保证作为 <li>（仓库页的 <ul> 内）也干净、不冒项目符号。 */
.ghsi-pholder { list-style: none !important; margin: 0 !important; padding: 0 !important; box-sizing: border-box; }

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
    if (useTurboFrame && state.frameId) headers['Turbo-Frame'] = state.frameId;
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
      // 追加到列表容器（Stars=帧本身，仓库=条目所在的 <ul>）。
      // 若哨兵就在同一容器里，插到哨兵之前，保证哨兵恒定在最底部（自动加载才能一路触发）。
      const target = state.list;
      if (state.sentinel && state.sentinel.parentNode === target) {
        target.insertBefore(frag, state.sentinel);
      } else {
        target.appendChild(frag);
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

  function reset(frame, listId) {
    teardown(false);

    const cfg = LISTS[listId] || LISTS.stars;
    state.listId = listId;
    state.frameId = cfg.frameId;
    state.placeholderTag = cfg.placeholderTag;
    state.keyKind = cfg.keyKind || 'repo';
    state.itemSelectors = cfg.itemSelectors;
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

    // 追加/回收容器：多数列表的条目都装在一个 <ul>/<div> 容器里（不是帧的直接子元素），
    // 要找到它；Stars 页条目就在帧里，直接用帧本身。
    // 用 dominantContainer 而不是直接取父元素 —— Releases 的每个 div.Box 外还包了一层
    // 无 class 的 div，只有祖父容器才装得下全部条目。
    if (firstNodes.length && cfg.listMode !== 'frame') {
      const dc = dominantContainer(firstNodes);
      state.list = dc ? dc.el : (firstNodes[0].parentElement || frame);
    } else {
      state.list = frame;
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
    log('已启用[' + listId + '·' + cfg.label + '] ->', location.href,
        '| 首页条目', state.seen.size, '| list:', state.list && state.list.tagName, '| next:', state.nextUrl);
  }

  function teardown(full) {
    if (state.observer) { try { state.observer.disconnect(); } catch (e) { /* ignore */ } state.observer = null; }
    if (state.sentinel) { try { state.sentinel.remove(); } catch (e) { /* ignore */ } state.sentinel = null; }
    if (state.endMarker) { try { state.endMarker.remove(); } catch (e) { /* ignore */ } state.endMarker = null; }
    unbindRetryOnScroll();
    if (state.statusEl) { try { state.statusEl.remove(); } catch (e) { /* ignore */ } state.statusEl = null; }
    if (state.scheduled) { clearTimeout(state.scheduled); state.scheduled = null; }
    if (full) document.documentElement.classList.remove(HTML_FLAG);
    state.listId = null;
    state.keyKind = 'repo';
    state.itemSelectors = null;
    state.frame = null;
    state.frameId = null;
    state.list = null;
    state.placeholderTag = 'div';
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
    const listId = activeList();
    if (!listId) { teardown(true); return; }
    const cfg = LISTS[listId];
    // 先把列表配置挂上（extractItems 依赖它挑选择器），再去取帧
    state.listId = listId;
    state.keyKind = cfg.keyKind || 'repo';
    state.itemSelectors = cfg.itemSelectors;

    const frame = cfg.frameId
      ? (document.getElementById(cfg.frameId) || document.querySelector('turbo-frame#' + cfg.frameId))
      : null;
    if (!frame) { teardown(true); return; }

    // 已经初始化过：哨兵还在（内容没被 Turbo 换掉）-> 不动
    if (state.frame === frame && state.sentinel && frame.contains(state.sentinel)) return;
    // 已经到底：结束标记还在 -> 不动
    if (state.frame === frame && state.endMarker && frame.contains(state.endMarker)) return;

    // 内容还没渲染完（条目为 0 且也不是明确的空状态）-> 等下一次变化
    const hasItems = extractItems(frame).length > 0;
    const emptyState = /hasn't starred|doesn't have any starred|no starred|haven't starred|any public repositories|doesn't have any repositories|no repositories yet|doesn't have any followers|doesn't follow anyone|no forks|no issues|no pull requests|no commits|no releases|hasn't released/i
      .test(frame.textContent || '');
    if (!hasItems && !emptyState) return;

    reset(frame, listId);
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
      if (!activeList()) { if (state.frame) teardown(true); return; }
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
    lists: LISTS,
    state: state,
    activeList: () => state.listId,
    pages: () => state.pages.map(p => ({
      index: p.index, recycled: p.recycled,
      cached: !!(p.nodes && p.nodes.length), count: p.nodes ? p.nodes.length : 0,
      height: p.realHeight
    })),
    loadMore: () => maybeLoad(true),
    recycleNow: () => { recycleAbove(); }
  };
})();
