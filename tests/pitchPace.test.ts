/**
 * CPU投手の配球のくじ＝緩急と、追い込んでからの勝負球（フェーズCCC-86。`npm run balance:pace` で測った帯）。
 *
 * BBB-84 で内外角は読めなくなったが、配球にはまだ**投げる前に分かる**ものが2つ残っていた：
 * **球速はカウントだけで決まる**（初球は必ず速球…）＝カウントを読む打者は三振3%／
 * **追い込んだ1球は荒れていなくてもボール**＝追い込まれたら振らないだけで1試合に数点多く取れた。
 *
 * 2026-10-14 ユーザー判断：**いつもの形は手がかりとして残し、くじが当たったときだけ外す**
 * （緩急は 1/3・決め球も・3ボールの置き球はそのまま／勝負球の割合は計測で＝1/3）。
 *
 * 規則は `tests/cpuPitchMix.test.ts`。ここは**帰結の帯**＝値そのものではなく「どちらが大きいか」
 * 「どのくらいの範囲か」で書く。打者の合わせ方は仮定なので、帯は**本当の時間差の半分**
 * （`pace.ts` の `TIMING_MODELS[1]`）で書き、向きが仮定によらないことは `balance:pace` で確かめてある。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AtBatOptions } from '../tools/balance/atbat';
import {
  ADOPTED_MIX,
  type MixRule,
  type PaceLeague,
  TWO_STRIKE_TAKE,
  TWO_STRIKE_ZONE_ONLY,
  paceLeague,
  waitActual,
  waitFixed,
  waitUsual,
} from '../tools/balance/pace';
import { crowd } from '../tools/balance/tell';

// 同期の計測が続くので、テストの合間にイベントループを1周させる（`tests/balance.test.ts` と同じ）
afterEach(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/** 1つの対戦を回す回数（`balance:pace` の本番は24） */
const REPS = 12;
const TIMEOUT = 90000;
/** 本当の時間差の半分だけ合わせ直せる人間（`TIMING_MODELS[1]`） */
const HALF = 0.5;

const cache = new Map<string, PaceLeague>();
function run(key: string, opts: AtBatOptions, rule: MixRule | null): PaceLeague {
  let hit = cache.get(key);
  if (!hit) {
    hit = paceLeague({ hardTiming: HALF, ...opts }, rule, REPS);
    cache.set(key, hit);
  }
  return hit;
}

const before = {
  usual: () => run('before-usual', { waitFor: waitUsual }, null),
  actual: () => run('before-actual', { waitFor: waitActual }, null),
  fast: () => run('before-fast', { waitFor: waitFixed('fast') }, null),
  take: () => run('before-take', { waitFor: waitUsual, ...TWO_STRIKE_TAKE }, null),
};
const after = {
  usual: () => run('after-usual', { waitFor: waitUsual }, ADOPTED_MIX),
  actual: () => run('after-actual', { waitFor: waitActual }, ADOPTED_MIX),
  fast: () => run('after-fast', { waitFor: waitFixed('fast') }, ADOPTED_MIX),
  neutral: () => run('after-neutral', { waitFor: waitFixed('neutral') }, ADOPTED_MIX),
  take: () => run('after-take', { waitFor: waitUsual, ...TWO_STRIKE_TAKE }, ADOPTED_MIX),
  zone: () => run('after-zone', { waitFor: waitUsual, ...TWO_STRIKE_ZONE_ONLY }, ADOPTED_MIX),
  cpu: () => run('after-cpu', { stanceFor: undefined, hardTiming: undefined }, ADOPTED_MIX),
  crowd: () => run('after-crowd', { waitFor: waitUsual, stanceFor: crowd }, ADOPTED_MIX),
};

describe('穴その1：球速はカウントだけで決まっていた（CCC-86 の前）', () => {
  it(
    'カウントの傾向を待つ打者は、本当の球速を知る打者（読みの札）とまったく同じ＝三振はほとんど無い',
    () => {
      expect(before.usual()).toEqual(before.actual());
      expect(before.usual().k).toBeLessThan(0.05);
    },
    TIMEOUT,
  );
});

