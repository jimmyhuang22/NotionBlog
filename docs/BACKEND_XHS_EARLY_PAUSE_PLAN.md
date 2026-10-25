# 小红书早期失败的持久暂停方案（N05）

状态：用户已明确批准以下源码、离线测试与常规 develop 交付，实施结果见[进度记录](progress/2026-10-25-xhs-early-pause.md)。基线为 develop `b13957556500f931fdeceda4bf61b7a4de1175b0`。本方案没有真实任务恢复或运行包安装许可。

## 复现与边界

`uploadBrowserNotes` 在发现及 HTTP scope 检查之后才设置 scopeDigest，catch 的 pause 又以该值为条件，导致早期非 BUSY 失败不写 HTTP 手工恢复闩。普通 HTTP 周期以 health.manualRequired 为闩；浏览器补采依赖自己的 state，两者不是同一个暂停。

在临时虚构运行目录调用真实 `handleXhsBrowserNotes`，分别损坏发现状态与 HTTP policy，并覆盖有／无既有健康回执，共四种情况：均报告失败并释放两把锁，但没有新 HTTP 暂停，浏览器 state 仍 complete。随后损坏主配置，真实补发 notes-pause 同样失败，说明不能仅依赖扩展的补发消息保证持久暂停。Cloud prepare 调用为零，无来源或项目请求，临时目录已清理。

另用现有 writer 写全零 scope，并交给真实 `runHttpNoteCycle('run')`：解析成功，manualRequired 保留，prepare／execute 均为零。全零是既有“尚未取得 scope”占位，不代表任何真实 scope 或发布资格；已有 health 的 scope 会由 writer 保留。

只补 HTTP health 不能声称浏览器自动行为全部停止。正常浏览器异常仍有独立暂停／显式恢复规则，本次保留两条 lane 的差异。

## 完整实施范围

1. **可靠写 HTTP 闩。** 私有上传 pause 无条件尝试现有 `recordExternalHttpPause`，使用本次已验证 scope 或既有全零占位。保留 writer 对旧 scope、历史时间和成本的保留行为，不用 policyDigest 冒充 scope，不在 catch／finally 重读配置。
2. **在已持有的浏览器锁内写本 lane 暂停。** 使用已经验证过的 policy digest 重新读取最新 browser state；对尚未 paused 的状态持久置 paused 和受控失败码。保留 job、lastSubmission、browserIds 以及独立 recovery ticket；已经 paused 的原原因／已接受恢复状态保持，不能用外层旧快照覆盖子流程写入的 accepted 状态。该写入不依赖再次读取损坏的主配置或 HTTP scope。
3. **两项写入各自尝试，保留首错和清理。** 一项写入失败不阻止另一项；固定诊断表明未能完整写暂停，不输出正文、配置或任意异常详情。原上传异常继续抛出，锁与云资源仍全部清理，BUSY 继续只延期，不新增暂停或覆盖旧暂停。close-only 失败沿原失败规则处理，已有业务错误不被 close／pause 异常替代。
4. **同类 HTTP CLI 发现异常。** 该入口目前在 catch 内调用 checked().scope 以后才写暂停，配置消失时同样会失败。改为只使用本次成功 checked 时保存的摘要或全零占位；不在异常路径重新做 scope/config 检查，不改 run／resume 命令或原手工恢复规则，写暂停失败不能覆盖原发现异常。

预计主要源码为 `scripts/social-sync/xiaohongshu-browser-notes.ts`、`http-cycle-cli.ts`，必要时复用 `xiaohongshu-http-cycle.ts` 的窄 helper；保持 HttpHealth／BrowserState 字段与版本、原生消息、共享 DTO、依赖、锁语义和恢复入口。测试使用本机临时虚构状态，不修改共享演示 fixtures 或真实运行目录。

本项只覆盖已验证运行上下文、进入发现／上传阶段后的失败；尚未通过根目录或身份检查的入口拒绝不强行写暂停。文件系统不可写／状态损坏时不能承诺全部持久写入成功，保留原错误并明确诊断。

## 定向验收与验证节奏

- 两个早期失败点 × 有／无旧 health：新失败可见、manualRequired 生效，未知 scope 用全零；旧有效 scope／时间／成本不丢失，后续普通 run 不 prepare／execute。
- 配置在失败时消失、扩展补发 pause 不可用：本 lane 的已验证最新 browser state 已暂停；配置修复后自动入口仍停，显式恢复沿原规则工作。
- 已有 paused、恢复 accepted、未知上传／已采证据不被外层旧状态覆盖或重采；手工浏览器恢复与 HTTP 手工闩的独立关系保持。
- BUSY 不新增／覆盖暂停；写状态或 close 再失败仍保留原错误，并释放所有锁；一项暂停写入失败仍尝试另一项。
- HTTP CLI 发现错误后配置损坏，不在 catch 再读配置；首错、已有健康回执和资源收尾保持。

开发阶段只跑这些直接相关回归与类型检查，整组源码稳定后集中一次完整 check 和离线 build；已有 Node 24、双锁依赖、字体和外部出站守卫复用，无安装／下载。后续仅因新变化、实际失败或集成疑点补验受影响范围。常规 PR 指向 develop，核对发布暂停及受检／生成／实际合入差异后普通合并；平台正常 PR／push 自动 CI 与本机分开，不手动派发。

## 已批准的范围

上述源码、局部虚构测试、必要需求／决策／进度记录及常规 develop 交付，包含正常自动 CI。真实浏览器／来源／数据库／Storage／网站请求、真实配置或凭据读取／修改、暂停目录写入、运行包安装、任务恢复、main 发布和部署均不包含。补丁交付不等于既有任务已采用或已恢复，也不追加持续授权。
