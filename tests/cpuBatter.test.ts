import { describe, expect, it } from 'vitest';
import {
  CPU_SWING_SIGMA_SEC,
  CPU_TIMING_PENALTY_SEC,
  SELECTIVE_HALF_WIDTH,
  TWO_STRIKE_HALF_WIDTH,
  cpuSwingClockAt,
  cpuSwingLead,
  cpuTimingScale,
  crossesSwingDecisionPoint,
  drawCpuSwingNoise,
  paceStepOf,
  predictCrossX,
  shouldCpuSwing,
  timeToContactPlane,
} from '../src/core/cpuBatter';
import { contactPlaneCrossing, judgeSwing } from '../src/core/batting';
import { createRngState } from '../src/core/rng';
import {
  BAT_REACH_INSIDE_X,
  BAT_REACH_OUTSIDE_X,
  CONTACT_PLANE_Z,
  SWING_ACTIVE_SEC,
  SWING_IDEAL_SEC,
} from '../src/core/batting';
import type { PitchFlight } from '../src/core/pitch';
import {
  createPitchFlight,
  neutralSpeedFor,
  speedForPitchSelection,
  stepPitchFlight,
  LEFT_BATTER_SIDE,
  REFERENCE_PITCHER_NEUTRAL,
  RIGHT_BATTER_SIDE,
  SPEED_FAST,
  SPEED_NEUTRAL,
  SPEED_SLOW,
  BATTER_STANCE_RANGE,
  STRIKE_ZONE_HALF_WIDTH,
} from '../src/core/pitch';
import { EMPTY_COUNT } from '../src/core/rules';

function flightAt(z: number, opts: Partial<PitchFlight> = {}): PitchFlight {
  return { x: 0, z, vx: 0, vz: 30, ...opts };
}

describe('timeToContactPlane（打撃面通過までの残り時間）', () => {
  it('球速が正なら残り距離÷球速', () => {
    const flight = flightAt(CONTACT_PLANE_Z - 3, { vz: 30 });
    expect(timeToContactPlane(flight)).toBeCloseTo(0.1, 5);
  });

  it('既に打撃面を通過していれば負の値になる', () => {
    const flight = flightAt(CONTACT_PLANE_Z + 1, { vz: 30 });
    expect(timeToContactPlane(flight)).toBeLessThan(0);
  });

  it('球速が0以下ならInfinity（0除算・逆行を避ける安全策）', () => {
    expect(timeToContactPlane(flightAt(-5, { vz: 0 }))).toBe(Infinity);
    expect(timeToContactPlane(flightAt(-5, { vz: -1 }))).toBe(Infinity);
  });
});

describe('predictCrossX（現在の速度を等速直線とみなした着弾点の外挿）', () => {
  it('横速度がなければ現在のXがそのまま予測値', () => {
    const flight = flightAt(CONTACT_PLANE_Z - 3, { x: 0.2, vx: 0, vz: 30 });
    expect(predictCrossX(flight)).toBeCloseTo(0.2, 5);
  });

  it('横速度があれば残り時間ぶん外挿する', () => {
    const flight = flightAt(CONTACT_PLANE_Z - 3, { x: 0, vx: 1, vz: 30 }); // 残り0.1秒
    expect(predictCrossX(flight)).toBeCloseTo(0.1, 5);
  });
});

