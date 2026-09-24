import { describe, expect, it } from 'vitest';
import {
  type SkillHolder,
  type SkillId,
  type SkillLineage,
  ACTIVE_LINEAGE_COUNT,
  ALL_LINEAGES,
  ALL_SKILL_IDS,
  CONSUMABLE_VERB,
  DRAFTABLE_SKILL_IDS,
  DRAFT_OPTION_COUNT,
  DRAFT_RARITY_WEIGHT,
  DUO_RARITY,
  DUO_SKILL_IDS,
  GUN_SHOTS_PER_PITCHER,
  LINEAGE_NAME,
  MAX_SKILLS_PER_PLAYER,
  SKILLS,
  SKILL_NAME_MAX_LENGTH,
  SKILL_TEXT_MAX_LENGTH,
  VERB_SKILL_IDS,
  activeLineagesFor,
  brawlLoadoutFor,
  canGrant,
  combinedModifier,
  combinedPlay,
  cpuChooseSkill,
  drawSkillDraft,
  eligibleHolders,
  rarityStars,
  skillDef,
} from '../src/core/skills';
import { DEFAULT_SEED, createRngState, nextIndex, nextRng, nextWeightedIndex } from '../src/core/rng';
// ランの寸法（フェーズF-26-6）。デュオが揃うかを測る単位は1試合ではなく1ランなので、
// 物差しをランの側から借りる（`RUN_GAMES` を動かせばこのテストの測り方も追従する）。
import { DRAFTS_PER_GAME, RUN_GAMES } from '../src/core/run';
import { BRAWL_MAX_HP, DEFAULT_LOADOUT, MOVES } from '../src/core/brawl';

function holder(id: string, skills: SkillId[] = [], canPitch = false): SkillHolder {
  return { id, canPitch, skills };
}

// ---- 乱数（フェーズF-26-1。**このゲームで乱数を引くのは抽選だけ**） ----

describe('rng: シード付き乱数', () => {
  it('同じ状態からは必ず同じ値が出る（試合まるごと再現できることの土台）', () => {
    const state = createRngState(DEFAULT_SEED);
    expect(nextRng(state)).toEqual(nextRng(state));
  });

  it('引くたびに状態が進む（同じ状態を使い回さない限り値は変わる）', () => {
    const a = nextRng(createRngState(DEFAULT_SEED));
    const b = nextRng(a.state);
    expect(b.state).not.toBe(a.state);
    expect(b.value).not.toBe(a.value);
  });

  it('値は 0 以上 1 未満に収まる', () => {
    let state = createRngState(12345);
    for (let i = 0; i < 500; i += 1) {
      const draw = nextRng(state);
      expect(draw.value).toBeGreaterThanOrEqual(0);
      expect(draw.value).toBeLessThan(1);
      state = draw.state;
    }
  });

  it('シードが違えば別の系列になる', () => {
    const a = nextRng(createRngState(1)).value;
    const b = nextRng(createRngState(2)).value;
    expect(a).not.toBe(b);
  });

  it('createRngState は 0 を既定シードへ逃がす（縮退を避ける）', () => {
    expect(createRngState(0)).toBe(DEFAULT_SEED);
  });

  it('nextIndex は範囲内に収まる', () => {
    let state = createRngState(7);
    for (let i = 0; i < 200; i += 1) {
      const drawn = nextIndex(state, 3);
      expect(drawn.index).toBeGreaterThanOrEqual(0);
      expect(drawn.index).toBeLessThan(3);
      state = drawn.state;
    }
  });

  it('nextIndex は候補0件でも止まらない', () => {
    expect(nextIndex(createRngState(1), 0).index).toBe(0);
  });

  it('nextWeightedIndex は重み0の候補を絶対に選ばない', () => {
    let state = createRngState(99);
    for (let i = 0; i < 300; i += 1) {
      const drawn = nextWeightedIndex(state, [0, 5, 0]);
      expect(drawn.index).toBe(1);
      state = drawn.state;
    }
  });

  it('nextWeightedIndex は重みの大きい候補ほど多く出る', () => {
    let state = createRngState(2024);
    const counts = [0, 0];
    for (let i = 0; i < 2000; i += 1) {
      const drawn = nextWeightedIndex(state, [90, 10]);
      counts[drawn.index] += 1;
      state = drawn.state;
    }
    expect(counts[0]).toBeGreaterThan(counts[1] * 4);
  });
});

// ---- スキル名鑑（データの約束事） ----

