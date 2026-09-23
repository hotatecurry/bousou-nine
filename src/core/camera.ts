/**
 * **カメラの置き場所と「画面に何がどれだけ大きく映るか」**（フェーズE-24／LL-59／NN-61）。
 *
 * 中心はちっちゃいモードの追従カメラ（E-24）。原作の「ちっちゃいモード」は打球・走者に
 * 寄った画面がボールを追ってスクロールする。従来はフィールド全体を1画面に収めた固定鳥瞰で、
 * 選手が数ピクセルにしか見えず守備の手応えが薄かった（ファインプレイの跳躍が見た目で
 * ほぼ分からない一因でもある）。
 *
 * ここには**Three.jsに依存しない計算だけ**を置く（カメラの置き場所・追従・追従点の
 * クランプ・画面外マーカーの位置・**選手とボールの見かけの大きさ**）。実際のカメラ操作は
 * scenes/chicchaiScene.ts と scenes/dekkaiScene.ts のリグが、画面外マーカーの描画は
 * ui/hud が担う。
 *
 * **見かけの大きさの値がここに集まっているのは意図的**（LL-59の `CHICCHAI_PLAYER_SCALE`／
 * NN-61の `BALL_RADIUS`・`CHICCHAI_BALL_SCALE`・`DEKKAI_BALL_SCALE`）＝「選手はどれだけ
 * 大きく見えるか」と「ボールはどれだけ大きく見えるか」は必ず一緒に見て決めるものなので、
 * 調整先を散らさない（テンポの値を core/tempo.ts に集約したのと同じ理由）。
 * どれも**判定には一切効かない**（捕球半径・送球・盗塁の窓はワールド座標の純粋関数で、
 * 描く大きさを引数に取らない）。
 *
 * 設計の要点：
 * - **寄り具合は「地面に映る横幅の半分」1つの値で決める**（CHICCHAI_VIEW_HALF_WIDTH）。
 *   カメラの高さ・引きはそこから毎フレーム導出するので、**画面のアスペクト比が変わっても
 *   映るメートル数が変わらない**（ウィンドウを細くしても寄り具合は同じ）。テンポの値を
 *   core/tempo.ts に集約したのと同じ理由で、調整したくなるのはこの1つだけになる。
 * - **追従は指数的な追いつき**（時定数 CAMERA_FOLLOW_TAU）。速い打球ではわずかに遅れて
 *   ボールが画面中心より先に出るので、スクロールしている感じが出る。
 */
import { GRAVITY } from './batting';
import type { Vec2 } from './fielding';
import {
  CATCH_HEIGHT,
  CATCH_Z,
  PITCHER_PLATE_Z,
  PLATE_Z,
  RELEASE_HEIGHT,
  RELEASE_Z,
  STRIKE_ZONE_HALF_WIDTH,
} from './pitch';

/** ちっちゃいモードの垂直画角（度）。従来の固定鳥瞰と同じ値を引き継ぐ */
export const CHICCHAI_FOV_DEG = 42;

/**
 * 地面に映る横幅の半分（m）＝**寄り具合そのもの**。34m なら画面の横に68m分が映る
 * （本塁を中心に置けば一塁・三塁が両方入り、二塁は画面の外）。
 *
 * 従来の固定鳥瞰は同じ画角で半幅108m（＝フィールド全体）だったので、約3.2倍寄ることになる。
 * これ以上寄せると打球を追う野手が画面外から飛び込んでくる形になり、これ以上引くと
 * 「選手が小さくて守備の手応えが無い」という元の問題に戻る。
 */
export const CHICCHAI_VIEW_HALF_WIDTH = 34;

/**
 * 見下ろす角度（度。水平=0、真上=90）。真上に近いほど遠近の歪みが小さく塁の位置関係が
 * 読みやすいが、完全な真上にすると選手の背丈が消えて「高さ」の手がかりが無くなる
 * （＝ファインプレイで跳んだことが読めない。フェーズE-25-(e)で跳躍の姿勢を入れたので、
 * それまで高さを表していた拡大表現はここに寄りかかっている）。
 */
