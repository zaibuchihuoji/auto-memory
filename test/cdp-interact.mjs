/** 交互测试：开关切换 → 查看正文 → 新增 → 删除 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const DEBUG_PORT = 9226;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
const page = list.filter((t) => t.type === "page").find((t) => /\/sessions\//.test(t.url ?? ""));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => pending.set(id, (msg) => (msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)))); };
const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
const assert = (c, m) => { if (!c) { console.error("FAIL: " + m); process.exit(1); } console.log("ok: " + m); };

// 打开面板
await evalJs(`document.querySelector('.side-footer-settings')?.click()`);
await sleep(1500);
await evalJs(`document.querySelector('.settings-tab-list .am-tab')?.click()`);
await sleep(2200);

// 1. 关掉"自动沉淀"开关 → config 应变
await evalJs(`(() => {
  const rows = [...document.querySelectorAll('.am-row')];
  const row = rows.find(r => r.querySelector('b')?.textContent === '自动沉淀');
  row.querySelector('.am-switch input').click();
  return true;
})()`);
await sleep(1800);
let st = await evalJs(`(async () => {
  const cfg = await (await fetch('/assets/auto-memory.config.json?t=' + Date.now())).json();
  const s = await (await fetch('http://127.0.0.1:' + cfg.port + '/state', { headers: { Authorization: 'Bearer ' + cfg.token } })).json();
  return s.config;
})()`);
assert(st.autoSave === false, "开关切换落盘 autoSave=false");

// 切回来
await evalJs(`(() => {
  const rows = [...document.querySelectorAll('.am-row')];
  const row = rows.find(r => r.querySelector('b')?.textContent === '自动沉淀');
  row.querySelector('.am-switch input').click();
  return true;
})()`);
await sleep(1500);

// 2. 查看正文
await evalJs(`(() => {
  const card = [...document.querySelectorAll('.am-entry')][0];
  const btn = [...card.querySelectorAll('button')].find(b => b.textContent === '查看');
  btn.click();
  return true;
})()`);
await sleep(1200);
const viewText = await evalJs(`document.querySelector('.am-view')?.textContent?.slice(0, 50) ?? null`);
assert(viewText && viewText.includes("commit"), "查看正文加载: " + viewText?.slice(0, 20));

// 3. 新增条目（本机 scope，选工作区）
await evalJs(`(() => {
  const btn = [...document.querySelectorAll('.am-toolbar button')].find(b => b.textContent.includes('新增'));
  btn.click();
  return true;
})()`);
await sleep(600);
await evalJs(`(() => {
  const form = document.querySelector('.am-add');
  const segBtns = [...form.querySelectorAll('.am-seg button')];
  segBtns.find(b => b.textContent === '本机').click();
  const ws2 = form.querySelector('select');
  if (ws2.options.length) ws2.selectedIndex = 0;
  return { segOn: segBtns.find(b => b.classList.contains('on'))?.textContent };
})()`);
await evalJs(`(() => {
  const form = document.querySelector('.am-add');
  form.querySelector('input[type=text]').value = '交互测试条目';
  form.querySelector('textarea').value = '这条由 CDP 交互测试创建，应可被删除';
  return true;
})()`);
await evalJs(`(() => {
  const form = document.querySelector('.am-add');
  const save = [...form.querySelectorAll('button')].find(b => b.textContent.includes('保存'));
  save.click();
  return true;
})()`);
await sleep(1800);
st = await evalJs(`(async () => {
  const cfg = await (await fetch('/assets/auto-memory.config.json?t=' + Date.now())).json();
  return (await (await fetch('http://127.0.0.1:' + cfg.port + '/state', { headers: { Authorization: 'Bearer ' + cfg.token } })).json());
})()`);
const added = st.entries.find((e) => e.title === "交互测试条目");
assert(added && added.scope === "local", "新增 local 条目");

// 4. 删除它（confirm 对话框要拦掉），并顺手验证来源徽章
await evalJs(`window.confirm = () => true; true`);
const badges = await evalJs(`(() => {
  const card = [...document.querySelectorAll('.am-entry')].find(c => c.textContent.includes('交互测试条目'));
  return card ? [...card.querySelectorAll('.am-badge')].map(b => b.textContent) : null;
})()`);
assert(badges && badges.includes("本机") && badges.includes("手动"), "新条目徽章: " + JSON.stringify(badges));
await evalJs(`(() => {
  const card = [...document.querySelectorAll('.am-entry')].find(c => c.textContent.includes('交互测试条目'));
  const btn = [...card.querySelectorAll('button')].find(b => b.textContent === '删除');
  btn.click();
  return true;
})()`);
await sleep(1800);
st = await evalJs(`(async () => {
  const cfg = await (await fetch('/assets/auto-memory.config.json?t=' + Date.now())).json();
  return (await (await fetch('http://127.0.0.1:' + cfg.port + '/state', { headers: { Authorization: 'Bearer ' + cfg.token } })).json());
})()`);
assert(!st.entries.some((e) => e.title === "交互测试条目"), "删除生效");
assert(st.entries.length === 2, "剩余 2 条种子数据");

// 5. 编辑：改第一条种子标题 → 校验 → 改回
await evalJs(`(() => {
  const card = [...document.querySelectorAll('.am-entry')][0];
  const btn = [...card.querySelectorAll('button')].find(b => b.textContent === '编辑');
  btn.click();
  return true;
})()`);
await sleep(1500);
const editHint = await evalJs(`document.querySelector('.am-add .am-inject b')?.textContent ?? null`);
assert(editHint && editHint.includes("正在编辑"), "编辑表单预填提示: " + editHint);
await evalJs(`(() => {
  const form = document.querySelector('.am-add');
  form.querySelector('input[type=text]').value = 'commit 信息用中文（已编辑）';
  return true;
})()`);
await evalJs(`(() => {
  const form = document.querySelector('.am-add');
  const save = [...form.querySelectorAll('button')].find(b => b.textContent.includes('保存修改'));
  save.click();
  return true;
})()`);
await sleep(1800);
st = await evalJs(`(async () => {
  const cfg = await (await fetch('/assets/auto-memory.config.json?t=' + Date.now())).json();
  return (await (await fetch('http://127.0.0.1:' + cfg.port + '/state', { headers: { Authorization: 'Bearer ' + cfg.token } })).json());
})()`);
const edited = st.entries.find((e) => e.title === "commit 信息用中文（已编辑）");
assert(edited, "编辑落盘（标题已改）");
// 改回原标题
await evalJs(`(() => {
  const card = [...document.querySelectorAll('.am-entry')][0];
  const btn = [...card.querySelectorAll('button')].find(b => b.textContent === '编辑');
  btn.click();
  return true;
})()`);
await sleep(1500);
await evalJs(`(() => {
  const form = document.querySelector('.am-add');
  form.querySelector('input[type=text]').value = 'commit 信息用中文';
  [...form.querySelectorAll('button')].find(b => b.textContent.includes('保存修改')).click();
  return true;
})()`);
await sleep(1800);
st = await evalJs(`(async () => {
  const cfg = await (await fetch('/assets/auto-memory.config.json?t=' + Date.now())).json();
  return (await (await fetch('http://127.0.0.1:' + cfg.port + '/state', { headers: { Authorization: 'Bearer ' + cfg.token } })).json());
})()`);
assert(st.entries.some((e) => e.title === "commit 信息用中文"), "改回原标题");

console.log("--- 交互测试全部通过 ---");
process.exit(0);
