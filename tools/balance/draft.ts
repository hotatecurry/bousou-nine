/**
 * ローグライトの**リロール**（フェーズU-42）の計測。
 *
 *   npm run balance:draft
 *
 * ⑧が「入れていない」と明記していた抽選のやり直しを、勘で回数を決めずに数字にしてから
 * 定数を決める（CLAUDE.md「バランス調整の方針」）。
 *
 * 1段目：**1回の抽選で狙いの札が候補に入る確率**（リロールの素の値打ち）。
 * 2段目：**リロール回数ごとに、狙ったデュオが1ランで揃う割合**（＝`RUN_REROLLS` を決める計測）。
 * 3段目：**温存に値打ちがあるか**（すぐ引き直す打ち手 vs 前提が1つ揃ってから引き直す打ち手）。
 *        ここが「回数券をラン全体にした」というユーザー判断が生きるかどうかの分かれ目。
 * 4段目：**回数券が1ランのどこで尽きるか**。
 * 5段目：**CPUの規則が発火する頻度**（決定的な規則が死んでいないか・多すぎないか）。
 *
 * ## この計測が答えられること／答えられないこと
 *
 * 抽選は乱数を引く唯一の場所（⑧）なので、**「何が候補に出るか」の分布は正確に測れる**。
 * 一方で「人間がどう選ぶか」は測れないので、ここでは**狙いを1つ決めて追いかける打ち手**
 * （デュオの前提を1人に集め、関係の無い候補ではリロールする）を代表として置く。
 * F-26-5/F-26-7 が「狙ったデュオが揃う試合の割合」で測ったのと同じ物差しで、
 * **リロールの前後を比べられる**ことがこの置き方の狙い。
 */
import { createRngState, type RngState } from '../../src/core/rng';
import {
  DRAFTS_PER_GAME,
  RUN_GAMES,
  gameSeed,
} from '../../src/core/run';
import {
  type SkillId,
  DUO_SKILL_IDS,
  REROLLS_PER_RUN,
  SKILLS,
  activeLineagesFor,
  cpuChooseSkill,
  drawSkillDraft,
  shouldCpuReroll,
} from '../../src/core/skills';
import { createTeamRoster, grantSkill, skillHoldersOf } from '../../src/core/roster';
import { TEAMS, teamById } from '../../src/core/teams';

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const f2 = (v: number): string => v.toFixed(2);

/** 測るラン数（シードを変えて回す）。多いほど安定するが、決定的なので毎回同じ値が出る */
const RUNS = 400;

/** 1ランの抽選回数（⑧の「45回」そのもの） */
const DRAFTS_PER_RUN = RUN_GAMES * DRAFTS_PER_GAME;

/**
 * 狙いのデュオ（測る対象）。**★の組み合わせが違う3つ**を並べて、
 * 「軽い狙い」と「重い狙い」でリロールの効き方が変わるかを見る。
 */
const TARGETS = DUO_SKILL_IDS.filter((id) => SKILLS[id].requires !== undefined)
  .map((id) => {
    const requires = SKILLS[id].requires ?? [];
    return {
      id,
      requires,
      stars: requires.map((r) => SKILLS[r].rarity),
      lineage: SKILLS[id].lineage,
    };
  })
  .filter((t) => t.requires.length === 2);

/** 代表として測る3つ（★1+★2 / ★2+★2 / ★2+★3 に相当するものを名鑑の並びから拾う） */
const SAMPLE_TARGETS = [
  TARGETS.find((t) => t.stars[0] + t.stars[1] === 3),
  TARGETS.find((t) => t.stars[0] + t.stars[1] === 4),
  TARGETS.find((t) => t.stars[0] + t.stars[1] === 5),
].filter((t): t is (typeof TARGETS)[number] => t !== undefined);

/** 人間の球団（測るあいだ固定。名鑑の1球団目） */
const HUMAN_TEAM = TEAMS[0].id;

// ============================================================
console.log('=== 1. 1回の抽選で「狙いの札」が候補に入る確率 ===\n');
console.log('（狙い＝そのデュオの前提2つ、または揃った後のデュオ本体。系統の絞り込みは試合ごと）');

interface HitStat {
  label: string;
  /** 狙いの系統が「今回の系統」に入っている試合の割合 */
  lineageIn: number;
  /** 系統が入っている試合で、1回の抽選に狙いの札が入る確率 */
  hit: number;
}

