import { describe, expect, it } from 'vitest';
import {
  type PitchFlight,
  ARM_RELEASE_LEAN_RAD,
  ARM_RELEASE_REACH,
  ARM_SLOT_RAD,
  BATTER_STANCE_RANGE,
  BATTER_STAND_X,
  BATTER_ZONE_MAX_X,
  BATTER_ZONE_MIN_X,
  COURSE_RELEASE_VX,
  FATIGUE_BREAK_LOSS,
  FATIGUE_SPEED_DROP,
  LEFT_ARM_SIDE,
  LEFT_BATTER_SIDE,
  RIGHT_ARM_SIDE,
  RIGHT_BATTER_SIDE,
  NEUTRAL_RATING,
  RELEASE_HEIGHT,
  RELEASE_Z,
  RUBBER_HALF_RANGE,
  SPD_SPAN,
  STEER_ACCEL_MIN,
  SPEED_FAST,
  SPEED_NEUTRAL,
  SPEED_SLOW,
  STRIKE_ZONE_HALF_WIDTH,
  armReleaseHandOffsetX,
  armReleaseHeight,
  armReleaseOffsetX,
  clampReleaseX,
  clampRubberX,
  createPitchFlight,
  releaseXFor,
  fatiguedBreak,
  fatiguedSpeed,
  judgePitch,
  plateCrossingX,
  speedForPitchSelection,
  steerAccelFor,
  stepPitchFlight,
  batterStandX,
} from '../src/core/pitch';
import { BASE_POSITIONS } from '../src/core/fielding';

const DT = 1 / 60;

/** プレート通過まで飛行を進め、通過時のXと所要時間を返す */
function flyToPlate(
  initial: PitchFlight,
  steerAt: (time: number) => -1 | 0 | 1,
): { crossX: number; time: number } {
  let flight = initial;
  let time = 0;
  for (let i = 0; i < 1000; i++) {
    const next = stepPitchFlight(flight, steerAt(time), DT);
    time += DT;
    const crossX = plateCrossingX(flight, next);
    if (crossX !== null) return { crossX, time };
    flight = next;
  }
  throw new Error('プレートに到達しなかった');
}

describe('clampRubberX', () => {
  it('範囲内はそのまま', () => {
    expect(clampRubberX(0.5)).toBe(0.5);
  });

  it('範囲外は±RUBBER_HALF_RANGEに収める', () => {
    expect(clampRubberX(5)).toBe(RUBBER_HALF_RANGE);
    expect(clampRubberX(-5)).toBe(-RUBBER_HALF_RANGE);
  });
});

describe('createPitchFlight', () => {
  it('リリース位置Xと基準球速で初期化される（省略時）', () => {
    expect(createPitchFlight(0.3)).toEqual({
      x: 0.3,
      z: RELEASE_Z,
      vx: 0,
      vz: SPEED_NEUTRAL,
    });
  });

  it('事前選択した球速とリリース瞬間のコース入力（初期横速度）を反映する', () => {
    expect(createPitchFlight(0, SPEED_FAST, COURSE_RELEASE_VX)).toEqual({
      x: 0,
      z: RELEASE_Z,
      vx: COURSE_RELEASE_VX,
      vz: SPEED_FAST,
    });
  });
});

describe('speedForPitchSelection（ワインドアップ中の緩急事前選択・説明書p19②）', () => {
  it('上（+1）はフォーク/チェンジアップ＝遅い球', () => {
    expect(speedForPitchSelection(1)).toBe(SPEED_SLOW);
  });

  it('下（-1）は速球', () => {
    expect(speedForPitchSelection(-1)).toBe(SPEED_FAST);
  });

  it('無入力は基準速', () => {
    expect(speedForPitchSelection(0)).toBe(SPEED_NEUTRAL);
  });
});

