/**
 * スキルの見た目（フェーズYY-73）。**そのスキルを持っている選手の体に、名前どおりの物が付く**
 * （犬なら犬の耳、歯車なら背中で回る歯車、ジェット靴なら噴射口の付いた靴、心眼なら目隠し…）。
 *
 * テストプレイ「スキルが全く作れていない」の正体は、**ほとんどの札が数字の足し引きだけで、
 * 画面のどこにも出ていなかった**こと（`テレパシー`＝打率+0.25、`鷹`＝捕球範囲+1.2m…）。
 * 誰が何を持っているかが見えないと、ビルドを組んだ手応えも、相手のビルドを読む手がかりも無い。
 *
 * ## 作り方
 *
 * - **部品は手続きで起こす**（小さな球・円柱・円環の組み合わせ。トゥーンの塗り＋輪郭線）。
 *   付く場所は体の関節（`attachToBody`）か足元（`attachToFacing`）＝**姿勢を動かせば必ず付いてくる**
 *   （バット・銃と同じ「関節の子」の考え方）。ちっちゃいモードの2.5倍にも自動で付いてくる。
 * - **1札に1つの見た目**（`LOOKS`）。**判定には一切触らない**（見た目を消してもゲームは同じ）。
 * - 回る歯車・漂う念の玉・光る輪は `onBeforeRender` で自分を動かす＝呼び出し側は何も更新しない。
 * - **着せ替えは `dressPlayer` の1本**（持っている札の並びが同じなら何もしない＝毎フレーム呼べる）。
 *
 * 位置の目安（関節ノードの原点からのメートル。`assets-src/scripts/build_player.py` の寸法）：
 * 頭＝首の付け根が原点・頭の中心 y≈0.20・帽子のてっぺん y≈0.38・顔は +Z／胴＝腰の高さが原点・
 * 胸 y≈0.40・背中 z≈-0.13・肩 y≈0.50／腰＝ベルト y≈0.07／足＝足首が原点・靴底 y≈-0.085。
 */
import * as THREE from 'three';
import type { SkillId } from '../core/skills';
import { SKILLS } from '../core/skills';
import { addOutline, createToonMaterial } from '../render/toon';
import { type BodyMount, attachToBody, attachToFacing } from './player';

// ---- 材質 ----

const toon = (color: number): THREE.Material => createToonMaterial({ color });
const metal = (): THREE.Material => createToonMaterial({ color: 0x9aa3ad });
const dark = (): THREE.Material => createToonMaterial({ color: 0x23262e });
const glow = (color: number, opacity = 0.85): THREE.Material =>
  new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

/** 部品の置き場。**付ける場所と、そこでの形**だけを持つ */
interface Part {
  mount: BodyMount | 'feetGround';
  obj: THREE.Object3D;
}

type Piece = (obj: THREE.Object3D) => THREE.Object3D;

function mesh(
  geo: THREE.BufferGeometry,
  material: THREE.Material,
  pos: [number, number, number] = [0, 0, 0],
  rot: [number, number, number] = [0, 0, 0],
  scale: [number, number, number] = [1, 1, 1],
): THREE.Mesh {
  const m = new THREE.Mesh(geo, material);
  m.position.set(...pos);
  m.rotation.set(...rot);
  m.scale.set(...scale);
  return m;
}

function group(...children: THREE.Object3D[]): THREE.Group {
  const g = new THREE.Group();
  for (const c of children) g.add(c);
  return g;
}

/** 形を持つ部品には輪郭線を付ける（光る部品には付けない） */
const outlined: Piece = (obj) => {
  addOutline(obj);
  return obj;
};

/** 自分で回る・漂う（描く直前に時計から姿勢を書く） */
function animate(obj: THREE.Object3D, fn: (o: THREE.Object3D, t: number, camera: THREE.Camera) => void): THREE.Object3D {
  let first: THREE.Mesh | null = null;
  obj.traverse((o) => {
    if (!first && (o as THREE.Mesh).isMesh) first = o as THREE.Mesh;
  });
  if (first) {
    (first as THREE.Mesh).onBeforeRender = (_r, _s, camera) => fn(obj, performance.now() / 1000, camera);
  }
  return obj;
}

const sphere = (r: number, seg = 12): THREE.BufferGeometry => new THREE.SphereGeometry(r, seg, Math.max(6, seg - 4));
const cyl = (rt: number, rb: number, h: number, seg = 12): THREE.BufferGeometry =>
  new THREE.CylinderGeometry(rt, rb, h, seg);
const torus = (r: number, tube: number, seg = 24): THREE.BufferGeometry => new THREE.TorusGeometry(r, tube, 8, seg);
const cone = (r: number, h: number, seg = 10): THREE.BufferGeometry => new THREE.ConeGeometry(r, h, seg);
const box = (x: number, y: number, z: number): THREE.BufferGeometry => new THREE.BoxGeometry(x, y, z);

const parentQuat = new THREE.Quaternion();
/** 文字盤のように「正面を見せたい」物をカメラへ向ける（でっかいモードの打者は横向きに映るので、体の向きのままだと真横から見えて読めない） */
function faceCamera(o: THREE.Object3D, camera: THREE.Camera): void {
  if (!o.parent) return;
  o.parent.getWorldQuaternion(parentQuat);
  o.quaternion.copy(parentQuat.invert().multiply(camera.quaternion));
}

// ---- 頭まわり ----

/** 鉢巻き・はちまき（額の高さの輪＋後ろの結び目） */
function headband(color: number, tails = true): Part {
  const band = mesh(torus(0.128, 0.018), toon(color), [0, 0.25, 0.005], [Math.PI / 2, 0, 0], [1, 1.08, 1]);
  const parts: THREE.Object3D[] = [band];
  if (tails) {
    parts.push(mesh(box(0.03, 0.09, 0.012), toon(color), [0.03, 0.2, -0.145], [0.3, 0, 0.35]));
    parts.push(mesh(box(0.03, 0.09, 0.012), toon(color), [-0.03, 0.2, -0.145], [0.3, 0, -0.35]));
  }
  return { mount: 'head', obj: outlined(group(...parts)) };
}

