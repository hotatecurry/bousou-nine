/**
 * 試合ごとの先発の選び直しと、疲労の持ち越し（フェーズV-43）の計測。
 *
 *   npm run balance:rotation
 *
 * 決めたかったのは1つ、**1試合休むとどれだけ戻るか**（`REST_RECOVERY`）。
 * CLAUDE.md「バランス調整の方針＝勘で動かさず必ず計測してから決める」に従う。
 *
 * ## なぜ代償が要るのか（このセッションの前提）
 *
 * F-26-6のラン化以来、**投球数は試合ごとに仕切り直され**（`run.ts` が「新しい試合は
 * 必ず全員そろった状態から始まる」と明記）、先発はランの最初に決めたものを5試合ずっと
 * 使っていた。ここで選び直せるようにするだけだと**毎試合エースが支配戦略**になる
 * （選択肢は増えるのに判断は生まれない）＝F-26-8が消費型で出した結論
 * 「試合ごとに回復させると温存の判断そのものが消える」とまったく同じ形。
 * そこで **投げた投手全員に疲れが残る**（2026-08-08 ユーザー判断）。
 *
 * ## 何を再利用しているか
 *
 * - **疲労の効き方は `src/core` の既存の規則をそのまま呼ぶ**（`maxPitchesFor` /
 *   `staminaRemaining` / `fatigueFromRemaining`）＝B-11のモデルを1行も書き写さない。
 * - **打たれ方は `sweep`（I-29以来の土台）**、**失点は `runExpectancy`（Q-38の土台）**。
 *   疲労は `judgeSwing` の球威（`EXIT_FATIGUE_BONUS`）としてそこへ入る。
 *
 * ## 意図的な限界（S-40と同じ）
 *
 * **疲労が変化量を痩せさせる分（`FATIGUE_BREAK_LOSS`）は、この分母では測れない**
 * ＝`sweep` は「当てられた打球」を一様に取るので、**当てさせない力**（曲がり・制球）は
 * 分母に入っていない。ここで出るのは**疲労の費用の下限**で、実際の費用はこれより大きい。
 * だから「連投は損」という向きの結論は安全側（費用を小さく見積もったうえで損）。
 */
import {
  STAMINA_FRESH_THRESHOLD,
  STARTER_TYPE_COUNT,
  fatigueFromRemaining,
  maxPitchesFor,
  staminaRemaining,
} from '../../src/core/roster';
import { TEAMS, pitcherRowPitching } from '../../src/core/teams';
import { REST_RECOVERY, RUN_GAMES } from '../../src/core/run';
import { distributionFor, solveRunExpectancy } from './runExpectancy';
import { pct, summarize, sweep } from './sweep';

const row = (cells: readonly string[], width = 10): string =>
  cells.map((c) => c.padStart(width)).join('');

const f2 = (v: number): string => v.toFixed(2);
const f3 = (v: number): string => v.toFixed(3);

/**
 * 先発が1試合に投げる球数。**「限界まで投げる」ではなく「試合を作る」ぶん**にしてある
 * （名鑑の先発型の容量は 85〜125球なので、この値なら容量の大きい投手は最後まで無傷、
 * 小さい投手は終盤に落ちる＝スタミナの差がそのまま出る）。絶対値ではなく
 * 「同じ球数を投げさせたときの比較」に使うだけの値。
 */
const STARTER_PITCHES_PER_GAME = 110;

/** 疲労 → その投手が投げている間の「1イニングの失点期待」（打者は平均） */
const runsCache = new Map<number, number>();
function runsPerInningAt(fatigue: number): number {
  const key = Math.round(fatigue * 1000) / 1000;
  const cached = runsCache.get(key);
  if (cached !== undefined) return cached;
  const dist = distributionFor(0.5, { average: 0.5, pitcherFatigue: key });
  // RE[アウト0][走者なし]＝そのイニングの残りに入る点＝1イニングの失点期待
  const value = solveRunExpectancy(dist)[0][0];
  runsCache.set(key, value);
  return value;
}

/** 疲労を 0..1 の格子で先に測っておき、途中の値は線形で読む（sweep を何百回も回さない） */
const FATIGUE_GRID = Array.from({ length: 21 }, (_, i) => i / 20);
const FATIGUE_RUNS = FATIGUE_GRID.map((f) => runsPerInningAt(f));
function runsAtFatigue(fatigue: number): number {
  const x = Math.max(0, Math.min(1, fatigue)) * (FATIGUE_GRID.length - 1);
  const i = Math.min(FATIGUE_GRID.length - 2, Math.floor(x));
  const t = x - i;
  return FATIGUE_RUNS[i] * (1 - t) + FATIGUE_RUNS[i + 1] * t;
}

