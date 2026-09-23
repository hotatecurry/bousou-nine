/**
 * フェーズO-36：打席内の立ち位置（説明書p14「+でバッティングポジションを決め、Aでスイング」）。
 *
 * 着手前の実態：打者は `BATTER_STAND_X`（打席の中央）に固定で、**打者側にコースへの
 * 対抗手段が「振るか見送るか」しか無かった**。原作差分の🔶で最後まで残っていた1行。
 *
 * 設計は「立ち位置のオフセット1つから全部を導出する」（B-9で打席の左右を符号1つに
 * 集約したのと同じ形）：**バットの到達範囲・芯・死球ゾーン・見た目の立ち位置・
 * 銃の命中ゾーン**がすべて同じ値から動く。
 *
 * ここで固定するのは5つ。
 * 1. **既定 0 は従来と完全に同じ**（B-8以来の基準線。既存1155件が1件も変わっていない）
 * 2. **可動幅は「寄り切っても内角のストライクに届く」最大値**（`npm run balance:stance`）
 * 3. **どれだけ寄ってもストライクゾーンの球で死球にはならない**（設計不変条件）
 * 4. **接触の広さ（バットの届く幅）は動かない**＝立ち位置は打ちやすさではなく
 *    「どのコースを取りに行くか」の選択
 * 5. **CPUの規則は決定的で読める**（直前の球のコースへ芯を合わせる）
 */
import { describe, expect, it } from 'vitest';
import {
  BATTER_STANCE_MOVE_SPEED,
  BATTER_STANCE_RANGE,
  BATTER_STAND_X,
  BATTER_ZONE_MAX_X,
  BATTER_ZONE_MIN_X,
  LEFT_BATTER_SIDE,
  RIGHT_BATTER_SIDE,
  RUBBER_MOVE_SPEED,
  SPEED_NEUTRAL,
  STRIKE_ZONE_HALF_WIDTH,
  batterFrameX,
  batterStandX,
  clampStance,
  judgePitch,
} from '../src/core/pitch';
import {
  BAT_REACH_INSIDE_X,
  BAT_REACH_OUTSIDE_X,
  SWEET_SPOT_X,
  SWING_IDEAL_SEC,
  batReachFor,
  judgeBunt,
  judgeSwing,
} from '../src/core/batting';
import { chooseCpuStance, shouldCpuSwing } from '../src/core/cpuBatter';
import { batterAimX, judgeShot } from '../src/core/gun';
import { createPitchFlight } from '../src/core/pitch';

/** 寄り切った／離れ切った立ち位置 */
const NEAR = -BATTER_STANCE_RANGE;
const FAR = BATTER_STANCE_RANGE;

/**
 * 打者ローカル（-=外角 / +=内角）→ ワールドX。`batterFrameX` は自分自身の逆関数なので
 * 読み替えはこれ1本で足りる＝**どちらの打席が +X 側かをテストに書き写さない**
 * （フェーズBB-49で右打者が三塁側へ移っても、ここが見ている内角・外角の意味は動かない）。
 */
const at = (localX: number, side = RIGHT_BATTER_SIDE) => batterFrameX(localX, side);

/** ワールドXで指定するスイング（CPUの判断と同じ座標で比べるとき用） */
const swingWorld = (crossX: number, stance = 0, side = RIGHT_BATTER_SIDE) =>
  judgeSwing(
    { crossX, swingTime: SWING_IDEAL_SEC, pitchSpeed: SPEED_NEUTRAL },
    { power: 0.5, average: 0.5 },
    side,
    0,
    stance,
  );

/** 打者ローカルのコースで指定するスイング */
const swing = (localX: number, stance = 0, side = RIGHT_BATTER_SIDE) =>
  swingWorld(at(localX, side), stance, side);

