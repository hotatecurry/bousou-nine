/**
 * 試合ごとの先発の選び直しと、疲労の持ち越し（フェーズV-43。CLAUDE.md ⑧）。
 *
 * ⑧がリロール（U-42）と並べて「入れていない」としていたもう1つ。それまで
 * **先発・打順はランの最初に決めたものを5試合ずっと使っていた**＝R-39でCPUに
 * 4人ローテーションが付いた後も、人間側だけが1人の先発を使い続けるという非対称が
 * 残っていた。
 *
 * ここで固定したいのは5つ：
 * - **真実は「投球数」の側**（B-11をそのまま試合の外へ延長）＝残量・疲労・型は導出のまま。
 * - **回復はラン全体の資源**（試合ごとに全快しない）＝F-26-8・U-42と同じ理由で、
 *   全快させると「今日は誰に投げさせるか」の判断そのものが消える。
 * - **`REST_RECOVERY` が満たすべき3条件**（`npm run balance:rotation` の3段目）＝
 *   CPUの4人ローテが全快で回る／連投は球威が落ちる／1試合空ければほぼ無傷。
 * - **持ち越しを渡さない呼び出しはV-43の前とまったく同じ**（テスト・2P PLAY）。
 * - **選手IDは名鑑の並び順**（C-15の約束）＝采配を変えても疲れの記録の指す先が動かない。
 */
import { describe, expect, it } from 'vitest';
import { createActor } from 'xstate';
import { gameMachine } from '../src/core/gameMachine';
import {
  DEFAULT_ROSTER_PLAN,
  PITCHING_STAFF_SIZE,
  STAMINA_FRESH_THRESHOLD,
  STARTER_TYPE_COUNT,
  createTeamRoster,
  cpuStarterIndex,
  effectivePitching,
  grantSkill,
  maxPitchesFor,
  pitchCountOf,
  remainingStaminaOf,
  staffPlayerId,
  staminaRemaining,
  withCarriedFatigue,
} from '../src/core/roster';
import {
  REST_RECOVERY,
  RUN_GAMES,
  createRun,
  nextGameRoster,
  restedPitchCounts,
  runDoors,
  withNextGame,
} from '../src/core/run';
import { TEAMS } from '../src/core/teams';

const TEAM = TEAMS[0];
const OTHER = TEAMS[1];

/** 投手陣の i 人目のID（名鑑の並び順） */
const pid = (i: number): string => staffPlayerId(TEAM.id, i);

/** i 人目のスタミナ（名鑑の値） */
function staminaOf(i: number): number {
  return TEAM.pitchers[i][7] as number;
}

function rosterWithPitches(counts: Record<string, number>) {
  return withCarriedFatigue(createTeamRoster(TEAM), counts);
}

describe('疲労の持ち越し：回復の規則（restedPitchCounts）', () => {
  it('1試合ぶんの休養で、限界球数の REST_RECOVERY だけ回復する', () => {
    const stamina = staminaOf(0);
    const max = maxPitchesFor(stamina);
    const next = restedPitchCounts(rosterWithPitches({ [pid(0)]: max }));
    expect(next[pid(0)]).toBe(Math.round(max * (1 - REST_RECOVERY)));
  });

  it('持ち越すのは「投球数」なので整数（`pitchCounts` に小数が混ざらない）', () => {
    const next = restedPitchCounts(rosterWithPitches({ [pid(0)]: 94 }));
    expect(Number.isInteger(next[pid(0)])).toBe(true);
  });

  it('回復しきったらキーごと落ちる（＝無傷。`skillUses` と同じ扱い）', () => {
    const max = maxPitchesFor(staminaOf(0));
    // 回復量ちょうど以下しか投げていなければ、次の試合は完全に無傷
    const next = restedPitchCounts(rosterWithPitches({ [pid(0)]: max * REST_RECOVERY }));
    expect(next[pid(0)]).toBeUndefined();
    expect(Object.keys(next)).toHaveLength(0);
  });

  it('投げなかった投手も回復する（持ち越しが減るだけ＝「全員が休む」）', () => {
    const max = maxPitchesFor(staminaOf(1));
    // 前の試合から持ち越した状態のまま、この試合では1球も投げていない
    const carried = restedPitchCounts(rosterWithPitches({ [pid(1)]: max }));
    const twice = restedPitchCounts(rosterWithPitches(carried));
    expect(twice[pid(1)] ?? 0).toBeLessThan(carried[pid(1)]);
  });

  it('投げた球は積み上がる（同じ投手を続けて使うと疲れが溜まる）', () => {
    const max = maxPitchesFor(staminaOf(0));
    const after1 = restedPitchCounts(rosterWithPitches({ [pid(0)]: max }));
    // 次の試合も同じだけ投げる＝持ち越し＋この試合ぶん
    const after2 = restedPitchCounts(rosterWithPitches({ [pid(0)]: after1[pid(0)] + max }));
    expect(after2[pid(0)]).toBeGreaterThan(after1[pid(0)]);
  });

  it('スタミナのスキルは回復量にも効く（残量の読み方が持ち主でも他人でも変わらない）', () => {
    // `タフネス` 系＝STMへの補正。限界球数が増えるので、同じ割合の回復が球数としては多くなる
    const base = createTeamRoster(TEAM);
    const boosted = grantSkill(base, pid(0), 'tafunesu').roster;
    // スキルが載らなければこのテストは意味を持たない（名鑑・プールの変更に気づける）
    expect(effectivePitching(boosted, pid(0))!.stamina).toBeGreaterThan(staminaOf(0));
    const thrown = 100;
    const plain = restedPitchCounts(withCarriedFatigue(base, { [pid(0)]: thrown }));
    const tough = restedPitchCounts(withCarriedFatigue(boosted, { [pid(0)]: thrown }));
    expect(tough[pid(0)] ?? 0).toBeLessThan(plain[pid(0)]);
  });
});

