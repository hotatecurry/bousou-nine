/**
 * 配球のコースに持ち味＝**制球**（フェーズT-41）の計測。
 *
 *   npm run balance:control
 *
 * S-40 が「今回は意図的に触っていない」として明示的に残した最後の1つを、勘で決めずに
 * 数字にしてから定数を決める（CLAUDE.md「バランス調整の方針」）。
 *
 * 1段目：**ERA→制球の換算**（名鑑96人がこの幅に散らばっているか＝規則が死なないか）。
 * 2段目：**狙う位置と、見逃したときの判定**（制球ごと × カウント区分 × 打席の立ち位置）。
 * 3段目：**膨らみの曲線**（`CPU_CONTROL_CURVE`）＝この計測がいちばん決めたいもの。
 * 4段目：**見逃し続けたときの打席の帰結**（96人ぶんの三振／四球／死球）。
 * 5段目：**打者の対抗手段**（O-36の立ち位置で死球を避けられるか）。
 * 6段目：**打ちに行ける球がどれだけ減るか**と、**I-29の帯が動かないこと**の確認。
 *
 * ## この計測が答えられること／答えられないこと
 *
 * 制球が動かすのは**投球がゾーンに入るか（見逃したときの判定）**であって、
 * `sweep.ts` の分母（バットに当たった打球をタイミング×コースで一様に取る）には
 * 投球のコースが入っていない。つまり **I-29 で測った「当たったときの打たれ方」は
 * 原理的に動かない**（6段目で確かめる）。動くのは四球・三振・死球のほうで、
 * そこは「打者が見逃し続けたら」という決定的な下限として測る
 * （人間がどの球に手を出すかの分布は分からない＝S-40が速球の値打ちを測れなかったのと同じ限界）。
 */
import {
  BATTER_STANCE_RANGE,
  BATTER_ZONE_MIN_X,
  COURSE_RELEASE_VX,
  COURSE_VX_PER_CONTROL,
  FATIGUE_CONTROL_LOSS,
  LEFT_BATTER_SIDE,
  PLATE_Z,
  RELEASE_Z,
  RIGHT_BATTER_SIDE,
  STRIKE_ZONE_HALF_WIDTH,
  type BatterSide,
  batterFrameX,
  courseReleaseVxFor,
  fatiguedControl,
  judgePitch,
  speedForPitchSelection,
} from '../../src/core/pitch';
import { batReachFor } from '../../src/core/batting';
import {
  CPU_CONTROL_CURVE,
  CPU_CONTROL_EDGE,
  CPU_CONTROL_MAX_TARGET,
  CPU_RELIEF_REMAINING_THRESHOLD,
  chooseCpuPitchPlan,
  chooseCpuRelief,
  cpuControlSpray,
  cpuPitcherStyle,
} from '../../src/core/cpuPitcher';
import {
  CONTROL_ERA_BEST,
  CONTROL_ERA_WORST,
  eraWithControl,
  fatigueFromRemaining,
  pitcherControl,
  pitcherQuality,
  pitcherRole,
  staminaRemaining,
} from '../../src/core/roster';
import { TEAMS, pitcherRowPitching } from '../../src/core/teams';
import type { Count } from '../../src/core/rules';

const row = (cells: readonly string[]): string => cells.map((c) => c.padStart(11)).join('');
const f2 = (v: number): string => v.toFixed(2);
const f3 = (v: number): string => v.toFixed(3);

/** 名鑑96人（16球団×6人） */
const PITCHERS = TEAMS.flatMap((t) =>
  t.pitchers.map((r) => ({
    name: r[0] as string,
    team: t.short,
    ...pitcherRowPitching(r),
  })),
);

/** 打席の立ち位置（O-36）。負がプレートに寄る／正が離れる */
const STANCES = [
  { label: 'ヨル', value: -BATTER_STANCE_RANGE },
  { label: 'チュウオウ', value: 0 },
  { label: 'ハナレル', value: BATTER_STANCE_RANGE },
] as const;

/** カウントの3区分（`chooseCpuPitchPlan` の3分岐そのもの） */
const COUNTS: ReadonlyArray<{ label: string; count: Count }> = [
  { label: 'ツウジョウ(0-0)', count: { balls: 0, strikes: 0 } },
  { label: 'キメダマ(0-2)', count: { balls: 0, strikes: 2 } },
  { label: 'オキニクル(3-0)', count: { balls: 3, strikes: 0 } },
];

// ============================================================
console.log('=== 1. ERA → 制球（名鑑96人の散らばり） ===\n');
console.log(`換算： ERA ${f2(CONTROL_ERA_BEST)} → 制球 1.00 ／ ERA ${f2(CONTROL_ERA_WORST)} → 制球 0.00`);

