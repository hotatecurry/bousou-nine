import { describe, expect, it } from 'vitest';
import { createActor } from 'xstate';
import { gameMachine } from '../src/core/gameMachine';
import { EMPTY_BASES, EMPTY_COUNT, fieldingTeam } from '../src/core/rules';
import {
  BULLPEN_SIZE,
  DEFAULT_ROSTER_PLAN,
  PITCHER_ORDER_SLOT,
  currentBatterId,
  fatigueOf,
  gunRemainingOf,
  gunShotsOf,
  hasSkill,
  maxPitchesFor,
  pitchCountOf,
  swapBattingOrder,
} from '../src/core/roster';
import { type SkillId, GUN_SHOTS_PER_PITCHER } from '../src/core/skills';
import { teamById } from '../src/core/teams';

function startGame() {
  return createActor(gameMachine).start();
}

/** 3アウトを一括で送って半イニングを終わらせる */
function endHalf(actor: ReturnType<typeof startGame>, runs = 0) {
  actor.send({ type: 'PLAY_RESOLVED', outsAdded: 3, runs, bases: EMPTY_BASES });
}

describe('gameMachine: カウントと打席結果', () => {
  it('初期状態は1回表・無死・0-0', () => {
    const actor = startGame();
    const ctx = actor.getSnapshot().context;
    expect(ctx.inning).toBe(1);
    expect(ctx.half).toBe('top');
    expect(ctx.outs).toBe(0);
    expect(ctx.score).toEqual({ away: 0, home: 0 });
    // 銃は誰も持っていない状態から始まる（フェーズF-26-2でスキル `ジュウ` に吸収された）
    expect(gunRemainingOf(ctx.rosters.home, ctx.rosters.home.pitcher)).toBe(0);
  });

  it('4ボールで四球: 走者一塁・カウントリセット', () => {
    const actor = startGame();
    for (let i = 0; i < 4; i++) {
      actor.send({ type: 'PITCH_RESULT', judgement: 'ball' });
    }
    const ctx = actor.getSnapshot().context;
    expect(ctx.bases).toEqual({ first: true, second: false, third: false });
    expect(ctx.count).toEqual({ balls: 0, strikes: 0 });
  });

  it('3ストライクで三振: アウト+1・カウントリセット', () => {
    const actor = startGame();
    for (let i = 0; i < 3; i++) {
      actor.send({ type: 'PITCH_RESULT', judgement: 'strike' });
    }
    const ctx = actor.getSnapshot().context;
    expect(ctx.outs).toBe(1);
    expect(ctx.count).toEqual({ balls: 0, strikes: 0 });
  });

  it('2ストライクからのファウルでは三振しない', () => {
    const actor = startGame();
    actor.send({ type: 'PITCH_RESULT', judgement: 'strike' });
    actor.send({ type: 'PITCH_RESULT', judgement: 'strike' });
    actor.send({ type: 'PITCH_RESULT', judgement: 'foul' });
    const ctx = actor.getSnapshot().context;
    expect(ctx.outs).toBe(0);
    expect(ctx.count.strikes).toBe(2);
  });

  // バントのファウル（フェーズAA-48）。通常のファウルとの違いはここだけで、
  // 三振になった後の処理（アウト・カウントの仕切り直し・打順）は既存の三振と同じ経路。
  it('2ストライクからのバントファウルは三振になる（打順も進む）', () => {
    const actor = startGame();
    actor.send({ type: 'PITCH_RESULT', judgement: 'strike' });
    actor.send({ type: 'PITCH_RESULT', judgement: 'strike' });
    actor.send({ type: 'PITCH_RESULT', judgement: 'buntFoul' });
    const ctx = actor.getSnapshot().context;
    expect(ctx.outs).toBe(1);
    expect(ctx.count).toEqual({ balls: 0, strikes: 0 });
    expect(ctx.rosters.away.lineupIndex).toBe(1);
  });

  it('1ストライクまでのバントファウルは通常のストライクと同じ（打席は続く）', () => {
    const actor = startGame();
    actor.send({ type: 'PITCH_RESULT', judgement: 'buntFoul' });
    actor.send({ type: 'PITCH_RESULT', judgement: 'buntFoul' });
    const ctx = actor.getSnapshot().context;
    expect(ctx.outs).toBe(0);
    expect(ctx.count).toEqual({ balls: 0, strikes: 2 });
    expect(ctx.rosters.away.lineupIndex).toBe(0);
  });

  it('三振3つで攻守交代', () => {
    const actor = startGame();
    for (let i = 0; i < 9; i++) {
      actor.send({ type: 'PITCH_RESULT', judgement: 'strike' });
    }
    const ctx = actor.getSnapshot().context;
    expect(ctx.inning).toBe(1);
    expect(ctx.half).toBe('bottom');
    expect(ctx.outs).toBe(0);
  });

  it('死球で打者一塁へ（退場は発生しない）', () => {
    const actor = startGame();
    actor.send({ type: 'HIT_BY_PITCH' });
    const ctx = actor.getSnapshot().context;
    expect(ctx.bases.first).toBe(true);
    expect(ctx.winner).toBeNull();
  });

  it('満塁からの押し出し四球で1点', () => {
    const actor = startGame();
    actor.send({ type: 'HIT_BY_PITCH' });
    actor.send({ type: 'HIT_BY_PITCH' });
    actor.send({ type: 'HIT_BY_PITCH' });
    for (let i = 0; i < 4; i++) {
      actor.send({ type: 'PITCH_RESULT', judgement: 'ball' });
    }
    const ctx = actor.getSnapshot().context;
    expect(ctx.score.away).toBe(1);
    expect(ctx.bases).toEqual({ first: true, second: true, third: true });
  });
});

