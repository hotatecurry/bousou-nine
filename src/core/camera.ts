/**
 * ちっちゃいモードの追従カメラ（フェーズE-24）。原作の「ちっちゃいモード」は打球・走者に
 * 寄った画面がボールを追ってスクロールする。従来はフィールド全体を1画面に収めた固定鳥瞰で、
 * 選手が数ピクセルにしか見えず守備の手応えが薄かった（ファインプレイの跳躍が見た目で
 * ほぼ分からない一因でもある）。
 *
 * ここには**Three.jsに依存しない計算だけ**を置く（カメラの置き場所・追従・追従点の
 * クランプ・画面外マーカーの位置）。実際のカメラ操作は scenes/chicchaiScene.ts の
 * リグが、画面外マーカーの描画は ui/hud が担う。
 *
 * 設計の要点：
 * - **寄り具合は「地面に映る横幅の半分」1つの値で決める**（CHICCHAI_VIEW_HALF_WIDTH）。
 *   カメラの高さ・引きはそこから毎フレーム導出するので、**画面のアスペクト比が変わっても
 *   映るメートル数が変わらない**（ウィンドウを細くしても寄り具合は同じ）。テンポの値を
 *   core/tempo.ts に集約したのと同じ理由で、調整したくなるのはこの1つだけになる。
 * - **追従は指数的な追いつき**（時定数 CAMERA_FOLLOW_TAU）。速い打球ではわずかに遅れて
 *   ボールが画面中心より先に出るので、スクロールしている感じが出る。
 */
import type { Vec2 } from './fielding';

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
