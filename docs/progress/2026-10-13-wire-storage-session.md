# 2026-10-13：首次与增量运行器的会话接线和锁内清理（Codex）

编辑登记：用户在询问切换条件后要求继续推进。本方从最新 develop 创建独立分支，接入自己的 PR219 会话适配；主拥有方当前只收尾云安装记录，其冻结运行包不覆盖。只改两个 CLI、两个 host，新增共用 Storage factory／资源跟踪及自己的针对测试，更新自己的会话说明／上线准备和本记录。不修改旧 worker 封面刷新修复、其他对话文档、契约 DTO、依赖、fixtures、SQL、页面、运行环境或调度。

首次 publish 和增量 run 的 lazy source factory 采用同一适配，明确的三项私有参数启用原 hash-approved 受限 helper；先登记清理再预检 token，重读轮换凭据后发对象请求。缺省保留固定 token 路径，但必须覆盖整轮剩余预算加两分钟，不足时在来源读取前拒绝。部分参数和本机 Storage 的冲突配置明确失败；seal／initialize／recover／status／help 不创建 Source 或会话。

资源跟踪覆盖 hostAwait 取消后才返回的 factory。两套 host 在预算取消后先等创建和所有 cleanup，再关闭 SQL／本机 store，最后写报告和释放 canonical 锁。清理失败仍继续关闭其他资源并记录稳定错误；不会让已开始的轮换在锁外继续保存凭据。公开 report 形状和真实 publisher 协议保持。

验证：六项新增案例包含 fixed-token 整轮窗口、三项参数完整性、临时私有文件+假 helper 的预检／并发轮换、取消后不再发对象、cleanup 失败收尾，以及本机兼容引擎受限 SQL 组合下 full／incremental 迟到 factory 清理前不能获得第二把锁。连同既有首次与增量 host 31项针对验证、类型检查通过。首轮完整检查后先纳入前端时间线代码与安装记录，1,688 项测试／739 文件隐私／构建40trace通过；随后作品页新增代码与路由，再纳入后完成最终 Node 24 check：1,692 项测试、类型、协议、746 文件隐私通过，构建及41份 server trace 私有文件检查通过。只有这些新的应用改动才重复相应完整验证。两份锁文件一致，以 APFS 独立副本复用同机依赖，私有 wrapper 仅限制本机测试文件并行度为二，工程脚本、超时和 CI 未改变。文档收尾做格式、链接与暂存隐私检查，不重复工程验证。

仅虚构账号、临时文件、假 HTTP 和本机 PostgreSQL 兼容引擎；没有实际 Auth refresh／云连接／来源或图片请求。

接口与 provider：仅内部 source dependency 增加 registerCleanup，无公开 DTO、SQL digest 或媒体身份改变。Supabase factory 可选续期，COS 运输和真实媒体目标／预算仍由拥有方落实。用户已选现有项目维护切换，文档明确准备齐再改政策，沿用其他拥有方实际安装／连接回执，不重复安装。

局限与下一项：新接线尚未安装到 Mac operating release；需要包含最新合并提交的固定包、原私有 helper 摘要／会话实证，再完成同次 full→seal→initialize、独立媒体及异常恢复验收。旧封面到期修复与业务恢复仍由原后端对话负责，运行切换须协调在途 publisher 和小图。没有修改真实凭据、来源配置、公开范围、云政策、排程、网站模式，未合 main 或部署。