// 銃はスキル `ジュウ` を取った投手だけが撃てる（フェーズF-26-2）。残弾はチーム共有では
// なく**投手個人**で、状態として持つのは発射数だけ（残弾はそこからの導出）。
describe('gameMachine: 銃システム', () => {
  /**
   * 目当てのスキルが3択に出るまで引き直して、指定の選手に付ける。
   *
   * **UIの外からスキルを流し込む経路は無い**（`SKILL_GRANTED` は提示中の候補しか通さない）
   * ので、テストも実際の経路（抽選→付与）をそのまま通す。抽選はシード固定で決定的なため、
   * この引き直し自体も毎回同じ回数で終わる。引く側は攻撃中のチームなので、
   * 付けたい選手のチームが攻撃している半イニングで呼ぶ。
   */
  function grantViaDraft(
    actor: ReturnType<typeof startGame>,
    side: 'away' | 'home',
    playerId: string,
    skillId: SkillId,
  ) {
    for (let i = 0; i < 50; i++) {
      actor.send({ type: 'SKILL_DRAFT_DRAWN' });
      const pending = actor.getSnapshot().context.pendingDraft;
      expect(pending).not.toBeNull();
      if (pending!.side === side && pending!.draft.options.includes(skillId)) {
        actor.send({ type: 'SKILL_GRANTED', side, playerId, skillId });
        expect(hasSkill(actor.getSnapshot().context.rosters[side], playerId, skillId)).toBe(true);
        return;
      }
      // 候補に無ければ提示だけ畳んで引き直す（存在しない選手IDなので何も付かない）
      actor.send({
        type: 'SKILL_GRANTED',
        side: pending!.side,
        playerId: '',
        skillId: pending!.draft.options[0],
      });
    }
    throw new Error(`${skillId} が抽選に出なかった`);
  }

  it('`ジュウ` を持たない投手は撃てない（GUN_USED を送っても何も起きない）', () => {
    const actor = startGame();
    actor.send({ type: 'GUN_USED' });
    const ctx = actor.getSnapshot().context;
    const roster = ctx.rosters[fieldingTeam(ctx.half)];
    expect(gunShotsOf(roster, roster.pitcher)).toBe(0);
    expect(gunRemainingOf(roster, roster.pitcher)).toBe(0);
  });

  it('`ジュウ` を持つ投手は撃つたびに残弾が減り、投球数には数えない', () => {
    const actor = startGame();
    endHalf(actor); // 1回裏＝ホームの攻撃（ホームが抽選を引く回）
    const pitcher = actor.getSnapshot().context.rosters.home.pitcher;
    grantViaDraft(actor, 'home', pitcher, 'ju');
    endHalf(actor); // 2回表＝ホームが守備に戻る

    actor.send({ type: 'GUN_USED' });
    const roster = actor.getSnapshot().context.rosters.home;
    expect(gunRemainingOf(roster, pitcher)).toBe(GUN_SHOTS_PER_PITCHER - 1);
    // 銃は投球ではないので投球数（＝スタミナ）には数えない
    expect(pitchCountOf(roster, pitcher)).toBe(0);
  });

  it('残弾を撃ち切ると以降は何も起きない（投手個人の3発）', () => {
    const actor = startGame();
    endHalf(actor);
    const pitcher = actor.getSnapshot().context.rosters.home.pitcher;
    grantViaDraft(actor, 'home', pitcher, 'ju');
    endHalf(actor);

    for (let i = 0; i < GUN_SHOTS_PER_PITCHER + 2; i++) {
      actor.send({ type: 'GUN_USED' });
    }
    const roster = actor.getSnapshot().context.rosters.home;
    expect(gunShotsOf(roster, pitcher)).toBe(GUN_SHOTS_PER_PITCHER);
    expect(gunRemainingOf(roster, pitcher)).toBe(0);
  });

  it('継投すると残弾は引き継がれない（銃は投手個人に付く）', () => {
    const actor = startGame();
    endHalf(actor);
    const starter = actor.getSnapshot().context.rosters.home.pitcher;
    grantViaDraft(actor, 'home', starter, 'ju');
    endHalf(actor);

    actor.send({ type: 'GUN_USED' });
    actor.send({ type: 'SUBSTITUTE_PITCHER', side: 'home', bullpenIndex: 0 });
    const roster = actor.getSnapshot().context.rosters.home;
    expect(roster.pitcher).not.toBe(starter);
    // 降りた投手の記録は残るが、マウンドの新しい投手はスキルを持たないので撃てない
    expect(gunRemainingOf(roster, starter)).toBe(GUN_SHOTS_PER_PITCHER - 1);
    expect(gunRemainingOf(roster, roster.pitcher)).toBe(0);
    actor.send({ type: 'GUN_USED' });
    expect(gunShotsOf(actor.getSnapshot().context.rosters.home, roster.pitcher)).toBe(0);
  });
});

