/**
 * 乱闘v3のコマンド入力（**ストII準拠**。フェーズXX-72）。
 *
 * 他の `core/*.ts` と同じく**乱数を使わず・Three.jsにも入力レイヤーにも依存しない**純粋な
 * モジュール。v2（G-27）は秒の時計で3種のコマンドだけを見ていたが、v3は**1フレーム＝1/60秒の
 * 固定の時計**で、ストIIのコマンドをひととおり判定する（波動＝↓↘→／竜巻＝↓↙←／
 * 昇龍＝→↓↘／溜め（後ろ→前・下→上）／一回転／連打／ダッシュ＝→→・←←）。
 *
 * ## 方向は「テンキー表記」に畳んでから見る（v2から変えていない）
 *
 * 格闘ゲームの慣習どおり **1..9 のテンキー表記**（5=ニュートラル）に変換してから判定する。
 * 変換のときに**その選手の向き（`facing`）で前後を入れ替える**ので、判定表は「前＝6」の
 * 1通りだけで書ける＝**画面左の打者と画面右の投手で分岐を持たない**。
 *
 * ## 表示も同じ数列から起こす
 *
 * HUDに出す矢印（`motionNotation`）は判定に使う `MOTION_SEQUENCE` から作る＝
 * **見えているコマンドと実際に効くコマンドが別々の数値から起きない**。
 */

/** 1フレームぶんの入力（パッドの状態そのもの。向きは知らない） */
export interface FrameInput {
  /** 右が +1（画面の右＝ワールドの +X） */
  x: -1 | 0 | 1;
  /** 上が +1 */
  y: -1 | 0 | 1;
  /** パンチ（1P＝K／2P＝テンキー2）を押しているか */
  p: boolean;
  /** キック（1P＝J／2P＝テンキー1） */
  k: boolean;
  /** 超必殺（1P＝G／2P＝テンキー3） */
  s: boolean;
}

export const NEUTRAL_INPUT: FrameInput = { x: 0, y: 0, p: false, k: false, s: false };

/** その選手にとっての「前」がワールドXのどちら向きか */
export type FightFacing = 1 | -1;

/** テンキー表記（5＝ニュートラル、6＝前、4＝後ろ、2＝下、8＝上） */
export type Numpad = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/** 方向入力をテンキー表記へ（`facing` で前後を入れ替える） */
export function numpadOf(x: number, y: number, facing: FightFacing): Numpad {
  const forward = Math.sign(x) * facing;
  const up = Math.sign(y);
  return (5 + forward + 3 * up) as Numpad;
}

export function isBackDir(d: Numpad): boolean {
  return d === 1 || d === 4 || d === 7;
}
export function isForwardDir(d: Numpad): boolean {
  return d === 3 || d === 6 || d === 9;
}
export function isDownDir(d: Numpad): boolean {
  return d === 1 || d === 2 || d === 3;
}
export function isUpDir(d: Numpad): boolean {
  return d === 7 || d === 8 || d === 9;
}

/**
 * コマンドの種類。**難しいものほど強い技に割り当てる**（`core/brawl.ts` の技表）。
 */
export type MotionId =
  /** 波動（↓↘→）。飛び道具 */
  | 'qcf'
  /** 竜巻（↓↙←） */
  | 'qcb'
  /** 昇龍（→↓↘）。桜井ノウハウ「ガード不能の体勢を経由してから最大威力の技が出る」 */
  | 'dp'
  /** 後ろ溜め→前（1秒ためる＝待つことが代償） */
  | 'chargeBF'
  /** 下溜め→上 */
  | 'chargeDU'
  /** 一回転（上下左右を順に）。いちばん難しい */
  | 'spin'
  /** 同じボタンの連打（百裂） */
  | 'mash'
  /** ダッシュ（→→）・バックステップ（←←） */
  | 'dashF'
  | 'dashB';

/** 判定と表示の両方が使う入力列（溜めは1つ目が溜める向き） */
export const MOTION_SEQUENCE: Record<MotionId, readonly Numpad[]> = {
  qcf: [2, 3, 6],
  qcb: [2, 1, 4],
  dp: [6, 2, 3],
  chargeBF: [4, 6],
  chargeDU: [2, 8],
  spin: [6, 2, 4, 8],
  mash: [],
  dashF: [6, 5, 6],
  dashB: [4, 5, 4],
};

