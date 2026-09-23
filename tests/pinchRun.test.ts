/**
 * 代走（フェーズGG-54）。EE-52（采配メニュー・打順の段）→FF-53（打者カード・塁上の走者）と
 * **走力を見せてきた流れの終点**で、それまで**塁に出た後に足で動かす手が1つも無かった**
 * （v1に代走が無いことは `managerMenu.ts`・CLAUDE.md が明記していた）。
 *
 * ここで固定するのは4つ：
 *
 * - **ロスターと塁の上が必ず同時に入れ替わる**（`SUBSTITUTE_RUNNER` の1本だけが両方を書く）
 *   ＝どちらか片方だけが動くと「退いたはずの選手が塁に立っている」が起きる。
 * - **代走は退いた走者の打順スロットと守備位置を引き継ぐ**（B-10の代打とまったく同じ）。
 * - **投手が走者なら自動継投を伴う**（ユーザー判断：代打と同じ扱い）。
 * - **カウント・アウト・塁の占有は動かない**（采配は打席を進めない＝代打・継投と同じ）。
 *
 * CPUの規則（`chooseCpuPinchRunner`）の値の根拠は `npm run balance:pinchrun` が測り、
 * 帯は `tests/balance.test.ts` が固定する（`cpuOffense.test.ts` と同じ分け方）。
 */
import { describe, expect, it } from 'vitest';
import { createActor } from 'xstate';
import { gameMachine } from '../src/core/gameMachine';
import {
  CPU_PINCH_RUN_BAT_LOSS,
  type CpuPinchRunCandidate,
  chooseCpuPinchRunner,
} from '../src/core/cpuBatter';
import {
  PITCHER_ORDER_SLOT,
  canPinchRun,
  createTeamRoster,
  currentBatterId,
  positionOf,
  ratingBar,
  substituteRunnerAt,
} from '../src/core/roster';
import { describePinchRunTarget } from '../src/ui/managerMenu';
import { ANONYMOUS_RUNNER } from '../src/core/rules';
import { teamById } from '../src/core/teams';

const TEAM = teamById('foresters');
const roster = createTeamRoster(TEAM);

// ---- ロスターの入れ替え（substituteRunnerAt） ----

describe('代走：ロスターの入れ替え（substituteRunnerAt）', () => {
  it('退いた走者の打順スロットと守備位置を、代走がそのまま引き継ぐ', () => {
    // 3番（外野手）が塁にいる、という想定
    const runnerId = roster.lineup[2];
    const position = positionOf(roster, runnerId);
    const incoming = roster.bench[0];
    const { roster: next, ok } = substituteRunnerAt(roster, runnerId, 0);

    expect(ok).toBe(true);
    expect(next.lineup[2]).toBe(incoming);
    expect(positionOf(next, incoming)).toBe(position);
    // 退いた走者はロスターから離れ、控えは1人減る
    expect(next.ejected).toContain(runnerId);
    expect(next.bench).not.toContain(incoming);
    expect(next.bench.length).toBe(roster.bench.length - 1);
    // 打順の他のスロットには触らない
    expect(next.lineup[0]).toBe(roster.lineup[0]);
    expect(next.lineupIndex).toBe(roster.lineupIndex);
  });

  it('指定した控え以外の並び順は変わらない（末尾詰めにしない）', () => {
    const { roster: next } = substituteRunnerAt(roster, roster.lineup[1], 1);
    expect(next.bench).toEqual([roster.bench[0], roster.bench[2]]);
  });

  it('投手が走者なら自動継投を伴う（守備位置Pを空けられない＝代打と同じ）', () => {
    const pitcher = roster.pitcher;
    const relief = roster.bullpen[0];
    const incoming = roster.bench[0];
    const { roster: next, ok } = substituteRunnerAt(roster, pitcher, 0);

    expect(ok).toBe(true);
    // 代走は投手の打順スロットを取り、マウンドにはブルペン先頭が上がる
    expect(next.lineup[PITCHER_ORDER_SLOT]).toBe(incoming);
    expect(next.pitcher).toBe(relief);
    expect(next.positions.P).toBe(relief);
    expect(next.bullpen.length).toBe(roster.bullpen.length - 1);
    expect(next.ejected).toContain(pitcher);
  });

  it('投手が走者でブルペンが尽きていれば、代走そのものを送れない（roster は無傷）', () => {
    const empty = { ...roster, bullpen: [] };
    const { roster: next, ok } = substituteRunnerAt(empty, empty.pitcher, 0);
    expect(ok).toBe(false);
    expect(next).toBe(empty);
  });

  it('打順から既に外れている走者（出塁した代打）は、塁の上だけの入れ替えになる', () => {
    // 打順にも守備位置にも居ない選手＝`advanceBatter` に退けられた代打の状態を作る
    const ghost = roster.bench[2];
    const orphan = { ...roster, ejected: [ghost], bench: [roster.bench[0], roster.bench[1]] };
    const { roster: next, ok } = substituteRunnerAt(orphan, ghost, 0);

    expect(ok).toBe(true);
    // 触るものが無いので打順も守備位置も動かない
    expect(next.lineup).toEqual(orphan.lineup);
    expect(next.positions).toEqual(orphan.positions);
    // すでに ejected にいる選手を二重に積まない
    expect(next.ejected.filter((id) => id === ghost).length).toBe(1);
    expect(next.bench.length).toBe(orphan.bench.length - 1);
  });

  it('範囲外の控え・実在しない走者では何も起きない（防御的ガード）', () => {
    expect(substituteRunnerAt(roster, roster.lineup[0], -1).ok).toBe(false);
    expect(substituteRunnerAt(roster, roster.lineup[0], roster.bench.length).ok).toBe(false);
    // 無名の走者（識別を持たない経路）には代走を送れない
    expect(substituteRunnerAt(roster, ANONYMOUS_RUNNER, 0).ok).toBe(false);
    expect(substituteRunnerAt(roster, roster.lineup[0], -1).roster).toBe(roster);
  });
});

