/**
 * CPU投手の配球のくじ＝緩急と、追い込んでからの勝負球（フェーズCCC-86）。
 *
 * BBB-84 で内外角は読めなくなったが、配球にはまだ**投げる前に分かる**ものが2つ残っていた：
 * **球速はカウントだけで決まっていた**（初球は必ず速球・ストライクの後はフォーク…）／
 * **追い込んだ1球は、制球が中位以下の投手なら必ずボール**（決め球は隅の1つ外側。T-41）。
 * どちらも内外角と同じ形で塞いだ：**いつもの形（カウントの傾向）は手がかりとして残し、
 * くじが当たったときだけ外す**。
 *
 * ここが固定するのは規則。割合と帰結の帯は `tests/pitchPace.test.ts`（`npm run balance:pace`）。
 */
import { describe, expect, it } from 'vitest';
import {
  type CpuPitchMix,
  type CpuPitcherStyle,
  type CpuSpeedMode,
  CORNER_MARGIN,
  CPU_ATTACK_CHANCE,
  CPU_CONTROL_MAX_TARGET,
  CPU_PACE_CHANGE_CHANCE,
  CPU_PACE_SCOPE,
  NORMAL_TARGET_X,
  chooseCpuPitchPlan,
  cpuControlSpray,
  drawCpuPitchMix,
} from '../src/core/cpuPitcher';
import { LEFT_BATTER_SIDE, RIGHT_BATTER_SIDE, STRIKE_ZONE_HALF_WIDTH, batterFrameX } from '../src/core/pitch';
import { createRngState, nextRng } from '../src/core/rng';
import type { Count } from '../src/core/rules';

const COUNTS: Count[] = [];
for (let balls = 0; balls <= 3; balls += 1) {
  for (let strikes = 0; strikes <= 2; strikes += 1) COUNTS.push({ balls, strikes });
}
const STYLES: CpuPitcherStyle[] = ['power', 'breaking', 'balanced'];
const CONTROLS = [0, 0.25, 0.4, 0.5, 0.75, 1];
const MODES: CpuSpeedMode[] = ['fast', 'neutral', 'slow'];

/** くじが何も起こさない球（外さない・勝負しない） */
const QUIET: CpuPitchMix = { change: false, pick: 0.5, attack: false };

/** CCC-86 の前の球速（カウントだけで決まる。ワンバウンドするフォークは投手有利のときだけ＝BBB-79） */
function usualSpeed(count: Count, style: CpuPitcherStyle, bouncing: boolean): CpuSpeedMode {
  const ahead = count.strikes > count.balls;
  const ok = (m: CpuSpeedMode): CpuSpeedMode => (m === 'slow' && bouncing && !ahead ? 'neutral' : m);
  if (count.strikes >= 2) {
    return ok(style === 'power' ? 'fast' : style === 'breaking' ? 'slow' : 'neutral');
  }
  if (count.balls >= 3) return 'neutral';
  return ok(count.strikes === 0 ? 'fast' : 'slow');
}

describe('配球のくじを引く（drawCpuPitchMix）', () => {
  it('同じ状態からは必ず同じ結果（シードを固定すれば試合まるごと再現できる）', () => {
    const state = createRngState(4242);
    expect(drawCpuPitchMix(state)).toEqual(drawCpuPitchMix(state));
  });

  it('1球につき必ず3つ進む（外さない球・追い込んでいない球でも系列の進み方は同じ）', () => {
    const state = createRngState(31);
    expect(drawCpuPitchMix(state).state).toBe(nextRng(nextRng(nextRng(state).state).state).state);
  });

  it('外すのは CPU_PACE_CHANGE_CHANCE・勝負球は CPU_ATTACK_CHANCE の割合で、互いに独立', () => {
    let state = createRngState(2026);
    let change = 0;
    let attack = 0;
    let both = 0;
    let pickSum = 0;
    const n = 30000;
    for (let i = 0; i < n; i += 1) {
      const draw = drawCpuPitchMix(state);
      state = draw.state;
      if (draw.mix.change) change += 1;
      if (draw.mix.attack) attack += 1;
      if (draw.mix.change && draw.mix.attack) both += 1;
      pickSum += draw.mix.pick;
    }
    expect(change / n).toBeCloseTo(CPU_PACE_CHANGE_CHANCE, 1);
    expect(attack / n).toBeCloseTo(CPU_ATTACK_CHANCE, 1);
    expect(both / n).toBeCloseTo(CPU_PACE_CHANGE_CHANCE * CPU_ATTACK_CHANCE, 1);
    expect(pickSum / n).toBeCloseTo(0.5, 1);
  });

  it('割合を0にすれば決して起きず、1にすれば必ず起きる（計測が割合を振るための引数）', () => {
    let state = createRngState(5);
    for (let i = 0; i < 200; i += 1) {
      const never = drawCpuPitchMix(state, 0, 0);
      expect(never.mix.change).toBe(false);
      expect(never.mix.attack).toBe(false);
      const always = drawCpuPitchMix(state, 1, 1);
      expect(always.mix.change).toBe(true);
      expect(always.mix.attack).toBe(true);
      state = never.state;
    }
  });

  it('いつもの形は手がかりのまま＝外れるのは半分より少ない（半分なら何も語らない）', () => {
    expect(CPU_PACE_CHANGE_CHANCE).toBeGreaterThan(0);
    expect(CPU_PACE_CHANGE_CHANCE).toBeLessThan(0.5);
    expect(CPU_ATTACK_CHANCE).toBeGreaterThan(0);
    expect(CPU_ATTACK_CHANCE).toBeLessThan(1);
  });
});

