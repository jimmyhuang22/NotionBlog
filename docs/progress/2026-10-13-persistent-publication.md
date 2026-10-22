# 2026-10-13：独立持久发布基础（Codex）

## 编辑登记

分支 `codex/persistent-publication` 从完成旧请求整合的 develop `b49ca0c` 创建。修改独立发布 SQL／摘要、新 server helper、网站 runtime、标准 CLI、Mac mini 固定入口与对应测试／本项文档；不修改契约、fixtures、前端页面或归档 PROGRESS／DECISIONS。

## 变更

新增 `nb_publication` 指针与受限 API；首次激活需当前完整、新鲜、符合政策的批次，安装不激活或复活历史内容。新 writer 把原 promotion 与显式激活放在同一服务器事务中，失败不破坏上一发布。新 reader 使用同一 DTO 和内容服务，取消新模式的展示过期判断，保留当前政策、中央 deny 与祖先过滤。

`DATABASE_PUBLICATION_MODE`／`SYNC_PUBLICATION_MODE` 默认 qualified。published 要求 v2 和独立 storage 媒体。Mac mini 固定入口明确传递选项，拒绝不支持的新模式 release／旧 child 回执，并按所选模式回读服务器。增加仅供迁移 owner 使用的 `migrate-publication`，加入协议摘要检查；未运行云迁移或任何真实同步。

## 验证

Node 24 下 `npm run check` 通过：1309 项测试、类型、冻结／扩展协议和 560 文件隐私检查；`npm run build` 通过，40 个服务端 trace 排除私有输入。完整检查后补充固定入口默认兼容守卫，再通过 typecheck 与 9 项固定入口测试，确保共享旧 v1 的 storage 选项不会改变 qualified host 的混合媒体行为。

受影响的 PGlite 与固定入口测试覆盖实际存储媒体、同步到期后独立内容可读、旧模式拒绝、权限最小化、中央及读取中撤回、策略变更拒绝、幂等发布、不完整批次保留上一版、激活失败原子回滚、新入口选项及旧 child 拒绝。另用主工作区私有 blocklist 核对本项 19 个修改文件，无真实值匹配。所有验证使用演示数据或本机构建，没有联网采集 Notion、下载真实媒体或访问云数据库。

## 限制与下一项

这是重构第一阶段的发布基础，没有线上启用。当前仍为完整采集，独立小图／CDN、页级变化队列、源端撤回处理器及新发布元数据备份尚待实现；不能用本阶段证明慢图问题已经解决。后续复用已核验原件和小图，按必要范围联调，完成图片读取后再由用户发布 main。详见 [发布模式](../CONTENT_PUBLICATION.md)。
