/**
 * 選手モデルの供給口（フェーズE-25）。
 *
 * **呼び出し側は「人型のGroupをもらう」ことだけを知る**（CLAUDE.md ⑨）。中身が箱人間か
 * glTFかを知らないので、モデルを差し替えても3か所（でっかいモードの投手/打者/捕手・
 * ちっちゃいモードの野手9＋走者・乱闘のファイター2）は書き換えずに済む。
 * 色替え・向き・**姿勢（フェーズE-25-(c)）**もこの口の側の責務にしてあるのは同じ理由で、
 * **モデルの内部構造（どのメッシュがユニフォームか・どのノードが肘か）を呼び出し側に
 * 漏らさない**ため。
 *
 * モデルは Blender で作って glTF で読み込む（`assets-src/player.blend` がソース）。
 * 全高1.8mの実寸・約5.5頭身で、**関節ごとに別ノード**（Pelvis→Torso→Head/Arm…、
 * LegUpper→LegLower→Foot）になっている＝**時間から関節角を計算する手続きアニメ**
 * （E-25の(c)）をこの階層にそのまま載せる。
 *
 * ---
 * **アニメは判定側に一切触らない**（CLAUDE.md ⑨）。スイングの有効時間・走者速度・
 * 捕球半径はすべて `core/*.ts` のままで、ここがやるのは「既に決まっている動きに
 * 見た目を乗せる」ことだけ。だからこのファイルは `core` から**型（打席の左右）以外は
 * 何も読まない**し、判定へ値を返す関数も持たない。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  type BatterSide,
  type PitchArm,
  type PitchArmSide,
  ARM_RELEASE_LEAN_RAD,
  ARM_SLOT_RAD,
  NEUTRAL_PITCH_ARM,
} from '../core/pitch';
import type { PitchKey, SwingKey } from '../core/keyframes';
import playerModelUrl from '../assets/player.glb?url';
import { type FighterPose, type PoseKit, applyFighterPose } from './fighterPoses';
import { addOutline, castShadows, toonify } from '../render/toon';

/**
 * チーム色として塗り替えるマテリアルの名前（Blender 側の材質名と一致させる）。
 * ユニフォーム（胴・帽子・袖）だけが対象で、肌・パンツ・スパイクは全選手で共有する
 * ＝**色替えしても「白いパンツの野球選手」であることは変わらない**（箱人間が
 * 「脚の白は変えない」としていたのと同じ切り分け）。
 */
const UNIFORM_MATERIAL_NAME = 'Uniform';

/** モデルの正面。glTF に落ちた時点で **+Z 向き**（Blender の正面 -Y が +Z になる）。 */
export const MODEL_FORWARD_YAW = 0;

// ---- モデルの寸法（player.glb と一致させる。姿勢の計算に要る） ----
//
// 関節をどれだけ曲げても**足の裏が地面に着いたまま**でいるために、腰の高さを
// 脚の角度から毎回導出する（`groundedHipY`）。数値を持つのはここ1か所で、
// モデルを作り直したらこの4つを書き換える（`assets-src/player.blend` の寸法）。

/** 股関節→膝 */
const THIGH_LENGTH = 0.45;
/** 膝→足首 */
const SHIN_LENGTH = 0.385;
/** 足首→足の裏 */
const ANKLE_HEIGHT = 0.085;
/** 直立時の腰の高さ（= 脚を伸ばしたときの足首＋脛＋腿） */
const HIP_HEIGHT = ANKLE_HEIGHT + THIGH_LENGTH + SHIN_LENGTH;
/** 肘→手（前腕の長さ。バットを持たせる手のノードを置く位置） */
const FOREARM_LENGTH = 0.345;

/**
 * 関節ノードの名前（Blender 側の階層と一致させる）。**1つでも欠けたら投げる**：
 * 姿勢が黙って効かないと「なぜか1人だけ棒立ち」に実機まで気づけない
 * （E-25-1で `createPlayer` を「原型が無ければ投げる」にしたのと同じ理由）。
 */
const JOINT_NAMES = [
  'Pelvis',
  'Torso',
  'Head',
  'ArmUpperL',
  'ArmLowerL',
  'ArmUpperR',
  'ArmLowerR',
  'LegUpperL',
  'LegLowerL',
  'LegUpperR',
  'LegLowerR',
  'FootL',
  'FootR',
] as const;
type JointName = (typeof JOINT_NAMES)[number];
type Joints = Record<JointName, THREE.Object3D>;

/**
 * 手（前腕の先）のノード。バット等を持たせる取り付け口で、**手首の角度は姿勢の側が書く**
 * ＝持たせる側は「付ける物の形」だけを知ればよい。
 *
 * 左右を `left`/`right` と呼ばずモデルのローカルX（`plusX`/`minusX`）で持つのは、
 * このモデルの L/R がどちらの手かを**呼び出し側に約束しないため**（打席の左右で
 * どちらの手に持たせるかは `attachBat` が決める）。
 */
interface Hands {
  plusX: THREE.Object3D;
  minusX: THREE.Object3D;
}

/**
 * 姿勢（フェーズE-25-(c)＝基本の5種／**E-25-(e)＝スキル固有の6種**）。
 * 基本＝構え（idle/stance/crouch）・歩き/走り（run）・投球（pitch）・打撃（swing/bunt）・
 * 捕球（catch）／スキル固有＝バイク（bike）・銃（aim）・ドロップキック（dropkick）・
 * 倒れる（fallen）・ファインプレイ（jump/dive）。
 *
 * どれも**時間や進行度を1つ受け取るだけ**で、判定側の値（スイングの有効時間・
 * 走者速度・捕球半径・行動不能の秒数）は一切見ない＝アニメを変えてもゲームの手触りは
 * 動かない。進行度は**呼び出し側が既に持っている値をそのまま渡す**ので、見た目と
 * 判定が別々の時計で動くことが構造的に起きない（E-25-(c)の投球・打撃と同じ整理）。
 */
export type PlayerPose =
  /** 直立（既定）。野手・走者・乱闘のファイターの平常時 */
  | { kind: 'idle' }
  /**
   * 歩き/走り。**歩調は `movePlayerTo` が積んだ「実際に進んだ距離」から起こす**ので
   * 引数を取らない＝呼び出し側が速度を別に持たなくてよく、見た目と実際の動きが
   * 構造的に食い違わない（足が空回りする／止まっているのに走る、が起きない）。
   */
  | { kind: 'run' }
  /** 捕球。reach=0（構え）〜1（グラブを伸ばし切る） */
  | { kind: 'catch'; reach: number }
  /** 捕手の座り込み */
  | { kind: 'crouch' }
  /**
   * 打席の構え（バットを持つ）。`walking` の間は脚だけ歩きに差し替える
   * （打者の仕切り直し＝打席へ歩いて入る間。フェーズE-23）。
   */
  | { kind: 'stance'; side: BatterSide; walking?: boolean }
  /**
   * スイング（フェーズBBB-76）。**原作の5枚の絵のどれか**（`core/keyframes.ts` の
   * `swingKeyAt` がスイングの経過から選ぶ）＝絵の間を補間しない（コマ送り）。
   * 体のヨーは呼び出し側が `swingKeyYaw(key)` を Group に掛ける。
   */
  | { kind: 'swing'; side: BatterSide; key: SwingKey }
  /** バント（バットを出して止める） */
  | { kind: 'bunt'; side: BatterSide }
  /**
   * 投球（フェーズBBB-76）。**原作の8枚の絵のどれか**（`core/keyframes.ts` の
   * `windupKeyAt`／`afterReleaseKeyAt` が投球の進行から選ぶ）。
   * `arm`（説明書のARM。フェーズCC-50）は**投げる腕と、その腕の角度**で、
   * 省略すると右のオーバースロー。**判定側のリリース位置のずれ（`armReleaseOffsetX`）と
   * 同じ `ARM_SLOT_RAD` から傾きを取る**ので、球の出どころと腕の向きが食い違わない。
   */
  | { kind: 'pitch'; key: PitchKey; arm?: PitchArm }
  /**
   * 送球（フェーズHH-55）。**t=0 がリリースの瞬間**（腕が前へ出切っている）〜1（振り抜き）
   * ＝**ボールが手を離れた後だけ**を描く。投球（`pitch`）が担ぎ上げから始まるのと違うのは、
   * **送球には判定の側に担ぎ上げの時間が無い**から：送球時間は `距離 ÷ THROW_SPEED` で
   * リリースの瞬間から数えられており、動作を待ってボールを出すと盗塁の窓・けん制の境界・
   * 内野ゴロの帰結が全部動く。**見た目の時計は判定の時計から導出する**（E-25-(e)）ので、
   * 判定が始まるところから動作も始める＝**手からボールが離れるフレームで腕が前にある**。
   *
   * `arm` は投球と同じ（省略＝右の上手）。名鑑にARMがあるのは投手だけなので、実データで
   * 投げるのはマウンドの1人だけになる（`fielderThrowArm`）。
   */
  | { kind: 'throw'; t: number; arm?: PitchArm }
  // ---- ここからスキル固有（フェーズE-25-(e)） ----
  /**
   * バイクにまたがって走る（★3メカ `バイク`／消費型 `ニトロ`。F-26-3）。
   * 腰はシートの高さに座り、脚はステップへ折り、腕はハンドルへ伸ばす
   * （**部品の寸法から逆算した角度**なので、走者がシートやステップから浮かない）。
   */
  | { kind: 'bike' }
  /**
   * 銃を構える（★3メカ `ジュウ`／消費型 `ヨビジュウ`。F-26-2）。
   * t=0（下ろしている）〜1（構え切る）。**銃口は必ず打者の側（モデルの +Z）を向く**
   * ので、照準が乗っている先と構えている先が食い違わない。
   */
  | { kind: 'aim'; t: number; arm?: PitchArm }
  /**
   * ドロップキック（★2ボウリョク。F-26-4）。t=0（踏み切り）〜1（蹴り切って着地）。
   * 上体を反らせて両脚を前へ突き出す＝**当たっても外れても同じ動作**（外れの代償は
   * 下の `fallen` が受ける）。
   */
  | { kind: 'dropkick'; t: number }
  /**
   * 倒れて起き上がる（蹴り倒された野手＝`DROPKICK_DOWN_SEC`／蹴りを外して転んだ走者＝
   * `DROPKICK_STUMBLE_SEC`。どちらも同じ姿勢を使う＝**倒れているという事実は1つ**）。
   * t=0（倒れ始め）〜1（起き上がり切る）。`forward` は倒れる向き（前＝うつ伏せ）。
   */
  | { kind: 'fallen'; t: number; forward: boolean }
  /**
   * ファインプレイのジャンプ（説明書p23）。lift=0（地面）〜1（頂点）＝**跳んでいる高さの
   * 進行度そのもの**を渡すので、腕が伸び切るフレームと最高到達点が必ず一致する。
   */
  | { kind: 'jump'; lift: number }
  /**
   * ファインプレイの横っとび・ダイビング（説明書p23）。t=0（踏み切り）〜1（伸び切り）。
   * **伸び切ったまま起き上がるまで低い**＝跳んだ代償（起き上がりの隙）が姿勢で見える。
   */
  | { kind: 'dive'; t: number }
  /**
   * 乱闘v3（フェーズXX-72）の姿勢。ストIIの立ち・しゃがみ・ジャンプ・技・やられを
   * `entities/fighterPoses.ts` がまとめて持つ（技の数が多いので別のファイルに分けた）。
   */
  | { kind: 'fighter'; pose: FighterPose };

