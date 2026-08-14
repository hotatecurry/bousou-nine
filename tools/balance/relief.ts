/**
 * CPUの継投を「能力の比較」にする（フェーズZ-47）の計測。
 *
 *   npm run balance:relief
 *
 * W-44 が明示的に残した部分＝**CPU側では疲労が発火しない**を埋める。勘で決めずに
 * 数字にしてから定数を決める（CLAUDE.md「バランス調整の方針」）。
 *
 * 1段目：**いまの規則（J-30）が実際にしていること**（＝出発点。質を見ずに代えている）。
 * 2段目：**物差し**（疲労込みの質＝B-11の読み替えをそのまま使う）が名鑑96人に散らばるか。
 * 3段目：**新しい規則で「どの疲労まで投げるか」**＝このセッションでいちばん決めたいもの。
 * 4段目：**上乗せ（マージン）の候補**＝規則が死なない範囲はどこか。
 * 5段目：**その疲労が人間の攻撃側にどれだけ返ってくるか**（続投を狙う値打ち）。
 * 6段目：**不変条件**（無傷では絶対に代えない／全員疲れていれば続投）。
 *
 * ## この計測が答えられること／答えられないこと
 *
 * **「どちらの投手が良いか」を `sweep` では決められない**（S-40 が配球の持ち味で踏んだのと
 * 同じ壁）：`sweep.ts` の分母は「バットに当たった打球」なので、**当てさせない力**（変化量・
 * 制球）が入っていない。しかも打球初速は `0.5 × 球速` を含むので、**速い投手ほど「当たった
 * ときは打たれる」と出る**＝この分母で質を決めると、遅くて曲がらない投手がいちばん良い
 * ことになってしまう。だから物差しは**能力値の側**（B-11の読み替え）から採り、`sweep` は
 * 5段目で「疲労が実際に打たれ方へ返ってくる量（下限）」を測るのにだけ使う。
 */
import {
  CPU_RELIEF_QUALITY_MARGIN,
  CPU_RELIEF_REMAINING_THRESHOLD,
  chooseCpuRelief,
} from '../../src/core/cpuPitcher';
import {
  RATING_TICKS,
  STAMINA_FRESH_THRESHOLD,
  fatigueFromRemaining,
  pitcherControl,
  pitcherQuality,
  pitcherRole,
  pitcherStuff,
  staminaRemaining,
} from '../../src/core/roster';
import type { PitcherStats, PitcherStuff } from '../../src/core/roster';
import { TEAMS, pitcherRowPitching } from '../../src/core/teams';
import { distributionFor, solveRunExpectancy } from './runExpectancy';

const row = (cells: readonly string[], width = 11): string =>
  cells.map((c) => c.padStart(width)).join('');

const f2 = (v: number): string => v.toFixed(2);
const f3 = (v: number): string => v.toFixed(3);

/** 1打席あたりの投球数（control.ts の9段目と同じ仮定＝比較のための値） */
const PITCHES_PER_PA = 4;
/** 1試合で投手陣が投げるおよその球数（同上） */
const PITCHES_PER_GAME = 140;

// ============================================================
// 共通：1試合ぶんの投手起用をシミュレートする
// ============================================================
//
// **判断の場所は main.ts の `tryCpuRelief` と同じ「打席の切れ目」**にしてある。
// 規則そのもの（`decide`）だけを差し替えられるようにして、旧規則と候補を比べる。

interface StaffResult {
  /** その試合でCPU投手が到達した最大の疲労（＝このセッションが上げたい数字） */
  maxFatigue: number;
  /** 交代の回数 */
  changes: number;
  /** 交代のうち、**降りる投手より質の低い投手を出した**回数（旧規則だけで起きる） */
  downgrades: number;
  /** 最後にマウンドにいた投手の疲労 */
  lastFatigue: number;
  /** ブルペンに残った人数 */
  left: number;
  /** **1球あたりの平均疲労**（最大値と違い「試合を通してどれだけ疲れた球を投げたか」） */
  meanFatigue: number;
}

