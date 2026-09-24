/**
 * スキルが**効いた瞬間**の見た目（フェーズYY-73）。でっかいモード・ちっちゃいモードの両方で使う
 * （乱闘は乱闘の効果を持っている）。
 *
 * - **発動の閃き**（`burst`）：投げた・打った・捕った・給油した瞬間に、その選手の札の系統の色で
 *   火花と輪が弾ける。**毎球効く札（球速・変化）は控えめ、一度きりの給油や長打の札は大きく**。
 * - **走る足の尾**（`trail`）：走力の札を持つ走者の足元から、札の性格の粒が流れる
 *   （ジェット靴＝青い炎、チーター＝黄色い筋、スケボー＝火花…）。
 * - **守備範囲の輪**（`reachRings`）：捕球範囲の札を持つ野手の足元に、実際に届く半径の輪を出す
 *   （`犬`・`鷹` の「届く範囲が広がる」が目に見える＝輪の中に入れば捕れる）。
 * - **落下点の印**（`landing`）：`鷹`・`隼`・`野生の勘` の読み。打球が落ちる場所に印が出る。
 * - **通過点の輪**（`crossing`）と**軌道の線**（`path`）：`未来視`・`心眼` の読み。
 *
 * **判定には一切触らない**（位置は呼び出し側が判定と同じ純粋関数から渡す）。
 */
import * as THREE from 'three';
import type { SkillId, SkillLineage } from '../core/skills';
import { SKILLS } from '../core/skills';
import { createVfx } from '../render/vfx';

/** 系統の色（見た目の約束：暴力＝赤橙・メカ＝水色・超能力＝紫・動物＝琥珀・根性＝金） */
export const LINEAGE_COLOR: Record<SkillLineage, number> = {
  violence: 0xff6a3a,
  mecha: 0x5fd8ff,
  psychic: 0xc07aff,
  animal: 0xffc04a,
  guts: 0xffe066,
};

/** 走る足の尾の色（札の性格。無ければ系統の色） */
const TRAIL_COLOR: Partial<Record<SkillId, number>> = {
  jettogutsu: 0x60c8ff,
  tabosukebo: 0x60c8ff,
  sukebo: 0xffd080,
  hoba: 0x9fe8ff,
  chita: 0xffd040,
  uma: 0xd8b080,
  inoshishi: 0xc89a6a,
  kyatapira: 0x8a8a8a,
  hashirikomi: 0xffffff,
};

export interface SkillFx {
  readonly root: THREE.Group;
  burst(pos: THREE.Vector3, skills: readonly SkillId[], strength: number): void;
  /** `scale` は選手の描く倍率（ちっちゃいモードは2.5倍＝尾も同じだけ大きく） */
  trail(pos: THREE.Vector3, skill: SkillId, scale?: number): void;
  /** 守備範囲の輪（null で消す）。半径は判定と同じ捕球半径 */
  reachRings(rings: ReadonlyArray<{ x: number; z: number; radius: number; skill: SkillId }> | null): void;
  landing(point: { x: number; z: number } | null): void;
  crossing(point: { x: number; y: number; z: number } | null): void;
  path(points: ReadonlyArray<{ x: number; y: number; z: number }> | null): void;
  update(dt: number): void;
  clear(): void;
}

export function colorOf(skills: readonly SkillId[]): number {
  const id = skills.find((s) => SKILLS[s]);
  return id ? LINEAGE_COLOR[SKILLS[id].lineage] : 0xffffff;
}

