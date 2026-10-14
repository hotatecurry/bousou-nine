/**
 * **CPU投手の内外角と、立ち位置という手がかり（フェーズBBB-84）**の計測の部品。
 * 出力は `tellReport.ts`（`npm run balance:tell`）、帯は `tests/pitchTell.test.ts`。
 *
 * BBB-83 が `balance:plate` の17段目で見つけた穴＝**CPU投手の内外角は投げる前に100%読める**
 * （ボール数＋ファウル数の偶奇で決まり、プレートのどちら側に立つかにも出る）ので、
 * 人間の打者は読んで寄るだけで打率 .36・本塁打 7%/打席になる。
 *
 * 2026-10-12 ユーザー判断：**内外角を試合のシードの別系列から引き、立ち位置は「たいてい
 * そちら側」という手がかりとして残す**（CPUもリリースの瞬間のコース入力で逆の隅へ投げ分ける）。
 * この計測は、その**割合**（`CPU_CROSS_CHANCE`）と**逆を突く向き**と**球の形**を決め、
 * 帰結を固定する。
 *
 * 土台は `atbat.ts`（判定・CPUの判断はすべて `src/core` の純粋関数）。打者の構え方だけを
 * `stanceFor` で差し替える＝**人間の打者の打ち方**を置く。読む打ち方だけでなく、
 * **読まずに寄る打ち方**（いつもプレートへ寄り切る／内角のボール球へ踏み込んで当たる）も
 * 必ず並べる＝最初はここを測らず、「信じて寄る」より強い打ち方を見落とした：
 *
 * - **中央のまま**（読まない）
 * - **立ち位置を信じる**（外角と示されたら寄る・内角なら離れる。投げた後は動かない）
 * - **信じて、逆を突かれたら球筋を見てから戻る**（人の反応＋打席内の移動の速さ）
 * - **いつもプレートへ寄り切る**／半分だけ寄る／いつも離れて立つ（読まない）
 * - **内角のボール球へ踏み込む**（投げる前から／投げた後に＝死球をもらいに行く）
 * - **CPU打者の規則**（直前のストライクのコースへ寄る＝O-36）
 *
 * タイミングはどれもCPU打者と同じ（直前のストライクの速さに合わせ、σ40ms でぶれる＝AAA-75）。
 * 得点は**四球・死球を押し出しの進塁として数えた**打線の得点期待（`PaDistribution.walk`）。
 */
import { type PitcherStats, createTeamRoster } from '../../src/core/roster';
import { TEAMS, pitcherRowPitching, teamById } from '../../src/core/teams';
import {
  type PitchFlight,
  BATTER_STANCE_MOVE_SPEED,
  BATTER_STANCE_RANGE,
  LEFT_BATTER_SIDE,
  STRIKE_ZONE_HALF_WIDTH,
  clampStance,
  flightRateAt,
  plateCrossingX,
  stepPitchFlight,
} from '../../src/core/pitch';
import { SWING_IDEAL_SEC } from '../../src/core/batting';
import { CPU_SWING_SIGMA_SEC } from '../../src/core/cpuBatter';
import { type CpuPitchShape, CPU_CROSS_CHANCE, cpuSteerAccelAt } from '../../src/core/cpuPitcher';
import type { Count } from '../../src/core/rules';
import {
  type AtBatOptions,
  type AtBatResult,
  batterSideOf,
  pitchSideStream,
  simulateAtBat,
  swingNoiseStream,
} from './atbat';
import { type PaDistribution, solveLineup } from './runExpectancy';

export const row = (cells: readonly string[], width = 9): string => cells.map((c) => c.padStart(width)).join('');
export const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
export const f2 = (v: number): string => v.toFixed(2);
export const f3 = (v: number): string => v.toFixed(3);

export const ROSTERS = TEAMS.map((t) => createTeamRoster(teamById(t.id)));
export const STAFF: PitcherStats[] = TEAMS.flatMap((t) => teamById(t.id).pitchers.map((r) => pitcherRowPitching(r)));

/** 1つの対戦を何度回すか（先発16人×打線9人×この回数。ぶれと内外角の系列は1本を共有） */
export const REPS = 24;
/** 人の反応時間（秒）。CPUの反応（確保→送球・乱闘・打球への反応）と同じ値 */
export const HUMAN_REACTION_SEC = 0.25;