/** 開始残量 → 球威が落ちるまでに投げられる球数（B-11のしきい値をそのまま使う） */
function pitchesUntilFade(startRemaining: number, stamina: number): number {
  return Math.max(0, (startRemaining - STAMINA_FRESH_THRESHOLD) * maxPitchesFor(stamina));
}

/**
 * 開始残量 `startRemaining` の投手が `pitches` 球投げる間の、1イニングあたりの平均失点。
 * **持ち越しは「投球数」の形で入れる**（B-11の「真実は投球数の側」をそのまま延長）。
 */
function gameRuns(startRemaining: number, stamina: number, pitches = STARTER_PITCHES_PER_GAME): number {
  const max = maxPitchesFor(stamina);
  const carried = (1 - startRemaining) * max;
  let sum = 0;
  for (let p = 0; p < pitches; p += 1) {
    sum += runsAtFatigue(fatigueFromRemaining(staminaRemaining(carried + p, stamina)));
  }
  return sum / pitches;
}

/**
 * 残量 `usedRemaining` で試合を終えた投手が、**`later` 試合後**にもう一度先発するときの
 * 開始残量。回復は**試合と試合の間に1回ずつ**入るので、次の試合（＝連投）でも1回ぶんは戻る。
 * `later=1` が連投、`later=4` がCPUの4人ローテーション（R-39）。
 */
function remainingAfterRest(usedRemaining: number, later: number, recovery: number): number {
  return Math.min(1, usedRemaining + later * recovery);
}

console.log('=== V-43 試合ごとの先発の選び直し／疲労の持ち越し ===\n');

// ---- 1段目：疲労が打たれ方にどれだけ効くか（＝持ち越しが代償になるか） ----
//
// ここが 0 に近ければ「疲労を持ち越しても何も起きない」＝このセッションの設計が空振りする。

console.log('■ 1段目：疲労が打たれ方に効く量（打者は平均・ところざわ・基準速）');
console.log(row(['ヒロウ', 'ザンリョウ', 'アンダ率', 'HR率', '1イニング失点']));
for (const fatigue of [0, 0.25, 0.5, 0.75, 1]) {
  const s = summarize(sweep({ pitcherFatigue: fatigue }));
  // 疲労は残量から導出される（残量0.5で疲労0／残量0で疲労1）
  const remaining = STAMINA_FRESH_THRESHOLD * (1 - fatigue);
  console.log(
    row([
      f2(fatigue),
      f2(remaining),
      pct(s.hitRate),
      pct(s.homerunRate),
      f3(runsPerInningAt(fatigue)),
    ]),
  );
}
const freshRuns = runsPerInningAt(0);
const spentRuns = runsPerInningAt(1);
console.log(
  `\n  → 疲労MAXで1イニングの失点期待が ${f3(freshRuns)} → ${f3(spentRuns)}（${
    ((spentRuns / freshRuns - 1) * 100).toFixed(1)
  }%増）。`,
);
console.log(
  '    9イニングなら ' +
    `${f2(freshRuns * 9)} → ${f2(spentRuns * 9)} 点＝**持ち越しは実際に代償になる**。\n`,
);

// ---- 2段目：開始残量ごとの費用（連投がどれだけ損か） ----

console.log('■ 2段目：開始残量ごとの費用（先発型 STM0.85＝容量110球・110球投げる）');
console.log(row(['カイシ残量', 'キュウイまで', 'ヘイキン失点/イニング', '9イニング']));
for (const start of [1, 0.8, 0.6, 0.5, 0.4, 0.2, 0]) {
  const runs = gameRuns(start, 0.85);
  console.log(
    row([f2(start), `${Math.round(pitchesUntilFade(start, 0.85))}キュウ`, f3(runs), f2(runs * 9)]),
  );
}
console.log('');

// ---- 3段目：回復率の候補（ここが決めたい値） ----
//
// 満たすべき条件は3つ：
//  (a) **CPUの4人ローテーション（中3日）で必ず全快**＝R-39でCPUに入れた規則が、
//      新しい代償のもとでも損をしない（⑧の「CPUも対等」）。
//  (b) **連投（中0日）は球威ダウン域から始まる**（開始残量 < 0.5）＝規則が死なない。
//  (c) **中2日はほぼ無傷**（0.8以上）＝5試合のランで3人でも回せる余地を残す。

