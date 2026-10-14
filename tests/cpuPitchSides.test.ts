/**
 * CPU投手の内外角と、立ち位置という手がかり（フェーズBBB-84）。
 *
 * BBB-83 までは内外角が「ボール数＋ファウル数の偶奇」で決まり、投手の立ち位置にも必ず
 * 出ていた＝人間の打者は投げる前に100%読めた。BBB-84 からは**試合のシードの別系列から引き**、
 * 立ち位置は「たいていそちら側」の手がかりになる：**打者の外角側に立ったときだけ**、
 * `CPU_CROSS_CHANCE` の割合で内角のストライクへ逆を突く。
 *
 * あわせて、寄ることが「もらい得」にならないための2つ：**CPU投手は踏み込んでいる打者の体へ
 * 投げない**（`avoidCrowdingBatter`）／**投げた後に踏み込んで当たった球は死球にしない**
 * （`judgePitch` の `releaseStance`）。
 *
 * ここが固定するのは規則と球の形。割合と帰結の帯は `tests/pitchTell.test.ts`
 * （`npm run balance:tell`）。
 */
import { describe, expect, it } from 'vitest';
import {
  type CpuPitchPlan,
  type CpuPitchShape,
  type CpuPitcherStyle,
  CPU_BREAK_STEER_SEC,
  CPU_CROSS_CHANCE,
  avoidCrowdingBatter,
  chooseCpuPitchPlan,
  cpuSteerAccelAt,
  drawCpuPitchSides,
  planCpuPitchShape,
} from '../src/core/cpuPitcher';
import {
  type PitchProfile,
  BATTER_STANCE_RANGE,
  BATTER_ZONE_MIN_X,
  LEFT_ARM_SIDE,
  LEFT_BATTER_SIDE,
  NEUTRAL_PITCH_PROFILE,
  RIGHT_ARM_SIDE,
  RIGHT_BATTER_SIDE,
  RUBBER_HALF_RANGE,
  STRIKE_ZONE_HALF_WIDTH,
  armReleaseOffsetX,
  batterFrameX,
  createPitchFlight,
  judgePitch,
  plateCrossingX,
  stepPitchFlight,
} from '../src/core/pitch';
import { createRngState, nextRng } from '../src/core/rng';
import type { Count } from '../src/core/rules';
import { predictCpuPitchPath, plateCrossing } from '../src/core/skillSight';

const COUNTS: Count[] = [];
for (let balls = 0; balls <= 3; balls += 1) {
  for (let strikes = 0; strikes <= 2; strikes += 1) COUNTS.push({ balls, strikes });
}
const STYLES: CpuPitcherStyle[] = ['power', 'breaking', 'balanced'];
const CONTROLS = [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 1];
const PROFILES: PitchProfile[] = [
  NEUTRAL_PITCH_PROFILE,
  { speed: 1, breakLeft: 0.1, breakRight: 0.1, fork: 0.1 },
  { speed: 0, breakLeft: 1, breakRight: 1, fork: 1 },
  { speed: 0.72, breakLeft: 0.3, breakRight: 0.8, fork: 0.55 },
];
const ARMS = [
  { side: RIGHT_ARM_SIDE, slot: 'over' },
  { side: LEFT_ARM_SIDE, slot: 'over' },
  { side: RIGHT_ARM_SIDE, slot: 'side' },
  { side: RIGHT_ARM_SIDE, slot: 'under' },
] as const;

/** 形どおりに飛ばして、本塁を通るXを返す（`dekkaiScene.ts` の release → flight と同じ並び） */
function crossX(shape: CpuPitchShape, dt = 1 / 60): number {
  let flight = createPitchFlight(shape.releaseX, shape.speed, shape.releaseVx);
  let since = 0;
  for (let i = 0; i < 4000; i += 1) {
    const next = stepPitchFlight(flight, shape.steerX, dt, cpuSteerAccelAt(shape, since, dt));
    since += dt;
    const x = plateCrossingX(flight, next);
    if (x !== null) return x;
    flight = next;
  }
  throw new Error('本塁を通過しなかった（テストの前提が崩れている）');
}

