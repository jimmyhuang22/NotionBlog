# 2026-10-25：控制台下架接线与验收暂缓（Claude）

## 编辑登记

修改 `scripts/console-bridge/takedown.ts`、`console/lib/types.ts`、`console/lib/demo-backend.ts`、`console/components/takedown-flow.tsx`、[对接协议](../CONSOLE_BRIDGE.md) 与 `tests/console-bridge.test.ts`，新增 `console/instrumentation.ts` 与本记录。没有修改下架工具、同步程序、调度、数据库或网站。

## 改了什么

- **Notion 弹窗链接。** 形如 `…/数据库-<编号>?p=<页面编号>` 的链接，路径里是数据库编号，下架工具只读路径，原样传入会指向整个数据库。桥接命令现在取 `?p=` 里的页面编号，保留原 Notion 主机，只把路径换成该编号，再交给工具。
- **计划目标与租约。** 计划的目标页以计划自身的 `target` 为准；`TakedownPlan.syncBusy` 报告数据库租约字段是否非空。下架工具和数据库函数在租约非空时（过期也算）一律拒绝，所以控制台在这种计划上显示原因并停用确认。
- **控制台 instrumentation。** 没有自己的 instrumentation 时，Next 会打包网站的 `src/instrumentation.ts`，离线开发保护随之拦截控制台在局域网地址上的内部请求（登录后靠整页跳转兜底）。现在控制台有独立的空 instrumentation，构建产物里已无该保护，局域网登录正常。

## 真实接线与计划

- Codex 确认新库的受限下架账号已安装，指明 operator env 与固定运行副本；私有配置已开启下架，Node 用运行副本 manifest 指定的版本。
- 用户选定一条动态作测试页并授权这次验收。经控制台生成一次计划（一次只读查询）：目标即该动态，1 页、1 张图，`sharedOwnerUrl=false`，**`leaseActive=true`**。没有执行，没有写入下架名单或清缓存。

## 验收暂缓

Codex 答复：租约是第 45 轮失败运行留下的、已过期未清空的租约。现在执行，下架工具会拒绝；绕开工具则会清租约、改变运行状态与版本，使来源负责人准备的精确修复失效。约定：

- 等来源负责人完成租约处理、完整发布、后置与收尾后，再重新生成计划；必须仍是 1 页／1 图、`leaseActive=false`、`sharedOwnerUrl=false`，并与来源执行线互斥。
- 恢复要用网站 v2 的管理员 `allow` 命令，由后端在互斥与锁内执行，控制台的下架账号不能恢复。快照仍包含该条时，可以和下架、核验放在同一个短窗口完成；否则需要重新采集发布。所以把“下架 → 核验 → 恢复 → 刷新 → 恢复核验”放在同一轮，用户的授权也要覆盖恢复。

## 验证

`tests/console-bridge.test.ts` 10 项通过（新增弹窗链接一项，测试链接为虚构）、`tests/console-backends.test.ts` 13 项通过；类型检查、`eslint console`（不含构建产物）与隐私检查通过；控制台生产构建通过，构建产物中已不含离线保护；局域网地址登录在 1280 与 390 宽复查正常。真实下架尚未执行。

## 下一项

等 Codex 通知租约处理与来源发布完成后，准备包含恢复步骤的验收单，取得用户对恢复部分的明确授权，再在同一窗口执行。之后考虑在控制台加“恢复”入口（需要后端提供受限的恢复能力）。
