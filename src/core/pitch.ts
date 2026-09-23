/**
 * 投球システムの純粋ロジック（判定・数値計算のみ、状態は持たない）。
 *
 * ファミスタ'90説明書（p19・p31）準拠の投球モデル：
 * - ①位置：投球前に十字キー左右で投手がプレート上を移動してリリース位置を決める。
 * - ②投球とスピード：モーション（ワインドアップ）中の上下入力で球速を事前選択する。
 *   上=フォーク/チェンジアップ（遅い球）、下=速球。球速はリリース時に確定し、
 *   飛行中は変わらない（かつては飛行中のリアルタイム加減速方式だったが、
 *   実機テストプレイ後の原作照合により説明書準拠の事前選択方式へ変更した。
 *   フォークの「落ちる」変化はv1では球速差のみで表現する）。
 * - ③コース：投げる瞬間の左右入力で、初期の横速度としてイン/アウトへ投げ分ける。
 * - ④変化球：リリース後の左右入力で横方向に加速（カーブ/シュート）。
 *   入力をやめても横速度は残る。
 * - ストライク判定は原作同様、本塁通過時の左右コースのみで行う（高低はゾーンに含めない）。
 * - 打者の立ち位置まで曲げると死球（デッドボール）。立ち位置は打席の左右（BOX）で
 *   反転する（フェーズB-9。BatterSide 参照。**右打者は三塁側＝-X**。フェーズBB-49）。
 *
 * 座標系は field.ts と同一（本塁原点、+Z=捕手方向、+X=一塁側）。
 * でっかいモードのカメラは -Z を向く（本塁後方から投手方向を見る）ため、
 * 「画面上の左右」とワールドXは同じ向きになる（反転不要）。カメラの向きを
 * 知っている呼び出し側（シーン層）がこの対応関係を担い、ここではワールド座標のみ扱う。
 */

export const PITCHER_PLATE_Z = -18.44;
/** リリース点（投手プレートのやや捕手寄り） */
export const RELEASE_Z = PITCHER_PLATE_Z + 0.8;
export const PLATE_Z = 0;
/** 捕手のミット位置。ここまで到達したら捕球して1球終了 */
export const CATCH_Z = 2.2;

/** 投手がプレート上で左右に移動できる範囲（±X） */
export const RUBBER_HALF_RANGE = 0.8;
/** プレート上の左右移動速度 m/s */
export const RUBBER_MOVE_SPEED = 4;

/** 球速 m/s（ニュートラル≒130km/h / 速球≒150km/h / フォーク・チェンジアップ≒80km/h） */
export const SPEED_NEUTRAL = 36;
export const SPEED_FAST = 42;
export const SPEED_SLOW = 22;
/** 左右入力による横方向加速度 m/s^2（曲がりの強さ） */
const STEER_ACCEL = 14;

// ---- 投手の能力値の反映（フェーズB-8。roster.ts の PitcherStats を参照） ----

/**
 * 能力値を渡さなかった場合の基準レーティング。ここを 0.5 に置き、下の SPD_SPAN /
 * STEER_ACCEL_SPAN を「0.5 のとき従来の定数ちょうどになる」よう決めてあるので、
 * **能力値を持ち込む前の投球と数値が完全に一致する**（既存の調整・テストの基準線）。
 */
export const NEUTRAL_RATING = 0.5;

/** 緩急3段階の、基準速からの差（説明書p19②の上下入力による事前選択） */
export const SPEED_FAST_DELTA = SPEED_FAST - SPEED_NEUTRAL;
export const SPEED_SLOW_DELTA = SPEED_NEUTRAL - SPEED_SLOW;
/**
 * 球速（SPD）0..1 が基準速を動かす幅 m/s。速球派（1.0）は基準速42・速球48、
 * 軟投派（0.0）は基準速30・速球36＝**軟投派の速球が速球派の基準速にも届かない**。
 * 緩急3段階の差（±SPEED_*_DELTA）は投手によらず一定なので、「誰が投げても
 * 上下入力の意味は同じ」という操作の一貫性は保たれる。
 *
 * **フォークの変化量Fを「緩急の幅」に繋ぐ案は計測で否定した**（フェーズO-35）。
 * 打球初速が `0.5 × 球速` を含むので**球速を動かすと必ず打球の質が動き**、
 * 遅くすれば弱い当たりが野手の前に落ち・速くすれば長打が増える＝
 * **中庸がいちばんアウトになりやすく、幅を広げると両側とも打者有利**になる
 * （名鑑の実レンジ F 0.38→0.90 でフォークの安打率 9.7%→17.0%・速球のHR率 14.2%→27.4%）。
 * Fは球速ではなく**フォークの曲がり**に繋いだ（下記 `steerAccelForSelection`）。
 */
export const SPD_SPAN = 12;

/**
 * 投手の基準速 m/s＝**緩急の中心**（上下無入力のときの球速）。SPDだけで決まる。
 *
 * `speedForPitchSelection` と**シーン層の見た目（ドロップ・残像）が同じ関数から
 * 中心を取る**ので、「速球派の投手のフォークが、平均的な投手の基準速より速い」
 * ような球でも**見た目が正しく『遅い球』として描かれる**（B-9で立ち位置と死球ゾーンを
 * 同じ定数から求めたのと同じ整理）。
 */
export function neutralSpeedFor(pitcherSpeed: number = NEUTRAL_RATING): number {
  return SPEED_NEUTRAL + (clamp01(pitcherSpeed) - NEUTRAL_RATING) * SPD_SPAN;
}

