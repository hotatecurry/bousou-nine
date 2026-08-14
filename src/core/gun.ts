/**
 * 銃システムの純粋ロジック（照準移動・発射判定のみ、状態は持たない）。
 *
 * ファミスタ拡張仕様（CLAUDE.md ③銃システム）準拠：
 * - 命中判定は完全スキル依存。乱数は一切介在しない（照準Xが打者ゾーンに
 *   合っていれば必中、打者側に回避手段はない）。
 * - 外れた場合は通常の投球判定と同じ扱い（＝本塁通過位置によるストライク/ボール）。
 *
 * 投球（pitch.ts）は「リリース位置→曲がり」のモデルだが、銃は照準そのものが
 * 本塁上の狙い位置になる直接照準モデル。ただし判定に使うゾーン（ストライクゾーン・
 * 打者ゾーン）は pitch.ts のものをそのまま流用する（同じ物理的なゾーンを
 * 投球と銃で二重定義しないため）。
 *
 * 座標系は pitch.ts / field.ts と同一（本塁原点、+X=一塁側）。
 * でっかいモードのカメラは-Zを向く（本塁後方から投手方向を見る）ため
 * 「画面上の左右」とワールドXは同じ向きになる（反転不要。この対応関係は
 * シーン層が担う。ここではワールド座標のみ扱う）。
 */
import {
  type BatterSide,
  type PitchCall,
  RIGHT_BATTER_SIDE,
  batterStandX,
  judgePitch,
} from './pitch';

/** 照準の可動範囲（±X）。打者ゾーンの外側にも十分な余白を持たせ、
 *  「漠然と真ん中に構えれば当たる」にならないシビアさを確保する。 */
export const GUN_AIM_HALF_RANGE = 2.4;
/** 照準の左右移動速度 m/s */
export const GUN_AIM_MOVE_SPEED = 3.2;
/** 銃モードに入った直後・発射直後の照準初期位置（ストライクゾーン中央） */
export const GUN_AIM_INITIAL_X = 0;

/** 発射結果。'hitByPitch' = 命中（死球）、それ以外は通常の投球判定と同じ意味。 */
export type GunShotResult = PitchCall;

export function clampAimX(x: number): number {
  return Math.max(-GUN_AIM_HALF_RANGE, Math.min(GUN_AIM_HALF_RANGE, x));
}

/** 1フレーム分の照準移動。十字キー左右の直接位置操作（投球前のプレート移動と同じ方式）。 */
export function stepAimX(x: number, steerX: -1 | 0 | 1, dt: number): number {
  return clampAimX(x + steerX * GUN_AIM_MOVE_SPEED * dt);
}

/**
 * 発射判定。照準X（本塁上の狙い位置）から結果を決める。
 * - 打者ゾーン内 → 必中（'hitByPitch'）
 * - ストライクゾーン内 → 見逃し扱いの 'strike'
 * - それ以外 → 'ball'
 * pitch.ts の judgePitch と同一ゾーンを使う薄いラッパー（意図の明示と、
 * 将来ゾーンを分離する場合の変更点をここに閉じ込めるため）。
 *
 * side（打席の左右。フェーズB-9）も judgePitch にそのまま渡す：**左打者は反対側に
 * 立っているので、狙う先も反対側になる**（照準を合わせ直さないと当たらない）。
 *
 * stance（打席内の立ち位置。フェーズO-36）も同じ：**打者が寄れば命中ゾーンも寄る**。
 * 撃たれる側から見れば、離れて立つことが銃に対する（わずかな）距離取りにもなる。
 */
export function judgeShot(
  aimX: number,
  side: BatterSide = RIGHT_BATTER_SIDE,
  stance = 0,
): GunShotResult {
  return judgePitch(aimX, side, stance);
}

/**
 * 打者のど真ん中を狙う照準X（フェーズF-26-2。CPU投手が撃つときの狙い）。
 *
 * **見た目の立ち位置と同じ関数（`batterStandX`）から求める**ので、打席の左右が反転しても、
 * 死球ゾーンの広さを調整しても、**打者が打席内で動いても**（フェーズO-36）、狙いは必ず
 * 打者の中心に乗る（B-9で見た目の立ち位置と死球ゾーンを同じ定数から求めたのと同じ整理）。
 *
 * CPUの照準は人間のように動かないので、**構えた時点で必中が確定している**。
 * これは理不尽ではなく仕様として見せる側の問題で、だからこそ CLAUDE.md ⑧の
 * 「CPUが撃つときは予兆を必ず付ける」がセットになる（予兆の間、この照準が打者の上に
 * 出ているので、どこを狙われているかは見えている）。
 */
export function batterAimX(side: BatterSide = RIGHT_BATTER_SIDE, stance = 0): number {
  return clampAimX(batterStandX(side, stance));
}
