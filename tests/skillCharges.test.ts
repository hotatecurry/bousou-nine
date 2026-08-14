/**
 * 消費型スキル（フェーズF-26-8。CLAUDE.md ⑧「消費型スキル」）。
 *
 * **真実は「使った数」（`TeamRoster.skillUses`）の側**で、残り回数・効果・枠の空き・
 * 強化デュオの候補入りは、すべてそこからの導出になっている（B-11の投球数→残りスタミナ、
 * F-26-2の撃った数→残弾と同じ形）。だからここで固定したいのは個々の数字より
 * **「使ったら効果も枠も強化の目も同時に動くか」というひと続きの導出**のほう。
 *
 * `rosterSkills.test.ts` と分けてあるのは、対象が「スキルがロスターにどう乗るか」ではなく
 * **チャージという寿命の扱い**だから（フェーズFでここを触るときに1ファイルで済む）。
 */
import { describe, expect, it } from 'vitest';
import {
  canGrantTo,
  canShootGun,
  canUseVerb,
  chargesLeftOf,
  createTeamRoster,
  effectivePlay,
  grantSkill,
  gunRemainingOf,
  gunShotsOf,
  hasSkill,
  hasSkillRoom,
  isSpent,
  liveSkillsOf,
  pitchCountOf,
  recordGunShot,
  skillHoldersOf,
  skillUsesOf,
  skillsOf,
  substitutePitcherAt,
  useSkillCharge,
  useVerb,
  withCarriedSkills,
} from '../src/core/roster';
import {
  type SkillId,
  ALL_SKILL_IDS,
  CONSUMABLE_VERB,
  DRAFTABLE_SKILL_IDS,
  DUO_RARITY,
  DUO_SKILL_IDS,
  GUN_SHOTS_PER_PITCHER,
  SKILLS,
  chargeTotalOf,
  consumablesForVerb,
  isConsumable,
} from '../src/core/skills';
import { teamById } from '../src/core/teams';

const TEST_TEAM = teamById('foresters');
const CONSUMABLE_IDS = ALL_SKILL_IDS.filter((id) => isConsumable(id));

// ---- 名鑑側の約束 ----

describe('消費型: 名鑑の約束', () => {
  it('消費型は必ず1回以上のチャージを持つ（取った瞬間に使えない札を作らない）', () => {
    expect(CONSUMABLE_IDS.length).toBeGreaterThan(0);
    for (const id of CONSUMABLE_IDS) {
      expect(SKILLS[id].charges, id).toBeGreaterThan(0);
    }
  });

  /**
   * **消費型が判定側に新しい分岐を生やさない**ことを固定する。取りうる形は2つだけ：
   *
   * 1. **既存の動詞を配る**（`CONSUMABLE_VERB`。F-26-8）＝問い合わせ側は動詞の名前しか
   *    知らないので、札が増えても `canUseVerb` の答えが変わるだけ。
   * 2. **一時効果**（`duration`。M-33）＝効果の中身は従来の3つの形のままで、
   *    `effectiveSkillsOf` が「いま効いている札」を絞るだけ。
   *
   * どちらでもない消費型は、判定側にスキル専用の分岐を要求する＝F-26-3/4以来の
   * 「バイク専用の分岐を持たない」という整理が崩れる。
   */
  it('消費型は既存の動詞の代用か一時効果のどちらか（新しい操作を増やさない）', () => {
    for (const id of CONSUMABLE_IDS) {
      const verb = CONSUMABLE_VERB[id];
      if (verb === undefined) {
        expect(SKILLS[id].duration, id).toBeDefined();
        continue;
      }
      expect(ALL_SKILL_IDS, id).toContain(verb);
    }
  });

  it('消費型は抽選プールに載る（デュオではなく、運で配られる側）', () => {
    for (const id of CONSUMABLE_IDS) {
      expect(DRAFTABLE_SKILL_IDS, id).toContain(id);
    }
  });

  /**
   * **強化デュオの前提はちょうど1つの消費型**。2つ以上を前提にすると「どの札のチャージを
   * 増やすのか」が一意に決まらず、`chargeTotalOf` の意味が曖昧になる。
   */
  it('チャージを増やすデュオは、前提がちょうど1つの消費型', () => {
    const boosters = DUO_SKILL_IDS.filter((id) => SKILLS[id].chargeBonus !== undefined);
    expect(boosters.length).toBeGreaterThan(0);
    for (const id of boosters) {
      const def = SKILLS[id];
      expect(def.rarity, id).toBe(DUO_RARITY);
      expect(def.requires!.length, id).toBe(1);
      expect(isConsumable(def.requires![0]), id).toBe(true);
      expect(def.chargeBonus, id).toBeGreaterThan(0);
    }
  });

  it('デュオの前提は1つか2つ（0個＝ただの★4や、枠に収まらない数を作らない）', () => {
    for (const id of DUO_SKILL_IDS) {
      const requires = SKILLS[id].requires!;
      expect(requires.length, id).toBeGreaterThanOrEqual(1);
      expect(requires.length, id).toBeLessThanOrEqual(2);
      expect(new Set(requires).size, id).toBe(requires.length);
    }
  });

  it('chargeTotalOf は素のチャージと強化デュオを足す（持っていなければ足さない）', () => {
    expect(chargeTotalOf(['tetsugeta'], 'tetsugeta')).toBe(SKILLS.tetsugeta.charges);
    expect(chargeTotalOf(['tetsugeta', 'rokettogeta'], 'tetsugeta')).toBe(
      SKILLS.tetsugeta.charges! + SKILLS.rokettogeta.chargeBonus!,
    );
    // 常設のスキルにはチャージという概念が無い
    expect(chargeTotalOf(['doroppukikku'], 'doroppukikku')).toBe(0);
  });

  it('consumablesForVerb はその動詞を代用する札を返す', () => {
    expect(consumablesForVerb('doroppukikku')).toEqual(['tetsugeta']);
    expect(consumablesForVerb('baiku')).toEqual(['nitoro']);
    expect(consumablesForVerb('ju')).toEqual(['yobiju']);
    expect(consumablesForVerb('kinniku')).toEqual([]);
  });
});