describe('くじが何も起こさない球は CCC-86 の前とまったく同じ', () => {
  it('どのカウント・持ち味・制球・ワンバウンドの有無でも、方針は渡さないときと同じ', () => {
    for (const count of COUNTS) {
      for (const style of STYLES) {
        for (const control of CONTROLS) {
          for (const bouncingFork of [false, true]) {
            const sides = { side: -1 as const, cross: false };
            const bare = chooseCpuPitchPlan(count, style, control, 0, { bouncingFork, sides });
            const quiet = chooseCpuPitchPlan(count, style, control, 0, { bouncingFork, sides, mix: QUIET });
            expect(quiet).toEqual(bare);
            expect(bare.speed).toBe(usualSpeed(count, style, bouncingFork));
          }
        }
      }
    }
  });
});

describe('緩急を外す', () => {
  it('外すときは、いつもの球速以外の、投げてよい球速になる（コースは変わらない）', () => {
    for (const count of COUNTS) {
      for (const style of STYLES) {
        for (const bouncingFork of [false, true]) {
          const usual = usualSpeed(count, style, bouncingFork);
          const quiet = chooseCpuPitchPlan(count, style, 0.5, 0, { bouncingFork, mix: QUIET });
          for (const pick of [0, 0.3, 0.6, 0.999]) {
            const plan = chooseCpuPitchPlan(count, style, 0.5, 0, {
              bouncingFork,
              mix: { change: true, pick, attack: false },
            });
            expect(plan.targetX).toBe(quiet.targetX);
            const ahead = count.strikes > count.balls;
            // ワンバウンドするフォークは、投手有利のときしか投げない（BBB-79 はくじでも崩れない）
            if (bouncingFork && !ahead) expect(plan.speed).not.toBe('slow');
            if (count.balls >= 3 && count.strikes < 2) {
              // 3ボールの置き球は外さない（T-41 の「待った側への報酬」。CPU_PACE_SCOPE）
              expect(plan.speed).toBe('neutral');
            } else {
              expect(plan.speed).not.toBe(usual);
            }
          }
        }
      }
    }
  });

  it('残りの候補のどれになるかは pick で決まる（区間を等分。速い順）', () => {
    const count = { balls: 0, strikes: 0 };
    const at = (pick: number): CpuSpeedMode =>
      chooseCpuPitchPlan(count, 'balanced', 0.5, 0, { mix: { change: true, pick, attack: false } }).speed;
    // いつもの速球を外す＝基準速かフォーク
    expect(at(0)).toBe('neutral');
    expect(at(0.49)).toBe('neutral');
    expect(at(0.5)).toBe('slow');
    expect(at(0.999)).toBe('slow');
    // ワンバウンドするフォークを持つ投手の初球（投手有利ではない）＝外すなら基準速しか無い
    const bouncing = (pick: number): CpuSpeedMode =>
      chooseCpuPitchPlan(count, 'balanced', 0.5, 0, {
        bouncingFork: true,
        mix: { change: true, pick, attack: false },
      }).speed;
    expect(bouncing(0)).toBe('neutral');
    expect(bouncing(0.999)).toBe('neutral');
  });

  it('決め球も外す・3ボールの置き球は外さない（2026-10-14 ユーザー判断）', () => {
    expect(CPU_PACE_SCOPE).toEqual({ putaway: true, threeBalls: false });
  });

  it('区分を差し替えれば、決め球を持ち味のまま・置き球も外す、もできる（計測用の引数）', () => {
    const change = { change: true, pick: 0, attack: false };
    const putaway = chooseCpuPitchPlan({ balls: 0, strikes: 2 }, 'power', 0.5, 0, {
      mix: change,
      paceScope: { putaway: false, threeBalls: true },
    });
    expect(putaway.speed).toBe('fast');
    const three = chooseCpuPitchPlan({ balls: 3, strikes: 0 }, 'power', 0.5, 0, {
      mix: change,
      paceScope: { putaway: false, threeBalls: true },
    });
    expect(three.speed).not.toBe('neutral');
    expect(three.targetX).toBe(0);
  });

  it('いつもの球速がそのカウントの傾向になる（外す割合 1/3 なら 2/3 がいつもの球速）', () => {
    let state = createRngState(77);
    const tally: Record<CpuSpeedMode, number> = { fast: 0, neutral: 0, slow: 0 };
    const n = 6000;
    for (let i = 0; i < n; i += 1) {
      const draw = drawCpuPitchMix(state);
      state = draw.state;
      tally[chooseCpuPitchPlan({ balls: 0, strikes: 0 }, 'balanced', 0.5, 0, { mix: draw.mix }).speed] += 1;
    }
    expect(tally.fast / n).toBeCloseTo(1 - CPU_PACE_CHANGE_CHANCE, 1);
    expect(tally.neutral / n).toBeCloseTo(CPU_PACE_CHANGE_CHANCE / 2, 1);
    expect(tally.slow / n).toBeCloseTo(CPU_PACE_CHANGE_CHANCE / 2, 1);
    for (const m of MODES) expect(tally[m]).toBeGreaterThan(0);
  });
});