// ---- 姿勢の角度（すべてラジアン） ----
//
// 回転の向きの約束（モデルは +Z 正面・手足は -Y に垂れている）：
//   rotation.x が正 → 手足は**後ろ（-Z）**へ振れる／負 → 前（+Z）へ振れる
//   rotation.z が正 → 手足は**+X 側**へ開く
// 数値はすべて実機（Playwright のスクリーンショット）で見ながら決めた。

/** 直立時に腕をわずかに開く（真っ直ぐ垂らすと板に見える） */
const IDLE_ARM_SPREAD = 0.12;
const IDLE_ELBOW = 0.15;

/**
 * 走り：腿の振り／膝の曲げ／腕の振り／肘の曲げ／前傾。
 * **ちっちゃいモードの見下ろし視点で決めた値**（腿を大きく開くと、真上に近い角度からは
 * 脚が横一直線に見えて「滑っている」ように読める）。膝を深く曲げるほうが走りに見える。
 */
const RUN_LEG_SWING = 0.62;
const RUN_KNEE_BEND = 1.15;
const RUN_ARM_SWING = 0.7;
const RUN_ELBOW = 1.1;
const RUN_LEAN = 0.12;
/** 1m進むごとに歩調が進む角度（＝歩幅。2πで1周期＝2歩） */
const GAIT_RADIANS_PER_METER = 2.4;
/**
 * 打席へ入るときの歩幅の倍率（フェーズE-23の「打者の仕切り直し」）。走りと同じ振り幅だと、
 * でっかいモードの近い視点では大股すぎて「歩いて入る」に見えない。
 */
const WALK_STRIDE_SCALE = 0.5;
/** これ以下の移動は「止まっている」とみなす（浮動小数の揺れで足が動かないように） */
const MOVE_EPSILON = 1e-4;

/** 捕球：グラブを伸ばす前後の腕の上げ角 */
const CATCH_ARM_LOW = 1.1;
const CATCH_ARM_HIGH = 2.0;

/** 捕手の座り込み（腿を前・脛を後ろ＝深くしゃがむ） */
const CROUCH_THIGH = -1.15;
const CROUCH_SHIN = 1.45;

/**
 * 打席の構え：膝の曲げ・足の開き。**原作の打者は構えから振り切りまで同じ高さ**
 * （頭と足の位置が6枚とも同じ。フェーズBBB-77で実測）なので、スイングの絵もこの曲げの
 * 上に組み立てる。
 *
 * **膝はわずかに曲げるだけ＝ほぼ直立**（フェーズBBB-78。テストプレイ「後ろにのけぞりすぎ。
 * 直立してちゃんと構えてほしい」）。BBB-77 で深く曲げた（腿 -0.55・脛 0.95）ら、腰が
 * 立ったまま膝だけが前へ出て、**いすに座りかけたように上体が後ろへ倒れて見えた**
 * （原作の構えは頭が足の真上にある）。上体の前傾（`SWING_FRAMES` の `torsoX`）で構えの形を作る。
 *
 * **それでも後ろへ反って見えた原因は `torsoX` の符号**だった（フェーズBBB-79。テストプレイ
 * 「まだちょっと後ろにのけぞってます」）。腕・脚（-Y へぶら下がる部品）は `rotation.x` の正が
 * 後ろへ振る向きだが、**胴・骨盤（+Y へ伸びる部品）は正が前へ倒す向き**＝BBB-78 が前傾の
 * つもりで入れた負の値は、**上体を後ろへ反らせていた**。走り・捕球・バントの前傾も同じ
 * 取り違えだったので一緒に正した（`RUN_LEAN` ほか）。
 */
const STANCE_THIGH = -0.2;
const STANCE_SHIN = 0.35;
const STANCE_FEET_SPREAD = 0.18;
/**
 * 打者が首を回して投手を見る量の範囲 rad（フェーズBBB-77）。**原作の打者はどの絵でも
 * 後頭部しか見えない**＝ずっと投手のほうを見ている。体がどれだけ回っていても首で
 * 投手のほうへ向け直す（回せる量には限りがある）。
 */
const BATTER_HEAD_TURN_MIN = -0.6;
const BATTER_HEAD_TURN_MAX = 1.35;

/**
 * リリースの瞬間の投げる腕の角度（rotation.x を増やし続けると、腕は後ろ→頭上→前へ回る。
 * 4.7＝**前方水平**）。**この形の手から球が出る**（MM-60 の `armReleaseHeight`・CC-50 の
 * `armReleaseOffsetX` はこの腕から解いてある）＝リリースの絵（`PITCH_FRAMES.release`）と
 * 送球の振り出し（`applyThrow`）が共有する。
 */
const PITCH_ARM_RELEASE = 4.7;

/**
 * 送球の振り抜き（フェーズHH-55）。**投球の `PITCH_ARM_RELEASE` から始まって
 * ここまで振り下ろす**＝始点は投球と同じ定数なので、リリースの腕の形が投球と送球で
 * 食い違わない。野手は踏み込んで体ごと倒れ込まずに1歩で投げる（＝振り抜いた後すぐ
 * 次の動作に移れる形に見える）。
 */
const THROW_ARM_THROUGH = 5.3;
/** 送球で上体が前へ出る角（投球のフォロースルーより浅い） */
const THROW_LEAN = 0.3;

/** 読み込み済みの原型。`createPlayer` はこれを複製するだけなので同期で返せる。 */
let prototypeModel: THREE.Object3D | null = null;

/**
 * 選手モデルを読み込む。**`createPlayer` を呼ぶ前に一度だけ await する**
 * （読み込みは非同期だが、供給口は同期のまま保ちたいので原型を先に用意する形にした）。
 */
export async function preloadPlayerModel(): Promise<void> {
  if (prototypeModel) return;
  const gltf = await new GLTFLoader().loadAsync(playerModelUrl);
  const model = gltf.scene;
  // トゥーン調（ブラッシュアップ：グラフィック）。**原型に一度だけ掛ける**＝複製は
  // 材質も輪郭の殻もそのまま引き継ぐ（殻は本体とジオメトリを共有するので、関節を
  // 回せば縁も一緒に回る）。影は本体だけが落とす。
  toonify(model);
  addOutline(model);
  castShadows(model);
  prototypeModel = model;
}

interface PlayerVisual {
  /**
   * 向き（ヨー）を持つ内側のノード。**外側のGroupのローカル軸は呼び出し側のもの**
   * （打者のバットのオフセット、スイングのヨー回転）なので、モデルの向きを外側に
   * 持たせると打席の座標系が壊れる。向きはここで持ち、外側の軸には触らない。
   */
  facing: THREE.Object3D;
  /** この選手だけの色を塗るマテリアル（複製元と共有しない＝1人塗ると全員変わる、が起きない） */
  uniform: THREE.MeshToonMaterial[];
  /** 関節ノード（姿勢はここを回す） */
  joints: Joints;
  /** 手（取り付け口） */
  hands: Hands;
  /** 歩調（進んだ距離の累積 m）。`movePlayerTo` が伸ばし、走りの姿勢が読む */
  gait: number;
  /** 直前に置いた位置（移動量から歩調と向きを起こすため） */
  last: THREE.Vector3;
  /**
   * 直前のフレームで動いていたか。**捕球の姿勢が「腕は捕球・脚は走り」を組み合わせる**
   * ために要る（追いかけながらグラブを出す野手が、最後の数メートルだけ足を止めて
   * 滑って見えるのを防ぐ）。
   */
  moving: boolean;
  /**
   * 投げる腕の側（グラブは反対の手。ブラッシュアップで追加）。捕球・座り込みの姿勢は
   * **グラブ側の腕で構える**ので、これを見て腕を選ぶ。既定は右投げ（グラブは +X の手）。
   */
  throwSide: PitchArmSide;
}

const visuals = new WeakMap<THREE.Group, PlayerVisual>();

/**
 * 選手1体を作る。`preloadPlayerModel()` の完了後にだけ呼べる。
 *
 * 呼ぶ前に読み込みが済んでいないのは**呼び出し順の誤り**なので、黙って箱人間へ
 * 落とさずに投げる（落とすと「なぜか1人だけ箱」が実機で見つかるまで気づけない）。
 */
export function createPlayer(color: number): THREE.Group {
  if (!prototypeModel) {
    throw new Error('createPlayer: preloadPlayerModel() を先に await すること');
  }
  const group = new THREE.Group();
  const facing = new THREE.Object3D();
  group.add(facing);

  // clone はジオメトリとマテリアルを共有する（＝14メッシュぶんの頂点は1つで済む）。
  // 塗り替える必要があるユニフォームのマテリアルだけ、この選手専用に複製する。
  const model = prototypeModel.clone(true);
  facing.add(model);

  const uniform: THREE.MeshToonMaterial[] = [];
  const found = new Map<string, THREE.Object3D>();
  model.traverse((obj) => {
    // **先に見つかった（＝階層の浅い）ノードを関節とする**。材質が複数ある部位は
    // glTF で「関節ノード＋材質ごとのメッシュ」に分かれるので、同名の子に上書きさせない
    if (obj.name && !found.has(obj.name)) found.set(obj.name, obj);
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    const material = mesh.material as THREE.Material;
    if (material.name !== UNIFORM_MATERIAL_NAME) return;
    const own = material.clone() as THREE.MeshToonMaterial;
    mesh.material = own;
    uniform.push(own);
  });

  const joints = {} as Joints;
  for (const name of JOINT_NAMES) {
    const node = found.get(name);
    if (!node) {
      throw new Error(`createPlayer: モデルに関節ノード ${name} が無い（player.glb の階層を確認）`);
    }
    joints[name] = node;
  }

  // 手は前腕の先（バットを持たせる位置）。モデルには無いノードなのでここで足す。
  const hands: Hands = {
    plusX: new THREE.Object3D(),
    minusX: new THREE.Object3D(),
  };
  hands.plusX.position.y = -FOREARM_LENGTH;
  hands.minusX.position.y = -FOREARM_LENGTH;
  joints.ArmLowerR.add(hands.plusX);
  joints.ArmLowerL.add(hands.minusX);

  visuals.set(group, {
    facing,
    uniform,
    joints,
    hands,
    gait: 0,
    last: new THREE.Vector3(),
    moving: false,
    throwSide: NEUTRAL_PITCH_ARM.side,
  });
  setPlayerColor(group, color);
  setPlayerPose(group, { kind: 'idle' });
  return group;
}

