/**
 * **打席まるごとの計測（フェーズQQ-65）**＝`npm run balance:plate`
 *
 * 土台は `atbat.ts`（CPU投手 vs CPU打者の1打席を1球ずつ回す）。ここはその出力。
 *
 * ## この計測が答える問い
 *
 * `ORIGINAL_PARITY.md` の未確認事項は「**何試合か遊ばないと分からない**」と繰り返して
 * いるが、そこには2種類が混ざっている：**手応え**（悩ましいか・握りやすいか＝人が
 * 遊ぶしかない）と、**頻度**（何回起きるか＝数えれば分かる）。後者を数えるための土台が
 * ここまで無かった＝`tools/balance/` は**打席の中を一度も回していない**（`sweep.ts` は
 * 当たった後の格子、`runExpectancy.ts` は三振・四球ぶんを外から仮定して足す）。
 *
 * ## フェーズAAA-75：CPU打者に「ぶれ」が入った
 *
 * CPU打者は**直前のストライクの速さに合わせて振り、人間並みにタイミングがぶれる**
 * （`cpuBatter.ts` の `cpuSwingLead` / `CPU_SWING_SIGMA_SEC`）。**同じ対戦でも打席ごとに
 * 結果が散る**ので、各段は**1つのぶれの系列を共有して何度も回す**（`REPS`）＝割合が
 * 分布として出る。系列はシードで決まるので、何度走らせても同じ数字になる。
 *
 * 旧来の段のうち、**決定的なCPU打者の性質を測っていたもの**（8段目＝速球の早振りの罰／
 * 11段目の階段／13段目＝早振りの罰の帯）は、仕組みそのものが無くなったので置き換えた
 * （経緯は ORIGINAL_PARITY.md の SS-67・TT-68・AAA-75 のフェーズ記録にある）。
 *
 * ## フェーズBBB-83：守備の追い方（16段目）と、人間の打者の構え（17段目）
 *
 * - **16段目＝CPU守備の追い方と反応**。BBB-82 までのCPU守備（いちばん近い野手を球へ向ける・
 *   打った瞬間に動く）と、BBB-83 の先回り＋反応の遅れを、同じ打席で比べる。
 * - **17段目＝投手の立ち位置を読んで構える打者**。1〜15段目の打者はCPUの規則（直前のストライクへ
 *   寄る）で構えるが、**人間は投手がプレートのどちら側に立つかを見て寄れる**。BBB-83 では
 *   「内外角は投げる前に100%読める」という穴としてここで見つかり、**BBB-84 で立つ側を別系列から
 *   引く＋立ち位置は外れる手がかり**（外角側に立ったときだけ、3回に1回、内角のストライクへ）に
 *   した（詳しい計測は `npm run balance:tell`）。
 *
 * ## フェーズBBB-84：CPU投手の内外角は引く（全段の基準が動いた）
 *
 * `simulateAtBat` は既定で**ぶれの系列と同じ種から内外角の系列を起こす**（実機と同じ）。
 * あわせて、CPU投手は踏み込んでいる打者の体へ投げず、投げた後に踏み込んで当たった球は死球に
 * ならない（どちらも実機と同じ＝既定）。BBB-83 までの規則で回すには
 * `sides: null`・`avoidCrowder: false`・`noAwardIfSteppedIn: false` を渡す。
 */
import { type PitcherStats, createTeamRoster, pitchArmOf, pitcherControl } from '../../src/core/roster';
import { TEAMS, pitcherRowPitching, teamById } from '../../src/core/teams';
import { HOT_MODIFIER } from '../../src/core/condition';
import { BALLPARKS, DEFAULT_BALLPARK } from '../../src/core/ballpark';
import { CPU_FIELD_REACTION_SEC, FIELDER_HOME_POSITIONS, runnerSpeed } from '../../src/core/fielding';
import {
  BATTER_STANCE_RANGE,
  CATCH_Z,
  STRIKE_ZONE_HALF_WIDTH,
  armReleaseOffsetX,
  createPitchFlight,
  releaseXFor,
  neutralSpeedFor,
  speedForPitchSelection,
  stepPitchFlight,
  forkBounces,
} from '../../src/core/pitch';
import {
  AVG_MISHIT_RELIEF,
  SWING_ACTIVE_SEC,
  SWING_IDEAL_SEC,
  TIMING_SPEED_PENALTY,
  contactPlaneCrossing,
  judgeSwing,
} from '../../src/core/batting';
import {
  CPU_SWING_SIGMA_SEC,
  CPU_TIMING_PENALTY_SEC,
  SELECTIVE_HALF_WIDTH,
  TWO_STRIKE_HALF_WIDTH,
} from '../../src/core/cpuBatter';
import {
  CORNER_MARGIN,
  CPU_CONTROL_MAX_TARGET,
  NORMAL_TARGET_X,
  chooseCpuPitchPlan,
  cpuControlSpray,
  cpuPitcherStyle,
  cpuSteerAccelAt,
  planCpuPitchShape,
} from '../../src/core/cpuPitcher';
import type { Count } from '../../src/core/rules';
import {
  type AtBatOptions,
  type AtBatResult,
  type HumanPitch,
  batterSideOf,
  controlOf,
  pitchProfileOf,
  simulateAtBat,
  simulatePitch,
  swingNoiseStream,
} from './atbat';
import { SIM_DT, simulatePlay } from './sim';
import { type PaDistribution, distributionFor, paOutcomeOf, solveLineup } from './runExpectancy';

const row = (cells: readonly string[], width = 12): string =>
  cells.map((c) => c.padStart(width)).join('');
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const f2 = (v: number): string => v.toFixed(2);

const ROSTERS = TEAMS.map((t) => createTeamRoster(teamById(t.id)));
const STAFFS = TEAMS.map((t) => teamById(t.id).pitchers.map((r) => pitcherRowPitching(r)));

/** 1つの対戦を何度回すか（ぶれの系列を共有して回す＝打席ごとに違うぶれが乗る） */
const REPS = 12;
/** 人間の配球（17段目）は1つの形あたりこの回数 */
const HUMAN_REPS = 8;

/** 対戦の作り方＝**i番目の打線 vs i+1番目の先発**（16通り。名鑑をひと巡り舐める） */
function matchups() {
  return ROSTERS.map((off, i) => {
    const def = ROSTERS[(i + 1) % ROSTERS.length];
    return { off, def, pitcher: def.players[def.pitcher].pitching! };
  });
}

/** 打席の集計 */
interface Tally {
  n: number;
  strikeout: number;
  swingK: number;
  walk: number;
  hitByPitch: number;
  inPlay: number;
  out: number;
  single: number;
  double: number;
  triple: number;
  homerun: number;
  pitches: number;
  swings: number;
  misses: number;
  fouls: number;
  takes: number;
  longest: number;
}

function tally(results: readonly AtBatResult[]): Tally {
  const t: Tally = {
    n: 0,
    strikeout: 0,
    swingK: 0,
    walk: 0,
    hitByPitch: 0,
    inPlay: 0,
    out: 0,
    single: 0,
    double: 0,
    triple: 0,
    homerun: 0,
    pitches: 0,
    swings: 0,
    misses: 0,
    fouls: 0,
    takes: 0,
    longest: 0,
  };
  for (const r of results) {
    t.n += 1;
    t[r.kind] += 1;
    if (r.kind === 'strikeout' && r.misses > 0) t.swingK += 1;
    if (r.outcome) t[r.outcome] += 1;
    t.pitches += r.pitches;
    t.swings += r.swings;
    t.misses += r.misses;
    t.fouls += r.fouls;
    t.takes += r.takes;
    t.longest = Math.max(t.longest, r.pitches);
  }
  return t;
}

