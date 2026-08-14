/**
 * 打席内の立ち位置（説明書p14「+でバッティングポジションを決め」）の計測（フェーズO-36）。
 *
 *   npm run balance:stance
 *
 * K-31・L-32・N-34と同じ手順で、**入れる前に「帯が空でないか」を測る**
 * （CLAUDE.md「バランス調整の方針＝勘で動かさず必ず計測してから決める」）。
 * ここで確かめたいことは3つ：
 *
 * 1. **可動幅をいくつにするか**（`BATTER_STANCE_RANGE`）。寄り切って内角のストライクが
 *    バットに届かなくなると「立ち位置を選んだ瞬間に打てない球がある」＝押し引きではなく
 *    ただの罰になる。届くぎりぎりを探す。
 * 2. **寄る／離れるが実際に帰結を動かすか**（動かないなら操作を足す意味が無い）。
 * 3. **リスク（死球）が同じ操作の上に乗っているか**（桜井ノウハウ「リスクとリターンは
 *    かなり近いところに適切な大きさに配置」）。
 *
 * 判定は `src/core` の純粋関数をそのまま呼ぶ（このファイルに判定式は書かない）。
 */
import {
  BAT_REACH_INSIDE_X,
  BAT_REACH_OUTSIDE_X,
  judgeSwing,
} from '../../src/core/batting';
import {
  BATTER_STANCE_RANGE,
  BATTER_ZONE_MAX_X,
  BATTER_ZONE_MIN_X,
  SPEED_NEUTRAL,
  STRIKE_ZONE_HALF_WIDTH,
  judgePitch,
} from '../../src/core/pitch';
import { chooseCpuStance } from '../../src/core/cpuBatter';
import { DEFAULT_BALLPARK } from '../../src/core/ballpark';
import { type PlayResult, isHit, simulatePlay } from './sim';
import { pct, swingTimeFor } from './sweep';

const batter = { power: 0.5, average: 0.5 };
/** 検討する可動幅の候補（m）。実装値は `BATTER_STANCE_RANGE` */
const CANDIDATES = [0.15, 0.2, 0.25, 0.3] as const;
/** 見せる立ち位置（打者ローカルのオフセット。負=プレートに寄る） */
const STANCES = [-0.2, -0.1, 0, 0.1, 0.2] as const;

