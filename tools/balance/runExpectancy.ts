/**
 * 計測の土台その3：**得点期待**（フェーズQ-38の敬遠のために作った）。
 *
 * `sim.ts` が1打球、`sweep.ts` が1打席ぶんの帰結の分布を出すのに対し、こちらは
 * **その分布を打席の連なりに乗せて「イニングの残りに入る点」を出す**。敬遠は
 * 「打たせずに塁を1つ与える」手なので、得か損かはこの量でしか決まらない。
 *
 * 出力を持たない純粋な計算だけを置く（`walk.ts` が表を印刷し、`tests/balance.test.ts` が
 * 帯を固定する＝`sim.ts`/`sweep.ts` と `report.ts` の分け方と同じ）。
 *
 * ## 何を再利用しているか
 *
 * **進塁と得点は `src/core/rules.ts` の純粋関数をそのまま呼ぶ**（`advanceOnHitRunners` /
 * `forceAdvanceRunners`）＝進塁の規則をここに書き写さない。ゲーム側で進塁の仕方が
 * 変われば、この計測の結論も一緒に動く。
 *
 * ## 意図的な単純化（絶対値ではなく比較に使う）
 *
 * - **分母はフェアの打球**（`sweep.ts` の約束）＝三振・四球・ファウルは打席に数えない。
 *   そのぶんアウト率が低く出て得点期待は高めに出るが、これは**敬遠に不利な方向の偏り**
 *   （走者1人の価値が高く見積もられる）。`walk.ts` の8段目で三振率を仮定した感度を見て、
 *   境界が動かないことを確かめてある。
 * - **アウトのとき走者は動かない**（併殺も進塁打も無い）＝`advanceOnHit` が「全走者が
 *   打者と同じ塁数だけ進む」簡易モデルなのと同じ粒度。
 */
import {
  type BaseRunners,
  type HitType,
  advanceOnHitRunners,
  forceAdvanceRunners,
} from '../../src/core/rules';
import { DEFAULT_BALLPARK } from '../../src/core/ballpark';
import { type Ballpark } from '../../src/core/ballpark';
import { runnerSpeed } from '../../src/core/fielding';
import { type SweepSample, sweep } from './sweep';

/** 打席の帰結。ファウルは打席に数えないので現れない */
export type PaOutcome = 'out' | HitType;

/**
 * 打席の帰結の分布。`walk`（フェーズBBB-84）は**四球・死球の確率**で、渡すと塁が詰まっている
 * 走者だけを押し出す進塁として数える（`rules.ts` の `forceAdvanceRunners`＝試合の四球・死球・
 * 敬遠と同じ規則）。それまでは四死球をアウトか単打のどちらかへ寄せて幅で読むしかなかった
 * （`atBatDistribution` の `walkAs`）。**省略＝0＝従来と完全に同じ**（一様な格子の分布は
 * フェアの打球だけが分母なので、もともと四死球を含まない）。
 */
export type PaDistribution = Record<PaOutcome, number> & { walk?: number };

export const PA_OUTCOMES: readonly PaOutcome[] = [
  'out',
  'single',
  'double',
  'triple',
  'homerun',
];

/** sweep の1打球 → 打席の帰結（ファウルは null＝打席に数えない） */
export function paOutcomeOf(sample: SweepSample): PaOutcome | null {
  const o = sample.result.outcome;
  switch (o.kind) {
    case 'foul':
      return null;
    case 'flyout':
    case 'groundout':
      return 'out';
    case 'beatThrow':
      // 一塁を踏んでそのまま先の塁へ行った打者走者（フェーズBBB-77）
      return o.bases === 3 ? 'triple' : o.bases === 2 ? 'double' : 'single';
    case 'homerun':
      return 'homerun';
    case 'groundRuleDouble':
      return 'double';
    case 'hit':
      return o.hit;
  }
}

