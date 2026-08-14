/**
 * 背景（空と遠景）の配置計算（フェーズE-25-(d) の2段目）。
 *
 * ここには**Three.jsに依存しない計算だけ**を置く（`core/stands.ts`・`core/camera.ts` と
 * 同じ立て方）。部品そのものは `entities/stadium.ts` が glTF から供給し、実際に並べるのは
 * `scenes/field.ts`。
 *
 * 設計の要点：
 * - **遠景の置き場所もスタンドから導出する**（`standOuterRadius`）。C-14の不変条件
 *   「見えている壁と当たる壁が同じ数値から起きる」を、E-25-(d) がスタンドまで延長したのと
 *   同じやり方で、さらに外側の景色まで延長する＝**球場を足すときに書くのは従来どおり
 *   説明書の2つの数値（センター・両翼）だけ**で、遠景は勝手に付いてくる。
 * - **空と遠景の地面は「世界の端」を消すためにある**。E-25-(d) までは、スタンドの上が
 *   一様な背景色で、低いスタンドの球場（かせんじき6段・だいそうげん5段）では
 *   **描かれた地面（`GROUND_RADIUS`=175m）の縁がそのまま地平線として見えていた**。
 *   ドーム（`SKY_RADIUS`）が上を、遠景の地面（`FAR_GROUND_RADIUS`）が下を覆う。
 * - **散らしに乱数を使わない**（連番から決まる）。⑧ローグライトの「本編の乱数は消費しない」と
 *   衝突しないだけでなく、毎回同じ絵になる＝スクリーンショットで比べられる。
 */
import { type Ballpark } from './ballpark';
import { standOuterRadius } from './stands';

const DEG = Math.PI / 180;

/**
 * 空のドームの半径 m。**でっかいモードのカメラの far（`DEKKAI_CAMERA_FAR`）の内側**に
 * 収める（カメラは本塁の後ろ 10m ほど）。ちっちゃいモードは far=1000 なので余る。
 */
export const SKY_RADIUS = 420;

/**
 * ドームが水平線より下へどれだけ回り込んでいるか（度。`assets-src/stadium.blend` の
 * `SkyDome` と一致させる）。**視界にすきまを作らない条件がこれ**：
 *
 * カメラ（高さ h）から下向き傾き s で出た視線は、`h/s` の距離で地面に当たる。
 * `h/s < SKY_RADIUS` なら**地面が先**（＝ドームより手前なので地面が見える）、
 * それより浅い視線は**必ずドームに当たる**（ドームは閉じた殻なので、下の縁より上へ
 * 出ていく視線は逃げ場がない）。つまり
 * **地平線＝`atan(h / SKY_RADIUS)` のところで地面と空が接する**。
 * 下の縁を水平線より下げてあるのは、その接点の丸め誤差でも背景色が覗かないための保険。
 */
export const SKY_SKIRT_DEG = 4;

/**
 * 遠景の地面の半径 m。上の理屈から**見えるのは `SKY_RADIUS` までで足りる**が、
 * カメラが高いとき（ちっちゃいモードは 47m ほど）に地面が先に尽きないよう
 * ドームより外まで敷いておく。上限はでっかいモードのカメラの far。
 */
export const FAR_GROUND_RADIUS = 480;

/**
 * `FarGround` 部品の内側の穴の割合（`assets-src/stadium.blend` と一致させる）。
 * 穴の半径 158m が既存の地面（`GROUND_RADIUS`=175m）より内側にあるので、
 * **2枚が重なって継ぎ目ができない**。
 */
export const FAR_GROUND_INNER_RATIO = 0.33;

/** 遠景の地面を既存の地面より下に置く量 m（Zファイティング避け。地面は -0.02） */
export const FAR_GROUND_Y = -0.06;

/** 遠景をスタンドの最後列からどれだけ外に置くか m（これより内側には置かない） */
export const SKYLINE_MARGIN = 6;

/** 遠景の1つを置く場所 */
export interface SkylineSpot {
  x: number;
  z: number;
  /** ヨー（ラジアン）。**+Z がフィールドを向く**＝部品の正面と一致する（`RingSegment` と同じ約束） */
  yaw: number;
  /** 本塁からの距離 m */
  radius: number;
  /** 方角（度。0=センター / +45=ライト線） */
  deg: number;
  /** 0..1 の散らし（連番から決まる＝乱数を使わない）。大きさ・色の振り分けに使う */
  variation: number;
}

/**
 * 連番から決まる 0..1 の散らし。`scenes/field.ts` の `crowdHash`（観客の散らし）と同じ
 * 考え方で、**乱数を使わずに毎回同じ絵**を作る。
 */
export function skylineHash(i: number, salt = 0): number {
  const h = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return h - Math.floor(h);
}

/**
 * その球場で遠景を置きはじめてよい距離 m（スタンドの最後列の外側）。
 * **段数で変わる**ので、低いスタンドの球場（かせんじき・だいそうげん）では遠景が近くに寄り、
 * 大きいスタンドの球場（どうむ18段）では遠くへ下がる＝スタンドに埋もれない。
 */