describe('SKILLS: 名鑑の約束', () => {
  it('idとキーが一致している（引き違いが起きない）', () => {
    for (const id of ALL_SKILL_IDS) {
      expect(SKILLS[id].id).toBe(id);
    }
  });

  it('表示名は全角8文字以内（3択画面とカードの幅がデータで崩れない）', () => {
    for (const id of ALL_SKILL_IDS) {
      expect(SKILLS[id].name.length).toBeLessThanOrEqual(SKILL_NAME_MAX_LENGTH);
      // ブラッシュアップで漢字かな交じりにした（外来語はカタカナのまま）。**半角を混ぜない**
      // ＝全角だけなら文字数がそのまま表示幅（全角1文字＝半角2つ）になり、幅の約束が崩れない
      expect(SKILLS[id].name).toMatch(/^[\u3040-\u30ff\u4e00-\u9fff々ー・]+$/);
    }
  });

  it('説明は24文字以内', () => {
    for (const id of ALL_SKILL_IDS) {
      expect(SKILLS[id].text.length).toBeLessThanOrEqual(SKILL_TEXT_MAX_LENGTH);
    }
  });

  it('系統はすべて表示名を持つ', () => {
    for (const id of ALL_SKILL_IDS) {
      expect(LINEAGE_NAME[SKILLS[id].lineage]).toBeTruthy();
    }
  });

  it('前提を持つスキルは必ず★4（デュオ）で、抽選プールに載らない', () => {
    for (const id of ALL_SKILL_IDS) {
      const def = SKILLS[id];
      if (def.requires) {
        expect(def.rarity).toBe(DUO_RARITY);
        expect(DRAFTABLE_SKILL_IDS).not.toContain(id);
        expect(DUO_SKILL_IDS).toContain(id);
      } else {
        expect(def.rarity).toBeLessThan(DUO_RARITY);
        expect(DRAFTABLE_SKILL_IDS).toContain(id);
      }
    }
  });

  it('デュオの前提は実在するスキルを指し、自分自身は指さない', () => {
    for (const id of DUO_SKILL_IDS) {
      const requires = SKILLS[id].requires!;
      expect(requires[0]).not.toBe(requires[1]);
      for (const req of requires) {
        expect(ALL_SKILL_IDS).toContain(req);
        expect(req).not.toBe(id);
      }
    }
  });

  it('抽選プールのスキルはすべて出現比を持つ（重み0で永久に出ないスキルを作らない）', () => {
    for (const id of DRAFTABLE_SKILL_IDS) {
      expect(DRAFT_RARITY_WEIGHT[SKILLS[id].rarity]).toBeGreaterThan(0);
    }
  });

  it('レアなほど出にくい', () => {
    expect(DRAFT_RARITY_WEIGHT[1]!).toBeGreaterThan(DRAFT_RARITY_WEIGHT[2]!);
    expect(DRAFT_RARITY_WEIGHT[2]!).toBeGreaterThan(DRAFT_RARITY_WEIGHT[3]!);
  });

  it('3択を成立させられるだけの候補がプールにある', () => {
    expect(DRAFTABLE_SKILL_IDS.length).toBeGreaterThanOrEqual(DRAFT_OPTION_COUNT);
  });

  it('rarityStars は常に4文字（★の数が違っても行がずれない）', () => {
    for (const rarity of [1, 2, 3, 4] as const) {
      expect(rarityStars(rarity)).toHaveLength(4);
      expect(rarityStars(rarity).startsWith('★'.repeat(rarity))).toBe(true);
    }
  });

  it('表示名は重複しない（3択画面で同じ名前が2つ並ばない）', () => {
    const names = ALL_SKILL_IDS.map((id) => SKILLS[id].name);
    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * **効果を持たないスキルは動詞系だけ**（銃・バイク・ドロップキックは実体が
   * `fielding.ts` の定数と `chicchaiScene.ts` の操作にある）。ここを固定しておくと、
   * 効果の書き忘れ（`modifier` を付けそこねた新スキル）が黙って死に札になるのを防げる。
   *
   * **F-26-8で消費型を数えるようになった**：`ヨビジュウ`・`ニトロ` は同じ動詞を回数券として
   * 配る札なので、データ側に効果を持たないのは常設の動詞とまったく同じ理由による
   * （`CONSUMABLE_VERB` に載っていることが「動詞である」ことの根拠になる）。
   * 強化デュオ（`chargeBonus`）もチャージを増やすだけの札は効果欄が空になりうる。
   */
  it('効果を持たないスキルは動詞系（常設・消費型）とチャージ強化だけ', () => {
    for (const id of ALL_SKILL_IDS) {
      const def = SKILLS[id];
      const hasEffect = Boolean(def.modifier || def.play || def.brawl || def.chargeBonus || def.refill);
      const isVerb = VERB_SKILL_IDS.includes(id) || CONSUMABLE_VERB[id] !== undefined;
      expect(hasEffect || isVerb, id).toBe(true);
    }
  });
});

// ---- プールの拡充とバランス（フェーズF-26-5） ----

describe('SKILLS: 系統ごとの厚み（F-26-5）', () => {
  const draftableOf = (lineage: SkillLineage) =>
    DRAFTABLE_SKILL_IDS.filter((id) => SKILLS[id].lineage === lineage);
  const duosOf = (lineage: SkillLineage) =>
    DUO_SKILL_IDS.filter((id) => SKILLS[id].lineage === lineage);

  it('プールは70前後ある（F-26-7の目標＝抽選60＋デュオ10）', () => {
    expect(DRAFTABLE_SKILL_IDS.length).toBeGreaterThanOrEqual(58);
    expect(ALL_SKILL_IDS.length).toBeGreaterThanOrEqual(68);
  });

  /**
   * **1ランの抽選回数（5試合×9回＝45回）に対して、実効プールが小さすぎないこと**
   * （フェーズF-26-7）。実際に引く母集団は「3系統ぶん」なので、総数ではなく
   * **どの3系統の組み合わせでも**足りていることを固定する。ここが抽選回数を下回ると、
   * ラン中に同じ札ばかりが出てくる（ハデスでいえば1ランに出る神が少なすぎる状態）。
   */
  it('どの3系統の組み合わせでも、1ランの抽選回数に見合う母集団がある', () => {
    const drafts = RUN_GAMES * DRAFTS_PER_GAME;
    for (let i = 0; i < ALL_LINEAGES.length; i += 1) {
      for (let j = i + 1; j < ALL_LINEAGES.length; j += 1) {
        for (let k = j + 1; k < ALL_LINEAGES.length; k += 1) {
          const trio = [ALL_LINEAGES[i], ALL_LINEAGES[j], ALL_LINEAGES[k]];
          const pool = DRAFTABLE_SKILL_IDS.filter((id) => trio.includes(SKILLS[id].lineage));
          expect(pool.length, trio.join('/')).toBeGreaterThanOrEqual(drafts * 0.6);
        }
      }
    }
  });

  /**
   * **試合ごとに3系統へ絞る**（`ACTIVE_LINEAGE_COUNT`）ので、薄い系統が1つでもあると
   * 「その系統を引いた試合だけ候補が枯れる」ことになる。どの3つの組み合わせでも
   * 3択が成立する厚みを、系統ごとの下限として固定する。
   */
  it('どの系統も抽選プールに十分な枚数を持つ（薄い系統を作らない）', () => {
    for (const lineage of ALL_LINEAGES) {
      // F-26-7で 7→12 に揃えた。3系統に絞っても36枚が残る厚み。
      expect(draftableOf(lineage).length, lineage).toBeGreaterThanOrEqual(12);
    }
  });

  it('どの系統もレアリティが★1〜★3に散っている（同じ重さの札ばかりにならない）', () => {
    for (const lineage of ALL_LINEAGES) {
      const rarities = new Set(draftableOf(lineage).map((id) => SKILLS[id].rarity));
      expect(rarities).toEqual(new Set([1, 2, 3]));
    }
  });

  /**
   * 系統を絞る以上、**デュオの無い系統があると「その系統だけの試合には目標が無い」**。
   * ハデスでいう「その神のボーン（合体技）が存在しない」状態にあたる。
   */
  it('どの系統も2つデュオを持つ（絞られてもランの目標が2通りある）', () => {
    for (const lineage of ALL_LINEAGES) {
      // F-26-7で 1→2 に増やした。プールが倍になったぶん**前提が散らばりやすくなる**ので、
      // 目標そのものを増やして「この系統では何を集めるか」の当たりを付けやすくする。
      expect(duosOf(lineage).length, lineage).toBeGreaterThanOrEqual(2);
    }
  });

  /**
   * **デュオの前提2つは必ず同じ系統**。違う系統にまたがると、絞り込みで片方の系統だけが
   * 出る試合に「前提は溜まるのに相方が永久に出ない」という行き止まりが生まれる。
   */
  it('デュオとその前提2つは同じ系統（絞り込みで行き止まりが生まれない）', () => {
    for (const id of DUO_SKILL_IDS) {
      const def = SKILLS[id];
      for (const req of def.requires!) {
        expect(SKILLS[req].lineage).toBe(def.lineage);
      }
    }
  });

  /**
   * 前提が投手専用なら、それを揃えられるのは投手だけ＝デュオも投手にしか付きえない。
   * ここが食い違うと「野手が候補に出るのに永久に前提を満たせない」死に札になる。
   */
  it('前提に投手専用があればデュオ自身も投手専用', () => {
    for (const id of DUO_SKILL_IDS) {
      const def = SKILLS[id];
      if (def.requires!.some((req) => SKILLS[req].target === 'pitcher')) {
        expect(def.target).toBe('pitcher');
      }
    }
  });

  /** 前提2つは枠（`MAX_SKILLS_PER_PLAYER`）にちょうど収まる数でなければ揃えられない */
  it('デュオの前提は枠に収まる数（揃えられないデュオを作らない）', () => {
    for (const id of DUO_SKILL_IDS) {
      expect(SKILLS[id].requires!.length).toBeLessThanOrEqual(MAX_SKILLS_PER_PLAYER);
    }
  });

  /**
   * レーティングは 0..1 なので、1枚で 0.5 を超えて動かす補正は「素の能力値が意味を失う」
   * （名鑑の差が全部埋まる）。負の補正も同じ幅に収める。
   */
  it('レーティング補正は1枚あたり±0.5以内（名鑑の差を消し飛ばさない）', () => {
    for (const id of ALL_SKILL_IDS) {
      for (const value of Object.values(SKILLS[id].modifier ?? {})) {
        expect(Math.abs(value)).toBeLessThanOrEqual(0.5);
      }
    }
  });

  /**
   * 条件付きの補正（銃の弾数・ドロップキックの射程）は、前提スキルを持っていないと
   * 何も起きない＝**抽選プールに置くと死に札になる**。`requires` が前提を保証する
   * デュオにだけ置く、というのがF-26-5の約束。
   *
   * **F-26-8で例外が1つできた**：`テツゲタ` のように**その動詞を自分で解禁する消費型**は、
   * 単独で引いても必ず効く＝死に札にならないので、射程の補正を持ってよい
   * （デュオ限定にしていた理由がそもそも当たらない）。ここを緩めないと、常設の
   * `ドロップキック`（同じ★2で何度でも蹴れる）に対して回数だけ少ない下位互換になってしまう。
   */
  it('条件付きの補正（銃の弾数・蹴りの射程）は、デュオかその動詞を解禁する札にだけ置く', () => {
    for (const id of DRAFTABLE_SKILL_IDS) {
      const def = SKILLS[id];
      const verb = CONSUMABLE_VERB[id];
      if (def.play?.gunShots !== undefined) expect(verb, id).toBe('ju');
      if (def.play?.dropkickRange !== undefined) expect(verb, id).toBe('doroppukikku');
    }
    expect(SKILLS.homingudan.play?.gunShots).toBeGreaterThan(0);
    expect(SKILLS.roketokikku.play?.dropkickRange).toBeGreaterThan(0);
    expect(SKILLS.tetsugeta.play?.dropkickRange).toBeGreaterThan(0);
  });
});

describe('activeLineagesFor: 試合ごとの系統の絞り込み（F-26-5）', () => {
  it('必ず3系統・重複なし', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const lineages = activeLineagesFor(seed);
      expect(lineages).toHaveLength(ACTIVE_LINEAGE_COUNT);
      expect(new Set(lineages).size).toBe(ACTIVE_LINEAGE_COUNT);
      for (const lineage of lineages) expect(ALL_LINEAGES).toContain(lineage);
    }
  });

  it('並びは常に ALL_LINEAGES の順（引いた順で表示がばらつかない）', () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const lineages = activeLineagesFor(seed);
      const sorted = ALL_LINEAGES.filter((l) => lineages.includes(l));
      expect(lineages).toEqual(sorted);
    }
  });

  it('同じシードなら同じ顔ぶれ（試合まるごと再現できる）', () => {
    expect(activeLineagesFor(4649)).toEqual(activeLineagesFor(4649));
  });

  it('シードが違えば顔ぶれが変わりうる（試合ごとに性格が変わる）', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 100; seed += 1) seen.add(activeLineagesFor(seed).join(','));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('どの系統も出番がある（永久に出ない系統を作らない）', () => {
    const seen = new Set<SkillLineage>();
    for (let seed = 1; seed <= 200; seed += 1) {
      for (const lineage of activeLineagesFor(seed)) seen.add(lineage);
    }
    expect(seen.size).toBe(ALL_LINEAGES.length);
  });
});

