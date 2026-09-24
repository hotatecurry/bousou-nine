/**
 * ローグライトのスキルがロスターにどう乗るか（フェーズF-26-1。CLAUDE.md ⑧）。
 *
 * `roster.test.ts` と分けてあるのは、対象が「名鑑＋交代」ではなく **F-26で足した
 * 派生ビュー（`effectiveBatting`/`effectivePitching`）と付与の可否**だから。
 * スキルを増やしていくフェーズFの間、触る場所がここ1つに固まる。
 */
import { describe, expect, it } from 'vitest';
import {
  advanceBatter,
  brawlLoadoutOf,
  canShootGun,
  createTeamRoster,
  currentBatterId,
  currentBatterPosition,
  displayHomeRuns,
  effectiveBatting,
  effectivePitching,
  effectivePlay,
  fatigueOf,
  grantSkill,
  gunRemainingOf,
  gunShotsOf,
  hasSkill,
  hasSkillRoom,
  maxPitchesFor,
  pitchCountOf,
  recordGunShot,
  recordPitch,
  remainingStaminaOf,
  skillHoldersOf,
  skillsOf,
  substituteBatterAt,
  substitutePitcherAt,
} from '../src/core/roster';
import {
  type SkillId,
  GUN_SHOTS_PER_PITCHER,
  MAX_SKILLS_PER_PLAYER,
  SKILLS,
} from '../src/core/skills';
import { teamById } from '../src/core/teams';

const TEST_TEAM = teamById('foresters');

describe('スキル: 保持と付与', () => {
  it('組んだ直後は誰もスキルを持たない（名鑑には書き込まれない）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    expect(roster.skills).toEqual({});
    for (const id of roster.lineup) {
      expect(skillsOf(roster, id)).toEqual([]);
    }
  });

  it('同じ球団を組み直せば必ず素の能力値から始まる（スキルは試合中の状態）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    expect(grantSkill(roster, roster.lineup[0], 'kinniku').ok).toBe(true);
    expect(createTeamRoster(TEST_TEAM).skills).toEqual({});
  });

  it('付与すると hasSkill が真になり、元のロスターは変わらない（純粋）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.lineup[0];
    const { roster: next, ok } = grantSkill(roster, id, 'kinniku');
    expect(ok).toBe(true);
    expect(hasSkill(next, id, 'kinniku')).toBe(true);
    expect(hasSkill(roster, id, 'kinniku')).toBe(false);
  });

  it('同じスキルは二重に付かない', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.lineup[0];
    const once = grantSkill(roster, id, 'kinniku');
    const twice = grantSkill(once.roster, id, 'kinniku');
    expect(twice.ok).toBe(false);
    expect(twice.roster).toBe(once.roster);
  });

  it('枠は1選手 MAX_SKILLS_PER_PLAYER までで、それ以上は付かない（ロスターも変わらない）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.lineup[0];
    // 枠の数だけ順に付ける（枠上限を動かしてもテストの意図が変わらないようにする）
    const filler: SkillId[] = ['kinniku', 'sukebo', 'yochi', 'shuchu'];
    let filled = roster;
    for (let i = 0; i < MAX_SKILLS_PER_PLAYER; i += 1) {
      filled = grantSkill(filled, id, filler[i]).roster;
    }
    expect(hasSkillRoom(filled, id)).toBe(false);
    const over = grantSkill(filled, id, 'shoryuken');
    expect(over.ok).toBe(false);
    expect(over.roster).toBe(filled);
  });

  it('投手専用スキルは野手に付かない', () => {
    const roster = createTeamRoster(TEST_TEAM);
    expect(grantSkill(roster, roster.positions.CF, 'tafunesu').ok).toBe(false);
    expect(grantSkill(roster, roster.pitcher, 'tafunesu').ok).toBe(true);
  });

  it('デュオは前提2つを同じ選手が揃えたときだけ、枠上限の例外として3つ目に付く', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.lineup[0];
    const a = grantSkill(roster, id, 'shoryuken');
    expect(grantSkill(a.roster, id, 'battoshoryuken').ok).toBe(false);
    const b = grantSkill(a.roster, id, 'bukimochikomi');
    const duo = grantSkill(b.roster, id, 'battoshoryuken');
    expect(duo.ok).toBe(true);
    expect(skillsOf(duo.roster, id)).toHaveLength(3);
  });

  it('前提を別々の選手に散らすとデュオは付かない（誰に集めるかがランの目標になる）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const a = grantSkill(roster, roster.lineup[0], 'shoryuken');
    const b = grantSkill(a.roster, roster.lineup[1], 'bukimochikomi');
    expect(grantSkill(b.roster, roster.lineup[0], 'battoshoryuken').ok).toBe(false);
    expect(grantSkill(b.roster, roster.lineup[1], 'battoshoryuken').ok).toBe(false);
  });

  it('永久退場した選手には付かない（付けても効かない死に札を作らない）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const outgoing = currentBatterId(roster);
    const { roster: after } = substituteBatterAt(roster, 0);
    expect(after.ejected).toContain(outgoing);
    expect(grantSkill(after, outgoing, 'kinniku').ok).toBe(false);
  });

  it('スキルは打順ではなく選手に付いて回る（打順が進んでも保持される）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.lineup[0];
    const { roster: withSkill } = grantSkill(roster, id, 'kinniku');
    expect(hasSkill(advanceBatter(advanceBatter(withSkill)), id, 'kinniku')).toBe(true);
  });

  it('代打を送ってもスキルは退いた選手のもので、入った選手には移らない', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const outgoing = currentBatterId(roster);
    const { roster: withSkill } = grantSkill(roster, outgoing, 'kinniku');
    const incoming = withSkill.bench[0];
    const { roster: after } = substituteBatterAt(withSkill, 0);
    expect(hasSkill(after, outgoing, 'kinniku')).toBe(true);
    expect(hasSkill(after, incoming, 'kinniku')).toBe(false);
  });
});

