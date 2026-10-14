/**
 * 死球のあと乱闘に持ち込むか（フェーズWW-71）。**決めるのは殴られた打者側だけ**で、
 * CPUの打者は「銃なら必ず／普通の死球は装備が投手以上のときだけ」（2026-09-23 ユーザー判断）。
 *
 * **フェーズBBB-80で、普通の死球は「そのうえで3回に1回」になった**（テストプレイ「CPUが
 * デッドボールになった際に、乱闘を仕掛けてくる確率がちょっと高すぎる」。2026-10-10 ユーザー判断）。
 * くじは呼び出し側が試合のシードから別系列で引いて渡す（`CPU_BRAWL_ROLL_SALT`）。
 */
import { describe, expect, it } from 'vitest';
import {
  CPU_BRAWL_CHANCE,
  CPU_BRAWL_ROLL_SALT,
  DEFAULT_LOADOUT,
  type FighterLoadout,
  loadoutStrength,
  shouldCpuStartBrawl,
} from '../src/core/brawl';
import { CPU_SWING_NOISE_SALT } from '../src/core/cpuBatter';
import { DEFAULT_SEED, createRngState, nextRng } from '../src/core/rng';
import { brawlLoadoutFor } from '../src/core/skills';

const strong: FighterLoadout = { ...DEFAULT_LOADOUT, maxHp: 160, powerScale: 1.3 };

/** くじが当たる値・外れる値（境目の両側） */
const HIT = CPU_BRAWL_CHANCE - 0.01;
const MISS = CPU_BRAWL_CHANCE + 0.01;

describe('shouldCpuStartBrawl（CPUの打者が乱闘するか）', () => {
  it('銃で撃たれたら、装備で負けていても・くじが外れても必ず乱闘する', () => {
    for (const roll of [0, HIT, MISS, 0.999]) {
      expect(
        shouldCpuStartBrawl({ byGun: true, batter: DEFAULT_LOADOUT, pitcher: strong, roll }),
      ).toBe(true);
    }
  });

  it('普通の死球は、装備で負けていればくじが当たっても乱闘しない（＝ぶつける前に読める）', () => {
    for (const roll of [0, HIT]) {
      expect(
        shouldCpuStartBrawl({ byGun: false, batter: DEFAULT_LOADOUT, pitcher: strong, roll }),
      ).toBe(false);
    }
  });

  it('装備が投手以上（等しいときを含む）でも、くじが当たったときだけ乱闘する', () => {
    for (const batter of [strong, DEFAULT_LOADOUT]) {
      const base = { byGun: false, batter, pitcher: DEFAULT_LOADOUT };
      expect(shouldCpuStartBrawl({ ...base, roll: 0 })).toBe(true);
      expect(shouldCpuStartBrawl({ ...base, roll: HIT })).toBe(true);
      expect(shouldCpuStartBrawl({ ...base, roll: MISS })).toBe(false);
      expect(shouldCpuStartBrawl({ ...base, roll: 0.999 })).toBe(false);
    }
  });

  it('確率は3回に1回（ユーザー判断）', () => {
    expect(CPU_BRAWL_CHANCE).toBeCloseTo(1 / 3, 10);
  });

  it('試合のシードから引いたくじで、スキルの無い同士の死球のおよそ3回に1回が乱闘になる', () => {
    // main.ts と同じ引き方：試合のシード＋塩から系列を起こし、死球1つにつき1回引く
    let brawls = 0;
    let total = 0;
    for (let game = 0; game < 400; game += 1) {
      let state = createRngState(DEFAULT_SEED + game * 7919 + CPU_BRAWL_ROLL_SALT);
      for (let hbp = 0; hbp < 5; hbp += 1) {
        const draw = nextRng(state);
        state = draw.state;
        total += 1;
        if (
          shouldCpuStartBrawl({
            byGun: false,
            batter: DEFAULT_LOADOUT,
            pitcher: DEFAULT_LOADOUT,
            roll: draw.value,
          })
        ) {
          brawls += 1;
        }
      }
    }
    const rate = brawls / total;
    expect(rate).toBeGreaterThan(0.29);
    expect(rate).toBeLessThan(0.38);
  });

  it('同じシードなら同じ並び（試合は再現できる）・CPU打者のぶれとは別の系列', () => {
    const rolls = (seed: number): number[] => {
      let state = createRngState(seed);
      const out: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        const draw = nextRng(state);
        state = draw.state;
        out.push(draw.value);
      }
      return out;
    };
    expect(rolls(DEFAULT_SEED + CPU_BRAWL_ROLL_SALT)).toEqual(rolls(DEFAULT_SEED + CPU_BRAWL_ROLL_SALT));
    expect(CPU_BRAWL_ROLL_SALT).not.toBe(CPU_SWING_NOISE_SALT);
    expect(rolls(DEFAULT_SEED + CPU_BRAWL_ROLL_SALT)).not.toEqual(
      rolls(DEFAULT_SEED + CPU_SWING_NOISE_SALT),
    );
  });

  it('装備の強さは体力・威力・必殺技の数のどれが増えても上がる（読める規則）', () => {
    const base = loadoutStrength(DEFAULT_LOADOUT);
    expect(loadoutStrength({ ...DEFAULT_LOADOUT, maxHp: 130 })).toBeGreaterThan(base);
    expect(loadoutStrength({ ...DEFAULT_LOADOUT, powerScale: 1.2 })).toBeGreaterThan(base);
    expect(loadoutStrength(brawlLoadoutFor(['shoryuken']))).toBeGreaterThan(base);
  });
});
