# 源码隐私扫描与历史范围

扫描器是规则检查，不是所有秘密均不存在的证明。个人资料及 blocklist 留在忽略目录；GitHub 原生密钥扫描／推送保护另有自己的覆盖。

## 本机入口

```sh
node scripts/check-privacy.mjs
node scripts/check-privacy.mjs --staged
node scripts/check-privacy.mjs --history HEAD
node scripts/check-privacy.mjs --range BASE..HEAD
git rev-parse HEAD | node scripts/check-privacy.mjs --commits-stdin
node scripts/check-privacy.mjs --capabilities
```

无参数检查跟踪及未忽略候选，暂存模式检查索引；history／range 读取逐提交完整树，保留中间加入后删除与合并侧链。`BASE` 要替换成实际基线。集合入口只接受完整 commit OID，范围选择器负责加入每个非删除目标完整树，空差集不能免检目标。能力声明版本为 2，不读取 Git 或本机 blocklist。

历史／集合要求完整对象图，拒绝浅库、graft、缺失对象及超限，禁用 replacement 和隐式 lazy fetch。读取失败明确停止，不截断后宣称通过。

敏感键名按完整边界和大小写统一处理，支持完整 TOKEN／PASSWORD／NPSSO 等；通用字面值保留至少 12 字符门槛，符号不是豁免。PostgreSQL URI 与有上下文的 libpq conninfo 另行检查，远端非空密码不受通用门槛免除。空模板、完整环境引用和明确整值占位符可继续使用；受检虚构兼容是明确整值及必要 key／路径范围，任意 example／fixture 前缀和 tests 路径不构成免检。

`.local/privacy-blocklist.json` 缺失可选，存在但语法／结构／读取错误时固定拒绝，不降级为空名单。匹配内容与原始 JSON／Git 异常不输出；路径转义，路径本身若命中秘密格式或私有名单则脱敏。短／未知秘密、编码／拼接与复杂动态语法仍可能漏检。

## 推送政策

hook 先做原工作区检查，再按 `scripts/privacy/history-policy.json` 核对实际目的地、仓库身份、版本和固定 legacy anchor。目的地匹配是本机规范化，不是实时服务器身份审计。每个非删除分支检查 anchor 之后的全部可达提交，并总查目标完整树；多个 ref 去重，不排除任意 remotes，不因远端已有 SHA 就当作受检。本机不为 before 自动联网。删除不增加上传对象；其他 ref 使用明确 commit-only 完整历史，不能剥离为 commit 的 blob／tree ref 拒绝。

anchor 只划出既有公开历史，新规则首次采用须记录旧史审计及发现。它不自动跟随 develop 前移，未来调整须审核新增排除范围及规则版本。移植其他目的地须单独审阅政策／基线，不能直接复用本仓库豁免。

## CI 与采用顺序

| 工作流 | 行为 |
| --- | --- |
| Repository privacy | 分支 push、main／develop 目标 PR、显式手动输入；无共享并发、依赖安装、应用 cache 或候选 checkout |
| Repository checks | 仍仅 PR／手动；先可信早期扫描，再按原隔离规则检查候选应用；双锁安装、必需检查名及应用取消机制保留 |

PR 扫描器取固定 base SHA；topic push 从受保护 develop 解析并冻结，main／develop push 使用 before。手动 `trusted_branch`、完整 `target_oid` 和 `history_mode` 分开记录。CI 分支 push 还检查 before／after 双侧历史及树；缺旧对象时失败，不改扫新 tip 后记旧事件成功。

首次旧 base 仅可走已审精确哈希的 legacy 引导，旧输出全部抑制，只打印固定状态、安全计数、退出码和来源；不能称新规则已过。未知版本拒绝。新脚本先由本机审阅和离线回归验收，合入 develop 后后续开发 PR 才取得新可信规则；main 随独立发布采用。默认分支手动表单／新工作流尚未协调采用前，不据源码合入 develop 宣称入口已获平台验收，不为此代合 main 或派发任务。

候选 YAML、skip 指令、工作流不存在、外部贡献者审批、人工取消及平台限制仍可能使扫描不运行。无并发组解决工作流主动取消旧扫描，不是不可绕过政策或服务端上传前阻断。required workflow／外部控制器／仓库设置另审，失败、取消及 SKIPPED 如实保留。

具体范围与受检结果见[实施方案](BACKEND_PRIVACY_CI_PLAN.md)和[进度记录](progress/2026-10-25-privacy-ci-scanning.md)。
