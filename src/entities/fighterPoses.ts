/**
 * 乱闘v3の姿勢（フェーズXX-72）。**横視点（2.5D）の格闘ゲームのポーズ**を、選手モデルの
 * 関節（`player.ts` と同じ階層）に時間から書く。
 *
 * `player.ts` の `setPlayerPose({ kind: 'fighter', pose })` から呼ばれる。モデルの寸法や
 * 足を地面に着ける計算（`flexLegs`）は `player.ts` が持っているので、**呼び出し側から
 * 道具（`PoseKit`）として受け取る**＝このファイルはモデルの寸法を書き写さない。
 *
 * ## 約束（`player.ts` の姿勢と同じ）
 *
 * - モデルの正面は +Z（＝相手のいる向き）。技はすべて +Z へ伸ばす。
 * - 腕の `rotation.x` が負＝前へ上がる。脚の `rotation.x` が負＝前へ振り上げる。
 * - 骨盤の `rotation.x` が正＝前へ倒れる（うつ伏せ）、負＝後ろへ反る（仰向け）。
 * - **全関節は毎回まっさらから書く**（`player.ts` の `resetJoints` の後に呼ばれる）。
 *
 * ## 技の進行度
 *
 * 技は `ext`（0..1＝伸び切り具合）で書く。**当たり判定が出ているフレームで必ず1**
 * （`fighterMovePose` がエンジンの技表から計算する）＝画面で伸び切った拳と、実際に当たる
 * 時間が1フレームもずれない（E-25-(c)で投球の腕とリリースを同じ値から起こしたのと同じ整理）。
 */
import type * as THREE from 'three';

export type FighterJointName =
  | 'Pelvis'
  | 'Torso'
  | 'Head'
  | 'ArmUpperL'
  | 'ArmLowerL'
  | 'ArmUpperR'
  | 'ArmLowerR'
  | 'LegUpperL'
  | 'LegLowerL'
  | 'LegUpperR'
  | 'LegLowerR'
  | 'FootL'
  | 'FootR';

export type FighterJoints = Record<FighterJointName, THREE.Object3D>;

/** `player.ts` から借りる道具（モデルの寸法を知っている計算） */
export interface PoseKit {
  /** 脚を曲げつつ足の裏を地面に着けたままにする（腰の高さも書く） */
  flexLegs(j: FighterJoints, thigh: number, shin: number): void;
  groundedHipY(thigh: number, shin: number): number;
  hipHeight: number;
}

/** 見た目の技の種類（エンジンの技IDと同じ名前。見た目の表をここに閉じる） */
export type FighterMoveVisual =
  | 'cP'
  | 'sP'
  | 'sK'
  | 'crP'
  | 'crK'
  | 'jP'
  | 'jK'
  | 'hadou'
  | 'shoryu'
  | 'tatsu'
  | 'zutsuki'
  | 'hyakuretsu'
  | 'screw'
  | 'buki'
  | 'somersault'
  | 'divekick'
  | 'kobun'
  | 'shinku'
  | 'batto';

export type FighterPose =
  | { kind: 'stance'; t: number }
  | { kind: 'walk'; phase: number; back: boolean }
  | { kind: 'crouch'; t: number }
  | { kind: 'guard'; low: boolean; shake: number }
  | { kind: 'dash'; t: number; back: boolean }
  | { kind: 'jumpSquat' }
  | { kind: 'jump'; t: number }
  | { kind: 'land' }
  /** 技。`ext` は伸び切り（当たっている間は1）、`t` は技全体の進行（0..1） */
  | { kind: 'move'; move: FighterMoveVisual; ext: number; t: number }
  | { kind: 'hit'; t: number; low: boolean }
  | { kind: 'airHit'; t: number }
  | { kind: 'down'; t: number }
  | { kind: 'wakeup'; t: number }
  | { kind: 'dizzy'; t: number }
  | { kind: 'throw'; t: number }
  | { kind: 'thrown'; t: number; screw: boolean }
  | { kind: 'ko'; t: number }
  | { kind: 'win'; t: number }
  | { kind: 'lose'; t: number };

const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// ---- 構えの基本 ----

