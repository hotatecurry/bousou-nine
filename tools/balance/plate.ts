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
 * そのせいで、いくつもの数字が**仮定の上に積まれている**：
 * `homerun.ts` の「三振・四球ぶん 23%」（JJ-57が抗力を決めた分母）／`relief.ts` の
 * 「1打席4球・1試合140球」（Z-47の物差し）／`walk.ts`・`lineup.ts`・`pinchrun.ts` の
 * 「一様な格子の分布」（Q-38の敬遠 0.80、R-39の盗塁 0.73、GG-54の代走 0.10）。
 */
import {
  type PitcherStats,
  createTeamRoster,
  pitchArmOf,
  pitcherControl,
} from '../../src/core/roster';
import { TEAMS, pitcherRowPitching, teamById } from '../../src/core/teams';
import { HOT_MODIFIER } from '../../src/core/condition';
import { BALLPARKS, DEFAULT_BALLPARK } from '../../src/core/ballpark';
import { runnerSpeed } from '../../src/core/fielding';
import {
  CATCH_Z,
  STRIKE_ZONE_HALF_WIDTH,
  SPEED_FAST,
  armReleaseOffsetX,
  releaseXFor,
  SPEED_NEUTRAL,
  SPEED_SLOW,
  createPitchFlight,
  speedForPitchSelection,
  stepPitchFlight,
} from '../../src/core/pitch';
import {
  AVG_MISHIT_RELIEF,
  CONTACT_PLANE_Z,
  MAX_DIRECTION_DEG,
  SWING_ACTIVE_SEC,
  SWING_IDEAL_SEC,
  TIMING_SPEED_PENALTY,
  contactPlaneCrossing,
  judgeSwing,
} from '../../src/core/batting';
import {
  CPU_TIMING_PENALTY_SEC,
  SELECTIVE_HALF_WIDTH,
  TWO_STRIKE_HALF_WIDTH,
  crossesSwingDecisionPoint,
  shouldCpuSwing,
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
  batterSideOf,
  controlOf,
  pitchProfileOf,
  simulateAtBat,
  simulatePitch,
} from './atbat';
import { SIM_DT, simulatePlay } from './sim';
import { distributionFor, paOutcomeOf, solveLineup } from './runExpectancy';

const row = (cells: readonly string[], width = 12): string =>
  cells.map((c) => c.padStart(width)).join('');
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const f2 = (v: number): string => v.toFixed(2);

const ROSTERS = TEAMS.map((t) => createTeamRoster(teamById(t.id)));

/** 対戦の作り方＝**i番目の打線 vs i+1番目の先発**（16通り。名鑑をひと巡り舐める） */
function matchups() {
  return ROSTERS.map((off, i) => {
    const def = ROSTERS[(i + 1) % ROSTERS.length];
    return { off, def, pitcher: def.players[def.pitcher].pitching! };
  });
}

/**
 * **4・5段目で「振らせて」測るための幅**（フェーズTT-68）。TT-68 で通常の球の狙いが
 * 打者が手を出す幅の縁（`SELECTIVE_HALF_WIDTH`）へ移ったので、**CPU打者は初球の速球を
 * 見送る**（2段目の 0-0 が 100%「振らず」）＝そのままでは打球が1つも採れない。
 * 4・5段目が答える問いは「**振ったときにどこへ飛ぶか**」（QQ-65のファウルラインの山・
 * 球場別の入り方）で、振るかどうかとは別なので、**2ストライクの幅を渡して振らせる**。
 */
const SWING_AT_NORMAL = { normal: TWO_STRIKE_HALF_WIDTH } as const;

console.log('打席まるごとの計測（CPU投手 vs CPU打者／球場＝ところざわ／名鑑16球団をひと巡り）');
console.log('土台：tools/balance/atbat.ts（判定・CPUの判断はすべて src/core の純粋関数）');

// ============================================================
// 1. 打席の帰結（三振・四球は本当に起きるのか）
// ============================================================

console.log('\n=== 1. CPU打者の打席の帰結（16球団×9人＝144打席） ===');
{
  const tally: Record<string, number> = {};
  let pitches = 0;
  let swings = 0;
  let takes = 0;
  let fouls = 0;
  for (const m of matchups()) {
    for (const id of m.off.lineup) {
      const b = m.off.players[id];
      const r = simulateAtBat(m.pitcher, b.batting);
      const key = r.kind === 'inPlay' ? r.outcome! : r.kind;
      tally[key] = (tally[key] ?? 0) + 1;
      pitches += r.pitches;
      swings += r.swings;
      takes += r.takes;
      fouls += r.fouls;
    }
  }
  const total = Object.values(tally).reduce((s, v) => s + v, 0);
  console.log(`${'帰結'.padEnd(12)}${row(['打席', '割合'])}`);
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`${k.padEnd(12)}${row([String(v), pct(v / total)])}`);
  }
  console.log(
    `\n   1打席あたり **${(pitches / total).toFixed(2)}球**（振った ${(swings / total).toFixed(2)} / 見送った ${(takes / total).toFixed(2)} / ファウル ${(fouls / total).toFixed(2)}）`,
  );
  console.log(`   relief.ts が置いている仮定は「1打席 4球」＝ここが実測値。`);
  console.log(
    `   homerun.ts が置いている仮定は「三振・四球ぶん 23%」＝実測は ${pct(((tally['strikeout'] ?? 0) + (tally['walk'] ?? 0) + (tally['hitByPitch'] ?? 0)) / total)}。`,
  );
}

// ============================================================
// 2. 球速モード別の1球（CPUの配球はカウントで決まる）
// ============================================================
//
// `chooseCpuPitchPlan` は 0-0=速球 / 1ストライク後=フォーク / 3ボール後=基準速（真ん中）/
// 2ストライク後=決め球（隅）。**同じ投手・同じ打者でもカウントで球種が変わる**ので、
// 打席の帰結（1段目）を球ごとに分解するとこうなる。

