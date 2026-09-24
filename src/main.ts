/**
 * エントリポイント。
 * 単一Scene＋カメラ切り替え方式（でっかい/ちっちゃい）で、モード遷移は
 * modeMachine のステートに完全連動する瞬時カット（原作準拠）。
 *
 * 投球・打撃・守備・走塁は本実装済み。打球はスイング接触→BATTED_BALL→ちっちゃいモードへ
 * 引き継がれ、操作野手の捕球・送球と走者の自動進塁による実プレーでアウト/安打/得点が
 * 確定する（セッション4）。
 */
import * as THREE from 'three';
import { createActor } from 'xstate';
import { type GameContext, gameMachine, rerollsLeftOf } from './core/gameMachine';
import { modeMachine } from './core/modeMachine';
import {
  type BaseRunners,
  type Bases,
  type Count,
  type Half,
  type HitType,
  type RunnerId,
  type TeamSide,
  STRIKES_FOR_OUT,
  applyPitch,
  battingTeam,
  fieldingTeam,
  occupancy,
  opponent,
} from './core/rules';
import {
  type PlayerSlot,
  type SideControllers,
  PLAYER_LABEL,
  PLAYER_SLOTS,
  controllersFor,
  defensePlayer,
  isTwoPlayer,
  offensePlayer,
  playerOfSide,
  roleOfPlayer,
  sideOfPlayer,
} from './core/players';
import type { TeamId } from './core/teams';
import { type BattedBall, type BattingProfile, GRAVITY, callAfterSwing } from './core/batting';
import {
  type BatterSide,
  type PitchArm,
  type PitchCall,
  batterStandX,
  LEFT_BATTER_SIDE,
  NEUTRAL_PITCH_ARM,
  NEUTRAL_RATING,
  RIGHT_BATTER_SIDE,
  batterFrameX,
  judgePitch,
  fatiguedBreak,
  fatiguedControl,
  fatiguedSpeed,
  plateCrossingX,
  armReleaseHeight,
  neutralSpeedFor,
} from './core/pitch';
import {
  type FieldingPosition,
  type RosterPlan,
  DEFAULT_ROSTER_PLAN,
  activatableEffect,
  brawlLoadoutOf,
  canPinchHit,
  canPinchRun,
  canShootGun,
  canUseVerb,
  controlBonusOf,
  cpuRosterPlan,
  currentBatterId,
  currentBatterPosition,
  effectiveBatting,
  effectiveBattingHand,
  effectivePitching,
  effectivePlay,
  fatigueOf,
  fielderThrowArm,
  positionLabel,
  gunRemainingOf,
  isHot,
  isPitcherAtBat,
  nextBatterId,
  pitchArmOf,
  pitcherControl,
  pitcherQualityOf,
  pitcherRole,
  remainingStaminaOf,
  skillHoldersOf,
  liveSkillsOf,
  skillProcsOf,
  effectiveSkillsOf,
} from './core/roster';
import { dressPlayer } from './entities/skillLooks';
import { createSkillFx } from './scenes/skillFx';
import { SKILL_SOUND } from './audio/skillSounds';
import { SKILLS, type SkillMoment, sightOf, skillsAtMoment } from './core/skills';
import {
  SLOW_TIME_SCALE,
  inSlowZone,
  plateCrossing,
  predictCpuPitchPath,
  readingText,
  type SightPoint,
} from './core/skillSight';
import { CATCH_RADIUS } from './core/fielding';
import { runSkillDraft } from './ui/skillDraft';
import { matchEnd, runEnd, runNextSelect } from './ui/runScreen';
import {
  type SkillId,
  cpuChooseSkill,
  rerollsLeft,
  shouldCpuReroll,
  skillDef,
} from './core/skills';
import {
  type CarriedFatigue,
  type CarriedSkills,
  type CarriedUses,
  type RunState,
  RUN_GAMES,
  createRun,
  preloadedSkills,
  restedPitchCounts,
  runDoors,
  runOutcomeAfter,
  runProgress,
  skillCount,
  withGameResult,
  withNextGame,
} from './core/run';
import { isLuckyInning } from './core/condition';
import {
  type EdgeMarker,
  BALL_RADIUS,
  CHICCHAI_PLAYER_SCALE,
  dekkaiBallScale,
  edgeMarker,
} from './core/camera';
import {
  type AtBatMarker,
  type InterludeKind,
  CONTACT_FOLLOW_SEC,
  CPU_BRAWL_DECISION_SEC,
  GAME_RESULT_PAUSE_SEC,
  GUN_TELEGRAPH_SEC,
  INTERLUDE_SEC,
  interludeBetween,
} from './core/tempo';
import {
  type BaseKey,
  type CarriedLeads,
  type CpuStealOptions,
  CPU_STEAL_JUMP_SEC,
  CPU_STEAL_MAX_DEFENSE_SLACK_SEC,
  DROPKICK_RANGE,
  MAX_LEAD,
  STEAL_LEAD,
  baseFromPadDirection,
  canTakeLeadOff,
  chooseCpuSteals,
  cpuStealDefenseSlack,
  resolveCarriedLeads,
  runnerSpeed,
} from './core/fielding';
import { type Ballpark, type BallparkId, DEFAULT_BALLPARK, ballparkById } from './core/ballpark';
import {
  type BrawlEvent,
  type BrawlLoadouts,
  type BrawlSide,
  type BrawlState,
  MOVES,
  MOVE_NAME,
  shouldCpuStartBrawl,
} from './core/brawl';
import {
  chooseCpuPinchHitter,
  chooseCpuPinchRunner,
  chooseCpuStance,
  crossesSwingDecisionPoint,
  shouldCpuActivateBattingEffect,
  shouldCpuSwing,
} from './core/cpuBatter';
import { chooseCpuRelief, shouldCpuIntentionalWalk, shouldCpuShoot } from './core/cpuPitcher';
import { batterAimX } from './core/gun';
import { sfx } from './audio/sfx';
import { music } from './audio/music';
import { crowd } from './audio/crowd';
import { audioSettings, setAudioSettings } from './audio/engine';
import {
  type VirtualPad,
  PLAYER1_KEYS,
  PLAYER2_KEYS,
  createKeyboardPad,
  createMergedPad,
  createRolePad,
} from './input/keyboard';
import { type MatchSelection, runRosterPlanSelect, runTeamSelect } from './ui/teamSelect';
import {
  type BrawlPracticeSetup,
  type KnockSetup,
  type PracticeMode,
  INITIAL_BRAWL_PRACTICE,
  INITIAL_KNOCK,
  KNOCK_RUNNER_PATTERNS,
  PRACTICE_DUMMIES,
  PRACTICE_KEYS,
  PRACTICE_SUPERS,
  cycleKnock,
  cyclePracticeSkill,
  knockLaunch,
  PRACTICE_SKILLS,
  practiceSkillSides,
  practiceBrawlLoadout,
  practiceFoeLoadout,
  practiceHudLines,
} from './debug/practice';
import {
  type IntentionalWalkTarget,
  type PinchRunTarget,
  runManagerMenu,
} from './ui/managerMenu';
import { createField, FIELD_POSITIONS } from './scenes/field';
import {
  type PitchProfile,
  createBattingController,
  createCpuPitcherController,
  createDekkaiCamera,
  createGunController,
  createPitchingController,
} from './scenes/dekkaiScene';
import {
  type PlayPrompt,
  type PlayPromptKind,
  createChicchaiCamera,
  createFielders,
  createFieldPlayController,
  createRunners,
} from './scenes/chicchaiScene';
import {
  BRAWL_STAGE_Z,
  createBrawlCamera,
  createBrawlController,
  createBrawlFighters,
} from './scenes/brawlScene';
import {
  attachGlove,
  createPlayer,
  preloadPlayerModel,
  setPlayerColor,
  setPlayerFacing,
  setPlayerPose,
} from './entities/player';
import { createProp, preloadProps } from './entities/props';
import { preloadStadiumModel } from './entities/stadium';
import { createBall } from './entities/ball';
import { createReticle } from './entities/reticle';
import { type PlayPromptLine, createHud } from './ui/hud/hud';
import { preloadPixelFont, setPixelText } from './ui/hud/pixelText';
// ドットフォント（DotGothic16・SIL OFL 1.1）。日本語は使う字のぶんだけ小分けで読み込まれる
import '@fontsource/dotgothic16/400.css';
import { setOutlineViewport } from './render/toon';
import { setTextureAnisotropy } from './render/textures';
import { createLightRig, groundFocusOf } from './render/lighting';

// ---- Three.js セットアップ（単一Scene） ----

const app = document.getElementById('app')!;
// 描画の質（ブラッシュアップ：グラフィック）。**アンチエイリアスを入れ、高DPIの画面では
// 実際の画素数で描く**（それまでは antialias:false・等倍で、縁がギザギザにかくついていた）。
// 画素比は2で頭打ち＝4Kの画面で4倍の画素を塗って重くならないように。
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
const pixelRatio = (): number => Math.min(window.devicePixelRatio || 1, 2);
renderer.setPixelRatio(pixelRatio());
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
setOutlineViewport(window.innerWidth, window.innerHeight, pixelRatio());
// 地面の模様（芝の刈り目）は浅い角度で見るので、異方性フィルタを上限まで効かせる
setTextureAnisotropy(renderer.capabilities.getMaxAnisotropy());
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101820);

// 光源は太陽＋空の照り返しの2つだけ（トゥーンの階調は太陽の向きで段が決まる）。
// 影はモードごとに「いま映っている場所の周り」へ寄せる（`renderFrame`）。
const lightRig = createLightRig(scene);

/**
 * この試合の球場（フェーズC-14）。**チーム選択（runTeamSelect）で決まるまで確定しない**
 * ので、フィールドのジオメトリを組むのも背景色を決めるのも選択の完了後に行う
 * （メインループも同じタイミングで始まるので、選択前に描かれるフレームは無い）。
 * 打球物理（フェンスの距離・高さ）はここを問い合わせる ballparkOf 経由で参照される。
 *
 * ラン化（フェーズF-26-6）で**試合ごとに変わる**ようになったので、組んだフィールドを
 * 覚えておいて差し替える（`applyBallpark`）。
 */
let ballpark: Ballpark = DEFAULT_BALLPARK;
/** いま Scene に載っているフィールド（球場を差し替えるときに取り除くため覚えておく） */
let fieldGroup: THREE.Group | null = null;

/** 取り除いたフィールドのGPU資源を解放する（5試合ぶん積み上がるので捨て置かない） */
function disposeGroup(group: THREE.Group): void {
  group.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material.dispose();
    // スタンド・観客は InstancedMesh（フェーズE-25-(d)）。行列と色のバッファは
    // ジオメトリとは別に持っているので、これを呼ばないと試合ごとに積み上がる。
    const instanced = child as THREE.InstancedMesh;
    if (instanced.isInstancedMesh) instanced.dispose();
  });
}

/**
 * その試合の球場を反映する（フィールドの形・芝生の広さ・空の色）。**打球物理も描画も
 * 同じ `ballpark` から起こす**というC-14の整理はそのままで、ラン化ではここが
 * 試合ごとに呼ばれるようになっただけ。
 */
function applyBallpark(id: BallparkId): void {
  ballpark = ballparkById(id);
  scene.background = new THREE.Color(ballpark.skyColor);
  if (fieldGroup) {
    scene.remove(fieldGroup);
    disposeGroup(fieldGroup);
  }
  fieldGroup = createField(ballpark);
  scene.add(fieldGroup);
}

// でっかいモードの投手・打者の既定色（乱闘の交代で色替えするので、試合ごとに戻せるよう
// 名前を付けてある。フェーズF-26-6のラン化で試合を作り直すようになったため）。
const PITCHER_COLOR = 0x2255cc;
const BATTER_COLOR = 0xcc3333;

// 選手モデル（フェーズE-25）。**人型を作るより前に一度だけ読み込む**：供給口
// （createPlayer）は同期のままにしてあるので、原型が無い状態で呼ぶと投げる。
await preloadPlayerModel();
// 球場の部品（フェーズE-25-(d)）。同じ理由で `createField` より前に読み込む
// （フィールドを組むのはチーム選択の後なので、ここで待っても表示は遅れない）。
await preloadStadiumModel();
// スキルの持ち物（フェーズE-25-(e)。バイク・銃）。走者・投手に持たせるのはこの直後なので、
// 人型と同じく**作るより前に**読み込む。
await preloadProps();
// 文字（ブラッシュアップ）。英数・かなを先に読み込んでおく＝最初の画面から代わりの字で
// 描かれることがない（漢字は使うぶんだけ後から読み込まれ、HUDは読み込み後に描き直す）
await preloadPixelFont();

const pitcher = createPlayer(PITCHER_COLOR);
pitcher.position.copy(FIELD_POSITIONS.mound);
pitcher.position.y = 0.4;
scene.add(pitcher);

const batter = createPlayer(BATTER_COLOR);
// 左右のXは打撃コントローラーが打席の左右（BOX）に応じて出し入れする（フェーズB-9）。
// ここでの初期値は右打席（＝三塁側。フェーズBB-49）で、判定と同じ `batterStandX` から
// 起こす＝符号の取り決めを書き写さない。向きも打席の左右で決まるので
// 打撃コントローラー側（applyStance）が書く。
batter.position.set(batterStandX(), 0, 0.2);
scene.add(batter);

// 捕手は守備側＝投手と同じユニフォーム（ブラッシュアップ：旧来の緑は仮の色で、
// 本塁の前に3チーム目がいるように見えていた）
const catcher = createPlayer(PITCHER_COLOR);
catcher.position.set(0, 0, 2.4);
// 捕手だけは本塁の後ろから投手（-Z）を向く＝でっかいモードのカメラからは背中が見える
setPlayerFacing(catcher, Math.PI);
// 捕手は座って構える（フェーズE-25-(c)）。プレー中この姿勢が変わることは無いので
// 起動時に一度書くだけでよい（投手・打者と違い、捕手の見た目は状態を持たない）。
setPlayerPose(catcher, { kind: 'crouch' });
scene.add(catcher);

// グラブとミット（ブラッシュアップ：グラフィック）。**投げない側の手**に持たせる。
// 捕手は右投げの既定のまま動かない。投手は継投で左右が入れ替わるので、状態が変わる
// たびに持ち替える（`refresh`）。
const pitcherGlove = createProp('Glove');
attachGlove(pitcher, pitcherGlove, NEUTRAL_PITCH_ARM.side);
attachGlove(catcher, createProp('Mitt'), NEUTRAL_PITCH_ARM.side);

const ball = createBall();
scene.add(ball);

// 守備の9野手（常時シーンに配置。ちっちゃいモードの鳥瞰でのみ実質的に見える）
const fielders = createFielders();
for (const f of fielders) scene.add(f.group);
// スキルが効いた瞬間の見た目（フェーズYY-73）
const skillFx = createSkillFx();
scene.add(skillFx.root);

// 走者（打者走者＋一二三塁走者）。フィールドプレー中のみ表示される
const runners = createRunners();
scene.add(runners.batter, runners.first, runners.second, runners.third);

// 打球の落下地点を示す影（鳥瞰カメラでの高さの手がかり）
const ballShadow = new THREE.Mesh(
  new THREE.CircleGeometry(0.5, 12),
  new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }),
);
ballShadow.rotation.x = -Math.PI / 2;
ballShadow.visible = false;
scene.add(ballShadow);

// 銃モードの照準（レティクル）。非銃モード中は非表示
const reticle = createReticle();
scene.add(reticle);

// 乱闘（v1）の専用ファイター（でっかいモードの投手/打者とは別インスタンス。
// ちっちゃいモードの野手/走者と同じく常時シーンに配置し、表示/非表示のみ切り替える）
const brawlFighters = createBrawlFighters();
scene.add(brawlFighters.batter, brawlFighters.pitcher);

const aspect = () => window.innerWidth / window.innerHeight;
const dekkaiCamera = createDekkaiCamera(aspect());
// ちっちゃいモードは打球・走者に寄ってボールを追うカメラ（フェーズE-24）。カメラ本体は
// 従来どおり main.ts が持ち（render・リサイズ）、どこを見るかはリグが毎フレーム決める。
const chicchaiRig = createChicchaiCamera(aspect());
const chicchaiCamera = chicchaiRig.camera;
const brawlCamera = createBrawlCamera(aspect());
let activeCamera: THREE.PerspectiveCamera = dekkaiCamera;

window.addEventListener('resize', () => {
  renderer.setPixelRatio(pixelRatio());
  renderer.setSize(window.innerWidth, window.innerHeight);
  setOutlineViewport(window.innerWidth, window.innerHeight, pixelRatio());
  for (const cam of [dekkaiCamera, chicchaiCamera, brawlCamera]) {
    cam.aspect = aspect();
    cam.updateProjectionMatrix();
  }
});

/** 影を寄せる注視点（毎フレーム書き直す作業用） */
const shadowFocus = new THREE.Vector3();
/** 乱闘の舞台の中心（影をここへ寄せる） */
const brawlStageFocus = new THREE.Vector3(0, 0, BRAWL_STAGE_Z);

/**
 * 1フレームを描く。**描画はすべてここを通す**＝影の範囲（いま映っているモードの
 * 注視点の周り）を毎フレーム合わせてから描く。モードの判定は `activeCamera` から行う
 * （どのカメラで描くかが決まれば、影を落とす場所も決まる）。
 */
function renderFrame(): void {
  if (activeCamera === chicchaiCamera) {
    lightRig.update('chicchai', groundFocusOf(chicchaiCamera, shadowFocus));
  } else if (activeCamera === brawlCamera) {
    lightRig.update('brawl', brawlStageFocus);
  } else {
    lightRig.update('dekkai', shadowFocus.set(0, 0, -8));
  }
  renderer.render(scene, activeCamera);
}

// ---- ステートマシン起動 ----
//
// **1試合＝1組のアクター**（フェーズF-26-6のラン化）。`gameMachine` は今までどおり
// 「1試合」を表すマシン（決着したら最終状態 gameOver で止まる）のままで、**ランは
// その外側にある試合の列**なので、次の試合はアクターごと作り直す（`startGame`）。
// マシンに「試合をリセットするイベント」を足す形にしなかったのは、そうすると
// 最終状態でなくなり「試合は決着したら終わり」という今の性質が消えるため。

let gameActor = createActor(gameMachine).start();
let modeActor = createActor(modeMachine).start();

const hudRoot = document.getElementById('hud')!;
// チーム選択中はHUDを出さない（フェーズC-13）。既定のカードのスコアボードが選択画面の
// 裏に透けて見えると、まだ選んでいない球団が対戦相手のように見えてしまう。
hudRoot.style.display = 'none';
const hud = createHud(hudRoot);

/** modeMachine のステート値からトップレベルのモード名を取り出す */
function currentMode(): string {
  const value = modeActor.getSnapshot().value;
  return typeof value === 'string' ? value : Object.keys(value)[0];
}

function isGunMode(): boolean {
  return modeActor.getSnapshot().matches({ dekkai: 'gun' });
}

function refresh(): void {
  const game = gameActor.getSnapshot().context;
  const mode = currentMode();
  // ちっちゃいモードは鳥瞰、乱闘は2.5D横視点、それ以外（でっかい/死球）はクローズアップ視点
  activeCamera = mode === 'chicchai' ? chicchaiCamera : mode === 'brawl' ? brawlCamera : dekkaiCamera;
  // でっかいモードの投手/打者/捕手プレースホルダーは、ちっちゃいモード（鳥瞰の
  // 守備・走塁）・乱闘（専用ファイターに切り替え済み）では不要かつ視界の邪魔になる
  // （実機テストプレイで、鳥瞰視点にこれらが写り込み守備対象と紛らわしいと判明した
  // ため非表示にする。詳細はPROGRESS.md「実装メモ」）。
  const showDekkaiActors = mode !== 'chicchai' && mode !== 'brawl';
  // 投手のグラブは投げない側の手（継投で右投げ・左投げが入れ替わる）
  attachGlove(pitcher, pitcherGlove, currentPitchArm().side);
  pitcher.visible = showDekkaiActors;
  batter.visible = showDekkaiActors;
  catcher.visible = showDekkaiActors;
  // 逆に**ちっちゃいモードの野手9人はでっかいモードでは隠す**。野手Pのホームポジションは
  // マウンド（`FIELDER_HOME_POSITIONS.P`）、野手Cは本塁の後ろで、**でっかいモードの投手・
  // 捕手とほぼ同じ場所に立っている**＝隠さないと投手が2人・捕手が2人並んで見える
  // （実機テストプレイで判明。箱のプレースホルダー時代は同じ姿勢・同じ形で重なって
  // 1体に見えていたが、E-25で人型モデル＋姿勢が入って別々の人として見えるようになった）。
  const showFielders = mode === 'chicchai';
  for (const f of fielders) f.group.visible = showFielders;
  // 持ち越したリード（フェーズL-32）は「いまその塁にいる走者のもの」だけを渡す
  // ＝走者が入れ替わった塁の古い数字が画面に残らない（表示と判定が同じ関数から起きる）。
  hud.update(
    game,
    mode,
    isGunMode(),
    controllers,
    run ? runProgress(run) : undefined,
    resolveCarriedLeads(game.baseRunners, carriedLeads),
  );
  syncMusic();
}

/**
 * 場面から流す曲を決める（ブラッシュアップ：BGM）。**状態が変わるたびに呼ぶ**（同じ曲なら
 * 何もしない＝`music.play` の側が重ねない）。
 *
 * - 抽選画面・試合の間の画面＝抽選の曲（考える時間）
 * - 乱闘＝乱闘の曲
 * - **得点圏に走者がいる＝チャンスの曲**（応援歌風。攻撃側・守備側どちらにとっても
 *   山場なので、どちらが人間でも同じ曲にする＝`hud` のカードと同じ「今の対戦」の扱い）
 * - それ以外＝試合の曲。決着した後はループを流さない（勝敗のジングルだけ）。
 */
function syncMusic(): void {
  if (!gameStarted) return;
  if (runScreenOpen || draftOpen) {
    music.play('draft');
    return;
  }
  if (currentMode() === 'brawl') {
    music.play('brawl');
    return;
  }
  const ctx = gameActor.getSnapshot().context;
  if (ctx.winner !== null) return;
  music.play(ctx.bases.second || ctx.bases.third ? 'chance' : 'game');
}

/** チーム選択（タイトル）へ戻るときの音：場内のざわめきを止め、タイトルの曲にする */
function backToTitleAudio(): void {
  crowd.stopAmbience();
  music.play('title');
}

/**
 * **M キーで BGM のオン/オフ**（ブラッシュアップ）。ゲームの操作（①のキー表）とは別の
 * 本体の設定なので、1P・2Pのどちらのキーとも重ならない M に置く。設定は窓を閉じても
 * 覚えておく（`audio/engine.ts`）。切り替えた瞬間だけ画面の上に小さく出す。
 */
function installMusicToggle(): void {
  const toast = document.createElement('div');
  toast.style.cssText = `
    position: fixed;
    top: calc(12px * var(--ui-scale, 1));
    left: 50%;
    transform: translateX(-50%);
    z-index: 60;
    padding: calc(4px * var(--ui-scale, 1)) calc(10px * var(--ui-scale, 1));
    background: rgba(6, 10, 36, 0.9);
    border: 2px solid #f4f4f4;
    line-height: 0;
    pointer-events: none;
    opacity: 0;
    transition: opacity 250ms;
  `;
  document.body.appendChild(toast);
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyM' || e.repeat) return;
    const next = !audioSettings().music;
    setAudioSettings({ music: next });
    // 文字はドット文字の canvas で描く（DOMの文字はにじむ。フェーズWW-71）
    setPixelText(toast, next ? '♪ BGM オン' : '♪ BGM オフ（Mで戻す）', { color: '#ffe066' });
    toast.style.opacity = '1';
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      toast.style.opacity = '0';
    }, 1400);
  });
}

// 試合終了は winner が確定して以降、状態変化のたびに何度も refresh() が呼ばれ続けるため
// （hud.update自体は毎回同じ内容を描き直すだけで無害だが）、勝敗確定の効果音は
// 二重発火を避けて最初の1回だけ鳴らす。
let winAnnounced = false;
/** 決着してからランの画面が出るまでの残り時間（フェーズF-26-6。GAME_RESULT_PAUSE_SEC） */
let resultPauseRemaining = 0;

/**
 * アクターの購読をまとめて張り直す（フェーズF-26-6）。**試合ごとにアクターを作り直す**
 * ので、購読も試合ごとに張り直す必要がある。呼ぶのは `startGame` の中の1か所だけ
 * （＝購読が二重に積み上がる経路が無い）。
 *
 * `batting.syncStance` を同じ購読に相乗りさせているのは、打者が変わった瞬間に
 * 見た目の左右を判定側と揃えるため（フェーズB-9。詳細は下記 batting の生成箇所）。
 */
function subscribeActors(): void {
  gameActor.subscribe(() => {
    refresh();
    batting.syncStance();
    const decided = gameActor.getSnapshot().context.winner;
    if (decided !== null && !winAnnounced) {
      winAnnounced = true;
      sfx.win();
      // 勝敗のジングル（ブラッシュアップ：BGM）。**人間が勝ったか**で曲を変える
      // （2P PLAY は両側が人間なので必ず勝利の曲）。ループ曲はここで止める＝決着の後は静かに。
      music.stop();
      music.jingle(controllers[decided] !== 'cpu' ? 'win' : 'lose');
      // 決着の表示（サヨナラのバナー・スコアボード・勝者）を読み切る間を置いてから
      // ランの画面へ移る（メインループが消化する）。
      resultPauseRemaining = GAME_RESULT_PAUSE_SEC;
    }
  });
  modeActor.subscribe(refresh);
}

