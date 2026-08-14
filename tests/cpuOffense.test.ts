/**
 * CPUの攻撃の采配（フェーズX-45）＝代打と、打球での余分な進塁。
 *
 * どちらも決定的な純粋関数なので、ここで固定するのは「規則そのもの」：
 * どの場面で発火し、どの場面で発火しないか。値の根拠（しきい値）のほうは
 * `npm run balance:offense` が測り、帯は `tests/balance.test.ts` が固定する。
 *
 * **送りバント・スクイズは同じセッションで計測して見送った**ので、ここには規則が無い
 * （見送った理由と、その計測の帯は `tests/balance.test.ts` に記録してある）。
 */
import { describe, expect, it } from 'vitest';
import {
  CPU_PINCH_HIT_GAP,
  type CpuPinchHitCandidate,
  chooseCpuPinchHitter,
} from '../src/core/cpuBatter';
import {
  BASE_POSITIONS,
  CPU_TAG_UP_MARGIN_SEC,
  RUNNER_SPEED,
  RUNNER_SPEED_MAX,
  RUNNER_SPEED_MIN,
  chooseCpuExtraBases,
  cpuExtraBaseSlack,
  predictLanding,
  predictLandingAt,
} from '../src/core/fielding';
import { createBattedBall } from '../src/core/batting';
import type { Bases } from '../src/core/rules';

const NO_RUNNERS: Bases = { first: false, second: false, third: false };
const SCORING: Bases = { first: false, second: true, third: false };

/** 名鑑どおりの投手の打撃（`balance:offense` の8段目の平均） */
const PITCHER_BAT = { average: 0.2, power: 0.1 };
/** 名鑑どおりのいちばん強い控え（同上） */
const BENCH: CpuPinchHitCandidate[] = [
  { index: 0, average: 0.3, power: 0.2 },
  { index: 1, average: 0.49, power: 0.67 },
  { index: 2, average: 0.4, power: 0.3 },
];

describe('CPUの代打（X-45。chooseCpuPinchHitter）', () => {
  it('投手の打席で得点圏に走者がいれば、いちばん強い控えを送る', () => {
    expect(
      chooseCpuPinchHitter({
        pitcherAtBat: true,
        bases: SCORING,
        batter: PITCHER_BAT,
        bench: BENCH,
      }),
    ).toBe(1);
  });

  it('三塁走者でも得点圏として扱う（1本で点が入る打席＝Q-38・M-33と同じ定義）', () => {
    expect(
      chooseCpuPinchHitter({
        pitcherAtBat: true,
        bases: { first: true, second: false, third: true },
        batter: PITCHER_BAT,
        bench: BENCH,
      }),
    ).toBe(1);
  });

  it('投手の打席でなければ出さない（先発を降ろす代償が付かない＝判断にならない）', () => {
    expect(
      chooseCpuPinchHitter({
        pitcherAtBat: false,
        bases: SCORING,
        batter: PITCHER_BAT,
        bench: BENCH,
      }),
    ).toBeNull();
  });

  it('得点圏に走者がいなければ出さない（走者なし・一塁は利得が小さい）', () => {
    for (const bases of [NO_RUNNERS, { first: true, second: false, third: false }]) {
      expect(
        chooseCpuPinchHitter({ pitcherAtBat: true, bases, batter: PITCHER_BAT, bench: BENCH }),
      ).toBeNull();
    }
  });

  it('控えが明確に強くなければ出さない（差が CPU_PINCH_HIT_GAP に届かない）', () => {
    const weak: CpuPinchHitCandidate[] = [{ index: 0, average: 0.4, power: 0.5 }];
    // 差は (0.4+0.5) - (0.2+0.1) = 0.60 < 0.80
    expect(
      chooseCpuPinchHitter({
        pitcherAtBat: true,
        bases: SCORING,
        batter: PITCHER_BAT,
        bench: weak,
      }),
    ).toBeNull();
  });

  it('しきい値ちょうどでは出す（同着は攻撃側に有利＝境界の向きを固定する）', () => {
    const edge: CpuPinchHitCandidate[] = [
      { index: 0, average: PITCHER_BAT.average + CPU_PINCH_HIT_GAP, power: PITCHER_BAT.power },
    ];
    expect(
      chooseCpuPinchHitter({
        pitcherAtBat: true,
        bases: SCORING,
        batter: PITCHER_BAT,
        bench: edge,
      }),
    ).toBe(0);
  });

  it('同率なら並び順の先（cpuChooseSkill・chooseCpuRelief と同じ畳み方で一意に決まる）', () => {
    const tie: CpuPinchHitCandidate[] = [
      { index: 0, average: 0.5, power: 0.6 },
      { index: 1, average: 0.6, power: 0.5 },
    ];
    expect(
      chooseCpuPinchHitter({ pitcherAtBat: true, bases: SCORING, batter: PITCHER_BAT, bench: tie }),
    ).toBe(0);
  });

  it('控えがいなければ出さない', () => {
    expect(
      chooseCpuPinchHitter({
        pitcherAtBat: true,
        bases: SCORING,
        batter: PITCHER_BAT,
        bench: [],
      }),
    ).toBeNull();
  });

  it('好調・スキルで上がった打者には代打を出さなくなる（渡す値がそのまま効く）', () => {
    // 呼び出し側は `effectiveBatting` を通すので、好調（D-19。AV+HR 各+0.2）が
    // 乗った投手はしきい値に届かなくなる＝「今日あたっている投手には代打を出さない」
    const hot = { average: PITCHER_BAT.average + 0.2, power: PITCHER_BAT.power + 0.2 };
    expect(
      chooseCpuPinchHitter({ pitcherAtBat: true, bases: SCORING, batter: hot, bench: BENCH }),
    ).toBeNull();
  });
});

