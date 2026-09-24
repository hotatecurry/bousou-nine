/**
 * 乱闘の格闘エンジン（**v3＝ストIIのゲーム性**。フェーズXX-72）。
 * 位置・体力・技の判定・状態遷移・ラウンドの進行だけを持ち、シーン/入力には依存しない。
 *
 * テストプレイ「格闘ゲームがまだ簡易的すぎる（アーバンチャンピオン以下）。ちゃんとストIIの
 * ようなゲーム性を持たせたい」への答え。v2（G-27）は**位置という概念が無く**（2人は動かず、
 * 間合いも飛び込みも対空も無い）、三すくみ（ガード・投げ・打撃）だけで出来ていた。
 * v3で足したのは、ストIIのゲーム性を作っている部品そのもの：
 *
 * - **間合い**：歩き（前は速く後ろは遅い）・ダッシュ・画面端・押し合い。
 * - **立ち／しゃがみ／ジャンプ**：技が3つの姿勢で変わる。ジャンプ攻撃は**立ちでしか防げない**
 *   （中段）、足払いは**しゃがみでしか防げない**（下段）＝ガードの二択。
 * - **後ろ入れでガード**（2026-09-23 ユーザー判断＝K=パンチ・J=キック。ガード専用の
 *   ボタンは無い）。技を出している間・跳んでいる間はガードできない。
 * - **投げ**：近くで横＋パンチ。ガードを崩す手段（v2の三すくみはここに残る）。
 * - **必殺技**：コマンド入力（`brawlCommand.ts`）。**スキルが配る**（⑧）。飛び道具・無敵対空・
 *   突進・コマンド投げ・連打技。**必殺技はガードの上から削る**（削りダメージ）。
 * - **超必殺**：ゲージが満タンのとき G。ゲージは当てても食らっても溜まる。
 * - **コンボ**：通常技を当てた（ガードされた）ときだけ必殺技へキャンセルできる。
 *   のけぞりが技の硬直より長ければ次の通常技が繋がる（目押し）。
 * - **ヒットストップ・のけぞり・ガード硬直・押し戻し・ダウン・起き上がり・ピヨり**。
 * - **ラウンド制**：2本先取・1ラウンド60秒（ユーザー判断）。時間切れは体力の割合で判定。
 *
 * ## 時計は1フレーム＝1/60秒（固定）
 *
 * v2は秒の時計（可変の dt）だったが、格闘ゲームの判定は「何フレーム有利か」で書くほうが
 * 読める（技表の数字がそのまま手触りになる）ので、**固定の1/60秒で1フレームずつ進める**。
 * シーンは実時間を貯めて整数回 `stepBrawl` を呼ぶ＝**画面の重さで判定が変わらない**。
 *
 * ## 乱数は使わない（他の core/*.ts と同じ）
 *
 * 同じ入力なら同じ結果になる。CPUも同じ入力の経路（`FrameInput`）で技を出す
 * （`brawlAi.ts`）＝**CPUだけが出せる技は1つも無い**（⑧の「CPUも対等」）。
 *
 * ## 座標
 *
 * x は舞台の横（m。画面右が +）、y は足元の高さ（m）。向き（`facing`）は前が +1 なら +x。
 * 技の当たり判定は「向いている方向を正」とした相対の箱で書く（左右で表を分けない）。
 */
import {
  type FightFacing,
  type FrameInput,
  type InputHistory,
  type MotionId,
  type Numpad,
  NEUTRAL_INPUT,
  consumeInput,
  createInputHistory,
  detectMotion,
  isBackDir,
  isDownDir,
  isForwardDir,
  isUpDir,
  motionNotation,
  stepInput,
} from './brawlCommand';

export type BrawlSide = 'batter' | 'pitcher';
export const BRAWL_SIDES: readonly BrawlSide[] = ['batter', 'pitcher'];
export const OTHER_SIDE: Record<BrawlSide, BrawlSide> = { batter: 'pitcher', pitcher: 'batter' };

// ---- 時間と勝負形式 ----

export const FPS = 60;
/** 1ラウンドの秒数（ユーザー判断） */
export const ROUND_SECONDS = 60;
/** 先に取れば勝ちのラウンド数（2本先取。ユーザー判断） */
export const ROUNDS_TO_WIN = 2;
/**
 * 最大ラウンド数。引き分けのラウンドは誰にも数えないので、延々と続かないよう上限を置く。
 * 上限まで決まらなければ取ったラウンドの多いほう、それも同じなら**打者の勝ち**
 * （殴られた側＝乱闘を仕掛けた側。決定的な規則として書いておく）。
 */
export const MAX_ROUNDS = 5;
/** ラウンドの始まり（`第1ラウンド`→`ファイト！`）のフレーム */
export const INTRO_FRAMES = 110;
/** `ファイト！` が出るフレーム（ここから先はもう動ける） */
export const FIGHT_CALL_AT = 70;
/** KOしてから勝ち名乗りまで（倒れる・スローを見せる） */
export const KO_FRAMES = 150;
/** 時間切れの告知 */
export const TIME_UP_FRAMES = 100;
/** ラウンドの勝ち名乗り */
export const ROUND_END_FRAMES = 100;
/** 試合（乱闘）の決着の見せ時間 */
export const MATCH_END_FRAMES = 110;

// ---- 舞台と体 ----

/** 舞台の端（中心から ±m）。画面端＝押し戻しがここで止まる */
export const STAGE_HALF = 4.8;
/** 2人がこれ以上離れられない距離（カメラの画面に2人とも収まる幅） */
export const MAX_GAP = 6.0;
/** ラウンド開始時の間合い */
export const START_GAP = 2.8;
/** 押し合いの半幅（地上の2人はこの2倍より近づけない） */
export const PUSH_HALF = 0.3;
/** 前歩き・後ろ歩き（m/フレーム）。**後ろは遅い**＝下がり続けるだけでは逃げ切れない */
export const WALK_FORWARD = 0.03;
export const WALK_BACK = 0.023;
/** ジャンプ：踏み切り・滞空・頂点の高さ・横の速さ */
export const JUMP_SQUAT = 4;
export const JUMP_AIR_FRAMES = 40;
export const JUMP_HEIGHT = 1.3;
export const GRAVITY = (2 * JUMP_HEIGHT) / (JUMP_AIR_FRAMES / 2) ** 2;
export const JUMP_VY = GRAVITY * (JUMP_AIR_FRAMES / 2);
export const JUMP_VX = 0.052;
/** 着地の硬直（跳び込みの着地を狩られる隙） */
export const LAND_FRAMES = 3;
/** ダッシュ（スキル `喧嘩っ早い`） */
export const DASH_FRAMES = 16;
export const DASH_DISTANCE = 1.5;
export const BACKDASH_FRAMES = 14;
export const BACKDASH_DISTANCE = 1.15;

/** 喰らい判定（足元からの高さ）。しゃがむと頭が下がる＝高い技の下をくぐれる */
export const HURT_STAND = { half: 0.32, top: 1.78 };
export const HURT_CROUCH = { half: 0.36, top: 1.08 };
export const HURT_AIR = { half: 0.3, bottom: 0.25, top: 1.7 };

/** ダウン（倒れている）・起き上がり（どちらも無敵） */
export const KNOCKDOWN_FRAMES = 36;
export const WAKEUP_FRAMES = 16;
/** のけぞり・ガード・起き上がりの直後に投げられない猶予 */
export const THROW_INVULN_FRAMES = 8;
/** 押したボタンを覚えておくフレーム（硬直の最後に押しても出る＝繋がる） */
export const INPUT_BUFFER = 4;
/** 一回転を跳び上がった直後に取り消して出せる猶予（フレーム） */
export const SCREW_AIR_GRACE = 6;

export const BRAWL_MAX_HP = 120;
/** ピヨり（気絶）までの耐久。技ごとの `stun` が溜まり、しばらく食らわなければ減る */
export const STUN_MAX = 60;
export const STUN_DECAY_WAIT = 90;
export const STUN_DECAY_PER_FRAME = 0.25;
export const DIZZY_FRAMES = 140;
/** ピヨりの間、レバーやボタンを動かすたびに縮む（ストIIのレバガチャ） */
export const DIZZY_MASH_FRAMES = 4;
export const METER_MAX = 100;
/** 超必殺の暗転（全体が止まる） */
export const SUPER_FLASH_FRAMES = 32;
/** コンボ補正（何発目か→倍率。以降は最後の値） */
export const COMBO_SCALING: readonly number[] = [1, 1, 0.85, 0.75, 0.65, 0.55, 0.5];

// ---- 技 ----

export type NormalId = 'cP' | 'sP' | 'sK' | 'crP' | 'crK' | 'jP' | 'jK';
export type SpecialId =
  | 'hadou'
  | 'shoryu'
  | 'tatsu'
  | 'zutsuki'
  | 'hyakuretsu'
  | 'screw'
  | 'buki'
  | 'somersault'
  | 'divekick'
  | 'kobun';
export type SuperId = 'shinku' | 'batto';
export type MoveId = NormalId | SpecialId | SuperId | 'throw';

export type GuardType = 'mid' | 'high' | 'low';

/** 箱（向いている方向を正の x、足元からの y） */
export interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export type ProjectileKind = 'hadou' | 'shinku' | 'kobun';

export interface MoveDef {
  kind: 'normal' | 'special' | 'super' | 'throw';
  /** 出るまで（このフレームから当たり判定が出る） */
  startup: number;
  /** 当たり判定が出ている長さ */
  active: number;
  /** 戻り（地上技）／着地の硬直（空中へ出る技） */
  recovery: number;
  hitbox?: Box;
  damage: number;
  /** ガードされたときの削り（通常技は0） */
  chip: number;
  stun: number;
  hitstun: number;
  blockstun: number;
  pushHit: number;
  pushBlock: number;
  guard: GuardType;
  hitstop: number;
  knockdown: boolean;
  /** 空中で食らって落ちている相手にも当たる（昇龍・超必殺） */
  juggle?: boolean;
  /** 多段の数 */
  hits?: number;
  /** 多段の間隔（フレーム） */
  hitEvery?: number;
  /** 当てた（ガードされた）ときに必殺技・超必殺へ繋げられる */
  cancel?: boolean;
  /** 打撃が当たらないフレーム [from, to) */
  invuln?: readonly [number, number];
  /** 飛び道具を素通りするフレーム [from, to) */
  projInvuln?: readonly [number, number];
  /** 動き：経過フレーム→開始位置からの前方の距離と高さ（`air` の技は終わったら落ちる） */
  path?: (t: number) => { dx: number; y: number };
  /** 空中へ出る技（`path` が終わったら重力で落ち、着地で `recovery` の硬直） */
  air?: boolean;
  /** 空中で出す技（ジャンプ攻撃・急降下） */
  fromAir?: boolean;
  /** 飛び道具を出すフレームと種類 */
  projectile?: { at: number; kind: ProjectileKind };
  /** 掴み技の間合い（中心どうしの距離） */
  grabRange?: number;
  /** 当てた・ガードされたら跳ね返る（頭突き） */
  bounce?: boolean;
  /** コマンド（必殺技）。超必殺は G で出るので持たない */
  command?: MotionId;
  button?: 'p' | 'k';
}

