# 2026-10-23：README 换结构图、说清内容怎么接入（Claude）

用户看过上一版 README 后提出三点：用词仍偏僵硬，“截图取景与来源见截图说明”这类话可以去掉；Mermaid 流程图换成符合项目结构的图片；说明接入时内容要怎么导入。

## 改了什么

- 全文改口语：去掉截图说明的引用和“缺什么就说什么”等偏内部的条目，各节缩短，常用命令只留五个。
- 新画结构图 `docs/assets/readme/architecture-{light,dark}.png`，原稿 `architecture.svg`。四栏：在 Notion 里写 → 你的电脑定时同步（只读、按公开规则筛选、存图片原件与小图）→ 你的 PostgreSQL 与对象存储 → 网站与访客；游戏平台时长写回 Notion，B 站／小红书作品由作品采集单独写入。README 用 `<picture>` 按 GitHub 浅色／深色主题切换。
- “接入自己的 Notion”改成四步，第一步说明：内容要先整理成 Notion 数据库，列名在配置里对应、不用改；不在 Notion 里的旧记录可用 CSV 导入或让 AI 整理后批量导入。第四步明确：PostgreSQL 不用手动导入，同步程序首次运行写入全部公开内容，之后按间隔更新。
- 截图说明补了结构图一节。

依据：字段映射见 `config/notion-website.example.json`；同步程序的运行与间隔见 `docs/NOTION_SYNC_WORKER.md`；游戏与社交数据流向见 `docs/GAME_ACCOUNT_SYNC.md`、`docs/SOCIAL_SYNC.md`。

## 验证

结构图用本机 Chrome 无头模式经 DevTools 协议按 1200 × 580、两倍像素渲染，两张都逐一看过，文字没有溢出或被裁切。做了记录格式测试、README 本地链接与图片核对、隐私检查和差异复核，并用 GitHub 的 Markdown 接口确认 `<picture>`、表格和折叠段能正常显示。只改文档与文档图片，未重跑 check／build。

## 限制与下一项

`<picture>` 的深色版跟随 GitHub 的主题设置，在其他 Markdown 查看器里可能只显示浅色版。合入 develop 后，main 要等下一次发布才会更新。