export function createSkillFx(): SkillFx {
  const root = new THREE.Group();
  root.name = 'skillFx';
  const vfx = createVfx();
  root.add(vfx.group);

  // 守備範囲の輪（最大9人ぶん）
  const ringGeo = new THREE.RingGeometry(0.96, 1, 48);
  const rings = Array.from({ length: 9 }, () => {
    const m = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({ color: 0xffc04a, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }),
    );
    m.rotation.x = -Math.PI / 2;
    m.visible = false;
    m.renderOrder = 5;
    root.add(m);
    return m;
  });

  // 落下点の印（鷹の目＝十字の入った輪）
  const landingMark = new THREE.Group();
  const lm = new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide });
  // ちっちゃいモードの選手は2.5倍で描くので、足元に隠れない大きさ（野手の体より外に出る）
  const lRing = new THREE.Mesh(new THREE.RingGeometry(2.6, 3.1, 48), lm);
  const lBar1 = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 0.3), lm);
  const lBar2 = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 6.4), lm);
  for (const m of [lRing, lBar1, lBar2]) {
    m.rotation.x = -Math.PI / 2;
    landingMark.add(m);
  }
  landingMark.position.y = 0.06;
  landingMark.visible = false;
  landingMark.renderOrder = 6;
  root.add(landingMark);

  // 通過点の輪（未来視）
  const crossingMark = new THREE.Mesh(
    new THREE.TorusGeometry(0.12, 0.015, 8, 32),
    new THREE.MeshBasicMaterial({ color: 0x7fe8ff, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  crossingMark.visible = false;
  crossingMark.renderOrder = 12;
  root.add(crossingMark);

  // 軌道の線（心眼）。細い線は1画素にしかならないので、光る管で描く
  const pathMaterial = new THREE.MeshBasicMaterial({
    color: 0xc07aff,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const pathLine = new THREE.Mesh(new THREE.BufferGeometry(), pathMaterial);
  pathLine.visible = false;
  pathLine.renderOrder = 12;
  root.add(pathLine);
  let pathKey: unknown = null;

  let t = 0;

  return {
    root,

    burst(pos, skills, strength) {
      if (skills.length === 0) return;
      const color = colorOf(skills);
      const s = Math.max(0.2, Math.min(1, strength));
      vfx.hit(pos, { color, heavy: s > 0.6, size: 0.25 + 0.45 * s, count: Math.round(4 + 10 * s), speed: 2 + 5 * s });
      if (s > 0.35) vfx.shockwave(pos, color, 0.4 + 1.0 * s);
      for (let i = 0; i < Math.round(3 + 6 * s); i++) vfx.ember(pos, color, 0.12 + 0.2 * s, 0.4 + 0.4 * s, 1.5);
    },

    trail(pos, skill, scale = 1) {
      const color = TRAIL_COLOR[skill] ?? LINEAGE_COLOR[SKILLS[skill]?.lineage ?? 'guts'];
      vfx.ember(pos, color, 0.35 * scale, 0.45, 0.3 * scale);
    },

    reachRings(list) {
      rings.forEach((r, i) => {
        const e = list?.[i];
        r.visible = !!e;
        if (!e) return;
        r.position.set(e.x, 0.05, e.z);
        const pulse = 1 + 0.03 * Math.sin(t * 6 + i);
        r.scale.set(e.radius * pulse, e.radius * pulse, 1);
        (r.material as THREE.MeshBasicMaterial).color.setHex(LINEAGE_COLOR[SKILLS[e.skill]?.lineage ?? 'animal']);
      });
    },

    landing(point) {
      landingMark.visible = !!point;
      if (point) {
        landingMark.position.x = point.x;
        landingMark.position.z = point.z;
        landingMark.rotation.y = t * 1.2;
      }
    },

    crossing(point) {
      crossingMark.visible = !!point;
      if (point) {
        crossingMark.position.set(point.x, point.y, point.z);
        crossingMark.scale.setScalar(1 + 0.12 * Math.sin(t * 8));
      }
    },

    path(points) {
      pathLine.visible = !!points && points.length > 1;
      if (!points || points.length < 2 || points === pathKey) return;
      pathKey = points;
      const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p.x, p.y, p.z)));
      pathLine.geometry.dispose();
      pathLine.geometry = new THREE.TubeGeometry(curve, Math.min(200, points.length * 2), 0.022, 6, false);
    },

    update(dt) {
      t += dt;
      vfx.update(dt);
    },

    clear() {
      vfx.clear();
      rings.forEach((r) => (r.visible = false));
      landingMark.visible = false;
      crossingMark.visible = false;
      pathLine.visible = false;
      pathKey = null;
    },
  };
}
