/**
 * 乱闘の格闘エンジン（**v2＝コマンド必殺技・コンボ・投げ技**。フェーズG-27）。
 * 体力ゲージ・技の判定・状態遷移だけを持ち、シーン/入力には依存しない。
 *
 * CLAUDE.md ③「乱闘システム」準拠：
 * - v2スコープ：本格コマンド入力必殺技・コンボ・投げ技を含む格闘システム。
 * - 決着：敗北した側は（呼び出し側の責務で）その試合から永久退場する。
 *
 * 対戦カードは「打者 vs 投手」の1vs1固定（死球を挟んだ両者の乱闘、という
 * 仕様上の場面が常にこの2人であるため）。**1P PLAY では打者側だけを人間が操作し、
 * 投手側は簡易CPU（brawlScene.ts側の責務）が動かす。2P PLAY では両側が人間**。
 *
 * 他のcore/*.tsと同じく乱数は一切使わない（このゲーム全体の設計方針：判定はすべて
 * 決定的で、同じ入力なら同じ結果になる＝テストしやすく、プレイヤーが「なぜそうなったか」を
 * 納得できる）。技の当たり外れはガード可否・投げの成立条件・入力タイミングだけで決まる。
 *
 * ## v2の骨格＝三すくみ（ガード・投げ・打撃）
 *
 * v1は「ガードすると8割減る／必殺技だけガード不能」だけだったので、**ガードし続ける側に
 * 崩れる理由が無かった**（必殺技を持たない選手どうしならガード連打が最適解になる）。
 * v2は崩しの役目を**投げ**へ移し、次の三すくみを作る：
 *
 * - **ガード**は打撃を8割減らす。ただし**投げには無力**（`guardable: false`）。
 * - **投げ**は棒立ち・ガード中の相手を掴む。ただし**相手が技を出していると空振り**して
 *   大きな隙（`whiffRecoverySec`）を晒す。
 * - **打撃**は投げの空振りを潰す（発生が速い技ほど確実）。
 *
 * 桜井ノウハウ「ゲーム性とは駆け引き、そしてリスクとリターン」「リスクとリターンは
 * かなり近いところに適切な大きさに配置しなければならない」。v1では「ガードの上から
 * 崩す手段」が必殺技（＝スキルを引いた人だけの特権）にしか無く、**引けなかった試合の
 * 乱闘には駆け引きが存在しなかった**。投げは全員が持つので、素の選手どうしでも成立する。
 *
 * ## コンボ＝「当てた技はキャンセルして次へ繋げられる」
 *
 * 技が**ヒットしたときだけ**（ガードされたら不可）、硬直をキャンセルして**より格上の技**へ
 * 繋げられる（`rank`）。同じ技・格下へは繋げられないので、ジャブ連打が無限ループにならない。
 * 相手はヒットストップ（`hitstunSec`）の間は動けないので、**次の技の発生がその残り時間より
 * 短ければ実際に繋がる**＝繋がるかどうかは秒数の比較だけで決まり、専用のコンボ表を持たない。
 */
import type { CommandId } from './brawlCommand';

export type BrawlSide = 'batter' | 'pitcher';

/**
 * 技のID。**必殺技はスキルが配る**（2026-07-31 ユーザー判断。`skills.ts` の `unlockMove`）。
 * 素の選手が持つのは `jab` / `punch` / `throw` の3つで、これだけで三すくみが成立する。
 */
export type MoveId = 'jab' | 'punch' | 'throw' | 'shoryu' | 'buki' | 'batto';

/** 打撃か投げか。**投げだけがガードを貫き、相手の状態で成否が変わる** */
export type MoveKind = 'strike' | 'throw';

