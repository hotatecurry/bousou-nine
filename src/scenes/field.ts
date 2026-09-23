/**
 * 野球場のプレースホルダージオメトリ。
 * 座標系: 本塁を原点、外野方向を -Z、一塁方向を +X とする。
 * でっかい/ちっちゃい両モードで同じ単一Sceneを共有する（カメラ切り替え方式）。
 *
 * フェンス・芝生・ファウルラインの形は**すべて core/ballpark.ts の `fenceAt` から起こす**
 * （フェーズC-14）。打球物理が当たり判定に使っているのと同じ関数なので、
 * 「見えているフェンスと当たるフェンスが違う」ことが構造的に起きない。
 */
import * as THREE from 'three';
import { PITCHER_PLATE_Z } from '../core/pitch';
import {
  type Ballpark,
  type BallparkId,
  DEFAULT_BALLPARK,
  FENCE_ANGLE_LIMIT_DEG,
  fenceAt,
} from '../core/ballpark';
import {
  STAND_RISE,
  STAND_TREAD,
  ringRow,
  seatSpots,
  standBoundary,
  standFrontDistance,
  wallBoundary,
} from '../core/stands';
import {
  FAR_GROUND_RADIUS,
  FAR_GROUND_Y,
  SKY_RADIUS,
  type SkylineItem,
  skylineBaseRadius,
  skylinePlan,
} from '../core/horizon';
import { type StadiumPart, placeParts } from '../entities/stadium';
import { createGround } from './fieldGround';
import { createClouds } from './clouds';
import { BASE_AXIS } from '../core/fielding';

export const FIELD_POSITIONS = {
  home: new THREE.Vector3(0, 0, 0),
  first: new THREE.Vector3(BASE_AXIS, 0, -BASE_AXIS),
  second: new THREE.Vector3(0, 0, -BASE_AXIS * 2),
  third: new THREE.Vector3(-BASE_AXIS, 0, -BASE_AXIS),
  mound: new THREE.Vector3(0, 0, PITCHER_PLATE_Z),
} as const;

/**
 * 球場の外まで含めた地面の半径。**ちっちゃいモードが追従カメラになった（フェーズE-24）
 * ことで初めて必要になった**もので、寄って本塁際・ファウルゾーンを映すと、従来は
 * 画面に入らなかった「芝生の外」＝背景色の空白が大きく映ってしまう。
 * カメラの可動範囲（core/camera.ts の FOCUS_LIMIT）＋映る範囲がこの円に収まるよう
 * 決めてある。**6球場でいちばん深いだいそうげん（センター130m）を追えるところまで
 * カメラが下がれるようになった**ぶん（フェーズC-14）、E-24の150mから広げてある。
 */
export const GROUND_RADIUS = 175;

/** フェンスを何度きざみで多角形近似するか（1°＝両翼線の間で90枚のパネル） */
const FENCE_STEP_DEG = 1;

const DEG = Math.PI / 180;

/**
 * フェンスの帯（内側から見える壁）を1枚のジオメトリとして作る。
 * `distanceAt` はその方角のフェンス距離、`heightAt` は高さを返す。
 * 高さや距離が区間の境目で段になっている球場（ふえいふえい）は、1°ぶんの
 * 斜めのパネルでつながる＝穴があかない。
 */
function createFenceBand(
  distanceAt: (deg: number) => number,
  heightAt: (deg: number) => number,
  color: number,
  fromDeg = -FENCE_ANGLE_LIMIT_DEG,
  toDeg = FENCE_ANGLE_LIMIT_DEG,
): THREE.Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const steps = Math.max(1, Math.round((toDeg - fromDeg) / FENCE_STEP_DEG));
  for (let i = 0; i <= steps; i += 1) {
    const deg = fromDeg + ((toDeg - fromDeg) * i) / steps;
    const r = distanceAt(deg);
    const h = heightAt(deg);
    const x = r * Math.sin(deg * DEG);
    const z = -r * Math.cos(deg * DEG);
    positions.push(x, 0, z, x, h, z);
    if (i > 0) {
      const b0 = (i - 1) * 2;
      const t0 = b0 + 1;
      const b1 = i * 2;
      const t1 = b1 + 1;
      indices.push(b0, b1, t1, b0, t1, t0);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return new THREE.Mesh(
    geometry,
    new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }),
  );
}