const controls = PITCHERS.map((p) => pitcherControl(p.era)).sort((a, b) => a - b);
const median = controls[Math.floor(controls.length / 2)];
const eras = PITCHERS.map((p) => p.era).sort((a, b) => a - b);
console.log(
  `名鑑の ERA： 最小 ${f2(eras[0])} / 中央値 ${f2(eras[Math.floor(eras.length / 2)])} / 最大 ${f2(eras[eras.length - 1])}`,
);
console.log(
  `名鑑の 制球： 最小 ${f3(controls[0])} / 中央値 ${f3(median)} / 最大 ${f3(controls[controls.length - 1])}`,
);
console.log(`  → 中央値が基準値0.5に乗っているか： ${Math.abs(median - 0.5) < 0.02 ? 'YES' : 'NO'}`);

const byControl = [...PITCHERS].sort((a, b) => pitcherControl(b.era) - pitcherControl(a.era));
console.log('\n制球の上位5人 / 下位5人：');
for (const p of byControl.slice(0, 5)) {
  console.log(`  ${p.team} ${p.name.padEnd(5)} ERA${f2(p.era)} 制球${f3(pitcherControl(p.era))}`);
}
console.log('  ...');
for (const p of byControl.slice(-5)) {
  console.log(`  ${p.team} ${p.name.padEnd(5)} ERA${f2(p.era)} 制球${f3(pitcherControl(p.era))}`);
}

console.log('\n球団ごとの制球（先発型4人の平均。R-39のローテーションで人間が順に浴びる4人）：');
const teamRows = TEAMS.map((t) => {
  const starters = t.pitchers.slice(0, 4).map((r) => pitcherControl(pitcherRowPitching(r).era));
  return { name: t.short, avg: starters.reduce((a, b) => a + b, 0) / starters.length };
}).sort((a, b) => b.avg - a.avg);
console.log(teamRows.map((t) => `${t.name}:${f2(t.avg)}`).join('  '));

// ============================================================
console.log('\n\n=== 2. 狙う位置と、見逃したときの判定 ===\n');
console.log('（制球ごとに、カウント区分の狙うX＝本塁通過位置。打者は右打者）\n');

const SAMPLE_CONTROLS = [1.0, 0.75, 0.5, 0.25, 0.0];
console.log(row(['制球', 'フクラミ', ...COUNTS.map((c) => c.label)]));
for (const control of SAMPLE_CONTROLS) {
  const cells = COUNTS.map(({ count }) => f3(chooseCpuPitchPlan(count, 'balanced', control).targetX));
  console.log(row([f2(control), f3(cpuControlSpray(control)), ...cells]));
}
console.log(
  `\n（ストライクゾーン半幅 ${STRIKE_ZONE_HALF_WIDTH} ／ 死球ゾーンの手前の縁 ${BATTER_ZONE_MIN_X}` +
    `（立ち位置で ±${BATTER_STANCE_RANGE} 動く） ／ 狙いの上限 ${f2(CPU_CONTROL_MAX_TARGET)}）`,
);

console.log('\n見逃したときの判定（右打者。ヨル=プレートに寄る／ハナレル=離れる）：\n');
console.log(row(['制球', ...COUNTS.map((c) => c.label)]));
for (const stance of STANCES) {
  console.log(`\n[立ち位置 ${stance.label}]`);
  for (const control of SAMPLE_CONTROLS) {
    const cells = COUNTS.map(({ count }) => {
      const { targetX } = chooseCpuPitchPlan(count, 'balanced', control);
      const call = judgePitch(targetX, RIGHT_BATTER_SIDE, stance.value);
      return call === 'strike' ? 'ストライク' : call === 'ball' ? 'ボール' : '★シキュウ';
    });
    console.log(row([f2(control), ...cells]));
  }
}

// ============================================================
console.log('\n\n=== 3. 膨らみの曲線（CPU_CONTROL_CURVE を決める） ===\n');

/** その曲線で、制球 c の投手が決め球で狙うX（上限も込み） */
const CORNER_MARGIN = 0.05;
function putawayTarget(control: number, curve: number): number {
  return Math.min(
    STRIKE_ZONE_HALF_WIDTH + CORNER_MARGIN + cpuControlSpray(control, curve),
    CPU_CONTROL_MAX_TARGET,
  );
}
function normalTarget(control: number, curve: number): number {
  return Math.min(
    STRIKE_ZONE_HALF_WIDTH * 0.55 + Math.max(0, cpuControlSpray(control, curve)),
    CPU_CONTROL_MAX_TARGET,
  );
}