describe('combinedPlay: プレー定数の補正（F-26-5）', () => {
  it('スキルなしなら補正なし', () => {
    expect(combinedPlay([])).toEqual({});
  });

  it('同じ項目は足し合わされる（イヌ＋タカで守備範囲が重なる）', () => {
    const both = combinedPlay(['inu', 'taka']);
    expect(both.catchRadius).toBeCloseTo(
      (SKILLS.inu.play!.catchRadius ?? 0) + (SKILLS.taka.play!.catchRadius ?? 0),
    );
  });

  it('レーティング補正とは別の棚（混ざらない）', () => {
    expect(combinedPlay(['kinniku'])).toEqual({});
    expect(combinedModifier(['inu'])).toEqual({});
  });

  it('知らないIDが混ざっていても壊れない', () => {
    expect(combinedPlay(['inu', 'nonexistent' as SkillId]).catchRadius).toBeCloseTo(0.6);
  });
});

// ---- 銃（フェーズF-26-2でオリジナル要素の銃を吸収した★3スキル） ----

describe('SKILLS: ジュウ', () => {
  it('★3の投手専用スキル（野手に付けても意味が無いので候補に出さない）', () => {
    expect(SKILLS.ju.rarity).toBe(3);
    expect(SKILLS.ju.target).toBe('pitcher');
  });

  it('動詞系＝データ側に効果を持たない（効くのは hasSkill を見る側）', () => {
    expect(SKILLS.ju.modifier).toBeUndefined();
    expect(SKILLS.ju.brawl).toBeUndefined();
    expect(combinedModifier(['ju'])).toEqual({});
    expect(brawlLoadoutFor(['ju'])).toEqual(brawlLoadoutFor([]));
  });

  it('抽選プールに載る（デュオではないので運で配られる側）', () => {
    expect(DRAFTABLE_SKILL_IDS).toContain('ju');
  });

  it('投手にだけ付けられる', () => {
    const pitcher = { id: 'p', canPitch: true, skills: [] };
    const fielder = { id: 'f', canPitch: false, skills: [] };
    expect(canGrant(pitcher, 'ju')).toBe(true);
    expect(canGrant(fielder, 'ju')).toBe(false);
  });

  it('弾数は名鑑側の定数として持つ（残弾の導出はロスター側）', () => {
    expect(GUN_SHOTS_PER_PITCHER).toBeGreaterThan(0);
  });
});

