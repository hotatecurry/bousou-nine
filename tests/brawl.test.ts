/**
 * 乱闘v3（ストIIのゲーム性。フェーズXX-72）のエンジン。
 *
 * 判定はすべて1フレーム＝1/60秒の固定の時計で、同じ入力なら同じ結果になる（決定的）。
 * ここでは「ストIIらしさ」を作っている約束を固定する：歩き・ジャンプ・後ろ入れガード・
 * 中段／下段の二択・投げと投げ抜け・飛び道具と削り・無敵対空・キャンセル・ラウンド制。
 */
import { describe, expect, it } from 'vitest';
import {
  type BrawlEvent,
  type BrawlLoadouts,
  type BrawlSide,
  type BrawlState,
  type FighterLoadout,
  BRAWL_MAX_HP,
  DEFAULT_LOADOUT,
  FIGHT_CALL_AT,
  INTRO_FRAMES,
  JUMP_HEIGHT,
  KO_FRAMES,
  MATCH_END_FRAMES,
  MAX_GAP,
  METER_MAX,
  MOVES,
  NO_PASSIVES,
  PROJECTILES,
  ROUND_END_FRAMES,
  STAGE_HALF,
  TIME_UP_FRAMES,
  WALK_BACK,
  WALK_FORWARD,
  brawlLoser,
  createBrawlState,
  hurtboxOf,
  moveList,
  stepBrawl,
} from '../src/core/brawl';
import { type FrameInput, NEUTRAL_INPUT } from '../src/core/brawlCommand';

type Pad = Partial<FrameInput>;

function pad(p: Pad = {}): FrameInput {
  return { ...NEUTRAL_INPUT, ...p };
}

/** 本番の流れ（開幕の `第1ラウンド`→`ファイト！`）を飛ばして、戦える状態から始める */
function fightState(loadouts?: Partial<BrawlLoadouts>): BrawlState {
  let s = createBrawlState({ batter: DEFAULT_LOADOUT, pitcher: DEFAULT_LOADOUT, ...loadouts });
  for (let i = 0; i < INTRO_FRAMES + 1; i++) s = stepBrawl(s, { batter: pad(), pitcher: pad() }).state;
  expect(s.phase).toBe('fight');
  return s;
}

/** 入力の列を1フレームずつ流す（止まっている間＝ヒットストップも1フレームとして数える） */
function run(
  s: BrawlState,
  frames: number,
  inputs: (i: number) => Partial<Record<BrawlSide, Pad>> = () => ({}),
): { state: BrawlState; events: BrawlEvent[] } {
  const events: BrawlEvent[] = [];
  for (let i = 0; i < frames; i++) {
    const inp = inputs(i);
    const r = stepBrawl(s, { batter: pad(inp.batter), pitcher: pad(inp.pitcher) });
    s = r.state;
    events.push(...r.events);
  }
  return { state: s, events };
}

/** 2人の間合いを決めて置き直す（テスト用） */
function placeAt(s: BrawlState, batterX: number, pitcherX: number): BrawlState {
  return {
    ...s,
    batter: { ...s.batter, x: batterX, facing: batterX < pitcherX ? 1 : -1 },
    pitcher: { ...s.pitcher, x: pitcherX, facing: pitcherX < batterX ? 1 : -1 },
  };
}

const withSpecials = (...specials: FighterLoadout['specials']): FighterLoadout => ({
  ...DEFAULT_LOADOUT,
  specials,
});

describe('ラウンドの始まり', () => {
  it('開幕は動けない（`第1ラウンド`→`ファイト！`の間）', () => {
    let s = createBrawlState();
    const x0 = s.batter.x;
    const r = run(s, FIGHT_CALL_AT, () => ({ batter: { x: 1 } }));
    s = r.state;
    expect(s.batter.x).toBeCloseTo(x0);
    expect(r.events.some((e) => e.k === 'round')).toBe(true);
    expect(r.events.some((e) => e.k === 'fight')).toBe(true);
  });

  it('開幕が明けたら戦える', () => {
    const s = fightState();
    expect(s.round).toBe(1);
    expect(s.batter.hp).toBe(BRAWL_MAX_HP);
  });
});

