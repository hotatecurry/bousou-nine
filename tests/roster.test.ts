import { describe, expect, it } from 'vitest';
import {
  advanceBatter,
  canPinchHit,
  cpuRosterPlan,
  cpuStarterIndex,
  createTeamRoster,
  currentBatterId,
  currentBatterPosition,
  displayAverage,
  displayHomeRuns,
  effectiveBattingHand,
  pitchArmOf,
  formatAverage,
  formatEra,
  ejectBatterAndSubstitute,
  ejectPitcherAndSubstitute,
  fatigueFromRemaining,
  fatigueOf,
  fielderThrowArm,
  hasAvailablePinchHitter,
  hasAvailableReliever,
  maxPitchesFor,
  pitchCountOf,
  pitcherRole,
  playerAtPosition,
  positionOf,
  recordPitch,
  remainingStaminaOf,
  setLineupIndex,
  staminaRemaining,
  substituteBatterAt,
  substitutePitcherAt,
  swapBattingOrder,
  normalizeRosterPlan,
  BENCH_SIZE,
  BULLPEN_SIZE,
  DEFAULT_ROSTER_PLAN,
  DISPLAY_AVG_MIN,
  DISPLAY_AVG_SPAN,
  DISPLAY_HR_MAX,
  PITCHER_ORDER_SLOT,
  PITCHING_STAFF_SIZE,
  STARTER_TYPE_COUNT,
  STAMINA_FRESH_THRESHOLD,
  STAMINA_MIN_PITCHES,
  STAMINA_PITCH_SPAN,
  type FieldingPosition,
  type TeamRoster,
} from '../src/core/roster';
import { LEFT_ARM_SIDE, NEUTRAL_PITCH_ARM, RIGHT_ARM_SIDE } from '../src/core/pitch';
import { TEAMS, teamById } from '../src/core/teams';

/**
 * ロスターの構造・交代の規則を確かめるテストなので、**能力値の中身に依存しない**
 * 1球団だけを使う（フェーズB-12で16球団になったが、構造はどの球団でも同じ）。
 * バランス型のフォレスターズを基準球団として使う（名鑑側のコメント参照）。
 * 名鑑そのものの検証は `tests/teams.test.ts` の担当。
 */
const TEST_TEAM = teamById('foresters');

const ALL_POSITIONS: readonly FieldingPosition[] = [
  'P',
  'C',
  '1B',
  '2B',
  '3B',
  'SS',
  'LF',
  'CF',
  'RF',
];

/**
 * このロスター構造の不変条件（フェーズB-10）：**9つの守備位置がすべて別の選手で埋まり、
 * その9人が打順9人とちょうど一致する**（原作にDH制は無い＝投手も打順に入る）。
 * 交代のたびにこれが崩れていないかを確かめるためのヘルパー。
 */
function expectPositionsMatchLineup(roster: TeamRoster): void {
  const fielders = ALL_POSITIONS.map((position) => roster.positions[position]);
  expect(fielders).toHaveLength(9);
  expect(new Set(fielders).size).toBe(9); // 同じ選手が2か所を守らない
  expect(new Set(fielders)).toEqual(new Set(roster.lineup));
}

describe('createTeamRoster（ロスター生成）', () => {
  it('打順9人・控え3人・先発投手1人・ブルペン5人を持つ', () => {
    const roster = createTeamRoster(TEST_TEAM);
    expect(roster.lineup).toHaveLength(9);
    expect(roster.bench).toHaveLength(BENCH_SIZE);
    expect(roster.bullpen).toHaveLength(BULLPEN_SIZE);
    expect(roster.lineupIndex).toBe(0);
    expect(roster.ejected).toEqual([]);
  });

  it('打順の先頭が現在の打者', () => {
    const roster = createTeamRoster(TEST_TEAM);
    expect(currentBatterId(roster)).toBe(roster.lineup[0]);
  });
});

