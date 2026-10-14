/**
 * でっかいモードのCPU打撃AI（純粋ロジックのみ、状態は持たない）。
 * cpuPitcher.ts と対になる、打者側の2P/CPU操作分離の本体（PROGRESS.md「でっかいモードの
 * CPU投球/打撃AI」参照）。
 *
 * 設計方針：
 * - CPU打者は毎フレーム「今スイングを押すべきか」を判断するのではなく、着弾（打撃面通過）
 *   までの残り時間が**その球で狙う時刻**（`cpuSwingLead`）とちょうど一致する瞬間に一度だけ
 *   判断する（shouldCpuSwing）。現在のボール速度・コースを線形外挿して着弾点を予測するので、
 *   投手側がその後もカーブを続けている場合は予測が外れて差し込まれる／泳ぐことがある
 *   （＝曲げ球がCPU打者も欺けるという、人間の打者と同じ駆け引きが自然に成立する）。
 * - 判断内容：バットが届く範囲外なら見送り。**ストライクには手を出す**。**2ストライク以降は
 *   隅の1つ外まで広げて粘る**（ファウルで凌ぐ＝三振回避を優先）が、そこから更に外れた球は
 *   見送る。
 * - エッジ検出（crossesSwingDecisionPoint）は、既存の contactPlaneCrossing 等と同じ
 *   「前後2フレームの状態から境界越えを検出する」作法に揃えた。
 *
 * ## フェーズAAA-75：タイミングは「直前の球の速さ」に合わせ、人間並みにぶれる
 *
 * UU-69 が残した「CPUの三振 39.6%／CPU打線の本塁打 0本」を測ったら、原因は数値ではなく
 * **スイングの始め方**にあった（`npm run balance:plate` の12〜15段目）：
 *
 * 1. **CPUのスイングは「判断したフレームの1フレーム前から振り始めた」扱いになっていた**
 *    （判断は `next` の位置で下すのに、スイングの時計は `prev` の時刻から数えていた）。
 *    遅れは最大1フレーム＝**結果が画面のリフレッシュレートで変わる**（ど真ん中の速球を
 *    投げ続けたときの三振率：60Hzで86.1%／144Hzで37.5%）。UU-69 が有効窓を 0.14→0.09 に
 *    狭めたせいで、この固定の遅れが窓に対して相対的に大きくなった。
 * 2. その遅れのせいで、**2ストライク後の速球はCPUが必ず空振りし**、**CPUは速球を一度も
 *    前へ飛ばせなかった**＝CPUの三振 39.6% はすべて空振り、本塁打0本の正体もこれ。
 *    人間の投手側から見ると**ど真ん中の速球×3＝三振86%・安打0の必勝配球**だった。
 * 3. 遅れを消して**完全に決定的なまま**にすると「同じ球には必ず同じ結果」になる。
 *    規則を35通り試したが、**どの規則にも三振100%か打率.000になる配球が残った**
 *    （空振りさせる球があれば人間は必ずそれを選べる。無ければCPUは三振しない）。
 *
 * そこで（2026-09-29 ユーザー判断）：
 *
 * - **タイミングは「直前の球の速さ」に合わせる**（`cpuSwingLead`）。その打席でストライクに
 *   なった球（見逃し・空振り・ファウル）の速さを覚え、**同じ速さを続けると捉えられ、
 *   速さを変えると崩れる**。緩急1段（速球↔基準速↔フォーク）につき
 *   `CPU_TIMING_PENALTY_SEC`（窓の1/3）ずれる。初球はその投手の基準速を待つ。
 *   **O-36の「直前のストライクのコースへ芯を合わせる」と対**になる＝CPU打者は
 *   **コースも速さも、直前のストライクに合わせてくる**（読める規則のまま）。
 * - **人間並みの小さなぶれを持たせる**（`CPU_SWING_SIGMA_SEC`）。**CLAUDE.md⑪の
 *   「CPUの規則は決定的」を、打撃のタイミングについてだけ緩めた**唯一の場所。ぶれは
 *   試合のシードから別系列で引く（`drawCpuSwingNoise`。本編の乱数は消費しない）ので、
 *   **シードを固定すれば試合まるごと再現できる**という約束は保たれる。
 * - **スイングはサブフレームで正確に始める**（`cpuSwingClockAt`）＝どのリフレッシュレート
 *   でも同じ結果になる。
 * - **2ストライクのタイミングの特別扱い（窓の縁まで泳ぐ）はやめた**。空振りは緩急とぶれから
 *   自然に生まれるので要らない（残したまま測ると、人間の決まった配球で取れる三振の最大が
 *   36%→45% に増えた＝必勝配球に近づく）。
 * - **手を出す幅はストライクゾーンいっぱい**（`SELECTIVE_HALF_WIDTH`）。TT-68 の
 *   「隅の1つ内側（0.40）」のままだと、0.40〜0.45 に投げれば**見逃しストライクを
 *   取り放題**という別の必勝配球が残った（`npm run balance:plate` の9段目：その帯を使う
 *   配球で三振 33〜51%）。
 *
 * **判定（`judgeSwing`）には1行も触っていない**ので `npm run balance` は完全に不変で、
 * 人間の打者の手応え（到達範囲・有効窓）も1mmも動いていない。
 */