export interface MoveDef {
  power: number;
  startupSec: number;
  recoverySec: number;
  /** 投げが空振りしたときの隙（打撃は使わない）。**リスクの実体はここ** */
  whiffRecoverySec?: number;
  /** ヒットさせた相手が動けない時間。**次の技の発生がこれより短ければコンボになる** */
  hitstunSec: number;
  /** ガードされたときに相手が動けない時間（ヒットより短い＝ガードした側が先に動ける） */
  guardstunSec: number;
  /**
   * 技の格。**格が上がる方向にしかキャンセルできない**ので、同じ技の繰り返しで
   * 永久に繋ぐことができない（コンボの上限をダメージ補正とは別に構造で作る）。
   */
  rank: number;
  kind: MoveKind;
  /**
   * ガードで防げるか。**投げだけが防げない**＝ガードを崩す唯一の手段（v1は必殺技を
   * ガード不能にしていたが、その役目は投げへ移した。上のコメント参照）。
   */
  guardable: boolean;
  /**
   * 必殺技のコマンド（`core/brawlCommand.ts`）。持たない技は方向＋ボタンで出る。
   * **どのコマンドがどの技になるかの唯一の出どころ**で、入力側は
   * `moveForCommand` でここを引く（表と実装が二重に持たれない）。
   */
  command?: CommandId;
}

/**
 * 技の表。数値は**秒**で持つ（フレーム数ではない＝このゲームの他の判定と同じ時計）。
 *
 * 発生・硬直・ヒットストップの関係は「繋がる／繋がらない」を直接決めるので、
 * **格を1つ上げた技の発生が、格下の技のヒットストップより短い**ように並べてある
 * （jab 0.36 > punch 0.26 / punch 0.46 > shoryu 0.30 / shoryu 0.60 > buki 0.38 …）。
 * 逆に**投げはヒットさせても繋がらない**：硬直（0.55）がヒットストップ（0.50）より
 * 長いので、投げた側が動けるようになった時点で相手はもう動ける。
 */
export const MOVES: Record<MoveId, MoveDef> = {
  jab: {
    power: 6,
    startupSec: 0.12,
    recoverySec: 0.22,
    hitstunSec: 0.36,
    guardstunSec: 0.14,
    rank: 1,
    kind: 'strike',
    guardable: true,
  },
  punch: {
    power: 14,
    startupSec: 0.26,
    recoverySec: 0.36,
    hitstunSec: 0.46,
    guardstunSec: 0.2,
    rank: 2,
    kind: 'strike',
    guardable: true,
  },
  /** 投げ（前方向＋Bで出る。全員が持つ）。ガードを崩す代わりに、暴れられると空振りする */
  throw: {
    power: 20,
    startupSec: 0.16,
    recoverySec: 0.55,
    whiffRecoverySec: 0.65,
    hitstunSec: 0.5,
    guardstunSec: 0,
    rank: 0,
    kind: 'throw',
    guardable: false,
  },
  /**
   * ショウリュウケン（★2 `ショウリュウケン`）。コマンドは**前→下→前下**＝桜井ノウハウが
   * 「スティックを前下→斜め前に入れる過程でガード不能な体勢を経由してから最大威力の技が
   * 出る＝リスクが大きい技はリターンも大きい」と分析した、まさにそのコマンド
   * （v1のコメントはこの分析を引いていたが、コマンド自体は無かった）。
   */
  shoryu: {
    power: 26,
    startupSec: 0.3,
    recoverySec: 0.55,
    hitstunSec: 0.6,
    guardstunSec: 0.3,
    rank: 3,
    kind: 'strike',
    guardable: true,
    command: 'dp',
  },
  /** ブキモチコミ（★3）。溜めコマンド＝**1秒後ろを入れて待つ**ことが代償の大振り */
  buki: {
    power: 34,
    startupSec: 0.38,
    recoverySec: 0.62,
    hitstunSec: 0.62,
    guardstunSec: 0.34,
    rank: 4,
    kind: 'strike',
    guardable: true,
    command: 'charge',
  },
  /** バットリュウケン（★4デュオ）。一回転＝いちばん難しく、いちばん強い（前提2つの報酬） */
  batto: {
    power: 46,
    startupSec: 0.42,
    recoverySec: 0.7,
    hitstunSec: 0.7,
    guardstunSec: 0.38,
    rank: 5,
    kind: 'strike',
    guardable: true,
    command: 'super',
  },
};

