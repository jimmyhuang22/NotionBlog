# 有界内容读取扩展

本扩展优化 v2 网站读取，不更改同步 writer、来源、公开政策、内容 schema digest 或已上传对象。默认旧路径继续工作。启用步骤需要独立的迁移所有者和原受限 reader，不给网站读表或写表权限。

## 行为

- `DATABASE_READ_PROJECTION=legacy`（默认）：沿用现有 qualified／published SQL。
- `DATABASE_READ_PROJECTION=scoped`：仅支持 `DATABASE_CONTENT_VERSION=2`；使用原 `DATABASE_PUBLICATION_MODE` 对应的当前成功批次。新增独立能力摘要检查，错误不回退。
- 内容与 metadata 只验证实际引用；媒体按 owner 去重。状态列表按本页选择正文，不再先导出全部动态。
- 搜索使用文字片段及内部目标／图片资格标记，应用逐片段脱敏后按原顺序匹配。SQL 通过显式栈遍历 AST，保留 32 层深度边界，避免逐块发起 SQL 或重建整棵文本 AST。不读取图片对象、访问 Notion 或保存跨请求资格。纯文本 16 MiB、两万条边界继续生效；传输投影另有 32 MiB 上限。
- 首页先获取无正文索引，动态只为最终页面批量加载。批次／资格版本改变、正文缺失或明确撤回都会拒绝混合结果。完整快照与单次内容／选中正文批量读取保留 16 MiB 边界。
- 列表和年份统计仍基于合格 metadata，首页仍读取社交快照；本阶段没有把全部过滤、计数和排序迁入数据库，也没有给出无限容量保证。

## 安装与切换

1. 按最终 PR／发布提交核对 `database/scoped-read-protocol.json` 的三个迁移 SHA-256，与文件实际字节一致。依次为 `migration`、`searchMigration`、`traversalMigration`；后续修复不改写已经安装的前两份文件。原 v1/v2／publication／availability 迁移保持原样。
2. 在内容 writer 已排空的维护窗口，用原迁移所有者依次应用所列迁移。先设置有限 `lock_timeout` 与 `statement_timeout`；索引创建若无法取得锁或超时，整项事务回滚，不能自动重试或停止其他任务。已经安装且摘要一致的项不重复应用。
3. 所有者将三个已核实的文件 SHA 分别写入 `nb_read.migrations` 中 version=1、2、3 的 digest。此表启用 RLS，网站 reader、writer 与客户端角色均不能直接读写。
4. 使用网站已有受限 reader 调用 `nb_read_api.check_capability($baseDigest)`、`check_search_parts($searchDigest)` 与 `check_search_walk($traversalDigest)`，均须为 true；核对直接读表、调用私有 helper 及其他角色调用 API 均被拒绝。公开 DTO 的 schema digest 仍须匹配原 v2。
5. 分别核对当前 publication mode 的单篇、缺失篇、动态列表、年份、课程目录、中文／英文搜索、首页翻页以及撤回和版本变化。本地 SQL 结果不能替代正式环境验收。
6. 获准后将网站服务端开关设为 scoped，随用户选定的正式发布激活；不因安装扩展重启内容同步、重采正文或重传图片。记录实际受检部署与 SQL 调用数、字节、p50/p95 和错误率。

迁移不会启用开关，也不改当前发布指针。切换回 legacy 是应用回退；独立只读扩展与索引可保留，不在运行中自动删除 schema。旧完整动态快照的容量限制也会随旧路径恢复。

## 限制与后续

搜索当前仍扫描所选合格文本。紧凑投影省去重复全站引用计算、格式／URL 传输和逐栏目往返；是否需要混合 n-gram 或发布时文本索引，应按真实中文短词、高频词、内容规模和维护成本另测。对已开始的 SQL，取消仍等待原 driver 超时／正常收尾，整轮期限不是强行杀查询。

首轮真实验收暴露了紧凑 AST 与逐块 SQL 调用仍然偏慢，两个独立补充迁移分别替换传输格式与遍历方式。旧 API 留作安装历史，当前应用要求三项能力齐备。不能只根据合成基准启用，也不能把本机远程读库计时当成正式页面的 p50／p95。

新函数仅在私有 schema 中以固定 `search_path` 运行，原资格函数继续处理父链与中央 denied。禁止为性能扩大公开来源、把状态当发布开关、持久缓存旧资格，或给 reader 提权。
