/**
 * 乱闘v2の計測（フェーズI-29。G-27の未確認事項）。
 *
 * 見るのは記録されていた4点：
 * (1) 1回の乱闘が短すぎないか（＝決着までの秒数）
 * (2) 投げ（20ダメージ・ガード不能）が強すぎないか
 * (3) 必殺技を持つ選手と持たない選手の差
 * (4) ガードの価値（固めているだけで勝てないか）
 *
 * **判定は `core/brawl.ts` の `stepBrawl` をそのまま回す**。ここが持つのは
 * 「どう入力するか」＝戦い方の型だけで、CPUの型は `scenes/brawlScene.ts` の
 * 固定スクリプトを写してある（あちらは Three.js に依存するので import できない）。
 */
import {
  type BrawlSide,
  type BrawlState,
  type FighterLoadout,
  type MoveId,
  DEFAULT_LOADOUT,
  MOVES,
  createBrawlState,
  isDefeated,
  setGuarding,
  stepBrawl,
  tryStartAttack,
} from '../../src/core/brawl';

const DT = 1 / 60;

/** brawlScene.ts の CPU固定スクリプト（写し。あちらを変えたらここも直す） */
export const CPU_CYCLE_SEC = 3;
export const CPU_GUARD_WINDOW: readonly [number, number] = [0.95, 1.45];
export const CPU_ATTACK_SCRIPT: ReadonlyArray<{ at: number; move: MoveId | 'finisher' }> = [
  { at: 0.3, move: 'jab' },
  { at: 0.5, move: 'punch' },
  { at: 1.6, move: 'throw' },
  { at: 2.3, move: 'finisher' },
];

function finisherOf(loadout: FighterLoadout): MoveId {
  let best: MoveId = 'punch';
  for (const move of loadout.moves) {
    if (MOVES[move].command !== undefined && MOVES[move].rank > MOVES[best].rank) best = move;
  }
  return best;
}

/** 戦い方の型（決定的） */
export type Tactic = 'cpu' | 'guard' | 'jab' | 'combo' | 'throw' | 'idle';

interface Runner {
  elapsed: number;
  fired: Set<number>;
}

/**
 * 1フレームぶん、その型に沿って入力する。**入力の窓口は人間と同じ**
 * （`tryStartAttack` / `setGuarding`）なので、型を変えても判定の通り道は変わらない。
 */
function act(
  state: BrawlState,
  side: BrawlSide,
  tactic: Tactic,
  runner: Runner,
  dt: number,
): BrawlState {
  const loadout = state.loadouts[side];
  const me = state[side];
  const put = (next: typeof me): BrawlState => ({ ...state, [side]: next });

  if (tactic === 'idle') return state;
  if (tactic === 'guard') return put(setGuarding(me, true));

  if (tactic === 'jab') return put(tryStartAttack(me, 'jab', loadout));

  if (tactic === 'throw') return put(tryStartAttack(me, 'throw', loadout));

  if (tactic === 'combo') {
    // ジャブ→パンチ→（持っていれば）必殺技。**当てた技だけがキャンセルできる**ので、
    // 毎フレーム上から順に試すだけでコンボになる（格上へしか通らない）。
    const finisher = finisherOf(loadout);
    for (const move of ['jab', 'punch', finisher] as MoveId[]) {
      const next = tryStartAttack(me, move, loadout);
      if (next !== me) return put(next);
    }
    return state;
  }

  // cpu：3秒周期の固定スクリプト
  const elapsed = runner.elapsed + dt;
  runner.elapsed = elapsed >= CPU_CYCLE_SEC ? elapsed - CPU_CYCLE_SEC : elapsed;
  if (elapsed >= CPU_CYCLE_SEC) runner.fired = new Set();
  const now = runner.elapsed;
  let next = setGuarding(me, now >= CPU_GUARD_WINDOW[0] && now < CPU_GUARD_WINDOW[1]);
  CPU_ATTACK_SCRIPT.forEach((step, i) => {
    if (runner.fired.has(i) || now < step.at) return;
    const move = step.move === 'finisher' ? finisherOf(loadout) : step.move;
    next = tryStartAttack(next, move, loadout);
    runner.fired.add(i);
  });
  return put(next);
}

export interface FightResult {
  /** 決着までの秒数（決着しなければ上限） */
  seconds: number;
  winner: BrawlSide | null;
  batterHp: number;
  pitcherHp: number;
  /** 与えた総ダメージ */
  damage: Record<BrawlSide, number>;
  /** 最大コンボ数 */
  maxCombo: Record<BrawlSide, number>;
}

/** 2つの型を戦わせて決着までを測る */
export function fight(
  batter: Tactic,
  pitcher: Tactic,
  loadouts?: Partial<Record<BrawlSide, FighterLoadout>>,
  maxSeconds = 60,
): FightResult {
  let state = createBrawlState({
    batter: loadouts?.batter ?? DEFAULT_LOADOUT,
    pitcher: loadouts?.pitcher ?? DEFAULT_LOADOUT,
  });
  const runners: Record<BrawlSide, Runner> = {
    batter: { elapsed: 0, fired: new Set() },
    pitcher: { elapsed: 0, fired: new Set() },
  };
  const damage: Record<BrawlSide, number> = { batter: 0, pitcher: 0 };
  const maxCombo: Record<BrawlSide, number> = { batter: 0, pitcher: 0 };

  let t = 0;
  while (t < maxSeconds) {
    state = act(state, 'batter', batter, runners.batter, DT);
    state = act(state, 'pitcher', pitcher, runners.pitcher, DT);
    const stepped = stepBrawl(state, DT);
    state = stepped.state;
    for (const hit of stepped.hits) {
      damage[hit.attacker] += hit.damage;
      maxCombo[hit.attacker] = Math.max(maxCombo[hit.attacker], hit.combo);
    }
    t += DT;
    if (isDefeated(state.batter) || isDefeated(state.pitcher)) break;
  }
  const winner = isDefeated(state.batter)
    ? 'pitcher'
    : isDefeated(state.pitcher)
      ? 'batter'
      : null;
  return {
    seconds: t,
    winner,
    batterHp: state.batter.hp,
    pitcherHp: state.pitcher.hp,
    damage,
    maxCombo,
  };
}
