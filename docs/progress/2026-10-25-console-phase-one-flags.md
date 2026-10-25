# 2026-10-25：控制台按能力开关分阶段接入（Claude）

## 编辑登记

修改 `console/lib/types.ts`、`console/lib/demo-backend.ts`、`console/lib/demo-scenarios.ts`、`console/components/sync-panel.tsx`、`console/app/content/page.tsx`、`console/README.md`、[对接协议](../CONSOLE_BRIDGE.md) 与 `tests/console-backends.test.ts`，新增本记录。没有修改网站、契约、数据库协议、同步程序或调度。

## 改了什么

用户要求 Codex 先实现桥接命令的 `status`、`operation.*` 与下架，冻结等新模式上线后再做。为此：

- 能力开关新增 `sync`（整轮立即同步）。关闭时总览的“立即同步”按钮停用并说明“后端还没接上，同步照常定时进行”。
- 内容页遵守 `contentList`：关闭时不再调用内容列表，只提示还没接上，并指向“下架”页。
- 演示新增“第一阶段”场景：旧模式，只有状态、记录和下架可用，其余操作返回 `UNSUPPORTED`。

交接说明写在本机忽略目录 `.local/handoff-to-codex/2026-10-25-console-bridge-phase-1.md`，不提交。

## 验证

只在演示数据下验证。无头 Chrome 1280 宽：第一阶段场景下总览按钮停用并显示原因、内容页显示提示，无报错。`tests/console-backends.test.ts` 13 项通过（新增第一阶段一项）；类型检查、`eslint console`（不含构建产物）与隐私检查通过。改动只在控制台与其测试，不影响网站构建。

## 限制与下一项

桥接命令仍待 Codex 实现。第二阶段（冻结、内容列表、单页同步）等新模式上线。
