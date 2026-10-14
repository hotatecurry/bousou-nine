/**
 * CPUの攻撃の采配の計測（フェーズX-45）。
 *
 *   npm run balance:offense
 *
 * J-30（守備・継投）→R-39/S-40（配球・走塁）→T-41（コース）と埋めてきた
 * 「CPUだけが持っていない判断」のうち、**攻撃側だけがまるごと空いていた**：
 * CPU打者は一度もバントせず（`cpuBatter.ts` にバントの経路が1本も無い）、
 * CPUは代打を出さない（`SUBSTITUTE_BATTER` は人間の采配メニューからしか来ない）。
 *
 * CLAUDE.md「バランス調整の方針＝勘で動かさず必ず計測してから決める」に従って、
 * **CPUがいつバントし、いつ代打を出し、いつ余分な塁を狙うか**をここで決める。
 *
 * ## この計測が出した結論（1〜6段目は「入れなかった理由」の記録）
 *
 * **送りバントとスクイズはこの守備モデルでは一度も成立しない**（2・6段目）ので入れていない。
 * 理由は J-30 が測った構造そのもの＝**送球（34m/s）は走者の4.5倍速い**。バントは
 * **打球を本塁のすぐ近くに置く手**なので送球距離が最短になり、この構造がいちばん極端に
 * 出る（投手が本塁から約11mの地点で1秒前後に確保し、そこからどの塁へも0.8秒で届く。
 * 走者の塁間は3.3〜4.0秒）。得点確率で見ても全塁状況・全アウト・全打者で負ける（4段目）。
 * 成立させるには `THROW_SPEED` を 8.2〜10.7m/s（今の1/3）にするしかなく、それは
 * 内野ゴロ・犠飛・盗塁・けん制の境界を全部壊す（J-30が測って据え置きと決めた通り）。
 * **I-29の `TIMING_SWEET_BAND`、O-35の「F＝緩急の幅」、R-39の打順、S-40の配球の費用、
 * W-44のCPU限定の疲労に続く6件目の「計測が設計を否定した」記録**として残す。
 *
 * 入れたのは計測が支持した2つ＝**代打**（7・8段目）と**打球での余分な進塁**（9〜11段目）。
 * 後者が生きているのは、**外野へ抜けた打球なら送球距離が長い**からで、バントとちょうど
 * 裏返しの理由になっている（S-40のタッチアップが「深いフライなら還れる」のと同じ形）。
 *
 * **15段目は表示のほう**（フェーズEE-52。DD-51が投手側でやった7段目の打者側）＝
 * 采配メニューの代打に**走力の列**を足す根拠。**16/16球団で「打つ力で最良の控え」と
 * 「走力で最良の控え」が別人**（足で選べば塁間で最大0.46秒）なので、この列は
 * **CPUが見ていない材料を人間に渡す**ことになる（CPUの代打は AV+HR だけを見る）。
 *
 * ## 尺度が敬遠（Q-38）と違う理由＝得点確率
 *
 * Q-38は**得点期待**（平均何点入るか）で決めたが、**送りバントはその尺度ではほぼ常に損**
 * になる（アウトを1つ差し出して塁を1つ進める手なので、平均点は必ず下がる方向に働く）。
 * 送りバントが実際に使われるのは「**1点あればいい**」場面で、そこで正しい尺度は
 * **1点以上入る確率**のほう（`runExpectancy.ts` の `solveScoreProbability`）。
 * 2026-08-09 のユーザー判断もこちら。
 *
 * ## 何を再利用しているか
 *
 * - **バントの打球は `judgeBunt`、その後の守備は `simulatePlay`** ＝I-29以来の土台を
 *   そのまま呼ぶ。バントの弱いゴロを誰がどこで拾うかは、打球物理と野手の動きが決める
 *   ものであって、ここに書き写す値ではない。
 * - **送球と走者の時間競争は `sim.ts` の `throwOut` と同じ式**（送球＝距離÷THROW_SPEED、
 *   走者＝距離÷走力、同着は走者有利）。`retires()` がその写しで、**打者走者については
 *   `simulatePlay` 自身の判定と一致することを1段目で突き合わせる**。
 *
 * ## 意図的な単純化（絶対値ではなく比較に使う）
 *
 * - **守備は「最善の対応をする」ものとして測る**（もっとも進んだ走者から順に、刺せる
 *   走者を刺す）。実機のCPU守備は「もっとも進んだ走者の塁へ1投目」なので同じだが、
 *   **CPUがバッターのときの守備は人間**なので、そちらに合わせて**攻撃側に不利な側**
 *   （＝守備が最善を打つ）で見積もる。ここで「バントが得」と出る場面は実際にはもっと得。
 * - **塁上の走者は塁に着いた状態からスタート**（リード0）。L-32の持ち越したリードは
 *   攻撃側に有利な方向にしか働かないので、これも安全側の見積もり。
 * - 打席の帰結の分布は `sweep` 由来＝**分母はフェアの打球**（三振・四球・ファウルを
 *   数えない）。walk.ts と同じ約束で、絶対値ではなく比較に使う。
 */
import { type BaseKey, type FielderId, type Vec2 } from '../../src/core/fielding';
import {
  BASE_ARRIVE_RADIUS,
  BASE_POSITIONS,
  CONTROLLABLE_FIELDERS,
  CPU_TAG_UP_MARGIN_SEC,
  FIELDER_HOME_POSITIONS,
  FIELDER_SPEED,
  RUNNER_SPEED,
  STEAL_LEAD,
  THROW_SPEED,
  advancedBase,
  cpuExtraBaseSlack,
  distance,
  nearestFielder,
  predictLandingAt,
  runnerSpeed,
} from '../../src/core/fielding';
import {
  BAT_REACH_INSIDE_X,
  BAT_REACH_OUTSIDE_X,
  createBattedBall,
  judgeBunt,
  judgeSwing,
} from '../../src/core/batting';
import { SPEED_NEUTRAL } from '../../src/core/pitch';
import { RATING_TICKS, maxPitchesFor, ratingBar } from '../../src/core/roster';
import {
  TEAMS,
  benchRowStats,
  fielderRowStats,
  pitcherRowBatting,
  pitcherRowPitching,
} from '../../src/core/teams';
import { PICKUP_THROW_DELAY_SEC, simulatePlay } from './sim';
import {
  type PaDistribution,
  type RunExpectancy,
  type ScoreProbability,
  BASE_STATE_COUNT,
  baseStateLabel,
  battleValue,
  distributionFor,
  paScoreProb,
  solveInning,
  solveRunExpectancy,
  solveScoreProbability,
} from './runExpectancy';
import { crossXFor, pct, sweep, swingTimeFor } from './sweep';