/** 耳（帽子の上に2つ） */
function ears(kind: 'dog' | 'cat' | 'rabbit' | 'bear' | 'wolf', color: number): Part {
  const inner = 0xf0b0b0;
  const make = (sx: number): THREE.Object3D => {
    switch (kind) {
      case 'rabbit':
        return group(
          mesh(sphere(0.035), toon(color), [sx * 0.05, 0.47, -0.01], [0, 0, sx * -0.12], [1, 3.2, 0.55]),
          mesh(sphere(0.02), toon(inner), [sx * 0.05, 0.47, 0.012], [0, 0, sx * -0.12], [1, 2.8, 0.3]),
        );
      case 'bear':
        return mesh(sphere(0.045), toon(color), [sx * 0.1, 0.37, -0.01], [0, 0, 0], [1, 1, 0.6]);
      case 'dog':
        return mesh(sphere(0.04), toon(color), [sx * 0.13, 0.3, -0.01], [0, 0, sx * 0.5], [0.7, 1.8, 0.4]);
      case 'cat':
      case 'wolf':
        return group(
          mesh(cone(0.045, 0.1, 4), toon(color), [sx * 0.08, 0.41, -0.01], [0, Math.PI / 4, sx * -0.25], [1, 1, 0.5]),
          mesh(cone(0.025, 0.06, 4), toon(inner), [sx * 0.08, 0.4, 0.005], [0, Math.PI / 4, sx * -0.25], [1, 1, 0.3]),
        );
    }
  };
  return { mount: 'head', obj: outlined(group(make(1), make(-1))) };
}

/** 目のまわり（サングラス・目隠し・眼鏡・光る目覚まし） */
function eyewear(kind: 'shades' | 'blindfold' | 'glasses' | 'visor'): Part {
  switch (kind) {
    case 'shades':
      return {
        mount: 'head',
        obj: outlined(
          group(
            mesh(box(0.07, 0.035, 0.02), dark(), [0.045, 0.215, 0.13]),
            mesh(box(0.07, 0.035, 0.02), dark(), [-0.045, 0.215, 0.13]),
            mesh(box(0.03, 0.01, 0.01), dark(), [0, 0.225, 0.135]),
          ),
        ),
      };
    case 'blindfold':
      return {
        mount: 'head',
        obj: outlined(group(mesh(torus(0.13, 0.024), toon(0x202020), [0, 0.215, 0.005], [Math.PI / 2, 0, 0], [1, 1.06, 1]))),
      };
    case 'glasses':
      return {
        mount: 'head',
        obj: group(
          mesh(torus(0.03, 0.006), dark(), [0.045, 0.215, 0.135]),
          mesh(torus(0.03, 0.006), dark(), [-0.045, 0.215, 0.135]),
        ),
      };
    case 'visor':
      return {
        mount: 'head',
        obj: animate(
          group(mesh(box(0.17, 0.035, 0.03), glow(0x7fe8ff, 0.9), [0, 0.215, 0.13])),
          (o, t) => {
            o.children[0].scale.x = 1 + 0.08 * Math.sin(t * 6);
          },
        ),
      };
  }
}

/** 額に付く物（鉄板・光る第三の目・根性の日の丸） */
function forehead(kind: 'plate' | 'eye' | 'sun', big = false): Part {
  switch (kind) {
    case 'plate':
      return {
        mount: 'head',
        obj: outlined(group(mesh(torus(0.128, 0.018), toon(0xeeeeee), [0, 0.25, 0.005], [Math.PI / 2, 0, 0], [1, 1.08, 1]), mesh(box(0.15, 0.065, 0.025), metal(), [0, 0.25, 0.14]))),
      };
    case 'eye':
      return {
        mount: 'head',
        obj: animate(group(mesh(sphere(big ? 0.028 : 0.02), glow(0xd07aff), [0, 0.265, 0.13], [0, 0, 0], [1, 0.6, 0.5])), (o, t) => {
          const k = 1 + 0.25 * Math.sin(t * 5);
          o.children[0].scale.set(k, 0.6 * k, 0.5);
        }),
      };
    case 'sun':
      return {
        mount: 'head',
        obj: outlined(group(mesh(torus(0.128, 0.018), toon(0xffffff), [0, 0.25, 0.005], [Math.PI / 2, 0, 0], [1, 1.08, 1]), mesh(cyl(0.022, 0.022, 0.01), toon(0xd8202a), [0, 0.25, 0.138], [Math.PI / 2, 0, 0]))),
      };
  }
}