describe('clampStance / batterStandX：立ち位置は1つの値に集約されている', () => {
  it('可動範囲の中はそのまま、外は範囲へ丸める（壊れた値でも打席の外へ出ない）', () => {
    expect(clampStance(0)).toBe(0);
    expect(clampStance(0.1)).toBeCloseTo(0.1, 10);
    expect(clampStance(5)).toBe(BATTER_STANCE_RANGE);
    expect(clampStance(-5)).toBe(-BATTER_STANCE_RANGE);
  });

  it('既定（0）は打席の中央ちょうど＝見た目の基準線が動かない', () => {
    // 右打者は三塁側（-X）、左打者は一塁側（+X）に立つ（フェーズBB-49）
    expect(batterStandX(RIGHT_BATTER_SIDE)).toBe(-BATTER_STAND_X);
    expect(batterStandX(LEFT_BATTER_SIDE)).toBe(BATTER_STAND_X);
  });

  it('負がプレートに寄る・正が離れる（左右はXについて鏡像）', () => {
    // 寄る＝本塁（原点）に近づく＝絶対値が小さくなる（どちらの打席でも同じ）
    for (const side of [RIGHT_BATTER_SIDE, LEFT_BATTER_SIDE] as const) {
      expect(Math.abs(batterStandX(side, NEAR))).toBeLessThan(BATTER_STAND_X);
      expect(Math.abs(batterStandX(side, FAR))).toBeGreaterThan(BATTER_STAND_X);
    }
    expect(batterStandX(LEFT_BATTER_SIDE, NEAR)).toBe(-batterStandX(RIGHT_BATTER_SIDE, NEAR));
  });

  it('移動速度は投手のプレート移動と同じ帯（同じ「位置を決める」操作なので）', () => {
    expect(BATTER_STANCE_MOVE_SPEED).toBeGreaterThan(0);
    expect(BATTER_STANCE_MOVE_SPEED).toBeLessThanOrEqual(RUBBER_MOVE_SPEED * 2);
  });
});

describe('batReachFor：到達範囲と芯が一緒に平行移動する', () => {
  it('既定（0）は従来の定数そのもの', () => {
    expect(batReachFor()).toEqual({
      outside: BAT_REACH_OUTSIDE_X,
      inside: BAT_REACH_INSIDE_X,
      sweet: SWEET_SPOT_X,
    });
  });

  it('寄れば外角へ伸び、内角が縮む（体からの距離は変わらない＝幅が一定）', () => {
    const near = batReachFor(NEAR);
    expect(near.outside).toBeCloseTo(BAT_REACH_OUTSIDE_X + NEAR, 10);
    expect(near.inside).toBeCloseTo(BAT_REACH_INSIDE_X + NEAR, 10);
    expect(near.inside - near.outside).toBeCloseTo(BAT_REACH_INSIDE_X - BAT_REACH_OUTSIDE_X, 10);
  });

  it('芯も一緒に動く（芯だけ本塁中央に残ると、寄るのが一方的な得になる）', () => {
    expect(batReachFor(NEAR).sweet).toBeCloseTo(NEAR, 10);
    expect(batReachFor(FAR).sweet).toBeCloseTo(FAR, 10);
  });

  it('可動範囲の外を渡してもクランプされる', () => {
    expect(batReachFor(-9)).toEqual(batReachFor(-BATTER_STANCE_RANGE));
  });
});

describe('可動幅：寄り切っても内角のストライクには届く（計測で決めた根拠）', () => {
  it('寄り切ってもストライクゾーンの内角端に届く（打てない球を作らない）', () => {
    expect(batReachFor(NEAR).inside).toBeGreaterThanOrEqual(STRIKE_ZONE_HALF_WIDTH);
    expect(swing(STRIKE_ZONE_HALF_WIDTH, NEAR)).not.toBeNull();
  });

  it('離れ切ってもストライクゾーンの外角端に届く', () => {
    expect(batReachFor(FAR).outside).toBeLessThanOrEqual(-STRIKE_ZONE_HALF_WIDTH);
    expect(swing(-STRIKE_ZONE_HALF_WIDTH, FAR)).not.toBeNull();
  });

  it('これより広い可動幅では内角のストライクに届かなくなる（＝上限である理由）', () => {
    expect(BAT_REACH_INSIDE_X - (BATTER_STANCE_RANGE + 0.05)).toBeLessThan(STRIKE_ZONE_HALF_WIDTH);
  });
});

