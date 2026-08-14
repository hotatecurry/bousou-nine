/**
 * ラン（試合をまたぐローグライト。フェーズF-26-6。CLAUDE.md ⑧）。
 *
 * ここで固定したいのは4つ：
 * - **ランの寸法**（5試合×9回の抽選 と 枠の数）が噛み合っていること。ここが崩れると
 *   終盤の抽選が「候補を作れず何も起きない回」になり、ローグライトの山場が静かになる。
 * - **扉が決定的で、同じ相手と二度当たらない**こと（シードを固定すればラン全体を再現できる）。
 * - **相手も同じだけ蓄積している**こと（⑧のCPU対等。人間側だけが育つと進むほど一方的になる）。
 * - **持ち越しがロスターの不変条件を壊さない**こと（枠・対象・デュオの前提）。
 */
import { describe, expect, it } from 'vitest';
import { createActor } from 'xstate';
import { gameMachine } from '../src/core/gameMachine';
import {
  type RunState,
  DRAFTS_PER_GAME,
  RUN_DOOR_COUNT,
  RUN_GAMES,
  createRun,
  gameSeed,
  preloadedSkills,
  runDoors,
  runOutcomeAfter,
  runProgress,
  skillCount,
  withGameResult,
  withNextGame,
} from '../src/core/run';
import {
  DEFAULT_ROSTER_PLAN,
  createTeamRoster,
  skillHoldersOf,
  skillsOf,
  withCarriedSkills,
} from '../src/core/roster';
import { MAX_SKILLS_PER_PLAYER, SKILLS } from '../src/core/skills';
import { TEAMS, teamById } from '../src/core/teams';
import { BALLPARKS } from '../src/core/ballpark';

const SEED = 12345;

function newRun(): RunState {
  return createRun({
    seed: SEED,
    teamId: TEAMS[0].id,
    side: 'home',
    plan: DEFAULT_ROSTER_PLAN,
    opponent: TEAMS[1].id,
    park: BALLPARKS[0].id,
  });
}

/** 1つも落とさずに最後まで進んだランの各時点（テストから5試合を通しで回すため） */
function playThrough(run: RunState, games: number): RunState {
  let state = run;
  for (let i = 1; i < games; i += 1) {
    state = withGameResult(state, true);
    const doors = runDoors(state);
    state = withNextGame(state, doors[0], state.skills);
  }
  return state;
}

describe('ランの寸法（抽選の回数と枠の数）', () => {
  it('ラン全体の抽選回数が、ロスターに置ける枠の数を超えない', () => {
    // 超えると最終戦で「候補が作れず何も起きない抽選」だけが残る（F-26-6で枠上限を
    // 2→3にした理由そのもの）。枠の数はロスターの人数から導出する＝名鑑の人数を
    // 増減させたらこのテストが先に落ちる。
    const holders = skillHoldersOf(createTeamRoster(teamById(TEAMS[0].id))).length;
    expect(RUN_GAMES * DRAFTS_PER_GAME).toBeLessThanOrEqual(holders * MAX_SKILLS_PER_PLAYER);
  });

  it('実際に試合へ出る打線9人ぶんの枠より抽選のほうが多い（枠の奪い合いは残る）', () => {
    // 全部を打線に積むことはできない＝終盤ほど「誰に付けるか」が重くなる（⑧の中心）。
    expect(RUN_GAMES * DRAFTS_PER_GAME).toBeGreaterThan(9 * MAX_SKILLS_PER_PLAYER);
  });
});

describe('createRun / withGameResult / runOutcomeAfter', () => {
  it('1試合目から始まり、初戦の相手はチーム選択で選んだ球団', () => {
    const run = newRun();
    expect(run.game).toBe(1);
    expect(run.wins).toBe(0);
    expect(run.skills).toEqual({});
    expect(run.current.opponent).toBe(TEAMS[1].id);
    expect(run.current.park).toBe(BALLPARKS[0].id);
    expect(run.current.seed).toBe(gameSeed(SEED, 1));
    // 自分の球団も faced に入れておく（扉に自分自身が出てこない条件）
    expect(run.faced).toContain(TEAMS[0].id);
  });

  it('勝てば勝ち数が増え、負ければ増えない', () => {
    expect(withGameResult(newRun(), true).wins).toBe(1);
    expect(withGameResult(newRun(), false).wins).toBe(0);
  });

  it('負けたらランはそこで終わり', () => {
    expect(runOutcomeAfter(newRun(), false)).toBe('over');
  });

  it('勝てば次の試合へ、最終戦に勝てばクリア', () => {
    const run = newRun();
    expect(runOutcomeAfter(run, true)).toBe('continue');
    expect(runOutcomeAfter({ ...run, game: RUN_GAMES - 1 }, true)).toBe('continue');
    expect(runOutcomeAfter({ ...run, game: RUN_GAMES }, true)).toBe('clear');
  });

  it('進行の表示は「何試合目 / 何勝」', () => {
    expect(runProgress(withGameResult(newRun(), true))).toEqual({
      game: 1,
      wins: 1,
      total: RUN_GAMES,
    });
  });
});

