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
  DEKKAI_FOV_DEG,
  DEKKAI_TRAIL_FRAME_SEC,
  FOCUS_LIMIT,
  cameraDistance,
  cameraOffset,
  clampFocus,
  dekkaiBallLook,
  dekkaiBallScale,
  dekkaiScreenMotionAxis,
  dekkaiViewDepth,
  edgeMarker,
  followFocus,
  pitchArcPath,
} from '../src/core/camera';
import { BALLPARKS, deepestFence } from '../src/core/ballpark';
import { CATCH_RADIUS } from '../src/core/fielding';
import {
  CATCH_HEIGHT,
  CATCH_Z,
  NEUTRAL_PITCH_ARM,
  PITCHER_PLATE_Z,
  PLATE_Z,
  RELEASE_Z,
  SPEED_FAST_DELTA,
  SPEED_SLOW_DELTA,
  STRIKE_ZONE_HALF_WIDTH,
  armReleaseHeight,
  neutralSpeedFor,
  pitchFastness,
  pitchSlowness,
} from '../src/core/pitch';
import { TEAMS, pitcherRowPitching } from '../src/core/teams';
import { GROUND_RADIUS } from '../src/scenes/field';

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
  /** 奥行き d にある 1m が画面で何pxになるか（でっかいモードの垂直画角から） */
  const dekkaiPpm = (d: number, screenH = 720) =>
    screenH / (2 * d * Math.tan((DEKKAI_FOV_DEG / 2) * DEG));
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
    // MM-60 自身の読み取り条件（いちばん低い解像度で5px以上離れる）は球の大きさに
    // 依らない＝こちらは球をいくら大きくしても壊れない
    expect(step * dekkaiPpm(depth(releasePoint), 600)).toBeGreaterThan(5);
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

  it('カメラは1つも動かしていない（映る範囲・画角・置き場所）', () => {
    expect(DEKKAI_FOV_DEG).toBe(40);
    expect(DEKKAI_CAMERA_POS).toEqual({ x: 0, y: 4.5, z: CATCH_Z + 8 });
    expect(DEKKAI_CAMERA_LOOK_AT).toEqual({ x: 0, y: 1.5, z: PITCHER_PLATE_Z });
  });
});

