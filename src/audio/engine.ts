/**
 * 音の土台（ブラッシュアップ：効果音・BGM）。**外部の音声ファイルは使わず、すべて WebAudio で
 * 合成する**（効果音＝`sfx.ts`、歓声＝`crowd.ts`、BGM＝`music.ts`）。
 *
 * ここが持つのは3つだけ：
 * 1. **音の通り道**：効果音・BGM・歓声の3本のバス → マスター → コンプレッサー → 出力。
 *    コンプレッサーは音量の天井を揃える役（打球音と歓声とBGMが重なっても割れない）。
 * 2. **球場の残響**（`reverbSend`）：合成したインパルス応答（1.6秒の減衰するノイズ）で
 *    屋外の球場の「カーン…」という返りを作る。効果音は送り量を選んで混ぜる。
 * 3. **使えるようになるまでの扱い**：ブラウザは最初のキー入力（ユーザー操作）まで音を
 *    出させない。テスト（node）には AudioContext が無いので、取れなければ何もしない。
 *
 * **判定には一切触らない**（音は起きたことを後から知らせるだけ）。
 */

export interface AudioGraph {
  ctx: AudioContext;
  /** 効果音のバス */
  sfx: GainNode;
  /** BGMのバス */
  music: GainNode;
  /** 歓声・場内のざわめきのバス */
  crowd: GainNode;
  /** 残響への送り口（ここへつなぐと球場の返りが付く） */
  reverbSend: GainNode;
}

let graph: AudioGraph | null = null;
let unlocked = false;
const unlockListeners: (() => void)[] = [];

/** 音量の設定（BGMのオン/オフ・効果音のオン/オフ）。**窓を閉じても覚えておく** */
export interface AudioSettings {
  music: boolean;
  sfx: boolean;
}

const SETTINGS_KEY = 'famista.audio';
const MUSIC_LEVEL = 0.42;
const SFX_LEVEL = 0.95;
const CROWD_LEVEL = 0.55;

let settings: AudioSettings = loadSettings();

function loadSettings(): AudioSettings {
  const fallback = { music: true, sfx: true };
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<AudioSettings>;
    return { music: parsed.music !== false, sfx: parsed.sfx !== false };
  } catch {
    return fallback;
  }
}

function saveSettings(): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // 保存できない環境（プライベートブラウズ等）でも鳴らすことはできる
  }
}

export function audioSettings(): AudioSettings {
  return { ...settings };
}

export function setAudioSettings(next: Partial<AudioSettings>): void {
  settings = { ...settings, ...next };
  saveSettings();
  if (!graph) return;
  const t = graph.ctx.currentTime;
  graph.music.gain.setTargetAtTime(settings.music ? MUSIC_LEVEL : 0, t, 0.05);
  graph.sfx.gain.setTargetAtTime(settings.sfx ? SFX_LEVEL : 0, t, 0.02);
  graph.crowd.gain.setTargetAtTime(settings.sfx ? CROWD_LEVEL : 0, t, 0.05);
}

/**
 * 音の通り道を取る（無ければ作る）。**鳴らしてよいのはユーザー操作の後だけ**なので、
 * まだ解除されていなければ null を返す（呼び出し側は黙って何もしない）。
 */
export function audio(): AudioGraph | null {
  if (!unlocked) return null;
  return ensureGraph();
}

function ensureGraph(): AudioGraph | null {
  if (graph) return graph;
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  const ctx = new Ctor({ latencyHint: 'interactive' });

  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -14;
  compressor.knee.value = 10;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.22;
  compressor.connect(ctx.destination);

  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(compressor);

  const bus = (level: number): GainNode => {
    const g = ctx.createGain();
    g.gain.value = level;
    g.connect(master);
    return g;
  };
  const sfx = bus(settings.sfx ? SFX_LEVEL : 0);
  const music = bus(settings.music ? MUSIC_LEVEL : 0);
  const crowd = bus(settings.sfx ? CROWD_LEVEL : 0);

  // 球場の残響（屋外の広い空間＝前半は薄く、1.6秒かけて消える）
  const convolver = ctx.createConvolver();
  convolver.buffer = stadiumImpulse(ctx, 1.6);
  const reverbReturn = ctx.createGain();
  reverbReturn.gain.value = 0.55;
  convolver.connect(reverbReturn);
  reverbReturn.connect(sfx);
  const reverbSend = ctx.createGain();
  reverbSend.gain.value = 1;
  reverbSend.connect(convolver);

  graph = { ctx, sfx, music, crowd, reverbSend };
  return graph;
}

