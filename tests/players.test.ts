/**
 * 誰がどちらの側を操作するか（フェーズD-20。1P PLAY / 2P PLAY）。
 *
 * ここをテストする値打ちは2つ：
 * - **1P PLAY の割当がD-20より前と同じであること**＝「人間側はこの1つ、もう一方はCPU」。
 *   ここが崩れると、既に調整済みの1P PLAY の挙動（CPU投球・CPU守備・CPU走塁）が
 *   まるごと変わる（人間側にもCPUが動く／CPU側の入力を人間が握る）。
 * - **役割が表裏で必ず入れ替わること**＝同じキー（A）が1Pには投球・2Pには打撃を意味する、
 *   という2P PLAY の操作体系そのもの。**2人が同じ役割を取り合うことも、どちらも
 *   受け持たないことも起きない**のがこの仕組みの前提（CLAUDE.md ①の多目的ボタン方式が
 *   2人に広がっても成立する条件）。
 *
 * 入力そのもの（キーの読み取り・パッドの合成）は手動確認とPlaywrightの実機検証の担当
 * （CLAUDE.md「テスト方針」：判定ロジック・数値計算・状態遷移を優先する）。
 */
import { describe, expect, it } from 'vitest';
import {
  type PlayerSlot,
  type SideControllers,
  PLAYER_SLOTS,
  controllersFor,
  defensePlayer,
  isHumanSide,
  isTwoPlayer,
  offensePlayer,
  playerOfSide,
  roleOfPlayer,
  sideOfPlayer,
} from '../src/core/players';
import type { Half, TeamSide } from '../src/core/rules';

const HALVES: readonly Half[] = ['top', 'bottom'];
const SIDES: readonly TeamSide[] = ['away', 'home'];

describe('1P PLAY の割当（D-20より前と同じ形）', () => {
  it('人間が操作する側だけが 1P で、もう一方は必ずCPU', () => {
    for (const humanSide of SIDES) {
      const controllers = controllersFor('1p', humanSide);
      expect(playerOfSide(controllers, humanSide)).toBe('p1');
      expect(playerOfSide(controllers, humanSide === 'away' ? 'home' : 'away')).toBeNull();
      expect(isTwoPlayer(controllers)).toBe(false);
    }
  });

  it('2P のパッドはどの側も操作しない（1P PLAY 中に押しても何も起きない条件）', () => {
    for (const humanSide of SIDES) {
      const controllers = controllersFor('1p', humanSide);
      expect(sideOfPlayer(controllers, 'p2')).toBeNull();
      for (const half of HALVES) {
        expect(roleOfPlayer(controllers, half, 'p2')).toBeNull();
      }
    }
  });

  it('守備側・攻撃側のどちらか一方だけが人間になる（もう一方はCPUが担う）', () => {
    for (const humanSide of SIDES) {
      const controllers = controllersFor('1p', humanSide);
      for (const half of HALVES) {
        const defense = defensePlayer(controllers, half);
        const offense = offensePlayer(controllers, half);
        expect(defense === null).not.toBe(offense === null);
      }
    }
  });
});

describe('2P PLAY の割当（説明書p4「先攻がコントローラーI、後攻がII」）', () => {
  const controllers = controllersFor('2p', 'away');

  it('先攻＝1P・後攻＝2P に固定される（humanSide は使われない）', () => {
    expect(controllers).toEqual({ away: 'p1', home: 'p2' });
    // 1P PLAY 用の引数を変えても 2P の割当は動かない（固定＝原作準拠）
    expect(controllersFor('2p', 'home')).toEqual(controllers);
  });

  it('両側とも人間（CPUに任せる判断がどこにも立たない）', () => {
    expect(isTwoPlayer(controllers)).toBe(true);
    for (const side of SIDES) expect(isHumanSide(controllers, side)).toBe(true);
    for (const half of HALVES) {
      expect(defensePlayer(controllers, half)).not.toBeNull();
      expect(offensePlayer(controllers, half)).not.toBeNull();
    }
  });

  it('表裏で役割が入れ替わる（同じキーが1Pには投球・2Pには打撃を意味する）', () => {
    // 表＝先攻（1P）の攻撃／裏＝後攻（2P）の攻撃
    expect(roleOfPlayer(controllers, 'top', 'p1')).toBe('batting');
    expect(roleOfPlayer(controllers, 'top', 'p2')).toBe('pitching');
    expect(roleOfPlayer(controllers, 'bottom', 'p1')).toBe('pitching');
    expect(roleOfPlayer(controllers, 'bottom', 'p2')).toBe('batting');
  });

  it('2人が同じ役割を取り合うことも、どちらも受け持たないことも無い', () => {
    for (const half of HALVES) {
      const roles = PLAYER_SLOTS.map((p) => roleOfPlayer(controllers, half, p));
      expect(roles).toContain('pitching');
      expect(roles).toContain('batting');
    }
  });

  it('守備側・攻撃側は必ず別のプレイヤー（同じ人が投げて打つことがない）', () => {
    for (const half of HALVES) {
      const defense = defensePlayer(controllers, half);
      const offense = offensePlayer(controllers, half);
      expect(defense).not.toBe(offense);
    }
  });
});

describe('side と player の対応（入力の振り分けの土台）', () => {
  const cases: SideControllers[] = [
    controllersFor('1p', 'away'),
    controllersFor('1p', 'home'),
    controllersFor('2p', 'away'),
  ];

  it('playerOfSide と sideOfPlayer は互いの逆になっている', () => {
    for (const controllers of cases) {
      for (const side of SIDES) {
        const player = playerOfSide(controllers, side);
        if (player === null) continue;
        expect(sideOfPlayer(controllers, player)).toBe(side);
      }
      for (const player of PLAYER_SLOTS) {
        const side = sideOfPlayer(controllers, player);
        if (side === null) continue;
        expect(playerOfSide(controllers, side)).toBe(player);
      }
    }
  });

  it('1人のプレイヤーが2つの側を同時に操作することはない', () => {
    for (const controllers of cases) {
      const sides = PLAYER_SLOTS.map((p) => sideOfPlayer(controllers, p)).filter(
        (s): s is TeamSide => s !== null,
      );
      expect(new Set(sides).size).toBe(sides.length);
    }
  });

  it('役割は「守備側なら投球・攻撃側なら打撃」から導出される（別に持たない）', () => {
    for (const controllers of cases) {
      for (const half of HALVES) {
        for (const player of PLAYER_SLOTS) {
          const role = roleOfPlayer(controllers, half, player);
          const expected: PlayerSlot | null = defensePlayer(controllers, half);
          if (role === 'pitching') expect(player).toBe(expected);
          if (role === 'batting') expect(player).toBe(offensePlayer(controllers, half));
        }
      }
    }
  });
});
