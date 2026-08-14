/**
 * スキル抽選が試合の状態機械にどう乗るか（フェーズF-26-1。CLAUDE.md ⑧）。
 *
 * ここで固定したいのは3つ：
 * - **乱数を引くのは抽選だけ**で、シードを固定すれば試合まるごと再現できること。
 * - **同じ回に二重に引かない／選び損ねた抽選が残らない**こと（残ると以降の抽選が止まる）。
 * - 抽選と付与が**カウント・アウト・塁・打順に一切触れない**こと。
 */
import { describe, expect, it } from 'vitest';
import { createActor } from 'xstate';
import { gameMachine } from '../src/core/gameMachine';
import { EMPTY_BASES } from '../src/core/rules';
import {
  type TeamRoster,
  canUseVerb,
  chargesLeftOf,
  currentBatterId,
  gunRemainingOf,
  hasSkill,
  hasSkillRoom,
  skillHoldersOf,
  skillsOf,
} from '../src/core/roster';
import { DEFAULT_SEED, createRngState } from '../src/core/rng';
import {
  type SkillId,
  ACTIVE_LINEAGE_COUNT,
  DRAFT_OPTION_COUNT,
  MAX_SKILLS_PER_PLAYER,
  SKILLS,
  activeLineagesFor,
  eligibleHolders,
} from '../src/core/skills';

function startGame() {
  return createActor(gameMachine).start();
}

/**
 * そのスキルを実際に付けられる選手（＝抽選画面が段階②に並べる候補の先頭）。
 * **「打席に立っている選手」を決め打ちにしない**のは、投手専用のスキル（`ジュウ`・
 * `タフネス` 等）が候補に出た回では野手に付かないため＝プールの中身が変わるたびに
 * テストが落ちる、という結びつきを断つ（F-26-5でプールが10→41になったときに顕在化した）。
 */
function grantableHolder(roster: TeamRoster, skillId: SkillId): string {
  return eligibleHolders(skillHoldersOf(roster), skillId)[0].id;
}

/** 3アウトを一括で送って半イニングを終わらせる（攻守交代＝次の抽選の機会） */
function endHalf(actor: ReturnType<typeof startGame>) {
  actor.send({ type: 'PLAY_RESOLVED', outsAdded: 3, runs: 0, bases: EMPTY_BASES });
}

function draw(actor: ReturnType<typeof startGame>) {
  actor.send({ type: 'SKILL_DRAFT_DRAWN' });
  return actor.getSnapshot().context;
}

