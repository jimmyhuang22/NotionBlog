# 2026-11-02：读取事务超时与独立运维期限

用户确认按 M08 方案离线实现。事务池可能不采用客户端 startup GUC，网站不得以客户端 statement_timeout 配置值代替服务端实际设置。

- 网站及社交读取通过专用 reader executor，在同一 checkout 内用 BEGIN READ ONLY、SET LOCAL、原 SQL 和事务收尾完成；超时不超过网站 15 秒／社交 10 秒，并受当前请求剩余时间约束。
- 新增控制 SQL 计入总预算，业务查询上限独立保留；读取失败不能把未收尾事务归还池。同步 writer 的原 executor、冻结 SQL 与协议摘要保持。
- 归档 export／restore 使用独立 owner session、连接与进程期限，不通过加大全局网站超时解决。已知事务池不用于跨语句 owner 运维，恢复结果不明不得重放。

具体默认值、验证及采用边界见[说明](../DATABASE_OPERATION_DEADLINES.md)。本决定补充既有读取预算和恢复规程，不改变内容公开、凭据、真实安装或发布权限。
