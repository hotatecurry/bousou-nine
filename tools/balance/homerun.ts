/**
 * ホームランの出やすさ（フェーズJJ-57）。
 *
 * テストプレイの報告「ホームランが出やすすぎる」を数字にするための計測。
 * **判定は `src/core` の純粋関数をそのまま呼ぶ**ので、定数を動かせばここも一緒に動く。
 *
 * 打球初速の式は1本しかない（`batting.ts` の `judgeSwing`）：
 *
 *   初速 = (EXIT_SPEED_BASE + EXIT_PITCH_CARRY×球速 + EXIT_POWER_BONUS×長打力
 *           + EXIT_FATIGUE_BONUS×疲労) × 質(タイミング・コース)
 *
 * したがって **`EXIT_SPEED_BASE` を δ 下げることは、球速を 2δ 下げることと完全に同値**
 * （`EXIT_PITCH_CARRY`=0.5）。この同値性のおかげで、**定数を書き換えずに候補を測れる**
 * （`sweep` の `pitchSpeed` を動かすだけ）。5段目はそれを使っている。
 *
 * 実行：`npm run balance:hr`
 */
import {
  EXIT_PITCH_CARRY,
  EXIT_POWER_BONUS,
  EXIT_SPEED_BASE,
  LAUNCH_BASE_DEG,
} from '../../src/core/batting';
import { DEFAULT_BALLPARK, fenceAt } from '../../src/core/ballpark';
import { TEAMS, teamById } from '../../src/core/teams';
import { HOT_MODIFIER } from '../../src/core/condition';
import { createTeamRoster } from '../../src/core/roster';

/** 打線の人数（`roster.ts` は外へ出していないのでここで持つ） */
const LINEUP_SIZE = 9;
import { SPEED_FAST, SPEED_NEUTRAL, SPEED_SLOW } from '../../src/core/pitch';
import { distributionFor, solveLineup } from './runExpectancy';
import { carryOf } from './physics';

const row = (cells: readonly string[], width = 10): string =>
  cells.map((c) => c.padStart(width)).join('');

/**
 * 「バットに当たらない打席」の割合。**この計測の唯一の仮定**で、`sweep` の格子は
 * 当たった打球だけを見るので、1試合の本数に直すにはこれが要る（三振・四球ぶん）。
 * 実際の野球の三振率（約23%）に合わせてある。**HR/100打球のほうはこの仮定に依存しない**
 * ので、値を疑うときはそちらを見る。
 */
const NO_CONTACT_RATE = 0.23;

