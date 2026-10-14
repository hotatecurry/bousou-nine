/**
 * CPUの試合前の采配（打順）と、球団の個性（走力）の計測（フェーズR-39）。
 *
 *   npm run balance:lineup
 *
 * 決めたかったのは2つ。**CPUがどう打順を組むか**と、**CPUがどの走者に盗塁を仕掛けるか**
 * （`chooseCpuSteals` のしきい値）。どちらも CLAUDE.md「バランス調整の方針＝勘で動かさず
 * 必ず計測してから決める」に従い、得点期待（`runExpectancy.ts`）の上で損得を出した。
 *
 * **結論は「打順は触らない・盗塁は走力を見る」**（下のまとめ）。打順のほうは計測が
 * 設計を否定した側で、名鑑（B-12）が既に定石順で書かれているため、能力値から組み直すと
 * かえって得点期待が下がる。この計測を残してあるのは**同じ懸念を蒸し返さないため**
 * （CLAUDE.md「計測で問題なしと出たら、それも結論として記録して閉じる」）。
 *
 * ## 何を再利用しているか
 *
 * - **打席の帰結の分布**は既存の `sweep`（タイミング×コースの格子）から作る＝I-29以来の
 *   計測の土台をそのまま使う。分母は**フェアの打球**（`sweep.ts` の約束どおり）。
 * - **進塁と得点は `src/core/rules.ts` の純粋関数**、**盗塁の窓は `src/core/fielding.ts` の
 *   `stealSafeJumpSec`** をそのまま呼ぶ＝規則をここに書き写さない。ゲーム側の定数
 *   （塁間・送球速度・持ち替え・走力の幅）を動かせば、この計測の結論も一緒に動く。
 *
 * ## 意図的な単純化（絶対値ではなく比較に使う）
 *
 * - 三振・四球・ファウルは打席に数えない（`walk.ts` と同じ分母）。**全打順に一様に効く
 *   偏り**なので、打順どうしの比較には影響しない。
 * - 併殺・進塁打が無い（アウトのとき走者は動かない）＝`advanceOnHit` の粒度に揃えてある。
 *   実際の野球の打順論で「1番に俊足」と言われる根拠の一部（併殺を避ける）はこの
 *   モデルには入っていない。
 * - **走力（RUN）は内野安打にだけ効く**（`sweep` の `runnerSpeed`）。盗塁の価値は
 *   打順の計算には入れず、5〜7段目で別に測る。
 *
 * 1打者ぶんの分布を出すのに `sweep` が441打球を回すので、**16球団×9人＝144人ぶんで
 * 40秒ほどかかる**（一度出した能力値の組は使い回す）。
 */
import { TEAMS, fielderRowStats, pitcherRowBatting } from '../../src/core/teams';
import type { BatterStats } from '../../src/core/roster';
import {
  BASE_POSITIONS,
  CPU_STEAL_JUMP_SEC,
  MAX_LEAD,
  STEAL_LEAD,
  runnerSpeed,
  stealSafeJumpSec,
} from '../../src/core/fielding';
import {
  type PaDistribution,
  distributionFor,
  solveLineup,
  solveRunExpectancy,
} from './runExpectancy';

const row = (cells: readonly string[], width = 10): string =>
  cells.map((c) => c.padStart(width)).join('');

const LINEUP_SIZE = 9;

// ---- 打者の分布のキャッシュ（同じ能力値の組は二度測らない） ----

const dists = new Map<string, PaDistribution>();
function distOf(stats: { average: number; power: number; run: number }): PaDistribution {
  const key = `${stats.average}/${stats.power}/${stats.run}`;
  const cached = dists.get(key);
  if (cached) return cached;
  const dist = distributionFor(stats.power, { average: stats.average, run: stats.run });
  dists.set(key, dist);
  return dist;
}

/** 名鑑の1球団 → 打順1〜8番の野手＋先発投手（＝名鑑どおりの並び） */
function teamBatters(teamIndex: number): BatterStats[] {
  const team = TEAMS[teamIndex];
  return [
    ...team.lineup.map((r) => fielderRowStats(r)),
    pitcherRowBatting(team.pitchers[0]),
  ];
}

const AVERAGE = { average: 0.5, power: 0.5, run: 0.5 };
const STRONG = { average: 0.75, power: 0.85, run: 0.5 };
const PITCHER = { average: 0.18, power: 0.1, run: 0.36 };

