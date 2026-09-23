import { describe, expect, it } from 'vitest';
import {
  type BrawlLoadouts,
  type BrawlSide,
  type BrawlState,
  type FighterLoadout,
  type MoveId,
  BRAWL_MAX_HP,
  COMBO_SCALING,
  DEFAULT_LOADOUT,
  DEFAULT_LOADOUTS,
  GUARD_DAMAGE_MULTIPLIER,
  MOVES,
  MOVE_NAME,
  brawlLoser,
  canAct,
  canCancelInto,
  canUseMove,
  commandMoves,
  createBrawlState,
  isDefeated,
  isThrowable,
  moveForCommand,
  setGuarding,
  stepBrawl,
  tryStartAttack,
} from '../src/core/brawl';

const DT = 1 / 60;

/** 必殺技はスキルが配る（F-26-1／G-27）ので、扱うテストはこの装備を明示的に渡す */
const SHORYU_LOADOUT: FighterLoadout = { ...DEFAULT_LOADOUT, moves: [...DEFAULT_LOADOUT.moves, 'shoryu'] };
const SHORYU_LOADOUTS: BrawlLoadouts = { batter: SHORYU_LOADOUT, pitcher: SHORYU_LOADOUT };
const FULL_LOADOUT: FighterLoadout = {
  ...DEFAULT_LOADOUT,
  moves: [...DEFAULT_LOADOUT.moves, 'shoryu', 'buki', 'batto'],
};

function shoryuState(): BrawlState {
  return createBrawlState(SHORYU_LOADOUTS);
}

function advance(state: BrawlState, seconds: number) {
  let s = state;
  const steps = Math.ceil(seconds / DT) + 1;
  let hits: ReturnType<typeof stepBrawl>['hits'] = [];
  for (let i = 0; i < steps; i++) {
    const result = stepBrawl(s, DT);
    s = result.state;
    if (result.hits.length > 0) hits = hits.concat(result.hits);
  }
  return { state: s, hits };
}

/** その技を出して、当たる（または空振りが確定する）ところまで進める */
function land(state: BrawlState, side: BrawlSide, move: MoveId, loadout = DEFAULT_LOADOUT) {
  const started: BrawlState = { ...state, [side]: tryStartAttack(state[side], move, loadout) };
  return advance(started, MOVES[move].startupSec + DT);
}

describe('tryStartAttack / setGuarding: 行動の受付', () => {
  it('idle からのみ技を出せる', () => {
    const state = createBrawlState();
    const started = tryStartAttack(state.batter, 'jab');
    expect(started.phase).toBe('startup');
    expect(started.pendingMove).toBe('jab');
  });

  it('startup 中に別の技を出そうとしても無視される（連打不可）', () => {
    const state = createBrawlState();
    const started = tryStartAttack(state.batter, 'jab');
    const again = tryStartAttack(started, 'punch');
    expect(again).toEqual(started);
  });

  it('技を出すとガード中フラグは解除される', () => {
    const state = createBrawlState();
    const guarding = setGuarding(state.batter, true);
    const attacking = tryStartAttack(guarding, 'punch');
    expect(attacking.guarding).toBe(false);
  });

  it('idle 以外ではガード設定を受け付けない（隙の間は防御に切り替えられない）', () => {
    const state = createBrawlState();
    const started = tryStartAttack(state.batter, 'punch');
    const guarded = setGuarding(started, true);
    expect(guarded).toEqual(started);
  });
});

// ---- 三すくみ（ガード・投げ・打撃）＝v2の骨格 ----

