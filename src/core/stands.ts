/**
 * スタンド（観客席）の配置計算（フェーズE-25-(d)）。
 *
 * ここには**Three.jsに依存しない計算だけ**を置く（core/camera.ts と同じ立て方）。
 * 部品そのものは `entities/stadium.ts` が glTF から供給し、実際に並べるのは
 * `scenes/field.ts`。
 *
 * 設計の要点：
 * - **外周は `fenceAt` から起こす**＝C-14の不変条件（見えている壁と当たる壁が同じ数値から
 *   起きる）を、フェンスの外側に建つものまで延長する。**球場ごとの形をここに書かない**ので、
 *   球場を足すときに書くのは従来どおり説明書の2つの数値（センター・両翼）だけで済む。
 * - **外周の形は実在の球場と同じ3部構成**：外野は**フェンスそのもの**（±45°）、ファウル地域は
 *   **ファウルラインに平行な直線**、本塁の裏はその2本が交わる角。直線は「ラインから
 *   `FOUL_MARGIN` だけ外側」という1つの条件から極座標で解けるので（`r = FOUL_MARGIN /
 *   sin(|θ|-45°)`）、外野の円弧と同じ「方角→距離」の関数のまま扱える。
 * - **1区画＝1段**（`assets-src/stadium.blend` の StandSection がその1段）。段数を球場ごとに
 *   変えられるので、かせんじきの河川敷らしい低いスタンドも どうむ の大きなスタンドも
 *   同じ部品1つで書ける。
 * - **段は頂点ごとの外向き法線に沿って積む**。法線を隣り合う区画で共有するので、
 *   後ろの段ほど外周が長くなる曲線部でも**区画のあいだに隙間ができない**
 *   （区画ごとに幅を計算し直すため）。
 */
import { type Ballpark, FENCE_ANGLE_LIMIT_DEG, fenceAt } from './ballpark';

const DEG = Math.PI / 180;

/** 段の奥行き m（`assets-src/stadium.blend` の StandSection と一致させる） */
export const STAND_TREAD = 1.0;
/** 段の高さ m（同上） */
export const STAND_RISE = 0.55;
/** 座席の座面の高さ m（その段の底面から）＝観客を置く高さ */
export const SEAT_SURFACE_Y = STAND_RISE + 0.4;
/** 座席が段の前端からどれだけ奥にあるか m（観客の前後位置） */
export const SEAT_BACK_OFFSET = 0.3;

/** 壁とスタンド最前列のすきま m（通路） */
export const STAND_GAP = 1.5;

/**
 * ファウル地域のスタンドがファウルラインから離れている距離 m。
 * **本塁の裏のスタンドまでの距離もこの1つから決まる**（左右のファウルラインを外側へ
 * `FOUL_MARGIN` ずらした2本の直線が本塁の裏で交わる＝`FOUL_MARGIN·√2` ≈ 22.6m）。
 */
export const FOUL_MARGIN = 16;

/** スタンドを何度きざみの区画に割るか（360÷この値が1段あたりの区画数） */
export const STAND_STEP_DEG = 4;

/** 観客どうしの間隔 m（区画の幅をこれで割った数だけ座る） */
export const SPECTATOR_SPACING = 0.9;

