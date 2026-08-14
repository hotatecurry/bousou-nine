import { describe, expect, it } from 'vitest';
import {
  CAMERA_FOLLOW_TAU,
  CHICCHAI_FOV_DEG,
  CHICCHAI_TILT_DEG,
  CHICCHAI_VIEW_HALF_WIDTH,
  FOCUS_LIMIT,
  cameraDistance,
  cameraOffset,
  clampFocus,
  edgeMarker,
  followFocus,
} from '../src/core/camera';
import { BALLPARKS, deepestFence } from '../src/core/ballpark';
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
