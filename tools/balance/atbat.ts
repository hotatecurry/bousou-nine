/**
 * **打席まるごとの計測の土台（フェーズQQ-65）**＝CPU投手 vs CPU打者の1打席を、
 * 1球ずつ決定的にシミュレートする。
 *
 * ## なぜ要るか
 *
 * `tools/balance/` はここまで**打席の中を一度も回していない**。土台は2つあって、
 * どちらも「当たった後」から始まる：
 *
 * - `sweep.ts`＝**タイミング×コースの格子を一様に舐める**（当たった球だけが分母）。
 * - `runExpectancy.ts`＝その格子から作った分布（`PaDistribution`）に
 *   「三振・四球ぶん」を**外から仮定して足す**（`strikeoutRate`。homerun.ts は 23%）。
 *
 * つまり**「CPU投手が投げた球をCPU打者がどう料理するか」は誰も測っていない**：
 * 何球で決着するのか、四球はどれくらい出るのか、そもそも振ってもらえるのか。
 * ここが空いているせいで、いくつもの計測が**仮定の上に積まれている**：
 *
 * - `homerun.ts`＝三振・四球ぶん **23%**（JJ-57が抗力を決めた分母そのもの）
 * - `relief.ts`＝1打席 **4球**・1試合 **140球**（Z-47の継投の物差し）
 * - `walk.ts` / `lineup.ts` / `pinchrun.ts` / `offense.ts`＝**一様な格子の分布**で
 *   得点期待を解いている（＝Q-38の敬遠 0.80、R-39の盗塁 0.73、GG-54の代走 0.10）
 *
 * しかも CLAUDE.md の「バランス調整の方針」が JJ-57 で足した但し書き
 * （**一様な格子の平均は実際に画面で起きていることではない**＝CPU打者は常に t=0 で振る）に
 * よれば、その分布は**画面の帰結と3倍以上ずれる**（実測：得点 1.40 vs 5.02／1試合）。
 *
 * このファイルはその穴を埋める＝**「1打席」を実際に回して帰結を数える**。
 *
 * ## 何を再利用し、何を再現しているか（sim.ts と同じ境界の引き方）
 *
 * - **判定・CPUの判断はすべて `src/core` の純粋関数をそのまま呼ぶ**
 *   （`chooseCpuPitchPlan` / `cpuPitcherStyle` / `pitcherControl` / `planCpuPitchShape` /
 *   `cpuSteerAccelAt` / `stepPitchFlight` / `plateCrossingX` / `judgePitch` /
 *   `cpuSwingLead` / `crossesSwingDecisionPoint` / `cpuSwingClockAt` / `shouldCpuSwing` /
 *   `drawCpuSwingNoise` / `chooseCpuStance` /
 *   `contactPlaneCrossing` / `judgeSwing` / `callAfterSwing` / `applyPitch`）。
 *   **ここに判定式は1つも書かない**＝定数を動かせば計測も一緒に動く。
 * - **再現しているのは「フレームの回し方」だけ**：1球の中で
 *   ①横加速を解く →②飛行を1フレーム進める →③CPUのスイング判断 →④接触判定 →
 *   ⑤本塁通過のコース判定 →⑥捕手まで到達したら決着、という順序は
 *   `scenes/dekkaiScene.ts` の `update()` の 'flight' 分岐（と `onFlightStep` の中身＝
 *   `main.ts`）にある。**この部分だけはシーン層と二重になる**ので、
 *   実機（Playwright）で突き合わせてから数値を動かすこと（sim.ts と同じ約束）。
 * - **打球のプレーは `sim.ts` の `simulatePlay` にそのまま渡す**（＝守備・送球・
 *   走者の時間競争は既存の土台のまま）。
 *
 * ## 前提（意図的な単純化）
 *
 * - **塁上の走者はいない**（`simulatePlay` の前提そのまま）。打席の帰結を測るのが目的で、
 *   走者がいるとCPUの送球先の選択が混ざる。得点への翻訳は従来どおり
 *   `runExpectancy.ts` が担う（＝**この土台が作るのは分布まで**）。
 * - **打者の立ち位置（O-36）は打席の間に寄り切る**：実機は 1.2m/s で寄るが、
 *   球と球の間（`PITCH_SETTLE_SEC` + `CPU_PITCH_INTERVAL_SEC` ＝ 1秒以上）で
 *   可動幅 0.2m は必ず埋まる（0.2 / 1.2 ≒ 0.17秒）。
 * - **人間の打者・人間の投手は測れない**（入力次第）。ここで出るのは
 *   **CPU同士＝「読み合いが無い」ときの下限**にあたる。
 *
 * ## フェーズAAA-75：CPU打者のぶれ（ここだけは同じ対戦でも結果が散る）
 *
 * CPU打者は**人間並みにタイミングがぶれる**（`cpuBatter.ts` の `CPU_SWING_SIGMA_SEC`）。
 * ぶれは試合と同じ `drawCpuSwingNoise` を**系列（`SwingNoiseStream`）として回す**ので、
 * **系列を渡さなければ毎回同じ打席**（既定の系列＝ゲームの既定シードと同じ）になり、
 * **1つの系列を計測全体で共有すれば、打席ごとに違うぶれ**が乗る（＝分布が測れる）。
 * どちらも決定的＝同じ呼び方をすれば必ず同じ数字が出る。
 */