/** 0..1 を滑らかに（出だしが速い） */
function easeOut(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - (1 - c) * (1 - c);
}

/**
 * 技の表（フレーム）。**数字がそのまま手触り**：発生が速い技は割り込める、戻りが長い技は
 * ガードされたら反撃される。いくつかの約束：
 *
 * - **通常技の足払い（しゃがみK）はガードされると不利**（戻り21 > ガード硬直13）＝
 *   振れば当たるが、読まれたら返される（桜井ノウハウ「リスクとリターンは近くに」）。
 * - **昇龍拳は出だし無敵・外すと大きな隙**。対空の答えであり、読まれたら着地に何でも入る。
 * - **波動拳は撃った後が長い**（34）＝近くで撃てば飛び込まれる。遠くから撃つ技。
 * - **竜巻旋風脚は高い**（しゃがんだ相手の頭の上を通る）＝しゃがみガードでくぐれる。
 */
export const MOVES: Record<MoveId, MoveDef> = {
  // ---- 通常技（誰でも持つ） ----
  cP: {
    kind: 'normal', startup: 4, active: 3, recovery: 7,
    hitbox: { x0: 0.18, x1: 0.78, y0: 1.0, y1: 1.62 },
    damage: 7, chip: 0, stun: 5, hitstun: 15, blockstun: 11, pushHit: 0.22, pushBlock: 0.32,
    guard: 'mid', hitstop: 7, knockdown: false, cancel: true,
  },
  sP: {
    kind: 'normal', startup: 5, active: 3, recovery: 10,
    hitbox: { x0: 0.22, x1: 1.02, y0: 1.2, y1: 1.66 },
    damage: 7, chip: 0, stun: 5, hitstun: 14, blockstun: 10, pushHit: 0.32, pushBlock: 0.42,
    guard: 'mid', hitstop: 7, knockdown: false, cancel: true,
  },
  sK: {
    kind: 'normal', startup: 9, active: 4, recovery: 17,
    hitbox: { x0: 0.3, x1: 1.42, y0: 0.9, y1: 1.62 },
    damage: 11, chip: 0, stun: 9, hitstun: 18, blockstun: 14, pushHit: 0.55, pushBlock: 0.6,
    guard: 'mid', hitstop: 9, knockdown: false,
  },
  crP: {
    kind: 'normal', startup: 4, active: 3, recovery: 7,
    hitbox: { x0: 0.18, x1: 0.88, y0: 0.55, y1: 1.05 },
    damage: 5, chip: 0, stun: 4, hitstun: 13, blockstun: 9, pushHit: 0.28, pushBlock: 0.34,
    guard: 'mid', hitstop: 6, knockdown: false, cancel: true,
  },
  crK: {
    kind: 'normal', startup: 7, active: 4, recovery: 21,
    hitbox: { x0: 0.28, x1: 1.36, y0: 0.0, y1: 0.36 },
    damage: 10, chip: 0, stun: 8, hitstun: 20, blockstun: 13, pushHit: 0.35, pushBlock: 0.5,
    guard: 'low', hitstop: 8, knockdown: true,
  },
  jP: {
    kind: 'normal', startup: 3, active: 10, recovery: 0, fromAir: true,
    hitbox: { x0: 0.08, x1: 0.78, y0: -0.1, y1: 0.95 },
    damage: 8, chip: 0, stun: 6, hitstun: 16, blockstun: 12, pushHit: 0.3, pushBlock: 0.35,
    guard: 'high', hitstop: 7, knockdown: false,
  },
  jK: {
    kind: 'normal', startup: 5, active: 12, recovery: 0, fromAir: true,
    // 後ろへも少し出ている＝相手の頭を越えながら当てる「めくり」ができる
    hitbox: { x0: -0.3, x1: 0.98, y0: -0.45, y1: 0.5 },
    damage: 11, chip: 0, stun: 8, hitstun: 18, blockstun: 14, pushHit: 0.35, pushBlock: 0.4,
    guard: 'high', hitstop: 8, knockdown: false,
  },
  throw: {
    kind: 'throw', startup: 0, active: 1, recovery: 36, grabRange: 0.85,
    damage: 14, chip: 0, stun: 8, hitstun: 0, blockstun: 0, pushHit: 0, pushBlock: 0,
    guard: 'mid', hitstop: 0, knockdown: true,
  },

  // ---- 必殺技（スキルが配る） ----
  /** 波動拳（↓↘→＋P）。気の飛び道具。撃った後が長い＝遠くから撃つ技 */
  hadou: {
    kind: 'special', startup: 12, active: 1, recovery: 34, command: 'qcf', button: 'p',
    projectile: { at: 12, kind: 'hadou' },
    damage: 0, chip: 0, stun: 0, hitstun: 0, blockstun: 0, pushHit: 0, pushBlock: 0,
    guard: 'mid', hitstop: 0, knockdown: false,
  },
  /** 昇龍拳（→↓↘＋P）。出だし無敵の対空。外せば落ちてくるまで無防備 */
  shoryu: {
    kind: 'special', startup: 3, active: 14, recovery: 12, command: 'dp', button: 'p',
    hitbox: { x0: 0.05, x1: 0.75, y0: 0.8, y1: 2.2 },
    damage: 16, chip: 3, stun: 12, hitstun: 30, blockstun: 16, pushHit: 0.2, pushBlock: 0.3,
    guard: 'mid', hitstop: 12, knockdown: true, juggle: true,
    invuln: [0, 10], air: true,
    path: (t) =>
      t < 3 ? { dx: 0, y: 0 } : { dx: 0.6 * easeOut((t - 3) / 18), y: 1.65 * easeOut((t - 3) / 18) },
  },
  /** 竜巻旋風脚（↓↙←＋K）。回りながら前へ。高いのでしゃがんだ相手には当たらない */
  tatsu: {
    kind: 'special', startup: 8, active: 36, recovery: 12, command: 'qcb', button: 'k',
    hitbox: { x0: -0.2, x1: 0.95, y0: 0.78, y1: 1.42 },
    damage: 5, chip: 1, stun: 4, hitstun: 18, blockstun: 12, pushHit: 0.18, pushBlock: 0.22,
    guard: 'mid', hitstop: 6, knockdown: true, hits: 3, hitEvery: 12,
    projInvuln: [8, 44], air: true,
    path: (t) =>
      t < 8
        ? { dx: 0, y: 0.35 * (t / 8) }
        : { dx: Math.min(2.4, (2.4 * (t - 8)) / 36), y: 0.35 },
  },
  /** 頭突き（←溜め→＋P）。飛び道具をくぐって一直線に突っ込む。当たっても防がれても跳ね返る */
  zutsuki: {
    kind: 'special', startup: 6, active: 24, recovery: 22, command: 'chargeBF', button: 'p',
    hitbox: { x0: 0.25, x1: 0.95, y0: 0.35, y1: 1.1 },
    damage: 14, chip: 3, stun: 10, hitstun: 24, blockstun: 16, pushHit: 0.3, pushBlock: 0.3,
    guard: 'mid', hitstop: 11, knockdown: true, bounce: true,
    projInvuln: [6, 30], air: true,
    path: (t) =>
      t < 6 ? { dx: 0, y: 0.3 * (t / 6) } : { dx: Math.min(3.0, (3.0 * (t - 6)) / 24), y: 0.45 },
  },
  /** 百裂張り手（P連打）。目の前を張り手で埋める。削りも入る */
  hyakuretsu: {
    kind: 'special', startup: 4, active: 30, recovery: 10, command: 'mash', button: 'p',
    hitbox: { x0: 0.2, x1: 1.02, y0: 0.8, y1: 1.62 },
    damage: 4, chip: 1, stun: 3, hitstun: 12, blockstun: 9, pushHit: 0.08, pushBlock: 0.1,
    guard: 'mid', hitstop: 4, knockdown: false, hits: 5, hitEvery: 6,
  },
  /** スクリュー（一回転＋P）。投げより広い間合いで掴んで叩きつける。外せば大きな隙 */
  screw: {
    kind: 'special', startup: 2, active: 1, recovery: 28, command: 'spin', button: 'p',
    grabRange: 1.15,
    damage: 28, chip: 0, stun: 20, hitstun: 0, blockstun: 0, pushHit: 0, pushBlock: 0,
    guard: 'mid', hitstop: 0, knockdown: true,
  },
  /** 武器振り回し（←溜め→＋K）。持ち込んだバットで大きく振る。とても長いが遅い */
  buki: {
    kind: 'special', startup: 16, active: 5, recovery: 30, command: 'chargeBF', button: 'k',
    hitbox: { x0: 0.3, x1: 1.8, y0: 0.55, y1: 1.95 },
    damage: 18, chip: 4, stun: 12, hitstun: 26, blockstun: 18, pushHit: 0.6, pushBlock: 0.7,
    guard: 'mid', hitstop: 13, knockdown: true,
  },
  /** サマーソルト（↓溜め↑＋K）。宙返りの対空。出だし無敵 */
  somersault: {
    kind: 'special', startup: 3, active: 12, recovery: 12, command: 'chargeDU', button: 'k',
    hitbox: { x0: -0.1, x1: 0.8, y0: 0.3, y1: 2.0 },
    damage: 15, chip: 3, stun: 10, hitstun: 28, blockstun: 16, pushHit: 0.3, pushBlock: 0.35,
    guard: 'mid', hitstop: 11, knockdown: true, juggle: true,
    invuln: [0, 9], air: true,
    path: (t) =>
      t < 3 ? { dx: 0, y: 0 } : { dx: -0.3 * easeOut((t - 3) / 14), y: 1.45 * easeOut((t - 3) / 14) },
  },
  /** 急降下キック（ジャンプ中に↓＋K）。斜め下へ突き刺さる中段。当たれば跳ね返る */
  divekick: {
    kind: 'special', startup: 3, active: 60, recovery: 10, fromAir: true, button: 'k',
    hitbox: { x0: 0.08, x1: 0.75, y0: -0.35, y1: 0.45 },
    damage: 10, chip: 2, stun: 7, hitstun: 18, blockstun: 13, pushHit: 0.3, pushBlock: 0.35,
    guard: 'high', hitstop: 8, knockdown: false, bounce: true,
  },
  /** 子分を呼ぶ（↓↙←＋P）。1ラウンドに1回、子分が後ろから駆け込んで殴りかかる */
  kobun: {
    kind: 'special', startup: 8, active: 1, recovery: 18, command: 'qcb', button: 'p',
    projectile: { at: 8, kind: 'kobun' },
    damage: 0, chip: 0, stun: 0, hitstun: 0, blockstun: 0, pushHit: 0, pushBlock: 0,
    guard: 'mid', hitstop: 0, knockdown: false,
  },

  // ---- 超必殺（ゲージ満タンで G） ----
  /** 真空波動拳。大きな気弾が5回当たる */
  shinku: {
    kind: 'super', startup: 10, active: 1, recovery: 36,
    projectile: { at: 10, kind: 'shinku' },
    damage: 0, chip: 0, stun: 0, hitstun: 0, blockstun: 0, pushHit: 0, pushBlock: 0,
    guard: 'mid', hitstop: 0, knockdown: false, invuln: [0, 10],
  },
  /** バット龍拳。燃えるバットで昇る4段の昇龍（`バット龍拳` のデュオ） */
  batto: {
    kind: 'super', startup: 5, active: 24, recovery: 14,
    hitbox: { x0: 0.0, x1: 1.1, y0: 0.6, y1: 2.6 },
    damage: 10, chip: 3, stun: 8, hitstun: 30, blockstun: 12, pushHit: 0.1, pushBlock: 0.2,
    guard: 'mid', hitstop: 8, knockdown: true, juggle: true, hits: 4, hitEvery: 6,
    invuln: [0, 14], air: true,
    path: (t) =>
      t < 5 ? { dx: 0, y: 0 } : { dx: 0.8 * easeOut((t - 5) / 22), y: 2.0 * easeOut((t - 5) / 22) },
  },
};