describe('stepPitchFlight', () => {
  it('入力オブジェクトを変更しない（純粋関数）', () => {
    const flight = createPitchFlight(0);
    const before = { ...flight };
    stepPitchFlight(flight, 1, DT);
    expect(flight).toEqual(before);
  });

  it('球速はリリース時に確定し、飛行中は変わらない（原作準拠）', () => {
    for (const speed of [SPEED_SLOW, SPEED_NEUTRAL, SPEED_FAST]) {
      let flight = createPitchFlight(0, speed);
      for (let i = 0; i < 30; i++) flight = stepPitchFlight(flight, 1, DT);
      expect(flight.vz).toBe(speed);
    }
  });

  it('左右入力をやめても横速度（曲がり）は残る', () => {
    let flight = createPitchFlight(0);
    for (let i = 0; i < 10; i++) flight = stepPitchFlight(flight, 1, DT);
    const vxAfterSteer = flight.vx;
    expect(vxAfterSteer).toBeGreaterThan(0);
    flight = stepPitchFlight(flight, 0, DT);
    expect(flight.vx).toBe(vxAfterSteer);
  });
});

describe('plateCrossingX', () => {
  const at = (x: number, z: number): PitchFlight => ({ x, z, vx: 0, vz: SPEED_NEUTRAL });

  it('本塁手前どうしのステップでは null', () => {
    expect(plateCrossingX(at(0, -5), at(0, -4))).toBeNull();
  });

  it('通過済みのステップでは null（二重判定しない）', () => {
    expect(plateCrossingX(at(0, 0.5), at(0, 1.5))).toBeNull();
  });

  it('通過時のXを線形補間で求める', () => {
    expect(plateCrossingX(at(0, -1), at(1, 1))).toBeCloseTo(0.5);
  });
});

describe('judgePitch（ストライクゾーン・死球判定）', () => {
  it('ゾーン内（境界含む）はストライク', () => {
    expect(judgePitch(0)).toBe('strike');
    expect(judgePitch(STRIKE_ZONE_HALF_WIDTH)).toBe('strike');
    expect(judgePitch(-STRIKE_ZONE_HALF_WIDTH)).toBe('strike');
  });

  it('ゾーン外・打者に当たらない球はボール', () => {
    expect(judgePitch(STRIKE_ZONE_HALF_WIDTH + 0.01)).toBe('ball');
    expect(judgePitch(1.5)).toBe('ball'); // 一塁側は打者不在（既定の右打者は三塁側。BB-49）
    expect(judgePitch(-(BATTER_ZONE_MAX_X + 0.1))).toBe('ball'); // 打者の背後を抜けた暴投
  });

  it('打者の立ち位置（境界含む）は死球', () => {
    expect(judgePitch(-BATTER_ZONE_MIN_X)).toBe('hitByPitch');
    expect(judgePitch(-1.3)).toBe('hitByPitch');
    expect(judgePitch(-BATTER_ZONE_MAX_X)).toBe('hitByPitch');
  });
});

