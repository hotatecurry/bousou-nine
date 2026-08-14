/**
 * 打撃システムの純粋ロジック（スイング判定・打球の初速/角度・打球飛行物理）。
 *
 * ファミスタ準拠のスイングモデル：
 * - Aボタンでスイング。バットは始動時間ののち、打撃面（本塁のやや投手寄り）上に
 *   短い有効時間だけ存在し、その間にボールが打撃面を通過すれば接触する。
 * - タイミング：早振り＝引っ張り（右打者は三塁側）、振り遅れ＝流し（一塁側）。
 *   極端なタイミングは方向が45°を超えてファウルゾーンへ飛ぶ。
 *   引っ張るのは**打者が立っている側**（打者ローカルの +X＝内角側。フェーズBB-49）で、
 *   左打者（BatterSide=+1）はこれらがすべてXについて鏡像になる（＝引っ張りは一塁側）。
 * - コース：バットの芯（ゾーン中央）から外れるほど初速が落ちる。
 *   内角（詰まる）＝ゴロ寄り、外角（バットの先）＝フライ寄り。
 * - 空振り（スイングしたが接触なし）はコースにかかわらずストライク。
 *
 * 打球は重力・バウンド・転がりの簡易物理で飛び、
 * ノーバウンドのフェンス越え（本塁打候補）／バウンド後の越え（エンタイトルツーベース）／
 * 最初の着地点によるフェア・ファウルを判定材料として返す。
 *
 * 座標系は pitch.ts / field.ts と同一（本塁原点、+Z=捕手方向、+X=一塁側、外野=-Z）。
 */
import { type Ballpark, DEFAULT_BALLPARK, fenceAtPoint } from './ballpark';
import {
  type BatterSide,
  type PitchCall,
  type PitchFlight,
  RIGHT_BATTER_SIDE,
  batterFrameX,
  clampStance,
} from './pitch';

/** バットとボールが接触する打撃面のZ（本塁のやや投手寄り） */
export const CONTACT_PLANE_Z = -0.3;
/** 接触時の打球初期高さ */
export const CONTACT_HEIGHT = 1.0;

/** スイング開始からバットが打撃面に届くまでの始動時間 */
export const SWING_STARTUP_SEC = 0.02;
/** バットが打撃面上にある有効時間（この間にボールが通過すれば接触） */
export const SWING_ACTIVE_SEC = 0.14;
/** ジャストミートとなるスイング経過時間（有効時間の中央） */
export const SWING_IDEAL_SEC = SWING_STARTUP_SEC + SWING_ACTIVE_SEC / 2;

/**
 * バットが届く左右範囲（**打者ローカル**。外角側=-X / 内角側=+X）。
 * 左打者はワールドXが反転するだけで、届く範囲そのものは打者によらず同じ
 * （バットの長さと構えは全打者共通。batterFrameX で打者ローカルに直してから比べる）。
 */
export const BAT_REACH_OUTSIDE_X = -0.75;
export const BAT_REACH_INSIDE_X = 0.65;
/** バットの芯（ストライクゾーン中央） */
export const SWEET_SPOT_X = 0;

/**
 * 打席内の立ち位置（フェーズO-36）を反映したバットの到達範囲と芯（打者ローカル）。
 *
 * **範囲も芯も、立ち位置のオフセットぶん平行移動するだけ**（バットの長さと構えは
 * 全打者共通のまま）＝**体からの距離で見れば何も変わっていない**。動くのは
 * 「本塁から見てどこに届くか」のほうで、プレートに寄る（負）ほど外角へ届き、
 * 内角は手元へ食い込んで詰まる。離れる（正）ほど内角を芯で叩けるが外角が先になる。
 *
 * 芯を一緒に動かすのが要点：芯だけ本塁中央に置いたままにすると、寄るほど
 * 「外角に届くうえに芯で捉えられる」一方的な得になってしまう。
 */
export interface BatReach {
  /** 外角側の限界（打者ローカル。もっとも小さいX） */
  outside: number;
  /** 内角側の限界（打者ローカル。もっとも大きいX） */
  inside: number;
  /** バットの芯 */
  sweet: number;
}

export function batReachFor(stance = 0): BatReach {
  const offset = clampStance(stance);
  return {
    outside: BAT_REACH_OUTSIDE_X + offset,
    inside: BAT_REACH_INSIDE_X + offset,
    sweet: SWEET_SPOT_X + offset,
  };
}

