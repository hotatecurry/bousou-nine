/**
 * 手続きで起こすテクスチャの共通設定（ブラッシュアップ：グラフィック）。
 *
 * 地面の模様（芝の刈り目・土）は画像ファイルを持たず canvas で描く＝球場を足しても
 * 資産が増えない。**`document` に触るのは呼ばれたときだけ**（テストは node 環境で
 * `scenes/field.ts` を読み込むので、読み込んだ瞬間に canvas を作ってはいけない）。
 */
import * as THREE from 'three';

/**
 * 異方性フィルタの強さ。でっかいモードは地面を浅い角度で見るので、これが無いと
 * 芝の刈り目が奥でにじむ。値は描画器の上限（main.ts が起動時に渡す）。
 */
let maxAnisotropy = 1;

export function setTextureAnisotropy(value: number): void {
  maxAnisotropy = Math.max(1, value);
}

/** 連番から決まる疑似乱数（0..1）。**本編の乱数は使わない**＝毎回同じ絵になる */
export function hash01(n: number): number {
  const h = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return h - Math.floor(h);
}

/** canvas に描いてテクスチャにする（繰り返し・sRGB・ミップマップ・異方性まで揃える） */
export function canvasTexture(
  size: number,
  draw: (ctx: CanvasRenderingContext2D, size: number, height: number) => void,
  height = size,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  draw(ctx, size, height);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = maxAnisotropy;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}
