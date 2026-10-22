# 首次增量目录初始化

完整发布后，空的变化目录会把所有页面当作新增记录。`discovery-baseline.ts` 复用同一轮完整采集已取得的元数据，在完整内容经独立 reader 验证后初始化目录，避免立即重新采集已发布的正文。

运行器接入顺序：

1. 用 `captureDirectoryMetadata(client, pinnedConfig).client` 包住完整采集器已有的客户端。适配器仅观察 `getPage` 和 `listPages`，其他读方法保持原客户端绑定；不增加请求。
2. 使用同一完整采集的最终 records 调用 `seal(records)`，得到 `directory-baseline-v1` companion。与原完整采集工件一起原子保存在后台私有目录；页面 ID 和指纹不提交 Git，也不交给浏览器。封存后不能再用此客户端采新页面。
3. 完整发布成功后，使用 [完整内容独立回读](CONTENT_BASELINE.md) 验证同一 records／media，初始化普通内容缓存及学习基线。由真实 `initializeContentBaseline` 的成功结果和独立 reader 状态构造 `ContentCacheBaselineProof`；writer 回执、自填布尔值、旧学习子集或公开 DTO 不足以初始化目录。
4. 调用 `initializeDirectoryBaseline({ queue, config, capture, baseline, proof, currentState })`。`currentState` 来自独立 reader，必须与完整证明的 revision、config、schema、policy epoch 全部一致。保持运行器原有 canonical mutex；初始化成功后才启动各来源的变化发现。

指纹复用既有 `page-metadata-v2` 算法，含属性、物理父级、归档标记和按来源配置选择的封面，去掉临时文件签名。companion 绑定整批 records digest；每个种子必须属于已验证发布成员，且记录的 `updatedAt` 与采集元数据时间一致。同页多次读取结果冲突、不可用、归档、未取得元数据或时间不符时，排除该种子，后续扫描照常产生核验提示。无法补造旧完整发布的 companion；缺失时接受正常扫描成本，不能在发布后重新读一遍元数据来假装原始基线。

队列 schema 升为 4，给首次种子增加持久回执。旧 schema 1／2／3 事务升级，保留 jobs、unknown attempts、retirements 和已有扫描结果；已使用的目录拒绝首次种子。相同基线与种子重放只返回原回执，不覆盖后续目录；不同基线或指纹拒绝重放。种子最多 20,000 个，总计原子写入，不生成任务、不清除已有任务、不确认未知提交、不设置水位或扫描游标。

首次仍进行元数据成员扫描。未变化的已发布成员不进入正文采集；新的、实际变化的、缺失的成员按原逻辑生成提示。源端缺失仍不能直接授权撤回；本初始化也不扩大公开范围。自动学习的新子页由独立子目录发现负责，不能靠现有 ID 探针推断完整后代。

本项提供后台模块，未安装实际 CLI、替换调度、修改数据库或启用网站新模式。主运行器负责读取私有 companion、独立 reader binding、取消／预算、跨进程锁和恢复顺序；所有来源／云端／图片 I/O 仍通过其既有受限端口。