describe('スキル: 能力値への反映（派生ビュー）', () => {
  it('スキルなしなら名鑑の値がそのまま出る', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.lineup[0];
    expect(effectiveBatting(roster, id)).toEqual(roster.players[id].batting);
    expect(effectivePitching(roster, roster.pitcher)).toEqual(roster.players[roster.pitcher].pitching);
  });

  it('投球能力を持たない選手は effectivePitching が undefined', () => {
    const roster = createTeamRoster(TEST_TEAM);
    expect(effectivePitching(roster, roster.positions.CF)).toBeUndefined();
  });

  it('キンニクは長打力を上げ、HUDの表示本塁打数も一緒に増える', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.lineup[8];
    const before = displayHomeRuns(effectiveBatting(roster, id).power);
    const { roster: next } = grantSkill(roster, id, 'kinniku');
    expect(effectiveBatting(next, id).power).toBeGreaterThan(effectiveBatting(roster, id).power);
    expect(displayHomeRuns(effectiveBatting(next, id).power)).toBeGreaterThan(before);
  });

  it('スケボーは走力を上げる', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.lineup[0];
    const { roster: next } = grantSkill(roster, id, 'sukebo');
    expect(effectiveBatting(next, id).run).toBeGreaterThan(effectiveBatting(roster, id).run);
  });

  /**
   * **負の補正**（フェーズF-26-5のトレードオフ札）。専用の仕組みを持たず、
   * `combinedModifier` の足し算と `rated` のクランプにそのまま乗ることを固定する。
   */
  it('キャタピラは走力を上げる代わりに打率を下げる（トレードオフ）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.lineup[0];
    const { roster: next } = grantSkill(roster, id, 'kyatapira');
    expect(effectiveBatting(next, id).run).toBeGreaterThan(effectiveBatting(roster, id).run);
    expect(effectiveBatting(next, id).average).toBeLessThan(effectiveBatting(roster, id).average);
  });

  it('レーティングは0を下回らない（負の補正も素直に頭打ちになる）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.lineup[0];
    const piled = { ...roster, skills: { ...roster.skills, [id]: Array(20).fill('kyatapira') } };
    expect(effectiveBatting(piled, id).average).toBe(0);
  });

  it('補正は付けた選手だけに効く（他の選手は素のまま）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const target = roster.lineup[0];
    const other = roster.lineup[1];
    const { roster: next } = grantSkill(roster, target, 'kinniku');
    expect(effectiveBatting(next, other)).toEqual(roster.players[other].batting);
  });

  it('レーティングは1.0を超えない（重ねがけは素直に頭打ちになる）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.lineup[3];
    // 名鑑から直接、同じ補正を大量に積んだ状態を作る（上限に必ず当たる量）
    const piled = { ...roster, skills: { ...roster.skills, [id]: Array(8).fill('kinniku') } };
    expect(effectiveBatting(piled, id).power).toBeLessThanOrEqual(1);
    expect(effectiveBatting(piled, id).power).toBe(1);
  });

  it('打席の左右（BOX）はスキルで変わらない（レーティングではないため）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.lineup[0];
    const { roster: next } = grantSkill(roster, id, 'kinniku');
    expect(effectiveBatting(next, id).bats).toBe(roster.players[id].batting.bats);
  });

  it('ERAはスキルで変わらない（レーティングではなく表示用の実数値）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.pitcher;
    const { roster: next } = grantSkill(roster, id, 'tafunesu');
    expect(effectivePitching(next, id)!.era).toBe(roster.players[id].pitching!.era);
  });

  it('タフネスはスタミナ・限界球数・残量・疲労をまとめて動かす', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.pitcher;
    const { roster: next } = grantSkill(roster, id, 'tafunesu');
    expect(effectivePitching(next, id)!.stamina).toBeGreaterThan(
      effectivePitching(roster, id)!.stamina,
    );
    expect(maxPitchesFor(effectivePitching(next, id)!.stamina)).toBeGreaterThan(
      maxPitchesFor(effectivePitching(roster, id)!.stamina),
    );
    // 同じ球数を投げた状態で比べると、タフネス持ちのほうが残量が多く疲れていない
    let plain = roster;
    let tough = next;
    for (let i = 0; i < 80; i += 1) {
      plain = recordPitch(plain);
      tough = recordPitch(tough);
    }
    expect(remainingStaminaOf(tough, id)).toBeGreaterThan(remainingStaminaOf(plain, id));
    expect(fatigueOf(tough, id)).toBeLessThanOrEqual(fatigueOf(plain, id));
  });

  it('乱闘の装備はスキルから組まれる（必殺技の解禁）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.lineup[0];
    expect(brawlLoadoutOf(roster, id).specials).not.toContain('shoryu');
    const { roster: next } = grantSkill(roster, id, 'shoryuken');
    expect(brawlLoadoutOf(next, id).specials).toContain('shoryu');
  });
});

