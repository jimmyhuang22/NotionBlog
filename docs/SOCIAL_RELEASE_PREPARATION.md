# 社交长期展示：切换与回滚准备

此文件是操作草案，不表示已经合并、配置 Vercel 或部署。固定作品、成员版本和实际凭据在操作者 SSD 私有清单中。后台周期安装与网站展示是两件独立的事；当前运行包不因网站代码整合而替换。

## 进入条件

- 后端分支已包含选择的集成版本，check／build 和精确提交的 GitHub 检查通过。正式合并与发布按用户当前授权执行；prepare 不代表获准部署。
- Claude 已补每个平台／合集的真实采样时间标签，沿用已有 DTO 和 `socialSampleStatus`；过期保留原数字，排序和合集折叠不由采样时间改变。
- 已有 retained 迁移与受限 reader 安装，固定批准清单已经回读。无新作品、新合集成员、展示批准或云端权限动作。旧短时资格不能代替长期投影证据。
- 发布窗口内重新核对正确团队／项目、当前 main、实际 Production 部署和变量元数据，保留回滚基线；准备时的历史快照不能当作切换时的现状。

## 最小配置变化

以下全部是服务端变量，目标环境显式选择 Production，不扩大到所有 Preview 或 Development。具体项目与路径只留 SSD。URL 和证书值不进 Git、日志或命令参数。

| 变量 | 候选值或来源 | 类型 | 作用 |
| --- | --- | --- | --- |
| `SOCIAL_PROVIDER` | `database` | Config | 首页 v2／社交 v2 接入独立社交 reader |
| `SOCIAL_DISPLAY_MODE` | `retained` | Config | 使用已批准的长期投影，避免旧短时资格过期撤卡 |
| `SOCIAL_READER_DATABASE_URL` | 原 SSD 受限 reader 配置，用户为 `nb_social_reader` | Secret | 只读社交展示；不使用 worker、网站 reader 或管理员 URL |
| `SOCIAL_READER_DATABASE_TLS` | `verify` | Config | 校验证书；不使用关闭校验的配置 |
| `SOCIAL_READER_DATABASE_CA_CERT` | 原 reader 所用 CA，仅存在时配置 | Secret | 保留原 TLS 信任材料，不能用缺证书作为关闭校验的理由 |

若目标已存在同名变量，先读其环境／分支／类型元数据并保留恢复来源，再准备明确的 update；不存在才准备 add。本项不盲目 force 覆盖。Secret 保存后不可从 Production pull 回取，安装值应从 SSD 原配置通过 stdin 传递，避免读取其他云端秘密。[Vercel 变量说明](https://vercel.com/docs/environment-variables)与[Config／Secret](https://vercel.com/docs/environment-variables/sensitive-environment-variables)是平台依据。

`CONTENT_PROVIDER`、`DATABASE_CONTENT_VERSION`、栏目来源和允许范围、媒体／小图设置、站点身份／索引／域名均沿用原站，不作为本次候选修改。社交封面当前仍为 null，不借此迁图或调整其他图片服务。旧 `/api/social/works` v1 仍走 trial；本次验收首页与 `/api/social/works/v2`，不把 v1 的结果当作 retained 模式成败。

## 验证与执行顺序

1. 凭已有 reader 的本地候选配置验证角色和 TLS 配置，可复用已保存的固定清单与实际受限回读；不重采统计、复制分享地址、重传图片或重新初始化云表。
2. 标签交付后启动一次临时本机预览，显式使用 retained，内容 provider 沿用届时可用的实际配置。检查独立 v2 接口、首页首16条和一次翻页、代表单视频／图文／合集与原链接、不同平台的采样时间；旧数字样式用虚构逾期输入验收。失败按具体层次诊断，不通过改批准范围或伪造时间来修正。
3. 汇总本机结果、精确 GitHub 检查、固定清单、目标环境差异和当前回滚部署，提交具体发布清单让用户确认。未经该次授权，清单保持未执行。
4. 获准后协调一个发布窗口，再检查基线、写入约定环境，复用正常 develop → main 发布产生一次部署；若独立手动部署另需明确授权。只改环境变量不会改变正在服务的旧部署，不能写完变量就宣称已上线。[环境生效规则](https://vercel.com/docs/environment-variables)说明变量只用于后续部署。
5. 新部署 READY 后核对 commit、项目、目标环境和正式域名指向；只做一轮代表接口／页面验收，记录实际时间和结果。新 snapshot 版本的游标必须从第一页开始，不能沿用准备阶段的旧游标。

本次无需 Vercel Cron、常驻服务或新的 Supabase 对象。Mac mini 周期仍是已审核范围的本地到期检查及受限上传；网站 reader 不获得审批或采集能力。

## 回滚清单

网页开启后如出现配置／查询／页面故障，先保留该部署和请求的错误回执。按获准的恢复范围将正式域名回到**切换前即时保存的成功 Production 部署**，核对实际 alias 与前一批页面。历史部署保留其当时配置；不要把“编辑当前项目变量”当作即时网页回滚。[Instant Rollback](https://vercel.com/docs/instant-rollback)和[部署提升](https://vercel.com/docs/deployments/promoting-a-deployment)说明平台行为。

再恢复本次改过的项目变量，供未来部署使用：原来缺失的键移除，原来已有的键恢复其保存来源；不碰其他环境或站内 reader／媒体变量。若需以新部署恢复正常首页，应准备 `SOCIAL_PROVIDER=disabled`；不要退回可能已失效的 trial 显示模式来假装恢复。配置恢复本身也不改旧部署。

Vercel rollback 可能暂停后续 Production 自动指向；恢复后记录这个状态，下一次正式发布按平台要求明确 promote，不能以推 main 成功当作域名已更新。恢复只作用网站，不删除云端长期投影、批准清单、角色、两份 SQLite、outbox、Chrome 扩展或 Dagu 工作流，不替换已获系统权限的 App。

## 状态回交

交回确定提交／检查、变量差异名称（不含秘密）、实际部署／域名、生效时间、243范围的读回摘要、代表页／分页／采样时间结果、是否发生回滚及其恢复目标。未完成的标签、本机浏览器、云端配置或部署分别标记 pending，不能用后端查询成功替代页面验收。
