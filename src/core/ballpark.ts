/**
 * 球場（フェーズC-14。説明書p24-25「グランドの紹介」の6球場）。
 *
 * 従来のフェンスは `FENCE_RADIUS=100` / `FENCE_HEIGHT=4` の**円1つ**で、打球物理・
 * フェンスの描画・カメラの可動範囲がその2つの定数を共有していた。原作の6球場は
 * センターと両翼で距離が違い（110〜130m / 85〜110m）、いびつな形・高いレフトフェンス・
 * ラッキーゾーンといった非対称も持つので、**「方角→フェンスの距離と高さ」を返す関数**に
 * 一般化する（2026-07-25 ユーザー判断）。
 *
 * 設計の要点：
 * - **判定の形は変えない**。打球物理は `r >= FENCE_RADIUS` が
 *   `r >= fenceAt(park, 方角).distance` になるだけで、跳ね返りの法線（半径方向）も
 *   越えの判定（高さ比較）も従来のまま。
 * - **説明書の数値（センター/両翼）だけを持ち、間は円弧で埋める**。フェンスは
 *   「本塁の先にある点を中心とする円弧」としてモデル化するので、2つの数値から
 *   形が一意に決まる（`fenceArcDistance`）＝球場を足すときに書くのは説明書に
 *   載っている2つの数字だけで済む。
 * - **球場ごとの癖は「区間（FenceSector）」の例外表**で表す。区間を持たない球場は
 *   きれいな円弧のままで、ふえいふえいの「いびつな形＋高いレフトフェンス」も
 *   たからづかのラッキーゾーンも同じ1つの仕組みで書ける。描画（scenes/field.ts）も
 *   同じ関数から形を起こすので、**見た目と判定がずれることが構造的に起きない**
 *   （B-9で打席の立ち位置と死球ゾーンを同じ定数から求めたのと同じ整理）。
 * - **距離は説明書の実寸をそのまま使う**（2026-07-25 ユーザー判断）。従来の
 *   「円形100m一律」に対してセンターは遠く・両翼は近くなるので、球場を選ぶことが
 *   そのままHRの出やすさの選択になる。
 *
 * 座標系は batting.ts / field.ts と同一（本塁原点、外野=-Z、+X=一塁側＝ライト方向）。
 */
import type { HitType } from './rules';

export type BallparkId =
  | 'tokorozawa'
  | 'fueifuei'
  | 'kasenjiki'
  | 'takarazuka'
  | 'doumu'
  | 'daisougen';

/** 標準的なフェンスの高さ（区間で上書きしない球場・方角はこの高さ） */
export const FENCE_HEIGHT_STANDARD = 4;

/** フェンスを持つ方角の範囲（度）。±45°＝両翼線。これを超える方角は両翼線と同じ扱い */
export const FENCE_ANGLE_LIMIT_DEG = 45;

/** ある方角でのフェンスの断面 */
export interface FenceAt {
  /** 本塁からフェンスまでの距離 m */
  distance: number;
  /** フェンスの高さ m（これを超えた打球が場外＝本塁打） */
  height: number;
}

/**
 * 基準の円弧からの例外を持つ方角の区間（球場ごとの癖はすべてこれで表す）。
 * 方角は度で -45=レフト線 / 0=センター / +45=ライト線。
 * **最初に一致した区間が勝つ**（重ねて書いたときの優先順位を並び順で決められる）。
 */
export interface FenceSector {
  fromDeg: number;
  toDeg: number;
  /** 基準の円弧からの距離の増減 m（+で深く、-で手前に張り出す） */
  offset: number;
  /** この区間のフェンスの高さ m */
  height: number;
}

export interface Ballpark {
  id: BallparkId;
  /** 選択画面に出す球場名（説明書p24-25の表記） */
  name: string;
  /** センターまでの距離 m（説明書の数値） */
  center: number;
  /** 両翼までの距離 m（説明書の数値） */
  wing: number;
  /** 両翼が説明書に載っていない（だいそうげんだけ「不明」）＝こちらで決めた数値 */
  wingIsOurs?: boolean;
  /** 選択画面に出す説明書の紹介文（要約） */
  note: string;
  /** 基準の円弧からの例外。空なら左右対称のきれいな形 */
  sectors: readonly FenceSector[];
  /**
   * ラッキーゾーン（たからづか）。**距離はすでに center/wing に織り込んである**
   * （説明書の119m/91mが「ラッキーゾーンを含めた広さ」＝実際にHRになる距離）ので、
   * ここに持つのは「その内側の柵の外にもう1枚壁がある」という見た目の情報だけ。
   * 打撃に効くのは区間で下げたフェンスの高さのほう（低い柵＝ライナーでも越える）。
   */
  luckyZone: { fromDeg: number; outerOffset: number } | null;
  /**
   * これ以上の距離でボールが止まると**ランニングホームラン**（だいそうげん。説明書p25
   * 「外野手がボールを後ろにそらすと致命的、球はテンテン転がって、あっという間に
   * ランニングホームランとなってしまいます」）。持たない球場は null。
   */
  runningHomerDistance: number | null;
  /**
   * 空の色（屋根付きのどうむだけ屋内の天井色にする）。
   *
   * **E-25-(d) の2段目からは「地平線の色」を指す**：空はドーム（`SkyDome`）になり、
   * 頂点色のグラデーション（地平線=1.0 → 天頂=深い青）にこの色を掛けるので、
   * **天頂の色はここから導出される**（別に持たない＝⑥「表示はレーティングからの導出」と
   * 同じ整理）。`scene.background` にも引き続きこの色を使うので、ドームで覆いきれない
   * 隅があっても地平線の色と地続きになる。
   */
  skyColor: number;
}

