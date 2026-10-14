/**
 * CPU投手の内外角と、立ち位置という手がかり（フェーズBBB-84。`npm run balance:tell` で測った帯）。
 *
 * BBB-83 が見つけた穴＝**CPU投手の内外角は投げる前に100%読めた**（ボール数＋ファウル数の偶奇で
 * 決まり、投手の立ち位置にも必ず出ていた）ので、人間の打者は読んで寄るだけで打率 .36・
 * 本塁打 7%/打席・11点/試合になっていた。
 *
 * BBB-84 は内外角を別系列から引き、立ち位置を「外れる手がかり」にした。**最初に入れた形
 * （どちらの側に立っても逆を突く）は、読む打者しか測らずに決めた**ので、読まずに寄り切る打者
 * （死球のもらい得＋外角の長打）のほうがはるかに強いことを見落とした。仕上げの形は3つ：
 *
 * 1. **逆を突くのは、打者の外角側に立って内角のストライクへ投げるときだけ**
 * 2. **CPU投手は、踏み込んでいる打者の体へ投げない**（リリースの瞬間に反対側へ投げ直す）
 * 3. **投げた後に踏み込んで当たった球は死球にしない**
 *
 * 規則と球の形は `tests/cpuPitchSides.test.ts`。ここは**帰結の帯**＝値そのものではなく
 * 「どちらが大きいか」「どのくらいの範囲か」で書く（`tests/balance.test.ts` と同じ約束）。
 * 打席は 先発16人×打線9人×`REPS` 回（ぶれと内外角の系列は1本を共有＝何度走らせても同じ数字）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CPU_CROSS_CHANCE } from '../src/core/cpuPitcher';
import type { AtBatOptions } from '../tools/balance/atbat';
import {
  type League,
  FIRST_CUT,
  HITS_CROWDERS,
  center,
  crowd,
  halfCrowd,
  leanTruth,
  league,
  standOff,
  stepIntoInsideBallLate,
  trustTell,
} from '../tools/balance/tell';

// 同期の計測が続くので、テストの合間にイベントループを1周させる（`tests/balance.test.ts` と同じ）
afterEach(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/** 1つの対戦を回す回数（`balance:tell` の本番は24。帯を読むにはこれで足りる） */
const REPS = 8;
const TIMEOUT = 60000;

/**
 * 同じ計測を何度も回さない（1本あたり1〜2秒かかる）。
 *
 * **緩急と勝負球は CCC-86 の前（いつもの形）で回す**（`mixes: null`）＝ここは BBB-84 が内外角を
 * 決めた世界をそのまま再現する帯（緩急がカウントだけで決まり、追い込んだ1球は外へ逃げた頃）。
 * CCC-86 で配球のくじが入った後も、BBB-84 の結論（立ち位置を信じる打者が、読まずに寄る打者を
 * 下回らない）が保たれることは `tests/pitchPace.test.ts` が確かめる。
 */
const cache = new Map<string, League>();
function run(key: string, opts: AtBatOptions, chance: number | null = CPU_CROSS_CHANCE): League {
  let hit = cache.get(key);
  if (!hit) {
    hit = league({ mixes: null, ...opts }, chance, REPS);
    cache.set(key, hit);
  }
  return hit;
}

/** 投げた後に、内角のボール球へ踏み込む打者（リリースの瞬間は立ち位置を信じた場所にいる） */
const STEP_LATE: AtBatOptions = { stanceAtReleaseFor: trustTell, stanceFor: stepIntoInsideBallLate };