const hitsOf = (t: Tally): number => t.single + t.double + t.triple + t.homerun;
/** 打率＝安打 ÷（打席 − 四死球） */
const avgOf = (t: Tally): number => hitsOf(t) / Math.max(1, t.n - t.walk - t.hitByPitch);

/** 先発16人×打線9人を `reps` 回ずつ回す（ぶれの系列は1本を共有） */
function runStarters(opts: AtBatOptions = {}, reps = REPS, seed = 1): AtBatResult[] {
  const noise = opts.noise ?? swingNoiseStream(seed, CPU_SWING_SIGMA_SEC);
  const out: AtBatResult[] = [];
  for (const m of matchups()) {
    for (const id of m.off.lineup) {
      for (let r = 0; r < reps; r += 1) {
        out.push(simulateAtBat(m.pitcher, m.off.players[id].batting, { ...opts, noise }));
      }
    }
  }
  return out;
}

/** 人間の配球の形（17段目）。1文字目＝緩急（F/N/S）、2文字目＝コース（m/c/b/o） */
const SEL: Record<string, -1 | 0 | 1> = { F: -1, N: 0, S: 1 };
/** 打者から見たコース（外角）。c＝投手の通常の狙い／b＝ゾーンの縁の内側／o＝ボール */
const LOC: Record<string, number> = { m: 0, c: -NORMAL_TARGET_X, b: -0.43, o: -0.6 };
const HUMAN_PATTERNS: readonly (readonly string[])[] = [
  ['Fm'],
  ['Nm'],
  ['Sm'],
  ['Fb'],
  ['Sb'],
  ['Fc'],
  ['Fm', 'Sm'],
  ['Sm', 'Fm'],
  ['Fm', 'Fm', 'Sm'],
  ['Fm', 'Nm', 'Sm'],
  ['Nm', 'Fm', 'Sm'],
  ['Fo', 'Sm'],
  ['Fb', 'Sm'],
  ['Sb', 'Fm'],
  ['Fc', 'Sc'],
];

/** 人間がある配球の形を投げ続けたときの、CPU打線144人ぶんの帰結 */
function runHuman(pattern: readonly string[], opts: AtBatOptions = {}, reps = HUMAN_REPS): Tally {
  const noise = opts.noise ?? swingNoiseStream(7, CPU_SWING_SIGMA_SEC);
  const humanPitch = (_: Count, i: number): HumanPitch => {
    const tok = pattern[i % pattern.length];
    return { selection: SEL[tok[0]], localX: LOC[tok[1]] };
  };
  const out: AtBatResult[] = [];
  for (const m of matchups()) {
    for (const id of m.off.lineup) {
      for (let r = 0; r < reps; r += 1) {
        out.push(simulateAtBat(m.pitcher, m.off.players[id].batting, { ...opts, noise, humanPitch }));
      }
    }
  }
  return tally(out);
}

/** 人間の配球15通りのうち、いちばん三振を取れる形・いちばん打たれない形・いちばん打たれる形 */
function humanExtremes(opts: AtBatOptions = {}, reps = HUMAN_REPS) {
  const rows = HUMAN_PATTERNS.map((p) => ({ label: p.join(','), t: runHuman(p, opts, reps) }));
  const k = (r: (typeof rows)[number]) => r.t.strikeout / r.t.n;
  const maxK = rows.reduce((a, b) => (k(b) > k(a) ? b : a));
  const minAvg = rows.reduce((a, b) => (avgOf(b.t) < avgOf(a.t) ? b : a));
  const maxAvg = rows.reduce((a, b) => (avgOf(b.t) > avgOf(a.t) ? b : a));
  return { rows, maxK, minAvg, maxAvg };
}

const KNOWN = '   実際の野球は 三振22% / 四球8.5% / 死球1%未満 / 打率.250前後 / 1打席3.9球 / HRは約30打席に1本。';

console.log('打席まるごとの計測（CPU投手 vs CPU打者／球場＝ところざわ／名鑑16球団をひと巡り）');
console.log('土台：tools/balance/atbat.ts（判定・CPUの判断はすべて src/core の純粋関数）');
console.log(
  `CPU打者のぶれ σ=${(CPU_SWING_SIGMA_SEC * 1000).toFixed(0)}ms・緩急1段のずれ ${(CPU_TIMING_PENALTY_SEC * 1000).toFixed(0)}ms（窓の1/3）・各対戦を${REPS}回`,
);

// ============================================================
// 1. 打席の帰結（三振・四球は本当に起きるのか）
// ============================================================

console.log(`\n=== 1. CPU打者の打席の帰結（16球団×9人×${REPS}回） ===`);
{
  const starters = tally(runStarters());
  // 救援も含めた6人ずつ（相手5球団ぶん）＝**制球の悪い救援が混ざると四死球が増える**
  const noise = swingNoiseStream(2);
  const staff: AtBatResult[] = [];
  ROSTERS.forEach((off, i) => {
    for (let d = 1; d <= 5; d += 1) {
      for (const pit of STAFFS[(i + d) % STAFFS.length]) {
        for (const id of off.lineup) staff.push(simulateAtBat(pit, off.players[id].batting, { noise }));
      }
    }
  });
  const all = tally(staff);
  console.log(
    `${'相手'.padEnd(14)}${row(['打席', '三振', '(空振り)', '四球', '死球', '打率', '二塁打+', 'HR', '球数', '空振/振', '最長'], 9)}`,
  );
  for (const [label, t] of [
    ['先発16人', starters],
    ['投手陣6人ずつ', all],
  ] as const) {
    console.log(
      `${label.padEnd(14)}${row(
        [
          String(t.n),
          pct(t.strikeout / t.n),
          pct(t.swingK / t.n),
          pct(t.walk / t.n),
          pct(t.hitByPitch / t.n),
          avgOf(t).toFixed(3),
          pct((t.double + t.triple) / t.n),
          pct(t.homerun / t.n),
          (t.pitches / t.n).toFixed(2),
          pct(t.misses / Math.max(1, t.swings)),
          String(t.longest),
        ],
        9,
      )}`,
    );
  }
  console.log(KNOWN);
  console.log(
    `   1打席あたり（先発）：振った ${(starters.swings / starters.n).toFixed(2)} / 見送った ${(starters.takes / starters.n).toFixed(2)} / ファウル ${(starters.fouls / starters.n).toFixed(2)}`,
  );
  console.log('   AAA-75の前（決定的・1フレーム遅れ）は 三振39.6%（すべて空振り）/ 四球8.3% / 死球4.2% / HR 0本 / 3.79球。');
}

// ============================================================
// 2. カウント別の1球（CPUの配球は自然に緩急を付ける）
// ============================================================
//
// `chooseCpuPitchPlan` は 0-0=速球 / 1ストライク後=フォーク / 3ボール後=基準速（真ん中）/
// 2ストライク後=決め球（隅）。CPU打者は**直前のストライクの速さ**を待つので、
// 0-1 のフォークは「速球を待っていたところ」へ来る（2段ずれる）。

