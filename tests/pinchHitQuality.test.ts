/**
 * 代打側にも「いまの中身」を出す（フェーズEE-52。CLAUDE.md ⑪／「意思決定材料は隠さない」）。
 *
 * DD-51は継投を**1行1人の表**（型・残量・球速・変化量・制球）にしたが、**代打は D-18 以来
 * 「1行の文章」のまま**で、しかも**走力（RUN）は試合中どこにも数字が出ない唯一の能力値**
 * だった。ここで固定したいのは4つ：
 *
 * - **代打も表になる**（見出し・イマ・候補の列が縦に揃う＝差の大小で選ぶための表示）。
 * - **AV/HR は数値のまま・走力はバー**（ユーザー判断）＝HUDの打者カード・原作の名鑑と
 *   同じ表記を保ちつつ、表示用の新しい数値を作らずに走力を出す。
 * - **スキルと好調が数字に乗る**（`effectiveBatting` 経由＝CPUの代打が見ているのと同じ値）。
 * - **打順の表（試合前・試合間）が同じ物差しで並ぶ**＝名鑑の直読みをやめる。
 */
import { describe, expect, it } from 'vitest';
import {
  BATTER_STAT_HEADERS,
  RATING_TICKS,
  batterStatCells,
  createTeamRoster,
  displayHomeRuns,
  effectiveBatting,
  eraStatCell,
  formatAverage,
  grantSkill,
  ratingBar,
} from '../src/core/roster';
import { describeBatterEntry } from '../src/ui/managerMenu';
import { describeLineupRow } from '../src/ui/teamSelect';
import { LUCKY_INNING } from '../src/core/condition';
import { teamById } from '../src/core/teams';

const TEAM = teamById('foresters');
const roster = createTeamRoster(TEAM);

/** 全角を2・半角を1として数えた表示幅（等幅フォントで列が揃う条件） */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += /[　-鿿！-｠●○▶◆]/.test(ch) ? 2 : 1;
  return width;
}

/** バーの●の数（＝目で読める長さ） */
const filled = (line: string): number => (line.match(/●/g) ?? []).length;

describe('打者の能力値の列（batterStatCells）', () => {
  it('AV/HR は数値のまま・走力だけがバー（ユーザー判断）', () => {
    const stats = effectiveBatting(roster, roster.lineup[3]);
    const [average, homeRuns, run] = batterStatCells(stats);
    expect(average.trim()).toBe(formatAverage(stats.average));
    expect(Number(homeRuns.trim())).toBe(displayHomeRuns(stats.power));
    expect(run).toBe(ratingBar(stats.run));
  });

  it('HUDの打者カードと同じ数字が出る（画面をまたいで同じ物差し）', () => {
    for (const id of roster.lineup) {
      const stats = effectiveBatting(roster, id);
      const [average, homeRuns] = batterStatCells(stats);
      expect(average.trim()).toBe(formatAverage(stats.average));
      expect(Number(homeRuns.trim())).toBe(displayHomeRuns(stats.power));
    }
  });

  it('見出しと値のセルが同じ幅（列が縦に揃う条件）', () => {
    const cells = batterStatCells(effectiveBatting(roster, roster.lineup[0]));
    expect(cells).toHaveLength(BATTER_STAT_HEADERS.length);
    cells.forEach((cell, i) => {
      expect(displayWidth(cell)).toBe(displayWidth(BATTER_STAT_HEADERS[i]));
    });
  });

  it('投手の防御率の欄は打者のAV+HRとまったく同じ幅（走力のバーが横にずれない）', () => {
    const [average, homeRuns] = batterStatCells(effectiveBatting(roster, roster.lineup[0]));
    expect(displayWidth(eraStatCell(3.2))).toBe(displayWidth(`${average} ${homeRuns}`));
  });

  it('走力が高いほどバーが長い（バーの長さの大小＝足の速さの大小）', () => {
    const slow = batterStatCells({ bats: 'R', average: 0.5, power: 0.5, run: 0.1 })[2];
    const fast = batterStatCells({ bats: 'R', average: 0.5, power: 0.5, run: 0.9 })[2];
    expect(filled(fast)).toBeGreaterThan(filled(slow));
    expect(filled(fast)).toBeLessThanOrEqual(RATING_TICKS);
  });
});

