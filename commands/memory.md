---
name: memory
description: 查看和管理持久记忆（列表/搜索/审查/删除/恢复/迁移/开关）
---

管理用户的持久记忆。参数：$ARGUMENTS

按参数执行：

- **无参数或 `list`**：读取 `~/.kimi-code/memory/` 下所有 `MEMORY.md` 索引，按 全局 / 项目 / 本机 分组列出全部条目。每条标注：级别、来源（frontmatter `origin`：auto=自动沉淀 / manual=手动）、状态（`status`：probation=试用中〔注入 N/3〕/ active=已转正）、类型、所属项目、更新时间，并给出总数。
- **`search <关键词>`**：在所有索引与主题文件中检索，列出命中条目、所在文件与级别。
- **`show <标题或文件名>`**：Read 对应主题文件，展示完整内容（含级别、来源、状态、证据）。
- **`review`**：列出 `status: probation` 的试用条目和最近 7 天 `origin: auto` 的自动沉淀（这些最容易混入垃圾），逐条问用户保留还是删除；用户说删的立即执行，绝不批量自作主张。
- **`forget <标题或文件名>`**：运行 `node <插件目录>/scripts/memory-cli.mjs forget "<标题>"`（插件目录：`KIMI_PLUGIN_ROOT` 环境变量，否则 `~/.kimi-code/plugins/managed/auto-memory/`）。CLI 会进回收站、自动条目记负反馈。不要直接手删文件。
- **`restore <标题>`**：运行 `…/memory-cli.mjs restore "<标题>"`（恢复即转正）。列出回收站可用 `trash`。
- **`trash`**：列出回收站全部条目（含下架原因：violation=格式不合格 / expired=试用过期 / user=用户删除）。
- **`move <标题或文件名> <user|project|local>`**：运行 `…/memory-cli.mjs move "<标题>" <级别> --workspace <当前工作区>`（字段保留、索引两端同步）。不要手搬文件。
- **索引与文件不一致（有条目文件但不在列表/索引里有死行）**：运行 `…/memory-cli.mjs reindex` 重建。
- **`on` / `off`**：改写 `~/.kimi-code/memory/config.json` 的 `enabled`（告知"下次会话生效"）；也可提示用户在 设置 → 记忆 面板操作。
- **`scope <user|project|local> <on|off>`**：改写 config.json 里 `scopes` 对应字段。

存储结构：`user/MEMORY.md` + `user/<slug>.md`；`project/<key>/`、`local/<key>/` 同理（key = 工作区绝对路径中非 `[a-zA-Z0-9_-]` 字符替换为 `-`）。索引行格式 `- [标题](文件.md) — 钩子`。生命周期：自动沉淀 → probation；注入满 3 次或用户恢复 → active；14 天未转正 → 回收站（可恢复）。