describe('judgePitch（打席の左右。フェーズB-9）', () => {
  it('死球ゾーンが打者と一緒に反対側へ移る', () => {
    // 左打者は一塁側（+X）に立つ＝右打者（三塁側）の鏡像。フェーズBB-49
    expect(judgePitch(-BATTER_STAND_X, LEFT_BATTER_SIDE)).toBe('ball');
    expect(judgePitch(BATTER_STAND_X, LEFT_BATTER_SIDE)).toBe('hitByPitch');
    expect(judgePitch(BATTER_ZONE_MIN_X, LEFT_BATTER_SIDE)).toBe('hitByPitch');
    expect(judgePitch(BATTER_ZONE_MAX_X, LEFT_BATTER_SIDE)).toBe('hitByPitch');
    expect(judgePitch(BATTER_ZONE_MAX_X + 0.1, LEFT_BATTER_SIDE)).toBe('ball');
  });

  it('ストライクゾーンは打席の左右で変わらない（本塁基準・左右対称）', () => {
    for (const x of [-STRIKE_ZONE_HALF_WIDTH, 0, STRIKE_ZONE_HALF_WIDTH]) {
      expect(judgePitch(x, LEFT_BATTER_SIDE)).toBe('strike');
      expect(judgePitch(x, RIGHT_BATTER_SIDE)).toBe('strike');
    }
  });

  it('右打者と左打者の判定はXについて厳密な鏡像になる', () => {
    for (let x = -2.5; x <= 2.5; x += 0.05) {
      expect(judgePitch(-x, LEFT_BATTER_SIDE)).toBe(judgePitch(x, RIGHT_BATTER_SIDE));
    }
  });

  it('打者の立ち位置（見た目）は死球ゾーンの内側にある', () => {
    // シーン層はこの関数で打者を立たせる。ここがずれると「見た目は当たっているのに
    // 死球にならない」（またはその逆）が起きるので、同じ定数から導いていることを固定する。
    expect(BATTER_STAND_X).toBeGreaterThan(BATTER_ZONE_MIN_X);
    expect(BATTER_STAND_X).toBeLessThan(BATTER_ZONE_MAX_X);
    for (const side of [RIGHT_BATTER_SIDE, LEFT_BATTER_SIDE] as const) {
      expect(judgePitch(batterStandX(side), side)).toBe('hitByPitch');
    }
  });

  it('右打者は三塁側の打席に立つ（実際の野球どおり。フェーズBB-49）', () => {
    // 一塁は +X（fielding.ts の BASE_POSITIONS）なので、右打者は本塁を挟んだ反対＝
    // 三塁側（-X）に立つ。**この1行が BB-49 で直した誤りそのもの**で、
    // B-9〜AA-48 は右打者が一塁側に立っていた。
    expect(BASE_POSITIONS.first.x).toBeGreaterThan(0);
    expect(batterStandX(RIGHT_BATTER_SIDE)).toBeLessThan(0);
    expect(batterStandX(LEFT_BATTER_SIDE)).toBeGreaterThan(0);
    // 死球ゾーンも一緒に動く（見た目と判定は同じ定数から起きる＝B-9の不変条件）＝
    // **打者のいない側は必ずボール**
    expect(judgePitch(BATTER_STAND_X, RIGHT_BATTER_SIDE)).toBe('ball');
    expect(judgePitch(-BATTER_STAND_X, RIGHT_BATTER_SIDE)).toBe('hitByPitch');
    expect(judgePitch(-BATTER_STAND_X, LEFT_BATTER_SIDE)).toBe('ball');
    expect(judgePitch(BATTER_STAND_X, LEFT_BATTER_SIDE)).toBe('hitByPitch');
  });
});