export interface DistributionOptions {
  park?: Ballpark;
  /** 打率（AV）。既定は平均 */
  average?: number;
  /**
   * 走力（RUN）。**内野安打（`beatThrow`）にだけ効く**（フェーズR-39で足した）。
   * 打順の比較では打者ごとに能力値が違うので、AV・HRと同じく分布に織り込む。
   * 既定（省略）は平均の走者＝`sim.ts` の既定と同じ＝Q-38までの計測と完全に同じ結果。
   */
  run?: number;
  /** 格子の分割数（片側）。既定 10 */
  steps?: number;
  /**
   * 「バットに当たらない打席」の割合。全打者に同じだけ足す（感度分析用）。
   * 既定 0＝測ったそのまま。
   */
  strikeoutRate?: number;
  /**
   * 投げている球の速さ m/s（フェーズV-43で足した）。**打球初速は `0.5 × 球速` を含む**ので、
   * 速い球ほど当てられたときは飛ぶ（O-35・S-40が記録したU字）。既定（省略）は
   * `sweep` の既定＝`SPEED_NEUTRAL` なので、V-43以前の計測と完全に同じ結果になる。
   */
  pitchSpeed?: number;
  /** その球を投げた投手の基準速（`SweepOptions.pitcherNeutral`。フェーズBBB-85） */
  pitcherNeutral?: number;
  /**
   * 投手の疲労 0..1（フェーズV-43で足した）。**打球初速に最大 `EXIT_FATIGUE_BONUS`
   * ぶんの球威が乗る**（B-11）＝疲れた投手は打たれ方の分布そのものが悪くなる。
   * 既定（省略）は 0＝無傷なので、V-43以前の計測と完全に同じ結果になる。
   */
  pitcherFatigue?: number;
  /**
   * タイミングを固定してコースだけ舐める（フェーズJJ-57）。**CPU打者は常に t=0 で振る**
   * ので、`timing: 0` が「実際に画面で起きていること」に近い分布になる。
   */
  timing?: number;
}

/** 長打力（HR）別の打席帰結の分布 */
export function distributionFor(power: number, opts: DistributionOptions = {}): PaDistribution {
  const k = opts.strikeoutRate ?? 0;
  const samples = sweep({
    park: opts.park ?? DEFAULT_BALLPARK,
    batter: { power, average: opts.average ?? 0.5 },
    runnerSpeed: opts.run === undefined ? undefined : runnerSpeed(opts.run),
    steps: opts.steps ?? 10,
    pitchSpeed: opts.pitchSpeed,
    pitcherNeutral: opts.pitcherNeutral,
    pitcherFatigue: opts.pitcherFatigue,
    timing: opts.timing,
  });
  const dist: PaDistribution = { out: 0, single: 0, double: 0, triple: 0, homerun: 0 };
  let total = 0;
  for (const s of samples) {
    const outcome = paOutcomeOf(s);
    if (outcome === null) continue;
    dist[outcome] += 1;
    total += 1;
  }
  for (const key of PA_OUTCOMES) dist[key] = (dist[key] / total) * (1 - k);
  dist.out += k;
  return dist;
}

// ---- 状態（アウト数 × 塁の埋まり方） ----

export const BASE_STATE_COUNT = 8;

export function runnersOfState(state: number): BaseRunners {
  return {
    first: state & 1 ? 'r1' : null,
    second: state & 2 ? 'r2' : null,
    third: state & 4 ? 'r3' : null,
  };
}

export function stateOfRunners(runners: BaseRunners): number {
  return (runners.first ? 1 : 0) | (runners.second ? 2 : 0) | (runners.third ? 4 : 0);
}

export function baseStateLabel(state: number): string {
  if (state === 0) return 'ランナーなし';
  const names = [state & 1 ? '一' : '', state & 2 ? '二' : '', state & 4 ? '三' : ''].filter(
    Boolean,
  );
  return `${names.join('・')}塁`;
}

/** `E[outs][state]` ＝その状態からイニング終了までに入る点の期待値 */
export type RunExpectancy = number[][];

/** 1打席ぶんの期待値＝Σ 確率 ×（入る点 ＋ 打席後の状態の期待値） */
export function paValue(
  dist: PaDistribution,
  outs: number,
  state: number,
  table: RunExpectancy,
): number {
  let value = 0;
  for (const outcome of PA_OUTCOMES) {
    const p = dist[outcome];
    if (p === 0) continue;
    if (outcome === 'out') {
      value += p * (outs + 1 >= 3 ? 0 : table[outs + 1][state]);
      continue;
    }
    const { runners, runs } = advanceOnHitRunners(runnersOfState(state), 'B', outcome);
    value += p * (runs + table[outs][stateOfRunners(runners)]);
  }
  const walk = dist.walk ?? 0;
  if (walk > 0) {
    const { runners, runs } = forceAdvanceRunners(runnersOfState(state), 'B');
    value += walk * (runs + table[outs][stateOfRunners(runners)]);
  }
  return value;
}

/**
 * その分布の打者だけが並ぶ打線の得点期待表。打席をまたぐ再帰なので反復して解く
 * （アウトの確率が正なので必ず収束する）。
 */
export function solveRunExpectancy(dist: PaDistribution, iterations = 400): RunExpectancy {
  const table: RunExpectancy = [0, 1, 2].map(() => new Array<number>(BASE_STATE_COUNT).fill(0));
  for (let i = 0; i < iterations; i += 1) {
    // アウトの多い側から解くと、同じ反復の中で新しい値が使えて収束が速い
    for (let outs = 2; outs >= 0; outs -= 1) {
      for (let state = 0; state < BASE_STATE_COUNT; state += 1) {
        table[outs][state] = paValue(dist, outs, state, table);
      }
    }
  }
  return table;
}

