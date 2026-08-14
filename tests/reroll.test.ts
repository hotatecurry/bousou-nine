/**
 * リロール＝抽選のやり直し（フェーズU-42。CLAUDE.md ⑧ローグライト要素）。
 *
 * ⑧が「入れていない」と明記していた札で、**3択が引けなかったときに手が1つも無かった**
 * （抽選画面の判断が「3つのうちどれか」だけで閉じていた）穴を埋める。
 *
 * ここで固定したいのは4つ：
 * - **真実は「使った数」の側**（`rerollsUsed`）で、残りはそこからの導出＝
 *   「もう引き直せないのに残り回数だけ出ている」が構造的に起きない（F-26-8と同じ整理）。
 * - **回数券はラン全体で使い切り**＝試合をまたいでも回復しない（温存の判断が消えない）。
 * - **引き直した後は新しい3択だけが有効**（古い候補を付けられない）。
 * - **CPUの規則は決定的**（`shouldCpuReroll`）で、乱数を1つも引かない。
 */
import { describe, expect, it } from 'vitest';
import { createActor } from 'xstate';
import { gameMachine, rerollsLeftOf } from '../src/core/gameMachine';
import { EMPTY_BASES, type TeamSide } from '../src/core/rules';
import { skillHoldersOf, skillsOf } from '../src/core/roster';
import {
  type SkillDraft,
  type SkillId,
  DRAFT_OPTION_COUNT,
  REROLLS_PER_RUN,
  SKILLS,
  drawSkillDraft,
  eligibleHolders,
  rerollsLeft,
  shouldCpuReroll,
} from '../src/core/skills';
import { RUN_GAMES, createRun, gameSeed, preloadedSkills, withNextGame } from '../src/core/run';
import { TEAMS } from '../src/core/teams';
import { DEFAULT_ROSTER_PLAN } from '../src/core/roster';

function startGame() {
  return createActor(gameMachine).start();
}

function draw(actor: ReturnType<typeof startGame>) {
  actor.send({ type: 'SKILL_DRAFT_DRAWN' });
  return actor.getSnapshot().context;
}

function reroll(actor: ReturnType<typeof startGame>, side: TeamSide) {
  actor.send({ type: 'SKILL_DRAFT_REROLLED', side });
  return actor.getSnapshot().context;
}

/** 3アウトを一括で送って半イニングを終わらせる（＝次の抽選の機会） */
function endHalf(actor: ReturnType<typeof startGame>) {
  actor.send({ type: 'PLAY_RESOLVED', outsAdded: 3, runs: 0, bases: EMPTY_BASES });
}

const draftOf = (id: SkillId, ...rest: SkillId[]): SkillDraft => ({ options: [id, ...rest] });

describe('rerollsLeft: 残りは「使った数」からの導出', () => {
  it('使っていなければ満タン', () => {
    expect(rerollsLeft(0)).toBe(REROLLS_PER_RUN);
  });

  it('使ったぶんだけ減る', () => {
    expect(rerollsLeft(1)).toBe(REROLLS_PER_RUN - 1);
    expect(rerollsLeft(REROLLS_PER_RUN)).toBe(0);
  });

  it('使いすぎても負にならない（表示にも判定にも負の残りが出ない）', () => {
    expect(rerollsLeft(REROLLS_PER_RUN + 5)).toBe(0);
  });

  it('「毎試合1回」には届かない＝ラン全体の資源のまま（`balance:draft` の3つ目の基準）', () => {
    expect(REROLLS_PER_RUN).toBeLessThan(RUN_GAMES);
  });
});

describe('shouldCpuReroll: CPUの規則は決定的', () => {
  const byRarity = (rarity: number): SkillId =>
    (Object.keys(SKILLS) as SkillId[]).find((id) => SKILLS[id].rarity === rarity)!;

  it('★2以上が1枚も無ければ引き直す', () => {
    expect(shouldCpuReroll(draftOf(byRarity(1), byRarity(1), byRarity(1)))).toBe(true);
  });

  it('★2以上が1枚でもあれば引き直さない（`cpuChooseSkill` がそれを取るため）', () => {
    expect(shouldCpuReroll(draftOf(byRarity(1), byRarity(2), byRarity(1)))).toBe(false);
    expect(shouldCpuReroll(draftOf(byRarity(1), byRarity(1), byRarity(3)))).toBe(false);
  });

  it('候補が空なら引き直さない（引き直しても何も出ないため）', () => {
    expect(shouldCpuReroll({ options: [] })).toBe(false);
  });

  it('同じ3択なら何度問うても同じ答え（乱数を引かない）', () => {
    const draft = draftOf(byRarity(1), byRarity(1), byRarity(1));
    expect(shouldCpuReroll(draft)).toBe(shouldCpuReroll(draft));
  });
});