describe('三すくみ：ガードは打撃を防ぐが、投げには無力', () => {
  it('ガードしていなければ技の威力どおりダメージが通る', () => {
    const { hits, state } = land(createBrawlState(), 'batter', 'punch');
    expect(hits[0].damage).toBe(MOVES.punch.power);
    expect(hits[0].guarded).toBe(false);
    expect(state.pitcher.hp).toBe(BRAWL_MAX_HP - MOVES.punch.power);
  });

  it('ガード中の打撃は大幅に軽減される', () => {
    const base = createBrawlState();
    const guarding: BrawlState = { ...base, pitcher: setGuarding(base.pitcher, true) };
    const { hits } = land(guarding, 'batter', 'punch');
    expect(hits[0].guarded).toBe(true);
    expect(hits[0].damage).toBe(Math.round(MOVES.punch.power * GUARD_DAMAGE_MULTIPLIER));
  });

  it('投げはガード中でも全ダメージが通る（ガードを崩す唯一の手段）', () => {
    const base = createBrawlState();
    const guarding: BrawlState = { ...base, pitcher: setGuarding(base.pitcher, true) };
    const { hits } = land(guarding, 'batter', 'throw');
    expect(hits[0].guarded).toBe(false);
    expect(hits[0].damage).toBe(MOVES.throw.power);
  });

  it('投げは棒立ちの相手にも通る', () => {
    const { hits } = land(createBrawlState(), 'batter', 'throw');
    expect(hits[0].damage).toBe(MOVES.throw.power);
  });

  it('技を出している相手は投げられない（暴れが投げに勝つ）', () => {
    const base = createBrawlState();
    // 相手はパンチの起こり中（startup が投げの発生より長いので、投げた瞬間はまだ攻撃中）
    const busy: BrawlState = { ...base, pitcher: tryStartAttack(base.pitcher, 'punch') };
    expect(isThrowable(busy.pitcher)).toBe(false);
    const { hits, state } = land(busy, 'batter', 'throw');
    expect(hits[0].whiffed).toBe(true);
    expect(hits[0].damage).toBe(0);
    expect(state.pitcher.hp).toBe(BRAWL_MAX_HP);
  });

  it('投げの空振りは通常より長い隙になる（リスクの実体）', () => {
    const base = createBrawlState();
    const busy: BrawlState = { ...base, pitcher: tryStartAttack(base.pitcher, 'punch') };
    const { state } = land(busy, 'batter', 'throw');
    expect(state.batter.phase).toBe('recovery');
    expect(state.batter.timer).toBeGreaterThan(MOVES.throw.recoverySec);
    expect(MOVES.throw.whiffRecoverySec).toBeGreaterThan(MOVES.throw.recoverySec);
  });

  it('のけぞり中の相手も投げられない（投げっぱなしのループにならない）', () => {
    const { state } = land(createBrawlState(), 'batter', 'jab');
    expect(state.pitcher.phase).toBe('hitstun');
    expect(isThrowable(state.pitcher)).toBe(false);
  });
});

describe('硬直：食らった側・ガードした側は動けない', () => {
  it('食らった側はのけぞっている間なにも出せない', () => {
    const { state } = land(createBrawlState(), 'batter', 'punch');
    expect(state.pitcher.phase).toBe('hitstun');
    expect(canAct(state.pitcher)).toBe(false);
    expect(tryStartAttack(state.pitcher, 'jab')).toEqual(state.pitcher);
  });

  it('のけぞりが明ければ idle に戻る', () => {
    const { state } = land(createBrawlState(), 'batter', 'punch');
    const { state: later } = advance(state, MOVES.punch.hitstunSec + DT);
    expect(later.pitcher.phase).toBe('idle');
    expect(canAct(later.pitcher)).toBe(true);
  });

  it('ガードした側のほうが先に動ける（守り切ればこちらの番になる）', () => {
    const base = createBrawlState();
    const guarding: BrawlState = { ...base, pitcher: setGuarding(base.pitcher, true) };
    const { state } = land(guarding, 'batter', 'punch');
    expect(state.pitcher.phase).toBe('guardstun');
    // ガード硬直が明けた時点では、攻撃側はまだ硬直中
    const { state: later } = advance(state, MOVES.punch.guardstunSec + DT);
    expect(later.pitcher.phase).toBe('idle');
    expect(later.batter.phase).toBe('recovery');
    expect(MOVES.punch.guardstunSec).toBeLessThan(MOVES.punch.recoverySec);
  });

  it('命中後は recovery を経て idle に戻る', () => {
    const { state } = land(createBrawlState(), 'batter', 'jab');
    expect(state.batter.phase).toBe('recovery');
    const { state: later } = advance(state, MOVES.jab.recoverySec + DT);
    expect(later.batter.phase).toBe('idle');
  });
});

