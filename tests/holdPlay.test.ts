/**
 * 塁間で止まる（フェーズN-34。説明書p25の挟殺の「逃げる側」の3つ目の手）。
 *
 * K-31 が「行くか戻るか」を作った後も、**前へ行っても戻っても刺される**場面
 * （`npm run balance:rundown` の3段目「どちらも×」＝走力7.5で20.8%）には手が1つも
 * 無かった。止まれると、非フォースの走者には塁への送球が効かなくなる（K-31の
 * `throwRetiresRunner`）ので、守備は走って追うしかなくなる。
 *
 * このファイルが固定するのは4つ：
 * 1. **J が何を意味するか**（`chooseRunnerCommand`）＝L-32までの帰結が変わらないこと
 * 2. 止まった走者に送球が効かないこと（K-31の関数の使われ方）
 * 3. CPUの規則（`shouldCpuHold` / `chooseCpuHoldRelease`）が決定的で、必ず決着すること
 * 4. **止まって稼げる時間の帯**＝N-34で新しく生まれる判断の広さ
 *    （I-29の方針「測った結果は帯としてテストに固定する」）
 */
import { describe, expect, it } from 'vitest';
import {
  BASE_PATH,
  BASE_POSITIONS,
  FIELDER_SPEED,
  RUNNER_SPEED,
  RUNNER_SPEED_MAX,
  RUNNER_SPEED_MIN,
  TAG_RADIUS,
  THROW_SPEED,
  type RunningLeg,
  type Vec2,
  advancedBase,
  canTagByRunning,
  chooseCpuHoldRelease,
  chooseRunnerCommand,
  distance,
  shouldCpuHold,
  throwRetiresRunner,
} from '../src/core/fielding';

const ahead = BASE_POSITIONS.second;
const behind = BASE_POSITIONS.first;

function midway(t: number): Vec2 {
  return { x: behind.x + (ahead.x - behind.x) * t, z: behind.z + (ahead.z - behind.z) * t };
}

function leg(over: Partial<RunningLeg> = {}): RunningLeg {
  return { from: 'first', to: 'second', holding: false, canHold: true, ...over };
}

// ---- 1. J が何を意味するか（操作） ----

describe('chooseRunnerCommand（Jはまず「走れ」、走れる走者がいないときだけ「止まれ」）', () => {
  it('仕掛けられる走者がいれば従来どおり発進（L-32の帰結は1つも変わらない）', () => {
    // 走っている走者が同時にいても、発進が先に効く＝止まる操作は既存の操作を奪わない
    expect(chooseRunnerCommand(['first'], [leg({ from: 'second', to: 'third' })], null)).toEqual({
      kind: 'send',
      from: ['first'],
    });
  });

  it('無指定の発進は走れる走者が全員（L-32のダブルスチールと同じ規則）', () => {
    expect(chooseRunnerCommand(['second', 'first'], [], null)).toEqual({
      kind: 'send',
      from: ['second', 'first'],
    });
  });

  it('仕掛けられる走者がいなければ、走っている走者が止まる', () => {
    expect(chooseRunnerCommand([], [leg()], null)).toEqual({ kind: 'hold', from: ['first'] });
  });

  it('止まっている走者がいれば、止めるより先に再スタートする', () => {
    const command = chooseRunnerCommand([], [leg({ holding: true }), leg({ from: 'second', to: 'third' })], null);
    expect(command).toEqual({ kind: 'resume', from: ['first'] });
  });

  it('塁を指定すればその塁へ向かっている走者だけが対象（送球・帰塁の塁指定と同じ）', () => {
    const running = [leg(), leg({ from: 'second', to: 'third' })];
    expect(chooseRunnerCommand([], running, 'third')).toEqual({ kind: 'hold', from: ['second'] });
    expect(chooseRunnerCommand([], running, 'second')).toEqual({ kind: 'hold', from: ['first'] });
  });

  it('指定した塁に該当者がいなければ何も起きない（既存の「空振り」の扱い）', () => {
    expect(chooseRunnerCommand([], [leg()], 'home')).toBeNull();
  });

  it('1プレーに1回だけ＝もう止まった走者は止まれない', () => {
    expect(chooseRunnerCommand([], [leg({ canHold: false })], null)).toBeNull();
  });

  it('打者走者も対象（ユーザー判断：全員一律）', () => {
    expect(chooseRunnerCommand([], [leg({ from: 'batter', to: 'first' })], null)).toEqual({
      kind: 'hold',
      from: ['batter'],
    });
  });

  it('同じ入力からは必ず同じ結果（決定的）', () => {
    const running = [leg(), leg({ from: 'second', to: 'third', holding: true })];
    const first = chooseRunnerCommand([], running, null);
    for (let i = 0; i < 5; i += 1) expect(chooseRunnerCommand([], running, null)).toEqual(first);
  });
});