/**
 * その球が**その投手の基準速からどれだけ遅い／速いか**（0..1）。
 *
 * 見た目（弧・残像。`core/camera.ts` の `pitchArcPath` / `dekkaiBallTrail`）が読む重み。
 * **フェーズPP-63でシーン層からここへ移した**＝それまで `dekkaiScene.ts` の中に式が
 * 直接書かれていて、計測（`npm run balance:flight`）とテストが同じ定義を読めなかった。
 * 中心は必ず `neutralSpeedFor`（＝その投手の基準速）から取るので、**速球派のフォークも
 * 「その投手にとって遅い球」として正しく描かれる**（上のコメントの取り決めのまま）。
 */
export function pitchSlowness(vz: number, neutral: number = SPEED_NEUTRAL): number {
  return clamp01((neutral - vz) / SPEED_SLOW_DELTA);
}

export function pitchFastness(vz: number, neutral: number = SPEED_NEUTRAL): number {
  return clamp01((vz - neutral) / SPEED_FAST_DELTA);
}

/** 変化量0..1 → 横方向加速度 m/s^2 の下限と幅（0.5 で従来の STEER_ACCEL=14） */
export const STEER_ACCEL_MIN = 9;
export const STEER_ACCEL_SPAN = 10;

/**
 * 投球の判定に効く投手の能力値（フェーズB-8。`roster.ts` の `PitcherStats` の部分集合）。
 * 球速は緩急3段階すべての基準を上下させ、変化量は曲げたときの効き幅を決める。
 *
 * **疲労は呼び出し側（main.ts の `currentPitchProfile`）で織り込み済み**の値が入る
 * （`fatiguedSpeed`/`fatiguedBreak`）ので、ここから先は「いまのこの投手の球」として
 * そのまま読める。人間の投球（シーン層）もCPUの投球（`cpuPitcher.ts`）も同じ型を通る
 * ＝**能力値の効き方が攻守どちらの経路でも1つ**（フェーズP-37）。
 */
export interface PitchProfile {
  /** 球速（SPD）0..1 */
  speed: number;
  /** 変化量：カーブ方向（左へ曲げるとき）0..1 */
  breakLeft: number;
  /** 変化量：シュート方向（右へ曲げるとき）0..1 */
  breakRight: number;
  /**
   * 変化量：フォーク（F）0..1（フェーズO-35。説明書p26-29）。**上入力で選んだ
   * 遅い球（フォーク/チェンジアップ）を曲げるときだけ、R/L の代わりにこれを使う**
   * （下記 `steerAccelForSelection`）。球速には効かない。
   */
  fork: number;
}

/** 能力値を渡さないときの投手（すべて基準値＝能力値を持ち込む前とまったく同じ球） */
export const NEUTRAL_PITCH_PROFILE: PitchProfile = {
  speed: NEUTRAL_RATING,
  breakLeft: NEUTRAL_RATING,
  breakRight: NEUTRAL_RATING,
  fork: NEUTRAL_RATING,
};

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// ---- スタミナ消耗による球威の低下（フェーズB-11。roster.ts の fatigueOf を受け取る） ----
//
// 疲労は**能力値を下げる形で効かせる**（別系統の補正値を後段に足すのではなく、
// 「疲れた投手＝一時的に球速も変化量も低い投手」に読み替える）。こうすると、下流の
// speedForPitchSelection / steerAccelFor は一切変わらず、緩急3段階の幅も曲げ方の操作感も
// そのまま＝**疲れても操作の意味は変わらず、効き幅だけが痩せる**。
//
// 疲労0では入力の能力値をそのまま返すので、B-8の基準線（既存の調整とテスト）は動かない。

/** 疲労MAXで球速レーティングが下がる量（0.72の先発なら 0.37 相当＝約 -4.2m/s） */
export const FATIGUE_SPEED_DROP = 0.35;
/**
 * 疲労MAXで変化量が失われる割合。**1.0＝レーティングが0まで落ち、曲がりは
 * `STEER_ACCEL_MIN` の下限だけが残る**（誰が投げても同じ最低限の変化になる）。
 *
 * ここを半端な値にすると**変化量の低下が体感できない**：疲労で球速も落ちるぶん
 * ボールが本塁に届くまでの時間が延び（38.6→34.4m/s で約+12%）、横の移動量は
 * 時間の2乗で効くので、加速度を2割減らした程度では総移動量がほぼ変わらない
 * （実機で無傷 -2.37m に対し疲労MAX -2.48m ＝むしろ増える、を実測して判明した）。
 * 下限まで落として初めて「曲げても曲がらない」が実際の軌道に出る。
 */
export const FATIGUE_BREAK_LOSS = 1;

/** 疲労を織り込んだ球速（SPD）レーティング */
export function fatiguedSpeed(speed: number, fatigue: number): number {
  return clamp01(clamp01(speed) - FATIGUE_SPEED_DROP * clamp01(fatigue));
}

/** 疲労を織り込んだ変化量レーティング（曲がりの強さ） */
export function fatiguedBreak(breakAmount: number, fatigue: number): number {
  return clamp01(breakAmount) * (1 - FATIGUE_BREAK_LOSS * clamp01(fatigue));
}