/** タイミング極値での打球方向の最大角。45°（両翼線）を超えるぶんがファウルになる */
export const MAX_DIRECTION_DEG = 60;
/** 芯で捉えたときの打ち上げ角 */
export const LAUNCH_BASE_DEG = 21;
/** コースによる打ち上げ角の変化幅（内角いっぱいでゴロ、外角いっぱいでフライ） */
export const LAUNCH_TILT_DEG = 30;
/** 打球初速 = (BASE + CARRY×球速 + 長打力) × 質。速球ほど飛ぶ＝速球は打たれたときのリスクが大きい */
export const EXIT_SPEED_BASE = 22;
export const EXIT_PITCH_CARRY = 0.5;
/** タイミング／コースのずれによる初速の減衰率 */
const TIMING_SPEED_PENALTY = 0.3;
const COURSE_SPEED_PENALTY = 0.5;

// ---- 打者の能力値の反映（フェーズB-8。roster.ts の BatterStats を参照） ----

/**
 * 打撃能力のうち、打球の質に効く2値だけを取り出したもの
 * （打席の左右＝BOX は判定式の左右反転なので BatterSide として別に渡す。
 * 走力＝RUN は走者側の fielding.ts が使う）。
 */
export interface BattingProfile {
  /** 本塁打（HR）0..1。打球初速への上乗せ */
  power: number;
  /** 打率（AV）0..1。芯・タイミングを外したときの減衰の緩和 */
  average: number;
}

/**
 * 能力値を渡さなかった場合の既定値。**どちらも0＝上乗せも緩和も無い**ため、
 * 能力値を持ち込む前の打球とまったく同じ数値になる（既存のテストと調整済みの
 * 手触りをそのまま基準線として保つための取り決め）。
 */
export const NEUTRAL_BATTER: BattingProfile = { power: 0, average: 0 };

/** 長打力（HR=1）が打球初速に上乗せする最大量 m/s */
export const EXIT_POWER_BONUS = 6;
/**
 * 打率（AV=1）が芯・タイミングのずれによる減衰をどれだけ和らげるか（0..1の割合）。
 * 0.5＝最高の巧打者でも減衰が半分になるだけで、芯を食った当たりには及ばない
 * （＝「詰まっても前へ飛ぶ」が「凡打がヒットになる」にはならない）。
 */
export const AVG_MISHIT_RELIEF = 0.5;

/**
 * 疲労MAXの投手から打ったときに打球初速へ上乗せされる量 m/s（フェーズB-11の「球威」）。
 *
 * **これが無いと疲労は打者にとって不利になる**：初速は `EXIT_PITCH_CARRY * 球速` を
 * 含むので、疲労で球速だけ落とすと打球はむしろ飛ばなくなる（「速球ほど打たれたときの
 * リスクが大きい」という既存の設計の裏返し）。疲労の球速低下ぶん（-4.2m/s × 0.5 =
 * -2.1m/s）を上回る +5 を置くことで、差し引き約 +3m/s ＝**長打力 +0.5 相当が全打者に
 * 乗る**（実測でフェンスを越えるか手前で失速するかが入れ替わる幅）。
 */
export const EXIT_FATIGUE_BONUS = 5;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * バント（説明書p14「スイングの途中でAボタンを離すと、バントもできます」）。
 * フルスイングと違いタイミングの概念は持たず、バットを出しておけばコース内の球に当たる。
 * 打球は転がる程度の弱いゴロになり、方向は十字キーの左右で狙う
 * （説明書p17 送りバント「バットをななめに出し、ファールラインぎりぎりに転がすのがコツ」）。
 */
export const BUNT_EXIT_SPEED = 11;
/**
 * 押しバント（プッシュバント）の初速 m/s（十字キー上。フェーズY-46）。
 *
 * **値は `npm run balance:bunt` が決めた**＝ファウルライン際（±44°）へ転がしたとき、
 * **投手が拾い上げるまでの時間がいちばん長くなる**初速。速すぎると三塁手・一塁手の
 * 立っている塁まで転がって（18m/s以上）その場で拾われ、遅すぎれば従来どおり本塁の
 * すぐ近くで拾われる。17m/s のとき本塁から20mの地点・確保 1.90秒で、**捕手が盗塁を
 * 刺す経路（2.74秒）より守備が遅くなる**＝転がすことが走者を助ける側に初めて回る。
 *
 * **方向を外すと逆に罰が来る**（これが押しのリスク）：正面〜-20°へ押すと**投手が
 * 空中で捕る小フライ**になり、-30°でも 0.82秒＝標準のバント（1.00秒）より速く拾われる。
 */