/** 頭の上に乗る物（輪・王冠・羽・炎のとさか・たてがみ…） */
function crownPiece(kind: 'halo' | 'crown' | 'feather' | 'phoenix' | 'mane' | 'ballStalk' | 'antenna' | 'fireHelmet' | 'ironHelmet' | 'bikeHelmet'): Part {
  switch (kind) {
    case 'halo':
      return {
        mount: 'head',
        obj: animate(group(mesh(torus(0.11, 0.012), glow(0xfff2a0), [0, 0.47, 0], [Math.PI / 2, 0, 0])), (o, t) => {
          o.children[0].position.y = 0.47 + 0.012 * Math.sin(t * 2.4);
        }),
      };
    case 'crown': {
      const gold = toon(0xffc83a);
      const spikes = [0, 1, 2, 3, 4].map((i) => {
        const a = (i / 5) * Math.PI * 2;
        return mesh(cone(0.022, 0.06, 4), gold, [Math.sin(a) * 0.085, 0.43, Math.cos(a) * 0.085]);
      });
      return { mount: 'head', obj: outlined(group(mesh(cyl(0.09, 0.09, 0.04, 16), gold, [0, 0.39, 0]), ...spikes)) };
    }
    case 'feather':
      return {
        mount: 'head',
        obj: outlined(group(mesh(sphere(0.03), toon(0x8a5a30), [0.1, 0.36, -0.03], [0.3, 0, -0.5], [0.6, 3.2, 0.25]), mesh(sphere(0.018), toon(0xf4eee0), [0.14, 0.44, -0.05], [0.3, 0, -0.5], [0.6, 1.6, 0.25]))),
      };
    case 'phoenix': {
      const flames = [-1, 0, 1].map((i) =>
        mesh(cone(0.035, 0.16 - Math.abs(i) * 0.04, 6), glow(i === 0 ? 0xffd040 : 0xff6a20, 0.9), [i * 0.045, 0.45 - Math.abs(i) * 0.02, -0.02 - Math.abs(i) * 0.01], [-0.2, 0, i * -0.35]),
      );
      return {
        mount: 'head',
        obj: animate(group(...flames), (o, t) => {
          o.children.forEach((c, i) => {
            c.scale.y = 1 + 0.2 * Math.sin(t * 9 + i * 1.7);
          });
        }),
      };
    }
    case 'mane': {
      const tufts: THREE.Object3D[] = [];
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        if (Math.cos(a) > 0.55) continue; // 顔の前は開ける
        tufts.push(mesh(cone(0.05, 0.14, 5), toon(0xc0782a), [Math.sin(a) * 0.14, 0.24, Math.cos(a) * 0.14], [Math.cos(a) * 1.3, 0, -Math.sin(a) * 1.3]));
      }
      return { mount: 'head', obj: outlined(group(...tufts)) };
    }
    case 'ballStalk':
      return {
        mount: 'head',
        obj: outlined(group(mesh(cyl(0.006, 0.006, 0.12), dark(), [0, 0.44, 0]), mesh(sphere(0.04), toon(0xf8f8f0), [0, 0.52, 0]), mesh(torus(0.04, 0.004), toon(0xd8202a), [0, 0.52, 0], [0, Math.PI / 2, 0.4]))),
      };
    case 'antenna':
      return {
        mount: 'head',
        obj: animate(
          group(
            mesh(cyl(0.005, 0.005, 0.14), dark(), [0.06, 0.44, 0], [0, 0, -0.35]),
            mesh(cyl(0.005, 0.005, 0.14), dark(), [-0.06, 0.44, 0], [0, 0, 0.35]),
            mesh(sphere(0.022), glow(0xd07aff), [0.085, 0.51, 0]),
            mesh(sphere(0.022), glow(0xd07aff), [-0.085, 0.51, 0]),
          ),
          (o, t) => {
            const k = 1 + 0.3 * Math.sin(t * 8);
            o.children[2].scale.setScalar(k);
            o.children[3].scale.setScalar(2 - k);
          },
        ),
      };
    case 'fireHelmet':
      return {
        mount: 'head',
        obj: outlined(group(mesh(sphere(0.15, 16), toon(0xd8302a), [0, 0.3, -0.005], [0, 0, 0], [1, 0.72, 1.12]), mesh(cyl(0.2, 0.2, 0.012, 20), toon(0xd8302a), [0, 0.26, -0.03], [0, 0, 0], [1, 1, 1.15]), mesh(box(0.07, 0.08, 0.012), toon(0xffc83a), [0, 0.35, 0.14], [-0.3, 0, 0]))),
      };
    case 'ironHelmet':
      return {
        mount: 'head',
        obj: outlined(group(mesh(sphere(0.15, 16), metal(), [0, 0.3, 0], [0, 0, 0], [1, 0.8, 1.05]), mesh(box(0.2, 0.02, 0.02), dark(), [0, 0.28, 0.15]))),
      };
    case 'bikeHelmet':
      return {
        mount: 'head',
        obj: outlined(group(mesh(sphere(0.16, 16), toon(0xf0f0f0), [0, 0.28, -0.01], [0, 0, 0], [1, 0.95, 1.08]), mesh(box(0.2, 0.06, 0.02), glow(0x60c0ff, 0.6), [0, 0.22, 0.15]), mesh(box(0.04, 0.2, 0.3), toon(0xd8302a), [0, 0.32, -0.01]))),
      };
  }
}

/** 顔の前（猪の牙） */
function tusks(): Part {
  return {
    mount: 'head',
    obj: outlined(group(mesh(cone(0.012, 0.07, 6), toon(0xf6f0dc), [0.04, 0.16, 0.12], [0.4, 0, 0.3]), mesh(cone(0.012, 0.07, 6), toon(0xf6f0dc), [-0.04, 0.16, 0.12], [0.4, 0, -0.3]))),
  };
}

