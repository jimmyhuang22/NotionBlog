# 2026-10-28：控制台续期兼容已有公开 Storage key（Codex）

编辑登记：真实接入在媒体上传前被本机 writer session 的 key 类型检查拒绝。已配置的旧公开 anon key 与本项目匹配，现有受限 reader 已完成真实读取；不是数据或身份不符，也不需要迁移凭据。本项仅让 session 接受该既有公开 key，仍拒绝 secret、service_role、authenticated 及其他项目 key；实际写入仍要求受限 authenticated writer JWT 和服务端校验。

来源配置、凭据值、权限及原恢复程序／计划文件不改。已有独立媒体的字节验证不会重复下载。新增回归通过真实 Storage adapter 的虚构不可变 PUT 验证旧 key 接线，并覆盖越权／错项目／坏 key 在 Auth 前拒绝。固定 Node 24 定向 11 项、完整 3,114 项（无跳过）、TypeScript、build／49 项服务端追踪、privacy／diff 检查通过；真实采用结果另记，不把此兼容修正写成媒体已上传或按钮已开启。