export function skylineBaseRadius(park: Ballpark, rows: number): number {
  return standOuterRadius(park, rows) + SKYLINE_MARGIN;
}

export interface SkylineRingOptions {
  /** 基準の距離からさらに外へ置く量 m */
  offset?: number;
  /** 距離の散らし m（0..spread のあいだで個体ごとに散る） */
  spread?: number;
  /** 方角の範囲（度）。省略すると全周に等間隔で並べる */
  fromDeg?: number;
  toDeg?: number;
  /** 方角の散らし（区画の幅に対する割合 0..1）。全周のときだけ効く */
  jitter?: number;
  /** 散らしの系列を分ける（同じ球場に2種類並べても同じ形にならないように） */
  salt?: number;
}

/**
 * 遠景を並べる場所の一覧。全周（既定）なら等間隔＋わずかな散らし、方角の範囲を
 * 指定すればその区間だけに並べる。
 *
 * **返る距離は必ず `baseRadius` 以上**（＝スタンドの外）で、**`FAR_GROUND_RADIUS` 未満**
 * （＝描かれた地面の上に立つ）。この2つは `tests/horizon.test.ts` が6球場で固定する。
 */
export function skylineSpots(
  baseRadius: number,
  count: number,
  opts: SkylineRingOptions = {},
): SkylineSpot[] {
  const { offset = 0, spread = 0, fromDeg, toDeg, jitter = 0.5, salt = 0 } = opts;
  const spots: SkylineSpot[] = [];
  if (count <= 0) return spots;
  const whole = fromDeg === undefined || toDeg === undefined;
  const from = whole ? -180 : fromDeg;
  const to = whole ? 180 : toDeg;
  const step = (to - from) / count;
  for (let i = 0; i < count; i += 1) {
    // 全周は「区画の中央」に置いて散らす／範囲指定は端から端まで均等に置く
    const center = whole ? from + (i + 0.5) * step : count === 1 ? (from + to) / 2 : from + i * step;
    const deg = center + (whole ? (skylineHash(i, salt) - 0.5) * step * jitter : 0);
    const radius = baseRadius + offset + skylineHash(i, salt + 11) * spread;
    const t = deg * DEG;
    spots.push({
      x: radius * Math.sin(t),
      z: -radius * Math.cos(t),
      yaw: -t,
      radius,
      deg,
      variation: skylineHash(i, salt + 29),
    });
  }
  return spots;
}

/**
 * 全周に途切れなく並べるときの1つあたりの幅 m（山並みのように「つながって見えたい」もの）。
 * 弦の長さそのものだと丸め誤差で継ぎ目が開くので、`STAND_STEP_DEG` の区画と同じく
 * わずかに重ねる（`scenes/field.ts` の `SECTION_OVERLAP` と同じ考え方）。
 */
export function wrapWidth(radius: number, count: number, overlap = 1.15): number {
  return ((2 * Math.PI * radius) / count) * overlap;
}

/**
 * 遠景1種類ぶんの指定（**大きさの決め方だけ**。どの部品を使うか・何色かは見た目の話なので
 * `scenes/field.ts` の表が持つ）。高さも幅も同じ `variation` から補間するので、
 * **1つの個体の縦横の比率は崩れない**（別々に散らすと、細長い木や平たいビルが混ざる）。
 */
export interface SkylineItem extends SkylineRingOptions {
  count: number;
  /** 高さ m（[最小, 最大]） */
  height: [number, number];
  /**
   * 幅 m（[最小, 最大]）。`'wrap'` は**全周に途切れなくつながる幅**を距離から計算する
   * （山並みのように、切れ目が見えると困るもの）。
   */
  width: [number, number] | 'wrap';
  /** 奥行き＝幅×この倍率（遠くから見るので、silhouette を壊さない程度の厚みでよい） */
  depthRatio: number;
}

/** 遠景1つの置き場所と大きさ */
export interface SkylinePlacement extends SkylineSpot {
  width: number;
  height: number;
  depth: number;
  /** 左右を反転するか（`'wrap'` のときだけ。同じ部品の繰り返しが読めないように） */
  flip: boolean;
}

function lerp(range: readonly [number, number], t: number): number {
  return range[0] + (range[1] - range[0]) * t;
}

/**
 * 遠景1種類ぶんの置き場所と大きさ。**距離は必ず `baseRadius` 以上**（＝スタンドの外）で、
 * **`SKY_RADIUS` 未満**（＝空のドームの内側に立つ）。これは `tests/horizon.test.ts` が
 * 6球場×全項目で固定する。
 */
export function skylinePlan(baseRadius: number, item: SkylineItem): SkylinePlacement[] {
  return skylineSpots(baseRadius, item.count, item).map((spot) => {
    const width =
      item.width === 'wrap' ? wrapWidth(spot.radius, item.count) : lerp(item.width, spot.variation);
    return {
      ...spot,
      width,
      height: lerp(item.height, spot.variation),
      depth: width * item.depthRatio,
      flip: item.width === 'wrap' && spot.variation < 0.5,
    };
  });
}
