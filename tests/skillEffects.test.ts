/**
 * 一時効果（フェーズM-33。CLAUDE.md ⑧「一時効果」）。
 *
 * **`duration` は効果の種類ではなく「効く長さ」の軸**で、既存の3つの形
 * （`modifier` / `play` / `brawl`）に掛け合わせる。だからここで固定したいのは
 * 個々の数字より、**「切ると既存の導出経路がそのまま動き、打席が終わると同時に止まる」
 * というひと続きの流れ**のほう（`skillCharges.test.ts` がチャージの寿命について
 * 同じ立て方をしているのと対）。
 *
 * 消費（チャージ）そのものの規則は F-26-8 の仕組みに丸乗りしているので、ここでは
 * 「一時効果もその仕組みを正しく通るか」だけを見る。
 */
import { describe, expect, it } from 'vitest';
import { createActor } from 'xstate';
import {
  activatableEffect,
  activateEffect,
  activeEffectsOf,
  chargesLeftOf,
  clearActiveEffects,
  createTeamRoster,
  currentBatterId,
  effectiveBatting,
  effectivePlay,
  effectiveSkillsOf,
  grantSkill,
  hasActiveEffect,
  hasSkillRoom,
  liveSkillsOf,
  skillsOf,
} from '../src/core/roster';
import {
  ALL_SKILL_IDS,
  DRAFTABLE_SKILL_IDS,
  DUO_SKILL_IDS,
  SKILLS,
  TEMPORARY_SKILL_IDS,
  effectRole,
  isConsumable,
  isTemporary,
  temporariesForRole,
} from '../src/core/skills';
import type { BattedBall } from '../src/core/batting';
import { CATCH_RADIUS, shouldCpuActivateCatchEffect } from '../src/core/fielding';
import { shouldCpuActivateBattingEffect } from '../src/core/cpuBatter';
import { EMPTY_BASES } from '../src/core/rules';
import { gameMachine } from '../src/core/gameMachine';
import { teamById } from '../src/core/teams';

const TEST_TEAM = teamById('foresters');
const roster = () => createTeamRoster(TEST_TEAM);
const firstBatter = (): string => currentBatterId(roster());

// ---- 名鑑側の約束 ----

