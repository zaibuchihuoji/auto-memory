/**
 * CDP 驱动：连接 Kimi Code Desktop（--remote-debugging-port=9222），
 * 打开设置 → 验证"记忆"tab 注入 → 点击 → 验证面板渲染 → 截图。
 * 用法：node test/cdp-drive.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEBUG_PORT = 9226;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const pages = list.filter((t) => t.type === "page");
      const main = pages.find((t) => /\/sessions\//.test(t.url ?? ""))
        ?? pages.find((t) => !/browser-overlay|devtools/.test(t.url ?? ""));
      if (main) return main;
    } catch {}
    await sleep(1000);
  }
  throw new Error("未找到桌面端页面 target");
}

const page = await findPage();
console.log("page:", page.url.slice(0, 60), page.title ?? "");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error("ws 连接失败")); });

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    pending.set(id, (msg) => (msg.error ? rej(new Error(method + ": " + JSON.stringify(msg.error))) : res(msg.result)));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(method + " timeout")); } }, 15000);
  });
}
async function evalJs(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("eval 异常: " + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result?.value;
}
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(HERE, name), Buffer.from(r.data, "base64"));
  console.log("截图:", name);
}

await send("Runtime.enable");
await send("Page.enable");
await sleep(4000); // 等 SPA 渲染

// 1. 打开设置
const gear = await evalJs(`(() => {
  const b = document.querySelector('.side-footer-settings');
  if (!b) return 'no-gear';
  b.click();
  return 'clicked';
})()`);
console.log("设置按钮:", gear);
if (gear !== "clicked") throw new Error("找不到设置齿轮");
await sleep(2000);

// 2. 检查 tab 注入（1.5s 轮询周期，多等几轮）
let tabs = null, ours = false;
for (let i = 0; i < 6; i++) {
  const st = await evalJs(`(() => {
    const list = document.querySelector('.settings-tab-list');
    return list ? { total: list.querySelectorAll('button').length, ours: !!list.querySelector('.am-tab'),
      texts: [...list.querySelectorAll('button')].map(b => b.textContent.trim()) } : null;
  })()`);
  if (st) { tabs = st; ours = st.ours; break; }
  await sleep(1500);
}
console.log("tabs:", JSON.stringify(tabs));
if (!tabs) throw new Error("设置 tab 列表没出现");
if (!ours) throw new Error("“记忆”tab 未注入");

// 3. 点击"记忆"tab
await evalJs(`document.querySelector('.settings-tab-list .am-tab').click()`);
await sleep(2500); // 面板打开 + /state 拉取

const panel = await evalJs(`(() => {
  const bd = document.querySelector('.am-backdrop');
  if (!bd) return { open: false };
  const entries = [...bd.querySelectorAll('.am-entry .am-e-title')].map(e => e.textContent);
  const toggles = [...bd.querySelectorAll('.am-row b')].map(e => e.textContent);
  return { open: true, title: bd.querySelector('h3')?.textContent, status: bd.querySelector('.am-status')?.textContent,
    toggles, entryTitles: entries, groups: [...bd.querySelectorAll('.am-group-h')].map(e => e.textContent) };
})()`);
console.log("面板:", JSON.stringify(panel, null, 2));
await shot("panel-screenshot.png");

// 4. 收起：点一个当前未激活的原生 tab，面板应自动关闭
await evalJs(`(() => {
  const btns = [...document.querySelectorAll('.settings-tab-list button')].filter(b => !b.classList.contains('am-tab'));
  const target = btns.find(b => !b.classList.contains('on')) ?? btns[0];
  target?.click();
  return target?.textContent.trim() ?? 'none';
})()`);
await sleep(800);
const closed = await evalJs(`!document.querySelector('.am-backdrop')`);
console.log("点原生 tab 后面板自动收起:", closed);

console.log("--- CDP 驱动完成 ---");
process.exit(0);
