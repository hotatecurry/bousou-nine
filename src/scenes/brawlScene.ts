/**
 * 乱闘（**v3＝ストIIのゲーム性**。フェーズXX-72）：2.5D横視点のカメラで、既存の3D選手モデルを
 * 横から映す（CLAUDE.md ③「乱闘システム」の描画方針。専用2Dスプライトは使わない）。
 *
 * 対戦カードは常に「打者 vs 投手」の1vs1。**判定はすべて `core/brawl.ts`**（1フレーム＝1/60秒の
 * 固定の時計で進む純粋関数）、**CPUの判断は `core/brawlAi.ts`**（人間とまったく同じパッドの
 * 入力を作る）。ここが持つのは次の4つだけ：
 *
 * 1. **入力を集める**：人間はパッドの押しっぱなし＋押した瞬間の取りこぼし防止（`press`）、
 *    CPUは `cpuInput`。どちらも同じ `FrameInput` の形でエンジンへ渡す。
 * 2. **時計を合わせる**：描画は可変フレームなので、固定の1/60秒を積み立てて回す。
 *    KOの直後だけゆっくり回す（スローモーション＝見せ場。判定の中身は変わらない）。
 * 3. **見た目**：姿勢は `entities/fighterPoses.ts`（エンジンの技表から伸び切りを計算する＝
 *    画面で伸び切った拳と実際に当たる時間が1フレームもずれない）、飛び道具・子分・武器・
 *    火花・土煙・炎は `render/vfx.ts`、カメラは2人の中点を追って寄り引きする。
 * 4. **イベントを外へ渡す**（`onEvents`）：音とHUDの呼び出しは main.ts の側（シーンは
 *    音を鳴らさないという既存の約束）。
 */
import * as THREE from 'three';
import {
  type BrawlEvent,
  type BrawlLoadouts,
  type BrawlSide,
  type BrawlState,
  type Fighter,
  type MoveId,
  type PracticeOptions,
  BRAWL_SIDES,
  DASH_FRAMES,
  DEFAULT_LOADOUTS,
  FPS,
  JUMP_AIR_FRAMES,
  METER_MAX,
  MOVES,
  OTHER_SIDE,
  ROUNDS_TO_WIN,
  WAKEUP_FRAMES,
  brawlLoser,
  createBrawlState,
  moveList,
  stepBrawl,
} from '../core/brawl';
import { type BrawlDummy, type CpuBrain, cpuInput, createCpuBrain, dummyInput } from '../core/brawlAi';
import type { FrameInput } from '../core/brawlCommand';
import type { FighterMoveVisual, FighterPose } from '../entities/fighterPoses';
import {
  attachToBody,
  createPlayer,
  movePlayerTo,
  setPlayerColor,
  setPlayerFacing,
  setPlayerPose,
  setPlayerScale,
} from '../entities/player';
import { createProp } from '../entities/props';
import type { VirtualPad } from '../input/keyboard';
import { createVfx } from '../render/vfx';

/**
 * 乱闘の舞台＝**本塁とマウンドの間（フィールドの上）**。カメラは本塁の側に立って外野を
 * 向く（でっかいモードと同じ向き）ので**画面右が +X**＝打者（-X）が画面左・投手が画面右。
 * HUDの体力ゲージ（打者＝左／投手＝右）とも、エンジンの向き（打者は +X が前）とも一致する。
 */
export const BRAWL_STAGE_Z = -9.5;

const STEP = 1 / FPS;
const MAX_DT = 0.1;
/** KOの直後のスローモーション（実時間に対するエンジンの速さ）と長さ（エンジンのフレーム） */
const KO_SLOWMO = 0.3;
const KO_SLOWMO_FRAMES = 45;
/** 当たった瞬間の白い光（秒） */
const HIT_FLASH_SEC = 0.06;

const BATTER_COLOR = 0xcc3333;
const PITCHER_COLOR = 0x2255cc;
const FLASH_COLOR = 0xffffff;

export function createBrawlCamera(aspect: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(40, aspect, 0.1, 600);
  camera.position.set(0, 1.5, BRAWL_STAGE_Z + 6.5);
  camera.lookAt(0, 1.05, BRAWL_STAGE_Z);
  return camera;
}

