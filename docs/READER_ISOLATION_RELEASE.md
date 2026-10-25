# 网站读取隔离的分阶段发布

R01 用 `DATABASE_READER_ISOLATION` 控制网站数据库入口的额外隔离检查。缺省和 `off` 延后强制验证，`enforce` 执行既有拒绝规则；空串、空白、大小写变体或其他值返回 MISCONFIGURED。配置仅在服务器 runtime 创建时读取，不由访客输入控制，不打包到客户端。

off 保留原公共读取路径，首次 SQL 调用记录一次 `WEBSITE_READER_ISOLATION_DEFERRED`。该诊断只表示尚未强制验证，不证明真实账号状态；不会打印凭据或角色详情。off 不撤销旧权限、不解决 B03、不吞掉业务读取错误。库函数 `isolatedWebsiteReader(db)` 仍默认严格，工作程序及 B20 直连的独立校验也保持严格。

## 每次发布的声明检查

本机入口不加载业务 env，不读凭据／证据文件，不连接项目，不部署。`--mode` 是**拟采用配置的显式声明**，未设置变量时使用 `unset`，不能省略参数。

```sh
node scripts/check-reader-isolation-release.ts --phase deferred --mode unset
node scripts/check-reader-isolation-release.ts --phase deferred --mode off
node scripts/check-reader-isolation-release.ts --phase verified --mode enforce --evidence-sha256 <receipt-sha256>
```

deferred 阶段只能采用 off／未设置，避免隔离前误开。verified 阶段必须 enforce 且有 64 位小写十六进制回执摘要，避免声明已经验收却忘记强制。无效组合、缺参数、重复或额外参数返回固定错误与退出码 2；成功只输出阶段和解析模式，不回显摘要。

此检查不能证明声明、摘要或数据库状态真实。发布材料须逐项填写：

- 最终网站提交、实际目标和本次阶段；采用的是未设置、off 还是 enforce。
- deferred：明确 B03 未完成及旧宽权限仍保留，不把其他修复上线写成权限已隔离。
- verified：由原安装拥有方提供同一目标的角色／成员、能力、网站与同步读取验收回执引用和摘要，再采用 enforce。
- 将拟采用配置与获准回读的实际目标配置对照；环境值是 Config 性质且仅服务端使用，不修改／回读任何业务凭据。
- 开启或改变模式时重建网站实例；原 runtime 不动态重载。记录失败／回退和如何恢复匹配的配置，不能用旧成功缓存证明新权限。
- R01 检查通过不替代 B23 网站／维护兼容、B20 直连能力、缓存过渡或其他发布前提，也不代表本次 main 合并已获授权。

真实隔离安装、云变量读取或写入、enforce 激活、网站回读和部署均须在各自有效授权内进行。不能从本机声明通过推导允许联网，不能自动复用旧窗口；普通 develop 交付不触发上述操作。

源码与隔离测试方案见 [R01 方案](BACKEND_READER_ISOLATION_MODE_PLAN.md)，真实隔离步骤见 [B03 方案](BACKEND_READER_ISOLATION_PLAN.md)。
