/**
 * BGM（ブラッシュアップ：ファミコン音源風のオリジナル曲。WebAudio合成）。
 *
 * **4チャンネル**＝矩形波2声（`pulse1` 旋律・`pulse2` 和音のアルペジオ）・三角波（`tri`
 * ベース）・ノイズ（`noise` ドラム）。ファミコンの音源構成（矩形波2・三角波1・ノイズ1）を
 * そのまま真似る＝原作の雰囲気に寄せる（ユーザー判断「BGMはファミコン風」）。
 * 矩形波は**デューティ比**（12.5%／25%／50%）で音色を変える（細いほど鼻にかかった
 * ラッパのような音）。曲そのものはすべて書き下ろし（`songs.ts`）。
 *
 * 鳴らし方は**先読みスケジューラ**：25msごとに「0.15秒先まで」の音符を AudioContext の
 * 時計で予約する＝画面の処理が重くてもリズムが揺れない。
 *
 * - `play(name)`：ループ曲を切り替える（同じ曲なら何もしない）。前の曲は短くフェードする。
 * - `jingle(name)`：短い曲（本塁打のファンファーレ等）を1回だけ鳴らす。その間ループ曲は
 *   小さくして、終わったら戻す。
 * - `stop()`：止める。
 *
 * **判定には一切触らない**。どの曲をいつ鳴らすかは main.ts が場面から決める。
 */
import { audio, onAudioUnlocked, whiteNoiseBuffer } from './engine';
import { type SongName, type JingleName, type Song, SONGS, JINGLES } from './songs';

const LOOKAHEAD_SEC = 0.15;
const TICK_MS = 25;

/** チャンネルごとの音量（BGMのバスの中での釣り合い） */
const CHANNEL_LEVEL = { pulse1: 0.17, pulse2: 0.08, tri: 0.3, noise: 0.22 } as const;

const dutyWaves = new Map<number, PeriodicWave>();

/** 矩形波（デューティ比 duty）のフーリエ級数 */
function pulseWave(ctx: AudioContext, duty: number): PeriodicWave {
  const key = Math.round(duty * 1000);
  const cached = dutyWaves.get(key);
  if (cached) return cached;
  const n = 40;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let i = 1; i < n; i += 1) {
    real[i] = (2 / (i * Math.PI)) * Math.sin(i * Math.PI * duty);
  }
  const wave = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  dutyWaves.set(key, wave);
  return wave;
}

const midiToFreq = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

interface Player {
  song: Song;
  /** この曲の0ステップ目の時刻（AudioContext の時計） */
  start: number;
  /** どこまで予約したか（ステップ） */
  scheduledStep: number;
  /** この曲だけの音量（切り替えのフェード・ジングル中の絞りに使う） */
  gain: GainNode;
  loop: boolean;
  /** 1回きりの曲が終わる時刻 */
  endsAt: number;
}

let current: Player | null = null;
let currentName: SongName | null = null;
let jingle: Player | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
/** 解除前に頼まれた曲（最初のキー入力で鳴り始める） */
let pending: SongName | null = null;

function secPerStep(song: Song): number {
  return 60 / song.bpm / 4;
}

function makePlayer(song: Song, loop: boolean, level: number): Player | null {
  const g = audio();
  if (!g) return null;
  const gain = g.ctx.createGain();
  gain.gain.value = level;
  gain.connect(g.music);
  const start = g.ctx.currentTime + 0.06;
  return {
    song,
    start,
    scheduledStep: 0,
    gain,
    loop,
    endsAt: start + song.length * secPerStep(song),
  };
}

function ensureTimer(): void {
  if (timer !== null) return;
  timer = setInterval(tick, TICK_MS);
}

function tick(): void {
  const g = audio();
  if (!g) return;
  const now = g.ctx.currentTime;
  if (current) schedule(current, now);
  if (jingle) {
    schedule(jingle, now);
    if (now > jingle.endsAt + 0.2) {
      const done = jingle;
      jingle = null;
      done.gain.disconnect();
      // ループ曲を元の大きさへ戻す
      if (current) current.gain.gain.setTargetAtTime(1, now, 0.25);
    }
  }
}

function schedule(p: Player, now: number): void {
  const sps = secPerStep(p.song);
  // タブが裏に回っていた等で予約が遅れていたら、今の位置まで飛ばす（まとめて鳴らさない）
  const nowStep = (now - p.start) / sps;
  if (p.scheduledStep < nowStep - 2) p.scheduledStep = Math.ceil(nowStep);
  const untilStep = (now + LOOKAHEAD_SEC - p.start) / sps;
  while (p.scheduledStep < untilStep) {
    const step = p.scheduledStep;
    const loopIndex = Math.floor(step / p.song.length);
    if (!p.loop && loopIndex > 0) break;
    const local = step - loopIndex * p.song.length;
    for (const track of p.song.tracks) {
      for (const ev of track.events) {
        if (ev.step !== local) continue;
        const at = p.start + step * sps;
        playEvent(track.channel, ev, at, ev.len * sps, p.gain, track.duty ?? 0.5, track.volume ?? 1);
      }
    }
    p.scheduledStep += 1;
  }
}

interface NoteEvent {
  step: number;
  len: number;
  midi?: number;
  drum?: string;
}