describe('試合前の采配（フェーズC-15：先発投手選択・打順入替）', () => {
  /** 打順の並びを「名鑑の何番目の選手か」で書き出す（順列としての中身を見るため） */
  const orderOf = (roster: TeamRoster): number[] =>
    roster.lineup.map((id) =>
      id === roster.pitcher ? PITCHER_ORDER_SLOT : Number(id.split('-b')[1]) - 1,
    );

  it('采配を渡さなければ名鑑どおり（C-15の前とまったく同じロスター）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    expect(roster.players[roster.pitcher].name).toBe(TEST_TEAM.pitchers[0][0]);
    expect(roster.pitcherSlot).toBe(PITCHER_ORDER_SLOT);
    expect(orderOf(roster)).toEqual([...DEFAULT_ROSTER_PLAN.order]);
    // ブルペンは名鑑の残り5人が並び順のまま
    expect(roster.bullpen.map((id) => roster.players[id].name)).toEqual(
      TEST_TEAM.pitchers.slice(1).map((row) => row[0]),
    );
  });

  it('先発を選ぶと、その投手がマウンドと打順に入り、残り5人がブルペンになる', () => {
    const roster = createTeamRoster(TEST_TEAM, { starterIndex: 2 });
    expect(roster.players[roster.pitcher].name).toBe(TEST_TEAM.pitchers[2][0]);
    // マウンドと守備位置Pと打順スロットの3つが同じ選手を指す（B-10の不変条件）
    expect(roster.positions.P).toBe(roster.pitcher);
    expect(roster.lineup[roster.pitcherSlot]).toBe(roster.pitcher);
    expect(roster.bullpen).toHaveLength(BULLPEN_SIZE);
    expect(roster.bullpen).not.toContain(roster.pitcher);
    // 選ばれなかった投手は名鑑の並び（先発型→リリーフ型）のままブルペンに入る
    expect(roster.bullpen.map((id) => roster.players[id].name)).toEqual(
      TEST_TEAM.pitchers.filter((_, i) => i !== 2).map((row) => row[0]),
    );
    expectPositionsMatchLineup(roster);
  });

  it('選手IDは采配で変わらない（同じ選手はどの先発を選んでも同じID）', () => {
    const a = createTeamRoster(TEST_TEAM);
    const b = createTeamRoster(TEST_TEAM, { starterIndex: 3, order: [8, 7, 6, 5, 4, 3, 2, 1, 0] });
    // IDは名鑑の並び順から作る＝走者・投球数・退場の記録が采配でずれない
    expect(Object.keys(b.players).sort()).toEqual(Object.keys(a.players).sort());
    for (const id of Object.keys(a.players)) {
      expect(b.players[id].name).toBe(a.players[id].name);
    }
  });

  it('打順を入れ替えると打つ順番だけが変わり、守備位置は選手に付いて回る', () => {
    const base = createTeamRoster(TEST_TEAM);
    // 1番と4番を入れ替える
    const order = swapBattingOrder(DEFAULT_ROSTER_PLAN.order, 0, 3);
    const roster = createTeamRoster(TEST_TEAM, { order });
    expect(roster.lineup[0]).toBe(base.lineup[3]);
    expect(roster.lineup[3]).toBe(base.lineup[0]);
    // 守備位置は元のまま（打順入替は守りを動かさない）
    expect(roster.positions).toEqual(base.positions);
    expectPositionsMatchLineup(roster);
  });

  it('投手を打順のどこに置くかも采配のうち（pitcherSlot が並びに追従する）', () => {
    // 投手を1番に置く（9番の野手が9番のまま残る形）
    const order = swapBattingOrder(DEFAULT_ROSTER_PLAN.order, 0, PITCHER_ORDER_SLOT);
    const roster = createTeamRoster(TEST_TEAM, { order });
    expect(roster.pitcherSlot).toBe(0);
    expect(roster.lineup[0]).toBe(roster.pitcher);
    expect(currentBatterId(roster)).toBe(roster.pitcher);
    expectPositionsMatchLineup(roster);
  });

  it('打順を入れ替えても9人がちょうど1回ずつ入る（同じ選手が2度打たない）', () => {
    const order = [4, 8, 0, 7, 1, 6, 2, 5, 3];
    const roster = createTeamRoster(TEST_TEAM, { order });
    expect(new Set(roster.lineup).size).toBe(9);
    expect(orderOf(roster)).toEqual(order);
    expectPositionsMatchLineup(roster);
  });

  it('壊れた采配は既定へ落ちる（打順に同じ選手が2人いるロスターを作らせない）', () => {
    const staff = PITCHING_STAFF_SIZE;
    // 先発の範囲外・小数・負値
    for (const starterIndex of [-1, staff, staff + 10, 1.5, Number.NaN]) {
      expect(normalizeRosterPlan({ starterIndex }, staff).starterIndex).toBe(0);
    }
    // 打順が順列でない（重複・欠け・長さ違い・範囲外）
    for (const order of [
      [0, 0, 1, 2, 3, 4, 5, 6, 7],
      [0, 1, 2, 3, 4, 5, 6, 7],
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 8],
      [0, 1, 2, 3, 4, 5, 6, 7, 9],
      [0, 1, 2, 3, 4, 5, 6, 7, 1.5],
    ]) {
      expect(normalizeRosterPlan({ order }, staff).order).toEqual([...DEFAULT_ROSTER_PLAN.order]);
    }
    // 片方だけ壊れていても、もう片方は活かす
    const mixed = normalizeRosterPlan({ starterIndex: 3, order: [0, 0, 0] }, staff);
    expect(mixed.starterIndex).toBe(3);
    expect(mixed.order).toEqual([...DEFAULT_ROSTER_PLAN.order]);
    // 壊れた采配で組んでも不変条件は崩れない
    const roster = createTeamRoster(TEST_TEAM, { starterIndex: 99, order: [1, 1, 1] });
    expect(roster.players[roster.pitcher].name).toBe(TEST_TEAM.pitchers[0][0]);
    expectPositionsMatchLineup(roster);
  });

  it('swapBattingOrder は2か所だけを入れ替え、元の並びは変えない（純粋関数）', () => {
    const order = DEFAULT_ROSTER_PLAN.order;
    const swapped = swapBattingOrder(order, 1, 5);
    expect(swapped[1]).toBe(order[5]);
    expect(swapped[5]).toBe(order[1]);
    expect([...order]).toEqual([...DEFAULT_ROSTER_PLAN.order]); // 元は不変
    expect(new Set(swapped).size).toBe(order.length); // 順列のまま
  });

  it('swapBattingOrder は範囲外・同一スロットなら元の並びをそのまま返す', () => {
    const order = DEFAULT_ROSTER_PLAN.order;
    for (const [a, b] of [
      [-1, 0],
      [0, 9],
      [3, 3],
    ]) {
      expect(swapBattingOrder(order, a, b)).toBe(order); // 参照ごと不変
    }
  });

  it('采配を決めたロスターでも交代の規則は変わらない（代打・継投）', () => {
    // 投手を3番に置き、先発も入れ替えた状態で代打→継投を通す
    const order = swapBattingOrder(DEFAULT_ROSTER_PLAN.order, 2, PITCHER_ORDER_SLOT);
    let roster = createTeamRoster(TEST_TEAM, { starterIndex: 1, order });
    expect(roster.pitcherSlot).toBe(2);

    // 投手の打席（3番）へ代打を送ると自動継投する（B-10の規則）
    roster = setLineupIndex(roster, 2);
    const relieverToBe = roster.bullpen[0];
    const { roster: afterPinch, ok } = substituteBatterAt(roster, 0);
    expect(ok).toBe(true);
    expect(afterPinch.pitcher).toBe(relieverToBe);
    expect(currentBatterId(afterPinch)).toBe(roster.bench[0]);
    // 打席が終われば新しい投手が3番のスロットを引き継ぐ（ずれは1打席で解消）
    const advanced = advanceBatter(afterPinch);
    expect(advanced.lineup[advanced.pitcherSlot]).toBe(advanced.pitcher);
    expectPositionsMatchLineup(advanced);
  });
});