// ---- バイク（フェーズF-26-3。走力の上限そのものを踏み越える動詞系スキル） ----

describe('SKILLS: バイク', () => {
  it('★3のメカ系統で、走者になる全選手が対象（投手も打順に入るので pitcher に絞らない）', () => {
    expect(SKILLS.baiku.rarity).toBe(3);
    expect(SKILLS.baiku.lineage).toBe('mecha');
    expect(SKILLS.baiku.target).toBe('any');
  });

  it('動詞系＝データ側に効果を持たない（効くのは走塁を動かす側）', () => {
    expect(SKILLS.baiku.modifier).toBeUndefined();
    expect(SKILLS.baiku.brawl).toBeUndefined();
    expect(combinedModifier(['baiku'])).toEqual({});
    expect(brawlLoadoutFor(['baiku'])).toEqual(brawlLoadoutFor([]));
  });

  /**
   * `スケボー` は走力レーティングへの補正（上限8.2m/sは動かない）、`バイク` は上限を
   * 踏み越える動詞系。**同じメカ系統の走塁スキルでも表し方が違う**ことを固定しておく
   * ＝バイクをレーティング補正に書き換えると代償（オーバーラン）が消える。
   */
  it('同じ走塁でも スケボー はレーティング補正、バイク は動詞系', () => {
    expect(SKILLS.sukebo.modifier?.run).toBeGreaterThan(0);
    expect(SKILLS.baiku.modifier).toBeUndefined();
  });

  it('抽選プールに載り、誰にでも付けられる', () => {
    expect(DRAFTABLE_SKILL_IDS).toContain('baiku');
    expect(canGrant(holder('f'), 'baiku')).toBe(true);
    expect(canGrant(holder('p', [], true), 'baiku')).toBe(true);
  });
});

