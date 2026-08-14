/**
 * でっかいモードのCPU投球AI（純粋ロジックのみ、状態は持たない）。
 * 2P/CPU操作分離（セッション7）はちっちゃいモードの守備・走塁のみを対象としており、
 * でっかいモード（投球・打撃）はセッション9まで単一キーボードのホットシート専用だった
 * （PROGRESS.md「でっかいモードのCPU投球/打撃AI」参照）。本モジュールはその投球側を担う。
 *
 * 設計方針（他のCPU AI・判定ロジックと同じく乱数は一切使わない）：
 * - 狙うコースはカウントだけから決まる決定的な方針（chooseCpuPitchPlan）。
 *   2ストライク後は隅を突いて三振を狙い、3ボール後は四球回避でゾーン中央へ、
 *   それ以外はボール数の偶奇で内外角を交互に突く単純な周期パターンで、
 *   「同じコースの連投」を避ける（周期パターンは brawl.ts の固定タイムスクリプトと
 *   同じ「乱数なしで単調になりすぎない」ための手段）。
 * - **決め球（追い込んだ1球）の球速だけは投手の持ち味で決まる**（フェーズS-40。
 *   `cpuPitcherStyle`）。それまでは速球派も変化球派もまったく同じ配球をしていた
 *   ＝B-12が「CPUは球団の個性を活かさない」として記録した穴の、投球側の分。
 * - **狙いがゾーンの縁からどれだけ外れるかは制球で決まる**（フェーズT-41。
 *   `cpuControlSpray`。出どころは**ERA**＝D-18以来「判定に効かない唯一の項目」だった
 *   96人ぶんの数値）。S-40が「今回は意図的に触っていない」と残した最後の1つで、
 *   それまでは制球の良い投手も悪い投手も**まったく同じ隅を同じ精度で**突いていた。
 * - コース（左右）は**リリース位置を逆算して**決める（フェーズP-37。それ以前は
 *   「リリース位置＝狙うコース」で飛行中は一切ステアせず、CPUの球は必ず直線だった）。
 *   左右ステアを「デッドゾーン外で加速し続け、内に入ったら加速をやめる」だけの
 *   bang-bang方式で入れると、位置は制御できても速度（vx）を止める仕組みがなく、
 *   蓄積した横速度でデッドゾーンを通り過ぎて反対側で再度ステアが入る……という振動が
 *   起きて、際どいコース狙いが簡単に死球ゾーンへ暴走しうる（詳細は cpuPitcher.test.ts の
 *   コメント）。**P-37はフィードバック制御そのものを使わずに埋めた**：飛行時間は
 *   リリース時に確定している（球速は飛行中に変わらない＝原作準拠）ので、
 *   「この変化量でこれだけ曲げるなら、どこから投げれば狙ったコースへ届くか」を
 *   `planCpuPitchShape` が先に解いてしまう（開ループ）。振動しようがなく、
 *   本塁通過位置は従来どおり狙いどおりのまま、球だけが曲がる。
 * - 球速はリリース時に確定する（releaseSpeedForPlan）。原作準拠改修（説明書p19②の
 *   事前選択方式）で人間側の緩急が「ワインドアップ中の上下入力→リリース時確定」に
 *   なったのに合わせ、かつて存在した飛行中の球速フィードバック制御
 *   （stepCpuPitchSteer）は撤去した（飛行中に球速が変わらない物理になったため
 *   フィードバック自体が不要になり、CPUはより単純になった）。
 */
import type { Bases, Count } from './rules';
import {
  type PitchProfile,
  BATTER_STANCE_RANGE,
  BATTER_ZONE_MIN_X,
  NEUTRAL_PITCH_PROFILE,
  NEUTRAL_RATING,
  PLATE_Z,
  RELEASE_Z,
  STRIKE_ZONE_HALF_WIDTH,
  clampReleaseX,
  speedForPitchSelection,
  steerAccelForSelection,
} from './pitch';

export type CpuSpeedMode = 'fast' | 'neutral' | 'slow';

export interface CpuPitchPlan {
  /** 本塁通過時に狙うワールドX（コース）。シーン層がリリース位置に直接反映する */
  targetX: number;
  speed: CpuSpeedMode;
}

/**
 * 方針の球速モード → 人間の上下入力（説明書p19②）と同じ表現。
 * CPUと人間で球速の決め方を1本の関数（speedForPitchSelection）に寄せることで、
 * 投手の能力値（SPD）が攻守どちらの経路でも同じように効く。
 */
const SPEED_SELECTION: Record<CpuSpeedMode, -1 | 0 | 1> = {
  fast: -1,
  neutral: 0,
  slow: 1,
};

/** 隅を突くときの、ストライクゾーン境界からの上乗せ（ぎりぎり際どいコース） */
const CORNER_MARGIN = 0.05;
/** 通常時に狙う内外角の寄せ幅（ゾーン半幅に対する割合） */
const NORMAL_CORNER_RATIO = 0.55;

