/**
 * 効果音（ブラッシュアップで全面的に作り直した。WebAudio合成・外部の音声ファイルは使わない）。
 *
 * それまでは「矩形波1本＋短いノイズ」で鳴らしていたので、どの音も軽く気の抜けた音だった
 * （テストプレイ「SEがしょぼい」）。いまは**実物の音の成り立ち**を重ねて作る：
 *
 * - **打球音**＝硬い木が割れる高域のクリック＋木の胴鳴り（数本の倍音が別々の速さで消える）
 *   ＋低い芯の「ドン」＋球場の返り。**打球の強さ（初速）で明るさ・重さ・返りの量が変わる**
 *   ＝芯を外した当たりは鈍く、芯で捉えた当たりは甲高く響く（手応えが耳で分かる）。
 * - **ミット**＝革を叩く帯域のノイズ＋乾いたクリック＋低い胴。速い球ほど鋭い。
 * - **歓声**は `crowd.ts`（場内のざわめきと、プレーに応じた沸き方）。
 *
 * 桜井ノウハウ照合（sakurai_all.txt）：
 * - 「アタック強め・残響ほどほど」「ヒットストップで画面が止まっている間に主要な音は
 *   鳴り終わっているのが理想」＝打球音の芯は最初の0.1秒に集め、返りだけを後ろへ流す。
 * - 「音の優先度や大きさはプレイヤーに大きく関係するものをより大きくする」＝決着
 *   （本塁打・KO・勝敗）を最大、命中（打球・銃・乱闘の打撃）をその次、動作（スイング・
 *   送球）をさらに下、という音量の階層は従来のまま守る。
 * - 「名作に音が悪いものなし」。
 *
 * **判定には一切触らない**。鳴らすきっかけは実際のゲームイベントの発生元（main.ts）が持つ。
 * AudioContext の無い環境（テスト）やユーザー操作の前は、どの関数も何もしない。
 */
import { type AudioGraph, audio, envelope, whiteNoiseBuffer } from './engine';
import { crowd } from './crowd';

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

interface NoiseOpts {
  at?: number;
  dur: number;
  gain: number;
  type?: BiquadFilterType;
  freq?: number;
  q?: number;
  /** 鳴っている間にフィルタの周波数をここまで動かす（風切り音の「ヒュッ」） */
  freqEnd?: number;
  attack?: number;
  /** 残響へ送る量（0..1） */
  send?: number;
  pan?: number;
}

/** 帯域を絞ったノイズの一発 */
function noise(g: AudioGraph, o: NoiseOpts): void {
  const { ctx } = g;
  const t = o.at ?? ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = whiteNoiseBuffer(ctx);
  const filter = ctx.createBiquadFilter();
  filter.type = o.type ?? 'bandpass';
  filter.frequency.setValueAtTime(o.freq ?? 1000, t);
  if (o.freqEnd !== undefined) {
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqEnd), t + o.dur);
  }
  filter.Q.value = o.q ?? 0.8;
  const amp = ctx.createGain();
  envelope(amp.gain, t, o.gain, o.attack ?? 0.002, o.dur);
  src.connect(filter).connect(amp);
  route(g, amp, o.send ?? 0, o.pan ?? 0);
  // バッファの頭を毎回ずらす（同じ波形の繰り返しが耳に付かないように）
  src.start(t, Math.random() * 1.5, o.dur + 0.1);
}

interface ToneOpts {
  at?: number;
  type?: OscillatorType;
  freq: number;
  freqEnd?: number;
  dur: number;
  gain: number;
  attack?: number;
  send?: number;
  pan?: number;
}

/** 音程のある一発（胴鳴りの倍音・低い芯・ゴング） */
function tone(g: AudioGraph, o: ToneOpts): void {
  const { ctx } = g;
  const t = o.at ?? ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.freq, t);
  if (o.freqEnd !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqEnd), t + o.dur);
  }
  const amp = ctx.createGain();
  envelope(amp.gain, t, o.gain, o.attack ?? 0.002, o.dur);
  osc.connect(amp);
  route(g, amp, o.send ?? 0, o.pan ?? 0);
  osc.start(t);
  osc.stop(t + o.dur + (o.attack ?? 0.002) + 0.05);
}

