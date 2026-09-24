/**
 * 乱闘v3のCPU（フェーズXX-72）。**人間と同じパッドの入力だけで戦う**・**相手は 0.25秒遅れて
 * 見る**・**決定的**の3つを固定する。
 */
import { describe, expect, it } from 'vitest';
import {
  type BrawlSide,
  type BrawlState,
  type FighterLoadout,
  DEFAULT_LOADOUT,
  INTRO_FRAMES,
  MOVES,
  createBrawlState,
  stepBrawl,
} from '../src/core/brawl';
import { type CpuBrain, REACTION_FRAMES, cpuInput, createCpuBrain } from '../src/core/brawlAi';
import { type FrameInput, NEUTRAL_INPUT } from '../src/core/brawlCommand';

function fightState(loadouts: Partial<Record<BrawlSide, FighterLoadout>> = {}): BrawlState {
  let s = createBrawlState({ batter: DEFAULT_LOADOUT, pitcher: DEFAULT_LOADOUT, ...loadouts });
  for (let i = 0; i < INTRO_FRAMES + 1; i++) {
    s = stepBrawl(s, { batter: NEUTRAL_INPUT, pitcher: NEUTRAL_INPUT }).state;
  }
  return s;
}

function place(s: BrawlState, batterX: number, pitcherX: number): BrawlState {
  return {
    ...s,
    batter: { ...s.batter, x: batterX, facing: 1 },
    pitcher: { ...s.pitcher, x: pitcherX, facing: -1 },
  };
}

/** 打者は人間の入力（`human`）、投手はCPUで `frames` だけ回す */
function runVsCpu(
  s0: BrawlState,
  frames: number,
  human: (i: number) => Partial<FrameInput>,
  brain0: CpuBrain = createCpuBrain(),
): { state: BrawlState; cpuInputs: FrameInput[]; events: ReturnType<typeof stepBrawl>['events'] } {
  let s = s0;
  let brain = brain0;
  const cpuInputs: FrameInput[] = [];
  const events: ReturnType<typeof stepBrawl>['events'] = [];
  for (let i = 0; i < frames; i++) {
    const c = cpuInput(brain, s, 'pitcher');
    brain = c.brain;
    cpuInputs.push(c.input);
    const r = stepBrawl(s, { batter: { ...NEUTRAL_INPUT, ...human(i) }, pitcher: c.input });
    s = r.state;
    events.push(...r.events);
  }
  return { state: s, cpuInputs, events };
}

describe('反応の遅れ', () => {
  it('相手の状態は 0.25秒（15フレーム）遅れて見る＝人の反応より速くはない', () => {
    expect(REACTION_FRAMES).toBe(15);
    expect(REACTION_FRAMES / 60).toBeGreaterThanOrEqual(0.2);
  });

  it('発生の速い通常技は反応より速い＝見てから防がれない技が残る（差し込む価値）', () => {
    expect(MOVES.cP.startup).toBeLessThan(REACTION_FRAMES);
    expect(MOVES.crK.startup).toBeLessThan(REACTION_FRAMES);
  });
});

describe('CPUの判断（人間と同じ入力で）', () => {
  it('遠くから大振りの回し蹴りを出されたら、後ろを入れて守る', () => {
    // 打者が間合いの外で回し蹴りを振る＝CPUは遅れて見ても「技が来ている」と読める
    const s0 = place(fightState(), -1.4, 0.2);
    const r = runVsCpu(s0, 40, (i) => ({ k: i === 0 }));
    // 投手は画面右＝後ろは +x
    expect(r.cpuInputs.some((inp) => inp.x === 1)).toBe(true);
  });

  it('ピヨったらレバーとボタンをがちゃがちゃして抜けようとする', () => {
    let s = place(fightState(), -2, 2);
    s = { ...s, pitcher: { ...s.pitcher, act: { k: 'dizzy', t: 0, dur: 140 } } };
    const r = runVsCpu(s, 12, () => ({}));
    const xs = new Set(r.cpuInputs.map((i) => i.x));
    expect(xs.has(1) && xs.has(-1)).toBe(true);
    expect(r.cpuInputs.some((i) => i.p || i.k)).toBe(true);
  });

  it('昇龍拳を持っていれば、跳び込んできた相手を対空で落とす', () => {
    const lo: FighterLoadout = { ...DEFAULT_LOADOUT, specials: ['shoryu'] };
    const s0 = place(fightState({ pitcher: lo }), -2.2, 0.2);
    const r = runVsCpu(s0, 70, (i) => (i < 2 ? { x: 1, y: 1 } : {}));
    expect(r.events.some((e) => e.k === 'special' && e.side === 'pitcher' && e.move === 'shoryu')).toBe(true);
  });

  it('波動拳を持っていれば、とても遠い相手には撃つ', () => {
    const lo: FighterLoadout = { ...DEFAULT_LOADOUT, specials: ['hadou'] };
    const s0 = place(fightState({ pitcher: lo }), -4.5, 1.2);
    const r = runVsCpu(s0, 40, () => ({}));
    expect(r.events.some((e) => e.k === 'projectile' && e.side === 'pitcher')).toBe(true);
  });

  it('持っていない必殺技は出さない（素の選手は通常技と投げだけ）', () => {
    const s0 = place(fightState(), -1.0, 0.2);
    const r = runVsCpu(s0, 600, (i) => ({ x: i % 90 < 45 ? 1 : 0 }));
    expect(r.events.some((e) => e.k === 'special' && e.side === 'pitcher')).toBe(false);
  });

  it('同じ状況からは必ず同じ入力（決定的・乱数不使用）', () => {
    const script = (i: number): Partial<FrameInput> => ({ x: i % 60 < 30 ? 1 : -1, p: i % 23 === 0 });
    const a = runVsCpu(place(fightState(), -1.5, 1.5), 400, script);
    const b = runVsCpu(place(fightState(), -1.5, 1.5), 400, script);
    expect(JSON.stringify(a.cpuInputs)).toBe(JSON.stringify(b.cpuInputs));
  });
});