// ---- 制球（フェーズT-41。S-40が「意図的に触っていない」と残した最後の1つ） ----
//
// S-40 で**何を投げるか**には持ち味が乗ったが、**どこへ投げるか**は全投手が同じだった
// （`chooseCpuPitchPlan` はカウントだけを見る）＝制球の良い投手も悪い投手もまったく同じ
// 隅を、まったく同じ精度で突いていた。出どころは **ERA**（`roster.ts` の `pitcherControl`。
// D-18以来「判定に効かない唯一の項目」だった96人ぶんの数値）で、**新しい能力値は増えていない**。
//
// ## 効き方は「狙いが外へ膨らむ」1つだけ（ユーザー判断）
//
// ズレの仕組み（狙いは同じで、そこから外れる）は持たない。**狙う位置そのものを動かす**ので
// 開ループのまま＝P-37 が「振動しようがない」ために捨てたフィードバック制御に戻らない。
// 膨らむのは**ゾーンの縁からの距離**で、そこから2つの振る舞いが**新しい規則を1つも
// 足さずに**同時に出てくる：
//
// - **荒れた投手はボールが先行する**（隅を狙うほど外れる）。
// - **3ボールになると既存の規則（`balls>=3`→ど真ん中）で置きにくる**＝待った側への報酬。
//   ここには膨らみを掛けない＝**置きにいく球は誰が投げても真ん中**。
//
// ## なぜ「縁の内側」まで許すのか（制球の良い投手の値打ち）
//
// T-41 の前は決め球が必ず `HALF + 0.05` ＝**見逃せば必ずボール**だったので、
// 見逃し続ける打者は6球で必ず四球になっていた（PROGRESS.mdに既知の挙動として記録がある）。
// 制球1.0の投手が**縁の内側**（`CPU_CONTROL_EDGE`）を突けるようにすると、そこが
// **見逃したら三振**に変わる＝「際どいところへ投げ切れること」がそのまま値打ちになる。
//
// ## 曲線（`CPU_CONTROL_CURVE`）が決めているもの
//
// 膨らみは制球のズレの**3乗**で効く。線形にしなかったのは `npm run balance:control` の
// 3段目が決めた＝**荒れを「例外」にとどめたまま、死球ゾーンには届かせる**という
// 両立が要るから。緩い曲線では誰も届かず（ユーザー判断が死文になる）、急な曲線では
// 狙いが上限に張り付いて**荒れた投手どうしの差がそこで消える**。
// **中央値の投手が従来ちょうど**なのは曲線とは無関係で、下の式から自動で決まる。

/**
 * 制球1.0の投手が狙う、ストライクゾーンの**内側**の余裕（負のマージン）。
 * ちょうど縁（margin=0）にしないのは、飛行の丸め誤差でストライク/ボールが
 * 裏返るのを避けるため（P-37が「隅を突く球がゾーンの内外を行き来する」ことを
 * 嫌ってフレーム途中の力積まで合わせたのと同じ理由）。
 */
export const CPU_CONTROL_EDGE = -0.02;

/**
 * 膨らみの効き方（制球のズレの何乗か）。**`npm run balance:control` の3段目が決めた**
 * （CLAUDE.md「バランス調整の方針」）。見たのはP-37・S-40と同じ「名鑑96人でどう分かれるか」：
 *
 * - **2乗以下**では、いちばん荒れた投手でも狙いが `0.71` までしか出ず、**死球ゾーン（0.9）に
 *   誰一人届かない**＝ユーザー判断（荒れた投手はぶつけうる）が死文になる。
 * - **3.5乗以上**では狙いが `CPU_CONTROL_MAX_TARGET` に**張り付く**＝そこから先は
 *   どれだけ制球が悪くても同じ球になり、**荒れた投手どうしの差が消える**
 *   （P-37 が `CPU_BREAK_STEER_SEC` を「名鑑96人が誰も頭打ちにならない最大値」で
 *   決めたのとまったく同じ基準）。
 * - **3乗**は狙い `0.990` で上限に触れない**最大の曲線**で、なおかつ死球ゾーンへ届くのは
 *   いちばん荒れた3人（アイアンズの ERA4.10/4.20/4.30）だけ＝荒れが「例外」に収まる。
 */
export const CPU_CONTROL_CURVE = 3;

/**
 * どんなに荒れても狙いがここを越えない上限（ワールドX の絶対値）。
 * **`BATTER_ZONE_MIN_X`（死球ゾーンの手前の縁）＋ 立ち位置の可動幅の半分**からの導出で、
 * これが T-41 の不変条件を作る（`tests/control.test.ts` が固定）：
 *
 * - **打席から離れて立てば（O-36）どんな荒れ球でも必ず避けられる**（死球ゾーンが遠のく）。
 * - **打席の中央では当たる**／**プレートに寄れば当たりやすい**
 *   ＝O-36 の立ち位置の選択に「荒れた投手への構え方」という重みが増える。
 *
 * 打者側に避ける手が実在することが、回避手段の無い死球を理不尽にしない条件
 * （桜井ノウハウ「人に反応できない動作をするとすっごい理不尽感がある」＝F-26-2で
 * 銃に1.5秒の予兆を置き、F-26-4でドロップキックに警告距離を置いたのと同じ扱い）。
 */
export const CPU_CONTROL_MAX_TARGET = BATTER_ZONE_MIN_X + BATTER_STANCE_RANGE / 2;

/**
 * 狙いが外へ膨らむ幅（決定的・乱数不使用）。**基準は「名鑑の中央値の投手」**で、
 * そこからの差だけを持つ：
 *
 * - 制球 0.5（名鑑の中央値＝ERA3.10）→ **0＝T-41の前と1mmも変わらない**
 *   （B-8以来の「基準値0.5＝従来の定数」。決め球も通常の球も従来ちょうど）
 * - 制球 1.0 → 負（縁の**内側**へ入る＝決め球が**見逃せばストライク**になる）
 * - 制球 0.0 → 正（大きく外れる。幅は上の2つと曲線から**導出**するので定数を持たない）
 *
 * 幅そのものを定数として持たないのが要点で、`CPU_CONTROL_EDGE`（良い側の到達点）と
 * `CORNER_MARGIN`（従来の値）を動かせば悪い側も一緒に動く
 * （`pitcherRole` を STM から、`cpuPitcherStyle` を SPD/F から導くのと同じ整理）。
 */
