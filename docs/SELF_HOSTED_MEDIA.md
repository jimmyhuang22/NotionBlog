# 自托管展示图片

本模式让Mac处理并保留原图，网站读取预生成的展示副本。当前交付为离线后端源码与虚构数据验证；未安装到服务器，也未接真实同步。默认关闭，仅适用于专用[自托管启动入口](SELF_HOSTED.md)的database v2、qualified读取，当前须关闭社交。

## 请求与展示规则

| 请求/情况 | display-only行为 |
| --- | --- |
| `/media/v2/a1.<64位摘要>` | 返回该资产最大展示版，宽度≤1600 |
| `?thumbnail=400/800/1600` | 返回声明档位；未声明时取能覆盖目标宽度的最小已有副本，否则取最大展示版 |
| 1000宽输入 | 必须生成1000宽最大展示版，不放大到1600 |
| 小图多档相同 | 同一SHA文件去重；最大展示版必备，即使没有体积收益 |
| 缺少资产、资格撤回或来源绑定变化 | 404，无图片字节 |
| 声明文件缺失、损坏、权限/路径错误 | 503，不换文件掩盖问题 |
| 非法或重复查询参数 | 400 |

接口不提供原图读取方法，不连接COS/Notion，不在请求期间缩放或编码。每次在文件读取前后查询既有媒体资格，比较runId、assetId、owner、原件SHA及来源指纹。即使没有旧缩略图登记，现有400档资格函数仍能返回source与runId；本轮未增加SQL或角色权限。

响应使用`private, no-store`、`noindex, nofollow`、`no-referrer`及`nosniff`。这不免除服务器公网流量或带宽；文件仍经网站HTTP返回。当前不启用Caddy静态根目录或共享缓存。

## Mac离线生成

使用同一锁文件已有的sharp，无新增依赖。独立`display-webp-v1`配方保留转正、sRGB、透明度、不放大与元数据清理；对相同缩放参考采用Q85/无损择小。宽度上限不是长边上限，WebP单边仍不得超过16383；输入上限20MiB/4000万像素。动画、多页、高位深或解码错误使批次失败，不能把首帧或原件当作展示产物。

输入清单是受保护的本机JSON，根目录及原图所在目录为当前用户所有、0700，输入文件0600、普通文件、单硬链接、绝对规范路径，不接受符号链接或URL。以下示意中的source必须来自同批已验证的`ThumbnailProjection`，不能用手填占位值进行真实发布：

这里复用的是数据结构；生成器不查询数据库或认定素材已公开。后续同步器应从同批经审的捕获记录/媒体绑定构造待发布输入，而不是先提升数据库来取得新run的公开资格。真正的当前资格检查发生在访客读取时；完整枚举、发布前资格与覆盖核验仍由后续同步接线负责。

```ts
{
  format: "notionblog-display-input-v1",
  runId, // 该批数据库UUID
  assets: [{ originalFile: "/private/notionblog-input/fictional.png", source }]
}
// source: { version: "v2", runId, thumbnail: null,
//   source: { media: StoredMedia, binding: MediaSourceBinding } }
```

```sh
npm run media:self-hosted -- build \
  --input /private/notionblog-input/plan.json \
  --output /private/notionblog-staging/new-batch
```

CLI以隔离环境运行并加载现有Node外连保护，只处理显式本机文件。默认唯一输出预算128MiB，可用`--max-output-bytes`调低或增至硬上限1GiB；每批≤20000资产、累计输入≤1GiB。预算不是进程峰值内存承诺。输出路径必须全新；不覆盖已有批次，不修改原图，不连接数据库或发布。

## 清单与只读目录

```text
display-root/                     0700
  objects/<展示SHA256>.webp        0600
  runs/<数据库runId>.json         0600
```

清单格式`notionblog-display-v1`包含runId、编码配方摘要及资产的`base/variants`。每个文件记录SHA256、字节数、MIME与实际尺寸；资产记录owner、原件SHA和来源指纹。清单不包含原图路径、来源URL或凭据，仍作为私有运行资料保存，不放入Git或浏览器DTO。

对象采用独占创建、落盘及回读校验，清单最后写入。生成失败可能保留待诊断的staging文件，不能把失败目录当成完整批次。读适配器验证目录、当前UID、权限、普通文件/单硬链接、禁止符号链接、读取前后状态、字节数、SHA及WebP头尺寸。配置拒绝public下的展示目录，读取也拒绝public本身链接到展示目录的情况；部署仍不得通过其他public子链接或挂载暴露副本。编码器已独立解码验证透明度；网站只验证头与摘要，不承担图片解码工作。

未来部署顺序是：独立核验展示包→安装所有对象及该run清单→以同容器UID设置0700/0600→只读挂载到网站→核验该批全部受管图片覆盖→最后提升数据库runId。网站和上传者不能并发改写已有文件；保留旧run文件供恢复。不要使用硬链接安装对象，也不要把原图或整个Mac缓存打包。

本轮未实现真实同步/传输/发布器，也不证明输入枚举已覆盖全站。构建器能保证所给列表全部成功才写清单，不能判断调用者是否漏列图片；后续完整覆盖门禁必须在数据库提升前完成。网站会移除未准备的图片投影并拒绝其媒体请求，这不能作为“迁移完整”的证明。

配置文件的environment增加：

```json
{
  "SELF_HOSTED_MEDIA_MODE": "display-only",
  "SELF_HOSTED_MEDIA_ROOT": "/run/notionblog-display"
}
```

这是已有reader配置的补充，不能替代整份配置。启动在监听前核对目录。保持TLS verify、`nb_website_reader`、reader隔离enforce、社交disabled及共享缓存关闭；不能通过dotenv单独开启。目录必须位于public之外且只读挂载，原图/对象存储凭据不在允许配置中。

## DTO与验收边界

`ImageAsset`原字段语义保持，新增可选：

```ts
delivery?: { mode: "display-only"; maxWidth: number; maxHeight: number }
```

尺寸取已编码最大展示版的真实值。读取层在同次已合格SQL投影中补充，不增加逐图片SQL，不写回冻结记录；外部或未准备的图片不交给浏览器。未启用模式时不装配文件适配器，现有Vercel/COS路径保留。前端接线见[Claude交接](SELF_HOSTED_MEDIA_FRONTEND_HANDOFF.md)。

本机测试覆盖真实生成文件、CLI、尺寸/透明度/转正、坏文件与路径、混批和读取中撤回；实际生产GET通过loopback HTTP连接隔离PGlite的真实迁移/资格SQL。该HTTP测试替代了pg传输并断言TLS配置严格，未执行原生PostgreSQL TLS握手，不能代替目标Linux、真实照片压缩率、服务器容量或浏览器灯箱验收。