import {
  type Count,
  type PitchJudgement,
  EMPTY_COUNT,
  applyPitch,
} from '../../src/core/rules';
import {
  type BatterSide,
  type PitchArm,
  type PitchCall,
  type PitchFlight,
  type PitchProfile,
  CATCH_Z,
  LEFT_BATTER_SIDE,
  REFERENCE_PITCHER_NEUTRAL,
  RIGHT_BATTER_SIDE,
  armReleaseOffsetX,
  batterFrameX,
  fatiguedBreak,
  fatiguedControl,
  fatiguedSpeed,
  flightRateAt,
  flightSecondsUntil,
  forkBounces,
  judgePitch,
  neutralSpeedFor,
  pitchBounces,
  plateCrossingX,
  releasePitchFlight,
  releaseXFor,
  speedForPitchSelection,
  stepPitchFlight,
} from '../../src/core/pitch';
import {
  type BattedBallLaunch,
  type BattingProfile,
  CONTACT_PLANE_Z,
  SWING_ACTIVE_SEC,
  SWING_IDEAL_SEC,
  callAfterSwing,
  contactPlaneCrossing,
  judgeSwing,
} from '../../src/core/batting';
import {
  type CpuPaceScope,
  type CpuPitchMix,
  type CpuPitchPlan,
  type CpuPitchShape,
  type CpuPitchSides,
  type CpuSpeedMode,
  CPU_CROSS_CHANCE,
  CPU_ATTACK_CHANCE,
  CPU_PACE_CHANGE_CHANCE,
  CPU_PITCH_MIX_SALT,
  CPU_PITCH_SIDE_SALT,
  avoidCrowdingBatter,
  chooseCpuPitchPlan,
  cpuPitcherStyle,
  cpuSteerAccelAt,
  drawCpuPitchMix,
  drawCpuPitchSides,
  planCpuPitchShape,
  releaseSpeedForPlan,
} from '../../src/core/cpuPitcher';
import {
  CPU_SWING_NOISE_SALT,
  CPU_SWING_SIGMA_SEC,
  chooseCpuStance,
  cpuSwingClockAt,
  cpuSwingLead,
  cpuTimingScale,
  crossesSwingDecisionPoint,
  drawCpuSwingNoise,
  shouldCpuSwing,
} from '../../src/core/cpuBatter';
import { DEFAULT_SEED, createRngState } from '../../src/core/rng';
import {
  type BatterStats,
  type PitcherStats,
  effectiveBattingHand,
  pitchArmOf,
  pitcherControl,
} from '../../src/core/roster';
import { type Ballpark, DEFAULT_BALLPARK } from '../../src/core/ballpark';
import { runnerSpeed } from '../../src/core/fielding';
import { type PlayOptions, type PlayResult, SIM_DT, simulatePlay } from './sim';
import { type PaDistribution, type PaOutcome, paOutcomeOf } from './runExpectancy';

/** 1球が捕手へ届くまでの最大フレーム数（無限ループの保険。実際は40前後） */
const MAX_PITCH_FRAMES = 600;
/** 1打席の最大球数（ファウルで延びるので上限を置く。実際は10球未満で決着する） */
const MAX_PITCHES_PER_PA = 40;

/** 打席の帰結（打席が終わった理由） */
export type AtBatKind = 'strikeout' | 'walk' | 'hitByPitch' | 'inPlay';

export interface AtBatResult {
  kind: AtBatKind;
  /**
   * インプレーになったときの帰結（`runExpectancy.ts` の `PaOutcome` と同じ語彙）。
   * それ以外は null＝**得点期待へ翻訳するのは呼び出し側**（四球・死球は塁を与える手で、
   * 打球の分布とは別枠のため）。
   */
  outcome: PaOutcome | null;
  /** この打席の投球数（`relief.ts` の PITCHES_PER_PA=4 を検証する材料） */
  pitches: number;
  /** 振った回数（空振り・ファウル・インプレーを含む） */
  swings: number;
  /** ファウルで粘った回数 */
  fouls: number;
  /** 見送った回数 */
  takes: number;
  /** この打席で到達した最深のストライク数（2ストライクへ届いたかを数える材料。TT-68） */
  maxStrikes: number;
  /** この打席で到達した最深のボール数（3ボールへ届いたかを数える材料。TT-68） */
  maxBalls: number;
  /** 振って当たらなかった回数（空振り。フェーズAAA-75） */
  misses: number;
  /** インプレーになったときの打球そのもの（HR判定・飛距離を見る材料） */
  play?: PlayResult;
  /**
   * インプレーになった打球の入力（フェーズBBB-83）。**同じ打球を別の守備で回し直す**
   * （`simulatePlay` にそのまま渡す）ための控え。
   */
  batted?: { launch: BattedBallLaunch; contactX: number; runnerSpeed: number };
}

/**
 * CPU打者のぶれの系列（フェーズAAA-75）。試合の `cpuSwingNoiseState`（main.ts）と同じく
 * `drawCpuSwingNoise` を1球に1回ずつ回す。`sigma` を 0 にすれば**ぶれ無し**＝狙いどおりの時刻。
 */
export interface SwingNoiseStream {
  /** 次の1球ぶんのぶれ（秒） */
  next(): number;
  /**
   * 同じ種から起こした**CPU投手の内外角の系列**（フェーズBBB-84）。試合では1つのシードから
   * ぶれの系列も内外角の系列も起きる（main.ts）ので、計測でも**ぶれの系列を共有すれば
   * 内外角の系列も一緒に共有される**＝打席ごとに違う側へ来る。
   */
  sides: PitchSideStream;
  /** 同じ種から起こした**CPU投手の配球のくじの系列**（フェーズCCC-86。`sides` と同じ考え方） */
  mixes: PitchMixStream;
}

/**
 * CPU投手の内外角の系列（フェーズBBB-84）。試合の `cpuPitchSideState`（main.ts）と同じく
 * `drawCpuPitchSides` を1球に1回ずつ回す。
 */
export interface PitchSideStream {
  /** 次の1球ぶんの内外角 */
  next(): CpuPitchSides;
}

/**
 * CPU投手の配球のくじの系列（フェーズCCC-86）。試合の `cpuPitchMixState`（main.ts）と同じく
 * `drawCpuPitchMix` を1球に1回ずつ回す。
 */
export interface PitchMixStream {
  /** 次の1球ぶんの配球のくじ */
  next(): CpuPitchMix;
}

/**
 * `changeChance`・`attackChance` は**定数（`CPU_PACE_CHANGE_CHANCE`・`CPU_ATTACK_CHANCE`）を
 * 書き換えずに割合を振るための引数**。
 */
export function pitchMixStream(
  seed: number = DEFAULT_SEED,
  changeChance: number = CPU_PACE_CHANGE_CHANCE,
  attackChance: number = CPU_ATTACK_CHANCE,
): PitchMixStream {
  let state = createRngState(seed + CPU_PITCH_MIX_SALT);
  return {
    next() {
      const draw = drawCpuPitchMix(state, changeChance, attackChance);
      state = draw.state;
      return draw.mix;
    },
  };
}