// ---- 1. 打順の値打ち（どの打順に強打者を置くと点が増えるか） ----
//
// 打線の中に**1人だけ**強打者を置き、その打順を1番から9番まで動かして1試合の得点期待を
// 見る。これが「打順の値打ちの順位」そのもので、CPUの打順（`cpuBattingOrder`）は
// この順位に沿って強い打者から埋める。

console.log('\n=== 1. 打順の値打ち（平均打者8人＋強打者1人。強打者の打順を動かす） ===');
console.log('   1試合（9回）の得点期待。強打者＝AV0.75 HR0.85／他は全員 AV0.5 HR0.5。');
console.log(`${'強打者の打順'.padEnd(14)}${row(['得点期待', '1番との差'], 12)}`);

function strongAtSlotRuns(slot: number): number {
  const lineup = Array.from({ length: LINEUP_SIZE }, (_, i) =>
    distOf(i === slot ? STRONG : AVERAGE),
  );
  return solveLineup(lineup).runs;
}
const strongRuns = Array.from({ length: LINEUP_SIZE }, (_, i) => strongAtSlotRuns(i));
for (let slot = 0; slot < LINEUP_SIZE; slot += 1) {
  console.log(
    `${`${slot + 1}番`.padEnd(14)}` +
      row([strongRuns[slot].toFixed(3), (strongRuns[slot] - strongRuns[0]).toFixed(3)], 12),
  );
}
const slotRank = Array.from({ length: LINEUP_SIZE }, (_, i) => i).sort(
  (a, b) => strongRuns[b] - strongRuns[a],
);
console.log(`   値打ちの高い順：${slotRank.map((s) => `${s + 1}番`).join(' > ')}`);

// ---- 2. 打順ごとの打席数（値打ちの出どころ） ----

console.log('\n=== 2. 打順ごとの1試合の打席数（平均打者だけの打線） ===');
const flat = solveLineup(Array.from({ length: LINEUP_SIZE }, () => distOf(AVERAGE)));
console.log(
  `${'打順'.padEnd(8)}` + row(Array.from({ length: LINEUP_SIZE }, (_, i) => `${i + 1}番`), 7),
);
console.log(`${'打席数'.padEnd(8)}` + row(flat.pa.map((v) => v.toFixed(2)), 7));

// ---- 3. 投手を何番に置くか（原作の既定は9番） ----

console.log('\n=== 3. 投手（最弱打者）を何番に置くか ===');
console.log('   平均打者8人＋投手1人。値が大きいほど良い打順。');
console.log(`${'投手の打順'.padEnd(14)}${row(['得点期待'], 12)}`);
const pitcherRuns = Array.from({ length: LINEUP_SIZE }, (_, slot) =>
  solveLineup(
    Array.from({ length: LINEUP_SIZE }, (_, i) => distOf(i === slot ? PITCHER : AVERAGE)),
  ).runs,
);
for (let slot = 0; slot < LINEUP_SIZE; slot += 1) {
  console.log(`${`${slot + 1}番`.padEnd(14)}` + row([pitcherRuns[slot].toFixed(3)], 12));
}
const bestPitcherSlot = pitcherRuns.indexOf(Math.max(...pitcherRuns));
const pitcherSlotLoss = pitcherRuns[bestPitcherSlot] - pitcherRuns[LINEUP_SIZE - 1];
console.log(
  `   最良は ${bestPitcherSlot + 1}番（原作の既定は9番。9番との差 ${pitcherSlotLoss.toFixed(3)}点）`,
);

// ---- 4. 打力スコアの選び方（名鑑16球団で並べ替えて比べる） ----
//
// CPUは試合中に `sweep` を回せないので、**能力値レーティングから作る1つのスコア**で
// 並べるしかない。どのスコアが「本当に良い並び」にいちばん近いかをここで決める。
// 比較の相手は**局所探索**（2つの打順を入れ替えて良くなる限り繰り返す）で得た並び。

type Score = (s: BatterStats) => number;
const SCORES: Array<{ name: string; score: Score }> = [
  { name: 'AV+HR', score: (s) => s.average + s.power },
  { name: 'AV', score: (s) => s.average },
  { name: 'HR', score: (s) => s.power },
  { name: 'AV*2+HR', score: (s) => s.average * 2 + s.power },
  { name: 'AV+HR*2', score: (s) => s.average + s.power * 2 },
  { name: 'AV+HR+RUN/2', score: (s) => s.average + s.power + s.run / 2 },
];

