/**
 * でっかいモードのCPU打撃AI（純粋ロジックのみ、状態は持たない）。
 * cpuPitcher.ts と対になる、打者側の2P/CPU操作分離の本体（PROGRESS.md「でっかいモードの
 * CPU投球/打撃AI」参照）。
 *
 * 設計方針（乱数は一切使わない）：
 * - CPU打者は毎フレーム「今スイングを押すべきか」を判断するのではなく、着弾（打撃面通過）
 *   までの残り時間が「押してからジャストミートまでの理想時間（SWING_IDEAL_SEC）」と
 *   ちょうど一致するフレームで一度だけ判断する（shouldCpuSwing）。現在のボール速度・
 *   コースを線形外挿して着弾点を予測するので、投手側がその後もカーブを続けている場合は
 *   予測が外れて差し込まれる／泳ぐことがある（＝曲げ球がCPU打者も欺けるという、
 *   人間の打者と同じ駆け引きが自然に成立する。意図した挙動）。
 * - 判断内容：バットが届く範囲外なら見送り。**「甘い球」だけを振る**（ストライクゾーンの
 *   隅の1つ内側）。**2ストライク以降は隅の1つ外まで広げて粘る**（ファウルで凌ぐ＝
 *   三振回避を優先）が、そこから更に外れた球は見送る。
 * - エッジ検出（crossesSwingDecisionPoint）は、既存の contactPlaneCrossing 等と同じ
 *   「前後2フレームの状態から境界越えを検出する」作法に揃えた。
 *
 * ## フェーズSS-67：打席の駆け引きを成立させた
 *
 * QQ-65 が計測で見つけた構造（`ORIGINAL_PARITY.md`）＝**CPU打者は三振も四球もしない**
 * （1打席1.51球で必ず打球になる／見送りは0.00球）と、**フォークが人間の投手の支配戦略**
 * （ど真ん中のフォークが88.2%アウト）を、**新しい定数を1つも増やさずに**埋めた：
 *
 * 1. **罰を緩急の両側へ**（`cpuSwingLead`）＝遅い球には泳ぐ。速球・基準速は完全に不変。
 * 2. **追い込まれたら窓の縁まで泳ぐ**（同上の `twoStrikes`）＝決め球に空振りが生まれる。
 * 3. **振る幅を実際に「甘い球」へ**（`SELECTIVE_HALF_WIDTH` / `TWO_STRIKE_HALF_WIDTH`）
 *    ＝見送りと四球が生まれ、T-41の制球（どれだけ外れるか）に初めて帰結が付く。
 *
 * 実測（`npm run balance:plate`）：三振 0%→**6.3%** / 四球 0%→**6.3%** /
 * 1打席 1.51→**2.20球** / 死球 0% / **40球で終わらない打席 5件→0件**。
 * **判定（`judgeSwing`）には1行も触っていない**ので `npm run balance` は完全に不変で、
 * 人間の打者の手応え（到達範囲・有効窓）も1mmも動いていない。
 */
import { CONTACT_PLANE_Z, SWING_ACTIVE_SEC, SWING_IDEAL_SEC, batReachFor } from './batting';
import type { BatterSide, PitchFlight } from './pitch';
import {
  RIGHT_BATTER_SIDE,
  SPEED_FAST_DELTA,
  SPEED_NEUTRAL,
  SPEED_SLOW_DELTA,
  STRIKE_ZONE_HALF_WIDTH,
  batterFrameX,
  clampStance,
} from './pitch';
import { CORNER_MARGIN as CPU_CORNER_MARGIN } from './cpuPitcher';
import type { Bases, Count } from './rules';