/** 技の表示名（HUDの技表） */
export const MOVE_NAME: Record<MoveId, string> = {
  cP: '肘打ち',
  sP: '突き',
  sK: '回し蹴り',
  crP: 'しゃがみ突き',
  crK: '足払い',
  jP: '跳び突き',
  jK: '跳び蹴り',
  throw: '投げ',
  hadou: '波動拳',
  shoryu: '昇龍拳',
  tatsu: '竜巻旋風脚',
  zutsuki: '頭突き',
  hyakuretsu: '百裂張り手',
  screw: 'スクリュー',
  buki: '武器振り回し',
  somersault: 'サマーソルト',
  divekick: '急降下キック',
  kobun: '子分を呼ぶ',
  shinku: '真空波動拳',
  batto: 'バット龍拳',
};

/** 飛び道具の形 */
export interface ProjectileDef {
  /** m/フレーム */
  speed: number;
  /** 出る位置（撃った人から前へ・足元から上へ） */
  spawnX: number;
  spawnY: number;
  /** 当たりの半径（横・縦） */
  rx: number;
  ry: number;
  damage: number;
  chip: number;
  stun: number;
  hitstun: number;
  blockstun: number;
  push: number;
  hits: number;
  /** 多段の間隔（フレーム） */
  hitEvery: number;
  guard: GuardType;
  /** 最後の1発でダウンさせる */
  knockdown: boolean;
  hitstop: number;
  /** 何フレームで消えるか（画面の外へ出ても消える） */
  lifetime: number;
  /** 飛び道具どうしで打ち消し合うか（子分は人なので消えない） */
  clashes: boolean;
}

export const PROJECTILES: Record<ProjectileKind, ProjectileDef> = {
  hadou: {
    speed: 0.075, spawnX: 0.8, spawnY: 1.25, rx: 0.26, ry: 0.22,
    damage: 11, chip: 3, stun: 8, hitstun: 20, blockstun: 16, push: 0.5,
    hits: 1, hitEvery: 0, guard: 'mid', knockdown: false, hitstop: 10, lifetime: 200, clashes: true,
  },
  shinku: {
    speed: 0.09, spawnX: 0.9, spawnY: 1.2, rx: 0.45, ry: 0.42,
    damage: 7, chip: 2, stun: 4, hitstun: 22, blockstun: 18, push: 0.2,
    hits: 5, hitEvery: 5, guard: 'mid', knockdown: true, hitstop: 6, lifetime: 200, clashes: true,
  },
  kobun: {
    speed: 0.1, spawnX: -1.2, spawnY: 0.75, rx: 0.3, ry: 0.6,
    damage: 10, chip: 2, stun: 8, hitstun: 20, blockstun: 14, push: 0.5,
    hits: 1, hitEvery: 0, guard: 'mid', knockdown: false, hitstop: 8, lifetime: 150, clashes: false,
  },
};

// ---- 装備（スキルから翻訳される） ----

/**
 * 乱闘の「装備」（フェーズF-26-1／v3で広げた）。ローグライトのスキルは `skills.ts` の
 * `brawlLoadoutFor` がここへ翻訳してから渡す＝**このファイルはスキルの存在を知らない**。
 *
 * 既定（`DEFAULT_LOADOUT`）は素の選手：体力120・威力等倍・**必殺技も超必殺も無い**
 * （通常技7つと投げだけ。これでストIIの基本＝間合い・ガードの二択・対空・投げは成立する）。
 */
export interface BrawlPassives {
  /** 前ダッシュ・バックステップ（→→／←←） */
  dash: boolean;
  /** 1ラウンドに耐えられる攻撃の数（技を出している間に食らっても怯まない。スーパーアーマー） */
  armor: number;
  /** 体力が3割を切ったときの威力の倍率（1=無し） */
  rage: number;
  /** 通常技もガードの上から削る（鉄の拳） */
  ironFist: boolean;
  /** 相手の威力の倍率（威嚇。1=無し） */
  intimidate: number;
  /** 歩きの速さの倍率 */
  walk: number;
  /** ジャンプの高さの倍率 */
  jump: number;
  /** ピヨりにくさ（耐久に足す） */
  stunGuard: number;
}

export const NO_PASSIVES: BrawlPassives = {
  dash: false,
  armor: 0,
  rage: 1,
  ironFist: false,
  intimidate: 1,
  walk: 1,
  jump: 1,
  stunGuard: 0,
};

export interface FighterLoadout {
  maxHp: number;
  /** 技の威力倍率 */
  powerScale: number;
  /** 出せる必殺技（コマンドで出る） */
  specials: readonly SpecialId[];
  /** 超必殺（ゲージ満タンで G）。null=持っていない */
  super: SuperId | null;
  passives: BrawlPassives;
}

export const DEFAULT_LOADOUT: FighterLoadout = {
  maxHp: BRAWL_MAX_HP,
  powerScale: 1,
  specials: [],
  super: null,
  passives: NO_PASSIVES,
};

export type BrawlLoadouts = Record<BrawlSide, FighterLoadout>;

export const DEFAULT_LOADOUTS: BrawlLoadouts = {
  batter: DEFAULT_LOADOUT,
  pitcher: DEFAULT_LOADOUT,
};

// ---- 状態 ----

export type Action =
  | { k: 'idle' }
  | { k: 'crouch' }
  | { k: 'walk'; dir: 1 | -1 }
  /** 後ろを入れて構えている（相手が技を出しているので歩かずにガードの形） */
  | { k: 'guard'; low: boolean }
  | { k: 'dash'; t: number; dir: 1 | -1 }
  | { k: 'jumpSquat'; t: number; dir: -1 | 0 | 1 }
  /** 跳んでいる。`attacked`＝この跳躍で空中攻撃を出したか（1回だけ） */
  | { k: 'air'; t: number; dir: -1 | 0 | 1; attacked: boolean }
  | { k: 'land'; t: number; dur: number }
  | {
      k: 'attack';
      move: MoveId;
      t: number;
      /** 当てた（ガードされた）か＝キャンセルの条件 */
      connected: boolean;
      /** 多段のうち当たった数 */
      hitCount: number;
      /** 最後に当たったフレーム（多段の間隔） */
      lastHitT: number;
      /** 技を出した位置（`path` の基準） */
      x0: number;
      y0: number;
      /** `path` が終わって落ちている／跳ね返っている */
      falling: boolean;
      /** 着地した後の硬直の残り（空中へ出る技） */
      landing: number;
      /** 百裂を連打で伸ばした分 */
      extend: number;
    }
  | { k: 'hitstun'; t: number; dur: number; low: boolean }
  | { k: 'blockstun'; t: number; dur: number; low: boolean }
  /** 空中で食らって落ちている（`knockdown` なら着地でダウン、そうでなければ着地して立つ） */
  | { k: 'airHit'; t: number; knockdown: boolean }
  | { k: 'knockdown'; t: number }
  | { k: 'wakeup'; t: number }
  | { k: 'throwing'; t: number; move: 'throw' | 'screw'; back: boolean }
  | { k: 'thrown'; t: number; move: 'throw' | 'screw' }
  | { k: 'dizzy'; t: number; dur: number }
  | { k: 'ko'; t: number }
  | { k: 'win'; t: number }
  | { k: 'lose'; t: number };

export interface Fighter {
  side: BrawlSide;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: FightFacing;
  hp: number;
  maxHp: number;
  stun: number;
  /** 最後に食らってからのフレーム（ピヨりの耐久が戻り始めるまで） */
  sinceHit: number;
  meter: number;
  act: Action;
  input: InputHistory;
  /** いま押しているパッドの状態（ガードの判定に使う） */
  pad: FrameInput;
  /** 押したボタンを覚えている残りフレーム */
  bufP: number;
  bufK: number;
  /**
   * **押した瞬間に成立していた必殺技**（残りフレーム付き）。コマンドはボタンを押した
   * 瞬間に読む（ストIIと同じ）＝ヒットストップの間に押して、止まっている間にレバーが
   * 戻っても技は出る（キャンセルの受付）。
   */
  bufSpecial: SpecialId | null;
  bufSpecialLeft: number;
  /** 超必殺（G）を押したのを覚えている残りフレーム */
  bufSuper: number;
  /** 食らっている連続技の何発目か（補正とコンボ表示） */
  comboTaken: number;
  /** 無敵の残り（起き上がり等。打撃も投げも当たらない） */
  invuln: number;
  throwInvuln: number;
  /** 押し戻しの残り（ワールドの x。符号付き） */
  slide: number;
  /** このラウンドで耐えられるスーパーアーマーの残り */
  armorLeft: number;
  /** このラウンドで子分を呼んだか */
  kobunUsed: boolean;
  /** ピヨりが確定している（のけぞりが明けたらピヨる） */
  dizzyPending: boolean;
  /** 最後に食らった技（見た目の出し分け） */
  hurtBy: MoveId | ProjectileKind | null;
  roundWins: number;
}

export interface Projectile {
  id: number;
  owner: BrawlSide;
  kind: ProjectileKind;
  x: number;
  y: number;
  dir: FightFacing;
  t: number;
  hitsLeft: number;
  /** 次に当たれるまで（多段の間隔） */
  cooldown: number;
  alive: boolean;
}

export type BrawlPhase = 'intro' | 'fight' | 'ko' | 'timeUp' | 'roundEnd' | 'matchEnd' | 'done';

export interface PracticeOptions {
  /** 体力が減らない（0になる前に満タンへ戻す） */
  refillHp: boolean;
  /** ゲージが常に満タン */
  fullMeter: boolean;
}

export interface BrawlState {
  frame: number;
  phase: BrawlPhase;
  phaseT: number;
  round: number;
  /** 残り時間（フレーム） */
  timer: number;
  /** ヒットストップ・超必殺の暗転（全体が止まる残りフレーム） */
  freeze: number;
  batter: Fighter;
  pitcher: Fighter;
  projectiles: Projectile[];
  nextProjectileId: number;
  loadouts: BrawlLoadouts;
  /** ラウンドごとの結果 */
  results: Array<BrawlSide | 'draw'>;
  /** 乱闘の勝者（決着したら） */
  winner: BrawlSide | null;
  /** 練習（デバッグの乱闘）。null=本番 */
  practice: PracticeOptions | null;
}