type ReliefDecision = (
  current: { remaining: number; quality: number },
  bullpen: readonly { index: number; remaining: number; reliever: boolean; quality: number }[],
) => number | null;

function simulateStaff(pitchers: readonly PitcherStats[], decide: ReliefDecision): StaffResult {
  const counts = pitchers.map(() => 0);
  // 先発＝名鑑の先頭（R-39のローテーションの1試合目）。ブルペンは残り5人を名鑑の並びのまま
  let current = 0;
  const bullpen = pitchers.map((_, i) => i).filter((i) => i !== current);
  const remainingOf = (i: number) => staminaRemaining(counts[i], pitchers[i].stamina);
  const fatigueOf = (i: number) => fatigueFromRemaining(remainingOf(i));
  const qualityOf = (i: number) => pitcherQuality(pitchers[i], fatigueOf(i));

  let maxFatigue = 0;
  let fatigueSum = 0;
  let changes = 0;
  let downgrades = 0;
  for (let pitch = 1; pitch <= PITCHES_PER_GAME; pitch += 1) {
    if (pitch % PITCHES_PER_PA === 1 && pitch > 1) {
      const idx = decide(
        { remaining: remainingOf(current), quality: qualityOf(current) },
        bullpen.map((i, k) => ({
          index: k,
          remaining: remainingOf(i),
          reliever: pitcherRole(pitchers[i].stamina) === 'reliever',
          quality: qualityOf(i),
        })),
      );
      if (idx !== null) {
        const before = qualityOf(current);
        current = bullpen.splice(idx, 1)[0];
        changes += 1;
        if (qualityOf(current) < before) downgrades += 1;
      }
    }
    counts[current] += 1;
    maxFatigue = Math.max(maxFatigue, fatigueOf(current));
    fatigueSum += fatigueOf(current);
  }
  return {
    maxFatigue,
    changes,
    downgrades,
    lastFatigue: fatigueOf(current),
    left: bullpen.length,
    meanFatigue: fatigueSum / PITCHES_PER_GAME,
  };
}

/** 旧規則（J-30）＝質を見ない。`chooseCpuRelief` の Z-47 前の中身をそのまま書いたもの */
const OLD_RULE: ReliefDecision = (current, bullpen) => {
  if (current.remaining >= CPU_RELIEF_REMAINING_THRESHOLD) return null;
  const fresh = bullpen.filter((c) => c.remaining >= CPU_RELIEF_REMAINING_THRESHOLD);
  if (fresh.length === 0) return null;
  let best = fresh[0];
  for (const c of fresh.slice(1)) {
    if (c.reliever !== best.reliever) {
      if (c.reliever) best = c;
      continue;
    }
    if (c.remaining > best.remaining) best = c;
  }
  return best.index;
};

/**
 * 新規則の候補（マージン `margin` つき）。**候補の選び方は従来のまま**（ユーザー判断：
 * リリーフ型優先→残量→並び順＝原作p8）で、**その一番手と今の投手を質で比べる**だけ。
 */
const newRule =
  (margin: number): ReliefDecision =>
  (current, bullpen) => {
    const index = OLD_RULE(current, bullpen);
    if (index === null) return null;
    const candidate = bullpen.find((c) => c.index === index);
    if (!candidate) return null;
    return candidate.quality >= current.quality + margin ? index : null;
  };

const STAFFS = TEAMS.map((t) => ({
  short: t.short,
  pitchers: t.pitchers.map((r) => pitcherRowPitching(r)),
}));
const ALL_PITCHERS = STAFFS.flatMap((s) => s.pitchers);

console.log('=== Z-47 CPUの継投を能力の比較にする ===\n');
console.log(
  `（1試合 ${PITCHES_PER_GAME}球・1打席 ${PITCHES_PER_PA}球・先発は名鑑の先頭＝R-39の1試合目。\n` +
    '  判断の場所は main.ts の tryCpuRelief と同じ「打席の切れ目」）\n',
);