describe('歩き・ジャンプ・間合い', () => {
  it('前歩きは後ろ歩きより速い（下がり続けるだけでは逃げ切れない）', () => {
    expect(WALK_FORWARD).toBeGreaterThan(WALK_BACK);
    const s = fightState();
    const fwd = run(s, 30, () => ({ batter: { x: 1 } })).state;
    const back = run(s, 30, () => ({ batter: { x: -1 } })).state;
    expect(fwd.batter.x - s.batter.x).toBeCloseTo(WALK_FORWARD * 30, 5);
    expect(s.batter.x - back.batter.x).toBeCloseTo(WALK_BACK * 30, 5);
  });

  it('ジャンプは踏み切ってから放物線を描き、同じ高さの頂点で降りてくる', () => {
    let s = fightState();
    let top = 0;
    s = run(s, 1, () => ({ batter: { y: 1 } })).state;
    for (let i = 0; i < 60; i++) {
      s = run(s, 1).state;
      top = Math.max(top, s.batter.y);
    }
    expect(top).toBeGreaterThan(JUMP_HEIGHT * 0.95);
    expect(top).toBeLessThan(JUMP_HEIGHT * 1.05);
    expect(s.batter.y).toBe(0);
  });

  it('2人は重ならない（押し合う）', () => {
    const s = run(placeAt(fightState(), -0.2, 0.2), 20, () => ({ batter: { x: 1 }, pitcher: { x: -1 } })).state;
    expect(s.pitcher.x - s.batter.x).toBeGreaterThanOrEqual(0.6 - 1e-6);
  });

  it('画面に2人とも収まる距離より離れられない', () => {
    const s = run(fightState(), 400, () => ({ batter: { x: -1 }, pitcher: { x: 1 } })).state;
    expect(s.pitcher.x - s.batter.x).toBeLessThanOrEqual(MAX_GAP + 1e-6);
    expect(s.batter.x).toBeGreaterThanOrEqual(-STAGE_HALF);
  });
});

