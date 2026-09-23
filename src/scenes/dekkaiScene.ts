/**
 * でっかいモード：捕手やや後方・やや上から投手方向を見るクローズアップ視点
 * （原作ファミスタ準拠。実機テストプレイのフィードバックにより、当初CLAUDE.mdで
 * 想定していた「投手後方から捕手・打者を見る」向きから反転した。詳細はPROGRESS.md
 * 「実装メモ」参照）。カメラが -Z を向くため、画面左右とワールドXの向きは一致する
 * （反転不要。かつてのカメラは+Z向きで反転が必要だった。詳細は下記 worldSteerX ）。
 * 投球コントローラー（プレート移動→ワインドアップ→飛行操作→捕球/死球）と
 * 打撃コントローラー（スイング→接触判定→打球生成）もここが持つ。
 */
import * as THREE from 'three';
import {
  type BatterSide,
  type PitchArm,
  type PitchCall,
  type PitchFlight,
  type PitchProfile,
  BATTER_STANCE_MOVE_SPEED,
  CATCH_Z,
  NEUTRAL_RATING,
  PLATE_Z,
  RELEASE_Z,
  RIGHT_BATTER_SIDE,
  NEUTRAL_PITCH_ARM,
  RUBBER_MOVE_SPEED,
  SPEED_NEUTRAL,
  armReleaseHeight,
  armReleaseOffsetX,
  batterStandX,
  clampRubberX,
  clampStance,
  courseReleaseVxFor,
  createPitchFlight,
  judgePitch,
  neutralSpeedFor,
  pitchFastness,
  pitchSlowness,
  plateCrossingX,
  releaseXFor,
  speedForPitchSelection,
  steerAccelForSelection,
  stepPitchFlight,
} from '../core/pitch';
import {
  type BattedBall,
  type BattingProfile,
  SWING_ACTIVE_SEC,
  SWING_STARTUP_SEC,
  contactPlaneCrossing,
  createBattedBall,
  judgeBunt,
  judgeSwing,
} from '../core/batting';
import {
  type GunShotResult,
  GUN_AIM_INITIAL_X,
  clampAimX,
  judgeShot,
  stepAimX,
} from '../core/gun';
import {
  type CpuPitchPlan,
  type CpuPitchShape,
  chooseCpuPitchPlan,
  cpuPitcherStyle,
  cpuSteerAccelAt,
  planCpuPitchShape,
  shouldCpuPickoff,
} from '../core/cpuPitcher';
import {
  PITCH_RELEASE_T,
  attachBat,
  attachGun,
  movePlayerTo,
  setPlayerFacing,
  setPlayerPose,
} from '../entities/player';
import { createProp, gunMuzzleOf } from '../entities/props';
import {
  DEKKAI_CAMERA_LOOK_AT,
  DEKKAI_CAMERA_POS,
  DEKKAI_FOV_DEG,
  dekkaiBallLook,
  pitchArcPath,
} from '../core/camera';
import type { Bases, Count } from '../core/rules';
import { CPU_PITCH_INTERVAL_SEC, PITCH_SETTLE_SEC } from '../core/tempo';
import type { VirtualPad } from '../input/keyboard';

/**
 * でっかいモードのカメラが描く最も遠い距離 m。**背景（フェーズE-25-(d) の2段目）の
 * 大きさの上限**でもあるので定数として出してある：空のドームや遠景の地面がこれを超えると
 * 手前で切れて背景色が覗く（`core/horizon.ts` と `tests/horizon.test.ts` が参照する）。
 */
export const DEKKAI_CAMERA_FAR = 500;

export function createDekkaiCamera(aspect: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(DEKKAI_FOV_DEG, aspect, 0.1, DEKKAI_CAMERA_FAR);
  // 本塁（捕手）のやや後方・頭上から投手方向（-Z）を見る。**置き場所は core/camera.ts**
  // （フェーズNN-61）＝ボールの見かけの大きさがカメラからの距離で決まるので、
  // テストと `npm run balance:ball` が同じ値を読める場所に置いてある。
  camera.position.set(DEKKAI_CAMERA_POS.x, DEKKAI_CAMERA_POS.y, DEKKAI_CAMERA_POS.z);
  camera.lookAt(DEKKAI_CAMERA_LOOK_AT.x, DEKKAI_CAMERA_LOOK_AT.y, DEKKAI_CAMERA_LOOK_AT.z);
  return camera;
}

export type PitchPhase = 'ready' | 'windup' | 'flight' | 'settle';

const WINDUP_SEC = 0.35;
/**
 * リリース後にフォロースルーを取り切るまでの時間（フェーズE-25-(c)。**見た目だけ**）。
 * 球の飛行・判定はこの値を一切見ないので、長くしても投球そのものは変わらない。
 */
const PITCH_FOLLOW_SEC = 0.3;
/** タブ非アクティブ復帰などで dt が跳ねたときの暴走防止 */
const MAX_DT = 0.1;
/**
 * 緩急を見た目で伝える視覚演出（高低はゾーン判定に無関係・原作準拠）。
 * 遅い球（＝上入力で選ぶフォーク/チェンジアップ）は弧を描いて手元で落ち、
 * 速球は進行方向に残像を引く。**式と値は `core/camera.ts` に集約してある**
 * （フェーズPP-63。`pitchArcPath` / `dekkaiBallLook`）＝「球がどう見えるか」の
 * 調整先を散らさない（NN-61の見かけの大きさ・LL-59の選手の縮尺と同じ場所）。
 *
 * ここに残るのは残像の向きを three へ渡すための作業用ベクトルだけ。伸ばす向きは
 * 毎フレーム変わる（＝画面上の進行方向）ので、球のローカル+Zをその向きへ合わせてから
 * そのローカル軸だけを伸ばす。毎フレーム new しないよう使い回す。
 */
const TRAIL_FROM = new THREE.Vector3(0, 0, 1);
const TRAIL_AXIS = new THREE.Vector3();


/**
 * 投球の判定に効く投手の能力値。**定義は `core/pitch.ts` にある**
 * （フェーズP-37でCPUの投球も同じ能力値を読むようになったため、判定側の層へ移した）。
 * ここでは既存の import 経路を保つために型だけ通す。
 */
export type { PitchProfile };

export interface PitchingController {
  /** Aボタン押下で呼ぶ。ready のときだけ投球動作を開始する */
  startPitch(): boolean;
  /**
   * 毎フレーム呼ぶ。controlActive が false の間は投球操作（投球前のプレート移動・
   * 飛行中の変化球）を受け付けない。ボールの飛行と判定は状態にかかわらず進む
   * （盗塁でちっちゃいモードへ移っても、その球はカウントとして決着する）。
   */
  update(dt: number, controlActive: boolean): void;
  /** ワインドアップ〜捕球までの間 true（この間は銃モード切替なども抑止する） */
  isBusy(): boolean;
  /** ワインドアップ〜飛行中（スイングを受け付ける区間）の間 true */
  isPitchLive(): boolean;
  /**
   * この球が捕手のミット（CATCH_Z）へ届くまでの残り時間（秒）。isPitchLive() の間だけ
   * 意味を持つ（それ以外は0）。盗塁（説明書p13）の判定に使う：仕掛けた瞬間のこの値が
   * そのまま「捕手がいつ投げられるか」＝走者の持ち時間になる（core/fielding.ts の
   * stealSafeJumpSec 参照）。
   *
   * ワインドアップ中はまだリリースしていないので「残りモーション＋飛行時間」を返す。
   * 飛行時間の球速は release() と同じ決め方（人間＝事前選択、CPU＝方針）で求めるので、
   * 遅い球を選んでいれば残り時間も長い＝そのぶん盗塁しやすい（実際の野球と同じ）。
   */
  timeToCatcher(): number;
  /**
   * ボールメッシュの表示・位置更新を手放す（盗塁でちっちゃいモードへ切り替わったとき）。
   * 投球自体は判定まで進み続ける（カウントは進む）が、画面のボールはちっちゃいモード側が
   * 使うため、こちらは触らなくなる。次の startPitch() で自動的に元へ戻る。
   */
  detachBall(): void;
  /**
   * スイング接触時に呼ぶ。判定なしで投球を打ち切る
   * （ボールメッシュは非表示にせず、打球側＝フィールドプレーが引き継ぐ）。
   */
  abortFlight(): void;
}

