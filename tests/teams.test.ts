/**
 * 16球団の選手名鑑（フェーズB-12）の検証。
 *
 * 名鑑は**手書きの固定データ**なので、テストが守るべきものは2つある：
 *
 * 1. **構造の不変条件** — 9守備位置が過不足なく埋まる／控え・ブルペンの人数が揃う／
 *    先発として使える投手がいる／能力値が 0..1 に収まる。ここが崩れた球団を1つでも
 *    混ぜると、その球団を選んだときだけ試合が壊れる（16球団あると手動確認では
 *    まず気づけない＝ここを自動で見る値打ちがいちばん大きい）。
 * 2. **バランスの意図** — 総合力はおおむね揃っていて、得意分野は球団ごとに違う。
 *    ここが崩れると「強い球団を選ぶだけのゲーム」か「名前が違うだけの同じ球団が16個」に
 *    なる（`teams.ts` 冒頭のコメント参照）。数字を調整するときの手すりとして帯で固定する。
 */
import { describe, expect, it } from 'vitest';
import {
  type TeamData,
  TEAMS,
  benchRowStats,
  fielderRowStats,
  pitcherRowBatting,
  pitcherRowPitching,
  teamById,
  DEFAULT_AWAY_TEAM_ID,
  DEFAULT_HOME_TEAM_ID,
} from '../src/core/teams';
import { REFERENCE_PITCHER_NEUTRAL, neutralSpeedFor } from '../src/core/pitch';
import {
  BENCH_SIZE,
  BULLPEN_SIZE,
  PITCHING_STAFF_SIZE,
  STARTER_TYPE_COUNT,
  createTeamRoster,
  pitcherRole,
  type FieldingPosition,
} from '../src/core/roster';

/** 投手を除く8守備位置（打順1〜8番がちょうどここを埋める） */
const FIELD_POSITIONS: readonly FieldingPosition[] = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'];

/** 名鑑に書かれている野手の人数（打順9スロットのうち投手以外） */
const LINEUP_FIELDERS = FIELD_POSITIONS.length;

/** 打線の総合力＝打順9人（投手を含む）の AV+HR+RUN の合計 */
function lineupPower(team: TeamData): number {
  return team.lineup.reduce((sum, row) => {
    const s = fielderRowStats(row);
    return sum + s.average + s.power + s.run;
  }, 0);
}

/** 投手陣の総合力＝4人の 球速＋変化量（左右の平均）＋スタミナ の合計 */
function pitchingPower(team: TeamData): number {
  return team.pitchers.reduce((sum, row) => {
    const p = pitcherRowPitching(row);
    return sum + p.speed + (p.breakRight + p.breakLeft) / 2 + p.stamina;
  }, 0);
}

/** 控えの総合力＝控え野手3人の AV+HR+RUN の合計 */
function benchPower(team: TeamData): number {
  return team.bench.reduce((sum, row) => {
    const s = benchRowStats(row);
    return sum + s.average + s.power + s.run;
  }, 0);
}

/**
 * 球団の総合力。控えを半分の重みにしているのは、控えが試合に出るのが代打・代走の
 * 数打席だけだから（先発9人と同じ重みで数えると、控えが厚いだけの球団が過大評価される）。
 */
function teamPower(team: TeamData): number {
  return lineupPower(team) + pitchingPower(team) + benchPower(team) * 0.5;
}

