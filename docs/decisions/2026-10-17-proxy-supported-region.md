# 2026-10-17：Proxy地域配置须通过平台实际部署验证

PR413的`functions["src/proxy.ts"]`在本机Next构建和Vercel打包中生效，但发布415被托管平台的`unused_function`校验拒绝；PR417移除了该配置。后续源码通配`src/**/*`也在真实Preview的安装／构建前被同类校验拒绝。两次本机成功与平台失败均保留，不作为可发布方案。

当前Vercel检测器对Next入口使用前缀许可，包含middleware与app/pages，尚未包含proxy；一般src通配也不在许可范围。本次兼容候选将入口机械改名为`src/middleware.ts`与具名middleware导出，在config中显式使用Node运行时，并以`functions["src/middleware.ts"].regions=["sin1"]`约束这一真实入口。matcher、逐请求公开资格、SQL、池配置、404／503、DTO和Claude页面不变，普通页面／API地域不覆盖。

这是有期限的兼容债务：Next16已弃用middleware文件约定，但当前版本仍支持其全部功能与稳定Node运行时。待Vercel平台接受proxy入口地域配置后迁回；每次升级Next或Vercel部署链前重新验证，不增加伪入口、不绕过平台校验、不修改依赖，也不退回Edge。

交付条件为真实Vercel Preview构建成功，并从该部署实际产物核对`_middleware.deployedTo`仅为sin1，确认九条matcher与Node运行时保留；仅本机成功、顶层regions正确或页面函数已在sin1均不足以放行。生产发布另按用户授权及集中发布流程进行，地域正确不等于F21性能已验收关闭。本次真实受保护Preview已通过上述平台构建及地域条件，并完成200／404／503路由抽查；使用mock验证配置兼容性，不代替真实内容性能验收。

配置依据：[Vercel函数配置](https://vercel.com/docs/project-configuration/vercel-json#functions)、[Next middleware兼容说明](https://nextjs.org/docs/app/api-reference/file-conventions/middleware)、[Next Proxy约定](https://nextjs.org/docs/app/api-reference/file-conventions/proxy)。平台接受与否以真实预览为准。