// ---- ドロップキック（フェーズF-26-4。試合そのものの中で野手を殴る動詞系スキル） ----

describe('SKILLS: ドロップキック', () => {
  it('★2のボウリョク系統で、走者になる全選手が対象', () => {
    expect(SKILLS.doroppukikku.rarity).toBe(2);
    expect(SKILLS.doroppukikku.lineage).toBe('violence');
    expect(SKILLS.doroppukikku.target).toBe('any');
  });

  /**
   * 同じボウリョク系統でも `ショウリュウケン` は乱闘という別の画面の中で効く（brawl を持つ）。
   * ドロップキックは**試合の中で**効くので、データ側には何も持たない＝効き先の違いが
   * 型に出ていることを固定しておく（brawl を足すと乱闘エンジンへ迷い込む）。
   */
  it('動詞系＝能力値は動かさない。乱闘では名前どおり急降下キックになる（XX-72）', () => {
    expect(SKILLS.doroppukikku.modifier).toBeUndefined();
    expect(combinedModifier(['doroppukikku'])).toEqual({});
    // 乱闘v3：跳んで↓＋K（体力・威力は動かさない＝必殺技が1つ増えるだけ）
    const lo = brawlLoadoutFor(['doroppukikku']);
    expect(lo.specials).toEqual(['divekick']);
    expect(lo.maxHp).toBe(brawlLoadoutFor([]).maxHp);
    expect(lo.powerScale).toBe(1);
  });

  it('抽選プールに載り、誰にでも付けられる', () => {
    expect(DRAFTABLE_SKILL_IDS).toContain('doroppukikku');
    expect(canGrant(holder('f'), 'doroppukikku')).toBe(true);
    expect(canGrant(holder('p', [], true), 'doroppukikku')).toBe(true);
  });

  /**
   * バイクと同じ枠（走塁中に押す動詞系）だが、**枠上限2は例外にしない**＝1人に
   * 両方を積むと他のスキルを一切持てなくなる、という選択になっている。
   */
  it('バイクと両立するが、枠を1つずつ食う', () => {
    expect(canGrant(holder('f', ['baiku']), 'doroppukikku')).toBe(true);
    expect(canGrant(holder('f', ['baiku', 'doroppukikku', 'kinniku']), 'sukebo')).toBe(false);
  });
});

// ---- 効果の合成 ----

describe('combinedModifier: パラメータ系の合成', () => {
  it('スキルなしなら補正なし', () => {
    expect(combinedModifier([])).toEqual({});
  });

  it('同じ項目の補正は足し合わされる', () => {
    const mod = combinedModifier(['kinniku', 'kinniku']);
    expect(mod.power).toBeCloseTo((SKILLS.kinniku.modifier!.power ?? 0) * 2);
  });

  it('違う項目の補正は別々に乗る', () => {
    const mod = combinedModifier(['kinniku', 'sukebo']);
    expect(mod.power).toBeCloseTo(SKILLS.kinniku.modifier!.power!);
    expect(mod.run).toBeCloseTo(SKILLS.sukebo.modifier!.run!);
  });

  it('乱闘スキルはパラメータ補正を持たない（効き先が違う）', () => {
    expect(combinedModifier(['shoryuken', 'kenkappayai'])).toEqual({});
  });
});

