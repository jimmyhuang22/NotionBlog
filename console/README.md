# 控制台

在 Mac mini 上运行的小网站：看同步状态、立即同步、冻结和解冻页面、紧急下架、查看操作记录。功能与边界见[控制台方案](../docs/ADMIN_CONSOLE_PROPOSAL.md)，与后端的对接见[对接协议](../docs/CONSOLE_BRIDGE.md)。

它与博客网站是两个独立的 Next.js 应用：共用仓库的依赖和类型，但不进入网站的构建，也不部署到 Vercel。

## 用演示数据试用

```bash
npm run console
```

打开 `http://localhost:4310`。内容是虚构的，操作只在这个进程里模拟，重启后复原。顶部可以切换场景：一切正常、同步失败、结果未知、旧模式（新模式上线前的样子）、第一阶段（后端只接上状态、记录和下架时的样子）。

## 接真实后端

桥接命令第一阶段在 `scripts/console-bridge/`，配置格式见[对接协议](../docs/CONSOLE_BRIDGE.md#第一阶段实现)。在私有 env 文件（不提交）里写：

```bash
CONSOLE_BACKEND=bridge
CONSOLE_BRIDGE_COMMAND=/absolute/path/to/node
CONSOLE_BRIDGE_ARGS_JSON=["/absolute/repo/scripts/console-bridge/cli.ts","--config","/absolute/.local/console-bridge/config.json"]
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

默认只监听 `127.0.0.1`。要让家里局域网的其他电脑访问，改为监听 Mac mini 的局域网地址，并列出访问时用的地址或主机名（例如 Bonjour 名称 `xxx.local`）：

```bash
CONSOLE_HOST=Mac mini 的局域网地址
CONSOLE_ALLOWED_HOSTS=Mac mini 的局域网地址,Mac mini 的 Bonjour 名称.local
```

这时本机也要用局域网地址打开。局域网里是普通 HTTP，登录密码和 cookie 不加密；出门在外要用时改用 Tailscale 地址，或接到已有的 HTTPS 反向代理后面。

启动脚本拒绝监听 `0.0.0.0` 这类“所有网络”地址；监听本机以外的地址时必须设置密码。

## 开机自动运行（Mac mini）

按 HomeLab 其他服务的做法安装：代码放在 `~/Services/notionblog-console/releases/<提交>/`，`current` 指向正在用的那一份；私有配置、env 和桥接状态放在同目录的 `.local/`（700，文件 600），不随代码更新；由 LaunchAgent `local.homelab.notionblog-console` 启动，开机运行、退出后自动拉起，日志在 `~/Library/Logs/HomeLab/notionblog-console/`。

更新到新版本：

1. 从 develop 导出新提交到新的 `releases/<提交>/`，在里面执行 `npm ci` 和 `node console/run.mjs build`。
2. 把 `current` 改指向新目录。
3. `launchctl kickstart -k gui/$(id -u)/local.homelab.notionblog-console` 重启。

旧的 release 目录保留，出问题时把 `current` 改回去再重启。私有 env 里的桥接命令路径应指向 `current/scripts/console-bridge/cli.ts`，这样更新时不用改配置。

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
