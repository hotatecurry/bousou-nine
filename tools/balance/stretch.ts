/**
 * **塁を踏んでそのまま先の塁へ**（フェーズBBB-77）の計測。`npm run balance:stretch`
 *
 * フェンス手前の見えない壁（野手は本塁から98mより奥へ行けなかった）を外したら、CPU打線の
 * 二塁打・三塁打が 6.4% → 0% になった（`npm run balance:plate`）。それまでの長打は
 * **誰も拾えないまま止まった打球を距離で分類する**経路（`fallbackHit`）からしか出ておらず、
 * その大半は壁の向こうへ転がった球だった。野手が拾った打球では打者走者は必ず一塁で
 * 止まっていた（`finalizePlay` の「欲張り進塁は対象外」）。
 *
 * BBB-77で打者走者が**一塁を踏んでそのまま二塁へ**行けるようにした（人間は十字キー＋J、
 * CPUは打球の瞬間に X-45 と同じ物差しで判断＝`chooseCpuStretches`）。ここで見るのは：
 *
 * 1. 判断ごとの帰結（狙わない／CPUの判断／必ず二塁を狙う）＝**長打がどれだけ戻るか**
 * 2. CPUの判断の当たり外れ＝狙った打球が実際に二塁で生きたか／狙えば生きた打球を
 *    どれだけ見送ったか
 * 3. 見込み（着地の時刻）と実際に守備が確保した時刻のずれ
 */
import { judgeSwing, NEUTRAL_BATTER } from '../../src/core/batting';
import { DEFAULT_BALLPARK } from '../../src/core/ballpark';
import {
  CPU_TAG_UP_MARGIN_SEC,
  FIELDER_HOME_POSITIONS,
  predictLandingAt,
  predictSecureAt,
} from '../../src/core/fielding';
import { RIGHT_BATTER_SIDE, SPEED_NEUTRAL } from '../../src/core/pitch';
import { createBattedBall } from '../../src/core/batting';
import {
  type PlayResult,
  SIM_CHASE,
  SIM_DT,
  SIM_REACTION_SEC,
  isExtraBase,
  isHit,
  simulatePlay,
} from './sim';
import { crossXFor, pct, swingTimeFor } from './sweep';

interface Sample {
  timing: number;
  course: number;
  none: PlayResult;
  cpu: PlayResult;
  always: PlayResult;
}

function samplesFor(power: number, pitchSpeed = SPEED_NEUTRAL, steps = 10): Sample[] {
  const out: Sample[] = [];
  const batter = { ...NEUTRAL_BATTER, power };
  for (let i = -steps; i <= steps; i++) {
    for (let j = -steps; j <= steps; j++) {
      const timing = i / steps;
      const course = j / steps;
      const crossX = crossXFor(course, RIGHT_BATTER_SIDE);
      const launch = judgeSwing({ crossX, swingTime: swingTimeFor(timing), pitchSpeed }, batter, RIGHT_BATTER_SIDE, 0);
      if (!launch) continue;
      out.push({
        timing,
        course,
        none: simulatePlay(launch, crossX, { park: DEFAULT_BALLPARK, stretch: false }),
        cpu: simulatePlay(launch, crossX, { park: DEFAULT_BALLPARK }),
        always: simulatePlay(launch, crossX, { park: DEFAULT_BALLPARK, stretchOverride: 1 }),
      });
    }
  }
  return out;
}

const isDoubleByStretch = (r: PlayResult) => r.outcome.kind === 'beatThrow' && (r.outcome.bases ?? 1) >= 2;

