/**
 * 原作の「絵の切り替え」の時間割（フェーズBBB-76。`src/core/keyframes.ts`）。
 * 原作の映像（素振り・打った球・7球の投球）を1フレームずつ測った値をそのまま固定する。
 */
import { describe, expect, it } from 'vitest';
import {
  ORIGINAL_FRAME_SEC,
  PITCH_RELEASE_FRAMES,
  PITCH_WINDUP_FRAMES,
  PITCH_WINDUP_KEYS,
  STEAL_GO_SEC,
  SWING_CONTACT_KEY_FROM,
  SWING_FINISH_FROM,
  SWING_FINISH_HOLD_SEC,
  SWING_KEY_SEC,
  SWING_RETURN_FROM,
  SWING_RETURN_KEY_SEC,
  SWING_TOTAL_SEC,
  afterReleaseKeyAt,
  swingKeyAt,
  windupKeyAt,
} from '../src/core/keyframes';
import { SWING_ACTIVE_SEC, SWING_IDEAL_SEC } from '../src/core/batting';
import { PITCH_WINDUP_SEC } from '../src/core/pitch';

const F = ORIGINAL_FRAME_SEC;

describe('投球モーションの時間割（原作：どの球でも70フレーム）', () => {
  it('70フレームでリリース', () => {
    expect(PITCH_WINDUP_FRAMES).toBe(70);
    expect(PITCH_WINDUP_SEC / F).toBeCloseTo(70, 9);
  });

  it('原作の絵の切り替え（0/12/24/44/60フレーム）', () => {
    expect(PITCH_WINDUP_KEYS.map((k) => k.fromFrame)).toEqual([0, 12, 24, 44, 60]);
    expect(windupKeyAt(0)).toBe('raise');
    expect(windupKeyAt(11 * F)).toBe('raise');
    expect(windupKeyAt(12 * F)).toBe('overhead');
    expect(windupKeyAt(24 * F)).toBe('kick');
    expect(windupKeyAt(43 * F)).toBe('kick');
    expect(windupKeyAt(44 * F)).toBe('back');
    expect(windupKeyAt(60 * F)).toBe('cock');
    expect(windupKeyAt(69.9 * F)).toBe('cock');
  });

  it('リリースから16フレームで守備の構え（最初の4フレームは球が手を離れた形）', () => {
    expect(PITCH_RELEASE_FRAMES).toBe(16);
    expect(afterReleaseKeyAt(0)).toBe('release');
    expect(afterReleaseKeyAt(3 * F)).toBe('release');
    expect(afterReleaseKeyAt(4 * F)).toBe('follow');
    expect(afterReleaseKeyAt(15 * F)).toBe('follow');
    expect(afterReleaseKeyAt(16 * F)).toBe('field');
    expect(afterReleaseKeyAt(5)).toBe('field');
  });

  it('走者が走り出せるのは投手が本塁へ踏み出す絵（44フレーム目）から', () => {
    expect(STEAL_GO_SEC / F).toBeCloseTo(44, 9);
    expect(windupKeyAt(STEAL_GO_SEC)).toBe('back');
  });
});

describe('スイングの時間割（原作：3フレームずつ5枚・振り切りで41フレーム・2フレームずつ戻る）', () => {
  it('1枚3フレーム／振り切り41フレーム／戻り2フレーム', () => {
    expect(SWING_KEY_SEC / F).toBeCloseTo(3, 9);
    expect(SWING_FINISH_HOLD_SEC / F).toBeCloseTo(41, 9);
    expect(SWING_RETURN_KEY_SEC / F).toBeCloseTo(2, 9);
  });

  it('当たる絵（本塁の上で水平）は判定の芯の時刻から始まる＝ちょうどで当たれば必ずこの絵', () => {
    expect(SWING_CONTACT_KEY_FROM).toBe(SWING_IDEAL_SEC);
    expect(swingKeyAt(SWING_IDEAL_SEC)).toBe('contact');
    // 振り遅れ（早く当たる＝流し打ち）は手前の絵、引っ張り（遅く当たる）は当たる絵のまま
    expect(swingKeyAt(SWING_IDEAL_SEC - SWING_ACTIVE_SEC / 2 + 0.001)).toBe('lag');
    expect(swingKeyAt(SWING_IDEAL_SEC + SWING_ACTIVE_SEC / 2 - 0.001)).toBe('contact');
  });

  it('順番どおりに切り替わる（構え→寝かせる→斜め下→水平→斜め上→肩越し→逆順→構え）', () => {
    const seen: string[] = [];
    for (let t = -F; t <= SWING_TOTAL_SEC + F; t += F / 4) {
      const k = swingKeyAt(t);
      if (seen[seen.length - 1] !== k) seen.push(k);
    }
    expect(seen).toEqual([
      'stance',
      'load',
      'lag',
      'contact',
      'follow',
      'finish',
      'follow',
      'contact',
      'lag',
      'load',
      'stance',
    ]);
  });

  it('振り出しから振り切った形まで12フレーム弱・構えへ戻り切るまで約1秒（原作 12f / 61f）', () => {
    expect(SWING_FINISH_FROM / F).toBeGreaterThan(11);
    expect(SWING_FINISH_FROM / F).toBeLessThan(12.5);
    expect(SWING_RETURN_FROM - SWING_FINISH_FROM).toBeCloseTo(SWING_FINISH_HOLD_SEC, 12);
    expect(SWING_TOTAL_SEC / F).toBeGreaterThan(59);
    expect(SWING_TOTAL_SEC / F).toBeLessThan(62);
    expect(swingKeyAt(SWING_TOTAL_SEC + F)).toBe('stance');
  });
});
