/**
 * 守備・走塁システムの純粋ロジック（判定・数値計算のみ、状態は持たない）。
 *
 * ファミスタ準拠の守備モデル（v1スコープ）：
 * - 打球発生と同時に、着地予測地点にもっとも近い野手が「操作対象」になる
 *   （十字キーで移動。他の8人はホームポジションで静止＝守備範囲外のフォロー連携は対象外）。
 * - 捕球（自動）：操作対象の野手がボールの近く（射程内・リーチ内）に来れば、
 *   ボタン入力なしで毎フレーム自動的に成立する（原作準拠：捕球にボタンは使わない。
 *   CLAUDE.mdの操作表でもAは「打撃/投球/送球/帰塁」であり捕球は含まれない）。
 *   ノーバウンドで捕ればフライアウト。バウンド後に捕れば「確保」状態になり、
 *   送球フェーズへ移る。
 * - 送球（A、確保中）：十字キーで塁を指定（＝塁の方向にもっとも近い入力方向）してから
 *   投げる。無入力なら「もっとも進んだ強制走者の塁」へ自動送球（原作の分かりやすさ優先）。
 * - 判定：送球がその塁へ到達する時間 と 対象走者がその塁へ到達する時間 の競争
 *   （同着は走者有利＝実際の野球の「タイ・ゴー・ザ・ランナー」慣習に準拠）。
 *
 * 注意：この時間競争の判定関数（resolveDefensePlay/applyForcedResult）は「1送球で全走者を
 * 一括判定する」旧モデル用で、シーン層（chicchaiScene.ts）は現在これらを使わず、送球ごとに
 * 対象走者1人ずつを個別判定する増分モデル（連続送球対応）に置き換えている。ここに残す
 * 純粋関数は単体テスト付きのユーティリティとして保持（将来の再利用・参照用）。
 *
 * v1の意図的な簡略化（PROGRESS.md 未確定事項に記録）：
 * - フォースされていない走者は動かない（先の塁への欲張り進塁・タッチプレーは対象外）。
 * - ファウルゾーンでの捕球はアウトにならない（着地前の現在地がフェア/ファウルで判定）。
 * - フライ捕球時は走者が全員いったん元の塁へ戻り、そこからタッチアップで進塁を
 *   仕掛けられる（説明書p19。FLY_CATCH_RELEASE_SEC / chooseCpuTagUp を参照）。
 * - けん制球（説明書p24）は投球前の別入口。塁上の走者が LEAD_SPEED でリードを広げ、
 *   けん制球のリリースと同時に帰塁を始める＝送球と帰塁の時間競争になる
 *   （pickoffOutLead / leadPosition / chooseCpuPickoffThrow を参照）。
 * - 盗塁（説明書p13）は投球中の別入口。走者は STEAL_LEAD から走り出し、捕手は
 *   「投球が届く＋持ち替え（STEAL_CATCH_RELEASE_SEC）」の後に投げる＝**仕掛けた
 *   瞬間の投球の残り時間**が成否を決める（stealSafeJumpSec / chooseCpuSteals を参照）。
 *   **複数の走者が同時にスタートできる**（フェーズL-32のダブルスチール。塁を指定しない
 *   仕掛けは走れる走者全員＝chooseSendRunners / stealableBases）。**スタート位置は直前の
 *   けん制から持ち越したリード**があればそちら（resolveCarriedLeads）。
 *
 * 座標系は pitch.ts / batting.ts / field.ts と同一
 * （本塁原点、+Z=捕手方向、外野=-Z、+X=一塁側）。
 */
import type { BaseRunners, Bases, RunnerId } from './rules';
import { PITCHER_PLATE_Z } from './pitch';
import { type BattedBall, stepBattedBall } from './batting';

export interface Vec2 {
  x: number;
  z: number;
}

export type BaseKey = 'first' | 'second' | 'third' | 'home';
export type FielderId = 'P' | 'C' | '1B' | '2B' | '3B' | 'SS' | 'LF' | 'CF' | 'RF';

/** 塁間 27.4m を斜め45度に配置したときの軸方向距離（field.ts と共有する幾何の正） */
export const BASE_PATH = 27.4;
export const BASE_AXIS = BASE_PATH / Math.SQRT2;

export const BASE_POSITIONS: Record<BaseKey, Vec2> = {
  home: { x: 0, z: 0 },
  first: { x: BASE_AXIS, z: -BASE_AXIS },
  second: { x: 0, z: -BASE_AXIS * 2 },
  third: { x: -BASE_AXIS, z: -BASE_AXIS },
};

/** 9守備位置のホームポジション（プレー開始時に全野手がここへリセットされる） */
export const FIELDER_HOME_POSITIONS: Record<FielderId, Vec2> = {
  P: { x: 0, z: PITCHER_PLATE_Z },
  C: { x: 0, z: 2.2 },
  '1B': { x: 14, z: -13 },
  '2B': { x: 8, z: -28 },
  SS: { x: -8, z: -28 },
  '3B': { x: -14, z: -13 },
  LF: { x: -45, z: -68 },
  CF: { x: 0, z: -80 },
  RF: { x: 45, z: -68 },
};

/**
 * 塁カバー割当（ファミスタ'90説明書p20「打者がボールを打つと、野手のうち4人は
 * 自動的にベースカバーに入ります」準拠）。捕手=本塁、一塁手=一塁、二塁手=二塁、
 * 三塁手=三塁に自動で入り、十字キーの一斉移動の対象外になる。
 */
export const BASE_COVER_ASSIGNMENTS: Readonly<Partial<Record<FielderId, BaseKey>>> = {
  C: 'home',
  '1B': 'first',
  '2B': 'second',
  '3B': 'third',
};

/** 十字キーで一斉移動する野手（塁カバー4人を除く残り全員。説明書p20「内・外野手をコントロール」） */
export const CONTROLLABLE_FIELDERS: readonly FielderId[] = ['P', 'SS', 'LF', 'CF', 'RF'];

/**
 * 走者の移動速度 m/s（走力の基準値）。塁間・送球・けん制・盗塁の各境界は
 * すべてこの値を基準に調整済みなので、能力値の中央（0.5）がちょうどこの速度になる
 * ように runnerSpeed を決めてある（＝平均的な走者では従来どおりの手触り）。
 */
export const RUNNER_SPEED = 7.5;

/**
 * 走力（RUN）0..1 → 実際の走者速度 m/s（フェーズB-8）。
 *
 * 中央（0.5）が RUNNER_SPEED=7.5 になるよう対称に振ってあるので、**平均的な走者は
 * 従来と同じ**で、俊足・鈍足だけが基準からずれる。上限を野手の 8.5m/s より遅く
 * 留めているのが要点で、どんな俊足でも野手に追いつかれうる＝守備側の操作が
 * 無意味にならない（挟殺の読み合いが成立する条件そのもの）。
 *
 * 実際の効き方は塁間 27.4m の所要時間の差として出る：
 * 俊足（1.0）3.34秒 / 平均 3.65秒 / 鈍足（0.0）4.03秒。**この0.7秒の幅が、
 * 送球との時間競争（内野安打・盗塁・けん制・タッチアップ）すべてに一様に効く。**
 */
export const RUNNER_SPEED_MIN = 6.8;
export const RUNNER_SPEED_MAX = 8.2;

export function runnerSpeed(run: number): number {
  const r = Math.max(0, Math.min(1, run));
  return RUNNER_SPEED_MIN + (RUNNER_SPEED_MAX - RUNNER_SPEED_MIN) * r;
}
/** 操作野手の移動速度 m/s */
export const FIELDER_SPEED = 8.5;
/** 送球速度 m/s */
export const THROW_SPEED = 34;
/** 捕球が成立する野手とボールの距離 */
export const CATCH_RADIUS = 2.6;
/**
 * 捕球が成立する高さの上限（ジャンプ・リーチの簡易モデル）。
 * 注意：打球は水平速度が大きく（40m/s近いことも珍しくない）、捕球半径2.6mを
 * 100〜200ミリ秒で通り抜ける。そのため捕球は「タイミングよくボタンを押す」
 * 操作にはできない（実機テストプレイで人間には実質不可能と判明した経緯が
 * PROGRESS.md「実装メモ」にある）。捕球判定はシーン層が毎フレーム自動で試みる
 * 前提であり（原作ファミスタ準拠：捕球にボタン入力は不要、Aは送球専用）、
 * この定数は「どの高さまで手が届くか」というリーチのみを意味する。
 */
export const CATCH_MAX_HEIGHT = 2.2;
/** 走者が塁に到達したとみなす距離 */
export const BASE_ARRIVE_RADIUS = 1.4;

// ---- バイク（フェーズF-26-3。★3メカのスキル `バイク`。CLAUDE.md ⑧） ----
//
// **CLAUDE.md ⑥の設計不変条件と正面からぶつかる唯一のスキル**：
// 「走力の上限（8.2m/s）は野手の足（8.5m/s）より遅くする。どんな俊足でも野手に
// 追いつかれうることが、挟殺の読み合い（＝守備側の操作に意味があること）の前提」。
// 2倍速の 13.6〜16.4m/s は野手を完全に振り切るので、**そのままでは「タッチアウト」
// という概念が消える**。そこで代償を2つ、**速さと不可分な形**で必ず付ける：
//
// 1. **曲がれない＝塁で止まれない**（bikeOverrunsAt / bikeOverrunTarget）。踏んだ塁を
//    行き過ぎて止まるので、戻る指示（K）が出るまで塁を踏んでいない＝送球でもタッチでも
//    刺されうる。速く着くほど早く無防備になる、という形で速さそのものが危うさになる。
// 2. **戻りは徒歩・1プレーに1回だけ点火できる**（シーン層が持つ規則）。往復に使えないので
//    挟殺（走者が塁間を行き来して逃げるプレー）にはバイクを持ち込めない＝上の不変条件は
//    「挟殺が成立する」という本来の意味のまま保たれる。

/**
 * バイクの速度倍率。原作差分ではなくオリジナル要素なので基準は「体感で別物になること」。
 * 2倍だと塁間 27.4m が 3.65秒→1.83秒 になり、**内野からの送球（THROW_SPEED=34m/s）でも
 * ほぼ間に合わなくなる**＝「間に合わせる」ための道具として明確に効く。
 */
export const BIKE_SPEED_SCALE = 2;

/**
 * 塁を行き過ぎる距離 m。**MAX_LEAD（けん制のリード上限6m）と同じ**にしてある：
 * けん制で刺されるかどうかの境界（pickoffOutLead は一塁で約4.3m）がすでに調整済みなので、
 * 同じ深さに置けば「刺せるが、投げるのが遅れれば戻られる」という既知の手触りになる。
 */
export const BIKE_OVERRUN_DISTANCE = 6;

/**
 * J を押し続けてバイクに点火するまでの時間 s（ユーザー判断：**仕掛けるときに選ぶ**）。
 *
 * 「押した瞬間」では長押しと区別が付かないので、走り出しはいつもどおり徒歩で始まり、
 * 押し続けているとエンジンがかかる。短く離せば従来どおりの走塁＝**バイクを持つ選手でも
 * 乗らない選択ができる**（守りが塁に張り付いている場面ではオーバーランが即アウトになる）。
 * 打撃の「Kを押しっぱなし＝フルスイング／離す＝バント」と同じ、既存の押し分けの語彙。
 */
export const BIKE_ENGAGE_SEC = 0.3;

/**
 * CPU走者がオーバーランしてから帰塁を始めるまでの反応時間 s（決定的・乱数不使用）。
 *
 * CPU側もスキルを持つ（CLAUDE.md ⑧）ので、CPUの走者もバイクに乗る。ただし帰塁を
 * 誰も指示しないとプレーが畳まれない（人間守備は「刺せる走者がいる限り待つ」）ので、
 * **CPUは必ず自動で戻る**。人間が守るときは 6m/(2倍速) で出て行き、この反応の後
 * 6m/(徒歩) で戻る間＝およそ1.7秒が「狙える窓」になる。
 *
 * **人間が「イキスギ!」を読んでKを押すのに要る時間より短くしない**（実機で0.2秒にすると
 * CPUの走者だけが人間には不可能な速さで戻り、代償を払っているように見えなくなった）。
 * 桜井ノウハウ「人ができる範囲のこともずるいと思われるのはCPの常」。F-26-2の銃の予兆を
 * 1.5秒置いたのと同じ理由で、**CPUの得を人間が再現できる範囲に留める**。
 */
export const BIKE_CPU_RETURN_SEC = 0.5;

/**
 * その塁でオーバーランが起きるか（ユーザー判断：**本塁以外すべて**）。
 *
 * 本塁だけが例外なのは、本塁は駆け抜けた時点で得点が確定して走者でなくなるから
 * （実際の野球と同じ）。一塁も対象に含めるのはこのゲームの選択で、実際の野球の
 * 「一塁はオーバーラン可」とは違う＝**打者走者がバイクに乗るのも賭けになる**。
 */
export function bikeOverrunsAt(base: BaseKey): boolean {
  return base !== 'home';
}