describe('投球の統合挙動（リリース→プレート通過）', () => {
  it('ど真ん中からの直球はそのままストライク', () => {
    const { crossX } = flyToPlate(createPitchFlight(0), () => 0);
    expect(Math.abs(crossX)).toBeLessThan(0.01);
    expect(judgePitch(crossX)).toBe('strike');
  });

  it('プレート端からの直球は平行に進みボールになる', () => {
    const { crossX } = flyToPlate(createPitchFlight(RUBBER_HALF_RANGE), () => 0);
    expect(crossX).toBeCloseTo(RUBBER_HALF_RANGE, 2);
    expect(judgePitch(crossX)).toBe('ball');
  });

  it('横入力を保持するとゾーン外まで曲がる', () => {
    const { crossX } = flyToPlate(createPitchFlight(0), () => 1);
    expect(crossX).toBeGreaterThan(STRIKE_ZONE_HALF_WIDTH);
  });

  it('途中まで曲げて離すと曲がり幅を調整できる（スキル操作）', () => {
    const fullHold = flyToPlate(createPitchFlight(0), () => 1);
    const halfHold = flyToPlate(createPitchFlight(0), (t) => (t < 0.2 ? 1 : 0));
    expect(halfHold.crossX).toBeGreaterThan(0);
    expect(halfHold.crossX).toBeLessThan(fullHold.crossX);
  });

  it('操作次第で打者に当てられる（死球ゾーンに到達できる）', () => {
    // 曲げ続けると打者の背後に抜けるので、途中で戻すスキル操作を模す。
    // 既定の右打者は三塁側（-X）に立つので、曲げるのも -X 側（BB-49）。
    // **フェーズRR-66で 0.2→0.12秒**：バットが届く範囲に合わせて打者が本塁へ寄った
    // （死球ゾーンが 0.9〜1.7 → 0.65〜1.45 へ動いた）ので、0.2秒も曲げると
    // **打者の背後へ抜ける**（-1.54）。
    const { crossX } = flyToPlate(createPitchFlight(-0.4), (t) => (t < 0.12 ? -1 : 0));
    expect(judgePitch(crossX)).toBe('hitByPitch');
  });

  it('緩急で到達時間が変わる（フォーク/チェンジ > 直球 > 速球）', () => {
    const slow = flyToPlate(createPitchFlight(0, SPEED_SLOW), () => 0);
    const neutral = flyToPlate(createPitchFlight(0, SPEED_NEUTRAL), () => 0);
    const fast = flyToPlate(createPitchFlight(0, SPEED_FAST), () => 0);
    expect(slow.time).toBeGreaterThan(neutral.time);
    expect(neutral.time).toBeGreaterThan(fast.time);
  });

  it('フォーク/チェンジアップは滞空が長いぶん大きく曲がる', () => {
    const slowCurve = flyToPlate(createPitchFlight(0, SPEED_SLOW), () => 1);
    const fastCurve = flyToPlate(createPitchFlight(0, SPEED_FAST), () => 1);
    expect(slowCurve.crossX).toBeGreaterThan(fastCurve.crossX);
  });

  it('リリース瞬間のコース入力だけで、ど真ん中からゾーンぎりぎりの隅を突ける（説明書p19③）', () => {
    const { crossX } = flyToPlate(
      createPitchFlight(0, SPEED_NEUTRAL, COURSE_RELEASE_VX),
      () => 0,
    );
    // ズレ幅はゾーン半幅とほぼ同じ（僅かに内側）になるよう COURSE_RELEASE_VX を調整してある
    expect(crossX).toBeGreaterThan(STRIKE_ZONE_HALF_WIDTH * 0.85);
    expect(judgePitch(crossX)).toBe('strike');
  });

  it('コース入力と変化球を重ねればゾーン外まで外せる', () => {
    const { crossX } = flyToPlate(
      createPitchFlight(0, SPEED_NEUTRAL, COURSE_RELEASE_VX),
      () => 1,
    );
    expect(judgePitch(crossX)).toBe('ball');
  });
});

