/**
 * 読みの札（フェーズYY-73）。**見せる軌道・通過点は実際の飛行と同じ関数から起こす**＝
 * 予言は外れない。
 */
import { describe, expect, it } from 'vitest';
import { chooseCpuPitchPlan, planCpuPitchShape } from '../src/core/cpuPitcher';
import { LEFT_BATTER_SIDE, RIGHT_BATTER_SIDE } from '../src/core/pitch';
import {
  courseReading,
  inSlowZone,
  plateCrossing,
  predictCpuPitchPath,
  readingText,
  speedReading,
} from '../src/core/skillSight';

const profile = { speed: 0.5, breakLeft: 0.5, breakRight: 0.5, fork: 0.5 };

describe('軌道と通過点', () => {
  it('通過点は狙ったコース（曲げる球でも）', () => {
    for (const count of [
      { balls: 0, strikes: 0 },
      { balls: 1, strikes: 1 },
      { balls: 0, strikes: 2 },
      { balls: 3, strikes: 0 },
    ]) {
      const plan = chooseCpuPitchPlan(count);
      const shape = planCpuPitchShape(plan, profile);
      const path = predictCpuPitchPath(shape, 1.5);
      expect(Math.abs(plateCrossing(path).x - plan.targetX)).toBeLessThan(0.02);
    }
  });

  it('軌道はリリースからミットまで続き、ミットの高さで終わる', () => {
    const plan = chooseCpuPitchPlan({ balls: 0, strikes: 1 });
    const shape = planCpuPitchShape(plan, profile);
    const path = predictCpuPitchPath(shape, 1.5);
    expect(path.length).toBeGreaterThan(20);
    expect(path[0].y).toBeCloseTo(1.5, 5);
    expect(path[path.length - 1].y).toBeGreaterThan(0.8);
  });
});

describe('読みの文字', () => {
  it('球種とコース（打者から見て）', () => {
    expect(speedReading({ targetX: 0, speed: 'fast' })).toBe('速球');
    expect(speedReading({ targetX: 0, speed: 'slow' })).toBe('フォーク');
    // 右打者は -X に立つ＝-X が内角
    expect(courseReading(-0.4, RIGHT_BATTER_SIDE)).toBe('内角');
    expect(courseReading(0.4, RIGHT_BATTER_SIDE)).toBe('外角');
    expect(courseReading(0.4, LEFT_BATTER_SIDE)).toBe('内角');
    expect(courseReading(0.05, RIGHT_BATTER_SIDE)).toBe('真ん中');
  });

  it('持っている読みだけを並べる（何も読めなければ null）', () => {
    const plan = { targetX: -0.4, speed: 'fast' as const };
    expect(readingText(plan, { speed: true, course: true }, RIGHT_BATTER_SIDE)).toBe('読み: 速球・内角');
    expect(readingText(plan, { course: true }, RIGHT_BATTER_SIDE)).toBe('読み: 内角');
    expect(readingText(plan, { crossing: true }, RIGHT_BATTER_SIDE)).toBeNull();
  });
});

describe('時間停止の区間', () => {
  it('本塁の手前だけ（投げた直後は普通の速さ）', () => {
    expect(inSlowZone(-17)).toBe(false);
    expect(inSlowZone(-3)).toBe(true);
    expect(inSlowZone(1)).toBe(false);
  });
});