const hitStats: HitStat[] = SAMPLE_TARGETS.map((target) => {
  let lineageGames = 0;
  let games = 0;
  let draws = 0;
  let hits = 0;
  for (let run = 0; run < RUNS; run += 1) {
    for (let game = 1; game <= RUN_GAMES; game += 1) {
      const seed = gameSeed(run * 977 + 1, game);
      const lineages = activeLineagesFor(createRngState(seed));
      games += 1;
      if (!lineages.includes(target.lineage)) continue;
      lineageGames += 1;
      // 素のロスター（まだ何も持っていない）に対して9回ぶん引く＝「狙いの札が
      // どれだけの頻度で回ってくるか」の素の値
      const roster = createTeamRoster(teamById(HUMAN_TEAM));
      const holders = skillHoldersOf(roster);
      let state: RngState = createRngState(seed);
      for (let i = 0; i < DRAFTS_PER_GAME; i += 1) {
        const drawn = drawSkillDraft(state, holders, lineages);
        state = drawn.state;
        draws += 1;
        if (drawn.draft.options.some((id) => target.requires.includes(id))) hits += 1;
      }
    }
  }
  return {
    label: `${SKILLS[target.id].name}(★${target.stars.join('+★')})`,
    lineageIn: lineageGames / games,
    hit: hits / Math.max(1, draws),
  };
});

console.log('狙い'.padEnd(24) + 'ケイトウガ デル'.padStart(16) + '1カイデ アタル'.padStart(16));
for (const s of hitStats) {
  console.log(s.label.padEnd(24) + pct(s.lineageIn).padStart(16) + pct(s.hit).padStart(16));
}
console.log(
  '\n→ 外れたときに引き直せば 1-(1-p)^(k+1) まで上がる（k=その抽選で使ったリロールの数）。',
);
for (const s of hitStats) {
  const once = 1 - (1 - s.hit) ** 2;
  console.log(`   ${s.label}: 1カイ ${pct(s.hit)} → ヒキナオシ1カイ ${pct(once)}`);
}

// ============================================================
console.log('\n=== 2. リロール回数ごとに、狙ったデュオが1ランで揃う割合 ===\n');
console.log('（打ち手＝狙いの札があれば必ず取り「1人に集める」／無ければリロール／');
console.log('  リロールが尽きたら候補のうち最もレアなものを取る）');

/**
 * リロールの使い方（＝人間の打ち手）。**この2つの差が「温存に値打ちがあるか」**で、
 * ラン全体の回数券（ユーザー判断）が per-game より良いことの根拠になる。
 *
 * - `greedy`：狙いの札が候補に無ければ、いつでも引き直す。
 * - `patient`：**前提を1つ持ってから**（＝あと1枚でデュオ）だけ引き直す。
 */
type RerollPolicy = 'greedy' | 'patient';

/**
 * 1ランを回して、狙ったデュオが揃ったかを返す。
 *
 * **人間の打ち手を固定する**（狙いを追う打ち手）。リロールの有無で変わるのは
 * 「外れた抽選をもう一度引けるか」だけなので、この打ち手なら回数がそのまま効き目に出る。
 */
function simulateRun(opts: {
  runSeed: number;
  target: (typeof TARGETS)[number];
  rerolls: number;
  policy?: RerollPolicy;
}): { got: boolean; draftIndex: number; spent: number[] } {
  const { runSeed, target, rerolls, policy = 'greedy' } = opts;
  let roster = createTeamRoster(teamById(HUMAN_TEAM));
  let left = rerolls;
  /** 前提を集める先（デュオは「同じ選手が」持つ必要がある＝最初に前提を取った選手） */
  let collector: string | null = null;
  let draftIndex = 0;
  /** リロールを使った抽選の通し番号（何試合目で尽きるかを見る） */
  const spent: number[] = [];

  for (let game = 1; game <= RUN_GAMES; game += 1) {
    const seed = gameSeed(runSeed, game);
    const lineages = activeLineagesFor(createRngState(seed));
    let state: RngState = createRngState(seed);
    for (let i = 0; i < DRAFTS_PER_GAME; i += 1) {
      draftIndex += 1;
      const holders = skillHoldersOf(roster);
      let drawn = drawSkillDraft(state, holders, lineages);
      state = drawn.state;
      const wanted = (options: readonly SkillId[]): SkillId | undefined =>
        options.find((id) => id === target.id) ??
        options.find((id) => target.requires.includes(id));
      // `patient` は「あと1枚でデュオ」になってからしか引き直さない（温存する打ち手）
      const held = collector === null ? [] : (roster.skills[collector] ?? []);
      const oneAway = target.requires.some((r) => held.includes(r));
      const mayReroll = policy === 'greedy' || oneAway;
      // 狙いが無ければ引き直す（残っている限り）
      while (mayReroll && wanted(drawn.draft.options) === undefined && left > 0) {
        left -= 1;
        spent.push(draftIndex);
        drawn = drawSkillDraft(state, holders, lineages);
        state = drawn.state;
      }
      if (drawn.draft.options.length === 0) continue;
      const pick = wanted(drawn.draft.options);
      if (pick === undefined) {
        // 狙いが無い＝最もレアなものを拾って枠を埋める（CPUと同じ規則）
        const picked = cpuChooseSkill(drawn.draft, holders);
        if (picked) roster = grantSkill(roster, picked.holderId, picked.skillId).roster;
        continue;
      }
      // 狙いは「同じ選手に」集める（デュオの前提は同一選手が持つ必要がある）
      const eligible = holders.filter((h) =>
        collector === null ? true : h.id === collector,
      );
      const holder = eligible.find((h) => {
        const owned = h.skills;
        if (owned.includes(pick)) return false;
        if (SKILLS[pick].target === 'pitcher' && !h.canPitch) return false;
        if (SKILLS[pick].requires) return SKILLS[pick].requires.every((r) => owned.includes(r));
        return owned.length < 3;
      });
      if (!holder) continue;
      const result = grantSkill(roster, holder.id, pick);
      if (!result.ok) continue;
      roster = result.roster;
      collector = holder.id;
      if (pick === target.id) return { got: true, draftIndex, spent };
    }
  }
  return { got: false, draftIndex: 0, spent };
}