const row = (cells: readonly string[]): string => cells.map((c) => c.padStart(11)).join('');
const m = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(2)}m`;

/**
 * ある立ち位置で、あるコース（打者ローカルX）へ来た球をタイミング全域で振ったときの
 * 帰結。分母は「バットに当たった打球」（sweep.ts と同じ見方）。
 */
function outcomesAt(stance: number, localX: number, steps = 10): PlayResult[] {
  const results: PlayResult[] = [];
  for (let i = -steps; i <= steps; i += 1) {
    const launch = judgeSwing(
      { crossX: localX, swingTime: swingTimeFor(i / steps), pitchSpeed: SPEED_NEUTRAL },
      batter,
      1,
      0,
      stance,
    );
    if (!launch) continue;
    results.push(simulatePlay(launch, localX, { park: DEFAULT_BALLPARK }));
  }
  return results;
}

console.log('\n=== 1. 可動幅の候補：寄り切ったとき内角のストライクに届くか ===');
console.log(`   ストライクゾーンは本塁基準で ±${STRIKE_ZONE_HALF_WIDTH}m。`);
console.log(`   素のバットの到達範囲は 外角 ${BAT_REACH_OUTSIDE_X}m / 内角 ${BAT_REACH_INSIDE_X}m。`);
console.log(`${'可動幅'.padEnd(8)}${row(['寄り→内角端', '離れ→外角端', '死球の下端', 'ゾーンとの間'])}`);
// 候補の比較は定数から直接組む（`batReachFor` は採用済みの可動幅でクランプするので、
// 候補を渡しても採用値まで丸められてしまう＝候補どうしの比較にならない）。
for (const range of CANDIDATES) {
  const insideLimit = BAT_REACH_INSIDE_X - range; // 寄り切ったときの内角側の限界
  const outsideLimit = BAT_REACH_OUTSIDE_X + range; // 離れ切ったときの外角側の限界
  const hbpFloor = BATTER_ZONE_MIN_X - range;
  console.log(
    `${`±${range}m`.padEnd(8)}` +
      row([
        STRIKE_ZONE_HALF_WIDTH <= insideLimit ? `とどく(${insideLimit.toFixed(2)})` : `とどかない(${insideLimit.toFixed(2)})`,
        -STRIKE_ZONE_HALF_WIDTH >= outsideLimit ? `とどく(${outsideLimit.toFixed(2)})` : `とどかない(${outsideLimit.toFixed(2)})`,
        `${hbpFloor.toFixed(2)}m`,
        `${(hbpFloor - STRIKE_ZONE_HALF_WIDTH).toFixed(2)}m`,
      ]),
  );
}
console.log('   → 内角のストライクに届かなくなる幅は採らない（打てない球が生まれる）。');
console.log(`   採用：±${BATTER_STANCE_RANGE}m`);

console.log('\n=== 2. 立ち位置ごとの、コース別の帰結（ところざわ・長打力0.5・基準速） ===');
console.log('   分母は当たった打球。コースは打者ローカルX（負=外角 / 正=内角）。');
const COURSES = [-0.7, -0.45, -0.2, 0, 0.2, 0.45, 0.65] as const;
console.log(`${'立ち位置'.padEnd(10)}${COURSES.map((c) => `${c >= 0 ? '+' : ''}${c}`.padStart(11)).join('')}`);
for (const stance of STANCES) {
  const cells = COURSES.map((localX) => {
    const results = outcomesAt(stance, localX);
    if (results.length === 0) return 'とどかない';
    const hits = results.filter((r) => isHit(r.outcome)).length;
    return pct(hits / results.length);
  });
  const tag = stance < 0 ? ' ←寄る' : stance > 0 ? ' ←離れる' : ' ←中央';
  console.log(`${m(stance).padEnd(10)}${cells.map((c) => c.padStart(11)).join('')}${tag}`);
}
console.log('   ストライクゾーンは ±0.45m。外角いっぱい（-0.45）と内角いっぱい（+0.45）の');
console.log('   両方を見ると、立ち位置がそのまま「どちらのコースを取りに行くか」になっている。');

console.log('\n=== 3. ストライクゾーン全域の平均（＝どちらが得か。片方が支配的でないか） ===');
console.log(`${'立ち位置'.padEnd(10)}${row(['安打率', 'HR率', '届かない', '死球になる幅'])}`);
for (const stance of STANCES) {
  let inPlay = 0;
  let hits = 0;
  let homers = 0;
  let unreachable = 0;
  let zonePoints = 0;
  for (let i = -20; i <= 20; i += 1) {
    const localX = (i / 20) * STRIKE_ZONE_HALF_WIDTH;
    zonePoints += 1;
    const results = outcomesAt(stance, localX);
    if (results.length === 0) {
      unreachable += 1;
      continue;
    }
    for (const r of results) {
      if (r.outcome.kind === 'foul') continue;
      inPlay += 1;
      if (isHit(r.outcome)) hits += 1;
      if (r.outcome.kind === 'homerun') homers += 1;
    }
  }
  // 死球になる幅＝ボール球のうち打者に当たる帯（ゾーンの外側 0..1.2m を舐める）
  let hbp = 0;
  const step = 0.01;
  for (let x = STRIKE_ZONE_HALF_WIDTH; x < 2.2; x += step) {
    if (judgePitch(x, 1, stance) === 'hitByPitch') hbp += step;
  }
  console.log(
    `${m(stance).padEnd(10)}` +
      row([
        pct(hits / inPlay),
        pct(homers / inPlay),
        pct(unreachable / zonePoints),
        `${hbp.toFixed(2)}m`,
      ]),
  );
}
console.log(`   死球ゾーンの幅そのものは一定（${(BATTER_ZONE_MAX_X - BATTER_ZONE_MIN_X).toFixed(1)}m）で、動くのは位置。`);

console.log('\n=== 4. リスクの所在：ゾーンのすぐ外の球が死球になるか（立ち位置別） ===');
console.log('   本塁通過X（打者ローカル）に対する判定。ストライク/ボール/**シキュウ**。');
const PROBES = [0.45, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.5, 1.7, 1.9] as const;
console.log(`${'立ち位置'.padEnd(10)}${PROBES.map((p) => `${p}`.padStart(8)).join('')}`);
for (const stance of STANCES) {
  const cells = PROBES.map((x) => {
    const call = judgePitch(x, 1, stance);
    return call === 'hitByPitch' ? 'シキュウ' : call === 'strike' ? 'ストライク' : 'ボール';
  });
  console.log(`${m(stance).padEnd(10)}${cells.map((c) => c.padStart(8)).join('')}`);
}
console.log('   → 寄れば内角のボール球が死球になり、離れれば当たらない＝');
console.log('     「外角を取りに行く」リターンと「ぶつけられる」リスクが同じ操作の上に乗る。');

console.log('\n=== 5. CPU打者の規則が生む駆け引き：配球を散らすと何が変わるか ===');
console.log('   CPUは直前の球のコースへ芯を合わせる（`chooseCpuStance`）。1球目を投げた後、');
console.log('   **同じコースへ続けて投げる**か**逆へ投げる**かで2球目の帰結を比べる。');
console.log(`${'1球目のコース'.padEnd(14)}${row(['同じコース', '逆のコース', '差'])}`);
function hitRateAt(stance: number, localX: number): number | null {
  const results = outcomesAt(stance, localX, 20);
  if (results.length === 0) return null;
  return results.filter((r) => isHit(r.outcome)).length / results.length;
}
let sameTotal = 0;
let oppositeTotal = 0;
let rows = 0;
for (const first of [-0.45, -0.3, -0.15, 0.15, 0.3, 0.45] as const) {
  const stance = chooseCpuStance(first); // CPUはここへ寄る
  const same = hitRateAt(stance, first);
  const opposite = hitRateAt(stance, -first);
  const cell = (v: number | null): string => (v === null ? 'とどかない' : pct(v));
  if (same !== null && opposite !== null) {
    sameTotal += same;
    oppositeTotal += opposite;
    rows += 1;
  }
  console.log(
    `${`${first >= 0 ? '+' : ''}${first}`.padEnd(14)}` +
      row([
        cell(same),
        cell(opposite),
        same !== null && opposite !== null ? pct(same - opposite) : '-',
      ]),
  );
}
console.log(
  `平均：同じコース ${pct(sameTotal / rows)} / 逆のコース ${pct(oppositeTotal / rows)}` +
    `（差 ${pct((sameTotal - oppositeTotal) / rows)}）`,
);
console.log('   → PROGRESS.md がセッション9で「同じ配球を続けると同じ打球になる＝配球を');
console.log('     散らすことがCPU打者対策として意味を持つ」と書き残していた駆け引きが、');
console.log('     ここで初めて実際の帰結を持つ（それまでCPU打者は立ち位置を持たなかった）。');
