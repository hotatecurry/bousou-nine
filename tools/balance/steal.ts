/**
 * 盗塁まわりの計測（フェーズL-32）。
 *
 *   npm run balance:steal
 *
 * L-32 で入れる2つ——**リードの持ち越し**（けん制で稼いだ／削られたリードが次の1球の
 * スタート位置になる）と**複数走者の同時スタート**（ダブルスチール）——が、
 * 実装する価値のある帯を持っているかを**着手前に**測るためのもの。CLAUDE.md の
 * 「数値の手応えは勘で動かさず必ず計測してから決める」（I-29で確定）に従う。
 * J-30 は測ってから「帯が空」と分かって実装を差し替え、K-31 は測ってから
 * 「28.6%」を確かめて着手した。ここも同じ順序を踏む。
 *
 * 判定は `src/core/fielding.ts` の純粋関数（`stealSafeJumpSec`）と、送球の時間競争を
 * そのまま使う（シーン層に判定式を書かないのと同じ約束）。定数を動かせばここの数字も
 * 一緒に動く。
 *
 * ## 何を見るか
 *
 * 1. **リードが盗塁の窓をどれだけ動かすか**。窓＝「仕掛けた瞬間に投球の残り時間が
 *    これ以上あればセーフ」という値なので、**小さいほど易しい**。投球中に実際に取れる
 *    残り時間には上限（ワインドアップ0.35秒＋飛行時間）があるので、窓がその上限を
 *    超えていれば**その盗塁はどう仕掛けても成立しない**。
 * 2. **けん制で戻された走者（リード0）は本当に走れなくなるか**＝「押し得」の代償が
 *    実際に効くか。効かないなら持ち越しを入れても意味がない。
 * 3. **ダブルスチールで守備は何人刺せるか**。捕手は1つの塁にしか投げられないので、
 *    「どちらを刺すか」の選択が生まれるはず。両方刺せてしまう（＝仕掛けるだけ損）
 *    ならリスクとリターンが釣り合っていない。
 */
import {
  BASE_PATH,
  BASE_POSITIONS,
  FIELDER_HOME_POSITIONS,
  MAX_LEAD,
  RUNNER_SPEED,
  RUNNER_SPEED_MAX,
  RUNNER_SPEED_MIN,
  STEAL_CATCH_RELEASE_SEC,
  STEAL_LEAD,
  THROW_SPEED,
  advancedBase,
  distance,
  pickoffOutLead,
  stealSafeJumpSec,
} from '../../src/core/fielding';
import {
  CATCH_Z,
  PITCH_WINDUP_SEC,
  SPEED_FAST,
  SPEED_NEUTRAL,
  SPEED_SLOW,
  flightSecondsUntil,
  releasePitchFlight,
} from '../../src/core/pitch';
import { STEAL_GO_SEC } from '../../src/core/keyframes';

/**
 * 走者が使えるモーションの長さ（フェーズBBB-76）。モーションは原作の70フレーム
 * （`PITCH_WINDUP_SEC`）になったが、**走り出せるのは投手が本塁へ踏み出してから**
 * （`STEAL_GO_SEC`）なので、持ち時間に足されるのはそこからリリースまで（26フレーム）。
 */
const WINDUP_SEC = PITCH_WINDUP_SEC - STEAL_GO_SEC;

/**
 * 仕掛けられるいちばん早い瞬間＝ワインドアップに入った直後の「捕手に届くまでの残り時間」。
 * これが走者に与えられる持ち時間の上限で、盗塁の窓がこれを超えていれば成立しない。
 * （dekkaiScene.ts の timeToCatcher() と同じ式：残りモーション＋リリース点からの飛行）
 */
function maxJumpSec(pitchSpeed: number): number {
  // 飛行は**ゲームが投げる球とまったく同じ球**で数える（dekkaiScene.ts の timeToCatcher と同じ
  // `releasePitchFlight`＝時計とフォークの手元の失速込み。BBB-77で失速を足した）
  return WINDUP_SEC + flightSecondsUntil(releasePitchFlight(0, pitchSpeed, 0), CATCH_Z);
}

const PITCHES: Array<[string, number]> = [
  ['速球', SPEED_FAST],
  ['標準', SPEED_NEUTRAL],
  ['遅球', SPEED_SLOW],
];

const LEADS: Array<[string, number]> = [
  ['0.0（けん制で戻された）', 0],
  ['1.8', 1.8],
  [`${STEAL_LEAD.toFixed(1)}（既定）`, STEAL_LEAD],
  ['4.3（けん制で刺される深さ）', 4.3],
  ['5.2', 5.2],
  [`${MAX_LEAD.toFixed(1)}（上限）`, MAX_LEAD],
];

function pad(s: string | number, w: number): string {
  return String(s).padStart(w);
}

/** その塁への盗塁が、どの球種までなら成立するか（成立しなければ「不可」） */
function feasibility(window: number): string {
  const ok = PITCHES.filter(([, speed]) => maxJumpSec(speed) >= window).map(([name]) => name);
  return ok.length === 0 ? '不可' : ok.join('/');
}