export const BUNT_PUSH_EXIT_SPEED = 17;
/** バントの打ち上げ角（転がすので浅い） */
export const BUNT_LAUNCH_DEG = 7;
/**
 * 十字キー左右でバントを狙える最大角（±。45°を超えるとファウルゾーン）。
 *
 * 説明書p17 の送りバント「**バットをななめに出し、ファールラインぎりぎりに転がすのがコツ**」
 * をそのまま値にしたもの（フェーズY-46で 38°→44°）。ラインの内側1°で、打球は直線に
 * 転がるのでフェアのまま。**ライン際ほど投手が拾うまでの距離が伸びる**ので、
 * 「コツ」が実際に守備の時間として効く（`npm run balance:bunt` の4段目）。
 */
export const BUNT_MAX_DIRECTION_DEG = 44;

const GRAVITY = 9.8;
/**
 * 空気抵抗の係数 1/m（フェーズJJ-57）。加速度は `-AIR_DRAG × |v| × v`（速さの2乗に比例）。
 *
 * **それまで飛行は重力だけの放物線だった**＝初速46m/sの打球が147m飛ぶ（実際の野球なら
 * 約120m）。テストプレイの「ホームランが出やすすぎる」の**根本原因はここ**で、
 * 初速を一律に下げる案は計測が退けた（`npm run balance:hr`）＝**安打率・内野安打まで
 * 一緒に削れてしまう**（平均打者の芯の安打率が 33%→22% まで落ちる）。
 *
 * 抗力は**速さの2乗**で効くので、**長い飛球だけが強く縮み、ゴロ・ライナー・内野への
 * 打球はほとんど動かない**＝狙った場所にだけ効く唯一のレバーだった。
 *
 * **実際の野球の値（≒0.006）は使えない**：この球場の柵（説明書p24-25の実寸）は
 * 抗力の無いモデルに合わせて決まっているので、本物の抗力を入れると飛距離が86〜106mに
 * なり**誰一人柵を越えられなくなる**（実測）。採用値は `npm run balance:hr` が
 * **「タイミングが合ったときに誰がHRを打てるか」**で決めた（t=0の帰結）：
 *
 * | 長打力 | 抗力なし | 0.0008 | **0.0010** | 0.0012 | 0.0015 |
 * |---|---|---|---|---|---|
 * | 0.50（平均） | **11.0%** | 0% | **0%** | 0% | 0% |
 * | 0.70 | 22.0% | 11.0% | **0%** | 0% | 0% |
 * | 0.85 | 22.0% | 18.3% | **11.0%** | 11.0% | 0% |
 * | 1.00 | 25.7% | 22.0% | **18.3%** | 18.3% | 11.0% |
 * | 好調の0.50 | 25.7% | 14.7% | **11.0%** | 7.3% | 0% |
 * | 速球×0.50 | — | 22.0% | **18.3%** | 18.3% | 11.0% |
 *
 * 0.0010 は**平均打者が芯で捉えても越えられない最小の値**で、そのうえで
 * **強打者・好調（D-19）・速球（`EXIT_PITCH_CARRY` の狙い）という「理由」があるときだけ
 * 越える**＝どれか1つでも死ぬ値（0.0015以上は好調も速球も効かなくなる）は採れない。
 * 芯の安打率は 33.0%→25.7%（打率 .33 相当）で、打てなくなるほどは下がっていない。
 */
const AIR_DRAG = 0.0006;
const BOUNCE_RESTITUTION = 0.45;
const BOUNCE_FRICTION = 0.72;
/** バウンドの跳ね返りがこれ未満になったら転がりに移行 */
const BOUNCE_STOP_VY = 1.2;
/** 転がり中の減速度 m/s^2 */
const ROLL_DECEL = 5.5;
/** 転がりがこれ以下になったら静止 */
const REST_SPEED = 0.5;
const WALL_RESTITUTION = 0.35;

/** 打撃面の通過情報。frac はステップ内の通過タイミング（0..1、サブフレーム精度） */
export interface PlaneCrossing {
  x: number;
  frac: number;
}

/**
 * このステップで打撃面（CONTACT_PLANE_Z）を通過したなら通過時のXを線形補間で返す。
 * 未通過なら null。
 */
