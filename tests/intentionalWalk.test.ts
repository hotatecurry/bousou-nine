/**
 * 敬遠（フェーズQ-38）。実際の野球の申告敬遠＝**投げずに打者を一塁へ歩かせる**。
 *
 * 固定するのは3つ：
 * - **四球とまったく同じ結果になる**（押し出しの点・打順の進行・カウントのリセット）。
 *   実装が `applyWalk` を共有していることを、外から見た帰結で確かめる。
 * - **投げていないので投球数（スタミナ）は動かない**（けん制球・銃と同じ扱い）。
 * - **宣言できるのは守備側だけ**。
 *
 * CPUの規則（`shouldCpuIntentionalWalk`）は `npm run balance:walk` が測った境界そのものなので、
 * ここでは「規則の形」（一塁が空いている・得点圏・強打者・次打者との差）を固定する。
 * 数値の帯そのものは `tests/balance.test.ts` に置く。
 */
import { describe, expect, it } from 'vitest';
import { createActor } from 'xstate';
import { gameMachine } from '../src/core/gameMachine';
import {
  CPU_INTENTIONAL_WALK_POWER_GAP,
  CPU_INTENTIONAL_WALK_POWER_THRESHOLD,
  shouldCpuIntentionalWalk,
} from '../src/core/cpuPitcher';
import { EMPTY_BASES, fieldingTeam } from '../src/core/rules';
import { currentBatterId, nextBatterId, pitchCountOf } from '../src/core/roster';

function startGame() {
  return createActor(gameMachine).start();
}

/** いま守備についている側（＝敬遠を宣言できる側） */
function defenseSide(actor: ReturnType<typeof startGame>) {
  return fieldingTeam(actor.getSnapshot().context.half);
}

describe('敬遠：四球とまったく同じ結果になる', () => {
  it('走者なしで宣言すると打者は一塁へ・カウントは0-0に戻る', () => {
    const actor = startGame();
    actor.send({ type: 'INTENTIONAL_WALK', side: defenseSide(actor) });
    const ctx = actor.getSnapshot().context;
    expect(ctx.bases).toEqual({ first: true, second: false, third: false });
    expect(ctx.count).toEqual({ balls: 0, strikes: 0 });
    expect(ctx.outs).toBe(0);
  });

  it('カウントの途中でも宣言できる（残りのボール数を数えない）', () => {
    const actor = startGame();
    actor.send({ type: 'PITCH_RESULT', judgement: 'strike' });
    actor.send({ type: 'PITCH_RESULT', judgement: 'strike' });
    expect(actor.getSnapshot().context.count).toEqual({ balls: 0, strikes: 2 });
    actor.send({ type: 'INTENTIONAL_WALK', side: defenseSide(actor) });
    const ctx = actor.getSnapshot().context;
    expect(ctx.bases.first).toBe(true);
    expect(ctx.count).toEqual({ balls: 0, strikes: 0 });
  });

  it('打順が1つ進む（打席が終わる）', () => {
    const actor = startGame();
    const before = actor.getSnapshot().context;
    const batting = before.half === 'top' ? 'away' : 'home';
    const expected = nextBatterId(before.rosters[batting]);
    actor.send({ type: 'INTENTIONAL_WALK', side: defenseSide(actor) });
    const after = actor.getSnapshot().context;
    expect(currentBatterId(after.rosters[batting])).toBe(expected);
  });

  it('フォースされた走者だけが進む（一・三塁 → 一・二・三塁）', () => {
    const actor = startGame();
    actor.send({
      type: 'PLAY_RESOLVED',
      outsAdded: 0,
      runs: 0,
      bases: { first: true, second: false, third: true },
    });
    actor.send({ type: 'INTENTIONAL_WALK', side: defenseSide(actor) });
    expect(actor.getSnapshot().context.bases).toEqual({
      first: true,
      second: true,
      third: true,
    });
  });

  it('満塁で宣言すると押し出しで1点入る', () => {
    const actor = startGame();
    actor.send({
      type: 'PLAY_RESOLVED',
      outsAdded: 0,
      runs: 0,
      bases: { first: true, second: true, third: true },
    });
    const before = actor.getSnapshot().context.score;
    actor.send({ type: 'INTENTIONAL_WALK', side: defenseSide(actor) });
    const ctx = actor.getSnapshot().context;
    expect(ctx.score.away).toBe(before.away + 1);
    expect(ctx.bases).toEqual({ first: true, second: true, third: true });
  });

  it('4球のボールで歩かせたときと塁・カウント・打順が一致する', () => {
    const walked = startGame();
    for (let i = 0; i < 4; i += 1) walked.send({ type: 'PITCH_RESULT', judgement: 'ball' });
    const declared = startGame();
    declared.send({ type: 'INTENTIONAL_WALK', side: defenseSide(declared) });
    const a = walked.getSnapshot().context;
    const b = declared.getSnapshot().context;
    expect(b.bases).toEqual(a.bases);
    expect(b.count).toEqual(a.count);
    expect(b.baseRunners).toEqual(a.baseRunners);
    expect(currentBatterId(b.rosters.away)).toBe(currentBatterId(a.rosters.away));
  });
});

