# 2026-11-02：本站关闭 Cloudflare Rocket Loader

用户要求按 F54 交接关闭本站 Rocket Loader，由 Codex 负责云端配置。

本站使用 Next 的流式 HTML、hydration 与首绘前主题脚本。Cloudflare 不应通过 Rocket Loader 改写这些脚本的类型和执行时机；本站区域关闭该功能，应用脚本保持原样。后续部署或代理配置接续时须保留此设置，避免重新引入主题首绘与流式占位延迟。

本决定只涉及本站的脚本优化，不更改 DNS、源站、TLS、安全策略、页面／图片缓存或其他性能开关。实际执行与有界验收见[本轮记录](../progress/2026-11-02-f54-rocket-loader-off.md)。
