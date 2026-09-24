/**
 * スキル名鑑と抽選（フェーズF-26-1。CLAUDE.md ⑧ローグライト要素）。
 *
 * **このファイルは「動かないデータ」と「純粋な抽選ロジック」だけを持つ**（`teams.ts` が
 * 16球団の名鑑1ファイルであるのと同じ形）。誰が何を持っているかという試合中の状態は
 * `TeamRoster.skills` が、乱数の状態は `GameContext.rngState` が持つ。
 * **スキルを増やすときに触るのは原則このファイルの `SKILLS` だけ**になるようにしてある。
 *
 * ## スキルの2つの形
 *
 * - **パラメータ系**（`modifier`）：能力値レーティング（AV/HR/RUN/SPD/STM…）への補正として
 *   表す。**独自の係数を持たない**ので、`roster.ts` の `effectiveBatting`/`effectivePitching`
 *   を通すだけで打球初速も走者速度もHUDの表示（`displayHomeRuns` 等）も自動で追従する
 *   （⑥の「表示はレーティングからの導出」がそのまま効く）。
 * - **動詞系**：新しい操作を解禁するもの。データ側には何も持たず、使う場所が
 *   `hasSkill(roster, id, 'shoryuken')` と問い合わせる。銃・バイク・ドロップキック・必殺技。
 *
 * ## ハデス方式（CLAUDE.md ⑧）
 *
 * - **1選手の枠は `MAX_SKILLS_PER_PLAYER` まで**＝取ることが別の可能性を閉じる。
 * - **デュオ**（`requires`）＝特定の1〜2つを**同じ選手が**持つと候補に出る合体スキル。
 *   **枠上限の例外で、枠が埋まっていても付く**（枠に阻まれて取れないとランの目標にならないため）。
 * - **★4はデュオ専用で抽選プールに置かない**＝強いものを引く運ではなく、揃えにいく判断。
 *
 * ## 消費型（`charges`。フェーズF-26-8）
 *
 * **使うたびに減り、使い切ると枠が空く札**。ここまでの札は「取ったらランの終わりまで
 * ずっと効く」ものだけだったので、**動詞系には「使う判断」が存在しなかった**
 * （銃・バイク・ドロップキックの「1プレーに1回」は連打の禁止であって、使うか使わないかの
 * 判断ではない＝機会が来たら必ず使うのが正解）。消費型はそこにリスク側を足す
 * （桜井ノウハウ「ゲーム性とは駆け引き、そしてリスクとリターン」「リスクとリターンは
 * かなり近いところに適切な大きさに配置しなければならない」）。
 *
 * - **回数はラン全体**（`RUN_GAMES` 試合を通して `charges` 回）。試合ごとに回復させると
 *   持ち続けるコストが消えて、「温存する／しない」の判断そのものが無くなる。
 * - **使い切った札は枠を返す**（`roster.ts` の `liveSkillsOf`）。使うリターンは効果だけでなく
 *   **枠が空いて次の札が入ること**でもある＝温存には必ず対価がある（桜井ノウハウ
 *   「支払いがあることで貯め込みが楽しくなる／無限に資材だけが増えて使い道が何もない
 *   採掘ゲームがあってもしょうがない」）。
 * - **強化デュオ（`chargeBonus`）は未使用のあいだだけ候補に出る**：`requires` は
 *   **使い切っていない札**しか数えないので、使った瞬間に強化の目が消える。
 *   「いま使うか、温存して強化を狙うか」はこの1つの規則から出ている。
 * - **消費型は常設の動詞の代用**（`CONSUMABLE_VERB`）。常設の札を持っていれば
 *   チャージは減らない＝両方持てば実質そのまま常設になる。
 *
 * ## 一時効果（`duration`。フェーズM-33）
 *
 * **F-26-8が残していた穴を埋める4つ目の軸。** 消費型が置けるのは動詞を持つ2系統
 * （ボウリョク・メカ）だけで、チョウノウリョク・ドウブツ・コンジョウには「使う瞬間」のある
 * 札が1枚も無かった（＝取ったら効きっぱなしで、判断が抽選の一度きりしか無い）。
 *
 * **`duration` は効果の種類ではなく「効く長さ」の軸**＝既存の3つの形（`modifier` /
 * `play` / `brawl`）に掛け合わせる。だから判定側には新しい経路がまったく増えない：
 * `roster.ts` の `effectiveSkillsOf` が「いま効いている札」を絞り込むだけで、
 * `effectiveBatting` も `effectivePlay` も従来のまま動く（打球初速もHUDのカードの数字も
 * 一緒に動く＝CLAUDE.md ⑥「表示はレーティングからの導出」がそのまま効く）。
 *
 * - **一時効果は必ず消費型**（`charges` 必須。`tests/skills.test.ts` が固定）。回数券でなければ
 *   毎打席切るのが最適解になり、「いつ切るか」という判断そのものが消える。
 * - **1打席だけ**（`'atBat'`）。打者側は自分の打席、守備側はその打席の打球＝**同じ1つの単位で
 *   両方が書ける**。寿命の終わりは `gameMachine` の `advanceLineup`（打席が終わる唯一の場所）
 *   1か所が畳む。
 */
import type { BrawlPassives, FighterLoadout, SpecialId, SuperId } from './brawl';
import { BRAWL_MAX_HP, DEFAULT_LOADOUT } from './brawl';
import { type RngState, createRngState, nextIndex, nextWeightedIndex, sampleWithoutReplacement } from './rng';

/** 系統（ハデスの神に相当）。「今回はメカビルド」と言語化できることがビルドの認識に要る */
export type SkillLineage = 'violence' | 'mecha' | 'psychic' | 'animal' | 'guts';

export const LINEAGE_NAME: Record<SkillLineage, string> = {
  violence: '暴力',
  mecha: 'メカ',
  psychic: '超能力',
  animal: '動物',
  guts: '根性',
};

/**
 * 系統の宣言順（＝表示順）。**この並びが「今回の系統」の見え方を決める**ので、
 * 抽選の順序に関係なくいつも同じ順に並ぶよう、絞り込みの結果はここへ揃えて出す。
 */
export const ALL_LINEAGES: readonly SkillLineage[] = [
  'violence',
  'mecha',
  'psychic',
  'animal',
  'guts',
];

/**
 * 系統ごとの担当領域（フェーズF-26-5。CLAUDE.md ⑧「今回はメカビルド、と言語化できること」）。
 *
 * **効果の種類を系統に割り当てる**ことで、「その系統を引いた試合はこういう試合になる」が
 * 成立する。名前の雰囲気だけを分けても、どの系統からも同じ効果が出てくるなら
 * ビルドの性格は生まれない。
 *
 * - `violence` ボウリョク＝**乱闘と妨害**（体力・威力・必殺技／ドロップキック）
 * - `mecha` メカ＝**走塁と飛び道具**（走力／球速／銃・バイク）
 * - `psychic` チョウノウリョク＝**投球と読み**（変化量／打撃の芯を外さない）
 * - `animal` ドウブツ＝**守備と走塁の勘**（捕球範囲／盗塁のスタート）
 * - `guts` コンジョウ＝**能力値の底上げ**（長打力・打率・スタミナと、その代償）
 */
export const LINEAGE_DOMAIN: Record<SkillLineage, string> = {
  violence: '乱闘と妨害',
  mecha: '走塁と飛び道具',
  psychic: '投球と読み',
  animal: '守備と走塁の勘',
  guts: '能力値の底上げ',
};

/** ★1（地味に効く）〜★4（デュオ専用）。数値が大きいほどレアで強い */
export type SkillRarity = 1 | 2 | 3 | 4;

/** デュオのレアリティ。抽選プールには置かない（`DRAFT_RARITY_WEIGHT` にキーが無い） */
export const DUO_RARITY: SkillRarity = 4;

/**
 * 抽選での出現比。★4が無いのは**デュオを運で配らない**ため（前提を揃えた選手への報酬）。
 * 比としてのみ意味を持つので合計を100に揃える必要はない。
 *
 * **この比はスキルの枚数によらずそのまま成り立つ**（フェーズF-26-5）：抽選はまず
 * ここからレアリティを引き、そのレアリティの中から等確率で1枚選ぶ（`drawOneFromPool`）。
 * 各スキルに重みを付けて一括で引くと、★1の枚数を増やしただけで★1の出現率が上がってしまい、
 * プールを増やすたびにここの数字を調整し直す羽目になる。
 */
export const DRAFT_RARITY_WEIGHT: Partial<Record<SkillRarity, number>> = {
  1: 60,
  2: 30,
  3: 10,
};

/**
 * 1選手が持てるスキルの上限（デュオはこの例外＝もう1つ上として付く）。
 *
 * **ラン化（F-26-6）で 2 → 3 にした。** 抽選の回数はラン全体で
 * `RUN_GAMES × DRAFTS_PER_GAME` ＝ 5×9 ＝ **45回**になったのに対し、スキルを置ける枠は
 * ロスター17人（打線9＋ブルペン5＋控え3）×上限。上限2だと 34枠しかなく、**最終戦の
 * 途中で全員の枠が埋まって「候補が作れず何も起きない抽選」だけが残る**（ローグライトの
 * 山場がいちばん静かになる）。3なら51枠で最後まで置き場所があり、それでいて
 * **実際に試合へ出る打線9人ぶんは27枠しかない**ので、⑧の中心にある「枠の奪い合い」
 * （4番に3つ目を積むか、まだ空いている7番に付けるか）は終盤ほど強くなる。
 */
export const MAX_SKILLS_PER_PLAYER = 3;

/**
 * 表示名の最大文字数。**HUDの選手カードは2つぶんを1行に並べる**ので、ここを緩めると
 * `スキル ○○○○○○○○ ○○○○○○○○` の行がカードを横に広げ、D-18で詰めた
 * 「パネル同士が重ならない」配置を崩しうる。選手名がカタカナ4文字以内（`teams.ts`）なのと
 * 同じ理由の制約で、`tests/skills.test.ts` が全スキルについて固定する。
 */
export const SKILL_NAME_MAX_LENGTH = 8;
/** 説明文の最大文字数（3択画面の1行） */
export const SKILL_TEXT_MAX_LENGTH = 24;

/** 1回の抽選で提示する候補の数 */
export const DRAFT_OPTION_COUNT = 3;

/**
 * **リロール**（抽選のやり直し）の回数（フェーズU-42。ハデスの Fated Persuasion に相当）。
 * 2026-08-07 ユーザー判断：**ラン全体でこの回数だけ**（試合ごとに回復させない）／
 * **3枚まるごと引き直す**（1枚だけの選び直しではない）／**CPUも同じ回数券を持つ**。
 *
 * F-26-8（消費型スキル）とまったく同じ整理で持つ：**真実は「使った数」の側**
 * （`GameContext.rerollsUsed` / `RunState.rerollsUsed`）で、残りはそこからの導出
 * （`rerollsLeft`）＝「もう引き直せないのに残り回数だけ出ている」が構造的に起きない。
 * **試合ごとに回復させない**のも同じ理由で、回復させると「今引き直すか、終盤の
 * デュオ狙いに残すか」という温存の判断そのものが消える（F-26-8の結論）。
 *
 * **総数がここ（`skills.ts`）にあるのは、消費型の総数が `SkillDef.charges` にあるのと同じ形**
 * ＝ラン（試合の外側）を `gameMachine` に知らせずに済む（CLAUDE.md ⑧「ランは試合の外側」）。
 *
 * ## 値の根拠（`npm run balance:draft`）
 *
 * 1. **効く**：狙ったデュオが1ランで揃う割合が 10.3% → **22.8%**（前提が1つ揃ってから
 *    切る打ち手。すぐ切る打ち手でも 14.2%）。
 * 2. **確実にはならない**：それでも8割近いランでは揃わない＝F-26-5の狙い（強いものを
 *    引く運ではなく、**揃えにいく判断**）が保たれる。
 * 3. **「毎試合1回」に届かない**（`RUN_GAMES`=5 > 3）＝**ラン全体の資源であって
 *    試合ごとの資源にならない**上限。ユーザー判断が構造として効くための条件。
 * 4. **CPUは必ず序盤で使い切る**：CPUの規則（`shouldCpuReroll`）は1ラン45回の抽選で
 *    **8.56回**言うので、3回では最初の1試合半で尽きる＝F-26-8の
 *    「**CPUは温存しない／温存は人間の取り分**」がそのまま成り立つ。
 */