describe('内外角を引く（drawCpuPitchSides）', () => {
  it('同じ状態からは必ず同じ結果（シードを固定すれば試合まるごと再現できる）', () => {
    const state = createRngState(12345);
    expect(drawCpuPitchSides(state)).toEqual(drawCpuPitchSides(state));
  });

  it('1球につき必ず2つ進む（側を持たない球でも系列の進み方は同じ）', () => {
    const state = createRngState(777);
    expect(drawCpuPitchSides(state).state).toBe(nextRng(nextRng(state).state).state);
  });

  it('側は五分五分、逆を突くのは CPU_CROSS_CHANCE の割合', () => {
    let state = createRngState(2026);
    let first = 0;
    let cross = 0;
    const n = 20000;
    for (let i = 0; i < n; i += 1) {
      const draw = drawCpuPitchSides(state);
      state = draw.state;
      if (draw.sides.side === 1) first += 1;
      if (draw.sides.cross) cross += 1;
    }
    expect(first / n).toBeGreaterThan(0.48);
    expect(first / n).toBeLessThan(0.52);
    expect(cross / n).toBeGreaterThan(CPU_CROSS_CHANCE - 0.02);
    expect(cross / n).toBeLessThan(CPU_CROSS_CHANCE + 0.02);
  });

  it('立ち位置は手がかりのまま＝外れるのは半分より少ない（半分なら何も語らない）', () => {
    expect(CPU_CROSS_CHANCE).toBeGreaterThan(0);
    expect(CPU_CROSS_CHANCE).toBeLessThan(0.5);
  });

  it('割合を0にすれば必ず立ち位置どおり、1にすれば必ず逆（計測が割合を振るための引数）', () => {
    let state = createRngState(9);
    for (let i = 0; i < 200; i += 1) {
      expect(drawCpuPitchSides(state, 0).sides.cross).toBe(false);
      expect(drawCpuPitchSides(state, 1).sides.cross).toBe(true);
      state = drawCpuPitchSides(state).state;
    }
  });

  it('立つ側と「逆を突くくじ」は別々に決まる（どちらの側に立っても、くじの割合は同じ）', () => {
    let state = createRngState(31);
    const seen = { '1': [0, 0], '-1': [0, 0] } as Record<string, [number, number]>;
    for (let i = 0; i < 20000; i += 1) {
      const draw = drawCpuPitchSides(state);
      state = draw.state;
      seen[String(draw.sides.side)][draw.sides.cross ? 1 : 0] += 1;
    }
    for (const [honest, cross] of Object.values(seen)) {
      expect(cross / (honest + cross)).toBeGreaterThan(CPU_CROSS_CHANCE - 0.03);
      expect(cross / (honest + cross)).toBeLessThan(CPU_CROSS_CHANCE + 0.03);
    }
  });
});

