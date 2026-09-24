/**
 * 実戦バランスの詰め（フェーズI-29）の**計測レポート**。
 *
 *   npm run balance
 *
 * で、未確認事項に溜まっていた数値を一度に測って表にする。**数値を動かす前と後で
 * 同じ表を出して比べる**のが使い方で、調整の根拠はここの出力から取る。
 * 帯として固定したものは `tests/balance.test.ts` にある（回帰はそちらが止める）。
 */
import { BALLPARKS, DEFAULT_BALLPARK, type Ballpark } from '../../src/core/ballpark';
import type { BattingProfile } from '../../src/core/batting';
import { SPEED_FAST, SPEED_NEUTRAL, SPEED_SLOW } from '../../src/core/pitch';
import { HOT_MODIFIER } from '../../src/core/condition';
import { LAUNCH_BASE_DEG } from '../../src/core/batting';
import {
  BASE_PATH,
  BIKE_OVERRUN_DISTANCE,
  BIKE_SPEED_SCALE,
  RUNNER_SPEED,
  RUNNER_SPEED_MAX,
  RUNNER_SPEED_MIN,
  type FielderId,
} from '../../src/core/fielding';
import { DEFAULT_LOADOUT } from '../../src/core/brawl';
import { type SkillId, brawlLoadoutFor } from '../../src/core/skills';
import { matchup } from './brawl';
import { carryOf, fenceInfo, heightAtFence, requiredExitSpeed } from './physics';
import { pct, summarize, sweep } from './sweep';

const STEPS = 10;

