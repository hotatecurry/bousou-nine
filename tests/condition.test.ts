/**
 * 好調（ゼッコーチョー／ラッキー7。フェーズD-19。説明書p16-17）。
 *
 * `rosterSkills.test.ts` と分けてあるのは、対象が「スキル」ではなく **試合そのものが
 * 配る好調**だから。テストの値打ちは3つ：
 * - **シードから決まり再現できる**（好調が運任せに見えても、規則としては読める）。
 * - **補正が既存の導出経路（`effectiveBatting` → 打球初速・HUDの表示）に乗る**
 *   ＝「ゼッコーチョーと出ているのに打球は非力」が起きない。
 * - **好調を持ち込む前とまったく同じに戻せる**（好調でない打者・イニングを渡さない
 *   呼び出しは従来どおり）。
 */
import { describe, expect, it } from 'vitest';
import { createActor } from 'xstate';
import {
  HOT_BATTERS_PER_TEAM,
  HOT_MODIFIER,
  LUCKY_INNING,
  isHotBatter,
  isLuckyInning,
  pickHotBatters,
} from '../src/core/condition';
import {
  createTeamRoster,
  displayHomeRuns,
  effectiveBatting,
  grantSkill,
  isHot,
  substituteBatterAt,
  withHotBatters,
} from '../src/core/roster';
import { gameMachine } from '../src/core/gameMachine';
import { DEFAULT_SEED, createRngState } from '../src/core/rng';
import { TEAMS, teamById } from '../src/core/teams';

const TEST_TEAM = teamById('foresters');

/** 好調を載せたロスター（テストのたびに同じシードで組む＝結果は決定的） */
function hotRoster(seed = DEFAULT_SEED, side: 'away' | 'home' = 'away') {
  return withHotBatters(createTeamRoster(TEST_TEAM), seed, side);
}

describe('好調: 誰が絶好調になるか', () => {
  it('組んだ直後のロスターには好調者がいない（載せるのはシードを知っている側）', () => {
    expect(createTeamRoster(TEST_TEAM).hot).toEqual([]);
  });

  it('各チームちょうど HOT_BATTERS_PER_TEAM 人が好調になる', () => {
    expect(hotRoster().hot).toHaveLength(HOT_BATTERS_PER_TEAM);
  });

  it('同じシード・同じ側なら必ず同じ顔ぶれ（＝試合まるごと再現できる）', () => {
    expect(hotRoster(12345, 'away').hot).toEqual(hotRoster(12345, 'away').hot);
  });

  it('シードが変われば顔ぶれも変わる（球団を選び直しても固定にならない）', () => {
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8].map((s) => hotRoster(s).hot.join(','));
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });

  it('先攻と後攻で顔ぶれがずれる（同じ系列だと同じ打順が好調になってしまう）', () => {
    // 塩を分けていないと、候補の並びの長さが同じである以上まったく同じ添字が選ばれる。
    // 同じ球団を先攻・後攻に置いたときに違いが出ることでそれを確かめる。
    const away = hotRoster(DEFAULT_SEED, 'away').hot;
    const home = hotRoster(DEFAULT_SEED, 'home').hot;
    expect(away).not.toEqual(home);
  });

  it('候補は打線9人＋控え3人（ブルペンの投手は打席に立たないので入らない）', () => {
    const roster = hotRoster();
    const candidates = [...roster.lineup, ...roster.bench];
    for (const id of roster.hot) expect(candidates).toContain(id);
    // どのシードで引いてもブルペンからは選ばれない
    for (let seed = 1; seed <= 40; seed += 1) {
      for (const id of hotRoster(seed).hot) {
        expect(roster.bullpen).not.toContain(id);
      }
    }
  });

  it('返す並びは候補の並び順に揃う（引いた順番で表示がぶれない）', () => {
    const roster = hotRoster();
    const candidates = [...roster.lineup, ...roster.bench];
    const indices = roster.hot.map((id) => candidates.indexOf(id));
    expect([...indices]).toEqual([...indices].sort((a, b) => a - b));
  });

  it('候補が人数より少なくても止まらない（あるだけ返す）', () => {
    expect(pickHotBatters(DEFAULT_SEED, ['solo'], 'away')).toEqual(['solo']);
    expect(pickHotBatters(DEFAULT_SEED, [], 'away')).toEqual([]);
  });

  it('16球団すべてで好調者が2人立つ（名鑑の人数の前提が全球団で成り立つ）', () => {
    for (const team of TEAMS) {
      const roster = withHotBatters(createTeamRoster(team), DEFAULT_SEED, 'home');
      expect(roster.hot).toHaveLength(HOT_BATTERS_PER_TEAM);
    }
  });
});

