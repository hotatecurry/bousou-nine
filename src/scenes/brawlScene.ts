/**
 * 乱闘（**v2**：コマンド必殺技・コンボ・投げ技。フェーズG-27）：2.5D横視点固定カメラ
 * （CLAUDE.md ③「乱闘システム」の描画方針。既存の3D選手モデルを横視点で映すだけで、
 * 専用2Dスプライトは使わない）。
 *
 * 対戦カードは常に「打者 vs 投手」の1vs1（死球を挟んだ乱闘という場面上、常にこの2人）。
 * **1P PLAY では打者側だけを人間が操作し、投手側は本ファイル内の簡易CPU（決定的な固定
 * スクリプト。他のcore/*と同じく乱数は使わない）が動かす。2P PLAY（フェーズD-20）では
 * 投手側も人間が操作する**＝そちらのCPUスクリプトは走らない。
 *
 * 判定・状態遷移は `core/brawl.ts`、コマンド入力の判定は `core/brawlCommand.ts` の
 * 純粋関数に委譲し、ここが持つのは「入力の読み取り→core呼び出し→見た目への反映」だけ
 * （PitchingController/BattingController/GunController と同じ設計）。
 */
import * as THREE from 'three';
import {
  type BrawlLoadouts,
  type BrawlSide,
  type BrawlState,
  type FighterState,
  type HitResult,
  type MoveId,
  CPU_BRAWL_REACTION_SEC,
  DEFAULT_LOADOUTS,
  MOVES,
  MOVE_NAME,
  brawlLoser,
  canUseMove,
  chooseCpuBrawlAction,
  commandMoves,
  createBrawlState,
  moveForCommand,
  setGuarding,
  stepBrawl,
  tryStartAttack,
} from '../core/brawl';
import {
  type CommandBuffer,
  type FightFacing,
  commandNotation,
  consumeCommand,
  createCommandBuffer,
  detectCommand,
  numpadOf,
  stepCommandBuffer,
} from '../core/brawlCommand';
import { type BrawlAttackStyle, createPlayer, setPlayerColor, setPlayerFacing, setPlayerPose } from '../entities/player';
import type { DirectionState, VirtualPad } from '../input/keyboard';

/**
 * 乱闘の舞台＝**本塁とマウンドの間（フィールドの上）**。カメラは本塁の側に立って外野を
 * 向く（でっかいモードと同じ向き）ので**画面右が +X**になり、打者（-X）が画面左・
 * 投手（+X）が画面右に立つ＝HUDの体力ゲージ（打者＝左／投手＝右）とも、コマンドの
 * 「前」（`BRAWL_FACING`）とも画面の左右が一致する。
 *
 * ブラッシュアップで舞台を移した：旧来は z=+320（本塁の裏、球場の外）に置き、カメラが
 * +Z を向いていたため**画面右が -X**＝打者が画面右・投手が画面左に映り、体力ゲージとも
 * 十字キーの「前」とも左右が逆になっていた（背景も何もない地面だった）。フィールドの
 * 上なら背後にマウンド・外野・スタンドが映り、死球のあとその場で始まる見え方にもなる。
 * でっかいモードの3人とちっちゃいモードの野手は乱闘中は隠れている（main.ts の refresh）。
 */
export const BRAWL_STAGE_Z = -9.5;
/** カメラから舞台の中心までの距離（2人が画面の左右半分ずつに収まる） */
const CAMERA_DISTANCE = 6.5;
const FIGHTER_HALF_GAP = 2.2;
const LUNGE_DISTANCE = 0.9;
/** 食らったときに押し下がる距離（横視点なので、当たったことが位置でも読める） */
const HURT_PUSHBACK = 0.35;
const HIT_FLASH_SEC = 0.15;
/** 決着後、でっかいモードへカット復帰するまでの見せ時間（フィールドプレーの結果表示と同じ考え方） */
const RESULT_PAUSE_SEC = 0.8;
/** KOで倒れ切るまでの時間（`RESULT_PAUSE_SEC` の中で倒れ切る） */
const KO_FALL_SEC = 0.45;
const MAX_DT = 0.1;

