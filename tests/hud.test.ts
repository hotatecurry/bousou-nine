/**
 * HUDの打者カード／投手カードの文言（フェーズD-18）。
 *
 * hud.ts のうち**DOMに触らない純粋関数だけ**をここでテストする（パネルの配置・見た目は
 * 手動確認とPlaywrightの実機検証の担当。CLAUDE.md「テスト方針」）。カードの文言を
 * テストする値打ちは2つ：**原作のHUD項目（名前・打率・本塁打数／名前・防御率）が
 * 実際に出ているか**と、**交代（代打・継投）のあとに別の選手の数字へ切り替わるか**。
 * 後者は「表示が実際の対戦相手を指している」ことそのもので、ここがずれると
 * 表示を見て判断する意味がなくなる。
 */
import { describe, expect, it } from 'vitest';
import {
  batterCardText,
  gunLine,
  leadLine,
  pitcherCardText,
  runnerSpeedLine,
  scoreboardText,
  winnerText,
} from '../src/ui/hud/hud';
import { TEAMS, teamById } from '../src/core/teams';
import { createActor } from 'xstate';
import { gameMachine } from '../src/core/gameMachine';
import { EMPTY_BASES } from '../src/core/rules';
import {
  BULLPEN_SIZE,
  batterStatCells,
  createTeamRoster,
  effectiveBatting,
  grantSkill,
  recordGunShot,
  displayHomeRuns,
  formatAverage,
  formatEra,
  maxPitchesFor,
  ratingBar,
  recordPitch,
  setLineupIndex,
  substituteBatterAt,
  substitutePitcherAt,
  withHotBatters,
  BOUNCING_FORK_LABEL,
  pitcherForkBouncesOf,
  type TeamRoster,
} from '../src/core/roster';
import { FORK_BOUNCE_MIN_RATING } from '../src/core/pitch';
import { LUCKY_INNING } from '../src/core/condition';
import { DEFAULT_SEED } from '../src/core/rng';

/**
 * カードの文言を確かめるテストなので、**実在の球団を1組だけ**使う（フェーズB-12で
 * 名鑑が16球団になったため、仮ロスターではなく名鑑から起こす）。文言の形は球団に
 * よらないので、期待値は名鑑の値から計算して書く＝**名鑑の数字を調整しても
 * テストが壊れない**（球団の中身を固定したいのは `tests/teams.test.ts` の担当）。
 */
const AWAY_TEAM = teamById('flames');
const HOME_TEAM = teamById('foresters');

function throwPitches(roster: TeamRoster, count: number): TeamRoster {
  let next = roster;
  for (let i = 0; i < count; i++) next = recordPitch(next);
  return next;
}

describe('打者カード（フェーズD-18）', () => {
  it('打順・守備位置・名前・打率・本塁打数・代打の残りを出す', () => {
    const roster = createTeamRoster(AWAY_TEAM);
    const lines = batterCardText(roster).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('打者 1番 中堅');
    // 名前と打率・本塁打数（ブラッシュアップで原作の記号 AV/HR から日本語の見出しにした）
    const batter = roster.players[roster.lineup[0]];
    expect(lines[1]).toBe(
      `村瀬 打率${formatAverage(batter.batting.average)} 本塁打${displayHomeRuns(batter.batting.power)}` +
        ` 走力${ratingBar(batter.batting.run)}`,
    );
    expect(lines[2]).toBe('代打 残り3');
  });

  it('打順が進むとその打者のカードになる（9番は投手）', () => {
    const roster = createTeamRoster(AWAY_TEAM);
    expect(batterCardText(setLineupIndex(roster, 3)).split('\n')[0]).toBe('打者 4番 一塁');
    // 4番（主砲）は1番より本塁打が多く見える＝カードが打者の違いを伝えている
    const homeRuns = (slot: number) =>
      displayHomeRuns(roster.players[roster.lineup[slot]].batting.power);
    const slugger = batterCardText(setLineupIndex(roster, 3)).split('\n')[1];
    expect(slugger).toBe(
      `赤塚 打率.275 本塁打${homeRuns(3)} 走力${ratingBar(roster.players[roster.lineup[3]].batting.run)}`,
    );
    expect(homeRuns(3)).toBeGreaterThan(homeRuns(0));
    expect(batterCardText(setLineupIndex(roster, 8)).split('\n')[0]).toBe('打者 9番 投手');
  });

  it('代打を送るとカードの名前と数字が入れ替わり、残り人数が減る', () => {
    const roster = createTeamRoster(AWAY_TEAM);
    const { roster: next, ok } = substituteBatterAt(roster, 0);
    expect(ok).toBe(true);
    const lines = batterCardText(next).split('\n');
    // 代打は退いた選手の守備位置を引き継ぐ（フェーズB-10）ので見出しは変わらない
    expect(lines[0]).toBe('打者 1番 中堅');
    const pinch = next.players[next.lineup[0]];
    expect(lines[1]).toBe(
      `内山 打率${formatAverage(pinch.batting.average)} 本塁打${displayHomeRuns(pinch.batting.power)}` +
        ` 走力${ratingBar(pinch.batting.run)}`,
    );
    expect(lines[2]).toBe('代打 残り2');
  });

  it('守備位置を持たない打者（投手の打席への代打）では打順だけを出す', () => {
    const roster = setLineupIndex(createTeamRoster(AWAY_TEAM), 8);
    const { roster: next, ok } = substituteBatterAt(roster, 0);
    expect(ok).toBe(true);
    // 投手の打席への代打は自動継投を伴い、この1打席だけ守備位置を持たない
    expect(batterCardText(next).split('\n')[0]).toBe('打者 9番');
  });
});

