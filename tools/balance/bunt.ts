/**
 * 送りバントが成立しない理由の分解と、成立させうるレバーの計測（フェーズY-46）。
 *
 *   npm run balance:bunt
 *
 * ## なぜもう一度測るのか（X-45との違い）
 *
 * X-45（`balance:offense` の1〜6段目）は「**CPUに送りバントをさせるか**」を問いにして、
 * 答えは「全塁状況・全アウト・全打者で損＝させない」だった。そこで閉じたのは
 * **CPUの采配**のほうで、**バントという操作そのものが損である**という事実は
 * 人間側にも残っている＝**原作 説明書p17 が送りバントを技術として紹介している**
 * （「バットをななめに出し、ファールラインぎりぎりに転がすのがコツ」）ことに対する
 * 差分としてPROGRESS.mdに記録された。Y-46はそちらを問いにする。
 *
 * X-45は「送球速度を1/3にするしかない」で止まったが、**それは1つのレバーしか
 * 動かさなかったときの話**。ここでは不足を秒に分解し、レバーごとに
 * **(a) 不足をどれだけ埋めるか / (b) 既存の境界をどれだけ動かすか**を並べる。
 * J-30が `THROW_SPEED` を据え置くと決めた理由は「内野ゴロ・犠飛・盗塁・けん制の
 * 境界を全部同時に壊す」ことなので、**壊さないレバーがあるかどうか**が問い。
 *
 * ## この計測が決めたこと（結論）
 *
 * - **問題の言い直しがいちばんの成果**（1段目）：捕手が盗塁を刺す経路 2.74秒に対し、
 *   バントを拾って二塁へ投げる経路は 2.26秒＝**転がすと守備が0.48秒“速くなる”**
 *   （実際の野球と逆）。だからH-28で走らせてから転がしても損だった。
 * - **採ったのは費用ゼロの2つ**：**A 打球でもリードを保つ**（2段目。打者走者は本塁から
 *   走るので既存の境界を1つも動かさない）と、**D 押しバント**（4・4b段目。
 *   `BUNT_PUSH_EXIT_SPEED`=17m/s・`BUNT_MAX_DIRECTION_DEG`=±44°）。
 * - **退けたのは2つ**：**B ゴロの持ち替え**（6段目。内野安打が 25→32本＝I-29の帯を
 *   張り直すことになる）と、**E 一・三塁手の突っ込み**（5段目。3B 0.90秒 < P 1.10秒＝
 *   **守備がむしろ速くなる**ので逆効果）。
 * - **17m/s は帯の内側でいちばん遠くへ転がる値**（4b段目）＝弱いと捕手が空中で捕る
 *   小フライ、強いと三塁手の立っている三塁まで転がる。**正面へ押すと投手が空中で捕る**
 *   （4段目）＝押しは方向を当てて初めて得。
 *   → **フェーズBBB-82（野手の足を原作の 6.0m/s に）で 17→13 へ解き直した**：投手が遅く
 *   なって、17m/s は三塁手の手前まで転がる（足の速い打者が必ず内野安打）／16〜16.5m/s は
 *   誰が打っても全員セーフ。基準を「いちばん足の速い打者でも一塁で刺される最大の初速」へ
 *   置き直した（4c段目）。
 * - **CPUにはバントを入れない**（8段目）＝得になるのは「無死・走者一塁・長打力0.45以下」
 *   の1場面だけ（+0.6〜+1.6pt）で、しかも走者を同時に走らせる必要がある。
 *
 * **1段目だけは Y-46 を入れる前の値**（`LEGACY_*`）で回す＝「埋めるべき不足はいくら
 * だったのか」を後から再現できるようにするため。それ以外の段は現在の定数で回る。
 *
 * ## 何を再利用しているか
 *
 * - **バントの打球は `judgeBunt`、その後の守備は `simulatePlay`**（X-45と同じ土台）。
 * - **送球と走者の時間競争は `sim.ts` の `throwOut` と同じ式**（`retires`）。
 *   X-45の同名関数と同じ式で、**現行値では `simulatePlay` 自身の判定と一致すること**を
 *   1段目で突き合わせる。
 * - **仮定を振る（バントの初速・角度）ときだけ打球ベクトルをこちらで組む**（`buntLaunch`）。
 *   現行の定数で `judgeBunt` と完全に一致することを起動時に確認する（ずれたら投げる）。
 */
import {
  BUNT_EXIT_SPEED,
  BUNT_LAUNCH_DEG,
  BUNT_MAX_DIRECTION_DEG,
  BUNT_PUSH_EXIT_SPEED,
  type BattedBallLaunch,
  judgeBunt,
} from '../../src/core/batting';
import {
  type BaseKey,
  type FielderId,
  type Vec2,
  BASE_ARRIVE_RADIUS,
  BASE_PATH,
  BASE_POSITIONS,
  CATCH_RADIUS,
  FIELDER_HOME_POSITIONS,
  FIELDER_SPEED,
  MAX_LEAD,
  RUNNER_SPEED,
  STEAL_CATCH_RELEASE_SEC,
  STEAL_LEAD,
  THROW_SPEED,
  distance,
  pickoffOutLead,
  runnerSpeed,
  stealSafeJumpSec,
} from '../../src/core/fielding';
import { createBattedBall, stepBattedBall } from '../../src/core/batting';
import { DEFAULT_BALLPARK } from '../../src/core/ballpark';
import {
  type BatterSide,
  LEFT_BATTER_SIDE,
  RIGHT_BATTER_SIDE,
  STRIKE_ZONE_HALF_WIDTH,
} from '../../src/core/pitch';
import { chooseCpuPitchPlan } from '../../src/core/cpuPitcher';
import { pitcherControl } from '../../src/core/roster';
import { TEAMS, fielderRowStats, pitcherRowPitching } from '../../src/core/teams';
import { CATCH_MIN_PLAY_SEC, PICKUP_THROW_DELAY_SEC, SIM_DT, simulatePlay } from './sim';
import {
  type PaDistribution,
  type ScoreProbability,
  baseStateLabel,
  distributionFor,
  paScoreProb,
  solveScoreProbability,
} from './runExpectancy';
import { pct, sweep } from './sweep';