console.log('\n=== 2. カウント別の1球＝CPUの配球ごとの帰結（何を待っていたかを添える） ===');
const COUNTS: ReadonlyArray<{
  label: string;
  count: Count;
  wait: string;
  expected: (p: PitcherStats) => number | null;
}> = [
  { label: '速球(0-0)', count: { balls: 0, strikes: 0 }, wait: '基準速', expected: () => null },
  {
    label: 'フォーク(0-1)',
    count: { balls: 0, strikes: 1 },
    wait: '速球',
    expected: (p) => speedForPitchSelection(-1, p.speed),
  },
  { label: '基準(3-0)', count: { balls: 3, strikes: 0 }, wait: '基準速', expected: () => null },
  {
    label: '決め球(0-2)',
    count: { balls: 0, strikes: 2 },
    wait: 'フォーク',
    expected: (p) => speedForPitchSelection(1, p.speed),
  },
];
{
  console.log(
    `${'カウント'.padEnd(16)}${row(['待つ球', 'アウト', '安打', 'HR', 'ファウル', '空振り', '見送り', '平均|t|'], 9)}`,
  );
  for (const c of COUNTS) {
    const noise = swingNoiseStream(3);
    let out = 0;
    let hits = 0;
    let hr = 0;
    let foul = 0;
    let miss = 0;
    let take = 0;
    let n = 0;
    const timings: number[] = [];
    for (const m of matchups()) {
      const profile = pitchProfileOf(m.pitcher, 0);
      const control = controlOf(m.pitcher, 0);
      const arm = pitchArmOf(m.pitcher.throws);
      for (const id of m.off.lineup) {
        const b = m.off.players[id];
        const side = batterSideOf(b.batting, m.pitcher);
        for (let r = 0; r < REPS; r += 1) {
          const p = simulatePitch(
            profile,
            control,
            arm,
            c.count,
            { power: b.batting.power, average: b.batting.average },
            side,
            0,
            0,
            { expectedSpeed: c.expected(m.pitcher), noise: noise.next() },
          );
          n += 1;
          if (!p.swung) {
            take += 1;
            continue;
          }
          if (!p.launch) {
            miss += 1;
            continue;
          }
          if (p.timing !== null) timings.push(Math.abs(p.timing));
          const play = simulatePlay(p.launch, p.contactX, { runnerSpeed: runnerSpeed(b.batting.run) });
          const o = paOutcomeOf({ timing: 0, course: 0, result: play });
          if (o === null) foul += 1;
          else if (o === 'out') out += 1;
          else {
            hits += 1;
            if (o === 'homerun') hr += 1;
          }
        }
      }
    }
    const meanT = timings.length ? timings.reduce((s, v) => s + v, 0) / timings.length : 0;
    console.log(
      `${c.label.padEnd(16)}${row(
        [c.wait, pct(out / n), pct(hits / n), pct(hr / n), pct(foul / n), pct(miss / n), pct(take / n), meanT.toFixed(2)],
        9,
      )}`,
    );
  }
  console.log('   ＝**速さが変わる球（0-1のフォーク）ほど空振り・ファウルが増え**、待っていた球に近いほど芯に寄る。');
}

// ============================================================
// 3. CPU打者が「実際に振ったときにどこへ飛ぶか」（速球の打球の方向）
// ============================================================
//
// QQ-65 が見つけた「速球の打球がファウルラインの上に乗っている」の現在形。
// AAA-75 以降は**初球の速球は差し込まれて逆方向**、**同じ速球の2球目は芯**になる。

console.log('\n=== 3. 速球を振った打球の方向（名鑑96投手 × 打線9人・初球と同じ速さの2球目） ===');
{
  for (const [label, second] of [
    ['初球（基準速を待つ）', false],
    ['2球目（速球を待つ）', true],
  ] as const) {
    const noise = swingNoiseStream(4);
    const buckets = new Map<string, number>();
    let n = 0;
    let fair = 0;
    let hr = 0;
    for (const r of ROSTERS) {
      for (const pid of [r.pitcher, ...r.bullpen]) {
        const pit = r.players[pid].pitching!;
        const profile = pitchProfileOf(pit, 0);
        const control = controlOf(pit, 0);
        const arm = pitchArmOf(pit.throws);
        for (const id of r.lineup) {
          const b = r.players[id];
          const p = simulatePitch(
            profile,
            control,
            arm,
            { balls: 0, strikes: 0 },
            { power: b.batting.power, average: b.batting.average },
            batterSideOf(b.batting, pit),
            0,
            0,
            {
              expectedSpeed: second ? speedForPitchSelection(-1, pit.speed) : null,
              noise: noise.next(),
            },
          );
          if (!p.launch) continue;
          const play = simulatePlay(p.launch, p.contactX, { runnerSpeed: runnerSpeed(b.batting.run) });
          n += 1;
          const d = play.directionDeg;
          const a = Math.abs(d);
          const key = a >= 45 ? 'ファウル(45°以上)' : a >= 25 ? (d < 0 ? '左25〜45°' : '右25〜45°') : '中央±25°';
          buckets.set(key, (buckets.get(key) ?? 0) + 1);
          if (play.outcome.kind !== 'foul') fair += 1;
          if (play.outcome.kind === 'homerun') hr += 1;
        }
      }
    }
    const cells = ['ファウル(45°以上)', '左25〜45°', '中央±25°', '右25〜45°'].map(
      (k) => `${k} ${pct((buckets.get(k) ?? 0) / Math.max(1, n))}`,
    );
    console.log(`   ${label.padEnd(18)} 当たった ${n}本：${cells.join(' / ')} ／ HR ${pct(hr / Math.max(1, fair))}（フェアのうち）`);
  }
  console.log('   ＝**同じ速球を続けるほど芯で捉えられる**（緩急を付けない投手への罰）。');
}

// ============================================================
// 4. 球場別（実際の打席の本塁打）
// ============================================================

console.log(`\n=== 4. 球場別（実際の打席・先発16人×打線9人×${REPS}回） ===`);
{
  console.log(`${'球場'.padEnd(14)}${row(['両翼', '中堅', 'HR/打席', '打率'], 11)}`);
  for (const park of BALLPARKS) {
    const t = tally(runStarters({ park }, REPS, 5));
    console.log(
      `${park.name.padEnd(14)}${row([`${park.wing}m`, `${park.center}m`, pct(t.homerun / t.n), avgOf(t).toFixed(3)], 11)}`,
    );
  }
}

// ============================================================
// 5. 既存の計測が置いていた仮定との差
// ============================================================