/** この打者と勝負したときの失点期待（打席のあとは表どおりの打者が続く） */
export function battleValue(
  batter: PaDistribution,
  outs: number,
  state: number,
  table: RunExpectancy,
): number {
  return paValue(batter, outs, state, table);
}

/** 敬遠したときの失点期待＝押し出しの点＋次打者と勝負 */
export function walkValue(
  next: PaDistribution,
  outs: number,
  state: number,
  table: RunExpectancy,
): number {
  const { runners, runs } = forceAdvanceRunners(runnersOfState(state), 'B');
  return runs + battleValue(next, outs, stateOfRunners(runners), table);
}

// ---- 得点確率（フェーズX-45。送りバントはこの尺度でしか測れない） ----
//
// 上の得点期待（平均何点入るか）は敬遠（Q-38）を測るのにちょうどよい量だったが、
// **送りバントはこれで測るとほぼ常に損**になる（アウトを1つ差し出して塁を1つ進める
// 手なので、平均点は必ず下がる方向に働く。実際の野球でもサボメトリクスの結論はこれ）。
//
// 送りバントが実際に使われるのは「**1点あればいい**」場面で、そこで正しい尺度は
// **1点以上入る確率**のほう。同じ `PaDistribution`・同じ進塁規則（`rules.ts` の純粋関数）
// から解けるので、足すのは「点が入ったらそこで1」という終端条件1つだけ。

/** `S[outs][state]` ＝その状態からイニング終了までに**1点以上**入る確率 */
export type ScoreProbability = number[][];

/**
 * 1打席ぶんの得点確率＝Σ 確率 ×（その打席で点が入れば 1、入らなければ打席後の確率）。
 * `paValue`（得点期待）と同じ形で、違うのは**入った点を足す代わりに 1 で打ち切る**ところだけ。
 */
export function paScoreProb(
  dist: PaDistribution,
  outs: number,
  state: number,
  table: ScoreProbability,
): number {
  let value = 0;
  for (const outcome of PA_OUTCOMES) {
    const p = dist[outcome];
    if (p === 0) continue;
    if (outcome === 'out') {
      value += p * (outs + 1 >= 3 ? 0 : table[outs + 1][state]);
      continue;
    }
    const { runners, runs } = advanceOnHitRunners(runnersOfState(state), 'B', outcome);
    value += p * (runs > 0 ? 1 : table[outs][stateOfRunners(runners)]);
  }
  const walk = dist.walk ?? 0;
  if (walk > 0) {
    const { runners, runs } = forceAdvanceRunners(runnersOfState(state), 'B');
    value += walk * (runs > 0 ? 1 : table[outs][stateOfRunners(runners)]);
  }
  return value;
}

/** その分布の打者だけが並ぶ打線の得点確率表（解き方は `solveRunExpectancy` と同じ反復） */
export function solveScoreProbability(dist: PaDistribution, iterations = 400): ScoreProbability {
  const table: ScoreProbability = [0, 1, 2].map(() =>
    new Array<number>(BASE_STATE_COUNT).fill(0),
  );
  for (let i = 0; i < iterations; i += 1) {
    for (let outs = 2; outs >= 0; outs -= 1) {
      for (let state = 0; state < BASE_STATE_COUNT; state += 1) {
        table[outs][state] = paScoreProb(dist, outs, state, table);
      }
    }
  }
  return table;
}

// ---- 打線の得点期待（フェーズR-39。打順の定石を測るための土台） ----
//
// 上の `solveRunExpectancy` は「同じ打者だけが並ぶ打線」を解く（敬遠の損得は打席1つの
// 比較なのでそれで足りた）。**打順を比べるには9人ばらばらの打線を回す必要がある**：
// 打順の値打ちは「打席が何回来るか」と「回ってきたとき塁に誰がいるか」の2つから出て、
// どちらも打線全体の並びで決まるため。
//
// イニングをまたいで**先頭打者が持ち越される**のがこの計算の要点で、そのために
// 1イニングぶんを「先頭打者 b から始めたときの（得点・次の先頭打者の分布・打席数）」
// として解き、それを9イニングぶん連ねる。

/** 1試合のイニング数（延長は数えない＝打順の比較に使う量なので9回で足りる） */
export const INNINGS_PER_GAME = 9;
/** 1イニングに回す打席数の上限（3アウトになる確率が1に収束するまでの打ち切り） */
const MAX_PA_PER_INNING = 60;