export interface League {
  n: number;
  avg: number;
  /** 出塁率＝（安打＋四球＋死球）÷ 打席 */
  obp: number;
  single: number;
  extra: number;
  hr: number;
  k: number;
  bb: number;
  hbp: number;
  /** 1試合の得点期待（四球・死球は押し出しの進塁） */
  runs: number;
  /** 打席の左右ごとの内訳（右／左） */
  bySide: Record<'R' | 'L', { n: number; single: number; extra: number; hr: number }>;
}

/**
 * 先発16人×打線9人を回し、打席の帰結と打線ごとの得点期待を出す。
 * `crossChance` を渡すと、その割合で逆を突く内外角の系列を使う（`null`＝BBB-83 までの偶奇の規則）。
 */
export function league(
  opts: AtBatOptions,
  crossChance: number | null = CPU_CROSS_CHANCE,
  reps = REPS,
): League {
  const noise = swingNoiseStream(1, CPU_SWING_SIGMA_SEC);
  const sides = crossChance === null ? null : pitchSideStream(1, crossChance);
  const all: AtBatResult[] = [];
  const bySide: League['bySide'] = {
    R: { n: 0, single: 0, extra: 0, hr: 0 },
    L: { n: 0, single: 0, extra: 0, hr: 0 },
  };
  let runs = 0;
  ROSTERS.forEach((off, i) => {
    const def = ROSTERS[(i + 1) % ROSTERS.length];
    const pitcher = def.players[def.pitcher].pitching!;
    const lineup: PaDistribution[] = [];
    for (const id of off.lineup) {
      const bat = off.players[id].batting;
      const hand = batterSideOf(bat, pitcher) === LEFT_BATTER_SIDE ? 'L' : 'R';
      const dist: PaDistribution = { out: 0, single: 0, double: 0, triple: 0, homerun: 0, walk: 0 };
      for (let r = 0; r < reps; r += 1) {
        const res = simulateAtBat(pitcher, bat, { ...opts, noise, sides });
        all.push(res);
        bySide[hand].n += 1;
        if (res.outcome === 'single') bySide[hand].single += 1;
        if (res.outcome === 'double' || res.outcome === 'triple') bySide[hand].extra += 1;
        if (res.outcome === 'homerun') bySide[hand].hr += 1;
        if (res.kind === 'inPlay') dist[res.outcome!] += 1 / reps;
        else if (res.kind === 'strikeout') dist.out += 1 / reps;
        else dist.walk! += 1 / reps;
      }
      lineup.push(dist);
    }
    runs += solveLineup(lineup).runs;
  });
  const n = all.length;
  const outcome = (k: string): number => all.filter((r) => r.outcome === k).length;
  const kind = (k: string): number => all.filter((r) => r.kind === k).length;
  const hits = outcome('single') + outcome('double') + outcome('triple') + outcome('homerun');
  const free = kind('walk') + kind('hitByPitch');
  return {
    n,
    avg: hits / Math.max(1, n - free),
    obp: (hits + free) / n,
    single: outcome('single') / n,
    extra: (outcome('double') + outcome('triple')) / n,
    hr: outcome('homerun') / n,
    k: kind('strikeout') / n,
    bb: kind('walk') / n,
    hbp: kind('hitByPitch') / n,
    runs: runs / ROSTERS.length,
    bySide,
  };
}

export const HEAD = row(['打率', '出塁率', '単打', '二塁打+', 'HR', '三振', '四球', '死球', '得点/試合'], 9);
export const line = (label: string, r: League): string =>
  `${label.padEnd(34)}${row(
    [f3(r.avg), f3(r.obp), pct(r.single), pct(r.extra), pct(r.hr), pct(r.k), pct(r.bb), pct(r.hbp), f2(r.runs)],
    9,
  )}`;

// ---- 打者の構え方（人間の読み方） ----

type Stance = NonNullable<AtBatOptions['stanceFor']>;
/** 本当の狙いへ寄る（share＝寄る割合。負なら逆へ）＝読みが外れない世界でだけ意味を持つ */
export const leanTruth =
  (share: number): Stance =>
  (_last, planned) =>
    clampStance(planned) * share;
export const center: Stance = () => 0;
/** 立ち位置を信じて寄り切る。投げた後は動かない */
export const trustTell: Stance = (_last, _planned, tell) => clampStance(tell.shown);
/**
 * 立ち位置を信じて寄り切り、**逆を突かれたら球筋を見てから戻る**。動けるのは
 * 「打撃面までの時間 − スイングを押す時刻 − 見てから動き出すまで」のあいだで、
 * 速さは打席内の移動の速さ（O-36）。
 */