const row = (cells: readonly string[], width = 10): string =>
  cells.map((c) => c.padStart(width)).join('');

const AIMS = [-1, 0, 1] as const;
const AIM_LABEL: Record<number, string> = { [-1]: '三塁側', 0: '正面', 1: '一塁側' };

// ---- バントの打球と、そこから組み立てる送球の時間競争 ----

interface FieldedBunt {
  by: string;
  sec: number;
  pos: Vec2;
  /** `simulatePlay` 自身の判定（打者走者を一塁で刺せたか）。1段目の突き合わせに使う */
  simGroundout: boolean;
  /** 打ち上がって直接捕られた（バントの小フライ）＝打者アウト・走者は動かない */
  popOut: boolean;
  /** ファウル（カウントが進むだけ） */
  foul: boolean;
}

/** その狙い・そのコースのバントを実際に転がして、誰がいつどこで拾うかを得る */
function fieldBunt(aim: -1 | 0 | 1, crossX: number): FieldedBunt | null {
  const launch = judgeBunt(crossX, aim);
  if (launch === null) return null;
  const result = simulatePlay(launch, crossX);
  const kind = result.outcome.kind;
  if (kind === 'flyout') {
    return { by: result.outcome.by, sec: result.seconds, pos: { x: 0, z: 0 }, simGroundout: false, popOut: true, foul: false };
  }
  if (kind === 'foul') {
    return { by: '-', sec: result.seconds, pos: { x: 0, z: 0 }, simGroundout: false, popOut: false, foul: true };
  }
  if (result.fielded === undefined) {
    // 誰も拾えなかった（バントでは起きないはずだが、起きたら安打として扱う）
    return null;
  }
  return {
    by: result.fielded.by,
    sec: result.fielded.sec,
    pos: result.fielded.pos,
    simGroundout: kind === 'groundout',
    popOut: false,
    foul: false,
  };
}

interface Leg {
  from: BaseKey;
  to: BaseKey;
}

/**
 * その走者をその塁への送球1本で刺せるか。**`sim.ts` の `throwOut` と同じ式**
 * （リリース＝確保＋持ち替え（BBB-82）、同着は走者有利、走者は既に着いていたら刺せない）。
 */
function retires(f: FieldedBunt, leg: Leg, speed: number, covered = 0): boolean {
  const path = distance(BASE_POSITIONS[leg.from], BASE_POSITIONS[leg.to]) - covered;
  const release = f.sec + PICKUP_THROW_DELAY_SEC;
  if (release >= (path - BASE_ARRIVE_RADIUS) / speed) return false;
  return release + distance(f.pos, BASE_POSITIONS[leg.to]) / THROW_SPEED < path / speed;
}

/** 打球でフォースされる走者（打者走者を含む）。**もっとも進んだ走者が先頭** */
function forcedLegs(state: number): Leg[] {
  const legs: Leg[] = [];
  if (state & 1) {
    if (state & 2) {
      if (state & 4) legs.push({ from: 'third', to: 'home' });
      legs.push({ from: 'second', to: 'third' });
    }
    legs.push({ from: 'first', to: 'second' });
  }
  legs.push({ from: 'home', to: 'first' });
  return legs;
}

const BASE_BIT: Partial<Record<BaseKey, number>> = { first: 1, second: 2, third: 4 };

interface BuntResult {
  /** 刺された走者（null＝全員セーフ） */
  retired: Leg | null;
  outs: number;
  runs: number;
  state: number;
  label: string;
}

/** 最善の守備（もっとも進んだ走者から順に刺せる走者を刺す）に対するバントの帰結 */
function buntAgainstBestDefense(f: FieldedBunt, state: number, speed: number): BuntResult {
  if (f.popOut) {
    return { retired: null, outs: 1, runs: 0, state, label: '小フライ' };
  }
  const legs = forcedLegs(state);
  const retired = legs.find((leg) => retires(f, leg, speed)) ?? null;
  let bits = state;
  let runs = 0;
  for (const leg of legs) {
    if (leg.from !== 'home') bits &= ~(BASE_BIT[leg.from] ?? 0);
  }
  for (const leg of legs) {
    if (retired && leg.from === retired.from && leg.to === retired.to) continue;
    if (leg.to === 'home') runs += 1;
    else bits |= BASE_BIT[leg.to] ?? 0;
  }
  const label =
    retired === null
      ? '全員セーフ'
      : retired.from === 'home'
        ? '送りバント成功'
        : `${retired.to}でアウト`;
  return { retired, outs: retired === null ? 0 : 1, runs, state: bits, label };
}

// ---- 1. バントの打球そのもの ----

const CONTACT_XS = Array.from(
  { length: 8 },
  (_, i) => BAT_REACH_OUTSIDE_X + ((BAT_REACH_INSIDE_X - BAT_REACH_OUTSIDE_X) * i) / 7,
);