describe('一時効果: 名鑑の約束（M-33）', () => {
  it('3系統（チョウノウリョク・ドウブツ・コンジョウ）に1枚ずつ入った', () => {
    const lineages = TEMPORARY_SKILL_IDS.map((id) => SKILLS[id].lineage);
    expect(new Set(lineages)).toEqual(new Set(['psychic', 'animal', 'guts']));
  });

  /**
   * **一時効果は必ず消費型**。回数券でなければ毎打席切るのが最適解になり、
   * 「いつ切るか」という判断そのものが消える（この札を入れた理由がそこにある）。
   */
  it('一時効果はすべて消費型（切り放題にしない）', () => {
    expect(TEMPORARY_SKILL_IDS.length).toBeGreaterThan(0);
    for (const id of TEMPORARY_SKILL_IDS) {
      expect(isConsumable(id), id).toBe(true);
      expect(SKILLS[id].charges, id).toBeGreaterThan(0);
    }
  });

  /**
   * **効果の中身は従来の3つの形のまま**。ここが空の一時効果は「切っても何も起きない札」
   * ＝判定側に専用の分岐を要求する形でしか実装できない。
   */
  it('一時効果は既存の3つの形（modifier/play/brawl）のどれかで効く', () => {
    for (const id of TEMPORARY_SKILL_IDS) {
      const def = SKILLS[id];
      expect(Boolean(def.modifier || def.play || def.brawl), id).toBe(true);
    }
  });

  it('一時効果は抽選プールに載る（デュオではなく運で配られる側）', () => {
    for (const id of TEMPORARY_SKILL_IDS) {
      expect(DRAFTABLE_SKILL_IDS, id).toContain(id);
    }
  });

  /**
   * **押す場所（役割）が必ず決まっている**。G の空きスロットは2つ（でっかいモードの
   * 打者側／ちっちゃいモードの守備側）しかないので、どちらでもない札は押せない＝
   * 引いても切れない死に札になる。
   */
  it('どの一時効果も押せる役割に振り分けられている', () => {
    const byRole = [...temporariesForRole('batting'), ...temporariesForRole('fielding')];
    expect(new Set(byRole)).toEqual(new Set(TEMPORARY_SKILL_IDS));
    // 守備側は捕球範囲を動かす札、打者側はそれ以外（役割の導出が効果と噛み合っている）
    for (const id of temporariesForRole('fielding')) {
      expect(SKILLS[id].play?.catchRadius, id).toBeGreaterThan(0);
    }
  });

  it('両方の役割に少なくとも1枚ずつある（どちらのGも空振りにならない）', () => {
    expect(temporariesForRole('batting').length).toBeGreaterThan(0);
    expect(temporariesForRole('fielding').length).toBeGreaterThan(0);
  });

  /** 一時効果にも強化デュオが付く（F-26-8の「温存の報酬」がそのまま3系統へ広がる） */
  it('どの一時効果にもチャージを増やす強化デュオがある', () => {
    for (const id of TEMPORARY_SKILL_IDS) {
      const booster = DUO_SKILL_IDS.find(
        (duo) => SKILLS[duo].chargeBonus !== undefined && SKILLS[duo].requires?.includes(id),
      );
      expect(booster, id).toBeDefined();
      // 前提と同じ系統（絞り込みで相方が永久に出ない、が起きない条件）
      expect(SKILLS[booster!].lineage, booster).toBe(SKILLS[id].lineage);
    }
  });

  it('従来の札はすべて常設のまま（duration を後から生やしていない）', () => {
    const permanent = ALL_SKILL_IDS.filter((id) => !isTemporary(id));
    expect(permanent.length).toBe(ALL_SKILL_IDS.length - TEMPORARY_SKILL_IDS.length);
    for (const id of permanent) expect(SKILLS[id].duration, id).toBeUndefined();
  });
});

// ---- 切る／効く／消える ----

