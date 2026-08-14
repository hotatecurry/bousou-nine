import { describe, expect, it } from 'vitest';
import {
  cpuSwingLead,
  crossesSwingDecisionPoint,
  predictCrossX,
  shouldCpuSwing,
  timeToContactPlane,
} from '../src/core/cpuBatter';
import {
  BAT_REACH_INSIDE_X,
  BAT_REACH_OUTSIDE_X,
  CONTACT_PLANE_Z,
  SWING_ACTIVE_SEC,
  SWING_IDEAL_SEC,
  SWING_STARTUP_SEC,
} from '../src/core/batting';
import type { PitchFlight } from '../src/core/pitch';
import {
  LEFT_BATTER_SIDE,
  RIGHT_BATTER_SIDE,
  SPEED_FAST,
  SPEED_NEUTRAL,
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

describe('crossesSwingDecisionPoint（スイング判断フレームのエッジ検出）', () => {
  // vz=30 は基準速(36)未満なので速球ペナルティ0＝lead は SWING_IDEAL_SEC のまま
  const lead = cpuSwingLead(30);

  it('残り時間がしきい値を上から下へまたいだフレームでtrue', () => {
    // z = CONTACT_PLANE_Z - vz*t なので、t=lead+0.01 → t=lead-0.01 とまたがせる
    const prev = flightAt(CONTACT_PLANE_Z - 30 * (lead + 0.01), { vz: 30 });
    const next = flightAt(CONTACT_PLANE_Z - 30 * (lead - 0.01), { vz: 30 });
    expect(crossesSwingDecisionPoint(prev, next)).toBe(true);
  });

  it('しきい値をまだ上回ったままなら false', () => {
    const prev = flightAt(CONTACT_PLANE_Z - 30 * (lead + 0.05), { vz: 30 });
    const next = flightAt(CONTACT_PLANE_Z - 30 * (lead + 0.03), { vz: 30 });
    expect(crossesSwingDecisionPoint(prev, next)).toBe(false);
  });

  it('既にしきい値を下回った状態が続いているだけなら false（このフレームで跨いだのではない）', () => {
    const prev = flightAt(CONTACT_PLANE_Z - 30 * (lead - 0.03), { vz: 30 });
    const next = flightAt(CONTACT_PLANE_Z - 30 * (lead - 0.05), { vz: 30 });
    expect(crossesSwingDecisionPoint(prev, next)).toBe(false);
  });
});

describe('cpuSwingLead（速球ほど早振りでタイミングを外す）', () => {
  it('基準速以下ではペナルティなし（ジャストミートのリード）', () => {
    expect(cpuSwingLead(SPEED_NEUTRAL)).toBe(SWING_IDEAL_SEC);
    expect(cpuSwingLead(SPEED_NEUTRAL - 5)).toBe(SWING_IDEAL_SEC);
  });

  it('速球ほどリードが伸びる（早振り＝タイミングを外す）', () => {
    expect(cpuSwingLead(SPEED_FAST)).toBeGreaterThan(cpuSwingLead(SPEED_NEUTRAL));
    // 速球でも有効スイング窓（0.14秒）の中に収まる＝空振りにはならず「弱い当たり」になる
    expect(cpuSwingLead(SPEED_FAST)).toBeLessThan(SWING_STARTUP_SEC + SWING_ACTIVE_SEC);
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

  it('2ストライク未満は「甘い球の範囲」より外・バット到達範囲より内側の際どいコースを見送る', () => {
    // 0.63: 到達範囲(<=0.65)には入るが、甘い球の許容幅(<=0.6)は超える際どいコース
    const flight = flightAt(CONTACT_PLANE_Z, { x: 0.63, vx: 0 });
    expect(shouldCpuSwing(flight, { balls: 0, strikes: 1 })).toBe(false);
  });

  it('2ストライク以降は同じ際どいコースにも手を出す（三振回避で粘る）', () => {
    const flight = flightAt(CONTACT_PLANE_Z, { x: 0.63, vx: 0 });
    expect(shouldCpuSwing(flight, { balls: 0, strikes: 2 })).toBe(true);
  });

  it('甘い球（ど真ん中）は2ストライク未満でも振る', () => {
    const flight = flightAt(CONTACT_PLANE_Z, { x: 0, vx: 0 });
    expect(shouldCpuSwing(flight, EMPTY_COUNT)).toBe(true);
  });

  describe('打席の左右（フェーズB-9）', () => {
    it('バットの到達範囲がXについて鏡像になる', () => {
      // 到達範囲は外角側のほうが広い（judgeSwing と同じ非対称）ので、右打者（三塁側に
      // 立つ。フェーズBB-49）の外角いっぱいは +0.75＝一塁側で、左打者には背中側＝届かない
      const outsideForRight = flightAt(CONTACT_PLANE_Z, { x: -BAT_REACH_OUTSIDE_X, vx: 0 });
      expect(shouldCpuSwing(outsideForRight, { balls: 0, strikes: 2 }, RIGHT_BATTER_SIDE)).toBe(true);
      expect(shouldCpuSwing(outsideForRight, { balls: 0, strikes: 2 }, LEFT_BATTER_SIDE)).toBe(false);

      const outsideForLeft = flightAt(CONTACT_PLANE_Z, { x: BAT_REACH_OUTSIDE_X, vx: 0 });
      expect(shouldCpuSwing(outsideForLeft, { balls: 0, strikes: 2 }, LEFT_BATTER_SIDE)).toBe(true);
      expect(shouldCpuSwing(outsideForLeft, { balls: 0, strikes: 2 }, RIGHT_BATTER_SIDE)).toBe(false);
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