describe('crossesSwingDecisionPoint（スイング判断の瞬間のエッジ検出）', () => {
  // 初球・基準速＝ジャストミートを狙う時刻（フェーズAAA-75で lead は球ごとに呼び出し側が渡す）
  const lead = cpuSwingLead(30, 30);

  it('残り時間がしきい値を上から下へまたいだフレームでtrue', () => {
    // z = CONTACT_PLANE_Z - vz*t なので、t=lead+0.01 → t=lead-0.01 とまたがせる
    const prev = flightAt(CONTACT_PLANE_Z - 30 * (lead + 0.01), { vz: 30 });
    const next = flightAt(CONTACT_PLANE_Z - 30 * (lead - 0.01), { vz: 30 });
    expect(crossesSwingDecisionPoint(prev, next, lead)).toBe(true);
  });

  it('しきい値をまだ上回ったままなら false', () => {
    const prev = flightAt(CONTACT_PLANE_Z - 30 * (lead + 0.05), { vz: 30 });
    const next = flightAt(CONTACT_PLANE_Z - 30 * (lead + 0.03), { vz: 30 });
    expect(crossesSwingDecisionPoint(prev, next, lead)).toBe(false);
  });

  it('既にしきい値を下回った状態が続いているだけなら false（このフレームで跨いだのではない）', () => {
    const prev = flightAt(CONTACT_PLANE_Z - 30 * (lead - 0.03), { vz: 30 });
    const next = flightAt(CONTACT_PLANE_Z - 30 * (lead - 0.05), { vz: 30 });
    expect(crossesSwingDecisionPoint(prev, next, lead)).toBe(false);
  });
});

describe('paceStepOf（緩急の段＝その投手の基準速を0として 速球+1 / フォーク-1）', () => {
  it('どの球速（SPD）の投手でも、速球・基準速・フォークはちょうど +1 / 0 / -1', () => {
    for (const spd of [0, 0.3, 0.5, 0.8, 1]) {
      const neutral = neutralSpeedFor(spd);
      expect(paceStepOf(speedForPitchSelection(-1, spd), neutral)).toBeCloseTo(1, 10);
      expect(paceStepOf(speedForPitchSelection(0, spd), neutral)).toBeCloseTo(0, 10);
      expect(paceStepOf(speedForPitchSelection(1, spd), neutral)).toBeCloseTo(-1, 10);
    }
  });
});

describe('cpuSwingLead（直前のストライクの速さに合わせる。フェーズAAA-75）', () => {
  const fast = SPEED_FAST;
  const neutral = SPEED_NEUTRAL;
  const slow = SPEED_SLOW;

  it('初球はその投手の基準速を待つ＝基準速ならジャストミート', () => {
    expect(cpuSwingLead(neutral, neutral)).toBeCloseTo(SWING_IDEAL_SEC, 10);
    expect(cpuSwingLead(neutral, neutral, null)).toBeCloseTo(SWING_IDEAL_SEC, 10);
  });

  it('**待っていた速さと同じ球は芯**（＝同じ速さを続けると捉えられる）', () => {
    for (const v of [fast, neutral, slow]) {
      expect(cpuSwingLead(v, neutral, v)).toBeCloseTo(SWING_IDEAL_SEC, 10);
    }
  });

  it('待っていた球より遅ければ早振り（泳ぐ）・速ければ振り遅れ（差し込まれる）', () => {
    expect(cpuSwingLead(slow, neutral, fast)).toBeGreaterThan(SWING_IDEAL_SEC);
    expect(cpuSwingLead(fast, neutral, slow)).toBeLessThan(SWING_IDEAL_SEC);
    // 初球の速球は基準速を待っているので差し込まれ、フォークは泳ぐ
    expect(cpuSwingLead(fast, neutral)).toBeLessThan(SWING_IDEAL_SEC);
    expect(cpuSwingLead(slow, neutral)).toBeGreaterThan(SWING_IDEAL_SEC);
  });

  it('緩急1段で CPU_TIMING_PENALTY_SEC・2段でその2倍ずれる（上下の幅の違いは段で吸収する）', () => {
    expect(cpuSwingLead(fast, neutral, neutral) - SWING_IDEAL_SEC).toBeCloseTo(-CPU_TIMING_PENALTY_SEC, 10);
    expect(cpuSwingLead(slow, neutral, neutral) - SWING_IDEAL_SEC).toBeCloseTo(CPU_TIMING_PENALTY_SEC, 10);
    expect(cpuSwingLead(slow, neutral, fast) - SWING_IDEAL_SEC).toBeCloseTo(2 * CPU_TIMING_PENALTY_SEC, 10);
  });

  it('**1段の変化だけでは空振りさせられない**／2段（速球↔フォーク）は窓の縁を越える', () => {
    // 1段は芯から縁（窓の半分）の内側＝ぶれが無ければ当たる（弱い当たり）
    expect(CPU_TIMING_PENALTY_SEC).toBeLessThan(SWING_ACTIVE_SEC / 2);
    // 2段は縁の外＝ぶれが引き戻さなければ空振り（緩急を目いっぱい使った値打ち）
    expect(2 * CPU_TIMING_PENALTY_SEC).toBeGreaterThan(SWING_ACTIVE_SEC / 2);
    // 値は TT-68 の梯子の1段＝有効窓の1/3（新しい数値を持ち込んでいない）
    expect(CPU_TIMING_PENALTY_SEC).toBeCloseTo(SWING_ACTIVE_SEC / 3, 10);
  });

  it('ぶれはそのまま時刻に足される／打撃面を過ぎてから振り出すことはない（0で下げ止まる）', () => {
    expect(cpuSwingLead(neutral, neutral, null, 0.02)).toBeCloseTo(SWING_IDEAL_SEC + 0.02, 10);
    expect(cpuSwingLead(fast, neutral, slow, -1)).toBe(0);
  });
});

