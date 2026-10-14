/**
 * 投手の球速（SPD）の効かせ方と、野手の足（フェーズBBB-85）の部品。
 * 出力は `speedReport.ts`（`npm run balance:speed`）。帯のテスト（`tests/pitcherSpeed.test.ts`）は
 * ここの部品だけを読む（出力のファイルは読み込んだだけで全段を回すため。`tell.ts` と同じ分け方）。
 *
 * ## 何を測るか
 *
 * テストプレイ「CPUが長打を出しすぎる。こちらの投手は球速のスキル（鉄腕）を持っているのに」
 * 「守備の移動スピードが、ちょっと遅すぎる」。**人間が投げ、CPU打線が打つ**場面を回す
 * （`AtBatOptions.humanPitch`＝決まった配球をまっすぐ投げる）。ここまでの計測は CPU投手か、
 * 投手の球速を名鑑のまま置いた人間の配球しか見ておらず、**同じ投手の球速だけを変えたら
 * どうなるか**は一度も測っていなかった。
 *
 * ## 野手の足は定数を書き換えて測った
 *
 * `FIELDER_SPEED` は `core/fielding.ts` の守備の見込み（`planCpuChase`・`predictSecureAt`）が
 * 直接読むので、引数では差し替えられない。候補の比較（6.0／6.5／7.0／7.5）は定数を書き換えて
 * 回した記録を `speedReport.ts` の6段目に残してある。いまの値での帰結はその場で出す。
 */
import { CPU_SWING_SIGMA_SEC } from '../../src/core/cpuBatter';
import { NORMAL_TARGET_X } from '../../src/core/cpuPitcher';
import {
  type AtBatOptions,
  type AtBatResult,
  type HumanPitch,
  type SpeedRule,
  simulateAtBat,
  swingNoiseStream,
} from './atbat';
import { ROSTERS, f3, pct, row } from './tell';

/** 緩急（F＝速球／N＝基準速／S＝遅い球）とコース（打者から見たX。負＝外角）の1球 */
const SELECTION: Record<string, -1 | 0 | 1> = { F: -1, N: 0, S: 1 };
const LOCATION: Record<string, number> = {
  m: 0, // 真ん中
  c: -NORMAL_TARGET_X, // 外角の隅
  i: NORMAL_TARGET_X, // 内角の隅
  b: -0.43, // 外角ぎりぎり
};

/** 配球の形（1球ずつ順に繰り返す） */
export type Pattern = readonly string[];

/** 緩急と内外角を散らす（よくある人間の配球） */
export const MIXED: readonly Pattern[] = [
  ['Fm', 'Sm'],
  ['Fc', 'Si'],
  ['Fi', 'Nc', 'Sm'],
  ['Fb', 'Sm'],
  ['Nc', 'Fi', 'Sc'],
];

/** 速球で押す（球の速い投手でやりがちな形） */
export const HEAT: readonly Pattern[] = [['Fm'], ['Fc', 'Fi'], ['Fc', 'Fi', 'Sm'], ['Fm', 'Fm', 'Sm']];

/** CPUの守備（実機と同じ先回り＋反応） */
export const CPU_DEFENSE: AtBatOptions = {};
/**
 * 人間らしい守備の代わり：いちばん近い野手を球へ向ける一斉移動（`'follow'`）・反応 0.3秒。
 * **CPU走者が人間の守備に見込む動き**（`predictSecureAt` の既定）に、人の反応を足したもの。
 */
export const HUMAN_DEFENSE: AtBatOptions = { chase: 'follow', reactionSec: 0.3 };

/** BBB-84 まで：投手の球速がそのまま打球に乗り、CPU打者の誤差は投手によらない */
export const RULE_BEFORE: SpeedRule = { relativeCarry: false, timingScale: false };
/** 採らなかった形：打球に乗せないだけ（球速がCPU打者相手に何にも効かない） */
export const RULE_CARRY_ONLY: SpeedRule = { timingScale: false };
/** 採用（実機と同じ）：打球に乗せない＋球が速い投手ほどCPU打者の誤差が大きい */
export const RULE_NOW: SpeedRule = {};

export interface PitchingSum {
  n: number;
  /** 打率（四死球を除く） */
  avg: number;
  single: number;
  double: number;
  triple: number;
  hr: number;
  /** 二塁打以上／打席 */
  long: number;
  /** 三振／打席 */
  k: number;
  /** インプレーの打球の平均初速 m/s */
  exit: number;
}

export function summarizePitching(all: readonly AtBatResult[]): PitchingSum {
  const n = all.length;
  const of = (k: string): number => all.filter((r) => r.outcome === k).length;
  const free = all.filter((r) => r.kind === 'walk' || r.kind === 'hitByPitch').length;
  const hits = of('single') + of('double') + of('triple') + of('homerun');
  const inPlay = all.filter((r) => r.batted);
  const exit =
    inPlay.reduce((a, r) => a + Math.hypot(r.batted!.launch.vx, r.batted!.launch.vy, r.batted!.launch.vz), 0) /
    Math.max(1, inPlay.length);
  return {
    n,
    avg: hits / Math.max(1, n - free),
    single: of('single') / n,
    double: of('double') / n,
    triple: of('triple') / n,
    hr: of('homerun') / n,
    long: (of('double') + of('triple') + of('homerun')) / n,
    k: all.filter((r) => r.kind === 'strikeout').length / n,
    exit,
  };
}

/**
 * 人間の配球（形を束ねる）×CPU打線144人。投手は各球団の先頭（エース）で、**球速だけ**を
 * `speedOf`（名鑑の球速 → 使う球速）で差し替える。ぶれの系列は1本を共有する。
 */
export function pitching(
  patterns: readonly Pattern[],
  speedOf: (rosterSpeed: number) => number,
  opts: AtBatOptions = {},
  reps = 4,
): PitchingSum {
  const noise = swingNoiseStream(7, CPU_SWING_SIGMA_SEC);
  const all: AtBatResult[] = [];
  for (const pattern of patterns) {
    const humanPitch = (_: unknown, i: number): HumanPitch => {
      const token = pattern[i % pattern.length];
      return { selection: SELECTION[token[0]], localX: LOCATION[token[1]] };
    };
    ROSTERS.forEach((off, i) => {
      const def = ROSTERS[(i + 1) % ROSTERS.length];
      const base = def.players[def.pitcher].pitching!;
      const pitcher = { ...base, speed: Math.max(0, Math.min(1, speedOf(base.speed))) };
      for (const id of off.lineup) {
        for (let r = 0; r < reps; r += 1) {
          all.push(simulateAtBat(pitcher, off.players[id].batting, { ...opts, noise, humanPitch }));
        }
      }
    });
  }
  return summarizePitching(all);
}

/** 球速を決まった値に置く */
export const fixedSpeed =
  (rating: number) =>
  (): number =>
    rating;
/** 名鑑の球速に足す（鉄腕は +0.2） */
export const speedPlus =
  (delta: number) =>
  (rosterSpeed: number): number =>
    rosterSpeed + delta;

/** `鉄腕` の球速の補正（`core/skills.ts` の `tetsuwan`） */
export const TETSUWAN_SPEED = 0.2;

export const PITCHING_HEAD = row(['打率', '単打', '二塁打', '三塁打', 'HR', '長打計', '三振', '初速'], 9);
export const pitchingLine = (label: string, s: PitchingSum): string =>
  `${label.padEnd(34)}${row(
    [f3(s.avg), pct(s.single), pct(s.double), pct(s.triple), pct(s.hr), pct(s.long), pct(s.k), s.exit.toFixed(1)],
    9,
  )}`;