/**
 * 技の表示名（HUDの技表。全角8文字以内＝スキル名と同じ制限で、パネルの幅が
 * データで崩れない）。**スキル名とは別に持つ**：`武器持ち込み` というスキルが配る技は
 * 「武器を振り回す」動作で、札の名前をそのまま技名にすると何が起きるのか読めない。
 */
export const MOVE_NAME: Record<MoveId, string> = {
  jab: 'ジャブ',
  punch: 'パンチ',
  throw: '投げ',
  shoryu: '昇龍拳',
  buki: '武器振り回し',
  batto: 'バット龍拳',
};

export const BRAWL_MAX_HP = 100;
/** ガード成功時のダメージ倍率（80%軽減。完全無効化はしない＝ガード連打だけでは勝てない） */
export const GUARD_DAMAGE_MULTIPLIER = 0.2;

/**
 * コンボ補正（1ヒット目・2ヒット目…の倍率。以降は最後の値を使い続ける）。
 * **繋げるほど1発が軽くなる**ので、長いコンボは「決めきる」ためのものであって
 * 1コンボで試合が終わらない（桜井ノウハウ「リターンは適切な大きさに」）。
 */
export const COMBO_SCALING: readonly number[] = [1, 0.8, 0.6, 0.5];

function comboScale(hits: number): number {
  return COMBO_SCALING[Math.min(Math.max(hits, 1), COMBO_SCALING.length) - 1];
}

/**
 * その選手の乱闘での「装備」（フェーズF-26-1）。ローグライトのスキルはここに翻訳されて
 * から渡される（`skills.ts` の `brawlLoadoutFor`）ので、**このファイルはスキルの存在を
 * 一切知らない**＝乱闘は純粋な格闘エンジンのままでいられる（従来どおりスキル抜きで
 * テストが書ける）。
 *
 * 既定値（`DEFAULT_LOADOUT`）はスキルを持ち込む前と同じ強さになるようにしてある：
 * 体力100・威力等倍・**必殺技は出せない**（持てるのはジャブ・パンチ・投げの3つ）。
 * 必殺技を既定から外してあるのは、それがスキルの解禁対象だから（F-26-1）。
 * **投げは既定に含む**（v2）＝崩しの手段が全員にある、が三すくみの前提。
 */
export interface FighterLoadout {
  maxHp: number;
  /** 技の威力倍率 */
  powerScale: number;
  /** 出せる技。ここに無い技は `tryStartAttack` が無視する */
  moves: readonly MoveId[];
}

export const DEFAULT_LOADOUT: FighterLoadout = {
  maxHp: BRAWL_MAX_HP,
  powerScale: 1,
  moves: ['jab', 'punch', 'throw'],
};

export type BrawlLoadouts = Record<BrawlSide, FighterLoadout>;

export const DEFAULT_LOADOUTS: BrawlLoadouts = {
  batter: DEFAULT_LOADOUT,
  pitcher: DEFAULT_LOADOUT,
};

/**
 * 行動できるのは `idle` だけ（`recovery` はキャンセル可能なときだけ例外＝`canCancelInto`）。
 * `hitstun`/`guardstun` は**相手の技を受けて動けない時間**で、コンボが繋がるかどうかは
 * この残り時間と次の技の発生の比較で決まる。
 */
export type FighterPhase = 'idle' | 'startup' | 'recovery' | 'hitstun' | 'guardstun' | 'defeated';

