# GitHub Stars 无限滚动 —— 技术指南

一份给 GitHub 用户 Stars 标签页加"无限滚动"的用户脚本（Tampermonkey / Violentmonkey）。

- **脚本文件**：`github-stars-infinite-scroll.user.js`
- **适用范围**：任意用户的 Stars 页（`https://github.com/{任意用户名}?tab=stars`），不限于某个账号
- **依赖**：无。纯浏览器端，不改 GitHub 的 DOM 结构之外的任何东西，不需要服务器、不需要 Token

---

## 一、先说结论：GitHub 现在的 Stars 分页长什么样

这一节是整份脚本的地基。所有结论都来自对线上页面的**实际抓取验证**（2026-10），不是猜的。

| # | 结论 | 验证方式 / 影响 |
|---|------|----------------|
| 1 | **分页不是 `?page=N`，而是游标 `?after=<cursor>&tab=stars`** | 抓 `?tab=stars&page=2` 返回的是**第一页**（30 条与第一页完全一致）。照网上老教程写 `page++` 会原地打转 |
| 2 | 下一页地址**必须**取自分页区 "Next" 链接的 `href` | 游标是一次性的、不透明字符串；自己拼不出来。好在 Next 链接里已经带上了排序参数（`user_lists_sort` / `direction`），换个排序也能正确续接 |
| 3 | 列表容器是 `<turbo-frame id="user-starred-repos">` | 每个仓库条目是它的后代 `div.col-12 … border-bottom` |
| 4 | 请求带 `Turbo-Frame: user-starred-repos` 头，GitHub **只返回该帧的 HTML 片段** | 实测体积 328KB → 193KB，省掉整页骨架的解析开销 |
| 5 | **最后一页根本没有 `.paginate-container`** | 这就是天然的终止信号，不需要猜"是不是最后一页" |
| 6 | 分页区 DOM：`.paginate-container > .BtnGroup[data-test-selector="pagination"] > a[rel="nofollow"]`（文案 `Next`） | Previous 是 `<button disabled>`，所以只认 `<a>` |

> 分页区真实结构（已脱敏）：
> ```html
> <div class="paginate-container">
>   <div class="BtnGroup" data-test-selector="pagination">
>     <button class="btn BtnGroup-item" disabled="disabled">Previous</button>
>     <a rel="nofollow" class="btn BtnGroup-item"
>        href="https://github.com/zopdems?after=Y3Vyc29yOnYyOpK0…%3D%3D&amp;tab=stars">Next</a>
>   </div>
> </div>
> ```

---

## 二、实现思路

整体是一条"**取游标 → 请求 → 解析 → 追加 → 取新游标**"的循环，靠 `IntersectionObserver` 触发：

```
URL 是 /{user}?tab=stars ?
        │ 否 → 不启用（并清理残留）
        ▼
找到 turbo-frame#user-starred-repos
        ▼
用页面上已有的 30 条铺底 → seen 集合（去重基线）
从分页区取出第一个游标 → nextUrl
插入哨兵 <div> 到列表末尾 + 插入状态胶囊
        ▼
IntersectionObserver 监听哨兵（rootMargin 900px 预加载）
        │ 哨兵进入视口
        ▼
fetch(nextUrl, { Turbo-Frame: user-starred-repos })
        ▼
DOMParser 解析 → 取 turbo-frame → 抽条目 → 按 owner/repo 去重 → appendChild
        ▼
从新文档取下一个游标
   ├─ 有  → 更新 nextUrl，回到监听
   └─ 无  → finish()：停止请求 + 显示"已到底"
```

### 模块划分

| 模块 | 职责 |
|------|------|
| `isStarsPage()` | 页面识别：单段路径 + `tab=stars` + 排除 GitHub 保留路径（`/topics`、`/marketplace`…） |
| `findFrame()` / `extractItems()` / `itemKey()` | DOM 抽取，带三级降级选择器 |
| `extractNextUrl()` | 从分页区拿下一个游标；拿不到就返回 `null` |
| `loadNext()` | 单次加载：节流 → 请求 → 解析 → 追加 → 推进游标 / 结束 |
| `finish()` | 终止：解绑观察、打结束标记、显示"已到底" |
| `recycleAbove()` / `rehydrateAbove()` / `recyclePage()` / `rehydratePage()` | 滚动回收与回看补回：整页 ↔ 等高占位块 的互换，按页缓存支撑 |
| `boot()` / `reset()` / `teardown()` | 生命周期，配合 Turbo 无刷新跳转反复启停 |
| `setStatus()` | 底部状态胶囊（加载中 / 已加载 N 个 / 失败 / 已到底） |