export function cpuControlSpray(
  control: number = NEUTRAL_RATING,
  curve: number = CPU_CONTROL_CURVE,
): number {
  const miss = Math.max(0, Math.min(1, 1 - control)) / (1 - NEUTRAL_RATING);
  return (CORNER_MARGIN - CPU_CONTROL_EDGE) * (miss ** curve - 1);
}

// ---- 投手の持ち味（フェーズS-40。B-12が「CPUは球団の個性を活かさない」と記録した穴） ----
//
// R-39 で盗塁に走力が効くようになったが、**配球には投手の持ち味が1つも乗っていなかった**
// ＝`chooseCpuPitchPlan` はカウントだけを見るので、**速球派も変化球派もまったく同じ配球**を
// していた（P-37で曲がりの「大きさ」には差が付いたが、「何を投げるか」は同じだった）。
//
// ## なぜ「打たれにくい球」を選ばせないのか
//
// `npm run balance:identity` の1段目が測ったとおり、**当てられたときの費用だけを見ると
// 遅い球がどの投手にとっても一番安い**（SPD0.5で 安打率 速球40.6% / 基準24.5% / フォーク9.7%）。
// 費用で選ばせると**全投手がフォークしか投げなくなり、このセッションの目的そのものが
// 失われる**（持ち味が消えて一様になる）。
//
// 費用の裏には値打ちがあり、そちらは投手ごとに違う（同2段目）：
// - **速球の値打ち＝打者に与える時間の短さ**（SPD1.0の速球は飛行 0.367秒／SPD0.3は 0.445秒）
// - **フォークの値打ち＝曲がり**（F1.0のフォークは 0.99m／F0.3のフォークは 0.43m）
//
// どちらが自分の武器かは **SPD と F のどちらが高いか**で決まる。だから持ち味はここから導く
// （B-11が先発型/リリーフ型をSTMから導出したのと同じ＝別フィールドを持たない）。

export type CpuPitcherStyle = 'power' | 'breaking' | 'balanced';

/**
 * 持ち味が付く SPD と F の差。**`npm run balance:identity` の3・3b段目が決めた**
 * （CLAUDE.md「バランス調整の方針」）。見たのはP-37・R-39と同じ「名鑑で規則が死なないか」：
 *
 * - 0.05 では**バランス型が6人/96人**しか残らない（第3の型が実質存在しない）。
 * - 0.30 では**16球団中7球団の先発型4人が全員同じ型**になり、持ち味を入れた意味が薄れる。
 * - **0.15** は 速球派43 / 技巧派16 / バランス37 と3つの型がどれも生きていて、
 *   R-39のローテーションで人間が順に浴びる**先発型4人に3つの型がそろう球団が 7/16 と最大**
 *   （4人とも同じ型になるのは 1/16 だけ）＝**試合ごとに相手の顔が変わる**。
 */
export const CPU_PITCHER_STYLE_GAP = 0.15;

/**
 * その投手の持ち味（決定的・乱数不使用）。**別フィールドを持たず能力値から導出する**ので、
 * 名鑑の数値を触れば持ち味も一緒に動く（`pitcherRole` がSTMから型を導くのと同じ整理）。
 *
 * 疲労を織り込んだ profile を渡せば**疲れた投手は持ち味も痩せる**（B-11で変化量が
 * 下限まで落ちるので、技巧派は追い込んでもフォークで仕留められなくなる）。
 */
export function cpuPitcherStyle(profile: PitchProfile = NEUTRAL_PITCH_PROFILE): CpuPitcherStyle {
  const gap = profile.speed - profile.fork;
  if (gap >= CPU_PITCHER_STYLE_GAP) return 'power';
  if (-gap >= CPU_PITCHER_STYLE_GAP) return 'breaking';
  return 'balanced';
}

/**
 * 追い込んだ1球（決め球）の球速。**持ち味が効くのはここだけ**で、初球と
 * ストライク先行後は従来のまま＝**どの型にも緩急が残る**（速球派でも1ストライク後は
 * フォークを投げるので、速い球しか来ない投手にはならない）。
 *
 * 動かす区分を1つに絞ったのは打たれ方の分布を壊さないため（同3c段目）：
 * SPD1.0の投手で 安打率 33.9%→37.3%・HR率 17.8%→22.7% と、**速球派の決め球は
 * 当てられれば飛ぶ**。その費用と釣り合う値打ち（打者に与える時間の短さ）は
 * **当てさせない力なので当たった打球の分母では測れない**＝リスクとリターンが
 * 同じ1球の上に乗っている（桜井ノウハウ「リスクとリターンはかなり近いところに
 * 適切な大きさに配置」）。
 */
const PUTAWAY_SPEED: Record<CpuPitcherStyle, CpuSpeedMode> = {
  power: 'fast',
  breaking: 'slow',
  // 従来と同じ＝持ち味を持ち込む前の配球がそのまま残る（B-8の基準線と同じ整理）
  balanced: 'neutral',
};