/**
 * オーバーランして止まる位置。**走ってきた向きの延長**（曲がれないので進路が変わらない）。
 * 塁間 27.4m に対して 6m なので、次の塁に着いてしまうことはない。
 */
export function bikeOverrunTarget(from: Vec2, base: BaseKey): Vec2 {
  const to = BASE_POSITIONS[base];
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  return {
    x: to.x + (dx / len) * BIKE_OVERRUN_DISTANCE,
    z: to.z + (dz / len) * BIKE_OVERRUN_DISTANCE,
  };
}

// ---- ドロップキック（フェーズF-26-4。★2ボウリョクのスキル `ドロップキック`。CLAUDE.md ⑧） ----
//
// 走者が塁間で野手を蹴って行動不能にし、持っていたボールを落とさせる。**バイク（F-26-3）が
// 「速さ」で送球との時間競争に勝ちにいくのに対し、こちらは「時間を止める」ほうから勝ちにいく**
// ＝どちらも同じ時間競争の上に乗るので、判定側に専用の分岐は要らない。
//
// バイクと同じく CLAUDE.md ⑥の不変条件（挟殺の読み合いが成立すること）とぶつかるので、
// **代償を強さと不可分な形で3つ**付ける：
// 1. **空振ると転ぶ**（DROPKICK_STUMBLE_SEC）。射程に野手がいなければ走者はその場で止まる
//    ＝「蹴るか、走り続けるか」がタイミングの読み合いになる（外すと確実に刺される距離を失う）。
// 2. **1プレーに1回だけ**（シーン層の dropkickUsed。空振りでも消費する）。連打で野手を
//    薙ぎ倒せると挟殺という概念が消えるため、バイクの「1プレーに1回しか点火できない」と
//    同じ規則をそのまま置く。
// 3. **射程が短い**（DROPKICK_RANGE）。守備側は「ボールを持って走者へ寄る（ランダン）」の
//    代わりに「離れたまま塁へ投げる」を選べる＝蹴られない立ち回りが常に存在する。

/**
 * 蹴りが届く距離 m。**タッチ半径（TAG_RADIUS=1.6）より広い**ことがこのスキルの意味そのもの
 * ＝タッチされる前に蹴れる。広げすぎると守備がランダンで近寄れなくなるので、捕球半径
 * （CATCH_RADIUS=2.6）とダイビングのリーチ（FINE_PLAY_DIVE_RADIUS=3.4）の少し外に置いた。
 */
export const DROPKICK_RANGE = 4;

/**
 * 警告が出てから蹴られるまでに、守備側が確保できる時間 s。人の単純反応時間（約0.2秒）に
 * 「塁の方向へ十字キーを入れてKを押す」ぶんを足した長さ。
 *
 * **射程ちょうどで警告を出すのでは「もう蹴られる」の通知にしかならず、判断の余地が無い**
 * （桜井ノウハウ「人に反応できない動作をするとすっごい理不尽感がある」。F-26-2でCPUの銃に
 * 1.5秒の予兆を置いたのと同じ扱い）。回避手段（詰めるのをやめて塁へ投げる）が実際に間に合う
 * ことが、蹴られること自体を理不尽にしない条件。
 */
export const DROPKICK_WARN_LEAD_SEC = 0.35;

/**
 * 守備側に「蹴られる」と警告を出す距離 m。**射程＋その時間で詰められる距離**として導出する
 * ので、野手や走者の速さを触れば警告の距離も自動で追従する（FINE_PLAY_TRIGGER_RANGE を
 * ダイビングの到達距離から逆算したのと同じ立て方）。
 *
 * 詰め方は最悪の場合＝野手（8.5m/s）と走者（上限8.2m/s）が正面から寄り合う場合で見積もる。
 * 実際のランダンは後ろから追う形が多く、そちらでは猶予はもっと長くなる。
 */
export function dropkickWarnRange(range: number = DROPKICK_RANGE): number {
  return range + (FIELDER_SPEED + RUNNER_SPEED_MAX) * DROPKICK_WARN_LEAD_SEC;
}

/**
 * 素の射程での警告距離。スキルで射程が伸びた走者（デュオ `ロケットキック`。F-26-5）には
 * `dropkickWarnRange(伸びた射程)` を使う＝**射程が伸びれば警告も同じだけ早く出る**ので、
 * 「回避手段が間に合う」という上記の不変条件がスキルを取っても保たれる。
 */
export const DROPKICK_WARN_RANGE = dropkickWarnRange();

/**
 * 蹴られた野手が動けない時間 s。ファインプレイを外したときの起き上がり
 * （FINE_PLAY_DIVE_RECOVERY_SEC=0.9）より長い＝自分で跳んで外したのと、蹴られたのとでは
 * ダメージが違う。走者はこの間に 1.5×7.5 ≒ 11m 進める＝塁間 27.4m の4割で、
 * **挟殺から抜け出せるが、塁の遠いところで蹴っても届かない**長さ。
 */
export const DROPKICK_DOWN_SEC = 1.5;

/**
 * 空振ったとき走者が転んで止まっている時間 s。7.5m/s で 7.5m 失う計算で、
 * **バイクのオーバーラン（6m）と同じ帯**に置いてある（どちらも「行き過ぎ・止まり」で
 * 払う距離の代償なので、手触りを揃えた）。
 */
export const DROPKICK_STUMBLE_SEC = 1;

/**
 * 蹴られて落ちたボールが野手から離れる距離 m（蹴った向きの延長へ転がる）。
 * **CATCH_RADIUS（2.6）の内側**にしてあるのが要点で、起き上がった当人がその場で拾い直せる
 * ＝落球でプレーが宙に浮かない（＝守備側が払うコストは DOWN_SEC の分だけと確定する）。
 * それでもボールが手を離れて地面に転がるので、**別の野手が先に拾える**（守備側の対処が増える）。
 */
export const DROPKICK_LOOSE_BALL_DISTANCE = 2;

/**
 * 蹴る相手（走者からもっとも近い、射程内の野手）。いなければ null＝空振り。
 *
 * **投手も対象に含む**（ファインプレイが投手だけを除外している FINE_PLAY_ELIGIBLE とは違う）：
 * あれは原作の規則（説明書p23「ピッチャーだけはファインプレイができません」）だが、
 * 蹴られる側に原作の規則は無いし、投手が一塁カバーに入る場面で除外する理由も無い。
 */
export function dropkickTarget(
  runnerPos: Vec2,
  positions: Record<FielderId, Vec2>,
  range: number = DROPKICK_RANGE,
): FielderId | null {
  let best: FielderId | null = null;
  let bestDist = Infinity;
  for (const id of Object.keys(positions) as FielderId[]) {
    const d = distance(runnerPos, positions[id]);
    if (d > range || d >= bestDist) continue;
    bestDist = d;
    best = id;
  }
  return best;
}

/**
 * 落球したボールの落ち着き先。**走者→野手の向きの延長**（蹴り飛ばした方向）へ転がる。
 * 走者と野手が重なっている（距離0）ときは向きが決まらないので、その場に落とす。
 */
export function dropkickLooseBallPos(
  runnerPos: Vec2,
  fielderPos: Vec2,
  distanceOut: number = DROPKICK_LOOSE_BALL_DISTANCE,
): Vec2 {
  const dx = fielderPos.x - runnerPos.x;
  const dz = fielderPos.z - runnerPos.z;
  const len = Math.hypot(dx, dz);
  if (len === 0) return { ...fielderPos };
  return {
    x: fielderPos.x + (dx / len) * distanceOut,
    z: fielderPos.z + (dz / len) * distanceOut,
  };
}

/**
 * ファインプレイ（説明書p23「捕球のとき飛んできたボールに向けて+を入れA」）の種類。
 * 上=ジャンプ（届く高さが伸びる）／左右=横っとび・下=ダイビング（横に跳んで距離が伸びる）。
 * 原作は3方向を別の動作として区別するが、判定上は「高さが伸びる」か「距離が伸びる」かの
 * 2種類しかないため、跳ぶ向き（dir）は呼び出し側が持ち、ここでは kind だけを扱う。
 */
export type FinePlayKind = 'jump' | 'dive';

/**
 * ファインプレイができる野手（説明書p23「ピッチャーだけはファインプレイができません」）。
 * 捕手・内野手・外野手は塁カバー中でも跳べる（原作が除外しているのは投手だけ）。
 */
export const FINE_PLAY_ELIGIBLE: readonly FielderId[] = [
  'C',
  '1B',
  '2B',
  '3B',
  'SS',
  'LF',
  'CF',
  'RF',
];

/** 跳んでいる時間（この間だけリーチが伸びる） */
export const FINE_PLAY_ACTIVE_SEC = 0.4;
/** 横っとび・ダイビング中の移動速度（走る FIELDER_SPEED=8.5 より速い＝跳ぶ意味がある） */
export const FINE_PLAY_DIVE_SPEED = 13;
/** 横っとび・ダイビング中の捕球半径（通常 CATCH_RADIUS=2.6 から伸びる） */
export const FINE_PLAY_DIVE_RADIUS = 3.4;
/** ジャンプ中に届く高さ（通常 CATCH_MAX_HEIGHT=2.2 から伸びる。フェンス4mの手前を掠める球に届く） */
export const FINE_PLAY_JUMP_HEIGHT = 4;
/**
 * 跳んだ後、動けない時間（＝ファインプレイのコスト。この間その野手だけ一斉移動から外れる）。
 * 外すと「とりあえず跳び続けるのが最適」になってしまうため、失敗にはリスクを持たせる。
 * ダイビングは伏せた姿勢から起き上がるぶんジャンプより長い。
 */
export const FINE_PLAY_JUMP_RECOVERY_SEC = 0.35;
export const FINE_PLAY_DIVE_RECOVERY_SEC = 0.9;
/**
 * ファインプレイを仕掛けられる野手とボールの距離の上限。
 * ダイビングの到達距離（FINE_PLAY_DIVE_SPEED × FINE_PLAY_ACTIVE_SEC ≒ 5.2m）に
 * 伸びた捕球半径（3.4m）を足した 8.6m より少しだけ広く取り、「跳べば届くかもしれない」
 * 範囲に野手がいるときだけ発動する（誰も近くにいないのに遠くの野手が跳ぶのを防ぐ）。
 */
export const FINE_PLAY_TRIGGER_RANGE = 10;

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function nearestFielder(
  point: Vec2,
  positions: Record<FielderId, Vec2>,
): FielderId {
  let best: FielderId = 'P';
  let bestDist = Infinity;
  for (const id of Object.keys(positions) as FielderId[]) {
    const d = distance(point, positions[id]);
    if (d < bestDist) {
      bestDist = d;
      best = id;
    }
  }
  return best;
}

/** 着地点の予測（地点と、そこへ届くまでの秒数） */
export interface LandingPrediction {
  point: Vec2;
  /** 打球発生から着地までの秒数 */
  sec: number;
}

/**
 * 打球の（重力による）最初の着地点と、そこへ届くまでの時間を予測する。
 * stepBattedBall は純粋関数なので、実際のボールに影響を与えず
 * 「影のシミュレーション」として走らせられる。
 *
 * 秒数のほうは **CPU攻撃の進塁判断（`cpuExtraBaseSlack`。フェーズX-45）** が使う＝
 * 走者は打球の瞬間に走るかどうかを決めるので、「守備がいつボールを持つか」の
 * 見込みが要る。守備側（`landingPoint`）は地点しか使わないので `predictLanding` のまま。
 */
export function predictLandingAt(
  ball: BattedBall,
  dtStep = 1 / 60,
  maxSeconds = 6,
): LandingPrediction {
  let b = ball;
  let elapsed = 0;
  while (b.landing === null && elapsed < maxSeconds) {
    b = stepBattedBall(b, dtStep);
    elapsed += dtStep;
  }
  return { point: b.landing ?? { x: b.x, z: b.z }, sec: elapsed };
}

export function predictLanding(ball: BattedBall, dtStep = 1 / 60, maxSeconds = 6): Vec2 {
  return predictLandingAt(ball, dtStep, maxSeconds).point;
}

/**
 * 捕球が成立するか（距離・高さの簡易判定）。
 * radius / maxHeight は既定で通常のリーチ。ファインプレイ中の野手だけは
 * 伸びたリーチ（finePlayReach）を渡して判定する。
 */
export function canCatch(
  fielderPos: Vec2,
  ballPos: Vec2,
  ballHeight: number,
  radius: number = CATCH_RADIUS,
  maxHeight: number = CATCH_MAX_HEIGHT,
): boolean {
  return distance(fielderPos, ballPos) <= radius && ballHeight <= maxHeight;
}

/**
 * d-pad 方向にもっとも近い塁を選ぶ（十字キーの「塁指定」機能）。
 * dir はゼロベクトル不可（呼び出し側で無入力時は既定の塁を使う）。
 */