describe('投手の能力値（球速・変化量：フェーズB-8）', () => {
  it('能力値を渡さないと従来の3段階の球速そのままになる', () => {
    expect(speedForPitchSelection(0)).toBe(SPEED_NEUTRAL);
    expect(speedForPitchSelection(-1)).toBe(SPEED_FAST);
    expect(speedForPitchSelection(1)).toBe(SPEED_SLOW);
    expect(speedForPitchSelection(0, NEUTRAL_RATING)).toBe(SPEED_NEUTRAL);
  });

  it('球速が高い投手はどの段階でも速い', () => {
    for (const y of [-1, 0, 1] as const) {
      expect(speedForPitchSelection(y, 1)).toBeGreaterThan(speedForPitchSelection(y, 0.5));
      expect(speedForPitchSelection(y, 0.5)).toBeGreaterThan(speedForPitchSelection(y, 0));
    }
  });

  it('緩急の幅は投手によらず一定（上下入力の意味が誰でも同じ）', () => {
    for (const spd of [0, 0.5, 1]) {
      expect(speedForPitchSelection(-1, spd) - speedForPitchSelection(0, spd)).toBeCloseTo(
        SPEED_FAST - SPEED_NEUTRAL,
        10,
      );
      expect(speedForPitchSelection(0, spd) - speedForPitchSelection(1, spd)).toBeCloseTo(
        SPEED_NEUTRAL - SPEED_SLOW,
        10,
      );
    }
  });

  it('軟投派の速球は速球派の基準速にも届かない（球速差が体感できる幅になっている）', () => {
    expect(speedForPitchSelection(-1, 0)).toBeLessThan(speedForPitchSelection(0, 1));
  });

  it('球速の能力値は 0..1 の外を渡されても頭打ちになる', () => {
    expect(speedForPitchSelection(0, 5)).toBe(speedForPitchSelection(0, 1));
    expect(speedForPitchSelection(0, -5)).toBe(speedForPitchSelection(0, 0));
  });

  it('変化量0.5が従来の曲がり幅で、大きいほど強く曲がる', () => {
    /** 右へ曲げ続けたときの本塁通過X（大きいほどよく曲がっている） */
    const bendAt = (steerAccel?: number) => {
      let flight = createPitchFlight(0, SPEED_NEUTRAL);
      for (let i = 0; i < 1000; i++) {
        const next = stepPitchFlight(flight, 1, DT, steerAccel);
        const crossX = plateCrossingX(flight, next);
        if (crossX !== null) return crossX;
        flight = next;
      }
      throw new Error('本塁を通過しなかった');
    };
    // 既定（能力値なし）と変化量0.5が一致する＝基準線が動いていない
    expect(bendAt(steerAccelFor(NEUTRAL_RATING))).toBeCloseTo(bendAt(), 10);
    expect(bendAt(steerAccelFor(1))).toBeGreaterThan(bendAt(steerAccelFor(0.5)));
    expect(bendAt(steerAccelFor(0.5))).toBeGreaterThan(bendAt(steerAccelFor(0)));
  });

  it('変化量は 0..1 の外を渡されても頭打ちになる', () => {
    expect(steerAccelFor(5)).toBe(steerAccelFor(1));
    expect(steerAccelFor(-5)).toBe(steerAccelFor(0));
  });
});