function heading(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function row(cells: (string | number)[], widths: number[]): void {
  console.log(
    cells
      .map((c, i) => {
        const s = String(c);
        return i === 0 ? s.padEnd(widths[i]) : s.padStart(widths[i]);
      })
      .join(' '),
  );
}

const hitter = (power: number, average: number): BattingProfile => ({ power, average });

/** 乱闘でいちばん強くなる組（前提2つ＋デュオ） */
const DUO_BUILD: readonly SkillId[] = ['shoryuken', 'bukimochikomi', 'battoshoryuken'];

// ---- 1. 球場ごとの打球の帰結（実寸フェンスでHRが減った件。C-14の未確認事項） ----

function reportParks(): void {
  heading('1. 球場ごとの帰結（右打者・基準速36m/s・接触した打球の一様分布）');
  const widths = [12, 7, 7, 7, 7, 7, 7, 8];
  row(['球場', '中堅', 'HR率', '長打率', '安打率', 'ファウル', '最大飛距離', '芯の帰結'], widths);
  for (const park of BALLPARKS) {
    for (const [label, batter] of [
      ['長打力0.0', hitter(0, 0.5)],
      ['長打力0.5', hitter(0.5, 0.5)],
      ['長打力1.0', hitter(1, 0.5)],
    ] as const) {
      const s = summarize(sweep({ park, batter, steps: STEPS }));
      row(
        [
          `${park.name}/${label}`,
          park.center,
          pct(s.homerunRate),
          pct(s.extraBase / s.inPlay),
          pct(s.hitRate),
          pct(s.foul / s.total),
          s.maxCarry.toFixed(1),
          s.center?.outcome.kind ?? '-',
        ],
        widths,
      );
    }
  }
}

// ---- 2. 球速とHR（速球ほど飛ぶ＝速球のリスク） ----

function reportPitchSpeed(): void {
  heading('2. 球速ごとのHR率（ところざわ・長打力0.5）');
  const widths = [16, 8, 8, 10, 10];
  row(['球速', 'HR率', '安打率', '芯の初速', '芯の飛距離'], widths);
  for (const [label, speed] of [
    ['フォーク 22m/s', SPEED_SLOW],
    ['基準 36m/s', SPEED_NEUTRAL],
    ['速球 42m/s', SPEED_FAST],
  ] as const) {
    const s = summarize(
      sweep({ park: DEFAULT_BALLPARK, batter: hitter(0.5, 0.5), pitchSpeed: speed, steps: STEPS }),
    );
    row(
      [
        label,
        pct(s.homerunRate),
        pct(s.hitRate),
        s.center ? s.center.exitSpeed.toFixed(1) : '-',
        s.center ? s.center.carry.toFixed(1) : '-',
      ],
      widths,
    );
  }
}

// ---- 3. 打球方向とタイミングの関係（HRが減った件の構造的な原因） ----

function reportDirection(): void {
  heading('3. タイミングと打球方向・飛距離（ところざわ・長打力0.5・基準速）');
  const widths = [10, 10, 10, 10, 12];
  row(['タイミング', '方向(度)', '初速', '飛距離', '帰結'], widths);
  const samples = sweep({ park: DEFAULT_BALLPARK, batter: hitter(0.5, 0.5), steps: STEPS });
  for (const s of samples.filter((x) => x.course === 0)) {
    row(
      [
        s.timing.toFixed(1),
        s.result.directionDeg.toFixed(1),
        s.result.exitSpeed.toFixed(1),
        s.result.carry.toFixed(1),
        s.result.outcome.kind,
      ],
      widths,
    );
  }
}

// ---- 4. 好調（ゼッコーチョー）の効き（D-19の未確認事項） ----

function reportHot(): void {
  heading('4. 好調の効き（AV+0.2 / HR+0.2。ところざわ・基準速）');
  const widths = [16, 8, 8, 10, 10];
  row(['打者', 'HR率', '安打率', '芯の初速', '芯の飛距離'], widths);
  const base: BattingProfile[] = [hitter(0.2, 0.3), hitter(0.5, 0.5), hitter(0.8, 0.7)];
  for (const b of base) {
    for (const hot of [false, true]) {
      const batter = hot
        ? hitter(
            Math.min(1, b.power + (HOT_MODIFIER.power ?? 0)),
            Math.min(1, b.average + (HOT_MODIFIER.average ?? 0)),
          )
        : b;
      const s = summarize(sweep({ park: DEFAULT_BALLPARK, batter, steps: STEPS }));
      row(
        [
          `HR${b.power.toFixed(1)}/AV${b.average.toFixed(1)}${hot ? ' 好調' : ''}`,
          pct(s.homerunRate),
          pct(s.hitRate),
          s.center ? s.center.exitSpeed.toFixed(1) : '-',
          s.center ? s.center.carry.toFixed(1) : '-',
        ],
        widths,
      );
    }
  }
}

// ---- 5. 守備範囲スキル（捕球半径。F-26-7の未確認事項） ----

function reportCatchRadius(): void {
  heading('5. 捕球半径の上乗せ（ドウブツ系統のスキル。ところざわ・長打力0.5）');
  const widths = [14, 8, 8, 10, 10];
  row(['上乗せ', '安打率', 'HR率', 'フライアウト', 'ゴロアウト'], widths);
  for (const bonus of [0, 0.4, 0.6, 1.0, 1.5, 2.5, 4.3]) {
    const s = summarize(
      sweep({
        park: DEFAULT_BALLPARK,
        batter: hitter(0.5, 0.5),
        catchBonus: () => bonus,
        steps: STEPS,
      }),
    );
    row(
      [
        `+${bonus.toFixed(1)}m`,
        pct(s.hitRate),
        pct(s.homerunRate),
        pct(s.flyout / s.inPlay),
        pct(s.groundout / s.inPlay),
      ],
      widths,
    );
  }
}

// ---- 5b. 守備範囲スキルを「1人だけ」に付けた場合（実際に起きる形） ----

function reportCatchRadiusSingle(): void {
  heading('5b. 捕球半径の上乗せを1人だけに付けた場合（スキルは選手に付くので実際はこちら）');
  const widths = [16, 8, 10, 10];
  row(['付ける相手', '安打率', 'フライアウト', 'ゴロアウト'], widths);
  const base = summarize(sweep({ park: DEFAULT_BALLPARK, batter: hitter(0.5, 0.5), steps: STEPS }));
  row(['(なし)', pct(base.hitRate), pct(base.flyout / base.inPlay), pct(base.groundout / base.inPlay)], widths);
  for (const id of ['CF', 'SS', '1B'] as FielderId[]) {
    for (const bonus of [1.0, 4.3]) {
      const s = summarize(
        sweep({
          park: DEFAULT_BALLPARK,
          batter: hitter(0.5, 0.5),
          catchBonus: (f) => (f === id ? bonus : 0),
          steps: STEPS,
        }),
      );
      row(
        [
          `${id} +${bonus.toFixed(1)}m`,
          pct(s.hitRate),
          pct(s.flyout / s.inPlay),
          pct(s.groundout / s.inPlay),
        ],
        widths,
      );
    }
  }
}

// ---- 8. 走力とバイク（F-26-3の未確認事項「乗る価値のある場面が狭すぎないか」） ----

function reportRunner(): void {
  heading('8. 走者の速さと内野安打（ところざわ・長打力0.5。バイクは2倍速）');
  const widths = [18, 10, 10, 10];
  row(['走者', '安打率', 'ゴロアウト', '内野安打'], widths);
  for (const [label, speed] of [
    ['鈍足 6.8m/s', RUNNER_SPEED_MIN],
    ['平均 7.5m/s', RUNNER_SPEED],
    ['俊足 8.2m/s', RUNNER_SPEED_MAX],
    ['バイク 15.0m/s', RUNNER_SPEED * BIKE_SPEED_SCALE],
  ] as const) {
    const s = summarize(
      sweep({ park: DEFAULT_BALLPARK, batter: hitter(0.5, 0.5), runnerSpeed: speed, steps: STEPS }),
    );
    row(
      [label, pct(s.hitRate), pct(s.groundout / s.inPlay), pct(s.beatThrow / s.inPlay)],
      widths,
    );
  }
  console.log(
    `  参考：塁間 ${BASE_PATH}m を 平均${(BASE_PATH / RUNNER_SPEED).toFixed(2)}秒 / ` +
      `バイク${(BASE_PATH / (RUNNER_SPEED * BIKE_SPEED_SCALE)).toFixed(2)}秒。` +
      `オーバーラン ${BIKE_OVERRUN_DISTANCE}m の戻りは徒歩で ${(
        BIKE_OVERRUN_DISTANCE / RUNNER_SPEED
      ).toFixed(2)}秒`,
  );
}

// ---- 6. 方角ごとのフェンスと、越えるのに要る初速（HRが出にくい構造の正体） ----

function reportFence(): void {
  heading('6. 方角ごとのフェンスと必要初速（打ち上げ角21°＝芯で捉えたとき）');
  const widths = [8, 10, 8, 12, 14];
  for (const park of [BALLPARKS[0], BALLPARKS[2], BALLPARKS[5]]) {
    console.log(`--- ${park.name}（中堅${park.center}m / 両翼${park.wing}m）`);
    row(['方角', 'フェンス', '高さ', '必要初速', '芯43m/sの高さ'], widths);
    for (const deg of [0, 10, 20, 30, 40, 45]) {
      const fence = fenceInfo(park, deg);
      const need = requiredExitSpeed(park, deg, LAUNCH_BASE_DEG);
      row(
        [
          `${deg}°`,
          fence.distance.toFixed(1),
          fence.height.toFixed(1),
          Number.isFinite(need) ? need.toFixed(1) : '不可',
          heightAtFence(park, 43, LAUNCH_BASE_DEG, deg).toFixed(2),
        ],
        widths,
      );
    }
  }
}

// ---- 7. 打ち上げ角と飛距離（柵なしの純粋な物理） ----

function reportCarry(): void {
  heading('7. 初速×打ち上げ角の飛距離 m（柵なし。現在の芯の角度は21°）');
  const angles = [15, 18, 21, 24, 27, 30, 33];
  const widths = [8, ...angles.map(() => 7)];
  row(['初速', ...angles.map((a) => `${a}°`)], widths);
  for (const speed of [36, 40, 43, 46, 49]) {
    row(
      [`${speed}m/s`, ...angles.map((a) => carryOf(speed, a).toFixed(0))],
      widths,
    );
  }
}

// ---- 9. 乱闘v3（XX-72。詳しくは `npm run balance:brawl`） ----

function reportBrawl(): void {
  heading('9. 乱闘：スキルから組んだ装備（打者側）×素の相手。CPUどうし36通り');
  const widths = [24, 8, 10, 8];
  row(['装備', '勝率', '1R秒', '時間切'], widths);
  for (const [label, skills] of [
    ['素', []],
    ['昇龍拳', ['shoryuken']],
    ['武器持ち込み', ['bukimochikomi']],
    ['デュオ バット龍拳', DUO_BUILD],
  ] as const) {
    const m = matchup(brawlLoadoutFor(skills as readonly SkillId[]), DEFAULT_LOADOUT);
    row(
      [label, pct(m.batterWins / m.games), m.avgRoundSeconds.toFixed(1), pct(m.timeUpRate)],
      widths,
    );
  }
}

function main(): void {
  const parks: Ballpark[] = [...BALLPARKS];
  console.log(`球場 ${parks.length}／格子 ${(STEPS * 2 + 1) ** 2} 点（タイミング×コース）`);
  reportParks();
  reportPitchSpeed();
  reportDirection();
  reportHot();
  reportCatchRadius();
  reportCatchRadiusSingle();
  reportRunner();
  reportFence();
  reportCarry();
  reportBrawl();
}

main();