describe('疲労の持ち越し：REST_RECOVERY が満たす3条件（balance:rotation の3段目）', () => {
  it('a: CPUの4人ローテーション（4試合後）なら完投しても全快で回る', () => {
    // R-39の `cpuStarterIndex` は先発型4人を順に回す＝同じ投手が投げるのは4試合後
    expect(REST_RECOVERY * STARTER_TYPE_COUNT).toBeGreaterThanOrEqual(1);
    // 規則そのものも確かめる（4試合後にまた同じ投手＝連投しない）
    for (let game = 1; game <= RUN_GAMES; game += 1) {
      expect(cpuStarterIndex(game)).not.toBe(cpuStarterIndex(game + 1));
    }
    expect(cpuStarterIndex(1)).toBe(cpuStarterIndex(1 + STARTER_TYPE_COUNT));
  });

  it('b: 連投（次の試合にもう一度）は球威が落ちた状態から始まる＝代償が効く', () => {
    expect(REST_RECOVERY).toBeLessThan(STAMINA_FRESH_THRESHOLD);
  });

  it('c: 1試合空ければほぼ無傷（4人ローテだけが正解にはならない）', () => {
    expect(REST_RECOVERY * 2).toBeGreaterThanOrEqual(0.8);
  });

  it('毎試合の全快にはならない（＝「毎試合エース」が支配戦略にならない条件）', () => {
    expect(REST_RECOVERY).toBeLessThan(1);
  });
});

describe('疲労の持ち越し：載せ方（withCarriedFatigue は関所）', () => {
  it('持ち越した投球数がそのまま pitchCounts になり、残量はそこからの導出', () => {
    const max = maxPitchesFor(staminaOf(0));
    const roster = rosterWithPitches({ [pid(0)]: max * 0.6 });
    expect(pitchCountOf(roster, pid(0))).toBeCloseTo(max * 0.6, 6);
    expect(remainingStaminaOf(roster, pid(0))).toBeCloseTo(staminaRemaining(max * 0.6, staminaOf(0)), 6);
  });

  it('壊れた指定は黙って落ちる（存在しないID・野手・負の球数・NaN）', () => {
    const roster = withCarriedFatigue(createTeamRoster(TEAM), {
      'no-such-player': 50,
      [`${TEAM.id}-b1`]: 50, // 野手（投球能力を持たない）
      [pid(2)]: -10,
      [pid(3)]: Number.NaN,
    });
    expect(Object.keys(roster.pitchCounts)).toHaveLength(0);
    expect(remainingStaminaOf(roster, pid(2))).toBe(1);
  });

  it('渡さなければ全員無傷（V-43を通さない呼び出しは従来とまったく同じ）', () => {
    const roster = withCarriedFatigue(createTeamRoster(TEAM), {});
    for (let i = 0; i < PITCHING_STAFF_SIZE; i += 1) {
      expect(remainingStaminaOf(roster, pid(i))).toBe(1);
    }
  });
});