describe('judgeSwing：立ち位置は「どのコースを取りに行くか」の選択', () => {
  it('引数を省略した呼び出しは従来と完全に同じ（基準線が動かない）', () => {
    const withoutStance = judgeSwing({
      crossX: 0,
      swingTime: SWING_IDEAL_SEC,
      pitchSpeed: SPEED_NEUTRAL,
    });
    const withZero = judgeSwing(
      { crossX: 0, swingTime: SWING_IDEAL_SEC, pitchSpeed: SPEED_NEUTRAL },
      undefined,
      RIGHT_BATTER_SIDE,
      0,
      0,
    );
    expect(withZero).toEqual(withoutStance);
  });

  it('寄れば、中央では届かなかった外角の球に届く', () => {
    const far = BAT_REACH_OUTSIDE_X - 0.1;
    expect(swing(far)).toBeNull();
    expect(swing(far, NEAR)).not.toBeNull();
  });

  it('寄れば、中央では届いた内角いっぱいの球に届かなくなる（代償）', () => {
    expect(swing(BAT_REACH_INSIDE_X)).not.toBeNull();
    expect(swing(BAT_REACH_INSIDE_X, NEAR)).toBeNull();
  });

  it('離れれば逆になる（内角へ伸び、外角が届かなくなる）', () => {
    expect(swing(BAT_REACH_OUTSIDE_X)).not.toBeNull();
    expect(swing(BAT_REACH_OUTSIDE_X, FAR)).toBeNull();
    expect(swing(BAT_REACH_INSIDE_X + 0.1, FAR)).not.toBeNull();
  });

  it('芯で捉えた打球は立ち位置によらず同じ（＝寄っても強くならない）', () => {
    const center = swing(SWEET_SPOT_X)!;
    const near = swing(batReachFor(NEAR).sweet, NEAR)!;
    expect(near.vx).toBeCloseTo(center.vx, 10);
    expect(near.vy).toBeCloseTo(center.vy, 10);
    expect(near.vz).toBeCloseTo(center.vz, 10);
  });

  it('同じコースでも、寄れば芯から外れて打球が弱まる（読み違えの代償）', () => {
    const speedOf = (l: { vx: number; vy: number; vz: number }) => Math.hypot(l.vx, l.vy, l.vz);
    // 内角のストライクは、寄るほど詰まる
    expect(speedOf(swing(0.4, NEAR)!)).toBeLessThan(speedOf(swing(0.4)!));
    // 外角のストライクは、寄るほど芯に近づく
    expect(speedOf(swing(-0.4, NEAR)!)).toBeGreaterThan(speedOf(swing(-0.4)!));
  });

  it('バントも同じく到達範囲だけが動く（打球そのものは変わらない）', () => {
    const far = at(BAT_REACH_OUTSIDE_X - 0.1);
    expect(judgeBunt(far, 0)).toBeNull();
    expect(judgeBunt(far, 0, RIGHT_BATTER_SIDE, NEAR)).not.toBeNull();
    expect(judgeBunt(0, 0, RIGHT_BATTER_SIDE, NEAR)).toEqual(judgeBunt(0, 0));
  });

  it('左打者はすべてXについて鏡像になる', () => {
    // 同じ「打者から見たコース」（外角 -0.8）を左右それぞれの打席で受ける
    const right = swing(-0.8, NEAR, RIGHT_BATTER_SIDE);
    const left = swing(-0.8, NEAR, LEFT_BATTER_SIDE);
    expect(right).not.toBeNull();
    expect(left).not.toBeNull();
    expect(left!.vx).toBeCloseTo(-right!.vx, 10);
    expect(left!.vz).toBeCloseTo(right!.vz, 10);
  });
});

