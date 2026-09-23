/**
 * 乱闘v2のコマンド入力判定（ストII準拠。フェーズG-27）。
 *
 * CLAUDE.md ③「乱闘v2：本格コマンド入力必殺技」の入力側だけを持つ純粋モジュールで、
 * 他の `core/*.ts` と同じく**乱数を使わず・Three.jsにも入力レイヤーにも依存しない**
 * （方向は `{x, y}` という形だけを受け取る＝`input/keyboard.ts` の `DirectionState` が
 * そのまま渡せるが、こちらはその型を知らない）。
 *
 * ## 方向は「テンキー表記」に畳んでから見る
 *
 * 格闘ゲームの慣習どおり **1..9 のテンキー表記**（5=ニュートラル）に変換してから判定する。
 * 変換のときに**その選手の向き（`facing`）で前後を入れ替える**ので、以降の判定表は
 * 「前＝6」の1通りだけで書ける＝**画面左の打者と画面右の投手で分岐を持たない**
 * （B-9で打席の左右を符号1つに畳んで「打者から見たX」で判定したのとまったく同じ整理）。
 *
 * ## 表示も同じ数列から起こす
 *
 * HUDに出す矢印（`commandNotation`）は判定に使う `COMMAND_MOTION` から作る。
 * **見えているコマンドと実際に効くコマンドが別々の数値から起きない**ようにするため
 * （C-14で描画と当たり判定を同じ `fenceAt` から起こしたのと同じ理由）。
 */

/** 方向入力（`input/keyboard.ts` の `DirectionState` がそのまま渡せる形） */
export interface Direction {
  x: number;
  y: number;
}

/**
 * その選手にとっての「前」がワールドXのどちら向きか（打者＝画面左で +1／投手＝ -1）。
 * これを掛けてから判定するので、**両者はまったく同じコマンド表を使う**。
 */
export type FightFacing = 1 | -1;

/** コマンドの種類。**難しいものほど強い技に割り当てる**（`core/brawl.ts` の `MOVES`） */
export type CommandId =
  /** 昇龍拳コマンド（前→下→前下）。桜井ノウハウが「ガード不能の体勢を経由してから
   *  最大威力の技が出る」と分析したもので、v1のコメントが引いていた当のコマンド */
  | 'dp'
  /** 溜めコマンド（後ろを1秒ためて前）。**待つことが代償**の技 */
  | 'charge'
  /** 一回転（前→下→後ろ→上）。いちばん難しく、いちばん強い技 */
  | 'super';

/**
 * コマンドの入力列（テンキー表記）。**判定と表示の両方がここから起きる**。
 * `charge` だけは「後ろをためる」時間が要るので、列の1つ目が溜める向きになる。
 */
export const COMMAND_MOTION: Record<CommandId, readonly number[]> = {
  dp: [6, 2, 3],
  charge: [4, 6],
  super: [6, 2, 4, 8],
};

/** 昇龍・一回転の受付時間（秒）。キーボードで斜めを作るには2キーを重ねる必要があるので、
 *  アーケードのレバーより気持ち長めに取ってある（実機で詰める前提の初期値）。 */
export const COMMAND_WINDOW_SEC: Record<CommandId, number> = {
  dp: 0.5,
  charge: 0.35,
  super: 0.9,
};

/** 溜めコマンドに要る保持時間（秒） */
export const CHARGE_SEC = 1;

/** 入力履歴に残す最大件数（これ以上は古いものから捨てる） */
const MAX_ENTRIES = 16;

interface DirEntry {
  /** テンキー表記（1..9。5=ニュートラル） */
  dir: number;
  /** その方向に入った時刻（`CommandBuffer.now` と同じ時計） */
  time: number;
}

/**
 * 入力履歴。**純粋な値**（`stepCommandBuffer` は新しいバッファを返す）なので、
 * テストでは秒とテンキーだけで任意の入力列を組める。
 */
export interface CommandBuffer {
  /** 方向が**変わった瞬間**だけ積む（押しっぱなしで履歴が埋まらない） */
  entries: readonly DirEntry[];
  /** いま入っている方向（テンキー表記） */
  dir: number;
  /** バッファ内の時計（秒）。`stepCommandBuffer` が dt を積む */
  now: number;
  /** 後ろを入れ続けている時間（溜め） */
  chargeSec: number;
  /** 溜めが完成した状態で前へ入れられる期限（`now` と比べる。0=未完成） */
  chargeReadyUntil: number;
  /** ここまでの入力は使用済み（コマンドが成立した時刻。二重発動を防ぐ） */
  consumedAt: number;
}

export function createCommandBuffer(): CommandBuffer {
  return { entries: [], dir: 5, now: 0, chargeSec: 0, chargeReadyUntil: 0, consumedAt: 0 };
}

/** 方向入力をテンキー表記へ（`facing` で前後を入れ替えるので、判定表は「前=6」の1通り） */
export function numpadOf(dir: Direction, facing: FightFacing): number {
  const forward = Math.sign(dir.x) * facing;
  const up = Math.sign(dir.y);
  return 5 + forward + 3 * up;
}

/** 後ろ寄り（溜めが乗る向き）／前寄り（溜めを開放できる向き） */
function isBack(dir: number): boolean {
  return dir === 1 || dir === 4 || dir === 7;
}

function isForward(dir: number): boolean {
  return dir === 3 || dir === 6 || dir === 9;
}

/**
 * 1フレーム進める（純粋関数）。**毎フレーム呼ぶ**：方向が変わったときだけ履歴に積み、
 * 溜め時間はここで数える。
 *
 * 溜めの受付を「後ろを離した瞬間」に立てているのが要点で、キーボードでは
 * **←を離して→を押すまでに必ずニュートラルを通る**（レバーと違って斜めに滑らせられない）。
 * 「後ろ→前」の直接遷移だけを見ていると、溜めコマンドがまず成立しない。
 */
