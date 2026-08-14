import { describe, expect, it } from 'vitest';
import {
  type BattedBall,
  type BattedBallLaunch,
  type PlaneCrossing,
  BAT_REACH_INSIDE_X,
  BAT_REACH_OUTSIDE_X,
  CONTACT_HEIGHT,
  CONTACT_PLANE_Z,

  SWING_ACTIVE_SEC,
  SWING_IDEAL_SEC,
  SWING_STARTUP_SEC,
  BUNT_EXIT_SPEED,
  BUNT_PUSH_EXIT_SPEED,
  EXIT_FATIGUE_BONUS,
  EXIT_POWER_BONUS,
  NEUTRAL_BATTER,
  callAfterSwing,
  contactPlaneCrossing,
  createBattedBall,
  isFairPosition,
  judgeBunt,
  judgeSwing,
  stepBattedBall,
} from '../src/core/batting';
import {
  type Ballpark,
  DEFAULT_BALLPARK,
  ballparkById,
  fenceAt,
} from '../src/core/ballpark';
import {
  type BatterSide,
  type PitchFlight,
  LEFT_BATTER_SIDE,
  RIGHT_BATTER_SIDE,
  batterFrameX,
  SPEED_FAST,
  SPEED_NEUTRAL,
  SPEED_SLOW,
  batterStandX,
  createPitchFlight,
  fatiguedSpeed,
  speedForPitchSelection,
  stepPitchFlight,
} from '../src/core/pitch';

const DT = 1 / 60;

function launchSpeed(l: BattedBallLaunch): number {
  return Math.hypot(l.vx, l.vy, l.vz);
}

/** 水平面からの打ち上げ角（rad） */
function launchAngle(l: BattedBallLaunch): number {
  return Math.atan2(l.vy, Math.hypot(l.vx, l.vz));
}

/**
 * コースは**打者ローカル**（-=外角 / +=内角）で書く。`batterFrameX` は自分自身の逆関数
 * （符号を掛けるだけ）なので、ローカル→ワールドの読み替えもこれ1本で足りる＝
 * **打席がどちら側にあるかをテスト側に書き写さない**（フェーズBB-49で右打者が
 * 三塁側へ移っても、テストが見ている「内角・外角」の意味は動かない）。
 */
function worldX(localX: number, side: BatterSide = RIGHT_BATTER_SIDE): number {
  return batterFrameX(localX, side);
}

function idealContact(pitchSpeed: number, localX = 0): BattedBallLaunch {
  const launch = judgeSwing({ crossX: worldX(localX), swingTime: SWING_IDEAL_SEC, pitchSpeed });
  if (!launch) throw new Error('接触しなかった');
  return launch;
}

/** フェンス越えか静止まで打球を飛ばす */
function simulate(initial: BattedBall, park: Ballpark = DEFAULT_BALLPARK): BattedBall {
  let state = initial;
  for (let i = 0; i < 10000 && !state.resting && state.over === null; i++) {
    state = stepBattedBall(state, DT, park);
  }
  return state;
}

/** 既定の球場（ところざわ）の中堅フェンスまでの距離。フェンス際のテストの基準にする */
const CENTER_FENCE = fenceAt(DEFAULT_BALLPARK, 0).distance;
const KASENJIKI = ballparkById('kasenjiki');

/** 最初の着地まで打球を飛ばす */
function flyUntilLanding(initial: BattedBall): BattedBall {
  let state = initial;
  for (let i = 0; i < 10000 && state.landing === null; i++) {
    state = stepBattedBall(state, DT);
  }
  if (state.landing === null) throw new Error('着地しなかった');
  return state;
}

describe('judgeSwing（タイミング判定）', () => {
  it('始動前・振り抜き後の通過は空振り', () => {
    expect(
      judgeSwing({ crossX: 0, swingTime: SWING_STARTUP_SEC - 0.001, pitchSpeed: SPEED_NEUTRAL }),
    ).toBeNull();
    expect(
      judgeSwing({
        crossX: 0,
        swingTime: SWING_STARTUP_SEC + SWING_ACTIVE_SEC + 0.001,
        pitchSpeed: SPEED_NEUTRAL,
      }),
    ).toBeNull();
  });

  it('有効時間の境界（始動直後・振り抜き際）は接触する', () => {
    expect(
      judgeSwing({ crossX: 0, swingTime: SWING_STARTUP_SEC, pitchSpeed: SPEED_NEUTRAL }),
    ).not.toBeNull();
    expect(
      judgeSwing({
        crossX: 0,
        swingTime: SWING_STARTUP_SEC + SWING_ACTIVE_SEC,
        pitchSpeed: SPEED_NEUTRAL,
      }),
    ).not.toBeNull();
  });

  it('ジャストミート×芯はセンター方向への強い打球', () => {
    const launch = idealContact(SPEED_NEUTRAL);
    expect(Math.abs(launch.vx)).toBeLessThan(1e-9);
    expect(launch.vy).toBeGreaterThan(0);
    expect(launch.vz).toBeLessThan(0);
  });

  it('早振りは引っ張り（右打者は三塁側 -X）、振り遅れは流し（+X）', () => {
    const early = judgeSwing({
      crossX: 0,
      swingTime: SWING_IDEAL_SEC + SWING_ACTIVE_SEC / 4,
      pitchSpeed: SPEED_NEUTRAL,
    })!;
    const late = judgeSwing({
      crossX: 0,
      swingTime: SWING_IDEAL_SEC - SWING_ACTIVE_SEC / 4,
      pitchSpeed: SPEED_NEUTRAL,
    })!;
    expect(early.vx).toBeLessThan(0);
    expect(late.vx).toBeGreaterThan(0);
  });

  it('極端なタイミングは方向が45°を超える（ファウルゾーン方向）', () => {
    const edge = judgeSwing({
      crossX: 0,
      swingTime: SWING_STARTUP_SEC + SWING_ACTIVE_SEC,
      pitchSpeed: SPEED_NEUTRAL,
    })!;
    expect(Math.abs(edge.vx)).toBeGreaterThan(Math.abs(edge.vz));
  });

  it('タイミングがずれるほど初速が落ちる', () => {
    const ideal = launchSpeed(idealContact(SPEED_NEUTRAL));
    const off = launchSpeed(
      judgeSwing({
        crossX: 0,
        swingTime: SWING_IDEAL_SEC + 0.05,
        pitchSpeed: SPEED_NEUTRAL,
      })!,
    );
    expect(off).toBeLessThan(ideal);
  });
});

