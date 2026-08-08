// Chat 详情视图的服务端外壳 —— 只剩一张静态 HTML 骨架。
//
// 样式与脚本已经搬到 web/chat.css / web/chat.js, 由 /chat/app.css、/chat/app.js
// 独立提供 (见 ./chat-http)。好处不只是"代码在真文件里": 页面 shell 常驻不变,
// 资源可被浏览器按 ETag 缓存, 而 turn 正文继续由服务端渲染 (diff / ANSI / 语法
// 高亮只在 shared/detail-render 实现一次, 不必在客户端重写一遍)。
//
// 资源 URL 一律用相对路径 —— svr 常挂在反代子路径下 (如 /wc/chat), 绝对路径会 404。
import { SHARED_CSS, TURN_CSS } from "./detail-render.js";
import { readAsset, type Asset } from "./web-assets.js";

/** /chat/app.css = 详情页共用样式 + 本视图外壳样式。 */
export const chatStyles = (): Asset => {
  const own = readAsset("chat.css");
  return {
    body: `${SHARED_CSS}${TURN_CSS}${own?.body ?? ""}`,
    type: "text/css; charset=utf-8",
    etag: own?.etag ?? 'W/"nocss"',
  };
};

export const chatScript = (): Asset =>
  readAsset("chat.js") ?? { body: "", type: "text/javascript; charset=utf-8", etag: 'W/"nojs"' };

export const renderChatPage = (): string =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Chat Details</title>
<link rel="stylesheet" href="https://unpkg.com/highlight.js@11/styles/github.min.css">
<link rel="stylesheet" href="chat/app.css">
<script src="https://unpkg.com/markdown-it@14/dist/markdown-it.min.js"></script>
<script src="https://unpkg.com/@highlightjs/cdn-assets@11/highlight.min.js"></script>
</head><body>
<div class="app">
  <aside class="side">
    <div class="side-head">
      <div class="l1"><span class="t">会话列表</span><span class="n" id="side-n"></span></div>
      <div class="s" id="side-sub"></div>
    </div>
    <div class="tags" id="tags"></div>
  </aside>
  <main class="main">
    <div class="topbar">
      <span class="back" id="tb-back">‹</span>
      <span class="em" id="tb-em">💬</span>
      <span class="h" id="tb-h"></span>
      <span class="sub" id="tb-sub"></span>
    </div>
    <div class="gbar" id="gbar" hidden></div>
    <div class="thread" id="thread"><div class="thread-in" id="thread-in"></div></div>
    <div class="statusbar">
      <span id="sb" style="display:contents"></span>
      <span class="conn" id="conn"><span class="d"></span></span>
    </div>
  </main>
</div>
<script src="chat/app.js" defer></script>
</body></html>`;