export interface BrawlFighterMeshes {
  batter: THREE.Group;
  pitcher: THREE.Group;
}

/** 乱闘専用の選手モデル（常時シーンに置いて表示/非表示だけ切り替える） */
export function createBrawlFighters(): BrawlFighterMeshes {
  const batter = createPlayer(BATTER_COLOR);
  const pitcher = createPlayer(PITCHER_COLOR);
  batter.visible = false;
  pitcher.visible = false;
  return { batter, pitcher };
}

// ---- HUDへ渡す形 ----

export interface BrawlHudFighter {
  name: string;
  hp: number;
  maxHp: number;
  meter: number;
  meterMax: number;
  hasSuper: boolean;
  roundWins: number;
  /** この選手が相手に当てている連続技の数（2以上で表示） */
  combo: number;
  /** 怒り（体力が3割を切って威力が上がっている） */
  raging: boolean;
}

export interface BrawlHudView {
  batter: BrawlHudFighter;
  pitcher: BrawlHudFighter;
  /** 残り秒（切り上げ）。練習では null（止まっている） */
  timer: number | null;
  round: number;
  roundsToWin: number;
}

export interface BrawlMoveHint {
  name: string;
  notation: string;
}

export type { BrawlDummy } from '../core/brawlAi';

export interface BrawlController {
  /** 3D の置き場（飛び道具・子分・効果）。main.ts がシーンに足す */
  readonly root: THREE.Group;
  /**
   * 乱闘を始める。装備は**この瞬間の両者のスキルから組む**（乱闘の最中に代打・継投は無い）。
   * `names` はHUDの名前、`practice` はデバッグの乱闘（体力が戻る・ゲージ満タン・時間無制限）。
   */
  enter(loadouts?: BrawlLoadouts, names?: Record<BrawlSide, string>, practice?: PracticeOptions): void;
  exit(): void;
  /** 毎フレーム呼ぶ。active は「乱闘モード中」の間だけ true */
  update(dt: number, active: boolean): void;
  /**
   * ボタンを押した瞬間（K＝P、J＝K、G＝超必殺）。押しっぱなしはパッドから読むが、
   * **1フレームより短い押しを取りこぼさない**ためにここでも覚えておく。
   */
  press(side: BrawlSide, button: 'p' | 'k' | 's'): void;
  view(): BrawlHudView;
  /** その選手が持っている必殺技と超必殺（**その人が押す向き**で書く） */
  moveHints(side: BrawlSide): readonly BrawlMoveHint[];
  /** 練習：相手の動き */
  setDummy(side: BrawlSide, dummy: BrawlDummy): void;
}

// ---- 姿勢：エンジンの状態 → 見た目 ----

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** 技の伸び切り（当たり判定が出ている間は必ず1）と全体の進行 */
function moveProgress(f: Fighter): { move: MoveId; ext: number; t: number } | null {
  const a = f.act;
  if (a.k !== 'attack') return null;
  const def = MOVES[a.move];
  const active = def.active + a.extend;
  const total = def.startup + active + def.recovery;
  let ext: number;
  if (a.t < def.startup) ext = a.t / Math.max(1, def.startup);
  else if (a.t < def.startup + active) ext = 1;
  else ext = 1 - (a.t - def.startup - active) / Math.max(1, def.recovery);
  // 空中へ出る技は、落ちている間も形を保つ（昇龍の拳は降りてくるまで天を指す）
  if (a.falling) ext = Math.max(ext, 0.6);
  return { move: a.move, ext: clamp01(ext), t: clamp01(a.t / total) };
}

