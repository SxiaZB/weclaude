// Chat detail SPA shell — served once, then driven entirely by the JSON API in
// ./chat-http (list → thread → SSE). No meta-refresh, no whole-page re-fetch:
// the shell is static, `/api/chat` fills the sidebar, `/api/thread` fills the
// thread, and `/api/events` streams deltas (chat summary + one turn fragment at
// a time). Turn bodies arrive as server-rendered HTML so diff/highlight/ansi
// rendering stays in one place (shared/detail-render) instead of being ported
// to client JS.
import { SHARED_CSS, TURN_CSS } from "./detail-render.js";

const CHAT_CSS = `
  html,body{height:100%}
  body{overflow:hidden}
  .app{display:flex;height:100vh;height:100dvh}
  .side{width:264px;flex:none;background:#fff;border-right:1px solid #d0d7de;
    display:flex;flex-direction:column;min-height:0}
  .side-head{padding:14px 16px 10px;border-bottom:1px solid #eaeef2}
  .side-head .t{font-size:14px;font-weight:600}
  .side-head .s{font-size:11px;color:#8c959f;font-family:ui-monospace,Menlo,monospace;
    word-break:break-all;margin-top:2px}
  .tags{flex:1;min-height:0;overflow-y:auto;padding:6px}
  .tag-row{display:flex;gap:10px;align-items:flex-start;padding:9px 10px;border-radius:8px;
    cursor:pointer;border:1px solid transparent}
  .tag-row:hover{background:#f6f8fa}
  .tag-row.on{background:#0969da0f;border-color:#0969da33}
  .tag-av{width:30px;height:30px;flex:none;border-radius:9px;background:#f1f3f6;
    display:flex;align-items:center;justify-content:center;font-size:16px;position:relative}
  .tag-av .live{position:absolute;right:-2px;bottom:-2px;width:9px;height:9px;border-radius:50%;
    background:#1a7f37;border:2px solid #fff;animation:pulse 1.4s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
  .tag-main{min-width:0;flex:1}
  .tag-l1{display:flex;align-items:baseline;gap:6px}
  .tag-name{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;
    text-overflow:ellipsis;font-family:ui-monospace,Menlo,monospace}
  .tag-ts{margin-left:auto;flex:none;font-size:11px;color:#8c959f;
    font-family:ui-monospace,Menlo,monospace}
  .tag-prev{font-size:12px;color:#656d76;margin-top:2px;overflow:hidden;
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;line-height:1.45}
  .tag-badge{font-size:10px;padding:0 5px;border-radius:8px;flex:none;
    color:#1a7f37;background:#1a7f3714;border:1px solid #1a7f3733}
  .main{flex:1;min-width:0;display:flex;flex-direction:column}
  .topbar{flex:none;display:flex;align-items:center;gap:10px;padding:12px 20px;
    background:#fff;border-bottom:1px solid #d0d7de}
  .topbar .em{font-size:18px}
  .topbar .h{font-size:15px;font-weight:600;font-family:ui-monospace,Menlo,monospace}
  .topbar .sub{font-size:11px;color:#8c959f;font-family:ui-monospace,Menlo,monospace;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .topbar .back{display:none;font-size:18px;color:#656d76;cursor:pointer;padding:0 4px}
  .thread{flex:1;min-height:0;overflow-y:auto;overflow-anchor:none;
    padding:16px 20px 24px;-webkit-overflow-scrolling:touch}
  .thread-in{max-width:920px;margin:0 auto;display:flex;flex-direction:column;gap:18px}
  .empty{color:#8c959f;text-align:center;padding:60px 0;font-size:13px}
  .more-btn{align-self:center;background:#fff;border:1px solid #d0d7de;border-radius:16px;
    padding:5px 16px;font-size:12px;color:#57606a;cursor:pointer;font-family:inherit}
  .more-btn:hover{background:#f6f8fa;color:#0969da;border-color:#0969da55}
  /* ── turn 分组 ── */
  .turn-group{display:flex;flex-direction:column;gap:10px}
  .tg-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;
    padding-bottom:6px;border-bottom:1px dashed #d8dee4}
  .tg-dot{width:7px;height:7px;border-radius:50%;background:#b1bac4;flex:none}
  .tg-dot.live{background:#1a7f37;animation:pulse 1.4s infinite}
  .tg-time{font-size:11.5px;color:#8c959f;font-family:ui-monospace,Menlo,monospace}
  .tg-tok{font-size:11px;color:#57606a;background:#f1f3f6;border-radius:9px;
    padding:1px 7px;font-family:ui-monospace,Menlo,monospace}
  .tg-link{margin-left:auto;color:#8c959f;text-decoration:none;font-size:13px}
  .tg-link:hover{color:#0969da}
  .turn-group .bubbles{margin-top:0}
  /* ── 页脚 status bar ── */
  .statusbar{flex:none;display:flex;align-items:center;gap:16px;flex-wrap:wrap;
    padding:8px 20px;background:#fff;border-top:1px solid #d0d7de;
    font-size:11.5px;color:#57606a;font-family:ui-monospace,Menlo,monospace}
  .statusbar .st{display:flex;align-items:center;gap:5px}
  .statusbar .st .k{color:#8c959f;text-transform:uppercase;letter-spacing:.4px;font-size:10px}
  .statusbar .st .v{color:#1f2328;font-weight:700;font-variant-numeric:tabular-nums}
  .statusbar .run{color:#1a7f37;font-weight:700}
  .statusbar .idle{color:#8c959f}
  .sb-bar{display:flex;height:6px;width:120px;border-radius:3px;overflow:hidden;background:#eaeef2}
  .sb-bar .seg{height:100%}
  .conn{margin-left:auto;display:flex;align-items:center;gap:5px}
  .conn .d{width:7px;height:7px;border-radius:50%;background:#1a7f37}
  .conn.off .d{background:#cf222e}
  @media(max-width:760px){
    .app{flex-direction:column}
    .side{width:auto;border-right:0;border-bottom:1px solid #d0d7de;max-height:44vh}
    .app.reading .side{display:none}
    .app.reading .topbar .back{display:block}
    .thread{padding:12px}
    .statusbar{gap:10px;padding:7px 12px}
    .sb-bar{display:none}
  }
`;

