import { describe, expect, it } from 'vitest';
import {
  type Bases,
  EMPTY_BASES,
  EMPTY_BASE_RUNNERS,
  EMPTY_COUNT,
  EMPTY_LINE_SCORE,
  advanceOnHit,
  advanceOnHitRunners,
  applyPitch,
  battingTeam,
  evaluateProgress,
  fieldingTeam,
  forceAdvance,
  forceAdvanceRunners,
  occupancy,
  opponent,
  recordInningRuns,
  runnersFromBases,
} from '../src/core/rules';

describe('applyPitch', () => {
  it('ボールでカウントが増える', () => {
    expect(applyPitch({ balls: 1, strikes: 2 }, 'ball')).toEqual({
      kind: 'inProgress',
      count: { balls: 2, strikes: 2 },
    });
  });

  it('4ボール目で四球', () => {
    expect(applyPitch({ balls: 3, strikes: 2 }, 'ball')).toEqual({ kind: 'walk' });
  });

  it('ストライクでカウントが増える', () => {
    expect(applyPitch(EMPTY_COUNT, 'strike')).toEqual({
      kind: 'inProgress',
      count: { balls: 0, strikes: 1 },
    });
  });

  it('3ストライク目で三振', () => {
    expect(applyPitch({ balls: 0, strikes: 2 }, 'strike')).toEqual({
      kind: 'strikeout',
    });
  });

  it('ファウルでストライクが増える', () => {
    expect(applyPitch({ balls: 1, strikes: 0 }, 'foul')).toEqual({
      kind: 'inProgress',
      count: { balls: 1, strikes: 1 },
    });
  });

  it('2ストライクからのファウルは3ストライク目にならない', () => {
    expect(applyPitch({ balls: 0, strikes: 2 }, 'foul')).toEqual({
      kind: 'inProgress',
      count: { balls: 0, strikes: 2 },
    });
  });
});

/**
 * バントのファウル（フェーズAA-48。説明書p32「実際の野球のルールにできるだけ
 * 合わせてある」）。**ファウルの頭打ちを適用しない**＝実際の野球と同じく
 * 「バントのファウルはストライクとして数える」1つの規則。
 */
describe('applyPitch：バントのファウル（AA-48）', () => {
  it('2ストライクからのバントファウルは三振', () => {
    expect(applyPitch({ balls: 0, strikes: 2 }, 'buntFoul')).toEqual({ kind: 'strikeout' });
  });

  it('ボールが先行していても三振（カウントの他の中身は関係ない）', () => {
    expect(applyPitch({ balls: 3, strikes: 2 }, 'buntFoul')).toEqual({ kind: 'strikeout' });
  });

  it('2ストライク未満ではストライクとまったく同じ（＝三振だけの特別扱いを持たない）', () => {
    for (const count of [
      { balls: 0, strikes: 0 },
      { balls: 2, strikes: 1 },
      { balls: 3, strikes: 1 },
    ]) {
      expect(applyPitch(count, 'buntFoul')).toEqual(applyPitch(count, 'strike'));
    }
  });

  it('通常のファウルは従来どおり頭打ちのまま（AA-48はバントにしか効かない）', () => {
    expect(applyPitch({ balls: 0, strikes: 2 }, 'foul')).toEqual({
      kind: 'inProgress',
      count: { balls: 0, strikes: 2 },
    });
  });
});

describe('forceAdvance（四球・死球）', () => {
  it('走者なし: 打者が一塁へ', () => {
    expect(forceAdvance(EMPTY_BASES)).toEqual({
      bases: { first: true, second: false, third: false },
      runs: 0,
    });
  });

  it('一塁走者のみ: 一・二塁になる', () => {
    expect(forceAdvance({ first: true, second: false, third: false })).toEqual({
      bases: { first: true, second: true, third: false },
      runs: 0,
    });
  });

  it('二塁走者のみ: フォースされず一・二塁のまま', () => {
    expect(forceAdvance({ first: false, second: true, third: false })).toEqual({
      bases: { first: true, second: true, third: false },
      runs: 0,
    });
  });

  it('三塁走者のみ: フォースされず一・三塁', () => {
    expect(forceAdvance({ first: false, second: false, third: true })).toEqual({
      bases: { first: true, second: false, third: true },
      runs: 0,
    });
  });

  it('一・二塁: 満塁になる', () => {
    expect(forceAdvance({ first: true, second: true, third: false })).toEqual({
      bases: { first: true, second: true, third: true },
      runs: 0,
    });
  });

  it('満塁: 押し出しで1点', () => {
    expect(forceAdvance({ first: true, second: true, third: true })).toEqual({
      bases: { first: true, second: true, third: true },
      runs: 1,
    });
  });
});