describe('代走：送れるかの判断（canPinchRun）', () => {
  it('控えがいれば普通の走者には送れる', () => {
    expect(canPinchRun(roster, roster.lineup[0])).toBe(true);
  });

  it('控えが尽きていれば送れない', () => {
    expect(canPinchRun({ ...roster, bench: [] }, roster.lineup[0])).toBe(false);
  });

  it('投手が走者のときはブルペンも要る（canPinchHit とまったく同じ条件）', () => {
    expect(canPinchRun(roster, roster.pitcher)).toBe(true);
    expect(canPinchRun({ ...roster, bullpen: [] }, roster.pitcher)).toBe(false);
    // 投手以外なら、ブルペンが尽きていても送れる
    expect(canPinchRun({ ...roster, bullpen: [] }, roster.lineup[0])).toBe(true);
  });

  it('実在しない走者には送れない', () => {
    expect(canPinchRun(roster, ANONYMOUS_RUNNER)).toBe(false);
  });
});

// ---- 試合状態（SUBSTITUTE_RUNNER） ----

/** 一塁に「打席に立っていた選手」を置いた状態から始める（四球でそうなる） */
function startWithRunnerOnFirst() {
  const actor = createActor(gameMachine).start();
  const runnerId = currentBatterId(actor.getSnapshot().context.rosters.away);
  for (let i = 0; i < 4; i += 1) actor.send({ type: 'PITCH_RESULT', judgement: 'ball' });
  return { actor, runnerId };
}

