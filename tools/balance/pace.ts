/**
 * **CPU投手の配球のくじ＝緩急と、追い込んでからの勝負球（フェーズCCC-86）**の計測の部品。
 * 出力は `paceReport.ts`（`npm run balance:pace`）、帯は `tests/pitchPace.test.ts`。
 *
 * BBB-84 で内外角は読めなくなったが、配球にはまだ**投げる前に分かる**ものが2つ残っていた：
 *
 * 1. **球速はカウントだけで決まる**（初球は必ず速球・ストライクの後はフォーク・3ボールは基準速・
 *    追い込んだら持ち味＝S-40）。人間の打者はカウントを見れば待つ速さを知れる。
 * 2. **追い込んだ1球は、制球が中位以下の投手なら必ずボール**（決め球は隅の1つ外側。T-41）。
 *    追い込まれたら振らないだけで四球が取れる。
 *
 * 土台は `atbat.ts`（判定・CPUの判断はすべて `src/core` の純粋関数）。ここで置くのは
 * **人間の打者の打ち方**だけ：
 *
 * - **何を待つか**（`AtBatOptions.waitFor`）＝カウントの傾向／本当の球速（読みの札）／
 *   直前のストライクの速さ（CPU打者の規則）／いつも同じ速さ（読まない）
 * - **追い込まれたらどこまで振るか**（`AtBatOptions.swingWidths.twoStrike`）＝際どい球にも手を出す
 *   （CPU打者の規則）／ゾーンの球だけ（見極めの上限）／振らない
 * - **待つ速さを外したときにどれだけ合わせ直せるか**（`AtBatOptions.hardTiming`）＝
 *   **ここはモデルの仮定**なので、3通りを必ず並べて見る：
 *   - **CPU打者と同じ**（緩急1段＝`CPU_TIMING_PENALTY_SEC`＝窓の1/3。見てから大半を合わせ直せる）
 *   - **半分**（本当の時間差の半分だけずれる）
 *   - **合わせ直せない**（待っていた速さの球が届く時刻に振る＝外せばほぼ空振り）
 *   本当の時間差は大きい（基準の投手で 速球↔基準速 0.09秒・基準速↔フォーク 0.19秒。有効窓の
 *   片側は 0.045秒）。人間がどこにいるかは測れない（遊んで確かめる）ので、**どの仮定でも
 *   同じ結論になる値**を選ぶ。
 *
 * 立ち位置はどれも BBB-84 のいちばん良い打ち方（立ち位置を信じる）にそろえる。
 * 打球の帰結と得点は `tell.ts` の `league` と同じ回し方。**得点は打線ごとではなく全打席を
 * 1つの分布にまとめて解く**（`PaceLeague.runs`）＝暴れる打線（合わせ直せない打者が荒れた投手から
 * 四球を取り続けると、その打線だけ 1試合170点のような値になる）に引っ張られない。
 */
import {
  type CpuPaceScope,
  type CpuPitchMix,
  type CpuSpeedMode,
  CPU_ATTACK_CHANCE,
  CPU_PACE_CHANGE_CHANCE,
  CPU_PACE_SCOPE,
  chooseCpuPitchPlan,
  cpuPitcherStyle,
} from '../../src/core/cpuPitcher';
import { CPU_SWING_SIGMA_SEC } from '../../src/core/cpuBatter';
import { STRIKE_ZONE_HALF_WIDTH, forkBounces } from '../../src/core/pitch';
import type { Count } from '../../src/core/rules';
import {
  type AtBatOptions,
  type AtBatResult,
  controlOf,
  pitchMixStream,
  pitchProfileOf,
  pitchSideStream,
  simulateAtBat,
  swingNoiseStream,
} from './atbat';
import { type PaDistribution, solveLineup } from './runExpectancy';
import { ROSTERS, STAFF, trustTell, f2, f3, pct, row } from './tell';

/** 1つの対戦を何度回すか（先発16人×打線9人×この回数。ぶれ・内外角・緩急の系列は1本を共有） */
export const PACE_REPS = 24;

// ---- 打者の打ち方（何を待つか） ----

type Wait = NonNullable<AtBatOptions['waitFor']>;
/** カウントの傾向を待つ（いつも投げる球速＝手がかりを信じる） */
export const waitUsual: Wait = ({ usual }) => usual;
/** いつも同じ速さを待つ（読まない） */
export const waitFixed =
  (mode: CpuSpeedMode): Wait =>
  () =>
    mode;
/** 本当の球速を知っている（読みの札の上限） */
export const waitActual: Wait = () => 'actual';
/** 直前のストライクの速さを待つ（CPU打者の規則） */
export const waitLast: Wait = () => 'last';