/** 頭のまわりを回る・漂う物（念の玉・思念の波・霊・時計・スプーン・照準・∞） */
function floater(kind: 'orb' | 'orbs2' | 'waves' | 'wisp' | 'clock' | 'spoons' | 'crosshair' | 'infinity', color = 0xc07aff): Part {
  switch (kind) {
    case 'orb':
      return {
        mount: 'torso',
        obj: animate(group(mesh(sphere(0.045), glow(color)), mesh(sphere(0.07), glow(color, 0.3))), (o, t) => {
          o.position.set(0.3 * Math.cos(t * 1.7), 0.62 + 0.05 * Math.sin(t * 3), 0.3 * Math.sin(t * 1.7));
        }),
      };
    case 'orbs2':
      return {
        mount: 'torso',
        obj: animate(group(mesh(sphere(0.035), glow(color)), mesh(sphere(0.035), glow(0x7fe8ff))), (o, t) => {
          o.position.set(0, 0.6, 0);
          o.children[0].position.set(0.28 * Math.cos(t * 2.2), 0.04 * Math.sin(t * 4), 0.28 * Math.sin(t * 2.2));
          o.children[1].position.set(-0.28 * Math.cos(t * 2.2), -0.04 * Math.sin(t * 4), -0.28 * Math.sin(t * 2.2));
        }),
      };
    case 'waves':
      return {
        mount: 'head',
        obj: animate(group(mesh(torus(0.18, 0.006), glow(color, 0.6), [0, 0.22, 0], [Math.PI / 2, 0, 0]), mesh(torus(0.18, 0.006), glow(color, 0.6), [0, 0.22, 0], [Math.PI / 2, 0, 0])), (o, t) => {
          o.children.forEach((c, i) => {
            const k = ((t * 0.9 + i * 0.5) % 1);
            c.scale.setScalar(0.8 + k * 0.8);
            ((c as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - k);
          });
        }),
      };
    case 'wisp':
      return {
        mount: 'torso',
        obj: animate(group(mesh(sphere(0.05), glow(0xe8f4ff, 0.75)), mesh(cone(0.04, 0.12, 8), glow(0xe8f4ff, 0.45), [0, -0.08, -0.03], [Math.PI + 0.4, 0, 0])), (o, t) => {
          o.position.set(-0.3 + 0.03 * Math.sin(t * 2), 0.66 + 0.06 * Math.sin(t * 1.4), -0.1);
        }),
      };
    case 'clock': {
      const face = mesh(cyl(0.1, 0.1, 0.02, 20), toon(0xf6f0dc), [0, 0, 0], [Math.PI / 2, 0, 0]);
      const rim = mesh(torus(0.1, 0.014), toon(0xc8a040));
      const hand = mesh(box(0.012, 0.08, 0.006), dark(), [0, 0.035, 0.014]);
      const hand2 = mesh(box(0.012, 0.055, 0.006), dark(), [0, 0.025, 0.015]);
      return {
        mount: 'torso',
        obj: animate(outlined(group(face, rim, hand, hand2)), (o, t, camera) => {
          // 頭の真上に浮かべ、文字盤をカメラへ向ける（体の横に置くと頭の陰に隠れた＝実機で確かめた）
          o.position.set(0, 0.98 + 0.04 * Math.sin(t * 1.3), 0);
          faceCamera(o, camera);
          // 秒針は止まったり動いたりする（時間が止まる）
          const tick = Math.floor(t) + Math.min(1, (t % 1) * 6);
          hand.rotation.z = -tick * 0.5;
          hand.position.set(Math.sin(tick * 0.5) * 0.035, Math.cos(tick * 0.5) * 0.035, 0.014);
        }),
      };
    }
    case 'spoons': {
      const spoon = (): THREE.Object3D =>
        group(mesh(cyl(0.01, 0.01, 0.14), metal(), [0, 0, 0], [0, 0, 0.5]), mesh(sphere(0.032), metal(), [0.05, 0.075, 0], [0, 0, 0], [0.7, 1.1, 0.4]));
      const a = spoon();
      const b = spoon();
      return {
        mount: 'torso',
        obj: animate(group(a, b), (o, t) => {
          o.position.set(0, 0.6, 0);
          a.position.set(0.3 * Math.cos(t * 1.9), 0, 0.3 * Math.sin(t * 1.9));
          b.position.set(-0.3 * Math.cos(t * 1.9), 0.05, -0.3 * Math.sin(t * 1.9));
          a.rotation.z = t * 3;
          b.rotation.z = -t * 3;
        }),
      };
    }
    case 'crosshair':
      return {
        mount: 'handR',
        obj: animate(group(mesh(torus(0.05, 0.006), glow(0xff5050)), mesh(box(0.13, 0.006, 0.006), glow(0xff5050)), mesh(box(0.006, 0.13, 0.006), glow(0xff5050))), (o, t) => {
          o.position.set(0, -0.12, 0.05);
          o.rotation.z = t * 1.5;
        }),
      };
    case 'infinity': {
      const curve = new THREE.CatmullRomCurve3(
        Array.from({ length: 24 }, (_, i) => {
          const a = (i / 24) * Math.PI * 2;
          const d = 1 + Math.sin(a) ** 2;
          return new THREE.Vector3((0.2 * Math.cos(a)) / d, 0, (0.2 * Math.sin(a) * Math.cos(a)) / d);
        }),
        true,
      );
      return {
        mount: 'torso',
        obj: animate(group(mesh(new THREE.TubeGeometry(curve, 48, 0.02, 6, true), glow(0xc07aff))), (o, t) => {
          o.position.set(0, 0.8, 0);
          o.rotation.set(Math.PI / 2, t * 1.2, 0);
        }),
      };
    }
  }
}

// ---- 首・胴・背中 ----

/** 首に掛ける物（数珠・金の鎖・手ぬぐい） */
function neck(kind: 'beads' | 'chain' | 'towel'): Part {
  switch (kind) {
    case 'beads': {
      const beads: THREE.Object3D[] = [];
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        beads.push(mesh(sphere(0.016, 8), toon(i === 0 ? 0xd07a30 : 0x5a2e18), [Math.sin(a) * 0.12, 0.5 - (Math.cos(a) > 0 ? Math.cos(a) * 0.08 : 0), Math.cos(a) * 0.1]));
      }
      return { mount: 'torso', obj: group(...beads) };
    }
    case 'chain':
      return { mount: 'torso', obj: mesh(torus(0.12, 0.012), toon(0xffc83a), [0, 0.5, 0.015], [Math.PI / 2 + 0.35, 0, 0], [1, 0.85, 1]) };
    case 'towel':
      return {
        mount: 'torso',
        obj: outlined(group(mesh(torus(0.12, 0.028), toon(0xf6f6f6), [0, 0.53, -0.01], [Math.PI / 2 + 0.2, 0, 0], [1, 0.85, 1]), mesh(box(0.06, 0.18, 0.02), toon(0xf6f6f6), [0.09, 0.42, 0.11], [0.1, 0, 0.1]))),
      };
  }
}