export function contactPlaneCrossing(
  prev: PitchFlight,
  next: PitchFlight,
): PlaneCrossing | null {
  if (prev.z >= CONTACT_PLANE_Z || next.z < CONTACT_PLANE_Z) return null;
  const frac = (CONTACT_PLANE_Z - prev.z) / (next.z - prev.z);
  return { x: prev.x + (next.x - prev.x) * frac, frac };
}

export interface SwingSample {
  /** 打撃面通過時のボールX（コース） */
  crossX: number;
  /** 打撃面通過時点のスイング経過秒（Aボタン押下からの時間） */
  swingTime: number;
  /** 通過時の球速 m/s */
  pitchSpeed: number;
}

/** 打球の初速ベクトル（ワールド座標。外野方向は -Z） */
export interface BattedBallLaunch {
  vx: number;
  vy: number;
  vz: number;
}

/**
 * スイング判定。タイミング（スイング経過時間）×コース（通過X）から
 * 接触の有無と打球の初速・角度を決める。空振りは null。
 *
 * batter（打者の能力値）は**打球の質にだけ**効く：長打力が初速を底上げし、打率が
 * 芯・タイミングを外したときの減衰を和らげる。**接触するかどうか（バットの到達範囲・
 * スイングの有効時間）は打者によらず一定**なので、人間が操作したときのスイングの
 * 手応えは打者が代わっても変わらない（2026-07-23 ユーザー判断）。
 *
 * side（打席の左右＝BOX。フェーズB-9）は**判定をいったん打者ローカルへ移して行い、
 * 打球の左右だけをワールドへ戻す**形で効く。したがって内角/外角の意味も、
 * 引っ張り/流しの意味も打者にとっては同じで、飛ぶ向きだけが鏡像になる。
 *
 * pitcherFatigue（投手の疲労0..1。フェーズB-11）は**投手側から打球の質に効く唯一の値**で、
 * 打者の長打力とまったく同じ形で初速に上乗せされる（＝疲れた投手からは非力な打者でも
 * 一発が出る）。既定は 0＝疲労を持ち込む前とまったく同じ打球。
 *
 * stance（打席内の立ち位置。フェーズO-36）は**バットの到達範囲と芯を平行移動する**だけ
 * （`batReachFor`）。**接触するかどうかの広さも、芯を食ったときの打球も変わらない**ので、
 * 立ち位置は「打ちやすさ」ではなく**どのコースを打ちに行くかの選択**として効く。
 * 既定 0＝打席中央＝従来と完全に同じ。
 */
export function judgeSwing(
  sample: SwingSample,
  batter: BattingProfile = NEUTRAL_BATTER,
  side: BatterSide = RIGHT_BATTER_SIDE,
  pitcherFatigue = 0,
  stance = 0,
): BattedBallLaunch | null {
  const { crossX, swingTime, pitchSpeed } = sample;
  if (swingTime < SWING_STARTUP_SEC || swingTime > SWING_STARTUP_SEC + SWING_ACTIVE_SEC) {
    return null;
  }
  // 以降のコース計算はすべて打者ローカル（左打者は左右が入れ替わる）
  const localX = batterFrameX(crossX, side);
  const reach = batReachFor(stance);
  if (localX < reach.outside || localX > reach.inside) return null;

  // +1=早振り（スイング終盤にボール到達）→引っ張り / -1=振り遅れ→流し
  const timing = (swingTime - SWING_IDEAL_SEC) / (SWING_ACTIVE_SEC / 2);
  // -1=外角いっぱい（バットの先）/ +1=内角いっぱい（詰まる）
  const course =
    localX < reach.sweet
      ? (localX - reach.sweet) / (reach.sweet - reach.outside)
      : (localX - reach.sweet) / (reach.inside - reach.sweet);

  // 打率が高いほど「外したときの減衰」そのものが小さくなる（芯を食った当たりの
  // 上限は動かさないので、巧打者でもジャストミートを超える打球にはならない）。
  const relief = 1 - AVG_MISHIT_RELIEF * clamp01(batter.average);
  const quality =
    (1 - TIMING_SPEED_PENALTY * Math.abs(timing) * relief) *
    (1 - COURSE_SPEED_PENALTY * Math.abs(course) * relief);
  const speed =
    (EXIT_SPEED_BASE +
      EXIT_PITCH_CARRY * pitchSpeed +
      EXIT_POWER_BONUS * clamp01(batter.power) +
      EXIT_FATIGUE_BONUS * clamp01(pitcherFatigue)) *
    quality;

  // 早振り→引っ張り（打者ローカルの +X＝内角側＝**打者が立っているほうの側**。
  // 右打者なら三塁側、左打者なら一塁側。フェーズBB-49で「打者から遠い側」から直した＝
  // 内角の球を引っ張るという実際の野球の形になり、ワールドの打球方向は変わっていない）
  const directionRad = (timing * MAX_DIRECTION_DEG * Math.PI) / 180;
  const launchRad = ((LAUNCH_BASE_DEG - course * LAUNCH_TILT_DEG) * Math.PI) / 180;
  const horizontal = speed * Math.cos(launchRad);
  return {
    // 左右だけワールドへ戻す（打ち上げ角・飛距離は打席の左右で変わらない）
    vx: side * horizontal * Math.sin(directionRad),
    vy: speed * Math.sin(launchRad),
    vz: -horizontal * Math.cos(directionRad),
  };
}

