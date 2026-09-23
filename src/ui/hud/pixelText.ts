/**
 * ドット文字の描画ヘルパー（canvas。ブラッシュアップでフォントを DotGothic16 に替えた）。
 *
 * ## 字の点を「点の中心」で拾う（フェーズWW-71。テストプレイ「漢字がにじむ」）
 *
 * VV-70 は **16pxで描いて半透明の縁を捨てる（二値化）**方式だったが、実測すると
 * **DotGothic16 の輪郭は画素の格子に乗っていない**：点の格子は 1em=16点（62.5単位）だが、
 * 格子の境目が**点の真ん中（31.25単位）にずれて**いて、しかも1本の線が約1.17点ぶんの太さで
 * 描かれている（fontTools で輪郭を読んで確認）。16pxで描くと**すべての点が2画素にまたがって
 * 半分ずつ塗られ**、二値化で両方とも塗りつぶされる＝**線が2倍の太さになり、画数の多い漢字
 * （威嚇・貫禄…）が黒い塊になっていた**。
 *
 * そこで**4倍の大きさ（64px）で描いてから、点の格子の中心だけを拾う**。点の中心がどこに
 * 来るかは描いてみて決める（`calibrate`：ずらし方を総当たりして、拾った値が
 * 「真っ黒でも真っ白でもない」曖昧な点がいちばん少ない位置を採る）＝フォントの寸法を
 * 書き写さない。線の太さが1.17点でも、中心を拾う限り1点は1画素になる。
 *
 * ## 拡大は「端末の画素」で整数倍
 *
 * Windows の表示倍率（125%・150%）では CSS の1pxが端末の1.25・1.5画素になるので、
 * CSSで整数倍に拡大しても**端末の画素では整数倍にならず、点の幅が不揃いになっていた**。
 * いまは**端末の画素で何倍に描くかを先に整数で決め**（`deviceScale`）、CSSの大きさは
 * そこから割り戻す（`uiScale` は CSS px/点 で、1.25倍の画面なら 0.8 のような端数になる）。
 * 倍率の段は端末の画素数から決める（1700×860 以上で2倍…＝従来の段を端末の画素に移しただけ）
 * ので、**画面に対する字の大きさは同じ解像度の画面と揃う**。
 *
 * - **拡大率は整数倍だけ**（`scale`×`deviceScale`）。中途半端な倍率はドットの幅が
 *   揃わなくなる（②「ドット絵の拡大はいつも整数倍」）。
 * - **縁取り（`outline`）・影（`shadows`）**：背景の無いバナー（ホームラン!等）は3Dの画面の
 *   上に直接乗るので、1ドットの縁で字を画面から切り離す。影はタイトル画面の題名と見出し用。
 * - **フォントは使う文字のぶんだけ後から読み込まれる**（日本語は120個の小分けファイル）。
 *   まだ読み込まれていない字を含む文字列は、いったん代わりの字で描いておき、読み込みが
 *   終わったら同じ文字列のままなら描き直す（`document.fonts.load`）。
 * - **DOMの文字は使わない**：ブラウザが描くDOMの文字は必ず縁がぼかされる（Windows の
 *   Chrome には切る手段が無い）。タイトル・チーム選択の画面もこの canvas で描く
 *   （`setPixelText`）。
 */

/** DotGothic16 の格子（=原寸の字の高さ）。拡大率はこれの整数倍 */
export const GLYPH_PX = 16;

/** 字の並び（DotGothic16 が無い字だけ次のフォントで描かれる） */
export const PIXEL_FONT_FAMILY = '"DotGothic16", "MS Gothic", "ＭＳ ゴシック", monospace';

export interface PixelShadow {
  /** ずらす量（点。右・下が正） */
  dx: number;
  dy: number;
  color: string;
}

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
  /** 影（点単位のずらしと色。先に書いたものほど奥） */
  shadows?: readonly PixelShadow[];
  /** 字と字の間に足す点の数（題名の字間） */
  letterSpacing?: number;
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
  shadows: [],
  letterSpacing: 0,
};

const FONT = `${GLYPH_PX}px ${PIXEL_FONT_FAMILY}`;

/**
 * 描き込みの倍率（超解像）。**4倍で描いて点の中心を拾う**ので、中心の位置の誤差は
 * 原寸で 1/4 画素以下に収まる（点の線は1点の真ん中を中心に±0.4点以上の余裕がある）。
 */