/** `crossChance` は**定数（`CPU_CROSS_CHANCE`）を書き換えずに逆を突く割合を振るための引数** */
export function pitchSideStream(
  seed: number = DEFAULT_SEED,
  crossChance: number = CPU_CROSS_CHANCE,
): PitchSideStream {
  let state = createRngState(seed + CPU_PITCH_SIDE_SALT);
  return {
    next() {
      const draw = drawCpuPitchSides(state, crossChance);
      state = draw.state;
      return draw.sides;
    },
  };
}

export function swingNoiseStream(
  seed: number = DEFAULT_SEED,
  sigma: number = CPU_SWING_SIGMA_SEC,
): SwingNoiseStream {
  let state = createRngState(seed + CPU_SWING_NOISE_SALT);
  return {
    next() {
      const draw = drawCpuSwingNoise(state, sigma);
      state = draw.state;
      return draw.noise;
    },
    sides: pitchSideStream(seed),
    mixes: pitchMixStream(seed),
  };
}

export interface AtBatOptions {
  park?: Ballpark;
  /** 投手の疲労 0..1（既定 0＝無傷）。球速・変化量・制球・球威のすべてに効く（B-11／W-44） */
  fatigue?: number;
  /**
   * 好調（D-19）の補正を打者へ足すか。`HOT_MODIFIER` は呼び出し側で足して渡す想定なので、
   * ここでは受け取らない（＝この土台は名鑑の値をそのまま使う）。
   */
  /** 打席の左右を明示する（既定は名鑑のBOXと相手投手のARMから導出＝実機と同じ） */
  side?: BatterSide;
  /**
   * CPU打者が手を出す幅（フェーズSS-67）。**定数を書き換えずに振るための引数**で、
   * 渡さなければ採用値（`SELECTIVE_HALF_WIDTH` / `TWO_STRIKE_HALF_WIDTH`）＝実機と同じ。
   */
  swingWidths?: { normal?: number; twoStrike?: number };
  /**
   * CPU投手が**通常の球**で狙う内外角（ワールドXの絶対値。フェーズTT-68）と、
   * CPU打者の**通常の早振りの罰**（同）。`swingWidths` と同じく**定数
   * （`NORMAL_TARGET_X` / `CPU_TIMING_PENALTY_SEC`）を書き換えずに振るための引数**で、
   * 渡さなければ採用値＝実機と同じ。
   */
  aims?: { normalTarget?: number; crossBothWays?: boolean; paceScope?: CpuPaceScope };
  /**
   * CPU投手の配球のくじの系列（フェーズCCC-86）。渡さなければ**ぶれの系列と同じ種の系列**
   * （`noise.mixes`）＝実機と同じ。**`null` を渡すといつもの形だけ**（CCC-86 の前＝球速はカウント
   * だけで決まり、追い込んだ1球は必ず外へ逃げる）＝前後を比べる用。
   */
  mixes?: PitchMixStream | null;
  /**
   * 打者が**どの速さを待つか**（フェーズCCC-86。人間の打者の打ち方を置く）。
   * `usual`＝そのカウントでいつも投げる球速（カウントの傾向＝手がかり）、`actual`＝本当に来る球速。
   * 返すのは待つ緩急の段・`'actual'`（本当の速さを知っている＝読みの札の上限）・`'last'`
   * （直前のストライクの速さ＝CPU打者の規則）。渡さなければ `'last'`（`readsPace` なら `'actual'`）。
   */
  waitFor?: (ctx: { count: Count; usual: CpuSpeedMode; actual: CpuSpeedMode }) => CpuSpeedMode | 'actual' | 'last';
  /**
   * **人間が待つ速さを外したときのずれを、本当の時間差で数える**（フェーズCCC-86）。渡さなければ
   * CPU打者と同じ（緩急1段＝`CPU_TIMING_PENALTY_SEC`＝見てから半分以上合わせ直せる前提）。
   * 数を渡すと、本当の時間差のその割合だけずれる（1＝待っていた速さの球が届く時刻に振り出す＝
   * 合わせ直せない前提で、外せばほぼ空振り／0.5＝見てから半分だけ合わせ直せる）。
   */
  hardTiming?: number;
  /**
   * CPU打者のぶれ（フェーズAAA-75）。渡さなければ**この打席のためだけの既定の系列**
   * （＝同じ対戦はいつも同じ打席）。計測全体で1つを共有すると打席ごとに違うぶれが乗る。
   */
  noise?: SwingNoiseStream;
  /** 緩急1段あたりのずれ（秒）。**定数（`CPU_TIMING_PENALTY_SEC`）を書き換えずに振るための引数** */
  paceStepSec?: number;
  /** 1フレームの長さ（既定 `SIM_DT`＝60Hz）。**リフレッシュレートによらないこと**の確認に使う */
  dt?: number;
  /** AAA-75の前のスイングの始め方（フレームの先頭から振り出す）で測る＝不具合の再現用 */
  legacyFrameStart?: boolean;
  /**
   * **人間が投げる球**（フェーズAAA-75の17段目）。渡すとCPU投手の配球の代わりに、毎球この
   * 関数が返す球を**まっすぐ**投げる（`selection`＝緩急の上下、`localX`＝打者から見た
   * コース。負が外角）。**人間の決まった配球に必勝の形が無いか**を数えるための入口。
   */
  humanPitch?: (count: Count, index: number) => HumanPitch;
  /**
   * 野手の定位置の差し替え（`PlayOptions.home`。フェーズBBB-83）。**定数を書き換えずに外野の
   * 深さの候補を比べる**ための引数で、渡さなければ `FIELDER_HOME_POSITIONS`＝実機と同じ。
   */
  home?: PlayOptions['home'];
  /** CPU守備の追い方の差し替え（`PlayOptions.chase`。フェーズBBB-83の前後を比べる用） */
  chase?: PlayOptions['chase'];
  /** CPU守備の反応の遅れの差し替え（`PlayOptions.reactionSec`） */
  reactionSec?: PlayOptions['reactionSec'];
  /**
   * 打者の立ち位置の差し替え（フェーズBBB-83）。**人間の打者のように「来る側を読んで構える」**
   * 場合を測るための引数で、渡さなければCPU打者の規則（`chooseCpuStance`）＝実機と同じ。
   * `planned` はこの球の**本当の**狙い（打者ローカルX）。`tell` は**打者に見えているもの**
   * （フェーズBBB-84）＝投手の立ち位置が示す側と、投げた後に球筋を見て動ける時間。
   */
  stanceFor?: (lastStrikeLocalX: number | null, planned: number, tell: PitchTell) => number;
  /**
   * CPU投手の内外角の系列（フェーズBBB-84）。渡さなければ**ぶれの系列と同じ種の系列**
   * （`noise.sides`）＝実機と同じ。**`null` を渡すと BBB-83 までの規則**（ボール数＋ファウル数の
   * 偶奇・必ず立ち位置どおり）＝前後を比べる用。
   */
  sides?: PitchSideStream | null;
  /**
   * 打者が**球速も読む**（待つ速さ＝その球の速さ）。CPU投手の球速はカウントから決まるので、
   * 人間は投げる前に知れる＝人間の打者の上限を測る用（CPU打者は直前のストライクの速さを待つ）。
   */
  readsPace?: boolean;
  /**
   * **リリースの瞬間の**立ち位置（渡さなければ `stanceFor` と同じ＝投げる前に決めて動かない）。
   * `stanceFor` は球が届くときの立ち位置＝**投げた後に踏み込む打者**を測るための引数。
   */
  stanceAtReleaseFor?: (lastStrikeLocalX: number | null, planned: number, tell: PitchTell) => number;
  /**
   * CPU投手が、**リリースの瞬間に**踏み込んでいる打者の体へ行く球を反対側へ投げる
   * （`avoidCrowdingBatter`）。既定は実機と同じ（する）。`false` で、当てていた頃を再現する。
   */
  avoidCrowder?: boolean;
  /**
   * 投げた後に踏み込んで当たった球を死球にしない（`judgePitch` の `releaseStance`）。
   * 既定は実機と同じ（死球にしない）。`false` で、死球になった頃を再現する。
   */
  noAwardIfSteppedIn?: boolean;
  /**
   * 投手の球速（SPD）の効かせ方（フェーズBBB-85）。**渡さなければ実機と同じ**。前後と、
   * 採らなかった形を比べるための引数（`npm run balance:speed`）。
   */
  speedRule?: SpeedRule;
}