describe('敬遠：投げていないので投球数は動かない', () => {
  it('宣言しても投手の投球数は増えない（けん制球・銃と同じ扱い）', () => {
    const actor = startGame();
    const side = defenseSide(actor);
    const before = actor.getSnapshot().context.rosters[side];
    const pitcher = before.pitcher;
    expect(pitchCountOf(before, pitcher)).toBe(0);
    actor.send({ type: 'INTENTIONAL_WALK', side });
    const after = actor.getSnapshot().context.rosters[side];
    expect(pitchCountOf(after, pitcher)).toBe(0);
  });

  it('4球のボールで歩かせた場合との差は投球数だけ（そちらは PITCH_THROWN で増える）', () => {
    const actor = startGame();
    const side = defenseSide(actor);
    for (let i = 0; i < 4; i += 1) {
      actor.send({ type: 'PITCH_THROWN' });
      actor.send({ type: 'PITCH_RESULT', judgement: 'ball' });
    }
    const ctx = actor.getSnapshot().context;
    // 交代していないので、いま守っている側の投手の記録に4球残っている
    expect(pitchCountOf(ctx.rosters[side], ctx.rosters[side].pitcher)).toBe(4);
  });
});

describe('敬遠：宣言できるのは守備側だけ', () => {
  it('攻撃側から送られても何も起きない（自分で自分を歩かせられない）', () => {
    const actor = startGame();
    const batting = actor.getSnapshot().context.half === 'top' ? 'away' : 'home';
    actor.send({ type: 'INTENTIONAL_WALK', side: batting });
    expect(actor.getSnapshot().context.bases).toEqual(EMPTY_BASES);
  });

  it('攻守が入れ替われば、宣言できる側も入れ替わる', () => {
    const actor = startGame();
    actor.send({ type: 'PLAY_RESOLVED', outsAdded: 3, runs: 0, bases: EMPTY_BASES });
    expect(actor.getSnapshot().context.half).toBe('bottom');
    // 裏の守備は away（表に攻撃していた側）
    actor.send({ type: 'INTENTIONAL_WALK', side: 'home' });
    expect(actor.getSnapshot().context.bases).toEqual(EMPTY_BASES);
    actor.send({ type: 'INTENTIONAL_WALK', side: 'away' });
    expect(actor.getSnapshot().context.bases.first).toBe(true);
  });
});

