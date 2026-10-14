/**
 * 投手の球速（SPD）の効かせ方と、野手の足（フェーズBBB-85）。`npm run balance:speed`。
 * 部品は `speed.ts`（帯のテスト `tests/pitcherSpeed.test.ts` が読む）。
 *
 * テストプレイ「CPUが長打を出しすぎる。こちらの投手は球速のスキル（鉄腕）を持っているのに」
 * 「守備の移動スピードが、ちょっと遅すぎる」への計測。
 */
import { CPU_SWING_SIGMA_SEC, cpuTimingScale } from '../../src/core/cpuBatter';
import { CPU_FIELD_REACTION_SEC, FIELDER_SPEED, RUNNER_SPEED, RUNNER_SPEED_MIN } from '../../src/core/fielding';
import { REFERENCE_PITCHER_NEUTRAL, SPEED_NEUTRAL, neutralSpeedFor } from '../../src/core/pitch';
import { SWING_ACTIVE_SEC } from '../../src/core/batting';
import { TEAMS, pitcherRowPitching, teamById } from '../../src/core/teams';
import type { SpeedRule } from './atbat';
import { HEAD, league, line, trustTell } from './tell';
import {
  CPU_DEFENSE,
  HEAT,
  HUMAN_DEFENSE,
  MIXED,
  PITCHING_HEAD,
  RULE_BEFORE,
  RULE_CARRY_ONLY,
  RULE_NOW,
  TETSUWAN_SPEED,
  fixedSpeed,
  pitching,
  pitchingLine,
  speedPlus,
} from './speed';

const RATINGS = [0.3, 0.5, 0.7, 0.9] as const;
const PATTERNS = [
  ['散らす', MIXED],
  ['速球で押す', HEAT],
] as const;