// ---- 2. 止まると送球が効かない（K-31の規則がそのまま効く） ----

describe('止まった走者と送球', () => {
  it('非フォースの走者が止まれば、塁へ投げても刺せない（＝守備は走って追うしかない）', () => {
    expect(throwRetiresRunner(false, false)).toBe(false);
  });

  it('フォース走者は止まっても塁へ投げられれば刺される＝内野ゴロの帰結は変わらない', () => {
    expect(throwRetiresRunner(true, false)).toBe(true);
  });

  it('止まっている走者は走って追えば必ず触れる＝止まったままプレーが宙に浮かない', () => {
    expect(
      canTagByRunning({ x: 0, z: -60 }, { pos: midway(0.5), target: ahead, speed: 0 }),
    ).toBe(true);
  });
});

// ---- 3. CPUの規則 ----

describe('shouldCpuHold（CPU走者が止まる規則）', () => {
  const caughtEitherWay = {
    // 走者のすぐ横に野手がいる＝どちらへ走っても刺される（`shouldCpuRetreat` が false を返す残り）
    carrier: midway(0.5),
    runner: midway(0.5),
    ahead,
    behind,
    speed: RUNNER_SPEED,
  };

  it('進んでも戻っても刺されるなら止まる（K-31の引き返しが手を持たない場面）', () => {
    expect(shouldCpuHold({ ...caughtEitherWay, helpsOtherRunners: true })).toBe(true);
  });

  it('他に走っている走者がいなければ止まらない（止まっても本人は助からないため）', () => {
    expect(shouldCpuHold({ ...caughtEitherWay, helpsOtherRunners: false })).toBe(false);
  });

  it('進めば助かるなら止まらない（塁に着くほうが常に良い）', () => {
    expect(
      shouldCpuHold({
        carrier: { x: 0, z: -110 },
        runner: midway(0.5),
        ahead,
        behind,
        speed: RUNNER_SPEED,
        helpsOtherRunners: true,
      }),
    ).toBe(false);
  });

  it('戻れば助かるなら止まらない（引き返しの規則が先に効く場面を奪わない）', () => {
    expect(
      shouldCpuHold({
        carrier: { x: ahead.x + 1, z: ahead.z + 1 },
        runner: midway(0.1),
        ahead,
        behind,
        speed: RUNNER_SPEED,
        helpsOtherRunners: true,
      }),
    ).toBe(false);
  });

  it('同じ状況からは必ず同じ判断（決定的）', () => {
    const opts = { ...caughtEitherWay, helpsOtherRunners: true };
    const first = shouldCpuHold(opts);
    for (let i = 0; i < 5; i += 1) expect(shouldCpuHold(opts)).toBe(first);
  });
});

