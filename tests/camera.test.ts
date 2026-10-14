import { describe, expect, it } from 'vitest';
import {
  BALL_RADIUS,
  CAMERA_FOLLOW_TAU,
  CHICCHAI_BALL_SCALE,
  CHICCHAI_FOV_DEG,
  CHICCHAI_PLAYER_SCALE,
  CHICCHAI_TILT_DEG,
  CHICCHAI_VIEW_HALF_WIDTH,
  DEKKAI_BALL_ANCHOR,
  DEKKAI_BALL_ANCHOR_DISTANCE,
  DEKKAI_BALL_SCALE,
  DEKKAI_CAMERA_LOOK_AT,
  DEKKAI_CAMERA_POS,
  DEKKAI_EDGE_MARGIN,
  DEKKAI_FOV_DEG,
  DEKKAI_PITCH_SIZE_FAR,
  DEKKAI_PITCH_SIZE_NEAR,
  DEKKAI_PITCH_SIZE_SWITCH,
  DEKKAI_RUNNER_HALF_WIDTH,
  DEKKAI_SHADOW_ASPECT,
  FOCUS_LIMIT,
  cameraDistance,
  cameraOffset,
  clampFocus,
  dekkaiBallScale,
  dekkaiFovFor,
  dekkaiPitchLook,
  dekkaiScreenRise,
  dekkaiViewDepth,
  edgeMarker,
  followFocus,
  pitchLineHeight,
  CHANGEUP_DROP_BOTTOM,
  CHANGEUP_DROP_TOP,
  FORK_BOUNCE_CENTER_Y,
  FORK_BOUNCE_Z,
  changeupEndHeight,
  pitchDrawnHeight,
} from '../src/core/camera';
import { CONTACT_PLANE_Z } from '../src/core/batting';
import { BALLPARKS, deepestFence } from '../src/core/ballpark';
import { BASE_AXIS, CATCH_RADIUS } from '../src/core/fielding';
import {
  CATCH_HEIGHT,
  CATCH_Z,
  NEUTRAL_PITCH_ARM,
  PITCHER_PLATE_Z,
  RELEASE_Z,
  SPEED_FAST_DELTA,
  SPEED_SLOW_DELTA,
  STRIKE_ZONE_HALF_WIDTH,
  armReleaseHeight,
  createPitchFlight,
  neutralSpeedFor,
  pitchClockRate,
  stepPitchFlight,
  PLATE_Z as PLATE_Z_PITCH,
  SPEED_NEUTRAL as SPEED_NEUTRAL_PITCH,
  SPEED_SLOW as SPEED_SLOW_PITCH,
  pitchStallFor,
} from '../src/core/pitch';
import { GROUND_RADIUS } from '../src/scenes/field';

/** 上手投げのリリースの高さ（MM-60。フォークの落ち方のテストで使う） */
const RELEASE_HEIGHT_OVER = armReleaseHeight(NEUTRAL_PITCH_ARM);

const DEG = Math.PI / 180;
const WIDE = 16 / 9;

/** そのアスペクト比で地面に映る横幅の半分（＝寄り具合の実測） */
function visibleHalfWidth(aspect: number, halfWidth = CHICCHAI_VIEW_HALF_WIDTH): number {
  const distance = cameraDistance(CHICCHAI_FOV_DEG, aspect, halfWidth);
  const halfHorizontal = Math.atan(Math.tan((CHICCHAI_FOV_DEG / 2) * DEG) * aspect);
  return distance * Math.tan(halfHorizontal);
}

/**
 * 追従点から見て、画面の奥（外野方向）と手前（本塁方向）に何m映るか。
 * 奥は「見下ろす角度 - 垂直画角の半分」のレイが地面に当たる位置、
 * 手前は「見下ろす角度 + 垂直画角の半分」（90度を超えるとカメラの真下より後ろ）。
 */
function visibleDepth(aspect: number): { ahead: number; behind: number } {
  const distance = cameraDistance(CHICCHAI_FOV_DEG, aspect, CHICCHAI_VIEW_HALF_WIDTH);
  const { y, z } = cameraOffset(distance, CHICCHAI_TILT_DEG);
  const halfV = (CHICCHAI_FOV_DEG / 2) * DEG;
  const far = (CHICCHAI_TILT_DEG * DEG) - halfV;
  const near = (CHICCHAI_TILT_DEG * DEG) + halfV;
  return {
    // カメラの地面上の足元は追従点より z 手前にいる
    ahead: y / Math.tan(far) - z,
    behind: y / Math.tan(near) + z,
  };
}