/**
 * 基準速から離れた球に対してCPUがどれだけ早振り（＝タイミングを外して引っ掛け気味）に
 * なるか。実機テストプレイで「守備のときCPUが速球を100%ホームランにする」ことが判明した
 * 対策として入った値。旧実装はCPUが球速によらず常にジャストミート（timing=0）で捉えたため、
 * 初速が最大になる速球が確実にフェンスを越えていた。現実同様「基準からずれた球ほど
 * タイミングが取りづらい」よう、スイング判断のリード（＝押すタイミング）を早める。
 * スイングが早まるとジャストミートより terminal 側で捉える＝引っ張り・詰まりで初速が
 * 落ち、痛烈な当たりでも深いフライ／ゴロ止まりになりHRが激減する（ミートは残るので
 * CPUの攻撃自体は成立し続ける）。スイング経過が理想＋この罰＝有効窓（`SWING_ACTIVE_SEC`）の
 * 中に収まるため、単独では空振りにならず「弱い当たり」になる。
 *
 * **フェーズSS-67で名前を `FAST` から外した**（値は 0.045 のまま＝**新しい定数はゼロ**）：
 * `cpuSwingLead` が緩急の**両側**を見るようになったので、速球専用の値ではなくなった。
 *
 * ## フェーズTT-68：値を有効窓からの導出にした（0.045 → `SWING_ACTIVE_SEC / 3` ＝0.0467）
 *
 * SS-67 が残した宿題（**三振・四球が実際の野球の帯に届いていない**）を埋める2つのてこの
 * うちの打者側。**新しい定数は増えず、むしろマジックナンバーが1つ消えた**＝
 * 2ストライクの罰（`SWING_ACTIVE_SEC / 2`＝窓の縁まで泳ぐ）と**同じ刻みの梯子**になる：
 *
 * | 場面 | 罰 | 意味 |
 * |---|---|---|
 * | 通常 | `SWING_ACTIVE_SEC / 3` | 窓の1/3ぶん早振り＝弱い当たり（空振りにはならない） |
 * | 2ストライク | `SWING_ACTIVE_SEC / 2` | 窓の縁まで泳ぐ＝決め球に空振りが生まれる（SS-67） |
 *
 * **SS-67 が「一律に上げる案」を否定したときの計測は、`foulsInAtBat`（ファウルで隅を
 * 散らす規則）を入れる前のものだった**（＝1打席17球・ファウルの無限打席25%）。
 * `npm run balance:plate` の13段目で測り直すと、**無限ファウルは起きない**（最長6球）。
 *
 * 値は同13段目が決めた（CLAUDE.md「バランス調整の方針」）＝**帯は 0.0455〜0.0472 で、
 * `SWING_ACTIVE_SEC / 3`（0.0467）はそのほぼ中央**。上限の外（0.0475以上）では
 * **CPU打線の本塁打が 0.00本/試合になる**（弱い当たりしか出なくなる）。
 * さらに上（0.050）では**人間がど真ん中へ投げたフォークが100%ファウル**になり、
 * SS-67 が消したばかりの「人間の投手側の支配戦略」が別の形で戻る＝**採用値では
 * 3段目（人間の3択）は SS-67 と完全に同じ**（フォーク 32.6%アウト/67.4%安打）。
 */
export const CPU_TIMING_PENALTY_SEC = SWING_ACTIVE_SEC / 3;

/**
 * 球速に応じたスイング判断リード（**基準速から離れた球ほど早振りになりタイミングを外す**）。
 *
 * ## フェーズSS-67：罰を緩急の両側へ広げた
 *
 * それまで罰は**速球側にしか無かった**（`fastness`）ので、**緩い球はCPU打者に必ず芯で
 * 捉えられていた**（実測：フォークの |timing| は平均 0.117・芯率 87.5%）。打球初速に
 * `0.5 × 球速` が入るぶん当たっても弱いのでほとんどアウトになり、結果として
 * **フォークを投げ続けるのが人間の投手の支配戦略**になっていた（`npm run balance:plate`
 * の3段目で「ど真ん中のフォーク＝88.2%アウト」。QQ-65 が
 * `ORIGINAL_PARITY.md` に「別セッションの規模」として書き残した穴）。
 *
 * 実際の野球で緩急が効くのは**両側**（速い球には差し込まれ、遅い球には泳ぐ）なので、
 * `fastness` を「基準速からの隔たり」（`offness`）に一般化した。**新しい定数は1つも
 * 増えていない**（W-44 が `FATIGUE_CONTROL_LOSS` を `FATIGUE_SPEED_DROP` に、
 * CC-50 が腕のずれを O-36 の可動幅に揃えたのと同じ「既にある値に揃える」やり方）。
 *
 * **基準線は動かない**（B-8以来の約束）：
 * - **基準速（`SPEED_NEUTRAL`）は offness 0＝ジャストミートのまま**
 * - **速球（`SPEED_FAST`）は offness 1＝従来とまったく同じ 0.045**
 * ＝I-29・JJ-57・QQ-65・RR-66 が測った打たれ方の骨格（速球のHR・ファウルの帯）は
 * 1mmも動かない（`tests/balance.test.ts` の速球HRの回帰帯がそのまま通る）。
 * 動くのは**基準速より遅い球だけ**。
 *
 * 幅は上下で違う（`SPEED_FAST_DELTA`=6 / `SPEED_SLOW_DELTA`=14）ので、
 * **どちらの端でも「緩急を目いっぱい使った球」がちょうど罰の最大**になる
 * （＝緩急の幅そのものが投手によらず一定という `speedForPitchSelection` の約束と揃う）。
 */
