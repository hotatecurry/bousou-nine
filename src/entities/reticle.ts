/**
 * 銃モードの照準（レティクル）のプレースホルダー表現。
 * 命中時のシリアス演出（コミカルにしない）とトーンを揃え、赤系の十字＋リングのみで
 * 過度な装飾はしない。
 *
 * **他の物体に隠されない**（`depthTest: false`）。照準は本塁上（PLATE_Z）に置くが、
 * 打者は本塁のわずかに手前（z=0.2）に立つので、素直に描くと**狙いを打者に合わせた瞬間に
 * 照準が打者の体の裏へ回り込んで消える**（フェーズF-26-2の実機検証で判明。命中させる
 * ときだけ照準が見えないという、いちばん困る消え方をしていた）。CPUの銃の予兆
 * （CLAUDE.md ⑧）は「どこを狙われているか見えていること」が要件なので、照準だけは
 * 深度に関わらず最前面へ描く（HUDと同じ扱い）。
 */
import * as THREE from 'three';

/** 照準を最前面に描くための描画順（シーン内の他の物体より後に描く） */
const RETICLE_RENDER_ORDER = 999;

export function createReticle(): THREE.Group {
  const group = new THREE.Group();
  const barMat = new THREE.MeshBasicMaterial({
    color: 0xff2a2a,
    depthTest: false,
    depthWrite: false,
  });

  const hBar = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.045, 0.045), barMat);
  group.add(hBar);
  const vBar = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.55, 0.045), barMat);
  group.add(vBar);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.22, 0.27, 24),
    new THREE.MeshBasicMaterial({
      color: 0xff2a2a,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      depthWrite: false,
    }),
  );
  group.add(ring);

  for (const child of group.children) child.renderOrder = RETICLE_RENDER_ORDER;
  group.visible = false;
  return group;
}