describe('chooseCpuPitchPlan：立つ側は引いた側、逆を突くのは外角側に立って内角へ', () => {
  it('くじが外れなら、引いた側へ投げる（カウントの偶奇も、ファウルの数も見ない）', () => {
    for (const count of COUNTS) {
      for (const side of [1, -1] as const) {
        for (const fouls of [0, 1, 2]) {
          const plan = chooseCpuPitchPlan(count, 'balanced', 0.5, fouls, { sides: { side, cross: false } });
          if (plan.targetX !== 0) expect(Math.sign(plan.targetX)).toBe(side);
        }
      }
    }
  });

  it('狙う距離と球速は、側を引かない規則と1つも変わらない（変わるのは「どちらの隅か」だけ）', () => {
    for (const count of COUNTS) {
      for (const style of STYLES) {
        for (const control of CONTROLS) {
          for (const bouncingFork of [false, true]) {
            const legacy = chooseCpuPitchPlan(count, style, control, 0, { bouncingFork });
            for (const side of [1, -1] as const) {
              for (const cross of [false, true]) {
                for (const batterSide of [RIGHT_BATTER_SIDE, LEFT_BATTER_SIDE]) {
                  const plan = chooseCpuPitchPlan(count, style, control, 0, {
                    bouncingFork,
                    sides: { side, cross },
                    batterSide,
                  });
                  expect(Math.abs(plan.targetX)).toBeCloseTo(Math.abs(legacy.targetX), 12);
                  expect(plan.speed).toBe(legacy.speed);
                }
              }
            }
          }
        }
      }
    }
  });

  it('逆を突くのは、打者の外角側に立って、内角のストライクへ投げるときだけ', () => {
    let crossed = 0;
    let honestOffPlate = 0;
    let honestInside = 0;
    for (const count of COUNTS) {
      for (const control of CONTROLS) {
        for (const side of [1, -1] as const) {
          for (const batterSide of [RIGHT_BATTER_SIDE, LEFT_BATTER_SIDE]) {
            const honest = chooseCpuPitchPlan(count, 'balanced', control, 0, {
              sides: { side, cross: false },
              batterSide,
            });
            const plan = chooseCpuPitchPlan(count, 'balanced', control, 0, {
              sides: { side, cross: true },
              batterSide,
            });
            const inZone = honest.targetX !== 0 && Math.abs(honest.targetX) <= STRIKE_ZONE_HALF_WIDTH;
            const standsOutside = batterFrameX(side, batterSide) < 0;
            expect(plan.cross ?? false).toBe(inZone && standsOutside);
            if (plan.cross) {
              crossed += 1;
              // 立つ側（引いた側）の反対＝打者の内角のストライクへ
              expect(plan.targetX).toBeCloseTo(-honest.targetX, 12);
              expect(batterFrameX(plan.targetX, batterSide)).toBeGreaterThan(0);
              expect(judgePitch(plan.targetX, batterSide)).toBe('strike');
            } else {
              // それ以外は立ち位置どおり
              expect(plan.targetX).toBe(honest.targetX);
              if (!inZone && honest.targetX !== 0) honestOffPlate += 1;
              if (inZone && !standsOutside) honestInside += 1;
            }
          }
        }
      }
    }
    // どの球も実際に存在する（規則が片方へ潰れていない）
    expect(crossed).toBeGreaterThan(0);
    expect(honestOffPlate).toBeGreaterThan(0);
    expect(honestInside).toBeGreaterThan(0);
  });

  it('内角側に立った球は、くじに関係なく必ず内角へ来る（立ち位置が外れるのは外角側だけ）', () => {
    for (const batterSide of [RIGHT_BATTER_SIDE, LEFT_BATTER_SIDE]) {
      // 打者ローカルの +X＝内角＝ワールドでは打席の符号の側
      const inside = batterSide as 1 | -1;
      for (const count of COUNTS) {
        for (const control of CONTROLS) {
          const plan = chooseCpuPitchPlan(count, 'balanced', control, 0, {
            sides: { side: inside, cross: true },
            batterSide,
          });
          expect(plan.cross).toBeUndefined();
          if (plan.targetX !== 0) expect(batterFrameX(plan.targetX, batterSide)).toBeGreaterThan(0);
        }
      }
    }
  });

  it('逆を引かなければ、どの球にも印は付かない', () => {
    for (const count of COUNTS) {
      for (const control of CONTROLS) {
        const plan = chooseCpuPitchPlan(count, 'balanced', control, 0, { sides: { side: 1, cross: false } });
        expect(plan.cross).toBeUndefined();
      }
    }
  });

  it('真ん中狙い（3ボール）は側も逆も持たない＝誰が投げても真ん中のまま（T-41）', () => {
    for (const strikes of [0, 1]) {
      for (const side of [1, -1] as const) {
        const plan = chooseCpuPitchPlan({ balls: 3, strikes }, 'balanced', 0.5, 0, {
          sides: { side, cross: true },
        });
        expect(plan.targetX).toBe(0);
        expect(plan.cross).toBeUndefined();
      }
    }
  });

  it('制球の悪い投手は逆を突けない（狙いがゾーンの外へ膨らむ＝T-41）', () => {
    for (const count of COUNTS) {
      const plan = chooseCpuPitchPlan(count, 'balanced', 0, 0, { sides: { side: 1, cross: true } });
      expect(plan.cross).toBeUndefined();
    }
    // 中央値の投手は、ストライクを取りに行く球（初球など）で逆を突ける
    expect(chooseCpuPitchPlan({ balls: 0, strikes: 0 }, 'balanced', 0.5, 0, { sides: { side: 1, cross: true } }).cross).toBe(true);
    // 制球の良い投手は、決め球（縁の内側）でも逆を突ける
    expect(chooseCpuPitchPlan({ balls: 0, strikes: 2 }, 'balanced', 1, 0, { sides: { side: 1, cross: true } }).cross).toBe(true);
    expect(chooseCpuPitchPlan({ balls: 0, strikes: 2 }, 'balanced', 0.5, 0, { sides: { side: 1, cross: true } }).cross).toBeUndefined();
  });

  it('側を渡さなければ BBB-83 までと完全に同じ（偶奇の規則。T-41・SS-67 の計測の基準線）', () => {
    for (const count of COUNTS) {
      for (const fouls of [0, 1, 2, 3]) {
        const plan = chooseCpuPitchPlan(count, 'balanced', 0.5, fouls);
        expect(plan.cross).toBeUndefined();
        if (plan.targetX !== 0) {
          expect(Math.sign(plan.targetX)).toBe((count.balls + fouls) % 2 === 0 ? 1 : -1);
        }
      }
    }
  });

  it('内角側に立って外角へ逆を突く形（最初に入れて、計測が退けた）は、計測用の引数でだけ出る', () => {
    const count = { balls: 0, strikes: 0 };
    // 右打者（-X に立つ）の内角側＝-X に立つ
    const sides = { side: -1 as const, cross: true };
    const plain = chooseCpuPitchPlan(count, 'balanced', 0.5, 0, { sides, batterSide: RIGHT_BATTER_SIDE });
    expect(plain.cross).toBeUndefined();
    expect(plain.targetX).toBeLessThan(0);
    const both = chooseCpuPitchPlan(count, 'balanced', 0.5, 0, {
      sides,
      batterSide: RIGHT_BATTER_SIDE,
      crossBothWays: true,
    });
    expect(both.cross).toBe(true);
    expect(both.targetX).toBeCloseTo(-plain.targetX, 12);
    // 外す球は、この引数でも立ち位置どおり
    const waste = chooseCpuPitchPlan({ balls: 0, strikes: 2 }, 'balanced', 0.5, 0, {
      sides,
      batterSide: RIGHT_BATTER_SIDE,
      crossBothWays: true,
    });
    expect(waste.cross).toBeUndefined();
  });
});

