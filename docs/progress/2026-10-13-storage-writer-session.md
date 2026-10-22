# 2026-10-13：首次长采集的 Storage writer 会话适配（Codex）

编辑登记：独立分支从最新 develop 开始，仅新增 `scripts/website-sync/writer-storage-session.ts`、自己的测试、会话说明和本记录。没有修改正在由其他拥有方接线的 CLI／full host、旧 `run.ts`、数据库／Storage 通用接口、契约、依赖、fixtures、SQL、栏目或其他进度记录。

实际准备发现新入口仍传固定 Storage JWT，现有 JWT 窗口不足首次长采集；旧发布器已有受限、摘要固定的会话 helper。新增可注入 token getter 与私有文件适配，复用已有 Storage 回调入口和操作者原 helper，固定同一 SQL／CA／对象目标／API／writer，重新读取轮换结果、合并并发请求、拒绝漂移和未验证续期。本轮失败不重试；取消后先等待凭据保存，再允许调用方释放 canonical writer 锁。

前置读取安装版本的 Next.js 环境变量指南及 Supabase 会话文档，服务端私有输入不使用公开环境变量。十项有意义的本机测试覆盖连续到期、并发实际假 Storage 上传、前后绑定与 JWT 身份、续期拒绝和窗口、取消收尾、私有 helper 摘要与权限。临时目录采用 realpath，遵守既有目录守卫，不降低权限校验。

纳入 PR213 最终 develop 树后集中完成一次 Node 24 `npm run check`：1,680 项测试、类型、协议与 730 文件隐私检查通过；`npm run build` 通过，40 份 server trace 排除私有运行文件。两份锁文件与既有同机依赖一致，APFS 独立副本复用；私有 wrapper 限制测试文件并行度为二，工程测试脚本、超时和 CI 没有改变。文档收尾仅补链接、记录、差异与暂存隐私检查，不重复完整套件。

同步自己的上线准备文档：首次发布入口 PR213 已合 develop；安装拥有方经授权安装五项云扩展并交回能力、摘要与受限连接证明，原政策／名单／批次保持，新指针未激活。本方读取其私有回执更新状态，没有重复云查询或安装。最终自动学习候选采用学习拥有方补齐“排序”的已审版本。平台验证前 develop 又仅新增发布215的验收记录，纳入后补格式、17个文档链接与隐私检查，应用树不变，不重复工程套件；main 最新215与未安装的 Mac release 分开记录。

测试只使用虚构输入和临时 helper；没有调用真实 Auth refresh、读取来源／图片／对象、占 publisher 锁、修改云权限／配置／政策／调度、切换运行包／网站、合 main 或部署。已有实际 reader LOGIN／客户端 TLS 基础预检交回私有文件，不冒充完整 scope 或真实首次基线证明。

接口与 provider：公开契约没有改变；模块为 Supabase writer 的内部适配，尚未接入新 CLI。安装方应在同一 canonical 锁内接入 `session.token`，并在 finally 中先 await `session.close` 再释放锁。具体要求见 [会话说明](../WRITER_STORAGE_SESSION.md)。首次完整工件、实际云扩展安装、媒体目标与获准预算仍由原拥有方接续，本项不接管或替其发布。