describe('cpuTimingScale（球が速い投手ほど、CPU打者の誤差が大きい。フェーズBBB-85）', () => {
  const fastest = neutralSpeedFor(1);
  const slowest = neutralSpeedFor(0);

  it('基準の投手（名鑑の平均）で 1＝BBB-85 の前と同じ', () => {
    expect(cpuTimingScale(REFERENCE_PITCHER_NEUTRAL)).toBe(1);
  });

  it('倍率は基準速の比そのまま＝飛行時間が縮む比と同じ（新しい数値を持たない）', () => {
    expect(cpuTimingScale(fastest)).toBeCloseTo(fastest / REFERENCE_PITCHER_NEUTRAL, 12);
    expect(cpuTimingScale(slowest)).toBeCloseTo(slowest / REFERENCE_PITCHER_NEUTRAL, 12);
    // いちばん速い投手で約1.1倍・いちばん遅い投手で約0.8倍
    expect(cpuTimingScale(fastest)).toBeGreaterThan(1.08);
    expect(cpuTimingScale(fastest)).toBeLessThan(1.15);
    expect(cpuTimingScale(slowest)).toBeGreaterThan(0.75);
    expect(cpuTimingScale(slowest)).toBeLessThan(0.82);
  });

  it('球速（基準速）に単調', () => {
    let last = 0;
    for (let rating = 0; rating <= 1.0001; rating += 0.1) {
      const scale = cpuTimingScale(neutralSpeedFor(rating));
      expect(scale).toBeGreaterThan(last);
      last = scale;
    }
  });

  it('投手を持たない素の球は 1（渡さない呼び出しは従来どおり）', () => {
    expect(cpuTimingScale()).toBe(1);
    expect(cpuTimingScale(undefined)).toBe(1);
  });

  it('cpuSwingLead では、緩急のずれとぶれの両方に掛かる（芯の時刻は動かない）', () => {
    const n = fastest;
    const fast = speedForPitchSelection(-1, 1);
    const slow = speedForPitchSelection(1, 1);
    const scale = cpuTimingScale(n);
    // 同じ速さを待っていて、ぶれも無ければ芯のまま
    expect(cpuSwingLead(fast, n, fast, 0, undefined, scale)).toBeCloseTo(SWING_IDEAL_SEC, 12);
    // 緩急1段のずれが倍率ぶん大きくなる
    expect(cpuSwingLead(fast, n, n, 0, undefined, scale) - SWING_IDEAL_SEC).toBeCloseTo(
      -CPU_TIMING_PENALTY_SEC * scale,
      12,
    );
    expect(cpuSwingLead(slow, n, fast, 0, undefined, scale) - SWING_IDEAL_SEC).toBeCloseTo(
      2 * CPU_TIMING_PENALTY_SEC * scale,
      12,
    );
    // ぶれも同じ倍率
    expect(cpuSwingLead(n, n, null, 0.02, undefined, scale) - SWING_IDEAL_SEC).toBeCloseTo(0.02 * scale, 12);
    // 渡さなければ 1＝従来どおり
    expect(cpuSwingLead(n, n, null, 0.02)).toBeCloseTo(SWING_IDEAL_SEC + 0.02, 12);
  });

  it('いちばん速い投手でも、緩急1段だけでは空振りさせられない（AAA-75 の要点は保つ）', () => {
    // 1段のずれが、芯から窓の縁（窓の半分）の内側に収まる
    expect(CPU_TIMING_PENALTY_SEC * cpuTimingScale(fastest)).toBeLessThan(SWING_ACTIVE_SEC / 2);
    // いちばん遅い投手でも、2段（速球↔フォーク）は縁を越える
    expect(2 * CPU_TIMING_PENALTY_SEC * cpuTimingScale(slowest)).toBeGreaterThan(SWING_ACTIVE_SEC / 2);
  });
});

