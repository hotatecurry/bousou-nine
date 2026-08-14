/**
 * 敬遠（申告敬遠）の計測（フェーズQ-38）。
 *
 *   npm run balance:walk
 *
 * 敬遠は**打たずに塁を1つ与える**手なので、得か損かは「打たせたときの失点期待」と
 * 「走者を1人増やしたうえで次打者と勝負したときの失点期待」の差でしか決まらない。
 * CLAUDE.md「バランス調整の方針＝勘で動かさず必ず計測してから決める」に従って、
 * **CPUがどの打者を歩かせるか**（`shouldCpuIntentionalWalk` のしきい値）をここで決める。
 *
 * ## 何を再利用しているか
 *
 * - **打席の帰結の分布**は既存の `sweep`（タイミング×コースの格子）から作る＝I-29以来の
 *   計測の土台をそのまま使う。分母は**フェアの打球**（`sweep.ts` の約束どおり）。
 * - **進塁と得点は `src/core/rules.ts` の純粋関数をそのまま呼ぶ**
 *   （`advanceOnHitRunners` / `forceAdvanceRunners`）＝進塁の規則をここに書き写さない。
 *   ゲーム側で進塁の仕方が変われば、この計測の結論も一緒に動く。
 *
 * ## 意図的な単純化（絶対値ではなく比較に使う）
 *
 * - **三振・四球・ファウルは打席に数えない**（分母がフェアの打球）。そのぶんアウト率が
 *   実際より低く出て、得点期待は全体に高めに出る。**これは敬遠に不利な方向の偏り**
 *   （走者1人の価値が高く見積もられる）なので、この計測で「敬遠が得」と出る場面は
 *   実際にはもっと得になる。8段目で三振率を仮定した感度も見る（境界は動かなかった）。
 * - **アウトのとき走者は動かない**（併殺も進塁打も無い）。ゲームの `advanceOnHit` が
 *   「全走者が打者と同じ塁数だけ進む」簡易モデルなのと同じ粒度に揃えてある。
 */
import { TEAMS, fielderRowStats, pitcherRowBatting } from '../../src/core/teams';
import {
  type PaDistribution,
  BASE_STATE_COUNT,
  baseStateLabel,
  battleValue,
  distributionFor,
  solveRunExpectancy,
  walkValue,
} from './runExpectancy';
import { pct } from './sweep';

const row = (cells: readonly string[], width = 10): string =>
  cells.map((c) => c.padStart(width)).join('');

// ---- 1. 長打力別の打席帰結の分布 ----

const POWERS = [0, 0.25, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1] as const;
const dists = new Map<number, PaDistribution>();
/** 同じ長打力を二度測らない（sweep は1回441打球ぶん回る） */
function distOf(power: number): PaDistribution {
  const key = Math.round(power * 100) / 100;
  const cached = dists.get(key);
  if (cached) return cached;
  const dist = distributionFor(key);
  dists.set(key, dist);
  return dist;
}
for (const power of POWERS) distOf(power);

console.log('\n=== 1. 長打力（HR）別の打席帰結（ところざわ・打率0.5・基準速） ===');
console.log('   分母はフェアの打球（三振・四球・ファウルは打席に数えない＝sweep.ts の約束）。');
console.log(`${'長打力'.padEnd(8)}${row(['アウト', '単打', '二塁打', '三塁打', '本塁打'])}`);
for (const power of POWERS) {
  const d = distOf(power);
  console.log(
    `${String(power).padEnd(8)}` +
      row([pct(d.out), pct(d.single), pct(d.double), pct(d.triple), pct(d.homerun)]),
  );
}

// ---- 2. 得点期待表（平均打者だけの打線） ----

const AVERAGE_POWER = 0.5;
const table = solveRunExpectancy(distOf(AVERAGE_POWER));

console.log('\n=== 2. 得点期待（平均打者＝長打力0.5だけが並ぶ打線） ===');
console.log('   その状態からイニング終了までに入る点。実際の野球の得点期待表と同じ形。');
console.log(`${'塁状況'.padEnd(14)}${row(['0アウト', '1アウト', '2アウト'])}`);
for (let state = 0; state < BASE_STATE_COUNT; state += 1) {
  console.log(
    `${baseStateLabel(state).padEnd(14)}` +
      row([0, 1, 2].map((outs) => table[outs][state].toFixed(2))),
  );
}

// ---- 3. 敬遠の損得（一塁が空いている場面） ----

const NEXT_POWERS = [0.3, 0.5, 0.7] as const;
/** 一塁が空いている塁状況（＝敬遠しても押し出しにならない） */
const OPEN_FIRST = [0, 2, 4, 6];

