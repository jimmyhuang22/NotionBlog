# 2026-11-22：Steam 本人成就读取与隐私核对（Codex）

基于 `573eda1`，核实 [#416](https://github.com/jimmyhuang22/NotionBlog/pull/416) 第十八节 Steam 权限问题。用现有本人 Web API Key，只读查询固定允许名单中的一款已游玩游戏。`GetPlayerAchievements/v1` 返回 HTTP 200、`success: true`，含成就数据。当前账户设置已支持该样本，继续保持现有设置。匿名社区样本返回 302，由此无法确定「游戏详情」的实际公开等级。

Steam 将公开资料的可见性交给用户控制，单款标为私人的游戏也会隐藏该游戏的成就。`GetPlayerAchievements` 官方接口表说明了本人 Key、SteamID 和 AppID，未明确普通本人 Key 是否必然需要把「游戏详情」设为公开。当前设置下的成功读取无法推出 Friends Only 或 Private 时的行为。此次没有改变设置做反向试验。接入前仍应要求已有固定允许范围，私人／隐藏排除优先。来源：[Steamworks 成就接口](https://partner.steamgames.com/doc/webapi/ISteamUserStats#GetPlayerAchievements)、[Valve 隐私说明第 5.4 节](https://store.steampowered.com/privacy_agreement/)、[Steam 私人游戏说明](https://help.steampowered.com/en/faqs/view/1150-C06F-4D62-4966)。

验证范围仅一款获准游戏，数次 Steam 只读请求响应正文合计低于 10 KB。未保存源响应或公开账户与游戏标识，未改网站接口、provider 或 Steam 设置。在发布 [#409](https://github.com/jimmyhuang22/NotionBlog/pull/409) 打开期间，改动留在工作分支。