export const CHICCHAI_TILT_DEG = 70;

/**
 * ちっちゃいモードで選手を実寸の何倍で描くか（フェーズLL-59）。
 *
 * **寄り具合（上の半幅）と対になる値なので隣に置く**：ちっちゃいモードで選手がどれだけ
 * 大きく見えるかは、この2つの掛け合わせでしか決まらない（テンポの値を core/tempo.ts に
 * 集約したのと同じ理由＝調整先を散らさない）。ちっちゃいモードのボールも同じ考えで
 * 実寸より大きく描いてある（`scenes/chicchaiScene.ts` の `BALL_SCALE`）。
 *
 * **判定には一切効かない**：捕球半径（2.6m）・送球・盗塁の窓・タッチはすべてワールド
 * 座標の純粋関数で、モデルの大きさを引数に取らない＝この値をいくつにしても試合の帰結は
 * 1つも動かない（`npm run balance` は不変）。動かすのは「読めるかどうか」だけ。
 *
 * **なぜ要るか**：E-24（追従カメラ）以来、E-25-(e)（バイク・倒れる・跳ぶ）→G-27（乱闘の技）
 * →HH-55（送球）と姿勢を作ってきたが、**いちばん映るはずのちっちゃいモードでいちばん
 * 小さい**（実寸だと 1280x720 で 11.6px＝原作のスプライトの1/7）という記録が3回続いていた。
 *
 * **値は `npm run balance:scale` が決めた**（帯は 2.21倍〜3.97倍）：
 * - 上限 3.97倍＝**描かれた体が覆う地面が捕球半径（2.6m）に届く**大きさ。見下ろしている
 *   ぶん頭は足元から `全高 / tan(70°)` だけ手前に重なって見えるので、これを越えると
 *   「触れているのに捕れない」が画面から読めなくなる。
 * - 下限 2.21倍＝**いちばん狭い窓（800x600。FF-53がHUDの折り返しを実測した窓）でも
 *   原作のスプライト（16px）を下回らない**大きさ。
 *
 * **帯の中のどこを採るかは実機が決めた**：LL-59 はいったん上限寄りの **3.0倍**（原作の
 * 存在感＝画面幅の6.25%にいちばん近い実用値）を採ったが、テストプレイで**大きすぎる**と
 * 出た（2026-08-16 ユーザー判断）ので **2.5倍**へ下げた＝1280x720 で 29.0px・
 * 800x600 でも 18.1px（下限の16pxを上回る）・覆いは捕球半径の 63%（3.0倍では76%）。
 * **帯そのものは計測のまま動かしていない**ので、振り直すのはこの1つの値だけで済む。
 *
 * **カメラを寄せるてこでは届かない**ことも計測が示している：半幅を縮める手は
 * 「一塁・三塁（x=±19.4m）が両方入る」という不変条件（tests/camera.test.ts）が
 * 下限を決めるので、限界の半幅20mでも1.7倍止まりになる（＝どこへ投げるかの判断が
 * 画面の外へ出てしまう）。
 */
export const CHICCHAI_PLAYER_SCALE = 2.5;

/** でっかいモードの垂直画角（度） */
export const DEKKAI_FOV_DEG = 40;

/**
 * でっかいモードのカメラの置き場所と見る先（本塁＝捕手のやや後方・頭上から投手を見る。
 * 原作準拠＝CLAUDE.md②）。**実際のカメラは `scenes/dekkaiScene.ts` の
 * `createDekkaiCamera` がここから組む**ので、値の出どころは1か所（ちっちゃいモードの
 * リグが上の寄り具合から組むのと同じ立て方）。
 *
 * フェーズNN-61でここへ移した＝**ボールの見かけの大きさがカメラからの距離で決まる**
 * （下記 `dekkaiBallScale`）ので、テストと `npm run balance:ball` が読める場所に要る。
 */
export const DEKKAI_CAMERA_POS = { x: 0, y: 4.5, z: CATCH_Z + 8 } as const;
export const DEKKAI_CAMERA_LOOK_AT = { x: 0, y: 1.5, z: PITCHER_PLATE_Z } as const;

