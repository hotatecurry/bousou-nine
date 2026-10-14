/**
 * 球団の個性の残り（フェーズS-40）の計測。
 *
 *   npm run balance:identity
 *
 * R-39 が明示的に残した3つの穴を、それぞれ数字にしてから定数を決める
 * （CLAUDE.md「バランス調整の方針＝勘で動かさず必ず計測してから決める」）。
 *
 * 1〜3段目：**配球に投手の持ち味**（`chooseCpuPitchPlan` はカウントしか見ないので、
 *   速球派も変化球派も同じ配球をする）。
 * 4段目：**タッチアップの深さ**（`CPU_TAG_UP_MIN_DEPTH`=78m の固定値）。
 * 5段目：**けん制のリード**（`cpuLeadDistance` の 5.2/3.6m の固定2値）。
 *
 * ## 配球について、この計測が答えられること／答えられないこと
 *
 * `sweep.ts` の分母は**バットに当たった打球**（タイミング×コースを一様に取る）なので、
 * 「当てにくさ」＝球の見づらさは測れない。したがって配球は次の2つを別々に測って、
 * **費用（当てられたときの質）と値打ち（当てさせない力）**として並べる：
 *
 * - 費用＝球速ごとの安打率・HR率（O-35 の `fork.ts` 1段目が見つけたU字。
 *   打球初速が `0.5 × 球速` を含むので**中庸がいちばんアウトになりやすい**）。
 * - 値打ち＝**打者に与える時間**（飛行時間。速球ほど短い）と**曲がり幅**
 *   （P-37 の `planCpuPitchShape().breakWidth`。フォークほど大きい）。
 *
 * どちらが自分の武器かは投手ごとに違う＝それが「持ち味」で、しきい値は
 * **名鑑96人がどう分かれるか**で決める（P-37が「頭打ちになる人数」で倒す長さを、
 * R-39が「走る人数」で余裕のしきい値を決めたのと同じ見方）。
 */
import {
  NEUTRAL_RATING,
  PLATE_Z,
  RELEASE_Z,
  type PitchProfile,
  neutralSpeedFor,
  speedForPitchSelection,
} from '../../src/core/pitch';
import {
  type CpuSpeedMode,
  CPU_BREAK_STEER_SEC,
  chooseCpuPitchPlan,
  planCpuPitchShape,
} from '../../src/core/cpuPitcher';
import {
  BASE_PATH,
  BASE_POSITIONS,
  CPU_LEAD_AGGRESSIVE,
  CPU_LEAD_CAUTIOUS,
  FIELDER_HOME_POSITIONS,
  FLY_CATCH_RELEASE_SEC,
  LEAD_SPEED,
  MAX_LEAD,
  RUNNER_SPEED,
  STEAL_LEAD,
  THROW_SPEED,
  distance,
  pickoffOutLead,
  runnerSpeed,
  stealSafeJumpSec,
} from '../../src/core/fielding';
import { DEFAULT_BALLPARK } from '../../src/core/ballpark';
import {
  TEAMS,
  benchRowStats,
  fielderRowStats,
  pitcherRowBatting,
  pitcherRowPitching,
} from '../../src/core/teams';
import { pct, summarize, sweep } from './sweep';

const row = (cells: readonly string[]): string => cells.map((c) => c.padStart(11)).join('');
const batter = { power: 0.5, average: 0.5 };

/** 名鑑96人（16球団×6人）の投球能力 */
const PITCHERS = TEAMS.flatMap((t) =>
  t.pitchers.map((r) => ({ name: r[0] as string, team: t.name, ...pitcherRowPitching(r) })),
);
/** 名鑑192人（打線8＋控え3＋先発投手1）の走力＝R-39の `balance:lineup` と同じ母集団 */
const RUNNERS = TEAMS.flatMap((t) => [
  ...t.lineup.map((r) => ({ name: r[1], team: t.name, run: fielderRowStats(r).run })),
  ...t.bench.map((r) => ({ name: r[0], team: t.name, run: benchRowStats(r).run })),
  { name: t.pitchers[0][0] as string, team: t.name, run: pitcherRowBatting(t.pitchers[0]).run },
]);

/** リリース→本塁の飛行時間（球速はリリース時に確定して飛行中変わらない＝説明書p19②） */
const flightSecFor = (speed: number): number => (PLATE_Z - RELEASE_Z) / speed;