export const REROLLS_PER_RUN = 3;

/**
 * 残りのリロール回数（**使った数からの導出**）。B-11の投球数→残りスタミナ、
 * F-26-2の撃った数→残弾、F-26-8のチャージとまったく同じ形。
 */
export function rerollsLeft(used: number): number {
  return Math.max(0, REROLLS_PER_RUN - used);
}

/**
 * その試合で候補に出る系統の数（フェーズF-26-5。ハデスの「そのランに出る神」に相当）。
 *
 * プールが41まで増えた時点で、**全部から均等に引くとデュオの相方が出なくなる**
 * （前提2つを同じ選手に揃えるのが運任せになり、CLAUDE.md ⑧の「強いものを引く運ではなく、
 * 揃えにいく判断」が成立しない）。5系統のうち3つに絞れば実質のプールは 41→25 前後になり、
 * 同じ系統の札が繰り返し出る＝**揃えにいく判断が現実的になる**。
 *
 * 副産物として「今回はメカとドウブツの試合」という**試合ごとの性格**が生まれる。
 * これは⑧が求めていた「今回はメカビルド、と言語化できること」そのもので、
 * 5系統すべてが毎試合出ていると、どの試合も同じ顔になる。
 *
 * **絞るのは試合単位で、両チーム共通**（先攻・後攻で候補の系統が違うと、
 * どちらが有利かが引きの前に決まってしまう＝⑧の「CPUも対等」が崩れる）。
 */
export const ACTIVE_LINEAGE_COUNT = 3;

/**
 * 系統の抽選に混ぜる塩（フェーズF-26-5）。**本編の乱数列（`GameContext.rngState`）を
 * 消費せずに**系統を決めるために、同じシードから別系列を起こす。
 *
 * 消費しない理由は2つ：(1) 「シードを渡さない `MATCH_SETUP` は既定シードのまま」という
 * 既存の約束（テストが決定的に書ける）を保つため。(2) 系統は試合開始時に一度決まるだけの
 * 値で、抽選の系列に割り込ませると「何回目の抽選か」と乱数の位置がずれる。
 */
const LINEAGE_SEED_SALT = 0x5eed;

/**
 * その試合で候補に出る系統（シードから決まる純粋関数）。**結果は `ALL_LINEAGES` の順に
 * 揃えて返す**ので、引いた順番によらず表示は常に同じ並びになる。
 */
export function activeLineagesFor(seed: number): readonly SkillLineage[] {
  const { picked } = sampleWithoutReplacement(
    createRngState(seed + LINEAGE_SEED_SALT),
    ALL_LINEAGES,
    ACTIVE_LINEAGE_COUNT,
  );
  return ALL_LINEAGES.filter((lineage) => picked.includes(lineage));
}

/**
 * 付与できる相手。**'pitcher' は投球能力を持つ選手だけ**（投手にしか意味の無いスキルを
 * 野手に付けさせない＝死に札を構造的に減らす）。走塁・打撃・守備のスキルは全選手が
 * 打者にも走者にもなるので 'any'。細かい対象が要るスキルが出てきたら値を足す。
 */
export type SkillTarget = 'pitcher' | 'any';

/**
 * 能力値レーティングへの補正。フィールド名は `BatterStats`/`PitcherStats` と同じにしてあり、
 * 適用側（`roster.ts`）は名前で足して 0..1 にクランプするだけで済む。
 */
export interface StatModifier {
  average?: number;
  power?: number;
  run?: number;
  speed?: number;
  breakRight?: number;
  breakLeft?: number;
  fork?: number;
  stamina?: number;
  /**
   * **制球**（フェーズW-44。+が良くなる）。他の項目と違って `PitcherStats` に同名の
   * フィールドが無いのは、原作の名鑑（説明書p26-29）が持つのが **ERA**（実数値）だから
   * ＝`roster.ts` の `effectivePitching` が `eraWithControl` で**ERAそのものへ書き戻す**
   * （ユーザー判断）。おかげで**HUDの投手カードの防御率が一緒に動く**＝⑧の
   * 「パラメータ系はHUDの表示も自動で追従する」がこの軸でも成り立つ。
   */
  control?: number;
}

/**
 * **既存のプレー定数への補正**（フェーズF-26-5）。能力値レーティング（`StatModifier`）に
 * 畳めない「守備の届く範囲」「盗塁のスタート位置」のような値を、**専用の係数を作らずに
 * 既存の定数への足し算**として表す。
 *
 * 原作（説明書p26-29）に守備の能力項目は無い（CLAUDE.md ⑥）ので、ここは**ローグライトで
 * 初めて守備に個人差が付く**場所になる。名鑑の側には一切書かない＝素の選手は従来どおり
 * 全員同じ守備範囲のままで、スキルを取った選手だけがそこから伸びる。
 *
 * どの項目も**既存の判定の形を変えない**ものだけを選んである：
 * - `catchRadius` は毎フレームの幾何判定（`canCatch`）に足すだけ＝送球の時間競争には触れない。
 * - `stealLead` は走り出す位置を動かすだけ（`stealSafeJumpSec` は元から lead を引数に取る）。
 * - `gunShots` / `dropkickRange` は**デュオ専用**（前提スキルを持っていないと意味が無い値なので、
 *   `requires` で前提が保証されるデュオに置く＝抽選プールに死に札を作らない）。
 */
export interface PlayModifier {
  /** 捕球の届く半径 +m（`CATCH_RADIUS`。ファインプレイの伸びたリーチにも同じだけ乗る） */
  catchRadius?: number;
  /** 盗塁のスタート位置 +m（`STEAL_LEAD`。深いほど間に合いやすい） */
  stealLead?: number;
  /** 銃の弾数 +発（`GUN_SHOTS_PER_PITCHER`。デュオ専用） */
  gunShots?: number;
  /** ドロップキックの射程 +m（`DROPKICK_RANGE`。警告距離も導出なので一緒に伸びる。デュオ専用） */
  dropkickRange?: number;
}

/**
 * 乱闘への効果（動詞系のうち、乱闘だけは値で表せるのでここに持つ）。
 * 乱闘v3（フェーズXX-72）で**必殺技・超必殺・体質**の3つを配れるようにした。
 */
export interface BrawlModifier {
  /** 体力の上乗せ */
  hp?: number;
  /** 技の威力倍率（重ねがけは足し算＝`brawlLoadoutFor`） */
  powerScale?: number;
  /** 配る必殺技（コマンドで出る） */
  special?: SpecialId;
  /** 配る超必殺（ゲージ満タンで G） */
  super?: SuperId;
  /** 体質（ダッシュ・スーパーアーマー・怒り・鉄の拳・威嚇…） */
  passive?: Partial<BrawlPassives>;
}

export type SkillId =
  // ボウリョク（乱闘と妨害）
  | 'kenkappayai'
  | 'tekko'
  | 'zutsuki'
  | 'karate'
  | 'dosukoi'
  | 'shoryuken'
  | 'hadouken'
  | 'doroppukikku'
  | 'abareguse'
  | 'haganenokarada'
  | 'ikaku'
  | 'tetsugeta'
  | 'bukimochikomi'
  | 'oyabun'
  // メカ（走塁と飛び道具）
  | 'sukebo'
  | 'haguruma'
  | 'kyatapira'
  | 'yobitanku'
  | 'bane'
  | 'jettogutsu'
  | 'tabo'
  | 'hoba'
  | 'douryokuro'
  | 'jairo'
  | 'yobiju'
  | 'nitoro'
  | 'ju'
  | 'baiku'
  // チョウノウリョク（投球と読み）
  | 'yochi'
  | 'nenriki'
  | 'shinenha'
  | 'reikan'
  | 'nendouriki'
  | 'terepashi'
  | 'saikopawa'
  | 'jikanteishi'
  | 'miraishi'
  | 'sainendou'
  | 'shinenseigyo'
  | 'zazen'
  | 'shingan'
  | 'yomikiru'
  | 'zettaiyochi'
  // ドウブツ（守備と走塁の勘）
  | 'inu'
  | 'usagi'
  | 'saru'
  | 'neko'
  | 'kame'
  | 'taka'
  | 'uma'
  | 'kuma'
  | 'washi'
  | 'inoshishi'
  | 'chita'
  | 'hayabusa'
  | 'kemonogaeri'
  // コンジョウ（能力値の底上げ）
  | 'kinniku'
  | 'tafunesu'
  | 'shuchu'
  | 'hashirikomi'
  | 'suburi'
  | 'nebari'
  | 'kajibanochikara'
  | 'tetsuwan'
  | 'dokonjou'
  | 'kiai'
  | 'fushicho'
  | 'daiesu'
  | 'shinimonogurui'
  // デュオ（★4。系統ごとに2つ＝どの系統を引いてもランの目標が2通りある）
  | 'battoshoryuken'
  | 'shinkuhadouken'
  | 'roketokikku'
  | 'homingudan'
  | 'tabosukebo'
  | 'zenchizenno'
  | 'mugenhenka'
  | 'mushin'
  | 'yaseinokan'
  | 'kemonomichi'
  | 'yakyubaka'
  | 'tetsujin'
  // 強化デュオ（★4。前提は消費型1つ＝未使用で温存している間だけ候補に出る。F-26-8）
  | 'rokettogeta'
  | 'renshaju'
  | 'rokettoenjin'
  // 一時効果の強化デュオ（★4。同じ形を M-33 の3枚にも与える）
  | 'kaminoyochi'
  | 'kemononoou'
  | 'fushinochikara';

/**
 * `ジュウ` を取った投手が1試合に撃てる弾数（フェーズF-26-2。ユーザー判断：**投手個人**に3発）。
 *
 * **チーム共有ではなく投手ごと**なのは、スキルが打順ではなく選手に付いて回る（CLAUDE.md ⑧）から。
 * 継投でスキル持ちを降ろせば銃はマウンドから消え、2人が取れば合計6発になる＝残弾の持ち主が
 * 「誰を投げさせるか」の采配と地続きになる。チーム共有のままだと、スキルを持たない投手に
 * 代えた瞬間に「撃つ主体がいないのに残弾だけある」という宙に浮いた数字が残る。
 *
 * 実際の残弾（撃った数からの導出）は `roster.ts` の `gunRemainingOf` が持つ
 * ＝**真実は「撃った数」の側**で、B-11が投球数から残りスタミナを導出したのと同じ整理。
 */
export const GUN_SHOTS_PER_PITCHER = 3;