describe('judgeSwing（コース判定）', () => {
  it('バットが届かないコースは空振り', () => {
    expect(
      judgeSwing({
        crossX: worldX(BAT_REACH_OUTSIDE_X - 0.01),
        swingTime: SWING_IDEAL_SEC,
        pitchSpeed: SPEED_NEUTRAL,
      }),
    ).toBeNull();
    expect(
      judgeSwing({
        crossX: worldX(BAT_REACH_INSIDE_X + 0.01),
        swingTime: SWING_IDEAL_SEC,
        pitchSpeed: SPEED_NEUTRAL,
      }),
    ).toBeNull();
  });

  it('内角いっぱい（詰まる）はゴロになる', () => {
    const jammed = idealContact(SPEED_NEUTRAL, BAT_REACH_INSIDE_X);
    expect(jammed.vy).toBeLessThan(0);
  });

  it('外角（バットの先）は芯よりフライ寄りになる', () => {
    const tip = idealContact(SPEED_NEUTRAL, BAT_REACH_OUTSIDE_X);
    const sweet = idealContact(SPEED_NEUTRAL);
    expect(launchAngle(tip)).toBeGreaterThan(launchAngle(sweet));
  });

  it('芯を外すほど初速が落ちる', () => {
    const sweet = launchSpeed(idealContact(SPEED_NEUTRAL));
    const off = launchSpeed(idealContact(SPEED_NEUTRAL, BAT_REACH_OUTSIDE_X / 2));
    expect(off).toBeLessThan(sweet);
  });

  it('速球ほど打球初速が出る（緩急のリスクとリターン）', () => {
    expect(launchSpeed(idealContact(SPEED_FAST))).toBeGreaterThan(
      launchSpeed(idealContact(SPEED_SLOW)),
    );
  });
});

describe('callAfterSwing（空振りストライク）', () => {
  it('空振りならボール球でもストライク', () => {
    expect(callAfterSwing('ball', true)).toBe('strike');
  });

  it('見逃しは判定そのまま', () => {
    expect(callAfterSwing('ball', false)).toBe('ball');
    expect(callAfterSwing('strike', false)).toBe('strike');
  });

  it('死球はスイングの有無に関係なくそのまま', () => {
    expect(callAfterSwing('hitByPitch', true)).toBe('hitByPitch');
  });
});

describe('contactPlaneCrossing', () => {
  const at = (x: number, z: number): PitchFlight => ({ x, z, vx: 0, vz: SPEED_NEUTRAL });

  it('打撃面の手前どうしのステップでは null', () => {
    expect(contactPlaneCrossing(at(0, -3), at(0, -2))).toBeNull();
  });

  it('通過済みのステップでは null（二重判定しない）', () => {
    expect(contactPlaneCrossing(at(0, -0.2), at(0, 0.5))).toBeNull();
  });

  it('通過時のXとサブフレーム時刻を線形補間で求める', () => {
    const cross = contactPlaneCrossing(at(0, -0.8), { x: 1, z: 0.2, vx: 0, vz: SPEED_NEUTRAL });
    expect(cross).not.toBeNull();
    expect((cross as PlaneCrossing).x).toBeCloseTo(0.5);
    expect((cross as PlaneCrossing).frac).toBeCloseTo(0.5);
  });
});