describe('スタミナ消耗による球威の低下（フェーズB-11）', () => {
  it('疲労0なら能力値をそのまま返す（B-8の基準線が動かない）', () => {
    for (const rating of [0, 0.35, 0.5, 0.72, 0.95, 1]) {
      expect(fatiguedSpeed(rating, 0)).toBe(rating);
      expect(fatiguedBreak(rating, 0)).toBe(rating);
    }
  });

  it('疲労が進むほど球速レーティングが下がる（0未満にはならない）', () => {
    expect(fatiguedSpeed(0.72, 1)).toBeCloseTo(0.72 - FATIGUE_SPEED_DROP, 6);
    expect(fatiguedSpeed(0.72, 0.5)).toBeCloseTo(0.72 - FATIGUE_SPEED_DROP / 2, 6);
    expect(fatiguedSpeed(0.1, 1)).toBe(0);
  });

  /**
   * 「球威が落ちる」が体感できる幅であることの固定。速球派（0.95）の疲れた基準速が
   * 無傷の技巧派（0.35）を下回らない程度には残しつつ、明確に遅くなる。
   */
  it('疲労MAXで基準速が実測4m/s以上落ちる', () => {
    const fresh = speedForPitchSelection(0, 0.72);
    const tired = speedForPitchSelection(0, fatiguedSpeed(0.72, 1));
    expect(fresh - tired).toBeCloseTo(FATIGUE_SPEED_DROP * SPD_SPAN, 6);
    expect(fresh - tired).toBeGreaterThanOrEqual(4);
  });

  it('疲労MAXで変化量が下限まで落ちる（誰が投げても最低限の変化だけ残る）', () => {
    expect(fatiguedBreak(0.9, 1)).toBeCloseTo(0.9 * (1 - FATIGUE_BREAK_LOSS), 6);
    expect(steerAccelFor(fatiguedBreak(0.9, 1))).toBe(STEER_ACCEL_MIN);
    expect(steerAccelFor(fatiguedBreak(0.3, 1))).toBe(STEER_ACCEL_MIN);
  });

  /**
   * 変化量の低下が**実際の軌道に出る**ことの固定。疲労で球速も落ちる＝本塁までの
   * 時間が延び、横の移動量は時間の2乗で効くので、加速度の低下がこれを上回っていないと
   * 「曲げても曲がらない」が体感できない（実機で総移動量がむしろ増えるのを観測して
   * FATIGUE_BREAK_LOSS を 0.5 から 1 に上げた経緯がある）。
   */
  it('飛行時間が延びるぶんを差し引いても、疲れると横の移動量が減る', () => {
    const distance = (rating: number, fatigue: number) => {
      const accel = steerAccelFor(fatiguedBreak(rating, fatigue));
      const speed = speedForPitchSelection(0, fatiguedSpeed(0.72, fatigue));
      const time = (0 - RELEASE_Z) / speed; // リリース点から本塁まで
      return 0.5 * accel * time * time;
    };
    const fresh = distance(0.6, 0);
    const tired = distance(0.6, 1);
    expect(tired).toBeLessThan(fresh * 0.85);
  });

  it('緩急3段階の幅は疲れても変わらない（上下入力の意味が変わらない）', () => {
    const tired = fatiguedSpeed(0.72, 1);
    expect(speedForPitchSelection(-1, tired) - speedForPitchSelection(0, tired)).toBeCloseTo(
      speedForPitchSelection(-1, 0.72) - speedForPitchSelection(0, 0.72),
      6,
    );
    expect(speedForPitchSelection(0, tired) - speedForPitchSelection(1, tired)).toBeCloseTo(
      speedForPitchSelection(0, 0.72) - speedForPitchSelection(1, 0.72),
      6,
    );
  });
});

