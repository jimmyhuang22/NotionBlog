# 映射恢复与课程重采源码候选

本项在新仓库准备独立能力，保留所有旧捕获、旧运行批次及冻结兼容表。用户同意实现源码候选；数据库安装、固定转换启用、真实来源运行、调度和部署分别验收。本候选未执行这些操作。

## 严格配置转换与 owner 事务

`courseRatingRemoval` 只允许从已启用的 course 来源删除 recommendation、difficulty 及 recommendationRating、difficultyRating 既有映射，至少删除一项。原始 JSON 除这项删除外须语义相同，解析后的配置也必须改变；来源、顺序、公开范围、时区、其他映射、禁用来源和额外字段均不能借机改变。结果同时绑定两份文件的原始 SHA-256 与解析后的配置摘要，并以进程内身份防止复制回执冒充核验。

`applyCourseRatingRemovalPolicy` 是安装 owner 的显式工程入口，不由普通同步程序调用。调用方必须提供一个独占连接上的事务回调 `transaction(work)`，负责提交／异常回滚；不能传入 `pool.query` 充当事务。函数在事务内锁住 state，核对旧配置、预期 revision／epoch／currentRun、空 lease、freshness，以及全部已安装 sources／permits，仅更新 config_digest 并将 revision 加一。epoch、现有成功批次、历史 runs、deny 和全部来源范围保持；旧成功内容仍依原期限可读。普通 writer／reader 没有修改该状态的权限。

## 独立数据库核验

新增 [mapped 协议](../database/mapped-capture-protocol.json) 绑定一个独立 SQL 增量；不改旧基础迁移或既有 inspect_fresh_run。

`nb_revalidation_api.inspect_mapped_fresh_run` 先通过 assert_lease 锁定并核验当前 run／fence／revision／epoch／服务器期限，再核对历史 run 的 fence、revision、旧配置摘要、已结束的 failed／published 状态和时间顺序。新旧配置必须不同，新 run 不能有 records、media、tombstones 或 revalidation bindings。media source bindings 的外键依赖 media，因此该限制同时禁止已有媒体绑定。

函数只返回新 lease 与历史身份、两批期限和服务器时间；不更新 runs、不写绑定、不续旧资格。函数位于既有私有 schema，固定 search_path，撤销 PUBLIC／reader 权限，仅既有 nb_writer 获执行权；没有新增登录角色或公开 API。安全与权限核对参考 [Supabase 数据库函数文档](https://supabase.com/docs/guides/database/functions)。实际查询验证仅在临时 PGlite 数据库执行，没有读取云项目或运行云 advisors。

## 另行审阅的版本准入

新增 [恢复目录](../database/capture-recovery-compatibility.json) 格式 `capture-recovery-catalog-v1`，初始 transitions 为空。因此本候选不授权任何真实生产者，未知名称直接拒绝，不回退旧转换。

后续每个条目须由源码审阅追加：固定 producerCommit、Node 绝对路径摘要、版本与二进制摘要（真实路径留在私有清单中）、生产者目录摘要，以及完整文件并集的 before／after SHA-256（含未变化文件、增加与删除）。新目录本身的字节由实际已核验 consumer 清单绑定，避免把自身摘要写入自身形成循环；其余文件没有文档、测试、依赖或脚本豁免。生产者与消费者的实际冻结目录、清单文件原始摘要、全部文件和 Node 均须核验；同版本伪造、丢文件、重复路径、同时修改两边、混入其他旧转换都不能取得准入。

低层 `admitReviewedCaptureRecovery` 接收已由工程审阅的表，用于离线验证；它不是主机配置接口。生产主机只读取随源码携带的目录，没有操作员提供表、任意摘要覆盖或布尔跳过开关。成功核验签发冻结的进程内对象，复制 JSON 回执、展开对象及另一个进程的回执不能充当准入。

## 主机接线与采集

新参数仅用于显式恢复，仍要求捕获、新的共享预算、qualified／notion 模式和 `resumeQualification: "fresh"`：

- `resumeRecovery`：已审目录中的单个条目名称；必须同时提供既有 resumeProducer。
- `resumeConsumerManifestSha256`：当前固定清单的原始文件摘要；resumeProducer 继续显式绑定旧清单摘要。
- `resumeSource: { file, sha256 }`：仅 course-rating-removal 条目需要的旧配置私有文件；普通课程重采不能携带该参数。

主机与子进程各自核验，主机在 session 刷新、锁和子进程启动前完成；子进程在创建来源 reader／数据库连接前重验。不自动执行 owner 策略事务，不把捕获目录当作资格。清单、旧配置、捕获 index 和当前配置分别绑定；新输出写入另一 run 目录，旧捕获不改。

两种已审转换都排除旧 course DTO，由当前 mapper 重新采集课程。其他页面仍走原有当前成员发现、完整来源／父链证明、独立媒体字节验证和发布前稳定核对；变化页面按现有规则重新采集。晚撤回、移动、持续变化或坏图会阻断暂存。原有有界发布修复、预算与新 lease 资格保持。报告增加强制重采课程数与保留页面数，不将本机数据写成真实来源验收。

## 交付和后续边界

离线测试使用公开虚构的固定源码快照，不读取旧 Git 对象或私人运行包。覆盖完整清单与 Node 篡改、默认关闭、主机参数拒绝、映射原始摘要和作用域、owner 回滚／权限、SQL 身份／期限／暂存拒绝、旧成功可读、课程重采及坏图／晚撤回／移动；历史转换继续接受原输入并拒绝本候选字节。

本候选与诊断草稿 [PR16](https://github.com/jimmyhuang22/NotionBlog/pull/16) 独立；后续集成需核对共同 run.ts／run-private.mjs 和测试摘要，再验证组合版本。retention 由原登记任务负责，不在此复制。新增 SQL 也会改变数据库结构目录，未来安装时须与 retention 的结构差异审阅及回退绑定一并核清，不在本项重绑 guard。实际生产转换仍缺运行 owner 的固定运行包、最新完整成功捕获及回退绑定，不能用在途批次替代。只有贡献实际进入新 develop 后，才能重新核对旧实现请求是否已被完整替代；本候选不关闭旧请求、不清理工作树。