export function cpuSwingLead(
  pitchSpeed: number,
  twoStrikes = false,
  normalPenalty: number = CPU_TIMING_PENALTY_SEC,
): number {
  const offness =
    pitchSpeed >= SPEED_NEUTRAL
      ? (pitchSpeed - SPEED_NEUTRAL) / SPEED_FAST_DELTA
      : (SPEED_NEUTRAL - pitchSpeed) / SPEED_SLOW_DELTA;
  const penalty = twoStrikes ? SWING_ACTIVE_SEC / 2 : normalPenalty;
  return SWING_IDEAL_SEC + penalty * Math.min(1, Math.max(0, offness));
}

/**
 * 手を出す幅（＝これより外は見送る）＝**「甘い球」の定義そのもの**。
 * **ストライクゾーンの隅の1つ内側**（`ゾーン半幅 - 投手が狙う隅の余裕`）。
 *
 * **フェーズSS-67で 0.15 → `-CPU_CORNER_MARGIN`**（0.60 → **0.40**）。
 * このファイルの冒頭コメントは元から「**『甘い球』だけを振る選球眼**」と書いていたが、
 * **実際の 0.60 は名鑑96人が投げる球をすべて含んでいた**（実測：通常の球は最大 0.382、
 * 決め球でも最大 0.634）＝**CPU打者は1球も見送らず**（実測 見送り 0.00球/打席）、
 * **四球も見逃し三振も構造的に起こりえなかった**。
 *
 * **新しい数値は持ち込まず、`CPU_CORNER_MARGIN`（＝CPU投手が狙う隅の余裕）1刻みで
 * 表した**（W-44 が `COURSE_VX_PER_CONTROL` を「既にある隅に合わせる」で決めたのと
 * 同じやり方）。意味はひと言で言える＝**「投手が狙う隅より内側だけを振る」**。
 *
 * 値は `npm run balance:plate` が決めた（CLAUDE.md「バランス調整の方針」）：
 * ここを 0.40 にすると **三振6.3% / 四球6.3% / 死球0%** と3つが同時に成立する。
 * 1つ広い 0.45（ゾーンいっぱい）では**三振が0%に戻り**、1つ狭い 0.3375 では
 * **死球が2.8%に増える**（見送りが増えて内角の荒れ球が本塁まで届くため）。
 */
export const SELECTIVE_HALF_WIDTH = STRIKE_ZONE_HALF_WIDTH - CPU_CORNER_MARGIN;

/**
 * 2ストライク以降に手を出す幅（＝**追い込まれたら隅まで手を出す**）。
 * **ストライクゾーンの隅の1つ外側**＝`SELECTIVE_HALF_WIDTH` とゾーンを挟んで対称。
 *
 * それまでは `count.strikes >= 2` なら **バットが届く球すべてに手を出す**（＝幅は無限大）
 * だった。「ファウルで凌ぐ＝三振回避を優先」という意図は正しいが、**CPU投手の決め球は
 * 81.3%がボール**（実測）なので、**どんなに外れた球でも必ず追いかける**＝
 * **四球も見逃し三振も構造的に起こりえなかった**（T-41が作った「制球の値打ち＝
 * 見逃し三振」も、CPU打者に対しては一度も成立していなかった）。
 *
 * フェーズSS-67では**「粘る」という意図はそのまま**に、**広がる幅を有限にした**：
 * 追い込まれたら隅まで手を出すが、そこから更に外れた球は見送る。
 * **刻みは `CPU_CORNER_MARGIN` 1つぶん**なので、ここでも新しい数値は持ち込んでいない。
 */
export const TWO_STRIKE_HALF_WIDTH = STRIKE_ZONE_HALF_WIDTH + CPU_CORNER_MARGIN;

/** 打撃面（CONTACT_PLANE_Z）通過までの残り時間。既に通過済み/球速0以下なら Infinity */
export function timeToContactPlane(flight: PitchFlight): number {
  if (flight.vz <= 0) return Infinity;
  return (CONTACT_PLANE_Z - flight.z) / flight.vz;
}

