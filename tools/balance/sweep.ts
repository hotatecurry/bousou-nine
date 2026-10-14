/**
 * 計測の土台その2：**打席の全域を格子で舐めて帰結を集計する**（フェーズI-29）。
 *
 * `sim.ts` が「1打球のプレー」を回すのに対し、こちらは「バットに当たりうる
 * すべての（タイミング × コース）」を等間隔に並べて、その分布を数える。
 *
 * ## 分母は「バットに当たった打球」
 *
 * 人間が実際にどのタイミングで振るかの分布は分からないので、**接触した打球を
 * 一様に取る**ことを分母にする。これは「打ち方の上手さ」を平均した見方で、
 * 定数を動かしたときの差分を見るには十分（絶対値そのものではなく、
 * 球場間・能力値間・調整の前後の**比較**に使う）。
 *
 * ## タイミングとコースの意味（batting.ts の judgeSwing と同じ）
 *
 * - timing: -1=振り遅れ（流し） / 0=ジャストミート / +1=早振り（引っ張り）
 * - course: -1=外角いっぱい（バットの先） / 0=芯 / +1=内角いっぱい（詰まる）
 */
import {
  type BattingProfile,
  BAT_REACH_INSIDE_X,
  BAT_REACH_OUTSIDE_X,
  NEUTRAL_BATTER,
  SWEET_SPOT_X,
  SWING_ACTIVE_SEC,
  SWING_IDEAL_SEC,
  judgeSwing,
} from '../../src/core/batting';
import {
  type BatterSide,
  RIGHT_BATTER_SIDE,
  SPEED_NEUTRAL,
  batterFrameX,
} from '../../src/core/pitch';
import type { Ballpark } from '../../src/core/ballpark';
import type { FielderId } from '../../src/core/fielding';
import {
  type PlayOptions,
  type PlayOutcome,
  type PlayResult,
  isExtraBase,
  isHit,
  simulatePlay,
} from './sim';

/** 格子の1点（タイミング・コースは -1..+1 の正規化値） */
export interface SwingPoint {
  timing: number;
  course: number;
}

/** timing（-1..1）→ スイング経過秒。judgeSwing の逆算 */
export function swingTimeFor(timing: number): number {
  return SWING_IDEAL_SEC + timing * (SWING_ACTIVE_SEC / 2);
}

/** course（-1..1）→ 打撃面通過時のX（打者ローカル）。judgeSwing の逆算 */
export function localXFor(course: number): number {
  return course < 0
    ? SWEET_SPOT_X + course * (SWEET_SPOT_X - BAT_REACH_OUTSIDE_X)
    : SWEET_SPOT_X + course * (BAT_REACH_INSIDE_X - SWEET_SPOT_X);
}

/**
 * course（-1..1）→ 打撃面通過時の**ワールドX**（＝実際に飛んできたコース。打球の
 * 出どころでもある）。`judgeSwing` にも `createBattedBall` にもこの値を渡す＝
 * **格子の座標をワールドへ直す場所を1か所にする**（フェーズBB-49で打席が反対側へ
 * 移ったとき、掛け忘れた呼び出し側だけが別の打球を作っていた）。
 */
export function crossXFor(course: number, side: BatterSide = RIGHT_BATTER_SIDE): number {
  return batterFrameX(localXFor(course), side);
}

