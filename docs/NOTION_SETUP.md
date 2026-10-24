# Notion 只读连接与联调

最后更新：2026-10-11。网站使用独立的内部连接，聊天中连接的 Notion 工具不能替代服务器 Token。

## 创建连接

1. 登录存放内容的 Notion 工作区，打开 `Settings → Connections`。按当前界面提示开启 Developer Mode，进入开发者连接管理，创建 `+ New connection`。
2. 名称可用 `NotionBlog Readonly`，核对对应工作区。当前界面的 Authentication method 选择 `API token`，这是工作区范围的内部连接；若界面显示类型，则保持 Internal。连接管理入口可从 [Notion developer hub](https://developers.notion.com/) 进入。创建按钮包含接受 Developer Terms 的条款。
3. 创建后在 Configuration → Capabilities 中只保留 Read content；关闭默认启用的 Update content、Insert content，用户信息改为 No user information。评论及 Agent 权限也保持关闭。设置自动保存后重新核对，此网站不需要写入或邮箱权限。
4. 从 Configuration → Integration token 取得 API token，直接保存到本地环境文件。创建内部连接需要工作区所有者权限；名称与菜单可能因语言不同而略有差异。[Notion 官方创建说明](https://www.notion.com/help/create-integrations-with-the-notion-api)。

## 授权来源

在所需的动态数据库、课程目录数据库和首批课程的学习笔记数据库，分别打开右上角 `••• → Add connections`，选择刚创建的连接。也可在连接管理的 `Content access → Edit access` 中搜索并选择来源，核对同名结果的祖先路径，再保存。课程目录的授权会包含其后代；已通过父节点取得权限的学习来源不需要重复添加。[Notion 官方页面授权说明](https://www.notion.com/help/add-and-manage-connections-with-the-api)。

Notion 连接授权决定服务器可读范围；网站另用每个来源的 publication 配置决定展示范围。两者要同时满足。指定 Status 来源使用整来源模式，覆盖该 data source 的现有活动记录与未来新增记录；其他来源不会因此公开。学习网站 v2 按新授权自动纳入已配置课程来源的全部当前／未来课程及实际拥有的后代；仍检查完整活动父链与中央 deny，不跟随外部引用。冻结 v1 的名单模式保留兼容。阅读状态、Clear 和完成进度不影响公开资格。

只授权已确认的课程来源及其他指定来源，不要为了消除错误而授权整个工作区。真实来源位置在忽略的 `.local/notion-sources.json`；来源使用 data source ID，不能将 database ID 混用。学习来源的 database_parent 必须属于配置的课程。

## 本地配置

首次配置时，从 `.env.example` 创建项目根目录下被忽略的 `.env.local`；已有配置应保留，不覆盖已填写的 Token。只在本地编辑，不把 Token 放进聊天、截图、公共代码或 `NEXT_PUBLIC_*`：

```dotenv
CONTENT_PROVIDER=mock
NOTION_TOKEN=
NOTION_API_VERSION=2026-03-11
NOTION_SOURCES_CONFIG=.local/notion-sources.json
NOTION_SOURCES_JSON=
MEDIA_SIGNING_SECRET=
```

将 Token 填入 `NOTION_TOKEN`。其余值可保持模板默认。`MEDIA_SIGNING_SECRET` 可单独设置随机密钥；留空时使用 Token 签名，Token 轮换会使旧媒体路径失效。托管时通过私有环境提供 Token 与 `NOTION_SOURCES_JSON`，不要打包 `.local/`。JSON 环境值优先于本地文件。

```sh
npm run notion:check
```

此命令只读取已启用来源的 schema，检查 Token、读取权限与字段映射，不修改 Notion，不选择公开内容，不打印真实 ID 或原始错误。失败时检查工作区、数据库 Connections 和本地来源映射。schema 成功不等于正文和层级已完成真实验收。

来源检查成功后，还须按下节准备受限数据库 reader 与中央拒绝扩展，才能将 `CONTENT_PROVIDER` 改为 `notion`。配置错误会返回受控错误，不能自动回退 mock。allowlist 模式的空名单返回空内容；Status 的 all 模式无需逐条填入页面编号。

## 直连模式的中央拒绝与媒体

自 2026-10-25 的 B20 源码起，`CONTENT_PROVIDER=notion` 的每次公开读取都会查询当前中央 deny。它仍从 Notion 核对来源和物理父链，不要求页面已进入数据库内容快照；策略无法核实、版本变化或超限时返回 503。`notion:check` 仍只检查 Notion schema，不能代替此策略验收。

实际采用新 runtime 前，须另行授权并依次完成：

1. 准备既有 v1／v2 基础 schema 的相同 owner，以及已通过[读取隔离](BACKEND_READER_ISOLATION_PLAN.md)验收的独立网站 LOGIN；该 LOGIN 只属于 `nb_reader`，没有私有表／列、写函数、建库建表或额外角色权限。
2. 由原 owner 独立安装 `supabase/migrations/20261024230938_notion_direct_deny.sql`；文件和函数体指纹见 `database/notion-direct-deny-protocol.json`。扩展只授予 `nb_reader` 固定只读函数，不创建 LOGIN，不导出拒绝名单。
3. 在私有环境配置 `DATABASE_READER_URL`，采用 `DATABASE_TLS=verify` 和必要的 `DATABASE_CA_CERT`；不能复用 writer／owner／增量证据连接。先验收实际权限、能力与版本变化拒绝，再采用新网站代码。Git 合并不执行上述安装。

每批最多 256 个页面 ID；每次操作最多 64 次策略 SQL（包括目录检查），累计 256 KiB 逻辑返回。操作内合并相同 ID，操作间不缓存许可；输出前再次核对策略版本。普通数据库 provider 不新增这些策略查询。

直连的 `/media/m1…` 保留签名定位，改为完整缓冲校验图片后返回字节；不再向浏览器返回临时源地址。只允许 HTTPS／443、公网 DNS 全量结果、固定 IP 且验证原域名 TLS，每跳一个地址、最多两次重定向，无地址回退或业务重试。正文上限 20 MiB，校验 MIME／魔数、解码与 100M 像素边界；只支持 JPEG／PNG／GIF／WebP／AVIF。下载后重新核对策略及当前 owner／祖先／图片定位，撤回或换图就拒绝交付。响应使用 `private, no-store`、`nosniff`、`no-referrer`，不转发源响应头。

媒体业务期限为 8 秒，取消会中止上游连接；返回前等待客户端连接关闭，清理另有 1 秒界限。图像原生解码完成后仍须检查期限，不能保证 CPU 解码被取消信号立即打断。有内容总期限的 Notion 读取不进入 SDK 不可取消的重试睡眠；独立批处理保留原有限重试。

该代理会把直连图片流量转移到网站服务器；20 MiB 是单图正文界限，不是账单或并发流量硬上限。真实验收、凭据和安装需单独授权；本项仅完成源码与离线测试，既有数据库／hybrid 媒体交付仍按各自协议运行。

当前本地只读连接已建立，启用来源的 schema、字段映射、学习来源课程父节点和课程目录归属已核对通过，本地 provider 使用 notion。早期只选一门课程的真实联调范围是历史证据；2026-10-12 用户改为全部当前／未来课程与拥有的后代自动公开，工程／扩展与新发布仍须按各自交付状态核对，不能将旧证据解释为所有课程已上线。完整学习层级、代表正文和图片刷新及访问边界已通过真实联调；尚未逐页验收全部正文，完整 UI 与正式部署尚未完成。

## 来源公开配置

公共 `config/notion-sources.example.json` 保持禁用来源与空 allowlist 的安全默认值。建立私有配置时，复制示例到被忽略的位置，去除 `isExampleOnly: true` 或设为 false，填写真实来源并启用所需项目；不要把真实配置提交到 Git。

只有用户明确选择整来源展示的 `kind: "status"` 项可以改成：

```json
{
  "publication": { "mode": "all", "allowlistPageIds": [] }
}
```

all 只覆盖指定 data source 中直接归属且未归档、未删除的动态记录，包括未来新增记录；不会跟随普通子页、链接或其他来源。此模式不使用逐条名单，`allowlistPageIds` 保持空。冻结 v1 的 course／study-note 使用 all 仍被拒绝。网站 v2 自动学习使用 course 的 all 与 study-note 的 course-descendants，分别声明直属课程和所有权后代；两者共享课程根来源编号，后者不指向某一门课的笔记库。

冻结 v1 与旧网站 allowlist 配置保持：

```json
{
  "publication": { "mode": "allowlist", "allowlistPageIds": [] }
}
```

以上名单步骤仅用于旧兼容配置。新授权的全部课程模式与可选数字属性配置见 [学习自动公开](STUDY_PUBLICATION.md)，无需逐页补名单。网站中央 deny 可立即撤回一页及后代，并持续作用于后续自动采集；归档／移出范围则在新采集及 live 媒体检查中排除，已发布正文需中央撤回或新批次更新。

## 接口与数据行为

- `GET /api/content/[kind]`：列表、筛选、排序与游标分页。
- `GET /api/content/[kind]/[slug]`：允许页面的详情和正文 AST。
- `GET /api/study/[course]/tree?parentId=...`：允许课程的树；可选 parentId 必须属于该课程。
- `/media/[assetId]`：签名站内路径，每次核对公开页与图片归属，再临时重定向到新取得的媒体 URL。JSON 不包含原始签名 URL。

当前真实实现支持 status、course、study-note。其他类型保留统一契约与栏目开关，真实适配器后续补充。正文支持契约的 17 种块；未支持的格式、超出限制或无法安全解析的内容会标为 partial，前端应提示。不自动读取引用型 synced block。普通 Notion 子页使用固有 title 属性，未填日期、评分保留 null。

首版不持久缓存正文或公开资格；每次操作重新检查来源公开规则、归档和父链，API 和媒体响应使用 no-store。媒体重定向已交给浏览器的上游 URL 会在 Notion 的有效期内存在，已下载的内容无法追回。暂不承诺更强的内容撤回机制。

列表读取符合公开规则的页面元数据后全局排序，只读取当前列表页 Status 的正文。Status 的 all 模式先完整分页查询指定来源的直属记录；学习区按配置读取旧允许列表，或发现已授权课程的实际所有权后代；单门目录仅遍历该课程。游标绑定筛选、映射、公开配置和已编辑的元数据；新增或变化后客户端需要从第一页重新请求。此策略适合小规模初版，记录很多时延迟和 API 用量会增加，真实完整目录已测得明显延迟，仍需优化。

服务端同进程的请求按连接分开节流；遇到429或529，暂停新请求并遵守返回的完整 Retry-After。每次读取有可取消预算和有限重试，长等待可能返回受控繁忙状态供界面稍后重试。不同进程或工作区其他连接仍会影响共享配额，不能保证不会限流。规则依据 [Notion官方请求限制](https://developers.notion.com/reference/request-limits)。没有加入持久内容或资格缓存。

## 删除课程的“难度／推荐”属性

这两项已不再用于课程展示。删除 Notion 属性前，从实际来源配置的 course.fields 移除 recommendation、difficulty，以及存在时的 recommendationRating、difficultyRating 别名；不要删除体验／实用映射。现有 v1／v2 parser 只要求已配置的属性存在，未配置的评分经 mapper 返回 null。必需的 title 以及其他仍配置的属性继续严格校验，不能通过忽略所有 schema 错误来兼容删除。

Course.ratings 的 recommendation、difficulty 键继续保留并返回 null；同步 DTO 校验与数据库 reader 已支持此形态，无需为这次属性删除改契约或执行迁移。旧批次仍可能携带历史评分，本项不改写旧快照；前端移除展示和新批次输出 null 是两个不同步骤。

冻结发布包引用的来源不能原地改写。为下一轮准备独立新配置，更新来源文件 SHA 与规范化 configDigest，并在恢复方案中绑定政策、采集及验收输入；旧缓存／来源证据不能直接换指纹放行。暂停期间可先删除属性，但恢复前必须完成这项配置接续，不能直接启动仍引用旧映射的冻结任务。详见[属性删除接续](decisions/2026-10-17-course-rating-property-removal.md)。
