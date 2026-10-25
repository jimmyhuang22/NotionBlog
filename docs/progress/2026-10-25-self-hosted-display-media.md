# 2026-10-25：自托管展示图片后端（Codex）

编辑登记：独立分支接续最新develop，整合既有自托管入口；新增`scripts/self-hosted-media/`、`src/server/self-hosted-media/`、v2媒体路由接线、可选ImageAsset.delivery与相关文档/测试。未编辑ContentImage/Lightbox、冻结SQL、依赖或锁文件，也未覆盖其他会话的记录。

实现：独立配方生成必备≤1600最大展示版，不放大小图；400/800无收益时复用已有展示文件。批次清单最后写入，只存派生对象。读适配器验证私有目录、只读文件、摘要、WebP尺寸；v2路由复用现有资格SQL并在读文件后再次复核。DTO在同次当前run投影补充，外部/未准备图片移除，不写回同步记录。普通Vercel/COS路径保持，专用启动固定TLS verify、reader隔离enforce、no-store/noindex。

验证：`npm run check`最终通过（2849项测试，零失败/跳过），`npm run build`和`npm run build:self-hosted`通过，49份服务端追踪均通过隐私扫描。末尾public目录保护另完成typecheck和11项受影响测试复验，并对两种构建重验。定向测试包含实际生产媒体GET→本机HTTP→隔离PGlite真实资格SQL→磁盘副本，断言无原件/对象存储transport。PGlite测试替代pg传输，只验证严格TLS配置，未做本次原生TLS握手；不记作服务器或浏览器验收。

检查修正：初轮类型检查问题已解决；旧capture兼容测试更新两个精确文件摘要，并继续断言新运行字节不能被历史过渡接纳，未改冻结兼容清单或生产校验。Turbopack不接受跨工作区依赖链接，改为按相同锁文件在本机复制既有依赖后构建；零新增依赖下载。失败历史与最终回执保留在本地私有记录，不把初轮失败改写成通过。

限制与下一项：真实同步/传输发布器与完整覆盖门禁尚未接入，不能提升真实数据库批次。未读取真实图片/凭据或访问业务云服务，未部署上海、恢复任务、改DNS、推送/合并/发布。后端接口与安装约束见[说明](../SELF_HOSTED_MEDIA.md)，Claude后续按[交接](../SELF_HOSTED_MEDIA_FRONTEND_HANDOFF.md)连接灯箱并验证交互。