describe('runDoors: 次の相手の2択', () => {
  it('扉は2つで、相手・球場・系統がすべて決まっている', () => {
    const doors = runDoors(withGameResult(newRun(), true));
    expect(doors).toHaveLength(RUN_DOOR_COUNT);
    for (const door of doors) {
      expect(TEAMS.some((t) => t.id === door.opponent)).toBe(true);
      expect(BALLPARKS.some((p) => p.id === door.park)).toBe(true);
      // 系統は選ぶ前に見せる（F-26-5の絞り込み＝3つ）
      expect(door.lineages.length).toBeGreaterThan(0);
    }
  });

  it('同じシードなら毎回まったく同じ扉（ランごと再現できる）', () => {
    const a = runDoors(withGameResult(newRun(), true));
    const b = runDoors(withGameResult(newRun(), true));
    expect(b).toEqual(a);
  });

  it('扉ごとに相手が違い、自分の球団も対戦済みの球団も出てこない', () => {
    let state = newRun();
    for (let game = 1; game < RUN_GAMES; game += 1) {
      state = withGameResult(state, true);
      const doors = runDoors(state);
      expect(new Set(doors.map((d) => d.opponent)).size).toBe(doors.length);
      for (const door of doors) {
        expect(state.faced).not.toContain(door.opponent);
      }
      state = withNextGame(state, doors[0], state.skills);
    }
  });

  it('扉ごとにシードが違う＝選ぶ扉で系統・好調・抽選まで変わる', () => {
    const doors = runDoors(withGameResult(newRun(), true));
    expect(doors[0].seed).not.toBe(doors[1].seed);
  });
});

describe('withNextGame: 次の試合へ', () => {
  it('試合数が進み、選んだ扉が今の試合になる', () => {
    const run = withGameResult(newRun(), true);
    const door = runDoors(run)[1];
    const next = withNextGame(run, door, {});
    expect(next.game).toBe(2);
    expect(next.current).toEqual({ seed: door.seed, opponent: door.opponent, park: door.park });
    expect(next.faced).toContain(door.opponent);
  });

  it('持ち越すのはスキルだけ（球団・操作する側・采配はラン中ずっと同じ）', () => {
    const run = withGameResult(newRun(), true);
    const door = runDoors(run)[0];
    const carried = { [`${TEAMS[0].id}-b1`]: ['kinniku'] as const };
    const next = withNextGame(run, door, carried);
    expect(next.skills).toEqual(carried);
    expect(next.teamId).toBe(run.teamId);
    expect(next.side).toBe(run.side);
    expect(next.plan).toBe(run.plan);
  });

  /**
   * 消費型のチャージは**ラン全体で使い切り**（フェーズF-26-8）。ここを持ち越さないと
   * 試合ごとに全回復し、「いま使うか、温存して強化を狙うか」という判断が
   * 「毎試合使い切るのが正解」に潰れる。
   */
  it('消費型の使った回数も一緒に持ち越す（試合ごとに回復しない）', () => {
    const run = withGameResult(newRun(), true);
    const door = runDoors(run)[0];
    const id = `${TEAMS[0].id}-b1`;
    const next = withNextGame(run, door, { [id]: ['tetsugeta'] }, { [id]: { tetsugeta: 1 } });
    expect(next.uses[id]?.tetsugeta).toBe(1);
  });

  it('新しいランは誰も何も使っていない状態から始まる', () => {
    expect(newRun().uses).toEqual({});
  });
});

describe('preloadedSkills: 相手も同じだけ蓄積している', () => {
  const opponentOf = (game: number) =>
    preloadedSkills({ team: TEAMS[3].id, seed: gameSeed(SEED, game), game }).skills;

  it('初戦の相手は素のまま（まだ1試合も戦っていない）', () => {
    expect(opponentOf(1)).toEqual({});
  });

  it('試合数ぶんの抽選を済ませてくる（3試合目なら2試合ぶん）', () => {
    expect(skillCount(opponentOf(3))).toBe(2 * DRAFTS_PER_GAME);
    expect(skillCount(opponentOf(5))).toBe(4 * DRAFTS_PER_GAME);
  });

  it('試合が進むほど厚くなる', () => {
    let previous = 0;
    for (let game = 1; game <= RUN_GAMES; game += 1) {
      const count = skillCount(opponentOf(game));
      expect(count).toBeGreaterThanOrEqual(previous);
      previous = count;
    }
  });

  it('同じシード・同じ試合数なら毎回まったく同じ顔ぶれ（CPUの選択は決定的）', () => {
    expect(opponentOf(4)).toEqual(opponentOf(4));
  });

  it('枠と対象の不変条件を守る（投手専用が野手に付かない・枠を超えない）', () => {
    const roster = createTeamRoster(teamById(TEAMS[3].id));
    const skills = opponentOf(5);
    for (const id of Object.keys(skills)) {
      // デュオは枠上限の例外なので +1 まで許す
      expect(skills[id].length).toBeLessThanOrEqual(MAX_SKILLS_PER_PLAYER + 1);
      const canPitch = roster.players[id].pitching !== undefined;
      for (const skillId of skills[id]) {
        if (SKILLS[skillId].target === 'pitcher') expect(canPitch).toBe(true);
      }
    }
  });

  it('相手が変われば持ってくるものも変わる（球団ごとの投手・野手の顔ぶれが違うため）', () => {
    const a = preloadedSkills({ team: TEAMS[3].id, seed: gameSeed(SEED, 3), game: 3 }).skills;
    const b = preloadedSkills({ team: TEAMS[4].id, seed: gameSeed(SEED, 3), game: 3 }).skills;
    expect(Object.keys(a)[0]).not.toBe(Object.keys(b)[0]);
  });
});

