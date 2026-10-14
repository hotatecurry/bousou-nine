/**
 * 投手の球速（SPD）の効き方（フェーズBBB-85。`npm run balance:speed` で測った帯）。
 *
 * テストプレイ「CPUが長打を出しすぎる。こちらの投手は球速のスキル（鉄腕）を持っているのに」。
 * 測ると、**球速はCPU打者相手に損にしかなっていなかった**：打球初速に `0.5 × 球速` が乗る一方、
 * CPU打者のタイミングは投手ごとの相対（基準速からの緩急の段）で決まり、ぶれは秒で持つので、
 * 誰が投げても同じだけ当てた。
 *
 * 直し方は2つをセットで（2026-10-14 ユーザー判断）：
 * 1. **投手の球速は打球の強さに乗せない**（乗るのは緩急ぶんだけ＝`carriedPitchSpeed`）
 * 2. **球が速い投手ほど、CPU打者の誤差が大きい**（飛行時間が縮む比と同じ＝`cpuTimingScale`）
 *
 * ここで固定するのは向き（どちらが大きいか）で、値そのものではない。人間が決まった配球を
 * まっすぐ投げ、CPU打線144人が打つ（`tools/balance/speed.ts`）。
 */
import { describe, expect, it } from 'vitest';
import type { SpeedRule } from '../tools/balance/atbat';
import {
  MIXED,
  type PitchingSum,
  RULE_BEFORE,
  RULE_CARRY_ONLY,
  RULE_NOW,
  TETSUWAN_SPEED,
  fixedSpeed,
  pitching,
  speedPlus,
} from '../tools/balance/speed';
import { SKILLS } from '../src/core/skills';

const TIMEOUT = 120000;
/** 1つの条件＝配球5形×打線144人×この回数（帯は向きだけを見るので少なくてよい） */
const REPS = 2;

const cache = new Map<string, PitchingSum>();
/** 球速を決まった値に置いた投手（`rating`）か、名鑑の球速に足した投手（`plus`） */
function run(key: string, speedOf: (s: number) => number, rule: SpeedRule): PitchingSum {
  const hit = cache.get(key);
  if (hit) return hit;
  const value = pitching(MIXED, speedOf, { speedRule: rule }, REPS);
  cache.set(key, value);
  return value;
}
const SLOW = 0.3;
const FAST = 0.9;
const at = (name: string, rule: SpeedRule, rating: number): PitchingSum =>
  run(`${name}-${rating}`, fixedSpeed(rating), rule);
const plus = (name: string, rule: SpeedRule, delta: number): PitchingSum =>
  run(`${name}+${delta}`, speedPlus(delta), rule);

describe('穴：BBB-84 までは、球の速い投手ほど打たれた', () => {
  it(
    '球速を上げると長打が増え、三振は増えない（球速はCPU打者相手に損にしかならなかった）',
    () => {
      const slow = at('before', RULE_BEFORE, SLOW);
      const fast = at('before', RULE_BEFORE, FAST);
      // 実測（`balance:speed` の1段目）：長打 5.1% → 12.5%・本塁打 0.5% → 5.3%・三振 20.2% → 19.6%
      expect(fast.long).toBeGreaterThan(slow.long * 1.5);
      expect(fast.hr).toBeGreaterThan(slow.hr * 2);
      expect(fast.exit).toBeGreaterThan(slow.exit + 1.5);
      expect(fast.k).toBeLessThan(slow.k + 0.02);
    },
    TIMEOUT,
  );

  it(
    '球速のスキル（鉄腕）を持たせると、かえって打たれた',
    () => {
      const base = plus('before', RULE_BEFORE, 0);
      const skilled = plus('before', RULE_BEFORE, TETSUWAN_SPEED);
      expect(skilled.long).toBeGreaterThan(base.long);
      expect(skilled.hr).toBeGreaterThan(base.hr);
    },
    TIMEOUT,
  );

  it('ここで測っている球速の補正は、鉄腕のもの', () => {
    expect(SKILLS.tetsuwan.modifier?.speed).toBe(TETSUWAN_SPEED);
  });
});

describe('採らなかった形：打球に乗せないだけ', () => {
  it(
    '球速がCPU打者相手に何にも効かなくなる（遅い投手と速い投手で、打席がすべて同じ）',
    () => {
      // CPU打者は緩急を「その投手の基準速からの段」で見て、ぶれは秒で持つ＝球速が入る所が無い
      expect(at('carry', RULE_CARRY_ONLY, FAST)).toEqual(at('carry', RULE_CARRY_ONLY, SLOW));
    },
    TIMEOUT,
  );
});

describe('採用：打球に乗せない＋球が速い投手ほどCPU打者の誤差が大きい', () => {
  it(
    '球速を上げると三振が増え、打率が下がる',
    () => {
      const slow = at('now', RULE_NOW, SLOW);
      const fast = at('now', RULE_NOW, FAST);
      // 実測（同3段目）：三振 15.1% → 22.0%・打率 .241 → .213
      expect(fast.k).toBeGreaterThan(slow.k + 0.03);
      expect(fast.avg).toBeLessThan(slow.avg);
    },
    TIMEOUT,
  );

  it(
    '球速を上げても長打は増えない（打球の強さは投手によらない）',
    () => {
      const slow = at('now', RULE_NOW, SLOW);
      const fast = at('now', RULE_NOW, FAST);
      expect(fast.long).toBeLessThan(slow.long + 0.01);
      // インプレーの打球の平均初速はほぼ同じ（誤差が大きいぶん、速い投手のほうがわずかに弱い）
      expect(Math.abs(fast.exit - slow.exit)).toBeLessThan(0.6);
    },
    TIMEOUT,
  );

  it(
    '鉄腕を持たせると、打たれにくくなる（三振が増え、長打は増えない）',
    () => {
      const base = plus('now', RULE_NOW, 0);
      const skilled = plus('now', RULE_NOW, TETSUWAN_SPEED);
      expect(skilled.k).toBeGreaterThan(base.k);
      expect(skilled.long).toBeLessThan(base.long + 0.01);
      expect(skilled.hr).toBeLessThan(base.hr + 0.005);
      // 同じ投手が BBB-84 までの規則で投げたときより、長打は少ない
      expect(skilled.long).toBeLessThan(plus('before', RULE_BEFORE, TETSUWAN_SPEED).long);
    },
    TIMEOUT,
  );
});
