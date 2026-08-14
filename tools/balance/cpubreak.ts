/**
 * CPU投手の変化球（フェーズP-37）の計測。
 *
 *   npm run balance:cpubreak
 *
 * K-31・L-32・N-34・O-36と同じ手順で、**入れる前に測って値を決める**
 * （CLAUDE.md「バランス調整の方針＝勘で動かさず必ず計測してから決める」）。
 * ここで決めたいのは1つ、確かめたいのは3つ：
 *
 * - 決めたい：**`CPU_BREAK_STEER_SEC`（CPUが十字キーを倒し続ける長さ）**。
 *   長いと名鑑の上位がプレートの幅で頭打ちになり（R/L・F の差が消える）、
 *   短いと曲がりがゾーン半幅にも届かない（入れた意味が無い）。
 * - 確かめたい：(1) 名鑑96人の変化量が**実際に球の差になるか**、
 *   (2) **打者に理不尽でないか**（桜井ノウハウ「人に反応できない動作をするとすっごい
 *   理不尽感がある」）、(3) **本塁通過位置が逆算どおりか**（＝I-29で測った
 *   打たれ方の分布を動かしていないこと）。
 *
 * 判定・逆算は `src/core` の純粋関数をそのまま呼ぶ（このファイルに式は書かない）。
 */
import {
  CPU_BREAK_STEER_SEC,
  type CpuPitchPlan,
  chooseCpuPitchPlan,
  cpuSteerAccelAt,
  planCpuPitchShape,
} from '../../src/core/cpuPitcher';
import {
  BATTER_STANCE_RANGE,
  BATTER_ZONE_MIN_X,
  NEUTRAL_PITCH_PROFILE,
  type PitchProfile,
  PLATE_Z,
  RUBBER_HALF_RANGE,
  STRIKE_ZONE_HALF_WIDTH,
  createPitchFlight,
  plateCrossingX,
  stepPitchFlight,
} from '../../src/core/pitch';
import { BAT_REACH_INSIDE_X, BAT_REACH_OUTSIDE_X } from '../../src/core/batting';
import { TEAMS, pitcherRowPitching } from '../../src/core/teams';

const row = (cells: readonly string[], w = 12): string => cells.map((c) => c.padStart(w)).join('');
const m = (v: number): string => `${v.toFixed(2)}m`;

/** 代表的なカウント（`chooseCpuPitchPlan` が返す3種の方針をすべて含む） */
const COUNTS = [
  { label: '0-0 初球', count: { balls: 0, strikes: 0 } },
  { label: '1-0', count: { balls: 1, strikes: 0 } },
  { label: '0-1', count: { balls: 0, strikes: 1 } },
  { label: '0-2 追い込み', count: { balls: 0, strikes: 2 } },
  { label: '3-1 四球回避', count: { balls: 3, strikes: 1 } },
] as const;

/** 変化量レーティングだけを差し替えた投手（球速は基準のまま＝比較のため） */
function pitcherWithBreak(breakAmount: number): PitchProfile {
  return {
    ...NEUTRAL_PITCH_PROFILE,
    breakLeft: breakAmount,
    breakRight: breakAmount,
    fork: breakAmount,
  };
}

console.log('\n=== 1. プレートが吸収できる曲がりの幅（＝曲がりの上限） ===');
console.log('   リリース位置は プレート上（±%sm）にしか置けないので、'.replace('%s', String(RUBBER_HALF_RANGE)));
console.log('   狙うコースから戻せる距離＝ |狙い| + プレート半幅 が曲がりの上限になる。');
console.log(`${'カウント'.padEnd(16)}${row(['狙うコース', '曲げる向き', '曲がりの上限'])}`);
for (const { label, count } of COUNTS) {
  const plan = chooseCpuPitchPlan(count);
  const dir = plan.targetX > 0 ? '内(+)' : plan.targetX < 0 ? '外(-)' : '曲げない';
  const budget = plan.targetX === 0 ? 0 : Math.abs(plan.targetX) + RUBBER_HALF_RANGE;
  console.log(
    `${label.padEnd(16)}` +
      row([m(plan.targetX), dir, plan.targetX === 0 ? '-' : m(budget)]),
  );
}
console.log('   ※ど真ん中狙い（3ボール後の四球回避）は曲げない＝追い込まれたCPUは素直な球。');

