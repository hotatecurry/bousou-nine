/**
 * 乱闘v3のCPU（フェーズXX-72）。**人間と同じ入力の経路で戦う**＝パッドの状態
 * （`FrameInput`）を1フレームずつ作って `stepBrawl` に渡すだけで、CPUだけが出せる技も、
 * CPUだけが知っている判定も無い（⑧「CPUも対等」）。必殺技もコマンドを1フレームずつ入れて出す。
 *
 * ## 規則は決定的（乱数を使わない）
 *
 * 他の `core/*.ts` と同じく乱数は使わない。規則が読めることがそのまま攻略法になる
 * （桜井ノウハウ「コンピューターが良い目を出すとイカサマしてると思われがち」）。
 * 間合いの中での選び方にだけ**決まった巡回**（`cycle`）を使う＝同じ場面で毎回まったく
 * 同じ技を振ると、1つの対策で永久に勝ててしまうため（それでも同じ入力なら同じ結果）。
 *
 * ## 反応は人間並みに遅らせる
 *
 * **相手の状態は `REACTION_FRAMES`（15フレーム＝0.25秒）遅れて見る**。いまの状態を見ると
 * 「見てから必ずガードする・必ず対空する」CPUになる（桜井ノウハウ「人に反応できない
 * 動作をするとすっごい理不尽感がある」の裏返し＝CPUが人間に不可能な速さで反応するのも
 * 同じ理不尽さ）。発生の速い技（4〜9フレーム）は見てからは防げない＝**CPUも人間と同じく
 * 「来そうなら先に構える」**（近い間合いで考えている間は後ろを入れる）。
 *
 * 規則は上から順に見る：
 * 1. **動けない**（技の最中・のけぞり）→ ガード硬直なら後ろを入れ続ける／ピヨりならレバガチャ。
 * 2. **入力中のコマンド**があれば続ける（キャンセルの入力も技の最中に入れる）。
 * 3. **超必殺**：ゲージ満タンで、相手が隙を晒している（遅れて見た状態で）。
 * 4. **対空**：相手が跳んで近づいてくる → 昇龍・サマーソルト、無ければしゃがみ突きか立ちガード。
 * 5. **反撃**：相手の大技の戻り・着地の硬直が長く残っている → 足払い・回し蹴り・突進技。
 * 6. **ガード**：相手が技を出してきた・飛び道具が来る → 後ろ（下段ならしゃがみ）。
 *    飛び道具は遠ければ巡回で跳び越える。
 * 7. **間合いに応じた攻め**（巡回で選ぶ）：密着＝肘打ち→必殺技・投げ・足払い・固める／
 *    中間＝回し蹴り・足払い・竜巻／遠い＝歩いて詰める・跳び込み・突進技・子分／
 *    とても遠い＝波動拳（持っていれば）。
 */
import {
  type BrawlSide,
  type BrawlState,
  type Fighter,

  type SpecialId,
  MOVES,
  METER_MAX,
  OTHER_SIDE,
  PROJECTILES,
} from './brawl';
import { CHARGE_FRAMES, type FrameInput, NEUTRAL_INPUT } from './brawlCommand';

/** 相手の状態を何フレーム遅れて見るか（人の単純反応時間よりわずかに遅い＝人間が勝てる速さ） */
export const REACTION_FRAMES = 15;

/** 入力の1フレーム（`fx` は自分から見た前＝+1） */
interface MacroStep {
  fx: -1 | 0 | 1;
  y: -1 | 0 | 1;
  p?: boolean;
  k?: boolean;
  s?: boolean;
}

/** 相手のうち、CPUが見る部分（遅れて見るので写しを持つ） */
interface Seen {
  x: number;
  y: number;
  vx: number;
  act: Fighter['act'];
}

export interface CpuBrain {
  /** 見た相手の履歴（古いほうから） */
  seen: Seen[];
  /** 入れている最中のコマンド */
  macro: MacroStep[];
  /** 間合いの中の選び方の巡回（決定的なばらつき） */
  cycle: number;
  /** 次に考えるまで（考えるたびに同じ技を連打しないための間） */
  wait: number;
  /** ピヨりのレバガチャの位相 */
  mash: number;
  /** 相手を何フレーム遅れて見るか（既定 `REACTION_FRAMES`。計測で両者をずらすのに使う） */
  reaction: number;
}