/** 投手の球速（SPD）の効かせ方（`AtBatOptions.speedRule`。フェーズBBB-85） */
export interface SpeedRule {
  /**
   * 打球に乗るのは緩急ぶんだけ（`carriedPitchSpeed`）。既定は実機と同じ（true）。
   * `false`＝BBB-84 まで（投手の球速がそのまま打球に乗る）。
   */
  relativeCarry?: boolean;
  /**
   * 球が速い投手ほどCPU打者の誤差が大きい（`cpuTimingScale`）。既定は実機と同じ（true）。
   * `false`＝BBB-84 まで（誰が投げても同じ誤差）。
   */
  timingScale?: boolean;
  /** 誤差の倍率の指数（既定 1＝飛行時間の比そのまま。2 は採らなかった強い形） */
  timingPow?: number;
  /** 基準にする投手の基準速（既定 `REFERENCE_PITCHER_NEUTRAL`＝名鑑の平均。36 は SPD 0.5） */
  reference?: number;
}

/** 打者に見えている手がかり（`AtBatOptions.stanceFor`。フェーズBBB-84） */
export interface PitchTell {
  /**
   * 投手の立ち位置が示す狙い（打者ローカルX）。立ち位置どおりの球では本当の狙いと同じ、
   * 逆を突く球では符号が逆。真ん中狙いは 0。
   */
  shown: number;
  /** リリースから打撃面までの実時間（秒）。投げた後に球筋を見て動ける時間の上限 */
  secondsToContact: number;
}

/** 人間が投げる1球（`AtBatOptions.humanPitch`） */
export interface HumanPitch {
  /** 緩急（-1＝速球 / 0＝基準速 / 1＝フォーク。`speedForPitchSelection` の y） */
  selection: -1 | 0 | 1;
  /** 本塁を通るコース（打者ローカルX。負＝外角） */
  localX: number;
}

/** `simulatePitch` の追加の引数（フェーズAAA-75で位置引数から畳んだ） */
export interface PitchOptions {
  /** この打席でファウルにされた球数（SS-67。CPU投手が隅を散らす材料） */
  foulsInAtBat?: number;
  swingWidths?: { normal?: number; twoStrike?: number };
  aims?: { normalTarget?: number; crossBothWays?: boolean; paceScope?: CpuPaceScope };
  /** この球の内外角（フェーズBBB-84。渡さなければ BBB-83 までの偶奇の規則） */
  sides?: CpuPitchSides;
  /** この球の配球のくじ（フェーズCCC-86。渡さなければいつもの形） */
  mix?: CpuPitchMix;
  /** 待つ速さを外したずれを本当の時間差で数える割合（`AtBatOptions.hardTiming`） */
  hardTiming?: number;
  /** 投げる前に解いた球（`planCpuPitch`）。渡さなければここで解く */
  planned?: PlannedCpuPitch;
  /**
   * リリースの瞬間の立ち位置（`AtBatOptions.stanceAtReleaseFor`）。渡すと、**投げた後に
   * 踏み込んで当たった球は死球にしない**（`judgePitch` の5つ目の引数）。
   */
  releaseStance?: number;
  /** 打者が球速も読む（待つ速さ＝この球の速さ。`AtBatOptions.readsPace`） */
  readsPace?: boolean;
  /** CPU打者が待っている球速（null＝打席の初球＝その投手の基準速を待つ） */
  expectedSpeed?: number | null;
  /** この球のぶれ（秒。既定0＝狙いどおりの時刻） */
  noise?: number;
  paceStepSec?: number;
  dt?: number;
  legacyFrameStart?: boolean;
  /** CPU投手の配球の代わりに投げる球（人間の球＝曲げない。`AtBatOptions.humanPitch`） */
  given?: PitchFlight;
  speedRule?: SpeedRule;
}