describe('chooseCpuHoldRelease（止まったCPU走者が走り出す規則）', () => {
  const stuck = {
    carrier: midway(0.5),
    runner: midway(0.5),
    ahead,
    behind,
    speed: RUNNER_SPEED,
  };

  it('稼ぐ相手がいる間は止まったまま', () => {
    expect(chooseCpuHoldRelease({ ...stuck, canRetreat: true, helpsOtherRunners: true })).toBeNull();
  });

  it('時間を稼ぐ相手がいなくなったら必ず走り出す（プレーが宙に浮かないための保証）', () => {
    expect(chooseCpuHoldRelease({ ...stuck, canRetreat: true, helpsOtherRunners: false })).toBe(
      'ahead',
    );
  });

  it('守備が離れて進めるようになったら前へ走る', () => {
    expect(
      chooseCpuHoldRelease({
        carrier: { x: 0, z: -110 },
        runner: midway(0.5),
        ahead,
        behind,
        speed: RUNNER_SPEED,
        canRetreat: true,
        helpsOtherRunners: true,
      }),
    ).toBe('ahead');
  });

  it('戻れば助かるなら戻る。ただし1プレーに1回の引き返しを使い切っていたら戻らない', () => {
    const opts = {
      carrier: { x: ahead.x + 1, z: ahead.z + 1 },
      runner: midway(0.1),
      ahead,
      behind,
      speed: RUNNER_SPEED,
      helpsOtherRunners: true,
    };
    expect(chooseCpuHoldRelease({ ...opts, canRetreat: true })).toBe('behind');
    expect(chooseCpuHoldRelease({ ...opts, canRetreat: false })).toBeNull();
  });
});

// ---- 4. 止まって稼げる時間の帯（計測の固定） ----

/** 走者が塁間を進む刻み（`tools/balance/rundown.ts` と同じ） */
const PROGRESS_STEPS = 20;

function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

/**
 * 「どちらも×」の場面（＝止まる以外に手が無い場面）だけを舐めて、止まると何が変わるかを
 * 数える（`npm run balance:rundown` の4段目と同じ計算）。
 */
function tally(runnerSpeed: number): { cases: number; gains: number; fullBase: number } {
  const t = { cases: 0, gains: 0, fullBase: 0 };
  for (const from of ['first', 'second', 'third'] as const) {
    const back = BASE_POSITIONS[from];
    const next = BASE_POSITIONS[advancedBase(from)];
    for (let s = 1; s <= PROGRESS_STEPS; s += 1) {
      const runner = lerp(back, next, s / PROGRESS_STEPS);
      for (let x = -60; x <= 60; x += 4) {
        for (let z = 0; z >= -110; z -= 4) {
          const carrier = { x, z };
          if (Math.abs(x) > Math.abs(z) + 5) continue;
          const caught = (to: Vec2): boolean =>
            distance(carrier, to) / THROW_SPEED < distance(runner, to) / runnerSpeed ||
            canTagByRunning(carrier, { pos: runner, target: to, speed: runnerSpeed });
          if (!caught(next) || !caught(back)) continue;
          t.cases += 1;
          // 走り続ければ塁に着いた瞬間タッチされる／止まれば野手が走って来るまで生きている
          const keepGoing = distance(runner, next) / runnerSpeed;
          const held = Math.max(0, (distance(carrier, runner) - TAG_RADIUS) / FIELDER_SPEED);
          const gained = held - keepGoing;
          if (gained <= 0) continue;
          t.gains += 1;
          if (gained * runnerSpeed >= BASE_PATH) t.fullBase += 1;
        }
      }
    }
  }
  return t;
}

describe('止まって稼げる時間の帯（計測の結論。N-34）', () => {
  it('帯は空ではない＝「どちらも×」の場面の大半で、止まれば時間が稼げる', () => {
    const t = tally(RUNNER_SPEED);
    const ratio = t.gains / t.cases;
    // 値そのものではなく帯で固定する（実測は 72.0%／走力7.5）
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(0.9);
  });

  it('他の走者が塁を1つ進めるほど稼げる場面も実在する（挟殺の値打ちそのもの）', () => {
    // 実測は 27.8%（走力7.5。野手の足を原作の 6.0m/s にした BBB-82 から＝それまでの 8.5m/s では
    // 6.6%）。**1人を差し出して1つ進める**という判断が成立する場面。野手が遅いぶん、止まった
    // 走者へ寄るのに時間が掛かる＝止まる値打ちは上がったが、大半の場面ではまだ塁1つに届かない。
    const t = tally(RUNNER_SPEED);
    expect(t.fullBase).toBeGreaterThan(0);
    expect(t.fullBase / t.cases).toBeLessThan(0.4);
  });

  it('どの走力でも成立する（能力値で消えたりしない）', () => {
    for (const speed of [RUNNER_SPEED_MIN, RUNNER_SPEED, RUNNER_SPEED_MAX]) {
      expect(tally(speed).gains).toBeGreaterThan(0);
    }
  });
});
