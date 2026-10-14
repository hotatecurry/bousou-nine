/**
 * 読みの札が見せるもの（フェーズYY-73。`SkillSight`）の中身を起こす純粋関数。
 *
 * **CPU投手が投げる前に決めた形（`CpuPitchPlan`＋`CpuPitchShape`）をそのまま読む**＝
 * 見せる軌道・通過点は、実際に飛ぶ球と**同じ関数**（`createPitchFlight`・`stepPitchFlight`・
 * `cpuSteerAccelAt`・`pitchLineHeight`）から起こす。予言が外れることは構造的に無い
 * （「見えた場所と違うところへ来た」は起きない）。**判定には一切触らない**。
 *
 * 人間が投げる球（2P PLAY）は投げる前に形が無いので、ここでは読めない＝読みの札は
 * **CPU投手に対して**働く（1P PLAY の打席がほとんど）。
 */
import { dekkaiPitchLook } from './camera';
import { type CpuPitchPlan, type CpuPitchShape, cpuSteerAccelAt } from './cpuPitcher';
import {
  type BatterSide,
  type PitchStall,
  CATCH_Z,
  PLATE_Z,
  createPitchFlight,
  stepPitchFlight,
} from './pitch';
import type { SkillSight } from './skills';

export interface SightPoint {
  x: number;
  y: number;
  z: number;
}

/** 軌道を刻む間隔（秒）。画面で滑らかに見える細かさ */
const PATH_DT = 1 / 120;

/**
 * CPU投手の球の軌道（リリースからミットまで）。**実際の飛行と同じ手順**で刻む
 * （`tools/balance/atbat.ts` の `simulatePitch` と同じ並び）。
 *
 * **通り道だけを刻む**ので飛行の時計（フェーズBBB-76の `rate`）は渡さない＝球速どおりの
 * 時間で刻んでも、どこを通るかは時計を速めた本物の球と同じ。**点は描く球と同じ関数
 * （`dekkaiPitchLook`）で置く**＝**線の上を球が通る**（フォークが手元で落ちる形も同じ。BBB-77）。
 *
 * @param stall フォークの手元の失速（`pitchStallFor`）。落ちる形を描くのに使う
 */
export function predictCpuPitchPath(
  shape: CpuPitchShape,
  releaseHeight: number,
  stall?: PitchStall,
): SightPoint[] {
  // 逆を突く球（フェーズBBB-84）はリリースの瞬間から横へ動く＝その横速度も実際の球と同じ値
  let flight = createPitchFlight(shape.releaseX, shape.speed, shape.releaseVx);
  const points: SightPoint[] = [];
  const push = (): void => {
    const c = dekkaiPitchLook(stall ? { ...flight, stall } : flight, releaseHeight).center;
    points.push({ x: c.x, y: c.y, z: c.z });
  };
  push();
  let since = 0;
  for (let i = 0; i < 600 && flight.z < CATCH_Z; i++) {
    since += PATH_DT;
    const accel = cpuSteerAccelAt(shape, since - PATH_DT, PATH_DT);
    flight = stepPitchFlight(flight, shape.steerX, PATH_DT, accel);
    push();
  }
  return points;
}

/** 軌道のうち本塁を通る点（なければ最後の点） */
export function plateCrossing(path: readonly SightPoint[]): SightPoint {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    if (a.z <= PLATE_Z && b.z >= PLATE_Z) {
      const k = (PLATE_Z - a.z) / Math.max(1e-9, b.z - a.z);
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: PLATE_Z };
    }
  }
  return path[path.length - 1];
}

/** 球種の読み（速球・普通・フォーク） */
export function speedReading(plan: CpuPitchPlan): string {
  return plan.speed === 'fast' ? '速球' : plan.speed === 'slow' ? 'フォーク' : '直球';
}

/**
 * コースの読み（内角・真ん中・外角）。**打者から見た**言い方＝打者の立つ側（`BatterSide`
 * の符号の側）が内角。真ん中の幅は狙いの揺れより広く取る（0.15m）。
 */
export function courseReading(targetX: number, side: BatterSide): string {
  if (Math.abs(targetX) < 0.15) return '真ん中';
  return Math.sign(targetX) === side ? '内角' : '外角';
}

/** 読みの文字（持っている札の読みだけを並べる。何も読めなければ null） */
export function readingText(
  plan: CpuPitchPlan,
  sight: SkillSight,
  side: BatterSide,
): string | null {
  const parts: string[] = [];
  if (sight.speed) parts.push(speedReading(plan));
  if (sight.course) parts.push(courseReading(plan.targetX, side));
  return parts.length > 0 ? `読み: ${parts.join('・')}` : null;
}

/**
 * 時間停止（`時間停止`・`絶対予知`）で**時間が遅くなる区間**：本塁の手前これだけの距離から
 * 本塁までの間（メートル）。打者が振るかを決める時間帯（接触の0.2秒前ほど）を含む長さ。
 *
 * **フェーズBBB-76で 7→9m**：球が原作の速さ（球速どおりの1.3倍）で飛ぶようになったので、
 * 同じ距離では遅くなる時間が短くなる。基準速の球で**従来と同じ長さ**（ゲームの時計で
 * 約0.2秒＝遅くなっている間の実時間では約0.45秒）を覆う距離に広げた（7m × 1.3。
 * 実機：本塁の手前8.7mから1フレームの進みが 0.81m→0.37m に落ちる）。
 */
export const SLOW_ZONE_METERS = 9;
/** 時間停止の間の時間の速さ（実時間に対する倍率） */
export const SLOW_TIME_SCALE = 0.45;

/** いま時間が遅くなっているべきか（球のz位置から） */
export function inSlowZone(ballZ: number): boolean {
  return ballZ > PLATE_Z - SLOW_ZONE_METERS && ballZ < PLATE_Z + 0.4;
}