/**
 * 合成したインパルス応答。**両耳で少しずつ違うノイズ**を指数的に減衰させ、頭に
 * 30msぶんの空白（音源から壁までの距離）を置く＝スタンドに返ってくる感じ。
 */
function stadiumImpulse(ctx: AudioContext, seconds: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * seconds);
  const buffer = ctx.createBuffer(2, length, rate);
  const predelay = Math.floor(rate * 0.03);
  for (let ch = 0; ch < 2; ch += 1) {
    const data = buffer.getChannelData(ch);
    let seed = 1234 + ch * 777;
    for (let i = predelay; i < length; i += 1) {
      seed = (seed * 16807) % 2147483647;
      const n = (seed / 2147483647) * 2 - 1;
      const t = (i - predelay) / (length - predelay);
      // 早い反射は少しだけ濃く、あとは指数で消える
      const env = Math.pow(1 - t, 3.2) * (i < predelay + rate * 0.08 ? 1.3 : 1);
      data[i] = n * env * 0.5;
    }
  }
  return buffer;
}

/** 解除されたときに1回だけ呼ばれる（BGMの開始など） */
export function onAudioUnlocked(listener: () => void): void {
  if (unlocked) {
    listener();
    return;
  }
  unlockListeners.push(listener);
}

export function isAudioUnlocked(): boolean {
  return unlocked;
}

if (typeof window !== 'undefined') {
  const unlock = (): void => {
    const g = ensureGraph();
    if (!g) return;
    void g.ctx.resume();
    if (!unlocked) {
      unlocked = true;
      for (const listener of unlockListeners.splice(0)) listener();
    }
    window.removeEventListener('keydown', unlock);
    window.removeEventListener('pointerdown', unlock);
  };
  window.addEventListener('keydown', unlock);
  window.addEventListener('pointerdown', unlock);
}

// ---- 合成の部品（効果音・歓声・BGMが共有する） ----

let whiteNoise: AudioBuffer | null = null;
let pinkNoise: AudioBuffer | null = null;

/** 2秒ぶんの白色雑音（使い回す） */
export function whiteNoiseBuffer(ctx: AudioContext): AudioBuffer {
  if (whiteNoise) return whiteNoise;
  const length = ctx.sampleRate * 2;
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 98765;
  for (let i = 0; i < length; i += 1) {
    seed = (seed * 16807) % 2147483647;
    data[i] = (seed / 2147483647) * 2 - 1;
  }
  whiteNoise = buffer;
  return buffer;
}

/** 4秒ぶんのピンクノイズ（歓声のざわめき用。高い音ほど弱い＝人の声の群れに近い） */
export function pinkNoiseBuffer(ctx: AudioContext): AudioBuffer {
  if (pinkNoise) return pinkNoise;
  const length = ctx.sampleRate * 4;
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  let seed = 424242;
  for (let i = 0; i < length; i += 1) {
    seed = (seed * 16807) % 2147483647;
    const white = (seed / 2147483647) * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
    b6 = white * 0.115926;
  }
  pinkNoise = buffer;
  return buffer;
}

/** 0 から peak へ attack 秒で立ち上がり、decay 秒で指数的に消える音量の山 */
export function envelope(
  param: AudioParam,
  t0: number,
  peak: number,
  attack: number,
  decay: number,
): void {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(0.0001, t0);
  param.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + Math.max(0.001, attack));
  param.exponentialRampToValueAtTime(0.0001, t0 + attack + Math.max(0.005, decay));
}

// DEBUG TEMP: 音量の計測用（確認後に削除）
if (typeof window !== 'undefined') {
  (window as unknown as { __ftAudioGraph: () => AudioGraph | null }).__ftAudioGraph = () => graph;
}