/**
 * 打者カードの走力（フェーズFF-53）。EE-52で采配メニューと打順の段には走力の列が付いたが、
 * **いま打っている選手のカードはAV/HRのまま**で、足で選んだ代打も打席に入ると走者としての
 * 値打ちが見えなくなっていた。**行を増やさずに**（＝D-18で詰めたカードの高さの前提を
 * 動かさずに）能力値の行へ併記する、というのがここの約束。
 */
describe('打者カードの走力（フェーズFF-53）', () => {
  it('走力を足してもカードは3行のまま（D-18の高さの前提を動かさない）', () => {
    expect(batterCardText(createTeamRoster(AWAY_TEAM)).split('\n')).toHaveLength(3);
  });

  it('AV/HRと同じ行に、EE-52の表とまったく同じ目盛りで出る', () => {
    const roster = createTeamRoster(AWAY_TEAM);
    const stats = effectiveBatting(roster, roster.lineup[0]);
    const line = batterCardText(roster).split('\n')[1];
    // 表（`batterStatCells`）の3つ目の列＝同じ選手が画面をまたいで同じ見え方をする
    expect(line.endsWith(` 走力${batterStatCells(stats)[2]}`)).toBe(true);
  });

  it('走力の違う打者はバーの長さが違う（列が飾りになっていない）', () => {
    const roster = createTeamRoster(teamById('winds'));
    const bars = roster.lineup.map(
      (id) => batterCardText(setLineupIndex(roster, roster.lineup.indexOf(id))).split('\n')[1],
    );
    expect(new Set(bars.map((line) => line.slice(line.indexOf('走力')))).size).toBeGreaterThan(1);
  });

  it('スキルで走力が上がればバーも伸びる（表示はレーティングからの導出）', () => {
    // 足の遅い打者（9番＝投手）に `チーター`（RUN +0.4）を付ける＝目盛りが確実に動く
    const roster = setLineupIndex(createTeamRoster(AWAY_TEAM), 8);
    const faster = grantSkill(roster, roster.lineup[8], 'chita').roster;
    const bar = (r: TeamRoster) => {
      const line = batterCardText(r).split('\n')[1];
      return line.slice(line.indexOf('走力'));
    };
    expect(bar(faster)).not.toBe(bar(roster));
    expect(bar(faster)).toBe(`走力${ratingBar(effectiveBatting(faster, faster.lineup[8]).run)}`);
  });

  it('好調（D-19）では走力のバーは動かない（好調が動かすのは打撃だけ）', () => {
    const base = createTeamRoster(AWAY_TEAM);
    const roster = withHotBatters(base, DEFAULT_SEED, 'away');
    const slot = roster.lineup.findIndex((id) => roster.hot.includes(id));
    const hot = batterCardText(setLineupIndex(roster, slot), 1).split('\n')[1];
    const plain = batterCardText(setLineupIndex(base, slot)).split('\n')[1];
    expect(hot.slice(hot.indexOf('走力'))).toBe(plain.slice(plain.indexOf('走力')));
  });
});