console.log('\n=== 5. 得点・HRの見積もり（16球団平均・1試合） ===');
{
  const NO_CONTACT = 0.23;
  const summarize = (label: string, timing: number | undefined) => {
    let runs = 0;
    let hr = 0;
    for (const r of ROSTERS) {
      const lineup = r.lineup.map((id) => {
        const b = r.players[id].batting;
        return distributionFor(b.power, {
          park: DEFAULT_BALLPARK,
          average: b.average,
          run: b.run,
          strikeoutRate: NO_CONTACT,
          timing,
        });
      });
      const solved = solveLineup(lineup);
      runs += solved.runs;
      for (let i = 0; i < lineup.length; i += 1) hr += lineup[i].homerun * solved.pa[i];
    }
    console.log(`${label.padEnd(26)}${row([f2(runs / ROSTERS.length), f2(hr / ROSTERS.length)], 11)}`);
  };
  console.log(`${'分布の作り方'.padEnd(26)}${row(['得点/試合', 'HR/試合'], 11)}`);
  summarize('一様な格子（既存の既定）', undefined);
  summarize('t=0固定（JJ-57の7段目）', 0);

  // 実測＝1段目の打席を打者ごとの分布にする（ぶれがあるので同じ対戦でも散る＝本物の分布）
  const byBatter = (walkAsSingle: boolean) => {
    const noise = swingNoiseStream(1);
    let runs = 0;
    let hr = 0;
    for (const m of matchups()) {
      const lineup: PaDistribution[] = m.off.lineup.map((id) => {
        const d: PaDistribution = { out: 0, single: 0, double: 0, triple: 0, homerun: 0 };
        for (let r = 0; r < REPS; r += 1) {
          const res = simulateAtBat(m.pitcher, m.off.players[id].batting, { noise });
          if (res.kind === 'inPlay') d[res.outcome!] += 1 / REPS;
          else if (walkAsSingle && (res.kind === 'walk' || res.kind === 'hitByPitch')) d.single += 1 / REPS;
          else d.out += 1 / REPS;
        }
        return d;
      });
      const solved = solveLineup(lineup);
      runs += solved.runs;
      for (let i = 0; i < lineup.length; i += 1) hr += lineup[i].homerun * solved.pa[i];
    }
    return { runs: runs / ROSTERS.length, hr: hr / ROSTERS.length };
  };
  const asOut = byBatter(false);
  const asSingle = byBatter(true);
  console.log(`${'**実測の打席**（四死球＝アウト）'.padEnd(24)}${row([f2(asOut.runs), f2(asOut.hr)], 11)}`);
  console.log(`${'**実測の打席**（四死球＝単打）'.padEnd(24)}${row([f2(asSingle.runs), f2(asSingle.hr)], 11)}`);
  console.log('   参考：実際の野球は1チーム1試合あたり 約4.5点・HR 約1.1〜1.3本。');
  console.log('   ※四死球は分布の語彙に無いので2通りで挟む（本当はその間＝押し出しでしか走者が進まない単打）。');
  console.log('   AAA-75の前は 1.69点（四死球＝アウト）・HR 0.00本。');
}

// ============================================================
// 6. 好調（D-19）とラッキー7
// ============================================================

console.log('\n=== 6. 好調の寄与（実際の打席で測る） ===');
{
  const measure = (hotCount: number) => {
    const noise = swingNoiseStream(6);
    const out: AtBatResult[] = [];
    for (const m of matchups()) {
      m.off.lineup.forEach((id, i) => {
        const b = m.off.players[id].batting;
        const hot = i < hotCount;
        const batting = {
          ...b,
          power: Math.min(1, b.power + (hot ? (HOT_MODIFIER.power ?? 0) : 0)),
          average: Math.min(1, b.average + (hot ? (HOT_MODIFIER.average ?? 0) : 0)),
        };
        for (let r = 0; r < REPS; r += 1) out.push(simulateAtBat(m.pitcher, batting, { noise }));
      });
    }
    return tally(out);
  };
  console.log(`${'状態'.padEnd(20)}${row(['HR/打席', '打率'], 11)}`);
  for (const [label, hot] of [
    ['好調なし', 0],
    ['好調2人（D-19）', 2],
    ['全員好調（ラッキー7）', 9],
  ] as const) {
    const t = measure(hot);
    console.log(`${label.padEnd(20)}${row([pct(t.homerun / t.n), avgOf(t).toFixed(3)], 11)}`);
  }
}

// ============================================================
// 7. タイミングのずれによる減衰（TIMING_SPEED_PENALTY）を振る（QQ-65）
// ============================================================
//
// **定数は書き換えずに測れる**：初速はこの係数に対して線形（quality の1つ目の因子）なので、
// 打球ベクトルを比で伸縮すれば厳密に同値になる。**芯（timing=0）の打球は1mmも動かない**。
// 標本は**CPU打者が初球の速球を振った打球**（差し込まれる＝負のタイミング）。

console.log('\n=== 7. タイミングのずれによる減衰を振ったら（CPU打者・初球の速球） ===');
{
  const samples: Array<{
    launch: { vx: number; vy: number; vz: number };
    contactX: number;
    timing: number;
    relief: number;
    run: number;
  }> = [];
  const noise = swingNoiseStream(8);
  for (const m of matchups()) {
    const profile = pitchProfileOf(m.pitcher, 0);
    const control = controlOf(m.pitcher, 0);
    const arm = pitchArmOf(m.pitcher.throws);
    for (const id of m.off.lineup) {
      const b = m.off.players[id];
      for (let r = 0; r < REPS; r += 1) {
        const p = simulatePitch(
          profile,
          control,
          arm,
          { balls: 0, strikes: 0 },
          { power: b.batting.power, average: b.batting.average },
          batterSideOf(b.batting, m.pitcher),
          0,
          0,
          { noise: noise.next() },
        );
        if (!p.launch || p.timing === null) continue;
        samples.push({
          launch: p.launch,
          contactX: p.contactX,
          timing: p.timing,
          relief: 1 - AVG_MISHIT_RELIEF * b.batting.average,
          run: b.batting.run,
        });
      }
    }
  }
  console.log(`${'減衰'.padEnd(10)}${row(['平均初速', '平均飛距離', 'HR(ところざわ)', 'HR(かせんじき)', '安打', 'ファウル'], 13)}`);
  const narrow = BALLPARKS.find((p) => p.name === 'かせんじき') ?? DEFAULT_BALLPARK;
  for (const penalty of [0.3, 0.35, 0.4, 0.45]) {
    let exitSum = 0;
    let carrySum = 0;
    let hrDefault = 0;
    let hrNarrow = 0;
    let hits = 0;
    let foul = 0;
    for (const s of samples) {
      const ratio =
        (1 - penalty * Math.abs(s.timing) * s.relief) /
        (1 - TIMING_SPEED_PENALTY * Math.abs(s.timing) * s.relief);
      const launch = { vx: s.launch.vx * ratio, vy: s.launch.vy * ratio, vz: s.launch.vz * ratio };
      const opts = { runnerSpeed: runnerSpeed(s.run) };
      const play = simulatePlay(launch, s.contactX, opts);
      const playNarrow = simulatePlay(launch, s.contactX, { ...opts, park: narrow });
      exitSum += play.exitSpeed;
      carrySum += play.carry;
      if (play.outcome.kind === 'homerun') hrDefault += 1;
      if (playNarrow.outcome.kind === 'homerun') hrNarrow += 1;
      const o = paOutcomeOf({ timing: 0, course: 0, result: play });
      if (o === null) foul += 1;
      else if (o !== 'out') hits += 1;
    }
    const n = Math.max(1, samples.length);
    const mark = penalty === TIMING_SPEED_PENALTY ? ' ←現行' : '';
    console.log(
      `${penalty.toFixed(2).padEnd(10)}${row(
        [
          `${(exitSum / n).toFixed(1)}m/s`,
          `${(carrySum / n).toFixed(0)}m`,
          pct(hrDefault / n),
          pct(hrNarrow / n),
          pct(hits / n),
          pct(foul / n),
        ],
        13,
      )}${mark}`,
    );
  }
  console.log(`   標本 ${samples.length}本。**芯（timing=0）の打球はどの値でも1mmも動かない**（減衰は |timing| に比例する）。`);
}

