/**
 * 死球→乱闘の決着で「死球そのものが無かったことになる」ときの巻き戻し（フェーズBBB-81）。
 *
 * BBB-80 の実機確認で見つけた不具合：**投手の打順に入った代打が死球を受けて乱闘になると、
 * 乱闘で戦うのも、決着後に打席に立つのも、その代打ではなく攻撃側の投手になる**。死球は
 * 起きた瞬間に打順を進める（`advanceLineup`）ので、投手の打順スロットが現在の投手へ返され、
 * 代打は退いた扱いになっていた。調べると同じ経路で**満塁の死球の押し出しの1点**と
 * **一時効果（M-33）**も巻き戻っていなかった。
 *
 * 直し方：巻き戻し用の控え（`hbpRestoreOf`）が**死球の直前のロスター・得点・スコアボードも
 * 持つ**。死球から乱闘の決着までに試合の状態を動かすのは死球そのものだけなので、
 * まるごと戻してよい。
 */
import { describe, expect, it } from 'vitest';
import { createActor } from 'xstate';
import { gameMachine, hbpRestoreOf } from '../src/core/gameMachine';
import { activeEffectsOf, chargesLeftOf, currentBatterId } from '../src/core/roster';
import { EMPTY_BASES } from '../src/core/rules';
import { temporariesForRole } from '../src/core/skills';

function startGame() {
  return createActor(gameMachine).start();
}

/** 四球を1つ（打者が一塁へ） */
function walk(actor: ReturnType<typeof startGame>): void {
  for (let i = 0; i < 4; i++) actor.send({ type: 'PITCH_RESULT', judgement: 'ball' });
}

/** 先攻（away）の打順を、投手の打順（9番）の手前まで進める（8人ぶん打球でアウト→攻守交代を挟む） */
function advanceToPitcherSlot(actor: ReturnType<typeof startGame>): void {
  // 1回表：3人アウト → 1回裏を畳む → 2回表：3人アウト → 2回裏を畳む → 3回表：2人アウト
  for (let half = 0; half < 2; half++) {
    for (let i = 0; i < 3; i++) actor.send({ type: 'PLAY_RESOLVED', outsAdded: 1, runs: 0, bases: EMPTY_BASES });
    actor.send({ type: 'PLAY_RESOLVED', outsAdded: 3, runs: 0, bases: EMPTY_BASES });
  }
  for (let i = 0; i < 2; i++) actor.send({ type: 'PLAY_RESOLVED', outsAdded: 1, runs: 0, bases: EMPTY_BASES });
}

describe('満塁の死球→乱闘：押し出しの1点も無かったことになる', () => {
  for (const loser of ['batter', 'pitcher'] as const) {
    it(`${loser === 'batter' ? '打者' : '投手'}敗北：得点・スコアボード・走者が死球の直前に戻る`, () => {
      const actor = startGame();
      walk(actor);
      walk(actor);
      walk(actor);
      const pre = actor.getSnapshot().context;
      expect(pre.bases).toEqual({ first: true, second: true, third: true });
      expect(pre.score).toEqual({ away: 0, home: 0 });
      const restore = hbpRestoreOf(pre);

      actor.send({ type: 'HIT_BY_PITCH' });
      // 死球の瞬間は押し出しで1点入っている（乱闘にならなければこのまま確定する）
      expect(actor.getSnapshot().context.score).toEqual({ away: 1, home: 0 });

      actor.send({ type: 'BRAWL_RESOLVED', loser, restore });
      const ctx = actor.getSnapshot().context;
      expect(ctx.score).toEqual({ away: 0, home: 0 });
      expect(ctx.lineScore).toEqual(pre.lineScore);
      expect(ctx.baseRunners).toEqual(pre.baseRunners);
      expect(ctx.bases).toEqual({ first: true, second: true, third: true });
      expect(ctx.count).toEqual(pre.count);
      expect(ctx.rosters.away.lineupIndex).toBe(pre.rosters.away.lineupIndex);
    });
  }

  it('乱闘にならなければ（巻き戻しを送らなければ）押し出しの1点はそのまま残る', () => {
    const actor = startGame();
    walk(actor);
    walk(actor);
    walk(actor);
    actor.send({ type: 'HIT_BY_PITCH' });
    expect(actor.getSnapshot().context.score).toEqual({ away: 1, home: 0 });
    expect(actor.getSnapshot().context.bases).toEqual({ first: true, second: true, third: true });
  });
});

