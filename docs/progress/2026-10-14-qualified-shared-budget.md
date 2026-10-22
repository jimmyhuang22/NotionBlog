# 2026-10-14：旧 qualified 发布父子共享预算（Codex）

编辑登记：本项从 develop 隔离分支开发。只给 `run-private.mjs` 添加可选固定预算桥接；新增持久账本、端口守卫、preload、CLI、原 MJS 类型声明和自己的测试／说明。原 run.ts、采集 worker、runtime reader、调度、续期私有模块、协议／迁移、权限、来源、依赖与前端没有改动；其他会话的执行输入／媒体操作器不改。

新增入口的默认动作是离线检查。显式执行才创建一次不可重用的私有账本，原父进程、直属子进程和同进程续期共用 HTTP／正文／上传／SQL 预算与 deadline。固定 preload 保留旧入口的环境白名单、canonical 锁和原发布回执。错误与取消停止普通操作，只为精确 fenced fail_run 预留至多二十秒的有限清理；未知 promote 结果不自动重试。

接口与 provider：适用于旧 qualified/notion + Supabase HTTP/pg 端口，不适用于 published/COS 新发布链。详见 [共享预算说明](../QUALIFIED_SHARED_BUDGET.md)。预算只记录数字与固定错误码，不保存凭据或原始正文；SQL rows 与参数是应用层保守计数，Pool/Client 可能两层计费，不声称包含 TLS／PG 协议／计费流量。

验证：新增离线用例覆盖真实父子共享账本、不退款／不重建、锁冲突与持久停止、认证错误正文、超额后已收字节、原生 HTTPS IP/Host/SNI、SDK／下载器实际入口、pg callback／promise、受限清理和 deadline。冻结的虚构 release 使用实际旧 host 与新 preload，验证 SDK、HTTPS、续期样例及 pg 零额度在上游调用前失败；默认检查无 child／账本。旧入口兼容测试保留。一次完整 `npm run check` 通过：1805 项测试、类型检查、三项协议检查及 839 文件隐私检查，95.46 秒；一次 `npm run build` 通过，42 条服务端 trace 排除私有运行文件，3.90 秒。此前针对性 27 项用例通过，后续仅补本记录与交接，不重复全套。

局限与下一项：本轮没有真实 Source、对象存储、SQL、Token 续期或发布调用；没有安装新 runtime、切政策／网站或合入 main。旧已安装运行包仍缺此守卫，旧自然轮次失败也不是回退成功证据。发布拥有方下一步冻结新包与具体额度，完成原 writer／云租约交接，再结合媒体最终回执与具体维护授权执行。仅有代码和离线证明不能把执行状态标为 ready。
