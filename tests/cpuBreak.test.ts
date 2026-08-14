/**
 * CPU投手の変化球（フェーズP-37）。
 *
 * それまでCPUの球は**必ず直線**で、R/L も（O-35で繋いだ）F も CPU の球には一切
 * 効かなかった＝96人ぶんの変化量が、人間が投手側に回ったときしか生きていなかった
 * （CLAUDE.md ⑧「CPUも対等」に残っていた最後の構造的な穴）。
 *
 * ここが守るのは4つ：
 *
 * 1. **狙ったコースへ届く**（逆算が正しい）。フレームレートを変えても動かない。
 * 2. **本塁通過位置は従来と1つも変わらない**＝I-29で測った打たれ方の分布を動かしていない。
 * 3. **打者に当たりようがない**（bang-bang制御を退けた理由＝死球ゾーンへの暴走が
 *    構造的に起きないこと）。
 * 4. **名鑑の変化量が球の差になる**（R/L と F が実際に効く）。
 */
import { describe, expect, it } from 'vitest';
import {
  CPU_BREAK_STEER_SEC,
  type CpuPitchShape,
  chooseCpuPitchPlan,
  cpuSteerAccelAt,
  planCpuPitchShape,
} from '../src/core/cpuPitcher';
import {
  BATTER_ZONE_MIN_X,
  NEUTRAL_PITCH_PROFILE,
  type PitchProfile,
  RUBBER_HALF_RANGE,
  STRIKE_ZONE_HALF_WIDTH,
  createPitchFlight,
  fatiguedBreak,
  judgePitch,
  plateCrossingX,
  stepPitchFlight,
} from '../src/core/pitch';
import type { Count } from '../src/core/rules';
import { TEAMS, pitcherRowPitching } from '../src/core/teams';

/** `chooseCpuPitchPlan` が返しうる方針をすべて含むカウント一覧 */
const COUNTS: readonly Count[] = [
  { balls: 0, strikes: 0 },
  { balls: 1, strikes: 0 },
  { balls: 2, strikes: 1 },
  { balls: 0, strikes: 2 },
  { balls: 1, strikes: 2 },
  { balls: 3, strikes: 1 },
];

const profileWith = (breakAmount: number, over: Partial<PitchProfile> = {}): PitchProfile => ({
  ...NEUTRAL_PITCH_PROFILE,
  breakLeft: breakAmount,
  breakRight: breakAmount,
  fork: breakAmount,
  ...over,
});

/** 名鑑96人（実データでも成り立つことを確かめるため） */
const ROSTER_PROFILES: readonly PitchProfile[] = TEAMS.flatMap((t) =>
  t.pitchers.map((r) => {
    const s = pitcherRowPitching(r);
    return { speed: s.speed, breakLeft: s.breakLeft, breakRight: s.breakRight, fork: s.fork };
  }),
);

/** シーン層（dekkaiScene.ts の flight フェーズ）と同じ回し方で1球飛ばす */
function fly(shape: CpuPitchShape, fps = 60): { cross: number; maxAbsX: number } {
  const dt = 1 / fps;
  let flight = createPitchFlight(shape.releaseX, shape.speed, 0);
  let sinceRelease = 0;
  let maxAbsX = Math.abs(flight.x);
  for (let i = 0; i < 1000; i += 1) {
    const accel = cpuSteerAccelAt(shape, sinceRelease, dt);
    const next = stepPitchFlight(flight, shape.steerX, dt, accel);
    sinceRelease += dt;
    maxAbsX = Math.max(maxAbsX, Math.abs(next.x));
    const cross = plateCrossingX(flight, next);
    if (cross !== null) return { cross, maxAbsX };
    flight = next;
  }
  throw new Error('本塁を通過しなかった（テストの前提が崩れている）');
}

describe('planCpuPitchShape: 逆算（曲げても狙ったコースへ届く）', () => {
  it('どのカウント・どの変化量でも本塁通過位置は狙いどおり', () => {
    for (const count of COUNTS) {
      const plan = chooseCpuPitchPlan(count);
      for (const breakAmount of [0, 0.5, 1]) {
        const shape = planCpuPitchShape(plan, profileWith(breakAmount));
        // 誤差はオイラー積分の離散化のぶんだけ（隅の上乗せ0.05mよりずっと小さい）
        expect(Math.abs(fly(shape).cross - plan.targetX)).toBeLessThan(0.03);
      }
    }
  });

  it('フレームレートが変わっても狙いは動かない（力積を割合で与えているため）', () => {
    const plan = chooseCpuPitchPlan({ balls: 0, strikes: 1 });
    const shape = planCpuPitchShape(plan, profileWith(1));
    for (const fps of [30, 45, 60, 90, 144]) {
      expect(Math.abs(fly(shape, fps).cross - plan.targetX)).toBeLessThan(0.03);
    }
  });

  it('名鑑96人の誰が投げても狙いどおりに届く', () => {
    for (const profile of ROSTER_PROFILES) {
      for (const count of COUNTS) {
        const plan = chooseCpuPitchPlan(count);
        const shape = planCpuPitchShape(plan, profile);
        expect(Math.abs(fly(shape).cross - plan.targetX)).toBeLessThan(0.03);
      }
    }
  });

  it('狙うコースそのものは従来と1つも変わらない（I-29の打たれ方の分布を動かしていない）', () => {
    // 変えたのは「どこから投げるか」だけ。`chooseCpuPitchPlan` は1行も触っていない。
    for (const count of COUNTS) {
      const plan = chooseCpuPitchPlan(count);
      expect(planCpuPitchShape(plan, profileWith(1)).speed).toBe(
        planCpuPitchShape(plan, profileWith(0)).speed,
      );
      expect(fly(planCpuPitchShape(plan, profileWith(1))).cross).toBeCloseTo(
        fly(planCpuPitchShape(plan, profileWith(0))).cross,
        1,
      );
    }
  });
});