export interface SkillDef {
  id: SkillId;
  /** 表示名（カタカナ8文字以内。3択画面と選手カードの幅をデータで崩さないためテストで固定） */
  name: string;
  lineage: SkillLineage;
  rarity: SkillRarity;
  target: SkillTarget;
  /** 3択画面に出す一行説明（カタカナ・24文字以内。同じくテストで固定） */
  text: string;
  /** パラメータ系の効果 */
  modifier?: StatModifier;
  /** 既存のプレー定数への補正（フェーズF-26-5） */
  play?: PlayModifier;
  /** 乱闘への効果 */
  brawl?: BrawlModifier;
  /**
   * デュオの前提。**同じ選手が**この1〜2つを持っていると候補に出る。
   * 指定があるスキルは ★4 でなければならない（`tests/skills.test.ts` で固定）。
   *
   * **前提は「使い切っていない札」だけが数えられる**（F-26-8。`roster.ts` の
   * `canGrantTo` が `liveSkillsOf` を渡す）＝消費型を使い切ると強化デュオは候補から消える。
   */
  requires?: readonly SkillId[];
  /**
   * **消費型**（フェーズF-26-8）。ラン全体でこの回数だけ使える。
   * 省略＝常設（従来どおり取ったらランの終わりまで効き続ける）。
   *
   * 使った回数の記録は `TeamRoster.skillUses` にあり、**残り回数はそこからの導出**
   * （`chargesLeftOf`）＝B-11で投球数から残りスタミナを、F-26-2で撃った数から残弾を
   * 導出したのと同じ整理で、「残り」という数字を別に持たない。
   */
  charges?: number;
  /**
   * **強化デュオが前提の消費型に足すチャージ数**（フェーズF-26-8）。
   * `requires` がちょうど1つのときだけ意味を持つ（どの札のチャージを増やすかが
   * 一意に決まる形にしてある）。`tests/skills.test.ts` が固定する。
   */
  chargeBonus?: number;
  /**
   * **一時効果**（フェーズM-33）。省略＝取ったらずっと効く（従来のすべての札）。
   *
   * `'atBat'` は「**切ってから、その打席が終わるまで**」。**効果の種類ではなく効く長さ**なので、
   * `modifier`・`play`・`brawl` のどれとでも組み合わせられる＝判定側は1行も変わらない
   * （`roster.ts` の `effectiveSkillsOf` が「いま効いている札」を絞るだけ）。
   *
   * **必ず `charges` と対で書く**（`tests/skills.test.ts` が固定）。回数券でなければ
   * 毎打席切るのが最適解になり、「いつ切るか」という判断そのものが消えるため。
   */
  duration?: 'atBat';
}

/**
 * スキル名鑑（フェーズF-26-5でプールを10→41に拡充）。
 *
 * ## 並びは系統ごと
 *
 * `Object.keys` の順がそのまま抽選プールの並び＝CPUの同率時の選択順（`cpuChooseSkill`）に
 * なるので、**系統ごとにまとめ、系統の中はレアリティの昇順**で書く。増やすときも
 * この並びを崩さない（並びが変わるとCPUの振る舞いが黙って変わる）。
 *
 * ## レアリティの意味
 *
 * **★1は数値、★2は数値が大きいか代償つき、★3は試合の形が変わるもの**。
 * ★1が地味なのは意図的で、3択の全部が大事件だと選択が重くなりすぎて、
 * 「軽く取って枠を埋める」という判断ができなくなる。
 *
 * ## 効果の3つの形（増やすときはこのどれかに落とす）
 *
 * 1. **パラメータ系**（`modifier`）＝能力値レーティングへの補正。判定・HUD表示・采配メニューが
 *    すべて既存の導出経路で一緒に動く（CLAUDE.md ⑥）。**負の補正も置ける**ので、
 *    「長打力は上がるが打率は下がる」というトレードオフの札が独自の仕組み無しで書ける。
 * 2. **プレー定数系**（`play`）＝守備範囲・盗塁のスタートなど、レーティングに畳めない値への
 *    足し算（`PlayModifier`）。
 * 3. **動詞系**＝新しい操作の解禁。データ側には何も持たず、使う場所が `hasSkill` で問い合わせる
 *    （銃・バイク・ドロップキック・乱闘の必殺技）。
 *
 * ## デュオ（★4）は系統ごとに1つ以上
 *
 * 試合ごとに系統を3つに絞る（`ACTIVE_LINEAGE_COUNT`）ので、**デュオの無い系統があると
 * 「その系統だけ引いた試合には目標が無い」**ことになる。デュオの前提2つは必ず同じ系統に
 * 置く（`tests/skills.test.ts` が固定）＝絞り込みで前提だけが出て相方が永久に出ない、が起きない。
 * **条件付きの補正（銃の弾数・ドロップキックの射程）はデュオにだけ置く**：前提が `requires` で
 * 保証されるので、抽選プールに「持っていないと無意味な札」を作らずに済む。
 */