/**
 * 疲労MAXで**制球**レーティングが下がる量（フェーズW-44）。B-11がユーザー判断で確定した
 * 「疲労で効くのは球速・変化量・球威の3つ」に**4つ目**を足したもので、T-41でERAが判定に
 * 効くようになって初めて書けるようになった（それまで制球という軸そのものが無かった）。
 *
 * **形は `fatiguedSpeed` と同じ引き算**（`fatiguedBreak` の掛け算ではない）。制球は
 * 「レーティングが0でも下限の何かが残る」量ではなく、0がそのまま「いちばん荒れた投手」
 * を意味する軸だから＝下流（`cpuControlSpray`）が 0..1 をそのまま受け取れる。
 *
 * ## 値は `FATIGUE_SPEED_DROP` と同じ 0.35（新しい自由変数を作らない）
 *
 * **P-37・T-41が使った「名鑑96人で頭打ちになる投手が0人になる最大値」という基準は、
 * ここでは効かない**ことを計測が示した（`npm run balance:control` の8段目）：制球は
 * `clamp01` で0止まりで、制球0の投手の狙い（0.990）は T-41 が既に上限 1.0 の内側に
 * 収めてある＝**どれだけ疲れさせても頭打ちは 0/96 のまま**で、この基準では値が決まらない。
 * そこで**疲労がレーティングを削る量の基準線＝B-11の球速（0.35）に揃えた**
 * （`pitcherRole` を STM から、`cpuPitcherStyle` を SPD/F から導いたのと同じ「既にある
 * ものから決める」）。計測はそのうえで**帰結を4つ固定した**（同8段目）：
 *
 * - 疲労MAXで**見逃し三振を取れる投手が 8/96 → 0/96**（RR-66で無傷の側が 15→8 になった）（決め球の値打ちが疲労で失われる）。
 * - **打席中央で死球がありうるのが 3/96 → 29/96**（ユーザー判断「荒れは死球まで届く」）。
 * - **打席から離れれば 0/96 のまま**＝T-41の不変条件（打者に避ける手が実在する）は不変。
 * - 見逃し続けたときの帰結が無傷から変わるのは 15/96人。
 *
 * ただし**この数字が出るのは疲労1.0＝残量0のとき**で、CPU投手はJ-30の自動継投が
 * 残量0.5で必ず代えるため、実測の最大疲労は 0.029〜0.123（16球団平均 0.091。同9段目）。
 * **CPU側で荒れるのはブルペンが尽きた場面だけ**で、疲労が実際に高くなるのは
 * **自動継投しない人間の投手のほう**（無傷でも120球で1.00／V-43の持ち越しで残量0.6から
 * 始まれば80球で1.00）＝そちらは下の `courseReleaseVxFor` が受け持つ。
 */
export const FATIGUE_CONTROL_LOSS = 0.35;

/**
 * 疲労を織り込んだ制球レーティング（フェーズW-44）。疲労0では入力をそのまま返すので、
 * **T-41の配球はこの関数を通しても1mmも動かない**（B-8以来の基準線を崩さない）。
 *
 * これを読むのは**CPU投手の狙い**だけ（`cpuControlSpray`）。人間の投球にズレは足さない
 * （T-41のユーザー判断）＝人間側は下の `courseReleaseVxFor` で「狙える幅」が痩せる。
 */
export function fatiguedControl(
  control: number,
  fatigue: number,
  loss: number = FATIGUE_CONTROL_LOSS,
): number {
  return clamp01(clamp01(control) - loss * clamp01(fatigue));
}

/**
 * 変化量（0..1）→ リリース後の左右入力による横方向加速度。
 * 大きく曲がる投手ほど、同じ入力でもコースを大きく動かせる（説明書p19④）。
 */
export function steerAccelFor(breakAmount: number): number {
  return STEER_ACCEL_MIN + STEER_ACCEL_SPAN * clamp01(breakAmount);
}

// ---- フォークの変化量（F。フェーズO-35。説明書p26-29の投手データ F） ----
//
// **原作の変化量は R（右）/ L（左）/ F（フォーク）の3つ**だが、F だけが名鑑に
// 値を持ちながら**判定側に読む側が1つも無かった**（96人ぶんの数値が死んでいた）。
//
// この投球は**高低を持たない**（ストライク判定は左右コースのみ＝説明書p19準拠）ので、
// 「変化」が意味を持てるのは横の動きだけ。したがって F は
// **「フォークを選んだときの曲がりの強さ」**として R/L と同じ経路に載せる。
// 球速には一切触らないので、打球初速（`0.5 × 球速`）への副作用が構造的に生じない。
//
// **CPU投手は変化球を投げない**（`cpuPitcher.ts` は左右ステアを常に0にする）ので、
// F は R/L とまったく同じ扱いになる＝人間の投手にだけ効く。新しい非対称は増えていない。

/**
 * 緩急の選択（説明書p19②）に応じた、リリース後の左右入力の曲がりの強さ。
 *
 * - 上（+1）＝フォーク/チェンジアップ → **F**（フォークの変化量）
 * - それ以外（速球・基準速）→ 曲げる向きに応じた **R/L**（従来どおり）
 *
 * **Fを渡さない呼び出しは従来と完全に同じ**（既定が基準値0.5＝`STEER_ACCEL`）なので、
 * B-8以来の基準線もテストも動かない。
 *
 * なお遅い球はもともと飛行時間が長く、横の移動量は時間の2乗で効く（B-11の実測）。
 * F はその上に乗るので、**フォークを持ち球にする投手の球は実際に大きく動く**。
 */
export function steerAccelForSelection(
  speedSelection: -1 | 0 | 1,
  breakAmount: number = NEUTRAL_RATING,
  fork: number = NEUTRAL_RATING,
): number {
  return steerAccelFor(speedSelection > 0 ? fork : breakAmount);
}
/**
 * 「投げる瞬間」の左右入力によるコース投げ分けの初期横速度 m/s（説明書p19③）。
 * 基準球速での本塁到達時間（約0.49秒）に対しズレ幅が約0.44m＝ストライクゾーン
 * 半幅（0.45）とほぼ同じになる値：ど真ん中リリースからコース入力だけで
 * ゾーンぎりぎりの隅を突ける（それより外すにはプレート位置や変化球と組み合わせる）。
 */
export const COURSE_RELEASE_VX = 0.9;