/**
 * チーム色（ユニフォーム）を塗り替える。味方識別・代打の色替え・バイクのオレンジ・
 * 乱闘の点滅／退場色がすべてここを通る。
 */
export function setPlayerColor(group: THREE.Group, color: number): void {
  const visual = visuals.get(group);
  if (!visual) return;
  for (const material of visual.uniform) material.color.setHex(color);
}

/**
 * 選手の向き（ワールドのヨー角、ラジアン）。**0 = +Z を向く**＝でっかいモードでは
 * 本塁側、ちっちゃいモードでは内野から本塁を向く向き。
 *
 * 外側のGroupではなく内側のノードを回すので、**打者のようにGroup自身のヨーを
 * 別の用途（スイング）に使っている呼び出し側と衝突しない**。
 */
export function setPlayerFacing(group: THREE.Group, yaw: number): void {
  const visual = visuals.get(group);
  if (!visual) return;
  visual.facing.rotation.y = yaw;
}

/**
 * 選手を実寸の何倍で描くか（フェーズLL-59）。**見た目だけの値**で、位置（足元）も
 * 判定も一切動かさない＝呼び出し側が書いた x,z はそのままの意味を持ち続ける。
 *
 * **向きのノード（内側）に掛ける**のは `setPlayerFacing` と同じ理由：外側のGroupの
 * ローカル軸は呼び出し側のもの（打者のバットのオフセット、スイングのヨー）なので、
 * そこへ倍率を掛けると打席の座標系ごと伸びてしまう。内側に掛ければ**持ち物
 * （バット・銃・バイク）も手や腰の子なので一緒に大きくなる**＝「選手だけ大きくて
 * 乗っている車体は実寸」が構造的に起きない。
 *
 * 拡大は**足元から上へ**伸びる（原点が接地面）ので、地面にめり込むことも浮くこともない。
 *
 * 使うのはちっちゃいモードだけ（`CHICCHAI_PLAYER_SCALE`）。でっかいモード・乱闘は
 * 元からカメラが寄っているので実寸のまま＝**呼ばなければ 1.0 倍**。
 */
export function setPlayerScale(group: THREE.Group, scale: number): void {
  const visual = visuals.get(group);
  if (!visual) return;
  visual.facing.scale.setScalar(scale);
}

/**
 * 位置を書きつつ、歩き/走りを起こす（フェーズE-25-(c)）。
 *
 * **歩調も向きも「実際に動いた量」から導出する**のが要点：呼び出し側は速度も向きも
 * 別に持たなくてよく、**見た目と実際の動きが食い違うことが構造的に起きない**
 * （B-9で打席の立ち位置と死球ゾーンを同じ定数から求めたのと同じ整理）。走者の走力
 * （RUN）で足の速さが違えば、そのぶん足の回転も自然に速くなる。
 *
 * 姿勢は動いていれば `run`・止まっていれば `idle` を**この関数が書く**ので、
 * 野手・走者の呼び出し側は位置を書くだけでよい。別の姿勢を出したい呼び出し側
 * （捕球・打席の構え）は**この後に `setPlayerPose` を呼ぶ**（後勝ち）。
 *
 * @param snap 瞬間移動（プレー開始の配置・守備位置のリセット）。歩調も向きも動かさない
 * @param turn false なら向きを進行方向へ合わせない（打者のように向きが別の理由で決まる場合）
 * @param pose false なら姿勢を書かない（歩調だけ積む＝姿勢は呼び出し側が決める）
 */
export function movePlayerTo(
  group: THREE.Group,
  x: number,
  y: number,
  z: number,
  opts: { snap?: boolean; turn?: boolean; pose?: boolean } = {},
): void {
  const visual = visuals.get(group);
  group.position.set(x, y, z);
  if (!visual) return;
  const dx = x - visual.last.x;
  const dz = z - visual.last.z;
  visual.last.set(x, y, z);
  const writePose = opts.pose !== false;
  if (opts.snap) {
    visual.moving = false;
    if (writePose) setPlayerPose(group, { kind: 'idle' });
    return;
  }
  const dist = Math.hypot(dx, dz);
  if (dist <= MOVE_EPSILON) {
    visual.moving = false;
    if (writePose) setPlayerPose(group, { kind: 'idle' });
    return;
  }
  visual.moving = true;
  visual.gait += dist;
  // モデルの正面は +Z なので、進む向きのヨーは atan2(dx, dz)
  if (opts.turn !== false) setPlayerFacing(group, Math.atan2(dx, dz));
  if (writePose) setPlayerPose(group, { kind: 'run' });
}

/**
 * バットを打者の手に持たせる（フェーズE-25-(c)）。**どちらの手に持たせるかは打席の
 * 左右から決まる**ので、呼び出し側はモデルのL/Rを知らない（B-9の鏡像の延長）。
 * 打席が替わる（両打ち・代打）たびに呼べば付け替わる。
 *
 * バットは**手のノードの子**になるので、構え・スイング・バントの腕のポーズに
 * 必ず追従する＝「腕は下ろしたままバットだけ宙に浮く」が構造的に起きない。
 */
/**
 * 体の一部に物を付ける（乱闘v3。フェーズXX-72）。**拳の炎・足の風・武器**がその部位に
 * 付いてくる＝姿勢を動かせば必ず追従する（バット・銃と同じ「手のノードの子」の考え方）。
 * 部位の名前は乱闘の姿勢（`fighterPoses.ts`）と同じ：左右はモデルの左右（+X＝R）。
 */
export type BodyMount =
  | 'handR'
  | 'handL'
  | 'footR'
  | 'footL'
  | 'head'
  | 'torso'
  | 'pelvis'
  | 'armUpperR'
  | 'armUpperL';

export function attachToBody(group: THREE.Group, obj: THREE.Object3D, mount: BodyMount): void {
  const visual = visuals.get(group);
  if (!visual) return;
  const j = visual.joints;
  const target: Record<BodyMount, THREE.Object3D> = {
    handR: visual.hands.plusX,
    handL: visual.hands.minusX,
    footR: j.FootR,
    footL: j.FootL,
    head: j.Head,
    torso: j.Torso,
    pelvis: j.Pelvis,
    armUpperR: j.ArmUpperR,
    armUpperL: j.ArmUpperL,
  };
  target[mount].add(obj);
}

/**
 * 選手の足元（向きのノード）に物を付ける。**姿勢には引きずられず、向きと拡大だけに付いてくる**
 * （バイクと同じ付き方＝スケボー・ホバーの円盤・守備範囲の輪のような「地面側」の物）。
 */
export function attachToFacing(group: THREE.Group, obj: THREE.Object3D): void {
  visuals.get(group)?.facing.add(obj);
}

export function attachBat(group: THREE.Group, bat: THREE.Object3D, side: BatterSide): void {
  const visual = visuals.get(group);
  if (!visual) return;
  gripHand(visual, side).add(bat);
}

/**
 * バットを握る手＝**捕手側（打者の後ろ側）の手**。`side`（＝ワールドXの鏡像の符号）が
 * +1 の打席（左打者。フェーズBB-49）はモデルのローカル +X 側が捕手を向くので plusX、
 * -1 の打席（右打者）はその鏡像。
 */
function gripHand(visual: PlayerVisual, side: BatterSide): THREE.Object3D {
  return side >= 0 ? visual.hands.plusX : visual.hands.minusX;
}

/**
 * 銃を投げる腕の手に持たせる（フェーズE-25-(e)）。バットと同じく**手のノードの子**に
 * なるので、構えの腕を動かせば銃が必ず付いてくる（「腕は下ろしたまま銃だけ宙に浮く」が
 * 構造的に起きない）。銃口の向きは `aim` の姿勢が書く。
 *
 * 銃モードを抜けたら**呼び出し側が `visible` を落とす**（外したり付け直したりはしない）：
 * 銃を持っているかどうかはスキルと残弾で決まる`GunController`の状態であって、
 * モデル側が覚えておくものではない。
 */
export function attachGun(
  group: THREE.Group,
  gun: THREE.Object3D,
  side: PitchArmSide = NEUTRAL_PITCH_ARM.side,
): void {
  const visual = visuals.get(group);
  if (!visual) return;
  gunHand(visual, side).add(gun);
}

/**
 * 銃を握る手＝**投げる腕の手**（フェーズCC-50）。`gripHand`（打席の左右でバットを
 * 握る手を選ぶ）と同じ形で、呼び出し側はモデルの L/R を知らないままでいられる。
 */
function gunHand(visual: PlayerVisual, side: PitchArmSide): THREE.Object3D {
  return side >= 0 ? visual.hands.plusX : visual.hands.minusX;
}

/**
 * バイクにまたがらせる（フェーズE-25-(e)）。**向きのノードの子**にするのが要点で、
 * こうすると**進行方向へ向き直れば車体も一緒に向く**（`movePlayerTo` が書く向きに
 * そのまま乗る）が、**姿勢（関節）には引きずられない**＝またがっている脚を動かしても
 * 車体は水平のまま。部品の原点はシートの真下なので、位置合わせの数値は要らない。
 */
