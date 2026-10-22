# 2026-10-13：存档里不再加指向新记录的链接（Claude）

编辑登记：Claude 按用户的要求整理记录文件。范围：`docs/PROGRESS.md`、`docs/DECISIONS.md` 各删去几行链接，两份说明各改两句，`tests/record-entries.test.ts` 加一项检查。没有改代码、依赖、契约、fixtures、栏目开关、接口与媒体路由。

来由：进度与决策从 2026-10-12 起每项一个文件，两个旧文件作为存档不再追加。之后后端的几次合并请求仍往存档里加了内容。用户要求把加进 `PROGRESS.md` 的内容挪到单独的进度文件。

## 查到的情况

加进存档的不是正文，而是七行“见某个新文件”的链接：`PROGRESS.md` 标题下两行、末尾三行，`DECISIONS.md` 末尾两行。它们指向的记录本来就各有单独的文件，都在：

- `progress/2026-10-12-website-image-failure-recovery.md`
- `progress/2026-10-13-study-directory-republish.md`
- `progress/2026-10-13-social-fixed-refresh-plan.md`
- `progress/2026-10-13-social-bounded-refresh-executor.md`
- `progress/2026-10-13-social-refresh-cycle.md`
- `decisions/2026-10-13-social-fixed-refresh.md`
- `decisions/2026-10-13-social-bounded-refresh.md`

所以没有内容需要搬动，要做的是把链接从存档里拿掉。存档里 2026-10-12 的几节正文是从切换前开的分支合并进来的，属于允许的情况，没有动。

## 改了什么

- 两个存档删去这七行链接和它们各自带的空行，其余一字未改；删完后存档里没有任何指向单独记录的链接。
- `tests/record-entries.test.ts` 新增一项：存档里出现指向 `progress/` 或 `decisions/` 下带日期文件的链接就不通过，提示把链接删掉。原因和当初拆文件一样：这类链接总是加在同样两个位置（标题下、最后一节后），同时打开的合并请求会在 GitHub 上互相冲突。
- `docs/progress/README.md` 与 `docs/decisions/README.md` 写明存档不加这类链接，并更新对这项检查的说明。

## 怎么验证的

- 新检查在改动后的文件上通过；把 `PROGRESS.md` 临时恢复成删除前的样子，新检查按预期不通过，随后恢复。
- 两个存档的差异只有删除，没有别的行变化。
- 自动检查结果见合并请求正文。

## 限制

- 打开着的合并请求 177 在 `PROGRESS.md` 的说明行里加了一句指向新记录的话，与这次删除的位置相邻，合并本请求后它可能需要重新合入 develop，并且会被新检查拦下；需要它的作者把那一句去掉。
- 新检查只看链接，不拦没有链接的普通文字。

下一项：无。
