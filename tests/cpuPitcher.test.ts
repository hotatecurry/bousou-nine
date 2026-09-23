import { describe, expect, it } from 'vitest';
import {
  CORNER_MARGIN,
  CPU_GUN_POWER_THRESHOLD,
  CPU_PITCHER_STYLE_GAP,
  NORMAL_TARGET_X,
  chooseCpuPitchPlan,
  cpuPitcherStyle,
  cpuSteerAccelAt,
  planCpuPitchShape,
  releaseSpeedForPlan,
  shouldCpuPickoff,
  shouldCpuShoot,
} from '../src/core/cpuPitcher';
import {
  LEFT_ARM_SIDE,
  RIGHT_ARM_SIDE,
  RUBBER_HALF_RANGE,
  SPEED_FAST,
  SPEED_NEUTRAL,
  SPEED_SLOW,
  NEUTRAL_RATING,
  STRIKE_ZONE_HALF_WIDTH,
  armReleaseOffsetX,
  createPitchFlight,
  plateCrossingX,
  speedForPitchSelection,
  stepPitchFlight,
} from '../src/core/pitch';
import { EMPTY_BASES, EMPTY_COUNT } from '../src/core/rules';

describe('chooseCpuPitchPlan（カウントに応じた投球方針）', () => {
  it('初球（0-0）は速球・ボール0=偶数なので+側（外角）を狙う', () => {
    const plan = chooseCpuPitchPlan(EMPTY_COUNT);
    expect(plan.speed).toBe('fast');
    // フェーズTT-68：通常の球も「隅の1つ内側」を狙う（決め球＝隅の1つ外側と対称）
    expect(plan.targetX).toBeCloseTo(NORMAL_TARGET_X, 5);
    expect(NORMAL_TARGET_X).toBeCloseTo(STRIKE_ZONE_HALF_WIDTH - CORNER_MARGIN, 10);
  });

  it('ボール数が奇数なら狙うコースの符号が反転する', () => {
    const even = chooseCpuPitchPlan({ balls: 0, strikes: 0 });
    const odd = chooseCpuPitchPlan({ balls: 1, strikes: 0 });
    expect(Math.sign(odd.targetX)).toBe(-Math.sign(even.targetX));
  });

  it('2ストライク以降はゾーン境界よりわずかに外側の隅を突く', () => {
    const plan = chooseCpuPitchPlan({ balls: 0, strikes: 2 });
    expect(Math.abs(plan.targetX)).toBeGreaterThan(STRIKE_ZONE_HALF_WIDTH);
    expect(plan.speed).toBe('neutral');
  });

  it('3ボール以降は四球回避のためゾーン中央（ど真ん中）を狙う', () => {
    const plan = chooseCpuPitchPlan({ balls: 3, strikes: 1 });
    expect(plan.targetX).toBe(0);
    expect(plan.speed).toBe('neutral');
  });

  it('1ストライク（2未満）はスローボールを混ぜる', () => {
    const plan = chooseCpuPitchPlan({ balls: 0, strikes: 1 });
    expect(plan.speed).toBe('slow');
  });
});

// ---- 投手の持ち味（フェーズS-40。B-12の「CPUは球団の個性を活かさない」の投球側） ----

describe('cpuPitcherStyle（能力値から導出する持ち味）', () => {
  const profile = (speed: number, fork: number) => ({
    speed,
    fork,
    breakLeft: NEUTRAL_RATING,
    breakRight: NEUTRAL_RATING,
  });

  it('SPDがFより十分高ければ速球派', () => {
    expect(cpuPitcherStyle(profile(0.9, 0.3))).toBe('power');
  });

  it('FがSPDより十分高ければ技巧派', () => {
    expect(cpuPitcherStyle(profile(0.3, 0.9))).toBe('breaking');
  });

  it('差がしきい値に満たなければバランス型', () => {
    expect(cpuPitcherStyle(profile(0.6, 0.5))).toBe('balanced');
    expect(cpuPitcherStyle(profile(0.5, 0.6))).toBe('balanced');
  });

  it('しきい値ちょうどは持ち味が付く（境界は持ち味の側）', () => {
    expect(cpuPitcherStyle(profile(0.5 + CPU_PITCHER_STYLE_GAP, 0.5))).toBe('power');
    expect(cpuPitcherStyle(profile(0.5, 0.5 + CPU_PITCHER_STYLE_GAP))).toBe('breaking');
  });

  it('能力値を渡さなければバランス型＝S-40の前と同じ配球', () => {
    expect(cpuPitcherStyle()).toBe('balanced');
  });

  it('別フィールドを持たない＝同じ能力値から必ず同じ持ち味（乱数不使用）', () => {
    const p = profile(0.72, 0.41);
    expect(cpuPitcherStyle(p)).toBe(cpuPitcherStyle(p));
  });
});