// ============================================================
// 8. 人間が芯（t=0）で捉えたら（RR-66）
// ============================================================

console.log('\n=== 8. 人間が芯（t=0）で捉えたときの帰結 ===');
{
  const perfect = (pitcher: PitcherStats, count: Count, batter: { power: number; average: number }, side: 1 | -1) => {
    const profile = pitchProfileOf(pitcher, 0);
    const plan = chooseCpuPitchPlan(count, cpuPitcherStyle(profile), controlOf(pitcher, 0), 0, {
      bouncingFork: forkBounces(profile.fork),
    });
    const offset = armReleaseOffsetX(pitchArmOf(pitcher.throws));
    const shape = planCpuPitchShape(plan, profile, undefined, offset);
    let flight = createPitchFlight(releaseXFor(shape.plateX, offset), shape.speed, 0);
    let since = 0;
    for (let i = 0; i < 600; i += 1) {
      since += SIM_DT;
      const prev = flight;
      const next = stepPitchFlight(prev, shape.steerX, SIM_DT, cpuSteerAccelAt(shape, since - SIM_DT, SIM_DT));
      const cross = contactPlaneCrossing(prev, next);
      if (cross) {
        const launch = judgeSwing(
          {
            crossX: cross.x,
            swingTime: SWING_IDEAL_SEC,
            pitchSpeed: prev.vz,
            // 打球に乗るのは緩急ぶんだけ（BBB-85）
            pitcherNeutral: neutralSpeedFor(profile.speed),
          },
          batter,
          side,
          0,
          0,
        );
        return launch ? simulatePlay(launch, cross.x, {}) : null;
      }
      flight = next;
      if (next.z >= CATCH_Z) return null;
    }
    return null;
  };

  console.log(`${'カウント'.padEnd(16)}${row(['アウト', '安打', 'HR', 'ファウル'], 10)}`);
  for (const c of COUNTS) {
    let out = 0;
    let hits = 0;
    let hr = 0;
    let foul = 0;
    let n = 0;
    for (const m of matchups()) {
      for (const id of m.off.lineup) {
        const b = m.off.players[id];
        const play = perfect(m.pitcher, c.count, b.batting, batterSideOf(b.batting, m.pitcher));
        n += 1;
        if (!play) continue;
        const o = paOutcomeOf({ timing: 0, course: 0, result: play });
        if (o === null) foul += 1;
        else if (o === 'out') out += 1;
        else {
          hits += 1;
          if (o === 'homerun') hr += 1;
        }
      }
    }
    console.log(`${c.label.padEnd(16)}${row([pct(out / n), pct(hits / n), pct(hr / n), pct(foul / n)], 10)}`);
  }

  console.log(`\n${'長打力'.padEnd(10)}${row(['初球(速球)を芯で→HR'], 22)}`);
  for (const power of [0.2, 0.4, 0.6, 0.8, 1.0]) {
    let hr = 0;
    let n = 0;
    for (const m of matchups()) {
      const play = perfect(m.pitcher, { balls: 0, strikes: 0 }, { power, average: 0.5 }, -1);
      n += 1;
      if (play?.outcome.kind === 'homerun') hr += 1;
    }
    console.log(`${power.toFixed(1).padEnd(10)}${row([pct(hr / n)], 22)}`);
  }
  console.log('   RR-66の前は 長打力0.2でも94%だった＝**打者の差が出ていなかった**。');
}

// ============================================================
// 9. CPU打者が手を出す幅（SS-67 → AAA-75）
// ============================================================
//
// AAA-75 で `ゾーン − 隅`（0.40）から **ゾーンいっぱい**（0.45）へ。旧値のままだと
// 0.40〜0.45 は**振られずにストライクになる帯**＝人間の投手の見逃しストライク取り放題
// （右の2列＝その帯を使う配球の三振率）。

console.log('\n=== 9. CPU打者が手を出す幅（AAA-75。0.40〜0.45 の「振らない帯」を消した） ===');
{
  const widths = [
    { label: 'ゾーン-隅（TT-68）', normal: STRIKE_ZONE_HALF_WIDTH - CORNER_MARGIN },
    { label: '**ゾーン（採用）**', normal: SELECTIVE_HALF_WIDTH },
    { label: 'ゾーン+隅', normal: STRIKE_ZONE_HALF_WIDTH + CORNER_MARGIN },
  ];
  console.log(
    `${'手を出す幅'.padEnd(20)}${row(['幅', '三振', '四球', '死球', '打率', 'HR', '球数', '人:Fb 三振', '人:Fb,Sm'], 10)}`,
  );
  for (const w of widths) {
    const swingWidths = { normal: w.normal, twoStrike: TWO_STRIKE_HALF_WIDTH };
    const t = tally(runStarters({ swingWidths }));
    const fb = runHuman(['Fb'], { swingWidths });
    const fbsm = runHuman(['Fb', 'Sm'], { swingWidths });
    console.log(
      `${w.label.padEnd(20)}${row(
        [
          w.normal.toFixed(3),
          pct(t.strikeout / t.n),
          pct(t.walk / t.n),
          pct(t.hitByPitch / t.n),
          avgOf(t).toFixed(3),
          pct(t.homerun / t.n),
          (t.pitches / t.n).toFixed(2),
          pct(fb.strikeout / fb.n),
          pct(fbsm.strikeout / fbsm.n),
        ],
        10,
      )}`,
    );
  }
  console.log('   人:Fb＝ゾーンの縁の内側（0.43）へ速球を投げ続ける／人:Fb,Sm＝それとど真ん中のフォークを交互に。');
}

// ============================================================
// 10. CPU投手の通常の球の狙い（TT-68）
// ============================================================

console.log('\n=== 10. CPU投手の通常の球の狙い（TT-68。ワールドXの絶対値を振る） ===');
{
  const HALF = STRIKE_ZONE_HALF_WIDTH;
  const targets = [
    { label: 'ゾーン×0.55（TT-68の前）', x: HALF * 0.55 },
    { label: 'ゾーン×0.78', x: 0.35 },
    { label: '**ゾーン-隅（採用）**', x: NORMAL_TARGET_X },
    { label: 'ゾーンの縁', x: HALF },
    { label: '決め球と同じ隅', x: TWO_STRIKE_HALF_WIDTH },
  ];
  console.log(
    `${'通常の球の狙い'.padEnd(22)}${row(['狙いX', '三振', '四球', '死球', '打率', 'HR', '球数', '2S到達', '3B到達'], 9)}`,
  );
  for (const tg of targets) {
    const rs = runStarters({ aims: { normalTarget: tg.x } });
    const t = tally(rs);
    const twoStrike = rs.filter((r) => r.maxStrikes >= 2).length;
    const threeBall = rs.filter((r) => r.maxBalls >= 3).length;
    console.log(
      `${tg.label.padEnd(22)}${row(
        [
          tg.x.toFixed(3),
          pct(t.strikeout / t.n),
          pct(t.walk / t.n),
          pct(t.hitByPitch / t.n),
          avgOf(t).toFixed(3),
          pct(t.homerun / t.n),
          (t.pitches / t.n).toFixed(2),
          pct(twoStrike / t.n),
          pct(threeBall / t.n),
        ],
        9,
      )}`,
    );
  }
  // 名鑑96人の通常の球が、その狙いでどこに落ちるか（振られる／ボール）
  const STAFF = TEAMS.flatMap((tm) => tm.pitchers.map((r) => pitcherRowPitching(r)));
  let inZone = 0;
  let max = 0;
  for (const st of STAFF) {
    const x = Math.min(NORMAL_TARGET_X + Math.max(0, cpuControlSpray(pitcherControl(st.era))), CPU_CONTROL_MAX_TARGET);
    max = Math.max(max, x);
    if (x <= SELECTIVE_HALF_WIDTH) inZone += 1;
  }
  console.log(
    `   採用値で名鑑96人の通常の球がゾーンに入るのは ${inZone}人（最大 ${max.toFixed(3)}）＝**階段は無くなった**（AAA-75の前は 0.40 ちょうどに50人が載っていた）。`,
  );
}