console.log('\n=== 1. バントの打球（judgeBunt → simulatePlay。ところざわ・CPU守備） ===');
console.log('   狙い（十字キー左右）ごとに、誰がいつどこで拾い、一塁で刺せるかを出す。');
console.log('   「刺せる」欄は左＝この計測の式／右＝simulatePlay 自身の判定（一致すべき）。');
console.log(
  `${'狙い'.padEnd(8)}${'コース'.padEnd(8)}${row(['拾う野手', '確保s', '本塁から', '一塁で刺せる'], 12)}`,
);
for (const aim of AIMS) {
  for (const crossX of CONTACT_XS) {
    const f = fieldBunt(aim, crossX);
    if (f === null) {
      console.log(`${AIM_LABEL[aim].padEnd(8)}${crossX.toFixed(2).padEnd(8)}${row(['（届かない）'], 12)}`);
      continue;
    }
    if (f.foul || f.popOut) {
      console.log(
        `${AIM_LABEL[aim].padEnd(8)}${crossX.toFixed(2).padEnd(8)}` +
          row([f.foul ? 'ファウル' : `小フライ(${f.by})`, f.sec.toFixed(2), '-', '-'], 12),
      );
      continue;
    }
    const mine = retires(f, { from: 'home', to: 'first' }, RUNNER_SPEED);
    console.log(
      `${AIM_LABEL[aim].padEnd(8)}${crossX.toFixed(2).padEnd(8)}` +
        row(
          [
            f.by,
            f.sec.toFixed(2),
            Math.hypot(f.pos.x, f.pos.z).toFixed(1),
            `${mine ? 'アウト' : 'セーフ'}/${f.simGroundout ? 'アウト' : 'セーフ'}`,
          ],
          12,
        ),
    );
  }
}

// ---- 2. 送りバントの帰結（塁状況別・最善の守備） ----
//
// **バントの打球は打者の能力でもコースでも変わらない**（`judgeBunt` は狙いだけで決まる）
// ので、帰結は狙い3方向ぶんしかない＝決定的。だから「送れるかどうか」は確率ではなく、
// **その塁状況で通る狙いがあるかどうか**の問題になる。

/** 走者を置ける塁状況のうち、一塁が埋まっているもの（＝フォースで走者が自動的に走る） */
const FORCED_STATES = [1, 3, 5, 7];

interface AimOutcome {
  aim: -1 | 0 | 1;
  result: BuntResult;
}

/** その塁状況で、狙いごとの帰結（コースは代表値＝ど真ん中） */
function outcomesFor(state: number, speed = RUNNER_SPEED): AimOutcome[] {
  return AIMS.map((aim) => {
    const f = fieldBunt(aim, 0);
    if (f === null) throw new Error('ど真ん中のバントが届かない');
    return { aim, result: buntAgainstBestDefense(f, state, speed) };
  });
}

console.log('\n=== 2. 送りバントの帰結（最善の守備に対して。走者は塁上からスタート） ===');
console.log('   一塁に走者がいる＝打球でフォースされるので、走者は操作なしで走る。');
console.log('   （一塁が空いている塁状況では、CPUの走者は打球で動かない＝送れない）');
console.log(`${'塁状況'.padEnd(14)}${row(AIMS.map((a) => AIM_LABEL[a]), 16)}`);
for (const state of FORCED_STATES) {
  console.log(
    `${baseStateLabel(state).padEnd(14)}` +
      row(
        outcomesFor(state).map((o) => o.result.label),
        16,
      ),
  );
}

console.log('\n   走力別（一塁に走者。狙いは正面）：');
console.log(`${'走力'.padEnd(10)}${row(['一塁の走者', '打者走者', '帰結'], 16)}`);
for (const run of [0, 0.5, 1]) {
  const speed = 6.8 + 1.4 * run;
  const f = fieldBunt(0, 0)!;
  const lead = retires(f, { from: 'first', to: 'second' }, speed);
  const batter = retires(f, { from: 'home', to: 'first' }, speed);
  console.log(
    `${run.toFixed(1).padEnd(10)}` +
      row(
        [lead ? 'アウト' : 'セーフ', batter ? 'アウト' : 'セーフ', buntAgainstBestDefense(f, 1, speed).label],
        16,
      ),
  );
}

// ---- 3. バント vs 打たせる（得点確率） ----

const POWERS = [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9] as const;
const dists = new Map<number, PaDistribution>();
function distOf(power: number, average = 0.5): PaDistribution {
  const key = Math.round(power * 100) / 100 + Math.round(average * 100) / 100 / 1000;
  const cached = dists.get(key);
  if (cached) return cached;
  const dist = distributionFor(Math.round(power * 100) / 100, { average });
  dists.set(key, dist);
  return dist;
}

const AVERAGE_POWER = 0.5;
const scoreTable: ScoreProbability = solveScoreProbability(distOf(AVERAGE_POWER));
const runTable: RunExpectancy = solveRunExpectancy(distOf(AVERAGE_POWER));

console.log('\n=== 3. 得点確率（1点以上入る確率。平均打者だけが並ぶ打線） ===');
console.log('   送りバントを測れる唯一の尺度。得点期待（平均点）は同じ表の右側に併記する。');
console.log(`${'塁状況'.padEnd(14)}${row(['0死', '1死', '2死'], 9)}${'  |'}${row(['0死', '1死', '2死'], 9)}`);
for (let state = 0; state < BASE_STATE_COUNT; state += 1) {
  console.log(
    `${baseStateLabel(state).padEnd(14)}` +
      row([0, 1, 2].map((o) => pct(scoreTable[o][state])), 9) +
      '  |' +
      row([0, 1, 2].map((o) => runTable[o][state].toFixed(2)), 9),
  );
}

/** バントしたときの得点確率（帰結は決定的なので、狙いのうち攻撃側に最良のものを採る） */
function buntScoreProb(state: number, outs: number, speed = RUNNER_SPEED): number {
  let best = 0;
  for (const { result } of outcomesFor(state, speed)) {
    const after = outs + result.outs;
    const value = result.runs > 0 ? 1 : after >= 3 ? 0 : scoreTable[after][result.state];
    if (value > best) best = value;
  }
  return best;
}