const SUPERSAMPLE = 4;
const HI_FONT = `${GLYPH_PX * SUPERSAMPLE}px ${PIXEL_FONT_FAMILY}`;
/**
 * 1行の中で、字の枠の上端から基準線（alphabetic）までの点の数。DotGothic16 は1字の
 * 高さ16点のうち基準線より上が約14.4点（`actualBoundingBoxAscent`）なので14に置き、
 * 端数は `calibrate` が拾う位置で吸収する。
 */
const BASELINE_IN_GLYPH = 14;
/** 1行を描く作業場の上下の余白（点）。字が枠から1点はみ出しても拾えるように */
const LINE_MARGIN = 2;

/**
 * 点の中心を拾う位置（高解像度の画素の境目の番号 0..SUPERSAMPLE-1）。x は字の原点から、
 * y は基準線から数える。`calibrate` が決めるまでは、実測したフォントの格子
 * （x＝原点ちょうど、y＝基準線ちょうど）を既定にしておく。
 */
let sampleAt = { x: 0, y: 0 };
let calibrated = false;

/**
 * 画面全体の拡大率（端末の画素で何倍に描くか。整数）。**字は原寸16pxの整数倍でしか
 * 描かない**ので、大きな画面では全体を2倍・3倍にして、画面に対する文字の大きさを保つ。
 * 窓の大きさや表示倍率が変わって倍率が切り替わったら、作ったラベルをすべて描き直す。
 */
let deviceScale = computeDeviceScale();
let dpr = currentDpr();
/**
 * 作ったラベルの控え（**弱参照**＝采配メニュー等は開くたびにラベルを作るので、
 * 強く持つと画面から外れたラベルが溜まり続ける）。描き直しの手順はラベルの canvas に
 * 紐づけて持つ（canvas が回収されれば手順も一緒に消える）。
 */
const liveLabels = new Set<WeakRef<HTMLCanvasElement>>();
const redrawOf = new WeakMap<HTMLCanvasElement, () => void>();

function currentDpr(): number {
  if (typeof window === 'undefined') return 1;
  return window.devicePixelRatio || 1;
}

/**
 * 端末の画素での段（1700×860 以上で2倍、2550×1290 以上で3倍、3400×1720 以上で4倍）。
 * VV-70 の「1700×860 以上で2倍」を**CSS の px から端末の画素へ移した**だけで、
 * 表示倍率100%の画面では従来とまったく同じ段になる。
 */
function computeDeviceScale(): number {
  if (typeof window === 'undefined') return 1;
  const ratio = currentDpr();
  const w = window.innerWidth * ratio;
  const h = window.innerHeight * ratio;
  return Math.max(1, Math.min(4, Math.floor(Math.min(w / 850, h / 430))));
}

/**
 * DOMで組む画面（チーム選択など）も同じ倍率で並べられるよう、CSS変数 `--ui-scale` に
 * 写しておく（`calc(16px * var(--ui-scale))`）。**値は CSS px/点**なので端数になりうる。
 */
function publishUiScale(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty('--ui-scale', String(uiScale()));
}

function redrawAll(): void {
  for (const ref of liveLabels) {
    const el = ref.deref();
    if (!el) {
      liveLabels.delete(ref);
      continue;
    }
    redrawOf.get(el)?.();
  }
}

function refreshScale(): void {
  const nextScale = computeDeviceScale();
  const nextDpr = currentDpr();
  if (nextScale === deviceScale && nextDpr === dpr) return;
  deviceScale = nextScale;
  dpr = nextDpr;
  publishUiScale();
  redrawAll();
}

if (typeof window !== 'undefined') {
  publishUiScale();
  // 窓の大きさの変化と、表示倍率の変化（ブラウザの拡大縮小・別の画面へ窓を移す）の両方で
  // 測り直す。表示倍率は resize を伴わないこともあるので matchMedia でも見張る。
  window.addEventListener('resize', refreshScale);
  const watchDpr = (): void => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(`(resolution: ${currentDpr()}dppx)`);
    const onChange = (): void => {
      mq.removeEventListener?.('change', onChange);
      refreshScale();
      watchDpr();
    };
    mq.addEventListener?.('change', onChange);
  };
  watchDpr();
}