/**
 * ボールの実寸の半径 m（公認球＝直径7.3cm）。フェーズNN-61。
 *
 * **それまでは 0.4m（＝実寸の10.9倍）のプレースホルダーだった**（`entities/ball.ts` の
 * 冒頭も「後続セッションで実装する」と書いたままだった）。直径0.8mは
 * **ストライクゾーンの幅（0.9m）の89%**で、**MM-60が付けたリリースの高さの差
 * （上手–横手 0.220m）は球1個の0.27倍**＝せっかく作った「腕ごとに球の出どころが違う」が
 * 球そのものに隠れていた。LL-59が選手を3倍にして「ボールのほうが選手より大きい」を
 * 直したのと同じ性質の、球の側の宿題。
 *
 * **実寸を採ったのはユーザー判断**（2026-08-16）。見かけの大きさは下の2つが決める＝
 * ちっちゃいモードは倍率で、でっかいモードは距離補正で。
 */
export const BALL_RADIUS = 0.0366;

/**
 * ちっちゃいモードで実寸の何倍で描くか（`CHICCHAI_PLAYER_SCALE` と対の値）。
 *
 * **見かけは NN-61 の前と変わらない**：従来は半径0.4mのジオメトリを1.5倍していた
 * （＝描いた半径0.6m）ので、実寸に対する 16.4倍がちょうどその大きさになる
 * （1280x720 で直径22.6px＝**選手29.0px の 0.78倍**）。**実機で確かめた見え方なので
 * 動かさない**（B-8の「基準値0.5＝従来の定数」、MM-60の「上手は従来のまま」と同じ
 * **基準線を動かさない**整理）。選手を 3.0→2.5倍にしたぶん球は相対的に大きくなったが、
 * **球より小さく見える選手はいない**（テストで固定）。
 *
 * **実寸で描けない理由**は `npm run balance:ball` の6段目：真上から見下ろす画面で
 * 実寸の球は 1280x720 で **1.4px**（選手は29.0px）＝**追う対象が消える**。
 * でっかいモードと違って距離補正のてこも無い（鳥瞰なのでカメラからの距離がほぼ一定）。
 */
export const CHICCHAI_BALL_SCALE = 16.4;

/**
 * でっかいモードで**ボールが基準の大きさ（下の `DEKKAI_BALL_SCALE` ちょうど）に見える点**
 * ＝**本塁上**（ミットの高さ）。
 *
 * 下の `dekkaiBallScale` が距離補正で見かけの大きさを一定に保つので、**倍率が素で効くのは
 * この1点だけ**（そこより遠いところではもっと大きく、近いところでは小さく描かれる）。
 * **本塁を採ったのは「打者が振るかどうかを決める場所」だから**＝球の見かけの基準は、
 * その判断が起きる場所であってほしい（S-40が「基準速の走者はちょうど従来の78m」と
 * 基準線を意味のある1点に置いたのと同じ選び方）。
 */
export const DEKKAI_BALL_ANCHOR = { x: 0, y: CATCH_HEIGHT, z: PLATE_Z } as const;

/**
 * 実際の野球の本塁ベースの幅 m（17インチ）＝**このゲームのゾーンが実物の何倍かを測る物差し**。
 * 下の `DEKKAI_BALL_SCALE` を導くためだけに持つ（判定には一切出てこない）。
 */
const REAL_HOME_PLATE_WIDTH = 0.4318;