describe('CPUの試合前の采配（フェーズR-39）', () => {
  it('先発は先発型4人を試合ごとに順に回す（ローテーション）', () => {
    expect([1, 2, 3, 4, 5].map(cpuStarterIndex)).toEqual([0, 1, 2, 3, 0]);
  });

  it('回すのは先発型だけ＝リリーフ型（下2人）は先発しない', () => {
    for (let game = 1; game <= 12; game += 1) {
      const roster = createTeamRoster(TEST_TEAM, cpuRosterPlan(game));
      expect(pitcherRole(roster.players[roster.pitcher].pitching!.stamina)).toBe('starter');
    }
  });

  it('試合番号が変われば実際に別の投手が投げる（相手の持ち味が試合ごとに変わる）', () => {
    const names = [1, 2, 3, 4].map((game) => {
      const roster = createTeamRoster(TEST_TEAM, cpuRosterPlan(game));
      return roster.players[roster.pitcher].name;
    });
    expect(new Set(names).size).toBe(4);
  });

  it('打順は名鑑どおり（計測の結論。組み替えても得点期待が上がらない）', () => {
    for (const game of [1, 3, 5]) {
      expect([...cpuRosterPlan(game).order]).toEqual([...DEFAULT_ROSTER_PLAN.order]);
    }
  });

  it('決定的で、壊れた試合番号でも成立する采配になる（0以下・小数）', () => {
    expect(cpuRosterPlan(3)).toEqual(cpuRosterPlan(3));
    for (const game of [0, -5, 2.7]) {
      const plan = cpuRosterPlan(game);
      expect(plan.starterIndex).toBeGreaterThanOrEqual(0);
      expect(plan.starterIndex).toBeLessThan(STARTER_TYPE_COUNT);
      // normalizeRosterPlan（C-15の関所）を通しても落とされない＝そのまま使える
      expect(normalizeRosterPlan(plan, TEST_TEAM.pitchers.length)).toEqual(plan);
    }
  });
});

describe('advanceBatter（打順の進行）', () => {
  it('打順インデックスが1つ進む', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const next = advanceBatter(roster);
    expect(next.lineupIndex).toBe(1);
  });

  it('9番の次は1番に戻る（一巡）', () => {
    let roster = createTeamRoster(TEST_TEAM);
    for (let i = 0; i < 9; i++) roster = advanceBatter(roster);
    expect(roster.lineupIndex).toBe(0);
  });
});

describe('setLineupIndex（打順の巻き戻し）', () => {
  it('指定したインデックスに設定する', () => {
    let roster = createTeamRoster(TEST_TEAM);
    roster = advanceBatter(advanceBatter(roster));
    expect(roster.lineupIndex).toBe(2);
    roster = setLineupIndex(roster, 0);
    expect(roster.lineupIndex).toBe(0);
  });
});

describe('ejectBatterAndSubstitute（打者の退場・代打）', () => {
  it('控えがいれば代打が同じ打順スロットに入り、控えが1人減る', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const outgoing = currentBatterId(roster);
    const { roster: next, ok } = ejectBatterAndSubstitute(roster);
    expect(ok).toBe(true);
    expect(next.lineup[0]).not.toBe(outgoing);
    expect(next.lineup[0]).toBe(roster.bench[0]);
    expect(next.bench).toHaveLength(2);
    expect(next.lineupIndex).toBe(0); // 打順スロットは変わらない（同じ打席が続く）
    expect(next.ejected).toEqual([outgoing]);
  });

  it('控えが尽きていれば ok: false（没収試合の判定材料）', () => {
    let roster = createTeamRoster(TEST_TEAM);
    for (let i = 0; i < 3; i++) {
      roster = ejectBatterAndSubstitute(roster).roster;
    }
    expect(hasAvailablePinchHitter(roster)).toBe(false);
    const result = ejectBatterAndSubstitute(roster);
    expect(result.ok).toBe(false);
    expect(result.roster.ejected).toHaveLength(4);
  });
});

describe('ejectPitcherAndSubstitute（投手の退場・継投）', () => {
  it('ブルペンがいれば救援投手が投手に入り、ブルペンが1人減る', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const outgoing = roster.pitcher;
    const { roster: next, ok } = ejectPitcherAndSubstitute(roster);
    expect(ok).toBe(true);
    expect(next.pitcher).not.toBe(outgoing);
    expect(next.pitcher).toBe(roster.bullpen[0]);
    expect(next.bullpen).toHaveLength(BULLPEN_SIZE - 1);
    expect(next.ejected).toEqual([outgoing]);
  });

  it('ブルペンが尽きていれば ok: false（没収試合の判定材料）', () => {
    let roster = createTeamRoster(TEST_TEAM);
    for (let i = 0; i < BULLPEN_SIZE; i++) {
      roster = ejectPitcherAndSubstitute(roster).roster;
    }
    expect(hasAvailableReliever(roster)).toBe(false);
    const result = ejectPitcherAndSubstitute(roster);
    expect(result.ok).toBe(false);
    expect(result.roster.ejected).toHaveLength(BULLPEN_SIZE + 1);
  });
});

