/**
 * グラウンドの地面一式（ブラッシュアップ：グラフィック）。
 *
 * 芝（刈り目の市松）・内野の土と芝・マウンドの盛り上がり・本塁の五角形・打席の白線・
 * ウォーニングトラック・フェンスの黄帯・ファウルポール・距離表示。
 *
 * **判定には一切触らない**（見た目だけ）。形の出どころは判定と同じ定数：
 * 塁の位置は `BASE_AXIS`、マウンドは `PITCHER_PLATE_Z`、本塁の幅は**ストライクゾーンの幅**
 * （`STRIKE_ZONE_HALF_WIDTH`。ゾーンが実物より2.08倍広いのと同じ倍率で本塁も描く＝
 * 画面の本塁の上を通った球がストライク）、フェンスは `fenceAt`、外周は
 * `outerWallDistance`（スタンドと同じ）。**球場を足しても書くものは増えない。**
 *
 * 地面は**薄い板の重ね塗り**で作る（下から 芝 → 内野の土 → 内野の芝 → 土の円 → 白線）。
 * 板どうしは 1〜2cm ずつ持ち上げる＝ちっちゃいモードの 60m 先でも深度の精度（約2mm）の
 * 内側に収まり、ちらつかない。
 */
import * as THREE from 'three';
import { BASE_AXIS } from '../core/fielding';
import { PITCHER_PLATE_Z, STRIKE_ZONE_HALF_WIDTH } from '../core/pitch';
import { type Ballpark, FENCE_ANGLE_LIMIT_DEG, fenceAt } from '../core/ballpark';
import { outerWallDistance } from '../core/stands';
import { canvasTexture, hash01 } from '../render/textures';
import { addOutline, createToonMaterial } from '../render/toon';

const DEG = Math.PI / 180;

// ---- 寸法（実寸の野球場の比率。塁間だけは判定の `BASE_AXIS` から起こす） ----

/** 内野の土の円弧の半径（マウンドの中心から。実物の95ft） */
const INFIELD_ARC_RADIUS = 28.96;
/** 内野の芝を塁線からどれだけ内側へ下げるか（その幅が走路の土になる） */
const BASEPATH_WIDTH = 1.4;
/** 各塁の周りの土の円 */
const BASE_CUTOUT_RADIUS = 2.9;
/** 本塁の周りの土の円（本塁の中心から） */
const HOME_CIRCLE_RADIUS = 4.2;
/** マウンドの土の円（盛り上がりの裾より少し広い） */
const MOUND_CIRCLE_RADIUS = 3.1;
/** マウンドの高さ。**でっかいモードの投手はこの高さに立っている**（main.ts の pitcher.position.y） */
const MOUND_HEIGHT = 0.4;
/** ウォーニングトラックの幅（外周の壁の内側） */
const WARNING_TRACK_WIDTH = 4.2;
/** 白線の幅（実物は10cmだが、ちっちゃいモードの鳥瞰で消えない太さにする） */
const CHALK_WIDTH = 0.14;
/** 本塁の中心（奥行き）。ボールが本塁を通過する判定位置（z=0）が五角形の四角い部分の中央 */
const PLATE_CENTER_Z = 0;

// ---- 色 ----

const TURF_LIGHT = '#6cb84f';
const TURF_DARK = '#5aa343';
const DIRT_BASE = '#c99762';
const WARNING_TRACK_COLOR = 0xb58352;
const CHALK_COLOR = 0xfafaf2;
const FENCE_TOP_COLOR = 0xf2c230;
const POLE_COLOR = 0xf6d23a;

/** 芝の刈り目の1マス（m）。塁線に沿った45°の市松＝でっかいモードから見て菱形に並ぶ */
const TURF_CELL = 5.5;
/** 土の模様の繰り返し（m） */
const DIRT_TILE = 3.2;

// ---- テクスチャ ----