console.log('\n=== 2. 倒し続ける長さ ts の候補（曲がり幅 m。★＝プレートの幅で頭打ち） ===');
console.log('   変化量レーティング 0.0 / 0.5 / 1.0 の投手が、0-1（緩急=遅い球＝フォーク）と');
console.log('   0-0（速球）でどれだけ曲げられるか。頭打ちになると能力値の差が消える。');
const TS_CANDIDATES = [0.05, 0.06, 0.08, 0.1, 0.12, 0.15] as const;
const RATINGS = [0, 0.5, 1] as const;
function breakCell(plan: CpuPitchPlan, rating: number, ts: number): string {
  const shape = planCpuPitchShape(plan, pitcherWithBreak(rating), ts);
  const budget = Math.abs(plan.targetX) + RUBBER_HALF_RANGE;
  const capped = shape.breakWidth >= budget - 1e-6;
  return `${shape.breakWidth.toFixed(2)}${capped ? '★' : ' '}`;
}
const slowPlan = chooseCpuPitchPlan({ balls: 0, strikes: 1 }); // speed: 'slow'（F を使う）
const fastPlan = chooseCpuPitchPlan({ balls: 0, strikes: 0 }); // speed: 'fast'（R/L を使う）
console.log(
  `${'ts'.padEnd(8)}${row(['遅0.0', '遅0.5', '遅1.0', '速0.0', '速0.5', '速1.0'], 8)}`,
);
for (const ts of TS_CANDIDATES) {
  const cells = [
    ...RATINGS.map((r) => breakCell(slowPlan, r, ts)),
    ...RATINGS.map((r) => breakCell(fastPlan, r, ts)),
  ];
  const tag = ts === CPU_BREAK_STEER_SEC ? ' ←採用' : '';
  console.log(`${`${ts}s`.padEnd(8)}${row(cells, 8)}${tag}`);
}
console.log(`   参考：ストライクゾーン半幅 ${STRIKE_ZONE_HALF_WIDTH}m ／ 打席内の可動幅 ±${BATTER_STANCE_RANGE}m`);
console.log(`         バットの到達範囲 内角 ${BAT_REACH_INSIDE_X}m・外角 ${BAT_REACH_OUTSIDE_X}m`);

console.log('\n=== 3. 名鑑96人：変化量が実際に球の差になっているか（採用 ts） ===');
const pitchers = TEAMS.flatMap((t) =>
  t.pitchers.map((r) => ({ name: r[0] as string, team: t.name, stats: pitcherRowPitching(r) })),
);
function profileOf(p: (typeof pitchers)[number]): PitchProfile {
  return {
    speed: p.stats.speed,
    breakLeft: p.stats.breakLeft,
    breakRight: p.stats.breakRight,
    fork: p.stats.fork,
  };
}
const scored = pitchers.map((p) => {
  const prof = profileOf(p);
  return {
    ...p,
    fork: planCpuPitchShape(slowPlan, prof).breakWidth,
    fast: planCpuPitchShape(fastPlan, prof).breakWidth,
  };
});
console.log('   ts の候補ごとに、名鑑の変化量がどれだけ球の差になるかを見る。');
console.log('   **頭打ちの人数が増えるほど「F の高い投手」の値打ちが消える**（そこが決め手）。');
console.log(`${'ts'.padEnd(8)}${row(['フォーク最小', 'フォーク最大', '頭打ち', '速球最小', '速球最大'], 14)}`);
for (const ts of TS_CANDIDATES) {
  const f = pitchers.map((p) => planCpuPitchShape(slowPlan, profileOf(p), ts).breakWidth);
  const s = pitchers.map((p) => planCpuPitchShape(fastPlan, profileOf(p), ts).breakWidth);
  const cap = Math.abs(slowPlan.targetX) + RUBBER_HALF_RANGE;
  const capped = f.filter((v) => v >= cap - 1e-6).length;
  console.log(
    `${`${ts}s`.padEnd(8)}` +
      row(
        [
          m(Math.min(...f)),
          m(Math.max(...f)),
          `${capped}人`,
          m(Math.min(...s)),
          m(Math.max(...s)),
        ],
        14,
      ) +
      (ts === CPU_BREAK_STEER_SEC ? ' ←採用' : ''),
  );
}