describe('substituteBatterAt（采配メニューからの任意代打）', () => {
  it('指定インデックスの控えが同じ打順スロットに入り、その1人だけ控えから抜ける', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const outgoing = currentBatterId(roster);
    const { roster: next, ok } = substituteBatterAt(roster, 1);
    expect(ok).toBe(true);
    expect(next.lineup[0]).toBe(roster.bench[1]);
    // 指定した1人だけが抜け、残りの並び順は維持される（末尾詰めしない）
    expect(next.bench).toEqual([roster.bench[0], roster.bench[2]]);
    expect(next.ejected).toEqual([outgoing]);
  });

  it('範囲外インデックスなら roster を一切変更せず ok: false（防御的ガード）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const { roster: next, ok } = substituteBatterAt(roster, 99);
    expect(ok).toBe(false);
    expect(next).toBe(roster); // 参照ごと不変（何も起きない）
  });

  it('控えが空でも roster を変更しない（ejectBatterAndSubstitute と異なり ejected に積まない）', () => {
    let roster = createTeamRoster(TEST_TEAM);
    for (let i = 0; i < 3; i++) roster = ejectBatterAndSubstitute(roster).roster;
    expect(roster.bench).toHaveLength(0);
    const { roster: next, ok } = substituteBatterAt(roster, 0);
    expect(ok).toBe(false);
    expect(next).toBe(roster);
  });
});

describe('substitutePitcherAt（采配メニューからの任意継投）', () => {
  it('指定インデックスの救援投手が投手に入り、その1人だけブルペンから抜ける', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const outgoing = roster.pitcher;
    const { roster: next, ok } = substitutePitcherAt(roster, 2);
    expect(ok).toBe(true);
    expect(next.pitcher).toBe(roster.bullpen[2]);
    expect(next.bullpen).toEqual(roster.bullpen.filter((_, i) => i !== 2));
    expect(next.ejected).toEqual([outgoing]);
  });

  it('範囲外インデックスなら roster を一切変更せず ok: false', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const { roster: next, ok } = substitutePitcherAt(roster, -1);
    expect(ok).toBe(false);
    expect(next).toBe(roster);
  });
});

