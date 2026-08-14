/**
 * 調整の当たりを付けるための小さい実験（フェーズI-29）。**レポート（report.ts）が
 * 全体を並べるのに対し、こちらは1つの問いだけを速く回す**。
 *
 *   npm run balance:exp
 *
 * いま見ているのは「タイミングと打球の質の関係」＝どれだけの当たりが柵に届くか。
 */
import { BALLPARKS, DEFAULT_BALLPARK } from '../../src/core/ballpark';
import {
  LAUNCH_BASE_DEG,
  SWING_ACTIVE_SEC,
  SWING_IDEAL_SEC,
  judgeSwing,
} from '../../src/core/batting';
import { cpuSwingLead } from '../../src/core/cpuBatter';
import { SPEED_FAST, SPEED_NEUTRAL, SPEED_SLOW } from '../../src/core/pitch';
import { simulatePlay } from './sim';
import { heightAtFence, requiredExitSpeed } from './physics';
import { pct, summarize, sweep } from './sweep';

const hitter = (power: number) => ({ power, average: 0.5 });


console.log('\n-- 球場×長打力のHR率（基準速36m/s） --');
for (const park of BALLPARKS) {
  const cells = [0, 0.25, 0.5, 0.75, 1].map((p) => {
    const s = summarize(sweep({ park, batter: hitter(p), steps: 10 }));
    return pct(s.homerunRate).padStart(7);
  });
  console.log(`${park.name.padEnd(8)} ${cells.join(' ')}`);
}
console.log(`${'長打力'.padEnd(8)} ${['0.00', '0.25', '0.50', '0.75', '1.00'].map((s) => s.padStart(7)).join(' ')}`);

console.log('\n-- ところざわ・長打力0.5：安打率とアウトの内訳 --');
for (const [label, speed] of [
  ['基準36', SPEED_NEUTRAL],
  ['速球42', SPEED_FAST],
] as const) {
  const s = summarize(sweep({ park: DEFAULT_BALLPARK, batter: hitter(0.5), pitchSpeed: speed, steps: 10 }));
  console.log(
    `${label} HR ${pct(s.homerunRate)} / 安打 ${pct(s.hitRate)} / フライ ${pct(
      s.flyout / s.inPlay,
    )} / ゴロ ${pct(s.groundout / s.inPlay)} / ファウル ${pct(s.foul / s.total)}`,
  );
}

console.log('\n-- 芯の当たりが柵に届くか（ところざわ・打ち上げ角21°） --');
for (const deg of [0, 10, 15, 20, 25, 30, 40]) {
  const need = requiredExitSpeed(DEFAULT_BALLPARK, deg, LAUNCH_BASE_DEG);
  const h = heightAtFence(DEFAULT_BALLPARK, 43, LAUNCH_BASE_DEG, deg);
  console.log(
    `${String(deg).padStart(3)}° 必要初速 ${need.toFixed(1)} / 43m/s のときの柵での高さ ${h.toFixed(2)}m（柵4m）`,
  );
}

// CPU打者は「押してからジャストミートまでの理想時間」で振る（cpuSwingLead）。速球には
// わざと早振りのペナルティが乗るので、**CPUが実際に作るタイミングは1点に決まる**
// ＝そこがHRになっていないかを見る（過去に「CPUが速球を100%HRにする」事故がある）。
console.log('\n-- CPU打者が実際に作るタイミングと帰結（course=0） --');
for (const [label, speed] of [
  ['フォーク22', SPEED_SLOW],
  ['基準36', SPEED_NEUTRAL],
  ['速球42', SPEED_FAST],
] as const) {
  const timing = (cpuSwingLead(speed) - SWING_IDEAL_SEC) / (SWING_ACTIVE_SEC / 2);
  for (const power of [0.5, 1]) {
    const launch = judgeSwing(
      { crossX: 0, swingTime: cpuSwingLead(speed), pitchSpeed: speed },
      { power, average: 0.5 },
    );
    if (!launch) {
      console.log(`${label} 長打力${power}: 空振り`);
      continue;
    }
    const r = simulatePlay(launch, 0, { park: DEFAULT_BALLPARK });
    console.log(
      `${label} 長打力${power}: t=${timing.toFixed(2)} 方向${r.directionDeg
        .toFixed(0)
        .padStart(4)}° 初速${r.exitSpeed.toFixed(1)} → ${r.outcome.kind}`,
    );
  }
}

console.log('\n-- タイミングごとの初速（ところざわ・長打力0.5・course=0） --');
const line = sweep({ park: DEFAULT_BALLPARK, batter: hitter(0.5), steps: 10 }).filter(
  (s) => s.course === 0,
);
for (const s of line) {
  if (s.timing < 0) continue;
  console.log(
    `t=${s.timing.toFixed(1)} 方向${s.result.directionDeg.toFixed(0).padStart(4)}° 初速${s.result.exitSpeed
      .toFixed(1)
      .padStart(5)} 飛距離${s.result.carry.toFixed(0).padStart(4)} ${s.result.outcome.kind}`,
  );
}
