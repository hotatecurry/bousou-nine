/**
 * ファウルフライ（フェーズBBB-79。テストプレイ「ライト方向のファウルフライの落下点に
 * CPUの野手がいたのに、捕らずにファウルになった」）。
 *
 * それまでは v1 の割り切りで**フェアの上の飛球しか捕らなかった**（`attemptCatch` の
 * 「ファウル地域上では捕らない」）。実際の野球（説明書p32「実際の野球のルールに、できるだけ
 * 合わせてあります」）と同じく、**ファウル地域でもノーバウンドで捕ればアウト**にした。
 * 捕れないのは**スタンドに入った球**だけ（`isCatchableFly`）。
 */
import { describe, expect, it } from 'vitest';
import { type BattedBallLaunch, createBattedBall, isFairPosition, stepBattedBall } from '../src/core/batting';
import { BALLPARKS, DEFAULT_BALLPARK, fenceAt } from '../src/core/ballpark';
import { isCatchableFly } from '../src/core/fielding';
import { outerWallDistance } from '../src/core/stands';
import { simulatePlay } from '../tools/balance/sim';

const DEG = Math.PI / 180;

/** 方角 deg（0=中堅・正=一塁側）・本塁からの距離 r の地点 */
const at = (deg: number, r: number) => ({ x: r * Math.sin(deg * DEG), z: -r * Math.cos(deg * DEG) });

function launchOf(speed: number, directionDeg: number, launchDeg: number): BattedBallLaunch {
  const h = speed * Math.cos(launchDeg * DEG);
  return {
    vx: h * Math.sin(directionDeg * DEG),
    vy: speed * Math.sin(launchDeg * DEG),
    vz: -h * Math.cos(directionDeg * DEG),
  };
}

/** その打球が最初に地面へ着く地点 */
function landingOf(launch: BattedBallLaunch): { x: number; z: number } {
  let b = createBattedBall(launch, 0);
  for (let i = 0; i < 2000 && b.landing === null; i += 1) b = stepBattedBall(b, 1 / 60, DEFAULT_BALLPARK);
  return b.landing!;
}

describe('isCatchableFly：捕れるのは壁の内側（スタンドに入った球は捕れない）', () => {
  it('ファウル地域でも壁の内側なら捕れる', () => {
    for (const park of BALLPARKS) {
      for (const deg of [50, 60, 90, 135, 180, -50, -60, -90, -135]) {
        const wall = outerWallDistance(park, deg);
        const inside = at(deg, wall - 0.5);
        const stands = at(deg, wall + 0.5);
        expect(isFairPosition(inside.x, inside.z)).toBe(false);
        expect(isCatchableFly(park, inside.x, inside.z)).toBe(true);
        expect(isCatchableFly(park, stands.x, stands.z)).toBe(false);
      }
    }
  });

  it('フェアの飛球はフェンスの内側にいる間は必ず捕れる（これまでとまったく同じ）', () => {
    for (const park of BALLPARKS) {
      for (let deg = -45; deg <= 45; deg += 5) {
        const fence = fenceAt(park, deg).distance;
        for (const r of [5, fence / 2, fence - 0.5]) {
          const p = at(deg, r);
          expect(isCatchableFly(park, p.x, p.z)).toBe(true);
        }
      }
    }
  });
});

describe('ファウルフライは捕ればアウト（計測の土台＝シーンと同じ規則）', () => {
  it('ライン際の外へ上がったフライは、追いついた外野手がノーバウンドで捕る', () => {
    for (const [deg, fielder] of [
      [52, 'RF'],
      [-52, 'LF'],
    ] as const) {
      // 高く上がる（滞空4.4秒）ので、打球に反応してから走り出すCPUの外野手（BBB-83）でも届く
      const launch = launchOf(30, deg, 48);
      const land = landingOf(launch);
      // 確かにファウル地域の、壁の内側に落ちる打球
      expect(isFairPosition(land.x, land.z)).toBe(false);
      expect(isCatchableFly(DEFAULT_BALLPARK, land.x, land.z)).toBe(true);
      const play = simulatePlay(launch, 0, { park: DEFAULT_BALLPARK });
      expect(play.outcome).toEqual({ kind: 'flyout', by: fielder });
    }
  });

  it('スタンドに入るファウルは捕れずにファウル', () => {
    // 三塁側の奥（約75°）へ高く上がる打球＝ファウル地域の柵（約32m）を越えてスタンドへ
    const launch = launchOf(30, 75, 40);
    const land = landingOf(launch);
    expect(isCatchableFly(DEFAULT_BALLPARK, land.x, land.z)).toBe(false);
    expect(simulatePlay(launch, 0, { park: DEFAULT_BALLPARK }).outcome).toEqual({ kind: 'foul' });
  });
});
