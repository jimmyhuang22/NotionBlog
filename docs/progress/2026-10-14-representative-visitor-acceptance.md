# 2026-10-14：同批次代表访客累计守卫（Codex）

编辑登记：从最新develop隔离新增访客计划／HTTP验证／运输护栏／CLI／隔离服务器及自有测试、说明。消费既有shared账本、accepted-full、公开DTO／reader与构建，不改前端、全局入口、契约、fixtures、依赖、SQL／角色或其他会话私有运行计划。root历史进度的他方未提交改动保留。

实现与provider：[操作说明](../REPRESENTATIVE_VISITOR_ACCEPTANCE.md)。绑定同次成员、登记选择与受检构建，生产Next在loopback独立进程安装SQL/COS守卫再读库；实际LOGIN、每次投影版本、前后状态、代表API／HTML／媒体SHA和404检查。各段5分钟／64HTTP（含对象GET）／64MiB回应／256物理Client SQL／8MiB行JSON，共享账本保留失败和迟到数据；两个排他slot不自动重跑或退还预算。强杀／未排空留accountingComplete=false，stdout不泄露输入。

验证：集中一次 `npm run check` 的1846测试、类型、三协议与871候选隐私通过（128.82秒）；一次 `npm run build` 通过，42server trace排除私有文件（4.35秒）。真实生产Next＋loopback＋现有PGlite迁移/受限角色夹具通过15次根请求、3次模拟COSGET、39次物理Client SQL；最终必选400变体实际命中，SQL行JSON22280B／两处回应101074B、accountingComplete=true、Source/外部网络0。初次冻结权限／夹具摘要错误、多路由池及HTML流式账本竞争的失败日志保留；修正后只重验受影响路径，没有重跑全套／构建。相关67测试／类型／871隐私通过；末补站点配置内存冻结与原子inode替换读取竞争，最终15访客用例／类型／871隐私及3.98秒生产Next路径通过，稳定坏文件和空选择不能冒充成功。

接线细节：隔离Next共用单连接reader池，保留TLS／原超时；Next缓存构造器通过Pool原型处理。短ledger锁最多同期限250ms等待，不抢锁／退款／重试网络；持续锁占用或观察值未保存必须accountingComplete=false。前后固定slot、原前段ledger／回执SHA／combinedCounters验证和静态停止原因都已覆盖。独立测试中的数据库／对象传输明确为本地夹具，不写成云端通过。

局限与下一项：未执行真实Source／云SQL／COS／安装／调度／切换／main部署。此入口验收本地受检站点，远端域名／部署身份、远端SQL硬停、浏览器hydration和内地网络仍需要发布拥有方按具体窗口接线与实际验收；不冒充线上已通过。两段时间使用原预留，不新增完整采集或图片复验窗口。
