/**
 * 光源と影（ブラッシュアップ：グラフィック）。
 *
 * **太陽1つ＋空の照り返し1つ**だけで組む。トゥーンの階調（`render/toon.ts`）は
 * 太陽の向きで段が決まるので、光源を増やすと段が崩れる。
 *
 * 影は**いま映っている場所の周りだけ**に落とす。フィールドは200m四方あるので、
 * 全体を1枚の影に収めると1テクセルが10cm近くになり選手の影が溶ける。モードごとに
 * 見ている場所が決まっている（でっかい＝本塁とマウンドの間／ちっちゃい＝追従カメラの
 * 注視点／乱闘＝舞台）ので、影のカメラをそこへ寄せる。
 *
 * **判定には一切触らない**（見た目だけの値）。
 */
import * as THREE from 'three';

/** 太陽のある向き（本塁の後ろ・一塁側の高い空）。影は外野（-Z）へ落ちる */
const SUN_DIRECTION = new THREE.Vector3(0.38, 0.82, 0.43).normalize();
/** 太陽を注視点からどれだけ離して置くか（影のカメラの手前側の余裕） */
const SUN_DISTANCE = 120;
/** 影のテクスチャの一辺（ピクセル） */
const SHADOW_MAP_SIZE = 2048;

export type LightingView = 'dekkai' | 'chicchai' | 'brawl';

/**
 * モードごとの影の範囲（注視点からの半径 m）。**狭いほど影がくっきりする**ので、
 * 映っている範囲をぎりぎり覆う大きさにしてある。
 */
const SHADOW_HALF_EXTENT: Record<LightingView, number> = {
  // 本塁（z=0）からマウンド（z=-18.4）まで＋捕手の後ろ
  dekkai: 15,
  // 地面に映る横幅の半分（34m）＋奥行きのぶん
  chicchai: 52,
  // 乱闘の舞台（2人の間は数m）
  brawl: 7,
};

export interface LightRig {
  /** 毎フレーム：いま映っているモードと、その注視点（地面の上の点） */
  update(view: LightingView, focus: THREE.Vector3): void;
}

export function createLightRig(scene: THREE.Scene): LightRig {
  // 空の照り返し（上＝空の青、下＝芝の緑）。トゥーンの陰の側がこの色に寄る
  const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x5b7a4a, 1.35);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff4e0, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = SUN_DISTANCE * 2;
  scene.add(sun);
  scene.add(sun.target);

  // 影のカメラの軸（太陽の向きが固定なので一度だけ求める）。注視点をテクセルの格子に
  // 揃えるのに使う＝カメラが滑らかに動いても影の縁がちらつかない
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(up, SUN_DIRECTION).normalize();
  const upInLight = new THREE.Vector3().crossVectors(SUN_DIRECTION, right).normalize();

  let currentView: LightingView | null = null;
  const snapped = new THREE.Vector3();

  function applyExtent(view: LightingView): void {
    const half = SHADOW_HALF_EXTENT[view];
    const cam = sun.shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.updateProjectionMatrix();
    currentView = view;
  }

  return {
    update(view, focus) {
      if (view !== currentView) applyExtent(view);
      const texel = (SHADOW_HALF_EXTENT[view] * 2) / SHADOW_MAP_SIZE;
      const a = focus.dot(right);
      const b = focus.dot(upInLight);
      snapped
        .copy(focus)
        .addScaledVector(right, Math.round(a / texel) * texel - a)
        .addScaledVector(upInLight, Math.round(b / texel) * texel - b);
      sun.target.position.copy(snapped);
      sun.position.copy(snapped).addScaledVector(SUN_DIRECTION, SUN_DISTANCE);
      sun.target.updateMatrixWorld();
    },
  };
}

/**
 * カメラが見ている地面の点（視線の中心が y=0 と交わる点）。水平に近い視線で
 * 交点が遠すぎるときは `maxDistance` で打ち切る（でっかいモードは地平線の近くを見る）。
 */
export function groundFocusOf(
  camera: THREE.Camera,
  out: THREE.Vector3,
  maxDistance = 60,
): THREE.Vector3 {
  const origin = camera.getWorldPosition(new THREE.Vector3());
  const dir = camera.getWorldDirection(new THREE.Vector3());
  if (dir.y < -1e-3) {
    const t = Math.min(-origin.y / dir.y, maxDistance);
    return out.copy(origin).addScaledVector(dir, t).setY(0);
  }
  return out.copy(origin).addScaledVector(dir, maxDistance).setY(0);
}