/**
 * でっかいモードでボールを実寸の何倍で描くか（`CHICCHAI_BALL_SCALE` と対の値）。
 *
 * **NN-61 は 1.0倍（＝基準点で実寸ちょうど）だったが、テストプレイで「投げる球が
 * イメージより小さい」と出た**（2026-08-16 ユーザー判断）。実寸の球は本塁で直径
 * **6.9px**（1280x720）＝ただの点で、原作のスプライト（8x8px＝画面幅の3.1%）比では 1/5.8。
 *
 * **倍率は新しい数値を持ち込まずに決めた**＝**ゾーンが実物より広いのと同じ倍率**。
 * このゲームのストライクゾーンは幅 0.9m で、実際の本塁ベース（0.432m）の 2.08倍に
 * 描いてある（原作準拠で左右コースだけを見る判定なので、実物より広い）。**球にも
 * 同じ倍率を掛ければ、打者が実際に読む「ゾーンの幅に対する球の大きさ」が実際の野球と
 * 同じ比（約17%）になる**＝球だけが不釣り合いに大きい／小さいことがない
 * （W-44 が `COURSE_VX_PER_CONTROL` を「既にある隅に合わせる」で決め、CC-50 が腕のずれを
 * O-36 の可動幅に合わせたのと同じ**既にある寸法に揃える**やり方）。
 *
 * **上限はMM-60が決めている**（`npm run balance:ball` の4段目）：大きくするほど
 * リリースの高さの差（上手–横手 0.220m）が球に埋もれるので、**段差が球の半分を
 * 下回らない 2.26倍**が上限＝採用の 2.08倍はその内側（段差は球 0.54個ぶん＝**中心の
 * 高さの違いは読める**が、NN-61 当時の「球1個ぶん離れている」ほどの余裕は無い）。
 * **MM-60 自身の読み取り条件（いちばん低い解像度で5px以上離れる）は球の大きさとは
 * 無関係なので不変**（800x600 で 6.5px）。
 */
export const DEKKAI_BALL_SCALE = (2 * STRIKE_ZONE_HALF_WIDTH) / REAL_HOME_PLATE_WIDTH;

/** でっかいモードのカメラが向いている向き（単位ベクトル。置き場所と見る先から導出） */
const DEKKAI_FORWARD = (() => {
  const dx = DEKKAI_CAMERA_LOOK_AT.x - DEKKAI_CAMERA_POS.x;
  const dy = DEKKAI_CAMERA_LOOK_AT.y - DEKKAI_CAMERA_POS.y;
  const dz = DEKKAI_CAMERA_LOOK_AT.z - DEKKAI_CAMERA_POS.z;
  const len = Math.hypot(dx, dy, dz);
  return { x: dx / len, y: dy / len, z: dz / len };
})();

/**
 * カメラから見た**視線方向の奥行き** m（カメラからの直線距離ではない）。
 *
 * 遠近投影で画面上の大きさを決めるのはこちら＝視線に垂直な長さ L は
 * `L / (奥行き × tan(画角/2))` に映る（直線距離で割ると、視線から外れた位置にあるものほど
 * 実際より小さく見積もる）。**実機で踏んだ**：直線距離で補正すると、フォークが本塁手前で
 * 沈んで視線から外れるぶん、見かけの大きさが飛行中に11%ぶれた（実測 6.71→7.45px）。
 */
export function dekkaiViewDepth(p: { x: number; y: number; z: number }): number {
  return (
    (p.x - DEKKAI_CAMERA_POS.x) * DEKKAI_FORWARD.x +
    (p.y - DEKKAI_CAMERA_POS.y) * DEKKAI_FORWARD.y +
    (p.z - DEKKAI_CAMERA_POS.z) * DEKKAI_FORWARD.z
  );
}

/** 上の基準点の奥行き m（＝10.51m。見かけの大きさの分母） */
export const DEKKAI_BALL_ANCHOR_DISTANCE = dekkaiViewDepth(DEKKAI_BALL_ANCHOR);