/** BBB-83 までの規則（内外角＝偶奇・必ず立ち位置どおり・寄っている打者にも当てる） */
const before = {
  center: () => run('before-center', { ...HITS_CROWDERS, stanceFor: center }, null),
  read: () => run('before-read', { ...HITS_CROWDERS, stanceFor: leanTruth(1) }, null),
  crowd: () => run('before-crowd', { ...HITS_CROWDERS, stanceFor: crowd }, null),
  cpu: () => run('before-cpu', { ...HITS_CROWDERS }, null),
};
/** 最初に入れた形（どちらの側に立っても逆を突く・寄っている打者にも当てる） */
const first = {
  trust: () => run('first-trust', { ...FIRST_CUT, stanceFor: trustTell }),
  crowd: () => run('first-crowd', { ...FIRST_CUT, stanceFor: crowd }),
  stepLate: () => run('first-step', { ...FIRST_CUT, ...STEP_LATE }),
  cpu: () => run('first-cpu', { ...FIRST_CUT }),
};
/** 採用（外角側に立ったときだけ内角へ逆を突く・当てない・踏み込んだ球は死球にしない） */
const after = {
  center: () => run('after-center', { stanceFor: center }),
  trust: () => run('after-trust', { stanceFor: trustTell }),
  crowd: () => run('after-crowd', { stanceFor: crowd }),
  half: () => run('after-half', { stanceFor: halfCrowd }),
  off: () => run('after-off', { stanceFor: standOff }),
  stepLate: () => run('after-step', STEP_LATE),
  cpu: () => run('after-cpu', {}),
};

describe('穴そのもの（BBB-83 までの規則）', () => {
  it(
    '読みが外れない世界では、読んで寄り切る打者が中央の2倍以上の点を取る',
    () => {
      // 実測：寄り切る 11.3点/試合（打率.360・本塁打7.6%）対 中央 4.1点（.223・1.7%）
      expect(before.read().runs).toBeGreaterThan(before.center().runs * 2);
      expect(before.read().hr).toBeGreaterThan(before.center().hr * 2.5);
      expect(before.read().avg).toBeGreaterThan(before.center().avg + 0.1);
    },
    TIMEOUT,
  );

  it(
    '寄っている打者にも内角のボール球を当てていた＝読まずに寄り切るだけで、読む打者より点を取れた',
    () => {
      // 実測：いつも寄り切る 14.5点/試合・死球 18.5%（読んで寄り切る 11.3点・死球 0%）。
      // 得点期待は出塁率が高い打線ほど標本の揺れが大きいので、帯は死球と出塁率で持つ
      expect(before.crowd().hbp).toBeGreaterThan(0.1);
      expect(before.crowd().obp).toBeGreaterThan(before.read().obp);
      expect(before.crowd().runs).toBeGreaterThan(before.center().runs * 2);
    },
    TIMEOUT,
  );
});

describe('最初に入れた形の見落とし（どちらの側に立っても逆を突く・寄っている打者にも当てる）', () => {
  it(
    '読まずに寄り切る打者が、立ち位置を信じる打者の2倍の点を取った（読む打者しか測っていなかった）',
    () => {
      // 実測：いつも寄り切る 14.0点/試合・死球 17.2% 対 信じる 6.6点
      expect(first.crowd().hbp).toBeGreaterThan(0.1);
      expect(first.crowd().runs).toBeGreaterThan(first.trust().runs * 1.5);
    },
    TIMEOUT,
  );

  it(
    '投げた後に内角のボール球へ踏み込む打者も、死球で大きく得をした',
    () => {
      // 実測：13.5点/試合・死球 17.1%（外す球は必ず立ち位置どおり＝来ると分かる）
      expect(first.stepLate().hbp).toBeGreaterThan(0.1);
      expect(first.stepLate().runs).toBeGreaterThan(first.trust().runs * 1.3);
    },
    TIMEOUT,
  );
});