export function nearestBaseByDirection(
  from: Vec2,
  dir: Vec2,
  candidates: BaseKey[],
): BaseKey {
  const dirLen = Math.hypot(dir.x, dir.z);
  let best = candidates[0];
  let bestDot = -Infinity;
  for (const key of candidates) {
    const to = BASE_POSITIONS[key];
    const vx = to.x - from.x;
    const vz = to.z - from.z;
    const len = Math.hypot(vx, vz) || 1;
    const dot = (vx * dir.x + vz * dir.z) / (len * dirLen);
    if (dot > bestDot) {
      bestDot = dot;
      best = key;
    }
  }
  return best;
}

/**
 * ファミスタ'90説明書準拠の塁指定：十字キーの絶対方向→塁
 * （上=二塁、左=三塁、右=一塁、下=本塁。説明書p21送球・p30操作一覧の
 * d-pad図と同じマッピング）。無入力は null（呼び出し側が既定の塁を使う）。
 * 斜め入力は上下を優先する（説明書は4方向のみを想定しているため、
 * キーボードで斜めが入ってしまった場合の決定的なフォールバック）。
 */
export function baseFromPadDirection(x: number, y: number): BaseKey | null {
  if (y > 0) return 'second';
  if (y < 0) return 'home';
  if (x < 0) return 'third';
  if (x > 0) return 'first';
  return null;
}

/** ファインプレイ中の1人だけに適用する、伸びたリーチ */
export interface FinePlayReach {
  id: FielderId;
  radius: number;
  maxHeight: number;
}

/**
 * ファインプレイ中のリーチ（説明書p23）。
 * ジャンプは「高さ」だけ、横っとび・ダイビングは「距離」だけが伸びる
 * （跳ぶ向きの選択そのものは、跳んだ野手が実際にその方向へ移動することで効いてくる）。
 */
export function finePlayReach(id: FielderId, kind: FinePlayKind): FinePlayReach {
  return kind === 'jump'
    ? { id, radius: CATCH_RADIUS, maxHeight: FINE_PLAY_JUMP_HEIGHT }
    : { id, radius: FINE_PLAY_DIVE_RADIUS, maxHeight: CATCH_MAX_HEIGHT };
}

/**
 * 野手ごとの捕球半径の上乗せ m（フェーズF-26-5。ドウブツ系統のスキル `イヌ`/`タカ` 等）。
 * **省略すれば全員 0＝スキルを入れる前とまったく同じ判定**になる。
 *
 * 原作（説明書p26-29）に守備の能力項目は無い（CLAUDE.md ⑥）ので、素の名鑑からこの値が
 * 出ることはない。ここが non-zero になるのはローグライトのスキルを取った選手だけ。
 */
export type CatchRadiusBonus = (id: FielderId) => number;

/**
 * ボールを捕球できる位置にいる野手を探す（複数いれば最も近い野手）。
 * 原作準拠で「どの野手でもボールに触れれば捕球する」ための判定
 * （説明書p20：塁カバーに入った野手も含め、ボールが来れば捕る）。
 *
 * reach を渡すと、その野手1人だけ伸びたリーチで判定する（ファインプレイ中）。
 * bonusOf を渡すと、その野手のスキルぶんだけ半径がさらに伸びる（**ファインプレイ中の
 * 伸びたリーチにも同じだけ乗る**＝跳んだときだけスキルが効かない、という不自然が無い）。
 */
export function nearestCatchableFielder(
  positions: Record<FielderId, Vec2>,
  ballPos: Vec2,
  ballHeight: number,
  reach?: FinePlayReach,
  bonusOf?: CatchRadiusBonus,
): FielderId | null {
  let best: FielderId | null = null;
  let bestDist = Infinity;
  for (const id of Object.keys(positions) as FielderId[]) {
    const base = reach && reach.id === id ? reach.radius : CATCH_RADIUS;
    const radius = base + Math.max(0, bonusOf?.(id) ?? 0);
    const maxHeight = reach && reach.id === id ? reach.maxHeight : CATCH_MAX_HEIGHT;
    if (!canCatch(positions[id], ballPos, ballHeight, radius, maxHeight)) continue;
    const d = distance(positions[id], ballPos);
    if (d < bestDist) {
      bestDist = d;
      best = id;
    }
  }
  return best;
}

/**
 * ファインプレイの種類を十字キーから決める（説明書p23：上=ジャンプ、
 * 左右=横っとび、下=前へダイビングキャッチ）。無入力は null＝発動しない
 * （原作も「ボールに向けて+を入れA」であり、方向なしのファインプレイは無い）。
 * 斜め入力は塁指定（baseFromPadDirection）と同じく上下を優先する。
 */
export function finePlayKindFromPad(x: number, y: number): FinePlayKind | null {
  if (y > 0) return 'jump';
  if (y < 0 || x !== 0) return 'dive';
  return null;
}

/**
 * ファインプレイを行う野手を選ぶ（ボールにもっとも近い、投手以外の野手）。
 * 説明書p23「ピッチャーだけはファインプレイができません」に従い投手は候補から外す
 * （投手が最寄りでも次に近い野手が跳ぶ＝操作が空振りにならない）。
 * range 内に誰もいなければ null＝何も起きない（塁指定の「該当者なしなら空振り」と同じ扱い）。
 */
export function finePlayFielder(
  positions: Record<FielderId, Vec2>,
  ballPos: Vec2,
  range: number = FINE_PLAY_TRIGGER_RANGE,
): FielderId | null {
  let best: FielderId | null = null;
  let bestDist = Infinity;
  for (const id of FINE_PLAY_ELIGIBLE) {
    const d = distance(positions[id], ballPos);
    if (d > range || d >= bestDist) continue;
    bestDist = d;
    best = id;
  }
  return best;
}

/**
 * CPU守備のファインプレイ判断（決定的・乱数不使用。他の core/* と同じ設計方針）。
 *
 * 打球の軌道を跳んでいる時間ぶん（FINE_PLAY_ACTIVE_SEC）先読みし、「このまま立って
 * いては届かないが、跳べば届く」ときだけ跳ぶ。判断を**ボールが来る前に**下すのが要点で、
 * ボールが伸びたリーチに入った瞬間に跳ぶ実装だと同じフレームで捕球が成立してしまい、
 * 跳ぶ動作が画面に一度も出ない（＝リーチが伸びただけの、プレイヤーには理由の分からない
 * 捕球に見える）。先読みなら跳んでいる最中に捕るので、何が起きたのかが見える。
 *
 * 届くかどうかは**跳ぶ前の位置**で判定する（跳んだ勢いで進む5mぶんは加味しない）。
 * つまりCPUが得るのは「伸びたリーチ（2.6m→3.4m）」だけで、跳び込みの移動距離を稼ぐのは
 * 人間の読み勝ちに限る。CPUは判断を外さないので、これ以上与えると内野の間を抜ける
 * 打球が事実上なくなってしまう。
 */
export function chooseCpuFinePlay(
  positions: Record<FielderId, Vec2>,
  ball: BattedBall,
  dtStep = 1 / 60,
  bonusOf?: CatchRadiusBonus,
): { id: FielderId; kind: FinePlayKind; dir: Vec2 } | null {
  const id = finePlayFielder(positions, { x: ball.x, z: ball.z });
  if (id === null) return null;
  const p = positions[id];
  // 守備範囲のスキル（F-26-5）は「跳ぶかどうか」の判断にも同じだけ効かせる。
  // 効かせないと、範囲が広くて立ったまま届く球にもCPUが跳んでしまう（跳ぶ必要が無いのに
  // 跳んで、外せば起き上がりまで動けない＝スキルが不利益になる）。
  const bonus = Math.max(0, bonusOf?.(id) ?? 0);

  let candidate: { id: FielderId; kind: FinePlayKind; dir: Vec2 } | null = null;
  let b = ball;
  for (let t = 0; t < FINE_PLAY_ACTIVE_SEC; t += dtStep) {
    b = stepBattedBall(b, dtStep);
    const at = { x: b.x, z: b.z };
    // 跳ばなくても届く瞬間が窓の中にあるならファインプレイは不要（自動捕球に任せる）。
    // 窓の全体を見てから決めるのが要点：伸びたリーチの帯（2.6〜3.4m）は普通の捕球圏の
    // 外側にあるので、早い時刻のサンプルだけで決めると「そのまま捕れる球」にも跳んでしまう。
    if (canCatch(p, at, b.y, CATCH_RADIUS + bonus)) return null;
    if (candidate) continue;
    if (canCatch(p, at, b.y, FINE_PLAY_DIVE_RADIUS + bonus, CATCH_MAX_HEIGHT)) {
      const len = distance(p, at) || 1;
      candidate = { id, kind: 'dive', dir: { x: (at.x - p.x) / len, z: (at.z - p.z) / len } };
    } else if (canCatch(p, at, b.y, CATCH_RADIUS + bonus, FINE_PLAY_JUMP_HEIGHT)) {
      candidate = { id, kind: 'jump', dir: { x: 0, z: 0 } };
    }
  }
  return candidate;
}

/**
 * CPU守備が一時効果（`ケモノガエリ`）を切るかを判断するときの先読み幅（フェーズM-33）。
 *
 * **ファインプレイ（`FINE_PLAY_ACTIVE_SEC`）と同じ幅にしてある**のは、判断の中身が
 * 同じだから＝「このままでは届かないが、○○すれば届く」。別の値にすると、跳ぶ判断と
 * 切る判断でCPUの見えている未来の長さが違うことになる（人間はどちらも同じ打球を
 * 同じだけ見て決めている）。
 */
export const CPU_CATCH_EFFECT_LOOKAHEAD_SEC = FINE_PLAY_ACTIVE_SEC;

/**
 * CPU守備が一時効果（`ケモノガエリ`＝この打席だけ捕球範囲が広がる）を切るか
 * （決定的・乱数不使用。ユーザー判断：**場面を見て切る**）。
 *
 * 規則は `chooseCpuFinePlay` とまったく同じ形＝**このままでは届かないが、範囲が広がれば
 * 届く**ときだけ切る。打球を先読みし、素の範囲で捕れる瞬間が窓の中にあるなら切らない
 * （切っても結果が変わらない札を払わない）。CPU打者の規則（得点圏）と違って
 * 「ここぞ」の定義を持ち込まずに済むのは、守備側の一時効果には**届くか届かないかという
 * 客観的な境目**があるから。
 *
 * `radius` / `boosted` は呼び出し側が渡す（素の捕球半径＋その野手のスキル補正と、
 * そこへ一時効果を足した半径）＝**この関数はスキルの名前もロスターも知らない**
 * （`chooseCpuFinePlay` が `bonusOf` を受け取るのと同じ切り分け）。
 */
export function shouldCpuActivateCatchEffect(
  fielderPos: Vec2,
  ball: BattedBall,
  radius: number,
  boosted: number,
  dtStep = 1 / 60,
): boolean {
  if (boosted <= radius) return false;
  let hit = false;
  let b = ball;
  for (let t = 0; t < CPU_CATCH_EFFECT_LOOKAHEAD_SEC; t += dtStep) {
    b = stepBattedBall(b, dtStep);
    const at = { x: b.x, z: b.z };
    // 素の範囲で捕れる瞬間が窓の中にあるなら切らない。**窓の全体を見てから決める**のが
    // 要点で、早い時刻のサンプルだけで決めると「そのまま捕れる球」にも払ってしまう
    // （`chooseCpuFinePlay` が同じ理由で全域を走査しているのと同じ）。
    if (canCatch(fielderPos, at, b.y, radius)) return false;
    if (!hit && canCatch(fielderPos, at, b.y, boosted)) hit = true;
  }
  return hit;
}

/**
 * ランダンプレイ（説明書p25「ボールを捕ってから+で塁を指示しBを押すと、ボールを持った
 * 選手がその塁へダッシュします。指示しないときは1塁へ」）で、ボールを持った野手が
 * 走者にタッチできる距離。
 *
 * 捕球半径（CATCH_RADIUS=2.6）より意図的に狭くしてある。同じ広さだと、走者の脇を
 * かすめただけで勝手にタッチが成立し「間をつめて仕留める」（説明書p25の挟殺プレイ）
 * という操作そのものが消えてしまう。走者7.5m/s に対し野手8.5m/s＝1秒で1mしか
 * 詰められないので、この差が追いつくかどうかの読み合いになる。
 */
export const TAG_RADIUS = 1.6;

/**
 * ランダンプレイのタッチ判定：ボールを持った野手にもっとも近い、範囲内の走者を返す。
 *
 * 候補には「塁間を走っている走者」だけを渡すこと（塁上に留まっている走者・到達済みの
 * 走者は塁を踏んでいるのでタッチできない）。呼び出し側の live 判定と重複させないため、
 * ここでは絞り込みを行わない。
 */
export function tagTarget<T extends { pos: Vec2 }>(
  carrier: Vec2,
  runners: readonly T[],
  radius: number = TAG_RADIUS,
): T | null {
  let best: T | null = null;
  let bestDist = Infinity;
  for (const runner of runners) {
    const d = distance(carrier, runner.pos);
    if (d > radius || d >= bestDist) continue;
    bestDist = d;
    best = runner;
  }
  return best;
}

