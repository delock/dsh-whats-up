// dsh-whats-up client plugin — What's up · 会话动态面板(浏览器半)。
// --------------------------------------------------------------
// 与 pr-board 相同的契约:window.__ModuleLoader__.load({id, factory}),factory
// 返回 { name, inject, apply }。inject 声明依赖的服务名("sessions"),由宿主
// 在对应包就绪后解析;apply(ctx) 拿到客户端根上下文。
// 面板数据全部来自 host 端 /api/whats-up/data(host 只在文件指纹变化时
// 才重新分析,所以这里放心轮询)。点卡片 = CTX.sessions.open(sid) 直接跳回
// 那个被遗忘的会话。
(function () {
  var CSS_TEXT = `
#sa-widget{flex:none;margin-top:8px;padding:8px 2px 2px;border-top:1px solid color-mix(in srgb,currentColor 14%,transparent);font-size:12px;color:inherit;min-width:0;cursor:pointer}
#sa-widget .saw-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;font-weight:600;gap:6px}
#sa-widget .saw-list{display:flex;flex-wrap:wrap;gap:4px}
#sa-widget .saw-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:8px;font-size:11px;font-weight:600;background:color-mix(in srgb,currentColor 10%,transparent)}
#sa-widget .saw-chip b{font-weight:700}
#sa-widget .saw-chip.half b{color:#f87171}
#sa-widget .saw-chip.unans b{color:#fbbf24}
#sa-widget .saw-chip.dim{opacity:.55}
#sa-widget.saw-rail{padding:8px 0 2px;margin-top:6px;display:flex;justify-content:center}
#sa-widget.saw-rail .saw-head{display:none}
#sa-widget.saw-rail .saw-list{display:none}
#sa-widget .saw-railbtn{position:relative;display:none;width:36px;height:36px;align-items:center;justify-content:center;border-radius:50%;color:inherit;cursor:pointer}
#sa-widget.saw-rail .saw-railbtn{display:inline-flex}
#sa-widget .saw-railbtn:hover{background:color-mix(in srgb,currentColor 12%,transparent)}
#sa-widget .saw-railbtn svg{width:18px;height:18px;flex:none;pointer-events:none}
#sa-widget .saw-railbadge{position:absolute;top:1px;right:0;min-width:15px;height:15px;padding:0 4px;box-sizing:border-box;border-radius:8px;background:#ef4444;color:#fff;font-size:10px;font-weight:700;line-height:15px;text-align:center;pointer-events:none}
#sa-widget .saw-railbadge[hidden]{display:none}
#sa-overlay{position:fixed;inset:0;z-index:2147483000;display:none;background:color-mix(in srgb,#000000 62%,transparent);backdrop-filter:blur(3px)}
#sa-overlay.sa-show{display:flex;flex-direction:column}
#sa-overlay .sao-head{display:flex;align-items:center;gap:10px;padding:12px 18px;color:#fff;background:#161b22;flex:none;flex-wrap:wrap}
#sa-overlay .sao-title{font-size:15px;font-weight:700}
#sa-overlay .sao-sub{font-size:12px;opacity:.65;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#sa-overlay .sao-spacer{flex:1}
#sa-overlay .sao-btn{padding:4px 10px;border-radius:6px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:#fff;font-size:12px;cursor:pointer}
#sa-overlay .sao-btn:hover{background:rgba(255,255,255,.18)}
#sa-overlay .sao-x{border:none;font-size:16px;line-height:1;padding:4px 8px}
#sa-overlay .sao-tabs{display:flex;gap:6px;align-items:center;padding:8px 14px 0;flex-wrap:wrap;flex:none}
#sa-overlay .sao-tab{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.05);color:rgba(255,255,255,.75);font-size:12px;font-weight:600;cursor:pointer}
#sa-overlay .sao-tab:hover{background:rgba(255,255,255,.12);color:#fff}
#sa-overlay .sao-tab.sa-active{background:rgba(31,111,235,.35);border-color:rgba(96,165,250,.5);color:#fff}
#sa-overlay .sao-body{flex:1;overflow:auto;padding:12px 14px;display:flex;flex-direction:column;gap:8px;align-items:stretch;max-width:980px;width:100%;margin:0 auto;box-sizing:border-box}
#sa-overlay .sao-card{position:relative;padding:10px 12px;border-radius:10px;background:#1c2129;color:#d7dde5;font-size:12.5px;line-height:1.5;border:1px solid transparent;cursor:pointer;min-width:0}
#sa-overlay .sao-card:hover{border-color:rgba(255,255,255,.25);background:#232935}
#sa-overlay .sao-card .sao-r1{display:flex;align-items:baseline;gap:8px;min-width:0}
#sa-overlay .sao-card .sao-dot{width:8px;height:8px;border-radius:50%;flex:none;align-self:center}
#sa-overlay .sao-card .sao-title{font-weight:700;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#sa-overlay .sao-card .sao-when{flex:none;font-size:11px;opacity:.6;margin-right:24px}
#sa-overlay .sao-card .sao-done{position:absolute;top:6px;right:6px;width:20px;height:20px;line-height:18px;text-align:center;padding:0;border:none;border-radius:50%;background:rgba(52,211,153,.22);color:#6ee7b7;font-size:12px;cursor:pointer;opacity:.6}
#sa-overlay .sao-card:hover .sao-done{opacity:1}
#sa-overlay .sao-card .sao-done:hover{background:rgba(52,211,153,.45)}
#sa-overlay .sao-card.sa-marked{opacity:.45}
#sa-overlay .sao-card.sa-marked:hover{opacity:.75}
#sa-overlay .sao-card.sa-marked .sao-title{text-decoration:line-through}
#sa-overlay .sao-card.sa-marked .sao-done{background:rgba(148,163,184,.25);color:#cbd5e1;opacity:.8;pointer-events:auto}
#sa-overlay .sao-card .sao-summary{margin-top:5px;font-size:12.5px;color:#dbe4f0;line-height:1.5}
#sa-overlay .sao-card .sao-summary-pending{opacity:.55;font-style:italic}
#sa-overlay .sao-card .sao-summary-fallback{opacity:.8}
#sa-overlay .sao-digest{margin:10px 14px 0;padding:9px 12px;border-radius:8px;background:rgba(96,165,250,.12);border-left:3px solid rgba(96,165,250,.55);color:#cfe0f5;font-size:12.5px;line-height:1.55;flex:none}
#sa-overlay .sao-digest-pending{opacity:.6;font-style:italic}
#sa-overlay .sao-card .sao-meta{margin-top:3px;font-size:11px;opacity:.65;display:flex;gap:8px;flex-wrap:wrap}
#sa-overlay .sao-card .sao-orig{opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:340px}
#sa-overlay .sao-card .sao-flags{margin-top:5px;display:flex;gap:5px;flex-wrap:wrap}
#sa-overlay .sao-card .sao-flag{padding:0 6px;border-radius:6px;font-size:11px;background:rgba(239,68,68,.18);color:#fca5a5}
#sa-overlay .sao-card .sao-flag.warn{background:rgba(251,191,36,.16);color:#fcd34d}
#sa-overlay .sao-card .sao-flag.info{background:rgba(255,255,255,.09);color:rgba(255,255,255,.7)}
#sa-overlay .sao-card .sao-todos{margin-top:6px;padding:6px 8px;border-radius:8px;background:rgba(239,68,68,.09);border-left:2px solid rgba(239,68,68,.5);display:flex;flex-direction:column;gap:2px}
#sa-overlay .sao-card .sao-todos .sao-todo{font-size:11.5px;color:#fecaca;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#sa-overlay .sao-card .sao-quote{margin-top:6px;font-size:11.5px;opacity:.75;display:flex;flex-direction:column;gap:2px}
#sa-overlay .sao-card .sao-quote b{opacity:.9;font-weight:600}
#sa-overlay .sao-card .sao-quote span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#sa-overlay .sao-empty{padding:24px;border-radius:10px;border:1px dashed rgba(255,255,255,.15);color:rgba(255,255,255,.4);font-size:12px;text-align:center}
#sa-overlay .sao-loading{color:rgba(255,255,255,.5);font-size:12px;padding:6px 4px}
`;

  var name = "whats-up";
  var inject = ["sessions"];

  var CTX = null;
  var data = null;
  var busy = false;
  var activeTab = "recent";
  var pollTimer = null;
  var fillTimer = null; // 摘要还在生成时的短间隔重拉
  var POLL_MS = 10 * 60 * 1000;

  var STATUS = {
    recent: { label: "近期工作", color: "#c4b5fd", icon: "📌" },
    active: { label: "进行中", color: "#38bdf8", icon: "⚡" },
    half: { label: "做到一半", color: "#f87171", icon: "🔴" },
    unanswered: { label: "问了没回", color: "#fbbf24", icon: "🟡" },
    board: { label: "自动会话", color: "#7aa7ff", icon: "🔵" },
    done: { label: "已完成", color: "#34d399", icon: "🟢" },
    blank: { label: "空白", color: "#94a3b8", icon: "⚪" }
  };
  var TABS = ["recent", "half", "unanswered", "active", "board", "done", "blank"];

  function api(path) {
    return fetch(path).then(function (r) { return r.json(); });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function timeAgo(iso) {
    var t = Date.parse(iso) || 0;
    if (!t) return "";
    var s = Math.max(0, Date.now() - t) / 1000;
    if (s < 60) return "刚刚";
    if (s < 3600) return Math.floor(s / 60) + " 分钟前";
    if (s < 86400) return Math.floor(s / 3600) + " 小时前";
    return Math.floor(s / 86400) + " 天前";
  }

  function shortId(id) {
    var m = /([0-9a-f]{8})-[0-9a-f]{4}/.exec(String(id || ""));
    return m ? m[1] : String(id || "").slice(0, 8);
  }

  function projShort(cwd) {
    var p = String(cwd || "");
    var parts = p.split("/").filter(Boolean);
    return parts.slice(-2).join("/");
  }

  // ---------------- data ----------------

  function refresh(fresh) {
    if (busy) return Promise.resolve();
    busy = true;
    var q = fresh ? "?fresh=1" : "";
    return api("/api/whats-up/data" + q)
      .then(function (v) {
        busy = false;
        if (v && v.ok) {
          data = v;
          renderWidget();
          renderPanel();
          scheduleFill();
        }
      })
      .catch(function () {
        busy = false;
      });
  }

  // 摘要/总述还在 host 端生成时,面板开着就 12s 一拉,直到齐了为止
  function scheduleFill() {
    var ov = document.getElementById("sa-overlay");
    var open = ov && ov.classList.contains("sa-show");
    var pending = data && (data.pendingSummaries > 0 || sessionsOf(activeTab).some(function (s) { return s.summaryState === "pending"; }));
    if (open && pending) {
      if (fillTimer) clearTimeout(fillTimer);
      fillTimer = setTimeout(function () { fillTimer = null; refresh(false); }, 12000);
    }
  }

  // 标记完成(host 端持久,多设备同步):乐观更新本地状态立刻重排,再 POST 同步
  function toggleDone(btn) {
    var sid = btn.getAttribute("data-done-sid") || "";
    if (!sid || !data) return;
    var s = null;
    for (var i = 0; i < data.sessions.length; i++) if (data.sessions[i].id === sid) { s = data.sessions[i]; break; }
    if (!s) return;
    var to = !s.markedDone;
    s.markedDone = to; // 乐观更新 → renderPanel 立刻沉底
    var c = data.counts || {};
    if (to) {
      c[s.status] = Math.max(0, (c[s.status] || 0) - 1);
      if (s.recent) c.recent = Math.max(0, (c.recent || 0) - 1);
    }
    renderWidget();
    renderPanel();
    fetch("/api/whats-up/done", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sid: sid, done: to }),
    })
      .then(function () { refresh(false); })
      .catch(function () { refresh(false); });
  }

  function sessionsOf(tab) {
    if (!data || !data.sessions) return [];
    if (tab === "recent") return data.sessions.filter(function (s) { return s.recent; });
    return data.sessions.filter(function (s) { return s.status === tab; });
  }

  // ---------------- jump ----------------

  function jump(sid, title) {
    if (!CTX || !CTX.sessions || typeof CTX.sessions.open !== "function") {
      toast("无法跳转:sessions 服务不可用");
      return;
    }
    var ok = false;
    try {
      CTX.sessions.open(sid);
      ok = true;
    } catch (e) {
      ok = false;
    }
    if (ok) {
      var ov = document.getElementById("sa-overlay");
      if (ov) ov.classList.remove("sa-show");
      return;
    }
    // 兜底:按标题搜索(会话 id 形态可能不含目录前缀)
    if (CTX.sessions.search && title) {
      CTX.sessions.search(String(title).slice(0, 24)).then(function (res) {
        var items = (res && res.ok && res.value && res.value.items) || [];
        for (var i = 0; i < items.length; i++) {
          if ((items[i].title || "") === title) {
            try { CTX.sessions.open(items[i].sessionId || items[i].id); } catch (e) {}
            var ov2 = document.getElementById("sa-overlay");
            if (ov2) ov2.classList.remove("sa-show");
            return;
          }
        }
        toast("没找到这个会话(可能已被清理)");
      }, function () {
        toast("没找到这个会话(可能已被清理)");
      });
      return;
    }
    toast("没找到这个会话(可能已被清理)");
  }

  // ---------------- widget ----------------

  function widgetHtml() {
    return '<div class="saw-head"><span>What\'s up · 在忙啥</span></div>' +
      '<div class="saw-list" id="saw-row"><span class="saw-chip dim">加载中…</span></div>' +
      '<div class="saw-railbtn" id="saw-railbtn" aria-label="What\'s up">' +
      '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
      '<path d="M8 1.5a6.5 6.5 0 1 0 0 13A.75.75 0 0 0 8 13a5 5 0 1 1 0-10 .75.75 0 0 0 0-1.5Z"/>' +
      '<path d="M8 4.5a3.5 3.5 0 1 0 3.44 4.13.75.75 0 1 0-1.48-.24A2 2 0 1 1 8 6a.75.75 0 0 0 .53-.22l1.5-1.5a.75.75 0 0 0-.53-1.28.75.75 0 0 0-.53.22L8 5.19V4.5Z"/>' +
      '</svg><span class="saw-railbadge" id="saw-railbadge" hidden></span></div>';
  }

  function renderWidget() {
    var row = document.getElementById("saw-row");
    var badge = document.getElementById("saw-railbadge");
    if (!row || !data) return;
    var c = data.counts || {};
    var html = "";
    if (c.recent) html += '<span class="saw-chip">📌 在做 <b>' + c.recent + "</b></span>";
    if (c.half) html += '<span class="saw-chip half">🔴 半途 <b>' + c.half + "</b></span>";
    if (c.unanswered) html += '<span class="saw-chip unans">🟡 没回 <b>' + c.unanswered + "</b></span>";
    if (!html) html += '<span class="saw-chip dim">🟢 无待办会话</span>';
    row.innerHTML = html;
    if (badge) {
      var n = (c.half || 0) + (c.unanswered || 0);
      badge.hidden = !n;
      badge.textContent = n > 99 ? "99+" : String(n);
    }
  }

  function findSidebar() {
    var btns = document.querySelectorAll("button"), i, p, cs, d;
    for (i = 0; i < btns.length; i++) {
      if (!/(new|新建)/i.test(btns[i].textContent || "")) continue;
      p = btns[i].parentElement;
      for (d = 0; p && d < 6; d++) {
        try { cs = getComputedStyle(p); } catch (e) { break; }
        if (cs.getPropertyValue("--dsh-sidebar-inline-padding")) return p;
        p = p.parentElement;
      }
    }
    var els = document.querySelectorAll("body *");
    for (i = 0; i < els.length; i++) {
      try { cs = getComputedStyle(els[i]); } catch (e) { continue; }
      if (cs.getPropertyValue("--dsh-sidebar-inline-padding")) return els[i];
    }
    return null;
  }

  function mountInSidebar(sidebar) {
    var w = document.getElementById("sa-widget");
    if (!w) {
      w = document.createElement("div");
      w.id = "sa-widget";
      w.innerHTML = widgetHtml();
      w.addEventListener("click", function () { openPanel(); });
    } else {
      w.style.cssText = "";
    }
    sidebar.insertBefore(w, sidebar.lastChild);
    watchCollapse(sidebar, w);
    renderWidget();
    return w;
  }

  var RAIL_MAX_WIDTH = 120;
  function watchCollapse(sidebar, w) {
    if (w.__saWatched) return;
    w.__saWatched = true;
    var apply = function () {
      w.classList.toggle("saw-rail", sidebar.getBoundingClientRect().width <= RAIL_MAX_WIDTH);
    };
    apply();
    new MutationObserver(function () {
      apply();
      setTimeout(apply, 220);
    }).observe(sidebar, { attributes: true, attributeFilter: ["class", "style"] });
    if (typeof ResizeObserver === "function") new ResizeObserver(apply).observe(sidebar);
  }

  // ---------------- panel ----------------

  function openPanel() {
    var ov = document.getElementById("sa-overlay");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "sa-overlay";
      document.body.appendChild(ov);
      ov.addEventListener("click", function (e) {
        if (e.target === ov) ov.classList.remove("sa-show");
        var x = e.target.closest && e.target.closest(".sao-x");
        if (x) ov.classList.remove("sa-show");
        var tab = e.target.closest && e.target.closest(".sao-tab");
        if (tab) {
          activeTab = tab.getAttribute("data-tab") || "recent";
          renderPanel();
          scheduleFill();
        }
        var btn = e.target.closest && e.target.closest(".sao-refresh");
        if (btn) refresh(true);
        var doneBtn = e.target.closest && e.target.closest(".sao-done");
        if (doneBtn) { toggleDone(doneBtn); return; }
        var card = e.target.closest && e.target.closest(".sao-card");
        if (card) jump(card.getAttribute("data-sid") || "", card.getAttribute("data-title") || "");
      });
    }
    ov.classList.add("sa-show");
    renderPanel();
    refresh(false);
  }

  // 状态行:LLM 提取的一句话现状优先;生成中给占位;失败/缺失退回规则拼的兜底文案
  function summaryLine(s) {
    if (s.summaryState === "ok" && s.stateText) {
      return '<div class="sao-summary">' + esc(s.stateText) + "</div>";
    }
    if (s.summaryState === "pending") {
      return '<div class="sao-summary sao-summary-pending">⏳ 状态提取中…</div>';
    }
    var fb = "";
    if ((s.openTodos || []).length) fb = "☐ " + s.openTodos[0];
    else if (s.lastUser) fb = s.lastUser;
    if (fb) return '<div class="sao-summary sao-summary-fallback">' + esc(fb) + "</div>";
    return "";
  }

  function cardHtml(s) {
    var st = STATUS[s.status] || {};
    var flags = [];
    var has = function (f) { return (s.flags || []).indexOf(f) >= 0; };
    if (s.recent && s.status === "done") flags.push('<span class="sao-flag info">📌 近期在推进</span>');
    if (has("open-todo")) flags.push('<span class="sao-flag">遗留 todo ' + (s.openTodos || []).length + " 项</span>");
    if (has("open-turn")) flags.push('<span class="sao-flag warn">最后一个 turn 未结束</span>');
    if (has("interrupted")) flags.push('<span class="sao-flag warn">被中断</span>');
    if (has("unanswered")) flags.push('<span class="sao-flag warn">你问了没回</span>');
    if (has("forked")) flags.push('<span class="sao-flag info">曾派生新会话</span>');
    var todos = "";
    if ((s.openTodos || []).length) {
      todos = '<div class="sao-todos">' +
        s.openTodos.map(function (t) { return '<div class="sao-todo">☐ ' + esc(t) + "</div>"; }).join("") +
        "</div>";
    }
    var quotes = "";
    if (s.lastUser) quotes += '<div><b>最后你说:</b><span>' + esc(s.lastUser) + "</span></div>";
    if (s.lastAssistant) quotes += '<div><b>最后回复:</b><span>' + esc(s.lastAssistant) + "</span></div>";
    if (quotes) quotes = '<div class="sao-quote">' + quotes + "</div>";
    // 卡片标题 = LLM 提取的待办目标;原会话标题降为小字注释(跳转搜索兜底用它)
    var sessTitle = s.title || "(无标题)";
    var title = s.goal || sessTitle;
    var origTitle = s.goal && s.goal !== sessTitle ? '<span class="sao-orig">💬 ' + esc(sessTitle) + "</span>" : "";
    var dotColor = activeTab === "recent" && s.recent ? STATUS.recent.color : st.color;
    return '<div class="sao-card' + (s.markedDone ? " sa-marked" : "") + '" data-sid="' + esc(s.id) + '" data-title="' + esc(sessTitle) + '">' +
      '<button class="sao-done" data-done-sid="' + esc(s.id) + '" title="' + (s.markedDone ? "取消完成标记" : "标记为已完成,沉底") + '">' + (s.markedDone ? "↩" : "✓") + "</button>" +
      '<div class="sao-r1"><span class="sao-dot" style="background:' + (dotColor || "#888") + '"></span>' +
      '<span class="sao-title">' + esc(title) + "</span>" +
      '<span class="sao-when">' + timeAgo(new Date(s.lastTime || 0).toISOString()) + " · " + shortId(s.id) + "</span></div>" +
      summaryLine(s) +
      '<div class="sao-meta"><span>📁 ' + esc(projShort(s.cwd)) + "</span><span>" + (s.nTurns || 0) + " 轮 · " + (s.nTools || 0) + " 次工具</span>" + origTitle + "</div>" +
      (flags.length ? '<div class="sao-flags">' + flags.join("") + "</div>" : "") +
      todos + quotes +
      "</div>";
  }

  function renderPanel() {
    var ov = document.getElementById("sa-overlay");
    if (!ov || !ov.classList.contains("sa-show")) return;
    if (!data) {
      ov.innerHTML = '<div class="sao-head"><span class="sao-title">What\'s up</span></div><div class="sao-body"><div class="sao-loading">加载中…</div></div>';
      return;
    }
    var c = data.counts || {};
    var tabs = TABS.map(function (t) {
      var n = t === "recent" ? c.recent || 0 : c[t] || 0;
      if (!n && t !== "recent" && t !== "half") return ""; // 空分类不占标签位
      return '<span class="sao-tab' + (activeTab === t ? " sa-active" : "") + '" data-tab="' + t + '">' +
        (STATUS[t].icon + " " + STATUS[t].label + " " + n) + "</span>";
    }).join("");
    var list = sessionsOf(activeTab).sort(function (a, b) {
      var dm = (a.markedDone ? 1 : 0) - (b.markedDone ? 1 : 0);
      if (dm) return dm;
      return b.lastTime - a.lastTime;
    });
    var body = list.length
      ? list.map(cardHtml).join("")
      : '<div class="sao-empty">这里没有会话 👌</div>';
    var digest = "";
    var dg = (data.tabDigests || {})[activeTab];
    if (dg) {
      digest = '<div class="sao-digest">' + esc(dg) + "</div>";
    } else if ((data.pendingSummaries || 0) > 0 && list.length) {
      digest = '<div class="sao-digest sao-digest-pending">⏳ 正在生成这个分类的总述…</div>';
    }
    ov.innerHTML =
      '<div class="sao-head">' +
      '<span class="sao-title">👀 What\'s up</span>' +
      '<span class="sao-sub">共 ' + (data.total || 0) + " 个 · 在做 " + (c.recent || 0) + " · 半途 " + (c.half || 0) + " · 没回 " + (c.unanswered || 0) +
      " · 自动 " + (c.board || 0) + " · 完成 " + (c.done || 0) + " · 生成于 " + timeAgo(data.generatedAt) + "</span>" +
      '<span class="sao-spacer"></span>' +
      '<button class="sao-btn sao-refresh">刷新</button>' +
      '<button class="sao-btn sao-x">✕</button>' +
      "</div>" +
      '<div class="sao-tabs">' + tabs + "</div>" +
      digest +
      '<div class="sao-body">' + body + "</div>";
  }

  // ---------------- misc ----------------

  function toast(text) {
    var t = document.createElement("div");
    t.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483600;padding:9px 13px;border-radius:8px;background:#1f6feb;color:#fff;font-size:12.5px;box-shadow:0 4px 14px rgba(0,0,0,.4);cursor:pointer";
    t.textContent = text;
    t.onclick = function () { t.remove(); };
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 8000);
  }

  function bindHotkey() {
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        var ov = document.getElementById("sa-overlay");
        if (ov) ov.classList.remove("sa-show");
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "j" || e.key === "J")) {
        e.preventDefault();
        var ov2 = document.getElementById("sa-overlay");
        if (ov2 && ov2.classList.contains("sa-show")) ov2.classList.remove("sa-show");
        else openPanel();
      }
    });
  }

  function injectStyle() {
    if (document.getElementById("sa-style")) return;
    var st = document.createElement("style");
    st.id = "sa-style";
    st.textContent = CSS_TEXT;
    document.head.appendChild(st);
  }

  function init() {
    var sidebar = findSidebar();
    if (!sidebar) {
      // 侧栏还没渲染:稍后重试
      setTimeout(init, 1500);
      return;
    }
    mountInSidebar(sidebar);
    refresh(false);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function () { refresh(false); }, POLL_MS);
  }

  function apply(ctx) {
    CTX = ctx;
    injectStyle();
    bindHotkey();
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
  }

  window.__ModuleLoader__.load({
    id: "dsh-whats-up",
    factory: function () {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
      exports.name = name;
      exports.inject = inject;
      exports.apply = apply;
      return module.exports;
    }
  });
})();