describe('SKILL_DRAFT_DRAWN: 抽選', () => {
  it('引くと3択が提示され、引いた側は「これから攻撃するチーム」', () => {
    const ctx = draw(startGame());
    expect(ctx.pendingDraft).not.toBeNull();
    expect(ctx.pendingDraft!.side).toBe('away'); // 1回表＝先攻の攻撃
    expect(ctx.pendingDraft!.draft.options).toHaveLength(DRAFT_OPTION_COUNT);
  });

  it('裏の攻撃では後攻側が引く', () => {
    const actor = startGame();
    endHalf(actor);
    expect(actor.getSnapshot().context.half).toBe('bottom');
    expect(draw(actor).pendingDraft!.side).toBe('home');
  });

  it('引くと乱数の状態が進む', () => {
    const actor = startGame();
    const before = actor.getSnapshot().context.rngState;
    expect(draw(actor).rngState).not.toBe(before);
  });

  it('すでに提示中なら二重に引かない（乱数も進まない）', () => {
    const actor = startGame();
    const first = draw(actor);
    const second = draw(actor);
    expect(second.pendingDraft).toEqual(first.pendingDraft);
    expect(second.rngState).toBe(first.rngState);
  });

  it('同じシードなら毎回まったく同じ抽選になる（試合まるごと再現できる）', () => {
    const options = () => {
      const actor = startGame();
      actor.send({ type: 'MATCH_SETUP', away: 'winds', home: 'galaxies', seed: 4649 });
      return draw(actor).pendingDraft!.draft.options;
    };
    expect(options()).toEqual(options());
  });

  it('シードが違えば引きが変わりうる', () => {
    const optionsFor = (seed: number) => {
      const actor = startGame();
      actor.send({ type: 'MATCH_SETUP', away: 'winds', home: 'galaxies', seed });
      const seen: string[] = [];
      // 1回ぶんでは偶然一致しうるので、続けて数回引いた並びで比べる
      for (let i = 0; i < 6; i += 1) {
        const ctx = draw(actor);
        const picked = ctx.pendingDraft!.draft.options[0];
        seen.push(picked);
        const side = ctx.pendingDraft!.side;
        const target = ctx.rosters[side].lineup[i];
        actor.send({ type: 'SKILL_GRANTED', side, playerId: target, skillId: picked });
      }
      return seen.join(',');
    };
    expect(optionsFor(1)).not.toBe(optionsFor(987654));
  });

  it('シードを渡さない MATCH_SETUP は既定シードのまま（テストが決定的に書ける）', () => {
    const actor = startGame();
    actor.send({ type: 'MATCH_SETUP', away: 'winds', home: 'galaxies' });
    expect(actor.getSnapshot().context.rngState).toBe(DEFAULT_SEED);
  });

  it('候補はその試合の系統からしか出ない（F-26-5の絞り込み）', () => {
    const actor = startGame();
    actor.send({ type: 'MATCH_SETUP', away: 'winds', home: 'galaxies', seed: 20260728 });
    for (let round = 0; round < 6; round += 1) {
      const ctx = draw(actor);
      const pending = ctx.pendingDraft!;
      for (const id of pending.draft.options) {
        expect(ctx.lineages).toContain(SKILLS[id].lineage);
      }
      const side = pending.side;
      actor.send({
        type: 'SKILL_GRANTED',
        side,
        playerId: grantableHolder(ctx.rosters[side], pending.draft.options[0]),
        skillId: pending.draft.options[0],
      });
    }
  });

  it('試合が終わっていれば引かない（使う場面が無いスキルを選ばせない）', () => {
    const actor = startGame();
    actor.send({ type: 'FORFEIT', loser: 'away' });
    expect(actor.getSnapshot().context.winner).toBe('home');
    actor.send({ type: 'SKILL_DRAFT_DRAWN' });
    expect(actor.getSnapshot().context.pendingDraft).toBeNull();
  });

  it('抽選はカウント・アウト・塁・打順に一切触れない', () => {
    const actor = startGame();
    actor.send({ type: 'PITCH_RESULT', judgement: 'strike' });
    const before = actor.getSnapshot().context;
    const after = draw(actor);
    expect(after.count).toEqual(before.count);
    expect(after.outs).toBe(before.outs);
    expect(after.bases).toEqual(before.bases);
    expect(after.rosters.away.lineupIndex).toBe(before.rosters.away.lineupIndex);
  });
});

describe('lineages: 試合ごとの系統（F-26-5）', () => {
  it('起動直後から3系統が決まっている（抽選より前に決まる）', () => {
    const ctx = startGame().getSnapshot().context;
    expect(ctx.lineages).toHaveLength(ACTIVE_LINEAGE_COUNT);
    expect(new Set(ctx.lineages).size).toBe(ACTIVE_LINEAGE_COUNT);
  });

  it('MATCH_SETUP のシードで決まる（同じシードなら同じ顔ぶれ）', () => {
    const lineagesFor = (seed: number) => {
      const actor = startGame();
      actor.send({ type: 'MATCH_SETUP', away: 'winds', home: 'galaxies', seed });
      return actor.getSnapshot().context.lineages;
    };
    expect(lineagesFor(4649)).toEqual(activeLineagesFor(createRngState(4649)));
    expect(lineagesFor(4649)).toEqual(lineagesFor(4649));
  });

  /**
   * **系統を決めるのに本編の乱数を消費しない**（別系列から起こす）。消費すると
   * 「シードを渡さない MATCH_SETUP は既定シードのまま」という既存の約束が崩れ、
   * 抽選の再現性がシードだけでは説明できなくなる。
   */
  it('系統の抽選は乱数の状態を進めない', () => {
    const actor = startGame();
    const before = actor.getSnapshot().context.rngState;
    actor.send({ type: 'MATCH_SETUP', away: 'winds', home: 'galaxies' });
    expect(actor.getSnapshot().context.rngState).toBe(before);
  });

  it('両チームで同じ系統（先攻・後攻で候補の系統が違わない）', () => {
    const actor = startGame();
    actor.send({ type: 'MATCH_SETUP', away: 'winds', home: 'galaxies', seed: 31 });
    const lineages = actor.getSnapshot().context.lineages;
    const awaySide = draw(actor).pendingDraft!.side;
    expect(awaySide).toBe('away');
    // 表の抽選を畳んでから裏へ（提示が残ると次の抽選が起きない）
    const first = actor.getSnapshot().context;
    actor.send({
      type: 'SKILL_GRANTED',
      side: 'away',
      playerId: grantableHolder(first.rosters.away, first.pendingDraft!.draft.options[0]),
      skillId: first.pendingDraft!.draft.options[0],
    });
    endHalf(actor);
    const bottom = draw(actor);
    expect(bottom.pendingDraft!.side).toBe('home');
    expect(bottom.lineages).toEqual(lineages);
    for (const id of bottom.pendingDraft!.draft.options) {
      expect(lineages).toContain(SKILLS[id].lineage);
    }
  });

});