describe('withCarriedSkills: 持ち越しの適用', () => {
  const teamId = TEAMS[0].id;
  const roster = () => createTeamRoster(teamById(teamId));

  it('前の試合で取ったスキルがそのまま乗る', () => {
    const id = roster().lineup[0];
    const next = withCarriedSkills(roster(), { [id]: ['kinniku', 'nebari'] });
    expect(skillsOf(next, id)).toEqual(['kinniku', 'nebari']);
  });

  it('デュオは前提のあとに適用される（取った順のまま載せるので消えない）', () => {
    const id = roster().lineup[0];
    const carried = { [id]: ['kinniku', 'nebari', 'yakyubaka'] as const };
    expect(skillsOf(withCarriedSkills(roster(), carried), id)).toHaveLength(3);
  });

  it('壊れた指定は黙って落ちる（存在しない選手・枠超過・対象外）', () => {
    const base = roster();
    const id = base.lineup[0];
    const next = withCarriedSkills(base, {
      'no-such-player': ['kinniku'],
      // 投手専用スキルは野手に付かない／枠を超えたぶんは落ちる
      [id]: ['tafunesu', 'kinniku', 'sukebo', 'yochi', 'shuchu'],
    });
    expect(next.players['no-such-player']).toBeUndefined();
    expect(skillsOf(next, id)).toEqual(['kinniku', 'sukebo', 'yochi']);
  });

  it('指定が無ければ素のロスターのまま（ランを通さない呼び出しは従来どおり）', () => {
    expect(withCarriedSkills(roster(), {}).skills).toEqual({});
  });
});

describe('MATCH_SETUP: 試合の始まりに持ち込むスキル', () => {
  it('両チームぶんの持ち越しが試合開始時のロスターに乗る', () => {
    const actor = createActor(gameMachine).start();
    const away = TEAMS[0].id;
    const home = TEAMS[1].id;
    actor.send({
      type: 'MATCH_SETUP',
      away,
      home,
      seed: SEED,
      skills: { away: { [`${away}-b1`]: ['kinniku'] }, home: { [`${home}-p1`]: ['tafunesu'] } },
    });
    const ctx = actor.getSnapshot().context;
    expect(skillsOf(ctx.rosters.away, `${away}-b1`)).toEqual(['kinniku']);
    expect(skillsOf(ctx.rosters.home, `${home}-p1`)).toEqual(['tafunesu']);
  });

  it('スキルを渡さなければ素のロスター（ラン化の前とまったく同じ）', () => {
    const actor = createActor(gameMachine).start();
    actor.send({ type: 'MATCH_SETUP', away: TEAMS[0].id, home: TEAMS[1].id });
    const ctx = actor.getSnapshot().context;
    expect(ctx.rosters.away.skills).toEqual({});
    expect(ctx.rosters.home.skills).toEqual({});
  });

  it('投球数・退場は持ち越さない（新しい試合は全員そろった状態から始まる）', () => {
    const actor = createActor(gameMachine).start();
    actor.send({ type: 'PITCH_THROWN' });
    expect(actor.getSnapshot().context.rosters.home.pitchCounts).not.toEqual({});
    // まだ1球目のカウントも動いていない＝isPreGame なので差し替えが効く
    actor.send({ type: 'MATCH_SETUP', away: TEAMS[0].id, home: TEAMS[1].id, seed: SEED });
    const ctx = actor.getSnapshot().context;
    expect(ctx.rosters.home.pitchCounts).toEqual({});
    expect(ctx.rosters.home.ejected).toEqual([]);
  });
});

describe('ランを5試合通す', () => {
  it('最後まで相手が重複せず、試合数と勝ち数が揃う', () => {
    const state = playThrough(newRun(), RUN_GAMES);
    expect(state.game).toBe(RUN_GAMES);
    expect(state.wins).toBe(RUN_GAMES - 1);
    expect(new Set(state.faced).size).toBe(state.faced.length);
    expect(runOutcomeAfter(state, true)).toBe('clear');
  });

  it('シードを固定すればラン全体（相手・球場・系統）が再現できる', () => {
    expect(playThrough(newRun(), RUN_GAMES)).toEqual(playThrough(newRun(), RUN_GAMES));
  });
});
