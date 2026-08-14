/**
 * フェーズO-35：フォークの変化量（F）＝フォークの曲がり（説明書p26-29の投手データ F）。
 *
 * 着手前の実態：`fork` は名鑑（96人ぶん 0.38〜0.90）にも `PitcherStats` にも
 * スキルの補正欄にも存在したが、**読む側が1つも無かった**（`src/` 全体で4か所、
 * すべて定義と受け渡し）。原作の能力項目がまるごと死んでいた。
 *
 * **最初は「緩急の幅」に繋いだが計測で否定した**（`npm run balance:fork` の記録は
 * PROGRESS.md）。打球初速が `0.5 × 球速` を含むので球速を動かすと必ず打球の質が動き、
 * 幅を広げると**両側とも打者有利**になった（フォークの安打率 9.7%→17.0%）。
 * そこで**球速には触れず、R/L と同じ「曲がりの強さ」の経路**に載せ直した。
 *
 * ここで固定するのは3つ。
 * 1. **F=0.5 は従来の `STEER_ACCEL` ちょうど**（B-8以来の基準線）
 * 2. **フォークを選んだときだけ F、それ以外は R/L**（役割が混ざっていない）
 * 3. **球速には一切効かない**（否定された設計へ戻っていないことの歯止め）
 */
import { describe, expect, it } from 'vitest';
import {
  NEUTRAL_RATING,
  SPEED_FAST,
  SPEED_NEUTRAL,
  SPEED_SLOW,
  STEER_ACCEL_MIN,
  STEER_ACCEL_SPAN,
  neutralSpeedFor,
  speedForPitchSelection,
  steerAccelFor,
  steerAccelForSelection,
} from '../src/core/pitch';
import { TEAMS, pitcherRowPitching } from '../src/core/teams';

const SLOW = 1 as const;
const NEUTRAL = 0 as const;
const FAST = -1 as const;

describe('steerAccelForSelection：Fはフォークを選んだときだけ効く', () => {
  it('基準値0.5 で従来の STEER_ACCEL（=14）ちょうど', () => {
    const base = STEER_ACCEL_MIN + STEER_ACCEL_SPAN * NEUTRAL_RATING;
    expect(base).toBe(14);
    for (const y of [SLOW, NEUTRAL, FAST]) {
      expect(steerAccelForSelection(y, NEUTRAL_RATING, NEUTRAL_RATING)).toBe(base);
    }
  });

  it('引数を省略した呼び出しは従来と完全に同じ（基準線が動かない）', () => {
    for (const y of [SLOW, NEUTRAL, FAST]) {
      expect(steerAccelForSelection(y)).toBe(steerAccelFor(NEUTRAL_RATING));
    }
  });

  it('フォーク（上入力）を選ぶと F が使われる', () => {
    expect(steerAccelForSelection(SLOW, 0.1, 0.9)).toBe(steerAccelFor(0.9));
  });

  it('速球・基準速では R/L が使われる（Fは無視される）', () => {
    expect(steerAccelForSelection(FAST, 0.1, 0.9)).toBe(steerAccelFor(0.1));
    expect(steerAccelForSelection(NEUTRAL, 0.1, 0.9)).toBe(steerAccelFor(0.1));
  });

  it('Fが高いほどフォークは大きく曲がる（単調増加）', () => {
    expect(steerAccelForSelection(SLOW, 0.5, 0.2)).toBeLessThan(
      steerAccelForSelection(SLOW, 0.5, 0.5),
    );
    expect(steerAccelForSelection(SLOW, 0.5, 0.5)).toBeLessThan(
      steerAccelForSelection(SLOW, 0.5, 0.9),
    );
  });

  it('0..1 の外は内側へ丸める（壊れた値でも曲がりが暴れない）', () => {
    expect(steerAccelForSelection(SLOW, 0.5, -5)).toBe(STEER_ACCEL_MIN);
    expect(steerAccelForSelection(SLOW, 0.5, 5)).toBe(STEER_ACCEL_MIN + STEER_ACCEL_SPAN);
  });

  it('純粋関数（同じ入力からは必ず同じ加速度）', () => {
    expect(steerAccelForSelection(SLOW, 0.31, 0.77)).toBe(steerAccelForSelection(SLOW, 0.31, 0.77));
  });
});