describe('SKILL_GRANTED: 付与', () => {
  it('提示された候補を選ぶと、その選手に付いて提示が畳まれる', () => {
    const actor = startGame();
    const ctx = draw(actor);
    const side = ctx.pendingDraft!.side;
    const skillId = ctx.pendingDraft!.draft.options[0];
    const playerId = grantableHolder(ctx.rosters[side], skillId);
    actor.send({ type: 'SKILL_GRANTED', side, playerId, skillId });
    const next = actor.getSnapshot().context;
    expect(hasSkill(next.rosters[side], playerId, skillId)).toBe(true);
    expect(next.pendingDraft).toBeNull();
  });

  it('提示されていないスキルは付かない（UIの外から流し込めない）', () => {
    const actor = startGame();
    const ctx = draw(actor);
    const side = ctx.pendingDraft!.side;
    const playerId = currentBatterId(ctx.rosters[side]);
    // 候補に無いものを選んだ場合。候補3つに含まれないIDを探す
    const notOffered = (['kinniku', 'sukebo', 'shoryuken', 'bukimochikomi'] as const).find(
      (id) => !ctx.pendingDraft!.draft.options.includes(id),
    )!;
    actor.send({ type: 'SKILL_GRANTED', side, playerId, skillId: notOffered });
    const next = actor.getSnapshot().context;
    expect(hasSkill(next.rosters[side], playerId, notOffered)).toBe(false);
    // それでも提示は畳む（残ると次の回の抽選が止まる）
    expect(next.pendingDraft).toBeNull();
  });

  it('存在しない選手を指定しても壊れず、提示だけ畳まれる（CPUが付け先を持たない場合）', () => {
    const actor = startGame();
    const ctx = draw(actor);
    const side = ctx.pendingDraft!.side;
    actor.send({
      type: 'SKILL_GRANTED',
      side,
      playerId: '',
      skillId: ctx.pendingDraft!.draft.options[0],
    });
    expect(actor.getSnapshot().context.pendingDraft).toBeNull();
  });

  it('引いた側と違うチームには付かない', () => {
    const actor = startGame();
    const ctx = draw(actor);
    const drawnSide = ctx.pendingDraft!.side; // away
    const other = drawnSide === 'away' ? 'home' : 'away';
    const skillId = ctx.pendingDraft!.draft.options[0];
    const playerId = currentBatterId(ctx.rosters[other]);
    actor.send({ type: 'SKILL_GRANTED', side: other, playerId, skillId });
    expect(hasSkill(actor.getSnapshot().context.rosters[other], playerId, skillId)).toBe(false);
  });

  it('付与はカウント・アウト・塁・打順に一切触れない', () => {
    const actor = startGame();
    actor.send({ type: 'PITCH_RESULT', judgement: 'ball' });
    const ctx = draw(actor);
    const side = ctx.pendingDraft!.side;
    const before = actor.getSnapshot().context;
    actor.send({
      type: 'SKILL_GRANTED',
      side,
      playerId: currentBatterId(ctx.rosters[side]),
      skillId: ctx.pendingDraft!.draft.options[0],
    });
    const after = actor.getSnapshot().context;
    expect(after.count).toEqual(before.count);
    expect(after.outs).toBe(before.outs);
    expect(after.bases).toEqual(before.bases);
    expect(after.rosters[side].lineupIndex).toBe(before.rosters[side].lineupIndex);
  });

  it('選び損ねた抽選が残らない＝次の回もまた引ける', () => {
    const actor = startGame();
    const first = draw(actor);
    // 何も選ばず、候補に無いスキルで畳ませる（＝選び損ねに相当）
    actor.send({
      type: 'SKILL_GRANTED',
      side: first.pendingDraft!.side,
      playerId: '',
      skillId: first.pendingDraft!.draft.options[0],
    });
    endHalf(actor);
    expect(draw(actor).pendingDraft).not.toBeNull();
  });
});

