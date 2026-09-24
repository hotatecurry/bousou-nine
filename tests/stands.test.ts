import { describe, expect, it } from 'vitest';
import {
  FOUL_MARGIN,
  SEAT_BACK_OFFSET,
  SEAT_SURFACE_Y,
  STAND_GAP,
  STAND_RISE,
  STAND_STEP_DEG,
  STAND_TREAD,
  normalizeDeg,
  outerWallDistance,
  ringRow,
  seatSpots,
  standBoundary,
  standFrontDistance,
  standOuterRadius,
  standSurfaceHeight,
  wallBoundary,
} from '../src/core/stands';
import { BALLPARKS, FENCE_ANGLE_LIMIT_DEG, fenceAt } from '../src/core/ballpark';
import { GROUND_RADIUS } from '../src/scenes/field';

const DEG = Math.PI / 180;

/** 本塁から方角 deg・距離 r の点 */
function pointAt(deg: number, r: number): { x: number; z: number } {
  return { x: r * Math.sin(deg * DEG), z: -r * Math.cos(deg * DEG) };
}

/** 点とファウルライン（+45°/-45°の半直線を含む直線）との距離 m */
function distanceToFoulLine(x: number, z: number, sign: number): number {
  // 直線の向き (sin45, -cos45) に対する法線 (cos45, sin45) との内積
  return Math.abs(sign * x * Math.SQRT1_2 + z * Math.SQRT1_2);
}

describe('normalizeDeg（外周は全方位にある）', () => {
  it('-180..180 に丸める', () => {
    expect(normalizeDeg(0)).toBe(0);
    expect(normalizeDeg(190)).toBeCloseTo(-170, 10);
    expect(normalizeDeg(-190)).toBeCloseTo(170, 10);
    expect(normalizeDeg(360)).toBeCloseTo(0, 10);
  });
});

describe('outerWallDistance（外周の壁）', () => {
  it('外野（±45°以内）はフェンスそのもの＝判定と同じ数値から起きる', () => {
    for (const park of BALLPARKS) {
      for (const deg of [-45, -30, -12, 0, 15, 30, 45]) {
        const fence = fenceAt(park, deg).distance;
        const lucky = park.luckyZone;
        const extra = lucky && Math.abs(deg) >= lucky.fromDeg ? lucky.outerOffset : 0;
        expect(outerWallDistance(park, deg)).toBeCloseTo(fence + extra, 9);
      }
    }
  });

  it('たからづかだけ、ラッキーゾーンの区間は外壁のぶん外へ出る', () => {
    const takarazuka = BALLPARKS.find((p) => p.id === 'takarazuka')!;
    expect(outerWallDistance(takarazuka, 30)).toBeCloseTo(
      fenceAt(takarazuka, 30).distance + 9,
      9,
    );
    // 中堅寄り（ラッキーゾーンの外）はフェンスのまま
    expect(outerWallDistance(takarazuka, 0)).toBeCloseTo(fenceAt(takarazuka, 0).distance, 9);
  });

  it('ファウル地域はファウルラインに平行な直線になる（線からの距離が一定）', () => {
    for (const park of BALLPARKS) {
      for (const sign of [1, -1]) {
        for (const a of [70, 90, 110, 130]) {
          const deg = sign * a;
          const r = outerWallDistance(park, deg);
          const p = pointAt(deg, r);
          expect(distanceToFoulLine(p.x, p.z, sign)).toBeCloseTo(FOUL_MARGIN, 6);
        }
      }
    }
  });

  it('本塁の裏は2本の直線が交わる角＝FOUL_MARGIN·√2', () => {
    for (const park of BALLPARKS) {
      expect(outerWallDistance(park, 180)).toBeCloseTo(FOUL_MARGIN * Math.SQRT2, 6);
      expect(outerWallDistance(park, -180)).toBeCloseTo(FOUL_MARGIN * Math.SQRT2, 6);
    }
  });

  it('ファウルポールのすぐ外側は両翼のフェンスで頭打ちになる（外周が途切れない）', () => {
    for (const park of BALLPARKS) {
      const wing = outerWallDistance(park, FENCE_ANGLE_LIMIT_DEG);
      expect(outerWallDistance(park, 46)).toBeCloseTo(wing, 9);
      // 両翼線をまたいで連続している（段差ができない）
      expect(outerWallDistance(park, 45.001)).toBeCloseTo(wing, 6);
    }
  });
});

