import { describe, expect, it } from 'vitest';
import {
  type CommandBuffer,
  type Direction,
  type FightFacing,
  CHARGE_SEC,
  COMMAND_MOTION,
  COMMAND_WINDOW_SEC,
  commandNotation,
  consumeCommand,
  createCommandBuffer,
  detectCommand,
  numpadOf,
  stepCommandBuffer,
} from '../src/core/brawlCommand';

const DT = 1 / 60;

/** 打者（画面左＝前が +X）から見た8方向 */
const N: Direction = { x: 0, y: 0 };
const F: Direction = { x: 1, y: 0 };
const B: Direction = { x: -1, y: 0 };
const D: Direction = { x: 0, y: -1 };
const U: Direction = { x: 0, y: 1 };
const DF: Direction = { x: 1, y: -1 };
const DB: Direction = { x: -1, y: -1 };

function hold(buf: CommandBuffer, dir: Direction, seconds: number, facing: FightFacing = 1): CommandBuffer {
  let next = buf;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    next = stepCommandBuffer(next, dir, facing, DT);
  }
  return next;
}

/** 方向の並びを順に入れる（1つあたり `each` 秒） */
function input(dirs: readonly Direction[], each = 0.06, facing: FightFacing = 1): CommandBuffer {
  let buf = createCommandBuffer();
  for (const dir of dirs) buf = hold(buf, dir, each, facing);
  return buf;
}

describe('numpadOf: 向きで前後を入れ替えてからテンキー表記に畳む', () => {
  it('打者（前=+X）は右入力が 6（前）になる', () => {
    expect(numpadOf(F, 1)).toBe(6);
    expect(numpadOf(B, 1)).toBe(4);
    expect(numpadOf(DF, 1)).toBe(3);
  });

  it('投手（前=-X）は**同じ「前」が左入力**になる（両者が同じコマンド表を使える）', () => {
    expect(numpadOf({ x: -1, y: 0 }, -1)).toBe(6);
    expect(numpadOf({ x: 1, y: 0 }, -1)).toBe(4);
    expect(numpadOf({ x: -1, y: -1 }, -1)).toBe(3);
  });

  it('ニュートラルは5、上下は向きによらない', () => {
    expect(numpadOf(N, 1)).toBe(5);
    expect(numpadOf(N, -1)).toBe(5);
    expect(numpadOf(U, 1)).toBe(8);
    expect(numpadOf(D, -1)).toBe(2);
  });
});

describe('detectCommand: 昇龍拳コマンド（前→下→前下）', () => {
  it('前→下→前下 と入れると成立する', () => {
    expect(detectCommand(input([F, D, DF]))).toBe('dp');
  });

  it('間にニュートラルが挟まっても成立する（キーボードは必ずここを通る）', () => {
    expect(detectCommand(input([F, N, D, N, DF]))).toBe('dp');
  });

  it('投手側（前=左）でも同じ手順で成立する', () => {
    const buf = input([{ x: -1, y: 0 }, D, { x: -1, y: -1 }], 0.06, -1);
    expect(detectCommand(buf)).toBe('dp');
  });

  it('最後が前下でなければ成立しない（下→前 では出ない）', () => {
    expect(detectCommand(input([F, DF, D]))).toBeNull();
  });

  it('順番が違えば成立しない', () => {
    expect(detectCommand(input([D, F, DF]))).toBeNull();
  });

  it('受付時間を超えてゆっくり入れると成立しない', () => {
    let buf = createCommandBuffer();
    buf = hold(buf, F, 0.06);
    buf = hold(buf, D, COMMAND_WINDOW_SEC.dp);
    buf = hold(buf, DF, 0.06);
    expect(detectCommand(buf)).toBeNull();
  });

  it('成立したコマンドは消費すると二度は出ない（1入力1発）', () => {
    const buf = input([F, D, DF]);
    expect(detectCommand(buf)).toBe('dp');
    expect(detectCommand(consumeCommand(buf))).toBeNull();
  });
});