/**
 * カウントに応じた投球方針を決める（決定的、乱数不使用）。
 * - 2ストライク以降：三振を狙って隅（ストライクゾーンぎりぎり外側の際どいコース）を突き、
 *   **その投手の決め球**（`PUTAWAY_SPEED`）で仕留める（フェーズS-40）。
 * - 3ボール以降：四球回避を優先し、ゾーン中央の安全なコースへ投げる。
 * - それ以外：ボール数の偶奇で内外角を交互に突き、初球寄りは速球、
 *   ストライク先行後は緩急を混ぜる。
 *
 * **狙うコースの骨格（隅か、真ん中か）は持ち味もカウントの規則も変えていない**＝
 * I-29で測った打たれ方も、P-37の逆算（狙いへ寸分違わず届く）もそのまま。
 * 持ち味（S-40）が変えるのは「何を投げるか」、制球（T-41）が変えるのは
 * 「狙いがゾーンの縁からどれだけ外れるか」だけ。
 *
 * **制球（T-41）の効き方は3つの区分で違う**（どれも新しい規則ではなく、既存の3分岐に
 * 膨らみを掛けるかどうかだけ）：
 *
 * - **決め球（2ストライク以降）**＝符号つき。制球が良ければ**縁の内側**（見逃せば三振）、
 *   悪ければ**大きく外れる**（見逃せば四球へ近づく）。ここが制球のいちばんの値打ち。
 * - **通常の球**＝外へ膨らむぶんだけ（`Math.max(0, spray)`）。もともとゾーンの内側を
 *   狙っているので、**制球が良くてもこれ以上内へは寄せない**（甘くなるだけだから）
 *   ＝中央値以上の投手の通常の球は T-41 の前と完全に同じ。
 * - **3ボール以降（置きにいく球）**＝膨らませない。**誰が投げても真ん中**＝
 *   荒れた投手を見極めて待った側への報酬（リスクとリターンが同じカウントの上に乗る）。
 *
 * style / control を渡さない呼び出しは `balanced` + 基準値＝**T-41の前と完全に同じ方針**
 * を返す（B-8以来の「基準値0.5＝従来の定数」）。
 */
export function chooseCpuPitchPlan(
  count: Count,
  style: CpuPitcherStyle = 'balanced',
  control: number = NEUTRAL_RATING,
): CpuPitchPlan {
  const cornerSign: 1 | -1 = count.balls % 2 === 0 ? 1 : -1;
  const spray = cpuControlSpray(control);
  const aim = (base: number): number =>
    cornerSign * Math.min(base, CPU_CONTROL_MAX_TARGET);

  if (count.strikes >= 2) {
    return {
      targetX: aim(STRIKE_ZONE_HALF_WIDTH + CORNER_MARGIN + spray),
      speed: PUTAWAY_SPEED[style],
    };
  }
  if (count.balls >= 3) {
    return { targetX: 0, speed: 'neutral' };
  }
  const speed: CpuSpeedMode = count.strikes === 0 ? 'fast' : 'slow';
  return {
    targetX: aim(STRIKE_ZONE_HALF_WIDTH * NORMAL_CORNER_RATIO + Math.max(0, spray)),
    speed,
  };
}

/**
 * 方針の球速モード→リリース時に確定する実球速（原作準拠：飛行中は変わらない）。
 * pitcherSpeed は投手の球速（SPD）0..1（既定は基準値＝従来と同じ球速）。
 *
 * フォークの変化量（F）はここには効かない（フェーズO-35で計測により球速から外した）。
 * CPU投手はそもそも左右ステアを行わないので、**R/L と同じく F も CPU の球には効かない**。
 */
export function releaseSpeedForPlan(
  plan: CpuPitchPlan,
  pitcherSpeed: number = NEUTRAL_RATING,
): number {
  return speedForPitchSelection(SPEED_SELECTION[plan.speed], pitcherSpeed);
}

// ---- 変化球（フェーズP-37。説明書p19④「投げてから+を右か左でカーブ/シュート」） ----
//
// ここまでCPUの球は必ず直線で、**R/L も（O-35で繋いだ）F も CPU の球には一切効かなかった**
// ＝96人ぶんの変化量が、人間が投手側に回ったときしか生きていなかった（CLAUDE.md ⑧の
// 「CPUも対等」に残っていた最後の構造的な穴）。
//
// ## 逆算：フィードバック制御を使わずに曲げる
//
// この投球は**リリース時に球速が確定し、飛行中は変わらない**（説明書p19②準拠）ので、
// 本塁までの飛行時間 T は投げる前から分かっている。横の運動も、加速度 a を ts 秒だけ
// 与えるだけの単純な等加速度＋等速なので、**総横移動 Δ が閉じた式で書ける**：
//
//     Δ = a · ts · (T − ts/2)          （0 ≤ ts ≤ T）
//
// したがって「狙うコース targetX から Δ だけ戻したところ」から投げれば、**曲げたうえで
// 狙いどおりのコースへ届く**。制御ループが無いので振動しようがなく、
// **本塁通過位置は逆算する前とまったく同じ**＝I-29で測った打たれ方の分布は動かない
// （変わるのは「打者から見て、その球がどこへ来るか読めるか」だけ）。
//
// ## 曲げる向きは「狙うコースの側」（ユーザー判断）
//
// 反対側から入ってきて隅へ沈む＝実際の変化球の見え方。**ど真ん中狙い（3ボール後の
// 四球回避）は曲げない**ので、追い込まれたCPUは素直な球を投げる＝カウントを作ることに
// 意味が出る。曲げる向きが決まると使う変化量も決まる（左へ＝L／右へ＝R／
// 遅い球＝F。人間の投球と同じ `steerAccelForSelection` を通す）。
//
// ## 曲げられる幅の上限はプレートの広さ（`RUBBER_HALF_RANGE`）
//
// リリース位置はプレートの上にしか置けないので、**大きく曲げる投手ほど端から投げ始め、
// それでも足りなければ曲がりのほうが削られる**（`clampRubberX` の結果から実際の Δ を
// 取り直し、ts を解き直す）。削られても狙いどおりのコースへ届くことは変わらない。
// 「投手の立ち位置が狙いと違う」ことがそのまま打者への手がかりになる
// （意思決定材料は隠さない＝O-36で立ち位置にヒントを置かなかったのと同じ扱い）。