/**
 * いまの画面全体の拡大率＝**CSS px で見た1点の大きさ**（DOMで組む画面が文字の大きさを
 * 揃えるのに使う）。端末の画素では必ず整数倍（`deviceScale`）で、CSS では端数になりうる。
 */
export function uiScale(): number {
  return deviceScale / dpr;
}

/**
 * よく使う字（英数・かな・記号）を先に読み込んでおく。**タイトル画面を出す前に1回だけ
 * await する**（main.ts）＝最初の画面から代わりの字で描かれることがない。漢字は使う分だけ
 * 後から読み込まれる（`setText` が描き直す）。読み込んだあと**点の中心の位置を測る**。
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
    await document.fonts.load(HI_FONT, CALIBRATION_TEXT);
  } catch {
    // 読み込めなくても代わりのフォントで描ける（ゲームは止めない）
  }
  calibrate();
  // 読み込みより前に作られたラベルがあれば、測った位置で描き直す
  redrawAll();
}

function fontReady(text: string): boolean {
  if (typeof document === 'undefined' || !document.fonts) return true;
  try {
    return document.fonts.check(FONT, text);
  } catch {
    return true;
  }
}

// ---- 描画の作業場（全ラベルで共有する1枚の高解像度 canvas） ----

let scratch: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
let measurer: CanvasRenderingContext2D | null = null;

function scratchContext(width: number, height: number): CanvasRenderingContext2D {
  if (!scratch) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    scratch = { canvas, ctx };
  }
  const { canvas, ctx } = scratch;
  if (canvas.width < width || canvas.height < height) {
    canvas.width = Math.max(canvas.width, width);
    canvas.height = Math.max(canvas.height, height);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.font = HI_FONT;
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  return ctx;
}

function measureContext(): CanvasRenderingContext2D {
  if (!measurer) {
    measurer = document.createElement('canvas').getContext('2d')!;
  }
  measurer.font = FONT;
  return measurer;
}

/** 1字の送り幅（点）。DotGothic16 は全角16・半角8の整数だが、代わりの字は端数になりうる */
function advanceOf(ctx: CanvasRenderingContext2D, ch: string): number {
  return Math.max(0, Math.round(ctx.measureText(ch).width));
}

/**
 * **DotGothic16 に無い字を自前の点で描く**（フェーズWW-71）。カーソルの `▶` はこのフォントに
 * 入っておらず、代わりの MS ゴシックが**半角（8点）**で描いていた＝`▶ ` と `　 ` の幅が
 * 8点ずれて、**カーソルのある行だけ左へずれていた**（打順の表・抽選・扉の画面すべて）。
 * 全角16点の枠の中に描くので、並びの幅の約束（`▶ `＝`　 `）がそのまま成り立つ。
 * 行は字の枠の上端から数える（基準線は14行目）。
 */
const CUSTOM_GLYPHS: Record<string, readonly string[]> = {
  '▶': triangleRows(false),
  '◀': triangleRows(true),
};

/** 横向きの三角（高さ11点・幅6点。▲と同じくらいの重さ） */
function triangleRows(left: boolean): string[] {
  const rows: string[] = [];
  for (let r = 0; r < GLYPH_PX; r += 1) {
    const k = r - 3;
    const width = k < 0 || k > 10 ? 0 : 6 - Math.abs(k - 5);
    let row = '';
    for (let c = 0; c < GLYPH_PX; c += 1) {
      const inside = left ? c <= 12 && c > 12 - width : c >= 3 && c < 3 + width;
      row += inside ? '#' : '.';
    }
    rows.push(row);
  }
  return rows;
}

function isCustomGlyph(ch: string): boolean {
  return CUSTOM_GLYPHS[ch] !== undefined;
}

/** 1行の幅（点）。字間を足すとき・自前の字を含むときは字ごとの送り幅を積む */
function lineWidthOf(line: string, letterSpacing: number): number {
  const ctx = measureContext();
  const chars = [...line];
  if (letterSpacing === 0 && !chars.some(isCustomGlyph)) {
    return Math.ceil(ctx.measureText(line).width);
  }
  let width = 0;
  chars.forEach((ch, i) => {
    const advance = isCustomGlyph(ch) ? GLYPH_PX : advanceOf(ctx, ch);
    width += advance + (i < chars.length - 1 ? letterSpacing : 0);
  });
  return width;
}