console.log('曲線ごとの「いちばん荒れた投手（制球0）が決め球で狙うX」と、名鑑96人の内訳：\n');
console.log(
  row([
    'キョクセン',
    'セイギョ0',
    'ミノガシK',
    'シキュウ:ヨル',
    'シキュウ:中央',
    'シキュウ:ハナレ',
  ]),
);
for (const curve of [1, 2, 2.5, 3, 3.5, 4]) {
  const worst = putawayTarget(0, curve);
  let calledStrike = 0;
  const hbp = { near: 0, mid: 0, far: 0 };
  for (const p of PITCHERS) {
    const c = pitcherControl(p.era);
    // 決め球（隅）が見逃しストライクになる投手
    if (Math.abs(putawayTarget(c, curve)) <= STRIKE_ZONE_HALF_WIDTH) calledStrike += 1;
    // 死球ゾーンへ届く投手（決め球・通常のどちらかで）。**どちらの隅も「体側に来る
    // カウント」が必ずあるので、打者ローカル（＝体側）へ読み替えてから見る**
    // （隅の向きはボール数の偶奇で入れ替わる＝cornerSign。フェーズBB-49）
    const targets = [putawayTarget(c, curve), normalTarget(c, curve)].map((t) =>
      batterFrameX(t, RIGHT_BATTER_SIDE),
    );
    for (const [key, stance] of [
      ['near', -BATTER_STANCE_RANGE],
      ['mid', 0],
      ['far', BATTER_STANCE_RANGE],
    ] as const) {
      if (targets.some((t) => judgePitch(t, RIGHT_BATTER_SIDE, stance) === 'hitByPitch')) {
        hbp[key] += 1;
      }
    }
  }
  const mark = curve === CPU_CONTROL_CURVE ? ' ←採用' : '';
  console.log(
    row([
      String(curve),
      f3(worst),
      `${calledStrike}/96`,
      `${hbp.near}/96`,
      `${hbp.mid}/96`,
      `${hbp.far}/96`,
    ]) + mark,
  );
}
console.log(
  '\n判断の材料：\n' +
    '  - シキュウ:中央 が 0人 だと「荒れた投手はぶつけうる」（ユーザー判断）が死文になる。\n' +
    '  - シキュウ:中央 が多すぎると荒れが例外でなくなる（毎試合ぶつけられる）。\n' +
    '  - シキュウ:ハナレ は必ず 0人 でなければならない（＝打者に避ける手が実在する）。\n' +
    '  - ミノガシK は「制球が良い投手の値打ち」が実在する人数（0人だと値打ちが無い）。',
);

// ============================================================
console.log('\n\n=== 4. 見逃し続けたときの打席の帰結 ===\n');
console.log('（打者が1球も振らない＝制球だけで決まる下限。決定的なので1打席回せば決まる）\n');

type Outcome = 'サンシン' | 'シキュウ' | 'シキュウ(死球)';
function takeEverything(control: number, side: BatterSide, stance: number) {
  const count: Count = { balls: 0, strikes: 0 };
  for (let pitch = 1; pitch <= 12; pitch += 1) {
    const { targetX } = chooseCpuPitchPlan(count, 'balanced', control);
    const call = judgePitch(targetX, side, stance);
    if (call === 'hitByPitch') return { outcome: 'シキュウ(死球)' as Outcome, pitches: pitch };
    if (call === 'strike') {
      count.strikes += 1;
      if (count.strikes >= 3) return { outcome: 'サンシン' as Outcome, pitches: pitch };
    } else {
      count.balls += 1;
      if (count.balls >= 4) return { outcome: 'シキュウ' as Outcome, pitches: pitch };
    }
  }
  return { outcome: 'シキュウ' as Outcome, pitches: 12 };
}

for (const stance of STANCES) {
  const tally: Record<string, number> = {};
  let pitchSum = 0;
  for (const p of PITCHERS) {
    const r = takeEverything(pitcherControl(p.era), RIGHT_BATTER_SIDE, stance.value);
    tally[r.outcome] = (tally[r.outcome] ?? 0) + 1;
    pitchSum += r.pitches;
  }
  const parts = Object.entries(tally).map(([k, v]) => `${k} ${v}人`);
  console.log(
    `[立ち位置 ${stance.label.padEnd(6)}] ${parts.join(' / ')}  （平均 ${(pitchSum / PITCHERS.length).toFixed(1)}球）`,
  );
}

console.log('\nT-41の前（全投手が制球0.5相当）との比較：');
const before = takeEverything(0.5, RIGHT_BATTER_SIDE, 0);
console.log(`  全投手が ${before.outcome}（${before.pitches}球）＝「見逃し続ければ必ず四球」だった`);

console.log('\n制球ごとの内訳（右打者・打席中央）：');
console.log(row(['制球', 'ケッカ', 'タマカズ']));
for (const control of SAMPLE_CONTROLS) {
  const r = takeEverything(control, RIGHT_BATTER_SIDE, 0);
  console.log(row([f2(control), r.outcome, String(r.pitches)]));
}