describe('skillHoldersOf: 抽選に渡す候補の並び', () => {
  it('打順の1番から順に並ぶ（CPUの選択規則が読める順序になる）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const holders = skillHoldersOf(roster);
    expect(holders[0].id).toBe(roster.lineup[0]);
    expect(holders[1].id).toBe(roster.lineup[1]);
  });

  it('打順・ブルペン・控えを重複なく全員含む', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const ids = skillHoldersOf(roster).map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(roster.lineup.length + roster.bullpen.length + roster.bench.length);
    for (const id of [...roster.bullpen, ...roster.bench]) expect(ids).toContain(id);
  });

  it('投球能力の有無が正しく出る（投手専用スキルの対象判定に効く）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const holders = skillHoldersOf(roster);
    expect(holders.find((h) => h.id === roster.pitcher)!.canPitch).toBe(true);
    expect(holders.find((h) => h.id === roster.positions.CF)!.canPitch).toBe(false);
  });

  it('持っているスキルがそのまま渡る（枠の判定が抽選側で正しく効く）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.lineup[0];
    const { roster: next } = grantSkill(roster, id, 'kinniku');
    expect(skillHoldersOf(next).find((h) => h.id === id)!.skills).toEqual(['kinniku']);
  });

  it('永久退場した選手は含まれない', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const outgoing = currentBatterId(roster);
    const { roster: after } = substituteBatterAt(roster, 0);
    expect(skillHoldersOf(after).map((h) => h.id)).not.toContain(outgoing);
  });
});

