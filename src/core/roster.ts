/**
 * 選手データ・交代システムの純粋ロジック（判定・状態更新のみ、状態は持たない）。
 *
 * v1スコープ（PROGRESS.md セッション7、フェーズB-10で守備位置を追加）：
 * - 9人の打順＋控え野手（代打要員）、先発投手＋救援投手（ブルペン）という
 *   最小限のロスター構造。**DH制は扱わない（投手も打順に入る）**＝原作準拠。
 * - **打順9スロットと9守備位置は1対1で対応する**（フェーズB-10）。詳しくは `positions` /
 *   `pitcherSlot` のコメント。
 * - 交代は「乱闘敗北による強制退場」からの自動代打/継投（`ejectBatterAndSubstitute`/
 *   `ejectPitcherAndSubstitute`。控え/ブルペンの先頭を機械的に起用）と、監督采配としての
 *   任意タイミングでの代打/継投（`substituteBatterAt`/`substitutePitcherAt`。控え/ブルペンから
 *   指定インデックスの1人を起用、セッション9で追加）の2経路がある。前者は「負けた事実は
 *   交代の成否と無関係に確定する」ため控え/ブルペンが尽きていても outgoing を `ejected` に
 *   積んで ok:false を返す（没収試合の判定材料）。後者は采配メニュー側の任意選択という
 *   性質上、範囲外インデックス（=呼び出し側の防御的ガード漏れ）なら roster を一切変更せず
 *   ok:false を返す（何も起きない）。前者は後者を内部で使う薄いラッパー。
 * - 一度代打/継投で交代した選手は再出場しない（実際の野球のルールに準拠。理由の別なく
 *   ロースター離脱は共通して `ejected` に積む）。
 */
// 守備位置の識別子は守備システム（fielding.ts）が持つ9つのキーをそのまま使う。
// 「ロスターの守備位置」と「フィールド上の守備位置」が別々の語彙になると、割り当てた
// つもりの選手がどの野手なのか対応づけられなくなるため、型ごと共有する（型のみの
// import なので実行時の依存は生まれない。fielding.ts は roster.ts を参照しない）。
import type { FielderId } from './fielding';
// 名鑑（16球団の固定データ。フェーズB-12）から実際のロスターを組む。**データの側は
// 一切の状態を持たず、ここが「試合中に変化する状態」だけを受け持つ**（打順・交代・投球数）。
// teams.ts が roster.ts を参照するのは型だけなので、実行時の循環参照は生まれない。
import {
  type BenchRow,
  type FielderRow,
  type TeamData,
  type TeamId,
  benchRowStats,
  fielderRowStats,
  pitcherRowBatting,
  pitcherRowPitching,
} from './teams';
// ローグライトのスキル（フェーズF-26-1）。**`skills.ts` は選手データの構造を知らず、
// `roster.ts` の側が一方向に依存する**（`teams.ts` との関係と同じ整理）。
import {
  type EffectRole,
  type PlayModifier,
  type SkillHolder,
  type SkillId,
  GUN_SHOTS_PER_PITCHER,
  MAX_SKILLS_PER_PLAYER,
  SKILLS,
  brawlLoadoutFor,
  canGrant,
  chargeTotalOf,
  combinedModifier,
  combinedPlay,
  consumablesForVerb,
  effectRole,
  isConsumable,
  isTemporary,
  temporariesForRole,
} from './skills';
// 好調（ゼッコーチョー／ラッキー7。フェーズD-19）。`skills.ts` と同じく、こちらは
// 規則と補正の値だけを持ち、誰が好調かという状態は `TeamRoster.hot` が持つ。
import { HOT_MODIFIER, isHotBatter, pickHotBatters } from './condition';
import type { RngState } from './rng';
import type { TeamSide } from './rules';
import type { FighterLoadout } from './brawl';
// 疲労を「能力値を下げる形」で読み替える3つ（B-11の球速・変化量／W-44の制球）。
// **`pitch.ts` は何も import しない自己完結の層**なので、ここから参照しても循環しない。
// Z-47 の `pitcherQuality` が「疲れた投手＝一時的に能力の低い投手」という B-11 の
// 読み替えをそのまま比較に使うために要る。
import {
  type PitchArm,
  LEFT_ARM_SIDE,
  NEUTRAL_PITCH_ARM,
  RIGHT_ARM_SIDE,
  fatiguedBreak,
  fatiguedControl,
  fatiguedSpeed,
  forkBounces,
} from './pitch';

export type PlayerId = string;

/** 守備位置（P/C/1B/2B/3B/SS/LF/CF/RF）。fielding.ts の野手IDと同一の語彙 */
export type FieldingPosition = FielderId;

// ---- 能力値（フェーズB-8。説明書p26-29の項目体系に準拠、数値と名前は独自） ----
//
// 能力値の「体系」は原作に合わせるが、球団名・選手名・具体数値は独自に用意する
// （原作の名称は他社の著作物のため。CLAUDE.md「選手データは仕組み優先・名前は独自」）。
// 判定に効く値は **すべて 0..1 の正規化レーティング**で持ち、実際の物理量（m/s 等）への
// 変換は各システム側の対応関数が受け持つ（batting.ts の judgeSwing、pitch.ts の
// speedForPitchSelection / steerAccelFor、fielding.ts の runnerSpeed）。こうしておくと
// 「能力値の刻み方」と「ゲームの手触りの調整」を別々にいじれる。

/** 打席（説明書のBOX）。R=右打ち / L=左打ち / S=両打ち */
export type Handedness = 'R' | 'L' | 'S';

/** 投球腕（説明書のARM）。R=右投げ / L=左投げ / S=サイドスロー / U=アンダースロー */
export type ThrowArm = 'R' | 'L' | 'S' | 'U';

export interface BatterStats {
  /**
   * 打席の左右（BOX）。フェーズB-9で判定に接続済み：打席の立ち位置・バットの到達範囲・
   * 死球ゾーン・引っ張り方向がXについて鏡像になる（pitch.ts の BatterSide）。
   * S（両打ち）が実際にどちらの打席に立つかは相手投手で決まる（effectiveBattingHand）。
   */
  bats: Handedness;
  /**
   * 打率（AV）0..1。芯やタイミングを外したときの**打球の弱まりにくさ**に効く
   * （巧打者は詰まっても前へ飛ぶ）。当たりやすさ＝バットの到達範囲やスイングの有効時間は
   * 全打者共通のまま：人間が操作する以上、打者が変わるたびにスイングの手応えが
   * 変わってしまうと操作感が安定しないため（2026-07-23 ユーザー判断）。
   */
  average: number;
  /** 本塁打（HR）0..1。打球初速に上乗せされる＝長打力そのもの */
  power: number;
  /** 走力（RUN）0..1。走者としての足の速さ（fielding.ts の runnerSpeed） */
  run: number;
}

export interface PitcherStats {
  /**
   * 投球腕（ARM）。読む側は3つで、どれも `pitchArmOf` を通す：**両打ち（BOX=S）の打者が
   * どちらの打席に立つか**（effectiveBattingHand。B-9）／**投球の姿勢とリリース位置の
   * 横のずれ**（CC-50）／**投手ゴロを処理したときの送球の腕**（`fielderThrowArm`。HH-55）。
   * 対左右の打撃相性は原作の名鑑に項目が無いので入れていない。
   */
  throws: ThrowArm;
  /**
   * 防御率（ERA）。**HUDの投手カードに出す実数値**（フェーズD-18＝原作のHUD
   * 「ピッチャーの名前・防御率」）であり、**T-41からは制球の出どころでもある**
   * （`pitcherControl`＝CPU投手が狙いをどれだけ外すか）。他の項目と違って
   * レーティングではなく実数値のまま持つのは、原作の名鑑がそう書かれているから
   * （表示はそのまま `formatEra`、判定に効くときだけ 0..1 へ換算する）。
   */
  era: number;
  /** 球速（SPD）0..1。緩急3段階すべての基準になる（pitch.ts の speedForPitchSelection） */
  speed: number;
  /** 変化量：シュート方向（右へ曲げるときの曲がりの強さ）0..1 */
  breakRight: number;
  /** 変化量：カーブ方向（左へ曲げるときの曲がりの強さ）0..1 */
  breakLeft: number;
  /**
   * 変化量：フォーク（F）0..1。**上入力で選んだ遅い球を曲げるときだけ、R/L の代わりに
   * これを使う**（フェーズO-35。`pitch.ts` の `steerAccelForSelection`）。球速には効かない
   * ＝「緩急の幅」に繋ぐ案は計測が否定した（同関数のコメント）。
   */
  fork: number;
  /**
   * スタミナ（STM）0..1＝**球威を保てる球数の大きさ**（燃料タンクの容量）。
   * 実際の消耗は投球数（`TeamRoster.pitchCounts`）が持ち、残量・疲労はそこから
   * 導出する（maxPitchesFor / staminaRemaining / fatigueFromRemaining）。
   * **先発型/リリーフ型の区別もこの値そのもの**（pitcherRole）。
   */
  stamina: number;
}

// ---- スタミナの消耗モデル（フェーズB-11。説明書p26-29のSTM） ----
//
// **真実は「投球数」の側に置き、残りスタミナ・疲労はそこから導出する**（B-8で `Bases` を
// `BaseRunners` の派生ビューにし、B-10で `pitcher` を `positions.P` の派生ビューにしたのと
// 同じ整理）。投球数は「何球投げたか」という消しようのない事実なので、これを truth に
// すれば「表示上の残量」と「判定に効く疲労」が食い違うことが構造的に起きない。
//
// 能力値と同じく、ここが持つのは 0..1 の正規化された量だけで、球速・変化量・打球初速への
// 変換は各システム側（pitch.ts の fatiguedSpeed/fatiguedBreak、batting.ts の judgeSwing）が
// 受け持つ。

/** スタミナ0の投手が持つ球数（これでも1〜2イニングは投げられる） */
export const STAMINA_MIN_PITCHES = 25;
/** スタミナ1.0で上乗せされる球数（0.85の先発型なら110球＝ほぼ完投できる） */
export const STAMINA_PITCH_SPAN = 100;
/**
 * 球威が落ち始める残量。**残量が半分を切るまでは何球投げても従来とまったく同じ球**に
 * なる（＝立ち上がりから性能が下がり続けると、能力値を入れる前との差が常時出てしまい、
 * 調整済みの手触りの基準線が失われる）。この「前半は無傷」があることで、HUDのゲージが
 * 半分を割った瞬間が「そろそろ継投を考える」という読み取れる合図になる。
 */
export const STAMINA_FRESH_THRESHOLD = 0.5;
/** 先発型とみなすスタミナの下限（原作の「上位が先発型・下位がリリーフ型」に相当） */
export const STARTER_STAMINA_MIN = 0.6;
/**
 * 投球能力を持たない選手がマウンドにいた場合に使う基準スタミナ（読み出しで止めないための保険）。
 * 疲労の持ち越し（V-43の `restedPitchCounts`）も同じ保険を使うので、**残量の読み方と
 * 回復量の計算が同じ基準から出る**（別々に 0.5 と書くと片方だけ動かせてしまう）。
 */
export const NEUTRAL_STAMINA = 0.5;

/** 先発型 / リリーフ型（説明書p8：リリーフ型はスタミナが少なく先発向きでない） */
export type PitcherRole = 'starter' | 'reliever';

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** その投手が球威を保てる限界の球数 */
export function maxPitchesFor(stamina: number): number {
  return STAMINA_MIN_PITCHES + STAMINA_PITCH_SPAN * clamp01(stamina);
}

/** 残りスタミナ 1（無傷）→ 0（限界）。HUD・采配メニューのゲージはこの値を出す */
export function staminaRemaining(pitchCount: number, stamina: number): number {
  return clamp01(1 - Math.max(0, pitchCount) / maxPitchesFor(stamina));
}

/**
 * 球威の落ち具合 0（影響なし）→ 1（限界）。**残量が STAMINA_FRESH_THRESHOLD を
 * 切ってから効き始める**ので、0 のあいだは疲労を持ち込む前と完全に同じ球になる。
 */
export function fatigueFromRemaining(remaining: number): number {
  return clamp01((STAMINA_FRESH_THRESHOLD - remaining) / STAMINA_FRESH_THRESHOLD);
}

/**
 * 先発型かリリーフ型か。**スタミナから導出する派生ビューで、別のフィールドとしては
 * 持たない**（持つと「リリーフ型と表示されているのにスタミナは先発並み」という食い違いが
 * ありうる。原作でも型の実体はスタミナの多寡そのもの）。
 */
export function pitcherRole(stamina: number): PitcherRole {
  return stamina >= STARTER_STAMINA_MIN ? 'starter' : 'reliever';
}