console.log('\n左打者でも同じか（鏡像になっているだけか）：');
for (const control of SAMPLE_CONTROLS) {
  const r = takeEverything(control, RIGHT_BATTER_SIDE, 0);
  const l = takeEverything(control, LEFT_BATTER_SIDE, 0);
  const same = r.outcome === l.outcome && r.pitches === l.pitches;
  console.log(`  制球${f2(control)}： 右 ${r.outcome}(${r.pitches}) / 左 ${l.outcome}(${l.pitches}) ${same ? '' : '← 違う'}`);
}

// ============================================================
console.log('\n\n=== 5. 打者の対抗手段（O-36の立ち位置で避けられるか） ===\n');

let hbpAnywhere = 0;
let hbpEvenIfFar = 0;
const hbpPitchers: string[] = [];
for (const p of PITCHERS) {
  const c = pitcherControl(p.era);
  const targets: number[] = [];
  for (let balls = 0; balls <= 3; balls += 1) {
    for (let strikes = 0; strikes <= 2; strikes += 1) {
      for (const side of [RIGHT_BATTER_SIDE, LEFT_BATTER_SIDE] as const) {
        targets.push(chooseCpuPitchPlan({ balls, strikes }, 'balanced', c).targetX * side);
      }
    }
  }
  const hitsAt = (stance: number) =>
    targets.some((t) => judgePitch(t, RIGHT_BATTER_SIDE, stance) === 'hitByPitch');
  if (hitsAt(0)) {
    hbpAnywhere += 1;
    hbpPitchers.push(`${p.team}${p.name}(ERA${f2(p.era)})`);
  }
  if (hitsAt(BATTER_STANCE_RANGE)) hbpEvenIfFar += 1;
}
console.log(`打席の中央に立つと死球がありうる投手： ${hbpAnywhere}/96`);
console.log(`  → ${hbpPitchers.join(' ') || 'なし'}`);
console.log(`打席から離れても死球がありうる投手： ${hbpEvenIfFar}/96 （0でなければ設計の不変条件が壊れている）`);

console.log('\n荒れた投手に「寄る」ことの代償（O-36の判断に重みが増しているか）：');
for (const p of byControl.slice(-3)) {
  const c = pitcherControl(p.era);
  const putaway = chooseCpuPitchPlan({ balls: 0, strikes: 2 }, 'balanced', c).targetX;
  // 決め球の隅は体側に来るカウントで見る（向きはボール数の偶奇で入れ替わる）
  const bodySide = batterFrameX(Math.abs(putaway), RIGHT_BATTER_SIDE);
  const calls = STANCES.map(
    (s) => `${s.label}=${judgePitch(bodySide, RIGHT_BATTER_SIDE, s.value)}`,
  );
  console.log(`  ${p.team}${p.name} ERA${f2(p.era)} 決め球X=${f3(putaway)}  ${calls.join(' / ')}`);
}

// ============================================================
console.log('\n\n=== 6. 打ちに行ける球はどれだけ減るか（I-29の帯は動くか） ===\n');

console.log('バットが届く範囲に来る球の割合（12カウント × 右打者。届かない球は振っても当たらない）：\n');
console.log(row(['制球', 'トドク', 'ゾーンナイ']));
for (const control of SAMPLE_CONTROLS) {
  let reach = 0;
  let inZone = 0;
  let total = 0;
  for (let balls = 0; balls <= 3; balls += 1) {
    for (let strikes = 0; strikes <= 2; strikes += 1) {
      const { targetX } = chooseCpuPitchPlan({ balls, strikes }, 'balanced', control);
      const r = batReachFor(0);
      total += 1;
      if (targetX >= r.outside && targetX <= r.inside) reach += 1;
      if (Math.abs(targetX) <= STRIKE_ZONE_HALF_WIDTH) inZone += 1;
    }
  }
  console.log(
    row([f2(control), `${((reach / total) * 100).toFixed(0)}%`, `${((inZone / total) * 100).toFixed(0)}%`]),
  );
}
console.log(
  '\nI-29の帯（安打率・HR率）について：\n' +
    '  `sweep.ts` の分母は「バットに当たった打球」をタイミング×コースで一様に取るので、\n' +
    '  **投球がどこへ来たか**は分母に入っていない。したがって制球を入れても\n' +
    '  **I-29 で測った打たれ方の分布は1つも動かない**（動くのは上の「届く球の割合」＝\n' +
    '  そもそも振る値打ちがある球が何球あるか、のほう）。\n' +
    '  → `npm run balance` の出力がT-41の前後で完全に一致することで確かめられる。',
);