export const SKILLS: Record<SkillId, SkillDef> = {
  // ---- ボウリョク：乱闘と妨害 ----
  kenkappayai: {
    id: 'kenkappayai',
    name: '喧嘩っ早い',
    lineage: 'violence',
    rarity: 1,
    target: 'any',
    // 乱闘v3（XX-72）：**前ダッシュ・バックステップ**（→→／←←）。間合いを一気に詰める・
    // 離す手段は素の選手には無い（歩きだけ）ので、名前どおり「すぐ喧嘩を始められる」札。
    text: '乱闘でダッシュ（→→）',
    brawl: { hp: 10, passive: { dash: true } },
  },
  tekko: {
    id: 'tekko',
    name: '鉄甲',
    lineage: 'violence',
    rarity: 1,
    target: 'any',
    // 乱闘v3（XX-72）：**鉄の拳**＝通常技もガードの上から削る（素の通常技は削らない）。
    text: '拳が鉄 ガードの上も削る',
    brawl: { powerScale: 1.1, passive: { ironFist: true } },
  },
  zutsuki: {
    id: 'zutsuki',
    name: '頭突き',
    lineage: 'violence',
    rarity: 1,
    target: 'any',
    // 乱闘v3（XX-72）：**必殺技・頭突き**（←溜め→＋P）。飛び道具をくぐって突っ込む。
    text: '必殺技・頭突き',
    brawl: { hp: 10, special: 'zutsuki' },
  },
  karate: {
    id: 'karate',
    name: '空手',
    lineage: 'violence',
    rarity: 1,
    target: 'any',
    // 乱闘v3（XX-72）：**必殺技・竜巻旋風脚**（↓↙←＋K）。回りながら前へ出る蹴り。
    text: '必殺技・竜巻旋風脚',
    brawl: { special: 'tatsu' },
  },
  dosukoi: {
    id: 'dosukoi',
    name: 'どすこい',
    lineage: 'violence',
    rarity: 1,
    target: 'any',
    // ボウリョク系統で唯一、**打席にも効く**★1（体当たりの力がそのまま打球に乗る）。
    // 乱闘は死球が起きた試合にしか出番が無いので、系統を引き当てた試合が
    // 「何も起きなければ全部空振り」にならないための逃げ道でもある。
    // 乱闘v3（XX-72）：**必殺技・百裂張り手**（P連打）。打席でも押しが強い（長打力）。
    text: '百裂張り手 打席でも力',
    modifier: { power: 0.1 },
    brawl: { special: 'hyakuretsu' },
  },
  shoryuken: {
    id: 'shoryuken',
    name: '昇龍拳',
    lineage: 'violence',
    rarity: 2,
    target: 'any',
    // 乱闘v2（G-27）：**必殺技はスキルが配る**（2026-07-31 ユーザー判断）。コマンドは
    // `core/brawl.ts` の `MOVES` が持つので、ここに書くのは「どの技が解禁されるか」だけ
    // （表示の技表もコマンド判定も同じ1か所から起きる）。
    text: '必殺技・昇龍拳',
    brawl: { special: 'shoryu' },
  },
  hadouken: {
    id: 'hadouken',
    name: '波動拳',
    lineage: 'violence',
    rarity: 2,
    target: 'any',
    // 乱闘v3（XX-72）：**必殺技・波動拳**（↓↘→＋P）。テストプレイ「スキルの波動拳を
    // 試してみたい」。気の飛び道具で、**遠くから撃つ技**（撃った後が長い）。
    text: '必殺技・波動拳',
    brawl: { special: 'hadou' },
  },
  doroppukikku: {
    id: 'doroppukikku',
    name: 'ドロップキック',
    lineage: 'violence',
    rarity: 2,
    // 走者になるのは全選手（投手も打順に入る＝B-10）なので 'any'。
    target: 'any',
    // **動詞系**（新しい操作の解禁）。`ショウリュウケン` が乱闘という別の画面の中で効くのに対し、
    // こちらは**試合そのものの中で殴る**ので、実体は `core/fielding.ts` のドロップキック定数と
    // `scenes/chicchaiScene.ts` の走塁にある（バイクと同じ置き方）。
    text: 'Gで野手を蹴り倒す',
    // 乱闘でも使える（跳んで↓＋K＝急降下キック。XX-72）
    brawl: { special: 'divekick' },
  },
  abareguse: {
    id: 'abareguse',
    name: '暴れ癖',
    lineage: 'violence',
    rarity: 2,
    target: 'any',
    // 乱闘v3（XX-72）：**怒り**＝体力が3割を切ると威力1.5倍（追い込まれてから暴れる）。
    text: '追い込まれると威力1.5倍',
    brawl: { hp: 20, passive: { rage: 1.5 } },
  },
  haganenokarada: {
    id: 'haganenokarada',
    name: '鋼の体',
    lineage: 'violence',
    rarity: 2,
    target: 'any',
    // 乱闘v3（XX-72）：**スーパーアーマー**＝技を出している間は1ラウンドに2発まで怯まない。
    text: '技の最中は2発まで怯まない',
    brawl: { hp: 30, passive: { armor: 2 } },
  },
  ikaku: {
    id: 'ikaku',
    name: '威嚇',
    lineage: 'violence',
    rarity: 2,
    target: 'any',
    // 乱闘v3（XX-72）：**威嚇**＝にらまれた相手の威力が 0.85倍になる。
    text: 'にらみで相手の威力を下げる',
    brawl: { powerScale: 1.1, passive: { intimidate: 0.85 } },
  },
  tetsugeta: {
    id: 'tetsugeta',
    name: '鉄下駄',
    lineage: 'violence',
    rarity: 2,
    target: 'any',
    // **消費型**（F-26-8）。常設の `ドロップキック` と同じ★2で、上位互換にならないよう
    // **回数と射程を交換してある**：あちらは毎プレー蹴れるが射程4m、こちらはラン全体で
    // 2回だけだが射程6m（F-26-7の「同じ軸に複数置くときはどちらかが上位互換にならない
    // 配分にする」）。射程の補正をデュオ以外に置いている唯一の札で、
    // **自分でその動詞を解禁するので死に札にならない**（デュオ限定の理由が当たらない）。
    text: '2回だけ射程6mの蹴り',
    play: { dropkickRange: 2 },
    charges: 2,
  },
  bukimochikomi: {
    id: 'bukimochikomi',
    name: '武器持ち込み',
    lineage: 'violence',
    rarity: 3,
    target: 'any',
    // 乱闘v2（G-27）：威力に加えて**溜めコマンドの大技**を配る★3。ショウリュウケン（★2）が
    // 「速くて出しやすい必殺技」なのに対し、こちらは**1秒ためて待つ**ことが代償の一撃
    // ＝同じ「必殺技を配る札」でもどちらかが上位互換にならない（F-26-7の配分方針）。
    // 乱闘v3（XX-72）：**必殺技・武器振り回し**（←溜め→＋K）。とても長いが遅い。
    text: '武器振り回し 威力1.25倍',
    brawl: { powerScale: 1.25, special: 'buki' },
  },
  oyabun: {
    id: 'oyabun',
    name: '親分',
    lineage: 'violence',
    rarity: 3,
    target: 'any',
    // ★3は「試合の形が変わるもの」。乱闘に持ち込めば**ほぼ負けない**体力と威力で、
    // 死球を受けた（撃たれた）ときに乱闘を選ぶかどうかの判断そのものを反転させる。
    // 乱闘v3（XX-72）：**子分を呼ぶ**（↓↙←＋P。1ラウンドに1回）。子分が後ろから駆け込む。
    text: '子分を呼ぶ 体力と威力',
    brawl: { hp: 40, powerScale: 1.15, special: 'kobun' },
  },

  // ---- メカ：走塁と飛び道具 ----
  sukebo: {
    id: 'sukebo',
    name: 'スケボー',
    lineage: 'mecha',
    rarity: 1,
    target: 'any',
    // RUN +0.15＝走者速度 +0.21m/s。**上限（8.2m/s）自体は動かさない**ので、
    // 「野手の足 8.5m/s より遅い」という挟殺成立の前提（⑥）は保たれる。
    // 上限そのものを踏み越えるのは `バイク`（F-26-3）のほうで、そちらは
    // 「曲がれない＝塁を行き過ぎる」を代償に付けてある。
    text: '走力が上がる',
    modifier: { run: 0.15 },
  },
  haguruma: {
    id: 'haguruma',
    name: '歯車',
    lineage: 'mecha',
    rarity: 1,
    target: 'pitcher',
    // SPD +0.15＝緩急3段階すべての基準速が上がる（`speedForPitchSelection`）。
    text: '球速が上がる',
    modifier: { speed: 0.15 },
  },
  kyatapira: {
    id: 'kyatapira',
    name: 'キャタピラ',
    lineage: 'mecha',
    rarity: 1,
    target: 'any',
    // **★1で唯一のトレードオフ**。走力は スケボー より大きく伸びるが打率が落ちる＝
    // 「代走向きの札」になる。負の補正は `combinedModifier` の足し算と `rated` の
    // クランプにそのまま乗るので、専用の仕組みは要らない。
    text: '足は速いが打撃が落ちる',
    modifier: { run: 0.25, average: -0.1 },
  },
  yobitanku: {
    id: 'yobitanku',
    name: '予備タンク',
    lineage: 'mecha',
    rarity: 1,
    target: 'pitcher',
    // 限界球数 +20球。コンジョウの `タフネス`（+25球）と近いが、**系統が違う**ので
    // 同じ試合に両方が出るのは3系統のうち2つを引いたときだけ＝どちらか片方しか
    // 出ない試合のほうが多い（絞り込みがあるぶん、系統をまたいだ重複は許容できる）。
    text: 'スタミナ+20球',
    modifier: { stamina: 0.2 },
  },
  bane: {
    id: 'bane',
    name: 'バネ',
    lineage: 'mecha',
    rarity: 1,
    target: 'any',
    // 長打力と走力を少しずつ＝**メカ系統で唯一、打撃にも効く★1**。走塁一辺倒の系統に
    // 打者としての使い道を1枚だけ混ぜてある（`ドスコイ` と同じ理由）。
    text: '反発で力と足',
    modifier: { power: 0.1, run: 0.1 },
  },
  jettogutsu: {
    id: 'jettogutsu',
    name: 'ジェット靴',
    lineage: 'mecha',
    rarity: 2,
    target: 'any',
    text: '走力が大幅に上がる',
    modifier: { run: 0.3 },
  },
  tabo: {
    id: 'tabo',
    name: 'ターボ',
    lineage: 'mecha',
    rarity: 2,
    target: 'pitcher',
    // 球速を大きく上げる代わりにスタミナが減る＝**短いイニングを飛ばす投手**になる。
    // STM は限界球数そのもの（B-11）なので、-0.15 は限界 -15球として素直に効く。
    text: '球速++ スタミナ-',
    modifier: { speed: 0.3, stamina: -0.15 },
  },
  hoba: {
    id: 'hoba',
    name: 'ホバー',
    lineage: 'mecha',
    rarity: 2,
    target: 'any',
    // 走力の★2を2枚（`ジェットグツ` は走力一本、こちらは打撃も少し）。走者速度の上限
    // （8.2m/s）は動かないので、`バイク` だけが上限を踏み越えるという⑥の整理は保たれる。
    text: '浮き上がって走る 打撃も+',
    modifier: { run: 0.25, average: 0.05 },
  },
  douryokuro: {
    id: 'douryokuro',
    name: '動力炉',
    lineage: 'mecha',
    rarity: 2,
    target: 'pitcher',
    // `ターボ`（球速を大きく上げてスタミナを削る）と正反対の投手札＝**長く投げる**ほう。
    // 同じ系統に「飛ばす」と「持たせる」を並べておくと、投手をどう作るかの選択になる。
    text: '球速とスタミナが上がる',
    modifier: { speed: 0.15, stamina: 0.2 },
  },
  jairo: {
    id: 'jairo',
    name: 'ジャイロ',
    lineage: 'mecha',
    rarity: 2,
    target: 'any',
    // AV は「芯を外したときの打球の弱まりにくさ」（⑥）＝機械の安定装置で軸がぶれない、
    // という説明がそのまま効果になる。
    text: 'ぶれない 詰まっても前へ',
    modifier: { average: 0.2, run: 0.1 },
  },
  yobiju: {
    id: 'yobiju',
    name: '予備銃',
    lineage: 'mecha',
    rarity: 2,
    // 撃つのは投手だけ（`ジュウ` と同じ理由。CLAUDE.md ③）。
    target: 'pitcher',
    // **消費型**（F-26-8）。★3の `ジュウ`（毎試合3発）に対してラン全体で1発だけ＝
    // レアリティの差がそのまま回数の差になっている。**1発しか無いからこそ
    // 「どの打者に使うか」が判断になる**（銃は実質敬遠なので、狙いどころが読める）。
    text: '1回だけ銃が撃てる',
    charges: 1,
  },
  nitoro: {
    id: 'nitoro',
    name: 'ニトロ',
    lineage: 'mecha',
    rarity: 2,
    target: 'any',
    // **消費型**（F-26-8）。★3の `バイク`（何度でも乗れる）に対してラン全体で2回だけ。
    // 代償（オーバーラン6m）はそのままなので、⑥の設計不変条件（走力の上限＜野手の足＝
    // 挟殺が成立する）は消費型でも同じ形で保たれる＝**バイク専用の分岐は増えない**。
    text: '2回だけバイクに乗れる',
    charges: 2,
  },
  ju: {
    id: 'ju',
    name: '銃',
    lineage: 'mecha',
    rarity: 3,
    // 投手だけが撃てる（CLAUDE.md ③「ピッチャーはオプションで銃を持つことができる」）。
    target: 'pitcher',
    // **動詞系**（新しい操作の解禁）なので `modifier` も `brawl` も持たない。効果の実体は
    // 「銃モードへ入れるか」を問い合わせる側（`canShootGun`）にあり、データはこの1行だけ。
    //
    // フェーズF-26-2でオリジナル要素の銃をここへ吸収した。以後**銃は常設ではなく
    // ランごとの当たり**になる＝引けなかった試合に銃は存在しない（CLAUDE.md ⑧）。
    text: 'Gで打者を撃てる（3発）',
  },
  baiku: {
    id: 'baiku',
    name: 'バイク',
    lineage: 'mecha',
    rarity: 3,
    // 走者になるのは全選手（投手も打順に入る＝B-10）なので 'any'。
    target: 'any',
    // **動詞系**（新しい操作の解禁）。`スケボー` が走力レーティングを +0.15 する
    // パラメータ系なのに対し、こちらは**上限（8.2m/s）そのものを踏み越える**ので
    // レーティングでは表せない。代償（曲がれない＝塁を行き過ぎる）とセットでしか
    // 成立しないスキルなので、実体は `core/fielding.ts` のバイク定数と
    // `scenes/chicchaiScene.ts` の走塁にある。
    text: 'J長押しで2倍速 行き過ぎる',
  },

  // ---- チョウノウリョク：投球と読み ----
  yochi: {
    id: 'yochi',
    name: '予知',
    lineage: 'psychic',
    rarity: 1,
    target: 'any',
    // AV は「芯を外したときの打球の弱まりにくさ」（⑥）＝**当たりやすさには効かない**ので、
    // 読めても操作の手応えは変わらない（打者が代わるたびにスイングの感触が変わらない、
    // というB-8のユーザー判断はスキルでも崩さない）。
    text: '球が読める 詰まりにくい',
    modifier: { average: 0.15 },
  },
  nenriki: {
    id: 'nenriki',
    name: '念力',
    lineage: 'psychic',
    rarity: 1,
    target: 'pitcher',
    text: 'カーブが大きく曲がる',
    modifier: { breakLeft: 0.2 },
  },
  shinenha: {
    id: 'shinenha',
    name: '思念波',
    lineage: 'psychic',
    rarity: 1,
    target: 'pitcher',
    text: 'シュートが大きく曲がる',
    modifier: { breakRight: 0.2 },
  },
  reikan: {
    id: 'reikan',
    name: '霊感',
    lineage: 'psychic',
    rarity: 1,
    target: 'any',
    text: '球筋が少し読める',
    modifier: { average: 0.1, power: 0.05 },
  },
  nendouriki: {
    id: 'nendouriki',
    name: '念動力',
    lineage: 'psychic',
    rarity: 1,
    target: 'pitcher',
    // ネンリキ（カーブ）／シネンハ（シュート）が片側ずつなのに対し、こちらは両方を少し。
    // **★1のうちに「どちらも曲がる」形を用意しておく**と、★2の `サイコパワー` は
    // その上位ではなく「大きく曲げる」選択として残る。
    text: '両方少し曲がる',
    modifier: { breakLeft: 0.1, breakRight: 0.1 },
  },
  terepashi: {
    id: 'terepashi',
    name: 'テレパシー',
    lineage: 'psychic',
    rarity: 2,
    target: 'any',
    text: '配球が透けて見える',
    modifier: { average: 0.25 },
  },
  saikopawa: {
    id: 'saikopawa',
    name: 'サイコパワー',
    lineage: 'psychic',
    rarity: 2,
    target: 'pitcher',
    // 左右どちらの変化量も上げる＝ネンリキ／シネンハを1枚で兼ねる上位札。
    text: '変化球がよく曲がる',
    modifier: { breakLeft: 0.25, breakRight: 0.25 },
  },
  jikanteishi: {
    id: 'jikanteishi',
    name: '時間停止',
    lineage: 'psychic',
    rarity: 2,
    target: 'any',
    text: '球が止まって見える',
    modifier: { average: 0.15, power: 0.15 },
  },
  miraishi: {
    id: 'miraishi',
    name: '未来視',
    lineage: 'psychic',
    rarity: 2,
    target: 'any',
    // チョウノウリョクで唯一の**長打力に全振り**した札。「読み」の系統に力の軸を1本入れて
    // おかないと、この系統を引いた試合は打球が飛ばない試合になってしまう。
    text: '読んだ球を仕留める',
    modifier: { power: 0.25 },
  },
  sainendou: {
    id: 'sainendou',
    name: 'サイ念動',
    lineage: 'psychic',
    rarity: 2,
    target: 'pitcher',
    // 球速と変化量を同時に。**変化量は飛行時間に効く**（球が遅いほど横に大きく動く）ので、
    // 球速を上げるとこの2つは打ち消し合う＝1枚では極端にならない配分にしてある。
    text: '球が速く よく曲がる',
    modifier: { speed: 0.2, breakLeft: 0.1, breakRight: 0.1 },
  },
  shinenseigyo: {
    id: 'shinenseigyo',
    name: '思念制御',
    lineage: 'psychic',
    rarity: 2,
    target: 'pitcher',
    // **制球（W-44）＝チョウノウリョクで唯一「どこへ投げるか」に効く札**（他の投手向けの
    // 札はどれも「どれだけ曲がるか／どれだけ速いか」）。補正は ERA そのものへ書き戻される
    // ので、**HUDの投手カードの防御率が -0.44 動く**＝取ったことが数字で見える。
    //
    // +0.20 は `pitch.ts` の `COURSE_VX_PER_CONTROL` の基準そのもの＝**人間が投げると、
    // ど真ん中のプレート位置からCPUの決め球と同じ隅（0.50）へ届く**ようになる。
    // CPUが投げる側に回れば狙いがゾーンの縁の内側へ入る（＝見逃せば三振）。
    text: '狙ったコースへ吸い込まれる',
    modifier: { control: 0.2 },
  },
  zazen: {
    id: 'zazen',
    name: '座禅',
    lineage: 'psychic',
    rarity: 2,
    target: 'pitcher',
    // **トレードオフ札**（F-26-7の配分方針＝`シネンセイギョ` の上位互換にしない）。
    // 制球は上だが球速が落ちる＝どちらを取るかが選択になる。代償は3つに波及する：
    // 打球初速（`0.5 × 球速`）・飛行時間（打者に与える時間が延びる）・そして
    // **S-40の持ち味**（`cpuPitcherStyle` は SPD と F の差で決まるので、速球派が
    // バランス型や技巧派に変わりうる＝CPUが投げる側に回ると決め球そのものが変わる）。
    text: '隅へ届くが球が遅い',
    modifier: { control: 0.3, speed: -0.2 },
  },
  zettaiyochi: {
    id: 'zettaiyochi',
    name: '絶対予知',
    lineage: 'psychic',
    rarity: 2,
    target: 'any',
    // **一時効果**（M-33）。★3の `シンガン`（AV +0.35 が常時）に対して、こちらは
    // **その打席だけ AV を上限まで持っていく**＝常設の上位互換にはならず、
    // 「ここぞの1打席を確実にする」ほうへ振ってある（F-26-7の配分方針）。
    // 効果の形は従来どおりのパラメータ系なので、**HUDの打者カードの AV も一緒に動く**
    // ＝切ったことが数字で見える（CLAUDE.md ⑥「表示はレーティングからの導出」）。
    text: '1打席すべて見える',
    modifier: { average: 0.5 },
    charges: 2,
    duration: 'atBat',
  },
  shingan: {
    id: 'shingan',
    name: '心眼',
    lineage: 'psychic',
    rarity: 3,
    target: 'any',
    // AV +0.35＝HUDの表示打率も一緒に +.053 動く（`displayAverage`）。
    // 表示がレーティングからの導出だから起きることで、⑥の整理がそのまま効いている。
    text: 'すべての球が見える',
    modifier: { average: 0.35 },
  },
  yomikiru: {
    id: 'yomikiru',
    name: '読み切る',
    lineage: 'psychic',
    rarity: 3,
    target: 'any',
    // `シンガン`（打率に全振り）と対になる★3＝**読んで仕留める**ほう。デュオの
    // `ゼンチゼンノウ`（AV+0.3/HR+0.1）より力側へ寄せてあるので、デュオの上位互換にならない。
    text: 'すべて読んで仕留める',
    modifier: { average: 0.25, power: 0.2 },
  },

  // ---- ドウブツ：守備と走塁の勘 ----
  inu: {
    id: 'inu',
    name: '犬',
    lineage: 'animal',
    rarity: 1,
    target: 'any',
    // **原作（説明書p26-29）に守備の能力項目は無い**（⑥）ので、守備に個人差が付くのは
    // ローグライトのここが初めて。素の選手は全員 `CATCH_RADIUS`=2.6 のまま。
    text: '球に届く範囲が広がる',
    play: { catchRadius: 0.6 },
  },
  usagi: {
    id: 'usagi',
    name: '兎',
    lineage: 'animal',
    rarity: 1,
    target: 'any',
    // 盗塁のスタート位置（`STEAL_LEAD`=3.5m）が深くなる＝走る距離が縮む。
    // 判定（`stealSafeJumpSec`）は元から lead を引数に取るので、専用の分岐は要らない。
    text: '盗塁のスタートが深い',
    play: { stealLead: 1.2 },
  },
  saru: {
    id: 'saru',
    name: '猿',
    lineage: 'animal',
    rarity: 1,
    target: 'any',
    text: 'すばしっこく喧嘩に強い',
    modifier: { run: 0.1 },
    brawl: { hp: 15 },
  },
  neko: {
    id: 'neko',
    name: '猫',
    lineage: 'animal',
    rarity: 1,
    target: 'any',
    // 捕球半径 +0.4m（`イヌ` の +0.6 より控えめ）に足の速さが少し付く。守備範囲の札を
    // ★1に2枚置くのは、**デュオ `ヤセイノカン` の前提（イヌ＋タカ）を掘り当てる邪魔をしない**
    // 程度に、守備型のビルドを始めやすくするため。
    text: '身のこなしが軽い',
    play: { catchRadius: 0.4 },
    modifier: { run: 0.05 },
  },
  kame: {
    id: 'kame',
    name: '亀',
    lineage: 'animal',
    rarity: 1,
    target: 'any',
    // ★1のトレードオフ札で、`キャタピラ`（足＋／打撃−）のちょうど逆。足を捨てて
    // 詰まっても前へ飛ばす＝**代打で出す価値はあるが走らせたくない**打者になる。
    text: '遅いがしぶとい',
    modifier: { average: 0.15, run: -0.05 },
  },
  taka: {
    id: 'taka',
    name: '鷹',
    lineage: 'animal',
    rarity: 2,
    target: 'any',
    text: '球に届く範囲が大きい',
    play: { catchRadius: 1.2 },
  },
  uma: {
    id: 'uma',
    name: '馬',
    lineage: 'animal',
    rarity: 2,
    target: 'any',
    text: '足が速くスタートも深い',
    modifier: { run: 0.2 },
    play: { stealLead: 1 },
  },
  kuma: {
    id: 'kuma',
    name: '熊',
    lineage: 'animal',
    rarity: 2,
    target: 'any',
    text: '力が強く喧嘩に強い',
    modifier: { power: 0.25 },
    brawl: { hp: 20 },
  },
  washi: {
    id: 'washi',
    name: '鷲',
    lineage: 'animal',
    rarity: 2,
    target: 'any',
    // `タカ`（+1.2）より狭いが足が付く★2。守備範囲は**ファインプレイの伸びたリーチにも
    // そのまま乗る**ので、跳ぶ判断の届く距離まで一緒に広がる。
    text: '飛びついて捕る 足も+',
    play: { catchRadius: 0.9 },
    modifier: { run: 0.1 },
  },
  inoshishi: {
    id: 'inoshishi',
    name: '猪',
    lineage: 'animal',
    rarity: 2,
    target: 'any',
    text: 'まっすぐ突撃する',
    modifier: { run: 0.25, average: -0.05 },
  },
  kemonogaeri: {
    id: 'kemonogaeri',
    name: '獣返り',
    lineage: 'animal',
    rarity: 2,
    target: 'any',
    // **一時効果**（M-33）で、**3枚のうち唯一の守備側**。捕球半径 2.6 → 5.6m は
    // デュオ `ヤセイノカン` を積み切った選手（5.9m）に迫るが、**その打席だけ**。
    //
    // **打球が飛んでから切れる**（ちっちゃいモードの守備側のG）のがこの札の値打ちで、
    // 打者側の2枚（打席の頭で切る）と判断の質そのものが違う＝同じ「一時効果」でも
    // 場面が重ならない。届くかどうかを見てから払う点で、ファインプレイ（跳んで外せば
    // 起き上がるまで動けない）と同じ「見てから賭ける」操作の系列に乗る。
    text: '1打席 守備範囲激増',
    play: { catchRadius: 3 },
    charges: 2,
    duration: 'atBat',
  },
  chita: {
    id: 'chita',
    name: 'チーター',
    lineage: 'animal',
    rarity: 3,
    target: 'any',
    // RUN +0.4 でも走者速度の上限は 8.2m/s のまま＝野手（8.5m/s）に追いつかれうる
    // という挟殺成立の前提（⑥）は崩れない。踏み越えるのは `バイク` だけ。
    text: '足がとてつもなく速い',
    modifier: { run: 0.4 },
  },
  hayabusa: {
    id: 'hayabusa',
    name: '隼',
    lineage: 'animal',
    rarity: 3,
    target: 'any',
    // `チーター`（走力に全振り）と対になる★3＝**守備範囲に全振り**。素の 2.6m が 3.6m まで
    // 広がるので、内野の間を抜ける打球が目に見えて減る＝どこを守らせるかが采配になる
    // （B-10の守備位置の割当が打球処理に効く数少ない経路）。
    text: '速く跳び広く捕る',
    play: { catchRadius: 1 },
    modifier: { run: 0.2 },
  },

  // ---- コンジョウ：能力値の底上げ ----
  kinniku: {
    id: 'kinniku',
    name: '筋肉',
    lineage: 'guts',
    rarity: 1,
    target: 'any',
    // HR レーティング +0.15＝打球初速 +0.9m/s、HUDの表示本塁打数 +7本。**表示も一緒に動く**
    // のは、表示が同じレーティングからの導出だから（⑥）＝カードの数字が嘘にならない。
    text: '本塁打+7本分の力',
    modifier: { power: 0.15 },
  },
  tafunesu: {
    id: 'tafunesu',
    name: 'タフネス',
    lineage: 'guts',
    rarity: 1,
    target: 'pitcher',
    // STM は「球威を保てる球数」そのもの（⑥）なので、+0.25 は限界球数 +25球にあたる。
    // リリーフ型（0.3）がこれを得ると 0.55 で先発型の一歩手前まで来る＝`pitcherRole` の
    // 導出まで動くので、「継投で出したリリーフが長い回を投げられるようになる」が起きる。
    text: 'スタミナ+25球',
    modifier: { stamina: 0.25 },
  },
  shuchu: {
    id: 'shuchu',
    name: '集中',
    lineage: 'guts',
    rarity: 1,
    target: 'any',
    text: '打撃が全体的に上がる',
    modifier: { average: 0.1, power: 0.1 },
  },
  hashirikomi: {
    id: 'hashirikomi',
    name: '走り込み',
    lineage: 'guts',
    rarity: 1,
    target: 'any',
    // コンジョウ系統に**走力の底上げ**を1枚。メカ・ドウブツを引かなかった試合でも
    // 足を伸ばす手が残る（系統を3つに絞る以上、どの系統にも一通りの軸を置いておく）。
    text: '走り込んで足がつく',
    modifier: { run: 0.15 },
  },
  suburi: {
    id: 'suburi',
    name: '素振り',
    lineage: 'guts',
    rarity: 1,
    target: 'any',
    // `シュウチュウ`（AV/HRを均等に）と配分違いの★1＝力寄り。均等・力寄り・
    // 力に全振り（`キンニク`）の3枚で、★1の中に薄いグラデーションを作っている。
    text: '振り込んで力がつく',
    modifier: { power: 0.1, average: 0.05 },
  },
  nebari: {
    id: 'nebari',
    name: '粘り',
    lineage: 'guts',
    rarity: 2,
    target: 'any',
    text: '詰まっても前へ飛ぶ 足も+',
    modifier: { average: 0.2, run: 0.1 },
  },
  kajibanochikara: {
    id: 'kajibanochikara',
    name: '火事場の力',
    lineage: 'guts',
    rarity: 2,
    target: 'any',
    // ★2のトレードオフ札。長打力は名鑑の4番級まで跳ね上がるが、芯を外したときに
    // 打球が死ぬ＝**当たれば大きいが当たらない打者**になる。表示（打率・本塁打数）も
    // 同じレーティングからの導出なので、カードの数字がそのまま性格を語る。
    text: '力 大幅+ 打率-',
    modifier: { power: 0.35, average: -0.15 },
  },
  tetsuwan: {
    id: 'tetsuwan',
    name: '鉄腕',
    lineage: 'guts',
    rarity: 2,
    target: 'pitcher',
    text: '球速とスタミナが上がる',
    modifier: { speed: 0.2, stamina: 0.15 },
  },
  dokonjou: {
    id: 'dokonjou',
    name: 'ど根性',
    lineage: 'guts',
    rarity: 2,
    target: 'any',
    // 打撃3項目を少しずつ＝**系統の名前どおりの「底上げ」の見本**。尖らないぶん
    // 誰に付けても腐らないので、枠が余っているときの受け皿になる。
    text: 'すべて少しずつ上がる',
    modifier: { average: 0.15, power: 0.15, run: 0.05 },
  },
  kiai: {
    id: 'kiai',
    name: '気合',
    lineage: 'guts',
    rarity: 2,
    target: 'any',
    // `カジバノチカラ`（力を大きく上げて打率を下げる）から代償を抜いて幅を縮めた札。
    // **代償のある強い札と、代償の無い程よい札**を同じレアリティに並べておくと、
    // トレードオフを取るかどうかがその場の判断になる。
    text: '気合で飛ばす',
    modifier: { power: 0.25, average: 0.05 },
  },
  shinimonogurui: {
    id: 'shinimonogurui',
    name: '死に物狂い',
    lineage: 'guts',
    rarity: 2,
    target: 'any',
    // **一時効果**（M-33）。同じ★2の `カジバノチカラ`（力+0.35／打率-0.15 が常時）と
    // **同じ「一発狙い」の軸だが代償の形が違う**：あちらは打率を差し出し、こちらは回数を
    // 差し出す（打率は下がらない）。どちらかが上位互換にならない配分（F-26-7）。
    text: '1打席 力が爆発',
    modifier: { power: 0.5 },
    charges: 2,
    duration: 'atBat',
  },
  fushicho: {
    id: 'fushicho',
    name: '不死鳥',
    lineage: 'guts',
    rarity: 3,
    target: 'pitcher',
    // 限界球数 +50球。先発型（0.85＝110球）に乗せると完投どころか延長まで持つ。
    text: 'スタミナ+50球',
    modifier: { stamina: 0.5 },
  },
  daiesu: {
    id: 'daiesu',
    name: '大エース',
    lineage: 'guts',
    rarity: 3,
    target: 'pitcher',
    // 投手の4項目をまとめて底上げする★3。`フシチョウ`（スタミナに全振り＝長く投げる）に
    // 対して、こちらは**1試合を支配する**ほう。系統の担当領域（能力値の底上げ）を
    // 投手側でも成立させる1枚。
    text: 'エースの貫禄',
    modifier: { speed: 0.25, breakLeft: 0.2, breakRight: 0.2, stamina: 0.15 },
  },

  // ---- デュオ（★4。前提2つを同じ選手に揃えたときだけ候補に出る） ----
  battoshoryuken: {
    id: 'battoshoryuken',
    // 「バットショウリュウケン」を8文字に収めた表記（`SKILL_NAME_MAX_LENGTH`）。
    name: 'バット龍拳',
    lineage: 'violence',
    rarity: DUO_RARITY,
    target: 'any',
    // 乱闘v2（G-27）：前提2つ（ショウリュウケン＝昇龍コマンド／ブキモチコミ＝溜めコマンド）を
    // 揃えた選手への報酬として、**一回転コマンドの最大威力技**を配る。前提の2技も持って
    // いるので、格の上がる順（ジャブ→パンチ→昇龍→タメ→バット）にコンボが繋がる
    // ＝「誰に集めるか」がそのまま乱闘の強さになる（CLAUDE.md ⑧のデュオの狙い）。
    // 乱闘v3（XX-72）：**超必殺・バット龍拳**（ゲージ満タンでG）。燃えるバットで昇る4段。
    text: '超必殺・バット龍拳',
    brawl: { hp: 20, super: 'batto' },
    requires: ['shoryuken', 'bukimochikomi'],
  },
  shinkuhadouken: {
    id: 'shinkuhadouken',
    name: '真空波動拳',
    lineage: 'violence',
    rarity: DUO_RARITY,
    target: 'any',
    // 乱闘v3（XX-72）：前提2つ（波動拳＝飛び道具／空手＝竜巻旋風脚）を揃えた選手への報酬＝
    // **超必殺・真空波動拳**（ゲージ満タンでG。大きな気弾が5回当たる）。
    text: '超必殺・真空波動拳',
    brawl: { hp: 10, super: 'shinku' },
    requires: ['hadouken', 'karate'],
  },
  /**
   * 強化デュオ（F-26-8）。**前提は消費型1つだけ**で、`テツゲタ` を**まだ使い切って
   * いない**あいだだけ候補に出る＝「いま蹴るか、温存して強化を狙うか」がこの1枚から生まれる。
   * 効果は**チャージを増やす**（`chargeBonus`）＋射程を伸ばす。
   */
  rokettogeta: {
    id: 'rokettogeta',
    name: 'ロケット下駄',
    lineage: 'violence',
    rarity: DUO_RARITY,
    target: 'any',
    text: '鉄下駄が4回 射程8m',
    play: { dropkickRange: 2 },
    chargeBonus: 2,
    requires: ['tetsugeta'],
  },
  roketokikku: {
    id: 'roketokikku',
    name: 'ロケットキック',
    lineage: 'violence',
    rarity: DUO_RARITY,
    target: 'any',
    // **射程が伸びると警告距離（`ケラレル!`）も一緒に伸びる**：警告は射程からの導出
    // （`dropkickWarnRange`）なので、「回避手段が間に合う」という F-26-4 の不変条件が
    // デュオを取っても保たれる（桜井ノウハウ「人に反応できない動作は理不尽」）。
    text: 'ドロップキックの射程が伸びる',
    play: { dropkickRange: 2.5 },
    requires: ['doroppukikku', 'tekko'],
  },
  homingudan: {
    id: 'homingudan',
    name: 'ホーミング弾',
    lineage: 'mecha',
    rarity: DUO_RARITY,
    // 前提の2つがどちらも投手専用なので、デュオ自身も投手専用でなければ整合しない
    // （`tests/skills.test.ts` が「前提に投手専用があればデュオも投手専用」を固定する）。
    target: 'pitcher',
    text: '銃の弾が2発増える',
    play: { gunShots: 2 },
    requires: ['ju', 'haguruma'],
  },
  /** 強化デュオ（F-26-8）。`ヨビジュウ` を温存している投手にだけ出る＝弾が3発になる */
  renshaju: {
    id: 'renshaju',
    name: '連射銃',
    lineage: 'mecha',
    // 前提（`ヨビジュウ`）が投手専用なので、デュオ自身も投手専用でなければ整合しない。
    target: 'pitcher',
    rarity: DUO_RARITY,
    text: '予備銃が3発に増える',
    chargeBonus: 2,
    requires: ['yobiju'],
  },
  /** 強化デュオ（F-26-8）。`ニトロ` を温存している走者にだけ出る＝乗れる回数が倍になる */
  rokettoenjin: {
    id: 'rokettoenjin',
    name: 'ロケットエンジン',
    lineage: 'mecha',
    target: 'any',
    rarity: DUO_RARITY,
    text: 'ニトロが4回に増える',
    chargeBonus: 2,
    requires: ['nitoro'],
  },
  /**
   * 一時効果の強化デュオ（フェーズM-33）。**F-26-8の強化デュオとまったく同じ形**
   * （前提は消費型1つ＝まだ使い切っていない間だけ候補に出る）で、一時効果もその仕組みに
   * そのまま乗る＝新しい機構はゼロ。**温存の報酬が「切れる回数」として増える**ので、
   * 「いま切るか、温存して強化を狙うか」という F-26-8 の判断が3系統へそのまま広がる。
   */
  kaminoyochi: {
    id: 'kaminoyochi',
    name: '神の予知',
    lineage: 'psychic',
    rarity: DUO_RARITY,
    target: 'any',
    text: '絶対予知が4回に増える',
    chargeBonus: 2,
    requires: ['zettaiyochi'],
  },
  kemononoou: {
    id: 'kemononoou',
    name: '獣の王',
    lineage: 'animal',
    rarity: DUO_RARITY,
    target: 'any',
    text: '獣返りが4回に増える',
    chargeBonus: 2,
    requires: ['kemonogaeri'],
  },
  fushinochikara: {
    id: 'fushinochikara',
    name: '不死の力',
    lineage: 'guts',
    rarity: DUO_RARITY,
    target: 'any',
    text: '死に物狂いが4回に',
    chargeBonus: 2,
    requires: ['shinimonogurui'],
  },
  tabosukebo: {
    id: 'tabosukebo',
    name: 'ターボスケボー',
    lineage: 'mecha',
    rarity: DUO_RARITY,
    target: 'any',
    // 走力の札2枚（`スケボー`＋`ジェットグツ`）を揃えた選手への報酬。走者速度の上限
    // （8.2m/s）自体は動かないので、これを積んでも「野手の足より遅い」という⑥の
    // 設計不変条件は保たれる（踏み越えるのは `バイク` だけ）。
    text: '走力が極限まで',
    modifier: { run: 0.4 },
    requires: ['sukebo', 'jettogutsu'],
  },
  zenchizenno: {
    id: 'zenchizenno',
    name: '全知全能',
    lineage: 'psychic',
    rarity: DUO_RARITY,
    target: 'any',
    text: '読みが完全になる',
    modifier: { average: 0.3, power: 0.1 },
    requires: ['yochi', 'terepashi'],
  },
  mugenhenka: {
    id: 'mugenhenka',
    name: '無限変化',
    lineage: 'psychic',
    rarity: DUO_RARITY,
    // 前提2つ（`ネンリキ`＋`シネンハ`）がどちらも投手専用なので、デュオ自身も投手専用。
    target: 'pitcher',
    // チョウノウリョクのもう1つのデュオは**投手側**（`ゼンチゼンノウ` は打者側）。
    // 系統に2つ置くときは、**同じ側で2つ作らない**＝どちらの役割で引いても目標がある。
    text: 'どちらも極限まで曲がる',
    modifier: { breakLeft: 0.3, breakRight: 0.3 },
    requires: ['nenriki', 'shinenha'],
  },
  mushin: {
    id: 'mushin',
    name: '無心',
    lineage: 'psychic',
    // 前提2つ（`シネンセイギョ`＋`ザゼン`）がどちらも投手専用なので、デュオ自身も投手専用。
    target: 'pitcher',
    rarity: DUO_RARITY,
    // チョウノウリョク3つ目のデュオ（フェーズW-44）。`ムゲンヘンカ` が「どれだけ曲がるか」の
    // 極みなのに対し、こちらは「どこへ投げるか」の極み＝**同じ投手側でも軸が違う**
    // （F-26-7の「同じ側で2つ作らない」は役割＝打者側/投手側の話で、W-44は投手側の
    // 別の軸を1本足した形）。**`ザゼン` の球速の代償はそのまま残る**ので、
    // 3枚積んだ投手は「どこへでも投げ切れるが遅い」という極端な形になる。
    text: '狙わずとも隅へ届く',
    modifier: { control: 0.25 },
    requires: ['shinenseigyo', 'zazen'],
  },
  yaseinokan: {
    id: 'yaseinokan',
    name: '野生の勘',
    lineage: 'animal',
    rarity: DUO_RARITY,
    target: 'any',
    // イヌ(+0.6)＋タカ(+1.2)＋これ(+1.5)＝捕球半径 2.6→5.9m。**守備範囲だけが
    // 極端に広い選手**が1人できる＝どこを守らせるかが采配になる（B-10の守備位置の割当が
    // 初めて打球処理に効く場面）。
    text: '守備の範囲がさらに広がる',
    play: { catchRadius: 1.5 },
    requires: ['inu', 'taka'],
  },
  kemonomichi: {
    id: 'kemonomichi',
    name: '獣道',
    lineage: 'animal',
    rarity: DUO_RARITY,
    target: 'any',
    // ドウブツのもう1つのデュオは**走塁側**（`ヤセイノカン` は守備側）。盗塁のスタートは
    // けん制で許される深さ（`MAX_LEAD`）で頭打ちになるので、**深くしすぎても
    // 「けん制で刺される」側へは踏み込まない**（読み出し側でクランプしてある）。
    text: '盗塁のスタートが深い',
    play: { stealLead: 1.5 },
    modifier: { run: 0.15 },
    requires: ['usagi', 'uma'],
  },
  yakyubaka: {
    id: 'yakyubaka',
    name: '野球バカ',
    lineage: 'guts',
    rarity: DUO_RARITY,
    target: 'any',
    text: '打撃能力がすべて上がる',
    modifier: { average: 0.2, power: 0.2, run: 0.1 },
    requires: ['kinniku', 'nebari'],
  },
  tetsujin: {
    id: 'tetsujin',
    name: '鉄人',
    lineage: 'guts',
    rarity: DUO_RARITY,
    // 前提2つ（`タフネス`＋`フシチョウ`）がどちらも投手専用なので、デュオも投手専用。
    target: 'pitcher',
    // コンジョウのもう1つのデュオは**投手側**（`ヤキュウバカ` は打者側）。スタミナは
    // 限界球数そのもの（B-11）なので、揃えた投手は**延長まで球威が落ちない**。
    text: '投げ続けても衰えない',
    modifier: { stamina: 0.3, speed: 0.15 },
    requires: ['tafunesu', 'fushicho'],
  },
};