/**
 * バント判定（説明書p14）。バットを出して当てるだけなのでタイミングの概念は無く、
 * バットが届くコースなら当たる（届かないコースは空振りで null）。
 * aimX は十字キーの左右（-1=三塁側 / 0=正面 / +1=一塁側）で、転がす方向を狙う。
 * 打球はフルスイングよりはるかに弱く、浅い角度のゴロになる。
 *
 * **aimX は打席の左右に関係なく画面（ワールド）の絶対方向**：押した向きへ転がるほうが
 * 分かりやすく、塁の指定を絶対方向で統一している既存の操作体系とも揃う。
 * side が効くのは「バットが届くか」の判定だけ（左打者は届く範囲がXについて鏡像になる）。
 *
 * stance（フェーズO-36）も同じく**届くかどうか**にだけ効く（バントの打球は立ち位置で
 * 変わらない＝打力で変わらないのと同じ理由）。
 *
 * push（フェーズY-46）は十字キー上＝**押しバント**。転がす方向はそのままに初速だけが
 * `BUNT_PUSH_EXIT_SPEED` に上がる。**打者の能力値では変わらない**（バントは打力に
 * 左右されないという既存の約束をそのまま保つ）＝変わるのは「どう当てたか」だけ。
 */
export function judgeBunt(
  crossX: number,
  aimX: -1 | 0 | 1,
  side: BatterSide = RIGHT_BATTER_SIDE,
  stance = 0,
  push = false,
): BattedBallLaunch | null {
  const localX = batterFrameX(crossX, side);
  const reach = batReachFor(stance);
  if (localX < reach.outside || localX > reach.inside) return null;

  const speed = push ? BUNT_PUSH_EXIT_SPEED : BUNT_EXIT_SPEED;
  const directionRad = (aimX * BUNT_MAX_DIRECTION_DEG * Math.PI) / 180;
  const launchRad = (BUNT_LAUNCH_DEG * Math.PI) / 180;
  const horizontal = speed * Math.cos(launchRad);
  return {
    vx: horizontal * Math.sin(directionRad),
    vy: speed * Math.sin(launchRad),
    vz: -horizontal * Math.cos(directionRad),
  };
}

/** 空振り（スイングしたが接触なし）はコースに関係なくストライク */
export function callAfterSwing<T extends PitchCall>(call: T, swung: boolean): T | 'strike' {
  return swung && call === 'ball' ? 'strike' : call;
}

/** 打球の飛行状態（判定材料のフラグ込み） */
export interface BattedBall {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** 最初の着地点（フェア/ファウル判定用）。ノーバウンドの間は null */
  landing: { x: number; z: number } | null;
  /** フェンス越え：'fly'=ノーバウンド（本塁打候補）/ 'bounce'=バウンド後（エンタイトルツーベース候補） */
  over: 'fly' | 'bounce' | null;
  /** 転がり終わって静止した */
  resting: boolean;
  /**
   * バントで転がした打球か（フェーズAA-48）。**飛行そのものには一切効かない**が、
   * ファウルになったときの扱いが変わる（バントのファウルは2ストライク後は三振＝
   * `rules.ts` の `buntFoul`。説明書p32「実際の野球のルールにできるだけ合わせてある」）。
   *
   * **打球そのものに持たせる**のは、この事実が生まれるのがでっかいモードの接触
   * （`judgeBunt` を通ったか）で、使うのがちっちゃいモードの決着だから＝
   * ボールが運べば、打球のプレー（`launch`）にもヒットエンドランの引き継ぎ
   * （`convertToBattedBall`）にも専用の引数を足さずに届く。
   */
  bunt: boolean;
}

