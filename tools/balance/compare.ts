/**
 * 実機照合（フェーズI-29）：**実機で起きた打球をシミュレータに通し、帰結が一致するかを見る**。
 *
 *   npm run balance:compare -- <実機から採った plays の JSON>
 *
 * `tools/balance/sim.ts` は判定こそ `src/core` の純粋関数をそのまま呼ぶが、
 * **野手の動かし方（フレームの回し方）だけは `scenes/chicchaiScene.ts` を書き写している**。
 * そこがずれていたら計測値そのものが意味を失うので、実機の打球を録って突き合わせる。
 *
 * JSON の形は実機に一時的に仕込むフック（`window.__ft.plays`）と同じ：
 *   { plays: [{ launch: {vx,vy,vz}, contactX, park, outcome }] }
 */
import { readFileSync } from 'node:fs';
import { ballparkById } from '../../src/core/ballpark';
import type { BallparkId } from '../../src/core/ballpark';
import { type PlayOutcome, simulatePlay } from './sim';

interface RealPlay {
  launch: { vx: number; vy: number; vz: number };
  contactX: number;
  park: BallparkId;
  outcome:
    | { kind: 'foul' }
    | { kind: 'result'; outsAdded: number; runs: number; hit?: string };
}

/** シミュレータの帰結を、実機の `FieldPlayOutcome` と比べられる粒度へ畳む */
function foldSim(outcome: PlayOutcome): string {
  switch (outcome.kind) {
    case 'homerun':
      return 'homerun';
    case 'groundRuleDouble':
      return 'double';
    case 'hit':
      return outcome.hit;
    case 'beatThrow':
      return 'single';
    case 'flyout':
    case 'groundout':
      return 'out';
    case 'foul':
      return 'foul';
  }
}

/**
 * 実機側も同じ粒度へ畳む。
 *
 * **`hit` を持たず、アウトも増えていない帰結は単打**（`finalizePlay` の「刺されていない
 * 走者は全員フォース先へ安全到達」の経路）。実機は野手が拾って投げたが間に合わなかった
 * 場合に安打の種別を付けないので、ここで補う＝打者走者が一塁に立ったという事実は同じ。
 */
function foldReal(outcome: RealPlay['outcome']): string {
  if (outcome.kind === 'foul') return 'foul';
  if (outcome.hit) return outcome.hit;
  return outcome.outsAdded > 0 ? 'out' : 'single';
}

const path = process.argv[2];
if (!path) {
  console.error('使い方: npm run balance:compare -- <plays.json>');
  process.exit(1);
}
const data = JSON.parse(readFileSync(path, 'utf8')) as { plays: RealPlay[] };

let agree = 0;
console.log('初速   角度  方向    実機        シミュレータ  一致');
for (const play of data.plays) {
  const result = simulatePlay(play.launch, play.contactX, {
    park: ballparkById(play.park),
  });
  const real = foldReal(play.outcome);
  const sim = foldSim(result.outcome);
  const ok = real === sim;
  if (ok) agree += 1;
  console.log(
    `${result.exitSpeed.toFixed(1).padStart(5)} ${result.launchDeg.toFixed(0).padStart(4)}° ` +
      `${result.directionDeg.toFixed(0).padStart(4)}° ${real.padEnd(10)} ${sim.padEnd(12)} ${
        ok ? 'OK' : '×'
      }`,
  );
}
console.log(`\n一致 ${agree}/${data.plays.length}`);
