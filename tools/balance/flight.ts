/**
 * 投げてから届くまで（フェーズBBB-76。BBB-77で緩急を測り直した）の計測＝**原作の実機映像と同じ
 * 時間割になっているか**。飛行は**ゲームが投げる球とまったく同じ** `releasePitchFlight`
 * （時計とフォークの手元の失速込み）で数える。
 *
 *   npm run balance:flight
 *
 * それまで（PP-63）は「弧（フォークの落ち方）と残像（速球の伸び）」を測る道具だったが、
 * BBB-76で**投球の見え方そのものを原作準拠に作り直した**（弧と残像はやめた）ので、
 * 確かめる中身もそちらへ差し替えた。
 *
 * 原作（ファミスタ'90）の映像（`C:\Users\manab\Videos\hit.mov` ほか）を1フレームずつ
 * 測った値を「答え」として持ち、ゲームの式（`src/core/pitch.ts`・`camera.ts`・
 * `keyframes.ts`・`tempo.ts`）をそのまま読んで並べる＝**定数を動かせば計測も一緒に動く**。
 *
 * 1. リリース→打つ瞬間のフレーム数（球速別。原作の7球と並べる）
 * 2. 投球モーションと、スイングの絵の時間割（原作のフレーム数と並べる）
 * 3. 画面上で球が等速に下りてくるか（3Dのまま描いたときとの比較）
 * 4. 描く場所が本当の場所と一致する点（リリース・打撃面）と、途中のずれ
 * 5. 球と影の見かけの大きさ（原作の 4×4→6×6 ドット・影 4×2→5×3 ドットと並べる）
 * 6. 盗塁の窓がどう変わったか（モーションが長くなり、飛行が短くなった）
 */
import {
  BALL_RADIUS,
  DEKKAI_PITCH_SIZE_FAR,
  DEKKAI_PITCH_SIZE_NEAR,
  DEKKAI_PITCH_SIZE_SWITCH,
  dekkaiBallScale,
  dekkaiFovFor,
  dekkaiPitchLook,
  dekkaiScreenRise,
  dekkaiViewDepth,
  pitchLineHeight,
} from '../../src/core/camera';
import { CONTACT_PLANE_Z, SWING_IDEAL_SEC } from '../../src/core/batting';
import { CONTACT_BLACKOUT_SEC, CONTACT_HOLD_SEC } from '../../src/core/tempo';
import {
  PITCH_RELEASE_FRAMES,
  PITCH_WINDUP_KEYS,
  STEAL_GO_SEC,
  SWING_FINISH_FROM,
  SWING_RETURN_FROM,
  SWING_TOTAL_SEC,
  swingKeyAt,
} from '../../src/core/keyframes';
import {
  CATCH_Z,
  PITCH_WINDUP_SEC,
  PLATE_Z,
  RELEASE_Z,
  SPEED_FAST_DELTA,
  SPEED_SLOW_DELTA,
  FAST_BALL_PACE,
  armReleaseHeight,
  flightSecondsUntil,
  neutralSpeedFor,
  pitchClockRate,
  releasePitchFlight,
  stepPitchFlight,
} from '../../src/core/pitch';
import {
  BASE_POSITIONS,
  STEAL_LEAD,
  stealSafeJumpSec,
} from '../../src/core/fielding';

const FRAME = 1 / 60;
const f1 = (v: number): string => v.toFixed(1);
const row = (cells: readonly string[], w = 12): string => cells.map((c) => c.padStart(w)).join('');

/**
 * 原作の映像で測った球（リリース→影が打撃面に来るまでのフレーム数。影の進み＝0.047ドット/フレーム×km/h）。
 * **118km/h の球は BBB-76 では「遅い球」と読んでいたが、同じ投手の普通の球のばらつきだった**
 * （手元で遅くならない）。フォークは 115km/h で**手元で失速して 33フレーム**（BBB-77で測り直した）。
 */
const ORIGINAL_PITCHES: ReadonlyArray<{ kmh: number; frames: number; note: string }> = [
  { kmh: 151, frames: 18.9, note: '速球' },
  { kmh: 148, frames: 19.4, note: '速球' },
  { kmh: 129, frames: 22.3, note: '普通（2球）' },
  { kmh: 129, frames: 23.0, note: '打った球（hit.mov）' },
  { kmh: 118, frames: 24.5, note: '普通のばらつき' },
  { kmh: 115, frames: 33.0, note: 'フォーク（手元で失速）' },
];

const overArm = { side: 1 as const, slot: 'over' as const };
const releaseHeight = armReleaseHeight(overArm);
const neutral = neutralSpeedFor();