describe('名鑑の構造（フェーズB-12）', () => {
  it('16球団ある', () => {
    expect(TEAMS).toHaveLength(16);
  });

  it('球団ID・球団名・略称が重複しない', () => {
    expect(new Set(TEAMS.map((t) => t.id)).size).toBe(TEAMS.length);
    expect(new Set(TEAMS.map((t) => t.name)).size).toBe(TEAMS.length);
    expect(new Set(TEAMS.map((t) => t.short)).size).toBe(TEAMS.length);
  });

  it('略称は全球団カタカナ2文字（スコアボードの列がずれない条件）', () => {
    for (const team of TEAMS) {
      expect(team.short).toHaveLength(2);
    }
  });

  it('選手名は4文字以内で、同じ球団の中で重複しない（カードで区別できる条件）', () => {
    for (const team of TEAMS) {
      const names = [
        ...team.lineup.map((row) => row[1]),
        ...team.bench.map((row) => row[0]),
        ...team.pitchers.map((row) => row[0]),
      ];
      expect(names).toHaveLength(LINEUP_FIELDERS + BENCH_SIZE + PITCHING_STAFF_SIZE);
      for (const name of names) {
        expect(name.length, `${team.name} の ${name}`).toBeLessThanOrEqual(4);
        expect(name.length).toBeGreaterThan(0);
      }
      expect(new Set(names).size, `${team.name} に同名の選手がいる`).toBe(names.length);
    }
  });

  it('打順1〜8番が投手以外の8守備位置をちょうど1回ずつ埋める', () => {
    for (const team of TEAMS) {
      const positions = team.lineup.map((row) => row[0]);
      expect(positions, team.name).toHaveLength(8);
      expect(new Set(positions)).toEqual(new Set(FIELD_POSITIONS));
    }
  });

  it('控え3人・投手6人（先発1＋ブルペン5）を持つ', () => {
    for (const team of TEAMS) {
      expect(team.bench, team.name).toHaveLength(BENCH_SIZE);
      expect(team.pitchers, team.name).toHaveLength(PITCHING_STAFF_SIZE);
      expect(PITCHING_STAFF_SIZE).toBe(BULLPEN_SIZE + 1);
    }
  });

  it('能力値はすべて 0..1 に収まる（レーティングの前提）', () => {
    const inRange = (v: number, label: string) => {
      expect(v, label).toBeGreaterThanOrEqual(0);
      expect(v, label).toBeLessThanOrEqual(1);
    };
    for (const team of TEAMS) {
      for (const row of team.lineup) {
        const s = fielderRowStats(row);
        inRange(s.average, `${team.name} ${row[1]} AV`);
        inRange(s.power, `${team.name} ${row[1]} HR`);
        inRange(s.run, `${team.name} ${row[1]} RUN`);
      }
      for (const row of team.bench) {
        const s = benchRowStats(row);
        inRange(s.average, `${team.name} ${row[0]} AV`);
        inRange(s.power, `${team.name} ${row[0]} HR`);
        inRange(s.run, `${team.name} ${row[0]} RUN`);
      }
      for (const row of team.pitchers) {
        const p = pitcherRowPitching(row);
        inRange(p.speed, `${team.name} ${row[0]} SPD`);
        inRange(p.breakRight, `${team.name} ${row[0]} R`);
        inRange(p.breakLeft, `${team.name} ${row[0]} L`);
        inRange(p.fork, `${team.name} ${row[0]} F`);
        inRange(p.stamina, `${team.name} ${row[0]} STM`);
        const b = pitcherRowBatting(row);
        inRange(b.average, `${team.name} ${row[0]} 打AV`);
        inRange(b.power, `${team.name} ${row[0]} 打HR`);
        inRange(b.run, `${team.name} ${row[0]} 打RUN`);
        // 防御率は表示専用の実数値（レーティングではない）。桁が崩れない範囲に収める
        expect(p.era, `${team.name} ${row[0]} ERA`).toBeGreaterThan(0);
        expect(p.era, `${team.name} ${row[0]} ERA`).toBeLessThan(10);
      }
    }
  });

  /**
   * 原作（説明書p8）の「上4人が先発型・下2人がリリーフ型」。**先発を選ぶ画面
   * （フェーズC-15）は名鑑の並びをそのまま6枠に並べる**ので、この約束が崩れると
   * 「上の方から選べば先発型」という原作の読み方が通じなくなる。
   * 型そのものはSTMからの導出（`pitcherRole`）なので、ここで見ているのは
   * 並び順とSTMの一致であって、別に持っている値ではない。
   */
  it('投手陣は上4人が先発型・下2人がリリーフ型の順に並んでいる（説明書p8）', () => {
    for (const team of TEAMS) {
      const roles = team.pitchers.map((row) => pitcherRole(pitcherRowPitching(row).stamina));
      expect(roles.slice(0, STARTER_TYPE_COUNT), `${team.name} の上位`).toEqual(
        Array(STARTER_TYPE_COUNT).fill('starter'),
      );
      expect(roles.slice(STARTER_TYPE_COUNT), `${team.name} の下位`).toEqual(
        Array(PITCHING_STAFF_SIZE - STARTER_TYPE_COUNT).fill('reliever'),
      );
    }
  });

  /**
   * 先発の4人に**差がある**こと。差が無ければ「6人から選ぶ」画面はただの手数になる
   * （選択に意味を持たせるのがフェーズC-15の目的そのもの）。球速・変化量・スタミナの
   * どれかで幅があればよい＝全員が同じ型の投手にはならない。
   */
  it('先発型4人の中に球速・変化量・スタミナのどれかで差がある（選ぶ意味がある）', () => {
    for (const team of TEAMS) {
      const starters = team.pitchers.slice(0, STARTER_TYPE_COUNT).map(pitcherRowPitching);
      const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
      const widest = Math.max(
        spread(starters.map((p) => p.speed)),
        spread(starters.map((p) => (p.breakRight + p.breakLeft) / 2)),
        spread(starters.map((p) => p.stamina)),
      );
      // 名鑑の値は小数第2位までなので、丸めてから比べる（差がちょうど 0.20 の球団が
      // 浮動小数の誤差で落ちないように）
      expect(Math.round(widest * 100) / 100, `${team.name} の先発型4人`).toBeGreaterThanOrEqual(0.2);
    }
  });

  it('投手は打線のどの野手より非力（原作同様に投手も打席に立つ前提の妥当性）', () => {
    for (const team of TEAMS) {
      const weakestFielder = Math.min(...team.lineup.map((row) => fielderRowStats(row).power));
      for (const row of team.pitchers) {
        expect(pitcherRowBatting(row).power, `${team.name} ${row[0]}`).toBeLessThan(weakestFielder);
      }
    }
  });
});