describe('CHICCHAI_PLAYER_SCALE（選手を実寸の何倍で描くか。フェーズLL-59）', () => {
  /** 直立した高さの見かけの伸び（見下ろしているぶん cos だけしか残らない） */
  const apparent = (h: number) => h * Math.cos(CHICCHAI_TILT_DEG * DEG);
  /** 頭が足元から手前の地面へどれだけ重なって見えるか＝体が覆う地面 */
  const footprint = (h: number) => h / Math.tan(CHICCHAI_TILT_DEG * DEG);
  const PLAYER_HEIGHT = 1.8;
  const pixelsPerMeter = (screenW: number) => screenW / (2 * CHICCHAI_VIEW_HALF_WIDTH);

  it('実寸のままではない（E-24以来の「数ピクセルにしかならない」を解消する値）', () => {
    expect(CHICCHAI_PLAYER_SCALE).toBeGreaterThan(1);
  });

  it('いちばん狭い窓（800x600）でも原作のスプライト（16px）を下回らない＝下限', () => {
    // 800x600 は FF-53 がHUDの折り返しを実測した窓（実際に遊ばれうるいちばん狭い形）。
    const tall = apparent(PLAYER_HEIGHT * CHICCHAI_PLAYER_SCALE) * pixelsPerMeter(800);
    expect(tall).toBeGreaterThan(16);
  });

  it('描かれた体が捕球半径を覆い尽くさない＝上限', () => {
    // 覆いが捕球半径に届くと「触れているのに捕れない／離れて見えるのに捕れる」が
    // 画面から読めなくなる（判定そのものは1mmも動かないので、読み取りだけの問題）。
    expect(footprint(PLAYER_HEIGHT * CHICCHAI_PLAYER_SCALE)).toBeLessThan(CATCH_RADIUS);
  });

  it('拡大しても映る範囲・見下ろす角度は動かさない（送球先の塁が見える条件は不変）', () => {
    // 大きく見せるてこは3つあるが、カメラ側の2つには触らないことがこのフェーズの前提
    // （半幅を縮める手は「一塁・三塁が両方入る」に触れて1.7倍で頭打ちになる）。
    expect(CHICCHAI_VIEW_HALF_WIDTH).toBeGreaterThan(19.4);
    expect(CHICCHAI_TILT_DEG).toBe(70);
  });
});