describe('chooseCpuPitchPlan：持ち味が効くのは決め球だけ（フェーズS-40）', () => {
  const STYLES = ['power', 'breaking', 'balanced'] as const;
  const COUNTS = [
    { balls: 0, strikes: 0 },
    { balls: 1, strikes: 0 },
    { balls: 0, strikes: 1 },
    { balls: 2, strikes: 1 },
    { balls: 0, strikes: 2 },
    { balls: 3, strikes: 1 },
    { balls: 3, strikes: 2 },
  ];

  it('追い込んだら速球派は速球・技巧派はフォーク・バランス型は従来どおり基準速', () => {
    expect(chooseCpuPitchPlan({ balls: 0, strikes: 2 }, 'power').speed).toBe('fast');
    expect(chooseCpuPitchPlan({ balls: 0, strikes: 2 }, 'breaking').speed).toBe('slow');
    expect(chooseCpuPitchPlan({ balls: 0, strikes: 2 }, 'balanced').speed).toBe('neutral');
  });

  it('追い込む前の球速は持ち味によらない＝どの型にも緩急が残る', () => {
    for (const style of STYLES) {
      expect(chooseCpuPitchPlan({ balls: 0, strikes: 0 }, style).speed).toBe('fast');
      expect(chooseCpuPitchPlan({ balls: 0, strikes: 1 }, style).speed).toBe('slow');
      expect(chooseCpuPitchPlan({ balls: 3, strikes: 1 }, style).speed).toBe('neutral');
    }
  });

  it('狙うコースは持ち味を1つも見ない（I-29の打たれ方の骨格・P-37の逆算を動かさない）', () => {
    for (const count of COUNTS) {
      const base = chooseCpuPitchPlan(count).targetX;
      for (const style of STYLES) {
        expect(chooseCpuPitchPlan(count, style).targetX).toBe(base);
      }
    }
  });

  it('balanced は S-40 の前とすべてのカウントで完全に同じ方針を返す', () => {
    for (const count of COUNTS) {
      expect(chooseCpuPitchPlan(count, 'balanced')).toEqual(chooseCpuPitchPlan(count));
    }
  });
});

describe('持ち味が実際の球の差になる（planCpuPitchShape まで通す）', () => {
  const powerPitcher = { speed: 1, fork: 0.3, breakLeft: 0.3, breakRight: 0.3 };
  const breakingPitcher = { speed: 0.3, fork: 1, breakLeft: 1, breakRight: 1 };
  const putaway = (profile: typeof powerPitcher) =>
    planCpuPitchShape(
      chooseCpuPitchPlan({ balls: 0, strikes: 2 }, cpuPitcherStyle(profile)),
      profile,
    );

  it('速球派の決め球は飛行時間が短く（打者の時間を奪う）', () => {
    expect(putaway(powerPitcher).flightSec).toBeLessThan(putaway(breakingPitcher).flightSec);
  });

  it('技巧派の決め球は大きく曲がる（バットの届く範囲から逃げる）', () => {
    expect(putaway(breakingPitcher).breakWidth).toBeGreaterThan(putaway(powerPitcher).breakWidth);
  });

  it('どちらの決め球も狙ったコースへ届く（P-37の逆算は持ち味に関係なく成立する）', () => {
    for (const profile of [powerPitcher, breakingPitcher]) {
      const plan = chooseCpuPitchPlan({ balls: 0, strikes: 2 }, cpuPitcherStyle(profile));
      const shape = planCpuPitchShape(plan, profile);
      expect(shape.releaseX + shape.steerX * shape.breakWidth).toBeCloseTo(plan.targetX, 6);
    }
  });

  it('疲れた技巧派は持ち味を失う（B-11で変化量が下限まで落ちるため）', () => {
    // main.ts の currentPitchProfile が疲労を織り込んだ値を渡す＝ここに疲労の分岐は無い
    const tired = { ...breakingPitcher, fork: 0 };
    expect(cpuPitcherStyle(breakingPitcher)).toBe('breaking');
    expect(cpuPitcherStyle(tired)).toBe('power');
  });
});