describe('一時効果: 切ると効き、打席が終わると消える（M-33）', () => {
  const batting = temporariesForRole('batting')[0];
  const fielding = temporariesForRole('fielding')[0];

  it('取っただけでは効かない（切って初めて効果が乗る）', () => {
    const id = firstBatter();
    const held = grantSkill(roster(), id, batting).roster;
    const before = effectiveBatting(held, id);
    const base = effectiveBatting(roster(), id);
    // 取っただけ＝素の能力値のまま
    expect(before).toEqual(base);

    const { roster: fired, skillId } = activateEffect(held, id, 'batting');
    expect(skillId).toBe(batting);
    const after = effectiveBatting(fired, id);
    const mod = SKILLS[batting].modifier!;
    if (mod.power) expect(after.power).toBeGreaterThan(before.power);
    if (mod.average) expect(after.average).toBeGreaterThan(before.average);
  });

  /**
   * **プレー定数系の一時効果も同じ1つの導出を通る**（`effectivePlay`）＝
   * 効果の形が違っても、切る仕組みは1つで済んでいる。
   */
  it('守備側の札は切ると捕球半径の補正が出る', () => {
    const id = firstBatter();
    const held = grantSkill(roster(), id, fielding).roster;
    expect(effectivePlay(held, id).catchRadius ?? 0).toBe(0);
    const fired = activateEffect(held, id, 'fielding').roster;
    expect(effectivePlay(fired, id).catchRadius).toBe(SKILLS[fielding].play!.catchRadius);
  });

  it('切るとチャージが1つ減る（F-26-8の支払いをそのまま通る）', () => {
    const id = firstBatter();
    const held = grantSkill(roster(), id, batting).roster;
    const total = chargesLeftOf(held, id, batting);
    const fired = activateEffect(held, id, 'batting').roster;
    expect(chargesLeftOf(fired, id, batting)).toBe(total - 1);
  });

  it('同じ打席で二重に切れない（払うのは1回だけ）', () => {
    const id = firstBatter();
    const held = grantSkill(roster(), id, batting).roster;
    const once = activateEffect(held, id, 'batting').roster;
    const twice = activateEffect(once, id, 'batting');
    expect(twice.skillId).toBeNull();
    // rosterは一切変更されない＝残り回数が余計に減らない
    expect(twice.roster).toBe(once);
    expect(chargesLeftOf(twice.roster, id, batting)).toBe(chargesLeftOf(once, id, batting));
  });

  it('打席が終わると効果は消えるが、使った回数は残る', () => {
    const id = firstBatter();
    const held = grantSkill(roster(), id, batting).roster;
    const fired = activateEffect(held, id, 'batting').roster;
    const left = chargesLeftOf(fired, id, batting);

    const next = clearActiveEffects(fired);
    expect(activeEffectsOf(next, id)).toEqual([]);
    expect(effectiveBatting(next, id)).toEqual(effectiveBatting(held, id));
    // 使った記録は消えない（回数はラン全体で使い切り）
    expect(chargesLeftOf(next, id, batting)).toBe(left);
    // 次の打席ではまた切れる
    expect(activatableEffect(next, id, 'batting')).toBe(batting);
  });

  it('何も切っていなければ clearActiveEffects は同じ参照を返す（無駄なコピーをしない）', () => {
    const r = roster();
    expect(clearActiveEffects(r)).toBe(r);
  });

  it('持っていない・使い切った札は切れない', () => {
    const id = firstBatter();
    expect(activatableEffect(roster(), id, 'batting')).toBeNull();

    // チャージを使い切るまで「切る→打席終了」を繰り返す
    let r = grantSkill(roster(), id, batting).roster;
    const total = SKILLS[batting].charges!;
    for (let i = 0; i < total; i += 1) {
      expect(activatableEffect(r, id, 'batting'), `${i}回目`).toBe(batting);
      r = clearActiveEffects(activateEffect(r, id, 'batting').roster);
    }
    expect(activatableEffect(r, id, 'batting')).toBeNull();
    // 使い切った札は枠を返す（F-26-8の規則がそのまま効く）
    expect(liveSkillsOf(r, id)).not.toContain(batting);
    expect(skillsOf(r, id)).toContain(batting);
    expect(hasSkillRoom(r, id)).toBe(true);
  });

  it('役割が違えば切れない（打者側のGで守備の札は切れない）', () => {
    const id = firstBatter();
    const held = grantSkill(roster(), id, fielding).roster;
    expect(activatableEffect(held, id, 'batting')).toBeNull();
    expect(activatableEffect(held, id, 'fielding')).toBe(fielding);
  });

  it('hasActiveEffect は切った役割だけ true になる', () => {
    const id = firstBatter();
    const held = grantSkill(roster(), id, fielding).roster;
    expect(hasActiveEffect(held, id, 'fielding')).toBe(false);
    const fired = activateEffect(held, id, 'fielding').roster;
    expect(hasActiveEffect(fired, id, 'fielding')).toBe(true);
    expect(hasActiveEffect(fired, id, 'batting')).toBe(false);
  });

  /**
   * **切っていない一時効果も枠は占める**＝F-26-8の「温存には対価がある」がそのまま効く
   * （持っているだけで別の札を置けない）。
   */
  it('切っていなくても枠は占める（温存の対価）', () => {
    const id = firstBatter();
    const held = grantSkill(roster(), id, batting).roster;
    expect(liveSkillsOf(held, id)).toContain(batting);
    expect(effectiveSkillsOf(held, id)).not.toContain(batting);
  });
});

// ---- CPUの規則（決定的・乱数不使用） ----

