/**
 * 代走の計測（フェーズGG-54）。
 *
 *   npm run balance:pinchrun
 *
 * EE-52（采配メニューと打順の段に走力の列）→FF-53（打者カードと塁上の走者に走力）と
 * **走力を見せてきた流れの終点**にあたる。見せたのに、**塁に出た後に足で動かす手が
 * 1つも無かった**（v1に代走が無いことは `managerMenu.ts`・CLAUDE.md が明記していた）。
 *
 * CLAUDE.md「バランス調整の方針＝勘で動かさず必ず計測してから決める」に従って、
 * **代走にどれだけの値打ちがあるか**と**CPUがいつ出すか**をここで決める。
 *
 * ## 測るもの（代走の値打ちは「走力の差」がどの帯に効くか、で決まる）
 *
 * 走力（RUN）は塁間の所要時間に一様に効く（`runnerSpeed`＝6.8〜8.2m/s）。したがって
 * 代走の値打ちは**新しい仕組みではなく、既にある4つの時間競争の帯が動く量**として測れる：
 *
 *   1. 盗塁（`cpuStealDefenseSlack`。R-39）
 *   2. 打球での余分な進塁（`cpuExtraBaseSlack`。X-45）
 *   3. タッチアップ（`cpuTagUpDefenseSlack`。S-40）
 *   4. けん制で刺される深さ（`pickoffOutLead`。S-40）
 *
 * **どれも代走のために新しく作った式ではない**＝代走は「その塁に立っている人の
 * `run` を差し替える」だけの手で、判定側には新しい経路が1つも増えない。
 *
 * ## 何を再利用しているか
 *
 * - **帯はすべて `src/core/fielding.ts` の純粋関数をそのまま呼ぶ**（判定式をここに
 *   書き写さない）＝定数を動かせばこの計測も一緒に動く。
 * - **打球の分布は `sweep`**（I-29以来の土台）。10段目の `hitCases` と同じ組み立てで、
 *   X-45が「余分な進塁」を測ったのとまったく同じ格子を使う。
 * - **得点確率は `runExpectancy.ts` の `solveScoreProbability`**（X-45が送りバントの
 *   ために足した尺度）。代走も「アウトを増やさずに塁を進める」手なので、平均点より
 *   「1点以上入る確率」で見るほうが素直（終盤の1点を取りに行く手だから）。
 *
 * ## 意図的な単純化（絶対値ではなく比較に使う）
 *
 * - **守備は完璧な送球**（確保から投げるまでの遅れを含めない）＝走者に厳しい側。
 *   ここで「代走が効く」と出る場面は、実機ではもっと効く。
 * - **リードは標準**（L-32の持ち越しは攻撃側に有利な方向にしか働かない）。
 * - 打席の帰結の分布は `sweep` 由来＝**分母はフェアの打球**（三振・四球を数えない）。
 *   offense.ts・walk.ts と同じ約束で、絶対値ではなく比較に使う。
 */
import {
  type FielderId,
  type Vec2,
  BASE_POSITIONS,
  CONTROLLABLE_FIELDERS,
  CPU_STEAL_MAX_DEFENSE_SLACK_SEC,
  CPU_TAG_UP_MARGIN_SEC,
  FIELDER_HOME_POSITIONS,
  FIELDER_SPEED,
  cpuExtraBaseSlack,
  cpuStealDefenseSlack,
  cpuTagUpDefenseSlack,
  distance,
  nearestFielder,
  pickoffOutLead,
  predictLandingAt,
  runnerSpeed,
} from '../../src/core/fielding';
import { createBattedBall, judgeSwing } from '../../src/core/batting';
import { SPEED_NEUTRAL } from '../../src/core/pitch';
import { RATING_TICKS, ratingBar } from '../../src/core/roster';
import { TEAMS, benchRowStats, fielderRowStats, pitcherRowBatting } from '../../src/core/teams';
import {
  type PaDistribution,
  type ScoreProbability,
  BASE_STATE_COUNT,
  baseStateLabel,
  distributionFor,
  solveLineup,
  solveRunExpectancy,
  solveScoreProbability,
} from './runExpectancy';
import { crossXFor, pct, sweep, swingTimeFor } from './sweep';

