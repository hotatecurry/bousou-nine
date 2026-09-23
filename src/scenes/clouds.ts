/**
 * 空の雲（ブラッシュアップ：グラフィック）。
 *
 * **セル画の雲**＝上が白・下が淡い青の2トーンで、光源を使わない（MeshBasic＋頂点色）。
 * 光源で陰を付けると下側が空の照り返し（芝の緑）に染まって濁るので、陰の色は
 * こちらで決め打ちする。数・位置・形は連番から決まる（**本編の乱数は使わない**＝
 * 観客・遠景と同じ扱い）。
 *
 * でっかいモードのカメラは地平線から約14°上までしか映さないので、雲は**遠く・低く**置く
 * （距離 300〜395m・高さ 24〜54m＝仰角 3.5〜10°）。スタンドや遠景の上にちょうど頭を出す高さ。
 * ちっちゃいモード（見下ろし70°）ではほとんど映らない。判定には一切触らない。
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hash01 } from '../render/textures';

const CLOUD_COUNT = 16;
const TOP_COLOR = new THREE.Color(0xffffff);
const SHADE_COLOR = new THREE.Color(0xd3e1f4);

/** 1つの雲（平たい球を5〜7個くっつけたもの）。頂点色で上下2トーンに塗る */
function cloudGeometry(seed: number): THREE.BufferGeometry {
  const puffs: THREE.BufferGeometry[] = [];
  const n = 5 + Math.floor(hash01(seed + 0.3) * 3);
  const width = 34 + hash01(seed + 0.7) * 40;
  for (let i = 0; i < n; i += 1) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const r = (0.55 + 0.45 * Math.sin(Math.PI * t)) * (9 + hash01(seed + i * 1.3) * 8);
    const g = new THREE.SphereGeometry(r, 16, 10);
    g.scale(1, 0.62, 0.8);
    g.translate(
      (t - 0.5) * width,
      r * 0.25 + hash01(seed + i * 2.1) * 3,
      (hash01(seed + i * 3.7) - 0.5) * 8,
    );
    puffs.push(g);
  }
  const merged = mergeGeometries(puffs, false)!;
  for (const g of puffs) g.dispose();
  const normals = merged.attributes.normal;
  const colors = new Float32Array(normals.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < normals.count; i += 1) {
    // 下向きの面だけ陰の色（段で切る＝セル画）
    c.copy(normals.getY(i) < -0.15 ? SHADE_COLOR : TOP_COLOR);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return merged;
}

export function createClouds(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Clouds';
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
  for (let i = 0; i < CLOUD_COUNT; i += 1) {
    // 外野側（-Z）に多めに散らす＝でっかいモードの画面に入る側
    const deg = -110 + (220 * (i + hash01(i + 5.5) * 0.8)) / CLOUD_COUNT;
    const dist = 300 + hash01(i + 9.1) * 95;
    const height = 24 + hash01(i + 2.9) * 30;
    const mesh = new THREE.Mesh(cloudGeometry(i * 17.3), material);
    const a = (deg * Math.PI) / 180;
    mesh.position.set(dist * Math.sin(a), height, -dist * Math.cos(a));
    // 帯の向きを視線に対して横へ（本塁から見て横長に見える）
    mesh.rotation.y = -a;
    group.add(mesh);
  }
  return group;
}