// ---- 制球が人間の投球に出る場所（フェーズW-44） ----
//
// T-41 は「**人間が投げる球は狙ったところへ行く**」（＝ズレを足さない。自分の入力が
// 裏切られるとストレスになる）というユーザー判断で、制球をCPUの狙いにだけ効かせた。
// その結果**制球スキルを自分の投手に付けても人間が投げる限り何も起きない**＝⑧が禁じる
// 死に札になるので、W-44 で人間側にも制球の出口を1つ作った（ユーザー判断）。
//
// **出口は「誤差」ではなく「効き幅」**：コース入力の向きへは必ず動き、動く量だけが増減する
// ＝B-11が疲労で球速・変化量を痩せさせているのとまったく同じ形なので、T-41の判断
// （狙ったところへ行く）とも衝突しない。**制球という1つの軸が、投げる側によって
// 違う場所に出る**だけで、出どころ（ERA）は攻守どちらでも同じ1つ。

/**
 * 制球1.0ぶんで `COURSE_RELEASE_VX` を動かす量（フェーズW-44）。
 *
 * **`npm run balance:control` の10段目が決めた**（CLAUDE.md「バランス調整の方針」）。
 * 基準は**新しい数値を持ち込まず既にある隅に合わせる**こと＝**制球 +0.20 の投手が、
 * ど真ん中のプレート位置から「CPUの決め球と同じ隅」（ゾーン半幅 0.45 ＋ 際どさ 0.05
 * ＝ `cpuPitcher.ts` の `CORNER_MARGIN`）へ届く**値。補正なしの届くXは 0.441＝ゾーン半幅
 * とほぼ同じ（`COURSE_RELEASE_VX` のコメントどおり）なので、**制球スキルの値打ちは
 * 「ゾーンの外まで届く＝ボール球で釣れる」ぶん**だとひと言で言える。
 *
 * 代償の側も同じ値から出る：疲労MAXでは届くXが 0.441 → 0.338（-23%）＝
 * **ど真ん中に立ったままでは隅が突けなくなる**（プレート位置や変化球と組み合わせれば
 * 従来どおり届く＝`COURSE_RELEASE_VX` が元から想定している役割分担のまま）。
 */
export const COURSE_VX_PER_CONTROL = 0.6;

/**
 * 「投げる瞬間」の左右入力の効き幅（フェーズW-44）。
 *
 * - `controlBonus`＝**名鑑のERAからの差**（スキルの制球補正。`roster.ts` の `controlBonusOf`）。
 *   素のERAは効かせない＝**スキルも疲労も無ければ T-41 の前と完全に同じ 0.9**
 *   （B-8以来の「渡さない呼び出しは従来どおり」）。
 * - `fatigue`＝B-11の疲労。`FATIGUE_CONTROL_LOSS` ぶんの制球として引く（同じ定数を
 *   CPUの狙い（`fatiguedControl`）と共有するので、疲労の重さが2か所に分かれない）。
 *
 * 0で下げ止めるのは**入力の向きだけは絶対に裏切らないため**（負にすると押した側と
 * 逆へ動く）。どれだけ疲れてもコースは選べて、選べる幅が狭くなるだけになる。
 */
export function courseReleaseVxFor(controlBonus = 0, fatigue = 0): number {
  const bonus = controlBonus - FATIGUE_CONTROL_LOSS * clamp01(fatigue);
  return Math.max(0, COURSE_RELEASE_VX + COURSE_VX_PER_CONTROL * bonus);
}

/** ストライクゾーン半幅（左右コースのみで判定、原作準拠） */
export const STRIKE_ZONE_HALF_WIDTH = 0.45;

// ---- 打席の左右（説明書のBOX。フェーズB-9） ----

/**
 * 打席の左右を判定式に持ち込むための符号。**ワールドXにこの符号を掛けると
 * 「打者から見たX」になる**（打者ローカル座標。**+X＝内角＝打者が立っている側**）ので、
 * 片方の打席ぶんだけ調整した式（死球ゾーン・バットの到達範囲・引っ張り方向）を
 * そのまま反対の打席にも使える。
 *
 * - `-1` = 右打者：打者は **-X 側（三塁側）** に立ち、内角も引っ張りも -X（左翼方向）。
 * - `+1` = 左打者：上記のすべてがXについて鏡像（一塁側に立ち、引っ張りは +X）。
 *
 * **右打者が -1 なのは実際の野球の打席の位置そのもの**（フェーズBB-49）。一塁が +X
 * （`fielding.ts` の `BASE_POSITIONS`）なので、右打者は本塁を挟んだ反対＝三塁側に立つ。
 * B-9〜AA-48 はこれが逆（右打者が一塁側）で、そのぶん引っ張りを「打者から遠い側」に
 * 置いて打ち消していた＝**ワールドの打球方向は BB-49 の前後で変わっていない**
 * （右打者は従来どおり左翼へ引っ張る）。動いたのは「どちらの側に立つか」と
 * 「どちらが内角か」だけで、判定式は打者ローカルのまま1つも触っていない。
 */
export type BatterSide = 1 | -1;
export const RIGHT_BATTER_SIDE: BatterSide = -1;
export const LEFT_BATTER_SIDE: BatterSide = 1;

/** ワールドX → 打者から見たX（打者ローカル座標）。左打者なら左右が入れ替わる */
export function batterFrameX(worldX: number, side: BatterSide = RIGHT_BATTER_SIDE): number {
  return worldX * side;
}