const MODES: readonly CpuSpeedMode[] = ['fast', 'neutral', 'slow'];
const MODE_SELECTION: Record<CpuSpeedMode, -1 | 0 | 1> = { fast: -1, neutral: 0, slow: 1 };
const MODE_LABEL: Record<CpuSpeedMode, string> = {
  fast: '速球',
  neutral: '基準',
  slow: 'フォーク',
};

// ---------------------------------------------------------------------------

console.log('\n=== 1. 球速モードの費用（当てられたときの質）＝O-35のU字をSPD別に見る ===');
console.log('   分母は当たった打球。ところざわ・長打力0.5・打率0.5。');
console.log('   同じ「速球」でもSPDで実速が違う（速球派の速球48m/s vs 軟投派の速球36m/s）。');
console.log('   **BBB-85 から、打球に乗るのは緩急ぶんだけ**＝当てられたときの質は、どのSPDでも同じになる。');
console.log(`${'SPD'.padEnd(6)}${'モード'.padEnd(10)}${row(['実速', '安打率', 'HR率', 'ゴロアウト'])}`);
for (const spd of [0, 0.5, 1]) {
  for (const mode of MODES) {
    const speed = speedForPitchSelection(MODE_SELECTION[mode], spd);
    // 打球に乗るのは緩急ぶんだけ（BBB-85）＝投手の基準速を一緒に渡す
    const s = summarize(
      sweep({
        park: DEFAULT_BALLPARK,
        batter,
        pitchSpeed: speed,
        pitcherNeutral: neutralSpeedFor(spd),
        steps: 10,
      }),
    );
    console.log(
      `${String(spd).padEnd(6)}${MODE_LABEL[mode].padEnd(10)}` +
        row([
          `${speed.toFixed(0)}m/s`,
          pct(s.hitRate),
          pct(s.homerunRate),
          pct(s.groundout / s.inPlay),
        ]),
    );
  }
}
console.log('   → 費用の側だけを見ると「中庸がいちばん安い」（U字）。');
console.log('     だから配球の持ち味は**費用ではなく値打ちの側**（下の2段目）で決める。');

console.log('\n=== 2. 球速モードの値打ち（当てさせない力）＝時間と曲がり ===');
console.log('   時間＝リリースから本塁までの飛行時間（打者が見て振るまでに使える時間）。');
console.log(`   曲がり＝P-37の逆算が実際に作る横移動（倒す長さ ${CPU_BREAK_STEER_SEC}秒 固定）。`);
console.log(`${'能力'.padEnd(20)}${'モード'.padEnd(10)}${row(['実速', '飛行時間', '曲がり'])}`);
const SAMPLE_PROFILES: Array<{ label: string; profile: PitchProfile }> = [
  { label: '速球派 SPD1.0/F0.3', profile: { speed: 1, breakLeft: 0.3, breakRight: 0.3, fork: 0.3 } },
  { label: '技巧派 SPD0.3/F1.0', profile: { speed: 0.3, breakLeft: 1, breakRight: 1, fork: 1 } },
  { label: '平均   SPD0.5/F0.5', profile: { speed: 0.5, breakLeft: 0.5, breakRight: 0.5, fork: 0.5 } },
];
/** そのモードで実際に投げたときの（実速・飛行時間・曲がり幅） */
function pitchShapeOf(profile: PitchProfile, mode: CpuSpeedMode) {
  // 隅を突くカウント（0-0 は速球・0-1 はフォークと、既存規則がモードを決めてしまうので、
  // ここでは「同じ狙いのコース」に揃えたうえでモードだけを差し替えて比べる）
  const plan = { ...chooseCpuPitchPlan({ balls: 0, strikes: 0 }), speed: mode };
  const shape = planCpuPitchShape(plan, profile);
  return { speed: shape.speed, flight: shape.flightSec, width: shape.breakWidth };
}
for (const { label, profile } of SAMPLE_PROFILES) {
  for (const mode of MODES) {
    const s = pitchShapeOf(profile, mode);
    console.log(
      `${label.padEnd(20)}${MODE_LABEL[mode].padEnd(10)}` +
        row([`${s.speed.toFixed(0)}m/s`, `${s.flight.toFixed(3)}s`, `${s.width.toFixed(2)}m`]),
    );
  }
}
console.log('   → 速球の値打ちは**時間の短さ**、フォークの値打ちは**曲がり**。');
console.log('     どちらが大きいかは投手で入れ替わる＝これが「持ち味」。');