const row = (cells: readonly string[], width = 10): string =>
  cells.map((c) => c.padStart(width)).join('');

const RUNS = [0, 0.25, 0.5, 0.75, 1] as const;
const BASE_LEG = distance(BASE_POSITIONS.first, BASE_POSITIONS.second);
const ticksOf = (rating: number): number => (ratingBar(rating).match(/●/g) ?? []).length;

// 塁の状態のビット（offense.ts と同じ並び：1=一塁 2=二塁 4=三塁）
const FIRST = 1;
const SECOND = 2;
const THIRD = 4;

// ---- 1. 走力が動かす4つの帯（代走は「この差」を買う手） ----
//
// 代走で得られるのは走力の差そのものなので、まず**その差が何秒ぶんか**を出す。
// 4つとも「正なら完璧な送球で刺せる／負なら間に合わない」という同じ向きの量
// （R-39・S-40・X-45 が同じ形で揃えてある）なので、1つの表に並べられる。

console.log('=== 1. 走力が動かす帯（すべて `fielding.ts` の純粋関数をそのまま呼ぶ） ===');
console.log('   盗塁・進塁・タッチアップは「守備に残る余裕(秒)」＝**負なら完璧な送球でも刺せない**。');
console.log('   けん制は「刺される最小のリード(m)」＝**大きいほど深く出られる**。');
console.log(
  `${'走力'.padEnd(8)}${'m/s'.padEnd(8)}${row(
    ['塁間s', '盗塁(一→二)', '盗塁(二→三)', 'タッチ(三→本)', 'けん制(一塁)'],
    14,
  )}`,
);
// タッチアップは「外野の定位置くらいの深さのフライ」を代表点に取る（S-40の 78m 前後）
const TAG_UP_CATCH: Vec2 = { x: 0, z: -78 };
for (const run of RUNS) {
  const speed = runnerSpeed(run);
  console.log(
    `${run.toFixed(2).padEnd(8)}${speed.toFixed(2).padEnd(8)}` +
      row(
        [
          (BASE_LEG / speed).toFixed(2),
          cpuStealDefenseSlack('first', { speedOf: () => speed }).toFixed(2),
          cpuStealDefenseSlack('second', { speedOf: () => speed }).toFixed(2),
          cpuTagUpDefenseSlack('third', TAG_UP_CATCH, speed).toFixed(2),
          pickoffOutLead('first', FIELDER_HOME_POSITIONS.P, speed).toFixed(2),
        ],
        14,
      ),
  );
}
console.log(
  `   鈍足(0.0)→俊足(1.0) の差：塁間 ${(BASE_LEG / runnerSpeed(0) - BASE_LEG / runnerSpeed(1)).toFixed(2)}秒`,
);

// ---- 2. 盗塁：代走で「走れない走者」が「走れる走者」になるか ----
//
// R-39 のしきい値（`CPU_STEAL_MAX_DEFENSE_SLACK_SEC`＝0.10秒）は「その走者が走ったとき
// 守備に残る余裕」で、**これを下回る走者だけがCPUの盗塁の対象**になる。代走の値打ちが
// いちばん大きいのはここ＝**足を入れ替えた瞬間に、走れなかった塁が走れる塁になる**。

console.log('\n=== 2. 盗塁：どの走力から「仕掛ける値打ちがある」側に入るか ===');
console.log(`   R-39のしきい値＝守備の余裕 ${CPU_STEAL_MAX_DEFENSE_SLACK_SEC.toFixed(2)}秒 以下。`);
console.log(`${'走力'.padEnd(8)}${row(['一→二 余裕', '走れる', '二→三 余裕', '走れる'], 13)}`);
for (const run of RUNS) {
  const speed = runnerSpeed(run);
  const s1 = cpuStealDefenseSlack('first', { speedOf: () => speed });
  const s2 = cpuStealDefenseSlack('second', { speedOf: () => speed });
  console.log(
    `${run.toFixed(2).padEnd(8)}` +
      row(
        [
          s1.toFixed(2),
          s1 <= CPU_STEAL_MAX_DEFENSE_SLACK_SEC ? 'ハシレル' : '-',
          s2.toFixed(2),
          s2 <= CPU_STEAL_MAX_DEFENSE_SLACK_SEC ? 'ハシレル' : '-',
        ],
        13,
      ),
  );
}
/** その走力なら一塁から走れるか（R-39の規則そのもの） */
const canSteal = (run: number): boolean =>
  cpuStealDefenseSlack('first', { speedOf: () => runnerSpeed(run) }) <=
  CPU_STEAL_MAX_DEFENSE_SLACK_SEC;