// ---- フォースプレーとタッチプレー（フェーズK-31。説明書p32「実際の野球のルール」） ----
//
// **J-30 が見つけた行き止まりの正体はここだった。** それまでこのゲームは走者を全員
// 「フォース走者」として扱っていて（`sendRunner` が自分で仕掛けた走者にも `ForcedRunner` を
// 与えていた）、**塁へ投げるだけで誰でも刺せた**。実際の野球で塁を踏むだけでアウトになるのは
// 打者走者に押し出されて走る義務がある走者だけで、それ以外はタッチしないとアウトにならない。
//
// この1つの区別を入れると、**走者に「戻る」という逃げ道が生まれる**（`npm run balance:rundown`
// の3段目：走力7.5で **28.6%** の場面が「前へ行けば刺されるが戻れば助かる」）。J-30 が測った
// 「送球では刺せないが走れば追える」帯（0.0%）と違って、**この帯は空ではない**。
//
// **走り続ける限り帰結は1つも変わらない**のが要点：塁で待つ野手はボールを持っているので、
// 走者が塁に着く前に必ずタッチ半径（TAG_RADIUS=1.6m）を通る（塁に着いた判定は
// BASE_ARRIVE_RADIUS=1.4m ＝タッチ半径の内側）。だから I-29 で測った内野ゴロ・犠飛・
// A-7 の盗塁の窓（0.45秒）・A-6 のけん制の境界（4.3m）はどれも動かない。
// 変わるのは「走者が引き返したとき、その送球が無駄になる」ことだけ。

/**
 * その走行区間がフォースプレーか＝**行き先の塁を踏まれるだけでアウトになるか**。
 *
 * 打球のプレーでは `forcedRunners` が返す連鎖（打者走者は常に／一塁走者は打者が入るので
 * 常に／二塁走者は一塁が埋まっているときだけ…）がそのままフォースの一覧になる。
 * 自分で仕掛けた進塁・盗塁・タッチアップ・帰塁はどれもこの一覧に入らない＝タッチプレー。
 */
export function isForcePlay(leg: ForcedRunner, forced: readonly ForcedRunner[]): boolean {
  return forced.some((f) => f.from === leg.from && f.to === leg.to);
}

/**
 * その塁への**送球だけ**で走者を刺せるか（K-31）。
 *
 * - フォースプレー → 塁を踏めばアウト（従来どおり。判定は送球のリリース時に確定する）。
 * - タッチプレーでも、**その塁へ向かって走っている**走者なら結果は同じ＝塁で待つ野手の
 *   タッチに自分から突っ込むので、送球で刺したのと1フレームも違わない帰結になる。
 *   違うのは「アウトが確定するのが送球のリリース時ではなくタッチの瞬間」という点だけで、
 *   だからこそ**リリース後に引き返せば、その送球は無駄になる**。
 * - **塁から遠ざかって止まっている走者**（バイクのオーバーラン＝F-26-3）だけは、投げても
 *   誰も触れない。守備は走って追うしかない（ランダンプレイ＝説明書p25）＝ここが
 *   **この守備モデルで初めて生まれる「追うしかない場面」**で、走者側のドロップキック
 *   （F-26-4）が意味を持つ唯一の局面でもある。
 */
export function throwRetiresRunner(forcePlay: boolean, approachingTargetBase: boolean): boolean {
  return forcePlay || approachingTargetBase;
}

// ---- CPU守備のランダン／CPU走者の引き返し・走り出し（フェーズJ-30） ----
//
// ここまでCPUは**捕ったら1回投げて終わり**で、走って追うことも、追われて引き返すことも、
// けん制のにらみ合いから走り出すこともしなかった（1P PLAY だけに残っていた非対称）。
// 挟殺（説明書p25）は「追う側」と「逃げる側」の両方がいて初めて成立するプレーなので、
// **人間が守備側でも攻撃側でも起きない**という穴がそのまま残っていた。
//
// **判定は既存の時間競争のまま**（送球＝距離÷THROW_SPEED、走者＝距離÷走力）で、
// ここに足すのは「どちらが先に着くか」「走って追えば途中で触れるか」を秒数で比べる
// 純粋関数だけ。CPU専用の分岐も、CPUだけが知っている情報も無い＝**人間が同じ操作で
// 同じことをできる**（桜井ノウハウ「人ができる範囲のこともずるいと思われるのはCPの常」）。

/** 起点から目標へ向かう速度ベクトル（同じ点なら 0 ベクトル＝止まっている扱い） */
function velocityTo(from: Vec2, to: Vec2, speed: number): Vec2 {
  const len = distance(from, to);
  if (len === 0) return { x: 0, z: 0 };
  return { x: ((to.x - from.x) / len) * speed, z: ((to.z - from.z) / len) * speed };
}

/**
 * 等速直線で動く2点が、時間 [0, tMax] のあいだにもっとも近づく距離 m。
 *
 * 相対位置は時間について1次なので、距離の2乗は上に凸でない2次式＝**最小値は
 * 頂点か区間の端のどちらか**で、閉じた式で解ける（フレームを刻んで探さない）。
 * 刻むと刻み幅より細い「すれ違い」を取りこぼし、フレームレートで結果が変わる。
 */
export function closestApproachDistance(
  aFrom: Vec2,
  aVel: Vec2,
  bFrom: Vec2,
  bVel: Vec2,
  tMax: number,
): number {
  const dx = aFrom.x - bFrom.x;
  const dz = aFrom.z - bFrom.z;
  const wx = aVel.x - bVel.x;
  const wz = aVel.z - bVel.z;
  const speedSq = wx * wx + wz * wz;
  let t = 0;
  if (speedSq > 0) {
    t = -(dx * wx + dz * wz) / speedSq;
    t = Math.max(0, Math.min(tMax, t));
  }
  return Math.hypot(dx + wx * t, dz + wz * t);
}

/** ランダンで追う相手の走り方（現在地・行き先・足の速さ。バイクの2倍速もそのまま渡す） */
export interface ChaseTarget {
  pos: Vec2;
  /** その走者が向かっている塁の座標 */
  target: Vec2;
  /** 走力（RUN）とバイクを反映した実際の足 m/s＝シーン層の runSpeed と同じ値 */
  speed: number;
}

/**
 * ボールを持った野手が**走って追えばその走者を仕留められるか**（ランダンプレイ）。
 *
 * 決着の仕方が2通りあるので、両方を同じ順序で見る（updateRundown の実装と同じ順）：
 * 1. **塁に先着する**（fielderTime <= runnerTime）＝そこへ向かっていた走者はアウト。
 * 2. **途中でタッチ半径に入る**＝走者を追い越さなくても、すれ違いざまに触れればアウト。
 *
 * 同着は野手有利にしてある（1の `<=`）：塁への到達は「実際にその塁へ立った時点」で
 * 判定するので、走者側の移動が先に済んでいるフレーム順のぶん走者に有利が残っている。
 */
export function canTagByRunning(
  carrier: Vec2,
  runner: ChaseTarget,
  fielderSpeed: number = FIELDER_SPEED,
  radius: number = TAG_RADIUS,
): boolean {
  if (runner.speed <= 0) return true; // 止まっている走者は必ず追いつかれる（転倒中など）
  const runnerTime = distance(runner.pos, runner.target) / runner.speed;
  const fielderTime = distance(carrier, runner.target) / fielderSpeed;
  if (fielderTime <= runnerTime) return true;
  const tMax = Math.min(runnerTime, fielderTime);
  const closest = closestApproachDistance(
    runner.pos,
    velocityTo(runner.pos, runner.target, runner.speed),
    carrier,
    velocityTo(carrier, runner.target, fielderSpeed),
    tMax,
  );
  return closest <= radius;
}

/**
 * CPU守備がランダンプレイを仕掛ける相手を決める（決定的・乱数不使用）。
 *
 * **呼び出し側は「送球では刺せない走者」だけを渡すこと**（ユーザー判断：送球で刺せない
 * ときだけ追う）。送球で刺せる走者に走って寄るのは、確実なアウトを遅い手段に置き換える
 * だけで一度も得をしない。
 *
 * 選ぶのは**もっとも進んだ走者**＝送球先の選び方（`live[live.length-1]`）と同じ順序。
 * 追えない相手しかいなければ null＝呼び出し側は従来どおり送球する（プレーが宙に浮かない）。
 */
export function chooseCpuRundown<T extends ChaseTarget>(
  carrier: Vec2,
  candidates: readonly T[],
  fielderSpeed: number = FIELDER_SPEED,
  radius: number = TAG_RADIUS,
): T | null {
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    if (canTagByRunning(carrier, candidates[i], fielderSpeed, radius)) return candidates[i];
  }
  return null;
}

/**
 * CPU守備がどの走者の塁へ投げるかを決める（決定的・乱数不使用。フェーズY-46）。
 *
 * `candidates` は**もっとも進んだ走者が最後**（シーン層の `live` と同じ並び）。
 * `wouldGet` は「その塁への送球1本でその走者を刺せるか」（`throwWouldGet` の写し）。
 *
 * 規則は2つだけ：
 *
 * - **1投目はもっとも進んだ走者の塁へ投げる**（安打でボールが内野へ返ってくる絵は
 *   従来のまま）。ただし**その走者を刺せず、他に刺せる走者がいるならそちらへ投げる**。
 *   これが無いと、押しバント（Y-46）で先頭走者が送球に勝てるようになった瞬間に、
 *   **確実に取れる打者走者を見送って二塁へ投げ、結局誰も刺せない**＝送りバントが
 *   「アウトと引き換え」ではなく丸ごと得になる（実機で踏んだ）。刺せる相手が1人も
 *   いなければ従来どおり先頭の塁へ投げる＝プレーが宙に浮かない。
 * - **2投目以降は刺せる走者だけを狙う**（K-31から不変）。無ければ null＝投げない。
 */
export function chooseCpuThrowTarget<T>(
  candidates: readonly T[],
  wouldGet: (runner: T) => boolean,
  threwOnce: boolean,
): T | null {
  const lead = candidates[candidates.length - 1] ?? null;
  let gettable: T | null = null;
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    if (wouldGet(candidates[i])) {
      gettable = candidates[i];
      break;
    }
  }
  if (threwOnce) return gettable;
  if (lead === null) return null;
  return wouldGet(lead) ? lead : gettable ?? lead;
}

/**
 * CPU走者が引き返すか（挟殺の「逃げる側」。決定的・乱数不使用）。
 *
 * 規則は実際の走塁判断そのもので、**進めば刺されるが、戻れば助かるとき**だけ引き返す。
 * 「刺される」の中身は送球とランダンの2通りで、どちらも守備側が実際に取れる手段と
 * 同じ式で見る（送球＝`releaseThrow` の時間競争／ランダン＝`canTagByRunning`）。
 *
 * - **進んでも助かるなら引き返さない**：塁に着けば安全なので戻る理由が無い。
 * - **戻っても刺されるなら引き返さない**：どちらも刺されるなら、進んだほうが
 *   進塁の可能性が残る（＝損の少ないほうを選ぶ）。これが無いと、追われた走者が
 *   必ず後ろへ逃げて挟殺が「必ず戻る側の負け」になる。
 *
 * **`throwDelaySec`（守備がまだ投げられない残り時間）を必ず渡すこと。** フライ捕球後の
 * 持ち替え（`FLY_CATCH_RELEASE_SEC`=1.5秒）や盗塁の投球到達待ちの最中は、送球はその
 * ぶん遅れて出る。ここを 0 のままにすると**タッチアップ（説明書p19）が成立しなくなる**：
 * 外野の深いフライで `chooseCpuTagUp` が「送球が間に合わないから走れ」と判断した直後に、
 * この関数が持ち替えを無視して「進めば刺される」と読み、走り出した走者をその場で
 * 引き返させてしまう（＝**2つのCPU規則が同じ場面で反対の結論を出す**）。同じ遅れを
 * 両方に効かせれば、犠牲フライが成立する深さ（約73m）の導出とも自動的に一致する。
 */
export interface RunnerChase {
  /** ボールを持っている野手 */
  carrier: Vec2;
  runner: Vec2;
  /** いま向かっている塁 */
  ahead: Vec2;
  /** 引き返す先の塁（走ってきた起点） */
  behind: Vec2;
  speed: number;
  /** 守備がまだ投げられない残り時間 s（持ち替え・投球到達待ち。既定は「すぐ投げられる」） */
  throwDelaySec?: number;
  throwSpeed?: number;
  fielderSpeed?: number;
  radius?: number;
}

/**
 * その塁へ向かったら刺されるか。**守備が実際に取れる2つの手段**（塁へ投げる／走って
 * 追う）を、シーン層の `releaseThrow`・`updateRundown` とまったく同じ式で見る。
 *
 * 走者の判断（引き返す・止まる）はどれもこの1つの問いの組み合わせなので、ここに集めて
 * おかないと**同じ場面で違う結論を出す規則**ができる（J-30で実際に踏んだ：引き返しの
 * 規則が犠牲フライを取り消した）。
 */