/**
 * CPUが十字キーを倒し続ける長さ（秒）＝**人間の「短く1回倒す」に相当する入力**。
 * 曲がり幅そのものではなくここを固定するのが要点で、同じ入力でも
 * **変化量が大きい投手ほど・遅い球ほど大きく動く**（`fork.ts` の計測どおり
 * 横移動は飛行時間の2乗で効く）＝能力値の差がそのまま球の差になる。
 *
 * 値は `npm run balance:cpubreak` の1〜3段目で決めた（CLAUDE.md「バランス調整の方針」）。
 * **決め手は「名鑑96人のうち何人がプレートの幅で頭打ちになるか」**：0.10秒では34人、
 * 0.08秒では8人が上限に張り付き、**Fの高い投手ほど差が消える**（このセッションの目的
 * そのものが失われる）。**0.06秒なら頭打ち0人**で、96人全員の変化量が球の差になる。
 * これより短くすると曲がりがゾーン半幅にも届かず、入れた意味が無くなる。
 */
export const CPU_BREAK_STEER_SEC = 0.06;

/**
 * CPUの1球の「形」。リリース前に一度だけ解き、その球の間ずっと使う
 * （＝飛行中に判断し直さない＝制御ループを持たない）。
 */
export interface CpuPitchShape {
  /**
   * ボールが出るX（＝腕の先。シーン層が `createPitchFlight` に渡す）。
   * **プレート上に立てる範囲を腕のぶんずらした窓**へ収めてある（フェーズCC-50）。
   */
  releaseX: number;
  /**
   * プレート上の立ち位置（＝投手の体。シーン層が投手をここへ置く。フェーズCC-50）。
   * `releaseX` から腕のぶんを引いただけの導出で、**CC-50の前は両者が同じ値だった**。
   */
  plateX: number;
  /** 曲げる向き（0＝曲げない＝従来と同じ直線の球） */
  steerX: -1 | 0 | 1;
  /** リリースから何秒間 倒し続けるか */
  steerSec: number;
  /** 横方向加速度 m/s^2（人間が同じ球を曲げるときとまったく同じ値） */
  steerAccel: number;
  /** リリース球速 m/s（飛行中は変わらない） */
  speed: number;
  /** リリース→本塁の飛行時間 秒（逆算に使った値） */
  flightSec: number;
  /** 実際に曲がる横移動 m（＝ |releaseX − targetX|。プレートの幅で削られた後の値） */
  breakWidth: number;
}

/** Δ = a·ts·(T − ts/2) を ts について解く（0 ≤ ts ≤ T の側の根） */
function steerSecForBreak(breakWidth: number, accel: number, flightSec: number): number {
  if (breakWidth <= 0 || accel <= 0) return 0;
  const disc = flightSec * flightSec - (2 * breakWidth) / accel;
  // 判別式が負＝この飛行時間では曲げ切れない（呼び出し側で上限を掛けているので通常起きない）
  if (disc <= 0) return flightSec;
  return flightSec - Math.sqrt(disc);
}

/**
 * 投球方針（`chooseCpuPitchPlan`）＋投手の能力値 → その球の形（決定的・乱数不使用）。
 *
 * profile は**疲労を織り込んだ後の値**（main.ts の `currentPitchProfile`）を渡す＝
 * 疲れたCPU投手は球速も曲がりも落ちる（B-11の「変化量は下限まで落ちる」がそのまま効く）。
 * 省略時は基準値の投手＝**曲がり幅も既定になるだけで、狙うコースは何も変わらない**。
 */
export function planCpuPitchShape(
  plan: CpuPitchPlan,
  profile: PitchProfile = NEUTRAL_PITCH_PROFILE,
  steerSec: number = CPU_BREAK_STEER_SEC,
  releaseOffset = 0,
): CpuPitchShape {
  const speed = releaseSpeedForPlan(plan, profile.speed);
  const flightSec = (PLATE_Z - RELEASE_Z) / speed;
  const steerX: -1 | 0 | 1 = plan.targetX > 0 ? 1 : plan.targetX < 0 ? -1 : 0;
  const shape = (releaseX: number, rest: Omit<CpuPitchShape, 'releaseX' | 'plateX'>): CpuPitchShape => ({
    releaseX,
    // 体はリリース位置から腕のぶん戻したところ（フェーズCC-50。省略時は従来どおり同じ値）
    plateX: releaseX - releaseOffset,
    ...rest,
  });
  if (steerX === 0) {
    // ど真ん中狙い＝曲げない（従来と完全に同じ直線の球）
    return shape(clampReleaseX(plan.targetX, releaseOffset), {
      steerX: 0,
      steerSec: 0,
      steerAccel: 0,
      speed,
      flightSec,
      breakWidth: 0,
    });
  }
  const breakAmount = steerX < 0 ? profile.breakLeft : profile.breakRight;
  const steerAccel = steerAccelForSelection(SPEED_SELECTION[plan.speed], breakAmount, profile.fork);
  const held = Math.max(0, Math.min(steerSec, flightSec));
  // この投手がこの入力で自然に曲げられる幅
  const wanted = steerAccel * held * (flightSec - held / 2);
  // そこから逆算したリリース位置。プレートからはみ出すぶんは曲がりのほうが削られる
  // （窓は腕のぶんずれる＝**腕の側の隅へは楽に曲げられ、逆側は削られやすい**。CC-50）
  const releaseX = clampReleaseX(plan.targetX - steerX * wanted, releaseOffset);
  const breakWidth = Math.abs(plan.targetX - releaseX);
  return shape(releaseX, {
    steerX,
    steerSec: steerSecForBreak(breakWidth, steerAccel, flightSec),
    steerAccel,
    speed,
    flightSec,
    breakWidth,
  });
}