export function createPitchingController(opts: {
  pitcher: THREE.Group;
  ball: THREE.Mesh;
  pad: VirtualPad;
  onJudged: (call: PitchCall) => void;
  /**
   * リリースの瞬間に一度だけ呼ぶ（フェーズB-11のスタミナ消耗＝**1リリース1球**）。
   * 判定（onJudged）ではなくここで数えるのは、**打たれた球は判定を経ずに打球のプレーへ
   * 移る**ため（onJudged で数えると打たれた球だけ投球数に入らない）。けん制球・銃は
   * この経路を通らないので自動的に除外される（実際の野球でも投球数に数えない）。
   */
  onRelease?: () => void;
  /** 飛行1ステップごとの通知（スイング接触判定用）。中で abortFlight を呼んでよい */
  onFlightStep?: (prev: PitchFlight, next: PitchFlight, dt: number) => void;
  /**
   * 2P/CPU操作分離（セッション9・でっかいモード拡張）：true の間、リリース球速は
   * pad ではなく cpuReleaseSpeed から取り、飛行中の左右ステアは行わない。ready
   * フェーズの移動は既存の controlActive（update第2引数）で人間専用のまま制御する
   * （CPU側はリリース位置をシーン層のCPU投手コントローラーが直接セットするため、
   * ここでの移動は不要）。
   */
  isCpuTurn?: () => boolean;
  /** isCpuTurn が true のとき、リリース時に一度だけ呼ばれる球速の供給元 */
  cpuReleaseSpeed?: () => number;
  /**
   * isCpuTurn が true のとき、飛行中の毎フレームの曲がりの供給元（フェーズP-37）。
   * 引数はこのステップが覆う区間（リリースからの経過, 長さ）で、CPU投手コントローラーが
   * **投げる前に解いた形**（`planCpuPitchShape`）から答えるだけ＝ここでは判断しない。
   * 省略時は従来どおりCPUの球は曲がらない。
   */
  cpuBreak?: (sinceRelease: number, dt: number) => { steerX: -1 | 0 | 1; accel: number };
  /**
   * 今マウンドにいる投手の能力値（フェーズB-8）。人間が投げるときの球速と変化量に効く
   * （CPUの球速は cpuReleaseSpeed 側で同じ能力値から決まる）。継投で変わるので毎回問い合わせる。
   * 省略時は基準値＝能力値を持ち込む前とまったく同じ球になる。
   */
  pitcherProfile?: () => PitchProfile;
  /**
   * 今打席に立っている打者の左右（BOX。フェーズB-9）。死球ゾーンの位置に効く
   * ＝**左打者には反対側へ曲げないと当たらない**。打者は毎打席・代打で変わるので
   * 判定のたびに問い合わせる。省略時は右打者固定（従来と同じ）。
   */
  batterSide?: () => BatterSide;
  /**
   * 今の打者の打席内の立ち位置（フェーズO-36。`BattingController.stanceOffset`）。
   * **死球ゾーンが打者と一緒に動く**＝踏み込んでいる打者には内角のボール球が当たる。
   * 省略時は 0＝打席中央＝従来と同じ。
   */
  batterStance?: () => number;
  /**
   * **人間が投げるときのコース入力の効き幅**（フェーズW-44。`courseReleaseVxFor` の引数）。
   * 制球スキルの上乗せ（名鑑のERAからの差）と疲労を渡す＝**どちらも無ければ従来と
   * 完全に同じ 0.9**。CPUの球はリリース位置そのもので狙う（初期横速度は常に0）ので
   * 関係しない＝CPU側の制球は `createCpuPitcherController` の `pitcherControl` が受け持つ。
   */
  pitcherCourse?: () => { controlBonus: number; fatigue: number };
  /**
   * 今マウンドにいる投手の投球腕（説明書のARM。フェーズCC-50）。
   * **投げる腕の見た目**と**ボールが出るX**（プレート上の立ち位置＋腕のずれ）の
   * 両方がここから決まる。継投で変わるので毎回問い合わせる。
   * 省略時は右のオーバースロー（`NEUTRAL_PITCH_ARM`）。
   */
  pitcherArm?: () => PitchArm;
}): PitchingController {
  const {
    pitcher,
    ball,
    pad,
    onJudged,
    onRelease,
    onFlightStep,
    isCpuTurn,
    cpuReleaseSpeed,
    cpuBreak,
    pitcherProfile,
    batterSide,
    batterStance,
    pitcherCourse,
    pitcherArm,
  } = opts;

  /** いまマウンドにいる投手の腕（説明書のARM。フェーズCC-50） */
  function arm(): PitchArm {
    return pitcherArm?.() ?? NEUTRAL_PITCH_ARM;
  }

  let phase: PitchPhase = 'ready';
  let timer = 0;
  let flight: PitchFlight | null = null;
  let call: PitchCall | null = null;
  /**
   * ワインドアップ中に上下入力で事前選択された球速（原作準拠：説明書p19②。
   * 上=フォーク/チェンジアップ、下=速球）。ワインドアップ中の最後の非ゼロ入力を
   * 記憶する（リリースの瞬間だけ押している必要はなく、モーション中のどこかで
   * 押せば効く＝短押しでも取りこぼさない）。
   */
  let speedSelection: -1 | 0 | 1 = 0;
  /**
   * 盗塁（説明書p13）でちっちゃいモードへ切り替わり、ボールメッシュの担当を
   * フィールドプレー側へ渡した状態。投球の物理・判定は従来どおり進める。
   */
  let ballDetached = false;
  /** リリースからの経過（フォロースルーの進行。フェーズE-25-(c)。見た目だけに使う） */
  let sinceRelease = 0;

  /** カメラが -Z を向くため、画面上の左右入力はワールドXと同じ向き（反転不要） */
  function worldSteerX(): -1 | 0 | 1 {
    return pad.direction().x as -1 | 0 | 1;
  }

  /**
   * リリース時に確定する球速（人間＝ワインドアップ中の事前選択／CPU＝方針）。
   * どちらの経路でも投手の球速（SPD）が基準速を上下させる。
   */
  function resolvedReleaseSpeed(): number {
    return isCpuTurn?.()
      ? (cpuReleaseSpeed?.() ?? SPEED_NEUTRAL)
      : speedForPitchSelection(speedSelection, pitcherProfile?.().speed);
  }

  function syncBallMesh(f: PitchFlight): void {
    if (ballDetached) return;
    // **中心はその投手の基準速**（`neutralSpeedFor`）から取る（フェーズO-35で気づいて直した）。
    // 従来はグローバルな `SPEED_NEUTRAL` を中心にしていたので、**速球派の投手のフォークは
    // 「あまり遅くない球」として浅くしか沈まず**、軟投派の速球は伸びなかった。
    const neutral = neutralSpeedFor(pitcherProfile?.().speed);
    // **球はその投手の腕の先から出て、ミットへ落ちる**（MM-60＋フェーズPP-63）。
    // 弧は `core/camera.ts` の `pitchArcPath`＝**リリースの高さからミットの高さへ重力で
    // 落ちる放物線**で、大きさは飛行時間（＝球速）だけで決まる。基準速以上の球は弧なし
    // ＝PP-63の前と完全に同じ直線。高低はゾーン判定に無関係（説明書p19準拠）なので
    // **ここから下はすべて見た目だけ**（NN-61が置いていた地面の下限は、弧が必ずミットの
    // 高さで終わるので構造的に不要になった）。
    const path = pitchArcPath(f.z, f.vz, armReleaseHeight(arm()), pitchSlowness(f.vz, neutral));
    // **画面上の大きさの距離補正（NN-61）と残像（PP-63）を1か所で組む**。残像は画面上の
    // 進行方向へ伸ばす（旧実装はワールドZ＝視線に沿っていたので画面にほぼ出なかった）ので、
    // 弧の傾きから縦の速度を作って渡す＝**弧と残像が同じ1つの式から出る**。
    const look = dekkaiBallLook(
      { x: f.x, y: path.y, z: f.z },
      { x: f.vx, y: path.slope * f.vz, z: f.vz },
      pitchFastness(f.vz, neutral),
    );
    ball.position.set(look.center.x, look.center.y, look.center.z);
    if (look.axis) {
      // 伸ばす向きへローカル+Zを合わせてから、その軸だけ伸ばす（球なので他の軸は等倍）
      TRAIL_AXIS.set(look.axis.x, look.axis.y, look.axis.z);
      ball.quaternion.setFromUnitVectors(TRAIL_FROM, TRAIL_AXIS);
    } else {
      ball.quaternion.identity();
    }
    ball.scale.set(look.scale, look.scale, look.scale * (1 + look.trail));
  }

  /**
   * 投球モーションの見た目（フェーズE-25-(c)）。**投球の進行そのものから毎フレーム
   * 導出する**ので、モーションと球が食い違わない（振りかぶり中は必ず振りかぶって
   * いるし、リリースの瞬間に必ず腕が出る）。判定側の値は一切見ない。
   */
  function syncPitcherPose(): void {
    if (phase === 'ready') {
      setPlayerPose(pitcher, { kind: 'idle' });
      return;
    }
    if (phase === 'windup') {
      const w = 1 - Math.max(timer, 0) / WINDUP_SEC;
      setPlayerPose(pitcher, { kind: 'pitch', t: PITCH_RELEASE_T * w, arm: arm() });
      return;
    }
    // リリース後（飛行中・捕球後の間）はフォロースルーを取り切ってその姿勢で止まる
    const f = Math.min(1, sinceRelease / PITCH_FOLLOW_SEC);
    setPlayerPose(pitcher, {
      kind: 'pitch',
      t: PITCH_RELEASE_T + (1 - PITCH_RELEASE_T) * f,
      arm: arm(),
    });
  }

  function release(): void {
    phase = 'flight';
    // 球速：人間はワインドアップ中の上下事前選択、CPUは方針（plan）から。
    // コース：人間は「投げる瞬間」の左右入力を初期横速度に変換（説明書p19③）。
    // CPUはリリース位置そのもので狙うため初期横速度は常に0（cpuPitcher.ts参照）。
    const cpu = isCpuTurn?.() ?? false;
    const speed = resolvedReleaseSpeed();
    // 効き幅は制球（W-44）で増減する。**向きは入力どおりのまま**で、掛ける量だけが動く。
    const course = pitcherCourse?.();
    const releaseVx =
      cpu ? 0 : worldSteerX() * courseReleaseVxFor(course?.controlBonus, course?.fatigue);
    // **ボールは体の中心ではなく腕の先から出る**（フェーズCC-50）。投手の位置は
    // 人間なら十字キーで動かしたプレート上の立ち位置、CPUなら `shape.plateX`（逆算で
    // 解いた立ち位置）なので、どちらの経路でも `plateX + 腕のずれ` の1本で済む。
    flight = createPitchFlight(releaseXFor(pitcher.position.x, armReleaseOffsetX(arm())), speed, releaseVx);
    call = null;
    // ここからフォロースルー（見た目だけ。フェーズE-25-(c)）
    sinceRelease = 0;
    if (!ballDetached) ball.visible = true;
    syncBallMesh(flight);
    // 投球数の記録は最後に。先に呼ぶと**この球自身が消耗の分を先取りしてしまう**
    // （投げた瞬間に自分の球速が落ちる）。1球目は必ず無傷の能力値で投げられる。
    onRelease?.();
  }

  function finishPitch(judged: PitchCall): void {
    phase = 'settle';
    // 捕球後の「間」（フェーズE-23）。この間に1球ごとの判定コールを見せる
    timer = PITCH_SETTLE_SEC;
    flight = null;
    // 盗塁中はボールをちっちゃいモード側が使っている（走者を刺す送球）ので触らない
    if (!ballDetached) ball.visible = false;
    // 投げ終わりの姿勢（フォロースルー）はそのまま。次の startPitch で構えへ戻る
    onJudged(judged);
  }

  return {
    startPitch() {
      if (phase !== 'ready') return false;
      phase = 'windup';
      timer = WINDUP_SEC;
      speedSelection = 0;
      ballDetached = false;
      return true;
    },

    update(dt, controlActive) {
      const d = Math.min(dt, MAX_DT);
      if (phase !== 'ready' && phase !== 'windup') sinceRelease += d;
      switch (phase) {
        case 'ready': {
          if (!controlActive) break;
          // 投球前：プレート上を左右移動してコース（リリース位置）を決める。
          // 位置は movePlayerTo 経由で書く（フェーズE-25-(c)）。投手は向きも歩調も
          // 使わない（本塁を向いたまま構える）が、位置の書き込み口を1本にしておかないと
          // 「最後に置いた位置」がずれて、後から歩きを載せたときに嘘の移動量になる。
          movePlayerTo(
            pitcher,
            clampRubberX(pitcher.position.x + worldSteerX() * RUBBER_MOVE_SPEED * d),
            pitcher.position.y,
            pitcher.position.z,
            { turn: false, pose: false },
          );
          break;
        }
        case 'windup': {
          timer -= d;
          // モーション中の上下入力で球速を事前選択（原作準拠：説明書p19②）。
          // CPUの球速は plan から取るため、人間のターンだけサンプリングする。
          if (!isCpuTurn?.()) {
            const y = pad.direction().y;
            if (y !== 0) speedSelection = y;
          }
          if (timer <= 0) release();
          break;
        }
        case 'flight': {
          const prev = flight!;
          // リリース後の操作は左右（カーブ/シュート）のみ。上下は効かない（原作準拠）。
          // controlActive が落ちている間（＝盗塁でちっちゃいモードへ移った後）も曲げない：
          // 十字キーは塁の指定に使われているので、そのまま拾うと意図しない変化球になる
          // （最悪、打者側へ曲がって死球になる）。
          //
          // **CPUのときは飛行中に判断せず、投げる前に解いた形をなぞるだけ**（フェーズP-37。
          // このステップが覆う区間は [sinceRelease − d, sinceRelease]＝上で先に進めてある）。
          const cpuTurn = isCpuTurn?.() ?? false;
          const cpuSteer = cpuTurn ? cpuBreak?.(sinceRelease - d, d) : undefined;
          const steerX = cpuSteer ? cpuSteer.steerX : cpuTurn || !controlActive ? 0 : worldSteerX();
          // 曲がりの強さは投手の変化量（説明書のR/L/F）から。曲げる向きで別々の値を使う
          // ＝「カーブは大きいがシュートは小さい」といった持ち味が出る。
          // steerX===0 のときは横加速そのものが0なので、どちらを渡しても結果は同じ。
          //
          // **フォーク（上入力で選んだ遅い球）だけは F を使う**（フェーズO-35）。
          // 緩急の選択はリリース時に確定済みなので、飛行中に変わることはない。
          // CPU側も同じ `steerAccelForSelection` を通った値が cpuBreak から来る。
          const profile = pitcherProfile?.();
          const breakAmount =
            steerX < 0 ? (profile?.breakLeft ?? NEUTRAL_RATING) : (profile?.breakRight ?? NEUTRAL_RATING);
          const accel = cpuSteer
            ? cpuSteer.accel
            : steerAccelForSelection(speedSelection, breakAmount, profile?.fork);
          const next = stepPitchFlight(prev, steerX, d, accel);
          // スイング接触はコース判定より先（打った球はストライク/死球にならない）
          onFlightStep?.(prev, next, d);
          if (phase !== 'flight') break; // 接触で abortFlight された
          const crossX = plateCrossingX(prev, next);
          if (crossX !== null) {
            call = judgePitch(
              crossX,
              batterSide?.() ?? RIGHT_BATTER_SIDE,
              batterStance?.() ?? 0,
            );
          }
          if (call === 'hitByPitch') {
            // 打者に当たった球は捕手まで飛ばさない
            finishPitch('hitByPitch');
            break;
          }
          flight = next;
          syncBallMesh(next);
          if (next.z >= CATCH_Z) {
            // リリース点は本塁より手前なので、捕球時には必ず判定済み
            finishPitch(call!);
          }
          break;
        }
        case 'settle': {
          timer -= d;
          if (timer <= 0) phase = 'ready';
          break;
        }
      }
      // 姿勢は「投球がいまどこまで進んだか」から毎フレーム導出する（フェーズE-25-(c)）
      syncPitcherPose();
    },

    isBusy: () => phase !== 'ready',

    isPitchLive: () => phase === 'windup' || phase === 'flight',

    timeToCatcher() {
      if (phase === 'windup') {
        // まだリリースしていないので、残りモーション＋リリース点から捕手までの飛行時間。
        return Math.max(timer, 0) + (CATCH_Z - RELEASE_Z) / resolvedReleaseSpeed();
      }
      if (phase === 'flight' && flight) return Math.max(0, (CATCH_Z - flight.z) / flight.vz);
      return 0;
    },

    detachBall() {
      ballDetached = true;
    },

    abortFlight() {
      phase = 'ready';
      flight = null;
      call = null;
      setPlayerPose(pitcher, { kind: 'idle' });
    },
  };
}