console.log('\n=== 4. バント vs 打たせる（正＝バントしたほうが1点入りやすい） ===');
console.log('   値は「バントの得点確率 − その打者に打たせたときの得点確率」。');
console.log('   バントの打球は打者の能力で変わらないので、動くのは「打たせたとき」の側だけ。');
console.log(`${'塁状況'.padEnd(12)}${'アウト'.padEnd(6)}${row(POWERS.map((p) => `力${p}`), 8)}`);
for (const state of FORCED_STATES) {
  for (const outs of [0, 1, 2]) {
    const bunt = buntScoreProb(state, outs);
    const cells = POWERS.map((power) => {
      const swing = paScoreProb(distOf(power), outs, state, scoreTable);
      const diff = bunt - swing;
      return `${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(1)}`;
    });
    console.log(`${baseStateLabel(state).padEnd(12)}${String(outs).padEnd(6)}${row(cells, 8)}`);
  }
}

// ---- 5. しきい値（CPUの規則を決める） ----

/** バントが得でいられる打者の長打力の上限（0.05刻み。得にならなければ null） */
function powerLimit(state: number, outs: number): number | null {
  const bunt = buntScoreProb(state, outs);
  let limit: number | null = null;
  for (let power = 0; power <= 1.0001; power += 0.05) {
    const p = Math.round(power * 100) / 100;
    if (bunt - paScoreProb(distOf(p), outs, state, scoreTable) >= 0) limit = p;
  }
  return limit;
}

console.log('\n=== 5. しきい値：どこまでの打者ならバントさせるか ===');
console.log('   値は「この長打力以下ならバントのほうが得」。「-」＝どんな打者でも打たせたほうが得。');
console.log(`${'塁状況'.padEnd(14)}${row(['0死', '1死', '2死'], 10)}`);
for (const state of FORCED_STATES) {
  console.log(
    `${baseStateLabel(state).padEnd(14)}` +
      row(
        [0, 1, 2].map((outs) => {
          const t = powerLimit(state, outs);
          return t === null ? '-' : t.toFixed(2);
        }),
        10,
      ),
  );
}

// ---- 6. スクイズ（三塁走者が投球と同時にスタートし、その球をバントする） ----
//
// 三塁走者は打球でフォースされない（一・二塁が埋まっていない限り）ので、**走らせるのは
// 盗塁の操作**（L-32：本塁は塁を指定したときだけ走れる）。仕掛けた球を打つのは
// H-28（ヒットエンドラン）の引き継ぎがそのまま使える＝**新しい仕組みは要らない**。
//
// 走者は接触の時点で「リード＋スタートしてからの距離」だけ進んでいる。その頭の分
// （headStart）が長いほど還りやすいが、**バントを外したら走者は死ぬ**のがこの手の代償。

const SQUEEZE_HEAD_STARTS = [0.2, 0.35, 0.5] as const;

console.log('\n=== 6. スクイズ（三塁走者が還れるか。最善の守備＝本塁へ送球） ===');
console.log(`   走者は接触時点でリード ${STEAL_LEAD}m ＋ スタートからの距離だけ進んでいる。`);
console.log('   headStart＝仕掛けてから接触までの秒数（投球の飛行時間ぶん）。');
console.log(`${'headStart'.padEnd(12)}${'走力'.padEnd(8)}${row(AIMS.map((a) => AIM_LABEL[a]), 12)}`);
for (const head of SQUEEZE_HEAD_STARTS) {
  for (const run of [0, 0.5, 1]) {
    const speed = 6.8 + 1.4 * run;
    const covered = STEAL_LEAD + speed * head;
    const cells = AIMS.map((aim) => {
      const f = fieldBunt(aim, 0)!;
      const out = retires(f, { from: 'third', to: 'home' }, speed, covered);
      return out ? 'アウト' : 'ホームイン';
    });
    console.log(`${head.toFixed(2).padEnd(12)}${run.toFixed(1).padEnd(8)}${row(cells, 12)}`);
  }
}

console.log('\n   スクイズの損得（走者三塁。正＝仕掛けたほうが1点入りやすい）：');
console.log(`${'headStart'.padEnd(12)}${'アウト'.padEnd(8)}${row(POWERS.map((p) => `力${p}`), 8)}`);
for (const head of SQUEEZE_HEAD_STARTS) {
  for (const outs of [0, 1, 2]) {
    // 最善の狙いを採る（守備は最善、攻撃も最善）
    const speed = RUNNER_SPEED;
    const covered = STEAL_LEAD + speed * head;
    const scores = AIMS.some((aim) => !retires(fieldBunt(aim, 0)!, { from: 'third', to: 'home' }, speed, covered));
    // 還れなければ三塁走者はアウト・打者は一塁（守備の送球を1本使わせている）
    const value = scores ? 1 : outs + 1 >= 3 ? 0 : scoreTable[outs + 1][1];
    const cells = POWERS.map((power) => {
      const diff = value - paScoreProb(distOf(power), outs, 4, scoreTable);
      return `${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(1)}`;
    });
    console.log(`${head.toFixed(2).padEnd(12)}${String(outs).padEnd(8)}${row(cells, 8)}`);
  }
}

// ---- 7. 規則が実際に発火するか（名鑑16球団の打線で数える） ----
//
// しきい値を厳しくすれば「損なバント」は無くなるが、**一度も発火しない規則は死んだコード**
// （P-37で「名鑑96人のうち何人が頭打ちになるか」で倒す長さを決めたのと同じ見方）。

const lineupPowers = TEAMS.map((team) => [
  ...team.lineup.map((r) => fielderRowStats(r).power),
  pitcherRowBatting(team.pitchers[0]).power,
]);

console.log('\n=== 7. 規則が発火するか（名鑑16球団×9打順＝144通り） ===');
console.log('   「この長打力以下ならバント」としたとき、何打順が該当するか。');
console.log(`${'しきい値'.padEnd(12)}${row(['該当する打順', '球団数', '打線の中の位置'], 16)}`);
for (const threshold of [0.15, 0.2, 0.25, 0.3, 0.4]) {
  let slots = 0;
  const teams = new Set<number>();
  const positions: number[] = [];
  lineupPowers.forEach((powers, teamIndex) => {
    powers.forEach((power, i) => {
      if (power <= threshold) {
        slots += 1;
        teams.add(teamIndex);
        positions.push(i + 1);
      }
    });
  });
  const spread =
    positions.length === 0
      ? '-'
      : `${Math.min(...positions)}〜${Math.max(...positions)}番`;
  console.log(
    `${threshold.toFixed(2).padEnd(12)}` + row([`${slots}`, `${teams.size}/16`, spread], 16),
  );
}