// ============================================================
console.log('\n\n=== 7. 持ち味（S-40）との噛み合わせ ===\n');
console.log('制球と持ち味は別の軸になっているか（同じ投手に偏っていないか）：\n');
const cross: Record<string, { n: number; controlSum: number }> = {};
for (const p of PITCHERS) {
  const style = cpuPitcherStyle({
    speed: p.speed,
    breakLeft: p.breakLeft,
    breakRight: p.breakRight,
    fork: p.fork,
  });
  const key = style;
  cross[key] ??= { n: 0, controlSum: 0 };
  cross[key].n += 1;
  cross[key].controlSum += pitcherControl(p.era);
}
for (const [style, v] of Object.entries(cross)) {
  console.log(`  ${style.padEnd(9)} ${v.n}人  平均制球 ${f3(v.controlSum / v.n)}`);
}
const starters = PITCHERS.filter((p) => pitcherRole(p.stamina) === 'starter');
const relievers = PITCHERS.filter((p) => pitcherRole(p.stamina) === 'reliever');
const avg = (xs: typeof PITCHERS) =>
  xs.reduce((a, p) => a + pitcherControl(p.era), 0) / Math.max(1, xs.length);
console.log(`\n  先発型 ${starters.length}人 平均制球 ${f3(avg(starters))}`);
console.log(`  リリーフ型 ${relievers.length}人 平均制球 ${f3(avg(relievers))}`);
console.log(`\n（制球の下限マージン CPU_CONTROL_EDGE = ${CPU_CONTROL_EDGE}）`);

// ============================================================
// 以下はフェーズW-44（制球を疲労とスキルへ広げる）で足した段。
// ============================================================

/** 基準球速でのリリース→本塁の飛行時間（コース入力のズレ幅がここで決まる） */
const flightSecNeutral = (PLATE_Z - RELEASE_Z) / speedForPitchSelection(0);
/** 制球1.0ぶんで `COURSE_RELEASE_VX` をどれだけ動かすかの候補（10段目で決める） */
const CANDIDATE_VX_PER_CONTROL = COURSE_VX_PER_CONTROL;

/** その制球の投手が、決め球／通常の球で狙うX（上限も込み。3段目のものを再利用） */
function targetsFor(control: number): readonly number[] {
  return [putawayTarget(control, CPU_CONTROL_CURVE), normalTarget(control, CPU_CONTROL_CURVE)];
}
/** 名鑑96人を、その制球の求め方で数え上げる */
function tallyPitchers(controlOf: (era: number) => number) {
  let cappedTarget = 0; // 狙いが上限に張り付いた（＝そこから先は荒れの差が消える）
  let calledStrike = 0; // 決め球が見逃しストライク（制球の値打ち）
  const hbp = { near: 0, mid: 0, far: 0 };
  for (const p of PITCHERS) {
    const c = controlOf(p.era);
    const targets = targetsFor(c);
    if (targets[0] >= CPU_CONTROL_MAX_TARGET - 1e-9) cappedTarget += 1;
    if (targets[0] <= STRIKE_ZONE_HALF_WIDTH) calledStrike += 1;
    for (const [key, stance] of [
      ['near', -BATTER_STANCE_RANGE],
      ['mid', 0],
      ['far', BATTER_STANCE_RANGE],
    ] as const) {
      // 隅の向きはボール数の偶奇で入れ替わる（cornerSign）ので、**体側に来るカウント**
      // で見る＝狙いを打者ローカルからワールドへ読み替える（フェーズBB-49）
      if (
        targets.some(
          (t) => judgePitch(batterFrameX(t, RIGHT_BATTER_SIDE), RIGHT_BATTER_SIDE, stance) ===
            'hitByPitch',
        )
      ) {
        hbp[key] += 1;
      }
    }
  }
  return { cappedTarget, calledStrike, hbp };
}

// ============================================================
console.log('\n\n=== 8. 疲れると荒れる（FATIGUE_CONTROL_LOSS を決める） ===\n');
console.log(
  'B-11の疲労は 球速・変化量・球威 の3つに効く。**制球という軸そのものがT-41まで無かった**ので、\n' +
    'ここが4つ目になる。基準はP-37（CPU_BREAK_STEER_SEC）・T-41（CPU_CONTROL_CURVE）と同じ\n' +
    '「**名鑑96人で頭打ちになる投手が0人になる最大値**」＝張り付いた投手どうしは荒れの差が消える。\n',
);
console.log('（疲労MAX＝残量0。左端の 0.00 が「疲労を入れない」＝T-41の現状）\n');
console.log(
  row(['ソンシツ', 'アタマウチ', 'ミノガシK', 'シキュウ:ヨル', 'シキュウ:中央', 'シキュウ:ハナレ']),
);
const LOSS_CANDIDATES = [0, 0.1, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5];
for (const loss of LOSS_CANDIDATES) {
  const t = tallyPitchers((era) => fatiguedControl(pitcherControl(era), 1, loss));
  const mark = loss === FATIGUE_CONTROL_LOSS ? ' ←採用' : '';
  console.log(
    row([
      f2(loss),
      `${t.cappedTarget}/96`,
      `${t.calledStrike}/96`,
      `${t.hbp.near}/96`,
      `${t.hbp.mid}/96`,
      `${t.hbp.far}/96`,
    ]) + mark,
  );
}
console.log(
  '\n判断の材料（T-41の3段目と同じ並び）：\n' +
    '  - アタマウチ が 0人 でなくなった時点で「荒れた投手どうしの差」が消え始める＝上限。\n' +
    '  - ミノガシK が減ること自体が「疲れると決め球が甘くならず外れる」＝効いている証拠。\n' +
    '  - シキュウ:ハナレ は必ず 0人（＝打者は離れて立てば避けられる。T-41の不変条件）。',
);