const BATTER_COLOR = 0xcc3333;
const PITCHER_COLOR = 0x2255cc;
const GUARD_COLOR = 0x88aadd;
const DEFEATED_COLOR = 0x555555;
const FLASH_COLOR = 0xffffff;

/**
 * どちらを向いて立っているか（画面左の打者は右向き＝前が +X）。**立ち位置と同じ
 * `FIGHTER_HALF_GAP` の符号から起こす**ので、間隔を変えても背中合わせにならない。
 * コマンド判定（`core/brawlCommand.ts`）にもこの値をそのまま渡す＝**画面上の「前」と
 * コマンドの「前」が必ず一致する**。
 */
export const BRAWL_FACING: Record<BrawlSide, FightFacing> = { batter: 1, pitcher: -1 };

/** 技の見た目（`core` の技IDを `player.ts` に持ち込まないための対応表。E-25-(c)の一方通行を保つ） */
const MOVE_POSE: Record<MoveId, BrawlAttackStyle> = {
  jab: 'straight',
  punch: 'straight',
  throw: 'grab',
  shoryu: 'upper',
  buki: 'swing',
  batto: 'swing',
};

export function createBrawlCamera(aspect: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(42, aspect, 0.1, 600);
  camera.position.set(0, 1.7, BRAWL_STAGE_Z + CAMERA_DISTANCE);
  camera.lookAt(0, 1.1, BRAWL_STAGE_Z);
  return camera;
}

export interface BrawlFighterMeshes {
  batter: THREE.Group;
  pitcher: THREE.Group;
}

/** 乱闘専用の選手モデル（でっかいモードの投手/打者とは別インスタンス。
 *  ちっちゃいモードの野手/走者と同じく、常時シーンに置いて表示/非表示だけ切り替える）。 */
export function createBrawlFighters(): BrawlFighterMeshes {
  const batter = createPlayer(BATTER_COLOR);
  const pitcher = createPlayer(PITCHER_COLOR);
  batter.position.set(-FIGHTER_HALF_GAP, 0, BRAWL_STAGE_Z);
  pitcher.position.set(FIGHTER_HALF_GAP, 0, BRAWL_STAGE_Z);
  // 横視点固定カメラ（CLAUDE.md ③）なので、2人は画面の左右で**向かい合う**必要がある。
  setPlayerFacing(batter, Math.PI / 2);
  setPlayerFacing(pitcher, -Math.PI / 2);
  batter.visible = false;
  pitcher.visible = false;
  return { batter, pitcher };
}

/**
 * コマンドが成立していなければ出る通常技（十字キー＝選択、A＝実行の既存パターン）。
 * **方向を入れていればパンチ（強）・ニュートラルならジャブ（弱）**。
 * v1の「上＝必殺技」は無くなった＝必殺技はコマンドでしか出ない（v2の要点）。
 */
function normalMove(dir: DirectionState): MoveId {
  return dir.x !== 0 || dir.y !== 0 ? 'punch' : 'jab';
}

/** 前を入れているか（投げの成立条件。ガードは「前を入れていないときのB」） */
function isForwardHeld(dir: DirectionState, facing: FightFacing): boolean {
  const numpad = numpadOf(dir, facing);
  return numpad === 3 || numpad === 6 || numpad === 9;
}

interface FighterVisual {
  mesh: THREE.Group;
  baseX: number;
  facing: 1 | -1;
  baseColor: number;
  flashTimer: number;
  koElapsed: number;
}

function createVisual(mesh: THREE.Group, baseX: number, facing: 1 | -1, baseColor: number): FighterVisual {
  return { mesh, baseX, facing, baseColor, flashTimer: 0, koElapsed: 0 };
}

/**
 * 技の進行度。**前半（0〜0.5）が起こり・後半（0.5〜1）が硬直**なので、
 * `t=0.5`＝当たる瞬間に必ず伸び切る（`player.ts` の `brawlAttack` の約束）。
 *
 * 投げが空振りしたときは硬直が長い（`whiffRecoverySec`）ので、はじめのうちは 0.5 の
 * まま＝**掴み損ねた形で固まる**。隙の大きさがそのまま見た目に出る。
 */