export interface FighterState {
  hp: number;
  /** この選手の体力の最大値（装備で増える。HUDのゲージはこれを分母にする） */
  maxHp: number;
  phase: FighterPhase;
  /** idle/defeated 以外での残り秒数 */
  timer: number;
  /** startup 中に繰り出そうとしている技。startup 以外では null */
  pendingMove: MoveId | null;
  /** ガード中か（idle のときのみ有効。それ以外では常に false） */
  guarding: boolean;
  /** 直前に出した技（recovery 中のキャンセル可否と、見た目の姿勢に使う） */
  lastMove: MoveId | null;
  /** recovery 中にキャンセルできるか（**当てた技だけ**＝ガードされたら繋げられない） */
  cancelable: boolean;
  /** いま繋がっているコンボのヒット数（相手のヒットストップが切れたら0に戻る） */
  combo: number;
  /** 何を食らって動けないのか（見た目の出し分け用。判定には効かない） */
  hurtBy: MoveId | null;
}

export interface BrawlState {
  batter: FighterState;
  pitcher: FighterState;
  /**
   * 両者の装備（フェーズF-26-1）。**状態の側に持つ**のは、`stepBrawl` がダメージを
   * 出すときに攻撃側の威力倍率を要るため＝毎フレーム引数で渡し回すより、乱闘が
   * 始まった時点の装備が状態として固まっているほうが取り違えが起きない。
   */
  loadouts: BrawlLoadouts;
}

export interface HitResult {
  attacker: BrawlSide;
  defender: BrawlSide;
  move: MoveId;
  damage: number;
  /** ガードにより軽減されたか（投げはガード不能なので常に false） */
  guarded: boolean;
  /** 投げが空振りしたか（このときダメージは0で、攻撃側が長い隙を負う） */
  whiffed: boolean;
  /** 何ヒット目か（1＝単発。HUDのコンボ表示はこの値を出す） */
  combo: number;
}

export interface BrawlStepResult {
  state: BrawlState;
  /** このフレームで発生した命中（0〜2件。通常は0か1件） */
  hits: HitResult[];
}

export function createFighterState(loadout: FighterLoadout = DEFAULT_LOADOUT): FighterState {
  return {
    hp: loadout.maxHp,
    maxHp: loadout.maxHp,
    phase: 'idle',
    timer: 0,
    pendingMove: null,
    guarding: false,
    lastMove: null,
    cancelable: false,
    combo: 0,
    hurtBy: null,
  };
}

/** 装備を省略すると既定＝ジャブ・パンチ・投げだけの素の選手になる */
export function createBrawlState(loadouts: BrawlLoadouts = DEFAULT_LOADOUTS): BrawlState {
  return {
    batter: createFighterState(loadouts.batter),
    pitcher: createFighterState(loadouts.pitcher),
    loadouts,
  };
}

/** その装備で出せる技か（`ショウリュウケン` を持たない選手は `shoryu` が出ない） */
export function canUseMove(loadout: FighterLoadout, move: MoveId): boolean {
  return loadout.moves.includes(move);
}

/**
 * そのコマンドで出る技を装備の中から探す（`MOVES` の `command` が唯一の対応表）。
 * 持っていなければ null＝入力側は通常技へ落とす。
 */
export function moveForCommand(loadout: FighterLoadout, command: CommandId): MoveId | null {
  for (const move of loadout.moves) {
    if (MOVES[move].command === command) return move;
  }
  return null;
}

/** その装備で出せる必殺技（コマンドを持つ技）。HUDの技表はこれを並べる */
export function commandMoves(loadout: FighterLoadout): readonly MoveId[] {
  return loadout.moves.filter((move) => MOVES[move].command !== undefined);
}

export function canAct(fighter: FighterState): boolean {
  return fighter.phase === 'idle';
}

export function isDefeated(fighter: FighterState): boolean {
  return fighter.phase === 'defeated';
}

/**
 * 硬直をキャンセルして次の技へ繋げられるか（コンボ）。条件は3つ：
 * **当てた直後の recovery であること**・**格が上がること**・**打撃であること**
 * （投げはコンボの出口にも入口にもならない＝掴んだ相手を殴り続けられない）。
 */