import { CONTACT_PLANE_Z, SWING_ACTIVE_SEC, SWING_IDEAL_SEC, batReachFor } from './batting';
import type { BatterSide, PitchFlight } from './pitch';
import {
  REFERENCE_PITCHER_NEUTRAL,
  RIGHT_BATTER_SIDE,
  SPEED_FAST_DELTA,
  SPEED_SLOW_DELTA,
  STRIKE_ZONE_HALF_WIDTH,
  batterFrameX,
  clampStance,
  flightSecondsUntil,
} from './pitch';
import { CORNER_MARGIN as CPU_CORNER_MARGIN } from './cpuPitcher';
import { type RngState, nextRng } from './rng';
import type { Bases, Count } from './rules';

/**
 * **緩急1段あたり**、CPU打者のスイングがどれだけずれるか（秒）。
 *
 * 1段＝速球↔基準速、または基準速↔フォーク（`paceStepOf` の1）。**待っていた球より
 * 遅ければ早振り（泳ぐ＝引っ張り）、速ければ振り遅れ（差し込まれる＝流し）**になる。
 * 速球を待っているところへフォークが来れば2段ぶん＝窓の2/3ずれる＝**芯から縁まで（窓の半分）を
 * 越える**ので、ぶれが引き戻さなければ空振りになる。
 *
 * ## 値の出どころ（新しい数値は持ち込んでいない）
 *
 * `SWING_ACTIVE_SEC / 3`＝**TT-68 が「通常の罰」として決めた梯子の1段そのもの**。
 * TT-68 までは「基準速から離れた球ほど早振り」（`offness`）の罰として使っていたのを、
 * フェーズAAA-75で**「待っていた速さから何段ずれたか」**の1段ぶんへ読み替えた。
 * 1段なら窓の1/3（芯から縁までの2/3＝弱い当たり）、2段なら窓の2/3（縁の外＝空振り寄り）
 * ＝**1段の変化だけでは空振りさせられない**のが要点で、これより大きくすると
 * 「速さを1段変えるだけで空振り」が必勝配球になる（`npm run balance:plate` の13段目）。
 *
 * 旧来のコメントが持っていた経緯（セッション9の「CPUが速球を100%本塁打にする」対策
 * として入った早振り／SS-67で緩急の両側へ／TT-68で窓からの導出へ）は ORIGINAL_PARITY.md の
 * フェーズ記録にある。
 */
export const CPU_TIMING_PENALTY_SEC = SWING_ACTIVE_SEC / 3;

/**
 * CPU打者のタイミングのぶれ（標準偏差・秒）＝**人間並み**。
 *
 * 値は **UU-69 が有効窓（`SWING_ACTIVE_SEC`）を決めたときの人間のばらつき**（σ=40ms。
 * 「押す時刻が ±45ms に入れば当たる」窓で空振り 25.1%＝実際の野球の約25%）を
 * そのまま使う＝**新しい数値は持ち込んでいない**。意味はひと言で言える＝
 * **CPU打者は、平均的な人間と同じだけタイミングがぶれる**。
 *
 * ぶれを入れた理由は `npm run balance:plate` の12・15段目：**決定的なCPU打者には、
 * どう規則を作っても必勝の配球が残る**（同じ球には必ず同じ結果になるので、空振りさせる
 * 球があれば人間は必ずそれを選べる）。ぶれがあれば**同じ球でも結果が散る**ので、
 * どの決まった配球でも三振は4割程度までに収まる。
 */
export const CPU_SWING_SIGMA_SEC = 0.04;

/**
 * ぶれを引く系列の塩（`condition.ts` の `HOT_SEED_SALT`・`skills.ts` の
 * `LINEAGE_SEED_SALT` と同じ考え方＝**本編の乱数を消費せず、シードから別系列を起こす**）。
 * 値そのものに意味は無い。
 */
export const CPU_SWING_NOISE_SALT = 0xba7;

/**
 * ぶれを1球ぶん引く（正規分布。Box–Muller）。**±3σ で打ち切る**＝ごくまれに
 * 「0.2秒以上早く振り出す」ような、人がやらない振り方にはしない。
 *
 * 状態を書き換えず必ず新しい状態を返す（`rng.ts` の作法）。
 */
