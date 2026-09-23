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
import { describe, expect, it } from 'vitest';
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
  CPU_TIMING_PENALTY_SEC,
  SELECTIVE_HALF_WIDTH,
  chooseCpuStance,
  cpuSwingLead,
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
import { CPU_POSSESSED_REACTION_SEC, SIM_DT, simulatePlay } from '../tools/balance/sim';
import { simulateAtBat } from '../tools/balance/atbat';
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
const STEPS = 6;

const hitter = (power: number, average = 0.5) => ({ power, average });

/** 同じ条件を何度も測るのでまとめる */
function measure(opts: {
  park?: Ballpark;
  power: number;
  average?: number;
  pitchSpeed?: number;
  catchBonus?: (id: FielderId) => number;
  runnerSpeed?: number;
}): SweepSummary {
  return summarize(
    sweep({
      park: opts.park ?? DEFAULT_BALLPARK,
      batter: hitter(opts.power, opts.average),
      pitchSpeed: opts.pitchSpeed,
      catchBonus: opts.catchBonus,
      runnerSpeed: opts.runnerSpeed,
      steps: STEPS,
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

  it('CPU打者は速球を本塁打にできない（過去に潰した「CPUの速球HR連発」の回帰防止）', () => {
    // CPU打者は `cpuSwingLead` の1点でしか振らないので、**その1点の帰結**が
    // そのままCPUの打球になる。速球には早振りのペナルティが乗る＝弱い当たりになる、
    // というのが cpuBatter.ts の設計意図そのもの。
    //
    // **QQ-65：ここは「1点だけ」を見ていたので穴があった**。実機のスイングは lead
    // ちょうどではなく **lead 〜 lead+1フレーム** に散る（`batting.update` が
    // `pitching.update` の後で swingT を進めるため）し、名鑑の速球は 47.5m/s まである。
    // その帯を舐めると、旧値（減衰0.30）では両翼の柵へ届いていた（`npm run balance:plate`）。
    const worstCarry = (
      batter: { power: number; average: number },
      pitchSpeed: number,
    ): { carry: number; homerun: boolean } => {
      let carry = 0;
      let homerun = false;
      for (let frac = 0; frac <= 1.0001; frac += 0.05) {
        const launch = judgeSwing(
          { crossX: 0, swingTime: cpuSwingLead(pitchSpeed) + frac * SIM_DT, pitchSpeed },
          batter,
        );
        if (!launch) continue;
        const play = simulatePlay(launch, 0, { park: DEFAULT_BALLPARK });
        carry = Math.max(carry, play.carry);
        if (play.outcome.kind === 'homerun') homerun = true;
      }
      return { carry, homerun };
    };
    // 名鑑でいちばん速い投手の速球（＝いちばん飛ぶ球）でも、平均的な打者は越えられない
    const fastest = speedForPitchSelection(-1, 0.96);
    expect(worstCarry(hitter(0.5), fastest).homerun).toBe(false);
    expect(worstCarry(hitter(0.5), SPEED_FAST).homerun).toBe(false);
    // **強打者は越えうる**＝速球を置きにいくリスクそのものは消えていない
    expect(worstCarry(hitter(0.8, 0.7), fastest).homerun).toBe(true);
    // 早振りのぶん、実際に引っ張り方向へ飛んでいる（ペナルティが効いている証拠）
    const launch = judgeSwing(
      { crossX: 0, swingTime: cpuSwingLead(SPEED_FAST), pitchSpeed: SPEED_FAST },
      hitter(0.5),
    );
    expect(launch).not.toBeNull();
    expect(simulatePlay(launch!, 0, { park: DEFAULT_BALLPARK }).directionDeg).toBeLessThan(-20);
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

  it('CPU打者は基準速ならジャストミートする（速球以外にペナルティは無い）', () => {
    const timing = (cpuSwingLead(SPEED_NEUTRAL) - SWING_IDEAL_SEC) / (SWING_ACTIVE_SEC / 2);
    expect(timing).toBeCloseTo(0);
  });
});

describe('好調＝ゼッコーチョー／ラッキー7（D-19の未確認事項「+0.2 という幅が妥当か」）', () => {
  it('好調の打者は本塁打も安打も明確に増える（「今日はこの打者が来ている」が分かる幅）', () => {
    const plain = measure({ power: 0.5, average: 0.5 });
    const hot = measure({
      power: 0.5 + (HOT_MODIFIER.power ?? 0),
      average: 0.5 + (HOT_MODIFIER.average ?? 0),
    });
    expect(hot.homerunRate).toBeGreaterThan(plain.homerunRate);
    expect(hot.hitRate).toBeGreaterThan(plain.hitRate);
  });

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
    expect(base.hitRate - all.hitRate).toBeGreaterThan(0.05);
  });
});

describe('走力とバイク（B-8の設計不変条件とF-26-3の未確認事項）', () => {
  it('走力が上がるほど内野安打が増える（RUNが全走者に効いている）', () => {
    const slow = measure({ power: 0.5, runnerSpeed: RUNNER_SPEED_MIN });
    const mid = measure({ power: 0.5, runnerSpeed: RUNNER_SPEED });
    const fast = measure({ power: 0.5, runnerSpeed: RUNNER_SPEED_MAX });
    expect(mid.beatThrow).toBeGreaterThanOrEqual(slow.beatThrow);
    expect(fast.beatThrow).toBeGreaterThan(mid.beatThrow);
  });

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

  it('寄れば外角の球が打てるようになる（リターンが実際にある）', () => {
    const outside = -0.45; // 外角いっぱいのストライク
    expect(hitRateAt(-BATTER_STANCE_RANGE, outside)!).toBeGreaterThan(hitRateAt(0, outside)!);
  });

  it('寄れば内角の球は打てなくなる（同じ操作の上に代償がある）', () => {
    const inside = 0.45; // 内角いっぱいのストライク
    expect(hitRateAt(-BATTER_STANCE_RANGE, inside)!).toBeLessThan(hitRateAt(0, inside)!);
  });

  it('どこに立っても支配的にはならない（ゾーン全体では打席中央が最良）', () => {
    // 立ち位置は「読みが当たれば得、外れれば損」＝一様なコース分布では動かないのが最良。
    // これが崩れると「常に寄る」が正解になり、選択そのものが消える。
    // **コースの格子を17点に細かくする**（フェーズRR-66）：9点だと丸めの粗さで
    // 中央と寄りが 14.8% vs 15.7% と逆転して見えることがある（細かい格子＝
    // 17点／タイミング12・20分割ではどれも中央が最良）。
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
    const center = zoneAverage(0);
    expect(center).toBeGreaterThanOrEqual(zoneAverage(-BATTER_STANCE_RANGE));
    expect(center).toBeGreaterThanOrEqual(zoneAverage(BATTER_STANCE_RANGE));
  });

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

  it('名鑑96人の曲がりはゾーン半幅の1〜2倍に収まる（見えるが荒唐無稽ではない）', () => {
    // 実測：フォーク 0.48〜0.89m ／ 速球 0.25〜0.44m（ゾーン半幅 0.45m）
    const fork = widths(forkPlan);
    expect(Math.min(...fork)).toBeGreaterThan(STRIKE_ZONE_HALF_WIDTH * 0.8);
    expect(Math.max(...fork)).toBeLessThan(STRIKE_ZONE_HALF_WIDTH * 2.5);
  });

  it('遅い球ほど大きく曲がる（横移動は飛行時間の2乗で効く＝O-35の計測どおり）', () => {
    const fork = widths(forkPlan);
    const fast = widths(fastPlan);
    for (let i = 0; i < profiles.length; i += 1) expect(fork[i]).toBeGreaterThan(fast[i]);
  });

  it('曲がりの差は「投げる前に分かる」を消す大きさ（打席内の可動幅より大きい）', () => {
    // P-37より前はリリース位置＝本塁通過位置だった＝打者は投げる前に答えを見ていた。
    // 曲がり幅がそのまま「嘘の量」になるので、打者が寄れる幅（±0.2m）を超えている
    // ことが「リリース位置だけを見て構える」が成り立たない条件になる。
    for (const w of widths(fastPlan)) expect(w).toBeGreaterThan(BATTER_STANCE_RANGE);
  });
});

describe('敬遠（Q-38。`npm run balance:walk` で測った帯）', () => {
  // 得点期待の土台は計測ツールと同じものを使う（`tools/balance/runExpectancy.ts`）。
  // テストは粗い格子（STEPS）で回すので絶対値はツールの出力と一致しないが、
  // **ここが守るのは大小関係のほう**（このファイル全体の方針）。
  const dist = (power: number) => distributionFor(power, { steps: STEPS });
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

  it('強打者をどの打順に置いても得点期待はほとんど動かない（上位4つは横並び）', () => {
    const top = [0, 1, 2, 3].map((slot) => runsWithAt(slot, STRONG));
    const spread = Math.max(...top) - Math.min(...top);
    // 1〜4番のあいだの差は下位に落とす損（9番）よりずっと小さい
    expect(spread).toBeLessThan(0.05);
    expect(runsWithAt(0, STRONG) - runsWithAt(8, STRONG)).toBeGreaterThan(spread * 2);
  });

  it('最弱の打者（投手）は9番が最良＝原作の既定と一致する', () => {
    const runs = Array.from({ length: 9 }, (_, slot) => runsWithAt(slot, WEAK));
    expect(runs.indexOf(Math.max(...runs))).toBe(8);
    // 単調に「後ろへ回すほど良い」ので、9番固定に例外が要らない
    expect(runs[8]).toBeGreaterThan(runs[4]);
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
    const second = breakEven(FIRST, SECOND, 1);
    expect(second).toBeGreaterThan(0.6);
    // QQ-65 で「外した打球」の減衰を強めた（0.30→0.35）ぶん、長打が減って**アウト1つの
    // 費用が相対的に上がった**＝損益分岐は 0.805 → 0.916 へ動いた。R-39 の規則
    // （守備に残る余裕 0.10秒以下＝完璧な送球でしか刺せない走者だけが走る）は
    // **もともと成功率がほぼ1の場面しか通さない**ので、規則そのものは動かない。
    expect(second).toBeLessThan(0.95);
    // 三盗のほうが損益分岐は低い（三塁は還りやすい）＝一律のしきい値は三盗に対して保守的
    expect(breakEven(SECOND, THIRD, 1)).toBeLessThan(second);
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

  it('当てられたときの費用だけでは持ち味を決められない（速球はどの投手でも一番高い）', () => {
    // 1段目の再現。費用だけで選ばせるとどの投手も速球を投げなくなる＝持ち味が消える。
    // だから決め球は「当てさせない力」（時間の短さ／曲がり）の側から決めている。
    // **名鑑の実際の幅（SPD 0.35〜0.96）で見る**（フェーズRR-66）：RR-66で打球初速の
    // 基準を下げたので、**名鑑に存在しないSPD0の投手**ではフォークが遅すぎて
    // 前へ落ちる当たりが増え（21.0%）、速球（16.1%）を上回る。名鑑の中では従来どおり
    // 速球がいちばん高い。
    for (const spd of [0.35, 0.5, 0.96]) {
      const at = (y: -1 | 0 | 1) =>
        measure({ power: 0.5, pitchSpeed: speedForPitchSelection(y, spd) }).hitRate;
      const [fast, neutral, slow] = [at(-1), at(0), at(1)];
      expect(fast).toBeGreaterThan(neutral);
      expect(fast).toBeGreaterThan(slow);
      // いちばん安い球は速球よりはっきり安い（＝費用で選べば速球は選ばれない）
      expect(Math.min(neutral, slow)).toBeLessThan(fast * 0.8);
    }
  });

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
    // ここが成り立たないと V-43 の設計（疲れを代償にする）が空振りする
    expect(runsAt(1)).toBeGreaterThan(runsAt(0) * 2);
  });

  it('疲労は単調に効く（途中で得になる領域が無い＝「わざと疲れる」が起きない）', () => {
    const steps = [0, 0.25, 0.5, 0.75, 1].map(runsAt);
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i]).toBeGreaterThan(steps[i - 1]);
    }
  });

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
      // 1段目：本塁から 10.5〜11.2m・確保 0.83〜1.20秒
      const depth = Math.hypot(result.fielded!.pos.x, result.fielded!.pos.z);
      expect(depth).toBeLessThan(15);
      expect(result.fielded!.sec).toBeLessThan(1.5);
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
    const scoreTable = solveScoreProbability(distributionFor(0.5, { steps: STEPS }));
    const pitcher = distributionFor(0.1, { average: 0.2, steps: STEPS });
    const bench = distributionFor(0.67, { average: 0.49, steps: STEPS });
    const gain = (outs: number, state: number) =>
      paScoreProb(bench, outs, state, scoreTable) - paScoreProb(pitcher, outs, state, scoreTable);
    // **走者が出ていれば利得は大きく、走者なしでは小さい**（どの塁でも走者なしの2倍以上）
    // ＝X-45が「得点圏かどうか」でしきい値を切った根拠はここ。
    //
    // **フェーズUU-69で「三塁 > 一塁」は成り立たなくなった**（抗力 0.0012→0.0016）。
    // 長打が減ると、**三塁の走者はもともと弱い打者でも還せる**ので良い打者に替える利得が
    // 小さくなり、**一塁の走者は安打が要る**ぶん利得が大きく残る（実測 0死で 一塁11.2pt /
    // 二塁10.8pt / 三塁8.5pt / 走者なし3.7pt）。**X-45の規則そのものは触っていない**ので、
    // 「得点圏」という条件が**いちばん利得の大きい場面（一塁）を外している**ことは
    // 未確認事項として記録した（規則を解き直すのは別セッションの規模）。
    for (const state of [1, 2, 4]) {
      expect(gain(0, state)).toBeGreaterThan(gain(0, 0) * 2);
    }
    // どの場面でも「控えのほうが強い」ことは変わらない（負にはならない）
    for (let state = 0; state < 8; state += 1) {
      for (const outs of [0, 1, 2]) expect(gain(outs, state)).toBeGreaterThan(0);
    }
  });

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
        : 27.43 / speed - (sample.fielded.sec + distance(sample.fielded.pos, to) / THROW_SPEED);
    return { rule, actual };
  }

  const hits = sweep({ batter: hitter(0.5), steps: STEPS })
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

  it('帯が空ではない（安打の過半で余分な塁を狙える）', () => {
    const going = hits.filter(
      (h) => extraBaseCase(h, RUNNER_SPEED).rule <= -CPU_TAG_UP_MARGIN_SEC,
    );
    // 11段目：基準速で 80.0%
    expect(going.length / hits.length).toBeGreaterThan(0.5);
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

  it('余白 CPU_TAG_UP_MARGIN_SEC で、仕掛けた走者が実際に刺される場面が消える', () => {
    const going = hits.filter(
      (h) => extraBaseCase(h, RUNNER_SPEED).rule <= -CPU_TAG_UP_MARGIN_SEC,
    );
    const caught = going.filter((h) => extraBaseCase(h, RUNNER_SPEED).actual >= 0);
    // 12段目：margin 0 では 1.6% が刺される。0.14 で 0.0%
    expect(caught.length).toBe(0);
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
    CPU_POSSESSED_REACTION_SEC +
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

  it('押し＋ライン際でだけ、転がすほうが盗塁より守備を遅くできる（このフェーズの芯）', () => {
    // 標準のバントは**捕手の送球より速い**＝転がすと守備を助けてしまう（実際の野球と逆）
    expect(throwArrival(fieldBunt(-1), 'second')).toBeLessThan(catcherPath);
    // 押してライン際なら逆転する＝バントが走者を守る側に回る
    expect(throwArrival(fieldBunt(-1, true), 'second')).toBeGreaterThan(catcherPath);
  });

  it('押しバントでも打者走者は一塁で刺される（＝アウトと引き換えの手であることは変わらない）', () => {
    for (const aim of [-1, 1] as const) {
      const r = fieldBunt(aim, true);
      expect(throwArrival(r, 'first')).toBeLessThan(BASE_PATH / RUNNER_SPEED_MAX);
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
    // 7段目：走力1.0はセーフ（+0.04秒）／走力0.0はアウト
    expect(runnerSec(RUNNER_SPEED_MAX)).toBeLessThan(arrival);
    expect(runnerSec(RUNNER_SPEED_MIN)).toBeGreaterThan(arrival);
  });

  it('標準のバントはリードを足しても成立しない（押しが要る＝コツが効いている）', () => {
    const arrival = throwArrival(fieldBunt(-1), 'second');
    expect((BASE_PATH - STEAL_LEAD) / RUNNER_SPEED_MAX).toBeGreaterThan(arrival);
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
  });

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

describe('CPU打者の選球と空振り（SS-67。`npm run balance:plate` で測った帯）', () => {
  /**
   * QQ-65 が計測で見つけた構造＝**CPU打者は三振も四球もしない**（1打席1.51球で必ず
   * 打球になり、見送りは0.00球）を埋めたのが SS-67。ここで固定するのは値そのものでは
   * なく「**4つの帰結がどれも実際に起きること**」と「**打席が必ず終わること**」。
   */
  const atBats = () =>
    TEAMS.map((t) => createTeamRoster(teamById(t.id))).map((off, i, all) => {
      const def = all[(i + 1) % all.length];
      const pitcher = def.players[def.pitcher].pitching!;
      return off.lineup.map((id) => simulateAtBat(pitcher, off.players[id].batting));
    });

  const flat = () => atBats().flat();

  it('三振も四球も実際に起きる（SS-67の前はどちらも0%だった）', () => {
    const rs = flat();
    const k = rs.filter((r) => r.kind === 'strikeout').length;
    const bb = rs.filter((r) => r.kind === 'walk').length;
    expect(k).toBeGreaterThan(0);
    expect(bb).toBeGreaterThan(0);
    // **フェーズUU-69で「打球が主役」ではなくなった**（有効窓 0.14→0.09）＝
    // インプレーは 87.5%→**47.9%**。CPU打者の正規化タイミングは不変だが、
    // **スイング判断の時刻が遅くなった**ぶん振る球が増え、三振も増えた（25.0%→39.6%）。
    // ここで守るのは「4つの帰結がどれも起きること」だけに戻し、**割合の帯は
    // TT-68の describe が持つ**（そちらに実際の野球との差も書いてある）。
    expect(rs.filter((r) => r.kind === 'inPlay').length / rs.length).toBeGreaterThan(0.4);
  });

  it('打席は必ず終わる（ファウルの無限ループが構造的に無い）', () => {
    // 判定は決定的なので、**同じ球を投げ続けると同じファウルが永久に繰り返される**。
    // SS-67 の前は 144打席のうち5打席が上限（40球）に張り付いていた＝実機なら
    // 打席が終わらない。CPU投手が「粘られたら反対の隅へ散らす」ことで構造的に消えた。
    for (const r of flat()) expect(r.pitches).toBeLessThan(10);
  });

  it('CPU打者は見送るようになった（＝四球という帰結の入口）', () => {
    const rs = flat();
    const takes = rs.reduce((sum, r) => sum + r.takes, 0) / rs.length;
    expect(takes).toBeGreaterThan(0.2);
  });

  it('フォークは人間の投手の支配戦略ではなくなった（緩急の両側に罰があるので芯で捉えられない）', () => {
    // SS-67 の前は「遅い球には罰なし」だったので、CPU打者はフォークを必ず芯で捉えた
    // （|timing| 平均 0.117）＝当たっても弱いのでほぼアウトになり、投げ続けるのが
    // 最適解だった。いまは緩急の両側に罰があるので、フォークも芯からは外れる。
    expect(cpuSwingLead(SPEED_SLOW)).toBeGreaterThan(cpuSwingLead(SPEED_NEUTRAL));
    expect(cpuSwingLead(SPEED_SLOW)).toBeCloseTo(cpuSwingLead(SPEED_FAST), 10);
  });

  it('基準速の帰結は1mmも動いていない（B-8以来の「基準値＝従来の定数」）', () => {
    expect(cpuSwingLead(SPEED_NEUTRAL)).toBe(SWING_IDEAL_SEC);
  });

  /**
   * **フェーズTT-68で罰そのものを有効窓からの導出にした**（0.045 → `SWING_ACTIVE_SEC / 3`）。
   * SS-67 が置いた「速球は 0.045 のまま」という帯はここで意図して張り替えたもので、
   * 守るのは値ではなく**梯子の形**＝通常は窓の1/3・2ストライクは窓の1/2（縁まで泳ぐ）。
   */
  it('罰は有効窓からの導出で、2ストライクの罰と同じ刻みの梯子になっている（TT-68）', () => {
    expect(cpuSwingLead(SPEED_FAST)).toBeCloseTo(SWING_IDEAL_SEC + SWING_ACTIVE_SEC / 3, 10);
    expect(cpuSwingLead(SPEED_FAST, true)).toBeCloseTo(SWING_IDEAL_SEC + SWING_ACTIVE_SEC / 2, 10);
    // 通常の罰は必ず有効窓の内側＝**単独では空振りにならず「弱い当たり」になる**
    expect(cpuSwingLead(SPEED_FAST) - SWING_IDEAL_SEC).toBeLessThan(SWING_ACTIVE_SEC / 2);
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

describe('三振・四球を実際の野球の帯へ（TT-68。`npm run balance:plate` の12・13段目で測った帯）', () => {
  /**
   * SS-67 は三振・四球を 0%→6.3% にしたが、**実際の野球の帯（三振22% / 四球8.5% /
   * 1打席3.9球）には届いていなかった**（1打席2.20球）。12段目が測った原因は
   * **通常の球の狙いがゾーンのよく内側**（0.2475）にあったこと＝CPU打者が手を出す幅
   * （0.40）のよく内側なので**必ず振られ、その約半分がそのまま打球になる**。
   *
   * ここで固定するのは値そのものではなく、**打席がカウントの分岐へ届くこと**
   * （＝T-41の決め球・3ボールの置き球・S-40の持ち味が実戦で投げられる条件）と、
   * **どの帰結も消えていないこと**（三振・四球・打球・本塁打がすべて起きる）。
   */
  const atBats = () =>
    TEAMS.map((t) => createTeamRoster(teamById(t.id)))
      .map((off, i, all) => {
        const def = all[(i + 1) % all.length];
        const pitcher = def.players[def.pitcher].pitching!;
        return off.lineup.map((id) => simulateAtBat(pitcher, off.players[id].batting));
      })
      .flat();

  it('通常の球は「隅の1つ内側」＝決め球とゾーンを挟んで対称の梯子（新しい定数を持たない）', () => {
    expect(NORMAL_TARGET_X).toBeCloseTo(STRIKE_ZONE_HALF_WIDTH - CORNER_MARGIN, 10);
    // **見逃せばストライク**（ゾーンの内側）でありながら、**CPU打者は振ってこない縁**
    // ＝この2つが同時に成り立つ帯の幅は、ちょうど隅の余裕1つぶんしかない。
    expect(NORMAL_TARGET_X).toBeLessThan(STRIKE_ZONE_HALF_WIDTH);
    expect(NORMAL_TARGET_X).toBeGreaterThanOrEqual(SELECTIVE_HALF_WIDTH);
    expect(STRIKE_ZONE_HALF_WIDTH - SELECTIVE_HALF_WIDTH).toBeCloseTo(CORNER_MARGIN, 10);
  });

  it('罰は有効窓の1/3＝2ストライクの罰（窓の1/2）より必ず内側', () => {
    expect(CPU_TIMING_PENALTY_SEC).toBeCloseTo(SWING_ACTIVE_SEC / 3, 10);
    // **単独では空振りにならない**（＝弱い当たりになる）ことが罰の役目そのもの
    expect(CPU_TIMING_PENALTY_SEC).toBeLessThan(SWING_ACTIVE_SEC / 2);
    // **フェーズUU-69で秒数の帯（0.0455〜0.0472）は外した**＝あれは有効窓 0.14 の
    // ときに測った絶対値で、窓を 0.09 にすれば 0.03 になる（**梯子の形は不変**）。
    // 秒で固定すると窓を触るたびに落ちる＝「テストを直すためにテストを書き換える」になる。
  });

  it('打席がカウントの分岐へ届く（T-41の決め球・3ボールの置き球が実戦で投げられる条件）', () => {
    const rs = atBats();
    // SS-67 の実測は 2ストライク到達 12.5% / 3ボール到達 6.3% ＝ほとんど届いていなかった
    expect(rs.filter((r) => r.maxStrikes >= 2).length / rs.length).toBeGreaterThan(0.3);
    expect(rs.filter((r) => r.maxBalls >= 3).length / rs.length).toBeGreaterThan(0.12);
  });

  it('三振・四球・球数（実際の野球は 22% / 8.5% / 3.9球）', () => {
    const rs = atBats();
    const rate = (kind: string) => rs.filter((r) => r.kind === kind).length / rs.length;
    // **フェーズUU-69で三振が 25.0%→39.6% へ行き過ぎた**（有効窓 0.14→0.09 の代償。
    // 人間の空振りを実際の野球に合わせるほうを優先したユーザー判断）。
    // **上限を 0.45 まで広げたのは事実に合わせただけ**で、実際の野球（22%）から
    // 離れたことは未確認事項として記録してある＝ここは「まだ戻せていない」帯。
    expect(rate('strikeout')).toBeGreaterThan(0.18);
    expect(rate('strikeout')).toBeLessThan(0.45);
    // 四球は UU-69 でも 8.3% のまま＝実際の野球（8.5%）にぴったり乗っている
    expect(rate('walk')).toBeGreaterThan(0.05);
    expect(rate('walk')).toBeLessThan(0.13);
    const pitches = rs.reduce((sum, r) => sum + r.pitches, 0) / rs.length;
    expect(pitches).toBeGreaterThan(3);
    expect(pitches).toBeLessThan(4.5);
  });

  it('打球も長打も消えていない（＝三振ばかりの打席にならない）', () => {
    const rs = atBats();
    expect(rs.filter((r) => r.kind === 'inPlay').length / rs.length).toBeGreaterThan(0.4);
    // **フェーズUU-69でCPU打線の本塁打が 0.31→0.00本/試合になった**（有効窓と抗力の
    // 両方を動かした帰結）。**長打そのものは残っている**ので、ここで守るのは
    // 「長打が1本も出ない打線にはなっていない」まで＝**本数ゼロは未確認事項として
    // 記録した**（戻すなら `AIR_DRAG` 1か所。0.0012 なら 0.44本/試合へ戻る）。
    expect(rs.filter((r) => r.outcome === 'triple' || r.outcome === 'homerun').length).toBeGreaterThan(0);
    // 死球は例外のまま（T-41＝寄って立った打者に決め球が当たる。実際の野球は0.4%）
    expect(rs.filter((r) => r.kind === 'hitByPitch').length / rs.length).toBeLessThan(0.06);
  });

  it('打席は必ず終わる（狙いを動かしてもファウルの無限ループは戻らない）', () => {
    for (const r of atBats()) expect(r.pitches).toBeLessThan(10);
  });
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