/**
 * bunt は「バントで転がした打球か」（フェーズAA-48）。**省略時は false**＝
 * 渡さない呼び出し（計測の土台 `tools/balance/sim.ts` など）は従来と完全に同じ。
 */
export function createBattedBall(
  launch: BattedBallLaunch,
  contactX: number,
  bunt = false,
): BattedBall {
  return {
    x: contactX,
    y: CONTACT_HEIGHT,
    z: CONTACT_PLANE_Z,
    ...launch,
    landing: null,
    over: null,
    resting: false,
    bunt,
  };
}

/**
 * 1フレーム分の打球飛行（重力→バウンド/転がり→フェンス処理。純粋関数）。
 *
 * park（フェーズC-14）はフェンスの形だけに効く。従来は円形100m・高さ4m一律だったのが
 * **方角ごとの距離・高さ**になっただけで、越えの判定も跳ね返りの法線（半径方向）も
 * 従来のまま。既定はところざわ＝説明書で「最も平均的」とされる球場。
 */
export function stepBattedBall(
  ball: BattedBall,
  dt: number,
  park: Ballpark = DEFAULT_BALLPARK,
): BattedBall {
  if (ball.resting) return ball;
  const b = { ...ball };

  const rolling = b.landing !== null && b.y <= 0 && b.vy === 0;
  if (rolling) {
    const speed = Math.hypot(b.vx, b.vz);
    if (speed <= REST_SPEED) {
      b.vx = 0;
      b.vz = 0;
      b.resting = true;
      return b;
    }
    const factor = Math.max(0, 1 - (ROLL_DECEL * dt) / speed);
    b.vx *= factor;
    b.vz *= factor;
  } else {
    // 空気抵抗（フェーズJJ-57）。速さの2乗で効くので**長い飛球ほど強く縮む**＝
    // ゴロ・ライナーの帰結（I-29で測った内野安打・ゴロアウトの帯）はほとんど動かない。
    // バウンド後の飛行にも同じように効く（同じ空気の中を飛んでいるので分けない）。
    const speed = Math.hypot(b.vx, b.vy, b.vz);
    if (speed > 0) {
      const decel = Math.min(1, AIR_DRAG * speed * dt);
      b.vx -= b.vx * decel;
      b.vy -= b.vy * decel;
      b.vz -= b.vz * decel;
    }
    b.vy -= GRAVITY * dt;
  }
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.z += b.vz * dt;

  if (b.y <= 0 && b.vy < 0) {
    b.y = 0;
    if (!b.landing) b.landing = { x: b.x, z: b.z };
    const bounceVy = -b.vy * BOUNCE_RESTITUTION;
    b.vx *= BOUNCE_FRICTION;
    b.vz *= BOUNCE_FRICTION;
    b.vy = bounceVy < BOUNCE_STOP_VY ? 0 : bounceVy;
  }

  // フェンス。越え判定は一度だけ（越えた後は場外へ飛ばし続けるだけで再処理しない）
  if (b.over === null) {
    const r = Math.hypot(b.x, b.z);
    // その打球が飛んでいる方角のフェンス（球場ごとに距離も高さも違う。フェーズC-14）
    const fence = fenceAtPoint(park, b.x, b.z);
    if (r >= fence.distance) {
      if (b.y >= fence.height) {
        b.over = b.landing ? 'bounce' : 'fly';
      } else {
        // フェンス直撃：法線方向の速度成分を反転して場内へ跳ね返す
        const nx = b.x / r;
        const nz = b.z / r;
        const outward = b.vx * nx + b.vz * nz;
        if (outward > 0) {
          b.vx -= (1 + WALL_RESTITUTION) * outward * nx;
          b.vz -= (1 + WALL_RESTITUTION) * outward * nz;
        }
        const inside = (fence.distance - 0.01) / r;
        b.x *= inside;
        b.z *= inside;
      }
    }
  }
  return b;
}

/** フェア判定。両翼線上（|x| == -z）はフェア扱い */
export function isFairPosition(x: number, z: number): boolean {
  return -z >= Math.abs(x);
}
