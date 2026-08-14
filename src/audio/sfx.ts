/**
 * 8bit風効果音（WebAudio合成、外部音声ファイル不使用）。
 *
 * 桜井ノウハウ照合（sakurai_all.txt）：
 * - ファミコンの音源構成は矩形波2・三角波1・ノイズ1・DPCM1。矩形波は旋律、
 *   三角波はベースや鈍い衝撃音、ノイズはヒット音・爆発音に使われることが多い、
 *   という言及を踏まえ、旋律的な音（ファンファーレ等）は矩形波、低く重い一撃は
 *   三角波、打撃・銃声・KOなどの衝撃音はノイズバッファで表現する。
 * - 「アタック強め・残響ほどほど」（立ち上がりを速く、瞬時にピークへ）と、
 *   「ヒットストップで画面が止まっている間に主要な音は鳴り終わっているのが理想」
 *   という言及を踏まえ、すべての効果音は attack を短く（既定5ms）、余韻を
 *   ヒットストップの尺（打撃0.05〜0.11秒、銃0.3秒）に収まる長さで設計している。
 * - 「音の優先度や大きさはプレイヤーに大きく関係するものをより大きくする」
 *   （スマブラの例：撃墜音が最大、次にヒット音、その次に必殺技音…の順）に
 *   準拠し、ここでも 決着（ホームラン・KO・勝敗）を最大音量、命中
 *   （打撃・銃命中・乱闘ヒット）をその次、発射/攻撃モーションをさらにその次、
 *   空振り・ファウル・アウトは控えめ、という音量階層にした。
 * - 「名作に音が悪いものなし」という言及もあり、演出・見た目と同じく
 *   本セッションのスコープに含めた（PROGRESS.md「音響基盤ごとHUD・演出
 *   セッションで導入」の持ち越しに対応）。
 *
 * ブラウザの自動再生ポリシー対策：AudioContextはユーザー操作前は
 * suspended のままなので、最初のキー入力（keydown＝ユーザージェスチャー）で
 * resume する。テスト（jsdom/vitest）には AudioContext が存在しないため、
 * すべての関数は取得できない場合に何もせず戻る（no-op）。
 */

let sharedCtx: AudioContext | null = null;
let masterGain: GainNode | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!sharedCtx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    sharedCtx = new Ctor();
  }
  return sharedCtx;
}

function getMasterGain(c: AudioContext): GainNode {
  if (!masterGain) {
    masterGain = c.createGain();
    masterGain.gain.value = 0.9;
    masterGain.connect(c.destination);
  }
  return masterGain;
}

if (typeof window !== 'undefined') {
  const unlock = () => {
    getCtx()?.resume();
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('keydown', unlock);
}

interface ToneOptions {
  /** 矩形波＝旋律向き、三角波＝低く鈍い音向き（ファミコン音源の使い分けに準拠） */
  type?: 'square' | 'triangle';
  /** ピーク音量（0〜1） */
  gain?: number;
  /** 立ち上がり秒数（アタック強め＝短いほど良い、既定5ms） */
  attack?: number;
  /** ピークから減衰しきるまでの秒数（既定は duration と同じ） */
  decay?: number;
  /** 指定すると、鳴っている間に周波数をこの値まで直線的に滑らせる（下降音でKO感等を出す） */
  slideTo?: number;
}

/** 単発の音（矩形波/三角波）を鳴らす。 */
function tone(freq: number, duration: number, opts: ToneOptions = {}): void {
  const c = getCtx();
  if (!c) return;
  const { type = 'square', gain = 0.2, attack = 0.005, decay = duration, slideTo } = opts;
  const osc = c.createOscillator();
  osc.type = type;
  const t0 = c.currentTime;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo !== undefined) {
    osc.frequency.linearRampToValueAtTime(slideTo, t0 + attack + decay);
  }
  const g = c.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  osc.connect(g).connect(getMasterGain(c));
  osc.start(t0);
  osc.stop(t0 + attack + decay + 0.02);
}

interface NoiseOptions {
  gain?: number;
  /** 指定すると簡易フィルタを通す（低域寄り＝重い衝撃音、高域寄り＝軽い/鋭い音） */
  filterFreq?: number;
  filterType?: BiquadFilterType;
}