// 走れるようになる境界の走力（0.01刻み）
let stealThreshold = 1;
for (let r = 0; r <= 1.0001; r += 0.01) {
  const v = Math.round(r * 100) / 100;
  if (canSteal(v)) {
    stealThreshold = v;
    break;
  }
}
console.log(`   一塁から走れるようになる走力の境界：${stealThreshold.toFixed(2)}`);

// ---- 3. 打球での余分な進塁（X-45の帯が走力でどれだけ動くか） ----
//
// offense.ts の 10段目と**まったく同じ組み立て**（平均打者の安打を sweep の格子から集め、
// 着地点の予測から守備の時間を見積もる）。ここで見るのは走力による割合の差だけ。

const NEUTRAL = { power: 0.5, average: 0.5 };
const controllableHome = Object.fromEntries(
  CONTROLLABLE_FIELDERS.map((id) => [id, FIELDER_HOME_POSITIONS[id]]),
) as Record<FielderId, Vec2>;

interface HitCase {
  point: Vec2;
  sec: number;
}
const hitCases: HitCase[] = [];
for (const s of sweep({ batter: NEUTRAL })) {
  const kind = s.result.outcome.kind;
  if (kind !== 'beatThrow' && kind !== 'hit' && kind !== 'groundRuleDouble') continue;
  const crossX = crossXFor(s.course);
  const launch = judgeSwing(
    { crossX, swingTime: swingTimeFor(s.timing), pitchSpeed: SPEED_NEUTRAL },
    NEUTRAL,
  );
  if (launch === null) continue;
  const landing = predictLandingAt(createBattedBall(launch, crossX));
  const chaser = nearestFielder(landing.point, controllableHome);
  const chaseSec = distance(FIELDER_HOME_POSITIONS[chaser], landing.point) / FIELDER_SPEED;
  hitCases.push({ point: landing.point, sec: Math.max(landing.sec, chaseSec) });
}

/** その走力で「もう1つ先の塁」を狙える安打の割合（X-45の規則そのもの） */
function extraShare(from: 'first' | 'second' | 'third', run: number): number {
  const speed = runnerSpeed(run);
  const go = hitCases.filter(
    (c) =>
      cpuExtraBaseSlack({ from, speed, securePoint: c.point, secureSec: c.sec }) <=
      -CPU_TAG_UP_MARGIN_SEC,
  );
  return go.length / hitCases.length;
}

console.log('\n=== 3. 打球で余分な塁を狙える安打の割合（分母は平均打者の安打 ' + hitCases.length + ' 本） ===');
console.log(`${'走力'.padEnd(8)}${row(['一塁→三塁', '二塁→本塁', '三塁→本塁'], 13)}`);
for (const run of RUNS) {
  console.log(
    `${run.toFixed(2).padEnd(8)}` +
      row(
        [
          pct(extraShare('first', run)),
          pct(extraShare('second', run)),
          pct(extraShare('third', run)),
        ],
        13,
      ),
  );
}
console.log(
  `   鈍足→俊足の差：一塁 ${((extraShare('first', 1) - extraShare('first', 0)) * 100).toFixed(1)}pt` +
    ` / 二塁 ${((extraShare('second', 1) - extraShare('second', 0)) * 100).toFixed(1)}pt`,
);

// ---- 4. 代走の利得（得点確率） ----
//
// 走力そのものは打席の帰結（`PaDistribution`）を動かさない（内野安打だけは動くが、
// **代走は打席に立たない**ので関係ない）＝代走の利得は「走者が余分に進む確率が上がる」
// ことからしか出ない。そこで**塁状況の遷移**に落として得点確率の差で測る
// （X-45の13段目「余分な塁の値打ち」とまったく同じ読み方）。