describe('ボールの見かけの大きさ（フェーズNN-61。`npm run balance:ball` で測った帯）', () => {
  /** 奥行き d にある 1m が画面で何pxになるか（でっかいモードの垂直画角＝窓の形から） */
  const dekkaiPpm = (d: number, screenH = 720, aspect = 16 / 9) =>
    screenH / (2 * d * Math.tan((dekkaiFovFor(aspect) / 2) * DEG));
  /** 遠近投影で大きさを決めるのは視線方向の奥行き（直線距離ではない） */
  const depth = (p: { x: number; y: number; z: number }) => dekkaiViewDepth(p);
  /** 上手投げの球の出どころ（MM-60）と本塁・ミット */
  const releasePoint = { x: 0, y: armReleaseHeight(NEUTRAL_PITCH_ARM), z: RELEASE_Z };
  const mittPoint = { x: 0, y: CATCH_HEIGHT, z: CATCH_Z };
  /** 画面上の直径 px（距離補正込み） */
  const apparentDiameter = (p: { x: number; y: number; z: number }, screenH = 720) =>
    2 * BALL_RADIUS * dekkaiBallScale(p) * dekkaiPpm(depth(p), screenH);

  it('ジオメトリは実寸（公認球＝直径7.3cm。従来は0.4m＝10.9倍のプレースホルダー）', () => {
    expect(BALL_RADIUS).toBeGreaterThan(0.035);
    expect(BALL_RADIUS).toBeLessThan(0.038);
  });

  it('でっかいモードは飛行中ずっと同じ大きさに見える（原作の2Dスプライトと同じ扱い）', () => {
    // 素の3Dだと リリース→ミット で見かけが3.2倍に育つ＝いちばん見たいリリースの
    // 瞬間がいちばん小さい（実寸のままだと 2.6px）。距離補正がそれを一定にする。
    const along = [releasePoint, { x: 0, y: 1.2, z: -8 }, DEKKAI_BALL_ANCHOR, mittPoint];
    for (const p of along) {
      expect(apparentDiameter(p)).toBeCloseTo(apparentDiameter(DEKKAI_BALL_ANCHOR), 6);
    }
  });

  it('基準の大きさで見えるのは基準点＝本塁の1点だけ（遠いほど大きく描く）', () => {
    expect(dekkaiBallScale(DEKKAI_BALL_ANCHOR)).toBeCloseTo(DEKKAI_BALL_SCALE, 12);
    expect(dekkaiBallScale(releasePoint)).toBeGreaterThan(DEKKAI_BALL_SCALE); // 遠い＝大きく描く
    expect(dekkaiBallScale(mittPoint)).toBeLessThan(DEKKAI_BALL_SCALE); // 近い＝小さく描く
  });

  it('倍率はゾーンが実物より広いのと同じ＝ゾーン幅に対する球の比が実際の野球と同じ', () => {
    // 新しい数値を持ち込まずに大きさを決めるための物差し（2026-08-16 のテストプレイで
    // 「実寸＝1.0倍では小さすぎる」と出たときの根拠）。実際の野球は本塁ベース 0.432m に
    // 対して球 0.073m＝約17%で、このゲームのゾーン（0.9m）でも同じ比になる。
    const drawnAtPlate = 2 * BALL_RADIUS * DEKKAI_BALL_SCALE;
    expect(drawnAtPlate / (2 * STRIKE_ZONE_HALF_WIDTH)).toBeCloseTo(0.073 / 0.4318, 3);
  });

  it('MM-60のリリースの高さの差が球の半分より広く見える＝大きさの上限（設計の不変条件）', () => {
    // 大きくするほど、腕ごとの球の出どころの差（上手–横手 0.220m）が球に埋もれる。
    // NN-61 のプレースホルダー（直径0.8m）はこれが球0.27個ぶんで完全に隠れていた。
    // 実寸1.0倍なら1.13個ぶん確保できたが、それでは球が小さすぎたので（テストプレイ）、
    // **中心の高さの違いが読める**ところまでを上限にする＝球の半分（＝2.26倍）。
    const step = Math.abs(
      armReleaseHeight({ side: 1, slot: 'over' }) - armReleaseHeight({ side: 1, slot: 'side' }),
    );
    const stepPx = step * dekkaiPpm(depth(releasePoint));
    expect(stepPx / apparentDiameter(releasePoint)).toBeGreaterThan(0.5);
    // MM-60 自身の読み取り条件（5px以上離れる）は球の大きさに依らない＝こちらは球を
    // いくら大きくしても壊れない。**16:9 の窓では 960x540 まで成り立つ**。
    // ZZ-74 で一・三塁の走者が必ず入るよう画角を窓の形から決めるようにしたので、
    // 4:3（800x600）では 6.5px→4.5px に下がった（ユーザー判断で受け入れた代償）。
    expect(step * dekkaiPpm(depth(releasePoint), 540)).toBeGreaterThan(5);
    expect(step * dekkaiPpm(depth(releasePoint), 600, 4 / 3)).toBeGreaterThan(4);
  });

  it('基準点はミットより遠い（ミット基準にすると上の不変条件が破れる）', () => {
    expect(DEKKAI_BALL_ANCHOR_DISTANCE).toBeGreaterThan(depth(mittPoint));
  });

  it('ちっちゃいモードの見かけは LL-59 のときと変わらない（描画半径0.6m）', () => {
    // 従来は「半径0.4mのジオメトリ×1.5倍」。実寸16.4倍がちょうど同じ大きさになる。
    expect(BALL_RADIUS * CHICCHAI_BALL_SCALE).toBeCloseTo(0.6, 2);
  });

  it('ちっちゃいモードの球は選手より小さく、いちばん狭い窓でも見える', () => {
    const ppm = 800 / (2 * CHICCHAI_VIEW_HALF_WIDTH);
    const ballPx = 2 * BALL_RADIUS * CHICCHAI_BALL_SCALE * ppm;
    const playerPx = 1.8 * CHICCHAI_PLAYER_SCALE * Math.cos(CHICCHAI_TILT_DEG * DEG) * ppm;
    expect(ballPx).toBeGreaterThan(8);
    expect(ballPx).toBeLessThan(playerPx);
  });

  it('カメラの置き場所は動かしていない（画角の下限も40°のまま。実際の画角は窓の形から＝ZZ-74）', () => {
    expect(DEKKAI_FOV_DEG).toBe(40);
    expect(DEKKAI_CAMERA_POS).toEqual({ x: 0, y: 4.5, z: CATCH_Z + 8 });
    expect(DEKKAI_CAMERA_LOOK_AT).toEqual({ x: 0, y: 1.5, z: PITCHER_PLATE_Z });
  });
});