/** ノイズバッファ1回分の衝撃音（打撃・銃声・KOなど、ファミコンのノイズ音源相当）。 */
function noiseBurst(duration: number, opts: NoiseOptions = {}): void {
  const c = getCtx();
  if (!c) return;
  const { gain = 0.25, filterFreq, filterType = 'lowpass' } = opts;
  const length = Math.max(1, Math.floor(c.sampleRate * duration));
  const buffer = c.createBuffer(1, length, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;

  const src = c.createBufferSource();
  src.buffer = buffer;
  const t0 = c.currentTime;
  const g = c.createGain();
  g.gain.setValueAtTime(gain, t0); // アタック強め：ノイズは最初から全開にする
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

  let node: AudioNode = src;
  if (filterFreq) {
    const filter = c.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = filterFreq;
    node = node.connect(filter);
  }
  node.connect(g).connect(getMasterGain(c));
  src.start(t0);
  src.stop(t0 + duration + 0.02);
}

interface Note {
  freq: number;
  dur: number;
  /** 再生開始までの遅延秒数 */
  delay: number;
  type?: 'square' | 'triangle';
  gain?: number;
}

/** ファンファーレ等、複数の音を時間差で鳴らす（setTimeoutでスケジュール。UI演出用途で十分な精度）。 */
function sequence(notes: readonly Note[]): void {
  if (!getCtx()) return;
  for (const n of notes) {
    setTimeout(() => tone(n.freq, n.dur, { type: n.type, gain: n.gain }), n.delay * 1000);
  }
}

// ---- 効果音カタログ ----

export const sfx = {
  /** 空振り（バットが空を切る音）。優先度は低め（桜井：空振りは目立たせすぎない帯） */
  swingMiss(): void {
    noiseBurst(0.08, { gain: 0.12, filterFreq: 3000, filterType: 'highpass' });
  },

  /** バット接触音。打球初速(m/s)に比例して強く・高くする（強い当たりほど重い手応え） */
  hit(exitSpeed: number): void {
    const power = Math.min(1, exitSpeed / 45);
    noiseBurst(0.05, { gain: 0.2 + 0.15 * power, filterFreq: 1200 + 800 * power, filterType: 'bandpass' });
    tone(180 + 220 * power, 0.09, { type: 'triangle', gain: 0.18 + 0.12 * power });
  },

  /** ファウル（打球音より控えめな軽い音） */
  foul(): void {
    noiseBurst(0.06, { gain: 0.12, filterFreq: 900, filterType: 'bandpass' });
  },

  /** 通常の死球（銃ではない）。鈍い衝撃音 */
  hitByPitch(): void {
    tone(140, 0.14, { type: 'triangle', gain: 0.22 });
    noiseBurst(0.05, { gain: 0.15, filterFreq: 500, filterType: 'lowpass' });
  },

  /** アウト成立（フライアウト/フォースアウト等）。演出は控えめな下降音 */
  out(): void {
    tone(220, 0.08, { type: 'square', gain: 0.12, slideTo: 160 });
  },

  /** 安打（単打〜三塁打共通の着弾音）。塁打の大小はHUDバナー側で演出を分ける */
  base(): void {
    sequence([
      { freq: 523.25, dur: 0.08, delay: 0, gain: 0.18 },
      { freq: 659.25, dur: 0.12, delay: 0.07, gain: 0.18 },
    ]);
  },

  /** 三振 */
  strikeout(): void {
    sequence([
      { freq: 392.0, dur: 0.1, delay: 0, gain: 0.16 },
      { freq: 293.66, dur: 0.18, delay: 0.09, gain: 0.16 },
    ]);
  },

  /** 四死球（穏やかなブザー音） */
  walk(): void {
    tone(330, 0.16, { type: 'square', gain: 0.14 });
  },

  /**
   * ホームラン。桜井ノウハウ「決着イベントは最大音量」に準拠し、低域の一撃＋
   * ノイズの着弾に、上昇アルペジオのファンファーレを重ねる。
   */
  homerun(): void {
    noiseBurst(0.12, { gain: 0.3, filterFreq: 800, filterType: 'lowpass' });
    tone(140, 0.16, { type: 'triangle', gain: 0.3 });
    sequence([
      { freq: 523.25, dur: 0.12, delay: 0.05, gain: 0.22 },
      { freq: 659.25, dur: 0.12, delay: 0.17, gain: 0.22 },
      { freq: 783.99, dur: 0.12, delay: 0.29, gain: 0.22 },
      { freq: 1046.5, dur: 0.35, delay: 0.41, gain: 0.26 },
    ]);
  },

  /**
   * CPU投手が銃を構えた予兆（フェーズF-26-2）。**発射音より前に、はっきり別の音**で
   * 鳴らす：予兆は「これから避けられない一撃が来る」ことだけを伝える合図なので、
   * 発射（gunShot）と聞き分けられないと予兆の役目を果たさない。
   * 撃鉄を起こす硬い音＋不安を煽る上昇で、シリアス演出のトーンに合わせる。
   */
  gunAim(): void {
    noiseBurst(0.04, { gain: 0.2, filterFreq: 3500, filterType: 'highpass' });
    tone(180, 0.5, { type: 'square', gain: 0.14, slideTo: 320 });
  },

  /**
   * 一時効果を切った（フェーズM-33）。**押した瞬間の手応えだけ**を返す短い上昇音で、
   * 効果そのものはHUDの数字と行で見せる（⑧のトーン「ゲーム側は一切ツッコまない」＝
   * 大仰なファンファーレは鳴らさない）。切った本人にも相手にも同じ音が聞こえる＝
   * **相手が切ったことは隠さない**（意思決定材料は隠さない）。
   */
  skillActivate(): void {
    tone(440, 0.18, { type: 'square', gain: 0.12, slideTo: 880 });
  },

  /** 銃の発射音（命中/外れ問わず鳴る。命中時はさらに gunHit を重ねる） */
  gunShot(): void {
    noiseBurst(0.09, { gain: 0.26, filterFreq: 2200, filterType: 'lowpass' });
    tone(90, 0.1, { type: 'triangle', gain: 0.2 });
  },

  /** 銃命中（シリアス演出。発射音の上に低く重い一撃を追加する） */
  gunHit(): void {
    tone(70, 0.28, { type: 'triangle', gain: 0.32, slideTo: 40 });
  },

  /** 乱闘：攻撃モーション（ヒットの有無に関わらず、繰り出した瞬間に鳴る） */
  brawlAttack(): void {
    noiseBurst(0.05, { gain: 0.1, filterFreq: 2500, filterType: 'highpass' });
  },

  /** 乱闘：命中。ガード時は軽減された軽い音、素通し時は重い音（ダメージの手応えに合わせる） */
  brawlHit(guarded: boolean): void {
    if (guarded) {
      tone(660, 0.06, { type: 'square', gain: 0.14 });
    } else {
      noiseBurst(0.08, { gain: 0.24, filterFreq: 700, filterType: 'lowpass' });
      tone(150, 0.1, { type: 'triangle', gain: 0.22 });
    }
  },

  /** 乱闘：開始の合図 */
  brawlStart(): void {
    sequence([
      { freq: 220, dur: 0.08, delay: 0, gain: 0.16 },
      { freq: 220, dur: 0.08, delay: 0.1, gain: 0.16 },
    ]);
  },

  /** 乱闘：KO。決着イベントとして最大音量クラスに設定 */
  ko(): void {
    noiseBurst(0.16, { gain: 0.34, filterFreq: 600, filterType: 'lowpass' });
    tone(110, 0.32, { type: 'triangle', gain: 0.34, slideTo: 55 });
  },

  /** 試合終了（勝敗確定） */
  win(): void {
    sequence([
      { freq: 523.25, dur: 0.14, delay: 0, gain: 0.22 },
      { freq: 523.25, dur: 0.14, delay: 0.16, gain: 0.22 },
      { freq: 783.99, dur: 0.4, delay: 0.32, gain: 0.26 },
    ]);
  },
};