export const trustThenReact =
  (seeAndReactSec: number): Stance =>
  (_last, planned, tell) => {
    const lean = clampStance(tell.shown);
    const want = clampStance(planned);
    if (want === lean) return lean;
    const avail = Math.max(0, tell.secondsToContact - SWING_IDEAL_SEC - seeAndReactSec);
    const moved = Math.min(Math.abs(want - lean), BATTER_STANCE_MOVE_SPEED * avail);
    return lean + Math.sign(want - lean) * moved;
  };

// ---- 読まずに寄る打ち方（最初に測らず、見落としたもの） ----

/** プレートへ寄り切った立ち位置（負＝寄る） */
export const CROWD = -BATTER_STANCE_RANGE;
/** いつもプレートへ寄り切る（何も読まない） */
export const crowd: Stance = () => CROWD;
/** いつも半分だけ寄る */
export const halfCrowd: Stance = () => CROWD / 2;
/** いつも離れて立つ */
export const standOff: Stance = () => BATTER_STANCE_RANGE;
/** 外角と示されたら寄る／内角と示されたら中央のまま（離れない） */
export const crowdOnOutsideTell: Stance = (_last, _planned, tell) => (tell.shown < 0 ? CROWD : 0);

/**
 * 内角のボール球が来ると分かるか。**隅の外へ外す球は必ず立ち位置どおり**なので、
 * カウントと制球（＝狙う距離）と立ち位置（＝側）から、人間は投げる前に知れる。
 */
export const insideBallComing = (planned: number): boolean =>
  planned > STRIKE_ZONE_HALF_WIDTH;
/** 立ち位置を信じる。ただし内角のボール球には**投げる前から**踏み込む（当たりに行く） */
export const stepIntoInsideBall: Stance = (last, planned, tell) =>
  insideBallComing(planned) ? CROWD : trustTell(last, planned, tell);
/**
 * 立ち位置を信じる。ただし内角のボール球には**投げた後に**踏み込む（リリースの瞬間は
 * `trustTell` の場所にいる＝`stanceAtReleaseFor` に `trustTell` を渡して使う）。
 */
export const stepIntoInsideBallLate: Stance = (last, planned, tell) => {
  const from = trustTell(last, planned, tell);
  if (!insideBallComing(planned)) return from;
  return Math.max(CROWD, from - BATTER_STANCE_MOVE_SPEED * tell.secondsToContact);
};

// ---- 規則の前後（計測が再現するための引数の組） ----

/** 寄っている打者にも当て、投げた後に踏み込んでも死球になった頃（BBB-83 まで・最初に入れた形） */
export const HITS_CROWDERS: AtBatOptions = { avoidCrowder: false, noAwardIfSteppedIn: false };
/** 最初に入れた形＝どちらの側に立っても逆を突く（両方向）。寄っている打者にも当てる */
export const FIRST_CUT: AtBatOptions = { ...HITS_CROWDERS, aims: { crossBothWays: true } };

// ---- 1球を飛ばす（球の形・見分けの段） ----

/** 形と飛行の始まりから、本塁を通るXを出す（`atbat.ts` の `simulatePitch` と同じ並び） */
export function crossXOf(shape: CpuPitchShape, start: PitchFlight, dt = 1 / 240): number {
  let flight = start;
  let elapsed = 0;
  for (let i = 0; i < 4000; i += 1) {
    const r = flightRateAt(flight, flight.z);
    const next = stepPitchFlight(flight, shape.steerX, dt, cpuSteerAccelAt(shape, elapsed, dt * r));
    elapsed += (next.z - flight.z) / flight.vz;
    const x = plateCrossingX(flight, next);
    if (x !== null) return x;
    flight = next;
  }
  return NaN;
}

/** リリースから `frames` フレーム後（60Hz）の飛行状態 */
export function flightAfter(shape: CpuPitchShape, start: PitchFlight, frames: number): PitchFlight {
  let flight = start;
  let elapsed = 0;
  const dt = 1 / 60;
  for (let i = 0; i < frames; i += 1) {
    const r = flightRateAt(flight, flight.z);
    const next = stepPitchFlight(flight, shape.steerX, dt, cpuSteerAccelAt(shape, elapsed, dt * r));
    elapsed += (next.z - flight.z) / flight.vz;
    flight = next;
  }
  return flight;
}

export const COUNTS: Count[] = [];
for (let balls = 0; balls <= 3; balls += 1) for (let strikes = 0; strikes <= 2; strikes += 1) COUNTS.push({ balls, strikes });