/** 打者の立ち位置X範囲（打者ローカル）。ここを通ると死球 */
/**
 * **フェーズRR-66で 0.9〜1.7 から本塁側へ寄せた**：判定のバットの到達範囲を
 * **描かれたバットが実際に覆う範囲**へ狭めた（`BAT_REACH_OUTSIDE_X`）結果、
 * **打者がここまで遠いと外角のストライクに届かなくなる**ため。B-9の不変条件どおり
 * **死球ゾーンと打者の立ち位置（`BATTER_STAND_X`）は同じ定数から出す**ので、
 * 見た目の打者もここで一緒に前へ出る（1.3→1.05）。
 * `CPU_CONTROL_MAX_TARGET`（T-41のCPUの狙いの上限）もここからの導出なので一緒に動く。
 */
export const BATTER_ZONE_MIN_X = 0.65;
export const BATTER_ZONE_MAX_X = 1.45;
/**
 * 打者が立つX（打者ローカル。打席の中央）。シーン層の打者プレースホルダーの
 * 立ち位置もこの値から求めることで、**見た目の立ち位置と死球ゾーンがずれない**。
 */
export const BATTER_STAND_X = (BATTER_ZONE_MIN_X + BATTER_ZONE_MAX_X) / 2;

// ---- 打席内の立ち位置（説明書p14「+でバッティングポジションを決め」。フェーズO-36） ----

/**
 * 打席中央（`BATTER_STAND_X`）からどれだけ動けるか（打者ローカルXの ± 幅 m）。
 *
 * **符号は打者ローカルXの向きそのまま**＝ **負がプレートに寄る／正が離れる**
 * （打者ローカルでは打者は必ず +X 側に立っているので、本塁＝原点に近づくほどXは小さい）。
 *
 * この1つの値から**バットの到達範囲**（`batReachFor`）・**死球ゾーン**（`judgePitch`）・
 * **見た目の立ち位置**（`batterStandX`）・**銃の命中ゾーン**（`judgeShot`）がすべて
 * 導出される＝「寄ったのに死球ゾーンだけ動かない」が構造的に起きない
 * （B-9で立ち位置と死球ゾーンを同じ定数から求めたのと同じ整理）。
 *
 * 幅は `npm run balance:stance` で決めた（CLAUDE.md「バランス調整の方針」）。
 * **寄り切っても内角のストライクにバットが届く**ぎりぎりの値にしてあるので、
 * 「寄ったら内角は打てない」という詰み方はしない（届くが必ず詰まる）。
 */
export const BATTER_STANCE_RANGE = 0.16;

/** 立ち位置の左右移動速度 m/s（投球前のプレート移動 `RUBBER_MOVE_SPEED` と同じ手触り） */
export const BATTER_STANCE_MOVE_SPEED = 1.2;

/**
 * 立ち位置のオフセットを可動範囲へ収める。**壊れた値を渡しても打席の外には出られない**
 * （`normalizeRosterPlan` が壊れた打順を既定へ落とすのと同じ扱い）。
 */
export function clampStance(offset: number): number {
  return Math.max(-BATTER_STANCE_RANGE, Math.min(BATTER_STANCE_RANGE, offset));
}

/**
 * 打者が実際に立つワールドX。打席の左右（side）と打席内の立ち位置（stance）の両方から
 * 求める唯一の場所で、シーン層の見た目もここから起こす。
 */
export function batterStandX(
  side: BatterSide = RIGHT_BATTER_SIDE,
  stance = 0,
): number {
  return (BATTER_STAND_X + clampStance(stance)) * side;
}

// ---- 投球腕（説明書p26-29のARM。フェーズCC-50） ----
//
// **ARM は B-9 以来「両打ち（BOX=S）がどちらの打席に立つか」を決めるだけ**で、
// 96人ぶんの値が判定にも見た目にもほとんど効いていなかった（O-35のF・T-41のERAと
// 同じ「名鑑にあるのに読む側がいない数値」）。しかも `entities/player.ts` の投球姿勢は
// **全投手が +X側（一塁側）の腕**で投げていた＝実際の野球なら**全員が左投手**の見え方で、
// 名鑑の8割を占める右投げが1人も右投げに見えていなかった。
//
// ## 腕の角度（スロット）1つから、見た目と判定の両方が出る
//
// 持つのは**腕がどちら側にあるか（`side`）と、腕の角度（`slot`）**の2つだけで、
// **リリース位置の横のずれ**（判定）も**描く腕の傾き**（見た目）も、そこからの導出：
//
//     ずれ = side × ARM_RELEASE_REACH × sin(スロット角)
//
// 腕を鉛直から `θ` 傾ければ手は `腕の長さ × sinθ` だけ横へ出る、という素直な幾何
// （`entities/player.ts` の腕は `rotation.z` で傾け、**その横成分は投球の振り
// （`rotation.x`）に一切影響されない**＝見た目の横のずれが式どおりに出る）。
// B-9が打席の左右を符号1つに畳んだのと同じ整理で、**片側ぶんの式をそのまま反対側に使う**。

/** 投げ方（説明書のARM）。R/L＝オーバースロー・S＝サイドスロー・U＝アンダースロー */
export type PitchArmSlot = 'over' | 'side' | 'under';

/**
 * 腕がどちら側にあるか。**ワールドXの符号そのもの**（`BatterSide` と同じ持ち方）。
 *
 * - `-1` = 右投げ：投手は本塁を向いて立つので、右腕は **-X 側（三塁側）**。
 * - `+1` = 左投げ：一塁側。
 *
 * でっかいモードのカメラは -Z を向く（画面右＝+X）ので、**右投手の球は画面左から出る**
 * ＝捕手の後ろから見た実際の野球の絵。`RIGHT_BATTER_SIDE` が -1 なのと同じ理由で、
 * 右投手・右打者は**同じ側**（三塁側）に立つ＝球が打者の背中側から出てくる。
 */
export type PitchArmSide = 1 | -1;
export const RIGHT_ARM_SIDE: PitchArmSide = -1;
export const LEFT_ARM_SIDE: PitchArmSide = 1;