const row = (cells: readonly string[], width = 10): string =>
  cells.map((c) => c.padStart(width)).join('');

// ---- バントの打球（仮定を振れる形。現行値は judgeBunt と一致することを確認する） ----

/** 初速 m/s と方向（度。負＝三塁側）からバントの打球ベクトルを作る */
function buntLaunch(speed: number, deg: number): BattedBallLaunch {
  const directionRad = (deg * Math.PI) / 180;
  const launchRad = (BUNT_LAUNCH_DEG * Math.PI) / 180;
  const horizontal = speed * Math.cos(launchRad);
  return {
    vx: horizontal * Math.sin(directionRad),
    vy: speed * Math.sin(launchRad),
    vz: -horizontal * Math.cos(directionRad),
  };
}

{
  // 現行の定数で `judgeBunt` と完全に一致することの確認（ここがずれると以降が全部嘘になる）
  for (const aim of [-1, 0, 1] as const) {
    const a = judgeBunt(0, aim)!;
    const b = buntLaunch(BUNT_EXIT_SPEED, aim * BUNT_MAX_DIRECTION_DEG);
    const gap = Math.max(Math.abs(a.vx - b.vx), Math.abs(a.vy - b.vy), Math.abs(a.vz - b.vz));
    if (gap > 1e-9) throw new Error(`buntLaunch が judgeBunt と一致しない（aim=${aim}, 差=${gap}）`);
  }
}

interface Fielded {
  by: FielderId | string;
  sec: number;
  pos: Vec2;
  /** 本塁からの距離 */
  depth: number;
  /** `simulatePlay` 自身の判定（打者走者を一塁で刺せたか） */
  simGroundout: boolean;
  /** 打ち上がって直接捕られた／ファウル（送りバントとして成立しない） */
  spoiled: '小フライ' | 'ファウル' | null;
}

function fieldBunt(speed: number, deg: number): Fielded | null {
  const result = simulatePlay(buntLaunch(speed, deg), 0);
  const kind = result.outcome.kind;
  if (kind === 'flyout') {
    return { by: result.outcome.by, sec: result.seconds, pos: { x: 0, z: 0 }, depth: 0, simGroundout: false, spoiled: '小フライ' };
  }
  if (kind === 'foul') {
    return { by: '-', sec: result.seconds, pos: { x: 0, z: 0 }, depth: 0, simGroundout: false, spoiled: 'ファウル' };
  }
  if (result.fielded === undefined) return null; // 誰も拾わなかった＝安打
  return {
    by: result.fielded.by,
    sec: result.fielded.sec,
    pos: result.fielded.pos,
    depth: Math.hypot(result.fielded.pos.x, result.fielded.pos.z),
    simGroundout: kind === 'groundout',
    spoiled: null,
  };
}

/** 走塁の1区間 */
interface Leg {
  from: BaseKey;
  to: BaseKey;
}
const TO_SECOND: Leg = { from: 'first', to: 'second' };
const TO_FIRST: Leg = { from: 'home', to: 'first' };

interface Levers {
  /** 走者が打球の瞬間に持っているリード m（現状 0＝打球で塁に戻される） */
  lead: number;
  /**
   * 確保→送球の持ち替えへ**足すぶん** s。現状（0）でも拾ってからの持ち替え
   * （`PICKUP_RELEASE_SEC`＝0.35秒。フェーズBBB-82）は入っている＝Y-46 の当時は CPU の反応
   * 0.25秒だけだった。
   */
  transfer: number;
  /** 打球の瞬間までに走っていた秒数（H-28のヒットエンドラン＝走らせてから転がす。現状 0） */
  head: number;
}
const NOW: Levers = { lead: 0, transfer: 0, head: 0 };
const lv = (o: Partial<Levers>): Levers => ({ ...NOW, ...o });

/** その塁への送球1本が届く時刻（打球の瞬間から） */
function throwArrival(f: Fielded, to: BaseKey, lv: Levers): number {
  return (
    f.sec + PICKUP_THROW_DELAY_SEC + lv.transfer + distance(f.pos, BASE_POSITIONS[to]) / THROW_SPEED
  );
}

/**
 * その走者が塁に着く時刻（打球の瞬間から）。**打者走者は本塁から走る**ので、
 * リードも走り出しの頭も持たない（＝レバーAとH-28は打者走者に一切効かない）。
 */
function runnerArrival(leg: Leg, speed: number, l: Levers): number {
  if (leg.from === 'home') return BASE_PATH / speed;
  return Math.max(0, (BASE_PATH - l.lead) / speed - l.head);
}

/**
 * その走者をその塁への送球1本で刺せるか。**`sim.ts` の `throwOut` と同じ式**
 * （同着は走者有利／走者が既に着いていたら刺せない）。
 */
function retires(f: Fielded, leg: Leg, speed: number, l: Levers = NOW): boolean {
  if (f.spoiled !== null) return false;
  const release = f.sec + PICKUP_THROW_DELAY_SEC + l.transfer;
  const arriveRadiusSec = BASE_ARRIVE_RADIUS / speed;
  if (release >= runnerArrival(leg, speed, l) - arriveRadiusSec) return false;
  return throwArrival(f, leg.to, l) < runnerArrival(leg, speed, l);
}

/** その走者に残っている余裕 s（**正＝走者が勝つ**＝送りバント成功。負＝その秒数だけ足りない） */
function slack(f: Fielded, leg: Leg, speed: number, lv: Levers = NOW): number {
  if (f.spoiled !== null) return Number.NaN;
  return throwArrival(f, leg.to, lv) - runnerArrival(leg, speed, lv);
}

const AIMS = [-1, 0, 1] as const;
const AIM_LABEL: Record<number, string> = { [-1]: '三塁側', 0: '正面', 1: '一塁側' };
const RUNS = [0, 0.5, 1] as const;

/**
 * **Y-46を入れる前の**バント（初速11m/s・狙い±38°）。1段目の基準線として残す。
 * 現在の定数（`BUNT_EXIT_SPEED` / `BUNT_MAX_DIRECTION_DEG`）はこのフェーズで動いたので、
 * これを持たないと「埋めるべき不足はいくらだったのか」が再現できなくなる。
 */