describe('代走：試合状態（SUBSTITUTE_RUNNER）', () => {
  it('塁の上の走者とロスターが同時に入れ替わる（片方だけ動かない）', () => {
    const { actor, runnerId } = startWithRunnerOnFirst();
    const before = actor.getSnapshot().context;
    expect(before.baseRunners.first).toBe(runnerId);
    const incoming = before.rosters.away.bench[0];

    actor.send({ type: 'SUBSTITUTE_RUNNER', side: 'away', base: 'first', benchIndex: 0 });

    const ctx = actor.getSnapshot().context;
    expect(ctx.baseRunners.first).toBe(incoming);
    expect(ctx.rosters.away.ejected).toContain(runnerId);
    expect(ctx.rosters.away.bench).not.toContain(incoming);
  });

  it('塁の占有・カウント・アウトは動かない（采配は打席を進めない）', () => {
    const { actor } = startWithRunnerOnFirst();
    const before = actor.getSnapshot().context;

    actor.send({ type: 'SUBSTITUTE_RUNNER', side: 'away', base: 'first', benchIndex: 0 });

    const ctx = actor.getSnapshot().context;
    expect(ctx.bases).toEqual(before.bases);
    expect(ctx.count).toEqual(before.count);
    expect(ctx.outs).toBe(before.outs);
    expect(ctx.score).toEqual(before.score);
    expect(ctx.rosters.away.lineupIndex).toBe(before.rosters.away.lineupIndex);
  });

  it('空いている塁を指定しても何も起きない', () => {
    const { actor } = startWithRunnerOnFirst();
    const before = actor.getSnapshot().context;

    actor.send({ type: 'SUBSTITUTE_RUNNER', side: 'away', base: 'second', benchIndex: 0 });

    const ctx = actor.getSnapshot().context;
    expect(ctx.baseRunners).toEqual(before.baseRunners);
    expect(ctx.rosters.away.bench).toEqual(before.rosters.away.bench);
  });

  it('守備側から送っても効かない（塁上の走者は攻撃側の選手）', () => {
    const { actor } = startWithRunnerOnFirst();
    const before = actor.getSnapshot().context;

    actor.send({ type: 'SUBSTITUTE_RUNNER', side: 'home', base: 'first', benchIndex: 0 });

    const ctx = actor.getSnapshot().context;
    expect(ctx.baseRunners).toEqual(before.baseRunners);
    expect(ctx.rosters.home.bench).toEqual(before.rosters.home.bench);
  });

  it('代走で入った選手は、その打順が回ってくれば打席に立つ', () => {
    const { actor } = startWithRunnerOnFirst();
    const incoming = actor.getSnapshot().context.rosters.away.bench[0];
    actor.send({ type: 'SUBSTITUTE_RUNNER', side: 'away', base: 'first', benchIndex: 0 });

    // 1番の走者に代走を出したので、打線を一巡させると1番に代走が立つ
    const ctx = actor.getSnapshot().context;
    expect(ctx.rosters.away.lineup[0]).toBe(incoming);
  });
});

// ---- CPUの規則（chooseCpuPinchRunner） ----
//
// 「守備に残る余裕」は R-39 の `cpuStealDefenseSlack` の値をそのまま渡す約束なので、
// ここでは**しきい値の前後**を表す代表値だけを使う（実際の走力→秒の換算は
// `balance.test.ts` の帯が固定する）。

/** R-39のしきい値（テストの中では 0.10 という値そのものより「境界」の意味で使う） */
const LIMIT = 0.1;
/** その足では走れない（余裕が残る） */
const SLOW = 0.3;
/** その足なら走れる（完璧な送球でも間に合わない） */
const FAST = -0.05;
/** さらに速い */
const FASTEST = -0.2;

const SLOW_RUNNER = { average: 0.5, power: 0.5, stealSlack: SLOW };