describe('一時効果: CPUの規則（M-33）', () => {
  it('CPU打者は得点圏に走者がいる打席で切る', () => {
    expect(shouldCpuActivateBattingEffect(EMPTY_BASES)).toBe(false);
    expect(shouldCpuActivateBattingEffect({ ...EMPTY_BASES, first: true })).toBe(false);
    expect(shouldCpuActivateBattingEffect({ ...EMPTY_BASES, second: true })).toBe(true);
    expect(shouldCpuActivateBattingEffect({ ...EMPTY_BASES, third: true })).toBe(true);
  });

  /**
   * 守備側は「このままでは届かないが、範囲が広がれば届く」ときだけ切る
   * （`chooseCpuFinePlay` とまったく同じ判断の形。打球の作り方も
   * `fielding.test.ts` のファインプレイの節に揃えてある）。
   */
  const passingBall = (): BattedBall => ({
    x: 0,
    y: 0.5,
    z: 6, // 0.4秒の先読み窓の中で野手（z=0）の真横を通る
    vx: 0,
    vy: 0,
    vz: -15,
    landing: null,
    over: null,
    resting: false,
    bunt: false,
  });
  const boosted = CATCH_RADIUS + 3;

  it('CPU守備は素の範囲で届く打球には切らない', () => {
    expect(shouldCpuActivateCatchEffect({ x: 1, z: 0 }, passingBall(), CATCH_RADIUS, boosted)).toBe(
      false,
    );
  });

  it('CPU守備は範囲が広がれば届く打球に切る', () => {
    // 素の半径(2.6)の外・広げた半径(5.6)の内側を通る打球
    expect(shouldCpuActivateCatchEffect({ x: 4, z: 0 }, passingBall(), CATCH_RADIUS, boosted)).toBe(
      true,
    );
  });

  it('CPU守備は広げても届かない打球には切らない（払っても結果が変わらない）', () => {
    expect(shouldCpuActivateCatchEffect({ x: 40, z: 0 }, passingBall(), CATCH_RADIUS, boosted)).toBe(
      false,
    );
  });

  it('広がらない（補正0）なら常に切らない', () => {
    expect(
      shouldCpuActivateCatchEffect({ x: 4, z: 0 }, passingBall(), CATCH_RADIUS, CATCH_RADIUS),
    ).toBe(false);
  });
});

// ---- gameMachine 経由（イベントと打席の切れ目） ----

