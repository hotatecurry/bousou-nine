/**
 * 誰がどちらの側を操作するか（フェーズD-20。説明書p4「1P PLAY / 2P PLAY」）。
 *
 * ここに置くのは**割当の規則だけ**（純粋関数。Three.js・DOM・入力デバイスを知らない）で、
 * 実際のキーを読む役は `input/keyboard.ts`、それを場面ごとに配る役は `main.ts` が持つ。
 *
 * D-20より前は「人間は1人＝`humanSide: TeamSide` の1つだけ」で、投球・打撃・守備・走塁の
 * 出し分けは `fieldingTeam(half) === humanSide` の比較で足りていた。人間が2人になると
 * この比較では**「もう一方は必ずCPU」という暗黙の前提**が崩れる（実際にちっちゃいモードは
 * 「守備が人間＝攻撃はCPU」として走者を自動で動かしていた）。そこで
 * **`Record<TeamSide, SideController>`（側ごとに誰が操作しているか）を真実に置き**、
 * 「人間か」「CPUか」「どちらのプレイヤーか」はすべてそこからの導出にする
 * （B-11の投球数→残りスタミナ、F-26-2の撃った数→残弾と同じ整理）。
 */
import { type Half, type TeamSide, battingTeam, fieldingTeam, opponent } from './rules';

/** 人間のプレイヤー（原作の コントローラーI / II に相当） */
export type PlayerSlot = 'p1' | 'p2';

/** 1つの側を操作しているもの */
export type SideController = PlayerSlot | 'cpu';

/** 原作のモード選択（説明書p4）のうち、D-20で作る2つ。WATCH・リーグ戦は対象外 */
export type PlayMode = '1p' | '2p';

/** 側ごとの操作者。**これが唯一の真実**で、以下の問い合わせはすべてここから導く */
export type SideControllers = Record<TeamSide, SideController>;

/** でっかいモード／ちっちゃいモードで、あるプレイヤーが担っている役割 */
export type PlayerRole = 'pitching' | 'batting';

export const PLAYER_SLOTS: readonly PlayerSlot[] = ['p1', 'p2'];

/** HUD・操作ヒントに出す表記（1P/2P。原作の コントローラーI / II にあたる） */
export const PLAYER_LABEL: Record<PlayerSlot, string> = { p1: '1P', p2: '2P' };

/**
 * モードと（1P PLAYなら）人間が操作する側から、側ごとの操作者を決める。
 *
 * **2P PLAY は先攻＝1P・後攻＝2P に固定する**（原作準拠：説明書p4「先攻がコントローラーI、
 * 後攻がII」）。固定なので `humanSide` は 1P PLAY のときだけ意味を持つ。
 */
export function controllersFor(mode: PlayMode, humanSide: TeamSide): SideControllers {
  if (mode === '2p') return { away: 'p1', home: 'p2' };
  return {
    [humanSide]: 'p1',
    [opponent(humanSide)]: 'cpu',
  } as SideControllers;
}

/** その側を操作している人間（CPUが操作しているなら null） */
export function playerOfSide(
  controllers: SideControllers,
  side: TeamSide,
): PlayerSlot | null {
  const controller = controllers[side];
  return controller === 'cpu' ? null : controller;
}

/** そのプレイヤーが操作している側（操作していない＝1P PLAYの2P なら null） */
export function sideOfPlayer(
  controllers: SideControllers,
  player: PlayerSlot,
): TeamSide | null {
  if (controllers.away === player) return 'away';
  if (controllers.home === player) return 'home';
  return null;
}

/** その側が人間の操作か */
export function isHumanSide(controllers: SideControllers, side: TeamSide): boolean {
  return controllers[side] !== 'cpu';
}

/** 人間が2人か（＝2P PLAY。「もう一方は必ずCPU」の前提が崩れる場面の判定に使う） */
export function isTwoPlayer(controllers: SideControllers): boolean {
  return isHumanSide(controllers, 'away') && isHumanSide(controllers, 'home');
}

/**
 * いまその回で、そのプレイヤーが担っている役割（担っていなければ null）。
 *
 * 投球と打撃は必ず表裏で入れ替わる別チームの役割なので、**2人が同じ役割を取り合うことも、
 * どちらも受け持たないこともない**（D-20より前の isPitchingHuman/isBattingHuman が
 * 「常にどちらか片方だけ true」だったのと同じ性質を、プレイヤー単位に移したもの）。
 */
export function roleOfPlayer(
  controllers: SideControllers,
  half: Half,
  player: PlayerSlot,
): PlayerRole | null {
  const side = sideOfPlayer(controllers, player);
  if (side === null) return null;
  return side === fieldingTeam(half) ? 'pitching' : 'batting';
}

/** 守備側を操作している人間（CPU守備なら null） */
export function defensePlayer(
  controllers: SideControllers,
  half: Half,
): PlayerSlot | null {
  return playerOfSide(controllers, fieldingTeam(half));
}

/** 攻撃側を操作している人間（CPU攻撃なら null） */
export function offensePlayer(
  controllers: SideControllers,
  half: Half,
): PlayerSlot | null {
  return playerOfSide(controllers, battingTeam(half));
}