describe('detectCommand: 溜めコマンド（後ろをためて前）', () => {
  it('1秒ためてから前を入れると成立する', () => {
    let buf = hold(createCommandBuffer(), B, CHARGE_SEC + 0.05);
    buf = hold(buf, F, 0.05);
    expect(detectCommand(buf)).toBe('charge');
  });

  it('ためが足りなければ成立しない', () => {
    let buf = hold(createCommandBuffer(), B, CHARGE_SEC - 0.2);
    buf = hold(buf, F, 0.05);
    expect(detectCommand(buf)).toBeNull();
  });

  it('後ろを離してから前を押すまでにニュートラルを挟んでも成立する', () => {
    let buf = hold(createCommandBuffer(), B, CHARGE_SEC + 0.05);
    buf = hold(buf, N, 0.1);
    buf = hold(buf, F, 0.05);
    expect(detectCommand(buf)).toBe('charge');
  });

  it('開放が遅すぎると成立しない（離してから受付時間だけ）', () => {
    let buf = hold(createCommandBuffer(), B, CHARGE_SEC + 0.05);
    buf = hold(buf, N, COMMAND_WINDOW_SEC.charge + 0.1);
    buf = hold(buf, F, 0.05);
    expect(detectCommand(buf)).toBeNull();
  });

  it('斜め後ろ（下後ろ）でもためられる（しゃがみながら溜める）', () => {
    let buf = hold(createCommandBuffer(), DB, CHARGE_SEC + 0.05);
    buf = hold(buf, F, 0.05);
    expect(detectCommand(buf)).toBe('charge');
  });

  it('ためた後で前を離すと（ニュートラルのままでは）成立しない', () => {
    let buf = hold(createCommandBuffer(), B, CHARGE_SEC + 0.05);
    buf = hold(buf, N, 0.05);
    expect(detectCommand(buf)).toBeNull();
  });
});

describe('detectCommand: 一回転（上下左右をひと回り）', () => {
  it('時計回りで成立する', () => {
    expect(detectCommand(input([F, D, B, U]))).toBe('super');
  });

  it('反時計回りでも成立する', () => {
    expect(detectCommand(input([F, U, B, D]))).toBe('super');
  });

  it('3方向しか通らなければ成立しない', () => {
    expect(detectCommand(input([F, D, B]))).toBeNull();
  });

  it('途中で戻ると（往復では）成立しない', () => {
    expect(detectCommand(input([F, D, F, D]))).toBeNull();
  });

  it('斜めは通過点として無視される（レバーを回すと必ず通るため）', () => {
    expect(detectCommand(input([F, DF, D, DB, B, U], 0.05))).toBe('super');
  });

  it('一回転は昇龍拳より先に見る（回転の軌跡が昇龍の並びを含みうる）', () => {
    // 反時計回り（前→上→後ろ→下）のあと前下へ入れると、昇龍の「前・下・前下」も
    // 部分列として現れる。**難しいコマンドを先に見ないと、一回転が永久に出せない**
    const buf = input([F, U, B, D, DF], 0.05);
    expect(detectCommand(buf)).toBe('super');
  });
});

describe('commandNotation: 表示は判定と同じ数列から起こす', () => {
  it('打者側（前=右）は右向きの矢印で出る', () => {
    expect(commandNotation('dp', 1)).toBe('→↓↘');
  });

  it('投手側（前=左）は左右が鏡像になる（その人が押す向きで出す）', () => {
    expect(commandNotation('dp', -1)).toBe('←↓↙');
  });

  it('溜めは「ためる」ことが本体なので印を添える', () => {
    expect(commandNotation('charge', 1)).toBe('←溜め→');
  });

  it('一回転は4方向をそのまま並べる', () => {
    expect(commandNotation('super', 1)).toBe('→↓←↑');
  });

  it('表記の長さはコマンドの入力列と一致する（表と実装が二重に持たれていない）', () => {
    for (const command of ['dp', 'super'] as const) {
      expect([...commandNotation(command, 1)]).toHaveLength(COMMAND_MOTION[command].length);
    }
  });
});

describe('純粋性', () => {
  it('stepCommandBuffer は入力のバッファを変更しない', () => {
    const buf = createCommandBuffer();
    const snapshot = JSON.parse(JSON.stringify(buf));
    stepCommandBuffer(buf, F, 1, DT);
    expect(buf).toEqual(snapshot);
  });

  it('同じ入力列は常に同じ結果になる（乱数不使用）', () => {
    const results = new Set(Array.from({ length: 10 }, () => detectCommand(input([F, D, DF]))));
    expect(results.size).toBe(1);
  });
});
