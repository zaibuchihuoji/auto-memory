/**
 * auto-memory 插件 —— 自动补丁 + sidecar 守护 + 会话记忆注入
 *
 * 由插件 hook（SessionStart）调用：node --input-type=module -e "await import(...)"
 * 引擎注入 KIMI_PLUGIN_ROOT（插件根目录）与 KIMI_CODE_HOME 环境变量。
 *
 * 行为（hook 模式，静默）：
 *   1. 检查/修复 desktop-dist 注入（设置页"记忆"入口 + 管理面板）
 *   2. 确保 sidecar 本地服务在跑（面板的读写通道）
 *   3. 把当前适用的记忆索引输出到 stdout（进入会话上下文）
 * 任何一步失败都不阻塞会话启动（exit 0）。
 *
 * 手动模式：
 *   node auto-patch.mjs --status      查看注入/服务/存储状态
 *   node auto-patch.mjs --force       强制重新注入
 *   node auto-patch.mjs --uninstall   还原 desktop-dist 并停掉 sidecar
 *   其余参数：--dist <desktop-dist目录> --home <KIMI_CODE_HOME> --no-spawn
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as lib from "./memory-lib.mjs";

const SCRIPT_NAME = "auto-memory.js";
const CONFIG_NAME = "auto-memory.config.json";
const BACKUP_NAME = "index.html.auto-memory.bak";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const quiet = !has("--status") && !has("--uninstall") && !has("--force") && !args.includes("--verbose");
const say = (m) => { if (!quiet) console.log(m); };

// --- 定位 ------------------------------------------------------------------------
function findDistDir() {
  const forced = opt("--dist") || process.env.AUTO_MEMORY_DIST;
  if (forced && existsSync(join(resolve(forced), "index.html"))) return resolve(forced);
  const candidates = [
    join(process.env.LOCALAPPDATA ?? "", "Programs", "kimi-code", "Kimi Code", "resources", "desktop-dist"),
    join(process.env.LOCALAPPDATA ?? "", "Programs", "kimi-desktop", "resources", "desktop-dist"),
    "D:\\kimi-code\\Kimi Code\\resources\\desktop-dist",
  ];
  for (const c of candidates) if (c && existsSync(join(c, "index.html"))) return resolve(c);
  return null;
}

function homeDir() {
  return opt("--home") ?? process.env.KIMI_CODE_HOME ?? join(homedir(), ".kimi-code");
}

// --- 注入 ------------------------------------------------------------------------
function patchHtml(indexPath) {
  const html = readFileSync(indexPath, "utf8");
  const backupPath = join(dirname(indexPath), BACKUP_NAME);
  // 备份内容 = 当前页面去掉本插件注入行，每次打补丁跟随刷新：应用自动更新覆盖
  // index.html、或另一插件（如 usage-union）增删注入后，备份仍是干净基线，
  // 卸载时不会恢复出过期页面或指向已删除脚本的 ghost 标签
  const clean = html.split("\n").filter((l) => !l.includes(SCRIPT_NAME)).join("\n");
  if (!clean.includes("</body>")) throw new Error("index.html 结构异常");
  let cur = null;
  try { cur = readFileSync(backupPath, "utf8"); } catch {}
  if (cur !== clean) writeFileSync(backupPath, clean, "utf8");
  const scriptTag = `    <script src="/assets/${SCRIPT_NAME}"></script>\n`;
  writeFileSync(indexPath, clean.replace("</body>", `${scriptTag}</body>`), "utf8");
}

function injectUI(dist) {
  const indexPath = join(dist, "index.html");
  const runtimePath = join(dist, "assets", SCRIPT_NAME);
  mkdirSync(join(dist, "assets"), { recursive: true });
  const template = readFileSync(join(HERE, "..", "assets", "memory-ui.js"), "utf8");
  const html = readFileSync(indexPath, "utf8");
  const patched = html.includes(SCRIPT_NAME);
  const stale = !existsSync(runtimePath) || !readFileSync(runtimePath, "utf8").includes(`auto-memory@${lib.VERSION}`);
  if (patched && !stale && !has("--force")) return false;
  writeFileSync(runtimePath, `/* auto-memory@${lib.VERSION} */\n` + template, "utf8");
  if (!patched || has("--force")) patchHtml(indexPath);
  return true;
}

function uninstallDist(dist) {
  const indexPath = join(dist, "index.html");
  const backupPath = join(dist, BACKUP_NAME);
  if (existsSync(backupPath)) {
    copyFileSync(backupPath, indexPath);
    rmSync(backupPath, { force: true });
  } else if (existsSync(indexPath)) {
    const html = readFileSync(indexPath, "utf8");
    writeFileSync(indexPath, html.split("\n").filter((l) => !l.includes(SCRIPT_NAME)).join("\n"), "utf8");
  }
  rmSync(join(dist, "assets", SCRIPT_NAME), { force: true });
  rmSync(join(dist, "assets", CONFIG_NAME), { force: true });
}

// --- sidecar ---------------------------------------------------------------------
async function ping(port) {
  try {
    const j = await (await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(400) })).json();
    return j?.service === "auto-memory" ? j : null;
  } catch { return null; }
}

async function ensureSidecar(dist) {
  // 已有同版本实例在跑就不动；版本不一致（插件升级后）继续走拉起流程——
  // 新实例会占用下一个端口并重写 config，旧实例的自愈守卫会让位退出。
  // 并行探测：串行最坏 11×400ms≈4.4s，加上拉起等待可能顶到 hook 的 15s 超时
  const ports = [];
  for (let p = 39471; p < 39482; p++) ports.push(p);
  const hits = await Promise.all(ports.map(ping));
  let anyRunning = false;
  for (let i = 0; i < ports.length; i++) {
    if (hits[i]) {
      if (hits[i].version === lib.VERSION) return { running: true, port: ports[i], spawned: false };
      anyRunning = true;
    }
  }
  if (has("--no-spawn")) return { running: anyRunning, spawned: false };
  const assetsDir = join(dist, "assets");
  const child = spawn(process.execPath, [join(HERE, "sidecar.mjs")], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, AUTO_MEMORY_ASSETS: assetsDir },
    windowsHide: true,
  });
  child.unref();
  // 等 sidecar 绑定端口并写好 config（面板取 port/token 用）
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      const c = JSON.parse(readFileSync(join(assetsDir, CONFIG_NAME), "utf8"));
      if (c.port && await ping(c.port)) return { running: true, port: c.port, spawned: true };
    } catch {}
  }
  return { running: anyRunning, spawned: true };
}

async function shutdownSidecar() {
  const dist = findDistDir();
  if (!dist) return;
  try {
    const c = JSON.parse(readFileSync(join(dist, "assets", CONFIG_NAME), "utf8"));
    if (c.port && c.token) {
      await fetch(`http://127.0.0.1:${c.port}/shutdown`, {
        method: "POST", headers: { Authorization: `Bearer ${c.token}` }, signal: AbortSignal.timeout(800),
      }).catch(() => {});
    }
  } catch {}
}