describe('cpuSwingClockAt（サブフレームで振り出す＝リフレッシュレートによらない。AAA-75）', () => {
  it('フレームの先頭の時点では「まだ振り出していない分」だけ負（1フレーム未満）', () => {
    const lead = cpuSwingLead(30, 30);
    const prev = flightAt(CONTACT_PLANE_Z - 30 * (lead + 0.01), { vz: 30 });
    expect(cpuSwingClockAt(prev, lead)).toBeCloseTo(-0.01, 10);
  });

  /** まっすぐの球を刻み dt で飛ばし、判断した瞬間に振り出して、接触したときのスイング経過を返す */
  const swingTimeAtContact = (dt: number, speed: number, lead: number): number => {
    let flight = createPitchFlight(0, speed, 0);
    let swingT: number | null = null;
    for (let i = 0; i < 10000; i += 1) {
      const prev = flight;
      const next = stepPitchFlight(prev, 0, dt, 0);
      if (swingT === null && crossesSwingDecisionPoint(prev, next, lead)) {
        swingT = cpuSwingClockAt(prev, lead);
      }
      if (swingT !== null) {
        const cross = contactPlaneCrossing(prev, next);
        if (cross) return swingT + cross.frac * dt;
        swingT += dt;
      }
      flight = next;
    }
    throw new Error('届かなかった');
  };

  it('**どの刻みでも、狙った時刻ちょうどでバットと球が出会う**（AAA-75の前は最大1フレーム早かった）', () => {
    for (const speed of [SPEED_SLOW, SPEED_NEUTRAL, SPEED_FAST]) {
      for (const noise of [-0.03, 0, 0.025]) {
        const lead = cpuSwingLead(speed, SPEED_NEUTRAL, null, noise);
        for (const hz of [30, 60, 120, 144, 240]) {
          expect(swingTimeAtContact(1 / hz, speed, lead)).toBeCloseTo(lead, 9);
        }
      }
    }
  });

  it('同じ球・同じぶれなら、60Hzでも144Hzでも打球がまったく同じ', () => {
    const lead = cpuSwingLead(SPEED_FAST, SPEED_NEUTRAL, SPEED_FAST, 0.01);
    const launchAt = (hz: number) =>
      judgeSwing({
        crossX: 0,
        swingTime: swingTimeAtContact(1 / hz, SPEED_FAST, lead),
        pitchSpeed: SPEED_FAST,
      });
    const a = launchAt(60)!;
    const b = launchAt(144)!;
    expect(a.vx).toBeCloseTo(b.vx, 9);
    expect(a.vy).toBeCloseTo(b.vy, 9);
    expect(a.vz).toBeCloseTo(b.vz, 9);
  });
});

