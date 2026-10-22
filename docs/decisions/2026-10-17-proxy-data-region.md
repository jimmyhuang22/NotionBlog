# 2026-10-17：数据库预检Proxy与数据区域一致

背景：作品详情的线上请求trace显示，较慢请求的Proxy／Middleware阶段约1.5–1.7秒，紧接请求约0.38秒；页面函数均约0.57–0.60秒。部署元数据进一步确认页面和API位于数据区域，而Node.js Proxy默认发布到多个区域。Proxy会等待数据库公开资格预检，远端执行预检可能在页面开始之前承担跨区连接与查询往返。

工程决定：在`vercel.json`的`functions`中仅为`src/proxy.ts`显式指定与当前页面／数据库一致的执行区域。使用Vercel对Node.js函数的单函数区域配置，不在Next.js Proxy中设置不支持的`runtime`，也不依赖未传入当前Node middleware打包路径的Proxy区域字段。

保持逐请求公开资格、数据库错误传播、404／503重写及原有matcher；页面请求内去重、客户端预取／回访和其他函数区域保持。连接池参数、SQL、权限、数据库版本及同步运行包不随此项改变。

此决定先交付可审阅配置和本机构建验证，不等于正式区域切换或性能验收。发布仍由用户决定；发布后核对实际`_middleware`部署区域，再用同一部署的前次／连续请求trace和真实浏览器导航复验。迁移数据区域时须同步复核该配置，不能只改托管平台的页面默认区域。

依据：[Vercel单函数区域配置](https://vercel.com/docs/functions/configuring-functions/region)、项目安装的Next.js Proxy说明及本机缓存Vercel Next构建器的Node middleware配置路径。