console.log('\n=== 2. カウント別の1球＝CPUの配球ごとの帰結 ===');
const COUNTS = [
  { label: '速球(0-0)', count: { balls: 0, strikes: 0 } },
  { label: 'フォーク(0-1)', count: { balls: 0, strikes: 1 } },
  { label: '基準(3-0)', count: { balls: 3, strikes: 0 } },
  { label: '決め球(0-2)', count: { balls: 0, strikes: 2 } },
];
{
  console.log(`${'カウント'.padEnd(16)}${row(['アウト', '安打', 'HR', 'ファウル', '振らず', '平均方向'], 10)}`);
  for (const c of COUNTS) {
    let out = 0;
    let hits = 0;
    let hr = 0;
    let foul = 0;
    let noSwing = 0;
    let n = 0;
    const dirs: number[] = [];
    for (const m of matchups()) {
      const profile = pitchProfileOf(m.pitcher, 0);
      const control = controlOf(m.pitcher, 0);
      const arm = pitchArmOf(m.pitcher.throws);
      for (const id of m.off.lineup) {
        const b = m.off.players[id];
        const side = batterSideOf(b.batting, m.pitcher);
        const p = simulatePitch(
          profile,
          control,
          arm,
          c.count,
          { power: b.batting.power, average: b.batting.average },
          side,
          0,
          0,
        );
        n += 1;
        if (!p.launch) {
          noSwing += 1;
          continue;
        }
        const play = simulatePlay(p.launch, p.contactX, {
          runnerSpeed: runnerSpeed(b.batting.run),
        });
        const o = paOutcomeOf({ timing: 0, course: 0, result: play });
        dirs.push(play.directionDeg);
        if (o === null) foul += 1;
        else if (o === 'out') out += 1;
        else {
          hits += 1;
          if (o === 'homerun') hr += 1;
        }
      }
    }
    const meanDir = dirs.length ? dirs.reduce((s, d) => s + d, 0) / dirs.length : 0;
    console.log(
      `${c.label.padEnd(16)}${row(
        [pct(out / n), pct(hits / n), pct(hr / n), pct(foul / n), pct(noSwing / n), `${meanDir.toFixed(0)}°`],
        10,
      )}`,
    );
  }
  console.log('   ＝**TT-68以降、通常の球（0-0／0-1）は見送られる**（狙いが打者の手を出す幅の縁にある）');
  console.log('   ＝カウントが動いてから決着する。3ボール後の真ん中は打たれ、決め球は87.5%が見送り。');
}

// ============================================================
// 3. 人間が投げるときの3択（ど真ん中に置いたときの帰結）
// ============================================================
//
// CPUの配球はカウントで決まるが、**人間は毎球3つから選べる**（説明書p19②）。
// 同じ「ど真ん中」で球速だけ変えたときに何が起きるかを見る＝**人間の投手側に
// 支配戦略があるか**の確認。

/** ど真ん中へまっすぐ投げた球をCPU打者が打った結果（曲げない＝人間の素直な球） */
function straightPitch(
  speed: number,
  batter: { power: number; average: number; run: number },
  side: 1 | -1,
) {
  let flight = createPitchFlight(0, speed, 0);
  let swingT: number | null = null;
  let swung = false;
  for (let i = 0; i < 600; i += 1) {
    const prev = flight;
    const next = stepPitchFlight(prev, 0, SIM_DT, 0);
    if (swingT === null && !swung && crossesSwingDecisionPoint(prev, next)) {
      if (shouldCpuSwing(next, { balls: 0, strikes: 0 }, side, 0)) {
        swingT = 0;
        swung = true;
      }
    }
    if (swingT !== null) {
      const cross = contactPlaneCrossing(prev, next);
      if (cross) {
        const launch = judgeSwing(
          { crossX: cross.x, swingTime: swingT + cross.frac * SIM_DT, pitchSpeed: prev.vz },
          { power: batter.power, average: batter.average },
          side,
          0,
          0,
        );
        if (launch) return { launch, contactX: cross.x, swingTime: swingT + cross.frac * SIM_DT };
        swingT = null;
      }
    }
    flight = next;
    if (swingT !== null) swingT += SIM_DT;
    if (next.z >= CATCH_Z) return null;
  }
  return null;
}

console.log('\n=== 3. 人間が「ど真ん中」に投げたときの3択（CPU打者144人） ===');
{
  console.log(`${'球速'.padEnd(16)}${row(['アウト', '安打', 'HR', 'ファウル', '平均方向', 'スイング'], 10)}`);
  for (const [label, speed] of [
    ['速球 42m/s', SPEED_FAST],
    ['基準 36m/s', SPEED_NEUTRAL],
    ['フォーク 22m/s', SPEED_SLOW],
  ] as const) {
    let out = 0;
    let hits = 0;
    let hr = 0;
    let foul = 0;
    let n = 0;
    const dirs: number[] = [];
    let swingTimeSum = 0;
    for (const m of matchups()) {
      for (const id of m.off.lineup) {
        const b = m.off.players[id];
        const side = batterSideOf(b.batting, m.pitcher);
        const hit = straightPitch(speed, b.batting, side);
        n += 1;
        if (!hit) continue;
        swingTimeSum += hit.swingTime;
        const play = simulatePlay(hit.launch, hit.contactX, {
          runnerSpeed: runnerSpeed(b.batting.run),
        });
        const o = paOutcomeOf({ timing: 0, course: 0, result: play });
        dirs.push(play.directionDeg);
        if (o === null) foul += 1;
        else if (o === 'out') out += 1;
        else {
          hits += 1;
          if (o === 'homerun') hr += 1;
        }
      }
    }
    const meanDir = dirs.length ? dirs.reduce((s, d) => s + d, 0) / dirs.length : 0;
    console.log(
      `${label.padEnd(16)}${row(
        [
          pct(out / n),
          pct(hits / n),
          pct(hr / n),
          pct(foul / n),
          `${meanDir.toFixed(0)}°`,
          `${(swingTimeSum / Math.max(1, dirs.length)).toFixed(3)}s`,
        ],
        10,
      )}`,
    );
  }
  console.log(
    `   スイングの理想は 0.090s＝そこからのズレが引っ張り（+）／流し（-）。方向は ズレ×${MAX_DIRECTION_DEG}°。`,
  );
}