/**
 * 2つの距離関数にはさまれた地面の帯（ラッキーゾーンの床）を作る。
 * fromDeg..toDeg の区間だけを塗る。
 */
function createGroundBand(
  fromDeg: number,
  toDeg: number,
  innerAt: (deg: number) => number,
  outerAt: (deg: number) => number,
  color: number,
): THREE.Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const steps = Math.max(1, Math.round((toDeg - fromDeg) / FENCE_STEP_DEG));
  for (let i = 0; i <= steps; i += 1) {
    const deg = fromDeg + ((toDeg - fromDeg) * i) / steps;
    const s = Math.sin(deg * DEG);
    const c = Math.cos(deg * DEG);
    const ri = innerAt(deg);
    const ro = outerAt(deg);
    positions.push(ri * s, 0, -ri * c, ro * s, 0, -ro * c);
    if (i > 0) {
      const i0 = (i - 1) * 2;
      const o0 = i0 + 1;
      const i1 = i * 2;
      const o1 = i1 + 1;
      indices.push(i0, i1, o1, i0, o1, o0);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color }));
  mesh.position.y = 0.015;
  return mesh;
}

// ---- スタンド（フェーズE-25-(d)） ----
//
// 部品は Blender 製（`entities/stadium.ts`）、置く場所は `fenceAt` から起こす
// （`core/stands.ts`）。ここが決めるのは**球場ごとの見た目の違い**だけ。

/** 球場ごとのスタンドの作り。**説明書の紹介文（`park.note`）を見た目に翻訳したもの** */
export interface StandStyle {
  /** 段数（`core/stands.ts` の STAND_TREAD/STAND_RISE ぶんずつ外へ・上へ積む） */
  rows: number;
  /** 照明塔を立てるか */
  towers: boolean;
  /** スコアボードを置くか */
  scoreboard: boolean;
  /** スタンドの上に屋根を掛けるか（どうむ） */
  roof: boolean;
}

/**
 * **球場の性格を見た目に出す表**（C-14までは距離と壁の高さしか違わず、どの球場にいるかが
 * ひと目では分からなかった）。この表を `core/ballpark.ts` に置かないのは、段数も照明塔も
 * **判定にはいっさい効かない見た目だけの値**だから（⑦「球場は試合のルール・状態には
 * 効かない」）。判定に効く数値は従来どおり `Ballpark` の側にある。
 */
export const STAND_STYLE: Record<BallparkId, StandStyle> = {
  // 最も平均的＝標準の球場らしい姿がそのまま基準になる
  tokorozawa: { rows: 14, towers: true, scoreboard: true, roof: false },
  // 形のいびつさ・高いレフトフェンスはフェンス側が担うので、スタンドは標準
  fueifuei: { rows: 14, towers: true, scoreboard: true, roof: false },
  // 河川敷。狭いだけでなく設備も無い＝低いスタンドだけ
  kasenjiki: { rows: 6, towers: false, scoreboard: false, roof: false },
  takarazuka: { rows: 14, towers: true, scoreboard: true, roof: false },
  // 屋根付き（説明書p25）。空の色だけだった「屋内」に実際の屋根が付く＝照明塔は要らない。
  // **屋根が掛かるのはスタンドの上だけ**なので、真上から見るちっちゃいモードの視界は塞がない
  doumu: { rows: 18, towers: false, scoreboard: true, roof: true },
  // とてつもなく広い草原。設備は無いが、**3mの板塀から観客が覗く高さは要る**
  // （それより低いと塀に完全に隠れて「スタンドが無い」ように見え、狙った素っ気なさが
  //   作り忘れに見えてしまう。実機で3段だと一切見えなかったので5段にした）
  daisougen: { rows: 5, towers: false, scoreboard: false, roof: false },
};

/** 区画どうしをわずかに重ねる倍率（丸め誤差で継ぎ目に隙間が見えないように） */
const SECTION_OVERLAP = 1.02;

/** 照明塔を立てる方角（度）。外野の左右に2本ずつ */
const TOWER_DEG = [-58, -22, 22, 58];
/** 照明塔・スコアボードをスタンドの背面からどれだけ後ろに置くか m */
const BEHIND_STAND = 5;