// ---- CPU投球AI（でっかいモードの2P/CPU操作分離、セッション9） ----

/**
 * CPUがけん制へ入るまでの「間」（説明書p24）。ready に入った瞬間に画面が切り替わると
 * 何が起きたのか分からないため、投球の「間」より短くしつつタメを置く。
 */
const CPU_PICKOFF_THINK_SEC = 0.35;

export interface CpuPitcherController {
  /**
   * ready フェーズ（!pitching.isBusy()）の間、毎フレーム呼ぶ。まだ狙いを決めていなければ
   * このフレームで決めてプレート位置に直接反映し、「間」のタイマーを消化する。
   * true を返したら呼び出し側は pitching.startPitch() を呼ぶ。
   */
  updateReady(dt: number, count: Count): boolean;
  /**
   * けん制（説明書p24）の判断。ready フェーズで updateReady より**先に**毎フレーム呼ぶ。
   * 走者がいて、この打席でまだけん制していなければ、短い「間」を置いて true を返す
   * （呼び出し側はけん制モードへ入る）。true を返した後は usedThisPlateAppearance を
   * 立てて呼ぶことで、同じ打席で繰り返しけん制しない。
   */
  tryPickoff(
    dt: number,
    bases: Bases,
    usedThisPlateAppearance: boolean,
    /** 塁ごとの持ち越したリード m（フェーズJJ-57。0＝塁についたまま＝けん制しない） */
    leads?: Partial<Record<'first' | 'second' | 'third', number>>,
  ): boolean;
  /** createPitchingController の cpuReleaseSpeed にそのまま渡す（リリース球速） */
  releaseSpeed(): number;
  /**
   * createPitchingController の cpuBreak にそのまま渡す（フェーズP-37）。
   * 投げる前に解いた形（`planCpuPitchShape`）を読み出すだけで、ここでは何も判断しない。
   */
  breakAt(sinceRelease: number, dt: number): { steerX: -1 | 0 | 1; accel: number };
  /**
   * 1球が終わるたび（判定確定 or 打者接触によるabortFlight）に呼び、次の球のために
   * 狙いをリセットする。呼び忘れると次の ready フェーズで前の球の狙いを使い回してしまう。
   */
  reset(): void;
}