console.log('■ 3段目：回復率の候補（完投＝残量0 で終えた投手が、何試合後にどれだけ戻るか）');
console.log(row(['カイフク率', 'ツギノ試合', '2シアイゴ', '3シアイゴ', '4シアイゴ', 'ハンテイ']));
for (const recovery of [0.25, 0.3, 0.35, 0.4, 0.45, 0.5]) {
  const rests = [1, 2, 3, 4].map((r) => remainingAfterRest(0, r, recovery));
  // a=4試合後（CPUの4人ローテ）で全快 ／ b=連投は球威ダウン域 ／ c=1試合空ければほぼ無傷
  const a = rests[3] >= 1;
  const b = rests[0] < STAMINA_FRESH_THRESHOLD;
  const c = rests[1] >= 0.8;
  const verdict = a && b && c ? 'OK' : [!a ? 'a' : '', !b ? 'b' : '', !c ? 'c' : ''].join('') + 'ダメ';
  console.log(row([f2(recovery), ...rests.map(f2), verdict]));
}
console.log(
  '\n  条件 a=4試合後に全快（CPUの4人ローテ＝R-39が損をしない）／' +
    `b=連投は球威ダウン域（<${STAMINA_FRESH_THRESHOLD}）／c=1試合空ければほぼ無傷（≥0.80）`,
);
console.log(
  `  → 採用値 REST_RECOVERY = ${f2(REST_RECOVERY)}＝**3つを同時に満たす最小の回復率**\n` +
    '    （回復を大きくすると代償が軽くなって判断が薄れ、小さくすると c が崩れて\n' +
    '     4人ローテ以外が成立しなくなる＝もっとも代償が重いまま選択肢を殺さない値）。\n',
);

// ---- 4段目：連投の損得（採用値のもとで） ----

console.log(`■ 4段目：採用値 ${f2(REST_RECOVERY)} での「エースを何試合空けて使うか」（STM0.85）`);
console.log(row(['Nシアイゴ', 'カイシ残量', 'キュウイまで', '9イニング失点', 'ムキズとの差']));
const fresh9 = gameRuns(1, 0.85) * 9;
for (const rest of [1, 2, 3, 4]) {
  const start = remainingAfterRest(0, rest, REST_RECOVERY);
  const runs9 = gameRuns(start, 0.85) * 9;
  console.log(
    row([
      `${rest}`,
      f2(start),
      `${Math.round(pitchesUntilFade(start, 0.85))}キュウ`,
      f2(runs9),
      `+${f2(runs9 - fresh9)}`,
    ]),
  );
}
console.log(
  '\n  → 連投（次の試合にもう一度）は失点が大きく増え、**2試合空ければほぼ戻り、3試合で全快**。\n' +
    '    エースの持ち味（変化量・制球）はこの分母では測れない（S-40と同じ限界）ので、\n' +
    '    実際の損はこれより大きい＝「連投は損」という結論は安全側に出ている。\n',
);

// ---- 5段目：名鑑16球団で規則が死なないか ----
//
// R-39・S-40・T-41と同じ確認＝**しきい値を入れた結果、全球団で同じ振る舞いになる**（＝
// 個性が出ない）／**どの球団も成立しない**（＝規則が死ぬ）のどちらでもないこと。

console.log('■ 5段目：名鑑16球団の先発型4人（ローテーションが組めるか）');
console.log(row(['キュウダン', 'ヨウリョウ(4ニン)', 'サイダイ', 'サイショウ', 'ハバ'], 16));
let minCap = Infinity;
let maxCap = 0;
for (const team of TEAMS) {
  const caps = team.pitchers
    .slice(0, STARTER_TYPE_COUNT)
    .map((p) => maxPitchesFor(pitcherRowPitching(p).stamina));
  const lo = Math.min(...caps);
  const hi = Math.max(...caps);
  minCap = Math.min(minCap, lo);
  maxCap = Math.max(maxCap, hi);
  console.log(
    row(
      [
        team.short,
        caps.map((c) => Math.round(c)).join('/'),
        `${Math.round(hi)}`,
        `${Math.round(lo)}`,
        `${Math.round(hi - lo)}`,
      ],
      16,
    ),
  );
}
console.log(
  `\n  → 先発型の容量は ${Math.round(minCap)}〜${Math.round(maxCap)}球。` +
    `${STARTER_PITCHES_PER_GAME}球の試合では容量の小さい先発は終盤に落ちる＝\n` +
    '    「今日は誰に投げさせるか」がスタミナの差として実際に出る。\n',
);