// ---- 入力結線 ----

// **プレイヤーは2人ぶん常に用意する**（フェーズD-20）。1P PLAY でも2P側のパッドは
// 存在するが、`controllers` がどの側にも割り当てないので入力は全部落ちる。
const pads: Record<PlayerSlot, VirtualPad> = {
  p1: createKeyboardPad(PLAYER1_KEYS),
  p2: createKeyboardPad(PLAYER2_KEYS),
};
const padList = [pads.p1, pads.p2];
/** モード選択・試合結果のように「どちらのプレイヤーが押してもよい」画面に渡す */
const anyPad = createMergedPad(padList);

// 2P/CPU操作分離（セッション7、セッション9ででっかいモードにも拡張、フェーズD-20で
// 2人の人間に一般化）：試合開始前にプレイヤーが「モード（1P/2P）」「先攻・後攻の球団」
// 「球場」「（1P PLAYなら）操作するチーム」を選ぶ（runTeamSelect、メインループ開始前に
// ブロックする。球団選択はフェーズC-13で追加）。
// ちっちゃいモードはCPUが担う側を簡易CPU（着地点へ自動追跡→自動捕球→自動送球）が
// 守備代行し、人間が攻撃側のときは走塁（B=進塁/A=帰塁）を操作する（セッション7）。
// でっかいモード（投球・打撃）は、人間が投手側のときだけ人間がA/D・K・W/Sで
// 投球を操作し、CPUが投手側のときは core/cpuPitcher.ts が狙い・投球タイミングを
// 自動で決める。逆に人間が打者側のときだけKでスイングを操作し、CPUが打者側のときは
// core/cpuBatter.ts がスイングタイミングを自動で判断する。
//
// **どの側を誰が操作するかは `controllers` の1か所**（フェーズD-20。core/players.ts）。
// D-20より前の `humanSide: TeamSide` は「もう一方は必ずCPU」を前提にしていたので、
// 2P PLAY では成り立たない（実際、ちっちゃいモードは「守備が人間＝攻撃はCPU」として
// 走者を自動で動かしていた）。
let controllers: SideControllers = controllersFor('1p', 'home');
/** runTeamSelect 完了後に true。チーム選択オーバーレイ表示中はゲーム側の入力処理を止める
 *（pad.onPress はチーム選択のハンドラと同じボタンを共有するため、二重発火を避ける）。 */
let gameStarted = false;

/**
 * 進行中のラン（フェーズF-26-6。5試合の勝ち抜き）。**試合の外側の状態**なので
 * `gameMachine` のコンテキストには持たせず、球場（C-14）と同じく main.ts が持つ
 * ＝1試合のルール・判定はランを知らないまま従来どおり動く。
 * チーム選択が終わるまでは null（＝まだランが始まっていない）。
 */
let run: RunState | null = null;
/**
 * 2P PLAY の対戦カード（フェーズD-20。null なら1P PLAY＝ランを走らせている）。
 * **2P はランの外＝1試合完結**なので、持つのは結果画面に出す球団の組だけ。
 */
let twoPlayerMatch: { away: TeamId; home: TeamId } | null = null;
/** ランの画面（試合結果・次の相手・チーム選択）が開いている間は全アクターを止める */
let runScreenOpen = false;

// ---- デバッグモード（フェーズPP-64。詳細は `src/debug/practice.ts`） ----
//
// **null なら通常のプレイ**＝この3つの変数を見ている場所以外、main.ts は1つも変わっていない
// （デバッグ用の別経路を作らず、**試合状態へ送るイベントを選ぶ**だけ＝本番と同じ帰結が出る）。

/** いま走っているデバッグモード（null＝通常のプレイ） */
let practice: PracticeMode | null = null;
/** `pitch` モードで、CPU打者が振るか（数字キー1で切替。既定は振らない＝投球だけを見る） */
let practiceSwing = false;
/** `field` モードのノックの設定（方向・種類・走者） */
let practiceKnock: KnockSetup = INITIAL_KNOCK;
/** `brawl` モードの設定（相手の動き・超必殺・相手の必殺技） */
let practiceBrawl: BrawlPracticeSetup = INITIAL_BRAWL_PRACTICE;
/** 投球・打撃・守備のモードで試している札の番号（-1＝札なし。フェーズYY-73） */
let practiceSkill = -1;

/** デバッグ行を書き直す（設定を触ったときと試合開始時だけ呼ぶ） */
function syncPracticeHud(): void {
  hud.setDebugLine(
    practice === null
      ? null
      : practiceHudLines(practice, {
          swing: practiceSwing,
          knock: practiceKnock,
          brawl: practiceBrawl,
          skill: practiceSkill,
        }),
  );
}

function currentHalf(): Half {
  return gameActor.getSnapshot().context.half;
}

/** 守備側を操作している人間（CPU守備なら null）。役割束縛パッドの解決もこれを通る */
function defensePlayerNow(): PlayerSlot | null {
  return defensePlayer(controllers, currentHalf());
}

/** 攻撃側を操作している人間（CPU攻撃なら null） */
function offensePlayerNow(): PlayerSlot | null {
  return offensePlayer(controllers, currentHalf());
}

function isDefenseHuman(): boolean {
  return defensePlayerNow() !== null;
}

// でっかいモードへの2P/CPU操作分離拡張（セッション9）：投球と打撃は必ず「表裏で入れ替わる
// 別チームの役割」なので、fieldingTeam/battingTeam は常に互いに逆を指す。**フェーズD-20
// より前はここに「人間は1人」という前提が乗っていた**（isPitchingHuman と isBattingHuman は
// 常にどちらか片方だけが true）が、2P PLAY では両方 true になりうる＝この2つは
// 「その役割を人間が操作しているか」だけを意味する（＝CPUに任せるかの判断）。
// **誰の入力かは各パッド（defensePad/offensePad と、押下ハンドラのプレイヤー識別）が持つ。**
function isPitchingHuman(): boolean {
  return isDefenseHuman();
}

function isBattingHuman(): boolean {
  return offensePlayerNow() !== null;
}

// **役割に束縛したパッド**（フェーズD-20）：投球・銃・守備は守備側の、打撃・走塁は攻撃側の
// パッドを読む。攻守が入れ替わっても渡し直しは要らない（読むたびに解決する）ので、
// 各コントローラーは「1枚のパッドを受け取る」という従来の形のまま2人に対応できる。
// **CPUが担っている側では何も押されていないパッド**になる＝人間のキーが相手の動作へ
// 漏れ込む経路が構造的に無い（旧実装は `isBattingHuman()` の分岐でこれを手当てしていた）。
const defensePad = createRolePad(padList, () => {
  const player = defensePlayerNow();
  return player === null ? null : pads[player];
});
const offensePad = createRolePad(padList, () => {
  const player = offensePlayerNow();
  return player === null ? null : pads[player];
});

function gameIsOver(): boolean {
  return gameActor.getSnapshot().context.winner !== null;
}

// ---- 選手の能力値の解決（フェーズB-8） ----
//
// ロスター（誰が打席か・誰がマウンドか・誰が塁にいるか）を知っているのは main.ts だけなので、
// 「能力値を引いて渡す」役はここに集約する。各コントローラー（打撃・投球・守備）は
// 能力値の**値**だけを受け取り、ロスターの構造には一切依存しない。
// 交代・打順の進行で対象は毎球変わりうるため、保持せず毎回問い合わせる。

/** 今打席に立っている打者の打撃能力（打球初速・芯を外したときの減衰に効く） */
function currentBattingProfile(): BattingProfile {
  const ctx = gameActor.getSnapshot().context;
  const roster = ctx.rosters[battingTeam(ctx.half)];
  // スキルの補正込みで読む（フェーズF-26-1）。`キンニク` のようなレーティング補正が
  // 打球初速にもHUDの表示本塁打数にも同じ経路で効く。
  // **イニングを渡すのは好調（フェーズD-19）のため**：ゼッコーチョーもラッキー7も
  // AV/HR への補正なので、渡しさえすれば打球への効き方はスキルとまったく同じ経路を通る。
  // **負けているか**は `火事場の力`（フェーズYY-73）の条件
  const batting = effectiveBatting(roster, currentBatterId(roster), ctx.inning, battingTrailing());
  return { power: batting.power, average: batting.average };
}

/** 攻撃側がいま負けているか（`火事場の力` の条件。フェーズYY-73） */
function battingTrailing(): boolean {
  const ctx = gameActor.getSnapshot().context;
  const side = battingTeam(ctx.half);
  const other = side === 'away' ? 'home' : 'away';
  return ctx.score[side] < ctx.score[other];
}

// ---- スキルの見た目と音（フェーズYY-73） ----
//
// **誰が何を持っているかが体に出る**（`dressPlayer`＝毎フレーム呼んでも、札の並びが同じなら
// 何もしない）＋**効いた瞬間に閃いて鳴る**（`skillMoment`）＋**読みの札が見せるもの**
// （`syncSkillSight`）。どれも判定には触らない。

/** その選手のいま生きている札（使い切った消費型は外れる＝見た目も消える） */
function liveSkillsIn(roster: GameContext['rosters']['away'], id: string | undefined): readonly SkillId[] {
  return id !== undefined && roster.players[id] ? liveSkillsOf(roster, id) : [];
}

/** 一番レアな札の音を鳴らす（同時に効く札が複数でも、音は1つにまとめる） */
function playSkillSound(skills: readonly SkillId[], strength: number): void {
  const loudest = [...skills].sort((a, b) => (SKILLS[b]?.rarity ?? 0) - (SKILLS[a]?.rarity ?? 0))[0];
  if (loudest) sfx.skill(SKILL_SOUND[loudest], strength);
}

/** その瞬間に効く札があれば、その場所で閃いて鳴る */
function skillMoment(
  skills: readonly SkillId[],
  moment: SkillMoment,
  at: THREE.Vector3,
  strength: number,
  soundStrength = strength,
): void {
  const hits = skillsAtMoment(skills, moment);
  if (hits.length === 0) return;
  skillFx.burst(at, hits, strength);
  playSkillSound(hits, soundStrength);
}

/** 全員に札の見た目を着せる（毎フレーム。変わった選手だけ着替える） */
function syncSkillLooks(): void {
  const ctx = gameActor.getSnapshot().context;
  const bat = ctx.rosters[battingTeam(ctx.half)];
  const fld = ctx.rosters[fieldingTeam(ctx.half)];
  dressPlayer(pitcher, liveSkillsIn(fld, fld.pitcher));
  dressPlayer(batter, liveSkillsIn(bat, currentBatterId(bat)));
  dressPlayer(catcher, liveSkillsIn(fld, fld.positions.C));
  for (const f of fielders) dressPlayer(f.group, liveSkillsIn(fld, fld.positions[f.id as FieldingPosition]));
  for (const r of fieldPlay.runnersOnField()) dressPlayer(r.mesh, liveSkillsIn(bat, r.id));
}

/** 走る足の尾と、走り出した瞬間の閃き（ちっちゃいモード。走力・盗塁の札） */
const runnersStarted = new Set<string>();
let trailFrame = 0;
function syncRunnerSkillFx(): void {
  if (currentMode() !== 'chicchai' || !fieldPlay.isActive()) {
    runnersStarted.clear();
    return;
  }
  const ctx = gameActor.getSnapshot().context;
  const bat = ctx.rosters[battingTeam(ctx.half)];
  trailFrame += 1;
  for (const r of fieldPlay.runnersOnField()) {
    if (!r.running) continue;
    const skills = liveSkillsIn(bat, r.id);
    const runSkills = skillsAtMoment(skills, 'run');
    if (!runnersStarted.has(r.id)) {
      runnersStarted.add(r.id);
      const at = r.mesh.position.clone().setY(2.5);
      skillMoment(skills, 'lead', at, 0.6);
      if (runSkills.length > 0) playSkillSound(runSkills, 0.45);
    }
    if (runSkills.length > 0 && trailFrame % 2 === 0) {
      skillFx.trail(r.mesh.position.clone().setY(0.4), runSkills[0], CHICCHAI_PLAYER_SCALE);
    }
  }
}

/**
 * 鷹の読みで出している落下点（無ければ null）。**画面の外にある間は画面端の矢印で方向を出す**
 * （`syncChicchaiCamera`。カメラはボールを追うので、深いフライの落下点は落ちる直前まで画面の
 * 上へはみ出す＝実機で確かめた。走者の矢印と同じ仕組みで、色だけ違う）。
 */
let hawkLanding: { x: number; z: number } | null = null;

/** 守備範囲の輪と落下点の印（ちっちゃいモード。捕球範囲の札・鷹の読み） */
function syncFieldSkillFx(): void {
  if (currentMode() !== 'chicchai' || !fieldPlay.ballInFlight()) {
    skillFx.reachRings(null);
    skillFx.landing(null);
    hawkLanding = null;
    return;
  }
  const ctx = gameActor.getSnapshot().context;
  const fld = ctx.rosters[fieldingTeam(ctx.half)];
  const rings: Array<{ x: number; z: number; radius: number; skill: SkillId }> = [];
  let hawkEye = false;
  for (const f of fielders) {
    const skills = liveSkillsIn(fld, fld.positions[f.id as FieldingPosition]);
    if (sightOf(skills).landing) hawkEye = true;
    const catchSkills = skillsAtMoment(skills, 'catch');
    if (catchSkills.length === 0) continue;
    rings.push({
      x: f.group.position.x,
      z: f.group.position.z,
      radius: CATCH_RADIUS + catchRadiusBonusOf(f.id as FieldingPosition),
      skill: catchSkills[0],
    });
  }
  skillFx.reachRings(rings.length > 0 ? rings : null);
  hawkLanding = hawkEye ? fieldPlay.landingPoint() : null;
  skillFx.landing(hawkLanding);
}

/**
 * 読みの札（でっかいモード。`テレパシー`・`未来視`・`心眼`）。**CPU投手が決めた狙いと球の形を
 * そのまま読む**＝見える場所へ必ず来る。人間が投げる球は投げる前に形が無いので読めない。
 */
let sightPlanKey: unknown = null;
let sightPath: SightPoint[] | null = null;
function syncSkillSight(): void {
  const clear = (): void => {
    hud.setReading(null);
    skillFx.crossing(null);
    skillFx.path(null);
    sightPlanKey = null;
    sightPath = null;
  };
  if (currentMode() !== 'dekkai' || isPitchingHuman()) return clear();
  const ctx = gameActor.getSnapshot().context;
  const bat = ctx.rosters[battingTeam(ctx.half)];
  const sight = sightOf(effectiveSkillsForSight(bat, currentBatterId(bat)));
  const peek = cpuPitcher.peek();
  if (!peek || Object.keys(sight).length === 0) return clear();
  if (peek.plan !== sightPlanKey) {
    sightPlanKey = peek.plan;
    const fld = ctx.rosters[fieldingTeam(ctx.half)];
    const stats = effectivePitching(fld, fld.pitcher);
    sightPath = predictCpuPitchPath(
      peek.shape,
      armReleaseHeight(currentPitchArm()),
      neutralSpeedFor(stats?.speed),
    );
  }
  hud.setReading(readingText(peek.plan, sight, currentBatterSide()));
  skillFx.crossing(sight.crossing && sightPath ? plateCrossing(sightPath) : null);
  skillFx.path(sight.path ? sightPath : null);
}

/** 読みに使う札（**切ってある一時効果も含む**＝`絶対予知` は切った打席だけ見える） */
function effectiveSkillsForSight(roster: GameContext['rosters']['away'], id: string): readonly SkillId[] {
  return roster.players[id] ? effectiveSkillsOf(roster, id) : [];
}

/**
 * 時間停止（`時間停止`・`絶対予知`）。**人間が打つとき、球が本塁の手前にある間だけ**
 * 時間が遅くなる（ゲームの時計ごと遅くする＝判定も同じだけ遅い＝判定の中身は変わらない）。
 */
let slowActive = false;
function skillTimeScale(): number {
  const was = slowActive;
  slowActive = false;
  if (currentMode() !== 'dekkai' || !isBattingHuman() || !pitching.isPitchLive()) return 1;
  const ctx = gameActor.getSnapshot().context;
  const bat = ctx.rosters[battingTeam(ctx.half)];
  if (!sightOf(effectiveSkillsForSight(bat, currentBatterId(bat))).slow) return 1;
  if (!inSlowZone(ball.position.z)) return 1;
  slowActive = true;
  if (!was) {
    sfx.skill('tick', 0.7);
    hud.slowTint(true);
  }
  return SLOW_TIME_SCALE;
}

/**
 * 今打席に立っている打者が好調か（フェーズD-19）。**見た目（バットをクルクル回す）
 * だけに使う**：打球への効果は上の `currentBattingProfile` が能力値として渡すので、
 * ここは「投げる側が投げる前に読み取れる手がかり」を出すための問い合わせ。
 */
function currentBatterIsHot(): boolean {
  const ctx = gameActor.getSnapshot().context;
  const roster = ctx.rosters[battingTeam(ctx.half)];
  return isHot(roster, currentBatterId(roster), ctx.inning);
}

/**
 * 今打席に立っている打者の左右（BOX。フェーズB-9）。打席の立ち位置・バットの到達範囲・
 * 引っ張り方向・死球ゾーン・銃の命中ゾーンが、この符号でまとめて鏡像になる。
 *
 * **両打ち（S）は相手投手の腕で決まる**ので、打者だけでなくマウンドの投手も見る
 * （継投で相手が代われば、同じ打者でも立つ打席が変わる＝実際の野球と同じ）。
 * 打者交代・継投は投球動作中には起きない（采配メニューは ready フェーズだけ。
 * canOpenManagerMenu）ので、1球の途中で判定ゾーンが動くことはない。
 */
function currentBatterSide(): BatterSide {
  const ctx = gameActor.getSnapshot().context;
  const batting = ctx.rosters[battingTeam(ctx.half)];
  const fielding = ctx.rosters[fieldingTeam(ctx.half)];
  const bats = batting.players[currentBatterId(batting)].batting.bats;
  // 投手として起用されている選手は必ず pitching を持つ（roster.ts）。万一欠けても
  // 打席が決まらず止まることのないよう、右投手として扱う。
  const throws = fielding.players[fielding.pitcher].pitching?.throws ?? 'R';
  return effectiveBattingHand(bats, throws) === 'L' ? LEFT_BATTER_SIDE : RIGHT_BATTER_SIDE;
}

/**
 * 今マウンドにいる投手の投球腕（説明書のARM。フェーズCC-50）。
 *
 * **`currentBatterSide` とまったく同じ材料（守備側のロスターの投手の `throws`）を
 * 同じ読み方（`pitchArmOf` / `effectiveBattingHand`）で畳む**ので、「両打ちが左打席に
 * 立っているのに投手は右腕で投げている」という食い違いが構造的に起きない。
 * ここから**投げる腕の見た目**と**ボールが出るX**の両方が決まる。
 */
function currentPitchArm(): PitchArm {
  const ctx = gameActor.getSnapshot().context;
  const fielding = ctx.rosters[fieldingTeam(ctx.half)];
  // 投手として起用されている選手は必ず pitching を持つ（roster.ts）。万一欠けていても
  // 投球が止まらないよう、`currentBatterSide` と同じく右投手として扱う。
  return pitchArmOf(fielding.players[fielding.pitcher].pitching?.throws ?? 'R');
}

/**
 * 今の打者の打席内の立ち位置（打者ローカルXのオフセット。フェーズO-36）。
 *
 * **真実は打撃コントローラーが持つ**（入力で動かし、見た目もそこから書く）ので、
 * 死球ゾーン（`judgePitch`）・銃の命中ゾーン（`judgeShot`）・CPU投手の狙い（`batterAimX`）は
 * すべてこの1か所を通して読む＝`currentBatterSide` とまったく同じ配り方。
 */
function currentBatterStance(): number {
  return batting.stanceOffset();
}

/**
 * 今マウンドにいる投手の疲労0..1（フェーズB-11）。投球数（gameMachine が PITCH_THROWN で
 * 記録）とスタミナから導出される値で、球速・変化量・打たれたときの球威にまとめて効く。
 * **投手が疲れているかどうかは攻守どちらの側でも同じ計算**（守備側のロスターから引く）。
 */
function currentPitcherFatigue(): number {
  const ctx = gameActor.getSnapshot().context;
  const roster = ctx.rosters[fieldingTeam(ctx.half)];
  return fatigueOf(roster, roster.pitcher);
}

/**
 * 今マウンドにいる投手の投球能力（球速・変化量に効く）。
 * **疲労はここで能力値そのものに織り込む**（フェーズB-11）ので、人間の投球・CPUの投球
 * （cpuPitcher は下でこの speed を読む）・飛行中の曲がりのすべてに一度に効く。
 */
/**
 * 今マウンドにいる投手の制球 0..1（フェーズT-41）。**CPUが狙いをどれだけ外すか**にだけ効く
 * （人間の投球は今までどおり狙ったところへ行く＝ユーザー判断。人間側は下の
 * `currentPitcherCourse` が「狙える幅」として受け取る）。
 *
 * **W-44で2つ増えた**：(1) ERAはスキルの補正対象になった（`effectivePitching` が
 * `eraWithControl` で書き戻すので、ここは今までどおり ERA を読むだけで効く）。
 * (2) **疲労を掛ける**＝B-11の「疲労で効くのは球速・変化量・球威の3つ」に4つ目が付いた。
 * ただしCPU投手はJ-30の自動継投が残量0.5で代えるので、実際に効くのは
 * **ブルペンが尽きた場面だけ**（計測：16球団の最大疲労は平均0.091）。
 */
function currentPitcherControl(): number {
  const ctx = gameActor.getSnapshot().context;
  const roster = ctx.rosters[fieldingTeam(ctx.half)];
  const stats = effectivePitching(roster, roster.pitcher);
  // 投球能力を持たない選手がマウンドにいても止まらないよう基準値（＝従来と同じ狙い）へ落とす
  if (!stats) return NEUTRAL_RATING;
  return fatiguedControl(pitcherControl(stats.era), fatigueOf(roster, roster.pitcher));
}

/**
 * **人間が投げるときのコース入力の効き幅**の材料（フェーズW-44）。
 *
 * CPU側（上の `currentPitcherControl`）が「狙いがどれだけ外れるか」を受け取るのに対し、
 * 人間側が受け取るのは「**狙える幅**」＝押した向きへは必ず動き、動く量だけが増減する
 * （T-41のユーザー判断「人間の投球は狙ったところへ行く」を崩さない形。B-11が疲労で
 * 球速・変化量を痩せさせているのとまったく同じ扱い）。
 *
 * 渡すのは**名鑑のERAからの差**（`controlBonusOf`）で、素のERAは効かせない＝
 * **スキルを持たない無傷の投手は W-44 の前と1mmも変わらない**。
 */
function currentPitcherCourse(): { controlBonus: number; fatigue: number } {
  const ctx = gameActor.getSnapshot().context;
  const roster = ctx.rosters[fieldingTeam(ctx.half)];
  return {
    controlBonus: controlBonusOf(roster, roster.pitcher),
    fatigue: fatigueOf(roster, roster.pitcher),
  };
}

function currentPitchProfile(): PitchProfile {
  const ctx = gameActor.getSnapshot().context;
  const roster = ctx.rosters[fieldingTeam(ctx.half)];
  const stats = effectivePitching(roster, roster.pitcher);
  // 投手として起用されている選手は必ず pitching を持つ（roster.ts で投手だけに持たせている）。
  // 万一欠けていても投球が止まらないよう、基準値の投手として扱う。
  if (!stats) {
    return {
      speed: NEUTRAL_RATING,
      breakLeft: NEUTRAL_RATING,
      breakRight: NEUTRAL_RATING,
      fork: NEUTRAL_RATING,
    };
  }
  const fatigue = fatigueOf(roster, roster.pitcher);
  return {
    speed: fatiguedSpeed(stats.speed, fatigue),
    breakLeft: fatiguedBreak(stats.breakLeft, fatigue),
    breakRight: fatiguedBreak(stats.breakRight, fatigue),
    // **Fにも疲労を掛ける**（フェーズO-35）。FはR/Lと同じ「曲がりの強さ」になったので、
    // B-11がユーザー判断で確定した3つ（球速・**変化量**・球威）の「変化量」に素直に含まれる
    // ＝4つ目を足したのではなく、**変化量の残り1つがようやく揃った**。疲れた投手の
    // フォークだけ曲がり続ける、という食い違いが構造的に起きない。
    fork: fatiguedBreak(stats.fork, fatigue),
  };
}

/**
 * 走者の走る速さ（走力＝RUNの反映）。塁上の走者も打者走者も攻撃側チームの選手なので、
 * 打者側のロスターから引く（交代した選手も players には残り続けるので必ず見つかる）。
 */
function runnerSpeedOf(id: RunnerId): number {
  const ctx = gameActor.getSnapshot().context;
  const roster = ctx.rosters[battingTeam(ctx.half)];
  // スキル補正込み（`スケボー` 等）。走力の上限そのものは動かさないので、
  // 「野手の足より遅い＝挟殺が成立する」という前提（CLAUDE.md ⑥）は保たれる。
  return runnerSpeed(roster.players[id] ? effectiveBatting(roster, id).run : NEUTRAL_RATING);
}

/**
 * その走者がスキル `バイク`（フェーズF-26-3）を持っているか。走力（runnerSpeedOf）と
 * 違ってレーティングに畳めない**動詞系**のスキルなので、問い合わせの形も別に持つ
 * （銃が `canShootGun` で問い合わされるのと同じ）。
 */