/** 1球の中で起きたこと（`simulateAtBat` の内部。テストから覗けるように export する） */
export interface PitchOutcome {
  /** 見逃した／当たらなかったときの判定 */
  call: PitchCall | null;
  /** スイングしたか */
  swung: boolean;
  /** 打球（当たったとき） */
  launch: ReturnType<typeof judgeSwing>;
  /** 打球が打撃面を通過したワールドX（`simulatePlay` に渡す接触点） */
  contactX: number;
  /** 本塁を通過したコース（打者ローカルX。次の球の立ち位置の材料。通過しなければ null） */
  crossedLocalX: number | null;
  /** 投げた球の飛行時間（秒） */
  seconds: number;
  /** 投げた球の速さ（CPU打者が「次に待つ速さ」の材料。フェーズAAA-75） */
  speed: number;
  /** 振って当たらなかったか（空振り） */
  missed: boolean;
  /** 当たったときの正規化タイミング（正＝早振り・引っ張り。当たらなければ null） */
  timing: number | null;
}

/** 疲労を織り込んだ投球プロフィール（main.ts の `currentPitchProfile` と同じ式） */
export function pitchProfileOf(stats: PitcherStats, fatigue = 0): PitchProfile {
  return {
    speed: fatiguedSpeed(stats.speed, fatigue),
    breakLeft: fatiguedBreak(stats.breakLeft, fatigue),
    breakRight: fatiguedBreak(stats.breakRight, fatigue),
    fork: fatiguedBreak(stats.fork, fatigue),
  };
}

/** 疲労を織り込んだ制球（main.ts の `currentPitcherControl` と同じ式） */
export function controlOf(stats: PitcherStats, fatigue = 0): number {
  return fatiguedControl(pitcherControl(stats.era), fatigue);
}

/** 名鑑のBOX × 相手投手のARM → 打席の左右（main.ts の `currentBatterSide` と同じ式） */
export function batterSideOf(batter: BatterStats, pitcher: PitcherStats): BatterSide {
  return effectiveBattingHand(batter.bats, pitcher.throws) === 'L'
    ? LEFT_BATTER_SIDE
    : RIGHT_BATTER_SIDE;
}

/** CPU投手が投げる前に決めた1球（方針・形・飛行の始まり） */
export interface PlannedCpuPitch {
  plan: CpuPitchPlan;
  shape: CpuPitchShape;
  flight: PitchFlight;
}

/**
 * CPU投手の1球を、投げる前に解く（`dekkaiScene.ts` の `createCpuPitcherController.updateReady`
 * と `release` の並び）。**打者の構えを決める前に、投手の立ち位置を知る**ために切り出した
 * （フェーズBBB-84。人間の打者は立ち位置を見てから構える）。
 */
export function planCpuPitch(
  profile: PitchProfile,
  control: number,
  arm: PitchArm,
  count: Count,
  opts: Pick<PitchOptions, 'foulsInAtBat' | 'aims' | 'sides' | 'mix'> & { batterSide?: BatterSide } = {},
): PlannedCpuPitch {
  const plan = chooseCpuPitchPlan(
    count,
    cpuPitcherStyle(profile),
    control,
    opts.foulsInAtBat ?? 0,
    // ワンバウンドするフォークは投手有利のカウントでだけ（フェーズBBB-79。dekkaiScene.ts と同じ）
    // 逆を突くのは打者の外角側に立ったときだけ＝打席の左右が要る（フェーズBBB-84）
    // 緩急と勝負球はくじが当たったときだけいつもの形から外す（フェーズCCC-86）
    {
      ...(opts.aims ?? {}),
      bouncingFork: forkBounces(profile.fork),
      sides: opts.sides,
      batterSide: opts.batterSide,
      mix: opts.mix,
    },
  );
  return shapeCpuPitch(plan, profile, arm);
}

/**
 * そのカウントで**いつも投げる球速**（カウントの傾向＝打者に見えている手がかり。フェーズCCC-86）。
 * 緩急のくじを渡さずに方針を解くだけ（球速は内外角に左右されない）。
 */
export function usualPaceOf(
  profile: PitchProfile,
  control: number,
  count: Count,
  opts: Pick<PitchOptions, 'foulsInAtBat' | 'aims'> = {},
): CpuSpeedMode {
  return chooseCpuPitchPlan(count, cpuPitcherStyle(profile), control, opts.foulsInAtBat ?? 0, {
    ...(opts.aims ?? {}),
    bouncingFork: forkBounces(profile.fork),
  }).speed;
}

/** その緩急で投げたときの球速 m/s（CPU投手の `releaseSpeedForPlan` と同じ） */
export function speedOfPace(mode: CpuSpeedMode, profile: PitchProfile): number {
  return releaseSpeedForPlan({ targetX: 0, speed: mode }, profile.speed);
}

/**
 * リリースから打撃面までの実時間（秒）。**同じ場所から、その球速で投げたら**（フォークの手元の
 * 失速・飛行の時計込み＝`releasePitchFlight`）。人間が待つ速さを外したときのずれを数える材料。
 */
export function secondsToContactAt(speed: number, profile: PitchProfile): number {
  const flight = releasePitchFlight(0, speed, 0, neutralSpeedFor(profile.speed), profile.fork);
  return flightSecondsUntil(flight, CONTACT_PLANE_Z);
}

/** 方針から、球の形と飛行の始まりを解く（`planCpuPitch` の後半。リリースの瞬間の解き直しにも使う） */
export function shapeCpuPitch(plan: CpuPitchPlan, profile: PitchProfile, arm: PitchArm): PlannedCpuPitch {
  const releaseOffset = armReleaseOffsetX(arm);
  const shape = planCpuPitchShape(plan, profile, undefined, releaseOffset);
  // ボールは体（plateX）から腕のぶん外れたところから出る（CC-50）。初期の横速度は
  // **逆を突く球だけ**が持つ（BBB-84。立ち位置どおりの球は 0＝狙いはリリース位置そのもの）。
  // 飛行の時計とフォークの手元の失速は試合と同じ（フェーズBBB-76／77。dekkaiScene.ts の
  // release と同じ `releasePitchFlight`）
  const flight = releasePitchFlight(
    releaseXFor(shape.plateX, releaseOffset),
    shape.speed,
    shape.releaseVx,
    neutralSpeedFor(profile.speed),
    profile.fork,
  );
  return { plan, shape, flight };
}

