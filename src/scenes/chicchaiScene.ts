/**
 * ちっちゃいモード：固定鳥瞰カメラ。本塁が画面下、外野が画面上（原作準拠のレイアウト）。
 * でっかいモードから引き継いだ打球の飛行表示に加え、守備（操作野手の移動・捕球・送球）と
 * 走塁（フォースされた走者の自動進塁）を実プレーとしてシミュレートし、
 * アウト/セーフ・進塁・得点を確定する（セッション4）。
 *
 * セッション7で「2P/CPU操作分離」を導入：どちらのチームの守備・走塁を人間が
 * 操作するか（isDefenseHuman）に応じて、フォース走者以外の走塁（B=進塁/A=帰塁、
 * sendRunner/recallRunner）を人間が操作できるようになった。
 *
 * フェーズD-20（2P PLAY）で**守備側と攻撃側が別々の人間になりうる**ようになったので、
 * 入力（`defensePad`/`offensePad`）と「人間か」の問い合わせ（`isDefenseHuman`/
 * `isOffenseHuman`）を側ごとに分けた。**CPUに任せる判断はすべて `isOffenseHuman` /
 * `isDefenseHuman` のうち該当する側だけを見る**（D-20より前は人間が1人だったので
 * `!isDefenseHuman()` が「攻撃はCPU」の代用として通っていた）。
 *
 * 守備はファミスタ'90説明書準拠（実機テストプレイの指摘対応・原作差分洗い出しで
 * 全面改修。差分表はPROGRESS.md参照）：
 * - 塁カバー4人（捕手=本塁/一塁手=一塁/二塁手=二塁/三塁手=三塁）は自動で塁に入る。
 * - 残り5人（P/SS/LF/CF/RF）は十字キーで「全員が同じ方向へ」一斉移動する
 *   （説明書p20「+で内・外野手をコントロール」）。CPU守備は最寄り野手が目標へ
 *   向かう方向を全員に適用する＝人間と同じ動かし方（コードパスを分けない）。
 * - 捕球はボタン入力なしの自動。塁カバー4人も含めた全野手が捕球候補
 *   （どの野手でもボールに触れれば捕る）。Aは送球専用。
 * - 送球はA+十字キーの絶対塁指定（上=二塁/左=三塁/右=一塁/下=本塁、説明書p21）。
 *   指示なしなら一塁へ。ボールは実際に塁へ飛んでいき、到着時に判定が発効する。
 * - 人間守備に自動送球はない（原作準拠）。全走者が到達しきったら少しの間を置いて
 *   「全員セーフ」でプレーを畳む（v1は走者が目標の塁で止まる簡易仕様のため）。
 *
 * v1スコープ（PROGRESS.md 未確定事項に記録）：
 * - フォースされた走者は「フォースされているかどうか」で自動的に進塁する
 *   （タッチプレー・けん制・盗塁は対象外）。フォースされていない走者は
 *   人間が攻撃側のときのみ任意に進塁を仕掛けられる（sendRunner/recallRunner）。
 * - 人間守備は連続送球ができる（一度投げても到着後 possessed に戻り、続けて別の塁へ
 *   投げられる＝二塁→一塁で併殺も可能）。各送球は対象走者1人だけを個別判定する
 *   増分モデル。CPU守備は1送球で完結（中継・連続送球はCPUには持たせない）。
 * - ランダンプレイ（説明書p25）：確保中にB+塁指定で、ボールを持った野手がその塁へ
 *   ダッシュする（指示なしは一塁）。走っている途中で塁間の走者に触れればタッチアウト。
 *   塁に着けば、そこへ向かっていた走者は間に合わなかった＝アウト。走り終えれば
 *   possessed に戻るので、そのまま別の塁へ投げられる（説明書p25の「ランナーを
 *   ランダンプレイで仕留めて1塁送球」＝併殺）。CPU守備は使わない（送球のみ）。
 * - 盗塁（説明書p13）：投球中に攻撃側がB+塁指定で走り出すとここへ切り替わる。捕手は
 *   投球が届く＋持ち替え（STEAL_CATCH_RELEASE_SEC）の後にしか投げられないので、
 *   **仕掛けた瞬間の投球の残り時間**が走者の持ち時間になる。決着はけん制と同じ
 *   runnerPlay（打席は終わらない）で、その球のカウントは呼び出し側が別途進める。
 * - フライ捕球時はタッチアップ（説明書p19）。走者は全員いったん元の塁へ戻り、その塁から
 *   進塁を仕掛けられる（人間の攻撃側はB+塁指定、CPU攻撃側は chooseCpuTagUp が即断）。
 *   守備側は持ち替えの時間（FLY_CATCH_RELEASE_SEC）を置いてから塁へ投げて刺せる。
 * - ファインプレイ（説明書p23）：打球の飛行中にA+方向で、ボールにもっとも近い野手
 *   （投手を除く）が跳ぶ。上=ジャンプで届く高さが伸び、左右・下は跳んだ方向へ
 *   burst移動しつつ捕球半径が伸びる。跳んだ後は起き上がるまで動けない＝外したときの
 *   コストがある。CPU守備は「跳べば届く」ときだけ跳ぶ（chooseCpuFinePlay）。
 * - ボールが静止しても猶予（RESTING_PICKUP_GRACE_SEC）の間はプレー続行で、野手が
 *   追いつけば拾って送球できる。猶予を過ぎたら「守備が間に合わなかった」として
 *   必ず安打（距離による単打/二塁打/三塁打の簡易分類。旧仮実装にあった
 *   「近距離＝アウト」の当て推量は撤去し、実プレーの捕球・送球のみでアウトを取る）。
 */
import * as THREE from 'three';
import { type Ballpark, DEFAULT_BALLPARK, fallbackHit } from '../core/ballpark';
import { type BattedBall, WALL_RESTITUTION, isFairPosition, stepBattedBall } from '../core/batting';
import {
  FOUL_BARRIER_HEIGHT,
  normalizeDeg,
  outerWallDistance,
  standSurfaceHeight,
} from '../core/stands';
import { FENCE_ANGLE_LIMIT_DEG } from '../core/ballpark';
import { STAND_STYLE } from './field';
import {
  type BaseKey,
  type CarriedLeads,
  type FielderId,
  type FinePlayKind,
  type FinePlayReach,
  type ForcedRunner,
  type LandingPrediction,
  type RunningLeg,
  type Vec2,
  BASE_ARRIVE_RADIUS,
  BASE_COVER_ASSIGNMENTS,
  BASE_POSITIONS,
  BIKE_CPU_RETURN_SEC,
  CATCH_RADIUS,
  BIKE_ENGAGE_SEC,
  BIKE_SPEED_SCALE,
  CONTROLLABLE_FIELDERS,
  DROPKICK_DOWN_SEC,
  DROPKICK_RANGE,
  DROPKICK_STUMBLE_SEC,
  FIELDER_HOME_POSITIONS,
  FIELDER_SPEED,
  FINE_PLAY_ACTIVE_SEC,
  FINE_PLAY_DIVE_RECOVERY_SEC,
  FINE_PLAY_DIVE_SPEED,
  FINE_PLAY_JUMP_RECOVERY_SEC,
  FLY_CATCH_RELEASE_SEC,
  LEAD_SPEED,
  MAX_LEAD,
  RUNNER_SPEED,
  STEAL_CATCH_RELEASE_SEC,
  STEAL_LEAD,
  THROW_SPEED,
  advancedBase,
  baseFromPadDirection,
  leadDirectionBase,
  bikeOverrunTarget,
  bikeOverrunsAt,
  chooseCpuFinePlay,
  chooseCpuHoldRelease,
  chooseCpuPickoffThrow,
  chooseCpuExtraBases,
  chooseCpuRundown,
  chooseCpuTagUp,
  chooseCpuThrowTarget,
  chooseRunnerCommand,
  chooseSendRunners,
  cpuLeadDistance,
  distance,
  dropkickLooseBallPos,
  dropkickTarget,
  dropkickWarnRange,
  finePlayFielder,
  finePlayKindFromPad,
  finePlayReach,
  forcedRunners,
  isForcePlay,
  leadPosition,
  nearestCatchableFielder,
  nearestFielder,
  originOf,
  predictLanding,
  predictLandingAt,
  recallTargetBase,
  sendableRunnerBases,
  shouldCpuActivateCatchEffect,
  shouldCpuBreakForNextBase,
  shouldCpuHold,
  shouldCpuRetreat,
  stealableBases,
  tagTarget,
  tagsOnTheWay,
  throwRetiresRunner,
} from '../core/fielding';
import {
  type BaseRunners,
  type Bases,
  type HitType,
  type RunnerId,
  ANONYMOUS_RUNNER,
  EMPTY_BASE_RUNNERS,
  OUTS_PER_HALF,
  advanceOnHitRunners,
  occupancy,
} from '../core/rules';
import {
  BALL_RADIUS as BALL_REAL_RADIUS,
  CHICCHAI_BALL_SCALE,
  CHICCHAI_DEFAULT_FOCUS,
  CHICCHAI_FOV_DEG,
  CHICCHAI_PLAYER_SCALE,
  CHICCHAI_TILT_DEG,
  CHICCHAI_VIEW_HALF_WIDTH,
  cameraDistance,
  cameraOffset,
  clampFocus,
  followFocus,
} from '../core/camera';
import { FOUL_RESULT_PAUSE_SEC, PLAY_RESULT_PAUSE_SEC } from '../core/tempo';
// 送球の腕（フェーズHH-55）。**この層は名鑑の語彙（ARM）を知らない**＝main.ts が
// `fielderThrowArm` で畳んだものを受け取るだけ（走力・捕球半径と同じ切り分け）。
import { type PitchArm, NEUTRAL_PITCH_ARM } from '../core/pitch';
import {
  attachBike,
  attachGlove,
  createPlayer,
  movePlayerTo,
  setPlayerColor,
  setPlayerFacing,
  setPlayerPose,
  setPlayerScale,
} from '../entities/player';
import { createProp } from '../entities/props';
import type { VirtualPad } from '../input/keyboard';

/**
 * ちっちゃいモードの追従カメラ（フェーズE-24）。原作どおり**打球・走者に寄った画面が
 * ボールを追ってスクロールする**。
 *
 * 旧実装はフィールド全体を1画面に収めた固定鳥瞰（高さ140m）で、選手が数ピクセルにしか
 * 映らず守備の手応えが薄かった（ファインプレイの跳躍が見た目でほぼ分からない一因でもある）。
 *
 * カメラ本体（＝main.ts が render/リサイズで触るもの）と、追従の状態をまとめて返す。
 * 寄り具合・追従の速さ・可動範囲の計算は core/camera.ts にあり、ここは
 * 「Three.jsのカメラをその計算どおりに置く」だけを担う。
 */
export interface ChicchaiCameraRig {
  camera: THREE.PerspectiveCamera;
  /**
   * 毎フレーム呼ぶ。focus はカメラが見るべき地点（プレー外は null）。
   * **null から値に変わった最初のフレームは補間せず瞬時に合わせる**＝モードの切り替えが
   * 瞬時カット（原作準拠）である以上、カメラが前のプレーの位置から滑ってきては
   * カットになっていない。
   */
  update(focus: Vec2 | null, dt: number): void;
}

export function createChicchaiCamera(aspect: number): ChicchaiCameraRig {
  const camera = new THREE.PerspectiveCamera(CHICCHAI_FOV_DEG, aspect, 0.1, 1000);
  /** 今カメラが見ている地点。null＝プレー外（次のプレーの初回で瞬時に合わせる） */
  let focus: Vec2 | null = null;

  /**
   * 見る地点からカメラの位置と向きを決める。**距離は毎回 camera.aspect から求め直す**ので、
   * ウィンドウの形が変わっても地面に映る横幅（＝寄り具合）は変わらない。
   */
  function place(at: Vec2): void {
    const offset = cameraOffset(
      cameraDistance(CHICCHAI_FOV_DEG, camera.aspect, CHICCHAI_VIEW_HALF_WIDTH),
      CHICCHAI_TILT_DEG,
    );
    camera.position.set(at.x, offset.y, at.z + offset.z);
    camera.lookAt(at.x, 0, at.z);
  }

  place(CHICCHAI_DEFAULT_FOCUS);

  return {
    camera,
    update(desired, dt) {
      if (desired === null) {
        focus = null;
        return;
      }
      const target = clampFocus(desired);
      focus = focus === null ? target : followFocus(focus, target, dt);
      place(focus);
    },
  };
}

// ---- 野手・走者のメッシュ ----

/**
 * 野手の色。**全員がこの1色**（フェーズUU-69）。
 *
 * セッション4（2026-07-20）には**「責任野手」を黄色で塗る目印**（`CONTROLLED_COLOR`）が
 * あり、根拠は「**鳥瞰は9人が同時に映るので操作対象を見失いやすい**」だった。
 * だが守備の操作は説明書p20準拠の**一斉移動**（十字キーで全員が同じ方向へ動く）なので、
 * **「操作対象」という単独の野手はそもそも存在しない**＝前提のほうが成り立っていなかった。
 *
 * 運んでいた情報も**すべてボール側が既に運んでいる**：飛行中は**ボールの影**が地面の位置を
 * 出し続け、確保後は**ボールが持ち主の上にある**（送球はその持ち主から出る）。
 * テストプレイの指摘「**ボールを取ったら黄色くなるのが謎**」はそのとおりで、
 * **塗るほど「ユニフォームの色が試合中に変わる」というノイズにしかならない**。
 *
 * 追う役そのものは今も導出している（`nearestFielder`）が、**使うのは X-45 のCPUの判断だけ**
 * ＝見た目には出さない。戻すとしても「**確保した後は塗らない**」が最低条件になる。
 */
const FIELDER_COLOR = 0x336699;
const RUNNER_COLOR = 0xcc3333;
/**
 * バイクに乗っている走者の色（フェーズF-26-3）。**誰が乗っているかは守備側にも見えないと
 * いけない**：オーバーランを狙うかどうかがそのまま送球先の判断だから（「意思決定材料は
 * 隠さない」方針）。降りたら元の色へ戻すので、色そのものが「いま止まれない」の表示になる。
 * 見た目は箱人間のままで、バイクそのものはE-25（グラフィック刷新）の範囲。
 */
const BIKE_RUNNER_COLOR = 0xff9900;
/**
 * ボールへ手を伸ばす姿勢（フェーズE-25-(c)）に入る距離。**見た目だけの値**で、
 * 捕球が成立する半径（`CATCH_RADIUS`=2.6m）とは別物＝この値を広げても狭めても
 * 捕れる範囲は1ミリも変わらない。捕球半径より広く取ってあるのは、
 * 「捕りにいっている」ことが捕る前から見えるようにするため。
 */
const CATCH_POSE_RANGE = 6;

export interface FielderEntity {
  id: FielderId;
  group: THREE.Group;
}

/**
 * ちっちゃいモードの選手を1体作る（フェーズLL-59）。**このモードの選手はここだけで作る**
 * ので、実寸より大きく描く倍率の掛け忘れが起きない（野手9人と走者4人の2か所に同じ
 * 1行を書くと、片方だけ実寸のまま残りうる）。倍率は見た目だけで判定には効かない。
 */
function createChicchaiPlayer(color: number): THREE.Group {
  const group = createPlayer(color);
  setPlayerScale(group, CHICCHAI_PLAYER_SCALE);
  return group;
}

/**
 * 野手ごとのグラブ（ブラッシュアップ：グラフィック）。**野手Groupから引ける形で持つ**
 * （bikeOf と同じ）＝投げる腕が変わったとき（継投でマウンドの投手が左右入れ替わる）に
 * 持ち替える先をここから引く。捕手だけはミット。
 */
const gloveOf = new WeakMap<THREE.Group, THREE.Object3D>();

/** 9守備位置のプレースホルダーを生成する（常時シーンに配置。表示/非表示の出し分けはしない）。 */
export function createFielders(): FielderEntity[] {
  return (Object.keys(FIELDER_HOME_POSITIONS) as FielderId[]).map((id) => {
    const group = createChicchaiPlayer(FIELDER_COLOR);
    const glove = createProp(id === 'C' ? 'Mitt' : 'Glove');
    attachGlove(group, glove, NEUTRAL_PITCH_ARM.side);
    gloveOf.set(group, glove);
    const pos = FIELDER_HOME_POSITIONS[id];
    // 定位置への配置は瞬間移動（走ってきたわけではない）
    movePlayerTo(group, pos.x, 0, pos.z, { snap: true });
    return { id, group };
  });
}

/** 走者メッシュのプール（打者走者＋一二三塁）。プレー開始まで非表示。 */
export interface RunnerPool {
  batter: THREE.Group;
  first: THREE.Group;
  second: THREE.Group;
  third: THREE.Group;
}

/**
 * 走者ごとの車体（フェーズE-25-(e)。★3メカ `バイク`／消費型 `ニトロ`）。
 * **走者Groupから引ける形で持つ**ので、走者ビジュアル（プレーごとに作り直される）側に
 * 部品の参照を持たせなくてよい＝プレーをまたいで車体が迷子にならない。
 */
const bikeOf = new WeakMap<THREE.Group, THREE.Object3D>();

export function createRunners(): RunnerPool {
  const make = () => {
    const g = createChicchaiPlayer(RUNNER_COLOR);
    // 車体は走者1人につき1台、最初から持たせて**表示だけ出し入れする**
    // （野手・走者のメッシュ自体と同じ扱い＝プレー中に作らない）
    const bike = createProp('Bike');
    bike.visible = false;
    attachBike(g, bike);
    bikeOf.set(g, bike);
    g.visible = false;
    return g;
  };
  return { batter: make(), first: make(), second: make(), third: make() };
}

/** 車体の表示（乗ったら出す／降りたら消す。色替えと同じ「いま止まれない」の合図） */
function showBike(group: THREE.Group, on: boolean): void {
  const bike = bikeOf.get(group);
  if (bike) bike.visible = on;
}

// ---- フィールドプレー（打球の引き継ぎ・守備・走塁） ----

/**
 * 打球の帰結。foul 以外はすべて result にまとめ、outs/runs/bases を確定させる
 * （アウト/安打/本塁打などの内訳は呼び出し側が個別に気にする必要はない）。
 */
export type FieldPlayOutcome =
  /**
   * bunt は**バントで転がした打球のファウル**か（フェーズAA-48）。呼び出し側は
   * これを見て判定を `foul` と `buntFoul` に振り分ける＝**バントのファウルだけは
   * ファウルの頭打ちが効かず、2ストライク後は三振**（説明書p32「実際の野球のルールに
   * できるだけ合わせてある」）。事実そのものは打球（`BattedBall.bunt`）が運んでくる
   * ので、このシーンは覚えておく状態を1つも増やしていない。
   */
  | { kind: 'foul'; bunt: boolean }
  /**
   * 走塁だけのプレー（けん制球。説明書p24）の決着。アウト・得点・塁状況は result と
   * 同じ意味だが、**打席は終わっていない**（カウント・打順は据え置き）ことを呼び出し側に
   * 伝えるために別の kind にしてある（gameMachine の RUNNER_PLAY_RESOLVED に対応）。
   */
  | {
      kind: 'runnerPlay';
      outsAdded: number;
      runs: number;
      baseRunners: BaseRunners;
      /**
       * 決着した時点で、塁上に残った走者がどれだけ塁を離れていたか（フェーズL-32）。
       * **次の投球の盗塁のスタート位置**になる＝早めに帰塁した走者は浅いリードのまま
       * 次の球を迎える（`core/fielding.ts` のリードの持ち越しの節を参照）。
       */
      leads: CarriedLeads;
    }
  | {
      kind: 'result';
      outsAdded: number;
      runs: number;
      /** 決着後にどの塁へ誰が残ったか（走力を持ち越すため識別つきで返す。フェーズB-8） */
      baseRunners: BaseRunners;
      /**
       * resultFromHit（打球が守備を上回った安打・本塁打）経由の決着でのみ設定される。
       * 守備プレー（releaseThrow の送球判定、attemptCatch のフライアウト）による
       * アウト/セーフはこのフィールドを持たない（呼び出し側は演出のトリガーに使う。
       * 判定そのものには一切影響しない）。
       */
      hit?: HitType;
      /**
       * 守備プレー（捕球・送球）の帰結を「アウト/セーフ」の文字バナーで見せるための印
       * （実機テストプレイの指摘：送球後にセーフ/アウトが分からない＝アウトの積み重ねが
       * 見えないため守備→攻撃の交代が唐突に感じる）。判定そのものには影響しない演出用。
       * hit（安打）とは排他で、安打のときは付かない。
       */
      defense?: 'out' | 'safe';
    };

const MAX_DT = 0.1;
/**
 * 鳥瞰カメラからでも見えるようにボールを拡大表示する（**倍率の定義は
 * `core/camera.ts`**＝選手の縮尺 `CHICCHAI_PLAYER_SCALE` の隣。フェーズNN-61で
 * ジオメトリが実寸になったので、ここは「実寸の何倍で描くか」を受け取るだけになった）。
 *
 * **見かけは NN-61 の前と変わらない**：従来は半径0.4mのジオメトリ × 1.5倍＝描いた
 * 半径0.6m で、実寸の16.4倍がちょうど同じ大きさになる（差 0.2mm＝0.0px）。
 */
const BALL_SCALE = CHICCHAI_BALL_SCALE;
/** 保険：万一静止しない場合の強制打ち切り秒数 */
const MAX_PLAY_SEC = 15;
/**
 * **描いた球の半径** m（＝地面に置くときの中心の高さ）。従来はジオメトリの 0.4m を
 * そのまま使っていたので、1.5倍に描いた球は 0.2m だけ地面にめり込んでいた
 * （フェーズNN-61で拡大後の半径から導出するようにして解消。真上から見下ろす画面なので
 * 見た目の差は 3.8px ぶん浮くだけで、判定にはもともと一切効かない）。
 */
const BALL_RADIUS = BALL_REAL_RADIUS * CHICCHAI_BALL_SCALE;
/**
 * 人間守備がボールを保持したまま「刺せる走者がいない」状態が続いたとき、プレーを
 * 畳むまでの猶予。原作に自動送球は無い（送球はプレイヤーがA+塁指定で行う。説明書p21）
 * ため送球の強制はしないが、v1は走者が目標の塁で止まる簡易仕様のため、これが無いと
 * 持ったまま永久にプレーが終わらない。この猶予は「送球のたびにリセットされる」ので、
 * 1塁でセーフになった直後でも、この秒数以内にもう一度A+塁指定を押せば2塁へ続けて
 * 投げられる（投げ続ける限りプレーは続き、投げ終えれば猶予後に確定する）。
 * 送球を見てから次の塁を指定して押す余裕を持たせるため、やや長め（1.5秒）にする。
 */
const HOLD_ALL_SAFE_SEC = 1.5;
/**
 * タッチアップ（説明書p19）の判断猶予。フライを捕った瞬間から、人間の攻撃側が
 * B（進塁）を押すのを待つ時間。誰も仕掛けなければこの時間でプレーを畳む。
 * 長めに取っても「遅く押すほど得」にはならない（releaseThrow の時間競争は送球開始
 * 時点の走者の残り距離で判定するため、仕掛けが遅れた分だけ走者が不利になる）。
 * CPUが攻撃側のときは chooseCpuTagUp が捕球の瞬間に即断するので、この猶予は
 * 「人間が攻撃側のときだけ」開く（＝仕掛けないフライアウトに間延びを作らない）。
 */
const TAG_UP_WINDOW_SEC = 1.8;
/** 送球ボールの飛行高さ（見た目のみ。判定は resolveDefensePlay の時間競争で行う） */
const THROW_BALL_HEIGHT = 1.2;
/**
 * 打球発生直後、捕球判定を無効にする時間。全野手を捕球候補にしたことで、
 * 本塁のすぐ後ろに立つ捕手（接触点から約2.5m＝捕球半径2.6mの内側）が
 * 打った瞬間のボールを初回フレームで「捕って」しまい、全打球が即フライアウトに
 * なる不具合があった。バットを離れて最初の数百ミリ秒は捕球なしとすることで、
 * 捕手の即捕りだけを防ぎつつ、捕手がバント・ボテボテのゴロを拾う正当なプレーは
 * 残す（0.3秒あればボールは最速の打球でも十数メートル先へ抜けている）。
 */
const CATCH_MIN_PLAY_SEC = 0.3;
/**
 * ボールが静止してから「守備が間に合わなかった」と見なして距離分類のヒットを
 * 確定するまでの猶予。この間に野手が追いつけば拾って（自動捕球）送球できる。
 * 値は「外野の定位置から静止球までのおおよその距離 ÷ FIELDER_SPEED」から逆算
 * （深い打球で約20m ÷ 8.5m/s ≈ 2.4秒。追跡開始が遅れがちな人間操作でも
 * 拾い直しの機会が実際にあるように少し余裕を持たせる）。
 *
 * **ただしこの猶予は「誰も近づいていないとき」にしか進まない**（テストプレイの指摘。
 * 下記 `restingT` の更新）。固定の2.5秒だけで打ち切ると、**20mより遠くで静止した打球は
 * 野手が全力で走っている最中に自動でヒットになる**（実機で再現：最寄りの野手が
 * 14.8m手前にいるのに二塁打が確定した）＝「まだ球を取ってもいないのに次の打者へ移る」。
 * 逆に**誰も近づいていなければ従来どおり2.5秒で打ち切る**ので、守備が動かないときの
 * テンポは1mmも変わらない。プレー全体には `MAX_PLAY_SEC` の上限があるので、
 * 近づき続ける限り待つ形にしても決着しないことは起きない。
 */
const RESTING_PICKUP_GRACE_SEC = 2.5;
/**
 * 決着後の余韻（フェーズWW-71）で、走っていた野手が止まり切るまでの秒数。**見た目だけ**の
 * 値（判定からは一度も読まない）。急停止させると決着の瞬間に全員が固まって一時停止に見える。
 */
const AFTERMATH_COAST_SEC = 0.6;
/**
 * ファウルで元の塁へ戻る走者・守備位置へ戻る野手の速さ（走力・野手の足の何倍か）。
 * 小走り＝プレーがもう終わっていることが動きで分かる
 */
const AFTERMATH_JOG_SCALE = 0.55;
/** 決着してから、ボールを持った野手が投手へ返し始めるまで（見た目だけ） */
const AFTERMATH_TOSS_DELAY_SEC = 0.45;
/** 投手へ返す山なりの送球の速さ m/s（見た目だけ。本物の送球 `THROW_SPEED` よりずっと緩い） */
const AFTERMATH_TOSS_SPEED = 15;
/** 余韻の間、走者がこの距離まで塁に寄ったら止める（m） */
const AFTERMATH_STOP_DISTANCE = 0.05;
/** CPU守備が確保後に送球するまでの反応時間（人間の1.5秒待ちより短く即応させる） */
const CPU_POSSESSED_REACTION_SEC = 0.25;
/**
 * けん制モード（説明書p24）を続けられる時間。これを過ぎたら投球へ戻る
 * （＝投手はいつまでも走者とにらみ合っていられない）。
 *
 * この上限が「けん制はタイミングの判断である」ことを成立させている：リードは
 * LEAD_SPEED で育つので、投げるのが早すぎると浅くて刺せず、待ちすぎると窓が閉じて
 * 1球ぶんのけん制の機会を失う。CPU走者がもっとも深くリードするのに約2.1秒
 * （CPU_LEAD_AGGRESSIVE / LEAD_SPEED）かかるので、それより十分長く、しかし
 * 「待てば必ず刺せる」にはならない長さにしてある。
 */
const PICKOFF_WINDOW_SEC = 3;
/**
 * CPU投手のけん制で、**走者が誰も塁を離れないまま**この秒数が過ぎたら窓を閉じる
 * （フェーズII-56）。人間の走者はリードを押している間しか取らないので、押されなければ
 * 投げる候補が永久に生まれない＝3秒の窓は「待つ意味のない待ち時間」になる。
 * 押し始めればリードが0を超えてこのタイマーは戻るので、**にらみ合いそのものは短くならない**。
 */
const PICKOFF_IDLE_SEC = 0.8;
/**
 * けん制モードでCPU投手が「走り出した／帰塁を始めた走者」に反応して投げるまでの時間。
 * ボールを持って走者を見ている状態なので、打球の守備（CPU_POSSESSED_REACTION_SEC）より
 * ずっと速く反応する。この値が人間の走者にとっての「帰塁（A）が遅れたら刺される」
 * 境界を決める（詳細はPROGRESS.md）。
 */
const CPU_PICKOFF_REACTION_SEC = 0.08;
/** CPU守備がこれ以下に近づけば目標地点に到達したとみなす（震動防止） */
const CPU_SEEK_EPSILON = 0.05;
/** ファインプレイの見た目（判定には一切影響しない）：ジャンプで浮く高さ */
const FINE_PLAY_JUMP_LIFT = 1.6;
/**
 * ドロップキックの蹴りを見せる時間（フェーズE-25-(e)。見た目だけの値で、判定は
 * `performDropkick` がこの秒数を待たずに即決している＝**当たり判定と見た目の時計を
 * 分けてある**。当てた瞬間に効果が出るのは、蹴られた側の1.5秒が「蹴られた瞬間から」
 * 始まるほうが読みやすいから）。
 */
const DROPKICK_KICK_SEC = 0.45;
/**
 * 送球のフォロースルーを見せる時間（フェーズHH-55。**見た目だけの値**＝蹴りの0.45秒に
 * 続く2つ目の例外で、判定は `releaseThrow` がこの秒数を待たずに release の瞬間に確定
 * している）。**飛行時間から導出しない**のは、送球が 0.06秒（ランダンの至近距離）から
 * 3秒（外野からの本塁送球）まで50倍も開くから＝短い送球では動作が1フレームも見えず、
 * 長い送球では投げ終わった姿勢のまま固まる。振り抜きは投げた本人の動作なので、
 * ボールがどこまで飛ぶかとは本来無関係でよい。
 */
const THROW_POSE_SEC = 0.4;
/** 操作野手が場外へ出ないようにする移動範囲 */
const FIELDER_BOUND_RADIUS = 98;

/**
 * carrying＝ランダンプレイ（説明書p25）でボールを持った野手が塁へダッシュしている最中。
 * possessed（確保して止まっている）と対で、どちらからもA=送球・B=塁の指示し直しができる。
 */