// ---- 6段目：全員が疲れることの帰結（継投の費用） ----
//
// ユーザー判断「投げた投手全員」の確認＝リリーフを使うことにもランの費用が付くか。

console.log('■ 6段目：リリーフの持ち越し（STM0.30＝容量55球）');
console.log(row(['トウキュウ数', 'シアイゴ残量', 'ツギノ試合', 'サライライ']));
for (const pitches of [10, 20, 30, 40, 55]) {
  const after = staminaRemaining(pitches, 0.3);
  console.log(
    row([
      `${pitches}`,
      f2(after),
      f2(remainingAfterRest(after, 1, REST_RECOVERY)),
      f2(remainingAfterRest(after, 2, REST_RECOVERY)),
    ]),
  );
}
console.log(
  `\n  → リリーフは容量が小さいぶん残量の減りが速いが、**回復も同じ割合**（${f2(REST_RECOVERY)}／試合）\n` +
    '    なので、少しずつ使えば毎試合出られる＝「短く使う」ことに値打ちが出る。\n',
);

// ---- 7段目：5試合のランを通した打ち手の比較 ----

console.log(`■ 7段目：${RUN_GAMES}試合のランでの打ち手（先発が毎試合${STARTER_PITCHES_PER_GAME}球投げる）`);
const STAFF: readonly { label: string; stamina: number }[] = [
  { label: 'エース', stamina: 0.85 },
  { label: '2バンテ', stamina: 0.78 },
  { label: '3バンテ', stamina: 0.7 },
  { label: '4バンテ', stamina: 0.62 },
];

/** 打ち手＝各試合に誰を先発させるか（投手陣の添字の並び） */
const PLANS: readonly { label: string; order: readonly number[] }[] = [
  { label: 'エース連投', order: [0, 0, 0, 0, 0] },
  { label: 'エースと2番手', order: [0, 1, 0, 1, 0] },
  { label: '3人ローテ', order: [0, 1, 2, 0, 1] },
  { label: '4人ローテ', order: [0, 1, 2, 3, 0] },
];

console.log(row(['ウチテ', ...Array.from({ length: RUN_GAMES }, (_, i) => `${i + 1}シアイメ`), 'ゴウケイ失点'], 11));
/** 打ち手ごとの合計失点（下の結論の文に、いま測った値をそのまま出す） */
const planTotals = new Map<string, number>();
for (const plan of PLANS) {
  // 持ち越しは投球数の形で持つ（実装と同じ）
  const carried = STAFF.map(() => 0);
  const perGame: string[] = [];
  let total = 0;
  for (let g = 0; g < RUN_GAMES; g += 1) {
    const idx = plan.order[g];
    const { stamina } = STAFF[idx];
    const start = staminaRemaining(carried[idx], stamina);
    const runs9 = gameRuns(start, stamina) * 9;
    total += runs9;
    perGame.push(f2(runs9));
    // 投げた投手は球数を積み、投げなかった投手を含めて全員が回復する（＝実装と同じ順序）
    for (let i = 0; i < STAFF.length; i += 1) {
      const thrown = i === idx ? STARTER_PITCHES_PER_GAME : 0;
      carried[i] = Math.max(
        0,
        carried[i] + thrown - REST_RECOVERY * maxPitchesFor(STAFF[i].stamina),
      );
    }
  }
  console.log(row([plan.label, ...perGame, f2(total)], 11));
  planTotals.set(plan.label, total);
}
console.log(
  '\n  → **エース連投がいちばん損**（ランを通した失点がもっとも多い）＝ユーザー判断どおり\n' +
    '    「毎試合エース」が支配戦略でなくなる。ここがこのフェーズの成立条件そのもの。\n',
);
console.log(
  `  → そして**4人ローテが最適でもない**：3人ローテのほうが良い（${f2(planTotals.get('3人ローテ')!)} vs ${f2(planTotals.get('4人ローテ')!)}）。\n` +
    '    4人目は名鑑でいちばんスタミナが小さい（容量87球＝110球の試合では終盤に落ちる）ので、\n' +
    '    「1試合空けただけ（残量0.80）の good な投手」のほうが「無傷の weak な投手」より\n' +
    '    強い＝**休ませる価値と投手の質が釣り合う**（条件cを満たす回復率にした狙いどおり）。\n' +
    '    CPU（R-39）の4人ローテは**必ず全快で回る安全な打ち手**で、人間はそこから\n' +
    '    「3人で回して良い投手を多く使う」と踏み込める＝**踏み込みの判断が人間の取り分**\n' +
    '    （F-26-8の「温存の判断は人間の取り分」と同じ切り分け）。',
);