describe('コンボ：当てた技はキャンセルして格上の技へ繋げられる', () => {
  it('当てた直後は硬直をキャンセルできる', () => {
    const { state } = land(createBrawlState(), 'batter', 'jab');
    expect(state.batter.cancelable).toBe(true);
    expect(canCancelInto(state.batter, 'punch')).toBe(true);
    const next = tryStartAttack(state.batter, 'punch');
    expect(next.phase).toBe('startup');
    expect(next.pendingMove).toBe('punch');
  });

  it('同じ技・格下へはキャンセルできない（ジャブ連打で永久に繋がらない）', () => {
    const { state } = land(createBrawlState(), 'batter', 'jab');
    expect(canCancelInto(state.batter, 'jab')).toBe(false);
    expect(tryStartAttack(state.batter, 'jab')).toEqual(state.batter);
    const { state: afterPunch } = land(createBrawlState(), 'batter', 'punch');
    expect(canCancelInto(afterPunch.batter, 'jab')).toBe(false);
  });

  it('ガードされたらキャンセルできない（ガードの価値そのもの）', () => {
    const base = createBrawlState();
    const guarding: BrawlState = { ...base, pitcher: setGuarding(base.pitcher, true) };
    const { state } = land(guarding, 'batter', 'jab');
    expect(state.batter.cancelable).toBe(false);
    expect(tryStartAttack(state.batter, 'punch')).toEqual(state.batter);
  });

  it('繋いだ2発目はコンボ補正で軽くなる', () => {
    const { state } = land(createBrawlState(), 'batter', 'jab');
    const canceled: BrawlState = { ...state, batter: tryStartAttack(state.batter, 'punch') };
    const { hits } = advance(canceled, MOVES.punch.startupSec + DT);
    expect(hits[0].combo).toBe(2);
    expect(hits[0].damage).toBe(Math.round(MOVES.punch.power * COMBO_SCALING[1]));
  });

  it('繋がる条件は秒数の比較だけ（次の技の発生 < 相手ののけぞり）', () => {
    // ジャブ→パンチ→ショウリュウケンの3段が成立する並びであることを表で固定する
    expect(MOVES.punch.startupSec).toBeLessThan(MOVES.jab.hitstunSec);
    expect(MOVES.shoryu.startupSec).toBeLessThan(MOVES.punch.hitstunSec);
    expect(MOVES.buki.startupSec).toBeLessThan(MOVES.shoryu.hitstunSec);
    expect(MOVES.batto.startupSec).toBeLessThan(MOVES.buki.hitstunSec);
  });

  it('3発目までキャンセルで繋がり、コンボ数が伸びる', () => {
    let state = land(shoryuState(), 'batter', 'jab').state;
    state = { ...state, batter: tryStartAttack(state.batter, 'punch', SHORYU_LOADOUT) };
    const second = advance(state, MOVES.punch.startupSec + DT);
    state = second.state;
    state = { ...state, batter: tryStartAttack(state.batter, 'shoryu', SHORYU_LOADOUT) };
    const third = advance(state, MOVES.shoryu.startupSec + DT);
    expect(third.hits[0].combo).toBe(3);
    expect(third.hits[0].damage).toBe(Math.round(MOVES.shoryu.power * COMBO_SCALING[2]));
  });

  it('相手が立ち直ればコンボは途切れ、次の技は1発目に戻る', () => {
    const first = land(createBrawlState(), 'batter', 'jab');
    expect(first.state.batter.combo).toBe(1);
    const { state } = advance(first.state, MOVES.jab.hitstunSec + DT);
    expect(state.batter.combo).toBe(0);
    const again = land(state, 'batter', 'jab');
    expect(again.hits[0].combo).toBe(1);
    expect(again.hits[0].damage).toBe(MOVES.jab.power);
  });

  it('投げはコンボの入口にも出口にもならない', () => {
    const { state } = land(createBrawlState(), 'batter', 'jab');
    // 掴んで繋ぐことはできない
    expect(canCancelInto(state.batter, 'throw')).toBe(false);
    // 投げを当てても硬直がのけぞりより長いので、投げた側が動く頃には相手も動ける
    const thrown = land(createBrawlState(), 'batter', 'throw');
    expect(thrown.state.batter.cancelable).toBe(false);
    expect(MOVES.throw.recoverySec).toBeGreaterThan(MOVES.throw.hitstunSec);
  });

  it('コンボ補正は4発目以降も下限で止まる（延々と軽くならない）', () => {
    expect(COMBO_SCALING[COMBO_SCALING.length - 1]).toBeGreaterThan(0);
    expect(COMBO_SCALING.every((v, i) => i === 0 || v <= COMBO_SCALING[i - 1])).toBe(true);
  });
});