const LEGACY_EXIT_SPEED = 11;
const LEGACY_DIRECTION_DEG = 38;

console.log('\n================ 送りバントの不足を秒に分解する（フェーズY-46） ================');

// ---- 1. 内訳（X-45の1・2段目を「秒の不足」まで割る） ----

console.log('\n=== 1. Y-46より前：一塁の走者を二塁で刺すまでの内訳（ところざわ・CPU守備） ===');
console.log(`   打球は初速 ${LEGACY_EXIT_SPEED}m/s・狙い ±${LEGACY_DIRECTION_DEG}°（＝このフェーズで動かす前の値）。`);
console.log('   走者は基準速（走力0.5）。「余裕s」は正＝走者が勝つ／負＝その秒数だけ足りない。');
console.log('   「刺せる」欄は左＝この計測の式／右＝simulatePlay 自身の判定（一致すべき）。');
console.log(
  `${'狙い'.padEnd(8)}${row(['確保s', '本塁から', '拾う', '送球s', '守備計s', '走者s', '余裕s', '一塁で刺せる'], 11)}`,
);
for (const aim of AIMS) {
  const f = fieldBunt(LEGACY_EXIT_SPEED, aim * LEGACY_DIRECTION_DEG);
  if (f === null || f.spoiled !== null) {
    console.log(`${AIM_LABEL[aim].padEnd(8)}${row([f?.spoiled ?? '（拾われない）'], 11)}`);
    continue;
  }
  const mine = retires(f, TO_FIRST, RUNNER_SPEED);
  console.log(
    `${AIM_LABEL[aim].padEnd(8)}` +
      row(
        [
          f.sec.toFixed(2),
          f.depth.toFixed(1),
          String(f.by),
          (distance(f.pos, BASE_POSITIONS.second) / THROW_SPEED).toFixed(2),
          throwArrival(f, 'second', NOW).toFixed(2),
          runnerArrival(TO_SECOND, RUNNER_SPEED, NOW).toFixed(2),
          slack(f, TO_SECOND, RUNNER_SPEED).toFixed(2),
          `${mine ? 'アウト' : 'セーフ'}/${f.simGroundout ? 'アウト' : 'セーフ'}`,
        ],
        11,
      ),
  );
}

const BEST_NOW = AIMS.map((aim) => fieldBunt(LEGACY_EXIT_SPEED, aim * LEGACY_DIRECTION_DEG))
  .filter((f): f is Fielded => f !== null && f.spoiled === null)
  .reduce((a, b) => (slack(b, TO_SECOND, RUNNER_SPEED) > slack(a, TO_SECOND, RUNNER_SPEED) ? b : a));
const DEFICIT = -slack(BEST_NOW, TO_SECOND, RUNNER_SPEED);
console.log(
  `\n   → もっとも良い狙い（${BEST_NOW.depth.toFixed(1)}m地点）でも走者は ` +
    `${DEFICIT.toFixed(2)} 秒足りない（これが埋めるべき不足）。`,
);
console.log('   走力別の不足（狙いは最良を採る）：');
console.log(`${'走力'.padEnd(10)}${row(['走者s', '不足s'], 12)}`);
for (const run of RUNS) {
  const speed = runnerSpeed(run);
  console.log(
    `${run.toFixed(1).padEnd(10)}` +
      row(
        [
          runnerArrival(TO_SECOND, speed, NOW).toFixed(2),
          (-slack(BEST_NOW, TO_SECOND, speed)).toFixed(2),
        ],
        12,
      ),
  );
}

// **盗塁と比べる**：同じ走者を刺すのに、守備は「バントを拾って投げる」ほうが速いか、
// 「捕手が投球を受けて投げる」ほうが速いか。**バントのほうが速いなら、転がすこと自体が
// 守備を助けている**＝実際の野球と逆になっている、という形で不足を言い直せる。
const CATCHER_PATH_SEC =
  STEAL_CATCH_RELEASE_SEC + distance(BASE_POSITIONS.home, BASE_POSITIONS.second) / THROW_SPEED;
console.log(
  `\n   参考：捕手が投球を受けてから二塁へ投げると ${CATCHER_PATH_SEC.toFixed(2)}秒（持ち替え` +
    `${STEAL_CATCH_RELEASE_SEC}＋送球）。バントを拾って投げると ` +
    `${throwArrival(BEST_NOW, 'second', NOW).toFixed(2)}秒。`,
);
console.log(
  `   → **転がすと守備が ${(CATCHER_PATH_SEC - throwArrival(BEST_NOW, 'second', NOW)).toFixed(2)}秒 速くなる**` +
    `＝走者にとってはバントされないほうがマシ（実際の野球と逆）。`,
);

// ---- 2. レバーA：打球でも走者がリードを保つ（L-32との一貫性） ----
//
// **投球中の走者は全員リードを取っている**（L-32：盗塁・けん制のプレーはそこから始まる）
// のに、**打球のプレーだけは全員が塁の真上に戻される**（`buildRunnerVisuals` は
// `lead: 0`）。同じ1球の同じ瞬間に、打者が見送れば 3.5m・打てば 0m という食い違いが
// ここにある。**打者走者は本塁から走るので、このレバーは打者走者に一切効かない**
// ＝I-29が測った内野安打の帯（分母は打者走者）は原理的に動かない。

console.log('\n=== 2. レバーA：打球でも走者がリードを保つ（L-32との一貫性） ===');
console.log(`   現状 0m ／ 盗塁と同じ標準リード ${STEAL_LEAD}m ／ けん制で育てた上限 ${MAX_LEAD}m。`);
console.log(`${'リードm'.padEnd(10)}${row(['走者s', '不足s', '帰結'], 12)}`);
for (const lead of [0, STEAL_LEAD, MAX_LEAD]) {
  const l = lv({ lead });
  console.log(
    `${lead.toFixed(1).padEnd(10)}` +
      row(
        [
          runnerArrival(TO_SECOND, RUNNER_SPEED, l).toFixed(2),
          (-slack(BEST_NOW, TO_SECOND, RUNNER_SPEED, l)).toFixed(2),
          retires(BEST_NOW, TO_SECOND, RUNNER_SPEED, l) ? 'アウト' : 'セーフ',
        ],
        12,
      ),
  );
}