const distribution: PaDistribution = distributionFor(0.5, { average: 0.5 });
const scoreTable: ScoreProbability = solveScoreProbability(distribution);

console.log('\n=== 4. 塁を1つ多く取ることの値打ち（得点確率。X-45の13段目と同じ読み方） ===');
console.log(`${'場面'.padEnd(24)}${row(['止まる', '進む', '差'], 11)}`);
const TRANSITIONS: Array<[string, number, number]> = [
  ['一塁走者が二塁へ(盗塁)', FIRST, SECOND],
  ['一塁走者が三塁へ', FIRST | SECOND, FIRST | THIRD],
  ['二塁走者が生還', SECOND, 0],
];
for (const [label, before, after] of TRANSITIONS) {
  for (const outs of [0, 1, 2]) {
    // 「二塁走者が生還」は点が入るので確率1
    const go = label === '二塁走者が生還' ? 1 : scoreTable[outs][after];
    const stop = scoreTable[outs][before];
    console.log(
      `${`${label}(${outs}死)`.padEnd(24)}` +
        row([pct(stop), pct(go), `+${((go - stop) * 100).toFixed(1)}pt`], 11),
    );
  }
}

console.log('\n   ↑ これを「代走で走力がどれだけ上がるか」に掛けたのが代走の利得。');
console.log('   盗塁は失敗すると走者が消えて1アウト増えるので、損益分岐の成功率も出す：');
console.log(`${'アウト'.padEnd(8)}${row(['成功(二塁)', '失敗(走者無)', '現状(一塁)', '分岐点'], 13)}`);
for (const outs of [0, 1]) {
  const success = scoreTable[outs][SECOND];
  const fail = scoreTable[outs + 1][0];
  const stay = scoreTable[outs][FIRST];
  // p*success + (1-p)*fail >= stay を解く
  const p = (stay - fail) / (success - fail);
  console.log(
    `${String(outs).padEnd(8)}` +
      row([pct(success), pct(fail), pct(stay), p.toFixed(2)], 13),
  );
}

// ---- 5. 代走の費用＝控えを1人使うと代打が1つ減る ----
//
// **代走と代打は同じ資源（控え3人）を食い合う**（`roster.bench`）。したがってCPUの規則は
// 「代走の利得 > 失う代打の利得」でなければならない。X-45が測った代打の利得は
// **得点圏で +7.7〜+16.7pt**（`balance:offense` の8段目）なので、それと比べる。

console.log('\n=== 5. 費用：控えは代打と食い合う（X-45の代打の利得＝得点圏で +7.7〜+16.7pt） ===');
console.log('   代走の利得は「走力の差 × 帯の広がり」なので、上の 4. の差より必ず小さくなる。');
console.log('   ＝**盗塁が成立するようになる場面**でだけ、代打に匹敵する利得が出る。');
const stealGain0 = scoreTable[0][SECOND] - scoreTable[0][FIRST];
const stealGain1 = scoreTable[1][SECOND] - scoreTable[1][FIRST];
console.log(
  `   盗塁が1つ増えることの値打ち：0死 +${(stealGain0 * 100).toFixed(1)}pt / 1死 +${(stealGain1 * 100).toFixed(1)}pt`,
);

// ---- 6. 名鑑16球団で規則が発火するか（しきい値を決める） ----
//
// X-45が `CPU_PINCH_HIT_GAP`（AV+HRの差 0.80）を決めたのと同じ見方＝**しきい値ごとに
// 何球団で成立するか**。厳しすぎると規則が死に（どの球団も代走を出さない）、緩すぎると
// 個性が出ない（全球団が毎試合出す）。