console.log('\n=== 3. 敬遠の損得（一塁が空いている場面。正＝敬遠したほうが失点が減る） ===');
console.log('   値は「勝負したときの失点期待 − 敬遠したときの失点期待」。');
console.log('   次打者は長打力0.5（平均）。それ以降は全員平均打者。');
console.log(`${'塁状況'.padEnd(14)}${'アウト'.padEnd(8)}${row(POWERS.map((p) => `力${p}`), 8)}`);
for (const state of OPEN_FIRST) {
  for (const outs of [0, 1, 2]) {
    const cells = POWERS.map((power) => {
      const battle = battleValue(distOf(power), outs, state, table);
      const walk = walkValue(distOf(AVERAGE_POWER), outs, state, table);
      const diff = battle - walk;
      return `${diff >= 0 ? '+' : ''}${diff.toFixed(2)}`;
    });
    console.log(`${baseStateLabel(state).padEnd(14)}${String(outs).padEnd(8)}${row(cells, 8)}`);
  }
}

// ---- 4. 一塁が埋まっている場面（敬遠は必ず損か） ----

console.log('\n=== 4. 一塁が埋まっている場面（走者を押し出す＝敬遠の定石が禁じる場面） ===');
console.log('   同じく「勝負 − 敬遠」。負＝敬遠すると失点が増える。');
console.log(`${'塁状況'.padEnd(14)}${'アウト'.padEnd(8)}${row(POWERS.map((p) => `力${p}`), 8)}`);
for (const state of [1, 3, 5, 7]) {
  for (const outs of [0, 1, 2]) {
    const cells = POWERS.map((power) => {
      const diff =
        battleValue(distOf(power), outs, state, table) -
        walkValue(distOf(AVERAGE_POWER), outs, state, table);
      return `${diff >= 0 ? '+' : ''}${diff.toFixed(2)}`;
    });
    console.log(`${baseStateLabel(state).padEnd(14)}${String(outs).padEnd(8)}${row(cells, 8)}`);
  }
}

// ---- 5. しきい値（CPUの規則を決める） ----

/** 敬遠が得になる最小の長打力（0.01刻み。見つからなければ null） */
function thresholdFor(outs: number, state: number, nextPower: number): number | null {
  const next = distOf(nextPower);
  const walk = walkValue(next, outs, state, table);
  for (let power = 0; power <= 1.0001; power += 0.05) {
    const p = Math.round(power * 100) / 100;
    if (battleValue(distOf(p), outs, state, table) - walk >= 0) return p;
  }
  return null;
}

console.log('\n=== 5. しきい値：どれだけの打者なら歩かせたほうが得か ===');
console.log('   一塁が空いている場面で、敬遠が得になる打者の長打力の下限（0.05刻み）。');
console.log('   「-」＝どんな打者でも勝負したほうが得（＝敬遠する場面ではない）。');
console.log(`${'塁状況'.padEnd(14)}${'アウト'.padEnd(8)}${row(NEXT_POWERS.map((p) => `次打者${p}`), 10)}`);
for (const state of OPEN_FIRST) {
  for (const outs of [0, 1, 2]) {
    const cells = NEXT_POWERS.map((nextPower) => {
      const t = thresholdFor(outs, state, nextPower);
      return t === null ? '-' : t.toFixed(2);
    });
    console.log(`${baseStateLabel(state).padEnd(14)}${String(outs).padEnd(8)}${row(cells, 10)}`);
  }
}

// ---- 6. 次打者の上限（もう1つのしきい値） ----
//
// 敬遠は「この打者を避けて**次打者と勝負する**」手なので、次打者が同じくらい強ければ
// 意味がない。ここでは打者の長打力ごとに「次打者がどこまでなら敬遠が得か」を出す
// ＝CPUの規則が要求する**能力差**そのもの。

/** 敬遠が得でいられる次打者の長打力の上限（0.05刻み。得にならなければ null） */
function nextBatterLimit(outs: number, state: number, power: number): number | null {
  const battle = battleValue(distOf(power), outs, state, table);
  let limit: number | null = null;
  for (let next = 0; next <= 1.0001; next += 0.05) {
    const q = Math.round(next * 100) / 100;
    if (battle - walkValue(distOf(q), outs, state, table) >= 0) limit = q;
  }
  return limit;
}