describe('打撃とガード', () => {
  it('突きは間合いの中なら当たって体力が減り、全体が一瞬止まる（ヒットストップ）', () => {
    const s0 = placeAt(fightState(), -0.45, 0.45);
    const r = run(s0, 12, (i) => ({ batter: { p: i === 0 } }));
    const hit = r.events.find((e) => e.k === 'hit');
    expect(hit).toBeDefined();
    expect(r.state.pitcher.hp).toBe(BRAWL_MAX_HP - MOVES.cP.damage);
  });

  it('後ろを入れていれば通常技はガードされ、削られない', () => {
    const s0 = placeAt(fightState(), -0.45, 0.45);
    // 投手は右（＝打者から離れる向き）を入れる
    const r = run(s0, 14, (i) => ({ batter: { p: i === 0 }, pitcher: { x: 1 } }));
    const hit = r.events.find((e) => e.k === 'hit');
    expect(hit && hit.k === 'hit' && hit.blocked).toBe(true);
    expect(r.state.pitcher.hp).toBe(BRAWL_MAX_HP);
  });

  it('足払い（下段）は立ちガードでは防げず、しゃがみガードなら防げる', () => {
    const s0 = placeAt(fightState(), -0.6, 0.6);
    const standBlock = run(s0, 14, (i) => ({ batter: { y: -1, k: i === 0 }, pitcher: { x: 1 } }));
    expect(standBlock.state.pitcher.hp).toBeLessThan(BRAWL_MAX_HP);
    const crouchBlock = run(s0, 14, (i) => ({ batter: { y: -1, k: i === 0 }, pitcher: { x: 1, y: -1 } }));
    expect(crouchBlock.state.pitcher.hp).toBe(BRAWL_MAX_HP);
  });

  it('跳び蹴り（中段）はしゃがみガードでは防げず、立ちガードなら防げる', () => {
    // 打者が前へ跳んで、降りてくるところで蹴る
    const jumpIn = (pitcherPad: Pad) =>
      run(placeAt(fightState(), -1.4, 0.6), 60, (i) => ({
        batter: { x: i < 2 ? 1 : 0, y: i < 2 ? 1 : 0, k: i === 22 },
        pitcher: pitcherPad,
      }));
    const crouching = jumpIn({ x: 1, y: -1 });
    expect(crouching.state.pitcher.hp).toBeLessThan(BRAWL_MAX_HP);
    const standing = jumpIn({ x: 1 });
    expect(standing.state.pitcher.hp).toBe(BRAWL_MAX_HP);
    expect(standing.events.some((e) => e.k === 'hit' && e.blocked)).toBe(true);
  });

  it('当てた突きは必殺技でキャンセルできる（2発目もコンボになる）', () => {
    const s0 = placeAt(fightState({ batter: withSpecials('hadou') }), -0.45, 0.45);
    // 肘打ちを当てて、その戻りの間に ↓↘→＋P
    const r = run(s0, 60, (i) => ({
      batter:
        i === 0
          ? { p: true }
          : i === 6
            ? { y: -1 }
            : i === 7
              ? { y: -1, x: 1 }
              : i === 8
                ? { x: 1, p: true }
                : {},
    }));
    const hits = r.events.filter((e) => e.k === 'hit' && e.defender === 'pitcher');
    expect(hits.length).toBe(2);
    expect(hits[1].k === 'hit' && hits[1].combo).toBe(2);
  });
});

describe('投げ', () => {
  it('近くで横＋Pで投げる（ガードの上からでも）', () => {
    const s0 = placeAt(fightState(), -0.35, 0.35);
    const r = run(s0, 50, (i) => ({ batter: { x: 1, p: i === 0 }, pitcher: { x: 1 } }));
    expect(r.events.some((e) => e.k === 'throw')).toBe(true);
    expect(r.state.pitcher.hp).toBe(BRAWL_MAX_HP - MOVES.throw.damage);
  });

  it('同時に投げ合ったら投げ抜け（どちらも減らない）', () => {
    const s0 = placeAt(fightState(), -0.35, 0.35);
    const r = run(s0, 40, (i) => ({ batter: { x: 1, p: i === 0 }, pitcher: { x: -1, p: i === 0 } }));
    expect(r.events.some((e) => e.k === 'throwTech')).toBe(true);
    expect(r.state.batter.hp).toBe(BRAWL_MAX_HP);
    expect(r.state.pitcher.hp).toBe(BRAWL_MAX_HP);
  });
});

