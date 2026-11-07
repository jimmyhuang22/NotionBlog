# 2026-11-07：公开网站基础 CSP 观察策略（Codex）

## 范围

- 从 develop `5d999a2` 建立 `codex/csp-report-only-20261107`。用户同意先开始 CSP，采用交接审阅后的无 nonce 基础策略。
- 公开网站在 `next.config.ts` 的响应头规则增加一条 `Content-Security-Policy-Report-Only`。允许 Next Flight、主题启动脚本和渲染器所需的内联脚本与样式。资源默认同源，明确保留图片、字体和 worker 等所需的 `data:`、`blob:`，并将 frame 和 object 加载列为违规。现有强制 `frame-ancestors 'self'`、离线演示的隔离策略和详情页 ISR 沿用原设置。
- 策略没有上报地址。观察从浏览器取证，接口、内容 provider 和缓存配置沿用既有设置。

## 验证与后续

- Node 24 完整 `npm run check` 通过 3,311 项，无失败或跳过。普通构建和公开自托管构建通过，各核查 49 个服务端追踪文件。
- 用公开自托管生产产物和虚构数据在本机 Chrome 验收 12 条路径，包含动态展开、课程及笔记、作品、相册灯箱、搜索、浏览器代码和公式渲染、404 及 503。两条 CSP 响应头均符合预期，正常操作未触发违规。故意触发的脚本违规发出 disposition 为 `report` 的事件，测试脚本仍执行。
- 正式首页只读抽查一次，压缩响应 19,009 字节。该次 HTML 没有外部脚本标签。
- 后续按正式发布流程部署观察策略。历史浏览器记录曾出现 Cloudflare Analytics beacon，观察期需覆盖真实数据页面和代理注入的资源，再决定是否切到强制。见[交接方案](../BACKEND_HANDOFF_PLAN.md)与[历史浏览器记录](2026-11-04-home-first-visit.md)。