/**
 * このフレームで与える横加速度（シーン層が `stepPitchFlight` にそのまま渡す）。
 *
 * **倒し終わる瞬間がフレームの途中に来ても、与える力積（a·ts）は変わらない**：
 * 区間 [sinceRelease, sinceRelease+dt] のうち倒している時間の割合だけ加速度を弱める。
 * ここを「フレーム単位で倒す/倒さない」に丸めると、フレームレート次第で曲がり幅が
 * 最大1フレームぶんずれ、**逆算した狙いから外れる**（60fpsで最大10cm＝隅を突く球が
 * ゾーンの内外を行き来してしまう）。
 */
export function cpuSteerAccelAt(shape: CpuPitchShape, sinceRelease: number, dt: number): number {
  if (shape.steerX === 0 || dt <= 0) return 0;
  const from = Math.max(sinceRelease, 0);
  const to = Math.min(sinceRelease + dt, shape.steerSec);
  if (to <= from) return 0;
  return shape.steerAccel * ((to - from) / dt);
}

/**
 * CPU投手がけん制モード（説明書p24）へ入るかの判断（決定的・乱数不使用）。
 *
 * 条件は3つ：**走者がいる**／**1打席につき1回まで**（usedThisPlateAppearance）／
 * **その走者が実際に塁を離れている**（leads。フェーズJJ-57）。
 *
 * 3つ目が要るのは II-56 の帰結：**人間の走者は方向キーを押している間しかリードしない**
 * ので、押していない走者に対してけん制モードへ入っても**投げる候補が永久に生まれない**
 * ＝画面がちっちゃいモードへ切り替わって数秒止まるだけになる（テストプレイの
 * 「盗塁しかけようとしていないのにけん制されてうっとうしい」）。**塁を離れていない
 * 走者は刺しようがない**のだから、投手が見に行く理由もない、という素直な形。
 *
 * **リードは盗塁を仕掛けた後にだけ持ち越される**（`finalLeads`）ので、実際にはこれが
 * 「**走ろうとした走者だけがけん制される**」という規則になる＝ユーザーの言葉どおり
 * 「盗塁しかけようとしていないなら、けん制されない」。CPUの走者（人間が守備側）は
 * 従来どおり自分でリードを広げるので、この関数はそちらには呼ばれない（投げるのは人間）。
 *
 * 走者を実際に刺せるかどうかはリードの深さ次第で、その判断はけん制モードに入ってから
 * chooseCpuPickoffThrow（core/fielding.ts）が行う。ここは「にらみ合いに持ち込むか」だけを決める。
 */
export function shouldCpuPickoff(
  bases: Bases,
  usedThisPlateAppearance: boolean,
  leads: Partial<Record<'first' | 'second' | 'third', number>> = {},
): boolean {
  if (usedThisPlateAppearance) return false;
  return (['first', 'second', 'third'] as const).some(
    (base) => bases[base] && (leads[base] ?? 0) > 0,
  );
}

// ---- 自動継投（フェーズJ-30。B-11で保留していた「CPUは疲れても交代しない」） ----

/**
 * CPUが継投を考え始める残りスタミナ。**人間側で「球威が落ちる」境目にした値
 * （`roster.ts` の `STAMINA_FRESH_THRESHOLD`）と同じ 0.5**。
 *
 * 同じ値を使うのが要点：HUDのゲージが半分を割って `キュウイ ダウン` が出る瞬間が、
 * 人間にとっての「継投を考える合図」（B-11）であり、**CPUもまったく同じ合図で動く**
 * ＝規則が読める。数字を別に持つと「CPUだけ違う基準で代える」ことになり、
 * 桜井ノウハウの言う「コンピューターが良い目を出すとイカサマしてると思われがち」に落ちる。
 *
 * `roster.ts` から import せず同じ値を書いているのは、`cpuPitcher.ts` を
 * ルール（`rules`/`pitch`）だけに依存する軽い層のまま保つため。**ずれたらテストが落ちる**
 * （`tests/cpuPitcher.test.ts` が両者の一致を固定する）。
 */
export const CPU_RELIEF_REMAINING_THRESHOLD = 0.5;

/**
 * 「代えるか続投か」を比べるときに、控えに求める**質の上乗せ**（フェーズZ-47）。
 *
 * **0＝良いほうを出すだけ**（新しい自由変数を持ち込まない。W-44が
 * `FATIGUE_CONTROL_LOSS` を `FATIGUE_SPEED_DROP` に揃えたのと同じ考え方）。
 * `npm run balance:relief` の4段目が「上げるほどCPUが代えてこなくなり、J-30の自動継投
 * そのものが死ぬ」ことを示したので、**上乗せは置かない**のが正しいと決まった。
 *
 * 上げ下げしたくなったらここ1か所で済む（値を上げると「格上の控えがいても続投する」側へ、
 * 負にすると「同格でも代える」側へ寄る）。
 */
export const CPU_RELIEF_QUALITY_MARGIN = 0;

/** いまマウンドにいる投手の状態（`chooseCpuRelief` が「続投したときの姿」として読む） */
export interface CpuReliefIncumbent {
  /** 残りスタミナ 0..1（`remainingStaminaOf`） */
  remaining: number;
  /**
   * **疲労を織り込んだいまの質**（`roster.ts` の `pitcherQualityOf`。フェーズZ-47）。
   * 疲れるほど下がるので、投げ続けるほど控えに追い抜かれる。
   */
  quality: number;
}

/** 継投の候補（ブルペン1人ぶん）。`index` は `roster.bullpen` の添字をそのまま渡す */
export interface CpuReliefCandidate extends CpuReliefIncumbent {
  index: number;
  /** リリーフ型か（`pitcherRole(stamina) === 'reliever'`） */
  reliever: boolean;
}