describe('スタンドは打球の当たる壁より内側に入らない（C-14の不変条件の延長）', () => {
  it('6球場すべてで、最前列がフェンスより外にある', () => {
    for (const park of BALLPARKS) {
      for (let deg = -FENCE_ANGLE_LIMIT_DEG; deg <= FENCE_ANGLE_LIMIT_DEG; deg += 0.5) {
        expect(standFrontDistance(park, deg)).toBeGreaterThanOrEqual(
          fenceAt(park, deg).distance + STAND_GAP,
        );
      }
    }
  });

  it('ふえいふえいの例外区間でも、スタンドがフェンスに付いていく', () => {
    const fueifuei = BALLPARKS.find((p) => p.id === 'fueifuei')!;
    // -40..-12 だけフェンスが 6m 深い区間（そのぶんレフトのHRが至難になる）
    const inside = standFrontDistance(fueifuei, -30) - fenceAt(fueifuei, -30).distance;
    const outside = standFrontDistance(fueifuei, 30) - fenceAt(fueifuei, 30).distance;
    expect(inside).toBeCloseTo(STAND_GAP, 9);
    expect(outside).toBeCloseTo(STAND_GAP, 9);
    // フェンスが深いぶんスタンドも下がる＝左右非対称が見た目にも出る
    expect(standFrontDistance(fueifuei, -30) - standFrontDistance(fueifuei, 30)).toBeCloseTo(6, 6);
  });

  it('スタンドはプレーする場所に入り込まない（本塁・各塁から十分に離れている）', () => {
    // 本塁(0,0)・一塁(19.4,-19.4)・三塁(-19.4,-19.4)・二塁(0,-38.8) あたり
    const spots = [
      { x: 0, z: 0 },
      { x: 19.4, z: -19.4 },
      { x: -19.4, z: -19.4 },
      { x: 0, z: -38.8 },
    ];
    for (const park of BALLPARKS) {
      const boundary = wallBoundary(park);
      for (const spot of spots) {
        for (const v of boundary) {
          expect(Math.hypot(v.x - spot.x, v.z - spot.z)).toBeGreaterThan(15);
        }
      }
    }
  });
});

describe('ringRow（段の積み方）', () => {
  it('段が上がるほど外へ・上へ動く', () => {
    const park = BALLPARKS[0];
    const boundary = standBoundary(park);
    const row0 = ringRow(boundary, 0);
    const row5 = ringRow(boundary, 5);
    expect(row5).toHaveLength(row0.length);
    for (let i = 0; i < row0.length; i += 1) {
      expect(row5[i].y - row0[i].y).toBeCloseTo(5 * STAND_RISE, 9);
      // 外へ動く（本塁から遠ざかる）
      expect(Math.hypot(row5[i].x, row5[i].z)).toBeGreaterThan(
        Math.hypot(row0[i].x, row0[i].z),
      );
      // 動く量は段数×奥行きを**超えない**（法線に沿って積むので、外周が折れる角では
      // 2つの法線の平均になり、そのぶん短くなる＝重なりはしても離れはしない）
      const moved = Math.hypot(row5[i].x - row0[i].x, row5[i].z - row0[i].z);
      expect(moved).toBeLessThanOrEqual(5 * STAND_TREAD + 1e-9);
      expect(moved).toBeGreaterThan(5 * STAND_TREAD * 0.6);
    }
  });

  it('外野（滑らかな円弧の側）では、段の間隔がほぼ STAND_TREAD になる', () => {
    // 折れ目のない区間では法線がほぼ揃うので、段の間隔は奥行きそのものに近づく
    // （ぴったりにならないのは、フェンスの円弧の中心が本塁からずれていて、
    //   4°きざみの区画のあいだで法線がわずかに向きを変えるため）。
    const boundary = standBoundary(BALLPARKS[0]);
    const row0 = ringRow(boundary, 0);
    const row1 = ringRow(boundary, 1);
    for (let i = 0; i < row0.length; i += 1) {
      if (Math.abs(row0[i].deg) > 30) continue; // 両翼線の折れ目から離れた区間だけ見る
      const moved = Math.hypot(row1[i].x - row0[i].x, row1[i].z - row0[i].z);
      expect(moved).toBeCloseTo(STAND_TREAD, 2);
    }
  });

  it('区画は 360° を STAND_STEP_DEG で割った数だけあり、隣どうしが隙間なくつながる', () => {
    const park = BALLPARKS.find((p) => p.id === 'doumu')!;
    const boundary = standBoundary(park);
    expect(boundary).toHaveLength(360 / STAND_STEP_DEG);
    for (const row of [0, 7, 17]) {
      const segments = ringRow(boundary, row);
      for (let k = 0; k < segments.length; k += 1) {
        const a = segments[k];
        const b = segments[(k + 1) % segments.length];
        // 区画 a の右端と区画 b の左端が同じ点＝継ぎ目に隙間も重なりも無い
        const aEnd = {
          x: a.x + Math.cos(a.yaw) * (a.width / 2),
          z: a.z - Math.sin(a.yaw) * (a.width / 2),
        };
        const bStart = {
          x: b.x - Math.cos(b.yaw) * (b.width / 2),
          z: b.z + Math.sin(b.yaw) * (b.width / 2),
        };
        expect(Math.hypot(aEnd.x - bStart.x, aEnd.z - bStart.z)).toBeCloseTo(0, 6);
      }
    }
  });

  it('ヨーは +Z がフィールド側を向く（部品の正面と一致する）', () => {
    const park = BALLPARKS[0];
    for (const segment of ringRow(standBoundary(park), 3)) {
      // rotation.y = yaw のとき +Z は (sin yaw, cos yaw) を向く
      const fx = Math.sin(segment.yaw);
      const fz = Math.cos(segment.yaw);
      // その向きへ進むと本塁に近づく＝フィールド側を向いている
      const here = Math.hypot(segment.x, segment.z);
      const ahead = Math.hypot(segment.x + fx, segment.z + fz);
      expect(ahead).toBeLessThan(here);
    }
  });

  it('区画の中央の方角で外野とファウル地域を選り分けられる', () => {
    const segments = ringRow(standBoundary(BALLPARKS[0]), 0);
    const outfield = segments.filter((s) => Math.abs(s.deg) <= FENCE_ANGLE_LIMIT_DEG);
    const foul = segments.filter((s) => Math.abs(s.deg) > FENCE_ANGLE_LIMIT_DEG);
    expect(outfield.length + foul.length).toBe(segments.length);
    expect(outfield.length).toBeGreaterThan(0);
    expect(foul.length).toBeGreaterThan(0);
  });
});