describe('逆を突く球の形（planCpuPitchShape）', () => {
  const TARGETS = [0.4, 0.43, 0.45];
  const SPEEDS = ['fast', 'neutral', 'slow'] as const;

  /** 側・球種・投手・腕の総当たり */
  function eachCross(visit: (plan: CpuPitchPlan, profile: PitchProfile, offset: number) => void): void {
    for (const target of TARGETS) {
      for (const sign of [1, -1]) {
        for (const speed of SPEEDS) {
          for (const profile of PROFILES) {
            for (const arm of ARMS) {
              visit({ targetX: sign * target, speed, cross: true }, profile, armReleaseOffsetX(arm));
            }
          }
        }
      }
    }
  }

  it('立つ場所は、反対の隅へ立ち位置どおりに投げるときとまったく同じ（投げる前には見分けが付かない）', () => {
    eachCross((plan, profile, offset) => {
      const cross = planCpuPitchShape(plan, profile, undefined, offset);
      const mirror = planCpuPitchShape({ targetX: -plan.targetX, speed: plan.speed }, profile, undefined, offset);
      expect(cross.plateX).toBe(mirror.plateX);
      expect(cross.releaseX).toBe(mirror.releaseX);
      expect(cross.speed).toBe(mirror.speed);
    });
  });

  it('体は必ずプレートの上に立つ', () => {
    eachCross((plan, profile, offset) => {
      const cross = planCpuPitchShape(plan, profile, undefined, offset);
      expect(Math.abs(cross.plateX)).toBeLessThanOrEqual(RUBBER_HALF_RANGE + 1e-9);
      expect(cross.releaseX - cross.plateX).toBeCloseTo(offset, 10);
    });
  });

  it('狙いどおりの隅へ届く（どの刻みでも同じ場所を通る）', () => {
    eachCross((plan, profile, offset) => {
      const cross = planCpuPitchShape(plan, profile, undefined, offset);
      for (const dt of [1 / 60, 1 / 144, 1 / 240]) {
        expect(Math.abs(crossX(cross, dt) - plan.targetX)).toBeLessThan(1e-3);
      }
    });
  });

  it('リリースの瞬間から、狙う隅の向きへ斜めに出る（立ち位置どおりの球は横速度0）', () => {
    eachCross((plan, profile, offset) => {
      const cross = planCpuPitchShape(plan, profile, undefined, offset);
      expect(Math.sign(cross.releaseVx)).toBe(Math.sign(plan.targetX));
      expect(cross.steerX).toBe(Math.sign(plan.targetX));
      const honest = planCpuPitchShape({ targetX: plan.targetX, speed: plan.speed }, profile, undefined, offset);
      expect(honest.releaseVx).toBe(0);
    });
  });

  it('曲がりは立ち位置どおりの球と同じ（3割のまま＝BBB-77。足りないぶんは斜めの球筋が運ぶ）', () => {
    eachCross((plan, profile, offset) => {
      const cross = planCpuPitchShape(plan, profile, undefined, offset);
      // 倒し続ける長さは「短く1回倒す」まま（曲げ続けて届かせることはしない）
      expect(cross.steerSec).toBeCloseTo(Math.min(CPU_BREAK_STEER_SEC, cross.flightSec), 12);
      // 自然な曲がり幅＝プレートで削られていないときの、同じ側へ立ち位置どおりに投げる球の曲がり
      const natural = cross.steerAccel * cross.steerSec * (cross.flightSec - cross.steerSec / 2);
      expect(cross.breakWidth).toBeCloseTo(natural, 12);
      // 横移動の合計＝斜めのぶん＋曲がり＝狙いまでの距離
      expect(cross.releaseX + cross.releaseVx * cross.flightSec + cross.steerX * cross.breakWidth).toBeCloseTo(plan.targetX, 9);
    });
  });

  it('立ち位置どおりの球の形は、印を持たない方針（BBB-83 まで）と1つも変わらない', () => {
    for (const target of [0.5, 0.4, 0.2475, 0, -0.4, -0.5]) {
      for (const speed of SPEEDS) {
        for (const profile of PROFILES) {
          for (const arm of ARMS) {
            const offset = armReleaseOffsetX(arm);
            const plain = planCpuPitchShape({ targetX: target, speed }, profile, undefined, offset);
            const marked = planCpuPitchShape({ targetX: target, speed, cross: false }, profile, undefined, offset);
            expect(marked).toEqual(plain);
            expect(plain.releaseVx).toBe(0);
          }
        }
      }
    }
  });

  it('真ん中狙いに印が付いていても、まっすぐの球のまま', () => {
    const shape = planCpuPitchShape({ targetX: 0, speed: 'neutral', cross: true });
    expect(shape.releaseVx).toBe(0);
    expect(shape.steerX).toBe(0);
    expect(crossX(shape)).toBeCloseTo(0, 9);
  });

  it('読みの札の線（心眼・未来視）は、逆を突く球でも実際に通る場所を示す', () => {
    eachCross((plan, profile, offset) => {
      const cross = planCpuPitchShape(plan, profile, undefined, offset);
      const path = predictCpuPitchPath(cross, 1.5);
      expect(Math.abs(plateCrossing(path).x - plan.targetX)).toBeLessThan(0.02);
    });
  });
});