/** 背中に背負う物 */
function back(kind: 'gear' | 'tank' | 'board' | 'turbo' | 'nitro' | 'rocket' | 'shell' | 'wings' | 'bigWings' | 'bat' | 'flameBat' | 'cape' | 'flameWings'): Part {
  switch (kind) {
    case 'gear': {
      const teeth: THREE.Object3D[] = [];
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        teeth.push(mesh(box(0.035, 0.04, 0.03), metal(), [Math.cos(a) * 0.12, Math.sin(a) * 0.12, 0], [0, 0, a]));
      }
      const wheel = group(mesh(torus(0.1, 0.022), metal()), mesh(cyl(0.03, 0.03, 0.04), dark(), [0, 0, 0], [Math.PI / 2, 0, 0]), ...teeth);
      wheel.position.set(0, 0.42, -0.17);
      return { mount: 'torso', obj: animate(outlined(wheel), (o, t) => (o.rotation.z = t * 2)) };
    }
    case 'tank':
      return {
        mount: 'torso',
        obj: outlined(group(mesh(cyl(0.06, 0.06, 0.24, 14), toon(0x3a8ad8), [0.06, 0.4, -0.17]), mesh(sphere(0.06), toon(0x3a8ad8), [0.06, 0.52, -0.17]), mesh(sphere(0.06), toon(0x3a8ad8), [0.06, 0.28, -0.17]), mesh(cyl(0.015, 0.015, 0.05), metal(), [0.06, 0.58, -0.17]))),
      };
    case 'board':
      return {
        mount: 'torso',
        obj: outlined(group(mesh(box(0.2, 0.62, 0.025), toon(0xf07a20), [0, 0.38, -0.165], [0, 0, 0.35]), ...[-1, 1].flatMap((s) => [-1, 1].map((u) => mesh(cyl(0.025, 0.025, 0.03, 10), toon(0xf0f0e0), [s * 0.07 + u * 0.1, 0.38 + u * 0.24, -0.19], [0, 0, Math.PI / 2 + 0.35]))))),
      };
    case 'turbo':
      return {
        mount: 'torso',
        obj: outlined(group(mesh(cyl(0.028, 0.035, 0.22), metal(), [0.08, 0.34, -0.16], [-0.3, 0, 0]), mesh(cyl(0.028, 0.035, 0.22), metal(), [-0.08, 0.34, -0.16], [-0.3, 0, 0]))),
      };
    case 'nitro':
      return {
        mount: 'torso',
        obj: outlined(group(mesh(cyl(0.045, 0.045, 0.22, 12), toon(0x2ac06a), [-0.07, 0.4, -0.16], [0, 0, 0.2]), mesh(cyl(0.02, 0.03, 0.05), metal(), [-0.095, 0.53, -0.16], [0, 0, 0.2]))),
      };
    case 'rocket':
      return {
        mount: 'torso',
        obj: outlined(group(...[-1, 1].flatMap((s) => [mesh(cyl(0.05, 0.05, 0.26, 12), toon(0xe8e8f0), [s * 0.08, 0.4, -0.17]), mesh(cone(0.05, 0.08, 12), toon(0xd8302a), [s * 0.08, 0.57, -0.17]), mesh(cyl(0.04, 0.055, 0.05, 12), dark(), [s * 0.08, 0.25, -0.17])]))),
      };
    case 'shell': {
      const s = mesh(sphere(0.2, 14), toon(0x4a8a3a), [0, 0.38, -0.14], [0, 0, 0], [1, 1.1, 0.55]);
      const rim = mesh(torus(0.19, 0.02), toon(0xc8b070), [0, 0.38, -0.12], [0, 0, 0], [1, 1.1, 1]);
      return { mount: 'torso', obj: outlined(group(s, rim)) };
    }
    case 'wings':
    case 'bigWings':
    case 'flameWings': {
      const span = kind === 'wings' ? 1 : 1.5;
      const mat = kind === 'flameWings' ? glow(0xff7a20, 0.8) : toon(kind === 'wings' ? 0x8a5a30 : 0x6a4a2a);
      const wing = (sx: number): THREE.Mesh =>
        mesh(sphere(0.12, 10), mat, [sx * 0.2 * span, 0.46, -0.16], [0, sx * 0.4, sx * -0.6], [1.6 * span, 0.5, 0.12]);
      const obj = group(wing(1), wing(-1));
      return {
        mount: 'torso',
        obj: animate(kind === 'flameWings' ? obj : outlined(obj), (o, t) => {
          const flap = 0.15 * Math.sin(t * (kind === 'flameWings' ? 7 : 4));
          o.children[0].rotation.z = -0.6 + flap;
          o.children[1].rotation.z = 0.6 - flap;
        }),
      };
    }
    case 'bat':
    case 'flameBat': {
      const bat = group(mesh(cyl(0.035, 0.018, 0.75, 10), toon(0xc89a5a), [0, 0, 0]));
      if (kind === 'bat') {
        for (let i = 0; i < 5; i++) bat.add(mesh(cone(0.012, 0.04, 5), metal(), [0.03, 0.12 + i * 0.05, 0], [0, 0, -Math.PI / 2]));
      }
      bat.position.set(0.05, 0.4, -0.17);
      bat.rotation.set(0, 0, 0.7);
      const obj = outlined(bat);
      if (kind === 'flameBat') {
        const flame = mesh(cone(0.05, 0.25, 8), glow(0xff6a20), [0, 0.45, 0]);
        bat.add(flame);
        return { mount: 'torso', obj: animate(obj, (_o, t) => (flame.scale.y = 1 + 0.25 * Math.sin(t * 12))) };
      }
      return { mount: 'torso', obj };
    }
    case 'cape':
      return {
        mount: 'torso',
        obj: animate(outlined(group(mesh(box(0.42, 0.55, 0.02), toon(0x4a2a6a), [0, 0.28, -0.16], [0.12, 0, 0]))), (o, t) => {
          o.children[0].rotation.x = 0.12 + 0.05 * Math.sin(t * 2.2);
        }),
      };
  }
}

/** 胴の前（鋼の胸板・動力炉・弾帯） */
function chest(kind: 'plate' | 'reactor' | 'bandolier'): Part {
  switch (kind) {
    case 'plate':
      return { mount: 'torso', obj: outlined(group(mesh(sphere(0.17, 14), metal(), [0, 0.4, 0.06], [0, 0, 0], [1.15, 1, 0.55]))) };
    case 'reactor':
      return {
        mount: 'torso',
        obj: animate(group(mesh(torus(0.075, 0.018), metal(), [0, 0.4, 0.13]), mesh(sphere(0.058), glow(0x7fe8ff), [0, 0.4, 0.13])), (o, t) => {
          o.children[1].scale.setScalar(1 + 0.2 * Math.sin(t * 6));
        }),
      };
    case 'bandolier': {
      const belt = mesh(torus(0.2, 0.02), toon(0x6a4a2a), [0, 0.35, 0], [Math.PI / 2, 0.75, 0], [1, 0.72, 1]);
      const bullets = [0, 1, 2, 3, 4].map((i) => mesh(cyl(0.01, 0.01, 0.045, 6), toon(0xd8b040), [-0.12 + i * 0.06, 0.28 + i * 0.05, 0.13], [0, 0, 0.75]));
      return { mount: 'torso', obj: outlined(group(belt, ...bullets)) };
    }
  }
}

