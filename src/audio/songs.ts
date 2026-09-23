/**
 * BGMの曲データ（ブラッシュアップ：すべて書き下ろし。ファミコン音源風の4チャンネル）。
 *
 * 記法（1トークン＝1音。長さは16分音符いくつぶんか。1小節＝16）：
 * - `C5:4`＝C5を4ステップ。`-:4`＝休符。`#`/`b` で半音（`F#5`・`Bb4`）。
 * - `@Am4:16`＝Am の和音（根音 A4）を1ステップずつ上下に分散（アルペジオ）。`/2` で2ステップずつ。
 * - ドラム（noise）＝`k` キック・`s` スネア・`h` ハイハット・`o` オープン・`c` クラッシュ。
 *   `k+h:2` で同時に鳴らす。
 * - `|` は小節線（読みやすさのためだけ。**パース時に小節が16ステップちょうどか検査する**）。
 *
 * 曲は `music.ts` が鳴らす。**原作の曲は使わない**（著作物のため）。雰囲気だけを寄せる。
 */

export type Channel = 'pulse1' | 'pulse2' | 'tri' | 'noise';

export interface NoteEvent {
  step: number;
  len: number;
  midi?: number;
  drum?: string;
}

export interface Track {
  channel: Channel;
  /** 矩形波のデューティ比（0.125 / 0.25 / 0.5） */
  duty?: number;
  /** チャンネル内の音量の倍率 */
  volume?: number;
  events: NoteEvent[];
}

export interface Song {
  bpm: number;
  /** 曲の長さ（ステップ） */
  length: number;
  tracks: Track[];
}

const PITCH: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function noteToMidi(name: string): number {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`songs: 音名が読めない ${name}`);
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return 12 * (Number(m[3]) + 1) + PITCH[m[1]] + acc;
}

const CHORD: Record<string, number[]> = {
  '': [0, 4, 7, 12, 7, 4],
  m: [0, 3, 7, 12, 7, 3],
  '7': [0, 4, 7, 10, 7, 4],
  maj7: [0, 4, 7, 11, 7, 4],
  m7: [0, 3, 7, 10, 7, 3],
  sus4: [0, 5, 7, 12, 7, 5],
  dim: [0, 3, 6, 9, 6, 3],
};