describe('投球の見え方：原作準拠（フェーズBBB-76。`npm run balance:flight`）', () => {
  const over = armReleaseHeight(NEUTRAL_PITCH_ARM);
  const neutral = neutralSpeedFor();
  const fork = neutral - SPEED_SLOW_DELTA;
  const fast = neutral + SPEED_FAST_DELTA;
  const lookAt = (z: number, vz = neutral, x = 0, vx = 0) => dekkaiPitchLook({ x, z, vx, vz }, over);
  /** 1280x720 の画面で、リリースから打撃面まで1フレームごとに描く球の縦の位置（px。下が正） */
  const drawnTrack = (speed: number): number[] => {
    const px = 720 / (2 * Math.tan((dekkaiFovFor(16 / 9) / 2) * DEG));
    let flight = createPitchFlight(0, speed, 0, pitchClockRate(speed, neutral));
    const ys: number[] = [];
    while (flight.z < CONTACT_PLANE_Z) {
      ys.push(-dekkaiScreenRise(lookAt(flight.z, speed).center) * px);
      flight = stepPitchFlight(flight, 0, 1 / 60);
    }
    return ys;
  };

  it('通り道はリリースの高さからミットの高さへの直線（PP-63の弧はやめた＝原作の球は弧を描かない）', () => {
    for (const slot of ['over', 'side', 'under'] as const) {
      const from = armReleaseHeight({ side: 1, slot });
      expect(pitchLineHeight(RELEASE_Z, from)).toBeCloseTo(from, 9);
      expect(pitchLineHeight(CATCH_Z, from)).toBeCloseTo(CATCH_HEIGHT, 9);
      const mid = (RELEASE_Z + CATCH_Z) / 2;
      expect(pitchLineHeight(mid, from)).toBeCloseTo((from + CATCH_HEIGHT) / 2, 9);
    }
  });

  it('球は画面を一定の速さで下りてくる（原作の影は毎フレーム同じドット数ずつ進む）', () => {
    for (const speed of [fork, neutral, fast]) {
      const ys = drawnTrack(speed);
      const steps = ys.slice(1).map((y, i) => y - ys[i]);
      const lo = Math.min(...steps);
      const hi = Math.max(...steps);
      expect(lo).toBeGreaterThan(0);
      // 1フレームの刻みのばらつきは 3% 未満（3Dのままだと手元で数倍に加速する）
      expect((hi - lo) / hi).toBeLessThan(0.03);
    }
  });

  it('描く球はリリースと打撃面で本当の場所と一致する（手から出て、バットのところで当たる）', () => {
    const atRelease = lookAt(RELEASE_Z);
    expect(atRelease.center.z).toBeCloseTo(RELEASE_Z, 9);
    expect(atRelease.center.y).toBeCloseTo(over, 9);
    const atContact = lookAt(CONTACT_PLANE_Z);
    expect(atContact.center.z).toBeCloseTo(CONTACT_PLANE_Z, 9);
    expect(atContact.center.y).toBeCloseTo(pitchLineHeight(CONTACT_PLANE_Z, over), 9);
    expect(lookAt(CATCH_Z).center.z).toBeCloseTo(CATCH_Z, 9);
  });

  it('途中は本当の場所より先（本塁寄り）へ描く＝等速に見せるため。先へ行くのは途中だけ', () => {
    for (const z of [-15, -10, -5, -1]) {
      expect(lookAt(z).center.z).toBeGreaterThan(z);
    }
  });

  it('曲がる球も通り道の上に乗る（横はいまの速度のまま、描く奥行きまで外挿する）', () => {
    const z = -9;
    const look = lookAt(z, neutral, 0.1, 0.8);
    expect(look.center.x).toBeCloseTo(0.1 + (0.8 * (look.center.z - z)) / neutral, 9);
  });

  it('球の絵は途中で1回だけ大きくなる（原作の 4×4 → 6×6 ドット）', () => {
    expect(DEKKAI_PITCH_SIZE_NEAR / DEKKAI_PITCH_SIZE_FAR).toBeCloseTo(1.5, 9);
    expect(DEKKAI_PITCH_SIZE_SWITCH).toBeCloseTo(13 / 23, 9);
    const span = CATCH_Z - RELEASE_Z;
    const before = lookAt(RELEASE_Z + span * (DEKKAI_PITCH_SIZE_SWITCH - 0.01));
    const after = lookAt(RELEASE_Z + span * (DEKKAI_PITCH_SIZE_SWITCH + 0.01));
    expect(before.scale / dekkaiBallScale(before.center)).toBeCloseTo(DEKKAI_PITCH_SIZE_FAR, 9);
    expect(after.scale / dekkaiBallScale(after.center)).toBeCloseTo(DEKKAI_PITCH_SIZE_NEAR, 9);
  });

  it('手元の球は原作と同じく本塁の幅のおよそ1/4（1280x720 で 18px）', () => {
    const look = lookAt(CONTACT_PLANE_Z);
    const ppm = 720 / (2 * dekkaiViewDepth(look.center) * Math.tan((dekkaiFovFor(16 / 9) / 2) * DEG));
    const px = 2 * BALL_RADIUS * look.scale * ppm;
    expect(px).toBeGreaterThan(16);
    expect(px).toBeLessThan(20);
  });

  it('影は球の真下の地面にあり、縦横比はどこでも原作の影と同じ（地面の円を伸ばして揃える）', () => {
    for (const z of [RELEASE_Z, -8, CONTACT_PLANE_Z]) {
      const look = lookAt(z);
      expect(look.shadow.x).toBeCloseTo(look.center.x, 9);
      expect(look.shadow.z).toBeCloseTo(look.center.z, 9);
      // 奥行きの伸ばし × 見下ろす角度の正弦 ＝ 縦横比
      const sinLook = DEKKAI_CAMERA_POS.y / Math.hypot(DEKKAI_CAMERA_POS.y, look.shadow.z - DEKKAI_CAMERA_POS.z);
      expect(look.shadow.depthStretch * sinLook).toBeCloseTo(DEKKAI_SHADOW_ASPECT, 9);
    }
  });
});