/**
 * 狙うコースと球速を決め、**そこへ届くリリース位置を逆算して**、そこから腕のぶん
 * 戻した**立ち位置**（`shape.plateX`。フェーズCC-50）を pitcher.position.x に直接
 * 反映する（cpuPitcher.ts のモジュールコメント参照）。飛行中の曲がりも投げる前に
 * 解き切ってあるので、このコントローラーは飛行中いっさい判断しない
 * （＝フィードバック制御を持たない＝振動しようがない）。
 */
export function createCpuPitcherController(
  pitcher: THREE.Group,
  opts: {
    /**
     * 今マウンドにいるCPU投手の能力値（フェーズB-8／P-37／S-40）。人間が投げるときと
     * **同じ関数**（`speedForPitchSelection`・`steerAccelForSelection`）に通るので、
     * 球速も変化量も攻守どちらの側でも同じように効く。疲労は呼び出し側で織り込み済み。
     * S-40からは**持ち味（`cpuPitcherStyle`）の出どころ**でもある＝疲れて変化量が
     * 落ちた技巧派は、決め球のフォークも痩せる。
     */
    pitcherProfile?: () => PitchProfile;
    /**
     * 今マウンドにいるCPU投手の制球 0..1（フェーズT-41。`roster.ts` の `pitcherControl`）。
     * **`PitchProfile` とは別に受け取る**のは、制球が効くのが「球の形」ではなく
     * **狙う位置**だけで、しかも**CPUの投球にしか効かない**（ユーザー判断）ため
     * ＝人間の投球が通る経路（`pitcherProfile`）に混ぜない。
     * 省略時は基準値＝T-41の前とまったく同じ狙い。
     */
    pitcherControl?: () => number;
    /**
     * 今マウンドにいるCPU投手の投球腕（フェーズCC-50）。**逆算の窓が腕のぶんずれる**
     * ＝腕の側の隅へは楽に、逆側へは狭く曲げられる。省略時は右のオーバースロー。
     */
    pitcherArm?: () => PitchArm;
    /**
     * この打席でファウルにされた球数（フェーズSS-67）。**粘られたら反対の隅へ散らす**
     * ＝ファウルはカウントを動かさないので、これが無いと**まったく同じ球を投げ続ける**
     * （判定は決定的なので同じ結果＝ファウルが永久に繰り返され、打席が終わらない）。
     * 省略時は 0＝SS-67の前とまったく同じ配球。
     */
    foulsInAtBat?: () => number;
  } = {},
): CpuPitcherController {
  const { pitcherProfile, pitcherControl, pitcherArm, foulsInAtBat } = opts;
  let plan: CpuPitchPlan | null = null;
  /** その球の形（リリース位置・曲げ方）。plan と同時に解いて1球のあいだ使い回す */
  let shape: CpuPitchShape | null = null;
  let timer = 0;
  /** けん制の「間」の計時。1球ごとに reset() で仕切り直す */
  let pickoffTimer = 0;

  return {
    updateReady(dt, count) {
      if (!plan) {
        const profile = pitcherProfile?.();
        // 決め球（追い込んだ1球）だけは投手の持ち味で決まる（フェーズS-40）。
        // 狙いがゾーンの縁からどれだけ外れるかは制球で決まる（フェーズT-41）。
        // どちらも能力値からの導出なので、ここで別に状態を持つことはない。
        plan = chooseCpuPitchPlan(
          count,
          cpuPitcherStyle(profile),
          pitcherControl?.(),
          foulsInAtBat?.() ?? 0,
        );
        // 曲がりを織り込んだリリース位置をここで解く。以後この球の間は解き直さない
        // （＝球速も曲がりも「投げると決めた瞬間の能力値」で一貫する）。
        shape = planCpuPitchShape(
          plan,
          profile,
          undefined,
          armReleaseOffsetX(pitcherArm?.() ?? NEUTRAL_PITCH_ARM),
        );
        // CPUは狙いを決めた位置へ一度で移る（＝歩いて動いたのではない）ので snap。
        // **置くのは体（`plateX`）**で、ボールはそこから腕のぶん外れた `releaseX` から出る
        // （フェーズCC-50。投球側の `release()` が同じ式で解き直す）。
        movePlayerTo(
          pitcher,
          shape.plateX,
          pitcher.position.y,
          pitcher.position.z,
          { snap: true, pose: false },
        );
        // 投球間隔の「間」（フェーズE-23。core/tempo.ts に集約）
        timer = CPU_PITCH_INTERVAL_SEC;
      }
      timer -= Math.min(dt, MAX_DT);
      return timer <= 0;
    },

    tryPickoff(dt, bases, usedThisPlateAppearance, leads) {
      if (!shouldCpuPickoff(bases, usedThisPlateAppearance, leads)) return false;
      pickoffTimer += Math.min(dt, MAX_DT);
      if (pickoffTimer < CPU_PICKOFF_THINK_SEC) return false;
      // 消化した「間」はここで使い切る。次にけん制できる状況になったとき（次の打席）に
      // 前回の残りで即座に発火してしまい、画面が前触れなく切り替わるのを防ぐ。
      pickoffTimer = 0;
      return true;
    },

    releaseSpeed() {
      // **形を解くのに使った球速をそのまま返す**（フェーズP-37）。ここで球速を計算し直すと、
      // 逆算に使った飛行時間と実際の飛行時間が食い違い、狙ったコースからずれる。
      return shape ? shape.speed : SPEED_NEUTRAL;
    },

    breakAt(sinceRelease, dt) {
      if (!shape) return { steerX: 0, accel: 0 };
      return { steerX: shape.steerX, accel: cpuSteerAccelAt(shape, sinceRelease, dt) };
    },

    reset() {
      plan = null;
      shape = null;
      pickoffTimer = 0;
    },
  };
}

// ---- 打撃 ----