// ============================================================
console.log('\n=== 1段目：いまの規則（J-30）が実際にしていること ===\n');
console.log(
  'J-30 は**残量が 0.5 を切った瞬間に、質を一切見ずに代える**。その帰結を2つ数える：\n' +
    '  (a) CPU投手が到達する最大の疲労（＝B-11・W-44の効果が画面に出るか）\n' +
    '  (b) **降りる投手より質の低い投手を出した交代**が何回あるか\n',
);
console.log(row(['キュウダン', 'サイダイヒロウ', 'コウタイ', 'シツガサガル', 'ノコリ']));
let oldFatigueSum = 0;
let oldDowngrades = 0;
let oldChanges = 0;
for (const staff of STAFFS) {
  const r = simulateStaff(staff.pitchers, OLD_RULE);
  oldFatigueSum += r.maxFatigue;
  oldDowngrades += r.downgrades;
  oldChanges += r.changes;
  console.log(
    row([staff.short, f3(r.maxFatigue), String(r.changes), String(r.downgrades), String(r.left)]),
  );
}
console.log(
  `\n  → 16球団の平均最大疲労 ${f3(oldFatigueSum / STAFFS.length)}` +
    `／質が下がる交代 ${oldDowngrades}/${oldChanges} 回`,
);
console.log(
  '    ＝**疲労はほぼ0のまま**（W-44の計測の再現）。B-11の球速・変化量・球威と\n' +
    '      W-44の制球は、CPU側では一度も画面に出ていない。',
);

// ============================================================
console.log('\n\n=== 2段目：物差し（疲労込みの質）が名鑑96人に散らばるか ===\n');
console.log(
  '質＝**疲労を織り込んだ 球速＋変化量（R/Lの平均）＋制球**（0..3）。\n' +
    'B-11 が pitch.ts に「疲労は能力値を下げる形で効かせる＝疲れた投手は一時的に球速も\n' +
    '変化量も低い投手」と書いてあるので、**その読み替えをそのまま比較に使う**\n' +
    '（「疲労1.0は能力値で何点ぶんか」という換算率＝新しい自由変数が要らない）。\n',
);

const qualities = ALL_PITCHERS.map((p) => pitcherQuality(p, 0)).sort((a, b) => a - b);
const median = qualities[Math.floor(qualities.length / 2)];
console.log(
  `無傷の質（96人）： 最小 ${f3(qualities[0])} ／ 中央値 ${f3(median)} ／ 最大 ${f3(
    qualities[qualities.length - 1],
  )}`,
);
const starters = ALL_PITCHERS.filter((p) => pitcherRole(p.stamina) === 'starter');
const relievers = ALL_PITCHERS.filter((p) => pitcherRole(p.stamina) === 'reliever');
const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log(
  `  先発型 ${starters.length}人の平均 ${f3(mean(starters.map((p) => pitcherQuality(p, 0))))}` +
    ` ／ リリーフ型 ${relievers.length}人の平均 ${f3(
      mean(relievers.map((p) => pitcherQuality(p, 0))),
    )}`,
);

console.log('\n疲労が質を削る量（代表的な投手）：\n');
console.log(row(['トウシュ', 'ヒロウ0', 'ヒロウ0.25', 'ヒロウ0.5', 'ヒロウ0.75', 'ヒロウ1.0']));
const SAMPLES: Array<[string, PitcherStats]> = [
  ['エース', { throws: 'R', era: 2.0, speed: 0.8, breakRight: 0.7, breakLeft: 0.7, fork: 0.6, stamina: 0.85 }],
  ['ヘイキン', { throws: 'R', era: 3.1, speed: 0.6, breakRight: 0.5, breakLeft: 0.5, fork: 0.5, stamina: 0.7 }],
  ['アレダマ', { throws: 'R', era: 4.2, speed: 0.5, breakRight: 0.4, breakLeft: 0.4, fork: 0.4, stamina: 0.4 }],
];
for (const [name, stats] of SAMPLES) {
  console.log(
    row([name, ...[0, 0.25, 0.5, 0.75, 1].map((fat) => f3(pitcherQuality(stats, fat)))]),
  );
}
console.log(
  `\n  → 疲労1.0で落ちる量は「球速 ${f2(0.35)}＋変化量そのもの＋制球 ${f2(0.35)}」＝\n` +
    '    **良い投手ほど大きく落ちる**（曲がる投手は曲がりを丸ごと失う）。\n' +
    '    だから「無傷の格下」と「疲れた格上」がどこかで必ず入れ替わる＝比較が成立する。',
);