console.log('\n=== 6. しきい値：走力の差がどれだけあれば代走に値打ちがあるか ===');
console.log('   「その塁の走者より、控えの最速がどれだけ速いか」＝ run の差。');
console.log('   分母は 16球団 × 打線9人（投手を含む）＝144通り。');
console.log(
  `${'しきい値'.padEnd(10)}${row(['発火する打者', '割合', '発火する球団'], 15)}`,
);
interface TeamCase {
  team: string;
  /** 打線9人（野手8＋投手）の走力 */
  lineup: number[];
  /** 控え3人の走力 */
  bench: number[];
}
const teamCases: TeamCase[] = TEAMS.map((team) => ({
  team: team.name,
  lineup: [
    ...team.lineup.map((r) => fielderRowStats(r).run),
    // 投手も打順に入る（DH制なし＝B-10）。先発の1人ぶんを代表に取る
    pitcherRowBatting(team.pitchers[0]).run,
  ],
  bench: team.bench.map((r) => benchRowStats(r).run),
}));
for (const gap of [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5]) {
  let hits = 0;
  let total = 0;
  const teams = new Set<string>();
  for (const c of teamCases) {
    const best = Math.max(...c.bench);
    for (const run of c.lineup) {
      total += 1;
      if (best - run >= gap) {
        hits += 1;
        teams.add(c.team);
      }
    }
  }
  console.log(
    `${gap.toFixed(2).padEnd(10)}` +
      row([String(hits), pct(hits / total), `${teams.size}/16`], 15),
  );
}

console.log('\n   球団ごとの内訳（控えの最速 − 打線でいちばん遅い選手）：');
console.log(`${'球団'.padEnd(14)}${row(['控え最速', '打線最遅', '差', 'メモリ差'], 11)}`);
for (const c of teamCases) {
  const best = Math.max(...c.bench);
  const worst = Math.min(...c.lineup);
  console.log(
    `${c.team.padEnd(14)}` +
      row(
        [
          best.toFixed(2),
          worst.toFixed(2),
          (best - worst).toFixed(2),
          String(ticksOf(best) - ticksOf(worst)),
        ],
        11,
      ),
  );
}

// ---- 7. 「その走者は代走の甲斐があるか」を1つの量で言えるか ----
//
// R-39の盗塁・S-40のタッチアップ・X-45の余分な進塁は、どれも**「守備に残る余裕」1本**で
// 規則を書いている（新しい自由変数を作らない）。代走も同じ形で書けるなら、
// **`CPU_PINCH_RUN_GAP`（走力の差）1本**で足りる。ここでは「差がしきい値以上のとき、
// 実際に帯がまたがるか」を確かめる＝またがらないなら、その差は画面の飾りでしかない。

console.log('\n=== 7. 差がしきい値以上のとき、実際に帯をまたぐか（一塁走者・盗塁の帯） ===');
console.log('   「走れない → 走れる」に変わった組み合わせだけが、代走の値打ちが跳ねる場面。');
console.log(`${'しきい値'.padEnd(10)}${row(['発火', 'うち帯をまたぐ', '割合'], 16)}`);
for (const gap of [0.1, 0.15, 0.2, 0.25, 0.3, 0.4]) {
  let fired = 0;
  let crossed = 0;
  for (const c of teamCases) {
    const best = Math.max(...c.bench);
    for (const run of c.lineup) {
      if (best - run < gap) continue;
      fired += 1;
      if (!canSteal(run) && canSteal(best)) crossed += 1;
    }
  }
  console.log(
    `${gap.toFixed(2).padEnd(10)}` +
      row([String(fired), String(crossed), fired === 0 ? '-' : pct(crossed / fired)], 16),
  );
}

// ---- 8. 5目盛りのバー（FF-53）で、代走の判断が画面から読めるか ----
//
// DD-51の7段目・EE-52の15段目と同じ確認＝**画面が読める大きさの嘘をつかない**こと。
// FF-53で塁上の走者の走力はバーで出るようになったので、「代えるべきかどうか」は
// そのバーと控えのバーの比較で読める必要がある。

console.log('\n=== 8. しきい値の差が、FF-53のバー（5目盛り）で見えるか ===');
console.log(`   1目盛り = 走力 ${(1 / RATING_TICKS).toFixed(2)}。しきい値がこれ未満だと画面から読めない。`);
for (const gap of [0.1, 0.15, 0.2, 0.25, 0.3]) {
  const ticks = gap * RATING_TICKS;
  console.log(
    `   ${gap.toFixed(2)} → ${ticks.toFixed(1)} 目盛り ${ticks >= 1 ? '（読める）' : '（読めない）'}`,
  );
}