function playEvent(
  channel: 'pulse1' | 'pulse2' | 'tri' | 'noise',
  ev: NoteEvent,
  at: number,
  dur: number,
  out: GainNode,
  duty: number,
  volume: number,
): void {
  const g = audio();
  if (!g) return;
  const { ctx } = g;
  if (channel === 'noise') {
    if (ev.drum) drum(ctx, ev.drum, at, out, CHANNEL_LEVEL.noise * volume);
    return;
  }
  if (ev.midi === undefined) return;
  const osc = ctx.createOscillator();
  if (channel === 'tri') osc.type = 'triangle';
  else osc.setPeriodicWave(pulseWave(ctx, duty));
  osc.frequency.value = midiToFreq(ev.midi);
  const amp = ctx.createGain();
  const level = CHANNEL_LEVEL[channel] * volume;
  const release = Math.min(0.05, dur * 0.3);
  const end = at + Math.max(0.02, dur - 0.005);
  amp.gain.setValueAtTime(0.0001, at);
  amp.gain.exponentialRampToValueAtTime(level, at + 0.004);
  // 矩形波は音の頭を少し強く（ファミコンの音量エンベロープの手触り）
  if (channel !== 'tri' && dur > 0.12) {
    amp.gain.exponentialRampToValueAtTime(level * 0.72, at + 0.09);
  }
  amp.gain.setValueAtTime(channel !== 'tri' && dur > 0.12 ? level * 0.72 : level, end - release);
  amp.gain.exponentialRampToValueAtTime(0.0001, end);
  // 長い音にだけビブラート（歌っているように聞こえる）
  if (channel === 'pulse1' && dur > 0.35) {
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.5;
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(0, at);
    depth.gain.linearRampToValueAtTime(osc.frequency.value * 0.006, at + 0.25);
    vib.connect(depth).connect(osc.frequency);
    vib.start(at);
    vib.stop(end + 0.02);
  }
  osc.connect(amp).connect(out);
  osc.start(at);
  osc.stop(end + 0.02);
}

/** ドラム（k=キック s=スネア h=ハイハット o=オープン c=クラッシュ） */
function drum(ctx: AudioContext, kind: string, at: number, out: GainNode, level: number): void {
  if (kind === 'k') {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(160, at);
    osc.frequency.exponentialRampToValueAtTime(42, at + 0.09);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(level * 2.6, at);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + 0.12);
    osc.connect(amp).connect(out);
    osc.start(at);
    osc.stop(at + 0.14);
    return;
  }
  const spec: Record<string, { dur: number; type: BiquadFilterType; freq: number; gain: number }> = {
    s: { dur: 0.11, type: 'bandpass', freq: 1900, gain: 1.1 },
    h: { dur: 0.03, type: 'highpass', freq: 7000, gain: 0.45 },
    o: { dur: 0.14, type: 'highpass', freq: 6000, gain: 0.5 },
    c: { dur: 1.1, type: 'highpass', freq: 4500, gain: 0.7 },
  };
  const s = spec[kind];
  if (!s) return;
  const src = ctx.createBufferSource();
  src.buffer = whiteNoiseBuffer(ctx);
  const filter = ctx.createBiquadFilter();
  filter.type = s.type;
  filter.frequency.value = s.freq;
  filter.Q.value = 0.7;
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(level * s.gain, at);
  amp.gain.exponentialRampToValueAtTime(0.0001, at + s.dur);
  src.connect(filter).connect(amp).connect(out);
  src.start(at, Math.random(), s.dur + 0.05);
  if (kind === 's') {
    // スネアの胴（ノイズだけより締まる）
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(240, at);
    osc.frequency.exponentialRampToValueAtTime(140, at + 0.05);
    const body = ctx.createGain();
    body.gain.setValueAtTime(level * 0.9, at);
    body.gain.exponentialRampToValueAtTime(0.0001, at + 0.07);
    osc.connect(body).connect(out);
    osc.start(at);
    osc.stop(at + 0.08);
  }
}

function fadeOut(p: Player, seconds: number): void {
  const g = audio();
  if (!g) return;
  const t = g.ctx.currentTime;
  p.gain.gain.cancelScheduledValues(t);
  p.gain.gain.setValueAtTime(Math.max(0.0001, p.gain.gain.value), t);
  p.gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
  setTimeout(() => p.gain.disconnect(), seconds * 1000 + 200);
}

function play(name: SongName): void {
  if (currentName === name && current) return;
  const g = audio();
  if (!g) {
    // まだ音を出せない（最初のキー入力の前）：解除されたら鳴らす
    pending = name;
    return;
  }
  if (current) fadeOut(current, 0.3);
  const next = makePlayer(SONGS[name], true, jingle ? 0.2 : 1);
  current = next;
  currentName = next ? name : null;
  ensureTimer();
}

function playJingle(name: JingleName): void {
  const g = audio();
  if (!g) return;
  if (jingle) fadeOut(jingle, 0.1);
  jingle = makePlayer(JINGLES[name], false, 1);
  // ループ曲は絞る（ファンファーレを聴かせる）
  if (current) current.gain.gain.setTargetAtTime(0.18, g.ctx.currentTime, 0.05);
  ensureTimer();
}

function stop(): void {
  pending = null;
  if (current) fadeOut(current, 0.4);
  current = null;
  currentName = null;
}

onAudioUnlocked(() => {
  if (pending) {
    const name = pending;
    pending = null;
    play(name);
  }
});

export const music = {
  play,
  jingle: playJingle,
  stop,
  /** いまのループ曲（テスト・デバッグ用） */
  current: (): SongName | null => currentName ?? pending,
};
