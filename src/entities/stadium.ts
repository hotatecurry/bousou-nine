/**
 * 球場の部品の供給口（フェーズE-25-(d)）。
 *
 * **呼び出し側は「部品の名前と、置きたい場所の一覧」だけを知る**（`entities/player.ts` が
 * 「人型のGroupをもらうことだけを知る」のと同じ整理）。中身が何メッシュか・材質がいくつかを
 * 知らないので、Blender 側でモデルを作り替えても `scenes/field.ts` は書き換えずに済む。
 *
 * モデルは Blender で作って glTF で読み込む（`assets-src/stadium.blend` がソース、
 * 書き出し先は `src/assets/stadium.glb`）。**同じ場所へ上書き export すればコードを
 * 触らずに差し替わる**（選手モデルと同じ運用）。
 *
 * ---
 * **なぜ球場そのものを1つのモデルにしないか**：球場は6つあり、フェンスの距離も区間の
 * 例外（ふえいふえいの段差・たからづかのラッキーゾーン）も球場ごとに違う。完成形の
 * メッシュを固定で持つと、**見えている壁と当たる壁が別々の数値から起きる**ことになり、
 * C-14で退けた問題がそのまま戻る。そこで Blender が持つのは「スタンド1段」「観客1人」
 * といった**部品**だけにして、**並べる場所は `core/stands.ts` が `fenceAt` から起こす**。
 *
 * **並べ方は InstancedMesh**。スタンドは1段×90区画で最大1600個、観客は数千人になるので、
 * 1つずつメッシュにすると選手モデルの約250ドローコールに桁違いの数を足すことになる
 * （PROGRESS.mdが「球場を作り込むときに合わせて見る」と書き残していた点）。
 * インスタンス化すれば**部品1つにつき材質の数だけ**のドローコールで済む。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import stadiumModelUrl from '../assets/stadium.glb?url';
import { toToonMaterial } from '../render/toon';

/**
 * 部品の名前（`assets-src/stadium.blend` のオブジェクト名と一致させる）。
 * **1つでも欠けていたら読み込みで投げる**：黙って抜けると「なぜかこの球場だけ屋根が無い」に
 * 実機まで気づけない（player.ts が関節ノードの欠けで投げるのと同じ理由）。
 */
export const STADIUM_PARTS = [
  /** スタンド1段ぶんの1区画（幅1m。X方向へ引き伸ばして並べ、上へ積む） */
  'StandSection',
  /** 座った観客1人（原点＝座面） */
  'Spectator',
  /** 照明塔（原点＝地面） */
  'LightTower',
  /** 屋根1区画（原点＝屋根の下面の前端。どうむだけ使う） */
  'RoofSection',
  /** スコアボード（原点＝地面） */
  'Scoreboard',
  /** ファウル地域の低い柵1区画（外野はフェンスが兼ねる） */
  'Barrier',
  // ---- 背景（E-25-(d) の2段目）。スタンドの上を埋める ----
  /**
   * 空のドーム（単位半径1。水平線のわずかに下から天頂まで）。**glTFの
   * `KHR_materials_unlit`** で書き出してあるので three は `MeshBasicMaterial` を作る＝
   * 光源で片側だけ明るくなることがない。**頂点色で地平線→天頂のグラデーション**を持ち、
   * インスタンス色（`placeParts` の `colors`）が球場ごとの空の色を掛ける。
   */
  'SkyDome',
  /** 遠景の地面（単位半径1の輪。内側は既存の地面と重ねる） */
  'FarGround',
  /** 遠くの山並み（単位 幅1×高さ1。横に引き伸ばして輪につなげる） */
  'FarRidge',
  /** 遠くのビル（単位 1×1×1・底面が地面。頂点色で上ほど暗い） */
  'FarBuilding',
  /** 遠くの木（単位 高さ1） */
  'FarTree',
  /** 鉄橋（単位 長さ1×高さ1。かせんじきの河川敷らしさ） */
  'FarBridge',
] as const;
export type StadiumPart = (typeof STADIUM_PARTS)[number];

/** モデルの正面。glTF に落ちた時点で **+Z 向き**（Blender の正面 -Y が +Z になる）。 */
export const STADIUM_FORWARD_YAW = 0;

interface Primitive {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

/** 読み込み済みの原型。`placeParts` はこれを複製するだけなので同期で返せる。 */
let prototypes: Map<StadiumPart, Primitive[]> | null = null;

/**
 * 球場の部品を読み込む。**`placeParts` を呼ぶ前に一度だけ await する**
 * （選手モデルと同じく、供給口を同期のまま保つために原型を先に用意する形）。
 */
export async function preloadStadiumModel(): Promise<void> {
  if (prototypes) return;
  const gltf = await new GLTFLoader().loadAsync(stadiumModelUrl);
  const found = new Map<StadiumPart, Primitive[]>();
  for (const part of STADIUM_PARTS) {
    const node = gltf.scene.getObjectByName(part);
    if (!node) {
      throw new Error(`preloadStadiumModel: モデルに ${part} が無い（stadium.glb を確認）`);
    }
    const prims: Primitive[] = [];
    node.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      // トゥーン調（光源を使わない空のドームはそのまま＝`toToonMaterial` が素通しする）
      for (const material of materials) {
        prims.push({ geometry: mesh.geometry, material: toToonMaterial(material) });
      }
    });
    if (prims.length === 0) {
      throw new Error(`preloadStadiumModel: ${part} にメッシュが無い`);
    }
    found.set(part, prims);
  }
  prototypes = found;
}

/**
 * 同じ部品を `matrices` のぶんだけ並べる。返るのは InstancedMesh を束ねた Group で、
 * 呼び出し側は Scene に足すだけでよい。
 *
 * @param colors 個体ごとの色（観客に使う）。渡さなければモデルの材質の色のまま。
 *
 * **ジオメトリと材質は毎回複製する**。球場は試合ごとに組み直され（ラン化＝F-26-6）、
 * main.ts の `disposeGroup` が載っていたメッシュの資源を解放するので、原型と共有したままだと
 * **2試合目の球場が消える**（選手モデルは起動時に1度作って解放しないので、この違いがある）。
 */
export function placeParts(
  part: StadiumPart,
  matrices: readonly THREE.Matrix4[],
  colors?: readonly THREE.Color[],
): THREE.Group {
  if (!prototypes) {
    throw new Error('placeParts: preloadStadiumModel() を先に await すること');
  }
  const prims = prototypes.get(part);
  if (!prims) throw new Error(`placeParts: 未知の部品 ${part}`);

  const group = new THREE.Group();
  group.name = part;
  if (matrices.length === 0) return group;

  for (const prim of prims) {
    const mesh = new THREE.InstancedMesh(
      prim.geometry.clone(),
      prim.material.clone(),
      matrices.length,
    );
    for (let i = 0; i < matrices.length; i += 1) mesh.setMatrixAt(i, matrices[i]);
    mesh.instanceMatrix.needsUpdate = true;
    if (colors) {
      for (let i = 0; i < matrices.length; i += 1) {
        mesh.setColorAt(i, colors[i] ?? colors[colors.length - 1]);
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    // インスタンスを含めた範囲で視錐台カリングさせる（既定の境界球は部品1つ分しかない
    // ので、これを呼ばないと外周のスタンドがカメラの向きによって消える）。
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    group.add(mesh);
  }
  return group;
}