describe('好調: ラッキー7', () => {
  it('7回だけが対象（説明書p17）', () => {
    expect(LUCKY_INNING).toBe(7);
    expect(isLuckyInning(7)).toBe(true);
    expect(isLuckyInning(6)).toBe(false);
    expect(isLuckyInning(8)).toBe(false);
  });

  it('延長（10回以降）では効かない＝7回の山場が繰り返されない', () => {
    for (const inning of [10, 11, 14, 17]) expect(isLuckyInning(inning)).toBe(false);
  });

  it('イニングを渡さなければ効かない（試合の文脈を持たない読み出しは従来どおり）', () => {
    expect(isLuckyInning(undefined)).toBe(false);
  });

  it('7回は好調者でない打者も全員好調になる', () => {
    const roster = hotRoster();
    const cold = roster.lineup.find((id) => !roster.hot.includes(id))!;
    expect(isHot(roster, cold, 6)).toBe(false);
    expect(isHot(roster, cold, LUCKY_INNING)).toBe(true);
  });

  it('絶好調選手は7回以外でも好調（2つの由来は独立に立つ）', () => {
    const roster = hotRoster();
    expect(isHot(roster, roster.hot[0], 1)).toBe(true);
    expect(isHot(roster, roster.hot[0], LUCKY_INNING)).toBe(true);
  });

  it('isHotBatter は由来を区別せず1つの問いに畳む', () => {
    expect(isHotBatter(['x'], 'x', 1)).toBe(true);
    expect(isHotBatter(['x'], 'y', 1)).toBe(false);
    expect(isHotBatter(['x'], 'y', LUCKY_INNING)).toBe(true);
  });
});

describe('好調: 能力値への補正', () => {
  it('効くのは AV と HR だけ（走力RUNは動かない＝原作が言う「打撃」に留める）', () => {
    expect(HOT_MODIFIER.average).toBeGreaterThan(0);
    expect(HOT_MODIFIER.power).toBeGreaterThan(0);
    expect(HOT_MODIFIER.run).toBeUndefined();
  });

  it('好調の打者は AV も HR も上がる', () => {
    const roster = hotRoster();
    const id = roster.hot[0];
    const base = createTeamRoster(TEST_TEAM);
    const before = effectiveBatting(base, id);
    const after = effectiveBatting(roster, id);
    expect(after.average).toBeGreaterThan(before.average);
    expect(after.power).toBeGreaterThan(before.power);
    expect(after.run).toBe(before.run);
  });

  it('好調でない打者は素の能力値のまま（好調を入れる前と1ミリも変わらない）', () => {
    const roster = hotRoster();
    const cold = roster.lineup.find((id) => !roster.hot.includes(id))!;
    expect(effectiveBatting(roster, cold, 1)).toEqual(
      effectiveBatting(createTeamRoster(TEST_TEAM), cold),
    );
  });

  it('イニングを渡さない呼び出しにはラッキー7が乗らない（既定は従来どおり）', () => {
    const roster = hotRoster();
    const cold = roster.lineup.find((id) => !roster.hot.includes(id))!;
    // 渡さない＝ラッキー7を知らない読み出し（走者の走力など）
    expect(effectiveBatting(roster, cold).average).toBe(
      effectiveBatting(createTeamRoster(TEST_TEAM), cold).average,
    );
  });

  it('7回は全打者の AV/HR が上がる（ラッキー7も同じ補正の経路を通る）', () => {
    const roster = hotRoster();
    for (const id of roster.lineup) {
      const plain = effectiveBatting(roster, id, 1);
      const lucky = effectiveBatting(roster, id, LUCKY_INNING);
      // すでに上限に張り付いている打者だけは伸びしろが無い（クランプ）
      expect(lucky.average).toBeGreaterThanOrEqual(plain.average);
      expect(lucky.power).toBeGreaterThanOrEqual(plain.power);
    }
  });

  it('HUDに出る本塁打数も一緒に動く（表示はレーティングからの導出）', () => {
    const roster = hotRoster();
    const id = roster.hot[0];
    const before = displayHomeRuns(effectiveBatting(createTeamRoster(TEST_TEAM), id).power);
    const after = displayHomeRuns(effectiveBatting(roster, id).power);
    expect(after).toBeGreaterThan(before);
  });

  it('スキルの補正と重ねて足される（好調専用の係数を持たない）', () => {
    const roster = hotRoster();
    const id = roster.hot[0];
    const withSkill = grantSkill(roster, id, 'kinniku').roster;
    expect(effectiveBatting(withSkill, id).power).toBeGreaterThan(
      effectiveBatting(roster, id).power,
    );
  });

  it('重ねがけしても 0..1 を超えない（`rated` のクランプにそのまま乗る）', () => {
    const roster = hotRoster();
    for (const id of roster.lineup) {
      const stats = effectiveBatting(grantSkill(roster, id, 'kinniku').roster, id, LUCKY_INNING);
      expect(stats.average).toBeLessThanOrEqual(1);
      expect(stats.power).toBeLessThanOrEqual(1);
    }
  });
});

