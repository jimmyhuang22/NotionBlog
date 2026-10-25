# 展示图片前端交接（Claude）

后端已按用户确认的离线范围提供display-only模式。此文交接前端实现边界，不代表前端已经修改或授权正式发布。当前源码仍保留原ContentImage/Lightbox行为，需要在虚构数据下完成可选字段接线与交互验收。

## 可消费接口

仅使用[ImageAsset](../contracts/content.ts)与统一内容入口；不要读取后端文件路径、清单、SQL或运行环境。新可选字段：

```ts
delivery?: { mode: "display-only"; maxWidth: number; maxHeight: number }
```

字段缺省时保持全部既有行为。display-only时`image.src`是最大展示版的稳定站内地址，400/800/1600查询也只返回展示副本，服务器没有原图回源。`width/height`仍是旧来源元数据，不改含义；灯箱应以delivery的实际最大尺寸判断是否已经得到全部可用像素。例如原件2400宽而maxWidth1600时，放大不应触发更大原图请求；1000宽最大版不能被当成1600宽。

## 接线位置

| 文件 | 待完成行为 |
| --- | --- |
| [content-image.tsx](../src/components/content-image.tsx) | 把可选delivery传入灯箱注册；display-only时按最大展示尺寸判断已有版本，预览失败后最多尝试站内最大展示地址 |
| [lightbox.tsx](../src/components/lightbox.tsx) | Photo接收同一可选提示；预览→清晰版→最大展示版，达到最大后不再请求“原图”；加载/失败文案用“清晰图/图片”等准确说法 |
| [image-preview.ts](../src/lib/content/image-preview.ts) | 已支持v2的400/800/1600地址，按需要复用；不要构造原图、COS、Notion或私有文件URL |

保持现有布局、样式、手势、键盘、焦点返回、切图顺序与失败占位。用户批准的是字段接线和语义纠正；需要新的视觉/排版方案时先让用户确认。display-only文案不能说“原图加载失败”，也不能通过原件width误判永远尚未清晰。可放大已有像素，但不要把CSS放大当成获得原件。

400/800/1600是请求档位上限，响应可能是较大已有展示副本或原生尺寸小图；用实际naturalWidth与delivery上限判断，不根据参数猜尺寸。后端对声明文件坏/缺失返回503且不换档掩盖；前端若沿用一次最大版请求，应保持有界，不递归重试或寻找原件。当前全部图片no-store，不能宣称重复URL必然由浏览器缓存免传输。

## 离线验收

1. 缺省delivery：旧预览/1600/原件行为完全保留。
2. display-only的2400→1600、1000→1000、80→80三种样本：打开与放大后不出现更大原图请求，不误报尚在加载原图。
3. 透明图、缺档选择已有副本、坏文件503及撤回404：正确显示清晰度/失败提示，不无限请求。
4. 手机/桌面切图、关闭、Escape、焦点返回、双击/捏合与键盘缩放沿用原体验。

后端已有`tests/self-hosted-media.test.ts`与`tests/self-hosted-media-route.test.ts`；后者执行实际生产GET、隔离资格SQL和本机HTTP，未验证浏览器灯箱。前端验证使用虚构素材与离线入口，不访问真实网站、图片、Supabase、Vercel、COS或上海服务器。完整应用改动按项目约定运行check/build；本轮后端分支尚未推送/合并，整合来源与受检提交需要随交接记录核对。