/** 投球腕（名鑑のARM → `roster.ts` の `pitchArmOf` が畳んだもの） */
export interface PitchArm {
  side: PitchArmSide;
  slot: PitchArmSlot;
}

/** 能力値を渡さないときの投手＝右のオーバースロー（名鑑でいちばん多い形） */
export const NEUTRAL_PITCH_ARM: PitchArm = { side: RIGHT_ARM_SIDE, slot: 'over' };

/**
 * 投げ方ごとの腕の角度（鉛直からの傾き rad）。**見た目（`applyPitch` の `rotation.z`）と
 * 判定（リリースの横のずれ）が共有する唯一の軸**なので、ここを動かせば両方が一緒に動く。
 *
 * 上手（over）はほぼ真上から、横手（side）はほぼ水平、下手（under）はその中間
 * ＝**変則（S・U）ほど球の出どころが体から遠い**という、腕の角度そのものの帰結。
 */
export const ARM_SLOT_RAD: Record<PitchArmSlot, number> = {
  over: 0.35,
  under: 0.95,
  side: 1.4,
};

/**
 * 腕を真横（スロット90°）まで倒したときのリリースの横のずれ m。
 *
 * **モデルの実寸（肩0.20m＋上腕0.28m＋前腕0.345m＝0.825m）ではない**。実寸のまま
 * 入れると P-37 の逆算（狙うコースから曲がり幅ぶん戻したところがリリース位置）が
 * プレートの外へ出て**削られ、名鑑の変化量の差が消える**＝P-37 が
 * `CPU_BREAK_STEER_SEC` を決めたときとまったく同じ失敗になる（`npm run balance:arm`
 * の2段目：実寸のままだと 65球/1152 が削られ、曲げ終わりも 16%→54% まで延びる）。
 *
 * ## 「頭打ち0人」の基準はここでは効かない（W-44 と同じ結論）
 *
 * 削りを完全に0にできるのは **reach 0.10**（＝上手のずれ 3cm）までで、そこでは
 * **「判定にも効かせる」というユーザー判断がほぼ死文**になる（同2段目）。
 * P-37・T-41が使った基準がここでは値を決められないので、W-44 が
 * `COURSE_VX_PER_CONTROL` を「既にある隅（`CORNER_MARGIN`）に合わせる」で決めたのと
 * 同じやり方を採った＝**いちばん外から出る横手のずれを、打者が立ち位置で動ける幅
 * （`BATTER_STANCE_RANGE`。フェーズO-36）に合わせる**。
 *
 * **投手が腕で持つ左右のずれと、打者が立ち位置で持つ左右の幅が同じ大きさ**になる
 * ＝どちらも「相手のコースの取り方を、投げる前／振る前に少しずらす」手なので釣り合う。
 * 幅そのものを新しい定数として持たないので、O-36 の可動幅を動かせばここも一緒に動く
 * （`cpuControlSpray` が `CORNER_MARGIN` と `CPU_CONTROL_EDGE` から膨らみを導くのと同じ整理）。
 *
 * この値で削られるのは **2球/1152（Z-47が測ったCPUの最大疲労0.600でも）・最大 2cm**で、
 * **曲げ終わりの割合は16%のまま動かない**＝P-37 が守りたかったもの（名鑑の変化量が
 * 球の差になること・見てから振れること）はどちらも無傷（同2段目）。
 */
export const ARM_RELEASE_REACH = BATTER_STANCE_RANGE / Math.sin(ARM_SLOT_RAD.side);

/** その腕のリリース位置の横のずれ（ワールドX。右投げなら負＝三塁側） */
export function armReleaseOffsetX(arm: PitchArm = NEUTRAL_PITCH_ARM): number {
  return arm.side * ARM_RELEASE_REACH * Math.sin(ARM_SLOT_RAD[arm.slot]);
}

// ---------------------------------------------------------------------------
// リリースの高さ（フェーズMM-60）
// ---------------------------------------------------------------------------
//
// CC-50 が**スコープ外として明示的に残した1つ**＝それまで `RELEASE_HEIGHT` は 1.5m 固定で、
// **下手投げ（U）が低い位置から出てくる見た目**にはなっていなかった（横のずれだけで
// 表していた）。この投球は**高低をゾーン判定に含めない**（説明書p19準拠。`PitchFlight` は
// x と z しか持たない）ので、**ここから下は判定に一切効かない**＝LL-59（ちっちゃいモードの
// 縮尺）と同じ「見た目だけの値」。
//
// ## 「球の高さだけ腕から導く」では足りない（計測が示した）
//
// `applyPitch` はリリースの瞬間に腕を**前方水平**（`rotation.x` = 4.7rad）まで振り切るので、
// 手の高さに残るのは cos(4.7)≒-0.012 の分だけ＝**横の傾き（スロット）を変えても手は肩の
// 高さに張り付く**（`npm run balance:release` の1段目：3スロットの差は 0.053m＝実質ゼロ）。
// そこで球だけ下げると、**下手投げは手からボールが離れる**＝CC-50 が守った
// 「見た目と判定が同じ値から出る」の逆をやることになる。
//
// ## てこは上体の傾き（実際の submarine が低く出せる理由そのもの）
//
// 肩の1点で回すだけでは「横へ遠く」と「低く」は両立しない：横へ出す（sinφ）ほど縦に使える
// 長さ（cosφ）が減るので、**横手ほど手は肩の高さに張り付く**。実際の横手・下手投げは
// **上体を投げる側へ傾けて肩ごと下げている**ので、そこを軸に採った。**この1つの値から、
// 描く姿勢（`applyPitch` の `Torso.rotation.z`）と球の出どころの高さの両方が出る**
// ＝CC-50 が腕の角度1つから「描く腕の傾き」と「リリースの横のずれ」を出したのと同じ形。