// ---- 2b. レバーF：走らせてから転がす（H-28のヒットエンドラン。**既にある操作**） ----
//
// 実際の野球の送りバントは**必ず走者がスタートを切っている**。この操作は H-28 で
// 既に入っている（盗塁を仕掛けた球を打てる＝バントもできる）。頭の秒数は「投球の
// どこで仕掛けたか」で決まり、上限は**モーション中に走り出したとき**。

console.log('\n=== 2b. レバーF：走らせてから転がす（H-28。既にある操作） ===');
console.log(
  `   頭s＝打球の瞬間までに走っていた秒数。盗塁が成立する境界は残り ` +
    `${stealSafeJumpSec('first').toFixed(2)}秒（＝リリース直後に走ればこの頭が付く）。`,
);
console.log(`${'頭s'.padEnd(10)}${row(['走者s', '不足s(リード0)', '不足s(リード3.5)'], 18)}`);
for (const head of [0, 0.25, 0.45, 0.7, 0.9]) {
  console.log(
    `${head.toFixed(2).padEnd(10)}` +
      row(
        [
          runnerArrival(TO_SECOND, RUNNER_SPEED, lv({ head })).toFixed(2),
          (-slack(BEST_NOW, TO_SECOND, RUNNER_SPEED, lv({ head }))).toFixed(2),
          (-slack(BEST_NOW, TO_SECOND, RUNNER_SPEED, lv({ head, lead: STEAL_LEAD }))).toFixed(2),
        ],
        18,
      ),
  );
}

// ---- 3. レバーB：確保→送球の持ち替え ----
//
// この守備モデルには**捕ってから投げるまでの時間**が2か所だけある：
// フライ捕球後（`FLY_CATCH_RELEASE_SEC`=1.5）と捕手が投球を受けた後
// （`STEAL_CATCH_RELEASE_SEC`=1.6）。**ゴロを拾ったときだけ 0**（CPUには反応 0.25 が
// あるが、人間守備は K を押した瞬間に投げられる）。

console.log('\n=== 3. レバーB：確保→送球の持ち替え（ゴロにも時間を要求する） ===');
console.log('   現状は 0（CPUの反応 0.25 のみ）。フライ捕球後は 1.5・捕手の持ち替えは 1.6。');
console.log(`${'持ち替えs'.padEnd(12)}${row(['守備計s', '不足s(リード0)', '不足s(リード3.5)'], 18)}`);
for (const transfer of [0, 0.2, 0.35, 0.5, 0.7]) {
  console.log(
    `${transfer.toFixed(2).padEnd(12)}` +
      row(
        [
          throwArrival(BEST_NOW, 'second', lv({ transfer })).toFixed(2),
          (-slack(BEST_NOW, TO_SECOND, RUNNER_SPEED, lv({ transfer }))).toFixed(2),
          (-slack(BEST_NOW, TO_SECOND, RUNNER_SPEED, lv({ transfer, lead: STEAL_LEAD }))).toFixed(2),
        ],
        18,
      ),
  );
}

// ---- 4. レバーC/D：バントの打球そのもの（角度と強さ） ----
//
// 原作 説明書p17 の「**ファールラインぎりぎりに転がすのがコツ**」に対応するレバー。
// 現状は角度が ±38° 固定・初速 11m/s 固定なので、**どこへ転がしても投手が拾う**。

console.log('\n=== 4. レバーC/D：バントの角度と強さ（説明書p17「ファールラインぎりぎり」） ===');
console.log('   角度は三塁側（負）で代表。45°を超えるとファウル。「確保s」が伸びるほど走者が有利。');
console.log(
  `   採った値＝初速 ${BUNT_EXIT_SPEED}（標準）/ ${BUNT_PUSH_EXIT_SPEED}（押し）・狙い ±${BUNT_MAX_DIRECTION_DEG}°。`,
);
console.log(`${'初速'.padEnd(8)}${row(['0°', '-20°', '-30°', '-38°', '-42°', '-44°'], 15)}`);
const ANGLES = [0, -20, -30, -38, -42, -44];
const SPEEDS = [5, 7, 9, 11, 13, 15, 17, 20];
for (const speed of SPEEDS) {
  const cells = ANGLES.map((deg) => {
    const f = fieldBunt(speed, deg);
    if (f === null) return '拾われない';
    if (f.spoiled !== null) return `${f.spoiled}(${f.by})`;
    return `${f.sec.toFixed(2)}(${f.depth.toFixed(0)}m,${f.by})`;
  });
  console.log(`${speed.toFixed(1).padEnd(8)}${row(cells, 15)}`);
}

console.log('\n   その打球での不足s（リード0・基準速。正の値だけが送りバント成功）：');
console.log(`${'初速'.padEnd(8)}${row(ANGLES.map((d) => `${d}°`), 12)}${'  打者を一塁で'}`);
for (const speed of SPEEDS) {
  const cells = ANGLES.map((deg) => {
    const f = fieldBunt(speed, deg);
    if (f === null || f.spoiled !== null) return '-';
    return slack(f, TO_SECOND, RUNNER_SPEED).toFixed(2);
  });
  const corner = fieldBunt(speed, -44);
  const batter =
    corner === null || corner.spoiled !== null
      ? '-'
      : retires(corner, TO_FIRST, RUNNER_SPEED)
        ? 'アウト'
        : 'セーフ(バントヒット)';
  console.log(`${speed.toFixed(1).padEnd(8)}${row(cells, 12)}  ${batter}`);
}

// ---- 4b. 「置く／押す」の帯（初速を1m/s刻みで走査。両端に失敗があるか） ----
//
// 弱すぎると**捕手が空中で捕る**（小フライ＝バント失敗）、強すぎると**三塁手の
// 立っている三塁まで転がる**（その場で拾われる）。**間にだけ良い帯がある**なら、
// 「どれだけ押すか」は押し引きのある操作になる（桜井ノウハウ：リスクとリターンを
// 同じ操作の近くに置く）。