/**
 * コマンドの受付（フレーム）。**キーボードで斜めを作るには2キーを重ねる必要がある**ので、
 * アーケードのレバーより気持ち長めに取ってある。
 */
export const MOTION_WINDOW: Record<MotionId, number> = {
  qcf: 22,
  qcb: 22,
  dp: 24,
  chargeBF: 10,
  chargeDU: 10,
  spin: 40,
  mash: 30,
  dashF: 14,
  dashB: 14,
};

/** 溜めに要るフレーム（ストIIの溜め技と同じくおよそ0.7秒） */
export const CHARGE_FRAMES = 40;
/** 連打で出る技に要る押した回数（受付の窓の中で） */
export const MASH_PRESSES = 4;

const MAX_DIRS = 24;
const MAX_PRESSES = 8;

/** 入力の履歴（純粋な値。`stepInput` が新しい履歴を返す） */
export interface InputHistory {
  /** これまでに進めたフレーム数（履歴の時計） */
  frame: number;
  /** 方向が**変わった瞬間**だけ積む（押しっぱなしで履歴が埋まらない） */
  dirs: ReadonlyArray<{ dir: Numpad; at: number }>;
  /** いまの方向 */
  dir: Numpad;
  /** 前のフレームで押していたボタン（押した瞬間を取り出すため） */
  held: { p: boolean; k: boolean; s: boolean };
  /** パンチ・キックを押したフレーム（連打の判定に使う） */
  pPresses: readonly number[];
  kPresses: readonly number[];
  /** 後ろ・下を入れ続けているフレーム数（溜め） */
  chargeBack: number;
  chargeDown: number;
  /** 溜め切った状態で離したフレーム（ここから `MOTION_WINDOW` の間だけ開放できる。-1=無し） */
  backReleasedAt: number;
  downReleasedAt: number;
  /** ここまでの入力は使用済み（コマンドが成立したフレーム。二重発動を防ぐ） */
  consumedAt: number;
}

export function createInputHistory(): InputHistory {
  return {
    frame: 0,
    dirs: [],
    dir: 5,
    held: { p: false, k: false, s: false },
    pPresses: [],
    kPresses: [],
    chargeBack: 0,
    chargeDown: 0,
    backReleasedAt: -1,
    downReleasedAt: -1,
    consumedAt: -1,
  };
}

/** そのフレームで**押した瞬間**のボタン */
export interface Presses {
  p: boolean;
  k: boolean;
  s: boolean;
}

/**
 * 1フレーム進める（純粋関数）。**毎フレーム呼ぶ**：方向が変わったときだけ履歴に積み、
 * 溜めの時間はここで数える。
 *
 * 溜めの受付を「後ろを離した瞬間」に立てているのが要点で、キーボードでは
 * **←を離して→を押すまでにニュートラルを通る**ことがある（レバーのように斜めへ滑らせ
 * られない）。「後ろ→前」の直接の遷移だけを見ていると、溜め技がまず出ない。
 */
export function stepInput(
  h: InputHistory,
  input: FrameInput,
  facing: FightFacing,
): { history: InputHistory; pressed: Presses } {
  const frame = h.frame + 1;
  const dir = numpadOf(input.x, input.y, facing);
  const pressed: Presses = {
    p: input.p && !h.held.p,
    k: input.k && !h.held.k,
    s: input.s && !h.held.s,
  };

  let chargeBack = h.chargeBack;
  let backReleasedAt = h.backReleasedAt;
  if (isBackDir(dir)) {
    chargeBack += 1;
  } else {
    if (chargeBack >= CHARGE_FRAMES) backReleasedAt = frame;
    chargeBack = 0;
  }
  let chargeDown = h.chargeDown;
  let downReleasedAt = h.downReleasedAt;
  if (isDownDir(dir)) {
    chargeDown += 1;
  } else {
    if (chargeDown >= CHARGE_FRAMES) downReleasedAt = frame;
    chargeDown = 0;
  }

  const dirs = dir === h.dir ? h.dirs : [...h.dirs, { dir, at: frame }].slice(-MAX_DIRS);
  const pPresses = pressed.p ? [...h.pPresses, frame].slice(-MAX_PRESSES) : h.pPresses;
  const kPresses = pressed.k ? [...h.kPresses, frame].slice(-MAX_PRESSES) : h.kPresses;

  return {
    history: {
      frame,
      dirs,
      dir,
      held: { p: input.p, k: input.k, s: input.s },
      pPresses,
      kPresses,
      chargeBack,
      chargeDown,
      backReleasedAt,
      downReleasedAt,
      consumedAt: h.consumedAt,
    },
    pressed,
  };
}