describe('投球腕（ARM。フェーズCC-50。説明書p26-29）', () => {
  const over = { slot: 'over' } as const;

  it('右投げは三塁側（-X）・左投げは一塁側（+X）から出る（実際の野球の腕の位置）', () => {
    expect(armReleaseOffsetX({ side: RIGHT_ARM_SIDE, ...over })).toBeLessThan(0);
    expect(armReleaseOffsetX({ side: LEFT_ARM_SIDE, ...over })).toBeGreaterThan(0);
  });

  it('左右は完全な鏡像（片側ぶんの式をそのまま反対側に使う＝B-9と同じ整理）', () => {
    for (const slot of ['over', 'under', 'side'] as const) {
      expect(armReleaseOffsetX({ side: RIGHT_ARM_SIDE, slot })).toBeCloseTo(
        -armReleaseOffsetX({ side: LEFT_ARM_SIDE, slot }),
        10,
      );
    }
  });

  /**
   * 腕の角度がそのままリリースの横のずれになる（`腕の長さ × sin`）。**変則ほど遠い**の
   * 順序が崩れると、`entities/player.ts` が描く腕の傾きと球の出どころが食い違う。
   */
  it('上手 ＜ 下手 ＜ 横手 の順に球の出どころが体から遠い', () => {
    const of = (slot: 'over' | 'under' | 'side') =>
      Math.abs(armReleaseOffsetX({ side: RIGHT_ARM_SIDE, slot }));
    expect(of('over')).toBeLessThan(of('under'));
    expect(of('under')).toBeLessThan(of('side'));
  });

  /**
   * `npm run balance:arm` が決めた値の根拠そのもの（CLAUDE.md「バランス調整の方針」）。
   * **いちばん外から出る横手のずれ＝打者が立ち位置で動ける幅**（O-36）に合わせてある
   * ＝投手が腕で持つ左右のずれと、打者が立ち位置で持つ左右の幅が同じ大きさになる。
   */
  it('横手のずれは打者の立ち位置の可動幅と同じ大きさ（新しい数値を持ち込まない）', () => {
    expect(Math.abs(armReleaseOffsetX({ side: RIGHT_ARM_SIDE, slot: 'side' }))).toBeCloseTo(
      BATTER_STANCE_RANGE,
      10,
    );
    expect(ARM_RELEASE_REACH * Math.sin(ARM_SLOT_RAD.side)).toBeCloseTo(BATTER_STANCE_RANGE, 10);
  });

  it('リリース位置は「プレート上の立ち位置＋腕のずれ」（渡さなければ従来どおり）', () => {
    expect(releaseXFor(0.3)).toBe(0.3);
    const offset = armReleaseOffsetX({ side: RIGHT_ARM_SIDE, ...over });
    expect(releaseXFor(0.3, offset)).toBeCloseTo(0.3 + offset, 10);
  });

  /**
   * 逆算（P-37）がプレートの外を要求したときに削る窓。**腕の側へ広く・逆側へ狭い**＝
   * 右投手は三塁側の隅へ楽に曲げられ、一塁側の隅は削られやすい。
   */
  it('立てる窓は腕のぶんそのままずれる（腕の側へ広く・逆側へ狭い）', () => {
    const right = armReleaseOffsetX({ side: RIGHT_ARM_SIDE, ...over });
    expect(clampReleaseX(-99, right)).toBeCloseTo(-RUBBER_HALF_RANGE + right, 10);
    expect(clampReleaseX(99, right)).toBeCloseTo(RUBBER_HALF_RANGE + right, 10);
    // 渡さない呼び出しは従来どおり（B-8以来の基準線）
    expect(clampReleaseX(99)).toBeCloseTo(RUBBER_HALF_RANGE, 10);
    expect(clampReleaseX(0.4)).toBeCloseTo(0.4, 10);
  });

  /**
   * BB-49（打席の左右）との噛み合わせ。**右投げ対右打者は同じ側**＝球が打者の背中側から
   * 出てくる、という実際の野球の見え方になる（どちらの符号を反転させても崩れる）。
   */
  it('右投げ対右打者は同じ側（背中側から出る）／左打者には反対側から', () => {
    const right = armReleaseOffsetX({ side: RIGHT_ARM_SIDE, ...over });
    expect(Math.sign(right)).toBe(Math.sign(batterStandX(RIGHT_BATTER_SIDE)));
    expect(Math.sign(right)).not.toBe(Math.sign(batterStandX(LEFT_BATTER_SIDE)));
  });
});

/**
 * リリースの高さ（フェーズMM-60）。CC-50 がスコープ外として残した1つで、
 * **高低はゾーン判定に含めない**（説明書p19準拠）＝ここは全部「見た目だけ」の値。
 * 帯は `npm run balance:release` が測ったもの（CLAUDE.md「バランス調整の方針」）。
 */
