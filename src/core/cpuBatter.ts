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
 * - 判断内容：バットが届く範囲外なら見送り。2ストライク以降は際どい球にも手を出して
 *   粘る（ファウルで凌ぐ＝三振回避を優先）。それ以外は「甘い球」（ストライクゾーンに
 *   わずかな余裕を持たせた範囲）だけを振る選球眼を持たせる。
 * - エッジ検出（crossesSwingDecisionPoint）は、既存の contactPlaneCrossing 等と同じ
 *   「前後2フレームの状態から境界越えを検出する」作法に揃えた。
 */
import { CONTACT_PLANE_Z, SWING_IDEAL_SEC, batReachFor } from './batting';
import type { BatterSide, PitchFlight } from './pitch';
import {
  RIGHT_BATTER_SIDE,
  SPEED_FAST,
  SPEED_NEUTRAL,
  STRIKE_ZONE_HALF_WIDTH,
  batterFrameX,
  clampStance,
} from './pitch';
import type { Bases, Count } from './rules';

/**
 * 速球に対してCPUがどれだけ早振り（＝タイミングを外して引っ掛け気味）になるか。
 * 実機テストプレイで「守備のときCPUが速球を100%ホームランにする」ことが判明した対策。
 * 旧実装はCPUが球速によらず常にジャストミート（timing=0）で捉えたため、初速が最大に
 * なる速球が確実にフェンスを越えていた。現実同様「速い球ほどタイミングが取りづらい」
 * よう、基準速→速球にかけてスイング判断のリード（＝押すタイミング）を早める。
 * スイングが早まるとジャストミートより terminal 側で捉える＝引っ張り・詰まりで初速が
 * 落ち、痛烈な当たりでも深いフライ／ゴロ止まりになりHRが激減する（ミートは残るので
 * CPUの攻撃自体は成立し続ける）。0.045秒でスイング経過が理想＋約0.045秒＝有効窓
 * （0.14秒）の中に収まるため空振りにはならず、確実に「弱い当たり」になる。
 */
const CPU_FAST_TIMING_PENALTY_SEC = 0.045;

/** 球速に応じたスイング判断リード（速球ほど早振りになりタイミングを外す） */
export function cpuSwingLead(pitchSpeed: number): number {
  const fastness = Math.min(
    1,
    Math.max(0, (pitchSpeed - SPEED_NEUTRAL) / (SPEED_FAST - SPEED_NEUTRAL)),
  );
  return SWING_IDEAL_SEC + CPU_FAST_TIMING_PENALTY_SEC * fastness;
}

/** 際どい球にも手を出す「甘い球」判定の許容幅（ストライクゾーンよりわずかに広い） */
const SELECTIVE_HALF_WIDTH = STRIKE_ZONE_HALF_WIDTH + 0.15;

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
 */
export function crossesSwingDecisionPoint(prev: PitchFlight, next: PitchFlight): boolean {
  const lead = cpuSwingLead(prev.vz);
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
 */
export function shouldCpuSwing(
  flight: PitchFlight,
  count: Count,
  side: BatterSide = RIGHT_BATTER_SIDE,
  stance = 0,
): boolean {
  const predictedX = predictCrossX(flight);
  const localX = batterFrameX(predictedX, side);
  const reach = batReachFor(stance);
  if (localX < reach.outside || localX > reach.inside) return false;
  if (count.strikes >= 2) return true;
  return Math.abs(predictedX) <= SELECTIVE_HALF_WIDTH;
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
 * CPUが代走を出すときに**差し出してよい打力**（AV＋HRの合計の差）。
 *
 * `npm run balance:pinchrun` の12段目が決めた＝**どのイニングで出しても100%損しない
 * 唯一の候補**（0.20 まで緩めると「残り9イニング＝1回に出す」場合の96.6%までしか
 * 保てない＝1回に出すと損をする組が出る）。**おかげでイニングの条件が要らない**
 * ＝X-45が代打で「イニングのしきい値は置かない」と決めたのと同じ形に収まった
 * （そこも計測が決めている）。
 *
 * 16球団すべてで2〜5組成立するので**規則は死んでいない**（`CPU_PINCH_HIT_GAP` を
 * 「11球団で成立する」ことで決めたのと同じ見方）。
 *
 * **符号が代打と逆**なのが要点：代打は「控えがこれだけ強ければ出す」、代走は
 * 「控えがこれ以上弱くなければ出す」。
 *
 * **フェーズJJ-57で測り直した**（空気抵抗が入って長打が減り、**盗塁1つの値打ちが
 * +0.112点 → +0.069点**に下がった）：0.10 の保証は「**残り3イニングなら100%**／
 * 残り9イニングでは98.0%」に弱まった（12段目）。**値は据え置いた**＝100%を取り戻すには
 * 0（＝打力を1ミリも落とさない）しかなく、そこまで絞ると成立する組が 51→35 に減り、
 * 「しきい値＝差し出してよい上限」という規則の形そのものが表せなくなる。
 * **終盤に出すぶんには従来どおり損しない**ので、代走が実際に効く場面の保証は保たれている。
 */
export const CPU_PINCH_RUN_BAT_LOSS = 0.1;

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