describe('名鑑からロスターを組む（フェーズB-12）', () => {
  it('全16球団がロスターの不変条件を満たす（9守備位置＝打順9人）', () => {
    for (const team of TEAMS) {
      const roster = createTeamRoster(team);
      expect(roster.lineup, team.name).toHaveLength(9);
      expect(roster.bench, team.name).toHaveLength(BENCH_SIZE);
      expect(roster.bullpen, team.name).toHaveLength(BULLPEN_SIZE);
      const fielders = (Object.keys(roster.positions) as FieldingPosition[]).map(
        (p) => roster.positions[p],
      );
      expect(fielders).toHaveLength(9);
      expect(new Set(fielders).size).toBe(9);
      expect(new Set(fielders)).toEqual(new Set(roster.lineup));
      // 9番が投手＝守備位置Pと打順スロットが対応している（原作にDH制は無い）
      expect(roster.pitcher).toBe(roster.positions.P);
      expect(roster.lineup[roster.pitcherSlot]).toBe(roster.pitcher);
      expect(roster.team).toBe(team);
    }
  });

  it('選手IDは球団をまたいでも衝突しない（同姓の選手がいても識別できる）', () => {
    const ids = TEAMS.flatMap((team) => Object.keys(createTeamRoster(team).players));
    expect(ids).toHaveLength(TEAMS.length * (LINEUP_FIELDERS + BENCH_SIZE + PITCHING_STAFF_SIZE));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('名鑑の並びがそのまま打順になる', () => {
    const team = teamById('comets');
    const roster = createTeamRoster(team);
    expect(roster.players[roster.lineup[0]].name).toBe(team.lineup[0][1]);
    expect(roster.players[roster.lineup[7]].name).toBe(team.lineup[7][1]);
    expect(roster.players[roster.lineup[8]].name).toBe(team.pitchers[0][0]);
  });

  it('teamById は存在しないIDで例外（既定へ静かに落とさない）', () => {
    expect(teamById(DEFAULT_AWAY_TEAM_ID).id).toBe(DEFAULT_AWAY_TEAM_ID);
    expect(teamById(DEFAULT_HOME_TEAM_ID).id).toBe(DEFAULT_HOME_TEAM_ID);
    expect(() => teamById('no-such-team')).toThrow();
  });
});

describe('16球団のバランス（フェーズB-12）', () => {
  /**
   * **総合力は揃える**。ここが開くと「どの球団を選ぶか」が難易度選択になり、
   * 16球団ある意味（相性と好みで選ぶ）が消える。帯は現在の実データの散らばりに
   * 対して余裕を持たせた値で、名鑑を調整するときの手すりとして置いてある。
   */
  it('総合力が全球団おおむね同じ帯に収まる', () => {
    const powers = TEAMS.map(teamPower);
    const average = powers.reduce((a, b) => a + b, 0) / powers.length;
    for (const [i, power] of powers.entries()) {
      expect(Math.abs(power - average), `${TEAMS[i].name} の総合力 ${power.toFixed(2)}`).toBeLessThan(
        0.8,
      );
    }
  });

  /**
   * **得意分野は分ける**。打線1位と投手陣1位が同じ球団だと、その球団が単純に最強になる。
   * 逆に「打線が最強なら投手陣は最弱」という形にしておくと、総合力が同じでも
   * 試合の性質（打ち合いか投手戦か）が球団の組み合わせで変わる。
   */
  it('打線1位と投手陣1位は別の球団（最強球団を作らない）', () => {
    const bestLineup = [...TEAMS].sort((a, b) => lineupPower(b) - lineupPower(a))[0];
    const bestPitching = [...TEAMS].sort((a, b) => pitchingPower(b) - pitchingPower(a))[0];
    expect(bestLineup.id).not.toBe(bestPitching.id);
    // 打線最強の球団は投手陣が下位、投手最強の球団は打線が下位（トレードオフが実在する）
    const lineupRank = (team: TeamData) =>
      [...TEAMS].sort((a, b) => lineupPower(b) - lineupPower(a)).findIndex((t) => t.id === team.id);
    const pitchingRank = (team: TeamData) =>
      [...TEAMS]
        .sort((a, b) => pitchingPower(b) - pitchingPower(a))
        .findIndex((t) => t.id === team.id);
    expect(pitchingRank(bestLineup)).toBeGreaterThanOrEqual(TEAMS.length - 3);
    expect(lineupRank(bestPitching)).toBeGreaterThanOrEqual(TEAMS.length - 3);
  });

  /** 球団ごとの持ち味が数値として実在するか（説明どおりの球団になっているか） */
  it('球団の持ち味が数値に出ている', () => {
    const runTotal = (team: TeamData) =>
      team.lineup.reduce((sum, row) => sum + fielderRowStats(row).run, 0);
    const powerTotal = (team: TeamData) =>
      team.lineup.reduce((sum, row) => sum + fielderRowStats(row).power, 0);
    const averageTotal = (team: TeamData) =>
      team.lineup.reduce((sum, row) => sum + fielderRowStats(row).average, 0);
    const breakTotal = (team: TeamData) =>
      team.pitchers.reduce((sum, row) => {
        const p = pitcherRowPitching(row);
        return sum + (p.breakRight + p.breakLeft) / 2;
      }, 0);
    const speedTotal = (team: TeamData) =>
      team.pitchers.reduce((sum, row) => sum + pitcherRowPitching(row).speed, 0);

    const top = (score: (team: TeamData) => number) =>
      [...TEAMS].sort((a, b) => score(b) - score(a))[0].id;
    expect(top(runTotal)).toBe('winds'); // 走力＝ウィンズ
    expect(top(powerTotal)).toBe('rockets'); // 長打＝ロケッツ
    expect(top(averageTotal)).toBe('comets'); // 打率＝コメッツ
    expect(top(breakTotal)).toBe('moons'); // 変化量＝ムーンズ
    expect(top(speedTotal)).toBe('thunders'); // 球速＝サンダーズ
    // 控えの厚さ＝ナイツ（代打・代走で終盤に殴り返す球団）
    expect([...TEAMS].sort((a, b) => benchPower(b) - benchPower(a))[0].id).toBe('knights');
  });

  it('両打ち・左打ちの球団が実在する（打席の左右の駆け引きが球団で変わる）', () => {
    const switchHitters = (team: TeamData) =>
      team.lineup.filter((row) => fielderRowStats(row).bats === 'S').length;
    const leftHitters = (team: TeamData) =>
      team.lineup.filter((row) => fielderRowStats(row).bats === 'L').length;
    expect(switchHitters(teamById('auroras'))).toBeGreaterThanOrEqual(6);
    expect(leftHitters(teamById('blizzards'))).toBeGreaterThanOrEqual(5);
    // 左投手を複数持つ球団（両打ちの打席が入れ替わる相手）
    const lefties = teamById('blizzards').pitchers.filter(
      (row) => pitcherRowPitching(row).throws === 'L',
    );
    expect(lefties.length).toBeGreaterThanOrEqual(2);
  });
});

describe('球速の効き方の基準にする投手（フェーズBBB-85）', () => {
  /**
   * 投手の球速は「基準の投手からどれだけ速いか」として効く（打球の強さには乗らない／CPU打者の
   * 誤差には比で乗る）。**基準は名鑑の投手の平均**＝平均の投手の球は BBB-85 の前と同じになる。
   * 名鑑の球速を大きく動かしたら、ここが落ちて `REFERENCE_PITCHER_NEUTRAL` を見直すことになる。
   */
  it('REFERENCE_PITCHER_NEUTRAL は名鑑96人の球速の平均の投手の基準速（±0.3m/s）', () => {
    const speeds = TEAMS.flatMap((t) => teamById(t.id).pitchers.map((row) => pitcherRowPitching(row).speed));
    expect(speeds.length).toBe(TEAMS.length * PITCHING_STAFF_SIZE);
    const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    expect(Math.abs(neutralSpeedFor(mean) - REFERENCE_PITCHER_NEUTRAL)).toBeLessThan(0.3);
  });

  it('名鑑の投手は基準の両側にいる（誰にとっても得、誰にとっても損、にならない）', () => {
    const neutrals = TEAMS.flatMap((t) =>
      teamById(t.id).pitchers.map((row) => neutralSpeedFor(pitcherRowPitching(row).speed)),
    );
    const faster = neutrals.filter((n) => n > REFERENCE_PITCHER_NEUTRAL).length;
    const slower = neutrals.filter((n) => n < REFERENCE_PITCHER_NEUTRAL).length;
    expect(faster).toBeGreaterThan(neutrals.length * 0.3);
    expect(slower).toBeGreaterThan(neutrals.length * 0.3);
  });
});