export function canCancelInto(fighter: FighterState, move: MoveId): boolean {
  if (fighter.phase !== 'recovery' || !fighter.cancelable || !fighter.lastMove) return false;
  const next = MOVES[move];
  return next.kind === 'strike' && next.rank > MOVES[fighter.lastMove].rank;
}

/**
 * 技を繰り出す。**idle か、当てた技のキャンセル受付中**のみ通る（連打・格下への
 * キャンセルは不可）。**装備で解禁されていない技も無視される**（フェーズF-26-1）。
 */
export function tryStartAttack(
  fighter: FighterState,
  move: MoveId,
  loadout: FighterLoadout = DEFAULT_LOADOUT,
): FighterState {
  if (!canUseMove(loadout, move)) return fighter;
  if (!canAct(fighter) && !canCancelInto(fighter, move)) return fighter;
  return {
    ...fighter,
    phase: 'startup',
    timer: MOVES[move].startupSec,
    pendingMove: move,
    guarding: false,
    cancelable: false,
  };
}

/**
 * ガード状態を設定する。idle 以外では無視される（技の起こり・隙・のけぞりの間は
 * ガードに切り替えられない＝技を出したらその結果を引き受ける、という設計）。
 */
export function setGuarding(fighter: FighterState, guarding: boolean): FighterState {
  if (!canAct(fighter)) return fighter;
  return { ...fighter, guarding };
}

/** 投げが成立する相手か（**棒立ちかガード中だけ**＝技を出している相手には空振りする） */
export function isThrowable(defender: FighterState): boolean {
  return defender.phase === 'idle';
}

function computeDamage(
  move: MoveDef,
  defenderGuarding: boolean,
  powerScale: number,
  comboHits: number,
): { damage: number; guarded: boolean } {
  const guarded = defenderGuarding && move.guardable;
  const base = move.power * powerScale * comboScale(comboHits);
  return { damage: Math.round(guarded ? base * GUARD_DAMAGE_MULTIPLIER : base), guarded };
}

function stepFighterTimer(fighter: FighterState, dt: number): FighterState {
  if (fighter.phase === 'idle' || fighter.phase === 'defeated') return fighter;
  return { ...fighter, timer: fighter.timer - dt };
}

/** 硬直・のけぞりが明けたら idle へ戻す（キャンセル受付もそこで閉じる） */
function releaseIfDone(fighter: FighterState): FighterState {
  const stunned =
    fighter.phase === 'recovery' || fighter.phase === 'hitstun' || fighter.phase === 'guardstun';
  if (!stunned || fighter.timer > 0) return fighter;
  return { ...fighter, phase: 'idle', timer: 0, cancelable: false, hurtBy: null };
}

const OTHER_SIDE: Record<BrawlSide, BrawlSide> = { batter: 'pitcher', pitcher: 'batter' };

/**
 * 1フレーム進める（純粋関数。入力の state は変更しない）。
 *
 * 同一フレームで両者の技がちょうど完成した場合は打者側を先に解決する
 * （処理順による決定的なタイブレーク。守備プレーの「送球と走者の競争」と同様、
 * 現実的にはほぼ起こらない境界ケースだが、常に同じ結果になることを保証する）。
 */