console.log('\n疲労の段階ごとに、代表的な投手の決め球がどこへ行くか：\n');
console.log(row(['セイギョ', 'ヒロウ0', 'ヒロウ0.25', 'ヒロウ0.5', 'ヒロウ0.75', 'ヒロウ1.0']));
for (const control of SAMPLE_CONTROLS) {
  const cells = [0, 0.25, 0.5, 0.75, 1].map((fat) =>
    f3(putawayTarget(fatiguedControl(control, fat), CPU_CONTROL_CURVE)),
  );
  console.log(row([f2(control), ...cells]));
}

console.log('\n見逃し続けたときの帰結が、疲労で実際に変わる人数（右打者・打席中央）：');
for (const fat of [0, 0.25, 0.5, 0.75, 1]) {
  const tally: Record<string, number> = {};
  let changed = 0;
  for (const p of PITCHERS) {
    const base = pitcherControl(p.era);
    const before = takeEverything(base, RIGHT_BATTER_SIDE, 0);
    const after = takeEverything(fatiguedControl(base, fat), RIGHT_BATTER_SIDE, 0);
    tally[after.outcome] = (tally[after.outcome] ?? 0) + 1;
    if (before.outcome !== after.outcome || before.pitches !== after.pitches) changed += 1;
  }
  const parts = Object.entries(tally).map(([k, v]) => `${k} ${v}人`);
  console.log(`  疲労 ${f2(fat)}： ${parts.join(' / ')}  （無傷から変わった ${changed}/96人）`);
}

// ============================================================
console.log('\n\n=== 9. その疲労は実際に起きるのか（J-30の自動継投との噛み合わせ） ===\n');
console.log(
  '**制球が効くのはCPU投手だけ**（ユーザー判断）だが、そのCPU投手はJ-30の自動継投で\n' +
    `**残量が ${CPU_RELIEF_REMAINING_THRESHOLD} を切った打席の切れ目に交代する**（＝疲労が0を超えた直後）。\n` +
    'したがって「疲れて荒れる」場面が実際に生まれるのかを先に確かめる（J-30がランダンの帯を\n' +
    '測って「規則は正しいが発火しない」と結論したのと同じ手順）。\n' +
    '\n' +
    '※ **この段はW-44当時の記録**（平均0.091）**ではなく、いまの規則で回した値が出る**：\n' +
    '  Z-47 で継投が「代えるか続投か」の比較になったので、ここも一緒に動く。\n' +
    '  W-44の結論（人間側にも制球の出口が要る）は変わらない＝人間はいまも自動で代わらない。\n' +
    '  Z-47そのものの計測は `npm run balance:relief`。\n',
);

/** 1打席あたりの投球数（E-23のテンポではなく、実際の野球のおよその値） */
const PITCHES_PER_PA = 4;
/** 1試合で投手陣が投げるおよその球数 */
const PITCHES_PER_GAME = 140;

function simulateStaff(team: (typeof TEAMS)[number]) {
  const staff = team.pitchers.map((r) => pitcherRowPitching(r));
  const counts = staff.map(() => 0);
  let current = 0; // 先発＝名鑑の先頭（R-39の1試合目）
  const bullpen = staff.map((_, i) => i).filter((i) => i !== current);
  let maxFatigue = 0;
  let changes = 0;
  // **Z-47以降の意味**：交代せずに「疲れたまま投げ続け始めた」球目。
  // （Z-47の前は「ブルペンが尽きて代われなかった」場面だけを指していた）
  let keptTiredAt: number | null = null;
  const remainingOf = (i: number) => staminaRemaining(counts[i], staff[i].stamina);
  const qualityOf = (i: number) =>
    pitcherQuality(staff[i], fatigueFromRemaining(remainingOf(i)));
  for (let pitch = 1; pitch <= PITCHES_PER_GAME; pitch += 1) {
    if (pitch % PITCHES_PER_PA === 1 && pitch > 1) {
      // 打席の切れ目＝main.ts の tryCpuRelief が呼ばれる場所
      const idx = chooseCpuRelief(
        { remaining: remainingOf(current), quality: qualityOf(current) },
        bullpen.map((i, k) => ({
          index: k,
          remaining: remainingOf(i),
          reliever: pitcherRole(staff[i].stamina) === 'reliever',
          quality: qualityOf(i),
        })),
      );
      if (idx !== null) {
        current = bullpen.splice(idx, 1)[0];
        changes += 1;
      } else if (remainingOf(current) < CPU_RELIEF_REMAINING_THRESHOLD && keptTiredAt === null) {
        keptTiredAt = pitch;
      }
    }
    counts[current] += 1;
    maxFatigue = Math.max(maxFatigue, fatigueFromRemaining(remainingOf(current)));
  }
  return { maxFatigue, changes, keptTiredAt, left: bullpen.length };
}