describe('planCpuPitchShape: 曲げる向き（ユーザー判断：狙うコース側へ）', () => {
  it('狙いが内なら内へ、外なら外へ曲げる（反対側から入ってくる）', () => {
    const inside = chooseCpuPitchPlan({ balls: 0, strikes: 0 }); // targetX > 0
    const outside = chooseCpuPitchPlan({ balls: 1, strikes: 0 }); // targetX < 0
    expect(planCpuPitchShape(inside).steerX).toBe(1);
    expect(planCpuPitchShape(outside).steerX).toBe(-1);
  });

  it('リリース位置は狙いの反対側になる（＝立ち位置が打者への手がかりになる）', () => {
    const plan = chooseCpuPitchPlan({ balls: 0, strikes: 0 });
    const shape = planCpuPitchShape(plan);
    expect(shape.releaseX).toBeLessThan(plan.targetX);
    expect(shape.breakWidth).toBeCloseTo(Math.abs(plan.targetX - shape.releaseX), 10);
  });

  it('ど真ん中狙い（3ボール後の四球回避）は曲げない＝追い込まれたCPUは素直な球', () => {
    const plan = chooseCpuPitchPlan({ balls: 3, strikes: 1 });
    const shape = planCpuPitchShape(plan, profileWith(1));
    expect(plan.targetX).toBe(0);
    expect(shape.steerX).toBe(0);
    expect(shape.breakWidth).toBe(0);
    expect(shape.steerSec).toBe(0);
  });

  it('リリース位置は必ずプレートの上（曲がりのほうが削られる）', () => {
    for (const profile of ROSTER_PROFILES) {
      for (const count of COUNTS) {
        const shape = planCpuPitchShape(chooseCpuPitchPlan(count), profile);
        expect(Math.abs(shape.releaseX)).toBeLessThanOrEqual(RUBBER_HALF_RANGE + 1e-9);
      }
    }
  });
});

describe('planCpuPitchShape: 名鑑の変化量が球の差になる（このセッションの目的）', () => {
  const slow = chooseCpuPitchPlan({ balls: 0, strikes: 1 }); // speed: 'slow'＝フォーク
  const fast = chooseCpuPitchPlan({ balls: 0, strikes: 0 }); // speed: 'fast'

  it('変化量が大きいほど大きく曲がる（単調）', () => {
    const widths = [0, 0.25, 0.5, 0.75, 1].map(
      (r) => planCpuPitchShape(fast, profileWith(r)).breakWidth,
    );
    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i]).toBeGreaterThan(widths[i - 1]);
    }
  });

  it('遅い球（フォーク）は F を使う＝Fを上げるとフォークだけ曲がりが増える', () => {
    const low = profileWith(0.5, { fork: 0.2 });
    const high = profileWith(0.5, { fork: 0.9 });
    expect(planCpuPitchShape(slow, high).breakWidth).toBeGreaterThan(
      planCpuPitchShape(slow, low).breakWidth,
    );
    // 速球側は R/L で決まるので F を動かしても1mmも変わらない（O-35の切り分けのまま）
    expect(planCpuPitchShape(fast, high).breakWidth).toBeCloseTo(
      planCpuPitchShape(fast, low).breakWidth,
      10,
    );
  });

  it('曲げる向きで R と L を使い分ける（カーブは大きいがシュートは小さい投手が作れる）', () => {
    const profile = profileWith(0.5, { breakRight: 0.9, breakLeft: 0.1 });
    const inside = planCpuPitchShape(chooseCpuPitchPlan({ balls: 0, strikes: 0 }), profile);
    const outside = planCpuPitchShape(chooseCpuPitchPlan({ balls: 1, strikes: 0 }), profile);
    expect(inside.steerX).toBe(1);
    expect(outside.steerX).toBe(-1);
    expect(inside.breakWidth).toBeGreaterThan(outside.breakWidth);
  });

  it('疲れたCPU投手は曲がりも落ちる（B-11の「変化量は下限まで」がそのまま効く）', () => {
    const fresh = profileWith(0.9);
    const tired: PitchProfile = {
      ...fresh,
      breakLeft: fatiguedBreak(fresh.breakLeft, 1),
      breakRight: fatiguedBreak(fresh.breakRight, 1),
      fork: fatiguedBreak(fresh.fork, 1),
    };
    expect(planCpuPitchShape(slow, tired).breakWidth).toBeLessThan(
      planCpuPitchShape(slow, fresh).breakWidth,
    );
  });

  it('名鑑96人の誰もプレートの幅で頭打ちにならない（採用値 0.06秒の根拠）', () => {
    // 頭打ちになった投手はそこで差が消える＝「Fの高い投手」の値打ちが無くなる。
    // `npm run balance:cpubreak` の3段目：0.08秒なら8人、0.10秒なら34人が張り付く。
    const budget = Math.abs(slow.targetX) + RUBBER_HALF_RANGE;
    for (const profile of ROSTER_PROFILES) {
      expect(planCpuPitchShape(slow, profile).breakWidth).toBeLessThan(budget);
    }
  });
});