---

## 三、八个关键要点

### 1. 游标驱动，不要自己拼页码

```js
// ❌ 错误示范：GitHub 已不再支持 ?page=N
const url = `https://github.com/${user}?tab=stars&page=${++page}`;

// ✅ 正确：直接复用 Next 链接的 href
function extractNextUrl(scope) {
  const boxes = scope.querySelectorAll('.paginate-container, [data-test-selector="pagination"]');
  for (const box of boxes) {
    const links = Array.from(box.querySelectorAll('a[href]'));
    const next = links.find(a => /^\s*(next|下一页|下页)\s*$/i.test((a.textContent || '').trim()));
    if (!next) continue;
    const url = new URL(next.getAttribute('href'), location.href);
    if (url.origin !== location.origin) continue;
    return url.href;
  }
  return null;   // 没有分页区 = 最后一页
}
```

### 2. 用 `Turbo-Frame` 头拿片段，但要留整页兜底

```js
const headers = { 'Accept': 'text/html,application/xhtml+xml', 'X-Requested-With': 'XMLHttpRequest' };
if (useTurboFrame) headers['Turbo-Frame'] = 'user-starred-repos';
const res = await fetch(url, { headers, credentials: 'same-origin', redirect: 'follow' });
```

片段解析不出来时，去掉该头再抓一次整页重试。**脚本永不写死 DOM 位置之外的假设**——找不到 `turbo-frame#user-starred-repos` 会依次降级到 `main`、`body`。

### 3. 抽条目：不能直接取 `frame.children`

这是实测踩到的坑。条目外面**还包了一层 wrapper**，直接取子元素会把整个 wrapper 当成一个"条目"（于是只解析出 1 条）。正确做法是深度查找后**剔除包含其它候选元素的父级**：

```js
const ITEM_SELECTORS = [
  'div[class*="col-12"][class*="border-bottom"]',
  'div[class*="border-bottom"]',
  'div[class*="width-full"]'
];
function extractItems(frame) {
  for (const sel of ITEM_SELECTORS) {
    const cands = Array.from(frame.querySelectorAll(sel)).filter(el => itemKey(el));
    const top = cands.filter(el => !cands.some(o => o !== el && o.contains(el)));  // 只留最内层
    if (top.length) return top;
  }
  return Array.from(frame.children).filter(el => itemKey(el));
}
```

### 4. 去重：`owner/repo` 小写作为唯一键

```js
const REPO_PATH = /^\/([^/]+)\/([^/]+)\/?$/;
function itemKey(el) {
  const a = el.querySelector('h3 a[href]');
  if (!a) return null;                                   // 不是仓库条目
  const m = REPO_PATH.exec(new URL(a.getAttribute('href'), location.href).pathname);
  if (!m || RESERVED.has(m[1].toLowerCase())) return null; // 排除 /topics/xxx 之类
  return (m[1] + '/' + m[2]).toLowerCase();
}
```

首页已有的 30 条会先铺进 `seen` 集合，后续每页追加前比对，重复直接跳过。

### 5. 追加用 `importNode`，不触发重排跳转

```js
const node = document.importNode(el, true);   // 从解析文档克隆，不移动原节点
node.setAttribute('data-gh-star-page', String(state.page)); // 便于排查/样式
frag.appendChild(node);
// 循环结束后一次性挂载（插到哨兵之前，保证哨兵恒定在列表最底部）
if (state.sentinel && state.sentinel.parentNode === state.frame) {
  state.frame.insertBefore(frag, state.sentinel);
} else {
  state.frame.appendChild(frag);
}
```

> **为什么插到哨兵之前而不是末尾？** 旧写法 `appendChild` 会把新页加到哨兵后面，导致哨兵停在列表半空，滚过它之后 `IntersectionObserver` 再也不会触发，自动加载只能跑一轮。插到哨兵之前让哨兵永远在底部，自动加载才能一路触发到最后一页。

只在列表末尾方向挂载，**不 `pushState`、不刷新、不替换已有内容**，所以滚动位置天然保持不变。分页按钮靠 CSS 隐藏（见第 7 点），不是删除，避免破坏 GitHub 自身的逻辑。

### 6. 触发：`IntersectionObserver` + 哨兵