/**
 * 1行を高解像度で描き、点の中心を拾って `mask` へ書き込む。
 * `x0` は行の先頭の点、`baseline` は基準線の点（どちらも整数）。
 */
function rasterizeLine(
  line: string,
  letterSpacing: number,
  mask: Uint8Array,
  maskWidth: number,
  maskHeight: number,
  x0: number,
  baseline: number,
): void {
  if (line.length === 0) return;
  const S = SUPERSAMPLE;
  const lineDots = lineWidthOf(line, letterSpacing) + 2;
  const rowDots = GLYPH_PX + LINE_MARGIN * 2;
  const hiW = lineDots * S;
  const hiH = rowDots * S;
  const ctx = scratchContext(hiW, hiH);
  // 作業場の原点は「行の先頭の1点手前」、基準線は上の余白＋字の枠の中の基準線
  const penX = S;
  const baseY = (LINE_MARGIN + BASELINE_IN_GLYPH) * S;
  /** 自前で描く字の位置（行の先頭からの点） */
  const custom: Array<{ ch: string; at: number }> = [];
  const chars = [...line];
  if (letterSpacing === 0 && !chars.some(isCustomGlyph)) {
    ctx.fillText(line, penX, baseY);
  } else {
    // 字ごとに送る（字間を足す・自前の字を挟む）。**フォントで描ける字の並びはまとめて
    // 描く**＝このフォントの送り幅は整数なので、分けて描いても位置は変わらない
    const m = measureContext();
    let x = 0;
    let run = '';
    let runStart = 0;
    const flush = (): void => {
      if (run.length > 0) ctx.fillText(run, penX + runStart * S, baseY);
      run = '';
    };
    chars.forEach((ch, i) => {
      const gap = i < chars.length - 1 ? letterSpacing : 0;
      if (isCustomGlyph(ch)) {
        flush();
        custom.push({ ch, at: x });
        x += GLYPH_PX + gap;
        runStart = x;
        return;
      }
      if (letterSpacing !== 0) {
        ctx.fillText(ch, penX + x * S, baseY);
        x += advanceOf(m, ch) + gap;
        runStart = x;
        return;
      }
      if (run.length === 0) runStart = x;
      run += ch;
      x += advanceOf(m, ch);
    });
    flush();
  }
  const data = ctx.getImageData(0, 0, hiW, hiH).data;
  const top = baseline - (LINE_MARGIN + BASELINE_IN_GLYPH);
  for (let r = 0; r < rowDots; r += 1) {
    const my = top + r;
    if (my < 0 || my >= maskHeight) continue;
    const cy = r * S + sampleAt.y;
    for (let c = 0; c < lineDots; c += 1) {
      const mx = x0 - 1 + c;
      if (mx < 0 || mx >= maskWidth) continue;
      if (inkAt(data, hiW, hiH, c * S + sampleAt.x, cy)) mask[my * maskWidth + mx] = 1;
    }
  }
  // 自前の字は点をそのまま置く（字の枠の上端＝基準線の14点上）
  const glyphTop = baseline - BASELINE_IN_GLYPH;
  for (const { ch, at } of custom) {
    CUSTOM_GLYPHS[ch].forEach((row, r) => {
      const my = glyphTop + r;
      if (my < 0 || my >= maskHeight) return;
      for (let c = 0; c < row.length; c += 1) {
        const mx = x0 + at + c;
        if (row[c] === '#' && mx >= 0 && mx < maskWidth) mask[my * maskWidth + mx] = 1;
      }
    });
  }
}

/**
 * 高解像度の画素の境目 (x, y) を中心にした 2×2 の平均が半分を超えるか。
 * **1点の中心だけを見る**ので、線が1.17点の太さで描かれていても1点は1画素になる。
 */
function inkAt(data: Uint8ClampedArray, w: number, h: number, x: number, y: number): boolean {
  let sum = 0;
  for (let dy = -1; dy <= 0; dy += 1) {
    const yy = y + dy;
    if (yy < 0 || yy >= h) continue;
    for (let dx = -1; dx <= 0; dx += 1) {
      const xx = x + dx;
      if (xx < 0 || xx >= w) continue;
      sum += data[(yy * w + xx) * 4 + 3];
    }
  }
  return sum >= 2 * 255;
}