describe('stepBattedBall（打球物理）', () => {
  it('入力オブジェクトを変更しない（純粋関数）', () => {
    const ball = createBattedBall({ vx: 0, vy: 10, vz: -30 }, 0);
    const before = structuredClone(ball);
    stepBattedBall(ball, DT);
    expect(ball).toEqual(before);
  });

  it('重力で縦速度が減る', () => {
    const ball = createBattedBall({ vx: 0, vy: 10, vz: -30 }, 0);
    const next = stepBattedBall(ball, DT);
    expect(next.vy).toBeLessThan(ball.vy);
  });

  it('最初の着地点を記録し、以後のバウンドで上書きしない', () => {
    let state = createBattedBall({ vx: 0, vy: 5, vz: -20 }, 0);
    state = flyUntilLanding(state);
    const first = { ...state.landing! };
    for (let i = 0; i < 300; i++) state = stepBattedBall(state, DT);
    expect(state.landing).toEqual(first);
  });

  it('バウンドと転がりで減衰し最終的に静止する', () => {
    const state = simulate(createBattedBall({ vx: 0, vy: 8, vz: -25 }, 0));
    expect(state.resting).toBe(true);
    expect(state.vx).toBe(0);
    expect(state.vz).toBe(0);
    expect(Math.hypot(state.x, state.z)).toBeGreaterThan(10);
  });

  it('フェンス直撃は場内へ跳ね返る', () => {
    let state: BattedBall = {
      x: 0,
      y: 2,
      z: -(CENTER_FENCE - 0.2),
      vx: 0,
      vy: 5,
      vz: -20,
      landing: null,
      over: null,
      resting: false,
      bunt: false,
    };
    state = stepBattedBall(state, DT);
    expect(state.over).toBeNull();
    expect(state.vz).toBeGreaterThan(0);
    expect(Math.hypot(state.x, state.z)).toBeLessThanOrEqual(CENTER_FENCE);
  });

  it('ノーバウンドでフェンス上端より高く越えると over=fly', () => {
    let state: BattedBall = {
      x: 0,
      y: 10,
      z: -(CENTER_FENCE - 0.1),
      vx: 0,
      vy: 1,
      vz: -30,
      landing: null,
      over: null,
      resting: false,
      bunt: false,
    };
    state = stepBattedBall(state, DT);
    expect(state.over).toBe('fly');
  });

  it('バウンド後に越えると over=bounce（エンタイトルツーベース候補）', () => {
    let state: BattedBall = {
      x: 0,
      y: 10,
      z: -(CENTER_FENCE - 0.1),
      vx: 0,
      vy: 1,
      vz: -30,
      landing: { x: 0, z: -60 },
      over: null,
      resting: false,
      bunt: false,
    };
    state = stepBattedBall(state, DT);
    expect(state.over).toBe('bounce');
  });
});

describe('isFairPosition', () => {
  it('外野方向はフェア、両翼線上もフェア', () => {
    expect(isFairPosition(0, -50)).toBe(true);
    expect(isFairPosition(5, -5)).toBe(true);
    expect(isFairPosition(-5, -5)).toBe(true);
    expect(isFairPosition(0, 0)).toBe(true);
  });

  it('両翼線の外・本塁より後ろはファウル', () => {
    expect(isFairPosition(5.01, -5)).toBe(false);
    expect(isFairPosition(-5.01, -5)).toBe(false);
    expect(isFairPosition(0, 1)).toBe(false);
  });
});

describe('打撃の統合挙動（スイング→打球→落下）', () => {
  /**
   * フェーズC-14以降、この当たり（能力値なしの打者が速球をジャストミート）は
   * **球場によって帰結が変わる**：狭いかせんじき（中堅110m）なら越え、最も平均的な
   * ところざわ（同120m）では中堅フェンスの手前で失速して直撃になる。
   * 球場を選ぶことがそのままHRの出やすさの選択になっている、ということの確認。
   */
  it('速球をジャストミートで芯に当てると、狭い球場なら本塁打になる', () => {
    const state = simulate(createBattedBall(idealContact(SPEED_FAST), 0), KASENJIKI);
    expect(state.over).toBe('fly');
    expect(isFairPosition(state.x, state.z)).toBe(true);
  });

  it('同じ当たりでも平均的な球場（ところざわ）ではフェンスを越えない', () => {
    const state = simulate(createBattedBall(idealContact(SPEED_FAST), 0));
    expect(state.over).toBeNull();
  });

  it('スローボールはジャストミートでもフェンスをノーバウンドで越えない', () => {
    const state = simulate(createBattedBall(idealContact(SPEED_SLOW), 0));
    expect(state.over).toBeNull();
    expect(state.resting).toBe(true);
    expect(isFairPosition(state.landing!.x, state.landing!.z)).toBe(true);
  });

  it('詰まった内角打ちは内野ゴロ（浅い位置で静止）', () => {
    const state = simulate(
      createBattedBall(idealContact(SPEED_NEUTRAL, BAT_REACH_INSIDE_X), 0.4),
    );
    expect(state.resting).toBe(true);
    expect(Math.hypot(state.x, state.z)).toBeLessThan(50);
  });

  it('極端に早いスイングはレフト線の外へファウルになる', () => {
    const launch = judgeSwing({
      crossX: 0,
      swingTime: SWING_STARTUP_SEC + SWING_ACTIVE_SEC * 0.98,
      pitchSpeed: SPEED_NEUTRAL,
    })!;
    const state = flyUntilLanding(createBattedBall(launch, 0));
    expect(isFairPosition(state.landing!.x, state.landing!.z)).toBe(false);
  });

  it('投球フローとの結合：速球の打撃面通過を捉えて本塁打にできる', () => {
    let flight = createPitchFlight(0, SPEED_FAST);
    for (let i = 0; i < 1000; i++) {
      const next = stepPitchFlight(flight, 0, DT);
      const cross = contactPlaneCrossing(flight, next);
      if (cross) {
        const launch = judgeSwing({
          crossX: cross.x,
          swingTime: SWING_IDEAL_SEC,
          pitchSpeed: flight.vz,
        });
        expect(launch).not.toBeNull();
        const state = simulate(createBattedBall(launch!, cross.x), KASENJIKI);
        expect(state.over).toBe('fly');
        expect(isFairPosition(state.x, state.z)).toBe(true);
        return;
      }
      flight = next;
    }
    throw new Error('打撃面に到達しなかった');
  });

  it('接触点の高さは打撃面上で一定（コアは高さをゾーンに含めない・原作準拠）', () => {
    const ball = createBattedBall(idealContact(SPEED_NEUTRAL), 0.3);
    expect(ball.y).toBe(CONTACT_HEIGHT);
    expect(ball.z).toBe(CONTACT_PLANE_Z);
    expect(ball.x).toBe(0.3);
  });
});