/** 屋根がスタンドの最上段からどれだけ上に掛かるか m */
const ROOF_CLEARANCE = 6;
/** RoofSection の奥行き m（`assets-src/stadium.blend` と一致させる） */
const ROOF_PART_DEPTH = 16;

/** 観客の服の色。**乱数は使わない**（本編の乱数を消費しないのはもちろん、毎回同じ絵になる） */
const CROWD_COLORS = [
  0xd8d8d8, 0x8f9bb0, 0xcc5544, 0x3f6fb5, 0xe0c060, 0x4f9a68, 0xb06aa8, 0xdd8844,
];

const UP = new THREE.Vector3(0, 1, 0);
const scratchQuat = new THREE.Quaternion();
const scratchPos = new THREE.Vector3();
const scratchScale = new THREE.Vector3();

function transform(
  x: number,
  y: number,
  z: number,
  yaw: number,
  sx = 1,
  sy = 1,
  sz = 1,
): THREE.Matrix4 {
  scratchQuat.setFromAxisAngle(UP, yaw);
  return new THREE.Matrix4().compose(
    scratchPos.set(x, y, z),
    scratchQuat,
    scratchScale.set(sx, sy, sz),
  );
}

/** 観客の見た目を1人ずつ散らす（連番から決まるので毎回同じ＝乱数を持ち込まない） */
function crowdHash(i: number): number {
  const h = Math.sin(i * 12.9898) * 43758.5453;
  return h - Math.floor(h);
}

/**
 * その球場のスタンド一式（観客席・観客・柵・照明塔・スコアボード・屋根）。
 * **フェンスと同じ `fenceAt` から外周を起こす**ので、球場を替えれば形も一緒に変わる。
 */
function createStands(park: Ballpark): THREE.Group {
  const style = STAND_STYLE[park.id];
  const group = new THREE.Group();
  const boundary = standBoundary(park);
  const standDepth = style.rows * STAND_TREAD;

  // 観客席と観客（段ごとに区画へ割り、区画の幅ぶんだけ人を並べる）
  const sections: THREE.Matrix4[] = [];
  const crowd: THREE.Matrix4[] = [];
  const crowdColors: THREE.Color[] = [];
  for (let row = 0; row < style.rows; row += 1) {
    for (const segment of ringRow(boundary, row)) {
      sections.push(
        transform(segment.x, segment.y, segment.z, segment.yaw, segment.width * SECTION_OVERLAP),
      );
      for (const spot of seatSpots(segment)) {
        const n = crowd.length;
        // 向きを少し散らす（全員が寸分たがわず正面を向くと壁紙に見える）
        crowd.push(transform(spot.x, spot.y, spot.z, spot.yaw + (crowdHash(n) - 0.5) * 0.6));
        crowdColors.push(
          new THREE.Color(CROWD_COLORS[Math.floor(crowdHash(n + 0.5) * CROWD_COLORS.length)]),
        );
      }
    }
  }
  group.add(placeParts('StandSection', sections));
  group.add(placeParts('Spectator', crowd, crowdColors));

  // ファウル地域の柵（外野は打球が当たるフェンスがそのまま壁なので、その外だけ）
  const barriers = ringRow(wallBoundary(park), 0)
    .filter((s) => Math.abs(s.deg) > FENCE_ANGLE_LIMIT_DEG)
    .map((s) => transform(s.x, s.y, s.z, s.yaw, s.width * SECTION_OVERLAP));
  group.add(placeParts('Barrier', barriers));

  // 屋根（どうむ）。スタンドの上だけを覆うので、真上から見るちっちゃいモードは塞がない
  if (style.roof) {
    const y = style.rows * STAND_RISE + ROOF_CLEARANCE;
    const roofs = ringRow(boundary, 0).map((s) =>
      transform(s.x, y, s.z, s.yaw, s.width * SECTION_OVERLAP, 1, standDepth / ROOF_PART_DEPTH),
    );
    group.add(placeParts('RoofSection', roofs));
  }

  // 照明塔（スタンドの背後）
  if (style.towers) {
    const towers = TOWER_DEG.map((deg) => {
      const r = standFrontDistance(park, deg) + standDepth + BEHIND_STAND;
      const t = (deg * Math.PI) / 180;
      return transform(r * Math.sin(t), 0, -r * Math.cos(t), -t);
    });
    group.add(placeParts('LightTower', towers));
  }

  // スコアボード（中堅のスタンドの背後＝バックスクリーンの位置）
  if (style.scoreboard) {
    const r = standFrontDistance(park, 0) + standDepth + BEHIND_STAND;
    group.add(placeParts('Scoreboard', [transform(0, 0, -r, 0)]));
  }

  return group;
}