// ---- チャージの消費と枠 ----

describe('消費型: チャージの消費と枠', () => {
  const spendAll = (
    roster: ReturnType<typeof createTeamRoster>,
    id: string,
    skillId: SkillId,
  ): ReturnType<typeof createTeamRoster> => {
    let next = roster;
    while (chargesLeftOf(next, id, skillId) > 0) next = useSkillCharge(next, id, skillId).roster;
    return next;
  };

  it('取った直後は名鑑どおりのチャージを持つ（テツゲタ=2回）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.lineup[0];
    const next = grantSkill(roster, id, 'tetsugeta').roster;
    expect(chargesLeftOf(next, id, 'tetsugeta')).toBe(SKILLS.tetsugeta.charges);
    expect(isSpent(next, id, 'tetsugeta')).toBe(false);
    expect(hasSkill(next, id, 'tetsugeta')).toBe(true);
  });

  it('常設のスキルは決して使い切らない（チャージ0で、消費しても何も起きない）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.lineup[0];
    const next = grantSkill(roster, id, 'doroppukikku').roster;
    expect(chargesLeftOf(next, id, 'doroppukikku')).toBe(0);
    expect(isSpent(next, id, 'doroppukikku')).toBe(false);
    expect(useSkillCharge(next, id, 'doroppukikku').ok).toBe(false);
  });

  /**
   * 取っていない札のチャージを0にしていないと、**消費型を誰もが持っているのと同じ**に
   * なる（実装中に既存の銃のテストがこれを捕まえた＝残弾が3ではなく4になった）。
   */
  it('取っていない札のチャージは常に0', () => {
    const roster = createTeamRoster(TEST_TEAM);
    expect(chargesLeftOf(roster, roster.lineup[0], 'tetsugeta')).toBe(0);
    expect(canUseVerb(roster, roster.lineup[0], 'doroppukikku')).toBe(false);
  });

  it('使うたびに1つ減り、使い切ると持っていないのと同じになる', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.lineup[0];
    let next = grantSkill(roster, id, 'tetsugeta').roster;
    next = useSkillCharge(next, id, 'tetsugeta').roster;
    expect(chargesLeftOf(next, id, 'tetsugeta')).toBe(1);
    expect(hasSkill(next, id, 'tetsugeta')).toBe(true);
    next = useSkillCharge(next, id, 'tetsugeta').roster;
    expect(chargesLeftOf(next, id, 'tetsugeta')).toBe(0);
    expect(isSpent(next, id, 'tetsugeta')).toBe(true);
    expect(hasSkill(next, id, 'tetsugeta')).toBe(false);
    expect(canUseVerb(next, id, 'doroppukikku')).toBe(false);
  });

  it('使い切っても取った記録は残る（引き直して無限に補充できない）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.lineup[0];
    const next = spendAll(grantSkill(roster, id, 'tetsugeta').roster, id, 'tetsugeta');
    expect(skillsOf(next, id)).toContain('tetsugeta');
    expect(liveSkillsOf(next, id)).not.toContain('tetsugeta');
    expect(skillUsesOf(next, id, 'tetsugeta')).toBe(SKILLS.tetsugeta.charges);
    expect(grantSkill(next, id, 'tetsugeta').ok).toBe(false);
    // 抽選に渡す候補の側でも同じ（重複は owned、枠と前提は生きている札で見る）
    const holder = skillHoldersOf(next).find((h) => h.id === id)!;
    expect(holder.owned).toContain('tetsugeta');
    expect(holder.skills).not.toContain('tetsugeta');
  });

  it('使い切っていれば消費しても roster は変わらない（残り回数が負にならない）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.lineup[0];
    const next = spendAll(grantSkill(roster, id, 'tetsugeta').roster, id, 'tetsugeta');
    const again = useSkillCharge(next, id, 'tetsugeta');
    expect(again.ok).toBe(false);
    expect(again.roster).toBe(next);
  });

  /**
   * **使い切ると効果も止まる**。`テツゲタ` は射程の補正（`play`）を持つので、使い切った
   * 瞬間に射程も素の値へ戻る＝「もう蹴れないのに射程だけ伸びている」が起きない。
   */
  it('使い切ると効果（射程の補正）も止まる', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.lineup[0];
    let next = grantSkill(roster, id, 'tetsugeta').roster;
    expect(next && effectivePlay(next, id).dropkickRange).toBeGreaterThan(0);
    next = spendAll(next, id, 'tetsugeta');
    expect(effectivePlay(next, id)).toEqual({});
  });

  /**
   * **枠を返すことが、使うことのもう1つのリターン**（CLAUDE.md ⑧）。温存には
   * 「枠が1つ死んでいる」という対価が常にあり、使えば次の札を置ける。
   */
  it('使い切ると枠が空いて、次のスキルを付けられる', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.lineup[0];
    let next = grantSkill(roster, id, 'tetsugeta').roster;
    next = grantSkill(next, id, 'kinniku').roster;
    next = grantSkill(next, id, 'nebari').roster;
    expect(hasSkillRoom(next, id)).toBe(false);
    expect(grantSkill(next, id, 'suburi').ok).toBe(false);
    next = spendAll(next, id, 'tetsugeta');
    expect(hasSkillRoom(next, id)).toBe(true);
    expect(grantSkill(next, id, 'suburi').ok).toBe(true);
  });
});

