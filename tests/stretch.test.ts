/**
 * 塁を踏んでそのまま先の塁へ（フェーズBBB-77。説明書p16「+で進塁する塁を指定しB」）。
 *
 * それまで野手が拾った打球では、打者走者は一塁で、押し出された走者は1つ先の塁で**必ず
 * 止まっていた**（二塁打・三塁打は誰も拾えない打球の距離分類からしか出なかった）。
 * フェンス手前の見えない壁（98m）を外したらそれも消えたので、走者が「いま向かっている
 * 塁を踏んで次の塁へ」行けるようにした。ここが守るのは4つ：
 *
 * 1. **人間の J の意味**：無指定はフォースの走者だけ・指定はその塁へ向かう1人だけ・
 *    次の塁が空いていなければ行けない（前の走者も行くなら空く）。
 * 2. **N-34（止まる）の順番を崩さない**＝先へ行ける走者がいる間は J は「走れ」の側。
 * 3. **CPUの判断は X-45 と同じ物差し**＝守備の確保の見込み＋送球と、走者の時間の比較。
 * 4. **見込み（`predictSecureAt`）は着地より後**＝転がる球を拾う時刻を見る。
 */
import { describe, expect, it } from 'vitest';
import { type BattedBallLaunch, createBattedBall, stepBattedBall } from '../src/core/batting';
import { DEFAULT_BALLPARK } from '../src/core/ballpark';
import {
  BASE_POSITIONS,
  CPU_FIELD_REACTION_SEC,
  CPU_TAG_UP_MARGIN_SEC,
  type CpuStretchCandidate,
  DROPKICK_WARN_LEAD_SEC,
  FIELDER_HOME_POSITIONS,
  PICKUP_RELEASE_SEC,
  RUNNER_SPEED,
  type StretchCandidate,
  chooseCpuStretches,
  chooseRunnerCommand,
  chooseStretchRunners,
  predictLandingAt,
  type DefenseBallState,
  defenseSecToBase,
  predictSecureAt,
  shouldCpuRoundBase,
  THROW_SPEED,
} from '../src/core/fielding';
import { clampToPark } from '../src/core/stands';
import { simulatePlay } from '../tools/balance/sim';

const DEG = Math.PI / 180;

/** 打球の初速・方向（0＝中堅、正＝一塁側）・打ち上げ角から打ち出しを作る */
function launchOf(speed: number, directionDeg: number, launchDeg: number): BattedBallLaunch {
  const h = speed * Math.cos(launchDeg * DEG);
  return {
    vx: h * Math.sin(directionDeg * DEG),
    vy: speed * Math.sin(launchDeg * DEG),
    vz: -h * Math.cos(directionDeg * DEG),
  };
}

const batterRunner = (over: Partial<StretchCandidate> = {}): StretchCandidate => ({
  from: 'batter',
  to: 'first',
  forced: true,
  canStretch: true,
  ...over,
});

describe('chooseStretchRunners（人間の J）', () => {
  it('塁を指定しなければ、フォースで走っている走者だけが先へ行く', () => {
    const sentRunner: StretchCandidate = { from: 'second', to: 'third', forced: false, canStretch: true };
    expect(chooseStretchRunners([batterRunner(), sentRunner], null)).toEqual(['batter']);
  });

  it('塁を指定すれば、次の塁がその塁になる走者1人だけ', () => {
    const sentRunner: StretchCandidate = { from: 'second', to: 'third', forced: false, canStretch: true };
    expect(chooseStretchRunners([batterRunner(), sentRunner], 'second')).toEqual(['batter']);
    expect(chooseStretchRunners([batterRunner(), sentRunner], 'home')).toEqual(['second']);
    expect(chooseStretchRunners([batterRunner(), sentRunner], 'first')).toEqual([]);
  });

  it('前の走者が留まる塁へは行けない／前の走者も先へ行くなら空く', () => {
    const lead: StretchCandidate = { from: 'first', to: 'second', forced: true, canStretch: true };
    // 一塁走者も打者走者も押し出されて走っている（無指定＝両方が1つ余分に進む）
    expect(chooseStretchRunners([batterRunner(), lead], null).sort()).toEqual(['batter', 'first']);
    // 前の走者が行けない（刺された・転倒など）なら二塁は埋まったまま
    expect(chooseStretchRunners([batterRunner(), { ...lead, canStretch: false }], null)).toEqual([]);
  });

  it('行けない状態の走者（canStretch=false）と、もう本塁へ向かっている走者は選ばない', () => {
    expect(chooseStretchRunners([batterRunner({ canStretch: false })], null)).toEqual([]);
    expect(
      chooseStretchRunners([{ from: 'third', to: 'home', forced: true, canStretch: true }], null),
    ).toEqual([]);
  });
});