/**
 * CPU投手の自動継投（決定的・乱数不使用。ユーザー判断：J-30＝**球威が落ちたらリリーフ型へ**／
 * Z-47＝**疲労込みの能力比較**）。
 *
 * B-11では「CPUの采配はスコープ外」として入れなかったが、そのぶん**試合後半はCPU投手の
 * 球威が落ちたまま戻らず、人間が攻撃側のときだけ一方的に有利**という非対称が残っていた。
 * 規則は4つだけで、打順表・投手カードのERA・スタミナゲージから次に誰が出てくるかまで読める：
 *
 * 1. **いまの投手の球威が落ちていなければ代えない**（残量がしきい値以上）。
 * 2. **候補は「まだ球威が落ちていない投手」だけ**＝疲れた投手に代えても意味が無い。
 *    1人もいなければ交代しない（ブルペンが尽きた／全員疲れているなら続投する）。
 * 3. その中から**リリーフ型を優先**（原作p8「リリーフ型はスタミナが少なく先発向きでない」＝
 *    抑えは終盤に出すもの）。同型なら**残量が多い順**、それも同じなら**並び順の先**
 *    （`cpuChooseSkill` の「同率なら並び順の先」と同じ畳み方＝順序が一意に決まる）。
 * 4. **その一番手と、いまの投手の「疲労込みの質」を比べ、格下なら出さない**（Z-47）。
 *
 * ## なぜ4つ目が要るのか（W-44が残した部分）
 *
 * 1〜3だけだと**残量が 0.5 を切った打席の切れ目で必ず代わる**＝疲労が0を超えた瞬間に
 * マウンドから消えるので、**CPU投手が疲れたまま投げる場面が原理的に存在しない**
 * （`npm run balance:relief` の1段目：16球団の最大疲労は平均 0.091）。B-11の球速・
 * 変化量・球威と W-44 の制球は、CPU側では一度も画面に出ていなかった。しかも質を見ない
 * ので、**疲れたエースを格下のリリーフへ差し出す交代**が実際に起きていた。
 *
 * 4つ目を足すと、同じ「ゲージが半分を割る」合図のまま**判断の中身が「代える」から
 * 「代えるか続投か」に変わる**：
 *
 * - **ブルペンが薄い球団はエースが疲れたまま投げ続ける**（＝打ち崩す値打ちが生まれる）。
 * - **投手層の厚い球団はさっさと代える**（＝B-12の球団の個性が継投にも出る）。
 * - 質は投げるほど落ちるので、**続投もいつかは必ず終わる**（永久に粘らない）。
 *
 * 質の物差しは `roster.ts` の `pitcherQuality`（疲労を織り込んだ球速＋変化量＋制球）。
 * **`cpuPitcher.ts` は数値を受け取るだけ**で名鑑もロスターも知らない＝この層を
 * ルール（`rules`/`pitch`）だけに依存する軽いままに保つ（`remaining`・`reliever` を
 * 呼び出し側で解決して渡しているのと同じ形）。
 *
 * 呼び出し側は**打席の切れ目でだけ**呼ぶこと（投球中に代わると、投げている最中に
 * 投手がすり替わる）。`announceStaminaDrop` と同じ場所＝E-23の「間」に重なるので、
 * 打者側は「相手が代わった」ことを落ち着いて読める。
 */
export function chooseCpuRelief(
  current: CpuReliefIncumbent,
  bullpen: readonly CpuReliefCandidate[],
  threshold: number = CPU_RELIEF_REMAINING_THRESHOLD,
  margin: number = CPU_RELIEF_QUALITY_MARGIN,
): number | null {
  if (current.remaining >= threshold) return null;
  const fresh = bullpen.filter((c) => c.remaining >= threshold);
  if (fresh.length === 0) return null;
  let best = fresh[0];
  for (const c of fresh.slice(1)) {
    if (c.reliever !== best.reliever) {
      if (c.reliever) best = c;
      continue;
    }
    if (c.remaining > best.remaining) best = c;
  }
  // 4つ目（Z-47）：**選び方は変えず、出すかどうかだけを質で決める**。ここで null を
  // 返すと続投＝次の打席の切れ目にまた比べられ、そのときは疲労が進んだぶん質が落ちている。
  return best.quality >= current.quality + margin ? best.index : null;
}

// ---- 銃（フェーズF-26-2。CLAUDE.md ③＋⑧） ----

/**
 * CPUが銃を構える打者の長打力（HR）のしきい値。名鑑（`teams.ts`）の打線128人のうち
 * 上から約2割（およそ各球団の4番・5番）がここを超える＝**「相手の主砲」が来たときだけ**
 * 構える。走力型の球団（ウィンズ等）を選ぶと撃たれないのは意図どおりで、
 * 「そういう規則だから読めたはず」が成立する（下の決定性の理由）。
 */
export const CPU_GUN_POWER_THRESHOLD = 0.7;

/**
 * CPU投手が銃を撃つかの判断（決定的・乱数不使用。ユーザー判断：**強打者を敬遠する場面**）。
 *
 * 銃の命中は死球＝打者は一塁へ歩く（CLAUDE.md ③）ので、撃つことは実質**敬遠**にあたる。
 * だから規則も敬遠の定石そのものにした：**一塁が空いていて、長打力が上位の打者**のとき。
 * 一塁が埋まっていれば撃たない（走者を増やすだけで、満塁なら押し出しになる）。
 *
 * 桜井ノウハウ照合（CLAUDE.md ⑧）：「**コンピューターが良い目を出すとイカサマしてると
 * 思われがち**」。乱数で撃たれると「CPUだけ運がいい」になるが、この規則なら
 * **打順表と塁の状態を見れば撃たれる打席が事前に分かる**（＝主砲の前の打者を歩かせない、
 * 走者を一塁に置く、といった対処が成立する）。撃たれる側にとっては損ばかりでもない：
 * 出塁したうえで、乱闘を仕掛けて相手投手を退場させにいく分岐が残っている。
 *
 * 1打席1回に絞るのは `shouldCpuPickoff` と同じ理由（毎球構えられると試合が進まない）。
 * ammo は投手個人の残弾（`gunRemainingOf`）で、0なら構えない＝
 * **`ジュウ` を引いていないCPUはこの経路に一度も入らない**。
 */