export type BrawlEvent =
  | {
      k: 'hit';
      attacker: BrawlSide;
      defender: BrawlSide;
      move: MoveId | ProjectileKind;
      damage: number;
      blocked: boolean;
      x: number;
      y: number;
      /** 重い当たり（ダウン・必殺技・超必殺）＝大きな火花と音 */
      heavy: boolean;
      combo: number;
      armored: boolean;
    }
  | { k: 'whiff'; side: BrawlSide; move: MoveId }
  | { k: 'swing'; side: BrawlSide; move: MoveId }
  | { k: 'special'; side: BrawlSide; move: MoveId }
  | { k: 'super'; side: BrawlSide; move: SuperId }
  | { k: 'projectile'; side: BrawlSide; kind: ProjectileKind }
  | { k: 'clash'; x: number; y: number }
  | { k: 'throw'; side: BrawlSide; move: 'throw' | 'screw' }
  | { k: 'throwTech'; x: number }
  | { k: 'slam'; side: BrawlSide; x: number }
  | { k: 'jump'; side: BrawlSide }
  | { k: 'land'; side: BrawlSide }
  | { k: 'dash'; side: BrawlSide }
  | { k: 'knockdown'; side: BrawlSide; x: number }
  | { k: 'dizzy'; side: BrawlSide }
  | { k: 'meterFull'; side: BrawlSide }
  | { k: 'round'; round: number }
  | { k: 'fight' }
  | { k: 'ko'; loser: BrawlSide | 'both' }
  | { k: 'timeUp' }
  | { k: 'roundWin'; winner: BrawlSide | 'draw' }
  | { k: 'matchEnd'; winner: BrawlSide; loser: BrawlSide };

// ---- 作る ----

function createFighter(side: BrawlSide, loadout: FighterLoadout): Fighter {
  const facing: FightFacing = side === 'batter' ? 1 : -1;
  return {
    side,
    x: side === 'batter' ? -START_GAP / 2 : START_GAP / 2,
    y: 0,
    vx: 0,
    vy: 0,
    facing,
    hp: loadout.maxHp,
    maxHp: loadout.maxHp,
    stun: 0,
    sinceHit: 0,
    meter: 0,
    act: { k: 'idle' },
    input: createInputHistory(),
    pad: NEUTRAL_INPUT,
    bufP: 0,
    bufK: 0,
    bufSpecial: null,
    bufSpecialLeft: 0,
    bufSuper: 0,
    comboTaken: 0,
    invuln: 0,
    throwInvuln: 0,
    slide: 0,
    armorLeft: loadout.passives.armor,
    kobunUsed: false,
    dizzyPending: false,
    hurtBy: null,
    roundWins: 0,
  };
}

export function createBrawlState(
  loadouts: BrawlLoadouts = DEFAULT_LOADOUTS,
  practice: PracticeOptions | null = null,
): BrawlState {
  return {
    frame: 0,
    phase: practice ? 'fight' : 'intro',
    phaseT: 0,
    round: 1,
    timer: ROUND_SECONDS * FPS,
    freeze: 0,
    batter: createFighter('batter', loadouts.batter),
    pitcher: createFighter('pitcher', loadouts.pitcher),
    projectiles: [],
    nextProjectileId: 1,
    loadouts,
    results: [],
    winner: null,
    practice,
  };
}

/** ラウンドの頭に戻す（体力・位置・状態。ゲージとラウンド数は持ち越す＝ストIIと同じ） */
function resetForRound(s: BrawlState): void {
  for (const side of BRAWL_SIDES) {
    const f = s[side];
    const fresh = createFighter(side, s.loadouts[side]);
    s[side] = { ...fresh, meter: f.meter, roundWins: f.roundWins };
  }
  s.projectiles = [];
  s.timer = ROUND_SECONDS * FPS;
  s.freeze = 0;
}

// ---- 問い合わせ ----

export function moveOf(f: Fighter): MoveDef | null {
  return f.act.k === 'attack' ? MOVES[f.act.move] : null;
}

export function isAirborne(f: Fighter): boolean {
  return (
    f.act.k === 'air' ||
    f.act.k === 'airHit' ||
    (f.act.k === 'attack' && (f.y > 0.001 || MOVES[f.act.move].fromAir === true)) ||
    (f.act.k === 'ko' && f.y > 0.001)
  );
}

function isCrouching(f: Fighter): boolean {
  if (f.act.k === 'crouch') return true;
  if (f.act.k === 'guard' || f.act.k === 'blockstun' || f.act.k === 'hitstun') return f.act.low;
  if (f.act.k === 'attack') return f.act.move === 'crP' || f.act.move === 'crK';
  return false;
}

/** 自分から動ける（歩く・しゃがむ・技を出す・跳ぶ）状態か */
function canAct(f: Fighter): boolean {
  return (
    f.act.k === 'idle' || f.act.k === 'crouch' || f.act.k === 'walk' || f.act.k === 'guard'
  );
}

/** ガードできる状態か（地上で、技を出していない） */
function canBlock(f: Fighter): boolean {
  return canAct(f) || f.act.k === 'blockstun' || f.act.k === 'land';
}

/** 投げられる状態か */
function throwable(f: Fighter): boolean {
  if (f.invuln > 0 || f.throwInvuln > 0 || f.y > 0.001) return false;
  const k = f.act.k;
  return k === 'idle' || k === 'crouch' || k === 'walk' || k === 'guard' || k === 'attack' || k === 'land' || k === 'dash';
}

/** 攻撃中の技の経過から「当たり判定が出ているか」 */
function isActiveFrame(def: MoveDef, t: number, extend = 0): boolean {
  return t >= def.startup && t < def.startup + def.active + extend;
}

/** その選手の喰らい判定（ワールド座標。無敵なら null） */
export function hurtboxOf(f: Fighter, byProjectile = false, juggle = false): Box | null {
  if (f.invuln > 0) return null;
  const k = f.act.k;
  if (k === 'knockdown' || k === 'wakeup' || k === 'thrown' || k === 'ko' || k === 'win' || k === 'lose') {
    return null;
  }
  if (k === 'airHit' && !juggle) return null;
  if (k === 'throwing') return null;
  if (f.act.k === 'attack') {
    const def = MOVES[f.act.move];
    const t = f.act.t;
    if (def.invuln && t >= def.invuln[0] && t < def.invuln[1]) return null;
    if (byProjectile && def.projInvuln && t >= def.projInvuln[0] && t < def.projInvuln[1]) return null;
  }
  if (isAirborne(f)) {
    return {
      x0: f.x - HURT_AIR.half,
      x1: f.x + HURT_AIR.half,
      y0: f.y + HURT_AIR.bottom,
      y1: f.y + HURT_AIR.top,
    };
  }
  const box = isCrouching(f) ? HURT_CROUCH : HURT_STAND;
  return { x0: f.x - box.half, x1: f.x + box.half, y0: f.y, y1: f.y + box.top };
}