function poseOf(f: Fighter, frame: number, walkPhase: number): FighterPose {
  const a = f.act;
  switch (a.k) {
    case 'idle':
      return { kind: 'stance', t: frame / 75 };
    case 'crouch':
      return { kind: 'crouch', t: 0 };
    case 'walk':
      return { kind: 'walk', phase: walkPhase, back: a.dir < 0 };
    case 'guard':
      return { kind: 'guard', low: a.low, shake: 0 };
    case 'dash':
      return { kind: 'dash', t: a.t / DASH_FRAMES, back: a.dir < 0 };
    case 'jumpSquat':
      return { kind: 'jumpSquat' };
    case 'air':
      return { kind: 'jump', t: a.t / JUMP_AIR_FRAMES };
    case 'land':
      return { kind: 'land' };
    case 'attack': {
      const m = moveProgress(f)!;
      if (m.move === 'throw') return { kind: 'throw', t: m.t * 0.3 };
      return { kind: 'move', move: m.move as FighterMoveVisual, ext: m.ext, t: m.t };
    }
    case 'hitstun':
      return { kind: 'hit', t: a.t / Math.max(1, a.dur), low: a.low };
    case 'blockstun':
      return { kind: 'guard', low: a.low, shake: 1 - a.t / Math.max(1, a.dur) };
    case 'airHit':
      return { kind: 'airHit', t: a.t / 30 };
    case 'knockdown':
      return { kind: 'down', t: a.t / FPS };
    case 'wakeup':
      return { kind: 'wakeup', t: a.t / WAKEUP_FRAMES };
    case 'throwing':
      return { kind: 'throw', t: a.t / (a.move === 'screw' ? 60 : 36) };
    case 'thrown':
      return { kind: 'thrown', t: a.t / (a.move === 'screw' ? 44 : 18), screw: a.move === 'screw' };
    case 'dizzy':
      return { kind: 'dizzy', t: a.t / FPS };
    case 'ko':
      return { kind: 'ko', t: a.t / 40 };
    case 'win':
      return { kind: 'win', t: a.t / FPS };
    case 'lose':
      return { kind: 'lose', t: a.t / FPS };
  }
}

/** 技ごとの見た目の添え物（拳の炎・足の風・武器） */
const FIST_FIRE_MOVES: ReadonlySet<MoveId> = new Set(['shoryu', 'batto']);
const FOOT_WIND_MOVES: ReadonlySet<MoveId> = new Set(['tatsu', 'somersault', 'divekick', 'sK', 'jK', 'crK']);
const WEAPON_MOVES: ReadonlySet<MoveId> = new Set(['buki', 'batto']);

interface FighterRig {
  mesh: THREE.Group;
  bat: THREE.Object3D;
  batTip: THREE.Object3D;
  fist: THREE.Object3D;
  foot: THREE.Object3D;
  head: THREE.Object3D;
  baseColor: number;
  flash: number;
  walkPhase: number;
  lastX: number;
}

function createRig(mesh: THREE.Group, baseColor: number): FighterRig {
  const bat = createProp('Bat');
  bat.visible = false;
  attachToBody(mesh, bat, 'handR');
  const batTip = new THREE.Object3D();
  batTip.position.set(0, -1.05, 0);
  bat.add(batTip);
  const fist = new THREE.Object3D();
  attachToBody(mesh, fist, 'handR');
  const foot = new THREE.Object3D();
  attachToBody(mesh, foot, 'footR');
  const head = new THREE.Object3D();
  head.position.y = 0.32;
  attachToBody(mesh, head, 'head');
  return { mesh, bat, batTip, fist, foot, head, baseColor, flash: 0, walkPhase: 0, lastX: 0 };
}

// ---- 本体 ----