// ---- 制球（フェーズT-41。説明書p26-29のERA） ----
//
// S-40 が「今回は意図的に触っていない」として明示的に残した最後の1つ＝**狙うコースに
// 持ち味が乗っていない**（`chooseCpuPitchPlan` はカウントだけを見るので、制球の良い投手も
// 悪い投手もまったく同じ隅を突く）。
//
// **新しい能力値は増やさない**（ユーザー判断）。ERA は D-18 でHUDに出して以来
// **判定に効かない唯一の項目**として96人ぶんの数値が眠っていたので、そこから導く
// ＝O-35 が F でやったのと同じ「名鑑にあるのに読む側が1人もいない数値」の埋め方。
// `pitcherRole` を STM から、`cpuPitcherStyle` を SPD/F から導くのと同じで、
// **別フィールドとしては持たない**（名鑑の ERA を触れば制球も一緒に動く）。
//
// 換算の幅は名鑑96人の実際の散らばりから決めた（`npm run balance:control` の1段目）。
// **中央値（3.10）がちょうど基準値 0.5** になるので、B-8 以来の「基準値0.5＝従来の定数」が
// ここでも成り立つ＝**平均的な投手の配球は T-41 の前と1mmも変わらない**。

/** 制球1.0（これ以上良くならない）とみなすERA。名鑑の最小は1.95（ギャラクシーズのシライシ） */
export const CONTROL_ERA_BEST = 2.0;
/** 制球0.0（これ以上悪くならない）とみなすERA。名鑑の最大は4.30（アイアンズのサイキ） */
export const CONTROL_ERA_WORST = 4.2;

/**
 * 防御率（ERA）→ 制球 0..1（**低いERAほど制球が良い**）。
 *
 * 名鑑96人は 1.95〜4.30 に散らばっており、この換算でほぼ 0..1 の全域を使う
 * （中央値 3.10 → ちょうど 0.5）。**単調減少**なので、HUDに出ている防御率の大小が
 * そのまま制球の良し悪しを表す＝**打者は投手カードのERAを見て「待てば得する相手か」を
 * 投げられる前に読める**（D-18の「表示された数字が判断材料として使える」がそのまま効く）。
 */
export function pitcherControl(era: number): number {
  return clamp01((CONTROL_ERA_WORST - era) / CONTROL_ERA_SPAN);
}

/** 制球 0..1 の全域に対応する防御率の幅（換算の分母。上の2定数からの導出） */
export const CONTROL_ERA_SPAN = CONTROL_ERA_WORST - CONTROL_ERA_BEST;

/**
 * 制球への補正（+が良くなる）を **ERA そのものへ書き戻す**（フェーズW-44。ユーザー判断）。
 *
 * スキルの制球補正を「制球レーティングの側」に持つと、**HUDの投手カードのERAは名鑑の
 * ままなのに隅を突いてくる**という食い違いが出る（D-18の「表示された数字が判断材料に
 * なる」が崩れる）。真実をERAの側1つに置けば、**表示も・CPUの狙い（`pitcherControl`）も・
 * 人間のコース入力の幅（`controlBonusOf`）も、全部そこからの導出**になる
 * （B-11の投球数→残量、D-18の表示打率と同じ整理）。
 *
 * 換算はERA→制球の逆（`CONTROL_ERA_SPAN` ぶんで1.0動く）なので、**制球 +0.2 は ERA -0.44**。
 * 0で下げ止めるのは表示のため（防御率が負になる名鑑は無い）で、判定側は
 * `pitcherControl` が 0..1 にクランプするのでここに上限は要らない。
 */
export function eraWithControl(era: number, controlDelta: number): number {
  return Math.max(0, era - controlDelta * CONTROL_ERA_SPAN);
}

// ---- いまの投手の質（フェーズZ-47。CPUの継投が「代えるか続投か」を比べる物差し） ----
//
// J-30の自動継投は**残量が 0.5 を切った瞬間に、質を一切見ずに代えていた**。そのため
// (1) 疲れたエースを格下のリリーフへ差し出す交代が起こりえ、(2) **CPU投手が疲れたまま
// 投げる場面が原理的に存在しなかった**（`npm run balance:relief` の1段目：16球団の
// 最大疲労は平均 0.091）＝B-11の球速・変化量・球威と W-44 の制球が、CPU側では一度も
// 画面に出ていなかった（W-44が「CPU側では出番が無い」と計測して残した部分）。
//
// **新しい物差しは作らない**（ユーザー判断：疲労込みの能力比較）。`pitch.ts` の B-11 の
// コメントが「疲労は**能力値を下げる形で効かせる**（疲れた投手＝一時的に球速も変化量も
// 低い投手に読み替える）」と明記しているので、**その読み替えをそのまま比較に使う**だけで
// 済む＝「疲労1.0は能力値でいうと何点ぶんか」という換算率（新しい自由変数）が要らない。

/**
 * その投手の**いまの質**（0..3。大きいほど良い投手）。疲労を織り込む。
 *
 * 足すのは**疲労が実際に削る3つ**（B-11の球速・変化量＋W-44の制球）で、どれも 0..1 の
 * レーティングなので**そのまま足せる**（重みという新しい自由変数を持たない）。
 * X-45 が代打を「AV＋HR の合計の差」で比べたのと同じ畳み方。
 *
 * - **スタミナ（STM）は入れない**：これは「あとどれだけ投げられるか」であって
 *   「いまどれだけ良い球か」ではなく、しかも残量・疲労という形で既にこの式の中に
 *   入っている（二重に数えることになる）。
 * - **フォーク（F）は入れない**：`tests/teams.test.ts` の `pitchingPower`（総合力の帯）が
 *   R/L の平均だけを見ているのに揃えた。F を総合力に算入するかは O-35 が
 *   「何試合か遊んでから決める」として開いたままの判断で、ここで先に決めない。
 * - **球威（`EXIT_FATIGUE_BONUS`）は入らない**：レーティングではなく打球初速への
 *   足し算なので、この軸には乗らない＝**疲労の費用を安全側（小さめ）に見積もる**
 *   （V-43が `sweep` の分母について記録したのと同じ性質の限界）。
 */
export function pitcherQuality(stats: PitcherStats | undefined, fatigue: number): number {
  const stuff = pitcherStuff(stats, fatigue);
  return stuff.speed + stuff.breaking + stuff.control;
}

/**
 * **いまの球の中身**（フェーズDD-51）＝`pitcherQuality` が足している3つを、足す前の形で返す。
 *
 * Z-47 は物差し（合計）だけを作って閉じたので、**CPUは「疲れたエースと無傷の格下」を
 * 比べられるのに、人間の采配メニューには型と残量%しか出ていなかった**（ブルペン候補の
 * 球速・変化量・ERAは試合中どこにも出ない）＝既存の「意思決定材料は隠さない」方針の穴。
 * ここを**合計から割り戻す**のではなく**合計をこの関数の和として定義し直す**ことで、
 * **画面に出る3本のバーと、CPUが比べている数字が同じ1か所から出る**
 * （B-11の投球数→残量、D-18の表示打率と同じ「真実は1か所」の整理）。
 *
 * どれも 0..1 のレーティングなので、そのまま `ratingBar` に渡せる。
 */
export interface PitcherStuff {
  /** 疲労を織り込んだ球速（B-11） */
  speed: number;
  /** 疲労を織り込んだ変化量＝R/Lの平均（B-11。Fを入れないのは `pitcherQuality` の注参照） */
  breaking: number;
  /** 疲労を織り込んだ制球＝ERAからの導出（T-41＋W-44） */
  control: number;
}

export function pitcherStuff(stats: PitcherStats | undefined, fatigue: number): PitcherStuff {
  if (!stats) return { speed: 0, breaking: 0, control: 0 };
  return {
    speed: fatiguedSpeed(stats.speed, fatigue),
    breaking: fatiguedBreak((stats.breakRight + stats.breakLeft) / 2, fatigue),
    control: fatiguedControl(pitcherControl(stats.era), fatigue),
  };
}

// ---- 表示用の数値（フェーズD-18。説明書p13のHUD「バッターの名前・打率・本塁打数」
//      「ピッチャーの名前・防御率」） ----
//
// 打率（AV）・本塁打（HR）は判定用に 0..1 のレーティングとして持っているので、**HUDに出す
// 打率・本塁打数はそこから導出する**（表示のための実数値フィールドを別に持たない）。
// 真実がレーティングの側だけにあれば「.320 と表示されているのに打球は非力」という食い違いが
// 構造的に起きない（B-8で `Bases` を `BaseRunners` の、B-10で `pitcher` を `positions.P` の、
// B-11で残りスタミナを投球数の派生ビューにしたのと同じ整理）。
//
// 導出は**単調増加**なので、名鑑の数字の大小はそのまま能力の大小を表す＝表示された打率・
// 本塁打数が「誰を代打に出すか」「この打者を歩かせるか」の判断材料として実際に使える
// （表示と実力が一致していない数字は判断材料にならない）。
//
// **ERAだけは実数値をそのまま持っている**（`PitcherStats.era`）。原作でもERAは独立した
// データ項目で、判定に効くレーティングを持たない＝導出元が無いため。

/** レーティング0の打者の表示打率 */
export const DISPLAY_AVG_MIN = 0.2;
/** レーティング1で上乗せされる打率（1.0なら .350） */
export const DISPLAY_AVG_SPAN = 0.15;
/** レーティング1の打者の表示本塁打数（4番の0.95で43本） */
export const DISPLAY_HR_MAX = 45;

/** 打率レーティング（AV）→ 表示用の打率 0.200〜0.350 */
export function displayAverage(average: number): number {
  return DISPLAY_AVG_MIN + DISPLAY_AVG_SPAN * clamp01(average);
}

/** 本塁打レーティング（HR）→ 表示用の本塁打数 0〜45本 */
export function displayHomeRuns(power: number): number {
  return Math.round(DISPLAY_HR_MAX * clamp01(power));
}

/**
 * 打率レーティング（AV）→ 野球の慣習どおり整数部を落とした3桁表記（.320）。
 * 表示の桁が崩れないよう、範囲外（1.000以上）も一応の形にしてある。
 */
export function formatAverage(average: number): string {
  const value = displayAverage(average);
  if (value >= 1) return '1.000';
  return `.${String(Math.round(value * 1000)).padStart(3, '0')}`;
}

/** 防御率の表記（2.85）。10点台の投手でも桁が増えるだけで崩れない */
export function formatEra(era: number): string {
  return era.toFixed(2);
}

/** 能力値バーの目盛りの数（0..1のレーティングをこの数の●で表す） */
export const RATING_TICKS = 5;

/**
 * 0..1 のレーティングを ●○ の目盛りで表す（名鑑の生の数値をそのまま出しても比べにくい）。
 *
 * C-15の先発選択画面が持っていたものを、**采配メニューでも使うのでここへ移した**
 * （フェーズDD-51）。表示の作り方が2か所に分かれていると、同じ能力値が画面ごとに
 * 違う目盛りで出て「どちらが強いのか」を画面をまたいで比べられなくなる
 * （`formatEra`・`formatAverage` を核に置いてあるのと同じ理由）。
 */
export function ratingBar(rating: number): string {
  const filled = Math.max(0, Math.min(RATING_TICKS, Math.round(clamp01(rating) * RATING_TICKS)));
  return '●'.repeat(filled) + '○'.repeat(RATING_TICKS - filled);
}

/** 名前の欄の幅（全角。名鑑は全選手カタカナ4文字以内で揃えてある＝B-12の約束） */
export const NAME_COLUMN_WIDTH = 4;

/**
 * 名前を名鑑の幅に揃える（表で能力値の桁が縦に揃う条件）。**先発選択画面の打順表と
 * 采配メニューの継投の表が同じ幅を使う**ので、画面をまたいでも列の位置が変わらない。
 */
export function padName(name: string): string {
  return name + '　'.repeat(Math.max(0, NAME_COLUMN_WIDTH - name.length));
}

// ---- 打者の能力値の列（フェーズEE-52。采配メニューの代打と、打順の表で共有する） ----
//
// DD-51 が投手側でやったこと（**画面に出る列と、判断の材料が同じ1か所から出る**）の対で、
// 打者側は D-18 以来「1行の文章」（`ヤマオカ R AV.244 HR3 ゼッコーチョー ...`）のままだった
// ＝行ごとに長さが違うので、**縦に並べても列で比べられない**。ここを継投の表（DD-51）と
// 同じ「セルの並び」に畳む。
//
// **AV/HR は数値のまま**（ユーザー判断）：原作の名鑑（説明書p26-29）とHUDの打者カードが
// この表記で、`displayAverage`/`displayHomeRuns` という導出も既にある＝バーに直すと
// .312 と .298 が同じ目盛りに丸まって**情報が落ちる**うえ、同じ選手が画面ごとに違う
// 物差しで出ることになる（DD-51が揃えたのと逆をやることになる）。
//
// **走力（RUN）だけはバー**：こちらは表示用の導出を持たない（原作の名鑑にも数値表記が
// 無い）ので、**新しい表示用の数値を作らずに済む** `ratingBar` に載せる。
// D-18 は「4項目並べると1行が長くなる」ので走力を出さなかったが、表に畳めば列が1つ
// 増えるだけで済む。**RUNは試合中に数字がどこにも出ない唯一の能力値**だった
// （AV/HRは打者カード、ERAは投手カード、STMはゲージ、球速・変化量・制球はDD-51の継投）。
//
// なお **CPUの代打の判断（X-45）は AV＋HR の合計だけを見る**（`CPU_PINCH_HIT_GAP`＝0.80 は
// その合計で測った値）。走力はそこには入っていない＝**人間はCPUより1列多く見て決める**
// ことになるが、代打はそのまま走者になるので「打つ力で選ぶか、足で選ぶか」は人間の
// 取り分として残す（F-26-8の温存・U-42の切りどころと同じ切り分け）。