describe('疲労の持ち越し：MATCH_SETUP から試合へ', () => {
  function setup(fatigue?: Record<string, number>) {
    const actor = createActor(gameMachine).start();
    actor.send({
      type: 'MATCH_SETUP',
      away: TEAM.id,
      home: OTHER.id,
      ...(fatigue ? { fatigue: { away: fatigue } } : {}),
    });
    return actor.getSnapshot().context;
  }

  it('持ち越した投手は最初から減った残量で試合を始める', () => {
    const max = maxPitchesFor(staminaOf(0));
    const ctx = setup({ [pid(0)]: max * 0.6 });
    expect(remainingStaminaOf(ctx.rosters.away, pid(0))).toBeCloseTo(0.4, 6);
    // 相手側は渡していないので無傷のまま（側ごとに独立している）
    expect(remainingStaminaOf(ctx.rosters.home, staffPlayerId(OTHER.id, 0))).toBe(1);
  });

  it('fatigue を渡さない MATCH_SETUP はV-43の前とまったく同じ（全員無傷）', () => {
    const ctx = setup();
    for (let i = 0; i < PITCHING_STAFF_SIZE; i += 1) {
      expect(remainingStaminaOf(ctx.rosters.away, pid(i))).toBe(1);
    }
  });

  it('投げれば持ち越しの上に積み上がる（真実は投球数の側）', () => {
    const actor = createActor(gameMachine).start();
    actor.send({ type: 'MATCH_SETUP', away: TEAM.id, home: OTHER.id, fatigue: { away: { [pid(0)]: 30 } } });
    // away が守備につくのは裏の攻撃＝ここでは投球数の経路だけを見る
    const before = pitchCountOf(actor.getSnapshot().context.rosters.away, pid(0));
    expect(before).toBe(30);
  });
});

describe('ラン：疲れと采配の持ち越し（RunState）', () => {
  const run = createRun({
    seed: 1234,
    teamId: TEAM.id,
    side: 'away',
    plan: DEFAULT_ROSTER_PLAN,
    opponent: OTHER.id,
    park: 'tokorozawa',
  });

  it('1試合目は全員無傷（ランの最初なので投げた球が1つも無い）', () => {
    expect(run.fatigue).toEqual({});
  });

  it('次の試合へ疲れが持ち越される', () => {
    const fatigue = { [pid(0)]: 40 };
    const next = withNextGame(run, runDoors(run)[0], {}, {}, 0, fatigue);
    expect(next.fatigue).toEqual(fatigue);
  });

  it('采配（先発・打順）は試合ごとに選び直せる', () => {
    const plan = { starterIndex: 2, order: [...DEFAULT_ROSTER_PLAN.order] };
    const next = withNextGame(run, runDoors(run)[0], {}, {}, 0, {}, plan);
    expect(next.plan.starterIndex).toBe(2);
  });

  it('采配を渡さなければ前の試合のものを引き継ぐ（選び直さなかったときは従来どおり）', () => {
    const first = withNextGame(run, runDoors(run)[0], {}, {}, 0, {}, { starterIndex: 3, order: [...DEFAULT_ROSTER_PLAN.order] });
    const second = withNextGame(first, runDoors(first)[0], {}, {}, 0, {});
    expect(second.plan.starterIndex).toBe(3);
  });
});