function canBikeOf(id: RunnerId): boolean {
  const ctx = gameActor.getSnapshot().context;
  const roster = ctx.rosters[battingTeam(ctx.half)];
  // 常設の `バイク` か、消費型 `ニトロ` のチャージが残っていれば乗れる（F-26-8）。
  // **問い合わせる側は動詞の名前しか知らない**ので、消費型を足しても分岐は増えない。
  return roster.players[id] !== undefined && canUseVerb(roster, id, 'baiku');
}

/**
 * その走者がスキル `ドロップキック`（フェーズF-26-4）を持っているか。
 * バイク（canBikeOf）と同じ**動詞系**の問い合わせで、解決先も同じ攻撃側のロスター。
 */
function canDropkickOf(id: RunnerId): boolean {
  const ctx = gameActor.getSnapshot().context;
  const roster = ctx.rosters[battingTeam(ctx.half)];
  // 常設の `ドロップキック` か、消費型 `テツゲタ` のチャージ（F-26-8）。canBikeOf と同じ形。
  return roster.players[id] !== undefined && canUseVerb(roster, id, 'doroppukikku');
}

/**
 * 走者が動詞を1回使ったことをロスターへ記録する（フェーズF-26-8）。
 * **常設の札を持っている走者なら何も起きない**ので、シーン層は「いま使ったのは常設か
 * 消費型か」を判断しなくてよい（判断は `useVerb` の1か所に閉じている）。
 */
function recordVerbUse(id: RunnerId, verb: SkillId): void {
  const ctx = gameActor.getSnapshot().context;
  const side = battingTeam(ctx.half);
  if (ctx.rosters[side].players[id] === undefined) return;
  gameActor.send({ type: 'VERB_USED', side, playerId: id, verb });
}

/**
 * その走者のドロップキックの射程 m（フェーズF-26-5。デュオ `ロケットキック` で伸びる）。
 * **素の定数に補正を足すだけ**なので、スキルを持たない走者では必ず `DROPKICK_RANGE` に戻る。
 */
function dropkickRangeOf(id: RunnerId): number {
  const ctx = gameActor.getSnapshot().context;
  const roster = ctx.rosters[battingTeam(ctx.half)];
  if (roster.players[id] === undefined) return DROPKICK_RANGE;
  return DROPKICK_RANGE + (effectivePlay(roster, id).dropkickRange ?? 0);
}

/** その走者の盗塁のスタート位置 m（フェーズF-26-5。ドウブツ系統 `ウサギ`/`ウマ` で深くなる） */
function stealLeadOf(id: RunnerId): number {
  const ctx = gameActor.getSnapshot().context;
  const roster = ctx.rosters[battingTeam(ctx.half)];
  if (roster.players[id] === undefined) return STEAL_LEAD;
  // リードが深すぎると塁から離れすぎて逆にけん制で刺されるので、けん制の上限（MAX_LEAD）で
  // 頭打ちにする＝**盗塁のスタートだけが、けん制で許される深さを超えることはない**。
  return Math.min(MAX_LEAD, STEAL_LEAD + (effectivePlay(roster, id).stealLead ?? 0));
}

/**
 * その守備位置の選手の捕球半径の上乗せ m（フェーズF-26-5。ドウブツ系統 `イヌ`/`タカ` 等）。
 * **走者系の問い合わせと解決先が逆**（守備側チームのロスター）で、守備位置→選手の対応は
 * B-10の `positions` を引く＝代打・継投で守備位置に入った選手のスキルがそのまま効く。
 */
function catchRadiusBonusOf(id: FieldingPosition): number {
  const ctx = gameActor.getSnapshot().context;
  const roster = ctx.rosters[fieldingTeam(ctx.half)];
  const playerId = roster.positions[id];
  return playerId === undefined ? 0 : (effectivePlay(roster, playerId).catchRadius ?? 0);
}

/**
 * その守備位置の選手が送球するときの腕（フェーズHH-55。見た目だけ）。
 * **解決先は捕球半径と同じ守備側チームのロスター**で、実データを持つのは投手だけ
 * （`fielderThrowArm`）＝継投すればマウンドの送球の腕も一緒に替わる。
 */
function throwArmOf(id: FieldingPosition): PitchArm {
  const ctx = gameActor.getSnapshot().context;
  return fielderThrowArm(ctx.rosters[fieldingTeam(ctx.half)], id);
}

// ---- 一時効果（フェーズM-33。CLAUDE.md ⑧「一時効果」） ----
//
// **Gの空いていた2つのスロットに入る**（でっかいモードの打者側／ちっちゃいモードの守備側）。
// 銃・ドロップキックと同じで、ロスターを知っているここが「誰が切るか」を解決し、
// シーン側とHUDは問い合わせるだけにする。

/**
 * いまの打者が切れる一時効果（`シニモノグルイ`・`ゼッタイヨチ`）。無ければ null。
 * **HUDのヒントもGの処理もこれ1つを見る**ので、見えている操作と効く操作がずれない。
 */
function battingEffectReady(): SkillId | null {
  const ctx = gameActor.getSnapshot().context;
  const roster = ctx.rosters[battingTeam(ctx.half)];
  return activatableEffect(roster, currentBatterId(roster), 'batting');
}

/** 打者側の一時効果を切る（でっかいモードの打者側のG） */
function activateBattingEffect(): void {
  const ctx = gameActor.getSnapshot().context;
  const side = battingTeam(ctx.half);
  const playerId = currentBatterId(ctx.rosters[side]);
  if (activatableEffect(ctx.rosters[side], playerId, 'batting') === null) return;
  gameActor.send({ type: 'EFFECT_ACTIVATED', side, playerId, role: 'batting' });
  sfx.skillActivate();
  // 切った瞬間に体が閃いて鳴る（フェーズYY-73）
  skillMoment(liveSkillsIn(ctx.rosters[side], playerId), 'atBat', batter.position.clone().setY(1.3), 1);
}

/**
 * その守備位置の選手が、いま一時効果を切ったら**捕球半径がいくつ増えるか** m
 * （フェーズM-33）。切れなければ 0。
 *
 * **札そのものの値を読む**（`SKILLS[id].play.catchRadius`）ので、`ケモノガエリ` の
 * 数値を変えればシーンの判断もCPUの判断も一緒に動く＝定数の写し取りを作らない。
 */
function catchEffectGainOf(id: FieldingPosition): number {
  const ctx = gameActor.getSnapshot().context;
  const roster = ctx.rosters[fieldingTeam(ctx.half)];
  const playerId = roster.positions[id];
  if (playerId === undefined) return 0;
  const skillId = activatableEffect(roster, playerId, 'fielding');
  return skillId === null ? 0 : (skillDef(skillId).play?.catchRadius ?? 0);
}

/** 守備側の一時効果が実際に切られた（人間のG／CPUの判断のどちらもここへ来る） */
function onCatchEffect(id: FieldingPosition): void {
  const ctx = gameActor.getSnapshot().context;
  const side = fieldingTeam(ctx.half);
  const playerId = ctx.rosters[side].positions[id];
  if (playerId === undefined) return;
  gameActor.send({ type: 'EFFECT_ACTIVATED', side, playerId, role: 'fielding' });
  sfx.skillActivate();
  const f = fielders.find((e) => e.id === id);
  if (f) skillMoment(liveSkillsIn(ctx.rosters[side], playerId), 'atBat', f.group.position.clone().setY(3), 1);
}

/** ちっちゃいモードの守備側のGで一時効果を切る */
function activateFieldingEffect(): void {
  fieldPlay.catchEffect();
}

/** 今の打者走者（打球のプレーを始めるときに、その打者を走者として引き継ぐ） */
function currentBatterRunnerId(): RunnerId {
  const ctx = gameActor.getSnapshot().context;
  return currentBatterId(ctx.rosters[battingTeam(ctx.half)]);
}

// 乱闘（v1）：死球発生時点の「カウント・走者状況・打者側チームの打順」を控えておく。
// 乱闘が決着した場合、敗北側の要員入れ替えだけを残して死球そのものを巻き戻す
// （=同じ打席が継続する）ため gameMachine.BRAWL_RESOLVED に渡す
// （詳細は core/gameMachine.ts reduceBrawlResolved のコメント）。
// 乱闘を選ばなかった場合（BRAWL_DECLINED）はこの値を使わないまま捨てる。
let pendingHbpRestore: {
  count: Count;
  bases: Bases;
  baseRunners: BaseRunners;
  battingLineupIndex: number;
} | null = null;

/**
 * 乱闘に持ち込む両者の装備（フェーズF-26-1）。ローグライトのスキルをここで
 * 「体力・威力・出せる技」に翻訳してから乱闘へ渡す。
 *
 * **打者は `pendingHbpRestore.battingLineupIndex` から引く**。死球は起きた瞬間に
 * `HIT_BY_PITCH` で打順を1つ進めてしまう（＝楽観的に打席終了を確定させる。乱闘が
 * 決着したら巻き戻す設計）ので、乱闘に入る時点の `currentBatterId` は**もう次の打者**を
 * 指している。そのまま読むと「殴られた選手ではなく次の打者のスキル」で戦うことになる
 * （実機検証で実際にこの取り違えを踏んだ）。巻き戻し用に控えてある死球直前の打順が
 * そのまま「殴られた打者」なので、そちらを真実として使う。
 *
 * 投手は継投が挟まらないので現在の投手でよい。
 */
function brawlLoadouts(): BrawlLoadouts {
  const ctx = gameActor.getSnapshot().context;
  const battingRoster = ctx.rosters[battingTeam(ctx.half)];
  const fieldingRoster = ctx.rosters[fieldingTeam(ctx.half)];
  const batterId =
    pendingHbpRestore === null
      ? currentBatterId(battingRoster)
      : battingRoster.lineup[pendingHbpRestore.battingLineupIndex];
  return {
    batter: brawlLoadoutOf(battingRoster, batterId),
    pitcher: brawlLoadoutOf(fieldingRoster, fieldingRoster.pitcher),
  };
}

/**
 * 乱闘中の操作説明と技表（フェーズG-27）。**人間が操作している側のぶんだけ**出す
 * （CPUが動かす側の技表は誰の判断材料にもならない）。
 *
 * ここで組むのは、必要な3つがHUDからは見えないため：**誰がどの必殺技を持っているか**
 * （スキル＝`brawl.moveHints`）、**その人が押す向き**（画面左右で「前」が逆＝
 * `commandNotation` が facing から起こす）、**2Pのキー名の読み替え**（D-20の約束＝
 * 1Pのキー名をそのまま見せるのは案内として間違っている）。
 */
function brawlHintText(): { batter: string | null; pitcher: string | null } {
  const half = currentHalf();
  const out: { batter: string | null; pitcher: string | null } = { batter: null, pitcher: null };
  for (const side of ['batter', 'pitcher'] as const) {
    const team = side === 'batter' ? battingTeam(half) : fieldingTeam(half);
    const player = playerOfSide(controllers, team);
    if (!player) continue;
    const label = isTwoPlayer(controllers) ? `${PLAYER_LABEL[player]} ` : '';
    const keys = player === 'p2' ? { a: '[2]', b: '[1]', g: '[3]' } : { a: 'K', b: 'J', g: 'G' };
    // 乱闘v3（XX-72）：P＝パンチ（A）／K＝キック（B）／後ろでガード／近くで横＋Pで投げ
    const lines = [`${label}${keys.a}:パンチ ${keys.b}:キック 後ろ:ガード`, `近くで横+${keys.a}:投げ`];
    for (const hint of brawl.moveHints(side)) {
      // エンジンの表記（P＝パンチ／K＝キック）をその人のキー名へ（1回で置き換える＝
      // 「+P→+K」の後に「+K→+J」が重ねて効いてしまわないように）
      const notation = hint.notation
        .replace(/\+([PK])$/, (_m, b: string) => `+${b === 'P' ? keys.a : keys.b}`)
        .replace('ゲージ満タンでG', `ゲージ満タンで${keys.g}`);
      lines.push(`${hint.name} ${notation}`);
    }
    out[side] = lines.join('\n');
  }
  return out;
}

/** 乱闘のHUDに出す名前（殴られた打者と、いまの投手） */
function brawlNames(): Record<BrawlSide, string> {
  const ctx = gameActor.getSnapshot().context;
  const battingRoster = ctx.rosters[battingTeam(ctx.half)];
  const fieldingRoster = ctx.rosters[fieldingTeam(ctx.half)];
  const batterId =
    pendingHbpRestore === null
      ? currentBatterId(battingRoster)
      : battingRoster.lineup[pendingHbpRestore.battingLineupIndex];
  return {
    batter: battingRoster.players[batterId]?.name ?? '打者',
    pitcher: fieldingRoster.players[fieldingRoster.pitcher]?.name ?? '投手',
  };
}

/**
 * 乱闘のイベント → 音と大きな呼び出し（乱闘v3。フェーズXX-72）。シーンは音を鳴らさない
 * （既存の約束）ので、エンジンが出したイベントをここで音に変える。
 * **音の階層**：決着（KO）＞超必殺・必殺技の命中＞通常技の命中＞技の出だし・動き。
 */
let lastBrawlTick = -1;
function handleBrawlEvents(events: readonly BrawlEvent[], state: BrawlState): void {
  const nameOf = (side: BrawlSide): string => brawlNames()[side];
  for (const e of events) {
    switch (e.k) {
      case 'swing': {
        const def = MOVES[e.move];
        const kick = e.move === 'sK' || e.move === 'crK' || e.move === 'jK' || def.button === 'k';
        if (def.kind === 'normal') sfx.brawlSwing(kick, e.move === 'sK');
        break;
      }
      case 'hit': {
        const pan = Math.max(-0.8, Math.min(0.8, e.x / 4));
        if (e.blocked) sfx.brawlBlock(pan);
        else sfx.brawlImpact(e.heavy, pan);
        break;
      }
      case 'special':
        if (e.move === 'shoryu' || e.move === 'somersault') sfx.brawlRising(e.move === 'shoryu');
        else if (e.move === 'tatsu') sfx.brawlSpin();
        else if (e.move === 'zutsuki' || e.move === 'divekick') sfx.brawlDash();
        else if (e.move === 'kobun') sfx.brawlWhistle();
        else if (e.move === 'hyakuretsu' || e.move === 'buki') sfx.brawlSwing(false, true);
        break;
      case 'super':
        sfx.brawlSuperFlash();
        hud.brawlSuperFlash();
        hud.brawlCallout(MOVE_NAME[e.move], 'super');
        if (e.move === 'batto') sfx.brawlRising(true);
        break;
      case 'projectile':
        if (e.kind !== 'kobun') sfx.brawlProjectile(e.kind === 'shinku');
        break;
      case 'clash':
        sfx.brawlClash();
        break;
      case 'throw':
        sfx.brawlGrab();
        break;
      case 'slam':
        sfx.brawlSlam();
        break;
      case 'throwTech':
        sfx.brawlTech();
        hud.brawlCallout('投げ抜け', 'info');
        break;
      case 'knockdown':
        sfx.brawlThud(true);
        break;
      case 'land':
        sfx.brawlThud(false);
        break;
      case 'dash':
        sfx.brawlDash();
        break;
      case 'dizzy':
        sfx.brawlDizzy();
        break;
      case 'meterFull':
        sfx.brawlMeterFull();
        break;
      case 'round':
        sfx.brawlRound();
        hud.brawlCallout(state.practice ? '練習' : `第${e.round}ラウンド`, 'round');
        break;
      case 'fight':
        sfx.brawlFight();
        hud.brawlCallout('ファイト！', 'fight');
        break;
      case 'ko':
        sfx.ko();
        hud.brawlCallout('K.O.', 'ko');
        break;
      case 'timeUp':
        sfx.brawlTimeUp();
        hud.brawlCallout('タイムアップ', 'timeUp');
        break;
      case 'roundWin':
        hud.brawlCallout(e.winner === 'draw' ? '引き分け' : `${nameOf(e.winner)}の勝ち`, 'win');
        break;
      case 'matchEnd':
        sfx.win();
        hud.brawlCallout(`${nameOf(e.winner)} 乱闘に勝利！`, 'win');
        break;
      default:
        break;
    }
  }
  // 残り10秒の秒読み
  if (state.phase === 'fight' && !state.practice) {
    const sec = Math.ceil(state.timer / 60);
    if (sec <= 10 && sec !== lastBrawlTick && sec > 0) sfx.brawlTick();
    lastBrawlTick = sec;
  }
}

// ---- 死球のあと：乱闘に持ち込むかは打たれた打者側だけが決める（フェーズWW-71） ----

/** 直前の死球が銃によるものか（CPUの打者は銃で撃たれたら必ずやり返す＝`shouldCpuStartBrawl`） */
let hbpByGun = false;
/** CPUの打者が決めるまでの残り時間（`CPU_BRAWL_DECISION_SEC`） */
let cpuBrawlDecisionRemaining = 0;

/** 死球の画面へ入る（普通の死球・銃の命中の両方がここを通る） */
function enterDeadBall(byGun: boolean): void {
  hbpByGun = byGun;
  cpuBrawlDecisionRemaining = CPU_BRAWL_DECISION_SEC;
  modeActor.send({ type: 'DEAD_BALL' });
}

/** 乱闘を始める（人間の打者のJ・CPUの打者の判断の両方がここを通る） */
function startBrawl(): void {
  sfx.brawlStart();
  modeActor.send({ type: 'BRAWL_START' });
  brawl.enter(brawlLoadouts(), brawlNames());
  dressBrawlFighters();
}


/** 乱闘の2人にも札の見た目を着せる（フェーズYY-73） */
function dressBrawlFighters(): void {
  const ctx = gameActor.getSnapshot().context;
  const bat = ctx.rosters[battingTeam(ctx.half)];
  const fld = ctx.rosters[fieldingTeam(ctx.half)];
  const batterId =
    pendingHbpRestore === null ? currentBatterId(bat) : bat.lineup[pendingHbpRestore.battingLineupIndex];
  dressPlayer(brawlFighters.batter, liveSkillsIn(bat, batterId));
  dressPlayer(brawlFighters.pitcher, liveSkillsIn(fld, fld.pitcher));
}

/** 乱闘を見送って一塁へ歩く */
function declineBrawl(): void {
  modeActor.send({ type: 'BRAWL_DECLINED' });
}

/**
 * **CPUの打者が乱闘するかを決める**（死球の画面にいる間、毎フレーム呼ぶ）。
 * 打者側が人間なら何もしない（人間が J/K で決める）。「間」を置いてから決めるので、
 * 人間の投手は `デッドボール！` を読んでから結果を見ることになる（`CPU_BRAWL_DECISION_SEC`）。
 */
function updateCpuBrawlDecision(dt: number): void {
  if (isBattingHuman()) return;
  cpuBrawlDecisionRemaining -= dt;
  if (cpuBrawlDecisionRemaining > 0) return;
  cpuBrawlDecisionRemaining = 0;
  const loadouts = brawlLoadouts();
  if (shouldCpuStartBrawl({ byGun: hbpByGun, batter: loadouts.batter, pitcher: loadouts.pitcher })) {
    startBrawl();
  } else {
    declineBrawl();
  }
}

function captureHbpRestoreSnapshot(): void {
  const ctx = gameActor.getSnapshot().context;
  pendingHbpRestore = {
    count: ctx.count,
    bases: ctx.bases,
    // 走者の識別も一緒に巻き戻す（乱闘で死球が無かったことになったとき、塁上の走者が
    // 誰だったかまで戻らないと走力が入れ替わってしまう）
    baseRunners: ctx.baseRunners,
    battingLineupIndex: ctx.rosters[battingTeam(ctx.half)].lineupIndex,
  };
}

// でっかいモードのCPU投球AI（セッション9・2P/CPU操作分離の拡張）：CPU側が投手のとき、
// 狙うコース・球速をカウントから決め、**そこへ届くリリース位置を逆算して**（フェーズP-37）
// 直接反映してから一定の「間」を置いて投げる
// （詳細は core/cpuPitcher.ts・dekkaiScene.ts createCpuPitcherController）。
const cpuPitcher = createCpuPitcherController(pitcher, {
  // 球速だけでなく変化量（R/L/F）も渡す＝**CPUの球も名鑑の変化量で曲がる**（P-37）。
  // 疲労は currentPitchProfile が織り込むので、疲れたCPU投手は曲がりも落ちる（B-11）。
  pitcherProfile: currentPitchProfile,
  // 制球（フェーズT-41）＝**狙いがゾーンの縁からどれだけ外れるか**。ERAからの導出で、
  // 荒れた投手はボールが先行し、3ボールになると既存の規則で真ん中へ置きにくる。
  pitcherControl: currentPitcherControl,
  // 投球腕（フェーズCC-50）＝**逆算の窓が腕のぶんずれる**。狙うコースは1つも動かない。
  pitcherArm: currentPitchArm,
  // ファウルで粘られた球数（フェーズSS-67）＝**粘られたら反対の隅へ散らす**。
  // これが無いと同じ球を投げ続けて打席が終わらない（`cpuFoulsInAtBat` の説明を参照）。
  foulsInAtBat: cpuFoulsInAtBat,
});

// 投球（ファミスタ'90説明書p19準拠）：人間が投手側のときはA/Dでプレート上を移動、
// Kでワインドアップ開始。ワインドアップ中にW=フォーク/チェンジアップ・S=速球の
// 事前選択（緩急はリリース時に確定、飛行中は変わらない）。リリースの瞬間のA/Dで
// コース投げ分け、リリース後のA/Dでカーブ/シュート。CPUが投手側のときは
// cpuPitcher が狙い・球速を決め、main.tsのメインループが自動でstartPitch()を呼ぶ。
// 打撃：投球が生きている間、人間が打者側ならKでスイング（下のonFlightStepでCPU打者の
// スイングも同じbatting.trySwing()へ合流させる）。
// ---- 盗塁（説明書p13「盗塁しようとすると"ちっちゃいモード"に変わる」） ----
// 投球中に走者が走り出すと画面はちっちゃいモードへ切り替わるが、**その投球自体は
// 裏で最後まで進み、カウントとして決着する**（ユーザー判断：2026-07-23）。そのため
// 「盗塁のプレーが進行中か」を main.ts が持ち、(1)投球の判定を盗塁の決着まで保留する、
// (2)その球を打てる窓（ヒットエンドラン）を決める、の2つに使う。
//
// ---- ヒットエンドラン（フェーズH-28） ----
// **盗塁を仕掛けた球も打てる**（それまでは接触判定ごと止めていた）。画面はすでに
// ちっちゃいモードなので、**攻撃側のKは投球が生きている間だけスイングになる**
// （投球が終われば従来どおり帰塁）＝原作のA/Bが場面で機能を変える多目的ボタン方式の延長。
// 打球が出たら、走っている盗塁のプレーをそのまま打球のプレーへ引き継ぐ
// （fieldPlay.convertToBattedBall）＝走者はスタートを切った分だけ先行したまま走り続ける。

/** 盗塁のプレーが進行中（startSteal〜onSettled）。fieldPlay 側の状態と1対1で対応する */
let stealActive = false;

/**
 * ヒットエンドランの窓が開いているか（フェーズH-28）＝盗塁のプレー中で、その投球が
 * まだ生きている。**Kがスイングになる条件も、画面に出るヒントの条件もこれ1つ**
 * （見えている操作と効く操作が同じ値から起きる）。
 */
function hitAndRunOpen(): boolean {
  return stealActive && pitching.isPitchLive();
}
/** 盗塁中に決着した投球の判定。盗塁の決着を反映してから applyPitchCall に渡す */
let pendingPitch: { call: PitchCall; swung: boolean } | null = null;

/**
 * 1球の判定を試合状態へ反映する（三振/四球/死球の演出もここで一度だけ発火する）。
 * 通常は投球の決着（onJudged）から即座に呼ぶが、盗塁（説明書p13）が進行中の球だけは
 * 保留し、盗塁の決着を反映した後に呼ぶ（applyPendingPitch）。
 */
function applyPitchCall(call: PitchCall, swung: boolean): void {
  if (practice) {
    // デバッグモード（フェーズPP-64）＝**打席が終わる球だけ試合状態へ送らず、カウントを
    // 0-0 に戻す**。判定そのものは本番と同じ純粋関数（`callAfterSwing`→`applyPitch`）を
    // 通してバナーも同じように出すので、**確認したいこと（判定・演出）は1つも欠けない**。
    if (call === 'hitByPitch') {
      sfx.hitByPitch();
      hud.playBanner('walk', 'デッドボール');
      gameActor.send({ type: 'DEBUG_RESET_COUNT' });
      return;
    }
    sfx.mitt();
    const judgement = callAfterSwing(call, swung);
    const outcome = applyPitch(gameActor.getSnapshot().context.count, judgement);
    if (outcome.kind === 'strikeout') {
      sfx.strikeout();
      hud.playBanner('strikeout', '三振！');
      gameActor.send({ type: 'DEBUG_RESET_COUNT' });
    } else if (outcome.kind === 'walk') {
      sfx.walk();
      hud.playBanner('walk', 'フォアボール');
      gameActor.send({ type: 'DEBUG_RESET_COUNT' });
    } else {
      if (judgement === 'ball') hud.playBanner('ball', 'ボール');
      else hud.playBanner('strike', 'ストライク');
      gameActor.send({ type: 'PITCH_RESULT', judgement });
    }
    return;
  }
  if (call === 'hitByPitch') {
    // v1: スイング中でも死球を優先（銃システムの死球フローと同一経路）
    sfx.hitByPitch();
    captureHbpRestoreSnapshot();
    gameActor.send({ type: 'HIT_BY_PITCH' });
    enterDeadBall(false);
    return;
  }
  // 捕手が受けた球（見逃し・空振り）はミットの音。空振りの風切りは振り出した瞬間に鳴っている
  sfx.mitt();
  const judgement = callAfterSwing(call, swung);
  // applyPitch を先読みして三振/四球の演出（バナー+効果音）をここで一度だけ発火する
  // （gameMachine 内部でも同じ純粋関数で同じ判定が行われるが、副作用のない再計算なので
  // 二重に呼んでも安全。決着後は攻守交代/延長判定などをまたぐため main.ts 側で先に判定する）。
  const outcome = applyPitch(gameActor.getSnapshot().context.count, judgement);
  if (outcome.kind === 'strikeout') {
    sfx.strikeout();
    hud.playBanner('strikeout', '三振！');
  } else if (outcome.kind === 'walk') {
    sfx.walk();
    hud.playBanner('walk', 'フォアボール');
  } else {
    // 1球ごとの判定コール（フェーズE-23）。従来は三振・四球という打席の決着しか
    // 見せておらず、それ以外の球は「HUDのカウントの数字が変わるだけ」で何が起きたか
    // 分からなかった。捕球後の「間」（PITCH_SETTLE_SEC）に情報を載せる役目も兼ねる。
    if (judgement === 'ball') hud.playBanner('ball', 'ボール');
    else hud.playBanner('strike', 'ストライク');
  }
  gameActor.send({ type: 'PITCH_RESULT', judgement });
}