// ---- 8. 代打（投手の打席。B-10で自動継投になる＝先発を降ろす代償が付いている） ----

const pinchGains = TEAMS.map((team) => {
  const pitcher = pitcherRowBatting(team.pitchers[0]);
  const bench = team.bench.map(benchRowStats);
  const best = bench.reduce((a, b) => (b.power + b.average > a.power + a.average ? b : a));
  return { team: team.short, pitcher, best };
});

console.log('\n=== 8. 代打の利得（名鑑16球団：先発投手の打撃 vs いちばん強い控え） ===');
console.log('   差＝（控えのAV＋HR）−（投手のAV＋HR）。R-39のローテーションで相手の');
console.log('   先発が替わると投手の打撃も替わるので、先発型4人ぶん並べる。');
console.log(
  `${'球団'.padEnd(8)}${row(['控えAV', '控えHR'], 9)}  ${row(['先発1', '先発2', '先発3', '先発4'], 8)}`,
);
const gapRows = TEAMS.map((team) => {
  const bench = team.bench.map(benchRowStats);
  const best = bench.reduce((a, b) => (b.power + b.average > a.power + a.average ? b : a));
  return {
    short: team.short,
    best,
    gaps: team.pitchers.slice(0, 4).map((p) => {
      const bat = pitcherRowBatting(p);
      return best.average + best.power - (bat.average + bat.power);
    }),
  };
});
for (const g of gapRows) {
  console.log(
    `${g.short.padEnd(8)}` +
      row([g.best.average.toFixed(2), g.best.power.toFixed(2)], 9) +
      '  ' +
      row(
        g.gaps.map((v) => v.toFixed(2)),
        8,
      ),
  );
}
const allGaps = gapRows.flatMap((g) => g.gaps).sort((a, b) => a - b);
console.log(
  `   差の分布（16球団×先発型4人＝64通り）：最小 ${allGaps[0].toFixed(2)} / ` +
    `中央 ${allGaps[Math.floor(allGaps.length / 2)].toFixed(2)} / ` +
    `最大 ${allGaps[allGaps.length - 1].toFixed(2)}`,
);
console.log('   しきい値ごとの発火（Q-38が敬遠の能力差を決めたのと同じ見方）：');
for (const threshold of [0.6, 0.7, 0.8, 0.9, 1.0]) {
  const teams = gapRows.filter((g) => g.gaps.some((v) => v >= threshold)).length;
  console.log(
    `     ${threshold.toFixed(2)} → 先発 ${allGaps.filter((v) => v >= threshold).length}/64・` +
      `球団 ${teams}/16`,
  );
}

const avgPitcher = {
  average: pinchGains.reduce((s, g) => s + g.pitcher.average, 0) / pinchGains.length,
  power: pinchGains.reduce((s, g) => s + g.pitcher.power, 0) / pinchGains.length,
};
const avgBench = {
  average: pinchGains.reduce((s, g) => s + g.best.average, 0) / pinchGains.length,
  power: pinchGains.reduce((s, g) => s + g.best.power, 0) / pinchGains.length,
};
console.log(
  `${'（平均）'.padEnd(8)}` +
    row(
      [
        avgPitcher.average.toFixed(2),
        avgPitcher.power.toFixed(2),
        avgBench.average.toFixed(2),
        avgBench.power.toFixed(2),
      ],
      10,
    ),
);

const pitcherDist = distOf(avgPitcher.power, avgPitcher.average);
const benchDist = distOf(avgBench.power, avgBench.average);

console.log('\n   塁状況ごとの利得（左＝得点確率の差 pt／右＝得点期待の差 点）：');
console.log(`${'塁状況'.padEnd(14)}${row(['0死', '1死', '2死'], 9)}${'  |'}${row(['0死', '1死', '2死'], 9)}`);
for (let state = 0; state < BASE_STATE_COUNT; state += 1) {
  const probCells = [0, 1, 2].map((outs) => {
    const d =
      paScoreProb(benchDist, outs, state, scoreTable) -
      paScoreProb(pitcherDist, outs, state, scoreTable);
    return `+${(d * 100).toFixed(1)}`;
  });
  const runCells = [0, 1, 2].map((outs) => {
    const d =
      battleValue(benchDist, outs, state, runTable) -
      battleValue(pitcherDist, outs, state, runTable);
    return `+${d.toFixed(3)}`;
  });
  console.log(`${baseStateLabel(state).padEnd(14)}` + row(probCells, 9) + '  |' + row(runCells, 9));
}

// ---- 9. 代打の費用＝先発を降ろすと、残りをブルペンで投げ切れるか ----
//
// B-10で「投手の打席に代打を送ると自動で継投する」ので、代打の費用は**先発を失うこと**。
// この守備モデルで唯一きちんと数えられる費用は**球数**なので、そちらで測る：
// ブルペンが「球威を保ったまま」（残量が `STAMINA_FRESH_THRESHOLD` を割る前）投げられる
// 球数と、残りイニングに要る球数を比べて、**代打を出せる最も早い回**を出す。

const paPerInning = solveInning(new Array(9).fill(distOf(AVERAGE_POWER)), 0).pa.reduce(
  (a, b) => a + b,
  0,
);