describe('cameraDistance / cameraOffset（寄り具合の決め方）', () => {
  it('地面に映る横幅は指定した半幅どおりになる', () => {
    expect(visibleHalfWidth(WIDE)).toBeCloseTo(CHICCHAI_VIEW_HALF_WIDTH, 6);
  });

  it('アスペクト比が変わっても映る横幅は変わらない（縦長の画面ではカメラが引く）', () => {
    // ウィンドウの形で寄り具合が変わると、同じ操作でも野手の見かけの速さが変わってしまう
    expect(visibleHalfWidth(4 / 3)).toBeCloseTo(CHICCHAI_VIEW_HALF_WIDTH, 6);
    expect(visibleHalfWidth(21 / 9)).toBeCloseTo(CHICCHAI_VIEW_HALF_WIDTH, 6);
    expect(cameraDistance(CHICCHAI_FOV_DEG, 4 / 3, CHICCHAI_VIEW_HALF_WIDTH)).toBeGreaterThan(
      cameraDistance(CHICCHAI_FOV_DEG, WIDE, CHICCHAI_VIEW_HALF_WIDTH),
    );
  });

  it('寄るほどカメラは近づく（半幅と距離は比例する）', () => {
    const near = cameraDistance(CHICCHAI_FOV_DEG, WIDE, 20);
    const far = cameraDistance(CHICCHAI_FOV_DEG, WIDE, 40);
    expect(far).toBeCloseTo(near * 2, 6);
  });

  it('オフセットは見下ろす角度どおりで、距離は保たれる', () => {
    const offset = cameraOffset(100, CHICCHAI_TILT_DEG);
    expect(Math.hypot(offset.y, offset.z)).toBeCloseTo(100, 6);
    // 70度なら真上寄り（高さ＞引き）
    expect(offset.y).toBeGreaterThan(offset.z);
    expect(offset.y).toBeCloseTo(100 * Math.sin(CHICCHAI_TILT_DEG * DEG), 6);
  });

  it('真上から見下ろす（90度）ならカメラは追従点の真上に来る', () => {
    const offset = cameraOffset(50, 90);
    expect(offset.z).toBeCloseTo(0, 6);
    expect(offset.y).toBeCloseTo(50, 6);
  });

  it('従来の固定鳥瞰（半幅約108m）より寄っている', () => {
    // 旧実装は高さ140m・同じ画角でフィールド全体を収めていた。E-24の狙いは
    // 「選手が数ピクセル」を解消することなので、ここが縮んでいないと意味がない。
    expect(CHICCHAI_VIEW_HALF_WIDTH).toBeLessThan(108 / 2);
  });

  it('内野の塁がひとかたまりで映る寄り具合になっている（塁間27.4m）', () => {
    // 本塁を追っているときに一塁・三塁（X方向に±19.4m）が両方入る
    expect(CHICCHAI_VIEW_HALF_WIDTH).toBeGreaterThan(19.4);
    // 奥行きも塁間より広く映る＝走っている走者と行き先の塁が同時に見える
    // （これを割ると「どこへ投げるか」の判断が画面の外で起きてしまう）
    const depth = visibleDepth(WIDE);
    expect(depth.ahead + depth.behind).toBeGreaterThan(27.4);
  });

  it('追う対象より奥（プレーが進む外野方向）を広く映す', () => {
    // 見下ろす角度をつけているぶん、手前の端はカメラのほぼ真下に来る。結果として
    // 追っているものは画面のやや下に置かれ、打球・走者が進む先が広く見える。
    const depth = visibleDepth(WIDE);
    expect(depth.ahead).toBeGreaterThan(depth.behind);
  });
});