console.log('\n=== 9. 塁状況の得点確率（代走の判断の背景。0死） ===');
console.log(`${'塁状況'.padEnd(14)}${row(['0死', '1死', '2死'], 9)}`);
for (let state = 0; state < BASE_STATE_COUNT; state += 1) {
  console.log(
    `${baseStateLabel(state).padEnd(14)}` +
      row([0, 1, 2].map((o) => pct(scoreTable[o][state])), 9),
  );
}

// ---- 10. 本当の費用：代走で入った選手は、以後その打順で打ち続ける ----
//
// 上の 5段目で見た「控えを1人使う＝代打が1つ減る」は費用の半分でしかない。**代走で
// 入った選手はその打順を引き継ぐ**（B-10の「代打は退いた選手の守備位置を引き継ぐ」と
// 同じ扱い）ので、**残りの試合ぶん、その打順の打力が入れ替わる**。
//
// 足の速い控えが打力でも上回るとは限らないので、これは**イニングが早いほど大きい費用**
// になる＝**実際の野球で代走が終盤にしか出ない理由そのもの**。ここで測るのは
// 「残り何イニングなら、盗塁1つの利得が打力の入れ替えの費用を上回るか」。
//
// 利得と費用を同じ単位（得点期待＝平均何点）で比べる：得点確率は「1点以上入るか」の
// 一発勝負の量で、**打席をまたいで積み上がる費用の側には使えない**ため。

const runTable = solveRunExpectancy(distribution);
/** 盗塁が1つ成立することの値打ち（得点期待。0死・一塁→二塁） */
const stealRunGain = runTable[0][SECOND] - runTable[0][FIRST];

// `distributionFor` は1回ごとに sweep の格子を回す（重い）ので、能力値でキャッシュする
// （offense.ts の `distOf` と同じ。名鑑の値は 0.01 刻みなので丸めて鍵にする）。
const distCache = new Map<string, PaDistribution>();
function distOf(power: number, average: number): PaDistribution {
  const key = `${power.toFixed(2)}/${average.toFixed(2)}`;
  const cached = distCache.get(key);
  if (cached) return cached;
  const dist = distributionFor(Math.round(power * 100) / 100, {
    average: Math.round(average * 100) / 100,
  });
  distCache.set(key, dist);
  return dist;
}

/** 打線9人ぶんの分布（能力値そのまま） */
function lineupDistributions(batters: Array<{ average: number; power: number }>): PaDistribution[] {
  return batters.map((b) => distOf(b.power, b.average));
}

interface Roster {
  team: string;
  /** 打順9人（野手8＋投手1。DH制なし＝B-10） */
  lineup: Array<{ average: number; power: number; run: number }>;
  bench: Array<{ average: number; power: number; run: number }>;
}
const rosters: Roster[] = TEAMS.map((team) => ({
  team: team.name,
  lineup: [
    ...team.lineup.map((r) => fielderRowStats(r)),
    pitcherRowBatting(team.pitchers[0]),
  ],
  bench: team.bench.map((r) => benchRowStats(r)),
}));

// 元の打線の得点期待も球団×イニングでキャッシュする（`solveLineup` は9通りの先頭打者ぶん
// 1イニングを解くので、同じ打線を何度も解き直すと組み合わせの数だけ無駄になる）。
const baseRuns = new Map<string, number>();
function lineupRuns(dists: PaDistribution[], innings: number, key: string): number {
  const cached = baseRuns.get(key);
  if (cached !== undefined) return cached;
  const runs = solveLineup(dists, innings).runs;
  baseRuns.set(key, runs);
  return runs;
}

/** その打順を控えに差し替えたときの、残りNイニングの得点期待の減り（正＝損） */
function swapCost(r: Roster, slot: number, bench: Roster['bench'][number], innings: number): number {
  const before = lineupDistributions(r.lineup);
  const after = [...before];
  after[slot] = distOf(bench.power, bench.average);
  return (
    lineupRuns(before, innings, `${r.team}/${innings}`) -
    lineupRuns(
      after,
      innings,
      `${r.team}/${innings}/${slot}/${bench.power.toFixed(2)}/${bench.average.toFixed(2)}`,
    )
  );
}