/** バットを振り抜くまでの時間（接触ウィンドウの終端と一致させる） */
const SWING_SWEEP_SEC = SWING_STARTUP_SEC + SWING_ACTIVE_SEC;
/** 振り抜き後、構えに戻るまでの時間 */
const SWING_RECOVER_SEC = 0.24;
const SWING_TOTAL_SEC = SWING_SWEEP_SEC + SWING_RECOVER_SEC;
/**
 * 構えのヨー角と、フルスイングまでの回転量（プレースホルダー人形の簡易モーション）。
 * いずれも**右打者基準**で、左打者は打者ローカルの鏡像＝ヨー角の符号を反転して使う
 * （applyStance 参照）。
 */
const STANCE_YAW = 0.6;
/**
 * スイングで体が回る角度。**フェーズRR-66で 2.4→1.6**：実機で計測したところ、
 * **バット先端が本塁の上を通るのが t=0.067秒**なのに対し、**判定が芯と言うのは
 * t=0.090秒**（`SWING_IDEAL_SEC`）で、**当たった瞬間に止まる画面（ヒットストップ）では
 * バットがもう振り抜かれた後**になっていた。回る速さを落とすと通過が 0.089秒＝
 * **判定の芯とそろう**（実測）。振り抜きそのものは腕の伸び（`applySwing`）が担う。
 */
const SWING_YAW_RANGE = 1.6;
/** バントの姿勢（バットを投手方向へ出して止めた角度。振り抜かないので固定） */
const BUNT_YAW = -0.35;
/**
 * バットの長さ（握りから先端まで。バットは手のノードの子＝握りが原点）。
 *
 * **フェーズRR-66で 1.1→1.6**（テストプレイの「絶対バットが当たっていない場面でも
 * 当たる」）。実機で先端の軌跡を測ると、**バットは本塁（x=0）にすら届いていなかった**
 * （先端の最大 -0.32m）＝**ストライクゾーンの球でさえ、描かれたバットは通っていない**。
 * 判定側の到達範囲（`BAT_REACH_OUTSIDE_X`＝打者ローカル -0.75）は**実際の野球の
 * 手の届く範囲とほぼ同じ**で正しく、**ずれていたのは見た目のほう**だった
 * （このゲームは判定の横寸法が実物の約2倍＝OO-62が球の大きさで確かめた比と同じ）。
 * 1.6m は**先端が判定の限界（ワールド +0.76m）にちょうど届く**長さ（実機で計測）。
 */
const BAT_LENGTH = 1.1;
/**
 * 打者の仕切り直し（フェーズE-23）：次の打者が打席へ歩いて入ってくる開始位置。
 * 打席の外側（自分の打席と同じ側＝ベンチのある方向）から入る。
 */
const ENTRANCE_OFFSET_X = 5;
const ENTRANCE_OFFSET_Z = 2;
/**
 * 入場のうち「打席が空のまま」の割合。前の打者が引いてから次の打者が現れるまでの一拍で、
 * これが無いと打席が途切れず「同じ打者が横に動いただけ」に見える。
 */
const ENTRANCE_DELAY_RATIO = 0.35;
/**
 * ゼッコーチョーの打者がバットを回す速さ rad/秒（フェーズD-19。説明書p16
 * 「バットをクルクル回している打者＝その試合の絶好調選手」）。
 *
 * **原作の見せ方をそのまま踏襲する**：好調は打球の質にしか出ない（AV/HRへの補正）ので、
 * 投げる側にとっては**投げる前に読み取れる唯一の手がかり**がこの回転になる
 * （HUDの打者カードにも出すが、球を待つ間に見ているのは打者のほう）。
 *
 * 1周1秒弱。速すぎるとブレて何をしているか分からず、遅いと「回っている」と気づかれない。
 */
const HOT_BAT_SPIN_RATE = 7;

export interface BattingController {
  /** Aボタン押下で呼ぶ。1球につき1スイングのみ受け付ける */
  trySwing(): boolean;
  /** PitchingController の onFlightStep に結線する（飛行1ステップごとの接触判定） */
  checkContact(prev: PitchFlight, next: PitchFlight, dt: number): void;
  /** 毎フレーム呼ぶ（スイングモーションの進行） */
  update(dt: number): void;
  /** この球でスイングしたかを読み出してリセットする（空振りストライク判定用） */
  consumeSwung(): boolean;
  /**
   * いまバントの構えを取っているか（フェーズY-46。操作ヒントの出し分けに使う）。
   *
   * **押しバント（十字キー上）が押せる窓そのもの**＝バットを出してから球が来るまでの
   * 間だけ true。ヒットエンドラン（H-28）の窓を `isPitchLive` から出しているのと同じで、
   * **見えている操作と効く操作が同じ1つの状態から出る**（食い違いようがない）。
   */
  isBunting(): boolean;
  /**
   * 打席の左右（BOX）を今の打者に合わせ直す（フェーズB-9）。毎フレームの update でも
   * 追随するが、**打者が変わった瞬間に呼ぶ**ことで1フレームぶんの遅れも無くす
   * （判定側は状態から即座に切り替わるため、呼ばないと「見た目は右打席・死球判定は
   * 左打席」という1フレームが生じる。実機で観測して塞いだ）。
   */
  syncStance(): void;
  /**
   * 今の打席内の立ち位置（打者ローカルXのオフセット。負=プレートに寄る。フェーズO-36）。
   *
   * **真実はこのコントローラーが持ち、他はすべてここから読む**（死球ゾーン＝
   * `judgePitch`／銃の命中ゾーン＝`judgeShot`／CPU投手の狙い＝`batterAimX`）。
   * 見た目の立ち位置も同じ値から書くので、「見えている打者と当たる判定がずれる」ことが
   * 構造的に起きない（B-9で立ち位置と死球ゾーンを同じ定数から求めたのと同じ整理）。
   */
  stanceOffset(): number;
  /**
   * 打者の仕切り直し（フェーズE-23）。打席が切り替わる「間」のあいだ、次の打者が
   * 打席の外から歩いて入ってくる動きを再生する（durationSec は「間」の長さそのもの＝
   * 間が終わったちょうどのタイミングで打席に収まる）。0以下なら何もしない。
   *
   * 立ち位置は打席の左右（syncStance）と同じ計算から求めるので、**入場中のどのフレームでも
   * 見た目の左右と判定の左右は一致する**（フェーズB-9の不変条件を崩さない）。
   */
  startEntrance(durationSec: number): void;
  /**
   * 1球の決着時に呼ぶ。打撃動作を終了して構えへ戻す。
   * バントは「バットを出したまま球を待つ」ためスイングの時間切れで戻らないので、
   * 球を見送った場合の解除はここが担う（呼ばないと次の球へバント姿勢を持ち越す）。
   */
  endPitch(): void;
}