describe('リリースの高さ（フェーズMM-60。投げ方で低くなる）', () => {
  const SLOTS = ['over', 'under', 'side'] as const;
  const heightOf = (slot: (typeof SLOTS)[number], side = RIGHT_ARM_SIDE) =>
    armReleaseHeight({ side, slot });

  /**
   * 基準線を動かさない（B-8の「基準値0.5＝従来の定数」、S-40の「基準速はちょうど従来の78m」、
   * CC-50の「渡さない呼び出しは従来と同じ」と同じ整理）。名鑑96人のうち85人が上手なので、
   * **大多数の投手の見え方はMM-60の前と1ドットも変わらない**。
   */
  it('上手は従来の 1.5m ちょうど（渡さない呼び出しも同じ）', () => {
    expect(heightOf('over')).toBe(RELEASE_HEIGHT);
    expect(heightOf('over', LEFT_ARM_SIDE)).toBe(RELEASE_HEIGHT);
    expect(armReleaseHeight()).toBe(RELEASE_HEIGHT);
    expect(ARM_RELEASE_LEAN_RAD.over).toBe(0);
  });

  it('上手 ＞ 横手 ＞ 下手 の順に低い（実際の野球の見え方）', () => {
    expect(heightOf('over')).toBeGreaterThan(heightOf('side'));
    expect(heightOf('side')).toBeGreaterThan(heightOf('under'));
  });

  /**
   * (a) 帯の下側。**隣り合う投げ方どうしが画面で見分けられる**こと＝でっかいモードの
   * いちばん低い解像度（540p）で 5px 以上（`balance:release` の4段目）。
   * ここを割ると「3つ目の投げ方が無いのと同じ」になる。
   */
  it('隣り合う投げ方は 0.20m 以上離れる（画面で見分けが付く）', () => {
    expect(heightOf('over') - heightOf('side')).toBeGreaterThanOrEqual(0.2);
    expect(heightOf('side') - heightOf('under')).toBeGreaterThanOrEqual(0.2);
  });

  /**
   * (b) 帯の上側その1。手が腰（リリースの瞬間 0.87m）より下がると、脚の外側を通るはずの
   * 腕が体の中へ入る（剛体パーツなのでめり込みがそのまま見える）。
   */
  it('どの投げ方でも手は腰より上（腕が軸足を突き抜けない）', () => {
    for (const slot of SLOTS) expect(heightOf(slot)).toBeGreaterThan(0.87);
  });

  /**
   * (b) 帯の上側その2。**捕手のミット（1.0m）より高い位置から出る**＝球は必ず沈む。
   * 割ると下手投げだけ球が上っていき、放り上げに見える（`balance:release` の6段目）。
   */
  it('どの投げ方でもミット（1.0m）より高い位置から出る（球は上らない）', () => {
    for (const slot of SLOTS) expect(heightOf(slot)).toBeGreaterThan(1.0);
  });

  it('左右は完全な鏡像（高さは腕の側によらない）', () => {
    for (const slot of SLOTS) {
      expect(heightOf(slot, RIGHT_ARM_SIDE)).toBeCloseTo(heightOf(slot, LEFT_ARM_SIDE), 10);
    }
  });

  /**
   * **見た目の手の位置は実寸、判定に持ち込むずれは縮めたもの**（CC-50）。高さの落差は
   * 「体の中心から手までの横の距離」に比例するので、縮める前の実寸を使う必要がある。
   */
  it('見た目の手の横位置は判定用のずれより外（実寸 vs 縮めたもの）', () => {
    for (const slot of SLOTS) {
      const hand = Math.abs(armReleaseHandOffsetX({ side: RIGHT_ARM_SIDE, slot }));
      const judged = Math.abs(armReleaseOffsetX({ side: RIGHT_ARM_SIDE, slot }));
      expect(hand).toBeGreaterThan(judged);
      expect(Math.sign(armReleaseHandOffsetX({ side: RIGHT_ARM_SIDE, slot }))).toBe(
        Math.sign(armReleaseOffsetX({ side: RIGHT_ARM_SIDE, slot })),
      );
    }
  });

  /**
   * **判定は1つも動かない**（この投球は高低をゾーン判定に含めない＝`PitchFlight` は
   * x と z しか持たない）。CC-50 の横のずれに触れていないことをここで固定する。
   */
  it('リリースの横のずれ（CC-50）は高さを入れても変わらない', () => {
    expect(armReleaseOffsetX({ side: RIGHT_ARM_SIDE, slot: 'side' })).toBeCloseTo(
      RIGHT_ARM_SIDE * ARM_RELEASE_REACH * Math.sin(ARM_SLOT_RAD.side),
      10,
    );
    expect(createPitchFlight(0.3, 40)).not.toHaveProperty('y');
  });
});
