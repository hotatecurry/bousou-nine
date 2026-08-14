/**
 * フォークの変化量（F）の計測（フェーズO-35）。
 *
 *   npm run balance:fork
 *
 * F は名鑑（96人・0.38〜0.90）に最初から入っていたが**読む側が1つも無かった**ため、
 * 接続にあたって「F の高い投手は実際に有利なのか」を測る（CLAUDE.md
 * 「バランス調整の方針＝勘で動かさず必ず計測してから決める」）。
 *
 * ## 最初の設計（F＝緩急の幅）は、この計測が否定した
 *
 * 打球初速は `0.5 × 球速` を含むので、**球速を動かすと必ず打球の質が動く**：
 * 遅くすれば弱い当たりが野手の前に落ちて安打が増え、速くすれば長打が増える。
 * つまり**中庸がいちばんアウトになりやすく、幅を広げると両側とも打者有利**だった
 * （名鑑の実レンジ F 0.38→0.90 でフォークの安打率 9.7%→17.0%・速球のHR率 14.2%→27.4%）。
 * 1段目にその再現を残してある（`speedForPitchSelection` はもうFを見ないので、
 * ここでは球速を直接与えて同じ関係を確かめる）。
 *
 * ## いまの設計（F＝フォークの曲がり）
 *
 * 球速に触れないので上の副作用が構造的に生じない。2段目で「曲がりが増えると
 * どれだけコースを動かせるか」＝**打者のバットが届かないところへ逃げられるか**を見る。
 */
import {
  NEUTRAL_RATING,
  PLATE_Z,
  RELEASE_Z,
  SPEED_FAST,
  SPEED_NEUTRAL,
  SPEED_SLOW,
  STRIKE_ZONE_HALF_WIDTH,
  createPitchFlight,
  steerAccelForSelection,
  stepPitchFlight,
} from '../../src/core/pitch';
import { BAT_REACH_INSIDE_X, BAT_REACH_OUTSIDE_X } from '../../src/core/batting';
import { DEFAULT_BALLPARK } from '../../src/core/ballpark';
import { TEAMS, pitcherRowPitching } from '../../src/core/teams';
import { pct, summarize, sweep } from './sweep';

const batter = { power: 0.5, average: 0.5 };
const FORKS = [0, 0.2, 0.38, 0.5, 0.7, 0.9, 1] as const;
const row = (cells: readonly string[]): string => cells.map((c) => c.padStart(10)).join('');

console.log('\n=== 1. なぜ「F＝緩急の幅」を採らなかったか（球速を動かすと打球の質が動く） ===');
console.log('   分母は当たった打球。ところざわ・長打力0.5。');
console.log(`${'球速'.padEnd(8)}${row(['安打率', 'HR率', 'ゴロアウト', '最大飛距離'])}`);
for (const speed of [15, 19, 22, 26, 29, 36, 39, 42, 45]) {
  const s = summarize(sweep({ park: DEFAULT_BALLPARK, batter, pitchSpeed: speed, steps: 10 }));
  const tag = speed === SPEED_SLOW ? ' ←フォーク' : speed === SPEED_FAST ? ' ←速球' : speed === SPEED_NEUTRAL ? ' ←基準' : '';
  console.log(
    `${`${speed}m/s`.padEnd(8)}` +
      row([pct(s.hitRate), pct(s.homerunRate), pct(s.groundout / s.inPlay), `${s.maxCarry.toFixed(0)}m`]) +
      tag,
  );
}
console.log('   → 遅い側でも安打率が上がる（弱い当たりが野手の前に落ちる）。');
console.log('     速い側は長打が増える。**中庸がいちばんアウトになりやすい**ので、');
console.log('     緩急の幅を広げると両側とも打者有利になった＝Fの置き場所として不適。');

console.log('\n=== 2. F＝フォークの曲がり：リリース後に横へどれだけ動かせるか ===');
console.log('   リリースから本塁到達まで**曲げ続けた**ときの横移動 m（球速22m/s＝フォーク）。');
console.log('   これは上限値：実際は一瞬だけ倒して微調整するので、この数分の1しか動かない。');
console.log('   Fの比較のための指標として見る（横移動は加速度に比例するので比は同じ）。');
console.log(`${'F'.padEnd(6)}${row(['加速度', '横移動', 'ゾーン半幅比', 'バット外まで'])}`);
function lateralTravel(accel: number, speed: number): number {
  let f = createPitchFlight(0, speed, 0);
  const dt = 1 / 240;
  while (f.z < PLATE_Z) f = stepPitchFlight(f, 1, dt, accel);
  return f.x;
}
for (const fork of FORKS) {
  const accel = steerAccelForSelection(1, NEUTRAL_RATING, fork);
  const dx = lateralTravel(accel, SPEED_SLOW);
  console.log(
    `${String(fork).padEnd(6)}` +
      row([
        accel.toFixed(1),
        `${dx.toFixed(2)}m`,
        (dx / STRIKE_ZONE_HALF_WIDTH).toFixed(2),
        dx > BAT_REACH_INSIDE_X ? 'とどく' : '-',
      ]),
  );
}
console.log(`   参考：ストライクゾーン半幅 ${STRIKE_ZONE_HALF_WIDTH}m / バットの到達範囲`);
console.log(`         内角 ${BAT_REACH_INSIDE_X}m・外角 ${BAT_REACH_OUTSIDE_X}m`);