describe('followFocus（追従の滑らかさ）', () => {
  const from = { x: 0, z: 0 };
  const to = { x: 10, z: -20 };

  it('dt=0 では動かない', () => {
    expect(followFocus(from, to, 0)).toEqual(from);
  });

  it('目標へ近づくが行き過ぎない', () => {
    const next = followFocus(from, to, 1 / 60);
    expect(next.x).toBeGreaterThan(0);
    expect(next.x).toBeLessThan(to.x);
    expect(next.z).toBeLessThan(0);
    expect(next.z).toBeGreaterThan(to.z);
  });

  it('dt が大きければほぼ追いつく（重いフレームでも置き去りにならない）', () => {
    const next = followFocus(from, to, 5);
    expect(next.x).toBeCloseTo(to.x, 3);
    expect(next.z).toBeCloseTo(to.z, 3);
  });

  it('フレームレートに依存しない（半分のdtで2回＝1回分と同じ）', () => {
    const once = followFocus(from, to, 1 / 30);
    const twice = followFocus(followFocus(from, to, 1 / 60), to, 1 / 60);
    expect(twice.x).toBeCloseTo(once.x, 10);
    expect(twice.z).toBeCloseTo(once.z, 10);
  });

  it('時定数が大きいほど遅れる（＝スクロールしている感じが強くなる）', () => {
    const quick = followFocus(from, to, 1 / 60, 0.05);
    const slow = followFocus(from, to, 1 / 60, 0.5);
    expect(quick.x).toBeGreaterThan(slow.x);
  });

  it('最速の打球でも遅れは画面の半幅に収まる', () => {
    // 定常状態の遅れ＝速度×時定数。ここが半幅を超えるとボールが画面から出る
    const fastestBallSpeed = 45;
    expect(fastestBallSpeed * CAMERA_FOLLOW_TAU).toBeLessThan(CHICCHAI_VIEW_HALF_WIDTH);
  });
});

describe('clampFocus（追従点の可動範囲）', () => {
  it('範囲内はそのまま', () => {
    expect(clampFocus({ x: 10, z: -30 })).toEqual({ x: 10, z: -30 });
  });

  it('外野へ深追いしない（ホームランの打球は画面の外へ抜ける）', () => {
    expect(clampFocus({ x: 0, z: -140 }).z).toBe(FOCUS_LIMIT.deep);
  });

  it('本塁の後ろへ下がりすぎない', () => {
    expect(clampFocus({ x: 0, z: 40 }).z).toBe(FOCUS_LIMIT.back);
  });

  it('一塁側・三塁側とも同じだけ動ける（左右で見え方が変わらない）', () => {
    expect(clampFocus({ x: 200, z: 0 }).x).toBe(FOCUS_LIMIT.x);
    expect(clampFocus({ x: -200, z: 0 }).x).toBe(-FOCUS_LIMIT.x);
  });

  it('どの球場の中堅フェンスも画面に入るところまで下がれる（フェーズC-14）', () => {
    // フェンスが画面の外にあると「壁に当たって跳ね返る打球」が見えないまま決着する。
    // 追従点は打球より先へは行かないので、上限を広げても狭い球場の見え方は変わらない。
    const { ahead } = visibleDepth(WIDE);
    for (const park of BALLPARKS) {
      expect(-FOCUS_LIMIT.deep + ahead).toBeGreaterThan(deepestFence(park));
    }
  });

  it('可動範囲いっぱいでも映るのは描かれた地面の内側だけ（背景の空白が映らない）', () => {
    const { ahead, behind } = visibleDepth(WIDE);
    const corners = [
      { x: FOCUS_LIMIT.x + CHICCHAI_VIEW_HALF_WIDTH, z: FOCUS_LIMIT.deep - ahead },
      { x: FOCUS_LIMIT.x + CHICCHAI_VIEW_HALF_WIDTH, z: FOCUS_LIMIT.back + behind },
    ];
    for (const c of corners) {
      expect(Math.hypot(c.x, c.z)).toBeLessThan(GROUND_RADIUS);
    }
  });
});

