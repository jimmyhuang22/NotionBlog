/** Fictional trophies for the trophy preview page only. Names, art, rates and days are all made up. */
import type { Trophy, TrophyCount, TrophyGrade, TrophySet } from "@/lib/game-trophies";

const hues = [18, 42, 200, 265, 150, 330, 8, 90, 230, 300];
const shapes = [
  "<circle cx='32' cy='30' r='13'/>",
  "<path d='M32 14l16 18-16 18-16-18z'/>",
  "<path d='M32 13l5 12h13l-10 8 4 13-12-8-12 8 4-13-10-8h13z'/>",
  "<path d='M18 46l14-30 14 30z'/>",
  "<rect x='19' y='19' width='26' height='26' rx='6'/>",
];
/** A small square of made-up art, standing in for a platform's 64×64 icon. */
function art(index: number): string {
  const hue = hues[index % hues.length]!;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><defs><radialGradient id='g' cx='50%' cy='38%' r='70%'><stop offset='0' stop-color='hsl(${hue} 70% 46%)'/><stop offset='1' stop-color='hsl(${hue} 60% 12%)'/></radialGradient></defs><rect width='64' height='64' fill='url(#g)'/><g fill='hsl(${hue} 90% 82%)' opacity='.92'>${shapes[index % shapes.length]}</g><rect y='52' width='64' height='12' fill='rgba(0,0,0,.35)'/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const names: [string, string][] = [
  ["初入荒原", "走出最初的洞窟"], ["第一次倒下", "第一次在旅途中倒下"], ["篝火旁", "点亮第一处篝火"], ["骑马的人", "得到坐骑"],
  ["远方来信", "收到第一封信"], ["铸剑者", "把一把武器强化到顶"], ["收藏家", "收集 20 件护符"], ["夜行", "在夜里穿过整片沼泽"],
  ["雾中行者", "走出雾之森"], ["地下之城", "抵达地下的城市"], ["王座之下", "击败城中的守王者"], ["古老的契约", "完成古老的契约"],
  ["深渊回响", "听见深渊下的回声"], ["灰烬", "让城市化为灰烬"], ["百战余生", "击败 100 名强敌"], ["学徒", "学会 10 种法术"],
  ["月下誓言", "在满月下立誓"], ["无名之墓", "找到无名的墓"], ["风车之丘", "登上风车之丘"], ["破晓之刃", "取得破晓之刃"],
  ["孤身渡海", "不召唤任何帮手渡过冰海"], ["长夜将尽", "看见长夜的尽头"], ["无伤的旅途", "不受伤击败一位守护者"], ["归乡", "回到出发的地方"],
  ["钟声", "敲响山顶的钟"], ["星之子", "走进结局“星之子”"], ["余烬之王", "走进结局“余烬之王”"], ["守夜人", "守住篝火直到天明"],
];
const rates = [88.9, 86.1, 80.4, 72.0, 64.3, 30.2, 55.3, 48.9, 25.7, 44.0, 9.5, 21.3, 38.5, 35.2, 18.0, 33.0, 12.4, 29.4, 27.8, 6.8, 4.6, 14.2, 2.1, 52.0, 40.1, 23.9, 16.5, 3.3];
/** Rarer trophies carry the higher grades, as on the platforms. */
const gradeFor = (rate: number): TrophyGrade => rate <= 10 ? "gold" : rate <= 30 ? "silver" : "bronze";

/** One set of `total` trophies; `earnedDays` gives the day for each earned position (index into the list). */
function makeSet(id: string, platform: string, total: number, earnedDays: Record<number, string | null>, graded: boolean, hiddenFrom = 24): TrophySet {
  const trophies: Trophy[] = Array.from({ length: total }, (_, index) => {
    const [name, detail] = names[(index + 27) % names.length]!;
    const earned = index in earnedDays;
    const rate = index === 0 ? 3.1 : rates[(index + 27) % rates.length]!;
    const grade = graded ? (index === 0 ? "platinum" : gradeFor(rate)) : null;
    return { id: `${id}-${index}`, name: index === 0 && graded ? "全部收集" : name, detail: index === 0 && graded ? "拿到其他所有奖杯" : detail,
      grade, icon: { id: `${id}-icon-${index}`, src: art(index), alt: "", width: 64, height: 64 }, earned,
      earnedDate: earned ? earnedDays[index] ?? null : null, rarityPercent: rate, hidden: index >= hiddenFrom };
  });
  const earned = trophies.filter(trophy => trophy.earned).length;
  const grades = graded ? Object.fromEntries((["platinum", "gold", "silver", "bronze"] as TrophyGrade[]).map(grade => {
    const ofGrade = trophies.filter(trophy => trophy.grade === grade);
    return [grade, { earned: ofGrade.filter(trophy => trophy.earned).length, total: ofGrade.length }];
  })) as Record<TrophyGrade, TrophyCount> : undefined;
  return { id, platform, earned, total, progressPercent: Math.round(earned / total * 100), ...(grades ? { grades } : {}), trophies };
}

const partial: Record<number, string | null> = {
  1: "2022-04-28", 3: "2023-07-09", 5: "2022-04-10", 6: "2022-03-27", 7: "2022-04-24", 9: "2022-04-03", 11: "2022-04-12", 13: "2025-11-02",
  15: "2022-03-18", 16: "2022-03-18", 17: "2022-03-19", 18: "2022-03-20", 19: "2022-03-24", 20: "2022-03-30", 21: "2022-04-02", 22: "2022-04-08",
  23: "2022-04-15", 24: "2025-11-25", 25: "2022-04-26", 26: "2023-07-02", 27: "2025-11-20", 28: null,
};
const all = (total: number) => Object.fromEntries(Array.from({ length: total }, (_, index) => [index, index === 0 ? "2025-11-28" : `2025-${String(3 + (index % 9)).padStart(2, "0")}-${String(1 + (index % 27)).padStart(2, "0")}`]));

export const trophyCases: Record<string, { label: string; note: string; sets: TrophySet[]; body: boolean }> = {
  full: { label: "两个平台", note: "PS5 和 Steam 各一套，标题右边切换；左栏每个平台一行。", body: true,
    sets: [makeSet("demo-ps5", "PS5", 42, partial, true), makeSet("demo-steam", "Steam", 30, { 15: "2023-07-02", 16: "2023-07-02", 17: "2023-07-04", 18: "2023-07-05", 9: "2023-07-09", 26: "2023-07-05" }, false, 99)] },
  single: { label: "一个平台", note: "只有 PS5 一套：左栏是完整统计，标题旁写个数。没有正文时不再显示“还没有写下游玩记录”。", body: false,
    sets: [makeSet("demo-ps5-only", "PS5", 42, partial, true)] },
  platinum: { label: "已白金", note: "全部拿完：白金是最上面的横幅，下面不再重复；没有“未拿到”按钮。", body: false,
    sets: [makeSet("demo-plat", "PS5", 42, all(42), true)] },
  zero: { label: "一个都没拿到", note: "0 / N 照常显示，只有“未拿到”按钮。", body: false,
    sets: [makeSet("demo-zero", "PS4", 20, {}, true, 12)] },
  summary: { label: "只有统计", note: "后端只交付了第一步（每套的统计，没有逐个奖杯）：只有左栏；正文下没有“奖杯”一节，所以“还没有写下游玩记录”照常显示。", body: false,
    sets: [makeSet("demo-sum-4", "PS4", 30, partial, true), makeSet("demo-sum-5", "PS5", 20, {}, true)].map(({ trophies: _list, ...set }) => set) },
  none: { label: "没有奖杯", note: "任天堂或拿不到成就的游戏：页面和现在一样。", body: false, sets: [] },
};