/**
 * リリースの瞬間の上体の傾き（rad。**投げる肩が下がる向き**）。
 *
 * **上手は 0＝従来の姿勢そのまま**（`RELEASE_HEIGHT` も 1.5m のまま）。名鑑96人のうち
 * **85人（89%）が上手**なので、**大多数の投手の見え方は1ドットも動かない**
 * ＝B-8の「基準値0.5＝従来の定数」、S-40の「基準速の走者はちょうど従来の78m」、
 * CC-50の「渡さない呼び出しは従来と同じ」と同じ**基準線を動かさない**整理。
 *
 * **横手のほうが下手より傾きが小さい**のは、傾けたときに下がる量が「体の中心から手までの
 * 横の距離」に比例するから（横手は腕が横へ長く出ているぶん、同じ傾きでよく下がる）＝
 * `ARM_SLOT_RAD` の大小とは逆になる。**実際の野球の見え方（上手＞横手＞下手の順に低い）**
 * に合わせるため、スロットごとに別々の値を持つ（`ARM_SLOT_RAD` と同じ形の表）。
 *
 * 値は `npm run balance:release` が決めた（帯は「どの2つの投げ方も画面で見分けが付く
 * 0.20m 以上離れる」〜「手が腰（0.87m）より下がると腕が軸足を突き抜ける」）：
 * 横手 0.25 / 下手 0.55 で **上手1.500m / 横手1.283m / 下手1.051m**＝どの隣り合う2つも
 * 0.21m 以上離れ、下手でも腰まで 0.18rad の余裕が残る。
 */
export const ARM_RELEASE_LEAN_RAD: Record<PitchArmSlot, number> = {
  over: 0,
  under: 0.55,
  side: 0.25,
};

/**
 * 上手のリリースの高さ（m）＝**基準線**。
 *
 * この 1.5m は CC-50 までの `dekkaiScene.ts` の `RELEASE_HEIGHT` そのままで、**実測すると
 * 上手の手の高さ（1.501m）とぴったり一致する**（`npm run balance:release` の1段目）＝
 * もともと「球は上手の手から出ている」ことを表していた値なので、上手を動かさないという
 * 判断は「球を手から離さない」ことと同じ意味になる。
 */
export const RELEASE_HEIGHT = 1.5;

/**
 * 捕手のミットの高さ（m）＝**球の行き先の高さ**。`RELEASE_HEIGHT` と対になる値なので
 * 隣に置く（フェーズNN-61で `scenes/dekkaiScene.ts` からここへ移した＝でっかいモードの
 * ボールの見かけの大きさの基準点（`core/camera.ts` の `DEKKAI_BALL_ANCHOR`）が
 * この高さを要るようになったため。**値は 1.0 のまま**）。
 *
 * **投手の投げ方では動かない**（フェーズMM-60）＝ミットがあるのは捕手のいる場所で、
 * 実際の野球でも下手投げの相手だからといって低く構えたりはしない。球の出どころのほう
 * （`armReleaseHeight`）だけが腕で動く。
 */
export const CATCH_HEIGHT = 1.0;

// ---- 下の2つはモデルの寸法の写し（`entities/player.ts` / `src/assets/player.glb`）。
//      `ARM_RELEASE_REACH` が実寸の腕を写しているのと同じ扱いで、姿勢を作り直したら
//      ここも一緒に直す（`npm run balance:release` が順運動学で解いた値と突き合わせる）。
/** リリースの瞬間の腰の高さ（`applyPitch` の `HIP_HEIGHT - 0.05`） */
const RELEASE_HIP_HEIGHT = 0.87;
/** 体の中心から肩まで（glb の ArmUpper の x） */
const SHOULDER_HALF_WIDTH = 0.2;
/** 肩から手まで（上腕0.28＋前腕0.345を、リリースの肘の曲げ -0.2rad で畳んだ実効の長さ） */
const RELEASE_ARM_REACH = 0.618;

/**
 * **見た目の**手の横位置（体の中心から。ワールドX）。
 *
 * 判定に持ち込む `armReleaseOffsetX` は、これをプレートが吸収できる幅まで縮めたもの
 * （CC-50。実寸のままだと P-37 の逆算がプレートの外へ出て曲がりが削られる）＝
 * **こちらが実寸で、あちらが判定用**。高さの落差は「体の中心から手までの横の距離」に
 * 比例するので、ここでは縮める前の実寸を使う。
 */
export function armReleaseHandOffsetX(arm: PitchArm = NEUTRAL_PITCH_ARM): number {
  return arm.side * (SHOULDER_HALF_WIDTH + RELEASE_ARM_REACH * Math.sin(ARM_SLOT_RAD[arm.slot]));
}

/**
 * その腕のリリースの高さ（ワールドY。m）＝**球の出どころ**。
 *
 * 上体を腰まわりに θ 傾けると、腰から見て高さ h・横 d にある手は
 * `h·cosθ − d·sinθ` へ移る＝落差は `h(1−cosθ) + d·sinθ`。**`applyPitch` が実際に書く
 * 傾きと同じ値から解く**ので、球は必ず手から出る（`npm run balance:release` の5段目で
 * 順運動学の厳密解と突き合わせ、差は最大 0.011m＝720pで 0.4px＝1ピクセル未満）。
 *
 * **上手は傾き0なので `RELEASE_HEIGHT` ちょうど**（従来と完全に同じ）。
 */
export function armReleaseHeight(arm: PitchArm = NEUTRAL_PITCH_ARM): number {
  const lean = ARM_RELEASE_LEAN_RAD[arm.slot];
  const above = RELEASE_HEIGHT - RELEASE_HIP_HEIGHT;
  const lateral = Math.abs(armReleaseHandOffsetX(arm));
  return RELEASE_HEIGHT - (above * (1 - Math.cos(lean)) + lateral * Math.sin(lean));
}

