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
  REFERENCE_PITCHER_NEUTRAL,
  RIGHT_BATTER_SIDE,
  batterFrameX,
  clampStance,
} from './pitch';

/** バットとボールが接触する打撃面のZ（本塁のやや投手寄り） */
export const CONTACT_PLANE_Z = -0.3;
/** 接触時の打球初期高さ */
export const CONTACT_HEIGHT = 1.0;

/**
 * ジャストミートとなるスイング経過時間（＝**人間が押してからの狙う時刻**）。
 *
 * **フェーズUU-69で、ここが基準になった**（それまでは `SWING_STARTUP_SEC + 有効時間/2`
 * の導出値だった）。理由は**人間が合わせるのはこの時刻だから**で、有効時間を狭めても
 * **狙う時刻は動かない**＝「同じタイミングで押す、ただし許容が狭くなる」形にできる
 * （導出のままだと窓を狭めるたびに押す時刻ごとずれ、手触りが二重に動く）。
 * **値は従来の 0.02 + 0.14/2 = 0.09 そのもの**なので、この組み替え自体では何も動かない。
 */
export const SWING_IDEAL_SEC = 0.09;
/**
 * バットが打撃面上にある有効時間（この間にボールが通過すれば接触）。
 * **`timing` の正規化の分母でもある**（`timing = (経過 − 理想) / (有効時間/2)`）ので、
 * ここは「バットが生きている長さ」と「タイミングの物差し」を兼ねている。
 *
 * ## フェーズUU-69：0.14 → 0.09（テストプレイの「そもそも空振りすることがほぼない」）
 *
 * 0.14秒は**押す時刻が ±70ms に入れば必ず当たる**という意味で、**人間が普通に押せば
 * ほぼ外さない**幅だった（`npm run balance:plate` の14段目。押す時刻のばらつき σ=40ms で
 * **空振り 7.9%**。実際の野球は振った球の約25%が空振り）。0.09 なら **±45ms** で
 * **空振り 25.1%**＝実際の野球とほぼ同じになる。
 *
 * **打球の質は1mmも動かない**：`timing` は正規化されるので、**HR率・安打率・飛距離・
 * ファウルの帯はすべて不変**（`npm run balance` の1〜3段目が完全一致することを確認済み）。
 * 動くのは**当たるかどうか**と、**当たったときの正規化タイミングの散らばり**だけ
 * （同じ ±40ms のずれが、狭い窓では大きな `timing` になる＝芯を食いにくくなる）。
 *
 * **CPU側は「スイング判断の時刻」が一緒に動く**（TT-68が罰を `有効時間/3`・`/2` から
 * 導出しているため）＝CPU打者の正規化タイミングは不変のまま、**踏み切る時刻だけが
 * 遅くなる**（0.1367→0.1150秒前）。実測の帰結は 三振 25.0%→**39.6%** / 四球 8.3%（不変）/
 * 死球 4.2%（不変）/ 1打席 3.58→**3.79球**。**三振が実際の野球（22%）より多い側へ
 * 行き過ぎている**ことは正直な代償として記録しておく（2026-09-14 ユーザー判断：
 * 人間の空振りを実際の野球に合わせるほうを優先）。
 */
export const SWING_ACTIVE_SEC = 0.09;
/** スイング開始からバットが打撃面に届くまでの始動時間（上2つからの導出） */
export const SWING_STARTUP_SEC = SWING_IDEAL_SEC - SWING_ACTIVE_SEC / 2;

/**
 * バットが届く左右範囲（**打者ローカル**。外角側=-X / 内角側=+X）。
 * 左打者はワールドXが反転するだけで、届く範囲そのものは打者によらず同じ
 * （バットの長さと構えは全打者共通。batterFrameX で打者ローカルに直してから比べる）。
 */
/**
 * **フェーズRR-66で -0.75/+0.65 から狭めた**（テストプレイの「絶対バットが当たって
 * いない場面でも当たる」）。値は**実機で測った「描かれたバットが接触の瞬間に覆う範囲」**
 * ＝ world -0.63〜+0.63（バットの太さ 0.055 と球の半径 0.037 を足した値）で、
 * **外角側がわずかに広い**という上のコメントの性質を保つ形に丸めてある。
 *
 * それまで**判定は先端より1m以上先まで届いていた**（先端は本塁 x=0 にすら届いていない）。
 * **バットを伸ばすのではなく判定を見た目へ寄せた**（2026-08-21 ユーザー判断）ので、
 * **打者も本塁へ寄っている**（`BATTER_ZONE_MIN_X`／`BATTER_STAND_X`）＝そうしないと
 * 1.1mのバットでは外角のストライクに届かない。立ち位置の可動幅（`BATTER_STANCE_RANGE`）も
 * O-36と同じ規則で解き直した。
 */