/** 現在の速度で等速直線運動を続けたと仮定した、打撃面通過時のX（線形外挿） */
export function predictCrossX(flight: PitchFlight): number {
  const t = Math.max(0, timeToContactPlane(flight));
  return flight.x + flight.vx * t;
}

/**
 * このステップでスイング判断フレーム（残り時間がしきい値を下回った最初の瞬間）を
 * 通過したか。prev/next は onFlightStep で渡される前後1ステップ分の飛行状態。
 * しきい値は球速に応じて変わる（速球ほど早振りになる。cpuSwingLead 参照）。
 *
 * `normalPenalty` は**計測が定数を書き換えずに罰を振るための引数**（`swingWidths` と
 * 同じ作法。フェーズTT-68）。渡さなければ採用値＝ゲーム本体はこの経路しか通らない。
 */
export function crossesSwingDecisionPoint(
  prev: PitchFlight,
  next: PitchFlight,
  count: Count = { balls: 0, strikes: 0 },
  normalPenalty: number = CPU_TIMING_PENALTY_SEC,
): boolean {
  const lead = cpuSwingLead(prev.vz, count.strikes >= 2, normalPenalty);
  return timeToContactPlane(prev) > lead && timeToContactPlane(next) <= lead;
}

/**
 * 判断フレームで呼ぶ。予測着弾点とカウントから、スイングすべきかを返す。
 * バットが届かない球は常に見送り。2ストライク以降は粘るため際どい球にも手を出し、
 * それ以外は甘い球だけを振る。
 *
 * side（打席の左右。フェーズB-9）は「バットが届くか」の判定にだけ効く（judgeSwing と
 * 同じく打者ローカルで比べる）。選球眼はストライクゾーン基準＝本塁について左右対称なので
 * 打席の左右では変わらない。
 *
 * stance（打席内の立ち位置。フェーズO-36）も同じく**届くかどうか**にだけ効く
 * （`judgeSwing` と同じ `batReachFor` から取るので、「振ると判断したのに届かない」
 * ／「届くのに見送る」がずれない）。選球眼は本塁基準のままで動かさない＝
 * **立ち位置は選球を変える手ではなく、打ちに行くコースを選ぶ手**。
 *
 * widths は**計測が定数を書き換えずに幅を振るための引数**（`cpuControlSpray(control, curve)`
 * と同じ作法）。渡さなければ採用値＝ゲーム本体はこの経路しか通らない。
 */
export function shouldCpuSwing(
  flight: PitchFlight,
  count: Count,
  side: BatterSide = RIGHT_BATTER_SIDE,
  stance = 0,
  widths: { normal?: number; twoStrike?: number } = {},
): boolean {
  const predictedX = predictCrossX(flight);
  const localX = batterFrameX(predictedX, side);
  const reach = batReachFor(stance);
  if (localX < reach.outside || localX > reach.inside) return false;
  const width =
    count.strikes >= 2
      ? widths.twoStrike ?? TWO_STRIKE_HALF_WIDTH
      : widths.normal ?? SELECTIVE_HALF_WIDTH;
  return Math.abs(predictedX) <= width;
}

// ---- 打席内の立ち位置（フェーズO-36。説明書p14） ----

/**
 * CPU打者の立ち位置（決定的・乱数不使用。ユーザー判断：**CPU打者も動く**）。
 *
 * 規則は1つだけ＝**直前の球が通ったコースへ芯を合わせに行く**（`batReachFor` の芯は
 * 立ち位置そのものなので、オフセット＝狙うコースになる）。初球は打席の中央。
 *
 * この規則にした理由は2つ。
 *
 * 1. **人間の投手側に「配球を散らす」という手が生まれる**。PROGRESS.md がセッション9で
 *    「同じ配球を続けると同じ打球になる＝配球を散らすことがCPU打者対策として意味を持つ」と
 *    書き残していた駆け引きが、ここで初めて実際の帰結を持つ（同じコースへ続けて投げると
 *    芯で待たれ、逆へ投げれば詰まる／届かない）。
 * 2. **読める**（桜井ノウハウ「コンピューターが良い目を出すとイカサマしてると思われがち」）。
 *    立ち位置は画面に見えているうえ、次にどこへ寄るかは自分が投げた球で決まる＝
 *    こちらの操作の帰結でしかない。
 *
 * 移動そのものは人間と同じ速さ（`BATTER_STANCE_MOVE_SPEED`）でシーン層が寄せるので、
 * **投げ急げばCPUは寄り切れない**＝人にできない速さでは動かない（F-26-3のバイクの
 * 戻り0.5秒・J-30の乱闘の0.25秒と同じ扱い）。
 *
 * @param lastPitchLocalX この打席で直前に通過した球のコース（打者ローカルX）。null＝初球
 */