/** 点の中心の位置を測る見本（画数の多い漢字・かな・英数を混ぜる） */
const CALIBRATION_TEXT = '威嚇貫禄粘り工国鬱あアBg9';

/**
 * **点の中心がどこに来るかを描いて測る**。ずらし方（0..SUPERSAMPLE-1 の縦横）を総当たりし、
 * 拾った値が「塗りでも地でもない」曖昧な点がいちばん少ない位置を採る。
 * フォントの寸法を書き写さないので、フォントやブラウザの描き方が変わっても追従する。
 */
function calibrate(): void {
  if (typeof document === 'undefined') return;
  const S = SUPERSAMPLE;
  const lineDots = lineWidthOf(CALIBRATION_TEXT, 0) + 2;
  const rowDots = GLYPH_PX + LINE_MARGIN * 2;
  const hiW = lineDots * S;
  const hiH = rowDots * S;
  const ctx = scratchContext(hiW, hiH);
  ctx.fillText(CALIBRATION_TEXT, S, (LINE_MARGIN + BASELINE_IN_GLYPH) * S);
  const data = ctx.getImageData(0, 0, hiW, hiH).data;
  let best = { x: 0, y: 0, score: Number.POSITIVE_INFINITY };
  for (let oy = 0; oy < S; oy += 1) {
    for (let ox = 0; ox < S; ox += 1) {
      let ambiguous = 0;
      let ink = 0;
      for (let r = 0; r < rowDots; r += 1) {
        for (let c = 0; c < lineDots; c += 1) {
          const avg = average(data, hiW, hiH, c * S + ox, r * S + oy);
          if (avg > 40 && avg < 215) ambiguous += 1;
          if (avg >= 128) ink += 1;
        }
      }
      // 何も拾えない位置（全部が地）は曖昧さ0でも採らない
      if (ink === 0) continue;
      if (ambiguous < best.score) best = { x: ox, y: oy, score: ambiguous };
    }
  }
  if (Number.isFinite(best.score)) {
    sampleAt = { x: best.x, y: best.y };
    calibrated = true;
  }
}

function average(data: Uint8ClampedArray, w: number, h: number, x: number, y: number): number {
  let sum = 0;
  let n = 0;
  for (let dy = -1; dy <= 0; dy += 1) {
    const yy = y + dy;
    if (yy < 0 || yy >= h) continue;
    for (let dx = -1; dx <= 0; dx += 1) {
      const xx = x + dx;
      if (xx < 0 || xx >= w) continue;
      sum += data[(yy * w + xx) * 4 + 3];
      n += 1;
    }
  }
  return n === 0 ? 0 : sum / n;
}

/** 測り終えたか（テスト・確認用） */
export function pixelFontCalibrated(): boolean {
  return calibrated;
}

