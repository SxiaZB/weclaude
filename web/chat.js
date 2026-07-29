// Chat 详情 SPA。数据全部来自 /api/chat (侧栏 + 总账) 与 /api/thread (线程),
// 增量走 /api/events (SSE)。turn 正文是服务端渲染好的 HTML 片段 —— diff / ANSI /
// 语法高亮只在 shared/detail-render 实现一次, 这里只做 DOM 增量 reconcile。
//
// 无构建步骤: 保持 var / function 写法, 直接被浏览器加载。
(function () {
  var qs = new URLSearchParams(location.search);
  var TOKEN = qs.get('id') || '';
  var TICK_MS = 3000;

  // at / recvAt: 服务端快照时刻与本地收到时刻。所有"现在几点"的判断都换算到
  // 服务端时钟, 否则客户端时钟偏几分钟就会把运行中的会话判成已结束。
  var S = { base: '', target: '', tags: [], at: 0, recvAt: 0, es: null, pinned: true };
  var $ = function (s) { return document.querySelector(s); };
  var thread = $('#thread'), tagsEl = $('#tags'), sbEl = $('#sb'), connEl = $('#conn');

  var srvNow = function () { return S.at ? S.at + (Date.now() - S.recvAt) : Date.now(); };

  var fmtTok = function (n) {
    if (!n) return '0';
    if (n < 1000) return String(n);
    if (n < 1e6) { var v = n / 1000; return (v >= 10 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '')) + 'k'; }
    return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  };
  var fmtDur = function (ms) {
    if (ms < 1000) return ms + 'ms';
    var s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm' + (s - m * 60) + 's';
    return Math.floor(m / 60) + 'h' + (m % 60) + 'm';
  };
  // 聊天列表用的相对时间 — 一眼看出"刚刚 / 5 分钟前"。
  var fmtAgo = function (ts) {
    if (!ts) return '';
    var d = srvNow() - ts;
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + '分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + '小时前';
    var x = new Date(ts), p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return p(x.getMonth() + 1) + '-' + p(x.getDate()) + ' ' + p(x.getHours()) + ':' + p(x.getMinutes());
  };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;';
    });
  };
  var api = function (path, params) {
    var p = new URLSearchParams(params || {}); p.set('id', TOKEN);
    return fetch(path + '?' + p.toString(), { cache: 'no-store' }).then(function (r) { return r.json(); });
  };

  // ── 运行状态: 服务端只给"到这个时刻自动算结束", 由客户端定时判定 ──
  // SSE 只在有写入时推送, 一个真正停下来的 turn 不会再产生任何事件 —— 没有本地
  // 判定, 页面上的「运行中 / 正在思考」就永远熄不掉。
  var isRunning = function (t) { return !!t.runningUntil && srvNow() < t.runningUntil; };
  var curTag = function () {
    return S.tags.filter(function (x) { return x.target === S.target; })[0];
  };

  // ── markdown 渲染 (只对未渲染过的节点做, 复用节点不重绘) ──
  var md = null;
  var render = function (scope) {
    if (!window.markdownit) return;
    if (!md) {
      md = window.markdownit({
        html: false, linkify: true, breaks: true, highlight: function (str, lang) {
          if (lang && window.hljs) {
            try { return window.hljs.highlight(str, { language: lang, ignoreIllegals: true }).value; } catch (e) { }
          }
          if (window.hljs) { try { return window.hljs.highlightAuto(str).value; } catch (e) { } }
          return '';
        }
      });
    }
    scope.querySelectorAll('.bubble').forEach(function (b) {
      var src = b.querySelector('script.md-src'), body = b.querySelector('.md-body');
      if (src && body && body.dataset.rendered !== '1') {
        body.innerHTML = md.render(src.textContent || '');
        body.dataset.rendered = '1';
      }
    });
  };

  // ── 增量 reconcile (与 turn 页同款, 但会递归进 .bubbles) ──
  var snapOpen = function (scope) {
    var m = {};
    scope.querySelectorAll('[data-key]').forEach(function (b) {
      var k = b.getAttribute('data-key');
      b.querySelectorAll('details').forEach(function (d, i) { m[k + '#' + i] = d.open; });
    });
    return m;
  };
  var restoreOpen = function (scope, m) {
    scope.querySelectorAll('[data-key]').forEach(function (b) {
      var k = b.getAttribute('data-key');
      b.querySelectorAll('details').forEach(function (d, i) {
        var v = m[k + '#' + i]; if (v !== undefined) d.open = v;
      });
    });
  };
  var childBy = function (el, cls) {
    for (var i = 0; i < el.children.length; i++) if (el.children[i].classList.contains(cls)) return el.children[i];
    return null;
  };
  // sig 相同 → 原节点原样留下; 不同但两边都是 turn-group → 只换头 + 递归气泡层,
  // 这样一次 tool_result 到达不会重建整轮 DOM (滚动位置 / 展开态全部保住)。
  var reconcile = function (cur, next) {
    var open = snapOpen(cur), existing = {};
    Array.prototype.forEach.call(cur.children, function (c) {
      var k = c.getAttribute('data-key'); if (k) existing[k] = c;
    });
    var nodes = Array.prototype.map.call(next.children, function (nc) {
      var k = nc.getAttribute('data-key'), ex = k ? existing[k] : null;
      if (!ex) return document.importNode(nc, true);
      if (ex.getAttribute('data-sig') === nc.getAttribute('data-sig')) return ex;
      var eb = childBy(ex, 'bubbles'), nb = childBy(nc, 'bubbles');
      if (eb && nb) {
        var eh = childBy(ex, 'tg-head'), nh = childBy(nc, 'tg-head');
        if (eh && nh) eh.innerHTML = nh.innerHTML;
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
  var frag = function (html) {
    var d = document.createElement('div'); d.innerHTML = html; return d;
  };

  // ── 滚动: 默认到底; 用户手动上翻后解除吸附, 回到底部再吸附 ──
  var atBottom = function () {
    return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  };
  var toBottom = function (force) {
    if (force || S.pinned) thread.scrollTop = thread.scrollHeight;
  };
  thread.addEventListener('scroll', function () { S.pinned = atBottom(); });

  // ── 侧栏 (聊天列表) ──
  var tagMeta = function (t) {
    var u = t.usage || {};
    var bits = [];
    if (t.turns) bits.push(t.turns + ' 轮');
    if (u.tools) bits.push(u.tools + ' 工具');
    var tok = (u.output || 0) + (u.input || 0);
    if (tok) bits.push(fmtTok(tok) + ' tok');
    if (!bits.length) return '';
    return '<div class="tag-meta">' + bits.map(esc).join('<span class="sep">·</span>') + '</div>';
  };
  var renderTags = function () {
    if (!S.tags.length) {
      tagsEl.innerHTML = '<div class="empty-side">这个 chat 还没有会话记录</div>';
      return;
    }
    $('#side-n').textContent = S.tags.length + ' 个会话';
    tagsEl.replaceChildren.apply(tagsEl, S.tags.map(function (t) {
      var run = isRunning(t);
      var el = document.createElement('div');
      el.className = 'tag-row' + (t.target === S.target ? ' on' : '') + (run ? ' running' : '');
      el.innerHTML =
        '<div class="tag-av">' + esc(t.label) + (run ? '<span class="live"></span>' : '') + '</div>' +
        '<div class="tag-main">' +
          '<div class="tag-l1">' +
            '<span class="tag-name">' + esc(t.tag ? '#' + t.tag : 'default') + '</span>' +
            '<span class="tag-ts">' + esc(fmtAgo(t.lastTs)) + '</span>' +
          '</div>' +
          '<div class="tag-prev">' + esc(t.preview || '(暂无对话)') + '</div>' +
          tagMeta(t) +
        '</div>';
      el.onclick = function () { select(t.target); };
      return el;
    }));
  };

  var topbar = function () {
    var t = curTag();
    $('#tb-em').textContent = t ? t.label : '💬';
    $('#tb-h').textContent = t ? (t.tag ? '#' + t.tag : 'default') : '';
    $('#tb-sub').textContent = S.target;
  };

  // ── 页脚总账 ──
  var COLORS = { input: '#0a7d6b', cacheRead: '#8250df', cacheWrite: '#953800', output: '#1a7f37' };
  // 进行中的会话, 耗时要跟着走: durationMs 只统计到快照时刻 at, 之后的补上;
  // runningUntil 一过就冻住, 不会像旧版那样把静默期一路累加成几十小时。
  var liveDur = function (t) {
    var d = (t.usage && t.usage.durationMs) || 0;
    if (!t.runningUntil) return d;
    return d + Math.max(0, Math.min(srvNow(), t.runningUntil) - S.at);
  };
  var renderStatus = function (t) {
    if (!t) { sbEl.innerHTML = ''; return; }
    var u = t.usage || {}, run = isRunning(t);
    var segs = [['input', 'Input'], ['cacheRead', 'Cache read'], ['cacheWrite', 'Cache write'], ['output', 'Output']]
      .filter(function (s) { return u[s[0]] > 0; });
    var total = segs.reduce(function (a, s) { return a + u[s[0]]; }, 0);
    // token 一条都没采到就别画那条空槽 —— 空进度条看着像"用了 0%", 是误导。
    var bar = total > 0
      ? '<span class="sb-bar">' + segs.map(function (s) {
          return '<span class="seg" style="width:' + (u[s[0]] / total * 100).toFixed(2) + '%;background:' +
            COLORS[s[0]] + '" title="' + s[1] + ': ' + fmtTok(u[s[0]]) + '"></span>';
        }).join('') + '</span>'
      : '';
    // 值为 0 = 该指标没有数据 (老记录 / 网关不报 usage), 压暗成 "–" 与真实的 0 区分。
    var st = function (k, n, text) {
      return '<span class="st' + (n ? '' : ' void') + '" title="' + esc(k) + '">' +
        '<span class="k">' + k + '</span><span class="v">' + (n ? esc(text) : '–') + '</span></span>';
    };
    var cache = (u.cacheRead || 0) + (u.cacheWrite || 0);
    sbEl.innerHTML =
      '<span class="pill' + (run ? ' run' : '') + '"><span class="d"></span>' + (run ? '进行中' : '空闲') + '</span>' +
      (t.model ? '<span class="model" title="' + esc(t.model) + '">' + esc(t.model) + '</span>' : '') +
      st('turns', t.turns, t.turns) +
      st('tools', u.tools, u.tools) +
      st('api', u.calls, u.calls) +
      st('ctx', u.ctxPeak, fmtTok(u.ctxPeak)) +
      st('out', u.output, fmtTok(u.output)) +
      st('cache', cache, fmtTok(cache)) +
      st('time', liveDur(t), fmtDur(liveDur(t))) +
      bar;
  };

  // ── 线程 ──
  var applySummary = function (d) {
    S.base = d.base; S.tags = d.tags || [];
    S.at = d.at || Date.now(); S.recvAt = Date.now();
    $('#side-sub').textContent = d.base || '';
    renderTags(); topbar(); renderStatus(curTag());
  };

  var loadThread = function (target, limit) {
    return api('api/thread', limit ? { target: target, limit: limit } : { target: target }).then(function (d) {
      if (!d.ok || target !== S.target) return;
      var inner = $('#thread-in');
      if (!d.turns.length) { inner.innerHTML = '<div class="empty">这个会话还没有记录</div>'; return; }
      // 默认只取最近若干轮 (贴底阅读), 更早的按需一次性拉全。
      var more = d.truncated
        ? '<button class="more-btn" id="more">载入更早的 ' + (d.total - d.turns.length) + ' 轮</button>'
        : '';
      inner.innerHTML = more + d.turns.map(function (t) { return t.html; }).join('');
      d.turns.forEach(function (t) { markStale(t); });
      var btn = $('#more');
      if (btn) btn.onclick = function () { btn.textContent = '载入中…'; loadThread(target, '0'); };
      render(inner);
      expireTurns();
      S.pinned = true; toBottom(true);
      // CDN 字体/代码高亮加载完会改变高度, 再吸一次底。
      setTimeout(function () { toBottom(); }, 60);
    });
  };

  // staleAt 由 JSON 单独送来 (不在 html 里, 否则会打乱服务端的 sig 去重), 落到
  // DOM 上供 expireTurns 定时判定。
  var turnNode = function (id) {
    var inner = $('#thread-in'), hit = null;
    Array.prototype.forEach.call(inner.children, function (c) {
      if (c.getAttribute('data-key') === 't:' + id) hit = c;
    });
    return hit;
  };
  var markStale = function (t) {
    var n = turnNode(t.id);
    if (n) n.setAttribute('data-stale-at', t.staleAt || 0);
  };

  var upsertTurn = function (t) {
    var inner = $('#thread-in');
    var empty = inner.querySelector('.empty'); if (empty) empty.remove();
    var stick = S.pinned;
    var cur = turnNode(t.id);
    if (!cur) {
      inner.insertAdjacentHTML('beforeend', t.html);
      render(inner);
    } else if (cur.getAttribute('data-sig') !== t.sig) {
      var box = frag(t.html).firstElementChild;
      var eb = childBy(cur, 'bubbles'), nb = box && childBy(box, 'bubbles');
      if (eb && nb) {
        var eh = childBy(cur, 'tg-head'), nh = childBy(box, 'tg-head');
        if (eh && nh) eh.innerHTML = nh.innerHTML;
        reconcile(eb, nb);
        cur.setAttribute('data-sig', t.sig);
      } else if (box) {
        cur.replaceWith(box); render(inner);
      }
    }
    markStale(t);
    if (stick) toBottom(true);
  };

  // 到点了还没有新写入 → 这一轮已经结束: 熄掉呼吸点、移除"正在思考"。
  var expireTurns = function () {
    var now = srvNow();
    $('#thread-in').querySelectorAll('.turn-group[data-stale-at]').forEach(function (g) {
      var until = Number(g.getAttribute('data-stale-at') || 0);
      if (!until || now <= until) return;
      g.setAttribute('data-stale-at', '0');
      var dot = g.querySelector('.tg-dot'); if (dot) dot.classList.remove('live');
      var typing = g.querySelector('.typing'); if (typing) typing.remove();
    });
  };

  var select = function (target) {
    if (!target) return;
    S.target = target;
    document.querySelector('.app').classList.add('reading');
    renderTags(); topbar(); renderStatus(curTag());
    $('#thread-in').innerHTML = '<div class="empty">加载中…</div>';
    loadThread(target).then(function () { connect(); });
  };
  $('#tb-back').onclick = function () { document.querySelector('.app').classList.remove('reading'); };

  // ── SSE: chat 摘要 + 当前 tag 的 turn 增量。断线指数退避重连。 ──
  var backoff = 1000;
  var connect = function () {
    if (S.es) { S.es.close(); S.es = null; }
    var p = new URLSearchParams({ id: TOKEN, target: S.target });
    var es = new EventSource('api/events?' + p.toString());
    S.es = es;
    es.addEventListener('chat', function (e) { try { applySummary(JSON.parse(e.data)); } catch (err) { } });
    es.addEventListener('turn', function (e) { try { upsertTurn(JSON.parse(e.data)); } catch (err) { } });
    es.onopen = function () { backoff = 1000; connEl.className = 'conn'; connEl.title = '实时连接'; };
    es.onerror = function () {
      connEl.className = 'conn off'; connEl.title = '连接断开, 重连中';
      es.close(); if (S.es === es) S.es = null;
      setTimeout(function () { if (!S.es) connect(); }, backoff);
      backoff = Math.min(backoff * 2, 15000);
    };
  };

  // 本地心跳: 相对时间、运行中判定、耗时都随时间变化, 但服务端没有新事件可推。
  setInterval(function () {
    if (!S.tags.length) return;
    renderTags();
    renderStatus(curTag());
    expireTurns();
  }, TICK_MS);

  // ── boot ──
  api('api/chat', {}).then(function (d) {
    if (!d.ok) {
      document.body.innerHTML = '<div class="empty" style="padding:80px">' + esc(d.error || 'not found') + '</div>';
      return;
    }
    applySummary(d);
    // 卡片链接带来的那条 turn 决定默认选中的 tag; 否则取最近活跃的。
    select(d.self && d.self.target ? d.self.target : (S.tags[0] && S.tags[0].target));
  });
})();