/**
 * 好調の行（フェーズD-19）。**平常時のカードが1行も増えていないこと**を固定するのが
 * ここの主眼で、D-18で詰めた「パネル同士が重ならない」高さの前提を、好調が回って
 * こない打席では一切動かさないという約束にあたる（スキルの行と同じ扱い）。
 */
describe('打者カードの好調（フェーズD-19）', () => {
  it('好調でない打者のカードは従来どおり3行のまま', () => {
    const roster = createTeamRoster(AWAY_TEAM);
    expect(batterCardText(roster, 1).split('\n')).toHaveLength(3);
  });

  it('絶好調選手には理由の行が出て、AV/HRも上がった値で出る', () => {
    const base = createTeamRoster(AWAY_TEAM);
    const roster = withHotBatters(base, DEFAULT_SEED, 'away');
    const slot = roster.lineup.findIndex((id) => roster.hot.includes(id));
    expect(slot).toBeGreaterThanOrEqual(0);
    const lines = batterCardText(setLineupIndex(roster, slot), 1).split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('絶好調！');
    // 数字も一緒に動いている（表示はレーティングからの導出。⑥）
    const plain = batterCardText(setLineupIndex(base, slot)).split('\n')[1];
    expect(lines[1]).not.toBe(plain);
  });

  it('ラッキー7（7回）は好調でない打者のカードにも出る', () => {
    const roster = createTeamRoster(AWAY_TEAM);
    expect(batterCardText(roster, LUCKY_INNING).split('\n')).toContain('絶好調！');
    expect(batterCardText(roster, LUCKY_INNING - 1).split('\n')).not.toContain('絶好調！');
  });

  it('イニングを渡さない呼び出しは従来とまったく同じ文言', () => {
    const roster = createTeamRoster(AWAY_TEAM);
    expect(batterCardText(roster)).toBe(batterCardText(roster, 1));
  });
});

describe('投手カード（フェーズD-18）', () => {
  it('名前・防御率・救援の残り・スタミナゲージを出す', () => {
    const roster = createTeamRoster(HOME_TEAM);
    const lines = pitcherCardText(roster).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('投手 岩渕');
    const era = roster.players[roster.pitcher].pitching!.era;
    expect(lines[1]).toBe(`防御率${formatEra(era)} 救援 残り${BULLPEN_SIZE}`);
    // 無傷は10目盛りすべて埋まっている（B-11のゲージをそのままカードへ移した）
    expect(lines[2]).toBe('スタミナ ■■■■■■■■■■');
  });

  it('投球数が増えるとゲージが減り、球威が落ちたら文字でも出る', () => {
    const roster = createTeamRoster(HOME_TEAM);
    const max = maxPitchesFor(roster.players[roster.pitcher].pitching!.stamina);
    const half = pitcherCardText(throwPitches(roster, Math.round(max / 2))).split('\n');
    expect(half).toHaveLength(3);
    expect(half[2]).toBe('スタミナ ■■■■■□□□□□');
    // 半分を切ってから球威が落ちる（STAMINA_FRESH_THRESHOLD）＝そこで初めて警告が出る。
    // 警告はゲージと同じ行に足さない（カードが横に伸びて画面中央へ張り出すため）
    const spent = pitcherCardText(throwPitches(roster, max)).split('\n');
    expect(spent).toHaveLength(4);
    expect(spent[2]).toBe('スタミナ □□□□□□□□□□');
    expect(spent[3]).toBe('球威ダウン');
    // 疲労で行が増えてもいちばん長い行の長さは変わらない＝カードの幅が変わらない
    // （全角/半角の差でピクセル幅とは一致しないが、警告を別行にした狙いはこれで固定できる）
    const longest = (lines: string[]) => Math.max(...lines.map((l) => l.length));
    expect(longest(spent)).toBe(longest(half));
  });

  it('継投すると新しい投手の防御率とゲージになる', () => {
    const roster = throwPitches(createTeamRoster(HOME_TEAM), 200);
    const { roster: next, ok } = substitutePitcherAt(roster, 0);
    expect(ok).toBe(true);
    const lines = pitcherCardText(next).split('\n');
    const reliever = next.players[next.pitcher];
    expect(lines[0]).toBe('投手 細谷');
    expect(lines[1]).toBe(
      `防御率${formatEra(reliever.pitching!.era)} 救援 残り${BULLPEN_SIZE - 1}`,
    );
    expect(lines[2]).toBe('スタミナ ■■■■■■■■■■');
  });

  it('ワンバウンドするフォークを持つ投手にだけ「落ちるフォーク」の行が出る（フェーズBBB-79）', () => {
    const roster = createTeamRoster(HOME_TEAM);
    // 先発（Fが境目より小さい）には行そのものが出ない＝平常時のカードの高さは動かない
    expect(pitcherForkBouncesOf(roster, roster.pitcher)).toBe(false);
    expect(pitcherCardText(roster)).not.toContain(BOUNCING_FORK_LABEL);
    // Fの大きい投手に代わると出る（見逃せばボールになる球＝打つ側にも投げる側にも要る材料）
    const { roster: next } = substitutePitcherAt(roster, 0);
    expect(next.players[next.pitcher].pitching!.fork).toBeGreaterThanOrEqual(FORK_BOUNCE_MIN_RATING);
    expect(pitcherCardText(next).split('\n')).toContain(BOUNCING_FORK_LABEL);
    // 疲れて変化量が落ちれば落ちなくなる＝行も消える（実際の球と同じ式から出す）
    const max = maxPitchesFor(next.players[next.pitcher].pitching!.stamina);
    expect(pitcherCardText(throwPitches(next, max))).not.toContain(BOUNCING_FORK_LABEL);
  });

  it('投球能力を持たない選手がマウンドにいても表示で止まらない（保険）', () => {
    const roster = createTeamRoster(HOME_TEAM);
    const fielder = roster.lineup[0];
    const broken: TeamRoster = { ...roster, pitcher: fielder };
    const lines = pitcherCardText(broken).split('\n');
    expect(lines[0]).toBe('投手 相原');
    // 防御率の欄は落とし、残りの情報はそのまま出す
    expect(lines[1]).toBe(`救援 残り${BULLPEN_SIZE}`);
    expect(lines[2]).toBe('スタミナ ■■■■■■■■■■');
  });
});

