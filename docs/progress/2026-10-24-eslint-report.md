# 2026-10-24：引入 ESLint 与 React Hooks 规则，只报告（Claude）

编辑登记：
- 新增 `eslint.config.js`。
- `package.json`：新增开发依赖和 `lint` 脚本。
- `package-lock.json`。

没有改应用代码，也没有把 lint 接进 `npm run check`。

用户同意引入 ESLint 和 React Hooks 规则，要求先只报告、不自动改代码，并列出会报的地方。

## 装了什么，为什么这样装

- **开发依赖，版本写死**，只用于开发，不进网站：
  - `eslint` 10.13.0
  - `eslint-plugin-react-hooks` 7.1.1
  - `@babel/eslint-parser` 8.0.7
  - `@babel/core` 8.0.9

  连同它们的依赖共新增 145 个包。
- **为什么不用常见的 typescript-eslint**：项目用的 TypeScript 7 没有 JS 接口，而 typescript-eslint 要求 TypeScript 低于 6.1，npm 直接拒绝安装。用 `--legacy-peer-deps` 硬装的话，以后所有安装都得带这个开关，所以没这么做。
  - 现在改用 Babel 的解析器，它只读语法，不依赖 TypeScript，对 Hooks 规则来说够用了。类型检查照旧由 `npm run typecheck` 负责。
  - 也试过 oxlint：只有 2 条经典规则，查不到插件 7.x 新增的 React 编译器检查，所以没选。
- **两个原有的数据包小升级**：Babel 依赖的 `browserslist` 要求更新版本，所以 `caniuse-lite`（1.0.30001815 → 1.0.30001819）和 `baseline-browser-mapping`（2.11.28 → 2.11.32）各升了一点。新版本仍在 Next 允许的范围内，生产构建照常通过。
- **范围**：`src/app`（不含后端的 `api`、`media`）、`src/components`、`src/lib`；`src/server` 不查。
- **规则**：插件的 `recommended-latest` 规则集，共 17 条，没有加别的规则。
- **运行方式**：`npm run lint`。现在有报告，所以退出码非零。

## 报了什么（31 处，`npm run lint` 原样可复现）

逐处读过代码后分三类。没有一处违反 Hooks 调用规则本身（`rules-of-hooks` 为 0）。

### 值得改（2 处）

- `components/lightbox.tsx:66`（refs）：渲染时直接从 ref 里的图片登记表读当前图片。登记表变了不会触发重新渲染。审查时记下的“图片注销后看大图变空白却不关闭”就出在这里，改成把登记表放进 state 或在变化时通知。
- `components/list-tail.tsx:44`（set-state-in-effect）：`slow` 在 `pending` 变成 false 时由 effect 重置。可以改成 `slow && pending` 直接推出来，少一次渲染。

### 有意为之、可以改写来消掉报告（行为不变）

- **服务端组件里 try 包着取数据和 JSX**（error-boundaries，9 处）：
  - `app/page.tsx:19`
  - `app/study/[course]/notes/layout.tsx:23、24（3 处）、33`
  - `app/study/[course]/page.tsx:32（2 处）`
  - `app/library/[type]/[slug]/page.tsx:154`

  这些 try 要接的是取数失败，不是渲染错误，意图是对的。把 JSX 挪到 try 外就不会报。
- **属性或路径变了，在 effect 里同步改 state**（set-state-in-effect，9 处）：
  - `course-tree.tsx:34`：当前页所在的分支自动展开。
  - `lightbox.tsx:84`：预览已经足够清晰。
  - `lightbox.tsx:211`：要读 DOM 上图片是否已加载完，只能在 effect 里。
  - `nav-links.tsx:57`、`theme-toggle.tsx:130`：挂载后才读路径和本地存储，保证首屏和服务端一致。
  - `search-palette.tsx:90`：清空输入时重置结果。
  - `study-reading-directory.tsx:25`：换页后关闭目录抽屉。
  - `use-paged-list.ts:93`：首页数据变了就重置列表。
  - `works-shell.tsx:55、115`：切换动画的阶段。

  多数可以改成渲染时调整或用 `key` 重置，但收益只是少一次渲染。其中 `nav-links` 和 `theme-toggle` 那两处为了和服务端一致，应该保持现状。
- **渲染时更新 ref 里的最新值**（refs，3 处）：`lightbox.tsx:120`，`use-paged-list.ts:114、116`。这是让事件处理读到最新值的常见做法，在并发渲染下理论上可能写入一次被丢弃的值，影响很小。

### 误报或已有说明（7 处）

- `components/blocks.tsx:79`（static-components）：`headingTag` 返回 `"h2"` 这样的字符串标签，不是新建的组件。
- `components/home-timeline.tsx:105`、`components/reading-outline.tsx:75`（immutability）：`map` 回调在渲染中同步执行，改的是渲染内的局部变量，不会出问题。
- `components/lightbox.tsx:96`（exhaustive-deps）：`photoSrc` 只出现在开头的判断里，而且总是和 `photoKey` 一起变。
- `components/study-reading-directory.tsx:67`（exhaustive-deps）：清理时读 `trigger.current`，按钮一直挂着，不会变。
- `components/use-dismiss.ts:40`（exhaustive-deps）：依赖只放 `open` 是有意的，注释写明了原因。

## 怎么验证的

- 从锁文件全新安装（`npm ci`），`npm run lint` 能正常解析全部 189 个文件，没有解析错误。
- `npm run check`、`npm run privacy:check`、`npm run build` 的结果见合并请求。check 里失败的仍是本机 Node 26 跑不了的那 4 个后端文件。

## 限制与下一项

- lint 还没接进 `npm run check`，也没接进 CI。等上面这些报告改完或标注完，再决定是否接进去、哪些规则作为错误拦下。
- 下一项建议先改“值得改”的两处，再按需要逐个改写“有意为之”的写法，或者在代码里标注后关掉对应的报告。