const REROLL_COUNTS = [0, 1, 2, 3, 4, 6, 9];

console.log(
  'ノコリ'.padStart(6) + SAMPLE_TARGETS.map((t) => SKILLS[t.id].name.padStart(14)).join(''),
);
const runResults = new Map<number, Map<SkillId, { got: number; when: number[]; spent: number[][] }>>();
for (const rerolls of REROLL_COUNTS) {
  const perTarget = new Map<SkillId, { got: number; when: number[]; spent: number[][] }>();
  const cells: string[] = [];
  for (const target of SAMPLE_TARGETS) {
    let got = 0;
    const when: number[] = [];
    const spentAll: number[][] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const r = simulateRun({ runSeed: run * 977 + 1, target, rerolls });
      if (r.got) {
        got += 1;
        when.push(r.draftIndex);
      }
      spentAll.push(r.spent);
    }
    perTarget.set(target.id, { got, when, spent: spentAll });
    cells.push(pct(got / RUNS).padStart(14));
  }
  runResults.set(rerolls, perTarget);
  console.log(String(rerolls).padStart(6) + cells.join(''));
}

console.log('\n揃うまでに要した抽選の回数（平均。45回中）：');
console.log(
  'ノコリ'.padStart(6) + SAMPLE_TARGETS.map((t) => SKILLS[t.id].name.padStart(14)).join(''),
);
for (const rerolls of REROLL_COUNTS) {
  const per = runResults.get(rerolls);
  const cells = SAMPLE_TARGETS.map((t) => {
    const r = per?.get(t.id);
    if (!r || r.when.length === 0) return '-'.padStart(14);
    const avg = r.when.reduce((a, b) => a + b, 0) / r.when.length;
    return f2(avg).padStart(14);
  });
  console.log(String(rerolls).padStart(6) + cells.join(''));
}

// ============================================================
console.log('\n=== 3. 温存に値打ちがあるか（すぐ引き直す vs 前提が揃ってから引き直す） ===\n');
console.log('（同じ回数券を、いつ切るかだけが違う2つの打ち手で比べる）');

console.log(
  'ノコリ'.padStart(6) +
    SAMPLE_TARGETS.flatMap((t) => [
      `${SKILLS[t.id].name}:スグ`.padStart(20),
      'オンゾン'.padStart(12),
    ]).join(''),
);
for (const rerolls of REROLL_COUNTS) {
  const cells: string[] = [];
  for (const target of SAMPLE_TARGETS) {
    for (const policy of ['greedy', 'patient'] as const) {
      let got = 0;
      for (let run = 0; run < RUNS; run += 1) {
        if (simulateRun({ runSeed: run * 977 + 1, target, rerolls, policy }).got) got += 1;
      }
      cells.push(pct(got / RUNS).padStart(policy === 'greedy' ? 20 : 12));
    }
  }
  console.log(String(rerolls).padStart(6) + cells.join(''));
}

// ============================================================
console.log('\n=== 4. 回数券は1ランのどこで尽きるか ===\n');
console.log('（すぐ引き直す打ち手が、45回のうち何回目までに使い切るか）');

