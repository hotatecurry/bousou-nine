/**
 * 帰結の2次元マップ（フェーズI-29）。タイミング（縦）× コース（横）の格子に、
 * 打球の帰結を1文字ずつ並べる。**どこがHRの領域なのかが目で分かる**ので、
 * 定数を動かしたときに「領域がどう動いたか」を確かめるのに使う。
 *
 *   npm run balance:map
 *
 * 記号： H=本塁打  D=柵直撃などの長打  h=安打  F=フライアウト  G=ゴロアウト  .=ファウル
 */
import { BALLPARKS, DEFAULT_BALLPARK } from '../../src/core/ballpark';
import { SPEED_FAST, SPEED_NEUTRAL } from '../../src/core/pitch';
import { type SweepSample, pct, summarize, sweep } from './sweep';

function symbolOf(s: SweepSample): string {
  const o = s.result.outcome;
  switch (o.kind) {
    case 'homerun':
      return 'H';
    case 'groundRuleDouble':
      return 'D';
    case 'hit':
      return o.hit === 'single' ? 'h' : 'D';
    case 'beatThrow':
      return 'h';
    case 'flyout':
      return 'F';
    case 'groundout':
      return 'G';
    case 'foul':
      return '.';
  }
}

function printMap(title: string, samples: SweepSample[]): void {
  const s = summarize(samples);
  console.log(
    `\n${title}  HR ${pct(s.homerunRate)} / 安打 ${pct(s.hitRate)} / ファウル ${pct(
      s.foul / s.total,
    )}`,
  );
  const timings = [...new Set(samples.map((x) => x.timing))].sort((a, b) => b - a);
  console.log('        コース 外角 ←         芯         → 内角');
  for (const t of timings) {
    const line = samples
      .filter((x) => x.timing === t)
      .sort((a, b) => a.course - b.course)
      .map(symbolOf)
      .join('');
    const dir = (-t * 60).toFixed(0).padStart(4);
    console.log(`t=${t.toFixed(1).padStart(4)} ${dir}° ${line}`);
  }
}

const hitter = (power: number) => ({ power, average: 0.5 });

printMap(
  'ところざわ・長打力0.5・基準速36',
  sweep({ park: DEFAULT_BALLPARK, batter: hitter(0.5), pitchSpeed: SPEED_NEUTRAL, steps: 10 }),
);
printMap(
  'ところざわ・長打力0.5・速球42',
  sweep({ park: DEFAULT_BALLPARK, batter: hitter(0.5), pitchSpeed: SPEED_FAST, steps: 10 }),
);
printMap(
  'ところざわ・長打力1.0・基準速36',
  sweep({ park: DEFAULT_BALLPARK, batter: hitter(1), pitchSpeed: SPEED_NEUTRAL, steps: 10 }),
);
printMap(
  'かせんじき・長打力0.5・基準速36',
  sweep({ park: BALLPARKS[2], batter: hitter(0.5), pitchSpeed: SPEED_NEUTRAL, steps: 10 }),
);
