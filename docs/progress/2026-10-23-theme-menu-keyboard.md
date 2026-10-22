# 2026-10-23：主题菜单的键盘操作（Claude）

编辑登记：分支 `fix/theme-menu-keyboard`，从 develop `abfe3a6` 开出。只改 `src/components/theme-toggle.tsx`、`src/lib/skins.ts`、`tests/skins.test.ts`、`docs/FRONTEND_GUIDE.md` 的主题切换一段和本记录；依赖、契约、fixtures、栏目开关、全局入口与后端路由都没有动。

这是前端交接包（2026-10-23，私人目录）里的第一优先项 U10。

## 问题

主题菜单里的四套主题声明为 `role="radiogroup"` 与 `role="radio"`，但四个按钮各自都是 Tab 停靠点，也没有方向键处理：键盘用户要逐个 Tab 再按空格，和单选组的声明不一致。在 develop `abfe3a6` 的代码里可以直接核对：四个按钮没有 `tabIndex`，菜单打开时的键盘监听只处理 Escape。

## 改了什么

- **单一 Tab 停靠点**：当前选中的主题 `tabIndex=0`，其余 `-1`。从“主题”按钮按 Tab 进组时落在当前主题上；再 Tab 到“明暗跟随系统”开关，再 Tab 离开菜单（失焦关闭，和原来一样）；Shift+Tab 回到“主题”按钮。菜单收起时面板是 `display: none`，选项不参与 Tab。
- **方向键移动并选中**：在组上监听 keydown，右／下到下一套，左／上到上一套，顺序按 `src/lib/skins.ts` 的清单（墨水、苹果、岛屿、千禧），两端循环；移动即选中，焦点跟到新选项，页面外观、`aria-checked`、根元素属性和存储同步变化，和原生单选一致。只在组内 `preventDefault`，页面其他地方的方向键和滚动不受影响。没有加 Home／End：单选组的键盘模型里它们是可选项，这次只补必要的。
- **不重复执行**：空格和回车仍是原生点击，`chooseSkin` 对已选中的主题直接返回，所以方向键选中后再按空格或回车不会再跑一遍切换动效。
- **顺序计算抽成 `skinAfter(id, steps)`** 放在 `skins.ts`，`tests/skins.test.ts` 新增一条测试覆盖前后移动与两端循环。
- **连续切换时清掉上一次动效的标记**：原来 `applyChoice` 只由最新一次切换收尾、删除自己的根标记（`data-theme-spread` 等），被替换掉的那次标记会留在根元素上，之后的一次切换会同时套上几种动效的规则。方向键让连续快速切换成了常态，所以新动效开始时先删掉其他动效的标记。只由最新动画收尾的保护保持不变。

Escape 关闭并把焦点还给“主题”按钮、点击外部关闭、失焦关闭、跟随系统开关、千禧固定浅色的提示和去掉开关、存储读写失败的降级、减少动态效果时直接切换、标签页图标跟随，这些都沿用原实现，没有改外观。

## 验证

离线演示模式（`npm run dev`，只有演示数据），本机 Google Chrome 无头模式经 DevTools 协议驱动，脚本在会话暂存目录，不进仓库。截图 1 倍。

宽度 1440、390、320，以及 720（当作 1440 的 200% 缩放），每个宽度跑同一套按键，结果全部一致：

1. 从页面 Tab 到“主题”按钮（路径：跳到正文、站名、动态、学习、搜索、主题），回车打开，`aria-expanded` 为 true。
2. Tab 落在当前主题“墨水”，四个选项里只有它 `tabIndex=0`；焦点框完整落在面板内，面板在视口内，页面没有横向溢出。
3. 右、下、右、右、左、上依次得到苹果、岛屿、千禧、墨水（循环）、千禧（反向循环）、岛屿；每一步焦点、`aria-checked`、根元素的 `data-skin`／`data-theme`、`localStorage` 同步；到千禧时 `data-theme=light`，开关换成“这套主题只有浅色”，离开千禧时恢复开关。
4. 在选中项上按空格、再按回车：选中不变，菜单仍开着。
5. Tab 到“明暗跟随系统”，空格关掉（`theme=light` 写入存储）、再按打开（存储清掉）；再 Tab 离开，菜单关闭，焦点在明暗按钮；Shift+Tab 回到“主题”（面板已隐藏），再 Shift+Tab 到“搜索”，收起的选项没有占 Tab。
6. 重开后 Tab、左、Escape：菜单关闭，焦点回到“主题”按钮。
7. 鼠标：点开、点“苹果”、在页头空白处按下关闭。
8. 一轮结束等待后根元素上没有残留的动效标记。
9. 控制台没有异常。

另外三个分支（1440 与 390）：已存偏好（岛屿＋深色）、系统深色、减少动态效果——加载后菜单 Tab 落在岛屿，方向键到千禧变浅色、到墨水保留深色，根上没有动效标记；`localStorage` 抛错——仍能用方向键切换，Escape 正常。截图：岛屿主题下焦点在“岛屿”上的菜单，1440 与 320 各一张。

工程检查：`npm run typecheck` 通过；`npm run check` 在本机（Node 26.11.1）以 28 个失败结束（2567 项里 2539 通过），都是本机 Node 版本的已知条件、与本改动无关：`tests/website-v2-runtime.test.ts` 与 `tests/qualified-shared-budget.test.ts` 的 23 个是子进程的 `dyld: Library not loaded libnode.147.dylib`；`tests/capture-recovery-admission.test.ts` 与 `tests/capture-recovery-host.test.ts` 的 5 个是 `scripts/website-sync/release.mjs` 的 `verifyRelease` 只接受 Node 24 而报 `RELEASE_INVALID`。这些文件都不引用本次改动的模块；其余测试（含 `tests/skins.test.ts` 新测试）通过。`npm run build` 与 `npm run privacy:check` 通过。没有平台检查（私人 PR 的应用检查为 SKIPPED，不算通过）。

一个观察，不是本改动引入的：一次主题切换还没结束就开始下一次时，Chrome 会把被替换的 view transition 记成 `AbortError: Transition was skipped`，在页面上直接连调两次 `document.startViewTransition` 就能看到；最终一轮里网站自己的流程没有再出现。

## 限制

- 桌面无头浏览器模拟，不是真机，也没有完整读屏走查；200% 缩放用 720 宽视口近似。
- 只在演示数据下验证；菜单外观没有改，没有逐一截四套主题乘深浅两色。
- 方向键顺序是清单顺序，面板里是两列网格，所以“下”走的是清单的下一项而不是视觉上的下一行；这是单选组的常规做法，也避免为两列另定规则。

## 下一项

把受检提交、文件范围、验证方式和本记录回交 Codex 核对集成影响。交接包里其余候选（U02、U03、U06～U09、U11～U18）按包内状态逐项复核，包建议 U10 之后先做 U06 外链作品在触屏上的辨认。