function table(title: string, rule: SpeedRule): void {
  for (const [name, patterns] of PATTERNS) {
    console.log(`\n   ── ${name}／CPUの守備／${title} ──`);
    console.log(`${'投手の球速（SPD）'.padEnd(34)}${PITCHING_HEAD}`);
    for (const rating of RATINGS) {
      console.log(
        pitchingLine(`SPD ${rating}`, pitching(patterns, fixedSpeed(rating), { ...CPU_DEFENSE, speedRule: rule }, 8)),
      );
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. 穴：BBB-84 までは、球の速い投手ほど打たれた ===');
console.log('   人間が投げる（決まった配球をまっすぐ）×CPU打線144人。投手は各球団のエースで、球速だけ差し替える。');
console.log('   打球初速に 0.5×球速 が乗り、CPU打者のタイミングは投手ごとの相対で決まる＝球速は損にしかならなかった。');
table('BBB-84 まで', RULE_BEFORE);

// ---------------------------------------------------------------------------
console.log('\n=== 2. 採らなかった形 ===');
console.log('   (a) 打球に乗せないだけ＝球速がCPU打者相手に何にも効かなくなる（どの球速でも同じ行になる）');
table('打球に乗せないだけ', RULE_CARRY_ONLY);
console.log('\n   (b) 誤差を基準速の2乗で効かせる＝遅い投手が打たれすぎ、速い投手の三振が3割に届く');
table('誤差∝基準速の2乗', { timingPow: 2 });
console.log('\n   (c) 基準を SPD 0.5（基準速36）に置く＝名鑑の投手（平均0.67）の打球が全体に 1m/s 弱くなる');
console.log(`${''.padEnd(34)}${HEAD}`);
console.log(line('CPU同士／BBB-84 まで', league({ speedRule: RULE_BEFORE })));
console.log(line('CPU同士／基準36', league({ speedRule: { reference: SPEED_NEUTRAL } })));
console.log(line(`CPU同士／基準${REFERENCE_PITCHER_NEUTRAL}（採用）`, league({ speedRule: RULE_NOW })));

// ---------------------------------------------------------------------------
console.log('\n=== 3. 採用：打球に乗せない＋球が速い投手ほどCPU打者の誤差が大きい ===');
console.log('   誤差（緩急のずれとぶれ）の倍率＝投手の基準速 ÷ 基準の投手の基準速＝飛行時間が縮む比と同じ。');
table('採用', RULE_NOW);

// ---------------------------------------------------------------------------
console.log(`\n=== 4. 鉄腕（球速 +${TETSUWAN_SPEED}）を持たせたエース：人間らしい守備で ===`);
console.log('   人間らしい守備＝いちばん近い野手を球へ向ける一斉移動・反応0.3秒。');
for (const [name, patterns] of PATTERNS) {
  console.log(`\n   ── ${name} ──`);
  console.log(`${'投手'.padEnd(34)}${PITCHING_HEAD}`);
  const at = (delta: number, rule: SpeedRule) =>
    pitching(patterns, speedPlus(delta), { ...HUMAN_DEFENSE, speedRule: rule });
  console.log(pitchingLine('エース／BBB-84 まで', at(0, RULE_BEFORE)));
  console.log(pitchingLine('エース＋鉄腕／BBB-84 まで', at(TETSUWAN_SPEED, RULE_BEFORE)));
  console.log(pitchingLine('エース／採用', at(0, RULE_NOW)));
  console.log(pitchingLine('エース＋鉄腕／採用', at(TETSUWAN_SPEED, RULE_NOW)));
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. 水準：CPU投手が投げるとき（CPUの守備） ===');
console.log('   人間の打者（立ち位置を信じる）は、タイミングが人間のもの＝誤差の倍率は掛からない（打球の強さだけ変わる）。');
console.log(`${''.padEnd(34)}${HEAD}`);
console.log(line('CPU打者／BBB-84 まで', league({ speedRule: RULE_BEFORE })));
console.log(line('CPU打者／採用', league({ speedRule: RULE_NOW })));
console.log(line('人間(信じる)／BBB-84 まで', league({ stanceFor: trustTell, speedRule: RULE_BEFORE })));
console.log(line('人間(信じる)／採用', league({ stanceFor: trustTell, speedRule: RULE_CARRY_ONLY })));

// ---------------------------------------------------------------------------
console.log(`\n=== 6. 野手の足と、CPU守備の反応（いま 野手 ${FIELDER_SPEED}m/s・反応 ${CPU_FIELD_REACTION_SEC}秒） ===`);
console.log(`   走者は ${RUNNER_SPEED_MIN}〜8.2m/s（基準 ${RUNNER_SPEED}）。原作の野手は約6.0m/s（BBB-82 の実測）。`);
console.log('   こちらの画面は横 約68m を映す（原作は約44m）＝同じ m/s でも画面の上では原作の65%の速さだった。');
console.log('\n   ── 野手の足の候補（定数を書き換えて回した記録。球速の規則は BBB-84 まで・CPU守備の反応 0.25秒） ──');
console.log('   野手    CPU同士 打率/得点   人間(信じる) 打率/得点   人間が投げる（散らす・人間らしい守備）打率/長打');
console.log('   6.0     .251 / 4.46        .314 / 7.48              .292 / 18.1%');
console.log('   6.5     .227 / 3.33        .292 / 6.72              .260 / 15.0%');
console.log('   7.0     .199 / 2.47        .270 / 5.93              .232 / 12.1%');
console.log('   7.5     .182 / 2.16        .246 / 4.65              .210 /  9.2%');
console.log('   ＝野手を速くすると、こちらが守るときのCPUの長打は減るが、こちらが打つときの安打も減る。');
console.log('\n   ── CPU守備の反応で釣り合いを取る（同じく記録。球速の規則は BBB-84 まで。人間(信じる)の得点を 7.5 前後に保つ値を採る） ──');
console.log('   野手 6.5：反応 0.35 → CPU同士 .240/3.71・人間 .310/7.41 ／ 0.45 → .263/4.62・.333/8.45');
console.log('   野手 7.0：反応 0.35 → CPU同士 .221/2.83・人間 .285/6.34 ／ 0.45 → .245/3.63・.317/7.76 ／ 0.55 → .252/3.98・.332/8.32');
console.log(`\n   ── いまの値（野手 ${FIELDER_SPEED}m/s）で、CPU守備の反応を振る ──`);
console.log(`${''.padEnd(34)}${HEAD}`);
for (const r of [0.25, 0.35, 0.45, 0.55]) {
  const tag = r === CPU_FIELD_REACTION_SEC ? '（採用）' : '';
  console.log(line(`CPU打者／反応${r}${tag}`, league({ reactionSec: r })));
  console.log(
    line(`人間(信じる)／反応${r}${tag}`, league({ reactionSec: r, stanceFor: trustTell, speedRule: RULE_CARRY_ONLY })),
  );
}
console.log('\n   ── 人間が投げる（エース・名鑑の球速）×CPU打線：守備ごと ──');
console.log(`${'守備'.padEnd(34)}${PITCHING_HEAD}`);
for (const [name, patterns] of PATTERNS) {
  console.log(pitchingLine(`${name}／CPUの守備`, pitching(patterns, speedPlus(0), CPU_DEFENSE)));
  console.log(pitchingLine(`${name}／人間らしい守備（反応0.3）`, pitching(patterns, speedPlus(0), HUMAN_DEFENSE)));
  console.log(
    pitchingLine(
      `${name}／人間らしい守備（反応0.5）`,
      pitching(patterns, speedPlus(0), { chase: 'follow', reactionSec: 0.5 }),
    ),
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 7. 基準の投手と、誤差の倍率の散らばり（名鑑96人） ===');
{
  const staff = TEAMS.flatMap((t) => teamById(t.id).pitchers.map((r, i) => ({ i, speed: pitcherRowPitching(r).speed })));
  const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const groups: readonly (readonly [string, readonly number[]])[] = [
    ['全96人', staff.map((p) => p.speed)],
    ['先頭（エース）16人', staff.filter((p) => p.i === 0).map((p) => p.speed)],
    ['先発型64人', staff.filter((p) => p.i < 4).map((p) => p.speed)],
    ['救援32人', staff.filter((p) => p.i >= 4).map((p) => p.speed)],
  ];
  console.log('   群            球速の平均  その基準速   最小   最大');
  for (const [name, xs] of groups) {
    console.log(
      `   ${name.padEnd(14)}${mean(xs).toFixed(3).padStart(8)}${neutralSpeedFor(mean(xs)).toFixed(2).padStart(10)}m/s` +
        `${Math.min(...xs).toFixed(2).padStart(7)}${Math.max(...xs).toFixed(2).padStart(7)}`,
    );
  }
  console.log(`   基準の投手の基準速 ${REFERENCE_PITCHER_NEUTRAL}m/s（＝球速 ${((REFERENCE_PITCHER_NEUTRAL - SPEED_NEUTRAL) / 12 + 0.5).toFixed(3)}）`);
  console.log('\n   球速   基準速   誤差の倍率   ぶれσ     緩急1段のずれ   同じ速さを待って空振り（|誤差|>窓の半分）');
  const half = SWING_ACTIVE_SEC / 2;
  /** 標準正規分布の上側確率（±3σで打ち切った分布の近似として十分） */
  const tail = (z: number): number => {
    const t = 1 / (1 + 0.2316419 * z);
    const d = 0.3989423 * Math.exp((-z * z) / 2);
    return d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  };
  for (const rating of [0, 0.35, 0.5, 0.67, 0.8, 0.96, 1]) {
    const n = neutralSpeedFor(rating);
    const scale = cpuTimingScale(n);
    const sigma = CPU_SWING_SIGMA_SEC * scale;
    console.log(
      `   ${rating.toFixed(2)}${n.toFixed(1).padStart(8)}${scale.toFixed(3).padStart(11)}` +
        `${(sigma * 1000).toFixed(1).padStart(10)}ms${(((SWING_ACTIVE_SEC / 3) * scale) * 1000).toFixed(1).padStart(12)}ms` +
        `${(2 * tail(half / sigma) * 100).toFixed(1).padStart(14)}%`,
    );
  }
}