/** 方角を -180..180 に丸める（外周は全方位にあるので `clampAngleDeg` は使えない） */
export function normalizeDeg(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/**
 * その方角の**いちばん外側の壁**までの距離 m。外野（±45°以内）はフェンス（たからづかは
 * ラッキーゾーンの外壁）、それより外はファウルラインに平行な直線で、**両翼の距離で
 * 頭打ちにする**＝ファウルポールのすぐ外側では外野フェンスがそのまま外周になる。
 *
 * 打球判定には一切使わない（判定は従来どおり `fenceAt` だけを見る）。ここが使うのは
 * `fenceAt` の**返り値のほう**なので、フェンスを動かせばスタンドも一緒に動く。
 */
export function outerWallDistance(park: Ballpark, deg: number): number {
  const d = normalizeDeg(deg);
  const a = Math.abs(d);
  if (a <= FENCE_ANGLE_LIMIT_DEG) {
    const base = fenceAt(park, d).distance;
    const lucky = park.luckyZone;
    return lucky && a >= lucky.fromDeg ? base + lucky.outerOffset : base;
  }
  const cap = outerWallDistance(park, d >= 0 ? FENCE_ANGLE_LIMIT_DEG : -FENCE_ANGLE_LIMIT_DEG);
  const line = FOUL_MARGIN / Math.sin((a - FENCE_ANGLE_LIMIT_DEG) * DEG);
  return Math.min(cap, line);
}

/**
 * 野手が壁からどれだけ手前で止まるか m（フェーズBBB-77）。体の厚み＋ちっちゃいモードで
 * 2.5倍に描くぶん（LL-59）が壁にめり込んで見えない程度。
 */
export const FIELDER_WALL_MARGIN = 1;

/**
 * 野手（と、こぼれた球）を**その球場の壁の内側**へ丸める（フェーズBBB-77。テストプレイ
 * 「守りの時に、フェンスのかなり手前でブロックされたようになる」）。
 *
 * それまでは**本塁から半径98mの円**で止めていた＝フェンスが半径100mの円1つだった頃（C-14の
 * 前）の名残で、中堅のフェンス（ところざわ120m・だいそうげん130m）の**20m以上手前**に
 * 見えない壁があった。いまは外周（`outerWallDistance`＝フェンスとファウル地域の柵）の
 * `FIELDER_WALL_MARGIN` 手前まで行ける。**判定にも効く**（フェンス際の打球に追いつける）＝
 * シーン（`chicchaiScene.ts`）と計測（`tools/balance/sim.ts`）が同じこの関数を通る。
 */
export function clampToPark(park: Ballpark, p: { x: number; z: number }): void {
  const r = Math.hypot(p.x, p.z);
  if (r < 1e-9) return;
  const bound = outerWallDistance(park, Math.atan2(p.x, -p.z) / DEG) - FIELDER_WALL_MARGIN;
  if (r > bound) {
    const k = bound / r;
    p.x *= k;
    p.z *= k;
  }
}

/** スタンド最前列までの距離 m（壁の外側に通路ぶんのすきまを空ける） */
export function standFrontDistance(park: Ballpark, deg: number): number {
  return outerWallDistance(park, deg) + STAND_GAP;
}

/** ファウル地域の柵の高さ m（`assets-src/stadium.blend` の Barrier と一致させる） */
export const FOUL_BARRIER_HEIGHT = 2.4;

/**
 * その地点で**落ちてきた球が止まる面の高さ** m（見た目だけ。テストプレイ「ホームランの球が
 * 客席をすり抜けてバウンドしていく」）。壁の内側と通路は地面（0）、スタンドは**その段の上面**、
 * 最上段より後ろ（スタンドの外）は地面。
 *
 * **打球の判定には一切使わない**（判定は従来どおり `stepBattedBall` の地面と `fenceAt` だけ）。
 * 打球の物理は地面を y=0 の平面としか知らないので、フェンスを越えた球はそのまま観客席の
 * 下へ潜り、下の地面で跳ねていた。描くときにこの面より下へ行かせないために使う。
 *
 * @param rows その球場のスタンドの段数（見た目の表＝`scenes/field.ts` の `STAND_STYLE`）
 */
export function standSurfaceHeight(park: Ballpark, rows: number, x: number, z: number): number {
  const deg = Math.atan2(x, -z) / DEG;
  const front = standFrontDistance(park, deg);
  const r = Math.hypot(x, z);
  if (r < front) return 0;
  const row = Math.floor((r - front) / STAND_TREAD);
  return row < rows ? (row + 1) * STAND_RISE : 0;
}

/** 外周の頂点（位置と、そこでの外向き単位法線） */
export interface RingVertex {
  x: number;
  z: number;
  /** 外向き法線（隣り合う2区画の法線の平均＝段を積んでも隙間ができない向き） */
  nx: number;
  nz: number;
}

/**
 * 「方角→距離」の関数から閉じた外周の頂点列を作る。頂点は `STAND_STEP_DEG` きざみで、
 * 最後の頂点の次は最初の頂点（＝リング）。
 */
export function ringBoundary(distanceAt: (deg: number) => number): RingVertex[] {
  const count = Math.round(360 / STAND_STEP_DEG);
  const pts: { x: number; z: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    const deg = -180 + i * STAND_STEP_DEG;
    const r = distanceAt(deg);
    const t = deg * DEG;
    pts.push({ x: r * Math.sin(t), z: -r * Math.cos(t) });
  }
  // 区画（頂点k→k+1）の外向き法線。進行方向 (dx,dz) に対して外向きは (dz,-dx)
  // （円で確かめると半径方向の外向きになる）。
  const segment = pts.map((p, k) => {
    const q = pts[(k + 1) % count];
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const len = Math.hypot(dx, dz) || 1;
    return { nx: dz / len, nz: -dx / len };
  });
  return pts.map((p, k) => {
    const a = segment[(k - 1 + count) % count];
    const b = segment[k];
    const nx = a.nx + b.nx;
    const nz = a.nz + b.nz;
    const len = Math.hypot(nx, nz) || 1;
    return { x: p.x, z: p.z, nx: nx / len, nz: nz / len };
  });
}

/** スタンド最前列の外周 */
export function standBoundary(park: Ballpark): RingVertex[] {
  return ringBoundary((deg) => standFrontDistance(park, deg));
}

/** 壁（フェンス／ファウル地域の柵）の外周 */
export function wallBoundary(park: Ballpark): RingVertex[] {
  return ringBoundary((deg) => outerWallDistance(park, deg));
}

/** 部品1つを置く場所（ワールド座標＋ヨー＋区画の幅） */
export interface RingSegment {
  x: number;
  y: number;
  z: number;
  /** ヨー（ラジアン）。**+Z がフィールドを向く**＝部品の正面と一致する */
  yaw: number;
  /** 区画の幅 m（幅1mの部品をこの倍率でX方向へ引き伸ばす） */
  width: number;
  /** 区画の中央の方角（度）。ファウル地域だけに置く部品を選り分けるのに使う */
  deg: number;
}

/**
 * 外周を `row` 段ぶん外へずらした位置の区画一覧。`row=0` が最前列で、段が上がるほど
 * 外へ（`STAND_TREAD`）・上へ（`STAND_RISE`）動く。
 */
export function ringRow(boundary: readonly RingVertex[], row: number): RingSegment[] {
  const count = boundary.length;
  const step = 360 / count;
  const offset = row * STAND_TREAD;
  const y = row * STAND_RISE;
  const out: RingSegment[] = [];
  for (let k = 0; k < count; k += 1) {
    const a = boundary[k];
    const b = boundary[(k + 1) % count];
    const ax = a.x + a.nx * offset;
    const az = a.z + a.nz * offset;
    const bx = b.x + b.nx * offset;
    const bz = b.z + b.nz * offset;
    const dx = bx - ax;
    const dz = bz - az;
    out.push({
      x: (ax + bx) / 2,
      y,
      z: (az + bz) / 2,
      // rotation.y = yaw のとき +X→(cos,−sin)・+Z→(sin,cos) なので、区画に沿う向きを
      // +X に合わせると +Z は自動的にフィールド側を向く。
      yaw: Math.atan2(-dz, dx),
      width: Math.hypot(dx, dz),
      deg: normalizeDeg(-180 + (k + 0.5) * step),
    });
  }
  return out;
}

/** 観客1人を置く場所 */
export interface SeatSpot {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** その区画の座席に座る観客の位置（区画の幅を `spacing` で割った人数だけ等間隔に並べる） */
export function seatSpots(
  segment: RingSegment,
  spacing: number = SPECTATOR_SPACING,
): SeatSpot[] {
  const n = Math.max(1, Math.round(segment.width / spacing));
  // 区画に沿う向き（+X）とフィールド向き（+Z）。ヨーの定義から導出する
  const ax = Math.cos(segment.yaw);
  const az = -Math.sin(segment.yaw);
  const fx = Math.sin(segment.yaw);
  const fz = Math.cos(segment.yaw);
  const spots: SeatSpot[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = -segment.width / 2 + ((i + 0.5) * segment.width) / n;
    spots.push({
      x: segment.x + ax * t - fx * SEAT_BACK_OFFSET,
      y: segment.y + SEAT_SURFACE_Y,
      z: segment.z + az * t - fz * SEAT_BACK_OFFSET,
      yaw: segment.yaw,
    });
  }
  return spots;
}

/**
 * スタンドがいちばん外へ届く距離 m（最後列の背面）。**描かれた地面（field.ts の
 * `GROUND_RADIUS`）の内側に収まっていること**をテストで固定するために使う
 * ＝スタンドが地面の縁からはみ出して宙に浮くことが起きない。
 */
export function standOuterRadius(park: Ballpark, rows: number): number {
  const boundary = standBoundary(park);
  let max = 0;
  for (const s of ringRow(boundary, rows)) {
    max = Math.max(max, Math.hypot(s.x, s.z) + s.width / 2);
  }
  return max;
}