/** 腰まわり（帯・まわし・ジャイロの輪・ホルスター・しっぽ） */
function waist(kind: 'blackBelt' | 'mawashi' | 'gyro' | 'holster' | 'tail', color = 0x202020, tail?: 'monkey' | 'cat' | 'horse' | 'cheetah' | 'fox'): Part {
  switch (kind) {
    case 'blackBelt':
      return {
        mount: 'pelvis',
        obj: outlined(group(mesh(torus(0.155, 0.02), toon(0x202020), [0, 0.08, 0], [Math.PI / 2, 0, 0], [1, 0.72, 1]), mesh(box(0.03, 0.12, 0.012), toon(0x202020), [0.04, 0.02, 0.115], [0, 0, 0.3]), mesh(box(0.03, 0.12, 0.012), toon(0x202020), [-0.04, 0.02, 0.115], [0, 0, -0.3]))),
      };
    case 'mawashi':
      return {
        mount: 'pelvis',
        obj: outlined(group(mesh(torus(0.16, 0.05), toon(0x3a3a8a), [0, 0.04, 0], [Math.PI / 2, 0, 0], [1, 0.72, 1]), mesh(box(0.14, 0.1, 0.02), toon(0x3a3a8a), [0, -0.05, 0.11]))),
      };
    case 'gyro':
      return {
        mount: 'pelvis',
        obj: animate(group(mesh(torus(0.26, 0.01), glow(0x7fe8ff)), mesh(torus(0.26, 0.01), glow(0x7fe8ff))), (o, t) => {
          o.position.set(0, 0.1, 0);
          o.children[0].rotation.set(Math.PI / 2 + 0.4 * Math.sin(t * 3), t * 2, 0);
          o.children[1].rotation.set(Math.PI / 2 + 0.4 * Math.cos(t * 3), -t * 2, 0.6);
        }),
      };
    case 'holster':
      return {
        mount: 'pelvis',
        obj: outlined(group(mesh(box(0.08, 0.17, 0.11), toon(0x5a3a1a), [0.19, -0.03, 0]), mesh(box(0.045, 0.08, 0.04), dark(), [0.19, 0.09, -0.015]))),
      };
    case 'tail': {
      const points: THREE.Vector3[] =
        tail === 'monkey'
          ? [new THREE.Vector3(0, 0, -0.12), new THREE.Vector3(0, -0.12, -0.3), new THREE.Vector3(0, 0.05, -0.45), new THREE.Vector3(0, 0.2, -0.38)]
          : tail === 'cat'
            ? [new THREE.Vector3(0, 0, -0.12), new THREE.Vector3(0, 0.05, -0.28), new THREE.Vector3(0, 0.25, -0.34)]
            : [new THREE.Vector3(0, 0, -0.12), new THREE.Vector3(0, -0.12, -0.25), new THREE.Vector3(0, -0.3, -0.3)];
      const thick = tail === 'horse' || tail === 'fox' ? 0.05 : 0.02;
      const tube = mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 16, thick, 8), toon(color));
      const parts: THREE.Object3D[] = [tube];
      if (tail === 'cheetah') {
        for (let i = 1; i < 4; i++) parts.push(mesh(torus(0.022, 0.006), dark(), points[Math.min(i, points.length - 1)].clone().lerp(points[Math.max(0, i - 1)], 0.5).toArray() as [number, number, number], [0.8, 0, 0]));
      }
      if (tail === 'fox') parts.push(mesh(sphere(0.045), toon(0xffffff), points[points.length - 1].toArray() as [number, number, number]));
      return {
        mount: 'pelvis',
        obj: animate(outlined(group(...parts)), (o, t) => {
          o.rotation.y = 0.25 * Math.sin(t * (tail === 'cat' ? 2.5 : 4));
        }),
      };
    }
  }
}

// ---- 腕・手 ----

/** 腕と手（鉄の籠手・グローブ・気の手・鉤爪・腕輪） */
function arms(kind: 'gauntlets' | 'gloves' | 'aura' | 'claws' | 'armbands' | 'wristbands' | 'ironArm', color = 0xd8302a): Part[] {
  const both = (build: (s: 1 | -1) => THREE.Object3D, mounts: [BodyMount, BodyMount]): Part[] => [
    { mount: mounts[0], obj: build(1) },
    { mount: mounts[1], obj: build(-1) },
  ];
  switch (kind) {
    case 'gauntlets':
      return both(() => outlined(group(mesh(cyl(0.06, 0.055, 0.18, 10), metal(), [0, 0.08, 0]), mesh(sphere(0.055), metal(), [0, -0.03, 0], [0, 0, 0], [1, 0.9, 1.1]))), ['handR', 'handL']);
    case 'gloves':
      return both(() => outlined(group(mesh(sphere(0.055), toon(color), [0, -0.035, 0.01], [0, 0, 0], [1, 1.1, 1.15]))), ['handR', 'handL']);
    case 'aura':
      return both(
        () =>
          animate(group(mesh(sphere(0.07), glow(color, 0.55), [0, -0.04, 0])), (o, t) => {
            o.children[0].scale.setScalar(1 + 0.2 * Math.sin(t * 7));
          }),
        ['handR', 'handL'],
      );
    case 'claws':
      return both(
        () => outlined(group(...[-1, 0, 1].map((i) => mesh(cone(0.012, 0.06, 5), toon(0xf6f0dc), [i * 0.02, -0.1, 0.02], [0.3, 0, 0])))),
        ['handR', 'handL'],
      );
    case 'armbands':
      return both(() => mesh(torus(0.062, 0.022), toon(color), [0, -0.1, 0], [Math.PI / 2, 0, 0]), ['armUpperR', 'armUpperL']);
    case 'wristbands':
      return both(() => mesh(torus(0.05, 0.022), toon(color), [0, 0.02, 0], [Math.PI / 2, 0, 0]), ['handR', 'handL']);
    case 'ironArm':
      return [{ mount: 'armUpperR', obj: outlined(group(mesh(cyl(0.065, 0.06, 0.26, 10), metal(), [0, -0.13, 0]), mesh(sphere(0.07), metal(), [0, 0, 0]))) }];
  }
}

