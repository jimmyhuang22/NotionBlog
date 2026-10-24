# 历史快照清理

这是独立的维护候选，网站和内容同步不会调用它。代码存在不代表已安装或启用；先审查来源、真实表结构、受限身份、当前成功批次、保护集合、运行路径及预算，再安排实际维护。

## 保护与归档

保留当前网站／持久发布指针、在途及有效批次、最近一天的完成记录、最近三个成功版本、操作者固定回退版本、重新验证／增量依赖，以及递归使用的合格小图供体。清理只删除获准的历史 v2 正文和媒体关系；运行摘要、发布政策、下架记录、对象字节及本机归档继续保留。

最近三个成功版本按 `finished_at DESC NULLS LAST, id DESC` 选取，避免空完成时间挤掉已完成批次。标为 published 但完成时间为空的异常批次另行全部保护，并继续展开其小图依赖；不推断其已经完成，也不把它们当作可删除候选。同一完成时间沿用固定ID顺序。PostgreSQL 降序默认将空值放在前面，见[排序规则](https://www.postgresql.org/docs/current/queries-order.html)。

`scripts/database-retention/plan.ts` 提供计划与严格选择器，`migration.ts` 导出默认关闭的独立数据库扩展 SQL。导入模块不会安装 SQL；它不在自动迁移目录中。已有环境不得重新执行建库 SQL，也不得以旧目录摘要代替当前审阅。

删除前保存原始 JSONB 文本、索引、摘要和不可覆盖的意图，在本机临时数据库按原始类型／约束恢复验证。不能让 JavaScript 数字转换改变大整数或小数文本。提交结果未知时停止并先核对服务器回执，禁止自动重发。

## 显式窗口与成本

新配置使用 `retention-daily-config-v2`，窗口使用 `retention-daily-window-v2`，两者均须有数字 `maximumRuns`，只接受 `1` 或 `2`。旧格式及缺失值不自动升级；现有冻结运行包保持独立。调度入口为：

```sh
node --conditions=react-server scripts/database-retention/scheduled-cli.ts --check /absolute/private/config.json
```

`--check` 只核对本机状态及已绑定程序，不取得锁、不读凭据、不启动子进程或业务连接。实际运行入口 `--config` 仅供已审安装使用。配置需要固定绝对路径、私有环境文件、原共享锁和同一批内容／小图／访客／正文后置的完整成功证明；网站暂停或上次维护待核账时继续拒绝准入。

访客验收若因缓存响应头约定失败，允许成功主流程显式指向同一操作目录中固定名称的接续回执。只接受同批、同站点、同计划及 `nb-public-cache-v1` 策略的成功接续，时间须位于原失败与主流程完成之间；其他失败类型或任意路径均拒绝。原失败与接续文件一起绑定窗口摘要，原失败不改写为成功；没有显式接续时仍须原回执通过。

新候选保持每二十四小时最多一次、三十分钟、最多七百五十次分块删除、每块最多五百行、三十二 MiB 逻辑 SQL 返回及五百一十二 MiB 待核归档文本。不能仅凭两批就保证成本够用：索引读取后先检查本机已有字节，保守计算缺失数据的 JSON 转义、删除回执及最终控制读取；无法容纳则在下载缺失数据或删除前停止。需要降为一批时另准备受审配置，不自动重试。

实际 RPC 共用累计返回预算，包括初次身份／计划读取及结果包装；事务中的 SQL 先测量 JSONB 返回大小，过大只返回小结果，写入事务随之回滚。核心回执中的 `returnedBytes` 仍是核心处理结果的计数，额外的入口读取与包装也会消耗 RPC 预算，不能把该字段当作整条连接的字节数。这里约束逻辑结果，不声称精确限制 PostgreSQL 协议、TLS 或云平台计费字节。原始保护、锁、来源核对及失败记录不因预算检查放宽。

## 缓存观察器与结构守卫

维护守卫包含相关表的约束、列、触发器定义／启用状态及触发器函数。安装缓存观察器后，旧摘要应当失配；不能移除守卫或直接信任任意当前结构。

`catalog-review.ts` 导出只读元数据检查 SQL，后续在单独获准的小窗口采集。它不访问正文，不调用受旧守卫阻断的维护 RPC，不更新摘要。把检查结果和**独立审阅固定**的期望摘要分别保存为受保护的 JSON 文件，再离线运行：

```sh
node scripts/database-retention/catalog-review-cli.ts \
  --input /absolute/private/catalog.json \
  --expectations /absolute/private/reviewed-expectations.json
```

检查结果包含 `storedGuardSHA256`、`actualCatalogSHA256`、`catalogFunctionSHA256`、`guardFunctionSHA256` 和按 SQL 原顺序保存的 `catalogLines`。期望文件包含 `beforeSHA256`、`afterSHA256`、`approvedObserverLineSHA256`、`catalogFunctionSHA256`、`guardFunctionSHA256`。不能从同一份未审结果自动生成期望文件。

工具只接受一个已固定的媒体缓存观察器新增项；去掉该项后须恢复原摘要，完整新摘要及两个守卫函数摘要也须匹配。额外列、约束、函数变化或禁用触发器均拒绝。通过只表示离线差异吻合，输出明确保留 `databaseWrites=0` 和 `maintenanceResumeAuthorized=false`。

## 安装与恢复边界

维护运行包必须按锁文件包含完整依赖：`archive.ts` 在实际执行中使用 `@electric-sql/pglite` 验证离线恢复，它虽然列在 devDependencies，却不是维护包可省略的测试工具。当前支持完整依赖安装或复用同锁文件的已验证完整目录；不支持 `--omit=dev`、仅网站 standalone 输出或 production-only 的 node_modules。无需改变包分类或版本。

在独立候选目录中准备依赖并检查本机引擎，不能对正在使用的运行目录直接执行 `npm ci`：

```sh
npm ci --include=dev --ignore-scripts --no-audit --no-fund
node --input-type=module -e '
await import("./scripts/database-retention/archive.ts");
const {PGlite}=await import("@electric-sql/pglite");
const db=new PGlite();
try {
  const {rows}=await db.query("SELECT 1::integer AS ok");
  if(rows[0]?.ok!==1)throw Error("RETENTION_LOCAL_ENGINE_FAILED");
  console.log("RETENTION_LOCAL_ENGINE_OK");
} finally { await db.close(); }
'
```

离线依赖缓存齐全时给 `npm ci` 加 `--offline`；缺包时停止，不把安装失败当作恢复验证可跳过。`--include=dev` 也避免 `NODE_ENV=production` 的默认省略行为，见[npm 安装说明](https://docs.npmjs.com/cli/v11/commands/npm-ci/#include)。该检查不读真实凭据、不连项目数据库；它只证明模块和本机引擎可用，每次删除前仍须通过真实归档内容的原恢复校验。新排序进入生成的维护 SQL 候选，已安装环境须另行审查函数差异及安装方案，不能直接重跑建库 SQL。

后续安装候选应固定源码、依赖、路径、前后像、权限及回退。保持旧暂停／失败／费用与删除回执，先核账未知意图，再对当前元数据和候选成本作有限复核。结构摘要重绑不能只执行无条件赋值；须在无在途删除时验证精确受审前后值，并按具体批准处理。

清理开始前仍须新的同批完整成功证明和原共享锁空档。来源恢复、自然发布刷新、真实撤回验收以及每日维护分别记录结果。缓存刷新失败不得把来源或清理的实际提交状态改写；维护失败只停止自身。