// ============================================================
// 4. 速球の打球が「ファウルラインの上」に乗っている
// ============================================================
//
// 2・3段目の平均方向がどちらも 40°台＝**ファウルライン（±45°）のすぐ内側**。
// ここが本当に境界の上なら、**HRになるかファウルになるかが投手のわずかな球速差で
// 決まる**ことになるので、名鑑96人の速球で方向を並べて確かめる。

console.log('\n=== 4. 速球を打った打球の方向（名鑑96投手 × 打線9人） ===');
{
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
        const side = batterSideOf(b.batting, pit);
        const p = simulatePitch(
          profile,
          control,
          arm,
          { balls: 0, strikes: 0 },
          { power: b.batting.power, average: b.batting.average },
          side,
          0,
          0,
          0,
          SWING_AT_NORMAL,
        );
        if (!p.launch) continue;
        const play = simulatePlay(p.launch, p.contactX, {
          runnerSpeed: runnerSpeed(b.batting.run),
        });
        n += 1;
        const a = Math.abs(play.directionDeg);
        const key = a >= 45 ? '45°以上(ファウル)' : a >= 42 ? '42〜45°' : a >= 39 ? '39〜42°' : a >= 30 ? '30〜39°' : '30°未満';
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
        if (play.outcome.kind !== 'foul') fair += 1;
        if (play.outcome.kind === 'homerun') hr += 1;
      }
    }
  }
  console.log(`${'方向の帯'.padEnd(20)}${row(['打球', '割合'])}`);
  for (const key of ['45°以上(ファウル)', '42〜45°', '39〜42°', '30〜39°', '30°未満']) {
    const v = buckets.get(key) ?? 0;
    if (v === 0) continue;
    console.log(`${key.padEnd(20)}${row([String(v), pct(v / n)])}`);
  }
  console.log(
    `\n   フェアになった打球 ${pct(fair / n)}／そのうちHR ${pct(hr / Math.max(1, fair))}（HRは全打球の ${pct(hr / n)}）`,
  );
  console.log('   ＝**ファウルラインの上に山がある**なら、HRとファウルは投手の球速差で入れ替わる。');
}

// ============================================================
// 5. 球場別（両翼が短い球場ほどライン際の打球が入る）
// ============================================================

console.log('\n=== 5. 球場別（速球を引っ張った打球がどれだけ入るか） ===');
{
  console.log(`${'球場'.padEnd(14)}${row(['両翼', '中堅', 'HR率', 'ファウル率'], 11)}`);
  for (const park of BALLPARKS) {
    let n = 0;
    let hr = 0;
    let foul = 0;
    for (const m of matchups()) {
      const profile = pitchProfileOf(m.pitcher, 0);
      const control = controlOf(m.pitcher, 0);
      const arm = pitchArmOf(m.pitcher.throws);
      for (const id of m.off.lineup) {
        const b = m.off.players[id];
        const side = batterSideOf(b.batting, m.pitcher);
        const p = simulatePitch(
          profile,
          control,
          arm,
          { balls: 0, strikes: 0 },
          { power: b.batting.power, average: b.batting.average },
          side,
          0,
          0,
          0,
          SWING_AT_NORMAL,
        );
        if (!p.launch) continue;
        const play = simulatePlay(p.launch, p.contactX, {
          park,
          runnerSpeed: runnerSpeed(b.batting.run),
        });
        n += 1;
        if (play.outcome.kind === 'homerun') hr += 1;
        if (play.outcome.kind === 'foul') foul += 1;
      }
    }
    console.log(
      `${park.name.padEnd(14)}${row(
        [`${park.wing}m`, `${park.center}m`, pct(hr / n), pct(foul / n)],
        11,
      )}`,
    );
  }
}

// ============================================================
// 6. 既存の計測が置いていた仮定との差
// ============================================================

console.log('\n=== 6. 得点・HRの見積もりは何倍ずれているか（16球団平均・1試合） ===');
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
    console.log(`${label.padEnd(24)}${row([f2(runs / ROSTERS.length), f2(hr / ROSTERS.length)], 11)}`);
  };
  console.log(`${'分布の作り方'.padEnd(24)}${row(['得点/試合', 'HR/試合'], 11)}`);
  summarize('一様な格子（既存の既定）', undefined);
  summarize('t=0固定（JJ-57の7段目）', 0);

  // 実測＝1段目の打席をそのまま分布にする（決定的なので1人1つの帰結＝確率1の分布）
  let runs = 0;
  let hr = 0;
  for (const m of matchups()) {
    const lineup = m.off.lineup.map((id) => {
      const r = simulateAtBat(m.pitcher, m.off.players[id].batting);
      const d = { out: 0, single: 0, double: 0, triple: 0, homerun: 0 };
      if (r.kind === 'inPlay') d[r.outcome!] = 1;
      else d.out = 1;
      return d;
    });
    const solved = solveLineup(lineup);
    runs += solved.runs;
    for (let i = 0; i < lineup.length; i += 1) hr += lineup[i].homerun * solved.pa[i];
  }
  console.log(
    `${'**実測の打席（1段目）**'.padEnd(22)}${row([f2(runs / ROSTERS.length), f2(hr / ROSTERS.length)], 11)}`,
  );
  console.log('   参考：実際の野球は1チーム1試合あたり 約4.5点・HR 約1.1〜1.3本。');
  console.log(
    '   ※上2つは「当たった後」の格子から作った分布＝**振るかどうか**が入っていない。実測は1段目そのもの。',
  );
}