export function chooseCpuStance(lastPitchLocalX: number | null): number {
  if (lastPitchLocalX === null) return 0;
  return clampStance(lastPitchLocalX);
}

// ---- 一時効果（フェーズM-33。CLAUDE.md ⑧「一時効果」） ----

/**
 * CPU打者が一時効果（`シニモノグルイ`・`ゼッタイヨチ`）を切るか
 * （決定的・乱数不使用。ユーザー判断：**場面を見て切る**）。
 *
 * **ここだけF-26-8のCPU規則（「使える場面の最初で使う」）から外す。** 常設の動詞
 * （銃・バイク・蹴り）は「使える場面」そのものが限られているので最初に使えばよかったが、
 * 一時効果は**どの打席でも切れる**＝同じ規則をあてはめると **1回表の先頭打者で切って
 * 終わり**になる。一時効果だけは「いつ切るか」が効果の大きさそのものなので、
 * 場面を見る規則が要る（F-26-8のコメントが「他の3系統に広げるなら別の形が要る」と
 * 書き残していた点そのもの）。
 *
 * 規則は1つだけ＝**得点圏（二塁か三塁）に走者がいる打席で切る**。1本で点が入る打席が
 * 「ここぞ」の定義で、**塁の状態を見れば切ってくる打席が事前に読める**（桜井ノウハウ
 * 「コンピューターが良い目を出すとイカサマしてると思われがち」＝規則が読めれば
 * 「そういう規則だから読めたはず」に変わる）。投手側の対処も素直に立つ：
 * 走者を得点圏に置かない、置いたら勝負を避ける。
 *
 * **温存の判断は人間の取り分**（F-26-8と同じ切り分け）＝CPUはこの規則で機械的に払う。
 */
export function shouldCpuActivateBattingEffect(bases: Bases): boolean {
  return bases.second || bases.third;
}

// ---- 代打（フェーズX-45。CLAUDE.md ⑪「CPUの采配」の攻撃側） ----
//
// J-30（自動継投・乱闘）→R-39/S-40（試合前の采配・配球・走塁）→T-41（コース）と
// 埋めてきた「CPUだけが持っていない判断」のうち、**攻撃側の采配だけがまるごと空いて
// いた**：`SUBSTITUTE_BATTER` は人間の采配メニューからしか送られず、**CPUは投手の
// 打席にも代打を出さなかった**（B-11以来の「CPUの采配はスコープ外」の最後の残り）。
//
// **送りバント・スクイズは同じセッションで計測して見送った**（`npm run balance:offense`）。
// この守備モデルでは送球（34m/s）が走者の4.5倍速く、バントは**打球を本塁のすぐ近くに
// 置く手**なので送球距離が最短になる＝どの塁状況・どの走力・どの狙いでも先頭の走者が
// 刺され、得点確率は全域で負ける。J-30が `THROW_SPEED` を据え置きと決めた構造そのもの。

/**
 * CPUが代打を出すのに要る、控えと今の打者の**能力差**（AV＋HRの合計）。
 *
 * `npm run balance:offense` の8段目が決めた＝名鑑16球団×先発型4人の64通りで
 * 差は 0.68〜1.12 に散らばり、**0.80 なら11球団で成立する**（1.00 まで厳しくすると
 * 4球団しか残らず規則が死ぬ＝Q-38が敬遠の能力差 0.20 を決めたのとまったく同じ見方）。
 *
 * この値にすると **B-12が名鑑に持たせた「控えの厚み」に初めて帰結が付く**：
 * 控えが売りのナイツ（差1.10）はよく代打を出し、控えの薄いギャラクシーズ・コメッツ
 * （0.68〜0.72）は出さない＝R-39が走力で、S-40がタッチアップで球団の個性に帰結を
 * 付けたのと同じ形。
 */
export const CPU_PINCH_HIT_GAP = 0.8;