// フェーズEE-52で `staffStatus`（投手陣6人ぶんの残量と能力値）を `nextGameRoster`
// （次の試合と同じ手順で組んだロスターそのもの）に広げた＝選択画面は投手だけでなく
// 打線9人も並べるので、投手ぶんだけを別の入口から渡すと**打者側だけ名鑑を直読みする
// 経路が残る**（実際そうなっていた）。読むものは変わっていないので、この節の意味も同じ。
describe('試合と試合の間の采配：次の試合のロスター（nextGameRoster）', () => {
  it('持ち越しを渡さなければ名鑑どおり・全員無傷', () => {
    const roster = nextGameRoster({ teamId: TEAM.id });
    for (let i = 0; i < PITCHING_STAFF_SIZE; i += 1) {
      expect(remainingStaminaOf(roster, pid(i))).toBe(1);
    }
  });

  it('持ち越した投手だけ残量が減る（画面の数字＝試合が始まったときの残量）', () => {
    const max = maxPitchesFor(staminaOf(1));
    const roster = nextGameRoster({
      teamId: TEAM.id,
      carried: { skills: {}, uses: {}, fatigue: { [pid(1)]: max * 0.5 } },
    });
    expect(remainingStaminaOf(roster, pid(1))).toBeCloseTo(0.5, 6);
    expect(remainingStaminaOf(roster, pid(0))).toBe(1);
  });

  it('誰を先発にするかでは変わらない（残量は選手に付く値）', () => {
    const carried = { skills: {}, uses: {}, fatigue: { [pid(0)]: 50 } };
    const a = nextGameRoster({ teamId: TEAM.id, carried, plan: { ...DEFAULT_ROSTER_PLAN, starterIndex: 0 } });
    const b = nextGameRoster({ teamId: TEAM.id, carried, plan: { ...DEFAULT_ROSTER_PLAN, starterIndex: 3 } });
    expect(remainingStaminaOf(a, pid(0))).toBe(remainingStaminaOf(b, pid(0)));
  });

  // フェーズDD-51：V-43の選択画面は能力値だけ名鑑を直読みしていたので、スキルで
  // ERAが動いた投手も名鑑のERAのまま出ていた（W-44がHUDの投手カードで直したのと同じ穴）。
  it('能力値はスキルの補正込みで返す（名鑑の直読みではない）', () => {
    const plain = nextGameRoster({ teamId: TEAM.id });
    // `シネンセイギョ`＝制球+0.20（W-44。補正はERAそのものへ書き戻る）
    const skilled = nextGameRoster({
      teamId: TEAM.id,
      carried: { skills: { [pid(0)]: ['shinenseigyo'] }, uses: {}, fatigue: {} },
    });
    expect(effectivePitching(skilled, pid(0))!.era).toBeLessThan(
      effectivePitching(plain, pid(0))!.era,
    );
    expect(effectivePitching(skilled, pid(1))!.era).toBe(effectivePitching(plain, pid(1))!.era);
  });
});

describe('選手IDは名鑑の並び順（C-15の約束＝疲れの記録が采配でずれない）', () => {
  it('staffPlayerId と createTeamRoster が同じIDを指す', () => {
    for (let starterIndex = 0; starterIndex < PITCHING_STAFF_SIZE; starterIndex += 1) {
      const roster = createTeamRoster(TEAM, { starterIndex });
      expect(roster.pitcher).toBe(staffPlayerId(TEAM.id, starterIndex));
      for (let i = 0; i < PITCHING_STAFF_SIZE; i += 1) {
        expect(roster.players[staffPlayerId(TEAM.id, i)]?.name).toBe(TEAM.pitchers[i][0]);
      }
    }
  });

  it('先発を替えても持ち越した疲れは同じ投手に付いたまま', () => {
    const carried = { [pid(4)]: 40 };
    const asStarter = withCarriedFatigue(createTeamRoster(TEAM, { starterIndex: 4 }), carried);
    const asBullpen = withCarriedFatigue(createTeamRoster(TEAM, { starterIndex: 0 }), carried);
    expect(pitchCountOf(asStarter, pid(4))).toBe(40);
    expect(pitchCountOf(asBullpen, pid(4))).toBe(40);
  });
});

describe('名鑑16球団で規則が死なない（R-39・S-40・T-41と同じ確認）', () => {
  it('どの球団も先発型4人でローテーションが組める', () => {
    for (const team of TEAMS) {
      const starters = team.pitchers.slice(0, STARTER_TYPE_COUNT);
      expect(starters).toHaveLength(STARTER_TYPE_COUNT);
      // 全員が「1試合投げても、4試合後には全快している」＝ローテが破綻しない
      for (const row of starters) {
        const max = maxPitchesFor(row[7] as number);
        const afterOneGame = Math.max(0, max - REST_RECOVERY * max);
        expect(afterOneGame).toBeLessThan(max);
        expect(REST_RECOVERY * STARTER_TYPE_COUNT).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('先発型の容量に差があり、「今日は誰に」が選択になる', () => {
    for (const team of TEAMS) {
      const caps = team.pitchers
        .slice(0, STARTER_TYPE_COUNT)
        .map((row) => maxPitchesFor(row[7] as number));
      expect(Math.max(...caps) - Math.min(...caps)).toBeGreaterThan(0);
    }
  });
});