describe('穴その2：追い込んだ1球は荒れていなくてもボールだった（CCC-86 の前）', () => {
  it(
    '追い込まれたら振らないだけで、出塁率も得点もはっきり上がった',
    () => {
      // 実測（24回）：出塁率 .389 → .461・得点 7.0 → 8.7点/試合
      expect(before.take().obp).toBeGreaterThan(before.usual().obp + 0.05);
      expect(before.take().runs).toBeGreaterThan(before.usual().runs * 1.15);
    },
    TIMEOUT,
  );
});

describe('採用：緩急は読めるが外れる', () => {
  it(
    'カウントの傾向を待つ打者の三振は、外れなかった頃の倍以上・打率は下がる',
    () => {
      expect(after.usual().k).toBeGreaterThan(before.usual().k * 2);
      expect(after.usual().avg).toBeLessThan(before.usual().avg - 0.02);
    },
    TIMEOUT,
  );

  it(
    '傾向を読むのは今も得＝いつも同じ速さを待つ（読まない）打ち方より三振が少ない',
    () => {
      expect(after.usual().k).toBeLessThan(after.fast().k);
      expect(after.usual().k).toBeLessThan(after.neutral().k);
      expect(after.usual().avg).toBeGreaterThan(after.neutral().avg);
    },
    TIMEOUT,
  );

  it(
    '本当の球速を知る（読みの札＝`予知` ほか）は、ここで初めて値打ちを持つ',
    () => {
      // いままでは札が無くてもカウントで分かった（上の「穴その1」）
      expect(after.actual().k).toBeLessThan(after.usual().k - 0.03);
      expect(after.actual().avg).toBeGreaterThan(after.usual().avg);
    },
    TIMEOUT,
  );
});

describe('採用：追い込まれたら振らないだけでは得をしない', () => {
  it(
    '振らない打者は、普通に打つ打者を上回らない（見逃し三振が増える）',
    () => {
      expect(after.take().runs).toBeLessThan(after.usual().runs);
      expect(after.take().k).toBeGreaterThan(after.usual().k + 0.04);
      // 前は振らないほうが 1試合に数点多く取れた
      expect(after.take().runs).toBeLessThan(before.take().runs * 0.7);
    },
    TIMEOUT,
  );

  it(
    'ゾーンの球だけを振る（見極める）打者への報酬は残る',
    () => {
      expect(after.zone().runs).toBeGreaterThan(after.usual().runs);
      expect(after.zone().bb).toBeGreaterThan(after.usual().bb);
    },
    TIMEOUT,
  );
});

describe('BBB-84 の結論は保たれる', () => {
  it(
    '立ち位置を信じる打者（`paceLeague` の既定）は、読まずに寄り切る打者より打率がはっきり高く、得点も下回らない',
    () => {
      expect(after.usual().avg).toBeGreaterThan(after.crowd().avg + 0.02);
      expect(after.usual().runs).toBeGreaterThan(after.crowd().runs * 0.9);
    },
    TIMEOUT,
  );
});

describe('CPU打者 vs CPU投手の水準（計測の基準。画面には出ない）', () => {
  it(
    '打率・三振・本塁打は帯にとどまり、四球は少ない側（CPU打者は追い込まれたら隅の1つ外まで必ず振る）',
    () => {
      const r = after.cpu();
      expect(r.avg).toBeGreaterThan(0.2);
      expect(r.avg).toBeLessThan(0.31);
      expect(r.k).toBeGreaterThan(0.06);
      expect(r.k).toBeLessThan(0.25);
      expect(r.bb).toBeGreaterThan(0.01);
      expect(r.bb).toBeLessThan(0.1);
      expect(r.hr).toBeGreaterThan(0.003);
    },
    TIMEOUT,
  );
});