export function createPixelLabel(initialText: string, opts: PixelLabelOptions = {}): PixelLabel {
  const o = { ...DEFAULTS, ...opts };
  const canvas = document.createElement('canvas');
  canvas.style.imageRendering = 'pixelated';
  const ctx = canvas.getContext('2d')!;
  /** いま出している文字列と見た目（同じなら描き直さない＝毎フレーム呼ばれても軽い） */
  let drawnKey = '';
  let currentText = initialText;

  function draw(text: string): void {
    const scale = Math.max(1, Math.round(o.scale));
    const shadowKey = o.shadows.map((s) => `${s.dx},${s.dy},${s.color}`).join(';');
    const key = [
      text,
      o.color,
      scale,
      deviceScale,
      dpr,
      o.align,
      o.outline,
      o.lineHeight,
      o.paddingX,
      o.paddingY,
      shadowKey,
      o.letterSpacing,
      sampleAt.x,
      sampleAt.y,
    ].join('\u0000');
    if (key === drawnKey) return;
    const lines = text.split('\n');
    let maxWidth = 0;
    const widths = lines.map((line) => {
      const w = lineWidthOf(line, o.letterSpacing);
      maxWidth = Math.max(maxWidth, w);
      return w;
    });
    const edge = o.outline ? 1 : 0;
    // 影は右・下へずらすぶんだけ canvas を広げる（左・上へのずらしは使っていない）
    const shadowX = Math.max(0, ...o.shadows.map((s) => s.dx));
    const shadowY = Math.max(0, ...o.shadows.map((s) => s.dy));
    const width = Math.max(1, Math.ceil(o.paddingX * 2 + maxWidth + edge * 2 + shadowX));
    const height = Math.max(1, Math.ceil(o.paddingY * 2 + lines.length * o.lineHeight + edge * 2 + shadowY));
    // canvas.width/height の変更は描画バッファをリセットするので、描く前に設定する
    canvas.width = width;
    canvas.height = height;
    // **端末の画素で整数倍**になるよう、CSS の大きさは端末の倍率から割り戻す
    const devicePixelsPerDot = scale * deviceScale;
    canvas.style.width = `${(width * devicePixelsPerDot) / dpr}px`;
    canvas.style.height = `${(height * devicePixelsPerDot) / dpr}px`;

    const mask = new Uint8Array(width * height);
    // 字の高さ16に対して行の高さは20：上に2ドット空けて字を置く（字の点が格子に乗る）
    const top = o.paddingY + edge + Math.round((o.lineHeight - GLYPH_PX) / 2);
    lines.forEach((line, i) => {
      const x0 =
        o.align === 'center'
          ? Math.round((width - shadowX - widths[i]) / 2)
          : o.paddingX + edge;
      rasterizeLine(line, o.letterSpacing, mask, width, height, x0, top + i * o.lineHeight + BASELINE_IN_GLYPH);
    });
    paint(ctx, mask, width, height, o.color, o.outline, o.shadows);
    drawnKey = key;
  }

  function render(text: string): void {
    currentText = text;
    draw(text);
    if (!fontReady(text)) {
      // まだ読み込まれていない字がある：読み込み後、同じ文字列のままなら描き直す
      document.fonts
        .load(HI_FONT, text)
        .then(() => document.fonts.load(FONT, text))
        .then(
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
 * 拾った点（`mask`）に色を塗る（影→縁取り→字の順）。**半透明の画素は1つも作らない**
 * ＝整数倍に拡大しても点が灰色ににじまない。
 */
function paint(
  ctx: CanvasRenderingContext2D,
  mask: Uint8Array,
  width: number,
  height: number,
  color: string,
  outline: string | null,
  shadows: readonly PixelShadow[],
): void {
  const image = ctx.createImageData(width, height);
  const data = image.data;
  const [r, g, b] = parseColor(color);
  const out = outline ? parseColor(outline) : null;
  const shade = shadows.map((s) => ({ ...s, rgb: parseColor(s.color) }));
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
      // 影：手前（後に書いた影）から見て、最初に当たった影の色を採る
      for (let k = shade.length - 1; k >= 0; k -= 1) {
        const s = shade[k];
        const sx = x - s.dx;
        const sy = y - s.dy;
        if (sx < 0 || sy < 0 || sx >= width || sy >= height || !mask[sy * width + sx]) continue;
        data[p] = s.rgb[0];
        data[p + 1] = s.rgb[1];
        data[p + 2] = s.rgb[2];
        data[p + 3] = 255;
        break;
      }
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

// ---- DOMで組む画面の文字（フェーズWW-71） ----

const domLabels = new WeakMap<HTMLElement, PixelLabel>();

/**
 * **要素の文字を canvas のドット文字に置き換える**（`textContent` の代わりに呼ぶ）。
 * ブラウザが描くDOMの文字は縁がぼかされるので、タイトル・チーム選択の画面もこれで描く。
 * 要素ごとにラベルを1つだけ持ち、同じ文字・同じ見た目なら描き直さない（毎回呼んでよい）。
 * 余白は要素の側（CSS）が持つので、ラベル自身の余白は既定で0にする。
 */
export function setPixelText(
  el: HTMLElement,
  text: string,
  opts: Partial<PixelLabelOptions> = {},
): PixelLabel {
  let label = domLabels.get(el);
  const merged: Partial<PixelLabelOptions> = { paddingX: 0, paddingY: 0, ...opts };
  if (!label) {
    label = createPixelLabel(text, merged);
    label.el.style.display = 'inline-block';
    label.el.style.verticalAlign = 'top';
    el.replaceChildren(label.el);
    domLabels.set(el, label);
    return label;
  }
  label.setText(text, merged);
  return label;
}