describe('好調: 選手に付いて回る', () => {
  it('代打で好調の打者を退かせると、その好調はベンチへ下がる（打順には残らない）', () => {
    let roster = hotRoster();
    // 好調の選手が打席に立つ打順まで進める
    const slot = roster.lineup.indexOf(roster.hot.find((id) => roster.lineup.includes(id))!);
    roster = { ...roster, lineupIndex: slot };
    expect(isHot(roster, roster.lineup[slot], 1)).toBe(true);
    const after = substituteBatterAt(roster, 0).roster;
    // 代打が好調でなければ、その打順の打者はもう好調ではない
    expect(isHot(after, after.lineup[slot], 1)).toBe(after.hot.includes(after.lineup[slot]));
    // 退いた選手の好調はロスター側の記録としては消えない（誰が好調だったかは変わらない）
    expect(after.hot).toEqual(roster.hot);
  });
});

describe('好調: gameMachine への接続', () => {
  it('起動直後の既定カードにも好調者が立っている', () => {
    const actor = createActor(gameMachine).start();
    const { rosters } = actor.getSnapshot().context;
    expect(rosters.away.hot).toHaveLength(HOT_BATTERS_PER_TEAM);
    expect(rosters.home.hot).toHaveLength(HOT_BATTERS_PER_TEAM);
  });

  it('MATCH_SETUP で好調者も仕切り直す（ロスターの全取り替えと足並みが揃う）', () => {
    const actor = createActor(gameMachine).start();
    actor.send({ type: 'MATCH_SETUP', away: 'foresters', home: 'winds', seed: 4649 });
    const { rosters } = actor.getSnapshot().context;
    expect(rosters.away.hot).toHaveLength(HOT_BATTERS_PER_TEAM);
    for (const id of rosters.away.hot) {
      expect([...rosters.away.lineup, ...rosters.away.bench]).toContain(id);
    }
  });

  it('シードを固定すれば好調の顔ぶれまで再現される', () => {
    const run = () => {
      const actor = createActor(gameMachine).start();
      actor.send({ type: 'MATCH_SETUP', away: 'foresters', home: 'winds', seed: 777 });
      return actor.getSnapshot().context.rosters;
    };
    const a = run();
    const b = run();
    expect(a.away.hot).toEqual(b.away.hot);
    expect(a.home.hot).toEqual(b.home.hot);
  });

  it('シードを渡さない MATCH_SETUP は既定シードのまま（既存の約束を崩さない）', () => {
    const actor = createActor(gameMachine).start();
    actor.send({ type: 'MATCH_SETUP', away: 'foresters', home: 'winds' });
    const { rosters } = actor.getSnapshot().context;
    expect(rosters.away.hot).toEqual(
      withHotBatters(createTeamRoster(teamById('foresters')), DEFAULT_SEED, 'away').hot,
    );
  });

  it('本編の乱数（スキル抽選の系列）は好調の抽選で進まない', () => {
    const actor = createActor(gameMachine).start();
    actor.send({ type: 'MATCH_SETUP', away: 'foresters', home: 'winds', seed: 2026 });
    // シードから作った状態そのもの＝好調のぶんを1つも消費していない
    // （消費すると「何回目の抽選か」と乱数の位置がずれる。F-26-5の系統の絞り込みと同じ扱い）
    expect(actor.getSnapshot().context.rngState).toBe(createRngState(2026));
  });
});
