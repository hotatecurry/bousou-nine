/**
 * トゥーン調の見た目の供給口（ブラッシュアップ：グラフィック）。
 *
 * **判定には一切触らない**（CLAUDE.md ⑨「判定は真面目、見た目と名前が狂っている」）。
 * ここがやるのは「既にある形をどう塗るか」だけで、`core/*.ts` からは何も読まない。
 *
 * 3つの道具を持つ：
 * 1. **階調の地図（`toonGradient`）**＝光の当たり方を3段に丸める1本のテクスチャ。
 *    全員が同じ1本を共有するので、選手・道具・スタンドの陰の段が揃う。
 * 2. **材質の読み替え（`toToonMaterial`）**＝Blender から来た PBR の材質（色・頂点色・
 *    テクスチャ）をトゥーンの材質へ移す。**Blender 側は色だけ塗ればよい**＝モデルを
 *    作り直しても塗り方はここ1か所で揃う（`player.ts` の「モデルの内部構造を漏らさない」と
 *    同じ整理）。
 * 3. **輪郭線（`addOutline`）**＝裏面を法線方向へ膨らませた殻（inverted hull）を子に足す。
 *    three 同梱の OutlineEffect は**毎フレームシーン全体を2回描き、インスタンス描画に
 *    対応しない**（観客1万人の殻が崩れる）ので使わない。殻を持つのは選手・道具・ボールだけ。
 *
 * 輪郭の太さは**画面上のピクセル数**で持つ（遠くの選手ほど細く、ただし `minPx` を
 * 下回らない）。ちっちゃいモードの小さな選手でも1ドットの縁が残る＝芝の上で読める。
 */
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ---- 1. 階調 ----

/**
 * 光の当たり方（dot(N,L) を -1..1 → 0..1 に写した値）を何段に丸めるか。
 * 5 テクセルで持つのは**しきい値の位置を決めるため**：-1..1 を5等分した区間に
 * [陰, 陰, 中間, 明, 明] を並べる＝dot(N,L) < -0.2 が陰・-0.2..0.2 が中間・0.2 以上が明。
 * 真正面から当たる面だけでなく、斜めの面まで明るい側に入る（顔や胸が陰に沈まない）。
 */
const TOON_STEPS = [0.42, 0.42, 0.7, 1.0, 1.0];

let gradient: THREE.DataTexture | null = null;

/** トゥーンの階調テクスチャ（全材質で共有）。 */
export function toonGradient(): THREE.DataTexture {
  if (gradient) return gradient;
  const data = new Uint8Array(TOON_STEPS.length * 4);
  TOON_STEPS.forEach((v, i) => {
    const c = Math.round(v * 255);
    data.set([c, c, c, 255], i * 4);
  });
  const tex = new THREE.DataTexture(data, TOON_STEPS.length, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  gradient = tex;
  return tex;
}

/** トゥーンの材質を1つ作る（色だけ指定する場面向け）。 */
export function createToonMaterial(
  params: THREE.MeshToonMaterialParameters = {},
): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ gradientMap: toonGradient(), ...params });
}

// ---- 2. 材質の読み替え ----

/**
 * glTF から来た材質をトゥーンの材質へ移す。**名前を引き継ぐ**のが要点で、
 * `player.ts` は材質の名前（`Uniform`）で「塗り替える材質」を見分けている。
 *
 * すでにトゥーン、または光源を使わない材質（空のドーム＝`KHR_materials_unlit` から
 * 作られる MeshBasicMaterial）はそのまま返す＝空が光で片側だけ明るくなることはない。
 */
export function toToonMaterial(material: THREE.Material): THREE.Material {
  if ((material as THREE.MeshToonMaterial).isMeshToonMaterial) return material;
  if ((material as THREE.MeshBasicMaterial).isMeshBasicMaterial) return material;
  const src = material as THREE.MeshStandardMaterial;
  const toon = createToonMaterial({
    color: src.color ? src.color.clone() : new THREE.Color(0xffffff),
    map: src.map ?? null,
    vertexColors: src.vertexColors,
    transparent: src.transparent,
    opacity: src.opacity,
    side: src.side,
    alphaTest: src.alphaTest,
  });
  if (src.emissive && (src.emissive.r > 0 || src.emissive.g > 0 || src.emissive.b > 0)) {
    toon.emissive = src.emissive.clone();
    toon.emissiveIntensity = src.emissiveIntensity ?? 1;
    toon.emissiveMap = src.emissiveMap ?? null;
  }
  toon.name = src.name;
  return toon;
}

/** 木構造の中の材質をすべてトゥーンへ移す（原型に一度だけ掛ける）。 */
export function toonify(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(toToonMaterial)
      : toToonMaterial(mesh.material);
  });
}

// ---- 3. 輪郭線 ----

/**
 * 輪郭の殻の材質が共有する「画面の大きさ」。リサイズのたびに `setOutlineViewport` が
 * 書き換える（殻の太さをピクセルで持つには描画バッファの大きさが要る）。
 */
const viewport = {
  uResolution: { value: new THREE.Vector2(1280, 720) },
  uPixelRatio: { value: 1 },
};

/** 描画バッファの大きさが変わったら呼ぶ（main.ts のリサイズ処理）。 */
export function setOutlineViewport(width: number, height: number, pixelRatio: number): void {
  viewport.uResolution.value.set(width * pixelRatio, height * pixelRatio);
  viewport.uPixelRatio.value = pixelRatio;
}