describe('逆を突かれて死球になることは無い（外れたら損、だけが残る）', () => {
  it('逆を突く球は、どの打席・どの立ち位置の打者にも当たらない', () => {
    let crosses = 0;
    for (const count of COUNTS) {
      for (const style of STYLES) {
        for (const control of CONTROLS) {
          for (const side of [1, -1] as const) {
            for (const batterSide of [RIGHT_BATTER_SIDE, LEFT_BATTER_SIDE]) {
              const plan = chooseCpuPitchPlan(count, style, control, 0, {
                sides: { side, cross: true },
                batterSide,
              });
              if (!plan.cross) continue;
              crosses += 1;
              for (const batter of [RIGHT_BATTER_SIDE, LEFT_BATTER_SIDE]) {
                for (const stance of [-BATTER_STANCE_RANGE, 0, BATTER_STANCE_RANGE]) {
                  expect(judgePitch(plan.targetX, batter, stance)).toBe('strike');
                }
              }
            }
          }
        }
      }
    }
    expect(crosses).toBeGreaterThan(50);
  });
});

describe('踏み込んでいる打者の体へは投げない（avoidCrowdingBatter）', () => {
  const IN = -BATTER_STANCE_RANGE;
  /** その打者の内角へ、ゾーンの外まで外した球（打者ローカルの距離） */
  const insideBall = (batterSide: 1 | -1, local: number): CpuPitchPlan => ({
    targetX: local * batterSide,
    speed: 'neutral',
  });

  it('寄ったから当たる球は、同じ距離の反対側へ投げ直す（立つ場所は変わらない＝逆を突く球と同じ形）', () => {
    for (const batterSide of [RIGHT_BATTER_SIDE, LEFT_BATTER_SIDE]) {
      for (const local of [0.5, 0.55, 0.6, BATTER_ZONE_MIN_X - 0.01]) {
        const plan = insideBall(batterSide, local);
        // 打席の中央なら当たらないが、寄り切れば当たる球
        expect(judgePitch(plan.targetX, batterSide, 0)).toBe('ball');
        expect(judgePitch(plan.targetX, batterSide, IN)).toBe('hitByPitch');
        const answer = avoidCrowdingBatter(plan, batterSide, IN);
        expect(answer.targetX).toBeCloseTo(-plan.targetX, 12);
        expect(answer.speed).toBe(plan.speed);
        expect(answer.cross).toBe(true);
        // 投げ直した球は、打者がどこに立っていても当たらない（外角のボール球）
        for (const stance of [IN, 0, BATTER_STANCE_RANGE]) {
          expect(judgePitch(answer.targetX, batterSide, stance)).toBe('ball');
        }
        // 投手は動かない（リリースの横速度で反対の隅へ届く）
        for (const profile of PROFILES) {
          for (const arm of ARMS) {
            const offset = armReleaseOffsetX(arm);
            const before = planCpuPitchShape(plan, profile, undefined, offset);
            const after = planCpuPitchShape(answer, profile, undefined, offset);
            expect(after.plateX).toBe(before.plateX);
            expect(Math.abs(crossX(after) - answer.targetX)).toBeLessThan(1e-3);
          }
        }
      }
    }
  });

  it('当たらない球は変えない（打席の中央・離れている打者・ストライク・外角のボール球）', () => {
    for (const batterSide of [RIGHT_BATTER_SIDE, LEFT_BATTER_SIDE]) {
      const plans: CpuPitchPlan[] = [
        insideBall(batterSide, 0.5),
        insideBall(batterSide, 0.4),
        insideBall(batterSide, -0.4),
        insideBall(batterSide, -0.55),
        { targetX: 0, speed: 'neutral' },
      ];
      for (const plan of plans) {
        for (const stance of [0, BATTER_STANCE_RANGE]) {
          expect(avoidCrowdingBatter(plan, batterSide, stance)).toBe(plan);
        }
      }
      // 寄っていても、ストライクと外角の球はそのまま
      for (const plan of plans.slice(1)) expect(avoidCrowdingBatter(plan, batterSide, IN)).toBe(plan);
    }
  });

  it('少しだけ寄った打者には、その位置で当たる球だけを避ける', () => {
    const half = IN / 2;
    const plan = insideBall(RIGHT_BATTER_SIDE, 0.5);
    // 半分寄った打者の体の縁は 0.57＝0.50 の球は当たらない
    expect(judgePitch(plan.targetX, RIGHT_BATTER_SIDE, half)).toBe('ball');
    expect(avoidCrowdingBatter(plan, RIGHT_BATTER_SIDE, half)).toBe(plan);
    const wider = insideBall(RIGHT_BATTER_SIDE, 0.6);
    expect(judgePitch(wider.targetX, RIGHT_BATTER_SIDE, half)).toBe('hitByPitch');
    expect(avoidCrowdingBatter(wider, RIGHT_BATTER_SIDE, half).cross).toBe(true);
  });

  it('打席の中央に立っていても当たる球（荒れ球）はそのまま＝避ける手は「離れて立つ」（T-41）', () => {
    for (const batterSide of [RIGHT_BATTER_SIDE, LEFT_BATTER_SIDE]) {
      const plan = insideBall(batterSide, BATTER_ZONE_MIN_X + 0.02);
      expect(judgePitch(plan.targetX, batterSide, 0)).toBe('hitByPitch');
      expect(avoidCrowdingBatter(plan, batterSide, IN)).toBe(plan);
      expect(avoidCrowdingBatter(plan, batterSide, 0)).toBe(plan);
      // 離れて立てば当たらない
      expect(judgePitch(plan.targetX, batterSide, BATTER_STANCE_RANGE)).toBe('ball');
    }
  });

  it('名鑑の幅の制球で、寄り切った打者に当たる球が残るのは「中央でも当たる球」だけ', () => {
    let avoided = 0;
    let wild = 0;
    for (const count of COUNTS) {
      for (const style of STYLES) {
        for (const control of CONTROLS) {
          for (const side of [1, -1] as const) {
            for (const cross of [false, true]) {
              for (const batterSide of [RIGHT_BATTER_SIDE, LEFT_BATTER_SIDE]) {
                const plan = chooseCpuPitchPlan(count, style, control, 0, { sides: { side, cross }, batterSide });
                const answer = avoidCrowdingBatter(plan, batterSide, IN);
                if (answer !== plan) avoided += 1;
                if (judgePitch(answer.targetX, batterSide, IN) === 'hitByPitch') {
                  wild += 1;
                  expect(judgePitch(answer.targetX, batterSide, 0)).toBe('hitByPitch');
                }
              }
            }
          }
        }
      }
    }
    // 避ける球も、荒れ球も、どちらも実際に存在する
    expect(avoided).toBeGreaterThan(0);
    expect(wild).toBeGreaterThan(0);
  });
});

