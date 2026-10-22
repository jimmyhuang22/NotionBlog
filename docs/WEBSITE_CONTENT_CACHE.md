# 增量发布的私有内容缓存

`scripts/website-incremental-sync/content-cache.ts` 保存完整发布中的 raw `WebsiteRecord` 与 `StoredMedia` 描述，供普通页对比、已知页巡查、学习变化的站内链接修订和资产复用使用。它与学习检查点分开，覆盖所有已接受来源；图片字节不进入 SQLite。网站页面、DTO 和访问资格不读取这个缓存。

## 建立基线

`openContentCache(directory, configDigest, sourceKeys)` 使用已有私有目录，创建 `content.sqlite`（600），目录必须为 700。拒绝软链接、硬链接、其他用户的文件、不安全的旁文件、未知 schema 或另一范围的缓存。

`initialize({state, records, media}, proof)` 只接受同一次完整采集、同一个已接受发布版本、同配置／schema／policy epoch 的私有输入。`proof` 必须由完整发布的独立 reader 验证者提供：完整性、记录／媒体数量及 `contentCacheBaselineDigest` 全量摘要全部匹配。摘要包含所有 raw 记录和媒体描述，不用浏览器派生字段、旧单课程快照、writer 回执或本机日期代造证明。缓存本身不生成数据库验证证明，不请求来源或导出数据库正文。已初始化实例拒绝重新初始化。

主运行器可用已合入的 `collectWebsiteStudyBaseline` 返回的同一组 `collection.records`，结合该次媒体准备描述与完整独立验收结果来建立内容缓存；学习排序单独由其 baseline 提供。不能只凭学习页的核对结果证明全栏目缓存完整。避免第二次读 Notion 或重新下载图片。外部完整发布、配置变化或 policy epoch 变化需要先停止新准备并对齐已验证基线；不能直接改本机版本字符串。

## 接口

- `readPublished(ticket, state)`：同版本私有页及该 owner 的媒体描述；未知页返回 null，不能当删除证明。
- `placement(ticket, state, newOrdinal?)`：已有页沿用原 ordinal。未知页必须由运行器提供当前来源目录位置，缓存不猜排序。
- `knownPages(sourceKey, state)`：已验证版本的私有 ID 目录，可接 `createKnownPageDirectorySource`；不代替新后代发现。
- `incomingLinks(hrefChanges, state)`：按持久链接索引取得受影响的普通记录，修订学习页路径／标题，撤回后内部引用标记不可用、child-page target 置空。未变化正文不遍历，学习记录仍交学习领域；超出 100 项依赖上限整体停止，不输出部分成功。
- `assets(records, state)`：仅返回实际引用且 owner／尺寸匹配的既有资产描述。新资产缺项明确 pending，由图片端口补充准备和字节证明；此接口不读图片。

全部读取要求明确当前 `PublicationState`，检查配置、schema、发布版本及 policy epoch。它是后台已验证数据复用，不是浏览器读取资格缓存。

## 所有栏目版本接续和恢复

`withContentCache` 包装已有协调层的 `IncrementalPorts`，不修改队列、学习领域或协调层实现。普通和学习 delta 都在提交前保存 operation ID、完整 prepared request 和摘要；异步准备结束后再次执行实际 `queue.assertPreparing`，然后持久 stage。unknown 提交恢复只 lookup、独立验证和安装，不重新准备或发送。

验证必须先通过原协调层的独立 reader，再从独立 reader 连接取得本次准确版本。`finalize` 依次完成原领域检查点与内容缓存的 SQLite 事务，然后执行器才确认队列。如果任一安装失败或成功回复丢失，队列仍待验证，重启后只重复验证／幂等安装。撤回按同一物理 parent 链删除旧子树，显式搬走的 upsert 可重新纳入；资产索引随引用更新，和 SQL 一样删除已不被引用的描述。

`retire` 重读公共队列持久 closure，只有未发送或明确拒绝才清理准备数据；清理回复丢失可重复，已应用项不可退役。未知响应、lookup(null)、取消、过期租约都不自行成为删除或已拒绝证明。原协调层的学习检查点仍对普通提交执行 `stageOtherPublication`；不能只为学习更新缓存版本。

上限：2 万记录、2 万媒体、20 万链接、128 MiB 原始缓存；单次 delta 沿用 SQL 的 100 项／16 MiB；最多 8 项待准备请求、总 64 MiB，保留 1 万 operation 身份，SQLite 65536 页。超限明确停止，运行器负责有界维护及已验证基线重建。日常同步不运行工程测试。

## 当前边界

已提供可消费的后台组件，尚未安装生产 CLI、建立真实完整基线或改变 Dagu。完整采集与学习顺序由学习基线任务负责；实际数据库角色连接、图片准备、canonical 锁、入口和整体验收由各拥有方接线。此模块没有云迁移、Notion／Storage 客户端、文件上传、公开范围变更、网站开关或部署动作。