export const ALL_SKILL_IDS = Object.keys(SKILLS) as SkillId[];

/** 抽選プールに載るスキル（＝デュオ以外）。`SKILLS` の宣言順を保つ＝並び順が決定的 */
export const DRAFTABLE_SKILL_IDS: readonly SkillId[] = ALL_SKILL_IDS.filter(
  (id) => SKILLS[id].requires === undefined,
);

/** デュオ（★4）。前提が揃った選手がいるときだけ候補になる */
export const DUO_SKILL_IDS: readonly SkillId[] = ALL_SKILL_IDS.filter(
  (id) => SKILLS[id].requires !== undefined,
);

export function skillDef(id: SkillId): SkillDef {
  return SKILLS[id];
}

// ---- 消費型（フェーズF-26-8） ----

/**
 * **動詞系のスキル**（データ側に効果を持たず、使う場所が `hasSkill` で問い合わせるもの）。
 * 効果の書き忘れ（`modifier` を付けそこねた新スキル）が黙って死に札になるのを防ぐため、
 * `tests/skills.test.ts` がこの一覧と突き合わせる。
 */
export const VERB_SKILL_IDS: readonly SkillId[] = ['ju', 'baiku', 'doroppukikku'];

/**
 * **消費型が代用する常設の動詞**（フェーズF-26-8）。
 *
 * 消費型は新しい操作を増やすのではなく、**既存の動詞を回数券として配る**。だから
 * 判定側（`fielding.ts`・`chicchaiScene.ts`）にはスキルが増えたことすら見えず、
 * 「その走者は蹴れるか」という既存の問い合わせ（`roster.ts` の `canUseVerb`）の
 * 答えが変わるだけで済む。
 *
 * **常設の札を持っていればチャージは減らない**（`useVerb`）＝両方持った選手では
 * 消費型が実質そのまま常設になる（死に札にならない）。
 */