/**
 * この打席で直前に本塁を通過した球のコース（打者ローカルX。フェーズO-36）。null=初球。
 * **CPU打者の立ち位置の唯一の材料**（`chooseCpuStance`）で、打席が切り替わるたびに捨てる
 * （`updateInterlude`）＝前の打者への配球が次の打者の構えに残らない。**誰への配球かを
 * 一緒に持つ**のは、間が開く前にも同じことを保証するため（下記 `cpuStanceTarget`）。
 */
let lastPitch: { batterId: string; localX: number } | null = null;

/**
 * CPU打者が寄る先（フェーズO-36）。**この打者への配球でなければ材料にしない。**
 *
 * 打席が切り替わるたびに `updateInterlude` が記憶を捨てるが、**その間が開くのは
 * でっかいモードへ戻ってから**なので、死球で打者が代わった直後（deadBall モード）の
 * ように**打席だけ先に変わっている瞬間**がある。識別を突き合わせておけば、
 * **前の打者への配球で次の打者が寄る**ことが構造的に起きない
 * （実機で踏んだ：死球の直後、まだ1球も受けていない打者が 0.2m 寄って立っていた）。
 */
function cpuStanceTarget(): number {
  const ctx = gameActor.getSnapshot().context;
  const batterId = currentBatterId(ctx.rosters[battingTeam(ctx.half)]);
  return chooseCpuStance(lastPitch && lastPitch.batterId === batterId ? lastPitch.localX : null);
}

/**
 * この打席でファウルにされた球数（フェーズSS-67）。**CPU投手が粘られたら
 * 反対の隅へ散らす**ための材料で、`lastPitch` とまったく同じ「打者の識別で
 * 突き合わせる」形にしてある（打席が替われば 0 に戻る）。
 *
 * ファウルは**カウントを動かさない**ので、これが無いとCPU投手は2ストライクから
 * まったく同じ球を投げ続け、判定が決定的である以上**同じファウルが永久に繰り返される**
 * （実測：144打席のうち5打席が40球の上限に張り付いた＝実機なら打席が終わらない）。
 */
let foulsThisAtBat: { batterId: string; fouls: number } | null = null;

function cpuFoulsInAtBat(): number {
  const ctx = gameActor.getSnapshot().context;
  const batterId = currentBatterId(ctx.rosters[battingTeam(ctx.half)]);
  return foulsThisAtBat && foulsThisAtBat.batterId === batterId ? foulsThisAtBat.fouls : 0;
}

function countFoulInAtBat(): void {
  const ctx = gameActor.getSnapshot().context;
  const batterId = currentBatterId(ctx.rosters[battingTeam(ctx.half)]);
  foulsThisAtBat =
    foulsThisAtBat && foulsThisAtBat.batterId === batterId
      ? { batterId, fouls: foulsThisAtBat.fouls + 1 }
      : { batterId, fouls: 1 };
}

const pitching = createPitchingController({
  pitcher,
  ball,
  // 投球は守備側の操作（フェーズD-20。2P PLAY では相手のパッドは読まない）
  pad: defensePad,
  isCpuTurn: () => !isPitchingHuman(),
  cpuReleaseSpeed: () => cpuPitcher.releaseSpeed(),
  // CPUの変化球（フェーズP-37）。投げる前に解いた形をなぞるだけ＝飛行中は判断しない
  cpuBreak: (sinceRelease, dt) => cpuPitcher.breakAt(sinceRelease, dt),
  pitcherProfile: currentPitchProfile,
  // 死球ゾーンは打者と一緒に動く（左打者には反対側へ曲げないと当たらない）
  batterSide: currentBatterSide,
  // 打席内の立ち位置（フェーズO-36）。**踏み込んでいる打者には内角のボール球が当たる**
  // ＝投手側から見れば、寄られたら内角を突けるが外せば一塁を与える、という綱引きになる。
  batterStance: currentBatterStance,
  // 制球（フェーズW-44）＝**人間が投げるときのコース入力の効き幅**。スキルで広がり、
  // 疲労で痩せる（向きは入力どおりのまま）。CPUの狙いのほうは cpuPitcher 側で効く。
  pitcherCourse: currentPitcherCourse,
  // 投球腕（フェーズCC-50）＝**投げる腕の見た目**と**ボールが出るX**（プレート上の
  // 立ち位置＋腕のずれ）。人間の投球もCPUの投球も同じ1本を通る。
  pitcherArm: currentPitchArm,
  // スタミナ消耗（フェーズB-11）は**リリースの瞬間に1球ずつ**記録する。判定側で数えると
  // 打たれた球（判定を経ずに打球のプレーへ移る）が抜け落ちる。
  onRelease: () => {
    sfx.pitchRelease();
    const before = gameActor.getSnapshot().context;
    const fldSide = fieldingTeam(before.half);
    const pitcherId = before.rosters[fldSide].pitcher;
    const procsBefore = skillProcsOf(before.rosters[fldSide], pitcherId).length;
    gameActor.send({ type: 'PITCH_THROWN' });
    // スキル（フェーズYY-73）：投げた瞬間に球速・変化・制球の札が閃く（毎球なので控えめ）
    const after = gameActor.getSnapshot().context.rosters[fldSide];
    const skills = liveSkillsIn(after, pitcherId);
    const hand = new THREE.Vector3(pitcher.position.x, 1.7, pitcher.position.z + 0.5);
    skillMoment(skills, 'pitch', hand, 0.5, 0.2);
    // 一度だけの給油（予備タンク・不死鳥）＝疲れかけた瞬間に大きく閃いて鳴る
    const procs = skillProcsOf(after, pitcherId);
    if (procs.length > procsBefore) {
      const fired = procs.slice(procsBefore);
      skillFx.burst(pitcher.position.clone().setY(1.1), fired, 1);
      skillFx.burst(pitcher.position.clone().setY(2.0), fired, 1);
      playSkillSound(fired, 1);
    }
  },
  onJudged: (call) => {
    // 判定確定＝この球は終わり。次の球のためにCPU投手の狙いをリセットする
    // （リセットを忘れると次の ready フェーズで前の球の狙いを使い回してしまう）。
    cpuPitcher.reset();
    const swung = batting.consumeSwung();
    // バントはバットを出したまま球を待つ（スイングの時間切れで戻らない）ため、
    // 見送って判定が確定したこのタイミングで打撃動作を終了させる。
    batting.endPitch();
    // 盗塁中の球は、盗塁の決着（塁・アウト）を先に反映してからカウントへ反映する。
    // 逆順にすると、四球で押し出しの進塁を計算した後に盗塁で塁が動く／三振が3アウト目
    // なら盗塁の結果を反映する先のイニングが変わる、といった順序の矛盾が起きる。
    if (stealActive) {
      pendingPitch = { call, swung };
      return;
    }
    applyPitchCall(call, swung);
  },
  onFlightStep: (prev, next, dt) => {
    // でっかいモードのCPU打撃AI（セッション9）：CPUが打者側のとき、着弾までの残り時間が
    // 理想スイング時間としきい値を跨いだ瞬間（＝人間なら「今だ」と判断する頃合い）に
    // 一度だけスイングするか判断する。実際の接触判定は下の batting.checkContact が
    // 既存のジャストミート判定でそのまま行う（曲げ球で予測が外れれば人間同様に凡打/空振りになる）。
    // **盗塁中も同じ判断をそのまま通す**（フェーズH-28。ユーザー判断：CPUもヒットエンドランを
    // やる）＝規則は従来どおり決定的なままで、⑧の「CPUも対等」が走らせて打つ場面にも及ぶ。
    // デバッグモード（フェーズPP-64）：`pitch` は数字キーの切替に従い、`field` は
    // ノックで打球を作るのでCPU打者は振らない（＝投げた球が勝手にプレーへ移らない）。
    const cpuMaySwing = practice === null ? true : practice === 'pitch' ? practiceSwing : false;
    // 判断の時刻はカウントで変わる（フェーズSS-67）＝**追い込まれると窓の縁まで泳ぐ**
    // ので、決め球（S-40の持ち味の球）に空振りが生まれる。
    if (
      cpuMaySwing &&
      !isBattingHuman() &&
      crossesSwingDecisionPoint(prev, next, gameActor.getSnapshot().context.count)
    ) {
      // 打席の左右はCPU打者にも同じように効く（左打者は届く範囲がXについて鏡像）。
      // 立ち位置（フェーズO-36）も同じ＝**寄っているCPU打者は内角を見送る**（届かないので）。
      if (
        shouldCpuSwing(
          next,
          gameActor.getSnapshot().context.count,
          currentBatterSide(),
          currentBatterStance(),
        )
      ) {
        if (batting.trySwing()) sfx.swing();
      }
    }
    // CPU打者の立ち位置の材料（フェーズO-36）＝**この打席で直前に本塁を通過したコース**。
    // 打たれた球は打撃面（本塁より手前）で終わるのでここには来ない＝記憶に残るのは
    // 「見送った/空振りした球」だけになる。
    // **フェーズSS-67：ストライクだった球だけを材料にする**。SS-67でCPU打者がボール球を
    // 見送るようになった結果、それまでほぼ動かなかったこの立ち位置が毎打席動くように
    // なり、**外れた球へ寄る→次の内角で死球**が頻発した（実測 死球 6.3%）。
    // 打者が芯を合わせに行く先は「ストライクが来ているコース」であって、外れた球では
    // ない＝O-36の狙い（同じコースへ続けて投げると狙われる）はそのままに、
    // **荒れ球へ踏み込む**という副作用だけが消える。
    const crossed = plateCrossingX(prev, next);
    if (crossed !== null && judgePitch(crossed, currentBatterSide(), currentBatterStance()) === 'strike') {
      const ctx = gameActor.getSnapshot().context;
      lastPitch = {
        batterId: currentBatterId(ctx.rosters[battingTeam(ctx.half)]),
        localX: batterFrameX(crossed, currentBatterSide()),
      };
    }
    // 接触判定は盗塁中も止めない（フェーズH-28）。打球が出たら、走っている盗塁のプレーを
    // 打球のプレーへ**引き継ぐ**ので、走塁プレーと二重になることはない（下の
    // ヒットストップ明けの分岐で convertToBattedBall を通す）。
    batting.checkContact(prev, next, dt);
  },
});

// 打球の帰結演出（バナー+効果音）。hit が設定されるのは resultFromHit 経由の決着
// （安打・本塁打）のみで、守備側主導の送球判定/フライアウトには付かない
// （chicchaiScene.ts FieldPlayOutcome のコメント参照）。
const HIT_BANNER: Record<HitType, { kind: 'homerun' | 'triple' | 'double' | 'single'; text: string }> = {
  homerun: { kind: 'homerun', text: 'ホームラン！' },
  triple: { kind: 'triple', text: 'スリーベース！' },
  double: { kind: 'double', text: 'ツーベース！' },
  single: { kind: 'single', text: 'ヒット！' },
};

// 守備・走塁：操作野手の捕球/送球（fieldPlay.action、A割り当て）と
// 走者の自動進塁（フォース対象のみ）でアウト/安打/得点を確定する。
const fieldPlay = createFieldPlayController({
  ball,
  shadow: ballShadow,
  fielders,
  runners,
  // 守備（野手の一斉移動・ファインプレイ・送球/ランダンの塁指定）と走塁（進塁/帰塁・
  // バイクの点火・ドロップキック）は**別の人間が同時に操作しうる**ので、パッドも
  // 「人間か」の問い合わせも側ごとに分ける（フェーズD-20）。
  defensePad,
  offensePad,
  isDefenseHuman,
  isOffenseHuman: isBattingHuman,
  // 走者ごとの走力（フェーズB-8）。ちっちゃいモードはロスターを知らないので、
  // 「この走者は何m/sで走るか」だけをここから供給する。
  runnerSpeedOf,
  // スキル `バイク`（フェーズF-26-3）を持つ走者か。走力と同じく、選手データの解決は
  // ロスターを知っている側（ここ）に置き、シーンは問い合わせるだけにする。
  canBikeOf,
  // スキル `ドロップキック`（フェーズF-26-4）を持つ走者か（同上）。
  canDropkickOf,
  // 既存のプレー定数へのスキル補正（フェーズF-26-5）。攻撃側の走者から引くもの2つと、
  // 守備側の野手から引くもの1つ。どれも「素の定数＋補正」なので、スキルが無ければ従来どおり。
  dropkickRangeOf,
  stealLeadOf,
  catchRadiusBonusOf,
  // 送球の腕（フェーズHH-55。見た目だけ）。CC-50 ででっかいモードの投球姿勢が ARM で
  // 鏡像になったので、これが無いと左投げの投手が投手ゴロだけ右で投げることになる。
  throwArmOf,
  // 一時効果（フェーズM-33）。**「これから払えば得られる補正」と「切った」の2本**で、
  // 上の `catchRadiusBonusOf`（もう効いている補正）と対になる。
  catchEffectGainOf,
  onCatchEffect,
  // 蹴りが出たときの効果音（当たり＝乱闘の打撃音、空振り＝空振り音）。**バナーは出さない**：
  // CLAUDE.md ⑧のトーン「ゲーム側は一切ツッコまない」に従い、蹴られた野手が倒れて
  // ボールがこぼれる、という画面上の事実だけで見せる（煽った瞬間にバカゲーに落ちる）。
  onDropkick: (hit, runnerId) => {
    if (hit) sfx.brawlImpact(false);
    else sfx.swingMiss();
    // 消費型 `テツゲタ`（F-26-8）のチャージを1つ使う。**当たっても外れても消費する**
    // ＝1プレーに1回という既存の規則と同じ扱い（当たるまで撃ち直せる札にしない）。
    recordVerbUse(runnerId, 'doroppukikku');
  },
  // バイクの点火（F-26-8。消費型 `ニトロ` のチャージを1つ使う）。常設の `バイク` 持ちなら
  // `useVerb` が何もしないので、シーンからは常に同じように報せてよい。
  onBikeIgnite: (runnerId) => {
    sfx.bikeIgnite();
    recordVerbUse(runnerId, 'baiku');
  },
  // ヒットエンドランの窓（フェーズH-28）。**Kがスイングになる条件（onA）と同じ関数**を
  // 渡すので、画面に出るヒントと実際に効く操作が食い違わない。
  canHitAndRun: hitAndRunOpen,
  // この試合の球場（フェーズC-14）。チーム選択の完了時に決まる＝このコントローラーを
  // 作る時点ではまだ選ばれていないので、値ではなく問い合わせで渡す。
  ballparkOf: () => ballpark,
  // 守備プレー中のアウト/セーフをその都度、文字バナー＋効果音で見せる（捕球・各送球の
  // 到着時に発火）。実機テストプレイの指摘：送球後にセーフ/アウトが分からず、アウトの
  // 積み重ねも見えないため守備→攻撃の交代が唐突に感じる、への対応。
  onDefenseResult: (kind) => {
    if (kind === 'out') {
      sfx.out();
      hud.playBanner('out', 'アウト！');
    } else {
      sfx.base();
      hud.playBanner('safe', 'セーフ！');
    }
  },
  // ちっちゃいモードの操作ヒント：人間が攻撃側なら走塁（説明書p19：タッチアップの
  // 猶予中は「Bで進塁」、仕掛けた走者がいる間は「Aで帰塁」）、守備側なら飛行中は
  // ファインプレイ（説明書p23：跳べば届く距離にボールがある間だけ「A+方向」）、
  // 確保中は塁間に走者がいる間だけランダンプレイ（説明書p25：「B+方向」）を画面に
  // 出す（既存の「意思決定材料は隠さない」方針。状況が変われば消える）。
  onPlayPrompt: (prompt) => hud.showPlayPrompt(promptLines(prompt)),
  // 野手の捕球（グラブ）と送球（風切り）の音（ブラッシュアップ：効果音）
  onFieldSound: (kind, fielder) => {
    if (kind === 'catch') sfx.catchBall();
    else sfx.throwBall();
    // スキル（フェーズYY-73）：捕った瞬間に捕球範囲の札が閃く
    if (kind !== 'catch' || fielder === null) return;
    const c = gameActor.getSnapshot().context;
    const fld = c.rosters[fieldingTeam(c.half)];
    const f = fielders.find((e) => e.id === fielder);
    if (!f) return;
    skillMoment(
      liveSkillsIn(fld, fld.positions[fielder as FieldingPosition]),
      'catch',
      f.group.position.clone().setY(2.5),
      0.7,
    );
  },
  onSettled: (outcome) => {
    const wasSteal = stealActive;
    stealActive = false;
    // 盗塁の決着でイニングが変わったか（＝3アウト目になったか）を見るために控えておく。
    // 変わった場合、保留していた投球の判定は捨てる（実際の野球でも、走者が3アウト目に
    // なった打者は次のイニングに新しいカウントで打ち直す）。
    const beforeCtx = gameActor.getSnapshot().context;
    switch (outcome.kind) {
      case 'foul': {
        // 打球が出たら走者は塁に戻る＝持ち越したリード（フェーズL-32）は無効になる
        carriedLeads = {};
        // バントのファウルだけはファウルの頭打ちが効かない（フェーズAA-48）＝
        // 2ストライク後は三振。事実は打球（`BattedBall.bunt`）が運んでくるので、
        // ここは振り分けるだけ。
        const judgement = outcome.bunt ? 'buntFoul' : 'foul';
        // 粘られた球数を数える（フェーズSS-67）＝次の球でCPU投手が隅を入れ替える。
        countFoulInAtBat();
        // 判定コール（フェーズE-23）。ファウルだけは打球のプレー側で決着するので、
        // ストライク/ボールと違ってここで出す。**三振になる場合は三振のコール**に
        // 差し替える（`applyPitchCall` と同じ「純粋関数で先読みして演出を一度だけ出す」形で、
        // **効果音もバナーも1つの帰結につき1つ**）。出さないと、バントを転がしたのに
        // 打者が消えた理由が画面から読めない。
        const foulOutcome = applyPitch(beforeCtx.count, judgement);
        if (foulOutcome.kind === 'strikeout') {
          sfx.strikeout();
          hud.playBanner('strikeout', 'バントファウル\n三振！');
        } else {
          sfx.foul();
          hud.playBanner('foul', 'ファウル');
        }
        gameActor.send({ type: 'PITCH_RESULT', judgement });
        break;
      }
      case 'runnerPlay':
        // けん制球（説明書p24）・盗塁（説明書p13）の決着。アウト・得点・塁状況だけを
        // 反映し、カウントと打順には触れない（同じ打者が同じカウントで打席に立ち続ける。
        // 盗塁のときだけ、この後に保留していた1球ぶんのカウントが進む）。アウト/セーフの
        // 見せ方は打球のときと同じく onDefenseResult 側で済んでいる。
        //
        // **リードはここで次の球へ引き継ぐ**（フェーズL-32）＝早めに帰塁した走者は0、
        // 耐えた走者は深いまま。これが「けん制で走者を釘付けにする／耐えて走る」という
        // 読み合いの入れ物で、真実はこの1か所（直近の走塁プレーの終了時の値）だけにある。
        carriedLeads = outcome.leads;
        // デバッグモード（フェーズPP-64）は**結果を記録しない**＝プレーは従来どおり
        // 走って見えるが、アウト・得点・塁の状態は元のまま（同じ場面をもう一度作れる）。
        if (practice) break;
        gameActor.send({
          type: 'RUNNER_PLAY_RESOLVED',
          outsAdded: outcome.outsAdded,
          runs: outcome.runs,
          bases: occupancy(outcome.baseRunners),
          baseRunners: outcome.baseRunners,
        });
        break;
      case 'result':
        carriedLeads = {};
        // 安打・本塁打のバナーはここで（守備プレーのアウト/セーフは onDefenseResult 側で
        // その都度出しているので、ここでは二重に出さない）。
        if (outcome.hit) {
          const banner = HIT_BANNER[outcome.hit];
          if (outcome.hit === 'homerun') {
            sfx.homerun();
            music.jingle('homerun');
          } else sfx.base();
          hud.playBanner(banner.kind, banner.text);
        }
        if (practice) break;
        gameActor.send({
          type: 'PLAY_RESOLVED',
          outsAdded: outcome.outsAdded,
          runs: outcome.runs,
          bases: occupancy(outcome.baseRunners),
          baseRunners: outcome.baseRunners,
        });
        break;
    }
    modeActor.send({ type: 'PLAY_COMPLETE' });

    // 盗塁中に決着していた投球を、ここでカウントへ反映する（でっかいモードへ戻った後に
    // 送るのは、死球なら deadBall モードへ遷移するため＝ちっちゃいモードからは遷移できない）。
    if (wasSteal && pendingPitch) {
      const pitch = pendingPitch;
      pendingPitch = null;
      const after = gameActor.getSnapshot().context;
      const sameAtBat =
        after.winner === null &&
        after.inning === beforeCtx.inning &&
        after.half === beforeCtx.half;
      if (sameAtBat) applyPitchCall(pitch.call, pitch.swung);
    }
  },
});

// 打った瞬間からカットまで（フェーズWW-71）。**それまでのヒットストップ（全体の静止）を
// やめ、打球がバットから飛び出すところを見せてからカットする**（テストプレイ「切り替わる
// 前に一時停止したみたいになる」）。静止のすぐ後に画面が切り替わるので、手応えではなく
// 引っかかりに見えていた。この間は打者が振り抜き、球は打った向きへ飛んでいく（見た目
// だけ）。守備のプレーは従来どおり**接触の瞬間の状態から**始まる＝判定は1つも動かない。
// 入力はこの間も止める（打ってからカットまでの一瞬に押したキーが次の画面へ漏れない）。
let contactFollowRemaining = 0;
let pendingBatted: BattedBall | null = null;
/** カットまでの間に見せる球の位置と速度（`pendingBatted` の接触の瞬間から積分する。見た目だけ） */
let contactBall: { x: number; y: number; z: number; vx: number; vy: number; vz: number } | null =
  null;

function hitStopActive(): boolean {
  return contactFollowRemaining > 0;
}

/** カットまでの球を1フレーム進める（重力だけの放物線。空気抵抗・跳ね返りは見せる長さに要らない） */
function advanceContactBall(dt: number): void {
  if (!contactBall) return;
  const b = contactBall;
  b.vy -= GRAVITY * dt;
  b.x += b.vx * dt;
  b.y = Math.max(BALL_RADIUS, b.y + b.vy * dt);
  b.z += b.vz * dt;
  const k = dekkaiBallScale(b);
  ball.scale.set(k, k, k);
  ball.position.set(b.x, b.y, b.z);
}

