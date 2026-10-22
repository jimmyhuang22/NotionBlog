# 持久发布的独立图片读取

本扩展在 `DATABASE_PUBLICATION_MODE=published`、网站 v2、独立 `storage` 媒体模式及 `MEDIA_THUMBNAILS=enabled` 下接通既有 `/media/v2/:assetId?thumbnail=400|800`。页面、DTO 和图片地址格式保持，启用之前需要部署匹配 SQL、准备独立对象并完成实际验收。

图片入口以当前已发布内容的父资产资格和文件摘要查询 400／800px 索引。已验证小图可从历史批次复用，后台增量改变全站发布版本时不需要重新生成或上传同一副本。读图没有 Notion resolver 或上游临时地址：一次请求包含两次 SQL 查询和一次独立对象读取，取得字节后再次核对发布身份与媒体描述。

未发布、已下架、课程祖先被撤回、父资产不再被正文引用时不能读取。图片字节按 MIME、长度和 SHA-256 校验。缺少所选小图，或有效历史小图不比原件更小时，显式读取同一已发布独立原件；错误的索引、权限、版本、对象和字节产生失败。原件对象也必须已准备完成。

## 数据库与服务端入口

- 新迁移由 Supabase CLI 生成，身份记录在 `database/published-thumbnails-protocol.json`。`installPublishedThumbnails` 使用专用 migration-owner 连接，检查原发布和缩略图迁移，原子安装并把完整文件摘要写入函数注释作为部署身份；重复执行仅验证，不改写既有版本。直接运行原始 SQL 文件还没有完成摘要登记，验收使用此安装器。
- 既有 thumbnail registry、qualified API、原迁移文件和摘要保持。新增按父资产／SHA／档位查找的索引，及私有 publication API 内的能力检查、读取和登记函数。服务器 `nb_reader` 仅执行读取；`nb_writer` 仅登记新变体。浏览器、anon、authenticated 和 service_role 没有这三项新入口的权限，也没有底表读取权限。此路径使用受限服务器 SQL 登录，不依赖浏览器 JWT 的用户身份。
- `createPublishedThumbnailReader` 把原始受限连接封装在固定查询内，检查扩展、schema、完整投影与变体身份。`publicationReader` 原有查询白名单保持；运行入口仅增加一个专用读取函数，不公开任意 SQL executor。
- `createPublishedThumbnailRegistrar` 接收 `expectedRevision / parentAssetId / parentSha256 / widthCap / thumbnail`。后台必须先准备并核验独立对象，再登记。SQL 锁定当前发布状态、校验原件／所有者／尺寸／字节收益；记录幂等且不可覆盖，不改变内容发布或有效期。旧 qualified registrar 不用于新模式。
- 发布备份可选记录 `publishedMigrationDigest`。旧备份继续可读，恢复目标须匹配是否安装本扩展及其身份；函数和索引随迁移部署，媒体和历史索引随原备份恢复。恢复仍清除两个发布指针，不自动启用内容。

## 验证范围

本地实际 PGlite 查询验证了 reader／writer／public 权限、默认授权撤销、跨已过期历史批次复用、原件摘要变化、引用删除、下架与读后撤回、登记幂等／拒绝及完整备份恢复。另以仅在测试进程替换的 pg 传输连接同一 PostgreSQL 引擎，调用真实内容与图片 route handlers；移除 Notion 配置并阻断全部 `fetch`，两档小图、原件、内容和查询边界正常，源请求计数为零。

这些是虚构内容、合成字节和本机对象。测试替换传输不验证实际 TCP／TLS；没有把云端 API、目标网络、真实图片覆盖和 CDN 当成本次结果。本机独立 Supabase 栈的 54322 端口未运行，`supabase db advisors --local` 无法连接，权限检查来自实际 PostgreSQL catalog／执行测试。

当前响应仍为 `private, no-store`。此扩展消除读图对 Notion 的依赖；CDN 地址签发、缓存期限、真实原件／小图 provider、托管安装和地域时延仍需后续接线验收。已有图片不因本工程重新下载、编码、上传或删除，默认运行配置保持。