export function createCpuBrain(reaction = REACTION_FRAMES): CpuBrain {
  return { seen: [], macro: [], cycle: 0, wait: 0, mash: 0, reaction };
}

function snapshot(f: Fighter): Seen {
  return { x: f.x, y: f.y, vx: f.vx, act: f.act };
}

/** 前後の向きをワールドの入力へ */
function toInput(step: MacroStep, facing: 1 | -1): FrameInput {
  return {
    x: (step.fx * facing) as -1 | 0 | 1,
    y: step.y,
    p: step.p ?? false,
    k: step.k ?? false,
    s: step.s ?? false,
  };
}

// コマンドの並び（前＝+1）。最後のボタンは同じフレーム
const QCF_P: MacroStep[] = [{ fx: 0, y: -1 }, { fx: 1, y: -1 }, { fx: 1, y: 0, p: true }];
const QCB_K: MacroStep[] = [{ fx: 0, y: -1 }, { fx: -1, y: -1 }, { fx: -1, y: 0, k: true }];
const QCB_P: MacroStep[] = [{ fx: 0, y: -1 }, { fx: -1, y: -1 }, { fx: -1, y: 0, p: true }];
const DP_P: MacroStep[] = [{ fx: 1, y: 0 }, { fx: 0, y: -1 }, { fx: 1, y: -1, p: true }];
const SPIN_P: MacroStep[] = [
  { fx: 1, y: 0 },
  { fx: 1, y: -1 },
  { fx: 0, y: -1 },
  { fx: -1, y: -1 },
  { fx: -1, y: 0 },
  { fx: 0, y: 1, p: true },
];
const MASH_P: MacroStep[] = [
  { fx: 0, y: 0, p: true },
  { fx: 0, y: 0 },
  { fx: 0, y: 0, p: true },
  { fx: 0, y: 0 },
  { fx: 0, y: 0, p: true },
  { fx: 0, y: 0 },
  { fx: 0, y: 0, p: true },
  { fx: 0, y: 0 },
  { fx: 0, y: 0, p: true },
];
const HOLD = (step: MacroStep, frames: number): MacroStep[] => Array.from({ length: frames }, () => step);

/** その必殺技を肘打ちのキャンセルで出すときのコマンド（当たれば繋がる） */
function comboFollow(has: (id: SpecialId) => boolean): MacroStep[] {
  if (has('hadou')) return QCF_P;
  if (has('tatsu')) return QCB_K;
  if (has('shoryu')) return DP_P;
  return [];
}

