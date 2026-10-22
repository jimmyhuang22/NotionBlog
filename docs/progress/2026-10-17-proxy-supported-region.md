# 2026-10-17：F21平台兼容地域配置与真实预览

编辑登记：后端交接会话接续部署失败交接；原“优化详情页首次加载”对话已将后续交回本会话。独立分支codex/proxy-supported-region，从develop b2482ec开始；不修改Claude页面，不恢复网站内容同步，不重抓Notion或媒体。

- 原Proxy单文件和后续源码通配均被真实Vercel部署的unused_function校验拒绝，尚未进入安装／Next构建；已定位Next入口前缀许可尚缺proxy，本机打包成功不能代替平台验收，所有失败保留。
- 最终将入口机械改为middleware文件与导出，显式保留Node运行时及九条matcher，用该真实入口配置sin1。资格body与matcher逐字核对不变，普通页面／API、权限、SQL、池、DTO与Claude页面不改。Next16仍支持但已弃用该文件约定，记录兼容债务，平台支持后迁回。
- 完整check的类型与协议检查通过，2179项中2170项通过；另9项因未暂存的文件改名使release fixture的git ls-files仍复制旧路径而失败。暂存后仅重跑受影响文件，19项全部通过；隐私检查与build通过43份server trace核验，不把局部重跑写成完整check重跑通过。集中合并／发布检查按既有流程执行。
- 真实Vercel Preview已READY，使用受检代码8186c4e；平台安装、Next16.4 webpack构建和43份trace隐私检查通过，实际_middleware.deployedTo仅sin1、runtime=nodejs24.x，九条matcher打包保留。平台保留Next的middleware弃用提示，未隐藏警告。
- 受保护预览四次GET通过：mock健康API200、课程200、未知课程404、不可用占位503，全部no-store，响应正文合计77719字节；未请求图片、Notion或真实数据库内容。预览与原始证据留私有回执，不写入公开文档。
- 后续文档提交不改变受检可执行配置，不重复构建／部署。不自动合并develop或main、不切生产或恢复同步；F21保持未关闭，正式发布后先核实际入口地域，再由Claude按首次、预取、五分钟回访分别复验，旧版本暖态数据不算新修复收益。