describe('能力値（フェーズB-8：説明書p26-29の項目体系・数値は独自）', () => {
  const roster = createTeamRoster(TEST_TEAM);
  const all = Object.values(roster.players);

  it('全選手が打撃能力を持ち、値は 0..1 に収まっている', () => {
    expect(all.length).toBeGreaterThan(0);
    for (const p of all) {
      for (const v of [p.batting.average, p.batting.power, p.batting.run]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(['R', 'L', 'S']).toContain(p.batting.bats);
    }
  });

  it('投手だけが投球能力を持ち、値は 0..1 に収まっている', () => {
    const pitcherIds = [roster.pitcher, ...roster.bullpen];
    for (const p of all) {
      const isPitcher = pitcherIds.includes(p.id);
      expect(p.pitching !== undefined).toBe(isPitcher);
      if (!p.pitching) continue;
      for (const v of [
        p.pitching.speed,
        p.pitching.breakRight,
        p.pitching.breakLeft,
        p.pitching.fork,
        p.pitching.stamina,
      ]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(['R', 'L', 'S', 'U']).toContain(p.pitching.throws);
      expect(p.pitching.era).toBeGreaterThan(0);
    }
  });

  /**
   * 「誰を使うか」に意味を持たせるための最低条件＝打線の中に役割の差が実際にあること。
   * 数値を平坦にすると（全員同じ能力値だと）能力値モデルを入れた意味がなくなるので固定する。
   */
  it('打順に役割の差がある（1番は俊足・4番は長打力）', () => {
    const leadoff = roster.players[roster.lineup[0]].batting;
    const cleanup = roster.players[roster.lineup[3]].batting;
    expect(leadoff.run).toBeGreaterThan(cleanup.run);
    expect(cleanup.power).toBeGreaterThan(leadoff.power);
  });

  it('投手陣にも持ち味の差がある（速球派と技巧派で球速・変化量が逆転する）', () => {
    const stats = [roster.pitcher, ...roster.bullpen].map((id) => roster.players[id].pitching!);
    const fastest = stats.reduce((a, b) => (a.speed > b.speed ? a : b));
    const bendiest = stats.reduce((a, b) => (a.breakLeft > b.breakLeft ? a : b));
    expect(fastest).not.toBe(bendiest);
    expect(fastest.breakLeft).toBeLessThan(bendiest.breakLeft);
    expect(bendiest.speed).toBeLessThan(fastest.speed);
  });

  it('投手の打撃は野手より非力（原作同様に投手も打席に立つ）', () => {
    const pitcherBatting = roster.players[roster.pitcher].batting;
    // 投手も打順に入る（フェーズB-10）ので、比較対象は「投手以外の8守備位置」に絞る
    const worstFielder = (Object.keys(roster.positions) as FieldingPosition[])
      .filter((position) => position !== 'P')
      .map((position) => roster.players[roster.positions[position]].batting)
      .reduce((a, b) => (a.power < b.power ? a : b));
    expect(pitcherBatting.power).toBeLessThan(worstFielder.power);
  });
});

describe('守備位置の割当（フェーズB-10）', () => {
  it('9つの守備位置がすべて埋まり、打順9人と過不足なく一致する', () => {
    expectPositionsMatchLineup(createTeamRoster(TEST_TEAM));
  });

  it('投手は打順の9番に入る（原作にDH制は無い）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    expect(roster.pitcherSlot).toBe(8);
    expect(roster.lineup[roster.pitcherSlot]).toBe(roster.pitcher);
    expect(roster.positions.P).toBe(roster.pitcher);
  });

  it('pitcher は positions.P の派生ビュー（継投しても食い違わない）', () => {
    let roster = createTeamRoster(TEST_TEAM);
    for (const bullpenIndex of [2, 1, 0]) {
      roster = substitutePitcherAt(roster, bullpenIndex).roster;
      expect(roster.pitcher).toBe(roster.positions.P);
    }
  });

  it('positionOf / playerAtPosition が逆写像になっている', () => {
    const roster = createTeamRoster(TEST_TEAM);
    for (const position of ALL_POSITIONS) {
      const player = playerAtPosition(roster, position);
      expect(positionOf(roster, player.id)).toBe(position);
    }
  });

  it('守備位置についていない選手（控え）は positionOf が null', () => {
    const roster = createTeamRoster(TEST_TEAM);
    expect(positionOf(roster, roster.bench[0])).toBeNull();
  });

  it('打順を一巡すると9番で投手が打席に立つ', () => {
    let roster = createTeamRoster(TEST_TEAM);
    const batters: string[] = [];
    for (let i = 0; i < 9; i++) {
      batters.push(currentBatterId(roster));
      roster = advanceBatter(roster);
    }
    expect(batters[8]).toBe(roster.pitcher);
    expect(currentBatterPosition(setLineupIndex(roster, 8))).toBe('P');
  });
});

describe('代打と守備位置の引き継ぎ（フェーズB-10）', () => {
  it('代打は退いた選手の守備位置をそのまま引き継ぐ', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const outgoing = currentBatterId(roster); // 1番＝中堅手
    const position = positionOf(roster, outgoing)!;
    expect(position).toBe('CF');

    const { roster: next, ok } = substituteBatterAt(roster, 1);
    expect(ok).toBe(true);
    expect(next.positions[position]).toBe(roster.bench[1]);
    expect(positionOf(next, outgoing)).toBeNull();
    expectPositionsMatchLineup(next);
  });

  it('投手の打席への代打はブルペン先頭を自動継投させる（代打はマウンドを継がない）', () => {
    const roster = setLineupIndex(createTeamRoster(TEST_TEAM), 8);
    const startingPitcher = roster.pitcher;
    const reliever = roster.bullpen[0];

    const { roster: next, ok } = substituteBatterAt(roster, 0);
    expect(ok).toBe(true);
    // 打順スロットは代打が、守備位置Pは新投手が取る
    expect(currentBatterId(next)).toBe(roster.bench[0]);
    expect(next.pitcher).toBe(reliever);
    expect(next.positions.P).toBe(reliever);
    expect(next.bullpen).toHaveLength(BULLPEN_SIZE - 1);
    expect(next.bench).toHaveLength(BENCH_SIZE - 1);
    expect(next.ejected).toEqual([startingPitcher]);
  });

  it('その打席が終わると新投手が打順スロットを引き継ぎ、代打は退く', () => {
    const roster = setLineupIndex(createTeamRoster(TEST_TEAM), 8);
    const pinchHitter = roster.bench[0];
    const substituted = substituteBatterAt(roster, 0).roster;
    // 代打が入っている間だけ打順9人と守備9人がずれる（打席が終わるまでの一時的な状態）
    expect(new Set(Object.values(substituted.positions))).not.toEqual(new Set(substituted.lineup));

    const next = advanceBatter(substituted);
    expect(next.lineup[next.pitcherSlot]).toBe(next.pitcher);
    expect(next.ejected).toContain(pinchHitter);
    expectPositionsMatchLineup(next);
  });

  it('通常の打席では advanceBatter が打順に触れない（打順スロットの巻き戻しは起きない）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const next = advanceBatter(roster);
    expect(next.lineup).toEqual(roster.lineup);
    expect(next.ejected).toEqual([]);
  });

  it('ブルペンが尽きていれば投手の打席へは代打を送れない（rosterを一切変更しない）', () => {
    let roster = createTeamRoster(TEST_TEAM);
    for (let i = 0; i < BULLPEN_SIZE; i++) roster = substitutePitcherAt(roster, 0).roster;
    expect(hasAvailableReliever(roster)).toBe(false);

    roster = setLineupIndex(roster, 8);
    expect(hasAvailablePinchHitter(roster)).toBe(true); // 控えは残っている
    expect(canPinchHit(roster)).toBe(false); // が、守備位置Pを埋められないので送れない
    const { roster: next, ok } = substituteBatterAt(roster, 0);
    expect(ok).toBe(false);
    expect(next).toBe(roster);
  });

  it('投手の打席で2人目の代打を送っても二重に継投しない', () => {
    const roster = setLineupIndex(createTeamRoster(TEST_TEAM), 8);
    const first = substituteBatterAt(roster, 0).roster;
    const reliever = first.pitcher;

    const { roster: second, ok } = substituteBatterAt(first, 0);
    expect(ok).toBe(true);
    expect(second.pitcher).toBe(reliever); // マウンドは変わらない
    expect(second.bullpen).toEqual(first.bullpen);
    expect(second.ejected).toContain(roster.bench[0]); // 退いたのは1人目の代打
  });

  it('乱闘で投手が打席のまま負け、ブルペンが尽きていれば ok:false（没収試合の判定材料）', () => {
    let roster = createTeamRoster(TEST_TEAM);
    for (let i = 0; i < BULLPEN_SIZE; i++) roster = substitutePitcherAt(roster, 0).roster;
    roster = setLineupIndex(roster, 8);
    const result = ejectBatterAndSubstitute(roster);
    expect(result.ok).toBe(false);
    expect(result.roster.ejected).toContain(roster.pitcher);
  });
});