console.log('');
const sorted = [...scored].sort((a, b) => b.fork - a.fork);
console.log(`${'投手'.padEnd(10)}${'球団'.padEnd(14)}${row(['F', 'R', 'SPD', 'フォークの曲がり', '速球の曲がり'])}`);
for (const p of [...sorted.slice(0, 3), ...sorted.slice(-3)]) {
  console.log(
    `${p.name.padEnd(10)}${p.team.padEnd(14)}` +
      row([
        p.stats.fork.toFixed(2),
        p.stats.breakRight.toFixed(2),
        p.stats.speed.toFixed(2),
        m(p.fork),
        m(p.fast),
      ]),
  );
}
const forks = scored.map((p) => p.fork);
const fasts = scored.map((p) => p.fast);
const cappedCount = scored.filter(
  (p) => p.fork >= Math.abs(slowPlan.targetX) + RUBBER_HALF_RANGE - 1e-6,
).length;
console.log(
  `\nフォークの曲がり：${m(Math.min(...forks))} 〜 ${m(Math.max(...forks))}` +
    `（差 ${m(Math.max(...forks) - Math.min(...forks))} ＝ ゾーン半幅の ${((Math.max(...forks) - Math.min(...forks)) / STRIKE_ZONE_HALF_WIDTH).toFixed(1)}倍）`,
);
console.log(
  `速球の曲がり　：${m(Math.min(...fasts))} 〜 ${m(Math.max(...fasts))}` +
    `（差 ${m(Math.max(...fasts) - Math.min(...fasts))}）`,
);
console.log(`プレートの幅で頭打ちになる投手：${cappedCount} / ${scored.length}人`);

console.log('\n=== 4. 打者から見て：リリース位置はもう「答え」ではない ===');
console.log('   P-37より前は **リリース位置＝本塁通過位置**（CPUの球は必ず直線）だった＝');
console.log('   打者は投げる前から来るコースを知っていた。曲がる幅がそのまま「嘘の量」になる。');
console.log(`${'カウント'.padEnd(16)}${row(['リリース位置', '本塁通過', '嘘の量', 'ゾーン半幅比', '可動幅比'])}`);
for (const { label, count } of COUNTS) {
  const plan = chooseCpuPitchPlan(count);
  const shape = planCpuPitchShape(plan);
  console.log(
    `${label.padEnd(16)}` +
      row([
        m(shape.releaseX),
        m(plan.targetX),
        m(shape.breakWidth),
        (shape.breakWidth / STRIKE_ZONE_HALF_WIDTH).toFixed(2),
        (shape.breakWidth / BATTER_STANCE_RANGE).toFixed(2),
      ]),
  );
}