describe('投げた後に踏み込んで当たった球は死球にしない（judgePitch の releaseStance）', () => {
  const IN = -BATTER_STANCE_RANGE;

  it('渡さなければ従来どおり（届いたときの立ち位置だけで決まる）', () => {
    for (const batterSide of [RIGHT_BATTER_SIDE, LEFT_BATTER_SIDE]) {
      for (const local of [-0.6, -0.4, 0, 0.4, 0.5, 0.6, 0.7, 1.0]) {
        for (const stance of [IN, 0, BATTER_STANCE_RANGE]) {
          const x = local * batterSide;
          expect(judgePitch(x, batterSide, stance, false, stance)).toBe(judgePitch(x, batterSide, stance));
        }
      }
    }
  });

  it('リリースのときは当たらない場所にいて、投げた後に踏み込んで当たった球はボール', () => {
    for (const batterSide of [RIGHT_BATTER_SIDE, LEFT_BATTER_SIDE]) {
      const x = 0.5 * batterSide;
      expect(judgePitch(x, batterSide, IN)).toBe('hitByPitch');
      expect(judgePitch(x, batterSide, IN, false, 0)).toBe('ball');
      expect(judgePitch(x, batterSide, IN, false, BATTER_STANCE_RANGE)).toBe('ball');
    }
  });

  it('リリースのときから寄っていた打者に当たれば死球（投手が当てた球）', () => {
    for (const batterSide of [RIGHT_BATTER_SIDE, LEFT_BATTER_SIDE]) {
      const x = 0.5 * batterSide;
      expect(judgePitch(x, batterSide, IN, false, IN)).toBe('hitByPitch');
      // 中央でも当たる球は、踏み込んでいても死球
      const wild = (BATTER_ZONE_MIN_X + 0.02) * batterSide;
      expect(judgePitch(wild, batterSide, IN, false, 0)).toBe('hitByPitch');
    }
  });

  it('離れて避けた球はボール・ストライクはどこに立っていてもストライク', () => {
    const wild = (BATTER_ZONE_MIN_X + 0.02) * RIGHT_BATTER_SIDE;
    expect(judgePitch(wild, RIGHT_BATTER_SIDE, BATTER_STANCE_RANGE, false, 0)).toBe('ball');
    for (const stance of [IN, 0, BATTER_STANCE_RANGE]) {
      for (const at of [IN, 0, BATTER_STANCE_RANGE]) {
        expect(judgePitch(0.4 * RIGHT_BATTER_SIDE, RIGHT_BATTER_SIDE, stance, false, at)).toBe('strike');
      }
    }
  });
});