/** 能力値をまるめてキャッシュする（sweep は格子を舐めるので重い） */
const cache = new Map<string, ReturnType<typeof distributionFor>>();
function distOf(power: number, average: number, pitchSpeed = SPEED_NEUTRAL) {
  const key = `${power.toFixed(2)}/${average.toFixed(2)}/${pitchSpeed.toFixed(1)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const d = distributionFor(power, {
    average,
    pitchSpeed,
    strikeoutRate: NO_CONTACT_RATE,
  });
  cache.set(key, d);
  return d;
}

/** その打線の1試合のHR数・得点（打順ごとの打席数で重み付け） */
function gameOf(
  batters: ReadonlyArray<{ power: number; average: number }>,
  pitchSpeed = SPEED_NEUTRAL,
  hotCount = 0,
) {
  const dists = batters.map((b, i) => {
    const hot = i < hotCount;
    return distOf(
      Math.min(1, b.power + (hot ? (HOT_MODIFIER.power ?? 0) : 0)),
      Math.min(1, b.average + (hot ? (HOT_MODIFIER.average ?? 0) : 0)),
      pitchSpeed,
    );
  });
  const solved = solveLineup(dists);
  let homeruns = 0;
  for (let i = 0; i < dists.length; i += 1) homeruns += solved.pa[i] * dists[i].homerun;
  return { homeruns, runs: solved.runs };
}

/** 名鑑の打線9人（打撃の能力値だけ） */
function lineupOf(teamId: string) {
  const roster = createTeamRoster(teamById(teamId));
  return roster.lineup.map((id) => ({
    name: roster.players[id].name,
    power: roster.players[id].batting.power,
    average: roster.players[id].batting.average,
  }));
}

console.log('ホームランの出やすさ（球場＝ところざわ／格子441点／三振・四球ぶん', `${(NO_CONTACT_RATE * 100).toFixed(0)}%`, 'を除いた打席で計算）');
console.log(
  `初速の式：(${EXIT_SPEED_BASE} + ${EXIT_PITCH_CARRY}×球速 + ${EXIT_POWER_BONUS}×長打力) × 質`,
);

// ---- 1. いまの出方（16球団の実際の打線） ----

console.log('\n=== 1. 16球団の打線が1試合に打つHR（基準速36m/s） ===');
console.log(`${'球団'.padEnd(12)}${row(['HR/試合', '得点/試合', '打線の長打力'], 12)}`);
const perTeam: Array<{ name: string; hr: number; runs: number }> = [];
for (const team of TEAMS) {
  const batters = lineupOf(team.id);
  const g = gameOf(batters);
  perTeam.push({ name: team.name, hr: g.homeruns, runs: g.runs });
  const avgPower = batters.reduce((s, b) => s + b.power, 0) / batters.length;
  console.log(
    `${team.name.padEnd(12)}${row([g.homeruns.toFixed(2), g.runs.toFixed(2), avgPower.toFixed(2)], 12)}`,
  );
}
const leagueHr = perTeam.reduce((s, t) => s + t.hr, 0) / perTeam.length;
const leagueRuns = perTeam.reduce((s, t) => s + t.runs, 0) / perTeam.length;
console.log(
  `\n   16球団平均：**HR ${leagueHr.toFixed(2)}本/試合**・得点 ${leagueRuns.toFixed(2)}点/試合`,
);
console.log(
  `   最多 ${Math.max(...perTeam.map((t) => t.hr)).toFixed(2)}本／最少 ${Math.min(...perTeam.map((t) => t.hr)).toFixed(2)}本`,
);
console.log('   参考：実際の野球は1チーム1試合あたり約1.1〜1.3本（得点は約4.5点）。');

// ---- 2. 球速で何倍変わるか ----

console.log('\n=== 2. 球速別（同じ打線・16球団平均） ===');
console.log(`${'球速'.padEnd(16)}${row(['HR/試合', '得点/試合'], 12)}`);
for (const [label, speed] of [
  ['フォーク 22m/s', SPEED_SLOW],
  ['基準 36m/s', SPEED_NEUTRAL],
  ['速球 42m/s', SPEED_FAST],
] as const) {
  let hr = 0;
  let runs = 0;
  for (const team of TEAMS) {
    const g = gameOf(lineupOf(team.id), speed);
    hr += g.homeruns;
    runs += g.runs;
  }
  console.log(
    `${label.padEnd(16)}${row([(hr / TEAMS.length).toFixed(2), (runs / TEAMS.length).toFixed(2)], 12)}`,
  );
}
console.log('   ＝速球は「当てられたときに飛ぶ」（初速に 0.5×球速 が入る）ので差が大きい。');

// ---- 3. 好調（D-19）とラッキー7の寄与 ----

console.log('\n=== 3. 好調の寄与（HOT_MODIFIER=+0.2 が AV と HR の両方に乗る） ===');
console.log(`${'状態'.padEnd(20)}${row(['HR/試合', '得点/試合'], 12)}`);
for (const [label, hot] of [
  ['好調なし', 0],
  ['好調2人（D-19の常態）', 2],
  ['全員好調（ラッキー7）', LINEUP_SIZE],
] as const) {
  let hr = 0;
  let runs = 0;
  for (const team of TEAMS) {
    const g = gameOf(lineupOf(team.id), SPEED_NEUTRAL, hot);
    hr += g.homeruns;
    runs += g.runs;
  }
  console.log(
    `${label.padEnd(20)}${row([(hr / TEAMS.length).toFixed(2), (runs / TEAMS.length).toFixed(2)], 12)}`,
  );
}

// ---- 4. なぜ小さな差で大きく動くのか（フェンスと飛距離の余裕） ----

console.log('\n=== 4. 芯を食った打球の飛距離と、フェンスまでの余裕 ===');
console.log(`${'長打力'.padEnd(10)}${row(['芯の初速', '飛距離', '中堅の柵', '余裕'], 11)}`);
for (const power of [0.0, 0.25, 0.5, 0.75, 1.0]) {
  const speed = EXIT_SPEED_BASE + EXIT_PITCH_CARRY * SPEED_NEUTRAL + EXIT_POWER_BONUS * power;
  const dist = carryOf(speed, LAUNCH_BASE_DEG);
  const fence = fenceAt(DEFAULT_BALLPARK, 0).distance;
  console.log(
    `${power.toFixed(2).padEnd(10)}${row([speed.toFixed(1), dist.toFixed(1), fence.toFixed(1), (dist - fence).toFixed(1)], 11)}`,
  );
}
console.log('   ＝**柵の距離と飛距離がほぼ同じ帯に並んでいる**ので、初速が 1m/s 動くだけで');
console.log('     「越える／越えない」が入れ替わる（好調 +0.2 は初速 +1.2m/s に相当）。');

// ---- 5. レバー：打球初速を一律に下げる ----

console.log('\n=== 5. 打球初速を一律 δ m/s 下げたら（＝EXIT_SPEED_BASE を δ 下げる） ===');
console.log('   球速を 2δ 下げるのと完全に同値なので、定数を書き換えずに測れる。');
console.log(
  `${'δ(m/s)'.padEnd(10)}${row(['HR/試合', '得点/試合', '安打率', 'ラッキー7のHR'], 13)}`,
);
for (const delta of [0, 0.5, 1, 1.5, 2, 2.5, 3]) {
  const speed = SPEED_NEUTRAL - delta / EXIT_PITCH_CARRY;
  let hr = 0;
  let runs = 0;
  let hits = 0;
  let hot7 = 0;
  for (const team of TEAMS) {
    const batters = lineupOf(team.id);
    const g = gameOf(batters, speed);
    hr += g.homeruns;
    runs += g.runs;
    hot7 += gameOf(batters, speed, LINEUP_SIZE).homeruns;
    for (const b of batters) {
      const d = distOf(b.power, b.average, speed);
      hits += (d.single + d.double + d.triple + d.homerun) / batters.length;
    }
  }
  const n = TEAMS.length;
  console.log(
    `${delta.toFixed(1).padEnd(10)}` +
      row(
        [
          (hr / n).toFixed(2),
          (runs / n).toFixed(2),
          `${((hits / n) * 100).toFixed(1)}%`,
          (hot7 / n).toFixed(2),
        ],
        13,
      ),
  );
}
console.log('   ＝**HRは急に減り、安打率と得点はゆるやかにしか減らない**（柵の帯にだけ効くため）。');

// ---- 6. レバー：長打力の効き幅（EXIT_POWER_BONUS）を下げる ----

console.log('\n=== 6. 長打力の効き幅を下げたら（EXIT_POWER_BONUS 6 → x） ===');
console.log('   打球初速の上乗せは 長打力×x なので、長打力を x/6 倍に読み替えて測る。');
console.log(`${'x(m/s)'.padEnd(10)}${row(['HR/試合', '得点/試合', '強打者と平均の差'], 16)}`);
for (const x of [6, 5, 4, 3]) {
  let hr = 0;
  let runs = 0;
  for (const team of TEAMS) {
    const batters = lineupOf(team.id).map((b) => ({ ...b, power: (b.power * x) / EXIT_POWER_BONUS }));
    const g = gameOf(batters);
    hr += g.homeruns;
    runs += g.runs;
  }
  const strong = distOf((0.9 * x) / EXIT_POWER_BONUS, 0.5).homerun;
  const mid = distOf((0.5 * x) / EXIT_POWER_BONUS, 0.5).homerun;
  console.log(
    `${x.toFixed(1).padEnd(10)}` +
      row(
        [(hr / TEAMS.length).toFixed(2), (runs / TEAMS.length).toFixed(2), `${((strong - mid) * 100).toFixed(1)}pt`],
        16,
      ),
  );
}
console.log('   ＝こちらは**強打者だけを削る**ので、名鑑の長打力の差そのものが薄まる。');

// ---- 7. CPU打者はジャストミートで振る（I-29が記録した既知の偏り） ----
//
// **一様な格子は「実際にどう当たるか」を表していない**：CPU打者は基準速に対して常に
// t=0（ジャストミート）で振る（`cpuBatter.ts`）ので、**タイミングの減衰がまったく
// 掛からない**。人間の上手いプレイヤーも同じ帯に寄っていく。1〜6段目の数字は格子の
// 平均なので、ここが実際に画面で起きていることに近い。

console.log('\n=== 7. タイミングが合ったときのHR率（コースだけを格子で舐める） ===');
console.log('   CPU打者は常に t=0 で振るので、こちらが「実際に見えるHRの出方」に近い。');
console.log(`${'長打力'.padEnd(10)}${row(['一様な格子', 't=0固定', '倍率'], 13)}`);
for (const power of [0.25, 0.5, 0.75, 1.0]) {
  const flat = distributionFor(power, { average: 0.5, strikeoutRate: NO_CONTACT_RATE });
  const sweet = distributionFor(power, {
    average: 0.5,
    strikeoutRate: NO_CONTACT_RATE,
    timing: 0,
  });
  console.log(
    `${power.toFixed(2).padEnd(10)}` +
      row(
        [
          `${(flat.homerun * 100).toFixed(1)}%`,
          `${(sweet.homerun * 100).toFixed(1)}%`,
          `${(sweet.homerun / Math.max(1e-9, flat.homerun)).toFixed(1)}倍`,
        ],
        13,
      ),
  );
}

console.log('\n=== 8. δを入れたときの「t=0で振ったときのHR率」 ===');
console.log(`${'δ(m/s)'.padEnd(10)}${row(['長打力0.25', '0.50', '0.75', '1.00'], 12)}`);
for (const delta of [0, 1, 2, 3, 4]) {
  const speed = SPEED_NEUTRAL - delta / EXIT_PITCH_CARRY;
  const cells = [0.25, 0.5, 0.75, 1.0].map((power) => {
    const d = distributionFor(power, {
      average: 0.5,
      pitchSpeed: speed,
      strikeoutRate: NO_CONTACT_RATE,
      timing: 0,
    });
    return `${(d.homerun * 100).toFixed(1)}%`;
  });
  console.log(`${delta.toFixed(1).padEnd(10)}${row(cells, 12)}`);
}
