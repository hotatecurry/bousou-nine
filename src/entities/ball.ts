/**
 * ボールのプレースホルダー。投球・打球の物理は後続セッションで実装する。
 */
import * as THREE from 'three';

export function createBall(): THREE.Mesh {
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.4, 12, 12),
    new THREE.MeshLambertMaterial({ color: 0xffffff }),
  );
  ball.visible = false;
  return ball;
}
