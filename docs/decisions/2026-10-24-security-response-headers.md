# 2026-10-24：补齐生产基础安全响应头

用户审阅最小方案后，明确批准本地实现与离线验证：从最新 develop 建立独立分支，补齐以下基础响应头，不推送、合并、部署、访问真实服务或恢复任务。

| 响应头 | 值 | 范围 |
| --- | --- | --- |
| X-Content-Type-Options | nosniff | 按已声明 MIME 处理资源 |
| Referrer-Policy | strict-origin-when-cross-origin | 跨安全站点只发送来源，不发送页面路径与参数 |
| Content-Security-Policy | frame-ancestors 'self' | 生产页面仅允许同源页面嵌入本站 |
| X-Frame-Options | SAMEORIGIN | 与 CSP 嵌入限制一致的兼容回退 |

外站通过 iframe 嵌入本站会受到限制；这不限制本站引用外部 iframe，也不等于完整的脚本资源 CSP 或防 XSS 验收。未确认允许的外部嵌入来源不自动加入白名单。

开发、离线演示和 Preview 继续使用原有强隔离 CSP 及 noindex，不能被生产仅含 frame-ancestors 的策略替换。媒体的 Referrer-Policy 保持更严格的 no-referrer，包括重定向和错误响应。HSTS、缓存规则、媒体 MIME、来源公开资格、reader 权限与接口契约不变。

本项补充 [开发出站隔离](2026-10-20-development-egress-guards.md)，不扩大任何真实访问授权。通过本机 check／build 和离线响应核对后只交付本地差异；正式发布仍遵守 [main 发布约定](2026-10-12-no-direct-merges-to-main.md)。