describe('judgeSwing（打者の能力値：フェーズB-8）', () => {
  /** 芯・ジャストミートの当たり */
  const sweet = (batter?: Parameters<typeof judgeSwing>[1]) =>
    judgeSwing({ crossX: 0, swingTime: SWING_IDEAL_SEC, pitchSpeed: SPEED_NEUTRAL }, batter)!;
  /** 芯を外し、タイミングもずらした当たり */
  const mishit = (batter?: Parameters<typeof judgeSwing>[1]) =>
    judgeSwing(
      {
        crossX: BAT_REACH_INSIDE_X * 0.8,
        swingTime: SWING_IDEAL_SEC + 0.04,
        pitchSpeed: SPEED_NEUTRAL,
      },
      batter,
    )!;

  it('能力値を渡さないと基準値の打者として扱う（従来の打球と完全に一致する）', () => {
    expect(launchSpeed(sweet())).toBe(launchSpeed(sweet(NEUTRAL_BATTER)));
    expect(launchSpeed(mishit())).toBe(launchSpeed(mishit(NEUTRAL_BATTER)));
  });

  it('長打力が高いほど打球初速が出る（上乗せ幅は EXIT_POWER_BONUS まで）', () => {
    const weak = launchSpeed(sweet({ power: 0, average: 0 }));
    const slugger = launchSpeed(sweet({ power: 1, average: 0 }));
    expect(slugger).toBeGreaterThan(weak);
    expect(slugger - weak).toBeCloseTo(EXIT_POWER_BONUS, 5);
  });

  it('打率は芯を外した当たりの弱まりを和らげる', () => {
    const poor = launchSpeed(mishit({ power: 0, average: 0 }));
    const skilled = launchSpeed(mishit({ power: 0, average: 1 }));
    expect(skilled).toBeGreaterThan(poor);
  });

  it('打率は芯を食った当たりには影響しない（巧打者でも上限は動かない）', () => {
    // ずれが0なら緩和する対象そのものが無い＝ジャストミートの打球は打者によらず同じ
    expect(launchSpeed(sweet({ power: 0, average: 1 }))).toBeCloseTo(
      launchSpeed(sweet({ power: 0, average: 0 })),
      10,
    );
  });

  it('能力値は「当たるかどうか」には一切影響しない（操作の手応えを打者で変えない）', () => {
    const best = { power: 1, average: 1 };
    // バットが届かないコースは、どんな打者でも空振り
    expect(
      judgeSwing(
        {
          crossX: worldX(BAT_REACH_OUTSIDE_X - 0.01),
          swingTime: SWING_IDEAL_SEC,
          pitchSpeed: SPEED_NEUTRAL,
        },
        best,
      ),
    ).toBeNull();
    // スイングの有効時間の外も、どんな打者でも空振り
    expect(
      judgeSwing(
        { crossX: 0, swingTime: SWING_STARTUP_SEC - 0.001, pitchSpeed: SPEED_NEUTRAL },
        best,
      ),
    ).toBeNull();
  });

  it('能力値は 0..1 の外を渡されても頭打ちになる（極端な値で壊れない）', () => {
    expect(launchSpeed(sweet({ power: 5, average: 5 }))).toBeCloseTo(
      launchSpeed(sweet({ power: 1, average: 1 })),
      10,
    );
    expect(launchSpeed(mishit({ power: -5, average: -5 }))).toBeCloseTo(
      launchSpeed(mishit({ power: 0, average: 0 })),
      10,
    );
  });

  /**
   * 能力値が「試合の帰結」を実際に変えることの確認（数値の上下だけでなく結果が変わる）。
   * 基準速をジャストミートしたとき、非力な打者の当たりはフェンス手前で失速し、
   * 長打力のある打者は越える＝**同じスイングでも打者が違えば結果が違う**。
   */
  it('基準速のジャストミートは、非力な打者だと外野フライ・長打力があると本塁打になる', () => {
    // 球場はかせんじき（中堅110m）で固定する。**能力値の差が帰結の差になる境目は
    // 球場の広さで動く**ので、どの球場で見るかを決めないとこの比較が成り立たない
    // （ところざわ120mでは power 0.5 も越えなくなる＝フェーズC-14）。
    const hit = (power: number) =>
      simulate(
        createBattedBall(
          judgeSwing(
            { crossX: 0, swingTime: SWING_IDEAL_SEC, pitchSpeed: SPEED_NEUTRAL },
            { power, average: 0 },
          )!,
          0,
        ),
        KASENJIKI,
      );
    expect(hit(0).over).toBeNull(); // 9番打者クラス（power 0.15）は越えない
    expect(hit(0.5).over).toBe('fly'); // 中距離打者以上は越える
    expect(hit(0.95).over).toBe('fly'); // 4番（power 0.95）
  });

  it('スローボールは長打力があっても飛距離が伸びるだけで本塁打にはならない', () => {
    const carry = (power: number) => {
      const state = simulate(
        createBattedBall(
          judgeSwing(
            { crossX: 0, swingTime: SWING_IDEAL_SEC, pitchSpeed: SPEED_SLOW },
            { power, average: 0 },
          )!,
          0,
        ),
      );
      return { over: state.over, dist: Math.hypot(state.landing!.x, state.landing!.z) };
    };
    // 緩い球は打者の力だけではフェンスを越えない（＝緩急にはちゃんと意味がある）
    expect(carry(0).over).toBeNull();
    expect(carry(1).over).toBeNull();
    // ただし飛距離ははっきり伸びる（長打力が死んでいるわけではない）
    expect(carry(0.5).dist).toBeGreaterThan(carry(0).dist + 10);
  });
});