console.log('\n=== 9. 代打の費用：先発を降ろした後、ブルペンで投げ切れるか ===');
console.log(`   1イニングの打席数は計測から ${paPerInning.toFixed(2)}（平均打者だけの打線）。`);
console.log('   1打席の球数は測る土台が無いので仮定を振る（感度分析）。');
console.log('   ブルペンの容量＝5人ぶんの「球威を保ったまま投げられる球数」（限界の半分）。');
console.log(`${'球/打席'.padEnd(10)}${row(['要る球数/回', 'ブルペン容量', '投げ切れる最速の回'], 18)}`);
const bullpenCapacity =
  TEAMS.reduce((sum, team) => {
    const arms = team.pitchers.slice(1).map((p) => maxPitchesFor(pitcherRowPitching(p).stamina));
    return sum + arms.reduce((a, b) => a + b, 0) * 0.5;
  }, 0) / TEAMS.length;
for (const perPa of [3.5, 4, 4.5]) {
  const perInning = paPerInning * perPa;
  let earliest: number | null = null;
  for (let inning = 1; inning <= 9; inning += 1) {
    const remaining = 9 - inning + 1;
    if (remaining * perInning <= bullpenCapacity) {
      earliest = inning;
      break;
    }
  }
  console.log(
    `${perPa.toFixed(1).padEnd(10)}` +
      row(
        [perInning.toFixed(0), bullpenCapacity.toFixed(0), earliest === null ? '-' : `${earliest}回`],
        18,
      ),
  );
}


// ---- 10. 打球で余分な塁を取れるか（S-40のタッチアップと同じ「時間の比較」） ----
//
// CPU攻撃が打球中に仕掛けるのは**フライのタッチアップだけ**（`chooseCpuTagUp`）で、
// **`sendRunner` は人間の攻撃側しか使わない**。バントと違ってここに帯があるのは、
// **外野へ抜けた打球は送球距離が長い**から＝深いフライならタッチアップで還れるのと
// まったく同じ理由（バントとちょうど裏返し）。
//
// **仕掛けるかどうかは打球の瞬間に決まる**（守備が確保してからでは、走者はそこから
// 塁間 3.3〜4.0秒を走ることになってどんな送球にも勝てない）。したがって規則が使えるのは
// **着地点の予測**（`predictLandingAt`＝CPU守備が追いかける先とまったく同じ情報）だけで、
// 転がって伸びるぶんを見込まないぶん**必ず短めに出る＝走者に厳しい側**の見積もりになる。
// ここでは「予測で決めた判断が、実際の守備に対してどうなったか」まで突き合わせる。

const NEUTRAL = { power: AVERAGE_POWER, average: 0.5 };
const controllableHome = Object.fromEntries(
  CONTROLLABLE_FIELDERS.map((id) => [id, FIELDER_HOME_POSITIONS[id]]),
) as Record<FielderId, Vec2>;

interface HitCase {
  /** 打球発生から守備が確保するまでの**見込み**（規則が使う値） */
  predicted: { point: Vec2; sec: number };
  /** 実際に確保した時刻と位置（`simulatePlay`。誰も拾わなかったら undefined） */
  actual?: { sec: number; pos: Vec2 };
  finalDistance: number;
}

// **守備は「CPU走者が人間の守備に見込む動き」で回す**（フェーズBBB-83）：この規則が実機で使われるのは
// CPUが攻撃＝人間が守るときだけで、CPU走者の見込みはその守備を「いちばん近い野手を球へ向ける・
// 反応0」として写している（`predictSecureAt` の `'follow'`）。CPU守備（先回り）を相手に測ると、
// 画面では起きない組み合わせを数えることになる。
const hitCases: HitCase[] = [];
for (const s of sweep({ batter: NEUTRAL, chase: 'follow', reactionSec: 0 })) {
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
  hitCases.push({
    predicted: { point: landing.point, sec: Math.max(landing.sec, chaseSec) },
    actual: s.result.fielded,
    finalDistance: s.result.finalDistance,
  });
}

/** 実際の守備に対する余裕（規則ではなく「本当のところ」）。拾われなければ必ず安全 */
function actualSlack(c: HitCase, from: 'first' | 'second' | 'third', speed: number): number {
  const to = BASE_POSITIONS[advancedBase(from)];
  const runSec = distance(BASE_POSITIONS[from], to) / speed;
  if (c.actual === undefined) return Number.NEGATIVE_INFINITY;
  // 拾ってから持ち替え（BBB-82）を待って投げる＝`sim.ts` の throwOut・`tests/balance.test.ts` と同じ式
  return runSec - (c.actual.sec + PICKUP_THROW_DELAY_SEC + distance(c.actual.pos, to) / THROW_SPEED);
}

/** 規則（`cpuExtraBaseSlack`）が見る余裕＝着地点の予測から出す見込み */
function ruleSlack(c: HitCase, from: 'first' | 'second' | 'third', speed: number): number {
  return cpuExtraBaseSlack({
    from,
    speed,
    securePoint: c.predicted.point,
    secureSec: c.predicted.sec,
  });
}

console.log('\n=== 10. 見込みと実際のズレ（規則は着地点の予測しか使えない） ===');
console.log(`   分母は平均打者の安打 ${hitCases.length} 本（sweep の格子から）。`);
console.log('   正＝見込みのほうが守備に厳しい（＝規則は走者に慎重）。');
const diffs = hitCases
  .filter((c) => c.actual !== undefined)
  .map((c) => ruleSlack(c, 'second', RUNNER_SPEED) - actualSlack(c, 'second', RUNNER_SPEED))
  .sort((a, b) => a - b);
console.log(
  `${'最小'.padEnd(8)}${diffs[0].toFixed(2).padEnd(8)}` +
    `${'中央'.padEnd(8)}${diffs[Math.floor(diffs.length / 2)].toFixed(2).padEnd(8)}` +
    `${'最大'.padEnd(8)}${diffs[diffs.length - 1].toFixed(2)}`,
);
console.log(
  `   見込みのほうが慎重だった割合：${pct(diffs.filter((d) => d >= 0).length / diffs.length)}`,
);

// ---- 11. 規則が「行く」と言う割合と、そのうち実際に刺される割合 ----

const FROMS: Array<'first' | 'second' | 'third'> = ['first', 'second', 'third'];
const FROM_LABEL: Record<string, string> = {
  first: '一塁→二塁',
  second: '二塁→三塁',
  third: '三塁→本塁',
};

