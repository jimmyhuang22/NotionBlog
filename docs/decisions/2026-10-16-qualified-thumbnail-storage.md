# 2026-10-16：qualified v2 小图单独选择存储

日期：2026-10-16。状态：工程准备，生产启用待独立验收与批准。

已生成的小图可以位于COS，而原链路转换图片仍保留在既有Storage。因此增加服务端THUMBNAIL_STORAGE_PROVIDER，仅用于qualified v2混合媒体路径的已登记缩略图；未设置继承STORAGE_PROVIDER。原图、公开策略、有效期、Notion源端撤回检查、摘要验证和错误行为保持。

不能直接切换整个STORAGE_PROVIDER，否则会将尚未转存的转换原图也指向COS。新开关必须与已核验的目标对象、当前批次登记、受限reader及代表访客验收一起启用；没有原图复制或上传动作。