/**
 * スコアボードと勝敗表示は、フェーズC-13で「ビジター/ホーム」固定から**選んだ球団**に
 * 変わった。ここで確かめたいのは**表示が実際に選ばれた球団を指しているか**と、
 * **どの球団でも列がずれないか**（略称を全球団2文字に揃えた狙いはこれ）。
 */
describe('スコアボード・勝敗表示（フェーズC-13）', () => {
  function startGame(away: string, home: string) {
    const actor = createActor(gameMachine).start();
    actor.send({ type: 'MATCH_SETUP', away, home });
    return actor;
  }

  it('行の頭が選ばれた球団の略称になる', () => {
    const actor = startGame('comets', 'moons');
    const lines = scoreboardText(actor.getSnapshot().context).split('\n');
    expect(lines[1].startsWith('コメ ')).toBe(true);
    expect(lines[2].startsWith('ムン ')).toBe(true);
  });

  /**
   * 見出しの回数字と得点の桁が縦に揃うかは**文字数ではなく表示幅**で決まる（カタカナは
   * 半角の2倍幅で描かれる）。略称を全球団カタカナ2文字に揃え、見出しの空白を半角5つに
   * したのはこの一致のため。
   */
  const displayWidth = (line: string) =>
    [...line].reduce((w, ch) => w + (/[ -~]/.test(ch) ? 1 : 2), 0);

  it('どの球団の組み合わせでも3行の表示幅が揃う（列がずれない）', () => {
    for (const away of TEAMS) {
      for (const home of TEAMS) {
        const lines = scoreboardText(startGame(away.id, home.id).getSnapshot().context).split('\n');
        expect(displayWidth(lines[0]), `${away.name} vs ${home.name}`).toBe(displayWidth(lines[1]));
        expect(displayWidth(lines[1])).toBe(displayWidth(lines[2]));
      }
    }
  });

  /**
   * ラン（フェーズF-26-6）の進行はスコアボードの上に1行足す。**ランを通していない
   * 呼び出しでは行そのものが出ない**ので、上の「3行の表示幅が揃う」前提は動かない。
   */
  it('ランの進行を渡すと1行増え、渡さなければ従来どおり3行', () => {
    const ctx = startGame('comets', 'moons').getSnapshot().context;
    expect(scoreboardText(ctx).split('\n')).toHaveLength(3);
    const withRun = scoreboardText(ctx, { game: 3, wins: 2, total: 5 }).split('\n');
    expect(withRun).toHaveLength(4);
    expect(withRun[0]).toBe('ラン 3/5 2勝');
  });

  it('勝敗表示は球団名で出る', () => {
    const actor = startGame('winds', 'rockets');
    // 9回裏を待たずに決着させる（没収試合＝相手の勝ち）
    actor.send({ type: 'FORFEIT', loser: 'home' });
    expect(winnerText(actor.getSnapshot().context)).toBe('ウィンズの勝ち！');
    const away = startGame('winds', 'rockets');
    away.send({ type: 'FORFEIT', loser: 'away' });
    expect(winnerText(away.getSnapshot().context)).toBe('ロケッツの勝ち！');
  });

  it('試合前なら選び直せるが、1球投げた後のチーム変更は効かない', () => {
    const actor = startGame('comets', 'moons');
    actor.send({ type: 'MATCH_SETUP', away: 'winds', home: 'irons' });
    expect(actor.getSnapshot().context.rosters.away.team.id).toBe('winds');
    // 打席が進んだ後は握りつぶす（塁上の走者・投球数といった記録を無効にしないため）
    actor.send({ type: 'PITCH_RESULT', judgement: 'strike' });
    actor.send({ type: 'MATCH_SETUP', away: 'comets', home: 'moons' });
    expect(actor.getSnapshot().context.rosters.away.team.id).toBe('winds');
    expect(actor.getSnapshot().context.rosters.home.team.id).toBe('irons');
  });

  it('得点が入った後のチーム変更も効かない（記録が消えない）', () => {
    const actor = startGame('comets', 'moons');
    actor.send({ type: 'PLAY_RESOLVED', outsAdded: 0, runs: 1, bases: EMPTY_BASES });
    actor.send({ type: 'MATCH_SETUP', away: 'winds', home: 'irons' });
    expect(actor.getSnapshot().context.rosters.away.team.id).toBe('comets');
    expect(actor.getSnapshot().context.score.away).toBe(1);
  });
});