console.log('\n=== 11. 規則が仕掛ける割合（margin は CPU_TAG_UP_MARGIN_SEC＝0.14） ===');
console.log('   「刺される」＝規則が行かせたのに、実際の守備には間に合わなかった打球。');
console.log(
  `${'走力'.padEnd(8)}${row(
    FROMS.map((f) => FROM_LABEL[f]),
    13,
  )}  ${'刺される'.padEnd(10)}`,
);
for (const run of [0, 0.5, 1]) {
  const speed = 6.8 + 1.4 * run;
  const cells = FROMS.map((from) =>
    pct(
      hitCases.filter((c) => ruleSlack(c, from, speed) <= -CPU_TAG_UP_MARGIN_SEC).length /
        hitCases.length,
    ),
  );
  const going = hitCases.filter((c) => ruleSlack(c, 'second', speed) <= -CPU_TAG_UP_MARGIN_SEC);
  const caught = going.filter((c) => actualSlack(c, 'second', speed) >= 0);
  console.log(
    `${run.toFixed(1).padEnd(8)}` +
      row(cells, 13) +
      '  ' +
      `${going.length === 0 ? '-' : pct(caught.length / going.length)}`,
  );
}

console.log('\n   打球の深さ別（二塁→三塁・基準速）：');
console.log(`${'ボールの距離'.padEnd(14)}${row(['本数', '仕掛ける'], 10)}`);
const DEPTH_BANDS: Array<[string, number, number]> = [
  ['〜40m', 0, 40],
  ['40〜60m', 40, 60],
  ['60〜80m', 60, 80],
  ['80〜100m', 80, 100],
  ['100m〜', 100, Infinity],
];
for (const [label, lo, hi] of DEPTH_BANDS) {
  const band = hitCases.filter((c) => c.finalDistance >= lo && c.finalDistance < hi);
  if (band.length === 0) continue;
  const go = band.filter((c) => ruleSlack(c, 'second', RUNNER_SPEED) <= -CPU_TAG_UP_MARGIN_SEC);
  console.log(`${label.padEnd(14)}` + row([String(band.length), pct(go.length / band.length)], 10));
}

// ---- 12. 余白（margin）の選び方 ----

console.log('\n=== 12. しきい値：余白をどれだけ要求するか（二塁→三塁・基準速） ===');
console.log('   margin＝「これだけ余裕があるときだけ行く」秒数。0＝ぎりぎりでも行く。');
console.log(`${'margin'.padEnd(10)}${row(['仕掛ける', '実際に刺される', '最悪の余裕s'], 15)}`);
for (const margin of [0, 0.1, 0.14, 0.2, 0.3, 0.5]) {
  const going = hitCases.filter((c) => ruleSlack(c, 'second', RUNNER_SPEED) <= -margin);
  const worst = going
    .map((c) => actualSlack(c, 'second', RUNNER_SPEED))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => b - a)[0];
  const caught = going.filter((c) => actualSlack(c, 'second', RUNNER_SPEED) >= 0);
  console.log(
    `${margin.toFixed(2).padEnd(10)}` +
      row(
        [
          pct(going.length / hitCases.length),
          going.length === 0 ? '-' : pct(caught.length / going.length),
          worst === undefined ? '-' : worst.toFixed(2),
        ],
        15,
      ),
  );
}

// ---- 13. 余分な塁の値打ちと、名鑑の走力での発火 ----

console.log('\n=== 13. 余分な塁の値打ち（得点確率） ===');
console.log(`${'場面'.padEnd(22)}${row(['止まる', '進む', '差'], 12)}`);
for (const outs of [0, 1, 2]) {
  // 走者二塁で単打：止まれば三塁、進めば生還（＝1点入るので確率は1）
  const stop = scoreTable[outs][4];
  console.log(
    `${`二塁走者が生還(${outs}死)`.padEnd(22)}` +
      row([pct(stop), pct(1), `+${((1 - stop) * 100).toFixed(1)}pt`], 12),
  );
}
for (const outs of [0, 1, 2]) {
  // 走者一塁で単打：止まれば一・二塁、進めば一・三塁
  const stop = scoreTable[outs][1 | 2];
  const go = scoreTable[outs][1 | 4];
  console.log(
    `${`一塁走者が三塁へ(${outs}死)`.padEnd(22)}` +
      row([pct(stop), pct(go), `+${((go - stop) * 100).toFixed(1)}pt`], 12),
  );
}

const runValues = TEAMS.flatMap((team) => team.lineup.map((r) => fielderRowStats(r).run));
console.log('\n=== 14. 名鑑16球団の打線128人の走力で、規則が発火するか ===');
console.log('   「二塁→三塁」を仕掛ける安打の割合を、実際の走力の分布で見る。');
console.log(`${'走力'.padEnd(10)}${'人数'.padEnd(8)}${row(['仕掛ける割合'], 20)}`);
const buckets = new Map<string, number>();
for (const run of runValues) {
  const key = run.toFixed(1);
  buckets.set(key, (buckets.get(key) ?? 0) + 1);
}
for (const key of [...buckets.keys()].sort()) {
  const speed = 6.8 + 1.4 * Number(key);
  const share = pct(
    hitCases.filter((c) => ruleSlack(c, 'second', speed) <= -CPU_TAG_UP_MARGIN_SEC).length /
      hitCases.length,
  );
  console.log(`${key.padEnd(10)}${String(buckets.get(key)).padEnd(8)}${row([share], 20)}`);
}

// ---- 15. 代打の表に走力の列を足す根拠（フェーズEE-52） ----
//
// DD-51 が投手側でやった 7段目（**5目盛りで名鑑96人が潰れないか／画面の読み取り単位より
// 小さい食い違いしか無いか**）の、打者側の対。見るのは3つ：
//   (a) 走力が5目盛りで**何段階に散るか**（同じバーばかりなら見せても判断材料にならない）
//   (b) 走力の列が**実際に別の選手を指す割合**（AV+HRで選ぶのと結論が変わらないなら飾り）
//   (c) 同じ目盛りに見える2人の**実際の差**（読み取り単位より小さいか）