const batting = createBattingController({
  batter,
  // 原作準拠（説明書p14）：Aを押しっぱなしならフルスイング、スイング途中で離すとバント。
  // バントの方向は十字キー左右で狙う（でっかいモードのカメラは-Z向きなので画面左右＝ワールドX）。
  // CPUが打者のときは「Aを押しっぱなし」と見なす：isPressed('a') は人間のキー状態なので、
  // そのまま使うと人間が投球でAを離した瞬間にCPUのスイングまでバントに化けてしまう。
  // **読むのは攻撃側のパッド**（フェーズD-20）＝2P PLAY では投手側のKがスイングを
  // 押しっぱなしにすることも、投手側の十字キーがバントの方向を曲げることもない。
  isSwingHeld: () => !isBattingHuman() || offensePad.isPressed('a'),
  buntAimX: () => (isBattingHuman() ? offensePad.direction().x : 0),
  // 押しバント（説明書p17「ファールラインぎりぎりに転がすのがコツ」。フェーズY-46）。
  // **十字キー上下は打者側でどこにも割り当たっていなかった**ので、新しいキーは増えない
  // （投球の「上下＝緩急／左右＝コース」と同じ形が、打撃側にもそのまま来る）。
  // CPU打者はバントしないので、CPUのときは常に false（人間のキー状態を流用しない）。
  buntPush: () => isBattingHuman() && offensePad.direction().y > 0,
  // 打席内の立ち位置（説明書p14。フェーズO-36）。**バントの狙う方向と同じ十字キー左右**だが、
  // 押し分ける必要は無い：立ち位置は打撃動作の外だけ、バントの方向は打撃動作の中だけ効く
  // （＝原作の多目的ボタン方式と同じで、同じ入力の意味が場面で決まる）。
  stanceMove: () => (isBattingHuman() ? (offensePad.direction().x as -1 | 0 | 1) : 0),
  // CPU打者は「直前の球のコースへ芯を合わせる」＝**同じコースへ続けて投げると狙われる**
  // （人間の投手側に「配球を散らす」という手が生まれる）。人間が打者のときは null。
  cpuStance: () => (isBattingHuman() ? null : cpuStanceTarget()),
  // 打者の能力値（長打力・打率）は人間/CPUを問わず同じように打球へ効く
  batterProfile: currentBattingProfile,
  // 投手の疲労（フェーズB-11）も同じく打球へ効く：球威が落ちたぶん打球初速が伸びる
  pitcherFatigue: currentPitcherFatigue,
  // 打席の左右（BOX）。立ち位置・構え・バットの到達範囲・引っ張り方向をまとめて反転する
  batterSide: currentBatterSide,
  // 好調（フェーズD-19）は見た目だけ＝原作どおりバットをクルクル回す。打球への効果は
  // batterProfile が能力値として運ぶので、ここで二重には効かない。
  batterHot: currentBatterIsHot,
  onContact: (batted) => {
    pitching.abortFlight();
    // 接触＝この球は終わり（判定を経ずに打ち切られるため onJudged は呼ばれない）。
    // ここでも次の球のためにCPU投手の狙いをリセットしておく（onJudged と同じ理由）。
    cpuPitcher.reset();
    const exitSpeed = Math.hypot(batted.vx, batted.vy, batted.vz);
    sfx.hit(exitSpeed); // 打球音の芯は最初の0.1秒に集めてある（sfx.ts参照）
    // スキル（フェーズYY-73）：打った瞬間に打率・長打力の札が閃く（強い当たりほど大きく）
    {
      const c = gameActor.getSnapshot().context;
      const roster = c.rosters[battingTeam(c.half)];
      const strength = Math.max(0.35, Math.min(1, (exitSpeed - 25) / 20));
      skillMoment(
        liveSkillsIn(roster, currentBatterId(roster)),
        'contact',
        new THREE.Vector3(batted.x, batted.y, batted.z),
        strength,
        0.4 + 0.5 * strength,
      );
    }
    // 接触点から球を飛ばし始める。カット（BATTED_BALL）は `CONTACT_FOLLOW_SEC` の後に送る。
    // この間もまだでっかいモードのカメラなので、**拡大率も投球中と同じ距離補正で書く**
    // （フェーズNN-61。素の1.0倍に戻すと、接触の瞬間だけ球が実寸＝本塁の見かけより
    // 小さく縮んで見える）。**残像（PP-63）はここで戻す**＝打った球はもう投球ではないので
    // 伸ばさない（等倍にすれば球なので、向きは戻さなくても同じ形）。
    const k = dekkaiBallScale(batted);
    ball.scale.set(k, k, k);
    ball.position.set(batted.x, batted.y, batted.z);
    pendingBatted = batted;
    contactBall = { x: batted.x, y: batted.y, z: batted.z, vx: batted.vx, vy: batted.vy, vz: batted.vz };
    contactFollowRemaining = CONTACT_FOLLOW_SEC;
  },
});

// 打席の左右（BOX）は打者が変わった瞬間に見た目へ反映する（フェーズB-9）。毎フレームの
// batting.update でも追随するが、判定側（死球ゾーン・銃の命中ゾーン）は状態が変わった
// その瞬間に切り替わるため、これが無いと「見た目は右打席・判定は左打席」の1フレームが
// 生じる（実機の全フレーム監視で観測したので塞いだ）。
// フェーズF-26-6で `subscribeActors` に統合した（購読を試合ごとに張り直す必要が出たため。
// 呼ばれるのは batting の生成より後＝startGame の中なので、未初期化にはならない）。

// ---- 試合のテンポ：打席の切れ目の「間」（フェーズE-23） ----
//
// 原作には打者が代わるとき・攻守が入れ替わるときに明確な「間」がある。従来は3アウト目の
// 直後や三振の直後に何の予告もなく次の投球が始まっていた。
//
// **間は「状態の差分」から導出する**（AtBatMarker）。打席の終わり方は三振/四球/死球/打球/
// けん制でのイニング終了と複数あり、終わりのイベントを個別に捕まえると必ず取りこぼす
// （syncPlateAppearance が「1打席1回」の判定に状態を使っているのと同じ理由）。
//
// 間を消化するのは**でっかいモードにいる間だけ**。打球のプレー中（ちっちゃいモード）や
// 死球・乱闘の最中に打順が動いても、でっかいモードへ戻った最初のフレームで差分として
// 現れるので、そこで初めて間が開く（＝プレーの決着表示と二重に待たせない）。
let interlude: { kind: InterludeKind; remaining: number } | null = null;
let lastAtBatMarker: AtBatMarker | null = null;

function interludeActive(): boolean {
  return interlude !== null;
}

function atBatMarkerOf(ctx: GameContext): AtBatMarker {
  return {
    inning: ctx.inning,
    half: ctx.half,
    lineupIndex: ctx.rosters[battingTeam(ctx.half)].lineupIndex,
    over: ctx.winner !== null,
  };
}

/** その「間」に何を見せるか（ただ止まっている時間にしないための中身） */
function interludeText(kind: InterludeKind, ctx: GameContext): string {
  if (kind === 'inningChange') {
    const half = ctx.half === 'top' ? '表' : '裏';
    // ラッキー7（フェーズD-19。説明書p17）は**この回に入る瞬間にだけ**言う。攻守交代の間は
    // もともと「次はどの回か」を見せる場所なので、打線全員が好調になるという回の性質も
    // ここに置くのが素直（②「間を延ばすときは間に見せるものとセットで設計する」）。
    // 以降は打者カードの `ゼッコーチョー!` とバットの回転が、打席ごとに同じことを伝える。
    if (isLuckyInning(ctx.inning)) return `ラッキーセブン！\n${ctx.inning}回${half}`;
    return `攻守交代\n${ctx.inning}回${half}`;
  }
  // 打者交代：何番・どの守備位置の誰が打席に立つか（采配メニューの見出しと同じ粒度）
  const roster = ctx.rosters[battingTeam(ctx.half)];
  const position = currentBatterPosition(roster);
  const name = roster.players[currentBatterId(roster)].name;
  return `${roster.lineupIndex + 1}番${position ? ` ${positionLabel(position)}` : ''}\n${name}`;
}

function clearInterlude(): void {
  if (!interlude) return;
  interlude = null;
  hud.showInterlude(null);
}

/**
 * でっかいモードにいる間だけ毎フレーム呼ぶ。打席が切り替わっていれば「間」を開き、
 * 進行中なら消化する。true を返している間は投球・けん制・盗塁・銃を止める。
 */
function updateInterlude(ctx: GameContext, dt: number): boolean {
  const marker = atBatMarkerOf(ctx);
  const kind = lastAtBatMarker ? interludeBetween(lastAtBatMarker, marker) : null;
  lastAtBatMarker = marker;
  if (kind) {
    interlude = { kind, remaining: INTERLUDE_SEC[kind] };
    hud.showInterlude(interludeText(kind, ctx));
    if (kind === 'inningChange') music.jingle('change');
    // 次の打者が打席へ歩いて入る（間がちょうど終わる頃に打席に収まる）。
    // 立ち位置（フェーズO-36）も打者ごとに仕切り直す：見た目は startEntrance が 0 へ戻し、
    // CPUの材料（直前の球のコース）はここで捨てる＝**両方が同じ瞬間に初期化される**。
    batting.startEntrance(INTERLUDE_SEC[kind]);
    lastPitch = null;
  }
  if (!interlude) return false;
  interlude.remaining -= dt;
  if (interlude.remaining > 0) return true;
  clearInterlude();
  return false;
}

// 銃：銃モード中はWASDが照準（gun.update）、Kが発射（gun.fire）。
// 命中はデッドボールと同じ処理だが、シリアス演出のため一瞬のヒットストップを挟んでから
// HIT_BY_PITCH/DEAD_BALLを送る（打撃のヒットストップと同じ「手応え」の設計を踏襲）。
// 命中ゾーンも打者と一緒に動く（右打者は画面左＝三塁側、左打者は画面右へ振らないと当たらない）
const gun = createGunController({
  pitcher,
  // 銃は投手側（守備側）の操作（フェーズD-20）。撃たれる側のWASDで照準が動かない
  // ＝CPUの予兆と同じ扱い（メインループ側の並び順のコメント参照）。
  pad: defensePad,
  reticle,
  // 銃の部品（フェーズE-25-(e)）。投手は試合ごとに作り直さない1体なので、ここで一度
  // 持たせるだけでよい（見えるかどうかは銃モードの側が決める）。
  gun: createProp('Gun'),
  // 銃は**投げる腕の手**に持つ（フェーズCC-50）＝投球の見た目と食い違わない
  pitcherArm: currentPitchArm,
  batterSide: currentBatterSide,
  // 命中ゾーン＝死球ゾーンなので、打席内の立ち位置にも追従させる（フェーズO-36）＝
  // 人間が撃つときも「いま打者が立っている場所」を狙うことになる。
  batterStance: currentBatterStance,
});

const GUN_HIT_STOP_SEC = 0.3;
let gunHitStopRemaining = 0;
let pendingGunHit = false;

function gunHitStopActive(): boolean {
  return gunHitStopRemaining > 0;
}

/**
 * 銃の発射（人間の K・CPUの予兆明けの両方から呼ぶ。フェーズF-26-2）。
 *
 * **経路を1本にまとめてある**：撃つ主体が人間かCPUかで、死球の扱い・残弾の消費・
 * 乱闘への分岐が変わってはいけない（CPUに撃たれたときだけ乱闘に持ち込めない、
 * といった非対称が生まれると、⑧で決めた「CPUも対等にスキルを持つ」が成立しない）。
 */
function fireGun(): void {
  const result = gun.fire();
  sfx.gunShot(); // 発射音は命中/外れを問わず鳴る
  gameActor.send({ type: 'GUN_USED' });
  if (result === 'hitByPitch') {
    // 命中：一瞬の静止で「当たった」手応えを出してから死球処理・カット
    // （DEAD_BALLへの遷移でdekkai.gunを離れるため、モード側の後始末はそちらに任せる）
    sfx.gunHit(); // シリアス演出：発射音の上に低く重い一撃を追加
    captureHbpRestoreSnapshot();
    hud.gunHitFlash();
    gun.exit();
    gunHitStopRemaining = GUN_HIT_STOP_SEC;
    pendingGunHit = true;
    return;
  }
  // 外れ：通常の投球判定と同じ扱い（ストライク/ボール）。
  // 発射後は命中/外れを問わず構えを解除する（毎回明示的にONにしてから撃つことを
  // 徹底＝押しっぱなし事故防止・毎打席の明示的なリスク選択という既存方針と同じ理由。
  // 三振で打席が変わっても銃モードが残り続けない）
  gameActor.send({ type: 'PITCH_RESULT', judgement: result });
  modeActor.send({ type: 'GUN_TOGGLE' });
  gun.exit();
}

// ---- CPU投手の銃と予兆（フェーズF-26-2。CLAUDE.md ⑧） ----
//
// **撃つかどうかの規則は決定的**（`shouldCpuShoot`＝一塁が空いた強打者の打席）で、
// **構えてから撃つまでに必ず「間」を置く**（`GUN_TELEGRAPH_SEC`）。予兆を挟むのは
// 桜井ノウハウ「人に反応できない動作をするとすっっごい理不尽感がある」への対応で、
// 打者側に回避手段が無い（CLAUDE.md ③）以上、**見えていることが唯一の救い**になる。
// 予兆の間は全アクターを静止させる（ヒットストップと同じ扱い）。

/** 予兆の残り時間。0より大きい間はメインループが全アクターを止める */
let gunTelegraphRemaining = 0;
/** CPU投手の銃は1打席1回まで（けん制・盗塁と同じ理由。syncPlateAppearance で戻す） */
let cpuGunUsed = false;

function gunTelegraphActive(): boolean {
  return gunTelegraphRemaining > 0;
}

/**
 * CPU投手が銃を構えるか判断し、構えるなら予兆を始める（true を返す）。
 * でっかいモードの ready フェーズ（投球動作に入る前）でだけ呼ぶ。
 */
function tryCpuGun(ctx: GameContext): boolean {
  const fielding = ctx.rosters[fieldingTeam(ctx.half)];
  const batting = ctx.rosters[battingTeam(ctx.half)];
  const batterId = currentBatterId(batting);
  const decision = shouldCpuShoot({
    ammo: gunRemainingOf(fielding, fielding.pitcher),
    bases: ctx.bases,
    // 長打力はスキルの補正込みで読む（`キンニク` で主砲に育った打者は撃たれるようになる）。
    // **好調（フェーズD-19）も同じ経路で乗る**＝ゼッコーチョーの打者・ラッキー7の打線は
    // 撃たれやすくなる（敬遠の定石として筋が通っており、規則は決定的なままなので読める）。
    batterPower: effectiveBatting(batting, batterId, ctx.inning).power,
    usedThisPlateAppearance: cpuGunUsed,
  });
  if (!decision) return false;
  cpuGunUsed = true;
  // 人間が撃つときと同じ銃モードへ入る（HUDの「▶ジュウ モード」もそのまま出る＝
  // 相手が構えていることが、こちらが構えたときと同じ表示で分かる）
  modeActor.send({ type: 'GUN_TOGGLE' });
  gun.enter();
  // 狙いは打者の中心（必中）。予兆の間ずっとレティクルが打者に乗っている＝
  // 「どこを狙われているか」まで見えている状態で撃たれる
  // 立ち位置（フェーズO-36）も込みで狙う＝**踏み込んでいる打者にも必中**
  // （撃たれる側が離れて立っていれば、狙いもその位置へ動く）。
  gun.aimAt(batterAimX(currentBatterSide(), currentBatterStance()));
  sfx.gunAim();
  hud.playBanner('gunAim', `${fielding.players[fielding.pitcher].name}\n銃を構えた！`);
  gunTelegraphRemaining = GUN_TELEGRAPH_SEC;
  return true;
}

/**
 * CPU投手の敬遠（フェーズQ-38。規則は `core/cpuPitcher.ts` の
 * `shouldCpuIntentionalWalk`＝一塁が空いていて得点圏に走者がいる場面の強打者）。
 *
 * **銃（`tryCpuGun`）の後に見る**：どちらも「一塁を与えて強打者を避ける」手だが、
 * 銃は撃たれた側が乱闘に持ち込める＝投手を退場させに行ける荒っぽい手で、敬遠は
 * 誰にでもある基本の手。**残弾のあるスキル持ちは先に撃つ**ので、`ジュウ` を引いた
 * 試合の見せ場が敬遠に食われない（F-26-2の銃が「敬遠の下位互換」にならない）。
 *
 * でっかいモードの ready フェーズ（投球動作に入る前）でだけ呼ぶ。**打席がその場で
 * 終わる**ので「1打席1回」の枷は要らない（けん制・銃と違い、押した瞬間に打者が代わる）。
 */
function tryCpuIntentionalWalk(ctx: GameContext): boolean {
  const batting = ctx.rosters[battingTeam(ctx.half)];
  const batterId = currentBatterId(batting);
  // 長打力はスキル・好調の補正込みで読む（銃の判断とまったく同じ経路）＝
  // **ゼッコーチョーの打者・ラッキー7の打線は歩かされやすくなる**。
  const decision = shouldCpuIntentionalWalk({
    bases: ctx.bases,
    batterPower: effectiveBatting(batting, batterId, ctx.inning).power,
    nextBatterPower: effectiveBatting(batting, nextBatterId(batting), ctx.inning).power,
  });
  if (!decision) return false;
  declareIntentionalWalk(fieldingTeam(ctx.half));
  return true;
}

// 乱闘（v2＝フェーズG-27）：プレイヤーは打者側を操作（K=攻撃／J=ガード／前+J=投げ／
// コマンド入力で必殺技）、投手側は決定的な固定スクリプトの簡易CPUが動かす
// （brawlScene.ts内で完結。2P PLAY では投手側も人間＝D-20）。
// 決着後は死球を巻き戻して同じ打席を継続し（gameActor.BRAWL_RESOLVED）、負けた側の現在の
// 打者/投手をロスターから永久退場させて控え/ブルペンから自動交代する（セッション7で本実装）。
//
// **交代はバナーで知らせ、ユニフォームは塗り替えない**（フェーズWW-71。テストプレイ
// 「乱闘が終わった後にピッチャーのユニフォームの色が変わる」）。セッション7は交代の合図として
// でっかいモードの投手・打者を別の色（緑・茶・紫…）に塗っていたが、**でっかいモードの
// 投手・打者は1体ずつを全員で使い回している**ので、塗った色がその後の全投手・全打者に
// 残り、**守備側の色（青）でも攻撃側の色（赤）でもない3チーム目**に見えていた。

const brawl = createBrawlController({
  batter: brawlFighters.batter,
  pitcher: brawlFighters.pitcher,
  camera: brawlCamera,
  // 乱闘の打者側＝攻撃側のパッド／投手側＝守備側のパッド（フェーズD-20）。
  // 1P PLAY では相手側が `NULL_PAD` になるので、CPUスクリプトがそのまま動く。
  pads: { batter: offensePad, pitcher: defensePad },
  isHuman: (side) => (side === 'batter' ? isBattingHuman() : isPitchingHuman()),
  // 音と大きな呼び出しはエンジンのイベントから（乱闘v3。フェーズXX-72）
  onEvents: handleBrawlEvents,
  onResolved: (loser: BrawlSide) => {
    const preRestoreCtx = gameActor.getSnapshot().context;
    const restore = pendingHbpRestore ?? {
      count: preRestoreCtx.count,
      bases: preRestoreCtx.bases,
      baseRunners: preRestoreCtx.baseRunners,
      battingLineupIndex: preRestoreCtx.rosters[battingTeam(preRestoreCtx.half)].lineupIndex,
    };
    pendingHbpRestore = null;
    // 退場する選手（交代の告知に名前を出す）。打者は死球の直前の打順から引く
    // （`brawlLoadouts` と同じ理由＝死球で打順はもう1つ進んでいる）
    const loserTeam =
      loser === 'batter' ? battingTeam(preRestoreCtx.half) : fieldingTeam(preRestoreCtx.half);
    const loserRoster = preRestoreCtx.rosters[loserTeam];
    const loserId =
      loser === 'batter' ? loserRoster.lineup[restore.battingLineupIndex] : loserRoster.pitcher;
    gameActor.send({ type: 'BRAWL_RESOLVED', loser, restore });

    const after = gameActor.getSnapshot().context;
    if (after.winner === null) {
      const roster = after.rosters[loserTeam];
      const subId =
        loser === 'batter' ? roster.lineup[restore.battingLineupIndex] : roster.pitcher;
      if (subId !== loserId) {
        hud.playBanner(
          'ejected',
          `${loserRoster.players[loserId]?.name ?? ''} 退場\n代わって ${roster.players[subId]?.name ?? ''}`,
        );
      }
    }

    modeActor.send({ type: 'BRAWL_END' });
    brawl.exit();
    hud.setBrawlHint(null);
  },
});
scene.add(brawl.root);

// 采配メニュー（セッション9）：Start（ポーズ）で開く、乱闘の強制交代とは独立した任意の
// 代打/継投。でっかいモードの ready フェーズ（投球動作中でない間）だけ開ける
// （実際のプロ野球でも投球動作中の交代は無い）。メニューが開いている間はメインループを
// 静止させ（menuOpenガード）、ゲーム側のA/B/銃キーもチーム選択と同じ理由で二重発火を防ぐ。
let menuOpen = false;

function canOpenManagerMenu(): boolean {
  return (
    gameStarted &&
    !gameIsOver() &&
    !hitStopActive() &&
    !gunHitStopActive() &&
    !gunTelegraphActive() &&
    currentMode() === 'dekkai' &&
    !isGunMode() &&
    !pitching.isBusy()
  );
}

// ---- けん制球（説明書p24「Bで"ちっちゃいモード"に切替→+で塁を指示→A」） ----

/**
 * けん制モードへ入れるか。投球動作中・銃モード中・ポーズ中は不可（采配メニューと同じ
 * 「ready フェーズだけ」の条件）。走者がいなければ入る意味がないので入らない。
 */
function canStartPickoff(): boolean {
  const bases = gameActor.getSnapshot().context.bases;
  return (
    gameStarted &&
    !gameIsOver() &&
    !hitStopActive() &&
    !gunHitStopActive() &&
    !gunTelegraphActive() &&
    !menuOpen &&
    // 打席の切れ目の「間」（フェーズE-23）の最中は投球も守備の仕掛けも受け付けない
    !interludeActive() &&
    currentMode() === 'dekkai' &&
    !isGunMode() &&
    !pitching.isBusy() &&
    (bases.first || bases.second || bases.third)
  );
}

function startPickoff(): void {
  const ctx = gameActor.getSnapshot().context;
  // 持ち越したリード（フェーズL-32）から始める＝**けん制モードに入り直しても
  // 走者のリードは0に戻らない**（戻せると、投げずに入り直すだけで走者が耐えて
  // 勝ち取った深いリードを無効化できてしまう）。
  fieldPlay.startPickoff(ctx.baseRunners, ctx.outs, resolveCarriedLeads(ctx.baseRunners, carriedLeads));
  modeActor.send({ type: 'PICKOFF' });
}

// CPU投手のけん制は1打席1回まで（core/cpuPitcher.ts shouldCpuPickoff の理由参照）。
// CPU攻撃側の盗塁も同じく1打席1回まで（毎球走られるとテンポが壊れるのと、走者は
// 1打席に何度も同じ塁を盗めないため）。
// 打席が変わったかは「イニング・表裏・打者側チームの打順インデックス」の組で判定する
// （打席の終わり方は三振/四球/死球/打球/イニング終了と複数あるため、終わりのイベントを
// 個別に捕まえるより、状態から導出するほうが取りこぼしがない）。
let cpuPickoffUsed = false;
let cpuStealUsed = false;
// 人間の攻撃側が自分からにらみ合いへ入るのも1打席1回まで（フェーズKK-58。`canTakeLead`）。
// CPU投手のけん制と同じ枷にしてあるので、**同じ打席で投げ合う回数が両者そろって1回**になる。
let offenseLeadUsed = false;
let lastPlateAppearanceKey = '';

/**
 * けん制・盗塁のプレーが終わった時点の各走者のリード（フェーズL-32）。
 *
 * **次の投球の盗塁のスタート位置**であり、けん制モードに入り直したときの開始位置でもある
 * （`core/fielding.ts` の「リードの持ち越し」の節）。持つのはこの1か所だけで、有効なのは
 * **同じ打席のあいだ・同じ走者がその塁にいるあいだ**：
 * - 打席が変わったら捨てる（`syncPlateAppearance`）＝走者は塁に戻って構え直す。
 * - 打球（ファウル含む）が起きたら捨てる（`onSettled`）＝同じ理由。
 * - 走者が入れ替わった塁は `resolveCarriedLeads` が識別で弾く（＝捨て忘れても効かない）。
 */
let carriedLeads: CarriedLeads = {};

/**
 * 「球威が落ちた」ことを既に知らせた投手（フェーズB-11）。1人につき一度だけ出す。
 * 交代した投手は再登板しないので、この集合が試合中に膨らみ続けることはない。
 */
const staminaDropAnnounced = new Set<string>();

/**
 * スタミナが半分を切って球威が落ち始めた瞬間を一度だけ知らせる（フェーズB-11）。
 *
 * **打席の切れ目でだけ見る**：投げた直後（飛行中）に出すと、次の球の判断材料ではなく
 * 目の前のプレーの邪魔になる。打者が代わる「間」（フェーズE-23）に重なるので、
 * 投手側なら継投を、打者側なら狙い目であることを落ち着いて読める
 * （＝伸ばした「間」に見せるものを1つ足す形になっている）。
 */
function announceStaminaDrop(ctx: GameContext): void {
  const roster = ctx.rosters[fieldingTeam(ctx.half)];
  const id = roster.pitcher;
  if (staminaDropAnnounced.has(id) || fatigueOf(roster, id) <= 0) return;
  staminaDropAnnounced.add(id);
  hud.playBanner('stamina', `${roster.players[id].name}\n球威ダウン`);
}

/**
 * CPU投手の自動継投（フェーズJ-30。規則は `core/cpuPitcher.ts` の `chooseCpuRelief`）。
 *
 * B-11で「CPUの采配はスコープ外」として入れなかったぶん、**試合後半はCPU投手の球威が
 * 落ちたまま戻らず、人間が攻撃側のときだけ一方的に有利**という非対称が残っていた
 * （1P PLAY だけの話＝2P PLAY にはCPUがいない）。
 *
 * **人間側は自動で代わらない**（采配は人間の取り分）ので、見るのは「投手側がCPUのとき」だけ。
 * `announceStaminaDrop` と同じく**打席の切れ目でだけ**呼ばれるので、投げている最中に
 * 投手がすり替わることはなく、E-23の「間」に重なって落ち着いて読める。
 */