/** 打率の欄の幅（`.312`）。列を縦に揃える条件なので、書式を変えるならここも一緒に動かす */
const AVG_COLUMN_WIDTH = 4;
/** 本塁打数の欄の幅（`28`／`3`） */
const HR_COLUMN_WIDTH = 2;

/**
 * 打者の能力値の列の見出し（値のセルとまったく同じ幅で持つ＝見出しと値が縦に揃う）。
 * 打率＝`.312`（半角4）・本（本塁打数）＝`28`（半角2）・走力＝バー10目盛りぶん（全角5）。
 */
export const BATTER_STAT_HEADERS = ['打率', '本', '走力　　　'] as const;

/**
 * 打者1人ぶんの能力値のセル（打率・本塁打数・走力）。**スキルと好調は呼び出し側が
 * `effectiveBatting` を通して渡す**ので、ここは書式だけを受け持つ。
 */
export function batterStatCells(stats: BatterStats): string[] {
  return [
    formatAverage(stats.average).padEnd(AVG_COLUMN_WIDTH),
    String(displayHomeRuns(stats.power)).padStart(HR_COLUMN_WIDTH),
    ratingBar(stats.run),
  ];
}

/**
 * 打順の表で投手の行に出す防御率の欄（打者のAV+HRの2列とまったく同じ幅）。
 * 揃えておかないと**投手の行だけ走力のバーが横にずれる**（比べるための表示にならない）。
 */
export function eraStatCell(era: number): string {
  // 「防」＝防御率（全角1文字＝半角2つぶん）。打率＋本の2列ぶん（半角7）に収める
  return `防${formatEra(era)}`.padEnd(AVG_COLUMN_WIDTH + HR_COLUMN_WIDTH);
}

/**
 * その打席で実際に立つ打席の左右を決める（フェーズB-9）。
 *
 * R/L はそのまま。**S（両打ち）は相手投手と逆の打席に立つ**（実際の野球と同じ。
 * 変化球が自分から遠ざかる側＝打ちやすい側を選ぶ）。説明書のARM表記のうち
 * S（サイドスロー）・U（アンダースロー）は**腕の左右ではなく投げ方**なので、
 * 左右が分からない＝右投手として扱う（実際にもサイド/アンダーは右投げが多数派）。
 *
 * 打席が変わるたび・継投のたびに呼ぶ想定の純粋関数（状態は持たない）。
 */
export function effectiveBattingHand(bats: Handedness, pitcherThrows: ThrowArm): 'R' | 'L' {
  if (bats !== 'S') return bats;
  return pitcherThrows === 'L' ? 'R' : 'L';
}

/**
 * 名鑑のARM → 投球腕（フェーズCC-50。`pitch.ts` の `PitchArm`）。
 *
 * **`effectiveBattingHand` とまったく同じ読み方**をここでも使う＝S（サイドスロー）・
 * U（アンダースロー）は**腕の左右ではなく投げ方**なので、腕の側は右として扱う
 * （B-9の取り決めをそのまま延長する。両打ちの打席と投球腕の側が食い違わない）。
 * 4値に差が付くのは**腕の角度（スロット）**のほうで、そこからリリースの横のずれと
 * 描く腕の傾きが同時に決まる（`armReleaseOffsetX`）。
 *
 * この関数が `roster.ts` にあるのは、`pitch.ts` を名鑑の語彙（`ThrowArm`）から
 * 切り離しておくため（B-9で `Handedness` → `BatterSide` の変換を外に置いたのと同じ形）。
 */
export function pitchArmOf(throws: ThrowArm): PitchArm {
  if (throws === 'L') return { side: LEFT_ARM_SIDE, slot: 'over' };
  if (throws === 'S') return { side: RIGHT_ARM_SIDE, slot: 'side' };
  if (throws === 'U') return { side: RIGHT_ARM_SIDE, slot: 'under' };
  return { side: RIGHT_ARM_SIDE, slot: 'over' };
}

/**
 * その守備位置の選手が**送球するときの腕**（フェーズHH-55）。
 *
 * **ARM を持っているのは投手だけ**（原作の名鑑＝説明書p26-29に野手の投球腕の項目は無い）
 * なので、**マウンドの1人だけが実データで投げ、残り8人は右の上手で揃う**。データの無い
 * ものを推測で散らさない、というのは `teams.ts` に無い値を作らない既存の約束と同じ扱い
 * （実際の野球でも野手の大半は右投げなので、既定が嘘にもならない）。
 *
 * **引くのは `positions.P`**（B-10の「真実は `positions` の側」）＝**継投すれば送球の腕も
 * 一緒に替わる**（`roster.pitcher` から引くと、派生ビューを写し取ったぶんだけ食い違う
 * 経路が増える）。CC-50 ででっかいモードの投球姿勢が ARM で鏡像になったので、これが
 * 無いと**左投げの投手が投手ゴロだけ右で投げる**という食い違いを HH-55 が新しく作る。
 */
export function fielderThrowArm(roster: TeamRoster, position: FieldingPosition): PitchArm {
  if (position !== 'P') return NEUTRAL_PITCH_ARM;
  const pitching = roster.players[roster.positions.P]?.pitching;
  return pitching === undefined ? NEUTRAL_PITCH_ARM : pitchArmOf(pitching.throws);
}

export interface Player {
  id: PlayerId;
  /** 名鑑の選手名（カタカナ4文字以内。HUDのカード・采配メニューにそのまま出る） */
  name: string;
  /** 打撃能力。投手も打席に立つ前提で全選手が持つ */
  batting: BatterStats;
  /** 投球能力。投手（先発・ブルペン）だけが持つ */
  pitching?: PitcherStats;
}

export interface TeamRoster {
  /**
   * この球団の名鑑（フェーズB-12）。**球団名・略称の唯一の出どころ**で、スコアボードの
   * 略称も勝敗表示の球団名もここから引く（名前を別フィールドに写し取ると、選手だけ
   * 差し替わって球団名が前のまま、といった食い違いが起きうる）。中身は不変のデータで、
   * 試合中に変化する状態（打順・交代・投球数）は下のフィールドが持つ。
   */
  team: TeamData;
  players: Record<PlayerId, Player>;
  /** 9人の打順（スロットは固定、中身の PlayerId が代打で入れ替わる） */
  lineup: PlayerId[];
  /** 現在の打順インデックス（0-8） */
  lineupIndex: number;
  /**
   * 守備位置ごとの選手（フェーズB-10）。**9つの守備位置は常にすべて埋まっている**のが
   * この構造の不変条件で、交代（代打・継投）はこの写像を壊さないように書かれている。
   *
   * 通常は **打順9人 ＝ 守備9人**（同じ9人の別の見方）。原作にDH制は無く、投手も打順に
   * 立つため、9スロット全部がちょうど9つの守備位置に対応する。唯一の例外が「投手の打順に
   * 代打を送った直後」で、その打席のあいだだけ打順側に代打が、守備側に自動継投した
   * 新投手が入って一時的にずれる（`substituteBatterAt` / `advanceBatter` のコメント参照）。
   *
   * **守備能力の項目は原作（説明書p26-29）に無い**ので、誰がどこを守るかは走塁・打撃の
   * 能力値には影響しない。この写像が効くのは「代打で入った選手がどの守備位置を引き継ぐか」
   * と「投手が打順のどこに立つか」＝采配の帰結のほうで、ちっちゃいモードの野手の挙動は
   * 従来どおり選手の識別に依存しない。
   */
  positions: Record<FieldingPosition, PlayerId>;
  /**
   * 投手が入っている打順スロット（0-8。既定は9番＝8で、試合前の打順入替＝
   * フェーズC-15の `RosterPlan.order` で別の打順にも置ける）。
   *
   * `positions.P` と対で「投手は打順のどこを打つか」を表す。**代打で一時的に打順側だけが
   * 別の選手になる**ため、投手の打順スロットは `lineup` から探すのではなくこの値で覚える
   * （探す方式だと、代打が入った瞬間に「投手の打順」が行方不明になる）。
   */
  pitcherSlot: number;
  /** 代打要員（控え野手）。先頭から順に起用する */
  bench: PlayerId[];
  /**
   * 現在の投手。**`positions.P` から導出される派生ビュー**で、真実は `positions` の側にある
   * （B-8で `bases` を `baseRunners` の派生ビューにしたのと同じ整理）。両方を書くのは
   * 必ず `withPitcher` を通し、守備位置と投手が食い違うことが構造的に起きないようにする。
   */
  pitcher: PlayerId;
  /** 救援投手（ブルペン）。先頭から順に起用する */
  bullpen: PlayerId[];
  /**
   * 投手ごとの投球数（フェーズB-11）。**スタミナ消耗の唯一の真実**で、残りスタミナ・
   * 疲労はここから導出する（staminaRemaining / fatigueFromRemaining）。
   *
   * まだ1球も投げていない投手はキーを持たない（`pitchCountOf` が 0 として読む）。
   * 降板した投手のぶんも消さずに残す：一度マウンドを降りた投手は再登板できないので
   * 実害はなく、「誰が何球投げたか」という試合の履歴をロスター側で失わないため。
   */
  pitchCounts: Record<PlayerId, number>;
  /**
   * 選手ごとに付与されたローグライトのスキル（フェーズF-26-1。CLAUDE.md ⑧）。
   * **`pitchCounts` と同じ「試合中に変化する状態」の棚**で、名鑑（`teams.ts`）の側には
   * 一切書き込まない＝同じ球団を選び直せば必ず素の能力値から始まる。
   *
   * まだ何も持っていない選手はキーを持たない（`skillsOf` が空配列として読む）。
   * **スキルは打順ではなく選手に付いて回る**ので、代打・継投でスキル持ちを退かせるかが
   * そのまま采配になる（B-10の「代打は守備位置を引き継ぐ」と同じ整理）。
   *
   * 試合をまたぐラン化（F-26-6）で持ち越すのはこのフィールドだけで済む。
   */
  skills: Record<PlayerId, readonly SkillId[]>;
  /**
   * 消費型スキルを使った回数（フェーズF-26-8）。**残り回数はここからの導出**
   * （`chargesLeftOf`）で、「残り」という数字を別に持たない＝B-11で投球数から残りスタミナを、
   * F-26-2で撃った数から残弾を導出したのと同じ整理。
   *
   * まだ使っていない札はキーを持たない（`skillUsesOf` が 0 として読む）。
   * **`skills` の側は使い切っても消さない**（取った履歴として残す）＝同じ札を引き直して
   * 無限に補充することが起きない。いま効いているかは `liveSkillsOf` が導出する。
   *
   * 回数は**ラン全体**（`RUN_GAMES` 試合を通して使い切り）なので、`skills` と一緒に
   * 次の試合へ持ち越す（`withCarriedSkills`）。試合ごとに回復させると持ち続けるコストが
   * 消えて、「温存する／しない」という判断そのものが無くなる。
   */
  skillUses: Record<PlayerId, Partial<Record<SkillId, number>>>;
  /**
   * **いま切ってある一時効果**（フェーズM-33。`duration: 'atBat'` の札）。
   *
   * ここまでの状態（投球数・撃った数・使った回数）はすべて「積み上がる記録」で、
   * 効いているかどうかはそこからの導出だった。一時効果だけは**「この打席で切った」という
   * 出来事そのもの**が真実で、導出できる元が無い（好調がシードから決まるのとは違い、
   * プレイヤーが押した瞬間にしか存在しない情報）。だから状態として持つ。
   *
   * **消えるのは打席が終わるとき1か所だけ**（`gameMachine` の `advanceLineup` が
   * 両チームぶん `clearActiveEffects` を通す）＝「1打席だけ」という寿命の定義と、
   * 実際に消える場所が同じ1つの出来事になっている。だから
   * 「打席が終わったのに効果が残る」が構造的に起きない。
   *
   * **試合をまたいでは持ち越さない**（`withCarriedSkills` は `skills` と `skillUses` だけを
   * 運ぶ）＝新しい試合は必ず「何も切っていない」状態から始まる。残り回数のほうは
   * ラン全体で使い切りなので `skillUses` 側が持ち越す。
   */
  activeEffects: Record<PlayerId, readonly SkillId[]>;
  /**
   * 投手ごとの銃の発射数（フェーズF-26-2）。**残弾はここから導出する**
   * （`gunRemainingOf`）＝B-11で投球数から残りスタミナを導出したのと同じ整理で、
   * 「残弾」という別の数字を持たないので表示と実際が食い違わない。
   *
   * まだ撃っていない投手はキーを持たない（`gunShotsOf` が 0 として読む）。
   * **投球数（`pitchCounts`）とは別の棚**にしてある：銃はリリースの経路を通らず、
   * 実際の野球でも投球数に数えないため（B-11の「けん制球・銃は数えない」）。
   */
  gunShots: Record<PlayerId, number>;
  /**
   * この試合の絶好調選手（フェーズD-19。説明書p16「バットをクルクル回している打者」）。
   * **`skills` と同じ「試合中に変化しない試合固有の状態」の棚**で、名鑑（`teams.ts`）には
   * 一切書き込まない＝同じ球団を選び直しても、シードが変われば別の選手が好調になる。
   *
   * 中身はシードから決まる（`withHotBatters`）。**打順ではなく選手に付く**ので、
   * 代打・継投で好調の選手を退かせるかがそのまま采配になる（スキルと同じ整理）。
   *
   * ラッキー7（7回の攻撃は全員好調）はここには入らない＝**イニングから導出される**
   * 派生の好調で、状態としては持たない（`isHotBatter` に inning を渡して判定する。
   * 持つと「7回が終わったのに好調が残る」といった食い違いが起きうる）。
   */
  hot: readonly PlayerId[];
  /** 乱闘敗北等で永久退場した選手のID一覧（表示・履歴用） */
  ejected: PlayerId[];
  /**
   * **この試合で一度だけ効く札を使ったか**（フェーズYY-73。`予備タンク`・`不死鳥` の給油）。
   * 試合ごとに仕切り直す（新しい試合のロスターは空から始まる）。省略＝まだ何も使っていない。
   */
  skillProcs?: Record<PlayerId, readonly SkillId[]>;
}