function attackProgress(f: FighterState): number | null {
  if (f.phase === 'startup' && f.pendingMove) {
    const def = MOVES[f.pendingMove];
    return 0.5 * (1 - Math.max(0, f.timer) / def.startupSec);
  }
  if (f.phase === 'recovery' && f.lastMove) {
    const def = MOVES[f.lastMove];
    const left = Math.min(1, Math.max(0, f.timer) / def.recoverySec);
    return 0.5 + 0.5 * (1 - left);
  }
  return null;
}

/** のけぞり・ガード硬直の進行度（0=食らった瞬間〜1=立ち直る） */
function stunProgress(f: FighterState): number {
  const def = f.hurtBy ? MOVES[f.hurtBy] : null;
  const total = def ? (f.phase === 'guardstun' ? def.guardstunSec : def.hitstunSec) : 0.3;
  return total <= 0 ? 1 : 1 - Math.min(1, Math.max(0, f.timer) / total);
}

function applyFighterVisual(v: FighterVisual, f: FighterState, dt: number): void {
  const attack = attackProgress(f);
  let offset = 0;
  if (attack !== null) offset = LUNGE_DISTANCE * Math.sin(Math.PI * attack);
  else if (f.phase === 'hitstun') offset = -HURT_PUSHBACK * (1 - stunProgress(f));
  v.mesh.position.x = v.baseX + offset * v.facing;

  // 姿勢は状態からの導出だけで決める（見た目用のタイマーを別に持たない＝E-25-(e)の約束）
  if (f.phase === 'defeated') {
    v.koElapsed += dt;
    // 倒れて起き上がらない（`fallen` は t=0.18 で倒れ切り、0.78 から起き上がる）
    setPlayerPose(v.mesh, { kind: 'fallen', t: Math.min(0.5, (v.koElapsed / KO_FALL_SEC) * 0.18), forward: false });
  } else if (attack !== null) {
    const move = f.phase === 'startup' ? f.pendingMove : f.lastMove;
    setPlayerPose(v.mesh, { kind: 'brawlAttack', style: MOVE_POSE[move ?? 'jab'], t: attack });
  } else if (f.phase === 'hitstun') {
    const t = stunProgress(f);
    // **投げられたときだけ倒される**（同じ「食らった」でも見た目で区別が付く）
    if (f.hurtBy === 'throw') setPlayerPose(v.mesh, { kind: 'fallen', t: 0.18 + t * 0.6, forward: true });
    else setPlayerPose(v.mesh, { kind: 'brawlHurt', t });
  } else {
    setPlayerPose(v.mesh, { kind: 'fight', guard: f.guarding || f.phase === 'guardstun' });
  }

  if (v.flashTimer > 0) {
    v.flashTimer -= dt;
    setPlayerColor(v.mesh, FLASH_COLOR);
  } else if (f.phase === 'defeated') {
    setPlayerColor(v.mesh, DEFEATED_COLOR);
  } else if (f.guarding || f.phase === 'guardstun') {
    setPlayerColor(v.mesh, GUARD_COLOR);
  } else {
    setPlayerColor(v.mesh, v.baseColor);
  }
}

// ---- CPU：相手の状態を見て手を選ぶ決定的な規則（乱数不使用。フェーズJ-30） ----
//
// G-27までは**3秒周期の固定スクリプト**で、相手が何をしていようと同じ順に技を振っていた
// （ORIGINAL_PARITY.md に「3秒周期を覚えれば安全に潰せる」と記録した状態）。判断そのものは
// `core/brawl.ts` の `chooseCpuBrawlAction`（純粋関数・テスト対象）へ移し、ここが持つのは
// **「いつの相手を見せるか」＝反応の遅れ**だけになった。
//
// **相手の状態は `CPU_BRAWL_REACTION_SEC` ぶん遅れて渡す**（下の履歴バッファ）。いまの状態を
// 渡すと「見てから必ずガードする」CPUになり人間側に勝ち筋が無くなる（桜井ノウハウ
// 「人に反応できない動作をするとすっっごい理不尽感がある」の裏返し＝**CPUが人間に不可能な
// 速さで反応するのも同じ理不尽さ**になる）。