describe('chooseRunnerCommand：先へ行ける走者は「走れ」の側（N-34の順番を崩さない）', () => {
  const runningBatter = { from: 'batter' as const, to: 'first' as const, holding: false, canHold: true };

  it('先へ行ける走者がいれば、J は止まる指示にならず先の塁への指示になる', () => {
    expect(chooseRunnerCommand([], [runningBatter], null, [batterRunner()])).toEqual({
      kind: 'send',
      from: [],
      stretch: ['batter'],
    });
  });

  it('渡さなければBBB-77の前とまったく同じ（走っている打者走者への無指定の J＝止まる）', () => {
    expect(chooseRunnerCommand([], [runningBatter], null)).toEqual({ kind: 'hold', from: ['batter'] });
  });

  it('塁を指定したときは、その塁へ向かう走者がいなければ何も起きない', () => {
    expect(chooseRunnerCommand([], [runningBatter], 'third', [batterRunner()])).toBeNull();
  });
});

describe('chooseCpuStretches（CPUは打球の瞬間に判断する。X-45と同じ物差し）', () => {
  const batter = (over: Partial<CpuStretchCandidate> = {}): CpuStretchCandidate => ({
    ...batterRunner(),
    start: { ...BASE_POSITIONS.home },
    speed: RUNNER_SPEED,
    ...over,
  });

  it('深い打球（確保が遅く、送球も長い）なら二塁へ行く', () => {
    const extra = chooseCpuStretches([batter()], { securePoint: { x: -60, z: -95 }, secureSec: 6 });
    expect(extra.get('batter')).toBe(1);
  });

  it('外野の手前ですぐ拾われる打球なら一塁で止まる', () => {
    const extra = chooseCpuStretches([batter()], { securePoint: { x: -20, z: -60 }, secureSec: 2.5 });
    expect(extra.get('batter')).toBe(0);
  });

  it('足が速いほど・余白が小さいほど先へ行く（単調）', () => {
    const secure = { securePoint: { x: -40, z: -85 }, secureSec: 4.4 };
    const slow = chooseCpuStretches([batter({ speed: 6.8 })], secure).get('batter')!;
    const fast = chooseCpuStretches([batter({ speed: 8.2 })], secure).get('batter')!;
    expect(fast).toBeGreaterThanOrEqual(slow);
    const strict = chooseCpuStretches([batter()], { ...secure, margin: 1 }).get('batter')!;
    const loose = chooseCpuStretches([batter()], { ...secure, margin: 0 }).get('batter')!;
    expect(loose).toBeGreaterThanOrEqual(strict);
    expect(CPU_TAG_UP_MARGIN_SEC).toBeGreaterThan(0);
  });

  it('前の走者が留まる塁へは行かない（連鎖）', () => {
    const lead: CpuStretchCandidate = {
      from: 'first',
      to: 'second',
      forced: true,
      canStretch: false,
      start: { ...BASE_POSITIONS.first },
      speed: RUNNER_SPEED,
    };
    const extra = chooseCpuStretches([batter(), lead], { securePoint: { x: -60, z: -95 }, secureSec: 6 });
    expect(extra.get('first')).toBe(0);
    expect(extra.get('batter')).toBe(0);
  });
});