const LINEUP_SIZE = 9;
/**
 * 控え野手・ブルペンの人数。**名鑑（teams.ts）が全球団この人数で書かれていること**を
 * `tests/teams.test.ts` が固定する（ここで切り詰めたり水増ししたりはしない＝
 * 名鑑に書いた選手が黙って消えることがない）。
 */
export const BENCH_SIZE = 3;
export const BULLPEN_SIZE = 5;
/** 投手陣の人数（先発1＋ブルペン5＝6人）。原作（説明書p8）の人数に合わせてある */
export const PITCHING_STAFF_SIZE = BULLPEN_SIZE + 1;
/**
 * 名鑑の投手6人のうち先発型として書かれている人数（上から4人）。原作の
 * 「上4人が先発型・下2人がリリーフ型」（説明書p8）。**型そのものはSTMから
 * 導出される**（`pitcherRole`）ので、これは名鑑の並びの約束を表す定数。
 */
export const STARTER_TYPE_COUNT = 4;

// ---- 試合前の采配（フェーズC-15。説明書p8-9の「せんぱつピッチャー」「だじゅん」） ----
//
// 原作は試合前に**先発投手を6人から選び**、**先発オーダーの打順を入れ替え**られる。
// どちらも「名鑑のどの選手をどこに置くか」の指定でしかないので、`TeamRoster` に
// 可変の状態として持たせず、**ロスターを組むときの引数（`RosterPlan`）として渡す**。
// こうしておくと打順・守備位置・投手の対応関係を作る場所が `createTeamRoster` 1か所に
// 保たれ、「打順を入れ替えたのに守備位置が付いてこない」といった食い違いが起きない。

/**
 * 打順スロットの中身を指す番号のうち、**投手**を表す値。0..7 は名鑑の野手8人
 * （`TeamData.lineup` の添字）を指す。原作にDH制は無く投手も打順に入るので、
 * 打順9スロットの出どころは「野手8人＋投手1人」のちょうど9通りになる。
 */
export const PITCHER_ORDER_SLOT = LINEUP_SIZE - 1;

/** 試合前に決める打順と先発投手（フェーズC-15） */
export interface RosterPlan {
  /** 先発投手＝名鑑 `TeamData.pitchers` の添字。選ばれなかった5人がブルペンに入る */
  starterIndex: number;
  /**
   * 打順1番から9番の並び。各要素は「そのスロットに入る選手」を表す番号で、
   * 0..7＝名鑑の野手、`PITCHER_ORDER_SLOT`＝投手（`starterIndex` の投手）。
   * 0..8 の**順列でなければならない**（同じ選手を2度打たせない・誰も外さない）。
   */
  order: readonly number[];
}

/** 名鑑の並びをそのまま使う既定の采配（先頭の投手が先発／打順は名鑑どおり・9番が投手） */
export const DEFAULT_ROSTER_PLAN: RosterPlan = {
  starterIndex: 0,
  order: Array.from({ length: LINEUP_SIZE }, (_, i) => i),
};

/** 0..8 の順列か（打順の並びとして成立しているか） */
function isValidOrder(order: readonly number[] | undefined): order is readonly number[] {
  if (!order || order.length !== LINEUP_SIZE) return false;
  return new Set(order).size === LINEUP_SIZE && order.every((v) => Number.isInteger(v) && v >= 0 && v < LINEUP_SIZE);
}

/**
 * 采配の指定を検証して、成立しないものは既定へ落とす。**壊れた指定でロスターを
 * 組ませない**ための関所で、`createTeamRoster` が必ずここを通す（UI側のバグや
 * 保存データの取り違えが「打順に同じ選手が2人いる」といった壊れ方に化けないように）。
 * 先発と打順は独立に判定する＝片方だけ壊れていてももう片方は活かす。
 */
export function normalizeRosterPlan(
  plan: Partial<RosterPlan> | undefined,
  staffSize: number,
): RosterPlan {
  const starterIndex =
    plan?.starterIndex !== undefined &&
    Number.isInteger(plan.starterIndex) &&
    plan.starterIndex >= 0 &&
    plan.starterIndex < staffSize
      ? plan.starterIndex
      : DEFAULT_ROSTER_PLAN.starterIndex;
  return {
    starterIndex,
    order: isValidOrder(plan?.order) ? [...plan.order] : [...DEFAULT_ROSTER_PLAN.order],
  };
}

// ---- CPUの試合前の采配（フェーズR-39） ----
//
// C-15以来「試合前の采配が付くのは人間側だけ＝CPU側は名鑑どおり」だった
// （1P PLAY の相手は毎試合かならず名鑑の先頭の投手が先発する）。R-39はそのうち
// **先発だけ**をCPUにも決めさせる。
//
// **打順は名鑑どおりのまま**にしてある。これは手抜きではなく計測の結論で
// （`npm run balance:lineup` の4段目）、**名鑑（B-12）が既に定石順で手書きされている**
// ため、能力値から組み直すとかえって得点期待が下がる（16球団平均で 3.675 →
// AV+HR降順 3.647）。局所探索で見つかる最良でも +0.068＝**1試合で1.8%**しか動かず、
// 打順を触ることに値打ちが無いことがはっきりした（I-29が `TIMING_SWEET_BAND` を、
// O-35が「F＝緩急の幅」を計測で棄却したのと同じ扱い）。

/**
 * CPUの先発投手（フェーズR-39）。**先発型4人を試合ごとに順に回す**（ローテーション）。
 *
 * 名鑑の投手は上4人が先発型（`STARTER_TYPE_COUNT`。説明書p8）で、C-15はそこに
 * 球速・変化量・スタミナのどれかで 0.2 以上の差を付けることを名鑑の約束にしてある
 * ＝**回すこと自体が「試合ごとに相手の持ち味が変わる」ことになる**。それまでは
 * どの試合でも必ず `pitchers[0]` が投げていたので、ランの5試合で人間が浴びる球は
 * 相手球団が変わっても常に「その球団の先頭の投手」1人ぶんだった。
 *
 * 規則は決定的で読める（⑧のCPUの原則）＝**何試合目かを見れば相手の先発が分かる**。
 * 5試合のランなら 1→2→3→4→1 の順に当たる。
 */
export function cpuStarterIndex(game: number): number {
  const n = Math.max(1, Math.floor(game));
  return (n - 1) % STARTER_TYPE_COUNT;
}

/**
 * CPUの試合前の采配（先発＋打順）。**打順は名鑑どおり**（上のコメントの計測の結論）。
 * `MATCH_SETUP` の `plans` にそのまま渡せる形で返す。
 */
export function cpuRosterPlan(game: number): RosterPlan {
  return { starterIndex: cpuStarterIndex(game), order: [...DEFAULT_ROSTER_PLAN.order] };
}

/**
 * 投手陣の `index` 人目（名鑑 `TeamData.pitchers` の並び）の選手ID。
 *
 * **IDは名鑑の並び順から作る**（C-15）ので、先発を替えても打順を入れ替えても同じ選手は
 * 同じID＝走者・投球数・退場・疲れの記録が采配でずれない。`createTeamRoster` と、
 * 組んだロスターから名鑑の並び順で投手を引きたい側（V-43の持ち越し・EE-52の選択画面）の
 * **両方がここを通る**ので、規約が2か所に書かれることがない。
 */
export function staffPlayerId(teamId: TeamId, index: number): PlayerId {
  return `${teamId}-p${index + 1}`;
}

/**
 * 打順の2スロットを入れ替える（原作の「選手を選んでA→入れたい打順を選んでA」）。
 * 範囲外なら元の並びをそのまま返す（何も起きない＝任意采配の既存の防御方針どおり）。
 */
export function swapBattingOrder(
  order: readonly number[],
  a: number,
  b: number,
): readonly number[] {
  if (a < 0 || b < 0 || a >= order.length || b >= order.length || a === b) return order;
  const next = [...order];
  next[a] = order[b];
  next[b] = order[a];
  return next;
}

/**
 * 投手を差し替える唯一の入口（`positions.P` と派生ビュー `pitcher` を必ず同時に書く）。
 * 片方だけ書ける経路を残すと「マウンドにいる選手」と「Pを守っている選手」が食い違いうる。
 */
function withPitcher(roster: TeamRoster, pitcher: PlayerId): TeamRoster {
  return { ...roster, positions: { ...roster.positions, P: pitcher }, pitcher };
}

/**
 * 名鑑（`teams.ts` の `TeamData`）から試合用のロスターを組む（フェーズB-12）。
 *
 * **能力値と名前はすべて名鑑の側にあり、ここは構造を組むだけ**：野手8人を守備位置と
 * 1対1で結び、先発投手を打順に入れ（原作にDH制は無い）、控え・ブルペンを先頭から
 * 使う順に並べる。以前はここに仮の能力値テーブルを直接持っていたが、16球団ぶんの
 * データが入った時点で「データ」と「構造」を分ける必要が出たため分離した。
 *
 * 第2引数の `plan`（フェーズC-15）が試合前の采配＝**どの投手が先発か**と
 * **打順の並び**を決める。省略すれば名鑑どおり（先頭の投手が先発・9番が投手）なので、
 * 采配を指定しない呼び出しはC-15の前とまったく同じロスターになる。
 *
 * 選手IDは**名鑑での並び順から作る**ので、先発を替えても打順を入れ替えても**同じ選手は
 * 同じID**になる（走者・投球数・退場の記録はすべてIDで引くため、采配で番号がずれると
 * 記録の指す先が変わってしまう）。球団IDを前置するので、同姓の選手が別の球団にいても
 * 識別は衝突しない。
 */
export function createTeamRoster(team: TeamData, plan?: Partial<RosterPlan>): TeamRoster {
  const players: Record<PlayerId, Player> = {};
  const makePlayer = (
    id: PlayerId,
    name: string,
    batting: BatterStats,
    pitching?: PitcherStats,
  ): PlayerId => {
    players[id] = pitching ? { id, name, batting, pitching } : { id, name, batting };
    return id;
  };

  const { starterIndex, order } = normalizeRosterPlan(plan, team.pitchers.length);

  // 野手8人。守備位置は行の1列目で決まる（**打順をどう並べ替えても守備位置は選手に
  // 付いて回る**＝打順入替は打つ順番だけを変える采配になる）。
  const fielders: PlayerId[] = [];
  const positions = {} as Record<FieldingPosition, PlayerId>;
  for (const [i, row] of team.lineup.entries()) {
    const [position, name] = row as FielderRow;
    const id = makePlayer(`${team.id}-b${i + 1}`, name, fielderRowStats(row));
    fielders.push(id);
    positions[position] = id;
  }
  const bench: PlayerId[] = [];
  for (const [i, row] of team.bench.entries()) {
    const [name] = row as BenchRow;
    bench.push(makePlayer(`${team.id}-h${i + 1}`, name, benchRowStats(row)));
  }
  // 投手は6人ぶんすべて `players` に載せる（マウンドに立つのは1人でも、ブルペンの
  // 面々は采配メニューに能力値付きで並ぶため）。IDは名鑑の並び順から作る。
  const staff = team.pitchers.map((row, i) =>
    makePlayer(staffPlayerId(team.id, i), row[0], pitcherRowBatting(row), pitcherRowPitching(row)),
  );
  const pitcher = staff[starterIndex];
  positions.P = pitcher;
  // 選ばれなかった投手がブルペン。名鑑の並び（先発型→リリーフ型）は保つので、
  // 強制退場時の自動継投（先頭から起用）は「残っている中でいちばん先発寄り」を選ぶ。
  const bullpen = staff.filter((_, i) => i !== starterIndex);

  // 打順は指定された並びのとおりに組む（投手のスロットもここで決まる＝原作どおり
  // 投手を何番に置くかも采配のうち）。
  const lineup = order.map((slot) => (slot === PITCHER_ORDER_SLOT ? pitcher : fielders[slot]));

  return {
    team,
    players,
    lineup,
    lineupIndex: 0,
    positions,
    pitcherSlot: order.indexOf(PITCHER_ORDER_SLOT),
    bench,
    pitcher,
    bullpen,
    pitchCounts: {},
    skills: {},
    skillUses: {},
    activeEffects: {},
    gunShots: {},
    // 好調者はシードを知っている側（gameMachine）が `withHotBatters` で後から載せる。
    // ここで空にしておくことで、**ロスターを組むだけの呼び出し（テスト・選択画面の
    // プレビュー）はD-19の前とまったく同じロスターになる**。
    hot: [],
    ejected: [],
  };
}