export function stepBrawl(state: BrawlState, dt: number): BrawlStepResult {
  const fighters: Record<BrawlSide, FighterState> = {
    batter: stepFighterTimer(state.batter, dt),
    pitcher: stepFighterTimer(state.pitcher, dt),
  };
  const hits: HitResult[] = [];

  (['batter', 'pitcher'] as const).forEach((side) => {
    const attacker = fighters[side];
    if (attacker.phase !== 'startup' || attacker.timer > 0 || !attacker.pendingMove) return;

    const other = OTHER_SIDE[side];
    const defender = fighters[other];
    const move = attacker.pendingMove;
    const def = MOVES[move];

    // 投げは**相手の状態**で成否が決まる（棒立ち・ガード中だけ掴める）。空振りなら
    // ダメージも硬直も与えず、投げた側だけが長い隙を負う＝これが投げのリスク。
    const whiffed = def.kind === 'throw' && !isThrowable(defender);
    if (defender.phase === 'defeated' || whiffed) {
      const recovery = whiffed ? (def.whiffRecoverySec ?? def.recoverySec) : def.recoverySec;
      fighters[side] = {
        ...attacker,
        phase: 'recovery',
        timer: recovery,
        pendingMove: null,
        lastMove: move,
        cancelable: false,
        combo: 0,
      };
      if (whiffed) {
        hits.push({ attacker: side, defender: other, move, damage: 0, guarded: false, whiffed: true, combo: 0 });
      }
      return;
    }

    // ヒットストップ中の相手に当てたときだけコンボが伸びる（そうでなければ1発目に戻る）
    const chained = defender.phase === 'hitstun';
    const combo = chained ? attacker.combo + 1 : 1;
    const { damage, guarded } = computeDamage(
      def,
      defender.guarding,
      state.loadouts[side].powerScale,
      combo,
    );
    const hp = Math.max(0, defender.hp - damage);
    fighters[other] = {
      ...defender,
      hp,
      phase: hp <= 0 ? 'defeated' : guarded ? 'guardstun' : 'hitstun',
      timer: guarded ? def.guardstunSec : def.hitstunSec,
      pendingMove: null,
      guarding: false,
      cancelable: false,
      combo: 0,
      hurtBy: guarded ? null : move,
    };
    fighters[side] = {
      ...attacker,
      phase: 'recovery',
      timer: def.recoverySec,
      pendingMove: null,
      lastMove: move,
      // **ガードされたら繋げられない**＝守り切ればこちらの番が来る、がガードの価値
      cancelable: !guarded && def.kind === 'strike',
      combo: guarded ? 0 : combo,
    };
    hits.push({ attacker: side, defender: other, move, damage, guarded, whiffed: false, combo });
  });

  (['batter', 'pitcher'] as const).forEach((side) => {
    fighters[side] = releaseIfDone(fighters[side]);
  });
  // **コンボが続いているかは「相手がまだのけぞっているか」だけで決まる**（別のタイマーを
  // 持たない）。相手が動けるようになった時点でコンボは途切れており、次に当てた技は
  // 1ヒット目に戻る＝HUDの表示も補正も同じ1つの事実から導かれる。
  (['batter', 'pitcher'] as const).forEach((side) => {
    if (fighters[side].combo !== 0 && fighters[OTHER_SIDE[side]].phase !== 'hitstun') {
      fighters[side] = { ...fighters[side], combo: 0 };
    }
  });

  return {
    state: { batter: fighters.batter, pitcher: fighters.pitcher, loadouts: state.loadouts },
    hits,
  };
}

// ---- CPUの行動判断（フェーズJ-30。G-27の「固定スクリプトのまま」を置き換える） ----
//
// G-27のCPUは**3秒周期の固定スクリプト**で、距離も相手の状態も見なかった（ORIGINAL_PARITY.md
// に「読み合いの相手としては単調。3秒周期を覚えれば安全に潰せる」と記録したとおり）。
// v2で作った三すくみ（ガード／投げ／打撃）は**相手の状態に応じて手を変えて初めて成立する**
// ので、CPUがそれをしないと乱闘の駆け引きは人間の一人相撲になっていた。
//
// ここで足すのは**相手の状態を見て手を選ぶ決定的な規則**だけで、技も装備も人間と同じものを
// 同じ経路（`tryStartAttack`）で使う（⑧の「CPUも対等」）。乱数は使わない。

/** CPUの1フレームぶんの意思。`wait` は「何もしない（ガードも解く）」 */
export type CpuBrawlAction =
  | { kind: 'wait' }
  | { kind: 'guard' }
  | { kind: 'attack'; move: MoveId };