/** 代打の候補（控え1人ぶん）。`index` は `roster.bench` の添字をそのまま渡す */
export interface CpuPinchHitCandidate {
  index: number;
  /** 打率（AV）レーティング。**スキル・好調込み**（`effectiveBatting` を通した値） */
  average: number;
  /** 長打力（HR）レーティング。同上 */
  power: number;
}

/**
 * CPUの代打（決定的・乱数不使用。ユーザー判断：**投手の打席を軸に**）。
 *
 * 規則は3つだけで、打順表と塁の状態を見れば代打が出る打席が事前に読める
 * （桜井ノウハウ「コンピューターが良い目を出すとイカサマしてると思われがち」＝
 * 決定的なら「そういう規則だから読めたはず」になる。`shouldCpuShoot`・
 * `shouldCpuIntentionalWalk` と同じ扱い）：
 *
 * 1. **投手の打席であること**。B-10の「投手の打席に代打を送ると自動で継投する」が
 *    そのまま効くので、**先発を降ろすという代償が構造的に付いている**＝これが
 *    「いつ出すか」を判断にする。人間側から見ると「相手のエースを早く降ろさせる」
 *    という筋が見える。
 * 2. **得点圏（二塁 or 三塁）に走者がいること**。8段目の計測が「利得は得点圏で跳ねる」
 *    と示した（走者なし +4.9pt / 一塁 +5.3pt に対し、二塁 +7.7pt・三塁 +9.5〜+16.7pt）。
 *    **M-33のCPUの一時効果・Q-38の敬遠とまったく同じ「1本で点が入る打席＝ここぞ」**の
 *    定義をそのまま使う（CPUの「ここぞ」の意味を規則ごとにばらけさせない）。
 *    9段目でブルペンの球数を数えたが**イニングのしきい値は要らない**と出た
 *    （容量207球に対し1イニング14〜18球＝1回から投げ切れる）ので、
 *    絞りはこの得点圏の条件1本に置く。
 * 3. **控えが明確に強いこと**（`CPU_PINCH_HIT_GAP`）。
 *
 * 選ぶのは**もっとも強い控え**（AV＋HRの合計が最大、同率なら並び順の先＝
 * `cpuChooseSkill`・`chooseCpuRelief` と同じ畳み方で順序が一意に決まる）。
 * **好調（D-19）とスキル（⑧）は呼び出し側が `effectiveBatting` で読み込んで渡す**ので、
 * **今日あたっている控えが自然に選ばれる**（采配メニューが代打候補に好調の印を出して
 * いるのと同じ材料を、CPUも同じだけ見ていることになる）。
 *
 * @returns 送る控えの添字。出さないなら null
 */
export function chooseCpuPinchHitter(opts: {
  pitcherAtBat: boolean;
  bases: Bases;
  batter: { average: number; power: number };
  bench: readonly CpuPinchHitCandidate[];
  gap?: number;
}): number | null {
  if (!opts.pitcherAtBat) return null;
  if (!opts.bases.second && !opts.bases.third) return null;
  if (opts.bench.length === 0) return null;
  let best = opts.bench[0];
  for (const c of opts.bench.slice(1)) {
    if (c.average + c.power > best.average + best.power) best = c;
  }
  const gap = opts.gap ?? CPU_PINCH_HIT_GAP;
  const current = opts.batter.average + opts.batter.power;
  return best.average + best.power >= current + gap ? best.index : null;
}

// ---- 代走（フェーズGG-54。⑧「CPUも対等」＝代打と同じく攻撃側の采配） ----
//
// **代走は「走力を買って打力を売る」手**（`npm run balance:pinchrun` の10段目）。
// ここを取り違えると規則が必ず損をする：走力だけを見て「いちばん遅い走者をいちばん速い
// 控えに代える」と、**9回に出しても得点期待で -0.058点**（利得＝盗塁が1つ成立する
// +0.112点 に対し、費用＝残り1イニングでも打力の入れ替えが 0.170点）。**代走で入った
// 選手はその打順を引き継いで以後ずっと打つ**（B-10の「代打は退いた選手の守備位置を
// 引き継ぐ」と同じ）ので、費用は打席をまたいで積み上がる。
//
// したがって規則は**買うもの（足）と売るもの（打力）の両方**を見る。