console.log('\n=== 3. しきい値：SPD − F で名鑑96人はどう分かれるか ===');
console.log('   速球の武器＝SPD（実速と飛行時間を決める）／フォークの武器＝F（曲がりを決める）。');
console.log('   |SPD − F| がしきい値を超えたほうを持ち味とする（超えなければバランス型）。');
const gaps = PITCHERS.map((p) => p.speed - p.fork);
console.log(
  `   名鑑の散らばり：最小 ${Math.min(...gaps).toFixed(2)} / 最大 ${Math.max(...gaps).toFixed(2)}` +
    ` / 平均 ${(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(2)}`,
);
console.log(`${'しきい値'.padEnd(10)}${row(['速球派', '技巧派', 'バランス', '個性ある球団'])}`);
for (const th of [0.05, 0.1, 0.12, 0.15, 0.18, 0.2, 0.25, 0.3, 0.4]) {
  const power = PITCHERS.filter((p) => p.speed - p.fork >= th).length;
  const breaking = PITCHERS.filter((p) => p.fork - p.speed >= th).length;
  const balanced = PITCHERS.length - power - breaking;
  // 「先発型4人のうち1人でも持ち味が付く球団」＝試合ごとに相手の顔が変わる球団（R-39）
  const teams = TEAMS.filter((t) =>
    t.pitchers.slice(0, 4).some((r) => {
      const s = pitcherRowPitching(r);
      return Math.abs(s.speed - s.fork) >= th;
    }),
  ).length;
  console.log(
    `${String(th).padEnd(10)}` + row([`${power}人`, `${breaking}人`, `${balanced}人`, `${teams}/16`]),
  );
}

console.log('\n=== 3b. しきい値ごとに、先発型4人の「顔ぶれ」がどれだけ割れるか ===');
console.log('   R-39のローテーションで人間が浴びる4人。全員が同じ型だと持ち味を入れた意味が薄い。');
console.log(`${'しきい値'.padEnd(10)}${row(['4人とも同型', '2型', '3型そろう'])}`);
for (const th of [0.05, 0.1, 0.12, 0.15, 0.18, 0.2, 0.25, 0.3]) {
  const styleOf = (r: (typeof TEAMS)[number]['pitchers'][number]): string => {
    const s = pitcherRowPitching(r);
    if (s.speed - s.fork >= th) return 'power';
    if (s.fork - s.speed >= th) return 'breaking';
    return 'balanced';
  };
  const kinds = TEAMS.map((t) => new Set(t.pitchers.slice(0, 4).map(styleOf)).size);
  console.log(
    `${String(th).padEnd(10)}` +
      row([
        `${kinds.filter((k) => k === 1).length}/16`,
        `${kinds.filter((k) => k === 2).length}/16`,
        `${kinds.filter((k) => k === 3).length}/16`,
      ]),
  );
}

console.log('\n=== 3c. 変えるのは「決め球」だけ：打たれ方はどれだけ動くか ===');
console.log('   カウントの3区分（初球=0ストライク／ストライク先行=1／追い込み=2以上）を');
console.log('   等重みで平均した安打率・HR率。**動かすのは追い込みの1区分だけ**。');
const STYLE_SPEEDS: Record<string, readonly [CpuSpeedMode, CpuSpeedMode, CpuSpeedMode]> = {
  // [初球, ストライク先行, 追い込み]。初球と先行は従来のまま＝緩急はどの型にも残る
  '従来(balanced)': ['fast', 'slow', 'neutral'],
  '速球派(power)': ['fast', 'slow', 'fast'],
  '技巧派(breaking)': ['fast', 'slow', 'slow'],
};
console.log(`${'投手'.padEnd(20)}${'配球'.padEnd(18)}${row(['安打率', 'HR率', '決め球の実速'])}`);
for (const { label, profile } of SAMPLE_PROFILES) {
  for (const [styleName, modes] of Object.entries(STYLE_SPEEDS)) {
    let hit = 0;
    let hr = 0;
    for (const mode of modes) {
      const speed = speedForPitchSelection(MODE_SELECTION[mode], profile.speed);
      const s = summarize(
        sweep({
          park: DEFAULT_BALLPARK,
          batter,
          pitchSpeed: speed,
          pitcherNeutral: neutralSpeedFor(profile.speed),
          steps: 8,
        }),
      );
      hit += s.hitRate / modes.length;
      hr += s.homerunRate / modes.length;
    }
    const putaway = speedForPitchSelection(MODE_SELECTION[modes[2]], profile.speed);
    console.log(
      `${label.padEnd(20)}${styleName.padEnd(18)}` +
        row([pct(hit), pct(hr), `${putaway.toFixed(0)}m/s`]),
    );
  }
}
console.log('   → 速球派の決め球は打たれれば飛ぶ（費用）。値打ちは2段目の「時間の短さ」で、');
console.log('     そこは当てさせない力なのでこの分母（当たった打球）では測れない＝');
console.log('     **リスクとリターンが同じ1球の上に乗っている**（桜井ノウハウ）。');

