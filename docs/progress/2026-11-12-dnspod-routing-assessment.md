# 2026-11-12：免费 DNS 分流与现有代理依赖评估（Codex）

## 编辑登记与范围

- 独立工作树，仅新增本记录；没有修改应用、共享契约、provider 实现、运行配置或其他工作线文件。
- 用户仅授权评估免费 DNSPod 的地区分流及 Cloudflare 服务保留方式。本次没有修改 DNS、云服务器、访问策略、凭据、调度或正式发布。
- 具体域名、账户、路由及探针结果留在忽略目录的私人评估记录，本文只记通用结论。以下为待批准方案，不是已实施决定。

## 评估结果

- DNSPod 免费版支持境内、境外基本线路，可以完成国内、海外两源站的基本分流；免费版最小 TTL 为 600 秒，不含 DNSSEC 和可用性 SLA，不能按秒级故障切换承诺。
- 当前网站的 Cloudflare HTTP 代理承载了源站端口覆盖、静态资源缓存及旧入口跳转。DNSPod 接管权威解析不等于迁移这些 HTTP 功能，公开新站需独立提供标准 HTTPS、重定向及静态资源服务。
- 受保护预览入口依赖 Tunnel 和 Access。免费方案建议将这些入口迁到另一个继续由 Cloudflare 托管的管理域名，保留邮箱限制及源站 JWT 校验；不能简单复制隧道 CNAME，或用开放源站替代登录保护。
- 普通 DNS-only 预览入口的服务器密码保护可以保留。另一个域名下已有的管理服务原则上不受本次主域名解析迁移影响，实施前需确认没有跨域依赖。
- Cloudflare 的外部权威 DNS 配合 Partial CNAME 接入仅支持 Business／Enterprise；不能将其算作免费保留同域代理的方案。DNSPod 子域名委派托管也不属于免费版能力。
- 现役备用回退依赖 Cloudflare 的端口覆盖和访问控制，不能把新解析的 A 记录改回旧服务器就声称已回退。更换 NS 前必须单独准备回退；Cloudflare 免费区域进入 Moved 后可能自动删除，需导出规则和记录，不能假定原区域永久保留。
- 公开流量直连后不会享有原 Cloudflare HTTP 缓存、安全过滤和代理流量分析；浏览器缓存与服务器缓存可以保留，但不等同于全球 CDN。

## 验证与局限

- 只读查看当前域名 DNS、规则总览及 Workers 路由列表；对照本地部署记录，核对注册商、NS、DS、MX 等公开信息。
- 对现有网站、预览、跳转和管理入口进行少量匿名 HTTP HEAD 检查；正式入口正常，预览认证挑战正常，未下载正文或直接读取数据库／对象存储。
- 官方文档及控制台页面流量估计数 MB，HTTP 头和 DNS 查询小于 0.1 MB，未精确计量；低于本次日常只读小额度。
- 这不是全账户安全审计；未逐项导出 WAF、TLS、页面规则或账户级产品配置。新管理域名入口、新公开 HTTPS、国内外 DNS 分流和回退均未部署或验收。
- 本记录为纯文档，按约定检查格式、链接、差异与隐私，不运行应用全套测试和构建。

## 下一项

以以下补充评估为当前候选方向，等待用户决定；尚未授权实际配置。海外正式节点由另一项工作比较确定，试验节点不自动成为正式内容源。

## 同日补充：国内直连、海外保留 Cloudflare