// ---- 装備（フェーズF-26-1／G-27。ローグライトのスキルがここへ翻訳されて渡る） ----

describe('FighterLoadout: スキルによる装備', () => {
  it('既定の装備はジャブ・パンチ・投げの3つ（必殺技はスキルが配る）', () => {
    expect(DEFAULT_LOADOUT.moves).toEqual(['jab', 'punch', 'throw']);
    expect(canUseMove(DEFAULT_LOADOUT, 'shoryu')).toBe(false);
    const state = createBrawlState();
    expect(tryStartAttack(state.batter, 'shoryu')).toEqual(state.batter);
  });

  it('素の選手でも三すくみは全部使える（引けなかった試合の乱闘が成立する）', () => {
    for (const move of ['jab', 'punch', 'throw'] as const) {
      expect(canUseMove(DEFAULT_LOADOUT, move)).toBe(true);
    }
  });

  it('装備で解禁されていれば必殺技が出る', () => {
    const started = tryStartAttack(shoryuState().batter, 'shoryu', SHORYU_LOADOUT);
    expect(started.phase).toBe('startup');
    expect(started.pendingMove).toBe('shoryu');
  });

  it('コマンドから技を引ける（持っていなければ null）', () => {
    expect(moveForCommand(SHORYU_LOADOUT, 'dp')).toBe('shoryu');
    expect(moveForCommand(DEFAULT_LOADOUT, 'dp')).toBeNull();
    expect(moveForCommand(FULL_LOADOUT, 'charge')).toBe('buki');
    expect(moveForCommand(FULL_LOADOUT, 'super')).toBe('batto');
  });

  it('必殺技はすべてコマンドを持ち、通常技は持たない（技表に出るのは必殺技だけ）', () => {
    expect(commandMoves(FULL_LOADOUT)).toEqual(['shoryu', 'buki', 'batto']);
    expect(commandMoves(DEFAULT_LOADOUT)).toEqual([]);
    for (const move of ['jab', 'punch', 'throw'] as const) {
      expect(MOVES[move].command).toBeUndefined();
    }
  });

  it('技名は全角8文字以内（HUDの技表の幅がデータで崩れない）', () => {
    for (const name of Object.values(MOVE_NAME)) {
      expect(name.length).toBeLessThanOrEqual(8);
    }
  });

  it('コマンドが要る技ほど強い（難しさとリターンが釣り合っている）', () => {
    expect(MOVES.shoryu.power).toBeGreaterThan(MOVES.punch.power);
    expect(MOVES.buki.power).toBeGreaterThan(MOVES.shoryu.power);
    expect(MOVES.batto.power).toBeGreaterThan(MOVES.buki.power);
    // 強い技ほど隙も大きい（当たらなければ損をする）
    expect(MOVES.batto.recoverySec).toBeGreaterThan(MOVES.jab.recoverySec);
  });

  it('装備を省略した createBrawlState はスキルを持ち込む前と同じ強さになる', () => {
    const state = createBrawlState();
    expect(state.loadouts).toEqual(DEFAULT_LOADOUTS);
    expect(state.batter.hp).toBe(BRAWL_MAX_HP);
    expect(state.batter.maxHp).toBe(BRAWL_MAX_HP);
  });

  it('体力の上乗せは maxHp と初期HPの両方に効く（HUDのゲージが満タンから始まる）', () => {
    const tough: FighterLoadout = { ...DEFAULT_LOADOUT, maxHp: BRAWL_MAX_HP + 30 };
    const state = createBrawlState({ batter: tough, pitcher: DEFAULT_LOADOUT });
    expect(state.batter.hp).toBe(BRAWL_MAX_HP + 30);
    expect(state.batter.maxHp).toBe(BRAWL_MAX_HP + 30);
    expect(state.pitcher.maxHp).toBe(BRAWL_MAX_HP);
  });

  it('威力倍率は攻撃側の装備で決まる（ブキモチコミ）', () => {
    const armed: FighterLoadout = { ...DEFAULT_LOADOUT, powerScale: 1.5 };
    const state = createBrawlState({ batter: armed, pitcher: DEFAULT_LOADOUT });
    const { hits } = land(state, 'batter', 'punch', armed);
    expect(hits[0].damage).toBe(Math.round(MOVES.punch.power * 1.5));
  });

  it('威力倍率はガード時の軽減とも噛み合う（先に倍率、その後に軽減）', () => {
    const armed: FighterLoadout = { ...DEFAULT_LOADOUT, powerScale: 1.5 };
    const base = createBrawlState({ batter: armed, pitcher: DEFAULT_LOADOUT });
    const guarding: BrawlState = { ...base, pitcher: setGuarding(base.pitcher, true) };
    const { hits } = land(guarding, 'batter', 'punch', armed);
    expect(hits[0].guarded).toBe(true);
    expect(hits[0].damage).toBe(Math.round(MOVES.punch.power * 1.5 * GUARD_DAMAGE_MULTIPLIER));
  });

  it('stepBrawl は装備をそのまま持ち回る（プレー中に装備が消えない）', () => {
    const { state } = advance(shoryuState(), 0.5);
    expect(state.loadouts).toEqual(SHORYU_LOADOUTS);
  });
});