describe('brawlLoadoutFor: 乱闘の装備（乱闘v3。XX-72）', () => {
  it('スキルなしなら既定＝必殺技も超必殺も無い（通常技と投げだけ）', () => {
    const loadout = brawlLoadoutFor([]);
    expect(loadout.maxHp).toBe(BRAWL_MAX_HP);
    expect(loadout.powerScale).toBe(1);
    expect(loadout.specials).toEqual([]);
    expect(loadout.super).toBeNull();
    expect(loadout.passives).toEqual(DEFAULT_LOADOUT.passives);
  });

  it('名前どおりの必殺技を配る（昇龍拳・波動拳・竜巻旋風脚・頭突き・百裂張り手・武器・子分）', () => {
    expect(brawlLoadoutFor(['shoryuken']).specials).toContain('shoryu');
    expect(brawlLoadoutFor(['hadouken']).specials).toContain('hadou');
    expect(brawlLoadoutFor(['karate']).specials).toContain('tatsu');
    expect(brawlLoadoutFor(['dosukoi']).specials).toContain('hyakuretsu');
    expect(brawlLoadoutFor(['bukimochikomi']).specials).toContain('buki');
    expect(brawlLoadoutFor(['oyabun']).specials).toContain('kobun');
    expect(brawlLoadoutFor(['doroppukikku']).specials).toContain('divekick');
  });

  it('体質を配る札（ダッシュ・鉄の拳・怒り・アーマー・威嚇）', () => {
    expect(brawlLoadoutFor(['kenkappayai']).passives.dash).toBe(true);
    expect(brawlLoadoutFor(['tekko']).passives.ironFist).toBe(true);
    expect(brawlLoadoutFor(['abareguse']).passives.rage).toBeGreaterThan(1);
    expect(brawlLoadoutFor(['haganenokarada']).passives.armor).toBeGreaterThan(0);
    expect(brawlLoadoutFor(['ikaku']).passives.intimidate).toBeLessThan(1);
  });

  it('デュオは超必殺を配る（前提2つの必殺技はそのまま残る）', () => {
    const batto = brawlLoadoutFor(['shoryuken', 'bukimochikomi', 'battoshoryuken']);
    expect(batto.super).toBe('batto');
    expect(batto.specials).toEqual(expect.arrayContaining(['shoryu', 'buki']));
    const shinku = brawlLoadoutFor(['hadouken', 'karate', 'shinkuhadouken']);
    expect(shinku.super).toBe('shinku');
    expect(shinku.specials).toEqual(expect.arrayContaining(['hadou', 'tatsu']));
  });

  it('真空波動拳の前提は同じ系統の2枚（波動拳・空手）', () => {
    expect(SKILLS.shinkuhadouken.requires).toEqual(['hadouken', 'karate']);
    for (const id of SKILLS.shinkuhadouken.requires!) {
      expect(SKILLS[id].lineage).toBe(SKILLS.shinkuhadouken.lineage);
    }
  });

  it('威力は足し算で重なる（フェーズI-29と同じ重ね方）', () => {
    const lo = brawlLoadoutFor(['tekko', 'bukimochikomi']);
    expect(lo.powerScale).toBeCloseTo(1 + 0.1 + 0.25);
  });

  it('どんなに威力を積んでも、1発では相手を倒しきれない（当てれば勝ちにしない）', () => {
    // 抽選だけで積める最悪の組（威力の上がる札を枠いっぱいまで）に、怒りの倍率まで乗せる
    const draftablePower = DRAFTABLE_SKILL_IDS.filter(
      (id) => (SKILLS[id].brawl?.powerScale ?? 0) > 1,
    );
    const worst = [...draftablePower]
      .sort((a, b) => (SKILLS[b].brawl?.powerScale ?? 0) - (SKILLS[a].brawl?.powerScale ?? 0))
      .slice(0, MAX_SKILLS_PER_PLAYER);
    expect(worst).toHaveLength(MAX_SKILLS_PER_PLAYER);
    const lo = brawlLoadoutFor(worst);
    const strongest = Math.max(...Object.values(MOVES).map((m) => m.damage * (m.hits ?? 1)));
    const rage = brawlLoadoutFor(['abareguse']).passives.rage;
    expect(strongest * lo.powerScale * rage).toBeLessThan(BRAWL_MAX_HP);
  });

  it('知らないIDが混ざっていても壊れない', () => {
    expect(brawlLoadoutFor(['shoryuken', 'nonexistent' as SkillId]).specials).toContain('shoryu');
  });
});

// ---- 付与の可否（枠・重複・対象・デュオ） ----

describe('canGrant: 付与の可否', () => {
  it('空き枠があれば付けられる', () => {
    expect(canGrant(holder('a'), 'kinniku')).toBe(true);
  });

  it('枠が埋まっていれば付けられない（1選手 MAX_SKILLS_PER_PLAYER まで）', () => {
    const full = holder('a', ['kinniku', 'sukebo', 'yochi']);
    expect(full.skills).toHaveLength(MAX_SKILLS_PER_PLAYER);
    expect(canGrant(full, 'shoryuken')).toBe(false);
  });

  it('同じスキルは二重に付かない', () => {
    expect(canGrant(holder('a', ['kinniku']), 'kinniku')).toBe(false);
  });

  it('投手専用スキルは野手に付かない', () => {
    expect(canGrant(holder('a', [], false), 'tafunesu')).toBe(false);
    expect(canGrant(holder('p', [], true), 'tafunesu')).toBe(true);
  });

  it('デュオは前提2つを同じ選手が持っているときだけ付く', () => {
    expect(canGrant(holder('a', ['shoryuken']), 'battoshoryuken')).toBe(false);
    expect(canGrant(holder('a', ['bukimochikomi']), 'battoshoryuken')).toBe(false);
    expect(canGrant(holder('a', ['shoryuken', 'bukimochikomi']), 'battoshoryuken')).toBe(true);
  });

  it('デュオは枠上限の例外＝枠が埋まっていても前提が揃っていれば付く', () => {
    const full = holder('a', ['shoryuken', 'bukimochikomi', 'kinniku']);
    expect(full.skills).toHaveLength(MAX_SKILLS_PER_PLAYER);
    expect(canGrant(full, 'battoshoryuken')).toBe(true);
    // 枠が埋まっている以上、デュオ以外は付かないまま
    expect(canGrant(full, 'kinniku')).toBe(false);
  });

  it('前提が別々の選手に散っているとデュオは出ない（誰に集めるかがランの目標になる）', () => {
    const holders = [holder('a', ['shoryuken']), holder('b', ['bukimochikomi'])];
    expect(eligibleHolders(holders, 'battoshoryuken')).toHaveLength(0);
  });
});

// ---- 抽選 ----

