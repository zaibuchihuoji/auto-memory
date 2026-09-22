/**
 * sidecar 端到端测试：拉起 → ping → 增查删改 → 停止。全部在 node 内完成。
 * 用法：node test/sidecar-e2e.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const testdir = mkdtempSync(join(tmpdir(), "am-e2e-"));
const assets = join(testdir, "assets");
const env = { ...process.env, KIMI_CODE_HOME: join(testdir, "home"), AUTO_MEMORY_ASSETS: assets };

const child = spawn(process.execPath, [join(HERE, "..", "scripts", "sidecar.mjs")], { env, stdio: "inherit" });
const cfgPath = join(assets, "auto-memory.config.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cfg = null;
for (let i = 0; i < 40 && !cfg; i++) {
  await sleep(250);
  try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")); } catch {}
}
if (!cfg?.port) { console.error("FAIL: sidecar 未写出 config"); child.kill(); process.exit(1); }
console.log("ok: sidecar 启动 port=" + cfg.port);

const H = { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" };
const base = `http://127.0.0.1:${cfg.port}`;
const call = async (path, opts = {}) => {
  const res = await fetch(base + path, { ...opts, headers: H });
  return { status: res.status, body: await res.json() };
};
const assert = (c, m) => { if (!c) { console.error("FAIL: " + m); child.kill(); process.exit(1); } console.log("ok: " + m); };

let j = await call("/ping");
assert(j.body.ok && j.body.service === "auto-memory", "ping");

j = await call("/state");
assert(j.status === 200 && j.body.entries.length === 0, "初始 state 为空");

j = await call("/entry", { method: "POST", body: JSON.stringify({ scope: "project", workspace: "D:/x/demo", title: "测试记忆条目", content: "sidecar 写入验证" }) });
assert(j.body.ok, "POST /entry");

j = await call("/state");
assert(j.body.entries.length === 1 && j.body.entries[0].workspace === "D:/x/demo", "state 可见新条目");
assert(j.body.workspaces.includes("D:/x/demo"), "workspaces 列表");

j = await call(`/entry?id=${encodeURIComponent("project|D--x-demo|测试记忆条目.md")}`);
assert(j.body.content.includes("sidecar 写入验证"), "GET /entry 正文");

j = await call("/config", { method: "POST", body: JSON.stringify({ autoSave: false }) });
assert(j.body.config.autoSave === false && j.body.config.enabled === true, "PATCH /config 合并语义");

let bad = await fetch(base + "/state");
assert(bad.status === 401, "无 token 401");

bad = await call("/entry?id=" + encodeURIComponent("user|..|../../evil.md"));
assert(bad.status === 400, "路径穿越 400");

j = await call("/delete", { method: "POST", body: JSON.stringify({ id: "project|D--x-demo|测试记忆条目.md" }) });
assert(j.body.ok, "POST /delete");

j = await call("/state");
assert(j.body.entries.length === 0, "删除后 state 为空");

// 编辑：新增 → 改标题和内容 → 校验（先清空回收站——前段的删除在新语义下也会进站）
await call("/purge", { method: "POST", body: "{}" });
j = await call("/entry", { method: "POST", body: JSON.stringify({ scope: "user", title: "编辑前", content: "v1 内容", origin: "auto", type: "偏好" }) });
const editId = j.body.id;
j = await call("/update", { method: "POST", body: JSON.stringify({ id: editId, title: "编辑后", content: "v2 内容", type: "偏好", evidence: "用户偏好验证" }) });
assert(j.body.ok && j.body.file.includes("编辑后"), "POST /update 改名");
j = await call(`/entry?id=${encodeURIComponent(j.body.id)}`);
assert(j.body.content === "v2 内容", "编辑后正文");
j = await call("/state");
const edited = j.body.entries.find((e) => e.title === "编辑后");
assert(edited && edited.origin === "auto" && edited.status === "probation", "自动条目编辑保留 origin+probation");

// 回收站流：删除（user 原因）→ trash 可见 → 恢复 → 转正 + 负反馈记录
await call("/delete", { method: "POST", body: JSON.stringify({ id: edited.id }) });
j = await call("/state");
assert(j.body.trash.length === 1 && j.body.trash[0].trashReason === "user", "删除进回收站(user)");
assert(j.body.rejected.length === 1 && j.body.rejected[0].title === "编辑后", "自动条目删除记负反馈");
j = await call("/restore", { method: "POST", body: JSON.stringify({ id: j.body.trash[0].id }) });
assert(j.body.ok, "POST /restore");
j = await call("/state");
const back = j.body.entries.find((e) => e.title === "编辑后");
assert(back && back.status === "active", "恢复即转正");
assert(j.body.trash.length === 0, "回收站已清空");
await call("/delete", { method: "POST", body: JSON.stringify({ id: back.id }) });
await call("/purge", { method: "POST", body: "{}" });
j = await call("/state");
assert(j.body.entries.length === 0 && j.body.trash.length === 0, "编辑测试清理干净");

await call("/touch", { method: "POST", body: JSON.stringify({ workspace: "D:/x/demo" }) });
j = await call("/state");
assert(j.body.lastWorkspace === "D:/x/demo", "POST /touch");

await call("/shutdown", { method: "POST" });
await sleep(800);
let dead = true;
try { await fetch(base + "/ping", { signal: AbortSignal.timeout(600) }); dead = false; } catch {}
assert(dead, "shutdown 后端口关闭");

console.log("--- sidecar e2e 全部通过 ---");
process.exit(0);