describe('1試合を通した抽選（ランとして成立するか）', () => {
  it('攻守交代のたびに引き続けても、枠の上限を超えて付かない', () => {
    const actor = startGame();
    actor.send({ type: 'MATCH_SETUP', away: 'winds', home: 'galaxies', seed: 20260727 });
    // 9イニングぶん（表裏18回）引いて、毎回1番打者に付け続ける＝枠が真っ先に埋まる相手
    for (let i = 0; i < 18; i += 1) {
      const ctx = draw(actor);
      if (!ctx.pendingDraft) {
        endHalf(actor);
        continue;
      }
      const side = ctx.pendingDraft.side;
      actor.send({
        type: 'SKILL_GRANTED',
        side,
        playerId: ctx.rosters[side].lineup[0],
        skillId: ctx.pendingDraft.draft.options[0],
      });
      endHalf(actor);
    }
    const final = actor.getSnapshot().context;
    for (const side of ['away', 'home'] as const) {
      const roster = final.rosters[side];
      for (const id of Object.keys(roster.skills)) {
        // デュオを取っていれば3つになりうる（枠上限の例外）が、それ以外は2つまで
        expect(skillsOf(roster, id).length).toBeLessThanOrEqual(MAX_SKILLS_PER_PLAYER + 1);
      }
    }
  });

  it('両チームが同じ回数だけ引ける（表裏それぞれで攻撃側が引く＝対称）', () => {
    const actor = startGame();
    actor.send({ type: 'MATCH_SETUP', away: 'winds', home: 'galaxies', seed: 555 });
    const drawnBy = { away: 0, home: 0 };
    for (let i = 0; i < 6; i += 1) {
      const ctx = draw(actor);
      if (ctx.pendingDraft) {
        const side = ctx.pendingDraft.side;
        drawnBy[side] += 1;
        actor.send({
          type: 'SKILL_GRANTED',
          side,
          playerId: ctx.rosters[side].lineup[i % 9],
          skillId: ctx.pendingDraft.draft.options[0],
        });
      }
      endHalf(actor);
    }
    expect(drawnBy.away).toBe(3);
    expect(drawnBy.home).toBe(3);
  });
});

// ---- 消費型スキル（フェーズF-26-8） ----