console.log('\n=== 6. 次打者の上限＝敬遠が要求する「能力差」 ===');
console.log('   一塁が空いていて得点圏に走者がいる代表的な場面。値は「次打者がこの長打力');
console.log('   以下なら敬遠が得」。「-」＝どんな次打者でも勝負したほうが得。');
console.log(`${'打者の長打力'.padEnd(14)}${row(['二塁1死', '三塁1死', '二・三塁1死', '二・三塁2死'], 13)}`);
for (const power of [0.6, 0.7, 0.75, 0.8, 0.9, 1] as const) {
  const cells = [
    nextBatterLimit(1, 2, power),
    nextBatterLimit(1, 4, power),
    nextBatterLimit(1, 6, power),
    nextBatterLimit(2, 6, power),
  ].map((v) => (v === null ? '-' : v.toFixed(2)));
  console.log(`${String(power).padEnd(14)}${row(cells, 13)}`);
}

// ---- 7. 規則が実際に発火するか（名鑑16球団の打線で数える） ----
//
// しきい値を厳しくすれば「損な敬遠」は無くなるが、**一度も発火しない規則は死んだコード**
// （P-37で「名鑑96人のうち何人が頭打ちになるか」で倒す長さを決めたのと同じ見方）。
// 打順は1〜8番が野手・9番が投手で、**次打者は打順の次**（9番の次は1番）。

console.log('\n=== 7. 規則が実際に発火するか（名鑑16球団×9打順＝144通りの並び） ===');
console.log('   「一塁が空いていて得点圏に走者」の場面で、打者と次打者の能力だけを見る。');
console.log('   括弧内は好調（+0.2。フェーズD-19）が乗った打者を数えたとき。');
console.log(`${'しきい値'.padEnd(10)}${'能力差'.padEnd(10)}${row(['該当する打順', '球団数'], 14)}`);
const lineupPowers = TEAMS.map((team) => [
  ...team.lineup.map((r) => fielderRowStats(r).power),
  pitcherRowBatting(team.pitchers[0]).power,
]);
for (const threshold of [0.65, 0.7, 0.75]) {
  for (const gap of [0.15, 0.2, 0.25]) {
    let slots = 0;
    let hotSlots = 0;
    const teams = new Set<number>();
    lineupPowers.forEach((powers, teamIndex) => {
      powers.forEach((power, i) => {
        const next = powers[(i + 1) % powers.length];
        if (power >= threshold && next <= power - gap) {
          slots += 1;
          teams.add(teamIndex);
        }
        // 好調は打者側にだけ乗る（次打者が好調かは打席が来るまで分からない）
        if (power + 0.2 >= threshold && next <= power + 0.2 - gap) hotSlots += 1;
      });
    });
    console.log(
      `${threshold.toFixed(2).padEnd(10)}${gap.toFixed(2).padEnd(10)}` +
        row([`${slots} (${hotSlots})`, `${teams.size}/16`], 14),
    );
  }
}

// ---- 8. 感度：三振を数えても結論の向きが変わらないか ----

console.log('\n=== 8. 感度：打席に三振を混ぜても結論の向きは変わるか ===');
console.log('   分母をフェアの打球に取るとアウト率が低く出る＝走者1人の価値が高く見える');
console.log('   （敬遠に不利な偏り）。三振率を仮定して同じ境界を測り直す。');
console.log(`${'三振率'.padEnd(10)}${row(['二・三塁1死', '三塁2死', '二塁2死', 'なし0死'], 14)}`);
for (const k of [0, 0.15, 0.25]) {
  const kDists = new Map<number, PaDistribution>();
  for (const power of POWERS) kDists.set(power, distributionFor(power, { strikeoutRate: k }));
  const kTable = solveRunExpectancy(kDists.get(AVERAGE_POWER)!);
  const boundary = (outs: number, state: number): string => {
    const walk = walkValue(kDists.get(AVERAGE_POWER)!, outs, state, kTable);
    for (const power of POWERS) {
      if (battleValue(kDists.get(power)!, outs, state, kTable) - walk >= 0) return power.toFixed(2);
    }
    return '-';
  };
  console.log(
    `${pct(k).padEnd(10)}` +
      row([boundary(1, 6), boundary(2, 4), boundary(2, 2), boundary(0, 0)], 14),
  );
}

console.log('\n=== まとめ（この計測が決めたこと） ===');
console.log('   ・一塁が埋まっていたら敬遠は損（4段目）。満塁は必ず1点献上で最大の損。');
console.log('   ・得点圏に走者がいないと、ほぼどんな打者でも勝負したほうが得（3段目）。');
console.log('   ・得点圏に走者がいる場面の境界は長打力 0.70 前後（5段目）で、');
console.log('     三振率を仮定しても動かない（8段目）＝分母の取り方に依存しない結論。');
console.log('   ・次打者との差は 0.20 以上要る（6段目の上限にほぼ一致）。');
console.log('   ・その組み合わせ（0.70／0.20）は名鑑16球団のうち10球団・13打順で成立する');
console.log('     （7段目）＝規則として死んでいない。好調が乗れば40打順まで広がる。');
console.log('');