console.log('\n=== 4b. 「置く／押す」の帯（三塁線 -44°。リードは 3.5m＝レバーAを入れた前提） ===');
console.log('   余裕s は正＝先頭の走者が二塁でセーフ。走力3種ぶん並べる。');
console.log(
  `${'初速'.padEnd(8)}${row(['帰結', '確保s', '本塁から'], 13)}${row(RUNS.map((r) => `余裕s(走力${r})`), 14)}`,
);
for (let speed = 9; speed <= 21; speed += 1) {
  const f = fieldBunt(speed, -44);
  if (f === null) {
    console.log(`${speed.toFixed(0).padEnd(8)}${row(['拾われない'], 13)}`);
    continue;
  }
  if (f.spoiled !== null) {
    console.log(`${speed.toFixed(0).padEnd(8)}${row([`${f.spoiled}(${f.by})`, '-', '-'], 13)}`);
    continue;
  }
  const cells = RUNS.map((run) =>
    slack(f, TO_SECOND, runnerSpeed(run), lv({ lead: STEAL_LEAD })).toFixed(2),
  );
  console.log(
    `${speed.toFixed(0).padEnd(8)}` +
      row([`${f.by}が拾う`, f.sec.toFixed(2), `${f.depth.toFixed(0)}m`], 13) +
      row(cells, 14),
  );
}

// ---- 4c. 押しの初速を解き直す（フェーズBBB-82。野手の足を原作の 6.0m/s にした後） ----
//
// 見るのは3つ：**先頭の走者（一塁→二塁）が生きるか**／**打者が一塁で生きてしまわないか**
// （生きれば「アウトと引き換え」ではなくなる）／**三塁走者が還れてしまわないか**（スクイズ）。
// 採る値＝**走力1.0の打者でも一塁で刺される、いちばん大きい初速**。
{
  console.log('\n=== 4c. 押しの初速（三塁線 -44°・リード 3.5m。余裕s＝正なら走者の勝ち） ===');
  console.log(
    `${'初速'.padEnd(8)}${'拾う'.padEnd(6)}` +
      row(['確保s', '本塁から', '一→二 力0', '力0.5', '力1', '三→本 力1', '打者 力0.8', '打者 力1'], 11),
  );
  const margin = (f: Fielded, to: BaseKey, path: number, run: number) =>
    throwArrival(f, to, NOW) - path / runnerSpeed(run);
  for (const speed of [11, 12, 13, 13.5, 13.75, 14, 14.5, 15, 16, 16.5, 17, 17.2, 17.5, 18]) {
    const f = fieldBunt(speed, -BUNT_MAX_DIRECTION_DEG);
    if (f === null || f.spoiled !== null) {
      console.log(`${String(speed).padEnd(8)}${f?.spoiled ?? '拾われない'}`);
      continue;
    }
    const led = BASE_PATH - STEAL_LEAD;
    const cells = [
      f.sec.toFixed(2),
      `${f.depth.toFixed(0)}m`,
      margin(f, 'second', led, 0).toFixed(2),
      margin(f, 'second', led, 0.5).toFixed(2),
      margin(f, 'second', led, 1).toFixed(2),
      margin(f, 'home', led, 1).toFixed(2),
      margin(f, 'first', BASE_PATH, 0.8).toFixed(2),
      margin(f, 'first', BASE_PATH, 1).toFixed(2),
    ];
    const mark = speed === BUNT_PUSH_EXIT_SPEED ? ' ←押し' : speed === BUNT_EXIT_SPEED ? ' ←標準' : '';
    console.log(`${String(speed).padEnd(8)}${String(f.by).padEnd(6)}${row(cells, 11)}${mark}`);
  }
  console.log('   ＝16〜16.5 は誰が打っても全員セーフ／17 は三塁手が拾い、足の速い打者が生きる。');
}

// ---- 5. レバーE：一塁手・三塁手がバントに突っ込む ----
//
// 「塁カバー4人（説明書p20）が固定なのでバントに突っ込まない」ことが有利に働いている
// のではないか、という疑いを潰す。**突っ込ませると守備はむしろ速くなる**はず
// （3B は本塁から 19m、投手は 18.44m だが、バントは三塁線側に転がるので 3B のほうが近い）。

/**
 * その野手が単独で突っ込んだときに確保できる最速の時刻（球の位置を追う。上限の見積もり）。
 * `simulatePlay` と同じく打球発生から `CATCH_MIN_PLAY_SEC` は捕れない。
 */
function chargeSecureSec(speed: number, deg: number, id: FielderId): number | null {
  let ball = createBattedBall(buntLaunch(speed, deg), 0);
  const start = FIELDER_HOME_POSITIONS[id];
  for (let t = 0; t < 6; t += SIM_DT) {
    if (t >= CATCH_MIN_PLAY_SEC && distance(start, { x: ball.x, z: ball.z }) <= FIELDER_SPEED * t + CATCH_RADIUS) {
      return t;
    }
    ball = stepBattedBall(ball, SIM_DT, DEFAULT_BALLPARK);
  }
  return null;
}

console.log('\n=== 5. レバーE：一塁手・三塁手が突っ込んだら（塁カバーを外す） ===');
console.log('   値＝その野手が単独で突っ込んだときの確保s（球を追いながらの最速。上限の見積もり）。');
console.log(`${'狙い'.padEnd(10)}${row(['P(現状)', '3B', '1B', 'C'], 11)}`);
for (const aim of AIMS) {
  const deg = aim * BUNT_MAX_DIRECTION_DEG;
  const cells = (['P', '3B', '1B', 'C'] as FielderId[]).map((id) => {
    const t = chargeSecureSec(BUNT_EXIT_SPEED, deg, id);
    return t === null ? '-' : t.toFixed(2);
  });
  console.log(`${AIM_LABEL[aim].padEnd(10)}${row(cells, 11)}`);
}

// ---- 6. 費用：既存の境界がどれだけ動くか ----
//
// J-30が `THROW_SPEED` を据え置くと決めた理由は「内野ゴロ・犠飛・盗塁・けん制の
// 境界を全部同時に壊す」ことだった。レバーごとに、**その4つがどれだけ動くか**を出す。