console.log('\n=== 3. 同じFでも、フォーク（遅い）ほど大きく動く（飛行時間の効果） ===');
console.log('   B-11の実測どおり横の移動量は時間の2乗で効く。Fはこの上に乗る。');
console.log(`${'F'.padEnd(6)}${row(['フォーク22', '基準36', '速球42', 'フォーク/速球'])}`);
for (const fork of FORKS) {
  const accelSlow = steerAccelForSelection(1, NEUTRAL_RATING, fork);
  const accelOther = steerAccelForSelection(0, NEUTRAL_RATING, fork);
  const slow = lateralTravel(accelSlow, SPEED_SLOW);
  const mid = lateralTravel(accelOther, SPEED_NEUTRAL);
  const fast = lateralTravel(accelOther, SPEED_FAST);
  console.log(
    `${String(fork).padEnd(6)}` +
      row([`${slow.toFixed(2)}m`, `${mid.toFixed(2)}m`, `${fast.toFixed(2)}m`, (slow / fast).toFixed(2)]),
  );
}

console.log('\n=== 4. 名鑑96人：Fが実際に生むフォークの曲がりの散らばり ===');
const pitchers = TEAMS.flatMap((t) =>
  t.pitchers.map((r) => ({ name: r[0] as string, team: t.name, ...pitcherRowPitching(r) })),
);
const scored = pitchers.map((p) => ({
  ...p,
  forkTravel: lateralTravel(steerAccelForSelection(1, p.breakRight, p.fork), SPEED_SLOW),
  breakTravel: lateralTravel(steerAccelForSelection(0, p.breakRight, p.fork), SPEED_NEUTRAL),
}));
// 接続前は「フォークも R/L で曲がる」だったので、その値も並べて差分を見る
// （接続前もフォークの横移動には散らばりがあった。無かったのは **F の効き目**のほう）。
const withBefore = scored.map((p) => ({
  ...p,
  before: lateralTravel(steerAccelForSelection(0, p.breakRight, p.fork), SPEED_SLOW),
}));
const sorted = [...withBefore].sort((a, b) => b.forkTravel - a.forkTravel);
console.log(`${'投手'.padEnd(10)}${'球団'.padEnd(14)}${row(['F', 'R/L(右)', '接続前', '接続後', '差'])}`);
for (const p of [...sorted.slice(0, 3), ...sorted.slice(-3)]) {
  const d = p.forkTravel - p.before;
  console.log(
    `${p.name.padEnd(10)}${p.team.padEnd(14)}` +
      row([
        p.fork.toFixed(2),
        p.breakRight.toFixed(2),
        `${p.before.toFixed(2)}m`,
        `${p.forkTravel.toFixed(2)}m`,
        `${d >= 0 ? '+' : ''}${d.toFixed(2)}m`,
      ]),
  );
}
const travels = withBefore.map((p) => p.forkTravel);
const diffs = withBefore.map((p) => p.forkTravel - p.before);
const spread = Math.max(...travels) - Math.min(...travels);
console.log(
  `\nフォークの横移動：最小 ${Math.min(...travels).toFixed(2)}m / 最大 ${Math.max(...travels).toFixed(2)}m` +
    `（差 ${spread.toFixed(2)}m ＝ ゾーン半幅の ${(spread / STRIKE_ZONE_HALF_WIDTH).toFixed(1)}倍）`,
);
console.log(
  `接続で動いた量：最小 ${Math.min(...diffs).toFixed(2)}m / 最大 ${Math.max(...diffs).toFixed(2)}m ` +
    `/ 平均 ${(diffs.reduce((a, b) => a + b, 0) / diffs.length).toFixed(2)}m`,
);
console.log('接続前もフォークは R/L で曲がっていたので散らばり自体はあった。');
console.log('**無かったのは「F を動かしても何も起きない」ほう**＝96人ぶんの数値が死んでいた。');
console.log(`\n（リリース ${RELEASE_Z}m → 本塁 ${PLATE_Z}m）`);