/** 塁状況 × 安打の種類 → 進塁後の塁状況と入る点（毎回引き直さないよう先に畳む） */
const HIT_TRANSITION: Array<Partial<Record<HitType, { state: number; runs: number }>>> = Array.from(
  { length: BASE_STATE_COUNT },
  (_, state) => {
    const row: Partial<Record<HitType, { state: number; runs: number }>> = {};
    for (const hit of ['single', 'double', 'triple', 'homerun'] as const) {
      const { runners, runs } = advanceOnHitRunners(runnersOfState(state), 'B', hit);
      row[hit] = { state: stateOfRunners(runners), runs };
    }
    return row;
  },
);

const HIT_KINDS = ['single', 'double', 'triple', 'homerun'] as const;

/**
 * 塁状況 → 四球・死球で押し出された後の塁状況と入る点（フェーズBBB-84。`PaDistribution.walk`）。
 * 安打と違って**詰まっている走者だけが進む**。
 */
const WALK_TRANSITION: Array<{ state: number; runs: number }> = Array.from(
  { length: BASE_STATE_COUNT },
  (_, state) => {
    const { runners, runs } = forceAdvanceRunners(runnersOfState(state), 'B');
    return { state: stateOfRunners(runners), runs };
  },
);

export interface InningResult {
  /** そのイニングに入る点の期待値 */
  runs: number;
  /** 次のイニングの先頭打者の分布（打順の添字→確率。合計1） */
  next: number[];
  /** 打順ごとの打席数の期待値 */
  pa: number[];
}

/**
 * 打順 `leadoff` から始まる1イニングを解く（打線は9人ぶんの帰結の分布で与える）。
 *
 * 打者は1打席ごとにちょうど1つ進むので、**k打席目の打者は必ず `(leadoff+k) % 9`**
 * ＝状態として持つ必要があるのは（アウト数 × 塁の埋まり方）の24通りだけになる。
 */
export function solveInning(lineup: readonly PaDistribution[], leadoff: number): InningResult {
  const size = lineup.length;
  let cur = new Float64Array(3 * BASE_STATE_COUNT);
  cur[0] = 1;
  let runs = 0;
  const next = new Array<number>(size).fill(0);
  const pa = new Array<number>(size).fill(0);
  for (let k = 0; k < MAX_PA_PER_INNING; k += 1) {
    const batter = (leadoff + k) % size;
    const dist = lineup[batter];
    const nxt = new Float64Array(3 * BASE_STATE_COUNT);
    let alive = 0;
    for (let outs = 0; outs < 3; outs += 1) {
      for (let state = 0; state < BASE_STATE_COUNT; state += 1) {
        const p = cur[outs * BASE_STATE_COUNT + state];
        if (p <= 0) continue;
        pa[batter] += p;
        const out = p * dist.out;
        if (outs === 2) next[(leadoff + k + 1) % size] += out;
        else nxt[(outs + 1) * BASE_STATE_COUNT + state] += out;
        for (const hit of HIT_KINDS) {
          const q = p * dist[hit];
          if (q <= 0) continue;
          const t = HIT_TRANSITION[state][hit]!;
          runs += q * t.runs;
          nxt[outs * BASE_STATE_COUNT + t.state] += q;
          alive += q;
        }
        const walk = p * (dist.walk ?? 0);
        if (walk > 0) {
          const t = WALK_TRANSITION[state];
          runs += walk * t.runs;
          nxt[outs * BASE_STATE_COUNT + t.state] += walk;
          alive += walk;
        }
        if (outs < 2) alive += out;
      }
    }
    cur = nxt;
    if (alive < 1e-12) break;
  }
  return { runs, next, pa };
}

export interface LineupResult {
  /** 1試合（9回）に入る点の期待値 */
  runs: number;
  /** 打順ごとの1試合の打席数 */
  pa: number[];
}

/**
 * 打線の1試合の得点期待（先頭打者は1番から。**イニングをまたいで打順が持ち越される**）。
 * 打順を入れ替えると変わるのはこの値で、`lineup` の並びがそのまま打順1〜9番。
 */
export function solveLineup(
  lineup: readonly PaDistribution[],
  innings = INNINGS_PER_GAME,
): LineupResult {
  const size = lineup.length;
  const perLeadoff = Array.from({ length: size }, (_, b) => solveInning(lineup, b));
  let v = new Array<number>(size).fill(0);
  v[0] = 1;
  let runs = 0;
  const pa = new Array<number>(size).fill(0);
  for (let i = 0; i < innings; i += 1) {
    const nv = new Array<number>(size).fill(0);
    for (let b = 0; b < size; b += 1) {
      const w = v[b];
      if (w <= 0) continue;
      const inning = perLeadoff[b];
      runs += w * inning.runs;
      for (let c = 0; c < size; c += 1) {
        nv[c] += w * inning.next[c];
        pa[c] += w * inning.pa[c];
      }
    }
    v = nv;
  }
  return { runs, pa };
}
