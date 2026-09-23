/**
 * ドット文字の描画ヘルパー（canvas。ブラッシュアップでフォントを DotGothic16 に替えた）。
 *
 * **16px格子のドットフォント（DotGothic16）を原寸の16pxでcanvasに描き、CSSで整数倍に
 * 拡大する**（image-rendering: pixelated）。原寸で描くので字の点が画素にぴったり乗り、
 * さらに**描いた字の半透明の縁を捨てる（二値化）**ので、拡大しても点がにじまない。
 * それまでは MS ゴシックを 8px で描いて3倍にしていた＝ビットマップを持たない大きさで
 * 描いていたので、字が潰れてにじんでいた（テストプレイ「フォントがイケてない」）。
 *
 * - **拡大率は整数倍だけ**（1=16px・2=32px・3=48px…）。中途半端な倍率はドットの幅が
 *   揃わなくなる（②「ドット絵の拡大はいつも整数倍」）。
 * - **縁取り（`outline`）**：背景の無いバナー（ホームラン!等）は3Dの画面の上に直接乗るので、
 *   1ドットの縁で字を画面から切り離す。
 * - **フォントは使う文字のぶんだけ後から読み込まれる**（日本語は120個の小分けファイル）。
 *   まだ読み込まれていない字を含む文字列は、いったん代わりの字で描いておき、読み込みが
 *   終わったら同じ文字列のままなら描き直す（`document.fonts.load`）。
 */

/** DotGothic16 の格子（=原寸の字の高さ）。拡大率はこれの整数倍 */
export const GLYPH_PX = 16;

/** 字の並び（DotGothic16 が無い字だけ次のフォントで描かれる） */
export const PIXEL_FONT_FAMILY = '"DotGothic16", "MS Gothic", "ＭＳ ゴシック", monospace';

export interface PixelLabelOptions {
  color?: string;
  /** 整数倍の拡大率（1=16px）。既定1 */
  scale?: number;
  paddingX?: number;
  paddingY?: number;
  /** 行間（原寸のpx）。既定20＝字の高さ16＋4 */
  lineHeight?: number;
  align?: 'left' | 'center';
  /** 1ドットの縁取りの色（背景の無いバナー用）。省略すると縁取りなし */
  outline?: string | null;
}

export interface PixelLabel {
  el: HTMLCanvasElement;
  /** overrides を渡すと以後の描画スタイルを恒久的に更新する（バナーの色/拡大率の出し分け等に使う） */
  setText(text: string, overrides?: Partial<PixelLabelOptions>): void;
}

const DEFAULTS: Required<PixelLabelOptions> = {
  color: '#f8f8f8',
  scale: 1,
  paddingX: 6,
  paddingY: 4,
  lineHeight: 20,
  align: 'left',
  outline: null,
};

const FONT = `${GLYPH_PX}px ${PIXEL_FONT_FAMILY}`;

/**
 * 画面全体の拡大率（整数）。**字は原寸16pxの整数倍でしか描かない**ので、大きな画面
 * （フルHDの全画面など）では全体を2倍にして、画面に対する文字の大きさを保つ。
 * 窓の大きさが変わって倍率が切り替わったら、作ったラベルをすべて描き直す。
 */
let globalScale = computeUiScale();
/**
 * 作ったラベルの控え（**弱参照**＝采配メニュー等は開くたびにラベルを作るので、
 * 強く持つと画面から外れたラベルが溜まり続ける）。描き直しの手順はラベルの canvas に
 * 紐づけて持つ（canvas が回収されれば手順も一緒に消える）。
 */
const liveLabels = new Set<WeakRef<HTMLCanvasElement>>();
const redrawOf = new WeakMap<HTMLCanvasElement, () => void>();

function computeUiScale(): number {
  if (typeof window === 'undefined') return 1;
  return window.innerWidth >= 1700 && window.innerHeight >= 860 ? 2 : 1;
}

/**
 * DOMで組む画面（チーム選択など）も同じ倍率で字を描けるよう、CSS変数 `--ui-scale` に
 * 写しておく（`font-size: calc(16px * var(--ui-scale))`）。
 */
function publishUiScale(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty('--ui-scale', String(globalScale));
}

if (typeof window !== 'undefined') {
  publishUiScale();
  window.addEventListener('resize', () => {
    const next = computeUiScale();
    if (next === globalScale) return;
    globalScale = next;
    publishUiScale();
    for (const ref of liveLabels) {
      const el = ref.deref();
      if (!el) {
        liveLabels.delete(ref);
        continue;
      }
      redrawOf.get(el)?.();
    }
  });
}

/** いまの画面全体の拡大率（DOMで組む画面が文字の大きさを揃えるのに使う） */
export function uiScale(): number {
  return globalScale;
}

/** 字の縁の半透明をどこで切るか（0..255）。これより薄い画素は捨て、濃い画素は塗りつぶす */
const ALPHA_CUT = 110;

/**
 * よく使う字（英数・かな・記号）を先に読み込んでおく。**タイトル画面を出す前に1回だけ
 * await する**（main.ts）＝最初の画面から代わりの字で描かれることがない。漢字は使う分だけ
 * 後から読み込まれる（`setText` が描き直す）。
 */