describe('edgeMarker（画面外の走者を指す印）', () => {
  const margin = 0.06;

  it('画面内なら印は出ない', () => {
    expect(edgeMarker({ x: 0, y: 0, z: 0 }, margin)).toBeNull();
    expect(edgeMarker({ x: 1, y: -1, z: 0.5 }, margin)).toBeNull();
  });

  it('右へ外れたら右端で右を指す', () => {
    const m = edgeMarker({ x: 2, y: 0, z: 0 }, margin)!;
    expect(m.x).toBeCloseTo(0.97, 6);
    expect(m.y).toBeCloseTo(0.5, 6);
    expect(m.angle).toBeCloseTo(0, 6);
  });

  it('奥（画面上）へ外れたら上端で上を指す', () => {
    const m = edgeMarker({ x: 0, y: 3, z: 0 }, margin)!;
    expect(m.x).toBeCloseTo(0.5, 6);
    expect(m.y).toBeCloseTo(0.03, 6);
    // 画面座標は下が+なので、上を指す向きは -π/2
    expect(m.angle).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('斜めに外れたら角に置かれ、斜めを指す', () => {
    const m = edgeMarker({ x: 2, y: 2, z: 0 }, margin)!;
    expect(m.x).toBeCloseTo(0.97, 6);
    expect(m.y).toBeCloseTo(0.03, 6);
    expect(m.angle).toBeCloseTo(-Math.PI / 4, 6);
  });

  it('遠くへ外れても印は画面の中に留まる（端から margin の内側）', () => {
    for (const p of [
      { x: 50, y: 0, z: 0 },
      { x: 0, y: -80, z: 0 },
      { x: -30, y: 12, z: 0 },
    ]) {
      const m = edgeMarker(p, margin)!;
      expect(m.x).toBeGreaterThanOrEqual(margin / 2);
      expect(m.x).toBeLessThanOrEqual(1 - margin / 2);
      expect(m.y).toBeGreaterThanOrEqual(margin / 2);
      expect(m.y).toBeLessThanOrEqual(1 - margin / 2);
    }
  });

  it('カメラの後ろにある走者も正しい向きを指す（座標の反転を戻す）', () => {
    // project() はカメラの後ろの点で x,y の符号が反転し z>1 になる。素通しすると
    // 「本塁の後ろへ抜けた打球を追っているとき、走者の印が真逆を指す」ことになる。
    const m = edgeMarker({ x: 0.5, y: 0.5, z: 1.5 }, margin)!;
    expect(m.x).toBeCloseTo(0.03, 6);
    expect(m.y).toBeCloseTo(0.97, 6);
    expect(m.angle).toBeCloseTo((3 * Math.PI) / 4, 6);
  });

  it('真後ろの一点は向きが決まらないので印を出さない', () => {
    expect(edgeMarker({ x: 0, y: 0, z: 2 }, margin)).toBeNull();
  });
});

describe('でっかいモードの画角は窓の形から（フェーズZZ-74。一・三塁の走者が必ず入る）', () => {
  /** 一・三塁のベースに立つ走者の外側の端の、画面の横の位置（NDC。±1 が画面の端） */
  const runnerEdgeNdc = (aspect: number): number => {
    const edge = { x: BASE_AXIS + DEKKAI_RUNNER_HALF_WIDTH, y: 0.9, z: -BASE_AXIS };
    const tanHalfV = Math.tan((dekkaiFovFor(aspect) / 2) * DEG);
    return edge.x / dekkaiViewDepth(edge) / (tanHalfV * aspect);
  };

  it('どの窓の形でも、一・三塁の走者は画面の横幅に収まる', () => {
    for (const aspect of [21 / 9, 16 / 9, 16 / 10, 1.44, 4 / 3, 5 / 4]) {
      expect(runnerEdgeNdc(aspect)).toBeLessThanOrEqual(1 - DEKKAI_EDGE_MARGIN + 1e-9);
    }
  });

  it('40°より狭くはしない（横に広い窓で寄りすぎない）／16:9 では約6%引くだけ', () => {
    expect(dekkaiFovFor(21 / 9)).toBe(DEKKAI_FOV_DEG);
    const tan16 = Math.tan((dekkaiFovFor(16 / 9) / 2) * DEG);
    const tan40 = Math.tan((DEKKAI_FOV_DEG / 2) * DEG);
    expect(tan40 / tan16).toBeGreaterThan(0.9);
    expect(tan40 / tan16).toBeLessThan(0.96);
  });

  it('細い窓ほど広く映す（横幅が一・三塁ぶん以上あることを優先する）', () => {
    expect(dekkaiFovFor(4 / 3)).toBeGreaterThan(dekkaiFovFor(16 / 9));
  });
});

describe('フォークの落ち方（フェーズBBB-79：Fの大きい投手だけワンバウンド）', () => {
  const over = RELEASE_HEIGHT_OVER;
  const bounce = pitchStallFor(SPEED_SLOW_PITCH, SPEED_NEUTRAL_PITCH, 0.8)!;
  const changeup = (fork: number) => pitchStallFor(SPEED_SLOW_PITCH, SPEED_NEUTRAL_PITCH, fork)!;
  // 描く奥行きは本当の位置とほぼ同じ（打撃面から先は一致する）ので、ここでは同じ z で見る
  const h = (z: number, stall = bounce) => pitchDrawnHeight(z, z, over, stall);

  it('地面に着くのは失速の後・判定の本塁通過（PLATE_Z）より手前＝跳ねてから本塁を通る', () => {
    expect(FORK_BOUNCE_Z).toBeGreaterThan(bounce.fromZ);
    expect(FORK_BOUNCE_Z).toBeLessThan(PLATE_Z_PITCH);
  });

  it('ワンバウンドするフォークは本塁の前で地面に着き（球の下端が地面）、跳ねてミットへ上がる', () => {
    expect(h(FORK_BOUNCE_Z)).toBeCloseTo(FORK_BOUNCE_CENTER_Y, 9);
    // 着く手前は下がり続け、着いた後は上がり続ける
    let prev = Infinity;
    for (let z = bounce.fromZ; z <= FORK_BOUNCE_Z; z += 0.05) {
      expect(h(z)).toBeLessThanOrEqual(prev + 1e-9);
      prev = h(z);
    }
    prev = -Infinity;
    for (let z = FORK_BOUNCE_Z; z <= CATCH_Z; z += 0.05) {
      expect(h(z)).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = h(z);
    }
    expect(h(CATCH_Z)).toBeCloseTo(CATCH_HEIGHT, 9);
    // 着いた瞬間の中心の高さ＝本塁で描く球の半径（下端がちょうど地面）
    expect(FORK_BOUNCE_CENTER_Y).toBeCloseTo(BALL_RADIUS * DEKKAI_BALL_SCALE * DEKKAI_PITCH_SIZE_NEAR, 12);
  });

  it('チェンジアップ（Fが境目より小さい）は膝の高さより上で止まり、地面には着かない', () => {
    for (const fork of [0, 0.38, 0.54, 0.69]) {
      const end = changeupEndHeight(fork);
      expect(end).toBeGreaterThanOrEqual(CHANGEUP_DROP_BOTTOM);
      expect(end).toBeLessThanOrEqual(CHANGEUP_DROP_TOP);
      expect(h(CONTACT_PLANE_Z, changeup(fork))).toBeCloseTo(end, 9);
      expect(h(CATCH_Z, changeup(fork))).toBeCloseTo(end, 9);
    }
    // F が大きいほど深く落ちる
    expect(changeupEndHeight(0.6)).toBeLessThan(changeupEndHeight(0.4));
  });

  it('失速の前・フォークでない球は通り道の直線のまま（これまでと1mmも変わらない）', () => {
    expect(h(bounce.fromZ - 1)).toBeCloseTo(pitchLineHeight(bounce.fromZ - 1, over), 12);
    expect(pitchDrawnHeight(0, 0, over)).toBeCloseTo(pitchLineHeight(0, over), 12);
  });
});
