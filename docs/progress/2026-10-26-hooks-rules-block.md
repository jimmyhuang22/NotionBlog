# 2026-10-26：两条经典 Hooks 规则接入检查（Claude）

编辑登记：
- `eslint.config.js`
- `scripts/development/run.mjs`（检查清单加一步）
- `src/components/lightbox.tsx`、`study-reading-directory.tsx`、`use-dismiss.ts`

没有改依赖、契约、页面样式或 CI 工作流文件。

用户要求：React 的两条经典 Hooks 规则（`rules-of-hooks`、`exhaustive-deps`）接进检查并能拦下合并，编译器那组检查继续只报告。

## 改了什么

- **规则级别**：`eslint.config.js` 里，两条经典规则设为错误，插件推荐集里其余 15 条编译器检查一律降为警告。
- **接进检查**：`npm run check` 在类型检查之后加一步 `eslint src --quiet`。只有错误会让检查失败，警告不输出。CI 执行的就是 `npm run check`，所以合并请求的平台检查也会带上这一步。想看全部报告（包括警告）仍用 `npm run lint`。
- **修掉原有的 3 处依赖数组报告**，行为都不变：
  - `lightbox.tsx`：加载 1600 版本的 effect 补上 `photoSrc`。它只在开头的判断里用到，并且总是和 `photoKey` 一起变。
  - `study-reading-directory.tsx`：抽屉 effect 开头先把“课程目录”按钮存进局部变量，清理时把焦点还给它。这是规则推荐的写法，避免清理时 ref 已经变了。
  - `use-dismiss.ts`：菜单的 `close` 每次渲染都是新函数，改成放进保存最新值的 ref；依赖数组写全（`open` 和两个 ref），监听仍然只在菜单打开时设置。

## 怎么验证的

- **能拦下**：临时放一个在 `if` 里调用 `useState`、依赖数组又缺项的组件，`npm run check` 在 lint 这一步失败并列出 2 个错误，测试还没开始跑。探测文件随后删除。
- **现状**：`npm run lint` 为 0 个错误、25 个警告。原来 28 处，减去修掉的 3 处。
- 用和 CI 相同的 Node 24.21.0 跑 `npm run check`：3018 个测试全部通过，0 失败、0 跳过，lint 步骤通过；`npm run build` 通过，49 份服务端追踪隐私检查通过。
- 无界面 Chrome，演示数据，生产构建：
  - 主题菜单连开三轮：Esc 关闭并把焦点还给按钮，点外面关闭。
  - 900 宽的笔记页：打开课程目录抽屉，焦点进入抽屉；按 Esc 关闭，焦点回到“课程目录”按钮。
  - 看大图：打开后按 Esc 关闭。

## 限制与下一项

- 合并请求的平台检查会第一次在 CI 上跑这一步，结果以合并请求上的为准。
- 剩下的 25 个警告见 [ESLint 报告](2026-10-24-eslint-report.md) 的分类，都属于有意为之的写法或误报，只报告、不拦截。
