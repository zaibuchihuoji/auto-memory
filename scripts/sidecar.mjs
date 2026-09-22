/**
 * auto-memory sidecar
 *
 * 由 SessionStart hook 拉起的本地常驻服务（kimi-webbridge daemon 同款模式）：
 * 桌面端渲染进程没有 fs 权限，注入的记忆管理面板通过本服务读写
 * ~/.kimi-code/memory/。仅绑定 127.0.0.1，Bearer token 写入
 * desktop-dist/assets/auto-memory.config.json 供面板获取。
 *
 * 自愈：每 30s 检查 config 文件，若指向别的端口（新版本已接管）则自行退出，
 * 避免旧进程残留。
 *
 * 端点：
 *   GET  /ping                 → {ok, version}
 *   GET  /state                → {config, entries, workspaces, lastWorkspace}
 *   POST /config  {patch}      → 合并保存，返回新 config
 *   POST /entry   {scope,workspace,title,content} → 新增/更新
 *   GET  /entry?id=            → {content}
 *   POST /delete  {id}         → 删除
 *   POST /touch   {workspace}  → 记录最近工作区（hook 调用）
 *   POST /shutdown             → 退出
 */

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { writeFileSync, existsSync, readFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as lib from "./memory-lib.mjs";
import * as su from "./self-update.mjs";

const ROOT = lib.memoryRoot();
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ASSETS_DIR = process.env.AUTO_MEMORY_ASSETS ?? null;
const CONFIG_NAME = "auto-memory.config.json";
const PORT_RANGE = [39471, 39482];

let TOKEN = randomBytes(16).toString("hex");
let PORT = 0;
let lastWorkspace = null;

function writeClientConfig() {
  if (!ASSETS_DIR) return;
  try {
    mkdirSync(ASSETS_DIR, { recursive: true });
    const body = JSON.stringify({
      version: lib.VERSION, port: PORT, token: TOKEN, dataDir: ROOT, pid: process.pid,
    }, null, 2) + "\n";
    // 原子替换：面板/hook 可能恰好在读，避免拿到截断 JSON
    const fp = join(ASSETS_DIR, CONFIG_NAME);
    const tmp = `${fp}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, body, "utf8");
      renameSync(tmp, fp);
    } catch {
      try { unlinkSync(tmp); } catch {}
      writeFileSync(fp, body, "utf8");
    }
  } catch {}
}

function pingExisting(port) {
  return new Promise((resolve) => {
    const req = fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(500) });
    req.then((r) => r.json()).then((j) => resolve(j?.ok && j?.service === "auto-memory" ? j : null)).catch(() => resolve(null));
  });
}

async function pickPort() {
  // 先复用同版本旧实例的端口（重置 token 需要重写 config，旧实例 token 未知 →
  // 除非版本一致且 config 仍指向它，否则开新端口并让旧实例自愈退出）
  for (let p = PORT_RANGE[0]; p < PORT_RANGE[1]; p++) {
    const hit = await pingExisting(p);
    if (hit && hit.version === lib.VERSION) {
      const cfgPath = ASSETS_DIR ? join(ASSETS_DIR, CONFIG_NAME) : null;
      if (cfgPath && existsSync(cfgPath)) {
        try {
          const c = JSON.parse(readFileSync(cfgPath, "utf8"));
          if (c.port === p && c.pid) return { port: p, reuse: true, pid: c.pid };
        } catch {}
      }
    }
  }
  return { port: 0, reuse: false };
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "authorization,content-type",
  "Access-Control-Max-Age": "86400",
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", ...CORS });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 1e6) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (e) { reject(new Error("JSON 解析失败")); }
    });
    req.on("error", reject);
  });
}

let tryingPort = 0;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;

  if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }

  // /ping 免鉴权（供探测复用）；其余端点校验 Bearer token
  if (path === "/ping") {
    return json(res, 200, { ok: true, service: "auto-memory", version: lib.VERSION, port: PORT });
  }
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${TOKEN}`) return json(res, 401, { ok: false, error: "未授权" });

  try {
    if (req.method === "GET" && path === "/state") {
      const cfg = lib.loadConfig(ROOT);
      const entries = lib.listEntries(ROOT);
      const workspaces = [...new Set(entries.filter((e) => e.workspace).map((e) => e.workspace))];
      // 注入预览跟随"最近工作区"；sidecar 重启后丢失时回退到已有工作区，
      // 避免面板在首次会话前误显示"项目 0 条"
      const injection = lib.injectionPreview(ROOT, cfg, lastWorkspace ?? workspaces[0] ?? null);
      const trash = lib.listTrash(ROOT);
      const rejected = lib.listRejected(ROOT, 20);
      const sweepLog = lib.lastSweep(ROOT);
      const update = su.updateState(PLUGIN_ROOT) ?? null;
      return json(res, 200, { ok: true, config: cfg, entries, workspaces, lastWorkspace, injection, trash, rejected, sweepLog, update, dataDir: ROOT, version: lib.VERSION });
    }
    if (req.method === "POST" && path === "/config") {
      const patch = await readBody(req);
      const cfg = lib.normalizeConfig({ ...lib.loadConfig(ROOT), ...(patch ?? {}) });
      cfg.scopes = { ...lib.loadConfig(ROOT).scopes, ...(patch?.scopes ?? {}) };
      lib.saveConfig(ROOT, cfg);
      return json(res, 200, { ok: true, config: cfg });
    }
    if (req.method === "POST" && path === "/entry") {
      const b = await readBody(req);
      if (!b?.title || !String(b.title).trim()) return json(res, 400, { ok: false, error: "标题不能为空" });
      if (!lib.loadConfig(ROOT).enabled) return json(res, 409, { ok: false, error: "记忆功能已关闭" });
      const r = lib.addEntry(ROOT, b);
      return json(res, 200, { ok: true, ...r });
    }
    if (req.method === "GET" && path === "/entry") {
      const parsed = lib.readEntryParsed(ROOT, url.searchParams.get("id") ?? "");
      return json(res, 200, { ok: true, content: parsed.content, meta: parsed.meta });
    }
    if (req.method === "POST" && path === "/update") {
      const b = await readBody(req);
      if (!b?.id) return json(res, 400, { ok: false, error: "缺少条目 id" });
      const r = lib.updateEntry(ROOT, b.id, b);
      return json(res, 200, { ok: true, ...r });
    }
    if (req.method === "POST" && path === "/delete") {
      const b = await readBody(req);
      // 面板/命令删除都是用户意志 → 记负反馈并进回收站
      lib.deleteEntry(ROOT, b?.id ?? "", "user");
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && path === "/restore") {
      const b = await readBody(req);
      const r = lib.restoreEntry(ROOT, b?.id ?? "");
      return json(res, 200, { ok: true, ...r });
    }
    if (req.method === "POST" && path === "/purge") {
      const b = await readBody(req);
      lib.purgeTrash(ROOT, b?.id ?? null);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && path === "/touch") {
      const b = await readBody(req);
      if (b?.workspace) lastWorkspace = String(b.workspace);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && path === "/shutdown") {
      json(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 100);
      return;
    }
    json(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    json(res, 400, { ok: false, error: String(err?.message ?? err) });
  }
});

server.on("error", (e) => {
  if (e?.code === "EADDRINUSE" && tryingPort < PORT_RANGE[1]) listen(tryingPort + 1);
  else process.exit(1);
});

function listen(port) {
  tryingPort = port;
  server.listen(port, "127.0.0.1", () => {
    PORT = port;
    writeClientConfig();
    // 自愈守卫：config 被新实例改写（指向别的端口）→ 让位退出；config 被删除
    // （如卸载流程）→ 连续两次确认后退出，避免版本交替期残留孤儿进程
    let configMisses = 0;
    setInterval(() => {
      if (!ASSETS_DIR) return;
      try {
        const c = JSON.parse(readFileSync(join(ASSETS_DIR, CONFIG_NAME), "utf8"));
        configMisses = 0;
        if (c.port && c.port !== PORT) process.exit(0);
      } catch {
        if (++configMisses >= 2) process.exit(0);
      }
    }, 30_000).unref();
  });
}

// --- 启动 ------------------------------------------------------------------------
const existing = await pickPort();
if (existing.reuse) {
  // 同版本已在跑且 config 指向它：直接退出（token 沿用旧 config，无需重启）
  process.exit(0);
}
listen(PORT_RANGE[0]);