export function shouldCpuShoot(opts: {
  ammo: number;
  bases: Bases;
  batterPower: number;
  usedThisPlateAppearance: boolean;
}): boolean {
  if (opts.usedThisPlateAppearance) return false;
  if (opts.ammo <= 0) return false;
  if (opts.bases.first) return false;
  return opts.batterPower >= CPU_GUN_POWER_THRESHOLD;
}

// ---- 敬遠（フェーズQ-38。実際の野球の申告敬遠） ----
//
// F-26-2で銃を「実質敬遠」として入れたときから、**人間の投手側には歩かせる手そのものが
// 無かった**（D-19が「敬遠を入れるかは要判断」と書き残していた穴）。Q-38で人間側に
// 采配メニューの `ケイエン` が入ったので、⑧の「CPUも対等」に合わせてCPUにも持たせる。
//
// **銃を持っているCPUは先に撃つ**（呼び出し側の順序。main.ts）。撃てば死球＝一塁を
// 与えるところは同じだが、**乱闘に持ち込まれる余地を残す**ぶん銃のほうが荒っぽい手で、
// 敬遠は誰にでもある基本の手。こうしておくと `ジュウ` を引いた試合の見せ場が消えない。

/**
 * CPUが敬遠を考え始める打者の長打力（HR）。`npm run balance:walk` の5段目
 * （得点圏に走者がいる場面で「勝負より敬遠のほうが失点期待が小さくなる」下限）が決める。
 *
 * **0.7 → 0.8 に上げた**（フェーズJJ-57）。空気抵抗が入って**長打が減ったぶん、
 * 強打者を歩かせて塁を1つ与える価値も下がった**＝同じ 0.70 では二・三塁1死で
 * -0.14点（＝歩かせるほうが損）になる。**計測を追いかけて境界を引き直しただけ**で、
 * 規則の形（一塁が空いている／得点圏に走者／次打者との差）は何も変えていない。
 * 0.80 なら二・三塁1死で +0.03点＝計測どおり得の側に戻る。
 *
 * **銃の `CPU_GUN_POWER_THRESHOLD`（0.7）とは値が分かれた**：あちらは「名鑑の上から
 * 約2割」という別の決め方なので、一致していたのは元から偶然（Q-38のコメント参照）。
 */
export const CPU_INTENTIONAL_WALK_POWER_THRESHOLD = 0.8;

/**
 * 敬遠が成り立つのに要る、**次打者との長打力の差**。敬遠は「この打者を避けて次打者と
 * 勝負する」手なので、次打者が同じくらい強ければ塁を1つ配るだけの損になる。
 *
 * `balance:walk` の6段目が「打者の長打力ごとに、次打者がどこまでなら得か」を出しており、
 * その上限はおおむね **打者 − 0.20〜0.25**（打者0.7で 0.45〜0.60／打者1.0で 0.70〜0.85）。
 * 0.25 まで厳しくすると名鑑16球団で**4球団・6打順**でしか成立せず規則が死ぬ（7段目）ので、
 * **0.20**（10球団・13打順、好調込みで40打順）を採った。
 * 境界の場面（打者ちょうど0.70・二塁または三塁に走者・1死）では最大 0.02点ぶん損だが、
 * そのぶん「4番を歩かせて5番と勝負する」という**読める形**に収まる。
 */
export const CPU_INTENTIONAL_WALK_POWER_GAP = 0.2;

/**
 * CPU投手が敬遠するかの判断（決定的・乱数不使用）。規則は敬遠の定石そのもので、
 * **どれも `npm run balance:walk` が測った境界**（CLAUDE.md「バランス調整の方針」）：
 *
 * 1. **一塁が空いていること**。埋まっていると走者を押し出すので原則損で、満塁なら
 *    必ず1点献上＝最大の損（4段目：満塁はどの打者でも -0.29〜-1.12）。
 * 2. **得点圏（二塁 or 三塁）に走者がいること**。走者なしでは「1本で点が入らない」ので
 *    歩かせる値打ちがほぼ無い（3段目：走者なしはほぼ全域で負）。
 * 3. **打者が強打者で、次打者がそれより弱いこと**（上の2定数）。
 *
 * `shouldCpuShoot` と同じく、**打順表と塁の状態を見れば歩かされる打席が事前に分かる**
 * （桜井ノウハウ「コンピューターが良い目を出すとイカサマしてると思われがち」＝
 * 決定的なら「そういう規則だから読めたはず」になる）。人間側の対処も同じ形で成立する
 * ＝主砲の後ろに強い打者を置けば歩かされない（打順を決めるC-15の判断に帰結が付く）。
 *
 * 好調（フェーズD-19）は呼び出し側が `effectiveBatting` で読み込んだ長打力に
 * 乗っているので、**ゼッコーチョーの打者・ラッキー7の打線は歩かされやすくなる**
 * （銃の判断とまったく同じ経路）。
 */
export function shouldCpuIntentionalWalk(opts: {
  bases: Bases;
  batterPower: number;
  nextBatterPower: number;
}): boolean {
  if (opts.bases.first) return false;
  if (!opts.bases.second && !opts.bases.third) return false;
  if (opts.batterPower < CPU_INTENTIONAL_WALK_POWER_THRESHOLD) return false;
  return opts.nextBatterPower <= opts.batterPower - CPU_INTENTIONAL_WALK_POWER_GAP;
}