/**
 * CPUが反応するまでの時間 s。**相手の状態をこの秒数ぶん遅れて見る**ことで、
 * 「見てから完璧に受ける」CPUにしない。
 *
 * 桜井ノウハウ「人に反応できない動作をするとすっっごい理不尽感があります」の裏返しで、
 * **CPU側が人間に不可能な速さで反応するのも同じ理不尽さ**になる（F-26-2で銃に1.5秒の
 * 予兆を、F-26-3でバイクの自動帰塁を人間が押せる0.5秒に合わせたのと同じ扱い）。
 * 0.25秒は人間の単純反応時間（約0.2秒）よりわずかに遅い＝**人間が勝てる速さ**。
 *
 * これが効くのは「相手の起こりを見てガードする」判断で、ジャブの発生（0.12秒）は
 * この遅れより短いので**ジャブはCPUに見てから防がれない**＝差し込む価値が残る。
 */
export const CPU_BRAWL_REACTION_SEC = 0.25;

/** 装備の中でいちばん格の高い打撃（コンボの締めと、隙を見つけたときの一撃に使う） */
export function strongestStrike(loadout: FighterLoadout): MoveId {
  let best: MoveId = 'jab';
  for (const move of loadout.moves) {
    if (MOVES[move].kind !== 'strike') continue;
    if (MOVES[move].rank > MOVES[best].rank) best = move;
  }
  return best;
}

/**
 * CPUの行動を1つ決める（決定的・乱数不使用）。**`seen` には反応時間ぶん前の相手の状態**を
 * 渡すこと（`CPU_BRAWL_REACTION_SEC`）＝いまの状態を渡すと見てから完璧に受けるCPUになる。
 *
 * 規則は上から順に見るだけで、三すくみ（ガード／投げ／打撃）の各辺に1つずつ対応する：
 *
 * 1. **自分が動けない**（硬直・のけぞり）→ 何もしない。
 * 2. **技を当てた直後**（キャンセル受付中）→ 格上へ繋ぐ＝人間と同じコンボ。
 * 3. **相手が技を出そうとしている／出している** → ガード（打撃をガードで受ける辺）。
 * 4. **相手がガードしている** → 投げ（ガードを崩す唯一の手段。三すくみの要）。
 * 5. **相手が硬直・のけぞり中** → 装備でいちばん強い打撃を叩き込む（隙を突く辺）。
 * 6. **それ以外（にらみ合い）** → ジャブ。いちばん発生が速く、当たればコンボの起点になる。
 *
 * 5→2 が繋がるので、CPUも**隙を見つけたら格上の技で締める**動きになる。逆に人間側は
 * 「起こりを見せてガードを誘い、投げる」「ガードを見せて暴れを誘う」が効くようになる
 * ＝**規則が読めることがそのまま攻略法になる**（決定的である理由そのもの）。
 */
export function chooseCpuBrawlAction(
  self: FighterState,
  seen: FighterState,
  loadout: FighterLoadout,
): CpuBrawlAction {
  const finisher = strongestStrike(loadout);
  if (canCancelInto(self, finisher)) return { kind: 'attack', move: finisher };
  if (!canAct(self)) return { kind: 'wait' };
  if (seen.phase === 'startup') return { kind: 'guard' };
  if (seen.guarding) return { kind: 'attack', move: 'throw' };
  if (seen.phase === 'hitstun' || seen.phase === 'recovery') {
    return { kind: 'attack', move: finisher };
  }
  return { kind: 'attack', move: 'jab' };
}

/**
 * 決着した側（敗者）を返す。まだ決着していなければ null。
 * 万一同一フレームで両者が同時に沈んだ場合は、より深く削られた側
 * （HPがより低い方。同値なら打者）を敗者とする。
 */
export function brawlLoser(state: BrawlState): BrawlSide | null {
  const batterDown = isDefeated(state.batter);
  const pitcherDown = isDefeated(state.pitcher);
  if (batterDown && pitcherDown) {
    return state.batter.hp <= state.pitcher.hp ? 'batter' : 'pitcher';
  }
  if (batterDown) return 'batter';
  if (pitcherDown) return 'pitcher';
  return null;
}