// ---- 足 ----

/** 足に付く物（ジェット靴・バネ・キャタピラ・下駄・脚絆・ロケットブーツ・蹴り当て） */
function feet(kind: 'jet' | 'spring' | 'treads' | 'geta' | 'rocketGeta' | 'warmers' | 'rocketBoots' | 'kickPads'): Part[] {
  const both = (build: () => THREE.Object3D): Part[] => [
    { mount: 'footR', obj: build() },
    { mount: 'footL', obj: build() },
  ];
  switch (kind) {
    case 'jet':
      return both(() =>
        animate(group(outlined(mesh(cyl(0.05, 0.062, 0.11, 10), metal(), [0, -0.01, -0.1], [Math.PI / 2 - 0.4, 0, 0])), mesh(cone(0.05, 0.16, 8), glow(0x60c8ff), [0, -0.05, -0.2], [-Math.PI / 2 - 0.4, 0, 0])), (o, t) => {
          o.children[1].scale.y = 0.7 + 0.4 * Math.abs(Math.sin(t * 20));
        }),
      );
    case 'rocketBoots':
      return both(() =>
        animate(group(outlined(mesh(cyl(0.05, 0.06, 0.1, 10), toon(0xd8302a), [0, 0.02, -0.08], [Math.PI / 2 - 0.3, 0, 0])), mesh(cone(0.045, 0.14, 8), glow(0xffa030), [0, -0.02, -0.17], [-Math.PI / 2 - 0.3, 0, 0])), (o, t) => {
          o.children[1].scale.y = 0.7 + 0.5 * Math.abs(Math.sin(t * 18));
        }),
      );
    case 'spring': {
      // 足首に巻いたばね（靴底の下に付けると地面に埋まって見えない＝実機で確かめた）
      const helix = new THREE.CatmullRomCurve3(
        Array.from({ length: 36 }, (_, i) => new THREE.Vector3(0.075 * Math.cos(i * 0.9), -0.05 + i * 0.006, 0.075 * Math.sin(i * 0.9))),
      );
      return both(() => outlined(group(mesh(new THREE.TubeGeometry(helix, 72, 0.013, 6), metal()))));
    }
    case 'treads':
      return both(() => outlined(group(mesh(box(0.13, 0.05, 0.3), dark(), [0, -0.06, 0.03]), ...[0, 1, 2, 3, 4].map((i) => mesh(box(0.14, 0.012, 0.02), metal(), [0, -0.035, -0.09 + i * 0.06])))));
    case 'geta':
    case 'rocketGeta': {
      const m = kind === 'geta' ? metal() : toon(0xd8302a);
      return both(() => {
        const g = group(mesh(box(0.12, 0.025, 0.28), m, [0, -0.1, 0.03]), mesh(box(0.11, 0.05, 0.03), m, [0, -0.135, 0.11]), mesh(box(0.11, 0.05, 0.03), m, [0, -0.135, -0.05]));
        if (kind === 'rocketGeta') g.add(mesh(cone(0.03, 0.09, 8), glow(0xffa030), [0, -0.12, -0.2], [-Math.PI / 2, 0, 0]));
        return outlined(g);
      });
    }
    case 'warmers':
      return both(() => mesh(cyl(0.065, 0.06, 0.14, 10), toon(0xe04a8a), [0, 0.12, 0]));
    case 'kickPads':
      return both(() => outlined(group(mesh(cyl(0.07, 0.065, 0.12, 10), toon(0xf6f6f6), [0, 0.13, 0.01]))));
  }
}

/** 足元（向きのノード＝姿勢に引きずられない地面側。ホバーの円盤） */
function hoverDisc(): Part {
  return {
    mount: 'feetGround',
    obj: animate(group(mesh(cyl(0.3, 0.3, 0.02, 24), glow(0x60c8ff, 0.45), [0, 0.03, 0]), mesh(torus(0.3, 0.012, 32), glow(0x9fe8ff), [0, 0.04, 0], [Math.PI / 2, 0, 0])), (o, t) => {
      o.children[1].scale.setScalar(1 + 0.08 * Math.sin(t * 5));
    }),
  };
}

// ---- 札ごとの見た目（全札） ----

/**
 * **1札に1つの見た目**。名前から連想できる物を選び、系統ごとの持ち味（暴力＝鉢巻き・籠手、
 * メカ＝機械、超能力＝光って漂う物、動物＝耳・しっぽ・羽、根性＝汗と気合）を揃える。
 * 強化デュオ（チャージを増やすだけの札）は前提の見た目を光らせた版を付ける。
 */
