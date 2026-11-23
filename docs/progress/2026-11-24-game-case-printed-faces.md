# 2026-11-24：游戏卡盒照实物印顶条（Claude）

- **页面**：游戏库 `/library/games` 的卡盒和“最近在玩”转盘，共用 `GameCase`。
- **组件**：`src/lib/library.ts` 的 `gameCaseLook` 按卡盒显示的平台名定样式（ps5／ps4／ps／switch2／switch，Steam、PC、3DS 照旧）。`src/components/game-case-marks.tsx` 是按照片像素画的 PS 顶条标志、Switch 2 标志和 Switch 红色方块，`game-case.tsx` 按样式放顶条或方块；`library.css` 写边框、顶条高度、标志宽度和颜色，左边不画边框。`game-tag.tsx` 多导出图标路径，标签本身不变。[决策](../decisions/2026-11-24-game-case-printed-faces.md)。
- **量法**：用户发的五张实物照片逐像素量边框、顶条、图标和字的位置，换算成卡盒宽度的比例。原型和量出的数字在前端忽略目录 `.local/previews/game-case-real-20261124/`（`build-real.py` 文件头）。
- **验证**：本机 `npm run check`、`npm run build`。临时预览页（未提交，已删）用 13 张真实竖图渲染真组件，在 300、214、150 三种高度看过浅色和深色，150 以 2× 复看；覆盖 PS5、PS4、无型号 PlayStation、Switch 2、Switch、无竖图的横图回退和 Steam 对照。没有用真实数据跑整站。
- **限制**：正式数据的 PlayStation 游戏现在都只写“PlayStation”，上线后都会是白条加 PS 图标；要印 PS5／PS4，得等 Codex 确认改名无影响后在 Notion 改写平台名（后端交接第二十一节）。NINTENDO SWITCH 字样用系统字体按量出的宽度拉伸，字形与官方略有差别。
- **下一项**：Codex 确认并改写 PlayStation 平台名后，在真实数据下复看两种 PS 盒。