/** 反応の遅れを作る履歴バッファ（時刻つきスナップショット。古いものから捨てる） */
interface SeenHistory {
  clock: number;
  frames: Array<{ at: number; state: FighterState }>;
}

function createSeenHistory(): SeenHistory {
  return { clock: 0, frames: [] };
}

/**
 * 相手の状態を1フレーム記録し、**反応時間ぶん前の状態**を返す。
 * 履歴が反応時間ぶん溜まるまで（＝乱闘が始まった直後）は最も古い記録＝開始時の構えを返す
 * ので、開始と同時に読み合いが始まることはない。
 */
function observe(history: SeenHistory, current: FighterState, dt: number): FighterState {
  history.clock += dt;
  history.frames.push({ at: history.clock, state: current });
  const deadline = history.clock - CPU_BRAWL_REACTION_SEC;
  // 期限より古いものは、直前の1つだけ残して捨てる（その1つが「いま見えている状態」）
  while (history.frames.length > 1 && history.frames[1].at <= deadline) {
    history.frames.shift();
  }
  return history.frames[0].state;
}

/** 乱闘の2つの側（フェーズD-20で「側ごとに人間かCPUか」を見るようになったため） */
const BRAWL_SIDES: readonly BrawlSide[] = ['batter', 'pitcher'];

/** HUDへ出す1人ぶんの状態（体力ゲージとコンボ表示。真実は `BrawlState` の側） */
export interface BrawlFighterView {
  hp: number;
  maxHp: number;
  /** いま繋がっているコンボのヒット数（0=繋がっていない） */
  combo: number;
}

/** HUDの技表に出す1行（表示も判定も `MOVES` から起きる＝食い違わない） */
export interface BrawlMoveHint {
  name: string;
  notation: string;
}

export interface BrawlController {
  /**
   * 乱闘開始時（モード遷移で brawl に入った瞬間）に呼ぶ。HPをリセットし表示する。
   * 装備（フェーズF-26-1）は**この瞬間の両者のスキルから組む**：乱闘の最中に代打・継投は
   * 起きないので、開始時に固めてしまえば途中で食い違わない。省略すれば従来どおり。
   */
  enter(loadouts?: BrawlLoadouts): void;
  /** 乱闘終了時に呼ぶ。非表示に戻す */
  exit(): void;
  /** 毎フレーム呼ぶ。active は「乱闘モード中」の間だけ true にする */
  update(dt: number, active: boolean): void;
  /**
   * Aボタン押下で呼ぶ。**コマンドが成立していればその必殺技**、していなければ
   * 方向で選ばれた通常技（ニュートラル＝ジャブ／方向あり＝パンチ）を繰り出す。
   * **どちら側を操作している人が押したか**を渡す（フェーズD-20。省略時は打者側）。
   */
  attack(side?: BrawlSide): void;
  /**
   * Bボタン押下で呼ぶ。**前を入れていれば投げ**（ガードを崩す唯一の手段）。
   * 前を入れていなければ何もしない＝そのままガード（押しっぱなしで `update` が拾う）。
   */
  grab(side?: BrawlSide): void;
  /** HUD用の状態（体力・コンボ）。**最大値も返す**（装備で増えるので分母が固定でない） */
  view(): Record<BrawlSide, BrawlFighterView>;
  /** HUDの技表。その選手が持っている必殺技と、**その人が押す向き**のコマンド表記 */
  moveHints(side: BrawlSide): readonly BrawlMoveHint[];
}

