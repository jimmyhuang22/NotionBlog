# 2026-10-13：同次完整发布制作增量启动工件（Codex）

编辑登记：独立分支新增完整工件 helper、自己测试和文档；worker 仅增加可选 capture hook 与 signal 边界，未传选项保持原路径。不编辑主 host／CLI、普通 reader／cache、目录 seed、媒体运输、前端、契约、依赖或实际运行包。

原来主运行器只有启动工件的消费入口，本项补 producer：在同一次完整采集中捕获学习排序和目录元数据，保存全部实际媒体描述及 lease deny。准备文件必须先于任何 SQL stage／promote 完整落盘，失败／取消不发布。接受文件由实际独立 reader 核对同一 fullRunId、完整成员／eligible 媒体 ID 和不变的状态／政策后生成；丢回复可只从准备文件和数据库继续，无需第二次 Source 或图片处理。文件私有、不可覆盖、原子安装；接受文件仍不是 raw-reader 或对象字节证明。

针对性24项与类型已通过：11项新验证配合既有自动学习／完整遍历，实际本机受限 publisher／reader 与三个 SQLite 联通。测试使用虚构 Source／storage，同一次四页只一轮 Source 和一张媒体处理，双缓存及目录种子可消费封存结果。发现状态 API 也可授 writer，已补 reader 专属成员能力核对；未放宽权限。测试库最初漏设置已安装学习扩展摘要，已按实际安装协议补齐；数字排序的 fixture 改为真实拥有的笔记数据库记录。

最终集中 `npm run check` 的1,624项、类型／三协议／698文件隐私检查，以及 `npm run build`／40服务端trace全部通过；完整本机检查与构建约63秒，仅执行一次。真实 Notion／图片／云 SQL／完整发布／工件生成／安装／排程／main／部署均零；现有单课55页 publisher 和小图接续保持。下一项由主运行器拥有方消费 optional hook 与封存结果，再按具体安装／发布授权制作真实工件。

随后带入已合的主运行器并补一项实际入口组合：worker产出文件 → 独立 reader封存 → `runIncrementalHost initialize`，受限 LOGIN／实际本机 SQL和三个SQLite直接消费，三页只三次 raw回读，Source／storage工厂零次，连接全部关闭。最终组合类型、50项定点（含12项本项验证）、构建／40trace通过；完整本机检查在带入之前执行，最后提交的完整检查由平台CI确认，不重复旧全套。