console.log('\n=== 3d. 名鑑の先発型4人：しきい値0.15での型と、実際に投げる決め球 ===');
console.log('   R-39のローテーションで人間が順に浴びる4人（試合ごとに顔が変わるか）。');
const STYLE_TH = 0.15;
const styleNameOf = (p: PitchProfile): string =>
  p.speed - p.fork >= STYLE_TH ? '速球派' : p.fork - p.speed >= STYLE_TH ? '技巧派' : 'バランス';
const PUTAWAY_OF: Record<string, CpuSpeedMode> = {
  速球派: 'fast',
  技巧派: 'slow',
  バランス: 'neutral',
};
for (const t of TEAMS.slice(0, 4)) {
  const cells = t.pitchers.slice(0, 4).map((r) => {
    const s = pitcherRowPitching(r);
    const prof: PitchProfile = {
      speed: s.speed,
      breakLeft: s.breakLeft,
      breakRight: s.breakRight,
      fork: s.fork,
    };
    const name = styleNameOf(prof);
    const shape = pitchShapeOf(prof, PUTAWAY_OF[name]);
    return `${r[0]}:${name} ${shape.speed.toFixed(0)}m/s ${shape.width.toFixed(2)}m`.padStart(28);
  });
  console.log(`${t.name.padEnd(12)}${cells.join('')}`);
}

// ---------------------------------------------------------------------------