/**
 * 窓の中に残っている（かつ未消費の）方向の履歴。いまの方向も末尾に含む。
 * **窓が開いた時点で押しっぱなしだった方向も先頭に含める**＝↓を長く押したままでも、
 * そこから↘→と入れれば波動になる（ストIIと同じ。↓に入った瞬間が古くても、
 * ↓は窓の中でずっと入っていた）。使用済みより前の方向は含めない（同じ入力で2回出ない）。
 */
function recentEntries(h: InputHistory, window: number): { dir: Numpad; at: number }[] {
  const from = Math.max(h.frame - window, h.consumedAt);
  const out = h.dirs.filter((e) => e.at > from).map((e) => ({ dir: e.dir, at: e.at }));
  const before = h.dirs.filter((e) => e.at <= from);
  const held = before[before.length - 1];
  if (held && h.frame - window >= h.consumedAt && held.at > h.consumedAt) out.unshift({ dir: held.dir, at: from });
  if (out.length === 0 || out[out.length - 1].dir !== h.dir) out.push({ dir: h.dir, at: h.frame });
  return out;
}

function recentDirs(h: InputHistory, window: number): Numpad[] {
  return recentEntries(h, window).map((e) => e.dir);
}

/**
 * 最後の方向を離してからボタンを押すまでの猶予（フレーム）。**キーボードでは方向キーを
 * 離した直後にボタンを押すのが自然**（↓↘→ と叩いてから K）なので、最後の方向が
 * 「いま入っている」ことまでは求めない（ストIIのレバーの入力受付と同じ考え方）。
 */
export const MOTION_TAIL = 8;

/**
 * 「最後の方向」が条件を満たすコマンドの判定。**猶予の中で最後に入っていた、条件を
 * 満たす方向**までの並びに、コマンドが順に現れるかを見る。
 */
function endsWithMotion(
  h: InputHistory,
  window: number,
  seq: readonly Numpad[],
  isEnd: (d: Numpad) => boolean,
): boolean {
  const entries = recentEntries(h, window);
  for (let i = entries.length - 1; i >= 0; i--) {
    // その方向を離したフレーム（次の入力が入ったフレーム）。いま入っているなら今
    const releasedAt = i === entries.length - 1 ? h.frame : entries[i + 1].at;
    if (h.frame - releasedAt > MOTION_TAIL) break;
    if (!isEnd(entries[i].dir)) continue;
    if (hasSubsequence(entries.slice(0, i + 1).map((e) => e.dir), seq)) return true;
  }
  return false;
}

/** 並びの中に、その順で現れるか（間に別の方向が挟まってもよい＝取りこぼしを減らす） */
function hasSubsequence(dirs: readonly Numpad[], seq: readonly Numpad[]): boolean {
  let i = 0;
  for (const d of dirs) {
    if (d === seq[i]) i += 1;
    if (i === seq.length) return true;
  }
  return false;
}

/** 時計回り／反時計回りの隣（一回転の判定。上=8 から見た並び） */
const CLOCKWISE: Partial<Record<Numpad, Numpad>> = { 8: 6, 6: 2, 2: 4, 4: 8 };
const COUNTER: Partial<Record<Numpad, Numpad>> = { 8: 4, 4: 2, 2: 6, 6: 8 };

/** 斜めを「その両隣の上下左右」とみなして、上下左右だけの軌跡にする */
function cardinalPath(dirs: readonly Numpad[]): Numpad[] {
  const out: Numpad[] = [];
  const push = (d: Numpad): void => {
    if (out[out.length - 1] !== d) out.push(d);
  };
  for (const d of dirs) {
    if (d === 2 || d === 4 || d === 6 || d === 8) push(d);
  }
  return out;
}