describe('shouldCpuRoundBase（塁を踏んだ／塁の上にいるCPU走者が、いまの守備の状況で次の塁へ行くか。BBB-78）', () => {
  const at = (base: 'first' | 'second' | 'third') => ({ ...BASE_POSITIONS[base] });
  const round = (base: 'first' | 'second' | 'third', defense: DefenseBallState) =>
    shouldCpuRoundBase({ runner: at(base), base, speed: RUNNER_SPEED, defense });

  it('ボールを持った野手が次の塁の近くにいれば止まる', () => {
    expect(round('first', { kind: 'held', carrier: at('second'), delaySec: 0 })).toBe(false);
  });

  it('ボールを持った野手がとても遠い（右翼の奥から三塁）なら回る', () => {
    expect(round('second', { kind: 'held', carrier: { x: 90, z: -100 }, delaySec: 0 })).toBe(true);
  });

  it('テストプレイの場面：三塁を踏んだとき、ボールがまだ外野を転がっていて拾うのが遅ければ本塁へ回る', () => {
    // 守備が最善に追っても、拾うのは3秒後の左中間の奥＝本塁への送球込みで 5.8秒
    const far: DefenseBallState = { kind: 'loose', secure: { point: { x: -30, z: -90 }, sec: 3 } };
    expect(round('third', far)).toBe(true);
    // すぐ拾われる（0.5秒後の浅い外野）なら本塁への送球のほうが速い＝止まる
    const near: DefenseBallState = { kind: 'loose', secure: { point: { x: -30, z: -60 }, sec: 0.5 } };
    expect(round('third', near)).toBe(false);
  });

  it('送球が飛んでいる間は、受けた野手の投げ継ぎまで見込む', () => {
    const toFirst: DefenseBallState = { kind: 'throw', target: 'first', remainingSec: 0.4 };
    // 一塁で受けて三塁へ投げ継ぐ＝0.4 + 38.8m/34 ≒ 1.54秒 ＜ 二塁→三塁 3.66秒
    expect(defenseSecToBase(toFirst, 'third')).toBeCloseTo(
      0.4 + Math.hypot(BASE_POSITIONS.first.x - BASE_POSITIONS.third.x, BASE_POSITIONS.first.z - BASE_POSITIONS.third.z) / THROW_SPEED,
      9,
    );
    expect(round('second', toFirst)).toBe(false);
  });

  it('余白は X-45 と同じ（ちょうど余白ぶんだけ早く着くなら回り、それより遅ければ止まる）', () => {
    const run = Math.hypot(BASE_POSITIONS.third.x, BASE_POSITIONS.third.z) / RUNNER_SPEED;
    const exactly = (slack: number): DefenseBallState => ({
      kind: 'loose',
      // 守備が本塁へ届けるのは「拾う＋持ち替え（BBB-82）」の後（送球の距離は0）
      secure: { point: { x: 0, z: 0 }, sec: run + slack - PICKUP_RELEASE_SEC },
    });
    expect(round('third', exactly(CPU_TAG_UP_MARGIN_SEC + 0.001))).toBe(true);
    expect(round('third', exactly(CPU_TAG_UP_MARGIN_SEC - 0.001))).toBe(false);
  });

  it('いまの野手の位置から見込む：同じ球でも、野手が球から遠いほど拾うのが遅い（人間の守備の遅れが走者の得になる）', () => {
    // 左中間へ落ちて転がる球。野手が守備位置にいるときと、右中間へ寄っていたとき
    let ball = createBattedBall(launchOf(30, -25, 12), 0);
    while (ball.landing === null) ball = stepBattedBall(ball, 1 / 60);
    const ready = predictSecureAt(ball, DEFAULT_BALLPARK);
    const away = { x: 40, z: -70 };
    const late = predictSecureAt(ball, DEFAULT_BALLPARK, 1 / 60, 12, {
      ...FIELDER_HOME_POSITIONS,
      P: away,
      SS: away,
      LF: away,
      CF: away,
      RF: away,
    });
    expect(late.sec).toBeGreaterThan(ready.sec + 1);
  });
});

