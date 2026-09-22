# auto-memory — Kimi Code Desktop 持久记忆

给 Kimi Code Desktop 加上**跨会话持久记忆**，并在**设置页注入「记忆」管理面板**。

设置页左侧导航多出一个「记忆」项（手绘的大脑线稿图标，与原生单色描边图标同风格），点开是管理面板：

```
┌───────────────────────────────┐
│ 记忆 · 服务正常                 │
│ 记忆功能      [开关]            │
│ 自动沉淀      [开关]            │
│ 全局/项目/本机 [三档 scope 开关]  │
│ 记忆条目 · 2 [搜索][级别|来源筛选]  │
│ ● 全局·手动 commit… [查看|编辑|删除] │
│ ● 项目 usage-union   …   [查看|删除]│
└───────────────────────────────┘
```

## 组成

| 部分 | 说明 |
| --- | --- |
| 记忆引擎 | 会话启动（SessionStart hook）把记忆索引注入上下文；`system-prompt.md`（内联于 kimi.plugin.json 的 systemPrompt 字段）定义写入合同（什么值得记/先查重再落盘/绝不记密钥）；`/auto-memory:remember` 与 `/auto-memory:memory` 命令手动存取 |
| 存储层 | `~/.kimi-code/memory/`：`config.json` + 三层 scope（`user/`、`project/<工作区key>/`、`local/<工作区key>/`），索引行格式 `- [标题](文件.md) — 钩子`（正文在主题文件，索引只存指针，每级 6000 字符预算、注入时截断） |
| 管理面板 | 注入设置页的「记忆」tab + 覆盖层面板：总开关、自动沉淀、三档 scope 开关、条目搜索/查看/删除/手动新增、试用条目一键转正 |
| sidecar | 本地服务（127.0.0.1 + token，`scripts/sidecar.mjs`），面板经它读写记忆目录；hook 拉起、旧版本自愈退出 |
| CLI | `scripts/memory-cli.mjs`：AI/命令行的受控操作通道（`list/show/add/forget/move/promote/restore/reindex`），走与面板同一套存储层校验 |

## 安装

同 usage-union：设置 → 插件 → 安装自定义插件，填仓库地址；或本地目录（要求根目录有 `kimi.plugin.json`）。安装后**重启 Kimi Code Desktop** 或刷新视图生效。

注意：`app://` 协议有缓存。插件更新后新脚本要在**下次会话启动（hook 自动重注入）+ 重启应用**后才生效——这与 usage-union 的行为一致。

## 生命周期（自动沉淀的质量机制）

自动沉淀不是写入即永久，而是带反馈闭环的分层信任：

| 层 | 触发 | 行为 |
|---|---|---|
| L0 | 用户明示"记住 X" | 立即写，永久生效 |
| L1 | 用户纠正 AI | 立即写（evidence=纠正原话），永久生效 |
| L2 | AI 有用户原话可引 | 写入（必填 type + evidence），**试用**：注入满 3 次转正；14 天未转正进回收站 |
| L3 | AI 纯推断无证据 | 不写（至多口头问一句） |

机械保障（不依赖 AI 自觉）：缺 type/evidence 的自动条目在下次会话启动时被 sweep 直接下架进回收站；删除自动条目会记入负反馈清单，下次会话注入给 AI（同类内容仅在证据充分时才写）；回收站可恢复（恢复即转正），滞留超 90 天自动清理；AI 的删除/迁移/转正操作统一走 `scripts/memory-cli.mjs`（与面板同一套存储层校验，避免手改文件丢字段、漏记负反馈）。每次会话启动的维护结果（转正/过期/下架/计数）在面板注入预览行可见。

## 自动更新（v0.4.0）

会话启动 hook 在全部职责完成后做一次**限频 24h** 的自更新检查：只走
`codeload.github.com`（国内直连可达，与引擎安装插件同一通道，零依赖纯 Node 解包），
发现默认分支版本更新就把插件目录原子替换（失败自动回滚），**下一会话自动生效**；
面板标题栏会显示"已更新到 vX（重启会话生效）"。

- 开发副本（目录含 `.git`）永不自更新，避免覆盖本地改动
- 立即检查：`node scripts/auto-patch.mjs --check-update`
- 关闭检查：`--no-update` 参数或 `AUTO_MEMORY_NO_UPDATE=1` 环境变量

## 使用

- 设置 → 🧠记忆：管理所有开关与条目（下次会话生效的项有标注）
- 对话里说"记住：这个项目用 pnpm"→ AI 按 `remember` 命令规则落盘
- `/auto-memory:memory list|search|forget` 命令行式管理
- 手动管理（终端）：

```bash
node scripts/memory-cli.mjs list                  # 列出全部条目
node scripts/memory-cli.mjs add "标题" --scope project --content "…"   # 新增
node scripts/memory-cli.mjs forget "标题"         # 删除（进回收站 + 自动条目记负反馈）
node scripts/memory-cli.mjs move "标题" user      # 纠正级别
node scripts/memory-cli.mjs promote "标题"        # 试用条目转正
node scripts/memory-cli.mjs reindex               # 重建索引（回收孤儿文件）
```

- 手动模式：`node scripts/auto-patch.mjs --status|--force|--uninstall`

## 验证（本仓库自带）

```bash
node test/sidecar-e2e.mjs   # sidecar API 全链路（14 项断言）
node test/cdp-drive.mjs     # 需桌面端以 --remote-debugging-port=9226 启动：
                            # tab 注入/面板渲染/收起行为 + 截图
node test/cdp-interact.mjs  # 开关/查看/新增/删除交互（同样要求 9226）
```

## 踩坑记录（Windows）

- **安全软件对删除非 ASCII 文件名拦截不稳定**（静默失败甚至终止 node 进程）：删除一律先 `renameSync` 成纯 ASCII 临时名再删；列表与注入永远以索引为准，孤儿文件无害。
- **`app://` 协议缓存**：改注入脚本必须升版本号（hook 依赖版本标记重写），并重启应用/忽略缓存刷新才能生效。
- **Vue scoped CSS**：往设置页 tab 列表插节点，除了克隆 class 还要带上 `data-v-*` 属性，样式才会跟随主题。
- **SVG 图标必须用 createElementNS 创建**：document.createElement('svg') 造出来的是 HTMLUnknownElement，宽高为 0、不渲染。原生 tab 图标实测为 16px、stroke-width 1.8。
- **不要手动改原生 tab 选中态**：Vue vdom 不知道外部 DOM 改动，会让原生 tab 的点击变成无操作。面板打开期间用 document 捕获阶段点击来收面板。

## 卸载

```bash
node scripts/auto-patch.mjs --uninstall   # 还原 desktop-dist 并停掉 sidecar
```

记忆数据在 `~/.kimi-code/memory/`，卸载插件不会删除它，可自行备份/清除。
