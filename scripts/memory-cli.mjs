#!/usr/bin/env node
/**
 * auto-memory CLI —— AI / 命令行的受控记忆操作通道
 *
 * 为什么存在：面板走 sidecar → memory-lib；AI 若按提示词合同直接手写文件，
 * 则绕过全部机制（frontmatter 字段保留、索引重写、回收站、负反馈、引用改名）。
 * 本 CLI 把破坏性 / 迁移性操作收敛到与面板同一套代码路径。
 *
 * 用法：
 *   node memory-cli.mjs list [关键词]
 *   node memory-cli.mjs show <标题>
 *   node memory-cli.mjs add <标题> [--content 文本] [--scope user|project|local]
 *                            [--type 偏好|事实|坑] [--evidence 用户原话] [--auto]
 *                            [--workspace 路径]
 *   node memory-cli.mjs forget <标题>       # 用户意志删除：进回收站；自动条目记负反馈
 *   node memory-cli.mjs move <标题> <user|project|local> [--workspace 路径]
 *   node memory-cli.mjs promote <标题>      # 试用 → 正式
 *   node memory-cli.mjs restore <标题>      # 从回收站恢复（恢复即转正）
 *   node memory-cli.mjs reindex             # 重建索引：回收孤儿文件、清掉死索引行
 *
 * project/local 的 workspace 缺省取当前目录（AI 在工作区里运行时 cwd 即工作区）。
 * --home 可指定 KIMI_CODE_HOME。
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as lib from "./memory-lib.mjs";

const args = process.argv.slice(2);
const cmd = args[0] ?? "";
const rest = args.slice(1);
const opt = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
const has = (n) => rest.includes(n);

const HOME = opt("--home") ?? process.env.KIMI_CODE_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".kimi-code");
const ROOT = lib.memoryRoot(HOME);
const CWD = process.cwd();
const fail = (m) => { console.error("✗ " + m); process.exit(1); };

/** 按标题（或文件名）找唯一条目；多义/找不到时报出候选 */
function resolveEntry(query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) fail("请给出条目标题");
  const all = lib.listEntries(ROOT);
  const exact = all.filter((e) => e.title.toLowerCase() === q || (e.file ?? "").toLowerCase() === q);
  const fuzzy = all.filter((e) => e.title.toLowerCase().includes(q) || (e.file ?? "").toLowerCase().includes(q));
  const pick = exact.length ? exact : fuzzy;
  if (pick.length === 1) return pick[0];
  if (!pick.length) fail(`找不到条目「${query}」。用 list 查看现有条目。`);
  fail(`「${query}」匹配到 ${pick.length} 条，请用更完整的标题：\n` +
    pick.map((e) => `  - ${e.title}（${e.scope}${e.workspace ? ` · ${e.workspace}` : ""}）`).join("\n"));
}

function resolveTrash(query) {
  const q = String(query ?? "").trim().toLowerCase();
  const all = lib.listTrash(ROOT);
  const pick = all.filter((e) => (e.title ?? "").toLowerCase().includes(q) || (e.id ?? "").toLowerCase().includes(q));
  if (pick.length === 1) return pick[0];
  if (!pick.length) fail(`回收站里找不到「${query}」。`);
  fail(`「${query}」匹配到 ${pick.length} 条回收站条目，请用更完整的标题：\n` +
    pick.map((e) => `  - ${e.title}（${e.scope} · ${e.trashReason || "?"}）`).join("\n"));
}

function scopeArg(allowEmpty = false) {
  const s = opt("--scope");
  if (!s) return allowEmpty ? undefined : fail("需要 --scope user|project|local");
  if (!["user", "project", "local"].includes(s)) fail(`非法 scope：${s}`);
  return s;
}

function workspaceFor(scope) {
  return scope === "user" ? undefined : (opt("--workspace") ?? CWD);
}

function warnBudget(r) {
  if (r?.overBudget) console.error("⚠ 记忆索引接近字符上限：下次注入会带「先整理」提示，建议合并/精简旧条目。");
}