- 用户澄清最终仅保留国内、海外两个正式站，旧云主机和未选中的海外节点不再承担预览站；因此不再要求迁移全部旧预览入口或长期保留旧站回退。首次切换仍需有限的恢复安排。
- 前述 Partial 方案限制只适用于该产品，不能推导为外部 DNS 配合 Cloudflare 代理都必须付费。新增候选为 DNSPod 地区解析加 Cloudflare for SaaS Custom Hostnames；它是另一个官方产品。
- 官方 Cloudflare for SaaS Free 计划包含 100 个主机名，超出后另行计费；非企业启用需要支付信息。使用量配额可能按区域或账户统计，不能把免费额度写成硬性零费用保障。评估没有启用订阅、录入支付信息或创建自定义主机名。
- 网站权威解析迁入 DNSPod 后，境内线路指向国内直连源站，默认／境外线路以 CNAME 指向另一个持续由 Cloudflare 托管的域名中的专用接入名。正式网站主机名需在该 SaaS 区域分别登记并完成域名与边缘证书验证，不能仅复制普通橙云 CNAME 或硬编码公共边缘 IP。
- 海外路径为浏览器到 Cloudflare，再到选定海外节点；地址栏可保持同一正式主机名。国内路径不经过该代理，不获得其防护。DNS 地区判断仍受递归解析器、VPN、缓存影响，免费 DNS TTL 限制不变。
- SaaS 可提供缓存及所属区域套餐范围内的 WAF、DDoS 防护和分析；并不自动升级为付费安全功能。只缓存可安全共享的版本化静态资源，页面、API、鉴权图片与撤回资格仍遵循既有策略。规则应限定正式站主机名，避免影响管理域名既有应用。
- 优先评估 Tunnel 作为海外回源，或严格 TLS、限制来源的 HTTPS 回源；正式站不沿用预览站邮箱登录门禁，管理应用保护不变。源站 Host/SNI、隧道 ingress 及 reader 公开范围需要单独验收。
- DNSPod 官方允许根域名使用 `@` CNAME，同时说明可能影响 MX／TXT 等解析；免费版无 CNAME 展平。因而不能把根域同址方案判定为已验收，也不能仅因无展平就断言一定无法使用。子域名方案更直接；根域需验证多个递归解析器、A/AAAA、证书及未来邮箱兼容。如不满足要求，再由用户选择以 www 为主入口或其他付费根域接入，不能擅自更改规范域名。
- Cloudflare 的 Apex Proxying 固定 IP 能力属于企业付费附加项；默认不支持拿任意 Cloudflare 边缘 IP 写入 A 记录来代替 SaaS CNAME。
- 双路径 HTTPS 包含两套访客证书：国内源站须使用浏览器信任的证书，海外由 Cloudflare 管理边缘证书。需设计各自持续续期，不能假定一次 TXT 验证永久有效；SaaS 续期可能转为 HTTP 验证。分流可能令验证请求到达另一端，因此优先评估可协调的 DNS 验证。若采用 Delegated DCV，须避免与国内源站 DNS-01 使用同一 challenge 名发生冲突，不能一边委派一边独立覆盖 TXT。
- 本次仅核对官方资料和本地记录，无项目云数据库／对象存储请求，未读取后台账单或确认账户剩余额度；公共资料读取估计数 MB。没有 DNS、服务器、凭据、订阅或调度修改。产品能力层面可行，当前账户激活、根域兼容、双端续期及真实分流仍待另行授权试验。
- 下一步建议是先批准小范围验证方案：独立测试主机名、SaaS 额度及账单确认、双端 HTTPS、静态缓存 HIT、管理入口隔离、内容撤回与地区 DNS 检查；不得将测试授权扩大为正式主域切换。

补充资料：[SaaS 套餐](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/)、[启用要求](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/enable/)、[接入流程](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/)、[缓存](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/performance/cache-for-saas/)、[根域代理](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/apex-proxying/)、[DNSPod CNAME](https://cloud.tencent.com/document/product/302/3450)、[证书续期](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/certificate-management/issue-and-validate/renew-certificates/)、[SaaS DCV 委派](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/certificate-management/issue-and-validate/validate-certificates/delegated-dcv/)。

## 官方依据

- [DNSPod 智能解析线路](https://cloud.tencent.com/document/product/302/8643)
- [DNSPod 版本对比](https://cloud.tencent.com/document/product/302/106264)
- [DNSPod 子域名托管](https://cloud.tencent.com/document/product/302/79793)
- [Cloudflare Partial CNAME 接入](https://developers.cloudflare.com/dns/zone-setups/partial-setup/)
- [Cloudflare Tunnel DNS](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/)
- [Cloudflare 代理功能](https://developers.cloudflare.com/dns/proxy-status/)
- [Cloudflare 区域状态](https://developers.cloudflare.com/dns/zone-setups/reference/domain-status/)