/** 効果音のバスへ（＋残響へ送る・左右に振る） */
function route(g: AudioGraph, node: AudioNode, send: number, pan: number): void {
  let out: AudioNode = node;
  if (pan !== 0) {
    const p = g.ctx.createStereoPanner();
    p.pan.value = pan;
    out = node.connect(p);
  }
  out.connect(g.sfx);
  if (send > 0) {
    const s = g.ctx.createGain();
    s.gain.value = send;
    out.connect(s).connect(g.reverbSend);
  }
}

/** ゴング（乱闘の開始・決着）。金属の非整数倍の倍音がゆっくり消える */
function bell(g: AudioGraph, at: number, base: number, gain: number): void {
  const partials: [number, number, number][] = [
    [1, 1.0, 1.6],
    [2.76, 0.55, 1.0],
    [5.4, 0.3, 0.55],
    [8.93, 0.16, 0.3],
  ];
  for (const [ratio, level, decay] of partials) {
    tone(g, { at, freq: base * ratio, dur: decay, gain: gain * level, send: 0.35 });
  }
  noise(g, { at, dur: 0.02, gain: gain * 0.6, type: 'highpass', freq: 3000 });
}

export const sfx = {
  // ---- 投打 ----

  /** スイングの風切り（振り出した瞬間。人間もCPUも同じ音） */
  swing(): void {
    const g = audio();
    if (!g) return;
    noise(g, { dur: 0.2, gain: 0.32, type: 'bandpass', freq: 420, freqEnd: 1900, q: 1.2, attack: 0.05 });
    noise(g, { dur: 0.16, gain: 0.12, type: 'highpass', freq: 2600, attack: 0.06 });
  },

  /** 空振り・蹴りの空振り（風切りだけ。スイングの音と同じ系統で短い） */
  swingMiss(): void {
    const g = audio();
    if (!g) return;
    noise(g, { dur: 0.16, gain: 0.26, type: 'bandpass', freq: 520, freqEnd: 1700, q: 1.3, attack: 0.03 });
  },

  /**
   * 打球音。**初速（m/s）で音の性格が変わる**：芯で捉えた強い当たりは甲高く長く響き
   * （カーン）、芯を外した弱い当たりは鈍く短い（ゴツッ）。バントもこの音の弱い端。
   */
  hit(exitSpeed: number): void {
    const g = audio();
    if (!g) return;
    const t = g.ctx.currentTime;
    const p = clamp01((exitSpeed - 18) / 28);
    const level = 0.45 + 0.55 * p;
    // 1. 硬い木が割れる瞬間のクリック
    noise(g, { at: t, dur: 0.014, gain: 0.95 * level, type: 'highpass', freq: 2400 + 1600 * p, q: 0.7 });
    // 2. 木の胴鳴り（倍音ごとに消える速さが違う＝「カーン」の尾）
    const body = 760 + 260 * p;
    tone(g, { at: t, freq: body, freqEnd: body * 0.97, dur: 0.07 + 0.16 * p, gain: 0.34 * level, send: 0.25 + 0.4 * p });
    tone(g, { at: t, freq: body * 2.13, freqEnd: body * 2.1, dur: 0.05 + 0.1 * p, gain: 0.2 * level, send: 0.2 });
    tone(g, { at: t, freq: body * 3.55, dur: 0.03 + 0.05 * p, gain: 0.11 * level });
    // 3. 低い芯（手に来る重さ）。弱い当たりほど相対的に濁る
    tone(g, { at: t, freq: 170 - 40 * p, freqEnd: 70, dur: 0.09, gain: 0.42 * (0.5 + 0.5 * p) });
    noise(g, { at: t, dur: 0.05, gain: 0.35 * (1 - 0.5 * p), type: 'lowpass', freq: 900 });
    // 4. 強い当たりは場内がどよめく
    crowd.react('ooh', 0.2 + 0.6 * p * p);
  },

  /** ミット（捕手が投球を受けた）。速い球ほど鋭い「バシッ」 */
  mitt(pitchSpeed = 36): void {
    const g = audio();
    if (!g) return;
    const p = clamp01((pitchSpeed - 28) / 16);
    noise(g, { dur: 0.045, gain: 0.55 + 0.35 * p, type: 'bandpass', freq: 1300 + 700 * p, q: 0.9, send: 0.18 });
    noise(g, { dur: 0.012, gain: 0.25 + 0.35 * p, type: 'highpass', freq: 3600 });
    tone(g, { freq: 230, freqEnd: 110, dur: 0.06, gain: 0.38 });
  },

  /** 野手の捕球（グラブ）。ミットより柔らかい「パスッ」 */
  catchBall(): void {
    const g = audio();
    if (!g) return;
    noise(g, { dur: 0.04, gain: 0.34, type: 'bandpass', freq: 1150, q: 1.0, send: 0.1 });
    tone(g, { freq: 200, freqEnd: 120, dur: 0.05, gain: 0.22 });
  },

  /** 送球（投げた瞬間の短い風切り） */
  throwBall(): void {
    const g = audio();
    if (!g) return;
    noise(g, { dur: 0.13, gain: 0.2, type: 'bandpass', freq: 800, freqEnd: 1900, q: 1.4, attack: 0.02 });
  },

  /** 投球のリリース（ごく小さい風切り。速い球ほど鋭い） */
  pitchRelease(pitchSpeed = 36): void {
    const g = audio();
    if (!g) return;
    const p = clamp01((pitchSpeed - 28) / 16);
    noise(g, { dur: 0.12, gain: 0.1 + 0.08 * p, type: 'bandpass', freq: 900 + 700 * p, freqEnd: 2200, q: 1.5, attack: 0.02 });
  },

  /** ファウル（打球音はもう鳴っている。場内の「あー」だけ） */
  foul(): void {
    crowd.react('groan', 0.25);
  },

  /** 死球（体に当たる鈍い音＋場内のどよめき） */
  hitByPitch(): void {
    const g = audio();
    if (!g) return;
    tone(g, { freq: 105, freqEnd: 55, dur: 0.16, gain: 0.55 });
    noise(g, { dur: 0.1, gain: 0.45, type: 'lowpass', freq: 600, send: 0.12 });
    crowd.react('gasp', 0.6);
  },

  /** アウト（締まった「ドッ」＋場内の反応） */
  out(): void {
    const g = audio();
    if (!g) return;
    tone(g, { freq: 120, freqEnd: 62, dur: 0.12, gain: 0.34 });
    noise(g, { dur: 0.06, gain: 0.22, type: 'lowpass', freq: 700 });
    crowd.react('groan', 0.35);
  },

  /** 安打・セーフ（場内が沸く） */
  base(): void {
    crowd.react('cheer', 0.6);
  },

  /** 三振（ミットの音は判定の瞬間に鳴っている。場内の「おおー」） */
  strikeout(): void {
    crowd.react('ooh', 0.5);
  },

  /** 四球（場内のざわめきが少し上がる） */
  walk(): void {
    crowd.react('murmur', 0.45);
  },

  /** 本塁打（場内が総立ちで沸く。ファンファーレは BGM の側＝`music.jingle`） */
  homerun(): void {
    crowd.react('roar', 1);
  },

  // ---- 銃（シリアス演出） ----

  /** CPU投手が銃を構えた予兆。撃鉄を起こす金属音＋張り詰めた低音（発射音とはっきり別の音） */
  gunAim(): void {
    const g = audio();
    if (!g) return;
    const t = g.ctx.currentTime;
    for (const [dt, f] of [
      [0, 3400],
      [0.11, 2600],
    ] as const) {
      noise(g, { at: t + dt, dur: 0.012, gain: 0.5, type: 'highpass', freq: 3500 });
      tone(g, { at: t + dt, freq: f, dur: 0.035, gain: 0.18, type: 'triangle' });
    }
    tone(g, { at: t + 0.15, freq: 52, freqEnd: 60, dur: 1.2, gain: 0.3, attack: 0.5, type: 'triangle' });
    crowd.react('gasp', 0.8);
  },

  /** 銃の発射（命中・外れを問わず鳴る。命中時は gunHit を重ねる） */
  gunShot(): void {
    const g = audio();
    if (!g) return;
    const t = g.ctx.currentTime;
    noise(g, { at: t, dur: 0.012, gain: 1.0, type: 'highpass', freq: 1800 });
    noise(g, { at: t, dur: 0.22, gain: 0.9, type: 'lowpass', freq: 7000, freqEnd: 700, send: 0.85 });
    tone(g, { at: t, freq: 80, freqEnd: 34, dur: 0.3, gain: 0.85, send: 0.4 });
  },

  /** 銃の命中（重い衝撃＋場内が凍りつく） */
  gunHit(): void {
    const g = audio();
    if (!g) return;
    tone(g, { freq: 72, freqEnd: 38, dur: 0.32, gain: 0.7 });
    noise(g, { dur: 0.16, gain: 0.45, type: 'lowpass', freq: 500, send: 0.3 });
  },

  // ---- スキル ----

  /** 一時効果・スキルの発動（きらめく上昇音。押した手応えだけを返す） */
  skillActivate(): void {
    const g = audio();
    if (!g) return;
    const t = g.ctx.currentTime;
    const notes = [1046.5, 1318.5, 1568, 2093, 2637];
    notes.forEach((f, i) => {
      tone(g, { at: t + i * 0.035, freq: f, dur: 0.22, gain: 0.12, send: 0.35, type: 'triangle' });
    });
    noise(g, { at: t, dur: 0.35, gain: 0.08, type: 'highpass', freq: 6000, attack: 0.08, send: 0.3 });
  },

  /** バイクの点火（エンジンが吹け上がる） */
  bikeIgnite(): void {
    const g = audio();
    if (!g) return;
    const { ctx } = g;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(48, t);
    osc.frequency.exponentialRampToValueAtTime(150, t + 0.35);
    osc.frequency.exponentialRampToValueAtTime(110, t + 0.7);
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i += 1) {
      const x = (i / 255) * 2 - 1;
      curve[i] = Math.tanh(x * 3);
    }
    shaper.curve = curve;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1100;
    const amp = ctx.createGain();
    envelope(amp.gain, t, 0.32, 0.05, 0.75);
    osc.connect(shaper).connect(lp).connect(amp);
    route(g, amp, 0.1, 0);
    osc.start(t);
    osc.stop(t + 0.9);
  },

  // ---- 乱闘 ----

  /** 乱闘：開始のゴング（カーン、カーン）＋場内がどよめく */
  brawlStart(): void {
    const g = audio();
    if (!g) return;
    const t = g.ctx.currentTime;
    bell(g, t, 880, 0.3);
    bell(g, t + 0.32, 880, 0.3);
    crowd.react('roar', 0.7);
  },

  /** 乱闘：KO（重い一撃＋ゴングの連打＋総立ち） */
  ko(): void {
    const g = audio();
    if (!g) return;
    const t = g.ctx.currentTime;
    tone(g, { at: t, freq: 110, freqEnd: 40, dur: 0.4, gain: 0.8, send: 0.3 });
    noise(g, { at: t, dur: 0.2, gain: 0.55, type: 'lowpass', freq: 700, send: 0.3 });
    for (let i = 0; i < 3; i += 1) bell(g, t + 0.25 + i * 0.16, 900, 0.26);
    crowd.react('roar', 1);
  },

  // ---- 乱闘v3（フェーズXX-72）：ストIIの音の役割をひととおり ----
  //
  // 桜井ノウハウ「音の優先度や大きさはプレイヤーに大きく関係するものをより大きくする」＝
  // **決着（KO）＞超必殺・必殺技の命中＞通常技の命中＞技の出だし・動き**の階層を守る。
  // 出だしの音（風切り）は小さく、当たった音だけを大きくする＝**音で当たったかが分かる**。

  /** 技の振り（当たり判定が出た瞬間の風切り）。蹴りは低く長く、重い技ほど太い */
  brawlSwing(kick: boolean, heavy: boolean): void {
    const g = audio();
    if (!g) return;
    noise(g, {
      dur: heavy ? 0.16 : 0.09,
      gain: heavy ? 0.26 : 0.18,
      type: 'bandpass',
      freq: kick ? 380 : 700,
      freqEnd: kick ? 1400 : 2600,
      q: 1.2,
      attack: 0.015,
    });
  },

  /** 命中。重い当たり（ダウン・必殺技）は低い芯を足して長く響かせる */
  brawlImpact(heavy: boolean, pan = 0): void {
    const g = audio();
    if (!g) return;
    tone(g, { freq: heavy ? 120 : 170, freqEnd: heavy ? 38 : 70, dur: heavy ? 0.3 : 0.14, gain: heavy ? 0.85 : 0.6, pan });
    noise(g, { dur: heavy ? 0.16 : 0.08, gain: heavy ? 0.6 : 0.45, type: 'lowpass', freq: heavy ? 800 : 1300, send: heavy ? 0.25 : 0.12, pan });
    noise(g, { dur: 0.02, gain: 0.45, type: 'highpass', freq: 2800, pan });
    if (heavy) crowd.react('ooh', 0.55);
  },

  /** ガードされた（硬い「バシッ」＝素通しの重い音と聞き分けられる） */
  brawlBlock(pan = 0): void {
    const g = audio();
    if (!g) return;
    noise(g, { dur: 0.045, gain: 0.4, type: 'bandpass', freq: 2400, q: 2.8, send: 0.1, pan });
    tone(g, { freq: 620, freqEnd: 480, dur: 0.05, gain: 0.16, type: 'triangle', pan });
  },

  /** 気を溜めて撃つ（波動拳・真空波動拳）。溜めの低いうなり→放つ「ボウッ」 */
  brawlProjectile(big: boolean): void {
    const g = audio();
    if (!g) return;
    const t = g.ctx.currentTime;
    tone(g, { at: t, freq: 180, freqEnd: big ? 520 : 380, dur: 0.18, gain: 0.25, type: 'sawtooth', attack: 0.06 });
    noise(g, { at: t + 0.1, dur: big ? 0.45 : 0.32, gain: big ? 0.5 : 0.38, type: 'bandpass', freq: 500, freqEnd: 1800, q: 0.9, send: 0.3 });
    tone(g, { at: t + 0.1, freq: big ? 220 : 300, freqEnd: 90, dur: 0.35, gain: 0.35, send: 0.25 });
  },

  /** 飛び道具どうしの相殺（弾ける高い火花） */
  brawlClash(): void {
    const g = audio();
    if (!g) return;
    noise(g, { dur: 0.25, gain: 0.5, type: 'highpass', freq: 3200, send: 0.35 });
    tone(g, { freq: 1500, freqEnd: 400, dur: 0.22, gain: 0.25, type: 'square' });
  },

  /** 昇る技（昇龍拳・サマーソルト・バット龍拳）。上へ抜ける風と炎 */
  brawlRising(fire: boolean): void {
    const g = audio();
    if (!g) return;
    noise(g, { dur: 0.3, gain: 0.35, type: 'bandpass', freq: 400, freqEnd: 3200, q: 0.9, attack: 0.01, send: 0.2 });
    if (fire) noise(g, { dur: 0.45, gain: 0.3, type: 'lowpass', freq: 1500, freqEnd: 500, send: 0.3 });
  },

  /** 回転する蹴り（竜巻旋風脚）。風切りを3回重ねる */
  brawlSpin(): void {
    const g = audio();
    if (!g) return;
    const t = g.ctx.currentTime;
    for (let i = 0; i < 3; i += 1) {
      noise(g, { at: t + i * 0.12, dur: 0.1, gain: 0.22, type: 'bandpass', freq: 500, freqEnd: 1900, q: 1.3, attack: 0.02 });
    }
  },

  /** 突進（頭突き・急降下キック）。低い突風 */
  brawlDash(): void {
    const g = audio();
    if (!g) return;
    noise(g, { dur: 0.22, gain: 0.3, type: 'lowpass', freq: 900, freqEnd: 300, attack: 0.02 });
  },

  /** 掴んだ（衣擦れ）→ 叩きつけ（重い「ドサッ」＋場内のどよめき） */
  brawlGrab(): void {
    const g = audio();
    if (!g) return;
    noise(g, { dur: 0.08, gain: 0.3, type: 'bandpass', freq: 1400, q: 0.8 });
  },
  brawlSlam(): void {
    const g = audio();
    if (!g) return;
    tone(g, { freq: 90, freqEnd: 34, dur: 0.35, gain: 0.85, send: 0.25 });
    noise(g, { dur: 0.25, gain: 0.55, type: 'lowpass', freq: 500, send: 0.3 });
    crowd.react('ooh', 0.6);
  },

  /** 投げ抜け（弾き合う「パァン」） */
  brawlTech(): void {
    const g = audio();
    if (!g) return;
    noise(g, { dur: 0.06, gain: 0.5, type: 'bandpass', freq: 1800, q: 1.5, send: 0.2 });
  },

  /** 倒れる・着地（体が地面に落ちる） */
  brawlThud(heavy: boolean): void {
    const g = audio();
    if (!g) return;
    tone(g, { freq: heavy ? 80 : 110, freqEnd: 40, dur: heavy ? 0.25 : 0.1, gain: heavy ? 0.6 : 0.22 });
    noise(g, { dur: heavy ? 0.2 : 0.06, gain: heavy ? 0.35 : 0.12, type: 'lowpass', freq: 600 });
  },

  /** ピヨった（頭の上で鳥が鳴くような高いさえずり） */
  brawlDizzy(): void {
    const g = audio();
    if (!g) return;
    const t = g.ctx.currentTime;
    for (let i = 0; i < 4; i += 1) {
      tone(g, { at: t + i * 0.13, freq: 2600, freqEnd: 3400, dur: 0.07, gain: 0.08, type: 'sine' });
    }
    crowd.react('gasp', 0.5);
  },

  /** 子分を呼ぶ（指笛） */
  brawlWhistle(): void {
    const g = audio();
    if (!g) return;
    const t = g.ctx.currentTime;
    tone(g, { at: t, freq: 2100, freqEnd: 2700, dur: 0.12, gain: 0.18 });
    tone(g, { at: t + 0.13, freq: 2700, freqEnd: 1900, dur: 0.22, gain: 0.18 });
  },

  /** 超必殺の暗転（キラッ＋低い「ドン」） */
  brawlSuperFlash(): void {
    const g = audio();
    if (!g) return;
    const t = g.ctx.currentTime;
    tone(g, { at: t, freq: 55, freqEnd: 30, dur: 0.6, gain: 0.7, send: 0.35 });
    for (const [i, f] of [1320, 1760, 2640].entries()) {
      tone(g, { at: t + i * 0.05, freq: f, dur: 0.4, gain: 0.14, type: 'triangle', send: 0.4 });
    }
    crowd.react('roar', 0.6);
  },

  /** ゲージが満タンになった（上がっていく3音） */
  brawlMeterFull(): void {
    const g = audio();
    if (!g) return;
    const t = g.ctx.currentTime;
    [880, 1109, 1319].forEach((f, i) => tone(g, { at: t + i * 0.06, freq: f, dur: 0.14, gain: 0.12, type: 'square' }));
  },

  /** ラウンドの呼び出し（ゴング1つ） */
  brawlRound(): void {
    const g = audio();
    if (!g) return;
    bell(g, g.ctx.currentTime, 880, 0.28);
  },

  /** 「ファイト！」（ゴング2つ＋場内が沸く） */
  brawlFight(): void {
    const g = audio();
    if (!g) return;
    const t = g.ctx.currentTime;
    bell(g, t, 990, 0.3);
    bell(g, t + 0.14, 990, 0.3);
    crowd.react('roar', 0.6);
  },

  /** 残り10秒の秒読み */
  brawlTick(): void {
    const g = audio();
    if (!g) return;
    tone(g, { freq: 1600, dur: 0.035, gain: 0.1, type: 'square' });
  },

  /** 時間切れ（ブザー） */
  brawlTimeUp(): void {
    const g = audio();
    if (!g) return;
    tone(g, { freq: 196, dur: 0.6, gain: 0.3, type: 'square' });
    tone(g, { freq: 208, dur: 0.6, gain: 0.2, type: 'square' });
  },

  /** 試合終了（場内が沸く。勝敗のジングルは BGM の側） */
  win(): void {
    crowd.react('cheer', 0.9);
  },

  // ---- メニュー ----

  /** カーソル移動（小さく乾いた音） */
  menuMove(): void {
    const g = audio();
    if (!g) return;
    tone(g, { freq: 1650, dur: 0.035, gain: 0.08, type: 'triangle' });
    noise(g, { dur: 0.008, gain: 0.06, type: 'highpass', freq: 5000 });
  },

  /** 決定（明るく上がる2音） */
  menuConfirm(): void {
    const g = audio();
    if (!g) return;
    const t = g.ctx.currentTime;
    tone(g, { at: t, freq: 988, dur: 0.06, gain: 0.12, type: 'square' });
    tone(g, { at: t + 0.06, freq: 1480, dur: 0.12, gain: 0.12, type: 'square' });
  },

  /** 戻る・取り消し（下がる2音） */
  menuCancel(): void {
    const g = audio();
    if (!g) return;
    const t = g.ctx.currentTime;
    tone(g, { at: t, freq: 740, dur: 0.06, gain: 0.1, type: 'square' });
    tone(g, { at: t + 0.06, freq: 494, dur: 0.1, gain: 0.1, type: 'square' });
  },
};