function tryCpuRelief(ctx: GameContext): void {
  if (isPitchingHuman()) return;
  const side = fieldingTeam(ctx.half);
  const roster = ctx.rosters[side];
  const index = chooseCpuRelief(
    {
      remaining: remainingStaminaOf(roster, roster.pitcher),
      // **疲れたぶんだけ質が落ちた姿**で比べる（フェーズZ-47）＝控えが格下なら続投する
      quality: pitcherQualityOf(roster, roster.pitcher),
    },
    roster.bullpen.map((id, i) => ({
      index: i,
      remaining: remainingStaminaOf(roster, id),
      reliever: pitcherRole(effectivePitching(roster, id)?.stamina ?? NEUTRAL_RATING) === 'reliever',
      // 控えは投げていないので疲労0（V-43の持ち越しは人間側だけ）だが、読み方は同じ1本
      quality: pitcherQualityOf(roster, id),
    })),
  );
  if (index === null) return;
  const incoming = roster.players[roster.bullpen[index]].name;
  gameActor.send({ type: 'SUBSTITUTE_PITCHER', side, bullpenIndex: index });
  // 交代したこと自体を見せる（打者側にとっては「相手の球威が戻った」という判断材料。
  // 投手カードは refresh で追従するが、切り替わった瞬間は banner でないと見落とす）。
  hud.playBanner('stamina', `${incoming}\nリリーフ`);
}

function syncPlateAppearance(ctx: GameContext): void {
  const key = `${ctx.inning}-${ctx.half}-${ctx.rosters[battingTeam(ctx.half)].lineupIndex}`;
  if (key === lastPlateAppearanceKey) return;
  lastPlateAppearanceKey = key;
  cpuPickoffUsed = false;
  cpuStealUsed = false;
  offenseLeadUsed = false;
  cpuGunUsed = false;
  // 打席が変われば走者は塁に戻って構え直す＝持ち越したリード（フェーズL-32）も無効になる
  carriedLeads = {};
  // 継投を先に見る：代わった投手のスタミナで `announceStaminaDrop` を判断させたいので
  // （交代した直後に前の投手の「キュウイ ダウン」が出ると、何が起きたのか読めない）。
  tryCpuRelief(ctx);
  announceStaminaDrop(gameActor.getSnapshot().context);
  // 代打を一時効果より先に見る（フェーズX-45）：代打で打者が入れ替わるので、
  // 逆順だと「退いた投手の札を切ってから代打を送る」ことになって1回ぶん無駄になる。
  tryCpuPinchHit(gameActor.getSnapshot().context);
  // 代走は代打の**後**に見る（フェーズGG-54）：どちらも控え（`roster.bench`）を食い合うので、
  // 順序を決めておかないと「どちらが誰を取るか」が変わる。**代打を先にすると X-45 の
  // 帰結が1つも動かない**（代打の条件のほうが狭い＝投手の打席・得点圏・能力差0.80）。
  // 実際にはぶつからないことが多い＝EE-52の計測どおり16球団すべてで「打つ力best」と
  // 「走力best」は別人なので、たいてい別々の控えが選ばれる。
  tryCpuPinchRun(gameActor.getSnapshot().context);
  tryCpuBattingEffect(gameActor.getSnapshot().context);
}

/**
 * CPUの代打（フェーズX-45。規則は `core/cpuBatter.ts` の `chooseCpuPinchHitter`）。
 *
 * J-30が自動継投を入れて以降も、**攻撃側の采配だけはCPUが一度も行わなかった**
 * （`SUBSTITUTE_BATTER` は人間の采配メニューからしか送られない）。1P PLAY で人間が
 * 守備側のとき、CPUは得点圏に走者を置いても投手をそのまま打席に立たせていた。
 *
 * `tryCpuRelief` とまったく同じ形＝**打席の切れ目でだけ**呼び、**人間側は自動で
 * 代わらない**（采配は人間の取り分）。能力値は `effectiveBatting` を通すので、
 * **スキル（⑧）と好調（D-19）が乗った値**で比べる＝采配メニューが代打候補に好調の印を
 * 出しているのと同じ材料を、CPUも同じだけ見ていることになる。
 */
function tryCpuPinchHit(ctx: GameContext): void {
  if (isBattingHuman()) return;
  const side = battingTeam(ctx.half);
  const roster = ctx.rosters[side];
  // 投手の打席ではブルペンが要る（守備位置Pを埋められないため。B-10）＝
  // 采配メニューが「コウホ ナシ」を出すのと同じ1か所を見る。
  if (!canPinchHit(roster)) return;
  const index = chooseCpuPinchHitter({
    pitcherAtBat: isPitcherAtBat(roster),
    bases: ctx.bases,
    batter: effectiveBatting(roster, currentBatterId(roster), ctx.inning),
    bench: roster.bench.map((id, i) => {
      const stats = effectiveBatting(roster, id, ctx.inning);
      return { index: i, average: stats.average, power: stats.power };
    }),
  });
  if (index === null) return;
  const incoming = roster.players[roster.bench[index]].name;
  gameActor.send({ type: 'SUBSTITUTE_BATTER', side, benchIndex: index });
  // 交代したこと自体を見せる（`tryCpuRelief` の「リリーフ」と同じ扱い）。打者カードは
  // refresh で追従するが、切り替わった瞬間はバナーでないと見落とす。
  hud.playBanner('stamina', `${incoming}\n代打`);
}

/**
 * CPUの代走（フェーズGG-54。規則は `core/cpuBatter.ts` の `chooseCpuPinchRunner`）。
 *
 * `tryCpuPinchHit` とまったく同じ形＝**打席の切れ目でだけ**呼び、**人間側は自動で
 * 代わらない**（采配は人間の取り分）。
 *
 * **見るのは一塁の走者だけ**：R-39が「二塁→三塁の盗塁はどんな俊足でも刺される」ことを
 * 確定させているので、**足を買っても帯をまたげるのは一塁しかない**
 * （`npm run balance:pinchrun` の13段目(a)）。塁ごとの分岐ではなく、規則そのものが
 * そう畳まれている（`chooseCpuPinchRunner` のコメント参照）。
 *
 * **走力とリードの渡し方は `cpuStealOptions`（R-39）と同じ**＝「代走を出すと判断した
 * 前提」と「実際に走るときの計算」が同じ1本の式（`cpuStealDefenseSlack`）から出るので、
 * 代えたのに走らない／代えなくても走れた、という食い違いが起きない。
 */
function tryCpuPinchRun(ctx: GameContext): void {
  if (isBattingHuman()) return;
  const side = battingTeam(ctx.half);
  const roster = ctx.rosters[side];
  const runnerId = ctx.baseRunners.first;
  if (runnerId === null || !canPinchRun(roster, runnerId)) return;
  const leads = resolveCarriedLeads(ctx.baseRunners, carriedLeads);
  /** その足の走者が一塁から走ったときに守備に残る余裕（秒）＝R-39とまったく同じ式 */
  const slackOf = (run: number): number =>
    cpuStealDefenseSlack('first', {
      speedOf: () => runnerSpeed(run),
      leadOf: () => leads.first ?? STEAL_LEAD,
    });
  const runner = effectiveBatting(roster, runnerId, ctx.inning);
  const index = chooseCpuPinchRunner({
    runner: {
      average: runner.average,
      power: runner.power,
      stealSlack: slackOf(runner.run),
    },
    bench: roster.bench.map((id, i) => {
      const stats = effectiveBatting(roster, id, ctx.inning);
      return {
        index: i,
        average: stats.average,
        power: stats.power,
        stealSlack: slackOf(stats.run),
      };
    }),
    stealSlackLimit: CPU_STEAL_MAX_DEFENSE_SLACK_SEC,
  });
  if (index === null) return;
  const incoming = roster.players[roster.bench[index]].name;
  gameActor.send({ type: 'SUBSTITUTE_RUNNER', side, base: 'first', benchIndex: index });
  // 塁の上の走者が入れ替わったことは状況パネルの走力のバー（FF-53）に出るが、
  // **切り替わった瞬間はバナーでないと見落とす**（代打・リリーフと同じ扱い）。
  hud.playBanner('stamina', `${incoming}\n代走`);
}

/**
 * CPU打者の一時効果（フェーズM-33。規則は `core/cpuBatter.ts` の
 * `shouldCpuActivateBattingEffect`）。**打席の頭で一度だけ判断する**＝`tryCpuRelief` と
 * 同じ場所で、同じ「打席の切れ目」の粒度に揃えてある。
 *
 * 人間側は自分で押す（温存の判断は人間の取り分＝F-26-8と同じ切り分け）。
 */
function tryCpuBattingEffect(ctx: GameContext): void {
  const side = battingTeam(ctx.half);
  if (isBattingHuman()) return;
  const roster = ctx.rosters[side];
  const playerId = currentBatterId(roster);
  if (activatableEffect(roster, playerId, 'batting') === null) return;
  if (!shouldCpuActivateBattingEffect(ctx.bases)) return;
  gameActor.send({ type: 'EFFECT_ACTIVATED', side, playerId, role: 'batting' });
  sfx.skillActivate();
  skillMoment(liveSkillsIn(roster, playerId), 'atBat', batter.position.clone().setY(1.3), 1);
}

// ---- 盗塁（説明書p13「投球中も走塁操作が可能」） ----

/**
 * 盗塁を仕掛けられる場面か（＝人間が攻撃側で、走者がいて、でっかいモードにいる）。
 * 投球中かどうかはここでは見ない：投球前に押した場合は「ボールを持った投手の前で
 * スタートを切る」＝けん制のにらみ合いへ移る（startSteal 参照）ので、どちらも成立する。
 */
function canStartSteal(): boolean {
  const bases = gameActor.getSnapshot().context.bases;
  return dekkaiOffenseOpen() && (bases.first || bases.second || bases.third);
}

/**
 * でっかいモードで人間の攻撃側が拡張操作（盗塁・一時効果）を出せる場面か。
 * **画面が止まっている間はどれも動かない**という `onGun` の共通ガードと同じ条件で、
 * ヒントの出し分けもここを見る（見えている操作と効く操作を1か所から出す）。
 */
function dekkaiOffenseOpen(): boolean {
  return (
    gameStarted &&
    !gameIsOver() &&
    !hitStopActive() &&
    !gunHitStopActive() &&
    !gunTelegraphActive() &&
    !menuOpen &&
    !interludeActive() &&
    currentMode() === 'dekkai' &&
    !isGunMode()
  );
}

/**
 * CPU攻撃側の盗塁判断（`chooseCpuSteals`）に渡す、走者ごとの事情（フェーズR-39）。
 *
 * **どちらも既にこの場にある値**をそのまま渡すだけで、新しい状態は持たない：走力は
 * 走者の速さの唯一の出どころ（`runnerSpeedOf`＝スキル・代走込みの派生ビュー）、リードは
 * `startSteal` が実際のスタート位置として渡すのと**同じ `resolveCarriedLeads` の結果**。
 * こうしておくと「走ると判断した前提」と「実際に走る位置」が構造的に食い違わない。
 */
function cpuStealOptions(ctx: GameContext): CpuStealOptions {
  const leads = resolveCarriedLeads(ctx.baseRunners, carriedLeads);
  return {
    speedOf: (from) => {
      const id = ctx.baseRunners[from];
      return id === null ? runnerSpeed(NEUTRAL_RATING) : runnerSpeedOf(id);
    },
    leadOf: (from) => leads[from] ?? STEAL_LEAD,
  };
}

/**
 * 盗塁のスタートを切る（人間の攻撃側のB、またはCPU攻撃側の判断から呼ぶ）。
 *
 * **投球中（ワインドアップ〜飛行中）なら盗塁**：ちっちゃいモードへ切り替え、捕手が
 * 投球を捕って投げるまでの時間との競争になる（fieldPlay.startSteal）。仕掛けた瞬間の
 * 投球の残り時間（pitching.timeToCatcher）がそのまま走者の持ち時間なので、**モーションを
 * 見てすぐ走れば間に合い、遅れれば刺される**。
 *
 * **投球前なら、リードを取りにけん制のにらみ合いへ入る**（フェーズKK-58）。
 * **走り出さない**のが要点で、そこから先は II-56 の世界＝方向キーを押している間だけ
 * リードが伸び、K で帰塁、もう一度 J で走り出す（従来の「投球前のJ＝走り出して刺される」
 * 帰結はこの2度目のJに移った）。**入るのは1打席に1回まで**（`offenseLeadUsed`）。
 *
 * これが要るのは II-56 と JJ-57 が噛み合って**リードという操作が到達できなくなっていた**
 * ため：人間の走者がリードを伸ばせるのは**けん制モード中だけ**（II-56）なのに、CPUが
 * けん制モードへ入るのは**リード>0の走者がいるときだけ**（JJ-57）で、リードが持ち越されるのは
 * `finalLeads` が `ledOff` の走者に対してだけ＝**一度も塁を離れていない走者は永久に
 * 離れられない**という循環になっていた。入口を攻撃側に置けば循環が切れる。
 *
 * target は人間なら十字キーの絶対塁指定（**無指定＝走れる走者全員のダブルスチール**。
 * フェーズL-32）、CPUなら `chooseCpuSteals` が返す起点の塁の配列。**投球前の分岐を
 * 通るのは人間だけ**（CPU攻撃側の呼び出しは `pitching.isPitchLive()` で門番されている）。
 */
function startSteal(target: BaseKey | null | Array<'first' | 'second' | 'third'>): void {
  const ctx = gameActor.getSnapshot().context;
  if (pitching.isPitchLive()) {
    if (
      !fieldPlay.startSteal(
        ctx.baseRunners,
        ctx.outs,
        target,
        pitching.timeToCatcher(),
        // 直前のけん制で残ったリード（フェーズL-32）がスタート位置になる。
        // 早めに帰塁していれば浅く（＝走れない）、耐えていれば深い（＝走れる）。
        resolveCarriedLeads(ctx.baseRunners, carriedLeads),
      )
    ) {
      return;
    }
    // 投球はこのまま裏で進み、カウントとして決着する（判定は盗塁の決着後に反映）。
    // ボールメッシュはちっちゃいモード側（捕手への投球→塁への送球）が使う。
    pitching.detachBall();
    stealActive = true;
    modeActor.send({ type: 'STEAL' });
    return;
  }
  // 投球前：走者が自分からにらみ合いへ入る（フェーズKK-58）。**投手側の入口
  // （`startPickoff`）とまったく同じ**＝持ち越したリードから始まり、窓の長さも
  // CPUの投げる判断も1か所のまま（攻撃側専用のけん制を作らない）。
  if (!canTakeLead()) return;
  offenseLeadUsed = true;
  startPickoff();
}

/**
 * 攻撃側が自分からけん制のにらみ合いへ入れるか（フェーズKK-58）。規則そのものは
 * `core/fielding.ts` の `canTakeLeadOff`（純粋関数）にあり、ここは**いまの状態を
 * そこへ渡すだけ**（`shouldCpuPickoff` に `resolveCarriedLeads` の結果を渡すのと同じ形）。
 *
 * `dekkaiOffenseOpen`（画面が止まっている間はどの操作も動かない）は呼び出し側の
 * `canStartSteal` が既に見ているので、ここでは重ねない。
 */
function canTakeLead(): boolean {
  const bases = gameActor.getSnapshot().context.bases;
  return canTakeLeadOff(bases, offenseLeadUsed, pitching.isBusy());
}

/**
 * でっかいモードで人間の攻撃側にできる操作を知らせる（既存の「意思決定材料は隠さない」
 * 方針。新しい操作は見えないと存在しないのと同じ）。
 *
 * 出るのは2つ：**盗塁**（走者がいるとき）と、**一時効果**（切れる札を持っているとき。
 * フェーズM-33）。**両方同時に出る**＝どちらかを優先して隠すと、走者を置いた場面
 * （＝一時効果を切りたい場面そのもの）で必ず片方が消える。ヒントの並びは配列なので、
 * ちっちゃいモードが守備側・攻撃側の2本を並べるのと同じ形で足せる。
 *
 * 操作ヒントの表示チャンネルはちっちゃいモードのフィールドプレー（onPlayPrompt）と
 * 共用なので、こちらはでっかいモードにいる間だけ出し、状態が変わったときにだけ呼ぶ。
 */
let dekkaiPromptShown = '';

function syncStealPrompt(): void {
  const open = !fieldPlay.isActive() && isBattingHuman() && dekkaiOffenseOpen();
  const kinds: PlayPromptKind[] = [];
  // 一時効果を先に出す：**押せる場面が圧倒的に少ない**札なので、案内が隠れると
  // 存在ごと忘れられる（盗塁は走者がいる限りいつでも出る標準操作）。
  // 押しバント（フェーズY-46）を先頭に出す：**バットを出している間だけの短い窓**で、
  // かつ方向を外すと損をする操作なので、他の常時出るヒントに埋もれさせない
  // （H-28の `ヒットエンドラン!` を短い窓の間だけ出すのと同じ扱い）。
  // 出す条件は他の2つと同じ `open`＝**ちっちゃいモードのプレー中は出さない**
  // （ヒントの表示チャンネルは1つなので、フィールドプレー側の案内と取り合わない）。
  // 2ストライクでは文言だけ差し替える（フェーズAA-48。押せる操作は同じ）＝
  // **ファウルが三振になるのはこのカウントだけ**なので、それ以外では1行も増えない
  // （銃の残弾・持ち越したリード・ゼッコーチョーと同じ「無いときは出さない」扱い）。
  if (open && batting.isBunting()) {
    const twoStrikes = gameActor.getSnapshot().context.count.strikes >= STRIKES_FOR_OUT - 1;
    kinds.push(twoStrikes ? 'buntTwoStrikes' : 'bunt');
  }
  if (open && battingEffectReady() !== null) kinds.push('battingEffect');
  // 盗塁とリード取りは**同じ枠を入れ替える**（フェーズKK-58）：同じJが投球前は
  // 「にらみ合いへ入る」・投球中は「盗塁」なので、両方並べると押した結果が読めない。
  // 使い切った後・投球中は従来どおり `steal`＝KK-58の前と同じ案内に戻る。
  if (open && canStartSteal()) kinds.push(canTakeLead() ? 'takeLead' : 'steal');
  // 中身が変わったときだけ書き換える（毎フレームHUDを組み直さないための既存の作法）
  const key = kinds.join(',');
  if (key === dekkaiPromptShown) return;
  dekkaiPromptShown = key;
  const player = offensePlayerNow();
  hud.showPlayPrompt(
    kinds.map((kind) => ({ kind, player: isTwoPlayer(controllers) ? player : null })),
  );
}

/**
 * ちっちゃいモードのヒント（守備側・攻撃側の対）を、HUDに出す行の並びへ落とす
 * （フェーズD-20）。**誰への案内かはここで決める**：シーン側は「守備側の案内／攻撃側の
 * 案内」しか知らず、それがどちらのプレイヤーのものかを知っているのは main.ts だけ
 * （能力値の解決を main.ts に集約しているのと同じ分担）。
 *
 * 1P PLAY では `player: null` を渡す＝行頭のラベルもキー名の読み替えも付かない
 * ＝D-20より前とまったく同じ表示になる。
 */
function promptLines(prompt: PlayPrompt): PlayPromptLine[] {
  const twoPlayer = isTwoPlayer(controllers);
  const lines: PlayPromptLine[] = [];
  const add = (kind: PlayPromptKind | null, player: PlayerSlot | null): void => {
    if (kind === null) return;
    lines.push({ kind, player: twoPlayer ? player : null });
  };
  add(prompt.defense, defensePlayerNow());
  add(prompt.offense, offensePlayerNow());
  return lines;
}

// ---- ちっちゃいモードの追従カメラ（フェーズE-24） ----

/** 走者を指す印の投影に使う高さ（足元ではなく体のあたりを指す）。 */
const RUNNER_MARKER_HEIGHT = 0.6;
/** 鷹の落下点の矢印の色（落下点の印と同じ金色＝`skillFx` の landingMark） */
const HAWK_MARKER_COLOR = '#ffe066';
/** 画面外マーカーを画面端からどれだけ内側に置くか（画面の3%内側） */
const EDGE_MARKER_MARGIN = 0.06;
/** 投影の作業用ベクトル（毎フレーム確保しないよう使い回す） */
const projected = new THREE.Vector3();

/**
 * 追従カメラと画面外マーカーを1フレーム分進める（フェーズE-24）。
 *
 * **フィールドプレーの更新より後に呼ぶ**（動いた後のボール・走者の位置で追う）。
 * プレー外では focus が null になり、リグはそれを「次のプレーは瞬時に合わせる」の
 * 合図として使う＝モードの切り替えが瞬時カット（原作準拠）であることと辻褄が合う。
 */
/**
 * ノックを1本打ち出す（フェーズPP-64の `field` モード）。
 *
 * **打球のプレーの入口は本番とまったく同じ**（`fieldPlay.launch` → `BATTED_BALL`）＝
 * 捕球・送球・タッチ・走者の帰結はすべて本番の判定がそのまま出る。違うのは
 * **打球の出どころが打撃ではなくノックの設定**であることと、**結果を記録しない**ことだけ。
 */
function fireKnock(): void {
  if (!practice || fieldPlay.isActive()) return;
  const ctx = gameActor.getSnapshot().context;
  const roster = ctx.rosters[battingTeam(ctx.half)];
  // 走者は**攻撃側の打線の上から**置く（名鑑の選手なので走力もそのまま効く＝
  // 「足の速い走者だと送球が間に合わない」まで本番と同じ条件で見られる）。
  const pattern = KNOCK_RUNNER_PATTERNS[practiceKnock.runners].bases;
  const runners: BaseRunners = { first: null, second: null, third: null };
  pattern.forEach((base, i) => {
    runners[base] = roster.lineup[(roster.lineupIndex + 1 + i) % roster.lineup.length];
  });
  fieldPlay.launch(knockLaunch(practiceKnock), runners, currentBatterRunnerId(), ctx.outs);
  modeActor.send({ type: 'BATTED_BALL' });
  syncChicchaiCamera(0);
}

/**
 * デバッグモードの数字キー（フェーズPP-64）。**ゲームのキーマップ（`input/keyboard.ts`）には
 * 1つも足さない**ので、本番の操作は1つも奪われない（`practice` が null の間は何も起きない）。
 */
window.addEventListener('keydown', (e) => {
  if (!practice || e.repeat) return;
  if (practice === 'brawl') {
    if (e.code === PRACTICE_KEYS.brawlDummy) {
      practiceBrawl = { ...practiceBrawl, dummy: (practiceBrawl.dummy + 1) % PRACTICE_DUMMIES.length };
      brawl.setDummy('pitcher', PRACTICE_DUMMIES[practiceBrawl.dummy].id);
    } else if (e.code === PRACTICE_KEYS.brawlSuper) {
      practiceBrawl = { ...practiceBrawl, super: (practiceBrawl.super + 1) % PRACTICE_SUPERS.length };
      startPracticeBrawl();
    } else if (e.code === PRACTICE_KEYS.brawlFoe) {
      practiceBrawl = { ...practiceBrawl, foeSpecials: !practiceBrawl.foeSpecials };
      startPracticeBrawl();
    } else return;
    syncPracticeHud();
    return;
  }
  // スキルを1枚ずつ試す（フェーズYY-73）：0＝次・9＝前
  if (e.code === PRACTICE_KEYS.skillNext || e.code === PRACTICE_KEYS.skillPrev) {
    practiceSkill = cyclePracticeSkill(practiceSkill, e.code === PRACTICE_KEYS.skillNext ? 1 : -1);
    const skillId = practiceSkill < 0 ? null : PRACTICE_SKILLS[practiceSkill];
    for (const side of practiceSkillSides(practice)) gameActor.send({ type: 'DEBUG_SET_SKILL', side, skillId });
    syncPracticeHud();
    return;
  }
  if (practice === 'pitch' && e.code === PRACTICE_KEYS.toggleSwing) {
    practiceSwing = !practiceSwing;
    syncPracticeHud();
    return;
  }
  if (practice !== 'field') return;
  if (e.code === PRACTICE_KEYS.cycleDirection) practiceKnock = cycleKnock(practiceKnock, 'direction');
  else if (e.code === PRACTICE_KEYS.cycleKind) practiceKnock = cycleKnock(practiceKnock, 'kind');
  else if (e.code === PRACTICE_KEYS.cycleRunners) practiceKnock = cycleKnock(practiceKnock, 'runners');
  else if (e.code === PRACTICE_KEYS.knock) {
    fireKnock();
    return;
  } else return;
  syncPracticeHud();
});

function syncChicchaiCamera(dt: number): void {
  const focus = fieldPlay.cameraFocus();
  chicchaiRig.update(focus, dt);
  if (focus === null || currentMode() !== 'chicchai') {
    hud.showRunnerMarkers([]);
    return;
  }
  const markers: Array<EdgeMarker & { color?: string }> = [];
  for (const p of fieldPlay.markedRunners()) {
    projected.set(p.x, RUNNER_MARKER_HEIGHT, p.z).project(chicchaiCamera);
    const marker = edgeMarker(projected, EDGE_MARKER_MARGIN);
    if (marker) markers.push(marker);
  }
  if (hawkLanding) {
    projected.set(hawkLanding.x, 0.1, hawkLanding.z).project(chicchaiCamera);
    const marker = edgeMarker(projected, EDGE_MARKER_MARGIN);
    if (marker) markers.push({ ...marker, color: HAWK_MARKER_COLOR });
  }
  hud.showRunnerMarkers(markers);
}

