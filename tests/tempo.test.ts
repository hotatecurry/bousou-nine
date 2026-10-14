import { describe, expect, it } from 'vitest';
import {
  type AtBatMarker,
  CALL_BANNER_SEC,
  CONTACT_BLACKOUT_SEC,
  CONTACT_HOLD_SEC,
  CPU_BRAWL_DECISION_SEC,
  CPU_PITCH_INTERVAL_SEC,
  FOUL_RESULT_PAUSE_SEC,
  GUN_TELEGRAPH_SEC,
  INTERLUDE_SEC,
  PITCH_SETTLE_SEC,
  PLAY_RESULT_PAUSE_SEC,
  interludeBetween,
} from '../src/core/tempo';

function marker(over: Partial<AtBatMarker> = {}): AtBatMarker {
  return { inning: 1, half: 'top', lineupIndex: 0, over: false, ...over };
}

describe('interludeBetween（打席の切れ目に置く「間」の判断）', () => {
  it('同じ打席が続いている間は「間」を置かない', () => {
    expect(interludeBetween(marker(), marker())).toBeNull();
  });

  it('打順が進んだら打者の仕切り直し', () => {
    expect(interludeBetween(marker(), marker({ lineupIndex: 1 }))).toBe('batterChange');
  });

  it('打順が9番から1番へ一巡しても打者の仕切り直しになる', () => {
    // 「増えたか」ではなく「変わったか」で見ていることの確認（一巡でも間は要る）
    expect(interludeBetween(marker({ lineupIndex: 8 }), marker({ lineupIndex: 0 }))).toBe(
      'batterChange',
    );
  });

  it('表裏が入れ替わったら攻守交代', () => {
    expect(interludeBetween(marker(), marker({ half: 'bottom' }))).toBe('inningChange');
  });

  it('イニングが進んだら攻守交代', () => {
    expect(
      interludeBetween(marker({ half: 'bottom' }), marker({ inning: 2, half: 'top' })),
    ).toBe('inningChange');
  });

  it('攻守交代は打者交代より優先する（交代では必ず打者も代わるため）', () => {
    // 表裏が変われば打順インデックスも別チームのものに変わる。ここで短いほうを選ぶと
    // 「チェンジ」を見せる時間が消えてしまう。
    expect(
      interludeBetween(marker({ lineupIndex: 3 }), marker({ half: 'bottom', lineupIndex: 5 })),
    ).toBe('inningChange');
  });

  it('試合が終わっていたら「間」を置かない（勝敗表示へ進む）', () => {
    expect(
      interludeBetween(marker({ lineupIndex: 3 }), marker({ inning: 9, half: 'bottom', over: true })),
    ).toBeNull();
  });
});

describe('テンポの定数（原作の実測値を入れ替えても壊してはいけない大小関係）', () => {
  it('判定コールは捕球後の「間」の中で消える（次の投球に重ならない）', () => {
    expect(CALL_BANNER_SEC).toBeLessThanOrEqual(PITCH_SETTLE_SEC);
  });

  it('攻守交代の「間」は打者交代より長い（どちらの攻撃になったかを読ませる）', () => {
    expect(INTERLUDE_SEC.inningChange).toBeGreaterThan(INTERLUDE_SEC.batterChange);
  });

  it('打席の切れ目の「間」は1球ごとの「間」より長い（毎球そこまで待たせない）', () => {
    expect(INTERLUDE_SEC.batterChange).toBeGreaterThan(PITCH_SETTLE_SEC);
  });

  it('銃の予兆は1球ごとの「間」より長い（構えたことを読み取れる長さが要る）', () => {
    // 予兆が短いと「人に反応できない動作」（桜井ノウハウ）に戻る。打者側に回避手段が
    // 無い（CLAUDE.md ③）以上、見えていることだけが理不尽感を防いでいる。
    expect(GUN_TELEGRAPH_SEC).toBeGreaterThan(PITCH_SETTLE_SEC);
  });

  it('銃の予兆は攻守交代の「間」より短い（1つのことを読むだけの時間に収める）', () => {
    expect(GUN_TELEGRAPH_SEC).toBeLessThan(INTERLUDE_SEC.inningChange);
  });

  it('ファウルの見せ時間はほかの帰結より長い（打球がどこへ行ったかを見てから戻る。WW-71）', () => {
    expect(FOUL_RESULT_PAUSE_SEC).toBeGreaterThan(PLAY_RESULT_PAUSE_SEC);
  });

  it('打った瞬間の絵は2フレーム・黒は7フレーム（原作の実測。BBB-76）', () => {
    // 原作の打った映像：バットに球が来た絵を2フレーム見せ、7フレーム真っ黒になってから守備の画面
    expect(CONTACT_HOLD_SEC * 60).toBeCloseTo(2, 9);
    expect(CONTACT_BLACKOUT_SEC * 60).toBeCloseTo(7, 9);
    // 合わせても0.2秒に満たない＝WW-71が嫌った「切り替わる前の一時停止」にはならない長さ
    expect(CONTACT_HOLD_SEC + CONTACT_BLACKOUT_SEC).toBeLessThan(0.2);
  });

  it('すべての「間」は正の値（0にすると原作より速い従来の挙動に戻る）', () => {
    for (const sec of [
      PITCH_SETTLE_SEC,
      CPU_PITCH_INTERVAL_SEC,
      PLAY_RESULT_PAUSE_SEC,
      FOUL_RESULT_PAUSE_SEC,
      CONTACT_HOLD_SEC,
      CONTACT_BLACKOUT_SEC,
      CPU_BRAWL_DECISION_SEC,
      CALL_BANNER_SEC,
      GUN_TELEGRAPH_SEC,
      INTERLUDE_SEC.batterChange,
      INTERLUDE_SEC.inningChange,
    ]) {
      expect(sec).toBeGreaterThan(0);
    }
  });
});
