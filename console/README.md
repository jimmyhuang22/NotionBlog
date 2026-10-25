# 控制台

在 Mac mini 上运行的小网站：看同步状态、立即同步、冻结和解冻页面、紧急下架、查看操作记录。功能与边界见[控制台方案](../docs/ADMIN_CONSOLE_PROPOSAL.md)，与后端的对接见[对接协议](../docs/CONSOLE_BRIDGE.md)。

它与博客网站是两个独立的 Next.js 应用：共用仓库的依赖和类型，但不进入网站的构建，也不部署到 Vercel。

## 用演示数据试用

```bash
npm run console
```

打开 `http://localhost:4310`。内容是虚构的，操作只在这个进程里模拟，重启后复原。顶部可以切换场景：一切正常、同步失败、结果未知、旧模式（新模式上线前的样子）、第一阶段（后端只接上状态、记录和下架时的样子）。

## 接真实后端

后端提供桥接命令后，在私有 env 文件（不提交）里写：

```bash
CONSOLE_BACKEND=bridge
CONSOLE_BRIDGE_COMMAND=/absolute/path/to/bridge
CONSOLE_BRIDGE_ARGS_JSON=["--config","/absolute/private/config.json"]
CONSOLE_PASSWORD=至少 12 个字符
CONSOLE_SESSION_SECRET=至少 32 个随机字符
CONSOLE_SITE_ORIGIN=https://网站地址
```

先构建一次，再用生产模式运行：

```bash
npm run console -- build
```

```bash
node --env-file=/absolute/private/console.env console/run.mjs start
```

## 从手机或其他电脑访问

默认只监听 `127.0.0.1`。要经 Tailscale 访问，加上：

```bash
CONSOLE_HOST=Mac mini 的 Tailscale 地址
CONSOLE_ALLOWED_HOSTS=Mac mini 的 Tailscale 主机名
```

启动脚本拒绝监听 `0.0.0.0` 这类“所有网络”地址；监听本机以外的地址时必须设置密码。

## 安全

- 每个请求先核对 Host（防 DNS 重绑定），设置了密码时再核对登录 cookie（HMAC 签名，12 小时，HttpOnly、SameSite=Strict）。
- 登录失败会放慢，15 分钟内连续 10 次失败后暂停登录。
- 页面不允许被嵌入，不被搜索引擎收录，不缓存。
- 控制台本身不持有数据库、Notion 或部署凭据；这些只在桥接命令里。传给桥接命令的环境只有 `PATH`、`HOME`、`NODE_ENV`。

## 其他设置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CONSOLE_PORT` | 4310 | 也可用 `--port` |
| `CONSOLE_TIME_ZONE` | Australia/Melbourne | 页面上时间的时区 |