// ============================================================
// 11. 人間のタイミングのばらつきと有効窓（UU-69）
// ============================================================
//
// **有効窓は「押す時刻の許容幅」そのもの**で、打球の質には一切効かない（`timing` が窓で
// 正規化される）。押す時刻の誤差 `e` に対して接触するのは |e| <= W/2 のときだけで、
// 正規化タイミングは `e / (W/2)`。**CPU打者のぶれ（AAA-75）の σ=40ms はこの表の
// σ40 の列そのもの**＝CPUは平均的な人間と同じだけぶれる。

console.log('\n=== 11. 人間のタイミングのばらつきと有効窓（UU-69。CPU打者のσはここのσ40と同じ） ===');
{
  const ERR_STEPS = 161;
  const gauss = (x: number, sigma: number): number => Math.exp(-(x * x) / (2 * sigma * sigma));
  const pitchAt = (pitcher: PitcherStats, count: Count) => {
    const profile = pitchProfileOf(pitcher, 0);
    const plan = chooseCpuPitchPlan(count, cpuPitcherStyle(profile), controlOf(pitcher, 0), 0, {
      bouncingFork: forkBounces(profile.fork),
    });
    const offset = armReleaseOffsetX(pitchArmOf(pitcher.throws));
    const shape = planCpuPitchShape(plan, profile, undefined, offset);
    let flight = createPitchFlight(releaseXFor(shape.plateX, offset), shape.speed, 0);
    let since = 0;
    for (let i = 0; i < 600; i += 1) {
      since += SIM_DT;
      const prev = flight;
      const next = stepPitchFlight(prev, shape.steerX, SIM_DT, cpuSteerAccelAt(shape, since - SIM_DT, SIM_DT));
      const cross = contactPlaneCrossing(prev, next);
      if (cross) return { crossX: cross.x, speed: prev.vz, neutral: neutralSpeedFor(profile.speed) };
      flight = next;
      if (next.z >= CATCH_Z) return null;
    }
    return null;
  };
  const COUNTS_H: Array<{ label: string; count: Count }> = [
    { label: '初球の速球(0-0)', count: { balls: 0, strikes: 0 } },
    { label: '3ボールの置き球(3-0)', count: { balls: 3, strikes: 0 } },
  ];
  const WINDOWS = [0.14, 0.12, 0.1, 0.09, 0.08];
  const SIGMAS = [0.03, 0.04, 0.05];
  for (const c of COUNTS_H) {
    console.log(`\n   ── ${c.label}（名鑑の打線・ところざわ） ──`);
    console.log(
      `${'有効窓'.padEnd(8)}${['押せる幅', 'σ30 空振り', '安打', 'HR', 'σ40 空振り', '安打', 'HR', 'σ50 空振り', '安打', 'HR']
        .map((x) => x.padStart(10))
        .join('')}`,
    );
    for (const w of WINDOWS) {
      const cells: string[] = [`±${((w / 2) * 1000).toFixed(0)}ms`];
      for (const sigma of SIGMAS) {
        let wt = 0;
        let whiff = 0;
        let hr = 0;
        let hits = 0;
        for (const m of matchups()) {
          const p = pitchAt(m.pitcher, c.count);
          if (!p) continue;
          for (const id of m.off.lineup) {
            const b = m.off.players[id].batting;
            for (let i = 0; i < ERR_STEPS; i += 1) {
              const e = (-3 + (6 * i) / (ERR_STEPS - 1)) * sigma;
              const weight = gauss(e, sigma);
              wt += weight;
              if (Math.abs(e) > w / 2) {
                whiff += weight;
                continue;
              }
              const timing = e / (w / 2);
              const launch = judgeSwing(
                {
                  crossX: p.crossX,
                  swingTime: SWING_IDEAL_SEC + timing * (SWING_ACTIVE_SEC / 2),
                  pitchSpeed: p.speed,
                  pitcherNeutral: p.neutral,
                },
                { power: b.power, average: b.average },
                batterSideOf(b, m.pitcher),
                0,
                0,
              );
              if (!launch) {
                whiff += weight;
                continue;
              }
              const play = simulatePlay(launch, p.crossX, { runnerSpeed: runnerSpeed(b.run) });
              const o = paOutcomeOf({ timing: 0, course: 0, result: play });
              if (play.outcome.kind === 'homerun') hr += weight;
              if (o !== null && o !== 'out') hits += weight;
            }
          }
        }
        cells.push(pct(whiff / wt), pct(hits / wt), pct(hr / wt));
      }
      console.log(`${w.toFixed(2).padEnd(8)}${cells.map((x) => x.padStart(10)).join('')}`);
    }
  }
  console.log('\n   実際の野球は**振った球の約25%が空振り**。');
}

// ============================================================
// 12. CPU打者のぶれ σ を振る（AAA-75）
// ============================================================
//
// **決定的なCPU打者には、どう規則を作っても必勝の配球が残る**（同じ球には必ず同じ結果）。
// ぶれを大きくするほど必勝配球は薄まるが、CPU打者そのものは下手になる（空振りが増える）。
// 右の3列＝人間の決まった配球15通りのうち、**いちばん三振を取れる形**と
// **いちばん打たれない／打たれる形**。

console.log('\n=== 12. CPU打者のぶれ σ を振る（AAA-75。採用は UU-69 の人間の σ40 と同じ） ===');
{
  console.log(
    `${'σ'.padEnd(12)}${row(['三振', '四球+死球', '打率', 'HR', '球数', '空振/振'], 9)}   人の配球：最大の三振／最低の打率／最高の打率`,
  );
  for (const sigma of [0, 0.02, 0.03, CPU_SWING_SIGMA_SEC, 0.05]) {
    const t = tally(runStarters({ noise: swingNoiseStream(1, sigma) }));
    const ex = humanExtremes({ noise: swingNoiseStream(7, sigma) }, sigma === 0 ? 1 : HUMAN_REPS);
    const mark = sigma === CPU_SWING_SIGMA_SEC ? '（採用）' : '';
    console.log(
      `${`${(sigma * 1000).toFixed(0)}ms${mark}`.padEnd(12)}${row(
        [
          pct(t.strikeout / t.n),
          pct((t.walk + t.hitByPitch) / t.n),
          avgOf(t).toFixed(3),
          pct(t.homerun / t.n),
          (t.pitches / t.n).toFixed(2),
          pct(t.misses / Math.max(1, t.swings)),
        ],
        9,
      )}   ${pct(ex.maxK.t.strikeout / ex.maxK.t.n)}(${ex.maxK.label}) / ${avgOf(ex.minAvg.t).toFixed(3)}(${ex.minAvg.label}) / ${avgOf(ex.maxAvg.t).toFixed(3)}(${ex.maxAvg.label})`,
    );
  }
  console.log('   σ=0（決定的）では必ずどこかの配球で三振100%か打率.000が出る＝ぶれを入れた理由そのもの。');
}