describe('必殺技', () => {
  /** ↓↘→＋P */
  const qcfP = (start: number) => (i: number): Pad =>
    i === start ? { y: -1 } : i === start + 1 ? { y: -1, x: 1 } : i === start + 2 ? { x: 1, p: true } : {};

  it('波動拳は飛び道具を出し、当たれば減り、ガードされても削る', () => {
    const s0 = placeAt(fightState({ batter: withSpecials('hadou') }), -2, 1.5);
    const hit = run(s0, 120, (i) => ({ batter: qcfP(0)(i) }));
    expect(hit.events.some((e) => e.k === 'projectile')).toBe(true);
    expect(hit.state.pitcher.hp).toBe(BRAWL_MAX_HP - PROJECTILES.hadou.damage);
    const blocked = run(s0, 120, (i) => ({ batter: qcfP(0)(i), pitcher: { x: 1 } }));
    expect(blocked.state.pitcher.hp).toBe(BRAWL_MAX_HP - PROJECTILES.hadou.chip);
  });

  it('波動拳は1発ずつ（画面に自分の弾があるうちは次が出ない）', () => {
    const s0 = placeAt(fightState({ batter: withSpecials('hadou') }), -3, 3);
    const r = run(s0, 80, (i) => ({ batter: { ...qcfP(0)(i), ...qcfP(50)(i) } }));
    expect(r.events.filter((e) => e.k === 'projectile').length).toBe(1);
  });

  it('飛び道具どうしは打ち消し合う', () => {
    const lo = { batter: withSpecials('hadou'), pitcher: withSpecials('hadou') };
    const s0 = placeAt(fightState(lo), -2.5, 2.5);
    const qcfLeft = (i: number): Pad =>
      i === 0 ? { y: -1 } : i === 1 ? { y: -1, x: -1 } : i === 2 ? { x: -1, p: true } : {};
    const r = run(s0, 120, (i) => ({ batter: qcfP(0)(i), pitcher: qcfLeft(i) }));
    expect(r.events.some((e) => e.k === 'clash')).toBe(true);
    expect(r.state.batter.hp).toBe(BRAWL_MAX_HP);
    expect(r.state.pitcher.hp).toBe(BRAWL_MAX_HP);
  });

  it('昇龍拳は出だしが無敵（重なっている打撃がすり抜ける）', () => {
    const s0 = placeAt(fightState({ batter: withSpecials('shoryu') }), -0.45, 0.45);
    // 打者が →↓↘＋P。そのフレームに投手の肘打ちが重なっても打者は減らない
    let s = run(s0, 3, (i) => ({ batter: i === 0 ? { x: 1 } : i === 1 ? { y: -1 } : { y: -1, x: 1, p: true } })).state;
    expect(s.batter.act.k).toBe('attack');
    for (let i = 0; i < 6; i++) {
      expect(hurtboxOf(s.batter)).toBeNull();
      s = run(s, 1).state;
    }
  });

  it('頭突きは後ろを溜めてから前＋P（溜めが足りなければ出ない）', () => {
    const s0 = placeAt(fightState({ batter: withSpecials('zutsuki') }), -2, 1.5);
    const charged = run(s0, 80, (i) => ({ batter: i < 45 ? { x: -1 } : i === 45 ? { x: 1, p: true } : {} }));
    expect(charged.events.some((e) => e.k === 'special' && e.move === 'zutsuki')).toBe(true);
    const short = run(s0, 40, (i) => ({ batter: i < 10 ? { x: -1 } : i === 10 ? { x: 1, p: true } : {} }));
    expect(short.events.some((e) => e.k === 'special')).toBe(false);
  });

  it('技表は持っている技だけを「その人が押す向き」で出す', () => {
    const lo = withSpecials('hadou', 'shoryu');
    expect(moveList(lo, 1).map((m) => m.notation)).toEqual(['↓↘→+P', '→↓↘+P']);
    expect(moveList(lo, -1).map((m) => m.notation)).toEqual(['↓↙←+P', '←↓↙+P']);
    expect(moveList(DEFAULT_LOADOUT, 1)).toEqual([]);
  });
});

describe('超必殺とゲージ', () => {
  it('ゲージ満タンでGを押すと超必殺（暗転で全体が止まる）', () => {
    const lo: FighterLoadout = { ...DEFAULT_LOADOUT, super: 'shinku' };
    let s = placeAt(fightState({ batter: lo }), -2, 2);
    s = { ...s, batter: { ...s.batter, meter: METER_MAX } };
    const r = run(s, 200, (i) => ({ batter: { s: i === 0 } }));
    expect(r.events.some((e) => e.k === 'super')).toBe(true);
    const hits = r.events.filter((e) => e.k === 'hit' && e.defender === 'pitcher');
    expect(hits.length).toBe(PROJECTILES.shinku.hits);
  });

  it('ゲージが足りなければGを押しても何も起きない', () => {
    const lo: FighterLoadout = { ...DEFAULT_LOADOUT, super: 'shinku' };
    const s = placeAt(fightState({ batter: lo }), -2, 2);
    const r = run(s, 30, (i) => ({ batter: { s: i === 0 } }));
    expect(r.events.some((e) => e.k === 'super')).toBe(false);
  });

  it('当てても食らってもゲージが溜まる', () => {
    const s0 = placeAt(fightState(), -0.45, 0.45);
    const r = run(s0, 20, (i) => ({ batter: { p: i === 0 } }));
    expect(r.state.batter.meter).toBeGreaterThan(0);
    expect(r.state.pitcher.meter).toBeGreaterThan(0);
  });
});