const STANCE_THIGH = -0.32;
const STANCE_SHIN = 0.6;
const CROUCH_THIGH = -1.25;
const CROUCH_SHIN = 2.15;

/**
 * 構え（半身・拳を顔の前）。**前足を相手側、後ろ足を開く**＝横から見て構えている形。
 * `bob` は呼吸の上下（ストIIの待機の揺れ）。
 */
function stanceBase(j: FighterJoints, kit: PoseKit, bob = 0): void {
  kit.flexLegs(j, STANCE_THIGH - 0.04 * bob, STANCE_SHIN + 0.08 * bob);
  // 前足（+X側を前へ）と後ろ足
  j.LegUpperR.rotation.x = STANCE_THIGH - 0.28 - 0.04 * bob;
  j.LegUpperL.rotation.x = STANCE_THIGH + 0.3 - 0.04 * bob;
  j.LegUpperL.rotation.z = -0.12;
  j.LegUpperR.rotation.z = 0.12;
  j.Torso.rotation.y = -0.35;
  j.Torso.rotation.x = -0.08;
  j.Head.rotation.y = 0.3;
  // 拳は顔の前（前の拳を少し前へ）
  j.ArmUpperL.rotation.x = -0.95;
  j.ArmLowerL.rotation.x = -1.65;
  j.ArmUpperR.rotation.x = -0.6;
  j.ArmLowerR.rotation.x = -2.0;
  j.ArmUpperL.rotation.z = 0.25;
  j.ArmUpperR.rotation.z = -0.15;
}

function crouchBase(j: FighterJoints, kit: PoseKit): void {
  kit.flexLegs(j, CROUCH_THIGH, CROUCH_SHIN);
  j.LegUpperL.rotation.z = -0.25;
  j.LegUpperR.rotation.z = 0.25;
  j.Torso.rotation.x = -0.45;
  j.Torso.rotation.y = -0.2;
  j.Head.rotation.x = 0.35;
  j.ArmUpperL.rotation.x = -1.0;
  j.ArmLowerL.rotation.x = -1.6;
  j.ArmUpperR.rotation.x = -0.7;
  j.ArmLowerR.rotation.x = -1.9;
}

// ---- 1つずつ ----