// ---- 好調（ゼッコーチョー。フェーズD-19。説明書p16-17） ----

/**
 * この試合の絶好調選手を決めて載せる（シードから決まるので再現可能）。
 *
 * 候補は**打線9人＋控え3人**（`hot` のコメント参照）。ブルペンの投手を外してあるのは、
 * 打席に立つ機会がほぼ無く**引き当てても何も起きない札**になるため（⑧で「条件付きの
 * 補正は死に札になるので抽選プールに置かない」としたのと同じ理由）。打線に入っている
 * 先発投手は原作どおり打順に立つので候補に含める。
 *
 * 呼ぶのはロスターを組み直す場所（`MATCH_SETUP` と初期コンテキスト）だけ＝**1試合に
 * 一度しか決まらない**。試合の途中で呼ばれても同じシードなら同じ結果になるが、
 * 交代で候補が変わると結果が変わりうるので、呼び出し点は増やさない。
 */
export function withHotBatters(roster: TeamRoster, seed: RngState, side: TeamSide): TeamRoster {
  return { ...roster, hot: pickHotBatters(seed, [...roster.lineup, ...roster.bench], side) };
}

/**
 * その打者が今この瞬間 好調か（絶好調選手か、ラッキー7の攻撃か）。
 *
 * **イニングを渡さなければラッキー7は効かない**（`isLuckyInning`）。渡すのは試合の
 * 文脈を持っている呼び出し＝打席・表示・采配メニューで、走者の走力のように
 * 好調が効かない読み出しは渡さなくてよい（`HOT_MODIFIER` に RUN が無いため）。
 */
export function isHot(roster: TeamRoster, playerId: PlayerId, inning?: number): boolean {
  return isHotBatter(roster.hot, playerId, inning);
}

// ---- ローグライトのスキル（フェーズF-26-1。CLAUDE.md ⑧） ----
//
// **能力値への効き方は「レーティングへの補正」1本に絞ってある**（`skills.ts` の
// `StatModifier`）。スキル専用の係数を判定側に持ち込まないので、打球初速も走者速度も
// スタミナの限界球数も、そしてHUDに出る打率・本塁打数・残量ゲージも、**すべて従来の
// 導出経路をそのまま通って一緒に動く**（⑥の「表示はレーティングからの導出」）。
// 「.320 と出ているのに打球は非力」が起きないのと同じ理由で、「キンニクを付けたのに
// カードの本塁打数が変わらない」も構造的に起きない。

/** その選手が**取ったことのある**スキル（使い切った消費型も含む。まだ何も無ければ空配列） */
export function skillsOf(roster: TeamRoster, playerId: PlayerId): readonly SkillId[] {
  return roster.skills[playerId] ?? [];
}

// ---- 消費型（フェーズF-26-8。CLAUDE.md ⑧「消費型スキル」） ----
//
// **真実は「使った数」の側**（`skillUses`）に置き、残り回数・生きているかどうかはすべて
// そこからの導出にする。B-11（投球数→残りスタミナ）・F-26-2（撃った数→残弾）・
// D-18（レーティング→打率表示）と同じ整理で、**表示と実際が食い違いようがない**形。

/** その選手がその札を使った回数 */
export function skillUsesOf(roster: TeamRoster, playerId: PlayerId, skillId: SkillId): number {
  return roster.skillUses[playerId]?.[skillId] ?? 0;
}

/**
 * その札の残りチャージ（消費型でなければ 0）。**強化デュオを取れば総チャージが増える**
 * ので、ここも一緒に増える（`chargeTotalOf`）＝温存の報酬が残り回数として直に見える。
 */
export function chargesLeftOf(roster: TeamRoster, playerId: PlayerId, skillId: SkillId): number {
  if (!isConsumable(skillId)) return 0;
  const owned = skillsOf(roster, playerId);
  // **取っていない札のチャージは常に0**。ここを見落とすと「消費型の札は誰でも
  // 持っているのと同じ」になり、`ヨビジュウ` を引いていない投手にも弾が増える
  // （テストが捕まえた＝残弾が3ではなく4になった）。
  if (!owned.includes(skillId)) return 0;
  return Math.max(0, chargeTotalOf(owned, skillId) - skillUsesOf(roster, playerId, skillId));
}

/** 使い切った消費型か（常設の札は決して使い切らない） */
export function isSpent(roster: TeamRoster, playerId: PlayerId, skillId: SkillId): boolean {
  return isConsumable(skillId) && chargesLeftOf(roster, playerId, skillId) <= 0;
}

/**
 * **いま効いているスキル**（使い切った消費型を除いたもの）。効果・枠・デュオの前提・
 * 動詞の解禁はすべてこちらを見る＝**使い切った札は枠を返し、効果も止まり、強化デュオの
 * 候補からも外れる**という3つが、この1つの導出から同時に成り立つ。
 */
export function liveSkillsOf(roster: TeamRoster, playerId: PlayerId): readonly SkillId[] {
  const owned = skillsOf(roster, playerId);
  return owned.some((id) => isSpent(roster, playerId, id))
    ? owned.filter((id) => !isSpent(roster, playerId, id))
    : owned;
}

/** その選手がその札を**いま使えるか**（使い切った消費型は持っていないのと同じ） */
export function hasSkill(roster: TeamRoster, playerId: PlayerId, skillId: SkillId): boolean {
  return liveSkillsOf(roster, playerId).includes(skillId);
}

// ---- 一時効果（フェーズM-33。CLAUDE.md ⑧「一時効果」） ----
//
// **判定側には新しい経路を1つも作らない**のがこの節の要点。`duration` は効果の種類ではなく
// 「効く長さ」なので、**いま効いている札の一覧を絞り込む（`effectiveSkillsOf`）だけ**で、
// 打球初速もHUDのカードも捕球半径も従来の導出経路のまま動く。

/** その選手がいま切ってある一時効果（宣言順） */
export function activeEffectsOf(roster: TeamRoster, playerId: PlayerId): readonly SkillId[] {
  return roster.activeEffects[playerId] ?? [];
}

/**
 * **いま実際に効いている札**（フェーズM-33）。`liveSkillsOf`（使い切っていない札）から、
 * **まだ切っていない一時効果だけを外す**。
 *
 * 効果を読むところ（`effectiveBatting` / `effectivePitching` / `effectivePlay` /
 * `brawlLoadoutOf`）はすべてこれを通るので、**一時効果がどの形の効果を持っていても
 * 自動的に正しく効く**（パラメータ系なら打球初速とHUDの数字が、プレー定数系なら捕球半径が、
 * 切った瞬間だけ動く）。
 *
 * 枠・デュオの前提・重複は従来どおり `liveSkillsOf` / `skillsOf` の側で見る＝
 * **切っていない一時効果も枠は占める**（持っているだけで場所を取る、という F-26-8 の
 * 「温存には対価がある」がそのまま効く）。
 */
export function effectiveSkillsOf(roster: TeamRoster, playerId: PlayerId): readonly SkillId[] {
  const live = liveSkillsOf(roster, playerId);
  if (!live.some((id) => isTemporary(id))) return live;
  const active = activeEffectsOf(roster, playerId);
  return live.filter((id) => !isTemporary(id) || active.includes(id));
}

/**
 * その選手がその役割で**いま切れる一時効果**（無ければ null）。
 *
 * - 残りチャージがある札だけ（使い切った札は `liveSkillsOf` から消えている）
 * - **すでに切ってある札は選ばない**（同じ打席で二重に払わせない）
 * - 複数あれば**宣言順の先頭**（`temporariesForRole`）＝決定的
 *
 * **HUDのヒントもこの1つの関数から出す**ので、「Gと出ているのに何も起きない」
 * （あるいはその逆）が構造的に起きない（H-28で `ヒットエンドラン!` のヒントと
 * 実際に効く窓を同じ条件から出したのと同じ整理）。
 */
export function activatableEffect(
  roster: TeamRoster,
  playerId: PlayerId,
  role: EffectRole,
): SkillId | null {
  const live = liveSkillsOf(roster, playerId);
  const active = activeEffectsOf(roster, playerId);
  for (const id of temporariesForRole(role)) {
    if (live.includes(id) && !active.includes(id)) return id;
  }
  return null;
}

/** その選手がその役割の一時効果を切っている最中か（HUDの「効いている」表示） */
export function hasActiveEffect(
  roster: TeamRoster,
  playerId: PlayerId,
  role: EffectRole,
): boolean {
  return activeEffectsOf(roster, playerId).some((id) => effectRole(id) === role);
}

/**
 * 一時効果を切る唯一の入口。**チャージを1つ払い、その打席のあいだ効くものとして記録する**。
 * 切れない指定（持っていない・使い切った・すでに切ってある）なら **roster を一切変更しない**
 * （`grantSkill`・`useSkillCharge` と同じ防御方針）。
 *
 * 支払いは既存の `useSkillCharge` をそのまま通すので、**残り回数・枠の返却・強化デュオが
 * 候補から消えることは、F-26-8 の仕組みが何も足さずにそのまま面倒を見る**。
 */
export function activateEffect(
  roster: TeamRoster,
  playerId: PlayerId,
  role: EffectRole,
): { roster: TeamRoster; skillId: SkillId | null } {
  const skillId = activatableEffect(roster, playerId, role);
  if (skillId === null) return { roster, skillId: null };
  const paid = useSkillCharge(roster, playerId, skillId);
  if (!paid.ok) return { roster, skillId: null };
  return {
    roster: {
      ...paid.roster,
      activeEffects: {
        ...paid.roster.activeEffects,
        [playerId]: [...activeEffectsOf(paid.roster, playerId), skillId],
      },
    },
    skillId,
  };
}

/**
 * 切ってある一時効果を全部落とす＝**打席が終わった**（フェーズM-33）。
 *
 * 呼ぶのは `gameMachine` の `advanceLineup` だけ（打席が終わる唯一の場所）。
 * **何も切っていなければ同じ参照を返す**ので、毎打席の交代で無駄なコピーが起きない。
 */
export function clearActiveEffects(roster: TeamRoster): TeamRoster {
  for (const _ in roster.activeEffects) return { ...roster, activeEffects: {} };
  return roster;
}

/** 空き枠があるか（デュオは枠上限の例外なのでこの判定を通らない。`canGrantTo` 参照） */
export function hasSkillRoom(roster: TeamRoster, playerId: PlayerId): boolean {
  return liveSkillsOf(roster, playerId).length < MAX_SKILLS_PER_PLAYER;
}

/**
 * 消費型のチャージを1つ使う。**使い切っていれば roster を一切変更しない**
 * （任意采配・`grantSkill` と同じ防御方針）。
 */
export function useSkillCharge(
  roster: TeamRoster,
  playerId: PlayerId,
  skillId: SkillId,
): { roster: TeamRoster; ok: boolean } {
  if (chargesLeftOf(roster, playerId, skillId) <= 0) return { roster, ok: false };
  return {
    roster: {
      ...roster,
      skillUses: {
        ...roster.skillUses,
        [playerId]: {
          ...roster.skillUses[playerId],
          [skillId]: skillUsesOf(roster, playerId, skillId) + 1,
        },
      },
    },
    ok: true,
  };
}

/**
 * その選手がその**動詞**（バイク・ドロップキック・銃）を使えるか。常設の札を持っているか、
 * 代用する消費型（`CONSUMABLE_VERB`）にチャージが残っていれば使える。
 *
 * **問い合わせる側はスキルの名前を1つしか知らない**（「バイクに乗れるか」）ので、
 * 消費型を足しても `chicchaiScene.ts` や `main.ts` の分岐は増えない。
 */
export function canUseVerb(roster: TeamRoster, playerId: PlayerId, verb: SkillId): boolean {
  if (hasSkill(roster, playerId, verb)) return true;
  return consumablesForVerb(verb).some((id) => chargesLeftOf(roster, playerId, id) > 0);
}