/** 打者走者を一塁で刺せるか（持ち替えを足したときの再判定。delay=0 で sim と一致） */
function groundoutWithTransfer(
  fielded: { sec: number; pos: Vec2 },
  transfer: number,
  speed = RUNNER_SPEED,
): boolean {
  const release = fielded.sec + PICKUP_THROW_DELAY_SEC + transfer;
  if (release >= (BASE_PATH - BASE_ARRIVE_RADIUS) / speed) return false;
  return release + distance(fielded.pos, BASE_POSITIONS.first) / THROW_SPEED < BASE_PATH / speed;
}

const samples = sweep();
const grounders = samples.filter(
  (s) => s.result.outcome.kind === 'groundout' || s.result.outcome.kind === 'beatThrow',
);
const inPlay = samples.filter((s) => s.result.outcome.kind !== 'foul');
{
  // delay=0 でこの式が simulatePlay 自身の判定と一致することの確認（1段目と同じ突き合わせ）
  const mismatch = grounders.filter(
    (s) =>
      groundoutWithTransfer(s.result.fielded!, 0) !== (s.result.outcome.kind === 'groundout'),
  ).length;
  console.log(`\n=== 6. 費用：既存の境界がどれだけ動くか（ゴロ ${grounders.length} 本／sim との不一致 ${mismatch} 本） ===`);
}
console.log('   レバーAは打者走者に効かない（本塁から走る）＝内野ゴロの帯は原理的に動かない。');
console.log(`${'持ち替えs'.padEnd(12)}${row(['ゴロアウト', '内野安打', 'フェア打球の安打率'], 16)}`);
for (const transfer of [0, 0.2, 0.35, 0.5, 0.7]) {
  const outs = grounders.filter((s) => groundoutWithTransfer(s.result.fielded!, transfer)).length;
  const beat = grounders.length - outs;
  // 安打率は「ゴロ以外の帰結はそのまま＋ゴロのうち刺せなかったぶん」で数え直す
  const otherHits = inPlay.filter((s) => {
    const k = s.result.outcome.kind;
    return k === 'hit' || k === 'homerun' || k === 'groundRuleDouble';
  }).length;
  console.log(
    `${transfer.toFixed(2).padEnd(12)}` +
      row([String(outs), String(beat), pct((otherHits + beat) / inPlay.length)], 16),
  );
}

console.log('\n   レバーごとの、既存の4つの境界への影響：');
console.log(`${'レバー'.padEnd(28)}${row(['内野ゴロ', '犠飛', '盗塁', 'けん制'], 12)}`);
console.log(
  `${'A リードを保つ'.padEnd(28)}` + row(['不変', '不変', '不変', '不変'], 12),
);
console.log(
  `${'B 持ち替え（ゴロ全般）'.padEnd(28)}` + row(['動く', '不変', '不変', '不変'], 12),
);
console.log(
  `${'C/D バントの打球'.padEnd(28)}` + row(['不変', '不変', '不変', '不変'], 12),
);
console.log(
  `   （犠飛＝FLY_CATCH_RELEASE_SEC / 盗塁＝STEAL_CATCH_RELEASE_SEC / けん制＝投手が持ったまま`,
);
console.log(`     ＝どれもゴロの確保を経ない別経路。盗塁の窓 ${stealSafeJumpSec('first').toFixed(3)}s ・`);
console.log(
  `     けん制の境界 ${pickoffOutLead('first', FIELDER_HOME_POSITIONS.P).toFixed(2)}m は上のどのレバーでも動かない）`,
);

// ---- 7. 組み合わせ：帯が開くか（開きすぎないか） ----

interface Combo {
  label: string;
  l: Levers;
  speed: number;
}

const COMBOS: Combo[] = [
  { label: 'Y-46前', l: NOW, speed: LEGACY_EXIT_SPEED },
  { label: 'A リードのみ', l: lv({ lead: STEAL_LEAD }), speed: LEGACY_EXIT_SPEED },
  { label: 'F 走らせる(頭0.45)のみ', l: lv({ head: 0.45 }), speed: LEGACY_EXIT_SPEED },
  { label: 'A+F', l: lv({ lead: STEAL_LEAD, head: 0.45 }), speed: LEGACY_EXIT_SPEED },
  { label: 'A+B(0.35)', l: lv({ lead: STEAL_LEAD, transfer: 0.35 }), speed: LEGACY_EXIT_SPEED },
  { label: 'A+D(押す)', l: lv({ lead: STEAL_LEAD }), speed: BUNT_PUSH_EXIT_SPEED },
  { label: 'A+F(頭0.25)+D(押す)', l: lv({ lead: STEAL_LEAD, head: 0.25 }), speed: BUNT_PUSH_EXIT_SPEED },
  { label: 'A+F(頭0.45)+D(押す)', l: lv({ lead: STEAL_LEAD, head: 0.45 }), speed: BUNT_PUSH_EXIT_SPEED },
  { label: 'D(押す)のみ', l: NOW, speed: BUNT_PUSH_EXIT_SPEED },
];

console.log('\n=== 7. 組み合わせ：送りバントが成立するか（狙いは三塁線＝-44°） ===');
console.log('   送りバント成功＝先頭セーフ かつ 打者アウト（アウトと引き換えに塁を1つ進める）。');
console.log('   「両方セーフ」＝守備が誰も刺せない＝バントが強すぎる（アウトを差し出していない）。');
console.log(`${'条件'.padEnd(26)}${row(RUNS.map((r) => `走力${r}`), 16)}`);
for (const c of COMBOS) {
  const f = fieldBunt(c.speed, -44);
  if (f === null || f.spoiled !== null) {
    console.log(`${c.label.padEnd(26)}${row([f?.spoiled ?? '拾われない'], 16)}`);
    continue;
  }
  const cells = RUNS.map((run) => {
    const speed = runnerSpeed(run);
    const leadSafe = !retires(f, TO_SECOND, speed, c.l);
    const batterOut = retires(f, TO_FIRST, speed, c.l);
    return leadSafe ? (batterOut ? '送りバント成功' : '両方セーフ') : '先頭アウト';
  });
  console.log(`${c.label.padEnd(26)}${row(cells, 16)}`);
}