describe('judgePitch：死球ゾーンも打者と一緒に動く', () => {
  it('立ち位置0では従来と完全に同じ', () => {
    for (const x of [0, 0.45, 0.8, 0.95, 1.3, 1.7, 1.9]) {
      expect(judgePitch(x, RIGHT_BATTER_SIDE, 0)).toBe(judgePitch(x));
    }
  });

  it('寄ると、中央ではボールだった内角の球が死球になる', () => {
    const x = at(BATTER_ZONE_MIN_X - BATTER_STANCE_RANGE / 2);
    expect(judgePitch(x)).toBe('ball');
    expect(judgePitch(x, RIGHT_BATTER_SIDE, NEAR)).toBe('hitByPitch');
  });

  it('離れると、中央では死球だった球に当たらない', () => {
    const x = at(BATTER_ZONE_MIN_X + BATTER_STANCE_RANGE / 2);
    expect(judgePitch(x)).toBe('hitByPitch');
    expect(judgePitch(x, RIGHT_BATTER_SIDE, FAR)).toBe('ball');
  });

  it('どれだけ寄ってもストライクゾーンの球では死球にならない（設計不変条件）', () => {
    expect(BATTER_ZONE_MIN_X - BATTER_STANCE_RANGE).toBeGreaterThan(STRIKE_ZONE_HALF_WIDTH);
    for (let i = -20; i <= 20; i += 1) {
      const x = (i / 20) * STRIKE_ZONE_HALF_WIDTH;
      expect(judgePitch(x, RIGHT_BATTER_SIDE, NEAR)).toBe('strike');
      expect(judgePitch(x, LEFT_BATTER_SIDE, NEAR)).toBe('strike');
    }
  });

  it('死球ゾーンの幅そのものは変わらない（位置だけが動く）', () => {
    const width = (stance: number): number => {
      let hit = 0;
      for (let x = 0; x < 3; x += 0.001) {
        if (judgePitch(at(x), RIGHT_BATTER_SIDE, stance) === 'hitByPitch') hit += 0.001;
      }
      return hit;
    };
    expect(width(NEAR)).toBeCloseTo(BATTER_ZONE_MAX_X - BATTER_ZONE_MIN_X, 2);
    expect(width(FAR)).toBeCloseTo(BATTER_ZONE_MAX_X - BATTER_ZONE_MIN_X, 2);
  });

  it('左打者では反対側へ動く', () => {
    const x = at(BATTER_ZONE_MIN_X - BATTER_STANCE_RANGE / 2, LEFT_BATTER_SIDE);
    expect(x).toBeGreaterThan(0); // 左打者は一塁側（+X）＝右打者の鏡像（BB-49）
    expect(judgePitch(x, LEFT_BATTER_SIDE)).toBe('ball');
    expect(judgePitch(x, LEFT_BATTER_SIDE, NEAR)).toBe('hitByPitch');
  });
});

describe('銃：命中ゾーンと狙いが立ち位置に追従する（フェーズF-26-2の延長）', () => {
  it('狙いは打者の中心に乗り続ける（寄れば狙いも寄る）', () => {
    // 見た目の立ち位置（batterStandX）そのもの＝照準の上限で削られていない
    expect(batterAimX(RIGHT_BATTER_SIDE)).toBe(batterStandX(RIGHT_BATTER_SIDE));
    expect(batterAimX(RIGHT_BATTER_SIDE, NEAR)).toBeCloseTo(at(BATTER_STAND_X + NEAR), 10);
    expect(batterAimX(LEFT_BATTER_SIDE, NEAR)).toBeCloseTo(
      at(BATTER_STAND_X + NEAR, LEFT_BATTER_SIDE),
      10,
    );
  });

  it('CPUの狙いは立ち位置がどこでも必中（予兆つきなので理不尽にはならない）', () => {
    for (const stance of [NEAR, 0, FAR]) {
      expect(judgeShot(batterAimX(RIGHT_BATTER_SIDE, stance), RIGHT_BATTER_SIDE, stance)).toBe(
        'hitByPitch',
      );
    }
  });

  it('打者が離れれば、中央を狙った弾は当たらなくなる', () => {
    const aim = batterAimX(RIGHT_BATTER_SIDE);
    expect(judgeShot(aim, RIGHT_BATTER_SIDE, 0)).toBe('hitByPitch');
    expect(judgeShot(at(BATTER_ZONE_MIN_X + 0.05), RIGHT_BATTER_SIDE, FAR)).toBe('ball');
  });
});