export const CONSUMABLE_VERB: Partial<Record<SkillId, SkillId>> = {
  tetsugeta: 'doroppukikku',
  yobiju: 'ju',
  nitoro: 'baiku',
};

/** 消費型か（`charges` を持つか） */
export function isConsumable(id: SkillId): boolean {
  return SKILLS[id]?.charges !== undefined;
}

// ---- 一時効果（フェーズM-33） ----

/**
 * 一時効果か（切ってからその打席の終わりまでだけ効く札）。
 *
 * **効果の中身は問わない**（`modifier` でも `play` でも `brawl` でもよい）＝`duration` は
 * 効果の種類ではなく**効く長さ**の軸で、既存の3つの形に掛け合わせる。だから読み出し側は
 * 「いまこの札は効いているか」だけを見ればよく、効果の適用は従来の経路のままになる。
 */
export function isTemporary(id: SkillId): boolean {
  return SKILLS[id]?.duration !== undefined;
}

/**
 * 一時効果の札（宣言順）。**同じ選手が2枚持っていたら宣言順の先頭から切る**
 * （`CONSUMABLE_VERB` の消費順が宣言順なのと同じ、決定的な規則）。
 */
export const TEMPORARY_SKILL_IDS: readonly SkillId[] = ALL_SKILL_IDS.filter((id) =>
  isTemporary(id),
);

