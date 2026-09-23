/**
 * ボールの供給口（`entities/player.ts`・`entities/props.ts` と同じ立て方＝呼び出し側は
 * 「球のメッシュをもらう」だけを知る）。
 *
 * **ジオメトリは実寸**（フェーズNN-61。それまでは半径0.4m＝実寸の10.9倍のプレースホルダー
 * だった）。**画面でどれだけ大きく見えるかはモードごとに決める**：ちっちゃいモードは
 * 倍率（`CHICCHAI_BALL_SCALE`）、でっかいモードは距離補正（`dekkaiBallScale`）で、
 * どちらも `core/camera.ts` に選手の縮尺（`CHICCHAI_PLAYER_SCALE`）と並べて置いてある
 * ＝**「何がどれだけ大きく映るか」の調整先を散らさない**。
 */
import * as THREE from 'three';
import { BALL_RADIUS } from '../core/camera';
import { addOutline, createToonMaterial } from '../render/toon';

export function createBall(): THREE.Mesh {
  // トゥーン調（ブラッシュアップ：グラフィック）。**縁取りが要るのはボールがいちばん**：
  // 白い球は明るい空・白いユニフォームの前で溶けるので、1ドットの縁で輪郭を残す。
  // 影は落とさない（鳥瞰の高さの手がかりは真下の影 `ballShadow` が別に持っている＝
  // 斜めに落ちる本物の影と2つ並ぶと、どちらが落下点か読めなくなる）。
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(BALL_RADIUS, 20, 14),
    createToonMaterial({ color: 0xfbfbf4 }),
  );
  addOutline(ball, { worldWidth: 0.012, minPx: 1, maxPx: 2 });
  ball.visible = false;
  return ball;
}
