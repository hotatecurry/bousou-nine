/**
 * ドット絵風テキスト描画ヘルパー（canvas使用、外部フォント/画像資産なし）。
 *
 * 低解像度のオフスクリーンcanvasに小さいフォントサイズでテキストを描画し
 * （imageSmoothingEnabled=false でアンチエイリアスを切る）、その canvas 要素自体を
 * CSSで整数倍に拡大表示する（image-rendering: pixelated）。ブラウザがcanvasの
 * ピクセルをそのまま拡大するため、カタカナを含む任意のテキストが、手作業の
 * ビットマップフォント（全グリフの手描き）を用意しなくてもファミコン風の
 * ブロック状ドット文字になる。HUDパネル本実装（セッション8）のドット絵表現は
 * すべてこのヘルパー経由で統一する。
 */

export interface PixelLabelOptions {
  /** 論理フォントサイズ（px、拡大前）。既定8 */
  fontSize?: number;
  fontFamily?: string;
  color?: string;
  /** 整数倍の拡大率。既定3（大きい・目立たせたい表示はもっと大きくする） */
  scale?: number;
  paddingX?: number;
  paddingY?: number;
  /** 行間（論理px） */
  lineHeight?: number;
  align?: 'left' | 'center';
}

export interface PixelLabel {
  el: HTMLCanvasElement;
  /** overrides を渡すと以後の描画スタイルを恒久的に更新する（バナーの色/拡大率の出し分け等に使う） */
  setText(text: string, overrides?: Partial<PixelLabelOptions>): void;
}

const DEFAULTS: Required<PixelLabelOptions> = {
  fontSize: 8,
  fontFamily: '"MS Gothic", "ＭＳ ゴシック", monospace',
  color: '#f8f8f8',
  scale: 3,
  paddingX: 4,
  paddingY: 3,
  lineHeight: 10,
  align: 'left',
};

export function createPixelLabel(initialText: string, opts: PixelLabelOptions = {}): PixelLabel {
  const o = { ...DEFAULTS, ...opts };
  const canvas = document.createElement('canvas');
  canvas.style.imageRendering = 'pixelated';
  const ctx = canvas.getContext('2d')!;

  function measure(lines: string[]): { width: number; height: number } {
    ctx.font = `${o.fontSize}px ${o.fontFamily}`;
    let maxWidth = 0;
    for (const line of lines) {
      maxWidth = Math.max(maxWidth, ctx.measureText(line).width);
    }
    return {
      width: Math.ceil(o.paddingX * 2 + maxWidth),
      height: Math.ceil(o.paddingY * 2 + lines.length * o.lineHeight),
    };
  }

  function draw(text: string): void {
    const lines = text.split('\n');
    const { width, height } = measure(lines);
    // canvas.width/height の変更は描画バッファをクリアし、フォント等の状態もリセットするため
    // リサイズ後に改めて設定し直す（measure時点の設定は使い回さない）。
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    canvas.style.width = `${canvas.width * o.scale}px`;
    canvas.style.height = `${canvas.height * o.scale}px`;
    ctx.imageSmoothingEnabled = false;
    ctx.font = `${o.fontSize}px ${o.fontFamily}`;
    ctx.fillStyle = o.color;
    ctx.textBaseline = 'top';
    ctx.textAlign = o.align === 'center' ? 'center' : 'left';
    const x = o.align === 'center' ? width / 2 : o.paddingX;
    lines.forEach((line, i) => {
      ctx.fillText(line, x, o.paddingY + i * o.lineHeight);
    });
  }

  draw(initialText);

  return {
    el: canvas,
    setText(text, overrides) {
      if (overrides) Object.assign(o, overrides);
      draw(text);
    },
  };
}