describe('死球のもらい得は消えた（採用）', () => {
  it(
    '最初から寄り切っている打者には、CPU投手が当てない',
    () => {
      // 実測：死球 17.4% → 0.0%（残るのは、打席の中央でも当たる荒れ球だけ＝T-41）
      expect(after.crowd().hbp).toBeLessThan(0.02);
    },
    TIMEOUT,
  );

  it(
    '投げた後に踏み込んで当たっても、一塁はもらえない',
    () => {
      // 実測：死球 17.1% → 0.0%・得点 13.5 → 8.2点/試合（立ち位置を信じるだけの打者 7.5点）。
      // 信じるだけの打者より少し高いのは死球ではなく四球のぶん（7.0→9.2%）＝踏み込むと内角の
      // 外す球にバットが届かず、追い込まれても振らない（計測の打者は2ストライクで際どい球を振る）。
      // 人間は踏み込まなくても、来ると分かっている外す球を見送れば同じだけ取れる。
      expect(after.stepLate().hbp).toBeLessThan(0.005);
      expect(after.stepLate().runs).toBeLessThan(first.stepLate().runs * 0.8);
      expect(after.stepLate().obp).toBeLessThan(first.stepLate().obp - 0.02);
    },
    TIMEOUT,
  );

  it(
    '立ち位置を信じて寄る打者は、逆を突かれても死球をもらわない',
    () => {
      expect(after.trust().hbp).toBeLessThan(0.005);
    },
    TIMEOUT,
  );
});

describe('立ち位置を信じる打者が、読まずに寄る打者を下回らない（採用）', () => {
  it(
    '立ち位置を信じる打者は、読まずに寄り切る打者より打率・出塁率がはっきり高く、得点も下回らない',
    () => {
      // 実測（3456打席／6912打席）：信じる .314/.362・7.5点／.315/.364・7.2点
      //                              寄り切る .241/.305・6.4点／.241/.310・6.9点
      // 得点期待は打線ごとの揺れが大きい（同じ打ち方でも標本で 1点ほど動く）ので、
      // 帯は打率と出塁率で持ち、得点は「下回らない」だけを見る
      expect(after.trust().avg).toBeGreaterThan(after.crowd().avg + 0.02);
      expect(after.trust().obp).toBeGreaterThan(after.crowd().obp + 0.01);
      expect(after.trust().runs).toBeGreaterThan(after.crowd().runs * 0.9);
    },
    TIMEOUT,
  );

  it(
    '中央のまま・離れて立つ打者よりは、はっきり点を取る（手がかりは死んでいない）',
    () => {
      // 実測：信じる 7.5点/試合／いつも半分寄る 5.0／中央 4.2／離れる 3.0
      const trust = after.trust().runs;
      expect(trust).toBeGreaterThan(after.half().runs * 1.05);
      expect(trust).toBeGreaterThan(after.center().runs * 1.3);
      expect(trust).toBeGreaterThan(after.off().runs * 1.5);
    },
    TIMEOUT,
  );

  it(
    'どちらの側に立っても逆を突く形（採らなかった）では、死球を消しても寄り切るほうが得だった',
    () => {
      // 実測：いつも寄り切る 8.7点 対 信じる 6.6点（内角側に立って外角へ逆を突いた球が、寄った打者の芯へ行く）
      const both: AtBatOptions = { aims: { crossBothWays: true } };
      const crowded = run('both-crowd', { ...both, stanceFor: crowd });
      const trusted = run('both-trust', { ...both, stanceFor: trustTell });
      expect(crowded.hbp).toBeLessThan(0.02);
      expect(crowded.runs).toBeGreaterThan(trusted.runs * 1.1);
      // 採用の形では、寄り切る打者の取り分がそこから下がり、信じる打者の取り分が上がる
      expect(after.crowd().obp).toBeLessThan(crowded.obp - 0.015);
      expect(after.trust().obp).toBeGreaterThan(trusted.obp);
    },
    TIMEOUT,
  );

  it(
    'それでも、読みが外れなかった頃よりはっきり低い（寄るのが賭けになった）',
    () => {
      // 実測：読んで寄り切る 11.3点 → 信じる 7.5点／本塁打 7.6% → 4.6%／打率 .360 → .314
      expect(after.trust().runs).toBeLessThan(before.read().runs * 0.85);
      expect(after.trust().hr).toBeLessThan(before.read().hr * 0.85);
      expect(after.trust().avg).toBeLessThan(before.read().avg - 0.02);
      // 読まずに寄るだけで取れていた点（14.5点）は、半分以下になった（6.4点）
      expect(after.crowd().runs).toBeLessThan(before.crowd().runs * 0.7);
    },
    TIMEOUT,
  );

  it(
    '割合を上げるほど、信じる打者の上積みは小さくなる（0 ＞ 採用 ＞ 1/2）',
    () => {
      const always = run('q0-trust', { stanceFor: trustTell }, 0);
      const coin = run('qhalf-trust', { stanceFor: trustTell }, 0.5);
      expect(always.runs).toBeGreaterThan(after.trust().runs);
      expect(after.trust().runs).toBeGreaterThan(coin.runs);
      // 必ず立ち位置どおり（0）なら、内外角を引いても穴は開いたまま＝引くだけでは足りない
      // （得点は標本の揺れが大きいので打率で見る）
      expect(always.avg).toBeGreaterThan(before.read().avg - 0.04);
      // **BBB-85（野手の足 7.0m/s）で差が縮んだ**：寄って外角を捉えた長打を、速くなった外野手が
      // 捕るようになった（`balance:tell` の4段目：割合0 で .352・採用 .308。この標本では .317 対 .308）。
      // 向き（必ず立ち位置どおりのほうが打てる）は変わらない
      expect(always.avg).toBeGreaterThan(after.trust().avg);
    },
    TIMEOUT,
  );
});

