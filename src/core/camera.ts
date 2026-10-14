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
import { CONTACT_PLANE_Z } from './batting';
import { BASE_AXIS, type Vec2 } from './fielding';
import {
  type PitchStall,
  CATCH_HEIGHT,
  CATCH_Z,
  FORK_BOUNCE_MIN_RATING,
  PITCHER_PLATE_Z,
  PLATE_Z,
  RELEASE_HEIGHT,
  RELEASE_Z,
  STRIKE_ZONE_HALF_WIDTH,
  forkBounces,
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

/**
 * でっかいモードの垂直画角の**下限**（度）。実際の画角は窓の形から `dekkaiFovFor` が決める
 * （一・三塁の走者が画面に収まる広さ。16:9 では約42.5°）。これより狭くはしない＝
 * 横に広い窓で寄りすぎない。
 */
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

/**
 * 一・三塁のベースに立つ走者の体の半分の幅 m（腕を含む）と、画面の縁からの余白（NDC）。
 * `dekkaiFovFor` がこの2つで「走者が画面の横幅に収まる」ことを決める。
 */
export const DEKKAI_RUNNER_HALF_WIDTH = 0.6;
export const DEKKAI_EDGE_MARGIN = 0.03;

/**
 * でっかいモードの垂直画角（度）を**窓の形から**決める（テストプレイ「塁が埋まっているのに
 * でっかいモードでは塁に誰もいない」）。**一・三塁のベースに立つ走者が必ず画面の横幅に
 * 収まる**最小の画角で、`DEKKAI_FOV_DEG`（40°）より狭くはしない。
 *
 * 40°固定のときは、一・三塁のベースが16:9の画面の**ちょうど左右の端**（NDC ±1.00）にあり、
 * 塁上の走者は半分切れ、16:9より細い窓では画面の外に出ていた。窓の横幅が一・三塁ぶん
 * 以上あることを優先したので、**16:9 でも絵全体が約6%小さくなり、細い窓ほど小さくなる**
 * （2026-09-25 ユーザー判断「少し引いて常に入れる」）。**判定には一切効かない**
 * （カメラはどの純粋関数の引数にもならない）。
 */
export function dekkaiFovFor(aspect: number): number {
  const edge = { x: BASE_AXIS + DEKKAI_RUNNER_HALF_WIDTH, y: 0.9, z: -BASE_AXIS };
  // 見る先が真正面（ヨー無し）なので、カメラの右はワールドの +X＝横のずれは x そのもの
  const tanHalfH = (edge.x - DEKKAI_CAMERA_POS.x) / dekkaiViewDepth(edge) / (1 - DEKKAI_EDGE_MARGIN);
  const needed = (2 * Math.atan(tanHalfH / aspect) * 180) / Math.PI;
  return Math.max(DEKKAI_FOV_DEG, needed);
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
// 投球の見た目（フェーズBBB-76。原作準拠。**見た目だけ**）
// ---------------------------------------------------------------------------
//
// テストプレイ「ピッチャーが球を投げてからヒットを打つまでの間が全然原作と違う」。原作の
// 映像を1フレームずつ測ると、投げた球は**画面を一定の速さで下りてくる**（地面の影が
// 毎フレーム同じドット数ずつ進む＝7球すべてで等速）。**地面には影が出て、球はその上を
// 一定の高さで飛ぶ**（球と影の間はずっと約20ドット）。球の絵は途中で1回だけ大きくなる
// （4×4→6×6）。
//
// 3Dの透視ではこうはならない：同じ速さで飛ぶ球は、遠くでは画面上をほとんど動かず、
// 手元で一気に迫る（リリースから打つまでの時間の前半で、画面上の移動の13%しか進まない
// ＝実機で計測）。**球が来るのを見ていられる時間**そのものが原作と違っていた。
//
// そこで**描く位置だけを「画面上で等速」になる奥行きへ置き直す**（ユーザー判断 2026-10-07）：
// - 通り道は**リリースからミットへの3Dの直線**（PP-63の弧はやめた＝原作の球は弧を描かない）。
// - その直線の上で、**リリースから打撃面までは画面の縦の位置が時間に比例する点**に描く。
//   両端（リリースと打撃面）は本当の位置と同じ＝**手から出て、バットのところで当たる**。
//   打撃面からミットまでも同じ形でつなぐ（そこは本当の球も一瞬で過ぎる）。
// - 横は**いまの速度のまま外挿**して同じ奥行きへ置く＝曲がる球もその直線（通り道）の上に乗る。
// - PP-63の残像はやめた（原作の球はドットの絵で、伸びない）。
//
// **判定はこれを一切見ない**（`PitchFlight` のまま）。描く場所が本当の場所より先へ行くのは
// 飛行の途中だけで、**着く時刻は本当の球と同じ**＝打つタイミングは変わらない。

/** 投球の通り道の高さ m（リリースの高さからミットの高さへの直線。フェーズBBB-76） */
export function pitchLineHeight(z: number, releaseHeight: number = RELEASE_HEIGHT): number {
  const p = (z - RELEASE_Z) / (CATCH_Z - RELEASE_Z);
  return releaseHeight + (CATCH_HEIGHT - releaseHeight) * p;
}

// ---- フォークの落ち方（フェーズBBB-77→**BBB-79で2通りに分けた**） ----
//
// BBB-77 は原作の録画のフォーク（失速の間に球と影の間が20→4ドット）に合わせて、**どの投手の
// フォークも**打撃面で地面すれすれ（0.2m）まで落としていた。原作のその1球は**本塁の上で
// ワンバウンドしてボール**の判定で、テストプレイ「ワンバウンドしたのに見逃したらストライク」。
// 2026-10-09 ユーザー判断で**ワンバウンドするのはFの大きい投手のフォークだけ**にした
// （説明書p19「上でフォークかチェンジアップ」。境目と判定は `core/pitch.ts` の
// `FORK_BOUNCE_MIN_RATING`／`pitchBounces`）：
//
// - **フォーク（F ≥ 境目）**：失速が始まった所から**本塁の前半分（`FORK_BOUNCE_Z`）で地面に
//   着き**（影と重なる）、跳ねて捕手のミットへ上がる＝原作の録画と同じ絵。判定の本塁通過
//   （`PLATE_Z`）より手前で着くので、見た目と「見逃せばボール」が食い違わない。
// - **チェンジアップ（F < 境目）**：打撃面までに `changeupEndHeight` まで落ちるだけ
//   （膝の高さより上＝低めのストライクに見える）。Fが大きいほど深い。
//
// どちらも**落ちる割合は本当の球の進み**（`trueZ`）で決める＝失速して進みが遅いぶん、
// 落ちるのもゆっくり見える（BBB-77のまま）。

/** ワンバウンドするフォークが地面に着く場所 z（本塁の前半分。判定の本塁通過より手前） */
export const FORK_BOUNCE_Z = PLATE_Z - 0.15;

/**
 * ワンバウンドしないフォーク（チェンジアップ）が打撃面で落ちきる高さ m。F が 0 で
 * `CHANGEUP_DROP_TOP`、境目の手前で `CHANGEUP_DROP_BOTTOM`（膝の高さ＝低めのストライク）。
 */
export const CHANGEUP_DROP_TOP = 0.75;
export const CHANGEUP_DROP_BOTTOM = 0.45;

/** チェンジアップ（ワンバウンドしないフォーク）が打撃面で落ちきる高さ m */
export function changeupEndHeight(fork: number): number {
  const t = Math.max(0, Math.min(1, fork / FORK_BOUNCE_MIN_RATING));
  return CHANGEUP_DROP_TOP + (CHANGEUP_DROP_BOTTOM - CHANGEUP_DROP_TOP) * t;
}

/**
 * 描く球の高さ m。ふつうは通り道の直線（`pitchLineHeight`）。フォーク（`stall` のある球）は
 * 上の2通りに落ちる（**高さはゾーン判定には使わない**＝判定はワンバウンドしたかどうか
 * だけで、それは `stall.fork` から `core/pitch.ts` が決める）。
 */
export function pitchDrawnHeight(
  drawnZ: number,
  trueZ: number,
  releaseHeight: number = RELEASE_HEIGHT,
  stall?: PitchStall,
): number {
  const line = pitchLineHeight(drawnZ, releaseHeight);
  if (!stall || trueZ <= stall.fromZ) return line;
  if (forkBounces(stall.fork)) {
    if (trueZ <= FORK_BOUNCE_Z) {
      const u = (trueZ - stall.fromZ) / (FORK_BOUNCE_Z - stall.fromZ);
      return line + (FORK_BOUNCE_CENTER_Y - line) * u;
    }
    // 跳ねて捕手のミットへ上がる（原作：本塁で影と重なった球が、捕手のミットへ上がっていく）
    const v = Math.min(1, (trueZ - FORK_BOUNCE_Z) / (CATCH_Z - FORK_BOUNCE_Z));
    return FORK_BOUNCE_CENTER_Y + (CATCH_HEIGHT - FORK_BOUNCE_CENTER_Y) * Math.sin((v * Math.PI) / 2);
  }
  const end = changeupEndHeight(stall.fork);
  const u = Math.min(1, (trueZ - stall.fromZ) / (CONTACT_PLANE_Z - stall.fromZ));
  return line + (end - line) * u;
}

/**
 * でっかいモードのカメラの上向き（単位ベクトル）。カメラは真正面（x=0）から見るので
 * 前向きは YZ 平面にあり、上向きはそれに垂直で y が正の向き（ロールなし＝three の lookAt と同じ）。
 */
const DEKKAI_UP = { x: 0, y: -DEKKAI_FORWARD.z, z: DEKKAI_FORWARD.y };

/**
 * 画面の縦の位置（**正接の比**＝`NDC の y × tan(垂直画角/2)`）。画角で割る前の値なので
 * **窓の形（画角）によらない**＝等速の判定に画角が要らない。カメラは x=0 から真正面を
 * 見るので x は縦の位置に効かない。
 */
export function dekkaiScreenRise(p: { y: number; z: number }): number {
  const ry = p.y - DEKKAI_CAMERA_POS.y;
  const rz = p.z - DEKKAI_CAMERA_POS.z;
  const depth = ry * DEKKAI_FORWARD.y + rz * DEKKAI_FORWARD.z;
  const rise = ry * DEKKAI_UP.y + rz * DEKKAI_UP.z;
  return rise / depth;
}

/**
 * 通り道（`pitchLineHeight` の直線）の上で、画面の縦の位置がちょうど `rise` になる z。
 * 直線の上では `rise = (A·z + B) / (C·z + D)` の形（分子・分母とも z の1次式）なので、
 * 逆に解ける。
 */
function lineDepthForRise(rise: number, releaseHeight: number): number {
  const k = (CATCH_HEIGHT - releaseHeight) / (CATCH_Z - RELEASE_Z);
  // y(z) - カメラの高さ = k·z + y0
  const y0 = releaseHeight - k * RELEASE_Z - DEKKAI_CAMERA_POS.y;
  const cz = DEKKAI_CAMERA_POS.z;
  const a = DEKKAI_UP.y * k + DEKKAI_UP.z;
  const b = DEKKAI_UP.y * y0 - DEKKAI_UP.z * cz;
  const c = DEKKAI_FORWARD.y * k + DEKKAI_FORWARD.z;
  const d = DEKKAI_FORWARD.y * y0 - DEKKAI_FORWARD.z * cz;
  return (b - rise * d) / (rise * c - a);
}

/**
 * 球の絵が大きくなる場所（リリース→ミットの何割か。原作：23フレームのうち13フレーム目）
 * と、その前後の大きさ（`DEKKAI_BALL_SCALE` に掛ける倍率）。原作の球は 4×4 → 6×6 ドットで、
 * 画面の高さに対して 1/60 → 1/40。1280x720 なら直径 12px → 18px（OO-62の14.4pxを挟む）＝
 * **近づくと1回だけ大きくなる**原作の見え方。手元の大きさは本塁の幅（ゾーン幅）に対しても
 * 原作と同じ比（約1/4）になる。
 */
export const DEKKAI_PITCH_SIZE_SWITCH = 13 / 23;
export const DEKKAI_PITCH_SIZE_FAR = 5 / 6;
export const DEKKAI_PITCH_SIZE_NEAR = 5 / 4;

/**
 * ワンバウンドするフォークが地面に着いた瞬間の球の中心の高さ m（フェーズBBB-79）＝本塁での
 * 描く球の半径（`BALL_RADIUS` × 見かけの倍率 × 手元の大きさ）。ここまで下がると球の下端が
 * 地面に着き、真下の影と重なる（原作の録画：本塁の上で球と影が1つになる）。
 */
export const FORK_BOUNCE_CENTER_Y = BALL_RADIUS * DEKKAI_BALL_SCALE * DEKKAI_PITCH_SIZE_NEAR;

/**
 * 影の縦横比（原作の影は 4×2 → 5×3 ドット＝縦が横の約半分）。地面の円を斜めから見ると、
 * 遠いほど平たく潰れる（リリース付近は1/6）ので、奥行きの向きをそのぶん引き伸ばして
 * どこでもこの比に揃える。
 */
export const DEKKAI_SHADOW_ASPECT = 0.55;

/** でっかいモードの投球の描き方（`dekkaiPitchLook` が組んで返す） */
export interface DekkaiPitchLook {
  /** 球の中心を置く場所 */
  center: { x: number; y: number; z: number };
  /** 球の一様な拡大率（見かけの大きさ一定＝NN-61 × 原作の2段の大きさ） */
  scale: number;
  /** 影（地面の円）を置く場所と大きさ。`depthStretch` は奥行きの向きだけに掛ける */
  shadow: { x: number; z: number; scale: number; depthStretch: number };
}

/**
 * でっかいモードの投球をどう描くか（フェーズBBB-76）。
 *
 * @param flight 判定の飛行状態（そのまま。描く場所はここから導くだけ）
 * @param releaseHeight リリースの高さ（`armReleaseHeight`。MM-60）
 */
export function dekkaiPitchLook(
  flight: { x: number; z: number; vx: number; vz: number; stall?: PitchStall },
  releaseHeight: number = RELEASE_HEIGHT,
): DekkaiPitchLook {
  const z = flight.z;
  const riseAt = (zz: number): number =>
    dekkaiScreenRise({ y: pitchLineHeight(zz, releaseHeight), z: zz });
  // 区間ごとに「画面の縦の位置が時間（＝z）に比例する」ように置き直す
  const [from, to] = z <= CONTACT_PLANE_Z ? [RELEASE_Z, CONTACT_PLANE_Z] : [CONTACT_PLANE_Z, CATCH_Z];
  const p = Math.max(0, Math.min(1, (z - from) / (to - from)));
  const rise = riseAt(from) + (riseAt(to) - riseAt(from)) * p;
  const zd = lineDepthForRise(rise, releaseHeight);
  // 横はいまの速度のまま、置き直した奥行きまで外挿する（曲がる球も通り道の上に乗る）
  const xd = flight.vz > 0 ? flight.x + (flight.vx * (zd - z)) / flight.vz : flight.x;
  // 高さは通り道の直線。フォークは手元で地面へ落ちていく（BBB-77。`pitchDrawnHeight`）
  const center = { x: xd, y: pitchDrawnHeight(zd, z, releaseHeight, flight.stall), z: zd };
  const progress = (z - RELEASE_Z) / (CATCH_Z - RELEASE_Z);
  const size = progress < DEKKAI_PITCH_SIZE_SWITCH ? DEKKAI_PITCH_SIZE_FAR : DEKKAI_PITCH_SIZE_NEAR;
  // 影：地面の円を、見下ろす角度で潰れたぶん奥行きの向きに伸ばす（縦横比を原作に揃える）
  const ground = { x: xd, y: 0, z: zd };
  const toCamera = Math.hypot(DEKKAI_CAMERA_POS.y, zd - DEKKAI_CAMERA_POS.z);
  const sinLook = DEKKAI_CAMERA_POS.y / Math.max(toCamera, 1e-6);
  return {
    center,
    scale: dekkaiBallScale(center) * size,
    shadow: {
      x: xd,
      z: zd,
      scale: dekkaiBallScale(ground) * size,
      depthStretch: DEKKAI_SHADOW_ASPECT / Math.max(sinLook, 1e-3),
    },
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