console.log(
  'ノコリ'.padStart(6) +
    'ツカイキル ラン'.padStart(18) +
    'ツカイキル トコロ'.padStart(20) +
    'ナンシアイメ'.padStart(14),
);
for (const rerolls of REROLL_COUNTS) {
  if (rerolls === 0) continue;
  const per = runResults.get(rerolls)?.get(SAMPLE_TARGETS[0].id);
  if (!per) continue;
  const spentRuns = per.spent.filter((s) => s.length >= rerolls);
  const lasts = spentRuns.map((s) => s[rerolls - 1]);
  const avg = lasts.length ? lasts.reduce((a, b) => a + b, 0) / lasts.length : 0;
  console.log(
    String(rerolls).padStart(6) +
      pct(spentRuns.length / RUNS).padStart(18) +
      (lasts.length ? `${f2(avg)}カイメ` : '-').padStart(20) +
      (lasts.length ? f2(avg / DRAFTS_PER_GAME) : '-').padStart(14),
  );
}
console.log(`\n（1ランの抽選は ${DRAFTS_PER_RUN} 回＝${RUN_GAMES}試合×${DRAFTS_PER_GAME}回）`);

// ============================================================
console.log('\n=== 5. CPUの規則（★2以上が1枚も無ければ引き直す）の発火頻度 ===\n');

let cpuDraws = 0;
let cpuFires = 0;
/** 1つの抽選で連続して発火した回数（引き直した先もまた★1だけ、が続くか） */
let cpuDouble = 0;
for (let run = 0; run < RUNS; run += 1) {
  for (let game = 1; game <= RUN_GAMES; game += 1) {
    const seed = gameSeed(run * 977 + 1, game);
    const lineages = activeLineagesFor(createRngState(seed));
    let roster = createTeamRoster(teamById(TEAMS[1].id));
    let state: RngState = createRngState(seed);
    for (let i = 0; i < DRAFTS_PER_GAME; i += 1) {
      const holders = skillHoldersOf(roster);
      let drawn = drawSkillDraft(state, holders, lineages);
      state = drawn.state;
      cpuDraws += 1;
      let fired = 0;
      // 回数券は無制限として「規則が何回言うか」だけを数える（回数の決め方は2段目）
      while (shouldCpuReroll(drawn.draft) && fired < 4) {
        fired += 1;
        drawn = drawSkillDraft(state, holders, lineages);
        state = drawn.state;
      }
      if (fired >= 1) cpuFires += 1;
      if (fired >= 2) cpuDouble += 1;
      const picked = cpuChooseSkill(drawn.draft, holders);
      if (picked) roster = grantSkill(roster, picked.holderId, picked.skillId).roster;
    }
  }
}
console.log(`抽選 ${cpuDraws} 回のうち 引き直した ${cpuFires} 回 = ${pct(cpuFires / cpuDraws)}`);
console.log(`  そのうち2回続けて引き直した: ${cpuDouble} 回 = ${pct(cpuDouble / cpuDraws)}`);
const cpuPerRun = (cpuFires / cpuDraws) * DRAFTS_PER_RUN;
console.log(
  `  → 1ラン(${DRAFTS_PER_RUN}回)あたり ${f2(cpuPerRun)} 回 言う` +
    '（回数券がそれより少なければ、CPUは序盤で使い切る＝温存は人間の取り分）',
);

// ============================================================
console.log(`\n=== 6. 採用値 REROLLS_PER_RUN = ${REROLLS_PER_RUN} の確認 ===\n`);

const adopted = runResults.get(REROLLS_PER_RUN);
const light = SAMPLE_TARGETS[0];
let patientGot = 0;
for (let run = 0; run < RUNS; run += 1) {
  if (
    simulateRun({ runSeed: run * 977 + 1, target: light, rerolls: REROLLS_PER_RUN, policy: 'patient' })
      .got
  ) {
    patientGot += 1;
  }
}
const base = (runResults.get(0)?.get(light.id)?.got ?? 0) / RUNS;
const patient = patientGot / RUNS;
const check = (label: string, ok: boolean, detail: string): void =>
  console.log(`  ${ok ? 'YES' : 'NO '} ${label}： ${detail}`);

check('効く（狙ったデュオが揃う割合が動く）', patient > base * 1.5, `${pct(base)} → ${pct(patient)}`);
check(
  '確実にはならない（揃えにいく判断が残る）',
  patient < 0.5,
  `${pct(patient)} < 50%（8割近いランでは揃わない）`,
);
check(
  '「毎試合1回」に届かない（ラン全体の資源であって試合ごとの資源にならない）',
  REROLLS_PER_RUN < RUN_GAMES,
  `${REROLLS_PER_RUN} < ${RUN_GAMES}試合`,
);
check(
  'CPUは必ず序盤で使い切る（温存は人間の取り分）',
  REROLLS_PER_RUN < cpuPerRun,
  `${REROLLS_PER_RUN} < ${f2(cpuPerRun)}回/ラン`,
);
check(
  '温存に値打ちがある（同じ回数でも切りどころで差が出る）',
  patient > (adopted?.get(light.id)?.got ?? 0) / RUNS,
  `スグ ${pct((adopted?.get(light.id)?.got ?? 0) / RUNS)} < オンゾン ${pct(patient)}`,
);
