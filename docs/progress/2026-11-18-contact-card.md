# 2026-11-18：联系我（Claude）

编辑登记：Claude 新增 `src/components/contact-card.tsx`、`src/lib/contact.ts`、`tests/contact-card.test.ts`；修改 `src/components/social-links.tsx`、`src/app/layout.tsx`（页脚）、`src/app/globals.css`、`src/app/skins.css`（社交图标规则扩到按钮）；新增决策 `docs/decisions/2026-11-18-contact-card.md`。契约、接口与媒体路由、取数层、fixtures、栏目开关、依赖与后端代码未改；站点配置未改。

## 改了什么

- `ContactCard`：入口按钮＋小卡片（邮箱、写邮件、复制），Esc／点外面／再点关闭，焦点管理，复制失败退回选中地址。
- 社交图标里的邮箱（配置里有 `email` 才出现）改为打开卡片的按钮，不再是 `mailto:` 链接；列表项的 key 不再含地址。页脚最前面加“联系我”。
- 地址由 `contactCode` 编码后交给卡片，页面源码与页面数据里都没有明文地址和 `mailto:`。
- 社交图标的样式规则从 `.socials a` 改为 `.socials :is(li > a, .contact > button)`（globals 与四个主题），只作用在图标本身，不碰卡片里的按钮；页脚 `.site-footer__links a` 改为只作用在直接子链接。

## 怎么验证的

- 新增两个测试：编码可还原、没配置时为空；社交图标与关闭状态的卡片没有明文地址和 mailto，key 不含地址，信封是按钮、其他图标仍是链接。Node 24.21.0：`npm run check` 与 `npm run build`，结果见合并请求。
- 本机正式构建配占位地址 `your-name@example.com`（离线隔离会把站点配置固定为空，所以临时在读取配置处加了一个只在本机生效的文件入口，验证后已还原，未提交）：首页、关于页、动态页的源码里地址与 mailto 均为 0；卡片打开后焦点在“写邮件”、地址正确，Esc 后关闭；无头浏览器没有剪贴板权限，复制走了“请手动复制”的退路。截图：首页卡片墨水与岛屿 1280、墨水 390 与 320、千禧 390、苹果深色 1280；页脚卡片墨水 1280、岛屿 390、墨水深色 390、墨水 320，均无横向溢出。

## 限制与下一项

- 等用户提供邮箱、部署方写入 `SITE_CONFIG_JSON` 后线上才会出现；在此之前两处都不显示（按设计）。
- 真实浏览器里复制成功的路径没有在无头环境验证。