describe('一時効果: gameMachine（M-33）', () => {
  const batting = temporariesForRole('batting')[0];

  /**
   * 札は `MATCH_SETUP` の持ち越し（F-26-6）で載せる。`SKILL_GRANTED` は
   * **提示中の候補しか付けない**（UIの外から任意のスキルを流し込めない、という既存の関所）
   * ので、抽選を回さずに札を持たせるにはこちらが正しい入口になる。
   */
  const started = (skills: Record<string, readonly (typeof batting)[]>, side: 'away' | 'home') => {
    const actor = createActor(gameMachine).start();
    actor.send({
      type: 'MATCH_SETUP',
      away: 'flames',
      home: 'winds',
      skills: { [side]: skills },
    });
    return actor;
  };

  /** その側の先頭打者に札を1枚持たせて始める */
  const withBattingCard = (side: 'away' | 'home') => {
    const probe = createActor(gameMachine).start();
    probe.send({ type: 'MATCH_SETUP', away: 'flames', home: 'winds' });
    const playerId = currentBatterId(probe.getSnapshot().context.rosters[side]);
    return { actor: started({ [playerId]: [batting] }, side), playerId };
  };

  it('EFFECT_ACTIVATED でチャージが減り、効果が乗る', () => {
    const side = 'away' as const;
    const { actor, playerId } = withBattingCard(side);
    const held = actor.getSnapshot().context.rosters[side];
    const before = chargesLeftOf(held, playerId, batting);

    actor.send({ type: 'EFFECT_ACTIVATED', side, playerId, role: 'batting' });
    const fired = actor.getSnapshot().context.rosters[side];
    expect(activeEffectsOf(fired, playerId)).toEqual([batting]);
    expect(chargesLeftOf(fired, playerId, batting)).toBe(before - 1);
  });

  it('存在しない選手・切れない札のイベントは何も起こさない', () => {
    const actor = createActor(gameMachine).start();
    actor.send({ type: 'MATCH_SETUP', away: 'flames', home: 'winds' });
    const side = 'away' as const;
    const before = actor.getSnapshot().context.rosters[side];
    actor.send({ type: 'EFFECT_ACTIVATED', side, playerId: 'nobody', role: 'batting' });
    // 札を持っていない打者にも効かない
    const playerId = currentBatterId(before);
    actor.send({ type: 'EFFECT_ACTIVATED', side, playerId, role: 'batting' });
    expect(actor.getSnapshot().context.rosters[side]).toBe(before);
  });

  /**
   * **打席が終わる唯一の場所（`advanceLineup`）が効果を落とす**。三振でも四球でも
   * 打球の決着でも同じ1か所を通るので、寿命の定義と実際に消える場所が一致する。
   */
  it('三振で打席が終わると効果が消える', () => {
    const side = 'away' as const;
    const { actor, playerId } = withBattingCard(side);
    actor.send({ type: 'EFFECT_ACTIVATED', side, playerId, role: 'batting' });
    expect(activeEffectsOf(actor.getSnapshot().context.rosters[side], playerId)).toEqual([batting]);

    for (let i = 0; i < 3; i += 1) actor.send({ type: 'PITCH_RESULT', judgement: 'strike' });
    expect(activeEffectsOf(actor.getSnapshot().context.rosters[side], playerId)).toEqual([]);
  });

  it('ボール球だけでは打席が終わらないので効果は残る', () => {
    const side = 'away' as const;
    const { actor, playerId } = withBattingCard(side);
    actor.send({ type: 'EFFECT_ACTIVATED', side, playerId, role: 'batting' });
    for (let i = 0; i < 3; i += 1) actor.send({ type: 'PITCH_RESULT', judgement: 'ball' });
    expect(activeEffectsOf(actor.getSnapshot().context.rosters[side], playerId)).toEqual([batting]);
  });

  /**
   * **守備側の札も打席の切れ目で落ちる**。打っている側だけを畳むと、守備の効果だけが
   * 次の打席へ漏れる（`advanceLineup` が両チームぶん通す理由）。
   */
  it('守備側チームの効果も打席の切れ目で消える', () => {
    const defense = 'home' as const;
    const fielding = temporariesForRole('fielding')[0];
    const probe = createActor(gameMachine).start();
    probe.send({ type: 'MATCH_SETUP', away: 'flames', home: 'winds' });
    const playerId = probe.getSnapshot().context.rosters[defense].positions.SS;
    const actor = createActor(gameMachine).start();
    actor.send({
      type: 'MATCH_SETUP',
      away: 'flames',
      home: 'winds',
      skills: { [defense]: { [playerId]: [fielding] } },
    });
    actor.send({ type: 'EFFECT_ACTIVATED', side: defense, playerId, role: 'fielding' });
    expect(activeEffectsOf(actor.getSnapshot().context.rosters[defense], playerId)).toEqual([
      fielding,
    ]);

    for (let i = 0; i < 3; i += 1) actor.send({ type: 'PITCH_RESULT', judgement: 'strike' });
    expect(activeEffectsOf(actor.getSnapshot().context.rosters[defense], playerId)).toEqual([]);
  });

  it('新しい試合のロスターは何も切っていない状態から始まる', () => {
    expect(activeEffectsOf(roster(), firstBatter())).toEqual([]);
  });
});

// ---- 役割の導出（表示と判定が同じ1か所から出る） ----

describe('effectRole: 押す場所は札から決まる（M-33）', () => {
  it('常設の札に対しても落ちない（未知のIDでも既定の役割を返す）', () => {
    // 一時効果でない札に対しても例外を投げない（呼び出し側にガードを要求しない）
    expect(['batting', 'fielding']).toContain(effectRole('kinniku'));
  });
});
