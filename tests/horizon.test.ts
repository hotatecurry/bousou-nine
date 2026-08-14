import { describe, expect, it } from 'vitest';
import {
  FAR_GROUND_INNER_RATIO,
  FAR_GROUND_RADIUS,
  SKYLINE_MARGIN,
  SKY_RADIUS,
  SKY_SKIRT_DEG,
  skylineBaseRadius,
  skylineHash,
  skylinePlan,
  skylineSpots,
  wrapWidth,
} from '../src/core/horizon';
import { BALLPARKS, deepestFence } from '../src/core/ballpark';
import { standOuterRadius } from '../src/core/stands';
import { GROUND_RADIUS, SKYLINE_STYLE, STAND_STYLE } from '../src/scenes/field';
import { DEKKAI_CAMERA_FAR } from '../src/scenes/dekkaiScene';

/** でっかいモードのカメラは本塁の後ろ（CATCH_Z+8＝約10m）に置かれる */
const DEKKAI_CAMERA_Z = 10.2;

describe('空と遠景の大きさ（世界の端を消すための条件）', () => {
  it('ドームも遠景の地面もカメラの far の内側に収まる（手前で切れて背景色が覗かない）', () => {
    expect(SKY_RADIUS + DEKKAI_CAMERA_Z).toBeLessThan(DEKKAI_CAMERA_FAR);
    expect(FAR_GROUND_RADIUS + DEKKAI_CAMERA_Z).toBeLessThan(DEKKAI_CAMERA_FAR);
  });

  it('遠景の地面はドームより外まで敷いてある（カメラが高いときに先に尽きない）', () => {
    expect(FAR_GROUND_RADIUS).toBeGreaterThanOrEqual(SKY_RADIUS);
  });

  it('遠景の地面の穴が既存の地面より内側にある＝2枚が重なって継ぎ目ができない', () => {
    expect(FAR_GROUND_RADIUS * FAR_GROUND_INNER_RATIO).toBeLessThan(GROUND_RADIUS);
  });

  it('ドームの縁が水平線より下にある＝地面と空の接点に背景色のすきまが出ない', () => {
    // カメラ（高さ4.5m）から見た地平線は atan(4.5 / SKY_RADIUS) ≒ 0.61°。
    // ドームの縁（-4°）はそれより下なので、接点の手前でドームが途切れることはない。
    const horizonDeg = (Math.atan(4.5 / SKY_RADIUS) * 180) / Math.PI;
    expect(SKY_SKIRT_DEG).toBeGreaterThan(horizonDeg);
  });
});

describe('skylineSpots（遠景の置き場所）', () => {
  it('乱数を使わない＝何度呼んでも同じ場所になる', () => {
    const a = skylineSpots(200, 12, { spread: 30, salt: 2 });
    const b = skylineSpots(200, 12, { spread: 30, salt: 2 });
    expect(a).toEqual(b);
    // 散らしは連番から決まる（同じ添字なら必ず同じ値）
    expect(skylineHash(7, 3)).toBe(skylineHash(7, 3));
    expect(skylineHash(7, 3)).not.toBe(skylineHash(8, 3));
  });

  it('散らしは 0..1 に収まる', () => {
    for (let i = 0; i < 200; i += 1) {
      const h = skylineHash(i, i % 5);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
    }
  });

  it('全周に散らしても距離は基準以上・散らしの幅以内に収まる', () => {
    for (const spot of skylineSpots(180, 24, { offset: 10, spread: 40 })) {
      expect(spot.radius).toBeGreaterThanOrEqual(190);
      expect(spot.radius).toBeLessThanOrEqual(230);
      expect(Math.hypot(spot.x, spot.z)).toBeCloseTo(spot.radius, 9);
    }
  });

  it('方角の範囲を指定すればその中だけに並ぶ（散らしも入らない）', () => {
    const spots = skylineSpots(180, 5, { fromDeg: -60, toDeg: -20 });
    for (const spot of spots) {
      expect(spot.deg).toBeGreaterThanOrEqual(-60);
      expect(spot.deg).toBeLessThanOrEqual(-20);
    }
    // 1つだけのときは範囲の中央に置く（鉄橋のように「そこに1本」置きたいもの）
    expect(skylineSpots(180, 1, { fromDeg: -34, toDeg: -34 })[0].deg).toBeCloseTo(-34, 9);
  });

  it('ヨーは +Z がフィールド側を向く（部品の正面と一致する＝スタンドと同じ約束）', () => {
    for (const spot of skylineSpots(200, 16, { spread: 20 })) {
      const fx = Math.sin(spot.yaw);
      const fz = Math.cos(spot.yaw);
      // その向きへ1m進むと本塁に近づく
      expect(Math.hypot(spot.x + fx, spot.z + fz)).toBeLessThan(Math.hypot(spot.x, spot.z));
    }
  });

  it('個数が0なら何も置かない（屋内の球場で空配列を渡せる）', () => {
    expect(skylineSpots(200, 0)).toEqual([]);
  });
});