describe('勝負球（追い込んだ1球がゾーンの隅へ）', () => {
  const attack: CpuPitchMix = { change: false, pick: 0.5, attack: true };

  it('追い込む前の球には効かない', () => {
    for (const count of COUNTS.filter((c) => c.strikes < 2)) {
      for (const control of CONTROLS) {
        const sides = { side: 1 as const, cross: false };
        expect(chooseCpuPitchPlan(count, 'balanced', control, 0, { sides, mix: attack })).toEqual(
          chooseCpuPitchPlan(count, 'balanced', control, 0, { sides, mix: QUIET }),
        );
      }
    }
  });

  it('追い込んだら、狙いは通常の球と同じ隅（膨らみは外へだけ）＝外へ逃げる決め球の代わり', () => {
    for (const balls of [0, 1, 2, 3]) {
      for (const control of CONTROLS) {
        const count = { balls, strikes: 2 };
        const spray = cpuControlSpray(control);
        const sides = { side: 1 as const, cross: false };
        const chase = chooseCpuPitchPlan(count, 'balanced', control, 0, { sides, mix: QUIET });
        const plan = chooseCpuPitchPlan(count, 'balanced', control, 0, { sides, mix: attack });
        expect(chase.targetX).toBeCloseTo(
          Math.min(STRIKE_ZONE_HALF_WIDTH + CORNER_MARGIN + spray, CPU_CONTROL_MAX_TARGET),
          9,
        );
        expect(plan.targetX).toBeCloseTo(Math.min(NORMAL_TARGET_X + Math.max(0, spray), CPU_CONTROL_MAX_TARGET), 9);
        // 球速は決め球のまま（緩急のくじとは別）
        expect(plan.speed).toBe(chase.speed);
      }
    }
  });

  it('中位の投手の勝負球はストライク・荒れた投手の勝負球はボール（制球の値打ちは残る＝T-41）', () => {
    const count = { balls: 1, strikes: 2 };
    const at = (control: number): number =>
      Math.abs(chooseCpuPitchPlan(count, 'balanced', control, 0, { sides: { side: 1, cross: false }, mix: attack }).targetX);
    expect(at(0.5)).toBeLessThanOrEqual(STRIKE_ZONE_HALF_WIDTH);
    expect(at(0.4)).toBeLessThanOrEqual(STRIKE_ZONE_HALF_WIDTH);
    expect(at(0)).toBeGreaterThan(STRIKE_ZONE_HALF_WIDTH);
    // 決め球（外へ逃げる球）は、中位の投手ならボール
    const chase = chooseCpuPitchPlan(count, 'balanced', 0.5, 0, { sides: { side: 1, cross: false }, mix: QUIET });
    expect(Math.abs(chase.targetX)).toBeGreaterThan(STRIKE_ZONE_HALF_WIDTH);
  });

  it('勝負球はゾーンの球なので、打者の外角側に立ったときは逆を突きうる（BBB-84 の規則のまま）', () => {
    for (const batterSide of [RIGHT_BATTER_SIDE, LEFT_BATTER_SIDE]) {
      // 打者の外角側＝打者ローカルで負の側に立つ
      const outsideSide = (batterFrameX(1, batterSide) > 0 ? -1 : 1) as 1 | -1;
      const plan = chooseCpuPitchPlan({ balls: 0, strikes: 2 }, 'balanced', 0.5, 0, {
        sides: { side: outsideSide, cross: true },
        batterSide,
        mix: attack,
      });
      expect(plan.cross).toBe(true);
      expect(batterFrameX(plan.targetX, batterSide)).toBeGreaterThan(0);
      expect(Math.abs(plan.targetX)).toBeLessThanOrEqual(STRIKE_ZONE_HALF_WIDTH);
      // 外へ逃げる決め球は逆を突かない（ボール球は必ず立ち位置どおり）
      const chase = chooseCpuPitchPlan({ balls: 0, strikes: 2 }, 'balanced', 0.5, 0, {
        sides: { side: outsideSide, cross: true },
        batterSide,
        mix: QUIET,
      });
      expect(chase.cross).toBeUndefined();
    }
  });
});
