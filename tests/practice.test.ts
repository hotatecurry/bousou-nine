import { describe, expect, it } from 'vitest';
import { createActor } from 'xstate';
import {
  INITIAL_KNOCK,
  KNOCK_DIRECTIONS,
  KNOCK_KINDS,
  KNOCK_RUNNER_PATTERNS,
  PRACTICE_MODES,
  cycleKnock,
  knockLabel,
  knockLaunch,
  practiceHudLines,
  practiceHumanSide,
} from '../src/debug/practice';
import { DEFAULT_BALLPARK } from '../src/core/ballpark';
import { stepBattedBall } from '../src/core/batting';
import { gameMachine } from '../src/core/gameMachine';
import { TEAMS } from '../src/core/teams';

/** その打球が止まる（またはフェンスを越える）まで飛ばして、着地点までの距離を測る */
function fly(setup: typeof INITIAL_KNOCK): {
  distance: number;
  apex: number;
  over: boolean;
  landingDeg: number;
} {
  let ball = knockLaunch(setup);
  let apex = ball.y;
  for (let i = 0; i < 2000 && !ball.resting; i += 1) {
    ball = stepBattedBall(ball, 1 / 60, DEFAULT_BALLPARK);
    apex = Math.max(apex, ball.y);
  }
  const landing = ball.landing ?? { x: ball.x, z: ball.z };
  return {
    distance: Math.hypot(landing.x, landing.z),
    apex,
    over: ball.over !== null,
    landingDeg: (Math.atan2(landing.x, -landing.z) * 180) / Math.PI,
  };
}

describe('デバッグモードの入口（フェーズPP-64）', () => {
  it('3つのモードが並ぶ（投球・打撃・守備）', () => {
    expect(PRACTICE_MODES.map((m) => m.id)).toEqual(['pitch', 'bat', 'field']);
  });

  it('操作する側はモードから決まる＝入口で「操作する側」を選ばせない', () => {
    // 1回表から始まるので、守備側＝後攻・攻撃側＝先攻。
    expect(practiceHumanSide('pitch')).toBe('home');
    expect(practiceHumanSide('field')).toBe('home');
    expect(practiceHudLines('bat', { swing: false, knock: INITIAL_KNOCK })).toContain('DEBUG');
    expect(practiceHumanSide('bat')).toBe('away');
  });

  it('デバッグ行には「押せるキー」と「カウントが戻ること」が必ず出る', () => {
    // 見えていなければデバッグモードそのものが使えない（本番の操作ヒントと同じ方針）。
    const pitch = practiceHudLines('pitch', { swing: false, knock: INITIAL_KNOCK });
    expect(pitch).toContain('0-0');
    expect(pitch).toContain('1:');
    const field = practiceHudLines('field', { swing: false, knock: INITIAL_KNOCK });
    expect(field).toContain('4:');
    expect(field).toContain(knockLabel(INITIAL_KNOCK));
  });
});

