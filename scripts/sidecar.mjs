/**
 * auto-memory sidecar
 *
 * 由 SessionStart hook 拉起的本地常驻服务（kimi-webbridge daemon 同款模式）：
 * 桌面端渲染进程没有 fs 权限，注入的记忆管理面板通过本服务读写
 * ~/.kimi-code/memory/。仅绑定 127.0.0.1，Bearer token 写入
 * desktop-dist/assets/auto-memory.config.json 供面板获取。
 *
 * 自愈：每 30s 检查 config 文件——被别的活实例改写（新版本接管）→ 让位退出；
 * config 意外丢失或指向死进程 → 重写夺回（连续两轮仍丢才让位，防卸载残留）。
 * 空闲 30 分钟（应用已关闭，面板/钩子都不再访问）→ 自退，不留后台进程。
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
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import * as lib from "./memory-lib.mjs";
import * as su from "./self-update.mjs";

// 不钉住插件目录：引擎安装/更新要把 managed/auto-memory 整个 rename，任何
// 进程的 CWD 停在里面都会让它 EBUSY。spawn 已传 cwd:homedir()，这里再兜一层
// （防 CLI/手动等其它拉起方式把 CWD 留在插件目录）
try { process.chdir(homedir()); } catch {}

const ROOT = lib.memoryRoot();
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ASSETS_DIR = process.env.AUTO_MEMORY_ASSETS ?? null;
const CONFIG_NAME = "auto-memory.config.json";
const PORT_RANGE = [39471, 39482];
const IDLE_EXIT_MS = 30 * 60_000;   // 这么久没有任何已鉴权请求（应用已关闭）→ 自退

let TOKEN = randomBytes(16).toString("hex");
let PORT = 0;
let lastWorkspace = null;
let lastActivityAt = Date.now();

/** 进程存活检查；EPERM 视为活着（别人的进程无权发信号）。 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}

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

// CORS 只放行桌面应用的自定义协议来源；其他浏览器页面拿不到 ACAO，跨域读被拦
function corsFor(req) {
  const origin = req.headers.origin ?? "";
  if (origin.startsWith("app://")) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "authorization,content-type",
      "Access-Control-Max-Age": "86400",
    };
  }
  return {};
}

function json(req, res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", ...corsFor(req) });
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

  if (req.method === "OPTIONS") { res.writeHead(204, corsFor(req)); res.end(); return; }

  // /ping 免鉴权（供探测复用）；其余端点校验 Bearer token
  if (path === "/ping") {
    return json(req, res, 200, { ok: true, service: "auto-memory", version: lib.VERSION, port: PORT });
  }
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${TOKEN}`) return json(req, res, 401, { ok: false, error: "未授权" });
  lastActivityAt = Date.now();

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
      return json(req, res, 200, { ok: true, config: cfg, entries, workspaces, lastWorkspace, injection, trash, rejected, sweepLog, update, dataDir: ROOT, version: lib.VERSION });
    }
    if (req.method === "POST" && path === "/config") {
      const patch = await readBody(req);
      const cfg = lib.normalizeConfig({ ...lib.loadConfig(ROOT), ...(patch ?? {}) });
      cfg.scopes = { ...lib.loadConfig(ROOT).scopes, ...(patch?.scopes ?? {}) };
      lib.saveConfig(ROOT, cfg);
      return json(req, res, 200, { ok: true, config: cfg });
    }
    if (req.method === "POST" && path === "/entry") {
      const b = await readBody(req);
      if (!b?.title || !String(b.title).trim()) return json(req, res, 400, { ok: false, error: "标题不能为空" });
      if (!lib.loadConfig(ROOT).enabled) return json(req, res, 409, { ok: false, error: "记忆功能已关闭" });
      const r = lib.addEntry(ROOT, b);
      return json(req, res, 200, { ok: true, ...r });
    }
    if (req.method === "GET" && path === "/entry") {
      const parsed = lib.readEntryParsed(ROOT, url.searchParams.get("id") ?? "");
      return json(req, res, 200, { ok: true, content: parsed.content, meta: parsed.meta });
    }
    if (req.method === "POST" && path === "/update") {
      const b = await readBody(req);
      if (!b?.id) return json(req, res, 400, { ok: false, error: "缺少条目 id" });
      const r = lib.updateEntry(ROOT, b.id, b);
      return json(req, res, 200, { ok: true, ...r });
    }
    if (req.method === "POST" && path === "/delete") {
      const b = await readBody(req);
      // 面板/命令删除都是用户意志 → 记负反馈并进回收站
      lib.deleteEntry(ROOT, b?.id ?? "", "user");
      return json(req, res, 200, { ok: true });
    }
    if (req.method === "POST" && path === "/restore") {
      const b = await readBody(req);
      const r = lib.restoreEntry(ROOT, b?.id ?? "");
      return json(req, res, 200, { ok: true, ...r });
    }
    if (req.method === "POST" && path === "/purge") {
      const b = await readBody(req);
      lib.purgeTrash(ROOT, b?.id ?? null);
      return json(req, res, 200, { ok: true });
    }
    if (req.method === "POST" && path === "/touch") {
      const b = await readBody(req);
      if (b?.workspace) lastWorkspace = String(b.workspace);
      return json(req, res, 200, { ok: true });
    }
    if (req.method === "POST" && path === "/shutdown") {
      json(req, res, 200, { ok: true });
      setTimeout(() => process.exit(0), 100);
      return;
    }
    json(req, res, 404, { ok: false, error: "not found" });
  } catch (err) {
    json(req, res, 400, { ok: false, error: String(err?.message ?? err) });
  }
});

server.on("error", (e) => {
  // 递增上限必须与 ensureSidecar 的探测范围一致（探测 p < PORT_RANGE[1]）：
  // 绑到范围外的实例永远不会被复用/发现，每次会话都会再拉一个新实例
  if (e?.code === "EADDRINUSE" && tryingPort + 1 < PORT_RANGE[1]) listen(tryingPort + 1);
  else process.exit(1);
});

function listen(port) {
  tryingPort = port;
  server.listen(port, "127.0.0.1", () => {
    PORT = port;
    writeClientConfig();
    // 空闲自退：面板与钩子都不再访问（应用已关闭）→ 退出，不留后台进程
    setInterval(() => {
      if (Date.now() - lastActivityAt > IDLE_EXIT_MS) process.exit(0);
    }, 60_000).unref();
    // config 看门狗：pid 判断夺回/让位，替代旧的"端口不一致就自杀"——
    // 那套逻辑在 config 陈旧时会留下"健康实例 + 坏 config"的死局
    let configMisses = 0;
    setInterval(() => {
      if (!ASSETS_DIR) return;
      let c = null;
      try { c = JSON.parse(readFileSync(join(ASSETS_DIR, CONFIG_NAME), "utf8")); } catch {}
      if (!c || typeof c.port !== "number") {
        // 丢失/损坏：连续两轮仍丢（有人在有意删，如卸载 shutdown 失败的兜底）
        // → 让位；单次意外丢失（杀软锁文件等）→ 重写夺回
        if (++configMisses >= 2) process.exit(0);
        writeClientConfig();
        return;
      }
      configMisses = 0;
      if (c.pid === process.pid && c.port === PORT) return;
      // 别的活实例改写了 config（新版本接管）→ 让位；config 指向死进程（陈旧）
      // → 重写夺回。pid 复用的误判代价只是多退一次，下次会话自动拉起
      if (c.port !== PORT && pidAlive(c.pid)) process.exit(0);
      writeClientConfig();
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
