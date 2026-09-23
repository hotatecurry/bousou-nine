/**
 * 場内の歓声（ブラッシュアップ：効果音）。
 *
 * 2つの層で作る：
 * 1. **ざわめき（`startAmbience`）**：試合中ずっと鳴っている低い群衆のノイズ。ピンクノイズを
 *    人の声の帯域（300〜2500Hz）へ絞り、ゆっくり揺らす（大勢の声が重なったときのうねり）。
 * 2. **沸き方（`react`）**：プレーに応じて一時的に盛り上がる。種類は5つ：
 *    - `cheer`（安打・セーフ）／`roar`（本塁打・乱闘・KO＝総立ち。指笛も混ぜる）
 *    - `ooh`（強い当たり・三振＝「おおー」。声の母音の山＝フォルマントを上げながら）
 *    - `groan`（アウト・ファウル＝「あー」。フォルマントを下げながら）
 *    - `gasp`（死球・銃＝息をのむ）／`murmur`（四球＝ざわつく）
 *
 * 声は合成なので言葉にはしない（原作のような実況の声は入れない）。**判定には一切触らない。**
 * 同じ種類が続けて呼ばれても重ならないよう、強い方で上書きする（安打のセーフと
 * 打球音のどよめきが同時に来ても、2倍の音量にはならない）。
 */
import { audio, envelope, pinkNoiseBuffer, whiteNoiseBuffer } from './engine';

export type CrowdReaction = 'cheer' | 'roar' | 'ooh' | 'groan' | 'gasp' | 'murmur';

interface Ambience {
  src: AudioBufferSourceNode;
  gain: GainNode;
  lfo: OscillatorNode;
}

let ambience: Ambience | null = null;
/** 種類ごとの「いま鳴っている強さ」と、その終わる時刻（同じ種類の重ね鳴りを防ぐ） */
const active = new Map<CrowdReaction, { until: number; intensity: number }>();

/** ざわめきの大きさ（試合中の平常時） */
const AMBIENCE_LEVEL = 0.3;

function startAmbience(): void {
  const g = audio();
  if (!g || ambience) return;
  const { ctx } = g;
  const src = ctx.createBufferSource();
  src.buffer = pinkNoiseBuffer(ctx);
  src.loop = true;
  const low = ctx.createBiquadFilter();
  low.type = 'bandpass';
  low.frequency.value = 650;
  low.Q.value = 0.6;
  const high = ctx.createBiquadFilter();
  high.type = 'bandpass';
  high.frequency.value = 2100;
  high.Q.value = 0.9;
  const highGain = ctx.createGain();
  highGain.gain.value = 0.35;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(AMBIENCE_LEVEL, ctx.currentTime + 1.5);
  // 群衆のうねり：ゆっくりした揺れを音量に足す
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.23;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = AMBIENCE_LEVEL * 0.35;
  lfo.connect(lfoDepth).connect(gain.gain);
  src.connect(low).connect(gain);
  src.connect(high).connect(highGain).connect(gain);
  gain.connect(g.crowd);
  src.start();
  lfo.start();
  ambience = { src, gain, lfo };
}

function stopAmbience(): void {
  const g = audio();
  if (!g || !ambience) return;
  const { ctx } = g;
  const a = ambience;
  ambience = null;
  const t = ctx.currentTime;
  a.gain.gain.cancelScheduledValues(t);
  a.gain.gain.setValueAtTime(Math.max(0.0001, a.gain.gain.value), t);
  a.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
  a.src.stop(t + 0.9);
  a.lfo.stop(t + 0.9);
}

/** 声の塊（ノイズを母音の山＝フォルマントに通す）。f1/f2 を時間で動かして「おお」「あー」にする */
function voiceSwell(
  intensity: number,
  opts: {
    attack: number;
    hold: number;
    release: number;
    f1: [number, number];
    f2: [number, number];
    bright?: number;
    level: number;
  },
): void {
  const g = audio();
  if (!g) return;
  const { ctx } = g;
  const t = ctx.currentTime;
  const total = opts.attack + opts.hold + opts.release;
  const src = ctx.createBufferSource();
  src.buffer = pinkNoiseBuffer(ctx);
  const out = ctx.createGain();
  const peak = opts.level * intensity;
  out.gain.setValueAtTime(0.0001, t);
  out.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + opts.attack);
  out.gain.setValueAtTime(Math.max(0.0002, peak), t + opts.attack + opts.hold);
  out.gain.exponentialRampToValueAtTime(0.0001, t + total);
  for (const [range, q, level] of [
    [opts.f1, 3.5, 1],
    [opts.f2, 4.5, 0.6],
  ] as const) {
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = q;
    f.frequency.setValueAtTime(range[0], t);
    f.frequency.linearRampToValueAtTime(range[1], t + opts.attack + opts.hold * 0.8);
    const lv = ctx.createGain();
    lv.gain.value = level;
    src.connect(f).connect(lv).connect(out);
  }
  if (opts.bright) {
    // 歓声の「わー」の明るさ（高い声の成分）
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1800;
    const lv = ctx.createGain();
    lv.gain.value = opts.bright;
    src.connect(hp).connect(lv).connect(out);
  }
  out.connect(g.crowd);
  src.start(t, Math.random() * 3, total + 0.1);
}