export const BAT_REACH_OUTSIDE_X = -0.65;
export const BAT_REACH_INSIDE_X = 0.62;
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
/**
 * 打球初速 = (BASE + CARRY×球速 + 長打力×`EXIT_POWER_BONUS`) × 質。
 * 速球ほど飛ぶ＝速球は打たれたときのリスクが大きい。
 *
 * **ここで言う球速は「緩急」のほう**（フェーズBBB-85。`carriedPitchSpeed`）：乗るのは
 * 基準の投手が同じ緩急で投げたときの球速で、**投手の球速（SPD）そのものは乗らない**。
 * それまでは球の速い投手ほど打球が飛び、CPU打者のタイミングは投手ごとの相対で決まるので、
 * **球速はCPU打者相手に損にしかなっていなかった**（計測：球速 0.3→0.9 で長打 7→16%/打席・
 * 三振は 20% のまま。テストプレイ「CPUが長打を出しすぎる。こちらの投手は球速のスキルを
 * 持っているのに」）。
 *
 * **フェーズRR-66で 22→20 へ下げ、長打力の幅を 6→10 へ広げた**（テストプレイの
 * 「相変わらずホームランが出すぎる」）。それまで**長打力0.2の打者でも、CPUの初球
 * （必ず速球）を芯で捉えれば94%が本塁打**だった＝**打者の差（最大6m/s）が
 * 全体（43〜46m/s）に対して小さすぎて、誰が打っても同じ打球になっていた**。
 * 基準を下げて幅を広げると、**同じ平均の打者は同じ初速のまま**（20+0.5×42+10×0.5
 * ＝46m/s＝従来と同じ）で、**上下の差だけが開く**。
 */
export const EXIT_SPEED_BASE = 20;
export const EXIT_PITCH_CARRY = 0.5;
/**
 * タイミングのずれによる初速の減衰率。
 *
 * **`export` してあるのは計測（`tools/balance/plate.ts`）が「この値を振ったら
 * どうなるか」を定数を書き換えずに出せるようにするため**（初速はこの係数に対して
 * 線形なので、打球ベクトルを比で伸縮すれば厳密に同値＝`homerun.ts` が
 * 「球速を 2δ 下げるのと完全に同値」として測っているのと同じやり方）。
 */
export const TIMING_SPEED_PENALTY = 0.35;
/** コース（芯からのずれ）による初速の減衰率 */
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

/**
 * 長打力（HR=1）が打球初速に上乗せする最大量 m/s。
 * **フェーズRR-66で 6→10**（`EXIT_SPEED_BASE` のコメント参照）＝**長打力という能力値が
 * 「柵を越えるかどうか」を実際に決める**ようになった（`npm run balance:plate` の10段目：
 * 初球の速球を芯で捉えたときのHR率が 長打力0.2で 94%→13%／1.0では 100%のまま）。
 */
export const EXIT_POWER_BONUS = 10;
/**
 * 打率（AV=1）が芯・タイミングのずれによる減衰をどれだけ和らげるか（0..1の割合）。
 * 0.5＝最高の巧打者でも減衰が半分になるだけで、芯を食った当たりには及ばない
 * （＝「詰まっても前へ飛ぶ」が「凡打がヒットになる」にはならない）。
 */
export const AVG_MISHIT_RELIEF = 0.5;

/**
 * 疲労MAXの投手から打ったときに打球初速へ上乗せされる量 m/s（フェーズB-11の「球威」）。
 *
 * **フェーズBBB-85で 5→2.9**。B-11 の +5 は、疲労で球速が落ちるぶん打球が弱くなる
 * （-4.2m/s × `EXIT_PITCH_CARRY` = -2.1m/s）のを上回らせるための値で、差し引きは +2.9m/s
 * だった。いまは投手の球速そのものが打球に乗らない（`carriedPitchSpeed`）ので、落ちるぶんが
 * 無い＝**差し引きの +2.9 をそのまま置く**。疲れた投手から打った打球は BBB-85 の前と同じ。
 * `tests/batting.test.ts` がこの導出（5 − 0.5 × 0.35 × 12）を固定する。
 */