describe('打席の左右の偏りが消える', () => {
  const singleShare = (r: League, hand: 'R' | 'L'): number => r.bySide[hand].single / r.bySide[hand].n;
  const extraShare = (r: League, hand: 'R' | 'L'): number => r.bySide[hand].extra / r.bySide[hand].n;

  it(
    'BBB-83 までは初球が必ず一塁側＝右打者は長打・左打者は単打に偏っていた',
    () => {
      // 実測：右 単打6.1%・二塁打+12.4%／左 単打19.7%・二塁打+2.5%
      expect(singleShare(before.cpu(), 'L')).toBeGreaterThan(singleShare(before.cpu(), 'R') * 2);
      expect(extraShare(before.cpu(), 'R')).toBeGreaterThan(extraShare(before.cpu(), 'L') * 2);
    },
    TIMEOUT,
  );

  it(
    '立つ側を五分五分に引き、逆を突く向きを打者から見た内角にそろえると、右打者と左打者の内訳がそろう',
    () => {
      const r = after.cpu();
      const ratio = (a: number, b: number): number => Math.max(a, b) / Math.min(a, b);
      expect(ratio(singleShare(r, 'R'), singleShare(r, 'L'))).toBeLessThan(1.7);
      expect(ratio(extraShare(r, 'R'), extraShare(r, 'L'))).toBeLessThan(1.7);
    },
    TIMEOUT,
  );
});

describe('CPU打者 vs CPU投手の水準（計測の基準）', () => {
  it(
    '打率・三振・四球・本塁打は実際の野球の帯にとどまる',
    () => {
      // 実測：打率 .251／三振 16.3%／四球 8.3%／本塁打 1.2%／4.5点（実際の野球 .250／22%／8.5%／3.0%／約4.5点）
      const r = after.cpu();
      expect(r.avg).toBeGreaterThan(0.2);
      expect(r.avg).toBeLessThan(0.31);
      expect(r.k).toBeGreaterThan(0.08);
      expect(r.k).toBeLessThan(0.25);
      expect(r.bb).toBeGreaterThan(0.04);
      expect(r.bb).toBeLessThan(0.14);
      expect(r.hr).toBeGreaterThan(0.005);
      expect(r.hr).toBeLessThan(0.045);
    },
    TIMEOUT,
  );

  it(
    '踏み込んだCPU打者への死球が消えた（最初に入れた形では 7% まで増えていた）',
    () => {
      // 実測：死球 BBB-83 まで 3.2% → 最初の形 6.1% → 採用 0.0%（実際の野球は1%未満）。
      // 直前のストライクへ寄るCPU打者（O-36）に、内角の外す球がそのまま当たっていた。
      expect(first.cpu().hbp).toBeGreaterThan(before.cpu().hbp);
      expect(after.cpu().hbp).toBeLessThan(0.02);
    },
    TIMEOUT,
  );
});