/** 1フレームぶんのCPUの入力（決定的）。脳の状態は写しを返す */
export function cpuInput(
  brainIn: CpuBrain,
  state: BrawlState,
  side: BrawlSide,
): { brain: CpuBrain; input: FrameInput } {
  const brain: CpuBrain = { ...brainIn, seen: [...brainIn.seen, snapshot(state[OTHER_SIDE[side]])] };
  if (brain.seen.length > brain.reaction + 1) brain.seen.shift();
  const self = state[side];
  const loadout = state.loadouts[side];
  const foe = brain.seen[0];
  const neutral = (): { brain: CpuBrain; input: FrameInput } => ({ brain, input: NEUTRAL_INPUT });
  const hold = (step: MacroStep): { brain: CpuBrain; input: FrameInput } => ({
    brain,
    input: toInput(step, self.facing),
  });

  if (state.phase !== 'fight') {
    brain.macro = [];
    return neutral();
  }

  // 1) 動けない
  const k = self.act.k;
  if (k === 'dizzy') {
    // レバガチャ（左右とボタンを交互に）
    brain.mash += 1;
    const phase = brain.mash % 4;
    return {
      brain,
      input: { x: phase < 2 ? 1 : -1, y: 0, p: phase === 0, k: phase === 2, s: false },
    };
  }
  if (self.act.k === 'blockstun') return hold({ fx: -1, y: self.act.low ? -1 : 0 });

  // 2) 入力中のコマンド（技の最中でも続ける＝キャンセルの入力）
  if (brain.macro.length > 0) {
    const [step, ...rest] = brain.macro;
    brain.macro = rest;
    return hold(step);
  }

  const busy = !(k === 'idle' || k === 'crouch' || k === 'walk' || k === 'guard');
  if (busy) {
    // 空中：跳び込みは降りてくるところで蹴る
    if (k === 'air' && self.vy < 0 && self.y < 0.95) return hold({ fx: 0, y: 0, k: true });
    return neutral();
  }

  if (brain.wait > 0) brain.wait -= 1;
  const dist = Math.abs(foe.x - self.x);
  const foeK = foe.act.k;
  const foeAttack = foe.act.k === 'attack' ? foe.act : null;
  const foeMove = foeAttack ? MOVES[foeAttack.move] : null;
  const charged = self.input.chargeBack >= CHARGE_FRAMES;
  const has = (id: SpecialId): boolean => loadout.specials.includes(id);
  const start = (macro: MacroStep[], wait = 10): { brain: CpuBrain; input: FrameInput } => {
    const [first, ...rest] = macro;
    brain.macro = rest;
    brain.wait = wait;
    brain.cycle += 1;
    return hold(first);
  };

  // 3) 超必殺：相手が隙を晒している
  const foeLanding = foe.act.k === 'land' ? foe.act.dur - foe.act.t : 0;
  const foeVulnerable =
    foeK === 'hitstun' ||
    foeK === 'dizzy' ||
    foeLanding > 6 ||
    (foeAttack !== null && foeMove !== null && foeAttack.t > foeMove.startup + foeMove.active);
  if (loadout.super && self.meter >= METER_MAX && foeVulnerable) {
    const reach = loadout.super === 'batto' ? 1.3 : 8;
    if (dist < reach) return start([{ fx: 0, y: 0, s: true }], 30);
  }

  // 4) 対空：相手が跳んで近づいてくる
  const foeAir = foe.y > 0.3 && (foeK === 'air' || (foeAttack !== null && foeMove?.fromAir === true));
  const approaching = Math.sign(self.x - foe.x) === Math.sign(foe.vx) || Math.abs(foe.vx) < 0.01;
  if (foeAir && approaching && dist < 2.2) {
    if (has('shoryu') && dist < 1.6) return start(DP_P, 20);
    if (has('somersault') && self.input.chargeDown >= CHARGE_FRAMES && dist < 1.4) {
      return start([{ fx: 0, y: 1, k: true }], 20);
    }
    if (dist < 1.2) return start([{ fx: 0, y: -1, p: true }], 12);
    return hold({ fx: -1, y: 0 });
  }

  // 5) 反撃：相手の大技の戻り・着地の硬直が長く残っている（遅れて見た状態で）
  const recoveryLeft =
    foeAttack && foeMove && foeAttack.t >= foeMove.startup + foeMove.active && !foeMove.air
      ? foeMove.startup + foeMove.active + foeMove.recovery - foeAttack.t - brain.reaction
      : foeLanding - brain.reaction;
  if (recoveryLeft >= 8) {
    if (dist < 1.3) return start([{ fx: 0, y: -1, k: true }], 16);
    if (dist < 1.45) return start([{ fx: 0, y: 0, k: true }], 18);
    if ((has('zutsuki') || has('buki')) && charged && dist < 2.8) {
      return start([{ fx: 1, y: 0, ...(has('zutsuki') ? { p: true } : { k: true }) }], 30);
    }
    if (has('hadou') && dist < 4) return start(QCF_P, 30);
  }

  // 6) ガード：相手が技を出してきた・飛び道具が来る
  if (foeAttack && foeMove && foeAttack.t < foeMove.startup + foeMove.active && dist < 2.4) {
    return hold({ fx: -1, y: foeMove.guard === 'low' ? -1 : 0 });
  }
  const incoming = state.projectiles.find(
    (p) => p.owner !== side && Math.sign(self.x - p.x) === p.dir && Math.abs(self.x - p.x) < 2.6,
  );
  if (incoming) {
    const far = Math.abs(self.x - incoming.x) > 1.4 && PROJECTILES[incoming.kind].hits === 1;
    // 遠ければ巡回で跳び越える（毎回ではない＝波動に対して読み合いが残る）
    if (far && brain.cycle % 3 === 0) return start([{ fx: 1, y: 1 }], 30);
    return hold({ fx: -1, y: 0 });
  }

  if (brain.wait > 0) {
    // 考え中：**近ければ後ろを入れて固める**（相手がしゃがんでいたらしゃがみガード＝足払いを読む）。
    // 遠ければ溜め技を持っていれば後ろを入れて溜める
    if (dist < 1.8) {
      const low = foe.act.k === 'crouch' || foeMove?.guard === 'low';
      return hold({ fx: -1, y: low ? -1 : 0 });
    }
    if (has('zutsuki') || has('buki')) return hold({ fx: -1, y: 0 });
    return neutral();
  }

  // 7) 間合いに応じた攻め（巡回で選ぶ）
  const c = brain.cycle % 6;
  if (dist < 1.05) {
    // 密着：肘打ち→必殺技（当たれば繋がる）／投げ／足払い／張り手・スクリュー／固める
    switch (c) {
      case 0:
        return start([{ fx: 0, y: 0, p: true }, { fx: 0, y: 0 }, { fx: 0, y: 0 }, ...comboFollow(has)], 18);
      case 1:
        // 投げ：投げ間合いまで踏み込んでから横＋P
        if (dist > 0.8) return start([...HOLD({ fx: 1, y: 0 }, 6), { fx: 1, y: 0, p: true }], 16);
        return start([{ fx: 1, y: 0, p: true }], 16);
      case 2:
        return start([{ fx: 0, y: -1, k: true }], 22);
      case 3:
        if (has('screw')) return start(SPIN_P, 30);
        if (has('hyakuretsu')) return start(MASH_P, 20);
        return start([{ fx: 0, y: -1, p: true }, { fx: 0, y: 0 }, { fx: 0, y: 0 }, ...comboFollow(has)], 16);
      case 4:
        if (has('hyakuretsu')) return start(MASH_P, 20);
        return start([{ fx: 1, y: 0, p: true }], 16);
      default:
        // 固める（一度下がって様子を見る）
        return start(HOLD({ fx: -1, y: 0 }, 14), 6);
    }
  }
  if (dist < 1.55) {
    switch (c) {
      case 0:
      case 3:
        return start([{ fx: 0, y: 0, k: true }], 24);
      case 1:
        return start([{ fx: 0, y: -1, k: true }], 26);
      case 2:
        if (has('tatsu')) return start(QCB_K, 30);
        if (has('screw') && dist < 1.15) return start(SPIN_P, 30);
        return start(HOLD({ fx: 1, y: 0 }, 10), 4);
      case 4:
        if (has('hyakuretsu')) return start([...HOLD({ fx: 1, y: 0 }, 8), ...MASH_P], 20);
        return start([{ fx: 1, y: 1 }], 30);
      default:
        return start(HOLD({ fx: -1, y: 0 }, 12), 6);
    }
  }
  if (dist < 3.2) {
    if ((has('zutsuki') || has('buki')) && charged && c % 2 === 0) {
      return start([{ fx: 1, y: 0, ...(has('zutsuki') ? { p: true } : { k: true }) }], 30);
    }
    if (has('hadou') && dist > 2.4 && c % 3 === 0 && !state.projectiles.some((p) => p.owner === side)) {
      return start(QCF_P, 30);
    }
    if (has('tatsu') && c === 1) return start(QCB_K, 30);
    if (has('kobun') && !self.kobunUsed && c === 3) return start(QCB_P, 30);
    if (c === 4) return start([{ fx: 1, y: 1 }], 30);
    return start(HOLD({ fx: 1, y: 0 }, 12), 2);
  }
  // とても遠い
  if (has('hadou') && !state.projectiles.some((p) => p.owner === side)) {
    return start(QCF_P, 40);
  }
  return hold({ fx: 1, y: 0 });
}

/**
 * 練習の相手（デバッグの乱闘。フェーズXX-72）。`cpu` 以外は**決まった形で立っているだけ**＝
 * 技の当たり方・ガードの二択（中段／下段）・対空を1つずつ確かめられる。
 */
export type BrawlDummy = 'cpu' | 'stand' | 'guard' | 'crouchGuard' | 'jump';

export function dummyInput(state: BrawlState, side: BrawlSide, dummy: Exclude<BrawlDummy, 'cpu'>): FrameInput {
  const back = (-state[side].facing) as -1 | 1;
  switch (dummy) {
    case 'stand':
      return NEUTRAL_INPUT;
    case 'guard':
      return { ...NEUTRAL_INPUT, x: back };
    case 'crouchGuard':
      return { ...NEUTRAL_INPUT, x: back, y: -1 };
    case 'jump':
      return { ...NEUTRAL_INPUT, y: 1 };
  }
}