export interface PaceWay {
  label: string;
  wait: Wait;
}
export const PACE_WAYS: readonly PaceWay[] = [
  { label: '傾向を待つ', wait: waitUsual },
  { label: '本当の球速を知る（読みの札）', wait: waitActual },
  { label: '直前のストライクの速さ（CPU打者）', wait: waitLast },
  { label: 'いつも速球を待つ', wait: waitFixed('fast') },
  { label: 'いつも基準速を待つ', wait: waitFixed('neutral') },
  { label: 'いつもフォークを待つ', wait: waitFixed('slow') },
];

/** 待つ速さを外したときの合わせ直し方（`AtBatOptions.hardTiming`） */
export interface TimingModel {
  label: string;
  hard: number | undefined;
}
export const TIMING_MODELS: readonly TimingModel[] = [
  { label: 'CPU打者と同じ（1段＝窓の1/3）', hard: undefined },
  { label: '本当の時間差の半分', hard: 0.5 },
  { label: '合わせ直せない（本当の時間差）', hard: 1 },
];

// ---- 回し方 ----

export interface PaceLeague {
  n: number;
  avg: number;
  obp: number;
  slg: number;
  hr: number;
  k: number;
  bb: number;
  /** 全打席を1つの分布にまとめた打線の1試合の得点期待（四球・死球は押し出しの進塁） */
  runs: number;
  /** 打線ごとに解いた得点期待の中央値（参考） */
  medianRuns: number;
  /** 振った球のうち空振りの割合 */
  whiff: number;
}

/**
 * CPU投手の配球の規則（`paceLeague` へ渡す）。`null`＝CCC-86 の前（球速はカウントだけで決まり、
 * 追い込んだ1球は必ず外へ逃げる）。
 */
export interface MixRule {
  /** いつもの球速から外す割合（`CPU_PACE_CHANGE_CHANCE`） */
  change: number;
  /** 追い込んだ1球が勝負球になる割合（`CPU_ATTACK_CHANCE`） */
  attack: number;
  /** 緩急のくじを効かせるカウントの区分（既定は採用＝`CPU_PACE_SCOPE`） */
  scope?: CpuPaceScope;
}

/** 採用した規則（ゲームと同じ） */
export const ADOPTED_MIX: MixRule = {
  change: CPU_PACE_CHANGE_CHANCE,
  attack: CPU_ATTACK_CHANCE,
  scope: CPU_PACE_SCOPE,
};

/** 先発16人×打線9人を回す（`tell.ts` の `league` と同じ組み合わせ） */
export function paceLeague(
  opts: AtBatOptions,
  rule: MixRule | null,
  reps = PACE_REPS,
  /** ぶれ・内外角・配球のくじの系列の種（同じ種なら同じ数字。別の種で標本の揺れを見る） */
  seed = 1,
): PaceLeague {
  const noise = swingNoiseStream(seed, CPU_SWING_SIGMA_SEC);
  const sides = pitchSideStream(seed);
  const mixes = rule === null ? null : pitchMixStream(seed, rule.change, rule.attack);
  const scope = rule?.scope ?? CPU_PACE_SCOPE;
  const all: AtBatResult[] = [];
  const pooled: PaDistribution = { out: 0, single: 0, double: 0, triple: 0, homerun: 0, walk: 0 };
  const perLineup: number[] = [];
  let swings = 0;
  let misses = 0;
  ROSTERS.forEach((off, i) => {
    const def = ROSTERS[(i + 1) % ROSTERS.length];
    const pitcher = def.players[def.pitcher].pitching!;
    const lineup: PaDistribution[] = [];
    for (const id of off.lineup) {
      const bat = off.players[id].batting;
      const dist: PaDistribution = { out: 0, single: 0, double: 0, triple: 0, homerun: 0, walk: 0 };
      for (let r = 0; r < reps; r += 1) {
        const res = simulateAtBat(pitcher, bat, {
          stanceFor: trustTell,
          ...opts,
          aims: { ...(opts.aims ?? {}), paceScope: scope },
          noise,
          sides,
          mixes,
        });
        all.push(res);
        swings += res.swings;
        misses += res.misses;
        const add = (d: PaDistribution, w: number): void => {
          if (res.kind === 'inPlay') d[res.outcome!] += w;
          else if (res.kind === 'strikeout') d.out += w;
          else d.walk! += w;
        };
        add(dist, 1 / reps);
        add(pooled, 1);
      }
      lineup.push(dist);
    }
    perLineup.push(solveLineup(lineup).runs);
  });
  const n = all.length;
  for (const k of Object.keys(pooled) as Array<keyof PaDistribution>) pooled[k] = (pooled[k] ?? 0) / n;
  const outcome = (k: string): number => all.filter((r) => r.outcome === k).length;
  const kind = (k: string): number => all.filter((r) => r.kind === k).length;
  const single = outcome('single');
  const double = outcome('double');
  const triple = outcome('triple');
  const homerun = outcome('homerun');
  const hits = single + double + triple + homerun;
  const free = kind('walk') + kind('hitByPitch');
  const ab = Math.max(1, n - free);
  perLineup.sort((a, b) => a - b);
  return {
    n,
    avg: hits / ab,
    obp: (hits + free) / n,
    slg: (single + 2 * double + 3 * triple + 4 * homerun) / ab,
    hr: homerun / n,
    k: kind('strikeout') / n,
    bb: free / n,
    runs: solveLineup(Array.from({ length: 9 }, () => pooled)).runs,
    medianRuns: perLineup[Math.floor(perLineup.length / 2)],
    whiff: misses / Math.max(1, swings),
  };
}