/** 技の当たり判定（ワールド座標。出ていなければ null） */
export function hitboxOf(f: Fighter): Box | null {
  if (f.act.k !== 'attack') return null;
  const def = MOVES[f.act.move];
  if (!def.hitbox) return null;
  if (!isActiveFrame(def, f.act.t, f.act.extend)) return null;
  if (f.act.falling && def.bounce) return null;
  const b = def.hitbox;
  const x0 = f.facing === 1 ? f.x + b.x0 : f.x - b.x1;
  const x1 = f.facing === 1 ? f.x + b.x1 : f.x - b.x0;
  return { x0, x1, y0: f.y + b.y0, y1: f.y + b.y1 };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/** その装備で出せる必殺技と超必殺（HUDの技表） */
export interface MoveListEntry {
  move: MoveId;
  name: string;
  notation: string;
}

export function moveList(loadout: FighterLoadout, facing: FightFacing): MoveListEntry[] {
  const out: MoveListEntry[] = [];
  for (const id of loadout.specials) {
    const def = MOVES[id];
    const button = def.button === 'k' ? 'K' : 'P';
    const notation =
      id === 'divekick'
        ? `跳んで${motionArrow(2, facing)}+K`
        : def.command
          ? `${motionNotation(def.command, facing)}+${button}`
          : '';
    out.push({ move: id, name: MOVE_NAME[id], notation });
  }
  if (loadout.super) out.push({ move: loadout.super, name: MOVE_NAME[loadout.super], notation: 'ゲージ満タンでG' });
  return out;
}

function motionArrow(d: Numpad, facing: FightFacing): string {
  const table: Record<number, string> = { 2: '↓', 8: '↑', 4: facing === 1 ? '←' : '→', 6: facing === 1 ? '→' : '←' };
  return table[d] ?? '';
}

// ---- 1フレーム進める ----

interface StepCtx {
  s: BrawlState;
  events: BrawlEvent[];
  pressed: Record<BrawlSide, { p: boolean; k: boolean; s: boolean }>;
  /** このフレームで投げを試みた側（同時に投げ合ったら抜ける） */
  throws: Set<BrawlSide>;
}

function cloneFighter(f: Fighter): Fighter {
  return { ...f, act: { ...f.act } as Action, pad: { ...f.pad } };
}

function cloneState(s: BrawlState): BrawlState {
  return {
    ...s,
    batter: cloneFighter(s.batter),
    pitcher: cloneFighter(s.pitcher),
    projectiles: s.projectiles.map((p) => ({ ...p })),
    results: [...s.results],
  };
}

/**
 * 1フレーム進める（純粋関数。入力の state は変更しない）。
 * `inputs` はその側のパッドの状態（CPUも同じ形で渡す＝同じ経路で技を出す）。
 */
export function stepBrawl(
  state: BrawlState,
  inputs: Record<BrawlSide, FrameInput>,
): { state: BrawlState; events: BrawlEvent[] } {
  const s = cloneState(state);
  const ctx: StepCtx = {
    s,
    events: [],
    pressed: { batter: { p: false, k: false, s: false }, pitcher: { p: false, k: false, s: false } },
    throws: new Set(),
  };
  s.frame += 1;
  if (s.phase === 'done') return { state: s, events: [] };

  // 入力は止まっている間も記録する（溜め・コマンドはヒットストップ中も途切れない）
  for (const side of BRAWL_SIDES) {
    const f = s[side];
    const { history, pressed } = stepInput(f.input, inputs[side], f.facing);
    f.input = history;
    f.pad = inputs[side];
    ctx.pressed[side] = pressed;
    if (pressed.p) f.bufP = INPUT_BUFFER;
    if (pressed.k) f.bufK = INPUT_BUFFER;
    if (pressed.s) f.bufSuper = INPUT_BUFFER;
    // 必殺技のコマンドは押した瞬間に読む
    if (pressed.p || pressed.k) {
      const special = specialAtPress(s.loadouts[side], f, pressed);
      if (special) {
        f.bufSpecial = special;
        f.bufSpecialLeft = INPUT_BUFFER + 2;
        f.input = consumeInput(f.input);
        if (MOVES[special].button === 'p') f.bufP = 0;
        else f.bufK = 0;
      }
    }
    // ピヨりはレバガチャで縮む
    if (f.act.k === 'dizzy' && (pressed.p || pressed.k || f.input.dirs.at(-1)?.at === s.frame)) {
      f.act.dur = Math.max(f.act.t + 1, f.act.dur - DIZZY_MASH_FRAMES);
    }
  }

  if (s.freeze > 0) {
    s.freeze -= 1;
    return { state: s, events: ctx.events };
  }

  advancePhase(ctx);
  // （TSの絞り込みは advancePhase の中の書き換えを追えないので、読み直してから比べる）
  if ((s.phase as BrawlPhase) === 'done') return { state: s, events: ctx.events };

  const fighting = s.phase === 'fight';
  for (const side of BRAWL_SIDES) {
    const f = s[side];
    if (f.bufP > 0) f.bufP -= 1;
    if (f.bufK > 0) f.bufK -= 1;
    if (f.bufSuper > 0) f.bufSuper -= 1;
    if (f.bufSpecialLeft > 0) {
      f.bufSpecialLeft -= 1;
      if (f.bufSpecialLeft === 0) f.bufSpecial = null;
    }
  }

  // 1) 意思（動ける側だけ）
  if (fighting) {
    for (const side of BRAWL_SIDES) decide(ctx, side);
    resolveThrowStarts(ctx);
  }

  // 2) 動き
  for (const side of BRAWL_SIDES) advanceFighter(ctx, side);
  resolvePush(s);
  if (fighting || s.phase === 'ko') updateFacing(s);

  // 3) 飛び道具
  advanceProjectiles(ctx);

  // 4) 当たり
  if (fighting) {
    resolveHits(ctx);
    checkRoundEnd(ctx);
  }

  // 練習：体力とゲージ
  if (s.practice) {
    for (const side of BRAWL_SIDES) {
      const f = s[side];
      if (s.practice.fullMeter) f.meter = METER_MAX;
      if (s.practice.refillHp && f.hp <= f.maxHp * 0.25 && f.comboTaken === 0 && canAct(f)) {
        f.hp = f.maxHp;
      }
    }
  }
  return { state: s, events: ctx.events };
}

// ---- ラウンドの進行 ----

function advancePhase(ctx: StepCtx): void {
  const s = ctx.s;
  s.phaseT += 1;
  switch (s.phase) {
    case 'intro':
      if (s.phaseT === 1) ctx.events.push({ k: 'round', round: s.round });
      if (s.phaseT === FIGHT_CALL_AT) ctx.events.push({ k: 'fight' });
      if (s.phaseT >= INTRO_FRAMES) {
        s.phase = 'fight';
        s.phaseT = 0;
      }
      break;
    case 'fight':
      if (s.practice) break;
      s.timer = Math.max(0, s.timer - 1);
      if (s.timer === 0) {
        s.phase = 'timeUp';
        s.phaseT = 0;
        ctx.events.push({ k: 'timeUp' });
      }
      break;
    case 'ko':
      if (s.phaseT >= KO_FRAMES) finishRound(ctx, koWinner(s));
      break;
    case 'timeUp':
      if (s.phaseT >= TIME_UP_FRAMES) finishRound(ctx, timeUpWinner(s));
      break;
    case 'roundEnd':
      if (s.phaseT >= ROUND_END_FRAMES) {
        const decided = matchWinner(s);
        if (decided) {
          s.phase = 'matchEnd';
          s.phaseT = 0;
          s.winner = decided;
          ctx.events.push({ k: 'matchEnd', winner: decided, loser: OTHER_SIDE[decided] });
        } else {
          s.round += 1;
          resetForRound(s);
          s.phase = 'intro';
          s.phaseT = 0;
        }
      }
      break;
    case 'matchEnd':
      if (s.phaseT >= MATCH_END_FRAMES) s.phase = 'done';
      break;
    case 'done':
      break;
  }
}

function koWinner(s: BrawlState): BrawlSide | 'draw' {
  const bDown = s.batter.hp <= 0;
  const pDown = s.pitcher.hp <= 0;
  if (bDown && pDown) return 'draw';
  return bDown ? 'pitcher' : 'batter';
}

/** 時間切れは**体力の割合**で判定（スキルで最大値が違っても公平に比べる） */
function timeUpWinner(s: BrawlState): BrawlSide | 'draw' {
  const b = s.batter.hp / s.batter.maxHp;
  const p = s.pitcher.hp / s.pitcher.maxHp;
  if (Math.abs(b - p) < 1e-9) return 'draw';
  return b > p ? 'batter' : 'pitcher';
}

function finishRound(ctx: StepCtx, winner: BrawlSide | 'draw'): void {
  const s = ctx.s;
  s.results.push(winner);
  if (winner !== 'draw') {
    s[winner].roundWins += 1;
    s[winner].act = { k: 'win', t: 0 };
    const loser = s[OTHER_SIDE[winner]];
    if (loser.act.k !== 'ko') loser.act = { k: 'lose', t: 0 };
  }
  s.phase = 'roundEnd';
  s.phaseT = 0;
  ctx.events.push({ k: 'roundWin', winner });
}

/** 乱闘の勝者が決まったか（2本先取・上限ラウンド） */
function matchWinner(s: BrawlState): BrawlSide | null {
  for (const side of BRAWL_SIDES) if (s[side].roundWins >= ROUNDS_TO_WIN) return side;
  if (s.round >= MAX_ROUNDS) {
    if (s.batter.roundWins !== s.pitcher.roundWins) {
      return s.batter.roundWins > s.pitcher.roundWins ? 'batter' : 'pitcher';
    }
    return 'batter';
  }
  return null;
}

function checkRoundEnd(ctx: StepCtx): void {
  const s = ctx.s;
  if (s.practice) return;
  const bDown = s.batter.hp <= 0;
  const pDown = s.pitcher.hp <= 0;
  if (!bDown && !pDown) return;
  s.phase = 'ko';
  s.phaseT = 0;
  s.projectiles = [];
  ctx.events.push({ k: 'ko', loser: bDown && pDown ? 'both' : bDown ? 'batter' : 'pitcher' });
}

// ---- 意思（入力→行動） ----

function numpad(f: Fighter): Numpad {
  return f.input.dir;
}

/** 相手から離れる向きを入れているか（ガードの条件。向きではなく相手の位置で見る＝めくりにも効く） */
function holdingAway(f: Fighter, from: Fighter): boolean {
  if (f.pad.x === 0) return false;
  const away = Math.sign(f.x - from.x) || -f.facing;
  return Math.sign(f.pad.x) === away;
}

function startAttack(ctx: StepCtx, f: Fighter, move: MoveId): void {
  const def = MOVES[move];
  const air = def.fromAir === true;
  f.act = {
    k: 'attack',
    move,
    t: 0,
    connected: false,
    hitCount: 0,
    lastHitT: -99,
    x0: f.x,
    y0: f.y,
    falling: false,
    landing: 0,
    extend: 0,
  };
  if (!air) {
    f.vx = 0;
    if (!def.air) f.vy = 0;
  }
  if (move === 'divekick') {
    f.vx = 0.11 * f.facing;
    f.vy = -0.11;
  }
  if (def.kind === 'special') {
    ctx.events.push({ k: 'special', side: f.side, move });
    addMeter(ctx, f, 2);
  }
  if (def.kind === 'super') {
    ctx.events.push({ k: 'super', side: f.side, move: move as SuperId });
    f.meter = 0;
    ctx.s.freeze = SUPER_FLASH_FRAMES;
  }
}

/**
 * 必殺技・超必殺を出せるか（コマンドの成立を見て、出すなら出して true）。
 * **超必殺が先**、次にむずかしいコマンドから（一回転の軌跡は昇龍を含みうる）。
 */
/**
 * ボタンを押した瞬間に成立している必殺技（コマンドの判定）。**むずかしいコマンドから**
 * 見る（一回転の軌跡は昇龍を含みうる／昇龍は波動を含みうる）。
 */
const SPECIAL_PRIORITY: readonly SpecialId[] = [
  'screw',
  'shoryu',
  'somersault',
  'zutsuki',
  'buki',
  'hadou',
  'tatsu',
  'kobun',
  'hyakuretsu',
];

function specialAtPress(
  loadout: FighterLoadout,
  f: Fighter,
  pressed: { p: boolean; k: boolean },
): SpecialId | null {
  for (const id of SPECIAL_PRIORITY) {
    if (!loadout.specials.includes(id)) continue;
    const def = MOVES[id];
    if (!def.command || !def.button) continue;
    if (!(def.button === 'p' ? pressed.p : pressed.k)) continue;
    if (detectMotion(f.input, def.command, def.button)) return id;
  }
  return null;
}

/**
 * 覚えている必殺技・超必殺を出せるなら出す（true）。**超必殺が先**。
 * 出せない理由（自分の弾がまだ画面にある・子分はもう呼んだ）なら、その入力は捨てる。
 */
function trySpecial(ctx: StepCtx, f: Fighter, air: boolean): boolean {
  const loadout = ctx.s.loadouts[f.side];
  if (f.bufSuper > 0 && loadout.super && f.meter >= METER_MAX && !air) {
    f.bufSuper = 0;
    startAttack(ctx, f, loadout.super);
    return true;
  }
  if (air) {
    if (f.bufK > 0 && loadout.specials.includes('divekick') && isDownDir(numpad(f))) {
      f.bufK = 0;
      startAttack(ctx, f, 'divekick');
      return true;
    }
    return false;
  }
  const id = f.bufSpecial;
  if (!id) return false;
  f.bufSpecial = null;
  f.bufSpecialLeft = 0;
  if (id === 'hadou' && ownsProjectile(ctx.s, f.side, 'hadou')) return false;
  if (id === 'kobun') {
    if (f.kobunUsed) return false;
    f.kobunUsed = true;
  }
  startAttack(ctx, f, id);
  return true;
}

function ownsProjectile(s: BrawlState, side: BrawlSide, kind: ProjectileKind): boolean {
  return s.projectiles.some((p) => p.alive && p.owner === side && (p.kind === kind || (kind === 'hadou' && p.kind === 'shinku')));
}

/** 通常技を選ぶ（姿勢と間合い） */
function normalFor(f: Fighter, foe: Fighter, button: 'p' | 'k'): NormalId {
  const crouch = isDownDir(numpad(f));
  if (crouch) return button === 'p' ? 'crP' : 'crK';
  if (button === 'k') return 'sK';
  return Math.abs(foe.x - f.x) <= 1.0 ? 'cP' : 'sP';
}

/** 動ける選手の1フレームぶんの意思 */
function decide(ctx: StepCtx, side: BrawlSide): void {
  const s = ctx.s;
  const f = s[side];
  const foe = s[OTHER_SIDE[side]];
  const d = numpad(f);
  const loadout = s.loadouts[side];

  // キャンセル（当てた通常技の戻りを必殺技・超必殺で打ち消す）
  if (f.act.k === 'attack') {
    const def = MOVES[f.act.move];
    const windowEnd = def.startup + def.active + 8;
    if (def.cancel && f.act.connected && f.act.t < windowEnd) {
      if (trySpecial(ctx, f, false)) return;
    }
    // 百裂は連打で伸びる
    if (f.act.move === 'hyakuretsu' && ctx.pressed[side].p && f.act.extend < 30) {
      f.act.extend += 6;
    }
    return;
  }

  // 空中：ジャンプ攻撃・急降下
  if (f.act.k === 'air') {
    // 一回転（スクリュー）は↑で終わるので、キーボードでは↑を押した後にボタンが来る＝
    // **跳び上がった直後（地面すれすれ）なら跳ぶのを取り消して掴む**（ストIIの「跳ぶ前の
    // 数フレームで一回転を入れる」と同じ猶予）
    if (f.bufSpecial === 'screw' && f.act.t <= SCREW_AIR_GRACE && f.y < 0.5) {
      f.y = 0;
      f.vy = 0;
      f.vx = 0;
      f.act = { k: 'idle' };
      trySpecial(ctx, f, false);
      return;
    }
    if (trySpecial(ctx, f, true)) return;
    if (!f.act.attacked && (f.bufP > 0 || f.bufK > 0)) {
      const move: NormalId = f.bufK > 0 ? 'jK' : 'jP';
      f.bufP = 0;
      f.bufK = 0;
      // 跳んだ勢い（vx/vy）はそのまま＝空中攻撃を出しても放物線は変わらない
      startAttack(ctx, f, move);
    }
    return;
  }

  // 踏み切り中も必殺技は出せる（一回転＋Pで跳ぶ前に掴む＝ストIIと同じ）
  if (f.act.k === 'jumpSquat') {
    if (trySpecial(ctx, f, false)) return;
    return;
  }

  if (!canAct(f)) return;

  // 必殺技
  if (trySpecial(ctx, f, false)) return;

  // 投げ（近くで横＋P）は `resolveThrowStarts` がまとめて見る（同時に投げ合ったら抜ける）
  if (f.bufP > 0 && (isForwardDir(d) || isBackDir(d)) && !isDownDir(d) && !isUpDir(d)) {
    if (Math.abs(foe.x - f.x) <= MOVES.throw.grabRange! && throwable(foe) && foe.y <= 0.001) {
      ctx.throws.add(side);
      return;
    }
  }

  // 通常技
  if (f.bufP > 0 || f.bufK > 0) {
    const button: 'p' | 'k' = f.bufK > 0 && !(f.bufP > 0) ? 'k' : 'p';
    f.bufP = 0;
    f.bufK = 0;
    startAttack(ctx, f, normalFor(f, foe, button));
    return;
  }

  // ダッシュ
  if (loadout.passives.dash) {
    if (detectMotion(f.input, 'dashF')) {
      f.input = consumeInput(f.input);
      f.act = { k: 'dash', t: 0, dir: 1 };
      ctx.events.push({ k: 'dash', side });
      return;
    }
    if (detectMotion(f.input, 'dashB')) {
      f.input = consumeInput(f.input);
      f.act = { k: 'dash', t: 0, dir: -1 };
      ctx.events.push({ k: 'dash', side });
      return;
    }
  }

  // 移動
  if (isUpDir(d)) {
    const dir: -1 | 0 | 1 = isForwardDir(d) ? 1 : isBackDir(d) ? -1 : 0;
    f.act = { k: 'jumpSquat', t: 0, dir };
    return;
  }
  const threatened = foeThreatens(s, foe, f);
  if (isDownDir(d)) {
    f.act = isBackDir(d) && threatened ? { k: 'guard', low: true } : { k: 'crouch' };
    return;
  }
  if (isForwardDir(d)) {
    f.act = { k: 'walk', dir: 1 };
    return;
  }
  if (isBackDir(d)) {
    f.act = threatened ? { k: 'guard', low: false } : { k: 'walk', dir: -1 };
    return;
  }
  f.act = { k: 'idle' };
}

/**
 * 相手が技を出してきているか（後ろを入れていたら歩かずにガードの形で止まる。
 * ストIIの「近距離ガード」）。飛び道具が近づいているときも同じ。
 */
function foeThreatens(s: BrawlState, foe: Fighter, self: Fighter): boolean {
  const near = Math.abs(foe.x - self.x) < 2.6;
  if (near && foe.act.k === 'attack' && foe.act.t < MOVES[foe.act.move].startup + MOVES[foe.act.move].active + 2) {
    return true;
  }
  return s.projectiles.some(
    (p) => p.alive && p.owner === foe.side && Math.abs(p.x - self.x) < 2.2 && Math.sign(self.x - p.x) === p.dir,
  );
}

/**
 * このフレームの投げをまとめて決める。**同時に掴み合ったら投げ抜け**（弾き合って離れる）。
 * 相手がこのフレームで跳んだ（踏み切った）などで投げられなくなっていたら、掴めずに
 * 肘打ちが出る（ボタンは押しているので何も出ないよりは素直）。
 */
function resolveThrowStarts(ctx: StepCtx): void {
  const s = ctx.s;
  if (ctx.throws.size === 2) {
    for (const side of BRAWL_SIDES) {
      const f = s[side];
      f.bufP = 0;
      f.act = { k: 'blockstun', t: 0, dur: 12, low: false };
      f.slide = -f.facing * 0.45;
    }
    ctx.events.push({ k: 'throwTech', x: (s.batter.x + s.pitcher.x) / 2 });
    return;
  }
  for (const side of ctx.throws) {
    const f = s[side];
    const foe = s[OTHER_SIDE[side]];
    f.bufP = 0;
    if (!throwable(foe) || foe.y > 0.001) {
      startAttack(ctx, f, 'cP');
      continue;
    }
    const back = isBackDir(numpad(f));
    f.act = { k: 'throwing', t: 0, move: 'throw', back };
    foe.act = { k: 'thrown', t: 0, move: 'throw' };
    foe.vx = 0;
    foe.vy = 0;
    ctx.events.push({ k: 'throw', side, move: 'throw' });
  }
}

// ---- 動き ----

function jumpVx(f: Fighter, dir: -1 | 0 | 1, jumpScale: number): number {
  return dir * JUMP_VX * f.facing * Math.sqrt(jumpScale);
}

function advanceFighter(ctx: StepCtx, side: BrawlSide): void {
  const s = ctx.s;
  const f = s[side];
  const foe = s[OTHER_SIDE[side]];
  const loadout = s.loadouts[side];
  const p = loadout.passives;
  if (f.invuln > 0) f.invuln -= 1;
  if (f.throwInvuln > 0) f.throwInvuln -= 1;
  f.sinceHit += 1;
  if (f.sinceHit > STUN_DECAY_WAIT) f.stun = Math.max(0, f.stun - STUN_DECAY_PER_FRAME);

  // 押し戻し（数フレームかけて滑る）
  if (f.slide !== 0) {
    const step = Math.sign(f.slide) * Math.min(Math.abs(f.slide), 0.06);
    f.x += step;
    f.slide -= step;
    if (Math.abs(f.slide) < 1e-4) f.slide = 0;
  }

  const a = f.act;
  switch (a.k) {
    case 'idle':
    case 'crouch':
    case 'guard':
      break;
    case 'walk':
      f.x += a.dir * f.facing * (a.dir === 1 ? WALK_FORWARD : WALK_BACK) * p.walk;
      break;
    case 'dash': {
      a.t += 1;
      const frames = a.dir === 1 ? DASH_FRAMES : BACKDASH_FRAMES;
      const dist = a.dir === 1 ? DASH_DISTANCE : BACKDASH_DISTANCE;
      // 前半で進み切る（ダッシュの出だしが速い）
      const prev = easeOut((a.t - 1) / (frames * 0.8));
      const now = easeOut(a.t / (frames * 0.8));
      f.x += a.dir * f.facing * dist * (now - prev);
      if (a.dir === -1 && a.t < 6) f.invuln = Math.max(f.invuln, 1);
      if (a.t >= frames) f.act = { k: 'idle' };
      break;
    }
    case 'jumpSquat':
      a.t += 1;
      if (a.t >= JUMP_SQUAT) {
        f.act = { k: 'air', t: 0, dir: a.dir, attacked: false };
        f.vy = JUMP_VY * Math.sqrt(p.jump);
        f.vx = jumpVx(f, a.dir, p.jump);
        ctx.events.push({ k: 'jump', side });
      }
      break;
    case 'air':
      a.t += 1;
      airPhysics(ctx, f, loadout);
      break;
    case 'land':
      a.t += 1;
      if (a.t >= a.dur) f.act = { k: 'idle' };
      break;
    case 'attack':
      advanceAttack(ctx, f, foe, loadout);
      break;
    case 'hitstun':
    case 'blockstun':
      a.t += 1;
      if (a.t >= a.dur) {
        f.throwInvuln = THROW_INVULN_FRAMES;
        if (a.k === 'hitstun' && f.dizzyPending) {
          f.dizzyPending = false;
          f.act = { k: 'dizzy', t: 0, dur: DIZZY_FRAMES };
          ctx.events.push({ k: 'dizzy', side });
        } else {
          f.act = { k: 'idle' };
          if (a.k === 'hitstun') f.comboTaken = 0;
        }
      }
      break;
    case 'airHit':
      a.t += 1;
      f.x += f.vx;
      f.y += f.vy;
      f.vy -= GRAVITY;
      if (f.y <= 0) {
        f.y = 0;
        f.vx = 0;
        f.vy = 0;
        if (a.knockdown) {
          f.act = { k: 'knockdown', t: 0 };
          ctx.events.push({ k: 'knockdown', side, x: f.x });
        } else if (f.dizzyPending) {
          f.dizzyPending = false;
          f.act = { k: 'dizzy', t: 0, dur: DIZZY_FRAMES };
          ctx.events.push({ k: 'dizzy', side });
        } else {
          f.act = { k: 'land', t: 0, dur: 8 };
          f.comboTaken = 0;
          f.throwInvuln = THROW_INVULN_FRAMES;
          ctx.events.push({ k: 'land', side });
        }
      }
      break;
    case 'knockdown':
      a.t += 1;
      if (a.t >= KNOCKDOWN_FRAMES) f.act = { k: 'wakeup', t: 0 };
      break;
    case 'wakeup':
      a.t += 1;
      if (a.t >= WAKEUP_FRAMES) {
        f.comboTaken = 0;
        f.throwInvuln = THROW_INVULN_FRAMES;
        if (f.dizzyPending) {
          f.dizzyPending = false;
          f.act = { k: 'dizzy', t: 0, dur: DIZZY_FRAMES };
          ctx.events.push({ k: 'dizzy', side });
        } else {
          f.act = { k: 'idle' };
        }
      }
      break;
    case 'throwing':
      advanceThrow(ctx, f, foe);
      break;
    case 'thrown':
      a.t += 1;
      break;
    case 'dizzy':
      a.t += 1;
      if (a.t >= a.dur) {
        f.act = { k: 'idle' };
        f.stun = 0;
        f.comboTaken = 0;
      }
      break;
    case 'ko':
      a.t += 1;
      if (f.y > 0 || f.vy > 0) {
        f.x += f.vx;
        f.y += f.vy;
        f.vy -= GRAVITY;
        if (f.y <= 0) {
          f.y = 0;
          f.vx = 0;
          f.vy = 0;
          ctx.events.push({ k: 'knockdown', side, x: f.x });
        }
      }
      break;
    case 'win':
    case 'lose':
      a.t += 1;
      if (f.y > 0) {
        f.y = Math.max(0, f.y + f.vy);
        f.vy -= GRAVITY;
      }
      break;
  }
  f.x = Math.max(-STAGE_HALF, Math.min(STAGE_HALF, f.x));
}

function airPhysics(ctx: StepCtx, f: Fighter, _loadout: FighterLoadout): void {
  f.x += f.vx;
  f.y += f.vy;
  f.vy -= GRAVITY;
  if (f.y <= 0) {
    f.y = 0;
    f.vx = 0;
    f.vy = 0;
    f.act = { k: 'land', t: 0, dur: LAND_FRAMES };
    ctx.events.push({ k: 'land', side: f.side });
  }
}

function advanceAttack(ctx: StepCtx, f: Fighter, foe: Fighter, loadout: FighterLoadout): void {
  const a = f.act;
  if (a.k !== 'attack') return;
  const def = MOVES[a.move];
  a.t += 1;
  // 振った瞬間（当たり判定が出たフレーム）＝風切りの音
  if (def.hitbox && a.t === def.startup) ctx.events.push({ k: 'swing', side: f.side, move: a.move });

  // 飛び道具を出す
  if (def.projectile && a.t === def.projectile.at) {
    spawnProjectile(ctx, f, def.projectile.kind);
  }

  // 空中の通常技・急降下：跳んだ放物線のまま
  if (def.fromAir) {
    f.x += f.vx;
    f.y += f.vy;
    f.vy -= a.move === 'divekick' && !a.falling ? 0 : GRAVITY;
    if (f.y <= 0) {
      f.y = 0;
      f.vx = 0;
      f.vy = 0;
      if (a.move === 'divekick' || a.move === 'jP' || a.move === 'jK') {
        const dur = a.move === 'divekick' ? def.recovery : LAND_FRAMES;
        f.act = { k: 'land', t: 0, dur };
        ctx.events.push({ k: 'land', side: f.side });
      }
    }
    return;
  }

  // `path` のある技（昇龍・竜巻・頭突き・サマーソルト・超必殺）
  if (def.path && !a.falling) {
    const end = def.startup + def.active;
    if (a.t <= end) {
      const pt = def.path(a.t);
      f.x = a.x0 + pt.dx * f.facing;
      f.y = a.y0 + pt.y;
      if (a.t === end) {
        a.falling = true;
        f.vx = 0;
        f.vy = 0;
      }
      return;
    }
  }
  if (def.air && a.falling) {
    f.x += f.vx;
    f.y += f.vy;
    f.vy -= GRAVITY;
    if (f.y <= 0) {
      f.y = 0;
      f.vx = 0;
      f.vy = 0;
      f.act = { k: 'land', t: 0, dur: def.recovery };
      ctx.events.push({ k: 'land', side: f.side });
    }
    return;
  }

  // 掴み技（スクリュー）：出た瞬間に間合いを見る
  if (a.move === 'screw' && a.t === def.startup) {
    if (Math.abs(foe.x - f.x) <= def.grabRange! && throwable(foe) && foe.y <= 0.001) {
      f.act = { k: 'throwing', t: 0, move: 'screw', back: false };
      foe.act = { k: 'thrown', t: 0, move: 'screw' };
      ctx.events.push({ k: 'throw', side: f.side, move: 'screw' });
      return;
    }
    ctx.events.push({ k: 'whiff', side: f.side, move: 'screw' });
  }

  const total = def.startup + def.active + a.extend + def.recovery;
  if (a.t >= total) {
    f.act = isDownDir(numpad(f)) ? { k: 'crouch' } : { k: 'idle' };
    void loadout;
  }
}

/** 投げ・スクリューの進行（ダメージは叩きつけた瞬間） */
function advanceThrow(ctx: StepCtx, f: Fighter, foe: Fighter): void {
  const a = f.act;
  if (a.k !== 'throwing') return;
  a.t += 1;
  const screw = a.move === 'screw';
  const slamAt = screw ? 44 : 18;
  const endAt = screw ? 60 : 36;
  if (foe.act.k === 'thrown') {
    // 投げている相手の位置（見た目。投げの間は相手を掴んでいる）
    if (screw) {
      const lift = Math.sin(Math.min(1, a.t / slamAt) * Math.PI) * 1.6;
      foe.x = f.x + f.facing * 0.5;
      foe.y = lift;
      f.y = lift * 0.9;
    } else {
      const k = Math.min(1, a.t / slamAt);
      const dir = a.back ? -1 : 1;
      foe.x = f.x + f.facing * dir * (0.4 + 0.9 * k) * (a.back ? Math.min(1, k * 1.4) : 1);
      foe.y = Math.sin(k * Math.PI) * 1.1;
    }
  }
  if (a.t === slamAt) {
    const def = MOVES[screw ? 'screw' : 'throw'];
    f.y = 0;
    if (foe.act.k === 'thrown') {
      foe.y = 0;
      const dmg = Math.round(def.damage * attackScale(ctx.s, f));
      foe.hp = Math.max(0, foe.hp - dmg);
      foe.stun += def.stun;
      foe.sinceHit = 0;
      foe.hurtBy = screw ? 'screw' : 'throw';
      foe.comboTaken += 1;
      addMeter(ctx, f, dmg * 0.8);
      addMeter(ctx, foe, dmg * 0.5);
      ctx.events.push({
        k: 'hit',
        attacker: f.side,
        defender: foe.side,
        move: screw ? 'screw' : 'throw',
        damage: dmg,
        blocked: false,
        x: foe.x,
        y: 0.3,
        heavy: true,
        combo: foe.comboTaken,
        armored: false,
      });
      ctx.events.push({ k: 'slam', side: foe.side, x: foe.x });
      if (foe.stun >= STUN_MAX + ctx.s.loadouts[foe.side].passives.stunGuard) foe.dizzyPending = true;
      foe.act = foe.hp <= 0 ? { k: 'ko', t: 0 } : { k: 'knockdown', t: 0 };
      if (foe.hp > 0) ctx.events.push({ k: 'knockdown', side: foe.side, x: foe.x });
      ctx.s.freeze = 6;
    }
  }
  if (a.t >= endAt) {
    f.act = { k: 'idle' };
    f.y = 0;
  }
}

function spawnProjectile(ctx: StepCtx, f: Fighter, kind: ProjectileKind): void {
  const def = PROJECTILES[kind];
  const s = ctx.s;
  s.projectiles.push({
    id: s.nextProjectileId++,
    owner: f.side,
    kind,
    x: f.x + def.spawnX * f.facing,
    y: f.y + def.spawnY,
    dir: f.facing,
    t: 0,
    hitsLeft: def.hits,
    cooldown: 0,
    alive: true,
  });
  ctx.events.push({ k: 'projectile', side: f.side, kind });
}

// ---- 押し合い・向き ----

function resolvePush(s: BrawlState): void {
  const b = s.batter;
  const p = s.pitcher;
  const grabbing = b.act.k === 'throwing' || p.act.k === 'throwing';
  // 2人とも地上（または高さの差が小さい）なら重ならない
  if (!grabbing && Math.abs(b.y - p.y) < 1.1) {
    const gap = p.x - b.x;
    const min = PUSH_HALF * 2;
    if (Math.abs(gap) < min) {
      const push = (min - Math.abs(gap)) / 2;
      const dir = gap === 0 ? (b.facing === 1 ? 1 : -1) : Math.sign(gap);
      b.x -= push * dir;
      p.x += push * dir;
    }
  }
  // 画面に2人とも収まる距離まで
  const dist = p.x - b.x;
  if (Math.abs(dist) > MAX_GAP) {
    const over = (Math.abs(dist) - MAX_GAP) / 2;
    const dir = Math.sign(dist);
    b.x += over * dir;
    p.x -= over * dir;
  }
  // 画面端
  for (const f of [b, p]) {
    if (f.x < -STAGE_HALF) f.x = -STAGE_HALF;
    if (f.x > STAGE_HALF) f.x = STAGE_HALF;
  }
}

/** 地上で自由に動ける選手は相手を向く（空中・技の最中は振り向かない＝めくりが成立する） */
function updateFacing(s: BrawlState): void {
  for (const side of BRAWL_SIDES) {
    const f = s[side];
    const foe = s[OTHER_SIDE[side]];
    const k = f.act.k;
    const free = k === 'idle' || k === 'crouch' || k === 'walk' || k === 'guard' || k === 'land' || k === 'wakeup' || k === 'blockstun' || k === 'hitstun' || k === 'dizzy';
    if (!free || f.y > 0.001) continue;
    const dx = foe.x - f.x;
    if (Math.abs(dx) > 0.05) f.facing = dx > 0 ? 1 : -1;
  }
}

// ---- 飛び道具 ----

function projectileBox(p: Projectile): Box {
  const def = PROJECTILES[p.kind];
  return { x0: p.x - def.rx, x1: p.x + def.rx, y0: p.y - def.ry, y1: p.y + def.ry };
}

function advanceProjectiles(ctx: StepCtx): void {
  const s = ctx.s;
  for (const p of s.projectiles) {
    if (!p.alive) continue;
    const def = PROJECTILES[p.kind];
    p.t += 1;
    p.x += def.speed * p.dir;
    if (p.cooldown > 0) p.cooldown -= 1;
    if (p.t > def.lifetime || Math.abs(p.x) > STAGE_HALF + 1.5) p.alive = false;
  }
  // 打ち消し合い（違う持ち主の飛び道具どうし）
  const live = s.projectiles.filter((p) => p.alive && PROJECTILES[p.kind].clashes);
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const b = live[j];
      if (a.owner === b.owner || !a.alive || !b.alive) continue;
      if (!overlaps(projectileBox(a), projectileBox(b))) continue;
      // 多段は1発ずつ削り合う（真空波動拳は波動拳1発で消えない）
      a.hitsLeft -= 1;
      b.hitsLeft -= 1;
      if (a.hitsLeft <= 0) a.alive = false;
      if (b.hitsLeft <= 0) b.alive = false;
      ctx.events.push({ k: 'clash', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    }
  }
  s.projectiles = s.projectiles.filter((p) => p.alive);
}

// ---- 当たり ----

/** ゲージを足す。**満タンになった瞬間**だけ告知する（超必殺を持っている選手だけ） */
function addMeter(ctx: StepCtx, f: Fighter, amount: number): void {
  const before = f.meter;
  f.meter = Math.min(METER_MAX, f.meter + amount);
  if (before < METER_MAX && f.meter >= METER_MAX && ctx.s.loadouts[f.side].super) {
    ctx.events.push({ k: 'meterFull', side: f.side });
  }
}

/** 攻撃側の威力（装備・怒り・相手の威嚇） */
function attackScale(s: BrawlState, attacker: Fighter): number {
  const own = s.loadouts[attacker.side];
  const foe = s.loadouts[OTHER_SIDE[attacker.side]];
  const rage = attacker.hp <= attacker.maxHp * 0.3 ? own.passives.rage : 1;
  return own.powerScale * rage * foe.passives.intimidate;
}

function comboScale(n: number): number {
  return COMBO_SCALING[Math.min(Math.max(n, 1), COMBO_SCALING.length) - 1];
}

interface Strike {
  attacker: Fighter;
  move: MoveId | ProjectileKind;
  damage: number;
  chip: number;
  stun: number;
  hitstun: number;
  blockstun: number;
  push: number;
  pushBlock: number;
  guard: GuardType;
  hitstop: number;
  knockdown: boolean;
  juggle: boolean;
  special: boolean;
  /** 当たった場所（火花） */
  x: number;
  y: number;
}

function resolveHits(ctx: StepCtx): void {
  const s = ctx.s;
  const strikes: Array<{ defender: BrawlSide; strike: Strike; onConnect: () => void }> = [];

  // 打撃
  for (const side of BRAWL_SIDES) {
    const f = s[side];
    const foe = s[OTHER_SIDE[side]];
    if (f.act.k !== 'attack') continue;
    const a = f.act;
    const def = MOVES[a.move];
    const box = hitboxOf(f);
    if (!box) continue;
    // 百裂は連打で伸ばしたぶんだけ当たる数も増える
    const hits = (def.hits ?? 1) + (a.move === 'hyakuretsu' ? Math.floor(a.extend / (def.hitEvery ?? 6)) : 0);
    if (a.hitCount >= hits) continue;
    if (hits > 1 && a.t - a.lastHitT < (def.hitEvery ?? 1)) continue;
    const hurt = hurtboxOf(foe, false, def.juggle === true);
    if (!hurt || !overlaps(box, hurt)) continue;
    const last = a.hitCount + 1 >= hits;
    strikes.push({
      defender: foe.side,
      strike: {
        attacker: f,
        move: a.move,
        damage: def.damage,
        chip: def.chip > 0 ? def.chip : s.loadouts[side].passives.ironFist && def.kind === 'normal' ? 2 : 0,
        stun: def.stun,
        hitstun: def.hitstun,
        blockstun: def.blockstun,
        push: def.pushHit,
        pushBlock: def.pushBlock,
        guard: def.guard,
        hitstop: def.hitstop,
        knockdown: def.knockdown && (hits === 1 || last),
        juggle: def.juggle === true,
        special: def.kind !== 'normal',
        x: (Math.max(box.x0, hurt.x0) + Math.min(box.x1, hurt.x1)) / 2,
        y: (Math.max(box.y0, hurt.y0) + Math.min(box.y1, hurt.y1)) / 2,
      },
      onConnect: () => {
        a.connected = true;
        a.hitCount += 1;
        a.lastHitT = a.t;
        if (def.bounce && !a.falling) {
          // 跳ね返る（頭突き・急降下）：その場から後ろへ跳んで落ちる
          a.falling = true;
          f.vx = -0.035 * f.facing;
          f.vy = 0.07;
        }
      },
    });
  }

  // 飛び道具
  for (const p of s.projectiles) {
    if (!p.alive || p.cooldown > 0) continue;
    const foe = s[OTHER_SIDE[p.owner]];
    const hurt = hurtboxOf(foe, true, false);
    const box = projectileBox(p);
    if (!hurt || !overlaps(box, hurt)) continue;
    const def = PROJECTILES[p.kind];
    const last = p.hitsLeft <= 1;
    strikes.push({
      defender: foe.side,
      strike: {
        attacker: s[p.owner],
        move: p.kind,
        damage: def.damage,
        chip: def.chip,
        stun: def.stun,
        hitstun: def.hitstun,
        blockstun: def.blockstun,
        push: def.push,
        pushBlock: def.push,
        guard: def.guard,
        hitstop: def.hitstop,
        knockdown: def.knockdown && last,
        juggle: false,
        special: true,
        x: p.x,
        y: p.y,
      },
      onConnect: () => {
        p.hitsLeft -= 1;
        p.cooldown = def.hitEvery;
        if (p.hitsLeft <= 0) p.alive = false;
      },
    });
  }

  // 同じフレームの当たりは両方とも成立する（相打ち）
  for (const { defender, strike, onConnect } of strikes) {
    onConnect();
    applyStrike(ctx, s[defender], strike);
  }
  s.projectiles = s.projectiles.filter((p) => p.alive);
}

function applyStrike(ctx: StepCtx, d: Fighter, st: Strike): void {
  const s = ctx.s;
  const a = st.attacker;
  const blocking = canBlock(d) && d.y <= 0.001 && holdingAway(d, a);
  const lowBlock = blocking && isDownDir(numpad(d));
  const guardOk =
    blocking && (st.guard === 'mid' || (st.guard === 'high' && !lowBlock) || (st.guard === 'low' && lowBlock));
  const scale = attackScale(s, a);

  if (guardOk) {
    const chip = Math.round(st.chip * scale);
    // 削りでも倒れる（ストIIと同じ。削り切られないよう、ガードだけでは守り切れない）
    d.hp = Math.max(0, d.hp - chip);
    d.act = { k: 'blockstun', t: 0, dur: st.blockstun, low: lowBlock };
    pushApart(d, a, st.pushBlock);
    addMeter(ctx, a, 2);
    addMeter(ctx, d, 3);
    s.freeze = Math.max(s.freeze, Math.round(st.hitstop * 0.7));
    ctx.events.push({
      k: 'hit',
      attacker: a.side,
      defender: d.side,
      move: st.move,
      damage: chip,
      blocked: true,
      x: st.x,
      y: st.y,
      heavy: st.special,
      combo: 0,
      armored: false,
    });
    if (d.hp <= 0) d.act = { k: 'ko', t: 0 };
    return;
  }

  // スーパーアーマー：技を出している最中なら怯まない（ダメージは受ける）
  // スーパーアーマー（鋼の体）：**技を出している最中なら**怯まない（ダメージは6割受ける）
  const armored = d.armorLeft > 0 && d.act.k === 'attack';
  const wasDizzy = d.act.k === 'dizzy';
  d.comboTaken += 1;
  const dmg = Math.max(1, Math.round(st.damage * scale * comboScale(d.comboTaken) * (armored ? 0.6 : 1)));
  d.hp = Math.max(0, d.hp - dmg);
  d.sinceHit = 0;
  d.hurtBy = st.move;
  addMeter(ctx, a, dmg * 0.8);
  addMeter(ctx, d, dmg * 0.5);
  s.freeze = Math.max(s.freeze, st.hitstop);
  ctx.events.push({
    k: 'hit',
    attacker: a.side,
    defender: d.side,
    move: st.move,
    damage: dmg,
    blocked: false,
    x: st.x,
    y: st.y,
    heavy: st.knockdown || st.special,
    combo: d.comboTaken,
    armored,
  });

  if (d.hp <= 0) {
    d.act = { k: 'ko', t: 0 };
    // 倒される方向（攻撃した側から離れる向き）へ吹き飛ぶ
    d.vx = 0.05 * (Math.sign(d.x - a.x) || a.facing);
    d.vy = 0.1;
    d.y = Math.max(d.y, 0.01);
    return;
  }

  if (armored) {
    d.armorLeft -= 1;
    return;
  }

  // ピヨり（のけぞり・ダウンが明けたら）。ピヨっている相手に当てたら覚める
  if (wasDizzy) {
    d.stun = 0;
  } else {
    d.stun += st.stun;
    if (d.stun >= STUN_MAX + s.loadouts[d.side].passives.stunGuard) {
      d.dizzyPending = true;
      d.stun = 0;
    }
  }

  const airborne = d.y > 0.001 || d.act.k === 'air' || d.act.k === 'airHit';
  if (st.knockdown || airborne) {
    const away = Math.sign(d.x - a.x) || a.facing;
    d.act = { k: 'airHit', t: 0, knockdown: st.knockdown || (airborne && st.special) };
    d.vx = away * (st.knockdown ? 0.045 : 0.03);
    d.vy = st.knockdown ? 0.09 : 0.06;
    d.y = Math.max(d.y, 0.01);
    return;
  }
  d.act = { k: 'hitstun', t: 0, dur: st.hitstun, low: isCrouching(d) };
  pushApart(d, a, st.push);
}

/** 押し戻し。**食らった側が画面端なら、攻撃した側が下がる**（ストIIの端の規則） */
function pushApart(d: Fighter, a: Fighter, dist: number): void {
  const away = Math.sign(d.x - a.x) || a.facing;
  const room = away > 0 ? STAGE_HALF - d.x : d.x + STAGE_HALF;
  const own = Math.min(dist, Math.max(0, room));
  d.slide = away * own;
  const rest = dist - own;
  if (rest > 0.01 && a.y <= 0.001) a.slide = -away * rest;
}

// ---- 決着 ----

/** 乱闘の負け（決着したら）。まだなら null */
export function brawlLoser(state: BrawlState): BrawlSide | null {
  if (state.phase !== 'done' || !state.winner) return null;
  return OTHER_SIDE[state.winner];
}

// ---- 乱闘に持ち込むか（フェーズWW-71） ----

/**
 * 乱闘の装備の強さ（体力×威力×必殺技の数）。**CPUの打者が乱闘するかの判断**に使う
 * （`shouldCpuStartBrawl`）。必殺技1つを「体力・威力の15%ぶん」、超必殺を2つぶんと数える
 * ＝装備の中身が読めれば、ぶつける前に「この打者は乱闘してくるか」が分かる。
 */
export const SPECIAL_MOVE_STRENGTH_BONUS = 0.15;

export function loadoutStrength(loadout: FighterLoadout): number {
  const moves = loadout.specials.length + (loadout.super ? 2 : 0);
  return loadout.maxHp * loadout.powerScale * (1 + SPECIAL_MOVE_STRENGTH_BONUS * moves);
}

/**
 * **CPUの打者が乱闘に持ち込むか**（フェーズWW-71。決定的・乱数不使用）。
 *
 * 乱闘に持ち込むかを決めるのは**殴られた打者側だけ**（テストプレイ「ぶつけておいて、
 * 乱闘するかどうかを投手の側が判断できるのはおかしい」）。人間の打者は自分で決め、
 * CPU の打者はこの規則で決める（2026-09-23 ユーザー判断）：
 *
 * 1. **銃で撃たれたら必ずやり返す**（銃は狙って当てる手なので、黙って一塁へ歩く理由が無い）。
 * 2. **普通の死球は、装備が投手以上のときだけ**（負ければ退場＝勝てる見込みがあるときだけ）。
 *
 * 規則が決まっているので、**人間の投手はぶつける前に読める**（打者の乱闘の装備を見れば
 * 乱闘になるかが分かる）＝銃の予兆（F-26-2）・敬遠（Q-38）と同じ「読めるCPU」。
 */
export function shouldCpuStartBrawl(opts: {
  byGun: boolean;
  batter: FighterLoadout;
  pitcher: FighterLoadout;
}): boolean {
  if (opts.byGun) return true;
  return loadoutStrength(opts.batter) >= loadoutStrength(opts.pitcher);
}