/**
 * グラブ（捕手はミット）を**投げない側の手**に持たせる（ブラッシュアップ：グラフィック）。
 * バット・銃と同じく手のノードの子なので、捕球の構えで腕を伸ばせばグラブが付いてくる。
 *
 * **何度呼んでもよい**（投げる側が変わったときだけ持ち替える）：マウンドの投手は継投で
 * 右投げ・左投げが入れ替わるので、呼び出し側は毎フレーム「いまの投げる腕」を渡せばよい。
 * 捕球・座り込みの姿勢はここで覚えた側を見てグラブ側の腕で構える＝見た目だけの値で、
 * 判定（捕球半径）には一切効かない。
 */
export function attachGlove(
  group: THREE.Group,
  glove: THREE.Object3D,
  throwSide: PitchArmSide,
): void {
  const visual = visuals.get(group);
  if (!visual) return;
  const hand = throwSide >= 0 ? visual.hands.minusX : visual.hands.plusX;
  if (glove.parent !== hand) hand.add(glove);
  visual.throwSide = throwSide;
}

export function attachBike(group: THREE.Group, bike: THREE.Object3D): void {
  const visual = visuals.get(group);
  if (!visual) return;
  visual.facing.add(bike);
}

/** 姿勢の計算に使い回す一時オブジェクト（毎フレーム18体ぶん作らないため） */
const scratchQuat = new THREE.Quaternion();
const scratchQuat2 = new THREE.Quaternion();
const scratchVec = new THREE.Vector3();
/** 手足が垂れている向き（バットは手のこの向きへ伸びる） */
const LIMB_DOWN = new THREE.Vector3(0, -1, 0);
/** モデルの正面（銃は部品のこの向きが銃口＝`entities/props.ts` の約束） */
const MODEL_FORWARD = new THREE.Vector3(0, 0, 1);

/**
 * **手に持たせた物をどちらへ向けるか**をモデル座標で指定する（フェーズE-25-(c)。
 * E-25-(e)で銃と共用にした）。
 *
 * 手首の角度を直接書く代わりに向きで書くのは、**持ち物の見え方を腕の角度から独立させる**
 * ため：構え・スイング・バント・銃の構えで腕をどう動かしても、持ち物は必ず指定した向きを
 * 向く（腕を1つ触るたびに手首の角度を測り直す、という調整のしかたを避ける）。
 * スイングは「構えの向き→振り抜きの向き」の補間だけで書ける。
 *
 * @param hand 握っている手のノード
 * @param propForward 部品のローカル座標で先端が向いている軸（バット＝-Y／銃＝+Z）
 */
function aimHeldProp(
  visual: PlayerVisual,
  hand: THREE.Object3D,
  propForward: THREE.Vector3,
  x: number,
  y: number,
  z: number,
): void {
  const j = visual.joints;
  const plusX = hand === visual.hands.plusX;
  const upper = plusX ? j.ArmUpperR : j.ArmUpperL;
  const lower = plusX ? j.ArmLowerR : j.ArmLowerL;
  // 手までの回転（骨盤は回さないので胴→上腕→前腕の3つで足りる）
  scratchQuat
    .setFromEuler(j.Torso.rotation)
    .multiply(scratchQuat2.setFromEuler(upper.rotation))
    .multiply(scratchQuat2.setFromEuler(lower.rotation));
  scratchVec.set(x, y, z).normalize();
  // 目標の向きを手のローカルへ引き戻してから、持ち物の先端をそこへ向ける
  scratchVec.applyQuaternion(scratchQuat.invert());
  hand.quaternion.setFromUnitVectors(propForward, scratchVec);
}

/**
 * **バットをどちらへ向けるか**をモデル座標で指定する（フェーズE-25-(c)）。
 *
 * モデル座標の約束（打者は本塁を向いて立つ）：
 *   +X * side = 捕手側（後ろ） / -X * side = 投手側 / +Z = 本塁側（体の正面）
 */
function aimBat(visual: PlayerVisual, side: BatterSide, x: number, y: number, z: number): void {
  aimHeldProp(visual, gripHand(visual, side), LIMB_DOWN, x * (side >= 0 ? 1 : -1), y, z);
}

/**
 * 姿勢を書く（フェーズE-25-(c)）。**毎フレーム呼んでよい**（全関節を毎回書き直すので、
 * 前の姿勢が残ることがない）。
 */
export function setPlayerPose(group: THREE.Group, pose: PlayerPose): void {
  const visual = visuals.get(group);
  if (!visual) return;
  const j = visual.joints;
  resetJoints(visual);
  switch (pose.kind) {
    case 'idle':
      applyIdle(j);
      break;
    case 'run':
      applyRun(j, visual.gait * GAIT_RADIANS_PER_METER);
      break;
    case 'catch':
      applyCatch(visual, pose.reach);
      break;
    case 'crouch':
      applyCrouch(visual);
      break;
    case 'stance':
      applyStancePose(visual, pose.side);
      if (pose.walking) applyRunLegs(j, visual.gait * GAIT_RADIANS_PER_METER, WALK_STRIDE_SCALE);
      break;
    case 'swing':
      applySwing(visual, pose.side, pose.key);
      break;
    case 'bunt':
      applyBunt(visual, pose.side);
      break;
    case 'pitch':
      applyPitch(j, pose.key, pose.arm);
      break;
    case 'throw':
      applyThrow(j, pose.t, pose.arm);
      break;
    case 'bike':
      applyBike(j);
      break;
    case 'aim':
      applyAim(visual, pose.t, pose.arm);
      break;
    case 'dropkick':
      applyDropkick(j, pose.t);
      break;
    case 'fallen':
      applyFallen(j, pose.t, pose.forward);
      break;
    case 'jump':
      applyJump(j, pose.lift);
      break;
    case 'dive':
      applyDive(j, pose.t);
      break;
    case 'fighter':
      applyFighterPose(j, pose.pose, POSE_KIT);
      break;
  }
}

/** 乱闘の姿勢へ貸す道具（モデルの寸法を知っている計算。`fighterPoses.ts` は寸法を書き写さない） */
const POSE_KIT: PoseKit = {
  flexLegs: (j, thigh, shin) => flexLegs(j as Joints, thigh, shin),
  groundedHipY: (thigh, shin) => groundedHipY(thigh, shin),
  hipHeight: HIP_HEIGHT,
};

/** 0..1 に丸める（進行度を受け取る姿勢が共通で使う） */
function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t));
}

/** 全関節を直立へ戻す（姿勢は必ずここから積み上げる＝前の姿勢の残りが混ざらない） */
function resetJoints(visual: PlayerVisual): void {
  for (const name of JOINT_NAMES) visual.joints[name].rotation.set(0, 0, 0);
  visual.joints.Pelvis.position.y = HIP_HEIGHT;
  visual.hands.plusX.quaternion.identity();
  visual.hands.minusX.quaternion.identity();
}

/**
 * 脚を曲げつつ**足の裏を地面に着けたままにする**。腰の高さは腿・脛の角度から導出し
 * （`groundedHipY`）、足首は曲げたぶんを打ち消して足の裏を水平に保つ。
 * これがあるので、しゃがみ・構えの深さを変えても足が地面へめり込まない。
 */
function flexLegs(j: Joints, thigh: number, shin: number): void {
  j.LegUpperL.rotation.x = thigh;
  j.LegUpperR.rotation.x = thigh;
  j.LegLowerL.rotation.x = shin;
  j.LegLowerR.rotation.x = shin;
  j.FootL.rotation.x = -(thigh + shin);
  j.FootR.rotation.x = -(thigh + shin);
  j.Pelvis.position.y = groundedHipY(thigh, shin);
}

/** 腿・脛の角度から「足の裏がちょうど地面に着く腰の高さ」を求める */
function groundedHipY(thigh: number, shin: number): number {
  return ANKLE_HEIGHT + THIGH_LENGTH * Math.cos(thigh) + SHIN_LENGTH * Math.cos(thigh + shin);
}

function applyIdle(j: Joints): void {
  j.ArmUpperL.rotation.z = -IDLE_ARM_SPREAD;
  j.ArmUpperR.rotation.z = IDLE_ARM_SPREAD;
  j.ArmLowerL.rotation.x = -IDLE_ELBOW;
  j.ArmLowerR.rotation.x = -IDLE_ELBOW;
}

/**
 * 走りの脚だけ（構えのまま歩く＝打者の入場でも使う）。
 * @param scale 歩幅の倍率。打席へ入る「歩き」は走りではないので小さくする
 */
function applyRunLegs(j: Joints, cycle: number, scale = 1): void {
  const s = Math.sin(cycle) * scale;
  j.LegUpperL.rotation.x = RUN_LEG_SWING * s;
  j.LegUpperR.rotation.x = -RUN_LEG_SWING * s;
  // 膝は「後ろへ振れている側」だけ曲げる（前へ出した脚は伸びる＝実際の走りと同じ）
  j.LegLowerL.rotation.x = RUN_KNEE_BEND * Math.max(0, s);
  j.LegLowerR.rotation.x = RUN_KNEE_BEND * Math.max(0, -s);
  j.FootL.rotation.x = -j.LegUpperL.rotation.x - j.LegLowerL.rotation.x * 0.5;
  j.FootR.rotation.x = -j.LegUpperR.rotation.x - j.LegLowerR.rotation.x * 0.5;
  j.Pelvis.position.y = HIP_HEIGHT;
}

function applyRun(j: Joints, cycle: number): void {
  applyRunLegs(j, cycle);
  const s = Math.sin(cycle);
  // 腕は同じ側の脚と逆へ振る
  j.ArmUpperL.rotation.x = -RUN_ARM_SWING * s;
  j.ArmUpperR.rotation.x = RUN_ARM_SWING * s;
  j.ArmLowerL.rotation.x = -RUN_ELBOW;
  j.ArmLowerR.rotation.x = -RUN_ELBOW;
  j.Torso.rotation.x = RUN_LEAN;
}

/**
 * 捕球：**腕は捕球の構え、脚は「いま実際に走っているか」から決める**。追いかけながら
 * グラブを出す野手の足が止まると、最後の数メートルだけ滑って見えるため。
 */
function applyCatch(visual: PlayerVisual, reach: number): void {
  const j = visual.joints;
  const r = Math.min(1, Math.max(0, reach));
  const lift = CATCH_ARM_LOW + (CATCH_ARM_HIGH - CATCH_ARM_LOW) * r;
  // グラブ側（投げない側）を高く、添える側はやや低く＝どちらで捕るかが読める
  const glove = gloveArms(visual);
  glove.upper.rotation.x = -lift;
  glove.bareUpper.rotation.x = -lift * 0.75;
  j.ArmUpperL.rotation.z = -0.25;
  j.ArmUpperR.rotation.z = 0.25;
  glove.lower.rotation.x = -0.35;
  glove.bareLower.rotation.x = -0.5;
  j.Torso.rotation.x = 0.12;
  if (visual.moving) applyRunLegs(j, visual.gait * GAIT_RADIANS_PER_METER);
  else flexLegs(j, -0.18, 0.3);
}