describe('SKILL_DRAFT_REROLLED: 3枚まるごと引き直す', () => {
  it('提示が差し替わり、使った回数が1つ増える', () => {
    const actor = startGame();
    const before = draw(actor);
    const first = before.pendingDraft!.draft.options;
    const after = reroll(actor, 'away');
    expect(after.rerollsUsed.away).toBe(1);
    expect(after.pendingDraft).not.toBeNull();
    expect(after.pendingDraft!.draft.options).toHaveLength(DRAFT_OPTION_COUNT);
    expect(after.pendingDraft!.draft.options).not.toEqual(first);
  });

  it('引き直した3択は「同じ乱数の続きをもう一度引いた」結果と一致する（専用の規則を持たない）', () => {
    const actor = startGame();
    const before = draw(actor);
    const expected = drawSkillDraft(
      before.rngState,
      skillHoldersOf(before.rosters.away),
      before.lineages,
    );
    const after = reroll(actor, 'away');
    expect(after.pendingDraft!.draft.options).toEqual(expected.draft.options);
    expect(after.rngState).toEqual(expected.state);
  });

  it(`回数券は ${REROLLS_PER_RUN} 回で尽き、それ以上は何も起きない`, () => {
    const actor = startGame();
    draw(actor);
    for (let i = 0; i < REROLLS_PER_RUN; i += 1) reroll(actor, 'away');
    const spent = actor.getSnapshot().context;
    expect(rerollsLeftOf(spent, 'away')).toBe(0);

    const after = reroll(actor, 'away');
    expect(after.rerollsUsed.away).toBe(REROLLS_PER_RUN);
    // 提示も乱数の位置も動かない＝払えないのに引かれる、が起きない
    expect(after.pendingDraft!.draft.options).toEqual(spent.pendingDraft!.draft.options);
    expect(after.rngState).toEqual(spent.rngState);
  });

  it('提示していない側から送っても何も起きない（相手の抽選を引き直せない）', () => {
    const actor = startGame();
    const before = draw(actor);
    expect(before.pendingDraft!.side).toBe('away');
    const after = reroll(actor, 'home');
    expect(after.rerollsUsed.home).toBe(0);
    expect(after.pendingDraft!.draft.options).toEqual(before.pendingDraft!.draft.options);
  });

  it('提示が無ければ何も起きない（抽選の外で回数券が減らない）', () => {
    const actor = startGame();
    const before = actor.getSnapshot().context;
    const after = reroll(actor, 'away');
    expect(after.rerollsUsed.away).toBe(0);
    expect(after.rngState).toEqual(before.rngState);
  });

  it('回数券は側ごとに別（片方が使い切っても相手は満タン）', () => {
    const actor = startGame();
    draw(actor);
    for (let i = 0; i < REROLLS_PER_RUN; i += 1) reroll(actor, 'away');
    // 表の攻撃を終わらせて、裏の攻撃側が引く
    actor.send({ type: 'SKILL_GRANTED', side: 'away', playerId: '', skillId: 'kinniku' });
    endHalf(actor);
    const ctx = draw(actor);
    expect(ctx.pendingDraft!.side).toBe('home');
    expect(rerollsLeftOf(ctx, 'away')).toBe(0);
    expect(rerollsLeftOf(ctx, 'home')).toBe(REROLLS_PER_RUN);
  });

  it('引き直した後は新しい3択だけが有効（古い候補は付かない）', () => {
    const actor = startGame();
    const before = draw(actor);
    const stale = before.pendingDraft!.draft.options[0];
    const after = reroll(actor, 'away');
    const fresh = after.pendingDraft!.draft.options;
    // 引き直しで消えた札を選んでも付かない（提示は畳まれるだけ）
    if (!fresh.includes(stale)) {
      const holder = eligibleHolders(skillHoldersOf(after.rosters.away), stale)[0].id;
      actor.send({ type: 'SKILL_GRANTED', side: 'away', playerId: holder, skillId: stale });
      const granted = actor.getSnapshot().context;
      expect(skillsOf(granted.rosters.away, holder)).not.toContain(stale);
      expect(granted.pendingDraft).toBeNull();
    }
  });

  it('カウント・アウト・塁・打順には一切触れない（抽選の棚だけを動かす）', () => {
    const actor = startGame();
    const before = draw(actor);
    const after = reroll(actor, 'away');
    expect(after.count).toEqual(before.count);
    expect(after.outs).toBe(before.outs);
    expect(after.bases).toEqual(before.bases);
    expect(after.inning).toBe(before.inning);
    expect(after.rosters.away.lineupIndex).toBe(before.rosters.away.lineupIndex);
  });

  it('シードが同じなら引き直しの結果まで同じ（試合まるごと再現できる）', () => {
    const run = (): readonly SkillId[] => {
      const actor = startGame();
      actor.send({ type: 'MATCH_SETUP', away: TEAMS[0].id, home: TEAMS[1].id, seed: 4242 });
      draw(actor);
      reroll(actor, 'away');
      reroll(actor, 'away');
      return actor.getSnapshot().context.pendingDraft!.draft.options;
    };
    expect(run()).toEqual(run());
  });
});