/** 指笛（総立ちのときだけ）。高い音程が揺れながら上下する */
function whistle(delay: number, base: number): void {
  const g = audio();
  if (!g) return;
  const { ctx } = g;
  const t = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(base * 0.8, t);
  osc.frequency.exponentialRampToValueAtTime(base * 1.15, t + 0.18);
  osc.frequency.exponentialRampToValueAtTime(base, t + 0.7);
  const vib = ctx.createOscillator();
  vib.frequency.value = 7;
  const vibDepth = ctx.createGain();
  vibDepth.gain.value = base * 0.02;
  vib.connect(vibDepth).connect(osc.frequency);
  const amp = ctx.createGain();
  envelope(amp.gain, t, 0.05, 0.08, 0.7);
  osc.connect(amp).connect(g.crowd);
  osc.start(t);
  vib.start(t);
  osc.stop(t + 0.9);
  vib.stop(t + 0.9);
}

/** 拍手（盛り上がりの後ろで細かく鳴る短いノイズの粒） */
function applause(duration: number, intensity: number): void {
  const g = audio();
  if (!g) return;
  const { ctx } = g;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = whiteNoiseBuffer(ctx);
  src.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2400;
  bp.Q.value = 0.5;
  // 粒立ち：速い揺れで音量を刻む
  const am = ctx.createGain();
  am.gain.value = 0.5;
  const lfo = ctx.createOscillator();
  lfo.type = 'square';
  lfo.frequency.value = 13;
  const depth = ctx.createGain();
  depth.gain.value = 0.5;
  lfo.connect(depth).connect(am.gain);
  const out = ctx.createGain();
  envelope(out.gain, t, 0.09 * intensity, 0.25, duration);
  src.connect(bp).connect(am).connect(out).connect(g.crowd);
  src.start(t);
  lfo.start(t);
  src.stop(t + duration + 0.3);
  lfo.stop(t + duration + 0.3);
}

function react(kind: CrowdReaction, intensity = 0.6): void {
  const g = audio();
  if (!g) return;
  const level = Math.min(1, Math.max(0, intensity));
  if (level <= 0.02) return;
  const now = g.ctx.currentTime;
  const current = active.get(kind);
  // 同じ種類がまだ鳴っていて、そちらのほうが強ければ重ねない
  if (current && current.until > now && current.intensity >= level) return;
  switch (kind) {
    case 'cheer':
      voiceSwell(level, { attack: 0.18, hold: 0.5, release: 1.6, f1: [700, 950], f2: [1300, 1700], bright: 0.5, level: 0.55 });
      applause(1.8, level);
      active.set(kind, { until: now + 1.2, intensity: level });
      break;
    case 'roar':
      voiceSwell(level, { attack: 0.25, hold: 1.4, release: 2.2, f1: [650, 1000], f2: [1200, 1900], bright: 0.8, level: 0.7 });
      applause(3.2, level * 1.2);
      whistle(0.35, 2600);
      whistle(0.8, 3100);
      whistle(1.4, 2300);
      active.set(kind, { until: now + 2.5, intensity: level });
      break;
    case 'ooh':
      voiceSwell(level, { attack: 0.3, hold: 0.25, release: 0.9, f1: [380, 560], f2: [800, 1000], level: 0.5 });
      active.set(kind, { until: now + 0.8, intensity: level });
      break;
    case 'groan':
      voiceSwell(level, { attack: 0.12, hold: 0.25, release: 0.8, f1: [620, 380], f2: [1150, 850], level: 0.4 });
      active.set(kind, { until: now + 0.6, intensity: level });
      break;
    case 'gasp':
      voiceSwell(level, { attack: 0.08, hold: 0.1, release: 0.6, f1: [900, 700], f2: [1800, 1500], bright: 0.4, level: 0.4 });
      active.set(kind, { until: now + 0.4, intensity: level });
      break;
    case 'murmur':
      voiceSwell(level, { attack: 0.3, hold: 0.4, release: 0.9, f1: [500, 520], f2: [1000, 1050], level: 0.3 });
      active.set(kind, { until: now + 0.9, intensity: level });
      break;
  }
}

export const crowd = { startAmbience, stopAmbience, react };
