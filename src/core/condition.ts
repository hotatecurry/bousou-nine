/**
 * 打者の好調（ゼッコーチョー／ラッキー7。フェーズD-19。説明書p16-17）。
 *
 * 原作の「バットをクルクル回している打者＝その試合の絶好調選手。成績以上の打撃が
 * 期待できる」と「7回の攻撃はバッター全員がゼッコーチョー」の2つを、**同じ1つの状態**
 * （その打者が今この瞬間 好調か）として持つ。効果も見せ方も同じものなので、別々の
 * 仕組みにすると「ラッキー7だけバットが回らない」といった食い違いが生まれる。
 *
 * ## このファイルが持つもの
 *
 * `core/tempo.ts`（間の長さ）・`core/camera.ts`（寄り具合）と同じ立て方で、
 * **調整したくなる値と規則だけ**を1か所に集める。誰が好調かという試合中の状態は
 * `TeamRoster.hot` が、乱数の状態は `GameContext.rngState` が持つ。
 *
 * ## 好調は「レーティングへの補正」1本で表す
 *
 * スキルのパラメータ系（CLAUDE.md ⑧）とまったく同じ形（`StatModifier`）にしてあるので、
 * 打球初速もHUDの打者カードの AV/HR も**従来の導出経路をそのまま通って一緒に動く**
 * （⑥「表示はレーティングからの導出」）。好調専用の係数を判定側に持ち込まないので、
 * 「ゼッコーチョーと出ているのに打球は非力」が構造的に起きない。
 *
 * ## 乱数の扱い
 *
 * 誰が絶好調かはシードから決まる（`pickHotBatters`）。**本編の乱数列
 * （`GameContext.rngState`）は消費せず**、`activeLineagesFor`（F-26-5）と同じく
 * 塩を混ぜた別系列から引く：
 * - 「シードを渡さない `MATCH_SETUP` は既定シードのまま」という既存の約束
 *   （テストが決定的に書ける）を保つため。
 * - 好調は試合開始時に一度決まるだけの値で、スキル抽選の系列に割り込ませると
 *   「何回目の抽選か」と乱数の位置がずれるため。
 */
import type { RngState } from './rng';
import { createRngState, sampleWithoutReplacement } from './rng';
import type { PlayerId } from './roster';
import type { TeamSide } from './rules';
import type { StatModifier } from './skills';

/**
 * 各チームの絶好調選手の人数（2026-07-28 ユーザー判断）。対象は**打線9人＋控え3人**で、
 * 控えも好調になりうる＝「今日あたっている控えを代打に出す」という采配が生まれる
 * （D-18で采配メニューに能力値を併記したのと同じ「意思決定材料は隠さない」方針）。
 *
 * 1試合の打席はチーム40前後なので、2人なら好調の打者は4〜5打席に1回まわってくる。
 * 1人だと2回に1度も出会わず「その試合の絶好調選手」を体感できないまま終わりうる。
 */
export const HOT_BATTERS_PER_TEAM = 2;

/**
 * 全員が好調になるイニング（説明書p17「ラッキー7」）。**7回の攻撃**なので表・裏の
 * 両方が対象＝先攻・後攻のどちらにも同じだけ回ってくる。
 *
 * **延長（10回以降）は対象外**：原作の記載は7回のみで、「7回だけ試合の様子が変わる」
 * という山場そのものが狙いなので、延長のたびに繰り返すとその意味が薄れる。
 */
export const LUCKY_INNING = 7;

/**
 * 好調のときに乗る能力値補正（2026-07-28 ユーザー判断：AV＋HRの2項目）。
 *
 * - **AV**（芯・タイミングを外したときの打球の弱まりにくさ）＝詰まっても前へ飛ぶ。
 * - **HR**（打球初速の上乗せ）＝捉えれば遠くへ飛ぶ。
 *
 * 原作の説明は「成績以上の打撃が期待できる」だけなので、**打撃の2項目に絞る**
 * （走力RUNまで上げると内野安打・盗塁まで好調が効き、原作が言っている範囲から広がる）。
 *
 * 値は⑧のスキルでいう★2相当（`カジバノチカラ` の HR+0.35 より控えめ、★1の +0.1 より上）。
 * **表示にすると打率 .300→.330・本塁打 14→23本**ぶんで、カードの数字を見て
 * 「今日はこの打者が来ている」と分かる大きさになっている。
 */
export const HOT_MODIFIER: StatModifier = { average: 0.2, power: 0.2 };

/**
 * 絶好調選手の抽選に混ぜる塩（チームごとに別の値）。**両チームで同じ系列を使うと、
 * 候補の並びが同じ長さである以上まったく同じ添字が選ばれる**＝先攻・後攻とも
 * 「3番と7番が絶好調」のような揃い方になり、抽選している感じが消える。
 *
 * `skills.ts` の `LINEAGE_SEED_SALT` と同じ考え方（本編の乱数を消費せず、シードから
 * 別系列を起こす）で、値そのものに意味は無い。
 */
const HOT_SEED_SALT: Record<TeamSide, number> = {
  away: 0x407,
  home: 0xb075,
};

/**
 * その試合の絶好調選手を選ぶ（シードから決まる純粋関数）。
 *
 * **候補より人数が多くても、あるだけ返す**（`sampleWithoutReplacement` の仕様）ので、
 * 候補が空のロスターでも止まらない。返す並びは候補の並び順に揃える＝引いた順番によらず
 * 表示・テストの見え方が安定する（`activeLineagesFor` が `ALL_LINEAGES` の順へ
 * 揃えて返すのと同じ整理）。
 */
export function pickHotBatters(
  seed: RngState,
  candidates: readonly PlayerId[],
  side: TeamSide,
): readonly PlayerId[] {
  const { picked } = sampleWithoutReplacement(
    createRngState(seed + HOT_SEED_SALT[side]),
    candidates,
    HOT_BATTERS_PER_TEAM,
  );
  return candidates.filter((id) => picked.includes(id));
}

/**
 * ラッキー7のイニングか（説明書p17）。**イニングを渡さない呼び出しは常に false**＝
 * 試合の文脈を持たない読み出し（単体テストなど）は、ラッキー7を持ち込む前と
 * まったく同じ値を見る（B-9で `BatterSide` の既定を右打者にしたのと同じ整理）。
 */
export function isLuckyInning(inning?: number): boolean {
  return inning === LUCKY_INNING;
}

/**
 * その打者が今この瞬間 好調か。**絶好調選手（試合を通して固定）か、ラッキー7の攻撃か**の
 * どちらかで立つ。呼び出し側はこの1つの問いだけを見ればよく、2つの由来を区別しない
 * （効果も見せ方も同じなので、区別すると分岐が増えるだけ）。
 */
export function isHotBatter(
  hot: readonly PlayerId[],
  playerId: PlayerId,
  inning?: number,
): boolean {
  return isLuckyInning(inning) || hot.includes(playerId);
}
