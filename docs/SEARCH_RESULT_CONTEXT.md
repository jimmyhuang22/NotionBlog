# 搜索结果来源行

用户已选定来源行，并批准兼容的最小搜索显示字段。`SearchHit.context?: { courseLabel: string; parentLabels: string[] } | null` 仅传可公开文字；旧响应缺字段继续工作。搜索页和快捷搜索共用同一呈现与链接名称，保留原阅读地址、关键词保护、输入法和手动恢复。

## 数据来源与限制

- 课程编号优先，缺失时用实际课程名；拒绝原课程 ID 兜底。父级由当前获准物理关系解析，按根到直属父级排序，不使用 URL、摘要或已存面包屑推测。
- 只给学习笔记补字段。没有可证明的课程、缺失／跨课／循环父链、未知或超限文字时为 null；不截断父链。不显示当前标题或学习总入口，直属笔记的父级数组为空。
- 最多 32 个父级，每标签最多 256 字符，全部标签合计最多 4,096 字符。公开文字沿用 Notion／临时媒体 URL 清理。新增显示字段不参与匹配和排序；版本／游标会随上下文或投影模式改变。
- Mock 用虚构的同名、跨课及不同父级样本。Notion 在同一读取操作中复用已资格核对的课程与祖先元数据，不额外逐篇取正文；它仍受 Notion 非事务式读取的原有限制，不承诺跨远端操作的原子快照。
- 栏目关闭继续生效；课程关闭时搜索结果不显示课程及父级。provider 失败不回退 mock。

## 数据库独立扩展

[`search-context-protocol.json`](../database/search-context-protocol.json) 固定新迁移摘要，由 `tests/search-context.test.ts` 随 `npm run check` 核对（不写进 `scripts/check-website-protocol.ts`：那个脚本属于已审的同步恢复运行文件，须保持逐字节不变）；迁移由 Supabase CLI 创建，既有冻结 SQL 与 schema digest 不变。代码默认 `DATABASE_SEARCH_CONTEXT=off`，未安装迁移的旧 reader 继续原响应。`on` 只允许 database v2；本项没有安装真实库或修改任何云端变量。

支持 qualified／published，各自支持 legacy、scoped on-demand／filtered／precomputed。可选 filtered／precomputed 仍须它们原来的独立安装与显式配置；上下文不会启用搜索优化。Legacy 启用上下文也需要基础 scoped reader 的 `nb_read.assert_pin` 能力，不能只安装本迁移而假定足够。

对实际返回的一页学习笔记额外发起一次元数据批量 SQL：最多 50 个不同 ID，响应最多 256 KiB；无笔记结果不请求该批。原搜索读取、匹配和末尾版本复核保留，不新增逐结果正文读取。数据库按同一 run／revision、当前来源资格、课程和祖先撤回复核，显式启用后缺迁移、摘要不匹配、权限失败、混合版本或缺失已请求行都返回错误。合法未知标签可为 null，两者不混用。

只有受限 `nb_reader` 可执行固定 reader 函数；内部 state 表启用 RLS 且不授予 reader／writer／公开角色访问。函数固定 `search_path=pg_catalog`，撤销 PUBLIC 及常见 API 角色的执行权。没有对内容表增加外键、派生行、生成、填充或常驻任务。

## 未来安装与验收

安装与启用须由用户另行授权，并由既有数据库负责人核对最终提交、新迁移文件 SHA、当前库身份、所有者、受限 reader 继承及已安装基础能力。不得将本轮本机角色模型写成真实权限已验收。先在独立事务安装并由所有者向 `nb_search_context.state.migration_digest` 登记已审文件 SHA，再以受限 reader 在原实际 publication／search 模式中核对资格、版本、返回大小和请求成本；不用真实正文作公开测试样本。无填充阶段，不改原 producer、同步／清理或来源调度。

确认安装与只读结果后，才可明确配置 `DATABASE_SEARCH_CONTEXT=on` 并走单独发布流程。配置变化不自动改变已有部署。回退使用关闭该开关的受检版本，保留扩展以免影响在途旧部署；本项不自动 DROP、重装或重试真实操作。现阶段只有离线 PGlite、Mock、Notion stub 和本地浏览器证据，不能声称云端已启用或生产性能已通过。