// ---- ローグライトのスキル抽選（フェーズF-26-1。CLAUDE.md ⑧） ----
//
// **その回の攻撃が始まる前に、攻撃側が1つ引く**（1回表・1回裏も含むので両チーム9回ずつで
// 完全に対称）。イニングの表裏が切り替わった最初のフレームで検出する＝E-23の「間」を
// 状態の差分から導出しているのと同じ考え方で、抽選のイベントを個別に捕まえに行かない。
//
// 人間側は3択画面（試合を止める。采配メニューと同じ扱い）、CPU側は決定的な規則で即決し、
// **何を取ったかは必ずバナーで見せる**（相手の手の内を隠すと、こちらの采配の判断材料が
// 欠ける＝既存の「意思決定材料は隠さない」方針）。
let draftOpen = false;
/** 最後に抽選を起こしたイニングの表裏（同じ回で二重に引かないための目印） */
let lastDraftMarker: string | null = null;

function draftMarkerOf(ctx: GameContext): string {
  return `${ctx.inning}-${ctx.half}`;
}

/**
 * CPU側の抽選を決定的に解決する（乱数は引かない。規則は skills.ts の cpuChooseSkill）。
 *
 * **リロールも決定的な規則で使う**（フェーズU-42。`shouldCpuReroll`＝★2以上が1枚も
 * 無ければ引き直す）。**CPUは温存しない**（F-26-8と同じ）＝規則が言うたびに切り、
 * 回数券が尽きたら黙る。`SKILL_DRAFT_REROLLED` は残りが無ければ何も起こさないので、
 * ここは「言う限り送る」だけでよい（送った回数と実際に減った回数は状態の側が決める）。
 */
function resolveCpuDraft(ctx: GameContext, side: TeamSide): void {
  let current = ctx;
  let pending = current.pendingDraft;
  if (!pending) return;
  while (rerollsLeftOf(current, side) > 0 && shouldCpuReroll(pending.draft)) {
    gameActor.send({ type: 'SKILL_DRAFT_REROLLED', side });
    const next = gameActor.getSnapshot().context;
    // 引き直せなかった（＝候補が作れない等で状態が動かなかった）ら、そこで打ち切る
    if (next.rerollsUsed[side] === current.rerollsUsed[side]) break;
    current = next;
    if (!current.pendingDraft) return;
    pending = current.pendingDraft;
  }
  const roster = current.rosters[side];
  const picked = cpuChooseSkill(pending.draft, skillHoldersOf(roster));
  if (!picked) {
    // 付けられる選手がいない＝提示を畳むだけ（存在しない選手IDを送って握りつぶさせる
    // のではなく、意図を明示して畳む）
    gameActor.send({ type: 'SKILL_GRANTED', side, playerId: '', skillId: pending.draft.options[0] });
    return;
  }
  gameActor.send({
    type: 'SKILL_GRANTED',
    side,
    playerId: picked.holderId,
    skillId: picked.skillId,
  });
  hud.playBanner(
    'stamina',
    `相手のスキル\n${roster.players[picked.holderId].name} ${skillDef(picked.skillId).name}`,
  );
}

/**
 * でっかいモードにいる間だけ毎フレーム呼ぶ。イニングの表裏が変わっていれば抽選を起こす。
 * **true を返している間は3択画面が開いている**＝呼び出し側は全アクターを静止させる。
 */
function syncSkillDraft(ctx: GameContext): boolean {
  if (draftOpen) return true;
  // デバッグモード（フェーズPP-64）では抽選そのものを起こさない＝**確認したい局面の前に
  // 3択画面が挟まらない**（スキルの効果を見たいときは、通常のプレイで引くか名鑑を触る）。
  if (practice) return false;
  if (gameIsOver()) return false;
  const marker = draftMarkerOf(ctx);
  if (marker === lastDraftMarker) return false;
  lastDraftMarker = marker;

  gameActor.send({ type: 'SKILL_DRAFT_DRAWN' });
  const drawn = gameActor.getSnapshot().context;
  const pending = drawn.pendingDraft;
  // 候補が1つも作れなければ（全員の枠が埋まった等）抽選そのものが起きない
  if (!pending) return false;

  // その回の攻撃側を操作しているのが人間なら3択画面、CPUなら決定的な規則で即決する
  // （フェーズD-20：2P PLAY では両チームとも人間が引く＝⑧の対等がそのまま人対人になる）。
  const player = playerOfSide(controllers, pending.side);
  if (player === null) {
    resolveCpuDraft(drawn, pending.side);
    return false;
  }

  draftOpen = true;
  syncMusic();
  const roster = drawn.rosters[pending.side];
  runSkillDraft(app, pads[player], {
    draft: pending.draft,
    roster,
    teamName: roster.team.name,
    lineages: drawn.lineages,
    rerollsLeft: rerollsLeftOf(drawn, pending.side),
    // リロール（フェーズU-42）＝**引き直すのは状態の側**（乱数も回数券も gameMachine が
    // 持つ）。UIは押されたことだけを伝え、新しい3択と残り回数を受け取る。
    // 引き直せなければ `null` を返す＝UIは何も変えない（回数券も減らない）。
    reroll: () => {
      // **直前の状態と比べる**（画面を開いた時点ではない）＝2回目以降のリロールでも
      // 「実際に引き直せたか」を正しく見分けられる
      const before = gameActor.getSnapshot().context;
      gameActor.send({ type: 'SKILL_DRAFT_REROLLED', side: pending.side });
      const next = gameActor.getSnapshot().context;
      if (next.rerollsUsed[pending.side] === before.rerollsUsed[pending.side]) return null;
      if (!next.pendingDraft || next.pendingDraft.side !== pending.side) return null;
      return {
        draft: next.pendingDraft.draft,
        left: rerollsLeftOf(next, pending.side),
      };
    },
  }).then((choice) => {
    gameActor.send({
      type: 'SKILL_GRANTED',
      side: pending.side,
      playerId: choice.playerId,
      skillId: choice.skillId,
    });
    draftOpen = false;
    syncMusic();
  });
  return true;
}

// ---- ラン：試合をまたぐ蓄積（フェーズF-26-6。CLAUDE.md ⑧） ----
//
// **5試合の勝ち抜き**。試合が決着するたびにここへ戻ってきて、勝っていれば次の相手を
// 選んで**アクターを作り直す**（1試合＝1組のアクター。上の「ステートマシン起動」参照）。
// 持ち越すのは `TeamRoster.skills` だけで、投球数・退場・好調・カウントは新しい試合の
// ぶんが最初から組み直される（＝毎試合スタミナも控えも全員そろった状態から始まる）。

/** 1試合を始めるのに要るものすべて（`MATCH_SETUP` に渡す内容＋球場） */
interface GameSetup {
  away: TeamId;
  home: TeamId;
  plans: Partial<Record<TeamSide, RosterPlan>>;
  seed: number;
  skills: Partial<Record<TeamSide, CarriedSkills>>;
  /**
   * 消費型スキルの使用回数（フェーズF-26-8）。**人間側だけが持ち越す**：CPU側は毎試合
   * `preloadedSkills` で組み直される新しいロスターなので、使った回数は残らない
   * （相手は「ここまでの試合数ぶんの蓄積」であって、同じ選手が5試合を戦い抜くわけではない）。
   */
  uses: Partial<Record<TeamSide, CarriedUses>>;
  /**
   * リロールをここまでに使った回数（フェーズU-42）。**両側とも持ち越す**：人間側は
   * ランの記録から、CPU側は `preloadedSkills` が過去の試合ぶんの蓄積を作るときに
   * 使ったぶんから（＝人間とまったく同じ資源のもとで蓄積している＝⑧の「CPUも対等」）。
   */
  rerolls: Partial<Record<TeamSide, number>>;
  /**
   * 前の試合までに投げた球数（フェーズV-43の疲労の持ち越し）。**人間側だけが持ち越す**
   * ＝`uses` とまったく同じ理由で、CPU側は毎試合 `preloadedSkills` が組み直す新しい
   * ロスターなので前の試合の球数が残らない（相手は「ここまでの試合数ぶんの蓄積」であって、
   * 同じ投手陣が5試合を投げ抜くわけではない）。**CPUのローテーション（R-39）は
   * `cpuStarterIndex` が先発型4人を順に回すので、そもそも連投しない。**
   */
  fatigue: Partial<Record<TeamSide, CarriedFatigue>>;
  park: BallparkId;
}

/**
 * ランの今の試合を `MATCH_SETUP` に渡せる形へ落とす。
 *
 * **相手のスキルはここで組み立てる**（`preloadedSkills`）＝「相手もここまでの試合数ぶん
 * 蓄積している」（⑧のCPU対等）を、gameMachine ではなくランの側の規則として持つ。
 * 人間側は前の試合から持ち越したものをそのまま渡す。
 */
function gameSetupOf(state: RunState): GameSetup {
  const cpuSide = opponent(state.side);
  const preloaded = preloadedSkills({
    team: state.current.opponent,
    seed: state.current.seed,
    game: state.game,
  });
  return {
    away: state.side === 'away' ? state.teamId : state.current.opponent,
    home: state.side === 'home' ? state.teamId : state.current.opponent,
    // 試合前の采配（C-15）。人間側は自分で決めたもの、**CPU側は先発だけ規則で決める**
    // （フェーズR-39の `cpuRosterPlan`＝先発型4人を試合ごとに回す。打順は計測の結論で
    // 名鑑どおり）。それまでCPUは毎試合かならず名鑑の先頭の投手を先発させていた。
    plans: { [state.side]: state.plan, [cpuSide]: cpuRosterPlan(state.game) },
    seed: state.current.seed,
    skills: {
      [state.side]: state.skills,
      [cpuSide]: preloaded.skills,
    },
    uses: { [state.side]: state.uses },
    rerolls: { [state.side]: state.rerollsUsed, [cpuSide]: preloaded.rerollsUsed },
    fatigue: { [state.side]: state.fatigue },
    park: state.current.park,
  };
}

/**
 * 試合をまたいで残ってはいけない一時状態を全部畳む。**アクターの外にある「この試合の
 * 覚え書き」がここに集まっている**（1打席1回の使用済みフラグ・間・抽選の目印・
 * 決着待ちの保留）ので、新しい試合を始める前にまとめて戻す。
 */
function resetPerGameState(): void {
  winAnnounced = false;
  resultPauseRemaining = 0;
  lastDraftMarker = null;
  lastAtBatMarker = null;
  clearInterlude();
  lastPlateAppearanceKey = '';
  cpuPickoffUsed = false;
  cpuStealUsed = false;
  offenseLeadUsed = false;
  cpuGunUsed = false;
  staminaDropAnnounced.clear();
  stealActive = false;
  carriedLeads = {};
  pendingPitch = null;
  pendingBatted = null;
  pendingGunHit = false;
  pendingHbpRestore = null;
  contactFollowRemaining = 0;
  contactBall = null;
  gunHitStopRemaining = 0;
  gunTelegraphRemaining = 0;
  dekkaiPromptShown = '';
  hud.showPlayPrompt([]);
  gun.exit();
  // 投手・打者を既定色へ戻す（WW-71で乱闘の色替えはやめたが、色は試合ごとに必ず揃えておく）
  setPlayerColor(batter, BATTER_COLOR);
  setPlayerColor(pitcher, PITCHER_COLOR);
}

/**
 * 1試合を始める。**アクターを作り直して購読を張り直す**のがランの要点で、
 * `MATCH_SETUP` が「まだ1球も投げていないときだけ効く」（`isPreGame`）という既存の
 * 成立条件も、作りたてのアクターなら必ず満たされる。
 */
function startGame(setup: GameSetup): void {
  gameActor.stop();
  modeActor.stop();
  gameActor = createActor(gameMachine).start();
  modeActor = createActor(modeMachine).start();
  subscribeActors();
  resetPerGameState();
  applyBallpark(setup.park);
  gameActor.send({
    type: 'MATCH_SETUP',
    away: setup.away,
    home: setup.home,
    plans: setup.plans,
    seed: setup.seed,
    skills: setup.skills,
    uses: setup.uses,
    rerolls: setup.rerolls,
    fatigue: setup.fatigue,
  });
  crowd.startAmbience();
  refresh();
}

/**
 * デバッグの乱闘（フェーズXX-72）。**死球の画面を通らずに乱闘へ入る**（打者＝人間・
 * 必殺技と超必殺を全部持つ）。体力は戻り・ゲージは満タン・時間は止まるので終わらない。
 */
function startPracticeBrawl(): void {
  const mode = currentMode();
  if (mode === 'dekkai') modeActor.send({ type: 'DEAD_BALL' });
  if (currentMode() === 'deadBall') modeActor.send({ type: 'BRAWL_START' });
  brawl.enter(
    { batter: practiceBrawlLoadout(practiceBrawl.super), pitcher: practiceFoeLoadout(practiceBrawl) },
    brawlNames(),
    { refillHp: true, fullMeter: true },
  );
  brawl.setDummy('pitcher', PRACTICE_DUMMIES[practiceBrawl.dummy].id);
}

/**
 * チーム選択の結果から試合を始める（起動時と、ラン／2Pの試合が終わった後の再挑戦）。
 *
 * **1P PLAY はラン（5試合の勝ち抜き。フェーズF-26-6）、2P PLAY は1試合完結**
 * （2026-07-31 ユーザー判断）。ランは「人間側が1つだけ」を前提に組んである
 * （扉で次の相手を選ぶ・相手はCPU規則で蓄積済み・持ち越すのは人間側のスキルだけ）ので、
 * 両側が人間の 2P PLAY をそこへ通すと意味が壊れる。**2P はランを作らない**
 * （`run = null`）＝スコアボードの `ラン n/5` の行も出ない。
 */
function startMatch(selection: MatchSelection): void {
  controllers = controllersFor(selection.mode, selection.humanSide);
  practice = selection.practice ?? null;
  practiceSwing = false;
  practiceKnock = INITIAL_KNOCK;
  practiceBrawl = INITIAL_BRAWL_PRACTICE;
  practiceSkill = -1;
  // **null なら消える**ので、デバッグモードの後に通常のプレイを始めても行が残らない
  // （デバッグの状態はここ1か所でしか切り替わらない）。
  syncPracticeHud();
  if (practice) {
    // デバッグモード（フェーズPP-64）は**ランの外＝1試合完結**（2P PLAY と同じ扱い）。
    // ランに通すと扉・抽選・勝敗の画面が挟まるが、ここで見たいのは1つの局面だけ。
    run = null;
    twoPlayerMatch = null;
    startGame({
      away: selection.away,
      home: selection.home,
      plans: selection.plans,
      // シードは固定＝**同じ場面が毎回同じ条件で出る**（好調・系統の絞り込みも動かない）。
      // 確認したいものだけを動かす、という道具の性質に合わせてある。
      seed: 1,
      skills: {},
      uses: {},
      rerolls: {},
      fatigue: {},
      park: selection.park,
    });
    gameStarted = true;
    hudRoot.style.display = '';
    if (practice === 'brawl') startPracticeBrawl();
    return;
  }
  if (selection.mode === '2p') {
    run = null;
    twoPlayerMatch = { away: selection.away, home: selection.home };
    startGame({
      away: selection.away,
      home: selection.home,
      // 試合前の采配は**両側ぶん**（フェーズC-15の `plans` は最初から両側を持てる形）
      plans: selection.plans,
      // シードは実プレイなので時刻から（系統の絞り込み・絶好調選手がここから決まる）
      seed: Date.now(),
      skills: {},
      uses: {},
      // 2P PLAY はランの外＝1試合完結（D-20）なので、リロールの回数券は**両者とも満タン**
      // から始まる（`REROLLS_PER_RUN` をその1試合で使い切る）。
      rerolls: {},
      // 同じ理由で**投手も両者とも無傷**（V-43の疲労の持ち越しはランの仕組み）。
      fatigue: {},
      park: selection.park,
    });
  } else {
    twoPlayerMatch = null;
    run = createRun({
      // ランのシード（フェーズF-26-1と同じく**実プレイだけ時刻から取る**）。ここから
      // 5試合ぶんの相手・球場・系統・好調・抽選がすべて決まる。
      seed: Date.now(),
      teamId: selection.humanSide === 'away' ? selection.away : selection.home,
      side: selection.humanSide,
      plan: selection.plans[selection.humanSide] ?? DEFAULT_ROSTER_PLAN,
      opponent: selection.humanSide === 'away' ? selection.home : selection.away,
      park: selection.park,
    });
    startGame(gameSetupOf(run));
  }
  gameStarted = true;
  hudRoot.style.display = '';
}


/** ランの成果（「ムラセ: キンニク ネバリ」の並び）。終了画面で見せる */
function runBuildLines(): string[] {
  if (!run) return [];
  const roster = gameActor.getSnapshot().context.rosters[run.side];
  return Object.keys(roster.skills)
    .filter((id) => roster.skills[id].length > 0)
    .map((id) => {
      const names = roster.skills[id].map((skillId) => skillDef(skillId).name).join(' ');
      return `${roster.players[id]?.name ?? id}: ${names}`;
    });
}

/**
 * 2P PLAY の試合結果（フェーズD-20）。**ランの外＝1試合完結**なので、勝った側を見せて
 * チーム選択へ戻すだけ（勝敗・持ち越し・扉は無い）。
 */
async function openMatchEndScreen(): Promise<void> {
  const card = twoPlayerMatch;
  if (!card) return;
  runScreenOpen = true;
  const ctx = gameActor.getSnapshot().context;
  const winner = ctx.winner;
  // 勝った側がどちらのプレイヤーだったかを出す（攻守は表裏で入れ替わるので、
  // 「どちらが勝ったか」は球団名だけでは読み取りにくい）。
  const winnerPlayer = winner === null ? null : playerOfSide(controllers, winner);
  await matchEnd(app, anyPad, {
    headline:
      winnerPlayer === null
        ? '引き分け'
        : `${winnerPlayer === 'p1' ? '1P' : '2P'}の勝ち！`,
    score: `${ctx.rosters.away.team.short} ${ctx.score.away} - ${ctx.score.home} ${ctx.rosters.home.team.short}`,
    lines: [
      `1P: ${ctx.rosters[sideOfPlayer(controllers, 'p1') ?? 'away'].team.name}`,
      `2P: ${ctx.rosters[sideOfPlayer(controllers, 'p2') ?? 'home'].team.name}`,
    ],
  });
  hudRoot.style.display = 'none';
  backToTitleAudio();
  const selection = await runTeamSelect(app, pads);
  startMatch(selection);
  runScreenOpen = false;
}

/**
 * 試合の決着をランに反映して、次の相手を選ばせる（勝ったとき）か、ランを終える。
 * **開いている間は `runScreenOpen` で全アクターを止める**（采配メニュー・抽選画面と同じ扱い）。
 */
async function openRunScreen(): Promise<void> {
  // 2P PLAY はランの外（フェーズD-20）＝こちらの経路で結果を見せる
  if (run === null) {
    await openMatchEndScreen();
    return;
  }
  const finished = run;
  runScreenOpen = true;
  syncMusic();
  const ctx = gameActor.getSnapshot().context;
  const won = ctx.winner === finished.side;
  // **勝敗を記録する前に問う**（記録した後は「負けた」という事実が勝ち数の差にしか残らない）
  const outcome = runOutcomeAfter(finished, won);
  // 持ち越すのは**この試合を戦い抜いたロスターのスキル**（退場者のぶんも含めて残す＝
  // 乱闘で退場した選手も次の試合には戻ってくるので、そのスキルも一緒に戻る）。
  const carried = ctx.rosters[finished.side].skills;
  // 消費型のチャージも一緒に持ち越す（F-26-8）＝**ラン全体で使い切り**。ここを渡さないと
  // 試合ごとに全回復し、「温存する／しない」の判断が成立しなくなる。
  const carriedUses = ctx.rosters[finished.side].skillUses;
  // リロールの回数券も同じく持ち越す（フェーズU-42）＝**ラン全体で使い切り**。
  // 真実は「使った数」の側なので、試合中に増えた `rerollsUsed` をそのまま書き戻す。
  const carriedRerolls = ctx.rerollsUsed[finished.side];
  // 投手の疲れ（フェーズV-43）。**この試合の投球数から休養ぶんを引いた残り**で、
  // 投げなかった投手は前の試合の持ち越しが減るだけ＝`restedPitchCounts` 1本で
  // 「積む」と「戻す」が閉じる。ここを渡さないと毎試合全快し、先発を選び直せる意味
  // （＝毎試合エースが支配戦略にならないこと）が消える。
  const carriedFatigue = restedPitchCounts(ctx.rosters[finished.side]);
  const state = withGameResult(finished, won);
  run = state;
  // 勝ち数はHUDのスコアボードにも出ているので、記録したその場で描き直す（アクターの
  // 状態は変わらないため購読は走らない＝これが無いと勝った試合のぶんだけ表示が遅れる）。
  refresh();

  if (outcome === 'continue') {
    const doors = runDoors(state);
    // 次の相手が持ってくるスキルの数（＝相手も同じだけ蓄積している、の可視化）。
    // どちらの扉でも試合数は同じなので、代表して先頭の扉で数える。
    const preview = preloadedSkills({
      team: doors[0].opponent,
      seed: doors[0].seed,
      game: state.game + 1,
    });
    const index = await runNextSelect(app, pads.p1, {
      headline: `${state.game}試合目 勝利！`,
      score: `${ctx.rosters.away.team.short} ${ctx.score.away} - ${ctx.score.home} ${ctx.rosters.home.team.short}`,
      progress: `次は ${state.game + 1}/${RUN_GAMES}試合目`,
      opponentSkills: skillCount(preview.skills),
      // 温存の判断（フェーズU-42）はここでする＝次の試合へ何回持っていけるかを見せる
      rerollsLeft: rerollsLeft(carriedRerolls),
      doors,
    });
    // 試合と試合の間の采配（フェーズV-43）＝**先発の選び直しと打順の組み直し**。
    // **扉を選んだ後**に置く：誰に投げさせるかは「次の相手・球場」が決まってからでないと
    // 決められない（C-15が采配を球団・球場の後に置いたのとまったく同じ理由）。
    // 残量も能力値も**次の試合と同じ手順で組んだ1つのロスター**から読む（`nextGameRoster`）
    // ＝画面の数字と試合の中身が一致する（投手陣＝DD-51／打線＝EE-52）。
    const door = doors[index];
    const plan = await runRosterPlanSelect(app, pads.p1, {
      teamId: state.teamId,
      plan: state.plan,
      carried: { skills: carried, uses: carriedUses, fatigue: carriedFatigue },
      headline: `${state.game + 1}試合目`,
    });
    run = withNextGame(state, door, carried, carriedUses, carriedRerolls, carriedFatigue, plan);
    startGame(gameSetupOf(run));
    runScreenOpen = false;
    return;
  }

  await runEnd(app, pads.p1, {
    cleared: outcome === 'clear',
    game: state.game,
    wins: state.wins,
    total: RUN_GAMES,
    build: runBuildLines(),
  });
  // 新しいランはチーム選択からやり直す（保存はしない＝セッション内だけのラン）。
  hudRoot.style.display = 'none';
  backToTitleAudio();
  const selection = await runTeamSelect(app, pads);
  startMatch(selection);
  runScreenOpen = false;
}

// ---- 入力ハンドラ（フェーズD-20：プレイヤーごとに1回ずつ登録する） ----
//
// **押したのが誰かで役割が決まる**（`roleOfPlayer`）。D-20より前は「人間は1人」だったので
// `isPitchingHuman()` を見れば押した人の役割まで決まったが、2P PLAY では同じキー（A）が
// 1Pには投球・2Pには打撃を意味する。押下ハンドラをプレイヤーごとに登録し、その人の役割で
// 分岐させることで、**同じ場面で2人が別々の操作を同時にできる**（投げながら振れる）。

function onStart(player: PlayerSlot): void {
  if (menuOpen || draftOpen || runScreenOpen || !canOpenManagerMenu()) return;
  // 采配メニューは「押した人がいま担っている役割」の交代だけを扱う（相手の采配は触れない）。
  // 2P PLAY では**先に押したほうが開く**（開いている間は全アクター静止＝Start=ポーズ）。
  const role = roleOfPlayer(controllers, currentHalf(), player);
  if (role === null) return;
  menuOpen = true;
  const ctx = gameActor.getSnapshot().context;
  const side = role === 'batting' ? battingTeam(ctx.half) : fieldingTeam(ctx.half);
  // イニングを渡すのはラッキー7（フェーズD-19）のため＝7回は候補も現打者も全員が
  // 好調として並ぶ（好調の理由がどれであれ、代打の判断材料としては同じもの）。
  runManagerMenu(app, pads[player], {
    role,
    roster: ctx.rosters[side],
    inning: ctx.inning,
    // 敬遠（フェーズQ-38）は守備側の采配なので、投手側のメニューにだけ並ぶ。
    // 相手のロスターそのものは渡さない（采配は自分の側だけ、という既存の切り分け）＝
    // 表示に要る名前と塁状況だけを渡す。
    intentionalWalk: role === 'pitching' ? intentionalWalkTarget(ctx) : undefined,
    // 代走（フェーズGG-54）は攻撃側の采配なので、打者側のメニューにだけ並ぶ。
    // 敬遠と同じ整理で、**塁の上に誰がいるかは `baseRunners` の側にある**ので渡す。
    pinchRun: role === 'batting' ? pinchRunTargets(ctx) : undefined,
  }).then((choice) => {
    if (choice) {
      if (choice.kind === 'intentionalWalk') {
        declareIntentionalWalk(side);
      } else if (choice.kind === 'pinchRun') {
        gameActor.send({
          type: 'SUBSTITUTE_RUNNER',
          side,
          base: choice.base,
          benchIndex: choice.index,
        });
      } else if (role === 'batting') {
        gameActor.send({ type: 'SUBSTITUTE_BATTER', side, benchIndex: choice.index });
      } else {
        gameActor.send({ type: 'SUBSTITUTE_PITCHER', side, bullpenIndex: choice.index });
      }
    }
    menuOpen = false;
  });
}