// ---- 強化デュオ（温存の報酬） ----

describe('消費型: 強化デュオ', () => {
  it('取るとチャージが増える（すでに使った数は巻き戻らない）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.lineup[0];
    let next = grantSkill(roster, id, 'tetsugeta').roster;
    next = useSkillCharge(next, id, 'tetsugeta').roster;
    expect(chargesLeftOf(next, id, 'tetsugeta')).toBe(1);
    next = grantSkill(next, id, 'rokettogeta').roster;
    // 総チャージ 2+2=4 のうち1つ使用済み＝残り3（「取ったら満タンに戻る」ではない）
    expect(chargesLeftOf(next, id, 'tetsugeta')).toBe(3);
    expect(skillUsesOf(next, id, 'tetsugeta')).toBe(1);
  });

  it('枠上限の例外として付く（前提1つでも従来のデュオと同じ扱い）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.lineup[0];
    let next = grantSkill(roster, id, 'tetsugeta').roster;
    next = grantSkill(next, id, 'kinniku').roster;
    next = grantSkill(next, id, 'nebari').roster;
    expect(hasSkillRoom(next, id)).toBe(false);
    expect(grantSkill(next, id, 'rokettogeta').ok).toBe(true);
  });

  /**
   * **これがこのフェーズの中心**（CLAUDE.md ⑧）：使い切った瞬間に強化の目が消えるので、
   * 「いま使うか、温存して強化を狙うか」が実際の判断になる。1回使っただけで消えては
   * 「一度も使うな」になってしまうので、**残っている限りは候補のまま**であることも固定する。
   */
  it('使い切ると付かなくなる（温存していた間だけの報酬）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.lineup[0];
    let next = grantSkill(roster, id, 'tetsugeta').roster;
    expect(canGrantTo(next, id, 'rokettogeta')).toBe(true);
    next = useSkillCharge(next, id, 'tetsugeta').roster;
    expect(canGrantTo(next, id, 'rokettogeta')).toBe(true);
    next = useSkillCharge(next, id, 'tetsugeta').roster;
    expect(canGrantTo(next, id, 'rokettogeta')).toBe(false);
    expect(grantSkill(next, id, 'rokettogeta').ok).toBe(false);
  });

  it('前提を持たない選手には付かない（誰に集めるかがランの目標になる）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const holder = roster.lineup[0];
    const other = roster.lineup[1];
    const next = grantSkill(roster, holder, 'tetsugeta').roster;
    expect(canGrantTo(next, other, 'rokettogeta')).toBe(false);
  });
});