// ============================================================
// 13. 緩急1段のずれ（CPU_TIMING_PENALTY_SEC）を振る（AAA-75）
// ============================================================
//
// 大きいほど緩急が効く（CPU打者が崩れる）が、**2段（速球↔フォーク）で窓の縁を越える**と
// 「交互に投げるだけで空振り」が必勝配球になる。採用は窓の1/3＝2段で窓の2/3（縁の手前）。

console.log('\n=== 13. 緩急1段のずれを振る（AAA-75。採用は窓の1/3＝TT-68の梯子の1段） ===');
{
  console.log(
    `${'1段のずれ'.padEnd(14)}${row(['三振', '四球+死球', '打率', 'HR', '球数', '空振/振'], 9)}   人の配球：最大の三振／最低の打率／最高の打率`,
  );
  for (const [label, step] of [
    ['窓の1/6', SWING_ACTIVE_SEC / 6],
    ['窓の1/4', SWING_ACTIVE_SEC / 4],
    ['**窓の1/3（採用）**', CPU_TIMING_PENALTY_SEC],
    ['窓の1/2', SWING_ACTIVE_SEC / 2],
  ] as const) {
    const t = tally(runStarters({ paceStepSec: step }));
    const ex = humanExtremes({ paceStepSec: step }, 4);
    console.log(
      `${label.padEnd(14)}${row(
        [
          pct(t.strikeout / t.n),
          pct((t.walk + t.hitByPitch) / t.n),
          avgOf(t).toFixed(3),
          pct(t.homerun / t.n),
          (t.pitches / t.n).toFixed(2),
          pct(t.misses / Math.max(1, t.swings)),
        ],
        9,
      )}   ${pct(ex.maxK.t.strikeout / ex.maxK.t.n)}(${ex.maxK.label}) / ${avgOf(ex.minAvg.t).toFixed(3)}(${ex.minAvg.label}) / ${avgOf(ex.maxAvg.t).toFixed(3)}(${ex.maxAvg.label})`,
    );
  }
}

// ============================================================
// 14. リフレッシュレートによらないこと（AAA-75の不具合）
// ============================================================
//
// **AAA-75の前、CPUのスイングは「判断したフレームの先頭から振り始めた」扱いだった**
// （最大1フレーム早い）。遅れの量がフレームの長さそのものなので、**画面のリフレッシュ
// レートで結果が変わった**。サブフレームで振り出すようにしたので、いまはどの刻みでも
// 同じになる（残る差は投球の飛行の積分の誤差だけ）。「旧」は振り出しの補正を外した行。

console.log('\n=== 14. リフレッシュレートによらないこと（同じぶれの系列で回す） ===');
{
  console.log(`${'刻み'.padEnd(18)}${row(['三振', '四球', '打率', 'HR', '球数'], 9)}`);
  for (const [label, hz, legacy] of [
    ['60Hz', 60, false],
    ['120Hz', 120, false],
    ['144Hz', 144, false],
    ['240Hz', 240, false],
    ['旧・60Hz', 60, true],
    ['旧・144Hz', 144, true],
  ] as const) {
    const t = tally(runStarters({ dt: 1 / hz, legacyFrameStart: legacy }, 6, 11));
    console.log(
      `${label.padEnd(18)}${row(
        [pct(t.strikeout / t.n), pct(t.walk / t.n), avgOf(t).toFixed(3), pct(t.homerun / t.n), (t.pitches / t.n).toFixed(2)],
        9,
      )}`,
    );
  }
}

// ============================================================
// 15. 人間の決まった配球（AAA-75。必勝の形が無いか）
// ============================================================
//
// 人間の投手が**同じ形の配球を投げ続けたら**CPU打線144人がどうなるか。1文字目＝緩急
// （F速球 / N基準速 / Sフォーク）、2文字目＝コース（m真ん中 / c隅0.40 / bゾーンの縁の内側0.43 /
// oボール0.60。すべて外角）。**AAA-75の前はど真ん中の速球だけで三振86%・安打0**だった。

console.log(`\n=== 15. 人間の決まった配球（CPU打線144人×${HUMAN_REPS}回） ===`);
{
  const ex = humanExtremes();
  console.log(`${'配球'.padEnd(12)}${row(['三振', '打率', 'HR', '四球', '球数', '空振/振'], 9)}`);
  for (const r of ex.rows) {
    const t = r.t;
    console.log(
      `${r.label.padEnd(12)}${row(
        [
          pct(t.strikeout / t.n),
          avgOf(t).toFixed(3),
          pct(t.homerun / t.n),
          pct(t.walk / t.n),
          (t.pitches / t.n).toFixed(2),
          pct(t.misses / Math.max(1, t.swings)),
        ],
        9,
      )}`,
    );
  }
  console.log(
    `   最大の三振 ${pct(ex.maxK.t.strikeout / ex.maxK.t.n)}（${ex.maxK.label}）／最低の打率 ${avgOf(ex.minAvg.t).toFixed(3)}（${ex.minAvg.label}）／最高の打率 ${avgOf(ex.maxAvg.t).toFixed(3)}（${ex.maxAvg.label}）`,
  );
  console.log('   ＝**同じ速さを続けると打たれ、速さを変えると崩せる**。どの決まった形も、毎打席は勝てない。');
}

// ============================================================
// 16. CPU守備の追い方と、打球への反応（フェーズBBB-83）
// ============================================================
//
// BBB-82 までのCPU守備は**いま球にいちばん近い野手を球へ向ける**だけで、打った瞬間に動き出して
// いた。一斉移動は全員が同じ向きへ動くので、内野を抜けたゴロや内野の後ろに落ちた当たりを
// 投手・遊撃手が後ろから追い、外野手は球から遠ざかるほうへ下がった＝**単打のはずの当たりが
// 二塁打・三塁打になっていた**。BBB-83 は「いちばん早く球に触れる野手が、球と出会う点へ
// 先回りする」（`planCpuChase`）＋「打球への反応 0.25秒」（`CPU_FIELD_REACTION_SEC`）。

/** 打席の帰結に、打線ごとの得点期待（四死球＝アウト／＝単打）を添える */
function league(opts: AtBatOptions, reps: number) {
  const noise = swingNoiseStream(1, CPU_SWING_SIGMA_SEC);
  const all: AtBatResult[] = [];
  const byPower: Array<{ power: number; res: AtBatResult }> = [];
  let lo = 0;
  let hi = 0;
  for (const m of matchups()) {
    const asOut: PaDistribution[] = [];
    const asSingle: PaDistribution[] = [];
    for (const id of m.off.lineup) {
      const bat = m.off.players[id].batting;
      const a: PaDistribution = { out: 0, single: 0, double: 0, triple: 0, homerun: 0 };
      const b: PaDistribution = { out: 0, single: 0, double: 0, triple: 0, homerun: 0 };
      for (let r = 0; r < reps; r += 1) {
        const res = simulateAtBat(m.pitcher, bat, { ...opts, noise });
        all.push(res);
        byPower.push({ power: bat.power, res });
        if (res.kind === 'inPlay') {
          a[res.outcome!] += 1 / reps;
          b[res.outcome!] += 1 / reps;
        } else {
          a.out += 1 / reps;
          b[res.kind === 'strikeout' ? 'out' : 'single'] += 1 / reps;
        }
      }
      asOut.push(a);
      asSingle.push(b);
    }
    lo += solveLineup(asOut).runs;
    hi += solveLineup(asSingle).runs;
  }
  return { t: tally(all), lo: lo / ROSTERS.length, hi: hi / ROSTERS.length, byPower };
}