export function drawCpuSwingNoise(
  state: RngState,
  sigma: number = CPU_SWING_SIGMA_SEC,
): { noise: number; state: RngState } {
  const a = nextRng(state);
  const b = nextRng(a.state);
  const u = Math.max(a.value, Number.EPSILON);
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * b.value);
  return { noise: sigma * Math.max(-3, Math.min(3, z)), state: b.state };
}

/**
 * その球が**その投手の基準速から緩急何段か**（速球＝+1／基準速＝0／フォーク＝-1）。
 *
 * 幅は上下で違う（`SPEED_FAST_DELTA`=6 / `SPEED_SLOW_DELTA`=14）ので、上下それぞれの幅で
 * 割る＝**緩急を目いっぱい使った球がちょうど1段**になる（`speedForPitchSelection` の
 * 「緩急の幅は投手によらず一定」と揃う）。**中心はその投手の基準速**なので、
 * 球速（SPD）の違う投手でも「速球→フォーク」は同じ2段になる（疲労で全体が遅くなっても同じ）。
 */
export function paceStepOf(pitchSpeed: number, pitcherNeutral: number): number {
  return pitchSpeed >= pitcherNeutral
    ? (pitchSpeed - pitcherNeutral) / SPEED_FAST_DELTA
    : (pitchSpeed - pitcherNeutral) / SPEED_SLOW_DELTA;
}

/**
 * 投手の球速（基準速）が、CPU打者のタイミングの誤差に掛ける倍率（フェーズBBB-85）。
 *
 * **球が速いぶん飛行時間が縮む、その同じ比で誤差（緩急のずれとぶれ）が大きくなる**＝
 * `投手の基準速 ÷ 基準の投手の基準速`。名鑑の平均の投手で 1（BBB-85 の前と同じ）、
 * いちばん速い投手（基準速42）で 1.11、いちばん遅い投手（30）で 0.79。
 *
 * それまで球速はCPU打者相手に何の得にもならなかった：CPU打者は緩急を**その投手の基準速からの
 * 段**で見て（`paceStepOf`）、ぶれは秒で持つので、誰が投げても同じだけ当てた。人間の打者は
 * 球が速いほど読む時間が短くなる＝その不利を、CPU打者は同じ比の誤差として持つ。
 *
 * 計測（先発16人の球速だけを差し替え、散らして投げる）：球速 0.3→0.9 で 三振 18→25%・
 * 打率 .246→.214。新しい数値は持ち込んでいない（比はそのまま飛行時間の比）。
 *
 * `pitcherNeutral` を渡さなければ 1＝投手を持たない素の球。
 */
export function cpuTimingScale(pitcherNeutral?: number): number {
  return pitcherNeutral === undefined ? 1 : pitcherNeutral / REFERENCE_PITCHER_NEUTRAL;
}

/**
 * CPU打者がバットを出し始める時刻＝**打撃面まで残り何秒でスイングを始めるか**
 * （フェーズAAA-75）。`SWING_IDEAL_SEC` ちょうどならジャストミート。
 *
 * **待っている球（`expectedSpeed`）との緩急の差**で決まる：
 * - 待っていた球より**遅い**＝早く振り出す（泳ぐ。正のタイミング＝引っ張り）
 * - 待っていた球より**速い**＝振り出しが遅れる（差し込まれる。負のタイミング＝流し）
 * - **同じ速さなら芯**（＝同じ球を続けると捉えられる）
 *
 * `expectedSpeed` が null＝**その打席の初球**で、投手の基準速を待つ。
 * `noiseSec` はぶれ（`drawCpuSwingNoise`）。渡さなければ0＝ぶれの無い狙いそのもの。
 * `stepSec` は**計測が定数を書き換えずに1段の重みを振るための引数**（`swingWidths` と
 * 同じ作法）。渡さなければ採用値＝ゲーム本体はこの経路しか通らない。
 * `timingScale` は投手の球速による誤差の倍率（`cpuTimingScale`。BBB-85）＝**緩急のずれと
 * ぶれの両方に掛かる**。渡さなければ 1。ゲーム本体は投げた球の基準速から必ず渡す。
 *
 * **0 より小さくはしない**（打撃面を過ぎてから振り出すことはない）。0 のときも判断は
 * 打撃面を通る瞬間に一度だけ起き、バットが届かないので空振りになる。
 */
export function cpuSwingLead(
  pitchSpeed: number,
  pitcherNeutral: number,
  expectedSpeed: number | null = null,
  noiseSec = 0,
  stepSec: number = CPU_TIMING_PENALTY_SEC,
  timingScale = 1,
): number {
  const expected = expectedSpeed ?? pitcherNeutral;
  const gap = paceStepOf(expected, pitcherNeutral) - paceStepOf(pitchSpeed, pitcherNeutral);
  return Math.max(0, SWING_IDEAL_SEC + (stepSec * gap + noiseSec) * timingScale);
}