function caughtHeadingTo(opts: RunnerChase, to: Vec2): boolean {
  const {
    carrier,
    runner,
    speed,
    throwDelaySec = 0,
    throwSpeed = THROW_SPEED,
    fielderSpeed = FIELDER_SPEED,
    radius = TAG_RADIUS,
  } = opts;
  return (
    throwDelaySec + distance(carrier, to) / throwSpeed < distance(runner, to) / speed ||
    canTagByRunning(carrier, { pos: runner, target: to, speed }, fielderSpeed, radius)
  );
}

export function shouldCpuRetreat(opts: RunnerChase): boolean {
  if (!caughtHeadingTo(opts, opts.ahead)) return false;
  return !caughtHeadingTo(opts, opts.behind);
}

/**
 * けん制のにらみ合いから、CPU走者が次の塁へ走り出すか（決定的・乱数不使用）。
 *
 * 規則は1つ：**その塁への送球が間に合わないなら走る**。投手がマウンドでボールを
 * 持っている間はどの塁へも送球が先に着くので走らない（従来どおりのにらみ合い）が、
 * **守備側がランダンで走者へ寄ってくると送球の起点が塁から遠ざかる**ので、そこで初めて
 * 走る目が出る＝「詰めるか、塁に残るか」という守備側の判断に意味が生まれる。
 *
 * 同着は走者不利（`>=` で走る＝厳密に間に合うときだけ）ではなく、送球の判定
 * （`releaseThrow` は `throwTime < runnerTime` のときだけアウト）と揃えてある。
 */
export function shouldCpuBreakForNextBase(opts: {
  carrier: Vec2;
  runner: Vec2;
  /** 次の塁 */
  next: Vec2;
  speed: number;
  throwSpeed?: number;
}): boolean {
  const { carrier, runner, next, speed, throwSpeed = THROW_SPEED } = opts;
  return distance(carrier, next) / throwSpeed >= distance(runner, next) / speed;
}

// ---- 走者が塁間で止まる（フェーズN-34。説明書p25の挟殺の「逃げる側」の3つ目の手） ----
//
// K-31 が「行くか戻るか」を作った後も、**前へ行っても戻っても刺される**場面
// （`npm run balance:rundown` の3段目「どちらも×」＝走力7.5で20.8%）には手が1つも
// 無かった。走者が止まれると、非フォースの走者には `throwRetiresRunner` が false を
// 返す＝**塁へ投げても触れない**ので、守備は走って追うしかなくなる（＝バイクの
// オーバーランに続く2つ目の「追うしかない場面」で、こちらはスキル不要）。
//
// 計測（同4段目）で分かったこと：
// - **止まると72%の場面で時間が稼げる**（平均1.82秒＝他の走者が13.7m走れる）。
//   そのうち 6.6% は他の走者が塁間まるごと1つぶん進める＝**1人を差し出して1つ進める**
//   という、実際の野球の挟殺の値打ちがそのまま出る。
// - **止まった本人が逃げ切れる場面は 0.0%**。走者は2つの塁を結ぶ線の上にいるので、
//   その走者へ寄る野手は必ず線にも寄る＝どちらへ走り出しても追いつかれる（J-30が
//   測った「送球では刺せないが走れば追える」帯が0.0%だったのと同じ幾何が効いている）。
//   **止まるのは自分が助かる手ではなく、他の走者のために時間を買う手**。
//
// **枷は「1プレーに1回」**（ユーザー判断）。バイクの点火・ドロップキック・引き返しと
// まったく同じ規則で、これが無いと止まる／走るを繰り返して挟殺が永久に終わらない。

/**
 * 止まっている走者を、その塁へ走る**道中で**タッチできるか（フェーズN-34）。
 *
 * `canTagByRunning` はこの用途には使えない：あちらは「塁への競争に勝てるか」を先に見るので、
 * **止まっている走者に対しては必ず true** になる（永久に塁へ着かないため）。ところが
 * 塁に先着しても、非フォースの走者は塁を踏まれただけでは刺されない＝**すでにその塁に
 * 立っている野手が「追いついた」ことになってしまい、実際には6m離れたまま**になる
 * （実機で踏んだ：CPUが自分の立っている塁へ「追いかけ」て、1回きりのランダンを空振りした）。
 *
 * 見るべきは塁への到達ではなく**通り道**で、走者は2つの塁を結ぶ線上にいるので、
 * 反対側の塁へ走れば必ずタッチ半径を通る。判定は既存の最接近距離
 * （`closestApproachDistance`）そのままで、走者の速度を0ベクトルにするだけ。
 */
export function tagsOnTheWay(
  carrier: Vec2,
  runner: Vec2,
  base: Vec2,
  fielderSpeed: number = FIELDER_SPEED,
  radius: number = TAG_RADIUS,
): boolean {
  const travel = distance(carrier, base) / fielderSpeed;
  return (
    closestApproachDistance(
      runner,
      { x: 0, z: 0 },
      carrier,
      velocityTo(carrier, base, fielderSpeed),
      travel,
    ) <= radius
  );
}

/**
 * CPU走者がその場に止まるか（決定的・乱数不使用。ユーザー判断：**CPUも止まる**）。
 *
 * 規則は `shouldCpuRetreat` が false を返した後の残り＝**進んでも戻っても刺される**とき。
 * ただし止まるのは**他に走っている走者がいるとき**だけにする：上の計測どおり止まった
 * 本人は助からないので、単独走者で止まっても「刺されるまでの時間が延びるだけ」＝
 * 画面上はCPUが意味もなく立ち止まったように見える（＝バグに見える）。
 *
 * CPUが仕掛けられないと、1P PLAY で人間が守備側のときにこの読み合いが一度も起きない
 * （F-26-4のドロップキックで踏んだ非対称と同じ）。
 */
export function shouldCpuHold(
  opts: RunnerChase & {
    /** 他に走っている走者がいる（＝止まって時間を稼ぐ意味がある） */
    helpsOtherRunners: boolean;
  },
): boolean {
  if (!opts.helpsOtherRunners) return false;
  return caughtHeadingTo(opts, opts.ahead) && caughtHeadingTo(opts, opts.behind);
}

/**
 * 止まっているCPU走者が走り出すか（走り出すならどちらの塁へ）。決定的・乱数不使用。
 *
 * - **進めば助かるなら進む／戻れば助かるなら戻る**（`shouldCpuRetreat` と同じ見方）。
 *   守備が詰めてくれば送球の起点が塁から遠ざかるので、この目は実際に開きうる。
 * - **時間を稼ぐ相手がいなくなったら必ず走り出す**（`helpsOtherRunners` が false）。
 *   止まる理由が消えた走者を止めたままにすると、**誰も動かずプレーが畳まれない**
 *   （バイクのオーバーランでCPUが必ず自分で戻る `BIKE_CPU_RETURN_SEC` と同じ、
 *   「CPUの側では必ず決着する」ための保証）。
 * - `canRetreat` は1プレーに1回の引き返し（K-31の `retreatUsed`）が残っているか。
 */
export function chooseCpuHoldRelease(
  opts: RunnerChase & { canRetreat: boolean; helpsOtherRunners: boolean },
): 'ahead' | 'behind' | null {
  if (!caughtHeadingTo(opts, opts.ahead)) return 'ahead';
  if (opts.canRetreat && !caughtHeadingTo(opts, opts.behind)) return 'behind';
  return opts.helpsOtherRunners ? null : 'ahead';
}

/**
 * タッチアップ（説明書p19「外野フライを捕られた瞬間にランナーを一気に進塁させる」）で、
 * フライを捕った野手が送球できるようになるまでの時間（捕球姿勢からの持ち替え・ステップ）。
 *
 * この時間が無いとタッチアップは物理的に一度も成立しない。走者の塁間は
 * BASE_PATH(27.4m) ÷ RUNNER_SPEED(7.5m/s) ≒ 3.65秒かかるのに対し、この守備モデルの
 * 送球は THROW_SPEED(34m/s) の直線飛行（滞空も中継も無い）なので、フェンス際(100m)から
 * 本塁へ投げてもわずか2.9秒＝どれだけ深いフライでも走者は必ず刺されてしまう。
 *
 * 送球そのものを遅くすると既存のゴロの守備（一塁送球のきわどさ）まで作り直しになるため、
 * 「フライを捕ってから投げ始めるまでの実時間」としてここだけに時間を足す。犠牲フライが
 * 成立する分岐点の深さは
 *   D = (BASE_PATH / RUNNER_SPEED - FLY_CATCH_RELEASE_SEC) * THROW_SPEED
 *     = (3.65 - 1.5) * 34 ≒ 73m（外野の定位置80m前後より手前）
 * となり、「外野まで運べば三塁走者は還れる／内野〜浅い外野なら刺される」という、
 * 原作の“外野フライで一気に進塁”とも実際の野球の犠牲フライとも合う挙動になる。
 */
export const FLY_CATCH_RELEASE_SEC = 1.5;

/**
 * 従来のCPUのタッチアップの境界（本塁からの捕球深度 m）。**フェーズS-40で走力を
 * 見る時間の比較（下記）に置き換えたが、基準速の走者ではこの深さと一致する**
 * ＝平均的な走者のタッチアップの手触り（A-2で実機調整した犠牲フライの分岐点）は不変。
 * 計測とテストの基準線として残してある。
 */
export const CPU_TAG_UP_MIN_DEPTH = 78;

/**
 * CPUがタッチアップを仕掛けるのに要る、**完璧な送球に対する不足の秒数**。
 * 下の「守備に残る余裕」が `-CPU_TAG_UP_MARGIN_SEC` 以下、つまり
 * **完璧な送球でもこれだけ間に合わない**ときにだけ走る（同着では走らない）。
 *
 * 0.14秒は `npm run balance:identity` の4b段目が決めた＝**基準速（走力0.5）の走者の
 * 境界がちょうど従来の 78m** になる値（差 0.0m）。R-39が `CPU_STEAL_JUMP_SEC` を
 * 動かさずに「誰が走るか」だけを変えたのとまったく同じ整理で、**変わるのは
 * 俊足・鈍足の走者の判断だけ**（名鑑192人で境界は 68m〜86m に開く。従来は全員78m）。
 */
export const CPU_TAG_UP_MARGIN_SEC = 0.14;

/**
 * その走者がタッチアップしたときの「守備に残る余裕」（秒。フェーズS-40）。
 * **正なら完璧な送球で刺せ、その秒数だけ遅れても間に合う。負なら完璧な送球でも
 * 間に合わない**＝`cpuStealDefenseSlack`（R-39）とまったく同じ向き・同じ形。
 *
 * 守備の時間＝**捕球姿勢からの持ち替え**（`FLY_CATCH_RELEASE_SEC`）＋捕球点から
 * 投げる塁までの送球時間。走者の時間＝塁間 ÷ その走者の足。
 *
 * 走る先の塁で送球距離が変わるのが要点で、**三塁は本塁より一塁側から遠い**ので、
 * 二塁→三塁は右方向の打球でだけ成立する（4c段目：基準速・深さ78mで 右翼線 -0.28秒＝
 * 走れる／左翼線 +0.67秒＝刺される）。実際の野球の「右方向のフライで進塁する」と同じ形。
 */
export function cpuTagUpDefenseSlack(
  from: 'second' | 'third',
  catchPoint: Vec2,
  speed: number = RUNNER_SPEED,
): number {
  const to = BASE_POSITIONS[advancedBase(from)];
  const runSec = distance(BASE_POSITIONS[from], to) / Math.max(0.1, speed);
  const defenseSec = FLY_CATCH_RELEASE_SEC + distance(catchPoint, to) / THROW_SPEED;
  return runSec - defenseSec;
}

/**
 * CPU攻撃側のタッチアップ判断（決定的・乱数不使用。他の core/* と同じ設計方針）。
 *
 * **フェーズS-40で「深さ78m固定・三塁走者だけ」から、走力を見る時間の比較へ置き換え、
 * 二塁→三塁も対象に広げた**（ユーザー判断）。それまでは俊足の走者も鈍足の走者も
 * まったく同じ深さで還り、二塁走者は右翼への大飛球でも動かなかった
 * （B-12が「CPUは球団の個性を活かさない」として記録した穴の、走塁側の残り）。
 *
 * 規則は `chooseCpuSteals`（R-39）と同じ2つの掛け合わせ：
 * - **塁が空いているか**＝三塁走者は本塁が常に空いている／二塁走者は三塁が空いているか、
 *   三塁走者も走る（＝空く）とき。塁を追い越す走塁が構造的に起きない。
 * - **走る値打ちがあるか**＝`cpuTagUpDefenseSlack` が `-CPU_TAG_UP_MARGIN_SEC` 以下。
 *
 * 並びは**本塁に近い順**（`chooseCpuSteals`・`sendableRunnerBases` と同じ）。
 * 人間の攻撃側は従来どおり塁を指定すればどの走者でも仕掛けられる＝**ギャンブルは
 * プレイヤーの裁量に残す**（`chooseCpuSteals` と同じ切り分け）。
 *
 * catchPoint は「捕った野手の位置」＝送球の起点を渡すこと（ボールの座標ではない。
 * 捕球はボールが捕球半径 CATCH_RADIUS に入った瞬間に成立するので、その時点の
 * ボールの座標は野手より数メートル手前にあり、実際に投げる距離と食い違う）。
 */
