/**
 * 死球のあと乱闘に持ち込むか（フェーズWW-71）。**決めるのは殴られた打者側だけ**で、
 * CPUの打者は「銃なら必ず／普通の死球は装備が投手以上のときだけ」（2026-09-23 ユーザー判断）。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOADOUT,
  type FighterLoadout,
  loadoutStrength,
  shouldCpuStartBrawl,
} from '../src/core/brawl';
import { brawlLoadoutFor } from '../src/core/skills';

const strong: FighterLoadout = { ...DEFAULT_LOADOUT, maxHp: 160, powerScale: 1.3 };

describe('shouldCpuStartBrawl（CPUの打者が乱闘するか）', () => {
  it('銃で撃たれたら、装備で負けていても必ず乱闘する', () => {
    expect(shouldCpuStartBrawl({ byGun: true, batter: DEFAULT_LOADOUT, pitcher: strong })).toBe(true);
  });

  it('普通の死球は、装備が投手以上のときだけ乱闘する', () => {
    expect(shouldCpuStartBrawl({ byGun: false, batter: strong, pitcher: DEFAULT_LOADOUT })).toBe(true);
    expect(shouldCpuStartBrawl({ byGun: false, batter: DEFAULT_LOADOUT, pitcher: strong })).toBe(false);
  });

  it('同じ装備（どちらもスキル無し）なら乱闘する＝「投手以上」は等しいときを含む', () => {
    expect(
      shouldCpuStartBrawl({ byGun: false, batter: DEFAULT_LOADOUT, pitcher: DEFAULT_LOADOUT }),
    ).toBe(true);
  });

  it('装備の強さは体力・威力・必殺技の数のどれが増えても上がる（読める規則）', () => {
    const base = loadoutStrength(DEFAULT_LOADOUT);
    expect(loadoutStrength({ ...DEFAULT_LOADOUT, maxHp: 130 })).toBeGreaterThan(base);
    expect(loadoutStrength({ ...DEFAULT_LOADOUT, powerScale: 1.2 })).toBeGreaterThan(base);
    expect(loadoutStrength(brawlLoadoutFor(['shoryuken']))).toBeGreaterThan(base);
  });
});