// ---- 8. 得点確率での損得（X-45の4段目を、レバー適用後に測り直す） ----

const dists = new Map<number, PaDistribution>();
function distOf(power: number): PaDistribution {
  const key = Math.round(power * 100) / 100;
  const cached = dists.get(key);
  if (cached) return cached;
  const d = distributionFor(key, { average: 0.5 });
  dists.set(key, d);
  return d;
}
const scoreTable: ScoreProbability = solveScoreProbability(distOf(0.5));
const POWERS = [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9] as const;
const FORCED_STATES = [1, 3, 5, 7];
const BASE_BIT: Partial<Record<BaseKey, number>> = { first: 1, second: 2, third: 4 };

/** 打球でフォースされる走者（もっとも進んだ走者が先頭） */
function forcedLegs(state: number): Leg[] {
  const legs: Leg[] = [];
  if (state & 1) {
    if (state & 2) {
      if (state & 4) legs.push({ from: 'third', to: 'home' });
      legs.push({ from: 'second', to: 'third' });
    }
    legs.push({ from: 'first', to: 'second' });
  }
  legs.push({ from: 'home', to: 'first' });
  return legs;
}

/** 最善の守備（もっとも進んだ走者から刺す）に対するバントの帰結 */
function buntOutcome(f: Fielded, state: number, speed: number, l: Levers) {
  const legs = forcedLegs(state);
  const retired = legs.find((leg) => retires(f, leg, speed, l)) ?? null;
  let bits = state;
  let runs = 0;
  for (const leg of legs) if (leg.from !== 'home') bits &= ~(BASE_BIT[leg.from] ?? 0);
  for (const leg of legs) {
    if (retired && leg.from === retired.from && leg.to === retired.to) continue;
    if (leg.to === 'home') runs += 1;
    else bits |= BASE_BIT[leg.to] ?? 0;
  }
  return { outs: retired === null ? 0 : 1, runs, state: bits };
}

function buntScoreProb(
  state: number,
  outs: number,
  l: Levers,
  exit: number,
  speed = RUNNER_SPEED,
): number {
  let best = 0;
  // **打者が実際に出せる角度だけを見る**（フェーズBBB-82で直した）：狙いは十字キーの
  // 左・無し・右の3通り（`judgeBunt`）＝Y-46 の前は ±38°、いまは ±44°。それまでは両方を
  // 混ぜて最良を採っていたので、いまは出せない -38° の押しバント（投手がいちばん遅れる）が
  // 押しの値打ちに数えられていた。
  const maxDeg = exit === LEGACY_EXIT_SPEED && l === NOW ? LEGACY_DIRECTION_DEG : BUNT_MAX_DIRECTION_DEG;
  for (const deg of AIMS.map((aim) => aim * maxDeg)) {
    const f = fieldBunt(exit, deg);
    if (f === null || f.spoiled !== null) continue;
    const r = buntOutcome(f, state, speed, l);
    const after = outs + r.outs;
    const value = r.runs > 0 ? 1 : after >= 3 ? 0 : scoreTable[after][r.state];
    if (value > best) best = value;
  }
  return best;
}

console.log('\n=== 8. 得点確率での損得（正＝バントのほうが1点入りやすい。X-45の4段目の測り直し） ===');
for (const c of COMBOS.filter((x) =>
  ['Y-46前', 'A+D(押す)', 'A+F(頭0.25)+D(押す)'].includes(x.label),
)) {
  console.log(`\n   ${c.label}：`);
  console.log(`${'塁状況'.padEnd(12)}${'アウト'.padEnd(6)}${row(POWERS.map((p) => `力${p}`), 8)}`);
  for (const state of FORCED_STATES) {

    for (const outs of [0, 1, 2]) {
      const bunt = buntScoreProb(state, outs, c.l, c.speed);
      // 俊足（走力1.0）の走者・打者なら（BBB-82：野手が遅くなって、足で帰結が分かれる）
      const fast = buntScoreProb(state, outs, c.l, c.speed, runnerSpeed(1));
      const cells = POWERS.map((power) => {
        const diff = bunt - paScoreProb(distOf(power), outs, state, scoreTable);
        return `${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(1)}`;
      });
      const fastDiff = fast - paScoreProb(distOf(0.45), outs, state, scoreTable);
      console.log(
        `${baseStateLabel(state).padEnd(12)}${String(outs).padEnd(6)}${row(cells, 8)}` +
          `   俊足・力0.45: ${fastDiff >= 0 ? '+' : ''}${(fastDiff * 100).toFixed(1)}`,
      );
    }
  }
}

// ---- 9. 名鑑での発火（誰にバントさせるか） ----

console.log('\n=== 9. 規則が発火するか（名鑑16球団×打線9人＝144通り） ===');
console.log('   「この長打力以下ならバント」としたとき、何打順が該当するか。');
const lineupPowers = TEAMS.flatMap((team) => team.lineup.map((r) => fielderRowStats(r).power));
console.log(`${'しきい値'.padEnd(12)}${row(['該当する打順'], 16)}`);
for (const threshold of [0.15, 0.2, 0.25, 0.3, 0.4]) {
  console.log(
    `${threshold.toFixed(2).padEnd(12)}` +
      row([`${lineupPowers.filter((p) => p <= threshold).length}/${lineupPowers.length}`], 16),
  );
}
console.log(`   （投手の打席は別枠＝名鑑の投手の長打力は ${TEAMS.map((t) => t.pitchers[0]).length} 人ぶん常にこの下）`);

// ---- 10. バントのファウル（フェーズAA-48：2ストライク後は三振） ----
//
// Y-46 が置いた失敗は3つ（弱い＝捕手が空中で捕る／正面＝投手が空中で捕る／強すぎ＝三塁手
// まで転がる）だが、**ファウルという4つ目の失敗には罰が無かった**（`applyPitch` の
// ファウルは2ストライクで頭打ちなので、何度でもやり直せる）。説明書p32「実際の野球の
// ルールにできるだけ合わせてある」に対する差分で、Y-46でバントが技術として成立した
// 直後だから値打ちが上がっている。
//
// **狙い（`judgeBunt`）は±44°にクランプされていて、そこは1行も触らない**（着手前の
// ユーザー判断）。だからここで測るのは「**ファウルはどこで生まれるのか**」＝
// 罰がどの場面に噛むのか、逃げ道があるのか、の2つ。