const LOOKS: Record<SkillId, () => Part[]> = {
  // ---- 暴力 ----
  kenkappayai: () => [headband(0xd8302a)],
  tekko: () => arms('gauntlets'),
  zutsuki: () => [forehead('plate')],
  karate: () => [waist('blackBelt'), headband(0xf6f6f6, false)],
  dosukoi: () => [waist('mawashi')],
  shoryuken: () => [...arms('gloves', 0xd8302a), headband(0xd8302a)],
  hadouken: () => arms('aura', 0x6fc8ff),
  doroppukikku: () => feet('kickPads'),
  abareguse: () => [headband(0x202020), ...arms('wristbands', 0x202020)],
  haganenokarada: () => [chest('plate')],
  ikaku: () => [eyewear('shades')],
  tetsugeta: () => feet('geta'),
  bukimochikomi: () => [back('bat')],
  oyabun: () => [back('cape'), neck('chain')],
  battoshoryuken: () => [back('flameBat'), ...arms('gloves', 0xff7a20)],
  shinkuhadouken: () => [...arms('aura', 0x3f7dff), headband(0x3f7dff)],
  rokettogeta: () => feet('rocketGeta'),
  roketokikku: () => feet('rocketBoots'),
  // ---- メカ ----
  sukebo: () => [back('board')],
  haguruma: () => [back('gear')],
  kyatapira: () => feet('treads'),
  yobitanku: () => [back('tank')],
  bane: () => feet('spring'),
  jettogutsu: () => feet('jet'),
  tabo: () => [back('turbo')],
  hoba: () => [hoverDisc()],
  douryokuro: () => [chest('reactor')],
  jairo: () => [waist('gyro')],
  yobiju: () => [waist('holster')],
  nitoro: () => [back('nitro')],
  ju: () => [waist('holster'), eyewear('shades')],
  baiku: () => [crownPiece('bikeHelmet')],
  homingudan: () => [chest('bandolier')],
  renshaju: () => [chest('bandolier'), waist('holster')],
  rokettoenjin: () => [back('rocket')],
  tabosukebo: () => [back('board'), ...feet('jet')],
  // ---- 超能力 ----
  yochi: () => [forehead('eye')],
  nenriki: () => [floater('orb')],
  shinenha: () => [floater('waves')],
  reikan: () => [floater('wisp')],
  nendouriki: () => [floater('orbs2')],
  terepashi: () => [crownPiece('antenna')],
  saikopawa: () => [floater('orbs2', 0xff7af0), floater('waves', 0xff7af0)],
  jikanteishi: () => [floater('clock')],
  miraishi: () => [eyewear('visor')],
  sainendou: () => [floater('spoons')],
  shinenseigyo: () => [floater('crosshair')],
  zazen: () => [neck('beads')],
  zettaiyochi: () => [forehead('eye', true), eyewear('visor')],
  shingan: () => [eyewear('blindfold')],
  yomikiru: () => [eyewear('glasses')],
  kaminoyochi: () => [forehead('eye', true), crownPiece('halo')],
  zenchizenno: () => [crownPiece('halo'), forehead('eye', true)],
  mugenhenka: () => [floater('infinity')],
  mushin: () => [neck('beads'), crownPiece('halo')],
  // ---- 動物 ----
  inu: () => [ears('dog', 0x8a5a30)],
  usagi: () => [ears('rabbit', 0xf6f6f6)],
  saru: () => [waist('tail', 0x8a5a30, 'monkey')],
  neko: () => [ears('cat', 0x404040), waist('tail', 0x404040, 'cat')],
  kame: () => [back('shell')],
  taka: () => [crownPiece('feather')],
  uma: () => [waist('tail', 0x5a3a1a, 'horse')],
  kuma: () => [ears('bear', 0x6a4a2a)],
  washi: () => [back('wings')],
  inoshishi: () => [tusks()],
  kemonogaeri: () => [ears('wolf', 0x9a9aa8), ...arms('claws')],
  chita: () => [waist('tail', 0xe0b040, 'cheetah')],
  hayabusa: () => [back('wings'), crownPiece('feather')],
  kemononoou: () => [crownPiece('mane')],
  yaseinokan: () => [ears('wolf', 0x9a9aa8), crownPiece('feather')],
  kemonomichi: () => [waist('tail', 0xe07a30, 'fox'), ears('cat', 0xe07a30)],
  // ---- 根性 ----
  kinniku: () => arms('armbands', 0xd8302a),
  tafunesu: () => arms('wristbands', 0xf6f6f6),
  shuchu: () => [forehead('sun')],
  hashirikomi: () => feet('warmers'),
  suburi: () => [neck('towel')],
  nebari: () => [neck('towel'), ...arms('wristbands', 0xffc83a)],
  kajibanochikara: () => [crownPiece('fireHelmet')],
  tetsuwan: () => arms('ironArm'),
  dokonjou: () => [headband(0xd8302a), ...arms('wristbands', 0xd8302a)],
  kiai: () => [forehead('sun'), neck('towel')],
  shinimonogurui: () => [headband(0x202020), ...arms('armbands', 0x202020)],
  fushicho: () => [crownPiece('phoenix')],
  daiesu: () => [crownPiece('crown')],
  fushinochikara: () => [back('flameWings'), headband(0x202020)],
  yakyubaka: () => [crownPiece('ballStalk')],
  tetsujin: () => [crownPiece('ironHelmet'), ...arms('ironArm')],
};

/** その札の見た目の部品（テスト用にも使う） */
export function skillLookParts(id: SkillId): Part[] {
  return LOOKS[id]?.() ?? [];
}

// ---- 着せ替え ----

interface Dressing {
  key: string;
  objects: THREE.Object3D[];
}

const dressed = new WeakMap<THREE.Group, Dressing>();

function dispose(obj: THREE.Object3D): void {
  obj.removeFromParent();
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) mat?.dispose();
  });
}

/**
 * 選手にスキルの見た目を着せる。**持っている札の並びが前と同じなら何もしない**ので毎フレーム
 * 呼んでよい（打者が替わる・代打・継投・スキルを取る、のどれで変わっても次のフレームで着替わる）。
 * 同じ場所に付く物が重なっても構わない（札が3つまでなので、実機で見て気にならない範囲）。
 */
export function dressPlayer(player: THREE.Group, skills: readonly SkillId[]): void {
  const key = skills.join(',');
  const current = dressed.get(player);
  if (current && current.key === key) return;
  if (current) for (const o of current.objects) dispose(o);
  const objects: THREE.Object3D[] = [];
  for (const id of skills) {
    if (!SKILLS[id]) continue;
    for (const part of skillLookParts(id)) {
      if (part.mount === 'feetGround') attachToFacing(player, part.obj);
      else attachToBody(player, part.obj, part.mount);
      objects.push(part.obj);
    }
  }
  dressed.set(player, { key, objects });
}

/** いま着せている札の並び（テスト・確認用） */
export function dressedSkillsKey(player: THREE.Group): string {
  return dressed.get(player)?.key ?? '';
}