/**
 * 銃の行（フェーズF-26-2）。銃はスキル `ジュウ` に吸収されたので、**取っていない試合では
 * 行そのものが出ない**（＝D-18で詰めたパネルの高さの前提を、取っていない間は動かさない）。
 */
/**
 * 状況パネルの幅の予算（半角換算）。D-18 で「決着バナーと重ならない」ように詰めた幅＝
 * 当時の操作の行（`◆ソウサ:トウキュウ  Start:サクセン`）の表示幅。ブラッシュアップで
 * 文言が漢字になって操作の行そのものは短くなったが、**パネルが越えてはいけない幅**は
 * この数字のまま＝リードの行・走力の行が足されてもここを超えない。
 */
const D18_SITUATION_PANEL_WIDTH = 35;

describe('状況パネルのリードの行（フェーズL-32）', () => {
  it('持ち越したリードが無ければ行そのものが出ない（平常時はL-32の前と同じ高さ）', () => {
    expect(leadLine(undefined)).toBe('');
    expect(leadLine({})).toBe('');
  });

  it('リードしている塁と距離が出る（走るか投げるかの判断材料）', () => {
    expect(leadLine({ first: 5.2 })).toBe('\nリード 1:5.2');
  });

  it('リード0も出す＝「けん制で釘付けにされた」ことが読める', () => {
    expect(leadLine({ first: 0 })).toBe('\nリード 1:0.0');
  });

  it('複数の走者を塁の順に並べる（ダブルスチールの判断材料）', () => {
    expect(leadLine({ first: 1.5, second: 6 })).toBe('\nリード 1:1.5 2:6.0');
  });

  it('パネルの横幅を広げない（決着バナーと重ならないための条件。D-18）', () => {
    // パネルの幅は**いちばん長い行**で決まる。常時出ている操作の行より短ければ、
    // リードの行が増えてもパネルは1ピクセルも横に伸びない＝D-18で詰めた
    // 「バナーと重ならない」前提を動かさない。全角＝半角2つぶんの表示幅で比べる。
    const width = (s: string): number =>
      [...s].reduce((w, c) => w + (c.charCodeAt(0) < 0x80 ? 1 : 2), 0);
    const longest = leadLine({ first: 6, second: 6, third: 6 }).replace('\n', '');
    expect(width(longest)).toBeLessThan(D18_SITUATION_PANEL_WIDTH);
  });
});