describe('chooseCpuStance：直前の球のコースへ芯を合わせる（決定的・読める）', () => {
  it('初球は打席の中央', () => {
    expect(chooseCpuStance(null)).toBe(0);
  });

  it('外角へ投げた次の球では寄る／内角へ投げた次の球では離れる', () => {
    expect(chooseCpuStance(-0.1)).toBeCloseTo(-0.1, 10);
    expect(chooseCpuStance(0.1)).toBeCloseTo(0.1, 10);
  });

  it('大きく外れた球でも可動範囲の中に収まる', () => {
    expect(chooseCpuStance(-3)).toBe(-BATTER_STANCE_RANGE);
    expect(chooseCpuStance(3)).toBe(BATTER_STANCE_RANGE);
  });

  it('同じ入力からは必ず同じ立ち位置（乱数を使っていない）', () => {
    for (const x of [null, -0.5, 0, 0.2, 1.4]) {
      expect(chooseCpuStance(x)).toBe(chooseCpuStance(x));
    }
  });

  it('芯＝立ち位置なので、狙ったコースがそのまま芯になる', () => {
    const stance = chooseCpuStance(-0.15);
    expect(batReachFor(stance).sweet).toBeCloseTo(-0.15, 10);
  });
});

describe('shouldCpuSwing：立ち位置は「届くか」にだけ効く（選球眼は動かさない）', () => {
  const flightAt = (x: number) => createPitchFlight(x, SPEED_NEUTRAL, 0);
  const count = { balls: 0, strikes: 0 };

  // **フェーズSS-67で選球の幅が到達範囲の内側に入った**（2ストライクでも `ゾーン+隅` まで）
  // ので、**打席の中央では幅のほうが先に効く**＝立ち位置は選球の結果に出ない。
  // 到達範囲が幅より内側へ縮む「離れて／寄って立った打席」でだけ、届くかどうかが表に出る。
  it('離れて立てば、外角の球は届かなくなる（＝立ち位置が効くのは届くかどうかだけ）', () => {
    const x = at(-0.5);
    expect(shouldCpuSwing(flightAt(x), { balls: 0, strikes: 2 })).toBe(true);
    expect(shouldCpuSwing(flightAt(x), { balls: 0, strikes: 2 }, RIGHT_BATTER_SIDE, FAR)).toBe(
      false,
    );
  });

  it('寄って立てば、内角の球は届かなくなる', () => {
    const x = at(0.5);
    expect(shouldCpuSwing(flightAt(x), { balls: 0, strikes: 2 })).toBe(true);
    expect(shouldCpuSwing(flightAt(x), { balls: 0, strikes: 2 }, RIGHT_BATTER_SIDE, NEAR)).toBe(
      false,
    );
  });

  it('選球眼（甘い球だけ振る）は立ち位置で変わらない', () => {
    // ゾーンから十分外れた球は、届いても振らない（2ストライク前）
    const x = at(-0.7);
    expect(shouldCpuSwing(flightAt(x), count, RIGHT_BATTER_SIDE, NEAR)).toBe(false);
    expect(shouldCpuSwing(flightAt(x), count, RIGHT_BATTER_SIDE, 0)).toBe(false);
  });

  it('振ると決めたのに届かない、が無い（判断と接触が同じ `batReachFor` を見ている）', () => {
    // **フェーズSS-67で「届くのに見送る」は起きるようになった**（選球の幅が到達範囲の
    // 内側に入ったので、届く球でも幅の外なら見送る＝それが四球・見逃し三振を生む）。
    // 逆向き（振ると決めたのに届かない）が無いことは設計の不変条件のまま。
    for (const stance of [NEAR, -0.1, 0, 0.1, FAR]) {
      for (let i = -20; i <= 20; i += 1) {
        const x = (i / 20) * 1.2;
        const decided = shouldCpuSwing(
          flightAt(x),
          { balls: 0, strikes: 2 },
          RIGHT_BATTER_SIDE,
          stance,
        );
        if (decided) expect(swingWorld(x, stance)).not.toBeNull();
      }
    }
  });
});
