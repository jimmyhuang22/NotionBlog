# 2026-11-23：游戏卡盒封面与平台时长

用户确认盒壳、顶部平台条、状态与时间由界面绘制。独立的盒内素材使用原版竖封面，优先使用无分级标志的发行商同版图。盒形沿用 Switch／Switch 2 为 0.62，PlayStation 为 0.79，Steam 为 0.71。保存原比例与实际像素，前端居中裁切。按封面区域实际保留的像素验收，有效高度 560 像素起，约 800–900 像素理想。桌面 3× 略软可接受。

网站 v2 的 Game 可选字段为 boxArt 和 platformPlayTime，对旧快照兼容。boxArt 对应前端共同选定的已知时长最长的平台。时长缺失时按最近的已核实平台、再按平台列表首项。没有合格的同版图时，前端使用现有横图在卡盒内完整展示。PS4 与 PS5 采用对应的软件版本；仅见宽泛的平台标签时仍需独立版本依据。

- boxArt 复用 ImageAsset、站内媒体和 400／800 像素宽档；cover 保持横版原用途。素材版本及是否带包装由导入前人工核对；发布端再按有效高度与已选平台校验。
- platformPlayTime 只为多平台作品公开 Game.platforms 中的准确标签与小时数。使用当前且已关联的平台记录；可确认的零保留，缺项省略，空集合使用 null。不输出账户、产品编号、精确时间戳或关联记录。此项更新既有“不公开逐平台明细”规定中对汇总时长的口径。
- 后端与前端共用 src/lib/content/game-case.ts 的 selectGameCasePlatform。前端可用其中的 gameCaseAspectRatio 设置盒体比例，用居中 cover 显示 boxArt；箱体和平台标记仍由组件自己画。

## 私有采集映射

网站 v2 的游戏来源可选映射 fields.platformPlayTime 为私有字符串公式，输出每行 Provider|Platform|Total Playtime Minutes。公式通过既有 Platform Records 关系选取已关联的 Current 行，Steam 只选 Library，Nintendo／PSN 只选 Played。判断空时长时保留已知零。不拼接账户、行 ID、时间戳和人工汇总。重复的同一软硬件平台记录须先核对避免叠加。已确认的独立 PS4／PS5 数据可汇总到 PlayStation，素材仍按游玩更多的实际版本校验。

fields.boxArt 为已审核原图的独立 files 属性，同时映射 fields.boxArtPlatform 为经核验的 select 平台。例如 Nintendo Switch 2、Steam 或 PS5；笼统的 PlayStation 标签无法代替实际图片版次。已启用平台字段须现有来源 schema 匹配之后才能运行。此文用于后续 Notion 配置确认，源库和现役配置没有修改。