/** 1トラックぶんの記法を音符の並びへ */
function parse(src: string, label: string): { events: NoteEvent[]; length: number } {
  const events: NoteEvent[] = [];
  let step = 0;
  let barStart = 0;
  let bar = 1;
  for (const token of src.trim().split(/\s+/)) {
    if (token === '|') {
      if (step - barStart !== 16) {
        throw new Error(`songs: ${label} の${bar}小節目が ${step - barStart} ステップ（16のはず）`);
      }
      barStart = step;
      bar += 1;
      continue;
    }
    const [head, lenPart] = token.split(':');
    const [lenText, perText] = (lenPart ?? '2').split('/');
    const len = Number(lenText);
    if (!Number.isFinite(len) || len <= 0) throw new Error(`songs: ${label} の長さが読めない ${token}`);
    if (head === '-') {
      step += len;
      continue;
    }
    if (head.startsWith('@')) {
      const m = /^@([A-G][#b]?)(maj7|m7|sus4|dim|7|m)?(-?\d)$/.exec(head);
      if (!m) throw new Error(`songs: ${label} の和音が読めない ${token}`);
      const root = noteToMidi(`${m[1]}${m[3]}`);
      const shape = CHORD[m[2] ?? ''];
      const per = Number(perText ?? '1');
      for (let i = 0; i * per < len; i += 1) {
        events.push({ step: step + i * per, len: per, midi: root + shape[i % shape.length] });
      }
      step += len;
      continue;
    }
    if (/^[kshoc](\+[kshoc])*$/.test(head)) {
      for (const d of head.split('+')) events.push({ step, len, drum: d });
      step += len;
      continue;
    }
    events.push({ step, len, midi: noteToMidi(head) });
    step += len;
  }
  if (step - barStart !== 16 && step !== barStart) {
    throw new Error(`songs: ${label} の最後の小節が ${step - barStart} ステップ（16のはず）`);
  }
  return { events, length: step };
}

/**
 * ベースライン（三角波）。和音の根音から「根音・5度・オクターブ・5度」の4分音符を作る
 * （球場のオルガン風に弾む形）。`['Gm','C']` は1小節を半分ずつ。
 */
function bassLine(bars: readonly (string | readonly [string, string])[], octave = 2): string {
  const rootOf = (chord: string): number => {
    const m = /^([A-G][#b]?)/.exec(chord)!;
    return noteToMidi(`${m[1]}${octave}`);
  };
  const name = (midi: number): string => {
    const names = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
    return `${names[midi % 12]}${Math.floor(midi / 12) - 1}`;
  };
  const out: string[] = [];
  for (const bar of bars) {
    if (typeof bar === 'string') {
      const r = rootOf(bar);
      out.push(`${name(r)}:4 ${name(r + 7)}:4 ${name(r + 12)}:4 ${name(r + 7)}:4 |`);
    } else {
      const a = rootOf(bar[0]);
      const b = rootOf(bar[1]);
      out.push(`${name(a)}:4 ${name(a + 12)}:4 ${name(b)}:4 ${name(b + 12)}:4 |`);
    }
  }
  return out.join(' ');
}

/** 和音の分散（pulse2）。1小節ぶんずつ和音名から作る */
function arpLine(bars: readonly (string | readonly [string, string])[], octave = 4, per = 1): string {
  const out: string[] = [];
  for (const bar of bars) {
    if (typeof bar === 'string') out.push(`@${bar}${octave}:16/${per} |`);
    else out.push(`@${bar[0]}${octave}:8/${per} @${bar[1]}${octave}:8/${per} |`);
  }
  return out.join(' ');
}

function song(
  bpm: number,
  parts: { channel: Channel; src: string; duty?: number; volume?: number }[],
  label: string,
): Song {
  let length = 0;
  const tracks: Track[] = parts.map((p) => {
    const parsed = parse(p.src, `${label}/${p.channel}`);
    length = Math.max(length, parsed.length);
    return { channel: p.channel, duty: p.duty, volume: p.volume, events: parsed.events };
  });
  return { bpm, length, tracks };
}

const repeat = (s: string, n: number): string => Array.from({ length: n }, () => s).join(' ');

// ---- 試合中（F長調・弾む4つ打ち。いちばん長く聴く曲なので、8小節の歌＋8小節の展開） ----

const GAME_CHORDS = [
  'F', 'Dm', 'Bb', 'C', 'F', 'Dm', ['Gm', 'C'], 'F',
  'Bb', 'C', 'Am', 'Dm', 'Gm', 'C', 'F', 'C7',
] as const;

const GAME = song(
  138,
  [
    {
      channel: 'pulse1',
      duty: 0.5,
      src: `
        C5:2 A4:2 C5:2 F5:4 E5:2 D5:2 C5:2 | D5:2 C5:2 A4:2 F4:4 A4:2 D5:4 |
        D5:4 C5:2 Bb4:2 A4:2 Bb4:2 C5:4 | G4:6 A4:2 Bb4:2 C5:2 E5:4 |
        C5:2 A4:2 C5:2 F5:4 G5:2 A5:2 G5:2 | F5:4 E5:2 D5:2 A4:4 D5:4 |
        Bb4:4 D5:4 C5:2 Bb4:2 G4:4 | F4:8 -:4 C5:2 E5:2 |
        F5:4 D5:2 Bb4:2 D5:4 F5:4 | E5:4 C5:2 G4:2 C5:4 E5:4 |
        A5:6 G5:2 F5:2 E5:2 C5:4 | D5:6 E5:2 F5:4 A5:4 |
        G5:4 F5:2 E5:2 D5:4 Bb4:4 | C5:4 D5:2 E5:2 G5:4 E5:4 |
        F5:4 A5:4 G5:2 F5:2 E5:2 D5:2 | C5:4 E5:2 G5:2 Bb5:4 C6:4 |`,
    },
    { channel: 'pulse2', duty: 0.125, src: arpLine(GAME_CHORDS, 4) },
    { channel: 'tri', src: bassLine(GAME_CHORDS, 2) },
    {
      channel: 'noise',
      src: repeat('k:2 h:2 s:2 h:2 k:2 k:2 s:2 h:2 |', 15) + ' k:2 h:2 s:2 h:2 s:2 s:2 s:1 s:1 s:2 |',
    },
  ],
  'game',
);

// ---- タイトル（C長調・行進曲風の明るいファンファーレ） ----

const TITLE_CHORDS = ['C', 'G', 'Am', 'F', 'C', 'G', ['F', 'G'], 'C'] as const;

const TITLE = song(
  148,
  [
    {
      channel: 'pulse1',
      duty: 0.25,
      src: `
        E5:2 G5:2 C6:4 B5:2 G5:2 E5:4 | D5:2 G5:2 B5:4 A5:2 G5:2 D5:4 |
        C5:2 E5:2 A5:4 G5:2 E5:2 C5:4 | F5:4 E5:2 D5:2 C5:4 A4:4 |
        E5:2 G5:2 C6:4 D6:2 C6:2 G5:4 | B5:4 A5:2 G5:2 D5:4 G5:4 |
        A5:4 F5:4 B5:4 G5:4 | C6:8 G5:2 E5:2 C5:4 |`,
    },
    { channel: 'pulse2', duty: 0.5, volume: 0.9, src: arpLine(TITLE_CHORDS, 4, 2) },
    { channel: 'tri', src: bassLine(TITLE_CHORDS, 2) },
    { channel: 'noise', src: repeat('k:4 s:2 h:2 k:4 s:2 s:2 |', 7) + ' k:2 s:2 s:2 s:2 k:2 s:1 s:1 s:2 s:2 |' },
  ],
  'title',
);

// ---- チャンス（G長調・応援歌風。同じ掛け声を繰り返して盛り上げる） ----

const CHANCE_CHORDS = ['G', 'G', 'C', 'D', 'G', 'G', ['C', 'D'], 'G'] as const;

const CHANCE = song(
  164,
  [
    {
      channel: 'pulse1',
      duty: 0.25,
      src: `
        G5:2 G5:2 G5:2 B5:4 A5:2 G5:4 | D5:2 E5:2 G5:2 A5:4 G5:2 E5:4 |
        E5:2 E5:2 E5:2 G5:4 E5:2 C5:4 | D5:2 E5:2 F#5:2 A5:4 F#5:2 D5:4 |
        G5:2 G5:2 G5:2 B5:4 A5:2 G5:4 | B5:2 C6:2 D6:2 B5:4 A5:2 G5:4 |
        E5:4 G5:4 A5:4 F#5:4 | G5:8 D5:2 E5:2 F#5:4 |`,
    },
    { channel: 'pulse2', duty: 0.125, src: arpLine(CHANCE_CHORDS, 4) },
    { channel: 'tri', src: bassLine(CHANCE_CHORDS, 2) },
    { channel: 'noise', src: repeat('k:2 h:2 s:2 h:2 k:2 h:2 s:2 s:2 |', 7) + ' s:2 s:2 s:2 s:2 s:1 s:1 s:1 s:1 k+c:4 |' },
  ],
  'chance',
);

// ---- 乱闘（E短調・速い8分の刻みで煽る） ----

const BRAWL = song(
  172,
  [
    {
      channel: 'pulse1',
      duty: 0.25,
      src: `
        E5:2 -:2 E5:2 G5:2 A5:4 G5:2 E5:2 | B5:4 A5:2 G5:2 A5:2 G5:2 E5:4 |
        C6:4 B5:2 A5:2 G5:4 E5:4 | D6:4 C6:2 B5:2 A5:4 F#5:4 |
        E5:2 -:2 E5:2 G5:2 A5:4 B5:2 A5:2 | G5:2 A5:2 B5:2 D6:2 E6:4 D6:2 B5:2 |
        C6:4 A5:4 D#6:4 F#5:4 | E6:8 B5:2 G5:2 E5:4 |`,
    },
    {
      channel: 'pulse2',
      duty: 0.125,
      // B7 は1つ低い3オクターブ目から（`@B73` ＝ 根音B・7の和音・3オクターブ）
      src: '@Em4:16 | @Em4:16 | @C4:16 | @D4:16 | @Em4:16 | @Em4:16 | @C4:8 @B73:8 | @Em4:16 |',
    },
    {
      channel: 'tri',
      src: `
        E2:2 E2:2 E3:2 E2:2 D3:2 E2:2 B2:2 E2:2 | E2:2 E2:2 E3:2 E2:2 G2:2 E2:2 B2:2 E2:2 |
        C2:2 C2:2 C3:2 C2:2 G2:2 C2:2 C3:2 C2:2 | D2:2 D2:2 D3:2 D2:2 A2:2 D2:2 D3:2 D2:2 |
        E2:2 E2:2 E3:2 E2:2 D3:2 E2:2 B2:2 E2:2 | E2:2 E2:2 E3:2 E2:2 G2:2 E2:2 B2:2 E2:2 |
        C2:2 C3:2 C2:2 C3:2 B1:2 B2:2 B1:2 B2:2 | E2:2 E2:2 B2:2 E2:2 E3:8 |`,
    },
    { channel: 'noise', src: repeat('k:2 k:2 s:2 k:2 k:2 k:2 s:2 h:2 |', 7) + ' s:1 s:1 s:1 s:1 s:2 s:2 k+c:8 |' },
  ],
  'brawl',
);

// ---- スキル抽選（D短調・ゆったりした分散和音。考える時間の曲） ----

const DRAFT_CHORDS = ['Dm7', 'G', 'Dm7', 'G', 'Bbmaj7', 'C', 'Am7', 'A7'] as const;

const DRAFT = song(
  100,
  [
    {
      channel: 'pulse1',
      duty: 0.125,
      volume: 0.9,
      src: `
        A4:4 C5:4 D5:8 | B4:4 D5:4 E5:8 | F5:4 E5:4 D5:4 C5:4 | D5:12 -:4 |
        F5:4 E5:4 D5:4 A4:4 | G4:4 C5:4 E5:8 | A5:4 G5:4 E5:4 C5:4 | C#5:8 E5:4 A4:4 |`,
    },
    { channel: 'pulse2', duty: 0.25, volume: 0.8, src: arpLine(DRAFT_CHORDS, 3, 2) },
    { channel: 'tri', volume: 0.8, src: bassLine(DRAFT_CHORDS, 2) },
    { channel: 'noise', volume: 0.6, src: repeat('k:4 h:4 h:4 h:4 |', 8) },
  ],
  'draft',
);

// ---- ジングル（1回きり） ----

const HOMERUN = song(
  176,
  [
    { channel: 'pulse1', duty: 0.25, src: 'G4:2 C5:2 E5:2 G5:2 C6:4 G5:2 C6:2 | E6:4 D6:2 C6:2 D6:4 G5:4 | C6:16 |' },
    { channel: 'pulse2', duty: 0.5, src: 'E4:2 G4:2 C5:2 E5:2 G5:4 E5:2 G5:2 | C6:4 B5:2 A5:2 B5:4 D5:4 | E5:16 |' },
    { channel: 'tri', src: 'C3:4 C3:4 C3:4 C3:4 | F2:4 F2:4 G2:4 G2:4 | C2:16 |' },
    { channel: 'noise', src: 's:1 s:1 s:1 s:1 k:4 s:4 k:2 s:2 | k:4 s:4 k:4 s:2 s:2 | k+c:16 |' },
  ],
  'homerun',
);

const CHANGE = song(
  160,
  [
    { channel: 'pulse1', duty: 0.25, src: 'C6:2 G5:2 E5:2 G5:2 C6:8 |' },
    { channel: 'pulse2', duty: 0.5, src: 'E5:2 C5:2 G4:2 C5:2 E5:8 |' },
    { channel: 'tri', src: 'C3:4 G2:4 C2:8 |' },
    { channel: 'noise', src: 's:2 s:2 s:2 s:2 k+c:8 |' },
  ],
  'change',
);

const WIN = song(
  150,
  [
    { channel: 'pulse1', duty: 0.25, src: 'G5:3 G5:1 G5:2 E5:2 G5:4 C6:4 | B5:2 A5:2 G5:2 A5:2 B5:4 D6:4 | C6:16 |' },
    { channel: 'pulse2', duty: 0.5, src: 'E5:3 E5:1 E5:2 C5:2 E5:4 G5:4 | G5:2 F5:2 E5:2 F5:2 G5:4 B5:4 | E5:16 |' },
    { channel: 'tri', src: 'C3:8 G2:8 | F2:8 G2:8 | C3:16 |' },
    { channel: 'noise', src: 'k:4 s:4 k:4 s:4 | k:4 s:4 k:2 s:2 s:2 s:2 | k+c:16 |' },
  ],
  'win',
);

const LOSE = song(
  104,
  [
    { channel: 'pulse1', duty: 0.25, src: 'G4:4 F4:4 Eb4:4 D4:4 | C4:16 |' },
    { channel: 'pulse2', duty: 0.125, src: 'Eb4:4 D4:4 C4:4 B3:4 | G3:16 |' },
    { channel: 'tri', src: 'C3:8 G2:8 | C2:16 |' },
  ],
  'lose',
);

export const SONGS = { title: TITLE, game: GAME, chance: CHANCE, brawl: BRAWL, draft: DRAFT } as const;
export type SongName = keyof typeof SONGS;

export const JINGLES = { homerun: HOMERUN, change: CHANGE, win: WIN, lose: LOSE } as const;
export type JingleName = keyof typeof JINGLES;
