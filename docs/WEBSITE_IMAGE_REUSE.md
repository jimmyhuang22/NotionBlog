# 网站同步的原件复用

v2 图片下载器提供可选的本机缓存，目标是减少同步时重复下载原图。它不改变浏览器图片交付、网站缓存头、公开范围或完整批次协议；v1 下载器和缩略图生成保持原有行为。

## 怎么启用

标准 `website:sync` CLI 可在私有操作环境设置：

| 配置 | 用途 |
| --- | --- |
| `SYNC_IMAGE_CACHE_DIRECTORY` | 缓存的绝对、规范路径；目录 700，文件 600。缺失时沿用完整下载 |
| `SYNC_IMAGE_ORIGINALS_DIRECTORY` | 可选的既有原件镜像根目录，内含 `sha256/`；只读，逐个使用时核对，不扫描全库 |

独立操作器也可以直接接入：

```ts
const cache = await createWebsiteImageCache({
  directory: "/absolute/private/image-cache",
  originalsDirectory: "/absolute/private/original-mirror",
});
const download = createWebsiteImageDownloader(options, { cache });
```

缓存保存哈希命名的原件和验证记录。配置了既有镜像时，核对同 SHA 文件后复用，不重复复制，不改镜像索引；缓存与镜像目录不能相同或相互包含，避免写回镜像。缺失或内容损坏的原件重新完整下载；不安全的文件权限、硬链接、符号链接或目录配置明确失败。缓存目录须保持私有并排除 Git；本实现不安装调度、不自动清理历史对象。旧固定 release 不会自动取得新代码或配置。

## 何时可以省掉图片正文下载

第一次完整安全 GET 通过格式、大小和字节检查后，记录强 ETag、SHA、大小、格式和表示条件。下一次仍使用当前获准来源提供的新地址、重新检查 HTTPS／全部 DNS 地址／TLS／重定向，并向对应原件发送 `If-None-Match`。

只有 304 返回同一个强 ETag、表示条件一致且本机原件通过 SHA／大小／格式核对时，才能复用本地字节。[HTTP 标准](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.2)规定条件请求使用弱比较，因此不能仅见到 304 就沿用旧文件；弱值、缺值、变化的验证器及不一致的表示证据拒绝复用。

200 响应照常完整下载，成功后更新验证记录。没有强 ETag、未知 `Vary`、`no-store` 或 HEIC 转换结果不建立可复用记录；403、404、限流、TLS／DNS 拒绝和取消不能用旧副本掩盖。

Notion 临时文件地址仍须重新获取，不能把旧签名地址当长期入口，见 [Notion 文件说明](https://developers.notion.com/reference/file-object)。缓存键只为确认的 S3 SigV4、仅签名 Host 的地址排除已知认证参数，保留其他查询参数的原始编码和顺序；外链使用完整地址，User-Agent 和表示协商也进入键。认证参数含义见 [S3 查询认证说明](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sigv4-query-string-auth.html)。这个定位规则本身不是原图未变的证明，复用仍要求当前响应的强验证器。

## 如何看节省量

CLI 输出 `imageTransfer`：实际请求尝试数、消费的响应体字节、完整下载图片数、成功重新验证图片数和复用字节。响应体统计包含已消费的失败／重试片段，不包含 HTTP／TLS 开销、提前预读或其他 Notion／SQL 请求，不能当作精确网络流量或账单。

本轮仅以三张小样本做可行性及实际实现验收。实际实现首次合计消费 16,749 字节，随后重新创建缓存／下载器并读取持久记录：三张均重新验证，消费图片响应体为零；三个原件直接来自已有镜像，额外文件复制为零。首次约 5.23 秒、复用约 4.89 秒，只代表这三张小图，不推算完整同步耗时或全库支持率。特殊查询编码隔离及失败行为由离线用例覆盖。

既有镜像没有历史 ETag 记录，仍需首次完整 GET 建立验证记录。[固定 v2 主机入口](WEBSITE_SYNC_RUNTIME.md)已接入这些配置；候选本机检查不代表正式运行已启用。Notion 正文枚举和数据库完整提交尚未增量化；本轮未发布新数据批次、启用周期同步或部署网站。