const BASE_LEG = distance(BASE_POSITIONS.first, BASE_POSITIONS.second);
const ticksOf = (rating: number): number => (ratingBar(rating).match(/●/g) ?? []).length;
const benchStats = TEAMS.map((team) => team.bench.map(benchRowStats));
const batterRuns = [
  ...TEAMS.flatMap((team) => team.lineup.map((r) => fielderRowStats(r).run)),
  ...benchStats.flat().map((b) => b.run),
];

console.log('\n=== 15. 代打の表に走力の列を足す根拠（EE-52。DD-51の7段目の打者側） ===');
console.log(`   (a) 名鑑の野手176人（打線128＋控え48）の走力が ${RATING_TICKS} 目盛りでどう散るか`);
console.log(`${'メモリ'.padEnd(10)}${row(['人数', '割合', '塁間(秒)'], 12)}`);
for (let t = 0; t <= RATING_TICKS; t += 1) {
  const members = batterRuns.filter((run) => ticksOf(run) === t);
  if (members.length === 0) continue;
  const legs = members.map((run) => BASE_LEG / runnerSpeed(run));
  console.log(
    `${('●'.repeat(t) + '○'.repeat(RATING_TICKS - t)).padEnd(10)}` +
      row(
        [
          String(members.length),
          pct(members.length / batterRuns.length),
          `${Math.min(...legs).toFixed(2)}〜${Math.max(...legs).toFixed(2)}`,
        ],
        12,
      ),
  );
}

console.log('   (b) 控え3人のうち「打つ力（AV+HR）で最良」と「走力で最良」が同じ人か');
let differs = 0;
let maxLegGain = 0;
for (const [i, bench] of benchStats.entries()) {
  const byBat = bench.reduce((a, b) => (b.average + b.power > a.average + a.power ? b : a));
  const byRun = bench.reduce((a, b) => (b.run > a.run ? b : a));
  if (byBat === byRun) continue;
  differs += 1;
  // 足で選んだときに買える時間（塁間1つぶん）と、そのとき差し出す打力
  const gain = BASE_LEG / runnerSpeed(byBat.run) - BASE_LEG / runnerSpeed(byRun.run);
  maxLegGain = Math.max(maxLegGain, gain);
  if (differs <= 4) {
    console.log(
      `     ${TEAMS[i].short.padEnd(8)}打力best AV${byBat.average.toFixed(2)}/HR${byBat.power.toFixed(2)} ` +
        `${ratingBar(byBat.run)}  ⇄  足best AV${byRun.average.toFixed(2)}/HR${byRun.power.toFixed(2)} ` +
        `${ratingBar(byRun.run)}（塁間 -${gain.toFixed(2)}秒）`,
    );
  }
}
console.log(
  `     → ${differs}/16 球団で「打つ力で最良」と「走力で最良」が別人` +
    `（足で選ぶと塁間で最大 ${maxLegGain.toFixed(2)} 秒）`,
);
console.log(
  '     CPUの代打（X-45）は AV+HR だけを見るので、この列は**人間だけが見る材料**になる。',
);

console.log('   (c) 同じ目盛りに見える2人の実際の差（読み取り単位より小さいか）');
let sameTickMaxLeg = 0;
let diffTickMinLeg = Number.POSITIVE_INFINITY;
for (const a of batterRuns) {
  for (const b of batterRuns) {
    const gap = Math.abs(BASE_LEG / runnerSpeed(a) - BASE_LEG / runnerSpeed(b));
    if (ticksOf(a) === ticksOf(b)) sameTickMaxLeg = Math.max(sameTickMaxLeg, gap);
    else diffTickMinLeg = Math.min(diffTickMinLeg, gap);
  }
}
console.log(
  `     同じ目盛り：塁間の差は最大 ${sameTickMaxLeg.toFixed(2)}秒 ／ ` +
    `違う目盛り：最小 ${diffTickMinLeg.toFixed(2)}秒`,
);
console.log('     ＝同じ長さに見える2人の差は、人の反応時間（約0.2秒）の範囲に収まっている。');

console.log('\n=== まとめ（この計測が決めたこと） ===');
console.log('   ・送りバントは全塁状況・全アウト・全打者で損（2・4・5段目）＝入れない。');
console.log('     どの狙いでも投手が本塁から約11mで確保し、どの塁へも0.8秒で届くため。');
console.log('   ・スクイズも同じ（6段目）＝頭を最大に取っても本塁で刺される。');
console.log('   ・代打の利得は得点圏で跳ねる（8段目）＝走者なし+4.9pt / 三塁+9.5〜+16.7pt。');
console.log('   ・控えとの差 0.80 は11/16球団で成立し（1.00では4球団＝規則が死ぬ）、');
console.log('     控えが売りのナイツ（1.10）がいちばん出しやすい＝B-12の個性に帰結が付く。');
console.log('   ・費用（先発を降ろす）はブルペンの球数では縛りにならない（9段目）＝');
console.log('     しきい値はイニングではなく「得点圏かどうか」に置くのが計測の答え。');
console.log('   ・打球での余分な進塁には帯がある（11段目）＝バントと裏返しで、');
console.log('     外野へ抜けた打球ほど送球距離が長いので走者が勝てる。');
console.log('   ・余白は `CPU_TAG_UP_MARGIN_SEC`（0.14秒）をそのまま使える（12段目）。');
console.log('   ・代打の表の走力の列は飾りにならない（15段目）＝5目盛りに176人が5段階へ散り、');
console.log('     **16/16球団で「打つ力で最良の控え」と「走力で最良の控え」が別人**');
console.log('     （足で選べば塁間で最大0.46秒＝盗塁・余分な進塁の可否が変わる大きさ）。');
console.log('     同じ長さに見える2人の差は0.13秒＝人の反応時間より小さい（DD-51と同じ基準）。');
console.log('');