describe('seatSpots（観客の並び）', () => {
  it('区画の幅の中に等間隔で並び、はみ出さない', () => {
    const segment = ringRow(standBoundary(BALLPARKS[0]), 4)[0];
    const spots = seatSpots(segment, 0.9);
    expect(spots.length).toBeGreaterThan(1);
    for (const spot of spots) {
      // 区画の中心からの距離（座席の奥行きぶんを除く）が幅の半分以内
      const dx = spot.x - segment.x;
      const dz = spot.z - segment.z;
      const along = dx * Math.cos(segment.yaw) - dz * Math.sin(segment.yaw);
      expect(Math.abs(along)).toBeLessThanOrEqual(segment.width / 2);
    }
  });

  it('高さは段の底面＋座面、位置は段の前端より奥', () => {
    const segment = ringRow(standBoundary(BALLPARKS[0]), 6)[10];
    for (const spot of seatSpots(segment)) {
      expect(spot.y).toBeCloseTo(segment.y + SEAT_SURFACE_Y, 9);
      // フィールド向き（+Z）に対して SEAT_BACK_OFFSET だけ後ろにいる
      const back =
        -((spot.x - segment.x) * Math.sin(segment.yaw) +
          (spot.z - segment.z) * Math.cos(segment.yaw));
      expect(back).toBeCloseTo(SEAT_BACK_OFFSET, 9);
    }
  });

  it('幅がどれだけ狭くても1人は座る（空の区画を作らない）', () => {
    expect(seatSpots({ x: 0, y: 0, z: -100, yaw: 0, width: 0.2, deg: 0 })).toHaveLength(1);
  });
});

describe('スタンドは描かれた地面の内側に収まる', () => {
  it('6球場すべてで、最後列の背面が GROUND_RADIUS を超えない', () => {
    // 実装の最大段数（どうむの18段）に、照明塔・スコアボードの控え（5m）を足しても収まること
    for (const park of BALLPARKS) {
      expect(standOuterRadius(park, 18) + 5).toBeLessThan(GROUND_RADIUS);
    }
  });
});

describe('standSurfaceHeight（観客席に落ちた球が止まる面。見た目だけ）', () => {
  const park = BALLPARKS.find((p) => p.id === 'tokorozawa')!;
  const rows = 14;

  it('フェンスの内側と通路は地面', () => {
    for (const deg of [-40, 0, 40, -80, 80, 180]) {
      const p = pointAt(deg, outerWallDistance(park, deg) - 1);
      expect(standSurfaceHeight(park, rows, p.x, p.z)).toBe(0);
      const gap = pointAt(deg, outerWallDistance(park, deg) + STAND_GAP / 2);
      expect(standSurfaceHeight(park, rows, gap.x, gap.z)).toBe(0);
    }
  });

  it('スタンドはその段の上面（段ごとに1段ぶん上がる）＝外野もファウル地域も', () => {
    for (const deg of [0, 30, -70, 120]) {
      const front = standFrontDistance(park, deg);
      for (const row of [0, 5, rows - 1]) {
        const p = pointAt(deg, front + (row + 0.5) * STAND_TREAD);
        expect(standSurfaceHeight(park, rows, p.x, p.z)).toBeCloseTo((row + 1) * STAND_RISE, 6);
      }
    }
  });

  it('最上段より後ろ（スタンドの外）は地面', () => {
    const p = pointAt(0, standFrontDistance(park, 0) + (rows + 2) * STAND_TREAD);
    expect(standSurfaceHeight(park, rows, p.x, p.z)).toBe(0);
  });
});