// ---- 動詞としての問い合わせ ----

describe('消費型: canUseVerb / useVerb', () => {
  it('常設のバイクを持っていれば乗れて、乗ってもチャージは減らない', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.lineup[0];
    let next = grantSkill(roster, id, 'baiku').roster;
    next = grantSkill(next, id, 'nitoro').roster;
    expect(canUseVerb(next, id, 'baiku')).toBe(true);
    // **常設が優先**＝両方持てば消費型は減らない（実質そのまま常設になる）
    expect(useVerb(next, id, 'baiku')).toBe(next);
    expect(chargesLeftOf(next, id, 'nitoro')).toBe(SKILLS.nitoro.charges);
  });

  it('ニトロだけならチャージで乗れて、使い切ると乗れなくなる', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.lineup[0];
    let next = grantSkill(roster, id, 'nitoro').roster;
    expect(canUseVerb(next, id, 'baiku')).toBe(true);
    next = useVerb(next, id, 'baiku');
    expect(chargesLeftOf(next, id, 'nitoro')).toBe(1);
    next = useVerb(next, id, 'baiku');
    expect(canUseVerb(next, id, 'baiku')).toBe(false);
    // 使い切った後に何度呼んでも変わらない（二重に報せが届いても壊れない）
    expect(useVerb(next, id, 'baiku')).toBe(next);
  });

  it('何も持っていない選手は動詞を使えず、記録しても何も起きない', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.lineup[1];
    expect(canUseVerb(roster, id, 'baiku')).toBe(false);
    expect(useVerb(roster, id, 'baiku')).toBe(roster);
  });

  it('チャージは選手ごと（同じ札を2人が持っても別々に減る）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const a = roster.lineup[0];
    const b = roster.lineup[1];
    let next = grantSkill(roster, a, 'nitoro').roster;
    next = grantSkill(next, b, 'nitoro').roster;
    next = useVerb(next, a, 'baiku');
    expect(chargesLeftOf(next, a, 'nitoro')).toBe(1);
    expect(chargesLeftOf(next, b, 'nitoro')).toBe(SKILLS.nitoro.charges);
  });
});

// ---- 銃（常設の弾から先に撃つ） ----

