/**
 * 乱闘v3の効果（フェーズXX-72）。**火花・ガードの閃き・土煙・衝撃の輪・炎・気の尾・
 * ピヨりの星**を、使い回す板（Sprite）の粒で描く。
 *
 * **判定には一切触らない**（どれも `core/brawl.ts` が出したイベントの位置に後から置くだけ）。
 * 粒のばらつきは連番のハッシュから取る＝本編の乱数は使わない（観客・地面の模様と同じ扱い）。
 *
 * 桜井ノウハウ照合：「ヒットストップで画面が止まっている間にも、エフェクトは動かして
 * 当たった感触を出す」＝粒は**実時間で動く**（エンジンの時計が止まっている間も広がる）。
 */
import * as THREE from 'three';
import { canvasTexture, hash01 } from './textures';

type TextureKind = 'glow' | 'star' | 'smoke' | 'ring' | 'streak';

let textures: Record<TextureKind, THREE.Texture> | null = null;

function makeTextures(): Record<TextureKind, THREE.Texture> {
  const glow = canvasTexture(64, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.7)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
  const star = canvasTexture(64, (ctx, s) => {
    // 4本の光条（打撃の火花）
    const c = s / 2;
    ctx.translate(c, c);
    for (let i = 0; i < 4; i++) {
      ctx.rotate(Math.PI / 4 + (i % 2) * 0);
      const g = ctx.createLinearGradient(-c, 0, c, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(-c, 0);
      ctx.lineTo(0, i % 2 === 0 ? -4 : -2.5);
      ctx.lineTo(c, 0);
      ctx.lineTo(0, i % 2 === 0 ? 4 : 2.5);
      ctx.closePath();
      ctx.fill();
    }
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 12);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-12, -12, 24, 24);
  });
  const smoke = canvasTexture(64, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 2, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
  const ring = canvasTexture(64, (ctx, s) => {
    ctx.strokeStyle = 'rgba(255,255,255,1)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s / 2 - 5, 0, Math.PI * 2);
    ctx.stroke();
  });
  const streak = canvasTexture(64, (ctx, s) => {
    const g = ctx.createLinearGradient(0, 0, s, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, s / 2 - 5, s, 10);
  });
  return { glow, star, smoke, ring, streak };
}

interface Particle {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  alive: boolean;
  vx: number;
  vy: number;
  vz: number;
  gravity: number;
  drag: number;
  life: number;
  maxLife: number;
  size0: number;
  size1: number;
  alpha0: number;
  spin: number;
}

export interface SparkOptions {
  color: number;
  /** 大きさの目安（m） */
  size?: number;
  count?: number;
  /** 飛び散る速さ（m/s） */
  speed?: number;
  /** 飛び散る向き（ワールドXの符号。0=全方向） */
  dir?: number;
}

export interface VfxSystem {
  readonly group: THREE.Group;
  /** 打撃の火花（中心の閃光＋放射状の粒） */
  hit(pos: THREE.Vector3, opts: SparkOptions & { heavy?: boolean }): void;
  /** ガードの閃き（青白い輪＋小さな火花） */
  guard(pos: THREE.Vector3, dir: number): void;
  /** 土煙（着地・ダウン・ダッシュ） */
  dust(pos: THREE.Vector3, amount: number, dir?: number): void;
  /** 衝撃の輪（KO・超必殺・投げの叩きつけ） */
  shockwave(pos: THREE.Vector3, color: number, size: number): void;
  /** 残る粒を1つ（炎・気の尾・風の筋）。`rise` は上へ流れる速さ */
  ember(pos: THREE.Vector3, color: number, size: number, life: number, rise?: number): void;
  /** 頭の上を回る星（ピヨり） */
  stars(pos: THREE.Vector3, t: number): void;
  update(dt: number): void;
  clear(): void;
}

const POOL_SIZE = 420;