console.log('\n=== 10. 代走の本当の費用＝残りの試合、その打順の打力が入れ替わる ===');
console.log(`   利得（盗塁が1つ成立）＝ +${stealRunGain.toFixed(3)}点（得点期待。0死・一塁→二塁）`);
console.log('   ここでは「いちばん遅い走者を、控えの最速に代える」＝走力だけを見た打ち手を測る。');
console.log(`${'残りイニング'.padEnd(14)}${row(['費用(点)', '利得-費用', '出すべきか'], 13)}`);
const naiveCost = (innings: number): number => {
  const costs = rosters.map((r) => {
    const fastest = r.bench.reduce((a, b) => (b.run > a.run ? b : a));
    let slot = 0;
    for (const [i, b] of r.lineup.entries()) if (b.run < r.lineup[slot].run) slot = i;
    return swapCost(r, slot, fastest, innings);
  });
  return costs.reduce((a, b) => a + b, 0) / costs.length;
};
for (const innings of [9, 6, 4, 3, 2, 1]) {
  const mean = naiveCost(innings);
  console.log(
    `${String(innings).padEnd(14)}` +
      row(
        [
          mean.toFixed(3),
          (stealRunGain - mean).toFixed(3),
          stealRunGain - mean >= 0 ? 'ダス' : 'ダサナイ',
        ],
        13,
      ),
  );
}
console.log('   → **走力だけを見る規則は、9回でも損**（費用が利得を上回る）。');
console.log('     代走は「走力を買って打力を売る」手なので、規則は必ず両方を見る必要がある。');

// ---- 11. 打力の差としきい値（規則を1本の量で書けるか） ----
//
// 費用は結局「退く選手と入る選手の打力の差」で決まる。X-45が代打を **AV+HR の合計の差**
// 1本で書いたのとまったく同じ量で、**代走はその符号が逆**（打力を差し出す側）。
// ここで「差がどこまでなら利得（盗塁1つ）を下回るか」を出す＝これがしきい値になる。

console.log('\n=== 11. 打力の差（AV+HR の合計）と費用の関係 ===');
console.log('   16球団 × 打順9 × 控え3 のうち、**盗塁の帯をまたぐ**組み合わせだけを数える。');
console.log('   イニングの条件が要るかもここで決まる（残り9＝1回に出しても損でないなら要らない）。');
console.log(
  `${'打力の差'.padEnd(12)}${row(['組', '費用(残9)', '費用(残6)', '費用(残3)', '費用(残1)'], 12)}`,
);
interface Combo {
  batGap: number;
  cost9: number;
  cost6: number;
  cost3: number;
  cost1: number;
}
const combos: Combo[] = [];
for (const r of rosters) {
  for (const [slot, out] of r.lineup.entries()) {
    for (const bench of r.bench) {
      // 盗塁の帯をまたがないなら、そもそも代走の利得が無い
      if (canSteal(out.run) || !canSteal(bench.run)) continue;
      combos.push({
        batGap: out.average + out.power - (bench.average + bench.power),
        cost9: swapCost(r, slot, bench, 9),
        cost6: swapCost(r, slot, bench, 6),
        cost3: swapCost(r, slot, bench, 3),
        cost1: swapCost(r, slot, bench, 1),
      });
    }
  }
}
const GAPS: Array<[string, number, number]> = [
  ['〜0.00（上回る）', -Infinity, 0],
  ['0.00〜0.20', 0, 0.2],
  ['0.20〜0.40', 0.2, 0.4],
  ['0.40〜0.60', 0.4, 0.6],
  ['0.60〜', 0.6, Infinity],
];
for (const [label, lo, hi] of GAPS) {
  const band = combos.filter((c) => c.batGap >= lo && c.batGap < hi);
  if (band.length === 0) continue;
  const mean = (f: (c: Combo) => number): string =>
    (band.reduce((a, c) => a + f(c), 0) / band.length).toFixed(3);
  console.log(
    `${label.padEnd(12)}` +
      row(
        [
          String(band.length),
          mean((c) => c.cost9),
          mean((c) => c.cost6),
          mean((c) => c.cost3),
          mean((c) => c.cost1),
        ],
        12,
      ),
  );
}
console.log(`   利得 +${stealRunGain.toFixed(3)}点 を下回る（＝出して得な）帯が、代走を出す条件。`);