/**
 * プレート上の立ち位置（＝投手の体）→ ボールが出るX。
 *
 * **真実はプレート上の立ち位置の側**（説明書p19①「+でプレート上の位置を決める」＝
 * 人間が動かすのも、CPUが解くのもこちら）で、リリース位置はそこからの導出＝
 * 「見えている投手の位置」と「球の出どころ」が食い違わない。
 * `releaseOffset` を渡さない呼び出しは従来と完全に同じ（B-8以来の基準線）。
 */
export function releaseXFor(plateX: number, releaseOffset = 0): number {
  return plateX + releaseOffset;
}

/**
 * 逆に「ここから投げたい」を、**プレート上に立てる範囲**へ収めたリリース位置に直す
 * （P-37の逆算がプレートからはみ出したぶんを削るのに使う）。窓は腕のぶんそのままずれる
 * ＝**右投手は三塁側へ広く・一塁側へ狭い**（腕の側へは楽に投げられる）。
 */
export function clampReleaseX(releaseX: number, releaseOffset = 0): number {
  return releaseXFor(clampRubberX(releaseX - releaseOffset), releaseOffset);
}

/** 飛行中のボール状態（高低はゾーン判定に無関係なので持たない） */
export interface PitchFlight {
  x: number;
  z: number;
  vx: number;
  vz: number;
}

export type PitchCall = 'strike' | 'ball' | 'hitByPitch';

export function clampRubberX(x: number): number {
  return Math.max(-RUBBER_HALF_RANGE, Math.min(RUBBER_HALF_RANGE, x));
}

/**
 * ワインドアップ中の上下入力→リリース球速（説明書p19②の事前選択）。
 * 上（+1）=フォーク/チェンジアップ（遅い球）、下（-1）=速球、無入力=基準速。
 *
 * pitcherSpeed は投手の球速（SPD）0..1 で、基準速そのものを上下させる
 * （＝速球派の投手はどの段階でも速い）。既定の 0.5 は従来の定数と完全に一致する。
 *
 * **緩急の幅（基準速からの差）は投手によらず一定**。フォークの変化量Fをここに
 * 繋ぐ案は計測で否定した（上記 `SPD_SPAN` のコメント）。
 */
export function speedForPitchSelection(
  y: -1 | 0 | 1,
  pitcherSpeed: number = NEUTRAL_RATING,
): number {
  const neutral = neutralSpeedFor(pitcherSpeed);
  return y > 0 ? neutral - SPEED_SLOW_DELTA : y < 0 ? neutral + SPEED_FAST_DELTA : neutral;
}

/**
 * リリース時の飛行状態を作る。speed はワインドアップ中に事前選択された球速
 * （speedForPitchSelection）、initialVx は「投げる瞬間」の左右コース入力
 * （±COURSE_RELEASE_VX。説明書p19③）を渡す。
 */
export function createPitchFlight(
  releaseX: number,
  speed: number = SPEED_NEUTRAL,
  initialVx = 0,
): PitchFlight {
  return { x: releaseX, z: RELEASE_Z, vx: initialVx, vz: speed };
}

/**
 * 1フレーム分の飛行を進める（セミインプリシット・オイラー）。
 * steerX はリリース後の左右入力（カーブ/シュートの横加速。説明書p19④）。
 * 球速（vz）はリリース時に確定済みで飛行中は変わらない（原作準拠）。
 *
 * steerAccel は投手の変化量に応じた曲がりの強さ（steerAccelFor）。省略時は従来の一定値。
 */
export function stepPitchFlight(
  flight: PitchFlight,
  steerX: -1 | 0 | 1,
  dt: number,
  steerAccel: number = STEER_ACCEL,
): PitchFlight {
  const vx = flight.vx + steerX * steerAccel * dt;
  return {
    x: flight.x + vx * dt,
    z: flight.z + flight.vz * dt,
    vx,
    vz: flight.vz,
  };
}

/**
 * このステップで本塁（PLATE_Z）を通過したなら通過時のXを線形補間で返す。
 * 未通過なら null。
 */
export function plateCrossingX(prev: PitchFlight, next: PitchFlight): number | null {
  if (prev.z >= PLATE_Z || next.z < PLATE_Z) return null;
  const t = (PLATE_Z - prev.z) / (next.z - prev.z);
  return prev.x + (next.x - prev.x) * t;
}

/**
 * 本塁通過時の左右コースからストライク/ボール/死球を判定する。
 * ストライクゾーンは本塁基準なので打席の左右に関係なく同じで、**死球ゾーンだけが
 * 打者の立つ側へ移る**（side=-1 の右打者なら -X＝三塁側。フェーズB-9・BB-49）。
 *
 * stance（打席内の立ち位置。フェーズO-36）は**死球ゾーンを打者と一緒に動かす**：
 * プレートに寄れば当たりやすく、離れれば当たらない＝バットが外角へ届くようになる
 * リターンと、同じ操作の上に乗るリスク。既定 0＝打席中央＝従来と完全に同じ。
 */
export function judgePitch(
  xAtPlate: number,
  side: BatterSide = RIGHT_BATTER_SIDE,
  stance = 0,
): PitchCall {
  if (Math.abs(xAtPlate) <= STRIKE_ZONE_HALF_WIDTH) return 'strike';
  const local = batterFrameX(xAtPlate, side);
  const offset = clampStance(stance);
  if (local >= BATTER_ZONE_MIN_X + offset && local <= BATTER_ZONE_MAX_X + offset) {
    return 'hitByPitch';
  }
  return 'ball';
}