// ---- 銃の残弾（フェーズF-26-2） ----
//
// 銃はスキル `ジュウ` に吸収された。**状態として持つのは発射数だけ**で、残弾はそこからの
// 導出＝B-11が投球数から残りスタミナを導出したのと同じ形（表示と実際が食い違わない）。

describe('スキル: 銃の残弾（ジュウ）', () => {
  /** 現在の投手に `ジュウ` を付けたロスター */
  function withGun() {
    const roster = createTeamRoster(TEST_TEAM);
    return grantSkill(roster, roster.pitcher, 'ju').roster;
  }

  it('持っていない投手の残弾は常に0（引かなかった試合に銃は存在しない）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    expect(gunRemainingOf(roster, roster.pitcher)).toBe(0);
    expect(canShootGun(roster)).toBe(false);
  });

  it('取った瞬間に3発持つ', () => {
    const roster = withGun();
    expect(gunRemainingOf(roster, roster.pitcher)).toBe(GUN_SHOTS_PER_PITCHER);
    expect(canShootGun(roster)).toBe(true);
  });

  it('撃つたびに1発ずつ減り、撃ち切ると撃てなくなる', () => {
    let roster = withGun();
    const pitcher = roster.pitcher;
    for (let i = 1; i <= GUN_SHOTS_PER_PITCHER; i++) {
      roster = recordGunShot(roster);
      expect(gunShotsOf(roster, pitcher)).toBe(i);
      expect(gunRemainingOf(roster, pitcher)).toBe(GUN_SHOTS_PER_PITCHER - i);
    }
    expect(canShootGun(roster)).toBe(false);
    // 撃ち切った後にさらに記録しても残弾は負にならない
    roster = recordGunShot(roster);
    expect(gunRemainingOf(roster, pitcher)).toBe(0);
  });

  it('銃は投球数に数えない（撃ってもスタミナが減らない）', () => {
    const roster = withGun();
    const before = remainingStaminaOf(roster, roster.pitcher);
    const after = recordGunShot(roster);
    expect(pitchCountOf(after, after.pitcher)).toBe(0);
    expect(remainingStaminaOf(after, after.pitcher)).toBe(before);
  });

  it('残弾は投手個人につく（継投すると銃はマウンドから消える）', () => {
    const withShot = recordGunShot(withGun());
    const starter = withShot.pitcher;
    const { roster: relieved, ok } = substitutePitcherAt(withShot, 0);
    expect(ok).toBe(true);
    expect(relieved.pitcher).not.toBe(starter);
    // 降りた投手の記録は残る（履歴を失わない＝投球数と同じ扱い）
    expect(gunRemainingOf(relieved, starter)).toBe(GUN_SHOTS_PER_PITCHER - 1);
    // 新しい投手はスキルを持たないので撃てない
    expect(canShootGun(relieved)).toBe(false);
  });

  it('スキルを持つ2人目の投手は自分の3発を持つ（チーム共有ではない）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const starter = roster.pitcher;
    const reliever = roster.bullpen[0];
    let withBoth = grantSkill(roster, starter, 'ju').roster;
    withBoth = grantSkill(withBoth, reliever, 'ju').roster;
    withBoth = recordGunShot(recordGunShot(withBoth)); // 先発が2発撃つ
    expect(gunRemainingOf(withBoth, starter)).toBe(GUN_SHOTS_PER_PITCHER - 2);
    expect(gunRemainingOf(withBoth, reliever)).toBe(GUN_SHOTS_PER_PITCHER);
    const { roster: after } = substitutePitcherAt(withBoth, 0);
    expect(canShootGun(after)).toBe(true);
  });

  it('野手には付けられない（投手専用スキル）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const fielder = roster.positions.CF;
    const { ok } = grantSkill(roster, fielder, 'ju');
    expect(ok).toBe(false);
    expect(hasSkill(roster, fielder, 'ju')).toBe(false);
  });

  /**
   * デュオ `ホーミングダン`（F-26-5）は**持ち弾のほうを増やす**（残弾を足すのではない）。
   * すでに撃った数は truth として残り続けるので、撃ってから取っても巻き戻らない
   * ＝B-11以来の「真実は投げた/撃った数の側」という整理が保たれる。
   */
  it('ホーミングダンで弾数が増える（すでに撃った数は巻き戻らない）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const pitcher = roster.pitcher;
    let withDuo = grantSkill(roster, pitcher, 'ju').roster;
    withDuo = grantSkill(withDuo, pitcher, 'haguruma').roster;
    withDuo = recordGunShot(withDuo); // 先に1発撃っておく
    expect(gunRemainingOf(withDuo, pitcher)).toBe(GUN_SHOTS_PER_PITCHER - 1);

    const after = grantSkill(withDuo, pitcher, 'homingudan').roster;
    const bonus = SKILLS.homingudan.play!.gunShots!;
    expect(gunRemainingOf(after, pitcher)).toBe(GUN_SHOTS_PER_PITCHER + bonus - 1);
    expect(gunShotsOf(after, pitcher)).toBe(1);
  });

  it('ジュウを持たない投手はホーミングダンがあっても撃てない（0発のまま）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    // 前提を満たさないので本来付かないが、状態を直接作っても残弾は0のままであることを固定
    const forced = {
      ...roster,
      skills: { ...roster.skills, [roster.pitcher]: ['homingudan' as const] },
    };
    expect(gunRemainingOf(forced, forced.pitcher)).toBe(0);
    expect(canShootGun(forced)).toBe(false);
  });
});

