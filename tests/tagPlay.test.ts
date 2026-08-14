/**
 * フォースプレーとタッチプレー（フェーズK-31。説明書p32「実際の野球のルール」）。
 *
 * J-30 が「送球速度を触ってもランダンの帯は開かない」と結論した後に残っていた別の入口＝
 * **そもそも塁へ投げるだけで誰でも刺せるのがおかしい**。実際の野球で塁を踏むだけで
 * アウトになるのは打者走者に押し出されて走る義務がある走者だけで、それ以外はタッチが要る。
 *
 * このファイルが固定するのは4つ：
 * 1. どの区間がフォースプレーか（`isForcePlay`）
 * 2. 送球だけで刺せるのはどの走者か（`throwRetiresRunner`）
 * 3. **走り続ける限り帰結は変わらない**という構造上の根拠（タッチ半径 > 塁の到達半径）
 * 4. 「前へ行けば刺されるが**戻れば助かる**」帯の広さ＝K-31で新しく生まれる走者の判断
 *    （I-29の方針「測った結果は帯としてテストに固定する」。J-30のランダンの帯0.0%と対照）
 */
import { describe, expect, it } from 'vitest';
import {
  BASE_ARRIVE_RADIUS,
  BASE_POSITIONS,
  RUNNER_SPEED,
  RUNNER_SPEED_MAX,
  RUNNER_SPEED_MIN,
  TAG_RADIUS,
  THROW_SPEED,
  type Vec2,
  advancedBase,
  canTagByRunning,
  distance,
  forcedRunners,
  isForcePlay,
  throwRetiresRunner,
} from '../src/core/fielding';
import type { Bases } from '../src/core/rules';

const EMPTY: Bases = { first: false, second: false, third: false };

// ---- 1. どの区間がフォースプレーか ----

describe('isForcePlay（塁を踏まれるだけでアウトになる区間）', () => {
  it('打者走者は常にフォース（一塁へ走る義務がある）', () => {
    const forced = forcedRunners(EMPTY);
    expect(isForcePlay({ from: 'batter', to: 'first' }, forced)).toBe(true);
  });

  it('一塁走者は打者が一塁に入るので常にフォース', () => {
    const forced = forcedRunners({ ...EMPTY, first: true });
    expect(isForcePlay({ from: 'first', to: 'second' }, forced)).toBe(true);
  });

  it('二塁走者は一塁が埋まっているときだけフォース（＝押し出されるときだけ）', () => {
    expect(
      isForcePlay({ from: 'second', to: 'third' }, forcedRunners({ ...EMPTY, second: true })),
    ).toBe(false);
    expect(
      isForcePlay(
        { from: 'second', to: 'third' },
        forcedRunners({ ...EMPTY, first: true, second: true }),
      ),
    ).toBe(true);
  });

  it('三塁走者は満塁のときだけフォース（本塁で刺せる）', () => {
    expect(
      isForcePlay(
        { from: 'third', to: 'home' },
        forcedRunners({ first: true, second: true, third: true }),
      ),
    ).toBe(true);
    expect(
      isForcePlay({ from: 'third', to: 'home' }, forcedRunners({ ...EMPTY, third: true })),
    ).toBe(false);
  });

  it('帰塁の区間（行き先が起点そのもの）はフォースの一覧に載らない＝タッチが要る', () => {
    const forced = forcedRunners({ ...EMPTY, first: true });
    expect(isForcePlay({ from: 'first', to: 'first' }, forced)).toBe(false);
  });

  it('走塁だけのプレー（けん制・盗塁）は押し出しが無いので全員タッチプレー', () => {
    // 打者走者がいない＝誰にも走る義務が無い。盗塁の二塁も、けん制の帰塁も、
    // 塁へ投げただけではアウトにならない（塁で待つ野手のタッチが要る）。
    for (const from of ['first', 'second', 'third'] as const) {
      expect(isForcePlay({ from, to: advancedBase(from) }, [])).toBe(false);
    }
  });
});

// ---- 2. 送球だけで刺せるのはどの走者か ----

describe('throwRetiresRunner（その塁への送球だけで刺せるか）', () => {
  it('フォースプレーなら、塁へ向かっていなくても塁を踏めばアウト', () => {
    expect(throwRetiresRunner(true, false)).toBe(true);
  });

  it('タッチプレーでも、その塁へ向かって走っているなら結果は同じ（塁で待つ野手に触れられる）', () => {
    expect(throwRetiresRunner(false, true)).toBe(true);
  });

  it('タッチプレーで塁から遠ざかって止まっている走者だけは、投げても刺せない', () => {
    // バイクで塁を行き過ぎた走者（F-26-3）がこれ。**この守備モデルで唯一
    // 「走って追うしかない」場面**で、走者側のドロップキック（F-26-4）が意味を持つ局面。
    expect(throwRetiresRunner(false, false)).toBe(false);
  });
});