const OUTLINE_VERTEX = /* glsl */ `
uniform vec2 uResolution;
uniform float uPixelRatio;
uniform float uWorldWidth;
uniform float uMinPx;
uniform float uMaxPx;
void main() {
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  // 法線を画面上の向きに直す（透視のひずみは無視＝殻の向きが分かれば足りる）
  vec3 n = normalize(normalMatrix * normal);
  vec2 dir = (projectionMatrix * vec4(n, 0.0)).xy * uResolution;
  float len = length(dir);
  dir = len > 1e-5 ? dir / len : vec2(0.0);
  // 太さ（ピクセル）＝世界の幅を今の奥行きで写した大きさ。遠くでも minPx は残す
  float px = uWorldWidth * projectionMatrix[1][1] * uResolution.y * 0.5 / max(clip.w, 1e-3);
  px = clamp(px, uMinPx * uPixelRatio, uMaxPx * uPixelRatio);
  clip.xy += dir * px * 2.0 / uResolution * clip.w;
  gl_Position = clip;
}
`;

const OUTLINE_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
void main() {
  gl_FragColor = vec4(uColor, 1.0);
  #include <colorspace_fragment>
}
`;

export interface OutlineStyle {
  /** 縁の色（既定は紺がかった黒＝真っ黒より絵に馴染む） */
  color?: THREE.ColorRepresentation;
  /** 実寸での縁の幅（m）。近いほど太く見える */
  worldWidth?: number;
  /** 画面上の最小の太さ（CSS px）。遠くの小さな選手でも縁が消えない */
  minPx?: number;
  /** 画面上の最大の太さ（CSS px） */
  maxPx?: number;
}

const DEFAULT_OUTLINE: Required<OutlineStyle> = {
  color: 0x1b1626,
  worldWidth: 0.03,
  minPx: 1.4,
  maxPx: 3.6,
};

/** 同じ見た目の殻は材質を共有する（選手18人ぶんで作り分けない）。 */
const outlineMaterials = new Map<string, THREE.ShaderMaterial>();

export function outlineMaterial(style: OutlineStyle = {}): THREE.ShaderMaterial {
  const s = { ...DEFAULT_OUTLINE, ...style };
  const color = new THREE.Color(s.color);
  const key = `${color.getHexString()}:${s.worldWidth}:${s.minPx}:${s.maxPx}`;
  const cached = outlineMaterials.get(key);
  if (cached) return cached;
  const material = new THREE.ShaderMaterial({
    name: 'Outline',
    uniforms: {
      uResolution: viewport.uResolution,
      uPixelRatio: viewport.uPixelRatio,
      uColor: { value: color },
      uWorldWidth: { value: s.worldWidth },
      uMinPx: { value: s.minPx },
      uMaxPx: { value: s.maxPx },
    },
    vertexShader: OUTLINE_VERTEX,
    fragmentShader: OUTLINE_FRAGMENT,
    side: THREE.BackSide,
  });
  outlineMaterials.set(key, material);
  return material;
}

/**
 * 殻に使うジオメトリ（本体と同じ形で、**法線だけなめらかにしたもの**）。
 *
 * 本体の角（箱の稜線・帽子のつば・靴底）は面ごとに法線が割れているので、そのまま
 * 膨らませると角で殻が裂けて縁が途切れる。位置が同じ頂点を1つに束ねて法線を平均すれば、
 * 角では斜めに膨らむ＝縁が1周つながる。形（頂点の位置）は本体と同じなので、
 * 関節を回しても殻がずれることはない。本体1つにつき一度だけ作って使い回す。
 */
const shellGeometries = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();

function shellGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const cached = shellGeometries.get(source);
  if (cached) return cached;
  const positionOnly = new THREE.BufferGeometry();
  positionOnly.setAttribute('position', source.attributes.position);
  if (source.index) positionOnly.setIndex(source.index);
  const merged = mergeVertices(positionOnly, 1e-4);
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  shellGeometries.set(source, merged);
  return merged;
}

/**
 * 縁を付けない材質（Blender 側の材質名）。目・眉は数ピクセルしかないので、縁を足すと
 * 黒い塊に潰れて表情が消える（縁は顔の輪郭が受け持つ）。
 */
const NO_OUTLINE_MATERIALS = new Set(['Eye', 'Brow']);

/** 殻のメッシュに付ける印（複製・塗り替え・影の設定で本体と見分ける） */
export const OUTLINE_FLAG = 'isToonOutline';

export function isOutlineMesh(obj: THREE.Object3D): boolean {
  return obj.userData[OUTLINE_FLAG] === true;
}

/**
 * `root` の下のメッシュすべてに輪郭の殻を子として足す。殻は**本体とジオメトリを共有**
 * するので、姿勢（関節の回転）も拡大（ちっちゃいモードの2.5倍）も自動で付いてくる。
 *
 * 殻は影を落とさず受けもしない（影は本体だけが作る）。名前は付けない＝
 * `player.ts` が名前で関節を探すときに引っかからない。
 */
export function addOutline(root: THREE.Object3D, style: OutlineStyle = {}): void {
  const material = outlineMaterial(style);
  const targets: THREE.Mesh[] = [];
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || isOutlineMesh(mesh)) return;
    if (!(mesh.geometry as THREE.BufferGeometry).attributes.normal) return;
    if ((mesh as unknown as THREE.InstancedMesh).isInstancedMesh) return;
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (mat && NO_OUTLINE_MATERIALS.has(mat.name)) return;
    targets.push(mesh);
  });
  for (const mesh of targets) {
    const shell = new THREE.Mesh(shellGeometry(mesh.geometry as THREE.BufferGeometry), material);
    shell.userData[OUTLINE_FLAG] = true;
    shell.castShadow = false;
    shell.receiveShadow = false;
    shell.raycast = () => {};
    mesh.add(shell);
  }
}

/** 影を落とす（本体だけ。殻は落とさない）。 */
export function castShadows(root: THREE.Object3D, receive = false): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || isOutlineMesh(mesh)) return;
    mesh.castShadow = true;
    mesh.receiveShadow = receive;
  });
}