describe('gameMachine: 打順の進行', () => {
  it('三振で打者側チームの打順が1つ進む', () => {
    const actor = startGame();
    for (let i = 0; i < 3; i++) actor.send({ type: 'PITCH_RESULT', judgement: 'strike' });
    expect(actor.getSnapshot().context.rosters.away.lineupIndex).toBe(1);
  });

  it('四球で打者側チームの打順が1つ進む', () => {
    const actor = startGame();
    for (let i = 0; i < 4; i++) actor.send({ type: 'PITCH_RESULT', judgement: 'ball' });
    expect(actor.getSnapshot().context.rosters.away.lineupIndex).toBe(1);
  });

  it('打球の決着（PLAY_RESOLVED）でも打順が進む', () => {
    const actor = startGame();
    actor.send({ type: 'PLAY_RESOLVED', outsAdded: 1, runs: 0, bases: EMPTY_BASES });
    expect(actor.getSnapshot().context.rosters.away.lineupIndex).toBe(1);
  });

  it('ファウル（据え置き）では打順は進まない', () => {
    const actor = startGame();
    actor.send({ type: 'PITCH_RESULT', judgement: 'foul' });
    expect(actor.getSnapshot().context.rosters.away.lineupIndex).toBe(0);
  });

  it('死球で打順が進み、乱闘を選ばなければそのまま確定する', () => {
    const actor = startGame();
    actor.send({ type: 'HIT_BY_PITCH' });
    expect(actor.getSnapshot().context.rosters.away.lineupIndex).toBe(1);
  });

  it('9番の次の打者は1番に戻る（一巡）', () => {
    const actor = startGame();
    for (let i = 0; i < 9; i++) {
      actor.send({ type: 'PLAY_RESOLVED', outsAdded: 0, runs: 0, bases: EMPTY_BASES });
    }
    expect(actor.getSnapshot().context.rosters.away.lineupIndex).toBe(0);
  });
});

describe('gameMachine: スコアボード（イニング別得点）', () => {
  it('無得点の打席決着でも現在のイニングのマスが0で確定する', () => {
    const actor = startGame();
    for (let i = 0; i < 3; i++) actor.send({ type: 'PITCH_RESULT', judgement: 'strike' });
    expect(actor.getSnapshot().context.lineScore.away).toEqual([0]);
    expect(actor.getSnapshot().context.lineScore.home).toEqual([]); // 裏はまだ未到達
  });

  it('得点した打席は該当イニングに加算される', () => {
    const actor = startGame();
    actor.send({ type: 'PLAY_RESOLVED', outsAdded: 0, runs: 2, bases: EMPTY_BASES });
    expect(actor.getSnapshot().context.lineScore.away).toEqual([2]);
  });

  it('表裏で同じイニング番号に記録される', () => {
    const actor = startGame();
    actor.send({ type: 'PLAY_RESOLVED', outsAdded: 0, runs: 1, bases: EMPTY_BASES });
    endHalf(actor); // 1回裏へ
    actor.send({ type: 'PLAY_RESOLVED', outsAdded: 0, runs: 3, bases: EMPTY_BASES });
    const ls = actor.getSnapshot().context.lineScore;
    expect(ls.away).toEqual([1]);
    expect(ls.home).toEqual([3]);
  });

  it('死球（乱闘なし）でも得点があればそのイニングに記録される', () => {
    const actor = startGame();
    actor.send({ type: 'HIT_BY_PITCH' });
    actor.send({ type: 'HIT_BY_PITCH' });
    actor.send({ type: 'HIT_BY_PITCH' });
    actor.send({ type: 'HIT_BY_PITCH' }); // 満塁から押し出しで1点
    expect(actor.getSnapshot().context.lineScore.away).toEqual([1]);
  });
});