/**
 * 'loose' はドロップキック（フェーズF-26-4）で叩き落とされたボールが地面にある状態。
 * **持ち主がいない possessed** として扱い、野手の動き方は打球の飛行中とまったく同じ
 * （塁カバーは塁へ、残りは一斉移動／CPUはボールを追う）。誰かが捕球半径に入れば
 * possessed へ戻る。蹴られた野手の足元（CATCH_RADIUS の内側）に落ちるので、
 * **遅くとも当人が起き上がった瞬間に拾い直される**＝プレーが宙に浮かない。
 */
type PlayPhase =
  | 'flying'
  | 'possessed'
  | 'carrying'
  | 'throwing'
  | 'loose'
  | 'resolved'
  | null;

interface RunnerVisual {
  mesh: THREE.Group;
  /** この走者の起点（打者走者は 'batter'）。sendRunner/recallRunner の対象検索に使う */
  origin: ForcedRunner['from'];
  /**
   * 走者そのもの（PlayerId）。決着時にどの塁へ誰が残ったかを返すために持つ
   * （＝次の打席へ走力を持ち越せる。フェーズB-8）。
   */
  id: RunnerId;
  /**
   * この走者の走る速さ m/s（走力＝RUNから決まる。fielding.ts の runnerSpeed）。
   * 全走者が一律だった RUNNER_SPEED を置き換えるもので、**移動にも送球との時間競争にも
   * 同じ値を使う**（見た目と判定が食い違わない）。
   */
  speed: number;
  pos: Vec2;
  target: Vec2;
  /**
   * 今この走者が走っている区間（null=塁上に留まっている）。進塁は {from: 起点, to: 次の塁}、
   * 帰塁は {from: 起点, to: 起点}＝行き先が起点そのものになる。この1本で表すことで、
   * 送球の時間競争（runnerHeadingTo）も決着（finalizePlay）も進塁・帰塁を区別せず
   * 同じ処理で扱える（＝帰塁中の走者も、その塁へ投げれば刺せる）。
   */
  forced: ForcedRunner | null;
  /**
   * いま走っている区間が**フォースプレー**か＝行き先の塁を踏まれるだけでアウトになるか
   * （フェーズK-31。`core/fielding.ts` の `isForcePlay` / `throwRetiresRunner`）。
   *
   * 打者走者と、打者に押し出されて走る義務のある走者だけが true。自分で仕掛けた進塁・
   * 盗塁・タッチアップ・帰塁はすべて false ＝**タッチしないとアウトにならない**。
   * `forced`（走行区間）とは別に持つのが要点で、区間はどちらの走者も同じ形で表せる
   * （進塁・帰塁を1本の {from,to} で扱う既存の整理を崩さない）。
   */
  forcePlay: boolean;
  /** 帰塁中（forced.to === origin）。表示・候補判定の意図を明示するための冗長フラグ */
  returning: boolean;
  /** 送球で刺された（アウト）。連続送球の増分判定で個別に立てる */
  out: boolean;
  /** 目標塁に到達して止まった（セーフ確定）。到達後は送球でも刺せない */
  arrived: boolean;
  /**
   * けん制モード（説明書p24）で塁を離れている距離（m）。塁上（forced===null）の間だけ
   * LEAD_SPEED で育ち、けん制球を投げられると帰塁が始まる＝この距離が送球との
   * 時間競争の持ち時間そのものになる。打球のプレーでは常に0。
   */
  lead: number;
  /**
   * このプレーで**一度でも塁を離れたか**（フェーズII-56）。人間の走者はリードを
   * 押している間しか取らないので、**離れていない走者と、離れてから帰塁した走者を
   * 区別する**ために要る（どちらも `lead` は0）。持ち越し（L-32）は前者では起きず、
   * 後者では「リード0を持ち越す」＝早めに帰塁した代償がそのまま残る。
   */
  ledOff: boolean;
  /** スキル `バイク` を持っている（乗れる／乗るかは別。フェーズF-26-3） */
  bikeCapable: boolean;
  /** いまバイクに乗って走っている（速さが BIKE_SPEED_SCALE 倍になる） */
  bike: boolean;
  /**
   * このプレーで一度でも点火した。**1プレーに1回しか点火できない**ことがCLAUDE.md ⑥の
   * 「野手に追いつかれうる＝挟殺の読み合いが成立する」を守っている：エンジンをかけ直せる
   * なら、走者は塁間を2倍速で往復して野手（8.5m/s）から永久に逃げられてしまう。
   */
  bikeUsed: boolean;
  /**
   * 曲がれずに塁を行き過ぎている（`target` は塁ではなくオーバーラン地点）。
   * **踏んだ塁は `forced.to` のまま**なので、送球の対象も決着後の落ち着き先も進塁と共通で、
   * オーバーラン専用の分岐を判定側に持たずに済む（帰塁を forced の行き先の差し替えで
   * 表しているのと同じ整理）。この間は塁を踏んでいないので arrived にはしない。
   */
  overrun: boolean;
  /** オーバーランしてからの経過秒（CPU走者が自動で帰塁を始めるまでの計時） */
  overrunSec: number;
  /** スキル `ドロップキック` を持っている（蹴れる／蹴るかは別。フェーズF-26-4） */
  dropkickCapable: boolean;
  /**
   * このプレーで一度でも蹴った（**空振りでも消費する**）。バイクの `bikeUsed` と同じ規則で、
   * これが無いと近寄ってくる野手を連打で薙ぎ倒せてしまい、挟殺（CLAUDE.md ⑥の設計不変条件）
   * という概念そのものが消える。
   */
  dropkickUsed: boolean;
  /**
   * 空振りして転んでいる残り時間 s（フェーズF-26-4）。0より大きい間は走らない。
   *
   * **判定側には「時間」の形でだけ持ち込む**（timeToSafety に足す）ので、送球との時間競争は
   * 転倒専用の分岐を持たずにそのまま走者不利へ傾く。バイクのオーバーランを
   * 「塁を踏むまでの残り時間＝無限大」で表したのと同じ整理。
   */
  stumbleSec: number;
  /**
   * 蹴りの動作を見せている残り時間 s（フェーズE-25-(e)。**見た目だけ**）。
   * 判定は蹴った瞬間に済んでいるので、この値は行動不能・転倒の秒数とは独立で、
   * **0でも判定は何も変わらない**（アニメを消してもゲームは同じに動く）。
   */
  kickSec: number;
  /**
   * 投球の前にスタートを切っていた走者（＝ヒットエンドラン。フェーズH-28）。
   * 盗塁のプレーが打球のプレーへ引き継がれた（`convertToBattedBall`）ときだけ立つ。
   *
   * 効くのは2か所で、どちらも**リターンと同じ場所にリスクを置く**ための印：
   * - 安打の進塁がもう1つ先まで伸びる（`resultFromHit` → `advanceOnHitRunners` の extraBases）
   * - フライを捕られたとき、瞬時に戻らず**走って戻る**＝その塁へ投げればライナーゲッツー
   *   （打者が打つのを見てから走った他の走者と違い、戻る距離は自分で選んだ賭けの分）
   */
  brokeEarly: boolean;
  /**
   * このプレーで一度でも自分から引き返した（フェーズJ-30。**K-31で人間の走者にも広げた**）。
   *
   * **1プレーに1回**なのは `bikeUsed` / `dropkickUsed` とまったく同じ理由＝これが無いと
   * 走者は「進めば刺される／戻れば助かる」の判定が入れ替わるたびに向きを変え続け、
   * 挟殺が**永久に終わらない**（野手は 8.5m/s で走者より速いので実際には詰められるが、
   * プレーの終了がフレームの綾に依存する状態を作らない）。1回に絞っておけば、
   * 引き返した先で刺されるか塁に戻って安全になるかのどちらかで必ず決着する。
   *
   * K-31で人間側にも同じ枷が要るようになったのは、**タッチプレーでは送球の帰結が到着まで
   * 決まらない**ため：進塁と帰塁を交互に押されると、送球が届くたびに走者が向きを変えて
   * どの送球も無駄になり、プレーが終わらなくなる（ORIGINAL_PARITY.md に「人間攻撃の
   * 走者往復に対するCPU守備」として記録されていた懸念が、K-31で初めて現実になる）。
   * けん制で塁に戻り切った走者は塁を踏み直しているのでここも戻す（また1回引き返せる）。
   */
  retreatUsed: boolean;
  /**
   * 塁間でその場に止まっている（フェーズN-34。説明書p25の挟殺の「逃げる側」）。
   *
   * **バイクのオーバーラン（`overrun`）と同じ「塁へ向かっていない」状態**で、
   * `approachingOwnBase` が false になる＝非フォースの走者なら**その塁へ投げても
   * 触れない**（`throwRetiresRunner`）。違いは、あちらが塁を通り過ぎた先で止まるのに対し
   * こちらは塁間で止まること、そしてスキルが要らないことだけ。
   *
   * 止まっても本人は助からない（計測：逃げ切れる場面は0.0%）。値打ちは**守備が
   * 走って追う時間ぶん、他の走者が進めること**のほうにある。
   */
  holding: boolean;
  /**
   * このプレーで一度でも止まった。**1プレーに1回**（ユーザー判断）で、
   * `bikeUsed` / `dropkickUsed` / `retreatUsed` とまったく同じ枷＝これが無いと
   * 止まる／走るを繰り返して守備の送球を無限に無駄にでき、挟殺が終わらない。
   */
  holdUsed: boolean;
}

/**
 * ちっちゃいモードの操作ヒント（今この瞬間にできる操作だけを出す）。
 * 攻撃側が人間のとき：
 *   'tagUp' = フライ捕球直後の判断猶予（B+方向で進塁）、
 *   'recall' = 進塁を仕掛けた走者がいる（A+方向で帰塁）。
 *   'hold' = 走っている走者を止められる（Bで停止。フェーズN-34）。
 *   'holding' = 走者が塁間で止まっている（Bで再スタート／A+方向で帰塁）。
 *   'lead' = けん制モードで走者が塁を離れている（A+方向で帰塁。説明書p24）。
 *   'dropkick' = スキル `ドロップキック` を持つ走者が走っている（Gで蹴れる。フェーズF-26-4）。
 *   'hitAndRun' = 盗塁を仕掛けた球がまだ打てる（Aでスイング。フェーズH-28）。
 * 守備側が人間のとき：
 *   'kickDanger' = ボールを持った野手が、蹴れる走者に近寄られている（フェーズF-26-4）。
 *   'catchEffect' = 一時効果を切れる野手が守っている（Gで捕球範囲。フェーズM-33）。
 *   'finePlay' = ボールが跳べば届く距離にある（A+方向でジャンプ/ダイビング。説明書p23）、
 *   'rundown'  = ボールを確保していて塁間に走者がいる（B+方向でランダンプレイ。説明書p25）、
 *   'pickoff'  = けん制モードで、まだ誰も走っていない（A+方向でけん制球。説明書p24）、
 *   'stealThrow' = 盗塁されている（A+方向で塁へ送球。説明書p13）。
 * でっかいモードで攻撃側が人間のとき（main.ts が出す。フィールドプレー中ではない）：
 *   'steal' = 走者がいて盗塁を仕掛けられる（投球中にB+方向）。
 *   'takeLead' = **まだ投げていない**うちにリードを取りに行ける（Bでにらみ合いへ。
 *     フェーズKK-58）。'steal' と**同じ枠を入れ替える**＝同じBが投球前と投球中で違う
 *     意味になるので、両方を並べると「いまどちらが効くのか」が読めない
 *     （'bunt' / 'buntTwoStrikes' と同じ「1つの操作の2つの状態」の持ち方）。
 *   'battingEffect' = 打者が一時効果を切れる（Gで1打席だけ。フェーズM-33）。
 *   'bunt' / 'buntTwoStrikes' = バントの構えを取っている（フェーズY-46／AA-48）。
 *     **2ストライクだけ文言が変わる**＝そこではファウルが三振になる（'hold' と
 *     'holding' が同じ操作の2つの状態を2つの kind で持つのと同じ形）。
 */
export type PlayPromptKind =
  | 'tagUp'
  | 'recall'
  | 'hold'
  | 'holding'
  | 'overrun'
  | 'dropkick'
  | 'hitAndRun'
  | 'kickDanger'
  | 'catchEffect'
  | 'finePlay'
  | 'rundown'
  | 'pickoff'
  | 'leadStart'
  | 'lead'
  | 'takeLead'
  | 'steal'
  | 'battingEffect'
  | 'bunt'
  | 'buntTwoStrikes'
  | 'stealThrow';

/**
 * 今出すべき操作ヒント（フェーズD-20）。**守備側と攻撃側で別々に持つ**：2P PLAY では
 * 両方が人間なので、1つに畳むとどちらかの案内が必ず消える（1P PLAY では CPU が担って
 * いる側が常に null になるので、出るヒントはD-20より前とまったく同じ）。
 */
export interface PlayPrompt {
  defense: PlayPromptKind | null;
  offense: PlayPromptKind | null;
}

/** ヒント無し（プレー外・両側ともCPU） */
export const NO_PLAY_PROMPT: PlayPrompt = { defense: null, offense: null };

/** 塁カバー担当野手の逆引き（送球到着後、その塁を守る野手がボールを持つ） */
const BASE_COVER_FIELDER: Record<BaseKey, FielderId> = {
  home: 'C',
  first: '1B',
  second: '2B',
  third: '3B',
};

/** 塁を指定する十字キー入力→ワールド座標変換。鳥瞰カメラは -Z を向くため反転不要
 * （でっかいモードの+Z正対カメラとは逆で、上入力=画面奥=ワールド-Z、左右は非反転）。 */
function padToWorldDir(x: number, y: number): Vec2 {
  return { x, z: -y };
}

/** 斜め入力でも跳ぶ速さが変わらないよう単位ベクトル化する（ゼロベクトルはそのまま） */
function normalize(v: Vec2): Vec2 {
  const len = Math.hypot(v.x, v.z);
  return len === 0 ? { x: 0, z: 0 } : { x: v.x / len, z: v.z / len };
}

export interface FieldPlayController {
  /**
   * 接触直後の打球状態・現在の走者状況・現在のアウト数を受け取ってフィールドプレーを
   * 開始する。outs はタッチアップの可否判定に使う（フライアウトが3アウト目なら
   * その時点でイニングが終わるので走者は還れない＝タッチアップの余地が無い）。
   *
   * leads は**打球の瞬間に走者が塁を離れている距離**（フェーズY-46）。L-32が
   * 「投球中の走者は全員リードを取っている」と決めた（盗塁・けん制はそこから始まる）のに、
   * **打球のプレーだけ全員が塁の真上に戻されていた**＝同じ1球の同じ瞬間に、打者が
   * 見送れば 3.5m・打てば 0m という食い違いがあった。渡すのは `startSteal` と
   * まったく同じ `resolveCarriedLeads` の結果で、**省略すれば従来どおり全員0**。
   *
   * 効くのは**塁上の走者の走り出し位置だけ**（打者走者は本塁から走るので無関係）＝
   * I-29が測った内野安打の帯は原理的に動かない。判定上の扱いも従来のまま
   * （タッチの対象にもドロップキックの担い手にもならない＝L-32の約束をそのまま延長）。
   */
  launch(
    initial: BattedBall,
    runners: BaseRunners,
    batterId: RunnerId,
    outs: number,
    leads?: Partial<Record<'first' | 'second' | 'third', number>>,
  ): void;
  /**
   * けん制球（説明書p24「Bで"ちっちゃいモード"に切替→+で塁を指示→A」）。打球を伴わない
   * もう1つの入口で、投手がボールを持った状態（possessed）からフィールドプレーを始める。
   *
   * 打球のプレー（launch）との違いは3点だけで、あとは既存の仕組みをそのまま使う：
   * (1) 走者は塁上からリードを取り、けん制球のリリースと同時に帰塁を始める、
   * (2) 打者走者がいない（打席は終わっていない）、
   * (3) 決着は runnerPlay として返す（カウント・打順は据え置き）。
   * 送球の時間競争・ランダンプレイ・挟殺・走塁操作はすべて打球のときと同じ経路を通る。
   *
   * carried は持ち越したリード（フェーズL-32。省略時は従来どおり全員0から育つ）。
   * これが無いと、**投手はけん制モードに入り直すだけで走者のリードを0に戻せてしまう**
   * ＝深いリードを我慢して勝ち取った報酬が、投げずに引き返すだけで消える。
   */
  startPickoff(
    runners: BaseRunners,
    outs: number,
    carried?: Partial<Record<'first' | 'second' | 'third', number>>,
  ): void;
  /**
   * 盗塁（説明書p13「盗塁しようとすると"ちっちゃいモード"に変わる」）。投球中に走者が
   * 走り出したところからフィールドプレーを始める、3つ目の入口。
   *
   * けん制（startPickoff）との違いは「ボールを持っているのが捕手で、しかもまだ手元に
   * 届いていない」ことだけ。pitchRemainingSec（投球が捕手に届くまでの残り時間）＋
   * 捕手の持ち替え（STEAL_CATCH_RELEASE_SEC）が過ぎるまで送球できないので、**仕掛けた
   * 瞬間の投球の残り時間がそのまま走者の持ち時間になる**（core/fielding.ts
   * stealSafeJumpSec）。送球の時間競争・ランダンプレイ・帰塁は打球のときと同じ経路。
   *
   * target は走らせる走者の指定で2通りある：
   * - **十字キーの絶対塁指定**（進塁先の `BaseKey`）＝その塁へ進む走者1人。
   *   **無指定（null）なら走れる走者が全員、同じ瞬間にスタートを切る**（フェーズL-32の
   *   ダブルスチール。ただし本塁へ向かう走者は除く＝`stealableBases`）。
   * - **起点の塁の配列**＝その走者たちを直接走らせる。CPU攻撃側の判断（`chooseCpuSteals`）は
   *   十字キーを持たないので、こちらで渡す（人間の入力を通す経路と分けておくと、
   *   CPUの規則がパッドの状態に影響されない＝D-20で `NULL_PAD` を入れたのと同じ理由）。
   *
   * 走れる走者がいなければ false を返す＝呼び出し側はモードを切り替えない。
   * carried は持ち越したリード（フェーズL-32。省略時は全員が既定の `STEAL_LEAD`＋スキル）。
   */
  startSteal(
    runners: BaseRunners,
    outs: number,
    target: BaseKey | null | Array<'first' | 'second' | 'third'>,
    pitchRemainingSec: number,
    carried?: Partial<Record<'first' | 'second' | 'third', number>>,
  ): boolean;
  /**
   * ヒットエンドラン（フェーズH-28）：盗塁を仕掛けた球を打者が打った。**4つ目の入口では
   * なく、走っている盗塁のプレーを打球のプレーへ引き継ぐ**もので、走者の現在位置と
   * 走っている区間はそのまま保つ（＝スタートを切っていた分がそのまま先行になる）。
   *
   * 引き継ぐと打席は終わる（決着は runnerPlay ではなく result）ので、呼び出し側は
   * 保留していた1球のカウントを捨てる。盗塁のプレーが動いていなければ false を返す
   * （＝打球は通常どおり launch で始める）。
   */
  convertToBattedBall(initial: BattedBall, batterId: RunnerId): boolean;
  /** 毎フレーム呼ぶ。守備操作の反映・走者の自動進塁・帰結確定を行う */
  update(dt: number): void;
  /**
   * A相当（守備側が人間のとき）。場面で機能が変わる：
   * - 打球の飛行中：ファインプレイ（説明書p23。十字キーの方向が必須で、
   *   上=ジャンプ/左右=横っとび/下=ダイビング。方向なし・近くに野手がいなければ何も起きない）。
   *   捕球そのものは update() が毎フレーム自動で行うので、Aは「跳ぶ」ためだけに使う。
   * - 確保中・ランダン中：送球（十字キーは塁の絶対指定＝上=二塁/左=三塁/右=一塁/下=本塁、
   *   説明書p21準拠。無指示なら一塁へ）。走っている最中でも投げられる＝挟殺で
   *   走者が引き返したら、追うのをやめて逆の塁へ投げる、という切り替えができる。
   */
  action(): void;
  /**
   * B相当（守備側が人間のとき）＝ランダンプレイ（説明書p25「ボールを捕ってから+で塁を
   * 指示しBを押すと、ボールを持った選手がその塁へダッシュします。指示しないときは1塁へ」）。
   * 走っている最中に押し直せば行き先を変えられる（＝挟殺で走者に合わせて向きを変える）。
   * 塁間の走者に触れればタッチアウト、塁に着けばそこへ向かっていた走者はアウト。
   */
  startRundown(): void;
  /**
   * B相当（攻撃側が人間のとき）。フォースされていない走者に進塁を仕掛ける。
   * 十字キーは「進塁する塁」の絶対指定（説明書p16準拠。該当走者がいなければ
   * 何もしない）、**無入力なら仕掛けられる走者が全員**（フェーズL-32）。
   * フライ捕球後（タッチアップの局面。説明書p19）はフォースが消えるため、
   * 塁上の全走者がこの操作の対象になる。
   */
  sendRunner(): void;
  /**
   * A相当（攻撃側が人間のとき）。進塁を仕掛けた走者を元の塁へ呼び戻す（帰塁）。
   * 十字キーは「帰る塁」の絶対指定（上=二塁/左=三塁/右=一塁、説明書p19準拠）で、
   * 該当する走者がいなければ何もしない。無入力なら直近に仕掛けた走者。
   * 走者は実際に元の塁へ走って戻るため、その塁へ送球されれば刺される。
   * **いったん次の塁を踏んだ（到達した）走者は戻れない**（説明書p19）。
   */
  recallRunner(): void;
  /**
   * G相当（攻撃側が人間のとき）＝ドロップキック（フェーズF-26-4。★2スキル
   * `ドロップキック`）。走っている走者のうち**野手にもっとも近い1人**が蹴る。
   * 射程（DROPKICK_RANGE）内に野手がいればその野手が行動不能になりボールを落とし、
   * いなければ空振りして走者が転ぶ（DROPKICK_STUMBLE_SEC）。どちらでも
   * **1プレーに1回で打ち止め**（挟殺が成立しなくなるのを防ぐ規則）。
   */
  dropkick(): void;
  /**
   * G相当（守備側が人間のとき）＝一時効果（フェーズM-33。★2スキル `ケモノガエリ`）。
   * **札を持っている野手のうちボールにもっとも近い1人**が切る（ドロップキックが
   * 「走っている走者のうち野手にもっとも近い1人」を選ぶのとまったく同じ畳み方）。
   *
   * 誰も持っていなければ何も起きない。**遠くの野手に払ってしまうこともありうる**が、
   * それは押した側の判断（蹴りが空振りしうるのと同じ＝押す責任がプレイヤーにある）。
   */
  catchEffect(): void;
  /**
   * いま `catchEffect()` を押したら実際に切れる野手（居なければ null）。**HUDのヒントを
   * これと同じ関数から出す**ので、「Gと出ているのに何も起きない」（あるいはその逆）が
   * 構造的に起きない（H-28で `ヒットエンドラン!` のヒントと効く窓を揃えたのと同じ整理）。
   */
  catchEffectReady(): FielderId | null;
  isActive(): boolean;
  /**
   * いまフィールドにいる走者（フェーズYY-73。スキルの見た目を着せる・走る足に効果を出す）。
   * `running` は塁間を走っている最中か。
   */
  runnersOnField(): Array<{ mesh: THREE.Group; id: RunnerId; running: boolean }>;
  /** 打球がまだ飛んでいる（捕られても転がり終えてもいない）か＝守備範囲の輪を出す間 */
  ballInFlight(): boolean;
  /**
   * 打球が最初に落ちる場所（フェーズYY-73。`鷹` の読み）。まだ一度も地面に着いていない
   * 飛球の間だけ返す。**守備の判定と同じ `predictLanding`**（影のシミュレーション）。
   */
  landingPoint(): Vec2 | null;
  /**
   * 追従カメラ（フェーズE-24）が見るべき地点。プレー中でなければ null を返す
   * （＝次のプレーの最初のフレームでカメラが瞬時に合わせ直す）。
   */
  cameraFocus(): Vec2 | null;
  /**
   * 画面外マーカー（フェーズE-24）で指し示す走者の位置。カメラがボールに寄ったぶん
   * 走者は画面外へ出るが、**どの塁へ投げるかは走者がどこまで来たかで決まる**ので、
   * 判断材料として方向だけは残す（既存の「意思決定材料は隠さない」方針）。
   */
  markedRunners(): Vec2[];
}