function applyCrouch(visual: PlayerVisual): void {
  const j = visual.joints;
  flexLegs(j, CROUCH_THIGH, CROUCH_SHIN);
  // 膝を外へ開く（捕手の座り方）
  j.LegUpperL.rotation.z = -0.3;
  j.LegUpperR.rotation.z = 0.3;
  j.Torso.rotation.x = -0.2;
  // ミットを前へ構え（投げない側の腕）、逆の手は下ろす
  const mitt = gloveArms(visual);
  mitt.upper.rotation.x = -1.35;
  mitt.lower.rotation.x = -0.55;
  mitt.upper.rotation.z = mitt.sign * 0.2;
  mitt.bareUpper.rotation.x = -0.4;
  mitt.bareLower.rotation.x = -0.7;
}

/**
 * グラブを持つ腕と、素手の腕。**投げる腕の反対がグラブ**（右投げ＝グラブは +X の手）。
 * sign はグラブ側の腕を外へ開く向き（+X の腕なら +1）。
 */
function gloveArms(visual: PlayerVisual) {
  const j = visual.joints;
  const plus = visual.throwSide < 0;
  return {
    upper: plus ? j.ArmUpperR : j.ArmUpperL,
    lower: plus ? j.ArmLowerR : j.ArmLowerL,
    bareUpper: plus ? j.ArmUpperL : j.ArmUpperR,
    bareLower: plus ? j.ArmLowerL : j.ArmLowerR,
    sign: plus ? 1 : -1,
  };
}

/**
 * 打席の構え＝**スイングの絵の1枚目**（`SWING_FRAMES.stance`）。左右の打席は `side` で
 * 鏡像になる（判定の鏡像＝B-9とまったく同じ符号を使う）。バントもここから組み立てる。
 */
function applyStancePose(visual: PlayerVisual, side: BatterSide): void {
  applyBatterFrame(visual, side, SWING_FRAMES.stance);
}

/** バントのバットの向き（体の前へ水平に出す） */
const BUNT_BAT_DIR = { x: -0.45, y: 0.05, z: 0.89 };
/**
 * バントの体のヨー（構えから投手側へ回した量 rad。スイングの絵の `yaw` と同じ約束＝
 * 呼び出し側が打者のGroupに掛ける）。バットを投手方向へ出して止めた角度。首の向きも
 * この値から決めるので、体の向きと首の向きが別々の数字から出ない（フェーズBBB-77）。
 */
export const BUNT_BODY_YAW = 0.95;

/**
 * スイングの絵（フェーズBBB-76→BBB-77。**原作の6枚**＝`core/keyframes.ts` の `SwingKey`。
 * 構えも1枚目として同じ形で持つ）。
 *
 * テストプレイ「バットを振ってから振り切った後のアニメーション絵が全然イメージと違う」
 * （BBB-76）→「まだ違和感ある。原作の動画をちゃんと見てほしい」（BBB-77）。原作のスイングは
 *
 * 0. `stance`：バットを立てて頭の後ろへ倒す（手は胸の前）
 * 1. `load`：バットを**後ろへ水平に寝かせる**（手は腰の前へ下りる）
 * 2. `lag`：**バットの先が手の後ろ下に残る**（手は前の腰。先は捕手側の下）
 * 3. `contact`：**本塁の前で水平**（当たる絵）
 * 4. `follow`：**右上へ振り上げる**（手は右肩の高さ）
 * 5. `finish`：**手が頭の左・あごの高さ、バットは頭の後ろを左上へ**
 *
 * の6枚を切り替える（ユーザー判断：コマ送り＝間を補間しない）。**打者の頭と足は6枚とも
 * 同じ位置**（膝を曲げた低い姿勢のまま振る）で、どの絵でも後頭部しか見えない＝ずっと
 * 投手のほうを見ている（BBB-77で原作の6枚を1ドットずつ読んだ）。
 *
 * **当たる絵（`contact`）だけは判定の形でもある**：バットを本塁の前の面に沿って
 * 球の通る高さに置き、判定の到達範囲（`BAT_REACH_*`）を覆う（描いたバットと当たる範囲が
 * 食い違わない）。他の5枚は判定に一切効かない（**見た目だけ**）。BBB-78で構えを直立に
 * したぶん肩が上がり、腕を伸ばし切っても握りは 1.10m までしか下がらないので、**バットの先を
 * わずかに下げて（先端 1.05m）球の通り道（本塁の前で 1.06m）を横切らせる**。
 */
interface SwingArm {
  /** 上腕の前後（負＝前へ上げる） */
  upperX: number;
  /** 上腕の開き（後ろの腕は捕手側・前の腕は投手側へ開く向きが正。打席の左右で鏡像） */
  upperZ: number;
  /** 肘の曲げ（負＝曲げる） */
  lowerX: number;
}

interface SwingFrame {
  /**
   * 体のヨー＝構えから投手側へ回した量 rad。**呼び出し側が打者のGroupに掛ける**
   * （`swingKeyYaw`）＝体ごと回る。腕とバットの向きはその回った体の中で書く。
   */
  yaw: number;
  /** バットを握る後ろの腕（捕手側） */
  back: SwingArm;
  /** 添える前の腕（投手側） */
  front: SwingArm;
  /** 上体の前傾（**正＝前へかぶさる**／負＝後ろへ反る。BBB-79で符号を正した） */
  torsoX: number;
  /** 上体のねじり（投手側へ回す向きが正） */
  torsoTwist: number;
  /**
   * バットの向き（**モデル座標**＝`aimBat` の約束：+x＝捕手側／+y＝上／+z＝本塁側）。
   * 体が `yaw` だけ回った後の座標なので、同じ向きの数字でも絵ごとに世界での向きは違う。
   */
  bat: { x: number; y: number; z: number };
  /** 前の脚の踏み込み（腿を前へ振る量 rad。負＝前） */
  stride: number;
  /**
   * 後ろの脚の返し（膝を曲げて踵を上げる量 rad）。原作の振り抜き・振り切りの絵は
   * **後ろの膝が前へ折れて踵が上がる**（腰を回し切った形）。
   */
  pivot: number;
}

/**
 * 6枚の絵の中身。**実機（Playwright）で原作の絵と並べて見ながら決めた**。腕の角度は、
 * 手とバットの先を置きたい場所（原作の絵から取った位置）へ**関節を解いて**出した値
 * （BBB-78で脚の曲げを変えたときに、同じ置き場所で解き直した）。
 */
export const SWING_FRAMES: Record<SwingKey, SwingFrame> = {
  stance: {
    yaw: 0,
    back: { upperX: 0.5, upperZ: 0.008, lowerX: -2.248 },
    front: { upperX: 0.412, upperZ: 1.162, lowerX: -1.183 },
    torsoX: 0.25,
    torsoTwist: 0,
    bat: { x: 0.3, y: 0.878, z: -0.373 },
    stride: 0,
    pivot: 0,
  },
  load: {
    yaw: 0.1,
    back: { upperX: 0.5, upperZ: 0.133, lowerX: -1.155 },
    front: { upperX: -0.29, upperZ: 0.69, lowerX: -0.038 },
    torsoX: 0.25,
    torsoTwist: 0.05,
    bat: { x: 0.156, y: -0.283, z: -0.946 },
    stride: -0.05,
    pivot: 0,
  },
  lag: {
    yaw: 0.55,
    back: { upperX: 0.5, upperZ: -0.007, lowerX: -1.195 },
    front: { upperX: 0.388, upperZ: 0.683, lowerX: -0.838 },
    torsoX: 0.2,
    torsoTwist: 0.2,
    bat: { x: 0.817, y: -0.503, z: 0.281 },
    stride: -0.2,
    pivot: 0.15,
  },
  contact: {
    yaw: 1,
    back: { upperX: -0.255, upperZ: 0.51, lowerX: -1.29 },
    front: { upperX: -0.902, upperZ: 0.845, lowerX: -0.102 },
    torsoX: 0.2,
    torsoTwist: 0.3,
    bat: { x: 0.783, y: 0, z: 0.622 },
    stride: -0.25,
    pivot: 0.3,
  },
  follow: {
    yaw: 1.35,
    back: { upperX: 0.055, upperZ: 1.013, lowerX: -2.137 },
    front: { upperX: 0.198, upperZ: 1.412, lowerX: -1.125 },
    torsoX: 0.05,
    torsoTwist: 0.4,
    bat: { x: 0.624, y: 0.602, z: 0.499 },
    stride: -0.2,
    pivot: 0.45,
  },
  finish: {
    yaw: 1.7,
    back: { upperX: -0.18, upperZ: -1.445, lowerX: -1.14 },
    front: { upperX: -0.21, upperZ: 0.413, lowerX: -2.033 },
    torsoX: 0.05,
    torsoTwist: 0.45,
    bat: { x: -0.706, y: 0.609, z: -0.362 },
    stride: -0.15,
    pivot: 0.55,
  },
};

/** その絵の体のヨー（構えから投手側へ回した量 rad。打者のGroupに掛ける） */
export function swingKeyYaw(key: SwingKey): number {
  return SWING_FRAMES[key].yaw;
}

/**
 * 打者の絵を1枚描く（構え・スイング共通。フェーズBBB-77）。**体のヨー（振り）は
 * 呼び出し側がGroupごと回している**ので、ここが描くのは「その絵の脚・腕・上体・首・
 * バットの向き」だけ。脚は構えの曲げの上に、前の脚の踏み込みと後ろの脚の返しを足す。
 */