describe('gameMachine: 乱闘決着（打順・ロスターとの連動）', () => {
  it('打者敗北: 死球の進塁・カウント・打順を巻き戻し、負けた打者を控えと交代する', () => {
    const actor = startGame();
    actor.send({ type: 'PITCH_RESULT', judgement: 'ball' });
    actor.send({ type: 'PITCH_RESULT', judgement: 'strike' });
    const preHbp = actor.getSnapshot().context; // count: 1B-1S, bases: 空, away打順0番
    const outgoingBatter = currentBatterId(preHbp.rosters.away);
    actor.send({ type: 'HIT_BY_PITCH' }); // 打者一塁・カウントリセット・打順1番へ（乱闘前の一時的な状態）
    expect(actor.getSnapshot().context.bases.first).toBe(true);
    expect(actor.getSnapshot().context.rosters.away.lineupIndex).toBe(1);

    actor.send({
      type: 'BRAWL_RESOLVED',
      loser: 'batter',
      restore: {
        count: preHbp.count,
        bases: preHbp.bases,
        battingLineupIndex: preHbp.rosters.away.lineupIndex,
      },
    });
    const ctx = actor.getSnapshot().context;
    expect(ctx.count).toEqual({ balls: 1, strikes: 1 });
    expect(ctx.bases).toEqual({ first: false, second: false, third: false });
    // 打順スロットは「同じ打席」を指す0番のまま（進行は巻き戻るが、中身の選手は代打に交代）
    expect(ctx.rosters.away.lineupIndex).toBe(0);
    expect(currentBatterId(ctx.rosters.away)).not.toBe(outgoingBatter);
    expect(ctx.rosters.away.ejected).toEqual([outgoingBatter]);
    expect(ctx.rosters.away.bench).toHaveLength(2);
  });

  it('投手敗北: 同様に巻き戻され、守備側（投手側）の投手を救援投手と交代する', () => {
    const actor = startGame();
    const preHbp = actor.getSnapshot().context;
    const outgoingPitcher = preHbp.rosters.home.pitcher;
    actor.send({ type: 'HIT_BY_PITCH' });
    actor.send({
      type: 'BRAWL_RESOLVED',
      loser: 'pitcher',
      restore: { count: preHbp.count, bases: preHbp.bases, battingLineupIndex: 0 },
    });
    const ctx = actor.getSnapshot().context;
    expect(ctx.bases).toEqual({ first: false, second: false, third: false });
    expect(ctx.rosters.home.pitcher).not.toBe(outgoingPitcher);
    expect(ctx.rosters.home.ejected).toEqual([outgoingPitcher]);
    expect(ctx.rosters.home.bullpen).toHaveLength(BULLPEN_SIZE - 1);
  });

  it('ブルペンは複数回の乱闘で積み上がって減っていく', () => {
    const actor = startGame();
    actor.send({ type: 'HIT_BY_PITCH' });
    actor.send({
      type: 'BRAWL_RESOLVED',
      loser: 'pitcher',
      restore: { count: EMPTY_COUNT, bases: EMPTY_BASES, battingLineupIndex: 0 },
    });
    actor.send({ type: 'HIT_BY_PITCH' });
    actor.send({
      type: 'BRAWL_RESOLVED',
      loser: 'pitcher',
      restore: { count: EMPTY_COUNT, bases: EMPTY_BASES, battingLineupIndex: 0 },
    });
    expect(actor.getSnapshot().context.rosters.home.ejected).toHaveLength(2);
    expect(actor.getSnapshot().context.rosters.home.bullpen).toHaveLength(BULLPEN_SIZE - 2);
  });

  it('代打が尽きると没収試合になる（相手チームの勝ち）', () => {
    const actor = startGame();
    for (let i = 0; i < 4; i++) {
      const preHbp = actor.getSnapshot().context;
      const lineupIndex = preHbp.rosters.away.lineupIndex;
      actor.send({ type: 'HIT_BY_PITCH' });
      actor.send({
        type: 'BRAWL_RESOLVED',
        loser: 'batter',
        restore: { count: preHbp.count, bases: preHbp.bases, battingLineupIndex: lineupIndex },
      });
    }
    const snapshot = actor.getSnapshot();
    expect(snapshot.matches('gameOver')).toBe(true);
    expect(snapshot.context.winner).toBe('home');
    expect(snapshot.context.rosters.away.bench).toHaveLength(0);
  });

  it('救援投手が尽きると没収試合になる（相手チームの勝ち）', () => {
    const actor = startGame();
    for (let i = 0; i < BULLPEN_SIZE + 1; i++) {
      actor.send({ type: 'HIT_BY_PITCH' });
      actor.send({
        type: 'BRAWL_RESOLVED',
        loser: 'pitcher',
        restore: { count: EMPTY_COUNT, bases: EMPTY_BASES, battingLineupIndex: 0 },
      });
    }
    const snapshot = actor.getSnapshot();
    expect(snapshot.matches('gameOver')).toBe(true);
    expect(snapshot.context.winner).toBe('away');
  });
});

