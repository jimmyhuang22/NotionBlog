# 2026-10-13：学习检查点持久化与增量执行器接入（Codex）

编辑登记：从最新 develop b0435d5 建独立 codex/study-incremental-runtime，仅新增学习私有检查点、领域 prepare／verify／finalize 适配、测试与说明，并复用既有学习引擎的验证／差量应用工具。公共 queue／executor／source、SQL、契约、前端、来源配置、运行 release 和 Dagu 由原拥有方维护，本项不覆盖。

新增私有 SQLite 学习检查点与操作身份绑定：准备先持久保存 next 状态，独立 reader 确认之后单事务安装检查点；进程中断只 lookup／回读／finalize，不重采／重发。明确的队列终态证明可退役未提交或被拒绝的准备，不以 null／超时清恢复数据。校验 SQL upsert／完整撤回子树与本机缓存一致，所有快照／身份数量有界。

领域 prepare／verify／finalize 接已有引擎和公共接口，变化入链须同版本私有缓存，新／旧资产需匹配描述，不读取文件或默认云连接。非学习发布也先 stage observer，让学习缓存跟随全站版本，并允许已验证的 AST 入链编辑；课程元数据／成员变化仍仅走学习引擎。取消阻止迟到 stage，中央 deny 和未被 observer 记录的版本漂移转恢复／复核。

验证：Node24 集中 npm run check 通过 1,365 项测试、类型、全部协议／摘要和 592 文件隐私检查；npm run build 通过，40 服务端 trace 排除私有输入。新增 18 项检查点／领域验证及既有引擎及依赖正文版本 16 项覆盖实际 PGlite writer、独立 reader、重开的 SQLite、进程退出、跨栏目版本接续与明确终态清理、公共任务代次／lease 检查及 retire hook。全部来源和媒体为本地模拟／注入，没有真实 Notion／图读／上传／云写／部署。局限：公共队列／运行器、完整私有缓存／资产索引、真实全课程基线及一次代表变更仍需组合接入；旧 Dagu 两步骤和 main 保持。具体接口见 docs/STUDY_INCREMENTAL_RUNTIME.md。

与公共执行器正在收尾的四个真实端口（prepare／verify／finalize／retire）在相同 tsconfig 下完成无输出类型匹配；候选接口仍由其原支线提交，本项未复制或修改公共执行器源码。

集成复验发现依赖页编辑版本变化时仍可能复用旧正文，补为读取该依赖页正文；新增子页单独事件亦可刷新已修改的父页，未变兄弟正文仍不读。已纳入最新 develop 的前端加载设置，未改其行为。
