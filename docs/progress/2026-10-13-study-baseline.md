# 2026-10-13：学习启动基线适配（Codex）

编辑登记：从最新 develop 建立独立短期分支，只扩展本方网站 Notion repository 的后台完整采集伴随入口，新增学习基线适配、自己的测试及说明。公共 queue／executor／discovery、主 coordinator／CLI、SQL、普通栏目缓存、媒体、契约和前端不改。

- `collectWebsiteStudyBaseline` 在完整采集同一次操作中保留数字排序和子页相对位置，返回供完整 publisher 使用的 records 及私有基线。正常旧 repository 行为保持；不增加第二遍 Notion 元数据、正文或图片读取。
- 旧单课程允许名单／非自动后代来源预检拒绝；完整图、工件摘要、来源与 deny 绑定、排序与已发布 ordinal 一致。初始化先查独立完整目录成员，再按同一实际 full run 版本核对每个私有记录，最后重查发布状态与政策，才初始化可恢复检查点。
- `createDatabaseStudyBaselineReader` 组合现有受限 API，无新权限或迁移。首次基线回读有显式页数上限，后续日常增量不走这条全目录／逐页路径。缺页、未知、漂移、取消或不一致均不安装；旧单课自洽快照无法隐藏数据库里的额外页。

验证：11 项新定点行为通过，覆盖两课／深页顺序与数字覆盖、源读取量不变、ancestor deny、坏工件、完整目录、预算／漂移／取消、冻结输入、SQLite 重开，以及实际本机 PGlite 完整 writer／独立 reader／学习检查点组合。Node24 的 npm run check：1,491 项测试、类型／全部协议、630 文件隐私检查通过；npm run build 及 40 份服务端追踪隐私检查通过。合并仍以该分支最新提交的平台检查为准。

限制与下一项：仅本机合成来源和实际本机 SQL，没有真实 Notion 采集、图片传输、云 SQL、初始化真实基线、运行器安装、排程、main 发布或部署。主运行器应以本次 collector 替换其单次完整采集，保存 records＋baseline，再接实际来源／独立媒体与 reader；不能先调用新 collector 后又运行会重采的旧全量 worker。说明见 [学习启动基线](../STUDY_BASELINE.md)。