// ============================================================
// 7. 好調（D-19）とラッキー7
// ============================================================

console.log('\n=== 7. 好調の寄与（実際の打席で測る） ===');
{
  const measure = (hotCount: number): { hr: number; hits: number; n: number } => {
    let hr = 0;
    let hits = 0;
    let n = 0;
    for (const m of matchups()) {
      m.off.lineup.forEach((id, i) => {
        const b = m.off.players[id].batting;
        const hot = i < hotCount;
        const batting = {
          ...b,
          power: Math.min(1, b.power + (hot ? (HOT_MODIFIER.power ?? 0) : 0)),
          average: Math.min(1, b.average + (hot ? (HOT_MODIFIER.average ?? 0) : 0)),
        };
        const r = simulateAtBat(m.pitcher, batting);
        n += 1;
        if (r.outcome === 'homerun') hr += 1;
        if (r.outcome && r.outcome !== 'out') hits += 1;
      });
    }
    return { hr, hits, n };
  };
  console.log(`${'状態'.padEnd(20)}${row(['HR率', '安打率'], 11)}`);
  for (const [label, hot] of [
    ['好調なし', 0],
    ['好調2人（D-19）', 2],
    ['全員好調（ラッキー7）', 9],
  ] as const) {
    const r = measure(hot);
    console.log(`${label.padEnd(20)}${row([pct(r.hr / r.n), pct(r.hits / r.n)], 11)}`);
  }
}

// ============================================================
// 8. 原因はどこにあるか＝速球のタイミング罰を振る
// ============================================================
//
// 2〜4段目が示すのは「**速球はCPU打者に引っ張られ、その角度がファウルラインの上に
// 乗っている**」こと。引っ張り角は `judgeSwing` の `timing × MAX_DIRECTION_DEG` で
// 決まり、その `timing` を作っているのが `cpuBatter.ts` の
// **CPU_FAST_TIMING_PENALTY_SEC**（セッション9で「CPUが速球を100%HRにする」対策として
// 入れた早振り）。**罰そのものを振ると何が起きるか**を並べる＝直すならどこを触るか、の帯。
//
// ここだけ `cpuSwingLead` を使わず自前で lead を作る（定数を触らずに振るため）。

console.log('\n=== 8. 速球のタイミング罰を振ったら（人間がど真ん中へ速球） ===');
{
  const timeToPlane = (f: { z: number; vz: number }): number =>
    f.vz <= 0 ? Infinity : (CONTACT_PLANE_Z - f.z) / f.vz;

  const hitOnce = (
    speed: number,
    penalty: number,
    batter: { power: number; average: number },
    side: 1 | -1,
  ) => {
    const fastness = Math.min(1, Math.max(0, (speed - SPEED_NEUTRAL) / (SPEED_FAST - SPEED_NEUTRAL)));
    const lead = SWING_IDEAL_SEC + penalty * fastness;
    let flight = createPitchFlight(0, speed, 0);
    let swingT: number | null = null;
    let swung = false;
    for (let i = 0; i < 600; i += 1) {
      const prev = flight;
      const next = stepPitchFlight(prev, 0, SIM_DT, 0);
      if (swingT === null && !swung && timeToPlane(prev) > lead && timeToPlane(next) <= lead) {
        if (shouldCpuSwing(next, { balls: 0, strikes: 0 }, side, 0)) {
          swingT = 0;
          swung = true;
        }
      }
      if (swingT !== null) {
        const cross = contactPlaneCrossing(prev, next);
        if (cross) {
          const launch = judgeSwing(
            { crossX: cross.x, swingTime: swingT + cross.frac * SIM_DT, pitchSpeed: prev.vz },
            batter,
            side,
            0,
            0,
          );
          if (launch) return { launch, contactX: cross.x };
          swingT = null;
        }
      }
      flight = next;
      if (swingT !== null) swingT += SIM_DT;
      if (next.z >= CATCH_Z) return null;
    }
    return null;
  };

  console.log(`${'罰(秒)'.padEnd(10)}${row(['アウト', '安打', 'HR', 'ファウル', '空振り', '平均|方向|'], 10)}`);
  for (const penalty of [0, 0.02, 0.03, 0.045, 0.06, 0.08]) {
    let out = 0;
    let hits = 0;
    let hr = 0;
    let foul = 0;
    let miss = 0;
    let n = 0;
    const dirs: number[] = [];
    for (const m of matchups()) {
      const speed = speedForPitchSelection(-1, m.pitcher.speed);
      for (const id of m.off.lineup) {
        const b = m.off.players[id];
        const side = batterSideOf(b.batting, m.pitcher);
        const hit = hitOnce(speed, penalty, b.batting, side);
        n += 1;
        if (!hit) {
          miss += 1;
          continue;
        }
        const play = simulatePlay(hit.launch, hit.contactX, {
          runnerSpeed: runnerSpeed(b.batting.run),
        });
        const o = paOutcomeOf({ timing: 0, course: 0, result: play });
        dirs.push(Math.abs(play.directionDeg));
        if (o === null) foul += 1;
        else if (o === 'out') out += 1;
        else {
          hits += 1;
          if (o === 'homerun') hr += 1;
        }
      }
    }
    const meanDir = dirs.length ? dirs.reduce((s, d) => s + d, 0) / dirs.length : 0;
    const mark = penalty === 0.045 ? ' ←現行' : '';
    console.log(
      `${penalty.toFixed(3).padEnd(10)}${row(
        [pct(out / n), pct(hits / n), pct(hr / n), pct(foul / n), pct(miss / n), `${meanDir.toFixed(1)}°`],
        10,
      )}${mark}`,
    );
  }
  console.log('   ファウルラインは ±45°＝**引っ張り角がその手前に乗ると、いちばん近い柵（両翼95m）へ向かう**。');
}