console.log(row(['キュウダン', 'サイダイヒロウ', 'コウタイ', 'ゾクトウカイシ', 'ノコリ']));
let fatigueSum = 0;
let anyWild = 0;
for (const team of TEAMS) {
  const r = simulateStaff(team);
  fatigueSum += r.maxFatigue;
  if (r.maxFatigue > 0.2) anyWild += 1;
  console.log(
    row([
      team.short,
      f3(r.maxFatigue),
      String(r.changes),
      r.keptTiredAt === null ? '-' : `${r.keptTiredAt}キュウメ`,
      String(r.left),
    ]),
  );
}
console.log(
  `\n16球団の平均最大疲労 ${f3(fatigueSum / TEAMS.length)} ／ 疲労0.2を超える球団 ${anyWild}/16`,
);
console.log(
  `（1試合 ${PITCHES_PER_GAME}球・1打席 ${PITCHES_PER_PA}球。ゾクトウカイシ＝疲れたまま投げ続け始めた球目）`,
);

console.log('\n\n人間側はどうか（**自動継投しない**＝采配は人間の取り分。B-11／J-30）：\n');
console.log(
  `先発を代えずに投げ切ったときの疲労（V-43の持ち越しぶんを開始残量として与える）：\n`,
);
console.log(row(['カイシザンリョウ', ...[60, 80, 100, 120, 140].map((n) => `${n}キュウ`)]));
for (const startRemaining of [1.0, 0.8, 0.6, 0.4]) {
  // 先発型の代表（STM 0.85＝容量110球）
  const stamina = 0.85;
  const cap = 25 + 100 * stamina;
  const carried = Math.round((1 - startRemaining) * cap);
  const cells = [60, 80, 100, 120, 140].map((n) =>
    f3(fatigueFromRemaining(staminaRemaining(carried + n, stamina))),
  );
  console.log(row([f2(startRemaining), ...cells]));
}
console.log(
  '\n→ **疲労が実際に高くなるのは人間の投手のほう**（CPUはJ-30が疲れる前に代える）。\n' +
    '  V-43で疲労がラン全体に持ち越されるようになったので、残量0.4で始まる登板もありうる。',
);

console.log('\n疲労で「狙える幅」が痩せるとどうなるか（人間側にも効かせた場合の試算）：\n');
console.log(row(['ヒロウ', 'セイギョゲン', 'VX', 'トドクX', 'スミニトドク']));
for (const fat of [0, 0.25, 0.5, 0.75, 1]) {
  const drop = FATIGUE_CONTROL_LOSS * fat;
  const vx = COURSE_RELEASE_VX + CANDIDATE_VX_PER_CONTROL * -drop;
  const reach = vx * flightSecNeutral;
  console.log(
    row([
      f2(fat),
      f2(-drop),
      f2(vx),
      f3(reach),
      reach >= STRIKE_ZONE_HALF_WIDTH ? 'トドク' : `${f3(STRIKE_ZONE_HALF_WIDTH - reach)}タリナイ`,
    ]),
  );
}
console.log(
  '\n（入力どおりの向きへは必ず動く＝**誤差を足すのではなく効き幅が痩せる**。\n' +
    '  B-11が疲労で球速・変化量を痩せさせているのとまったく同じ形で、T-41の\n' +
    '  「人間の投球は狙ったところへ行く」＝ズレを足さない、とも衝突しない）',
);

// ============================================================
console.log('\n\n=== 10. 制球スキル（補正量と、人間側のコース入力の幅） ===\n');
console.log('制球への補正 → ERAへの書き戻し（HUDの投手カードが実際に動く）：\n');
console.log(row(['ホセイ', 'ERAサ', 'エース2.0→', 'チュウオウチ3.1→', 'アレダマ4.3→']));
for (const delta of [0.1, 0.15, 0.2, 0.25, 0.3, -0.15, -0.2]) {
  console.log(
    row([
      (delta > 0 ? '+' : '') + f2(delta),
      f2(-delta * (CONTROL_ERA_WORST - CONTROL_ERA_BEST)),
      f2(eraWithControl(2.0, delta)),
      f2(eraWithControl(3.1, delta)),
      f2(eraWithControl(4.3, delta)),
    ]),
  );
}

