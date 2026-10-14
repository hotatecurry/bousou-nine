/**
 * CPUが見ている質を人間にも見せる（フェーズDD-51。CLAUDE.md ⑪／「意思決定材料は隠さない」）。
 *
 * Z-47はCPUの継投に「疲労込みの質」という物差しを与えて閉じたが、**人間の采配メニューには
 * 型と残量%しか出ていなかった**（ブルペン候補の球速・変化量・ERAは試合中どこにも出ない）。
 * ここで固定したいのは3つ：
 *
 * - **画面に出る3本のバーと、CPUが比べている合計が同じ1か所から出る**
 *   （`pitcherQuality` は `pitcherStuff` の和として定義し直した＝割り戻しではない）。
 * - **疲労とスキルがバーに出る**（＝「疲れたエースと無傷の格下」を人間も比べられる）。
 * - **合計値そのものは画面に出さない**（ユーザー判断。継投をバーの長さ比べにしない）。
 */
import { describe, expect, it } from 'vitest';
import {
  RATING_TICKS,
  createTeamRoster,
  effectivePitching,
  fatigueOf,
  grantSkill,
  maxPitchesFor,
  pitcherQuality,
  pitcherQualityOf,
  pitcherStuff,
  pitcherStuffOf,
  ratingBar,
  substitutePitcherAt,
  withCarriedFatigue,
  BOUNCING_FORK_LABEL,
} from '../src/core/roster';
import { describePitcherEntry } from '../src/ui/managerMenu';
import { pitcherRowPitching, teamById } from '../src/core/teams';
import { forkBounces } from '../src/core/pitch';

const TEAM = teamById('foresters');
/** 投手陣の i 人目のID（名鑑の並び順＝C-15の約束） */
const pid = (i: number): string => `${TEAM.id}-p${i + 1}`;

/** その投手を疲労1.0（残量0）まで投げさせたロスター */
function exhausted(playerId: string) {
  const base = createTeamRoster(TEAM);
  const max = maxPitchesFor(effectivePitching(base, playerId)!.stamina);
  return withCarriedFatigue(base, { [playerId]: max });
}

describe('質の内訳（pitcherStuff）＝CPUの物差しの中身', () => {
  it('3つの和が pitcherQuality に一致する（表示とCPUの判断が同じ出どころ）', () => {
    const stats = effectivePitching(createTeamRoster(TEAM), pid(0))!;
    for (const fatigue of [0, 0.25, 0.5, 0.75, 1]) {
      const stuff = pitcherStuff(stats, fatigue);
      expect(stuff.speed + stuff.breaking + stuff.control).toBeCloseTo(
        pitcherQuality(stats, fatigue),
        10,
      );
    }
  });

  it('ロスター版も同じ（pitcherStuffOf の和＝pitcherQualityOf）', () => {
    const roster = exhausted(pid(0));
    const stuff = pitcherStuffOf(roster, pid(0));
    expect(stuff.speed + stuff.breaking + stuff.control).toBeCloseTo(
      pitcherQualityOf(roster, pid(0)),
      10,
    );
  });

  it('疲れると3つとも落ちる（B-11の球速・変化量＋W-44の制球）', () => {
    const stats = effectivePitching(createTeamRoster(TEAM), pid(0))!;
    const fresh = pitcherStuff(stats, 0);
    const tired = pitcherStuff(stats, 1);
    expect(tired.speed).toBeLessThan(fresh.speed);
    expect(tired.breaking).toBeLessThan(fresh.breaking);
    expect(tired.control).toBeLessThan(fresh.control);
  });

  it('投球能力を持たない選手でも読み出しで止まらない（0が返る）', () => {
    const stuff = pitcherStuff(undefined, 0);
    expect(stuff).toEqual({ speed: 0, breaking: 0, control: 0 });
  });
});

describe('能力値バー（ratingBar）＝先発選択画面と采配メニューで同じ目盛り', () => {
  it('0..1 が目盛りの数に対応する', () => {
    expect(ratingBar(0)).toBe('○'.repeat(RATING_TICKS));
    expect(ratingBar(1)).toBe('●'.repeat(RATING_TICKS));
    expect(ratingBar(0.5)).toHaveLength(RATING_TICKS);
  });

  it('範囲外でも桁が崩れない（列がずれると画面をまたいだ比較ができない）', () => {
    expect(ratingBar(-1)).toBe('○'.repeat(RATING_TICKS));
    expect(ratingBar(2)).toBe('●'.repeat(RATING_TICKS));
  });

  it('レーティングについて単調（バーの長さの大小＝能力の大小）', () => {
    const filled = (v: number) => (ratingBar(v).match(/●/g) ?? []).length;
    for (let i = 1; i <= 10; i += 1) {
      expect(filled(i / 10)).toBeGreaterThanOrEqual(filled((i - 1) / 10));
    }
  });
});