describe('advanceOnHit（簡易進塁モデル）', () => {
  it('単打: 打者一塁、三塁走者が生還', () => {
    expect(advanceOnHit({ first: false, second: false, third: true }, 'single')).toEqual({
      bases: { first: true, second: false, third: false },
      runs: 1,
    });
  });

  it('二塁打: 一塁走者は三塁へ', () => {
    expect(advanceOnHit({ first: true, second: false, third: false }, 'double')).toEqual({
      bases: { first: false, second: true, third: true },
      runs: 0,
    });
  });

  it('三塁打: 全走者生還・打者三塁', () => {
    expect(advanceOnHit({ first: true, second: true, third: false }, 'triple')).toEqual({
      bases: { first: false, second: false, third: true },
      runs: 2,
    });
  });

  it('満塁本塁打: 4点', () => {
    expect(advanceOnHit({ first: true, second: true, third: true }, 'homerun')).toEqual({
      bases: EMPTY_BASES,
      runs: 4,
    });
  });
});

describe('evaluateProgress（試合進行）', () => {
  it('2アウト以下は続行', () => {
    expect(evaluateProgress(1, 'top', 2, { away: 0, home: 0 })).toEqual({
      kind: 'continue',
    });
  });

  it('3アウトで表→裏', () => {
    expect(evaluateProgress(1, 'top', 3, { away: 0, home: 0 })).toEqual({
      kind: 'nextHalf',
      inning: 1,
      half: 'bottom',
    });
  });

  it('3アウトで裏→次の回の表', () => {
    expect(evaluateProgress(3, 'bottom', 3, { away: 2, home: 1 })).toEqual({
      kind: 'nextHalf',
      inning: 4,
      half: 'top',
    });
  });

  it('9回表終了時にホームリードなら裏を行わず決着', () => {
    expect(evaluateProgress(9, 'top', 3, { away: 1, home: 2 })).toEqual({
      kind: 'gameOver',
      winner: 'home',
    });
  });

  it('9回表終了時に同点なら裏へ', () => {
    expect(evaluateProgress(9, 'top', 3, { away: 2, home: 2 })).toEqual({
      kind: 'nextHalf',
      inning: 9,
      half: 'bottom',
    });
  });

  it('9回裏にホームが勝ち越したらサヨナラ（アウト数を問わない）', () => {
    expect(evaluateProgress(9, 'bottom', 1, { away: 2, home: 3 })).toEqual({
      kind: 'gameOver',
      winner: 'home',
    });
  });

  it('9回裏終了時に同点なら延長へ', () => {
    expect(evaluateProgress(9, 'bottom', 3, { away: 2, home: 2 })).toEqual({
      kind: 'nextHalf',
      inning: 10,
      half: 'top',
    });
  });

  it('9回裏終了時にビジターリードならビジターの勝ち', () => {
    expect(evaluateProgress(9, 'bottom', 3, { away: 3, home: 2 })).toEqual({
      kind: 'gameOver',
      winner: 'away',
    });
  });

  it('延長12回裏のサヨナラも決着する', () => {
    expect(evaluateProgress(12, 'bottom', 0, { away: 4, home: 5 })).toEqual({
      kind: 'gameOver',
      winner: 'home',
    });
  });

  it('8回まではホームがリードしていても続行', () => {
    expect(evaluateProgress(8, 'bottom', 0, { away: 0, home: 5 })).toEqual({
      kind: 'continue',
    });
  });
});

describe('recordInningRuns（スコアボード）', () => {
  it('初回の記録で0点でもそのイニングのマスが確定する（未到達との区別）', () => {
    const ls = recordInningRuns(EMPTY_LINE_SCORE, 'away', 1, 0);
    expect(ls.away).toEqual([0]);
    expect(ls.home).toEqual([]); // 裏はまだ未到達のまま
  });

  it('同じイニング内の複数回の得点は加算される', () => {
    let ls = recordInningRuns(EMPTY_LINE_SCORE, 'away', 1, 2);
    ls = recordInningRuns(ls, 'away', 1, 1);
    expect(ls.away).toEqual([3]);
  });

  it('表裏は同じイニング番号で同じ添字に記録される', () => {
    let ls = recordInningRuns(EMPTY_LINE_SCORE, 'away', 3, 1);
    ls = recordInningRuns(ls, 'home', 3, 2);
    expect(ls.away[2]).toBe(1);
    expect(ls.home[2]).toBe(2);
  });

  it('イニングを飛ばして記録された場合は間を0で埋める', () => {
    const ls = recordInningRuns(EMPTY_LINE_SCORE, 'away', 3, 1);
    expect(ls.away).toEqual([0, 0, 1]);
  });

  it('元のオブジェクトを変更しない（純粋関数）', () => {
    const before = EMPTY_LINE_SCORE;
    recordInningRuns(before, 'away', 1, 5);
    expect(before).toEqual({ away: [], home: [] });
  });
});