console.log('\n名鑑96人に配ったときの動き（CPUが投げる側に回ったときの効き）：\n');
console.log(row(['ホセイ', 'ミノガシK', 'アタマウチ', 'シキュウ:中央']));
for (const delta of [0, 0.15, 0.2, 0.25, -0.15, -0.2]) {
  const t = tallyPitchers((era) => pitcherControl(eraWithControl(era, delta)));
  console.log(
    row([
      (delta > 0 ? '+' : '') + f2(delta),
      `${t.calledStrike}/96`,
      `${t.cappedTarget}/96`,
      `${t.hbp.mid}/96`,
    ]),
  );
}

console.log('\n人間が投げるときの効き（COURSE_RELEASE_VX への足し算＝狙える幅）：\n');
console.log(
  'ど真ん中のプレート位置からコース入力だけで届くX（基準球速。ゾーン半幅 ' +
    `${STRIKE_ZONE_HALF_WIDTH} / 死球ゾーンの縁 ${BATTER_ZONE_MIN_X}）：\n`,
);
/** CPUの決め球が狙う隅（`cpuPitcher.ts` の CORNER_MARGIN。この値に合わせるのが基準） */
const CPU_PUTAWAY_CORNER = STRIKE_ZONE_HALF_WIDTH + CORNER_MARGIN;
console.log(
  `基準：**制球 +0.20 の投手が、ど真ん中のプレート位置からCPUの決め球と同じ隅（${f2(CPU_PUTAWAY_CORNER)}）へ届く**\n` +
    '（新しい数値を持ち込まず、既にある隅に合わせる＝T-41の CORNER_MARGIN を使い回す）\n',
);
console.log(row(['1セイギョアタリ', 'VX(+0.20)', 'トドクX', 'キメダマノスミ', 'ヒロウ1.0デ']));
for (const perControl of [0.3, 0.45, 0.6, 0.9]) {
  const vx = COURSE_RELEASE_VX + perControl * 0.2;
  const reach = vx * flightSecNeutral;
  const tired = (COURSE_RELEASE_VX - perControl * FATIGUE_CONTROL_LOSS) * flightSecNeutral;
  const mark = perControl === COURSE_VX_PER_CONTROL ? ' ←採用' : '';
  console.log(
    row([
      f2(perControl),
      f2(vx),
      f3(reach),
      reach >= CPU_PUTAWAY_CORNER ? 'トドク' : `${f3(CPU_PUTAWAY_CORNER - reach)}タリナイ`,
      `${f3(tired)} (${((tired / (COURSE_RELEASE_VX * flightSecNeutral) - 1) * 100).toFixed(0)}%)`,
    ]) + mark,
  );
}
console.log(
  `\n（補正なしの届くX＝${f3(COURSE_RELEASE_VX * flightSecNeutral)}＝ゾーン半幅 ${STRIKE_ZONE_HALF_WIDTH} とほぼ同じ` +
    '＝W-44の前と同じ「ど真ん中から隅を突ける」）\n' +
    '判断の材料：\n' +
    '  - スキルの値打ち＝**ゾーンの外まで届く（ボール球で釣れる）**こと。\n' +
    '  - 疲労の代償＝**ど真ん中に立ったままでは隅が突けなくなる**こと（プレート位置や\n' +
    '    変化球と組み合わせれば従来どおり届く＝COURSE_RELEASE_VX が元から想定している役割分担）。\n' +
    '  - **向きは常に入力どおり**（0で下げ止める）＝どれだけ疲れてもコースは選べる。',
);

console.log('\n実際に使う関数（courseReleaseVxFor）での確認：\n');
console.log(row(['ホセイ', 'ヒロウ', 'VX', 'トドクX']));
for (const [bonus, fat] of [
  [0, 0],
  [0.2, 0],
  [0.3, 0],
  [0.75, 0],
  [0, 0.5],
  [0, 1],
  [0.2, 1],
] as const) {
  const vx = courseReleaseVxFor(bonus, fat);
  console.log(row([f2(bonus), f2(fat), f2(vx), f3(vx * flightSecNeutral)]));
}
console.log(
  `\n（死球ゾーンの縁は ${BATTER_ZONE_MIN_X}。プレートの端は ±0.8 なので、**人間は W-44 の前から\n` +
    '  プレート位置と組み合わせれば打者に当てられる**＝制球スキルが新しく開いた穴ではない）',
);