export async function preloadPixelFont(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  const sample =
    ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~' +
    'ぁあぃいぅうぇえぉおかがきぎくぐけげこごさざしじすずせぜそぞただちぢっつづてでとどなにぬねのはばぱひびぴふぶぷへべぺほぼぽまみむめもゃやゅゆょよらりるれろわをん' +
    'ァアィイゥウェエォオカガキギクグケゲコゴサザシジスズセゼソゾタダチヂッツヅテデトドナニヌネノハバパヒビピフブプヘベペホボポマミムメモャヤュユョヨラリルレロワヲンヴー' +
    '、。・「」（）！？：／＝＋－■□●○◆▶▲▼★☆←→↑↓　';
  try {
    await document.fonts.load(FONT, sample);
  } catch {
    // 読み込めなくても代わりのフォントで描ける（ゲームは止めない）
  }
}

function fontReady(text: string): boolean {
  if (typeof document === 'undefined' || !document.fonts) return true;
  try {
    return document.fonts.check(FONT, text);
  } catch {
    return true;
  }
}

export function createPixelLabel(initialText: string, opts: PixelLabelOptions = {}): PixelLabel {
  const o = { ...DEFAULTS, ...opts };
  const canvas = document.createElement('canvas');
  canvas.style.imageRendering = 'pixelated';
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  /** いま出している文字列と見た目（同じなら描き直さない＝毎フレーム呼ばれても軽い） */
  let drawnKey = '';
  let currentText = initialText;

  function draw(text: string): void {
    const scale = Math.max(1, Math.round(o.scale)) * globalScale;
    const key = `${text}\u0000${o.color}\u0000${scale}\u0000${o.align}\u0000${o.outline}\u0000${o.lineHeight}`;
    if (key === drawnKey) return;
    const lines = text.split('\n');
    ctx.font = FONT;
    let maxWidth = 0;
    for (const line of lines) maxWidth = Math.max(maxWidth, ctx.measureText(line).width);
    const edge = o.outline ? 1 : 0;
    const width = Math.max(1, Math.ceil(o.paddingX * 2 + maxWidth + edge * 2));
    const height = Math.max(1, Math.ceil(o.paddingY * 2 + lines.length * o.lineHeight + edge * 2));
    // canvas.width/height の変更は描画バッファとフォント等の状態をリセットするので、
    // リサイズ後に設定し直す
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = `${width * scale}px`;
    canvas.style.height = `${height * scale}px`;
    ctx.clearRect(0, 0, width, height);
    ctx.font = FONT;
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'top';
    ctx.textAlign = o.align === 'center' ? 'center' : 'left';
    const x = o.align === 'center' ? Math.round(width / 2) : o.paddingX + edge;
    // 字の高さ16に対して行の高さは20：上に2ドット空けて字を置く（字の点が格子に乗る）
    const top = o.paddingY + edge + Math.round((o.lineHeight - GLYPH_PX) / 2);
    lines.forEach((line, i) => ctx.fillText(line, x, top + i * o.lineHeight));
    binarize(ctx, width, height, o.color, o.outline);
    drawnKey = key;
  }

  function render(text: string): void {
    currentText = text;
    draw(text);
    if (!fontReady(text)) {
      // まだ読み込まれていない字がある：読み込み後、同じ文字列のままなら描き直す
      document.fonts.load(FONT, text).then(
        () => {
          if (currentText !== text) return;
          drawnKey = '';
          draw(text);
        },
        () => {},
      );
    }
  }

  render(initialText);
  redrawOf.set(canvas, () => {
    drawnKey = '';
    draw(currentText);
  });
  liveLabels.add(new WeakRef(canvas));

  return {
    el: canvas,
    setText(text, overrides) {
      if (overrides) Object.assign(o, overrides);
      render(text);
    },
  };
}

/**
 * 描いた字を**二値化して色を塗る**（＋必要なら1ドットの縁取り）。半透明の縁が残ると、
 * 整数倍に拡大したときに点が灰色ににじむ。
 */
function binarize(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  color: string,
  outline: string | null,
): void {
  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i += 1) mask[i] = data[i * 4 + 3] >= ALPHA_CUT ? 1 : 0;
  const [r, g, b] = parseColor(color);
  const out = outline ? parseColor(outline) : null;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const p = i * 4;
      if (mask[i]) {
        data[p] = r;
        data[p + 1] = g;
        data[p + 2] = b;
        data[p + 3] = 255;
        continue;
      }
      if (out && touches(mask, width, height, x, y)) {
        data[p] = out[0];
        data[p + 1] = out[1];
        data[p + 2] = out[2];
        data[p + 3] = 255;
        continue;
      }
      data[p + 3] = 0;
    }
  }
  ctx.putImageData(image, 0, 0);
}

/** 周り8ドットのどれかが字か（縁取りを置く場所） */
function touches(mask: Uint8Array, w: number, h: number, x: number, y: number): boolean {
  for (let dy = -1; dy <= 1; dy += 1) {
    const yy = y + dy;
    if (yy < 0 || yy >= h) continue;
    for (let dx = -1; dx <= 1; dx += 1) {
      const xx = x + dx;
      if (xx < 0 || xx >= w || (dx === 0 && dy === 0)) continue;
      if (mask[yy * w + xx]) return true;
    }
  }
  return false;
}

const colorCache = new Map<string, [number, number, number]>();

/** '#rrggbb' / '#rgb' を [r,g,b] に（HUDの色はすべてこの形で書いてある） */
function parseColor(color: string): [number, number, number] {
  const cached = colorCache.get(color);
  if (cached) return cached;
  let hex = color.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const n = parseInt(hex.slice(0, 6), 16);
  const rgb: [number, number, number] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  colorCache.set(color, rgb);
  return rgb;
}