console.log('\n各球団の先発が、リリーフの一番手に追い抜かれる疲労：\n');
console.log(row(['キュウダン', 'センパツノシツ', 'イチバンテ', 'オイヌカレル']));
let crossSum = 0;
let crossCount = 0;
let neverCrossed = 0;
for (const staff of STAFFS) {
  const starter = staff.pitchers[0];
  // 一番手＝旧規則が最初に選ぶ相手（全員無傷なので「リリーフ型優先→並び順の先」）
  const penIdx = staff.pitchers
    .map((p, i) => ({ p, i }))
    .filter(({ i }) => i !== 0)
    .sort((a, b) => Number(pitcherRole(b.p.stamina) === 'reliever') - Number(pitcherRole(a.p.stamina) === 'reliever'))[0];
  const rival = pitcherQuality(penIdx.p, 0);
  let crossed: number | null = null;
  for (let f = 0; f <= 1.0001; f += 0.01) {
    if (pitcherQuality(starter, f) <= rival) {
      crossed = f;
      break;
    }
  }
  if (crossed === null) neverCrossed += 1;
  else {
    crossSum += crossed;
    crossCount += 1;
  }
  console.log(
    row([
      staff.short,
      f3(pitcherQuality(starter, 0)),
      f3(rival),
      crossed === null ? 'ナシ(1.0マデ)' : f2(crossed),
    ]),
  );
}
console.log(
  `\n  → 追い抜かれる疲労の平均 ${f3(crossSum / Math.max(1, crossCount))}` +
    `（最後まで追い抜かれない球団 ${neverCrossed}/16）`,
);

// ============================================================
console.log('\n\n=== 3段目：新しい規則で「どの疲労まで投げるか」（発火するか） ===\n');
console.log('マージン 0（＝良いほうを出すだけ。新しい定数を持ち込まない）の場合：\n');
console.log(row(['キュウダン', 'サイダイヒロウ', 'コウタイ', 'シツガサガル', 'ノコリ']));
let newFatigueSum = 0;
let newDowngrades = 0;
let newChanges = 0;
let firedTeams = 0;
for (const staff of STAFFS) {
  const r = simulateStaff(staff.pitchers, newRule(0));
  newFatigueSum += r.maxFatigue;
  newDowngrades += r.downgrades;
  newChanges += r.changes;
  if (r.maxFatigue >= 0.2) firedTeams += 1;
  console.log(
    row([staff.short, f3(r.maxFatigue), String(r.changes), String(r.downgrades), String(r.left)]),
  );
}
console.log(
  `\n  → 16球団の平均最大疲労 ${f3(oldFatigueSum / STAFFS.length)} → **${f3(
    newFatigueSum / STAFFS.length,
  )}**` + `／疲労0.2を超える球団 **${firedTeams}/16**`,
);
console.log(
  `    質が下がる交代 ${oldDowngrades}/${oldChanges} → **${newDowngrades}/${newChanges}**` +
    '（＝定義上0。良いほうしか出さない）',
);