/**
 * 手を出す幅（＝これより外は見送る）＝**ストライクゾーンいっぱい**。
 *
 * ## 経緯
 *
 * - SS-67 までは 0.60（**名鑑96人が投げる球をすべて含んでいた**＝1球も見送らなかった）。
 * - SS-67 で `ゾーン半幅 - 隅の余裕`（0.40）＝「甘い球だけを振る」へ。
 * - **フェーズAAA-75で `ゾーン半幅`（0.45）へ**。0.40 のままだと、0.40〜0.45 に投げた球は
 *   **振られずにストライクになる**＝人間の投手が**見逃しストライクを取り放題**だった
 *   （TT-68 が未確認事項に残していた形。`npm run balance:plate` の9段目で、その帯を使う
 *   配球の三振が 33〜51%）。ぶれが入って空振りが自然に生まれるようになったので、
 *   **四球・三振を作るために「振らせない帯」を置く必要が無くなった**。
 *
 * 意味はひと言で言える＝**「ストライクには手を出す」**。
 */
export const SELECTIVE_HALF_WIDTH = STRIKE_ZONE_HALF_WIDTH;

/**
 * 2ストライク以降に手を出す幅（＝**追い込まれたら隅まで手を出す**）。
 * **ストライクゾーンの隅の1つ外側**＝投手の決め球（`ゾーン半幅 + 隅の余裕`）の狙いそのもの。
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

/**
 * 打撃面（CONTACT_PLANE_Z）通過までの残り**実時間**（秒）。通過済みなら負、球速0以下なら Infinity。
 *
 * **飛行の時計（フェーズBBB-76の `PitchFlight.rate`）込みで数える**＝CPU打者が振り出す時刻
 * （`cpuSwingLead`）もスイングの時計も実時間なので、ここを球速どおりの時間で数えると、
 * 原作の速さで飛んでくる球に対して**毎回振り遅れる**。
 */
export function timeToContactPlane(flight: PitchFlight): number {
  return flightSecondsUntil(flight, CONTACT_PLANE_Z);
}

/**
 * 現在の速度で等速直線運動を続けたと仮定した、打撃面通過時のX（線形外挿）。
 * **通り道の計算なので球速どおりの時間で外挿する**（横の速度 vx も同じ単位）＝時計を
 * 速めても予測する場所は変わらない。
 */
export function predictCrossX(flight: PitchFlight): number {
  if (flight.vz <= 0) return flight.x;
  const t = Math.max(0, (CONTACT_PLANE_Z - flight.z) / flight.vz);
  return flight.x + flight.vx * t;
}

/**
 * このステップでスイング判断の瞬間（残り時間が `lead` を下回った最初の瞬間）を通過したか。
 * prev/next は onFlightStep で渡される前後1ステップ分の飛行状態、`lead` はその球の
 * `cpuSwingLead`（**球ごとに一度だけ決める**＝ぶれを飛行の途中で引き直さない）。
 */
export function crossesSwingDecisionPoint(
  prev: PitchFlight,
  next: PitchFlight,
  lead: number,
): boolean {
  return timeToContactPlane(prev) > lead && timeToContactPlane(next) <= lead;
}

/**
 * 判断した瞬間に振り出すときの、**このフレームの先頭の時点でのスイングの経過時間**
 * （フェーズAAA-75。0 以下）。バッティングの `trySwing` にそのまま渡す。
 *
 * スイングの時計（`swingT`）は「フレームの先頭時点の経過」で持ち、接触判定はそこへ
 * サブフレームの通過時刻を足して読む（`dekkaiScene.ts` の `checkContact`）。CPUが振り出す
 * のは、残り時間がちょうど `lead` になった瞬間＝**このフレームの先頭から
 * `timeToContactPlane(prev) - lead` 秒後**なので、先頭の時点では**まだその分だけ
 * 振り出していない**（負の値）。
 *
 * **これが無いと、スイングはフレームの先頭から始まった扱いになる**＝狙いより最大
 * 1フレーム早く振ることになり、しかもその量が画面のリフレッシュレートで変わる
 * （AAA-75の前は、60Hzで2ストライクの速球が必ず空振り・144Hzでは半分しか空振らなかった）。
 */
export function cpuSwingClockAt(prev: PitchFlight, lead: number): number {
  return Math.min(0, lead - timeToContactPlane(prev));
}

/**
 * 判断の瞬間に呼ぶ。予測着弾点とカウントから、スイングすべきかを返す。
 * バットが届かない球は常に見送り。2ストライク以降は粘るため際どい球にも手を出し、
 * それ以外はストライクだけを振る。
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