/**
 * でっかいモードのボールに掛ける拡大率（フェーズNN-61。**見た目だけ**）。
 *
 * **画面上の大きさを一定に保つ**＝カメラから遠いほど大きく描く（原作は2Dスプライトなので
 * 飛行中も同じ大きさ。ユーザー判断 2026-08-16）。素の3Dのままだと**リリース（28.0m）から
 * 本塁（10.8m）までで見かけが2.6倍に育つ**ので、実寸で描くと**リリースの瞬間だけ
 * 2.6px**（800x600 では2.1px）＝**投げた球が手を離れた瞬間に見失う**。
 *
 * その一定の大きさを決めるのが上の `DEKKAI_BALL_SCALE`（基準点で実寸の何倍に見せるか）で、
 * ここはそこへ**距離の比を掛けるだけ**＝**「どれだけ大きいか」と「飛行中ずっと同じ大きさか」を
 * 別々の値に分けてある**ので、大きさを振り直しても一定であることは壊れない。
 *
 * 一定にする代わりに、**遠近そのものが持っていた「いつ来るか」の手がかりは消える**。
 * 残る手がかりは画面上の縦の動き（リリース時はほぼ画面中央→本塁では画面の6割ほど下）で、
 * こちらは補正しても変わらない。
 *
 * **基準点そのものにも下限がある**（`npm run balance:ball` の4段目）：近づけるほど球は
 * 大きくなるので、**リリースの高さの差（上手–横手 0.220m）が球に隠れない**ためには
 * **本塁（10.51m）までが限度**（ミット基準 8.32m は不可）＝**大きさを振るのは
 * `DEKKAI_BALL_SCALE` のほうで、基準点は動かさない**。
 *
 * 見かけの直径は **1280x720 で 14.4px・800x600 で 11.9px**（飛行中ずっと一定）＝
 * 原作のスプライト（8x8px）比で 1/2.8。
 */
export function dekkaiBallScale(p: { x: number; y: number; z: number }): number {
  // カメラの後ろ（奥行きが負）はそもそも映らないので0で止める（負の拡大率を作らない）
  return (DEKKAI_BALL_SCALE * Math.max(0, dekkaiViewDepth(p))) / DEKKAI_BALL_ANCHOR_DISTANCE;
}

// ---------------------------------------------------------------------------
// 投球の見た目：弧と残像（フェーズPP-63）
// ---------------------------------------------------------------------------
//
// NN-61（ボールの大きさ）が実寸にしたことで表に出た**2つの穴**を埋める。どちらも
// **高低はゾーン判定に無関係**（説明書p19準拠。`PitchFlight` は x と z しか持たない）なので、
// **ここから下は判定に一切効かない**＝LL-59・NN-61 と同じ「見た目だけの値」の並び。
//
// ## 1. 遅い球が地面へ潜っていた
//
// 旧実装（`dekkaiScene.ts`）は**直線から `FORK_DROP_MAX × slowness × q²` を引く**だけで、
// いちばん遅い球は**本塁の2.4m手前で y<0 に入り**、NN-61 が置いた下限（球の半径）で
// 止まっていた＝**ミットの高さへ収束しない**（球はミットの下を通って到着する）。
//
// 作り替えの形はユーザー判断で**放物線**（2026-08-16）：**リリースの高さ（MM-60）から
// ミットの高さ（`CATCH_HEIGHT`）へ、重力で落ちる弧**として解く。これで
// - **自由変数が消える**（`FORK_DROP_MAX` は要らない）＝弧の大きさは**飛行時間**、
//   つまり球速だけで決まる（`GRAVITY` は打球の飛行と同じ実際の重力を読む）。
// - **球は必ずミットに入る**＝NN-61 の地面クランプが構造的に不要になった。
// - **緩急がそのまま形に出る**：速球はほぼ直線・フォークは大きく弧を描いて手元で落ちる。
//
// 代償は**前半が必ず直線より上を通ること**（実際の80km/hの球と同じ）。**弧は
// `slowness` に比例させる**ので、**基準速・速球の見え方は従来と完全に同じ**
// （ユーザー判断＝MM-60の「上手は従来のまま」、B-8の「基準値0.5＝従来の定数」と同じ
// **基準線を動かさない**整理）。
//
// ## 2. 速球の伸びが画面に出ていなかった
//
// 旧実装は残像をワールドZ方向へ引き伸ばしていたが、でっかいモードのカメラはほぼ -Z を
// 向く＝**伸びが視線に沿ってしまい、画面では約1割しか出ていなかった**。**画面上の
// 進行方向（＝視線に垂直な速度成分）へ伸ばす**ように向きだけ直した（ユーザー判断）。

/** 投球の見た目の通り道の1点 */
export interface PitchArcPoint {
  /** その z での高さ m */
  y: number;
  /** dy/dz。`vy = slope × vz` として画面上の動く向きに使う */
  slope: number;
}