describe('投球の見え方：弧と残像（フェーズPP-63。`npm run balance:flight` で測った帯）', () => {
  const dekkaiPpm = (d: number, screenH = 720) =>
    screenH / (2 * d * Math.tan((DEKKAI_FOV_DEG / 2) * DEG));
  const span = CATCH_Z - RELEASE_Z;
  const over = armReleaseHeight(NEUTRAL_PITCH_ARM);
  /** 基準の投手（SPD0.5）の緩急3段階 */
  const neutral = neutralSpeedFor();
  const fork = neutral - SPEED_SLOW_DELTA;
  const fast = neutral + SPEED_FAST_DELTA;
  /** 弧を含んだ高さ（呼び出し側＝dekkaiScene と同じ渡し方） */
  const heightAt = (z: number, vz: number, from = over) =>
    pitchArcPath(z, vz, from, pitchSlowness(vz, neutral)).y;
  /** その z を通るときの見た目（残像込み） */
  const lookAt = (z: number, vz: number) => {
    const path = pitchArcPath(z, vz, over, pitchSlowness(vz, neutral));
    return dekkaiBallLook(
      { x: 0, y: path.y, z },
      { x: 0, y: path.slope * vz, z: vz },
      pitchFastness(vz, neutral),
    );
  };

  it('どの球速・どの腕でも、球はリリースの高さから出てミットの高さで終わる', () => {
    // 旧実装は直線から引き算していたので、いちばん遅い球は本塁の2.4m手前で y<0 に入り
    // NN-61 が置いた地面の下限で止まっていた（＝ミットの下を通って到着していた）。
    for (const slot of ['over', 'side', 'under'] as const) {
      const from = armReleaseHeight({ side: 1, slot });
      for (const vz of [16, fork, neutral, fast, 48]) {
        expect(heightAt(RELEASE_Z, vz, from)).toBeCloseTo(from, 9);
        expect(heightAt(CATCH_Z, vz, from)).toBeCloseTo(CATCH_HEIGHT, 9);
      }
    }
  });

  it('球は地面より上を通る＝地面の下限は構造的に要らない', () => {
    for (const vz of [16, fork, neutral, fast]) {
      for (let z = RELEASE_Z; z <= CATCH_Z; z += 0.05) {
        expect(heightAt(z, vz)).toBeGreaterThan(BALL_RADIUS);
      }
    }
  });

  it('基準速以上の球は弧なし＝PP-63の前と完全に同じ直線（基準線を動かさない）', () => {
    for (const vz of [neutral, neutral + 1, fast, 48]) {
      for (let z = RELEASE_Z; z <= CATCH_Z; z += 0.05) {
        const straight = over + (CATCH_HEIGHT - over) * ((z - RELEASE_Z) / span);
        expect(heightAt(z, vz)).toBeCloseTo(straight, 9);
      }
    }
  });

  it('遅い球は「スイングを決める時点」にはもう下っている（P-37と同じ基準）', () => {
    // 頂点を過ぎていること＝見てから振る打者に「上へ変化した」と読ませない。
    for (const vz of [16, fork]) {
      const tPlate = (PLATE_Z - RELEASE_Z) / vz;
      const zDecide = RELEASE_Z + vz * (tPlate - 0.25);
      const path = pitchArcPath(zDecide, vz, over, pitchSlowness(vz, neutral));
      expect(path.slope).toBeLessThan(0);
      // しかも落差が球の直径より大きい＝画面で読める（720p で 52px 以上）
      const dropPx =
        (heightAt(zDecide, vz) - heightAt(PLATE_Z, vz)) *
        dekkaiPpm(dekkaiViewDepth(DEKKAI_BALL_ANCHOR));
      expect(dropPx).toBeGreaterThan(2 * BALL_RADIUS * DEKKAI_BALL_SCALE * dekkaiPpm(dekkaiViewDepth(DEKKAI_BALL_ANCHOR)));
    }
  });

  it('名鑑96人のフォークは、打者の手元でリリースより高くならない（超過は3cm未満）', () => {
    // 弧は飛行時間の2乗で効くので、球速の遅い投手ほど大きく膨らむ。実際の重力（9.8）で
    // 名鑑の下端（SPD0.35）でも超過は 21mm＝720pで2px＝画面では読めない大きさに収まる。
    let worst = 0;
    for (const team of TEAMS) {
      for (const r of team.pitchers) {
        const p = pitcherRowPitching(r);
        const n = neutralSpeedFor(p.speed);
        const vz = n - SPEED_SLOW_DELTA;
        const y = pitchArcPath(PLATE_Z, vz, over, pitchSlowness(vz, n)).y;
        worst = Math.max(worst, y - over);
      }
    }
    expect(worst).toBeLessThan(0.03);
  });

  it('残像は画面上の進行方向（＝視線に垂直）へ伸びる。ワールドZではない', () => {
    const axis = dekkaiScreenMotionAxis({ x: 0, y: -1, z: 40 });
    expect(axis).not.toBeNull();
    // 視線に垂直＝奥行きを1mmも動かさない向き（旧実装のZ方向は9割が視線に沿っていた）
    const zero = dekkaiViewDepth({ x: 0, y: 0, z: 0 });
    const along = dekkaiViewDepth(axis!) - zero;
    expect(Math.abs(along)).toBeLessThan(1e-9);
    // このカメラでは球の動きはほぼ画面の縦＝下向き
    expect(axis!.y).toBeLessThan(-0.9);
  });

  it('残像は後ろへ伸びる（先端は実際の位置＝見た目が判定より先に行かない）', () => {
    const look = lookAt(PLATE_Z, fast);
    expect(look.trail).toBeGreaterThan(0);
    const axis = look.axis!;
    const drawnRadius = BALL_RADIUS * look.scale;
    // 伸びた球の前端（中心＋半径×(1+trail)）が、伸ばす前の前端と同じところにある
    const front = look.center.y + axis.y * drawnRadius * (1 + look.trail);
    const truth = heightAt(PLATE_Z, fast) + axis.y * drawnRadius;
    expect(front).toBeCloseTo(truth, 9);
  });

  it('基準速以下の球には残像が出ない（こちらも基準線を動かさない）', () => {
    for (const vz of [16, fork, neutral]) {
      const look = lookAt(PLATE_Z, vz);
      expect(look.trail).toBe(0);
      expect(look.axis).toBeNull();
      expect(look.center).toEqual({ x: 0, y: heightAt(PLATE_Z, vz), z: PLATE_Z });
    }
  });

  it('残像の長さは「1フレームで画面上に動く距離」＝新しい数値を持ち込まない', () => {
    const look = lookAt(PLATE_Z, fast);
    const path = pitchArcPath(PLATE_Z, fast, over, pitchSlowness(fast, neutral));
    const vel = { x: 0, y: path.slope * fast, z: fast };
    const axis = dekkaiScreenMotionAxis(vel)!;
    const screenSpeed = vel.x * axis.x + vel.y * axis.y + vel.z * axis.z;
    const drawnDiameter = 2 * BALL_RADIUS * look.scale;
    expect(look.trail).toBeCloseTo(
      (pitchFastness(fast, neutral) * screenSpeed * DEKKAI_TRAIL_FRAME_SEC) / drawnDiameter,
      9,
    );
    // 近づくほど画面上の動きが速くなるので残像も伸びる
    expect(lookAt(PLATE_Z, fast).trail).toBeGreaterThan(lookAt(RELEASE_Z + 1, fast).trail);
  });

  it('見かけの大きさ（NN-61）は1つも動いていない', () => {
    // 弧で球が視線から外れても、拡大率は奥行きから決まるので飛行中ずっと同じ大きさ。
    const diameterAt = (z: number, vz: number) => {
      const look = lookAt(z, vz);
      const p = { x: 0, y: heightAt(z, vz), z };
      return 2 * BALL_RADIUS * look.scale * dekkaiPpm(dekkaiViewDepth(p));
    };
    for (const z of [RELEASE_Z, -12, -6, PLATE_Z, CATCH_Z]) {
      expect(diameterAt(z, fork)).toBeCloseTo(diameterAt(PLATE_Z, fork), 6);
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