export function createBattingController(opts: {
  batter: THREE.Group;
  onContact: (ball: BattedBall) => void;
  /**
   * Aボタンを押し続けているか（原作準拠：説明書p14「スイングの途中でAボタンを離すと、
   * バントもできます」）。スイング中にこれが false になった時点でバントに切り替わる
   * （＝押しっぱなしがフルスイング、途中で離すとバント）。
   */
  isSwingHeld?: () => boolean;
  /** バントで転がす方向（十字キー左右。-1=三塁側 / 0=正面 / +1=一塁側） */
  buntAimX?: () => -1 | 0 | 1;
  /**
   * 押しバント（十字キー上。フェーズY-46）。押している間だけ強く転がす。
   *
   * **左右（方向）と同じ「接触の瞬間に読む」扱い**にしてある＝バントの構えを取った後でも
   * 球が来るまでに決め直せる（バントは「バットを出したまま球を待つ」動作なので、
   * 構えた瞬間に固定すると読み合いが1回ぶん早く終わってしまう）。
   */
  buntPush?: () => boolean;
  /**
   * 今打席に立っている打者の能力値（フェーズB-8）。打球の初速と、芯を外したときの
   * 減衰の緩和に効く。打者は毎打席・代打で変わるので、接触のたびに問い合わせる。
   * 省略時は基準値＝能力値を持ち込む前とまったく同じ打球になる。
   */
  batterProfile?: () => BattingProfile;
  /**
   * 今打席に立っている打者の左右（BOX。フェーズB-9）。**判定（バットの到達範囲・
   * 引っ張り方向）と見た目（打席の立ち位置・構え）の両方**を鏡像にする。
   * 省略時は右打者固定（従来と同じ）。
   */
  batterSide?: () => BatterSide;
  /**
   * 今マウンドにいる投手の疲労0..1（フェーズB-11）。**球威の低下ぶんが打球初速に
   * 上乗せされる**（疲れた投手からは打球が飛ぶ）。人間/CPUどちらが打者でも同じように
   * 効く。省略時は0＝疲労を持ち込む前とまったく同じ打球。
   */
  pitcherFatigue?: () => number;
  /**
   * 今打席に立っている打者が好調か（ゼッコーチョー／ラッキー7。フェーズD-19）。
   * **見た目だけに効く**（バットをクルクル回す）：打球への効果は能力値レーティングへの
   * 補正として `batterProfile` に織り込まれて来るので、ここで二重に足さない。
   * 省略時は常に平常＝好調を持ち込む前とまったく同じ見た目。
   */
  batterHot?: () => boolean;
  /**
   * 打席内の立ち位置を動かす入力（十字キー左右。-1=画面左 / +1=画面右。フェーズO-36）。
   * **でっかいモードのカメラは -Z を向く**ので画面左右＝ワールドXの向きそのまま
   * （投球前のプレート移動・バントの狙う方向と同じ扱い）。
   *
   * **打撃動作に入っている間は読まない**（ユーザー判断：動かせるのは打撃動作の外だけ）＝
   * Kを押した瞬間から左右は `buntAimX`（バントで転がす方向）の意味になるので、
   * 1つの十字キーが同時に2つの意味を持つことがない。
   */
  stanceMove?: () => -1 | 0 | 1;
  /**
   * CPUが打者のときの目標の立ち位置（`chooseCpuStance`）。null＝人間が打者
   * （そのときは `stanceMove` で動かす）。**寄せる速さは人間と同じ**なので、
   * 投げ急げばCPUは寄り切れない（人にできない速さでは動かない）。
   */
  cpuStance?: () => number | null;
}): BattingController {
  const {
    batter,
    onContact,
    isSwingHeld,
    buntAimX,
    buntPush,
    batterProfile,
    batterSide,
    pitcherFatigue,
    batterHot,
    stanceMove,
    cpuStance,
  } = opts;

  // バット（フェーズE-25-(c)）。**打者の手のノードの子**にするので、握りの位置・角度は
  // 姿勢（構え・スイング・バント）が決める＝腕を動かせばバットが必ず付いてくる
  // （E-25-1が残した「腕は下ろしたままバットだけ宙に浮く」の解消）。
  // 部品は Blender 製（`createProp('Bat')`。ブラッシュアップで箱から木のバットへ）。
  // 握りが原点・先端が -Y（前腕の延長）で、**握りから先端までちょうど `BAT_LENGTH`**
  // （判定の到達範囲は描かれたバットが覆う範囲に合わせてある＝フェーズRR-66。
  // `assets-src/scripts/build_props.py` が同じ長さで作る）。
  const bat = createProp('Bat');
  // **部品の長さが判定の約束とずれていたら投げる**（Blender で作り直したときに黙って
  // 「見えているバットと当たる範囲が違う」へ戻らないように。player.ts が関節の欠けで
  // 投げるのと同じ扱い）
  const batReach = -new THREE.Box3().setFromObject(bat).min.y;
  if (Math.abs(batReach - BAT_LENGTH) > 0.02) {
    throw new Error(`Bat の長さ ${batReach.toFixed(3)}m が BAT_LENGTH ${BAT_LENGTH}m と違う`);
  }

  /**
   * 今の打席の左右。判定と見た目で必ず同じ値を使うため、フレーム先頭で一度だけ
   * 読み直す（打者交代・スイッチヒッターの立ち位置替えはここで反映される。
   * 投球動作中に打者が変わることはない＝1球の途中でゾーンが動くことはない）。
   */
  let stanceSide: BatterSide = RIGHT_BATTER_SIDE;

  /**
   * 打席内の立ち位置（打者ローカルXのオフセット。負=プレートに寄る。フェーズO-36）。
   * **打者が代わるたびに 0 へ戻す**（`startEntrance`）＝立ち位置は打者の持ち物ではなく
   * 「いまの打席の構え」で、前の打者の踏み込みが次の打者に残らない。
   */
  let stance = 0;

  /** 打席の奥行き（Z）。入場アニメーションの基準にするため生成時の値を覚えておく */
  const standZ = batter.position.z;
  /** 入場（打者の仕切り直し）の経過秒と長さ。null=打席に収まっている */
  let entranceT: number | null = null;
  let entranceSec = 0;

  /**
   * 打者の立ち位置を書く唯一の場所。打席の左右（stanceSide）と入場の進行から求めるので、
   * **入場中でも見た目の左右は判定の左右と必ず一致する**（フェーズB-9）。
   */
  function syncBatterPosition(): void {
    // 0=打席の外（入場開始位置）／1=打席に収まっている
    let progress = 1;
    if (entranceT !== null && entranceSec > 0) {
      const t = Math.min(entranceT / entranceSec, 1);
      const walk =
        t <= ENTRANCE_DELAY_RATIO ? 0 : (t - ENTRANCE_DELAY_RATIO) / (1 - ENTRANCE_DELAY_RATIO);
      // 歩み寄って止まる（減速）。等速だと打席にぶつかって止まったように見える
      progress = 1 - (1 - walk) * (1 - walk);
    }
    const away = 1 - progress;
    // 位置は movePlayerTo 経由で書く（フェーズE-25-(c)）＝入場で歩いたぶんが歩調に積まれ、
    // **打席へ歩いて入る間だけ足が動く**。向きは打席の左右で決まる（進行方向ではない）ので
    // turn:false、姿勢は下の syncBatterPose が構え／スイングとして書くので pose:false。
    //
    // 打席内の立ち位置（フェーズO-36）も判定と同じ `batterStandX` から求める＝
    // **見えている打者と、死球ゾーン・バットの到達範囲が必ず同じ場所にある**。
    movePlayerTo(
      batter,
      batterStandX(stanceSide, stance) + ENTRANCE_OFFSET_X * stanceSide * away,
      batter.position.y,
      standZ + ENTRANCE_OFFSET_Z * away,
      { turn: false, pose: false },
    );
  }

  /**
   * 立ち位置を1フレーム進める（フェーズO-36）。人間は十字キーの左右、CPUは目標へ寄る。
   * **どちらも同じ速さ**（`BATTER_STANCE_MOVE_SPEED`）で、動かせるのは**打撃動作の外だけ**。
   *
   * 入力は画面の左右（ワールドX）なので、**打者ローカルへ直してから足す**（`stanceSide` を
   * 掛ける）＝左打者は「画面右へ押すとプレートから離れる」ではなく、右打者と同じく
   * 「プレート側へ押せば寄る」になる（B-9の鏡像の延長）。
   */
  function updateStance(dt: number): void {
    if (swingT !== null) return; // 打撃動作中は動かない（左右はバントの狙う方向）
    const step = BATTER_STANCE_MOVE_SPEED * dt;
    const target = cpuStance?.() ?? null;
    const next =
      target === null
        ? stance + (stanceMove?.() ?? 0) * stanceSide * step
        : stance + Math.max(-step, Math.min(step, target - stance));
    const clamped = clampStance(next);
    if (clamped === stance) return;
    stance = clamped;
    syncBatterPosition();
  }

  /**
   * 打席の左右を見た目に反映する。**打者ローカルを鏡像にするには、グループのヨー角の
   * 符号と、バットを持つ手（捕手側）をともに反転する**（片方だけだとバットが体の反対側に
   * 付いた姿勢になる）。立ち位置は死球ゾーンと同じ定数から求めるので、「見た目は左打席
   * なのに死球判定は右打席」というズレが起きない。
   */
  function applyStance(side: BatterSide): void {
    stanceSide = side;
    // バットを握る手も打席の左右で入れ替わる（どちらの手かは供給口が決める。E-25-(c)）
    attachBat(batter, bat, side);
    // モデルの向き（フェーズE-25）。**打者グループのヨーはスイングに使われている**ので、
    // 向きはモデル側のノードに持たせ、グループのヨー（stanceSide * STANCE_YAW）と
    // 足して本塁（x=0）を向くように打ち消す＝構えでは打席の内側を向き、スイングでは
    // グループごと回るので体も一緒に振られる。
    setPlayerFacing(batter, -side * (Math.PI / 2 + STANCE_YAW));
    syncBatterPosition();
  }
  applyStance(batterSide?.() ?? RIGHT_BATTER_SIDE);
  batter.rotation.y = stanceSide * STANCE_YAW;

  /** スイング経過秒。null=非スイング中 */
  let swingT: number | null = null;
  /** この球でスイング済みか（空振りストライクの判定材料） */
  let swung = false;
  let contacted = false;
  /**
   * この打席でバントに切り替わったか（原作準拠：スイング中にAを離すとバント）。
   * 一度切り替わったら、その球の間は戻さない（離した時点で「バットを出す」動作に確定）。
   */
  let bunting = false;

  /**
   * バットの回転（ゼッコーチョーの見せ方。フェーズD-19）。**構えている間だけ回し、
   * 打撃動作に入ったら必ず畳む**（回したままスイングすると、振り抜きの角度と
   * バットの向きが噛み合わず何をしているか読めなくなる）。
   *
   * 好調でない打者では常に `0` を書くので、**この機能を入れる前とバットの姿勢は
   * 1ラジアンも変わらない**（好調が回ってこない打席の見た目は従来のまま）。
   */
  function updateBatSpin(dt: number, idle: boolean): void {
    if (idle && (batterHot?.() ?? false)) {
      bat.rotation.z = (bat.rotation.z + HOT_BAT_SPIN_RATE * dt) % (Math.PI * 2);
      return;
    }
    bat.rotation.z = 0;
  }

  /**
   * スイングの進行度（0=構え / 1=振り抜き）。振り切るまでは増え、振り抜いた後は
   * 構えへ戻るぶん減る。**体のヨー（振り）も腕の姿勢もこの1つの値から起こす**ので、
   * 「体は振り切っているのに腕は構えのまま」がフレーム単位でも起きない。
   */
  function swingProgress(t: number): number {
    if (t <= SWING_SWEEP_SEC) return t / SWING_SWEEP_SEC;
    return 1 - Math.min((t - SWING_SWEEP_SEC) / SWING_RECOVER_SEC, 1);
  }

  /**
   * 打者の見た目を書く唯一の場所（体のヨー＝振り／関節の姿勢）。打撃動作の状態
   * （構え・バント・スイング）から毎回導出するので、**姿勢の書き残し**が起きない。
   */
  function syncBatterPose(): void {
    if (swingT === null) {
      batter.rotation.y = stanceSide * STANCE_YAW;
      setPlayerPose(batter, { kind: 'stance', side: stanceSide, walking: entranceT !== null });
      return;
    }
    if (bunting) {
      batter.rotation.y = stanceSide * BUNT_YAW;
      setPlayerPose(batter, { kind: 'bunt', side: stanceSide });
      return;
    }
    const p = swingProgress(swingT);
    batter.rotation.y = stanceSide * (STANCE_YAW - SWING_YAW_RANGE * p);
    setPlayerPose(batter, { kind: 'swing', side: stanceSide, t: p });
  }
  syncBatterPose();

  return {
    trySwing() {
      if (swingT !== null || swung) return false;
      swingT = 0;
      swung = true;
      contacted = false;
      bunting = false;
      return true;
    },

    checkContact(prev, next, dt) {
      if (swingT === null || contacted) return;
      const cross = contactPlaneCrossing(prev, next);
      if (!cross) return;
      // バント中はタイミングを問わずコース内なら当たる（バットを出しているだけなので）。
      // フルスイングは従来どおりタイミング×コースで判定する。
      // バントは「当てて転がすだけ」なので打者の能力値でも投手の疲労でも変わらない
      // （原作でもバントの打球は打力に左右されない。長打力で送りバントが強くなっても困る）。
      const launch = bunting
        ? judgeBunt(cross.x, buntAimX?.() ?? 0, stanceSide, stance, buntPush?.() ?? false)
        : judgeSwing(
            {
              crossX: cross.x,
              // swingT はフレーム先頭時点の経過なので、サブフレームの通過時刻を足す
              swingTime: swingT + cross.frac * dt,
              pitchSpeed: prev.vz,
            },
            batterProfile?.(),
            stanceSide,
            pitcherFatigue?.() ?? 0,
            // 打席内の立ち位置（フェーズO-36）。バットの到達範囲と芯が一緒に動く
            stance,
          );
      if (!launch) return; // 空振り（タイミング外 or バットが届かない）
      contacted = true;
      swung = false; // 接触したので空振りストライク扱いにしない
      // バントで出した打球かは**この時点で控えておく**（フェーズAA-48）。すぐ下で
      // bunting を畳むので、打球を作るときには読めなくなる。この事実が要るのは
      // ちっちゃいモードでファウルが確定したとき（2ストライク後は三振）。
      const wasBunt = bunting;
      // 打球が出ても**スイングは振り抜くまで続ける**（フェーズWW-71）。打った瞬間に全体を
      // 止めるヒットストップをやめ、打球がバットから飛び出すところを見せてからカットする
      // ようにしたので、姿勢もそこで止めない。もう当たらないことは `contacted` が保証し、
      // 打撃動作の後始末（バントのバットを畳む等）はカットの瞬間の `endPitch` が担う。
      onContact(createBattedBall(launch, cross.x, wasBunt));
    },

    update(dt) {
      // 打席の左右はフレーム先頭で読み直す（打者交代・両打ちの立ち位置替えの反映点）
      const side = batterSide?.() ?? RIGHT_BATTER_SIDE;
      if (side !== stanceSide) applyStance(side);
      // 入場（打者の仕切り直し）はスイングの有無に関わらず進める。スイング中に打者が
      // 入場していることは無いが、分岐の後ろに置くと下の早期returnで止まってしまう。
      if (entranceT !== null) {
        entranceT += Math.min(dt, MAX_DT);
        if (entranceT >= entranceSec) entranceT = null;
        syncBatterPosition();
      }
      // バットの回転は打撃動作の有無で決まるので、スイング中/構え中の分岐より前に一度だけ
      // 判断する（構えている＝スイングもバントもしていない、が唯一の条件）。
      updateBatSpin(dt, swingT === null);
      // 打席内の立ち位置（フェーズO-36）。打撃動作中は動かない＝updateStance が自分で見る。
      // スイングの進行より前に置くのは、押した瞬間に「動く」から「バントの方向」へ意味が
      // 変わる境目を1フレームずらさないため。
      updateStance(Math.min(dt, MAX_DT));
      if (swingT !== null) {
        // 投球側と同じ dt クランプ（跳ねると接触タイミングと表示がずれる）
        swingT += Math.min(dt, MAX_DT);
        // スイングを振り切る前にAを離したらバントに切り替える（説明書p14）
        if (!bunting && swingT < SWING_SWEEP_SEC && isSwingHeld && !isSwingHeld()) {
          bunting = true;
        }
        // バントは「バットを出したまま球を待つ」。フルスイングのように振り切って
        // 構えへ戻ることはしないので、スイングの時間切れ（SWING_TOTAL_SEC）を適用しない
        // ＝早めにバントの構えを取っても球が来るまで維持される（解除は endPitch / 接触時）。
        if (!bunting && swingT >= SWING_TOTAL_SEC) swingT = null;
      }
      // 見た目（体のヨーと関節）は状態から毎フレーム導出する。非スイング中も必ず通るので、
      // バント姿勢のまま固まることがない（従来の「構えへ戻す保険」はこの導出そのもの）。
      syncBatterPose();
    },

    consumeSwung() {
      const result = swung;
      swung = false;
      return result;
    },

    isBunting: () => bunting,

    stanceOffset: () => stance,

    startEntrance(durationSec) {
      if (durationSec <= 0) return;
      // 立ち位置は打者ごとに仕切り直す（フェーズO-36）。前の打者の踏み込みが
      // 次の打者に残ると、打席に入った瞬間の死球ゾーンが本人の構えと食い違う。
      stance = 0;
      entranceSec = durationSec;
      entranceT = 0;
      syncBatterPosition();
    },

    syncStance() {
      const side = batterSide?.() ?? RIGHT_BATTER_SIDE;
      if (side === stanceSide) return;
      applyStance(side);
      // 新しい打席の左右で見た目を組み直す（スイング中でも進行度は保たれる）
      syncBatterPose();
    },

    endPitch() {
      // 1球の決着（判定確定）でこの球の打撃動作を終える。バントでバットを出したまま
      // 球を見送った場合に、次の球へバント姿勢を持ち越さないために必要。
      swingT = null;
      bunting = false;
      contacted = false;
      syncBatterPose();
    },
  };
}

