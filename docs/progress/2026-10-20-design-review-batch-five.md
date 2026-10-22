# 2026-10-20：设计自检第五批落地（Claude）

编辑登记：Claude 本轮修改 `src/components/status-body.tsx`、`src/components/lightbox.tsx`、`src/components/home-timeline.tsx`、`src/components/pen-once.tsx`（新增）、`src/lib/pen-once.ts`（新增）、`src/app/page.tsx`、`src/app/layout.tsx`（只在页首脚本后加一段笔划标记）、`src/app/globals.css`、`src/app/motion.css`、`src/app/prose.css`、`src/app/study.css`、`src/app/timeline.css`、`src/app/skins.css`，新增决策记录。契约、接口与媒体路由、fixtures、依赖、栏目开关、全局入口与后端代码未改。

决定见[决策记录](../decisions/2026-10-20-design-review-batch-five.md)。

## 改了什么

- 收起：`StatusBody` 收起时先给完整卡片加 `is-folding`（`motion.css` 的 `fold`，0.25 秒），动画结束（或 450 毫秒兜底）后再收起；收起后如果这一条的顶边在吸顶页头之下被遮住，就 `scrollBy` 回到顶边上方 16 像素处。减少动态时跳过卷回，滚动也改为瞬时。
- 看大图：两枚导航按钮换成 30×30 的一笔箭头（纸色，无圆底，52×52 点按区），照片两侧预留从 108 调到 124；计数 `.lightbox__count` 用文楷；说明是纸色小条。
- 深色令牌：两处深色块里 `--card`、`--soft` 同步修改。按 WCAG 计算的对比度：灰字在卡片上 5.14，在浅灰块上 4.59，正文字 11.29。
- 千禧：`.hero__name` 与 `.site-header__brand` 使用渐变裁切文字、0.6px 描边和两层投影。
- 首页：`entry__latest` 文案改为“最新动态”。
- 手机课程页：540 宽以下隐藏 `.course-head__cover` 和 `--failed` 占位，资料按钮 `flex: 1 1 0` 并排。
- 笔划：页首脚本在会话存储里有 `pen-drawn` 时给 `<html>` 设置 `data-pen="drawn"`；首页（不是头像区组件，因为加载骨架也会渲染头像区）挂 `PenOnce`，挂载时写入会话存储，1.3 秒后或离开页面时打上标记；`[data-pen="drawn"]` 关闭笔划动画。
- 悬停：`.bili-card__frame`、`.works-card__frame` 的过渡改为 `0.3s cubic-bezier(0.3, 1.3, 0.5, 1)`。

## 怎么验证的

- 原型阶段：新版正式站（动态展开后收起、相册看大图、首页深色、千禧首页、首页“最新”、课程页 390）注入样式拍对照，每页访问一次。
- 实现之后（`next start`，演示数据，无头 Chrome 1x）：
  - 笔划：新会话首次打开首页时，在 DOMContentLoaded 后 300 毫秒检查，`pen-stroke` 动画正在播放，没有 `data-pen`；同一会话刷新后有 `data-pen="drawn"`，没有笔划动画。首页标签显示“最新动态”。
  - 看大图：两枚手绘箭头，计数为文楷，说明在纸条上。
  - 深色：卡片背景是 `rgb(38, 42, 53)`；千禧的名字和站名是镀铬字。
  - 手机课程页：把规则注入正式站的 样本课程 C 课程页（390 宽），第一条目录从 724 提到 476，两个按钮在同一行，无横向溢出。
- 类型检查、样式测试、构建通过；完整检查见合并请求。

## 限制与下一项

- 收起的卷回和滚回只能在真实长动态上看（演示数据的动态没有完整正文），要在下次发布后去正式站核对。
- 二十六（苹果、千禧的切换动效）先出逐帧原型。之后按 F40 交接包，给作品页平台切换加卡片依次进场。


隐私整理：本文的个人站点地址、课程代号及笔记定位按需泛化；原样本与回执保留在私有记录，技术测量和当时验收结论不变。