describe('地面の球を拾ってからの持ち替え（PICKUP_RELEASE_SEC。BBB-82）', () => {
  const at = (base: 'first' | 'second' | 'third') => ({ ...BASE_POSITIONS[base] });

  it('値は「人が反応して、塁の方向を入れて K を押すのに要る時間」と同じ（BBB-81の見込みを守備の時間にした）', () => {
    expect(PICKUP_RELEASE_SEC).toBe(DROPKICK_WARN_LEAD_SEC);
  });

  it('転がっている球の見込みには持ち替えが入る（拾う＋持ち替え＋送球）', () => {
    const point = { x: -30, z: -90 };
    const loose: DefenseBallState = { kind: 'loose', secure: { point, sec: 2 } };
    const throwSec = Math.hypot(point.x - BASE_POSITIONS.home.x, point.z - BASE_POSITIONS.home.z) / THROW_SPEED;
    expect(defenseSecToBase(loose, 'home')).toBeCloseTo(2 + PICKUP_RELEASE_SEC + throwSec, 9);
  });

  it('持っている球は「まだ投げられない残り」だけ（持ち替えの残りはシーンが渡す）', () => {
    const carrier = { x: -30, z: -90 };
    const throwSec = Math.hypot(carrier.x, carrier.z) / THROW_SPEED;
    expect(defenseSecToBase({ kind: 'held', carrier, delaySec: 0 }, 'home')).toBeCloseTo(throwSec, 9);
    expect(defenseSecToBase({ kind: 'held', carrier, delaySec: 0.2 }, 'home')).toBeCloseTo(0.2 + throwSec, 9);
  });

  it('塁で受けた野手の投げ継ぎには持ち替えが掛からない（併殺の送球は従来どおり）', () => {
    const toFirst: DefenseBallState = { kind: 'throw', target: 'first', remainingSec: 0.4 };
    const relay =
      Math.hypot(BASE_POSITIONS.first.x - BASE_POSITIONS.third.x, BASE_POSITIONS.first.z - BASE_POSITIONS.third.z) / THROW_SPEED;
    expect(defenseSecToBase(toFirst, 'third')).toBeCloseTo(0.4 + relay, 9);
  });

  it('持ち替えのぶんだけ、CPU走者は先の塁へ行きやすい（塁の上の判断）', () => {
    // 三塁走者が本塁へ：守備が本塁の真上で、走者より `late` 秒だけ早く拾う
    const run = Math.hypot(BASE_POSITIONS.third.x, BASE_POSITIONS.third.z) / RUNNER_SPEED;
    const round = (early: number) =>
      shouldCpuRoundBase({
        runner: at('third'),
        base: 'third',
        speed: RUNNER_SPEED,
        defense: { kind: 'loose', secure: { point: { x: 0, z: 0 }, sec: run - early } },
      });
    // 拾うのが 0.1秒 早くても、持ち替え（0.35秒）の間に余白（0.14秒）以上早く着ける
    expect(round(0.1)).toBe(true);
    // 拾うのが持ち替えより大きく早ければ間に合わない
    expect(round(PICKUP_RELEASE_SEC - CPU_TAG_UP_MARGIN_SEC + 0.01)).toBe(false);
    expect(round(PICKUP_RELEASE_SEC - CPU_TAG_UP_MARGIN_SEC - 0.01)).toBe(true);
  });

  it('打球の瞬間の判断（塁を踏んで先へ）にも同じ持ち替えが入る', () => {
    const batter: CpuStretchCandidate = {
      from: 'batter',
      to: 'first',
      forced: true,
      canStretch: true,
      start: { x: 0, z: 0 },
      speed: RUNNER_SPEED,
    };
    const runToSecond = (2 * Math.hypot(BASE_POSITIONS.first.x, BASE_POSITIONS.first.z)) / RUNNER_SPEED;
    const stretch = (early: number) =>
      chooseCpuStretches([batter], { securePoint: { ...BASE_POSITIONS.second }, secureSec: runToSecond - early }).get('batter');
    expect(stretch(PICKUP_RELEASE_SEC - CPU_TAG_UP_MARGIN_SEC - 0.01)).toBe(1);
    expect(stretch(PICKUP_RELEASE_SEC - CPU_TAG_UP_MARGIN_SEC + 0.01)).toBe(0);
  });
});