export function chooseCpuTagUp(
  bases: Bases,
  catchPoint: Vec2,
  speedOf?: (from: 'second' | 'third') => number,
): Array<'second' | 'third'> {
  const worth = (from: 'second' | 'third'): boolean =>
    cpuTagUpDefenseSlack(from, catchPoint, speedOf?.(from) ?? RUNNER_SPEED) <=
    -CPU_TAG_UP_MARGIN_SEC;
  const list: Array<'second' | 'third'> = [];
  const thirdRuns = bases.third && worth('third');
  const secondRuns = bases.second && (!bases.third || thirdRuns) && worth('second');
  if (thirdRuns) list.push('third');
  if (secondRuns) list.push('second');
  return list;
}

// ---- 打球での余分な進塁（フェーズX-45。説明書p16「+で進塁する塁を指定しB」） ----
//
// CPU攻撃が打球中に仕掛けるのは**フライのタッチアップだけ**（上の `chooseCpuTagUp`）で、
// **`sendRunner`（フォースされていない走者を次の塁へ送る）は人間の攻撃側しか使わなかった**
// ＝J-30以来「CPUだけが持っていない判断」を埋めてきた最後の1つ（攻撃側の走塁）。
//
// **同じセッションで送りバント・スクイズは計測して見送っている**（`balance:offense`）。
// バントは**打球を本塁のすぐ近くに置く手**なので送球距離が最短になり、送球（34m/s）が
// 走者の4.5倍という構造がいちばん不利に出る。こちらに帯があるのはちょうど裏返しの理由で、
// **外野へ抜けた打球は送球距離が長い**（深いフライならタッチアップで還れるのと同じ）。
//
// **判断するのは打球の瞬間**。守備がボールを確保してから決めたのでは、走者はそこから
// 塁間を走ることになって（3.3〜4.0秒）どんな送球にも勝てない＝実際の野球と同じく
// 「打った瞬間に走るかどうかを決める」形になる。そのため守備の時間は**着地点の予測**
// （`predictLandingAt`＝CPU守備が追いかける先とまったく同じ情報）から見積もる。
// 転がって伸びるぶんを見込まないので**必ず短めに出る＝走者に厳しい側**の見積もり。

/**
 * その走者が次の塁まで走ったときに**守備に残る余裕**（秒。フェーズX-45）。
 * `cpuTagUpDefenseSlack`（S-40）・`cpuStealDefenseSlack`（R-39）と**同じ向き・同じ形**
 * ＝正なら完璧な送球で刺せ、負なら完璧な送球でも間に合わない。
 *
 * 守備の時間に**確保から送球までの遅れを含めない**のが要点（＝完璧な守備）。フライの
 * タッチアップと違ってゴロには持ち替えの規則（`FLY_CATCH_RELEASE_SEC`）が無く、
 * 人間の守備は確保した瞬間に投げられるため。実際のCPU守備は反応の間を置くので、
 * そのぶんは走者にとって余分な保険になる。
 */
export function cpuExtraBaseSlack(opts: {
  from: 'first' | 'second' | 'third';
  speed: number;
  /** 守備がボールを確保すると見込まれる地点（＝送球の起点） */
  securePoint: Vec2;
  /** 打球発生から確保までの見込み秒数 */
  secureSec: number;
}): number {
  const to = BASE_POSITIONS[advancedBase(opts.from)];
  const runSec = distance(BASE_POSITIONS[opts.from], to) / Math.max(0.1, opts.speed);
  const defenseSec = opts.secureSec + distance(opts.securePoint, to) / THROW_SPEED;
  return runSec - defenseSec;
}

/**
 * CPU攻撃側の「もう1つ先の塁を狙う」判断（決定的・乱数不使用）。
 *
 * 余白は **`CPU_TAG_UP_MARGIN_SEC` をそのまま使う**（新しい自由変数を作らない＝W-44が
 * `FATIGUE_CONTROL_LOSS` を `FATIGUE_SPEED_DROP` に揃えたのと同じ整理）。意味も同じ
 * 「完璧な送球に対する不足の秒数」で、`npm run balance:offense` の11段目が
 * **ぎりぎりの突入（最悪 -0.06秒）が -0.17秒まで下がり、帯は基準速で62.7%残る**ことを
 * 確かめている。
 *
 * @param candidates 仕掛けられる走者（`sendableRunnerBases` の結果＝**本塁に近い順**）
 * @returns 実際に仕掛ける走者の起点（本塁に近い順）
 */
export function chooseCpuExtraBases(
  candidates: ReadonlyArray<'first' | 'second' | 'third'>,
  opts: {
    securePoint: Vec2;
    secureSec: number;
    speedOf?: (from: 'first' | 'second' | 'third') => number;
    margin?: number;
  },
): Array<'first' | 'second' | 'third'> {
  const margin = opts.margin ?? CPU_TAG_UP_MARGIN_SEC;
  const going: Array<'first' | 'second' | 'third'> = [];
  for (const from of candidates) {
    const slack = cpuExtraBaseSlack({
      from,
      speed: opts.speedOf?.(from) ?? RUNNER_SPEED,
      securePoint: opts.securePoint,
      secureSec: opts.secureSec,
    });
    // **前の走者が行かないなら、その塁は空かない＝後ろの走者も進めない**
    // （`chooseCpuTagUp` の「二塁走者が動けるのは三塁走者も走るとき」と同じ連鎖。
    //  候補は本塁に近い順なので、行かない走者が出た時点で打ち切ればよい）。
    if (slack > -margin) break;
    going.push(from);
  }
  return going;
}

// ---- けん制球（説明書p24「Bで"ちっちゃいモード"に切替→+で塁を指示→A」） ----

/**
 * けん制モード中、塁上の走者が塁を離れていく速さ（m/s）。
 * 全力疾走（RUNNER_SPEED=7.5）よりずっと遅い＝「じりじり離れる」表現。
 * リードは時間とともに広がるので、投手側は「投げるのが早すぎると浅くて刺せない／
 * 遅すぎると窓（PICKOFF_WINDOW_SEC）が閉じて投球に戻される」というタイミングの
 * 判断になる。
 */
export const LEAD_SPEED = 2.6;

/** 人間の走者が取れるリードの上限（m）。これ以上は離れない */
export const MAX_LEAD = 6;

/**
 * その塁の走者を投手のけん制球で刺せる最小のリード距離（m）。
 *
 * 送球の到達時間（距離÷THROW_SPEED）の間に走者が戻れる距離そのもの。実際の判定は
 * シーン層の送球（releaseThrow の時間競争）が行い、同着は走者有利なので
 * 「これを**超える**リード」で初めてアウトになる。CPUの判断とテストの基準値を
 * 1か所に集めるための関数。
 *
 * 第3引数の `speed`（フェーズS-40）は**その走者の実際の足の速さ**。**速い走者ほど
 * 深く出ても戻れる**＝境界そのものが走力の関数になる。既定は基準速（走力0.5）なので、
 * 渡さない呼び出しはS-40の前と完全に同じ値を返す（`stealSafeJumpSec` にR-39が
 * 走力を足したのとまったく同じ整理）。
 */
export function pickoffOutLead(
  base: BaseKey,
  pitcherPos: Vec2,
  speed: number = RUNNER_SPEED,
): number {
  return (distance(pitcherPos, BASE_POSITIONS[base]) / THROW_SPEED) * Math.max(0.1, speed);
}

/**
 * 塁から次の塁の方向へ lead メートル離れた位置（リード中の走者の立ち位置）。
 * 塁間を超えるリードは無い（次の塁に着いてしまう）ので塁間距離でクランプする。
 */
export function leadPosition(from: 'first' | 'second' | 'third', lead: number): Vec2 {
  const origin = BASE_POSITIONS[from];
  const next = BASE_POSITIONS[advancedBase(from)];
  const dx = next.x - origin.x;
  const dz = next.z - origin.z;
  const len = Math.hypot(dx, dz) || 1;
  const d = Math.max(0, Math.min(lead, len));
  return { x: origin.x + (dx / len) * d, z: origin.z + (dz / len) * d };
}

/**
 * **その走者がリードを取るときに押し続ける塁の方向**（フェーズII-56）＝`advancedBase` と
 * 同じ「次の塁」。塁の指定はこのゲームでは常に絶対方向（上=二塁/左=三塁/右=一塁/下=本塁）
 * なので、**一塁走者は上・二塁走者は左・三塁走者は下**を押している間だけリードが伸びる。
 *
 * **盗塁と同じ入力の延長**になっているのが要点：そのまま J を足せばその塁への盗塁で、
 * K を足せば帰塁（`recallTargetBase` は帰る塁＝起点を指すので押す向きは逆になる）。
 *
 * 別名として置いてあるのは、**「リードは走者が自分から取るもの」**という II-56 の
 * 決めごとを、位置の計算（`leadPosition`）とは別の言葉で残しておくため。
 */
export function leadDirectionBase(from: 'first' | 'second' | 'third'): BaseKey {
  return advancedBase(from);
}

/** けん制できる塁（走者がいる塁）。1つも無ければけん制モードに入る意味がない */
export function pickoffBases(bases: Bases): Array<'first' | 'second' | 'third'> {
  const list: Array<'first' | 'second' | 'third'> = [];
  if (bases.third) list.push('third');
  if (bases.second) list.push('second');
  if (bases.first) list.push('first');
  return list;
}

/**
 * CPU走者が取るリードの深さ（決定的・乱数不使用。他の core/* と同じ設計方針）。
 *
 * **一・二塁の走者はけん制で刺される深さまでリードし、三塁走者は刺されない深さで止まる。**
 * 三塁でアウトになる損失が大きいという実際の野球の感覚に合わせた区別で、結果として
 * 「一・二塁の走者にはけん制が効き、三塁走者には効かない」という、プレイヤーが
 * 学習できる明快なルールになる（刺せるかどうかは pickoffOutLead との大小関係で決まり、
 * テストで固定してある）。
 *
 * CPU走者はけん制モード中に走り出さない（既存の「CPU走者は追われても引き返さない」と
 * 同じv1の割り切り）。そのぶん投手側の判断は「リードが育つのを待って、窓が閉じる前に
 * 投げる」というタイミング一点に絞られる。
 *
 * ## フェーズS-40：深さだけを走力で決める（B-12の「球団の個性」の残り）
 *
 * それまでは 5.2m / 3.6m の**固定2値**で、**俊足の走者も鈍足の走者もまったく同じ深さ**
 * まで出ていた（R-39で盗塁だけが走力を見るようになり、リードは取り残されていた）。
 *
 * **踏み越し幅は距離ではなく時間で持つ**のが要点（`npm run balance:identity` の5段目）。
 * 刺される境界（`pickoffOutLead`）自体が走力の関数なので、距離で一定の踏み越しにすると
 * **俊足ほど「時間で見た踏み越し」が浅くなり、けん制が効かなくなっていく**。時間で持てば
 * **どの走者もちょうど同じだけ帰塁が間に合わない**＝ユーザー判断どおり
 * 「けん制はどの走者にも効くまま、深さだけが走力で決まる」になる。
 */
/**
 * 一・二塁：刺される境界を**この秒数ぶん踏み越す**。0.12秒は
 * `balance:identity` の5段目が決めた＝**基準速（走力0.5）で一塁 5.18m ＝ 従来の 5.2m**
 * （差 -0.02m）。R-39が `CPU_STEAL_JUMP_SEC` を動かさなかったのと同じ「基準線を
 * 動かさない」整理で、平均的な走者のけん制の手触り（A-6で実機調整した境界）は不変。
 */
export const CPU_LEAD_OVER_SEC = 0.12;
/**
 * 三塁：刺される境界の**この秒数ぶん手前で止まる**。0.09秒で
 * **基準速の三塁 3.60m ＝ 従来の 3.6m ちょうど**（同5段目）。
 */
export const CPU_LEAD_UNDER_SEC = 0.09;

/** 従来の固定2値（基準速のときの値と一致する。テストと計測の基準線として残す） */
export const CPU_LEAD_AGGRESSIVE = 5.2;
export const CPU_LEAD_CAUTIOUS = 3.6;

export function cpuLeadDistance(
  from: 'first' | 'second' | 'third',
  speed: number = RUNNER_SPEED,
  pitcherPos: Vec2 = FIELDER_HOME_POSITIONS.P,
): number {
  const boundary = pickoffOutLead(from, pitcherPos, speed);
  const margin = (from === 'third' ? -CPU_LEAD_UNDER_SEC : CPU_LEAD_OVER_SEC) * Math.max(0.1, speed);
  // 人間の上限を超えて出ることはない（同じ画面に並ぶので、CPUだけ深く出られると読めない）
  return Math.max(0, Math.min(MAX_LEAD, boundary + margin));
}