```js
state.observer = new IntersectionObserver(entries => {
  if (entries.some(e => e.isIntersecting)) maybeLoad();
}, { rootMargin: '0px 0px ' + CONFIG.preloadPx + 'px 0px', threshold: 0 });
state.observer.observe(state.sentinel);
```

`preloadPx = 900`：距底部还有 900px 就开始加载，用户几乎感觉不到等待。
追加完成后会再检查一次哨兵位置（`afterAppend()`）——万一新条目很矮、哨兵还在视口内，就继续拉，不会出现"加载一次就卡住"。

### 7. 状态提示与隐藏分页

```css
html.gh-stars-infinite main .paginate-container,
html.gh-stars-infinite main [data-test-selector="pagination"] { display: none !important; }
```

底部胶囊有 4 种状态：`加载中（带转圈）` / `已加载 N 个仓库` / `加载失败：原因 + 重试按钮` / `已到底 · 共 N 个仓库 / M 页`。
颜色走 Primer CSS 变量（`--bgColor-default` 等），**跟随 GitHub 浅色/深色主题**自动适配。

### 8. Turbo 兼容 + 失败重试

Turbo 做无刷新跳转时脚本不会重新执行，所以：

```js
['turbo:load', 'turbo:render', 'turbo:frame-load'].forEach(evt =>
  document.addEventListener(evt, () => setTimeout(boot, 60), true));
window.addEventListener('popstate', () => setTimeout(boot, 60));
// 外加一个 250ms 去抖的 MutationObserver 兜底（切排序、Turbo 换帧内容等场景）
```

`boot()` 每次都会重新判断"当前是不是 Stars 页"，不是就 `teardown()` 清理干净；是就用新的游标重新初始化。

**失败重试**分三层：
1. 自动退避重试 `maxRetry = 3` 次，间隔 `1500ms × 失败次数`
2. 超出次数后挂 `scroll` 监听 —— **下次滚动即重试**（因为哨兵一直在视口里，`IntersectionObserver` 不会再触发，必须补这条路）
3. 状态条上的「重试」按钮，手动触发

> ⚠️ 一个容易写错的回归点：到底后 `finish()` 会移除哨兵，此时 `MutationObserver` 若据此判断"脚本没初始化"就会重新 `reset()`，把 `done` 清掉，陷入"到底 → 重启 → 再到底"的死循环。脚本里用了一个 `#gh-stars-infinite-end` 结束标记挡住它。

### 9. 滚动回收（v1.3.0）：加载全了之后继续浏览也不卡

`content-visibility`、分块挂载、空闲预取、每轮 3 页把"加载过程"的卡顿压下去了，但**全部加载完之后继续上下翻看**，DOM 里始终堆着上千个条目，滚动仍然发涩、回看偶尔白屏。根因是：那些条目虽然在视口外被跳过绘制，但依然挂在 DOM 树里参与布局计算。

解法：**把视口上方已经翻过去的整页，从 DOM 摘掉换成一块等高占位条；往上回看时再补回**。无论加载多少页，DOM 里始终只保留"视口附近几页"。

```js
// 向下滚：整页滑出视口上方超过 recycleAbovePx 就回收成占位块
function recycleAbove() {
  const line = -CONFIG.recycleAbovePx;
  for (const page of state.pages) {                 // 按页顺序，只处理顶部的连续前缀
    if (page.recycled || !page.nodes.length) continue;
    const lastNode = page.nodes[page.nodes.length - 1];
    if (lastNode.getBoundingClientRect().bottom < line) {
      recyclePage(page);                            // 摘节点 + 插等高占位块
      maybeEvictCache();
    } else break;                                    // 后面的页更靠下，肯定还没离开，停止扫描
  }
}

// 向上滚：占位块重新进入缓冲距离内就补回真实节点
function rehydrateAbove() {
  const band = -CONFIG.recycleAbovePx;
  for (const page of state.pages) {
    if (!page.recycled || !page.placeholder.isConnected) continue;
    if (page.placeholder.getBoundingClientRect().bottom >= band) rehydratePage(page);
  }
}
```

三个实现要点：