/**
 * 投球の見た目の高さ（フェーズPP-63）。**リリースの高さからミットの高さへ落ちる放物線**で、
 * 弧の大きさは飛行時間（＝球速）から出る。
 *
 * 飛行時間 T の放物線は、両端を結ぶ直線に `(g T² / 2) · p(1-p)` を足したもの（p は
 * リリース0→ミット1の進み）＝**頂点はその1/4**（`g T² / 8`）。`slowness`（`core/pitch.ts`）を
 * 掛けるので、**基準速以上の球は直線ちょうど＝PP-63の前と1ドットも変わらない**。
 *
 * @param z いまのボールのZ
 * @param vz 球速 m/s（リリース時に確定し飛行中は変わらない＝説明書p19②）
 * @param releaseHeight リリースの高さ（`armReleaseHeight`。MM-60）
 * @param slowness その投手の基準速からどれだけ遅いか 0..1（`pitchSlowness`）
 */
export function pitchArcPath(
  z: number,
  vz: number,
  releaseHeight: number = RELEASE_HEIGHT,
  slowness = 0,
): PitchArcPoint {
  const span = CATCH_Z - RELEASE_Z;
  const p = Math.max(0, Math.min(1, (z - RELEASE_Z) / span));
  const flightSec = span / Math.max(vz, 1e-6);
  // 直線に足す弧（頂点はこの1/4）。slowness=0 なら弧は無い＝完全な直線。
  const arc = slowness * GRAVITY * flightSec * flightSec * 0.5;
  const fall = CATCH_HEIGHT - releaseHeight;
  return {
    y: releaseHeight + fall * p + arc * p * (1 - p),
    slope: (fall + arc * (1 - 2 * p)) / span,
  };
}

/**
 * その速度が**画面上でどちらへ動いて見えるか**（ワールドの単位ベクトル）。
 * 視線に垂直な成分＝画面に映る動きで、真正面へ来る球（垂直成分が無い）は null。
 *
 * このカメラでは球の動きはほぼ画面の縦なので、返るのはおおむね真下向きになる
 * （＝残像は縦に伸びる）。
 */
export function dekkaiScreenMotionAxis(v: {
  x: number;
  y: number;
  z: number;
}): { x: number; y: number; z: number } | null {
  const along = v.x * DEKKAI_FORWARD.x + v.y * DEKKAI_FORWARD.y + v.z * DEKKAI_FORWARD.z;
  const px = v.x - along * DEKKAI_FORWARD.x;
  const py = v.y - along * DEKKAI_FORWARD.y;
  const pz = v.z - along * DEKKAI_FORWARD.z;
  const len = Math.hypot(px, py, pz);
  if (len < 1e-6) return null;
  return { x: px / len, y: py / len, z: pz / len };
}

/**
 * 残像の長さを決める「1フレーム」（秒）＝60fpsの1枚ぶん。
 *
 * **残像の長さは新しい数値を持ち込まずに決める**＝**その球が1フレームで画面上に動く距離**
 * ちょうど（＝コマの間の隙間を埋める長さ）。実際の dt ではなく固定の1枚ぶんにするのは、
 * フレーム時間の揺れで球の形がちらつかないため。
 */
export const DEKKAI_TRAIL_FRAME_SEC = 1 / 60;

/** でっかいモードのボールの描き方（位置・拡大・残像）。`dekkaiBallLook` が組んで返す */
export interface DekkaiBallLook {
  /**
   * 球の中心を置く場所。**残像は必ず後ろへ伸ばす**（先端は実際の位置のまま）＝
   * 見た目が判定より先に行かない（伸ばした球の前端で早く振ってしまうことがない）。
   */
  center: { x: number; y: number; z: number };
  /** 一様な拡大率（見かけの大きさを一定に保つ距離補正＝NN-61） */
  scale: number;
  /** 残像を伸ばす向き（画面上の進行方向）。伸ばさないなら null */
  axis: { x: number; y: number; z: number } | null;
  /** 伸ばす割合（描いた球の直径に対する上乗せ。0=伸ばさない） */
  trail: number;
}