describe('gameMachine: 采配としての任意代打・継投', () => {
  it('SUBSTITUTE_BATTER: 指定した控えが同じ打順スロットに入り、カウント・走者状況は変わらない', () => {
    const actor = startGame();
    actor.send({ type: 'PITCH_RESULT', judgement: 'ball' });
    actor.send({ type: 'PITCH_RESULT', judgement: 'strike' });
    const before = actor.getSnapshot().context;
    const outgoing = currentBatterId(before.rosters.away);
    actor.send({ type: 'SUBSTITUTE_BATTER', side: 'away', benchIndex: 1 });
    const ctx = actor.getSnapshot().context;
    // 乱闘の強制退場（BRAWL_RESOLVED）と違い、カウント・打順インデックスは一切動かない
    expect(ctx.count).toEqual(before.count);
    expect(ctx.rosters.away.lineupIndex).toBe(before.rosters.away.lineupIndex);
    expect(currentBatterId(ctx.rosters.away)).toBe(before.rosters.away.bench[1]);
    expect(currentBatterId(ctx.rosters.away)).not.toBe(outgoing);
    expect(ctx.rosters.away.ejected).toEqual([outgoing]);
    expect(ctx.rosters.away.bench).toHaveLength(2);
    // 相手側（home）のロスターは無関係のまま
    expect(ctx.rosters.home).toEqual(before.rosters.home);
  });

  it('SUBSTITUTE_PITCHER: 指定した救援投手に交代し、カウント・走者状況は変わらない', () => {
    const actor = startGame();
    actor.send({ type: 'PITCH_RESULT', judgement: 'ball' });
    const before = actor.getSnapshot().context;
    const outgoing = before.rosters.home.pitcher;
    actor.send({ type: 'SUBSTITUTE_PITCHER', side: 'home', bullpenIndex: 2 });
    const ctx = actor.getSnapshot().context;
    expect(ctx.count).toEqual(before.count);
    expect(ctx.rosters.home.pitcher).toBe(before.rosters.home.bullpen[2]);
    expect(ctx.rosters.home.pitcher).not.toBe(outgoing);
    expect(ctx.rosters.home.ejected).toEqual([outgoing]);
    expect(ctx.rosters.home.bullpen).toHaveLength(BULLPEN_SIZE - 1);
  });

  it('控え/ブルペンが尽きた状態で送っても何も起きない（没収試合にはならない防御的ガード）', () => {
    const actor = startGame();
    for (let i = 0; i < 3; i++) {
      actor.send({ type: 'SUBSTITUTE_BATTER', side: 'away', benchIndex: 0 });
    }
    expect(actor.getSnapshot().context.rosters.away.bench).toHaveLength(0);
    const before = actor.getSnapshot().context;
    actor.send({ type: 'SUBSTITUTE_BATTER', side: 'away', benchIndex: 0 });
    const ctx = actor.getSnapshot().context;
    expect(ctx.rosters.away).toEqual(before.rosters.away);
    expect(ctx.winner).toBeNull();
  });
});

describe('gameMachine: 試合の決着', () => {
  it('9回裏終了までスコア差があれば決着する', () => {
    const actor = startGame();
    // 1回表にビジターが1点、その後は両者無得点で9回裏まで進める
    actor.send({ type: 'PLAY_RESOLVED', outsAdded: 0, runs: 1, bases: EMPTY_BASES });
    for (let i = 0; i < 18; i++) {
      endHalf(actor);
    }
    const snapshot = actor.getSnapshot();
    expect(snapshot.matches('gameOver')).toBe(true);
    expect(snapshot.context.winner).toBe('away');
    expect(snapshot.status).toBe('done');
  });

  it('9回表終了時にホームリードなら裏を行わず決着', () => {
    const actor = startGame();
    endHalf(actor); // 1回表
    actor.send({ type: 'PLAY_RESOLVED', outsAdded: 0, runs: 1, bases: EMPTY_BASES });
    for (let i = 0; i < 16; i++) {
      endHalf(actor); // 1回裏〜9回表
    }
    const snapshot = actor.getSnapshot();
    expect(snapshot.matches('gameOver')).toBe(true);
    expect(snapshot.context.winner).toBe('home');
  });

  it('9回裏にホームが勝ち越したらサヨナラで即決着', () => {
    const actor = startGame();
    for (let i = 0; i < 17; i++) {
      endHalf(actor); // 9回裏の頭まで両者無得点
    }
    expect(actor.getSnapshot().context.inning).toBe(9);
    expect(actor.getSnapshot().context.half).toBe('bottom');
    actor.send({ type: 'PLAY_RESOLVED', outsAdded: 0, runs: 1, bases: EMPTY_BASES });
    const snapshot = actor.getSnapshot();
    expect(snapshot.matches('gameOver')).toBe(true);
    expect(snapshot.context.winner).toBe('home');
  });

  it('9回で同点なら延長へ（無制限）', () => {
    const actor = startGame();
    for (let i = 0; i < 18; i++) {
      endHalf(actor);
    }
    const ctx = actor.getSnapshot().context;
    expect(ctx.inning).toBe(10);
    expect(ctx.half).toBe('top');
    expect(actor.getSnapshot().matches('playing')).toBe(true);
  });

  it('サヨナラ押し出し四球でも決着する', () => {
    const actor = startGame();
    for (let i = 0; i < 17; i++) {
      endHalf(actor);
    }
    // 9回裏に満塁を作って押し出し
    actor.send({ type: 'HIT_BY_PITCH' });
    actor.send({ type: 'HIT_BY_PITCH' });
    actor.send({ type: 'HIT_BY_PITCH' });
    for (let i = 0; i < 4; i++) {
      actor.send({ type: 'PITCH_RESULT', judgement: 'ball' });
    }
    const snapshot = actor.getSnapshot();
    expect(snapshot.matches('gameOver')).toBe(true);
    expect(snapshot.context.winner).toBe('home');
  });

  it('没収試合: FORFEIT で相手チームの勝ち', () => {
    const actor = startGame();
    actor.send({ type: 'FORFEIT', loser: 'home' });
    const snapshot = actor.getSnapshot();
    expect(snapshot.matches('gameOver')).toBe(true);
    expect(snapshot.context.winner).toBe('away');
  });

  it('決着後はイベントを受け付けない', () => {
    const actor = startGame();
    actor.send({ type: 'FORFEIT', loser: 'home' });
    actor.send({ type: 'PITCH_RESULT', judgement: 'ball' });
    expect(actor.getSnapshot().context.count.balls).toBe(0);
  });
});