describe('drawCpuSwingNoise（人間並みのぶれ。シードから決まる）', () => {
  it('同じ状態からは同じぶれ・新しい状態が返る（入力の状態は書き換えない）', () => {
    const state = createRngState(1234);
    const a = drawCpuSwingNoise(state);
    const b = drawCpuSwingNoise(state);
    expect(a).toEqual(b);
    expect(a.state).not.toBe(state);
  });

  it('平均0・標準偏差 σ（UU-69 の人間の σ40ms）・±3σ で打ち切る', () => {
    let state = createRngState(99);
    let sum = 0;
    let sq = 0;
    let max = 0;
    const n = 20000;
    for (let i = 0; i < n; i += 1) {
      const d = drawCpuSwingNoise(state);
      state = d.state;
      sum += d.noise;
      sq += d.noise * d.noise;
      max = Math.max(max, Math.abs(d.noise));
    }
    const mean = sum / n;
    const sd = Math.sqrt(sq / n - mean * mean);
    expect(Math.abs(mean)).toBeLessThan(0.002);
    expect(sd).toBeGreaterThan(CPU_SWING_SIGMA_SEC * 0.95);
    expect(sd).toBeLessThan(CPU_SWING_SIGMA_SEC * 1.05);
    expect(max).toBeLessThanOrEqual(3 * CPU_SWING_SIGMA_SEC + 1e-12);
    expect(CPU_SWING_SIGMA_SEC).toBeCloseTo(0.04, 10);
  });

  it('σを0にすればぶれ無し（狙いどおりの時刻）', () => {
    expect(drawCpuSwingNoise(createRngState(5), 0).noise).toBe(0);
  });
});