describe('Fは球速に一切効かない（計測で否定した設計へ戻っていないことの歯止め）', () => {
  it('speedForPitchSelection は球速（SPD）だけを見る', () => {
    expect(speedForPitchSelection(SLOW, NEUTRAL_RATING)).toBe(SPEED_SLOW);
    expect(speedForPitchSelection(FAST, NEUTRAL_RATING)).toBe(SPEED_FAST);
    expect(speedForPitchSelection(NEUTRAL, NEUTRAL_RATING)).toBe(SPEED_NEUTRAL);
  });

  it('緩急の幅は投手によらず一定（上下入力の意味が誰でも同じ）', () => {
    for (const spd of [0, 0.25, 0.5, 0.75, 1]) {
      const neutral = speedForPitchSelection(NEUTRAL, spd);
      expect(neutral - speedForPitchSelection(SLOW, spd)).toBeCloseTo(SPEED_NEUTRAL - SPEED_SLOW, 10);
      expect(speedForPitchSelection(FAST, spd) - neutral).toBeCloseTo(SPEED_FAST - SPEED_NEUTRAL, 10);
    }
  });
});

describe('neutralSpeedFor：緩急の中心（見た目のドロップ・残像もここから取る）', () => {
  it('基準値で従来の SPEED_NEUTRAL', () => {
    expect(neutralSpeedFor(NEUTRAL_RATING)).toBe(SPEED_NEUTRAL);
    expect(neutralSpeedFor()).toBe(SPEED_NEUTRAL);
  });

  it('speedForPitchSelection の無入力と必ず一致する（中心が2か所に分かれていない）', () => {
    for (const spd of [0, 0.3, 0.5, 0.8, 1]) {
      expect(neutralSpeedFor(spd)).toBe(speedForPitchSelection(NEUTRAL, spd));
    }
  });

  it('速球派の速球でも残像の正規化が1を超えない（接続前からあった見た目のバグの回帰防止）', () => {
    const spd = 1;
    const fast = speedForPitchSelection(FAST, spd);
    const fastness = (fast - neutralSpeedFor(spd)) / (SPEED_FAST - SPEED_NEUTRAL);
    expect(fastness).toBeLessThanOrEqual(1);
  });
});

describe('名鑑のFが実際にフォークの曲がりの差になる（死んだ能力項目ではなくなった）', () => {
  const pitchers = TEAMS.flatMap((t) => t.pitchers.map(pitcherRowPitching));

  it('96人の投手全員がFを持つ', () => {
    expect(pitchers).toHaveLength(16 * 6);
    for (const p of pitchers) expect(p.fork).toBeGreaterThan(0);
  });

  it('名鑑のFの散らばりが、実際のフォークの曲がりの散らばりになる', () => {
    const accels = pitchers.map((p) => steerAccelForSelection(SLOW, p.breakRight, p.fork));
    const spread = Math.max(...accels) - Math.min(...accels);
    // 接続前はフォークもR/Lで曲がっていたので、Fの散らばりは1mmも出ていなかった。
    // 値そのものではなく「実際に差が出ていること」を帯で守る。
    expect(spread).toBeGreaterThan(3);
  });

  it('フォークの曲がりとカーブ/シュートの曲がりが別の投手で最大になる（役割が重なっていない）', () => {
    const best = <T>(arr: readonly T[], score: (v: T) => number): T =>
      arr.reduce((a, b) => (score(b) > score(a) ? b : a));
    const bestFork = best(pitchers, (p) => p.fork);
    const bestBreak = best(pitchers, (p) => (p.breakLeft + p.breakRight) / 2);
    // 同一人物なら「F を足した意味」が薄い＝名鑑側の持ち味が分かれていることを固定する
    expect(bestFork.fork).toBeGreaterThan((bestBreak.breakLeft + bestBreak.breakRight) / 2 - 1);
    expect(bestFork).not.toBe(bestBreak);
  });
});