export const EXIT_FATIGUE_BONUS = 2.9;

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
 * 押しバント（プッシュバント）の初速 m/s（十字キー上。フェーズY-46 → BBB-82で 17→13 →
 * BBB-85で 13→13.5）。
 *
 * **値は `npm run balance:bunt` が決めた**。ファウルライン際（±44°）へ転がすと、標準のバント
 * （11m/s）より遠くで止まって**投手が拾い上げるまでの時間が延びる**（1.82→1.98秒・本塁から
 * 12→14m）＝先頭の走者に 0.14秒が足される（標準のバントで生きるのは走力0.8以上の走者だけ、
 * 押せば平均より少し速い走者から生きる）。捕手が盗塁を刺す経路（2.74秒）よりも守備は遅い。
 *
 * **BBB-82（野手の足を原作の 6.0m/s に）で解き直した**。Y-46 の 17m/s は「投手の確保が
 * いちばん遅れる初速」で決めたが、投手が遅くなると：
 * - **17m/s は三塁手の立つ塁の手前まで転がる**（投手が追いつけない）。そこから一塁へは遠いので
 *   **足の速い打者（走力0.8以上＝名鑑176人中32人）が必ず内野安打になる**。
 * - **16〜16.5m/s は投手の確保が 2.6秒前後まで遅れ、誰が打っても全員セーフ**（14〜15m/s でも
 *   足の速い打者は生きる）＝アウトを差し出さない送りバント（Y-46 が「強すぎる」として塞いだ形）。
 *
 * そこで基準を**「いちばん足の速い打者でも一塁で刺される、いちばん大きい初速」**に置き直した
 * （13.75 まで。余裕を取って 13＝最速の打者でも 0.16秒差でアウト）＝**バントはアウトと
 * 引き換えの手**のまま。スクイズ（三塁走者の本塁突入）もこの初速では成立しない。
 *
 * **方向を外すと得は無い**：正面へ押すと投手の正面（0.87秒で拾われる＝標準の 0.98秒より速い）。
 *
 * **BBB-85（野手の足 6.0→7.0・CPU守備の反応 0.25→0.45秒）で 13→13.5**。投手の足が速くなった
 * ぶん、13 のままだと基準速の走者が 0.10秒差でアウト（BBB-83 は 0.05秒差）まで離れた。
 * **BBB-83 と同じ余裕になる初速**へ解き直した：13.5 で、いちばん足の速い打者は一塁で
 * 0.16秒差のアウト・スクイズは 0.11秒差で不成立（どちらも BBB-83 と同じ値）、先頭の走者は
 * 基準速で 0.08秒差のアウト・最速で 0.19秒差のセーフ（`npm run balance:bunt` の4c段目）。
 * 14 まで上げると基準速の走者がほぼ同着（0.06秒差）になるが、スクイズが 0.06秒差まで近づく。
 */
export const BUNT_PUSH_EXIT_SPEED = 13.5;
/**
 * バントの打ち上げ角（転がすので浅い）。
 * **フェーズRR-66で 7→8**：抗力を上げた（0.0006→0.0012）ぶん打球が早く死ぬので、
 * 押しバントの確保が 1.90→1.77秒まで**速く**なり、Y-46が測った送りバントの成立
 * （俊足の走者が +0.04秒でセーフ）が -0.007秒＝アウトへ反転していた。1°上げると
 * 滞空が伸びて確保が元へ戻る＝**Y-46の帯（押し・ライン際・俊足なら成立）はそのまま**。
 */
export const BUNT_LAUNCH_DEG = 8;
/**
 * 十字キー左右でバントを狙える最大角（±。45°を超えるとファウルゾーン）。
 *
 * 説明書p17 の送りバント「**バットをななめに出し、ファールラインぎりぎりに転がすのがコツ**」
 * をそのまま値にしたもの（フェーズY-46で 38°→44°）。ラインの内側1°で、打球は直線に
 * 転がるのでフェアのまま。**ライン際ほど投手が拾うまでの距離が伸びる**ので、
 * 「コツ」が実際に守備の時間として効く（`npm run balance:bunt` の4段目）。
 */
export const BUNT_MAX_DIRECTION_DEG = 44;

/**
 * 重力 m/s²（実際の値）。**打球の飛行と、でっかいモードの投球の見た目の弧が同じ1つを読む**
 * （フェーズPP-63で `core/camera.ts` の `pitchArcPath` が読むようになったので export した）
 * ＝**「見た目の重力」という自由変数を作らない**（W-44 が `FATIGUE_CONTROL_LOSS` を
 * `FATIGUE_SPEED_DROP` に揃え、CC-50 が腕のずれを O-36 の可動幅に揃えたのと同じ
 * **既にある値に揃える**やり方）。
 */