describe('gameMachine: けん制球の決着（RUNNER_PLAY_RESOLVED）', () => {
  /** 一塁に走者を置き、カウントを1B-1Sにした状態を作る */
  function withRunnerOnFirst() {
    const actor = startGame();
    actor.send({ type: 'PLAY_RESOLVED', outsAdded: 0, runs: 0, bases: { first: true, second: false, third: false } });
    actor.send({ type: 'PITCH_RESULT', judgement: 'ball' });
    actor.send({ type: 'PITCH_RESULT', judgement: 'strike' });
    return actor;
  }

  it('けん制でアウトを取ってもカウントと打順は据え置き（打席が続く）', () => {
    const actor = withRunnerOnFirst();
    const before = actor.getSnapshot().context;
    expect(before.count).toEqual({ balls: 1, strikes: 1 });

    actor.send({ type: 'RUNNER_PLAY_RESOLVED', outsAdded: 1, runs: 0, bases: EMPTY_BASES });

    const ctx = actor.getSnapshot().context;
    expect(ctx.outs).toBe(1);
    expect(ctx.bases).toEqual(EMPTY_BASES);
    // 打席は終わっていないので、カウントも打順もそのまま
    expect(ctx.count).toEqual({ balls: 1, strikes: 1 });
    expect(ctx.rosters.away.lineupIndex).toBe(before.rosters.away.lineupIndex);
    expect(currentBatterId(ctx.rosters.away)).toBe(currentBatterId(before.rosters.away));
  });

  it('セーフ（アウトなし）なら塁状況だけが反映され、何も進まない', () => {
    const actor = withRunnerOnFirst();
    const before = actor.getSnapshot().context;
    actor.send({
      type: 'RUNNER_PLAY_RESOLVED',
      outsAdded: 0,
      runs: 0,
      bases: { first: true, second: false, third: false },
    });
    const ctx = actor.getSnapshot().context;
    expect(ctx.outs).toBe(before.outs);
    expect(ctx.count).toEqual(before.count);
    expect(ctx.bases).toEqual({ first: true, second: false, third: false });
  });

  it('けん制の間に生還した得点はスコアとスコアボードに入る', () => {
    const actor = withRunnerOnFirst();
    actor.send({ type: 'RUNNER_PLAY_RESOLVED', outsAdded: 0, runs: 1, bases: EMPTY_BASES });
    const ctx = actor.getSnapshot().context;
    expect(ctx.score.away).toBe(1);
    expect(ctx.lineScore.away[0]).toBe(1);
  });

  it('けん制アウトが3アウト目なら攻守交代する（カウント・塁はリセット）', () => {
    const actor = withRunnerOnFirst();
    actor.send({ type: 'PLAY_RESOLVED', outsAdded: 2, runs: 0, bases: { first: true, second: false, third: false } });
    expect(actor.getSnapshot().context.outs).toBe(2);

    actor.send({ type: 'RUNNER_PLAY_RESOLVED', outsAdded: 1, runs: 0, bases: EMPTY_BASES });

    const ctx = actor.getSnapshot().context;
    expect(ctx.half).toBe('bottom');
    expect(ctx.outs).toBe(0);
    expect(ctx.count).toEqual(EMPTY_COUNT);
    expect(ctx.bases).toEqual(EMPTY_BASES);
  });

  it('打席の途中でイニングが終わっても打順は進まない（次の回は同じ打者から）', () => {
    const actor = withRunnerOnFirst();
    actor.send({ type: 'PLAY_RESOLVED', outsAdded: 2, runs: 0, bases: { first: true, second: false, third: false } });
    const before = actor.getSnapshot().context.rosters.away.lineupIndex;
    actor.send({ type: 'RUNNER_PLAY_RESOLVED', outsAdded: 1, runs: 0, bases: EMPTY_BASES });
    expect(actor.getSnapshot().context.rosters.away.lineupIndex).toBe(before);
  });
});