// ---- 銃モード ----

/** 発射時のマズルフラッシュ表示秒数（シリアス演出、派手にしすぎない） */
const MUZZLE_FLASH_SEC = 0.08;
/** レティクルの表示高さ（打者の胸元付近） */
const RETICLE_HEIGHT = 1.3;
/** 銃を構え切るまでの時間 s（フェーズE-25-(e)。見た目だけ＝この間も撃てる） */
const GUN_RAISE_SEC = 0.18;
/**
 * 撃った後・銃モードを抜けた後に銃を降ろすまでの時間 s（フェーズE-25-(e)）。
 * **0にはできない**：命中は `GUN_HIT_STOP_SEC`（0.3秒）の全体静止を挟むので、抜けた瞬間に
 * 銃を消すと**静止している間だけ「銃を持たずに構えている投手」**になる（シリアス演出の
 * 見せ場でいちばん見られているフレーム）。
 */
const GUN_LOWER_SEC = 0.45;

export interface GunController {
  /** 銃モードに入った瞬間（GUN_TOGGLE→gun）に呼ぶ。照準を初期位置へ戻して表示する */
  enter(): void;
  /**
   * 照準を指定の位置へ直接置く（フェーズF-26-2。CPU投手が撃つときに使う）。
   * 人間は十字キーで動かすが、CPUは狙いを定めた状態から予兆に入るので、
   * **画面に出ているレティクルがそのまま「どこを狙われているか」の予告**になる。
   */
  aimAt(x: number): void;
  /** 銃モードを抜けた瞬間に呼ぶ。照準を隠す */
  exit(): void;
  /** 毎フレーム呼ぶ。active は「でっかいモード かつ 銃モード」の間だけ true にする */
  update(dt: number, active: boolean): void;
  /**
   * Aボタン押下で呼ぶ。現在の照準位置で判定してマズルフラッシュを発生させ、
   * 次弾に備えて照準を初期位置へ戻す（毎発、明示的な照準合わせを要求する）。
   */
  fire(): GunShotResult;
}