// ---- 3. 走り続ける限り帰結は変わらない（構造上の根拠） ----

describe('タッチプレーにしても帰結が変わらない理由', () => {
  it('タッチ半径は塁の到達半径より広い＝走り続ける走者は塁に着く前に必ずタッチ圏を通る', () => {
    // ここが逆転すると「送球が先に着いたのにタッチできないまま塁に入られる」が起き、
    // A-6のけん制の境界（4.3m）もA-7の盗塁の窓（0.45秒）も静かに壊れる。
    expect(TAG_RADIUS).toBeGreaterThan(BASE_ARRIVE_RADIUS);
  });

  it('止まっている走者は必ず追いつかれる（オーバーランがタッチで決着する根拠）', () => {
    // canTagByRunning は速さ0の走者を「必ず追いつかれる」と扱う。投げても刺せない走者が
    // 永久に安全になってしまう（＝プレーが終わらない）ことを、この性質が防いでいる。
    expect(
      canTagByRunning({ x: 0, z: -60 }, { pos: BASE_POSITIONS.second, target: BASE_POSITIONS.second, speed: 0 }),
    ).toBe(true);
  });
});

// ---- 4. 「戻れば助かる」帯の広さ（計測の固定） ----

/** 走者が塁間を進む刻み（`tools/balance/rundown.ts` と同じ） */
const PROGRESS_STEPS = 20;

function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

/**
 * フィールドを格子で舐めて、走者の帰結を3つに分ける（`npm run balance:rundown` の3段目と
 * 同じ計算）。守備は走者の選択に即応できるものとして見るので、走者が助かるのは
 * 「送球より先に踏める塁が1つでもある」ときだけ。
 */
function tally(runnerSpeed: number): { safeAhead: number; savedByRetreat: number; caught: number } {
  const t = { safeAhead: 0, savedByRetreat: 0, caught: 0 };
  for (const from of ['first', 'second', 'third'] as const) {
    const behind = BASE_POSITIONS[from];
    const ahead = BASE_POSITIONS[advancedBase(from)];
    for (let s = 1; s <= PROGRESS_STEPS; s += 1) {
      const runner = lerp(behind, ahead, s / PROGRESS_STEPS);
      for (let x = -60; x <= 60; x += 4) {
        for (let z = 0; z >= -110; z -= 4) {
          const carrier = { x, z };
          if (Math.abs(x) > Math.abs(z) + 5) continue;
          const caught = (to: Vec2): boolean =>
            distance(carrier, to) / THROW_SPEED < distance(runner, to) / runnerSpeed ||
            canTagByRunning(carrier, { pos: runner, target: to, speed: runnerSpeed });
          if (!caught(ahead)) t.safeAhead += 1;
          else if (!caught(behind)) t.savedByRetreat += 1;
          else t.caught += 1;
        }
      }
    }
  }
  return t;
}

describe('「戻れば助かる」帯（計測の結論。K-31）', () => {
  it('帯は空ではない＝K-31で走者に本物の判断が生まれる（J-30のランダンの帯0%と対照）', () => {
    const t = tally(RUNNER_SPEED);
    const total = t.safeAhead + t.savedByRetreat + t.caught;
    const ratio = t.savedByRetreat / total;
    // 値そのものではなく帯で固定する（無関係な定数を動かすたびに落ちないように）。
    // 実測は 28.6%（走力7.5）。
    expect(ratio).toBeGreaterThan(0.2);
    expect(ratio).toBeLessThan(0.4);
  });

  it('足が速いほど「前へ行けば安全」が増え、引き返しに頼る場面は減る', () => {
    const slow = tally(RUNNER_SPEED_MIN);
    const fast = tally(RUNNER_SPEED_MAX);
    expect(fast.safeAhead).toBeGreaterThan(slow.safeAhead);
    expect(fast.savedByRetreat).toBeLessThan(slow.savedByRetreat);
  });

  it('どの走力でも「戻れば助かる」場面は実在する（能力値で消えたりしない）', () => {
    for (const speed of [RUNNER_SPEED_MIN, RUNNER_SPEED, RUNNER_SPEED_MAX]) {
      expect(tally(speed).savedByRetreat).toBeGreaterThan(0);
    }
  });
});