describe('走者の識別（BaseRunners・フェーズB-8）', () => {
  const ALL_BASE_STATES: Bases[] = [
    { first: false, second: false, third: false },
    { first: true, second: false, third: false },
    { first: false, second: true, third: false },
    { first: false, second: false, third: true },
    { first: true, second: true, third: false },
    { first: true, second: false, third: true },
    { first: false, second: true, third: true },
    { first: true, second: true, third: true },
  ];

  it('occupancy は「誰かいるか」だけを取り出す', () => {
    expect(occupancy(EMPTY_BASE_RUNNERS)).toEqual(EMPTY_BASES);
    expect(occupancy({ first: 'A', second: null, third: 'C' })).toEqual({
      first: true,
      second: false,
      third: true,
    });
  });

  it('runnersFromBases → occupancy は元の塁状況に戻る（往復で情報が壊れない）', () => {
    for (const bases of ALL_BASE_STATES) {
      expect(occupancy(runnersFromBases(bases))).toEqual(bases);
    }
  });

  /**
   * 真偽値版は識別版の薄いアダプタなので、進塁の規則は1本しかない。
   * 「占有状況の計算が2つに分かれて食い違う」ことが起きないよう全パターンで固定する。
   */
  it('識別版と真偽値版の進塁結果は全パターンで一致する', () => {
    for (const bases of ALL_BASE_STATES) {
      const walked = forceAdvanceRunners(runnersFromBases(bases), 'BATTER');
      expect(occupancy(walked.runners)).toEqual(forceAdvance(bases).bases);
      expect(walked.runs).toBe(forceAdvance(bases).runs);

      for (const hit of ['single', 'double', 'triple', 'homerun'] as const) {
        const hitResult = advanceOnHitRunners(runnersFromBases(bases), 'BATTER', hit);
        expect(occupancy(hitResult.runners)).toEqual(advanceOnHit(bases, hit).bases);
        expect(hitResult.runs).toBe(advanceOnHit(bases, hit).runs);
      }
    }
  });

  it('四球：打者が一塁に入り、押し出された走者は自分の identity のまま次の塁へ', () => {
    const { runners, runs } = forceAdvanceRunners(
      { first: 'A', second: 'B', third: null },
      'BATTER',
    );
    expect(runners).toEqual({ first: 'BATTER', second: 'A', third: 'B' });
    expect(runs).toBe(0);
  });

  it('四球：フォースされない走者はその塁に残る（誰も入れ替わらない）', () => {
    const { runners } = forceAdvanceRunners({ first: null, second: 'B', third: 'C' }, 'BATTER');
    expect(runners).toEqual({ first: 'BATTER', second: 'B', third: 'C' });
  });

  it('満塁の押し出しは三塁走者が生還する（残る顔ぶれが1つずつずれる）', () => {
    const { runners, runs } = forceAdvanceRunners(
      { first: 'A', second: 'B', third: 'C' },
      'BATTER',
    );
    expect(runners).toEqual({ first: 'BATTER', second: 'A', third: 'B' });
    expect(runs).toBe(1); // C が生還
  });

  it('単打：全員が1つ進み、生還した走者だけが塁から消える', () => {
    const { runners, runs } = advanceOnHitRunners(
      { first: 'A', second: null, third: 'C' },
      'BATTER',
      'single',
    );
    expect(runners).toEqual({ first: 'BATTER', second: 'A', third: null });
    expect(runs).toBe(1); // C が生還
  });

  it('本塁打は全員生還して塁が空になる', () => {
    const { runners, runs } = advanceOnHitRunners(
      { first: 'A', second: 'B', third: 'C' },
      'BATTER',
      'homerun',
    );
    expect(runners).toEqual(EMPTY_BASE_RUNNERS);
    expect(runs).toBe(4);
  });

  it('二塁打で走者の行き先が重ならない（全員が同じ塁数だけ動くため）', () => {
    const { runners } = advanceOnHitRunners(
      { first: 'A', second: 'B', third: null },
      'BATTER',
      'double',
    );
    expect(runners).toEqual({ first: null, second: 'BATTER', third: 'A' });
    // B は生還済みなので、どの塁にも残っていない
    expect(Object.values(runners)).not.toContain('B');
  });
});