describe('judgeBunt（バント：説明書p14「スイングの途中でAを離すとバント」）', () => {
  it('バットが届くコースならタイミングによらず当たる', () => {
    // フルスイングなら空振りになる極端なタイミングでも、バントは当たる（バットを出すだけなので）
    expect(judgeSwing({ crossX: 0, swingTime: 0, pitchSpeed: SPEED_NEUTRAL })).toBeNull();
    expect(judgeBunt(0, 0)).not.toBeNull();
  });

  it('バットが届かないコースは空振り（フルスイングと同じ到達範囲）', () => {
    expect(judgeBunt(worldX(BAT_REACH_OUTSIDE_X - 0.01), 0)).toBeNull();
    expect(judgeBunt(worldX(BAT_REACH_INSIDE_X + 0.01), 0)).toBeNull();
  });

  it('打球はフルスイングよりはるかに弱い（転がる程度）', () => {
    const bunt = judgeBunt(0, 0)!;
    expect(launchSpeed(bunt)).toBeCloseTo(BUNT_EXIT_SPEED, 5);
    expect(launchSpeed(bunt)).toBeLessThan(launchSpeed(idealContact(SPEED_NEUTRAL)) / 2);
  });

  it('打ち上げ角は浅い（フライにならずゴロで転がる）', () => {
    const bunt = judgeBunt(0, 0)!;
    expect(launchAngle(bunt)).toBeLessThan(launchAngle(idealContact(SPEED_NEUTRAL)));
    expect((launchAngle(bunt) * 180) / Math.PI).toBeLessThan(15);
  });

  it('十字キー左右で転がす方向を狙える（-1=三塁側 / +1=一塁側）', () => {
    expect(judgeBunt(0, -1)!.vx).toBeLessThan(0); // 三塁側（-X）
    expect(judgeBunt(0, 0)!.vx).toBeCloseTo(0, 5); // 正面
    expect(judgeBunt(0, 1)!.vx).toBeGreaterThan(0); // 一塁側（+X）
  });

  it('狙った方向でもフェアゾーンに収まる（45度を超えない）', () => {
    for (const aim of [-1, 0, 1] as const) {
      const b = judgeBunt(0, aim)!;
      // 進行方向の角度（|vx| < |vz| ならファウルラインの内側）
      expect(Math.abs(b.vx)).toBeLessThan(Math.abs(b.vz));
    }
  });

  it('内野に収まる距離で止まる（外野まで届かない）', () => {
    const state = simulate(createBattedBall(judgeBunt(0, 0)!, 0));
    expect(state.resting).toBe(true);
    expect(Math.hypot(state.x, state.z)).toBeLessThan(45);
  });

  // ---- 押しバント（フェーズY-46。説明書p17「ファールラインぎりぎりに転がすのがコツ」）----

  it('十字キー上で強く転がる（押しバント）', () => {
    expect(launchSpeed(judgeBunt(0, 0, RIGHT_BATTER_SIDE, 0, true)!)).toBeCloseTo(
      BUNT_PUSH_EXIT_SPEED,
      5,
    );
    expect(BUNT_PUSH_EXIT_SPEED).toBeGreaterThan(BUNT_EXIT_SPEED);
  });

  it('押しても既定（押さない）は従来のバントと完全に同じ', () => {
    for (const aim of [-1, 0, 1] as const) {
      expect(judgeBunt(0, aim, RIGHT_BATTER_SIDE, 0, false)).toEqual(judgeBunt(0, aim));
    }
  });

  it('押しても変わるのは速さだけ（転がす方向・打ち上げ角は同じ）', () => {
    for (const aim of [-1, 0, 1] as const) {
      const normal = judgeBunt(0, aim)!;
      const pushed = judgeBunt(0, aim, RIGHT_BATTER_SIDE, 0, true)!;
      expect(launchAngle(pushed)).toBeCloseTo(launchAngle(normal), 6);
      // 方向（水平面の角度）が同じ＝速度ベクトルは定数倍の関係
      expect(Math.atan2(pushed.vx, -pushed.vz)).toBeCloseTo(Math.atan2(normal.vx, -normal.vz), 6);
    }
  });

  it('押しバントも打者の能力値では変わらない（バントは打力に左右されない）', () => {
    // judgeBunt は BattingProfile を受け取らない＝押しても打力の入る余地が無い
    expect(launchSpeed(judgeBunt(0, 1, RIGHT_BATTER_SIDE, 0, true)!)).toBeCloseTo(
      BUNT_PUSH_EXIT_SPEED,
      6,
    );
  });

  it('押しバントもフェアゾーンに収まる（ファウルラインの内側）', () => {
    for (const aim of [-1, 0, 1] as const) {
      const b = judgeBunt(0, aim, RIGHT_BATTER_SIDE, 0, true)!;
      expect(Math.abs(b.vx)).toBeLessThan(Math.abs(b.vz));
    }
  });

  it('押しバントも内野に収まる（外野へ抜ける打球にはならない）', () => {
    const state = simulate(createBattedBall(judgeBunt(0, -1, RIGHT_BATTER_SIDE, 0, true)!, 0));
    expect(state.resting).toBe(true);
    expect(Math.hypot(state.x, state.z)).toBeLessThan(45);
  });

  it('押しバントは左打者でも鏡像になる（方向は画面の絶対方向のまま）', () => {
    expect(judgeBunt(0, 1, LEFT_BATTER_SIDE, 0, true)).toEqual(
      judgeBunt(0, 1, RIGHT_BATTER_SIDE, 0, true),
    );
  });
});