export function createBrawlController(opts: {
  batter: THREE.Group;
  pitcher: THREE.Group;
  camera: THREE.PerspectiveCamera;
  /** 側ごとの入力。CPUの側には何も押されていないパッドが渡る */
  pads: Record<BrawlSide, VirtualPad>;
  /** その側を人間が操作しているか（false の側だけCPUが動く） */
  isHuman: (side: BrawlSide) => boolean;
  /** エンジンのイベント（音・HUDの呼び出し用） */
  onEvents?: (events: readonly BrawlEvent[], state: BrawlState) => void;
  /** 決着が確定し、勝ち名乗りを見せた後に一度だけ呼ぶ */
  onResolved: (loser: BrawlSide) => void;
}): BrawlController {
  const { camera, pads, isHuman, onEvents, onResolved } = opts;
  const root = new THREE.Group();
  root.name = 'brawlRoot';
  const vfx = createVfx();
  root.add(vfx.group);

  const rigs: Record<BrawlSide, FighterRig> = {
    batter: createRig(opts.batter, BATTER_COLOR),
    pitcher: createRig(opts.pitcher, PITCHER_COLOR),
  };

  // 飛び道具の見た目（気弾は光の玉、子分は小柄な選手）
  const orbMaterial = (color: number): THREE.MeshBasicMaterial =>
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending });
  const orbGeometry = new THREE.SphereGeometry(1, 20, 14);
  const orbs = new Map<number, THREE.Group>();
  const kobuns: Record<BrawlSide, THREE.Group> = {
    batter: createPlayer(BATTER_COLOR),
    pitcher: createPlayer(PITCHER_COLOR),
  };
  for (const side of BRAWL_SIDES) {
    const k = kobuns[side];
    setPlayerScale(k, 0.78);
    k.visible = false;
    root.add(k);
  }

  let state: BrawlState = createBrawlState();
  let names: Record<BrawlSide, string> = { batter: '打者', pitcher: '投手' };
  let brains: Record<BrawlSide, CpuBrain> = { batter: createCpuBrain(), pitcher: createCpuBrain() };
  let dummies: Record<BrawlSide, BrawlDummy> = { batter: 'cpu', pitcher: 'cpu' };
  let latched: Record<BrawlSide, { p: boolean; k: boolean; s: boolean }> = {
    batter: { p: false, k: false, s: false },
    pitcher: { p: false, k: false, s: false },
  };
  let acc = 0;
  let resolved = false;
  let entered = false;
  let realTime = 0;
  // カメラ
  const camTarget = new THREE.Vector3(0, 1.4, BRAWL_STAGE_Z);
  let camX = 0;
  let camDist = 6.5;
  let shake = 0;
  let superFocus: { side: BrawlSide; t: number } | null = null;
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();

  function humanInput(side: BrawlSide): FrameInput {
    const pad = pads[side];
    const dir = pad.direction();
    const l = latched[side];
    return {
      x: dir.x,
      y: dir.y,
      p: pad.isPressed('a') || l.p,
      k: pad.isPressed('b') || l.k,
      s: pad.isPressed('gun') || l.s,
    };
  }

  function inputFor(side: BrawlSide): FrameInput {
    if (isHuman(side)) return humanInput(side);
    const dummy = dummies[side];
    if (dummy !== 'cpu') return dummyInput(state, side, dummy);
    const r = cpuInput(brains[side], state, side);
    brains[side] = r.brain;
    return r.input;
  }

  function worldAt(x: number, y: number, out = tmp): THREE.Vector3 {
    return out.set(x, y, BRAWL_STAGE_Z + 0.25);
  }

  /** イベントを見た目に変える（音・HUDは onEvents で外へ） */
  function showEvents(events: readonly BrawlEvent[]): void {
    for (const e of events) {
      switch (e.k) {
        case 'hit': {
          const dir = Math.sign(state[e.defender].x - state[e.attacker].x) || 1;
          if (e.blocked) {
            vfx.guard(worldAt(e.x, e.y), dir);
            shake = Math.max(shake, 0.03);
          } else {
            const special = MOVES[e.move as MoveId]?.kind !== 'normal';
            const color = e.move === 'hadou' || e.move === 'shinku' ? 0x7fd8ff : special ? 0xffb030 : 0xfff1a0;
            vfx.hit(worldAt(e.x, e.y), { color, heavy: e.heavy, size: e.heavy ? 0.6 : 0.42, dir });
            rigs[e.defender].flash = HIT_FLASH_SEC;
            shake = Math.max(shake, e.heavy ? 0.14 : 0.05);
          }
          break;
        }
        case 'clash':
          vfx.shockwave(worldAt(e.x, e.y), 0x9fe8ff, 0.8);
          vfx.hit(worldAt(e.x, e.y), { color: 0xcff4ff, heavy: true, size: 0.6 });
          shake = Math.max(shake, 0.08);
          break;
        case 'throwTech':
          vfx.guard(worldAt(e.x, 1.2), 1);
          vfx.guard(worldAt(e.x, 1.2), -1);
          break;
        case 'slam':
          vfx.dust(worldAt(e.x, 0), 1.2);
          vfx.shockwave(worldAt(e.x, 0.15), 0xffe6b0, 0.9);
          shake = Math.max(shake, 0.18);
          break;
        case 'knockdown':
          vfx.dust(worldAt(e.x, 0), 0.8);
          break;
        case 'land':
          vfx.dust(worldAt(state[e.side].x, 0), 0.15);
          break;
        case 'dash':
          vfx.dust(worldAt(state[e.side].x, 0), 0.35, state[e.side].facing);
          break;
        case 'super':
          superFocus = { side: e.side, t: 0 };
          vfx.shockwave(worldAt(state[e.side].x, 1.1), 0xffe066, 1.3);
          break;
        case 'ko':
          for (const side of BRAWL_SIDES) {
            if (e.loser === side || e.loser === 'both') {
              vfx.shockwave(worldAt(state[side].x, 1.0), 0xffffff, 1.6);
              rigs[side].flash = 0.2;
            }
          }
          shake = Math.max(shake, 0.25);
          break;
        default:
          break;
      }
    }
  }

  function stepOnce(): void {
    const inputs = { batter: inputFor('batter'), pitcher: inputFor('pitcher') };
    for (const side of BRAWL_SIDES) latched[side] = { p: false, k: false, s: false };
    const r = stepBrawl(state, inputs);
    state = r.state;
    if (r.events.length > 0) {
      showEvents(r.events);
      onEvents?.(r.events, state);
    }
  }

  // ---- 見た目 ----

  function syncFighter(side: BrawlSide, dt: number): void {
    const f = state[side];
    const rig = rigs[side];
    const dx = f.x - rig.lastX;
    rig.lastX = f.x;
    if (f.act.k === 'walk') rig.walkPhase += Math.abs(dx) * 9 * (f.act.dir > 0 ? 1 : -1);
    rig.mesh.position.set(f.x, f.y, BRAWL_STAGE_Z);
    setPlayerFacing(rig.mesh, f.facing === 1 ? Math.PI / 2 : -Math.PI / 2);
    setPlayerPose(rig.mesh, { kind: 'fighter', pose: poseOf(f, state.frame, rig.walkPhase) });

    // 当たった瞬間の白い光→元の色（ピヨりは黄色く明滅）
    if (rig.flash > 0) {
      rig.flash -= dt;
      setPlayerColor(rig.mesh, FLASH_COLOR);
    } else if (f.act.k === 'dizzy' && Math.floor(realTime * 8) % 2 === 0) {
      setPlayerColor(rig.mesh, 0xd8c040);
    } else {
      setPlayerColor(rig.mesh, rig.baseColor);
    }

    // 武器（武器振り回し・バット龍拳の間だけ手に持つ）
    const a = f.act;
    const move = a.k === 'attack' ? a.move : null;
    rig.bat.visible = move !== null && WEAPON_MOVES.has(move);

    // 添え物の効果（実時間で出す＝ヒットストップの間も炎は揺れる）
    const frame = Math.floor(realTime * 60);
    if (move !== null) {
      const m = moveProgress(f)!;
      if (FIST_FIRE_MOVES.has(move) && m.ext > 0.3) {
        const src = move === 'batto' ? rig.batTip : rig.fist;
        src.getWorldPosition(tmp2);
        vfx.ember(tmp2, move === 'batto' ? 0xff6a1a : 0xffa030, 0.34, 0.35, 1.6);
        if (move === 'batto') {
          rig.bat.getWorldPosition(tmp);
          vfx.ember(tmp.lerp(tmp2, 0.5), 0xff3a10, 0.26, 0.3, 1.2);
        }
      }
      if (FOOT_WIND_MOVES.has(move) && m.ext > 0.5 && frame % 2 === 0) {
        rig.foot.getWorldPosition(tmp2);
        vfx.ember(tmp2, move === 'tatsu' ? 0xcfefff : 0xffffff, 0.2, 0.18, 0.2);
      }
      if ((move === 'hadou' || move === 'shinku') && m.t < 0.35) {
        rig.fist.getWorldPosition(tmp2);
        vfx.ember(tmp2, 0x6fd0ff, move === 'shinku' ? 0.35 : 0.24, 0.12, 0.3);
      }
      if (move === 'zutsuki' && m.ext >= 1 && frame % 2 === 0) {
        rig.head.getWorldPosition(tmp2);
        vfx.ember(tmp2, 0xffffff, 0.3, 0.15, 0);
      }
    }
    if (f.act.k === 'dizzy') {
      rig.head.getWorldPosition(tmp2);
      vfx.stars(tmp2, realTime);
    }
    // 怒り（体力3割以下で威力が上がっている）＝体から赤い気が立つ
    const loadout = state.loadouts[side];
    if (loadout.passives.rage > 1 && f.hp <= f.maxHp * 0.3 && f.hp > 0 && frame % 4 === 0) {
      vfx.ember(worldAt(f.x + (Math.sin(realTime * 13) * 0.3), 0.3 + ((frame / 4) % 5) * 0.3, tmp2), 0xff3020, 0.3, 0.5, 1.5);
    }
    // ゲージ満タン（超必殺を持っていれば体が光る）
    if (loadout.super && f.meter >= METER_MAX && frame % 6 === 0) {
      rig.fist.getWorldPosition(tmp2);
      vfx.ember(tmp2, 0xffe066, 0.18, 0.4, 0.8);
    }
  }

  function syncProjectiles(): void {
    const seen = new Set<number>();
    for (const side of BRAWL_SIDES) kobuns[side].visible = false;
    for (const p of state.projectiles) {
      if (!p.alive) continue;
      if (p.kind === 'kobun') {
        const k = kobuns[p.owner];
        k.visible = true;
        setPlayerFacing(k, p.dir === 1 ? Math.PI / 2 : -Math.PI / 2);
        movePlayerTo(k, p.x, 0, BRAWL_STAGE_Z + 0.35);
        setPlayerPose(k, { kind: 'run' });
        continue;
      }
      seen.add(p.id);
      let orb = orbs.get(p.id);
      if (!orb) {
        orb = new THREE.Group();
        const big = p.kind === 'shinku';
        const core = new THREE.Mesh(orbGeometry, orbMaterial(0xe8fbff));
        core.scale.setScalar(big ? 0.26 : 0.16);
        const halo = new THREE.Mesh(orbGeometry, orbMaterial(big ? 0x3f7dff : 0x3fb8ff));
        halo.scale.set(big ? 0.5 : 0.3, big ? 0.46 : 0.26, big ? 0.46 : 0.26);
        (halo.material as THREE.MeshBasicMaterial).opacity = 0.55;
        orb.add(halo, core);
        orb.renderOrder = 11;
        root.add(orb);
        orbs.set(p.id, orb);
      }
      orb.position.set(p.x, p.y, BRAWL_STAGE_Z + 0.25);
      const pulse = 1 + Math.sin(realTime * 30 + p.id) * 0.08;
      orb.scale.setScalar(pulse);
      // 尾（後ろへ流れる気）
      tmp2.set(p.x - p.dir * 0.15, p.y, BRAWL_STAGE_Z + 0.25);
      vfx.ember(tmp2, p.kind === 'shinku' ? 0x5f8dff : 0x5fc8ff, p.kind === 'shinku' ? 0.55 : 0.34, 0.22, 0);
    }
    for (const [id, orb] of orbs) {
      if (!seen.has(id)) {
        root.remove(orb);
        orbs.delete(id);
      }
    }
  }

  function syncCamera(dt: number): void {
    const b = state.batter;
    const p = state.pitcher;
    const mid = (b.x + p.x) / 2;
    const gap = Math.abs(p.x - b.x);
    let targetX = mid;
    // 跳んだ頭が上端の体力ゲージの下に入らない高さへ注視点を上げ、足元は画面の下寄りに置く
    // （ストIIと同じく、地面が画面の下の方にあって上に跳ぶ余白がある構図）
    let targetDist = 6.4 + Math.max(0, gap - 2.4) * 0.45;
    let targetY = 1.4 + Math.max(b.y, p.y) * 0.45;
    // 超必殺の暗転の間は出した本人へ寄る
    if (superFocus) {
      superFocus.t += dt;
      if (state.freeze > 0 && superFocus.t < 1.2) {
        targetX = state[superFocus.side].x;
        targetDist = 4.6;
        targetY = 1.35;
      } else {
        superFocus = null;
      }
    }
    const k = 1 - Math.exp(-dt * 7);
    camX += (targetX - camX) * k;
    camDist += (targetDist - camDist) * k;
    camTarget.y += (targetY - camTarget.y) * k;
    shake *= Math.exp(-dt * 10);
    const sx = shake * Math.sin(realTime * 93);
    const sy = shake * Math.cos(realTime * 71) * 0.6;
    camera.position.set(camX + sx, camTarget.y - 0.05 + sy, BRAWL_STAGE_Z + camDist);
    camTarget.x = camX + sx * 0.5;
    camera.lookAt(camTarget);
  }

  function syncAll(dt: number): void {
    for (const side of BRAWL_SIDES) syncFighter(side, dt);
    syncProjectiles();
    vfx.update(dt);
    syncCamera(dt);
  }

  function clearVisuals(): void {
    vfx.clear();
    for (const orb of orbs.values()) root.remove(orb);
    orbs.clear();
    for (const side of BRAWL_SIDES) {
      kobuns[side].visible = false;
      rigs[side].bat.visible = false;
      rigs[side].flash = 0;
    }
  }

  return {
    root,

    enter(loadouts: BrawlLoadouts = DEFAULT_LOADOUTS, n?: Record<BrawlSide, string>, practice?: PracticeOptions) {
      state = createBrawlState(loadouts, practice ?? null);
      names = n ?? { batter: '打者', pitcher: '投手' };
      brains = { batter: createCpuBrain(), pitcher: createCpuBrain() };
      latched = { batter: { p: false, k: false, s: false }, pitcher: { p: false, k: false, s: false } };
      if (!practice) dummies = { batter: 'cpu', pitcher: 'cpu' };
      acc = 0;
      resolved = false;
      entered = true;
      realTime = 0;
      shake = 0;
      superFocus = null;
      camX = 0;
      camDist = 6.5;
      clearVisuals();
      for (const side of BRAWL_SIDES) {
        const rig = rigs[side];
        rig.mesh.visible = true;
        rig.lastX = state[side].x;
        rig.walkPhase = 0;
      }
      root.visible = true;
      syncAll(0);
    },

    exit() {
      entered = false;
      rigs.batter.mesh.visible = false;
      rigs.pitcher.mesh.visible = false;
      clearVisuals();
      root.visible = false;
    },

    update(dt, active) {
      if (!active || !entered) return;
      const d = Math.min(dt, MAX_DT);
      realTime += d;
      // KOの直後だけゆっくり（見せ場のスローモーション）
      const slow = state.phase === 'ko' && state.phaseT < KO_SLOWMO_FRAMES ? KO_SLOWMO : 1;
      acc += d * slow;
      while (acc >= STEP) {
        acc -= STEP;
        if (state.phase === 'done') break;
        stepOnce();
      }
      syncAll(d);
      if (state.phase === 'done' && !resolved) {
        const loser = brawlLoser(state);
        if (loser) {
          resolved = true;
          onResolved(loser);
        }
      }
    },

    press(side, button) {
      if (!entered || !isHuman(side)) return;
      latched[side][button] = true;
    },

    view(): BrawlHudView {
      const fighter = (side: BrawlSide): BrawlHudFighter => {
        const f = state[side];
        const lo = state.loadouts[side];
        return {
          name: names[side],
          hp: f.hp,
          maxHp: f.maxHp,
          meter: f.meter,
          meterMax: METER_MAX,
          hasSuper: lo.super !== null,
          roundWins: f.roundWins,
          combo: state[OTHER_SIDE[side]].comboTaken,
          raging: lo.passives.rage > 1 && f.hp <= f.maxHp * 0.3 && f.hp > 0,
        };
      };
      return {
        batter: fighter('batter'),
        pitcher: fighter('pitcher'),
        timer: state.practice ? null : Math.ceil(state.timer / FPS),
        round: state.round,
        roundsToWin: ROUNDS_TO_WIN,
      };
    },

    moveHints(side) {
      return moveList(state.loadouts[side], state[side].facing).map((m) => ({ name: m.name, notation: m.notation }));
    },

    setDummy(side, dummy) {
      dummies[side] = dummy;
      brains[side] = createCpuBrain();
    },
  };
}