describe('gameMachine: 走者の識別（フェーズB-8）', () => {
  it('四球で出塁した打者が、その後も一塁走者として保持される', () => {
    const actor = startGame();
    const leadoff = currentBatterId(actor.getSnapshot().context.rosters.away);
    for (let i = 0; i < 4; i++) actor.send({ type: 'PITCH_RESULT', judgement: 'ball' });
    const ctx = actor.getSnapshot().context;
    expect(ctx.baseRunners.first).toBe(leadoff);
    // 打順は次の打者へ進んでいる＝一塁にいるのは「さっきの打者」で、今の打者ではない
    expect(currentBatterId(ctx.rosters.away)).not.toBe(leadoff);
  });

  it('連続四球で走者が押し出されても、誰がどの塁かが入れ替わらない', () => {
    const actor = startGame();
    const first = currentBatterId(actor.getSnapshot().context.rosters.away);
    for (let i = 0; i < 4; i++) actor.send({ type: 'PITCH_RESULT', judgement: 'ball' });
    const second = currentBatterId(actor.getSnapshot().context.rosters.away);
    for (let i = 0; i < 4; i++) actor.send({ type: 'PITCH_RESULT', judgement: 'ball' });

    const ctx = actor.getSnapshot().context;
    expect(ctx.baseRunners).toEqual({ first: second, second: first, third: null });
  });

  it('bases は baseRunners から導出される（占有状況と識別が食い違わない）', () => {
    const actor = startGame();
    const expectConsistent = () => {
      const { bases, baseRunners } = actor.getSnapshot().context;
      expect(bases).toEqual({
        first: baseRunners.first !== null,
        second: baseRunners.second !== null,
        third: baseRunners.third !== null,
      });
    };
    expectConsistent();
    actor.send({ type: 'HIT_BY_PITCH' });
    expectConsistent();
    actor.send({ type: 'PLAY_RESOLVED', outsAdded: 0, runs: 0, bases: EMPTY_BASES });
    expectConsistent();
    actor.send({
      type: 'RUNNER_PLAY_RESOLVED',
      outsAdded: 0,
      runs: 0,
      bases: { first: true, second: false, third: false },
      baseRunners: { first: 'RUNNER-X', second: null, third: null },
    });
    expectConsistent();
    expect(actor.getSnapshot().context.baseRunners.first).toBe('RUNNER-X');
  });

  it('攻守交代で走者はクリアされる', () => {
    const actor = startGame();
    actor.send({ type: 'HIT_BY_PITCH' });
    expect(actor.getSnapshot().context.baseRunners.first).not.toBeNull();
    endHalf(actor);
    expect(actor.getSnapshot().context.baseRunners).toEqual({
      first: null,
      second: null,
      third: null,
    });
  });

  it('識別を渡さないイベントでも占有状況は正しく反映される（後方互換）', () => {
    const actor = startGame();
    actor.send({
      type: 'PLAY_RESOLVED',
      outsAdded: 0,
      runs: 0,
      bases: { first: true, second: false, third: true },
    });
    const ctx = actor.getSnapshot().context;
    expect(ctx.bases).toEqual({ first: true, second: false, third: true });
    expect(ctx.baseRunners.first).not.toBeNull();
    expect(ctx.baseRunners.second).toBeNull();
    expect(ctx.baseRunners.third).not.toBeNull();
  });

  it('乱闘の巻き戻しでは塁上の走者も元の顔ぶれに戻る', () => {
    const actor = startGame();
    // 一塁に走者を置く（四球）
    for (let i = 0; i < 4; i++) actor.send({ type: 'PITCH_RESULT', judgement: 'ball' });
    const preHbp = actor.getSnapshot().context;
    const runnerOnFirst = preHbp.baseRunners.first;
    expect(runnerOnFirst).not.toBeNull();

    actor.send({ type: 'HIT_BY_PITCH' }); // 死球で押し出し進塁が一度適用される
    expect(actor.getSnapshot().context.baseRunners.second).toBe(runnerOnFirst);

    actor.send({
      type: 'BRAWL_RESOLVED',
      loser: 'batter',
      restore: {
        count: preHbp.count,
        bases: preHbp.bases,
        baseRunners: preHbp.baseRunners,
        battingLineupIndex: preHbp.rosters.away.lineupIndex,
      },
    });
    const ctx = actor.getSnapshot().context;
    expect(ctx.baseRunners).toEqual(preHbp.baseRunners);
    expect(ctx.baseRunners.first).toBe(runnerOnFirst);
  });
});

