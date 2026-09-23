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
 *   `crossesSwingDecisionPoint` / `shouldCpuSwing` / `chooseCpuStance` /
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
  RIGHT_BATTER_SIDE,
  armReleaseOffsetX,
  batterFrameX,
  createPitchFlight,
  fatiguedBreak,
  fatiguedControl,
  fatiguedSpeed,
  judgePitch,
  plateCrossingX,
  releaseXFor,
  stepPitchFlight,
} from '../../src/core/pitch';
import {
  type BattingProfile,
  callAfterSwing,
  contactPlaneCrossing,
  judgeSwing,
} from '../../src/core/batting';
import {
  chooseCpuPitchPlan,
  cpuPitcherStyle,
  cpuSteerAccelAt,
  planCpuPitchShape,
} from '../../src/core/cpuPitcher';
import {
  chooseCpuStance,
  crossesSwingDecisionPoint,
  shouldCpuSwing,
} from '../../src/core/cpuBatter';
import {
  type BatterStats,
  type PitcherStats,
  effectiveBattingHand,
  pitchArmOf,
  pitcherControl,
} from '../../src/core/roster';
import { type Ballpark, DEFAULT_BALLPARK } from '../../src/core/ballpark';
import { runnerSpeed } from '../../src/core/fielding';
import { type PlayResult, SIM_DT, simulatePlay } from './sim';
import { type PaOutcome, paOutcomeOf } from './runExpectancy';

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
  /** インプレーになったときの打球そのもの（HR判定・飛距離を見る材料） */
  play?: PlayResult;
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
  aims?: { normalTarget?: number };
  swingPenalty?: number;
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

/**
 * 1球を投げて決着させる（決定的）。
 *
 * フレームの順序は `dekkaiScene.ts` の `update()` の 'flight' 分岐に合わせてある：
 * ①`sinceRelease += dt` →②横加速（`cpuSteerAccelAt(sinceRelease - dt, dt)`）→
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
  foulsInAtBat = 0,
  swingWidths: { normal?: number; twoStrike?: number } = {},
  aims: { normalTarget?: number } = {},
  swingPenalty?: number,
): PitchOutcome {
  const plan = chooseCpuPitchPlan(count, cpuPitcherStyle(profile), control, foulsInAtBat, aims);
  const releaseOffset = armReleaseOffsetX(arm);
  const shape = planCpuPitchShape(plan, profile, undefined, releaseOffset);
  // ボールは体（plateX）から腕のぶん外れたところから出る（CC-50）。CPUはコース入力を
  // 使わない（狙いはリリース位置そのもの）ので初期横速度は0（dekkaiScene.ts の release）。
  let flight: PitchFlight = createPitchFlight(
    releaseXFor(shape.plateX, releaseOffset),
    shape.speed,
    0,
  );

  let sinceRelease = 0;
  let swingT: number | null = null;
  let swung = false;
  let call: PitchCall | null = null;
  let crossedLocalX: number | null = null;

  for (let frame = 0; frame < MAX_PITCH_FRAMES; frame += 1) {
    const dt = SIM_DT;
    sinceRelease += dt;
    const prev = flight;
    const accel = cpuSteerAccelAt(shape, sinceRelease - dt, dt);
    const next = stepPitchFlight(prev, shape.steerX, dt, accel);

    // ---- onFlightStep（main.ts）：CPU打者のスイング判断 ----
    if (
      swingT === null &&
      !swung &&
      crossesSwingDecisionPoint(prev, next, count, swingPenalty)
    ) {
      if (shouldCpuSwing(next, count, side, stance, swingWidths)) {
        swingT = 0;
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
          };
        }
        // 空振り＝この球はこのまま捕手へ（swung のまま＝`callAfterSwing` がストライクにする）
        swingT = null;
      }
    }

    const crossX = plateCrossingX(prev, next);
    if (crossX !== null) {
      call = judgePitch(crossX, side, stance);
      // 立ち位置の材料は**ストライクだった球だけ**（フェーズSS-67。main.ts と同じ規則）
      if (call === 'strike') crossedLocalX = batterFrameX(crossX, side);
    }
    if (call === 'hitByPitch') {
      return { call, swung, launch: null, contactX: 0, crossedLocalX, seconds: sinceRelease };
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
      };
    }
  }
  // ここへは来ない（保険）
  return { call: 'ball', swung, launch: null, contactX: 0, crossedLocalX, seconds: sinceRelease };
}

/**
 * 1打席を決着まで回す（決定的）。
 *
 * 打席の中の状態は2つだけ＝**カウント**と**直前の球のコース**（＝CPU打者の立ち位置の
 * 材料。O-36）。どちらも実機と同じ経路で持つので、**同じ対戦は必ず同じ打席になる**。
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

  let count: Count = EMPTY_COUNT;
  let lastPitchLocalX: number | null = null;
  let pitches = 0;
  let swings = 0;
  let fouls = 0;
  let takes = 0;
  let maxStrikes = 0;
  let maxBalls = 0;

  for (let i = 0; i < MAX_PITCHES_PER_PA; i += 1) {
    maxStrikes = Math.max(maxStrikes, count.strikes);
    maxBalls = Math.max(maxBalls, count.balls);
    pitches += 1;
    const stance = chooseCpuStance(lastPitchLocalX);
    const pitch = simulatePitch(
      profile,
      control,
      arm,
      count,
      profileBatting,
      side,
      stance,
      fatigue,
      fouls,
      opts.swingWidths ?? {},
      opts.aims ?? {},
      opts.swingPenalty,
    );
    if (pitch.crossedLocalX !== null) lastPitchLocalX = pitch.crossedLocalX;
    if (pitch.swung) swings += 1;
    else takes += 1;

    if (pitch.launch) {
      const play = simulatePlay(pitch.launch, pitch.contactX, {
        park: opts.park ?? DEFAULT_BALLPARK,
        runnerSpeed: runnerSpeed(batter.run),
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
      return { kind: 'inPlay', outcome, pitches, swings, fouls, takes, maxStrikes, maxBalls, play };
    }

    if (pitch.call === 'hitByPitch') {
      return { kind: 'hitByPitch', outcome: null, pitches, swings, fouls, takes, maxStrikes, maxBalls };
    }
    const judgement: PitchJudgement = callAfterSwing(pitch.call ?? 'ball', pitch.swung);
    const applied = applyPitch(count, judgement);
    if (applied.kind === 'strikeout') {
      return { kind: 'strikeout', outcome: null, pitches, swings, fouls, takes, maxStrikes, maxBalls };
    }
    if (applied.kind === 'walk') {
      return { kind: 'walk', outcome: null, pitches, swings, fouls, takes, maxStrikes, maxBalls };
    }
    count = applied.count;
  }
  // 決着しない打席は存在しない（保険：三振として畳む）
  return { kind: 'strikeout', outcome: null, pitches, swings, fouls, takes, maxStrikes, maxBalls };
}