export function createFieldPlayController(opts: {
  ball: THREE.Mesh;
  shadow: THREE.Object3D;
  fielders: FielderEntity[];
  runners: RunnerPool;
  /**
   * 守備側の入力（野手の一斉移動・ファインプレイの方向・送球/ランダンの塁指定）。
   * **攻撃側とは別のパッド**（フェーズD-20）＝2P PLAY では投げる側と走る側が別人なので、
   * 1枚のパッドから両方を読むと、片方の十字キーがもう片方の塁指定に化ける。
   * CPUが守備のときは何も押されていないパッド（`NULL_PAD`）が渡る。
   */
  defensePad: VirtualPad;
  /** 攻撃側の入力（進塁/帰塁の塁指定・バイクの点火のJ長押し・ドロップキック） */
  offensePad: VirtualPad;
  /** true の間、守備は人間が操作する（false ならCPUが自動守備する） */
  isDefenseHuman: () => boolean;
  /**
   * true の間、走塁は人間が操作する（false ならCPU走者＝自動で進塁・帰塁・バイク・蹴り）。
   *
   * **D-20より前は `!isDefenseHuman()` で代用していた**（人間は1人なので「守備が人間＝
   * 攻撃はCPU」が必ず成り立っていた）。2P PLAY では両方が人間になりうるので、
   * CPUに任せる判断はこちらで見る＝でないと**人間の走者が勝手にバイクに点火し、
   * 勝手に蹴り、勝手に帰塁する**（実際に代用のままだとそうなる）。
   */
  isOffenseHuman: () => boolean;
  onSettled: (outcome: FieldPlayOutcome) => void;
  /**
   * 守備プレー中の各アウト/セーフをその都度通知する（捕球・各送球の到着時に発火）。
   * 呼び出し側は文字バナー＋効果音で見せる。連続送球のたびに feedback を出すため、
   * プレー終了時にまとめて通知する onSettled とは別に、リアルタイムで呼ぶ。
   */
  onDefenseResult?: (kind: 'out' | 'safe') => void;
  /**
   * 操作ヒントの切り替え（既存の「意思決定材料は隠さない」方針を、新しい操作の
   * 発見しやすさにも適用する）。今その操作ができる間だけ non-null で呼ばれる。
   * 'tagUp' = フライ捕球直後の判断猶予（説明書p19。B+方向で進塁）、
   * 'recall' = 仕掛けた走者がいて呼び戻せる（説明書p19。A+方向で帰塁）、
   * 'finePlay' = ボールが跳べば届く距離にある（説明書p23。A+方向でジャンプ/ダイビング）、
   * 'rundown' = ボールを確保していて塁間に走者がいる（説明書p25。B+方向でランダンプレイ）。
   *
   * **守備側と攻撃側を別々に渡す**（フェーズD-20）：2P PLAY では両方が人間なので、
   * 1つのチャンネルにまとめると必ずどちらかの案内が消える。
   */
  onPlayPrompt?: (prompt: PlayPrompt) => void;
  /**
   * 捕球・送球の音のきっかけ（ブラッシュアップ：効果音）。**音はこのシーンが持たない**
   * （`onDefenseResult` と同じ分担）ので、プレーの局面が「飛んでいる／転がっている／
   * 送球中 → 野手が持った」に変わったら 'catch'、「→ 送球中」に変わったら 'throw' を報せる。
   * 判定には一切触らない（局面の切り替わりを見ているだけ）。
   */
  /** 捕球・送球の音。**捕った（投げた）野手も渡す**（フェーズYY-73：その野手の札が光って鳴る） */
  onFieldSound?: (kind: 'catch' | 'throw', fielder: FielderId | null) => void;
  /**
   * 走者ID→その走者の走る速さ m/s（走力＝RUNの反映。フェーズB-8）。
   * ロスターを知っているのは main.ts なので、能力値の解決はそちらに任せてここは
   * 「速さを問い合わせる」だけにしてある（このシーンは選手データに依存しない）。
   * 省略時は全員が基準速＝能力値を持ち込む前と同じ挙動になる。
   */
  runnerSpeedOf?: (id: RunnerId) => number;
  /**
   * 走者ID→スキル `バイク` を持っているか（フェーズF-26-3）。runnerSpeedOf と同じく
   * ロスターを知っている main.ts に解決を任せ、このシーンは選手データを知らないままにする。
   * 省略時は全員が持たない＝バイクを入れる前とまったく同じ挙動になる。
   */
  canBikeOf?: (id: RunnerId) => boolean;
  /**
   * 走者ID→スキル `ドロップキック` を持っているか（フェーズF-26-4）。canBikeOf と同じ形で、
   * ロスターを知っている main.ts に解決を任せる。省略時は全員が持たない。
   */
  canDropkickOf?: (id: RunnerId) => boolean;
  /**
   * 走者ID→ドロップキックの射程 m（フェーズF-26-5のデュオ `ロケットキック` で伸びる）。
   * 省略時は全員が素の `DROPKICK_RANGE`。**守備側の警告距離もこの値から導出する**ので、
   * 射程が伸びれば警告も同じだけ早く出る（F-26-4の「回避手段が間に合う」不変条件）。
   */
  dropkickRangeOf?: (id: RunnerId) => number;
  /**
   * 走者ID→盗塁のスタート位置 m（フェーズF-26-5のドウブツ系統 `ウサギ`/`ウマ` で深くなる）。
   * 省略時は全員が素の `STEAL_LEAD`。判定（`stealSafeJumpSec`）は元から lead を引数に
   * 取るので、走り出す位置を変えるだけで盗塁の成否が動く＝専用の分岐は要らない。
   */
  stealLeadOf?: (id: RunnerId) => number;
  /**
   * 守備位置→捕球半径の上乗せ m（フェーズF-26-5のドウブツ系統 `イヌ`/`タカ` 等）。
   * **守備側チームのロスターから引く**ので、走者系の問い合わせ（攻撃側）とは解決先が違う。
   * 省略時は全員0＝スキルを入れる前とまったく同じ捕球判定になる。
   */
  catchRadiusBonusOf?: (id: FielderId) => number;
  /**
   * 守備位置→**送球するときの腕**（フェーズHH-55）。`catchRadiusBonusOf` と同じく
   * 守備側チームのロスターから引く（守備位置→選手の対応を知っているのは main.ts だけ）。
   * **実データを持つのはマウンドの1人だけ**＝名鑑にARMがあるのは投手だから
   * （`fielderThrowArm`）。省略時は全員が右の上手＝見た目だけの既定値なので、
   * 渡さない呼び出し（テスト）でも判定は1ミリも変わらない。
   */
  throwArmOf?: (id: FielderId) => PitchArm;
  /**
   * 守備位置→**いま一時効果を切ったら捕球半径がいくつ増えるか** m（フェーズM-33）。
   * 切れない野手（札を持っていない・使い切った・すでに切ってある）は 0。
   * `catchRadiusBonusOf` と同じく守備側チームのロスターから引くが、あちらが
   * 「もう効いている補正」なのに対しこちらは「これから払えば得られる補正」。
   * 省略時は全員0＝一時効果を入れる前とまったく同じ挙動になる。
   */
  catchEffectGainOf?: (id: FielderId) => number;
  /**
   * 一時効果を実際に切った（フェーズM-33）。**チャージを減らして効果を載せるのは
   * ロスターを持つ main.ts の仕事**なので、このシーンは「誰が切ったか」を報告するだけ
   * （`onDropkick`・`onBikeIgnite` と同じ分担）。人間のGでもCPUの判断でも同じ経路を通る。
   */
  onCatchEffect?: (id: FielderId) => void;
  /**
   * ドロップキックが出たときの通知（当たった＝true / 空振り＝false）。効果音を鳴らすのは
   * 実際のゲームイベントの発生元（main.ts）という既存の分担に合わせる
   * （このシーンは音を持たない。onDefenseResult と同じ形）。
   */
  onDropkick?: (hit: boolean, runnerId: RunnerId) => void;
  /**
   * バイクに点火したときの通知（フェーズF-26-8）。**消費型 `ニトロ` のチャージを減らすのは
   * ロスターを持っている側**（main.ts）なので、シーンは「誰が点火したか」だけを報せる。
   * 常設の `バイク` で乗った走者でも同じように呼ばれる＝どちらの札で乗ったかを
   * シーンは知らない（`useVerb` が受け側で解決する）。
   */
  onBikeIgnite?: (runnerId: RunnerId) => void;
  /**
   * その球をまだ打てるか（＝投球が生きているか。フェーズH-28のヒットエンドラン）。
   * **真実は投球の側にある**ので、シーンが持っている「投球が捕手へ届くまでの残り時間」
   * ではなく main.ts（`pitching.isPitchLive()`）に問い合わせる＝**画面に出るヒントと、
   * 実際にKがスイングになる条件が同じ1つの値から起きる**（見えている操作と効く操作が
   * 食い違わない、という既存の約束）。省略時は常に false＝H-28の前と同じ挙動になる。
   */
  canHitAndRun?: () => boolean;
  /**
   * 今の試合の球場（フェーズC-14）。フェンスの距離・高さと、拾われなかった打球の
   * 距離分類に効く。**選ぶのは試合開始前のチーム選択（ui/teamSelect.ts）で、
   * このコントローラーはそれより前に作られる**ので、値ではなく問い合わせで受け取る
   * （runnerSpeedOf・isDefenseHuman と同じ形）。省略時はところざわ。
   */
  ballparkOf?: () => Ballpark;
}): FieldPlayController {
  const {
    ball,
    shadow,
    fielders,
    runners,
    defensePad,
    offensePad,
    isDefenseHuman,
    isOffenseHuman,
    onSettled,
    onDefenseResult,
    onPlayPrompt,
    onFieldSound,
    runnerSpeedOf,
    canBikeOf,
    canDropkickOf,
    dropkickRangeOf,
    stealLeadOf,
    catchRadiusBonusOf,
    throwArmOf,
    catchEffectGainOf,
    onCatchEffect,
    onDropkick,
    onBikeIgnite,
    canHitAndRun,
    ballparkOf,
  } = opts;
  const speedOf = (id: RunnerId): number => runnerSpeedOf?.(id) ?? RUNNER_SPEED;
  const canBike = (id: RunnerId): boolean => canBikeOf?.(id) ?? false;
  const canDropkick = (id: RunnerId): boolean => canDropkickOf?.(id) ?? false;
  const dropkickRangeFor = (id: RunnerId): number => dropkickRangeOf?.(id) ?? DROPKICK_RANGE;
  const stealLeadFor = (id: RunnerId): number => stealLeadOf?.(id) ?? STEAL_LEAD;
  const catchBonusOf = (id: FielderId): number => catchRadiusBonusOf?.(id) ?? 0;
  const throwArmFor = (id: FielderId): PitchArm => throwArmOf?.(id) ?? NEUTRAL_PITCH_ARM;
  const catchEffectGain = (id: FielderId): number => catchEffectGainOf?.(id) ?? 0;
  const ballpark = (): Ballpark => ballparkOf?.() ?? DEFAULT_BALLPARK;
  const fielderById = new Map<FielderId, FielderEntity>(fielders.map((f) => [f.id, f]));

  let phase: PlayPhase = null;
  /** 音のために覚えておく直前の局面（`onFieldSound`。切り替わりの向きで捕球か送球かを決める） */
  let soundPhase: PlayPhase = null;
  /**
   * このプレーの入口（'batted'=打球 launch / 'pickoff'=けん制球 startPickoff /
   * 'steal'=盗塁 startSteal）。けん制・盗塁はリードの進行・CPUの判断・決着の種類
   * （打席が終わらない＝runnerPlay）だけが違い、それ以外の守備・走塁は打球と完全に
   * 同じ経路を通る。
   */
  let playKind: 'batted' | 'pickoff' | 'steal' = 'batted';
  /** けん制モードの経過秒（PICKOFF_WINDOW_SEC との比較用） */
  let pickoffTimer = 0;
  /** けん制モードで「誰も塁を離れていない」状態が続いた秒数（フェーズII-56） */
  let pickoffIdleTimer = 0;
  /** バイク（フェーズF-26-3）の点火判定：人間の攻撃側がJを押し続けている秒数 */
  let bikeHoldSec = 0;
  /**
   * 「止まれ」の予約（フェーズN-34）。**Jを離した瞬間に止まる**ための状態で、押下時に
   * 「走れ（発進・再スタート）」が何も起きなかったときだけ対象の走者が入る。
   *
   * 押した瞬間に止めないのは、**同じJの長押しがバイクの点火**（F-26-3。0.3秒）だから：
   * 押下で即座に止めると、バイクに乗ろうとした走者が必ず0.3秒立ち止まってから発進する
   * ことになり、**既に計測済みのバイクの手触り（I-29）が変わってしまう**。押し分けの
   * 語彙は打撃（Kを押しっぱなし＝フルスイング／離す＝バント）とバイクで既に使っている
   * ものと同じで、**短く離せば止まる／押し続ければ点火**になる。
   */
  let holdArmed: ForcedRunner['from'][] = [];
  let ballState: BattedBall | null = null;
  /**
   * プレー開始時の塁の占有状況。「埋まっているか」だけを見る既存の判断
   * （フォース走者の算出・タッチアップの可否・進塁できる走者の一覧）が読む派生ビューで、
   * 走者の識別が要るところは originalRunners のほうを使う。
   */
  let originalBases: Bases = { first: false, second: false, third: false };
  /** プレー開始時に誰がどの塁にいたか（安打での自動進塁で走者を保つために持つ） */
  let originalRunners: BaseRunners = EMPTY_BASE_RUNNERS;
  /** この打球を打った打者（＝打者走者）。走塁だけのプレー（けん制・盗塁）では使わない */
  let batterRunnerId: RunnerId = ANONYMOUS_RUNNER;
  let forced: ForcedRunner[] = [];
  /** 攻撃側が人間のとき、任意に進塁を仕掛けた走者（起点の塁がキー） */
  const sentRunners = new Map<'first' | 'second' | 'third', ForcedRunner>();
  /** 全9野手の現在位置（原作準拠：塁カバー4人＋一斉移動の5人。全員が捕球候補） */
  let fielderPos = {} as Record<FielderId, Vec2>;
  /** ボールを確保している野手（possessed / carrying / throwing の間のみ non-null） */
  let holderId: FielderId | null = null;
  /**
   * ランダンプレイ（説明書p25）でボールを持った野手が向かっている塁
   * （phase === 'carrying' の間のみ non-null）。
   */
  let carryTarget: BaseKey | null = null;
  /** CPU守備が追いかける目標地点（着地予測。着地後はボールの現在地を追う） */
  let landingPoint: Vec2 = { x: 0, z: 0 };
  /** CPU守備が確保してから送球するまでの反応時間の計時 */
  let possessedTimer = 0;
  /** 送球せず確保したまま、全走者が決着（アウト/到達）してからの計時（プレー畳み用） */
  let holdSafeTimer = 0;
  /**
   * このプレーでCPU守備が一度でもランダンを仕掛けた（フェーズJ-30）。**1プレーに1回**で、
   * 仕留められなくても次からは送球に戻る＝走って追い続けてプレーが終わらない、が起きない。
   */
  let cpuRundownUsed = false;
  /**
   * このプレーでCPU守備が一度でも送球した（フェーズK-31）。
   *
   * K-31でCPU守備を連続送球にしたので、**投げ続けてプレーが終わらない**ことを塞ぐ枷が要る。
   * 1投目は従来どおり「もっとも進んだ走者の塁」へ必ず投げ（安打でボールが返ってくる絵は
   * 変わらない）、**2投目以降は送球で刺せる走者がいるときだけ**投げる。刺せる走者への
   * 送球は必ずアウトになる（塁で待つ野手のタッチ）ので live が減り、必ず終わる。
   */
  let cpuThrewOnce = false;
  /**
   * このプレーで守備が取ったアウトの数（フェーズK-31。送球の時間競争とタッチの2か所で増える）。
   *
   * **CPU守備は1プレーに1つだけアウトを取る**（K-31より前の「1送球で完結」と同じ重さ）。
   * K-31でCPUを連続送球にしたのは「引き返されて無駄になった送球を投げ直せるようにする」
   * ためであって、**CPU守備を強くするためではない**：これが無いと満塁の内野ゴロで
   * CPUが本塁→三塁→二塁と投げて必ず三重殺になる（実機で確認した）。しかも**フォース
   * された走者は引き返せない**ので、攻撃側にはこれに対する手が1つも無い。
   * フライアウト（`openTagUp` が打者に立てる out）はここを通らないので、犠牲フライの
   * 本塁送球は従来どおり行われる。
   */
  let defenseOuts = 0;
  /**
   * 送球中のボール（見た目の飛行）。連続送球モデルでは、送球ごとに対象走者1人の
   * アウト/セーフを release 時に確定し（result）、到着時にその結果を発効してから
   * 次の送球を受け付ける（possessed へ戻る）。
   */
  let throwState: {
    pos: Vec2;
    target: BaseKey;
    /**
     * この送球の帰結。その塁へ向かっている走者がいた場合のみ 'out'/'safe' が入る。
     * 走者が来ていない塁への送球（＝そもそもプレーが無い）は null で、アウト/セーフの
     * 判定表示を出さない（実機テストプレイの指摘：走者のいない塁に投げても「セーフ!」と
     * 出てしまう）。
     */
    result: 'out' | 'safe' | null;
    /**
     * タッチプレーの「予約」（フェーズK-31）。送球が時間競争に勝っている非フォースの走者で、
     * **到着した時点でまだ同じ塁へ向かっていればアウト**になる。引き返していれば無効＝
     * この送球は無駄になる（＝K-31が走者に与えた唯一の逃げ道）。
     */
    pendingTag: RunnerVisual | null;
    /** CPU守備の送球なら true */
    byCpu: boolean;
  } | null = null;
  /**
   * 送球の振り抜き（フェーズHH-55。見た目だけ）。**`throwState` とは別に持つ**：
   * 送球はボールが着いた瞬間に `throwState` が消えるのに対し、投げた本人の動作は
   * そこで止まらない（至近距離の送球なら 0.06秒で着く）。ドロップキックの `kickSec` と
   * まったく同じ形の「見た目の時計」で、**判定側からは一度も読まない**。
   */
  let throwPose: { id: FielderId; sec: number; arm: PitchArm; yaw: number } | null = null;
  let runnerVisuals: RunnerVisual[] = [];
  let outcome: FieldPlayOutcome | null = null;
  let pauseT = 0;
  /**
   * 決着してからの経過秒（フェーズWW-71の「余韻」）。決着後も画面は止めず、ボール・野手・
   * 走者を**見た目だけ**動かし続ける（判定はもう何もしない）。
   */
  let aftermathT = 0;
  /** 決着した瞬間にボールが誰の手にも無かったか（＝ファウル・安打の球は転がり続ける） */
  let ballFreeAtFinish = false;
  /**
   * 余韻の間に転がる球が**観客席に落ちて止まったか**（見た目だけ）。打球の物理は地面を
   * y=0 の平面としか知らないので、止めないとスタンドの下へ潜って跳ね続ける
   * （テストプレイ「ホームランの球が客席をすり抜けてバウンドしていく」）。
   */
  let ballInStands = false;
  /**
   * 余韻の間に**ボールを投手へ返す**山なりの送球（見た目だけ。フェーズWW-71）。
   * アウトが決まった後に野手の手の中で止まったままだと、その間の画面が静止画になる。
   */
  let returnToss: { from: Vec2; to: Vec2; t: number; dur: number } | null = null;
  let returnTossDone = false;
  /**
   * 直前のフレームの一斉移動の向き（フェーズWW-71）。決着後の野手はこの向きのまま惰性で
   * 止まっていく＝**走っていた野手が決着の瞬間に急停止して固まる**（一時停止に見える）を避ける。
   */
  let lastGroupDir: Vec2 = { x: 0, z: 0 };
  let elapsed = 0;
  /** ボールが静止してからの経過秒（RESTING_PICKUP_GRACE_SEC との比較用） */
  let restingT = 0;
  /**
   * 静止球へいちばん近い野手のこれまでの最短距離（テストプレイの指摘）。
   * **縮んでいる間は猶予を数え直す**＝追いついている最中に打ち切らない。
   */
  let restingNearest = Infinity;
  /** このプレー開始時点のアウト数（タッチアップの可否判定に使う） */
  let outsBefore = 0;
  /** タッチアップの局面（フライ捕球→走者は帰塁済み、まだ誰も送球していない）か */
  let tagUpActive = false;
  /**
   * ボールを確保してからの経過秒。「まだ投げられない」待ちの計時に使う共通のタイマーで、
   * 待ちの内訳は2つある（どちらも送球モデルが速すぎることへの現実的な補正。詳細は
   * core/fielding.ts の FLY_CATCH_RELEASE_SEC / STEAL_CATCH_RELEASE_SEC）：
   * - フライ捕球後の持ち替え（タッチアップ局面。TAG_UP_WINDOW_SEC の計時も兼ねる）
   * - 盗塁での「投球が捕手に届く＋捕手の持ち替え」
   */
  let throwHoldTimer = 0;
  /** throwHoldTimer がこの秒数を超えるまで送球できない（0＝すぐ投げられる） */
  let throwHoldSec = 0;
  /**
   * 盗塁で投球が捕手に届くまでの時間（0＝盗塁以外／すでに届いている）。届くまでは
   * ボールが手元に無いので、送球だけでなくランダンプレイ（持って走る）も始められない。
   */
  let ballArriveSec = 0;
  /** 盗塁で「投手→捕手」へ投球が飛んでいる様子を見せるための起点（届いたら null） */
  let pitchBallFrom: Vec2 | null = null;
  /**
   * 持ち替え中（FLY_CATCH_RELEASE_SEC の間）にAで指定された送球先。押しても無反応に
   * ならないよう予約しておき、投げられるようになった瞬間に発射する。
   */
  let queuedThrowBase: BaseKey | null = null;
  /** タッチアップの判断猶予が開いている（人間が攻撃側で、まだ誰も仕掛けていない） */
  let tagUpChanceOpen = false;
  /** onPlayPrompt の状態（同じ値を二重に通知しないための保持。守備側・攻撃側の対で持つ） */
  let prompt: PlayPrompt = NO_PLAY_PROMPT;
  /**
   * 進行中のファインプレイ（説明書p23）。同時に跳べるのは1人だけ。
   * t < FINE_PLAY_ACTIVE_SEC の間だけ捕球リーチが伸び（＝跳んでいる最中）、そこから
   * recoverSec の間はその野手が一斉移動の対象から外れて動けない（＝外したときのコスト）。
   */
  let finePlay: {
    id: FielderId;
    kind: FinePlayKind;
    /** 跳ぶ方向（ワールド座標の単位ベクトル。ジャンプはゼロ） */
    dir: Vec2;
    t: number;
    recoverSec: number;
  } | null = null;
  /**
   * ドロップキック（フェーズF-26-4）で蹴り倒された野手→起き上がるまでの残り秒。
   *
   * **ファインプレイ（finePlay）が単一スロットなのに対しこちらは複数持てる**：跳ぶのは
   * 「操作している側が1人を選ぶ」プレーだが、蹴られるのは走者の数だけ起こりうるし、
   * 1人が蹴られている最中に別の走者がもう1人蹴ることもある。行動不能の意味は同じなので、
   * 一斉移動・塁カバー・捕球の各所では `isFinePlayBusy` と並べて `isFielderDown` を見る。
   */
  const downedFielders = new Map<FielderId, number>();
  /** 叩き落とされて地面にあるボールの位置（phase === 'loose' の間のみ意味を持つ） */
  let looseBallPos: Vec2 = { x: 0, z: 0 };

  function findVisual(origin: ForcedRunner['from']): RunnerVisual | undefined {
    return runnerVisuals.find((v) => v.origin === origin);
  }

  /**
   * 走者の見た目の位置を書く（フェーズE-25-(c)）。**歩き/走りの足の回転も向きも
   * `movePlayerTo` が「実際に動いた量」から起こす**ので、ここに速度も向きも書かない
   * ＝走力（RUN）の差も、バイクの2倍速も、転倒中に止まっていることも、そのまま
   * 足の動きに出る（見た目と判定が別々の値を持たない）。
   *
   * @param snap 走ったのではなく置き直した場合（プレー開始・フライ捕球後の帰塁・
   *   けん制での塁への戻り）。歩調も向きも動かさない。
   */
  function placeRunner(v: RunnerVisual, snap = false): void {
    movePlayerTo(v.mesh, v.pos.x, 0, v.pos.z, { snap });
  }

  /**
   * 操作ヒントを合わせる（フェーズD-20で守備側・攻撃側の対になった）。**CPUが担っている
   * 側のヒントは出さない**ので、1P PLAY では出るヒントがD-20より前と1つも変わらない。
   */
  function setPlayPrompt(defense: PlayPromptKind | null, offense: PlayPromptKind | null): void {
    const next: PlayPrompt = {
      defense: isDefenseHuman() ? defense : null,
      offense: isOffenseHuman() ? offense : null,
    };
    if (prompt.defense === next.defense && prompt.offense === next.offense) return;
    prompt = next;
    onPlayPrompt?.(next);
  }

  function clearPlayPrompt(): void {
    setPlayPrompt(null, null);
  }

  /**
   * 帰塁できる走者の一覧（帰る先＝起点の塁を、仕掛けた順に返す）。
   * 原作の「いったん次の塁を踏むと前の塁に戻れない」（説明書p19）に従い、次の塁へ
   * 到達済み（arrived）の走者は除く。刺された走者・すでに帰塁中の走者も対象外。
   */
  function recallableBases(): Array<'first' | 'second' | 'third'> {
    const sent = [...sentRunners.keys()].filter((from) => {
      const v = findVisual(from);
      // **1プレーに1回しか引き返せない**（フェーズK-31の `retreatUsed`）。仕掛け直した走者を
      // 何度でも呼び戻せると、送球のたびに向きを変えてどの送球も無駄にでき、
      // タッチプレーでは挟殺が永久に終わらない。
      return v !== undefined && !v.out && !v.arrived && !v.returning && !v.retreatUsed;
    });
    // バイクで塁を行き過ぎた走者（フェーズF-26-3）も帰塁の対象になる。**帰る先は起点では
    // なく踏んだ塁（forced.to）**だが、プレイヤーから見ればどちらも「帰る塁の方向を押す」
    // で変わらない（十字キーは塁の絶対指定＝説明書p19）。仕掛けた走者より後ろに並べるので、
    // 無入力のKは行き過ぎた走者を優先して戻す（いちばん刺されやすいのがこの走者）。
    const overrun = overrunRunners().map((v) => v.forced!.to as 'first' | 'second' | 'third');
    if (playKind !== 'pickoff') return [...sent, ...overrun];
    // けん制モードでは「リードしている（＝塁を離れている）走者」も帰塁の対象になる。
    return [
      ...sent,
      ...overrun,
      ...leadingRunners().map((v) => v.origin as 'first' | 'second' | 'third'),
    ];
  }

  /**
   * バイクで塁を行き過ぎて止まっている（または行き過ぎつつある）走者。
   * 塁を踏んでいないので送球でもタッチでも刺されうる＝速さの代償が乗っている状態。
   */
  function overrunRunners(): RunnerVisual[] {
    return runnerVisuals.filter((v) => v.overrun && !v.out && !v.arrived);
  }

  /**
   * **投球の瞬間に各走者が塁を離れている距離**（フェーズL-32／Y-46）。
   *
   * 「持ち越したリード（L-32）＞その走者のスキル（`ウサギ`/`ウマ`。F-26-5）＞標準のリード」
   * の順で決まる。**盗塁（`startSteal`）と打球（`launch`）が同じ1か所を見る**のが要点で、
   * そうしないと**同じ1球の同じ瞬間なのに、打者が見送れば 3.5m・打てば 0m** という
   * 食い違いが残る（Y-46で埋めた穴そのもの）。
   */
  function pitchLeads(
    baseRunners: BaseRunners,
    carried?: Partial<Record<'first' | 'second' | 'third', number>>,
  ): Partial<Record<'first' | 'second' | 'third', number>> {
    const leads: Partial<Record<'first' | 'second' | 'third', number>> = {};
    for (const base of ['first', 'second', 'third'] as const) {
      const id = baseRunners[base];
      if (id === null) continue;
      leads[base] = carried?.[base] ?? stealLeadFor(id);
    }
    return leads;
  }

  /** けん制モードで塁上にいる（リード中の）走者。走り出した/帰塁中の走者は含まない */
  function leadingRunners(): RunnerVisual[] {
    return runnerVisuals.filter(
      (v) => v.origin !== 'batter' && v.forced === null && !v.out,
    );
  }

  /** 現在のリード距離（CPU投手のけん制判断 chooseCpuPickoffThrow に渡す） */
  function currentLeads(): Partial<Record<'first' | 'second' | 'third', number>> {
    const leads: Partial<Record<'first' | 'second' | 'third', number>> = {};
    for (const v of leadingRunners()) {
      leads[v.origin as 'first' | 'second' | 'third'] = v.lead;
    }
    return leads;
  }

  /**
   * けん制モードのリードの進行。塁上の走者だけが LEAD_SPEED でじりじり塁を離れる
   * （走り出した走者・帰塁中の走者は通常の走塁処理が動かすのでここでは触らない）。
   * リードの上限は人間なら MAX_LEAD、CPU走者なら塁と**その走者の足**で決まる
   * cpuLeadDistance（フェーズS-40。それまでは走力によらず 5.2m / 3.6m の固定2値だった）。
   * 渡す `v.speed` は移動にも送球との時間競争にも使っている値そのものなので、
   * 「深く出ると判断した前提」と「実際に戻る速さ」が構造的に食い違わない。
   */
  function updateLeads(d: number): void {
    const attackIsHuman = isOffenseHuman();
    // **人間の走者は、押している方向の塁へだけリードする**（フェーズII-56）。
    // それまでは攻撃側が人間でもリードが毎フレーム自動で伸びていて、**何も押さずに
    // 2秒待つだけでけん制に刺された**（実機で再現：0→5.11m→送球→アウト）＝
    // 「勝手に盗塁しようとする」と読めるうえ、**押さない＝損**という既定になっていた。
    // 自動リードは原作の仕様ではない（説明書p24のけん制は守備側の操作だけ）。
    const dir = offensePad.direction();
    const held = attackIsHuman ? baseFromPadDirection(dir.x, dir.y) : null;
    for (const v of leadingRunners()) {
      // 転んでいる間はリードも広がらない（フェーズF-26-4。塁上で蹴って外した走者）
      if (v.stumbleSec > 0) continue;
      const from = v.origin as 'first' | 'second' | 'third';
      if (attackIsHuman && held !== leadDirectionBase(from)) continue;
      const limit = attackIsHuman ? MAX_LEAD : cpuLeadDistance(from, v.speed);
      v.lead = Math.min(v.lead + LEAD_SPEED * d, limit);
      // **一度でも塁を離れたかを覚えておく**（フェーズII-56）。持ち越し（L-32）は
      // 「離れた走者が最後にどこにいたか」なので、**一度も離れていない走者は
      // 持ち越さない**＝次の球は従来どおり標準のリード（`stealLeadFor`）から走れる。
      if (v.lead > 0) v.ledOff = true;
      v.pos = leadPosition(from, v.lead);
      v.target = { ...v.pos };
      placeRunner(v);
    }
  }

  /**
   * けん制球のリリースと同時に、その塁の走者が帰塁を始める（実際の野球で走者が
   * 塁へ戻るのと同じ）。既存の帰塁（startRunnerReturn）に合流させることで、
   * 送球の時間競争・決着処理はけん制専用の分岐を一切持たずに済む
   * （持ち時間＝そのときのリード距離になる）。
   */
  function startLeadReturn(base: BaseKey): void {
    if (base === 'home') return;
    const leading = leadingRunners().find((v) => v.origin === base);
    if (leading) startRunnerReturn(base);
  }

  /**
   * 操作ヒントの表示状態を毎フレーム合わせる。守備の操作（飛行中＝ファインプレイ／
   * 確保中＝ランダンプレイ）と走塁の操作を**それぞれ独立に**決める（フェーズD-20）。
   *
   * 守備と攻撃は排他だったので長らく1つの表示チャンネルで足りていたが、2P PLAY では
   * **両方に人間がいる**ので、どちらか一方だけを出すと片方は操作を案内されないまま
   * プレーすることになる（既存の「意思決定材料は隠さない」方針に反する）。
   * CPUが担っている側のヒントを落とすのは `setPlayPrompt` の側。
   */
  function syncPlayPrompt(): void {
    if (phase === null || phase === 'resolved') {
      clearPlayPrompt();
      return;
    }
    setPlayPrompt(defensePromptKind(), offensePromptKind());
  }

  /** 守備側に出すヒント（人間が守備を操作していないときは出さない＝setPlayPromptが落とす） */
  function defensePromptKind(): PlayPromptKind | null {
    if (phase === 'flying') {
      // 一時効果（フェーズM-33）はファインプレイより先に案内する：どちらも「届かない
      // 打球に手を伸ばす」手だが、こちらは**払えば確実に範囲が広がる**のに対しあちらは
      // 外せば起き上がるまで動けない＝先に見せるべきなのは代償の軽いほう…ではなく、
      // **回数券のほうが押せる場面が圧倒的に少ない**から（ファインプレイは毎打球押せる）。
      // 案内が一時的に隠れても失われる判断が無いほうを後ろに回す、という
      // `dropkick` を `recall` より先に出すのと同じ基準。
      if (catchEffectCandidate() !== null) return 'catchEffect';
      return finePlayAvailable() ? 'finePlay' : null;
    }
    // 蹴られる危険（フェーズF-26-4）は他のどの案内よりも先に出す。ランダンで詰めるか
    // 塁へ投げるかという、いま選び直せる判断そのものに関わるため。
    if (kickDangerActive()) return 'kickDanger';
    // 送球中（throwing）はボールが手を離れているのでランダンは仕掛けられない。
    const canRundown = phase === 'possessed' || phase === 'carrying';
    if (!canRundown) return null;
    // 盗塁されている間は、まず「塁へ投げろ」を案内する（ランダンは走者に追いつく
    // プレーなので、走り出した直後のこの局面では送球が本命の対処になる）。
    if (hasLiveRunner()) return playKind === 'steal' ? 'stealThrow' : 'rundown';
    // けん制モードでまだ誰も走っていない＝にらみ合い中。投げる操作を案内する
    return playKind === 'pickoff' ? 'pickoff' : null;
  }

  /** 攻撃側（走塁）に出すヒント */
  function offensePromptKind(): PlayPromptKind | null {
    // ヒットエンドラン（フェーズH-28）の窓はいちばん短い（投球が捕手に届くまで）ので、
    // どの案内よりも先に出す。**この間だけKは帰塁ではなくスイング**なので、案内を
    // 出さないと「Kを押したら振ってしまった」になる（意思決定材料は隠さない）。
    if (playKind === 'steal' && canHitAndRun?.()) return 'hitAndRun';
    if (tagUpChanceOpen) return 'tagUp';
    // バイクで塁を行き過ぎている走者がいる間は、まずそれを伝える（フェーズF-26-3）。
    // 回避手段はある（K）が、いま刺されうる局面であることが見えていないと押せない
    // ＝「リード!」と同じ扱い（意思決定材料は隠さない）。
    if (overrunRunners().length > 0) return 'overrun';
    // 止まっている走者がいる間も同じ扱い（フェーズN-34）＝塁を踏んでいないので刺されうる。
    // 「オーバーラン」と違ってこちらは**自分で選んで止まっている**が、いま何が起きていて
    // どう抜けるのか（走る／戻る）が見えていないと、次の判断ができない。
    if (holdingRunners().length > 0) return 'holding';
    const recallable = recallableBases();
    // けん制モードでリード中（まだ誰も走っていない）なら「刺されうる」ことを先に伝える。
    const leadingOnly = playKind === 'pickoff' && sentRunners.size === 0;
    // **「刺されうる」を出すのは実際に塁を離れているときだけ**（フェーズII-56）。
    // それまでは塁についたままでもこの案内が出ていたが、自動リードが無くなった以上
    // 「リード!」は事実と食い違う（＝押していない人に危険を告げることになる）。
    if (leadingOnly && leadingRunners().some((v) => v.lead > 0)) return 'lead';
    // 塁についたままの走者しかいない＝**押せばリードできる**ことを案内する。自動で
    // リードしなくなった以上、ここを出さないと**リードという操作そのものが画面の
    // どこにも現れない**（走者が動かないのでフィードバックも無い）。
    if (leadingOnly && leadingRunners().length > 0) return 'leadStart';
    // ドロップキック（フェーズF-26-4）は帰塁より先に案内する：野手が寄ってから蹴るまでの
    // 猶予が短く、押せること自体を知らなければ選択肢として存在しないため。帰塁（K）は
    // いつでも押せる標準操作なので、案内が一時的に隠れても失われる判断が無い。
    if (dropkickableRunners().length > 0) return 'dropkick';
    if (recallable.length === 0) return null;
    // 止まれる走者がいるなら、帰塁と一緒に「止まる」も案内する（フェーズN-34）。
    // 帰塁を消さずに1つの2行に収めるのは、**この2つが同じ場面の2つの逃げ道**だから
    // （行く／戻る／止まる のうち、押せる2つを並べて見せないと選択になっていない）。
    if (holdHintActive()) return 'hold';
    // 進塁を仕掛けた走者がいるなら従来どおりの帰塁ヒント。
    return 'recall';
  }

  /** 今この瞬間にファインプレイを仕掛けられるか（跳べる野手が射程内にいるか） */
  function finePlayAvailable(): boolean {
    if (phase !== 'flying' || !ballState || finePlay !== null) return false;
    if (elapsed < CATCH_MIN_PLAY_SEC) return false;
    return finePlayFielder(fielderPos, { x: ballState.x, z: ballState.z }) !== null;
  }

  /** 跳んでいる最中だけリーチが伸びる（着地・起き上がり中は通常のリーチに戻る） */
  function activeFinePlayReach(): FinePlayReach | undefined {
    if (!finePlay || finePlay.t >= FINE_PLAY_ACTIVE_SEC) return undefined;
    return finePlayReach(finePlay.id, finePlay.kind);
  }

  /** ファインプレイ中（跳んでいる＋起き上がるまで）の野手は一斉移動の対象外 */
  function isFinePlayBusy(id: FielderId): boolean {
    return finePlay !== null && finePlay.id === id;
  }

  function startFinePlay(id: FielderId, kind: FinePlayKind, dir: Vec2): void {
    clearFinePlay();
    finePlay = {
      id,
      kind,
      dir,
      t: 0,
      recoverSec: kind === 'jump' ? FINE_PLAY_JUMP_RECOVERY_SEC : FINE_PLAY_DIVE_RECOVERY_SEC,
    };
  }

  /** 跳んだ姿勢（浮き・伏せ）を解いて立たせる */
  function clearFinePlay(): void {
    if (!finePlay) return;
    const entity = fielderById.get(finePlay.id);
    // 高さだけ戻せばよい（伏せ・伸びは姿勢が持つので、次のフレームの `setPlayerPose` が
    // 全関節を書き直した時点で解ける。フェーズE-25-(e)）
    if (entity) entity.group.position.y = 0;
    finePlay = null;
  }

  /**
   * ファインプレイの進行（跳んでいる間の burst 移動と、起き上がりの計時）。
   * ダイビング中は FIELDER_SPEED より速く跳んだ方向へ移動する＝走って追うより遠くへ届く。
   */
  function updateFinePlay(d: number): void {
    if (!finePlay) return;
    finePlay.t += d;
    if (finePlay.t >= FINE_PLAY_ACTIVE_SEC + finePlay.recoverSec) {
      clearFinePlay();
      return;
    }
    if (finePlay.kind === 'dive' && finePlay.t < FINE_PLAY_ACTIVE_SEC) {
      const p = fielderPos[finePlay.id];
      p.x += finePlay.dir.x * FINE_PLAY_DIVE_SPEED * d;
      p.z += finePlay.dir.z * FINE_PLAY_DIVE_SPEED * d;
      clampToField(p);
    }
  }

  /** ジャンプの滞空（0→1→0の弧）。ジャンプ以外・跳んでいない野手は0 */
  function jumpArc(id: FielderId): number {
    if (!finePlay || finePlay.id !== id || finePlay.kind !== 'jump') return 0;
    return Math.sin(Math.PI * Math.min(1, finePlay.t / FINE_PLAY_ACTIVE_SEC));
  }

  /**
   * ファインプレイ中の高さ（ジャンプ＝実際に宙に浮く）。**ダイビングは 0**：
   * 伏せている低さは姿勢（`dive`）が腰を落として作るので、群ごと沈めると二重になる
   * （フェーズE-25-(e)。それまでは姿勢が無かったので沈めることで伏せを表していた）。
   */
  function finePlayLift(id: FielderId): number {
    if (!finePlay || finePlay.id !== id || finePlay.kind !== 'jump') return 0;
    return jumpArc(id) * FINE_PLAY_JUMP_LIFT;
  }

  /**
   * ファインプレイ中の姿勢（フェーズE-25-(e)）。ジャンプは**跳んでいる高さの進行度**、
   * ダイビングは**伸び切るまでの進行度**をそのまま渡す＝腕が伸び切るフレームと最高到達点
   * （跳び込みの終わり）が必ず一致する。
   *
   * 跳んだ方向は姿勢に渡さない：向きは `movePlayerTo` が実際の移動から合わせるので、
   * **跳び込んだ先を向いて伸びる**（ジャンプは移動が無いので向きは変わらない）。
   */
  function applyFinePlayPose(entity: FielderEntity): void {
    if (!finePlay || finePlay.id !== entity.id) return;
    if (finePlay.kind === 'jump') {
      setPlayerPose(entity.group, { kind: 'jump', lift: jumpArc(entity.id) });
      return;
    }
    setPlayerPose(entity.group, {
      kind: 'dive',
      t: Math.min(1, finePlay.t / FINE_PLAY_ACTIVE_SEC),
    });
  }

  /**
   * ファインプレイを仕掛ける（人間守備のA、説明書p23「飛んできたボールに向けて+を入れA」）。
   * 方向が無ければ何もしない。跳ぶのはボールにもっとも近い投手以外の野手で、
   * 射程内に誰もいなければ空振り（塁指定の「該当者なしなら何もしない」と同じ扱い）。
   * 跳んでいる/起き上がり中は次のファインプレイを受け付けない（連打で跳び続けられない）。
   */
  function tryFinePlay(): void {
    if (!finePlayAvailable() || !ballState) return;
    const { x, y } = defensePad.direction();
    const kind = finePlayKindFromPad(x, y);
    if (kind === null) return;
    const ballPos = { x: ballState.x, z: ballState.z };
    const id = finePlayFielder(fielderPos, ballPos);
    if (id === null) return;
    startFinePlay(id, kind, kind === 'jump' ? { x: 0, z: 0 } : normalize(padToWorldDir(x, y)));
  }

  /**
   * 今この瞬間に送球できるか。フライ捕球直後の持ち替え（タッチアップ局面）と、
   * 盗塁で投球が捕手に届くまでの待ちを、同じ1つのタイマーで表す。
   */
  function canThrowNow(): boolean {
    return throwHoldTimer >= throwHoldSec;
  }

  /** ボールが手元にあるか（盗塁で投球が届く前だけ false）。ランダンプレイの可否 */
  function hasBallInHand(): boolean {
    return throwHoldTimer >= ballArriveSec;
  }

  /** 送球・確保のたびに待ちを解除する（次の確保は普通にすぐ投げられる） */
  function clearThrowHold(): void {
    throwHoldSec = 0;
    throwHoldTimer = 0;
    ballArriveSec = 0;
    pitchBallFrom = null;
  }

  function resetFielders(): void {
    clearFinePlay();
    // 蹴り倒されたまま次のプレーへ持ち越さない（フェーズF-26-4。行動不能は1プレー限り）
    clearDownedFielders();
    // 振り抜きも持ち越さない（フェーズHH-55。見た目だけの時計だが、次のプレーの配置は
    // `snap` で直立に戻すので、残しておくと守備位置に着いた野手が1人だけ投げ終わる）
    throwPose = null;
    fielderPos = {} as Record<FielderId, Vec2>;
    for (const f of fielders) {
      const home = FIELDER_HOME_POSITIONS[f.id];
      fielderPos[f.id] = { ...home };
      movePlayerTo(f.group, home.x, 0, home.z, { snap: true });
      // 群の回転・拡大には触らない：跳躍・伏せ・倒れはすべて**姿勢**が作るので
      // （フェーズE-25-(e)で拡大と傾けをやめた）、戻すべき状態がここには残らない。
      setPlayerColor(f.group, FIELDER_COLOR);
    }
  }

  /**
   * いま野手が手を伸ばす先（フェーズE-25-(c)の捕球アニメ）。飛んでいる打球・地面に
   * こぼれたボールが対象で、それ以外（送球中・確保中）は null。
   */
  function reachTarget(): Vec2 | null {
    if (phase === 'flying' && ballState) return { x: ballState.x, z: ballState.z };
    if (phase === 'loose') return looseBallPos;
    return null;
  }

  /**
   * いま送球を受けようとしている野手（フェーズHH-55）。**受け手は release の瞬間に
   * 確定している**（`BASE_COVER_FIELDER`＝到着時にボールを持つのと同じ1か所から引く）
   * ので、「投げた先の塁の野手がグラブを構える」＝**どこへ投げたかが姿勢からも読める**。
   *
   * 飛んでいる打球（`reachTarget`）と分けてあるのは、送球のボールは野手の頭上を
   * 通り過ぎるから：同じ経路に混ぜると、**通り道に立っていただけの野手までグラブを出す**
   * （捕るのは受け手1人だけなのに）。蹴り倒されている受け手（F-26-4）は捕れずに
   * こぼすので、そこは `down` の枝が先に効く。
   */
  function throwReceiverId(): FielderId | null {
    if (phase !== 'throwing' || !throwState) return null;
    return BASE_COVER_FIELDER[throwState.target];
  }

  function syncFielderMeshes(): void {
    const reach = reachTarget();
    const receiver = throwReceiverId();
    for (const f of fielders) {
      const p = fielderPos[f.id];
      const down = isFielderDown(f.id);
      // グラブは投げない側の手（マウンドの野手は投手の ARM で左右が入れ替わる）
      const glove = gloveOf.get(f.group);
      if (glove) attachGlove(f.group, glove, throwArmFor(f.id).side);
      // 位置を書くと同時に歩き/走りが起きる（歩調も向きも実際に動いた量から。E-25-(c)）
      movePlayerTo(f.group, p.x, finePlayLift(f.id), p.z);
      // 蹴り倒された野手（フェーズF-26-4）は**実際に倒れて起き上がる**（E-25-(e)。
      // それまでは沈めるだけだった）＝守備側にも攻撃側にも「この野手はいま動けない」が
      // 一目で分かる（意思決定材料は隠さない）。**倒れる向きは蹴られた側＝仰向け。**
      // ボールが近い野手・持っている野手はグラブを構える＝**誰が捕りにいっているか／
      // 誰が持っているかが姿勢で読める**。
      // **判定には一切効かない**（捕球半径は core/fielding.ts の CATCH_RADIUS のまま）。
      if (down) setPlayerPose(f.group, { kind: 'fallen', t: downedProgress(f.id), forward: false });
      // 送球の振り抜き（フェーズHH-55）。**持っている（`holderId`）より先に見る**：
      // 投げた瞬間はまだ `holderId` が投げた本人のままなので、後に置くと捕球の構えに
      // 上書きされて動作が一度も出ない。向きは投げた先＝腕の振りと球の飛ぶ先が揃う。
      else if (throwPose && throwPose.id === f.id) {
        setPlayerFacing(f.group, throwPose.yaw);
        setPlayerPose(f.group, {
          kind: 'throw',
          t: 1 - throwPose.sec / THROW_POSE_SEC,
          arm: throwPose.arm,
        });
      } else if (holderId === f.id) setPlayerPose(f.group, { kind: 'catch', reach: 0 });
      // 送球を受ける野手は、飛んでくるボールへグラブを伸ばす（同上）。近づくほど
      // 伸び切る＝**捕球（E-25-(c)）とまったく同じ形の進行度**で、専用の値を持たない。
      else if (receiver === f.id && throwState) {
        const d = Math.hypot(throwState.pos.x - p.x, throwState.pos.z - p.z);
        setPlayerFacing(f.group, Math.atan2(throwState.pos.x - p.x, throwState.pos.z - p.z));
        setPlayerPose(f.group, {
          kind: 'catch',
          reach: d < CATCH_POSE_RANGE ? 1 - d / CATCH_POSE_RANGE : 0,
        });
      } else if (reach) {
        const d = Math.hypot(reach.x - p.x, reach.z - p.z);
        if (d < CATCH_POSE_RANGE) {
          setPlayerPose(f.group, { kind: 'catch', reach: 1 - d / CATCH_POSE_RANGE });
        }
      }
      applyFinePlayPose(f);
    }
  }

  /** 目標へ最大 `step` だけ近づける（行き過ぎない。決着後の余韻で守備位置へ戻るのに使う） */
  function walkToward(p: Vec2, target: Vec2, step: number): void {
    const dx = target.x - p.x;
    const dz = target.z - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= CPU_SEEK_EPSILON) return;
    const k = Math.min(step, dist) / dist;
    p.x += dx * k;
    p.z += dz * k;
  }

  /** 場外へ出ないよう位置を丸める（一斉移動でも各自が個別にクランプされる） */
  function clampToField(p: Vec2): void {
    const r = Math.hypot(p.x, p.z);
    if (r > FIELDER_BOUND_RADIUS) {
      const scale = FIELDER_BOUND_RADIUS / r;
      p.x *= scale;
      p.z *= scale;
    }
  }

  /**
   * 野手の移動（1フレーム分）。原作準拠（説明書p20）：**塁カバー4人は自動で各塁へ入り、
   * 残り（P/SS/LF/CF/RF）は十字キーで全員が同じ方向へ一斉移動する**。CPU守備は、
   * 目標にもっとも近い野手が目標へ向かう方向を全員に適用する（＝人間の一斉移動と同じ
   * 動かし方をCPUがやる。コードパスを分けないための設計）。
   *
   * 打球の飛行中（phase='flying'）と、叩き落とされたボールを拾いにいく局面
   * （phase='loose'。フェーズF-26-4）で共通に使う＝**落球のあとの守備が、打球を追うのと
   * まったく同じ操作になる**（新しい操作を覚えずに済む）。cpuTarget が null なら
   * CPUは動かない（追う先が無い）。
   *
   * 跳んでいる／蹴り倒されている野手は、どちらの列からも外れる（動けないことの実体）。
   */
  function updateFielderMovement(d: number, cpuTarget: Vec2 | null): void {
    for (const [id, base] of Object.entries(BASE_COVER_ASSIGNMENTS) as Array<
      [FielderId, BaseKey]
    >) {
      if (isFinePlayBusy(id) || isFielderDown(id)) continue;
      const p = fielderPos[id];
      const target = BASE_POSITIONS[base];
      const dx = target.x - p.x;
      const dz = target.z - p.z;
      const dist = Math.hypot(dx, dz);
      if (dist > CPU_SEEK_EPSILON) {
        const step = Math.min(FIELDER_SPEED * d, dist);
        p.x += (dx / dist) * step;
        p.z += (dz / dist) * step;
      }
    }

    // 一斉移動の方向を決める（人間：十字キー / CPU：最寄り野手→目標の正規化ベクトル。
    // CPUの最寄り野手は目標のごく近くで1ステップ幅の微振動をし得るが、振動幅は
    // 捕球半径よりはるかに小さく、その前に自動捕球が成立するため実害はない）
    let moveDir: Vec2 = { x: 0, z: 0 };
    if (isDefenseHuman()) {
      moveDir = padToWorldDir(defensePad.direction().x, defensePad.direction().y);
    } else if (cpuTarget) {
      // 追う役は動ける野手から選ぶ（倒れている野手を基準にすると、動けない者の位置で
      // 全員の向きが決まってしまう）。全員倒れているときだけ従来どおり全員から選ぶ。
      const movable = CONTROLLABLE_FIELDERS.filter((id) => !isFielderDown(id));
      const pool = movable.length > 0 ? movable : CONTROLLABLE_FIELDERS;
      const controllablePositions = Object.fromEntries(
        pool.map((id) => [id, fielderPos[id]]),
      ) as Record<FielderId, Vec2>;
      const chaser = nearestFielder(cpuTarget, controllablePositions);
      const p = fielderPos[chaser];
      const dx = cpuTarget.x - p.x;
      const dz = cpuTarget.z - p.z;
      const dist = Math.hypot(dx, dz);
      if (dist > CPU_SEEK_EPSILON) moveDir = { x: dx / dist, z: dz / dist };
    }
    for (const id of CONTROLLABLE_FIELDERS) {
      if (isFinePlayBusy(id) || isFielderDown(id)) continue;
      const p = fielderPos[id];
      p.x += moveDir.x * FIELDER_SPEED * d;
      p.z += moveDir.z * FIELDER_SPEED * d;
      clampToField(p);
    }
    lastGroupDir = moveDir;
  }

  /**
   * その点にいちばん近い野手との距離（全野手＝塁カバーの4人も含む。捕球の候補と同じ
   * 母集団にそろえる＝「捕れる位置にいるのに猶予だけ進む」が起きない）。
   */
  function nearestFielderDistance(x: number, z: number): number {
    let min = Infinity;
    for (const f of fielders) {
      const d = distance(fielderPos[f.id], { x, z });
      if (d < min) min = d;
    }
    return min;
  }

  function syncBall(b: BattedBall): void {
    // 観客席の上では、その段の上面より下へ描かない（物理は地面しか知らない＝見た目だけ）
    const floor = surfaceAt(b.x, b.z);
    ball.position.set(b.x, Math.max(b.y, floor) + BALL_RADIUS, b.z);
    shadow.position.set(b.x, floor + 0.05, b.z);
  }

  /** その地点で落ちた球が止まる面の高さ（観客席の段・通路・グラウンド。見た目だけ） */
  function surfaceAt(x: number, z: number): number {
    const park = ballpark();
    return standSurfaceHeight(park, STAND_STYLE[park.id].rows, x, z);
  }

  /**
   * 余韻の間の球の転がり（見た目だけ）。**打球の物理そのもの**（`stepBattedBall`）で進め、
   * 物理が知らない2つだけを足す：**観客席に落ちたらそこで止まる**／**ファウル地域の柵
   * （高さ2.4m）に低く当たったら跳ね返る**。どちらも決着の後にしか起きない
   * （判定は `finish` までに済んでいる）。
   */
  function stepAftermathBall(b: BattedBall, d: number): BattedBall {
    const prevR = Math.hypot(b.x, b.z);
    const next = stepBattedBall(b, d, ballpark());
    const floor = surfaceAt(next.x, next.z);
    if (floor > 0 && next.y <= floor) {
      next.y = floor;
      ballInStands = true;
      return next;
    }
    const deg = normalizeDeg((Math.atan2(next.x, -next.z) * 180) / Math.PI);
    if (Math.abs(deg) > FENCE_ANGLE_LIMIT_DEG && next.y < FOUL_BARRIER_HEIGHT) {
      const wall = outerWallDistance(ballpark(), deg);
      const r = Math.hypot(next.x, next.z);
      if (r >= wall && prevR < wall) {
        const nx = next.x / r;
        const nz = next.z / r;
        const outward = next.vx * nx + next.vz * nz;
        if (outward > 0) {
          next.vx -= (1 + WALL_RESTITUTION) * outward * nx;
          next.vz -= (1 + WALL_RESTITUTION) * outward * nz;
        }
        const inside = (wall - 0.01) / r;
        next.x *= inside;
        next.z *= inside;
      }
    }
    return next;
  }

  function runnerMeshFor(from: ForcedRunner['from']): THREE.Group {
    return from === 'batter' ? runners.batter : runners[from];
  }

  /**
   * 走者ビジュアルの走塁スキル関連の初期値（バイク＝F-26-3／ドロップキック＝F-26-4）。
   * **プレーごとに作り直される**ので、使用の履歴（bikeUsed / dropkickUsed）は自動的に
   * 1プレー限りになる＝「1プレーに1回」の規則を別の場所で管理しなくてよい。
   */
  function runnerSkillFields(id: RunnerId): Pick<
    RunnerVisual,
    | 'bikeCapable'
    | 'bike'
    | 'bikeUsed'
    | 'overrun'
    | 'overrunSec'
    | 'dropkickCapable'
    | 'dropkickUsed'
    | 'stumbleSec'
    | 'kickSec'
  > {
    return {
      bikeCapable: canBike(id),
      bike: false,
      bikeUsed: false,
      overrun: false,
      overrunSec: 0,
      dropkickCapable: canDropkick(id),
      dropkickUsed: false,
      stumbleSec: 0,
      kickSec: 0,
    };
  }

  /** 現在の塁状況から走者ビジュアル一覧を作る（フォース対象は移動、それ以外は静止表示） */
  function buildRunnerVisuals(
    baseRunners: BaseRunners,
    forcedList: ForcedRunner[],
    batterId: RunnerId,
    leads: Partial<Record<'first' | 'second' | 'third', number>> = {},
  ): RunnerVisual[] {
    const visuals: RunnerVisual[] = [];

    const add = (from: ForcedRunner['from'], origin: Vec2, id: RunnerId) => {
      visuals.push(
        makeRunnerVisual(from, origin, id, forcedList.find((f) => f.from === from) ?? null),
      );
    };

    // 塁上の走者は**リードを取った位置から**走り出す（フェーズY-46）。渡されなければ
    // 従来どおり塁の真上。打者走者だけは本塁から（リードという概念が無い）。
    const startOf = (base: 'first' | 'second' | 'third'): Vec2 => {
      const lead = leads[base] ?? 0;
      return lead > 0 ? leadPosition(base, lead) : BASE_POSITIONS[base];
    };

    add('batter', BASE_POSITIONS.home, batterId);
    if (baseRunners.first) add('first', startOf('first'), baseRunners.first);
    if (baseRunners.second) add('second', startOf('second'), baseRunners.second);
    if (baseRunners.third) add('third', startOf('third'), baseRunners.third);
    return visuals;
  }

  /**
   * 走者ビジュアルを1人ぶん作る（プレー開始時の一括生成と、ヒットエンドランで
   * 途中から打者走者を足すとき＝フェーズH-28 の共通処理）。
   * 配置は瞬間移動（走ってきたわけではない）。
   */
  function makeRunnerVisual(
    from: ForcedRunner['from'],
    origin: Vec2,
    id: RunnerId,
    runner: ForcedRunner | null,
    /**
     * この区間がフォースプレーか（フェーズK-31）。既定は「走行区間があるなら
     * フォース」＝ここを通る2つの呼び出し（打球開始時の一括生成・ヒットエンドランで
     * 足す打者走者）はどちらもフォースの一覧から作られているので、既定のままで正しい。
     */
    forcePlay: boolean = runner !== null,
  ): RunnerVisual {
    const mesh = runnerMeshFor(from);
    mesh.visible = true;
    // メッシュは使い回しなので、前のプレーでバイクに乗った色と車体が残らないよう毎回戻す
    setPlayerColor(mesh, RUNNER_COLOR);
    showBike(mesh, false);
    movePlayerTo(mesh, origin.x, 0, origin.z, { snap: true });
    return {
      mesh,
      origin: from,
      id,
      speed: speedOf(id),
      pos: { ...origin },
      target: runner ? BASE_POSITIONS[runner.to] : origin,
      forced: runner,
      forcePlay,
      returning: false,
      out: false,
      arrived: false,
      lead: 0,
      // 打球のプレーにリードの持ち越しは無い（決着は `kind:'result'` で leads を返さない）
      ledOff: false,
      // 打球と同時に走り出す走者＝「打つのを見てから」走っている（フェーズH-28の
      // 飛び出しではない）ので、フライを捕られたら従来どおり無かったことになる。
      brokeEarly: false,
      retreatUsed: false,
      holding: false,
      holdUsed: false,
      ...runnerSkillFields(id),
    };
  }

  /**
   * 走塁だけのプレー（けん制・盗塁）の走者ビジュアル。打者走者はいない（打席は続いている）
   * ので塁上の走者だけを作り、フォースも無い（誰も走る義務がない）状態から始める。
   *
   * leads は塁を離れている距離。けん制は0から LEAD_SPEED で育て、盗塁は走り出す走者だけを
   * 標準のリード（STEAL_LEAD）に置く。
   */
  function buildRunnerPlayVisuals(
    baseRunners: BaseRunners,
    leads: Partial<Record<'first' | 'second' | 'third', number>>,
  ): RunnerVisual[] {
    const visuals: RunnerVisual[] = [];
    for (const base of ['first', 'second', 'third'] as const) {
      const id = baseRunners[base];
      if (id === null) continue;
      const mesh = runnerMeshFor(base);
      const lead = leads[base] ?? 0;
      const pos = lead > 0 ? leadPosition(base, lead) : { ...BASE_POSITIONS[base] };
      mesh.visible = true;
      setPlayerColor(mesh, RUNNER_COLOR);
      movePlayerTo(mesh, pos.x, 0, pos.z, { snap: true });
      visuals.push({
        mesh,
        origin: base,
        id,
        speed: speedOf(id),
        pos: { ...pos },
        target: { ...pos },
        forced: null,
        // 走塁だけのプレー（けん制・盗塁）に押し出しは無い＝**全員タッチプレー**
        // （フェーズK-31）。走り続ける限り帰結は従来どおりで、引き返す道だけが増える。
        forcePlay: false,
        returning: false,
        out: false,
        arrived: false,
        lead,
        // **持ち越したリードから始まる走者は、既に塁を離れている**（フェーズII-56）＝
        // 何も押さなくてもその深さのまま次のプレーへ持ち越す。ここを false から始めると
        // **投手がけん制モードに入り直すだけで持ち越しを消せる**ことになり、L-32が
        // 明示的に禁じた「投げずに入り直してリードを消す」がそのまま復活する。
        ledOff: lead > 0,
        // 立つのは打球へ引き継いだ瞬間（convertToBattedBall）＝いま走っている走者だけ
        brokeEarly: false,
        retreatUsed: false,
        holding: false,
        holdUsed: false,
        ...runnerSkillFields(id),
      });
    }
    return visuals;
  }

  /**
   * 走塁だけのプレー（けん制球＝説明書p24／盗塁＝説明書p13）の共通の開始処理。
   * 打球（launch）と違って飛行フェーズを経ず、ボールを持った野手（けん制＝投手、
   * 盗塁＝捕手）の possessed から始まる。以降の送球・ランダン・走塁・決着は
   * 打球のプレーと完全に同じ経路を通る。
   */
  function beginRunnerPlay(
    kind: 'pickoff' | 'steal',
    baseRunners: BaseRunners,
    outs: number,
    holder: FielderId,
    leads: Partial<Record<'first' | 'second' | 'third', number>>,
  ): void {
    phase = 'possessed';
    playKind = kind;
    pickoffTimer = 0;
    pickoffIdleTimer = 0;
    bikeHoldSec = 0;
    holdArmed = [];
    ballState = null;
    originalRunners = baseRunners;
    originalBases = occupancy(baseRunners);
    // 走塁だけのプレーに打者走者はいない（打席は続いている）
    batterRunnerId = ANONYMOUS_RUNNER;
    outsBefore = outs;
    forced = [];
    sentRunners.clear();
    outcome = null;
    pauseT = 0;
    elapsed = 0;
    restingT = 0;
    restingNearest = Infinity;
    possessedTimer = 0;
    holdSafeTimer = 0;
    throwState = null;
    carryTarget = null;
    cpuRundownUsed = false;
    cpuThrewOnce = false;
    defenseOuts = 0;
    tagUpActive = false;
    clearThrowHold();
    queuedThrowBase = null;
    tagUpChanceOpen = false;
    clearPlayPrompt();

    resetFielders();
    // 塁カバーの4人はすでに塁に付いている状態から始まる（打球のときのように、打った
    // 瞬間から走ってカバーに入る時間は無い）。
    for (const [id, base] of Object.entries(BASE_COVER_ASSIGNMENTS) as Array<
      [FielderId, BaseKey]
    >) {
      fielderPos[id] = { ...BASE_POSITIONS[base] };
    }
    holderId = holder;
    syncFielderMeshes();

    runnerVisuals = buildRunnerPlayVisuals(baseRunners, leads);

    const p = fielderPos[holder];
    ball.visible = true;
    ball.scale.setScalar(BALL_SCALE);
    ball.position.set(p.x, BALL_RADIUS, p.z);
    shadow.visible = false;
  }

  function cleanup(): void {
    phase = null;
    aftermathT = 0;
    ballFreeAtFinish = false;
    ballInStands = false;
    lastGroupDir = { x: 0, z: 0 };
    returnToss = null;
    returnTossDone = false;
    soundPhase = null;
    playKind = 'batted';
    pickoffTimer = 0;
    pickoffIdleTimer = 0;
    bikeHoldSec = 0;
    holdArmed = [];
    ballState = null;
    forced = [];
    sentRunners.clear();
    holderId = null;
    carryTarget = null;
    throwState = null;
    outcome = null;
    tagUpActive = false;
    clearThrowHold();
    queuedThrowBase = null;
    tagUpChanceOpen = false;
    clearPlayPrompt();
    clearFinePlay();
    clearDownedFielders();
    ball.visible = false;
    ball.scale.setScalar(1);
    shadow.visible = false;
    for (const v of runnerVisuals) v.mesh.visible = false;
    runnerVisuals = [];
  }

  function finish(result: FieldPlayOutcome): void {
    // 決着した瞬間にボールが誰の手にも無ければ、余韻の間も転がり続ける（ファウル・安打）。
    // 捕られた球・送球が着いた球は野手の手の中のまま（`phase` を書き換える前に見る）
    ballFreeAtFinish =
      holderId === null && throwState === null && ballState !== null && phase === 'flying';
    ballInStands = false;
    outcome = result;
    phase = 'resolved';
    // 帰結確定後、でっかいモードへカット復帰するまでの見せ時間（フェーズE-23）。
    // **ファウルは長め**（打球がどこへ行ったかを見てから戻る。フェーズWW-71）
    pauseT = result.kind === 'foul' ? FOUL_RESULT_PAUSE_SEC : PLAY_RESULT_PAUSE_SEC;
    aftermathT = 0;
    returnToss = null;
    returnTossDone = false;
    tagUpChanceOpen = false;
    clearPlayPrompt();
    // ファウルは**プレーが無かったことになる**ので、走っていた走者は元の塁へ、打者走者は
    // 打席へ歩いて戻る（見た目だけ。決着はもう `outcome` に入っている）
    if (result.kind === 'foul') {
      for (const v of runnerVisuals) {
        if (v.out) continue;
        v.target =
          v.origin === 'batter'
            ? { ...BASE_POSITIONS.home }
            : { ...BASE_POSITIONS[v.origin as 'first' | 'second' | 'third'] };
      }
    }
  }

  /**
   * 決着後の余韻（フェーズWW-71）。**見た目だけ**を動かし続ける＝判定は一切しない
   * （捕球・送球・タッチ・進塁の確定はすべて `finish` までに済んでいる）。
   *
   * それまでは決着の瞬間に全員がその場で固まり、1秒止まった画を見せてから戻っていた
   * ＝**「間」ではなく一時停止**に見えていた（テストプレイの指摘）。
   */
  function updateAftermath(d: number): void {
    aftermathT += d;
    // ボール：誰の手にも無ければ転がり続ける（フェンスで跳ね返るのも同じ物理）。
    // 野手の手の中にあれば、少し置いてから**投手へ山なりに返す**（アウトの後の球回し）
    if (ballFreeAtFinish && ballState) {
      if (!ballState.resting && !ballInStands) {
        ballState = stepAftermathBall(ballState, d);
        syncBall(ballState);
      }
    } else if (returnToss) {
      returnToss.t = Math.min(returnToss.dur, returnToss.t + d);
      const k = returnToss.t / returnToss.dur;
      const x = returnToss.from.x + (returnToss.to.x - returnToss.from.x) * k;
      const z = returnToss.from.z + (returnToss.to.z - returnToss.from.z) * k;
      // 山なり（最高点は距離の1/8。球回しの軽い送球に見える高さ）
      const span = distance(returnToss.from, returnToss.to);
      const y = THROW_BALL_HEIGHT + 4 * (span / 8) * k * (1 - k);
      ball.position.set(x, y, z);
      if (k >= 1) {
        returnToss = null;
        returnTossDone = true;
        holderId = 'P';
      }
    } else if (holderId !== null) {
      const p = fielderPos[holderId];
      ball.position.set(p.x, THROW_BALL_HEIGHT, p.z);
      if (
        !returnTossDone &&
        holderId !== 'P' &&
        aftermathT >= AFTERMATH_TOSS_DELAY_SEC &&
        !isFielderDown(holderId)
      ) {
        const to = fielderPos.P;
        const span = distance(p, to);
        if (span > 1) {
          returnToss = { from: { ...p }, to: { ...to }, t: 0, dur: span / AFTERMATH_TOSS_SPEED };
          throwPose = {
            id: holderId,
            sec: THROW_POSE_SEC,
            arm: throwArmFor(holderId),
            yaw: Math.atan2(to.x - p.x, to.z - p.z),
          };
          holderId = null;
        }
      }
    }
    // 野手：決着した瞬間の一斉移動の向きのまま惰性で止まり、それから**守備位置へ歩いて戻る**
    // （プレーが終わったことが動きで分かる。急停止させると全員が固まって一時停止に見える）
    const coast = Math.max(0, 1 - aftermathT / AFTERMATH_COAST_SEC);
    for (const id of CONTROLLABLE_FIELDERS) {
      if (id === holderId || isFinePlayBusy(id) || isFielderDown(id)) continue;
      if (throwPose && throwPose.id === id) continue;
      const p = fielderPos[id];
      if (coast > 0) {
        p.x += lastGroupDir.x * FIELDER_SPEED * coast * d;
        p.z += lastGroupDir.z * FIELDER_SPEED * coast * d;
        clampToField(p);
        continue;
      }
      walkToward(p, FIELDER_HOME_POSITIONS[id], FIELDER_SPEED * AFTERMATH_JOG_SCALE * d);
    }
    // 塁に入っていた野手も、送球が済んだら守備位置へ戻る
    if (coast <= 0) {
      for (const id of Object.keys(BASE_COVER_ASSIGNMENTS) as FielderId[]) {
        if (id === holderId || isFielderDown(id)) continue;
        if (throwPose && throwPose.id === id) continue;
        walkToward(fielderPos[id], FIELDER_HOME_POSITIONS[id], FIELDER_SPEED * AFTERMATH_JOG_SCALE * d);
      }
    }
    syncFielderMeshes();
    // 走者：走っていた走者は行き先の塁まで走り切る（ファウルなら元の塁へ小走りで戻る）
    const jog = outcome?.kind === 'foul' ? AFTERMATH_JOG_SCALE : 1;
    for (const v of runnerVisuals) {
      if (v.out || v.stumbleSec > 0) continue;
      const remaining = distance(v.pos, v.target);
      if (remaining <= AFTERMATH_STOP_DISTANCE) continue;
      const t = Math.min(1, (runSpeed(v) * jog * d) / remaining);
      v.pos = { x: v.pos.x + (v.target.x - v.pos.x) * t, z: v.pos.z + (v.target.z - v.pos.z) * t };
      placeRunner(v);
    }
    syncRunnerPoses();
  }

  function decideFallback(b: BattedBall, restingSeconds: number): FieldPlayOutcome | null {
    // ファウルはこの関数の3か所からしか出ないので、バントの事実（フェーズAA-48）も
    // ここで打球から読むだけで済む（プレー側に覚えておく状態は増えない）。
    const foul = (): FieldPlayOutcome => ({ kind: 'foul', bunt: b.bunt });
    if (b.over === 'fly') {
      return isFairPosition(b.x, b.z) ? resultFromHit('homerun') : foul();
    }
    if (b.over === 'bounce') {
      return isFairPosition(b.x, b.z)
        ? resultFromHit('double') // エンタイトルツーベース
        : foul();
    }
    if (b.landing && !isFairPosition(b.landing.x, b.landing.z)) return foul();
    if (b.resting) {
      // ボールが静止しても即座にヒット確定にはせず、猶予時間の間はプレー続行
      // （野手が追いついて拾えば送球フェーズへ移れる）。かつては静止した瞬間に
      // 距離分類のヒットを確定していたため、野手が数メートル手前まで迫っていても
      // 「自動でツーベースヒット」になってしまっていた（実機テストプレイの報告。
      // 詳細はPROGRESS.md「実装メモ」）。猶予を過ぎても誰も拾えなければ、従来通り
      // 「守備が間に合わなかった」として距離分類のヒットで打ち切る。
      if (restingSeconds < RESTING_PICKUP_GRACE_SEC) return null;
      // 距離による分類は球場ごと（だいそうげんだけ、奥深くまで転がるとランニング
      // ホームランになる。説明書p25。フェーズC-14）
      return resultFromHit(fallbackHit(ballpark(), b.x, b.z));
    }
    return null;
  }

  function resultFromHit(hit: HitType): FieldPlayOutcome {
    const { runners: baseRunners, runs } = advanceOnHitRunners(
      originalRunners,
      batterRunnerId,
      hit,
      // ヒットエンドラン（フェーズH-28）で投球の前にスタートを切っていた走者は、
      // 安打のときもう1つ先まで行ける（単打で一塁走者が三塁へ）。走らせて打つことの
      // 見返りそのもので、**リスク（フライで刺されうる・空振りで盗塁失敗）と同じ場所に置く**。
      brokeEarlyBases(),
    );
    return { kind: 'result', outsAdded: 0, runs, baseRunners, hit };
  }

  /**
   * 投球の前にスタートを切っていた（＝いま飛び出している）走者の起点の塁
   * （フェーズH-28）。アウトになった走者は数えない（進塁も帰塁もしないため）。
   */
  function brokeEarlyBases(): Array<'first' | 'second' | 'third'> {
    return runnerVisuals
      .filter((v) => v.brokeEarly && !v.out && v.origin !== 'batter')
      .map((v) => v.origin as 'first' | 'second' | 'third');
  }

  /**
   * タッチアップの局面で、まだ塁を踏み直していない走者の起点の塁（フェーズH-28）。
   * 飛び出していた走者は走って戻っている最中なので、戻り切るまでは仕掛け直せない
   * （＝リタッチ）。**通常の帰塁（打球のプレー中に気が変わって戻した走者）は従来どおり
   * 仕掛け直せる**ので、この制限はタッチアップの局面にだけ効かせる。
   */
  function retouchPendingBases(): Array<'first' | 'second' | 'third'> {
    if (!tagUpActive) return [];
    return runnerVisuals
      .filter(
        (v) =>
          v.brokeEarly && v.returning && !v.arrived && !v.out && v.origin !== 'batter',
      )
      .map((v) => v.origin as 'first' | 'second' | 'third');
  }

  /** その塁へ向かっている（まだ到達も刺されもしていない）走者を1人返す＝刺せる走者 */
  function runnerHeadingTo(base: BaseKey): RunnerVisual | undefined {
    return runnerVisuals.find(
      (v) => v.forced?.to === base && !v.out && !v.arrived,
    );
  }

  /**
   * その塁に「すでにいる」走者を1人返す（進塁して到達済み、またはそこに留まっている走者）。
   * もう刺せないのでアウトにはならないが、送球先に走者が実在する以上プレー自体はあるため、
   * 「セーフ」と表示するために使う（走者が誰もいない塁への送球＝判定なしと区別する）。
   */
  function runnerAtBase(base: BaseKey): RunnerVisual | undefined {
    return runnerVisuals.find((v) => {
      if (v.out) return false;
      // 進塁して到達済みの走者はその行き先の塁にいる
      if (v.forced) return v.forced.to === base && v.arrived;
      // 進塁していない走者は元の塁に留まっている（'batter' は塁ではないので除外）
      return v.origin !== 'batter' && v.origin === base;
    });
  }

  /**
   * まだ刺せる走者＝塁間を走っている（進塁・帰塁の途中で、まだ塁を踏んでいない）走者。
   * 送球の対象にも、ランダンプレイのタッチ対象にもなる（塁上の走者は触れてもアウトに
   * ならないので、どちらの用途でもこの絞り込みが正しい）。
   */
  function liveRunners(): RunnerVisual[] {
    return runnerVisuals.filter((v) => v.forced !== null && !v.out && !v.arrived);
  }

  function hasLiveRunner(): boolean {
    return liveRunners().length > 0;
  }

  /**
   * ランダンプレイ（説明書p25）でタッチできる走者＝塁を踏んでいない走者。
   *
   * 塁間を走っている走者（liveRunners）に加え、けん制モードで**塁を離れている
   * （リード中の）走者**も対象になる。実際の野球でもリードしている走者にタッチすれば
   * アウトで、これが無いと「けん制球を投げて走者を塁から離したまま、ボールを持った
   * 野手が詰めて仕留める」（説明書p25の挟殺）が成立しない。塁上（リード0）の走者と
   * 到達済みの走者は塁を踏んでいるので触れない。
   *
   * liveRunners そのものを広げないのは、あちらが「送球で刺せる走者」＝ forced を
   * 必ず持つ走者の意味で、CPU守備の送球先（forced.to）とプレーの畳み判定に使われて
   * いるため（リード中の走者を混ぜると行き先が無く、けん制モードも終われなくなる）。
   */
  function taggableRunners(): RunnerVisual[] {
    const running = liveRunners();
    if (playKind !== 'pickoff') return running;
    return [...running, ...leadingRunners().filter((v) => v.lead > 0)];
  }

  /**
   * その塁でのプレーの帰結を、塁の状況で3通りに分ける（実機テストプレイの指摘への対応）。
   * 送球の release とランダンプレイの塁到達で共通に使う：
   * - その塁へ進塁中の走者がいる …… beatsRunner の判定で 'out' / 'safe'
   * - その塁にすでに走者がいる（到達済み・留まっている）…… もう刺せないので 'safe'
   * - 走者が誰もいない …… そもそもプレーが無いので null（アウト/セーフを表示しない）
   *
   * beatsRunner は「ボールがその走者より先に塁へ着くか」。送球は投げた時点での時間競争、
   * ランダンは実際にその塁へ立った時点で呼ぶので常に true になる。
   *
   * **フェーズK-31：塁を踏むだけでアウトになるのはフォースプレーだけ**（説明書p32
   * 「実際の野球のルール」）。タッチプレーの走者はここでは決まらず（null＝バナーも出さない）、
   * 塁で待つ野手のタッチ（`updateTag`）が決める。**「間に合わなかった＝セーフ」の判定は
   * 先に見る**ので、セーフのバナーは従来どおりこの瞬間に出る（遅れるのはアウトだけ）。
   *
   * 「走り続ける走者はどうせタッチされるのだから、ここでアウトにしても同じ」は**間違い**で、
   * それをやると引き返す道が消える（`heading.forcePlay` の分岐のコメント参照）。
   * その「どうせ同じ」の見立てを使ってよいのは、CPUが送球先を選ぶときの**予測**
   * （`throwWouldGet` → `throwRetiresRunner`）だけ。
   */
  function resolveBaseResult(
    base: BaseKey,
    beatsRunner: (runner: RunnerVisual) => boolean,
  ): 'out' | 'safe' | null {
    const heading = runnerHeadingTo(base);
    if (heading) {
      if (!beatsRunner(heading)) return 'safe';
      // **タッチプレーはここでは決まらない。** 走り続ける走者なら結局タッチされて同じ帰結に
      // なるが、それを**この時点で先取りしてはいけない**：先取りすると「投げられてから
      // 引き返す」という K-31 の要（`npm run balance:rundown` の28.6%の帯）が死ぬ
      // （実機で実際に踏んだ＝走者が三塁の20m手前にいるのにボール飛行中にアウトになった）。
      // 決めるのは塁で待つ野手のタッチ（`updateTag`）。
      if (!heading.forcePlay) return null;
      heading.out = true;
      heading.mesh.visible = false;
      defenseOuts += 1;
      return 'out';
    }
    return runnerAtBase(base) ? 'safe' : null;
  }

  /**
   * その走者が、自分の行き先の塁へ**向かって**走っているか（フェーズK-31）。
   *
   * false になるのは2つ。**バイクで塁を行き過ぎた走者**（`target` が塁の先にあり、塁からは
   * 遠ざかっている。F-26-3）と、**塁間で止まった走者**（フェーズN-34）。どちらも塁で
   * 待ち構えても走者のほうから来ないので、守備は走って追うしかない＝この守備モデルで
   * 「ランダンでないと刺せない」場面になる（`throwRetiresRunner`）。
   *
   * 逆に言うと、**止まってもフォース走者は塁へ投げられれば刺される**（`throwRetiresRunner`
   * の第1引数が先に効く）＝内野ゴロの帰結は止まる操作を入れても1つも変わらない。
   */
  function approachingOwnBase(v: RunnerVisual): boolean {
    return !v.overrun && !v.holding;
  }

  /**
   * ボールを持った野手が、塁を踏んでいない走者に触れたらアウト（フェーズK-31）。
   *
   * ランダン中（carrying）は `updateRundown` が以前から見ていたもので、**止まって持っている
   * 間（possessed）にも同じ判定を効かせる**のがK-31の要点：塁へ投げても刺せない走者
   * （バイクで塁を行き過ぎて止まっている走者）は、最後はこのタッチでしか決まらない。
   *
   * **候補は呼び出し側が渡す。** 止まって持っている間は「塁間を走っている走者」だけ
   * （`liveRunners`）で、**けん制でリードしているだけの走者には触れない**：塁で送球を受けた
   * 野手がボールを持ったまま立っているので、走者がリードを取り直した瞬間に必ず触れてしまい、
   * **けん制球を生き延びても結局アウト**になる（実機で踏んだ）。リード中の走者を仕留めるには
   * 従来どおり詰めに行く（ランダン＝`taggableRunners` を渡す `updateRundown`）必要がある
   * ＝説明書p25の挟殺の形も、A-6のけん制の手触り（生き延びればまたリードを取り直せる）も
   * そのまま保たれる。
   */
  function updateTag(candidates: RunnerVisual[]): boolean {
    if (holderId === null || !hasBallInHand()) return false;
    const tagged = tagTarget(fielderPos[holderId], candidates);
    if (!tagged) return false;
    tagged.out = true;
    tagged.mesh.visible = false;
    defenseOuts += 1;
    onDefenseResult?.('out');
    holdSafeTimer = 0;
    return true;
  }

  /**
   * 送球（連続送球モデル）。指定した塁へ向かう走者1人だけを、送球の到達時間と走者の
   * 残り時間の競争で判定する（原作準拠。同着は走者有利＝throwTime が厳密に短いときのみ
   * アウト）。判定は release 時に確定し、ボールが実際に塁へ飛ぶ様子を見せてから
   * throwing の到着時に発効する（送球時間 = 距離÷THROW_SPEED は判定と同一なので一致）。
   * 到着後は possessed に戻り、別の塁へ続けて送球できる（＝一度投げたら終わりではない）。
   *
   * ランダンプレイ（説明書p25）で走っている最中にも投げられる。持って走るのをやめて
   * 投げるだけなので、起点は「今いる位置」＝ fielderPos[holderId] のままでよい。
   */
  function releaseThrow(targetBase: BaseKey, byCpu: boolean): void {
    if (holderId === null) return;
    // 一度投げたらタッチアップ／盗塁の「まだ投げられない」局面は終わり（以降は通常どおり、
    // 到着した塁から即座に投げ継げる連続送球に戻る＝持ち替えの遅延は掛からない）。
    tagUpActive = false;
    clearThrowHold();
    queuedThrowBase = null;
    tagUpChanceOpen = false;
    carryTarget = null;
    // けん制球（説明書p24）：投げられた塁の走者はこの瞬間から塁へ戻り始める。
    // 走者の持ち時間＝そのときのリード距離になり、以降は通常の送球判定と同じ競争になる。
    if (playKind === 'pickoff') startLeadReturn(targetBase);
    const from = fielderPos[holderId];
    const throwTime = distance(from, BASE_POSITIONS[targetBase]) / THROW_SPEED;
    // 走者ごとの走力（RUN）で時間競争する。俊足の走者は同じ送球でもセーフになりうる。
    // バイクの走者はここが2倍速になり、オーバーラン中は無限大＝必ず刺される（timeToSafety）。
    const beats = (runner: RunnerVisual): boolean => throwTime < timeToSafety(runner);
    const heading = runnerHeadingTo(targetBase);
    const result = resolveBaseResult(targetBase, beats);
    // **タッチプレーの「予約」**（フェーズK-31）。送球が勝っていても塁を踏むだけでは
    // アウトにならないので、`resolveBaseResult` はここで null を返す。その走者を覚えておき、
    // **到着した時点でまだ同じ塁へ向かっていればアウト**にする＝塁で受けた野手がそのまま
    // 走者にタッチする、という実際のプレーの形。
    //
    // 判定式（`beats`）も評価する瞬間もフォースプレーと同じなので、**走り続ける走者の
    // 帰結は1ミリも変わらない**（A-7の盗塁の窓0.45秒もA-6のけん制の境界4.3mもそのまま）。
    // 毎フレームのタッチ（`updateTag`）だけに任せると、走者は塁の 1.4m 手前
    // （BASE_ARRIVE_RADIUS）で「到達」してしまうぶん 0.2秒ほど得をして境界がずれる
    // ——実機で盗塁の窓が 0.45秒→0.25秒 に緩んでいるのを見つけて、この形にした。
    //
    // **変わるのは「引き返したらこの予約が消える」ことだけ**（下の到着処理）。
    //
    // 予約が付く条件は `throwRetiresRunner` そのもの＝**その塁へ向かって走っている**こと。
    // バイクで塁を行き過ぎて止まっている走者には付かない（塁で待っても来ないので触れない）
    // ＝そこだけは守備が走って追うしかない、というK-31の唯一の「追う理由」が残る。
    const pendingTag =
      heading !== undefined && !heading.forcePlay && approachingOwnBase(heading) && beats(heading)
        ? heading
        : null;
    throwState = { pos: { ...from }, target: targetBase, result, pendingTag, byCpu };
    // 振り抜き（フェーズHH-55）。**投げる先を向いてから振る**＝直前に走っていた向き
    // （`movePlayerTo` が進行方向から書く）のまま投げると、腕の振りと球の飛ぶ先が
    // ばらばらになる。向きは `throwState.pos` ではなく塁の座標から取るので、
    // 走りながら投げた（ランダン中の送球）場合も投げた先を向く。
    const targetPos = BASE_POSITIONS[targetBase];
    throwPose = {
      id: holderId,
      sec: THROW_POSE_SEC,
      arm: throwArmFor(holderId),
      yaw: Math.atan2(targetPos.x - from.x, targetPos.z - from.z),
    };
    phase = 'throwing';
    // **ここで一度書く**＝ボールはこのフレームから飛ぶので、次の update まで待つと
    // 1フレームだけ「球は出ているのに投げた本人は捕球の構えのまま」が映る（実機で見えた）。
    // 送球中は update の冒頭が毎フレーム書き直すので、二重には書かれない。
    syncFielderMeshes();
  }

  /**
   * ランダンプレイ（説明書p25）を仕掛ける／行き先を指示し直す。
   * 走っている最中の押し直しも受け付ける＝挟殺で走者が引き返したら向きを変えられる。
   */
  function startRundownTo(targetBase: BaseKey): void {
    if (holderId === null) return;
    carryTarget = targetBase;
    phase = 'carrying';
    // 走り出したらプレーを畳むカウントは仕切り直す（走っている間はプレー続行）
    holdSafeTimer = 0;
  }

  /**
   * その塁へ投げれば、その塁へ向かっている走者を刺せるか（フェーズJ-30）。
   * **`releaseThrow` の時間競争とまったく同じ式**を先に評価するだけで、CPUが送球と
   * ランダンのどちらを選ぶかの判断に使う（判定を二重に持たない＝投げた結果と食い違わない）。
   */
  function throwWouldGet(v: RunnerVisual): boolean {
    if (holderId === null || v.forced === null) return false;
    // フェーズK-31：投げても触れない走者（塁から遠ざかって止まっている＝バイクの
    // オーバーラン）には、時間競争に勝っていても意味が無い。ここを見ないと、CPU守備が
    // 刺せない塁へ永久に投げ続けてプレーが終わらない。
    if (!throwRetiresRunner(v.forcePlay, approachingOwnBase(v))) return false;
    const throwTime = distance(fielderPos[holderId], BASE_POSITIONS[v.forced.to]) / THROW_SPEED;
    return throwTime < timeToSafety(v);
  }

  /**
   * CPU守備が走って追う先の塁（無ければ null＝従来どおり投げるか畳む）。
   *
   * **2段構え**なのは、追う理由が2種類あるから：
   * 1. **走っている走者**＝塁への競争で追いつけるか（`chooseCpuRundown`。J-30から不変。
   *    この守備モデルでは発火しないことが計測で分かっているが、規則としては残してある）。
   * 2. **止まっている走者**＝塁へ先着しても非フォースなら刺せないので、**通り道で
   *    触れる塁**を選ぶ（`tagsOnTheWay`。フェーズN-34）。走者は2つの塁を結ぶ線上に
   *    いるので、反対側の塁へ走れば必ずタッチ半径を通る。
   */
  function cpuChaseTarget(live: RunnerVisual[]): BaseKey | null {
    if (cpuRundownUsed || holderId === null) return null;
    const carrier = fielderPos[holderId];
    const moving = live.filter((v) => !v.holding && !throwWouldGet(v));
    const found = chooseCpuRundown(
      carrier,
      moving.map((v) => ({
        base: v.forced!.to,
        pos: v.pos,
        target: BASE_POSITIONS[v.forced!.to],
        speed: runSpeed(v),
      })),
    );
    if (found) return found.base;
    // 止まっている走者は**もっとも進んだ走者から**見る（送球先の選び方と同じ順序）
    for (let i = live.length - 1; i >= 0; i -= 1) {
      const v = live[i];
      if (!v.holding || v.forced === null) continue;
      // 行き先の塁を先に試す（そこで触れるなら進塁も同時に止められる）→ だめなら起点の塁
      const bases: BaseKey[] = [v.forced.to, v.origin === 'batter' ? 'home' : v.origin];
      for (const base of bases) {
        if (tagsOnTheWay(carrier, v.pos, BASE_POSITIONS[base])) return base;
      }
    }
    return null;
  }

  /** ランダンプレイの終了（タッチアウト・塁への到達）。そのまま送球へ移れる possessed へ戻す */
  function endRundown(): void {
    carryTarget = null;
    phase = 'possessed';
    possessedTimer = 0;
    holdSafeTimer = 0;
  }

  /**
   * ランダンプレイの進行（1フレーム分）。指示された塁へ向かって走り、
   * 途中で塁間の走者に触れればタッチアウト、塁に着けばその塁でのプレーを決着させる。
   */
  function updateRundown(d: number): void {
    if (carryTarget === null || holderId === null) return;
    const p = fielderPos[holderId];
    const target = BASE_POSITIONS[carryTarget];
    const dx = target.x - p.x;
    const dz = target.z - p.z;
    const remaining = Math.hypot(dx, dz);
    const step = FIELDER_SPEED * d;
    const arrived = remaining <= step;
    if (arrived) {
      p.x = target.x;
      p.z = target.z;
    } else {
      p.x += (dx / remaining) * step;
      p.z += (dz / remaining) * step;
    }
    syncFielderMeshes();
    ball.position.set(p.x, BALL_RADIUS, p.z);

    // タッチアウトを塁への到達より先に見る：走者を追い越して塁に入った場合でも、
    // 触れた事実（＝より手前で決着したプレー）を優先するのが実際のプレーに近い。
    if (updateTag(taggableRunners())) {
      endRundown();
      return;
    }
    if (arrived) {
      // 実際にその塁へ立った時点の判定なので、まだ到達していない走者は間に合わなかった
      // （走者側の移動はこのフレームで先に済んでいるため、同着は走者有利のまま）。
      const result = resolveBaseResult(carryTarget, () => true);
      if (result) onDefenseResult?.(result);
      endRundown();
    }
  }

  /**
   * 走者の現在の到達状況から、プレー全体の帰結（塁・得点・アウト数）を確定する。
   * 刺されていない走者は「行き先の塁へ安全に到達した」ものとして扱う（v1簡易：
   * 一度セーフになった走者はその塁で止まる。欲張り進塁は対象外）。帰塁中の走者は
   * 行き先が起点の塁なので、途中でプレーが畳まれても元の塁に収まる。
   */
  function finalizePlay(): void {
    // 塁に残った走者を「誰が」まで含めて確定する（次の打席へ走力を持ち越すため）
    const baseRunners: BaseRunners = { first: null, second: null, third: null };
    let runs = 0;
    let outsAdded = 0;
    for (const v of runnerVisuals) {
      if (v.out) {
        outsAdded += 1;
        continue;
      }
      if (v.forced) {
        // **止まったまま畳まれた走者は、最後に踏んだ塁（起点）に落ち着く**（フェーズN-34）。
        // 「刺されていない走者は行き先の塁へ安全到達」という既定のままにすると、塁間で
        // 止まっていただけの走者が塁を1つもらえてしまう（＝止まるのが得になり、
        // 「1人を差し出す」という手の意味が反転する）。**打者走者だけは例外で従来どおり**
        // ＝常にフォースなので送球で刺せる＝畳む前に必ず決着しており、ここには来ない。
        if (v.holding && v.origin !== 'batter') {
          baseRunners[v.origin] = v.id;
        } else if (v.forced.to === 'home') runs += 1;
        else baseRunners[v.forced.to] = v.id;
      } else if (v.origin !== 'batter') {
        // 進塁を仕掛けなかった走者はその塁に留まる（けん制モードでリード中の走者も、
        // 塁を離れているだけで所属は元の塁なのでここに入る）
        baseRunners[v.origin] = v.id;
      }
    }
    // けん制・盗塁は打席を終わらせない（カウント・打順は据え置き）ので別の kind で返す
    if (playKind !== 'batted') {
      finish({ kind: 'runnerPlay', outsAdded, runs, baseRunners, leads: finalLeads() });
      return;
    }
    finish({ kind: 'result', outsAdded, runs, baseRunners });
  }

  /**
   * 決着時に塁上へ残った走者のリード（フェーズL-32。次の球の盗塁のスタート位置になる）。
   *
   * 塁の割り当ては上の `finalizePlay` とまったく同じ見方をする（走っている走者は
   * `forced.to` に着く／仕掛けていない走者は起点の塁に残る）ので、**「その走者が最後に
   * どの塁で、どれだけ塁を離れていたか」以上のことは持たない**：
   * - **進んだ先の塁では持ち越さない**（新しい塁では改めて既定のリードから始まる）。
   * - **帰塁（行き先＝起点）はリード0**＝塁を踏み直した。早めにKを押して助かった走者が
   *   その打席で失うのはこの値で、これが A-6 以来の「押し得」の代償そのもの。
   * - 塁上でリードしたまま窓が閉じた走者は**その深さのまま**次の球を迎える＝耐えた報酬。
   */
  function finalLeads(): CarriedLeads {
    const leads: CarriedLeads = {};
    for (const v of runnerVisuals) {
      if (v.out || v.origin === 'batter') continue;
      // **一度も塁を離れなかった走者は持ち越さない**（フェーズII-56）。人間の走者が
      // リードを取らなくなったので、ここを素通しにすると**けん制を仕掛けられただけで
      // リード0が持ち越り、その打席は二度と走れない**（既定の `stealLeadFor` 3.5m を
      // 下回る）＝何もしていない側が一方的に損をする。**リードして帰塁した走者は
      // `ledOff` が立っているので従来どおり0を持ち越す**（L-32の「押し得」の代償は不変）。
      if (!v.ledOff) continue;
      const base = v.origin;
      if (v.forced) {
        // 止まったまま畳まれた走者は起点の塁へ落ち着く（上記 `finalizePlay`）ので、
        // リードも**踏み直した扱いの0**（フェーズN-34）。持ち越しを免れるために止まる、
        // という抜け道をここで塞いでいる。
        if (v.holding) {
          leads[base] = { id: v.id, lead: 0 };
          continue;
        }
        if (v.forced.to !== base) continue;
        leads[base] = { id: v.id, lead: 0 };
        continue;
      }
      leads[base] = { id: v.id, lead: v.lead };
    }
    return leads;
  }

  // ---- バイク（フェーズF-26-3。★3メカのスキル `バイク`） ----

  /**
   * その走者がいま出している速さ m/s。**移動にも送球との時間競争にも同じ値を使う**
   * （B-8で走力を入れたときと同じ約束＝見た目と判定が食い違わない）。
   */
  function runSpeed(v: RunnerVisual): number {
    return v.bike ? v.speed * BIKE_SPEED_SCALE : v.speed;
  }

  /**
   * その走者が「塁を踏んで安全になる」までの残り時間 s（送球との時間競争に使う）。
   *
   * オーバーラン中の走者だけが Infinity になる：塁から**遠ざかっている**ので、帰塁の
   * 指示（K）が出るまで安全になりようがない＝その塁へ投げれば必ず刺せる。これが
   * バイクの代償の実体で、判定側に「バイクかどうか」を持ち込まずに時間の形で表せている。
   *
   * **止まっている走者も同じ**（フェーズN-34）。走り出す（または引き返す）まで塁に
   * 着かないので持ち時間は無限＝送球の時間競争には必ず負ける。**ただし非フォースなら
   * 負けても刺されない**（`throwRetiresRunner` が塁を踏むだけの決着を拒む）＝
   * 「送球は届くのに触れない」というランダンの入口が、専用の分岐なしにここから出る。
   */
  function timeToSafety(v: RunnerVisual): number {
    if (v.overrun || v.holding) return Number.POSITIVE_INFINITY;
    // 転んでいる間は走り出せないので、その残り時間がそのまま持ち時間に上乗せされる
    // （フェーズF-26-4。ドロップキックを空振りした代償を、送球判定に専用の分岐を
    // 持ち込まずに「時間」の形だけで効かせる）。
    return v.stumbleSec + distance(v.pos, v.target) / runSpeed(v);
  }

  /** いまバイクに点火できる走者（走っている最中で、まだこのプレーで点火していない） */
  function ignitableRunners(): RunnerVisual[] {
    return runnerVisuals.filter(
      (v) =>
        v.bikeCapable &&
        !v.bike &&
        !v.bikeUsed &&
        !v.overrun &&
        // 転んでいる間は点火できない（ドロップキックを空振りした直後。F-26-4）
        v.stumbleSec === 0 &&
        // 帰塁中は点火できない（曲がれない乗り物なので引き返しには使えない）。
        // これと bikeUsed の2つで、挟殺の往復から確実に締め出している。
        !v.returning &&
        // 止まっている間も点火できない（フェーズN-34）。同じJで再スタートが先に効くので、
        // 押し続ければ「再スタート → 0.3秒後に点火」の順で自然に乗れる。
        !v.holding &&
        v.forced !== null &&
        !v.out &&
        !v.arrived,
    );
  }

  function igniteBike(v: RunnerVisual): void {
    v.bike = true;
    v.bikeUsed = true;
    // 点火した押下は「止まれ」ではない（フェーズN-34。長押し＝点火／短く離す＝停止）
    holdArmed = [];
    setPlayerColor(v.mesh, BIKE_RUNNER_COLOR);
    // 車体の表示とまたがる姿勢は `syncRunnerPoses` が `bike` から毎フレーム導出する
    // （フェーズE-25-(e)。**真実は `v.bike` の側**＝「乗っているのに車体が無い」が起きない）
    // 消費型 `ニトロ`（F-26-8）のチャージを減らすのはロスターを持っている側。
    // **1プレーに1回しか点火できない**（`bikeUsed`）ので、ここが1プレーに複数回
    // 呼ばれることはない＝チャージが一度の走塁で溶けることもない。
    onBikeIgnite?.(v.id);
  }

  /** バイクを降りる（帰塁・呼び戻し）。色と車体が消えることが「もう止まれる」の合図になる */
  function dismountBike(v: RunnerVisual): void {
    v.bike = false;
    setPlayerColor(v.mesh, RUNNER_COLOR);
  }

  /**
   * 点火の判定（毎フレーム）。
   *
   * - **人間の攻撃側**：J（進塁ボタン）を BIKE_ENGAGE_SEC 押し続けると点火する。
   *   走り出しはいつもどおり徒歩なので、短く離せば従来と同じ走塁＝**乗らない選択**が
   *   できる（守備が塁に張り付いている場面ではオーバーランが即アウトになるため、
   *   これは実際に使い分ける価値のある判断になる）。
   * - **CPUの攻撃側**：仕掛けた走者は必ず点火する（決定的・乱数不使用）。桜井ノウハウ
   *   「コンピューターが良い目を出すとイカサマしてると思われがち」への対応で、
   *   F-26-1のCPUの選択規則・F-26-2の銃と同じ扱い＝規則が読めれば理不尽にならない。
   */
  function updateBikeIgnition(d: number): void {
    const riders = ignitableRunners();
    if (riders.length === 0) {
      bikeHoldSec = 0;
      return;
    }
    // CPU走者は必ず点火する（＝攻撃側が人間でないとき。フェーズD-20でこの条件を
    // 「守備が人間」から「攻撃がCPU」へ直した：2P PLAY では両方が人間なので、
    // 守備側を見ていると**人間の走者が勝手に点火する**）。
    if (!isOffenseHuman()) {
      riders.forEach(igniteBike);
      return;
    }
    if (!offensePad.isPressed('b')) {
      bikeHoldSec = 0;
      return;
    }
    bikeHoldSec += d;
    if (bikeHoldSec < BIKE_ENGAGE_SEC) return;
    riders.forEach(igniteBike);
    bikeHoldSec = 0;
  }

  /**
   * 塁を行き過ぎさせる（曲がれない）。**踏んだ塁（forced.to）は変えない**ので、
   * 送球の対象・ランダンのタッチ対象・決着後の落ち着き先はすべて進塁のときのまま。
   */
  function startOverrun(v: RunnerVisual): void {
    v.overrun = true;
    v.overrunSec = 0;
    v.target = bikeOverrunTarget(originOf(v.forced!.from), v.forced!.to);
  }

  /**
   * オーバーランからの帰塁（人間はK、CPUは BIKE_CPU_RETURN_SEC 後に自動）。
   * **バイクは降りる**＝戻りは徒歩なので、行きが速いほど戻りの遅さが際立つ。
   * 戻り先は踏んだ塁なので、到達すれば通常どおり arrived になってセーフが確定する。
   */
  function startOverrunReturn(v: RunnerVisual): void {
    v.overrun = false;
    dismountBike(v);
    v.target = { ...BASE_POSITIONS[v.forced!.to] };
    // 呼び戻した瞬間から守備側の反応・畳みの間を数え直す（startRunnerReturn と同じ）
    possessedTimer = 0;
    holdSafeTimer = 0;
  }

  /** CPU走者は必ず自分で戻る（誰も指示しないとプレーが畳まれないため） */
  function updateCpuOverrunReturn(d: number): void {
    if (isOffenseHuman()) return;
    for (const v of overrunRunners()) {
      v.overrunSec += d;
      if (v.overrunSec >= BIKE_CPU_RETURN_SEC) startOverrunReturn(v);
    }
  }

  // ---- ドロップキック（フェーズF-26-4。★2ボウリョクのスキル `ドロップキック`） ----

  /** 蹴り倒されて動けない野手（一斉移動・塁カバー・捕球のすべてから外れる） */
  function isFielderDown(id: FielderId): boolean {
    return downedFielders.has(id);
  }

  /**
   * 倒れている進行度（0=倒れ始め〜1=起き上がり切る。フェーズE-25-(e)の姿勢に渡す）。
   * **残り時間からの導出**なので、`DROPKICK_DOWN_SEC` を変えると倒れている見た目の
   * 長さも一緒に動く（見た目と行動不能の時計が別々にならない）。
   */
  function downedProgress(id: FielderId): number {
    const remaining = downedFielders.get(id) ?? 0;
    return 1 - Math.min(1, Math.max(0, remaining / DROPKICK_DOWN_SEC));
  }

  /**
   * 起き上がりの計時。0になった野手はその場で立ち上がり、**足元に落ちたボールは
   * 同じフレームの拾い直し判定で回収される**（DROPKICK_LOOSE_BALL_DISTANCE が
   * CATCH_RADIUS の内側にしてあるのはこのため）＝落球でプレーが宙に浮かない。
   *
   * 姿勢を戻す処理は要らない：`syncFielderMeshes` が毎フレーム全関節を書き直すので、
   * 倒れている列から抜けた時点で立ち上がる。
   */
  function updateDownedFielders(d: number): void {
    for (const [id, remaining] of [...downedFielders]) {
      const left = remaining - d;
      if (left > 0) downedFielders.set(id, left);
      else downedFielders.delete(id);
    }
  }

  /** 全員起こす（プレーの開始・終了時。倒れた姿勢が次のプレーへ持ち越されない） */
  function clearDownedFielders(): void {
    downedFielders.clear();
  }

  /**
   * 捕球の候補になる野手の位置（蹴り倒されている野手を除く）。
   * **打球の捕球にも落球の拾い直しにも同じものを通す**ので、「倒れているのに捕った」が
   * どちらの経路でも起きない。
   */
  function catchablePositions(): Record<FielderId, Vec2> {
    if (downedFielders.size === 0) return fielderPos;
    return Object.fromEntries(
      (Object.keys(fielderPos) as FielderId[])
        .filter((id) => !isFielderDown(id))
        .map((id) => [id, fielderPos[id]]),
    ) as Record<FielderId, Vec2>;
  }

  /**
   * 走者の姿勢と車体の上書き（フェーズE-25-(e)）。**位置を書いた後に呼ぶ**のが要点：
   * `movePlayerTo` は動いていれば走り・止まっていれば直立を書くので、「走り以外」
   * （乗っている・蹴っている・転んでいる）はここで後から上書きする＝野手の捕球の姿勢と
   * 同じ後勝ちの形（E-25-(c)）。
   *
   * どれも**状態からの導出だけ**で、この関数が状態を書き換えることは無い＝アニメを消しても
   * ゲームは1ミリも変わらない（見た目が判定に効かないという⑨の一方通行）。
   */
  function syncRunnerPoses(): void {
    for (const v of runnerVisuals) {
      if (!v.mesh.visible) continue;
      // 蹴っている間は車体を隠す（乗ったまま蹴った走者が、車体だけ立ったまま倒れないため）
      showBike(v.mesh, v.bike && v.kickSec === 0 && v.stumbleSec === 0);
      if (v.kickSec > 0) {
        setPlayerPose(v.mesh, { kind: 'dropkick', t: 1 - v.kickSec / DROPKICK_KICK_SEC });
      } else if (v.stumbleSec > 0) {
        // 蹴りを外して転んでいる＝**うつ伏せ**（蹴った勢いのまま前へ倒れる）
        setPlayerPose(v.mesh, {
          kind: 'fallen',
          t: 1 - v.stumbleSec / DROPKICK_STUMBLE_SEC,
          forward: true,
        });
      } else if (v.bike) {
        setPlayerPose(v.mesh, { kind: 'bike' });
      }
    }
  }

  /**
   * いまドロップキックを出せる走者（走っている／けん制で塁を離れている＋まだこのプレーで
   * 使っていない＋転んでいない）。塁を踏んで止まっている走者は蹴らない（蹴る理由が無い）。
   *
   * 「塁を離れている」を**けん制モードに限る**のは、盗塁のスタート位置としてのリード
   * （フェーズL-32で走らない走者にも与えた）が、ボールが打者へ向かっている間の抽象で
   * あって危険にさらされている状態ではないため。ここを開くと、蹴りたい走者（走っている
   * 走者）ではなく塁に立っているだけの走者が蹴り手に選ばれて空振りしうる
   * （＝L-32より前の挙動と食い違う）。`taggableRunners` が同じ絞り込みをしているのと対。
   */
  function dropkickableRunners(): RunnerVisual[] {
    return runnerVisuals.filter(
      (v) =>
        v.dropkickCapable &&
        !v.dropkickUsed &&
        v.stumbleSec === 0 &&
        !v.out &&
        !v.arrived &&
        (v.forced !== null || (playKind === 'pickoff' && v.lead > 0)),
    );
  }

  /**
   * 誰が誰を蹴るか。**野手にもっとも近い走者が蹴る**（＝Gを押した意図に一致する1人）。
   * その走者の最寄りの野手が射程内なら当たり、射程外なら空振り（target === null）。
   * 走者が複数いても蹴るのは常に1人＝「全員が転ぶ」ような驚きが起きない。
   */
  function chooseDropkick(): { runner: RunnerVisual; target: FielderId | null } | null {
    const candidates = dropkickableRunners();
    if (candidates.length === 0) return null;
    let best: { runner: RunnerVisual; target: FielderId; dist: number } | null = null;
    for (const v of candidates) {
      const id = dropkickTarget(v.pos, fielderPos, Number.POSITIVE_INFINITY);
      if (id === null) continue;
      const dist = distance(v.pos, fielderPos[id]);
      if (best === null || dist < best.dist) best = { runner: v, target: id, dist };
    }
    if (best === null) return { runner: candidates[0], target: null };
    // 射程はその走者のスキルで決まる（デュオ `ロケットキック` で伸びる。F-26-5）
    const inRange = best.dist <= dropkickRangeFor(best.runner.id);
    return { runner: best.runner, target: inRange ? best.target : null };
  }

  /**
   * ドロップキックを出す（人間の攻撃側のG／CPU走者の自動発動の共通処理）。
   * **当たっても外れても `dropkickUsed` を立てる**＝1プレーに1回で打ち止め。
   */
  function performDropkick(): void {
    const choice = chooseDropkick();
    if (choice === null) return;
    choice.runner.dropkickUsed = true;
    // 蹴る動作は当たり外れによらず同じ（フェーズE-25-(e)）＝**画面から結果を先読みできない**
    choice.runner.kickSec = DROPKICK_KICK_SEC;
    if (choice.target === null) {
      // 空振り＝その場で転んで止まる。送球との時間競争にはこの秒数がそのまま乗る
      // （timeToSafety）ので、外した走者は素直に刺されやすくなる。
      choice.runner.stumbleSec = DROPKICK_STUMBLE_SEC;
      // **空振りでもチャージは減る**（F-26-8）＝1プレーに1回という既存の規則と同じ扱い。
      // ここが「当たったときだけ」だと、当たるまで撃ち直せる札になってしまう。
      onDropkick?.(false, choice.runner.id);
      return;
    }
    downFielder(choice.target, choice.runner.pos);
    onDropkick?.(true, choice.runner.id);
  }

  /**
   * 野手を蹴り倒す。ボールを持っていれば叩き落とす（ユーザー判断：行動不能＋落球）。
   * 跳んでいる最中なら跳躍は中断する（姿勢の主が2つになるのを防ぐ）。
   */
  function downFielder(id: FielderId, fromRunner: Vec2): void {
    if (finePlay !== null && finePlay.id === id) clearFinePlay();
    downedFielders.set(id, DROPKICK_DOWN_SEC);
    // 蹴ってきた走者のほうを向かせる（フェーズE-25-(e)）。倒れる姿勢は仰向けなので、
    // これで**蹴られた方向とは逆へ倒れる**＝画面から因果が読める。倒れている間は
    // 動かない＝`movePlayerTo` が向きを書き換えないので、この向きは起き上がるまで残る。
    const entity = fielderById.get(id);
    const p = fielderPos[id];
    if (entity) setPlayerFacing(entity.group, Math.atan2(fromRunner.x - p.x, fromRunner.z - p.z));
    // 手にボールがあるときだけ落ちる。盗塁で投球がまだ届いていない捕手は「持っていない」
    // ので落としようがない（hasBallInHand と同じ見方をここでも通す）。
    if (holderId === id && hasBallInHand()) dropLooseBall(id, fromRunner);
  }

  /**
   * ボールを叩き落とす。**持ち主のいない possessed** として 'loose' へ移り、以後は
   * 打球の飛行中と同じ「野手を動かして拾いにいく」局面になる。
   * 送球の予約・持ち替えの待ちは、ボールが手を離れた時点で意味を失うので捨てる。
   */
  function dropLooseBall(fielder: FielderId, fromRunner: Vec2): void {
    looseBallPos = dropkickLooseBallPos(fromRunner, fielderPos[fielder]);
    clampToField(looseBallPos);
    holderId = null;
    carryTarget = null;
    queuedThrowBase = null;
    clearThrowHold();
    phase = 'loose';
    possessedTimer = 0;
    holdSafeTimer = 0;
    ball.position.set(looseBallPos.x, BALL_RADIUS, looseBallPos.z);
    shadow.visible = false;
  }

  /**
   * 一時効果（フェーズM-33。`ケモノガエリ`）を切れる野手のうち、**ボールにもっとも近い1人**。
   *
   * 候補は `catchEffectGain` が正を返す野手だけ＝ロスターを知らないこのシーンは
   * 「誰が切れるか」を判断しない（`canDropkickOf` と同じ分担）。倒れている野手
   * （F-26-4で蹴られた側）は捕球そのものができないので外す。
   *
   * ボールが飛んでいる／転がっている間だけ意味を持つ札なので、確保中・決着後は null。
   */
  function catchEffectCandidate(): FielderId | null {
    if (phase !== 'flying' || ballState === null) return null;
    const at = { x: ballState.x, z: ballState.z };
    let best: FielderId | null = null;
    let bestDist = Infinity;
    for (const id of Object.keys(fielderPos) as FielderId[]) {
      if (isFielderDown(id) || catchEffectGain(id) <= 0) continue;
      const d = distance(fielderPos[id], at);
      if (d >= bestDist) continue;
      bestDist = d;
      best = id;
    }
    return best;
  }

  /** 地面のボールを拾い直す（倒れている野手は候補外）。拾えたら送球できる possessed へ戻る */
  function attemptLooseBallPickup(): void {
    const catcher = nearestCatchableFielder(
      catchablePositions(),
      looseBallPos,
      0,
      undefined,
      catchBonusOf,
    );
    if (catcher === null) return;
    phase = 'possessed';
    holderId = catcher;
    possessedTimer = 0;
    holdSafeTimer = 0;
    const p = fielderPos[catcher];
    ball.position.set(p.x, BALL_RADIUS, p.z);
  }

  /**
   * 守備側に警告を出す場面か＝ボールを持った野手が、蹴れる走者に DROPKICK_WARN_RANGE まで
   * 寄られている。**射程の倍**で出すので、詰めるのをやめて塁へ投げる時間がまだある
   * （回避手段が存在することが、蹴られること自体を理不尽にしない条件）。
   */
  function kickDangerActive(): boolean {
    if (holderId === null) return false;
    const from = fielderPos[holderId];
    // 警告距離はその走者の射程からの導出（`dropkickWarnRange`）＝射程が伸びれば
    // 警告も同じだけ早く出る。「回避手段が間に合う」ことが理不尽にしない条件（F-26-4）。
    return dropkickableRunners().some(
      (v) => distance(v.pos, from) <= dropkickWarnRange(dropkickRangeFor(v.id)),
    );
  }

  /**
   * CPU走者のドロップキック（決定的・乱数不使用）。規則は1つだけ：
   * **ボールを持った野手が射程内に入ったら蹴る**。
   *
   * 人間が守備側のときにしか動かない＝これは「人間がランダンで詰めてきた」場面そのもので、
   * 蹴られたくなければ詰めずに塁へ投げればよい（`kickDangerActive` の警告つき）。
   * 桜井ノウハウ「人ができる範囲のこともずるいと思われるのはCPの常」＝人間も同じ操作で
   * 同じことができ、規則が読めるので理不尽にならない（F-26-2の銃・F-26-3のバイクと同じ扱い）。
   */
  function updateCpuDropkick(): void {
    if (isOffenseHuman()) return;
    // ボールが手にある局面だけ（送球中に蹴っても落とすものが無く、1回の権利を無駄にする）
    if (phase !== 'possessed' && phase !== 'carrying') return;
    if (holderId === null || !hasBallInHand()) return;
    const from = fielderPos[holderId];
    const kicker = dropkickableRunners().find(
      (v) => distance(v.pos, from) <= dropkickRangeFor(v.id),
    );
    if (kicker === undefined) return;
    kicker.dropkickUsed = true;
    kicker.kickSec = DROPKICK_KICK_SEC;
    downFielder(holderId, kicker.pos);
    onDropkick?.(true, kicker.id);
  }

  /**
   * CPU走者の引き返し（挟殺の「逃げる側」。フェーズJ-30。決定的・乱数不使用）。
   *
   * これが無いとCPU走者は**追われても真っすぐ走り続ける**ので、人間が守備側でランダンを
   * 仕掛けても「追いつくか、追いつかないか」だけの単純な追いかけっこにしかならなかった
   * （ORIGINAL_PARITY.md「CPU走者は追われても引き返さない」）。挟殺（説明書p25）は
   * **逃げる側が向きを変えて初めて成立する**プレーなので、ここが1P PLAY で挟殺そのものが
   * 起きなかった原因だった。
   *
   * 規則は `shouldCpuRetreat`（`core/fielding.ts`）1本＝**進めば刺されるが戻れば助かる**とき
   * だけ引き返す。人間の走者がKで帰塁を選ぶ判断とまったく同じ経路（`startRunnerReturn`）を
   * 通るので、戻る途中の走者はその塁へ投げれば刺せる（＝CPUだけ安全に逃げたりしない）。
   */
  function updateCpuRetreat(): void {
    if (isOffenseHuman()) return;
    if (phase !== 'possessed' && phase !== 'carrying') return;
    if (holderId === null || !hasBallInHand()) return;
    // **いま投げられる守備に対してだけ引き返しを判断する。** 持ち替えの最中（フライ捕球後の
    // 1.5秒・盗塁の投球到達待ち1.6秒）は、走者は自分の走塁を続ける＝実際の野球でも
    // 「捕手がボールを持った」だけで盗塁をやめる走者はいない。
    //
    // これが無いと**CPUの盗塁が一度も成功しなくなる**（実装中に実機の一歩手前で気づいた）：
    // 投球が捕手に届いた瞬間の走者は「二塁へ行けば刺されるが一塁へ戻れば助かる」状態なので、
    // 規則としては正しく毎回引き返してしまい、A-7が設計した「人間の捕手が投げれば刺せる／
    // 見送れば盗塁が決まる」という**守備側の判断そのものが消える**。
    if (!canThrowNow()) return;
    const carrier = fielderPos[holderId];
    for (const from of recallableBases()) {
      const v = findVisual(from);
      // 引き返せるのは「自分の意思で仕掛けた走者」だけ（フォースされた走者に戻る塁は無い）。
      // バイクでオーバーラン中の走者は既存の自動帰塁（updateCpuOverrunReturn）の担当。
      if (!v || v.forced === null || v.retreatUsed || v.returning || v.overrun) continue;
      if (v.out || v.arrived || v.stumbleSec > 0) continue;
      const decided = shouldCpuRetreat({
        carrier,
        runner: v.pos,
        ahead: BASE_POSITIONS[v.forced.to],
        behind: BASE_POSITIONS[from],
        speed: runSpeed(v),
        // **持ち替えの残り時間を必ず渡す**（フライ捕球後の1.5秒・盗塁の投球到達待ち）。
        // 渡さないと、`chooseCpuTagUp` が「送球が間に合わないから走れ」と判断した犠牲フライを
        // この関数が「進めば刺される」と読んで即座に取り消す（`shouldCpuRetreat` のコメント）。
        throwDelaySec: Math.max(0, throwHoldSec - throwHoldTimer),
      });
      if (!decided) continue;
      // `retreatUsed` は `startRunnerReturn` が立てる（人間の帰塁と同じ1本の経路）
      startRunnerReturn(from);
    }
  }

  /**
   * CPU走者がその場に止まる／止まるのをやめる（フェーズN-34。決定的・乱数不使用）。
   *
   * **`updateCpuRetreat` の後に見る**のが要点で、規則の順序がそのまま優先順位になる：
   * 戻れば助かるなら戻る（K-31）→ どちらへ行っても刺されるなら止まる（N-34）。
   * 2つの規則が同じ場面で反対の結論を出さないよう、判定は同じ `caughtHeadingTo`
   * （`core/fielding.ts`）から出している。
   */
  function updateCpuHold(): void {
    if (isOffenseHuman()) return;
    if (phase !== 'possessed' && phase !== 'carrying') return;
    if (holderId === null || !hasBallInHand()) return;
    // 引き返しと同じ条件：いま投げられる守備に対してだけ判断する（持ち替えの最中に
    // 止まると、犠牲フライ・盗塁が「捕手がボールを持った瞬間に諦める」ことになる）。
    if (!canThrowNow()) return;
    const carrier = fielderPos[holderId];
    for (const v of liveRunners()) {
      if (v.overrun || v.stumbleSec > 0 || v.origin === 'batter') continue;
      if (v.forced === null || v.forcePlay) continue; // フォース走者は止まっても塁へ投げられて終わり
      const behind = BASE_POSITIONS[v.origin as 'first' | 'second' | 'third'];
      const chase = {
        carrier,
        runner: v.pos,
        ahead: BASE_POSITIONS[v.forced.to],
        behind,
        speed: runSpeed(v),
        throwDelaySec: Math.max(0, throwHoldSec - throwHoldTimer),
      };
      // **止まって時間を稼ぐ相手がいるか**（他に決着していない走者がいるか）。
      // 単独走者では止まっても本人は助からない（計測：逃げ切れる場面は0.0%）ので、
      // 意味もなく立ち止まったように見えるだけになる。
      const helpsOtherRunners = liveRunners().some((o) => o !== v && !o.holding);
      if (v.holding) {
        const release = chooseCpuHoldRelease({
          ...chase,
          canRetreat: !v.retreatUsed,
          helpsOtherRunners,
        });
        if (release === 'ahead') startRunnerResume(v);
        else if (release === 'behind') {
          startRunnerResume(v);
          startRunnerReturn(v.origin as 'first' | 'second' | 'third');
        }
        continue;
      }
      if (v.holdUsed || v.returning) continue;
      if (shouldCpuHold({ ...chase, helpsOtherRunners })) startRunnerHold(v);
    }
  }

  /**
   * けん制のにらみ合いからCPU走者が走り出す（フェーズJ-30。決定的・乱数不使用）。
   *
   * 規則は `shouldCpuBreakForNextBase` 1本＝**その塁への送球が間に合わないなら走る**。
   * 投手がマウンドでボールを持っている間はどの塁へも送球が先に着くので走らない（従来どおり
   * にらみ合いのまま）が、**人間の投手がランダンで走者へ寄ると送球の起点が塁から遠ざかる**
   * ので、そこで初めて走る目が出る＝「詰めるか、塁に残るか」に意味が生まれる
   * （ORIGINAL_PARITY.md「CPU走者はけん制モード中に走り出さない」への対応）。
   */
  function updateCpuBreak(): void {
    if (isOffenseHuman()) return;
    if (playKind !== 'pickoff') return;
    if (phase !== 'possessed' && phase !== 'carrying') return;
    if (holderId === null || !hasBallInHand()) return;
    const carrier = fielderPos[holderId];
    for (const v of leadingRunners()) {
      if (v.lead <= 0 || v.stumbleSec > 0) continue;
      const from = v.origin as 'first' | 'second' | 'third';
      const decided = shouldCpuBreakForNextBase({
        carrier,
        runner: v.pos,
        next: BASE_POSITIONS[advancedBase(from)],
        speed: runSpeed(v),
      });
      if (decided) startRunnerAdvance(from);
    }
  }

  /**
   * 指定した塁の走者に「次の塁への進塁」を仕掛けさせる（B=進塁とタッチアップの共通処理）。
   *
   * **自分の意思で走る走者なので、これはタッチプレー**（フェーズK-31）＝行き先の塁へ
   * 投げられただけではアウトにならず、塁で待つ野手にタッチされて初めてアウトになる。
   * そのまま走り続ければ塁に着く前に必ずタッチ半径を通るので**帰結は従来と同じ**で、
   * 違うのは「投げられてから引き返せば、その送球が無駄になる」ことだけ。
   */
  function startRunnerAdvance(from: 'first' | 'second' | 'third'): void {
    const runner: ForcedRunner = { from, to: advancedBase(from) };
    sentRunners.set(from, runner);
    const visual = findVisual(from);
    if (visual) {
      visual.forced = runner;
      // 区間を組み立ててから**いまのフォース一覧に載っているか**を引く（フェーズK-31）。
      // 自分で仕掛けた進塁・タッチアップ・盗塁はどれも載っていない＝タッチプレーになるが、
      // 「フォースかどうか」の判断をここで決め打ちせず一覧に問い合わせておくことで、
      // フォースの決まり方（`forcedRunners`）を変えてもこの経路が置き去りにならない。
      visual.forcePlay = isForcePlay(runner, forced);
      visual.returning = false;
      visual.arrived = false;
      visual.target = BASE_POSITIONS[runner.to];
    }
    if (tagUpActive) {
      // 仕掛けられた瞬間からCPU守備の反応時間を数え直す（押した瞬間に即送球されず、
      // 必ず反応の間が入る）。人間守備側の畳みタイマーもここで巻き戻す。
      possessedTimer = 0;
      holdSafeTimer = 0;
      tagUpChanceOpen = false;
    }
  }

  /**
   * CPU攻撃側の「もう1つ先の塁を狙う」（フェーズX-45。`chooseCpuExtraBases`）。
   *
   * **打球が出た瞬間に一度だけ判断する。** 守備がボールを確保してから決めたのでは、
   * 走者はそこから塁間（3.3〜4.0秒）を走ることになってどんな送球にも勝てない＝
   * 実際の野球と同じく「打った瞬間に走るかどうかを決める」形にするしかない。
   *
   * そのため守備の時間は**着地点の予測から見積もる**（`chooseCpuTagUp` が捕球点という
   * 確定した1点を使えるのとはここが違う）。使う情報は**CPU守備が追いかける先とまったく
   * 同じ**（`landingPoint` と一斉移動でいちばん近い野手）なので、攻撃側だけが知っている
   * 情報は無い。転がって伸びるぶんを見込まないので**必ず短めに出る＝走者に厳しい側**の
   * 見積もりで、`npm run balance:offense` の10段目が「見込みのほうが慎重だった割合
   * 75.8%・中央値 +0.94秒」と確かめている（11段目：仕掛けた打球のうち実際に刺されたのは
   * 基準速で 0.0%）。
   *
   * 対象は**フォースされていない走者だけ**＝人間の `sendRunner` とまったく同じ候補
   * （`sendableRunnerBases`）。フォース走者は放っておいても走るので仕掛ける対象ではない。
   */
  function startCpuExtraBases(landing: LandingPrediction, chaser: FielderId): void {
    const candidates = sendableRunnerBases(originalBases, forced, []);
    if (candidates.length === 0) return;
    const chosen = chooseCpuExtraBases(candidates, {
      securePoint: landing.point,
      // ボールが着地する時刻と、いちばん近い野手がそこへ着く時刻の遅いほう
      secureSec: Math.max(
        landing.sec,
        distance(FIELDER_HOME_POSITIONS[chaser], landing.point) / FIELDER_SPEED,
      ),
      // 走力はその走者の見た目が持っている値そのもの（`chooseCpuTagUp` と同じ＝
      // 「行けると判断した前提」と「実際に走る速さ」が食い違わない）
      speedOf: (from) => findVisual(from)?.speed ?? RUNNER_SPEED,
    });
    for (const from of chosen) startRunnerAdvance(from);
  }

  // ---- 塁間で止まる（フェーズN-34。説明書p25の挟殺の「逃げる側」） ----

  /**
   * 止まる／再スタートの対象になりうる走者（塁間を走っている、または止まっている走者）。
   *
   * バイクで塁を行き過ぎた走者を外すのは、**すでに止まっていて、行き先の塁も踏み終えて
   * いる**から（あちらの逃げ道は既存の帰塁＝K。F-26-3）。転んでいる走者も自分の意思で
   * 止まっているのではないので外す。
   */
  function stoppableRunners(): RunnerVisual[] {
    return liveRunners().filter((v) => !v.overrun && v.stumbleSec === 0);
  }

  /** いま塁間を走っている走者の走行区間（Jが何を意味するかを決める `chooseRunnerCommand` へ渡す） */
  function runningLegs(): RunningLeg[] {
    return stoppableRunners().map((v) => ({
      from: v.origin,
      to: v.forced!.to,
      holding: v.holding,
      canHold: !v.holdUsed,
    }));
  }

  /** 止まっている走者（ヒントで使う） */
  function holdingRunners(): RunnerVisual[] {
    return runnerVisuals.filter((v) => v.holding && !v.out && !v.arrived);
  }

  /**
   * 「止まれる」ヒントを出すか。**守備がボールを持っている（または送球中）局面で、
   * 止まる意味のある走者がいるとき**だけ出す。
   *
   * 意味があるのは**非フォースの走者**だけ（フォース走者は止まっても塁へ投げられて
   * 終わり）。ここを絞らないと、内野ゴロのたびに打者走者に「止まれる」と案内することに
   * なり、**押すと損をする操作を勧める**ヒントになる（操作としては受け付ける＝
   * ユーザー判断の「全員一律」はそのまま）。
   */
  function holdHintActive(): boolean {
    if (phase !== 'possessed' && phase !== 'carrying' && phase !== 'throwing') return false;
    return stoppableRunners().some((v) => !v.holding && !v.holdUsed && !v.forcePlay);
  }

  /**
   * その場に止まる。**行き先（`forced`）は変えない**ので、送球の対象も決着後の落ち着き先も
   * 走っているときのままで、止まる専用の分岐を判定側に持たずに済む（バイクのオーバーランを
   * 「踏んだ塁は `forced.to` のまま」で表したのと同じ整理）。
   */
  function startRunnerHold(v: RunnerVisual): void {
    if (v.holding || v.holdUsed) return;
    v.holding = true;
    v.holdUsed = true;
    // 止まった瞬間から守備側の反応・畳みの間を数え直す（進塁・帰塁を仕掛けたときと同じ）
    possessedTimer = 0;
    holdSafeTimer = 0;
  }

  /** 止まっていた走者が同じ塁へ走り出す（`forced` を触っていないので向きも行き先もそのまま） */
  function startRunnerResume(v: RunnerVisual): void {
    if (!v.holding) return;
    v.holding = false;
    possessedTimer = 0;
    holdSafeTimer = 0;
  }

  /** 起点の塁から走者を引く（`chooseRunnerCommand` の返り値を実際の走者に解決する） */
  function runnerByOrigin(from: ForcedRunner['from']): RunnerVisual | undefined {
    return runnerVisuals.find((v) => v.origin === from && !v.out && !v.arrived);
  }

  /**
   * 「止まれ」の予約を、Jを離した瞬間に実行する（上記 `holdArmed` の理由）。
   * バイクに点火した押下では予約を捨てる＝**長押しは点火、短く離せば停止**。
   */
  function updateHoldRelease(): void {
    if (holdArmed.length === 0) return;
    if (offensePad.isPressed('b')) return;
    const targets = holdArmed;
    holdArmed = [];
    for (const from of targets) {
      const v = runnerByOrigin(from);
      // 離すまでの間に状況が変わっている（塁に着いた・刺された・止まれなくなった）なら何もしない
      if (v && v.forced !== null && !v.holding && !v.holdUsed) startRunnerHold(v);
    }
  }

  /**
   * 帰塁（説明書p19「+で帰る塁を指定しA」）。仕掛けた走者を元の塁へ走って戻す。
   *
   * 「その場で仕掛けを取り消す」のではなく、行き先を起点の塁にした走行区間
   * （forced = {from, to: from}）へ差し替えるのがポイント。走者は実際に戻る距離を
   * 走るので、守備がその塁へ投げれば送球の時間競争で刺せる（＝タッチアップの
   * ギャンブルを引き返す判断にもリスクが伴う）。判定・決着の処理は進塁と共通で、
   * 帰塁専用の分岐を持たない。
   *
   * sentRunners から外すことで、この走者はもう一度 B で送り直せる（気が変わったら
   * 仕掛け直せる）。到達済み（arrived）の走者は呼び出し側の候補算出で除外済み。
   */
  function startRunnerReturn(from: 'first' | 'second' | 'third'): void {
    sentRunners.delete(from);
    const visual = findVisual(from);
    if (!visual) return;
    visual.forced = { from, to: from };
    // 帰塁もタッチプレー（フェーズK-31）。戻っている最中は塁へ向かって走っているので、
    // その塁へ投げれば従来どおり刺せる＝**H-28のライナーゲッツーもけん制の判定も変わらない**。
    visual.forcePlay = false;
    // **1プレーに1回だけ**（フェーズK-31）。これが無いと、送球のたびに向きを変えて
    // どの送球も無駄にでき、挟殺が永久に終わらない（`retreatUsed` のコメント参照）。
    visual.retreatUsed = true;
    visual.returning = true;
    visual.arrived = false;
    // 止まっていた走者もKで引き返せる（フェーズN-34）＝逃げ方は既存の帰塁だけ、という
    // K-31の約束のまま。ここを戻さないと「戻る指示を出したのに止まったまま」になる。
    visual.holding = false;
    visual.target = BASE_POSITIONS[from];
    // 走行中にバイクごと呼び戻された走者はここで降りる（引き返しには使えない乗り物）。
    // bikeUsed は残るので、このプレーでかけ直すこともできない＝挟殺で逃げ回れない。
    visual.overrun = false;
    dismountBike(visual);
    // 呼び戻した瞬間から守備側の反応・畳みの間を数え直す（進塁を仕掛けたときと同じ）
    possessedTimer = 0;
    holdSafeTimer = 0;
  }

  /**
   * フライ捕球時、打球を追って進んでいた走者を元の塁へ戻す（帰塁）。
   *
   * **戻り方は2通り**（フェーズH-28で分かれた）：
   * - 打球を見てから走り出した走者は従来どおり**その場で塁へスナップ**する
   *   （原作どおり進んだ分は無かったことになる＝タッチアップの競争は必ず塁から始まる）。
   * - 投球の前にスタートを切っていた走者（ヒットエンドラン）は**走って戻る**。
   *   既存の帰塁（`startRunnerReturn`）へ合流させるだけなので、その塁へ送球されれば
   *   送球の時間競争でそのまま刺せる＝**ライナーゲッツーが成立する**。
   */
  function returnRunnersToBases(): void {
    for (const v of runnerVisuals) {
      if (v.origin === 'batter') continue;
      // 飛び出していた走者だけは走って戻る（戻る距離＝走らせて打った賭けの分）
      if (v.brokeEarly && !v.out) {
        startRunnerReturn(v.origin as 'first' | 'second' | 'third');
        continue;
      }
      const base = BASE_POSITIONS[v.origin];
      v.forced = null;
      v.forcePlay = false;
      // 塁へ戻された＝走塁がやり直しになるので、引き返しの権利も戻す（フェーズK-31。
      // バイクの点火 `bikeUsed` を戻すのとまったく同じ理由）。
      v.retreatUsed = false;
      v.returning = false;
      v.arrived = false;
      // 塁へ戻された＝走塁がやり直しなので、止まる権利も戻す（フェーズN-34。
      // `retreatUsed` / `bikeUsed` とまったく同じ理由）。
      v.holding = false;
      v.holdUsed = false;
      // 捕球の瞬間に走塁は無かったことになるので、バイクも降りた状態へ戻す
      // （タッチアップで仕掛け直せば、そのときにもう一度点火できる）。
      v.bikeUsed = false;
      v.overrun = false;
      dismountBike(v);
      v.pos = { ...base };
      v.target = { ...base };
      placeRunner(v, true);
    }
  }

  /**
   * タッチアップ（説明書p19「外野フライを捕られた瞬間にランナーを一気に進塁させる」）の
   * 局面を開く。開いたら true（＝呼び出し側はここでプレーを畳まない）。
   *
   * 捕球の瞬間に走者は全員いったん元の塁へ戻す（＝タッチアップの競争は必ず塁から始まる）。
   * 打球を追って次の塁まで走り切っていた走者も同じで、進んだ分は無かったことになる。
   * v1では戻る動作のアニメーションは持たず、その場で塁へスナップさせる（走者がどこから
   * 走り出すのかを曖昧にしないため。原作も捕球の瞬間が起点）。
   *
   * 次の場合は局面を開かず、従来どおり即座にフライアウトで畳む：
   * - このフライが3アウト目：イニングがその場で終わるので走者は還れない。
   * - 走者なし：仕掛ける相手がいない。
   * - CPUが攻撃側で、CPUが仕掛けないと判断した：判断は決定的に即断できるので、
   *   仕掛けないなら猶予時間を取らない（フライアウトのテンポを落とさない）。
   *   ただし**飛び出していた走者（フェーズH-28）が戻っている最中なら開く**：
   *   その塁へ投げれば刺せる（ライナーゲッツー）ので、送球する局面そのものが要る。
   */
  function openTagUp(catcher: FielderId): boolean {
    if (outsBefore + 1 >= OUTS_PER_HALF) return false;
    if (!originalBases.first && !originalBases.second && !originalBases.third) return false;
    // 飛び出していた走者（フェーズH-28）は塁へ戻る義務があるので、タッチアップを
    // 仕掛ける候補からは外す（＝リタッチ。戻り切る前に仕掛け直せると「捕られたのに
    // 次の塁が近い」という得だけが残り、ライナーで置いたリスクが帳消しになる）。
    const retouching = brokeEarlyBases();
    // CPUの判断は「捕った野手の位置」＝送球の起点の深さで行う（ボールの位置ではない。
    // 捕球はボールが野手の捕球半径に入った瞬間に成立するので、ボールの座標は野手より
    // 数メートル手前になり、実際に投げる距離とズレる）。
    // 走力はその走者の見た目が持っている値そのもの（移動にも送球との時間競争にも
    // 使っている `v.speed`）を渡す＝「還れると判断した前提」と「実際に走る速さ」が
    // 構造的に食い違わない（フェーズS-40。R-39が盗塁で走力を渡したのと同じ形）。
    let cpuTagUps = isOffenseHuman()
      ? []
      : chooseCpuTagUp(
          originalBases,
          fielderPos[catcher],
          (from) => findVisual(from)?.speed ?? RUNNER_SPEED,
        );
    // 戻り切っていない走者（フェーズH-28のリタッチ）は仕掛けられない。三塁走者が
    // 動けないなら二塁走者も動けない（三塁が埋まったままなので追い越しになる）＝
    // `chooseCpuTagUp` の連鎖をここでも保つ。
    if (cpuTagUps.includes('third') && retouching.includes('third')) cpuTagUps = [];
    else cpuTagUps = cpuTagUps.filter((from) => !retouching.includes(from));
    if (!isOffenseHuman() && cpuTagUps.length === 0 && retouching.length === 0) return false;

    const batterVisual = findVisual('batter');
    if (batterVisual) {
      // 打者はフライアウト（finalizePlay がこの out を1アウトとして数える）
      batterVisual.out = true;
      batterVisual.mesh.visible = false;
    }
    returnRunnersToBases();
    forced = [];
    sentRunners.clear();

    phase = 'possessed';
    holderId = catcher;
    possessedTimer = 0;
    holdSafeTimer = 0;
    tagUpActive = true;
    // 捕球姿勢からの持ち替え（この待ちが無いとタッチアップは物理的に成立しない）
    throwHoldSec = FLY_CATCH_RELEASE_SEC;
    throwHoldTimer = 0;
    ballArriveSec = 0;
    queuedThrowBase = null;
    const p = fielderPos[catcher];
    ball.position.set(p.x, BALL_RADIUS, p.z);
    shadow.visible = false;

    // 本塁に近い順に仕掛ける（`chooseCpuTagUp` が既にその順で返す）
    if (cpuTagUps.length > 0) for (const from of cpuTagUps) startRunnerAdvance(from);
    // 仕掛けられる走者が1人もいない（全員が戻っている最中）ときは猶予の案内を出さない
    // ＝押しても何も起きない操作は案内しない。飛び出しがなければ従来どおり常に開く。
    else {
      tagUpChanceOpen =
        isOffenseHuman() && sendableRunnerBases(originalBases, [], retouching).length > 0;
    }
    return true;
  }

  /**
   * 毎フレームの自動捕球（原作準拠：ボタン入力不要。塁カバーの4人も含めた
   * 全野手が捕球候補＝どの野手でもボールに触れれば捕る。説明書p20）。
   */
  function attemptCatch(): void {
    if (phase !== 'flying' || !ballState) return;
    // 打球発生直後は捕球無効（捕手の「即捕り」防止。CATCH_MIN_PLAY_SEC参照）
    if (elapsed < CATCH_MIN_PLAY_SEC) return;
    // 飛球（ノーバウンド）はファウル地域上では捕らない（v1仕様：ファウルフライの
    // 捕球アウトは対象外）。着地後のボールは、着地点がフェアなら生きた打球なので
    // 現在地がファウル地域でも拾える（着地点ファウルは decideFallback が
    // ファウル判定で先に決着させるため、ここには来ない）。
    if (ballState.landing === null && !isFairPosition(ballState.x, ballState.z)) return;
    // ファインプレイ中の1人だけリーチが伸びた状態で判定する（説明書p23）。
    // 蹴り倒されている野手（フェーズF-26-4）は候補から外れる（倒れたまま捕らない）。
    const catcher = nearestCatchableFielder(
      catchablePositions(),
      { x: ballState.x, z: ballState.z },
      ballState.y,
      activeFinePlayReach(),
      catchBonusOf,
    );
    if (catcher === null) return;
    // 捕ったら跳んだ姿勢は解いて立たせる（以降 syncFielderMeshes は呼ばれないため、
    // ここで解かないと伏せた/浮いたままの見た目が残る）
    clearFinePlay();

    if (ballState.landing === null) {
      // ノーバウンド捕球＝打者はフライアウト。走者は元の塁へ戻り、そこから
      // タッチアップ（説明書p19）を仕掛けられる。仕掛ける余地が無い場面
      // （3アウト目・走者なし・CPU攻撃側が仕掛けない）はその場で畳む。
      onDefenseResult?.('out');
      if (!openTagUp(catcher)) {
        // **球は捕った野手の手の中へ**（テストプレイ「捕られたはずのボールが、捕った選手を
        // すり抜けてバウンドしていく」）。持ち主を書かずに畳むと、余韻（`updateAftermath`）が
        // 「誰の手にも無い球」として飛行を続けさせていた。持ち主が決まっていれば、余韻では
        // 手の中に収まり、少し置いてから投手へ返される（アウトの後の球回し）
        holderId = catcher;
        const p = fielderPos[catcher];
        ball.position.set(p.x, THROW_BALL_HEIGHT, p.z);
        shadow.visible = false;
        // 走者は誰も進めないので、開始時の顔ぶれがそのまま塁に残る
        finish({ kind: 'result', outsAdded: 1, runs: 0, baseRunners: originalRunners });
      }
      return;
    }
    // バウンド後の捕球＝ボールを確保。送球フェーズへ。
    phase = 'possessed';
    holderId = catcher;
    possessedTimer = 0;
    holdSafeTimer = 0;
    const p = fielderPos[catcher];
    ball.position.set(p.x, BALL_RADIUS, p.z);
    shadow.visible = false;
  }

  return {
    launch(initial, baseRunners, batterId, outs, carried) {
      phase = 'flying';
      playKind = 'batted';
      pickoffTimer = 0;
      pickoffIdleTimer = 0;
      bikeHoldSec = 0;
      holdArmed = [];
      ballState = initial;
      originalRunners = baseRunners;
      originalBases = occupancy(baseRunners);
      batterRunnerId = batterId;
      outsBefore = outs;
      forced = forcedRunners(originalBases);
      sentRunners.clear();
      outcome = null;
      pauseT = 0;
      elapsed = 0;
      restingT = 0;
    restingNearest = Infinity;
      restingNearest = Infinity;
      possessedTimer = 0;
      tagUpActive = false;
      clearThrowHold();
      queuedThrowBase = null;
      tagUpChanceOpen = false;
      clearPlayPrompt();

      resetFielders();
      holderId = null;
      carryTarget = null;
      cpuRundownUsed = false;
      cpuThrewOnce = false;
      defenseOuts = 0;
      throwState = null;
      holdSafeTimer = 0;
      const landing = predictLandingAt(initial);
      landingPoint = landing.point;
      // 一斉移動の対象（塁カバー4人を除く）のうち、着地予測にもっとも近い野手。
      // **X-45（CPUの余分な進塁）が守備の時間を見積もるのに使う**（守備側の見た目には
      // 使わない＝UU-69で「操作中の野手の目印」を外した）。
      const controllablePositions = Object.fromEntries(
        CONTROLLABLE_FIELDERS.map((id) => [id, FIELDER_HOME_POSITIONS[id]]),
      ) as Record<FielderId, Vec2>;
      const chaser = nearestFielder(landing.point, controllablePositions);

      // 塁上の走者は**投球中に取っていたリードの位置から**走り出す（フェーズY-46）。
      // 見るのは盗塁とまったく同じ `pitchLeads` なので、打者が見送るか打つかで走者の
      // 立ち位置が変わることがない。打者走者は本塁からで、これは従来と同じ。
      runnerVisuals = buildRunnerVisuals(
        baseRunners,
        forced,
        batterId,
        pitchLeads(baseRunners, carried),
      );
      // CPU攻撃側の「もう1つ先の塁を狙う」判断（フェーズX-45）。**打球の瞬間に決める**
      // ＝守備が確保してからでは走者はどんな送球にも勝てないので、実際の野球と同じく
      // 打った瞬間に走るかどうかを決める（見積もりは下の `cpuSecureEstimate`）。
      if (!isOffenseHuman()) startCpuExtraBases(landing, chaser);

      ball.visible = true;
      ball.scale.setScalar(BALL_SCALE);
      shadow.visible = true;
      syncBall(initial);
    },

    startPickoff(baseRunners, outs, carried) {
      // 持ち越したリード（フェーズL-32）があればそこから始める。無ければ従来どおり0＝
      // A-6で調整した「リードが育つのを待って投げる」タイミングの手触りは動かない。
      beginRunnerPlay('pickoff', baseRunners, outs, 'P', { ...carried });
    },

    startSteal(baseRunners, outs, target, pitchRemainingSec, carried) {
      // 走者を先に決める（進塁の塁指定と同じ選び方＝どの走者を走らせるかの規則は1つ）。
      // **無指定なら走れる走者が全員**（フェーズL-32のダブルスチール）。ただし本塁への
      // 盗塁は捕手が本塁に立っている＝必ず刺されるので、無指定の一斉スタートからは外す
      // （塁を指定すれば従来どおり仕掛けられる）。
      const candidates = sendableRunnerBases(occupancy(baseRunners), [], []);
      const chosen = Array.isArray(target)
        ? // CPUの判断（chooseCpuSteals）は走者そのものを指してくる。実際に走れる走者だけに
          // 絞ってから使う＝規則が古い塁状況を見ていても、いない走者を走らせることはない。
          target.filter((from) => candidates.includes(from))
        : chooseSendRunners(
            target === null ? stealableBases(candidates) : candidates,
            target,
          );
      if (chosen.length === 0) return false;

      // 盗塁は「捕手がまだボールを持っていない」ところから始まる唯一のプレー。
      // 投球が届くまで（pitchRemainingSec）＋持ち替え（STEAL_CATCH_RELEASE_SEC）は
      // 送球もランダンもできず、その待ちが走者の持ち時間になる。
      //
      // **リードは走る走者だけでなく全走者に与える**（フェーズL-32）＝「投球中の走者は
      // 標準的なリードを取っている」という STEAL_LEAD の意味そのものを、走らない走者にも
      // 一貫させる。そうしないと、同じ場面で仕掛けた走者だけが 3.5m から、後から仕掛けた
      // 走者は塁の真上から走ることになり、**押した順番が成否を決めてしまう**。
      // スタート位置は「持ち越したリード（L-32）＞その走者のスキル（ドウブツ系統
      // `ウサギ`/`ウマ`。F-26-5）」の順に決まる。深いほど走る距離が短くなる＝そのまま
      // 盗塁の成否に効く。
      beginRunnerPlay('steal', baseRunners, outs, 'C', pitchLeads(baseRunners, carried));
      ballArriveSec = Math.max(0, pitchRemainingSec);
      throwHoldSec = ballArriveSec + STEAL_CATCH_RELEASE_SEC;
      throwHoldTimer = 0;
      // 投球が捕手へ飛んでいく様子を見せる（＝いつ捕手が投げられるようになるかの手がかり）
      pitchBallFrom = { ...FIELDER_HOME_POSITIONS.P };
      ball.position.set(pitchBallFrom.x, BALL_RADIUS, pitchBallFrom.z);

      for (const from of chosen) startRunnerAdvance(from);
      return true;
    },

    convertToBattedBall(initial, batterId) {
      // すでに決着した（帰結の表示待ちの）プレーには引き継がない＝確定した帰結を
      // 上書きしない。盗塁の決着より投球のほうが必ず先に終わるので実際には通らないが、
      // 「引き継げるのは走っている最中のプレーだけ」を成立条件として持たせておく。
      if (phase === null || phase === 'resolved' || playKind !== 'steal') return false;

      // 投球の前にスタートを切っていた走者に印を付ける（＝いま走っている走者。
      // このあとフォースを掛け直すと区別が付かなくなるので、必ず先に取る）。
      for (const v of runnerVisuals) {
        if (v.origin === 'batter' || v.out) continue;
        if (v.forced !== null) v.brokeEarly = true;
      }

      playKind = 'batted';
      phase = 'flying';
      ballState = initial;
      batterRunnerId = batterId;
      // 打球としての計時はここから（捕球無効の CATCH_MIN_PLAY_SEC も打った瞬間が起点）
      elapsed = 0;
      restingT = 0;
    restingNearest = Infinity;
      restingNearest = Infinity;
      possessedTimer = 0;
      holdSafeTimer = 0;
      // 捕手へ飛んでいた投球は打たれてもう無い＝「投球が届くまで投げられない」待ちも
      // 一緒に消える（打球を捕った野手は普通にすぐ投げられる）。
      clearThrowHold();
      queuedThrowBase = null;
      holderId = null;
      carryTarget = null;
      throwState = null;
      // 打球としては新しいプレーなので、守備の1プレー限りの枷も数え直す（フェーズK-31）
      cpuRundownUsed = false;
      cpuThrewOnce = false;
      defenseOuts = 0;
      tagUpActive = false;
      tagUpChanceOpen = false;
      clearPlayPrompt();

      // フォースはこの打球で決まり直す（打者走者が一塁へ走る＝後ろの走者が押し出される）。
      // 盗塁で走り出していた走者はすでに同じ塁へ向かっているので行き先は変わらず、
      // **走った分だけ先行している**（＝走らせて打つことの見返り）。
      forced = forcedRunners(originalBases);
      for (const runner of forced) {
        if (runner.from === 'batter') continue;
        const v = findVisual(runner.from);
        if (!v || v.out || v.arrived) continue;
        v.forced = runner;
        // 打球で押し出された走者はここで**フォースプレーに変わる**（フェーズK-31）＝
        // 盗塁のときはタッチが要ったのに、打った瞬間から塁を踏まれるだけでアウトになる。
        // 実際の野球と同じで、走者にとっては「打ってくれたぶん戻れなくなる」ことを意味する。
        v.forcePlay = true;
        v.returning = false;
        // 打たれた以上フォースで走る義務があるので、止まっていた走者も走り出す
        // （フェーズN-34。止まる権利は残すので、打球のプレーの中でもう一度止まれる）。
        v.holding = false;
        v.target = BASE_POSITIONS[runner.to];
        // フォースされた走者は「呼び戻せる走者」ではない（打球のプレーと同じ扱い）
        sentRunners.delete(runner.from);
      }

      // 打者走者を足す（盗塁のプレーには打者走者がいない）。位置は本塁＝打った瞬間の起点。
      runnerVisuals.push(
        makeRunnerVisual('batter', BASE_POSITIONS.home, batterId, {
          from: 'batter',
          to: 'first',
        }),
      );

      const landing = predictLanding(initial);
      landingPoint = landing;

      ball.visible = true;
      ball.scale.setScalar(BALL_SCALE);
      shadow.visible = true;
      syncBall(initial);
      return true;
    },

    update(dt) {
      if (phase === null) return;
      // 捕球・送球の音（局面の切り替わりを1フレーム遅れで拾う＝判定の流れには割り込まない）
      if (phase !== soundPhase) {
        if (phase === 'throwing') onFieldSound?.('throw', holderId);
        else if (
          phase === 'possessed' &&
          (soundPhase === 'flying' || soundPhase === 'loose' || soundPhase === 'throwing')
        ) {
          onFieldSound?.('catch', holderId);
        }
        soundPhase = phase;
      }
      const d = Math.min(dt, MAX_DT);
      // 蹴り倒された野手の起き上がり（フェーズF-26-4）はどのフェーズでも進める
      // ＝送球中に蹴られた野手が、送球の到着を待たされて余分に寝ていることが起きない。
      updateDownedFielders(d);
      // 送球の振り抜き（フェーズHH-55）も同じくどのフェーズでも進める＝ボールが着いて
      // possessed へ戻った後も、投げた本人は振り抜き切ってから直立に戻る（至近距離の
      // 送球で動作が途中で消えない）。
      if (throwPose) {
        throwPose.sec -= d;
        if (throwPose.sec <= 0) throwPose = null;
      }
      // **送球の見た目は「野手が1歩も動かないフェーズ」で起きる**ので、ここで書く。
      // 姿勢を書き直しているのは打球の飛行中（flying）・こぼれ球（loose）・ランダン
      // （carrying）＝**野手が動く局面だけ**で、送球中（throwing）と確保中（possessed）は
      // 誰も動かないぶん一度も更新されていなかった（＝振り抜きも受け手のグラブも、
      // 姿勢を書いても画面に出ない。実機で踏んだ）。**この2つの局面でしか呼ばない**ので、
      // 既存の3局面が二重に書かれることはない。
      if (throwPose || phase === 'throwing') syncFielderMeshes();
      // 操作ヒント（ファインプレイ／タッチアップ／帰塁）は毎フレーム状態から導出する。
      // 進塁を仕掛けた・呼び戻した・走者が塁を踏んだ・ボールが射程に入った、の
      // いずれでも表示が追随する。
      syncPlayPrompt();

      if (phase === 'resolved') {
        // 決着後も画面は止めない（フェーズWW-71）：見た目だけ動かし続けてから戻る
        updateAftermath(d);
        pauseT -= d;
        if (pauseT <= 0 && outcome) {
          const settled = outcome;
          cleanup();
          onSettled(settled);
        }
        return;
      }

      // 野手の移動（捕球後は送球するまで静止＝ボールを持ったまま走らないv1仕様）。
      // 原作準拠（説明書p20）：塁カバー4人は自動で各塁へ入り、残り（P/SS/LF/CF/RF）は
      // 十字キーで「全員が同じ方向へ」一斉移動する。CPU守備は、着地予測にもっとも
      // 近い野手が目標（着地予測。着地後はボールの現在地）へ向かう方向を全員に適用する
      // （＝人間の一斉移動と同じ動かし方をCPUがやる。コードパスを分けないための設計）。
      if (phase === 'flying') {
        // ファインプレイ中の野手は、跳んだ勢いで動き（ダイビング）、起き上がるまで
        // 一斉移動・塁カバーの対象から外れる（＝跳んで外したときのコスト）。
        updateFinePlay(d);

        updateFielderMovement(
          d,
          ballState
            ? ballState.landing !== null
              ? { x: ballState.x, z: ballState.z }
              : landingPoint
            : null,
        );

        // CPU守備のファインプレイ（説明書p23）：打球を先読みして「立っていては届かないが
        // 跳べば届く」ときだけ跳ぶ（決定的判断。無駄跳びをしないので起き上がりの隙は出ない）。
        if (!isDefenseHuman() && finePlay === null && ballState && elapsed >= CATCH_MIN_PLAY_SEC) {
          const choice = chooseCpuFinePlay(fielderPos, ballState, undefined, catchBonusOf);
          if (choice) startFinePlay(choice.id, choice.kind, choice.dir);
        }

        // CPU守備の一時効果（フェーズM-33。`ケモノガエリ`）：ファインプレイとまったく
        // 同じ判断の形で、「このままでは届かないが**範囲が広がれば**届く」ときだけ切る。
        // 候補の選び方（札を持つ野手のうちボールに最も近い1人）は人間のGと共通なので、
        // **CPUが人間にはできない選び方をすることが起きない**（⑧の対等）。
        if (!isDefenseHuman() && ballState && elapsed >= CATCH_MIN_PLAY_SEC) {
          const id = catchEffectCandidate();
          if (
            id !== null &&
            shouldCpuActivateCatchEffect(
              fielderPos[id],
              ballState,
              CATCH_RADIUS + catchBonusOf(id),
              CATCH_RADIUS + catchBonusOf(id) + catchEffectGain(id),
            )
          ) {
            onCatchEffect?.(id);
          }
        }
        syncFielderMeshes();

        // 捕球は人間・CPUを問わず、射程に入り次第ボタン入力なしで毎フレーム自動で試みる
        // （attemptCatchは範囲外なら無害）。原作ファミスタ準拠：捕球にボタンは使わず、
        // プレイヤーの仕事は「野手をボールに重ねる」ことだけ。Aは送球専用。塁カバーの
        // 4人も含めた全野手が捕球候補（説明書p20）。
        // かつては人間側のみ「射程内でAを押した瞬間」に捕球する方式だったが、
        // 打球は捕球半径2.6mを100〜200ミリ秒で通り抜けるため、人間の反応速度では
        // タイミング押しが実質不可能だった（実機テストプレイの「捕球できない」報告の
        // 根本原因。詳細はPROGRESS.md「実装メモ」）。
        attemptCatch();
      }

      // フライアウト等でこのフレーム中に決着した場合はここで打ち切る（残りのポーズ
      // カウントダウンは次フレームの冒頭分岐に任せる）。possessed への遷移は
      // 下の分岐が扱うのでここでは resolved のときだけ抜ける。捕球は上の移動ブロックで
      // 毎フレーム自動発火するため、resolved 後にボール物理・decideFallback を
      // 二重に走らせない安全策としてこのガードが必要。
      // attemptCatch() 内の finish() が phase を書き換え得ることを TS の制御フロー解析は
      // 追えないため、型アサーションで明示的に全候補と比較する。
      if ((phase as PlayPhase) === 'resolved') return;

      // 走者の自動進塁（フォース対象＋人間が攻撃側のとき任意で送った走者。
      // 捕球確保中も進み続ける＝止まらない）。刺された走者は動かない。
      // 目標塁に到達したら arrived を立ててセーフ確定（以後は送球でも刺せない）。
      // バイク（フェーズF-26-3）は走者を動かす前に見る：点火はこのフレームの移動から
      // 効かせ、オーバーラン中のCPUは走り出しの向きが変わる前に帰塁の判断をする。
      updateBikeIgnition(d);
      // 「止まれ」はJを離した瞬間に効く（フェーズN-34）。**点火の判定の後**に見るので、
      // 押し続けて点火した押下はここへ来ない（`igniteBike` が予約を捨てている）。
      updateHoldRelease();
      updateCpuOverrunReturn(d);
      // 転倒（フェーズF-26-4）の計時。移動より先に減らすので、残り時間が尽きたフレームから
      // すぐ走り出す（止まっている見た目と timeToSafety の持ち時間が1フレームもずれない）。
      // 蹴りの動作（フェーズE-25-(e)。見た目だけ）も同じところで減らす。
      for (const v of runnerVisuals) {
        if (v.stumbleSec > 0) v.stumbleSec = Math.max(0, v.stumbleSec - d);
        if (v.kickSec > 0) v.kickSec = Math.max(0, v.kickSec - d);
      }
      for (const v of runnerVisuals) {
        if (!v.forced || v.out || v.arrived) continue;
        // ドロップキックを空振りして転んでいる間は動かない（フェーズF-26-4）。
        // 送球との時間競争には timeToSafety がこの残り時間を足して効かせるので、
        // 「見た目は止まっているのに判定だけ走っている」は起きない。
        if (v.stumbleSec > 0) continue;
        // 自分から止まっている間も動かない（フェーズN-34）。持ち時間は timeToSafety が
        // 無限にするので、こちらも見た目と判定が一致する（転倒とまったく同じ扱い）。
        if (v.holding) continue;
        const remaining = distance(v.pos, v.target);
        if (remaining <= BASE_ARRIVE_RADIUS) {
          // オーバーラン地点に着いた＝塁の外で停止する。**arrived にはしない**ので、
          // 帰塁の指示が出るまで送球でもタッチでも刺されうる（バイクの代償）。
          // 停止位置は地点そのものへ合わせる（BASE_ARRIVE_RADIUS の手前で止まると、
          // 「何m行き過ぎるか」が定数どおりにならず、刺せる深さの見積もりがぶれる）。
          if (v.overrun) {
            v.pos = { ...v.target };
            placeRunner(v);
            continue;
          }
          // 曲がれないので塁で止まれず行き過ぎる。踏んだ塁は forced.to のまま
          if (v.bike && bikeOverrunsAt(v.forced.to)) {
            startOverrun(v);
            continue;
          }
          v.arrived = true;
          continue;
        }
        const step = runSpeed(v) * d;
        const t = Math.min(1, step / remaining);
        v.pos = { x: v.pos.x + (v.target.x - v.pos.x) * t, z: v.pos.z + (v.target.z - v.pos.z) * t };
        placeRunner(v);
      }

      // けん制モード（説明書p24）のリード。塁上の走者はじりじり塁を離れ、帰塁し切った
      // 走者は塁に戻ってまたリードを取り直す（帰塁は「無かったこと」にはならず、戻った
      // ぶんリードが浅い状態からのやり直しになる＝Aを押すこと自体にも時間の代償がある）。
      if (playKind === 'pickoff') {
        pickoffTimer += d;
        for (const v of runnerVisuals) {
          if (!v.returning || !v.arrived || v.out) continue;
          // **送球が空中にある間は塁上へ戻さない**（フェーズK-31）。戻すと走行区間（forced）が
          // 消え、その送球のタッチの予約（`throwState.pendingTag`）が「行き先が変わった」と
          // 見なされて無効になる＝**けん制球が必ずセーフになる**（実機で踏んだ）。走者が
          // 塁の 1.4m 手前で「到達」扱いになるぶんの猶予を、守備側に返さないための条件でもある。
          if (throwState !== null) continue;
          const base = v.origin as 'first' | 'second' | 'third';
          v.forced = null;
          v.forcePlay = false;
          // 塁を踏み直したので、また1回引き返せる（フェーズK-31）。けん制は1つのプレーの中で
          // 何度も投げられるので、ここを戻さないと2球目以降の帰塁ができなくなる。
          v.retreatUsed = false;
          // 同じ理由で、また1回止まれる（フェーズN-34）
          v.holding = false;
          v.holdUsed = false;
          v.returning = false;
          v.arrived = false;
          v.lead = 0;
          v.pos = { ...BASE_POSITIONS[base] };
          v.target = { ...v.pos };
          placeRunner(v, true);
        }
        updateLeads(d);
      }

      // 走者の姿勢（バイク・蹴り・転倒。フェーズE-25-(e)）は、走者を動かし終えたこの位置で
      // 上書きする（`movePlayerTo` が書いた走り／直立より後）。
      syncRunnerPoses();

      // CPU走者のドロップキック（フェーズF-26-4）。当たれば phase が 'loose' に変わるので、
      // この直後の分岐がそのまま「落球した局面」へ流れる。
      updateCpuDropkick();
      // CPU走者の引き返し・走り出し（フェーズJ-30）。**蹴りの後**に見るのは、蹴って
      // ボールが落ちたフレームでは `hasBallInHand()` が false になり「守備はボールを
      // 持っていない＝逃げる理由が無い」が正しく効くため（順序が逆だと、落ちる直前の
      // 状態を見て引き返してしまう）。
      updateCpuRetreat();
      // 止まる／止まるのをやめる（フェーズN-34）。**引き返しの後**＝「戻れば助かる」を
      // 先に見るので、2つの規則が同じ場面で競合しない。
      updateCpuHold();
      updateCpuBreak();

      if (phase === 'loose') {
        // 叩き落とされたボールを拾いにいく局面。**野手の動かし方は打球の飛行中と同じ**で、
        // 拾えたらそのまま送球できる possessed へ戻る。走者の移動はこの上で済んでいるので、
        // 落球している間も走塁は止まらない（＝落とされた時間がそのまま失点への距離になる）。
        updateFielderMovement(d, looseBallPos);
        syncFielderMeshes();
        attemptLooseBallPickup();
        // 誰も拾わないまま全走者が決着したら、確保中と同じ猶予でプレーを畳む
        // （ボールが地面にあるままプレーが終わらない、への保険）。
        if ((phase as PlayPhase) === 'loose') {
          if (hasLiveRunner()) holdSafeTimer = 0;
          else {
            holdSafeTimer += d;
            if (holdSafeTimer >= HOLD_ALL_SAFE_SEC) finalizePlay();
          }
        }
        return;
      }

      if (phase === 'possessed' || phase === 'carrying') {
        possessedTimer += d;
        // 「まだ投げられない」待ち（フライ捕球後の持ち替え／盗塁の投球到達＋持ち替え）の
        // 計時はランダンで走っている間も進める。ここを possessed だけにすると
        // 「Bで走り出してからA」で持ち替えを迂回でき、犠牲フライが成立しなくなる
        // （この待ちがタッチアップ成立の前提。fielding.ts参照）。
        throwHoldTimer += d;
        // 盗塁で投球が捕手へ飛んでいる間の見た目（届いた時点で普通の確保表示に戻る）
        if (pitchBallFrom !== null) {
          if (throwHoldTimer >= ballArriveSec) {
            pitchBallFrom = null;
            const mitt = holderId !== null ? fielderPos[holderId] : BASE_POSITIONS.home;
            ball.position.set(mitt.x, BALL_RADIUS, mitt.z);
          } else {
            const mitt = holderId !== null ? fielderPos[holderId] : BASE_POSITIONS.home;
            const t = ballArriveSec > 0 ? throwHoldTimer / ballArriveSec : 1;
            ball.position.set(
              pitchBallFrom.x + (mitt.x - pitchBallFrom.x) * t,
              THROW_BALL_HEIGHT,
              pitchBallFrom.z + (mitt.z - pitchBallFrom.z) * t,
            );
          }
        }
        // フェーズK-31：止まってボールを持っている間も、**塁間を走っている**走者に触れて
        // いればタッチアウト（ランダン中＝carrying は `updateRundown` が同じ判定を持つ）。
        // けん制でリードしているだけの走者を渡さないのが要点（`updateTag` のコメント）。
        if (phase === 'possessed') updateTag(liveRunners());
        // 持ち替え中に押された送球指示は、投げられるようになった瞬間に発射する
        if (queuedThrowBase !== null && canThrowNow()) {
          const queued = queuedThrowBase;
          queuedThrowBase = null;
          releaseThrow(queued, false);
          return;
        }
        // ランダンプレイ（説明書p25）は人間守備のみ。CPU守備は従来どおり送球で完結する
        // （追う判断・向きの変更まで持たせると、既に調整済みのCPU守備の挙動が変わるため）。
        if (phase === 'carrying') {
          updateRundown(d);
          return;
        }
        if (playKind === 'pickoff') {
          // けん制モード（説明書p24）のにらみ合い。打球の守備と違い、走者は「刺せる走者」に
          // なるまで（＝走り出す/帰塁を始めるまで）塁上でリードを広げているだけなので、
          // 打球用の畳みタイマー（HOLD_ALL_SAFE_SEC=1.5秒）ではリードが育つ前に終わって
          // しまう。専用の窓（PICKOFF_WINDOW_SEC）で計り、閉じたら投球へ戻す。
          const throwFrom = holderId !== null ? fielderPos[holderId] : FIELDER_HOME_POSITIONS.P;
          if (!isDefenseHuman()) {
            // CPU投手のけん制（＝人間が攻撃側）。走り出した／帰塁を始めた走者がいれば
            // その行き先へ即座に投げ（CPU_PICKOFF_REACTION_SEC）、いなければリードが
            // 刺せる深さに育った塁へ投げる（chooseCpuPickoffThrow）。
            const live = liveRunners();
            if (live.length > 0) {
              if (possessedTimer >= CPU_PICKOFF_REACTION_SEC) {
                // **投げても触れない走者には投げない**（フェーズN-34）。塁間で止まった走者
                // （と、バイクで塁を行き過ぎた走者）は塁へ投げても刺せないので、ここを
                // 素通しにすると**同じ塁へ0mの送球を繰り返してプレーが終わらない**。
                // 打球のプレーのCPU守備（下の分岐）が `throwWouldGet` で同じ絞り込みを
                // しているのと対で、追う判断も同じ `chooseCpuRundown` に任せる。
                const gettable = live.filter(throwWouldGet);
                if (gettable.length > 0) {
                  releaseThrow(gettable[gettable.length - 1].forced!.to, true);
                  return;
                }
                const chase = cpuChaseTarget(live);
                if (chase) {
                  cpuRundownUsed = true;
                  startRundownTo(chase);
                  return;
                }
                // 刺せる相手も追える相手もいない＝投げても無駄なので畳む（打球のプレーの
                // CPU守備と同じ畳み方。ここが無いと止まった走者の前で永久に止まる）。
                finalizePlay();
              }
              return;
            }
            const target = chooseCpuPickoffThrow(throwFrom, currentLeads());
            if (target !== null) {
              releaseThrow(target, true);
              return;
            }
            // **誰も塁を離れていなければ早めに切り上げる**（フェーズII-56）。人間の走者は
            // リードを押している間しか取らない（`updateLeads`）ので、押されないまま
            // 3秒の窓を使い切るのは**投げる相手がいないと分かっているのに待っている**
            // だけになる＝走者が出るたび毎打席3秒止まる。押し始めればリードが0を超えて
            // タイマーが戻るので、**にらみ合いに入った側の駆け引きは何も失われない**。
            // **人間が守備側のときは触らない**（窓の長さは守る側の持ち時間なので、
            // 2P PLAY で相手が動くのを待つ自由をこちらの都合で削らない）。
            if (leadingRunners().every((v) => v.lead <= 0)) {
              pickoffIdleTimer += d;
              if (pickoffIdleTimer >= PICKOFF_IDLE_SEC && !hasLiveRunner()) {
                finalizePlay();
                return;
              }
            } else {
              pickoffIdleTimer = 0;
            }
          }
          // 走者が動いている間（送球で刺せる／ランダンで追える間）は決着を待つ
          if (pickoffTimer >= PICKOFF_WINDOW_SEC && !hasLiveRunner()) finalizePlay();
          return;
        }
        if (!isDefenseHuman()) {
          // CPU守備：短い反応時間で「もっとも進んだ、まだ刺せる走者の塁」へ送球する。
          //
          // **フェーズK-31で「投げ直せる」ようにした。** タッチプレーでは送球の帰結が
          // 到着まで決まらないので、1送球で畳んでいると「投げられた瞬間に引き返す」だけで
          // ノーリスクになる（人間の攻撃側が一方的に得をする）。ただし**取れるアウトは
          // 従来どおり1プレーに1つ**（`defenseOuts`）＝K-31はCPU守備を強くするための
          // 変更ではない。投げ直せるのは「無駄になった送球のあと」だけになる。
          const live = liveRunners();
          if (live.length === 0) {
            // タッチアップの判断猶予（人間が攻撃側）の間は、仕掛けてくるのを待って畳まない
            if (!tagUpActive || throwHoldTimer >= TAG_UP_WINDOW_SEC) {
              if (possessedTimer >= CPU_POSSESSED_REACTION_SEC) finalizePlay();
            }
          } else if (defenseOuts > 0) {
            // すでに1つ取った＝K-31より前の「1送球で完結」と同じところで畳む
            // （待ちを足さないので、送球が着いてから畳むまでのテンポも従来と同じ）。
            finalizePlay();
          } else if (possessedTimer >= CPU_POSSESSED_REACTION_SEC && canThrowNow()) {
            // ランダンプレイ（説明書p25。フェーズJ-30）は**送球で刺せないときだけ**仕掛ける
            // （ユーザー判断）。確実なアウトを遅い手段に置き換えても一度も得をしないので、
            // 刺せる送球があるならこれまでどおり投げる＝**取れていたアウトは減らない**。
            //
            // **計測の結論（`npm run balance:rundown`）：現在の定数ではこの経路は発火しない。**
            // 送球もランダンも**同じ塁**を目指すので、塁への競争では送球が必ず勝つ
            // （「送球で刺せない」＝野手は塁から走者の THROW_SPEED/走力 倍以上遠い、という
            // 意味なので、走ればさらに遅い）。フィールドを格子で舐めると「送球では刺せないが
            // 走れば追える」帯は**送球 34〜10m/s のどこでも 0.0%** で、送球を遅くしても
            // 開かない（開くのは送球が野手の足より遅くなったときだけ＝あり得ない）。
            // 2026-08-03 ユーザー判断で **THROW_SPEED は据え置き**、この経路は
            // 「規則としては正しく、この守備モデルでは出番が無い」ものとして残す
            // （送球を遅くするスキル等が入れば、定数を触らずそのまま効き始める）。
            // 挟殺そのものは `updateCpuRetreat`（CPU走者の引き返し）の側で成立している。
            //
            // **フェーズK-31でこの経路に出番ができた。** タッチプレーを入れたことで
            // 「投げても触れない走者」（バイクで塁を行き過ぎて止まっている走者＝
            // `throwRetiresRunner` が false を返す唯一の形）が生まれ、そこでは
            // `throwWouldGet` が全員 false になるので、CPUは走って追うほかない。
            // 走者側から見れば、**寄ってくる野手をドロップキックで蹴れる場面**でもある。
            const lead = live[live.length - 1];
            const chase = throwWouldGet(lead) ? null : cpuChaseTarget(live);
            // 2投目以降は「送球で刺せる走者」だけを狙う（1投目は従来どおり、もっとも
            // 進んだ走者の塁へ必ず投げる＝安打でボールが返ってくる絵が変わらない）。
            const gettable = live.filter(throwWouldGet);
            // 送球先の規則は `chooseCpuThrowTarget`（フェーズY-46で純粋関数へ切り出した）。
            // 1投目は先頭の塁へ、ただし刺せないなら刺せる走者へ／2投目以降は刺せる走者だけ。
            const nextThrow = chooseCpuThrowTarget(live, throwWouldGet, cpuThrewOnce);
            // **すでにその塁にボールがあるなら投げない**（フェーズK-31）。タッチプレーの
            // 走者は塁で待って触れば決まるので、投げると距離0の送球を繰り返すだけになる。
            const ballIsThere =
              nextThrow !== null &&
              holderId !== null &&
              distance(fielderPos[holderId], BASE_POSITIONS[nextThrow.forced!.to]) <=
                BASE_ARRIVE_RADIUS;
            if (chase) {
              // **1プレーに1回だけ**（`cpuRundownUsed`）＝仕留められなくても必ず送球へ戻るので、
              // 走って追い続けてプレーが終わらないことが構造的に起きない
              // （バイクの `bikeUsed`・ドロップキックの `dropkickUsed` と同じ規則）。
              cpuRundownUsed = true;
              startRundownTo(chase);
            } else if (nextThrow && !ballIsThere) {
              cpuThrewOnce = true;
              releaseThrow(nextThrow.forced!.to, true);
            } else if (gettable.length === 0) {
              // 刺せる相手も追える相手もいない＝投げても無駄なので畳む。**同じ塁へ投げ続けて
              // プレーが終わらない**ことをここで塞いでいる。畳むまでの間はこの分岐に入る
              // 条件（CPU_POSSESSED_REACTION_SEC）がすでに置いているので、待ちを足さない
              // ＝K-31より前の「送球が着いたら畳む」テンポがそのまま残る。
              finalizePlay();
            }
            // 刺せる走者がいて、その塁にはもうボールがある＝**投げずに待つ**。
            // 走者は自分からタッチ半径へ入ってくるので、`updateTag` が必ず決着させる。
          }
        } else {
          // 人間守備：自動送球はしない（送球はA+塁指定でプレイヤーが行う。連続送球可）。
          // まだ刺せる走者がいる間は、プレイヤーの送球を待ち続ける。全走者が決着
          // （アウト or 到達）したら、少しの間を置いてプレーを畳む（ボールを持ったまま
          // 永久にプレーが終わらないことへの保険）。
          if (hasLiveRunner()) {
            holdSafeTimer = 0;
          } else {
            holdSafeTimer += d;
            if (holdSafeTimer >= HOLD_ALL_SAFE_SEC) finalizePlay();
          }
        }
        return;
      }

      if (phase === 'throwing' && throwState) {
        // 送球ボールの飛行（見た目）。到着したらこの送球の帰結（アウト/セーフ）を
        // バナーで見せ、連続送球のため possessed に戻す（到着塁の担当野手が確保）。
        // 走者が来ていない塁への送球は判定なし（result=null）＝バナーを出さない。
        const targetBase = throwState.target;
        const target = BASE_POSITIONS[targetBase];
        const dx = target.x - throwState.pos.x;
        const dz = target.z - throwState.pos.z;
        const dist = Math.hypot(dx, dz);
        const step = THROW_SPEED * d;
        if (dist <= step) {
          ball.position.set(target.x, BALL_RADIUS, target.z);
          // タッチプレーの予約（フェーズK-31）をここで発効する。**まだ同じ塁へ向かっている
          // 走者だけ**がアウトで、送球されてから引き返した走者は対象から外れる＝その送球は
          // 無駄になる（守備は投げ直すか、走って追うかを選び直すことになる）。
          const pending = throwState.pendingTag;
          let result = throwState.result;
          // **予約が生きているのは、まだその塁へ向かって走っているときだけ**。条件は
          // 予約を付けたときとまったく同じ（`releaseThrow` の `throwRetiresRunner` の形）で、
          // 引き返した走者（K-31）と**その場で止まった走者（N-34）**が同じように外れる
          // ＝どちらも「投げられてから逃げれば、その送球は無駄になる。ただし1プレーに1回」。
          if (
            pending &&
            !pending.out &&
            pending.forced?.to === targetBase &&
            approachingOwnBase(pending)
          ) {
            pending.out = true;
            pending.mesh.visible = false;
            defenseOuts += 1;
            result = 'out';
          }
          if (result) onDefenseResult?.(result);
          throwState = null;
          // 送球ごとに possessed へ戻り、続けて別の塁へ投げられる（＝1塁でセーフになっても
          // 2塁へ投げられる。実機テストプレイの指摘）。まだ刺せる走者がいなくても即終了は
          // せず、possessed の猶予タイマー（holdSafeTimer >= HOLD_ALL_SAFE_SEC）で畳む＝
          // 送球後にもう一投する時間を必ず確保する。
          //
          // **フェーズK-31：CPU守備もこの経路を通る**（それまでは `finalizePlay()` で
          // 1送球完結だった）。タッチプレーでは送球の帰結が到着まで決まらないので、
          // 1送球で畳むと「投げられた瞬間に引き返す」だけで走者がノーリスクになる。
          // 投げ続けて終わらない心配は、CPU側の「2投目以降は刺せる相手がいるときだけ」
          // （`cpuThrewOnce`）が塞いでいる。
          const receiver = BASE_COVER_FIELDER[targetBase];
          if (isFielderDown(receiver)) {
            // 受け手が蹴り倒されている（フェーズF-26-4）＝捕れないのでその塁にこぼれる。
            // **この送球の判定（アウト/セーフ）は release 時に確定済みなので覆さない**
            // （判定と見た目が一致するという既存の約束。releaseThrow のコメント参照）。
            // 覆るのは「次の送球ができるか」のほうで、拾い直すまで守備が止まる。
            looseBallPos = { ...target };
            holderId = null;
            carryTarget = null;
            phase = 'loose';
            possessedTimer = 0;
            holdSafeTimer = 0;
            ball.position.set(target.x, BALL_RADIUS, target.z);
            return;
          }
          holderId = receiver;
          fielderPos[holderId] = { ...target };
          phase = 'possessed';
          possessedTimer = 0;
          holdSafeTimer = 0;
        } else {
          throwState.pos.x += (dx / dist) * step;
          throwState.pos.z += (dz / dist) * step;
          ball.position.set(throwState.pos.x, THROW_BALL_HEIGHT, throwState.pos.z);
        }
        return;
      }

      // phase === 'flying'：ボール物理を進めつつ、確定条件をポーリング
      if (ballState && !ballState.resting) {
        ballState = stepBattedBall(ballState, d, ballpark());
        syncBall(ballState);
      }
      if (ballState) {
        elapsed += d;
        if (ballState.resting) {
          // **最寄りの野手が近づいている間は猶予を数え直す**（テストプレイの指摘）。
          // 「守備が間に合わなかった」で打ち切ってよいのは**誰も追いついていないとき**
          // だけで、走っている最中に打ち切ると「球を取ってもいないのに次の打者へ移る」。
          // 判定に使うのは捕球と同じ野手の位置なので、新しい状態も定数も増えていない。
          const near = nearestFielderDistance(ballState.x, ballState.z);
          if (near < restingNearest) {
            restingNearest = near;
            restingT = 0;
          } else {
            restingT += d;
          }
        }
        const fallback = decideFallback(ballState, restingT);
        if (fallback) {
          finish(fallback);
        } else if (elapsed >= MAX_PLAY_SEC) {
          finish(resultFromHit('triple'));
        }
      }
    },

    action() {
      // 飛行中のAはファインプレイ（説明書p23）。捕球そのものは毎フレーム自動で
      // 成立するため（原作準拠。Aは捕球には使わない）、ここでは跳ぶ操作だけを扱う。
      if (phase === 'flying') tryFinePlay();
      else if (phase === 'possessed' || phase === 'carrying') {
        // 原作準拠（説明書p21）：十字キーは塁の絶対指定（上=二塁、左=三塁、右=一塁、
        // 下=本塁）。指示しないときは自動的に一塁へ送球する。連続送球なので、到着後に
        // またA+塁指定で別の塁へ投げられる。ランダンで走っている最中でも投げられる。
        const { x, y } = defensePad.direction();
        const targetBase = baseFromPadDirection(x, y) ?? 'first';
        // フライ捕球直後の持ち替え中（タッチアップ局面）はまだ投げられないので、
        // 指定だけ予約して投げられる瞬間に発射する（押しても無反応、を避ける）。
        if (canThrowNow()) releaseThrow(targetBase, false);
        else queuedThrowBase = targetBase;
      }
    },

    startRundown() {
      if (phase !== 'possessed' && phase !== 'carrying') return;
      // 盗塁で投球がまだ捕手に届いていない間は、持って走るボールがそもそも手元にない
      if (!hasBallInHand()) return;
      // 原作準拠（説明書p25）：十字キーは塁の絶対指定で、指示しないときは一塁へ
      // （送球の塁指定と同じ操作体系）。
      const { x, y } = defensePad.direction();
      startRundownTo(baseFromPadDirection(x, y) ?? 'first');
    },

    sendRunner() {
      if (phase === null) return;
      // 原作準拠（説明書p16・p30）：十字キーは「進塁する塁」の絶対指定
      // （上=二塁、左=三塁、下=本塁）。指定された塁へ進める走者がいなければ何もしない。
      // **無入力なら仕掛けられる走者が全員走る**（フェーズL-32。選択規則は盗塁
      // （startSteal）と共通の chooseSendRunners に置いてある＝同じ入力なら同じ意味）。
      //
      // **フェーズN-34：走れる走者が1人もいないときだけ「止まれ／再スタート」になる**
      // （`chooseRunnerCommand`）。この順番なので、L-32までの帰結は1つも変わらない。
      const { x, y } = offensePad.direction();
      const command = chooseRunnerCommand(
        // 塁を踏み直していない走者（フェーズH-28のリタッチ待ち）は、仕掛けた走者と
        // 同じ扱いで候補から外す＝「もう走っているので新たには仕掛けられない」。
        sendableRunnerBases(originalBases, forced, [
          ...sentRunners.keys(),
          ...retouchPendingBases(),
        ]),
        runningLegs(),
        baseFromPadDirection(x, y),
      );
      if (command === null) return;
      if (command.kind === 'send') {
        for (const from of command.from) startRunnerAdvance(from as 'first' | 'second' | 'third');
        return;
      }
      if (command.kind === 'resume') {
        for (const from of command.from) {
          const v = runnerByOrigin(from);
          if (v) startRunnerResume(v);
        }
        return;
      }
      // 「止まれ」だけは**離した瞬間**に効く（同じJの長押しがバイクの点火のため。
      // `holdArmed` のコメント参照）。押している間はまだ走り続けている。
      holdArmed = command.from;
    },

    recallRunner() {
      if (phase === null) return;
      // 原作準拠（説明書p19）：十字キーは「帰る塁」の絶対指定（上=二塁、左=三塁、
      // 右=一塁）。その塁へ帰れる走者がいなければ何もしない。無入力なら直近に
      // 仕掛けた走者。すでに次の塁を踏んだ走者は候補に入らない（＝戻れない）。
      const { x, y } = offensePad.direction();
      const chosen = recallTargetBase(recallableBases(), baseFromPadDirection(x, y));
      if (chosen === null) return;
      // バイクで行き過ぎた走者は、起点ではなく**踏んだ塁**へ戻る（フェーズF-26-3）。
      // 同じ塁に通常の帰塁候補と並んだ場合はこちらを優先する＝いま刺されうるほうを救う。
      const overrun = overrunRunners().find((v) => v.forced!.to === chosen);
      if (overrun) {
        startOverrunReturn(overrun);
        return;
      }
      startRunnerReturn(chosen);
    },

    dropkick() {
      if (phase === null || phase === 'resolved') return;
      // 蹴るのは攻撃側の操作。**攻撃側が人間でなければ受け付けない**（CPU走者の蹴りは
      // `updateCpuDropkick` の担当）。フェーズD-20でこの条件を「守備が人間なら受け付けない」
      // から直した：2P PLAY では守備も人間なので、そのままだと攻撃側のGが死んでいた
      // （呼び出し側の main.ts が、Gを押したのが攻撃側のプレイヤーかを既に見ている）。
      if (!isOffenseHuman()) return;
      performDropkick();
    },

    catchEffect() {
      // 切るのは守備側の操作（CPU守備の判断は下の `flying` ブロックが担当）。
      if (!isDefenseHuman()) return;
      const id = catchEffectCandidate();
      if (id !== null) onCatchEffect?.(id);
    },

    catchEffectReady: () => (isDefenseHuman() ? catchEffectCandidate() : null),

    isActive: () => phase !== null,

    runnersOnField() {
      return runnerVisuals
        .filter((v) => v.mesh.visible && !v.out)
        .map((v) => ({ mesh: v.mesh, id: v.id, running: v.forced !== null && !v.arrived }));
    },

    ballInFlight: () => phase === 'flying' || phase === 'loose',

    landingPoint() {
      if (phase !== 'flying' || !ballState || ballState.landing !== null) return null;
      return predictLanding(ballState);
    },

    cameraFocus() {
      if (phase === null) return null;
      const ballPoint = { x: ball.position.x, z: ball.position.z };
      // 打球のプレーはボールが主役なので、ボールそのものを追う（原作のスクロール）。
      if (playKind === 'batted') return ballPoint;
      // 走塁だけのプレー（けん制・盗塁）はボールが投手/捕手の手元からほとんど動かないので、
      // ボールだけを追うと**勝負している走者が画面の外で決着してしまう**。ボールと走者の
      // 中点を見ることで、送球の出どころ（投手・捕手）と走者の両方が画面に残る。
      const targets = taggableRunners();
      if (targets.length === 0) return ballPoint;
      const cx = targets.reduce((sum, v) => sum + v.pos.x, 0) / targets.length;
      const cz = targets.reduce((sum, v) => sum + v.pos.z, 0) / targets.length;
      return { x: (ballPoint.x + cx) / 2, z: (ballPoint.z + cz) / 2 };
    },

    markedRunners() {
      if (phase === null) return [];
      // 印を出すのは**まだ刺されうる走者だけ**（塁間を走っている走者＋けん制モードで
      // 塁を離れている走者）。アウトになった走者・塁に到達して安全になった走者は
      // もう送球先の判断に関係しないので出さない＝画面が印だらけにならない。
      // これは「ランダンプレイでタッチできる走者」（taggableRunners）と同じ集合になる。
      return taggableRunners().map((v) => ({ ...v.pos }));
    },
  };
}