/**
 * その動詞を使ったことを記録する。**常設の札を持っていればチャージは減らない**
 * ＝消費型はあくまで「持っていない人の代用」で、両方持てば実質そのまま常設になる。
 * 使える消費型が複数あれば `CONSUMABLE_VERB` の宣言順に使う（決定的）。
 */
export function useVerb(roster: TeamRoster, playerId: PlayerId, verb: SkillId): TeamRoster {
  if (hasSkill(roster, playerId, verb)) return roster;
  return useVerbCharge(roster, playerId, verb);
}

/**
 * **常設を持っているかを見ずに**チャージだけを1つ使う。
 *
 * 使うのは銃（`recordGunShot`）だけ：銃の常設 `ジュウ` は「1試合3発」という**それ自体が
 * 有限の弾**なので、`useVerb` の「常設を持っていれば減らさない」という近道が当たらない
 * （撃ち切った `ジュウ` 持ちの投手は、次の1発をチャージから撃つ）。どちらの弾から撃つかの
 * 判断は `recordGunShot` が済ませてからここへ来る。
 */
export function useVerbCharge(roster: TeamRoster, playerId: PlayerId, verb: SkillId): TeamRoster {
  for (const id of consumablesForVerb(verb)) {
    if (chargesLeftOf(roster, playerId, id) > 0) return useSkillCharge(roster, playerId, id).roster;
  }
  return roster;
}

/**
 * 抽選・UIが使う `SkillHolder` 形へ落とす。**並び順が候補の並び順になる**ので、
 * 「打順1番→9番 → ブルペン → 控え」という読める順序で固定する（CPUの選択規則が
 * 「付けられる選手のうち先頭」なので、この順序がそのままCPUの振る舞いになる）。
 *
 * 永久退場した選手は除く（もう出場しないので、付けても効かない＝死に札になる）。
 * `lineup` に投手が入っているので投手が重複しないよう Set で畳む。
 */
export function skillHoldersOf(roster: TeamRoster): SkillHolder[] {
  const ordered = [...roster.lineup, roster.pitcher, ...roster.bullpen, ...roster.bench];
  const seen = new Set<PlayerId>();
  const holders: SkillHolder[] = [];
  for (const id of ordered) {
    if (seen.has(id) || roster.ejected.includes(id)) continue;
    seen.add(id);
    const player = roster.players[id];
    if (!player) continue;
    holders.push({
      id,
      canPitch: player.pitching !== undefined,
      // **枠とデュオの前提は「生きている札」で、重複の判定は「取った札」で**（F-26-8）。
      skills: liveSkillsOf(roster, id),
      owned: skillsOf(roster, id),
    });
  }
  return holders;
}

/** その選手にそのスキルを付けられるか（枠・重複・対象・デュオの前提。判定は `skills.ts`） */
export function canGrantTo(roster: TeamRoster, playerId: PlayerId, skillId: SkillId): boolean {
  const player = roster.players[playerId];
  if (!player || roster.ejected.includes(playerId)) return false;
  return canGrant(
    {
      id: playerId,
      canPitch: player.pitching !== undefined,
      skills: liveSkillsOf(roster, playerId),
      owned: skillsOf(roster, playerId),
    },
    skillId,
  );
}

/**
 * スキルを付ける唯一の入口。付けられない指定（枠が埋まっている・対象外・重複・デュオの
 * 前提が揃っていない）なら **roster を一切変更しない**（任意采配の既存の防御方針どおり）。
 */
export function grantSkill(
  roster: TeamRoster,
  playerId: PlayerId,
  skillId: SkillId,
): { roster: TeamRoster; ok: boolean } {
  if (!canGrantTo(roster, playerId, skillId)) return { roster, ok: false };
  return {
    roster: {
      ...roster,
      skills: { ...roster.skills, [playerId]: [...skillsOf(roster, playerId), skillId] },
    },
    ok: true,
  };
}

/**
 * 前の試合から持ち越したスキルを載せる（フェーズF-26-6。ランの持ち越し）。
 *
 * **必ず `grantSkill` を通す**ので、枠上限・対象（投手専用）・デュオの前提という
 * 不変条件は持ち越しでも保たれる＝壊れた指定（枠を超えた保存データ、退場した選手のID、
 * 前提の揃っていないデュオ）は**黙って落ちる**だけでロスターは壊れない
 * （C-15の `normalizeRosterPlan` が壊れた采配を既定へ落とすのと同じ関所の考え方）。
 *
 * 1人ぶんは**取った順のまま**適用する：デュオは前提2つが先に載っていないと付かないので、
 * 順番を並べ替えると持ち越しでデュオだけが消える。
 */
export function withCarriedSkills(
  roster: TeamRoster,
  carried: Record<PlayerId, readonly SkillId[]>,
  uses: Record<PlayerId, Partial<Record<SkillId, number>>> = {},
): TeamRoster {
  let next = roster;
  for (const playerId of Object.keys(carried)) {
    for (const skillId of carried[playerId]) {
      next = grantSkill(next, playerId, skillId).roster;
    }
  }
  // **消費型の使った回数も一緒に持ち越す**（F-26-8。回数はラン全体で使い切り）。
  // 載せるのは実際に持ち越せた札のぶんだけ＝落ちた指定の使用回数が宙に浮かない
  // （持ち越しが `grantSkill` という関所を必ず通るのと同じ考え方）。
  for (const playerId of Object.keys(uses)) {
    const live = skillsOf(next, playerId);
    for (const skillId of Object.keys(uses[playerId] ?? {}) as SkillId[]) {
      const count = uses[playerId]?.[skillId] ?? 0;
      if (count <= 0 || !live.includes(skillId)) continue;
      next = {
        ...next,
        skillUses: {
          ...next.skillUses,
          [playerId]: { ...next.skillUses[playerId], [skillId]: count },
        },
      };
    }
  }
  return next;
}

/**
 * 前の試合から持ち越した疲れを載せる（フェーズV-43。ランの持ち越し）。
 *
 * **持ち越すのは残量でも疲労でもなく「投球数」**（B-11の「真実は投球数の側」を試合の外へ
 * そのまま延長した形）。載せる先も従来の `pitchCounts` なので、**残量ゲージ・球威の低下・
 * 采配メニューの残量%・CPUの自動継投（J-30）は1行も触らずに、最初から減った状態で動く**。
 *
 * `withCarriedSkills` と同じ**関所**：壊れた指定（投手でない選手のID・存在しないID・
 * 負の球数）は黙って落ちるだけでロスターは壊れない。
 */
export function withCarriedFatigue(
  roster: TeamRoster,
  carried: Record<PlayerId, number>,
): TeamRoster {
  const pitchCounts: Record<PlayerId, number> = { ...roster.pitchCounts };
  for (const playerId of Object.keys(carried)) {
    const count = carried[playerId];
    if (!Number.isFinite(count) || count <= 0) continue;
    // 投球能力を持つ選手だけ（＝実際にマウンドに立ちうる選手）に載せる
    if (!roster.players[playerId]?.pitching) continue;
    pitchCounts[playerId] = count;
  }
  return { ...roster, pitchCounts };
}

/**
 * レーティング1項目に補正を乗せる。**必ず 0..1 にクランプする**ので、重ねがけしても
 * 上限を超えた分は素直に頭打ちになる（`skills.ts` の補正が足し算なのはこのため）。
 * 補正の指定が無ければ元の値をそのまま返す。
 *
 * **打席の左右（bats）・投球腕（throws）には補正を持たせていない**：レーティングではなく
 * 列挙値で、0..1 のクランプという枠に収まらないため。これらを動かすスキル
 * （`ニトウリュウ` 等。F-26-5）を入れるときは別の形が要る。
 */
function rated(base: number, delta: number | undefined): number {
  return delta === undefined ? base : clamp01(base + delta);
}

/**
 * 2つの補正を1つにまとめる（スキル＋好調。フェーズD-19）。**どちらも指定が無ければ
 * undefined のまま返す**ので、`rated` の「補正が無ければ元の値をそのまま返す」性質が
 * 保たれる（0 を足す形にすると、範囲外の値が黙ってクランプされるようになってしまう）。
 */
