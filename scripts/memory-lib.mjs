/**
 * auto-memory 存储层
 *
 * 目录结构（KIMI_CODE_HOME/memory/）：
 *   config.json                    {enabled, autoSave, scopes:{user,project,local}}
 *   user/MEMORY.md                 全局索引（一行一条：- [标题](文件.md) — 钩子）
 *   user/<slug>.md                 全局主题文件
 *   project/<key>/MEMORY.md+*.md   项目记忆（key = 工作区路径 slug）
 *   local/<key>/...                同 project，但属于本机私有
 *   .trash/<scope>/<key>/...       回收站（机械下架/试用过期/用户删除但可恢复；
 *                                  滞留超 90 天在 sweep 时自动清理）
 *   .rejected.jsonl                用户删除自动记忆的负反馈记录（训练沉淀策略）
 *   .last-sweep.json               上次会话启动维护的摘要（面板展示用）
 *
 * 生命周期（分层信任）：
 *   用户明示/纠正 → status: active（永久，无试用期）
 *   AI 自动沉淀   → status: probation（试用）；注入计数 sessions≥3 转正，
 *                   14 天未转正或格式不合格（缺 type/evidence）→ 回收站
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, renameSync, unlinkSync, appendFileSync } from "node:fs";
import { join } from "node:path";

// 版本号单一来源：kimi.plugin.json（上一层目录）
export const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../kimi.plugin.json", import.meta.url), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
const INDEX_NAME = "MEMORY.md";
const META_NAME = "meta.json";
const TRASH_DIR = ".trash";
const REJECTED_NAME = ".rejected.jsonl";
const SWEEP_NAME = ".last-sweep.json";
const MAX_INDEX_LINES = 200;
const MAX_INDEX_CHARS = 6000;            // 字符预算（借鉴 Hermes 有界记忆）
const CONSOLIDATE_AT_PCT = 80;           // 超过即注入"请整理"提示
const VALID_TYPES = ["偏好", "事实", "坑"];
const PROBATION_DAYS = 14;               // 试用期天数
const PROMOTE_AT_SESSIONS = 3;           // 注入 N 次自动转正
const REJECTED_INJECT_N = 5;             // 注入头携带的负反馈条数
const REJECTED_KEEP_LINES = 200;         // 负反馈文件保留行数（防无限增长）
const TRASH_RETENTION_DAYS = 90;         // 回收站自动清理天数

/** 原子写：先写临时文件再 rename，避免并读方（sidecar/面板）拿到截断内容 */
function writeAtomic(fp, data) {
  const tmp = `${fp}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, data, "utf8");
    renameSync(tmp, fp);
  } catch {
    try { unlinkSync(tmp); } catch {}
    writeFileSync(fp, data, "utf8");
  }
}

export function memoryRoot(home) {
  return join(home ?? process.env.KIMI_CODE_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".kimi-code"), "memory");
}

export function defaultConfig() {
  return {
    version: 1,
    enabled: true,
    autoSave: true,
    scopes: { user: true, project: true, local: true },
  };
}

export function loadConfig(root) {
  const p = join(root, "config.json");
  try {
    return normalizeConfig(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(root, cfg) {
  writeAtomic(join(root, "config.json"), JSON.stringify(normalizeConfig(cfg), null, 2) + "\n");
}

export function normalizeConfig(cfg) {
  const d = defaultConfig();
  const out = { ...d, ...cfg, scopes: { ...d.scopes, ...(cfg?.scopes ?? {}) } };
  out.enabled = !!out.enabled;
  out.autoSave = !!out.autoSave;
  for (const k of Object.keys(out.scopes)) out.scopes[k] = !!out.scopes[k];
  return out;
}

/** 工作区路径 → 目录 key。
 *  Windows 盘符大小写归一（D:\x 与 d:\x 是同一项目），斜杠方向本就会被替换。 */
export function projectKey(workspace) {
  let s = String(workspace ?? "").replace(/^([a-z]):/, (m, c) => c.toUpperCase() + ":");
  s = s.replace(/[^a-zA-Z0-9_-]/g, "-");
  return s === "" ? "unknown" : s;
}

function scopeDir(root, scope, key) {
  return scope === "user" ? join(root, "user") : join(root, scope, key ?? "unknown");
}

function readMeta(dir) {
  try { return JSON.parse(readFileSync(join(dir, META_NAME), "utf8")); } catch { return {}; }
}

function writeMeta(dir, workspace) {
  if (!workspace) return;
  writeAtomic(join(dir, META_NAME), JSON.stringify({ workspace }, null, 2) + "\n");
}

// --- 索引行 ----------------------------------------------------------------
// `- [标题](文件.md) — 钩子`（破折号兼容 em dash / hyphen / 中文—）
const LINE_RE = /^-\s+\[(.+?)\]\(([^)]+\.md)\)(?:\s*[—–-]\s*(.*))?$/;

function parseIndex(dir) {
  const p = join(dir, INDEX_NAME);
  const out = [];
  if (!existsSync(p)) return out;
  const lines = readFileSync(p, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = LINE_RE.exec(lines[i].trim());
    if (m) out.push({ line: i + 1, raw: lines[i], title: m[1], file: m[2], hook: (m[3] ?? "").trim() });
  }
  return out;
}

// 导出供 CLI reindex 复用：行格式只此一份，防 CLI 侧复刻漂移
export function writeIndex(dir, entries) {
  // 索引本体永远不含正文。这里不再截断行数/字符——静默丢弃会造成"写入成功但
  // 条目不可见"的孤儿；预算统一在注入时执行（buildContext 截断 + 超限警告），
  // 超预算时由 addEntry/updateEntry 返回 overBudget 提示 AI 先整理
  const lines = entries.map((e) => `- [${e.title}](${e.file})${e.hook ? ` — ${e.hook}` : ""}`);
  writeAtomic(join(dir, INDEX_NAME), lines.join("\n") + (lines.length ? "\n" : ""));
}

/** 索引是否超出整理阈值（写入方返回 overBudget 用） */
function indexOverBudget(dir) {
  return indexUsage(dir).chars > (MAX_INDEX_CHARS * CONSOLIDATE_AT_PCT) / 100;
}

/** 索引占用（面板用量显示 + 整理提示用） */
export function indexUsage(dir) {
  const p = join(dir, INDEX_NAME);
  const text = existsSync(p) ? readFileSync(p, "utf8") : "";
  return { chars: text.length, budget: MAX_INDEX_CHARS, lines: text ? text.split(/\r?\n/).filter(Boolean).length : 0 };
}

function normType(t) {
  return VALID_TYPES.includes(String(t ?? "")) ? String(t) : "";
}

// --- frontmatter ---------------------------------------------------------------
// 解析宽容度：AI 手写的 YAML 可能给值加引号（type: "偏好"）——必须剥掉，
// 否则 normType 校验失败，合格条目会被机械 sweep 误杀进回收站
export function parseFrontmatter(text) {
  const meta = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta, body: text };
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "").trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

function fmText(meta, content) {
  const order = ["title", "scope", "origin", "status", "type", "evidence", "workspace", "sessions", "created", "updated", "trashedAt", "trashReason"];
  const lines = [];
  for (const k of order) {
    if (meta[k] === undefined || meta[k] === null || meta[k] === "") continue;
    const v = String(meta[k]);
    // evidence 可能含冒号/换行：压成一行
    lines.push(`${k}: ${v.replace(/\r?\n/g, " ").slice(0, 300)}`);
  }
  return `---\n${lines.join("\n")}\n---\n\n${String(content ?? "").trim()}\n`;
}

function slugify(title) {
  const s = String(title).trim().replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60);
  return s || "memory";
}

export function firstHook(body) {
  const line = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  if (!line) return "";
  return line.replace(/^[-*]\s+/, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").slice(0, 80);
}

// --- 条目枚举 ---------------------------------------------------------------------
/**
 * 列出全部记忆条目（不含回收站）。
 * 返回 [{id, scope, projectKey, workspace, title, hook, file, origin, status, type, evidence, sessions, createdAt, updatedAt, exists}]
 */
export function listEntries(root) {
  const out = [];
  const scopes = [
    { scope: "user", keys: [null] },
    { scope: "project", keys: listKeys(root, "project") },
    { scope: "local", keys: listKeys(root, "local") },
  ];
  for (const { scope, keys } of scopes) {
    for (const key of keys) {
      const dir = scopeDir(root, scope, key);
      if (!existsSync(dir)) continue;
      const meta = readMeta(dir);
      for (const e of parseIndex(dir)) {
        out.push(fillMeta({ id: `${scope}|${key ?? ""}|${e.file}`, scope, projectKey: key, workspace: meta.workspace ?? null, title: e.title, hook: e.hook, file: e.file }, dir, e.file));
      }
    }
  }
  return out;
}

function fillMeta(entry, dir, file) {
  const fp = join(dir, file);
  try {
    const st = statSync(fp);
    entry.updatedAt = st.mtime.toISOString();
    const fm = parseFrontmatter(readFileSync(fp, "utf8")).meta;
    if (fm.origin === "auto") entry.origin = "auto"; else entry.origin = "manual";
    entry.status = fm.status === "probation" ? "probation" : "active";
    entry.type = normType(fm.type);
    entry.evidence = fm.evidence ?? "";
    entry.sessions = Number.isFinite(Number(fm.sessions)) ? Number(fm.sessions) : 0;
    entry.createdAt = fm.created ?? null;
    entry.exists = true;
  } catch {
    entry.origin = "manual"; entry.status = "active"; entry.type = ""; entry.evidence = "";
    entry.sessions = 0; entry.createdAt = null; entry.updatedAt = null; entry.exists = false;
  }
  return entry;
}

export function listKeys(root, scope) {
  const base = join(root, scope);
  if (!existsSync(base)) return [null];
  const keys = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  return keys.length ? keys : [null];
}

// --- 读 ----------------------------------------------------------------
export function readEntry(root, id) {
  const p = parseId(id);
  return readFileSync(join(scopeDir(root, p.scope, p.key), p.file), "utf8");
}

/** 读条目并拆出 frontmatter 与正文（编辑预填用） */
export function readEntryParsed(root, id) {
  const { meta, body } = parseFrontmatter(readEntry(root, id));
  return { meta, content: body.trim() };
}

function parseId(id) {
  const [scope, key, file] = String(id).split("|");
  // 保留文件名必须拒绝：否则 /delete {id:"user||MEMORY.md"} 会把索引本身删进回收站
  // key 与 file 同等校验：HTTP 传入的 id 不可信，"project|../../..|x.md" 不拦
  // 会经 join(root, scope, key) 逃出记忆根目录，读/写/删任意路径
  if (!["user", "project", "local"].includes(scope) || !file || file.includes("/") || file.includes("\\") || file.includes("..")
    || file === INDEX_NAME || file === META_NAME || file.startsWith(".")
    || (key && (key.includes("/") || key.includes("\\") || key.includes("..")))) {
    throw new Error("非法条目 id");
  }
  return { scope, key: key || null, file };
}

// --- 写 ----------------------------------------------------------------
/**
 * 编辑条目：改内容（原文件重写）、改标题（重命名文件）、改级别/工作区（跨目录迁移）。
 * status/evidence/sessions/created/origin 保留（patch 可显式覆盖）；updated 刷新。
 */
export function updateEntry(root, id, patch = {}) {
  const old = parseId(id);
  const oldFp = join(scopeDir(root, old.scope, old.key), old.file);
  const { meta, body } = parseFrontmatter(readFileSync(oldFp, "utf8"));
  const oldTitle = meta.title ?? old.file.replace(/\.md$/, "");

  const title = (patch.title ?? "").trim() || oldTitle;
  const content = patch.content !== undefined ? String(patch.content).trim() : body.trim();
  const newScope = ["user", "project", "local"].includes(patch.scope) ? patch.scope : old.scope;
  let workspace = meta.workspace ?? null;
  if (newScope !== "user") {
    if (patch.workspace) workspace = String(patch.workspace);
    if (!workspace) throw new Error("project/local 记忆必须带 workspace");
  }
  const newKey = newScope === "user" ? null : projectKey(workspace);
  const newDir = scopeDir(root, newScope, newKey);

  const keepFile = newScope === old.scope && newKey === old.key &&
    (old.file === `${slugify(title)}.md` || meta.title === title);
  const newFile = keepFile ? old.file : uniqueFile(newDir, slugify(title), title);
  const newFp = join(newDir, newFile);

  mkdirSync(newDir, { recursive: true });
  if (newScope !== "user") writeMeta(newDir, workspace);
  const next = {
    ...meta,
    title,
    scope: newScope,
    origin: patch.origin === "auto" || patch.origin === "manual" ? patch.origin : (meta.origin === "auto" ? "auto" : "manual"),
    status: patch.status === "probation" || patch.status === "active" ? patch.status : (meta.status === "probation" ? "probation" : "active"),
    type: patch.type !== undefined ? normType(patch.type) : normType(meta.type),
    evidence: patch.evidence !== undefined ? String(patch.evidence) : (meta.evidence ?? ""),
    ...(newScope !== "user" && workspace ? { workspace } : {}),
    sessions: meta.sessions,
    created: meta.created ?? new Date().toISOString(),
    updated: new Date().toISOString(),
  };
  writeAtomic(newFp, fmText(next, content));

  const newEntries = parseIndex(newDir).filter((e) => e.file !== newFile);
  newEntries.push({ title, file: newFile, hook: firstHook(content) });
  writeIndex(newDir, newEntries);

  if (newFp !== oldFp) deleteEntry(root, id, "cleanup");
  return { id: `${newScope}|${newKey ?? ""}|${newFile}`, file: newFile, overBudget: indexOverBudget(newDir) };
}

/** 新增（按 文件名 upsert：同 slug 覆盖，索引行同步改写）。
 *  origin: "manual"（用户明确要求/面板手写，默认，status=active）
 *          "auto"（AI 自动沉淀，status=probation 进入试用期）
 *  type: "偏好" | "事实" | "坑"；evidence: 触发写入的用户原话/事件（自动沉淀必填，机械校验） */
export function addEntry(root, { scope, workspace, title, content, origin, type, evidence }) {
  scope = ["user", "project", "local"].includes(scope) ? scope : "user";
  if (scope !== "user" && !workspace) throw new Error("project/local 记忆必须带 workspace");
  const key = scope === "user" ? null : projectKey(workspace);
  const dir = scopeDir(root, scope, key);
  mkdirSync(dir, { recursive: true });
  if (scope !== "user") writeMeta(dir, workspace);

  const file = uniqueFile(dir, slugify(title), title);
  const now = new Date().toISOString();
  const isAuto = origin === "auto";
  const meta = {
    title, scope, origin: isAuto ? "auto" : "manual",
    status: isAuto ? "probation" : "active",
    ...(normType(type) ? { type: normType(type) } : {}),
    ...(isAuto || evidence ? { evidence: String(evidence ?? "") } : {}),
    ...(workspace ? { workspace } : {}),
    sessions: 0, created: now, updated: now,
  };
  writeAtomic(join(dir, file), fmText(meta, content));

  const entries = parseIndex(dir).filter((e) => e.file !== file);
  entries.push({ title, file, hook: firstHook(content) });
  writeIndex(dir, entries);
  return { id: `${scope}|${key ?? ""}|${file}`, file, overBudget: indexOverBudget(dir) };
}

// --- 删 / 回收站 / 负反馈 -----------------------------------------------------------
/**
 * 删除条目。
 * reason: "user"（面板/命令删除 → 记入 .rejected.jsonl 负反馈）
 *         "cleanup"（迁移/改名清理，无副作用）
 *         "violation"（SessionStart 机械校验：格式不合格下架）
 *         "expired"（试用期 14 天未转正）
 * 除 cleanup 外均移入回收站（可恢复），非物理删除。
 */
export function deleteEntry(root, id, reason = "user") {
  const p = parseId(id);
  const dir = scopeDir(root, p.scope, p.key);
  const fp = join(dir, p.file);
  if (!existsSync(fp)) { writeIndex(dir, parseIndex(dir).filter((e) => e.file !== p.file)); return; }

  const { meta, body } = parseFrontmatter(readFileSync(fp, "utf8"));

  // 负反馈：仅用户删除的自动沉淀值得记录（手动条目是用户自己放的，删除不含策略信号）
  if (reason === "user" && meta.origin === "auto") {
    try {
      const rejPath = join(root, REJECTED_NAME);
      appendFileSync(rejPath, JSON.stringify({
        title: meta.title ?? p.file, scope: p.scope, type: normType(meta.type),
        hook: firstHook(body), evidence: meta.evidence ?? "", deletedAt: new Date().toISOString(),
      }) + "\n", "utf8");
      // 防无限增长：超过硬上限时只保留最近 REJECTED_KEEP_LINES 条
      const lines = readFileSync(rejPath, "utf8").split(/\r?\n/).filter(Boolean);
      if (lines.length > REJECTED_KEEP_LINES * 2) {
        writeAtomic(rejPath, lines.slice(-REJECTED_KEEP_LINES).join("\n") + "\n");
      }
    } catch {}
  }

  // 移入回收站
  if (reason !== "cleanup") {
    const trashDir = join(root, TRASH_DIR, p.scope, p.key ?? "");
    mkdirSync(trashDir, { recursive: true });
    let target = join(trashDir, p.file);
    let i = 2;
    while (existsSync(target)) target = join(trashDir, `${i++}-${p.file}`);
    const trashed = fmText({
      ...meta,
      trashedAt: new Date().toISOString(),
      trashReason: reason,
      // 恢复路径记录在 frontmatter 外不好带，恢复时用目录结构重建
    }, body);
    writeFileSync(target, trashed, "utf8");
  }

  // 物理删除原文件（先改名 ASCII 防 AV 拦截）+ 索引行移除
  const tmp = join(dir, `.del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`);
  try {
    renameSync(fp, tmp);
    try { rmSync(tmp, { force: true }); } catch { try { unlinkSync(tmp); } catch {} }
  } catch {
    try { unlinkSync(fp); } catch {}
  }
  writeIndex(dir, parseIndex(dir).filter((e) => e.file !== p.file));
  try {
    const rest = readdirSync(dir).filter((f) => f !== META_NAME && f !== INDEX_NAME && !f.startsWith(".del-"));
    if (!rest.length) rmSync(dir, { recursive: true, force: true });
  } catch {}
}

/** 列出回收站条目（user scope 是 .trash/user/ 扁平一层；project/local 是 .trash/<scope>/<key>/ 两层） */
export function listTrash(root) {
  const out = [];
  const base = join(root, TRASH_DIR);
  if (!existsSync(base)) return out;
  const pushFile = (scope, key, dir, f) => {
    if (!f.endsWith(".md") || f.startsWith(".del-")) return;
    try {
      const { meta, body } = parseFrontmatter(readFileSync(join(dir, f), "utf8"));
      out.push({
        id: `trash|${scope}|${key ?? ""}|${f}`,
        scope, projectKey: key ?? null,
        workspace: meta.workspace ?? null,
        title: meta.title ?? f, hook: firstHook(body),
        origin: meta.origin === "auto" ? "auto" : "manual",
        type: normType(meta.type),
        trashReason: meta.trashReason ?? "",
        trashedAt: meta.trashedAt ?? null,
      });
    } catch {}
  };
  for (const scopeDir of readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const scope = scopeDir.name;
    const sdir = join(base, scope);
    if (!["user", "project", "local"].includes(scope)) continue;
    for (const entry of readdirSync(sdir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        for (const f of readdirSync(join(sdir, entry.name))) pushFile(scope, entry.name, join(sdir, entry.name), f);
      } else {
        pushFile(scope, null, sdir, entry.name); // user：文件直接在 scope 层
      }
    }
  }
  return out;
}

/** 从回收站恢复一条（用户明确恢复 = 认可 → status: active 直接转正） */
export function restoreEntry(root, trashId) {
  const [tag, scope, key, file] = String(trashId).split("|");
  // key 与 file 同等校验：HTTP 传入的 id 不可信，带 ../ 会经 join 逃出 .trash
  if (tag !== "trash" || !["user", "project", "local"].includes(scope) || !file || file.includes("/") || file.includes("\\") || file.includes("..")
    || (key && (key.includes("/") || key.includes("\\") || key.includes("..")))) {
    throw new Error("非法回收站 id");
  }
  // user 的回收站文件在 .trash/user/ 下（扁平）；project/local 在 .trash/<scope>/<key>/ 下
  const trashFp = join(root, TRASH_DIR, scope, key || "", file);
  if (!existsSync(trashFp)) throw new Error("回收站条目不存在");
  const { meta, body } = parseFrontmatter(readFileSync(trashFp, "utf8"));
  const dir = scopeDir(root, scope, key || null);
  mkdirSync(dir, { recursive: true });
  if (scope !== "user") {
    const ws = meta.workspace ?? null;
    if (ws) writeMeta(dir, ws); else throw new Error("缺少 workspace 信息，无法恢复");
  }
  const target = uniqueFile(dir, slugify(meta.title ?? file.replace(/\.md$/, "")), meta.title ?? "");
  const restored = fmText({ ...meta, status: "active", trashedAt: undefined, trashReason: undefined, updated: new Date().toISOString() }, body);
  writeFileSync(join(dir, target), restored, "utf8");
  const entries = parseIndex(dir).filter((e) => e.file !== target);
  entries.push({ title: meta.title ?? target, file: target, hook: firstHook(body) });
  writeIndex(dir, entries);
  // 物理删除回收站副本 + 清理空目录
  const tmp = join(root, TRASH_DIR, scope, key || "", `.del-${Date.now()}.md`);
  try { renameSync(trashFp, tmp); try { rmSync(tmp, { force: true }); } catch {} } catch { try { unlinkSync(trashFp); } catch {} }
  const cleanup = key ? [join(root, TRASH_DIR, scope, key), join(root, TRASH_DIR, scope)] : [join(root, TRASH_DIR, scope)];
  for (const d of cleanup) {
    try { if (existsSync(d) && readdirSync(d).length === 0) rmSync(d, { recursive: true, force: true }); } catch {}
  }
  return { id: `${scope}|${key ?? ""}|${target}` };
}

/** 彻底删除回收站一条 / 清空 */
export function purgeTrash(root, trashId = null) {
  // 校验先行（在 existsSync 短路之前）：id 来自 HTTP body，key/file 带 ../
  // 会逃出 .trash 实现任意文件删除，即使 .trash 还不存在也必须先拒绝
  let target = null;
  if (trashId) {
    const [tag, scope, key, file] = String(trashId).split("|");
    // 与 restoreEntry 同一套校验：tag 之外每一段都必须白名单化
    if (tag !== "trash" || !["user", "project", "local"].includes(scope)
      || !file || file.includes("/") || file.includes("\\") || file.includes("..")
      || (key && (key.includes("/") || key.includes("\\") || key.includes("..")))) {
      throw new Error("非法回收站 id");
    }
    target = [scope, key, file];
  }
  const base = join(root, TRASH_DIR);
  if (!existsSync(base)) return;
  if (target) {
    const [scope, key, file] = target;
    const fp = join(base, scope, key, file);
    const tmp = join(base, scope, key, `.del-${Date.now()}.md`);
    try { renameSync(fp, tmp); try { rmSync(tmp, { force: true }); } catch {} } catch { try { unlinkSync(fp); } catch {} }
  } else {
    rmSync(base, { recursive: true, force: true });
  }
}

/** 清理回收站中滞留超过 days 天的条目（sweep 每次会话启动顺带执行） */
export function purgeExpiredTrash(root, days = TRASH_RETENTION_DAYS) {
  const cutoff = Date.now() - days * 86400_000;
  let n = 0;
  for (const it of listTrash(root)) {
    const ts = Date.parse(it.trashedAt ?? "");
    if (Number.isFinite(ts) && ts < cutoff) { purgeTrash(root, it.id); n++; }
  }
  return n;
}

/** 读取负反馈记录（最近 N 条） */
export function listRejected(root, n = REJECTED_INJECT_N) {
  const p = join(root, REJECTED_NAME);
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
  return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
}

// upsert 语义：同名 slug 直接复用文件（更新覆盖），不同标题撞 slug 时才加序号
function uniqueFile(dir, slug, title) {
  const p = join(dir, `${slug}.md`);
  if (!existsSync(p)) return `${slug}.md`;
  try {
    const { meta } = parseFrontmatter(readFileSync(p, "utf8"));
    if (meta.title === title) return `${slug}.md`;
  } catch {}
  let i = 2;
  while (existsSync(join(dir, `${slug}-${i}.md`))) i++;
  return `${slug}-${i}.md`;
}

// --- 会话启动维护（sweep）：转正 / 过期 / 机械校验 / 注入计数 ------------------
/**
 * 每次会话启动调用。顺序：
 *  1) 机械校验：origin=auto 的条目缺 type 或 evidence → 回收站（violation）
 *  2) 注入计数：将被注入的条目 sessions+1（重写 frontmatter）
 *  3) 转正：probation 且 sessions≥PROMOTE_AT_SESSIONS → active
 *  4) 过期：probation 且创建超 PROBATION_DAYS 天且未转正 → 回收站（expired）
 * 返回摘要并落盘 .last-sweep.json。
 */
export function sweep(root, cfg, workspace) {
  const result = { at: new Date().toISOString(), workspace: workspace ?? null, promoted: 0, expired: 0, violated: 0, counted: 0, purged: 0 };
  try { result.purged = purgeExpiredTrash(root); } catch {}
  const key = workspace ? projectKey(workspace) : null;
  const injectedDirs = [];
  if (cfg.enabled && cfg.scopes.user) injectedDirs.push(["user", null]);
  if (workspace && cfg.enabled) {
    if (cfg.scopes.project) injectedDirs.push(["project", key]);
    if (cfg.scopes.local) injectedDirs.push(["local", key]);
  }
  const inInjected = new Set(injectedDirs.map(([s, k]) => `${s}|${k}`));

  const all = [
    { scope: "user", keys: [null] },
    { scope: "project", keys: listKeys(root, "project") },
    { scope: "local", keys: listKeys(root, "local") },
  ];
  const now = Date.now();

  for (const { scope, keys } of all) {
    for (const k of keys) {
      const dir = scopeDir(root, scope, k);
      if (!existsSync(dir)) continue;
      const doCount = inInjected.has(`${scope}|${k}`);
      for (const e of [...parseIndex(dir)]) {
        const fp = join(dir, e.file);
        if (!existsSync(fp)) continue;
        const { meta, body } = parseFrontmatter(readFileSync(fp, "utf8"));

        // 1) 机械校验（仅自动条目；手动条目由用户背书，不强制 evidence）
        if (meta.origin === "auto" && (meta.status === "probation" || meta.status === undefined) &&
            (!normType(meta.type) || !String(meta.evidence ?? "").trim())) {
          deleteEntry(root, `${scope}|${k ?? ""}|${e.file}`, "violation");
          result.violated++;
          continue;
        }
        // 2) 注入计数 + 3) 转正：合并为一次原子重写（逐项分开各写一遍文件，
        // 且非原子写会让并读方——面板/另一会话的 sweep——拿到半截）
        let dirty = false;
        if (doCount) {
          meta.sessions = (Number(meta.sessions) || 0) + 1;
          result.counted++;
          dirty = true;
        }
        if (meta.status === "probation" && (Number(meta.sessions) || 0) >= PROMOTE_AT_SESSIONS) {
          meta.status = "active";
          result.promoted++;
          dirty = true;
        }
        if (dirty) writeAtomic(fp, fmText(meta, body));
        // 4) 过期（转正后 status 已是 active，自然跳过）
        if (meta.status === "probation") {
          const created = Date.parse(meta.created ?? "");
          if (Number.isFinite(created) && now - created > PROBATION_DAYS * 86400_000) {
            deleteEntry(root, `${scope}|${k ?? ""}|${e.file}`, "expired");
            result.expired++;
          }
        }
      }
    }
  }
  try { writeAtomic(join(root, SWEEP_NAME), JSON.stringify(result, null, 2) + "\n"); } catch {}
  return result;
}

export function lastSweep(root) {
  try { return JSON.parse(readFileSync(join(root, SWEEP_NAME), "utf8")); } catch { return null; }
}

// --- SessionStart 上下文注入 ------------------------------------------------------
/** 预览下次会话将注入的条目数与索引占用（与 buildContext 同一套条件，sweep 之后） */
export function injectionPreview(root, cfg, workspace) {
  const key = workspace ? projectKey(workspace) : null;
  const scopes = [
    { scope: "user", k: null, on: cfg.enabled && cfg.scopes.user },
    { scope: "project", k: workspace ? key : null, on: cfg.enabled && cfg.scopes.project && !!workspace },
    { scope: "local", k: workspace ? key : null, on: cfg.enabled && cfg.scopes.local && !!workspace },
  ];
  const out = { user: 0, project: 0, local: 0, probation: 0, chars: 0, budget: MAX_INDEX_CHARS, workspace: workspace ?? null };
  for (const s of scopes) {
    if (!s.on) continue;
    const dir = scopeDir(root, s.scope, s.k);
    if (!existsSync(dir)) continue;
    const idx = parseIndex(dir);
    out[s.scope] = idx.length;
    out.chars += indexUsage(dir).chars;
    for (const e of idx) {
      try {
        const fm = parseFrontmatter(readFileSync(join(dir, e.file), "utf8")).meta;
        if (fm.status === "probation") out.probation++;
      } catch {}
    }
  }
  out.total = out.user + out.project + out.local;
  out.overBudget = out.chars > (MAX_INDEX_CHARS * CONSOLIDATE_AT_PCT) / 100;
  return out;
}

export function buildContext(root, cfg, workspace) {
  if (!cfg.enabled) return "";
  const parts = [];
  const pushScope = (label, scope, key) => {
    if (!cfg.scopes[scope]) return;
    const dir = scopeDir(root, scope, key);
    if (!existsSync(dir)) return;
    const lines = [];
    for (const e of parseIndex(dir)) {
      let probation = false;
      try { probation = parseFrontmatter(readFileSync(join(dir, e.file), "utf8")).meta.status === "probation"; } catch {}
      lines.push(`- [${e.title}]${e.hook ? ` — ${e.hook}` : ""}${probation ? `〔试用〕` : ""}`);
    }
    if (!lines.length) return;
    parts.push({ label, scope, key, lines, usage: indexUsage(dir) });
  };
  pushScope("全局", "user", null);
  if (workspace) {
    const key = projectKey(workspace);
    pushScope(`项目 ${workspace}`, "project", key);
    pushScope(`本机·项目 ${workspace}`, "local", key);
  }

  const blocks = [];
  let totalLines = 0, totalChars = 0;
  for (const p of parts) {
    const take = p.lines.slice(0, Math.max(0, MAX_INDEX_LINES - totalLines));
    if (!take.length) continue;
    totalLines += take.length;
    totalChars += p.usage.chars;
    blocks.push(`【${p.label}】\n${take.join("\n")}`);
  }
  if (!blocks.length) return "";

  const head = [
    "[auto-memory] 以下是你的持久记忆索引（跨会话保存，目录 ~/.kimi-code/memory）。"
    + "若某条与当前任务相关，先用 Read 工具读取 ~/.kimi-code/memory/ 下对应主题文件再动手；"
    + "各块对应目录：全局→user/，项目→project/<工作区key>/，本机→local/<工作区key>/。"
    + "带〔试用〕标记的是 AI 自动沉淀、尚未转正的条目——仍可参考，但与用户明示冲突时以用户为准。",
  ];
  // 负反馈：用户删除过的自动记忆 → 同类内容今后谨慎沉淀
  const rejected = listRejected(root);
  if (rejected.length) {
    head.push(`用户曾删除过以下自动记忆（同类内容今后仅在证据非常充分时才写）：\n${rejected.map((r) => `- 《${r.title}》${r.type ? `〔${r.type}〕` : ""}${r.hook ? ` — ${r.hook.slice(0, 40)}` : ""}`).join("\n")}`);
  }
  if (totalChars > (MAX_INDEX_CHARS * CONSOLIDATE_AT_PCT) / 100) {
    head.push(`⚠ 记忆索引已占用 ${totalChars}/${MAX_INDEX_CHARS} 字符（>${CONSOLIDATE_AT_PCT}%）：本轮若要新增记忆，必须先合并或精简最不重要的旧条目；无新记忆时请主动整理一条冗余条目。`);
  }
  return [...head, "", ...blocks].join("\n");
}
