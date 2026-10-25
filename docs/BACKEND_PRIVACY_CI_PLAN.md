# N03／N07：隐私规则、推送范围与可信 CI 扫描方案

状态：**用户已于 2026-10-25 明确批准源码、离线测试、既有公开历史的本机审计和常规 develop 交付。** 基线为 develop `19f0560542ef3a6a1f0dfea1a3625514e209c44a`；按[本次决定](decisions/2026-10-25-privacy-ci-scanning.md)实施。方案准备时仅有文档与虚构探针，后续实现和验收另见[实施记录](progress/2026-10-25-privacy-ci-scanning.md)。仓库设置、真实凭据、业务状态和正式发布不包含。

## 已确认的问题

- N07：带符号的密码、完整键名 TOKEN／PASSWORD／NPSSO、小写 JSON 键及 libpq keyword 连接串漏检；坏 JSON blocklist 的原始解析错误可能回显输入。示例前缀也不是值安全的证明。
- N03：目前只有 PR／手动检查；工作流级可取消并发会终止旧扫描。仅改为 `cancel-in-progress: false` 仍不足，同组的旧 pending 默认会被新任务替换。
- N07：新分支 pre-push 重扫全部可达历史；直接改成排除所有 `--remotes` 会引入漏检。本机远端跟踪引用不是受检证明，还可来自其他仓库或指向未检查的候选。
- N07：CI 执行候选分支的扫描器，候选可将其改为直接成功。浅历史、Git replacement objects 也能使当前逐提交扫描漏掉内容。

上述结论有本机虚构证据：20 个规则／错误用例 × 3 模式，共 60 次运行，33 次漏报、3 次坏 JSON 回显、24 次对照符合预期；14 个独立 Git 场景覆盖新分支、侧链、force 形状、污染 remotes、浅仓库和替换对象。另有可信来源探针：同一份中间加入后删除的虚构秘密，候选扫描器退出 0，目标提交的扫描器退出 1 且未回显值。临时仓库均已清理；这些不是项目泄漏统计、修复后验收或平台结果。

## 一、扫描规则与错误输出

1. 键名按完整边界、不区分大小写识别已有敏感后缀，并允许名称本身就是 TOKEN／SECRET／PASSWORD／API_KEY／SECRET_KEY／PRIVATE_KEY／NPSSO／DATABASE_URL。通用字面赋值保留既有至少 12 字符门槛，不再按密码字符表排除符号。
2. 单／双引号及裸赋值取完整字面值，处理必要的引号／转义边界；不执行代码，不通过 eval 解析。空模板、完整明确占位符和整个环境变量引用继续兼容；不以 example／fixture 等任意开头直接放行。既有虚构测试值需要兼容时，仅采用可审阅的整值、key／路径范围，不新增文件级免检或自助忽略注释。
3. 保留 PostgreSQL URI 检查，补充有数据库上下文的 libpq keyword conninfo，包括单引号、反斜杠和 host／hostaddr 列表。远端非空字面 password 不受通用 12 字符门槛免除。DATABASE_URL 必须进入连接串分类；明显连接串解析失败应固定拒绝。本机／保留示例域名例外须明确，无法证明为本机的目标不能据此放行。
4. blocklist 缺失仍可选；语法、结构或读取异常均固定非零失败，不回显 Error／stack／cause／JSON 片段，不降级为空名单继续成功。私有 blocklist 不进入 CI。
5. 保留现有凭据格式、路径、签名 URL、暂存真实内容及逐提交检查。诊断只给稳定类别和安全定位，路径需转义；若路径本身命中敏感模式／私有名单，则脱敏定位。原始 Git／解析异常和匹配内容均不转发到日志。

通用短秘密、未知类型、编码／拼接及复杂动态语法仍可能漏检；占位符也可能被使用者当成真实密码。该工具不承诺通过即没有秘密。

## 二、可审阅的提交集合与历史边界

保留现有无参数、`--staged`、`--range`、`--history` 接口，新增完整 commit OID 的 stdin 集合接口；选择提交与检查对象分开。只接受仓库对象格式对应的完整 OID，逐个验证类型，拒绝 ref、选项、缩写和范围表达式；有非删除目标时总要加入其完整树，不能用空范围跳过当前内容。