/**
 * 「バントで転がした打球か」を打球そのものが運ぶ（フェーズAA-48）。ファウルになったとき
 * だけ意味を持つ（2ストライク後は三振＝`rules.ts` の `buntFoul`）。
 */
describe('打球がバントの事実を運ぶ（AA-48）', () => {
  it('既定は false（渡さない呼び出しは従来と同じ）', () => {
    expect(createBattedBall({ vx: 0, vy: 10, vz: -30 }, 0).bunt).toBe(false);
  });

  it('渡せばそのまま持つ', () => {
    expect(createBattedBall(judgeBunt(0, 0)!, 0, true).bunt).toBe(true);
  });

  it('飛行しても失われない（ちっちゃいモードの決着まで運ばれる）', () => {
    const state = simulate(createBattedBall(judgeBunt(0, -1)!, 0, true));
    expect(state.resting).toBe(true);
    expect(state.bunt).toBe(true);
  });

  it('飛行そのものには一切効かない（バント以外の打球と同じ物理）', () => {
    const launch = { vx: 3, vy: 10, vz: -30 };
    const plain = simulate(createBattedBall(launch, 0.2, false));
    const bunted = simulate(createBattedBall(launch, 0.2, true));
    expect({ ...bunted, bunt: false }).toEqual(plain);
  });
});

