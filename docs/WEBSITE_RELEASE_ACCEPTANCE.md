# 真实数据库网站预览验收

目标是验证 Notion → 完整同步批次 → 数据库 → 网站的实际链路。使用现有 reader、同步 CLI 和网站检查工具；图片优化与其他栏目扩展由对应任务维护。

## 发布前准备

网站读取隔离先填写[阶段声明](READER_ISOLATION_RELEASE.md)：尚未真实验收使用 deferred／off（含未设置），验收后使用 verified／enforce 并关联实际回执。声明检查只作本机一致性校验，不能替代真实角色／目标核验或本次发布授权。

1. 固定源码提交，运行 `npm run check` 与 `npm run build`。分别核对核心／reader 摘要，保持冻结的同步 v1；记录独立分支和唯一同步操作者。
2. 使用专用 reader 配置运行 `scripts/check-reader.ts --verify-access`。数据库 TLS、受限权限和 Auth 固定身份须全部通过。配置不含 writer、Notion Token 或 `NEXT_PUBLIC_` 凭据。
3. 查询当前发布指针、租约、政策摘要、来源与允许名单。核对运行根的三类锁；没有锁只表示检查时空闲，真正运行仍需本机锁与云租约共同互斥。
4. 通过现有 collection planner 重新枚举当前来源元数据，与完整暂存集合、祖先和顺序对比。它不读取正文／下载图片，也不续期批次或替代新鲜完整同步。
5. 在隔离回环生产服务器显式选择 database，运行 `scripts/check-website.ts --expect-unavailable`。未发布时内容／年份 API 须返回受控错误、no-store，不能回退 mock。HTTP 自身不证明 provider，结合启动配置与 reader 回执判断。

## 受保护的独立预览

确认目标项目、预览部署、Git 分支／提交和访问保护。仅为指定预览分支配置数据库与 Storage reader；所有变量 `target=preview` 且设置 `gitBranch`。不更新公共 Preview 默认值或 Production。读取身份配置保持服务端，密码与连接串使用秘密类型；不上传 worker 会话或 Notion Token。

先部署预览、核对匿名访问被保护层拦截，再执行完整同步，减少资格窗口在构建期间消耗。经认证请求使用正常登录的浏览器；其他工具先核实实际认证实现，不要为测试关闭保护、创建绕过密钥或扩大其他环境访问。实测 Vercel CLI 63.1.2 的完整 URL `vercel curl` 会创建或复用项目级 automation bypass，本轮已撤销意外新增项并停止使用该命令；不能仅凭技能中的 Trusted Sources 描述认为它不会改变项目访问能力。

传入秘密时使用可保持凭据在本机的路径，例如标准输入；不要通过工具输出中转 `.env` 值。CLI 登录会保存本机认证状态，若尚未获准需先明确授权；浏览器已登录不代表 CLI 已登录。

## 云端连接容量

单个进程的 `pool.max=2` 不代表全站最多两个连接：页面、API 与媒体函数会各自持有连接池。真实预览须验证多个实例并发读取，不能只以本机顺序请求或 reader 权限核验代替。数据库错误 `53300` 表示连接容量不足；核对角色上限、当前连接、项目总额度和连接模式，保留身份与查询权限。

Supabase 为无服务器请求推荐事务连接池，session 模式适合长连接。现有 reader 只执行独立 SQL 调用，没有命名 prepared statement 或跨请求会话依赖，可使用事务模式；配置变更先验证 TLS、只读权限、Auth 和并发查询，再仅更新本任务 branch preview 的秘密变量并重新构建。连接数量调整不修改 writer、冻结 SQL、发布资格或数据权限；有限上限仍需按持续运行负载验收。[Supabase 连接方式](https://supabase.com/docs/guides/database/connecting-to-postgres)、[连接池与额度](https://supabase.com/docs/guides/database/connecting-to-postgres/pooling-and-limits)。

## 完整同步与验收窗口

stage 不改变发布指针。已有暂存批次过期后，不能直接 promote、修改时间或作为新发布输入；用获准配置从头读取正文和图片，在完整检查通过后由已有 CLI 的 publish 模式原子发布。

实际运行根的包装器可能只允许 dry-run／stage。发布入口由唯一执行方审查，复用原锁、身份续期、私有临时环境和预算；不要让两个包装器同时写入同一会话，或以另一个 state 路径绕过锁。失败需核对云端是否提交，不能只按进程退出判断。

资格从 begin 时计算。完成后记录发布状态、当前 revision／epoch／政策摘要与剩余资格时间；预览仍遵守相同过期规则，不通过延长 TTL 留住页面。

## 网站端验证

- 本机 database 网站与受保护预览均检查动态分页／年份、课程目录／笔记归属、正文及代表站内图片，结合进程／部署配置证明 provider。
- 图片采用完整性已验证的清单；下载格式、大小及 SHA 回读、压缩和缓存策略仍按图片任务结果判断。抽样 HTTP 成功不替代全量对象验收。
- 失败批次、撤回与过期先在隔离数据库验证；云端政策变更测试须明确登记影响范围，不能为了测试修改用户的 Notion 正文或隐私名单。
- 海外与中国内地普通网络分别记录页面、API 和媒体的请求结果。开发主机的成功不证明内地访问，Vercel 登录页面也不算应用失败。

保存私人运行与 HTTP 回执，公共记录只写方法、结论及局限。结束后停止本机临时服务器；受保护预览保持其资格期限。定时同步、正式站点 provider、域名和其他栏目公开分别按用户安排推进。