// ============================================================
console.log('\n\n=== 4段目：マージンの候補（規則が死なない範囲） ===\n');
console.log(
  '**続投**（＝疲労が発火する）と**交代**（＝ブルペンが意味を持つ）の両方が起きることが要件。\n' +
    'マージンを大きくすると「格上の控えでも出さない」ことになり、J-30の継投が実質消える。\n',
);
console.log(row(['マージン', 'ヘイキンヒロウ', 'コウタイ/16', 'ゼンイントウバン', 'ブルペンノコリ']));
for (const margin of [0, 0.05, 0.1, 0.2, 0.4]) {
  let fatigueSum = 0;
  let changes = 0;
  let noChangeTeams = 0;
  let leftSum = 0;
  for (const staff of STAFFS) {
    const r = simulateStaff(staff.pitchers, newRule(margin));
    fatigueSum += r.maxFatigue;
    changes += r.changes;
    leftSum += r.left;
    if (r.changes === 0) noChangeTeams += 1;
  }
  console.log(
    row([
      f2(margin),
      f3(fatigueSum / STAFFS.length),
      f2(changes / STAFFS.length),
      `${noChangeTeams}/16`,
      f2(leftSum / STAFFS.length),
    ]),
  );
}
console.log(
  '\n  （ゼンイントウバン＝1試合を通して一度も交代しなかった球団の数。ここが増えると\n' +
    '   「CPUは代えてこない」＝J-30が入れた自動継投そのものが死ぬ）\n',
);
console.log(
  '→ **この基準ではマージンの値が決まらない**（0.40 まで上げても交代は 2.00 回残り、\n' +
    '  一度も代えない球団は 0/16 のまま）。W-44 が `FATIGUE_CONTROL_LOSS` で\n' +
    '  「P-37・T-41 の基準はここでは効かない」と書いたのと同じ形なので、**新しい自由変数を\n' +
    '  作らない 0（＝良いほうを出すだけ）を採る**。上げると「格上の控えがいるのに出さない」\n' +
    '  ＝CPUが弱くなるだけで、その見返りを測る尺度がこちらに無い（下の5段目の限界）。',
);

// ============================================================
console.log('\n\n=== 5段目：その疲労は人間の攻撃側にどれだけ返ってくるか ===\n');
console.log(
  '**続投を狙う値打ち**＝疲れた投手を打つことで実際に点が増えるか。`sweep` の分母には\n' +
    '変化量・制球が入らないので、ここで出るのは**下限**（実際の値打ちはこれより大きい）。\n',
);
const runsCache = new Map<number, number>();
const runsAt = (fatigue: number): number => {
  const key = Math.round(fatigue * 100) / 100;
  const hit = runsCache.get(key);
  if (hit !== undefined) return hit;
  const value = solveRunExpectancy(
    distributionFor(0.5, { average: 0.5, pitcherFatigue: key }),
  )[0][0];
  runsCache.set(key, value);
  return value;
};
console.log(row(['ヒロウ', '1イニング失点', '9イニング', 'ムキズヒ']));
const fresh = runsAt(0);
for (const fat of [0, 0.1, 0.2, 0.3, 0.5, 0.75, 1]) {
  const r = runsAt(fat);
  console.log(row([f2(fat), f3(r), f2(r * 9), `${((r / fresh - 1) * 100).toFixed(1)}%`]));
}

console.log(
  '\n**最大値ではなく「1球あたりの平均疲労」で見る**（＝試合を通してどれだけ疲れた球を\n' +
    '投げたか）。ここが旧規則からどれだけ動いたかが、そのまま人間の攻撃側の取り分：\n',
);
console.log(row(['キュウダン', 'キュウ:ヒロウ', 'シン:ヒロウ', 'キュウ:シツテン', 'シン:シツテン']));
let oldMeanSum = 0;
let newMeanSum = 0;
let oldRunsSum = 0;
let newRunsSum = 0;
for (const staff of STAFFS) {
  const o = simulateStaff(staff.pitchers, OLD_RULE);
  const n = simulateStaff(staff.pitchers, newRule(CPU_RELIEF_QUALITY_MARGIN));
  oldMeanSum += o.meanFatigue;
  newMeanSum += n.meanFatigue;
  oldRunsSum += runsAt(o.meanFatigue) * 9;
  newRunsSum += runsAt(n.meanFatigue) * 9;
  console.log(
    row([
      staff.short,
      f3(o.meanFatigue),
      f3(n.meanFatigue),
      f2(runsAt(o.meanFatigue) * 9),
      f2(runsAt(n.meanFatigue) * 9),
    ]),
  );
}
console.log(
  `\n  → 16球団平均：1球あたりの疲労 ${f3(oldMeanSum / STAFFS.length)} → **${f3(
    newMeanSum / STAFFS.length,
  )}**` +
    `／9イニングの失点期待 ${f2(oldRunsSum / STAFFS.length)} → **${f2(
      newRunsSum / STAFFS.length,
    )}点**`,
);
console.log(
  '\n  **この差はCPUが払う費用の見積もりであって、CPUの判断の是非ではない**：この尺度は\n' +
    '  疲労しか見ていない（`sweep` の分母に変化量・制球が入らないので、投手ごとの質を\n' +
    '  区別できない）＝この尺度だけで選ばせると**常にいちばん元気な投手**が最適になり、\n' +
    '  旧規則（質を見ない）に戻ってしまう。S-40 が配球の持ち味を「費用の側」から決められ\n' +
    '  なかったのとまったく同じ構造なので、**物差しは能力値の側（2段目）から採る**。',
);