describe('左打者（BOX。フェーズB-9）', () => {
  /**
   * 同じ「打者から見たコース」での右打者／左打者の打球（`worldX` がローカル→ワールドを
   * 打席の左右に応じて読み替えるので、**どちらの打席が +X 側かをここに書かない**）。
   */
  const rightAt = (localX: number, swingTime = SWING_IDEAL_SEC) =>
    judgeSwing(
      { crossX: worldX(localX, RIGHT_BATTER_SIDE), swingTime, pitchSpeed: SPEED_NEUTRAL },
      NEUTRAL_BATTER,
      RIGHT_BATTER_SIDE,
    );
  const leftAt = (localX: number, swingTime = SWING_IDEAL_SEC) =>
    judgeSwing(
      { crossX: worldX(localX, LEFT_BATTER_SIDE), swingTime, pitchSpeed: SPEED_NEUTRAL },
      NEUTRAL_BATTER,
      LEFT_BATTER_SIDE,
    );

  it('省略時は右打者（従来の固定）と完全に一致する', () => {
    const omitted = judgeSwing({ crossX: 0.3, swingTime: SWING_IDEAL_SEC, pitchSpeed: SPEED_NEUTRAL });
    expect(omitted).toEqual(
      judgeSwing(
        { crossX: 0.3, swingTime: SWING_IDEAL_SEC, pitchSpeed: SPEED_NEUTRAL },
        NEUTRAL_BATTER,
        RIGHT_BATTER_SIDE,
      ),
    );
  });

  it('バットの到達範囲がXについて鏡像になる', () => {
    // ワールドXで指定する（打者ローカルではなく、実際に飛んできたコース）
    const swingAt = (crossX: number, side: typeof RIGHT_BATTER_SIDE | typeof LEFT_BATTER_SIDE) =>
      judgeSwing(
        { crossX, swingTime: SWING_IDEAL_SEC, pitchSpeed: SPEED_NEUTRAL },
        NEUTRAL_BATTER,
        side,
      );
    // 到達範囲は外角側のほうが広い（0.75 ＞ 0.65）ので、どちらの打者に届くかが
    // -X/+X で入れ替わる。**右打者は三塁側（-X）に立つ**ので、その外角いっぱいは
    // +0.75＝一塁側（フェーズBB-49）＝左打者には背中側で届かない。
    expect(swingAt(-BAT_REACH_OUTSIDE_X, RIGHT_BATTER_SIDE)).not.toBeNull();
    expect(swingAt(-BAT_REACH_OUTSIDE_X, LEFT_BATTER_SIDE)).toBeNull();
    // 左打者の外角いっぱいは -0.75＝三塁側（右打者には内角を外れて届かない）
    expect(swingAt(BAT_REACH_OUTSIDE_X, LEFT_BATTER_SIDE)).not.toBeNull();
    expect(swingAt(BAT_REACH_OUTSIDE_X, RIGHT_BATTER_SIDE)).toBeNull();
    // 打者ローカルで見れば範囲そのものは左右で同じ
    expect(leftAt(BAT_REACH_INSIDE_X)).not.toBeNull();
    expect(leftAt(BAT_REACH_INSIDE_X + 0.01)).toBeNull();
    expect(leftAt(BAT_REACH_OUTSIDE_X - 0.01)).toBeNull();
  });

  it('引っ張り方向が逆になる（右=三塁側 / 左=一塁側）', () => {
    const early = SWING_STARTUP_SEC + SWING_ACTIVE_SEC * 0.95;
    expect(rightAt(0, early)!.vx).toBeLessThan(0); // 三塁側（-X）
    expect(leftAt(0, early)!.vx).toBeGreaterThan(0); // 一塁側（+X）
  });

  it('引っ張るのは打者が立っている側＝内角の球を引っ張る（フェーズBB-49）', () => {
    // **BB-49 で直した誤りそのもの**：B-9〜AA-48 は引っ張り方向が「打者から遠い側」に
    // あり、打席の位置と合わせて2つの誤りが打ち消し合っていた（ワールドの打球方向だけ
    // 正しく見えていた）。ここを固定しておけば、片方だけ直したときに必ず落ちる。
    const early = SWING_STARTUP_SEC + SWING_ACTIVE_SEC * 0.95;
    for (const side of [RIGHT_BATTER_SIDE, LEFT_BATTER_SIDE] as const) {
      const stand = batterStandX(side);
      const pulled = judgeSwing(
        { crossX: worldX(0, side), swingTime: early, pitchSpeed: SPEED_NEUTRAL },
        NEUTRAL_BATTER,
        side,
      )!;
      // 引っ張った打球は打者の立っている側へ飛ぶ（符号が同じ）
      expect(Math.sign(pulled.vx)).toBe(Math.sign(stand));
      // 内角いっぱい（打者ローカル +X）の球も、打者の立っている側のコース
      expect(Math.sign(worldX(BAT_REACH_INSIDE_X, side))).toBe(Math.sign(stand));
    }
  });

  it('打者から見て同じ当たりなら、打球は左右の符号だけが違う（強さ・角度は同じ）', () => {
    for (const localX of [-0.7, -0.3, 0, 0.3, 0.6]) {
      for (const swingTime of [0.04, SWING_IDEAL_SEC, 0.15]) {
        const r = rightAt(localX, swingTime);
        const l = leftAt(localX, swingTime);
        if (r === null) {
          expect(l).toBeNull();
          continue;
        }
        expect(l).not.toBeNull();
        expect(l!.vx).toBeCloseTo(-r.vx, 10);
        expect(l!.vy).toBeCloseTo(r.vy, 10);
        expect(l!.vz).toBeCloseTo(r.vz, 10);
      }
    }
  });

  it('バントも到達範囲だけが鏡像になる（狙う方向は画面の絶対方向のまま）', () => {
    // 到達範囲：右打者の外角いっぱい（+0.75＝一塁側。BB-49）は左打者には届かない
    // （フルスイングと同じ範囲）
    expect(judgeBunt(-BAT_REACH_OUTSIDE_X, 0, LEFT_BATTER_SIDE)).toBeNull();
    expect(judgeBunt(BAT_REACH_OUTSIDE_X, 0, LEFT_BATTER_SIDE)).not.toBeNull();
    expect(judgeBunt(BAT_REACH_OUTSIDE_X, 0, RIGHT_BATTER_SIDE)).toBeNull();
    // 転がす方向：左打者でも -1 は三塁側（-X）のまま＝押した向きへ転がる
    expect(judgeBunt(0, -1, LEFT_BATTER_SIDE)!.vx).toBeLessThan(0);
    expect(judgeBunt(0, 1, LEFT_BATTER_SIDE)!.vx).toBeGreaterThan(0);
    expect(judgeBunt(0, 1, LEFT_BATTER_SIDE)).toEqual(judgeBunt(0, 1, RIGHT_BATTER_SIDE));
  });

  it('打者の能力値は打席の左右と独立に効く（長打力は左打者でも初速を上げる）', () => {
    const slugger = { power: 1, average: 0 };
    const weak = { power: 0, average: 0 };
    const hit = (batter: typeof slugger) =>
      launchSpeed(
        judgeSwing(
          { crossX: 0, swingTime: SWING_IDEAL_SEC, pitchSpeed: SPEED_NEUTRAL },
          batter,
          LEFT_BATTER_SIDE,
        )!,
      );
    expect(hit(slugger)).toBeCloseTo(hit(weak) + EXIT_POWER_BONUS, 5);
  });
});