// ---- 打球での余分な進塁 ----

/** 外野へ抜けた打球（本塁から約100m）を守備が確保する見込み */
const DEEP = { securePoint: { x: 0, z: -100 }, secureSec: 3.2 };
/** 内野で止まった打球 */
const INFIELD = { securePoint: { x: 0, z: -30 }, secureSec: 1.5 };

describe('打球での余分な進塁（X-45。cpuExtraBaseSlack / chooseCpuExtraBases）', () => {
  it('余裕は S-40・R-39 と同じ向き（正＝守備が刺せる／負＝走者が先）', () => {
    expect(
      cpuExtraBaseSlack({ from: 'second', speed: RUNNER_SPEED, ...INFIELD }),
    ).toBeGreaterThan(0);
    expect(cpuExtraBaseSlack({ from: 'second', speed: RUNNER_SPEED, ...DEEP })).toBeLessThan(0);
  });

  it('足が速いほど余裕は小さくなる（走力がそのまま出る）', () => {
    const slow = cpuExtraBaseSlack({ from: 'second', speed: RUNNER_SPEED_MIN, ...DEEP });
    const fast = cpuExtraBaseSlack({ from: 'second', speed: RUNNER_SPEED_MAX, ...DEEP });
    expect(fast).toBeLessThan(slow);
  });

  it('外野へ抜けた打球では仕掛け、内野で止まった打球では仕掛けない', () => {
    expect(chooseCpuExtraBases(['second'], DEEP)).toEqual(['second']);
    expect(chooseCpuExtraBases(['second'], INFIELD)).toEqual([]);
  });

  it('前の走者が行かないなら後ろの走者も行かない（塁を追い越せない連鎖）', () => {
    // 三塁走者だけ本塁が遠くて行けない状況を作る＝二塁走者も三塁へ進めない
    const nearHome = { securePoint: { x: 0, z: -3 }, secureSec: 0.5 };
    expect(chooseCpuExtraBases(['third', 'second'], nearHome)).toEqual([]);
  });

  it('前の走者が行くなら後ろの走者も続ける', () => {
    expect(chooseCpuExtraBases(['third', 'second'], DEEP)).toEqual(['third', 'second']);
  });

  it('候補が空なら何も返さない', () => {
    expect(chooseCpuExtraBases([], DEEP)).toEqual([]);
  });

  it('余白の既定は CPU_TAG_UP_MARGIN_SEC（新しい自由変数を作っていない）', () => {
    // ちょうど margin ぶんだけ足りない場面を作り、既定と明示指定が一致することを見る
    const slack = cpuExtraBaseSlack({ from: 'second', speed: RUNNER_SPEED, ...DEEP });
    const tight = { ...DEEP, secureSec: DEEP.secureSec + slack + CPU_TAG_UP_MARGIN_SEC };
    expect(chooseCpuExtraBases(['second'], tight)).toEqual(['second']);
    expect(
      chooseCpuExtraBases(['second'], { ...tight, margin: CPU_TAG_UP_MARGIN_SEC + 0.01 }),
    ).toEqual([]);
  });

  it('本塁への進塁は三塁からの距離で測る（塁ごとに送球距離が違う）', () => {
    const point = { securePoint: { x: -60, z: -60 }, secureSec: 2.5 };
    // 左方向の打球は三塁が近い＝二塁走者は進みにくく、三塁走者（本塁狙い）は進みやすい
    const toThird = cpuExtraBaseSlack({ from: 'second', speed: RUNNER_SPEED, ...point });
    const toHome = cpuExtraBaseSlack({ from: 'third', speed: RUNNER_SPEED, ...point });
    expect(toHome).toBeLessThan(toThird);
  });

  it('走る距離は塁間そのもの（BASE_POSITIONS から導出していて定数を持たない）', () => {
    const zeroThrow = { securePoint: BASE_POSITIONS.third, secureSec: 0 };
    // 送球距離0・確保0秒なら、余裕はそのまま走者の所要時間になる
    expect(cpuExtraBaseSlack({ from: 'second', speed: RUNNER_SPEED, ...zeroThrow })).toBeCloseTo(
      27.43 / RUNNER_SPEED,
      1,
    );
  });
});

describe('着地予測の時刻（X-45。predictLandingAt）', () => {
  const ball = createBattedBall({ vx: 0, vy: 18, vz: -30 }, 0);

  it('地点は predictLanding と完全に一致する（同じ影シミュレーションから導出）', () => {
    expect(predictLandingAt(ball).point).toEqual(predictLanding(ball));
  });

  it('時刻は正で、打ち上げた球ほど長い', () => {
    const low = createBattedBall({ vx: 0, vy: 6, vz: -30 }, 0);
    expect(predictLandingAt(ball).sec).toBeGreaterThan(0);
    expect(predictLandingAt(ball).sec).toBeGreaterThan(predictLandingAt(low).sec);
  });
});