// ---- 背景（フェーズE-25-(d) の2段目） ----
//
// スタンドの上に残っていた「一様な背景色」を、**空のドーム＋遠景**で埋める。
// 置く場所は `core/horizon.ts` が**スタンドの最後列から**導出する（スタンドが `fenceAt` から
// 起きているので、球場を替えれば遠景の距離も一緒に動く）。

/**
 * 遠景の1種類ぶん。大きさの決め方（`SkylineItem`）は `core/horizon.ts` が持ち、
 * ここが足すのは**どの部品を使うか・何色か**という見た目だけ。
 */
export interface SkylineEntry extends SkylineItem {
  part: StadiumPart;
  /** 個体ごとの色（散らしの値で選ぶ。省略すればモデルの色のまま） */
  colors?: readonly number[];
}

/** 遠景のビルの色（**乱数は使わない**＝観客と同じく連番から決まる） */
const FAR_BUILDING_COLORS = [0xc8ccd4, 0xa8b0bd, 0xd6d2c8, 0x9fa8b4, 0xbfc6cf, 0xb2aca4];

/**
 * **球場ごとの遠景の表**（`STAND_STYLE` の延長）。`core/ballpark.ts` に置かないのは
 * 段数や照明塔と同じく**判定にいっさい効かない見た目だけの値**だから
 * （⑦「球場は試合のルール・状態には効かない」）。
 */
export const SKYLINE_STYLE: Record<BallparkId, readonly SkylineEntry[]> = {
  // 「ヒロカラズ セマカラズ モットモ ヘイキンテキ」＝郊外の球場。木立ちの向こうに低いビル
  tokorozawa: [
    { part: 'FarTree', count: 72, height: [9, 17], width: [9, 17], depthRatio: 1, offset: 4, spread: 26 },
    { part: 'FarBuilding', count: 16, height: [16, 30], width: [9, 16], depthRatio: 1, offset: 44, spread: 38, colors: FAR_BUILDING_COLORS, salt: 3 },
  ],
  // 「イビツナ カタチ ト タカイ レフトフェンス」＝街なかの古い球場。ビルに囲まれている
  fueifuei: [
    { part: 'FarBuilding', count: 40, height: [20, 52], width: [11, 21], depthRatio: 1, offset: 6, spread: 52, colors: FAR_BUILDING_COLORS },
    { part: 'FarTree', count: 22, height: [8, 13], width: [8, 13], depthRatio: 1, offset: 2, spread: 12, salt: 5 },
  ],
  // 「トニカク セマイ」＝河川敷。鉄橋とまばらな木しかない
  kasenjiki: [
    { part: 'FarBridge', count: 1, height: [17, 17], width: [150, 150], depthRatio: 0.05, offset: 26, fromDeg: -34, toDeg: -34 },
    { part: 'FarTree', count: 30, height: [7, 13], width: [7, 13], depthRatio: 1, offset: 6, spread: 30, salt: 2 },
  ],
  // 「ラッキーゾーンアリ」＝山あいの球場。背後に山並みが立つ
  takarazuka: [
    { part: 'FarRidge', count: 11, height: [42, 84], width: 'wrap', depthRatio: 0.35, offset: 52, spread: 22 },
    { part: 'FarTree', count: 40, height: [9, 15], width: [9, 15], depthRatio: 1, offset: 4, spread: 22, salt: 7 },
  ],
  // 「ヤネツキ」＝屋内。**遠景は出さない**（空のドームがそのまま天井になる）
  doumu: [],
  // 「トテツモナク ヒロイ」＝大草原。遠くに低い山並みが見えるだけ
  daisougen: [
    { part: 'FarRidge', count: 9, height: [13, 26], width: 'wrap', depthRatio: 0.4, offset: 86, spread: 18 },
  ],
};

/**
 * 空のドームと遠景の地面（どの球場にも必ず出す）。**この2枚が「世界の端」を消している**
 * ＝低いスタンドの球場で、描かれた地面の縁がそのまま地平線として見えていたのを埋める。
 */
