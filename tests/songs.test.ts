/**
 * BGMの曲データ（ブラッシュアップ：`src/audio/songs.ts`）。
 *
 * 曲は手書きの記法から組むので、**書き間違いは読み込みの時点で投げる**（小節が16ステップで
 * ない・音名が読めない）。ここでは「全曲が組める」ことと、ループ曲が小節の切れ目で
 * きれいに一周することを固定する（半端な長さだと、ループの継ぎ目でリズムがずれる）。
 */
import { describe, expect, it } from 'vitest';
import { JINGLES, SONGS } from '../src/audio/songs';

describe('BGMの曲データ', () => {
  it('全曲が組める（記法の書き間違いは読み込みで投げる）', () => {
    expect(Object.keys(SONGS).length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(JINGLES).length).toBeGreaterThanOrEqual(4);
  });

  it('ループ曲はすべてのチャンネルが同じ長さで、小節の切れ目で一周する', () => {
    for (const [name, song] of Object.entries(SONGS)) {
      expect(song.length % 16, name).toBe(0);
      for (const track of song.tracks) {
        const end = Math.max(...track.events.map((e) => e.step + e.len));
        expect(end, `${name}/${track.channel}`).toBeLessThanOrEqual(song.length);
        // 最後の音がループの継ぎ目をまたがない
        expect(end, `${name}/${track.channel}`).toBeGreaterThan(song.length - 16);
      }
    }
  });

  it('音域はファミコン音源の現実的な範囲に収まる（低すぎる／高すぎる音は鳴らさない）', () => {
    for (const [name, song] of [...Object.entries(SONGS), ...Object.entries(JINGLES)]) {
      for (const track of song.tracks) {
        for (const e of track.events) {
          if (e.midi === undefined) continue;
          expect(e.midi, `${name}/${track.channel}`).toBeGreaterThanOrEqual(23); // B0
          expect(e.midi, `${name}/${track.channel}`).toBeLessThanOrEqual(100); // E7
        }
      }
    }
  });

  it('テンポは曲の役割どおり（乱闘・チャンスは試合中より速く、抽選はゆったり）', () => {
    expect(SONGS.brawl.bpm).toBeGreaterThan(SONGS.game.bpm);
    expect(SONGS.chance.bpm).toBeGreaterThan(SONGS.game.bpm);
    expect(SONGS.draft.bpm).toBeLessThan(SONGS.game.bpm);
  });
});
