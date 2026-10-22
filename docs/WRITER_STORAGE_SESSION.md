# 同步 writer 的对象存储会话

长时间首次采集可能跨过 Storage JWT 的到期时间。`createSupabaseStorage` 已支持每次对象请求调用 token getter；`scripts/website-sync/writer-storage-session.ts` 提供独立会话适配，复用操作者现有的受限 Auth 续期 helper。首次发布与增量 CLI 已通过共用 `runtime-storage.ts` 接线；运行配置尚未安装，也没有实际刷新会话。

## CLI 私有输入

以下三个值必须全部明确配置，路径为同一真实私有目录内的绝对路径，摘要来自已审 helper 与运行包记录：

| 私有环境变量 | 用途 |
| --- | --- |
| `SYNC_STORAGE_WRITER_ENV_FILE` | 原受限 writer 的可轮换凭据文件；不指向复制出的陈旧 overlay |
| `SYNC_STORAGE_REFRESH_MODULE` | 原受限 Auth refresh helper |
| `SYNC_STORAGE_REFRESH_SHA256` | 该 helper 的固定 SHA-256 |

只填部分值、空路径或与 `DATABASE_MEDIA_DIRECTORY` 同时设置会失败。全部缺省时保留固定 token 路径，但要求其剩余寿命至少覆盖本次剩余预算加两分钟，否则在来源采集前拒绝。源端读取、下载、对象访问继续服从原预算和取消信号；不会从运行时错误回退到别的账号、媒体目标或 Notion 图片。

只有 `publish` 与 `run` 的 lazy source factory 创建 Storage／会话；`seal`、`initialize`、`recover`、`status` 与 `--help` 不构造这份适配，不读取续期输入或调用 Auth。SQL 连接仍按各命令原规则核对。开启这些私有参数是安装步骤，需要由拥有方在已确认的运行窗口配置；工程接线不自动改变既有环境文件、调度或网站模式。

## 接线边界

`openPrivateWriterStorageSession` 接收私有凭据文件、已审 helper 的绝对路径与 SHA-256、运行器构建 SQL／Storage 时采用的同一份环境，以及检查锁与运行截止时间的 `guard`。两份私有文件必须在同一真实私有目录，文件不能是符号链接或允许其他用户读取。没有隐式加载 `process.env`、后台定时器、管理员凭据或新登录。

初始化只读私有输入，不刷新会话。持有 canonical writer 锁后，把返回的 `session.token` 传给现有 `StorageOptions.token`。实际对象请求前重新读取凭据；有效期不足两分钟才调用 helper，并合并同一时刻的请求。绑定固定的 SQL URL、CA、Storage URL、bucket、API key 和 writer 用户；JWT 的 subject、issuer、authenticated 身份及 writer Storage 角色也必须一致。JWT 解码用于输入限制，签名和服务器身份仍由 Auth／Storage 验证。

helper 须沿用已审实现：自己的会话锁、防止并发 refresh、受限 Auth 请求和有界超时、原子保存新 access／refresh token，再由 Auth 核对用户；只有 `serverValidated=true` 才能继续。适配在执行 helper 前检查文件摘要，续期后重读凭据并再次检查绑定与有效窗口。失败后本轮不自动重试，不把服务端验证失败当作可用 token，也不输出原始网络异常或凭据。

```ts
// 在原 canonical writer 锁内执行；由运行拥有方填写私有输入。
const session = await openPrivateWriterStorageSession({
  credentialsPath, refreshModulePath, refreshModuleSha256,
  expected: workerEnvironment, guard: assertWriterLockAndDeadline,
});
try {
  const storage = createSupabaseStorage({
    url: workerEnvironment.STORAGE_URL,
    bucket: workerEnvironment.STORAGE_BUCKET,
    apiKey: workerEnvironment.STORAGE_API_KEY,
    role: "writer", token: session.token, fetch: boundedStorageFetch,
  });
  // 把 storage 注入已有来源适配或完整 publisher。
} finally {
  await session.close();
  // 必须等 close 完成，才能释放 canonical 锁。
}
```

取消时不能把已开始的 token 轮换丢在后台，也不能先释放 publisher 锁。`close` 拒绝新 token 请求，等待正在执行的 helper 完成；带预算的 transport 阻断取消或过期后的对象请求。两套 host 使用 `host-resources.ts` 跟踪 source factory：即使 `hostAwait` 已因取消返回，仍等待迟到的创建及注册清理，然后关闭 SQL／本机 store，最后释放锁。会话在预检 token 前就登记清理，创建失败也有收尾；一个 cleanup 失败不跳过其他资源。helper 须沿用已审的有界超时，不强杀正在保存轮换 pair 的 helper。它持有的独立会话锁不能代替 canonical publisher 锁。

此适配只适用于已有 Supabase writer 会话。独立 COS 传输、媒体目标、字节预算、reader 账号与网站读图会话继续分别配置；续期不会扩大公开范围、切换发布政策或弥补对象覆盖缺失。实际启用依运行切换授权，由 [首次发布入口](FULL_BASELINE_HOST.md)及[主运行器](INCREMENTAL_HOST.md)拥有方安装和验证。现有 `run.ts` 与旧运行包保持。

## 验证

测试用虚构账号、临时私有文件和假 Auth helper／Storage transport 覆盖多轮到期、并发上传只续期一次、前后绑定变化、错误 JWT 身份、服务端拒绝、续期窗口不足、取消时等待保存、摘要与文件权限拒绝。没有刷新真实会话或上传真实对象。完整运行仍需安装方在交接窗口核对实际 helper 摘要、同一受限 writer 及真实续期回执，不能把本机测试当作云会话验收。