/**
 * CPU投手がけん制球を投げるときの上乗せ（m）。刺せる距離ちょうどで投げると
 * 人間の走者に帰塁（A）を押す余地が無くなるため、少しだけ育つのを待ってから投げる。
 */
export const CPU_PICKOFF_MARGIN = 0.8;

/**
 * CPU投手のけん制送球判断（決定的・乱数不使用）。
 * 刺せる深さ（pickoffOutLead）＋マージンまでリードした塁があれば、その中で
 * もっとも本塁に近い塁（＝アウトの価値が高い塁）へ投げる。無ければ null＝まだ投げない。
 */
export function chooseCpuPickoffThrow(
  pitcherPos: Vec2,
  leads: Partial<Record<'first' | 'second' | 'third', number>>,
  margin: number = CPU_PICKOFF_MARGIN,
): 'first' | 'second' | 'third' | null {
  for (const base of ['third', 'second', 'first'] as const) {
    const lead = leads[base];
    if (lead === undefined) continue;
    if (lead > pickoffOutLead(base, pitcherPos) + margin) return base;
  }
  return null;
}

// ---- 盗塁（説明書p13「盗塁しようとすると"ちっちゃいモード"に変わる」） ----

/**
 * 盗塁のスタート位置の**既定値**（塁から離れているリードの距離 m）。
 *
 * けん制モードのリード（LEAD_SPEED で育つ可変値）とは別に、投球中の走者は
 * 「標準的なリードを取っている」ものとして扱う。塁の真上から走り出すモデルにすると
 * 下の時間計算どおり**どの投球でも必ず刺される**ため、盗塁という操作自体が成立しない。
 *
 * **フェーズL-32から「既定値」になった**：直前にけん制のプレーがあった打席では、
 * そこで残ったリード（0〜MAX_LEAD）が持ち越されてこの値を置き換える
 * （`resolveCarriedLeads`）。けん制を挟まない打席では従来どおり全員がこの値なので、
 * A-7で調整した窓（一塁走者で0.45秒）はそのまま動いていない。
 */
export const STEAL_LEAD = 3.5;

/**
 * 盗塁で捕手が投球を捕ってから塁へ投げられるようになるまでの時間（＝ポップタイム相当）。
 *
 * FLY_CATCH_RELEASE_SEC と同じ事情でここにも時間が要る：この守備モデルの送球は
 * THROW_SPEED=34m/s の直線飛行で、本塁→二塁は 38.76m ÷ 34 ≒ 1.14秒しかかからない。
 * 一方で走者は BASE_PATH(27.4m) から STEAL_LEAD を引いた 23.9m を RUNNER_SPEED で
 * 走るので 3.19秒。捕った瞬間に投げられると、どんなに good jump でも必ず刺される。
 *
 * 値は「仕掛けてよいタイミングの窓」から逆算してある（stealSafeJumpSec 参照）。
 * 1.6秒だと一塁走者の境界は残り 0.447秒＝**ワインドアップ中〜リリース直後**まで。
 * 原作の「モーションを見てスタートを切る」感覚に合う窓で、遅れれば刺される。
 */
export const STEAL_CATCH_RELEASE_SEC = 1.6;

/**
 * 盗塁が成功する「投球の残り時間」の境界（秒）。仕掛けた瞬間に投球の残りが
 * これ**以上**あればセーフ、下回っていればアウト。
 *
 * 捕手は「投球が届く（残り時間）＋持ち替え（STEAL_CATCH_RELEASE_SEC）」の後に投げるので、
 * 走者の所要時間との差がそのまま境界になる。走者側の操作は「いつスタートを切るか」だけ
 * なので、この1本の式が盗塁の判断のすべてを決める（実際の判定はシーン層の送球の
 * 時間競争（releaseThrow）が行い、けん制と同じ経路を通る）。
 *
 * 塁ごとに難易度が変わるのが要点：一塁→二塁は本塁から遠いので投げるのに時間がかかり
 * 窓が広い。二塁→三塁は送球距離が塁間そのもの（27.4m）で窓が狭く、三塁→本塁は
 * 捕手が塁に立っている（送球距離0）ので**どんなスタートでも刺される**。
 *
 * 第4引数の `speed`（フェーズR-39）は**その走者の実際の足の速さ**。既定は基準速
 * （`RUNNER_SPEED`＝走力0.5）なので、渡さない呼び出しはR-39の前と完全に同じ値を返す
 * （B-8で能力値の中央を従来の定数に合わせたのと同じ整理）。渡すのはCPUの盗塁の判断
 * （`chooseCpuSteals`）で、**俊足ほど窓が広い＝仕掛ける値打ちがある**という差がここから出る。
 */
export function stealSafeJumpSec(
  from: 'first' | 'second' | 'third',
  catcherPos: Vec2 = BASE_POSITIONS.home,
  lead: number = STEAL_LEAD,
  speed: number = RUNNER_SPEED,
): number {
  const throwTime = distance(catcherPos, BASE_POSITIONS[advancedBase(from)]) / THROW_SPEED;
  const runnerTime = (BASE_PATH - lead) / Math.max(0.1, speed);
  return runnerTime - throwTime - STEAL_CATCH_RELEASE_SEC;
}

/**
 * CPU攻撃側が盗塁を仕掛けるときの「投球の残り時間」（秒）。この値まで投球が進んだ
 * フレームで走り出す。
 *
 * stealSafeJumpSec('first') より**小さく**してあるのが要点で、CPUのスタートは常に
 * 「完璧な送球なら刺せる」遅さになる＝人間の捕手が送球（K+上）を出しさえすれば刺せる。
 * 逆に見送れば盗塁が決まるので、守備側にちゃんと操作の意味が生まれる（けん制で人間の
 * 走者が帰塁を押し遅れると刺されるのと同じ設計）。
 */
export const CPU_STEAL_JUMP_SEC = 0.25;

/**
 * CPUが盗塁を仕掛ける上限＝**その走者が走ったとき、守備に残る余裕**（秒。フェーズR-39）。
 *
 * CPUのスタートは `CPU_STEAL_JUMP_SEC`（0.25秒）に固定してある＝完璧な送球なら刺せる
 * 遅さ。その「刺せる余裕」は走者の足で縮む（`npm run balance:lineup` の6段目）：
 * 標準リードの二盗で **走力0.0＝0.53秒 → 0.5＝0.20秒 → 1.0＝-0.08秒**。
 *
 * **人の反応時間（約0.2秒）より小さいところから上が「仕掛ける値打ちのある走者」**で、
 * そこまで縮んでいれば守備は先読みしていないと刺せない。0.10秒を採ったのは計測の
 * 7段目＝名鑑16球団192人のうち54人が該当し（0.00では17人・6球団が皆無、0.20では112人＝
 * ほぼ全員）、**球団ごとの人数が1〜7人と開く**＝規則が死なず、球団の個性が数字に出る値。
 * 得点期待から出る損益分岐の成功率が 0.73（同5段目）＝軽々しく走ってよい手ではない、
 * という結論とも向きが合う。
 *
 * **塁で分けずに1つの値にしてある。** 二塁→三塁の損益分岐は 0.48〜0.62 と低い（同5段目
 * ＝三塁は還りやすいので、二盗より低い成功率でも見合う）ので、塁ごとに緩めれば三盗を
 * 増やせる。緩めていないのは、**この守備モデルでは標準リードの三盗はどの走力でも
 * 余裕が 0.26秒以上残る**（＝どうせ成立しない）ため、値を分けても帰結が変わらないから。
 * 三盗が現実的になるのは L-32 の深いリードを持ち越したときだけで、そこは 0.10秒でも通る。
 */
export const CPU_STEAL_MAX_DEFENSE_SLACK_SEC = 0.1;

/** CPUの盗塁判断が要る、走者ごとの事情（省略すれば従来どおり＝基準速・標準リード・本塁の捕手） */
export interface CpuStealOptions {
  /** その塁の走者の実際の足の速さ m/s（`runnerSpeed(RUN)`）。省略＝基準速 */
  speedOf?: (from: 'first' | 'second' | 'third') => number;
  /** その塁の走者が持ち越しているリード m（フェーズL-32）。省略＝標準のリード */
  leadOf?: (from: 'first' | 'second' | 'third') => number;
  /** 捕手の位置（送球の起点）。省略＝本塁 */
  catcherPos?: Vec2;
}

/**
 * その走者が走ったとき、守備に残る余裕（秒）。正なら完璧な送球で刺せ、その秒数だけ
 * 遅れても間に合う。負なら**完璧な送球でも間に合わない**。
 */
export function cpuStealDefenseSlack(
  from: 'first' | 'second' | 'third',
  opts: CpuStealOptions = {},
): number {
  return (
    stealSafeJumpSec(
      from,
      opts.catcherPos ?? BASE_POSITIONS.home,
      opts.leadOf?.(from) ?? STEAL_LEAD,
      opts.speedOf?.(from) ?? RUNNER_SPEED,
    ) - CPU_STEAL_JUMP_SEC
  );
}

/**
 * CPU攻撃側の盗塁判断（決定的・乱数不使用。他の core/* と同じ設計方針）。
 *
 * **フェーズL-32でダブルスチール（複数走者の同時スタート）へ広げ、フェーズR-39で
 * 走者の足を見るようにした**（どちらもユーザー判断：CPUも仕掛ける／球団の個性を効かせる）。
 * それまでは塁の状態しか見ていなかったので、**俊足打線のウィンズでも鈍足の4番でも
 * まったく同じ頻度で走っていた**（B-12が「CPUは球団の個性を活かさない」として記録した穴）。
 *
 * 規則は2つの掛け合わせ。**塁が空いているか**は従来どおり `forcedRunners` と同じ連鎖：
 * - 三塁走者は本塁が常に空いている／二塁走者は三塁が空いていれば／一塁走者は二塁が
 *   空いているか二塁走者が走る（＝空く）なら。
 *
 * **走る値打ちがあるか**は `cpuStealDefenseSlack` が `CPU_STEAL_MAX_DEFENSE_SLACK_SEC`
 * 以下であること。この1本で3つのことが同時に決まる：
 * - **俊足だけが走る**（球団の個性。走力0.5では 0.20秒＝人の反応で刺せるので走らない）。
 * - **三塁走者は走らない**（捕手が本塁に立っている＝送球距離0なので余裕が1秒以上残る）。
 *   L-32までは明示的な特例だったものが、**規則から導出される**ようになった。
 * - **深いリードを持ち越していれば走る**（L-32。標準リードでは誰も三盗しないが、
 *   けん制に耐えて6mまで広げた俊足なら三盗も仕掛ける）。
 *
 * 並びは**本塁に近い順**（`sendableRunnerBases` と同じ）。1打席1回までの制限は
 * 呼び出し側（main.ts）が持つ。人間の攻撃側は従来どおり塁を指定すればどの走者でも
 * 仕掛けられる＝**ギャンブルはプレイヤーの裁量に残す**（`chooseCpuTagUp` と同じ切り分け）。
 */
export function chooseCpuSteals(
  bases: Bases,
  opts: CpuStealOptions = {},
): Array<'first' | 'second' | 'third'> {
  const worth = (from: 'first' | 'second' | 'third'): boolean =>
    cpuStealDefenseSlack(from, opts) <= CPU_STEAL_MAX_DEFENSE_SLACK_SEC;
  const list: Array<'first' | 'second' | 'third'> = [];
  const thirdRuns = bases.third && worth('third');
  const secondRuns = bases.second && (!bases.third || thirdRuns) && worth('second');
  const firstRuns = bases.first && (!bases.second || secondRuns) && worth('first');
  if (thirdRuns) list.push('third');
  if (secondRuns) list.push('second');
  if (firstRuns) list.push('first');
  return list;
}

/** フォースされる走者の起点。'batter' は打者走者（本塁が起点）。 */
export type ForcedFrom = 'batter' | 'first' | 'second' | 'third';

export interface ForcedRunner {
  from: ForcedFrom;
  to: BaseKey;
}

/** 塁上の走者が次に進む塁（本塁からの生還はこの先を持たない）。 */
export function advancedBase(base: 'first' | 'second' | 'third'): BaseKey {
  return base === 'first' ? 'second' : base === 'second' ? 'third' : 'home';
}

/**
 * 手動走塁（2P/CPU操作分離セッション）：フォースされていない占有塁のうち、
 * まだ「進塁を仕掛けて」いない走者の一覧を返す（送りたい走者候補）。
 * 本塁に近い（＝進塁で得点に近づく）順に並べる＝無方向入力時の既定選択に使う。
 */
export function sendableRunnerBases(
  bases: Bases,
  forced: ForcedRunner[],
  alreadySent: ReadonlyArray<'first' | 'second' | 'third'>,
): Array<'first' | 'second' | 'third'> {
  const forcedFrom = new Set(forced.map((f) => f.from));
  const sent = new Set(alreadySent);
  const candidates: Array<'first' | 'second' | 'third'> = [];
  if (bases.third && !forcedFrom.has('third') && !sent.has('third')) candidates.push('third');
  if (bases.second && !forcedFrom.has('second') && !sent.has('second')) candidates.push('second');
  if (bases.first && !forcedFrom.has('first') && !sent.has('first')) candidates.push('first');
  return candidates;
}

