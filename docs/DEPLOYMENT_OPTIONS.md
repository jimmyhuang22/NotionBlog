# 中国内地与海外访问的部署候选

记录日期：2026-10-11。状态：国内外访问目标已确认；第一阶段优先试验 Vercel + Supabase，长期区域与运行位置待选择。

用户要求网站同时供中国内地与海外访问者正常访问。本文件记录官方能力核实与候选取舍，不代表已经购买、创建、部署或迁移。具体个人设备位置与后续生活安排只写入忽略的项目记忆。

最新阶段方向：用户倾向先跑通 Vercel + Supabase，以后按需求迁移。实施应保留可迁移边界，具体见 [首阶段联调准备](VERCEL_SUPABASE_TRIAL.md)；此前香港／上海建议作为后续候选，不再要求先完成两地比较才能推进首阶段试验。

## 已核实的访问边界

Vercel 官方说明没有中国内地服务器或 CDN 节点，内地访问会经跨境线路，可能出现延迟、限速或阻断。自定义域名可以降低默认域名被阻断的风险，但不能保证可用性；Vercel 明确不保证内地性能或可用性。[官方访问说明](https://vercel.com/kb/guide/accessing-vercel-hosted-sites-from-mainland-china)。

Supabase 官方托管区域目前包含新加坡、东京、首尔等，没有中国内地或香港。官方另记录了多个地区的域名阻断事件，但这些事件不能作为中国内地全网阻断的证据。本轮没有中国内地真实网络测量，不能把控制台、数据库协议、REST、Auth 和文件域名的可达性混为一谈。[托管区域](https://supabase.com/docs/guides/platform/regions)、[区域网络事件](https://supabase.com/blog/navigating-regional-network-blocks)。

网站服务端读取 Supabase 时，访客不必直连数据库；如果图片仍跳转到 Supabase 或 Notion，浏览器仍会依赖相应文件域名。国内网站配海外数据库还会使服务端请求承担跨境读取。同步正文和图片、把访客所需资源放在网站选定的存储区域，才能减少这些依赖。

## 国内对应能力

腾讯云 CloudBase for Supabase 版提供 PostgreSQL、REST、身份权限、对象存储和云函数。当前支持上海与新加坡；它采用类似的开发范式，但官方不承诺 100% Supabase API 兼容。[产品说明](https://cloud.tencent.com/product/tcbs)。

现有 Next.js 服务端可以使用 CloudBase 云托管的容器运行方案，保留 SSR、服务端路由与流式响应。当前工程为 Next.js 16.4.0、Node.js 24，官方部署示例使用的版本较早，仍需验证本工程的容器构建、API、媒体、环境隔离、流式响应和隐私追踪，不把产品支持等同于项目验收。[Next.js 容器部署说明](https://docs.cloudbase.net/recipes/deploy-nextjs-to-cloudbase-run)。

CloudBase 当前资源点文档显示上海 PostgreSQL 环境支持云托管，新加坡 PostgreSQL 环境不支持云托管；不能假设任意区域都能部署同一套组合。免费体验每月 3,000 资源点，个人版当前限时标价 19.9 元／月、40,000 点。计算、数据库、文件和流量都消耗资源；免费函数仅 3 秒／256 MB，不能默认免费体验能承接当前完整服务。实际费用需按选定环境和用量测算，套餐价不等于最终账单。[能力与价格](https://cloud.tencent.com/document/product/876/127357)。

腾讯 EdgeOne Makers（原 Pages）也提供 Next.js 全栈托管，可作为托管层的额外候选；它不自动替代关系数据库。加速区域、默认域名访问与自定义域名备案规则须单独检查，不能因服务商在国内就认为其所有区域与默认地址都适用于内地访问。[全栈支持](https://pages.edgeone.ai/zh/resources/pages-support-full-stack-deployment)、[域名规则](https://pages.edgeone.ai/zh/document/domain-overview)。

阿里云可用 ECS／SAE 承载应用，配 RDS PostgreSQL 与 OSS，或用轻量云主机自管 PostgreSQL。轻量数据库产品本身只提供 MySQL，不应误作 PostgreSQL 替代；普通 RDS PostgreSQL 或自管 PostgreSQL 才是相应候选。[SAE](https://help.aliyun.com/zh/sae/)、[RDS PostgreSQL](https://help.aliyun.com/zh/rds/apsaradb-rds-for-postgresql/what-is-apsaradb-rds-for-postgresql/)、[轻量数据库限制](https://help.aliyun.com/zh/simple-application-server/user-guide/overview-of-simple-database-service/)。

## 三条候选路径

| 组合 | 适用理由 | 主要代价与不确定性 |
| --- | --- | --- |
| 香港云主机 + 现有 Next.js + PostgreSQL + 同地域对象存储 | 用一套部署服务国内与海外，应用与数据库可就近通信；现有 Node.js 服务容易保留 | 有主机及存储费用；自管数据库增加升级、备份和恢复工作；内地到香港仍跨境，需实测线路 |
| 上海 CloudBase 云托管 + PostgreSQL + 云存储 | 优先内地访客，并使用托管数据库及计算减少机器维护 | 内地接入需备案；海外访问性能需测；平台适配与资源点用量需验证 |
| Vercel + Supabase | 免费试验与海外访问候选，Next.js 部署便利 | 不作为已验证的国内外共同访问方案；国内链路、文件与管理控制台均需测试 |

香港是地域候选，不是性能保证。腾讯与阿里官方都提示港澳台／海外实例的跨境访问可能发生较大延迟和丢包，轻量实例的带宽峰值不是稳定性承诺。[腾讯网络说明](https://cloud.tencent.com/document/product/1207/50103/)、[阿里轻量实例说明](https://help.aliyun.com/zh/simple-application-server/user-guide/create-a-server/)。对象存储的香港区域可另行选择，例如 OSS 中国香港。[OSS 区域](https://help.aliyun.com/zh/oss/user-guide/regions-and-endpoints)。

中国内地网站接入需要办理 ICP 备案，内地 CDN 接入也有相应要求。按阿里云当前说明，香港／海外服务器无需工信部 ICP 备案，但面向内地的网站仍需核对公安联网备案等要求；具体办理条件应向选定接入商确认。[备案流程](https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/icp-filing-application-overview)。

## 同步执行位置与建议

香港的一套完整部署和上海托管方案保留为后续迁移候选；当前第一阶段优先 Vercel + Supabase。长期区域、费用或备案路径尚未确定。现有 Next.js 和统一内容入口继续复用，数据库采用普通 PostgreSQL 建模，媒体通过可替换存储适配器接入，减少平台迁移成本。

后续迁往香港时，同步可放在香港云端，使用独立进程／容器读取 Notion 等来源并写入网站存储。若网站已经租用云主机，同步进程可以共享主机但须限制资源，避免重叠任务影响网站；未必需要再租一台专用服务器。首阶段任务位置仍需落实，外部平台可能按来源位置、账号或接口准入限制访问，仍要分别验证。

本地常开设备可用于开发、导出和验证后的备份，也可执行已验证网络与权限的同步任务。若该设备位于内地，读取 Notion API、写入海外数据库是额外跨境链路，不应成为未经验收的唯一更新来源。Notion 编辑端在用户所在地是否可用也需独立检查，云端同步不能解决编辑端网络问题。[Notion 网络排查](https://www.notion.com/en-gb/help/cant-access-notion)。

同步架构仍需明确更新与撤回延迟、原始数据边界、失败状态和恢复流程，沿用 [内容存储候选方案](CONTENT_STORAGE_PROPOSAL.md)。不会因部署讨论而修改当前 provider 或公开范围。

实际选型前应使用同一份匿名测试应用／数据，从内地电信、联通、移动及至少一个海外网络测量页面、API、图片、HTTPS/DNS 和失败率，并覆盖多个时段。同步执行端到 Notion、数据库、文件存储的路径另测。确认报价、续费、备份恢复和备案条件后，再按用户明确部署指令购买和切换域名。无需起步就维护双站点和双数据库。