function applyBatterFrame(visual: PlayerVisual, side: BatterSide, f: SwingFrame): void {
  const j = visual.joints;
  flexLegs(j, STANCE_THIGH, STANCE_SHIN);
  j.LegUpperL.rotation.z = -STANCE_FEET_SPREAD;
  j.LegUpperR.rotation.z = STANCE_FEET_SPREAD;
  // 捕手側（後ろ）がモデルの +X になるのが side=+1 の打席（左打者。BB-49）。もう一方は鏡像
  const sign = side >= 0 ? 1 : -1;
  const back = side >= 0 ? { upper: j.ArmUpperR, lower: j.ArmLowerR } : { upper: j.ArmUpperL, lower: j.ArmLowerL };
  const front = side >= 0 ? { upper: j.ArmUpperL, lower: j.ArmLowerL } : { upper: j.ArmUpperR, lower: j.ArmLowerR };
  back.upper.rotation.x = f.back.upperX;
  back.upper.rotation.z = sign * f.back.upperZ;
  back.lower.rotation.x = f.back.lowerX;
  front.upper.rotation.x = f.front.upperX;
  front.upper.rotation.z = sign * f.front.upperZ;
  front.lower.rotation.x = f.front.lowerX;
  j.Torso.rotation.x = f.torsoX;
  j.Torso.rotation.y = -sign * f.torsoTwist;
  // 首は投手のほうへ（体が回ったぶんだけ戻す＝どの絵でも投手を見ている）
  const headTurn = Math.PI / 2 - f.yaw - f.torsoTwist;
  j.Head.rotation.y =
    -sign * Math.min(BATTER_HEAD_TURN_MAX, Math.max(BATTER_HEAD_TURN_MIN, headTurn));
  // 前の脚（投手側）だけ踏み込む。足首で戻して足の裏は地面に向けたまま
  const frontLeg = side >= 0 ? { upper: j.LegUpperL, lower: j.LegLowerL, foot: j.FootL } : { upper: j.LegUpperR, lower: j.LegLowerR, foot: j.FootR };
  frontLeg.upper.rotation.x = STANCE_THIGH + f.stride;
  frontLeg.foot.rotation.x = -(frontLeg.upper.rotation.x + frontLeg.lower.rotation.x);
  // 後ろの脚（捕手側）は返す：膝を前へ折り、踵が上がる（つま先立ち）
  const backLeg = side >= 0 ? { upper: j.LegUpperR, lower: j.LegLowerR, foot: j.FootR } : { upper: j.LegUpperL, lower: j.LegLowerL, foot: j.FootL };
  backLeg.upper.rotation.x = STANCE_THIGH - f.pivot * 0.5;
  backLeg.lower.rotation.x = STANCE_SHIN + f.pivot;
  backLeg.foot.rotation.x = -(backLeg.upper.rotation.x + backLeg.lower.rotation.x) + f.pivot * 0.8;
  aimBat(visual, side, f.bat.x, f.bat.y, f.bat.z);
}

/** スイング（フェーズBBB-76）。その絵を描くだけ（絵の中身は `SWING_FRAMES`） */
function applySwing(visual: PlayerVisual, side: BatterSide, key: SwingKey): void {
  applyBatterFrame(visual, side, SWING_FRAMES[key]);
}

/** バント：バットを前へ出して止める（振り抜かないので進行度を持たない） */
function applyBunt(visual: PlayerVisual, side: BatterSide): void {
  applyStancePose(visual, side);
  const j = visual.joints;
  const sign = side >= 0 ? 1 : -1;
  // 首は投手のほうへ（構えより体を回しているぶんだけ戻す。`applyBatterFrame` と同じ考え方）
  j.Head.rotation.y =
    -sign *
    Math.min(BATTER_HEAD_TURN_MAX, Math.max(BATTER_HEAD_TURN_MIN, Math.PI / 2 - BUNT_BODY_YAW));
  const back = side >= 0 ? { upper: j.ArmUpperR, lower: j.ArmLowerR } : { upper: j.ArmUpperL, lower: j.ArmLowerL };
  const front = side >= 0 ? { upper: j.ArmUpperL, lower: j.ArmLowerL } : { upper: j.ArmUpperR, lower: j.ArmLowerR };
  back.upper.rotation.x = -0.85;
  back.upper.rotation.z = sign * 0.3;
  back.lower.rotation.x = -0.5;
  front.upper.rotation.x = -0.95;
  front.upper.rotation.z = sign * 0.55;
  front.lower.rotation.x = -0.35;
  j.Torso.rotation.x = 0.15;
  // バットを水平に寝かせて前へ出す
  aimBat(visual, side, BUNT_BAT_DIR.x, BUNT_BAT_DIR.y, BUNT_BAT_DIR.z);
}

/**
 * 投げる側の手足（フェーズCC-50）。**モデルの L/R ではなくワールドXの符号で選ぶ**ので、
 * 呼び出し側は「腕がどちら側にあるか」だけを知ればよい（`gripHand` が打席の左右で
 * 握る手を選ぶのとまったく同じ形）。踏み出す脚は投げる腕と反対＝軸足が腕の側に残る。
 */
function throwingLimbs(j: Joints, side: PitchArmSide) {
  const plus = side >= 0;
  return {
    armUpper: plus ? j.ArmUpperR : j.ArmUpperL,
    armLower: plus ? j.ArmLowerR : j.ArmLowerL,
    offUpper: plus ? j.ArmUpperL : j.ArmUpperR,
    offLower: plus ? j.ArmLowerL : j.ArmLowerR,
    strideUpper: plus ? j.LegUpperL : j.LegUpperR,
    strideLower: plus ? j.LegLowerL : j.LegLowerR,
    strideFoot: plus ? j.FootL : j.FootR,
    pivotUpper: plus ? j.LegUpperR : j.LegUpperL,
    pivotLower: plus ? j.LegLowerR : j.LegLowerL,
  };
}

/**
 * 投球モーションの絵（フェーズBBB-76。**原作の8枚**＝`core/keyframes.ts` の `PitchKey`）。
 *
 * 原作の投手は どの球でも同じ70フレームで、構え→両手を顔の前へ→頭上へ→足を上げる→
 * 腕を後ろへ引いて踏み出す→腕を頭の上へ担ぐ→リリース（前へ倒れ込む）→守備の構え、の
 * 絵を切り替える（ユーザー判断：コマ送り）。それまでは 0.35秒で「担いで振り出す」1本の
 * 動きだった。
 *
 * **リリースの絵だけは MM-60・CC-50 が決めた形そのまま**＝腕が前方水平（`PITCH_ARM_RELEASE`）・
 * 腕の角度（`ARM_SLOT_RAD`）・上体の傾き（`ARM_RELEASE_LEAN_RAD`）。球の出どころ
 * （`armReleaseHeight` / `armReleaseOffsetX`）はこの形から解いてあるので、**球は必ず手から出る**。
 * 他の7枚は判定に一切効かない（見た目だけ）。
 */
interface PitchArmPose {
  /** 上腕の前後（負＝前へ上げる／正＝後ろへ引く。腕は 2π 近くまで回せる） */
  upperX: number;
  /** 上腕の開き（その腕の側へ開く向きが正。負＝体の中央へ寄せる） */
  upperZ: number;
  /** 肘の曲げ（負＝曲げる） */
  lowerX: number;
}

interface PitchFrame {
  /** 投げる腕 */
  arm: PitchArmPose;
  /** グラブの腕 */
  off: PitchArmPose;
  /** 投げる腕を投げ方（上手・横手・下手）の角度へ倒すか（担ぐ・振り出す絵だけ） */
  slot: boolean;
  /** 踏み出す脚（腿の前後・膝・足首・腿の開き＝体を横へ向けたとき本塁の側へ出す量） */
  stride: { upperX: number; lowerX: number; footX: number; out?: number };
  /** 軸足（腿の前後・膝・腿の開き＝外側へ開く量） */
  pivot: { upperX: number; lowerX: number; out?: number };
  /** 上体の前後（正＝前へ倒れる） */
  torsoX: number;
  /** 上体のねじり（投げる腕を後ろへ引く向きが正） */
  torsoTwist: number;
  /**
   * 腰ごと横を向く量 rad（投げる腕の側を後ろへ引く向きが正＝右投げなら胸が三塁側）。
   * 足を上げる・腕を引く絵は体が横を向く＝**上げた膝が本塁から見て横へ出る**（原作の絵）。
   * 正面のまま上げると、膝がカメラの方へ向いて潰れて見えない。
   */
  hipTurn?: number;
  /** 腰を落とす量 m（直立の腰の高さからの差） */
  hipDrop: number;
}