describe('drawSkillDraft: 3択の生成', () => {
  const roster = () => [holder('a'), holder('b'), holder('p', [], true)];

  it('3つ提示され、重複しない', () => {
    const { draft } = drawSkillDraft(createRngState(DEFAULT_SEED), roster());
    expect(draft.options).toHaveLength(DRAFT_OPTION_COUNT);
    expect(new Set(draft.options).size).toBe(DRAFT_OPTION_COUNT);
  });

  it('同じ状態からは同じ3択が出る（シードを固定すれば再現できる）', () => {
    const a = drawSkillDraft(createRngState(555), roster());
    const b = drawSkillDraft(createRngState(555), roster());
    expect(a.draft.options).toEqual(b.draft.options);
    expect(a.state).toBe(b.state);
  });

  it('引くと乱数の状態が進む（同じ回に同じ候補が出続けない）', () => {
    const first = drawSkillDraft(createRngState(DEFAULT_SEED), roster());
    const second = drawSkillDraft(first.state, roster());
    expect(second.state).not.toBe(first.state);
  });

  it('付けられる選手がいないスキルは候補に出ない（押しても何も起きない選択肢を並べない）', () => {
    // 野手だけ＝投手専用の tafunesu はどの選手にも付かない
    const fieldersOnly = [holder('a'), holder('b')];
    for (let seed = 1; seed <= 60; seed += 1) {
      const { draft } = drawSkillDraft(createRngState(seed), fieldersOnly);
      expect(draft.options).not.toContain('tafunesu');
    }
  });

  it('全員の枠が埋まっていれば候補は0件（抽選そのものが起きない）', () => {
    const full = [
      holder('a', ['kinniku', 'sukebo', 'yochi']),
      holder('b', ['kinniku', 'sukebo', 'yochi']),
    ];
    expect(drawSkillDraft(createRngState(DEFAULT_SEED), full).draft.options).toHaveLength(0);
  });

  it('前提が揃っているデュオは必ず候補に入る（揃えた報酬が運で流れない）', () => {
    const withDuo = [holder('a', ['shoryuken', 'bukimochikomi']), holder('b')];
    for (let seed = 1; seed <= 40; seed += 1) {
      const { draft } = drawSkillDraft(createRngState(seed), withDuo);
      expect(draft.options).toContain('battoshoryuken');
    }
  });

  it('★1が★3より多く出る（レアなほど出にくい）', () => {
    const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
    for (let seed = 1; seed <= 400; seed += 1) {
      const { draft } = drawSkillDraft(createRngState(seed), roster());
      // 3択の先頭＝最初に引かれた1枚だけを数える（後続は重複除外で分布が歪むため）
      counts[skillDef(draft.options[0]).rarity] += 1;
    }
    expect(counts[1]).toBeGreaterThan(counts[3]);
  });

  /**
   * **出現比は枚数によらず `DRAFT_RARITY_WEIGHT` のとおりになる**（フェーズF-26-5）。
   * レアリティを先に引いてからその中で等確率に選ぶ（`drawOneFromPool`）ので、★1の
   * スキルを何枚足しても 60:30:10 は動かない＝プールを増やすたびに重みを調整し直さずに済む。
   * これが崩れると、★の数（画面に出る情報）と実際の出やすさが食い違う。
   */
  it('レアリティの出現比が重みどおり（枚数の偏りに引きずられない）', () => {
    const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
    const trials = 3000;
    for (let seed = 1; seed <= trials; seed += 1) {
      const { draft } = drawSkillDraft(createRngState(seed), roster());
      counts[skillDef(draft.options[0]).rarity] += 1;
    }
    const total = DRAFT_RARITY_WEIGHT[1]! + DRAFT_RARITY_WEIGHT[2]! + DRAFT_RARITY_WEIGHT[3]!;
    for (const rarity of [1, 2, 3] as const) {
      const expected = DRAFT_RARITY_WEIGHT[rarity]! / total;
      expect(counts[rarity] / trials).toBeCloseTo(expected, 1);
    }
  });
});

