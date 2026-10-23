# 2026-10-23：搜索结果来源行并入 develop（Claude）

编辑登记：Claude 在合并请求 #25 的分支上合入最新 develop，并修改 `scripts/check-website-protocol.ts`（恢复为 develop 原样）、`tests/capture-release-compatibility.test.ts`、`tests/search-context.test.ts`、`docs/REQUIREMENTS.md`（解冲突）、`docs/SEARCH_RESULT_CONTEXT.md`。来源行的实现、契约字段、fixtures 与数据库迁移沿用 Codex 在 #25 的提交，本轮没有改动；数据库迁移未安装，`DATABASE_SEARCH_CONTEXT` 保持默认关闭。

## 为什么要改

#25 最后一次同步 develop 之后，develop 合入了同步恢复能力（#22）。#22 在 `tests/helpers/recovery-runtime-sources.ts` 里钉住了已审恢复候选的五个运行文件，其中包括 `scripts/check-website-protocol.ts`。#25 在这个脚本里加了新迁移的摘要核对，文件字节随之改变，合在一起后六项测试失败（`capture-release-compatibility` 一项、`capture-recovery-historical` 五项）。直接改钉住的摘要，等于宣布新的恢复候选已审，那是后端的审核关口；用户选择保持该脚本不变，把核对移到测试里。

## 改了什么

- `scripts/check-website-protocol.ts` 恢复为 develop 的字节，重新与恢复候选一致。
- `tests/capture-release-compatibility.test.ts`：去掉 #25 为该脚本加的“较新协议检查器”分支和摘要；Notion 与数据库读取文件的新摘要保留。这个脚本回到由恢复候选的钉住规则判断。
- `tests/search-context.test.ts`：新增一项，核对 `database/search-context-protocol.json` 的能力名、迁移文件名与 SHA-256，报错文字与原协议脚本一致。
- `docs/SEARCH_RESULT_CONTEXT.md` 写明摘要在哪里核对、为什么不放进协议脚本。
- `docs/REQUIREMENTS.md` 冲突：保留“搜索上下文”段，“生产仓库接续”取 develop 已完成的版本，相同的“搜索恢复”段只留一份。

不同之处：协议脚本 `npm run website:protocol` 不再打印搜索上下文那一行；`npm run check` 仍会经由测试核对它。以后真正安装这份迁移时，安装流程要自己核对清单摘要，不能只靠协议脚本。

## 怎么验证的

本机 Node 26.11.1、演示数据。

- 新测试：正常通过；把清单摘要临时改坏后失败，报 “Search context extension differs from its manifest.”，清单已复原。
- `npm run check`、`npm run privacy:check`、`npm run build`：结果见合并请求。
- 浏览器（合入 develop 后、本轮改测试之前的同一份应用代码，本轮没有改应用与样式）：`next start` 演示数据，搜索页与快捷搜索搜 “Introduction”，墨水／苹果／岛屿的浅色与深色及千禧，1440／390／320：三条同名笔记各显示不同的“课程 › 父级”，无横向溢出、来源行不截断，长路径换行；读屏名称包含课程与父级；键盘下移两次回车进入该条自己的地址；没有来源行的结果保持紧凑一行；控制台无错误。#12 的换词回车保护与 #19 的手动重试、空结果操作仍在。

## 限制与下一项

- 只在演示数据下看过；正式站点读数据库且开关关闭，合并发布后不会出现来源行。读屏名称改为“类型，标题（，课程，父级）”、快捷搜索每行最低 44 像素这两处会随发布生效。
- 真实安装迁移、打开开关与性能验收另行授权，由数据库负责人执行。
- 快捷搜索换词时列表先收起再展开（#12 带来）、搜索页空结果操作的位置与缩进（#19），这两处小问题留待用户决定是否调整。
