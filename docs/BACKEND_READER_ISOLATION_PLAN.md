# 后端同步读取角色隔离方案（源码方案已确认）

用户于 2026-10-24 明确同意实施 B03 源码与离线测试。本文件是已批准的实施方案，不是安装记录；目标数据库在本方案批准时尚未在线核验；后续[只读审计](progress/2026-10-24-reader-isolation-handoff.md)已确认共用 LOGIN，但真实隔离仍未安装。现有迁移将包含来源证据的 `nb_delta_api.read_page` 和操作验收函数授权给网站读取组 `nb_reader`。公共 DTO 不包含这些证据，但网站数据库凭据拥有的权限仍过大。

## 源码改动

1. 新增独立 NOLOGIN 组 `nb_delta_reader`，不继承 `nb_reader` 或 writer 角色，不授予私有表、序列、CREATE 或成员管理权限。只授予工作程序所需 API schema 的 USAGE 和固定函数 EXECUTE。
2. 同步读取组的允许列表为 `nb_publication_api.check_capability(text)`、`nb_publication_api.read_snapshot(text[],boolean)`、`nb_delta_api.check_capability(text)`、`read_state()`、`check_reader(text)`、`read_page(text,text,text)`、`verify_operation(uuid,text,text)`。同步媒体验收另需公开媒体函数 `nb_publication_api.check_thumbnail_capability(text)` 与 `read_thumbnail(text,integer,text)`，只在对应扩展已安装时授予；两个安装次序均覆盖。安装撤回恢复扩展时另授予其只读 capability 检查。网站组保留公开内容函数，从网站组收回私有增量 reader 的三项函数授权。
3. 增量与完整基线连接检查改为要求独立同步读取组；继续核验实际 LOGIN 的整个成员图、禁止跨组与 admin option、禁止私有数据权限和额外可执行函数。网站连接增加拒绝私有 reader 权限的检查，异常不暴露账号或连接详情。
4. 用新迁移显式升级，不修改已安装的历史 SQL 或伪造旧摘要。冻结运行包继续拒绝未审阅的新字节，不直接扩充旧兼容许可。
5. 本机隔离数据库测试网站组不能调用私有函数、同步读取组能准备与验收但不能写入、writer 不会取得 reader 权限，以及混用 LOGIN 时失败。公共 DTO、栏目、来源公开范围不变。

## 真实环境的后续步骤（另行授权）

先确认网站与私人同步程序使用的实际 LOGIN 是否独立，并只回读角色成员和函数权限；不查询正文、来源记录、媒体或业务网站。若两者共用 LOGIN，必须先准备不同凭据和安装顺序，不能直接撤权造成现有程序失效。

在明确的项目、时间窗口、流量预算、停止条件和凭据配置授权下，再事务化创建组、调整指定 LOGIN 成员及函数权限；部署／安装对应运行包后分别验证。异常回滚角色变更，但不通过重新开放网站私有读取权限来长期维持旧任务。任何恢复暂停任务、正式部署或云端凭据修改都须单独处于有效授权范围内。

角色权限设计参考 [PostgreSQL GRANT](https://www.postgresql.org/docs/17/sql-grant.html) 与 [Supabase database roles](https://supabase.com/docs/guides/database/postgres/roles)。源码权限不能证明当前生产权限；本方案不声称已完成生产隔离。

## 发布前提

用户于 2026-10-25 批准 [R01 分阶段采用](READER_ISOLATION_RELEASE.md)：网站 runtime 缺省 off，保留原读取并记录尚未强制验证；显式 enforce 才在第一次查询前核验角色图和私有增量函数权限，失败不缓存为成功。库函数与独立同步校验仍默认严格，不受网站延后模式放宽。

off 不代表真实隔离已完成。开启 enforce 前仍须完成获批的真实权限核查、迁移、专用 LOGIN 成员调整及网站／同步读取验收，否则旧共享账号会被拒绝。每次发布明确阶段与拟采用模式，使用本机声明检查并核对真实回执；网站发布、云变量和实际安装仍分别授权。已有实例不动态重载模式，改权限／采用 enforce 时需按获批流程重建实例。

源码安装入口现为 `withOwnerInstallTransaction(config, session => installIncrementalReaderIsolation(session))`，withdrawal-recovery 同样接收受控 session；不再接受裸 SqlExecutor 或 Pool.query。两个函数均为显式 owner 操作，不由启动或构建自动调用。N08 将安装、摘要与末尾验证纳入同一固定 Client 事务，并用独立配方绑定执行体，详见[收尾方案](BACKEND_N08_FOLLOWUP_PLAN.md)。两个扩展支持任意安装次序；旧迁移和原协议摘要保持原样。它们不处理 LOGIN 凭据或成员切换，不能把“SQL 已安装”当成“真实账号已隔离”。

备份导出保留新扩展的已知摘要，恢复要求来源和空目标扩展集合及摘要一致；旧备份可先恢复到匹配的旧空目标，再显式升级。备份不携带 LOGIN 凭据或成员，不会自动安装角色、启用发布或恢复任务。

## 实际完整采集与后置程序的读取分工

用户在审计阻塞后同意继续兼容改造。增量证据接口与完整采集的公开验收不能共用一个角色：实际完整采集仍使用 qualified 公开快照，缩略图、正文和快照后置也使用公开读取接口。新增两种同步读取配置，网站保留自己的 LOGIN：

| 用途 | 组成员 | 边界 |
| --- | --- | --- |
| 网站公开内容 | `nb_reader` | 不持有私有证据权限 |
| 同步的公开验收 | 独立 LOGIN，仅 `nb_reader` | 使用公开快照／媒体接口，不能读取私有证据 |
| 同步的证据准备与验收 | 另一个独立 LOGIN，仅 `nb_delta_reader` | 使用既定证据函数，不写入、不加入网站组 |

`syncPublicReaderRole` 只接受同步公开读取账号族，`verifySyncPublicReader` 校验实际 LOGIN、整个成员图、管理选项、CREATE／私表权限和私有 reader 拒绝。两项权限查询在启动或后置验收前执行，不缓存为长期身份凭证；新增查询须纳入同轮预算。网站账号和证据账号不能作为公开同步凭据回退。

本轮只提供显式调用的检查模块和私人运行包候选，不自动改变旧网站／同步入口。私人候选以单独命名的完整采集入口及证据适配器保留历史冻结源字节，重新固定主机、原生观察器、输入编译和后置入口摘要。两个同步 profile 的文件与凭据均独立；安装模板移除已消费的 native context、resume 输入与旧资格，不能拿模板或历史回执启动新一轮。

运行包实际安装、创建两套凭据、数据库迁移与线上验收仍需要新的有界切换窗口；已关闭窗口不复用。source 恢复、调度、会话刷新与完整业务轮次预算独立管理，不能把读取兼容性通过当成完整同步成功。见[兼容验证记录](progress/2026-10-24-sync-reader-runtime.md)。