describe('VERB_USED: 消費型のチャージ', () => {
  /**
   * 消費型スキルを1つ付けたロスターで試合を始める。**選手IDは球団ごとに違う**ので、
   * 先に `MATCH_SETUP` で球団を確定させてからIDを読む（起動直後の既定カードのIDを
   * 使うと、持ち越しの指定が誰も指さずに黙って落ちる）。
   */
  function withConsumable(skillId: SkillId) {
    const actor = startGame();
    actor.send({ type: 'MATCH_SETUP', away: 'winds', home: 'galaxies' });
    const roster = actor.getSnapshot().context.rosters.away;
    const playerId = skillId === 'yobiju' ? roster.pitcher : roster.lineup[0];
    actor.send({
      type: 'MATCH_SETUP',
      away: 'winds',
      home: 'galaxies',
      skills: { away: { [playerId]: [skillId] } },
    });
    return { actor, playerId };
  }

  it('使うとチャージが1つ減る', () => {
    const { actor, playerId } = withConsumable('nitoro');
    expect(chargesLeftOf(actor.getSnapshot().context.rosters.away, playerId, 'nitoro')).toBe(2);
    actor.send({ type: 'VERB_USED', side: 'away', playerId, verb: 'baiku' });
    expect(chargesLeftOf(actor.getSnapshot().context.rosters.away, playerId, 'nitoro')).toBe(1);
  });

  it('使い切ると動詞が使えなくなり、枠が空く', () => {
    const { actor, playerId } = withConsumable('nitoro');
    actor.send({ type: 'VERB_USED', side: 'away', playerId, verb: 'baiku' });
    actor.send({ type: 'VERB_USED', side: 'away', playerId, verb: 'baiku' });
    const roster = actor.getSnapshot().context.rosters.away;
    expect(canUseVerb(roster, playerId, 'baiku')).toBe(false);
    expect(hasSkillRoom(roster, playerId)).toBe(true);
  });

  /**
   * 常設の札を持っている選手からも同じ報せが届く（シーン層はどちらの札で乗ったかを
   * 知らない）ので、**何も起きない**ことを固定する。
   */
  it('常設のバイク持ちが使っても何も減らない', () => {
    const actor = startGame();
    const playerId = actor.getSnapshot().context.rosters.away.lineup[0];
    actor.send({
      type: 'MATCH_SETUP',
      away: 'winds',
      home: 'galaxies',
      skills: { away: { [playerId]: ['baiku'] } },
    });
    const before = actor.getSnapshot().context.rosters.away;
    actor.send({ type: 'VERB_USED', side: 'away', playerId, verb: 'baiku' });
    expect(actor.getSnapshot().context.rosters.away).toBe(before);
  });

  it('知らない選手IDが来ても壊れない（UIの外からの指定に対する防御）', () => {
    const actor = startGame();
    const before = actor.getSnapshot().context.rosters.away;
    actor.send({ type: 'VERB_USED', side: 'away', playerId: 'nobody', verb: 'baiku' });
    expect(actor.getSnapshot().context.rosters.away).toBe(before);
  });

  it('銃は GUN_USED で撃つとチャージが減る（VERB_USED を経由しない）', () => {
    const { actor, playerId } = withConsumable('yobiju');
    expect(gunRemainingOf(actor.getSnapshot().context.rosters.away, playerId)).toBe(1);
    // 守備側（away が守るのは裏）に回してから撃つ
    endHalf(actor);
    actor.send({ type: 'GUN_USED' });
    expect(gunRemainingOf(actor.getSnapshot().context.rosters.away, playerId)).toBe(0);
  });
});

describe('MATCH_SETUP: 消費型の持ち越し（フェーズF-26-8）', () => {
  it('使った回数を渡すとその状態から始まる（ラン全体で使い切り）', () => {
    const actor = startGame();
    actor.send({ type: 'MATCH_SETUP', away: 'winds', home: 'galaxies' });
    const playerId = actor.getSnapshot().context.rosters.away.lineup[0];
    actor.send({
      type: 'MATCH_SETUP',
      away: 'winds',
      home: 'galaxies',
      skills: { away: { [playerId]: ['tetsugeta'] } },
      uses: { away: { [playerId]: { tetsugeta: 1 } } },
    });
    expect(chargesLeftOf(actor.getSnapshot().context.rosters.away, playerId, 'tetsugeta')).toBe(1);
  });

  it('渡さなければ全部未使用（1試合だけの呼び出しは従来どおり）', () => {
    const actor = startGame();
    actor.send({ type: 'MATCH_SETUP', away: 'winds', home: 'galaxies' });
    const playerId = actor.getSnapshot().context.rosters.away.lineup[0];
    actor.send({
      type: 'MATCH_SETUP',
      away: 'winds',
      home: 'galaxies',
      skills: { away: { [playerId]: ['tetsugeta'] } },
    });
    expect(chargesLeftOf(actor.getSnapshot().context.rosters.away, playerId, 'tetsugeta')).toBe(2);
  });
});