拟新增版本化历史政策，绑定本仓库的规范化推送目的地、完整 legacy anchor OID 和 policy 版本。候选边界为本项起点 `19f0560`，**它仅划出既有公开历史，不证明祖先已通过新规则**。启用前用新规则做一次本机、只读的既有公开历史审计，保存脱敏发现及处置记录。不能用写入 anchor 消除发现；涉及真实凭据、历史改写或云端处置时另行取得授权。

| 场景 | 拟检查集合 |
| --- | --- |
| pre-push 新分支或已有分支 | 对每个非删除目标 H，检查 `Reach(H) − Reach(anchor)`，另加 H 完整树；多个 ref 合并去重 |
| PR → main／develop | `Reach(event.head) − Reach(event.base)`，另加 head 完整树；保留全部合并父链 |
| CI 非删除分支 push | after 的上述 legacy 集合；before 非零时也检查其 legacy 集合和完整树，以保留 force 更新旧侧的核对机会 |
| 删除 ref | 不产生新的上传对象，记录无需新增对象检查；不将其写成历史通过 |
| 手动检查 | 明确固定受检 OID，选择 legacy 集合或显式完整历史；不能把任意受检 ref 同时当可信来源 |

pre-push 不依赖 before 是否已在本机，也不自动联网；它检查待上传 H。CI 要读取的 before／after／base／head 若不可取得，应明确失败，不能改扫新 tip 后标记旧事件成功。非祖先及完全无关历史仍按集合差检查；不使用 first-parent、时间、最近 N 项或 payload commits 数组替代对象遍历。

anchor 缺失、目标仓库绑定不符、对象缺失、浅仓库、遗留 graft 或预算不足均固定失败，或由操作人员明确选择完整历史模式；不自动更换为 origin/develop／任意 remotes。不自动推进 anchor；以后前移须重新审计新增排除范围并审阅政策。固定 anchor 后的历史会逐渐增长并重复检查，这是本次最小方案的成本，不新增自动通过缓存。

Git 读取禁用 replacement 与隐式 lazy fetch，CI 使用新建对象库／可信目录；候选只作为 Git 对象，不 checkout 或执行其过滤器、hooks、依赖或 npm scripts。文件内容按原始 blob 读取并去重，路径规则仍逐路径应用；超限或读取失败不能截断后报告通过。

本轮服务端新增触发只覆盖**分支** push。现有本机 hook 的非分支 ref 保持明确的 commit-only 完整检查：可剥离为 commit 的 tag 检查其树与历史，blob／tree ref 拒绝；不扩大为 tag 消息、commit 消息、LFS 外置正文或 submodule 仓库内容扫描。

## 三、CI 接线与信任来源

新增独立 `.github/workflows/privacy.yml`，覆盖所有分支 push、发往 main／develop 的普通 pull_request 和手动检查。隐私工作流不设置 concurrency，不因新推送自动取消或替换旧运行；只执行轻量 Git／Node 扫描，不安装依赖、使用应用 cache 或接触项目凭据。

原 `.github/workflows/check.yml` 继续只在 PR／手动时做完整 check／build，保留应用检查可取消并发、原必需检查名称与既有双锁安装；把其早期历史扫描步骤也改为可信来源。这样新增 push 不会产生名为原必需构建检查的 SKIPPED 替身，main 的原必需构建路径也继续包含可信扫描。不新增 required check、平台政策、仓库变量或云设置。

| 事件 | 扫描器／控制辅助文件来源 |
| --- | --- |
| PR | 事件固定的目标仓库 `base.sha` |
| topic branch push | 明确选择受保护 develop，先解析并冻结 SHA，再从该 SHA 取文件 |
| main／develop 自身 push | 事件固定的 before；零值／缺失须进入明确 bootstrap 或失败 |
| 手动 | 明确选择 main／develop 可信来源并冻结 SHA；受检 OID 单独记录 |

可信文件保存到独立目录，候选只 fetch 到对象库；核对事件固定 SHA，不执行候选扫描器／辅助文件／actions。上述限制适用于隐私扫描阶段；原应用阶段仍按现有隔离规则运行候选代码的完整 check／build，两个阶段分别记录。事件输入经环境变量或结构化参数传递与严格校验，不直接拼入 shell 代码。保持标准托管 Ubuntu、Node 24、`contents: read`、checkout 不持久保存凭据，沿用现有固定动作 SHA；无新依赖、第三方扫描器、schedule、自托管或 `pull_request_target`。

