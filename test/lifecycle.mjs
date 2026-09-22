/**
 * 生命周期全链路测试：分层写入 → 试用期 → 转正/过期/下架 → 回收站 → 恢复 → 负反馈
 * 用法：node test/lifecycle.mjs
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as lib from "../scripts/memory-lib.mjs";

const home = mkdtempSync(join(tmpdir(), "am-life-"));
process.env.KIMI_CODE_HOME = home;
// memoryRoot 在模块加载时不用 env（每次调用都读），直接传 root
const root = lib.memoryRoot(home);
const WS = "D:/demo/my-app";
let passed = 0;
const assert = (c, m) => { if (!c) { console.error("FAIL: " + m); process.exit(1); } passed++; console.log("ok: " + m); };
const cfg = lib.loadConfig(root);

// === 1. 分层写入：手动=active，自动=probation ===
lib.addEntry(root, { scope: "user", title: "手动条目", content: "用户要求记的", origin: "manual", type: "偏好" });
lib.addEntry(root, { scope: "project", workspace: WS, title: "自动合格条目", content: "有证据的自动沉淀", origin: "auto", type: "事实", evidence: "用户说：这个项目测试用 vitest" });
lib.addEntry(root, { scope: "user", title: "自动缺证据条目", content: "没有证据的自动沉淀", origin: "auto", type: "事实" });
let entries = lib.listEntries(root);
const manual = entries.find((e) => e.title === "手动条目");
const auto1 = entries.find((e) => e.title === "自动合格条目");
const auto2 = entries.find((e) => e.title === "自动缺证据条目");
assert(manual.status === "active" && manual.origin === "manual", "手动条目 active");
assert(auto1.status === "probation" && auto1.evidence.includes("vitest"), "自动条目 probation + evidence 读回");
assert(auto2.status === "probation" && !auto2.evidence, "缺证据条目也是 probation（下架交给 sweep）");

// === 2. sweep 第一轮：机械校验（缺 evidence → violation 下架）+ 注入计数 ===
let sw = lib.sweep(root, cfg, WS);
assert(sw.violated === 1, "缺证据条目被机械下架");
assert(sw.counted === 2, "注入的 2 条计数（手动+合格自动）");
entries = lib.listEntries(root);
assert(entries.length === 2, "下架后剩 2 条");
const trash1 = lib.listTrash(root);
assert(trash1.length === 1 && trash1[0].trashReason === "violation", "回收站含 violation 条目");
assert(lib.readEntryParsed(root, entries.find(e => e.title === "自动合格条目").id).meta.sessions === "1", "sessions=1 落盘");

// === 3. 手动条目永远不被机械校验（缺 type 也不下架）===
assert(entries.find((e) => e.title === "手动条目"), "手动条目不受机械校验影响");

// === 4. sweep 第二/三轮：注入计数 → 第三次转正 ===
lib.sweep(root, cfg, WS); // sessions=2
sw = lib.sweep(root, cfg, WS); // sessions=3 → 转正
assert(sw.counted === 2 && sw.promoted === 1, "第三次注入触发转正");
entries = lib.listEntries(root);
assert(entries.find((e) => e.title === "自动合格条目").status === "active", "转正后 status=active");

// === 5. 注入上下文标记 ===
lib.addEntry(root, { scope: "user", title: "新自动条目", content: "x", origin: "auto", type: "坑", evidence: "部署时踩了端口占用的坑" });
lib.sweep(root, cfg, WS); // 新条目 sessions=1，probation
const ctx = lib.buildContext(root, cfg, WS);
assert(ctx.includes("自动合格条目") && !ctx.match(/自动合格条目〔试用〕/), "转正条目无试用标记");
assert(/新自动条目.*〔试用〕/.test(ctx), "试用条目带〔试用〕标记");

// === 6. 过期：14 天未转正 → 回收站 ===
const staleId = entries.find((e) => e.title === "手动条目") ? null : null;
// 直接构造一个过期的 probation 条目（把 created 改到 15 天前）
lib.addEntry(root, { scope: "user", title: "过期候选", content: "老条目", origin: "auto", type: "事实", evidence: "旧证据" });
const all = lib.listEntries(root);
const old = all.find((e) => e.title === "过期候选");
const fp = join(root, "user", old.file);
let text = readFileSync(fp, "utf8").replace(/^created: .*$/m, `created: ${new Date(Date.now() - 15 * 86400_000).toISOString()}`);
writeFileSync(fp, text, "utf8");
sw = lib.sweep(root, cfg, WS);
assert(sw.expired === 1, "15 天 probation 过期进回收站");
assert(!lib.listEntries(root).some((e) => e.title === "过期候选"), "过期条目离开主列表");
const trashNow = lib.listTrash(root);
assert(trashNow.some((t) => t.title === "过期候选" && t.trashReason === "expired"), "回收站含 expired 条目");

// === 7. 负反馈：删除自动条目 → rejected.jsonl；删除手动条目 → 不记 ===
const autoEntry = lib.listEntries(root).find((e) => e.title === "新自动条目");
lib.deleteEntry(root, autoEntry.id, "user");
let rejected = lib.listRejected(root, 10);
assert(rejected.length === 1 && rejected[0].title === "新自动条目", "删除自动条目记负反馈");
const manualEntry = lib.listEntries(root).find((e) => e.title === "手动条目");
lib.deleteEntry(root, manualEntry.id, "user");
assert(lib.listRejected(root, 10).length === 1, "删除手动条目不记负反馈");
// 注入头部带负反馈
const ctx2 = lib.buildContext(root, cfg, WS);
assert(ctx2.includes("用户曾删除过以下自动记忆") && ctx2.includes("新自动条目"), "注入头部带负反馈清单");

// === 8. 恢复：回收站 → 主列表，直接转正 ===
const trashed = lib.listTrash(root).find((t) => t.title === "新自动条目");
const restored = lib.restoreEntry(root, trashed.id);
const back = lib.listEntries(root).find((e) => e.id === restored.id);
assert(back && back.status === "active", "恢复即转正");
assert(!lib.listTrash(root).some((t) => t.title === "新自动条目"), "回收站副本清除");

// === 9. sweep 摘要落盘 ===
const ls = lib.lastSweep(root);
assert(ls && typeof ls.promoted === "number" && typeof ls.violated === "number", "维护摘要落盘");

// === 10. 注入预览含 probation 计数 ===
const pv = lib.injectionPreview(root, cfg, WS);
assert(pv.probation !== undefined && pv.probation >= 0, "预览含试用计数");

// === 11. 关闭 autoSave 语义（仅合同层）+ enabled=false 全停 ===
lib.sweep(root, lib.normalizeConfig({ enabled: false }), WS);
assert(lib.buildContext(root, lib.normalizeConfig({ enabled: false }), WS) === "", "enabled=false 不注入");

console.log(`--- 生命周期全链路 ${passed} 项全部通过 ---`);
process.exit(0);
