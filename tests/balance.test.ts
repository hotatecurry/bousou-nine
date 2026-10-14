/**
 * 実戦バランスの計測を**帯として固定する**（フェーズI-29）。
 *
 * `ORIGINAL_PARITY.md` の未確認事項に「何試合か遊ばないと分からない」と溜まっていた
 * 数値を `tools/balance/` のシミュレータで測り、**測った結果そのもの**をここに置く。
 * 狙いは2つ：
 *
 * 1. **回帰を止める**。打球物理・守備・スキルのどれかを触ったときに、意図せず
 *    「HRが出ない試合」や「守備範囲スキルで安打が消える試合」になっていないかを、
 *    実機を起動しなくても検出できる。
 * 2. **根拠を残す**。CLAUDE.md ⑧の「判定は決定的」という方針のおかげで、ここの
 *    数字は何度回しても同じ値になる＝**調整の前後で比べられる**。
 *
 * **値そのものではなく帯と大小関係で書く**：厳密な等値で固定すると、無関係な定数を
 * 1つ動かすたびに落ちて「テストを直すためにテストを書き換える」になる。ここが守るのは
 * 「どちらが大きいか」「どのくらいの範囲か」という設計の意図のほう。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BALLPARKS, DEFAULT_BALLPARK, type Ballpark } from '../src/core/ballpark';
import {
  EXIT_PITCH_CARRY,
  EXIT_POWER_BONUS,
  EXIT_SPEED_BASE,
  SWING_ACTIVE_SEC,
  SWING_IDEAL_SEC,
  createBattedBall,
  stepBattedBall,
  SWING_STARTUP_SEC,
  judgeBunt,
  judgeSwing,
} from '../src/core/batting';
import { HOT_MODIFIER } from '../src/core/condition';
import {
  CPU_PINCH_HIT_GAP,
  CPU_PINCH_RUN_BAT_LOSS,
  CPU_SWING_SIGMA_SEC,
  CPU_TIMING_PENALTY_SEC,
  SELECTIVE_HALF_WIDTH,
  chooseCpuStance,
  cpuSwingLead,
  cpuTimingScale,
} from '../src/core/cpuBatter';
import {
  BASE_PATH,
  BASE_POSITIONS,
  BIKE_SPEED_SCALE,
  CONTROLLABLE_FIELDERS,
  CPU_STEAL_MAX_DEFENSE_SLACK_SEC,
  CPU_TAG_UP_MARGIN_SEC,
  CPU_TAG_UP_MIN_DEPTH,
  FIELDER_HOME_POSITIONS,
  FIELDER_SPEED,
  PICKUP_RELEASE_SEC,
  MAX_LEAD,
  RUNNER_SPEED,
  RUNNER_SPEED_MAX,
  RUNNER_SPEED_MIN,
  STEAL_CATCH_RELEASE_SEC,
  STEAL_LEAD,
  THROW_SPEED,
  chooseCpuSteals,
  chooseCpuTagUp,
  cpuExtraBaseSlack,
  cpuLeadDistance,
  cpuStealDefenseSlack,
  cpuTagUpDefenseSlack,
  distance,
  nearestFielder,
  pickoffOutLead,
  predictLandingAt,
  runnerSpeed,
  type FielderId,
  type Vec2,
} from '../src/core/fielding';
import {
  CPU_INTENTIONAL_WALK_POWER_THRESHOLD,
  CPU_RELIEF_QUALITY_MARGIN,
  CORNER_MARGIN,
  NORMAL_TARGET_X,
  chooseCpuPitchPlan,
  chooseCpuRelief,
  cpuPitcherStyle,
  planCpuPitchShape,
  shouldCpuIntentionalWalk,
} from '../src/core/cpuPitcher';
import {
  ARM_SLOT_RAD,
  BREAK_STRENGTH,
  BATTER_STANCE_RANGE,
  LEFT_BATTER_SIDE,
  NEUTRAL_RATING,
  PLATE_Z,
  RELEASE_Z,
  RIGHT_BATTER_SIDE,
  SPEED_FAST,
  SPEED_NEUTRAL,
  SPEED_SLOW,
  STRIKE_ZONE_HALF_WIDTH,
  armReleaseOffsetX,
  courseReleaseVxFor,
  fatiguedBreak,
  fatiguedControl,
  fatiguedSpeed,
  judgePitch,
  neutralSpeedFor,
  speedForPitchSelection,
} from '../src/core/pitch';
import {
  type PitcherStats,
  createTeamRoster,
  eraWithControl,
  fatigueFromRemaining,
  grantSkill,
  maxPitchesFor,
  pitchArmOf,
  pitcherControl,
  pitcherQuality,
  pitcherRole,
  pitcherStuff,
  ratingBar,
  RATING_TICKS,
  skillHoldersOf,
  staffPlayerId,
  staminaRemaining,
  withCarriedFatigue,
} from '../src/core/roster';
import { createRngState } from '../src/core/rng';
import {
  DRAFTS_PER_GAME,
  REST_RECOVERY,
  RUN_GAMES,
  gameSeed,
  restedPitchCounts,
} from '../src/core/run';
import {
  type SkillHolder,
  type SkillId,
  DUO_SKILL_IDS,
  REROLLS_PER_RUN,
  SKILLS,
  activeLineagesFor,
  canGrant,
  cpuChooseSkill,
  drawSkillDraft,
  shouldCpuReroll,
} from '../src/core/skills';
import {
  TEAMS,
  teamById,
  benchRowStats,
  fielderRowStats,
  pitcherRowBatting,
  pitcherRowPitching,
} from '../src/core/teams';
import { PICKUP_THROW_DELAY_SEC, simulatePlay } from '../tools/balance/sim';
import {
  type AtBatOptions,
  type AtBatResult,
  atBatDistribution,
  simulateAtBat,
  swingNoiseStream,
} from '../tools/balance/atbat';
import {
  type SweepSummary,
  crossXFor,
  summarize,
  sweep,
  swingTimeFor,
} from '../tools/balance/sweep';
import {
  battleValue,
  distributionFor,
  paScoreProb,
  solveLineup,
  solveRunExpectancy,
  solveScoreProbability,
  walkValue,
} from '../tools/balance/runExpectancy';

/** テストは粗めの格子で回す（帯を見るには十分で、全体を1秒以内に保てる） */
// このファイルは同期の重い計測が続く（全体で1分半）。テストの合間にイベントループを1周
// させないと、ワーカーが進み具合を親へ報告できないまま60秒を越えて
// 「[vitest-worker]: Timeout calling "onTaskUpdate"」で落ちる（テストは全部通っているのに
// `npm test` が失敗する。フェーズBBB-83で計測が重くなって表に出た）。
afterEach(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

const STEPS = 6;
/**
 * 打者・走者・球速どうしの**小さな差**を比べる帯で使う細かい格子（フェーズBBB-83）。
 * `STEPS` の粗い格子（169点）では、境目の打球が1〜2本入れ替わるだけで大小が裏返る
 * （CPU守備を先回りにした BBB-83 で、好調・走力・敬遠・配球の費用の4つが同時に裏返った。
 * 441点で測れば4つとも元の向きのまま＝崩れたのは格子の粗さのほう）。
 */
const FINE_STEPS = 10;

const hitter = (power: number, average = 0.5) => ({ power, average });

/** 同じ条件を何度も測るのでまとめる */
function measure(opts: {
  park?: Ballpark;
  power: number;
  average?: number;
  pitchSpeed?: number;
  /** その球を投げた投手の基準速（投手ごとの球速で `pitchSpeed` を決めたときに渡す。BBB-85） */
  pitcherNeutral?: number;
  catchBonus?: (id: FielderId) => number;
  runnerSpeed?: number;
  /** 格子の細かさ（既定 `STEPS`。小さな差を比べる帯は `FINE_STEPS`） */
  steps?: number;
}): SweepSummary {
  return summarize(
    sweep({
      park: opts.park ?? DEFAULT_BALLPARK,
      batter: hitter(opts.power, opts.average),
      pitchSpeed: opts.pitchSpeed,
      pitcherNeutral: opts.pitcherNeutral,
      catchBonus: opts.catchBonus,
      runnerSpeed: opts.runnerSpeed,
      steps: opts.steps ?? STEPS,
    }),
  );
}

const parkNamed = (name: string): Ballpark => BALLPARKS.find((p) => p.name === name)!;

describe('打球の帰結：長打力・球速・球場（C-14の未確認事項「実寸フェンスでHRが減った分の調整」）', () => {
  it('本塁打率は長打力について単調に増える（能力値がそのまま長打に出る）', () => {
    const rates = [0, 0.25, 0.5, 0.75, 1].map((p) => measure({ power: p }).homerunRate);
    for (let i = 1; i < rates.length; i += 1) {
      expect(rates[i]).toBeGreaterThanOrEqual(rates[i - 1]);
    }
    // 長打力0では柵を越えられず、最大なら明確に越える＝能力値の幅が帰結の幅になっている
    // （フェーズJJ-57で空気抵抗が入り、最大の値は 15% → 8.5% に下がった。**HRが減った
    // こと自体が狙い**なので、ここが守るのは「0 と明確に違う」ことのほう）
    expect(rates[0]).toBe(0);
    expect(rates[rates.length - 1]).toBeGreaterThan(0.05);
  });

  it('球場の広さの順に本塁打率が並ぶ（説明書p24-25の紹介文と一致する）', () => {
    // ここだけ格子を細かくする：ふえいふえいの「高いレフトフェンス」は方角 -40°〜-12°
    // の区間だけの例外なので、粗い格子ではその区間を跨いでしまい差が出ない。
    //
    // **速球で見る**（フェーズRR-66）：長打力の幅を6→10m/sへ広げ抗力を上げたので、
    // **基準速では長打力0.75でもほとんど柵に届かなくなった**（0.94%＝球場の差が
    // 出る前に0で並ぶ）。球場の差が見えるのは「届く球」＝速球のとき。
    const hr = (name: string) =>
      summarize(
        sweep({ park: parkNamed(name), batter: hitter(0.75), steps: 10, pitchSpeed: SPEED_FAST }),
      ).homerunRate;
    // かせんじき（110m「とにかく狭い」）＞ ところざわ（120m「最も平均的」）
    //   ＞ どうむ（122m「トップクラスの広さ」）＞ だいそうげん（130m「とてつもなく広い」）
    expect(hr('かせんじき')).toBeGreaterThan(hr('ところざわ'));
    expect(hr('ところざわ')).toBeGreaterThan(hr('どうむ'));
    expect(hr('どうむ')).toBeGreaterThan(hr('だいそうげん'));
    // たからづか（ラッキーゾーン＝両翼の柵が低い）は同じ広さの球場より越えやすい
    expect(hr('たからづか')).toBeGreaterThan(hr('ところざわ'));
    // ふえいふえい（レフトフェンス10m）は距離が近いのに越えにくい＝**同じ枠で見られる**
    // （RR-66で速球に揃えたので、QQ-65 が長打力1.0だけ別枠で測っていた必要が無くなった）。
    expect(parkNamed('ふえいふえい').center).toBe(parkNamed('ところざわ').center);
    expect(hr('ふえいふえい')).toBeLessThan(hr('ところざわ'));
    // 6球場ぶんの細かい格子で既定の5秒に迫る（実測3〜4秒）。**判定は何も変えず**、
    // 他の作業と同時に走らせたときの時間切れ（O-36の検証中に観測）だけを避ける。
  }, 20000);

  it('速球のほうが打たれたときのリスクが大きい（EXIT_PITCH_CARRY の狙い）', () => {
    const neutral = measure({ power: 0.5, pitchSpeed: SPEED_NEUTRAL });
    const fast = measure({ power: 0.5, pitchSpeed: SPEED_FAST });
    expect(fast.homerunRate).toBeGreaterThan(neutral.homerunRate);
  });

  it('CPU打者は初球の速球を芯では捉えない（過去に潰した「CPUの速球HR連発」の回帰防止）', () => {
    // 「CPUの速球HR連発」は、CPU打者が**どの球でも芯（t=0）で振っていた**ことが原因だった。
    // フェーズAAA-75以降、CPU打者は**直前のストライクの速さ**に合わせる＝**初球は投手の
    // 基準速を待っている**ので、初球の速球は緩急1段ぶん差し込まれる（ここはぶれ無しの狙い。
    // ぶれ込みの分布は `npm run balance:plate` の2・3段目）。
    // 緩急のずれは投手の球速の比で大きくなる（BBB-85。`cpuTimingScale`）
    const firstPitch = (spd: number) =>
      cpuSwingLead(
        speedForPitchSelection(-1, spd),
        neutralSpeedFor(spd),
        null,
        0,
        undefined,
        cpuTimingScale(neutralSpeedFor(spd)),
      );
    const repeated = (spd: number) =>
      cpuSwingLead(speedForPitchSelection(-1, spd), neutralSpeedFor(spd), speedForPitchSelection(-1, spd));
    /** 実際に投げた球＝投げた投手の基準速を持つ（打球に乗るのは緩急ぶんだけ。BBB-85） */
    const hrOf = (lead: number, spd: number, batter: { power: number; average: number }) => {
      const launch = judgeSwing(
        {
          crossX: 0,
          swingTime: lead,
          pitchSpeed: speedForPitchSelection(-1, spd),
          pitcherNeutral: neutralSpeedFor(spd),
        },
        batter,
      );
      if (!launch) return { homerun: false, directionDeg: 0 };
      const play = simulatePlay(launch, 0, { park: DEFAULT_BALLPARK });
      return { homerun: play.outcome.kind === 'homerun', directionDeg: play.directionDeg };
    };
    // 名鑑でいちばん速い投手の速球でも、初球なら平均的な打者は越えられない
    const fastest = 0.96;
    expect(hrOf(firstPitch(fastest), fastest, hitter(0.5)).homerun).toBe(false);
    expect(hrOf(firstPitch(0.5), 0.5, hitter(0.5)).homerun).toBe(false);
    // 差し込まれた打球は逆方向（右打者なら右翼側＝+X）へ飛ぶ
    expect(hrOf(firstPitch(0.5), 0.5, hitter(0.5)).directionDeg).toBeGreaterThan(20);
    // **同じ速球を続けた2球目は芯**＝強打者なら越える（緩急を付けない投手への罰）。
    // 誰の速球でも同じだけ飛ぶ（BBB-85：投手の球速は打球の強さに乗らない）
    for (const spd of [0.35, fastest]) {
      expect(hrOf(repeated(spd), spd, hitter(0.8, 0.7)).homerun).toBe(true);
    }
  });

  it('芯（タイミング0・コース0）の打球はタイミングの減衰に一切依存しない（QQ-65の不変条件）', () => {
    // `TIMING_SPEED_PENALTY` は |timing| に比例して掛かるので、**芯で捉えた打球の初速は
    // その値をどう動かしても変わらない**。QQ-65 で 0.30→0.35 に上げられたのはこの性質が
    // あったからで（I-29の「芯の帰結」もJJ-57の抗力の帯も動かさずに、外した打球だけを
    // 弱められる）、ここが崩れたら同じ触り方はもうできない。
    for (const pitchSpeed of [SPEED_SLOW, SPEED_NEUTRAL, SPEED_FAST]) {
      for (const power of [0, 0.5, 1]) {
        const launch = judgeSwing(
          { crossX: 0, swingTime: SWING_IDEAL_SEC, pitchSpeed },
          hitter(power, 0),
        );
        expect(launch).not.toBeNull();
        const exit = Math.hypot(launch!.vx, launch!.vy, launch!.vz);
        expect(exit).toBeCloseTo(
          EXIT_SPEED_BASE + EXIT_PITCH_CARRY * pitchSpeed + EXIT_POWER_BONUS * power,
          6,
        );
      }
    }
  });

  it('CPU打者は待っていた速さの球ならジャストミートする（初球は投手の基準速）', () => {
    const timingOf = (lead: number) => (lead - SWING_IDEAL_SEC) / (SWING_ACTIVE_SEC / 2);
    expect(timingOf(cpuSwingLead(SPEED_NEUTRAL, SPEED_NEUTRAL))).toBeCloseTo(0);
    expect(timingOf(cpuSwingLead(SPEED_FAST, SPEED_NEUTRAL, SPEED_FAST))).toBeCloseTo(0);
    expect(timingOf(cpuSwingLead(SPEED_SLOW, SPEED_NEUTRAL, SPEED_SLOW))).toBeCloseTo(0);
  });
});

describe('好調＝ゼッコーチョー／ラッキー7（D-19の未確認事項「+0.2 という幅が妥当か」）', () => {
  it('好調の打者は本塁打も安打も明確に増える（「今日はこの打者が来ている」が分かる幅）', () => {
    const plain = measure({ power: 0.5, average: 0.5, steps: FINE_STEPS });
    const hot = measure({
      power: 0.5 + (HOT_MODIFIER.power ?? 0),
      average: 0.5 + (HOT_MODIFIER.average ?? 0),
      steps: FINE_STEPS,
    });
    expect(hot.homerunRate).toBeGreaterThan(plain.homerunRate);
    expect(hot.hitRate).toBeGreaterThan(plain.hitRate);
  }, 20000);

  it('好調でも「長打力の高い打者」を超えはしない（補正であって別物にはならない）', () => {
    const hot = measure({
      power: 0.5 + (HOT_MODIFIER.power ?? 0),
      average: 0.5 + (HOT_MODIFIER.average ?? 0),
    });
    const slugger = measure({ power: 1, average: 1 });
    expect(hot.homerunRate).toBeLessThanOrEqual(slugger.homerunRate);
  });
});

describe('守備範囲スキル（F-26-7の未確認事項「内野の間を抜ける打球が消えていないか」）', () => {
  it('1人に最大まで重ねても安打率はわずかしか下がらない（スキルは選手に付くため）', () => {
    const base = measure({ power: 0.5 });
    // 素の捕球半径 2.6m が 6.9m になる＝ドウブツ系統を重ねられるだけ重ねた最悪の場合
    const boosted = measure({ power: 0.5, catchBonus: (id) => (id === 'SS' ? 4.3 : 0) });
    expect(boosted.hitRate).toBeLessThanOrEqual(base.hitRate);
    // **抜ける打球が消えない**：1人ぶんでは 5ポイント以上は削れない
    expect(base.hitRate - boosted.hitRate).toBeLessThan(0.05);
  });

  it('全員に配れば効きは大きくなる（＝効いていないわけではない）', () => {
    const base = measure({ power: 0.5 });
    const all = measure({ power: 0.5, catchBonus: () => 4.3 });
    // **安打の半分以上が消える**。BBB-79 でファウルフライも捕れるようになり、捕られた
    // ファウルフライが分母（インプレー）に入ったので、差を「何ポイント」で測ると分母の
    // 変化に引きずられる（安打は 9→3本で変わらないのに 5.x→4.7ポイントになった）。
    // 割合で見れば分母に左右されない。
    expect(all.hitRate).toBeLessThan(base.hitRate * 0.5);
  });
});

describe('走力とバイク（B-8の設計不変条件とF-26-3の未確認事項）', () => {
  it('走力が上がるほど内野安打が増える（RUNが全走者に効いている）', () => {
    const slow = measure({ power: 0.5, runnerSpeed: RUNNER_SPEED_MIN, steps: FINE_STEPS });
    const mid = measure({ power: 0.5, runnerSpeed: RUNNER_SPEED, steps: FINE_STEPS });
    const fast = measure({ power: 0.5, runnerSpeed: RUNNER_SPEED_MAX, steps: FINE_STEPS });
    expect(mid.beatThrow).toBeGreaterThanOrEqual(slow.beatThrow);
    expect(fast.beatThrow).toBeGreaterThan(mid.beatThrow);
  }, 20000);

  it('バイクの2倍速はゴロを実際に内野安打へ変える（乗る価値がある）', () => {
    const walk = measure({ power: 0.5, runnerSpeed: RUNNER_SPEED });
    const bike = measure({ power: 0.5, runnerSpeed: RUNNER_SPEED * BIKE_SPEED_SCALE });
    expect(bike.beatThrow).toBeGreaterThan(walk.beatThrow);
    expect(bike.groundout).toBeLessThan(walk.groundout);
  });
});

describe('打席内の立ち位置（O-36。`npm run balance:stance` で測った帯）', () => {
  /**
   * ある立ち位置で、あるコースへ来た球をタイミング全域で振ったときの安打率。
   *
   * **格子は STEPS より細かい 12分割**（フェーズRR-66）：バットの到達範囲を
   * 描かれたバットに合わせて狭めた（1.40→1.27m）ぶん**隅の帯そのものが細くなった**ので、
   * 粗い格子だと「中央でも内角の安打率が0」に丸まって差が見えない（実測は 4.2%）。
   */
  const STANCE_STEPS = 12;
  function hitRateAt(stance: number, localX: number): number | null {
    let hits = 0;
    let total = 0;
    for (let i = -STANCE_STEPS; i <= STANCE_STEPS; i += 1) {
      const launch = judgeSwing(
        {
          crossX: localX,
          swingTime: SWING_IDEAL_SEC + (i / STANCE_STEPS) * (SWING_ACTIVE_SEC / 2),
          pitchSpeed: SPEED_NEUTRAL,
        },
        hitter(0.5),
        1,
        0,
        stance,
      );
      if (!launch) continue;
      const outcome = simulatePlay(launch, localX, { park: DEFAULT_BALLPARK }).outcome;
      total += 1;
      if (
        outcome.kind === 'hit' ||
        outcome.kind === 'homerun' ||
        outcome.kind === 'groundRuleDouble' ||
        outcome.kind === 'beatThrow'
      ) {
        hits += 1;
      }
    }
    return total === 0 ? null : hits / total;
  }

  it('寄れば外角寄りの球が打てるようになる（リターンが実際にある）', () => {
    // **フェーズBBB-77で外角いっぱい（-0.45）から外角寄り（-0.2）へ見る場所を移した**：
    // フェンス手前の見えない壁（野手は本塁から98mより奥へ行けなかった）を外したら、外角
    // いっぱいの打球（逆方向への大飛球）は**どの立ち位置でも捕られる**ようになった（0%）。
    // 寄れば芯が外へ動く、という形そのものは外角寄りでそのまま出る（中央 0% → 寄る 8%）。
    // **フェーズBBB-82で見る場所を -0.3 へ**：野手の足を原作の 6.0m/s にしたら、-0.2 は中央でも
    // 寄っても同じ帯（47%）に入った。その1つ外（-0.3）は 中央 16% → 寄る 47%、外角いっぱい
    // （-0.45）も 中央 0% → 寄る 11% と、寄るリターンがそのまま出る。
    for (const outer of [-0.3, -0.45]) {
      expect(hitRateAt(-BATTER_STANCE_RANGE, outer)!).toBeGreaterThan(hitRateAt(0, outer)!);
    }
  });

  it('寄れば内角寄りの球は打てなくなる（同じ操作の上に代償がある）', () => {
    // **フェーズBBB-82で見る場所を内角寄り（+0.15）へ**：野手の足を原作の 6.0m/s にしたら、
    // 内角いっぱい（+0.45）は「詰まった当たりが野手の前に落ちる」ので、寄ったほうがかえって
    // 安打になる（中央 22% → 寄る 37%。どれも単打）。代償が出るのはその内側＝中央なら
    // いちばん打てる内角寄り（71%）が、寄ると詰まって 24% まで落ちる。
    const inside = 0.15;
    expect(hitRateAt(-BATTER_STANCE_RANGE, inside)!).toBeLessThan(hitRateAt(0, inside)! * 0.6);
  });

  it('どこに立っても支配的にはならない（ゾーン全体では中央との差が5pt未満か、中央より悪い）', () => {
    // 立ち位置は「読みが当たれば得、外れれば損」＝一様なコース分布ではどこも得をしないのが正しい。
    // これが崩れると「常に寄る」が正解になり、選択そのものが消える。
    // **コースの格子を17点に細かくする**（フェーズRR-66）：9点だと丸めの粗さで
    // 中央と寄りが 14.8% vs 15.7% と逆転して見えることがある。
    // **フェーズBBB-77（フェンス手前の見えない壁を外した）で「中央が最良」から「寄ると中央が
    // ほぼ同率」へ動いた**（寄る 9.2〜9.8% / 中央 8.7〜9.5% / 離れる 7.5〜8.2%。格子の細かさで
    // 前後する）＝寄るのは得にも損にもならない。帯は「中央を1pt以上上回る立ち位置が無い」。
    const zoneAverage = (stance: number): number => {
      let sum = 0;
      let n = 0;
      for (let i = -8; i <= 8; i += 1) {
        const rate = hitRateAt(stance, (i / 8) * 0.45);
        if (rate === null) continue;
        sum += rate;
        n += 1;
      }
      return sum / n;
    };
    // **フェーズBBB-82（野手の足を原作の 6.0m/s に）で、寄るほうが安打率で3pt前後高くなった**
    // （寄る 35.7% / 中央 32.1% / 離れる 31.4%）＝詰まった当たりが遅い野手の前に落ちるぶん。
    // ただし増えるのは単打で、**1打球あたりの塁打は 0.545 / 0.525 / 0.528 とほぼ同じ**＝
    // 支配的と言える差ではない。帯は「中央を5pt以上上回る立ち位置が無い」。
    const center = zoneAverage(0);
    expect(zoneAverage(-BATTER_STANCE_RANGE) - center).toBeLessThan(0.05);
    expect(zoneAverage(BATTER_STANCE_RANGE) - center).toBeLessThan(0.05);
  }, 20000);

  it('CPU打者には「配球を散らす」が有効になる（同じコースへ続けると狙われる）', () => {
    // CPUは直前の球のコースへ芯を合わせる（chooseCpuStance）ので、
    // **同じコースへ続けて投げた球**と**逆へ投げた球**で帰結が分かれる。
    let same = 0;
    let opposite = 0;
    let n = 0;
    for (const first of [-0.45, -0.3, -0.15, 0.15, 0.3, 0.45]) {
      const stance = chooseCpuStance(first);
      const a = hitRateAt(stance, first);
      const b = hitRateAt(stance, -first);
      if (a === null || b === null) continue;
      same += a;
      opposite += b;
      n += 1;
    }
    expect(same / n).toBeGreaterThan(opposite / n);
  });
});

describe('CPU投手の変化球（P-37。`npm run balance:cpubreak` で測った帯）', () => {
  const forkPlan = chooseCpuPitchPlan({ balls: 0, strikes: 1 }); // 遅い球＝Fを使う
  const fastPlan = chooseCpuPitchPlan({ balls: 0, strikes: 0 });
  const profiles = TEAMS.flatMap((t) =>
    t.pitchers.map((r) => {
      const s = pitcherRowPitching(r);
      return { speed: s.speed, breakLeft: s.breakLeft, breakRight: s.breakRight, fork: s.fork };
    }),
  );
  const widths = (plan: ReturnType<typeof chooseCpuPitchPlan>) =>
    profiles.map((p) => planCpuPitchShape(plan, p).breakWidth);

  it('名鑑96人の曲がりはゾーン半幅の「1〜2倍 × BREAK_STRENGTH」に収まる（見えるが荒唐無稽ではない）', () => {
    // P-37 の実測：フォーク 0.48〜0.89m ／ 速球 0.25〜0.44m（ゾーン半幅 0.45m）。
    // **BBB-77 で曲がり全体を3割にした**（「球があまりにも左右に曲がりやすすぎる」→ 自分の球も
    // CPUの球も3割、ユーザー判断）ので、いまは フォーク 0.14〜0.27m ／ 速球 0.07〜0.13m。
    // 帯も同じ割合で縮める（名鑑の変化量どうしの比は変わらない）。
    const fork = widths(forkPlan);
    expect(Math.min(...fork)).toBeGreaterThan(STRIKE_ZONE_HALF_WIDTH * 0.8 * BREAK_STRENGTH);
    expect(Math.max(...fork)).toBeLessThan(STRIKE_ZONE_HALF_WIDTH * 2.5 * BREAK_STRENGTH);
  });

  it('遅い球ほど大きく曲がる（横移動は飛行時間の2乗で効く＝O-35の計測どおり）', () => {
    const fork = widths(forkPlan);
    const fast = widths(fastPlan);
    for (let i = 0; i < profiles.length; i += 1) expect(fork[i]).toBeGreaterThan(fast[i]);
  });

  it('BBB-77で3割にした代償：速球の曲がりは打席内の可動幅より小さい（投げる前の手がかりが P-37 より読める）', () => {
    // P-37より前はリリース位置＝本塁通過位置だった＝打者は投げる前に答えを見ていた。
    // P-37 は曲がり幅を「嘘の量」と見て、打者が寄れる幅より大きい（＝立ち位置だけを見て構えても
    // 外れる）ことを条件にしていた。**BBB-77（曲がり3割。ユーザー判断）でこれは速球について
    // 成り立たなくなった**＝投手の立ち位置からコースが P-37 のときより読める。
    // **狙うコースは1つも変わっていない**（P-37 の逆算）ので、I-29 以来の打たれ方は動かない。
    // フォークはまだ半分近くの投手で可動幅を越える（緩い球ほど大きく曲がる）。
    for (const w of widths(fastPlan)) expect(w).toBeLessThan(BATTER_STANCE_RANGE);
    expect(Math.max(...widths(forkPlan))).toBeGreaterThan(BATTER_STANCE_RANGE);
  });
});

describe('敬遠（Q-38。`npm run balance:walk` で測った帯）', () => {
  // 得点期待の土台は計測ツールと同じものを使う（`tools/balance/runExpectancy.ts`）。
  // テストは粗い格子で回すので絶対値はツールの出力と一致しないが、
  // **ここが守るのは大小関係のほう**（このファイル全体の方針）。打者どうしの差は小さいので
  // `FINE_STEPS` で測る（`STEPS` では長打力 0.5 と 0.75 の損得が 0.003点差で裏返る）。
  const distMemo = new Map<number, ReturnType<typeof distributionFor>>();
  const dist = (power: number) => {
    // 同じ打者の分布を何度も引くので使い回す（決定的＝同じ値）
    let d = distMemo.get(power);
    if (!d) {
      d = distributionFor(power, { steps: FINE_STEPS });
      distMemo.set(power, d);
    }
    return d;
  };
  const average = dist(0.5);
  const table = solveRunExpectancy(average);
  /** 「勝負したときの失点期待 − 敬遠したときの失点期待」。正なら敬遠が得 */
  const gain = (power: number, outs: number, state: number, next = average) =>
    battleValue(dist(power), outs, state, table) - walkValue(next, outs, state, table);

  const SECOND_ONLY = 2;
  const SECOND_AND_THIRD = 6;
  const LOADED = 7;
  const EMPTY = 0;

  it('得点期待は「走者が多いほど・アウトが少ないほど」大きい（土台の妥当性）', () => {
    expect(table[0][EMPTY]).toBeGreaterThan(table[1][EMPTY]);
    expect(table[1][EMPTY]).toBeGreaterThan(table[2][EMPTY]);
    expect(table[0][LOADED]).toBeGreaterThan(table[0][SECOND_ONLY]);
    expect(table[0][SECOND_ONLY]).toBeGreaterThan(table[0][EMPTY]);
  });

  it('満塁の敬遠は必ず損（押し出しで1点献上する）', () => {
    for (const outs of [0, 1, 2]) {
      for (const power of [0.5, 0.75, 1]) expect(gain(power, outs, LOADED)).toBeLessThan(0);
    }
  });

  // BBB-77（フェンス手前の見えない壁を外した）から BBB-81 までは、一様な格子の打線がほとんど
  // 点を取れず、この帯は誤差に埋もれて崩れていた（`it.fails`）。**野手の足を原作の 6.0m/s に
  // した BBB-82 で攻撃が戻り、そのまま通るようになった。**
  it('走者なしの敬遠は損（1本で点が入らないので歩かせる値打ちが無い）', () => {
    // CPUの規則が「得点圏に走者がいること」を求める根拠。
    expect(gain(CPU_INTENTIONAL_WALK_POWER_THRESHOLD, 1, EMPTY)).toBeLessThan(0);
  });

  it('得点圏の強打者はしきい値の側で得になる（規則の境界が計測と合っている）', () => {
    // 二・三塁1死＝敬遠の代表的な場面。**しきい値の打者は平均打者よりはっきり得の側**。
    // ここを絶対値（>0）で書かないのは、このテストが粗い格子（STEPS）で回すぶん
    // ツールより悲観的に出るから（このファイルの方針＝守るのは大小関係）。
    // 絶対値の境界（0.80で+0.03点／0.75で-0.01点）は `balance:walk` の3・5段目が持つ。
    expect(gain(CPU_INTENTIONAL_WALK_POWER_THRESHOLD, 1, SECOND_AND_THIRD)).toBeGreaterThan(
      gain(0.5, 1, SECOND_AND_THIRD),
    );
    expect(gain(0.5, 1, SECOND_AND_THIRD)).toBeLessThan(0);
  });

  it('強い打者ほど歩かせる値打ちが大きい（単調）', () => {
    const weak = gain(0.5, 1, SECOND_AND_THIRD);
    const mid = gain(0.75, 1, SECOND_AND_THIRD);
    const strong = gain(1, 1, SECOND_AND_THIRD);
    expect(mid).toBeGreaterThan(weak);
    expect(strong).toBeGreaterThan(mid);
  });

  it('次打者が強いほど歩かせる値打ちが小さい（能力差を要求する根拠）', () => {
    const state = SECOND_AND_THIRD;
    const vsWeak = gain(1, 1, state, dist(0.25));
    const vsStrong = gain(1, 1, state, dist(1));
    expect(vsWeak).toBeGreaterThan(vsStrong);
    // 次打者が同じ強さなら、避ける意味が無い＝損
    expect(vsStrong).toBeLessThan(0);
  });

  it('CPUの規則は名鑑16球団で発火するが、濫用にはならない', () => {
    // 規則が一度も成立しなければ死んだコード、常に成立すれば毎打席歩かせることになる。
    // **フェーズJJ-57で敬遠は明確に「まれな采配」になった**：空気抵抗で長打が減り、
    // 塁を1つ与える値打ちが下がったのでしきい値が 0.70→0.80 に上がり、この場面
    // （二塁のみ＝いちばん条件の厳しい得点圏）で成立するのは 13打順 → 5打順。
    const lineups = TEAMS.map((team) => [
      ...team.lineup.map((r) => fielderRowStats(r).power),
      pitcherRowBatting(team.pitchers[0]).power,
    ]);
    const count = (bonus: number) =>
      lineups.reduce(
        (sum, powers) =>
          sum +
          powers.filter((power, i) =>
            shouldCpuIntentionalWalk({
              bases: { first: false, second: true, third: false },
              batterPower: power + bonus,
              nextBatterPower: powers[(i + 1) % powers.length],
            }),
          ).length,
        0,
      );
    const plain = count(0);
    const hot = count(HOT_MODIFIER.power ?? 0);
    expect(plain).toBeGreaterThanOrEqual(3);
    expect(plain).toBeLessThanOrEqual(30);
    // 好調（D-19）は銃と同じく「歩かされやすくなる」側に効く
    expect(hot).toBeGreaterThan(plain);
    expect(hot).toBeLessThan(lineups.length * 9);
  });
});

describe('CPUの采配と球団の個性（R-39。`npm run balance:lineup` で測った帯）', () => {
  // 打線は同じ打者を9回並べるので、能力値の組ごとに1回だけ測る（sweepは重い）
  const cache = new Map<string, ReturnType<typeof distributionFor>>();
  const dist = (s: { average: number; power: number; run: number }) => {
    const key = `${s.average}/${s.power}/${s.run}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const d = distributionFor(s.power, { average: s.average, run: s.run, steps: STEPS });
    cache.set(key, d);
    return d;
  };
  const AVERAGE = { average: 0.5, power: 0.5, run: 0.5 };
  const STRONG = { average: 0.75, power: 0.85, run: 0.5 };
  const WEAK = { average: 0.18, power: 0.1, run: 0.36 };
  /** その打順にだけ `stats` を置いた打線の1試合の得点期待 */
  const runsWithAt = (slot: number, stats: typeof AVERAGE) =>
    solveLineup(Array.from({ length: 9 }, (_, i) => dist(i === slot ? stats : AVERAGE))).runs;

  // ---- 打順：CPUに規則を持たせなかった根拠（触っても試合が動かない） ----

  it('打順が進むほど1試合の打席数は減る（打順の値打ちの出どころ）', () => {
    const pa = solveLineup(Array.from({ length: 9 }, () => dist(AVERAGE))).pa;
    for (let i = 1; i < pa.length; i += 1) expect(pa[i]).toBeLessThan(pa[i - 1]);
    // 1番と9番の差は1打席に満たない＝打順を触って得られる幅はこの程度しかない
    expect(pa[0] - pa[8]).toBeLessThan(1);
  });

  // BBB-79 では崩れていた（`it.fails`）。野手の足を原作の 6.0m/s にした BBB-82 で攻撃が戻り、
  // 上位4つの差 0.01点・1番と9番の差 0.04〜0.07点（格子の細かさで前後する）に戻った。
  it('強打者をどの打順に置いても得点期待はほとんど動かない（上位4つは横並び）', () => {
    const top = [0, 1, 2, 3].map((slot) => runsWithAt(slot, STRONG));
    const spread = Math.max(...top) - Math.min(...top);
    // 1〜4番のあいだの差は下位に落とす損（9番）よりずっと小さい
    expect(spread).toBeLessThan(0.05);
    expect(runsWithAt(0, STRONG) - runsWithAt(8, STRONG)).toBeGreaterThan(spread * 2);
  });

  it('最弱の打者（投手）をどの打順に置いても得点期待はほとんど動かない＝9番固定で損をしない', () => {
    // **フェーズBBB-82（野手の足を原作の 6.0m/s に）で「9番が最良」から「どこでもほぼ同じ」へ**。
    // 一様な格子では、長打力の無い打者の外した当たりが遅い野手の前に落ちて**出塁だけはする**
    // （投手：単打 19%・二塁打以上 12%／平均の打者：単打 14%・二塁打以上 15%）ので、打席の多い
    // 上位へ置いても損がほとんど出ない。打順による差は 0.005〜0.03点（格子の細かさで最良の
    // 打順が 9番にも1番にもなる＝誤差の大きさ）＝**9番に固定して失うものは無い**、という
    // R-39 の結論（CPUの打順に規則を持たせない）はそのまま。
    // なお**実際の打席**（`balance:plate`）では投手の打率は .10 前後で、差ははっきり出る＝
    // この一様な格子は打者どうしの比較には向かない（`atBatDistribution` の説明を参照）。
    const runs = Array.from({ length: 9 }, (_, slot) => runsWithAt(slot, WEAK));
    const best = Math.max(...runs);
    expect(best - runs[8]).toBeLessThan(0.02);
    expect(best - Math.min(...runs)).toBeLessThan(0.05);
  });

  // ---- 盗塁：走力を見る根拠（損益分岐と、走力が動かす守備の余裕） ----

  it('盗塁は高い成功率を要求する（軽々しく走ってよい手ではない）', () => {
    const table = solveRunExpectancy(dist(AVERAGE));
    const FIRST = 1;
    const SECOND = 2;
    const THIRD = 4;
    const EMPTY = 0;
    /** 損益分岐の成功率＝(いまの期待 − 失敗後の期待) / (成功後の期待 − 失敗後の期待) */
    const breakEven = (from: number, to: number, outs: number) =>
      (table[outs][from] - table[outs + 1][EMPTY]) /
      (table[outs][to] - table[outs + 1][EMPTY]);
    // **フェーズBBB-82（野手の足を原作の 6.0m/s に）で 0.65〜0.73**（1死 0.65 / 0死 0.72）＝
    // 実際の野球の損益分岐（7割前後）とほぼ同じ帯になった。履歴：R-39 0.73 → QQ-65 0.92
    // （長打が減ってアウト1つの費用が上がった）→ BBB-77 0.22（見えない壁を外して打線が
    // ほとんど点を取れなくなり、この帯は `it.fails` で残していた）→ BBB-82 で攻撃が戻った。
    // R-39 の規則（守備に残る余裕 0.10秒以下＝完璧な送球でしか刺せない走者だけが走る）は
    // **もともと成功率がほぼ1の場面しか通さない**ので、規則そのものは動かない。
    // **フェーズBBB-85（野手の足 7.0m/s・CPU守備の反応 0.45秒）で 0.54〜0.62**（1死 0.54 / 0死 0.62）：
    // 外野の間を抜ける長打が減って単打が増えた＝一塁の走者が安打1本では還りにくくなり、
    // 二塁へ進む値打ちが上がった。「半分以上は成功しないと損」という結論は変わらない。
    for (const outs of [0, 1]) {
      const second = breakEven(FIRST, SECOND, outs);
      expect(second).toBeGreaterThan(0.5);
      expect(second).toBeLessThan(0.85);
      // **三盗のほうが高い成功率を要る**（0.75〜0.81）＝実際の野球と同じ向き。BBB-82 の前は
      // 逆だった（「三塁は還りやすい」ぶん三盗が得）。野手が遅くなって**二塁の走者は安打1本で
      // たいてい還れる**ので、三塁へ進む上積みが小さくなった＝標準のリードではどの走力でも
      // 三盗が成立しない（R-39）ことと向きがそろった。
      expect(breakEven(SECOND, THIRD, outs)).toBeGreaterThan(second);
    }
  });

  it('走力は「守備に残る余裕」を動かし、平均の走者はしきい値の外にいる', () => {
    const slack = (run: number, lead?: number) =>
      cpuStealDefenseSlack('first', {
        speedOf: () => runnerSpeed(run),
        ...(lead === undefined ? {} : { leadOf: () => lead }),
      });
    expect(slack(1)).toBeLessThan(slack(0.5));
    expect(slack(0.5)).toBeLessThan(slack(0));
    // 平均の走者は人の反応時間（約0.2秒）ぶんの余裕を残す＝走らせない
    expect(slack(0.5)).toBeGreaterThan(CPU_STEAL_MAX_DEFENSE_SLACK_SEC);
    expect(slack(0.5)).toBeGreaterThan(0.15);
    expect(slack(0.5)).toBeLessThan(0.25);
    // 上限の走力なら完璧な送球でも間に合わない
    expect(slack(1)).toBeLessThan(0);
    // 深いリード（L-32の持ち越し）はしきい値の側へ押し出す
    expect(slack(0.5, MAX_LEAD)).toBeLessThan(CPU_STEAL_MAX_DEFENSE_SLACK_SEC);
  });

  it('CPUの盗塁は名鑑16球団で「よく走る球団」と「ほとんど走らない球団」に分かれる', () => {
    // 規則が一度も成立しなければ死んだコード、全員走れば個性が出ない（Q-38の7段目と同じ見方）。
    // 実測（`balance:lineup` の7段目）：192人中54人。球団ごとは1〜7人。
    const counts = TEAMS.map(
      (team) =>
        [...team.lineup.map((r) => fielderRowStats(r).run), ...team.bench.map((r) => r[4])].filter(
          (run) =>
            chooseCpuSteals(
              { first: true, second: false, third: false },
              { speedOf: () => runnerSpeed(run) },
            ).length > 0,
        ).length,
    );
    const total = counts.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(30);
    expect(total).toBeLessThan(100);
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...counts)).toBeGreaterThanOrEqual(Math.min(...counts) * 3);
  });
});

describe('球団の個性の残り（S-40。`npm run balance:identity` で測った帯）', () => {
  const NAMED_PITCHERS = TEAMS.flatMap((t) =>
    t.pitchers.map((r) => ({ team: t.name, ...pitcherRowPitching(r) })),
  );
  const profileOf = (p: (typeof NAMED_PITCHERS)[number]) => ({
    speed: p.speed,
    breakLeft: p.breakLeft,
    breakRight: p.breakRight,
    fork: p.fork,
  });

  // ---- 配球（1〜3段目） ----

  it('当てられたときの費用だけでは持ち味を決められない（いちばん安いのは中庸の球）', () => {
    // 1段目の再現。費用だけで選ばせるとどの投手も速球を投げなくなる＝持ち味が消える。
    // だから決め球は「当てさせない力」（時間の短さ／曲がり）の側から決めている。
    // **名鑑の実際の幅（SPD 0.35〜0.96）で見る**（フェーズRR-66）：RR-66で打球初速の
    // 基準を下げたので、**名鑑に存在しないSPD0の投手**ではフォークが遅すぎて
    // 前へ落ちる当たりが増え（21.0%）、速球（16.1%）を上回る。名鑑の中では従来どおり
    // 速球がいちばん高い。
    // **BBB-85 から、打球に乗るのは緩急ぶんだけ**＝当てられたときの質は、どの投手でも同じになる
    // （投手の基準速を一緒に渡す）。持ち味を費用から決められない、という結論はそのまま。
    for (const spd of [0.35, 0.5, 0.96]) {
      const at = (y: -1 | 0 | 1) =>
        measure({
          power: 0.5,
          pitchSpeed: speedForPitchSelection(y, spd),
          pitcherNeutral: neutralSpeedFor(spd),
          steps: FINE_STEPS,
        }).hitRate;
      const [fast, neutral, slow] = [at(-1), at(0), at(1)];
      // 速球は基準速より必ず高い＝費用で選べば速球は選ばれない（どの投手も持ち味が消える）
      expect(fast).toBeGreaterThan(neutral);
      expect(neutral).toBeLessThan(fast * 0.95);
      // **フェーズBBB-82（野手の足を原作の 6.0m/s に）から、遅い球も安くない**：当てられた
      // 弱い当たりが野手の前に落ちる（SPD0.5 で 速球33%／基準29%／フォーク39%）。それまでは
      // 速球がいちばん高かった。「いちばん安いのは中庸」＝費用の側はU字のままで、どの型の
      // 持ち味（速球・フォーク）も費用からは選ばれない、という結論は変わらない。
      // 速い投手（SPD0.96）だけは遅い球がいちばん安い（29%）＝遅い球は投手を選ぶ。
      if (spd <= 0.5) expect(slow).toBeGreaterThan(neutral);
    }
  }, 30000);

  it('速球の値打ちは時間の短さ、フォークの値打ちは曲がり（2段目）', () => {
    const power = { speed: 1, fork: 0.3, breakLeft: 0.3, breakRight: 0.3 };
    const breaking = { speed: 0.3, fork: 1, breakLeft: 1, breakRight: 1 };
    const shape = (p: typeof power, y: 'fast' | 'slow') =>
      planCpuPitchShape({ targetX: STRIKE_ZONE_HALF_WIDTH, speed: y }, p);
    // 速球派の速球は、技巧派の速球より打者に与える時間が短い
    expect(shape(power, 'fast').flightSec).toBeLessThan(shape(breaking, 'fast').flightSec);
    // 技巧派のフォークは、速球派のフォークより大きく曲がる
    expect(shape(breaking, 'slow').breakWidth).toBeGreaterThan(shape(power, 'slow').breakWidth);
  });

  it('名鑑96人で3つの型がどれも生きている（規則が死なない／一様にもならない）', () => {
    // 3段目：しきい値0.15で 速球派43 / 技巧派16 / バランス37。
    const counts = { power: 0, breaking: 0, balanced: 0 };
    for (const p of NAMED_PITCHERS) counts[cpuPitcherStyle(profileOf(p))] += 1;
    for (const style of ['power', 'breaking', 'balanced'] as const) {
      expect(counts[style]).toBeGreaterThan(NAMED_PITCHERS.length * 0.1);
    }
    expect(Math.max(...Object.values(counts))).toBeLessThan(NAMED_PITCHERS.length * 0.6);
  });

  it('R-39のローテーション（先発型4人）の顔ぶれが球団の中で割れる', () => {
    // 3b段目：4人とも同じ型になるのは 16球団中1球団だけ＝試合ごとに相手の持ち味が変わる。
    const kinds = TEAMS.map(
      (t) => new Set(t.pitchers.slice(0, 4).map((r) => cpuPitcherStyle(pitcherRowPitching(r)))).size,
    );
    expect(kinds.filter((k) => k === 1).length).toBeLessThanOrEqual(2);
    expect(kinds.filter((k) => k >= 3).length).toBeGreaterThanOrEqual(4);
  });

  // ---- タッチアップ（4段目） ----

  it('タッチアップの境界は基準速で従来の78mのまま（平均的な走者の手触りは不変）', () => {
    expect(cpuTagUpDefenseSlack('third', { x: 0, z: -CPU_TAG_UP_MIN_DEPTH })).toBeCloseTo(
      -CPU_TAG_UP_MARGIN_SEC,
      2,
    );
  });

  it('走力でタッチアップの境界が開く（従来は走力によらず全員78m）', () => {
    // 4d段目：68m（俊足）〜86m（鈍足）＝幅18m。ここでは「還れる走者の割合」で帯を見る。
    const at = (run: number, depth: number) =>
      chooseCpuTagUp({ first: false, second: false, third: true }, { x: 0, z: -depth }, () =>
        runnerSpeed(run),
      ).length > 0;
    expect(at(1, 70)).toBe(true);
    expect(at(0, 70)).toBe(false);
    expect(at(0, 95)).toBe(true);
    const runs = TEAMS.flatMap((t) => t.lineup.map((r) => fielderRowStats(r).run));
    const goers = runs.filter((run) => at(run, CPU_TAG_UP_MIN_DEPTH)).length;
    // 全員が還れても誰も還れなくても、走力を見た意味が無い
    expect(goers).toBeGreaterThan(runs.length * 0.2);
    expect(goers).toBeLessThan(runs.length * 0.9);
  });

  // ---- けん制のリード（5段目） ----

  it('リードの深さは走力で開くが、けん制はどの走者にも効いたまま', () => {
    const MOUND = FIELDER_HOME_POSITIONS.P;
    const leads = [0, 0.5, 1].map((r) => cpuLeadDistance('first', runnerSpeed(r)));
    expect(leads[2] - leads[0]).toBeGreaterThan(0.5);
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      const speed = runnerSpeed(r);
      expect(cpuLeadDistance('first', speed)).toBeGreaterThan(pickoffOutLead('first', MOUND, speed));
    }
  });

  it('深いリードの持ち越し（L-32）で、俊足のCPU走者だけが二盗を仕掛けられるようになる', () => {
    // 5b段目：リードを持ち越すと余裕は 走力0.5 で 0.093秒・走力1.0 で -0.219秒。
    const slack = (run: number) =>
      cpuStealDefenseSlack('first', {
        speedOf: () => runnerSpeed(run),
        leadOf: () => cpuLeadDistance('first', runnerSpeed(run)),
      });
    expect(slack(1)).toBeLessThan(slack(0.5));
    expect(slack(1)).toBeLessThan(0);
    expect(slack(0)).toBeGreaterThan(CPU_STEAL_MAX_DEFENSE_SLACK_SEC);
  });
});

describe('ローグライトのリロール（U-42。`npm run balance:draft` で測った帯）', () => {
  /**
   * 1ランぶん（`RUN_GAMES` × `DRAFTS_PER_GAME`）の抽選を回して、狙ったデュオが
   * 揃ったかを返す。**打ち手を固定する**（狙いの札があれば必ず取り1人に集める／
   * 無ければリロール）ので、リロールの回数がそのまま効き目に出る。
   *
   * `policy` は切りどころだけが違う2つ：`greedy`＝いつでも引き直す／
   * `patient`＝**前提を1つ持ってから**（あと1枚でデュオ）だけ引き直す。
   */
  function chaseDuo(opts: {
    runSeed: number;
    duo: SkillId;
    rerolls: number;
    policy: 'greedy' | 'patient';
  }): boolean {
    const requires = SKILLS[opts.duo].requires ?? [];
    let roster = createTeamRoster(teamById(TEAMS[0].id));
    let left = opts.rerolls;
    let collector: string | null = null;
    for (let game = 1; game <= RUN_GAMES; game += 1) {
      const seed = gameSeed(opts.runSeed, game);
      const lineages = activeLineagesFor(createRngState(seed));
      let state = createRngState(seed);
      for (let i = 0; i < DRAFTS_PER_GAME; i += 1) {
        const holders = skillHoldersOf(roster);
        let drawn = drawSkillDraft(state, holders, lineages);
        state = drawn.state;
        const wanted = (options: readonly SkillId[]): SkillId | undefined =>
          options.find((id) => id === opts.duo) ?? options.find((id) => requires.includes(id));
        const held = collector === null ? [] : (roster.skills[collector] ?? []);
        const mayReroll = opts.policy === 'greedy' || requires.some((r) => held.includes(r));
        while (mayReroll && wanted(drawn.draft.options) === undefined && left > 0) {
          left -= 1;
          drawn = drawSkillDraft(state, holders, lineages);
          state = drawn.state;
        }
        if (drawn.draft.options.length === 0) continue;
        const pick = wanted(drawn.draft.options);
        if (pick === undefined) {
          const picked = cpuChooseSkill(drawn.draft, holders);
          if (picked) roster = grantSkill(roster, picked.holderId, picked.skillId).roster;
          continue;
        }
        const pool: SkillHolder[] = collector === null
          ? holders
          : holders.filter((h) => h.id === collector);
        const holder = pool.find((h) => canGrant(h, pick));
        if (!holder) continue;
        const result = grantSkill(roster, holder.id, pick);
        if (!result.ok) continue;
        roster = result.roster;
        collector = holder.id;
        if (pick === opts.duo) return true;
      }
    }
    return false;
  }

  /** 測るラン数（決定的なので毎回同じ値になる。ツール側は400、ここは速さのため120） */
  const RUNS = 120;
  /** ★1+★2 の軽いデュオ（ツールの1つ目の代表と同じ選び方） */
  const LIGHT_DUO = DUO_SKILL_IDS.find((id) => {
    const requires = SKILLS[id].requires ?? [];
    return requires.length === 2 && requires.reduce((sum, r) => sum + SKILLS[r].rarity, 0) === 3;
  })!;

  const rate = (rerolls: number, policy: 'greedy' | 'patient'): number => {
    let got = 0;
    for (let run = 0; run < RUNS; run += 1) {
      if (chaseDuo({ runSeed: run * 977 + 1, duo: LIGHT_DUO, rerolls, policy })) got += 1;
    }
    return got / RUNS;
  };

  it('リロールがあると狙ったデュオが揃いやすくなる（無いときの1.5倍以上）', () => {
    const none = rate(0, 'patient');
    const withRerolls = rate(REROLLS_PER_RUN, 'patient');
    expect(none).toBeGreaterThan(0);
    expect(withRerolls).toBeGreaterThan(none * 1.5);
  });

  it('それでも「狙えば必ず揃う」にはならない（揃えにいく判断が運任せにも確実にもならない）', () => {
    expect(rate(REROLLS_PER_RUN, 'patient')).toBeLessThan(0.5);
  });

  it('温存に値打ちがある（同じ回数券でも、切りどころで結果が変わる）', () => {
    // これが成り立たないと「ラン全体の回数券」（試合ごとに回復させない）を選んだ意味が消える
    expect(rate(REROLLS_PER_RUN, 'patient')).toBeGreaterThan(rate(REROLLS_PER_RUN, 'greedy'));
  });

  it('CPUの規則は死んでいないが、毎回は言わない（★1だけの3択は2割前後）', () => {
    let draws = 0;
    let fires = 0;
    for (let run = 0; run < RUNS; run += 1) {
      const seed = gameSeed(run * 977 + 1, 1);
      const lineages = activeLineagesFor(createRngState(seed));
      let roster = createTeamRoster(teamById(TEAMS[1].id));
      let state = createRngState(seed);
      for (let i = 0; i < DRAFTS_PER_GAME; i += 1) {
        const holders = skillHoldersOf(roster);
        const drawn = drawSkillDraft(state, holders, lineages);
        state = drawn.state;
        draws += 1;
        if (shouldCpuReroll(drawn.draft)) fires += 1;
        const picked = cpuChooseSkill(drawn.draft, holders);
        if (picked) roster = grantSkill(roster, picked.holderId, picked.skillId).roster;
      }
    }
    expect(fires / draws).toBeGreaterThan(0.1);
    expect(fires / draws).toBeLessThan(0.35);
    // 1ラン45回でこれだけ言う＝回数券（3回）は序盤で尽きる＝温存は人間の取り分
    expect((fires / draws) * RUN_GAMES * DRAFTS_PER_GAME).toBeGreaterThan(REROLLS_PER_RUN);
  });
});

describe('疲労の持ち越し（V-43。`npm run balance:rotation` で測った帯）', () => {
  /** 疲労 f の投手が投げているときの、1イニングの失点期待 */
  const runsAt = (fatigue: number): number =>
    solveRunExpectancy(distributionFor(0.5, { average: 0.5, pitcherFatigue: fatigue }))[0][0];

  it('疲労は打たれ方を実際に悪くする（＝持ち越しが代償になる条件）', () => {
    // ここが成り立たないと V-43 の設計（疲れを代償にする）が空振りする。
    // **BBB-85 までこの計測は疲労の費用を大きく見ていた**：球威の上乗せ（+5m/s）だけを足し、
    // 疲労で球速が落ちるぶん打球が弱くなる（-2.1m/s）を数えていなかった（実機の差し引きは
    // +2.9）。BBB-85 で上乗せそのものが +2.9 になり、計測も実機と同じ値を見る＝2倍強 → 1.9倍。
    expect(runsAt(1)).toBeGreaterThan(runsAt(0) * 1.5);
  });

  it('疲労は単調に効く（途中で得になる領域が無い＝「わざと疲れる」が起きない）', () => {
    const steps = [0, 0.25, 0.5, 0.75, 1].map(runsAt);
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i]).toBeGreaterThan(steps[i - 1]);
    }
  }, 20000);

  it('連投したエースは、1試合空けた同じ投手より必ず損', () => {
    // 完投（残量0）→ 次の試合は REST_RECOVERY、2試合後は 2×REST_RECOVERY
    const backToBack = fatigueFromRemaining(REST_RECOVERY);
    const oneGameOff = fatigueFromRemaining(Math.min(1, REST_RECOVERY * 2));
    expect(runsAt(backToBack)).toBeGreaterThan(runsAt(oneGameOff));
    // 連投は「球威が落ちた状態」から始まる＝代償が最初の1球から効いている
    expect(backToBack).toBeGreaterThan(0);
    // 1試合空ければ球威は無傷に戻る（4人ローテだけが正解にならない条件）
    expect(oneGameOff).toBe(0);
  });

  it('休養で必ず回復する（積み上がる一方にはならない）', () => {
    const team = TEAMS[0];
    const id = staffPlayerId(team.id, 0);
    const max = maxPitchesFor(team.pitchers[0][7] as number);
    let carried: Record<string, number> = { [id]: max };
    // 投げずに休み続ければ、有限の試合数で必ず無傷へ戻る
    for (let game = 0; game < RUN_GAMES; game += 1) {
      carried = restedPitchCounts(withCarriedFatigue(createTeamRoster(team), carried));
    }
    expect(carried[id]).toBeUndefined();
  });
});

describe('制球を疲労とスキルへ（W-44。`npm run balance:control` の8〜10段目で測った帯）', () => {
  /** 名鑑96人（16球団×6人）のERA */
  const ERAS = TEAMS.flatMap((t) => t.pitchers.map((r) => pitcherRowPitching(r).era));
  /** その制球の投手が決め球で狙うXの絶対値 */
  const putaway = (control: number): number =>
    Math.abs(chooseCpuPitchPlan({ balls: 0, strikes: 2 }, 'balanced', control).targetX);
  /** 見逃せばストライクになる投手の人数（＝制球の値打ちが実在する人数） */
  const calledStrikes = (fatigue: number): number =>
    ERAS.filter((era) => putaway(fatiguedControl(pitcherControl(era), fatigue)) <= STRIKE_ZONE_HALF_WIDTH)
      .length;
  /**
   * 打席中央の打者に死球がありうる投手の人数。**隅の向きはボール数の偶奇で入れ替わる**
   * （cornerSign）ので、体側に来るカウントがあるかで数える（どちらの偶奇が体側かは
   * 打席の位置で決まる＝フェーズBB-49で入れ替わった）。
   */
  const hbpAtCenter = (fatigue: number): number =>
    ERAS.filter((era) =>
      [0, 1].some(
        (balls) =>
          judgePitch(
            chooseCpuPitchPlan(
              { balls, strikes: 2 },
              'balanced',
              fatiguedControl(pitcherControl(era), fatigue),
            ).targetX,
            RIGHT_BATTER_SIDE,
            0,
          ) === 'hitByPitch',
      ),
    ).length;

  it('疲労は決め球の値打ちを実際に奪う（見逃し三振を取れる投手が減る）', () => {
    // 8段目：無傷 15/96 → 疲労MAX 0/96。ここが動かないと「疲れると荒れる」が空振りする。
    // **フェーズRR-66で 15→8**：打者が本塁へ寄った（死球ゾーンが近づいた）ぶん
    // `CPU_CONTROL_MAX_TARGET` が下がり、荒れの曲線が 3→2 になった＝**制球の良い投手が
    // 縁の内側へ食い込む深さも浅くなった**。構造（良い投手だけが取れる／疲れると消える）は不変。
    expect(calledStrikes(0)).toBeGreaterThan(5);
    expect(calledStrikes(1)).toBe(0);
    // 途中で得になる領域が無い（単調）
    const steps = [0, 0.25, 0.5, 0.75, 1].map(calledStrikes);
    for (let i = 1; i < steps.length; i += 1) expect(steps[i]).toBeLessThanOrEqual(steps[i - 1]);
  });

  it('荒れは死球まで届く（ユーザー判断）が、無傷では例外のまま', () => {
    // 8段目：無傷では 3/96 だけ（T-41の帯）／疲労MAXでは増える
    expect(hbpAtCenter(0)).toBeLessThan(ERAS.length * 0.1);
    expect(hbpAtCenter(1)).toBeGreaterThan(hbpAtCenter(0));
  });

  it('人間の投手は自動で代わらないぶん、疲労が実際に振り切れる（V-43の持ち越し込み）', () => {
    const stamina = 0.85; // 先発型の代表（容量110球）
    const cap = maxPitchesFor(stamina);
    // 無傷から投げ切れば振り切れる
    expect(fatigueFromRemaining(staminaRemaining(120, stamina))).toBe(1);
    // V-43で残量0.6を持ち越して始めれば、80球で振り切れる
    const carried = Math.round(0.4 * cap);
    expect(fatigueFromRemaining(staminaRemaining(carried + 80, stamina))).toBe(1);
  });

  it('人間側の代償：疲れると隅に届かなくなる（が、向きは常に入力どおり）', () => {
    const flight = (PLATE_Z - RELEASE_Z) / speedForPitchSelection(0);
    const fresh = courseReleaseVxFor(0, 0) * flight;
    const tired = courseReleaseVxFor(0, 1) * flight;
    // 10段目：0.441 → 0.338（-23%）＝ど真ん中に立ったままでは隅が突けない
    expect(fresh).toBeGreaterThan(STRIKE_ZONE_HALF_WIDTH * 0.95);
    expect(tired).toBeLessThan(STRIKE_ZONE_HALF_WIDTH);
    expect(tired / fresh).toBeGreaterThan(0.7);
    // コースを選べなくはならない（0で下げ止める＝入力を裏切らない）
    expect(courseReleaseVxFor(0, 1)).toBeGreaterThan(0);
  });

  it('スキルの値打ち：ゾーンの外まで届く（ボール球で釣れる）', () => {
    const flight = (PLATE_Z - RELEASE_Z) / speedForPitchSelection(0);
    const bonus = SKILLS.shinenseigyo.modifier!.control!;
    expect(courseReleaseVxFor(bonus, 0) * flight).toBeGreaterThan(STRIKE_ZONE_HALF_WIDTH);
    // 3枚積んでも、ど真ん中からは死球ゾーン（0.9）に届かない
    const stacked =
      bonus + SKILLS.zazen.modifier!.control! + SKILLS.mushin.modifier!.control!;
    expect(courseReleaseVxFor(stacked, 0) * flight).toBeLessThan(0.9);
  });

  it('制球スキルは名鑑96人の分布を実際に動かす（規則が死んでいない）', () => {
    const bonus = SKILLS.shinenseigyo.modifier!.control!;
    const withSkill = ERAS.filter(
      (era) => putaway(pitcherControl(eraWithControl(era, bonus))) <= STRIKE_ZONE_HALF_WIDTH,
    ).length;
    // 10段目：15/96 → 52/96
    expect(withSkill).toBeGreaterThan(calledStrikes(0) * 2);
    expect(withSkill).toBeLessThan(ERAS.length); // 全員が完璧にはならない
  });
});

describe('CPUの攻撃の采配（X-45。`npm run balance:offense` で測った帯）', () => {
  // ---- 送りバント・スクイズを入れなかった理由（計測が否定した6件目） ----
  //
  // I-29の `TIMING_SWEET_BAND`、O-35の「F＝緩急の幅」、R-39の打順、S-40の配球の費用、
  // W-44のCPU限定の疲労に続く記録。**同じ懸念を蒸し返さないために帯を残す**
  // （CLAUDE.md「計測で問題なしと出たら、それも結論として記録して閉じる」）。

  /** ど真ん中のバントを転がして、守備が確保するまでの時刻と位置を得る */
  function fieldBunt(aim: -1 | 0 | 1) {
    const launch = judgeBunt(0, aim)!;
    const result = simulatePlay(launch, 0);
    return result;
  }

  it('バントは必ず投手が本塁のすぐ近くで確保する（どの狙いでも）', () => {
    for (const aim of [-1, 0, 1] as const) {
      const result = fieldBunt(aim);
      expect(result.fielded).toBeDefined();
      expect(result.fielded!.by).toBe('P');
      // 1段目：本塁から 12m前後・確保 0.98〜1.82秒（野手の足を原作の 6.0m/s にした BBB-82 から。
      // それまでの 8.5m/s では 0.83〜1.20秒）
      const depth = Math.hypot(result.fielded!.pos.x, result.fielded!.pos.z);
      expect(depth).toBeLessThan(15);
      expect(result.fielded!.sec).toBeLessThan(2.0);
    }
  });

  it('その位置からはどの塁への送球も走者より速い（＝送りバントが成立しない構造）', () => {
    const { fielded } = fieldBunt(0);
    for (const base of ['first', 'second', 'third', 'home'] as const) {
      const throwSec = distance(fielded!.pos, BASE_POSITIONS[base]) / THROW_SPEED;
      // もっとも足の速い走者でも塁間に 3.3秒かかる（J-30が測った「送球は走者の4.5倍」）
      const runSec = 27.43 / RUNNER_SPEED_MAX;
      expect(fielded!.sec + throwSec).toBeLessThan(runSec);
    }
  });

  it('打者走者も刺される（セーフティバントも成立しない）', () => {
    expect(fieldBunt(0).outcome.kind).toBe('groundout');
  });

  // ---- 代打（8段目） ----

  it('代打の利得は得点圏で跳ねる（＝しきい値を「得点圏かどうか」に置いた根拠）', () => {
    // **フェーズBBB-82で「打席そのもの」の分布へ載せ替えた**（`atBatDistribution`）。
    // それまでは一様な格子（`distributionFor`）で測っていたが、野手の足を原作の 6.0m/s に
    // すると、その格子では**外した当たりが野手の前に落ちる**ぶん投手（長打力0.1）と控え
    // （0.67）の出塁率が同じになり、利得が 0〜2pt まで潰れる。実際の打席では投手の打率は
    // .10 前後・控えは .34 前後で、差ははっきり出る＝画面で起きているのはこちら。
    // （BBB-77〜81 の間は、打線がほとんど点を取れずこの帯は `it.fails` で残していた。）
    const starters = TEAMS.map((team) => pitcherRowPitching(team.pitchers[0]));
    const batterOf = (average: number, power: number) => ({
      bats: 'R' as const,
      average,
      power,
      run: 0.5,
    });
    // 四球・死球は**押し出しの進塁としてそのまま数える**（`walkAs: 'walk'`。フェーズBBB-84で
    // 分布に四死球の枠ができた）のと、アウトに寄せた下限の両方で確かめる。BBB-83 までは枠が無く
    // 「アウトに寄せた下限／単打に寄せた上限」で挟んでいたが、単打へ寄せると四死球の多い弱い打者の
    // 値打ちを過大に見る（内外角を引くようになって、踏み込んだCPU打者への死球が増えた）。
    // **打席数は各640**（16投手×40）：160打席では標本の揺れ（±3pt）が利得の差と同じ大きさになる。
    for (const walkAs of ['out', 'walk'] as const) {
      const of = (average: number, power: number) =>
        atBatDistribution(batterOf(average, power), starters, { walkAs, reps: 40 });
      const scoreTable = solveScoreProbability(of(0.5, 0.5));
      const pitcher = of(0.2, 0.1);
      const bench = of(0.49, 0.67);
      const gain = (outs: number, state: number) =>
        paScoreProb(bench, outs, state, scoreTable) - paScoreProb(pitcher, outs, state, scoreTable);
      // **得点圏（二塁・三塁）の利得は、走者なし・一塁のみより大きい**（四死球をそのまま数えて
      // 0死 二塁 6.9pt 対 4.0/4.4pt、1死 9.0/6.1pt 対 3.5/4.4pt、2死 11.5/8.6pt 対 2.4/3.3pt）
      // ＝X-45が「得点圏かどうか」で切った根拠。
      // UU-69 が記録した「一塁がいちばん利得が大きい（規則が最良の場面を外している）」は
      // ここで解消した＝二塁の走者が安打1本で還れるようになったため。
      // **0死の三塁だけは別**：弱い打者でも還せる（内野ゴロ・外野フライで足りる）ので、
      // 利得は走者なし・一塁と同じ帯に並ぶ（4.3pt 対 4.0/4.4pt）。
      for (const outs of [0, 1, 2]) {
        for (const scoring of outs === 0 ? [2] : [2, 4]) {
          expect(gain(outs, scoring)).toBeGreaterThan(gain(outs, 0));
          expect(gain(outs, scoring)).toBeGreaterThan(gain(outs, 1));
        }
      }
      // アウトが増えるほど差が開く（2死では走者なしの2倍以上）＝2死の好機ほど代打が効く
      expect(gain(2, 2)).toBeGreaterThan(gain(2, 0) * 2);
      // どの場面でも「控えのほうが強い」ことは変わらない（負にはならない）
      for (let state = 0; state < 8; state += 1) {
        for (const outs of [0, 1, 2]) expect(gain(outs, state)).toBeGreaterThan(0);
      }
    }
  }, 30000);

  it('しきい値0.80は名鑑16球団で死んでいない（Q-38の能力差と同じ見方）', () => {
    const rows = TEAMS.map((team) => {
      const best = team.bench
        .map(benchRowStats)
        .reduce((a, b) => (b.power + b.average > a.power + a.average ? b : a));
      return team.pitchers
        .slice(0, 4)
        .map((p) => {
          const bat = pitcherRowBatting(p);
          return best.average + best.power - (bat.average + bat.power);
        });
    });
    const fires = rows.filter((gaps) => gaps.some((g) => g >= CPU_PINCH_HIT_GAP)).length;
    // 8段目：0.80 で 11/16 球団・1.00 まで厳しくすると 4/16 で規則が死ぬ
    expect(fires).toBeGreaterThanOrEqual(8);
    expect(fires).toBeLessThan(TEAMS.length);
    // 控えが売りの球団（ナイツ。B-12）がいちばん出しやすい
    const knights = TEAMS.findIndex((t) => t.short === 'ナイ');
    expect(Math.max(...rows[knights])).toBe(Math.max(...rows.map((g) => Math.max(...g))));
  });

  // ---- 打球での余分な進塁（10〜12段目） ----

  /** その安打について、規則が見る「見込み」と、実際の守備の両方の余裕を出す */
  function extraBaseCase(sample: (typeof hits)[number], speed: number) {
    const rule = cpuExtraBaseSlack({
      from: 'second',
      speed,
      securePoint: sample.predicted.point,
      secureSec: sample.predicted.sec,
    });
    const to = BASE_POSITIONS.third;
    const actual =
      sample.fielded === undefined
        ? Number.NEGATIVE_INFINITY
        : // 実際の守備も、拾ってから持ち替え（BBB-82）を待って投げる
          27.43 / speed -
          (sample.fielded.sec + PICKUP_RELEASE_SEC + distance(sample.fielded.pos, to) / THROW_SPEED);
    return { rule, actual };
  }

  // **守備は「CPU走者が人間の守備に見込む動き」**（いちばん近い野手を球へ向ける・反応0）で回す
  // （フェーズBBB-83）：この規則が実機で使われるのはCPUが攻撃＝人間が守るときだけ。CPU守備の
  // 先回りを相手に測ると、画面では起きない組み合わせを数えることになる。
  const hits = sweep({ batter: hitter(0.5), steps: STEPS, chase: 'follow', reactionSec: 0 })
    .filter((s) => ['beatThrow', 'hit', 'groundRuleDouble'].includes(s.result.outcome.kind))
    .map((s) => {
      const crossX = crossXFor(s.course);
      const launch = judgeSwing(
        { crossX, swingTime: swingTimeFor(s.timing), pitchSpeed: SPEED_NEUTRAL },
        hitter(0.5),
      )!;
      const landing = predictLandingAt(createBattedBall(launch, crossX));
      const controllable = Object.fromEntries(
        CONTROLLABLE_FIELDERS.map((id) => [id, FIELDER_HOME_POSITIONS[id]]),
      ) as Record<FielderId, Vec2>;
      const chaser = nearestFielder(landing.point, controllable);
      return {
        predicted: {
          point: landing.point,
          sec: Math.max(
            landing.sec,
            distance(FIELDER_HOME_POSITIONS[chaser], landing.point) / FIELDER_SPEED,
          ),
        },
        fielded: s.result.fielded,
        finalDistance: s.result.finalDistance,
        /** 滞空（着地までの秒数）。転がった打球とポテンヒットを分ける（RR-66） */
        hang: landing.sec,
      };
    });

  it('帯が空ではない（安打の3割前後で余分な塁を狙える）', () => {
    const going = hits.filter(
      (h) => extraBaseCase(h, RUNNER_SPEED).rule <= -CPU_TAG_UP_MARGIN_SEC,
    );
    // 11段目：基準速で 80.0% だった。**フェーズBBB-77で約3割に下がった**＝フェンス手前の
    // 見えない壁（野手は本塁から98mより奥へ行けなかった）を外し、外野の頭を越えて止まった
    // 打球（余分な塁を狙える安打の大半）が捕られるようになったため。残った安打は外野の手前に
    // 落ちる打球と内野を抜ける打球が中心。
    expect(going.length / hits.length).toBeGreaterThan(0.25);
    expect(going.length).toBeLessThan(hits.length); // 全部ではない（内野安打では行かない）
  });

  it('内野で転がった打球では仕掛けない（バントと同じ理由でここは帯が無い）', () => {
    // **滞空の短さも条件に入れる**（フェーズRR-66）：抗力を上げたので、**高く上がって
    // 48mに落ちるポップフライ**（滞空3.5秒）が「60m未満で止まった打球」に混ざるように
    // なった。それは内野ゴロではなく**浅い外野へのポテンヒット**で、守備が着くのは
    // 落ちた後（4.0秒）＝余分な塁を狙えるのが正しい。ここが見たいのは「転がった打球」。
    const infield = hits.filter((h) => h.finalDistance < 60 && h.hang < 1);
    expect(infield.length).toBeGreaterThan(0);
    for (const h of infield) {
      expect(extraBaseCase(h, RUNNER_SPEED).rule).toBeGreaterThan(-CPU_TAG_UP_MARGIN_SEC);
    }
  });

  it('足が速いほどよく仕掛ける（R-39の盗塁・S-40のタッチアップと同じ球団の個性）', () => {
    const share = (speed: number) =>
      hits.filter((h) => extraBaseCase(h, speed).rule <= -CPU_TAG_UP_MARGIN_SEC).length;
    expect(share(RUNNER_SPEED_MAX)).toBeGreaterThanOrEqual(share(RUNNER_SPEED));
    expect(share(RUNNER_SPEED)).toBeGreaterThanOrEqual(share(RUNNER_SPEED_MIN));
  });

  it('見込みは実際より慎重側に出る（着地点しか使えないぶんの安全側の偏り）', () => {
    const diffs = hits
      .filter((h) => h.fielded !== undefined)
      .map((h) => {
        const c = extraBaseCase(h, RUNNER_SPEED);
        return c.rule - c.actual;
      });
    const cautious = diffs.filter((d) => d >= 0).length;
    // 10段目：75.8% が慎重側
    expect(cautious / diffs.length).toBeGreaterThan(0.5);
  });

  it('余白 CPU_TAG_UP_MARGIN_SEC で、仕掛けた走者が刺されるのは「反応0の完璧な守備」に紙一重の1本だけ', () => {
    const going = hits.filter(
      (h) => extraBaseCase(h, RUNNER_SPEED).rule <= -CPU_TAG_UP_MARGIN_SEC,
    );
    const caught = going.filter((h) => extraBaseCase(h, RUNNER_SPEED).actual >= 0);
    // 12段目：margin 0 では 1.6% が刺される。0.14 で 0.0% だった（野手 6.0m/s まで）。
    // **フェーズBBB-85（野手 7.0m/s）で1本だけ残る**：左翼の前に落ちて転がる当たりを、
    // いちばん近い野手ではなく、一斉移動で同じ向きへ動いた左翼手が先に拾う（見込み 2.42秒・
    // 実際 2.05秒）。ここで言う実際の守備は**打った瞬間に動き出し、拾ってすぐ三塁へ投げる**
    // 守備で、その差は 0.03秒＝人の反応（0.2秒）があれば走者は生きる。
    expect(caught.length).toBeLessThanOrEqual(1);
    for (const h of caught) expect(extraBaseCase(h, RUNNER_SPEED).actual).toBeLessThan(0.05);
  });
});

describe('バントの成立（Y-46。`npm run balance:bunt` で測った帯）', () => {
  // X-45が「送りバントはこの守備モデルでは一度も成立しない」と結論したのは
  // **標準のバント（弱く転がすだけ・走者は塁の真上から）**についての話だった。
  // Y-46は不足を秒に分解し、**既存の境界を1つも動かさない2つのレバー**で埋めた：
  // (A) 打球のプレーでも走者がリードを保つ（L-32との一貫性）／
  // (D) 十字キー上で押しバント（説明書p17「ファールラインぎりぎりに転がすのがコツ」）。

  /** そのバントを転がして、守備が確保する時刻と位置を得る */
  const fieldBunt = (aim: -1 | 0 | 1, push = false) =>
    simulatePlay(judgeBunt(0, aim, RIGHT_BATTER_SIDE, 0, push)!, 0);

  /** 確保してからその塁へ送球が届くまで（打球の瞬間からの秒数）。sim.ts の throwOut と同じ式 */
  const throwArrival = (r: ReturnType<typeof fieldBunt>, base: 'first' | 'second') =>
    r.fielded!.sec +
    PICKUP_THROW_DELAY_SEC +
    distance(r.fielded!.pos, BASE_POSITIONS[base]) / THROW_SPEED;

  /** 捕手が投球を受けてから二塁へ投げるまで（＝盗塁を刺す経路。比較の基準線） */
  const catcherPath =
    STEAL_CATCH_RELEASE_SEC + distance(BASE_POSITIONS.home, BASE_POSITIONS.second) / THROW_SPEED;

  it('押しバントをライン際へ転がすと、標準のバントより確保が遅れる', () => {
    for (const aim of [-1, 1] as const) {
      expect(fieldBunt(aim, true).fielded!.sec).toBeGreaterThan(fieldBunt(aim).fielded!.sec);
    }
  });

  it('押しても正面へ出すと逆効果（投手の正面＝標準より早く決着する）', () => {
    const pushed = fieldBunt(0, true);
    const normal = fieldBunt(0);
    // 1段目/4段目：正面への押しは投手が空中で捕る（小フライ）か、より早く拾われる
    const pushedSec = pushed.fielded?.sec ?? pushed.seconds;
    expect(pushedSec).toBeLessThanOrEqual(normal.fielded!.sec);
  });

  it('ライン際へ転がせば、捕手が盗塁を刺すより守備は遅くなる（Y-46の芯。BBB-82で標準のバントも）', () => {
    // Y-46 の当時は**標準のバントが捕手の送球より速かった**（転がすと守備を助けた＝実際の野球と逆）。
    // 野手の足を原作の 6.0m/s にした BBB-82 からは、投手が拾いに行くのに時間が掛かるので、
    // 標準のバントでも守備は遅くなる＝この逆転は守備のモデルの側から解けた。
    expect(throwArrival(fieldBunt(-1), 'second')).toBeGreaterThan(catcherPath);
    expect(throwArrival(fieldBunt(-1, true), 'second')).toBeGreaterThan(catcherPath);
    // 押しのほうが標準より遅い。**差は BBB-83 で 0.14秒 → 0.01秒まで縮んだ**：CPUの投手が
    // 球と出会う点へまっすぐ向かうようになり（先回り）、三塁線に沿って転がる球はどこまで
    // 転がっても拾うまでの時間がほとんど変わらない（三塁線は投手から見てほぼ等距離）。
    // 標準のバントのほうは、打球への反応（0.25秒）のぶん拾うのが遅くなった。
    expect(
      throwArrival(fieldBunt(-1, true), 'second') - throwArrival(fieldBunt(-1), 'second'),
    ).toBeGreaterThan(0);
  });

  it('押しバントでも打者走者は一塁で刺される（＝アウトと引き換えの手であることは変わらない）', () => {
    // **フェーズBBB-85（野手 7.0m/s）で 13→13.5**＝BBB-83 と同じ余裕（最速の打者で 0.16秒）に
    // なる初速。以下は BBB-82 の記録。
    // **フェーズBBB-82で押しの初速をこの条件から解き直した（17→13）**。野手の足を原作の
    // 6.0m/s にすると、17m/s は三塁手の手前まで転がって足の速い打者（走力0.8以上）が必ず
    // 内野安打になり、16〜16.5m/s は誰が打っても全員セーフだった（`balance:bunt` の4c段目）。
    // いまの初速は「いちばん足の速い打者でも一塁で刺される最大の値」（余裕 0.1秒以上）。
    for (const aim of [-1, 1] as const) {
      const r = fieldBunt(aim, true);
      expect(BASE_PATH / RUNNER_SPEED_MAX - throwArrival(r, 'first')).toBeGreaterThan(0.1);
    }
  });

  it('押しても三塁走者は還れない（スクイズはこの守備でも成立しない＝X-45の結論のまま）', () => {
    // 4c段目：いちばん足の速い走者がリードを取っていても、本塁への送球のほうが早い
    for (const aim of [-1, 1] as const) {
      const r = fieldBunt(aim, true);
      const home =
        r.fielded!.sec + PICKUP_THROW_DELAY_SEC + distance(r.fielded!.pos, BASE_POSITIONS.home) / THROW_SPEED;
      expect((BASE_PATH - STEAL_LEAD) / RUNNER_SPEED_MAX).toBeGreaterThan(home);
    }
  });

  it('レバーAは打者走者に効かない（＝I-29の内野安打の帯が原理的に動かない根拠）', () => {
    // 打者走者は本塁から走るのでリードを持てない＝塁上の走者だけが得をする
    const batter = BASE_PATH / RUNNER_SPEED;
    const runnerWithLead = (BASE_PATH - STEAL_LEAD) / RUNNER_SPEED;
    expect(runnerWithLead).toBeLessThan(batter);
    expect(batter).toBeCloseTo(BASE_PATH / RUNNER_SPEED, 10); // リードの影響を受けない
  });

  it('リード＋押し＋俊足で送りバントが成立し、鈍足では成立しない（帯であって常勝ではない）', () => {
    const pushed = fieldBunt(-1, true);
    const arrival = throwArrival(pushed, 'second');
    const runnerSec = (speed: number) => (BASE_PATH - STEAL_LEAD) / speed;
    // 4c段目（BBB-85：野手 7.0m/s・押し 13.5m/s）：走力1.0はセーフ（+0.19秒）／走力0.0は
    // アウト（-0.41秒）。基準速はほぼ同着（-0.08秒＝わずかにアウト）＝平均より足のある走者から
    // 成立する。BBB-82 は +0.25／-0.35／-0.02、BBB-83 は +0.22／-0.05（基準速）。
    expect(runnerSec(RUNNER_SPEED_MAX)).toBeLessThan(arrival);
    expect(runnerSec(RUNNER_SPEED_MIN)).toBeGreaterThan(arrival);
    expect(Math.abs(runnerSec(RUNNER_SPEED) - arrival)).toBeLessThan(0.1);
  });

  it('標準のバントは、基準速の走者ではリードを足しても成立しない（俊足なら成立する）', () => {
    // BBB-82 から：野手が遅くなったぶん、標準のバントでも**いちばん速い走者**は二塁に間に合う。
    // 基準速の走者は間に合わない＝押し（ライン際）か、足のある走者が要る。
    const arrival = throwArrival(fieldBunt(-1), 'second');
    expect((BASE_PATH - STEAL_LEAD) / RUNNER_SPEED).toBeGreaterThan(arrival);
    expect((BASE_PATH - STEAL_LEAD) / RUNNER_SPEED_MAX).toBeLessThan(arrival);
  });
});

describe('バントのファウル（AA-48。`npm run balance:bunt` の10・10b段目で測った帯）', () => {
  // Y-46 が置いたバントの失敗は3つ（弱い＝捕手が空中で捕る／正面＝投手が空中で捕る／
  // 強すぎ＝三塁手まで転がる）で、**ファウルという4つ目の失敗にだけ罰が無かった**。
  // AA-48 は「バントのファウルはストライクとして数える」（説明書p32）を入れたが、
  // **狙い（`judgeBunt`）は1行も触っていない**ので、罰がどこに噛むかは打球のほうが決める。
  // ここで固定するのはその構造＝**ゾーン内では発火せず、決め球の隅でだけ発火し、
  // しかも打者側に逃げ道がある**（回避手段が無い罰にはしない、という既存の方針）。

  /** その接触点・狙いでバントしたときの帰結（バットが届かなければ null＝空振り） */
  const buntAt = (x: number, aim: -1 | 0 | 1, side = RIGHT_BATTER_SIDE, push = false) => {
    const launch = judgeBunt(x, aim, side, 0, push);
    return launch === null ? null : simulatePlay(launch, x).outcome.kind;
  };

  /** そのカウントでCPU投手が狙う本塁上のX（T-41。制球は名鑑の中央値＝基準の投手） */
  const planX = (balls: number, strikes: number) =>
    chooseCpuPitchPlan({ balls, strikes }, 'balanced', NEUTRAL_RATING).targetX;

  it('ストライクゾーン内の球はバントしてもファウルにならない（罰は見極めの側にある）', () => {
    for (const side of [RIGHT_BATTER_SIDE, LEFT_BATTER_SIDE] as const) {
      for (const push of [false, true]) {
        for (const aim of [-1, 0, 1] as const) {
          for (let x = -STRIKE_ZONE_HALF_WIDTH; x <= STRIKE_ZONE_HALF_WIDTH + 1e-9; x += 0.05) {
            expect(buntAt(x, aim, side, push)).not.toBe('foul');
          }
        }
      }
    }
  });

  it('決め球（2ストライクの隅）を球のある側へ置きバントするとファウル＝三振になる', () => {
    const x = planX(0, 2);
    expect(Math.abs(x)).toBeGreaterThan(STRIKE_ZONE_HALF_WIDTH); // 決め球はゾーンの外
    expect(buntAt(x, Math.sign(x) as -1 | 1)).toBe('foul');
  });

  it('その決め球でも逆側・正面なら転がる（＝避ける手が打者の側にある）', () => {
    const x = planX(0, 2);
    expect(buntAt(x, 0)).not.toBe('foul');
    expect(buntAt(x, -Math.sign(x) as -1 | 1)).not.toBe('foul');
    // 押せば球のある側へ転がしてもファウルにならない（Y-46の押しは帯がさらに外側）
    expect(buntAt(x, Math.sign(x) as -1 | 1, RIGHT_BATTER_SIDE, true)).not.toBe('foul');
  });

  it('送りバントの場面（0ストライク）では発火しない＝Y-46で測った得は削られない', () => {
    for (const [balls, strikes] of [
      [0, 0],
      [3, 0],
    ] as const) {
      for (const aim of [-1, 0, 1] as const) {
        for (const push of [false, true]) {
          expect(buntAt(planX(balls, strikes), aim, RIGHT_BATTER_SIDE, push)).not.toBe('foul');
        }
      }
    }
  });
});

describe('CPUの継投を能力の比較に（Z-47。`npm run balance:relief` で測った帯）', () => {
  /** 名鑑16球団の投手陣（6人ずつ） */
  const STAFFS = TEAMS.map((t) => t.pitchers.map((r) => pitcherRowPitching(r)));

  /**
   * 1試合ぶんの投手起用（計測ツールと同じ仮定＝140球・1打席4球・先発は名鑑の先頭）。
   * 判断の場所は main.ts の `tryCpuRelief` と同じ「打席の切れ目」。
   */
  const playGame = (
    pitchers: readonly PitcherStats[],
    compare: boolean,
  ): { maxFatigue: number; changes: number; downgrades: number; left: number } => {
    const counts = pitchers.map(() => 0);
    let current = 0;
    const bullpen = pitchers.map((_, i) => i).filter((i) => i !== current);
    const remainingOf = (i: number) => staminaRemaining(counts[i], pitchers[i].stamina);
    const qualityOf = (i: number) =>
      pitcherQuality(pitchers[i], fatigueFromRemaining(remainingOf(i)));
    let maxFatigue = 0;
    let changes = 0;
    let downgrades = 0;
    for (let pitch = 1; pitch <= 140; pitch += 1) {
      if (pitch % 4 === 1 && pitch > 1) {
        const idx = chooseCpuRelief(
          // compare=false で「質を見ない」旧規則を再現する（控えを常に格上として渡す）
          { remaining: remainingOf(current), quality: compare ? qualityOf(current) : 0 },
          bullpen.map((i, k) => ({
            index: k,
            remaining: remainingOf(i),
            reliever: pitcherRole(pitchers[i].stamina) === 'reliever',
            quality: compare ? qualityOf(i) : 0,
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
      maxFatigue = Math.max(maxFatigue, fatigueFromRemaining(remainingOf(current)));
    }
    return { maxFatigue, changes, downgrades, left: bullpen.length };
  };

  const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

  it('物差しは名鑑96人に散らばる（＝比較が成立する）', () => {
    // 2段目：無傷の質は 1.090〜2.620（中央値 1.760）
    const qualities = STAFFS.flat().map((p) => pitcherQuality(p, 0));
    expect(Math.min(...qualities)).toBeGreaterThan(0.8);
    expect(Math.max(...qualities)).toBeLessThan(3);
    expect(Math.max(...qualities) - Math.min(...qualities)).toBeGreaterThan(1);
  });

  it('疲労は質を単調に削り、良い投手ほど大きく落ちる（＝いつか必ず追い抜かれる）', () => {
    const ace = STAFFS.flat().reduce((a, b) => (pitcherQuality(a, 0) >= pitcherQuality(b, 0) ? a : b));
    const steps = [0, 0.25, 0.5, 0.75, 1].map((f) => pitcherQuality(ace, f));
    for (let i = 1; i < steps.length; i += 1) expect(steps[i]).toBeLessThan(steps[i - 1]);
    // 疲労MAXの落差は「球速0.35＋変化量そのもの＋制球0.35」＝名鑑の質の幅より大きい
    expect(steps[0] - steps[steps.length - 1]).toBeGreaterThan(1);
  });

  it('どの球団の先発も、疲れれば必ずリリーフの一番手に追い抜かれる（続投は必ず終わる）', () => {
    // 2段目：最後まで追い抜かれない球団は 0/16
    for (const pitchers of STAFFS) {
      const starter = pitchers[0];
      const rival = pitchers
        .slice(1)
        .sort(
          (a, b) =>
            Number(pitcherRole(b.stamina) === 'reliever') -
            Number(pitcherRole(a.stamina) === 'reliever'),
        )[0];
      expect(pitcherQuality(starter, 1)).toBeLessThanOrEqual(pitcherQuality(rival, 0));
    }
  });

  it('CPUの疲労が実際に発火する（W-44が残した部分＝このフェーズの目的）', () => {
    // 1・3段目：16球団の平均最大疲労 0.091 → 0.267／0.2を超える球団 11/16
    const before = mean(STAFFS.map((s) => playGame(s, false).maxFatigue));
    const after = mean(STAFFS.map((s) => playGame(s, true).maxFatigue));
    expect(before).toBeLessThan(0.15);
    expect(after).toBeGreaterThan(before * 2);
    expect(STAFFS.filter((s) => playGame(s, true).maxFatigue >= 0.2).length).toBeGreaterThan(
      STAFFS.length / 2,
    );
  });

  it('それでも振り切れはしない（＝ブルペンは尽きず、疲労1.0の投手を晒し続けない）', () => {
    for (const pitchers of STAFFS) {
      const r = playGame(pitchers, true);
      expect(r.maxFatigue).toBeLessThan(1);
      expect(r.left).toBeGreaterThan(0);
    }
  });

  it('質が下がる交代が無くなる（旧規則は交代の半分以上でこれをしていた）', () => {
    // 1段目：26/48 → 3段目：0/43
    const oldDown = STAFFS.reduce((a, s) => a + playGame(s, false).downgrades, 0);
    const oldChanges = STAFFS.reduce((a, s) => a + playGame(s, false).changes, 0);
    expect(oldDown).toBeGreaterThan(oldChanges / 2);
    expect(STAFFS.reduce((a, s) => a + playGame(s, true).downgrades, 0)).toBe(0);
  });

  it('交代そのものは死んでいない（どの球団も1試合に複数回代える）', () => {
    // 4段目：マージン0で 2.69回/球団。ここが0になるとJ-30の自動継投が実質消える
    for (const pitchers of STAFFS) expect(playGame(pitchers, true).changes).toBeGreaterThan(0);
  });

  it('上乗せ（マージン）は置かない＝良いほうを出すだけ', () => {
    // 4段目：0.40 まで上げても交代は残り「規則が死ぬ」基準では値が決まらなかったので、
    // 新しい自由変数を作らない 0 を採った（W-44 の FATIGUE_CONTROL_LOSS と同じ形）
    expect(CPU_RELIEF_QUALITY_MARGIN).toBe(0);
  });

  /**
   * DD-51：その物差しを**人間にも見せられるか**（`balance:relief` の7段目）。
   * Z-47 は合計だけを作って閉じたので、采配メニューには型と残量%しか出ていなかった。
   * 見せるのは合計ではなく足す前の3つ（`pitcherStuff`）を5目盛りのバーで。
   */
  const barIndex = (rating: number): number =>
    Math.max(0, Math.min(RATING_TICKS, Math.round(Math.max(0, Math.min(1, rating)) * RATING_TICKS)));
  const barSum = (s: PitcherStats, fatigue: number): number => {
    const stuff = pitcherStuff(s, fatigue);
    return barIndex(stuff.speed) + barIndex(stuff.breaking) + barIndex(stuff.control);
  };

  it('画面に出る3つの和が、CPUの物差しそのもの（割り戻しではない）', () => {
    for (const p of STAFFS.flat()) {
      for (const fatigue of [0, 0.5, 1]) {
        const stuff = pitcherStuff(p, fatigue);
        expect(stuff.speed + stuff.breaking + stuff.control).toBeCloseTo(
          pitcherQuality(p, fatigue),
          10,
        );
      }
    }
  });

  it('5目盛りで名鑑96人が潰れない（同じバーばかりなら見せても判断材料にならない）', () => {
    // 7段目(a)：キュウソク・ヘンカ・セイキュウとも3段階以上に散り、組み合わせは32通り
    const items: Array<(p: PitcherStats) => number> = [
      (p) => pitcherStuff(p, 0).speed,
      (p) => pitcherStuff(p, 0).breaking,
      (p) => pitcherStuff(p, 0).control,
    ];
    for (const pick of items) {
      expect(new Set(STAFFS.flat().map((p) => barIndex(pick(p)))).size).toBeGreaterThanOrEqual(3);
    }
    const patterns = new Set(
      STAFFS.flat().map((p) => items.map((pick) => barIndex(pick(p))).join('-')),
    );
    expect(patterns.size).toBeGreaterThan(10);
  });

  it('バーとCPUの結論が食い違うのは、1目盛りより小さい差のときだけ（画面が嘘をつかない）', () => {
    // 7段目(b)：2880場面で 一致93.2% / 同じ長さ6.1%（実差≤0.297）/ 逆0.7%（実差≤0.165）。
    // **「逆を指す場面が0」は成り立たない**（丸めがある以上あたりまえ）ことを計測が示したので、
    // 帯は「食い違いの大きさが読み取り単位（1目盛り＝質0.6点）未満」で張る。
    const tick = 3 / RATING_TICKS;
    let worst = 0;
    for (const pitchers of STAFFS) {
      for (const current of pitchers) {
        for (const fatigue of [0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
          for (const rival of pitchers) {
            if (rival === current) continue;
            const gap = pitcherQuality(rival, 0) - pitcherQuality(current, fatigue);
            const bars = barSum(rival, 0) - barSum(current, fatigue);
            // バーが「同じ」または「逆」を指した場面だけを数える
            if (bars === 0 || bars > 0 !== gap > 0) worst = Math.max(worst, Math.abs(gap));
          }
        }
      }
    }
    expect(worst).toBeLessThan(tick);
  });
});

describe('投球腕（CC-50。`npm run balance:arm` で測った帯）', () => {
  /** 名鑑96人 */
  const PITCHERS = TEAMS.flatMap((t) => t.pitchers.map((r) => pitcherRowPitching(r)));
  /** 全カウント（`chooseCpuPitchPlan` の3区分をすべて含む12通り） */
  const COUNTS = Array.from({ length: 4 }, (_, balls) =>
    Array.from({ length: 3 }, (_, strikes) => ({ balls, strikes })),
  ).flat();

  const profileOf = (p: PitcherStats, fatigue: number) => ({
    speed: fatiguedSpeed(p.speed, fatigue),
    breakLeft: fatiguedBreak(p.breakLeft, fatigue),
    breakRight: fatiguedBreak(p.breakRight, fatigue),
    fork: fatiguedBreak(p.fork, fatigue),
  });

  /** 腕を入れる前後で「球の形」がどれだけ変わったか（本塁通過位置は必ず不変） */
  const compare = (fatigue: number) => {
    let clipped = 0;
    let total = 0;
    let worstDelta = 0;
    let worstRatio = 0;
    for (const p of PITCHERS) {
      const profile = profileOf(p, fatigue);
      const control = fatiguedControl(pitcherControl(p.era), fatigue);
      const offset = armReleaseOffsetX(pitchArmOf(p.throws));
      for (const count of COUNTS) {
        const plan = chooseCpuPitchPlan(count, cpuPitcherStyle(profile), control);
        const base = planCpuPitchShape(plan, profile);
        const arm = planCpuPitchShape(plan, profile, undefined, offset);
        total += 1;
        if (Math.abs(arm.breakWidth - base.breakWidth) > 1e-6) clipped += 1;
        worstDelta = Math.max(worstDelta, Math.abs(arm.breakWidth - base.breakWidth));
        worstRatio = Math.max(worstRatio, arm.steerSec / arm.flightSec);
      }
    }
    return { clipped, total, worstDelta, worstRatio };
  };

  /**
   * このフェーズのいちばん強い不変条件＝**狙うコースは1行も触っていない**ので、
   * I-29 の打たれ方も T-41 の死球の帰結も原理的に動かない（`sweep.ts` の分母に
   * 投球のコースが入っていないのと同じ理由で、ここは実測でも完全一致する）。
   */
  it('CPUの本塁通過位置は腕によって変わらない', () => {
    for (const p of PITCHERS.slice(0, 24)) {
      const profile = profileOf(p, 0);
      const offset = armReleaseOffsetX(pitchArmOf(p.throws));
      for (const count of COUNTS) {
        const plan = chooseCpuPitchPlan(count, cpuPitcherStyle(profile), pitcherControl(p.era));
        const arm = planCpuPitchShape(plan, profile, undefined, offset);
        expect(arm.releaseX + arm.steerX * arm.breakWidth).toBeCloseTo(plan.targetX, 6);
      }
    }
  });

  /**
   * 2段目：採用値で削られるのは **2球/1152（Z-47が測ったCPUの最大疲労0.600でも）・
   * 最大2cm**。P-37 が守りたかったもの（名鑑の変化量が球の差になること）は無傷。
   */
  it('プレートの端で削られる球は例外にとどまる（名鑑の変化量の差は消えない）', () => {
    for (const fatigue of [0, 0.267, 0.6]) {
      const { clipped, total, worstDelta } = compare(fatigue);
      expect(clipped).toBeLessThan(total * 0.01);
      expect(worstDelta).toBeLessThan(0.05);
    }
  });

  /**
   * P-37 のもう1つの条件（桜井ノウハウ「人に反応できない動作をするとすっごい理不尽感」）。
   * 曲げ終わりが飛行の2割を超えないうちは、スイングを決める時点でもう直線になっている。
   */
  it('曲げ終わりの時刻は動かない（見てから振れる、が保たれる）', () => {
    for (const fatigue of [0, 0.267, 0.6]) expect(compare(fatigue).worstRatio).toBeLessThan(0.2);
  });

  /**
   * 実寸（肩0.20＋腕0.625＝0.825m）のまま入れたらどうなるかの記録＝
   * **なぜ縮めてあるのか**の根拠（`ARM_RELEASE_REACH` のコメント）。
   */
  it('実寸のまま入れると名鑑の変化量の差が実際に消える（縮めてある理由）', () => {
    const lifeSize = 0.825 / Math.sin(ARM_SLOT_RAD.side);
    let clipped = 0;
    let total = 0;
    for (const p of PITCHERS) {
      const profile = profileOf(p, 0);
      const arm = pitchArmOf(p.throws);
      const offset = arm.side * lifeSize * Math.sin(ARM_SLOT_RAD[arm.slot]);
      for (const count of COUNTS) {
        const plan = chooseCpuPitchPlan(count, cpuPitcherStyle(profile), pitcherControl(p.era));
        const base = planCpuPitchShape(plan, profile);
        const withArm = planCpuPitchShape(plan, profile, undefined, offset);
        total += 1;
        if (Math.abs(withArm.breakWidth - base.breakWidth) > 1e-6) clipped += 1;
      }
    }
    // 採用値の20倍以上の球が削られる（2/1152 → 45/1152）
    expect(clipped).toBeGreaterThan(compare(0).clipped * 20);
    expect(total).toBe(PITCHERS.length * COUNTS.length);
  });
});

describe('代打の表に走力を足す（EE-52。`npm run balance:offense` の15段目で測った帯）', () => {
  /** 名鑑16球団の野手176人（打線128＋控え48）の走力 */
  const RUNS = [
    ...TEAMS.flatMap((t) => t.lineup.map((r) => fielderRowStats(r).run)),
    ...TEAMS.flatMap((t) => t.bench.map((r) => benchRowStats(r).run)),
  ];
  /** 塁間（走者が1つ進むのに要る距離）＝走力の差を「秒」で読むための物差し */
  const BASE_LEG = distance(BASE_POSITIONS.first, BASE_POSITIONS.second);
  const ticksOf = (rating: number): number => (ratingBar(rating).match(/●/g) ?? []).length;
  const legSec = (run: number): number => BASE_LEG / runnerSpeed(run);

  it('5目盛りで名鑑176人が潰れない（同じバーばかりなら見せても判断材料にならない）', () => {
    // 15段目(a)：10.8% / 25.6% / 34.1% / 24.4% / 5.1% の5段階に散る
    expect(new Set(RUNS.map(ticksOf)).size).toBeGreaterThanOrEqual(4);
  });

  it('走力の列は飾りにならない＝どの球団でも「打つ力best」と「走力best」が別人', () => {
    // 15段目(b)：16/16球団。CPUの代打（X-45）は AV+HR だけを見るので、この列は
    // **人間だけが見る材料**になる＝「打つ力で選ぶか、足で選ぶか」が判断として残る
    for (const team of TEAMS) {
      const bench = team.bench.map(benchRowStats);
      const byBat = bench.reduce((a, b) => (b.average + b.power > a.average + a.power ? b : a));
      const byRun = bench.reduce((a, b) => (b.run > a.run ? b : a));
      expect(byRun).not.toBe(byBat);
      // 足で選べば塁間で買える時間（最大0.46秒＝盗塁・余分な進塁の可否が変わる大きさ）
      expect(legSec(byBat.run) - legSec(byRun.run)).toBeGreaterThan(0);
    }
  });

  it('同じ長さに見える2人の差は、人の反応時間より小さい（画面が嘘をつかない）', () => {
    // 15段目(c)：同じ目盛りの塁間の差は最大0.13秒。DD-51が投手側で立てたのと同じ基準
    // （食い違いが読み取り単位より小さいこと）を、走力の側でも張る
    let worst = 0;
    for (const a of RUNS) {
      for (const b of RUNS) {
        if (ticksOf(a) !== ticksOf(b)) continue;
        worst = Math.max(worst, Math.abs(legSec(a) - legSec(b)));
      }
    }
    expect(worst).toBeLessThan(0.2);
  });
});

describe('代走（GG-54。`npm run balance:pinchrun` で測った帯）', () => {
  /** 走力（RUN）→ その足で一塁から走ったときに守備に残る余裕（秒）＝R-39の式そのもの */
  const slackFor = (run: number): number =>
    cpuStealDefenseSlack('first', { speedOf: () => runnerSpeed(run) });
  /** その足なら盗塁を仕掛ける値打ちがあるか（R-39の規則そのもの） */
  const canSteal = (run: number): boolean => slackFor(run) <= CPU_STEAL_MAX_DEFENSE_SLACK_SEC;

  it('足を買って帯をまたげるのは一塁の走者だけ（＝規則が塁ごとの分岐を持たない根拠）', () => {
    // 1段目・13段目(a)：一塁は走力1.0で -0.08秒（またぐ）／二塁→三塁は +0.26秒＝
    // **どんな俊足でも刺される**（R-39が既に確定させている）ので、二塁の走者に足を
    // 買っても盗塁の帯は開かない
    expect(canSteal(1)).toBe(true);
    expect(canSteal(0)).toBe(false);
    expect(
      cpuStealDefenseSlack('second', { speedOf: () => runnerSpeed(1) }),
    ).toBeGreaterThan(CPU_STEAL_MAX_DEFENSE_SLACK_SEC);
  });

  it('代走で買えるのは「塁間 0.6〜0.8秒」＝4つの帯すべてに一様に効く', () => {
    // 1段目：鈍足4.03秒 → 俊足3.34秒（差0.69秒）。盗塁・余分な進塁・タッチアップ・
    // けん制のどれもこの1つの差から動く（代走は新しい仕組みを1つも足していない）
    const gain =
      BASE_PATH / runnerSpeed(0) - BASE_PATH / runnerSpeed(1);
    expect(gain).toBeGreaterThan(0.6);
    expect(gain).toBeLessThan(0.8);
  });

  // BBB-77〜81 の間は打線がほとんど点を取れず、この帯は崩れていた（`it.fails`）。野手の足を
  // 原作の 6.0m/s にした BBB-82 で攻撃が戻り、利得 +0.18点 に対して費用 0.74点（残り9イニング）。
  it('走力だけを見る規則は損（＝代走は「走力を買って打力を売る」手）', () => {
    // 10段目：利得（盗塁が1つ成立）+0.112点 に対し、**いちばん遅い走者をいちばん速い
    // 控えに代える**という走力だけの打ち手は、残り9イニングで 0.897点も打力を失う。
    // **この非対称がCPUの規則に打力の条件が要る理由**なので、名鑑の実際の打線で張る
    // （合成した打線では「遅い＝強打者」という名鑑の相関が再現できない）。
    const average = distributionFor(0.5, { average: 0.5 });
    const runTable = solveRunExpectancy(average);
    const stealGain = runTable[0][2] - runTable[0][1]; // 一塁 → 二塁
    expect(stealGain).toBeGreaterThan(0);

    const team = teamById('irons');
    const batters = [
      ...team.lineup.map((r) => fielderRowStats(r)),
      pitcherRowBatting(team.pitchers[0]),
    ];
    const fastest = team.bench
      .map(benchRowStats)
      .reduce((a, b) => (b.run > a.run ? b : a));
    let slot = 0;
    for (const [i, b] of batters.entries()) if (b.run < batters[slot].run) slot = i;

    const before = batters.map((b) => distributionFor(b.power, { average: b.average }));
    const after = [...before];
    after[slot] = distributionFor(fastest.power, { average: fastest.average });
    const cost = solveLineup(before, 9).runs - solveLineup(after, 9).runs;
    expect(cost).toBeGreaterThan(stealGain);
  }, 20000);

  it('しきい値（0.10）まで差し出す控えなら、終盤に出すぶんには損しない', () => {
    // 12段目：0.10 の保証は**フェーズJJ-57で「残り3イニングなら100%」に弱まった**
    // （空気抵抗で長打が減り、盗塁1つの値打ちが +0.112点 → +0.069点になったため。
    // 残り9イニングでは98.0%）。**代走が実際に効くのは終盤**なので値は据え置いた
    // （100%を取り戻すには 0＝打力を1ミリも落とさない、まで絞るしかない）。
    const average = distributionFor(0.5, { average: 0.5 });
    const runTable = solveRunExpectancy(average);
    const stealGain = runTable[0][2] - runTable[0][1];

    const lineup = new Array(9).fill(average);
    const swapped = [...lineup];
    // AV+HR の合計をちょうど CPU_PINCH_RUN_BAT_LOSS だけ落とす控え
    swapped[0] = distributionFor(0.5 - CPU_PINCH_RUN_BAT_LOSS / 2, {
      average: 0.5 - CPU_PINCH_RUN_BAT_LOSS / 2,
    });
    const cost = solveLineup(lineup, 3).runs - solveLineup(swapped, 3).runs;
    // **費用が利得を下回る**ことがこの規則の条件そのもの。粗い格子では費用がわずかに
    // 負に出る（＝差し出したほうが得）ことすらあるが、それは結論を強める側なので
    // 下限は置かない（このファイルの方針＝守るのは大小関係）。
    expect(cost).toBeLessThan(stealGain);
  });

  it('名鑑16球団すべてに「出す値打ちのある組み合わせ」がある（規則が死んでいない）', () => {
    // 13段目(b)：球団ごとに2〜5組。控えが売りのナイツも、薄い球団も0にはならない
    for (const team of TEAMS) {
      const lineup = [
        ...team.lineup.map((r) => fielderRowStats(r)),
        pitcherRowBatting(team.pitchers[0]),
      ];
      const bench = team.bench.map(benchRowStats);
      let fired = 0;
      for (const out of lineup) {
        for (const b of bench) {
          if (canSteal(out.run) || !canSteal(b.run)) continue;
          if (out.average + out.power - (b.average + b.power) > CPU_PINCH_RUN_BAT_LOSS) continue;
          fired += 1;
        }
      }
      expect(fired).toBeGreaterThan(0);
    }
  });
});

/**
 * 打席まるごとの帯（SS-67 → TT-68 → **AAA-75**。`npm run balance:plate`）。
 *
 * AAA-75 で CPU打者は**直前のストライクの速さに合わせ、人間並みにぶれる**ようになった
 * ので、同じ対戦でも打席ごとに結果が散る。ここでは**1本のぶれの系列を共有して各対戦を
 * `PLATE_REPS` 回ずつ**回す（系列はシードで決まる＝何度回しても同じ数字）。
 */
const PLATE_REPS = 4;
const plateAtBats = (opts: AtBatOptions = {}, seed = 1) => {
  const noise = swingNoiseStream(seed);
  return TEAMS.map((t) => createTeamRoster(teamById(t.id)))
    .map((off, i, all) => {
      const def = all[(i + 1) % all.length];
      const pitcher = def.players[def.pitcher].pitching!;
      return off.lineup.flatMap((id) =>
        Array.from({ length: PLATE_REPS }, () =>
          simulateAtBat(pitcher, off.players[id].batting, { ...opts, noise }),
        ),
      );
    })
    .flat();
};
/** 人間がある配球の形を投げ続けたとき（1文字目＝緩急 F/N/S、2文字目＝コース m/b） */
const humanAtBats = (pattern: readonly string[]) => {
  const sel: Record<string, -1 | 0 | 1> = { F: -1, N: 0, S: 1 };
  const loc: Record<string, number> = { m: 0, b: -0.43 };
  return plateAtBats({
    humanPitch: (_: unknown, i: number) => {
      const tok = pattern[i % pattern.length];
      return { selection: sel[tok[0]], localX: loc[tok[1]] };
    },
  }, 7);
};
const rateOf = (rs: readonly AtBatResult[], pred: (r: AtBatResult) => boolean) =>
  rs.filter(pred).length / rs.length;
const avgOf = (rs: readonly AtBatResult[]) =>
  rs.filter((r) => r.kind === 'inPlay' && r.outcome !== 'out').length /
  Math.max(1, rs.filter((r) => r.kind !== 'walk' && r.kind !== 'hitByPitch').length);

describe('CPU打者の選球と空振り（SS-67 → AAA-75。`npm run balance:plate` で測った帯）', () => {
  /**
   * QQ-65 が計測で見つけた構造＝**CPU打者は三振も四球もしない**（1打席1.51球で必ず
   * 打球になり、見送りは0.00球）を埋めたのが SS-67。ここで固定するのは値そのものでは
   * なく「**4つの帰結がどれも実際に起きること**」と「**打席が必ず終わること**」。
   */
  it('三振も四球も実際に起きる（SS-67の前はどちらも0%だった）', () => {
    const rs = plateAtBats();
    expect(rateOf(rs, (r) => r.kind === 'strikeout')).toBeGreaterThan(0);
    expect(rateOf(rs, (r) => r.kind === 'walk')).toBeGreaterThan(0);
    // **AAA-75で打球が主役に戻った**（UU-69の 47.9% → 70%台）＝CPU打者がストライクに
    // 手を出すようになり、三振は「緩急とぶれ」からだけ生まれる
    expect(rateOf(rs, (r) => r.kind === 'inPlay')).toBeGreaterThan(0.55);
  });

  it('打席は必ず終わる（ファウルの無限ループが構造的に無い）', () => {
    // SS-67 の前は 144打席のうち5打席が上限（40球）に張り付いていた。AAA-75の前は、人間が
    // ど真ん中のフォークを投げ続けると37.5%の打席が終わらなかった（下の describe で見る）。
    for (const r of plateAtBats()) expect(r.pitches).toBeLessThan(15);
  });

  it('CPU打者はボール球を見送る（＝四球という帰結の入口）', () => {
    const rs = plateAtBats();
    const takes = rs.reduce((sum, r) => sum + r.takes, 0) / rs.length;
    expect(takes).toBeGreaterThan(0.2);
  });

  it('**同じ速さを続けられると芯で捉える**（フォークにも速球にも「投げ続ければ勝てる」は無い）', () => {
    // SS-67 は「フォークを投げ続けるのが人間の支配戦略」を、TT-68/UU-69 は「速球を投げ
    // 続けるのが支配戦略」（ど真ん中の速球×3で三振86%）を残していた。AAA-75 以降、
    // 待っていた速さの球は芯（t=0）＝**どの球も、続ければ捉えられる**。
    for (const v of [SPEED_SLOW, SPEED_NEUTRAL, SPEED_FAST]) {
      expect(cpuSwingLead(v, SPEED_NEUTRAL, v)).toBeCloseTo(SWING_IDEAL_SEC, 10);
    }
  });

  it('ずれは有効窓からの導出（緩急1段＝窓の1/3＝TT-68の梯子の1段）', () => {
    expect(CPU_TIMING_PENALTY_SEC).toBeCloseTo(SWING_ACTIVE_SEC / 3, 10);
    // **1段の変化だけでは空振りさせられない**（芯から縁までの内側）
    expect(CPU_TIMING_PENALTY_SEC).toBeLessThan(SWING_ACTIVE_SEC / 2);
    // ぶれは UU-69 が有効窓を決めたときの人間の σ（新しい数値を持ち込んでいない）
    expect(CPU_SWING_SIGMA_SEC).toBeCloseTo(0.04, 10);
  });

  it('CPU投手の配球は、引数を渡さなければSS-67の前と完全に同じ（基準線）', () => {
    for (const balls of [0, 1, 2, 3]) {
      for (const strikes of [0, 1, 2]) {
        const count = { balls, strikes };
        expect(chooseCpuPitchPlan(count, 'balanced', NEUTRAL_RATING, 0)).toEqual(
          chooseCpuPitchPlan(count, 'balanced', NEUTRAL_RATING),
        );
      }
    }
  });

  it('ファウルで粘られると隅が入れ替わる（＝同じ球を投げ続けない）', () => {
    const count = { balls: 0, strikes: 2 };
    const first = chooseCpuPitchPlan(count, 'balanced', NEUTRAL_RATING, 0).targetX;
    const afterFoul = chooseCpuPitchPlan(count, 'balanced', NEUTRAL_RATING, 1).targetX;
    expect(Math.sign(afterFoul)).toBe(-Math.sign(first));
    expect(Math.abs(afterFoul)).toBeCloseTo(Math.abs(first), 10);
  });
});

describe('三振・四球の帯（TT-68 → AAA-75。`npm run balance:plate` の1・10段目で測った帯）', () => {
  /**
   * TT-68 は三振・四球を実際の野球の帯（22% / 8.5%）へ寄せたが、それは**決定的なCPU打者が
   * 0.40 ちょうどで振る／振らないを切り替える「階段」の上**に乗っていた（採用値の帯は
   * 2.5mm）。UU-69 で有効窓を狭めた途端に三振 39.6% へ飛んだのもこの階段のせい。
   *
   * AAA-75 でぶれが入ったので階段は消えた。代わりに**三振は実際の野球より少ない側**
   * （先発相手で 15%前後。実際は22%）に来ている＝CPU打者は**ストライクに必ず手を出す**
   * （様子見で見送るストライクが無い）ので、打席が短い。**ここは「まだ届いていない」帯**。
   */
  it('通常の球は「隅の1つ内側」＝決め球とゾーンを挟んで対称の梯子（新しい定数を持たない）', () => {
    expect(NORMAL_TARGET_X).toBeCloseTo(STRIKE_ZONE_HALF_WIDTH - CORNER_MARGIN, 10);
    expect(NORMAL_TARGET_X).toBeLessThan(STRIKE_ZONE_HALF_WIDTH);
    // **AAA-75 から CPU打者はゾーンいっぱいに手を出す**＝通常の球は「振られる隅」
    // （TT-68 までは「振られずにストライクになる帯」だった＝人間が真似すれば必勝配球）
    expect(SELECTIVE_HALF_WIDTH).toBeCloseTo(STRIKE_ZONE_HALF_WIDTH, 10);
    expect(NORMAL_TARGET_X).toBeLessThan(SELECTIVE_HALF_WIDTH);
  });

  it('打席がカウントの分岐へ届く（T-41の決め球・3ボールの置き球が実戦で投げられる条件）', () => {
    const rs = plateAtBats();
    // SS-67 の実測は 2ストライク到達 12.5% / 3ボール到達 6.3% ＝ほとんど届いていなかった。
    // **BBB-79 でファウルフライも捕れるようになった**ので、2ストライクの前にファウルフライで
    // 終わる打席が出る（同じ標本で 36%→29%。実際の野球と同じく粘る前に打ち取られる）
    expect(rateOf(rs, (r) => r.maxStrikes >= 2)).toBeGreaterThan(0.25);
    expect(rateOf(rs, (r) => r.maxBalls >= 3)).toBeGreaterThan(0.08);
  });

  it('三振・四球・球数（実際の野球は 22% / 8.5% / 3.9球。三振・四球・球数は少ない側）', () => {
    const rs = plateAtBats();
    const k = rateOf(rs, (r) => r.kind === 'strikeout');
    expect(k).toBeGreaterThan(0.08);
    // UU-69 の 39.6%（すべて空振り＝2ストライクの速球が必ず空振り）へは戻らない
    expect(k).toBeLessThan(0.3);
    // **CCC-86 で四球も少ない側になった**（CPU同士で 8.3%→3%）：追い込んだ1球の3回に1回が
    // 勝負球（ゾーンの隅）になり、CPU打者は追い込まれたら隅の1つ外（0.50）まで必ず手を出す
    // （SS-67）＝四球の入口だった「荒れた投手の外へ逃げる決め球を見送る」が減った。
    // 画面には出ない（CPU打者が相手にするのは人間の投手の配球）。人間の打者は見極めれば
    // 四球を取れる（`balance:pace` の5段目＝ゾーンの球だけを振る打者は四死球 5〜7%）
    expect(rateOf(rs, (r) => r.kind === 'walk')).toBeGreaterThan(0.015);
    expect(rateOf(rs, (r) => r.kind === 'walk')).toBeLessThan(0.13);
    // 配球のくじを入れる前（いつもの形）なら、四球は実際の野球の帯にいた
    const before = plateAtBats({ mixes: null });
    expect(rateOf(before, (r) => r.kind === 'walk')).toBeGreaterThan(0.04);
    const pitches = rs.reduce((sum, r) => sum + r.pitches, 0) / rs.length;
    expect(pitches).toBeGreaterThan(2.3);
    expect(pitches).toBeLessThan(4.5);
  });

  it('打球も長打も**本塁打も**消えていない（UU-69の「CPU打線の本塁打0本/試合」の解消）', () => {
    const rs = plateAtBats();
    expect(rateOf(rs, (r) => r.kind === 'inPlay')).toBeGreaterThan(0.55);
    // AAA-75の前はCPUが速球を前へ飛ばせず、本塁打は1本も出なかった。いまは30〜60打席に1本
    expect(rateOf(rs, (r) => r.outcome === 'homerun')).toBeGreaterThan(0.005);
    expect(rateOf(rs, (r) => r.outcome === 'homerun')).toBeLessThan(0.06);
    // 死球は例外のまま（T-41＝寄って立った打者に決め球が当たる。実際の野球は0.4%）
    expect(rateOf(rs, (r) => r.kind === 'hitByPitch')).toBeLessThan(0.08);
  });

  it('打席は必ず終わる（狙いを動かしてもファウルの無限ループは戻らない）', () => {
    for (const r of plateAtBats({ aims: { normalTarget: STRIKE_ZONE_HALF_WIDTH } })) {
      expect(r.pitches).toBeLessThan(15);
    }
  });
});

describe('人間の決まった配球に必勝の形が無い（AAA-75。`npm run balance:plate` の15段目）', () => {
  /**
   * AAA-75の前は、人間の投手に**必勝の配球**があった：ど真ん中の速球×3＝三振86%・安打0／
   * ど真ん中のフォークを投げ続けると37.5%の打席が終わらない／0.40〜0.45 の帯へ投げれば
   * 見逃しストライクを取り放題。**決定的なCPU打者には、どう規則を作っても何かが残る**
   * （35通り試した）ので、CPU打者に人間並みのぶれを入れた。ここで固定するのは
   * **「どの決まった形も、毎打席は勝てない」**こと。
   */
  const PATTERNS: readonly (readonly string[])[] = [['Fm'], ['Sm'], ['Fb'], ['Fm', 'Sm'], ['Sm', 'Fm']];

  it('どの形でも三振は半分に届かず、打率は下がり切らない', () => {
    for (const p of PATTERNS) {
      const rs = humanAtBats(p);
      expect(rateOf(rs, (r) => r.kind === 'strikeout')).toBeLessThan(0.45);
      expect(avgOf(rs)).toBeGreaterThan(0.05);
      for (const r of rs) expect(r.pitches).toBeLessThan(15);
    }
  }, 20000);

  it('**ど真ん中の速球を続けると打たれる**（AAA-75の前は三振86%・安打0）', () => {
    const rs = humanAtBats(['Fm']);
    expect(avgOf(rs)).toBeGreaterThan(0.3);
    expect(rateOf(rs, (r) => r.kind === 'strikeout')).toBeLessThan(0.2);
  });

  it('速さを変えれば崩せる（交互に投げると、続けるより三振が増える）', () => {
    const repeat = humanAtBats(['Fm']);
    const mix = humanAtBats(['Fm', 'Sm']);
    expect(rateOf(mix, (r) => r.kind === 'strikeout')).toBeGreaterThan(
      rateOf(repeat, (r) => r.kind === 'strikeout'),
    );
  }, 20000);
});

describe('リフレッシュレートによらない（AAA-75の不具合。`npm run balance:plate` の14段目）', () => {
  /**
   * AAA-75の前、CPUのスイングは**判断したフレームの先頭から振り始めた**扱い（最大1フレーム
   * 早い）で、投球の横移動も**1フレームぶん先の速度で進んでいた**。どちらもずれの量が
   * フレームの長さそのものなので、**画面のリフレッシュレートで結果が変わった**。
   */
  const keyOf = (r: AtBatResult) => `${r.kind}:${r.outcome}:${r.pitches}`;

  it('60Hzと144Hzで、同じぶれの打席の大半がまったく同じ結果になる', () => {
    const a = plateAtBats({ dt: 1 / 60 }, 11).map(keyOf);
    const b = plateAtBats({ dt: 1 / 144 }, 11).map(keyOf);
    const same = a.filter((k, i) => k === b[i]).length / a.length;
    // 残る差は 0.5mm 以下の軌道の違いが打球の境目（捕れる／捕れない）に当たった打席だけ
    expect(same).toBeGreaterThan(0.85);
    // 旧（フレームの先頭から振り出す）では 3割も揃わなかった
    const oldA = plateAtBats({ dt: 1 / 60, legacyFrameStart: true }, 11).map(keyOf);
    const oldB = plateAtBats({ dt: 1 / 144, legacyFrameStart: true }, 11).map(keyOf);
    expect(oldA.filter((k, i) => k === oldB[i]).length / oldA.length).toBeLessThan(0.5);
  }, 20000);
});

describe('人間の空振りとホームラン（UU-69。`npm run balance:plate` の14段目で測った帯）', () => {
  /**
   * テストプレイの2件（「そもそも空振りすることがほぼない」「ホームランが若干しか
   * 変わっていない」）。**1〜13段目はCPU打者か「人間が芯（t=0）で捉えたとき」しか
   * 測っていなかった**＝**人間が押すタイミングにばらつきがあるとき**の帰結は
   * 一度も測られていなかった（QQ-65がCPU側で見つけたのと同じ穴の、人間側の分）。
   */
  it('有効窓は「押す時刻の許容」そのもの＝狙う時刻は動かない', () => {
    // 人間が合わせるのは `SWING_IDEAL_SEC`（押してからジャストミートまで）で、
    // **窓を狭めてもここは動かない**＝「同じタイミングで押す、ただし許容が狭くなる」。
    expect(SWING_IDEAL_SEC).toBeCloseTo(0.09, 10);
    expect(SWING_STARTUP_SEC).toBeCloseTo(SWING_IDEAL_SEC - SWING_ACTIVE_SEC / 2, 10);
    // 押せる幅は ±45ms＝14段目の実測で空振り 25.1%（σ=40ms）＝実際の野球の約25%
    expect(SWING_ACTIVE_SEC / 2).toBeLessThanOrEqual(0.045);
    // 狭すぎない（±40ms を下回ると σ=40ms で空振りが 31.9% まで増える）
    expect(SWING_ACTIVE_SEC / 2).toBeGreaterThanOrEqual(0.04);
  });

  it('打球の質は有効窓に依存しない（窓が動かすのは「当たるかどうか」だけ）', () => {
    // `timing` は窓で正規化されるので、**同じ正規化タイミングなら同じ打球**になる。
    // これが崩れると「窓を狭めたらHR率まで動いた」ことになり、14段目の読み方が壊れる。
    for (const t of [0, 0.25, 0.5, 0.75]) {
      const launch = judgeSwing(
        { crossX: 0, swingTime: SWING_IDEAL_SEC + t * (SWING_ACTIVE_SEC / 2), pitchSpeed: SPEED_NEUTRAL },
        { power: 0.5, average: 0.5 },
      );
      expect(launch).not.toBeNull();
      // 芯からのずれが大きいほど弱い（正規化タイミングだけで決まる）
      if (t > 0) {
        const sweet = judgeSwing(
          { crossX: 0, swingTime: SWING_IDEAL_SEC, pitchSpeed: SPEED_NEUTRAL },
          { power: 0.5, average: 0.5 },
        )!;
        expect(Math.hypot(launch!.vx, launch!.vy, launch!.vz)).toBeLessThan(
          Math.hypot(sweet.vx, sweet.vy, sweet.vz),
        );
      }
    }
  });

  it('芯で捉えた打球はまだ柵を越える（＝抗力を上げてもHRが消えていない）', () => {
    // `AIR_DRAG` 0.0012→0.0016 で削ったのは**本数**で、**強打者が芯で捉えれば越える**
    // という構造は残す（RR-66が「打者の差」を作ったところは崩さない）。
    const strong = judgeSwing(
      { crossX: 0, swingTime: SWING_IDEAL_SEC, pitchSpeed: SPEED_FAST },
      { power: 1, average: 0.5 },
    )!;
    let ball = createBattedBall(strong, 0);
    for (let i = 0; i < 10000 && !ball.resting && ball.over === null; i += 1) {
      ball = stepBattedBall(ball, 1 / 60, DEFAULT_BALLPARK);
    }
    expect(ball.over).toBe('fly');
  });
});