function createBackdrop(park: Ballpark): THREE.Group {
  const group = new THREE.Group();
  group.add(
    placeParts('SkyDome', [transform(0, 0, 0, 0, SKY_RADIUS, SKY_RADIUS, SKY_RADIUS)], [
      new THREE.Color(park.skyColor),
    ]),
  );
  group.add(
    placeParts('FarGround', [
      transform(0, FAR_GROUND_Y, 0, 0, FAR_GROUND_RADIUS, 1, FAR_GROUND_RADIUS),
    ]),
  );
  // 雲（ブラッシュアップ）。屋根付きのどうむは屋内なので出さない
  if (!STAND_STYLE[park.id].roof) group.add(createClouds());
  return group;
}

/** その球場の遠景（山・ビル・木・鉄橋）。屋内（どうむ）は空のまま */
function createSkyline(park: Ballpark, rows: number): THREE.Group {
  const group = new THREE.Group();
  const base = skylineBaseRadius(park, rows);
  for (const entry of SKYLINE_STYLE[park.id]) {
    const matrices: THREE.Matrix4[] = [];
    const colors: THREE.Color[] = [];
    for (const p of skylinePlan(base, entry)) {
      matrices.push(
        transform(p.x, 0, p.z, p.yaw, p.flip ? -p.width : p.width, p.height, p.depth),
      );
      if (entry.colors) {
        colors.push(
          new THREE.Color(entry.colors[Math.floor(p.variation * entry.colors.length)]),
        );
      }
    }
    group.add(placeParts(entry.part, matrices, entry.colors ? colors : undefined));
  }
  return group;
}

export function createField(park: Ballpark = DEFAULT_BALLPARK): THREE.Group {
  const group = new THREE.Group();
  const fenceDistance = (deg: number): number => fenceAt(park, deg).distance;
  const fenceHeight = (deg: number): number => fenceAt(park, deg).height;

  // 球場の外まで敷く地面（スタンドの下・場外を埋める）。芝・土・ラインより下に置いて
  // Zファイティングを避ける。
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(GROUND_RADIUS, 64),
    new THREE.MeshLambertMaterial({ color: 0x4a8a3a }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  ground.receiveShadow = true;
  group.add(ground);

  // グラウンドの地面一式（ブラッシュアップ：芝の刈り目・内野の土と芝・マウンドの盛り上がり・
  // 五角形の本塁・打席の白線・ウォーニングトラック・ポール・距離表示）。形はすべて判定と
  // 同じ定数から起こすので、球場を替えれば一緒に変わる（`scenes/fieldGround.ts`）。
  group.add(createGround(park));

  // ラッキーゾーン（たからづか）。低い柵の外にもう1枚の外壁があり、その間の床を
  // 塗り分ける。柵が低いこと自体は fenceAt の高さに入っていて打球判定に効く。
  if (park.luckyZone) {
    const { fromDeg, outerOffset } = park.luckyZone;
    const outerAt = (deg: number): number => fenceDistance(deg) + outerOffset;
    for (const sign of [1, -1]) {
      const a = sign > 0 ? fromDeg : -FENCE_ANGLE_LIMIT_DEG;
      const b = sign > 0 ? FENCE_ANGLE_LIMIT_DEG : -fromDeg;
      group.add(createGroundBand(a, b, fenceDistance, outerAt, 0x8a6b3a));
      // 外壁はラッキーゾーンのある区間だけ（中堅はもともと柵が外壁そのもの）
      group.add(createFenceBand(outerAt, () => 5, 0x14496e, a, b));
    }
  }

  // 外野フェンス。当たり判定は core/batting.ts の打球物理が同じ fenceAt で行う
  group.add(createFenceBand(fenceDistance, fenceHeight, 0x1a5c8a));

  // スタンド一式（フェーズE-25-(d)）。**壁より外側にしか物を置かない**ので、
  // 打球判定に関わる形（フェンスの距離と高さ）はここまでで確定している
  group.add(createStands(park));

  // 背景（フェーズE-25-(d) の2段目）。**スタンドのさらに外側**なので、ここでも
  // 打球判定に関わる形は動かない。空のドームだけは全体を包む
  group.add(createBackdrop(park));
  group.add(createSkyline(park, STAND_STYLE[park.id].rows));

  return group;
}
