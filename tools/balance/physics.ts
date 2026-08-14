/**
 * 計測の土台その3：**打球の物理そのもの**を測る道具（フェーズI-29）。
 *
 * `sim.ts`（プレーの帰結）・`sweep.ts`（打席の格子）が「ゲームとしての結果」を測るのに対し、
 * ここは「その打球は何メートル飛ぶのか」「この方角の柵を越えるには何m/s要るのか」という
 * **物理側の事実**だけを測る。定数をどちらへ動かすかを決めるときの物差しになる。
 *
 * 飛距離はすべて `stepBattedBall`（実際の打球物理そのもの）で出す＝空気抵抗の有無や
 * バウンドの扱いを別式で近似しない。
 */
import {
  type BattedBall,
  CONTACT_PLANE_Z,
  createBattedBall,
  stepBattedBall,
} from '../../src/core/batting';
import { type Ballpark, fenceAt } from '../../src/core/ballpark';
import { SIM_DT } from './sim';

/**
 * 柵にぶつからない仮想の球場（飛距離そのものを測るため）。
 * `fenceAt` の形は使うが、距離を現実離れした値にして「越えたら終わり」を無効化する。
 */
export const FAR_PARK: Ballpark = {
  id: 'tokorozawa',
  name: '(無限)',
  center: 500,
  wing: 500,
  note: '',
  sectors: [],
  luckyZone: null,
  runningHomerDistance: null,
  skyColor: 0,
};

/** 初速・打ち上げ角・方向から打球の初速ベクトルを作る（judgeSwing と同じ座標系） */
export function launchFrom(
  exitSpeed: number,
  launchDeg: number,
  directionDeg: number,
): { vx: number; vy: number; vz: number } {
  const launchRad = (launchDeg * Math.PI) / 180;
  const dirRad = (directionDeg * Math.PI) / 180;
  const horizontal = exitSpeed * Math.cos(launchRad);
  return {
    vx: horizontal * Math.sin(dirRad),
    vy: exitSpeed * Math.sin(launchRad),
    vz: -horizontal * Math.cos(dirRad),
  };
}

/** 柵が無いものとした飛距離 m（最初の着地点までの水平距離） */
export function carryOf(exitSpeed: number, launchDeg: number, directionDeg = 0): number {
  let ball: BattedBall = createBattedBall(launchFrom(exitSpeed, launchDeg, directionDeg), 0);
  let t = 0;
  while (ball.landing === null && t < 15) {
    ball = stepBattedBall(ball, SIM_DT, FAR_PARK);
    t += SIM_DT;
  }
  return ball.landing ? Math.hypot(ball.landing.x, ball.landing.z) : 0;
}

/** その打球がノーバウンドで柵を越えるか（実際の球場で判定） */
export function clearsFence(
  park: Ballpark,
  exitSpeed: number,
  launchDeg: number,
  directionDeg: number,
): boolean {
  let ball: BattedBall = createBattedBall(
    launchFrom(exitSpeed, launchDeg, directionDeg),
    0,
  );
  let t = 0;
  while (ball.over === null && ball.landing === null && t < 15) {
    ball = stepBattedBall(ball, SIM_DT, park);
    t += SIM_DT;
  }
  return ball.over === 'fly';
}

/**
 * その方角の柵をノーバウンドで越えるのに要る初速 m/s（二分探索）。
 * 越えられない（打ち上げ角が浅すぎる等）なら Infinity。
 */
export function requiredExitSpeed(
  park: Ballpark,
  directionDeg: number,
  launchDeg: number,
  hi = 80,
): number {
  if (!clearsFence(park, hi, launchDeg, directionDeg)) return Infinity;
  let lo = 10;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (clearsFence(park, mid, launchDeg, directionDeg)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * 本塁からその方角へ伸ばした線が柵に当たる点（距離と高さ）。
 * `fenceAt` は方角（度）を受けるので、そのまま渡すだけ。
 */
export function fenceInfo(park: Ballpark, directionDeg: number): { distance: number; height: number } {
  return fenceAt(park, directionDeg);
}

/**
 * 打球が柵の位置に達したときの高さ m（柵の高さと比べれば「あと何メートル足りないか」が出る）。
 *
 * **飛ばすのは `FAR_PARK`**（柵の無い球場）で、距離だけ実際の球場の柵と比べる。
 * 実際の球場で飛ばすと `stepBattedBall` が柵に当たった時点で場内へ押し戻してしまい、
 * 「柵に達したフレーム」を外から観測できない（跳ね返り後の座標は常に柵の内側になる）。
 */
export function heightAtFence(
  park: Ballpark,
  exitSpeed: number,
  launchDeg: number,
  directionDeg: number,
): number {
  const fence = fenceAt(park, directionDeg);
  let ball: BattedBall = createBattedBall(launchFrom(exitSpeed, launchDeg, directionDeg), 0);
  let t = 0;
  while (t < 15) {
    const prev = ball;
    ball = stepBattedBall(ball, SIM_DT, FAR_PARK);
    t += SIM_DT;
    if (Math.hypot(ball.x, ball.z) >= fence.distance) {
      return Math.max(prev.y, ball.y);
    }
    if (ball.landing !== null) return 0;
  }
  return 0;
}

/** 打球が接触した高さ（参考。CONTACT_HEIGHT と同じ） */
export const CONTACT_Z = CONTACT_PLANE_Z;