/** リリース→打撃面の実時間（ゲームの式どおり。フォークは手元の失速込み） */
function contactSec(speed: number, center = neutral): number {
  return flightSecondsUntil(releasePitchFlight(0, speed, 0, center), CONTACT_PLANE_Z);
}

console.log('=== 1. リリース→打つ瞬間（打撃面）のフレーム数 ===');
console.log(row(['球', '球速m/s', '時計', 'ゲーム', '原作'], 12));
for (const [label, speed, orig] of [
  ['速球', neutral + SPEED_FAST_DELTA, `18.9〜19.4（BBB-77で普通の1/${FAST_BALL_PACE}に広げた）`],
  ['普通', neutral, '22.3〜23.0'],
  ['フォーク', neutral - SPEED_SLOW_DELTA, '33（手元で失速）'],
] as const) {
  console.log(
    row([
      label,
      speed.toFixed(1),
      `×${pitchClockRate(speed).toFixed(2)}`,
      `${f1(contactSec(speed) / FRAME)}f`,
      `${orig}f`,
    ]),
  );
}
console.log('原作の7球（km/h → フレーム）：' + ORIGINAL_PITCHES.map((p) => `${p.kmh}→${p.frames}`).join(' / '));
console.log('参考：PITCH_CLOCK_SPEEDUP を掛ける前（球速どおり）の普通の球は ' +
  `${f1(((RELEASE_Z - CONTACT_PLANE_Z) / -neutral) / FRAME)}f、遅い球は ` +
  `${f1(((RELEASE_Z - CONTACT_PLANE_Z) / -(neutral - SPEED_SLOW_DELTA)) / FRAME)}f だった。`);
console.log('名鑑の投手（SPDの端）：');
for (const spd of [0, 0.5, 1]) {
  const c = neutralSpeedFor(spd);
  console.log(
    `  SPD${spd.toFixed(1)}：速球 ${f1(contactSec(c + SPEED_FAST_DELTA, c) / FRAME)}f／普通 ${f1(contactSec(c, c) / FRAME)}f／遅い球 ${f1(contactSec(c - SPEED_SLOW_DELTA, c) / FRAME)}f`,
  );
}

console.log('\n=== 2. 時間割（原作のフレーム数） ===');
console.log(`投球モーション：${f1(PITCH_WINDUP_SEC / FRAME)}f（原作 70f）。絵の切り替え：` +
  PITCH_WINDUP_KEYS.map((k) => `${k.key}@${k.fromFrame}`).join(' ') + `／リリースの絵 ${PITCH_RELEASE_FRAMES}f（原作 16f）`);
console.log(`スイング：当たる絵の始まり ${f1(SWING_IDEAL_SEC / FRAME)}f（原作 6f）／振り切った形 ${f1(SWING_FINISH_FROM / FRAME)}f〜` +
  `${f1(SWING_RETURN_FROM / FRAME)}f（原作 12f〜53f）／構えへ戻り切る ${f1(SWING_TOTAL_SEC / FRAME)}f（原作 61f）`);
const keysByFrame: string[] = [];
for (let f = 0; f < Math.ceil(SWING_TOTAL_SEC / FRAME) + 1; f++) keysByFrame.push(swingKeyAt(f * FRAME).slice(0, 2));
console.log('  1フレームずつ：' + keysByFrame.join(' '));
console.log(`打った後：当たった絵 ${f1(CONTACT_HOLD_SEC / FRAME)}f → 黒 ${f1(CONTACT_BLACKOUT_SEC / FRAME)}f（原作 2f → 7f）`);

console.log('\n=== 3. 画面上で球が等速に下りてくるか（普通の球。1280x720） ===');
{
  const fov = dekkaiFovFor(16 / 9);
  const pxPerRise = 720 / (2 * Math.tan((fov / 2) * Math.PI / 180));
  const speed = neutral;
  let flight = releasePitchFlight(0, speed, 0);
  const drawn: number[] = [];
  const raw: number[] = [];
  for (let i = 0; i < 40 && flight.z < CONTACT_PLANE_Z; i++) {
    const look = dekkaiPitchLook(flight, releaseHeight);
    drawn.push(-dekkaiScreenRise(look.center) * pxPerRise);
    raw.push(-dekkaiScreenRise({ y: pitchLineHeight(flight.z, releaseHeight), z: flight.z }) * pxPerRise);
    flight = stepPitchFlight(flight, 0, FRAME);
  }
  const step = (a: number[]) => a.slice(1).map((v, i) => v - a[i]);
  const ds = step(drawn);
  const rs = step(raw);
  console.log(`描く球：1フレームに ${f1(Math.min(...ds))}〜${f1(Math.max(...ds))}px（等速）`);
  console.log(`3Dのまま：${f1(Math.min(...rs))}〜${f1(Math.max(...rs))}px（手元で${f1(Math.max(...rs) / Math.min(...rs))}倍に加速）`);
  const half = Math.floor(raw.length / 2);
  console.log(
    `時間の前半で進む割合：描く球 ${((drawn[half] - drawn[0]) / (drawn[drawn.length - 1] - drawn[0]) * 100).toFixed(0)}%／` +
      `3Dのまま ${((raw[half] - raw[0]) / (raw[raw.length - 1] - raw[0]) * 100).toFixed(0)}%（原作 50%）`,
  );
}

