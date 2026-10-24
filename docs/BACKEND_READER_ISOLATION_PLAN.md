# 后端同步读取角色隔离方案（源码方案已确认）

用户于 2026-10-24 明确同意实施 B03 源码与离线测试。本文件是已批准的实施方案，不是安装记录；当前目标数据库的实际权限尚未在线核验。现有迁移将包含来源证据的 `nb_delta_api.read_page` 和操作验收函数授权给网站读取组 `nb_reader`。公共 DTO 不包含这些证据，但网站数据库凭据拥有的权限仍过大。

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

本项网站读取器在第一次查询前核验角色图和私有增量函数权限，错误检查不会缓存为成功。尚未完成角色隔离的既有 nb_reader 会被拒绝。因此不能先发布网站防护再安排数据库升级；须先完成获批的真实权限核查、迁移和专用 LOGIN 成员调整，验证网站仍可读公开内容、同步账号可读必要证据，再按发布规则发布。已有连接实例的成功检查只在本次 runtime 内复用；线上改权限后仍需按已批准的切换流程重建连接实例。

源码安装入口为 `installIncrementalReaderIsolation(db)`，与 `installIncrementalWithdrawalRecovery(db)` 均是显式 owner 操作，不由启动或构建自动调用。两个扩展支持任意安装次序；旧迁移和原协议摘要保持原样。它们不处理 LOGIN 凭据或成员切换，不能把“SQL 已安装”当成“真实账号已隔离”。

备份导出保留新扩展的已知摘要，恢复要求来源和空目标扩展集合及摘要一致；旧备份可先恢复到匹配的旧空目标，再显式升级。备份不携带 LOGIN 凭据或成员，不会自动安装角色、启用发布或恢复任务。