/**
 * その一時効果が**どの役割で切るか**（フェーズM-33）。CLAUDE.md ① の「A/Bは場面で機能が
 * 変わる」多目的ボタン方式の延長で、**Gの空いていた2つのスロット**にそのまま対応する：
 *
 * - `'batting'`＝**でっかいモードの打者側**（打席の頭で切る）
 * - `'fielding'`＝**ちっちゃいモードの守備側**（打球を見てから切る）
 *
 * **効果の中身から導出せず、札に書く**：`play.catchRadius` を持つ札が将来「走者の
 * 守備範囲」に使われても困らないようにするためで、押す場所は札の設計そのものだから。
 */
export type EffectRole = 'batting' | 'fielding';

export function effectRole(id: SkillId): EffectRole {
  // 守備範囲を動かす札だけが守備側。増えたらここに足す（`tests/skills.test.ts` が
  // 「すべての一時効果が役割を持つ」ことを固定する）。
  return SKILLS[id]?.play?.catchRadius !== undefined ? 'fielding' : 'batting';
}

/** その役割で切れる一時効果の一覧（宣言順＝切る順番も同じ） */
export function temporariesForRole(role: EffectRole): SkillId[] {
  return TEMPORARY_SKILL_IDS.filter((id) => effectRole(id) === role);
}

/** その動詞を代用できる消費型の一覧（宣言順＝消費する順番も同じ） */
export function consumablesForVerb(verb: SkillId): SkillId[] {
  return (Object.keys(CONSUMABLE_VERB) as SkillId[]).filter((id) => CONSUMABLE_VERB[id] === verb);
}

/**
 * その選手が持っているスキルから、消費型1枚の**総チャージ数**を求める
 * （素の `charges` ＋ 強化デュオの `chargeBonus`）。
 *
 * 残り回数は「総チャージ − 使った数」として `roster.ts` が導出する＝**残りという数字を
 * 別に持たない**（B-11の残りスタミナ・F-26-2の残弾と同じ整理）。強化デュオを取った
 * 瞬間に残り回数が増えるのも、この導出の副産物として自動的にそうなる。
 */
export function chargeTotalOf(skills: readonly SkillId[], skillId: SkillId): number {
  const base = SKILLS[skillId]?.charges;
  if (base === undefined) return 0;
  let total = base;
  for (const id of skills) {
    const def = SKILLS[id];
    if (!def?.chargeBonus) continue;
    if (def.requires?.includes(skillId)) total += def.chargeBonus;
  }
  return total;
}

/** 「★★☆☆」のような表示（3択画面のレアリティ表記） */
export function rarityStars(rarity: SkillRarity): string {
  return '★'.repeat(rarity) + '☆'.repeat(4 - rarity);
}

// ---- 効果の合成（持っているスキルの一覧 → 実際に効く値） ----

/**
 * 持っているスキルのパラメータ補正を合成する。**足すだけ**（掛け算にしない）のは、
 * 能力値が 0..1 の正規化レーティングで、適用側が最後に 0..1 へクランプするため
 * ＝重ねがけしても上限を超えた分は素直に頭打ちになる。
 */
export function combinedModifier(skills: readonly SkillId[]): StatModifier {
  const total: StatModifier = {};
  for (const id of skills) {
    const mod = SKILLS[id]?.modifier;
    if (!mod) continue;
    for (const key of Object.keys(mod) as (keyof StatModifier)[]) {
      total[key] = (total[key] ?? 0) + (mod[key] ?? 0);
    }
  }
  return total;
}

/**
 * 持っているスキルのプレー定数補正を合成する（フェーズF-26-5）。`combinedModifier` と
 * まったく同じ足し算で、**違うのは適用先だけ**（レーティング 0..1 ではなく既存の定数 m/発）。
 * 読み出しは `roster.ts` の `effectivePlay` 1か所に集約する。
 */
export function combinedPlay(skills: readonly SkillId[]): PlayModifier {
  const total: PlayModifier = {};
  for (const id of skills) {
    const play = SKILLS[id]?.play;
    if (!play) continue;
    for (const key of Object.keys(play) as (keyof PlayModifier)[]) {
      total[key] = (total[key] ?? 0) + (play[key] ?? 0);
    }
  }
  return total;
}