describe('gameMachine: 投球数とスタミナ（フェーズB-11）', () => {
  it('PITCH_THROWN で守備側の投手の投球数だけが増える', () => {
    const actor = startGame();
    const before = actor.getSnapshot().context.rosters;
    const homePitcher = before.home.pitcher;
    const awayPitcher = before.away.pitcher;
    for (let i = 0; i < 5; i++) actor.send({ type: 'PITCH_THROWN' });
    const after = actor.getSnapshot().context.rosters;
    // 1回表は home が守備＝home の投手が投げている
    expect(pitchCountOf(after.home, homePitcher)).toBe(5);
    expect(pitchCountOf(after.away, awayPitcher)).toBe(0);
  });

  it('攻守交代で投球数の付け先が入れ替わる', () => {
    const actor = startGame();
    actor.send({ type: 'PITCH_THROWN' });
    endHalf(actor);
    for (let i = 0; i < 3; i++) actor.send({ type: 'PITCH_THROWN' });
    const { rosters, half } = actor.getSnapshot().context;
    expect(half).toBe('bottom'); // 1回裏＝away が守備
    expect(pitchCountOf(rosters.home, rosters.home.pitcher)).toBe(1);
    expect(pitchCountOf(rosters.away, rosters.away.pitcher)).toBe(3);
  });

  it('投球数以外（カウント・アウト・塁）は PITCH_THROWN で動かない', () => {
    const actor = startGame();
    actor.send({ type: 'PITCH_RESULT', judgement: 'strike' });
    const before = actor.getSnapshot().context;
    actor.send({ type: 'PITCH_THROWN' });
    const after = actor.getSnapshot().context;
    expect(after.count).toEqual(before.count);
    expect(after.outs).toBe(before.outs);
    expect(after.bases).toEqual(before.bases);
    expect(after.rosters.away.lineupIndex).toBe(before.rosters.away.lineupIndex);
  });

  /**
   * 継投の意味そのもの：疲れた投手を替えれば球威が戻る。ここが繋がっていないと
   * スタミナは「表示されるだけの数値」になる。
   */
  it('疲れた投手を継投で替えると疲労が0に戻る', () => {
    const actor = startGame();
    const homePitcher = actor.getSnapshot().context.rosters.home.pitcher;
    const stamina =
      actor.getSnapshot().context.rosters.home.players[homePitcher].pitching!.stamina;
    for (let i = 0; i < maxPitchesFor(stamina); i++) actor.send({ type: 'PITCH_THROWN' });
    const tired = actor.getSnapshot().context.rosters.home;
    expect(fatigueOf(tired, tired.pitcher)).toBe(1);

    actor.send({ type: 'SUBSTITUTE_PITCHER', side: 'home', bullpenIndex: 0 });
    const fresh = actor.getSnapshot().context.rosters.home;
    expect(fresh.pitcher).not.toBe(homePitcher);
    expect(fatigueOf(fresh, fresh.pitcher)).toBe(0);
  });

  it('死球→乱闘の巻き戻しでも投球数は戻らない（投げた事実は消えない）', () => {
    const actor = startGame();
    for (let i = 0; i < 4; i++) actor.send({ type: 'PITCH_THROWN' });
    const before = actor.getSnapshot().context;
    const pitcher = before.rosters.home.pitcher;
    actor.send({ type: 'HIT_BY_PITCH' });
    actor.send({
      type: 'BRAWL_RESOLVED',
      loser: 'batter',
      restore: {
        count: before.count,
        bases: before.bases,
        battingLineupIndex: before.rosters.away.lineupIndex,
      },
    });
    expect(pitchCountOf(actor.getSnapshot().context.rosters.home, pitcher)).toBe(4);
  });
});

describe('MATCH_SETUP: 試合前のチーム選択と采配（フェーズC-13/C-15）', () => {
  it('選んだ球団でロスターを組み直す', () => {
    const actor = startGame();
    actor.send({ type: 'MATCH_SETUP', away: 'winds', home: 'galaxies' });
    const ctx = actor.getSnapshot().context;
    expect(ctx.rosters.away.team.id).toBe('winds');
    expect(ctx.rosters.home.team.id).toBe('galaxies');
  });

  it('采配（先発投手・打順）は指定した側にだけ効き、もう一方は名鑑どおり', () => {
    const actor = startGame();
    const order = [...DEFAULT_ROSTER_PLAN.order];
    // 投手を1番に、3番の野手を9番に（打順を明確に組み替える）
    const swapped = swapBattingOrder(swapBattingOrder(order, 0, PITCHER_ORDER_SLOT), 2, 4);
    actor.send({
      type: 'MATCH_SETUP',
      away: 'winds',
      home: 'galaxies',
      plans: { home: { starterIndex: 2, order: swapped } },
    });
    const { away, home } = actor.getSnapshot().context.rosters;
    // 采配を渡した側：3人目の投手が先発で、打順1番に入っている
    expect(home.players[home.pitcher].name).toBe(teamById('galaxies').pitchers[2][0]);
    expect(home.pitcherSlot).toBe(0);
    expect(home.lineup[0]).toBe(home.pitcher);
    expect(home.bullpen).toHaveLength(BULLPEN_SIZE);
    // 渡していない側：名鑑どおり（先頭の投手が先発・9番が投手）
    expect(away.players[away.pitcher].name).toBe(teamById('winds').pitchers[0][0]);
    expect(away.pitcherSlot).toBe(PITCHER_ORDER_SLOT);
  });

  it('試合が始まってからは効かない（積み上がった記録を壊さない）', () => {
    const actor = startGame();
    actor.send({ type: 'MATCH_SETUP', away: 'winds', home: 'galaxies' });
    actor.send({ type: 'PITCH_RESULT', judgement: 'strike' });
    actor.send({
      type: 'MATCH_SETUP',
      away: 'irons',
      home: 'moons',
      plans: { home: { starterIndex: 3, order: [...DEFAULT_ROSTER_PLAN.order] } },
    });
    const ctx = actor.getSnapshot().context;
    expect(ctx.rosters.away.team.id).toBe('winds');
    expect(ctx.rosters.home.team.id).toBe('galaxies');
    expect(ctx.count.strikes).toBe(1);
  });
});