describe('采配メニューの継投（describePitcherEntry）', () => {
  /** バーの●の数（＝目で読める長さ） */
  const filled = (line: string): number => (line.match(/●/g) ?? []).length;

  it('1行1人の表になる：名前・型・残量・3本のバー', () => {
    const roster = createTeamRoster(TEAM);
    const line = describePitcherEntry(roster, pid(1));
    // 表なので改行しない（960x540で溢れないための形。実機の計測で決めた）
    expect(line).not.toContain('\n');
    expect(line).toContain(TEAM.pitchers[1][0]);
    expect(line).toMatch(/先発|救援/);
    expect(line).toContain('100%');
    expect(filled(line)).toBeGreaterThan(0);
  });

  it('列が縦に揃う（名前の長さによらず桁の位置が同じ＝比べるための表示）', () => {
    const roster = createTeamRoster(TEAM);
    const positions = TEAM.pitchers.map((_, i) => describePitcherEntry(roster, pid(i)).indexOf('●'));
    // 名鑑には2〜4文字の名前が混在しうるので、ここが揃わなければ `padName` が効いていない
    expect(new Set(positions).size).toBe(1);
  });

  it('ワンバウンドするフォークを持つ投手には「落ちるフォーク」の印が付く（フェーズBBB-79）', () => {
    const roster = createTeamRoster(TEAM);
    const marked = TEAM.pitchers.map((_, i) => describePitcherEntry(roster, pid(i)).endsWith(BOUNCING_FORK_LABEL));
    // 印は「Fが境目以上」の投手とちょうど一致する（HUDの投手カード・実際の球と同じ式）
    expect(marked).toEqual(TEAM.pitchers.map((row) => forkBounces(pitcherRowPitching(row).fork)));
    expect(marked.some(Boolean)).toBe(true);
    expect(marked.every(Boolean)).toBe(false);
    // 疲れ切れば落ちなくなる＝印も消える
    const i = marked.indexOf(true);
    expect(describePitcherEntry(exhausted(pid(i)), pid(i))).not.toContain(BOUNCING_FORK_LABEL);
  });

  it('CPUが比べている3つがそのまま出る（表示と判断が食い違わない）', () => {
    const roster = exhausted(pid(0));
    const stuff = pitcherStuffOf(roster, pid(0));
    const line = describePitcherEntry(roster, pid(0));
    expect(line).toContain(
      [ratingBar(stuff.speed), ratingBar(stuff.breaking), ratingBar(stuff.control)].join(' '),
    );
  });

  it('疲れた投手はバーが短くなる（残量だけでは読めなかったものが出る）', () => {
    const fresh = describePitcherEntry(createTeamRoster(TEAM), pid(0));
    const tired = describePitcherEntry(exhausted(pid(0)), pid(0));
    expect(filled(tired)).toBeLessThan(filled(fresh));
  });

  it('スキルの補正が出る（`シネンセイギョ`＝制球+0.20 でセイキュウが伸びる）', () => {
    const base = createTeamRoster(TEAM);
    const skilled = grantSkill(base, pid(1), 'shinenseigyo').roster;
    // 名鑑の値によっては目盛りが動かないこともあるので、まず素の値が動いていることを確かめる
    expect(pitcherStuffOf(skilled, pid(1)).control).toBeGreaterThan(
      pitcherStuffOf(base, pid(1)).control,
    );
    expect(filled(describePitcherEntry(skilled, pid(1)))).toBeGreaterThanOrEqual(
      filled(describePitcherEntry(base, pid(1))),
    );
    expect(describePitcherEntry(skilled, pid(1))).toContain(
      ratingBar(pitcherStuffOf(skilled, pid(1)).control),
    );
  });

  it('合計値（0..3）は画面に出さない（バーの長さ比べにしない＝ユーザー判断）', () => {
    const roster = exhausted(pid(0));
    const text = describePitcherEntry(roster, pid(0));
    expect(text).not.toContain(pitcherQualityOf(roster, pid(0)).toFixed(2));
    expect(text).not.toMatch(/シツ|チカラ/);
  });

  it('継投すれば表示も新しい投手のものになる（表示が実際のマウンドを指す）', () => {
    const { roster } = substitutePitcherAt(exhausted(pid(0)), 0);
    expect(fatigueOf(roster, roster.pitcher)).toBe(0);
    expect(describePitcherEntry(roster, roster.pitcher)).toContain('100%');
  });
});