function hasRotation(dirs: readonly Numpad[]): boolean {
  const path = cardinalPath(dirs);
  for (let i = 0; i + 3 < path.length; i++) {
    const quad = path.slice(i, i + 4);
    const cw = quad.every((d, n) => n === 0 || CLOCKWISE[quad[n - 1]] === d);
    const ccw = quad.every((d, n) => n === 0 || COUNTER[quad[n - 1]] === d);
    if (cw || ccw) return true;
  }
  return false;
}

/**
 * そのコマンドがいま成立しているか（ボタンを押した瞬間に呼ぶ）。
 * `button` は連打の判定にだけ使う（どのボタンを連打しているか）。
 */
export function detectMotion(h: InputHistory, motion: MotionId, button: 'p' | 'k' = 'p'): boolean {
  switch (motion) {
    case 'qcf':
    case 'qcb':
      return endsWithMotion(
        h,
        MOTION_WINDOW[motion],
        MOTION_SEQUENCE[motion],
        motion === 'qcf' ? isForwardDir : isBackDir,
      );
    case 'dp':
      // 最後は↘（前下）か、↘を経て→へ抜けた形まで許す
      return endsWithMotion(h, MOTION_WINDOW.dp, MOTION_SEQUENCE.dp, (d) => d === 3 || d === 6);
    case 'chargeBF':
      // 溜め切ったまま前を入れた／溜め切って離した直後に前を入れた
      return (
        isForwardDir(h.dir) &&
        (h.chargeBack >= CHARGE_FRAMES ||
          (h.backReleasedAt >= 0 &&
            h.backReleasedAt > h.consumedAt &&
            h.frame - h.backReleasedAt <= MOTION_WINDOW.chargeBF))
      );
    case 'chargeDU':
      return (
        isUpDir(h.dir) &&
        (h.chargeDown >= CHARGE_FRAMES ||
          (h.downReleasedAt >= 0 &&
            h.downReleasedAt > h.consumedAt &&
            h.frame - h.downReleasedAt <= MOTION_WINDOW.chargeDU))
      );
    case 'spin':
      return hasRotation(recentDirs(h, MOTION_WINDOW.spin));
    case 'mash': {
      const presses = button === 'p' ? h.pPresses : h.kPresses;
      const from = Math.max(h.frame - MOTION_WINDOW.mash, h.consumedAt);
      return presses.filter((at) => at > from).length >= MASH_PRESSES;
    }
    case 'dashF':
    case 'dashB': {
      const target: Numpad = motion === 'dashF' ? 6 : 4;
      if (h.dir !== target) return false;
      // いま前（後ろ）へ入った瞬間で、その直前にニュートラルを挟んで同じ向きがある
      const from = Math.max(h.frame - MOTION_WINDOW[motion], h.consumedAt);
      const entries = h.dirs.filter((e) => e.at > from);
      if (entries.length < 3) return false;
      const n = entries.length;
      return (
        entries[n - 1].dir === target &&
        entries[n - 1].at === h.frame &&
        entries[n - 2].dir === 5 &&
        entries[n - 3].dir === target
      );
    }
  }
}

/** コマンドが成立したあと呼ぶ。同じ入力で2回出ないように履歴を締める */
export function consumeInput(h: InputHistory): InputHistory {
  return {
    ...h,
    consumedAt: h.frame,
    chargeBack: 0,
    chargeDown: 0,
    backReleasedAt: -1,
    downReleasedAt: -1,
  };
}

/** テンキー表記→矢印 */
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
 * HUDに出すコマンド表記（`MOTION_SEQUENCE` から起こす＝表示と判定が同じ数列）。
 * **その選手が実際に押す向き**で出すので、画面右の投手には左右が反転して出る。
 */
export function motionNotation(motion: MotionId, facing: FightFacing): string {
  const arrow = (d: Numpad): string => ARROW[facing === 1 ? d : MIRROR[d]] ?? '';
  if (motion === 'mash') return '連打';
  if (motion === 'spin') return '一回転';
  if (motion === 'chargeBF') return `${arrow(4)}溜め${arrow(6)}`;
  if (motion === 'chargeDU') return `${arrow(2)}溜め${arrow(8)}`;
  if (motion === 'dashF') return `${arrow(6)}${arrow(6)}`;
  if (motion === 'dashB') return `${arrow(4)}${arrow(4)}`;
  return MOTION_SEQUENCE[motion].map(arrow).join('');
}