describe('敬遠：9回裏の押し出しはサヨナラになる（四球と同じ経路を通る証拠）', () => {
  it('同点・満塁で宣言すると試合が決着する', () => {
    const actor = startGame();
    // 9回裏まで進める（表裏それぞれ3アウト）
    for (let i = 0; i < 17; i += 1) {
      actor.send({ type: 'PLAY_RESOLVED', outsAdded: 3, runs: 0, bases: EMPTY_BASES });
    }
    const ctx = actor.getSnapshot().context;
    expect(ctx.inning).toBe(9);
    expect(ctx.half).toBe('bottom');
    actor.send({
      type: 'PLAY_RESOLVED',
      outsAdded: 0,
      runs: 0,
      bases: { first: true, second: true, third: true },
    });
    actor.send({ type: 'INTENTIONAL_WALK', side: 'away' });
    const after = actor.getSnapshot().context;
    expect(after.score.home).toBe(1);
    expect(after.winner).toBe('home');
  });
});

// ---- CPUの規則（数値の根拠は npm run balance:walk。帯は tests/balance.test.ts） ----

const SLUGGER = CPU_INTENTIONAL_WALK_POWER_THRESHOLD;
const WEAK_NEXT = SLUGGER - CPU_INTENTIONAL_WALK_POWER_GAP;
const SCORING_POSITION = { first: false, second: true, third: false };

describe('shouldCpuIntentionalWalk（CPU投手の敬遠）', () => {
  it('一塁が空いていて得点圏に走者・強打者・次打者が弱いなら歩かせる', () => {
    expect(
      shouldCpuIntentionalWalk({
        bases: SCORING_POSITION,
        batterPower: SLUGGER,
        nextBatterPower: WEAK_NEXT,
      }),
    ).toBe(true);
  });

  it('一塁が埋まっていたら歩かせない（走者を押し出すのは損）', () => {
    expect(
      shouldCpuIntentionalWalk({
        bases: { first: true, second: true, third: false },
        batterPower: 1,
        nextBatterPower: 0,
      }),
    ).toBe(false);
  });

  it('満塁でも歩かせない（押し出しで必ず1点献上する）', () => {
    expect(
      shouldCpuIntentionalWalk({
        bases: { first: true, second: true, third: true },
        batterPower: 1,
        nextBatterPower: 0,
      }),
    ).toBe(false);
  });

  it('得点圏に走者がいなければ歩かせない（1本で点が入らないので値打ちが無い）', () => {
    expect(
      shouldCpuIntentionalWalk({
        bases: EMPTY_BASES,
        batterPower: 1,
        nextBatterPower: 0,
      }),
    ).toBe(false);
  });

  it('三塁だけでも得点圏として扱う', () => {
    expect(
      shouldCpuIntentionalWalk({
        bases: { first: false, second: false, third: true },
        batterPower: SLUGGER,
        nextBatterPower: WEAK_NEXT,
      }),
    ).toBe(true);
  });

  it('しきい値に届かない打者は歩かせない', () => {
    expect(
      shouldCpuIntentionalWalk({
        bases: SCORING_POSITION,
        batterPower: SLUGGER - 0.01,
        nextBatterPower: 0,
      }),
    ).toBe(false);
  });

  it('次打者が強ければ歩かせない（避ける意味が無い）', () => {
    expect(
      shouldCpuIntentionalWalk({
        bases: SCORING_POSITION,
        batterPower: SLUGGER,
        nextBatterPower: WEAK_NEXT + 0.01,
      }),
    ).toBe(false);
  });

  it('打者が強いほど、より強い次打者でも成立する（差で決まる規則）', () => {
    const strong = shouldCpuIntentionalWalk({
      bases: SCORING_POSITION,
      batterPower: 1,
      nextBatterPower: 1 - CPU_INTENTIONAL_WALK_POWER_GAP,
    });
    expect(strong).toBe(true);
  });

  it('決定的（同じ入力なら必ず同じ答え）', () => {
    const opts = {
      bases: SCORING_POSITION,
      batterPower: SLUGGER,
      nextBatterPower: WEAK_NEXT,
    };
    expect(shouldCpuIntentionalWalk(opts)).toBe(shouldCpuIntentionalWalk(opts));
  });
});