const LEAGUE_REPS = 24;
const leagueRow = (label: string, r: ReturnType<typeof league>): string => {
  const t = r.t;
  return `${label.padEnd(30)}${row(
    [avgOf(t).toFixed(3), pct(t.single / t.n), pct(t.double / t.n), pct(t.triple / t.n), pct(t.homerun / t.n)],
    10,
  )}${row([`${f2(r.lo)}〜${f2(r.hi)}`], 14)}`;
};

console.log(`\n=== 16. CPU守備の追い方と反応（BBB-83。先発16人×打線9人×${LEAGUE_REPS}回） ===`);
{
  console.log(`${'守備'.padEnd(30)}${row(['打率', '単打', '二塁打', '三塁打', 'HR'], 10)}${row(['得点/試合'], 14)}`);
  const cases: Array<[string, AtBatOptions]> = [
    ['追いかける・反応0（BBB-82まで）', { chase: 'follow', reactionSec: 0 }],
    ['先回り・反応0', { chase: 'intercept', reactionSec: 0 }],
    ['先回り・反応0.20', { chase: 'intercept', reactionSec: 0.2 }],
    [`先回り・反応${CPU_FIELD_REACTION_SEC}（採用）`, {}],
    ['先回り・反応0.30', { chase: 'intercept', reactionSec: 0.3 }],
    ['先回り・反応0.50', { chase: 'intercept', reactionSec: 0.5 }],
  ];
  for (const [label, opts] of cases) console.log(leagueRow(label, league(opts, LEAGUE_REPS)));
  // 参考：外野の定位置を原作の実測（中堅 82〜86m）の中ほどへ（×1.05＝中堅 84m。採っていない）
  const deep = Object.fromEntries(
    (['LF', 'CF', 'RF'] as const).map((id) => [
      id,
      { x: FIELDER_HOME_POSITIONS[id].x * 1.05, z: FIELDER_HOME_POSITIONS[id].z * 1.05 },
    ]),
  );
  console.log(leagueRow('（参考）採用＋外野を5%深く', league({ home: deep }, LEAGUE_REPS)));
  console.log('   実際の野球は 打率.250 / 単打14.5% / 二塁打4.5% / 三塁打0.4% / HR3.0% / 約4.5点。');
  console.log('   ＝**先回りだけだと打率が大きく下がる**（BBB-82 の水準は守備の穴に支えられていた）。');
  console.log('     反応の遅れを入れると、得点の水準は BBB-82 とほぼ同じまま、二塁打・三塁打が単打へ移る。');
}

// ============================================================
// 17. 投手の立ち位置を読んで構える打者（BBB-83で見つかった穴 → BBB-84で塞いだ）
// ============================================================
//
// BBB-83 まで、CPU投手の内外角は**ボール数＋ファウル数の偶奇**で決まり、投手がプレートの
// どちら側に立つかにも必ず出ていた＝**人間の打者は投げる前に内外角が分かり、打席の中で寄れる**
// （O-36。移動は 0.13秒で端まで届く）。しかも**寄っている打者に内角のボール球をそのまま当てて
// いた**ので、読まずに寄り切るだけでも点が取れた。BBB-84 で**内外角は別系列から引き、立ち位置は
// 外れる手がかり**になった（打者の外角側に立ったときだけ、`CPU_CROSS_CHANCE` の割合で内角の
// ストライクへ逆を突く）。あわせて CPU投手は踏み込んでいる打者の体へ投げず、投げた後に踏み込んで
// 当たった球は死球にならない。タイミングのぶれはCPU打者と同じ（σ40ms＝人間の値）。
// 打ち方・規則ごとの帰結は `npm run balance:tell`。

console.log(`\n=== 17. 投手の立ち位置を読んで構える打者（BBB-83 → BBB-84。同じ対戦×${LEAGUE_REPS}回） ===`);
{
  console.log(
    `${'規則／構え方'.padEnd(30)}${row(['打率', '単打', '二塁打', '三塁打', 'HR'], 10)}${row(['得点/試合'], 14)}${row(['HR:力.6〜.8', '力.8〜'], 12)}`,
  );
  const clampLean = (x: number): number => Math.max(-BATTER_STANCE_RANGE, Math.min(BATTER_STANCE_RANGE, x));
  const hrOf = (r: ReturnType<typeof league>, lo: number, hi: number): string => {
    const rows = r.byPower.filter((x) => x.power >= lo && x.power < hi);
    return pct(rows.filter((x) => x.res.outcome === 'homerun').length / Math.max(1, rows.length));
  };
  // BBB-83 まで：偶奇の規則＝立ち位置は必ず本当の側（読みは外れない）・寄っている打者にも当てる
  const old: AtBatOptions = { sides: null, avoidCrowder: false, noAwardIfSteppedIn: false };
  const cases: Array<[string, AtBatOptions]> = [
    ['BBB-83まで／CPUの規則', { ...old }],
    ['BBB-83まで／読んで寄り切る', { ...old, stanceFor: (_l, planned) => clampLean(planned) }],
    ['BBB-83まで／いつも寄り切る', { ...old, stanceFor: () => -BATTER_STANCE_RANGE }],
    // BBB-84：立つ側を引く＝外角側に立った球は3回に1回、内角のストライクへ来る。寄っている打者には当てない
    ['BBB-84／CPUの規則', {}],
    ['BBB-84／中央のまま', { stanceFor: () => 0 }],
    ['BBB-84／立ち位置を信じる', { stanceFor: (_l, _p, tell) => clampLean(tell.shown) }],
    ['BBB-84／いつも寄り切る', { stanceFor: () => -BATTER_STANCE_RANGE }],
  ];
  for (const [label, opts] of cases) {
    const r = league(opts, LEAGUE_REPS);
    console.log(`${leagueRow(label, r)}${row([hrOf(r, 0.6, 0.8), hrOf(r, 0.8, 1.01)], 12)}`);
  }
  console.log('   ＝BBB-83 までは、読んで寄り切る打者の打率が1割以上・本塁打が3倍以上（強打者は3打席に1本）。');
  console.log('     読まずに寄り切るだけでも、内角のボール球が体に当たって一塁をもらえた（得点の上限の列）。');
  console.log('     BBB-84 で立ち位置は外れる手がかりになり、寄っている打者には当てなくなった');
  console.log('     ＝読まずに寄り切る打者が、立ち位置を信じる打者を上回らなくなった（打率ははっきり下）。');
  console.log('     寄ること自体の得（中央のままより点が入る）は残っている＝打球の角度の作りの側の話');
  console.log('     （得点は四死球をアウト〜単打へ寄せた幅。押し出しとして数えた値は `npm run balance:tell`）。');
}
