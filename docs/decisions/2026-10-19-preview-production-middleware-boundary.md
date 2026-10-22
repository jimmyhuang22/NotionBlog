# 2026-10-19：Preview不能代替Production中间层地域与性能验收

用户只授权本轮一次云端Preview；生产环境候选与正式入口切换仍须分别按明确范围推进。区域资格入口本轮已通过真实平台构建、普通函数sin1日志与权限／状态抽查，但不因此宣称生产性能通过。

补充[区域资格查询决策](2026-10-19-regional-route-qualification.md)及[旧地域兼容方案](2026-10-17-proxy-supported-region.md)：Vercel Preview把middleware部署到项目函数地区，Production才部署到全球地区。真实trace与[官方说明](https://vercel.com/kb/guide/how-to-migrate-from-fastly-to-vercel-with-zero-downtime)一致。这解释了旧方案的Preview地域结果不能外推到Production，不能把该差异当成本机数据库连接问题，也不能假设Node默认地区或更名就能锁定生产中间层。

后续将平台配置接受、普通函数实际SQL地区、权限及HTTP状态、端到端生产性能分别验收。Preview保留作功能与阶段诊断；最终性能须覆盖实际Production调度。若采用不切换正式域名的Production候选，必须另行获准，沿用并核对生产配置、固定版本与现网入口，不能自动创建、自动晋升Preview或把候选建成当前正式入口。当前项目分组配置差异及单次／不同入口IP限制在验收记录中保留。

本轮没有新的代码、SQL、池或Claude页面改动；约400ms动画继续由Claude负责。区域SQL已变短，但内部HTTP和重复地域路由仍需评估，不能通过放宽权限、跨请求正资格缓存或删除404／503检查换取数值。