// ヒットエンドラン（フェーズH-28）：投球の前にスタートを切っていた走者は、安打のとき
// もう1つ先まで行ける（走らせて打つことの見返り）。**渡さなければ従来と完全に同じ**。
describe('advanceOnHitRunners：飛び出していた走者の追加進塁（H-28）', () => {
  const ALL_BASE_STATES: Bases[] = [
    { first: false, second: false, third: false },
    { first: true, second: false, third: false },
    { first: false, second: true, third: false },
    { first: false, second: false, third: true },
    { first: true, second: true, third: false },
    { first: true, second: false, third: true },
    { first: false, second: true, third: true },
    { first: true, second: true, third: true },
  ];
  const ALL_EXTRA: Array<Array<'first' | 'second' | 'third'>> = [
    [],
    ['first'],
    ['second'],
    ['third'],
    ['first', 'second'],
    ['first', 'third'],
    ['second', 'third'],
    ['first', 'second', 'third'],
  ];

  it('単打で一塁走者が三塁まで行く（打者は一塁）', () => {
    const { runners, runs } = advanceOnHitRunners(
      { first: 'A', second: null, third: null },
      'BATTER',
      'single',
      ['first'],
    );
    expect(runners).toEqual({ first: 'BATTER', second: null, third: 'A' });
    expect(runs).toBe(0);
  });

  it('二塁走者は単打で生還する', () => {
    const { runners, runs } = advanceOnHitRunners(
      { first: null, second: 'B', third: null },
      'BATTER',
      'single',
      ['second'],
    );
    expect(runners).toEqual({ first: 'BATTER', second: null, third: null });
    expect(runs).toBe(1);
  });

  it('前の走者は追い越せない（一・二塁で飛び出していても三塁は二塁走者のもの）', () => {
    const { runners, runs } = advanceOnHitRunners(
      { first: 'A', second: 'B', third: null },
      'BATTER',
      'single',
      ['first'],
    );
    // B が三塁で止まるので A は二塁まで。**誰も消えない**（行き先の取り合いが起きない）
    expect(runners).toEqual({ first: 'BATTER', second: 'A', third: 'B' });
    expect(runs).toBe(0);
  });

  it('前の走者が生還したぶんは詰められる（一・三塁で一塁走者が飛び出し）', () => {
    const { runners, runs } = advanceOnHitRunners(
      { first: 'A', second: null, third: 'C' },
      'BATTER',
      'single',
      ['first'],
    );
    expect(runners).toEqual({ first: 'BATTER', second: null, third: 'A' });
    expect(runs).toBe(1); // C が生還して三塁が空く
  });

  it('本塁打では何も変わらない（全員どのみち生還する）', () => {
    const plain = advanceOnHitRunners({ first: 'A', second: 'B', third: 'C' }, 'BATTER', 'homerun');
    const extra = advanceOnHitRunners(
      { first: 'A', second: 'B', third: 'C' },
      'BATTER',
      'homerun',
      ['first', 'second', 'third'],
    );
    expect(extra).toEqual(plain);
  });

  it('省略時は従来どおり（どの塁状況・どの安打でも結果が変わらない）', () => {
    for (const bases of ALL_BASE_STATES) {
      for (const hit of ['single', 'double', 'triple', 'homerun'] as const) {
        const runners = runnersFromBases(bases, 'R');
        expect(advanceOnHitRunners(runners, 'BATTER', hit, [])).toEqual(
          advanceOnHitRunners(runners, 'BATTER', hit),
        );
      }
    }
  });

  /**
   * 走者が消えない・湧かないことを全パターンで固定する。追加進塁は行き先の取り合いを
   * 起こしうる唯一の経路（全員が同じ塁数だけ動くという前提が崩れる）なので、
   * 「塁に残った人数＋得点＝元の人数＋打者」を不変条件として押さえておく。
   */
  it('どの組み合わせでも走者は消えない（塁上＋得点＝元の走者＋打者）', () => {
    for (const bases of ALL_BASE_STATES) {
      for (const extra of ALL_EXTRA) {
        for (const hit of ['single', 'double', 'triple', 'homerun'] as const) {
          const before = { first: 'A', second: 'B', third: 'C' };
          const runners = {
            first: bases.first ? before.first : null,
            second: bases.second ? before.second : null,
            third: bases.third ? before.third : null,
          };
          const occupants = Object.values(runners).filter((id) => id !== null).length + 1;
          const { runners: after, runs } = advanceOnHitRunners(runners, 'BATTER', hit, extra);
          const left = Object.values(after).filter((id) => id !== null);
          expect(left.length + runs).toBe(occupants);
          // 同じ走者が2つの塁に居座らない（行き先の取り合いで上書きされていない）
          expect(new Set(left).size).toBe(left.length);
        }
      }
    }
  });
});

describe('チーム属性ヘルパー', () => {
  it('表はビジター攻撃・ホーム守備', () => {
    expect(battingTeam('top')).toBe('away');
    expect(fieldingTeam('top')).toBe('home');
  });

  it('裏はホーム攻撃・ビジター守備', () => {
    expect(battingTeam('bottom')).toBe('home');
    expect(fieldingTeam('bottom')).toBe('away');
  });

  it('opponent は相手側を返す', () => {
    expect(opponent('away')).toBe('home');
    expect(opponent('home')).toBe('away');
  });
});
