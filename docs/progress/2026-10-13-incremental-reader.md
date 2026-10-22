# 2026-10-13：单页已发布读取与独立提交确认（Codex）

## 编辑登记

从 develop `3464cf2` 开 `codex/incremental-reader`，验证前纳入已合学习分支 `94171ac`。新增独立 SQL／manifest、私有 reader、owner 安装入口和相关测试／说明；修正 publisher 对确定拒绝的分类。不修改公共队列／源准备支线的工作树、学习引擎、图片配方、DTO、fixtures、前端、旧存档、线上 release 或 Dagu。

## 变更

单页返回上一已发布的原证据和媒体，仅供后台比较，避免每次拉取全库正文。操作回读核验当前版本、变化记录／撤回和引用，用独立 reader 真正确认提交；不伪造 writer 的 readerVerified。后续发布、中央 deny、内容或版本不匹配不自动确认。

PostgreSQL 的已知明确 scope／媒体／完整性拒绝归入输入错误；只有 P0001 被识别，带同样文本的丢响应仍保持未知。公共 executor 需识别 DELTA_DEPENDENCY_MISSING 转复核，不能把 lookup null 当作未提交。

## 验证

Node 24 `npm run check` 通过：1340 项测试、类型、冻结与扩展协议、578 文件隐私检查；`npm run build` 通过，40 个服务端 trace 排除私有输入。16 项 reader／publisher PGlite 关联测试覆盖实际权限、过期 qualified、单页证据重用、丢回执恢复、篡改正文不确认、版本替代、撤回与祖先 deny。验证过程中修正了测试查询结果缺失的 TypeScript 类型标注，最终完整检查包含该修正。

## 边界与下一项

仅 develop 工程准备，未应用云迁移、激活发布／provider、改来源、安装新运行器或排程，没有真实 Notion 或图片传输。严格同一版本确认，旧操作已被替代时仍需恢复策略。下一步把实际 reader 接公共内容准备／队列执行器，再接学习 checkpoint、变化发现和独立媒体；持久发布／操作账本备份恢复与阻断 Notion 的验收仍需补齐。