/** 投手の8枚の絵。リリース以外は実機で原作の絵と並べて見ながら決めた（見た目だけ） */
export const PITCH_FRAMES: Record<PitchKey, PitchFrame> = {
  // 構え：グラブと手を胸の前で合わせる
  set: {
    arm: { upperX: -0.45, upperZ: -0.3, lowerX: -1.75 },
    off: { upperX: -0.45, upperZ: -0.3, lowerX: -1.75 },
    slot: false,
    stride: { upperX: 0, lowerX: 0, footX: 0 },
    pivot: { upperX: 0, lowerX: 0 },
    torsoX: 0,
    torsoTwist: 0,
    hipDrop: 0,
  },
  // 両手を合わせたまま顔の前へ上げる
  raise: {
    arm: { upperX: -1.25, upperZ: -0.25, lowerX: -1.7 },
    off: { upperX: -1.25, upperZ: -0.25, lowerX: -1.7 },
    slot: false,
    stride: { upperX: 0, lowerX: 0, footX: 0 },
    pivot: { upperX: 0, lowerX: 0 },
    torsoX: -0.05,
    torsoTwist: 0,
    hipDrop: 0,
  },
  // 両手を頭上へ（振りかぶり）
  overhead: {
    arm: { upperX: -2.85, upperZ: -0.2, lowerX: -0.7 },
    off: { upperX: -2.85, upperZ: -0.2, lowerX: -0.7 },
    slot: false,
    stride: { upperX: 0, lowerX: 0, footX: 0 },
    pivot: { upperX: 0, lowerX: 0 },
    torsoX: -0.12,
    torsoTwist: 0,
    hipDrop: 0,
  },
  // 足を高く上げる（体ごと横を向き、手は胸の前に下ろして体を縮める）
  kick: {
    arm: { upperX: -0.5, upperZ: -0.3, lowerX: -1.8 },
    off: { upperX: -0.5, upperZ: -0.3, lowerX: -1.8 },
    slot: false,
    stride: { upperX: -1.55, lowerX: 1.7, footX: -0.2 },
    pivot: { upperX: 0, lowerX: 0.15 },
    torsoX: -0.1,
    torsoTwist: 0.1,
    hipTurn: 1.25,
    hipDrop: 0.03,
  },
  // 腕を後ろへ引いて本塁へ踏み出す（グラブの腕は本塁へ向ける。引いた腕は背中の側へ
  // まっすぐ伸ばす＝体が横を向いているので、本塁から見て一塁側へ球が出て見える＝原作の絵）
  back: {
    arm: { upperX: 1.5, upperZ: 0.2, lowerX: -0.1 },
    off: { upperX: -1.3, upperZ: 0.2, lowerX: -0.3 },
    slot: false,
    stride: { upperX: -0.2, lowerX: 0.4, footX: 0, out: 0.75 },
    pivot: { upperX: 0.1, lowerX: 0.35 },
    torsoX: 0,
    torsoTwist: 0.3,
    hipTurn: 1.3,
    hipDrop: 0.12,
  },
  // 腕を頭の上へ担ぐ（踏み出した足は着いて、体は本塁へ向き直りかけている）
  cock: {
    arm: { upperX: 2.6, upperZ: 0, lowerX: -1.3 },
    off: { upperX: -1.1, upperZ: 0.1, lowerX: -0.6 },
    slot: true,
    stride: { upperX: -0.45, lowerX: 0.35, footX: 0.1, out: 0.35 },
    pivot: { upperX: 0.25, lowerX: 0.4 },
    torsoX: 0.05,
    torsoTwist: 0.1,
    hipTurn: 0.5,
    hipDrop: 0.08,
  },
  // リリース（MM-60・CC-50 の形そのまま。腕は前方水平＝この手から球が出る）
  release: {
    arm: { upperX: PITCH_ARM_RELEASE, upperZ: 0, lowerX: -0.2 },
    off: { upperX: -0.4, upperZ: 0, lowerX: -0.5 },
    slot: true,
    stride: { upperX: -0.55, lowerX: 0.15, footX: 0 },
    pivot: { upperX: 0, lowerX: 0 },
    torsoX: -0.1,
    torsoTwist: 0,
    hipDrop: 0.05,
  },
  // 投げ終わり（原作のリリースの絵＝低く前へ倒れ込む。腕は振り下ろして体の前を横切る）
  follow: {
    arm: { upperX: 5.7, upperZ: -0.5, lowerX: -0.3 },
    off: { upperX: -0.2, upperZ: 0.3, lowerX: -0.9 },
    slot: false,
    stride: { upperX: -1.0, lowerX: 1.1, footX: -0.1, out: 0.2 },
    pivot: { upperX: 0.55, lowerX: 0.7 },
    torsoX: 0.55,
    torsoTwist: -0.2,
    hipDrop: 0.22,
  },
  // 守備の構え（膝を外へ開いて腰を落とし、両手を前へ。顔は本塁へ向けたまま）
  field: {
    arm: { upperX: -0.9, upperZ: 0.25, lowerX: -0.6 },
    off: { upperX: -1.0, upperZ: 0.25, lowerX: -0.5 },
    slot: false,
    stride: { upperX: -0.9, lowerX: 1.4, footX: -0.5, out: 0.35 },
    pivot: { upperX: -0.9, lowerX: 1.4, out: 0.35 },
    torsoX: 0.15,
    torsoTwist: 0,
    hipDrop: 0.26,
  },
};

/**
 * 投球（フェーズBBB-76。原作の8枚を切り替える）。投げる腕は `arm.side` が決める
 * （フェーズCC-50）。腕の角度（`arm.slot`）は担ぐ・振り出す絵（`cock`・`release`）でだけ
 * 横へ倒す（`rotation.z` に入れる＝振り（`rotation.x`）に影響されない横成分）。
 * **上体の傾き（MM-60）はリリースの絵でだけ**倒す＝球の出どころ（`armReleaseHeight`）が
 * 想定している形と同じ。
 */
function applyPitch(j: Joints, key: PitchKey, arm: PitchArm = NEUTRAL_PITCH_ARM): void {
  const f = PITCH_FRAMES[key];
  const limbs = throwingLimbs(j, arm.side);
  limbs.armUpper.rotation.x = f.arm.upperX;
  limbs.armUpper.rotation.z = f.slot ? arm.side * ARM_SLOT_RAD[arm.slot] : arm.side * f.arm.upperZ;
  limbs.armLower.rotation.x = f.arm.lowerX;
  limbs.offUpper.rotation.x = f.off.upperX;
  limbs.offUpper.rotation.z = -arm.side * f.off.upperZ;
  limbs.offLower.rotation.x = f.off.lowerX;
  limbs.strideUpper.rotation.x = f.stride.upperX;
  // 本塁の側へ開く（踏み出す脚は投げる腕と反対の側＝その脚の外側へ開く向き）
  limbs.strideUpper.rotation.z = -arm.side * (f.stride.out ?? 0);
  limbs.strideLower.rotation.x = f.stride.lowerX;
  limbs.strideFoot.rotation.x = f.stride.footX;
  limbs.pivotUpper.rotation.x = f.pivot.upperX;
  limbs.pivotUpper.rotation.z = arm.side * (f.pivot.out ?? 0);
  limbs.pivotLower.rotation.x = f.pivot.lowerX;
  j.Torso.rotation.x = f.torsoX;
  // 投げる腕の側を後ろへ引く向きにねじる（右投げなら胸が三塁側を向く＝左肩が本塁を指す）
  j.Torso.rotation.y = arm.side * f.torsoTwist;
  // 上体を投げる側へ傾ける（フェーズMM-60）。リリースの絵だけ＝球の出どころと同じ形
  j.Torso.rotation.z = key === 'release' ? -arm.side * ARM_RELEASE_LEAN_RAD[arm.slot] : 0;
  // 腰ごと横を向く（右投げなら時計回り＝胸が三塁側）。リリースは正面（0）＝MM-60の形
  j.Pelvis.rotation.y = arm.side * (f.hipTurn ?? 0);
  j.Pelvis.position.y = HIP_HEIGHT - f.hipDrop;
}

/**
 * 送球（フェーズHH-55）。t は0（**リリースの瞬間**＝腕が前へ出切っている）→1（振り抜き）。
 *
 * **描くのはボールが手を離れた後だけ**。投球（`applyPitch`）が担ぎ上げから始まるのは、
 * 判定の側にワインドアップという時間が実在するから（`PITCH_WINDUP_SEC`）で、**送球には
 * それが無い**（送球時間は `距離 ÷ THROW_SPEED` をリリースの瞬間から数える）。担ぎ上げを
 * 見せるにはボールを待たせるしかなく、それは盗塁の窓・けん制の境界・内野ゴロの帰結を
 * まとめて動かす＝**判定を1行も触らないという約束のほうを優先した**。
 *
 * 腕の側と角度の扱いは投球とまったく同じ（`arm.slot` を `rotation.z` に入れる＝振りに
 * 影響されない横成分。CC-50）なので、**投手ゴロを処理した投手はでっかいモードと同じ腕で
 * 投げる**。
 */
function applyThrow(j: Joints, t: number, arm: PitchArm = NEUTRAL_PITCH_ARM): void {
  const p = clamp01(t);
  const limbs = throwingLimbs(j, arm.side);
  // 腕を横へ倒す（上手＝ほぼ真上／横手＝ほぼ水平／下手＝その中間）。投球と同じ定数。
  limbs.armUpper.rotation.z = arm.side * ARM_SLOT_RAD[arm.slot];
  // 投げる腕：前へ出切ったところ（リリース）から振り下ろす
  limbs.armUpper.rotation.x = lerp(PITCH_ARM_RELEASE, THROW_ARM_THROUGH, p);
  limbs.armLower.rotation.x = lerp(-0.35, 0.15, p);
  // グラブ側の腕は胸へ引き付ける（投げた腕と逆に動く＝体が回って見える）
  limbs.offUpper.rotation.x = lerp(-0.55, 0.25, p);
  limbs.offLower.rotation.x = lerp(-0.7, -0.3, p);
  // 上体は投げた勢いのまま前（+Z＝向いている先）へ出る
  j.Torso.rotation.x = lerp(0.05, THROW_LEAN, p);
  // 踏み出した脚は前に着いたまま、軸足が後ろへ流れる（1歩ぶん）
  limbs.strideUpper.rotation.x = lerp(-0.45, -0.3, p);
  limbs.strideLower.rotation.x = lerp(0.25, 0.15, p);
  limbs.pivotUpper.rotation.x = lerp(0.15, 0.45, p);
  limbs.pivotLower.rotation.x = lerp(0.2, 0.5, p);
  j.Pelvis.position.y = HIP_HEIGHT - lerp(0.02, 0.06, p);
}

// ---- スキル固有の姿勢（フェーズE-25-(e)） ----
//
// 回転の向き（`player.glb` の関節はすべて静止姿勢が無回転なので、素直に右手系で効く）：
//   **下へ垂れている手足**（rotation.x が正）→ 後ろ（-Z）へ振れる／負 → 前（+Z）へ
//   **上へ伸びている胴・骨盤**（rotation.x が正）→ 前（+Z）へ倒れる／負 → 後ろへ反る
// 骨盤は根なので、**正=「胴が前・脚が後ろ」（うつ伏せ／ダイビング）／負=「胴が後ろ・
// 脚が前」（ドロップキック／仰向け）** の2つの形がこれ1つで書ける。

/**
 * バイクにまたがる姿勢（★3メカ `バイク`。F-26-3）。角度は
 * `assets-src/props.blend` の寸法（シート上面 0.72m ／ハンドル＝腰の 0.66m 前・高さ1.00m ／
 * ステップ＝腰の 0.20m 前・高さ0.23m）から**逆算してある**＝部品を作り直したらここも
 * 一緒に直す（そうしないと走者がシートやステップから浮く）。
 */
const BIKE_HIP_Y = 0.76;
const BIKE_THIGH = -1.3;
const BIKE_SHIN = 1.95;
const BIKE_KNEE_SPREAD = 0.2;
const BIKE_LEAN = 0.3;
const BIKE_ARM_FORWARD = -1.25;
const BIKE_ARM_SPREAD = 0.22;
const BIKE_ELBOW = -0.3;