export const PACE_HEAD = row(['打率', '出塁率', '長打率', 'HR', '三振', '四死球', '空振り', '得点/試合'], 9);
export const paceLine = (label: string, r: PaceLeague): string =>
  `${label.padEnd(30)}${row(
    [f3(r.avg), f3(r.obp), f3(r.slg), pct(r.hr), pct(r.k), pct(r.bb), pct(r.whiff), f2(r.runs)],
    9,
  )}`;

// ---- 追い込まれたらどこまで振るか（2つ目の穴） ----

/** 追い込まれたらゾーンの球だけを振る（見極めの上限＝本塁を通る場所を必ず読み当てる） */
export const TWO_STRIKE_ZONE_ONLY: AtBatOptions = { swingWidths: { twoStrike: STRIKE_ZONE_HALF_WIDTH } };
/** 追い込まれたら振らない（ど真ん中の球にも手を出さない） */
export const TWO_STRIKE_TAKE: AtBatOptions = { swingWidths: { twoStrike: 0 } };

// ---- 採用の形で、カウント別に実際に来る球（手がかりの見え方） ----

export interface CountMix {
  /** 球速の割合（名鑑の投手で平均。くじの確率をそのまま掛けた期待値） */
  speed: Record<CpuSpeedMode, number>;
  /** いつもの球速（カウントの傾向）どおりに来る割合 */
  usual: number;
  /** ストライクゾーンへ来る割合（狙いがゾーンの中＝見逃せばストライク） */
  zone: number;
}

/**
 * そのカウントで、名鑑の投手96人が投げる球の出方（**くじの確率をそのまま掛けた期待値**＝
 * 乱数を回さない）。`rule` は採用の形（`ADOPTED_MIX`）か、比べる形。
 */
export function countMix(count: Count, rule: MixRule = ADOPTED_MIX): CountMix {
  const speed: Record<CpuSpeedMode, number> = { fast: 0, neutral: 0, slow: 0 };
  let usual = 0;
  let zone = 0;
  let total = 0;
  for (const stats of STAFF) {
    const profile = pitchProfileOf(stats);
    const control = controlOf(stats);
    const base = {
      bouncingFork: forkBounces(profile.fork),
      sides: { side: 1 as const, cross: false },
      paceScope: rule.scope ?? CPU_PACE_SCOPE,
    };
    const style = cpuPitcherStyle(profile);
    const plan = (mix: CpuPitchMix) => chooseCpuPitchPlan(count, style, control, 0, { ...base, mix });
    const home = plan({ change: false, pick: 0, attack: false }).speed;
    // 外したときの候補（pick の前半・後半で残りの球速を等分する）
    const alts = [0.25, 0.75].map((pick) => plan({ change: true, pick, attack: false }).speed);
    const weights: Array<[CpuSpeedMode, number]> = [
      [home, 1 - rule.change],
      [alts[0], rule.change / 2],
      [alts[1], rule.change / 2],
    ];
    for (const [mode, w] of weights) speed[mode] += w;
    usual += weights.filter(([m]) => m === home).reduce((s, [, w]) => s + w, 0);
    const inZone = (attack: boolean): number =>
      Math.abs(plan({ change: false, pick: 0, attack }).targetX) <= STRIKE_ZONE_HALF_WIDTH ? 1 : 0;
    zone += count.strikes >= 2 ? rule.attack * inZone(true) + (1 - rule.attack) * inZone(false) : inZone(false);
    total += 1;
  }
  for (const m of Object.keys(speed) as CpuSpeedMode[]) speed[m] /= total;
  return { speed, usual: usual / total, zone: zone / total };
}