export const GRAVITY = 9.8;
/**
 * 空気抵抗の係数 1/m（フェーズJJ-57）。加速度は `-AIR_DRAG × |v| × v`（速さの2乗に比例）。
 *
 * **それまで飛行は重力だけの放物線だった**＝初速46m/sの打球が147m飛ぶ（実際の野球なら
 * 約120m）。初速を一律に下げる案は計測が退けた（`npm run balance:hr`）＝**安打率・
 * 内野安打まで一緒に削れてしまう**。抗力は**速さの2乗**で効くので、**長い飛球だけが
 * 強く縮み、ゴロ・ライナー・内野への打球はほとんど動かない**＝狙った場所にだけ効く。
 *
 * **実際の野球の値（≒0.006）は使えない**：この球場の柵（説明書p24-25の実寸）は
 * 抗力の無いモデルに合わせて決まっているので、本物の抗力を入れると飛距離が86〜106mに
 * なり**誰一人柵を越えられなくなる**（実測）。
 *
 * **フェーズRR-66で 0.0006→0.0012**（テストプレイの「相変わらずホームランが出すぎる」）。
 * JJ-57 が基準にしていたのは**基準速**の芯だったが、**CPUの初球は必ず速球**（+3m/s）で、
 * しかも**隅を狙うので接触点がずれて打ち上げ角が上がる**（21°→31°）＝
 * **46m/sの打球が178m飛ぶ**帯に入っていた。抗力だけでは直せない（上げるほど安打も
 * 一緒に消える）ので、**`EXIT_SPEED_BASE` と `EXIT_POWER_BONUS` と3つセット**で
 * 「弱い打者は芯でも越えない／強い打者は越える」へ寄せた（`npm run balance:plate` の10段目）。
 * **さらに削るならここを 0.0016 まで上げられる**（HR/試合 1.49→0.94本＝実際の野球の帯。
 * 代償は t=0 の得点 3.29→2.30点・格子の安打率 18.2→15.7%）。
 *
 * ## フェーズUU-69で 0.0012→0.0016（テストプレイの「若干変わったくらいな体感」）
 *
 * **RR-66 がここに書き残した推奨値そのもの**（2026-09-14 ユーザー判断）。RR-66 は
 * 「打者の差」を作るところまでで止め、**本数そのものを実際の野球の帯へ寄せるのは
 * 次回**として値だけ残していた。実測（`npm run balance:plate` の14段目。人間が初球の
 * 速球を振ったとき・押す時刻のばらつき σ=30ms）：**HR 6.4%→3.6%（−44%）**で、
 * **安打率は 19.3%→18.4% とほとんど動かない**＝**HRだけを削る**という抗力の性質が
 * ここでも効いている（0.0014 は中間で HR 4.9%）。格子の長打率（長打力1.0・ところざわ）は
 * 17.6%→14.5%。**戻すならこの1か所**で、帯は `npm run balance:hr` と14段目がそのまま出す。
 */
const AIR_DRAG = 0.0016;
const BOUNCE_RESTITUTION = 0.45;
const BOUNCE_FRICTION = 0.72;
/** バウンドの跳ね返りがこれ未満になったら転がりに移行 */
const BOUNCE_STOP_VY = 1.2;
/** 転がり中の減速度 m/s^2 */
const ROLL_DECEL = 5.5;
/** 転がりがこれ以下になったら静止 */
const REST_SPEED = 0.5;
export const WALL_RESTITUTION = 0.35;

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
  /**
   * その球を投げた投手の基準速 m/s（`PitchFlight.neutral`。フェーズBBB-85）。渡すと、打球に乗るのは
   * **その投手の基準速からの緩急ぶん**だけになる（`carriedPitchSpeed`）。ゲーム本体は必ず渡す。
   * 渡さなければ球速がそのまま乗る（投手を持たない素の球＝テストと一様な格子の計測）。
   */
  pitcherNeutral?: number;
}

/**
 * 打球の強さに乗る球速 m/s＝**基準の投手（`REFERENCE_PITCHER_NEUTRAL`）が同じ緩急で投げたときの
 * 球速**（フェーズBBB-85）。
 *
 * 速球は基準速より速いぶん飛び、遅い球は飛ばない（「速球ほど打たれたときのリスクが大きい」は
 * そのまま）。**投手の球速（SPD）そのものは打球の強さに乗らない**＝球の速い投手ほど打たれたら
 * 飛ぶ、にはしない。疲れて球速が落ちても、打球は弱くならない（球威の上乗せ `EXIT_FATIGUE_BONUS` は
 * そのぶんを差し引いた値にしてある）。
 *
 * `pitcherNeutral` を渡さなければ球速そのもの＝投手を持たない素の球。
 */
export function carriedPitchSpeed(pitchSpeed: number, pitcherNeutral?: number): number {
  return pitcherNeutral === undefined
    ? pitchSpeed
    : REFERENCE_PITCHER_NEUTRAL + (pitchSpeed - pitcherNeutral);
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
  const { crossX, swingTime, pitchSpeed, pitcherNeutral } = sample;
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
      EXIT_PITCH_CARRY * carriedPitchSpeed(pitchSpeed, pitcherNeutral) +
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