describe('決着判定', () => {
  it('HPが0になった側が defeated になり、以後行動できない', () => {
    const base = shoryuState();
    const nearDead: BrawlState = { ...base, pitcher: { ...base.pitcher, hp: 1 } };
    const { state } = land(nearDead, 'batter', 'shoryu', SHORYU_LOADOUT);
    expect(isDefeated(state.pitcher)).toBe(true);
    expect(canAct(state.pitcher)).toBe(false);
    expect(brawlLoser(state)).toBe('pitcher');
  });

  it('ダメージはHP0未満に潜らない', () => {
    const base = shoryuState();
    const nearDead: BrawlState = { ...base, pitcher: { ...base.pitcher, hp: 3 } };
    const { state } = land(nearDead, 'batter', 'shoryu', SHORYU_LOADOUT);
    expect(state.pitcher.hp).toBe(0);
  });

  it('決着前は brawlLoser が null を返す', () => {
    expect(brawlLoser(createBrawlState())).toBeNull();
  });

  it('倒れた相手を殴っても何も起きない（決着後の空振り）', () => {
    const base = createBrawlState();
    const down: BrawlState = { ...base, pitcher: { ...base.pitcher, hp: 0, phase: 'defeated' } };
    const { hits, state } = land(down, 'batter', 'punch');
    expect(hits).toHaveLength(0);
    expect(state.pitcher.hp).toBe(0);
  });

  it('同時KO（同フレーム）はHPがより低い方を敗者とする', () => {
    const base = createBrawlState();
    const state: BrawlState = {
      ...base,
      batter: { ...base.batter, hp: 0, phase: 'defeated' },
      pitcher: { ...base.pitcher, hp: 5, phase: 'defeated' },
    };
    expect(brawlLoser(state)).toBe('batter');
  });

  it('同時KOでHPが完全に同値なら打者を敗者とする', () => {
    const base = createBrawlState();
    const state: BrawlState = {
      ...base,
      batter: { ...base.batter, hp: 0, phase: 'defeated' },
      pitcher: { ...base.pitcher, hp: 0, phase: 'defeated' },
    };
    expect(brawlLoser(state)).toBe('batter');
  });
});

describe('純粋性', () => {
  it('stepBrawl は入力の state を変更しない', () => {
    const state = createBrawlState();
    const started: BrawlState = { ...state, batter: tryStartAttack(state.batter, 'jab') };
    const snapshot = JSON.parse(JSON.stringify(started));
    stepBrawl(started, MOVES.jab.startupSec + DT);
    expect(started).toEqual(snapshot);
  });

  it('同じ入力は常に同じ結果になる（乱数不使用）', () => {
    const run = () => land(createBrawlState(), 'batter', 'punch').state.pitcher.hp;
    const results = new Set(Array.from({ length: 10 }, run));
    expect(results.size).toBe(1);
  });
});
