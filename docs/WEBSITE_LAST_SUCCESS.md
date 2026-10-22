# 网站保留最后成功内容

网站 v2 可通过独立数据库扩展保留当前成功批次：新同步失败或原新鲜度期限经过时，页面、API、已登记图片继续读取上次完整发布。它只放宽读取时的新鲜度限制；不延长 `valid_until`，不修改当前批次指针、写入租约、发布政策或冻结 v1。

扩展默认关闭。安装与启用是独立生产操作，需在已获授权、网站 writer 排空的窗口完成；不能在运行包中自动执行。迁移及 SHA256 见 `database/website-availability-protocol.json`。安装会校验当前原函数正文，未知版本拒绝覆盖；需先安装 v2、媒体来源与小图索引扩展。

## 行为边界

- 只读取 current 指向的已完整 published、政策 epoch 一致批次，不遍历更老历史，不读取 staging 或 failed。
- 新批次完成后仍由现有发布函数原子切换；新批次中删除的内容不从旧批次补回。
- owner、祖先、中央 deny 和来源范围检查保留。公开政策变化仍使旧 epoch 无效，不能依赖本扩展继续展示已撤回的范围。
- 未联系 Notion 时无法发现最新删除；更新失败期间会继续展示尚未发现的旧内容。这是用户明确接受的更新滞后。
- 普通媒体仍需 Notion 实时来源验证和临时地址刷新，上游或存储失败仍可能使单张图片不可用；不保证所有网络请求永远成功。
- 已有小图可以继续读取；过期批次不允许追加小图。过期 staging 的写入、续租和发布限制不变。

## 维护与回退

迁移 owner 校验文件 SHA、当前公开政策及 writer 排空状态后安装迁移，再记录 `nb_v2.migrations` 中 `001-website-last-success` 的真实文件摘要。只有迁移 owner 能修改私有 `nb_availability.policy` 表；reader、writer、Supabase API 角色没有直接访问权限。

```sql
-- Separate approved activation, after installation and state verification.
UPDATE nb_availability.policy SET retain_last_success=true WHERE singleton;
SELECT retain_last_success FROM nb_availability.policy WHERE singleton;
```

启用前后保存 current run、epoch、revision、valid_until 及已知下架项；它们不应因切换读取模式改变。用受限 reader 验证页面、API、现有小图和下架项，不人为修改真实批次时间来制造过期测试。本机测试覆盖过期行为。

紧急回退只将 `retain_last_success` 设为 false，不回滚内容或删除扩展；若当前批次已过期，严格模式会立即恢复拒读，所以应先确认回退影响。新同步继续既有周期；监控最后成功时间、当前批次年龄、连续失败与调度状态，保留旧内容不能代替同步故障告警。

本扩展不改变每次发布后的小图再绑定需求，也不改变定时任务预算和失败暂停规则。线上是否启用以私有安装／读回回执为准。