/**
 * 采配メニューに出す代走の対象（フェーズGG-54）＝**塁にいて、かつロスターから引ける走者**。
 *
 * 並びは一塁→二塁→三塁で、**FF-53の状況パネルの走力の行・L-32のリードの行と同じ順**
 * （同じ走者について3つの材料が、どの画面でも同じ並びで出る）。
 *
 * **無名の走者（`ANONYMOUS_RUNNER`）は外す**：テストが真偽値の塁状況だけを送ってきた
 * 経路では走者の識別が無く、代走を送る相手にできない（`substituteRunnerAt` も同じ理由で
 * 弾くので、ここで外すのは「押せない行を並べない」ため）。
 */
function pinchRunTargets(ctx: GameContext): PinchRunTarget[] {
  const roster = ctx.rosters[battingTeam(ctx.half)];
  const targets: PinchRunTarget[] = [];
  for (const base of ['first', 'second', 'third'] as const) {
    const runnerId = ctx.baseRunners[base];
    if (runnerId === null || roster.players[runnerId] === undefined) continue;
    targets.push({ base, runnerId });
  }
  return targets;
}

/** 采配メニューに出す敬遠の相手（フェーズQ-38）＝今の打者・次打者・塁状況 */
function intentionalWalkTarget(ctx: GameContext): IntentionalWalkTarget {
  const batting = ctx.rosters[battingTeam(ctx.half)];
  return {
    batterName: batting.players[currentBatterId(batting)].name,
    nextBatterName: batting.players[nextBatterId(batting)].name,
    bases: ctx.bases,
  };
}

/**
 * 敬遠を宣言する（フェーズQ-38。人間の采配メニューからも、CPUの判断からも通る1本）。
 *
 * **投げないので投球数は増えない**（`PITCH_THROWN` を送らない＝B-11のスタミナは減らず、
 * けん制球・銃と同じ扱い）。押し出しの得点・打順の進行・カウントのリセットは
 * `gameMachine` の `applyWalk` が四球とまったく同じ経路で面倒を見る。
 *
 * 見せ方は四球と同じバナー1枚（文言だけ `ケイエン`）＝**何が起きたのかが1行で分かる**。
 * この後は打者が代わるので、E-23の「打者の仕切り直し」の間がそのまま入る。
 */
function declareIntentionalWalk(side: TeamSide): void {
  sfx.walk();
  hud.playBanner('walk', '敬遠');
  gameActor.send({ type: 'INTENTIONAL_WALK', side });
}

function onA(player: PlayerSlot): void {
  if (!gameStarted || gameIsOver() || hitStopActive() || gunHitStopActive()) return;
  // 画面を止めている間（采配メニュー・スキル抽選・ランの画面）は試合側の操作を受け付けない。
  // **抽選・ランの画面は D-20 以前は素通ししていた**：人間が1人のときは「抽選を閉じるK」と
  // 「投球のK」が同じ人の同じキーだったので、閉じた瞬間に投げ始めるのは自然に見えていた。
  // 2P PLAY では**相手が抽選を選んでいる間に自分のキーが試合へ届く**ことになり、
  // 実機で「抽選中に押した投球が、画面を閉じた瞬間に始まっていた」のを踏んだ。
  if (menuOpen || draftOpen || runScreenOpen) return;
  // CPUの銃の予兆（フェーズF-26-2）の最中は、静止しているので何も受け付けない
  if (gunTelegraphActive()) return;
  const role = roleOfPlayer(controllers, currentHalf(), player);
  if (role === null) return;
  switch (currentMode()) {
    case 'dekkai':
      // 打者の仕切り直し・攻守交代の「間」（フェーズE-23）が明けるまで投球も銃も撃てない
      if (interludeActive()) break;
      if (isGunMode()) {
        // 銃は投手側（守備側）だけが撃てる。CPUが投手のときの発射は予兆明けに
        // メインループが自分で撃つ（fireGun）ので、打者側のKはここで弾く。
        if (role !== 'pitching') break;
        fireGun();
      } else if (role === 'pitching') {
        // 投手側のA＝投球開始
        pitching.startPitch();
      } else {
        // 打者側のA＝スイング
        if (pitching.isPitchLive() && batting.trySwing()) sfx.swing();
      }
      break;
    case 'chicchai':
      if (role === 'pitching') {
        // 飛行中は十字キーの方向へファインプレイ（説明書p23：上=ジャンプ/左右=横っとび/
        // 下=ダイビング）、確保中は十字キーで塁指定した方向へ送球
        fieldPlay.action();
      } else if (hitAndRunOpen()) {
        // ヒットエンドラン（フェーズH-28）：盗塁を仕掛けた球がまだ生きている間だけ、
        // 攻撃側のAは「帰塁」ではなく**スイング**になる（原作の多目的ボタン方式の延長）。
        // 代償は「その間は帰塁できない」ことで、投球が終われば下の帰塁へ戻る。
        batting.trySwing();
      } else {
        // 攻撃側のAは「帰塁」（説明書p19：十字キーで帰る塁を指定。
        // 無指定なら直近に仕掛けた走者。次の塁を踏んだ走者は戻れない）
        fieldPlay.recallRunner();
      }
      break;
    case 'deadBall':
      // 乱闘を選ばない（説明書に無いオリジナル要素。CLAUDE.md ③）。**決めるのは殴られた
      // 打者側だけ**（フェーズWW-71。テストプレイ「ぶつけておいて、乱闘するかを投手の側が
      // 判断できるのはおかしい」）。1P PLAY で人間が投手のときは何も押せず、CPUの打者が
      // `shouldCpuStartBrawl` で決める（メインループの `updateCpuBrawlDecision`）。
      if (role !== 'batting') break;
      declineBrawl();
      break;
    case 'brawl':
      // 乱闘v3（XX-72）：A＝パンチ。**押した人が操作している側**（2P PLAY では投手側も人間）。
      // 押しっぱなしはシーンがパッドから読むので、ここは「押した瞬間」を取りこぼさないためだけ。
      brawl.press(role === 'pitching' ? 'pitcher' : 'batter', 'p');
      break;
  }
}

function onB(player: PlayerSlot): void {
  if (!gameStarted || gameIsOver() || hitStopActive() || gunHitStopActive()) return;
  if (menuOpen || draftOpen || runScreenOpen) return; // 上の onA と同じ理由
  // CPUの銃の予兆（フェーズF-26-2）の最中は、静止しているので何も受け付けない
  if (gunTelegraphActive()) return;
  const role = roleOfPlayer(controllers, currentHalf(), player);
  if (role === null) return;
  const mode = currentMode();
  if (mode === 'deadBall') {
    // 乱闘に持ち込むのは殴られた打者側だけ（上の onA と同じ理由。フェーズWW-71）
    if (role !== 'batting') return;
    startBrawl();
  } else if (mode === 'brawl') {
    // 乱闘v3（XX-72）：B＝キック（ガードは後ろを入れる。ストIIと同じ）
    brawl.press(role === 'pitching' ? 'pitcher' : 'batter', 'k');
  } else if (mode === 'chicchai') {
    if (role === 'pitching') {
      // 守備側のBは「ランダンプレイ」（説明書p25：十字キーで塁を指示。
      // 無指定なら一塁へ。ボールを持った野手がその塁へダッシュし、途中で塁間の走者に
      // 触れればタッチアウト）
      fieldPlay.startRundown();
    } else {
      // 攻撃側のBは「走塁進塁」（フォースされていない走者から1人選んで送る）
      fieldPlay.sendRunner();
    }
  } else if (mode === 'dekkai' && role === 'pitching' && canStartPickoff()) {
    // 投手側のBは「けん制球」（説明書p24：Bでちっちゃいモードへ切り替え、
    // そこで塁を指定してAで送球する）。
    startPickoff();
  } else if (mode === 'dekkai' && role === 'batting' && canStartSteal()) {
    // 打者側のBは「盗塁」（説明書p13：投球中も走塁操作が可能。走り出すと
    // ちっちゃいモードに変わる）。十字キーは進塁する塁の絶対指定＝走塁と同じ操作体系。
    const { x, y } = pads[player].direction();
    startSteal(baseFromPadDirection(x, y));
  }
}

function onGun(player: PlayerSlot): void {
  // 拡張ボタン（CLAUDE.md ①）の共通ガード。画面が止まっている間はどの機能も動かさない。
  if (
    !gameStarted ||
    gameIsOver() ||
    hitStopActive() ||
    gunHitStopActive() ||
    gunTelegraphActive() ||
    menuOpen ||
    draftOpen ||
    runScreenOpen
  ) {
    return;
  }
  const role = roleOfPlayer(controllers, currentHalf(), player);
  if (role === null) return;
  // 乱闘では G＝超必殺（乱闘v3。ゲージ満タンのときだけ出る）
  if (currentMode() === 'brawl') {
    brawl.press(role === 'pitching' ? 'pitcher' : 'batter', 's');
    return;
  }
  // ちっちゃいモードでは同じGが「ドロップキック」になる（フェーズF-26-4）。銃は
  // でっかいモードの投手側、ドロップキックはちっちゃいモードの走者側なので、
  // **同じキーでも同時に両方が意味を持つ場面が無い**（A/Bが場面で機能を変える
  // 原作の多目的ボタン方式と同じ切り分け）。持っていない選手のときは何も起きない。
  if (currentMode() === 'chicchai') {
    // 蹴るのは走者＝攻撃側だけ（フェーズD-20：2P PLAY では守備側のGは何も起こさない）
    if (role === 'batting') fieldPlay.dropkick();
    // **守備側のGは一時効果**（フェーズM-33。`ケモノガエリ`）。Gの4つの場面のうち
    // ここだけが空いていた（でっかい投手側＝銃／でっかい打者側＝一時効果／ちっちゃい
    // 走者側＝蹴り）。**打球を見てから切れる**のがこの札の値打ちなので、押す場所も
    // 打球が飛んでいる画面の側に置く。持っていない／切れる相手がいなければ何も起きない。
    else activateFieldingEffect();
    return;
  }
  // でっかいモードの打者側のGは**一時効果**（フェーズM-33。`シニモノグルイ`・
  // `ゼッタイヨチ`）。銃は投手側なので**同じキーでも同時に両方の意味を持つ場面が無い**
  // （A/Bが場面で機能を変える原作の多目的ボタン方式と同じ切り分け）。
  //
  // **投球動作中でも切れる**（銃と違ってモードに入らないので、下の `isBusy` のガードを
  // 通さない）。ここを塞ぐと、CPU投手が投げ始めるまでの短い隙にしか押せない＝実機では
  // ほぼ押せなかった（実際に踏んだ）。切れる時間を打席いっぱいに開けても、
  // **効果は打席という単位のまま**（成否は「どの打席で切るか」で決まり、
  // フレーム単位の押し勝ちにはならない＝AVは当たりやすさには効かないという⑥の前提）。
  if (interludeActive() || currentMode() !== 'dekkai') return;
  if (role === 'batting') {
    activateBattingEffect();
    return;
  }
  // ここから下は投手側（守備側）の銃だけ。
  // 投球動作中（ワインドアップ〜捕球）のモード切替は禁止。
  // 飛行中に銃モードへ入れると、判定前のKで銃の仮処理が二重発火するため。
  if (pitching.isBusy()) return;
  const game = gameActor.getSnapshot().context;
  const enteringGun = !isGunMode();
  // ONに入れるのは**スキル `ジュウ` を持つ投手に残弾があるときだけ**（フェーズF-26-2）。
  // 引いていない試合ではGキーは何も起こさない＝銃は常設の機能ではなくなった。
  if (enteringGun && !canShootGun(game.rosters[fieldingTeam(game.half)])) return;
  modeActor.send({ type: 'GUN_TOGGLE' });
  if (enteringGun) gun.enter();
  else gun.exit();
}

// **2人ぶんまとめて登録する**。1P PLAY では2P側の押下も届くが、`roleOfPlayer` が
// null を返すのでどのハンドラも即座に戻る（＝キーが効かない）。
for (const player of PLAYER_SLOTS) {
  pads[player].onPress('start', () => onStart(player));
  pads[player].onPress('a', () => onA(player));
  pads[player].onPress('b', () => onB(player));
  pads[player].onPress('gun', () => onGun(player));
}

// ---- メインループ ----
// 2P/CPU操作分離のチーム選択（runTeamSelect）が完了するまでループを開始しない
// （選択画面がプレイヤーの入力をブロックする、原作にはない追加の起動前ステップ）。

// タイトル（チーム選択）の曲。音はブラウザの決まりで最初のキー入力まで鳴らないので、
// ここでは「鳴らしたい曲」を頼んでおくだけ（解除された瞬間に鳴り始める）。
music.play('title');
installMusicToggle();

runTeamSelect(app, pads).then((selection) => {
  // 選んだモード（フェーズD-20）・16球団のカード（フェーズB-12/C-13）・球場（C-14）・
  // 試合前の采配（C-15）から**試合を始める**（1P PLAY はラン＝フェーズF-26-6、
  // 2P PLAY は1試合完結）。ロスターの真実は gameMachine のコンテキスト側にあるので、
  // 名鑑からロスターを組むのも向こうに任せ、こちらは「どの球団か」「どの球場か」
  // 「どんな采配か」と、ランが持ち越すスキルだけを渡す（startMatch → startGame）。
  startMatch(selection);
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const rawDt = clock.getDelta();
    // 時間停止（フェーズYY-73）：人間の打席で、球が本塁の手前にある間だけゲームの時計が遅い
    const timeScale = gameStarted ? skillTimeScale() : 1;
    if (timeScale === 1) hud.slowTint(false);
    const dt = rawDt * timeScale;

    // 采配メニュー・抽選画面・ランの画面の表示中は全アクター静止（Start=ポーズの文言どおり）。
    // メニュー自体の入力はrunManagerMenuが登録したpad.onPressハンドラで完結する。
    if (menuOpen || draftOpen || runScreenOpen) {
      renderFrame();
      return;
    }

    // 試合が決着したらランの分岐点（フェーズF-26-6）。決着の表示を読み切る「間」を置いて
    // から、次の相手を選ぶ画面（勝ち）かランの終了画面（負け・クリア）へ移る。
    // **ここで止めるので、決着後は全アクターが静止する**（従来は勝敗確定後も各コントローラーが
    // 空回りし続けていた＝どのみち gameIsOver() で何も起きないが、止めたほうが素直）。
    if (gameIsOver()) {
      resultPauseRemaining -= dt;
      if (resultPauseRemaining <= 0) void openRunScreen();
      renderFrame();
      return;
    }

    // 打ってからカットまで（フェーズWW-71）。**止めずに見せる**：打者は振り抜き、打球は
    // バットから飛び出していく。ほかのアクター（投手・野手・CPUの判断）は進めない＝
    // 守備のプレーは接触の瞬間の状態から始まる（判定は従来のヒットストップと同じ）。
    if (hitStopActive()) {
      contactFollowRemaining -= dt;
      batting.update(dt);
      advanceContactBall(dt);
      if (!hitStopActive() && pendingBatted) {
        contactBall = null;
        // 振り抜きの後始末（バントのバットを畳む等）。ここでカットするので構えへ戻る姿は映らない
        batting.endPitch();
        const ctx = gameActor.getSnapshot().context;
        // ヒットエンドラン（フェーズH-28）：盗塁のプレーが動いているなら、新しい
        // プレーを始めるのではなく**そのプレーを打球へ引き継ぐ**（走者はスタートを
        // 切った位置のまま走り続ける）。引き継いだ時点で打席は終わるので、
        // 保留していた1球（pendingPitch）は捨てる＝打たれた球はカウントに数えない。
        if (stealActive && fieldPlay.convertToBattedBall(pendingBatted, currentBatterRunnerId())) {
          stealActive = false;
          pendingPitch = null;
        } else {
          fieldPlay.launch(
            pendingBatted,
            ctx.baseRunners,
            currentBatterRunnerId(),
            ctx.outs,
            // 打球の瞬間も走者はリードを取っている（フェーズY-46）。渡すのは盗塁・けん制と
            // **同じ `resolveCarriedLeads` の結果**で、持ち越しが無い塁は標準のリードに
            // 落ちる（＝この1行が「見送れば3.5m・打てば0m」の食い違いを閉じている）。
            resolveCarriedLeads(ctx.baseRunners, carriedLeads),
          );
        }
        pendingBatted = null;
        // 盗塁からの引き継ぎではすでにちっちゃいモードにいる（chicchai は BATTED_BALL を
        // 受け取らないので、送っても何も起きない＝経路を分けずに済む）。
        modeActor.send({ type: 'BATTED_BALL' });
        // このフレームで初めてちっちゃいモードが描かれるので、ここで追従カメラを打球に
        // 合わせておく（フェーズE-24）。呼ばないと前のプレーのカメラ位置で1フレーム
        // 描かれてしまい、瞬時カットが「一瞬ずれた画」から始まることになる。
        syncChicchaiCamera(0);
      }
      renderFrame();
      return;
    }

    // 銃命中のヒットストップ中も同様に全体静止（マズルフラッシュも含め静止したまま見せる）
    if (gunHitStopActive()) {
      gunHitStopRemaining -= dt;
      if (!gunHitStopActive() && pendingGunHit) {
        pendingGunHit = false;
        gameActor.send({ type: 'HIT_BY_PITCH' });
        enterDeadBall(true);
      }
      renderFrame();
      return;
    }

    // CPU投手の銃の予兆（フェーズF-26-2）も全体静止。**gun.update より前に置く**のが
    // 要点で、後ろに置くと静止しているはずの間に人間（＝この場面では打者側）のWASDが
    // gun.update に流れ込み、**撃たれる側が相手の照準を動かせてしまう**。
    // 消化しきったフレームでそのまま撃つ（人間のKと同じ fireGun を通る）。
    if (gunTelegraphActive()) {
      gunTelegraphRemaining -= dt;
      if (!gunTelegraphActive()) {
        gunTelegraphRemaining = 0; // 端数の負値を残さない（次の予兆の計時が読みにくくなる）
        fireGun();
      }
      renderFrame();
      return;
    }

    // 死球のあと、CPUの打者が乱闘するかを決める（フェーズWW-71）
    if (currentMode() === 'deadBall' && !gameIsOver()) updateCpuBrawlDecision(dt);

    // 投球操作はでっかいモード（通常）でのみ受け付ける。銃モード中のWASDは照準（gun.update）が使う。
    // 接触判定は pitching.update 内の onFlightStep → batting.checkContact で行うため、
    // スイングタイマーを進める batting.update は必ずその後に呼ぶ。
    // controlActive（ready フェーズのプレート移動）は人間が投手側のときだけ有効にする
    // （CPUが投手側のときはcpuPitcherがリリース位置を直接セットするため、この経路は使わない）。
    const gunModeActive = currentMode() === 'dekkai' && isGunMode() && !gameIsOver();
    pitching.update(
      dt,
      currentMode() === 'dekkai' && !isGunMode() && !gameIsOver() && isPitchingHuman(),
    );
    // **銃は投球の後に更新する**（フェーズE-25-(e)）：どちらも投手の姿勢を書くので、
    // 構えを最後に書かせないと投球側の「構え（idle）」に毎フレーム上書きされて銃を
    // 構えられない（野手の捕球・走者のバイクと同じ後勝ちの形）。銃モードへ入れるのは
    // 投球動作中でないときだけ（`pitching.isBusy()` のガード）なので、投球の見た目が
    // これで途切れることはない。
    gun.update(dt, gunModeActive);

    if (currentMode() === 'dekkai' && !isGunMode() && !gameIsOver()) {
      const ctx = gameActor.getSnapshot().context;
      // スキル抽選（フェーズF-26-1）。イニングの表裏が変わった最初のフレームで起こす＝
      // **その回の1球目より必ず前**。3択画面が開いている間は下の処理をすべて止める
      // （投球・けん制・盗塁が裏で進むと、選んでいる最中に試合が動いてしまう）。
      if (syncSkillDraft(ctx)) {
        renderFrame();
        return;
      }
      // 打席が変わったらCPUのけん制・盗塁の「1打席1回」を仕切り直す（攻守どちらの
      // 経路でも打席は進むので、投球AIの分岐の外で毎フレーム見る）。
      syncPlateAppearance(ctx);

      // 打者の仕切り直し・攻守交代の「間」（フェーズE-23）。開いている間はCPU投手も
      // 投げない（人間側の入力は各ハンドラの interludeActive() ガードで止めている）。
      if (!updateInterlude(ctx, dt)) {
        // でっかいモードのCPU投球AI（セッション9）：CPUが投手側で、まだ投球動作に入って
        // いない（ready）間だけ毎フレーム呼ぶ。狙いを決めて「間」を消化し、経過したら自動で
        // ワインドアップを開始する（startPitchはreadyフェーズ以外では何もしない安全設計）。
        if (!isPitchingHuman() && !pitching.isBusy()) {
          // 銃（フェーズF-26-2）はけん制・投球より先に判断する。撃つと決まればその打席は
          // 死球で終わるので、以降の判断は要らない（構えた次のフレームからは上の
          // gunTelegraphActive の分岐が全体を静止させ、予兆明けにそのまま撃つ）。
          if (tryCpuGun(ctx)) {
            // 敬遠（フェーズQ-38）は銃の次・けん制より先に見る。歩かせると決まれば
            // その打席はそこで終わる（＝けん制も投球も要らない）。
          } else if (tryCpuIntentionalWalk(ctx)) {
            // けん制（説明書p24）は投球より先に判断する。走者がいる打席で1回だけ、短い「間」の
            // 後にちっちゃいモードへ切り替えて走者とにらみ合う（実際に投げるかは
            // chooseCpuPickoffThrow が、そのときのリードの深さで決める）。
            // **塁を離れている走者がいるときだけ**けん制する（フェーズJJ-57）。
            // 渡すのは盗塁のスタート位置とまったく同じ `resolveCarriedLeads` の結果＝
            // 「走ろうとしている走者」と「見に行く相手」が同じ1か所から出る。
          } else if (
            cpuPitcher.tryPickoff(
              dt,
              ctx.bases,
              cpuPickoffUsed,
              resolveCarriedLeads(ctx.baseRunners, carriedLeads),
            )
          ) {
            cpuPickoffUsed = true;
            startPickoff();
          } else if (cpuPitcher.updateReady(dt, ctx.count)) {
            pitching.startPitch();
          }
        }

        // CPU攻撃側の盗塁（説明書p13）＝人間が守備側。投球の残り時間が
        // CPU_STEAL_JUMP_SEC まで縮んだフレームで走り出す（＝完璧な送球なら刺せる
        // スタートの遅さ。人間の捕手がK+塁指定を出せば刺せる。core/fielding.ts参照）。
        if (
          !isBattingHuman() &&
          !cpuStealUsed &&
          !stealActive &&
          pitching.isPitchLive() &&
          pitching.timeToCatcher() <= CPU_STEAL_JUMP_SEC
        ) {
          // **ダブルスチールもする**（フェーズL-32。ユーザー判断：CPUも仕掛ける）。
          // 走者の指定は塁の配列でそのまま渡す＝十字キーを経由しないので、CPUの規則が
          // 人間のパッドの状態に左右されない。
          //
          // **走者の足と持ち越したリードを渡す**（フェーズR-39）＝俊足の球団だけが
          // よく走る。どちらも既にこの場にある値で、走力は打者と同じ `effectiveBatting`
          // （＝スキル・好調の補正を通った派生ビュー）、リードは盗塁のスタート位置に
          // 渡しているものと**同じ `resolveCarriedLeads` の結果**なので、
          // 「走ると決めた前提」と「実際に走る位置」が食い違わない。
          const from = chooseCpuSteals(ctx.bases, cpuStealOptions(ctx));
          if (from.length > 0) {
            cpuStealUsed = true;
            startSteal(from);
          }
        }
      }
    } else {
      // でっかいモードを離れたら「間」は持ち越さない（打球のプレー・死球・乱闘・銃モード
      // へ移る経路は間の最中には無いが、残ったまま凍りつくことのないよう明示的に畳む）。
      clearInterlude();
    }

    batting.update(dt);
    // 盗塁のヒントはフィールドプレーの更新より先に出す：プレーが始まった最初のフレームで
    // 「でっかいモード用のヒントを消す→フィールドプレーが自分のヒントを出す」の順にしないと、
    // 出したばかりのヒントを消してしまう（どちらも表示チャンネルは1つ）。
    syncStealPrompt();
    fieldPlay.update(dt);
    // 追従カメラ・画面外マーカーはフィールドプレーの更新の後（＝動いた後の位置）で決める
    syncChicchaiCamera(dt);

    const brawlActive = currentMode() === 'brawl' && !gameIsOver();
    brawl.update(dt, brawlActive);
    if (brawlActive) {
      hud.updateBrawl(brawl.view(), dt);
      // 技表も**毎フレーム組み直す**（体力・コンボと同じ扱い）。乱闘に入った瞬間に一度だけ
      // 渡す形だと、渡す順番（モード遷移・装備の確定・HUDの更新）のどれか1つでも前後した
      // ときに黙って既定の文言に戻る＝実機で実際に踏んだ。導出しておけば必ず今の装備と一致する。
      hud.setBrawlHint(brawlHintText());
    }

    // スキルの見た目（フェーズYY-73）。**乱闘の間は乱闘の効果だけ**（場の効果は消す）
    syncSkillLooks();
    syncRunnerSkillFx();
    syncFieldSkillFx();
    syncSkillSight();
    skillFx.update(rawDt);

    renderFrame();
  });
});
