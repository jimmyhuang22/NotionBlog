# 2026-10-12：决策记录也改为每项一个文件（Claude）

编辑登记：Claude 按用户要求从最新 develop 开 `chore/decision-entries`，把决策记录照进度记录的办法拆开；只动记录的存放方式、相关说明和一项检查，不涉及页面、接口、契约、依赖和部署。

## 改动

- 新增 `docs/decisions/`：每项决策一个文件，命名与首行格式同进度记录；写法和读法见该目录的 README。第一条是这次的决定本身，`2026-10-12-one-file-per-record.md`。
- `docs/DECISIONS.md` 改为存档：标题加“（存档）”并在其下加一段说明，原有 12 节一字未动、没有迁移。
- 检查改名为 `tests/record-entries.test.ts`（原 `tests/progress-entries.test.ts`），同一套规则覆盖两个目录和两份存档：文件名、首行，以及存档里不得出现晚于 2026-10-12 的小节。
- 同步说明：`AGENTS.md`、`CLAUDE.md`、`README.md`、`docs/REQUIREMENTS.md`、`docs/DEVELOPMENT_HANDOFF.md` 与 `docs/BACKEND_HANDOFF.md` 的启动指令；`docs/progress/README.md` 里的检查文件名。

## 验证

- `npm run check` 通过：1,062 项测试、类型、三项协议与 394 个文件的隐私检查；`npm run build` 与 37 份服务端追踪检查通过。
- 检查确实会拦：在决策存档里临时加一节 `## 2026-10-13：…`、在新目录放不合规的文件名或首行，各自失败并给出改写提示；验证后已还原。
- 存档说明的位置按 GitHub 的合并方式模拟过：另一个分支同时在存档顶部加一节决策时不冲突。开这个请求时没有其他打开的请求改动决策存档。

## 限制

- 与进度记录相同：切换当天按旧习惯在存档里加一节日期为 2026-10-12 的决策，检查拦不住，从次日起才会被拦下。
- 旧决策留在存档里，没有逐条拆成文件；查一件事的现行决定时要同时看新目录和存档，以日期最新的为准。
- `docs/REQUIREMENTS.md` 仍是就地维护的单一文件，各方改的是不同位置，这次没有动。

## 下一项

无。Codex 的会话需要重新读一次 `AGENTS.md` 才会按新写法记录。