/**
 * 1球を投げて決着させる（決定的）。
 *
 * フレームの順序は `dekkaiScene.ts` の `update()` の 'flight' 分岐に合わせてある：
 * ①`sinceRelease += dt` →②横加速（`cpuSteerAccelAt` を**飛行の時計**で。BBB-76）→
 * ③飛行を1フレーム →④CPUのスイング判断（`onFlightStep`）→⑤接触判定（`checkContact`）→
 * ⑥本塁通過のコース判定 →⑦死球なら即決着／捕手（`CATCH_Z`）まで届いたら決着。
 * **スイングの経過（swingT）はこのフレームの後で進む**（`batting.update` が
 * `pitching.update` の後に呼ばれる。main.ts:3032 のコメントが順序を明示している）。
 */
export function simulatePitch(
  profile: PitchProfile,
  control: number,
  arm: PitchArm,
  count: Count,
  batter: BattingProfile,
  side: BatterSide,
  stance: number,
  fatigue: number,
  opts: PitchOptions = {},
): PitchOutcome {
  const dt = opts.dt ?? SIM_DT;
  // 人間の球（`given`）は曲げない＝CPUの形を持たない
  const planned = opts.given
    ? null
    : (opts.planned ?? planCpuPitch(profile, control, arm, count, { ...opts, batterSide: side }));
  const shape = planned ? planned.shape : null;
  let flight: PitchFlight = opts.given ?? planned!.flight;

  // CPU打者が振り出す時刻は**球ごとに一度だけ**決める（main.ts の `cpuSwingLeadFor`）
  // 投げた投手の基準速は球が持っている（BBB-85。main.ts の `cpuSwingLeadFor` と同じ）
  const pitcherNeutral = flight.neutral ?? neutralSpeedFor(profile.speed);
  const rule = opts.speedRule ?? {};
  const reference = rule.reference ?? REFERENCE_PITCHER_NEUTRAL;
  // 基準を差し替えるときは、基準速のほうをずらして渡す（定数を書き換えずに比べる）
  const ruleNeutral = pitcherNeutral - (reference - REFERENCE_PITCHER_NEUTRAL);
  // 既定は実機と同じ関数をそのまま通す（指数・基準を差し替えたときだけここで計算する）
  const timingScale = !(rule.timingScale ?? true)
    ? 1
    : rule.timingPow === undefined && rule.reference === undefined
      ? cpuTimingScale(pitcherNeutral)
      : Math.pow(pitcherNeutral / reference, rule.timingPow ?? 1);
  const expected = opts.readsPace ? flight.vz : (opts.expectedSpeed ?? null);
  // 人間が合わせ直せない前提（フェーズCCC-86の `hardTiming`）：待っていた速さの球が届く時刻に
  // 振り出す＝ずれは本当の時間差そのもの（速球↔基準速で 0.09秒・基準速↔フォークで 0.19秒）
  const lead =
    opts.hardTiming !== undefined
      ? Math.max(
          0,
          SWING_IDEAL_SEC +
            opts.hardTiming *
              (flightSecondsUntil(flight, CONTACT_PLANE_Z) - secondsToContactAt(expected ?? pitcherNeutral, profile)) +
            (opts.noise ?? 0),
        )
      : cpuSwingLead(flight.vz, pitcherNeutral, expected, opts.noise ?? 0, opts.paceStepSec, timingScale);
  const speed = flight.vz;

  let sinceRelease = 0;
  /** リリースからの飛行の時間（CPUの曲げ方の時計。dekkaiScene.ts の flightElapsed と同じ） */
  let flightElapsed = 0;
  let swingT: number | null = null;
  let swung = false;
  let call: PitchCall | null = null;
  let crossedLocalX: number | null = null;
  let missed = false;

  for (let frame = 0; frame < MAX_PITCH_FRAMES / (dt / SIM_DT); frame += 1) {
    sinceRelease += dt;
    const prev = flight;
    // CPUの曲げ方は球速どおりの飛行の時間で解いてある＝その時計で問い合わせる（BBB-76／77）
    const r = flightRateAt(prev, prev.z);
    const accel = shape ? cpuSteerAccelAt(shape, flightElapsed, dt * r) : 0;
    const next = stepPitchFlight(prev, shape ? shape.steerX : 0, dt, accel);
    if (prev.vz > 0) flightElapsed += (next.z - prev.z) / prev.vz;

    // ---- onFlightStep（main.ts）：CPU打者のスイング判断 ----
    if (swingT === null && !swung && crossesSwingDecisionPoint(prev, next, lead)) {
      if (shouldCpuSwing(next, count, side, stance, opts.swingWidths ?? {})) {
        // 振り出すのはフレームの途中＝そのぶんをスイングの時計に持たせる（AAA-75）
        swingT = opts.legacyFrameStart ? 0 : cpuSwingClockAt(prev, lead);
        swung = true;
      }
    }
    // ---- batting.checkContact（dekkaiScene）：接触はコース判定より先 ----
    if (swingT !== null) {
      const cross = contactPlaneCrossing(prev, next);
      if (cross) {
        const launch = judgeSwing(
          {
            crossX: cross.x,
            // swingT はフレーム先頭時点の経過なので、サブフレームの通過時刻を足す
            swingTime: swingT + cross.frac * dt,
            pitchSpeed: prev.vz,
            pitcherNeutral: (rule.relativeCarry ?? true) ? ruleNeutral : undefined,
          },
          batter,
          side,
          fatigue,
          stance,
        );
        if (launch) {
          return {
            call: null,
            swung: true,
            launch,
            contactX: cross.x,
            crossedLocalX,
            seconds: sinceRelease,
            speed,
            missed: false,
            timing: (swingT + cross.frac * dt - SWING_IDEAL_SEC) / (SWING_ACTIVE_SEC / 2),
          };
        }
        missed = true;
        // 空振り＝この球はこのまま捕手へ（swung のまま＝`callAfterSwing` がストライクにする）
        swingT = null;
      }
    }

    const crossX = plateCrossingX(prev, next);
    if (crossX !== null) {
      // ワンバウンドした球は見逃せばボール（フェーズBBB-79。dekkaiScene.ts と同じ）
      call = judgePitch(crossX, side, stance, pitchBounces(next), opts.releaseStance);
      // 立ち位置の材料は**ストライクだった球だけ**（フェーズSS-67。main.ts と同じ規則）
      if (call === 'strike') crossedLocalX = batterFrameX(crossX, side);
    }
    if (call === 'hitByPitch') {
      return {
        call,
        swung,
        launch: null,
        contactX: 0,
        crossedLocalX,
        seconds: sinceRelease,
        speed,
        missed,
        timing: null,
      };
    }
    flight = next;
    if (swingT !== null) swingT += dt;
    if (next.z >= CATCH_Z) {
      return {
        call: call ?? 'ball',
        swung,
        launch: null,
        contactX: 0,
        crossedLocalX,
        seconds: sinceRelease,
        speed,
        missed,
        timing: null,
      };
    }
  }
  // ここへは来ない（保険）
  return {
    call: 'ball',
    swung,
    launch: null,
    contactX: 0,
    crossedLocalX,
    seconds: sinceRelease,
    speed,
    missed,
    timing: null,
  };
}

