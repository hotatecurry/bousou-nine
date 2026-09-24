/**
 * 乱闘v3の計測（フェーズXX-72）。**CPUどうしを最後まで戦わせて**、装備ごとの勝ち方を数える。
 *
 * 判定は `core/brawl.ts` の `stepBrawl`、CPUの判断は `core/brawlAi.ts` の `cpuInput` を
 * **そのまま**回す（ここに判定式もCPUの規則も書かない＝定数を動かせば計測も一緒に動く）。
 *
 * CPUは決定的なので、同じ組み合わせは何度やっても同じ結果になる。**ばらつきは巡回の
 * 出だし（`cycle`）を 0..5 でずらして作る**（6×6＝36通り）＝乱数を使わずに、読み合いの
 * 始まり方が違う試合を並べる。
 */
import {
  type BrawlEvent,
  type BrawlLoadouts,
  type BrawlSide,
  type FighterLoadout,
  DEFAULT_LOADOUT,
  createBrawlState,
  stepBrawl,
} from '../../src/core/brawl';
import { type CpuBrain, REACTION_FRAMES, createCpuBrain, cpuInput } from '../../src/core/brawlAi';

export interface BrawlStats {
  winner: BrawlSide | null;
  rounds: number;
  /** ラウンドごとの長さ（秒） */
  roundSeconds: number[];
  /** 時間切れで終わったラウンドの数 */
  timeUps: number;
  hits: Record<BrawlSide, number>;
  blocked: Record<BrawlSide, number>;
  damage: Record<BrawlSide, number>;
  specials: Record<BrawlSide, number>;
  supers: Record<BrawlSide, number>;
  throws: Record<BrawlSide, number>;
  dizzies: Record<BrawlSide, number>;
  /** 1ラウンドでいちばん多く繋がったコンボ */
  maxCombo: number;
}

const zero = (): Record<BrawlSide, number> => ({ batter: 0, pitcher: 0 });

/** 1試合（乱闘）を最後まで。`offsets` は巡回の出だし（ばらつき） */
export function simulateBrawl(
  loadouts: Partial<BrawlLoadouts>,
  offsets: Record<BrawlSide, number> = { batter: 0, pitcher: 0 },
  maxFrames = 60 * 60 * 6,
): BrawlStats {
  let s = createBrawlState({ batter: DEFAULT_LOADOUT, pitcher: DEFAULT_LOADOUT, ...loadouts });
  // 反応の遅れも出だしでずらす（14〜16フレーム）。同じ規則・同じ遅れのCPUどうしは
  // 鏡写しに動いて相打ちを繰り返す（両者KO＝引き分けばかりになる）ので、計測の上だけの工夫
  const reaction = (o: number): number => REACTION_FRAMES + ((o % 3) - 1);
  const brains: Record<BrawlSide, CpuBrain> = {
    batter: { ...createCpuBrain(reaction(offsets.batter)), cycle: offsets.batter },
    pitcher: { ...createCpuBrain(reaction(offsets.pitcher + 1)), cycle: offsets.pitcher },
  };
  const stats: BrawlStats = {
    winner: null,
    rounds: 0,
    roundSeconds: [],
    timeUps: 0,
    hits: zero(),
    blocked: zero(),
    damage: zero(),
    specials: zero(),
    supers: zero(),
    throws: zero(),
    dizzies: zero(),
    maxCombo: 0,
  };
  let roundStart = 0;
  for (let frame = 0; frame < maxFrames && s.phase !== 'done'; frame++) {
    const b = cpuInput(brains.batter, s, 'batter');
    const p = cpuInput(brains.pitcher, s, 'pitcher');
    brains.batter = b.brain;
    brains.pitcher = p.brain;
    const r = stepBrawl(s, { batter: b.input, pitcher: p.input });
    s = r.state;
    for (const e of r.events) count(stats, e);
    for (const e of r.events) {
      if (e.k === 'fight') roundStart = frame;
      if (e.k === 'ko' || e.k === 'timeUp') stats.roundSeconds.push((frame - roundStart) / 60);
      if (e.k === 'timeUp') stats.timeUps += 1;
    }
  }
  stats.winner = s.winner;
  stats.rounds = s.results.length;
  return stats;
}

function count(stats: BrawlStats, e: BrawlEvent): void {
  switch (e.k) {
    case 'hit':
      if (e.blocked) stats.blocked[e.attacker] += 1;
      else stats.hits[e.attacker] += 1;
      stats.damage[e.attacker] += e.damage;
      if (!e.blocked) stats.maxCombo = Math.max(stats.maxCombo, e.combo);
      break;
    case 'special':
      stats.specials[e.side] += 1;
      break;
    case 'super':
      stats.supers[e.side] += 1;
      break;
    case 'throw':
      stats.throws[e.side] += 1;
      break;
    case 'dizzy':
      stats.dizzies[e.side] += 1;
      break;
    default:
      break;
  }
}

/** 36通り（巡回の出だし 6×6）を戦わせてまとめる */
export interface MatchupSummary {
  batterWins: number;
  pitcherWins: number;
  games: number;
  avgRoundSeconds: number;
  timeUpRate: number;
  avgRounds: number;
  hitsPerRound: number;
  blockRate: number;
  specialsPerRound: number;
  throwsPerRound: number;
  maxCombo: number;
}

export function matchup(batter: FighterLoadout, pitcher: FighterLoadout, spread = 6): MatchupSummary {
  let bw = 0;
  let pw = 0;
  let rounds = 0;
  let seconds = 0;
  let timeUps = 0;
  let hits = 0;
  let blocked = 0;
  let specials = 0;
  let throws = 0;
  let maxCombo = 0;
  let games = 0;
  for (let i = 0; i < spread; i++) {
    for (let j = 0; j < spread; j++) {
      const r = simulateBrawl({ batter, pitcher }, { batter: i, pitcher: j });
      games += 1;
      if (r.winner === 'batter') bw += 1;
      if (r.winner === 'pitcher') pw += 1;
      rounds += r.rounds;
      seconds += r.roundSeconds.reduce((a, b) => a + b, 0);
      timeUps += r.timeUps;
      hits += r.hits.batter + r.hits.pitcher;
      blocked += r.blocked.batter + r.blocked.pitcher;
      specials += r.specials.batter + r.specials.pitcher;
      throws += r.throws.batter + r.throws.pitcher;
      maxCombo = Math.max(maxCombo, r.maxCombo);
    }
  }
  return {
    batterWins: bw,
    pitcherWins: pw,
    games,
    avgRoundSeconds: rounds > 0 ? seconds / rounds : 0,
    timeUpRate: rounds > 0 ? timeUps / rounds : 0,
    avgRounds: rounds / games,
    hitsPerRound: rounds > 0 ? hits / rounds : 0,
    blockRate: hits + blocked > 0 ? blocked / (hits + blocked) : 0,
    specialsPerRound: rounds > 0 ? specials / rounds : 0,
    throwsPerRound: rounds > 0 ? throws / rounds : 0,
    maxCombo,
  };
}
