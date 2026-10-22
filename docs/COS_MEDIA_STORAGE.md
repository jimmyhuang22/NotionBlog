# 独立 COS 对象存储接入

`STORAGE_PROVIDER=cos` 为网站原图／400、800 小图以及首次完整／日常增量同步选择同一对象接口。未配置时保持 Supabase；未知值、缺配置或真实读取失败明确报错，不回退其他 provider。DTO、媒体 SHA、发布资格、撤回与旧运行模式保持。

## 配置与权限

服务端显式填写 `COS_BUCKET`（带 APPID 后缀）、`COS_REGION`、独立 `COS_PREFIX`、`COS_SECRET_ID` 和 `COS_SECRET_KEY`。网站使用 reader 的独立受限凭据，Mac mini 使用 writer 的凭据；不放入 NEXT_PUBLIC、源码或公开回执。临时凭据还须填写 `COS_SECURITY_TOKEN` 与 Unix 秒的 `COS_CREDENTIALS_EXPIRES_AT`。环境接入使用固定凭据；底层接口也允许调用方注入轮换 getter，本版不自动申请 STS 或续期 COS 身份。

目标使用已由安装方核对的私有桶和固定命名空间。reader 只需要该前缀的 `cos:GetObject`；writer 需要同前缀 `cos:PutObject`、`cos:GetObject`，以及目标桶 `cos:GetBucketVersioning`。实际 IAM 权限、独立身份、ACL／bucket policy 由安装方核对，程序中的 role 标记不替代云权限证明。不得为了适配把既有图床桶改成私有或扩大原账号权限。

虚拟对象键继续是 `sha256/<digest>`；实际 COS 路径是 `<prefix>/sha256/<digest>`。原件与小图都按自己的字节 SHA 定位。该选择作用于整份运行配置：切换前须把该版本需要的原件及已有小图放在匹配目标，不能只改环境变量就宣称迁移完成。原有 197 小图复用；历史清理的退役键及其迁移排除清单由媒体拥有方沿实际资产映射核对，不从历史备份恢复。

## 请求与不可变写入

采用腾讯云 V5 HMAC-SHA1 Authorization，签入固定 Host、路径、请求参数及实际头部；临时 token 也签入。HTTPS 域名由桶／地域构造，禁止重定向、匿名重试和任意来源 URL；每次读验证凭据窗口、完整尺寸、MIME 与 SHA。下载最多沿契约的 20 MiB，网络失败只返回固定错误。密钥、上游 URL 和错误正文不进入响应。

writer 在首次采集前读取真实桶版本状态，并在本轮共享该检查。只有从未启用版本控制的目标可写：启用或暂停版本控制时，腾讯云的禁止覆盖头均无效。上传签入 Content-MD5 和 `x-cos-forbid-overwrite=true`；409 只在完整回读字节吻合后复用，其他错误不重试覆盖。程序不删除对象、不改桶版本控制、不配置 ACL。[请求签名](https://cloud.tencent.com/document/product/436/7778)、[PUT Object](https://cloud.tencent.com/document/product/436/7749)、[桶版本状态](https://cloud.tencent.com/document/product/436/19888)

## 运行器与访客读取

两个新同步 CLI 的共用 storage 工厂支持 COS，仍受 canonical 锁、取消和既有预算约束。临时 COS 凭据须覆盖整轮剩余预算及签名余量；不足时在 Source 前拒绝。COS 与 Supabase 会话续期三项输入不能混用。桶检查响应计入媒体字节预算；原件上传／既存核验／独立回读继续沿现有保守预留。seal、initialize、recover、status、help 不构造对象或 Auth 会话。

网站继续通过原 `/media/v2` 入口和自有数据库资格检查交付字节。published 模式无需访客侧 Notion；旧 qualified／notion 模式按原配置运行。此版图片字节路径为 COS → 网站 → 浏览器，沿原缓存／撤回规则；直达 CDN、浏览器缓存和地区性能属于后续交付，不能把更换对象后端当作已测得提速。

## 验证与实际安装

测试包括独立计算的签名 fixture、临时 token、不可变冲突、错误版本状态、损坏与超限响应、配置选择、运行预算和取消。真实 Next route handlers 使用本机 PGlite 的受限 reader 与虚构 COS HTTP，在 Notion／Supabase Auth 输入缺失时交付原件及两个变体；撤回后不请求对象。这些是本机工程证据，不是腾讯云 IAM／TLS 或媒体覆盖回执。

实际建桶／IAM、保存凭据、迁移文件、维护 full → seal → initialize 和站点切换须使用已批准的具体目标、资产清单、预算与窗口。运行包从最终合并提交冻结，不改旧在途 publisher／小图入口。用户已选择现有项目维护窗口；先备齐对象与会话，再进入会使旧 qualified 批次失效的 policy 步骤。