describe('predictSecureAt（転がる球をCPU守備が拾う時刻の見込み）', () => {
  const gap = (speed: number) => createBattedBall(launchOf(speed, -25, 14), 0);

  it('着地してから拾う＝確保は着地より後', () => {
    for (const speed of [30, 36, 42]) {
      const ball = gap(speed);
      expect(predictSecureAt(ball).sec).toBeGreaterThanOrEqual(predictLandingAt(ball).sec);
    }
  });

  it('見込みは実際の守備（計測の土台＝実機と同じ動き）が拾う時刻と一致する', () => {
    // 攻撃側だけが知っている情報は無い＝守備が追いかける先と同じ物差しで影を回している。
    // ファインプレイは見込まない（`simulatePlay` も切って比べる）。
    // **見込みは相手の守備の動きを写す**（フェーズBBB-83）＝CPU守備（先回り＋反応の遅れ）と、
    // 人間の守備の見込み（いちばん近い野手を球へ向ける）の両方で確かめる。
    for (const mode of ['intercept', 'follow'] as const) {
      const reaction = mode === 'intercept' ? CPU_FIELD_REACTION_SEC : 0;
      let compared = 0;
      for (const dir of [-35, -25, -10, 10, 25, 35]) {
        for (const speed of [30, 36, 42]) {
          const launch = launchOf(speed, dir, 14);
          const play = simulatePlay(launch, 0, {
            park: DEFAULT_BALLPARK,
            finePlay: false,
            stretch: false,
            chase: mode,
            reactionSec: reaction,
          });
          if (play.outcome.kind !== 'beatThrow' || !play.fielded) continue;
          const secure = predictSecureAt(
            createBattedBall(launch, 0),
            DEFAULT_BALLPARK,
            1 / 60,
            12,
            FIELDER_HOME_POSITIONS,
            mode,
            reaction,
          );
          expect(Math.abs(secure.sec - play.fielded.sec)).toBeLessThanOrEqual(2 / 60);
          compared += 1;
        }
      }
      expect(compared).toBeGreaterThan(3);
    }
  });

  it('先回りの守備は、追いかける守備より遅くは拾わない（フェーズBBB-83）', () => {
    for (const dir of [-35, -25, -10, 10, 25, 35]) {
      for (const speed of [30, 36, 42]) {
        const ball = createBattedBall(launchOf(speed, dir, 14), 0);
        const follow = predictSecureAt(ball, DEFAULT_BALLPARK);
        const intercept = predictSecureAt(ball, DEFAULT_BALLPARK, 1 / 60, 12, FIELDER_HOME_POSITIONS, 'intercept');
        expect(intercept.sec).toBeLessThanOrEqual(follow.sec + 2 / 60);
      }
    }
  });

  it('拾う場所は球場の壁の内側（野手が行ける範囲）', () => {
    for (const speed of [30, 36, 42, 46]) {
      const p = { ...predictSecureAt(gap(speed), DEFAULT_BALLPARK).point };
      const before = { ...p };
      clampToPark(DEFAULT_BALLPARK, p);
      expect(p.x).toBeCloseTo(before.x, 9);
      expect(p.z).toBeCloseTo(before.z, 9);
    }
  });
});