/**
 * 1打席を決着まで回す（決定的）。
 *
 * 打席の中の状態は3つだけ＝**カウント**と**直前のストライクのコース**（＝CPU打者の
 * 立ち位置の材料。O-36）と**直前のストライクの速さ**（＝CPU打者が待つ速さ。AAA-75）。
 * どれも実機と同じ経路で持つ。ぶれは `opts.noise` の系列から1球に1回引く＝
 * **系列を渡さなければ同じ対戦は必ず同じ打席になる**。
 */
export function simulateAtBat(
  pitcher: PitcherStats,
  batter: BatterStats,
  opts: AtBatOptions = {},
): AtBatResult {
  const fatigue = opts.fatigue ?? 0;
  const profile = pitchProfileOf(pitcher, fatigue);
  const control = controlOf(pitcher, fatigue);
  const arm = pitchArmOf(pitcher.throws);
  const side = opts.side ?? batterSideOf(batter, pitcher);
  const profileBatting: BattingProfile = { power: batter.power, average: batter.average };

  const noise = opts.noise ?? swingNoiseStream();
  // 内外角の系列（BBB-84）。渡さなければぶれの系列と同じ種のもの＝実機と同じ。null は旧規則
  const sideStream = opts.sides === undefined ? noise.sides : opts.sides;
  // 配球のくじの系列（CCC-86）。渡さなければぶれの系列と同じ種のもの＝実機と同じ。null は前の規則
  const mixStream = opts.mixes === undefined ? noise.mixes : opts.mixes;
  let count: Count = EMPTY_COUNT;
  let lastPitchLocalX: number | null = null;
  let expectedSpeed: number | null = null;
  let pitches = 0;
  let swings = 0;
  let fouls = 0;
  let takes = 0;
  let maxStrikes = 0;
  let maxBalls = 0;
  let misses = 0;

  for (let i = 0; i < MAX_PITCHES_PER_PA; i += 1) {
    maxStrikes = Math.max(maxStrikes, count.strikes);
    maxBalls = Math.max(maxBalls, count.balls);
    pitches += 1;
    // 投手は構える前に1球を決めている（立ち位置もここで決まる）。人間の球は形を持たない
    const first = opts.humanPitch
      ? null
      : planCpuPitch(profile, control, arm, count, {
          foulsInAtBat: fouls,
          aims: opts.aims,
          sides: sideStream ? sideStream.next() : undefined,
          mix: mixStream ? mixStream.next() : undefined,
          batterSide: side,
        });
    // 打者が待つ速さ（CCC-86）。既定は直前のストライクの速さ（CPU打者の規則）
    const waiting =
      first && opts.waitFor
        ? opts.waitFor({
            count,
            usual: usualPaceOf(profile, control, count, { foulsInAtBat: fouls, aims: opts.aims }),
            actual: first.plan.speed,
          })
        : opts.readsPace
          ? 'actual'
          : 'last';
    const waitSpeed =
      waiting === 'last' ? expectedSpeed : waiting === 'actual' ? null : speedOfPace(waiting, profile);
    const target = first ? batterFrameX(first.plan.targetX, side) : 0;
    const tell: PitchTell | null = first
      ? {
          shown: first.plan.cross ? -target : target,
          secondsToContact: flightSecondsUntil(first.flight, CONTACT_PLANE_Z),
        }
      : null;
    const stance =
      opts.stanceFor && tell ? opts.stanceFor(lastPitchLocalX, target, tell) : chooseCpuStance(lastPitchLocalX);
    // リリースの瞬間の立ち位置（投げた後に踏み込む打者だけが、届くときと違う場所にいる）
    const releaseStance =
      opts.stanceAtReleaseFor && tell ? opts.stanceAtReleaseFor(lastPitchLocalX, target, tell) : stance;
    // CPU投手は、リリースの瞬間に踏み込んでいる打者の体へ行く球を反対側へ投げる（dekkaiScene.ts と同じ）
    let planned = first;
    if (first && (opts.avoidCrowder ?? true)) {
      const plan = avoidCrowdingBatter(first.plan, side, releaseStance);
      if (plan !== first.plan) planned = shapeCpuPitch(plan, profile, arm);
    }
    const pitch = simulatePitch(
      profile,
      control,
      arm,
      count,
      profileBatting,
      side,
      stance,
      fatigue,
      {
        foulsInAtBat: fouls,
        swingWidths: opts.swingWidths,
        aims: opts.aims,
        planned: planned ?? undefined,
        releaseStance: (opts.noAwardIfSteppedIn ?? true) ? releaseStance : undefined,
        readsPace: waiting === 'actual',
        expectedSpeed: waitSpeed,
        hardTiming: opts.hardTiming,
        noise: noise.next(),
        paceStepSec: opts.paceStepSec,
        dt: opts.dt,
        legacyFrameStart: opts.legacyFrameStart,
        given: opts.humanPitch ? humanFlight(pitcher, side, opts.humanPitch(count, i)) : undefined,
        speedRule: opts.speedRule,
      },
    );
    if (pitch.missed) misses += 1;
    if (pitch.crossedLocalX !== null) lastPitchLocalX = pitch.crossedLocalX;
    // 待つ速さは「ストライクになった球」から覚え直す（振った球・見逃しストライク。main.ts と同じ）
    if (pitch.swung || pitch.call === 'strike') expectedSpeed = pitch.speed;
    if (pitch.swung) swings += 1;
    else takes += 1;

    if (pitch.launch) {
      const play = simulatePlay(pitch.launch, pitch.contactX, {
        park: opts.park ?? DEFAULT_BALLPARK,
        runnerSpeed: runnerSpeed(batter.run),
        home: opts.home,
        chase: opts.chase,
        reactionSec: opts.reactionSec,
      });
      const outcome = paOutcomeOf({ timing: 0, course: 0, result: play });
      if (outcome === null) {
        // ファウル＝カウントは2ストライクで頭打ち（バントではないので `foul`）
        fouls += 1;
        const applied = applyPitch(count, 'foul');
        // ファウルは打席を終わらせない（`applyPitch` がそう書かれている）ので必ず inProgress
        if (applied.kind === 'inProgress') count = applied.count;
        continue;
      }
      return {
        kind: 'inPlay',
        outcome,
        pitches,
        swings,
        fouls,
        takes,
        maxStrikes,
        maxBalls,
        misses,
        play,
        batted: { launch: pitch.launch, contactX: pitch.contactX, runnerSpeed: runnerSpeed(batter.run) },
      };
    }

    if (pitch.call === 'hitByPitch') {
      return { kind: 'hitByPitch', outcome: null, pitches, swings, fouls, takes, maxStrikes, maxBalls, misses };
    }
    const judgement: PitchJudgement = callAfterSwing(pitch.call ?? 'ball', pitch.swung);
    const applied = applyPitch(count, judgement);
    if (applied.kind === 'strikeout') {
      return { kind: 'strikeout', outcome: null, pitches, swings, fouls, takes, maxStrikes, maxBalls, misses };
    }
    if (applied.kind === 'walk') {
      return { kind: 'walk', outcome: null, pitches, swings, fouls, takes, maxStrikes, maxBalls, misses };
    }
    count = applied.count;
  }
  // 決着しない打席は存在しない（保険：三振として畳む）
  return { kind: 'strikeout', outcome: null, pitches, swings, fouls, takes, maxStrikes, maxBalls, misses };
}