describe('planCpuPitchShape: 打者に理不尽でないこと', () => {
  it('球は飛行の2割以内で曲がり終わる（判断する時点ではもう直線）', () => {
    // スイングは接触の0.09秒前に押す必要があり、人の反応を足すと判断は0.25秒ほど前。
    // そこまでに曲がり終わっていれば「見てから振る」は従来どおり成立する
    // （桜井ノウハウ「人に反応できない動作をするとすっごい理不尽感がある」）。
    for (const profile of ROSTER_PROFILES) {
      for (const count of COUNTS) {
        const shape = planCpuPitchShape(chooseCpuPitchPlan(count), profile);
        expect(shape.steerSec).toBeLessThanOrEqual(CPU_BREAK_STEER_SEC + 1e-9);
        expect(shape.steerSec).toBeLessThan(shape.flightSec * 0.2);
      }
    }
  });

  it('飛行中いちども死球ゾーンへ入らない（bang-bang制御を退けた理由そのもの）', () => {
    for (const profile of ROSTER_PROFILES) {
      for (const count of COUNTS) {
        const plan = chooseCpuPitchPlan(count);
        const shape = planCpuPitchShape(plan, profile);
        const { cross, maxAbsX } = fly(shape);
        expect(maxAbsX).toBeLessThan(BATTER_ZONE_MIN_X);
        // 左右どちらの打席でも死球にならない（死球ゾーンは打者と一緒に動く＝B-9）
        expect(judgePitch(cross, 1)).not.toBe('hitByPitch');
        expect(judgePitch(cross, -1)).not.toBe('hitByPitch');
      }
    }
  });

  it('曲がりはゾーン半幅と同じ桁（見えるが、荒唐無稽ではない）', () => {
    // `npm run balance:cpubreak`：名鑑96人でフォーク 0.48〜0.89m・速球 0.25〜0.44m。
    const widths = ROSTER_PROFILES.map(
      (p) => planCpuPitchShape(chooseCpuPitchPlan({ balls: 0, strikes: 1 }), p).breakWidth,
    );
    expect(Math.min(...widths)).toBeGreaterThan(STRIKE_ZONE_HALF_WIDTH * 0.8);
    expect(Math.max(...widths)).toBeLessThan(STRIKE_ZONE_HALF_WIDTH * 2.5);
  });
});

describe('cpuSteerAccelAt: 与える力積はフレームの切れ目に左右されない', () => {
  const shape = planCpuPitchShape(chooseCpuPitchPlan({ balls: 0, strikes: 2 }), profileWith(0.8));

  it('倒している間ずっと同じ加速度、終わったら0', () => {
    expect(cpuSteerAccelAt(shape, 0, 1 / 240)).toBeCloseTo(shape.steerAccel, 10);
    expect(cpuSteerAccelAt(shape, shape.steerSec + 0.01, 1 / 240)).toBe(0);
  });

  it('終わりがフレームの途中に来ても、合計の力積は a×ts のまま', () => {
    for (const fps of [24, 30, 47, 60, 120]) {
      const dt = 1 / fps;
      let sum = 0;
      for (let i = 0; i < 200; i += 1) sum += cpuSteerAccelAt(shape, i * dt, dt) * dt;
      expect(sum).toBeCloseTo(shape.steerAccel * shape.steerSec, 10);
    }
  });

  it('曲げない球には何も与えない', () => {
    const straight = planCpuPitchShape(chooseCpuPitchPlan({ balls: 3, strikes: 0 }), profileWith(1));
    expect(cpuSteerAccelAt(straight, 0, 1 / 60)).toBe(0);
  });
});