**首次修复 PR 的自举必须明示。** 旧 base 尚无新集合接口／控制器：本轮已核对的旧扫描器 SHA-256 为 `9e00a14acaf65913e78a34963ebeac695881e89fe56ca7461eb1f4423a6799e7`，仅允许识别这条已审旧字节后调用其既有范围接口，明确标记 legacy-policy 结果；未知版本固定失败。新规则和控制器先由本机审阅、虚构回归及旧可信 CI 分别验收，不能临时执行 candidate 后宣称可信新规则已过。合入 develop 后，后续 develop 目标才取得新规则；main 目标仍使用其当时的 base，须等独立正式发布才能采用新版本。新手动工作流也须先存在于默认分支才可使用，本次不为此发布 main、不改默认分支或平台自举设置，也不手动派发 CI。

旧 checker 会输出原始路径，legacy 引导必须捕获并完全抑制其 stdout／stderr，只输出固定 legacy-policy 状态、退出码、安全计数及来源 SHA；不能转发旧 finding 文本后宣称已满足新定位脱敏。参数失败或输出无法安全识别时保持失败，不改用候选实现。

普通 PR 的 YAML 仍由候选控制，可写分支也可改变 push 工作流；提交消息跳过指令、工作流不存在、外部 PR 审批、平台事件／资源限制或人工取消也可能阻止运行。固定目标扫描器减少“改扫描器放行自己”的路径，**不构成不可绕过的平台政策，也不保证每次上传必然被扫描**。本方案不引入独立 required workflow 或外部控制器，GitHub 原生密钥扫描与推送保护保持各自边界。

## 拟修改范围与验收

- `scripts/check-privacy.mjs`、必要的本机 Git 集合／CI 引导辅助文件、版本化历史政策、`.githooks/pre-push`、上述两个 workflow。
- 局部随机生成的虚构回归与必要既有测试兼容、隐私／CI 说明、需求、决定、状态表及自己的进度；不改公共 DTO、栏目、业务 SQL、运行包、真实凭据或公开内容范围。
- 覆盖工作区／暂存／历史规则、坏 blocklist 不回显、含敏感值或换行的路径脱敏、已删中间提交与合并侧链、未知／非祖先 OID、污染 remotes、浅库／替换对象、多个 ref／删除、当前树无空范围旁路、可信扫描器与被改 candidate 对照、首次 legacy 自举／旧输出抑制／未知版本拒绝。
- CI 配置离线断言：分支 push 只有轻量独立扫描；PR／manual 保留完整构建与可信早期扫描；隐私无共享并发、不安装候选或依赖、权限不扩大、不新增原必需构建名的跳过实例。离线断言不当作真实 Actions 运行证明。
- 实施后集中一次 `npm run check` 与离线 build，按影响完成隐私／差异／实际合入核对；按常规规则进 develop。正常源码 PR／push 产生的 GitHub Actions 与本机结果分别记录，不手动补派或把 SKIPPED 当通过。

本次确认拟覆盖上述源码、局部虚构测试、本机既有公开 Git 历史审计、离线检查及常规 develop 交付，包括正常 PR／push 自动产生的 GitHub 托管扫描。**不包含业务项目请求、真实凭据处置、历史改写、仓库设置、main 发布、部署、任务恢复或业务 CI 凭据。** 私有准备证据不提交。

## 官方依据

- [GitHub 并发语义](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)：共享组默认会替换旧 pending；本方案采用独立无组扫描。
- [GitHub 事件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)、[跳过工作流](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs)：分支事件及跳过限制；不把配置新增写成无条件覆盖。
- [GitHub 安全事件说明](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)：候选代码作为数据，未采用该高信任事件。
- [Git rev-list](https://git-scm.com/docs/git-rev-list)、[pre-push 协议](https://git-scm.com/docs/githooks#_pre_push)、[replacement objects](https://git-scm.com/docs/git-replace)：范围、零 OID 与对象替换边界。