/**
 * 代走で**差し出してよい打力の上限**（AV＋HR の合計の差）。
 *
 * 代走は「走力を買って打力を売る」手なので、**差し出しすぎると残りの試合でその打順が
 * 損をする**（代走で入った選手はその打順を引き継いで以後ずっと打つ）。値は
 * `npm run balance:pinchrun` が「**どのイニングで出しても損しない**」で決めた。
 *
 * **フェーズRR-66で 0.10→0.03**：打撃モデルを作り直した（抗力＋初速の基準＋長打力の幅）
 * ぶん**長打が減り、盗塁1つの利得が 0.112点→0.019点まで下がった**＝差し出せる打力も
 * そのぶん小さくなった。**規則の形は動いていない**（名鑑16球団すべてに「出す値打ちの
 * ある組み合わせ」が残っていることはテストが固定している）。
 */
export const CPU_PINCH_RUN_BAT_LOSS = 0.03;

/** 代走の候補（控え1人ぶん）。`index` は `roster.bench` の添字をそのまま渡す */
export interface CpuPinchRunCandidate {
  index: number;
  /** 打率（AV）レーティング。**スキル込み**（`effectiveBatting` を通した値） */
  average: number;
  /** 長打力（HR）レーティング。同上 */
  power: number;
  /** その控えが走者になったとき、守備に残る余裕（秒）。`cpuStealDefenseSlack` の値 */
  stealSlack: number;
}

/**
 * CPUの代走（決定的・乱数不使用。ユーザー判断：**CPUも代走を出す**）。
 *
 * 規則は3つで、**塁の状態と名鑑を見れば代走が出る場面が事前に読める**
 * （`chooseCpuPinchHitter`・`shouldCpuIntentionalWalk` と同じ扱い）：
 *
 * 1. **いまの一塁走者では盗塁できない**（`cpuStealDefenseSlack` が R-39 のしきい値より
 *    大きい）。
 * 2. **その控えなら盗塁できる**（同じ式で しきい値以下）＝**帯をまたぐ**。
 *    **判定に使うのは R-39 の `CPU_STEAL_MAX_DEFENSE_SLACK_SEC` そのもの**なので、
 *    ここに新しい自由変数は増えない（Z-47が継投の物差しをB-11の読み替えで済ませ、
 *    X-45が余白を `CPU_TAG_UP_MARGIN_SEC` で済ませたのと同じ整理）。
 * 3. **打力をほとんど差し出さない**（`CPU_PINCH_RUN_BAT_LOSS`）。
 *
 * **塁を選ぶ条件を書いていないのに一塁の走者にしか出ない**のが規則2の効き方：
 * 二塁→三塁の盗塁は**走力1.0でも余裕 +0.26秒**（＝どんな俊足でも刺される）ことを
 * R-39 が既に確定させているので、帯をまたぐ組み合わせが一塁にしか存在しない
 * （`balance:pinchrun` の13段目(a)で確認）。**塁ごとの分岐を持たずに済む。**
 *
 * 選ぶのは**もっとも速い控え**（同率なら並び順の先＝`chooseCpuPinchHitter` が
 * 「もっとも強い控え」を選ぶのと同じ畳み方で順序が一意に決まる）。足を買う手なので、
 * 条件を満たした中でいちばん速い者を出す。
 *
 * @returns 送る控えの添字。出さないなら null
 */
export function chooseCpuPinchRunner(opts: {
  /** いまの一塁走者。走者がいない（＝代走の対象がない）なら null */
  runner: { average: number; power: number; stealSlack: number } | null;
  bench: readonly CpuPinchRunCandidate[];
  /** R-39のしきい値（`CPU_STEAL_MAX_DEFENSE_SLACK_SEC`）。呼び出し側が渡す */
  stealSlackLimit: number;
  batLoss?: number;
}): number | null {
  const runner = opts.runner;
  if (runner === null) return null;
  // 1. いまの走者で走れるなら、足を買う理由がない
  if (runner.stealSlack <= opts.stealSlackLimit) return null;
  const batLoss = opts.batLoss ?? CPU_PINCH_RUN_BAT_LOSS;
  const current = runner.average + runner.power;
  let best: CpuPinchRunCandidate | null = null;
  for (const c of opts.bench) {
    // 2. その控えでも走れないなら、代えても何も変わらない
    if (c.stealSlack > opts.stealSlackLimit) continue;
    // 3. 打力を差し出しすぎるなら、残りの試合でその打順が損をする
    if (current - (c.average + c.power) > batLoss) continue;
    // もっとも速い＝守備に残る余裕がもっとも小さい（同率なら並び順の先）
    if (best === null || c.stealSlack < best.stealSlack) best = c;
  }
  return best === null ? null : best.index;
}
