/*!
 * auto-memory 面板运行时（注入到 Kimi Code Desktop desktop-dist）
 *
 * - 在设置对话框的左侧 tab 列表追加"记忆"入口（克隆原生 tab 的 class 与
 *   data-v-xxx scoped 属性，样式自动跟随主题）
 * - 点击弹出管理面板：总开关 / 自动沉淀 / 三个 scope 开关、条目列表、搜索、
 *   查看、删除、手动新增
 * - 数据经本地 sidecar（127.0.0.1，token 在 /assets/auto-memory.config.json）
 * - 宿主 SPA 重渲染会移除外来节点：1.5s 轮询重挂载（同 usage-union 方案）；
 *   用户点原生 tab 时自动收起面板并让出选中态
 */
(() => {
  if (window.__autoMemoryInstalled) return;
  window.__autoMemoryInstalled = true;

  const CONFIG_URL = "/assets/auto-memory.config.json";
  const REATTACH_MS = 1500;

  // -------------------------------------------------------------------------
  // 主题
  // -------------------------------------------------------------------------
  const CSS = `
.am-scope{--am-fg:#c9c9d1;--am-dim:rgba(201,201,209,.55);--am-bg:rgba(30,30,34,.98);--am-card:rgba(255,255,255,.05);
  --am-border:rgba(255,255,255,.12);--am-hover:rgba(255,255,255,.08);--am-accent:#4f8cff;--am-ok:#4ade80;
  --am-warn:#fbbf24;--am-bad:#f87171;}
.am-scope.light{--am-fg:#3d3d46;--am-dim:rgba(61,61,70,.55);--am-bg:rgba(255,255,255,.98);--am-card:rgba(0,0,0,.04);
  --am-border:rgba(0,0,0,.12);--am-hover:rgba(0,0,0,.06);--am-accent:#3b76e0;--am-ok:#16a34a;
  --am-warn:#d97706;--am-bad:#dc2626;}
@media (prefers-color-scheme: light){.am-scope:not(.dark):not(.light){--am-fg:#3d3d46;--am-dim:rgba(61,61,70,.55);
  --am-bg:rgba(255,255,255,.98);--am-card:rgba(0,0,0,.04);--am-border:rgba(0,0,0,.12);--am-hover:rgba(0,0,0,.06);
  --am-accent:#3b76e0;--am-ok:#16a34a;--am-warn:#d97706;--am-bad:#dc2626;}}
.am-backdrop{position:fixed;inset:0;z-index:2147483600;background:rgba(0,0,0,.35);display:flex;align-items:center;
  justify-content:center;font-size:13px;color:var(--am-fg)}
.am-panel{width:min(680px,92vw);max-height:80vh;display:flex;flex-direction:column;background:var(--am-bg);
  border:1px solid var(--am-border);border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.45);overflow:hidden}
.am-head{display:flex;align-items:center;gap:8px;padding:14px 16px 10px}
.am-head h3{margin:0;font-size:15px;font-weight:600}
.am-dot{width:7px;height:7px;border-radius:50%;background:var(--am-ok);flex:none}
.am-dot.off{background:var(--am-bad)}
.am-status{font-size:11px;opacity:.6}
.am-head .am-x{margin-left:auto;all:unset;cursor:pointer;font-size:16px;line-height:1;padding:2px 8px;border-radius:6px;opacity:.6}
.am-head .am-x:hover{opacity:1;background:var(--am-hover)}
.am-body{overflow-y:auto;padding:0 16px 12px;scrollbar-width:thin;scrollbar-color:var(--am-border) transparent}
.am-body::-webkit-scrollbar{width:8px}
.am-body::-webkit-scrollbar-thumb{background:var(--am-border);border-radius:4px}
.am-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--am-border)}
.am-row:last-child{border-bottom:none}
.am-row .am-lab{flex:1}
.am-row .am-lab b{font-weight:600;display:block}
.am-row .am-lab i{font-style:normal;font-size:11px;opacity:.55}
.am-switch{position:relative;width:36px;height:20px;flex:none;cursor:pointer}
.am-switch input{display:none}
.am-switch i{position:absolute;inset:0;border-radius:10px;background:var(--am-border);transition:background .15s}
.am-switch i::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
  background:#fff;transition:left .15s;box-shadow:0 1px 3px rgba(0,0,0,.3)}
.am-switch input:checked+i{background:var(--am-accent)}
.am-switch input:checked+i::after{left:18px}
.am-switch.disabled{opacity:.4;pointer-events:none}
.am-sec{margin-top:12px}
.am-sec-title{font-size:11px;font-weight:600;opacity:.5;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.am-toolbar{display:flex;gap:8px;align-items:center;margin:6px 0}
.am-toolbar input[type=text]{flex:1;background:var(--am-card);border:1px solid var(--am-border);border-radius:8px;
  padding:6px 10px;color:var(--am-fg);font-size:12px;outline:none}
.am-toolbar input[type=text]:focus{border-color:var(--am-accent)}
.am-chip{all:unset;cursor:pointer;font-size:11px;padding:3px 10px;border-radius:20px;border:1px solid var(--am-border);opacity:.7}
.am-chip.on{background:var(--am-accent);border-color:var(--am-accent);color:#fff;opacity:1}
.am-inject{display:flex;align-items:center;gap:6px;font-size:11px;padding:7px 10px;border-radius:8px;
  background:var(--am-card);border:1px dashed var(--am-border);margin:6px 0 2px}
.am-inject b{font-weight:600;color:var(--am-ok)}
.am-inject i{font-style:normal;opacity:.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.am-seg{display:flex;border:1px solid var(--am-border);border-radius:8px;overflow:hidden}
.am-seg button{all:unset;cursor:pointer;font-size:12px;padding:5px 12px;color:var(--am-fg);opacity:.65;
  border-right:1px solid var(--am-border)}
.am-seg button:last-child{border-right:none}
.am-seg button.on{background:var(--am-accent);color:#fff;opacity:1}
.am-seg button:disabled{opacity:.25;cursor:not-allowed}
.am-target{font-size:10.5px;opacity:.5;margin:2px 0 8px;font-family:ui-monospace,Consolas,monospace}
.am-badge.manual{color:var(--am-accent);border-color:var(--am-accent)}
.am-badge.auto{color:var(--am-warn);border-color:var(--am-warn)}
.am-badge.probation{color:var(--am-warn);border-color:var(--am-warn);background:rgba(251,191,36,.08)}
.am-btn{all:unset;cursor:pointer;font-size:12px;padding:5px 12px;border-radius:8px;background:var(--am-accent);
  color:#fff;white-space:nowrap}
.am-btn:hover{filter:brightness(1.1)}
.am-btn.ghost{background:var(--am-card);color:var(--am-fg);border:1px solid var(--am-border)}
.am-btn.danger{background:transparent;color:var(--am-bad);border:1px solid var(--am-bad)}
.am-btn.sm{font-size:11px;padding:3px 9px}
.am-group{margin-bottom:10px}
.am-group-h{font-size:11px;opacity:.5;margin:10px 0 4px}
.am-entry{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border-radius:9px;background:var(--am-card);margin-bottom:6px}
.am-entry .am-e-main{flex:1;min-width:0}
.am-entry .am-e-title{font-weight:600;font-size:12.5px}
.am-entry .am-e-hook{font-size:11.5px;opacity:.65;margin-top:2px;overflow:hidden;text-overflow:ellipsis;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.am-entry .am-e-meta{font-size:10.5px;opacity:.45;margin-top:3px}
.am-badge{display:inline-block;font-size:10px;padding:1px 7px;border-radius:8px;border:1px solid var(--am-border);opacity:.8;margin-right:6px}
.am-badge.proj{color:var(--am-accent);border-color:var(--am-accent)}
.am-badge.local{color:var(--am-warn);border-color:var(--am-warn)}
.am-e-acts{display:flex;flex-direction:column;gap:5px;flex:none}
.am-view{background:var(--am-card);border:1px solid var(--am-border);border-radius:8px;padding:8px 10px;margin:-2px 0 6px;
  font-size:12px;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow-y:auto;font-family:ui-monospace,Consolas,monospace}
.am-empty{text-align:center;opacity:.5;padding:26px 0;font-size:12px}
.am-add{border:1px solid var(--am-border);border-radius:10px;padding:10px;margin-top:8px;background:var(--am-card)}
.am-add .am-frow{display:flex;gap:8px;margin-bottom:8px}
.am-add select,.am-add input[type=text]{background:var(--am-bg);border:1px solid var(--am-border);border-radius:7px;
  padding:5px 8px;color:var(--am-fg);font-size:12px;outline:none}
.am-add select:focus,.am-add input:focus{border-color:var(--am-accent)}
.am-add textarea{width:100%;box-sizing:border-box;background:var(--am-bg);border:1px solid var(--am-border);
  border-radius:7px;padding:6px 8px;color:var(--am-fg);font-size:12px;min-height:64px;resize:vertical;outline:none;
  font-family:inherit}
.am-foot{padding:8px 16px 12px;font-size:10.5px;opacity:.45;display:flex;justify-content:space-between;gap:10px}
.am-foot span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.am-tab{cursor:pointer;user-select:none}
`;

  function themeClass() {
    const ds = document.documentElement.dataset.colorScheme;
    if (ds === "light" || ds === "dark") return `am-scope ${ds}`;
    return `am-scope ${matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"}`;
  }

  // -------------------------------------------------------------------------
  // sidecar API
  // -------------------------------------------------------------------------
  let client = { at: 0, port: 0, token: "" };

  async function apiClient(force) {
    if (!force && client.port && Date.now() - client.at < 5000) return client;
    try {
      const j = await (await fetch(`${CONFIG_URL}?t=${Date.now()}`)).json();
      client = { at: Date.now(), port: j?.port ?? 0, token: j?.token ?? "", dataDir: j?.dataDir ?? "" };
    } catch { client = { at: Date.now(), port: 0, token: "" }; }
    return client;
  }

  async function call(path, opts = {}, forceCfg, retried) {
    const c = await apiClient(forceCfg);
    if (!c.port) throw new Error("记忆服务未运行");
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${c.port}${path}`, {
        ...opts,
        signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json", ...(opts.headers ?? {}) },
      });
    } catch (e) {
      throw new Error(/abort|timeout/i.test(String(e?.message ?? e)) ? "请求超时（服务无响应）" : String(e?.message ?? e));
    }
    // sidecar 升级换端口后 token 会轮换：401 时强制刷新一次配置并重试
    if (res.status === 401 && !retried) {
      await apiClient(true);
      return call(path, opts, true, true);
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j?.ok === false) throw new Error(j?.error ?? `HTTP ${res.status}`);
    return j;
  }

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------
  let state = null;         // /state 响应
  let loadError = null;
  let filter = "all";       // scope: all | user | project | local | trash
  let originFilter = "all"; // 来源: all | manual | auto
  let query = "";
  let openId = null;        // 展开正文的条目
  let addOpen = false;
  let editingId = null;     // 编辑中的条目
  let busy = false;

  async function refresh(forceCfg) {
    loadError = null;
    try { state = await call("/state", {}, forceCfg); }
    catch (e) { state = null; loadError = String(e?.message ?? e); }
    render();
  }

  async function mutate(path, body) {
    if (busy) return;
    busy = true;
    try { await call(path, { method: "POST", body: JSON.stringify(body ?? {}) }); await refresh(); }
    catch (e) { loadError = String(e?.message ?? e); render(); }
    busy = false;
  }

  // -------------------------------------------------------------------------
  // DOM 助手
  // -------------------------------------------------------------------------
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null) continue;
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return el;
  }

  function fmtTime(iso) {
    if (!iso) return "";
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return "";
    const s = (Date.now() - t) / 1000;
    if (s < 60) return "刚刚";
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
    if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)} 天前`;
    return new Date(t).toLocaleDateString();
  }

  function toggle(label, sub, checked, onChange, disabled) {
    const input = h("input", { type: "checkbox" });
    input.checked = !!checked;
    input.addEventListener("change", () => onChange(input.checked));
    return h("div", { class: "am-row" },
      h("div", { class: "am-lab" }, h("b", { text: label }), sub ? h("i", { text: sub }) : null),
      h("label", { class: `am-switch${disabled ? " disabled" : ""}` }, input, h("i")));
  }

  const SCOPE_LABEL = { user: "全局", project: "项目", local: "本机" };
  const SCOPE_DESC = {
    user: "全局记忆：跨项目通用（个人偏好、工作习惯）",
    project: "项目记忆：只在该工作区的会话里生效（技术栈、构建命令、约定）",
    local: "本机记忆：该工作区内、但仅本机适用（本机路径、个人调试习惯）",
  };

  // -------------------------------------------------------------------------
  // 面板渲染
  // -------------------------------------------------------------------------
  let backdrop = null;
  function render() { renderPanel(); }

  function renderPanel() {
    if (!backdrop) return;
    backdrop.textContent = "";
    const panel = h("div", { class: "am-panel" });
    const running = !!state;
    panel.appendChild(h("div", { class: "am-head" },
      memoryIcon(),
      h("h3", { text: "记忆" }),
      h("span", { class: `am-dot${running ? "" : " off"}` }),
      h("span", { class: "am-status", text: running ? "服务正常" : loadError ?? "服务未运行" }),
      h("button", { class: "am-x", text: "✕", onclick: closePanel })));

    const body = h("div", { class: "am-body" });
    if (!running) {
      body.appendChild(h("div", { class: "am-empty", text: loadError === "记忆服务未运行"
        ? "本地记忆服务未启动。开启一次新会话（或重启 Kimi Code Desktop）后会自动拉起。"
        : `加载失败：${loadError}` }));
      panel.appendChild(body);
      backdrop.appendChild(panel);
      return;
    }

    const cfg = state.config ?? {};
    // ---- 开关区 ----
    const switches = h("div", { class: "am-sec" });
    const patchCfg = (patch) => mutate("/config", patch);
    switches.appendChild(toggle("记忆功能", "关闭后：不注入索引、不可新增（下次会话生效）", cfg.enabled,
      (v) => patchCfg({ enabled: v })));
    switches.appendChild(toggle("自动沉淀", "允许 AI 在对话中自动保存值得记住的偏好与结论", cfg.autoSave,
      (v) => patchCfg({ autoSave: v }), !cfg.enabled));
    switches.appendChild(toggle("全局记忆", "跨项目通用（偏好、习惯）", cfg.scopes?.user,
      (v) => patchCfg({ scopes: { ...cfg.scopes, user: v } }), !cfg.enabled));
    switches.appendChild(toggle("项目记忆", "按工作区隔离（技术栈、构建命令、约定）", cfg.scopes?.project,
      (v) => patchCfg({ scopes: { ...cfg.scopes, project: v } }), !cfg.enabled));
    switches.appendChild(toggle("本机记忆", "项目内但仅本机（路径、个人调试习惯）", cfg.scopes?.local,
      (v) => patchCfg({ scopes: { ...cfg.scopes, local: v } }), !cfg.enabled));
    body.appendChild(switches);

    // ---- 条目区 ----
    const entriesSec = h("div", { class: "am-sec" });
    entriesSec.appendChild(h("div", { class: "am-sec-title", text: `记忆条目 · ${(state.entries ?? []).length}` }));

    // 注入预览：下次会话 AI 会带上哪些（与 hook 注入同一套条件，让它可见）
    const inj = state.injection ?? {};
    if (cfg.enabled) {
      const parts = [];
      if (cfg.scopes?.user) parts.push(`全局 ${inj.user ?? 0}`);
      if (cfg.scopes?.project) parts.push(`项目 ${inj.project ?? 0}`);
      if (cfg.scopes?.local) parts.push(`本机 ${inj.local ?? 0}`);
      const chars = inj.chars ?? 0, budget = inj.budget ?? 6000;
      const pct = Math.round((chars / budget) * 100);
      const sw = state.sweepLog;
      entriesSec.appendChild(h("div", { class: "am-inject" },
        h("b", { text: `下次会话注入 ${inj.total ?? 0} 条` }),
        h("i", { text: `（${parts.join(" · ") || "—"}${inj.probation ? `，其中试用 ${inj.probation} 条` : ""}）· 索引 ${chars}/${budget} 字符（${pct}%）` }),
        inj.overBudget ? h("i", { style: "color:var(--am-warn);flex:none", text: "⚠ 接近上限，AI 将被要求先整理" }) : null,
        sw ? h("i", { style: "flex:none;opacity:.35", text: `上次维护：转正${sw.promoted ?? 0} 过期${sw.expired ?? 0} 下架${sw.violated ?? 0} 清理${sw.purged ?? 0}` }) : null));
    } else {
      entriesSec.appendChild(h("div", { class: "am-inject" },
        h("b", { style: "color:var(--am-bad)", text: "记忆功能已关闭" }),
        h("i", { text: "开启后下次会话生效" })));
    }

    const toolbar = h("div", { class: "am-toolbar" });
    const search = h("input", { type: "text", placeholder: "搜索标题 / 内容钩子…" });
    search.value = query;
    search.addEventListener("input", () => { query = search.value; renderList(); });
    toolbar.appendChild(search);
    for (const f of [["all", "全部"], ["user", "全局"], ["project", "项目"], ["local", "本机"]]) {
      toolbar.appendChild(h("button", {
        class: `am-chip${filter === f[0] ? " on" : ""}`, text: f[1], title: "按级别筛选",
        onclick: () => { filter = f[0]; render(); },
      }));
    }
    entriesSec.appendChild(toolbar);

    // 来源筛选 + 回收站入口
    const originRow = h("div", { class: "am-toolbar" });
    for (const f of [["all", "全部来源"], ["manual", "手动"], ["auto", "自动沉淀"], ["probation", "试用中"]]) {
      originRow.appendChild(h("button", {
        class: `am-chip${filter !== "trash" && originFilter === f[0] ? " on" : ""}`, text: f[1],
        title: f[0] === "probation" ? "AI 自动沉淀、尚未转正的条目（注入≥3次转正，14天未转正回收）" : "按来源筛选",
        onclick: () => { originFilter = f[0]; filter = filter === "trash" ? "all" : filter; render(); },
      }));
    }
    const autoCount = (state.entries ?? []).filter((e) => e.origin === "auto").length;
    const probCount = (state.entries ?? []).filter((e) => e.status === "probation").length;
    const rejCount = (state.rejected ?? []).length;
    originRow.appendChild(h("i", { style: "font-style:normal;font-size:10.5px;opacity:.45",
      text: `自动 ${autoCount}（试用 ${probCount}）· 你曾拒绝 ${rejCount} 条` }));
    originRow.appendChild(h("button", {
      class: "am-btn ghost sm", style: "margin-left:auto", text: addOpen ? "收起" : "+ 新增", disabled: cfg.enabled ? null : "true",
      onclick: () => { addOpen = !addOpen; if (addOpen) editingId = null; render(); },
    }));
    entriesSec.appendChild(originRow);

    // 回收站入口行
    const trashCount = (state.trash ?? []).length;
    const trashRow = h("div", { class: "am-toolbar" });
    trashRow.appendChild(h("button", {
      class: `am-chip${filter === "trash" ? " on" : ""}`,
      text: filter === "trash" ? "← 返回记忆列表" : `回收站 (${trashCount})`,
      onclick: () => { filter = filter === "trash" ? "all" : "trash"; render(); },
    }));
    if (filter !== "trash" && trashCount) {
      trashRow.appendChild(h("i", { style: "font-style:normal;font-size:10.5px;opacity:.45",
        text: "机械下架 / 试用过期 / 你删除的条目，可恢复或彻底清除" }));
    }
    if (filter === "trash" && trashCount) {
      trashRow.appendChild(h("button", {
        class: "am-btn danger sm", style: "margin-left:auto", text: "清空回收站",
        onclick: () => { if (confirm("彻底清空回收站？此操作不可恢复。")) mutate("/purge", {}); },
      }));
    }
    entriesSec.appendChild(trashRow);

    if (addOpen && filter !== "trash") entriesSec.appendChild(buildAddForm(cfg));

    const listWrap = h("div", {});
    entriesSec.appendChild(listWrap);
    body.appendChild(entriesSec);
    panel.appendChild(body);

    panel.appendChild(h("div", { class: "am-foot" },
      h("span", { text: `数据目录：${state.dataDir ?? ""}` }),
      h("span", { text: "auto-memory 插件" })));
    backdrop.appendChild(panel);

    renderList();
    fillContents(backdrop);
    function renderList() {
      listWrap.textContent = "";
      const q = query.trim().toLowerCase();
      if (filter === "trash") {
        const items = (state.trash ?? []).filter((e) => !q || (e.title + " " + e.hook).toLowerCase().includes(q));
        if (!items.length) {
          listWrap.appendChild(h("div", { class: "am-empty", text: "回收站是空的" }));
          return;
        }
        const REASON = { violation: "格式不合格下架", expired: "试用 14 天未转正", user: "你删除的" };
        const groups = new Map();
        for (const e of items) {
          if (!groups.has(e.trashReason)) groups.set(e.trashReason, []);
          groups.get(e.trashReason).push(e);
        }
        for (const [reason, list] of groups) {
          listWrap.appendChild(h("div", { class: "am-group" },
            h("div", { class: "am-group-h", text: `${REASON[reason] ?? reason} · ${list.length}` }),
            ...list.map(trashCard)));
        }
        return;
      }
      let items = state.entries ?? [];
      if (filter !== "all") items = items.filter((e) => e.scope === filter);
      if (originFilter === "probation") items = items.filter((e) => e.status === "probation");
      else if (originFilter !== "all") items = items.filter((e) => (e.origin ?? "manual") === originFilter);
      if (q) items = items.filter((e) => (e.title + " " + e.hook).toLowerCase().includes(q));
      if (!items.length) {
        listWrap.appendChild(h("div", { class: "am-empty", text: q || filter !== "all" || originFilter !== "all" ? "没有匹配的条目" : "还没有记忆。对话里告诉 AI 值得记住的事，或点右上角新增。" }));
        return;
      }
      // 分组：全局 → 项目（按工作区）→ 本机（按工作区）
      const groups = new Map();
      for (const e of items) {
        const g = e.scope === "user" ? "全局" : `${SCOPE_LABEL[e.scope]} · ${shortWs(e.workspace)}`;
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(e);
      }
      for (const [g, list] of groups) {
        listWrap.appendChild(h("div", { class: "am-group" },
          h("div", { class: "am-group-h", text: `${g} · ${list.length}` }),
          ...list.map(entryCard)));
      }
    }
  }

  function trashCard(e) {
    const card = h("div", { class: "am-entry" });
    const main = h("div", { class: "am-e-main" },
      h("div", {},
        h("span", { class: `am-badge${e.scope === "project" ? " proj" : e.scope === "local" ? " local" : ""}`, text: SCOPE_LABEL[e.scope] ?? e.scope }),
        e.origin === "auto" ? h("span", { class: "am-badge auto", text: "自动沉淀" }) : h("span", { class: "am-badge manual", text: "手动" }),
        h("span", { class: "am-e-title", text: e.title })),
      e.hook ? h("div", { class: "am-e-hook", text: e.hook }) : null,
      h("div", { class: "am-e-meta", text: [e.workspace ? shortWs(e.workspace) : "", e.trashedAt ? fmtTime(e.trashedAt) : ""].filter(Boolean).join(" · ") }));
    card.appendChild(main);
    const acts = h("div", { class: "am-e-acts" });
    acts.appendChild(h("button", {
      class: "am-btn sm", text: "恢复",
      title: "恢复为正式记忆（用户恢复 = 认可，直接转正）",
      onclick: () => mutate("/restore", { id: e.id }),
    }));
    acts.appendChild(h("button", {
      class: "am-btn danger sm", text: "彻底删除",
      onclick: () => { if (confirm(`彻底删除《${e.title}》？不可恢复。`)) mutate("/purge", { id: e.id }); },
    }));
    card.appendChild(acts);
    return card;
  }

  function shortWs(ws) {
    if (!ws) return "未知项目";
    const parts = String(ws).split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? ws;
  }

  function entryCard(e) {
    const card = h("div", { class: "am-entry" });
    const isAuto = (e.origin ?? "manual") === "auto";
    const isProbation = e.status === "probation";
    const main = h("div", { class: "am-e-main" },
      h("div", {},
        h("span", { class: `am-badge${e.scope === "project" ? " proj" : e.scope === "local" ? " local" : ""}`,
          text: SCOPE_LABEL[e.scope] ?? e.scope, title: `级别：${SCOPE_LABEL[e.scope]}` }),
        h("span", { class: `am-badge${isAuto ? " auto" : " manual"}`,
          text: isAuto ? "自动沉淀" : "手动", title: isAuto ? "AI 自动沉淀（重点抽查对象）" : "你明确要求保存的" }),
        isProbation ? h("span", { class: "am-badge probation", text: `试用中·注入 ${e.sessions ?? 0}/3`,
          title: "注入满 3 次自动转正；14 天未转正移入回收站" }) : null,
        h("span", { class: "am-e-title", text: e.title }),
        e.exists ? null : h("span", { class: "am-e-meta", text: "（文件丢失）" })),
      e.hook ? h("div", { class: "am-e-hook", text: e.hook }) : null,
      h("div", { class: "am-e-meta", text: [e.type ? `类型：${e.type}` : "", e.workspace ?? "", e.updatedAt ? fmtTime(e.updatedAt) : ""].filter(Boolean).join(" · ") }),
      isAuto && e.evidence ? h("div", { class: "am-e-meta", style: "opacity:.4", text: `证据：${String(e.evidence).slice(0, 90)}` }) : null);
    card.appendChild(main);
    const acts = h("div", { class: "am-e-acts" });
    acts.appendChild(h("button", {
      class: "am-btn ghost sm", text: openId === e.id ? "收起" : "查看",
      onclick: async () => {
        if (openId === e.id) { openId = null; render(); return; }
        openId = e.id;
        try {
          const j = await call(`/entry?id=${encodeURIComponent(e.id)}`);
          openContent(e.id, j.content ?? "");
        } catch (err) { openContent(e.id, `读取失败：${err?.message ?? err}`); }
        render();
      },
    }));
    acts.appendChild(h("button", {
      class: "am-btn ghost sm", text: "编辑",
      onclick: async () => {
        try {
          const j = await call(`/entry?id=${encodeURIComponent(e.id)}`);
          editingId = {
            id: e.id, scope: e.scope,
            workspace: e.workspace ?? state.lastWorkspace ?? null,
            title: e.title, content: j.content ?? "", origin: j.meta?.origin,
            type: j.meta?.type ?? e.type, evidence: j.meta?.evidence ?? "",
          };
          addOpen = true;
          openId = null;
          render();
        } catch (err) { loadError = String(err?.message ?? err); render(); }
      },
    }));
    if (isProbation) acts.appendChild(h("button", {
      class: "am-btn sm", text: "转正",
      title: "立即转为正式记忆（等效于注入满 3 次）",
      onclick: () => mutate("/update", { id: e.id, status: "active" }),
    }));
    acts.appendChild(h("button", {
      class: "am-btn danger sm", text: "删除",
      onclick: () => { if (confirm(`删除记忆「${e.title}」？（移入回收站，可恢复；自动沉淀条目会记入负反馈）`)) mutate("/delete", { id: e.id }); },
    }));
    card.appendChild(acts);
    const holder = h("div", {}, card);
    if (openId === e.id) {
      const pre = h("div", { class: "am-view", text: "加载中…" });
      pre.dataset.amContentFor = e.id;
      holder.appendChild(pre);
    }
    return holder;
  }

  const CONTENTS = new Map();
  function openContent(id, content) { CONTENTS.set(id, content); }
  // render 后把已取回的正文填进对应 pre
  function fillContents(root) {
    for (const pre of root.querySelectorAll("pre[data-am-content-for], .am-view[data-am-content-for]")) {
      const c = CONTENTS.get(pre.dataset.amContentFor);
      if (c !== undefined) pre.textContent = c;
    }
  }

  function buildAddForm(cfg) {
    const form = h("div", { class: "am-add" });
    const editing = editingId; // 本渲染周期内的编辑目标（null = 新增）
    let scope = editing ? editing.scope : (filter !== "all" ? filter : "user");
    let ws = editing ? (editing.workspace ?? workspacesOf()[0] ?? null)
      : (state.lastWorkspace && workspacesOf().includes(state.lastWorkspace) ? state.lastWorkspace : workspacesOf()[0] ?? null);
    function workspacesOf() {
      return [...new Set([...(state.workspaces ?? []), state.lastWorkspace, editing?.workspace].filter(Boolean))];
    }

    // 记忆级别：三段显式选择，带说明，不藏在下拉框里
    const seg = h("div", { class: "am-seg" });
    const scopes = ["user", "project", "local"];
    const segBtns = scopes.map((s) => {
      const b = h("button", { text: SCOPE_LABEL[s], title: SCOPE_DESC[s] });
      b.addEventListener("click", () => {
        scope = s;
        segBtns.forEach((x, i) => x.classList.toggle("on", scopes[i] === s));
        syncTarget();
      });
      seg.appendChild(b);
      return b;
    });
    segBtns[scopes.indexOf(scope)].classList.add("on");

    // 所属工作区（仅项目/本机需要）
    const workspaces = workspacesOf();
    const wsSel = h("select", { style: "flex:1" }, ...workspaces.map((w) => h("option", { value: w, text: w })));
    if (ws) wsSel.value = ws;
    wsSel.addEventListener("change", () => { ws = wsSel.value; syncTarget(); });
    const wsRow = h("div", { class: "am-frow" },
      h("span", { style: "font-size:11px;opacity:.6;flex:none;align-self:center", text: "所属工作区" }), wsSel);

    const target = h("div", { class: "am-target" });
    const syncTarget = () => {
      wsRow.style.display = scope === "user" ? "none" : "";
      const key = String(ws ?? "").replace(/[^a-zA-Z0-9_-]/g, "-");
      target.textContent = scope === "user"
        ? (editing ? "迁移到：~/.kimi-code/memory/user/（跨项目可见）" : "写入：~/.kimi-code/memory/user/（跨项目可见）")
        : `写入：~/.kimi-code/memory/${scope}/${key || "…"}/（仅该工作区会话可见）`;
    };

    const titleIn = h("input", { type: "text", placeholder: "标题（如：本仓库用 pnpm 而不是 npm）", value: editing?.title ?? "" });
    const contentIn = h("textarea", { placeholder: "内容：写清楚结论和原因，AI 下次会话靠它回忆…" });
    if (editing) contentIn.value = editing.content ?? "";
    const typeSel = h("select", { style: "flex:none" },
      h("option", { value: "", text: "类型：不标" }),
      ...["偏好", "事实", "坑"].map((t) => h("option", { value: t, text: `类型：${t}` })));
    if (editing?.type) typeSel.value = editing.type;
    const errLine = h("div", { class: "am-e-meta", style: "color:var(--am-bad)" });
    if (editing) {
      form.appendChild(h("div", { class: "am-inject", style: "margin:0 0 10px" },
        h("b", { style: "color:var(--am-accent)", text: `正在编辑：${editing.title}` }),
        h("i", { text: `来源：${editing.origin === "auto" ? "自动沉淀" : "手动"}；可改内容、标题、级别或工作区` })));
    }
    form.appendChild(h("div", { class: "am-frow" },
      h("span", { style: "font-size:11px;opacity:.6;flex:none;align-self:center", text: "记忆级别" }), seg));
    form.appendChild(wsRow);
    form.appendChild(target);
    form.appendChild(h("div", { class: "am-frow" },
      h("span", { style: "font-size:11px;opacity:.6;flex:none;align-self:center", text: "条目类型" }), typeSel,
      h("i", { style: "font-style:normal;font-size:10.5px;opacity:.45", text: "偏好=个人习惯 · 事实=项目结论 · 坑=踩坑教训（可标可不标）" })));
    // 证据行：编辑自动沉淀条目，或手动条目本身带证据时显示
    // （只在 auto 时渲染会让手动条目编辑后证据被静默清空）
    let evidenceIn = null;
    if (editing && (editing.origin === "auto" || String(editing.evidence ?? "").trim())) {
      evidenceIn = h("input", { type: "text", placeholder: "证据：触发这条记忆的用户原话/事件（自动沉淀必填，缺失会被机械下架）", value: editing.evidence ?? "" });
      form.appendChild(h("div", { style: "height:8px" }));
      form.appendChild(evidenceIn);
    } else { evidenceIn = { value: "" }; }
    form.appendChild(titleIn);
    form.appendChild(h("div", { style: "height:8px" }));
    form.appendChild(contentIn);
    form.appendChild(h("div", { style: "height:8px" }));
    form.appendChild(h("div", { class: "am-frow" },
      errLine,
      editing ? h("button", {
        class: "am-btn ghost", text: "取消", style: "margin-right:auto",
        onclick: () => { editingId = null; addOpen = false; render(); },
      }) : null,
      h("button", {
        class: "am-btn", text: busy ? "保存中…" : (editing ? "保存修改" : "保存"),
        onclick: async () => {
          errLine.textContent = "";
          const workspace = scope === "user" ? undefined : ws || state.lastWorkspace || undefined;
          if (!titleIn.value.trim()) { errLine.textContent = "标题不能为空"; return; }
          if (scope !== "user" && !workspace) { errLine.textContent = "项目/本机记忆需要选择工作区"; return; }
          if (editing) {
            await mutate("/update", { id: editing.id, scope, workspace, title: titleIn.value.trim(), content: contentIn.value, type: typeSel.value, evidence: evidenceIn.value.trim() });
            if (!loadError) { editingId = null; addOpen = false; render(); }
          } else {
            await mutate("/entry", { scope, workspace, title: titleIn.value.trim(), content: contentIn.value, origin: "manual", type: typeSel.value });
            if (!loadError) { titleIn.value = ""; contentIn.value = ""; addOpen = false; render(); }
          }
        },
      })));
    syncTarget();
    return form;
  }

  function openPanel() {
    if (backdrop) return;
    backdrop = h("div", { class: `am-backdrop ${themeClass()}` });
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closePanel(); });
    document.body.appendChild(backdrop);
    render();
    refresh();
  }

  function closePanel() {
    backdrop?.remove();
    backdrop = null;
    openId = null;
    addOpen = false;
    editingId = null;
    CONTENTS.clear();
    deselectOurs();
  }

  // -------------------------------------------------------------------------
  // 设置页 tab 注入
  // -------------------------------------------------------------------------
  const TAB_TEXT = "记忆";
  let ourTab = null;

  function copyScopedAttrs(ref, target) {
    // Vue scoped CSS 依赖 data-v-xxx 属性选择器，克隆节点必须带上才能吃到样式
    for (const attr of ref.attributes) {
      if (attr.name.startsWith("data-v-")) target.setAttribute(attr.name, "");
    }
  }

  // 手绘"大脑"图标：与宿主图标同风格（16px、24 网格、单色描边 1.8、圆角端点），
  // 不用彩色 emoji。注意 SVG 必须用 createElementNS 创建，否则不渲染
  function memoryIcon() {
    const NS = "http://www.w3.org/2000/svg";
    const el = (tag, attrs = {}) => {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      return n;
    };
    const svg = el("svg", {
      width: "16", height: "16", viewBox: "0 0 24 24", fill: "none",
      "aria-hidden": "true",
    });
    const stroke = { fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round" };
    svg.appendChild(el("path", { ...stroke, d: "M9.5 4a2.5 2.5 0 0 1 2.5 2.5v13a2.5 2.5 0 0 1 -4.96 .44a2.5 2.5 0 0 1 -2.96 -3.08a3 3 0 0 1 -.34 -5.58a2.5 2.5 0 0 1 1.32 -4.24a2.5 2.5 0 0 1 4.44 -2.04z" }));
    svg.appendChild(el("path", { ...stroke, d: "M14.5 4a2.5 2.5 0 0 0 -2.5 2.5v13a2.5 2.5 0 0 0 4.96 .44a2.5 2.5 0 0 0 2.96 -3.08a3 3 0 0 0 .34 -5.58a2.5 2.5 0 0 0 -1.32 -4.24a2.5 2.5 0 0 0 -4.44 -2.04z" }));
    svg.appendChild(el("path", { ...stroke, d: "M12 6.5v13" }));
    svg.style.flex = "none";
    return svg;
  }

  function ensureTab() {
    const list = document.querySelector(".settings-tab-list");
    if (!list) {
      if (ourTab?.isConnected) ourTab.remove();
      if (backdrop) closePanel();
      ourTab = null;
      return;
    }
    if (ourTab?.isConnected && list.contains(ourTab)) return;
    const ref = list.querySelector("button");
    ourTab = h("button", { type: "button", class: "tab am-tab", role: "tab", "aria-selected": "false", tabindex: "-1" });
    if (ref) {
      ourTab.className = `${ref.className.split(" ").filter((c) => c !== "on").join(" ")} am-tab`;
      copyScopedAttrs(ref, ourTab);
    }
    ourTab.appendChild(h("span", { style: "display:inline-flex;align-items:center" }, memoryIcon()));
    ourTab.appendChild(h("span", { text: TAB_TEXT }));
    ourTab.addEventListener("click", (e) => {
      e.stopPropagation();
      // 不改原生 tab 的选中态：Vue 的 vdom 不知道我们动过 DOM，手动改会让
      // 原生 tab 的点击变成"无操作"。短暂双选中由面板覆盖层遮住内容区来弥补
      if (backdrop) { closePanel(); return; }
      ourTab.classList.add("on");
      ourTab.setAttribute("aria-selected", "true");
      openPanel();
    });
    list.appendChild(ourTab);
  }

  // 面板打开时，点击任何原生 tab 或内容区都收起面板（Vue 先处理完点击，我们
  // 在 document 捕获阶段兜底——包括点了 Vue 认为"已激活"的原生 tab 的场景）
  document.addEventListener("click", (e) => {
    if (!backdrop) return;
    const t = e.target;
    if (t instanceof Element && (t.closest(".settings-region") || (t.closest(".settings-tab-list button") && !t.closest(".am-tab")))) {
      closePanel();
    }
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && backdrop) closePanel(); });

  function deselectOurs() {
    if (!ourTab?.isConnected) return;
    ourTab.classList.remove("on");
    ourTab.setAttribute("aria-selected", "false");
  }

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------
  function boot() {
    try {
      const style = document.createElement("style");
      style.textContent = CSS;
      document.head.appendChild(style);
    } catch {}
    // 主题切换跟随：应用内切明暗主题时已打开的面板同步换肤
    try {
      new MutationObserver(() => { if (backdrop) backdrop.className = `am-backdrop ${themeClass()}`; })
        .observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-color-scheme"] });
    } catch {}
    setInterval(ensureTab, REATTACH_MS);
    ensureTab();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