function section1(): void {
  console.log('\n=== 1. リードが盗塁の窓をどれだけ動かすか ===');
  console.log('窓 = 仕掛けた瞬間に必要な「投球の残り時間」s（小さいほど易しい）。');
  console.log(
    `仕掛けられる上限 = ワインドアップ${WINDUP_SEC.toFixed(2)}s + 飛行時間：` +
      PITCHES.map(([name, speed]) => `${name} ${maxJumpSec(speed).toFixed(2)}s`).join(' / '),
  );
  console.log('「成立」= その窓に間に合う球種（＝その球なら盗塁が成立しうる）。\n');
  console.log(
    [pad('リード m', 26), pad('一→二', 8), pad('二→三', 8), pad('三→本', 8), '  成立（一→二）'].join(''),
  );
  for (const [label, lead] of LEADS) {
    const first = stealSafeJumpSec('first', BASE_POSITIONS.home, lead);
    const second = stealSafeJumpSec('second', BASE_POSITIONS.home, lead);
    const third = stealSafeJumpSec('third', BASE_POSITIONS.home, lead);
    console.log(
      [
        pad(label, 26),
        pad(first.toFixed(2), 8),
        pad(second.toFixed(2), 8),
        pad(third.toFixed(2), 8),
        `  ${feasibility(first)}`,
      ].join(''),
    );
  }
  console.log(
    `\n参考：けん制で刺される深さ（一塁）= ${pickoffOutLead('first', FIELDER_HOME_POSITIONS.P).toFixed(2)}m。` +
      '\nつまり「刺されない深さで我慢する」と窓はほとんど動かず、' +
      '\n「刺される深さまで残る」と初めて窓が目に見えて縮む＝リスクと引き換えの報酬になっている。',
  );
}

function section2(): void {
  console.log('\n=== 2. 「押し得」の代償は実際に効くか（リード0で走れるか） ===');
  console.log('けん制球で戻された走者は塁を踏み直す＝リード0。その状態で次の1球に走れるか。\n');
  console.log([pad('走力 m/s', 10), pad('リード0の窓', 14), '  走れる球種'].join(''));
  for (const speed of [RUNNER_SPEED_MIN, RUNNER_SPEED, RUNNER_SPEED_MAX]) {
    // stealSafeJumpSec は基準速で書かれているので、走力の効きはここで解き直す
    // （runnerTime だけが走力に依存する＝式の形はそのまま）。
    const runnerTime = BASE_PATH / speed;
    const throwTime = distance(BASE_POSITIONS.home, BASE_POSITIONS.second) / THROW_SPEED;
    const window = runnerTime - throwTime - STEAL_CATCH_RELEASE_SEC;
    console.log([pad(speed.toFixed(1), 10), pad(window.toFixed(2), 14), `  ${feasibility(window)}`].join(''));
  }
  console.log(
    '\n既定（3.5m）との差がそのまま「早めにKを押したことの損」になる。' +
      '\nL-32の当時は遅球（0.80秒かかる球）にだけ穴が残っていたが、フェーズBBB-76で緩急の幅が原作どおり' +
      '\n狭くなった（遅い球も 0.47秒で捕手に着く）ので、基準速の走者は**どの球にも走れなくなった**' +
      '\n（遅球の上限 0.90秒 vs 窓 0.91秒＝0.01秒差）。俊足（8.2m/s）はどの球にも走れる。',
  );
}

/** 走者が塁へ着く時刻 s（スタートの瞬間を0とする） */
function runnerArrival(lead: number, speed: number): number {
  return (BASE_PATH - lead) / speed;
}

/** 捕手の送球がその塁へ着く時刻 s（同上。jump=仕掛けた瞬間の投球の残り時間） */
function throwArrival(jump: number, to: 'second' | 'third' | 'home'): number {
  return jump + STEAL_CATCH_RELEASE_SEC + distance(BASE_POSITIONS.home, BASE_POSITIONS[to]) / THROW_SPEED;
}

function section3(): void {
  console.log('\n=== 3. ダブルスチール（一・二塁の同時スタート）で守備は何人刺せるか ===');
  console.log('捕手は1つの塁にしか投げられない。投げた先の塁の野手がすぐ投げ直せるものとして、');
  console.log('2人目まで刺せるか（＝重盗が一方的に得にならないか）を見る。\n');
  console.log(
    [pad('仕掛け s', 10), pad('二へ投げる', 22), pad('三へ投げる', 22)].join(''),
  );
  for (const jump of [0.9, 0.6, 0.45, 0.3, 0.25, 0.1]) {
    const cells: string[] = [];
    // 送球先ごとに「刺せた走者」と「その後の投げ直しで刺せるか」を数える
    for (const target of ['second', 'third'] as const) {
      const primaryFrom = target === 'second' ? 'first' : 'second';
      const otherFrom = target === 'second' ? 'second' : 'first';
      const otherTo = advancedBase(otherFrom) as 'second' | 'third';
      const primaryOut = throwArrival(jump, target) < runnerArrival(STEAL_LEAD, RUNNER_SPEED);
      // 投げ直し：受けた塁からもう一方の塁へ（中継の遅れは0＝守備に最大限有利に見る）
      const relay =
        throwArrival(jump, target) +
        distance(BASE_POSITIONS[target], BASE_POSITIONS[otherTo]) / THROW_SPEED;
      const otherOut = relay < runnerArrival(STEAL_LEAD, RUNNER_SPEED);
      const outs = (primaryOut ? 1 : 0) + (otherOut ? 1 : 0);
      cells.push(
        pad(
          `${outs}アウト（${primaryFrom}${primaryOut ? '×' : '○'} ${otherFrom}${otherOut ? '×' : '○'}）`,
          22,
        ),
      );
    }
    console.log([pad(jump.toFixed(2), 10), ...cells].join(''));
  }
  console.log(
    '\n×=刺される / ○=セーフ。仕掛けが早い（数字が大きい）ほど走者有利。' +
      '\n「1アウト」の行が読み合いになる場面＝どちらを刺すかを守備が選ぶ。',
  );
}

function main(): void {
  section1();
  section2();
  section3();
}

main();