// ============================================================
// 9. 直し方の帯＝タイミングのずれによる減衰（TIMING_SPEED_PENALTY）を振る
// ============================================================
//
// 8段目が示すのは「**罰（CPUの早振り）1つでは良い帯が無い**」こと＝弱めればHR、強めれば
// 何も起きない（ファウルか空振り）。**引っ張り角は罰で決まり、飛距離は打球の減衰で
// 決まる**ので、触るなら後者のほう＝`judgeSwing` の `TIMING_SPEED_PENALTY`。
//
// **定数は書き換えずに測れる**：初速はこの係数に対して線形（quality の1つ目の因子）なので、
// 打球ベクトルを比で伸縮すれば厳密に同値になる（`homerun.ts` の「球速を 2δ 下げるのと
// 完全に同値」と同じやり方）。
//
// **芯（timing=0）の打球は1mmも動かない**（減衰は |timing| に比例する）＝
// **I-29の「芯を食った当たり」もJJ-57の抗力の帯も動かさずに、外した打球だけを弱められる**。

console.log('\n=== 9. タイミングのずれによる減衰を振ったら（速球・人間がど真ん中） ===');
{
  const timeToPlane = (f: { z: number; vz: number }): number =>
    f.vz <= 0 ? Infinity : (CONTACT_PLANE_Z - f.z) / f.vz;

  /** 現行の罰でCPUが速球を打った打球（タイミングのズレ込み）を集める */
  const samples: Array<{
    launch: { vx: number; vy: number; vz: number };
    contactX: number;
    timing: number;
    relief: number;
    run: number;
  }> = [];
  for (const m of matchups()) {
    const speed = speedForPitchSelection(-1, m.pitcher.speed);
    for (const id of m.off.lineup) {
      const b = m.off.players[id];
      const side = batterSideOf(b.batting, m.pitcher);
      let flight = createPitchFlight(0, speed, 0);
      let swingT: number | null = null;
      let swung = false;
      for (let i = 0; i < 600; i += 1) {
        const prev = flight;
        const next = stepPitchFlight(prev, 0, SIM_DT, 0);
        if (swingT === null && !swung && crossesSwingDecisionPoint(prev, next)) {
          if (shouldCpuSwing(next, { balls: 0, strikes: 0 }, side, 0)) {
            swingT = 0;
            swung = true;
          }
        }
        if (swingT !== null) {
          const cross = contactPlaneCrossing(prev, next);
          if (cross) {
            const st = swingT + cross.frac * SIM_DT;
            const launch = judgeSwing(
              { crossX: cross.x, swingTime: st, pitchSpeed: prev.vz },
              { power: b.batting.power, average: b.batting.average },
              side,
              0,
              0,
            );
            if (launch) {
              samples.push({
                launch,
                contactX: cross.x,
                timing: (st - SWING_IDEAL_SEC) / (SWING_ACTIVE_SEC / 2),
                relief: 1 - AVG_MISHIT_RELIEF * b.batting.average,
                run: b.batting.run,
              });
              break;
            }
            swingT = null;
          }
        }
        flight = next;
        if (swingT !== null) swingT += SIM_DT;
        if (next.z >= CATCH_Z) break;
      }
      // timeToPlane は上の判断関数の中で使われている（読みやすさのために名前だけ残す）
      void timeToPlane;
    }
  }

  console.log(`${'減衰'.padEnd(10)}${row(['平均初速', '平均飛距離', 'HR(ところざわ)', 'HR(かせんじき)', '安打', 'ファウル'], 13)}`);
  for (const penalty of [0.3, 0.35, 0.4, 0.45, 0.5, 0.6]) {
    let exitSum = 0;
    let carrySum = 0;
    let hrDefault = 0;
    let hrNarrow = 0;
    let hits = 0;
    let foul = 0;
    const narrow = BALLPARKS.find((p) => p.name === 'かせんじき') ?? DEFAULT_BALLPARK;
    for (const s of samples) {
      // 初速は減衰の係数に対して線形＝比で伸縮すれば厳密に同値
      const ratio =
        (1 - penalty * Math.abs(s.timing) * s.relief) /
        (1 - TIMING_SPEED_PENALTY * Math.abs(s.timing) * s.relief);
      const launch = {
        vx: s.launch.vx * ratio,
        vy: s.launch.vy * ratio,
        vz: s.launch.vz * ratio,
      };
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
    const n = samples.length;
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
  console.log('   柵までの距離：ところざわ 両翼95m／かせんじき 両翼85m（いちばん狭い）。');
  console.log('   **芯（timing=0）の打球はどの値でも1mmも動かない**（減衰は |timing| に比例する）。');
}

// ============================================================
// 10. 人間が芯（t=0）で捉えたら＝**テストプレイの「HRが出すぎ」の出どころ**
// ============================================================
//
// 1〜9段目は**CPU打者**（速球には早振りの罰が乗る）を測っている。**人間は自分で
// タイミングを合わせられる**ので、上手いプレイヤーの帰結はこちら＝`judgeSwing` に
// `SWING_IDEAL_SEC` をそのまま渡した打球。
//
// **CPUの初球は必ず速球**（`chooseCpuPitchPlan` は strikes===0 で 'fast'）なので、
// 「初球を待って芯で振る」は**毎打席かならず来る確定の機会**になる。フェーズRR-66 の
// 前は、ここが**長打力0.2の打者でも94%が本塁打**だった。

console.log('\n=== 10. 人間が芯（t=0）で捉えたときの帰結 ===');
{
  const perfect = (pitcher: PitcherStats, count: Count, batter: { power: number; average: number }, side: 1 | -1) => {
    const profile = pitchProfileOf(pitcher, 0);
    const plan = chooseCpuPitchPlan(count, cpuPitcherStyle(profile), controlOf(pitcher, 0));
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
          { crossX: cross.x, swingTime: SWING_IDEAL_SEC, pitchSpeed: prev.vz },
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
// 11. CPU打者の選球と空振り（フェーズSS-67）
// ============================================================
//
// QQ-65 が計測で見つけた構造＝**CPU打者は三振も四球もしない**（1打席1.51球で必ず
// 打球になり、見送りは0.00球）を埋めたのが SS-67。ここが採用値の根拠。
//
// 触ったのは4つで、**新しい定数は1つも増えていない**：
// (1) 罰を緩急の両側へ（`cpuSwingLead`）／(2) 追い込まれたら窓の縁まで泳ぐ／
// (3) 手を出す幅を実際に「甘い球」へ（`ゾーン ∓ 隅の余裕`）／
// (4) CPU投手はファウルで粘られたら反対の隅へ散らす（`foulsInAtBat`）。

console.log('\n=== 11. CPU打者の選球と空振り（SS-67。手を出す幅を振る） ===');
{
  const widths: Array<{ label: string; normal: number }> = [
    { label: 'ゾーン+隅（SS-67の前は 0.60）', normal: STRIKE_ZONE_HALF_WIDTH + 0.05 },
    { label: 'ゾーンいっぱい', normal: STRIKE_ZONE_HALF_WIDTH },
    { label: '**ゾーン-隅（採用）**', normal: SELECTIVE_HALF_WIDTH },
    { label: 'さらに1つ内', normal: SELECTIVE_HALF_WIDTH - 0.05 },
    { label: '投手の通常の狙いと同じ', normal: STRIKE_ZONE_HALF_WIDTH * 0.55 },
  ];
  console.log(
    `${'手を出す幅'.padEnd(26)}${['幅', '三振', '四球', '死球', 'インプレー', '球数', '最長'].map((s) => s.padStart(10)).join('')}`,
  );
  for (const w of widths) {
    const tally: Record<string, number> = {};
    let pitches = 0;
    let n = 0;
    let longest = 0;
    for (const m of matchups()) {
      for (const id of m.off.lineup) {
        const b = m.off.players[id];
        const r = simulateAtBat(m.pitcher, b.batting, {
          swingWidths: { normal: w.normal, twoStrike: TWO_STRIKE_HALF_WIDTH },
        });
        tally[r.kind] = (tally[r.kind] ?? 0) + 1;
        pitches += r.pitches;
        longest = Math.max(longest, r.pitches);
        n += 1;
      }
    }
    console.log(
      `${w.label.padEnd(26)}${[
        w.normal.toFixed(3),
        pct((tally['strikeout'] ?? 0) / n),
        pct((tally['walk'] ?? 0) / n),
        pct((tally['hitByPitch'] ?? 0) / n),
        pct((tally['inPlay'] ?? 0) / n),
        (pitches / n).toFixed(2),
        String(longest),
      ]
        .map((s) => s.padStart(10))
        .join('')}`,
    );
  }
  console.log('   **採用（ゾーン-隅）だけが4つの帰結を同時に生む**＝1つ広いと三振も四球も0%に戻り');
  console.log('   （投手の狙い＝0.40 を全部振ってしまう）、狭いと見送りばかりでインプレーが25%まで落ちる。');
  console.log('   ※SS-67当時の数字（三振6.3%/四球6.3%）とは違う＝TT-68で投手の通常の狙いが 0.2475→0.40 へ');
  console.log('   移ったので、**この幅と投手の狙いは同じ1点を挟んで向かい合っている**（幅を動かす意味も変わった）。');
  console.log('   「最長」は**打席が終わることの回帰**＝SS-67の前は40球（上限）に張り付く打席が5件あった。');
}

// ============================================================
// 12. CPU投手の通常の球の狙い（フェーズTT-68）
// ============================================================
//
// SS-67 が残した宿題＝**三振・四球が実際の野球の帯（22% / 8.5% / 3.9球）に届いていない**
// （実測 6.3% / 6.3% / 2.20球）。原因は**通常の球**（`balls<3` かつ `strikes<=balls`）の
// 狙いがゾーンのよく内側（`ゾーン半幅 × 0.55`＝0.2475）にあったことで、**CPU打者が手を
// 出す幅（0.40）のよく内側**＝必ず振られ、その約半分がそのまま打球になっていた。
//
// ## 見るべき境界は2つで、その間が「見逃しストライクの帯」
//
// - **0.40（`SELECTIVE_HALF_WIDTH`）**＝ここを越えるとCPU打者は**見送る**
// - **0.45（`STRIKE_ZONE_HALF_WIDTH`）**＝ここを越えると**ボール**
//
// 帯の幅はちょうど `CORNER_MARGIN` 1つぶん。**帰結は連続ではなく階段状に飛ぶ**
// （制球0.5以上の投手50人は膨らみが0に切り上げられて全員この1点に載るため）。

console.log('\n=== 12. CPU投手の通常の球の狙い（TT-68。ワールドXの絶対値を振る） ===');
{
  const HALF = STRIKE_ZONE_HALF_WIDTH;
  const targets: Array<{ label: string; x: number }> = [
    { label: 'ゾーン×0.55（TT-68の前）', x: HALF * 0.55 },
    { label: 'ゾーン×0.78', x: 0.35 },
    { label: '1つ手前', x: 0.39 },
    { label: '**ゾーン-隅（採用）**', x: NORMAL_TARGET_X },
    { label: '1つ外', x: 0.404 },
    { label: 'ゾーンの縁', x: HALF },
    { label: '決め球と同じ隅', x: TWO_STRIKE_HALF_WIDTH },
  ];
  console.log(
    `${'通常の球の狙い'.padEnd(22)}${['狙いX', '三振', '四球', '死球', 'インプレー', '球数', '2S到達', '3B到達', '最長']
      .map((s2) => s2.padStart(9))
      .join('')}`,
  );
  for (const t of targets) {
    const tally: Record<string, number> = {};
    let pitches = 0;
    let n = 0;
    let longest = 0;
    let twoStrike = 0;
    let threeBall = 0;
    for (const m of matchups()) {
      for (const id of m.off.lineup) {
        const b = m.off.players[id];
        const res = simulateAtBat(m.pitcher, b.batting, { aims: { normalTarget: t.x } });
        tally[res.kind] = (tally[res.kind] ?? 0) + 1;
        pitches += res.pitches;
        longest = Math.max(longest, res.pitches);
        if (res.maxStrikes >= 2) twoStrike += 1;
        if (res.maxBalls >= 3) threeBall += 1;
        n += 1;
      }
    }
    console.log(
      `${t.label.padEnd(22)}${[
        t.x.toFixed(3),
        pct((tally['strikeout'] ?? 0) / n),
        pct((tally['walk'] ?? 0) / n),
        pct((tally['hitByPitch'] ?? 0) / n),
        pct((tally['inPlay'] ?? 0) / n),
        (pitches / n).toFixed(2),
        pct(twoStrike / n),
        pct(threeBall / n),
        String(longest),
      ]
        .map((s2) => s2.padStart(9))
        .join('')}`,
    );
  }
  console.log('   実際の野球は 三振22% / 四球8.5% / 1打席3.9球（インプレーは約68%）。');
  console.log(
    `   境界：手を出す幅 ${SELECTIVE_HALF_WIDTH.toFixed(2)}（越えると見送る）／ゾーン ${HALF.toFixed(2)}（越えるとボール）。`,
  );
  console.log('   **採用（0.40）の帯は 0.3995〜0.4020 の 2.5mm しかない**＝ここが階段の1段。');

  // 名鑑96人の通常の球が、その狙いでどこに落ちるか（振られる／見逃しストライク／ボール）
  const STAFF = TEAMS.flatMap((t) => t.pitchers.map((r) => pitcherRowPitching(r)));
  console.log(
    `\n${'通常の球の狙い'.padEnd(22)}${['振られる', '見逃しS', 'ボール', '最大X'].map((s2) => s2.padStart(11)).join('')}`,
  );
  for (const t of targets) {
    let swung = 0;
    let called = 0;
    let ball = 0;
    let max = 0;
    for (const st of STAFF) {
      const spray = Math.max(0, cpuControlSpray(pitcherControl(st.era)));
      const x = Math.min(t.x + spray, CPU_CONTROL_MAX_TARGET);
      max = Math.max(max, x);
      if (x <= SELECTIVE_HALF_WIDTH) swung += 1;
      else if (x <= HALF) called += 1;
      else ball += 1;
    }
    console.log(
      `${t.label.padEnd(22)}${[String(swung), String(called), String(ball), max.toFixed(3)]
        .map((s2) => s2.padStart(11))
        .join('')}`,
    );
  }
  console.log(
    `   96人＝名鑑16球団×6人。隅の余裕（${CORNER_MARGIN.toFixed(2)}）が「見逃しSの帯」の幅そのもの。`,
  );
  console.log('   採用値では制球0.5以上の50人が「振られる」側の縁ちょうどに載る＝そこが階段の段差。');
}

// ============================================================
// 13. CPU打者の早振りの罰（フェーズTT-68の打者側）
// ============================================================
//
// SS-67 は「罰を一律に上げる」案を **1打席17球・ファウルの無限打席25%** で否定したが、
// **その計測は `foulsInAtBat`（ファウルで隅を散らす規則）を入れる前**のものだった。
// 12段目の狙い（0.40）と組み合わせて測り直す。

console.log('\n=== 13. CPU打者の早振りの罰（TT-68。12段目の採用値と組み合わせて振る） ===');
{
  console.log(
    `${'罰(秒)'.padEnd(22)}${['三振', '四球', '死球', 'インプレー', '球数', '得点', 'HR', '最長']
      .map((s2) => s2.padStart(10))
      .join('')}`,
  );
  const penalties: Array<{ label: string; sec: number }> = [
    { label: 'SS-67（0.045）', sec: 0.045 },
    { label: '下限', sec: 0.0455 },
    { label: '**窓/3（採用）**', sec: CPU_TIMING_PENALTY_SEC },
    { label: '上限のすぐ外', sec: 0.0475 },
    { label: 'さらに上', sec: 0.05 },
    { label: '窓/2（＝2ストライクの罰）', sec: SWING_ACTIVE_SEC / 2 },
  ];
  for (const p of penalties) {
    const tally: Record<string, number> = {};
    let pitches = 0;
    let n = 0;
    let longest = 0;
    let runs = 0;
    let hr = 0;
    for (const m of matchups()) {
      const lineup: Array<{ out: number; single: number; double: number; triple: number; homerun: number }> = [];
      for (const id of m.off.lineup) {
        const b = m.off.players[id];
        const res = simulateAtBat(m.pitcher, b.batting, { swingPenalty: p.sec });
        tally[res.kind] = (tally[res.kind] ?? 0) + 1;
        pitches += res.pitches;
        longest = Math.max(longest, res.pitches);
        n += 1;
        const d = { out: 0, single: 0, double: 0, triple: 0, homerun: 0 };
        if (res.kind === 'inPlay') d[res.outcome!] = 1;
        else d.out = 1;
        lineup.push(d);
      }
      const solved = solveLineup(lineup);
      runs += solved.runs;
      for (let i = 0; i < lineup.length; i += 1) hr += lineup[i].homerun * solved.pa[i];
    }
    console.log(
      `${p.label.padEnd(22)}${[
        p.sec.toFixed(4),
        pct((tally['strikeout'] ?? 0) / n),
        pct((tally['walk'] ?? 0) / n),
        pct((tally['hitByPitch'] ?? 0) / n),
        pct((tally['inPlay'] ?? 0) / n),
        (pitches / n).toFixed(2),
        f2(runs / ROSTERS.length),
        f2(hr / ROSTERS.length),
      ]
        .map((s2) => s2.padStart(10))
        .join('')}${String(longest).padStart(10)}`,
    );
  }
  console.log('   **無限ファウルは起きない**（最長6球）＝SS-67が否定したときの前提（罰1つでは終わらない打席が出る）は');
  console.log('   `foulsInAtBat` で既に塞がっていた。');
  console.log('   **上限は「CPU打線の本塁打が消えないこと」**＝0.0475以上では HR 0.00本/試合（弱い当たりしか出ない）。');
  console.log('   0.050 まで上げると 3段目（人間の3択）の**ど真ん中のフォークが100%ファウル**になる＝');
  console.log('   SS-67が消した「人間の投手側の支配戦略」が別の形で戻る。採用値では3段目はSS-67と完全に同じ。');
}


// ============================================================
// 14. 人間のタイミングのばらつきと有効窓（テストプレイの指摘②「空振りがほぼない」）
// ============================================================
//
// 1〜13段目はすべて**CPU打者**か**人間が芯（t=0）で捉えたとき**しか測っていない。
// だが実際に画面で起きているのは**人間が押すタイミングにばらつきがある**ときの帰結で、
// そこは一度も測られていなかった（QQ-65 が「t=0 は基準速のときの姿でしかない」と
// 書いたのと同じ穴の、人間側の分）。
//
// ## 測り方（定数を1つも書き換えずに窓を振る）
//
// 有効窓 `W` のとき、押す時刻の誤差 `e` に対して
// **接触するのは |e| <= W/2 のときだけ**で、そのときの正規化タイミングは `e / (W/2)`。
// `judgeSwing` は正規化タイミングしか見ない（`timing` に畳んでから使う）ので、
// **同じ正規化タイミングを現行の定数で作って渡せば、窓を変えたのと同じ結果になる**
// ＝`swingWidths`（SS-67）・`aims`（TT-68）と同じ「定数を書き換えずに振る」作法。
//
// ばらつき σ は**人が視覚の合図に対して押すときの標準偏差**（30〜50ms が目安）。

console.log('\n=== 14. 人間のタイミングのばらつきと有効窓（TT-68の後の人間の打席） ===');
{
  /** 正規分布の乱数は使わない＝**誤差を等間隔の格子で舐める**（決定的） */
  const ERR_STEPS = 161;
  const gauss = (x: number, sigma: number): number => Math.exp(-(x * x) / (2 * sigma * sigma));

  /** CPUの配球を1球投げて、打撃面を通過するコースと球速を返す（10段目と同じ経路） */
  const pitchAt = (pitcher: PitcherStats, count: Count) => {
    const profile = pitchProfileOf(pitcher, 0);
    const plan = chooseCpuPitchPlan(count, cpuPitcherStyle(profile), controlOf(pitcher, 0));
    const offset = armReleaseOffsetX(pitchArmOf(pitcher.throws));
    const shape = planCpuPitchShape(plan, profile, undefined, offset);
    let flight = createPitchFlight(releaseXFor(shape.plateX, offset), shape.speed, 0);
    let since = 0;
    for (let i = 0; i < 600; i += 1) {
      since += SIM_DT;
      const prev = flight;
      const next = stepPitchFlight(prev, shape.steerX, SIM_DT, cpuSteerAccelAt(shape, since - SIM_DT, SIM_DT));
      const cross = contactPlaneCrossing(prev, next);
      if (cross) return { crossX: cross.x, speed: prev.vz };
      flight = next;
      if (next.z >= CATCH_Z) return null;
    }
    return null;
  };

  const COUNTS_H: Array<{ label: string; count: Count }> = [
    { label: '初球の速球(0-0)', count: { balls: 0, strikes: 0 } },
    { label: '3ボールの置き球(3-0)', count: { balls: 3, strikes: 0 } },
  ];
  const WINDOWS = [0.14, 0.12, 0.11, 0.1, 0.09, 0.08];
  const SIGMAS = [0.03, 0.04, 0.05];

  for (const c of COUNTS_H) {
    console.log(`\n   ── ${c.label}（長打力0.5・ところざわ） ──`);
    console.log(
      `${'有効窓'.padEnd(8)}${['押せる幅', 'σ30 空振り', 'ファウル', '安打', 'HR', 'σ40 空振り', 'ファウル', '安打', 'HR', 'σ50 空振り', 'ファウル', '安打', 'HR']
        .map((x) => x.padStart(10))
        .join('')}`,
    );
    for (const w of WINDOWS) {
      const cells: string[] = [`±${((w / 2) * 1000).toFixed(0)}ms`];
      for (const sigma of SIGMAS) {
        let wt = 0;
        let whiff = 0;
        let hr = 0;
        let foul = 0;
        let hits = 0;
        for (const m of matchups()) {
          const p = pitchAt(m.pitcher, c.count);
          if (!p) continue;
          for (const id of m.off.lineup) {
          const b = m.off.players[id].batting;
          for (let i = 0; i < ERR_STEPS; i += 1) {
            // 誤差は ±3σ を等間隔で舐め、正規分布の重みを掛ける（乱数は使わない）
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
            if (play.outcome.kind === 'homerun') hr += weight;
            else if (paOutcomeOf({ timing: 0, course: 0, result: play }) === null) foul += weight;
            else if (paOutcomeOf({ timing: 0, course: 0, result: play }) !== 'out') hits += weight;
          }
          }
        }
        cells.push(pct(whiff / wt), pct(foul / wt), pct(hits / wt), pct(hr / wt));
      }
      console.log(`${w.toFixed(2).padEnd(8)}${cells.map((x) => x.padStart(10)).join('')}`);
    }
  }
  console.log('\n   実際の野球は**振った球の約25%が空振り**（1打席あたりでは三振22%）。');
  console.log('   「空振り」には**窓を外した**ぶんと**バットが届かなかった**ぶんの両方が入る。');
  console.log('   **打球の質（HR率・安打率・飛距離）は窓を変えても1mmも動かない**＝動くのは');
  console.log('   「当たるかどうか」と「当たったときの正規化タイミングの散らばり」だけ。');
}