/**
 * 走者の走力の行（フェーズFF-53）。**走者がいないときは行そのものが出ない**（＝リードの行・
 * 銃の行・好調の行と同じ扱いで、平常時のパネルの高さはFF-53の前と1行も変わらない）ことと、
 * **満塁でもパネルの横幅が広がらない**（L-32が上で固定した条件をそのまま守る）ことが主眼。
 */
describe('状況パネルの走者の走力の行（フェーズFF-53）', () => {
  /** 指定した塁に、指定した選手（打線の添字）を置いた文脈を作る */
  function withRunners(slots: { first?: number; second?: number; third?: number }) {
    const actor = createActor(gameMachine).start();
    actor.send({ type: 'MATCH_SETUP', away: 'winds', home: 'irons' });
    const roster = actor.getSnapshot().context.rosters.away;
    const id = (slot: number | undefined) => (slot === undefined ? null : roster.lineup[slot]);
    actor.send({
      type: 'PLAY_RESOLVED',
      outsAdded: 0,
      runs: 0,
      bases: {
        first: slots.first !== undefined,
        second: slots.second !== undefined,
        third: slots.third !== undefined,
      },
      baseRunners: { first: id(slots.first), second: id(slots.second), third: id(slots.third) },
    });
    return actor.getSnapshot().context;
  }

  const width = (s: string): number =>
    [...s].reduce((w, c) => w + (c.charCodeAt(0) < 0x80 ? 1 : 2), 0);

  it('走者がいなければ行そのものが出ない（平常時はFF-53の前と同じ高さ）', () => {
    const actor = createActor(gameMachine).start();
    actor.send({ type: 'MATCH_SETUP', away: 'winds', home: 'irons' });
    expect(runnerSpeedLine(actor.getSnapshot().context)).toBe('');
  });

  it('塁の番号と走力のバーが、リードの行と同じ並びで出る', () => {
    const game = withRunners({ first: 0 });
    const runner = game.rosters.away.players[game.rosters.away.lineup[0]];
    expect(runnerSpeedLine(game)).toBe(`\n走力 1:${ratingBar(runner.batting.run)}`);
  });

  it('複数の走者を塁の順に並べる（ダブルスチールでどちらを走らせるかの材料）', () => {
    const game = withRunners({ first: 3, second: 0 });
    const bar = (slot: number) =>
      ratingBar(game.rosters.away.players[game.rosters.away.lineup[slot]].batting.run);
    expect(runnerSpeedLine(game)).toBe(`\n走力 1:${bar(3)} 2:${bar(0)}`);
  });

  it('満塁は3人目を字下げして次の行へ送る（パネルの横幅を広げないため）', () => {
    const lines = runnerSpeedLine(withRunners({ first: 0, second: 1, third: 2 })).split('\n');
    expect(lines).toHaveLength(3); // 先頭の空文字（改行から始まる）＋2行
    expect(lines[1].startsWith('走力 1:')).toBe(true);
    expect(lines[2].startsWith('　　 3:')).toBe(true);
    // 続きの行の字下げは見出しとちょうど同じ幅＝塁の番号が縦に揃う
    expect(width(lines[1].split('1:')[0])).toBe(width(lines[2].split('3:')[0]));
  });

  it('パネルの横幅を広げない（L-32がリードの行に置いた条件と同じ）', () => {
    const longest = runnerSpeedLine(withRunners({ first: 0, second: 1, third: 2 }))
      .split('\n')
      .reduce((a, b) => (width(a) >= width(b) ? a : b));
    expect(width(longest)).toBeLessThan(D18_SITUATION_PANEL_WIDTH);
  });

  it('スキルで走力が上がった走者はバーも伸びる（判定と表示が同じ出どころ）', () => {
    // 足の遅い走者（9番＝投手）に `チーター`（RUN +0.4）＝目盛りが確実に動く
    const game = withRunners({ first: 8 });
    const id = game.rosters.away.lineup[8];
    const before = runnerSpeedLine(game);
    const faster = {
      ...game,
      rosters: { ...game.rosters, away: grantSkill(game.rosters.away, id, 'chita').roster },
    };
    expect(runnerSpeedLine(faster)).not.toBe(before);
    expect(runnerSpeedLine(faster)).toBe(
      `\n走力 1:${ratingBar(effectiveBatting(faster.rosters.away, id).run)}`,
    );
  });

  it('名鑑に無い無名の走者は基準値で出す（実際に走る速さと同じ扱い）', () => {
    const actor = createActor(gameMachine).start();
    actor.send({ type: 'MATCH_SETUP', away: 'winds', home: 'irons' });
    // 真偽値だけの経路（走者の識別を渡さないプレー）では走者が無名になる
    actor.send({
      type: 'PLAY_RESOLVED',
      outsAdded: 0,
      runs: 0,
      bases: { first: true, second: false, third: false },
    });
    expect(runnerSpeedLine(actor.getSnapshot().context)).toBe(`\n走力 1:${ratingBar(0.5)}`);
  });

  it('攻撃側のロスターから引く（裏の攻撃では後攻の走者を出す）', () => {
    const actor = createActor(gameMachine).start();
    actor.send({ type: 'MATCH_SETUP', away: 'winds', home: 'irons' });
    // 三振3つで攻守交代（表の攻撃を終わらせる）
    for (let i = 0; i < 9; i++) actor.send({ type: 'PITCH_RESULT', judgement: 'strike' });
    expect(actor.getSnapshot().context.half).toBe('bottom');
    const home = actor.getSnapshot().context.rosters.home;
    actor.send({
      type: 'PLAY_RESOLVED',
      outsAdded: 0,
      runs: 0,
      bases: { first: false, second: true, third: false },
      baseRunners: { first: null, second: home.lineup[0], third: null },
    });
    const game = actor.getSnapshot().context;
    expect(runnerSpeedLine(game)).toBe(
      `\n走力 2:${ratingBar(home.players[home.lineup[0]].batting.run)}`,
    );
  });
});