export function createGunController(opts: {
  pitcher: THREE.Group;
  pad: VirtualPad;
  reticle: THREE.Object3D;
  /**
   * 銃の部品（`createProp('Gun')`。フェーズE-25-(e)）。**投手の手のノードの子**にするので、
   * 構えの腕を動かせば銃が必ず付いてくる（バットと同じ扱い＝宙に浮かない）。
   * 渡さなければ従来どおり照準とマズルフラッシュだけになる。
   */
  gun?: THREE.Object3D;
  /**
   * 今打席に立っている打者の左右（BOX。フェーズB-9）。命中ゾーンが打者と一緒に
   * 反対側へ移る＝**右打者には照準を画面左（三塁側）、左打者には画面右へ振らないと
   * 当たらない**（外れは従来どおり通常の投球判定と同じ扱いになる）。
   * 省略時は右打者固定。
   */
  batterSide?: () => BatterSide;
  /**
   * 今の打者の打席内の立ち位置（フェーズO-36）。命中ゾーンは死球ゾーンそのもの
   * （`judgeShot` → `judgePitch`）なので、**打者が寄れば当たる位置も寄る**。
   * 省略時は 0＝打席中央＝従来と同じ。
   */
  batterStance?: () => number;
  /**
   * 今マウンドにいる投手の投球腕（フェーズCC-50）。**銃は投げる腕の手に持つ**ので、
   * 右投手なら三塁側の腕で構える（投球の見た目と食い違わない）。省略時は右投げ。
   */
  pitcherArm?: () => PitchArm;
}): GunController {
  const { pitcher, pad, reticle, gun, batterSide, batterStance, pitcherArm } = opts;

  function armOf(): PitchArm {
    return pitcherArm?.() ?? NEUTRAL_PITCH_ARM;
  }

  const muzzleFlash = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xfff3b0 }),
  );
  muzzleFlash.visible = false;
  if (gun) {
    // 銃を持たせ、閃光は**銃口のノードの子**にする（フェーズE-25-(e)）＝銃身の長さを
    // 変えても閃光が付いてくる（座標をこちらに書き写さない）。
    gun.visible = false;
    attachGun(pitcher, gun, armOf().side);
    gunMuzzleOf(gun).add(muzzleFlash);
  } else {
    // 銃の部品が無い場合は従来どおり投手の胸元で光らせる
    muzzleFlash.position.set(0, 1.1, 0.4);
    pitcher.add(muzzleFlash);
  }

  let aimX = GUN_AIM_INITIAL_X;
  let flashTimer = 0;
  /** 構えの進行度 s（0=下ろしている。`GUN_RAISE_SEC` で構え切る） */
  let raiseSec = 0;
  /** 銃モードを抜けてから降ろすまでの残り s（0より大きい間は構えたまま銃が見える） */
  let lowerSec = 0;

  /** カメラが-Zを向くため、画面上の左右入力はワールドXと同じ向き（投球と同じく反転不要） */
  function worldSteerX(): -1 | 0 | 1 {
    return pad.direction().x as -1 | 0 | 1;
  }

  function syncReticle(): void {
    reticle.position.set(aimX, RETICLE_HEIGHT, PLATE_Z);
  }

  /**
   * 構えの見た目（フェーズE-25-(e)）。**銃が見えているかと姿勢は同じ1つの進行度から
   * 導出する**ので、「銃を持っていないのに構えている」「構えていないのに銃がある」が
   * 構造的に起きない。降ろし切ったら姿勢は書かない＝投球の姿勢（`syncPitcherPose`）に
   * そのまま戻る（毎フレーム全関節を書き直す作りなので、明示的に戻す処理は要らない）。
   */
  function syncGunPose(): void {
    const raised = Math.min(1, raiseSec / GUN_RAISE_SEC);
    const held = raiseSec > 0 || lowerSec > 0;
    if (gun) gun.visible = held;
    if (held) setPlayerPose(pitcher, { kind: 'aim', t: raised, arm: armOf() });
  }

  return {
    enter() {
      aimX = GUN_AIM_INITIAL_X;
      reticle.visible = true;
      syncReticle();
      raiseSec = 0;
      lowerSec = 0;
      // 継投で投手が代われば持つ手も変わる（フェーズCC-50）。**構えに入るときに
      // 持ち替える**のは、腕が変わりうるのが打席の切れ目＝銃モードの外だけだから
      // （打者の `applyStance` が打席の左右でバットの持ち手を替えるのと同じ扱い）。
      if (gun) attachGun(pitcher, gun, armOf().side);
      // 構えに入った最初のフレームから銃を出す（**CPUの予兆は全体静止＝update が
      // 呼ばれない**ので、ここで書かないと予兆の1.5秒がまるごと素手のままになる）
      syncGunPose();
    },

    aimAt(x) {
      aimX = clampAimX(x);
      syncReticle();
    },

    exit() {
      reticle.visible = false;
      // 構えていたときだけ降ろす（一度も構えていなければ何も起こらない＝新しい試合の
      // 頭で `exit` を念のため呼んでいる経路で、銃が一瞬映ることがない）
      if (raiseSec > 0) lowerSec = GUN_LOWER_SEC;
      raiseSec = 0;
    },

    update(dt, active) {
      // タブ非アクティブ復帰などで dt が跳ねたときの暴走防止（他コントローラと同じ規約）
      const d = Math.min(dt, MAX_DT);
      if (active) {
        aimX = stepAimX(aimX, worldSteerX(), d);
        syncReticle();
        raiseSec += d;
        lowerSec = 0;
      } else if (lowerSec > 0) {
        lowerSec = Math.max(0, lowerSec - d);
      }
      syncGunPose();
      if (flashTimer > 0) {
        flashTimer -= d;
        if (flashTimer <= 0) muzzleFlash.visible = false;
      }
    },

    fire() {
      muzzleFlash.visible = true;
      flashTimer = MUZZLE_FLASH_SEC;
      const result = judgeShot(
        aimX,
        batterSide?.() ?? RIGHT_BATTER_SIDE,
        batterStance?.() ?? 0,
      );
      aimX = GUN_AIM_INITIAL_X;
      syncReticle();
      return result;
    },
  };
}