switch (cmd) {
  case "list": {
    const q = (rest.find((a) => !a.startsWith("--")) ?? "").toLowerCase();
    const all = lib.listEntries(ROOT).filter((e) => !q || (e.title + " " + e.hook).toLowerCase().includes(q));
    if (!all.length) { console.log("（无条目）"); break; }
    const byScope = { user: [], project: [], local: [] };
    for (const e of all) byScope[e.scope]?.push(e);
    const label = { user: "全局", project: "项目", local: "本机" };
    for (const scope of ["user", "project", "local"]) {
      if (!byScope[scope].length) continue;
      console.log(`【${label[scope]}】`);
      for (const e of byScope[scope]) {
        console.log(`  - ${e.title} [${e.origin === "auto" ? "自动" : "手动"}${e.status === "probation" ? `·试用${e.sessions ?? 0}/3` : ""}${e.type ? `·${e.type}` : ""}] — ${e.hook}（${e.workspace ?? "-"}）`);
      }
    }
    console.log(`共 ${all.length} 条`);
    break;
  }

  case "show": {
    const e = resolveEntry(rest.find((a) => !a.startsWith("--")));
    console.log(lib.readEntry(ROOT, e.id));
    break;
  }

  case "add": {
    // 与面板/sidecar 路径同一约束：总开关关闭时不允许写入
    if (!lib.loadConfig(ROOT).enabled) fail("记忆功能已关闭（面板总开关），请先开启再写入");
    const title = rest.find((a) => !a.startsWith("--") && a !== opt("--scope") && a !== opt("--type") && a !== opt("--evidence") && a !== opt("--workspace") && a !== opt("--content"));
    if (!title?.trim()) fail("用法：add <标题> [--content 文本] [--scope user|project|local] [--type 偏好|事实|坑] [--evidence 原话] [--auto]");
    const scope = scopeArg(true) ?? "user";
    const r = lib.addEntry(ROOT, {
      scope,
      workspace: workspaceFor(scope),
      title: title.trim(),
      content: opt("--content") ?? title.trim(),
      origin: has("--auto") ? "auto" : "manual",
      type: opt("--type"),
      evidence: opt("--evidence"),
    });
    console.log(`✓ 已写入 ${r.id}`);
    warnBudget(r);
    break;
  }

  case "forget": {
    const e = resolveEntry(rest.find((a) => !a.startsWith("--")));
    // reason=user：进回收站可恢复；自动条目同时记负反馈（与面板删除同语义）
    lib.deleteEntry(ROOT, e.id, "user");
    console.log(`✓ 已删除「${e.title}」（${e.scope}），可从回收站恢复`);
    break;
  }

  case "move": {
    const title = rest.find((a) => !a.startsWith("--"));
    if (!title) fail("用法：move <标题> <user|project|local> [--workspace 路径]");
    const target = rest[rest.indexOf(title) + 1];
    if (!["user", "project", "local"].includes(target)) fail("目标级别必须是 user|project|local");
    const e = resolveEntry(title);
    const r = lib.updateEntry(ROOT, e.id, { scope: target, workspace: workspaceFor(target) });
    console.log(`✓ 已迁移「${e.title}」→ ${target}（新 id: ${r.id}）`);
    break;
  }

  case "promote": {
    const e = resolveEntry(rest.find((a) => !a.startsWith("--")));
    lib.updateEntry(ROOT, e.id, { status: "active" });
    console.log(`✓ 已转正「${e.title}」（试用 → 正式）`);
    break;
  }

  case "restore": {
    const t = resolveTrash(rest.find((a) => !a.startsWith("--")));
    const r = lib.restoreEntry(ROOT, t.id);
    console.log(`✓ 已恢复「${t.title}」→ ${r.id}（恢复即转正）`);
    break;
  }

  case "reindex": {
    // 以主题文件为唯一事实重建各 scope 索引：回收孤儿文件、清掉指向已删文件的死行
    let orphanFiles = 0, deadLines = 0, total = 0;
    const scopes = [
      { scope: "user", keys: [null] },
      { scope: "project", keys: lib.listKeys(ROOT, "project") },
      { scope: "local", keys: lib.listKeys(ROOT, "local") },
    ];
    for (const { scope, keys } of scopes) {
      for (const key of keys) {
        const dirPath = scope === "user" ? join(ROOT, "user") : join(ROOT, scope, key ?? "unknown");
        if (!existsSync(dirPath)) continue;
        const files = readdirSync(dirPath).filter((f) => f.endsWith(".md") && f !== "MEMORY.md" && !f.startsWith("."));
        const indexText = existsSync(join(dirPath, "MEMORY.md")) ? readFileSync(join(dirPath, "MEMORY.md"), "utf8") : "";
        const indexFiles = new Set(indexText.split(/\r?\n/)
          .map((l) => /\]\(([^)]+\.md)\)/.exec(l)?.[1]).filter(Boolean));
        const entries = [];
        for (const f of files) {
          const { meta, body } = lib.parseFrontmatter(readFileSync(join(dirPath, f), "utf8"));
          entries.push({ title: meta.title ?? f.replace(/\.md$/, ""), file: f, hook: lib.firstHook(body) });
          if (!indexFiles.has(f)) orphanFiles++;
        }
        for (const f of indexFiles) if (!files.includes(f)) deadLines++;
        total += entries.length;
        lib.writeIndex(dirPath, entries);   // 与面板同一份实现，行格式永不漂移
      }
    }
    console.log(`✓ 索引重建完成：共 ${total} 条；回收孤儿 ${orphanFiles} 个，清除死行 ${deadLines} 条`);
    break;
  }

  default:
    console.error("用法：node memory-cli.mjs <list|show|add|forget|move|promote|restore|reindex> …");
    process.exit(1);
}
