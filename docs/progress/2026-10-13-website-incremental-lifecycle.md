# 2026-10-13：公共准备终态与领域退役（Codex）

编辑登记：沿用 PR179，补自己 queue／executor 及 lifecycle 测试、说明；学习拥有方接自己的 checkpoint／domain，主重构接连接／运行器。未修改其工作树、SQL、图片或排程。

解决 domain.stage 后取消／明确拒绝却没有释放回调的接线缺口。队列 v3 同事务持久关闭 attempt 和退役待办，v1／v2 升级保留既有未知操作；未知提交和已发布成功不产生证明。执行器先恢复未知，再处理幂等 retire，回调成功才 ack，失败或预算结束阻止新的准备。终态先持久，不能由超时、lookup null 或仅过期伪造。

验证：10 新生命周期与原 queue／executor／discovery 的 58 项通过，类型通过；最终集中 npm run check 的 1415 项、全部协议与 602 文件隐私检查通过，npm run build 及 40 个 server trace 检查通过。覆盖取消后重开、明确拒绝、清理失败／丢回复只补退役、预算、摘要冲突、v2 升级及未知／成功提交不清理。

必要领域接入：never_submitted 的 payloadDigest 可能为 null，领域按操作身份取得自己 staged 摘要；参与的全部领域完成后才能返回。stage 前检查取消及当前 ticket，canonical 互斥和实际传输停止仍由运行器提供。接口见 [生命周期](../WEBSITE_INCREMENTAL_LIFECYCLE.md)。

没有真实 Notion／图片／云 SQL、采集、发布、迁移、部署或 Dagu 修改。下一项消费实际学习退役与混合栏目 checkpoint，再由运行器做代表性的联合验收；正常同步不执行工程检查。