describe('ノック（フェーズPP-64。守備モードの打球）', () => {
  it('設定は端で折り返す（押し続ければ全部見られる）', () => {
    let setup = { direction: KNOCK_DIRECTIONS.length - 1, kind: 0, runners: 0 };
    setup = cycleKnock(setup, 'direction');
    expect(setup.direction).toBe(0);
    expect(cycleKnock(setup, 'kind').kind).toBe(1);
    expect(cycleKnock(setup, 'runners').runners).toBe(1);
  });

  it('どの方向もフェアゾーンに収まる（ファウルの練習にならない）', () => {
    for (let d = 0; d < KNOCK_DIRECTIONS.length; d += 1) {
      expect(Math.abs(KNOCK_DIRECTIONS[d].deg)).toBeLessThan(45);
      for (let k = 0; k < KNOCK_KINDS.length; k += 1) {
        const result = fly({ direction: d, kind: k, runners: 0 });
        expect(Math.abs(result.landingDeg)).toBeLessThan(45);
      }
    }
  });

  it('種類ごとに狙った帯へ飛ぶ（ゴロは内野・フライは外野・大飛球はフェンス際）', () => {
    const center = (kind: number) => fly({ direction: 2, kind, runners: 0 });
    const grounder = center(0);
    const liner = center(1);
    const flyBall = center(2);
    const deep = center(3);
    // ゴロ＝低く転がる（内野で拾える。打ち上げ角が浅いので山にならない）
    expect(grounder.apex).toBeLessThan(3);
    // ライナーはゴロより速く・遠くへ抜ける
    expect(liner.distance).toBeGreaterThan(grounder.distance);
    // フライは外野の定位置あたりに落ちる＝捕球の練習になる高さ
    expect(flyBall.apex).toBeGreaterThan(10);
    expect(flyBall.distance).toBeGreaterThan(60);
    expect(flyBall.distance).toBeLessThan(100);
    // 大飛球はいちばん遠くへ（フェンス際／越え）
    expect(deep.distance).toBeGreaterThan(flyBall.distance);
  });

  it('走者のパターンは「後ろの塁から埋める」順（先頭が必ず入る）', () => {
    expect(KNOCK_RUNNER_PATTERNS.map((p) => p.bases.length)).toEqual([0, 1, 2, 3]);
    for (const pattern of KNOCK_RUNNER_PATTERNS) {
      if (pattern.bases.length > 0) expect(pattern.bases[0]).toBe('first');
    }
  });

  it('打球は打撃とまったく同じ形（バントではない・接触点は本塁の上）', () => {
    const ball = knockLaunch(INITIAL_KNOCK);
    expect(ball.bunt).toBe(false);
    expect(ball.x).toBe(0);
    expect(ball.landing).toBeNull();
  });
});

describe('DEBUG_RESET_COUNT（フェーズPP-64。カウント以外は1つも触らない）', () => {
  function started() {
    const actor = createActor(gameMachine).start();
    actor.send({
      type: 'MATCH_SETUP',
      away: TEAMS[0].id,
      home: TEAMS[1].id,
      plans: {},
      seed: 1,
      skills: {},
      uses: {},
      rerolls: {},
      fatigue: {},
    });
    return actor;
  }

  it('2ストライク3ボールから 0-0 に戻り、アウト・得点・打順・イニングは動かない', () => {
    const actor = started();
    for (const judgement of ['strike', 'strike', 'ball', 'ball', 'ball'] as const) {
      actor.send({ type: 'PITCH_RESULT', judgement });
    }
    const before = actor.getSnapshot().context;
    expect(before.count).toEqual({ balls: 3, strikes: 2 });
    actor.send({ type: 'DEBUG_RESET_COUNT' });
    const after = actor.getSnapshot().context;
    expect(after.count).toEqual({ balls: 0, strikes: 0 });
    expect(after.outs).toBe(before.outs);
    expect(after.score).toEqual(before.score);
    expect(after.inning).toBe(before.inning);
    expect(after.half).toBe(before.half);
    expect(after.bases).toEqual(before.bases);
    expect(after.baseRunners).toEqual(before.baseRunners);
    expect(after.rosters).toEqual(before.rosters);
    expect(after.winner).toBeNull();
  });

  it('三振・四球の代わりにこれを送れば、打席は永遠に終わらない', () => {
    const actor = started();
    const lineupBefore = actor.getSnapshot().context.rosters.away.lineupIndex;
    // 三振になる球を DEBUG_RESET_COUNT に差し替えながら30球投げる
    for (let pitch = 0; pitch < 30; pitch += 1) {
      const count = actor.getSnapshot().context.count;
      if (count.strikes >= 2) actor.send({ type: 'DEBUG_RESET_COUNT' });
      else actor.send({ type: 'PITCH_RESULT', judgement: 'strike' });
    }
    const ctx = actor.getSnapshot().context;
    expect(ctx.outs).toBe(0);
    expect(ctx.inning).toBe(1);
    expect(ctx.rosters.away.lineupIndex).toBe(lineupBefore);
  });
});
