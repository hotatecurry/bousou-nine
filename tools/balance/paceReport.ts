/**
 * **CPU投手の配球のくじ＝緩急と、追い込んでからの勝負球（フェーズCCC-86）**＝`npm run balance:pace`
 *
 * 部品（打者の打ち方・合わせ方・回し方）は `pace.ts`。ここはその出力。
 *
 * 段の並びは、このフェーズが形を決めた順：
 * 1. 穴その1：球速はカウントだけで決まる（CCC-86 の前）＝カウントを読む打者は読みの札と同じ
 * 2. 穴その2：追い込んだ1球は荒れていなくてもボール＝追い込まれたら振らないだけで得をする
 * 3. 緩急を外す割合（ユーザー判断で 1/3）
 * 4. 外す区分（決め球・3ボールの置き球。ユーザー判断で「決め球も・3ボールはそのまま」）
 * 5. 勝負球の割合（追い込まれたら振らない打者が、普通に打つ打者を上回らない最小＝1/3）
 * 6. 採用の形で、カウント別に実際に来る球（手がかりの見え方）
 * 7. 採用の形の帰結（打ち方×合わせ方）と、CPU同士の水準
 * 8. BBB-84 の結論（立ち位置を信じる打者が、読まずに寄る打者を下回らない）は保たれるか
 *
 * 1本の計測（先発16人×打線9人×24回）が数秒かかるので、全段で20分ほど。
 */
import type { CpuPaceScope } from '../../src/core/cpuPitcher';
import { CPU_SWING_SIGMA_SEC } from '../../src/core/cpuBatter';
import type { Count } from '../../src/core/rules';
import {
  ADOPTED_MIX,
  PACE_HEAD,
  PACE_REPS,
  PACE_WAYS,
  TIMING_MODELS,
  TWO_STRIKE_TAKE,
  TWO_STRIKE_ZONE_ONLY,
  type MixRule,
  type PaceWay,
  countMix,
  paceLeague,
  paceLine,
  waitUsual,
} from './pace';
import { center, crowd, pct, trustTell } from './tell';

const ways = (labels: readonly string[]): PaceWay[] => PACE_WAYS.filter((w) => labels.includes(w.label));
const MAIN_WAYS = ways(['傾向を待つ', '本当の球速を知る（読みの札）', 'いつも速球を待つ', 'いつも基準速を待つ']);

/** CCC-86 の前（緩急はカウントだけ・勝負球なし）を、外す割合の段で並べるための規則 */
const rulePace = (change: number, scope: CpuPaceScope = { putaway: true, threeBalls: true }): MixRule => ({
  change,
  attack: 0,
  scope,
});