describe('ラウンド制（2本先取・60秒）', () => {
  it('KOで勝ち名乗り→次のラウンド、2本取ったら決着して負けた側が分かる', () => {
    let s = fightState();
    // 投手の体力を1にして肘打ちで倒す（を2ラウンド）
    for (let round = 1; round <= 2; round++) {
      s = placeAt({ ...s, pitcher: { ...s.pitcher, hp: 1 } }, -0.45, 0.45);
      s = run(s, 12, (i) => ({ batter: { p: i === 0 } })).state;
      expect(s.phase).toBe('ko');
      s = run(s, KO_FRAMES + ROUND_END_FRAMES + 2).state;
      if (round === 1) {
        expect(s.phase).toBe('intro');
        expect(s.batter.roundWins).toBe(1);
        expect(s.pitcher.hp).toBe(s.pitcher.maxHp);
        s = run(s, INTRO_FRAMES + 1).state;
      }
    }
    expect(s.phase).toBe('matchEnd');
    s = run(s, MATCH_END_FRAMES + 1).state;
    expect(s.phase).toBe('done');
    expect(brawlLoser(s)).toBe('pitcher');
  });

  it('時間切れは体力の割合が多いほうの勝ち（最大値が違っても割合で比べる）', () => {
    const tough: FighterLoadout = { ...DEFAULT_LOADOUT, maxHp: 240 };
    let s = fightState({ pitcher: tough });
    // 打者 60/120（50%）・投手 132/240（55%）＝投手の勝ち
    s = { ...s, timer: 1, batter: { ...s.batter, hp: 60 }, pitcher: { ...s.pitcher, hp: 132 } };
    s = run(s, 2).state;
    expect(s.phase).toBe('timeUp');
    s = run(s, TIME_UP_FRAMES + 1).state;
    expect(s.pitcher.roundWins).toBe(1);
  });
});

describe('ピヨり・決定性', () => {
  it('続けて食らうとピヨる', () => {
    let s = placeAt(fightState(), -0.45, 0.45);
    s = { ...s, pitcher: { ...s.pitcher, stun: 58 } };
    const r = run(s, 40, (i) => ({ batter: { p: i === 0 } }));
    expect(r.events.some((e) => e.k === 'dizzy')).toBe(true);
  });

  it('同じ入力なら同じ結果（乱数を使わない）', () => {
    const script = (i: number): Partial<Record<BrawlSide, Pad>> => ({
      batter: { x: i % 40 < 20 ? 1 : -1, p: i % 17 === 0, k: i % 23 === 0 },
      pitcher: { x: i % 30 < 15 ? -1 : 1, y: i % 50 === 0 ? 1 : 0, p: i % 13 === 0 },
    });
    const a = run(fightState(), 600, script).state;
    const b = run(fightState(), 600, script).state;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('素の選手は必殺技も超必殺も持たない（技は通常技と投げだけ）', () => {
    expect(DEFAULT_LOADOUT.specials).toEqual([]);
    expect(DEFAULT_LOADOUT.super).toBeNull();
    expect(DEFAULT_LOADOUT.passives).toEqual(NO_PASSIVES);
  });
});