/**
 * 持っているスキルから乱闘の装備を組む。**乱闘の判定そのもの（`brawl.ts`）はスキルを
 * 一切知らない**：ここで「体力・威力・出せる技」という値に翻訳してから渡すので、
 * 乱闘は純粋な格闘エンジンのままでいられる（テストもスキル抜きで書ける）。
 *
 * **威力の重ねがけは足し算**（フェーズI-29。それまでは掛け算だった）。理由は2つ：
 *
 * 1. **一貫性**：このファイルの他の補正（`combinedModifier` のレーティング、
 *    `combinedPlay` の捕球半径・射程）はすべて足し算で、CLAUDE.md ⑧も
 *    「skills.ts の補正が足し算なのはこのため」と書いている。乱闘の威力だけが
 *    掛け算なのは取り決めから外れていた。
 * 2. **1コンボKOが構造的に消える**：掛け算では `ブキモチコミ`(1.5) × デュオ
 *    `バットリュウケン`(1.5) = 2.25 になり、**バットリュウケン単発が 46×2.25＝104
 *    ＝100HPを一撃で超えていた**（`npm run balance:brawl` の実測で 0.83秒KO）。
 *    足し算なら 1+0.5+0.5＝2.0 で 92 ＝ 一撃では倒れず、フルコンボでも 89.6＜100。
 *    **「必殺技を当てれば勝ち」ではなく「もう一度当てにいく」局面が残る。**
 */
export function brawlLoadoutFor(skills: readonly SkillId[]): FighterLoadout {
  let maxHp = BRAWL_MAX_HP;
  // 足し算にするため「1 からの増分」を積む（1.5 なら +0.5）
  let powerBonus = 0;
  const specials: SpecialId[] = [...DEFAULT_LOADOUT.specials];
  let superMove: SuperId | null = DEFAULT_LOADOUT.super;
  const passives: BrawlPassives = { ...DEFAULT_LOADOUT.passives };
  for (const id of skills) {
    const brawl = SKILLS[id]?.brawl;
    if (!brawl) continue;
    if (brawl.hp) maxHp += brawl.hp;
    if (brawl.powerScale) powerBonus += brawl.powerScale - 1;
    if (brawl.special && !specials.includes(brawl.special)) specials.push(brawl.special);
    if (brawl.super) superMove = brawl.super;
    const p = brawl.passive;
    if (p) {
      if (p.dash) passives.dash = true;
      if (p.ironFist) passives.ironFist = true;
      if (p.armor) passives.armor += p.armor;
      // 倍率の体質は「1 からの差」を足す（重ねても極端にならない）
      if (p.rage) passives.rage += p.rage - 1;
      if (p.intimidate) passives.intimidate += p.intimidate - 1;
      if (p.walk) passives.walk += p.walk - 1;
      if (p.jump) passives.jump += p.jump - 1;
      if (p.stunGuard) passives.stunGuard += p.stunGuard;
    }
  }
  return { maxHp, powerScale: 1 + powerBonus, specials, super: superMove, passives };
}

// ---- 抽選 ----

/** 1回ぶんの抽選結果（提示する候補）。付ける選手は選択の2段階目で決まる */
export interface SkillDraft {
  /** 提示された候補（多くて `DRAFT_OPTION_COUNT` 個。候補が尽きていれば少ない） */
  options: readonly SkillId[];
}

/**
 * 抽選に必要な、ロスターから見た「誰が何を持っているか」だけを抜き出した形。
 * **`TeamRoster` そのものを受け取らない**のは、`roster.ts` → `skills.ts` の一方向の
 * 依存を保つため（`skills.ts` は選手データの構造を知らなくてよい）。
 */
export interface SkillHolder {
  id: string;
  /** 投球能力を持つか（target: 'pitcher' の判定に使う） */
  canPitch: boolean;
  /**
   * **いま効いているスキル**（消費型のうち使い切ったものは含まない。F-26-8）。
   * 枠の数え方もデュオの前提もこちらで判定する＝**使い切った札は枠を返し、
   * 強化デュオの候補からも外れる**。
   */
  skills: readonly SkillId[];
  /**
   * **取ったことのあるスキル**（使い切ったものも含む。F-26-8）。重複取得を防ぐためだけに
   * 使う＝使い切った消費型を引き直して無限に補充する、が起きない。
   * 省略時は `skills` と同じ（消費型を持ち込まないテスト・呼び出しは従来どおり書ける）。
   */
  owned?: readonly SkillId[];
}

/** その選手にそのスキルを付けられるか（枠・重複・対象・デュオの前提） */
export function canGrant(holder: SkillHolder, skillId: SkillId): boolean {
  const def = SKILLS[skillId];
  if (!def) return false;
  if ((holder.owned ?? holder.skills).includes(skillId)) return false;
  if (def.target === 'pitcher' && !holder.canPitch) return false;
  if (def.requires) {
    // デュオは**枠上限の例外**。前提（1〜2つ）を同じ選手が持っていることだけが条件で、
    // **使い切った消費型は前提を満たさない**（`skills` が生きている札だけなので自動）。
    return def.requires.every((req) => holder.skills.includes(req));
  }
  return holder.skills.length < MAX_SKILLS_PER_PLAYER;
}

/** そのスキルを付けられる選手（**引数の順序をそのまま保つ**＝候補の並びが決定的） */
export function eligibleHolders(
  holders: readonly SkillHolder[],
  skillId: SkillId,
): SkillHolder[] {
  return holders.filter((holder) => canGrant(holder, skillId));
}

/** 抽選プールに載りうるレアリティ（★1〜3）を、重みの宣言順で */
const DRAFTABLE_RARITIES: readonly SkillRarity[] = ([1, 2, 3] as const).filter(
  (r) => (DRAFT_RARITY_WEIGHT[r] ?? 0) > 0,
);

/**
 * プールから1枚引く。**まずレアリティを重みで引き、その中から等確率で1枚**（フェーズF-26-5）。
 *
 * 旧実装（各スキルの重み＝そのレアリティの重み、として一括で引く）は、**プールが増えると
 * 出現比が勝手に変わる**問題があった：★1のスキルを10枚足すと ★1 の合計重みが10倍になり、
 * `DRAFT_RARITY_WEIGHT` の 60:30:10 が実際の出方と一致しなくなる。プールを10→41へ広げる
 * このフェーズでは、そこが表示（★の数）と体感のズレになる。
 *
 * レアリティを先に引けば **60:30:10 は枚数によらず正確に成り立つ**ので、以後スキルを
 * 何枚足しても出現比の再調整が要らない（＝「増やすときに触るのは `SKILLS` だけ」を保てる）。
 * そのレアリティの候補が尽きていれば重み0として扱い、残っているレアリティから引く。
 */
function drawOneFromPool(
  state: RngState,
  pool: readonly SkillId[],
): { id: SkillId; state: RngState } {
  const weights = DRAFTABLE_RARITIES.map((rarity) =>
    pool.some((id) => SKILLS[id].rarity === rarity) ? (DRAFT_RARITY_WEIGHT[rarity] ?? 0) : 0,
  );
  const rolled = nextWeightedIndex(state, weights);
  const bucket = pool.filter((id) => SKILLS[id].rarity === DRAFTABLE_RARITIES[rolled.index]);
  // 重み0のレアリティしか無い（＝すべて空）ときの保険。プールが空でない限り、
  // ここへ落ちてもプール先頭を返して抽選を止めない。
  if (bucket.length === 0) return { id: pool[0], state: rolled.state };
  const picked = nextIndex(rolled.state, bucket.length);
  return { id: bucket[picked.index], state: picked.state };
}

/**
 * 3択を引く。
 *
 * - **前提が揃っているデュオは必ず候補に入れる**（揃えた報酬が運で流れると、
 *   「誰に集めるか」というランの目標が成立しないため）。複数揃っていれば宣言順に入る。
 * - 残りの枠を ★1〜3 からレアリティの重み付きで引く（重複なし。`drawOneFromPool`）。
 * - **付けられる選手が1人もいないスキルは候補に出さない**（押しても何も起きない選択肢を
 *   並べない＝「意思決定材料は隠さない」の裏返し）。
 * - **`lineages` を渡すと、その系統のスキルだけが候補になる**（フェーズF-26-5の
 *   「試合ごとに系統を絞る」）。省略すると全系統＝絞り込みを入れる前とまったく同じ挙動で、
 *   系統を意識しないテストはそのまま書ける（`stepBattedBall` の球場が省略可能なのと同じ形）。
 */
export function drawSkillDraft(
  state: RngState,
  holders: readonly SkillHolder[],
  lineages?: readonly SkillLineage[],
): { draft: SkillDraft; state: RngState } {
  const inLineage = (id: SkillId): boolean =>
    lineages === undefined || lineages.includes(SKILLS[id].lineage);
  const available = (ids: readonly SkillId[]): SkillId[] =>
    ids.filter((id) => inLineage(id) && holders.some((holder) => canGrant(holder, id)));

  const options: SkillId[] = available(DUO_SKILL_IDS).slice(0, DRAFT_OPTION_COUNT);
  const pool = available(DRAFTABLE_SKILL_IDS);

  let s = state;
  while (options.length < DRAFT_OPTION_COUNT && pool.length > 0) {
    const drawn = drawOneFromPool(s, pool);
    s = drawn.state;
    options.push(drawn.id);
    pool.splice(pool.indexOf(drawn.id), 1);
  }

  return { draft: { options }, state: s };
}

/**
 * CPU側の選択（フェーズF-26-1）。**完全に決定的で、乱数を一切引かない。**
 *
 * 桜井ノウハウ照合：「**コンピューターが良い目を出すとイカサマしてると思われがち**」
 * 「人ができる範囲のこともずるいと思われるのはCPの常」。CPUの引きが乱数だと、
 * 競り負けたときに必ず「CPUだけ運がいい」と受け取られる。規則を決定的にしておけば
 * 「そういう規則だから読めたはず」に変わる（CLAUDE.md ⑧）。
 *
 * 規則は2つだけ：
 * 1. **候補のうち最もレアなものを取る**（同率なら候補の並び順の先）。
 * 2. **付けられる選手のうち先頭**（呼び出し側が打順順で渡すので＝打線の上位から埋まる）。
 *    結果としてCPUは上位打線に集約していくので、**デュオも自然に揃う**。
 */
/**
 * CPUがリロールするか（フェーズU-42）。**完全に決定的で、乱数を一切引かない**
 * （`cpuChooseSkill` と同じ理由＝引きが乱数だと、競り負けたときに必ず「CPUだけ運がいい」に
 * 受け取られる。規則が決まっていれば「そういう規則だから読めたはず」になる）。
 *
 * 規則は1つだけ：**★2以上が1枚も無ければ引き直す**。
 * `cpuChooseSkill` が「最もレアなものを取る」以上、**引き直す値打ちがあるのは
 * 最高が★1のときだけ**なので、CPUの選択規則からそのまま導かれる形にしてある
 * （CPU専用の重み表を別に持たない）。
 *
 * **CPUは温存しない**（F-26-8の消費型と同じ）＝言うたびに使い、尽きたら黙る。
 * 「いつ引き直すか」という温存の判断は人間側の取り分。
 */
export function shouldCpuReroll(draft: SkillDraft): boolean {
  if (draft.options.length === 0) return false;
  return draft.options.every((id) => SKILLS[id].rarity <= 1);
}

export function cpuChooseSkill(
  draft: SkillDraft,
  holders: readonly SkillHolder[],
): { skillId: SkillId; holderId: string } | null {
  let best: { skillId: SkillId; holderId: string; rarity: SkillRarity } | null = null;
  for (const skillId of draft.options) {
    const eligible = eligibleHolders(holders, skillId);
    if (eligible.length === 0) continue;
    const rarity = SKILLS[skillId].rarity;
    if (best === null || rarity > best.rarity) {
      best = { skillId, holderId: eligible[0].id, rarity };
    }
  }
  return best === null ? null : { skillId: best.skillId, holderId: best.holderId };
}