describe('消費型: 銃の弾', () => {
  it('ヨビジュウだけの投手も撃てる（1発）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const next = grantSkill(roster, roster.pitcher, 'yobiju').roster;
    expect(gunRemainingOf(next, next.pitcher)).toBe(1);
    expect(canShootGun(next)).toBe(true);
    const after = recordGunShot(next);
    expect(gunRemainingOf(after, after.pitcher)).toBe(0);
    expect(canShootGun(after)).toBe(false);
    // 銃は投球数に数えない（B-11の約束はそのまま）
    expect(pitchCountOf(after, after.pitcher)).toBe(0);
  });

  it('ジュウとヨビジュウの両方を持つと弾が合算され、常設の3発から先に減る', () => {
    const roster = createTeamRoster(TEST_TEAM);
    let next = grantSkill(roster, roster.pitcher, 'ju').roster;
    next = grantSkill(next, next.pitcher, 'yobiju').roster;
    expect(gunRemainingOf(next, next.pitcher)).toBe(GUN_SHOTS_PER_PITCHER + 1);
    for (let i = 0; i < GUN_SHOTS_PER_PITCHER; i += 1) next = recordGunShot(next);
    // ここまでは常設のぶん＝チャージは手つかず
    expect(gunShotsOf(next, next.pitcher)).toBe(GUN_SHOTS_PER_PITCHER);
    expect(chargesLeftOf(next, next.pitcher, 'yobiju')).toBe(1);
    next = recordGunShot(next);
    expect(chargesLeftOf(next, next.pitcher, 'yobiju')).toBe(0);
    expect(canShootGun(next)).toBe(false);
  });

  it('レンシャジュウでチャージが増える（温存していた投手への報酬）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    let next = grantSkill(roster, roster.pitcher, 'yobiju').roster;
    next = grantSkill(next, next.pitcher, 'renshaju').roster;
    expect(gunRemainingOf(next, next.pitcher)).toBe(1 + SKILLS.renshaju.chargeBonus!);
  });

  it('継投すると消費型の弾もマウンドから消える（スキルは選手に付いて回る）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const next = grantSkill(roster, roster.pitcher, 'yobiju').roster;
    const { roster: relieved } = substitutePitcherAt(next, 0);
    expect(canShootGun(relieved)).toBe(false);
  });

  it('ヨビジュウは投手専用（野手には付かない）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const fielder = roster.positions.CF;
    expect(canGrantTo(roster, fielder, 'yobiju')).toBe(false);
  });
});

// ---- ランの持ち越し ----

describe('消費型: ランの持ち越し（withCarriedSkills）', () => {
  it('使った回数も一緒に持ち越す（ラン全体で使い切り＝試合ごとに回復しない）', () => {
    const first = createTeamRoster(TEST_TEAM);
    const id = first.lineup[0];
    let played = grantSkill(first, id, 'tetsugeta').roster;
    played = useSkillCharge(played, id, 'tetsugeta').roster;

    const next = withCarriedSkills(createTeamRoster(TEST_TEAM), played.skills, played.skillUses);
    expect(hasSkill(next, id, 'tetsugeta')).toBe(true);
    expect(chargesLeftOf(next, id, 'tetsugeta')).toBe(1);
  });

  it('使用回数を渡さなければ全部未使用（1試合だけの呼び出しは従来どおり）', () => {
    const first = createTeamRoster(TEST_TEAM);
    const id = first.lineup[0];
    let played = grantSkill(first, id, 'tetsugeta').roster;
    played = useSkillCharge(played, id, 'tetsugeta').roster;
    const next = withCarriedSkills(createTeamRoster(TEST_TEAM), played.skills);
    expect(chargesLeftOf(next, id, 'tetsugeta')).toBe(SKILLS.tetsugeta.charges);
  });

  it('持ち越せなかった札の使用回数は載らない（宙に浮いた記録を作らない）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.lineup[0];
    const next = withCarriedSkills(roster, {}, { [id]: { tetsugeta: 1 } });
    expect(next.skillUses[id]?.tetsugeta).toBeUndefined();
    expect(chargesLeftOf(next, id, 'tetsugeta')).toBe(0);
  });

  it('使い切った札も持ち越され、次の試合でも使い切ったまま（枠は空いたまま）', () => {
    const first = createTeamRoster(TEST_TEAM);
    const id = first.lineup[0];
    let played = grantSkill(first, id, 'tetsugeta').roster;
    played = useSkillCharge(useSkillCharge(played, id, 'tetsugeta').roster, id, 'tetsugeta').roster;
    const next = withCarriedSkills(createTeamRoster(TEST_TEAM), played.skills, played.skillUses);
    expect(isSpent(next, id, 'tetsugeta')).toBe(true);
    expect(hasSkillRoom(next, id)).toBe(true);
  });

  it('強化デュオごと持ち越せばチャージの上乗せも一緒に戻る', () => {
    const first = createTeamRoster(TEST_TEAM);
    const id = first.lineup[0];
    let played = grantSkill(first, id, 'tetsugeta').roster;
    played = grantSkill(played, id, 'rokettogeta').roster;
    played = useSkillCharge(played, id, 'tetsugeta').roster;
    const next = withCarriedSkills(createTeamRoster(TEST_TEAM), played.skills, played.skillUses);
    expect(chargesLeftOf(next, id, 'tetsugeta')).toBe(3);
  });
});