function applyBike(j: Joints): void {
  // 腰はシートに座る高さ（地面から導出する `groundedHipY` は使わない＝足は地面に着いて
  // いないので、着けようとするとステップから足が落ちる）
  j.Pelvis.position.y = BIKE_HIP_Y;
  j.Torso.rotation.x = BIKE_LEAN;
  j.LegUpperL.rotation.x = BIKE_THIGH;
  j.LegUpperR.rotation.x = BIKE_THIGH;
  j.LegLowerL.rotation.x = BIKE_SHIN;
  j.LegLowerR.rotation.x = BIKE_SHIN;
  // 膝はタンクを挟むように外へ開く
  j.LegUpperL.rotation.z = -BIKE_KNEE_SPREAD;
  j.LegUpperR.rotation.z = BIKE_KNEE_SPREAD;
  // 足の裏をステップと水平に保つ（`flexLegs` と同じ打ち消し）
  j.FootL.rotation.x = -(BIKE_THIGH + BIKE_SHIN);
  j.FootR.rotation.x = -(BIKE_THIGH + BIKE_SHIN);
  // 両腕をハンドルへ
  j.ArmUpperL.rotation.x = BIKE_ARM_FORWARD;
  j.ArmUpperR.rotation.x = BIKE_ARM_FORWARD;
  j.ArmUpperL.rotation.z = -BIKE_ARM_SPREAD;
  j.ArmUpperR.rotation.z = BIKE_ARM_SPREAD;
  j.ArmLowerL.rotation.x = BIKE_ELBOW;
  j.ArmLowerR.rotation.x = BIKE_ELBOW;
}

/**
 * 銃を構える姿勢（★3メカ `ジュウ`。F-26-2）。**撃つ腕（+X側＝銃を持たせた手）を
 * 打者の側へ伸ばし、もう一方を添える**。t=0 は構えの入り（腕を下ろした状態）なので、
 * 銃モードに入った瞬間から構え切るまでが1つの値で書ける。
 */
const AIM_ARM = -1.5;
const AIM_SUPPORT_ARM = -1.3;
const AIM_SUPPORT_ELBOW = -0.5;
const AIM_SUPPORT_INWARD = 0.32;

function applyAim(visual: PlayerVisual, t: number, arm: PitchArm = NEUTRAL_PITCH_ARM): void {
  const j = visual.joints;
  const p = clamp01(t);
  const s = arm.side >= 0 ? 1 : -1;
  const limbs = throwingLimbs(j, arm.side);
  flexLegs(j, -0.12, 0.22);
  j.LegUpperL.rotation.z = -0.16;
  j.LegUpperR.rotation.z = 0.16;
  j.Torso.rotation.x = 0.06 * p;
  // 撃つ腕は水平よりわずかに下へ伸ばし切る（肘はほぼ伸びる）
  limbs.armUpper.rotation.x = AIM_ARM * p;
  limbs.armLower.rotation.x = -0.05 * p;
  limbs.armUpper.rotation.z = s * 0.1 * p;
  // 添える腕は体の中心へ寄せて肘を曲げる（両手で構えている形が上からでも読める）
  limbs.offUpper.rotation.x = AIM_SUPPORT_ARM * p;
  limbs.offLower.rotation.x = AIM_SUPPORT_ELBOW * p;
  limbs.offUpper.rotation.z = -s * AIM_SUPPORT_INWARD * p;
  // **銃口は必ず正面（打者の側）へ向く**＝照準が乗っている先と構えている先が一致する
  aimHeldProp(visual, gunHand(visual, arm.side), MODEL_FORWARD, 0, 0, 1);
}

/**
 * ドロップキック（★2ボウリョク。F-26-4）。上体を反らせて両脚を前へ突き出す。
 * **当たっても外れても同じ動作**（外したときの代償は `fallen` が受ける）。
 */
const KICK_LEAN = -1.15;
const KICK_THIGH = -0.35;
const KICK_RISE = 0.26;
const KICK_ARM_BACK = 0.9;
/** 踏み切りから脚が伸び切るまでの割合（残りは伸ばしたまま着地する） */
const KICK_EXTEND_T = 0.3;

function applyDropkick(j: Joints, t: number): void {
  const p = clamp01(t);
  const ext = Math.min(1, p / KICK_EXTEND_T);
  // 体は跳ねて放物線を描く（着地で 0 に戻る）
  j.Pelvis.position.y = HIP_HEIGHT + KICK_RISE * Math.sin(Math.PI * p);
  // 骨盤ごと反らせるので、**胴は後ろ・脚は前**が1つの回転で揃う
  j.Pelvis.rotation.x = KICK_LEAN * ext;
  j.LegUpperL.rotation.x = KICK_THIGH * ext;
  j.LegUpperR.rotation.x = KICK_THIGH * ext;
  // 膝は伸ばし切る（蹴り足がそろって前へ出る）
  j.FootL.rotation.x = -0.3 * ext;
  j.FootR.rotation.x = -0.3 * ext;
  // 腕は後ろへ振って反りを支える
  j.ArmUpperL.rotation.x = KICK_ARM_BACK * ext;
  j.ArmUpperR.rotation.x = KICK_ARM_BACK * ext;
  j.ArmUpperL.rotation.z = -0.4 * ext;
  j.ArmUpperR.rotation.z = 0.4 * ext;
  j.ArmLowerL.rotation.x = -0.35;
  j.ArmLowerR.rotation.x = -0.35;
}

/**
 * 倒れて起き上がる（蹴り倒された野手＝仰向け／蹴りを外して転んだ走者＝うつ伏せ）。
 * t は倒れている時間ぜんぶの進行度で、**倒れる・伸びている・起き上がるの3区間**に割り振る
 * ＝呼び出し側は残り時間から作った1つの値を渡すだけでよい（`DROPKICK_DOWN_SEC` と
 * `DROPKICK_STUMBLE_SEC` の長さが違っても同じ関数で書ける）。
 */
const FALLEN_LEAN = 1.45;
const FALLEN_HIP_Y = 0.2;
/** 倒れ切るまで／起き上がり始めの位置（残りは地面に伸びている時間） */
const FALLEN_DOWN_T = 0.18;
const FALLEN_RISE_T = 0.78;

function applyFallen(j: Joints, t: number, forward: boolean): void {
  const p = clamp01(t);
  const lean =
    p < FALLEN_DOWN_T
      ? p / FALLEN_DOWN_T
      : p > FALLEN_RISE_T
        ? 1 - (p - FALLEN_RISE_T) / (1 - FALLEN_RISE_T)
        : 1;
  const sign = forward ? 1 : -1;
  j.Pelvis.rotation.x = sign * FALLEN_LEAN * lean;
  j.Pelvis.position.y = lerp(HIP_HEIGHT, FALLEN_HIP_Y, lean);
  // 手足を投げ出す（伸び切った棒ではなく「倒れている」に見せる）
  j.LegLowerL.rotation.x = 0.5 * lean;
  j.LegLowerR.rotation.x = 0.25 * lean;
  j.ArmUpperL.rotation.x = sign * 0.9 * lean;
  j.ArmUpperR.rotation.x = sign * 0.7 * lean;
  j.ArmUpperL.rotation.z = -0.7 * lean;
  j.ArmUpperR.rotation.z = 0.55 * lean;
  j.ArmLowerL.rotation.x = -0.3 * lean;
  j.ArmLowerR.rotation.x = -0.5 * lean;
  j.Torso.rotation.x = -0.15 * lean;
}

/**
 * ファインプレイのジャンプ（説明書p23）。**グラブ側（-X）の腕を真上へ伸ばし切り、
 * 脚を畳む**。lift は跳んでいる高さの進行度そのものなので、**腕が伸び切るフレームと
 * 最高到達点が必ず一致する**（E-25-(c)で投球の腕とリリースを同じ値から起こしたのと同じ）。
 */
const JUMP_GLOVE_ARM = -2.9;
const JUMP_FREE_ARM = -1.2;
const JUMP_THIGH = -0.55;
const JUMP_SHIN = 1.25;

function applyJump(j: Joints, lift: number): void {
  const p = clamp01(lift);
  // 伸ばす前は捕球の構えと同じ高さから始める（跳ぶ前後で腕が飛ばない）
  j.ArmUpperL.rotation.x = lerp(-CATCH_ARM_LOW, JUMP_GLOVE_ARM, p);
  j.ArmUpperR.rotation.x = lerp(-CATCH_ARM_LOW * 0.75, JUMP_FREE_ARM, p);
  j.ArmUpperL.rotation.z = -0.12;
  j.ArmUpperR.rotation.z = 0.3;
  j.ArmLowerL.rotation.x = -0.15 * (1 - p);
  j.ArmLowerR.rotation.x = -0.6;
  // 脚は畳む（真下から見ても「浮いている」と分かる）
  j.LegUpperL.rotation.x = JUMP_THIGH * p;
  j.LegUpperR.rotation.x = JUMP_THIGH * p * 0.6;
  j.LegLowerL.rotation.x = JUMP_SHIN * p;
  j.LegLowerR.rotation.x = JUMP_SHIN * p * 0.7;
  j.Pelvis.position.y = HIP_HEIGHT - 0.05 * p;
}

/**
 * ファインプレイの横っとび・ダイビング（説明書p23）。**体を水平に伸ばして腕を前へ出す**。
 * 跳んだ方向へは呼び出し側が実際に動かしているので、ここは「伸び切った形」だけを持つ
 * （向きは `movePlayerTo` が進行方向へ合わせる＝跳び込んだ先を向いて伸びる）。
 *
 * **起き上がるまで伸びたまま**にしてあるのは、跳んだ代償（`FINE_PLAY_DIVE_RECOVERY_SEC`
 * の間その野手だけ動けない）が姿勢で見えるようにするため。
 */
const DIVE_LEAN = 1.3;
const DIVE_HIP_Y = 0.34;
const DIVE_ARM = -2.85;

function applyDive(j: Joints, t: number): void {
  const p = clamp01(t);
  // 骨盤ごと前へ倒すので、**胴が前・脚が後ろ**（伸び切った飛び込みの形）が1つの回転で揃う
  j.Pelvis.rotation.x = DIVE_LEAN * p;
  j.Pelvis.position.y = lerp(HIP_HEIGHT, DIVE_HIP_Y, p);
  // 腕は頭より前へ（骨盤が倒れているので、この角度で「体の軸の先」へ伸びる）
  j.ArmUpperL.rotation.x = lerp(-CATCH_ARM_LOW, DIVE_ARM, p);
  j.ArmUpperR.rotation.x = lerp(-CATCH_ARM_LOW * 0.75, DIVE_ARM * 0.85, p);
  j.ArmUpperL.rotation.z = -0.2;
  j.ArmUpperR.rotation.z = 0.35;
  j.ArmLowerL.rotation.x = -0.1;
  j.ArmLowerR.rotation.x = -0.25;
  // 脚は軽く曲げて流す
  j.LegLowerL.rotation.x = 0.45 * p;
  j.LegLowerR.rotation.x = 0.3 * p;
  j.Torso.rotation.x = -0.1 * p;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