/**
 * 進塁を仕掛ける走者を決める（説明書p16「+で進塁する塁を指定しB」）。
 *
 * candidates は sendableRunnerBases の結果（本塁に近い順）。destination は十字キーの
 * 絶対塁指定（baseFromPadDirection の結果）。
 *
 * - **塁を指定したとき**は従来どおり**その塁へ進む走者1人だけ**。該当者がいなければ空
 *   （送球・帰塁の塁指定と同じ「該当者がいなければ空振り」の扱い）。
 * - **指定しないとき（null）は走れる走者が全員**（フェーズL-32。ユーザー判断）。
 *   複数走者の同時スタート＝ダブルスチールの入口で、1人ずつ押し分ける必要がない
 *   ＝**同じ瞬間にスタートを切れる**（押し直すぶんの遅れがそのまま走者の不利になっていた）。
 *   L-32より前の既定は「本塁にもっとも近い走者1人」だったので、**無指定の意味だけが
 *   変わっている**（塁を指定したときの帰結は1つも変わらない）。
 *
 * 打球のプレー中の進塁（sendRunner）と盗塁（説明書p13）で共通に使う：どちらも
 * 「どの走者を次の塁へ走らせるか」を決めるだけで、違いは仕掛ける場面（打球の最中か
 * 投球の最中か）しかない＝**同じキー・同じ入力なら同じ意味**（見えている操作と効く操作が
 * 食い違わない）。
 */
export function chooseSendRunners(
  candidates: ReadonlyArray<'first' | 'second' | 'third'>,
  destination: BaseKey | null,
): Array<'first' | 'second' | 'third'> {
  if (destination === null) return [...candidates];
  const one = candidates.find((c) => advancedBase(c) === destination);
  return one === undefined ? [] : [one];
}

/**
 * 塁を指定しない一斉スタート（上記）で盗塁の対象になる走者（フェーズL-32）。
 *
 * **本塁へ向かう走者（三塁走者）だけを外す。** 捕手は本塁に立ったままボールを受けるので
 * 送球距離が0＝どんなスタートを切っても刺される（`stealSafeJumpSec('third')` は投球の
 * 残り時間の上限を超える）。**既定の操作が必ず走者を1人失う**のでは、無指定のJが罠になる。
 *
 * 塁を指定すれば従来どおり本塁へも走れる＝**ギャンブルはプレイヤーの裁量に残す**
 * （`chooseCpuSteals` が三塁走者を走らせないのと同じ切り分け）。打球のプレーの進塁では
 * この絞り込みを掛けない（本塁へ還すことがそもそもの目的なので）。
 */
export function stealableBases(
  candidates: ReadonlyArray<'first' | 'second' | 'third'>,
): Array<'first' | 'second' | 'third'> {
  return candidates.filter((from) => advancedBase(from) !== 'home');
}

/** 塁間を走っている（または止まっている）走者1人ぶんの走行区間（`chooseRunnerCommand` 用） */
export interface RunningLeg {
  /** その走者の起点（打者走者は 'batter'） */
  from: ForcedFrom;
  /** いま向かっている塁（帰塁中なら起点の塁） */
  to: BaseKey;
  /** いまその場に止まっている（フェーズN-34） */
  holding: boolean;
  /** まだこのプレーで止まっていない＝止まれる（1プレーに1回） */
  canHold: boolean;
}

/** J（進塁ボタン）が今この瞬間に何を意味するか（フェーズN-34） */
export interface RunnerCommand {
  kind: 'send' | 'resume' | 'hold';
  /** 対象の走者（`send` は仕掛ける走者の塁、`resume`/`hold` は走行中の走者の起点） */
  from: ForcedFrom[];
}

/**
 * J を押したときに起きること（フェーズN-34。ユーザー判断：**Jのトグル**）。
 *
 * **J はいつでもまず「走れ」の指示で、走れる状態の走者が1人もいないときだけ
 * 「止まれ」になる**。この順番のおかげで、L-32までの帰結（仕掛けられる走者がいる
 * ときの J）は**1つも変わらない**＝止まる操作は既存の操作の上に足されただけになる。
 *
 * 1. **仕掛けられる走者**がいれば従来どおり発進（`chooseSendRunners`。塁指定＝1人／
 *    無指定＝全員というL-32の規則もそのまま）。
 * 2. いなければ、**止まっている走者**が再スタートする。
 * 3. それもいなければ、**走っている走者が止まる**（1プレーに1回だけ）。
 *
 * 対象の選び方は3つとも共通で、塁を指定すれば**その塁へ向かっている走者だけ**、
 * 指定しなければ該当者全員（＝L-32のダブルスチールと同じ「同じキー・同じ入力なら
 * 同じ意味」）。押しても何も起きないときは null＝呼び出し側は何もしない。
 */
export function chooseRunnerCommand(
  sendable: ReadonlyArray<'first' | 'second' | 'third'>,
  running: readonly RunningLeg[],
  destination: BaseKey | null,
): RunnerCommand | null {
  const send = chooseSendRunners(sendable, destination);
  if (send.length > 0) return { kind: 'send', from: send };
  const matching = running.filter((leg) => destination === null || leg.to === destination);
  const resume = matching.filter((leg) => leg.holding);
  if (resume.length > 0) return { kind: 'resume', from: resume.map((leg) => leg.from) };
  const hold = matching.filter((leg) => !leg.holding && leg.canHold);
  if (hold.length > 0) return { kind: 'hold', from: hold.map((leg) => leg.from) };
  return null;
}

// ---- リードの持ち越し（フェーズL-32。説明書p24のけん制と p13 の盗塁をつなぐ） ----
//
// **A-6（けん制）以来ずっと記録されていた「攻撃側の押し得」を消すための仕組み**：
// 人間の走者は K（帰塁）を早めに押せば必ず助かり、押すことによる損失が何も無かった
// （リードが浅くなるだけで、次の投球の盗塁は常に STEAL_LEAD から始まっていたため）。
//
// L-32 は**けん制のプレーが終わった時点のリードを、その打席の投球へ持ち越す**。
// - 早めに戻った走者は**リード0**のまま次の球を迎える＝`stealSafeJumpSec` が 0.45秒→0.91秒
//   になり、標準球・速球には**走れない**（計測：`npm run balance:steal`）。
// - 戻らずに窓（PICKOFF_WINDOW_SEC）が閉じるまで耐えた走者は**深いリード**を持ち越す＝
//   窓が 0.11〜0.22秒まで縮み、リリース後でも間に合う／二塁からの三盗も現実的になる。
//
// つまり**けん制は「刺す」ためだけでなく「リードを削る」ために投げるもの**になり、
// 走者側には「戻る（安全だがその打席は走れない）／耐える（刺されうるが走れる）」という
// 判断が生まれる。投手が投げなければリードは育ったまま残るので、**にらみ合いに入ること
// 自体が投手のリスク**でもある（＝どちらにも押し得が無い）。
//
// 持ち越しは**走者の識別つき**で持つ（塁が同じでも別人なら効かない）。塁が変われば
// 新しい塁で改めて既定のリードから始まる＝「その塁でどれだけ塁を離れているか」という
// 事実そのものを持ち歩いているだけで、余分な状態を増やしていない。

/** ある塁の走者が、そのプレーの終了時にどれだけ塁を離れていたか */
export interface CarriedLead {
  /** その塁にいた走者（同じ塁でも別人なら持ち越さないための照合用） */
  id: RunnerId;
  /** 塁から離れている距離 m（0＝塁を踏み直した） */
  lead: number;
}

export type CarriedLeads = Partial<Record<'first' | 'second' | 'third', CarriedLead>>;

/**
 * 持ち越したリードのうち、**いまもその塁に同じ走者がいるものだけ**を距離に解く。
 *
 * 走者が進塁・生還・アウトで入れ替わっていれば、その塁の持ち越しは無効（＝既定のリードに
 * 戻る）。呼び出し側（main.ts）はこの結果をそのままプレーの開始リードとして渡し、
 * **持ち越しの無い塁は従来どおりの既定**（けん制＝0／盗塁＝標準のリード）になる。
 */
export function resolveCarriedLeads(
  runners: BaseRunners,
  carried: CarriedLeads,
): Partial<Record<'first' | 'second' | 'third', number>> {
  const leads: Partial<Record<'first' | 'second' | 'third', number>> = {};
  for (const base of ['first', 'second', 'third'] as const) {
    const entry = carried[base];
    if (entry === undefined || runners[base] === null || runners[base] !== entry.id) continue;
    leads[base] = entry.lead;
  }
  return leads;
}

/**
 * 帰塁（説明書p19「+で帰る塁を指定しA。いったん次の塁を踏むと前の塁に戻れない」）で
 * 呼び戻す走者を決める。
 *
 * candidates は「進塁を仕掛けたが、まだ次の塁を踏んでいない走者」の**帰る先の塁**
 * （＝その走者の起点の塁）を、仕掛けた順に並べたもの。次の塁へ到達済みの走者・
 * 送球で刺された走者は、原作の「いったん次の塁を踏むと前の塁に戻れない」ルールに
 * 従って呼び出し側で候補から除外しておくこと。
 *
 * destination は十字キーの絶対塁指定（baseFromPadDirection の結果。上=二塁/左=三塁/
 * 右=一塁）。指定された塁へ帰れる走者がいなければ null を返す＝何もしない
 * （送球・進塁の塁指定と同じ「指定した塁に該当者がいなければ空振り」の扱い）。
 * 無指定（null）のときは直近に仕掛けた走者を呼び戻す（従来の簡易版と同じ既定）。
 */
export function recallTargetBase(
  candidates: ReadonlyArray<'first' | 'second' | 'third'>,
  destination: BaseKey | null,
): 'first' | 'second' | 'third' | null {
  if (candidates.length === 0) return null;
  if (destination === null) return candidates[candidates.length - 1];
  return candidates.find((c) => c === destination) ?? null;
}

/**
 * フォースされる走者一覧を算出する（rules.ts の forceAdvance と同じ連鎖ルール）。
 * 打者は常にフォース対象。一塁走者は打者が入るので常にフォース。
 * 二塁走者は一塁が埋まっているときのみ、三塁走者は一・二塁とも埋まっているときのみ。
 */
export function forcedRunners(bases: Bases): ForcedRunner[] {
  const list: ForcedRunner[] = [{ from: 'batter', to: 'first' }];
  if (bases.first) list.push({ from: 'first', to: 'second' });
  if (bases.first && bases.second) list.push({ from: 'second', to: 'third' });
  if (bases.first && bases.second && bases.third) list.push({ from: 'third', to: 'home' });
  return list;
}

export function originOf(from: ForcedFrom): Vec2 {
  return from === 'batter' ? BASE_POSITIONS.home : BASE_POSITIONS[from];
}

/**
 * フォース走者の結果をベースに反映する。outTarget に一致する走者のみアウト
 * （1プレー1送球のv1では併殺は起きない＝他の走者は全員安全に進塁完了する）。
 *
 * 起点のクリアと行き先の設定を2パスに分けている点に注意：例えば一塁走者が
 * 二塁へ進む際に自分の起点（一塁）をクリアする処理を、打者が安全に一塁へ
 * 到達した「後」に単純に1パスで処理すると、同じ 'first' キーを取り合って
 * 打者の到達を上書きしてしまう（起点と行き先が同じ塁名を共有するため）。
 */
export function applyForcedResult(
  bases: Bases,
  forced: ForcedRunner[],
  outTarget: BaseKey | null,
): { bases: Bases; outsAdded: number; runs: number } {
  const next: Bases = { ...bases };
  for (const runner of forced) {
    if (runner.from !== 'batter') next[runner.from] = false;
  }

  let outsAdded = 0;
  let runs = 0;
  for (const runner of forced) {
    if (outTarget !== null && runner.to === outTarget) {
      outsAdded += 1;
      continue;
    }
    if (runner.to === 'home') runs += 1;
    else next[runner.to] = true;
  }
  return { bases: next, outsAdded, runs };
}

/**
 * 送球と対象走者の競争を判定し、結果をベースへ反映する。
 * 同着は走者有利（現実の野球の慣習に準拠）＝ throwTime が厳密に短いときのみアウト。
 */
export function resolveDefensePlay(
  bases: Bases,
  forced: ForcedRunner[],
  runnerRemainingDistance: Partial<Record<ForcedFrom, number>>,
  throwTargetBase: BaseKey,
  throwDistance: number,
): { bases: Bases; outsAdded: number; runs: number } {
  const throwTime = throwDistance / THROW_SPEED;
  const contested = forced.find((f) => f.to === throwTargetBase);
  let outTarget: BaseKey | null = null;
  if (contested) {
    const remaining = runnerRemainingDistance[contested.from] ?? 0;
    const runnerTime = remaining / RUNNER_SPEED;
    if (throwTime < runnerTime) outTarget = throwTargetBase;
  }
  return applyForcedResult(bases, forced, outTarget);
}