describe('状況パネルの銃の行（フェーズF-26-2）', () => {
  function withGun() {
    const roster = createTeamRoster(HOME_TEAM);
    return grantSkill(roster, roster.pitcher, 'ju').roster;
  }

  it('スキルを持たない投手のときは行が出ない', () => {
    expect(gunLine(createTeamRoster(HOME_TEAM), false)).toBe('');
    // 銃モードのフラグが立っていても、持っていなければ出さない（入れないので起きないが保険）
    expect(gunLine(createTeamRoster(HOME_TEAM), true)).toBe('');
  });

  it('スキルを持つ投手のときは残弾が出る', () => {
    expect(gunLine(withGun(), false)).toBe('\n銃 残り3');
  });

  it('銃モード中は構えていることが分かる表記になる', () => {
    expect(gunLine(withGun(), true)).toBe('\n▶銃モード（残り3）');
  });

  it('撃つと残弾の表示が減り、撃ち切っても行は残る（弾切れが見える）', () => {
    let roster = withGun();
    roster = recordGunShot(roster);
    expect(gunLine(roster, false)).toBe('\n銃 残り2');
    roster = recordGunShot(recordGunShot(roster));
    expect(gunLine(roster, false)).toBe('\n銃 残り0');
  });

  it('継投で銃を持たない投手になれば行ごと消える（残弾は投手個人のもの）', () => {
    const { roster: relieved } = substitutePitcherAt(withGun(), 0);
    expect(gunLine(relieved, false)).toBe('');
  });

  it('投手カードにもスキルとして出る（何を持っているかが1か所で分かる）', () => {
    const lines = pitcherCardText(withGun()).split('\n');
    expect(lines[lines.length - 1]).toBe('スキル 銃');
  });

  /**
   * **スキルを何個持ってもカードは横に伸びない**（フェーズF-26-7）。ラン化で1選手が
   * 最大4つ（枠3＋デュオ）持つようになり、横に並べると
   * `スキル タフネス ハグルマ ジュウ ホーミングダン` の1行がカードの幅を決めて
   * **画面中央（でっかいモードの視線の通り道）へ張り出す**（実機で確認したので縦並びに直した）。
   * D-18の「球威ダウンの警告をゲージと同じ行に足さない」と同じ約束を、ここでも固定する。
   */
  it('スキルが増えても行が縦に増えるだけで、いちばん長い行は伸びない', () => {
    let roster = createTeamRoster(HOME_TEAM);
    const id = roster.pitcher;
    // 枠いっぱい（3つ）＋デュオ＝4つ。いずれも投手に付く長めの名前を選ぶ
    for (const skillId of ['tafunesu', 'haguruma', 'ju', 'homingudan'] as const) {
      roster = grantSkill(roster, id, skillId).roster;
    }
    const lines = pitcherCardText(roster).split('\n');
    expect(lines.filter((l) => l.includes('タフネス') || l.includes('ホーミング弾'))).toHaveLength(2);
    // カードの幅は**表示幅**で決まる（カタカナは半角の2倍で描かれる）ので、文字数ではなく
    // そちらで測る。スタミナゲージ＝D-18でカードの幅を決めている行を超えないこと。
    const displayWidth = (line: string) =>
      [...line].reduce((w, ch) => w + (/[ -~]/.test(ch) ? 1 : 2), 0);
    const gauge = displayWidth(lines.find((l) => l.startsWith('スタミナ'))!);
    for (const line of lines) expect(displayWidth(line), line).toBeLessThanOrEqual(gauge);
  });
});