export interface SweepOptions {
  park?: Ballpark;
  batter?: BattingProfile;
  side?: BatterSide;
  pitchSpeed?: number;
  /**
   * その球を投げた投手の基準速（`neutralSpeedFor`。フェーズBBB-85）。**投手ごとの球速
   * （SPD）で `pitchSpeed` を決めたときは必ず渡す**＝打球に乗るのは緩急ぶんだけ（実機と同じ）。
   * 省略＝投手を持たない素の球（球速がそのまま乗る。緩急だけを比べる格子はこちら）。
   */
  pitcherNeutral?: number;
  pitcherFatigue?: number;
  catchBonus?: (id: FielderId) => number;
  runnerSpeed?: number;
  /** 格子の分割数（片側）。既定 10＝ -1..1 を21点 */
  steps?: number;
  /**
   * タイミングを**この値に固定**してコースだけを舐める（フェーズJJ-57）。省略時は
   * 従来どおりタイミングも格子で舐める。**CPU打者は常に t=0（ジャストミート）で振る**
   * （`cpuBatter.ts`）ので、一様な格子の平均は「実際に画面で起きていること」からずれる
   * ＝そこを見るための入口。
   */
  timing?: number;
  /**
   * 守備の追い方と、打球への反応（`sim.ts` の `PlayOptions`。フェーズBBB-83）。省略時は
   * 実機のCPU守備（先回り＋反応）。**人間の守備を相手にする規則**（CPU走者の余分な進塁＝X-45）を
   * 測るときは `'follow'`・反応0（＝CPU走者が人間の守備に見込む動き）を渡す。
   */
  chase?: PlayOptions['chase'];
  reactionSec?: number;
}

export interface SweepSample extends SwingPoint {
  result: PlayResult;
}

/** 格子を舐めて、当たったすべての打球の帰結を返す */
export function sweep(opts: SweepOptions = {}): SweepSample[] {
  const steps = opts.steps ?? 10;
  const side = opts.side ?? RIGHT_BATTER_SIDE;
  const pitchSpeed = opts.pitchSpeed ?? SPEED_NEUTRAL;
  const samples: SweepSample[] = [];
  const fixed = opts.timing;
  for (let i = -steps; i <= steps; i += 1) {
    const timing = fixed ?? i / steps;
    if (fixed !== undefined && i > -steps) break;
    for (let j = -steps; j <= steps; j += 1) {
      const course = j / steps;
      const crossX = crossXFor(course, side);
      const launch = judgeSwing(
        { crossX, swingTime: swingTimeFor(timing), pitchSpeed, pitcherNeutral: opts.pitcherNeutral },
        opts.batter ?? NEUTRAL_BATTER,
        side,
        opts.pitcherFatigue ?? 0,
      );
      // 格子は judgeSwing の接触範囲ちょうどを舐めるので、通常 null は出ない
      // （境界の丸め誤差で外れた点だけを捨てる）
      if (!launch) continue;
      samples.push({
        timing,
        course,
        result: simulatePlay(launch, crossX, {
          park: opts.park,
          catchBonus: opts.catchBonus,
          runnerSpeed: opts.runnerSpeed,
          chase: opts.chase,
          reactionSec: opts.reactionSec,
        }),
      });
    }
  }
  return samples;
}

export interface SweepSummary {
  total: number;
  /** フェアで、かつプレーになった打球（ファウルを除く） */
  inPlay: number;
  homerun: number;
  extraBase: number;
  hit: number;
  foul: number;
  flyout: number;
  groundout: number;
  beatThrow: number;
  /** フェア打球あたりの本塁打率 */
  homerunRate: number;
  /** フェア打球あたりの安打率 */
  hitRate: number;
  /** もっとも飛んだ打球の飛距離 m */
  maxCarry: number;
  /** ジャストミート（timing=0, course=0）の打球 */
  center: PlayResult | null;
}

export function summarize(samples: readonly SweepSample[]): SweepSummary {
  const count = (pred: (o: PlayOutcome) => boolean) =>
    samples.filter((s) => pred(s.result.outcome)).length;
  const foul = count((o) => o.kind === 'foul');
  const inPlay = samples.length - foul;
  const homerun = count((o) => o.kind === 'homerun');
  const hit = count(isHit);
  const center = samples.find((s) => s.timing === 0 && s.course === 0)?.result ?? null;
  return {
    total: samples.length,
    inPlay,
    homerun,
    extraBase: count(isExtraBase),
    hit,
    foul,
    flyout: count((o) => o.kind === 'flyout'),
    groundout: count((o) => o.kind === 'groundout'),
    beatThrow: count((o) => o.kind === 'beatThrow'),
    homerunRate: inPlay === 0 ? 0 : homerun / inPlay,
    hitRate: inPlay === 0 ? 0 : hit / inPlay,
    maxCarry: samples.reduce((m, s) => Math.max(m, s.result.carry), 0),
    center,
  };
}

/** パーセント表示（小数1桁） */
export function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}
