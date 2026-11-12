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

用户确认方向后，先完成受保护预览入口迁移设计、新公开 HTTPS 和旧入口跳转配置、完整 DNS／规则备份与回退设计，再进行不切正式 DNS 的验收。海外正式节点需明确选定；试验节点不自动成为正式内容源。

## 官方依据

- [DNSPod 智能解析线路](https://cloud.tencent.com/document/product/302/8643)
- [DNSPod 版本对比](https://cloud.tencent.com/document/product/302/106264)
- [DNSPod 子域名托管](https://cloud.tencent.com/document/product/302/79793)
- [Cloudflare Partial CNAME 接入](https://developers.cloudflare.com/dns/zone-setups/partial-setup/)
- [Cloudflare Tunnel DNS](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/)
- [Cloudflare 代理功能](https://developers.cloudflare.com/dns/proxy-status/)
- [Cloudflare 区域状态](https://developers.cloudflare.com/dns/zone-setups/reference/domain-status/)