describe('継投と打順（フェーズB-10）', () => {
  it('救援投手は守備位置Pと投手の打順スロットの両方を引き継ぐ', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const outgoing = roster.pitcher;
    const { roster: next } = substitutePitcherAt(roster, 1);

    expect(next.positions.P).toBe(roster.bullpen[1]);
    expect(next.lineup[next.pitcherSlot]).toBe(roster.bullpen[1]);
    expect(next.lineup).not.toContain(outgoing);
    expectPositionsMatchLineup(next);
  });

  it('投手の打席に代打が入っている間は継投しても打順に触れない', () => {
    const roster = setLineupIndex(createTeamRoster(TEST_TEAM), 8);
    const substituted = substituteBatterAt(roster, 0).roster; // 自動継投で投2がマウンドへ
    const pinchHitter = currentBatterId(substituted);

    const { roster: next } = substitutePitcherAt(substituted, 0); // さらに投3へ継投
    expect(currentBatterId(next)).toBe(pinchHitter); // 打席は代打のまま
    expect(next.lineup[next.pitcherSlot]).toBe(pinchHitter);

    // 打席が終われば、そのとき最後にマウンドにいる投手が打順を引き継ぐ
    const after = advanceBatter(next);
    expect(after.lineup[after.pitcherSlot]).toBe(next.pitcher);
    expectPositionsMatchLineup(after);
  });

  it('代打・継投をどう混ぜても「守備9人＝打順9人」は打席の終わりごとに保たれる', () => {
    let roster = createTeamRoster(TEST_TEAM);
    // 1番に代打 → 打席終了 → 9番（投手）まで進めて代打（自動継投）→ 打席終了 → 継投
    roster = advanceBatter(substituteBatterAt(roster, 0).roster);
    expectPositionsMatchLineup(roster);
    for (let i = 1; i < 8; i++) roster = advanceBatter(roster);
    expect(roster.lineupIndex).toBe(8);
    roster = advanceBatter(substituteBatterAt(roster, 0).roster);
    expectPositionsMatchLineup(roster);
    roster = substitutePitcherAt(roster, 0).roster;
    expectPositionsMatchLineup(roster);
  });
});

describe('pitchArmOf（名鑑のARM → 投球腕。フェーズCC-50）', () => {
  it('R は三塁側（-X）の上手・L は一塁側（+X）の上手', () => {
    expect(pitchArmOf('R')).toEqual({ side: RIGHT_ARM_SIDE, slot: 'over' });
    expect(pitchArmOf('L')).toEqual({ side: LEFT_ARM_SIDE, slot: 'over' });
  });

  /**
   * B-9（`effectiveBattingHand`）の取り決めをそのまま延長する＝S・U は腕の左右ではなく
   * 投げ方なので、**腕の側は右**。ここが食い違うと「両打ちが左打席に立っているのに
   * 投手は左腕で投げている」が起きる（下のテストがその一致を固定する）。
   */
  it('S・U は右腕（B-9の両打ちの読み方と同じ）で、スロットだけが違う', () => {
    expect(pitchArmOf('S')).toEqual({ side: RIGHT_ARM_SIDE, slot: 'side' });
    expect(pitchArmOf('U')).toEqual({ side: RIGHT_ARM_SIDE, slot: 'under' });
  });

  it('投球腕の側と、両打ちが立つ打席の読み方が必ず一致する', () => {
    for (const throws of ['R', 'L', 'S', 'U'] as const) {
      const leftArm = pitchArmOf(throws).side === LEFT_ARM_SIDE;
      // 両打ちは投手と逆の打席に立つ＝左投手なら右打席
      expect(effectiveBattingHand('S', throws)).toBe(leftArm ? 'R' : 'L');
    }
  });
});

describe('fielderThrowArm（送球するときの腕。フェーズHH-55）', () => {
  const FIELDERS_WITHOUT_ARM: FieldingPosition[] = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'];

  /**
   * 原作の名鑑（説明書p26-29）にARMがあるのは投手だけ。**データの無いものを推測で
   * 散らさない**ので、野手8人は既定（右の上手）で揃う＝渡さない呼び出しと同じ値。
   */
  it('投手以外はARMを持たないので全員が既定（右の上手）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    for (const pos of FIELDERS_WITHOUT_ARM) {
      expect(fielderThrowArm(roster, pos)).toEqual(NEUTRAL_PITCH_ARM);
    }
  });

  it('投手は名鑑のARMどおりに投げる（でっかいモードの投球姿勢と同じ読み方）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const starter = roster.players[roster.positions.P];
    expect(starter.pitching).toBeDefined();
    expect(fielderThrowArm(roster, 'P')).toEqual(pitchArmOf(starter.pitching!.throws));
  });

  /**
   * **真実は `positions.P` の側**（B-10）。ここを `roster.pitcher`（派生ビュー）から
   * 引くと、継投したのに送球の腕だけ前の投手のまま、という食い違いが生まれうる。
   */
  it('継投すると送球の腕もマウンドの投手のものに替わる', () => {
    const roster = createTeamRoster(TEST_TEAM);
    // 名鑑のARMが先発と違うブルペン投手を選ぶ（差が無ければこのテストは何も見ていない）
    const before = fielderThrowArm(roster, 'P');
    const index = roster.bullpen.findIndex((id) => {
      const p = roster.players[id].pitching;
      return p !== undefined && pitchArmOf(p.throws).slot !== before.slot;
    });
    expect(index).toBeGreaterThanOrEqual(0);
    const after = substitutePitcherAt(roster, index).roster;
    expect(fielderThrowArm(after, 'P')).toEqual(pitchArmOf(after.players[after.positions.P].pitching!.throws));
    expect(fielderThrowArm(after, 'P')).not.toEqual(before);
  });

  /**
   * 名鑑に左投げ・変則が実在しないと、腕で分ける意味が試合中に一度も出てこない
   * （＝実質未実装と同じ）。B-9が打席の左右について同じ形の回帰を置いているのと同じ扱い。
   */
  it('名鑑には既定と違う腕で投げる投手が実在する（16球団すべて）', () => {
    for (const team of TEAMS) {
      const roster = createTeamRoster(team);
      const staff = [roster.positions.P, ...roster.bullpen];
      const arms = staff.map((id) => pitchArmOf(roster.players[id].pitching!.throws));
      expect(arms.some((a) => a.side !== NEUTRAL_PITCH_ARM.side || a.slot !== NEUTRAL_PITCH_ARM.slot)).toBe(true);
    }
  });
});