console.log('\n=== 12. しきい値：打力の差をどこまで許すか（帯をまたぐ組だけ） ===');
console.log('   「得だった」＝残り9イニング（＝1回に出す最悪の場合）でも費用が利得を下回る。');
console.log(
  `${'しきい値'.padEnd(12)}${row(['成立する組', '球団', '得(残9)', '得(残3)'], 13)}`,
);
for (const limit of [0, 0.1, 0.2, 0.25, 0.3, 0.4, 0.6]) {
  const teams = new Set<string>();
  let fired = 0;
  let good9 = 0;
  let good3 = 0;
  for (const r of rosters) {
    for (const [slot, out] of r.lineup.entries()) {
      for (const bench of r.bench) {
        if (canSteal(out.run) || !canSteal(bench.run)) continue;
        if (out.average + out.power - (bench.average + bench.power) > limit) continue;
        fired += 1;
        teams.add(r.team);
        if (swapCost(r, slot, bench, 9) <= stealRunGain) good9 += 1;
        if (swapCost(r, slot, bench, 3) <= stealRunGain) good3 += 1;
      }
    }
  }
  console.log(
    `${limit.toFixed(2).padEnd(12)}` +
      row(
        [
          String(fired),
          `${teams.size}/16`,
          fired === 0 ? '-' : pct(good9 / fired),
          fired === 0 ? '-' : pct(good3 / fired),
        ],
        13,
      ),
  );
}

// ---- 13. 採った規則の確認 ----
//
// **0.10 を採る**：**どのイニングで出しても 100% 損しない**唯一の候補（0.20 は残り9で
// 96.6%＝1回に出すと損をする組が2つある）。おかげで**イニングの条件が要らない**＝
// X-45が「イニングのしきい値は置かない」としたのと同じ形に収まる（そこも計測が決めた）。
//
// **帯をまたぐ判定は R-39 の `CPU_STEAL_MAX_DEFENSE_SLACK_SEC` をそのまま使う**ので、
// 代走のために新しく作った自由変数は `CPU_PINCH_RUN_BAT_LOSS`（0.10）の1つだけ。

const BAT_LOSS = 0.1;
console.log('\n=== 13. 採った規則（帯をまたぐ＋打力を 0.10 以上落とさない）の確認 ===');
console.log('   (a) 帯をまたぐのは一塁の走者だけか（＝規則が塁を選ばずに書けるか）');
for (const from of ['first', 'second'] as const) {
  const best = cpuStealDefenseSlack(from, { speedOf: () => runnerSpeed(1) });
  console.log(
    `      ${from === 'first' ? '一塁→二塁' : '二塁→三塁'}：走力1.0でも余裕 ${best.toFixed(2)}秒` +
      ` ${best <= CPU_STEAL_MAX_DEFENSE_SLACK_SEC ? '（またぐ）' : '（どの走力でもまたがない）'}`,
  );
}
console.log('   (b) 球団ごとに何組成立するか（0＝その球団は代走を出さない）');
console.log(`${'球団'.padEnd(14)}${row(['成立する組', '最大の走力差'], 14)}`);
for (const r of rosters) {
  let fired = 0;
  let maxRunGain = 0;
  for (const out of r.lineup) {
    for (const bench of r.bench) {
      if (canSteal(out.run) || !canSteal(bench.run)) continue;
      if (out.average + out.power - (bench.average + bench.power) > BAT_LOSS) continue;
      fired += 1;
      maxRunGain = Math.max(maxRunGain, bench.run - out.run);
    }
  }
  console.log(
    `${r.team.padEnd(14)}` + row([String(fired), maxRunGain.toFixed(2)], 14),
  );
}