/** スコア降順の選手を、打順の値打ちの高い順（slotRank）に置く */
function orderByScore(batters: readonly BatterStats[], score: Score): number[] {
  const byScore = batters.map((_, i) => i).sort((a, b) => score(batters[b]) - score(batters[a]));
  const order = new Array<number>(LINEUP_SIZE).fill(0);
  slotRank.forEach((slot, rank) => {
    order[slot] = byScore[rank];
  });
  return order;
}

function runsOfOrder(batters: readonly BatterStats[], order: readonly number[]): number {
  return solveLineup(order.map((i) => distOf(batters[i]))).runs;
}

/** 2つの打順の入れ替えで良くなる限り繰り返す（決定的な山登り） */
function hillClimb(batters: readonly BatterStats[], start: readonly number[]): number[] {
  let order = [...start];
  let best = runsOfOrder(batters, order);
  for (let pass = 0; pass < 20; pass += 1) {
    let improved = false;
    for (let a = 0; a < LINEUP_SIZE; a += 1) {
      for (let b = a + 1; b < LINEUP_SIZE; b += 1) {
        const trial = [...order];
        [trial[a], trial[b]] = [trial[b], trial[a]];
        const runs = runsOfOrder(batters, trial);
        if (runs > best + 1e-9) {
          order = trial;
          best = runs;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return order;
}

console.log('\n=== 4. 打力スコアの選び方（名鑑16球団の平均。1試合の得点期待） ===');
console.log('   「名鑑どおり」＝いまのCPU（`TeamData` の並びそのまま・9番が投手）。');
console.log('   「最良」＝局所探索（総当たりの入れ替え）で見つけた並び＝到達しうる上限。');

const scoreTotals = new Map<string, number>();
let bookTotal = 0;
let bestTotal = 0;
let worstTotal = 0;
const pitcherSlots = new Array<number>(LINEUP_SIZE).fill(0);
const teamRows: Array<{ name: string; book: number; rule: number; best: number }> = [];

for (let t = 0; t < TEAMS.length; t += 1) {
  const batters = teamBatters(t);
  const book = Array.from({ length: LINEUP_SIZE }, (_, i) => i);
  const bookRuns = runsOfOrder(batters, book);
  bookTotal += bookRuns;
  for (const { name, score } of SCORES) {
    const runs = runsOfOrder(batters, orderByScore(batters, score));
    scoreTotals.set(name, (scoreTotals.get(name) ?? 0) + runs);
  }
  const best = hillClimb(batters, book);
  const bestRuns = runsOfOrder(batters, best);
  bestTotal += bestRuns;
  pitcherSlots[best.indexOf(LINEUP_SIZE - 1)] += 1;
  // いちばん悪い並び（最良の逆をたどる）＝打順を触ることの振れ幅の下限
  const worst = hillClimb(batters, book.slice().reverse());
  worstTotal += Math.min(runsOfOrder(batters, book.slice().reverse()), runsOfOrder(batters, worst));
  teamRows.push({
    name: TEAMS[t].name,
    book: bookRuns,
    rule: runsOfOrder(batters, orderByScore(batters, SCORES[0].score)),
    best: bestRuns,
  });
}

console.log(`${'並べ方'.padEnd(16)}${row(['得点期待', '名鑑との差'], 12)}`);
console.log(`${'名鑑どおり'.padEnd(16)}` + row([(bookTotal / 16).toFixed(3), '-'], 12));
for (const { name } of SCORES) {
  const total = (scoreTotals.get(name) ?? 0) / 16;
  console.log(
    `${name.padEnd(16)}` + row([total.toFixed(3), `+${(total - bookTotal / 16).toFixed(3)}`], 12),
  );
}
console.log(
  `${'最良（局所探索）'.padEnd(16)}` +
    row([(bestTotal / 16).toFixed(3), `+${(bestTotal / 16 - bookTotal / 16).toFixed(3)}`], 12),
);
console.log(
  `   最良の並びで投手が入った打順：` +
    pitcherSlots.map((n, i) => (n > 0 ? `${i + 1}番×${n}` : '')).filter(Boolean).join(' '),
);

console.log('\n   球団ごと（名鑑どおり / AV+HR / 最良）：');
for (const r of teamRows) {
  console.log(
    `${r.name.padEnd(12)}` +
      row([r.book.toFixed(3), r.rule.toFixed(3), r.best.toFixed(3)], 10),
  );
}

// ---- 5. 盗塁の損益分岐（得点期待から出る「必要な成功率」） ----

const table = solveRunExpectancy(distOf(AVERAGE));

/** 盗塁が得になる最小の成功率。失敗＝走者が消えてアウトが1つ増える */
function breakEven(fromState: number, toState: number, outs: number): number | null {
  const stay = table[outs][fromState];
  const succeed = table[outs][toState];
  const fail = outs + 1 >= 3 ? 0 : table[outs + 1][fromState & ~1 & ~2 & ~4];
  if (succeed <= fail) return null;
  return (stay - fail) / (succeed - fail);
}

console.log('\n=== 5. 盗塁の損益分岐（この成功率を下回る盗塁は損） ===');
console.log('   得点期待（平均打者の打線）から。失敗＝その走者が消えてアウトが1つ増える。');
console.log(`${'盗塁'.padEnd(14)}${row(['0アウト', '1アウト', '2アウト'], 12)}`);
console.log(
  `${'一塁→二塁'.padEnd(14)}` +
    row([0, 1, 2].map((o) => (breakEven(1, 2, o) ?? 0).toFixed(3)), 12),
);
console.log(
  `${'二塁→三塁'.padEnd(14)}` +
    row([0, 1, 2].map((o) => (breakEven(2, 4, o) ?? 0).toFixed(3)), 12),
);

// ---- 6. 走力ごとの「守備の余裕」（しきい値をどこに置くか） ----
//
// CPUのスタートは `CPU_STEAL_JUMP_SEC`（0.25秒）に固定してある＝**完璧な送球なら刺せる
// 遅さ**（A-7の設計。人間の捕手がK+塁指定を出せば刺せる）。その「刺せる余裕」が
// 走力によってどれだけ縮むかを秒で出す。
//
//   余裕 = その走者に要るジャンプ（stealSafeJumpSec）− CPUのスタート（0.25秒）
//
// **余裕が人の反応時間（0.2秒前後）を下回ると、守備は先読みしていないと刺せない**
// ＝そこから上が「仕掛ける値打ちのある走者」。

const RUNS = [0, 0.2, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] as const;

function slack(from: 'first' | 'second', run: number, lead: number): number {
  return (
    stealSafeJumpSec(from, BASE_POSITIONS.home, lead, runnerSpeed(run)) - CPU_STEAL_JUMP_SEC
  );
}

console.log('\n=== 6. 走力ごとの「守備の余裕」（秒。小さいほど刺しにくい） ===');
console.log('   CPUのスタートは 0.25秒（従来どおり）。負＝完璧な送球でも間に合わない。');
console.log(
  `${'走力'.padEnd(8)}${row(['二盗(標準)', '二盗(深)', '三盗(標準)', '三盗(深)'], 12)}`,
);
for (const run of RUNS) {
  console.log(
    `${String(run).padEnd(8)}` +
      row(
        [
          slack('first', run, STEAL_LEAD).toFixed(3),
          slack('first', run, MAX_LEAD).toFixed(3),
          slack('second', run, STEAL_LEAD).toFixed(3),
          slack('second', run, MAX_LEAD).toFixed(3),
        ],
        12,
      ),
  );
}
console.log(`   標準リード=${STEAL_LEAD}m（A-7）／深いリード=${MAX_LEAD}m（L-32の持ち越し上限）`);

// ---- 7. 規則が実際に発火するか（名鑑16球団で数える） ----
//
// しきい値を厳しくすれば「損な盗塁」は無くなるが、**一度も発火しない規則は死んだコード**
// （Q-38の7段目・P-37の「96人のうち何人が頭打ちになるか」と同じ見方）。
// あわせて**球団の個性が数字に出るか**＝俊足の球団（ウィンズ）と鈍足の球団で差が出るか。

console.log('\n=== 7. しきい値ごとに、名鑑16球団の何人が二盗を仕掛けるか ===');
console.log('   対象は打線9人＋控え3人（＝塁に出うる12人）×16球団＝192人。標準リード。');
console.log(`${'しきい値'.padEnd(10)}${row(['該当', '球団数', '最多の球団', '最少'], 14)}`);

const teamRunners = TEAMS.map((team) => [
  ...team.lineup.map((r) => fielderRowStats(r).run),
  ...team.bench.map((r) => r[4]),
]);

for (const threshold of [0, 0.1, 0.15, 0.2, 0.3]) {
  const counts = teamRunners.map(
    (runs) => runs.filter((r) => slack('first', r, STEAL_LEAD) <= threshold).length,
  );
  const total = counts.reduce((a, b) => a + b, 0);
  const teams = counts.filter((c) => c > 0).length;
  const max = Math.max(...counts);
  const min = Math.min(...counts);
  const top = counts.map((c, i) => (c === max ? TEAMS[i].short : '')).filter(Boolean).join(',');
  console.log(
    `${threshold.toFixed(2).padEnd(10)}` +
      row([`${total}/192`, `${teams}/16`, `${top}(${max})`, String(min)], 14),
  );
}

console.log('\n   球団ごとの人数（しきい値0.10・標準リード）：');
const counts10 = teamRunners.map(
  (runs) => runs.filter((r) => slack('first', r, STEAL_LEAD) <= 0.1).length,
);
for (let i = 0; i < TEAMS.length; i += 1) {
  console.log(`${TEAMS[i].name.padEnd(12)}${String(counts10[i]).padStart(4)}人 / 12`);
}

console.log('\n=== まとめ（この計測が決めたこと） ===');
console.log('   【打順：CPUに規則を持たせない】');
console.log(`   ・打順の値打ちは ${slotRank.map((s) => s + 1).join('>')} の順（1段目）だが、`);
const topSlots = strongRuns.slice(0, 4);
console.log(
  `     上位4つの差は ${(Math.max(...topSlots) - Math.min(...topSlots)).toFixed(3)}点＝誤差。` +
    '出どころは打席数（2段目）で、1番と9番でも',
);
console.log(`     1試合${(flat.pa[0] - flat.pa[LINEUP_SIZE - 1]).toFixed(2)}打席しか違わない。`);
console.log(
  bestPitcherSlot === LINEUP_SIZE - 1
    ? '   ・投手は 9番が最良（3段目）＝原作の既定（9番）と一致する。'
    : `   ・投手は ${bestPitcherSlot + 1}番が最良（3段目）だが、9番との差は ${pitcherSlotLoss.toFixed(3)}点＝誤差。` +
        '\n     ＝**9番に固定して失うものは無い**（一様な格子では、長打力の無い打者の外した' +
        '\n     当たりが野手の前に落ちて出塁だけはする＝打席の多い上位に置いても損が出ない。BBB-82）。',
);
const bestRuleGain = Math.max(...SCORES.map(({ name }) => (scoreTotals.get(name) ?? 0) / 16)) - bookTotal / 16;
const bestOrderGain = bestTotal / 16 - bookTotal / 16;
const asPct = (v: number) => `${v >= 0 ? '+' : ''}${((v / (bookTotal / 16)) * 100).toFixed(1)}%`;
console.log(
  `   ・能力値のスコアで組み直しても名鑑どおりから ${asPct(bestRuleGain)} まで（4段目）。B-12が名鑑を`,
);
console.log(
  `     定石順で手書きしているため。局所探索の最良でも ${asPct(bestOrderGain)} しか動かない＝`,
);
console.log('     **打順を触ることに値打ちが無い**（I-29の TIMING_SWEET_BAND、O-35の');
console.log('     「F＝緩急の幅」と同じく、計測が設計を否定した）。');
console.log('   【盗塁：走力を見る】');
const be = (from: number, to: number) => [0, 1, 2].map((o) => breakEven(from, to, o) ?? 0);
const range = (v: number[]) => `${Math.min(...v).toFixed(2)}〜${Math.max(...v).toFixed(2)}`;
console.log(
  `   ・一塁→二塁は成功率 ${range(be(1, 2))} を下回ると損（5段目）＝軽々しく走ってよい手ではない。`,
);
console.log(
  `     二塁→三塁の分岐点は ${range(be(2, 4))}` +
    (Math.min(...be(2, 4)) > Math.max(...be(1, 2))
      ? '＝二盗より高い（二塁の走者は安打1本でたいてい還れるので、三塁へ進む上積みが小さい）。'
      : '。'),
);
console.log('   ・走力は「守備に残る余裕」を 0.53秒（走力0）→ -0.08秒（1.0）まで動かす（6段目）。');
console.log('     人の反応（0.2秒前後）を下回るところから上が、仕掛ける値打ちのある走者。');
console.log('   ・しきい値は 0.10秒（7段目）＝192人中54人・球団ごと1〜7人で、規則が死なず');
console.log('     球団の個性が数字に出る。0.00では6球団が皆無、0.20ではほぼ全員になる。');
console.log('   ・三盗は標準リードではどの走力でも成立しない（6段目）＝L-32の深いリードを');
console.log('     持ち越したときだけ出る＝**けん制の駆け引きの見返り**になっている。');
console.log('');