describe('effectiveBattingHand（打席の左右の解決。フェーズB-9）', () => {
  it('R/L はどんな投手が相手でもそのまま', () => {
    for (const throws of ['R', 'L', 'S', 'U'] as const) {
      expect(effectiveBattingHand('R', throws)).toBe('R');
      expect(effectiveBattingHand('L', throws)).toBe('L');
    }
  });

  it('両打ち（S）は相手投手と逆の打席に立つ', () => {
    expect(effectiveBattingHand('S', 'R')).toBe('L');
    expect(effectiveBattingHand('S', 'L')).toBe('R');
  });

  it('サイド/アンダースローは腕の左右が不明なので右投手として扱う', () => {
    // 説明書のARM表記のS/Uは「投げ方」であって左右ではない（roster.ts のコメント参照）
    expect(effectiveBattingHand('S', 'S')).toBe('L');
    expect(effectiveBattingHand('S', 'U')).toBe('L');
  });

  it('同じ入力なら常に同じ結果（乱数なしの純関数）', () => {
    const results = new Set(Array.from({ length: 20 }, () => effectiveBattingHand('S', 'R')));
    expect(results.size).toBe(1);
  });
});

describe('打席の左右のデータ（フェーズB-9）', () => {
  const roster = createTeamRoster(TEST_TEAM);
  const allBatters = [...roster.lineup, ...roster.bench].map((id) => roster.players[id].batting);

  /**
   * 左打者・両打ちが実在しないと、判定側を左右対応にしても試合中に一度も左打席が
   * 出てこない（＝実質的に未実装と同じ）。データ側の回帰としてここで固定する。
   */
  it('打線に右打者・左打者・両打ちがすべて含まれる', () => {
    const boxes = new Set(allBatters.map((b) => b.bats));
    expect(boxes).toEqual(new Set(['R', 'L', 'S']));
  });

  it('BOXの値は R/L/S のいずれか（投手の打撃も含む）', () => {
    for (const p of Object.values(roster.players)) {
      expect(['R', 'L', 'S']).toContain(p.batting.bats);
    }
  });
});

describe('スタミナ消耗（フェーズB-11：説明書p26-29のSTM）', () => {
  /** その投手が「限界」に達するまで投げさせる（残量0・疲労MAX） */
  function throwPitches(roster: TeamRoster, count: number): TeamRoster {
    let r = roster;
    for (let i = 0; i < count; i++) r = recordPitch(r);
    return r;
  }

  it('限界の球数はスタミナで決まる（0で最小・1で最大）', () => {
    expect(maxPitchesFor(0)).toBe(STAMINA_MIN_PITCHES);
    expect(maxPitchesFor(1)).toBe(STAMINA_MIN_PITCHES + STAMINA_PITCH_SPAN);
    // 範囲外の値でも 0..1 に丸めて扱う（能力値の他項目と同じ規約）
    expect(maxPitchesFor(-1)).toBe(maxPitchesFor(0));
    expect(maxPitchesFor(2)).toBe(maxPitchesFor(1));
  });

  it('スタミナが高いほど長く投げられる（先発型＞リリーフ型）', () => {
    expect(maxPitchesFor(0.85)).toBeGreaterThan(maxPitchesFor(0.3));
  });

  it('残量は投球数に応じて 1 → 0 へ単調に減り、限界を超えても負にならない', () => {
    const stamina = 0.5;
    const max = maxPitchesFor(stamina);
    expect(staminaRemaining(0, stamina)).toBe(1);
    expect(staminaRemaining(max / 2, stamina)).toBeCloseTo(0.5, 6);
    expect(staminaRemaining(max, stamina)).toBe(0);
    expect(staminaRemaining(max * 2, stamina)).toBe(0);
  });

  /**
   * B-11の要：**残量が半分を切るまでは疲労0**。ここが崩れると、立ち上がりから
   * 性能が下がり続けて「疲労を持ち込む前と同じ球」という基準線が失われる。
   */
  it('残量が半分を切るまで疲労は0（前半は従来とまったく同じ球）', () => {
    expect(fatigueFromRemaining(1)).toBe(0);
    expect(fatigueFromRemaining(STAMINA_FRESH_THRESHOLD)).toBe(0);
    expect(fatigueFromRemaining(STAMINA_FRESH_THRESHOLD + 0.01)).toBe(0);
  });

  it('残量が半分を切ってから疲労が線形に増え、限界で1になる', () => {
    expect(fatigueFromRemaining(STAMINA_FRESH_THRESHOLD / 2)).toBeCloseTo(0.5, 6);
    expect(fatigueFromRemaining(0)).toBe(1);
  });

  it('先発型/リリーフ型はスタミナから導出される（別フィールドを持たない）', () => {
    expect(pitcherRole(0.85)).toBe('starter');
    expect(pitcherRole(0.7)).toBe('starter');
    expect(pitcherRole(0.45)).toBe('reliever');
    expect(pitcherRole(0.3)).toBe('reliever');
  });

  /**
   * 継投に「誰を出すか」の意味を持たせるための最低条件＝投手陣に両方の型がいること。
   * 全員が同じ型だと、スタミナを入れても選択が生まれない。
   */
  it('初期ロスターの投手陣に先発型とリリーフ型が両方いる', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const roles = [roster.pitcher, ...roster.bullpen].map((id) =>
      pitcherRole(roster.players[id].pitching!.stamina),
    );
    expect(roles).toContain('starter');
    expect(roles).toContain('reliever');
  });

  it('先発（初期の投手）は先発型＝1試合を任せられるスタミナを持つ', () => {
    const roster = createTeamRoster(TEST_TEAM);
    expect(pitcherRole(roster.players[roster.pitcher].pitching!.stamina)).toBe('starter');
  });

  it('投球数は初期0で、recordPitch でマウンドの投手だけが増える', () => {
    const roster = createTeamRoster(TEST_TEAM);
    expect(pitchCountOf(roster, roster.pitcher)).toBe(0);
    const after = throwPitches(roster, 3);
    expect(pitchCountOf(after, after.pitcher)).toBe(3);
    for (const id of after.bullpen) expect(pitchCountOf(after, id)).toBe(0);
  });

  it('投げるほど残量が減り、疲労が増える', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const max = maxPitchesFor(roster.players[roster.pitcher].pitching!.stamina);
    const half = throwPitches(roster, Math.round(max / 2));
    const spent = throwPitches(roster, max);
    expect(remainingStaminaOf(half, half.pitcher)).toBeCloseTo(0.5, 1);
    expect(fatigueOf(half, half.pitcher)).toBeCloseTo(0, 1);
    expect(remainingStaminaOf(spent, spent.pitcher)).toBe(0);
    expect(fatigueOf(spent, spent.pitcher)).toBe(1);
  });

  /**
   * 継投がスタミナの回復手段として機能するための条件。ここが引き継がれてしまうと
   * 「誰に替えても疲れたまま」になり、継投そのものが無意味になる。
   */
  it('継投すると新しい投手は無傷から始まる（前任の投球数は引き継がない）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const spent = throwPitches(roster, maxPitchesFor(1) + 10);
    const previous = spent.pitcher;
    const { roster: relieved, ok } = substitutePitcherAt(spent, 0);
    expect(ok).toBe(true);
    expect(remainingStaminaOf(relieved, relieved.pitcher)).toBe(1);
    expect(fatigueOf(relieved, relieved.pitcher)).toBe(0);
    // 降板した投手の記録は残す（誰が何球投げたかを失わない）
    expect(pitchCountOf(relieved, previous)).toBe(maxPitchesFor(1) + 10);
  });

  it('代打・打順の進行では投球数が変化しない（投げたときだけ増える）', () => {
    const roster = throwPitches(createTeamRoster(TEST_TEAM), 5);
    const counts = (r: TeamRoster) => pitchCountOf(r, roster.pitcher);
    expect(counts(advanceBatter(roster))).toBe(5);
    expect(counts(substituteBatterAt(roster, 0).roster)).toBe(5);
  });

  it('投球能力を持たない選手がマウンドにいても読み出しで止まらない（保険）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const fielder = roster.lineup[0];
    expect(roster.players[fielder].pitching).toBeUndefined();
    expect(remainingStaminaOf(roster, fielder)).toBe(1);
    expect(fatigueOf(roster, fielder)).toBe(0);
  });
});

