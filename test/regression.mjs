/**
 * 修复回归测试（v0.3.0）：覆盖审查发现并修复的问题。
 * 用法：node test/regression.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as lib from "../scripts/memory-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0;
const assert = (c, m) => { if (!c) { console.error("FAIL: " + m); process.exit(1); } passed++; console.log("ok: " + m); };
const newRoot = () => {
  const home = mkdtempSync(join(tmpdir(), "am-reg-"));
  return lib.memoryRoot(home);
};

// === 1. 带引号的 YAML frontmatter 不再被机械 sweep 误杀（v0.2.1 会下架） ===
{
  const root = newRoot();
  mkdirSync(join(root, "user"), { recursive: true });
  writeFileSync(join(root, "user", "quoted.md"), `---
title: 用 pnpm
scope: user
origin: auto
status: probation
type: "偏好"
evidence: "用户说：这个项目用 pnpm"
sessions: 0
created: ${new Date().toISOString()}
updated: ${new Date().toISOString()}
---

这个项目用 pnpm 而不是 npm。
`, "utf8");
  writeFileSync(join(root, "user", "MEMORY.md"), `- [用 pnpm](quoted.md) — 包管理器偏好\n`, "utf8");
  const sw = lib.sweep(root, lib.loadConfig(root), null);
  assert(sw.violated === 0, "带引号的合格自动条目不被机械下架");
  assert(lib.listEntries(root).some((e) => e.title === "用 pnpm"), "引号条目仍可见");
}

// === 2. 索引超预算：不再静默丢弃新条目；返回 overBudget 提示 ===
{
  const root = newRoot();
  let last = null;
  for (let i = 0; i < 95; i++) {
    last = lib.addEntry(root, { scope: "user", title: `条目${i}这是一个比较长的标题用来消耗字符预算`, content: "内容" + i });
  }
  const idx = readFileSync(join(root, "user", "MEMORY.md"), "utf8");
  assert(idx.includes("条目94"), "超预算时最新条目仍在索引（不产生孤儿）");
  assert(last.overBudget === true, "超预算时 addEntry 返回 overBudget=true");
  assert(lib.listEntries(root).length === 95, "全部条目可列出");
}

// === 3. 保留文件名拒绝：MEMORY.md / meta.json 不能被当成条目操作 ===
{
  const root = newRoot();
  let threw = 0;
  for (const bad of ["user||MEMORY.md", "user||meta.json", "user||.hidden.md"]) {
    try { lib.deleteEntry(root, bad, "user"); } catch { threw++; }
  }
  assert(threw === 3, "保留名/隐藏文件 id 被拒绝");
}

// === 4. 工作区盘符大小写归一 ===
{
  assert(lib.projectKey("d:\\x\\demo") === lib.projectKey("D:/x/demo"), "d:\\ 与 D:/ 生成同一 key");
}

// === 5. 回收站 90 天自动清理 ===
{
  const root = newRoot();
  lib.addEntry(root, { scope: "user", title: "老条目", content: "x" });
  const e = lib.listEntries(root)[0];
  lib.deleteEntry(root, e.id, "user");
  const trashFile = join(root, ".trash", "user", e.file);
  const old = readFileSync(trashFile, "utf8").replace(/^trashedAt: .*$/m, `trashedAt: ${new Date(Date.now() - 91 * 86400_000).toISOString()}`);
  writeFileSync(trashFile, old, "utf8");
  const sw = lib.sweep(root, lib.loadConfig(root), null);
  assert(sw.purged === 1, "滞留 91 天的回收站条目被自动清理");
  assert(lib.listTrash(root).length === 0, "清理后回收站为空");
}

// === 6. CLI：forget 走回收站+负反馈；move/promote/restore 可用 ===
{
  const home = mkdtempSync(join(tmpdir(), "am-cli-"));
  const root = lib.memoryRoot(home);
  const cli = (a) => spawnSync(process.execPath, [join(HERE, "..", "scripts", "memory-cli.mjs"), ...a, "--home", home], { encoding: "utf8" });

  let r = cli(["add", "CLI测试条目", "--scope", "user", "--content", "内容X"]);
  assert(r.status === 0, "CLI add 成功");
  r = cli(["add", "CLI自动条目", "--scope", "user", "--content", "内容Y", "--auto", "--type", "坑", "--evidence", "踩了端口占用的坑"]);
  assert(r.status === 0, "CLI add --auto 成功");

  r = cli(["forget", "CLI测试条目"]);
  assert(r.status === 0 && lib.listEntries(root).length === 1, "CLI forget 删除条目");
  assert(lib.listTrash(root).some((t) => t.title === "CLI测试条目"), "CLI forget 进回收站");
  assert(lib.listRejected(root, 5).length === 0, "手动条目删除不记负反馈");

  r = cli(["forget", "CLI自动条目"]);
  assert(r.status === 0, "CLI forget 自动条目");
  assert(lib.listRejected(root, 5).some((x) => x.title === "CLI自动条目"), "自动条目删除记负反馈");

  r = cli(["restore", "CLI自动条目"]);
  assert(r.status === 0, "CLI restore 恢复");
  const restored = lib.listEntries(root).find((e) => e.title === "CLI自动条目");
  assert(restored && restored.status === "active", "恢复即转正");

  r = cli(["promote", "CLI自动条目"]);
  assert(r.status === 0, "CLI promote 执行");
  r = cli(["move", "CLI自动条目", "project", "--workspace", "D:/x/demo"]);
  assert(r.status === 0, "CLI move 执行");
  assert(lib.listEntries(root).some((e) => e.scope === "project" && e.title === "CLI自动条目"), "move 后条目在 project scope");
}

// === 7. reindex：索引丢失后回收孤儿文件 ===
{
  const home = mkdtempSync(join(tmpdir(), "am-reindex-"));
  const root = lib.memoryRoot(home);
  lib.addEntry(root, { scope: "user", title: "孤儿条目", content: "内容" });
  const { unlinkSync } = await import("node:fs");
  unlinkSync(join(root, "user", "MEMORY.md"));   // 模拟索引丢失
  assert(lib.listEntries(root).length === 0, "索引丢失后条目不可见");
  const cli = (a) => spawnSync(process.execPath, [join(HERE, "..", "scripts", "memory-cli.mjs"), ...a, "--home", home], { encoding: "utf8" });
  const r = cli(["reindex"]);
  assert(r.status === 0, "reindex 执行成功");
  assert(lib.listEntries(root).length === 1, "reindex 回收孤儿条目");
}

// === 8. 版本号来自 manifest（单一来源） ===
{
  const manifest = JSON.parse(readFileSync(join(HERE, "..", "kimi.plugin.json"), "utf8"));
  assert(lib.VERSION === manifest.version, `VERSION 与 manifest 一致 → ${lib.VERSION}`);
  assert(typeof manifest.systemPrompt === "string" && manifest.systemPrompt.includes("写入分层"), "manifest 内联 systemPrompt 已同步");
}

console.log(`--- 回归测试 ${passed} 项全部通过 ---`);