describe('releaseSpeedForPlan（方針の球速モード→リリース球速）', () => {
  it('fast=速球、neutral=基準速、slow=フォーク/チェンジアップに対応する', () => {
    expect(releaseSpeedForPlan({ targetX: 0, speed: 'fast' })).toBe(SPEED_FAST);
    expect(releaseSpeedForPlan({ targetX: 0, speed: 'neutral' })).toBe(SPEED_NEUTRAL);
    expect(releaseSpeedForPlan({ targetX: 0, speed: 'slow' })).toBe(SPEED_SLOW);
  });
});

describe('CPU投球AIの統合シミュレーション（リリースからプレート通過まで）', () => {
  /**
   * シーン層（dekkaiScene.ts）が windup 前に `planCpuPitchShape` の解いた位置へ投手を
   * 置き、リリース時に球速を確定して飛ばす想定を再現する。
   *
   * **フェーズP-37より前は「リリース位置＝狙うコース」で飛行中いっさい曲げなかった**
   * ので、ここは `createPitchFlight(plan.targetX, ...)` を直接飛ばしていた。逆算が
   * 入ってリリース位置は狙いと別になったが、**保証すべきことは変わっていない**：
   * 方針が決めたコースへ寸分違わず着弾すること。曲がりそのものの検証は
   * `tests/cpuBreak.test.ts`（曲げる向き・変化量の反映・死球ゾーンへ入らないこと）。
   */
  function simulateCrossX(plan: ReturnType<typeof chooseCpuPitchPlan>): number {
    const shape = planCpuPitchShape(plan);
    let flight = createPitchFlight(shape.releaseX, shape.speed);
    const dt = 1 / 60;
    let sinceRelease = 0;
    for (let i = 0; i < 240; i++) {
      const next = stepPitchFlight(flight, shape.steerX, dt, cpuSteerAccelAt(shape, sinceRelease, dt));
      sinceRelease += dt;
      const cross = plateCrossingX(flight, next);
      if (cross !== null) return cross;
      flight = next;
    }
    throw new Error('本塁を通過しなかった（テストの前提が崩れている）');
  }

  it('2ストライク後の隅狙い（外角）が目標コースへ着弾する', () => {
    const plan = chooseCpuPitchPlan({ balls: 0, strikes: 2 });
    expect(simulateCrossX(plan)).toBeCloseTo(plan.targetX, 1);
  });

  it('2ストライク後の隅狙い（内角）が目標コースへ着弾する', () => {
    const plan = chooseCpuPitchPlan({ balls: 1, strikes: 2 });
    expect(simulateCrossX(plan)).toBeCloseTo(plan.targetX, 1);
  });

  it('3ボール後のゾーン中央狙いはど真ん中へ着弾する（曲げないので寸分違わず）', () => {
    const plan = chooseCpuPitchPlan({ balls: 3, strikes: 0 });
    expect(simulateCrossX(plan)).toBeCloseTo(0, 5);
  });

  it('速球の方針でも着弾コースはずれない（速度と位置が独立している）', () => {
    const plan = chooseCpuPitchPlan(EMPTY_COUNT);
    expect(plan.speed).toBe('fast');
    expect(simulateCrossX(plan)).toBeCloseTo(plan.targetX, 1);
  });

  it('リリース球速は飛行中ずっと維持される（暴走しない）', () => {
    const plan = { targetX: 0, speed: 'fast' as const };
    let flight = createPitchFlight(0, releaseSpeedForPlan(plan));
    for (let i = 0; i < 60; i++) {
      flight = stepPitchFlight(flight, 0, 1 / 60);
    }
    expect(flight.vz).toBe(SPEED_FAST);
  });
});

