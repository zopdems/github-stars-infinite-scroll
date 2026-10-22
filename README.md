# GitHub 列表无限滚动

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Userscript](https://img.shields.io/badge/Tampermonkey%20%2F%20Violentmonkey-✓-blue.svg)](https://www.tampermonkey.net/)

给 GitHub 上**所有可翻页的列表**加「无限滚动」：向下滚动自动加载下一页并追加到列表末尾，不用点 Next，页面不刷新、不跳转、滚动位置不变，到底给出提示。

- 📜 脚本：[`github-stars-infinite-scroll.user.js`](github-stars-infinite-scroll.user.js)
- 📖 技术指南：[`docs/GUIDE.md`](docs/GUIDE.md)

## 支持哪些列表

| 列表 | 地址 | 条目 / 去重 key |
|---|---|---|
| 星标 Stars | `/{用户}?tab=stars` | 仓库 `owner/repo` |
| 仓库 Repositories | `/{用户}?tab=repositories`（含 `&type=source`） | 仓库 `owner/repo` |
| 关注者 Followers | `/{用户}?tab=followers` | 用户 `用户名` |
| 正在关注 Following | `/{用户}?tab=following` | 用户 `用户名` |
| Fork 分支 | `/{仓库}/forks` | 仓库 `owner/repo` |
| 星标者 Stargazers | `/{仓库}/stargazers` | 用户 `用户名` |
| 关注者 Watchers | `/{仓库}/watchers` | 用户 `用户名` |
| Issues | `/{仓库}/issues` | Issue `owner/repo#号` |
| Pull requests | `/{仓库}/pulls` | PR `owner/repo#号` |
| 提交 Commits | `/{仓库}/commits/{分支}` | 提交 `sha` |

排序 / 过滤参数（`type=source`、`state=open`、`q=…` 等）**自动保留**——因为下一页地址直接复用分页区 Next 链接的 href。

---

## 为什么还需要一个脚本

因为网上大多数教程已经**过时**了，而且各个列表的分页机制**还不一样**（实测 2026-10）：

| 分页方式 | 出现在 | 说明 |
|---|---|---|
| 游标 `?after=<cursor>` | Stars、提交 | 实测 `?tab=stars&page=2` 返回的是**第一页**，照老办法写 `page++` 只会原地打转 |
| 页码 `?page=N` | 仓库、关注者、Fork、Issues、PR | 与 Stars 相反，`?page=2` 是**有效**的 |
| 页码 `?p=N` | 搜索结果 | 只在搜索页用 |

本脚本的做法是：**一律从分页区 "Next" 链接的 `href` 里取下一页地址**，因此三套机制都能正确处理，过滤参数也天然带上。

## 特性

| | |
|---|---|
| 触发 | 滚动接近底部自动加载（`IntersectionObserver` + 哨兵，提前 900px 预加载） |
| 追加 | 新条目直接挂在列表末尾，不刷新、不跳转、滚动位置不变，按 `owner/repo` 自动去重 |
| 终止 | 无下一页地址即停止请求，显示「已到底 · 共 N 个仓库 / M 页」 |
| 界面 | 隐藏原生分页按钮；底部状态胶囊显示进度，颜色跟随 GitHub 浅色/深色主题 |
| 容错 | 失败自动退避重试 3 次；仍失败则**下次滚动即重试**，另有手动「重试」按钮 |
| 范围 | 个人主页的 Stars / 仓库 / 关注者 / 正在关注，仓库的 Fork / 星标者 / 关注者 / Issues / PR / 提交；从其他页面点进来（Turbo 无刷新跳转）同样生效 |
| 性能 | 视口外跳过布局绘制、分块挂载避免长任务、空闲预取消除等待期、**滚动回收**（上方已浏览的整页换成等高占位块，回看再补回）—— 几千条也不卡 |
| 依赖 | 无。纯浏览器端，不需要服务器、不需要 Token，不上传任何数据 |

## 安装

### 一键安装（推荐）

先装用户脚本管理器：[Tampermonkey](https://www.tampermonkey.net/)（Chrome / Edge / Brave / Firefox）或 [Violentmonkey](https://violentmonkey.github.io/)，然后点：

> [**安装脚本**](https://raw.githubusercontent.com/zopdems/github-stars-infinite-scroll/main/github-stars-infinite-scroll.user.js)

脚本头里带了 `@downloadURL` / `@updateURL`，装好后 Tampermonkey 会自动检查更新。

### 手动安装

1. 下载 [`github-stars-infinite-scroll.user.js`](github-stars-infinite-scroll.user.js)
2. 打开扩展面板 → 把 `.user.js` 文件**拖进去**，或「导入 / Import」选择文件
3. 点「安装 / Install」

也可以新建脚本、粘贴全文、保存。

## 使用

打开上面表格里任一列表，向下滚动即可，无需任何设置：

```
https://github.com/zopdems?tab=stars                 # 星标
https://github.com/zopdems?tab=repositories          # 仓库（&type=source 只看非 fork）
https://github.com/torvalds/linux/forks              # Fork 分支
https://github.com/sindresorhus/type-fest/issues     # Issues
https://github.com/torvalds/linux/commits/master     # 提交
```

> 想看**自己的**仓库 / 星标，用 `https://github.com/{你的用户名}?tab=…`（在个人主页的标签页里）。
> 登录后的仪表盘 `https://github.com/?tab=repositories` 是另一套布局、需要登录态，本版本不覆盖。

调试入口（浏览器控制台）：

```js
GHStarsInfinite.activeList()       // 当前生效的列表类型：'forks' | 'issues' | … | null
GHStarsInfinite.lists              // 所有已登记的列表配置
GHStarsInfinite.loadMore()         // 手动触发一次加载
GHStarsInfinite.state              // 查看 seen / page / nextUrl / done / pages / list
GHStarsInfinite.pages()            // 一览每页：是否已回收、缓存是否在、节点数、高度
GHStarsInfinite.recycleNow()       // 立刻执行一次"回收上方整页"
```

如果某个列表没自动生效，先看 `GHStarsInfinite.activeList()`：返回 `null` 说明这个页面还没登记进 `LISTS`。

可调参数都集中在脚本顶部的 `CONFIG`（预加载距离、请求间隔、重试次数、最大页数等）。

## 星标很多时会卡吗

不会。脚本针对长列表做了三件事（实测单个条目 2.2KB、约 16 个元素，八百多条合计约 1.3 万节点 —— 这个量级本身压不垮浏览器，**瓶颈在渲染**，不在 DOM 规模）：

| 手段 | 解决什么 |
|------|----------|
| `content-visibility: auto` + `contain-intrinsic-height` | **视口外的条目直接跳过布局与绘制**。这是"回滚白屏"的主因解法：原来一屏之外的近千个条目（每个还带 2 个内联 SVG）都要参与光栅化，浏览器跟不上就给白块。占位高度用 `auto` 关键字，条目真实渲染过一次后浏览器会记住实际高度，滚动条不会跑偏 |
| 分块挂载（每帧 8 条，块间让出一帧） | 一次性挂载 30 条含 SVG 的节点会形成一个几十毫秒的长任务，正好卡在滚动帧上 —— 这就是"下滑卡顿"。切开以后每帧都有渲染机会 |
| 空闲预取（`requestIdleCallback`，提前 3000px） | 消掉下滑到边界时的那段"等待期"，内容在你读到之前就已经备好 |
| 每轮只加载 3 页 | 不会一口气把几十页全灌进 DOM。一轮满 3 页就停，继续下滑或点「继续」再开下一轮 |

**每轮只加载 3 页**（`CONFIG.maxBurstPages`，改 0 则不限制）：一轮满 3 页就停，继续下滑或点状态条上的「继续」再开下一轮。手动触发和失败重试不受这个限制。

如果还想更保守，可以把 `CONFIG.softCap` 设成一个数字（比如 300），加载到这里会停下并给一个「继续」按钮，避免一次性堆太多节点。

### 加载全了之后继续翻看还卡？—— 开启「滚动回收」

前几招把"加载过程"的卡顿压下去了，但如果你有几百上千个星标（比如 800+ / 27 页），**全加载完之后继续上下翻看**，DOM 里始终堆着上千个条目，滚动起来还是会发涩、回看偶尔白屏。

v1.3.0 增加了「滚动回收」（`CONFIG.recycle = true`，默认开）：

| 手段 | 解决什么 |
|------|----------|
| 滚动回收 + 回看补回 | 把**视口上方已经翻过去的整页**从 DOM 摘掉，换成**一块等高占位条**（高度 = 该页真实高度，所以滚动条不跳、位置不变）；往下滚不再为上面看不见的条目买单。往上回看时那一页从缓存**瞬间补回**，缓存被限量驱逐时才走一次网络重新拉取 |
| 按页缓存 | 每一页的节点整块缓存，回收/补回都是"整页换占位块"的 O(1) 操作，不做逐条 diff |

`CONFIG` 里新增三个开关：

| 参数 | 默认 | 说明 |
|------|------|------|
| `recycle` | `true` | 总开关 |
| `recycleAbovePx` | `1400` | 整页滑出视口上方超过这个距离（px）就回收；回看时占位条进入该距离内即补回 |
| `maxCachedPages` | `0` | `0` = 缓存所有已加载页（回看瞬时补回）；`>0` = 只保留最近 N 页节点，更久远的回看会重新拉取一次 |

关闭方法：把 `CONFIG.recycle` 设为 `false`，退回"全部常驻 DOM"的旧行为。

> 万一你的浏览器/环境对 `content-visibility` 支持不好，把 `CONFIG.contentVisibility` 设为 `false` 即可退回原行为。

## 它是怎么工作的

```
URL 是 /{user}?tab=stars 或 ?tab=repositories ?
        ▼
定位对应 turbo-frame（Stars=#user-starred-repos，仓库=#user-profile-frame）
        ▼
已有条目铺底做去重基线 → 从分页区取下一页地址（游标 or 页码，随标签页而定）
        ▼
列表末尾插哨兵 → IntersectionObserver 监听（提前 900px）
        │ 哨兵进入视口
        ▼
fetch(nextUrl, { Turbo-Frame: <帧id> })   ← 只返回帧片段（Stars 328KB→193KB；仓库 400KB→270KB）
        ▼
DOMParser 解析 → 抽条目 → 去重 → 追加到列表容器（Stars=帧，仓库=条目所在的 <ul>）
        ▼
取下一页地址：有 → 继续监听；无 → 停止并显示「已到底」
```

几个关键取舍：

- **下一页地址一律复用 Next 链接的 href**，两套分页机制（游标 / 页码）都不自己拼 URL
- **带 `Turbo-Frame` 头只取片段**，解析不出条目时自动降级为整页重抓
- **抽条目不能直接取 `frame.children`** —— 条目外还有一层 wrapper，那样会把 wrapper 当成 1 个条目
- **每类列表用不同的容器 / 条目选择器 / 追加容器 / 去重 key**（条目在 `<ul>` 里时，占位块也要是 `<li>` 才不破坏列表结构）
- **key 只按链接路径形态解析**（`owner/repo`、`用户名`、`…/issues/N`、`…/commit/<sha>`），不依赖包装标签，所以仓库名在 `h2` 还是 `h3` 都能认；条目里的 `stargazers` / `forks` 链接是三段路径，不会被误当成 key
- **到底后要留结束标记**，否则 `MutationObserver` 会误判为「未初始化」而重启，陷入死循环
- **滚动回收按"整页"换占位块**：回收前测一次该页真实高度缓存下来，占位条高度与之相等，所以滚动位置不跳变；回看时整页节点从缓存插回原位（缓存被驱逐才重新拉取这一页）

完整思路、踩坑记录和排错手册见 **[技术指南](docs/GUIDE.md)**。

## 已知限制

- 克隆出来的条目，其「取消星标」按钮带的是抓取时刻的 CSRF token，刷新页面后操作即可，不影响浏览
- 只匹配 `https://github.com/*`；企业版 GHE 改一行 `@match` 即可
- 覆盖上表的 10 类列表；**登录后的仪表盘 `/?tab=repositories` 是另一套布局，不覆盖**（看自己的仓库请用个人主页的 Repositories 标签页）
- `/{仓库}/stargazers`、`/{仓库}/watchers`：匿名访问会 404（需登录），**未做真实验证**，结构与 Fork 同构故一并登记；若 GitHub 改版失效，脚本会安全停止而不是乱加内容
- **搜索结果页 `/search` 未支持**：它是纯 React 应用，自己会重渲染并清掉追加的内容，且容器类名带构建哈希、不稳定
- Issues / PR / 提交这类新版 React 页面，若你在页面上做了筛选等交互，React 可能重渲染列表并清掉已追加的条目；滚动加载本身不受影响
- GitHub 若改版 DOM，脚本会安全地停止并提示「已到底」而不是疯狂重试

## 许可证

[MIT](LICENSE) © 2026 zopdems