export function applyFighterPose(j: FighterJoints, pose: FighterPose, kit: PoseKit): void {
  switch (pose.kind) {
    case 'stance':
      stanceBase(j, kit, Math.sin(pose.t * Math.PI * 2));
      return;
    case 'walk': {
      stanceBase(j, kit);
      const s = Math.sin(pose.phase);
      const dir = pose.back ? -1 : 1;
      j.LegUpperR.rotation.x = STANCE_THIGH - 0.28 + 0.4 * s * dir;
      j.LegUpperL.rotation.x = STANCE_THIGH + 0.3 - 0.4 * s * dir;
      j.LegLowerR.rotation.x = STANCE_SHIN + 0.35 * Math.max(0, -s);
      j.LegLowerL.rotation.x = STANCE_SHIN + 0.35 * Math.max(0, s);
      j.Pelvis.position.y = kit.groundedHipY(STANCE_THIGH, STANCE_SHIN) + 0.025 * Math.abs(Math.cos(pose.phase));
      return;
    }
    case 'crouch':
      crouchBase(j, kit);
      return;
    case 'guard':
      if (pose.low) {
        crouchBase(j, kit);
        j.ArmUpperL.rotation.x = -1.5;
        j.ArmUpperR.rotation.x = -1.4;
        j.ArmLowerL.rotation.x = -1.7;
        j.ArmLowerR.rotation.x = -1.75;
        j.ArmUpperL.rotation.z = 0.35;
        j.ArmUpperR.rotation.z = -0.35;
      } else {
        stanceBase(j, kit);
        // 両腕を体の前でクロス（ガードしていることが一目で分かる）
        j.ArmUpperL.rotation.x = -1.35;
        j.ArmUpperR.rotation.x = -1.3;
        j.ArmLowerL.rotation.x = -1.7;
        j.ArmLowerR.rotation.x = -1.75;
        j.ArmUpperL.rotation.z = 0.45;
        j.ArmUpperR.rotation.z = -0.45;
        j.Torso.rotation.x = 0.06;
        j.Torso.rotation.y = -0.15;
      }
      // ガードの衝撃で少しのけぞる
      j.Torso.rotation.x += 0.18 * pose.shake;
      return;
    case 'dash': {
      stanceBase(j, kit);
      const lean = pose.back ? 0.25 : -0.35;
      j.Torso.rotation.x = lean * Math.sin(Math.PI * clamp01(pose.t));
      j.LegUpperR.rotation.x = -0.8 * Math.sin(Math.PI * pose.t);
      j.LegUpperL.rotation.x = 0.5 * Math.sin(Math.PI * pose.t);
      return;
    }
    case 'jumpSquat':
      kit.flexLegs(j, -0.8, 1.4);
      j.Torso.rotation.x = -0.25;
      j.ArmUpperL.rotation.x = 0.4;
      j.ArmUpperR.rotation.x = 0.4;
      return;
    case 'jump': {
      // 放物線の中ほどで膝を抱える
      const tuck = Math.sin(Math.PI * clamp01(pose.t));
      j.LegUpperL.rotation.x = -1.3 * tuck;
      j.LegUpperR.rotation.x = -1.1 * tuck;
      j.LegLowerL.rotation.x = 2.0 * tuck;
      j.LegLowerR.rotation.x = 1.8 * tuck;
      j.ArmUpperL.rotation.x = -1.2;
      j.ArmLowerL.rotation.x = -1.4;
      j.ArmUpperR.rotation.x = -0.8;
      j.ArmLowerR.rotation.x = -1.8;
      j.Torso.rotation.x = -0.25 * tuck;
      j.Pelvis.position.y = kit.hipHeight + 0.2 * tuck;
      return;
    }
    case 'land':
      kit.flexLegs(j, -0.7, 1.2);
      j.Torso.rotation.x = -0.2;
      j.ArmUpperL.rotation.x = -0.6;
      j.ArmUpperR.rotation.x = -0.4;
      return;
    case 'move':
      applyMove(j, kit, pose.move, clamp01(pose.ext), clamp01(pose.t));
      return;
    case 'hit': {
      const lean = 1 - clamp01(pose.t);
      if (pose.low) crouchBase(j, kit);
      else stanceBase(j, kit);
      j.Torso.rotation.x = (pose.low ? -0.2 : 0) + 0.6 * lean;
      j.Head.rotation.x = 0.5 * lean;
      j.ArmUpperL.rotation.x = -0.4 + 0.6 * lean;
      j.ArmUpperR.rotation.x = -0.3 + 0.7 * lean;
      j.ArmUpperL.rotation.z = 0.3 + 0.5 * lean;
      j.ArmUpperR.rotation.z = -0.2 - 0.5 * lean;
      return;
    }
    case 'airHit': {
      // 吹き飛ばされて宙で反る（食らった勢いで背中から落ちていく）
      const p = clamp01(pose.t);
      j.Pelvis.rotation.x = -0.9 - 0.6 * p;
      j.LegUpperL.rotation.x = -0.5;
      j.LegUpperR.rotation.x = -0.9;
      j.LegLowerL.rotation.x = 0.8;
      j.LegLowerR.rotation.x = 0.4;
      j.ArmUpperL.rotation.x = -2.4;
      j.ArmUpperR.rotation.x = -2.1;
      j.ArmUpperL.rotation.z = -0.5;
      j.ArmUpperR.rotation.z = 0.5;
      j.Head.rotation.x = -0.4;
      return;
    }
    case 'down': {
      // 仰向けに倒れて伸びている
      j.Pelvis.rotation.x = -1.5;
      j.Pelvis.position.y = 0.2;
      j.LegLowerL.rotation.x = 0.4;
      j.LegLowerR.rotation.x = 0.15;
      j.ArmUpperL.rotation.x = -0.8;
      j.ArmUpperR.rotation.x = -1.1;
      j.ArmUpperL.rotation.z = -0.9;
      j.ArmUpperR.rotation.z = 0.7;
      j.Head.rotation.x = -0.2 + 0.05 * Math.sin(pose.t * 12);
      return;
    }
    case 'wakeup': {
      // 起き上がる（倒れた姿から構えへ）
      const p = clamp01(pose.t);
      stanceBase(j, kit);
      const lie = 1 - p;
      j.Pelvis.rotation.x = -1.5 * lie * lie;
      j.Pelvis.position.y = lerp(0.2, kit.groundedHipY(STANCE_THIGH, STANCE_SHIN), p);
      j.LegUpperL.rotation.x = STANCE_THIGH - 0.9 * lie;
      j.LegLowerL.rotation.x = STANCE_SHIN + 1.2 * lie;
      return;
    }
    case 'dizzy': {
      // ふらふら（上体が円を描いて揺れ、腕がだらりと下がる）
      stanceBase(j, kit);
      const w = pose.t * Math.PI * 2 * 1.6;
      j.Torso.rotation.z = 0.22 * Math.sin(w);
      j.Torso.rotation.x = 0.15 + 0.1 * Math.cos(w);
      j.Head.rotation.z = -0.3 * Math.sin(w);
      j.Head.rotation.x = 0.3;
      j.ArmUpperL.rotation.x = 0.1;
      j.ArmUpperR.rotation.x = 0.05;
      j.ArmLowerL.rotation.x = -0.2;
      j.ArmLowerR.rotation.x = -0.2;
      j.ArmUpperL.rotation.z = 0.15;
      j.ArmUpperR.rotation.z = -0.15;
      return;
    }
    case 'throw': {
      // 掴んで（前半）→ 担いで放り投げる（後半）
      const p = clamp01(pose.t);
      stanceBase(j, kit);
      const grab = Math.min(1, p / 0.3);
      const toss = clamp01((p - 0.3) / 0.4);
      j.ArmUpperL.rotation.x = lerp(-1.5 * grab, -2.8, toss);
      j.ArmUpperR.rotation.x = lerp(-1.4 * grab, -2.6, toss);
      j.ArmLowerL.rotation.x = -0.3;
      j.ArmLowerR.rotation.x = -0.3;
      j.Torso.rotation.x = lerp(-0.2 * grab, 0.35, toss);
      return;
    }
    case 'thrown': {
      // 宙で回される（投げ＝半回転、スクリュー＝きりもみ）
      const p = clamp01(pose.t);
      const turns = pose.screw ? 2.5 : 1;
      j.Pelvis.rotation.x = -Math.PI * turns * p;
      if (pose.screw) j.Pelvis.rotation.y = Math.PI * 4 * p;
      j.LegUpperL.rotation.x = -0.6;
      j.LegUpperR.rotation.x = -0.3;
      j.ArmUpperL.rotation.x = -2.2;
      j.ArmUpperR.rotation.x = -1.8;
      j.ArmUpperL.rotation.z = -0.6;
      j.ArmUpperR.rotation.z = 0.6;
      return;
    }
    case 'ko': {
      const p = clamp01(pose.t);
      j.Pelvis.rotation.x = -1.5 * Math.min(1, p * 1.6);
      j.Pelvis.position.y = lerp(kit.hipHeight, 0.2, Math.min(1, p * 1.6));
      j.ArmUpperL.rotation.x = -2.6;
      j.ArmUpperR.rotation.x = -2.2;
      j.ArmUpperL.rotation.z = -0.8;
      j.ArmUpperR.rotation.z = 0.8;
      j.LegLowerL.rotation.x = 0.6;
      j.Head.rotation.x = -0.4;
      return;
    }
    case 'win': {
      // 拳を突き上げる（もう片方の手は腰に）
      const p = clamp01(pose.t * 2);
      kit.flexLegs(j, -0.1, 0.2);
      j.ArmUpperR.rotation.x = lerp(-0.6, -3.0, p);
      j.ArmLowerR.rotation.x = lerp(-2.0, -0.2, p);
      j.ArmUpperL.rotation.x = 0.2;
      j.ArmUpperL.rotation.z = 0.7;
      j.ArmLowerL.rotation.x = -1.6;
      j.Torso.rotation.x = 0.1 * p;
      j.Head.rotation.x = -0.2 * p;
      return;
    }
    case 'lose': {
      // 膝に手をついてうなだれる（時間切れの負け）
      kit.flexLegs(j, -0.55, 0.9);
      j.Torso.rotation.x = -0.8;
      j.Head.rotation.x = 0.6;
      j.ArmUpperL.rotation.x = -0.7;
      j.ArmUpperR.rotation.x = -0.75;
      j.ArmLowerL.rotation.x = -0.3;
      j.ArmLowerR.rotation.x = -0.3;
      return;
    }
  }
}