describe('采配メニューの代打（describeBatterEntry）', () => {
  it('1行1人の表になる：名前・BOX・AV・HR・走力', () => {
    const line = describeBatterEntry(roster, roster.bench[0]);
    // 表なので改行しない（DD-51で継投を表に畳んだのと同じ形＝画面から溢れない）
    expect(line).not.toContain('\n');
    expect(line).toContain(roster.players[roster.bench[0]].name);
    expect(line).toContain(batterStatCells(effectiveBatting(roster, roster.bench[0])).join(' '));
  });

  it('列が縦に揃う（名前の長さによらず桁の位置が同じ＝比べるための表示）', () => {
    const positions = [...roster.bench, ...roster.lineup].map((id) =>
      displayWidth(describeBatterEntry(roster, id).split('●')[0].split('○')[0]),
    );
    // 名鑑には2〜4文字の名前が混在しうるので、ここが揃わなければ `padName` が効いていない
    expect(new Set(positions).size).toBe(1);
  });

  it('スキルの補正が数字に出る（`カジバノチカラ`＝力+0.35／打率-0.15）', () => {
    const id = roster.bench[0];
    const skilled = grantSkill(roster, id, 'kajibanochikara').roster;
    const before = effectiveBatting(roster, id);
    const after = effectiveBatting(skilled, id);
    expect(after.power).toBeGreaterThan(before.power);
    expect(describeBatterEntry(skilled, id)).toContain(
      String(displayHomeRuns(after.power)).padStart(2),
    );
    // 札の名前も同じ行に並ぶ（何がこの数字を動かしているのかが読める）
    expect(describeBatterEntry(skilled, id)).toContain('カジバノチカラ');
  });

  it('好調は数字と理由が同じ行に並ぶ（D-19。ラッキー7なら全員）', () => {
    const id = roster.bench[0];
    const plain = describeBatterEntry(roster, id);
    const hot = describeBatterEntry(roster, id, LUCKY_INNING);
    expect(plain).not.toContain('ゼッコーチョー');
    expect(hot).toContain('ゼッコーチョー');
    expect(hot).toContain(
      batterStatCells(effectiveBatting(roster, id, LUCKY_INNING)).slice(0, 2).join(' '),
    );
  });

  it('走力はスキルで動く（`チーター`＝RUN+0.4）＝表示と実際の足が食い違わない', () => {
    const id = roster.bench[0];
    const fast = grantSkill(roster, id, 'chita').roster;
    expect(effectiveBatting(fast, id).run).toBeGreaterThan(effectiveBatting(roster, id).run);
    expect(filled(describeBatterEntry(fast, id))).toBeGreaterThanOrEqual(
      filled(describeBatterEntry(roster, id)),
    );
    expect(describeBatterEntry(fast, id)).toContain(ratingBar(effectiveBatting(fast, id).run));
  });
});

describe('打順の表（describeLineupRow）', () => {
  it('打者の行は 打順・守備位置・名前・AV・HR・走力', () => {
    const line = describeLineupRow(roster, 0);
    const stats = effectiveBatting(roster, roster.lineup[0]);
    expect(line).toContain('1バン');
    expect(line).toContain(roster.players[roster.lineup[0]].name);
    expect(line).toContain(batterStatCells(stats).join(' '));
  });

  it('投手の行は防御率＋走力で、走力の列は9行とも同じ位置に来る', () => {
    const rows = roster.lineup.map((_, slot) => describeLineupRow(roster, slot));
    const barStarts = rows.map((line) => displayWidth(line.slice(0, line.search(/[●○]/))));
    expect(new Set(barStarts).size).toBe(1);
    expect(rows[roster.pitcherSlot]).toContain('ERA');
  });

  // フェーズEE-52：V-43で試合の間にもこの画面を通るようになったのに、打線の表は
  // 名鑑を直読みしていた＝スキルで能力が動いた打者も名鑑の値のまま出ていた
  // （DD-51が投手カードで直したのとまったく同じ食い違い）。
  it('能力値はスキルの補正込み（名鑑の直読みではない）', () => {
    const id = roster.lineup[2];
    const skilled = grantSkill(roster, id, 'kinniku').roster;
    expect(describeLineupRow(skilled, 2)).not.toBe(describeLineupRow(roster, 2));
    expect(describeLineupRow(skilled, 2)).toContain(
      batterStatCells(effectiveBatting(skilled, id)).join(' '),
    );
  });

  it('打順を入れ替えても能力値は選手に付いて回る（採配は打つ順番だけを変える）', () => {
    const swapped = createTeamRoster(TEAM, {
      starterIndex: 0,
      order: [1, 0, 2, 3, 4, 5, 6, 7, 8],
    });
    const first = describeLineupRow(roster, 0);
    const second = describeLineupRow(swapped, 1);
    // 打順の番号だけが違い、名前と能力値の並びは同じ
    expect(second.replace('2バン', '1バン')).toBe(first);
  });
});