/**
 * でっかいモードのボールをどう描くか（フェーズPP-63）。
 *
 * **残像は「1フレームで画面上に動く距離」**（上記）で、**`fastness` を掛ける**ので
 * 基準速以下の球には出ない＝PP-63の前の見え方をそのまま保つ（弧と同じ整理）。
 * 近づくほど画面上の動きは速くなるので**残像も伸びる**＝NN-61 が見かけの大きさを
 * 一定にして手放した「近づいてくる」手がかりが、こちらの形で少し戻る。
 *
 * @param pos ボールの位置（弧を含んだ見た目の高さ）
 * @param vel ボールの速度（`vy = slope × vz`。弧の傾きから作る）
 * @param fastness その投手の基準速からどれだけ速いか 0..1（`pitchFastness`）
 */
export function dekkaiBallLook(
  pos: { x: number; y: number; z: number },
  vel: { x: number; y: number; z: number },
  fastness = 0,
): DekkaiBallLook {
  const scale = dekkaiBallScale(pos);
  const axis = fastness > 0 ? dekkaiScreenMotionAxis(vel) : null;
  if (!axis || scale <= 0) return { center: { ...pos }, scale, axis: null, trail: 0 };
  // 画面上の動きの速さ＝視線に垂直な速度成分（axis はその向きの単位ベクトル）
  const screenSpeed = vel.x * axis.x + vel.y * axis.y + vel.z * axis.z;
  const drawnDiameter = 2 * BALL_RADIUS * scale;
  const trail = (fastness * screenSpeed * DEKKAI_TRAIL_FRAME_SEC) / drawnDiameter;
  // 伸びるのは前後半分ずつなので、後ろへ半分ずらすと先端が実際の位置に残る
  const back = BALL_RADIUS * scale * trail;
  return {
    center: { x: pos.x - axis.x * back, y: pos.y - axis.y * back, z: pos.z - axis.z * back },
    scale,
    axis,
    trail,
  };
}

/**
 * 追従の時定数（秒）。1フレームで desired へ `1 - exp(-dt/τ)` だけ近づく。
 * 小さくすると即座に追いつく（＝スクロールというよりボールが画面中央に貼り付く）、
 * 大きくすると遅れが目立ちボールが画面端へ寄っていく。0.12秒なら最速の打球（約40m/s）でも
 * 定常の遅れは約4.8mで、半幅34mの画面から出ることはない。
 */
export const CAMERA_FOLLOW_TAU = 0.12;

/**
 * 追従点の可動範囲（m）。**映る範囲が描かれた地面の外へ出ないための上限**で、
 * ここを超えて追わない＝ホームランのボールは画面の上へ抜けていく（原作でも打球は
 * 画面外へ消える）。値は「限界＋CHICCHAI_VIEW_HALF_WIDTH」がおおむね地面の縁に
 * 一致するように選んである（field.ts の GROUND_RADIUS）。
 *
 * 外野方向の限界は**6球場でいちばん深いフェンス（だいそうげんのセンター130m）が
 * 画面に入るところまで**下げてある（フェーズC-14）。E-24の -78 は円形100mの
 * フェンス専用の値で、そのままだと110〜130mのフェンスが画面の外に出てしまい、
 * 「壁に当たって跳ね返る打球が見えない」ことになる。上限を広げても追従点は
 * ボールより先へは行かないので、狭い球場での見え方は変わらない。
 */
export const FOCUS_LIMIT = {
  /** 一塁側・三塁側の限界 */
  x: 62,
  /** 外野方向（-Z）の限界 */
  deep: -108,
  /** 本塁の後ろ（+Z）の限界。捕手の後ろのファウルゾーンまでで止める */
  back: 8,
} as const;

/** プレーが始まっていないときにカメラが見ている場所（内野の中央あたり） */
export const CHICCHAI_DEFAULT_FOCUS: Vec2 = { x: 0, z: -19.4 };

const DEG = Math.PI / 180;