// 客户端脚本。风格与 detail-render 的 turn 页一致 (var/function, 无构建步骤),
// 但数据来源换成 fetch + EventSource, DOM 只做增量 reconcile。
const CHAT_JS = `
(function(){
  var qs = new URLSearchParams(location.search);
  var TOKEN = qs.get('id') || '';
  var S = { base:'', target:'', tags:[], es:null, pinned:true };
  var $ = function(s){ return document.querySelector(s); };
  var thread = $('#thread'), tagsEl = $('#tags'), sbEl = $('#sb'), connEl = $('#conn');

  var fmtTok = function(n){
    if(!n) return '0';
    if(n < 1000) return String(n);
    if(n < 1e6){ var v = n/1000; return (v>=10 ? v.toFixed(0) : v.toFixed(1).replace(/\\.0$/,'')) + 'k'; }
    return (n/1e6).toFixed(2).replace(/\\.?0+$/,'') + 'M';
  };
  var fmtDur = function(ms){
    if(ms < 1000) return ms + 'ms';
    var s = Math.round(ms/1000);
    if(s < 60) return s + 's';
    var m = Math.floor(s/60);
    if(m < 60) return m + 'm' + (s-m*60) + 's';
    return Math.floor(m/60) + 'h' + (m%60) + 'm';
  };
  // 聊天列表用的相对时间 — 一眼看出"刚刚 / 5 分钟前"。
  var fmtAgo = function(ts){
    if(!ts) return '';
    var d = Date.now() - ts;
    if(d < 60000) return '刚刚';
    if(d < 3600000) return Math.floor(d/60000) + '分钟前';
    if(d < 86400000) return Math.floor(d/3600000) + '小时前';
    var x = new Date(ts), p = function(n){ return n<10 ? '0'+n : ''+n; };
    return p(x.getMonth()+1) + '-' + p(x.getDate()) + ' ' + p(x.getHours()) + ':' + p(x.getMinutes());
  };
  var esc = function(s){
    return String(s==null?'':s).replace(/[&<>"']/g, function(c){
      return c==='&'?'&amp;':c==='<'?'&lt;':c==='>'?'&gt;':c==='"'?'&quot;':'&#39;';
    });
  };
  var api = function(path, params){
    var p = new URLSearchParams(params||{}); p.set('id', TOKEN);
    return fetch(path + '?' + p.toString(), {cache:'no-store'}).then(function(r){ return r.json(); });
  };

  // ── markdown 渲染 (只对未渲染过的节点做, 复用节点不重绘) ──
  var md = null;
  var render = function(scope){
    if(!window.markdownit) return;
    if(!md){
      md = window.markdownit({html:false, linkify:true, breaks:true, highlight:function(str,lang){
        if(lang && window.hljs){
          try{ return window.hljs.highlight(str,{language:lang,ignoreIllegals:true}).value; }catch(e){}
        }
        if(window.hljs){ try{ return window.hljs.highlightAuto(str).value; }catch(e){} }
        return '';
      }});
    }
    scope.querySelectorAll('.bubble').forEach(function(b){
      var src = b.querySelector('script.md-src'), body = b.querySelector('.md-body');
      if(src && body && body.dataset.rendered !== '1'){
        body.innerHTML = md.render(src.textContent||'');
        body.dataset.rendered = '1';
      }
    });
  };

  // ── 增量 reconcile (与 turn 页同款, 但会递归进 .bubbles) ──
  var snapOpen = function(scope){
    var m = {};
    scope.querySelectorAll('[data-key]').forEach(function(b){
      var k = b.getAttribute('data-key');
      b.querySelectorAll('details').forEach(function(d,i){ m[k+'#'+i] = d.open; });
    });
    return m;
  };
  var restoreOpen = function(scope, m){
    scope.querySelectorAll('[data-key]').forEach(function(b){
      var k = b.getAttribute('data-key');
      b.querySelectorAll('details').forEach(function(d,i){
        var v = m[k+'#'+i]; if(v !== undefined) d.open = v;
      });
    });
  };
  var childBy = function(el, cls){
    for(var i=0;i<el.children.length;i++) if(el.children[i].classList.contains(cls)) return el.children[i];
    return null;
  };
  // sig 相同 → 原节点原样留下; 不同但两边都是 turn-group → 只换头 + 递归气泡层,
  // 这样一次 tool_result 到达不会重建整轮 DOM (滚动位置 / 展开态全部保住)。
  var reconcile = function(cur, next){
    var open = snapOpen(cur), existing = {};
    Array.prototype.forEach.call(cur.children, function(c){
      var k = c.getAttribute('data-key'); if(k) existing[k] = c;
    });
    var nodes = Array.prototype.map.call(next.children, function(nc){
      var k = nc.getAttribute('data-key'), ex = k ? existing[k] : null;
      if(!ex) return document.importNode(nc, true);
      if(ex.getAttribute('data-sig') === nc.getAttribute('data-sig')) return ex;
      var eb = childBy(ex,'bubbles'), nb = childBy(nc,'bubbles');
      if(eb && nb){
        var eh = childBy(ex,'tg-head'), nh = childBy(nc,'tg-head');
        if(eh && nh) eh.innerHTML = nh.innerHTML;
        reconcile(eb, nb);
        ex.setAttribute('data-sig', nc.getAttribute('data-sig') || '');
        return ex;
      }
      return document.importNode(nc, true);
    });
    cur.replaceChildren.apply(cur, nodes);
    restoreOpen(cur, open);
    render(cur);
  };
  var frag = function(html){
    var d = document.createElement('div'); d.innerHTML = html; return d;
  };

  // ── 滚动: 默认到底; 用户手动上翻后解除吸附, 回到底部再吸附 ──
  var atBottom = function(){
    return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  };
  var toBottom = function(force){
    if(force || S.pinned) thread.scrollTop = thread.scrollHeight;
  };
  thread.addEventListener('scroll', function(){ S.pinned = atBottom(); });

  // ── 侧栏 (聊天列表) ──
  var renderTags = function(){
    tagsEl.replaceChildren.apply(tagsEl, S.tags.map(function(t){
      var el = document.createElement('div');
      el.className = 'tag-row' + (t.target === S.target ? ' on' : '');
      el.innerHTML =
        '<div class="tag-av">' + esc(t.label) + (t.running ? '<span class="live"></span>' : '') + '</div>' +
        '<div class="tag-main">' +
          '<div class="tag-l1"><span class="tag-name">' + esc(t.tag ? '#' + t.tag : 'default') + '</span>' +
            (t.running ? '<span class="tag-badge">运行中</span>' : '') +
            '<span class="tag-ts">' + esc(fmtAgo(t.lastTs)) + '</span></div>' +
          '<div class="tag-prev">' + esc(t.preview || '(暂无对话)') + '</div>' +
        '</div>';
      el.onclick = function(){ select(t.target); };
      return el;
    }));
  };

  var topbar = function(){
    var t = S.tags.filter(function(x){ return x.target === S.target; })[0];
    $('#tb-em').textContent = t ? t.label : '💬';
    $('#tb-h').textContent = t ? (t.tag ? '#' + t.tag : 'default') : '';
    $('#tb-sub').textContent = S.target;
  };

  var COLORS = {input:'#0a7d6b', cacheRead:'#8250df', cacheWrite:'#953800', output:'#1a7f37'};
  var renderStatus = function(u, running){
    if(!u){ sbEl.innerHTML = ''; return; }
    var segs = [['input','Input'],['cacheRead','Cache read'],['cacheWrite','Cache write'],['output','Output']]
      .filter(function(s){ return u[s[0]] > 0; });
    var total = segs.reduce(function(a,s){ return a + u[s[0]]; }, 0) || 1;
    var bar = segs.map(function(s){
      return '<span class="seg" style="width:' + (u[s[0]]/total*100).toFixed(2) + '%;background:' + COLORS[s[0]] +
        '" title="' + s[1] + ': ' + fmtTok(u[s[0]]) + '"></span>';
    }).join('');
    var st = function(k,v){ return '<span class="st"><span class="k">' + k + '</span><span class="v">' + v + '</span></span>'; };
    sbEl.innerHTML =
      '<span class="' + (running ? 'run' : 'idle') + '">' + (running ? '● 进行中' : '○ 空闲') + '</span>' +
      st('turns', u.turns) + st('tools', u.tools) + st('api', u.calls) +
      st('ctx', fmtTok(u.ctxPeak||0)) + st('out', fmtTok(u.output||0)) +
      st('cache', fmtTok((u.cacheRead||0)+(u.cacheWrite||0))) +
      st('time', fmtDur(u.durationMs||0)) +
      '<span class="sb-bar">' + bar + '</span>';
  };

  // ── 线程 ──
  var applySummary = function(d){
    S.base = d.base; S.tags = d.tags || [];
    $('#side-sub').textContent = d.base || '';
    renderTags(); topbar();
    var cur = S.tags.filter(function(x){ return x.target === S.target; })[0];
    if(cur) renderStatus(cur.usage, cur.running);
  };

  var loadThread = function(target, limit){
    return api('api/thread', limit ? {target:target, limit:limit} : {target:target}).then(function(d){
      if(!d.ok || target !== S.target) return;
      var inner = $('#thread-in');
      if(!d.turns.length){ inner.innerHTML = '<div class="empty">这个会话还没有记录</div>'; return; }
      // 默认只取最近若干轮 (贴底阅读), 更早的按需一次性拉全。
      var more = d.truncated
        ? '<button class="more-btn" id="more">载入更早的 ' + (d.total - d.turns.length) + ' 轮</button>'
        : '';
      inner.innerHTML = more + d.turns.map(function(t){ return t.html; }).join('');
      var btn = $('#more');
      if(btn) btn.onclick = function(){ btn.textContent = '载入中…'; loadThread(target, '0'); };
      render(inner);
      S.pinned = true; toBottom(true);
      // CDN 字体/代码高亮加载完会改变高度, 再吸一次底。
      setTimeout(function(){ toBottom(); }, 60);
    });
  };

  var upsertTurn = function(t){
    var inner = $('#thread-in');
    var empty = inner.querySelector('.empty'); if(empty) empty.remove();
    var stick = S.pinned;
    var cur = null;
    Array.prototype.forEach.call(inner.children, function(c){
      if(c.getAttribute('data-key') === 't:' + t.id) cur = c;
    });
    if(!cur){
      inner.insertAdjacentHTML('beforeend', t.html);
      render(inner);
    } else if(cur.getAttribute('data-sig') !== t.sig){
      var box = frag(t.html).firstElementChild;
      var eb = childBy(cur,'bubbles'), nb = box && childBy(box,'bubbles');
      if(eb && nb){
        var eh = childBy(cur,'tg-head'), nh = childBy(box,'tg-head');
        if(eh && nh) eh.innerHTML = nh.innerHTML;
        reconcile(eb, nb);
        cur.setAttribute('data-sig', t.sig);
      } else if(box){
        cur.replaceWith(box); render(inner);
      }
    }
    if(stick) toBottom(true);
  };

  var select = function(target){
    if(!target) return;
    S.target = target;
    document.querySelector('.app').classList.add('reading');
    renderTags(); topbar();
    var cur = S.tags.filter(function(x){ return x.target === target; })[0];
    if(cur) renderStatus(cur.usage, cur.running);
    $('#thread-in').innerHTML = '<div class="empty">加载中…</div>';
    loadThread(target).then(function(){ connect(); });
  };
  $('#tb-back').onclick = function(){ document.querySelector('.app').classList.remove('reading'); };

  // ── SSE: chat 摘要 + 当前 tag 的 turn 增量。断线指数退避重连。 ──
  var backoff = 1000;
  var connect = function(){
    if(S.es){ S.es.close(); S.es = null; }
    var p = new URLSearchParams({id:TOKEN, target:S.target});
    var es = new EventSource('api/events?' + p.toString());
    S.es = es;
    es.addEventListener('chat', function(e){ try{ applySummary(JSON.parse(e.data)); }catch(err){} });
    es.addEventListener('turn', function(e){ try{ upsertTurn(JSON.parse(e.data)); }catch(err){} });
    es.onopen = function(){ backoff = 1000; connEl.className = 'conn'; connEl.title = '实时连接'; };
    es.onerror = function(){
      connEl.className = 'conn off'; connEl.title = '连接断开, 重连中';
      es.close(); if(S.es === es) S.es = null;
      setTimeout(function(){ if(!S.es) connect(); }, backoff);
      backoff = Math.min(backoff * 2, 15000);
    };
  };

  // ── boot ──
  api('api/chat', {}).then(function(d){
    if(!d.ok){ document.body.innerHTML = '<div class="empty" style="padding:80px">' + esc(d.error||'not found') + '</div>'; return; }
    applySummary(d);
    // 卡片链接带来的那条 turn 决定默认选中的 tag; 否则取最近活跃的。
    select(d.self && d.self.target ? d.self.target : (S.tags[0] && S.tags[0].target));
  });
})();
`;

export const renderChatPage = (): string =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Chat Details</title>
<link rel="stylesheet" href="https://unpkg.com/highlight.js@11/styles/github.min.css">
<style>${SHARED_CSS}${TURN_CSS}${CHAT_CSS}</style>
<script src="https://unpkg.com/markdown-it@14/dist/markdown-it.min.js"></script>
<script src="https://unpkg.com/@highlightjs/cdn-assets@11/highlight.min.js"></script>
</head><body>
<div class="app">
  <aside class="side">
    <div class="side-head"><div class="t">会话列表</div><div class="s" id="side-sub"></div></div>
    <div class="tags" id="tags"></div>
  </aside>
  <main class="main">
    <div class="topbar">
      <span class="back" id="tb-back">‹</span>
      <span class="em" id="tb-em">💬</span>
      <span class="h" id="tb-h"></span>
      <span class="sub" id="tb-sub"></span>
    </div>
    <div class="thread" id="thread"><div class="thread-in" id="thread-in"></div></div>
    <div class="statusbar">
      <span id="sb" style="display:contents"></span>
      <span class="conn" id="conn"><span class="d"></span></span>
    </div>
  </main>
</div>
<script>${CHAT_JS}</script>
</body></html>`;