console.log('\n=== 5. 理不尽でないこと：球は飛行のどこで曲がり終わるか ===');
console.log('   スイングは接触の 0.09秒前（SWING_IDEAL_SEC）に押す必要があり、人の反応を');
console.log('   足すと判断は 0.25秒ほど前。そこまでに曲がり終わっていれば「見てから」間に合う。');
console.log(`${'カウント'.padEnd(16)}${row(['飛行時間', '曲げ終わり', '飛行の', '判断時点で', '直線外挿の誤差'])}`);
for (const { label, count } of COUNTS) {
  const plan = chooseCpuPitchPlan(count);
  const shape = planCpuPitchShape(plan);
  if (shape.steerX === 0) {
    console.log(`${label.padEnd(16)}${row([`${shape.flightSec.toFixed(2)}s`, '曲げない', '-', '-', '0.00m'])}`);
    continue;
  }
  const decideAt = Math.max(0, shape.flightSec - 0.25);
  // 判断時点の位置と速度から直線で外挿した本塁通過位置（＝打者の読み）
  const vxAt = shape.steerAccel * Math.min(decideAt, shape.steerSec) * shape.steerX;
  const xAt =
    shape.releaseX +
    shape.steerX *
      (0.5 * shape.steerAccel * Math.min(decideAt, shape.steerSec) ** 2 +
        Math.abs(vxAt) * Math.max(0, decideAt - shape.steerSec));
  const guess = xAt + vxAt * (shape.flightSec - decideAt);
  console.log(
    `${label.padEnd(16)}` +
      row([
        `${shape.flightSec.toFixed(2)}s`,
        `${shape.steerSec.toFixed(3)}s`,
        `${((shape.steerSec / shape.flightSec) * 100).toFixed(0)}%`,
        m(xAt),
        m(Math.abs(guess - plan.targetX)),
      ]),
  );
}
console.log('   → 曲がり切った後は等速なので、判断時点からの直線外挿は誤差ゼロで当たる＝');
console.log('     **「見てから振れる」まま**。変わったのは「投げる前に分かる」ほうだけ。');

console.log('\n=== 6. 逆算どおりに届くか＋死球ゾーンへ暴走しないか（実際に飛ばして確かめる） ===');
console.log('   シーン層と同じ stepPitchFlight を回す（フレームレートを変えても狙いは動かない）。');
function fly(shape: ReturnType<typeof planCpuPitchShape>, fps: number) {
  const dt = 1 / fps;
  let f = createPitchFlight(shape.releaseX, shape.speed, 0);
  let t = 0;
  let maxAbsX = Math.abs(f.x);
  for (let i = 0; i < 600; i += 1) {
    const accel = cpuSteerAccelAt(shape, t, dt);
    const next = stepPitchFlight(f, shape.steerX, dt, accel);
    t += dt;
    maxAbsX = Math.max(maxAbsX, Math.abs(next.x));
    const cross = plateCrossingX(f, next);
    if (cross !== null) return { cross, maxAbsX };
    f = next;
  }
  throw new Error('本塁を通過しなかった（テストの前提が崩れている）');
}
console.log(`${'カウント'.padEnd(16)}${row(['狙い', '60fps', '誤差', '30fps', '飛行中の最大|X|'])}`);
let worstError = 0;
let worstAbsX = 0;
for (const { label, count } of COUNTS) {
  const plan = chooseCpuPitchPlan(count);
  // いちばん大きく曲げる投手（変化量1.0）で見る＝誤差も暴走も最悪値になる
  const shape = planCpuPitchShape(plan, pitcherWithBreak(1));
  const a = fly(shape, 60);
  const b = fly(shape, 30);
  worstError = Math.max(worstError, Math.abs(a.cross - plan.targetX), Math.abs(b.cross - plan.targetX));
  worstAbsX = Math.max(worstAbsX, a.maxAbsX);
  console.log(
    `${label.padEnd(16)}` +
      row([m(plan.targetX), m(a.cross), m(Math.abs(a.cross - plan.targetX)), m(b.cross), m(a.maxAbsX)]),
  );
}
console.log(
  `\n最大の誤差 ${m(worstError)}（隅を突く上乗せ 0.05m・ゾーン半幅 ${STRIKE_ZONE_HALF_WIDTH}m と比べる）`,
);
console.log(
  `飛行中の最大|X| ${m(worstAbsX)} ＜ 死球ゾーンの下端 ${BATTER_ZONE_MIN_X}m` +
    `（打者に当たりようがない＝bang-bang制御で恐れていた暴走が構造的に起きない）`,
);
console.log(`\n（本塁 z=${PLATE_Z} ／ プレート半幅 ±${RUBBER_HALF_RANGE}m）`);