/** その接触点・狙いでバントしたときの帰結（ファウル＝AA-48の三振） */
function buntContact(crossX: number, aim: -1 | 0 | 1, side: BatterSide, push: boolean): string {
  const launch = judgeBunt(crossX, aim, side, 0, push);
  if (launch === null) return '届かない';
  const kind = simulatePlay(launch, crossX).outcome.kind;
  if (kind === 'foul') return 'ファウル';
  if (kind === 'flyout') return '小フライ';
  return 'ころがる';
}

console.log('\n=== 10. バントのファウルはどこで生まれるか（フェーズAA-48） ===');
console.log('   ファウル率＝その接触点でバントするとファウルになる割合（0.01m刻み）。');
console.log(`   ゾーン内＝|x|≦${STRIKE_ZONE_HALF_WIDTH}（見逃せばストライクの球）。`);
console.log(
  `${'側'.padEnd(4)}${'強さ'.padEnd(6)}${'狙い'.padEnd(8)}${row(['ゾーン内', '到達範囲', 'ファウルの帯'], 14)}`,
);
for (const side of [RIGHT_BATTER_SIDE, LEFT_BATTER_SIDE] as const) {
  for (const push of [false, true]) {
    for (const aim of AIMS) {
      let zoneFoul = 0;
      let zoneAll = 0;
      let reachFoul = 0;
      let reachAll = 0;
      let lo = Number.NaN;
      let hi = Number.NaN;
      for (let x = -1; x <= 1.0001; x += 0.01) {
        if (judgeBunt(x, aim, side, 0, push) === null) continue;
        const foul = buntContact(x, aim, side, push) === 'ファウル';
        reachAll += 1;
        if (foul) {
          reachFoul += 1;
          if (Number.isNaN(lo)) lo = x;
          hi = x;
        }
        if (Math.abs(x) <= STRIKE_ZONE_HALF_WIDTH) {
          zoneAll += 1;
          if (foul) zoneFoul += 1;
        }
      }
      console.log(
        `${(side === RIGHT_BATTER_SIDE ? '右' : '左').padEnd(4)}` +
          `${(push ? '押し' : '置き').padEnd(6)}` +
          `${AIM_LABEL[aim].padEnd(8)}` +
          row(
            [
              `${((100 * zoneFoul) / zoneAll).toFixed(0)}%`,
              `${((100 * reachFoul) / reachAll).toFixed(0)}%`,
              reachFoul === 0 ? '-' : `${lo.toFixed(2)}〜${hi.toFixed(2)}`,
            ],
            14,
          ),
      );
    }
  }
}

// 10b. 実際に来る球（T-41のCPUの狙い）で発火するか。
//
// `chooseCpuPitchPlan` の3分岐（通常 / 決め球 / 置きにいく球）をそのまま呼ぶので、
// **測っているのは「打者が実際に受け取る球」**であって仮定のコースではない。
// 決め球だけがゾーンの外（半幅0.45＋際どさ0.05＋制球の膨らみ）に置かれるので、
// **罰が噛むのは追い込まれた後だけ**という予想の裏取りになる。

console.log('\n=== 10b. 名鑑96人の球をバントしたら（右打者・立ち位置0・カウント3区分） ===');
console.log('   値＝96人ぶんの帰結の内訳。ファウル＝AA-48では2ストライク後に三振。');
const PITCHER_CONTROLS = TEAMS.flatMap((t) =>
  t.pitchers.map((r) => pitcherControl(pitcherRowPitching(r).era)),
);
const COUNT_CASES = [
  { label: 'ツウジョウ(0-0)', count: { balls: 0, strikes: 0 } },
  { label: 'キメダマ(0-2)', count: { balls: 0, strikes: 2 } },
  { label: 'オキニクル(3-0)', count: { balls: 3, strikes: 0 } },
] as const;
console.log(`${'カウント'.padEnd(16)}${'強さ'.padEnd(6)}${row(AIMS.map((a) => AIM_LABEL[a]), 22)}`);
for (const c of COUNT_CASES) {
  for (const push of [false, true]) {
    const cells = AIMS.map((aim) => {
      const tally: Record<string, number> = {};
      for (const control of PITCHER_CONTROLS) {
        const x = chooseCpuPitchPlan(c.count, 'balanced', control).targetX;
        const kind = buntContact(x, aim, RIGHT_BATTER_SIDE, push);
        tally[kind] = (tally[kind] ?? 0) + 1;
      }
      return Object.entries(tally)
        .map(([k, n]) => `${k}${n}`)
        .join(' ');
    });
    console.log(`${c.label.padEnd(16)}${(push ? '押し' : '置き').padEnd(6)}${row(cells, 22)}`);
  }
}
console.log(`   （決め球の狙いは ${'±'}${(STRIKE_ZONE_HALF_WIDTH + 0.05).toFixed(2)}m 以上＝ゾーンの外。`);
console.log('    ボール数の偶奇で内外が入れ替わるので、右打者から見た「球のある側」も入れ替わる）');

console.log('\n=== まとめ ===');
console.log(`   ・埋めるべき不足は ${DEFICIT.toFixed(2)} 秒（現状のもっとも良い狙いでも足りない分）。`);
console.log('   ・レバーAは既存の4つの境界をどれも動かさない（打者走者に効かないため）。');
console.log('   ・レバーBは内野ゴロの帯を動かす（6段目の表）＝I-29の帯を張り直すことになる。');
console.log('   ・レバーC/Dはバントの打球だけを動かす（他の打球に効かない）。');
console.log('   ・AA-48（10・10b段目）：ファウルはゾーンの外でしか生まれず、しかも');
console.log('     **球のある側へ転がしたときだけ**＝罰が噛むのは決め球（2ストライク）だけ。');
console.log('     0ストライクの球（8段目の送りバントの場面）では発火しないので、');
console.log('     測った得（無死一塁・非力な打者で +0.6〜+1.6pt）は削られない。');
console.log('');
