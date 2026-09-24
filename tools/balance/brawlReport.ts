/**
 * `npm run balance:brawl`：乱闘v3の計測（フェーズXX-72）。CPUどうしを36通り戦わせて、
 * 装備ごとの勝ち方（勝率・1ラウンドの長さ・時間切れの割合・ガードされた割合…）を並べる。
 */
import { type FighterLoadout, DEFAULT_LOADOUT, NO_PASSIVES } from '../../src/core/brawl';
import { brawlLoadoutFor } from '../../src/core/skills';
import type { SkillId } from '../../src/core/skills';
import { matchup } from './brawl';

function heading(text: string): void {
  console.log(`\n=== ${text} ===`);
}

function row(cells: Array<string | number>, widths: number[]): void {
  console.log(cells.map((c, i) => String(c).padEnd(widths[i] ?? 10)).join(''));
}

const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;

const loadout = (partial: Partial<FighterLoadout>): FighterLoadout => ({
  ...DEFAULT_LOADOUT,
  ...partial,
  passives: { ...NO_PASSIVES, ...(partial.passives ?? {}) },
});

export const BRAWL_BUILDS: ReadonlyArray<[string, FighterLoadout]> = [
  ['素', DEFAULT_LOADOUT],
  ['波動拳', loadout({ specials: ['hadou'] })],
  ['昇龍拳', loadout({ specials: ['shoryu'] })],
  ['竜巻旋風脚', loadout({ specials: ['tatsu'] })],
  ['頭突き', loadout({ specials: ['zutsuki'] })],
  ['百裂張り手', loadout({ specials: ['hyakuretsu'] })],
  ['スクリュー', loadout({ specials: ['screw'] })],
  ['武器', loadout({ specials: ['buki'], powerScale: 1.2 })],
  ['子分', loadout({ specials: ['kobun'] })],
  ['体力+60', loadout({ maxHp: 180 })],
  ['威力1.3', loadout({ powerScale: 1.3 })],
  ['波動+昇龍', loadout({ specials: ['hadou', 'shoryu'] })],
  ['真空波動拳', loadout({ specials: ['hadou', 'tatsu'], super: 'shinku' })],
];

export function reportBrawlMatrix(builds: ReadonlyArray<[string, FighterLoadout]> = BRAWL_BUILDS): void {
  heading('乱闘：装備ごと（打者側）×素の相手（投手側）。CPUどうし36通り');
  const widths = [14, 8, 10, 8, 9, 8, 8, 8, 8, 8];
  row(['装備', '勝率', '1R秒', '時間切', 'R/試合', '当/R', 'ガード', '必殺/R', '投げ/R', '最大連'], widths);
  for (const [label, lo] of builds) {
    const m = matchup(lo, DEFAULT_LOADOUT);
    row(
      [
        label,
        pct(m.batterWins / m.games),
        m.avgRoundSeconds.toFixed(1),
        pct(m.timeUpRate),
        m.avgRounds.toFixed(2),
        m.hitsPerRound.toFixed(1),
        pct(m.blockRate),
        m.specialsPerRound.toFixed(1),
        m.throwsPerRound.toFixed(1),
        m.maxCombo,
      ],
      widths,
    );
  }
}

function reportSkillBuilds(): void {
  heading('スキルから組んだ装備（打者側）×素の相手');
  const builds: Array<[string, readonly SkillId[]]> = [
    ['素', []],
    ['昇龍拳', ['shoryuken']],
    ['武器持ち込み', ['bukimochikomi']],
    ['バット龍拳（デュオ）', ['shoryuken', 'bukimochikomi', 'battoshoryuken']],
  ];
  const widths = [22, 8, 10, 8];
  row(['スキル', '勝率', '1R秒', '時間切'], widths);
  for (const [label, skills] of builds) {
    const m = matchup(brawlLoadoutFor(skills), DEFAULT_LOADOUT);
    row([label, pct(m.batterWins / m.games), m.avgRoundSeconds.toFixed(1), pct(m.timeUpRate)], widths);
  }
}

function main(): void {
  reportBrawlMatrix();
  reportSkillBuilds();
}

main();
