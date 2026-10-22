# 已发布普通页的确认撤回

普通单页准备现在可在读不到可公开记录时，调用 `preparePublishedWithdrawal(options)` 核查原来已发布的记录。它只处理普通来源；课程与学习笔记仍由领域引擎准备完整依赖变更，不把一个旧祖先直接当作普通页删除。

先取得同 publicationRevision／configDigest／schemaDigest 的独立 reader 私有投影，核对页 ID、sourceKey、kind 与媒体归属。当前来源仍须匹配配置摘要，直接 data source 还要验证其当前 schema。中央 deny／名单改变交政策流程，不伪装成源端删除。

只有当前完整页对象明确显示归档／回收站，或直属记录已物理移到另一 data source、page、block 或 workspace，才提供 archived／out-of-scope。当前页连续两次读取的身份、编辑时间、父级和归档标志一致，才构造撤回。期间恢复或移动则延迟重试；查不到、权限错误、活跃页及不能区分多来源的 legacy database parent 都不提供删除证明。显式允许的普通 page 移动父级不改变其配置身份。

`createSinglePagePreparationPort` 只在 SOURCE_SCOPE_UNKNOWN 时走这个分支；reader 没有原记录时保留待核。确认后仅构造一个 withdrawal，upserts／media 为空，不读取该页正文、下载或编码图片。成功仍经服务器版本 CAS、独立 reader 验证和领域检查点／队列确认。永久删除可信事件、政策重配及非学习入链改写属于主运行器／领域接线，不能以本 helper 冒充整套撤回完成。

本地 PGlite 使用实际增量 SQL 和独立角色，验证归档目标页后当前发布列表减一、目标不可读、另一页内容保持、正文读数为零。其他合成验证覆盖证据／版本／范围、取消、未知和确认期间变化。没有真实源或云库操作。