describe('shouldCpuSwing（CPU打者のスイング判断）', () => {
  it('バットが届かない外側の予測コースは見送る', () => {
    const flight = flightAt(CONTACT_PLANE_Z, { x: BAT_REACH_OUTSIDE_X - 0.1, vx: 0 });
    expect(shouldCpuSwing(flight, EMPTY_COUNT)).toBe(false);
  });

  it('バットが届かない内側の予測コースは見送る', () => {
    const flight = flightAt(CONTACT_PLANE_Z, { x: BAT_REACH_INSIDE_X + 0.1, vx: 0 });
    expect(shouldCpuSwing(flight, EMPTY_COUNT)).toBe(false);
  });

  it('2ストライク未満は「ストライクゾーン」より外・バット到達範囲より内側のボール球を見送る', () => {
    // 0.63: 到達範囲(<=0.65)には入るが、ゾーン(<=0.45)の外のボール球
    const flight = flightAt(CONTACT_PLANE_Z, { x: 0.63, vx: 0 });
    expect(shouldCpuSwing(flight, { balls: 0, strikes: 1 })).toBe(false);
  });

  it('2ストライク以降は幅が1つ広がる（＝粘る）が、無限ではない（フェーズSS-67）', () => {
    // SS-67の前は「2ストライクなら**バットが届く球すべて**に手を出す」だったので、
    // **CPU投手の決め球（81.3%がボール）をどんなに外れていても必ず追いかけ**、
    // 四球も見逃し三振も構造的に起こりえなかった。いまは隅の1つ外まで＝有限。
    const corner = flightAt(CONTACT_PLANE_Z, { x: STRIKE_ZONE_HALF_WIDTH + 0.04, vx: 0 });
    expect(shouldCpuSwing(corner, { balls: 0, strikes: 1 })).toBe(false);
    expect(shouldCpuSwing(corner, { balls: 0, strikes: 2 })).toBe(true);

    // そこから更に外れた球は、2ストライクでも見送る（＝これが四球を生む）
    const wild = flightAt(CONTACT_PLANE_Z, { x: 0.63, vx: 0 });
    expect(shouldCpuSwing(wild, { balls: 0, strikes: 2 })).toBe(false);
  });

  it('甘い球（ど真ん中）は2ストライク未満でも振る', () => {
    const flight = flightAt(CONTACT_PLANE_Z, { x: 0, vx: 0 });
    expect(shouldCpuSwing(flight, EMPTY_COUNT)).toBe(true);
  });

  it('**ストライクには手を出す**＝ゾーンの縁の内側（0.40〜0.45）も振る（フェーズAAA-75）', () => {
    // TT-68 の幅（0.40）のままだと、この帯は**振られずにストライクになる**＝人間の投手が
    // 見逃しストライクを取り放題だった（必勝配球の1つ）。
    expect(SELECTIVE_HALF_WIDTH).toBeCloseTo(STRIKE_ZONE_HALF_WIDTH, 10);
    const edge = flightAt(CONTACT_PLANE_Z, { x: STRIKE_ZONE_HALF_WIDTH - 0.02, vx: 0 });
    expect(shouldCpuSwing(edge, EMPTY_COUNT)).toBe(true);
    // 追い込まれたら隅の1つ外まで（決め球の狙いそのもの）
    expect(TWO_STRIKE_HALF_WIDTH).toBeGreaterThan(SELECTIVE_HALF_WIDTH);
  });

  describe('打席の左右（フェーズB-9）', () => {
    it('バットの到達範囲がXについて鏡像になる', () => {
      // 到達範囲は外角側のほうが広い（judgeSwing と同じ非対称）。
      // **フェーズSS-67で選球の幅が到達範囲の内側に入った**ので、打席の中央では
      // 幅のほうが先に効いて鏡像が観測できない＝**離れて立った打席**（外角側の
      // 到達範囲が幅より内側へ縮む）で見る。
      const far = BATTER_STANCE_RANGE;
      const outsideForRight = flightAt(CONTACT_PLANE_Z, { x: 0.5, vx: 0 });
      expect(
        shouldCpuSwing(outsideForRight, { balls: 0, strikes: 2 }, RIGHT_BATTER_SIDE, far),
      ).toBe(false);
      expect(
        shouldCpuSwing(outsideForRight, { balls: 0, strikes: 2 }, LEFT_BATTER_SIDE, far),
      ).toBe(true);

      const outsideForLeft = flightAt(CONTACT_PLANE_Z, { x: -0.5, vx: 0 });
      expect(shouldCpuSwing(outsideForLeft, { balls: 0, strikes: 2 }, LEFT_BATTER_SIDE, far)).toBe(
        false,
      );
      expect(shouldCpuSwing(outsideForLeft, { balls: 0, strikes: 2 }, RIGHT_BATTER_SIDE, far)).toBe(
        true,
      );
    });

    it('選球眼（甘い球かどうか）は打席の左右で変わらない', () => {
      const middle = flightAt(CONTACT_PLANE_Z, { x: 0, vx: 0 });
      expect(shouldCpuSwing(middle, EMPTY_COUNT, LEFT_BATTER_SIDE)).toBe(true);
      // 到達範囲には入るが甘くない際どいコース（左右どちらの打席でも見送る）
      const tough = flightAt(CONTACT_PLANE_Z, { x: -0.63, vx: 0 });
      expect(shouldCpuSwing(tough, { balls: 0, strikes: 1 }, LEFT_BATTER_SIDE)).toBe(false);
    });

    it('省略時は右打者（従来の固定）と同じ', () => {
      const flight = flightAt(CONTACT_PLANE_Z, { x: BAT_REACH_INSIDE_X, vx: 0 });
      expect(shouldCpuSwing(flight, EMPTY_COUNT)).toBe(
        shouldCpuSwing(flight, EMPTY_COUNT, RIGHT_BATTER_SIDE),
      );
    });
  });
});