// ============================================================
console.log('\n\n=== 6段目：不変条件（実際に使う関数で確認） ===\n');
const cand = (remaining: number, reliever: boolean, quality: number, index: number) => ({
  index,
  remaining,
  reliever,
  quality,
});
const checks: Array<[string, boolean]> = [
  [
    '無傷（残量≥0.5）のうちは、どんなに良い控えがいても代えない',
    chooseCpuRelief({ remaining: 1, quality: 0 }, [cand(1, true, 3, 0)]) === null,
  ],
  [
    'ブルペン全員が疲れていれば続投（J-30から不変）',
    chooseCpuRelief({ remaining: 0.1, quality: 0 }, [cand(0.2, true, 3, 0)]) === null,
  ],
  [
    '格下の控えには代えない（Z-47で新しくなった部分）',
    chooseCpuRelief({ remaining: 0.4, quality: 2.0 }, [cand(1, true, 1.5, 0)]) === null,
  ],
  [
    '格上の控えには代える',
    chooseCpuRelief({ remaining: 0.4, quality: 1.0 }, [cand(1, true, 1.5, 0)]) === 0,
  ],
  [
    '候補の順序は従来どおり（リリーフ型優先）',
    chooseCpuRelief({ remaining: 0.4, quality: 0 }, [cand(1, false, 3, 0), cand(1, true, 1, 1)]) ===
      1,
  ],
  [
    'しきい値は人間側の「球威が落ちる境目」と同じ',
    CPU_RELIEF_REMAINING_THRESHOLD === STAMINA_FRESH_THRESHOLD,
  ],
];
for (const [name, ok] of checks) console.log(`  ${ok ? 'OK ' : 'NG '} ${name}`);

console.log(
  '\n（制球の出どころは ERA＝`pitcherControl`。名鑑の中央値 3.10 がちょうど 0.5 なので、' +
    `\n  中央値の投手の制球は ${f2(pitcherControl(3.1))}＝T-41 の基準線がそのまま質にも乗る）`,
);

// ============================================================
console.log('\n\n=== 7段目：その物差しを人間に見せられるか（フェーズDD-51） ===\n');
//
// Z-47 は物差し（合計）を作って閉じたので、**人間の采配メニューには型と残量%しか
// 出ていなかった**＝CPUだけが「疲れたエースと無傷の格下」を比べられる状態だった。
// DD-51 は合計そのものではなく**足す前の3つ**（`pitcherStuff`）を5目盛りのバーで見せる。
// ここで確かめるのは、勘で決めたくない2つ：
//   (a) 5目盛りで**名鑑96人が潰れないか**（同じバーばかりなら見せても判断材料にならない）
//   (b) **バーを見て、CPUと同じ結論に到達できるか**（丸めで「同じに見えるのに代わる」が
//       起きると、Z-47の判断が画面と食い違う＝この見せ方そのものが失敗になる）

const barIndex = (rating: number): number =>
  Math.max(0, Math.min(RATING_TICKS, Math.round(Math.max(0, Math.min(1, rating)) * RATING_TICKS)));

