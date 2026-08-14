/**
 * 選手が持つ・乗る「物」の供給口（フェーズE-25-(e)。スキル固有の見た目）。
 *
 * **呼び出し側は「部品の名前をもらって Object3D をもらう」ことだけを知る**
 * （`entities/player.ts` が「人型のGroupをもらう」／`entities/stadium.ts` が
 * 「部品と置きたい場所の一覧」だけを知るのと同じ整理）。中身が何メッシュか・材質がいくつかを
 * 知らないので、Blender 側で作り替えてもシーン側は書き換えずに済む。
 *
 * モデルは Blender で作って glTF で読み込む（ソースは `assets-src/props.blend`、書き出し先は
 * `src/assets/props.glb`）。**同じ場所へ上書き export すればコードを触らずに差し替わる**
 * （選手モデル・球場の部品と同じ運用）。
 *
 * ---
 * **向きの約束は選手モデルと同じ**：モデルの正面は **+Z**（Blender の -Y が glTF で +Z に
 * なる）。だから「銃口が前」＝銃のローカル +Z、「バイクの前輪が前」＝バイクのローカル +Z で、
 * 付ける側は回転を1つも書かなくて正しい向きになる。
 *
 * **原点は「取り付く場所」に置く**：バイクは**シートの真下（地面）**＝乗る走者の腰の
 * 真下、銃は**握る手の位置**。座標をコード側に書き写さずに済むので、Blenderで寸法を
 * 変えても付き方がずれない（球場の部品で「原点＝座面」「原点＝地面」と決めたのと同じ）。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import propsModelUrl from '../assets/props.glb?url';

/**
 * 部品の名前（`assets-src/props.blend` のオブジェクト名と一致させる）。
 * **1つでも欠けていたら読み込みで投げる**：黙って抜けると「なぜかバイクだけ出ない」に
 * 実機まで気づけない（`player.ts` が関節ノードの欠けで、`stadium.ts` が部品の欠けで
 * 投げるのと同じ理由）。
 */
export const PROP_PARTS = [
  /** オートバイ（★3 メカ `バイク` ／消費型 `ニトロ`）。原点＝シートの真下の地面・+Z が前 */
  'Bike',
  /** 拳銃（★3 メカ `ジュウ` ／消費型 `ヨビジュウ`）。原点＝握る手・+Z が銃口の向き */
  'Gun',
] as const;
export type PropPart = (typeof PROP_PARTS)[number];

/**
 * 銃口のノード名（`Gun` の子）。マズルフラッシュの取り付け口で、**座標をコード側に
 * 持たない**ので銃身の長さを変えても閃光が付いてくる。
 */
const GUN_MUZZLE_NODE = 'GunMuzzle';

/** 読み込み済みの原型。`createProp` はこれを複製するだけなので同期で返せる。 */
let prototypes: Map<PropPart, THREE.Object3D> | null = null;

/**
 * 部品を読み込む。**`createProp` を呼ぶ前に一度だけ await する**
 * （選手モデル・球場の部品と同じく、供給口を同期のまま保つために原型を先に用意する形）。
 */
export async function preloadProps(): Promise<void> {
  if (prototypes) return;
  const gltf = await new GLTFLoader().loadAsync(propsModelUrl);
  const found = new Map<PropPart, THREE.Object3D>();
  for (const part of PROP_PARTS) {
    const node = gltf.scene.getObjectByName(part);
    if (!node) throw new Error(`preloadProps: モデルに ${part} が無い（props.glb を確認）`);
    found.set(part, node);
  }
  prototypes = found;
}

/**
 * 部品を1つ作る。`preloadProps()` の完了後にだけ呼べる（読み込み前に呼ぶのは呼び出し順の
 * 誤りなので、黙って空のGroupを返さずに投げる＝`createPlayer` と同じ扱い）。
 *
 * **ジオメトリと材質は原型と共有する**（`clone` の既定）。部品は起動時に作って解放しない
 * ＝選手モデルと同じ寿命なので、球場の部品のように複製する必要がない（あちらは試合ごとに
 * 組み直して `disposeGroup` で解放するため、共有すると2試合目が消える）。
 */
export function createProp(part: PropPart): THREE.Object3D {
  if (!prototypes) throw new Error('createProp: preloadProps() を先に await すること');
  const proto = prototypes.get(part);
  if (!proto) throw new Error(`createProp: 未知の部品 ${part}`);
  const obj = proto.clone(true);
  // 原型は glTF のシーン内で位置・向きを持ち得るので、取り付け口としては素の状態に戻す
  // （原点を「取り付く場所」に置いてあるという上記の約束を、呼び出し側から保証する）。
  obj.position.set(0, 0, 0);
  obj.quaternion.identity();
  return obj;
}

/**
 * 銃口のノードを取り出す（`createProp('Gun')` で作った銃に対して呼ぶ）。
 * 欠けていたら投げる＝マズルフラッシュが黙って原点（＝手元）で光ると、
 * 「なぜか銃口から出ていない」に実機まで気づけない。
 */
export function gunMuzzleOf(gun: THREE.Object3D): THREE.Object3D {
  const node = gun.getObjectByName(GUN_MUZZLE_NODE);
  if (!node) throw new Error(`gunMuzzleOf: ${GUN_MUZZLE_NODE} が無い（props.glb を確認）`);
  return node;
}