export function stepCommandBuffer(
  buf: CommandBuffer,
  dir: Direction,
  facing: FightFacing,
  dt: number,
): CommandBuffer {
  const now = buf.now + dt;
  const next = numpadOf(dir, facing);

  let chargeSec = buf.chargeSec;
  let chargeReadyUntil = buf.chargeReadyUntil;
  if (isBack(next)) {
    chargeSec += dt;
  } else if (chargeSec >= CHARGE_SEC) {
    // ためきった状態で後ろを離した＝ここから `COMMAND_WINDOW_SEC.charge` の間だけ
    // 前入れで開放できる（離した瞬間に1度だけ立て、そのあと溜めは0に戻す）
    chargeReadyUntil = now + COMMAND_WINDOW_SEC.charge;
    chargeSec = 0;
  } else {
    chargeSec = 0;
  }

  const entries =
    next === buf.dir
      ? buf.entries
      : [...buf.entries, { dir: next, time: now }].slice(-MAX_ENTRIES);

  return { entries, dir: next, now, chargeSec, chargeReadyUntil, consumedAt: buf.consumedAt };
}

/** 窓の中に残っている（かつ未消費の）履歴 */
function recent(buf: CommandBuffer, windowSec: number): readonly DirEntry[] {
  const from = Math.max(buf.now - windowSec, buf.consumedAt);
  return buf.entries.filter((e) => e.time > from);
}

/** 並びの中に、その順で現れるか（間に別の方向が挟まってもよい＝取りこぼしを減らす） */
function hasSubsequence(dirs: readonly number[], motion: readonly number[]): boolean {
  let i = 0;
  for (const dir of dirs) {
    if (dir === motion[i]) i += 1;
    if (i === motion.length) return true;
  }
  return false;
}

/** 時計回り／反時計回りの隣（一回転の判定に使う。上=8 から見た並び） */
const CLOCKWISE: Record<number, number> = { 8: 6, 6: 2, 2: 4, 4: 8 };
const COUNTER: Record<number, number> = { 8: 4, 4: 2, 2: 6, 6: 8 };

/** 上下左右だけを取り出して連続する重複を潰す（斜めは通過点として無視する） */
function cardinals(dirs: readonly number[]): number[] {
  const out: number[] = [];
  for (const dir of dirs) {
    if (dir !== 2 && dir !== 4 && dir !== 6 && dir !== 8) continue;
    if (out[out.length - 1] !== dir) out.push(dir);
  }
  return out;
}

/** 一回転：上下左右を4つ続けて同じ向きに回っているか（どちら回りでもよい） */
function hasRotation(dirs: readonly number[]): boolean {
  const path = cardinals(dirs);
  for (let i = 0; i + 3 < path.length; i++) {
    const quad = path.slice(i, i + 4);
    const cw = quad.every((d, k) => k === 0 || CLOCKWISE[quad[k - 1]] === d);
    const ccw = quad.every((d, k) => k === 0 || COUNTER[quad[k - 1]] === d);
    if (cw || ccw) return true;
  }
  return false;
}

/**
 * いま成立しているコマンドを返す（Aボタンを押した瞬間に呼ぶ）。成立していなければ null。
 *
 * **難しいものから順に見る**のが要点：一回転の軌跡は昇龍拳の並び（前・下・前下）を
 * 内側に含みうるので、先に昇龍を見ると一回転が永久に出せなくなる。
 */
export function detectCommand(buf: CommandBuffer): CommandId | null {
  const superDirs = recent(buf, COMMAND_WINDOW_SEC.super).map((e) => e.dir);
  if (hasRotation(superDirs)) return 'super';

  const dpDirs = recent(buf, COMMAND_WINDOW_SEC.dp).map((e) => e.dir);
  if (dpDirs[dpDirs.length - 1] === 3 && hasSubsequence(dpDirs, COMMAND_MOTION.dp)) return 'dp';

  // 溜めは履歴ではなく「開放の期限」で見る（`consumeCommand` が期限を落とすので二重に出ない）
  if (buf.now <= buf.chargeReadyUntil && isForward(buf.dir)) return 'charge';
  return null;
}

/** コマンドが成立したあと呼ぶ。同じ入力で2回出ないように履歴を締める */
export function consumeCommand(buf: CommandBuffer): CommandBuffer {
  return { ...buf, consumedAt: buf.now, chargeReadyUntil: 0, chargeSec: 0 };
}

/** テンキー表記→矢印（`facing` が -1 の側は左右が鏡像になる＝**その人が押すキーの向き**） */
const ARROW: Record<number, string> = {
  1: '↙',
  2: '↓',
  3: '↘',
  4: '←',
  6: '→',
  7: '↖',
  8: '↑',
  9: '↗',
};

const MIRROR: Record<number, number> = { 1: 3, 2: 2, 3: 1, 4: 6, 6: 4, 7: 9, 8: 8, 9: 7 };

/**
 * HUDに出すコマンド表記（`COMMAND_MOTION` から起こす＝表示と判定が同じ数列）。
 * **その選手が実際に押す向き**で出すので、画面右の投手には左右が反転して出る
 * （「前」と書いて読み替えさせるより、押す矢印をそのまま見せるほうが案内として速い）。
 */
export function commandNotation(command: CommandId, facing: FightFacing): string {
  const arrows = COMMAND_MOTION[command]
    .map((dir) => ARROW[facing === 1 ? dir : MIRROR[dir]])
    .join('');
  // 溜めだけは「ためる」ことがコマンドの本体なので、1つ目の矢印に印を添える
  return command === 'charge' ? `${arrows[0]}溜め${arrows.slice(1)}` : arrows;
}