describe('wrapWidth（山並みが途切れない幅）', () => {
  it('全部つないだ幅が円周を超える＝切れ目が見えない', () => {
    for (const [radius, count] of [
      [200, 9],
      [240, 11],
      [300, 8],
    ] as const) {
      expect(wrapWidth(radius, count) * count).toBeGreaterThan(2 * Math.PI * radius);
    }
  });
});

describe('遠景はスタンドの外・空の内に立つ（6球場すべて）', () => {
  it('基準の距離がスタンドの最後列より外にある', () => {
    for (const park of BALLPARKS) {
      const rows = STAND_STYLE[park.id].rows;
      expect(skylineBaseRadius(park, rows)).toBeCloseTo(
        standOuterRadius(park, rows) + SKYLINE_MARGIN,
        9,
      );
      expect(skylineBaseRadius(park, rows)).toBeGreaterThan(standOuterRadius(park, rows));
    }
  });

  it('段数が多い球場ほど遠景が外へ下がる（スタンドに埋もれない）', () => {
    const park = BALLPARKS[0];
    expect(skylineBaseRadius(park, 18)).toBeGreaterThan(skylineBaseRadius(park, 6));
  });

  it('実際に置かれる遠景が、スタンドの外・ドームの内・遠景の地面の上に収まる', () => {
    for (const park of BALLPARKS) {
      const rows = STAND_STYLE[park.id].rows;
      const base = skylineBaseRadius(park, rows);
      for (const entry of SKYLINE_STYLE[park.id]) {
        const plan = skylinePlan(base, entry);
        expect(plan).toHaveLength(entry.count);
        for (const p of plan) {
          // スタンドより外（＝観客席に木が生えたりしない）
          expect(p.radius).toBeGreaterThanOrEqual(base - 1e-9);
          // 空のドームの内側に立つ（外へ出ると空を突き抜ける）
          expect(p.radius).toBeLessThan(SKY_RADIUS);
          // 幅・奥行きを含めても、描かれた遠景の地面からはみ出して宙に浮かない。
          // 部品は「幅＝接線方向・奥行き＝半径方向」に置かれるので、いちばん遠い点は角
          expect(Math.hypot(p.radius + p.depth / 2, p.width / 2)).toBeLessThan(FAR_GROUND_RADIUS);
          expect(p.width).toBeGreaterThan(0);
          expect(p.height).toBeGreaterThan(0);
        }
      }
    }
  });

  it('遠景はプレーする場所（フェンスの内側）に入り込まない', () => {
    for (const park of BALLPARKS) {
      const rows = STAND_STYLE[park.id].rows;
      const base = skylineBaseRadius(park, rows);
      for (const entry of SKYLINE_STYLE[park.id]) {
        for (const p of skylinePlan(base, entry)) {
          // 本塁にいちばん近づくのは半径方向の手前の面（幅は接線方向なので遠ざかるだけ）
          expect(p.radius - p.depth / 2).toBeGreaterThan(deepestFence(park));
        }
      }
    }
  });

  it('高さと幅は同じ散らしから決まる＝縦横の比率が崩れた個体が出ない', () => {
    const plan = skylinePlan(200, {
      count: 8,
      height: [10, 20],
      width: [10, 20],
      depthRatio: 1,
    });
    for (const p of plan) expect(p.width).toBeCloseTo(p.height, 9);
  });
});

describe('球場ごとの遠景の表', () => {
  it('屋内のどうむだけ遠景を持たない（空のドームがそのまま天井になる）', () => {
    expect(SKYLINE_STYLE.doumu).toHaveLength(0);
    for (const park of BALLPARKS) {
      if (park.id === 'doumu') continue;
      expect(SKYLINE_STYLE[park.id].length).toBeGreaterThan(0);
    }
  });

  it('球場ごとに違う顔ぶれになっている（どの球場かがひと目で分かる、の条件）', () => {
    const faces = new Map<string, string>();
    for (const park of BALLPARKS) {
      const key = SKYLINE_STYLE[park.id]
        .map((e) => e.part)
        .sort()
        .join('+');
      faces.set(park.id, key);
    }
    // 河川敷だけが鉄橋、山あいと大草原だけが山並み
    expect(faces.get('kasenjiki')).toContain('FarBridge');
    expect(faces.get('takarazuka')).toContain('FarRidge');
    expect(faces.get('daisougen')).toContain('FarRidge');
    expect(faces.get('tokorozawa')).not.toContain('FarRidge');
    expect(faces.get('fueifuei')).not.toContain('FarRidge');
    // 6球場の顔ぶれが全部同じ、ということが無い
    expect(new Set(faces.values()).size).toBeGreaterThan(2);
  });
});