/**
 * 指定の寄り具合（地面の横幅の半分）で映すために必要なカメラ〜追従点の距離。
 * アスペクト比から水平画角を求めるので、**ウィンドウの形が変わっても映るメートル数は
 * 変わらない**（縦長の画面ではカメラが引いて横幅を保つ）。
 */
export function cameraDistance(fovDeg: number, aspect: number, halfWidth: number): number {
  const halfHorizontal = Math.atan(Math.tan((fovDeg / 2) * DEG) * aspect);
  return halfWidth / Math.tan(halfHorizontal);
}

/**
 * 追従点から見たカメラの置き場所（真上＝y、手前＝+z のオフセット）。
 * 見下ろす角度と距離だけで決まる（＝寄り具合を変えても見下ろす角度は変わらない）。
 */
export function cameraOffset(distance: number, tiltDeg: number): { y: number; z: number } {
  return {
    y: distance * Math.sin(tiltDeg * DEG),
    z: distance * Math.cos(tiltDeg * DEG),
  };
}

/**
 * 1フレーム分だけ追従点を desired へ近づける。指数的な追いつきなので、フレームレートが
 * 変わっても同じ速さで追う（dt が大きいフレームでも行き過ぎない）。
 */
export function followFocus(
  current: Vec2,
  desired: Vec2,
  dt: number,
  tau: number = CAMERA_FOLLOW_TAU,
): Vec2 {
  if (dt <= 0) return { ...current };
  if (tau <= 0) return { ...desired };
  const k = 1 - Math.exp(-dt / tau);
  return {
    x: current.x + (desired.x - current.x) * k,
    z: current.z + (desired.z - current.z) * k,
  };
}

/** 追従点を可動範囲へ丸める（映る範囲が描かれた地面の外へ出ないようにする） */
export function clampFocus(p: Vec2): Vec2 {
  return {
    x: Math.max(-FOCUS_LIMIT.x, Math.min(FOCUS_LIMIT.x, p.x)),
    z: Math.max(FOCUS_LIMIT.deep, Math.min(FOCUS_LIMIT.back, p.z)),
  };
}

/** 画面外のものを指し示す印（ビューポートに対する割合と、指し示す向き） */
export interface EdgeMarker {
  /** 0=左端 / 1=右端 */
  x: number;
  /** 0=上端 / 1=下端 */
  y: number;
  /** 画面上の向き（ラジアン。0=右、π/2=下） */
  angle: number;
}

/**
 * 画面外にあるものを、その方向の画面端に置く印の位置へ変換する（フェーズE-24）。
 * 追従カメラにすると走者が画面外へ出るので、**どの塁へ投げるかの判断材料が画面から
 * 消える**（既存の「意思決定材料は隠さない」方針に反する）ため、方向だけでも残す。
 *
 * @param ndc 正規化デバイス座標（THREE.Vector3.project() の結果。x,y は -1..1、
 *            y は上が+）。**カメラの後ろにある点は z>1 になり x,y の符号が反転する**ので、
 *            ここで戻してから扱う（本塁の後ろへ抜けた打球を追っているときに実際に起きる）。
 * @param margin 画面端からどれだけ内側に置くか（0..1。0.06＝画面の3%内側）
 * @returns 画面内にあるなら null（印は要らない）
 */
export function edgeMarker(
  ndc: { x: number; y: number; z: number },
  margin: number,
): EdgeMarker | null {
  const behind = ndc.z > 1;
  const nx = behind ? -ndc.x : ndc.x;
  const ny = behind ? -ndc.y : ndc.y;
  if (!behind && Math.abs(nx) <= 1 && Math.abs(ny) <= 1) return null;

  const extent = Math.max(Math.abs(nx), Math.abs(ny));
  // 真後ろの一点（方向が定まらない）だけは印を出さない
  if (extent === 0) return null;
  const scale = (1 - margin) / extent;
  const ex = nx * scale;
  const ey = ny * scale;
  return {
    x: (ex + 1) / 2,
    y: (1 - ey) / 2,
    // 画面座標は下が+なので、NDCのyを反転して向きを求める
    angle: Math.atan2(-ey, ex),
  };
}