describe('CPUの代走（GG-54。chooseCpuPinchRunner）', () => {
  it('走れない走者を、走れる控えに代える（帯をまたぐときだけ出す）', () => {
    const bench: CpuPinchRunCandidate[] = [
      { index: 0, average: 0.5, power: 0.5, stealSlack: FAST },
    ];
    expect(
      chooseCpuPinchRunner({ runner: SLOW_RUNNER, bench, stealSlackLimit: LIMIT }),
    ).toBe(0);
  });

  it('いまの走者で走れるなら出さない（足を買う理由がない）', () => {
    const bench: CpuPinchRunCandidate[] = [
      { index: 0, average: 0.5, power: 0.5, stealSlack: FASTEST },
    ];
    expect(
      chooseCpuPinchRunner({
        runner: { ...SLOW_RUNNER, stealSlack: FAST },
        bench,
        stealSlackLimit: LIMIT,
      }),
    ).toBeNull();
  });

  it('控えでも走れないなら出さない（代えても何も変わらない）', () => {
    const bench: CpuPinchRunCandidate[] = [
      { index: 0, average: 0.5, power: 0.5, stealSlack: SLOW },
    ];
    expect(
      chooseCpuPinchRunner({ runner: SLOW_RUNNER, bench, stealSlackLimit: LIMIT }),
    ).toBeNull();
  });

  it('打力を差し出しすぎるなら出さない（代走は走力を買って打力を売る手）', () => {
    // 走力では申し分ないが、AV+HR が しきい値より大きく落ちる控え
    const bench: CpuPinchRunCandidate[] = [
      {
        index: 0,
        average: 0.5 - CPU_PINCH_RUN_BAT_LOSS,
        power: 0.5 - CPU_PINCH_RUN_BAT_LOSS,
        stealSlack: FASTEST,
      },
    ];
    expect(
      chooseCpuPinchRunner({ runner: SLOW_RUNNER, bench, stealSlackLimit: LIMIT }),
    ).toBeNull();
  });

  it('しきい値ちょうどまでは許す（境界は「差し出してよい上限」）', () => {
    // **ぴったりの差は浮動小数の丸めで揺れる**（0.5 − 0.03 の引き算は 0.03 より
    // わずかに大きい差を作る）ので、しきい値の**すぐ内側**で見る。守りたいのは
    // 「上限まで差し出してよい」という向きで、最後の1e-9をどちらに倒すかではない。
    const bench: CpuPinchRunCandidate[] = [
      {
        index: 0,
        average: 0.5 - CPU_PINCH_RUN_BAT_LOSS + 1e-9,
        power: 0.5,
        stealSlack: FAST,
      },
    ];
    expect(
      chooseCpuPinchRunner({ runner: SLOW_RUNNER, bench, stealSlackLimit: LIMIT }),
    ).toBe(0);
  });

  it('条件を満たす控えのうち、もっとも速い1人を選ぶ', () => {
    const bench: CpuPinchRunCandidate[] = [
      { index: 0, average: 0.5, power: 0.5, stealSlack: FAST },
      { index: 1, average: 0.5, power: 0.5, stealSlack: FASTEST },
      { index: 2, average: 0.5, power: 0.5, stealSlack: SLOW },
    ];
    expect(chooseCpuPinchRunner({ runner: SLOW_RUNNER, bench, stealSlackLimit: LIMIT })).toBe(1);
  });

  it('同じ速さなら並び順の先（順序が一意に決まる＝決定的）', () => {
    const bench: CpuPinchRunCandidate[] = [
      { index: 0, average: 0.5, power: 0.5, stealSlack: FAST },
      { index: 1, average: 0.6, power: 0.6, stealSlack: FAST },
    ];
    expect(chooseCpuPinchRunner({ runner: SLOW_RUNNER, bench, stealSlackLimit: LIMIT })).toBe(0);
  });

  it('走者がいない・控えがいなければ出さない', () => {
    expect(chooseCpuPinchRunner({ runner: null, bench: [], stealSlackLimit: LIMIT })).toBeNull();
    expect(
      chooseCpuPinchRunner({ runner: SLOW_RUNNER, bench: [], stealSlackLimit: LIMIT }),
    ).toBeNull();
  });
});

// ---- 采配メニューの表示 ----

describe('代走：采配メニューの1枚目の行（describePinchRunTarget）', () => {
  it('塁の番号・走者の名前・走力のバーが出る（押す前に代える値打ちが読める）', () => {
    const runnerId = roster.lineup[0];
    const line = describePinchRunTarget(roster, { base: 'first', runnerId });
    expect(line).toContain('代走 1塁');
    expect(line).toContain(roster.players[runnerId].name);
    expect(line).toContain(ratingBar(TEAM.lineup[0][5]));
  });

  it('塁の番号は FF-53 の状況パネル・L-32 のリードの行と同じ 1/2/3', () => {
    const bases = ['first', 'second', 'third'] as const;
    for (const [i, base] of bases.entries()) {
      const line = describePinchRunTarget(roster, { base, runnerId: roster.lineup[i] });
      expect(line).toContain(`代走 ${i + 1}塁`);
    }
  });
});