describe('投手の疲労が打球に効く（フェーズB-11の「球威」）', () => {
  /** 芯・ジャストミートで捉えたときの打球（比較の基準） */
  function justMeet(pitchSpeed: number, pitcherFatigue: number): BattedBallLaunch {
    const launch = judgeSwing(
      { crossX: 0, swingTime: SWING_IDEAL_SEC, pitchSpeed },
      NEUTRAL_BATTER,
      RIGHT_BATTER_SIDE,
      pitcherFatigue,
    );
    expect(launch).not.toBeNull();
    return launch!;
  }

  it('疲労0なら疲労を持ち込む前とまったく同じ打球（基準線）', () => {
    const withArg = justMeet(SPEED_NEUTRAL, 0);
    const withoutArg = judgeSwing(
      { crossX: 0, swingTime: SWING_IDEAL_SEC, pitchSpeed: SPEED_NEUTRAL },
      NEUTRAL_BATTER,
      RIGHT_BATTER_SIDE,
    );
    expect(withArg).toEqual(withoutArg);
  });

  it('同じ球速なら、疲れた投手の球ほど打球初速が上がる', () => {
    const fresh = launchSpeed(justMeet(SPEED_NEUTRAL, 0));
    const half = launchSpeed(justMeet(SPEED_NEUTRAL, 0.5));
    const spent = launchSpeed(justMeet(SPEED_NEUTRAL, 1));
    expect(half).toBeGreaterThan(fresh);
    expect(spent).toBeGreaterThan(half);
    expect(spent - fresh).toBeCloseTo(EXIT_FATIGUE_BONUS, 6);
  });

  /**
   * B-11の設計の要：初速は `EXIT_PITCH_CARRY × 球速` を含むので、**疲労で球速だけを
   * 落とすと打球はむしろ飛ばなくなる**。球威の上乗せがその損失を上回っていることを
   * 「実際に疲れた投手が投げた球」（球速も落ちた球）どうしの比較で固定する。
   */
  it('球速低下を織り込んでも、疲れた投手からのほうが打球は速い', () => {
    const rating = 0.72;
    const fresh = launchSpeed(justMeet(speedForPitchSelection(0, rating), 0));
    const tired = launchSpeed(
      justMeet(speedForPitchSelection(0, fatiguedSpeed(rating, 1)), 1),
    );
    expect(tired).toBeGreaterThan(fresh);
    // 長打力+0.5相当（+3m/s前後）＝フェンスを越えるかどうかが入れ替わる幅
    expect(tired - fresh).toBeGreaterThan(2);
  });

  it('球威は長打力とまったく同じ形で乗る（非力な打者にも一発が出る）', () => {
    const powerless = launchSpeed(justMeet(SPEED_NEUTRAL, 1));
    const slugger = launchSpeed(
      judgeSwing(
        { crossX: 0, swingTime: SWING_IDEAL_SEC, pitchSpeed: SPEED_NEUTRAL },
        { power: EXIT_FATIGUE_BONUS / EXIT_POWER_BONUS, average: 0 },
        RIGHT_BATTER_SIDE,
        0,
      )!,
    );
    expect(powerless).toBeCloseTo(slugger, 6);
  });

  it('バントは投手の疲労に左右されない（当てて転がすだけ）', () => {
    // judgeBunt は疲労を受け取らない＝球威の上乗せが入る余地がない
    expect(launchSpeed(judgeBunt(0, 0)!)).toBeCloseTo(BUNT_EXIT_SPEED, 6);
  });

  it('届かないコースは疲労MAXでも空振り（当たりやすさは変わらない）', () => {
    const outOfReach = worldX(BAT_REACH_INSIDE_X + 0.1);
    expect(
      judgeSwing(
        { crossX: outOfReach, swingTime: SWING_IDEAL_SEC, pitchSpeed: SPEED_NEUTRAL },
        NEUTRAL_BATTER,
        RIGHT_BATTER_SIDE,
        1,
      ),
    ).toBeNull();
  });
});