const DEG = Math.PI / 180;
/**
 * 屋外の空（地平線の色）。E-25-(d) の2段目までは `0x101820`（ほぼ黒）を画面全体に
 * 敷いていたが、**空がドームになって階調を持てるようになった**ので昼の空にした
 * （それまでは照明の無いナイターのような画で、緑の芝生と釣り合っていなかった）。
 */
const SKY_OUTDOOR = 0xa9c7e2;

/**
 * センターと両翼の2つの数値だけからフェンスの形を決める。
 *
 * フェンスを「本塁の先 d の点を中心とする半径 R の円弧」とみなすと、本塁から方角θへ
 * 伸ばした線がその円と交わる距離は `d·cosθ + √(R² - d²sin²θ)` になる。
 * θ=0 で d+R=センター、θ=45° で両翼、の2式を解くと d と R が一意に決まる：
 *   d = (C² - W²) / (2C - √2·W)、R = C - d
 * 実在の球場と同じく中間（左中間・右中間）がいちばん深くなり、両翼へ向かって
 * なだらかに詰まる形になる（ところざわ 120/95 なら左中間は約113m）。
 */
export function fenceArcDistance(center: number, wing: number, deg: number): number {
  const d = (center * center - wing * wing) / (2 * center - Math.SQRT2 * wing);
  const r = center - d;
  const t = clampAngleDeg(deg) * DEG;
  const s = d * Math.sin(t);
  return d * Math.cos(t) + Math.sqrt(Math.max(0, r * r - s * s));
}

/** 方角を両翼線の内側へ丸める（ファウル地域の打球も両翼線と同じフェンスに当たる） */
export function clampAngleDeg(deg: number): number {
  return Math.max(-FENCE_ANGLE_LIMIT_DEG, Math.min(FENCE_ANGLE_LIMIT_DEG, deg));
}

/**
 * 打球の位置から方角（度）を求める。0=センター / +45=ライト線（一塁側） /
 * -45=レフト線（三塁側）。本塁より後ろ（+Z）の点も両翼線の外として丸められる。
 */
export function fenceAngleDeg(x: number, z: number): number {
  return clampAngleDeg((Math.atan2(x, -z) * 180) / Math.PI);
}

/** その方角のフェンス（距離と高さ）。球場の癖はここに集約される */
export function fenceAt(park: Ballpark, deg: number): FenceAt {
  const d = clampAngleDeg(deg);
  const sector = park.sectors.find((s) => d >= s.fromDeg && d <= s.toDeg);
  return {
    distance: fenceArcDistance(park.center, park.wing, d) + (sector?.offset ?? 0),
    height: sector?.height ?? FENCE_HEIGHT_STANDARD,
  };
}

/** その地点の方角のフェンス（`fenceAt(park, fenceAngleDeg(x, z))` の省略形） */
export function fenceAtPoint(park: Ballpark, x: number, z: number): FenceAt {
  return fenceAt(park, fenceAngleDeg(x, z));
}

/**
 * その球場でいちばん深いフェンスまでの距離（芝生の広さ・カメラの可動範囲を決めるのに使う）。
 * 区間の例外で中間が張り出す球場（ふえいふえい）があるので、実際に走査して求める。
 */
export function deepestFence(park: Ballpark): number {
  let max = 0;
  for (let deg = -FENCE_ANGLE_LIMIT_DEG; deg <= FENCE_ANGLE_LIMIT_DEG; deg += 0.5) {
    max = Math.max(max, fenceAt(park, deg).distance);
  }
  return max;
}

/**
 * 守備が誰も拾えないまま止まった打球を距離で単打/二塁打/三塁打に分類するときの境界 m
 * （chicchaiScene.ts の decideFallback から移設）。
 *
 * **球場の広さでは動かさない**：この境界が表しているのは「野手の定位置からどれだけ
 * 後ろへ抜けたか」で、野手のホームポジション（fielding.ts の FIELDER_HOME_POSITIONS。
 * 外野は約80m）は球場によらず同じだから。広い球場ほど同じ打球が遠くまで転がる＝
 * 長打になりやすい、という差はこの固定の境界のほうから自然に出る
 * （説明書のどうむ「俊足選手の多いチームにチャンス」）。
 */
export const FALLBACK_SINGLE_MAX = 75;
export const FALLBACK_DOUBLE_MAX = 90;

/**
 * 止まった打球の距離による帰結。だいそうげんだけ、外野手が後ろへそらして
 * ボールが場内の奥深くまで転がるとランニングホームランになる（説明書p25）。
 */
