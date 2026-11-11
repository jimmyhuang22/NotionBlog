# 2026-11-11：学习树邻接表线性构造（Codex）

## 编辑登记

- 用户批准先实施树的 Map + push，保留原实现离线比较，确认撤回、移动、恢复不变后合入 develop；不发布。列表下推仅继续权限/排序验证，Supabase 实例复用暂缓。
- 从最新 develop `ec3ef10fda7e7d52c49955985a392f3bb5703abf` 开 `codex/study-tree-adjacency-20261111`；开始时无未合并的 develop → main 发布请求。
- 本项只改 `src/server/notion/study-incremental.ts` 的两处邻接表构造，并增加基线、等价回归及离线比较入口。没有引入操作内索引缓存、序列化缓存或 dirty set；父链、撤回证据、冻结与完整正文规范化继续使用原流程。
- 本工作树已有上一轮未提交的方案报告；本次树修复 PR 不夹带列表/Supabase 产品实现。私人运行配置缺失，不假定掌握现役 worker 包版本。

## 修改与接口

- `prepareStudyDelta` 与 `applyStudyDelta` 使用每父节点独立数组，按原 Map 遍历顺序 push。构造由 O(N + Σdegree²) 改为 O(N)，仍在原调用位置重新构造。
- 无内容 DTO、检查点格式、读写接口、数据库迁移、依赖、公开来源或运行配置变化。该文件是同步 writer 的依赖；没有把它误当 reader-only，也没有放宽旧 capture/release 的可执行文件兼容校验。
- 原实现保留在测试基线中；原始对照、日志另存忽略目录 `.local/study-tree-adjacency-20261111/`。更早方案实验保留在 `.local/backend-remaining-options-20261111/tree/`。

## 验证

- 原实现从 `ec3ef10` 冻结在 `tests/helpers/study-incremental-baseline.ts`，除重定位 import 外与原文件逐字一致；原文件 SHA-256 为 `7ff670a793516baa7045aa54a81180ba07e29a1f294ee9da871f1f3715e3b18d`。
- 新增 21 项 A/B 回归；与已有 study incremental、domain、checkpoint 定向测试共 56 项通过。比较完整 delta、幂等摘要、应用后 checkpoint 与来源读取轨迹，并验证不修改调用方 checkpoint。
- 覆盖子树撤回、祖先 deny、同课程/跨课程移动、祖先撤回时后代移出、先提交撤回再恢复、链接标题与 href 改写、冻结后代、宽树/混合树；缺父节点、环、跨课程错误父链及伪造部分撤回均继续拒绝。
- 独立只读审查未发现阻塞问题；确认数组没有外部别名、顺序保持、原实现基线一致及计时边界正确。
- `scripts/performance/study-tree-adjacency.ts` 在 Node 24.21.0 / macOS arm64 测真实 `prepareStudyDelta` 和 `applyStudyDelta`，合成来源无网络。先做完整等价预热，每方案 3 次交错计时，阶段前 GC；数据构造、结果比较和来源轨迹核对在计时外。

| 合成树（笔记数） | prepare 原版 → 新版 | apply 原版 → 新版 |
| --- | ---: | ---: |
| 宽树 500 | 24.71 → 25.99 ms | 6.73 → 6.66 ms |
| 宽树 5,000 | 262.99 → 241.62 ms | 76.88 → 60.09 ms |
| 宽树 15,000 | 1020.10 → 704.40 ms | 331.96 → 185.85 ms |
| 混合树 15,000 | 892.23 → 912.46 ms | 224.80 → 231.69 ms |

- 上表为中位数，原始三次样本在忽略目录 `timings.json`。15,000 宽树 prepare / apply 分别减少约 31% / 44%；小树及混合树没有稳定收益（混合树本轮约慢 2.3% / 3.1%）。不是网站响应时间或现役私人 worker 的实测，完整验证、复制、重写与排序成本仍然存在。
- 复现：Node 24 执行 `node --expose-gc --require ./scripts/development/offline-network.cjs scripts/performance/study-tree-adjacency.ts`。
- Node 24 离线完整 `npm run check` 通过：类型、lint、隐私与协议校验通过，3,379 项测试通过，0 失败、0 跳过。`npm run build` 通过，50 个 server trace 的私人运行文件排除检查通过。日志保留在上述忽略目录；没有用平台跳过或历史回执代替本机验收。

## 集成与限制

- 只交付 develop；没有改 main、安装后台包、恢复/修改定时任务或部署。网站合入不会自动替换私人同步运行根。
- 项目数据库/Storage/Notion/网站云端请求为 0，流量约 0 MB；测试只使用本地合成输入。
- 列表权限和排序实验独立保留，不作为本次树修复已具备完整列表下推能力的证明。Supabase 实例复用按用户要求暂缓。
- 同次列表补充验证见忽略目录 `.local/backend-list-validation-20261111/REPORT.md`：19 组权限断言通过；保留原投影/比较器的精简字段候选在 180 组查询、744 页保持完整结果一致。直接 raw SQL 排序得到 7 个反例，版本号也不能覆盖全部媒体资格变化。下一步先设计完整资格一致性和仅选中元数据的读取，再测真实总成本；本次没有列表产品修改。