describe('drawSkillDraft: 試合ごとの系統の絞り込み（F-26-5）', () => {
  const roster = () => [holder('a'), holder('b'), holder('p', [], true)];

  it('指定した系統のスキルしか候補に出ない', () => {
    const lineages: SkillLineage[] = ['animal', 'guts'];
    for (let seed = 1; seed <= 120; seed += 1) {
      const { draft } = drawSkillDraft(createRngState(seed), roster(), lineages);
      for (const id of draft.options) expect(lineages).toContain(SKILLS[id].lineage);
    }
  });

  it('系統を省略すると全系統から出る（絞り込みを入れる前と同じ挙動）', () => {
    const seen = new Set<SkillLineage>();
    for (let seed = 1; seed <= 300; seed += 1) {
      for (const id of drawSkillDraft(createRngState(seed), roster()).draft.options) {
        seen.add(SKILLS[id].lineage);
      }
    }
    expect(seen.size).toBe(ALL_LINEAGES.length);
  });

  /**
   * **どの3系統の組み合わせでも3択が成立する**こと。ここが崩れると、特定の系統を
   * 引いた試合だけ候補が2つしか出ない（＝選択が選択でなくなる）。
   */
  it('どの3系統の組み合わせでも3択が埋まる', () => {
    for (let i = 0; i < ALL_LINEAGES.length; i += 1) {
      for (let j = i + 1; j < ALL_LINEAGES.length; j += 1) {
        for (let k = j + 1; k < ALL_LINEAGES.length; k += 1) {
          const lineages = [ALL_LINEAGES[i], ALL_LINEAGES[j], ALL_LINEAGES[k]];
          const { draft } = drawSkillDraft(createRngState(7), roster(), lineages);
          expect(draft.options).toHaveLength(DRAFT_OPTION_COUNT);
        }
      }
    }
  });

  it('系統外のデュオは前提が揃っていても出ない（絞り込みはデュオにも効く）', () => {
    const withDuo = [holder('a', ['shoryuken', 'bukimochikomi']), holder('b')];
    const { draft } = drawSkillDraft(createRngState(3), withDuo, ['animal', 'guts', 'mecha']);
    expect(draft.options).not.toContain('battoshoryuken');
  });

  it('系統内のデュオは絞り込んでも必ず候補に入る', () => {
    const withDuo = [holder('a', ['shoryuken', 'bukimochikomi']), holder('b')];
    for (let seed = 1; seed <= 40; seed += 1) {
      const { draft } = drawSkillDraft(createRngState(seed), withDuo, ['violence', 'animal', 'guts']);
      expect(draft.options).toContain('battoshoryuken');
    }
  });

  /**
   * **絞り込みの目的そのもの**＝同じ系統の札が繰り返し出るので、デュオの前提2つが
   * 両方めぐってくる確率が上がる。
   *
   * **測る単位は「1ラン」**（フェーズF-26-6）：デュオを揃えるのに使えるのは1試合ではなく
   * 5試合ぶんの抽選なので、`RUN_GAMES × DRAFTS_PER_GAME` を1本の物差しにする。ここを
   * 1試合のままにしておくと、プールを増やすたびに「1試合では揃わない」という
   * **もう誰も遊んでいない単位での失敗**を報告し続けることになる（F-26-7でプールを
   * 35→60に増やしたとき、実際にこのテストが1試合の値で落ちて気づいた）。
   *
   * 具体的な確率ではなく**絞る前との大小**を固定するのは、スキルを足すたびに絶対値が
   * 動くから。実測（プール60）では★2+★3の `バットリュウケン` の前提が
   * **1ランで81%（絞りなしでは58%）／1試合では10%**。
   */
  it('絞ったほうがデュオの前提が揃いやすい（絞り込みの目的）', () => {
    const holders = [holder('a'), holder('b'), holder('c'), holder('d'), holder('e', [], true)];
    const drafts = RUN_GAMES * DRAFTS_PER_GAME;
    const bothSeenRate = (lineages?: readonly SkillLineage[]): number => {
      let runs = 0;
      for (let seed = 1; seed <= 200; seed += 1) {
        let state = createRngState(seed);
        const seen = new Set<SkillId>();
        for (let i = 0; i < drafts; i += 1) {
          const { draft, state: next } = drawSkillDraft(state, holders, lineages);
          state = next;
          for (const id of draft.options) seen.add(id);
        }
        if (seen.has('shoryuken') && seen.has('bukimochikomi')) runs += 1;
      }
      return runs / 200;
    };
    const narrowed = bothSeenRate(['violence', 'animal', 'guts']);
    expect(narrowed).toBeGreaterThan(bothSeenRate());
    // 「揃えにいく判断」が成立する程度には起きる（運任せではない）。いちばん重い
    // ★2+★3の組で、1ランのうちに半分以上は前提がめぐってくること。
    expect(narrowed).toBeGreaterThan(0.5);
  });
});

describe('cpuChooseSkill: CPUの決定的な選択', () => {
  const holders = () => [holder('a'), holder('b'), holder('p', [], true)];

  it('同じ入力からは必ず同じ選択になる（乱数を引かない＝イカサマの余地が無い）', () => {
    const draft = { options: ['kinniku', 'shoryuken', 'sukebo'] as SkillId[] };
    const first = cpuChooseSkill(draft, holders());
    const second = cpuChooseSkill(draft, holders());
    expect(first).toEqual(second);
  });

  it('候補のうち最もレアなものを取る', () => {
    const draft = { options: ['kinniku', 'bukimochikomi', 'shoryuken'] as SkillId[] };
    expect(cpuChooseSkill(draft, holders())?.skillId).toBe('bukimochikomi');
  });

  it('同率なら候補の並び順の先を取る', () => {
    const draft = { options: ['kinniku', 'sukebo'] as SkillId[] };
    expect(cpuChooseSkill(draft, holders())?.skillId).toBe('kinniku');
  });

  it('付ける先は候補の並び順の先頭（打順の上位から埋まる）', () => {
    const draft = { options: ['kinniku'] as SkillId[] };
    expect(cpuChooseSkill(draft, holders())?.holderId).toBe('a');
  });

  it('投手専用スキルは投手に付ける', () => {
    const draft = { options: ['tafunesu'] as SkillId[] };
    expect(cpuChooseSkill(draft, holders())?.holderId).toBe('p');
  });

  it('デュオが候補にあれば最優先で取る（★4が最もレアなため）', () => {
    const withDuo = [holder('a', ['shoryuken', 'bukimochikomi']), holder('b')];
    const draft = { options: ['battoshoryuken', 'kinniku'] as SkillId[] };
    const picked = cpuChooseSkill(draft, withDuo);
    expect(picked?.skillId).toBe('battoshoryuken');
    expect(picked?.holderId).toBe('a');
  });

  it('誰にも付けられなければ null（呼び出し側が畳める）', () => {
    const full = [holder('a', ['kinniku', 'sukebo', 'yochi'])];
    expect(cpuChooseSkill({ options: ['shoryuken'] }, full)).toBeNull();
  });
});
