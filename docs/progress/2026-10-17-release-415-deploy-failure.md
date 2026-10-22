# 2026-10-17：发布 415 部署失败，拿掉 413 的函数区域配置后重发（Claude）

编辑登记：Claude 本轮只改 `vercel.json`（删掉合并请求 413 加的 `functions["src/proxy.ts"].regions`），新增这条记录。其余代码、契约、路由、fixtures、依赖、栏目开关与全局入口未改。

## 经过

- 发布请求 415（develop `3d5bf42` → main，用户指定由 Claude 合并）平台检查通过，2026-10-17 11:54:32 UTC 合并（main `b983811`）。
- Vercel 正式部署 11:55 失败，构建一开始就报：`Error: [unused_function] The pattern "src/proxy.ts" defined in \`functions\` doesn't match any Serverless Functions.`（`vercel inspect dpl_Fh2m9fdCwuFHDzt9z8kHb3sEDmjJ --logs`）。正式站点一直停在上一个成功部署，访客不受影响，这次发布的内容没有上线。
- 原因：413 把请求入口 `src/proxy.ts` 写进 `vercel.json` 的 `functions` 指定区域，但 Vercel 构建时不把它当成可匹配的函数。平台检查（本机构建）看不到这一步，只有 Vercel 构建才会校验。

## 处理

- 只删掉这一段配置，`vercel.json` 回到上一次成功部署时的内容（与 `5c066c3` 逐字相同）；413 的说明文档保留，后端另找写法。
- 再走一次 develop → main 发布。

## 给后端

请用 Vercel 认可的方式把请求入口放到数据区域（或确认做不到）；改了以后要在 Vercel 预览部署上确认能构建，不能只看本机构建。