console.log('\n=== 4. タッチアップ：時間の比較（R-39の盗塁とまったく同じ形） ===');
console.log(`   捕った野手が投げられるまで ${FLY_CATCH_RELEASE_SEC}秒（FLY_CATCH_RELEASE_SEC）。`);
console.log(`   守備の時間 = ${FLY_CATCH_RELEASE_SEC} + 捕球点→投げる塁 ÷ ${THROW_SPEED}m/s`);
console.log(`   走者の時間 = 塁間 ${BASE_PATH}m ÷ 走力`);
console.log('   「守備に残る余裕」= 走者の時間 − 守備の時間（正なら完璧な送球で刺せる）。');
console.log(`   現状のCPUは**深さ78m固定・三塁走者のみ**（CPU_TAG_UP_MIN_DEPTH）。`);
const TARGET_OF = { second: BASE_POSITIONS.third, third: BASE_POSITIONS.home } as const;
/** その走者がタッチアップしたときの「守備に残る余裕」（秒） */
function tagUpSlack(from: 'second' | 'third', catchPoint: { x: number; z: number }, speed: number): number {
  const to = TARGET_OF[from];
  const runSec = distance(BASE_POSITIONS[from], to) / speed;
  const defenseSec = FLY_CATCH_RELEASE_SEC + distance(catchPoint, to) / THROW_SPEED;
  return runSec - defenseSec;
}
/** 中堅方向の深さ D で、余裕が 0 になる深さ（＝三塁→本塁の従来の見方） */
function centerDepthForSlack(from: 'second' | 'third', speed: number, slack: number): number {
  // 二分探索（幾何が塁ごとに違うので閉じた式にしない）
  let lo = 0;
  let hi = 200;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (tagUpSlack(from, { x: 0, z: -mid }, speed) > slack) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
console.log(`${'走力'.padEnd(8)}${row(['足の速さ', '三塁→本塁', '二塁→三塁'])}`);
for (const run of [0, 0.25, 0.5, 0.75, 1]) {
  const sp = runnerSpeed(run);
  console.log(
    `${String(run).padEnd(8)}` +
      row([
        `${sp.toFixed(2)}m/s`,
        `${centerDepthForSlack('third', sp, 0).toFixed(0)}m`,
        `${centerDepthForSlack('second', sp, 0).toFixed(0)}m`,
      ]),
  );
}
console.log('   （中堅方向の深さで見た境界。実際は捕球点から投げる塁までの距離で決まる）');

console.log('\n=== 4b. しきい値：基準速の走者の境界を従来の78mに合わせる余裕 ===');
console.log('   R-39が `CPU_STEAL_JUMP_SEC` を動かさなかったのと同じ「基準線を動かさない」整理。');
console.log(`${'余裕'.padEnd(10)}${row(['三塁→本塁の深さ', '=78mとの差'])}`);
for (const s of [0, -0.05, -0.1, -0.14, -0.15, -0.2]) {
  const d = centerDepthForSlack('third', RUNNER_SPEED, s);
  console.log(`${s.toFixed(2).padEnd(10)}` + row([`${d.toFixed(1)}m`, `${(d - 78).toFixed(1)}m`]));
}

console.log('\n=== 4c. 打球の方向で二塁→三塁の成否が変わる（三塁は本塁より左に寄っている） ===');
console.log('   余裕（秒）。負＝完璧な送球でも間に合わない＝走る値打ちがある。基準速の走者。');
const DIRECTIONS: Array<{ label: string; deg: number }> = [
  { label: '左翼線', deg: -45 },
  { label: '左中間', deg: -22 },
  { label: '中堅', deg: 0 },
  { label: '右中間', deg: 22 },
  { label: '右翼線', deg: 45 },
];
console.log(`${'深さ'.padEnd(8)}${DIRECTIONS.map((d) => `${d.label}(三→本/二→三)`.padStart(24)).join('')}`);
for (const depth of [60, 70, 78, 90, 105]) {
  const cells = DIRECTIONS.map((d) => {
    const rad = (d.deg * Math.PI) / 180;
    const p = { x: Math.sin(rad) * depth, z: -Math.cos(rad) * depth };
    const a = tagUpSlack('third', p, RUNNER_SPEED);
    const b = tagUpSlack('second', p, RUNNER_SPEED);
    return `${a.toFixed(2)}/${b.toFixed(2)}`.padStart(24);
  });
  console.log(`${`${depth}m`.padEnd(8)}${cells.join('')}`);
}

console.log('\n=== 4d. 名鑑192人：走力で判断がどれだけ割れるか（中堅方向の境界で見る） ===');
const depths = RUNNERS.map((r) => centerDepthForSlack('third', runnerSpeed(r.run), -0.14));
console.log(
  `   三塁→本塁：最小 ${Math.min(...depths).toFixed(0)}m（俊足）〜 最大 ${Math.max(...depths).toFixed(0)}m（鈍足）` +
    ` ＝ 幅 ${(Math.max(...depths) - Math.min(...depths)).toFixed(0)}m（従来は全員78m）`,
);
const per = TEAMS.map((t) => {
  const rs = [
    ...t.lineup.map((r) => fielderRowStats(r).run),
    ...t.bench.map((r) => benchRowStats(r).run),
  ];
  return {
    name: t.name,
    n: rs.filter((run) => centerDepthForSlack('third', runnerSpeed(run), -0.14) < 78).length,
  };
}).sort((a, b) => b.n - a.n);
console.log(
  `   78mより浅くても還れる走者：${per.reduce((a, b) => a + b.n, 0)}/${RUNNERS.length}人` +
    `（球団ごと ${per[per.length - 1].n}〜${per[0].n}人：${per[0].name} 〜 ${per[per.length - 1].name}）`,
);

// ---------------------------------------------------------------------------

console.log('\n=== 5. けん制のリード：走力ごとの「刺されない深さ」 ===');
console.log('   `pickoffOutLead` は走力の関数（速いほど深くても戻れる）＝ここに走力を通すだけ。');
console.log(`   現状は固定2値（一・二塁 5.2m ＝刺される深さ／三塁 3.6m ＝刺されない深さ）。`);
const MOUND = FIELDER_HOME_POSITIONS.P;
/** その走者がその塁で、けん制されても戻れる最大のリード（m）＝pickoffOutLead の走力版 */
function safeLead(base: 'first' | 'second' | 'third', speed: number): number {
  return (distance(MOUND, BASE_POSITIONS[base]) / THROW_SPEED) * speed;
}
console.log(`${'走力'.padEnd(8)}${row(['足の速さ', '一塁', '二塁', '三塁'])}`);
for (const run of [0, 0.25, 0.5, 0.75, 1]) {
  const sp = runnerSpeed(run);
  console.log(
    `${String(run).padEnd(8)}` +
      row([
        `${sp.toFixed(2)}m/s`,
        `${safeLead('first', sp).toFixed(2)}m`,
        `${safeLead('second', sp).toFixed(2)}m`,
        `${safeLead('third', sp).toFixed(2)}m`,
      ]),
  );
}
console.log(
  `   参考（基準速の境界＝いまの固定値の根拠）：一塁 ${pickoffOutLead('first', MOUND).toFixed(2)}m ` +
    `/ 二塁 ${pickoffOutLead('second', MOUND).toFixed(2)}m / 三塁 ${pickoffOutLead('third', MOUND).toFixed(2)}m`,
);
console.log(
  `   いまの固定値との差：一塁 ${(CPU_LEAD_AGGRESSIVE - pickoffOutLead('first', MOUND)).toFixed(2)}m 踏み越す ` +
    `/ 二塁 ${(CPU_LEAD_AGGRESSIVE - pickoffOutLead('second', MOUND)).toFixed(2)}m ` +
    `/ 三塁 ${(CPU_LEAD_CAUTIOUS - pickoffOutLead('third', MOUND)).toFixed(2)}m`,
);
console.log('   → 一・二塁は境界を踏み越す（＝けん制が効く）／三塁だけ手前で止まる（＝効かない）。');
console.log('     この性格を保ったまま深さだけを走力で動かすには、**踏み越し幅を時間で持つ**');
console.log('     （距離で持つと俊足ほど「時間で見た踏み越し」が浅くなり、けん制が効かなくなる）。');
console.log(`${'踏み越し'.padEnd(10)}${row(['一塁@走力0', '一塁@0.5', '一塁@1.0', '旧5.2mとの差'])}`);
for (const sec of [0.08, 0.1, 0.12, 0.15]) {
  const at = (run: number) => safeLead('first', runnerSpeed(run)) + sec * runnerSpeed(run);
  console.log(
    `${`${sec}s`.padEnd(10)}` +
      row([
        `${at(0).toFixed(2)}m`,
        `${at(0.5).toFixed(2)}m`,
        `${at(1).toFixed(2)}m`,
        `${(at(0.5) - CPU_LEAD_AGGRESSIVE).toFixed(2)}m`,
      ]),
  );
}
console.log(`${'手前で止まる'.padEnd(10)}${row(['三塁@走力0', '三塁@0.5', '三塁@1.0', '旧3.6mとの差'])}`);
for (const sec of [0.05, 0.09, 0.12, 0.15]) {
  const at = (run: number) => safeLead('third', runnerSpeed(run)) - sec * runnerSpeed(run);
  console.log(
    `${`${sec}s`.padEnd(10)}` +
      row([
        `${at(0).toFixed(2)}m`,
        `${at(0.5).toFixed(2)}m`,
        `${at(1).toFixed(2)}m`,
        `${(at(0.5) - CPU_LEAD_CAUTIOUS).toFixed(2)}m`,
      ]),
  );
}
console.log(`   人間の上限 MAX_LEAD=${MAX_LEAD}m ／ リードが育つ速さ ${LEAD_SPEED}m/s`);

console.log('\n=== 5b. リードの深さが盗塁の窓をどう動かすか（L-32の持ち越し） ===');
console.log('   けん制のプレーが終わった時点のリードが次の投球へ持ち越される（L-32）ので、');
console.log('   「どこまでリードするか」はそのまま「走れるか」になる。');
console.log(`   CPUが仕掛ける条件は 守備の余裕 ≦ 0.10秒（R-39。スタートは0.25秒固定）。`);
console.log(`${'走力'.padEnd(8)}${row(['リード', '二盗の窓', '余裕', '三盗の窓', '余裕'])}`);
for (const run of [0, 0.5, 0.75, 1]) {
  const sp = runnerSpeed(run);
  const lead1 = Math.min(MAX_LEAD, safeLead('first', sp));
  const lead2 = Math.min(MAX_LEAD, safeLead('second', sp));
  const w1 = stealSafeJumpSec('first', BASE_POSITIONS.home, lead1, sp);
  const w2 = stealSafeJumpSec('second', BASE_POSITIONS.home, lead2, sp);
  console.log(
    `${String(run).padEnd(8)}` +
      row([
        `${lead1.toFixed(2)}m`,
        `${w1.toFixed(3)}s`,
        `${(w1 - 0.25).toFixed(3)}s`,
        `${w2.toFixed(3)}s`,
        `${(w2 - 0.25).toFixed(3)}s`,
      ]),
  );
}
console.log(`   参考：標準リード ${STEAL_LEAD}m・基準速のときの二盗の窓 ` +
  `${stealSafeJumpSec('first').toFixed(3)}s（A-7で調整した値）`);
console.log(`   （飛行時間の参考：基準速の投球 ${flightSecFor(speedForPitchSelection(0, NEUTRAL_RATING)).toFixed(3)}s）`);