/** 技のポーズ。`e`＝伸び切り（当たっている間1）、`t`＝技全体の進行 */
function applyMove(j: FighterJoints, kit: PoseKit, move: FighterMoveVisual, e: number, t: number): void {
  switch (move) {
    case 'cP':
      // 肘打ち（前の肘を横に振る）
      stanceBase(j, kit);
      j.ArmUpperL.rotation.x = lerp(-0.95, -1.5, e);
      j.ArmUpperL.rotation.z = lerp(0.25, 0.95, e);
      j.ArmLowerL.rotation.x = -2.1;
      j.Torso.rotation.y = lerp(-0.35, 0.35, e);
      return;
    case 'sP':
      // まっすぐの突き（前の拳を伸ばし切る）
      stanceBase(j, kit);
      j.ArmUpperL.rotation.x = lerp(-0.95, -1.62, e);
      j.ArmLowerL.rotation.x = lerp(-1.65, -0.05, e);
      j.ArmUpperL.rotation.z = lerp(0.25, 0.05, e);
      j.Torso.rotation.y = lerp(-0.35, 0.15, e);
      j.Torso.rotation.x = -0.12 * e;
      return;
    case 'sK': {
      // 回し蹴り（前足を高く振り上げる）
      stanceBase(j, kit);
      j.LegUpperR.rotation.x = lerp(STANCE_THIGH - 0.28, -1.75, e);
      j.LegUpperR.rotation.z = 0.25 * e;
      j.LegLowerR.rotation.x = lerp(STANCE_SHIN, 0.05, e);
      j.FootR.rotation.x = 0.4 * e;
      j.Torso.rotation.x = 0.4 * e;
      j.Torso.rotation.y = lerp(-0.35, -0.9, e);
      j.LegUpperL.rotation.x = -0.1;
      j.LegLowerL.rotation.x = 0.25;
      j.Pelvis.position.y = kit.groundedHipY(-0.1, 0.25);
      return;
    }
    case 'crP':
      // しゃがみ突き
      crouchBase(j, kit);
      j.ArmUpperL.rotation.x = lerp(-1.0, -1.5, e);
      j.ArmLowerL.rotation.x = lerp(-1.6, -0.1, e);
      j.Torso.rotation.y = lerp(-0.2, 0.25, e);
      return;
    case 'crK':
      // 足払い（しゃがんだまま前足を地面すれすれに払う）
      crouchBase(j, kit);
      j.LegUpperR.rotation.x = lerp(CROUCH_THIGH, -1.45, e);
      j.LegUpperR.rotation.z = lerp(0.25, 1.1, e);
      j.LegLowerR.rotation.x = lerp(CROUCH_SHIN, 0.1, e);
      j.Torso.rotation.x = lerp(-0.45, -0.1, e);
      j.Torso.rotation.z = -0.25 * e;
      j.ArmUpperR.rotation.x = 0.4 * e;
      return;
    case 'jP':
      // 跳び突き（下へ突き下ろす）
      jumpBase(j, kit, 0.8);
      j.ArmUpperL.rotation.x = lerp(-1.2, -1.2, e);
      j.ArmLowerL.rotation.x = lerp(-1.4, -0.1, e);
      j.ArmUpperL.rotation.z = 0.1;
      j.Torso.rotation.x = -0.3 * e;
      return;
    case 'jK':
      // 跳び蹴り（前の脚を斜め下へ伸ばす）
      jumpBase(j, kit, 0.7);
      j.LegUpperR.rotation.x = lerp(-1.1, -1.05, e);
      j.LegLowerR.rotation.x = lerp(1.8, 0.05, e);
      j.Pelvis.rotation.x = -0.35 * e;
      return;
    case 'hadou':
    case 'shinku': {
      // 波動拳：腰だめ（両手を後ろで合わせる）→ 両の掌を前へ突き出す
      stanceBase(j, kit);
      kit.flexLegs(j, -0.55, 0.95);
      j.LegUpperR.rotation.x = -0.95;
      j.LegUpperL.rotation.x = 0.1;
      const charge = t < 0.25 ? t / 0.25 : 1;
      const push = e;
      j.ArmUpperL.rotation.x = lerp(lerp(-0.95, 0.4, charge), -1.55, push);
      j.ArmUpperR.rotation.x = lerp(lerp(-0.6, 0.45, charge), -1.5, push);
      j.ArmLowerL.rotation.x = lerp(-1.4, -0.08, push);
      j.ArmLowerR.rotation.x = lerp(-1.4, -0.08, push);
      j.ArmUpperL.rotation.z = lerp(0.2, -0.12, push);
      j.ArmUpperR.rotation.z = lerp(-0.2, 0.12, push);
      j.Torso.rotation.y = lerp(-0.6, 0, push);
      j.Torso.rotation.x = -0.15 * push;
      return;
    }
    case 'shoryu':
    case 'batto': {
      // 昇龍拳：拳を天へ突き上げながら跳ぶ（脚を畳む）
      const rise = Math.max(e, t > 0.1 ? 1 - clamp01((t - 0.55) / 0.45) : e);
      j.ArmUpperR.rotation.x = lerp(-0.6, -3.05, rise);
      j.ArmLowerR.rotation.x = lerp(-2.0, -0.05, rise);
      j.ArmUpperR.rotation.z = -0.15;
      j.ArmUpperL.rotation.x = -0.5;
      j.ArmLowerL.rotation.x = -1.4;
      j.LegUpperL.rotation.x = -1.2 * rise;
      j.LegLowerL.rotation.x = 1.9 * rise;
      j.LegUpperR.rotation.x = -0.3 * rise;
      j.LegLowerR.rotation.x = 0.4 * rise;
      j.Torso.rotation.y = lerp(-0.4, 0.5, rise);
      j.Pelvis.rotation.y = move === 'batto' ? t * Math.PI * 4 : 0;
      return;
    }
    case 'tatsu': {
      // 竜巻旋風脚：前の脚を真横に伸ばし、体ごと回る
      const spin = t * Math.PI * 2 * 3.5;
      j.Pelvis.rotation.y = spin;
      j.LegUpperR.rotation.x = -1.57;
      j.LegLowerR.rotation.x = 0;
      j.LegUpperL.rotation.x = -0.6;
      j.LegLowerL.rotation.x = 1.4;
      j.ArmUpperL.rotation.x = -1.3;
      j.ArmUpperR.rotation.x = -1.3;
      j.ArmUpperL.rotation.z = 0.6;
      j.ArmUpperR.rotation.z = -0.6;
      j.ArmLowerL.rotation.x = -0.6;
      j.ArmLowerR.rotation.x = -0.6;
      return;
    }
    case 'zutsuki':
      // 頭突き：体を真横にして頭から飛ぶ（腕は後ろへ流す）
      j.Pelvis.rotation.x = lerp(0, 1.45, Math.min(1, e * 1.4));
      j.ArmUpperL.rotation.x = 0.4;
      j.ArmUpperR.rotation.x = 0.4;
      j.ArmUpperL.rotation.z = -0.3;
      j.ArmUpperR.rotation.z = 0.3;
      j.LegUpperL.rotation.x = 0.1;
      j.LegUpperR.rotation.x = -0.1;
      j.Head.rotation.x = -0.6 * e;
      return;
    case 'hyakuretsu': {
      // 百裂張り手：左右の掌を高速で交互に突き出す
      stanceBase(j, kit);
      kit.flexLegs(j, -0.6, 1.0);
      const phase = t * Math.PI * 2 * 7;
      const a = 0.5 + 0.5 * Math.sin(phase);
      const b = 0.5 + 0.5 * Math.sin(phase + Math.PI);
      j.ArmUpperL.rotation.x = lerp(-0.9, -1.6, a * e + (1 - e) * 0.2);
      j.ArmUpperR.rotation.x = lerp(-0.9, -1.55, b * e + (1 - e) * 0.2);
      j.ArmLowerL.rotation.x = lerp(-1.5, -0.1, a * e);
      j.ArmLowerR.rotation.x = lerp(-1.5, -0.1, b * e);
      j.ArmUpperL.rotation.z = 0.1;
      j.ArmUpperR.rotation.z = -0.1;
      j.Torso.rotation.y = 0.25 * Math.sin(phase);
      return;
    }
    case 'screw':
      // スクリューの空振り（両腕で抱きつきに行って空を切る）
      stanceBase(j, kit);
      j.ArmUpperL.rotation.x = -1.4 * e;
      j.ArmUpperR.rotation.x = -1.4 * e;
      j.ArmUpperL.rotation.z = 0.6 * e;
      j.ArmUpperR.rotation.z = -0.6 * e;
      j.ArmLowerL.rotation.x = -0.9;
      j.ArmLowerR.rotation.x = -0.9;
      j.Torso.rotation.x = -0.3 * e;
      return;
    case 'buki':
      // 武器振り回し：振りかぶって（前半）縦に振り下ろす（当たる瞬間に前）
      stanceBase(j, kit);
      j.ArmUpperR.rotation.x = e < 1 && t < 0.5 ? lerp(-0.6, 2.9, clamp01(t / 0.35)) : lerp(2.9, 5.9, clamp01((t - 0.3) / 0.25));
      j.ArmUpperL.rotation.x = j.ArmUpperR.rotation.x;
      j.ArmLowerR.rotation.x = -0.3;
      j.ArmLowerL.rotation.x = -0.3;
      j.ArmUpperR.rotation.z = -0.15;
      j.ArmUpperL.rotation.z = 0.15;
      j.Torso.rotation.x = lerp(0.3, -0.35, clamp01((t - 0.3) / 0.25));
      return;
    case 'somersault': {
      // サマーソルト：後ろ宙返りしながら蹴り上げる
      const flip = clamp01(t * 1.3);
      j.Pelvis.rotation.x = -Math.PI * 2 * flip;
      j.LegUpperR.rotation.x = -1.4 * e;
      j.LegLowerR.rotation.x = 0.1;
      j.LegUpperL.rotation.x = -0.4;
      j.LegLowerL.rotation.x = 1.2;
      j.ArmUpperL.rotation.x = 0.8;
      j.ArmUpperR.rotation.x = 0.8;
      return;
    }
    case 'divekick':
      // 急降下キック：斜め下へ足から突き刺さる
      j.Pelvis.rotation.x = -0.75;
      j.LegUpperR.rotation.x = -0.35;
      j.LegLowerR.rotation.x = 0;
      j.LegUpperL.rotation.x = 0.4;
      j.LegLowerL.rotation.x = 1.1;
      j.ArmUpperL.rotation.x = 0.9;
      j.ArmUpperR.rotation.x = 0.6;
      j.ArmUpperL.rotation.z = -0.5;
      j.ArmUpperR.rotation.z = 0.5;
      return;
    case 'kobun':
      // 子分を呼ぶ：指笛（片手を口へ、もう片手を前へ差し向ける）
      stanceBase(j, kit);
      j.ArmUpperR.rotation.x = -1.2;
      j.ArmLowerR.rotation.x = -2.3;
      j.ArmUpperR.rotation.z = 0.35;
      j.ArmUpperL.rotation.x = -1.5 * e;
      j.ArmLowerL.rotation.x = -0.1;
      j.Head.rotation.x = -0.15;
      return;
  }
}

function jumpBase(j: FighterJoints, kit: PoseKit, tuck: number): void {
  j.LegUpperL.rotation.x = -1.2 * tuck;
  j.LegUpperR.rotation.x = -1.1 * tuck;
  j.LegLowerL.rotation.x = 1.9 * tuck;
  j.LegLowerR.rotation.x = 1.8 * tuck;
  j.ArmUpperL.rotation.x = -1.2;
  j.ArmLowerL.rotation.x = -1.4;
  j.ArmUpperR.rotation.x = -0.8;
  j.ArmLowerR.rotation.x = -1.8;
  j.Pelvis.position.y = kit.hipHeight + 0.15 * tuck;
}