function sumDelta(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

/**
 * スキルの補正を乗せた打撃能力（**派生ビュー。名鑑の値は書き換えない**）。
 * 打球初速・走者速度・HUDの表示は、すべて素の `player.batting` ではなくこちらを読む。
 *
 * 第3引数の `inning`（フェーズD-19）は**好調の判定に要る試合の文脈**。渡すと
 * ラッキー7（7回の攻撃は全員好調）まで含めて解決される。**渡さなければ絶好調選手の
 * ぶんだけが乗る**ので、イニングを知らない呼び出し（走者の走力・単体テスト）は
 * 従来どおりのまま使える（B-9で `BatterSide` の既定を右打者にしたのと同じ整理）。
 *
 * 好調はスキルと同じ「レーティングへの補正」なので、**足し算の順番も同じ扱い**で
 * 単に重ねる（`rated` が 0..1 にクランプする）＝スキルで長打力を上げた打者が
 * ラッキー7を迎えても上限を超えて伸び続けることはない。
 */
export function effectiveBatting(
  roster: TeamRoster,
  playerId: PlayerId,
  inning?: number,
  /**
   * 自分のチームが負けているか（フェーズYY-73。`火事場の力` の条件）。省略＝負けていない
   * ＝条件付きの札は乗らない（采配の比較・名鑑の表のように場面の無い読み出しは素の値）。
   */
  trailing = false,
): BatterStats {
  const base = roster.players[playerId].batting;
  // **使い切った消費型の効果は止まる**（F-26-8）＝`テツゲタ` の射程も枠も一緒に返る。
  // **切っていない一時効果も乗らない**（M-33）＝どちらも `effectiveSkillsOf` の絞り込み1つ。
  // **条件付きの札は条件が揃ったときだけ乗る**（YY-73）。
  const skills = effectiveSkillsOf(roster, playerId).filter(
    (id) => SKILLS[id]?.when !== 'trailing' || trailing,
  );
  const mod = combinedModifier(skills);
  const hot = isHot(roster, playerId, inning) ? HOT_MODIFIER : {};
  return {
    bats: base.bats,
    average: rated(base.average, sumDelta(mod.average, hot.average)),
    power: rated(base.power, sumDelta(mod.power, hot.power)),
    run: rated(base.run, mod.run),
  };
}

/**
 * スキルの補正を乗せた投球能力（投球能力を持たない選手なら undefined）。
 * **スタミナもここを通る**ので、`タフネス` は限界球数・残量ゲージ・先発型/リリーフ型の
 * 判定（`pitcherRole`）まで一度に動かす＝表示と実際の持ち球数が食い違わない。
 */
export function effectivePitching(
  roster: TeamRoster,
  playerId: PlayerId,
): PitcherStats | undefined {
  const base = roster.players[playerId]?.pitching;
  if (!base) return undefined;
  const mod = combinedModifier(effectiveSkillsOf(roster, playerId));
  return {
    throws: base.throws,
    // **ERA はレーティングではなく実数値**（⑥）なので、制球の補正だけは 0..1 ではなく
    // ERA そのものへ書き戻す（フェーズW-44。ユーザー判断）＝**HUDの投手カードの防御率が
    // 実際に動く**ので、「.表示は名鑑のままなのに隅を突いてくる」食い違いが起きない。
    // 補正が無ければ名鑑の値そのまま＝W-44の前と完全に同じ。
    era: eraWithControl(base.era, mod.control ?? 0),
    speed: rated(base.speed, mod.speed),
    breakRight: rated(base.breakRight, mod.breakRight),
    breakLeft: rated(base.breakLeft, mod.breakLeft),
    fork: rated(base.fork, mod.fork),
    stamina: rated(base.stamina, mod.stamina),
  };
}

/**
 * その投手の**制球の上乗せ**（名鑑のERAからの差。フェーズW-44）。
 * **人間が投げるときのコース入力の効き幅**（`pitch.ts` の `courseReleaseVxFor`）だけが読む。
 *
 * 素の制球（名鑑のERA）ではなく**差**を返すのが要点で、これが T-41 のユーザー判断
 * 「人間の投球は今までどおり狙ったところへ行く」をそのまま保つ＝**スキルを持たない投手は
 * 必ず 0＝従来と同じ操作感**になる（名鑑のERAで人間の投球の手触りが変わることはない）。
 *
 * 差は**ERAの側から取る**ので `pitcherControl` のクランプ（0..1）を通らない＝
 * 名鑑最小のERA1.95（既に制球1.0でクランプ済み）の投手でも、補正を積んだぶんだけ
 * ちゃんと効く（`eraWithControl` が真実の側を動かしているからこう書ける）。
 */
export function controlBonusOf(roster: TeamRoster, playerId: PlayerId): number {
  const base = roster.players[playerId]?.pitching;
  if (!base) return 0;
  const eff = effectivePitching(roster, playerId);
  if (!eff) return 0;
  return (base.era - eff.era) / CONTROL_ERA_SPAN;
}

/**
 * その選手のプレー定数への補正（フェーズF-26-5。捕球半径・盗塁のスタート位置など）。
 *
 * **`effectiveBatting`/`effectivePitching` と同じ「派生ビュー」**で、名鑑にも `TeamRoster` にも
 * 実数値としては持たない。値を要る側（ちっちゃいモードの守備・走塁、銃の残弾）は、
 * 素の定数にここが返す差分を足して使う＝**スキルを持たない選手では必ず素の定数**になる。
 *
 * 未知のIDや存在しない選手でも空の補正を返すので、呼び出し側でガードが要らない。
 */
export function effectivePlay(roster: TeamRoster, playerId: PlayerId): PlayModifier {
  return combinedPlay(effectiveSkillsOf(roster, playerId));
}

/** その選手の乱闘の装備（体力・威力・出せる技）。乱闘シーンはこれだけを受け取る */
export function brawlLoadoutOf(roster: TeamRoster, playerId: PlayerId): FighterLoadout {
  return brawlLoadoutFor(effectiveSkillsOf(roster, playerId));
}

// ---- スタミナの読み出し・記録（フェーズB-11） ----

/** その投手がこの試合で投げた球数（まだ投げていなければ0） */
export function pitchCountOf(roster: TeamRoster, playerId: PlayerId): number {
  return roster.pitchCounts[playerId] ?? 0;
}

/**
 * その投手の残りスタミナ 1（無傷）→ 0（限界）。投球能力を持たない選手（＝本来
 * マウンドに立たない選手）は基準値のスタミナとして扱い、読み出しで止まらないようにする。
 */
export function remainingStaminaOf(roster: TeamRoster, playerId: PlayerId): number {
  // スキルの補正込みで読む（フェーズF-26-1）。`タフネス` は STM への補正として表されているので、
  // 限界球数・残量ゲージ・先発型/リリーフ型の導出が一度に動く＝表示と実際が食い違わない。
  const stats = effectivePitching(roster, playerId);
  return staminaRemaining(pitchCountOf(roster, playerId), stats?.stamina ?? NEUTRAL_STAMINA);
}

/** その投手の球威の落ち具合 0（影響なし）→ 1（限界） */
export function fatigueOf(roster: TeamRoster, playerId: PlayerId): number {
  return fatigueFromRemaining(remainingStaminaOf(roster, playerId));
}

/**
 * その投手の**いまの質**（フェーズZ-47。`pitcherQuality` にロスターの値を渡すだけ）。
 *
 * **スキルの補正込みで読む**（`effectivePitching`）ので、⑧の札で球速・変化量・制球が
 * 動いた投手はそのぶん質も動く＝**HUDの投手カードに出ている数字（ERA）と、CPUが
 * 継投で見ている質が同じ出どころ**になる（`remainingStaminaOf` が `タフネス` 込みの
 * 残量を返すのと同じ整理）。
 */
export function pitcherQualityOf(roster: TeamRoster, playerId: PlayerId): number {
  const stuff = pitcherStuffOf(roster, playerId);
  return stuff.speed + stuff.breaking + stuff.control;
}

/**
 * その投手の**いまの球の中身**（フェーズDD-51。`pitcherStuff` にロスターの値を渡すだけ）。
 *
 * 采配メニューの継投がこれを3本のバーで出す＝**CPUが `pitcherQualityOf` で比べているのと
 * 同じ値**（上の合計はこの3つの和）。`effectivePitching` を通すので、⑧の札で球速・変化量・
 * 制球（＝ERA）が動いた投手はバーも一緒に動く。
 */
export function pitcherStuffOf(roster: TeamRoster, playerId: PlayerId): PitcherStuff {
  return pitcherStuff(effectivePitching(roster, playerId), fatigueOf(roster, playerId));
}

/**
 * 画面に出す「ワンバウンドするフォークを持つ」の印（フェーズBBB-79）。HUDの投手カード・
 * 采配メニューの継投・先発を選ぶ画面が**同じ文言**を使う＝画面をまたいでも同じものを指す。
 */
export const BOUNCING_FORK_LABEL = '落ちるフォーク';

/**
 * その投手のフォークは**いま**ワンバウンドするか（フェーズBBB-79）。Fの大きい投手だけで、
 * **疲れて変化量が落ちれば落ちなくなる**（B-11の `fatiguedBreak` を通した値で決まる）。
 *
 * 実際に投げる球（main.ts の `currentPitchProfile` → `releasePitchFlight`）と**同じ式**
 * ＝画面の印と、実際に跳ねるかどうかが食い違わない。見逃せばボールになる球なので、
 * 打つ側にも投げる側にも要る材料（既存の「意思決定材料は隠さない」方針）。
 */
export function pitcherForkBounces(stats: PitcherStats | undefined, fatigue: number): boolean {
  return stats !== undefined && forkBounces(fatiguedBreak(stats.fork, fatigue));
}

/** ロスターの値で引く `pitcherForkBounces`（スキル込みの F・いまの疲労） */
export function pitcherForkBouncesOf(roster: TeamRoster, playerId: PlayerId): boolean {
  return pitcherForkBounces(effectivePitching(roster, playerId), fatigueOf(roster, playerId));
}

/**
 * 1球投げるたびに呼ぶ（リリースの瞬間＝1リリース1球）。今マウンドにいる投手の
 * 投球数だけを増やす。けん制球・銃はここを通らない（実際の野球でも投球数に数えない）。
 */
export function recordPitch(roster: TeamRoster): TeamRoster {
  const next: TeamRoster = {
    ...roster,
    pitchCounts: {
      ...roster.pitchCounts,
      [roster.pitcher]: pitchCountOf(roster, roster.pitcher) + 1,
    },
  };
  return applyRefill(next, roster.pitcher);
}

/**
 * **一度だけの給油**（フェーズYY-73。`予備タンク`・`不死鳥`）。残りスタミナが球威の落ちる
 * 境目（`STAMINA_FRESH_THRESHOLD`）を切った瞬間に、札の球数ぶん投球数を巻き戻す
 * （0 より下へは戻さない＝満タンを超えない）。**1試合に1札1回**。
 *
 * 給油したかどうかは `skillProcs` に残る＝main.ts はそこを見て炎と音を出す
 * （判定側は「いつ給油したか」を知らせない。投球数の真実は相変わらず `pitchCounts` だけ）。
 */
export function applyRefill(roster: TeamRoster, playerId: PlayerId): TeamRoster {
  if (remainingStaminaOf(roster, playerId) >= STAMINA_FRESH_THRESHOLD) return roster;
  const used = roster.skillProcs?.[playerId] ?? [];
  const skill = effectiveSkillsOf(roster, playerId).find(
    (id) => (SKILLS[id]?.refill ?? 0) > 0 && !used.includes(id),
  );
  if (!skill) return roster;
  const pitches = SKILLS[skill].refill ?? 0;
  return {
    ...roster,
    pitchCounts: {
      ...roster.pitchCounts,
      [playerId]: Math.max(0, pitchCountOf(roster, playerId) - pitches),
    },
    skillProcs: { ...(roster.skillProcs ?? {}), [playerId]: [...used, skill] },
  };
}

/** その選手がこの試合で使った一度きりの札（給油など） */
export function skillProcsOf(roster: TeamRoster, playerId: PlayerId): readonly SkillId[] {
  return roster.skillProcs?.[playerId] ?? [];
}

// ---- 銃の残弾（フェーズF-26-2。CLAUDE.md ③＋⑧） ----
//
// 銃はスキル `ジュウ` に吸収されたので、**撃てるのはそれを取った投手だけ**になった。
// 残弾はチーム共有ではなく**投手個人**（ユーザー判断。理由は `GUN_SHOTS_PER_PITCHER`）で、
// 状態として持つのは「撃った数」だけ＝残弾はそこからの導出。スタミナ（B-11）と同じ形。

/** その投手がこの試合で撃った弾数（まだ撃っていなければ0） */
export function gunShotsOf(roster: TeamRoster, playerId: PlayerId): number {
  return roster.gunShots[playerId] ?? 0;
}

/**
 * その投手の残弾。**`ジュウ` を持っていない投手は常に0**＝スキルを引かなかった試合に
 * 銃は存在しない。持っているかどうかを別に問い合わせなくても、この1つの数字で
 * 「撃てるか」が決まる（HUDの表示だけは「0発の銃持ち」と「銃無し」を区別したいので
 * `hasSkill` を併せて見る）。
 */
export function gunRemainingOf(roster: TeamRoster, playerId: PlayerId): number {
  // 消費型 `ヨビジュウ`（F-26-8）の残チャージも残弾に数える。**弾は常設のぶんから先に
  // 使う**（`recordGunShot`）ので、両方持っている投手では 3発＋チャージ という順に減る。
  const spare = consumablesForVerb('ju').reduce(
    (sum, id) => sum + chargesLeftOf(roster, playerId, id),
    0,
  );
  if (!hasSkill(roster, playerId, 'ju')) return spare;
  // デュオ `ホーミングダン`（F-26-5）は弾数そのものを増やす。**残弾ではなく持ち弾のほうを
  // 動かす**ので、すでに撃った数はそのまま残る＝「撃ってから取ったら残弾が満タンに戻る」
  // といった巻き戻りが起きない（真実は「撃った数」の側、というB-11以来の整理）。
  const total = GUN_SHOTS_PER_PITCHER + (effectivePlay(roster, playerId).gunShots ?? 0);
  return Math.max(0, total - gunShotsOf(roster, playerId)) + spare;
}

/**
 * 今マウンドにいる投手が撃てるか。**銃モードへ入れるかの唯一の条件**で、人間の G キーも
 * CPUの銃AIも gameMachine の `GUN_USED` のガードも、すべてここを通る
 * （B-10で投手の書き込みを `withPitcher` 1本に絞ったのと同じ「入口を1つにする」整理）。
 */
export function canShootGun(roster: TeamRoster): boolean {
  return gunRemainingOf(roster, roster.pitcher) > 0;
}

/**
 * 1発撃つたびに呼ぶ（今マウンドにいる投手の発射数だけを増やす。`recordPitch` と同じ形）。
 * **投球数には数えない**ので、銃を撃ってもスタミナは減らない（実際の投球ではないため）。
 */
export function recordGunShot(roster: TeamRoster): TeamRoster {
  const pitcher = roster.pitcher;
  // **常設の弾から先に撃つ**（F-26-8）＝`ジュウ` を持たない投手（`ヨビジュウ` だけ）や
  // 常設を撃ち切った投手のときにだけチャージが減る。判定の順序をここ1か所に閉じてあるので、
  // 撃つ側（人間の G キー・CPUの銃AI・`GUN_USED` のガード）はどちらの弾かを知らない。
  const permanent = hasSkill(roster, pitcher, 'ju')
    ? GUN_SHOTS_PER_PITCHER +
      (effectivePlay(roster, pitcher).gunShots ?? 0) -
      gunShotsOf(roster, pitcher)
    : 0;
  if (permanent <= 0) return useVerbCharge(roster, pitcher, 'ju');
  return {
    ...roster,
    gunShots: {
      ...roster.gunShots,
      [pitcher]: gunShotsOf(roster, pitcher) + 1,
    },
  };
}

/**
 * 守備位置の表示名（ブラッシュアップ：文字）。**内部の記号（CF・SS…）はデータと判定の約束の
 * まま**で、画面に出すときだけ日本語にする。カードは2文字（中堅）、表は1文字（中）。
 */
export const POSITION_LABEL: Record<FieldingPosition, string> = {
  P: '投手',
  C: '捕手',
  '1B': '一塁',
  '2B': '二塁',
  '3B': '三塁',
  SS: '遊撃',
  LF: '左翼',
  CF: '中堅',
  RF: '右翼',
};

/** 表の列に入れる1文字の守備位置（全角1文字＝半角の `CF` と同じ幅） */
export const POSITION_SHORT: Record<FieldingPosition, string> = {
  P: '投',
  C: '捕',
  '1B': '一',
  '2B': '二',
  '3B': '三',
  SS: '遊',
  LF: '左',
  CF: '中',
  RF: '右',
};

export function positionLabel(position: FieldingPosition): string {
  return POSITION_LABEL[position];
}

/** その選手が守っている位置（守備についていない＝代打で入ったばかりの選手なら null） */
export function positionOf(roster: TeamRoster, playerId: PlayerId): FieldingPosition | null {
  for (const position of Object.keys(roster.positions) as FieldingPosition[]) {
    if (roster.positions[position] === playerId) return position;
  }
  return null;
}

/** その守備位置についている選手 */
export function playerAtPosition(roster: TeamRoster, position: FieldingPosition): Player {
  return roster.players[roster.positions[position]];
}

/** 今の打者が守っている位置（投手の打席なら 'P'）。表示・采配メニュー用 */
export function currentBatterPosition(roster: TeamRoster): FieldingPosition | null {
  return positionOf(roster, currentBatterId(roster));
}

/**
 * 今この打席に代打を送れるか。控えがいることに加え、**投手の打席では救援投手も要る**
 * （投手が退けば守備位置Pが空くので、自動継投できないと9守備位置が埋まらなくなる。
 * `substituteBatterAt` のコメント参照）。采配メニューが候補を出すかの判断に使う。
 */
export function canPinchHit(roster: TeamRoster): boolean {
  if (roster.bench.length === 0) return false;
  return !isPitcherAtBat(roster) || roster.bullpen.length > 0;
}

/**
 * 今の打者が投手か（＝代打を送ると自動継投になる打席か。フェーズB-10）。
 * 采配メニューの表示と、**CPUの代打の判断**（`chooseCpuPinchHitter`。フェーズX-45）が
 * 同じ1か所を見る＝人間に見えている「この打席は投手」とCPUの前提が食い違わない。
 */
export function isPitcherAtBat(roster: TeamRoster): boolean {
  return currentBatterId(roster) === roster.pitcher;
}

export function currentBatterId(roster: TeamRoster): PlayerId {
  return roster.lineup[roster.lineupIndex];
}

export function currentBatter(roster: TeamRoster): Player {
  return roster.players[currentBatterId(roster)];
}

/**
 * 次の打者（フェーズQ-38の敬遠の判断・表示に使う）。**`advanceBatter` からの導出**なので、
 * 投手の打順に代打が入ったまま次の打席へ回る場合（B-10）も実際に立つ選手と一致する
 * ＝「歩かせた次に出てくる打者」と表示・判断が食い違わない。
 */
export function nextBatterId(roster: TeamRoster): PlayerId {
  return currentBatterId(advanceBatter(roster));
}

export function currentPitcher(roster: TeamRoster): Player {
  return roster.players[roster.pitcher];
}

/**
 * 打席終了（三振・四死球・打球の決着）ごとに呼ぶ。次の打順へ進める。
 *
 * あわせて「投手の打順に代打が入ったまま」の状態をここで解消する（フェーズB-10）。
 * 代打はその1打席を打つために送られた選手なので、打席が終わった時点で退き、守備位置Pを
 * 守っている現在の投手が打順スロットを引き継ぐ＝実際の野球で「代打のあと、守備につく
 * ときに新しい投手がその打順に入る」のと同じ形になる。**打順と守備位置のずれは1打席で
 * 必ず解消される**ので、この不整合が試合をまたいで積み上がることはない。
 *
 * 代打が出塁していた場合でも走者としてはそのまま走り切る（塁上の走者は `baseRunners` が
 * IDで覚えており、`players` からも消えないため）。ロースターから離れるのは打順だけ。
 */
export function advanceBatter(roster: TeamRoster): TeamRoster {
  const lineupIndex = (roster.lineupIndex + 1) % LINEUP_SIZE;
  const inPitcherSlot = roster.lineup[roster.pitcherSlot];
  if (inPitcherSlot === roster.pitcher) return { ...roster, lineupIndex };
  const lineup = [...roster.lineup];
  lineup[roster.pitcherSlot] = roster.pitcher;
  return {
    ...roster,
    lineup,
    lineupIndex,
    ejected: [...roster.ejected, inPitcherSlot],
  };
}

/** 打順インデックスを明示的に巻き戻す（乱闘決着で「同じ打席が継続」する場合に使う）。 */
export function setLineupIndex(roster: TeamRoster, lineupIndex: number): TeamRoster {
  return { ...roster, lineupIndex };
}

export function hasAvailablePinchHitter(roster: TeamRoster): boolean {
  return roster.bench.length > 0;
}

export function hasAvailableReliever(roster: TeamRoster): boolean {
  return roster.bullpen.length > 0;
}

export interface SubstitutionResult {
  roster: TeamRoster;
  /** 交代が成立したか。false なら控え/ブルペンが尽きている（没収試合の判定材料） */
  ok: boolean;
}

/**
 * 采配メニュー用：控えの指定インデックスから代打を送る。範囲外（控えが尽きている場合を
 * 含む）なら roster を一切変更せず ok: false を返す（呼び出し側の防御的ガード漏れに対する
 * 安全策。UIは候補が無ければそもそもこの関数を呼ばない設計にする）。
 * 指定インデックス以外の控えの並び順は維持する（末尾詰めではなく該当1件だけ抜く）。
 *
 * **代打は退いた選手の守備位置をそのまま引き継ぐ**（フェーズB-10）。9つの守備位置が
 * 常に埋まっているという不変条件は、この引き継ぎで保たれる。
 *
 * 唯一の例外が**投手の打席への代打**で、控えの野手にマウンドを継がせるわけにはいかない。
 * この場合はブルペン先頭を**自動的に継投させて**守備位置Pを埋め、代打は打順スロットだけを
 * 取る（＝その打席のあいだだけ打順9人と守備9人がずれる。`advanceBatter` が打席の終わりに
 * 解消する）。**ブルペンが尽きていれば代打自体を送れない**（守備位置Pを埋められないため。
 * 交代が成立しないので roster は一切変更しない＝任意采配の既存の防御方針どおり）。
 */
export function substituteBatterAt(roster: TeamRoster, benchIndex: number): SubstitutionResult {
  if (benchIndex < 0 || benchIndex >= roster.bench.length) {
    return { roster, ok: false };
  }
  const outgoing = currentBatterId(roster);
  const incoming = roster.bench[benchIndex];
  const bench = roster.bench.filter((_, i) => i !== benchIndex);
  const lineup = [...roster.lineup];
  lineup[roster.lineupIndex] = incoming;
  const ejected = [...roster.ejected, outgoing];

  // 退くのが「今マウンドにいる投手」かどうかで分岐する（打順スロットの比較ではない点に
  // 注意：投手の打順にすでに代打が入っている状態でもう一度代打を送る場合、退くのは
  // 前の代打であって投手ではないので、二重に継投してはいけない）。
  if (outgoing === roster.pitcher) {
    if (roster.bullpen.length === 0) return { roster, ok: false };
    const next = withPitcher(
      { ...roster, lineup, bench, bullpen: roster.bullpen.slice(1), ejected },
      roster.bullpen[0],
    );
    return { roster: next, ok: true };
  }

  const position = positionOf(roster, outgoing);
  const positions = position
    ? { ...roster.positions, [position]: incoming }
    : roster.positions;
  return { roster: { ...roster, lineup, bench, positions, ejected }, ok: true };
}

/**
 * 采配メニュー用：**塁上の走者に代走を送る**（フェーズGG-54）。
 *
 * `substituteBatterAt` とまったく同じ形で、違うのは**退く相手が「今の打者」ではなく
 * 「指定された走者」**という一点だけ（打順スロットも守備位置も、その走者が持っている
 * ものをそのまま引き継ぐ）。**塁の上の入れ替えはここでは行わない**＝走者の識別を持つ
 * `baseRunners` は `gameMachine` の側にあり、そこが真実（B-8の「塁の占有と識別で真実が
 * 二重化しないよう、gameMachine が必ず BaseRunners を先に更新する」）。
 *
 * 3つの相手を同じ1本で扱う：
 *
 * - **打順にも守備位置にもいる普通の走者**＝どちらも代走が引き継ぐ（＝代走はこの後
 *   その打順で打ち、その守備位置を守る）。「誰を出すか」が打撃と守りの決定でもある、
 *   というB-10の性質がそのまま代走にも乗る。
 * - **投手が走者**（ユーザー判断：代打と同じ扱い）＝守備位置Pを空けられないので
 *   **ブルペン先頭を自動継投させる**（`substituteBatterAt` と同じ理由・同じ手当て）。
 *   **ブルペンが尽きていれば代走そのものを送れない**（roster は一切変更しない）。
 *   打順スロットは代走が取り、**打席が終わった時点で `advanceBatter` が現在の投手へ
 *   返す**＝「投手の打順に代打を送った」ときとまったく同じ1打席ぶんのずれで、
 *   専用の後始末を持たない。
 * - **すでに打順から外れている走者**（投手の打順への代打が出塁し、打席が終わって
 *   `advanceBatter` に退けられた選手）＝**塁の上だけの入れ替え**になる。打順にも
 *   守備位置にもいないので触るものが無く、`ejected` にも二重に積まない。
 */
export function substituteRunnerAt(
  roster: TeamRoster,
  runnerId: PlayerId,
  benchIndex: number,
): SubstitutionResult {
  if (benchIndex < 0 || benchIndex >= roster.bench.length) {
    return { roster, ok: false };
  }
  // 実在しない走者（無名の走者 `ANONYMOUS_RUNNER` を含む）は交代できない
  if (roster.players[runnerId] === undefined) {
    return { roster, ok: false };
  }
  const incoming = roster.bench[benchIndex];
  const bench = roster.bench.filter((_, i) => i !== benchIndex);
  // 打順から既に外れている走者は、もう `ejected` に積まれている（二重に積まない）
  const ejected = roster.ejected.includes(runnerId)
    ? roster.ejected
    : [...roster.ejected, runnerId];
  const slot = roster.lineup.indexOf(runnerId);
  const lineup = [...roster.lineup];
  if (slot >= 0) lineup[slot] = incoming;

  if (runnerId === roster.pitcher) {
    if (roster.bullpen.length === 0) return { roster, ok: false };
    const next = withPitcher(
      { ...roster, lineup, bench, bullpen: roster.bullpen.slice(1), ejected },
      roster.bullpen[0],
    );
    return { roster: next, ok: true };
  }

  const position = positionOf(roster, runnerId);
  const positions = position ? { ...roster.positions, [position]: incoming } : roster.positions;
  return { roster: { ...roster, lineup, bench, positions, ejected }, ok: true };
}

/**
 * その走者に代走を送れるか（フェーズGG-54）。控えがいることに加え、**投手が走者のときは
 * 救援投手も要る**（守備位置Pを空けられない＝`canPinchHit` とまったく同じ条件）。
 * 采配メニューが候補を出すかの判断と、CPUの代走（`chooseCpuPinchRunner` の呼び出し側）が
 * 同じ1か所を見る。
 */
export function canPinchRun(roster: TeamRoster, runnerId: PlayerId): boolean {
  if (roster.bench.length === 0) return false;
  if (roster.players[runnerId] === undefined) return false;
  return runnerId !== roster.pitcher || roster.bullpen.length > 0;
}

/**
 * 采配メニュー用：ブルペンの指定インデックスから救援投手を送る。範囲外なら roster を
 * 一切変更せず ok: false を返す（substituteBatterAt と同じ防御方針）。
 *
 * **救援投手は守備位置Pと投手の打順スロットの両方を引き継ぐ**（フェーズB-10）＝原作に
 * DH制が無い以上、継投は打線の中身も入れ替える采配になる。ただし投手の打順に代打が
 * 入っている最中だけは打順に触れない（その打席は代打のものなので。打席が終わった時点で
 * `advanceBatter` が現在の投手を打順へ戻す）。
 */
export function substitutePitcherAt(roster: TeamRoster, bullpenIndex: number): SubstitutionResult {
  if (bullpenIndex < 0 || bullpenIndex >= roster.bullpen.length) {
    return { roster, ok: false };
  }
  const outgoing = roster.pitcher;
  const incoming = roster.bullpen[bullpenIndex];
  const bullpen = roster.bullpen.filter((_, i) => i !== bullpenIndex);
  const lineup = [...roster.lineup];
  if (lineup[roster.pitcherSlot] === outgoing) lineup[roster.pitcherSlot] = incoming;
  const next = withPitcher(
    { ...roster, lineup, bullpen, ejected: [...roster.ejected, outgoing] },
    incoming,
  );
  return { roster: next, ok: true };
}

/**
 * 現在の打者を退場させ、控えの先頭（インデックス0）から代打を送る。乱闘敗北等の
 * 強制退場専用：控えが尽きていても「負けた事実」自体は交代の成否と無関係に確定するため、
 * substituteBatterAt が no-op を返すケースでも outgoing だけは ejected に積んで ok: false
 * を返す（呼び出し側はこれを「出場可能な打者が尽きた」= 没収試合の判定に使う）。
 *
 * **投手が打席で負けた場合は救援投手も要る**（substituteBatterAt が自動継投するため）。
 * ブルペンが尽きていればここも ok: false になり、没収試合として試合が終わる＝その時点で
 * 守備位置Pが埋まらないまま残るが、以降の守備は行われないので実害はない。
 */
export function ejectBatterAndSubstitute(roster: TeamRoster): SubstitutionResult {
  const result = substituteBatterAt(roster, 0);
  if (result.ok) return result;
  return {
    roster: { ...roster, ejected: [...roster.ejected, currentBatterId(roster)] },
    ok: false,
  };
}

/**
 * 現在の投手を退場させ、ブルペンの先頭（インデックス0）から救援投手を送る。
 * ejectBatterAndSubstitute と同じ理由で、ブルペンが尽きていても outgoing は ejected に積む。
 */
export function ejectPitcherAndSubstitute(roster: TeamRoster): SubstitutionResult {
  const result = substitutePitcherAt(roster, 0);
  if (result.ok) return result;
  return {
    roster: { ...roster, ejected: [...roster.ejected, roster.pitcher] },
    ok: false,
  };
}