describe('MATCH_SETUP: 回数券はラン全体で使い切り', () => {
  it('渡さなければ満タン（1試合だけの呼び出し・2P PLAY はU-42の前と同じ扱い）', () => {
    const actor = startGame();
    actor.send({ type: 'MATCH_SETUP', away: TEAMS[0].id, home: TEAMS[1].id });
    const ctx = actor.getSnapshot().context;
    expect(rerollsLeftOf(ctx, 'away')).toBe(REROLLS_PER_RUN);
    expect(rerollsLeftOf(ctx, 'home')).toBe(REROLLS_PER_RUN);
  });

  it('前の試合までに使った回数を持ち越す（試合ごとに回復しない）', () => {
    const actor = startGame();
    actor.send({
      type: 'MATCH_SETUP',
      away: TEAMS[0].id,
      home: TEAMS[1].id,
      rerolls: { away: 2 },
    });
    const ctx = actor.getSnapshot().context;
    expect(rerollsLeftOf(ctx, 'away')).toBe(REROLLS_PER_RUN - 2);
    expect(rerollsLeftOf(ctx, 'home')).toBe(REROLLS_PER_RUN);
  });

  it('使い切って持ち越したら、その試合では1回も引き直せない', () => {
    const actor = startGame();
    actor.send({
      type: 'MATCH_SETUP',
      away: TEAMS[0].id,
      home: TEAMS[1].id,
      rerolls: { away: REROLLS_PER_RUN },
    });
    const before = draw(actor);
    const after = reroll(actor, 'away');
    expect(after.pendingDraft!.draft.options).toEqual(before.pendingDraft!.draft.options);
    expect(after.rerollsUsed.away).toBe(REROLLS_PER_RUN);
  });
});

describe('ラン：回数券の持ち越し', () => {
  const newRun = () =>
    createRun({
      seed: 99,
      teamId: TEAMS[0].id,
      side: 'away',
      plan: DEFAULT_ROSTER_PLAN,
      opponent: TEAMS[1].id,
      park: 'tokorozawa',
    });

  it('ランの始まりは未使用', () => {
    expect(newRun().rerollsUsed).toBe(0);
  });

  it('次の試合へ渡した使用回数がそのまま残る', () => {
    const run = newRun();
    const doors = [{ ...run.current, lineages: [] as const }];
    const next = withNextGame(run, doors[0], {}, {}, 2);
    expect(next.rerollsUsed).toBe(2);
  });

  it('渡さなければ前の値のまま（勝手に回復しない）', () => {
    const run = { ...newRun(), rerollsUsed: 3 };
    const doors = [{ ...run.current, lineages: [] as const }];
    expect(withNextGame(run, doors[0], {}, {}).rerollsUsed).toBe(3);
  });
});

describe('preloadedSkills: CPUも同じ回数券で蓄積している（⑧「CPUも対等」）', () => {
  const opponentOf = (game: number) =>
    preloadedSkills({ team: TEAMS[3].id, seed: gameSeed(99, game), game });

  it('初戦の相手はまだ1回も使っていない', () => {
    expect(opponentOf(1).rerollsUsed).toBe(0);
  });

  it('上限を超えて使わない（人間と同じ資源のもとで蓄積している）', () => {
    for (let game = 1; game <= RUN_GAMES; game += 1) {
      expect(opponentOf(game).rerollsUsed).toBeLessThanOrEqual(REROLLS_PER_RUN);
    }
  });

  it('試合数が増えるほど使用回数は減らない（ラン全体で使い切り）', () => {
    let previous = 0;
    for (let game = 1; game <= RUN_GAMES; game += 1) {
      const used = opponentOf(game).rerollsUsed;
      expect(used).toBeGreaterThanOrEqual(previous);
      previous = used;
    }
  });

  it('CPUは温存しないので、蓄積のあるうちに使い切る（F-26-8と同じ規則）', () => {
    expect(opponentOf(RUN_GAMES).rerollsUsed).toBe(REROLLS_PER_RUN);
  });

  it('同じシード・同じ試合数なら使った回数まで同じ（決定的）', () => {
    expect(opponentOf(4).rerollsUsed).toBe(opponentOf(4).rerollsUsed);
    expect(opponentOf(4).skills).toEqual(opponentOf(4).skills);
  });
});