function turfTexture(): THREE.CanvasTexture {
  return canvasTexture(256, (ctx, size) => {
    const half = size / 2;
    for (let i = 0; i < 2; i += 1) {
      for (let j = 0; j < 2; j += 1) {
        ctx.fillStyle = (i + j) % 2 === 0 ? TURF_LIGHT : TURF_DARK;
        ctx.fillRect(i * half, j * half, half, half);
      }
    }
    // 芝の粒（ごく薄く）。トゥーンの面を壊さない程度にだけ散らす
    for (let n = 0; n < 2600; n += 1) {
      const x = hash01(n) * size;
      const y = hash01(n + 0.37) * size;
      const light = hash01(n + 0.71) > 0.5;
      ctx.fillStyle = light ? 'rgba(255,255,255,0.05)' : 'rgba(0,40,0,0.07)';
      ctx.fillRect(x, y, 1, 2);
    }
  });
}

function dirtTexture(): THREE.CanvasTexture {
  return canvasTexture(256, (ctx, size) => {
    ctx.fillStyle = DIRT_BASE;
    ctx.fillRect(0, 0, size, size);
    // ならした土のむら（ごく薄く。濃くすると繰り返しの丸が鳥瞰で模様として見える）
    for (let n = 0; n < 90; n += 1) {
      const x = hash01(n + 3.1) * size;
      const y = hash01(n + 5.9) * size;
      const rx = 10 + hash01(n + 8.3) * 26;
      const ry = rx * (0.4 + hash01(n + 9.1) * 0.5);
      ctx.fillStyle = hash01(n + 1.7) > 0.5 ? 'rgba(255,230,190,0.035)' : 'rgba(110,70,30,0.035)';
      ctx.beginPath();
      ctx.ellipse(x, y, rx, ry, hash01(n + 4.4) * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    // 小石の粒
    for (let n = 0; n < 2200; n += 1) {
      const x = hash01(n + 11.3) * size;
      const y = hash01(n + 13.7) * size;
      ctx.fillStyle = hash01(n + 17.1) > 0.45 ? 'rgba(90,55,25,0.16)' : 'rgba(255,240,210,0.13)';
      ctx.fillRect(x, y, 1, 1);
    }
  });
}

// ---- ジオメトリの道具 ----

/**
 * 地面の板（ワールドの XZ 平面、高さ y）。**UV はワールド座標から起こす**＝どの板に
 * 同じ模様を貼っても継ぎ目で模様がずれない（芝の市松が内野の芝と外野で揃う）。
 *
 * @param uvScale 模様1回ぶんの長さ（m）
 * @param rotateDeg 模様の向き（芝は塁線に沿わせて45°）
 */
function groundGeometry(
  points: readonly THREE.Vector2[],
  holes: readonly (readonly THREE.Vector2[])[] = [],
): THREE.BufferGeometry {
  // Shape の座標は (x, -z)。-90° 回すと (x, y) → (x, 0, -y) で世界の (x, z) に戻る
  const shape = new THREE.Shape(points.map((p) => new THREE.Vector2(p.x, -p.y)));
  for (const hole of holes) {
    shape.holes.push(new THREE.Path(hole.map((p) => new THREE.Vector2(p.x, -p.y))));
  }
  const geometry = new THREE.ShapeGeometry(shape, 24);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

function setWorldUV(geometry: THREE.BufferGeometry, uvScale: number, rotateDeg = 0): void {
  const pos = geometry.attributes.position;
  const c = Math.cos(rotateDeg * DEG);
  const s = Math.sin(rotateDeg * DEG);
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    uv[i * 2] = (x * c - z * s) / uvScale;
    uv[i * 2 + 1] = (x * s + z * c) / uvScale;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** 円周上の点列（中心 cx,cz・半径 r）。XZ 平面の Vector2(x, z) で返す */
function circlePoints(cx: number, cz: number, r: number, segments = 40): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i < segments; i += 1) {
    const t = (i / segments) * Math.PI * 2;
    pts.push(new THREE.Vector2(cx + r * Math.cos(t), cz + r * Math.sin(t)));
  }
  return pts;
}

function flatMesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  y: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = y;
  mesh.receiveShadow = true;
  return mesh;
}

// ---- 部品 ----

/**
 * 外周の壁の内側いっぱいの芝（フェア・ファウルとも）。外周は `outerWallDistance`＝
 * スタンドと同じ関数なので、壁の足元まで芝が届く。本塁を中心にした扇で埋められる
 * （外周は方角→距離の1価関数）。
 */
function turfGeometry(park: Ballpark): THREE.BufferGeometry {
  const positions: number[] = [0, 0, 0];
  const indices: number[] = [];
  const steps = 180;
  for (let i = 0; i <= steps; i += 1) {
    const deg = -180 + (360 * i) / steps;
    const r = outerWallDistance(park, deg) + 0.6;
    positions.push(r * Math.sin(deg * DEG), 0, -r * Math.cos(deg * DEG));
    if (i > 0) indices.push(0, i + 1, i);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** ウォーニングトラック（外周の壁に沿った土の帯。ファウル地域の壁沿いにも続く） */
function warningTrackGeometry(park: Ballpark): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const steps = 360;
  for (let i = 0; i <= steps; i += 1) {
    const deg = -180 + (360 * i) / steps;
    const outer = outerWallDistance(park, deg) + 0.6;
    const inner = outer - 0.6 - WARNING_TRACK_WIDTH;
    const s = Math.sin(deg * DEG);
    const c = Math.cos(deg * DEG);
    positions.push(inner * s, 0, -inner * c, outer * s, 0, -outer * c);
    if (i > 0) {
      const a = (i - 1) * 2;
      indices.push(a, a + 2, a + 3, a, a + 3, a + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * 内野の土（本塁から両翼線に沿って出て、マウンドを中心にした円弧で閉じる）。
 * 円弧が塁線と交わる点は幾何で解く＝塁間（`BASE_AXIS`）を触っても形が付いてくる。
 */
function infieldDirtPoints(): THREE.Vector2[] {
  const moundZ = PITCHER_PLATE_Z;
  // 塁線上の点 (t/√2, -t/√2) がマウンド中心から INFIELD_ARC_RADIUS にある t
  const b = -2 * (-moundZ) / Math.SQRT2; // t の1次の係数
  const c = moundZ * moundZ - INFIELD_ARC_RADIUS * INFIELD_ARC_RADIUS;
  const t = (-b + Math.sqrt(b * b - 4 * c)) / 2;
  const edge = t / Math.SQRT2;
  const startDeg = Math.atan2(edge, -(-edge - moundZ)) / DEG; // マウンドから見た一塁側の端
  const pts: THREE.Vector2[] = [new THREE.Vector2(0, 0.5)];
  pts.push(new THREE.Vector2(edge, -edge));
  const steps = 60;
  for (let i = 1; i < steps; i += 1) {
    const deg = startDeg - ((2 * startDeg) * i) / steps;
    pts.push(
      new THREE.Vector2(
        INFIELD_ARC_RADIUS * Math.sin(deg * DEG),
        moundZ - INFIELD_ARC_RADIUS * Math.cos(deg * DEG),
      ),
    );
  }
  pts.push(new THREE.Vector2(-edge, -edge));
  return pts;
}

/** 内野の芝（塁間の正方形を走路の幅だけ内側へ下げたもの） */
function infieldGrassPoints(): THREE.Vector2[] {
  const cz = -BASE_AXIS;
  const half = BASE_AXIS - BASEPATH_WIDTH * Math.SQRT2;
  return [
    new THREE.Vector2(0, cz + half),
    new THREE.Vector2(half, cz),
    new THREE.Vector2(0, cz - half),
    new THREE.Vector2(-half, cz),
  ];
}

/** 本塁（五角形）。幅は**ストライクゾーンの幅**＝画面の本塁の上を通った球がストライク */
function homePlateGeometry(): THREE.BufferGeometry {
  const w = STRIKE_ZONE_HALF_WIDTH;
  const front = PLATE_CENTER_Z - w / 2;
  const shape = new THREE.Shape([
    new THREE.Vector2(-w, -front),
    new THREE.Vector2(w, -front),
    new THREE.Vector2(w, -(front + w)),
    new THREE.Vector2(0, -(front + 2 * w)),
    new THREE.Vector2(-w, -(front + w)),
  ]);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.035,
    bevelEnabled: true,
    bevelThickness: 0.012,
    bevelSize: 0.02,
    bevelSegments: 2,
  });
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

/** 長方形の白線の枠（中心 cx,cz・幅 w・奥行き d） */
function boxOutlineGeometry(cx: number, cz: number, w: number, d: number): THREE.BufferGeometry {
  const hw = w / 2;
  const hd = d / 2;
  const o = CHALK_WIDTH * 0.7;
  const outer = [
    new THREE.Vector2(cx - hw, cz - hd),
    new THREE.Vector2(cx + hw, cz - hd),
    new THREE.Vector2(cx + hw, cz + hd),
    new THREE.Vector2(cx - hw, cz + hd),
  ];
  const inner = [
    new THREE.Vector2(cx - hw + o, cz - hd + o),
    new THREE.Vector2(cx - hw + o, cz + hd - o),
    new THREE.Vector2(cx + hw - o, cz + hd - o),
    new THREE.Vector2(cx + hw - o, cz - hd + o),
  ];
  return groundGeometry(outer, [inner]);
}

/** 1本の白線（from→to、幅 CHALK_WIDTH） */
function chalkLineGeometry(fx: number, fz: number, tx: number, tz: number): THREE.BufferGeometry {
  const dx = tx - fx;
  const dz = tz - fz;
  const len = Math.hypot(dx, dz);
  const nx = (-dz / len) * (CHALK_WIDTH / 2);
  const nz = (dx / len) * (CHALK_WIDTH / 2);
  return groundGeometry([
    new THREE.Vector2(fx + nx, fz + nz),
    new THREE.Vector2(tx + nx, tz + nz),
    new THREE.Vector2(tx - nx, tz - nz),
    new THREE.Vector2(fx - nx, fz - nz),
  ]);
}

/** マウンドの盛り上がり（頂上は平ら＝投手が立つ高さ、裾はなめらかに地面へ） */
function moundGeometry(): THREE.BufferGeometry {
  const h = MOUND_HEIGHT;
  const profile = [
    new THREE.Vector2(0, h),
    new THREE.Vector2(0.9, h),
    new THREE.Vector2(1.4, h * 0.93),
    new THREE.Vector2(1.9, h * 0.72),
    new THREE.Vector2(2.4, h * 0.38),
    new THREE.Vector2(2.75, h * 0.12),
    new THREE.Vector2(2.95, 0),
  ];
  return new THREE.LatheGeometry(profile, 48);
}

/** 距離表示（フェンスの内側に貼る数字）。数字だけなのでドット体でなく太いゴシックで描く */
function distanceMarker(meters: number): THREE.Mesh {
  const tex = canvasTexture(
    256,
    (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '900 92px "Arial Black", "Arial", sans-serif';
      ctx.fillText(String(Math.round(meters)), w / 2, h / 2 + 6);
    },
    128,
  );
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(4.4, 2.2),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  return mesh;
}

/**
 * フェンスの上端の黄帯（ホームランライン）。高さが区間ごとに違う球場（ふえいふえいの
 * 高いレフト・たからづかの低い柵）でも `fenceAt` の高さにそのまま乗る。
 */
function fenceTopBand(park: Ballpark): THREE.Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const steps = Math.round(FENCE_ANGLE_LIMIT_DEG * 2);
  for (let i = 0; i <= steps; i += 1) {
    const deg = -FENCE_ANGLE_LIMIT_DEG + (2 * FENCE_ANGLE_LIMIT_DEG * i) / steps;
    const f = fenceAt(park, deg);
    const r = f.distance - 0.03;
    const x = r * Math.sin(deg * DEG);
    const z = -r * Math.cos(deg * DEG);
    positions.push(x, f.height - 0.28, z, x, f.height + 0.02, z);
    if (i > 0) {
      const a = (i - 1) * 2;
      indices.push(a, a + 2, a + 3, a, a + 3, a + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return new THREE.Mesh(
    geometry,
    new THREE.MeshLambertMaterial({ color: FENCE_TOP_COLOR, side: THREE.DoubleSide }),
  );
}

// ---- 組み立て ----

/**
 * 地面一式を組む。フェンスの本体・スタンド・背景は `scenes/field.ts` の側で、
 * ここはその内側（打球が転がる面）と、フェンスに貼る飾りだけを持つ。
 */
export function createGround(park: Ballpark): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Ground';

  const turfTex = turfTexture();
  const dirtTex = dirtTexture();
  const turf = new THREE.MeshLambertMaterial({ map: turfTex });
  const dirt = new THREE.MeshLambertMaterial({ map: dirtTex });
  const track = new THREE.MeshLambertMaterial({ map: dirtTex, color: WARNING_TRACK_COLOR });
  const chalk = new THREE.MeshLambertMaterial({ color: CHALK_COLOR });

  // 1. 芝（外周の壁の足元まで）
  const turfGeo = turfGeometry(park);
  setWorldUV(turfGeo, TURF_CELL * 2, 45);
  group.add(flatMesh(turfGeo, turf, 0));

  // 2. ウォーニングトラック
  const trackGeo = warningTrackGeometry(park);
  setWorldUV(trackGeo, DIRT_TILE);
  group.add(flatMesh(trackGeo, track, 0.01));

  // 3. 内野の土
  const infieldGeo = groundGeometry(infieldDirtPoints());
  setWorldUV(infieldGeo, DIRT_TILE);
  group.add(flatMesh(infieldGeo, dirt, 0.02));

  // 4. 内野の芝（同じ刈り目の模様＝外野の芝と地続きに見える）
  const grassGeo = groundGeometry(infieldGrassPoints());
  setWorldUV(grassGeo, TURF_CELL * 2, 45);
  group.add(flatMesh(grassGeo, turf, 0.03));

  // 5. 土の円（各塁・本塁・マウンド）
  const circles: [number, number, number][] = [
    [BASE_AXIS, -BASE_AXIS, BASE_CUTOUT_RADIUS],
    [0, -BASE_AXIS * 2, BASE_CUTOUT_RADIUS],
    [-BASE_AXIS, -BASE_AXIS, BASE_CUTOUT_RADIUS],
    [0, PLATE_CENTER_Z, HOME_CIRCLE_RADIUS],
    [0, PITCHER_PLATE_Z, MOUND_CIRCLE_RADIUS],
  ];
  for (const [cx, cz, r] of circles) {
    const geo = groundGeometry(circlePoints(cx, cz, r, 48));
    setWorldUV(geo, DIRT_TILE);
    group.add(flatMesh(geo, dirt, 0.04));
  }

  // 6. マウンドの盛り上がり（土の模様はワールド座標で貼る＝円の土と継ぎ目が出ない）
  const moundGeo = moundGeometry();
  moundGeo.translate(0, 0, PITCHER_PLATE_Z);
  setWorldUV(moundGeo, DIRT_TILE);
  const mound = new THREE.Mesh(moundGeo, dirt);
  mound.receiveShadow = true;
  mound.position.y = 0.035;
  group.add(mound);
  // プレート（投手板）
  const rubber = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 0.05, 0.22),
    createToonMaterial({ color: 0xffffff }),
  );
  rubber.position.set(0, MOUND_HEIGHT + 0.045, PITCHER_PLATE_Z);
  rubber.receiveShadow = true;
  group.add(rubber);

  // 7. 白線（ファウルライン・打席・捕手席・ネクストバッターズサークル）
  const lineY = 0.05;
  for (const sign of [1, -1]) {
    const length = fenceAt(park, sign * FENCE_ANGLE_LIMIT_DEG).distance;
    const end = length / Math.SQRT2;
    group.add(flatMesh(chalkLineGeometry(sign * 0.7, -0.7, sign * end, -end), chalk, lineY));
  }
  // 打席（左右）。打者の立ち位置（x=±1.05±0.16）が必ず枠の中に収まる大きさ
  for (const sign of [1, -1]) {
    group.add(flatMesh(boxOutlineGeometry(sign * 1.13, PLATE_CENTER_Z, 1.0, 1.9), chalk, lineY));
  }
  // 捕手席（打席の後ろ端から後ろへ伸びる2本と奥の線）
  const backZ = PLATE_CENTER_Z + 0.95;
  for (const sign of [1, -1]) {
    group.add(flatMesh(chalkLineGeometry(sign * 0.63, backZ, sign * 0.63, backZ + 2.2), chalk, lineY));
  }
  group.add(flatMesh(chalkLineGeometry(-0.63, backZ + 2.2, 0.63, backZ + 2.2), chalk, lineY));
  // ネクストバッターズサークル（本塁の両脇のファウル地域）
  for (const sign of [1, -1]) {
    const ring = groundGeometry(circlePoints(sign * 11.5, 4.5, 0.95, 32), [
      circlePoints(sign * 11.5, 4.5, 0.95 - CHALK_WIDTH, 32).reverse(),
    ]);
    group.add(flatMesh(ring, chalk, lineY));
  }

  // 8. 本塁と塁ベース（塁は鳥瞰で読める大きさ＝実物より大きい。従来どおり）
  const plate = new THREE.Mesh(homePlateGeometry(), createToonMaterial({ color: 0xffffff }));
  plate.position.y = 0.045;
  plate.receiveShadow = true;
  group.add(plate);
  const baseMat = createToonMaterial({ color: 0xffffff });
  const baseGeo = new THREE.BoxGeometry(1.0, 0.14, 1.0, 1, 1, 1);
  for (const [bx, bz] of [
    [BASE_AXIS, -BASE_AXIS],
    [0, -BASE_AXIS * 2],
    [-BASE_AXIS, -BASE_AXIS],
  ]) {
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.position.set(bx, 0.1, bz);
    base.rotation.y = Math.PI / 4;
    base.receiveShadow = true;
    base.castShadow = true;
    group.add(base);
  }

  // 9. フェンスの飾り（黄帯・ファウルポール・距離表示）
  group.add(fenceTopBand(park));
  for (const sign of [1, -1]) {
    const f = fenceAt(park, sign * FENCE_ANGLE_LIMIT_DEG);
    const height = f.height + 13;
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.26, height, 12),
      createToonMaterial({ color: POLE_COLOR }),
    );
    const r = f.distance + 0.3;
    pole.position.set((sign * r) / Math.SQRT2, height / 2, -r / Math.SQRT2);
    pole.castShadow = true;
    addOutline(pole, { worldWidth: 0.05 });
    group.add(pole);
  }
  // 距離表示は**フェンスの面に沿わせて**貼る。フェンスは本塁を中心にした円ではない
  // （`fenceArcDistance` の円の中心は本塁より外）ので、本塁へ向けて貼ると板の端が
  // フェンスの裏へ潜って数字が欠ける（実機で踏んだ）。
  const fencePoint = (deg: number): THREE.Vector2 => {
    const d = fenceAt(park, deg).distance;
    return new THREE.Vector2(d * Math.sin(deg * DEG), -d * Math.cos(deg * DEG));
  };
  for (const deg of [-FENCE_ANGLE_LIMIT_DEG + 8, -22, 0, 22, FENCE_ANGLE_LIMIT_DEG - 8]) {
    const f = fenceAt(park, deg);
    const marker = distanceMarker(f.distance);
    const p = fencePoint(deg);
    const tangent = fencePoint(deg + 0.5).sub(fencePoint(deg - 0.5)).normalize();
    // 接線の左手（本塁の側）へ少し浮かせる
    const inward = new THREE.Vector2(tangent.y, -tangent.x);
    if (inward.dot(p) > 0) inward.negate();
    marker.position.set(p.x + inward.x * 0.1, Math.min(f.height * 0.55, 2.2), p.y + inward.y * 0.1);
    marker.rotation.y = Math.atan2(-tangent.y, tangent.x);
    group.add(marker);
  }

  return group;
}
