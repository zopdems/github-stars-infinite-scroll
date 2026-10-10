# GitHub Stars 无限滚动

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Userscript](https://img.shields.io/badge/Tampermonkey%20%2F%20Violentmonkey-✓-blue.svg)](https://www.tampermonkey.net/)

给 GitHub 用户的 **Stars 标签页** 加「无限滚动」：向下滚动自动加载下一页并追加到列表末尾，不用点 Next，页面不刷新、不跳转、滚动位置不变，到底给出提示。

适用于**任意用户**的 `https://github.com/{用户名}?tab=stars`。

- 📜 脚本：[`github-stars-infinite-scroll.user.js`](github-stars-infinite-scroll.user.js)
- 📖 技术指南：[`docs/GUIDE.md`](docs/GUIDE.md)

---

## 为什么还需要一个脚本

因为网上大多数教程已经**过时**了。GitHub 的 Stars 分页早就不是 `?page=N`，而是**游标分页** `?after=<cursor>&tab=stars`。

实测（2026-10）：请求 `?tab=stars&page=2` 返回的是**第一页**，内容与第一页完全一致。所以照老办法写 `page++` 只会原地打转。

本脚本的做法是：**从分页区 "Next" 链接的 `href` 里取下一个游标**，同时天然兼容排序参数。

## 特性

| | |
|---|---|
| 触发 | 滚动接近底部自动加载（`IntersectionObserver` + 哨兵，提前 900px 预加载） |
| 追加 | 新条目直接挂在列表末尾，不刷新、不跳转、滚动位置不变，按 `owner/repo` 自动去重 |
| 终止 | 无下一页游标即停止请求，显示「已到底 · 共 N 个仓库 / M 页」 |
| 界面 | 隐藏原生分页按钮；底部状态胶囊显示进度，颜色跟随 GitHub 浅色/深色主题 |
| 容错 | 失败自动退避重试 3 次；仍失败则**下次滚动即重试**，另有手动「重试」按钮 |
| 范围 | 任意用户的 Stars 页；从其他页面点进来（Turbo 无刷新跳转）同样生效 |
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

打开任意用户的 Stars 页，例如 `https://github.com/zopdems?tab=stars`，向下滚动即可。

调试入口（浏览器控制台）：

```js
GHStarsInfinite.loadMore()   // 手动触发一次加载
GHStarsInfinite.state        // 查看 seen / page / nextUrl / done
```

可调参数都集中在脚本顶部的 `CONFIG`（预加载距离、请求间隔、重试次数、最大页数等）。

## 它是怎么工作的

```
URL 是 /{user}?tab=stars ?
        ▼
定位 <turbo-frame id="user-starred-repos">
        ▼
已有 30 条铺底做去重基线 → 从分页区取第一个游标
        ▼
列表末尾插哨兵 → IntersectionObserver 监听（提前 900px）
        │ 哨兵进入视口
        ▼
fetch(nextUrl, { Turbo-Frame: user-starred-repos })   ← 只返回帧片段，328KB → 193KB
        ▼
DOMParser 解析 → 抽条目 → 去重 → appendChild
        ▼
取下一个游标：有 → 继续监听；无 → 停止并显示「已到底」
```

几个关键取舍：

- **游标驱动**，不自己拼 URL
- **带 `Turbo-Frame` 头只取片段**，解析不出条目时自动降级为整页重抓
- **抽条目不能直接取 `frame.children`** —— 条目外还有一层 wrapper，那样会把 wrapper 当成 1 个条目
- **到底后要留结束标记**，否则 `MutationObserver` 会误判为「未初始化」而重启，陷入死循环

完整思路、踩坑记录和排错手册见 **[技术指南](docs/GUIDE.md)**。

## 已知限制

- 克隆出来的条目，其「取消星标」按钮带的是抓取时刻的 CSRF token，刷新页面后操作即可，不影响浏览
- 只匹配 `https://github.com/*`；企业版 GHE 改一行 `@match` 即可
- GitHub 若改版 DOM，脚本会安全地停止并提示「已到底」而不是疯狂重试

## 许可证

[MIT](LICENSE) © 2026 zopdems