export function createBrawlController(opts: {
  batter: THREE.Group;
  pitcher: THREE.Group;
  /**
   * 側ごとの入力（フェーズD-20）。**その側がCPUなら `NULL_PAD` が渡る**ので、
   * ガード（Bの押しっぱなし）やコマンド入力に人間のキーが漏れ込まない。
   */
  pads: Record<BrawlSide, VirtualPad>;
  /**
   * その側を人間が操作しているか（フェーズD-20）。**false の側だけ CPUスクリプトが動く**
   * ＝2P PLAY では両側 true になり、スクリプトはどちらにも走らない。
   */
  isHuman: (side: BrawlSide) => boolean;
  /** 技が命中するたびに呼ぶ（演出フック。ヒットフラッシュのトリガーに使う） */
  onHit?: (hit: HitResult) => void;
  /** 決着が確定し、見せ時間が経過した後に一度だけ呼ぶ */
  onResolved: (loser: BrawlSide) => void;
}): BrawlController {
  const { batter, pitcher, pads, isHuman, onHit, onResolved } = opts;

  const batterVisual = createVisual(batter, -FIGHTER_HALF_GAP, 1, BATTER_COLOR);
  const pitcherVisual = createVisual(pitcher, FIGHTER_HALF_GAP, -1, PITCHER_COLOR);
  const visualOf = (side: BrawlSide) => (side === 'batter' ? batterVisual : pitcherVisual);

  let state: BrawlState = createBrawlState();
  // コマンド入力の履歴は側ごとに持つ（**前後は `BRAWL_FACING` で入れ替わる**ので、
  // 2P PLAY でも両者が自分から見た同じコマンドを入力できる）
  let buffers: Record<BrawlSide, CommandBuffer> = {
    batter: createCommandBuffer(),
    pitcher: createCommandBuffer(),
  };
  let resolvedPending: BrawlSide | null = null;
  let pauseTimer = 0;
  // CPUが見ている相手の履歴も**側ごとに持つ**。1つを共有すると、両側がCPUになったとき
  // （D-21 WATCH でそうなる）に片方の見え方がもう片方に混ざる。
  let cpuSeen: Record<BrawlSide, SeenHistory> = {
    batter: createSeenHistory(),
    pitcher: createSeenHistory(),
  };

  function triggerFlash(side: BrawlSide): void {
    visualOf(side).flashTimer = HIT_FLASH_SEC;
  }

  /**
   * CPU側（`isHuman` が false の側）を1フレーム進める。**どちらの側でも動く**ように
   * してある（フェーズD-20）：2P PLAY では呼ばれないが、側を決め打ちにしておくと
   * 「投手側は必ずCPU」という前提がここに残り、人間の投手が固まったように見える。
   *
   * やることは3つだけ：**遅らせた相手の状態を作る**（observe）→ **規則で手を決める**
   * （`chooseCpuBrawlAction`）→ **人間とまったく同じ経路で出す**（`setGuarding` /
   * `tryStartAttack`）。技が出せるかどうか（装備・硬直・キャンセル可否）の判断は
   * すべて `tryStartAttack` 側に任せてあるので、**CPUだけが出せる技は1つも無い**。
   */
  function stepCpu(dt: number, side: BrawlSide): void {
    const foe: BrawlSide = side === 'batter' ? 'pitcher' : 'batter';
    const seen = observe(cpuSeen[side], state[foe], dt);
    const action = chooseCpuBrawlAction(state[side], seen, state.loadouts[side]);
    // ガードは「その意思のあいだだけ」＝攻撃を選んだフレームでは必ず外れる
    // （人間が前入れBで投げに行くとガードが外れるのと同じ＝崩しに行く瞬間は無防備）。
    state = { ...state, [side]: setGuarding(state[side], action.kind === 'guard') };
    if (action.kind !== 'attack') return;
    state = { ...state, [side]: tryStartAttack(state[side], action.move, state.loadouts[side]) };
  }

  /** 押した人の入力から技を決めて繰り出す（人間側のみ。CPUのぶんはここを通らない） */
  function startHumanAttack(side: BrawlSide, move: MoveId): void {
    state = { ...state, [side]: tryStartAttack(state[side], move, state.loadouts[side]) };
  }

  return {
    enter(loadouts: BrawlLoadouts = DEFAULT_LOADOUTS) {
      state = createBrawlState(loadouts);
      buffers = { batter: createCommandBuffer(), pitcher: createCommandBuffer() };
      resolvedPending = null;
      pauseTimer = 0;
      cpuSeen = { batter: createSeenHistory(), pitcher: createSeenHistory() };
      batter.visible = true;
      pitcher.visible = true;
      for (const side of BRAWL_SIDES) {
        const v = visualOf(side);
        v.flashTimer = 0;
        v.koElapsed = 0;
      }
      applyFighterVisual(batterVisual, state.batter, 0);
      applyFighterVisual(pitcherVisual, state.pitcher, 0);
    },

    exit() {
      batter.visible = false;
      pitcher.visible = false;
    },

    update(dt, active) {
      if (!active) return;
      const d = Math.min(dt, MAX_DT);

      if (resolvedPending) {
        pauseTimer -= d;
        // 決着後も倒れる動きは進める（KOの瞬間に画が止まらない）
        applyFighterVisual(batterVisual, state.batter, d);
        applyFighterVisual(pitcherVisual, state.pitcher, d);
        if (pauseTimer <= 0) {
          const loser = resolvedPending;
          resolvedPending = null;
          onResolved(loser);
        }
        return;
      }

      for (const side of BRAWL_SIDES) {
        if (isHuman(side)) {
          const dir = pads[side].direction();
          // コマンドの履歴は**押していない間も**積む（溜めは時間そのものが入力なので）
          buffers[side] = stepCommandBuffer(buffers[side], dir, BRAWL_FACING[side], d);
          // ガードは「前を入れていないときのB」＝**前入れBは投げ**（ガードが外れる）。
          // 崩しに行くとその瞬間だけ無防備、というリスクが操作にそのまま出る。
          const guarding = pads[side].isPressed('b') && !isForwardHeld(dir, BRAWL_FACING[side]);
          state = { ...state, [side]: setGuarding(state[side], guarding) };
        } else {
          stepCpu(d, side);
        }
      }

      const { state: next, hits } = stepBrawl(state, d);
      state = next;
      for (const hit of hits) {
        if (!hit.whiffed) triggerFlash(hit.defender);
        onHit?.(hit);
      }

      applyFighterVisual(batterVisual, state.batter, d);
      applyFighterVisual(pitcherVisual, state.pitcher, d);

      const loser = brawlLoser(state);
      if (loser) {
        resolvedPending = loser;
        pauseTimer = RESULT_PAUSE_SEC;
      }
    },

    attack(side: BrawlSide = 'batter') {
      if (resolvedPending) return;
      // CPU側のぶんをここから動かすことはない（呼び出し側が人間の押下だけを通す）
      if (!isHuman(side)) return;
      const loadout = state.loadouts[side];
      const command = detectCommand(buffers[side]);
      const special = command ? moveForCommand(loadout, command) : null;
      if (special) {
        // 成立したコマンドは消費する（同じ入力で2回出ない）
        buffers[side] = consumeCommand(buffers[side]);
        startHumanAttack(side, special);
        return;
      }
      startHumanAttack(side, normalMove(pads[side].direction()));
    },

    grab(side: BrawlSide = 'batter') {
      if (resolvedPending) return;
      if (!isHuman(side)) return;
      if (!isForwardHeld(pads[side].direction(), BRAWL_FACING[side])) return;
      if (!canUseMove(state.loadouts[side], 'throw')) return;
      startHumanAttack(side, 'throw');
    },

    view: () => ({
      batter: { hp: state.batter.hp, maxHp: state.batter.maxHp, combo: state.batter.combo },
      pitcher: { hp: state.pitcher.hp, maxHp: state.pitcher.maxHp, combo: state.pitcher.combo },
    }),

    moveHints: (side) =>
      commandMoves(state.loadouts[side]).map((move) => ({
        name: MOVE_NAME[move],
        notation: commandNotation(MOVES[move].command!, BRAWL_FACING[side]),
      })),
  };
}