1. **按页缓存**。`state.pages` 是"第几页 → `{nodes, url, nextUrl, realHeight, recycled, placeholder}`"的有序数组，每次 `appendItems` 把一整页节点整块存进去。回收/补回都是"整页换占位块"的 O(1) 操作，不做逐条 diff。
2. **占位块等高，滚动不跳变**。`recyclePage` 回收时会测一次该页真实高度（`getBoundingClientRect` 之和，只测一次并缓存）；占位条 `style.height` 与之相等，所以摘掉节点后列表总高不变，滚动位置纹丝不动。`content-visibility: auto` 下离屏节点仍占其固有高度，测量值稳定。
3. **回看自动补回**。`rehydratePage` 优先用缓存的节点瞬间插回原位；只有当 `maxCachedPages` 把这个页的缓存驱逐了才走网络：`fetchPage(page.url, true)` 用当初这一页的请求 URL 重新拉取并插回（URL 里的 `after` 游标保证拉回来的就是那一页）。

`rAF` 节流 + **按滚动方向分流**：向下滚只做回收、向上滚只做补回，平时几乎零开销。设 `CONFIG.recycle = false` 即可退回"全部常驻 DOM"的旧行为。

---

## 四、安装使用

### 1. 装扩展

| 浏览器 | 扩展 |
|--------|------|
| Chrome / Edge / Brave | [Tampermonkey](https://www.tampermonkey.net/) |
| Firefox | [Violentmonkey](https://violentmonkey.github.io/) 或 Tampermonkey |
| Safari | Userscripts / Tampermonkey |

### 2. 装脚本（两种方式任选）

**方式 A：拖文件安装（最简单）**
1. 把 `github-stars-infinite-scroll.user.js` 保存到本地
2. 打开扩展面板 → **已安装的用户脚本 / Installed userscripts** 页面
3. 把 `.user.js` 文件**直接拖进去**，或点「导入 / Import」选择文件
4. 在弹出的安装页点「安装 / Install」

**方式 B：粘贴代码**
1. 扩展图标 → 「添加新脚本 / Create a new script」
2. 清空编辑器，把脚本全文粘贴进去
3. `Ctrl+S` 保存

### 3. 用

打开任意用户的 Stars 页，例如：

```
https://github.com/zopdems?tab=stars
https://github.com/torvalds?tab=stars
```

- 向下滚动 → 自动加载，页面不跳转、滚动位置不变
- 底部胶囊显示进度；滚到底显示 **「已到底 · 共 N 个仓库 / M 页」**
- 网络出错时胶囊变红，滚动一下或点「重试」
- 从其他页面点进 Stars 页（Turbo 无刷新跳转）同样生效

### 4. 卸载 / 临时关闭

在扩展面板把脚本的「启用」开关关掉即可，刷新页面后完全恢复原生分页。

---

## 五、可调参数

脚本顶部的 `CONFIG`，按需改：

```js
const CONFIG = {
  frameId: 'user-starred-repos', // Stars 列表所在的 turbo-frame id
  preloadPx: 900,                // 距底部多少像素开始预加载（想更"跟手"就调大）
  minIntervalMs: 350,            // 两次请求最小间隔，防止风控
  maxRetry: 3,                   // 同一页自动重试次数
  backoffMs: 1500,               // 失败退避基数，实际延迟 = backoffMs × 失败次数
  maxPages: 500,                 // 安全阀，最多加载多少页
  debug: false,                  // 置 true 后控制台打印日志

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
  maxCachedPages: 0        // 0=缓存所有已加载页（回看瞬时补回）；>0=只保留最近 N 页节点，更久远的回看会重新拉取
};
```

调试时也可以在控制台直接调用：

```js
GHStarsInfinite.loadMore()            // 手动触发一次加载
GHStarsInfinite.state               // 查看 seen / page / nextUrl / done / pages
GHStarsInfinite.pages()             // 一览每页：是否已回收、缓存是否在、节点数、高度
GHStarsInfinite.recycleNow()        // 立刻执行一次"回收上方整页"
GHStarsInfinite.config.debug = true
```

---

## 六、已知限制与排错

| 现象 | 原因 / 处理 |
|------|-------------|
| 完全没反应，分页按钮还在 | 确认 URL 形如 `/{用户名}?tab=stars`（单段路径）。组织页没有 Stars 标签，脚本不会启用 |
| 只加载一两页就显示"已到底" | 大概率是 GitHub 改了 DOM。打开控制台看是否有 `[GH-Stars-Infinite] 未解析到仓库条目` 警告，然后把 `CONFIG.debug` 置 `true` 看细节 |
| 一直显示"加载失败：HTTP 429" | 触发了 GitHub 限流。把 `minIntervalMs` 调到 800~1000，或放慢滚动 |
| 追加出来的条目点"取消星标"失败 | 克隆过来的表单带的是抓取时刻的 CSRF token。刷新页面后操作即可，不影响浏览 |
| 企业版 GitHub（GHE）不生效 | 脚本 `@match` 只写了 `https://github.com/*`。改一行即可：`https://你的域名/*` |
| 浏览器报 CSP 错误导致 `fetch` 被拦 | 极少数环境会出现。改用油猴的 `GM_xmlhttpRequest`：把 `@grant none` 换成 `@grant GM_xmlhttpRequest`，并用 `GM_xmlhttpRequest({ url, headers, onload })` 替换 `fetchPage` 里的 `fetch` |
| 想同时支持 Followers / Repositories 标签 | 复制一份脚本，把 `frameId` 和 `isStarsPage()` 里的 `tab=stars` 改成对应值即可（Repositories 的分页同样是游标） |

---

## 七、长列表性能：为什么会卡、为什么回滚会白屏

星标数到几百上千（比如 810 个 / 27 页）时，会出现「下滑有等待期 → 卡顿 → 往上翻一片空白」。

### 先量一下，别瞎猜

实测单个条目：**2.2KB、约 16 个元素**（2 个内联 SVG、1 个 `<relative-time>`、无 `<details>` / 无 `<form>` / 无 `<script>`）。
810 条合计约 **1.7MB HTML、约 1.3 万 DOM 节点**。

这个规模**不足以**让 Chrome 白屏 —— 所以瓶颈不在 DOM 规模，而在**渲染**：一屏之外的近千个条目全部要参与布局和光栅化，滚动时光栅化跟不上就直接显示白块。对症下药才有意义。

### 三处改动

**1. `content-visibility: auto`（治白屏，收益最大）**

```css
html.gh-stars-infinite .ghsi-item {
  content-visibility: auto;
  contain-intrinsic-height: auto var(--ghsi-item-h, 128px);
}
```

视口外的条目直接跳过布局与绘制，需要光栅化的内容少掉 95%。注意两点：

- 占位高度用了 `auto` 关键字，条目真实渲染过一次后浏览器会**记住实际高度**，所以滚动条长度不会跑偏；`128px` 只是首次出现前的估计值，不准也没关系。
- **首页那 30 条也要打标记**（`reset()` 里就打了），只标记追加的条目没用 —— 第一屏之后照样要绘制。

**2. 分块挂载（治卡顿）**

```js
const size = Math.max(1, CONFIG.chunkSize);          // 默认 8
for (let i = 0; i < pending.length; i += size) {
  const frag = document.createDocumentFragment();
  for (const el of pending.slice(i, i + size)) { /* importNode + 打标记 */ }
  state.frame.appendChild(frag);
  if (i + size < pending.length) await nextFrame();  // 块间让出一帧
}
```

一次性挂载 30 个含 SVG 的节点会形成一个几十毫秒的长任务，正好卡在滚动帧上。切成 8 条一块、块间 `await nextFrame()`，每帧都留出渲染机会。

**3. 去掉强制同步布局**

原来 `afterAppend()` 用 `getBoundingClientRect()` 判断哨兵位置 —— 在一个已经很长的列表上，这会触发一次**强制同步布局**，滚一次卡一次。改成重新 `observe` 哨兵，让 `IntersectionObserver` 异步回调：

```js
state.observer.unobserve(state.sentinel);
state.observer.observe(state.sentinel);   // 仍在范围内就会再次回调，不同步布局
```

### 顺带修掉的「等待期」

`CONFIG.prefetchPx = 3000`：每次加载成功后，用 `requestIdleCallback` 在空闲时检查哨兵距离，够近就**提前把下一页取好**。这样等待发生在你阅读的时候，而不是你滚到底的时候。

### 4. 一轮只加载三页，别一口气灌完

即便渲染优化到位，一口气把 27 页全加载完也没必要 —— DOM 照样会堆到 810 个条目。所以默认加了**每轮上限**：

```js
maxBurstPages: 3,   // 一轮连续自动加载 3 页就停，滚动或点「继续」再开下一轮
```

行为是：

- 自动路径（哨兵触发、空闲预取）**每轮最多 3 页**，满了就停，状态条给一个「继续」按钮
- **继续滚动**即重置计数，开始下一轮 3 页
- 手动点「继续」、控制台 `GHStarsInfinite.loadMore()`、失败重试**不受此限制**（`force` 路径）

实现上只有两点要注意：

```js
// 只约束自动路径，手动/重试走 force，不该被限制住
if (CONFIG.maxBurstPages > 0 && !force && state.burst >= CONFIG.maxBurstPages) {
  showBurstPause();
  return;
}

// 滚动才重置计数；重置后重新 observe，由 IntersectionObserver 判断该不该真的加载
// —— 直接加载的话，用户在页面顶部随便滑一下也会触发
function onUserScroll() {
  if (!state.burstPaused || state.done || state.loading) return;
  state.burstPaused = false;
  state.burst = 0;
  afterAppend();
}
```

### 还想更保守

把 `CONFIG.softCap` 设成数字（如 300）：加载到这里会停下并显示一个「继续」按钮，避免一次性堆太多节点。默认 `0` = 不限。

`maxBurstPages` 管的是**一轮加载多少**，`softCap` 管的是**一共加载多少**，两者可以同时用。

---

## 八、验证记录

脚本不是"写完就交"，做了两轮实测验证：

**单元级（jsdom + 真实抓取的 HTML，11 项断言全过）**

- 第 1 页解析出 30 条，取到 `after` 游标，key 无重复
- 第 2 页（Turbo 片段）解析出 30 条；整页兜底路径解析结果一致，游标一致
- 第 1/2 页条目**零重叠**；合并后 60 条
- 单页用户（2 个星标）返回 `null` → 正确触发"已到底"

**端到端（脚本原样注入 jsdom，模拟 4 次连续翻页，25 项断言全过）**

- 首页铺底 30 条 → 连续加载 3 页 → DOM 120 条、去重集合 120、`page = 4`
- 第 5 页无分页区 → `done = true`、游标清空、状态条「已到底 · 共 122 个仓库 / 5 页」
- 到底后再触发不再发起请求；`IntersectionObserver` 已解绑
- 每次请求都带 `Turbo-Frame: user-starred-repos` 与 `X-Requested-With` 头
- 注入一次网络失败 → 失败计数 +1、状态条转 `error` + 出现「重试」按钮、**不误判为到底**；派发 `scroll` 事件后自动重试成功，计数归零
- 到底后等待 700ms 让 `MutationObserver` 触发，确认不会重启加载（第三节第 8 点的回归项）

**性能改动回归（v1.1.0，18 项断言全过）**

- 样式表含 `content-visibility: auto` 与 `contain-intrinsic-height: auto var(--ghsi-item-h)`；`--ghsi-item-h` 按 `CONFIG.itemHeight` 正确注入
- 首页 30 条**也**被打上优化标记；追加的条目同样带标记与页码属性
- 30 条按 `chunkSize=8` 切成多块，一次加载让出 4 帧（含挂载前的一帧）
- 软上限：达到阈值后状态条出现「继续」按钮，点击解除并继续加载
- `contentVisibility: false` 时完全不打标记（开关可退回原行为）
- 回归：重复内容触发「已到底」、到底后不被重启、空闲预取会提前加载

**每轮页数上限（v1.2.0，15 项断言全过，用合成页面精确控制游标）**

- 连触 3 次哨兵 → 累计 120 条、`burst = 3`
- 第 4 次不再加载、进入暂停、状态条出现「继续」按钮
- 派发 `scroll` → 暂停解除、计数归零，新一轮又是 3 页（累计 210）后再次停住
- 点「继续」按钮 → 立即加载一页（240）并解除暂停
- `maxBurstPages = 0` 时 5 次触发全部加载，不会暂停
- 手动/重试走 `force` 路径，不被每轮上限挡住

**滚动回收（v1.3.0，20 项断言全过，`test-recycle.js`，jsdom 注入真实脚本 + 可控布局/滚动）**

- 首页（第 1 页）启动即进入按页缓存；再加载一页后共 2 页、各 5 节点均在 DOM
- 把第 1 页推到视口上方并触发回收：节点从 DOM 摘除、出现 `.ghsi-pholder[data-gh-page="1"]` 占位块、占位块高度 = 5×100 = 500px、第 2 页未被误回收
- 往上回看（占位块进入缓冲距离内）：第 1 页节点从缓存补回、占位块移除、回收标记清除
- `maxCachedPages = 1` 下加载 4 页并全部回收：只保留最新 1 页节点，第 1~3 页缓存被驱逐
- 回看被驱逐的第 1 页：触发网络重新拉取（含首页 URL）、节点补回、占位块移除
- 回归：哨兵恒定在列表最底部（修复旧 `appendChild` 导致自动加载只能跑一轮的问题）