console.log('\n=== 4. 描く場所と本当の場所 ===');
{
  for (const z of [RELEASE_Z, -12, -6, -3, CONTACT_PLANE_Z, PLATE_Z, 1, CATCH_Z]) {
    const look = dekkaiPitchLook({ x: 0, z, vx: 0, vz: neutral }, releaseHeight);
    console.log(`  本当 z=${z.toFixed(2).padStart(6)} → 描く z=${look.center.z.toFixed(2).padStart(6)}（${(look.center.z - z >= 0 ? '+' : '') + (look.center.z - z).toFixed(2)}m）`);
  }
  console.log('  リリースと打撃面は一致＝手から出て、バットのところで当たる。途中は先へ描く（等速に見せるため）。');
}

console.log('\n=== 5. 球と影の見かけ（1280x720・ZZ-74の画角。原作は 240ドットの画面で球 4→6・影 4×2→5×3） ===');
{
  const fov = dekkaiFovFor(16 / 9);
  const ppm = (d: number) => 720 / (2 * d * Math.tan((fov / 2) * Math.PI / 180));
  for (const z of [RELEASE_Z + 0.5, -8, CONTACT_PLANE_Z]) {
    const look = dekkaiPitchLook({ x: 0, z, vx: 0, vz: neutral }, releaseHeight);
    const ball = 2 * BALL_RADIUS * look.scale * ppm(dekkaiViewDepth(look.center));
    const ground = { x: look.shadow.x, y: 0, z: look.shadow.z };
    const shadowW = 2 * BALL_RADIUS * look.shadow.scale * ppm(dekkaiViewDepth(ground));
    console.log(`  z=${z.toFixed(1).padStart(6)}：球 ${f1(ball)}px／影 幅 ${f1(shadowW)}px（原作×3＝球 12→18px）`);
  }
  console.log(`  大きくなる場所：リリース→ミットの ${(DEKKAI_PITCH_SIZE_SWITCH * 100).toFixed(0)}%（原作 13/23）。` +
    `倍率 ${DEKKAI_PITCH_SIZE_FAR.toFixed(3)}→${DEKKAI_PITCH_SIZE_NEAR.toFixed(3)}（基準 ${dekkaiBallScale({ x: 0, y: 1, z: PLATE_Z }).toFixed(2)}）`);
}

console.log('\n=== 6. 盗塁の窓（走者が走り出せる「投手の踏み出し」からの持ち時間） ===');
console.log(`  踏み出しはモーションの ${f1(STEAL_GO_SEC / FRAME)}f 目＝リリースの ${f1((PITCH_WINDUP_SEC - STEAL_GO_SEC) / FRAME)}f 前（それまでのモーション 0.35s＝21f）`);
{
  const first = stealSafeJumpSec('first', BASE_POSITIONS.home, STEAL_LEAD);
  const zero = stealSafeJumpSec('first', BASE_POSITIONS.home, 0);
  for (const [label, speed] of [
    ['速球', neutral + SPEED_FAST_DELTA],
    ['普通', neutral],
    ['フォーク', neutral - SPEED_SLOW_DELTA],
  ] as const) {
    const flight = flightSecondsUntil(releasePitchFlight(0, speed, 0), CATCH_Z);
    const max = PITCH_WINDUP_SEC - STEAL_GO_SEC + flight;
    console.log(
      `  ${label}：リリース時の残り ${flight.toFixed(3)}s・踏み出し ${max.toFixed(3)}s ／ ` +
        `一塁の境界 ${first.toFixed(3)}s（リリース後でも${flight >= first ? '間に合う' : '遅い'}）・リード0 ${zero.toFixed(3)}s（${max >= zero ? '踏み出しなら間に合う' : '不可'}）`,
    );
  }
}