/**
 * 表示用の数値（フェーズD-18）。HUDに出す打率・本塁打数は能力値レーティングからの
 * 導出で、実数値を別に持たない。**表示と実力が食い違わない**ことがこの導出の値打ちなので、
 * 単調性（強い打者のほうが必ず良い数字に見える）をテストで固定する。
 */
describe('表示用の打率・本塁打数（フェーズD-18）', () => {
  it('レーティング0/0.5/1 が 0.200/0.275/0.350 に対応する', () => {
    expect(displayAverage(0)).toBeCloseTo(DISPLAY_AVG_MIN, 6);
    expect(displayAverage(0.5)).toBeCloseTo(0.275, 6);
    expect(displayAverage(1)).toBeCloseTo(DISPLAY_AVG_MIN + DISPLAY_AVG_SPAN, 6);
  });

  it('打率・本塁打数はレーティングに対して単調増加（表示の大小＝能力の大小）', () => {
    for (let i = 0; i < 20; i++) {
      const lo = i / 20;
      const hi = (i + 1) / 20;
      expect(displayAverage(hi)).toBeGreaterThan(displayAverage(lo));
      expect(displayHomeRuns(hi)).toBeGreaterThanOrEqual(displayHomeRuns(lo));
    }
    expect(displayHomeRuns(0)).toBe(0);
    expect(displayHomeRuns(1)).toBe(DISPLAY_HR_MAX);
  });

  it('範囲外のレーティングでも表示が崩れない（0..1にクランプ）', () => {
    expect(displayAverage(-1)).toBeCloseTo(DISPLAY_AVG_MIN, 6);
    expect(displayAverage(2)).toBeCloseTo(DISPLAY_AVG_MIN + DISPLAY_AVG_SPAN, 6);
    expect(displayHomeRuns(-1)).toBe(0);
    expect(displayHomeRuns(2)).toBe(DISPLAY_HR_MAX);
  });

  it('打率は整数部を落とした3桁表記になる（.320）', () => {
    expect(formatAverage(0.8)).toBe('.320');
    expect(formatAverage(0.5)).toBe('.275');
    expect(formatAverage(0)).toBe('.200');
    expect(formatAverage(1)).toBe('.350');
    // 桁が足りない場合も0で埋める（現在の定数では起きないが、範囲を変えたときの保険）
    expect(formatAverage(0).length).toBe(4);
  });

  it('防御率は小数2桁で出る', () => {
    expect(formatEra(2.85)).toBe('2.85');
    expect(formatEra(3)).toBe('3.00');
    expect(formatEra(12.5)).toBe('12.50');
  });

  /**
   * 打線の役割の違い（1・2番は巧打／クリーンナップは長打）が**表示の数字にも出ている**か。
   * ここが潰れていると、名鑑を見て代打や配球を決める意味がなくなる。
   */
  it('初期ロスターの表示値に打線の役割が出ている', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const av = (slot: number) => displayAverage(roster.players[roster.lineup[slot]].batting.average);
    const hr = (slot: number) => displayHomeRuns(roster.players[roster.lineup[slot]].batting.power);
    // 3番（巧打＋長打）は8番より打率が高く、4番（主砲）は1番（俊足巧打）より本塁打が多い
    expect(av(2)).toBeGreaterThan(av(7));
    expect(hr(3)).toBeGreaterThan(hr(0));
    // 9番（投手）は打線でもっとも非力
    const powers = roster.lineup.map((_, i) => hr(i));
    expect(Math.min(...powers)).toBe(hr(8));
  });
});