export function fallbackHit(park: Ballpark, x: number, z: number): HitType {
  const dist = Math.hypot(x, z);
  if (park.runningHomerDistance !== null && dist >= park.runningHomerDistance) {
    return 'homerun';
  }
  if (dist < FALLBACK_SINGLE_MAX) return 'single';
  if (dist < FALLBACK_DOUBLE_MAX) return 'double';
  return 'triple';
}

/**
 * 6球場（説明書p24-25）。センター/両翼の数値は説明書のとおり。
 * **球場名は原作の表記をそのまま使う**：球団名・選手名と違って実在の球団・選手を
 * 指すものではなく、原作の球場名自体が実在の球場をもじった架空の地名だから
 * （B-12で球団名・選手名を独自にした理由＝他社の著作物である名称を避ける、には当たらない）。
 */
export const BALLPARKS: readonly Ballpark[] = [
  {
    id: 'tokorozawa',
    name: 'ところざわ',
    center: 120,
    wing: 95,
    note: 'ヒロカラズ セマカラズ モットモ ヘイキンテキ',
    sectors: [],
    luckyZone: null,
    runningHomerDistance: null,
    skyColor: SKY_OUTDOOR,
  },
  {
    id: 'fueifuei',
    name: 'ふえいふえい',
    center: 120,
    wing: 96,
    note: 'イビツナ カタチ ト タカイ レフトフェンス',
    // いびつな形＝レフトからレフト中間だけが基準の円弧より6m張り出し、その区間に
    // 10mの壁が立つ（説明書「レフト方向のホームランは至難のワザ!?」）。両翼線
    // （-45°〜-40°）は区間の外に置いてあるので、説明書の両翼96mはそのまま残る＝
    // 壁の手前と奥で段差ができ、それがそのまま「いびつな形」になる。
    sectors: [{ fromDeg: -40, toDeg: -12, offset: 6, height: 10 }],
    luckyZone: null,
    runningHomerDistance: null,
    skyColor: SKY_OUTDOOR,
  },
  {
    id: 'kasenjiki',
    name: 'かせんじき',
    center: 110,
    wing: 85,
    note: 'トニカク セマイ ホームランノ カイカンニ ヨウナラ ココ',
    sectors: [],
    luckyZone: null,
    runningHomerDistance: null,
    skyColor: SKY_OUTDOOR,
  },
  {
    id: 'takarazuka',
    name: 'たからづか',
    center: 119,
    wing: 91,
    note: 'ラッキーゾーンアリ チョウダリョクノ チームニ ユウリ',
    // ラッキーゾーンの柵は外壁より低い＝ライナー性の打球でも越える（説明書
    // 「長打力のあるチームに有利か?」）。距離のほうはすでに119m/91mに
    // 織り込まれている（ところざわより両翼で4m近い＝「少し狭い感じ」）。
    sectors: [
      { fromDeg: -45, toDeg: -15, offset: 0, height: 2.5 },
      { fromDeg: 15, toDeg: 45, offset: 0, height: 2.5 },
    ],
    luckyZone: { fromDeg: 15, outerOffset: 9 },
    runningHomerDistance: null,
    skyColor: SKY_OUTDOOR,
  },
  {
    id: 'doumu',
    name: 'どうむ',
    center: 122,
    wing: 100,
    note: 'ヤネツキ トップクラスノ ヒロサ シュンソクノ チームニ チャンス',
    sectors: [],
    luckyZone: null,
    runningHomerDistance: null,
    // 屋根付き＝空が見えない。判定には効かないが、6球場で唯一ひと目で分かる違い
    // （E-25-(d)の2段目からはドームの天井の色になる。遠景も出さない＝屋内）
    skyColor: 0x565a66,
  },
  {
    id: 'daisougen',
    name: 'だいそうげん',
    center: 130,
    wing: 110,
    // 説明書は「センター推定130m／両翼不明」。両翼はこちらで決めた数値
    // （どうむの100mが「トップクラスの広さ」と紹介されている以上、それを上回る必要がある）
    wingIsOurs: true,
    note: 'トテツモナク ヒロイ ソラスト ランニングホームラン',
    // 低い板塀（説明書の写真）。距離が桁違いなので高さは効かない
    sectors: [{ fromDeg: -45, toDeg: 45, offset: 0, height: 3 }],
    luckyZone: null,
    // 外野の定位置（約80m）から35m以上後ろ＝完全にそらした打球だけが該当する
    runningHomerDistance: 115,
    skyColor: SKY_OUTDOOR,
  },
];

/** 起動直後（球場を選ぶ前）の既定の球場＝「最も平均的」なところざわ */
export const DEFAULT_BALLPARK_ID: BallparkId = 'tokorozawa';

export function ballparkById(id: BallparkId): Ballpark {
  const park = BALLPARKS.find((p) => p.id === id);
  if (!park) throw new Error(`unknown ballpark: ${id}`);
  return park;
}

export const DEFAULT_BALLPARK = ballparkById(DEFAULT_BALLPARK_ID);