export function createVfx(): VfxSystem {
  if (!textures) textures = makeTextures();
  const tex = textures;
  const group = new THREE.Group();
  group.name = 'brawlVfx';
  const pool: Particle[] = [];
  let serial = 0;
  let cursor = 0;

  function take(kind: TextureKind, color: number, additive: boolean): Particle {
    // 空きを探す（無ければいちばん古いものを使い回す＝画面が粒で詰まらない）
    for (let i = 0; i < pool.length; i++) {
      const p = pool[(cursor + i) % pool.length];
      if (!p.alive) {
        cursor = (cursor + i + 1) % pool.length;
        return reset(p, kind, color, additive);
      }
    }
    if (pool.length < POOL_SIZE) {
      const material = new THREE.SpriteMaterial({
        map: tex[kind],
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const sprite = new THREE.Sprite(material);
      sprite.renderOrder = 10;
      group.add(sprite);
      const p: Particle = {
        sprite,
        material,
        alive: true,
        vx: 0,
        vy: 0,
        vz: 0,
        gravity: 0,
        drag: 0,
        life: 0,
        maxLife: 1,
        size0: 1,
        size1: 1,
        alpha0: 1,
        spin: 0,
      };
      pool.push(p);
      return reset(p, kind, color, additive);
    }
    const p = pool[cursor];
    cursor = (cursor + 1) % pool.length;
    return reset(p, kind, color, additive);
  }

  function reset(p: Particle, kind: TextureKind, color: number, additive: boolean): Particle {
    p.alive = true;
    p.material.map = tex[kind];
    p.material.color.setHex(color);
    p.material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    p.material.rotation = 0;
    p.material.needsUpdate = true;
    p.sprite.visible = true;
    p.vx = 0;
    p.vy = 0;
    p.vz = 0;
    p.gravity = 0;
    p.drag = 0;
    p.life = 0;
    p.spin = 0;
    p.alpha0 = 1;
    return p;
  }

  const rnd = (): number => hash01(serial++);

  function spawn(
    kind: TextureKind,
    color: number,
    pos: THREE.Vector3,
    o: {
      size0: number;
      size1: number;
      life: number;
      vx?: number;
      vy?: number;
      vz?: number;
      gravity?: number;
      drag?: number;
      alpha?: number;
      additive?: boolean;
      spin?: number;
      rotation?: number;
    },
  ): Particle {
    const p = take(kind, color, o.additive ?? true);
    p.sprite.position.copy(pos);
    p.vx = o.vx ?? 0;
    p.vy = o.vy ?? 0;
    p.vz = o.vz ?? 0;
    p.gravity = o.gravity ?? 0;
    p.drag = o.drag ?? 0;
    p.maxLife = o.life;
    p.size0 = o.size0;
    p.size1 = o.size1;
    p.alpha0 = o.alpha ?? 1;
    p.spin = o.spin ?? 0;
    p.material.rotation = o.rotation ?? 0;
    p.material.opacity = p.alpha0;
    p.sprite.scale.setScalar(o.size0);
    return p;
  }

  return {
    group,

    hit(pos, opts) {
      const size = opts.size ?? 0.5;
      const heavy = opts.heavy ?? false;
      spawn('glow', 0xffffff, pos, { size0: size * 1.6, size1: size * 0.4, life: heavy ? 0.16 : 0.1 });
      spawn('star', opts.color, pos, {
        size0: size * (heavy ? 2.6 : 1.8),
        size1: size * 0.6,
        life: heavy ? 0.22 : 0.14,
        rotation: rnd() * Math.PI,
      });
      const count = opts.count ?? (heavy ? 14 : 7);
      const speed = opts.speed ?? (heavy ? 7 : 5);
      for (let i = 0; i < count; i++) {
        const a = rnd() * Math.PI * 2;
        const sp = speed * (0.5 + rnd() * 0.7);
        const bias = (opts.dir ?? 0) * speed * 0.4;
        spawn('glow', opts.color, pos, {
          size0: size * (0.22 + rnd() * 0.2),
          size1: 0.02,
          life: 0.18 + rnd() * 0.18,
          vx: Math.cos(a) * sp + bias,
          vy: Math.sin(a) * sp + 1.5,
          vz: (rnd() - 0.5) * 2,
          gravity: 14,
          drag: 3,
        });
      }
      if (heavy) spawn('ring', opts.color, pos, { size0: size * 0.5, size1: size * 3.2, life: 0.22, alpha: 0.9 });
    },

    guard(pos, dir) {
      spawn('ring', 0x9fd4ff, pos, { size0: 0.25, size1: 1.1, life: 0.14, alpha: 0.9 });
      spawn('glow', 0xcfe8ff, pos, { size0: 0.6, size1: 0.15, life: 0.1 });
      for (let i = 0; i < 5; i++) {
        const a = (rnd() - 0.5) * 1.6;
        spawn('glow', 0x9fd4ff, pos, {
          size0: 0.12,
          size1: 0.02,
          life: 0.15,
          vx: -dir * Math.cos(a) * 4,
          vy: Math.sin(a) * 4,
          drag: 4,
        });
      }
    },

    dust(pos, amount, dir = 0) {
      const n = Math.round(4 + amount * 8);
      for (let i = 0; i < n; i++) {
        const side = rnd() < 0.5 ? -1 : 1;
        spawn('smoke', 0xd8c8a8, new THREE.Vector3(pos.x + (rnd() - 0.5) * 0.4, 0.12, pos.z + (rnd() - 0.5) * 0.3), {
          size0: 0.25 + amount * 0.25,
          size1: 0.7 + amount * 0.9,
          life: 0.45 + rnd() * 0.3,
          vx: (dir !== 0 ? -dir * (1 + rnd()) : side * (0.8 + rnd() * 1.5)) * (0.6 + amount),
          vy: 0.4 + rnd() * 0.6,
          drag: 2.5,
          alpha: 0.55,
          additive: false,
        });
      }
    },

    shockwave(pos, color, size) {
      spawn('ring', color, pos, { size0: size * 0.2, size1: size * 2.4, life: 0.35, alpha: 1 });
      spawn('glow', color, pos, { size0: size * 1.2, size1: size * 0.2, life: 0.25, alpha: 0.9 });
    },

    ember(pos, color, size, life, rise = 1.2) {
      spawn('glow', color, pos, {
        size0: size,
        size1: size * 0.15,
        life,
        vx: (rnd() - 0.5) * 0.6,
        vy: rise * (0.6 + rnd() * 0.8),
        vz: (rnd() - 0.5) * 0.4,
        drag: 1.5,
        alpha: 0.95,
      });
    },

    stars(pos, t) {
      // 3つの星が頭の上を回る（毎フレーム1つずつ短命の粒を置いて軌道を描く）
      for (let i = 0; i < 3; i++) {
        const a = t * 5 + (i * Math.PI * 2) / 3;
        spawn('star', i === 1 ? 0x9fe0ff : 0xffe066, new THREE.Vector3(pos.x + Math.cos(a) * 0.32, pos.y + Math.sin(a * 2) * 0.05, pos.z + Math.sin(a) * 0.32), {
          size0: 0.22,
          size1: 0.18,
          life: 0.05,
        });
      }
    },

    update(dt) {
      for (const p of pool) {
        if (!p.alive) continue;
        p.life += dt;
        if (p.life >= p.maxLife) {
          p.alive = false;
          p.sprite.visible = false;
          continue;
        }
        const k = p.life / p.maxLife;
        const damp = Math.exp(-p.drag * dt);
        p.vx *= damp;
        p.vy = p.vy * damp - p.gravity * dt;
        p.vz *= damp;
        p.sprite.position.x += p.vx * dt;
        p.sprite.position.y += p.vy * dt;
        p.sprite.position.z += p.vz * dt;
        p.sprite.scale.setScalar(p.size0 + (p.size1 - p.size0) * k);
        p.material.opacity = p.alpha0 * (1 - k * k);
        p.material.rotation += p.spin * dt;
      }
    },

    clear() {
      for (const p of pool) {
        p.alive = false;
        p.sprite.visible = false;
      }
    },
  };
}