describe('shouldCpuPickoff（CPU投手のけん制判断・説明書p24）', () => {
  it('走者がいなければけん制しない', () => {
    expect(shouldCpuPickoff(EMPTY_BASES, false)).toBe(false);
  });

  it('リードを取っている走者がいればけん制する', () => {
    expect(shouldCpuPickoff({ first: true, second: false, third: false }, false, { first: 3.5 })).toBe(
      true,
    );
    expect(shouldCpuPickoff({ first: false, second: false, third: true }, false, { third: 2 })).toBe(
      true,
    );
  });

  /**
   * フェーズJJ-57：**塁についたままの走者にはけん制しない**。II-56 で人間の走者は
   * 方向キーを押している間しかリードしなくなったので、押していない走者へ入っても
   * **投げる候補が永久に生まれない**（＝画面が数秒切り替わるだけ）。テストプレイの
   * 「盗塁しかけようとしていないのにけん制されてうっとうしい」がこれ。
   */
  it('塁を離れていない走者にはけん制しない（リードが0＝刺しようがない）', () => {
    const first = { first: true, second: false, third: false };
    expect(shouldCpuPickoff(first, false)).toBe(false);
    expect(shouldCpuPickoff(first, false, {})).toBe(false);
    expect(shouldCpuPickoff(first, false, { first: 0 })).toBe(false);
    // 走者のいない塁のリードは見ない（前の走者の値が残っていても発火しない）
    expect(shouldCpuPickoff(first, false, { second: 5 })).toBe(false);
  });

  it('同じ打席で2回目はけん制しない（毎球けん制されるとテンポが壊れる）', () => {
    expect(
      shouldCpuPickoff({ first: true, second: false, third: false }, true, { first: 5 }),
    ).toBe(false);
  });
});

describe('releaseSpeedForPlan（投手の球速能力の反映：フェーズB-8）', () => {
  it('能力値を渡さなければ従来の球速のまま', () => {
    for (const speed of ['fast', 'neutral', 'slow'] as const) {
      expect(releaseSpeedForPlan({ targetX: 0, speed })).toBe(
        releaseSpeedForPlan({ targetX: 0, speed }, NEUTRAL_RATING),
      );
    }
  });

  it('球速の高いCPU投手はどの方針でも速い球を投げる', () => {
    for (const speed of ['fast', 'neutral', 'slow'] as const) {
      expect(releaseSpeedForPlan({ targetX: 0, speed }, 1)).toBeGreaterThan(
        releaseSpeedForPlan({ targetX: 0, speed }, 0),
      );
    }
  });

  it('CPUと人間の球速は同じ関数で決まる（同じ能力値なら同じ球速）', () => {
    expect(releaseSpeedForPlan({ targetX: 0, speed: 'fast' }, 0.8)).toBe(
      speedForPitchSelection(-1, 0.8),
    );
    expect(releaseSpeedForPlan({ targetX: 0, speed: 'slow' }, 0.8)).toBe(
      speedForPitchSelection(1, 0.8),
    );
  });
});

// ---- 銃（フェーズF-26-2。ユーザー判断：強打者を敬遠する場面で撃つ） ----
//
// 命中＝死球＝一塁へ歩かせる（CLAUDE.md ③）ので、規則も敬遠の定石にしてある。
// **決定的**なので、打順表と塁の状態から「撃たれる打席」が事前に読める
// （桜井ノウハウ「コンピューターが良い目を出すとイカサマしてると思われがち」への対応）。

describe('shouldCpuShoot: CPU投手の銃', () => {
  const EMPTY = { first: false, second: false, third: false };
  const SLUGGER = CPU_GUN_POWER_THRESHOLD + 0.1;
  const CONTACT = CPU_GUN_POWER_THRESHOLD - 0.1;

  function shoot(over: Partial<Parameters<typeof shouldCpuShoot>[0]> = {}) {
    return shouldCpuShoot({
      ammo: 3,
      bases: EMPTY,
      batterPower: SLUGGER,
      usedThisPlateAppearance: false,
      ...over,
    });
  }

  it('一塁が空いた強打者の打席では撃つ', () => {
    expect(shoot()).toBe(true);
  });

  it('長打力が並の打者には撃たない（歩かせる価値がない）', () => {
    expect(shoot({ batterPower: CONTACT })).toBe(false);
  });

  it('一塁が埋まっていれば撃たない（走者を増やすだけ・満塁なら押し出し）', () => {
    expect(shoot({ bases: { ...EMPTY, first: true } })).toBe(false);
    expect(shoot({ bases: { first: true, second: true, third: true } })).toBe(false);
  });

  it('二・三塁の走者は判断に影響しない（一塁が空いていれば敬遠の形になる）', () => {
    expect(shoot({ bases: { first: false, second: true, third: true } })).toBe(true);
  });

  it('残弾が無ければ撃たない（ジュウを引いていないCPUはこの経路に入らない）', () => {
    expect(shoot({ ammo: 0 })).toBe(false);
  });

  it('1打席1回まで（毎球構えられると試合が進まない）', () => {
    expect(shoot({ usedThisPlateAppearance: true })).toBe(false);
  });

  it('しきい値ちょうどは撃つ（境界が決定的で読める）', () => {
    expect(shoot({ batterPower: CPU_GUN_POWER_THRESHOLD })).toBe(true);
  });
});