function main(): void {
  console.log('CPU投手の配球のくじ＝緩急と、追い込んでからの勝負球（フェーズCCC-86）');
  console.log(
    `土台：tools/balance/atbat.ts／先発16人×打線9人×${PACE_REPS}回／球場＝ところざわ／打者のぶれはσ${(CPU_SWING_SIGMA_SEC * 1000).toFixed(0)}ms／立ち位置は「信じる」（BBB-84）`,
  );
  console.log('得点は全打席を1つの分布にまとめた打線の得点期待（四球・死球は押し出しの進塁）。');
  console.log('打者が待つ速さを外したときの合わせ直し方は仮定なので3通り並べる：');
  for (const m of TIMING_MODELS) console.log(`   ・${m.label}`);

  // ============================================================
  // 1. 穴その1：球速はカウントだけで決まる
  // ============================================================

  console.log('\n=== 1. CCC-86 の前：球速はカウントだけで決まる（初球は必ず速球・ストライクの後はフォーク…） ===');
  for (const model of TIMING_MODELS) {
    console.log(`-- ${model.label}`);
    console.log(`${'打者が待つ速さ'.padEnd(30)}${PACE_HEAD}`);
    for (const way of PACE_WAYS) {
      console.log(paceLine(way.label, paceLeague({ waitFor: way.wait, hardTiming: model.hard }, null)));
    }
  }
  console.log('   ＝カウントの傾向を待つ打者は、読みの札（本当の球速を知る）とまったく同じ数字になる。');
  console.log('     どの合わせ方の仮定でも三振は3%ほど＝CPU投手はタイミングを外せない。');

  // ============================================================
  // 2. 穴その2：追い込まれたら振らない
  // ============================================================

  console.log('\n=== 2. CCC-86 の前：追い込んだ1球は外へ逃げる（制球が中位以下の投手なら必ずボール） ===');
  for (const model of TIMING_MODELS) {
    console.log(`-- ${model.label}（傾向を待つ）`);
    console.log(`${'追い込まれたら'.padEnd(30)}${PACE_HEAD}`);
    const base = { waitFor: waitUsual, hardTiming: model.hard };
    console.log(paceLine('際どい球にも手を出す（CPU打者の規則）', paceLeague(base, null)));
    console.log(paceLine('ゾーンの球だけ振る（見極めの上限）', paceLeague({ ...base, ...TWO_STRIKE_ZONE_ONLY }, null)));
    console.log(paceLine('振らない', paceLeague({ ...base, ...TWO_STRIKE_TAKE }, null)));
  }
  console.log('   ＝追い込まれたら振らないだけで、出塁率が .03〜.05・1試合に 1点ほど多く取れる（決め球は、制球のとびきり良い8人を除いて');
  console.log('     必ずボール）。緩急を引くと差は 3〜5点に広がる（5段目の 0＝合わせ損ねて追い込まれる打者ほど、振らずに四球を待つ値打ちが上がる）。');

  // ============================================================
  // 3. 緩急を外す割合
  // ============================================================

  console.log('\n=== 3. 緩急を外す割合（勝負球なし・どのカウントでも外す＝決めたときの比べ方） ===');
  for (const model of TIMING_MODELS) {
    console.log(`-- ${model.label}`);
    for (const change of [1 / 4, 1 / 3, 1 / 2]) {
      console.log(`   外す割合 ${change.toFixed(2)}`);
      console.log(`${'打者が待つ速さ'.padEnd(30)}${PACE_HEAD}`);
      for (const way of MAIN_WAYS) {
        console.log(paceLine(way.label, paceLeague({ waitFor: way.wait, hardTiming: model.hard }, rulePace(change))));
      }
    }
  }
  console.log('   ＝1/3 は、どの仮定でも「傾向を待つ」の打率が読まない打ち方（いつも同じ速さを待つ）を下回らない割合（三振はいちばん少ない）。');
  console.log('     1/4・1/2 では、合わせ直せる仮定のとき「いつも速球を待つ」のほうが打率で上回る（1/2 は手がかりが消える）。');
  console.log('     読みの札は割合によらず三振3%前後＝札の値打ちが生まれる。');
  console.log('     得点はどの割合でも（1段目の CCC-86 の前でも）「いつも速球を待つ」ほうが傾向を待つより多い＝早めに振って引っ張る打球と、');
  console.log('     空振りで粘って取る四球のぶん。打球の作りの性質で、緩急の規則では動かない（今回は触っていない）。');

  // ============================================================
  // 4. 外す区分
  // ============================================================

  console.log('\n=== 4. 外す区分（外す割合 1/3・勝負球なし） ===');
  const scopes: Array<[string, CpuPaceScope]> = [
    ['全部', { putaway: true, threeBalls: true }],
    ['決め球も・3ボールはそのまま（採用）', { putaway: true, threeBalls: false }],
    ['決め球は持ち味のまま', { putaway: false, threeBalls: true }],
  ];
  for (const model of TIMING_MODELS) {
    console.log(`-- ${model.label}`);
    for (const [label, scope] of scopes) {
      console.log(`   ${label}`);
      console.log(`${'打者が待つ速さ'.padEnd(30)}${PACE_HEAD}`);
      for (const way of ways(['傾向を待つ', '本当の球速を知る（読みの札）', 'いつも速球を待つ'])) {
        console.log(paceLine(way.label, paceLeague({ waitFor: way.wait, hardTiming: model.hard }, rulePace(1 / 3, scope))));
      }
    }
  }
  console.log('   ＝三振を外すのはほとんど決め球（持ち味のままだと傾向を待つ打者の三振は 3〜5割少ない）。3ボールの置き球はどちらでも数字がほとんど動かない');
  console.log('     ＝T-41 の「待った側への報酬（誰が投げても真ん中の基準速）」をそのまま残せる。');

  // ============================================================
  // 5. 勝負球の割合
  // ============================================================

  console.log('\n=== 5. 勝負球の割合（追い込んだ1球がゾーンの隅へ。外す割合 1/3・決め球も・3ボールはそのまま） ===');
  for (const model of TIMING_MODELS) {
    console.log(`-- ${model.label}（傾向を待つ）`);
    for (const attack of [0, 1 / 4, 1 / 3, 1 / 2, 2 / 3]) {
      const rule: MixRule = { ...ADOPTED_MIX, attack };
      console.log(`   勝負球 ${attack.toFixed(2)}`);
      console.log(`${'追い込まれたら'.padEnd(30)}${PACE_HEAD}`);
      const base = { waitFor: waitUsual, hardTiming: model.hard };
      console.log(paceLine('際どい球にも手を出す', paceLeague(base, rule)));
      console.log(paceLine('ゾーンの球だけ振る（見極めの上限）', paceLeague({ ...base, ...TWO_STRIKE_ZONE_ONLY }, rule)));
      console.log(paceLine('振らない', paceLeague({ ...base, ...TWO_STRIKE_TAKE }, rule)));
    }
  }
  console.log('   ＝1/3 が「追い込まれたら振らない打者が、普通に打つ打者を上回らない」いちばん小さい割合（1/4 は2つの仮定で振らないほうが得）。');
  console.log('     ゾーンの球だけを振る（見極める）打者への報酬は 1/3 でも残る（1/2 でほぼ消える）。');
  {
    const seeds = [2, 3];
    console.log(`   確かめ（別の種 ${seeds.join('・')}／48回。採用の 1/3）：`);
    for (const seed of seeds) {
      for (const model of TIMING_MODELS) {
        const base = { waitFor: waitUsual, hardTiming: model.hard };
        const normal = paceLeague(base, ADOPTED_MIX, 48, seed);
        const take = paceLeague({ ...base, ...TWO_STRIKE_TAKE }, ADOPTED_MIX, 48, seed);
        console.log(
          `     種${seed}・${model.label}：普通 ${normal.runs.toFixed(2)}点／振らない ${take.runs.toFixed(2)}点（三振 ${pct(take.k)}）`,
        );
      }
    }
  }

  // ============================================================
  // 6. 採用の形で、カウント別に実際に来る球
  // ============================================================

  console.log('\n=== 6. 採用の形で、カウント別に実際に来る球（名鑑の投手96人。くじの確率をそのまま掛けた期待値） ===');
  console.log(`${'カウント'.padEnd(10)}${['速球', '基準速', 'フォーク', 'いつもの球速', 'ゾーンへ', '（前）ゾーンへ'].map((s) => s.padStart(12)).join('')}`);
  for (let strikes = 0; strikes <= 2; strikes += 1) {
    for (let balls = 0; balls <= 3; balls += 1) {
      const count: Count = { balls, strikes };
      const m = countMix(count);
      const before = countMix(count, { change: 0, attack: 0 });
      console.log(
        `${`${balls}-${strikes}`.padEnd(10)}${[pct(m.speed.fast), pct(m.speed.neutral), pct(m.speed.slow), pct(m.usual), pct(m.zone), pct(before.zone)]
          .map((s) => s.padStart(12))
          .join('')}`,
      );
    }
  }
  console.log('   ＝どのカウントでも「いつもの球速」が3回に2回（3ボールの置き球は必ず基準速）。追い込んだ1球がゾーンへ来るのは');
  console.log('     CCC-86 の前は制球のとびきり良い投手だけ（96人中8人）だったのが、3回に1回の勝負球のぶん増える（荒れた投手の勝負球は外れうる）。');

  // ============================================================
  // 7. 採用の形の帰結と、CPU同士の水準
  // ============================================================

  console.log('\n=== 7. 採用の形の帰結（打ち方×合わせ方）と、CPU同士の水準 ===');
  for (const model of TIMING_MODELS) {
    console.log(`-- ${model.label}`);
    console.log(`${'打者の打ち方'.padEnd(30)}${PACE_HEAD}`);
    for (const way of PACE_WAYS) {
      console.log(paceLine(way.label, paceLeague({ waitFor: way.wait, hardTiming: model.hard }, ADOPTED_MIX)));
    }
    console.log(
      paceLine('傾向＋追い込まれたら振らない', paceLeague({ waitFor: waitUsual, hardTiming: model.hard, ...TWO_STRIKE_TAKE }, ADOPTED_MIX)),
    );
    console.log(
      paceLine(
        '傾向＋追い込まれたらゾーンだけ',
        paceLeague({ waitFor: waitUsual, hardTiming: model.hard, ...TWO_STRIKE_ZONE_ONLY }, ADOPTED_MIX),
      ),
    );
  }
  console.log('-- CPU打者 vs CPU投手（立ち位置もタイミングもCPUの規則。画面には出ない＝計測の基準）');
  console.log(`${'規則'.padEnd(30)}${PACE_HEAD}`);
  console.log(paceLine('CCC-86 の前', paceLeague({ stanceFor: undefined }, null)));
  console.log(paceLine('緩急だけ（勝負球なし）', paceLeague({ stanceFor: undefined }, { ...ADOPTED_MIX, attack: 0 })));
  console.log(paceLine('採用', paceLeague({ stanceFor: undefined }, ADOPTED_MIX)));
  console.log('   ＝CPU打者は追い込まれたら隅の1つ外（0.50）まで必ず手を出す（SS-67）ので、勝負球のぶん四球が減る。');

  // ============================================================
  // 8. BBB-84 の結論は保たれるか
  // ============================================================

  console.log('\n=== 8. BBB-84 の結論（立ち位置を信じる打者が、読まずに寄る打者を下回らない）は保たれるか ===');
  for (const model of TIMING_MODELS) {
    console.log(`-- ${model.label}（傾向を待つ）`);
    console.log(`${'立ち位置'.padEnd(30)}${PACE_HEAD}`);
    for (const [label, stanceFor] of [
      ['立ち位置を信じる', trustTell],
      ['いつも寄り切る', crowd],
      ['中央のまま', center],
    ] as const) {
      console.log(paceLine(label, paceLeague({ waitFor: waitUsual, hardTiming: model.hard, stanceFor }, ADOPTED_MIX)));
    }
  }
  console.log('   ＝並び（信じる ≧ 寄り切る ＞ 中央）は変わらない。');
}

main();