// --- 主流程 -----------------------------------------------------------------------
async function main() {
  if (has("--uninstall")) {
    await shutdownSidecar();
    const dist = findDistDir();
    if (!dist) { console.error("未找到 desktop-dist"); process.exit(1); }
    uninstallDist(dist);
    console.log(`✓ 已还原 ${dist}，sidecar 已停止`);
    return;
  }

  const dist = findDistDir();
  if (!dist) { say("auto-memory: desktop-dist 未找到，跳过注入"); return; }
  const root = lib.memoryRoot(homeDir());
  mkdirSync(root, { recursive: true });
  const cfg = lib.loadConfig(root);
  if (!existsSync(join(root, "config.json"))) lib.saveConfig(root, cfg);

  let injected = false;
  try { injected = injectUI(dist); } catch (e) { say(`auto-memory: 注入失败 ${e?.message ?? e}`); }

  const side = await ensureSidecar(dist);
  const cwd = process.cwd();
  // 告诉面板当前工作区（切项目后首次会话生效）
  if (side.running && cwd && cwd !== homedir()) {
    try {
      const c = JSON.parse(readFileSync(join(dist, "assets", CONFIG_NAME), "utf8"));
      await fetch(`http://127.0.0.1:${c.port}/touch`, {
        method: "POST",
        headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ workspace: cwd }),
        signal: AbortSignal.timeout(800),
      });
    } catch {}
  }

  // 会话启动维护：转正/过期/机械校验/注入计数（先于注入；负反馈也在此后生效）
  let sweepSummary = null;
  if (cfg.enabled) {
    try { sweepSummary = lib.sweep(root, cfg, cwd); } catch (e) { say(`auto-memory: sweep 失败 ${e?.message ?? e}`); }
  }

  // 会话上下文：记忆索引
  const ctx = cfg.enabled ? lib.buildContext(root, cfg, cwd) : "";
  if (ctx) console.log(ctx);

  if (has("--status")) {
    const entries = lib.listEntries(root);
    console.log(`auto-memory @${lib.VERSION}`);
    console.log(`  dist:      ${dist}（${injected ? "本次重新注入" : "已是最新"}）`);
    console.log(`  sidecar:   ${side.running ? `运行中 :${side.port}` : side.spawned ? "拉起失败" : "未运行"}`);
    console.log(`  存储:      ${root}`);
    console.log(`  开关:      enabled=${cfg.enabled} autoSave=${cfg.autoSave} scopes=${JSON.stringify(cfg.scopes)}`);
    console.log(`  条目:      ${entries.length} 条（user ${entries.filter((e) => e.scope === "user").length} / project ${entries.filter((e) => e.scope === "project").length} / local ${entries.filter((e) => e.scope === "local").length}；试用中 ${entries.filter((e) => e.status === "probation").length}）`);
    console.log(`  回收站:    ${lib.listTrash(root).length} 条 · 负反馈 ${lib.listRejected(root, 99).length} 条`);
    if (sweepSummary) console.log(`  本次维护:  转正 ${sweepSummary.promoted} · 过期 ${sweepSummary.expired} · 下架 ${sweepSummary.violated} · 清理回收站 ${sweepSummary.purged ?? 0} · 注入计数 ${sweepSummary.counted}`);
    console.log(`  当前目录:  ${cwd}`);
  }
}

main().catch((e) => { if (!quiet) { console.error("auto-memory 失败:", e?.message ?? e); process.exit(1); } });