/**
 * 消費型スキルの残り回数（フェーズF-26-8）。**残りがいくつかは「いま使うか、温存して
 * 強化を狙うか」という判断そのものの材料**なので、カードに出ていないと判断が成立しない
 * （既存の「意思決定材料は隠さない」方針＝スタミナゲージを両側に見せているのと同じ）。
 */
describe('選手カードの消費型スキル（フェーズF-26-8）', () => {
  function withConsumable() {
    const roster = createTeamRoster(HOME_TEAM);
    return grantSkill(roster, roster.pitcher, 'yobiju').roster;
  }

  /**
   * **銃の行は「持っているか」ではなく「撃てるか」で出す**。ここを `hasSkill('ju')` の
   * ままにしていたため、`ヨビジュウ` だけの投手は**撃てるのに残弾がどこにも出ない**
   * 状態になっていた（実機で発見：Gで銃モードには入れるのにパネルは2行のまま）。
   */
  it('消費型の弾だけの投手でも銃の行が出る（撃てるのに残弾が見えない、を防ぐ）', () => {
    expect(gunLine(withConsumable(), false)).toBe('\n銃 残り1');
    expect(gunLine(withConsumable(), true)).toBe('\n▶銃モード（残り1）');
  });

  it('撃ち切れば行ごと消える（消費型は弾切れの表示を残さない）', () => {
    expect(gunLine(recordGunShot(withConsumable()), false)).toBe('');
  });

  it('消費型は残り回数まで出る', () => {
    const lines = pitcherCardText(withConsumable()).split('\n');
    expect(lines[lines.length - 1]).toBe('スキル 予備銃 残り1');
  });

  it('常設のスキルには残り回数を出さない（従来の見た目のまま）', () => {
    const roster = createTeamRoster(HOME_TEAM);
    const lines = pitcherCardText(grantSkill(roster, roster.pitcher, 'ju').roster).split('\n');
    expect(lines[lines.length - 1]).toBe('スキル 銃');
  });

  it('使い切ると行ごと消える（もう使えないものはカードに残らない）', () => {
    const roster = recordGunShot(withConsumable());
    const lines = pitcherCardText(roster).split('\n');
    expect(lines.some((l) => l.includes('予備銃'))).toBe(false);
  });

  it('残り回数が付いてもカードは横に伸びない（スタミナゲージを超えない）', () => {
    let roster = withConsumable();
    roster = grantSkill(roster, roster.pitcher, 'renshaju').roster;
    roster = grantSkill(roster, roster.pitcher, 'tafunesu').roster;
    roster = grantSkill(roster, roster.pitcher, 'haguruma').roster;
    const lines = pitcherCardText(roster).split('\n');
    expect(lines.some((l) => l.includes('予備銃 残り3'))).toBe(true);
    const displayWidth = (line: string) =>
      [...line].reduce((w, ch) => w + (/[ -~]/.test(ch) ? 1 : 2), 0);
    const gauge = displayWidth(lines.find((l) => l.startsWith('スタミナ'))!);
    for (const line of lines) expect(displayWidth(line), line).toBeLessThanOrEqual(gauge);
  });
});