console.log('塁を踏んでそのまま先の塁へ（フェーズBBB-77）の計測　球場＝ところざわ／右打者／基準速');
console.log(`余白 CPU_TAG_UP_MARGIN_SEC=${CPU_TAG_UP_MARGIN_SEC}秒（X-45 と同じ）`);
console.log('');
console.log('=== 1. 判断ごとの帰結（接触した打球の一様分布。フェア打球あたり） ===');
console.log('長打力   判断           安打率     長打率   二・三塁打(踏んで先へ)   刺された(先の塁で)');
for (const power of [0.2, 0.5, 0.8, 1.0]) {
  const s = samplesFor(power);
  const fair = (k: keyof Sample) => s.filter((x) => (x[k] as PlayResult).outcome.kind !== 'foul');
  for (const [label, key] of [
    ['狙わない', 'none'],
    ['CPUの判断', 'cpu'],
    ['必ず二塁へ', 'always'],
  ] as const) {
    const f = fair(key);
    const hits = f.filter((x) => isHit(x[key].outcome)).length;
    const xb = f.filter((x) => isExtraBase(x[key].outcome)).length;
    const stretched = f.filter((x) => isDoubleByStretch(x[key])).length;
    // 先の塁で刺された＝狙わなければ安打だったのにアウトになった
    const lost = f.filter((x) => isHit(x.none.outcome) && x[key].outcome.kind === 'groundout').length;
    console.log(
      `${power.toFixed(1).padStart(4)}   ${label.padEnd(12)} ${pct(hits / f.length).padStart(7)} ${pct(xb / f.length).padStart(8)} ${pct(stretched / f.length).padStart(14)} ${pct(lost / f.length).padStart(18)}`,
    );
  }
}
console.log('');

console.log('=== 2. CPUの判断の当たり外れ（長打力0.5・1.0。狙わなければ単打だった打球だけ） ===');
for (const power of [0.5, 1.0]) {
  const s = samplesFor(power).filter((x) => x.none.outcome.kind === 'beatThrow');
  const couldDouble = s.filter((x) => isDoubleByStretch(x.always));
  const took = s.filter((x) => isDoubleByStretch(x.cpu));
  const tookButOut = s.filter((x) => x.cpu.outcome.kind === 'groundout');
  console.log(
    `長打力${power.toFixed(1)}: 単打 ${s.length}本 → 必ず狙えば二塁で生きた ${couldDouble.length}本／CPUが狙って生きた ${took.length}本／CPUが狙って刺された ${tookButOut.length}本`,
  );
}
console.log('');

console.log('=== 3. 見込み（着地の時刻）と、実際に守備が確保した時刻 ===');
console.log('（狙わなければ単打だった打球。見込みが早いほど判断は走者に厳しくなる）');
{
  const diffs: number[] = [];
  const secureDiffs: number[] = [];
  for (const power of [0.5, 1.0]) {
    for (const x of samplesFor(power)) {
      if (x.none.outcome.kind !== 'beatThrow' || !x.none.fielded) continue;
      const crossX = crossXFor(x.course, RIGHT_BATTER_SIDE);
      const launch = judgeSwing(
        { crossX, swingTime: swingTimeFor(x.timing), pitchSpeed: SPEED_NEUTRAL },
        { ...NEUTRAL_BATTER, power },
        RIGHT_BATTER_SIDE,
        0,
      );
      if (!launch) continue;
      const ball = createBattedBall(launch, crossX);
      diffs.push(x.none.fielded.sec - predictLandingAt(ball).sec);
      // 見込みは計測の守備（＝実機のCPU守備。先回り＋打球への反応。BBB-83）と同じ追い方で
      secureDiffs.push(
        x.none.fielded.sec -
          predictSecureAt(ball, DEFAULT_BALLPARK, SIM_DT, 12, FIELDER_HOME_POSITIONS, SIM_CHASE, SIM_REACTION_SEC).sec,
      );
    }
  }
  const show = (label: string, list: number[]) => {
    const d = [...list].sort((a, b) => a - b);
    const q = (p: number) => d[Math.min(d.length - 1, Math.floor(p * d.length))];
    console.log(
      `${label}　標本 ${d.length}本：実際の確保 − 見込み　中央値 ${q(0.5).toFixed(2)}秒／25% ${q(0.25).toFixed(2)}秒／75% ${q(0.75).toFixed(2)}秒`,
    );
  };
  show('着地の時刻（X-45の見込み）　　　　　　', diffs);
  show('転がる球を追って拾う時刻（BBB-77の見込み）', secureDiffs);
  console.log(
    '   ※見込みはファインプレイを見込まない。先回りの守備（BBB-83）は最後に跳び込んで拾うことが多く、',
  );
  console.log(`     実際の確保は見込みより 0.1秒ほど早い＝走者の余白（${CPU_TAG_UP_MARGIN_SEC}秒）の内側（2段目で刺された走者は0）。`);
}