describe('投手の打順に入った代打が死球→乱闘：戦うのも打席に立つのもその代打', () => {
  function setup() {
    const actor = startGame();
    advanceToPitcherSlot(actor);
    const before = actor.getSnapshot().context;
    expect(before.half).toBe('top');
    const slot = before.rosters.away.pitcherSlot;
    expect(before.rosters.away.lineupIndex).toBe(slot);
    const starter = before.rosters.away.pitcher;
    expect(currentBatterId(before.rosters.away)).toBe(starter);
    // 投手の打席に代打（自動で継投する＝B-10）
    actor.send({ type: 'SUBSTITUTE_BATTER', side: 'away', benchIndex: 0 });
    const pre = actor.getSnapshot().context;
    const pinch = currentBatterId(pre.rosters.away);
    expect(pinch).not.toBe(starter);
    expect(pre.rosters.away.pitcher).not.toBe(starter);
    return { actor, pre, pinch, slot, reliever: pre.rosters.away.pitcher };
  }

  it('死球の瞬間は、打順スロットが現在の投手へ返っている（乱闘にならなければこれで正しい）', () => {
    const { actor, pinch, slot, reliever } = setup();
    actor.send({ type: 'HIT_BY_PITCH' });
    const ctx = actor.getSnapshot().context;
    expect(ctx.rosters.away.lineup[slot]).toBe(reliever);
    expect(ctx.rosters.away.ejected).toContain(pinch);
    // 塁の上にいるのは代打（走者の識別は塁が持つ）
    expect(ctx.baseRunners.first).toBe(pinch);
  });

  it('巻き戻し用の控えは、死球を受けた打者＝代打を指す', () => {
    const { pre, pinch } = setup();
    const restore = hbpRestoreOf(pre);
    expect(restore.rosters!.away.lineup[restore.battingLineupIndex]).toBe(pinch);
  });

  it('投手敗北：同じ打席が続く＝打席に立つのは代打のまま（退いた扱いにならない）', () => {
    const { actor, pre, pinch } = setup();
    const restore = hbpRestoreOf(pre);
    const defensePitcher = pre.rosters.home.pitcher;
    actor.send({ type: 'HIT_BY_PITCH' });
    actor.send({ type: 'BRAWL_RESOLVED', loser: 'pitcher', restore });
    const ctx = actor.getSnapshot().context;
    expect(currentBatterId(ctx.rosters.away)).toBe(pinch);
    expect(ctx.rosters.away.ejected).not.toContain(pinch);
    expect(ctx.baseRunners.first).toBeNull();
    // 負けた守備側の投手は退場して救援が出る（従来どおり）
    expect(ctx.rosters.home.pitcher).not.toBe(defensePitcher);
    expect(ctx.rosters.home.ejected).toContain(defensePitcher);
    // 攻撃側の継投（代打を出したときの自動継投）はそのまま
    expect(ctx.rosters.away.pitcher).toBe(pre.rosters.away.pitcher);
  });

  it('打者敗北：退場するのは代打で、次の控えが同じ打席を引き継ぐ（投手は打席に立たない）', () => {
    const { actor, pre, pinch, reliever } = setup();
    const restore = hbpRestoreOf(pre);
    const benchBefore = pre.rosters.away.bench.length;
    actor.send({ type: 'HIT_BY_PITCH' });
    actor.send({ type: 'BRAWL_RESOLVED', loser: 'batter', restore });
    const ctx = actor.getSnapshot().context;
    const batter = currentBatterId(ctx.rosters.away);
    expect(batter).not.toBe(pinch);
    expect(batter).not.toBe(reliever);
    expect(ctx.rosters.away.ejected).toContain(pinch);
    expect(ctx.rosters.away.bench).toHaveLength(benchBefore - 1);
    // マウンドの投手は退場していない
    expect(ctx.rosters.away.pitcher).toBe(reliever);
    expect(ctx.rosters.away.ejected).not.toContain(reliever);
  });
});

describe('一時効果（M-33）を切った打席で死球→乱闘：同じ打席が続くので効果も残る', () => {
  it('効果は残り、回数券は切ったぶんだけ減ったまま（引き直しにはならない）', () => {
    const card = temporariesForRole('batting')[0];
    const probe = createActor(gameMachine).start();
    probe.send({ type: 'MATCH_SETUP', away: 'flames', home: 'winds' });
    const playerId = currentBatterId(probe.getSnapshot().context.rosters.away);
    const actor = createActor(gameMachine).start();
    actor.send({ type: 'MATCH_SETUP', away: 'flames', home: 'winds', skills: { away: { [playerId]: [card] } } });
    actor.send({ type: 'EFFECT_ACTIVATED', side: 'away', playerId, role: 'batting' });
    const pre = actor.getSnapshot().context;
    expect(activeEffectsOf(pre.rosters.away, playerId)).toEqual([card]);
    const chargesAfterUse = chargesLeftOf(pre.rosters.away, playerId, card);
    const restore = hbpRestoreOf(pre);

    actor.send({ type: 'HIT_BY_PITCH' });
    // 死球で打席が終わった扱いになり、効果は一度落ちる
    expect(activeEffectsOf(actor.getSnapshot().context.rosters.away, playerId)).toEqual([]);

    actor.send({ type: 'BRAWL_RESOLVED', loser: 'pitcher', restore });
    const ctx = actor.getSnapshot().context;
    expect(currentBatterId(ctx.rosters.away)).toBe(playerId);
    expect(activeEffectsOf(ctx.rosters.away, playerId)).toEqual([card]);
    expect(chargesLeftOf(ctx.rosters.away, playerId, card)).toBe(chargesAfterUse);
  });
});

describe('従来の呼び方（ロスター・得点を渡さない）はこれまでどおり', () => {
  it('打順の巻き戻しと退場だけが起きる', () => {
    const actor = startGame();
    const pre = actor.getSnapshot().context;
    const outgoing = currentBatterId(pre.rosters.away);
    actor.send({ type: 'HIT_BY_PITCH' });
    actor.send({
      type: 'BRAWL_RESOLVED',
      loser: 'batter',
      restore: { count: pre.count, bases: pre.bases, battingLineupIndex: pre.rosters.away.lineupIndex },
    });
    const ctx = actor.getSnapshot().context;
    expect(ctx.rosters.away.lineupIndex).toBe(0);
    expect(ctx.rosters.away.ejected).toEqual([outgoing]);
  });
});