describe('投球腕がリリース位置に効く（フェーズCC-50）', () => {
  const COUNTS = [
    { balls: 0, strikes: 0 },
    { balls: 1, strikes: 0 },
    { balls: 0, strikes: 1 },
    { balls: 0, strikes: 2 },
    { balls: 3, strikes: 1 },
  ];
  const ARMS = [
    { side: RIGHT_ARM_SIDE, slot: 'over' },
    { side: LEFT_ARM_SIDE, slot: 'over' },
    { side: RIGHT_ARM_SIDE, slot: 'side' },
    { side: RIGHT_ARM_SIDE, slot: 'under' },
  ] as const;

  /**
   * P-37 の不変条件そのもの。腕がずらすのは**リリース位置と立ち位置**だけで、
   * 狙い（`targetX`）は1行も触っていない＝I-29で測った打たれ方も T-41 の死球の帰結も動かない。
   */
  it('狙うコースは腕によって1mmも変わらない', () => {
    for (const count of COUNTS) {
      const plan = chooseCpuPitchPlan(count);
      for (const arm of ARMS) {
        const shape = planCpuPitchShape(plan, undefined, undefined, armReleaseOffsetX(arm));
        // 逆算は「狙い − 曲がり」なので、曲がりを足し戻すと必ず狙いに一致する
        expect(shape.releaseX + shape.steerX * shape.breakWidth).toBeCloseTo(plan.targetX, 6);
      }
    }
  });

  it('体は必ずプレートの上（±RUBBER_HALF_RANGE）に立ち、球はそこから腕のぶん外れて出る', () => {
    for (const count of COUNTS) {
      const plan = chooseCpuPitchPlan(count);
      for (const arm of ARMS) {
        const offset = armReleaseOffsetX(arm);
        const shape = planCpuPitchShape(plan, undefined, undefined, offset);
        expect(Math.abs(shape.plateX)).toBeLessThanOrEqual(RUBBER_HALF_RANGE + 1e-9);
        expect(shape.releaseX - shape.plateX).toBeCloseTo(offset, 10);
      }
    }
  });

  it('腕を渡さない呼び出しは従来どおり（立ち位置＝リリース位置）', () => {
    for (const count of COUNTS) {
      const shape = planCpuPitchShape(chooseCpuPitchPlan(count));
      expect(shape.plateX).toBeCloseTo(shape.releaseX, 10);
    }
  });

  /**
   * 右投手が +X の隅へ投げるのと、左投手が -X の隅へ投げるのは完全な鏡像＝
   * **どちらか片方だけ有利／不利ということが構造的に起きない**（B-9が打席の左右で
   * 片側ぶんの式をそのまま鏡像に使ったのと同じ整理）。
   */
  it('右投げと左投げは完全な鏡像（狙いも一緒に反転させれば符号だけが逆）', () => {
    for (const targetX of [0.5, 0.2475, 0]) {
      const right = planCpuPitchShape(
        { targetX, speed: 'slow' },
        undefined,
        undefined,
        armReleaseOffsetX({ side: RIGHT_ARM_SIDE, slot: 'over' }),
      );
      const left = planCpuPitchShape(
        { targetX: -targetX, speed: 'slow' },
        undefined,
        undefined,
        armReleaseOffsetX({ side: LEFT_ARM_SIDE, slot: 'over' }),
      );
      expect(right.plateX).toBeCloseTo(-left.plateX, 10);
      expect(right.releaseX).toBeCloseTo(-left.releaseX, 10);
      expect(right.breakWidth).toBeCloseTo(left.breakWidth, 10);
    }
  });
});