// ---- プレー定数への補正（フェーズF-26-5） ----

describe('effectivePlay: プレー定数への補正', () => {
  it('スキルなしなら補正なし（素の定数のまま）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    expect(effectivePlay(roster, roster.lineup[0])).toEqual({});
  });

  it('イヌで守備範囲の補正が出る', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.positions.CF;
    const { roster: next } = grantSkill(roster, id, 'inu');
    expect(effectivePlay(next, id).catchRadius).toBeCloseTo(SKILLS.inu.play!.catchRadius!);
  });

  it('イヌ＋タカは足し合わされる（重ねがけで守備範囲が広がる）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.positions.SS;
    let next = grantSkill(roster, id, 'inu').roster;
    next = grantSkill(next, id, 'taka').roster;
    expect(effectivePlay(next, id).catchRadius).toBeCloseTo(
      SKILLS.inu.play!.catchRadius! + SKILLS.taka.play!.catchRadius!,
    );
  });

  it('ウサギは盗塁のスタート位置の補正を持つ', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const id = roster.lineup[0];
    const { roster: next } = grantSkill(roster, id, 'usagi');
    expect(effectivePlay(next, id).stealLead).toBeGreaterThan(0);
    // レーティング側には一切影響しない（棚が違う）
    expect(effectiveBatting(next, id)).toEqual(roster.players[id].batting);
  });

  it('付けた選手だけに効く（他の選手は素の定数のまま）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const { roster: next } = grantSkill(roster, roster.positions.CF, 'inu');
    expect(effectivePlay(next, roster.positions.LF)).toEqual({});
  });

  /**
   * **代打・継投で守備位置に入った選手のスキルがそのまま効く**（B-10の「代打は守備位置を
   * 引き継ぐ」と同じ整理）。守備範囲は守備位置ではなく選手に付いて回る。
   */
  it('代打で守備位置に入った選手の守備範囲が引き継がれる', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const incoming = roster.bench[0];
    const withSkill = grantSkill(roster, incoming, 'taka').roster;
    const outgoingPosition = currentBatterPosition(withSkill)!;
    const { roster: after, ok } = substituteBatterAt(withSkill, 0);
    expect(ok).toBe(true);
    expect(after.positions[outgoingPosition]).toBe(incoming);
    expect(effectivePlay(after, after.positions[outgoingPosition]).catchRadius).toBeGreaterThan(0);
  });
});