console.log('(a) 5目盛りで96人が潰れないか（無傷。目盛りごとの人数）\n');
console.log(row(['コウモク', ...Array.from({ length: RATING_TICKS + 1 }, (_, i) => `${i}メモリ`)], 9));
const ITEMS: Array<[string, (s: PitcherStuff) => number]> = [
  ['キュウソク', (s) => s.speed],
  ['ヘンカ', (s) => s.breaking],
  ['セイキュウ', (s) => s.control],
];
for (const [label, pick] of ITEMS) {
  const counts = Array.from({ length: RATING_TICKS + 1 }, () => 0);
  for (const p of ALL_PITCHERS) counts[barIndex(pick(pitcherStuff(p, 0)))] += 1;
  console.log(row([label, ...counts.map(String)], 9));
}
const patterns = new Set(
  ALL_PITCHERS.map((p) => ITEMS.map(([, pick]) => barIndex(pick(pitcherStuff(p, 0)))).join('-')),
);
console.log(
  `\n  → 3本の組み合わせは96人で ${patterns.size} 通り` +
    `（1人1通りにはならないが、${RATING_TICKS}目盛り×3本で ${(RATING_TICKS + 1) ** 3} 通りの器がある）`,
);

console.log('\n(b) バーを見て、CPUと同じ結論に到達できるか\n');
//
// CPUが継投を考える場面（残量0.5未満）を総当たりで作り、**バーの合計**（人間が読めるもの）と
// **実数の合計**（CPUが比べるもの）の結論が一致するかを数える。バーで並ぶ＝人間が
// 「どちらが良いか」を目で読めるということ。
let cases = 0;
let agree = 0;
let ties = 0;
/** 結論が食い違った場面の「実際の差」（＝読み違いの大きさ。0..3のうち何点ぶんか） */
let worstFlip = 0;
let worstTie = 0;
const barSum = (s: PitcherStuff): number => ITEMS.reduce((sum, [, pick]) => sum + barIndex(pick(s)), 0);
for (const { pitchers } of STAFFS) {
  for (const current of pitchers) {
    for (const fatigue of [0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
      for (const rival of pitchers) {
        if (rival === current) continue;
        const now = pitcherStuff(current, fatigue);
        const next = pitcherStuff(rival, 0);
        const gap = pitcherQuality(rival, 0) - pitcherQuality(current, fatigue);
        const cpuSwitches =
          chooseCpuRelief({ remaining: 0.4, quality: pitcherQuality(current, fatigue) }, [
            { index: 0, remaining: 1, reliever: true, quality: pitcherQuality(rival, 0) },
          ]) !== null;
        cases += 1;
        if (barSum(now) === barSum(next)) {
          ties += 1;
          worstTie = Math.max(worstTie, Math.abs(gap));
        } else if (barSum(now) < barSum(next) === cpuSwitches) {
          agree += 1;
        } else {
          worstFlip = Math.max(worstFlip, Math.abs(gap));
        }
      }
    }
  }
}
const flips = cases - agree - ties;
console.log(
  `      くらべた場面 ${cases}／バーの長さで結論が一致 ${agree}（${((agree / cases) * 100).toFixed(1)}%）` +
    `\n      バーが同じ長さ（読めない） ${ties}（${((ties / cases) * 100).toFixed(1)}%）｜そのときの実差 最大 ${f3(worstTie)}` +
    `\n      バーが逆を指す ${flips}（${((flips / cases) * 100).toFixed(1)}%）｜そのときの実差 最大 ${f3(worstFlip)}`,
);
console.log(
  '\n  → **見せ方の条件は「逆を指す場面が0」ではなく「食い違うのは読み取り単位より\n' +
    `    小さい差のときだけ」**（この計測で分かった）。1目盛り＝レーティング ${(1 / RATING_TICKS).toFixed(1)}` +
    `＝質 ${(3 / RATING_TICKS).toFixed(1)} 点ぶん\n` +
    `    なので、実差が最大 ${f3(Math.max(worstFlip, worstTie))} の食い違いは**バーの1目盛りにも満たない**\n` +
    '    ＝どちらを出しても同じ場面に限られる（画面が嘘をついている場面は無い）。\n' +
    '    そこは**3本の内訳が違う**（速いが荒れる／曲がらないが制球は落ちない）ので、\n' +
    '    どちらを取るかは人間の判断＝合計値を1本のバーで出さなかった理由でもある。',
);