export interface AtBatDistributionOptions {
  /** 1投手あたりの打席数（既定 10） */
  reps?: number;
  /**
   * 四球・死球の数え方。**'walk' は押し出しの進塁としてそのまま数える**（`PaDistribution.walk`。
   * フェーズBBB-84＝試合の四球・死球と同じ規則）。'out'／'single' はアウトか単打へ寄せる
   * （BBB-82 までの読み方＝得点期待の下限と上限）。既定は 'out'（下限。従来と同じ）。
   */
  walkAs?: 'out' | 'single' | 'walk';
  /** ぶれの系列の種（同じ種なら同じ分布） */
  seed?: number;
}

/**
 * **打席そのもの**（CPU投手 vs CPU打者）を回して作る打席の帰結の分布（フェーズBBB-82）。
 *
 * `runExpectancy.ts` の `distributionFor` は「当たった打球」をタイミング×コースで一様に
 * 舐めた分布で、**振るかどうか・どのタイミングで当たるか**を含まない（QQ-65 が「実際の打席とは
 * 3倍以上ずれる」と記録したもの）。野手の足を原作の 6.0m/s にした BBB-82 からは、その一様な
 * 格子では**外した当たりが野手の前に落ちる**ぶん打者の差がほとんど消える（長打力0.1の投手と
 * 0.67の控えが同じ出塁率になる）が、実際の打席では差ははっきり出る（打率 .10 と .34）。
 * **打者どうしを比べる計測（代打の利得など）はこちらを使う**。
 */
export function atBatDistribution(
  batter: BatterStats,
  pitchers: readonly PitcherStats[],
  opts: AtBatDistributionOptions = {},
): PaDistribution {
  const reps = opts.reps ?? 10;
  const walkAs = opts.walkAs ?? 'out';
  const noise = swingNoiseStream(opts.seed ?? DEFAULT_SEED);
  const dist: PaDistribution = { out: 0, single: 0, double: 0, triple: 0, homerun: 0 };
  let total = 0;
  for (const pitcher of pitchers) {
    for (let i = 0; i < reps; i += 1) {
      const result = simulateAtBat(pitcher, batter, { noise });
      total += 1;
      if (result.kind === 'inPlay') dist[result.outcome!] += 1;
      else if (result.kind === 'strikeout') dist.out += 1;
      else dist[walkAs] = (dist[walkAs] ?? 0) + 1;
    }
  }
  for (const key of Object.keys(dist) as Array<keyof PaDistribution>) dist[key] = (dist[key] ?? 0) / total;
  return dist;
}

/**
 * 人間が投げる球（まっすぐ。`AtBatOptions.humanPitch`）の飛行の始まり。**本塁で `localX` を
 * 通る**ように、リリースのXをそのまま打者から見たコースに置く（曲げない球は横に動かない）。
 */
function humanFlight(pitcher: PitcherStats, side: BatterSide, pitch: HumanPitch): PitchFlight {
  const speed = speedForPitchSelection(pitch.selection, pitcher.speed);
  return releasePitchFlight(
    batterFrameX(pitch.localX, side),
    speed,
    0,
    neutralSpeedFor(pitcher.speed),
    pitcher.fork,
  );
}
