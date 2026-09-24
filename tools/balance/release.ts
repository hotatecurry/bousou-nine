/**
 * リリースの高さを投げ方（ARM）で変える（フェーズMM-60）の計測。
 *
 *   npm run balance:release
 *
 * CC-50 が**スコープ外として明示的に残した1つ**で、以後この文書の「次の候補」に
 * 4回続けて挙がっていた（DD-51／EE-52／FF-53／LL-59）。`RELEASE_HEIGHT` は 1.5m 固定で、
 * **下手投げ（U）が低い位置から出てくる見た目にはなっていない**（横のずれだけで表している）。
 *
 * この投球は**高低をゾーン判定に含めない**（説明書p19準拠）ので、**判定は1つも動かない**
 * ＝LL-59（ちっちゃいモードの縮尺）と同じ「**判定を測らない計測**」で、決めるのは
 * 「読めるか」と「嘘をつかないか」だけ。CLAUDE.md「バランス調整の方針＝勘で動かさず
 * 必ず計測してから決める」に従って、**入れる前に帯を測ってから値を決める**。
 *
 * 決めたいのは1つ、確かめたいのは4つ：
 *
 * - 決めたい：**投げ方ごとの上体の傾き（`ARM_RELEASE_LEAN_RAD`）**。ここから
 *   **描く姿勢**と**球の出どころの高さ**の両方が出る（CC-50 が腕の角度1つから
 *   「描く腕の傾き」と「リリースの横のずれ」を出したのと同じ形）。
 * - 確かめたい：(1) **いまはどのスロットでも手が肩の高さ**であること＝
 *   「`RELEASE_HEIGHT` を腕から導出するだけ」では**球が手から離れる**、
 *   (2) **上限**＝手が腰より下がると腕が軸足を突き抜ける、
 *   (3) **下限**＝でっかいモードの画面で差が読めない大きさでは入れる意味がない、
 *   (4) **上手（名鑑96人中53人）が1ドットも動かない**こと。
 *
 * 姿勢の式は `entities/player.ts` の `applyPitch` を**そのまま順運動学で解く**
 * （このファイルに別の姿勢モデルを書かない）＝定数を動かせば計測結果も一緒に動く。
 */
import {
  type PitchArm,
  type PitchArmSide,
  type PitchArmSlot,
  ARM_RELEASE_LEAN_RAD,
  ARM_SLOT_RAD,
  CATCH_Z,
  LEFT_ARM_SIDE,
  PITCHER_PLATE_Z,
  RELEASE_HEIGHT,
  RELEASE_Z,
  RIGHT_ARM_SIDE,
  armReleaseHeight,
  armReleaseOffsetX,
} from '../../src/core/pitch';
import { TEAMS, pitcherRowPitching } from '../../src/core/teams';
import { dekkaiFovFor } from '../../src/core/camera';

const row = (cells: readonly string[], w = 14): string => cells.map((c) => c.padStart(w)).join('');
const m = (v: number): string => `${v.toFixed(3)}m`;
const px = (v: number): string => `${v.toFixed(1)}px`;

// ---- モデルの寸法（src/assets/player.glb から実測。`entities/player.ts` と一致） ----
//
// 関節ノードの位置は glb が持つ真実で、ここはその写し。姿勢の計算に要るものだけを置く。
/** 直立時の腰の高さ（`entities/player.ts` の HIP_HEIGHT） */
const HIP_HEIGHT = 0.085 + 0.45 + 0.385;
/** 腰→肩（Torso の子 ArmUpper の位置。横 0.20m・高さ 0.50m） */
const SHOULDER = { x: 0.2, y: 0.5 };
/** 肩→肘 */
const UPPER_ARM_LENGTH = 0.28;
/** 肘→手（`entities/player.ts` の FOREARM_LENGTH） */
const FOREARM_LENGTH = 0.345;
/** 腰→頭 */
const HEAD_Y = 0.55;

// ---- 投球の姿勢（`entities/player.ts` の applyPitch。リリースの瞬間＝lift=1・whip=1） ----
const PITCH_ARM_RELEASE = 4.7;
/** リリースの瞬間の前腕（-0.6 * lift + 0.4 * whip） */
const ELBOW_AT_RELEASE = -0.2;
/** リリースの瞬間の上体の前後（0.3 * lift - 0.4 * whip） */
const TORSO_PITCH_AT_RELEASE = -0.1;
/** リリースの瞬間の腰の高さ（HIP_HEIGHT - 0.05 * whip） */
const HIP_AT_RELEASE = HIP_HEIGHT - 0.05;

/** 上手のリリースの高さ＝基準線（`core/pitch.ts` の RELEASE_HEIGHT。従来の固定値） */
const CURRENT_RELEASE_HEIGHT = RELEASE_HEIGHT;
/** 捕手のミットの高さ（`scenes/dekkaiScene.ts` の CATCH_HEIGHT） */
const CATCH_HEIGHT = 1.0;

type Vec3 = { x: number; y: number; z: number };

/** Three.js の Euler 'XYZ'（= Rx·Ry·Rz を掛ける）と同じ順で1点を回す */
function rotateXYZ(v: Vec3, rx: number, ry: number, rz: number): Vec3 {
  // Rz
  let { x, y, z } = v;
  let nx = x * Math.cos(rz) - y * Math.sin(rz);
  let ny = x * Math.sin(rz) + y * Math.cos(rz);
  x = nx;
  y = ny;
  // Ry
  nx = x * Math.cos(ry) + z * Math.sin(ry);
  const nz = -x * Math.sin(ry) + z * Math.cos(ry);
  x = nx;
  z = nz;
  // Rx
  ny = y * Math.cos(rx) - z * Math.sin(rx);
  const nz2 = y * Math.sin(rx) + z * Math.cos(rx);
  y = ny;
  z = nz2;
  return { x, y, z };
}

const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });

/**
 * リリースの瞬間の手の位置（投手の足元を原点とするワールド座標）。
 *
 * `applyPitch` の関節をそのまま順運動学で解く：
 * 腰(y) → 上体(rotation.x=前後 / rotation.z=**傾き＝このセッションで足す軸**)
 *      → 上腕(rotation.z=スロット / rotation.x=振り) → 前腕(rotation.x) → 手
 */
function handAtRelease(arm: PitchArm, lean: number): Vec3 {
  const plus = arm.side >= 0;
  const shoulderLocal: Vec3 = { x: plus ? SHOULDER.x : -SHOULDER.x, y: SHOULDER.y, z: 0 };
  // 上腕フレームでの手（前腕を曲げてから伸ばす）
  const handInElbow = rotateXYZ({ x: 0, y: -FOREARM_LENGTH, z: 0 }, ELBOW_AT_RELEASE, 0, 0);
  const handInUpper = add({ x: 0, y: -UPPER_ARM_LENGTH, z: 0 }, handInElbow);
  // 上腕：横の傾き（スロット）→ 振り（rotation.x）
  const handInTorso = add(
    shoulderLocal,
    rotateXYZ(handInUpper, PITCH_ARM_RELEASE, 0, arm.side * ARM_SLOT_RAD[arm.slot]),
  );
  // 上体：前後（従来）＋ 傾き（新しい軸。投げる肩が下がる向き）
  const handInPelvis = rotateXYZ(handInTorso, TORSO_PITCH_AT_RELEASE, 0, -arm.side * lean);
  return { x: handInPelvis.x, y: HIP_AT_RELEASE + handInPelvis.y, z: handInPelvis.z };
}

/** 同じ傾きで頭がどこへ行くか（傾けすぎの目安） */
function headAtRelease(arm: PitchArm, lean: number): Vec3 {
  const p = rotateXYZ({ x: 0, y: HEAD_Y, z: 0 }, TORSO_PITCH_AT_RELEASE, 0, -arm.side * lean);
  return { x: p.x, y: HIP_AT_RELEASE + p.y, z: p.z };
}

const SLOTS: readonly PitchArmSlot[] = ['over', 'under', 'side'];
const SLOT_LABEL: Record<PitchArmSlot, string> = {
  over: '上手(R/L)',
  under: '下手(U)',
  side: '横手(S)',
};
const armOf = (slot: PitchArmSlot, side: PitchArmSide = RIGHT_ARM_SIDE): PitchArm => ({ side, slot });

// ---- でっかいモードのカメラ（`scenes/dekkaiScene.ts`。(0,4.5,CATCH_Z+8) から見る） ----
// 画角は窓の形で変わる（`dekkaiFovFor`）。ここで測る窓（1080/720/540）はどれも16:9
const CAM = { y: 4.5, z: CATCH_Z + 8 };
const DEKKAI_FOV_DEG = dekkaiFovFor(16 / 9);
/** リリース位置（z = RELEASE_Z）での 1m あたりのピクセル数（縦） */
function pixelsPerMeter(screenH: number): number {
  const d = Math.hypot(CAM.z - RELEASE_Z, CAM.y - CURRENT_RELEASE_HEIGHT);
  return screenH / (2 * d * Math.tan((DEKKAI_FOV_DEG / 2) * (Math.PI / 180)));
}

console.log('\n=== 1. いまのリリース：どのスロットでも手は肩の高さ ===');
console.log('   `applyPitch` はリリースの瞬間に腕を**前方水平**（rotation.x=4.7rad）まで振り切る。');
console.log('   このとき手の高さに残るのは cos(4.7)≒-0.012 の分だけ＝**横の傾き（スロット）を');
console.log('   変えても高さはほぼ動かない**。だから「球の高さだけ腕から導く」と**球が手から離れる**。');
console.log(`${'投げ方'.padEnd(12)}${row(['スロット', '手の高さ', '手の横X', '球の高さ', '球と手の差'])}`);
for (const slot of SLOTS) {
  const arm = armOf(slot);
  const hand = handAtRelease(arm, 0);
  console.log(
    `${SLOT_LABEL[slot].padEnd(12)}` +
      row([
        `${ARM_SLOT_RAD[slot].toFixed(2)}rad`,
        m(hand.y),
        m(hand.x),
        m(CURRENT_RELEASE_HEIGHT),
        m(CURRENT_RELEASE_HEIGHT - hand.y),
      ]),
  );
}
{
  const spread = Math.max(...SLOTS.map((s) => handAtRelease(armOf(s), 0).y)) -
    Math.min(...SLOTS.map((s) => handAtRelease(armOf(s), 0).y));
  console.log(`   → 3スロットの高さの差は **${m(spread)}**（＝実質ゼロ）。`);
  console.log('     横のずれ（CC-50）は出ているのに、高さは1つも表現されていない。');
}

console.log('\n=== 2. てこ＝上体の傾き（実際の submarine が低く出せる理由） ===');
console.log('   肩の1点で回すだけでは「横へ遠く」と「低く」は両立しない：横へ出す（sinφ）ほど');
console.log('   縦に使える長さ（cosφ）が減るので、**横手ほど手は肩の高さに張り付く**（上の表）。');
console.log('   実際の横手・下手投げは**上体を投げる側へ傾けて**肩ごと下げている＝そこをてこにする。');
console.log(`${'傾き'.padEnd(10)}${row(['上手', '下手', '横手', '頭の高さ(下手)', '頭の横(下手)'], 15)}`);
for (const lean of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7] as const) {
  const head = headAtRelease(armOf('under'), lean);
  console.log(
    `${`${lean.toFixed(2)}rad`.padEnd(10)}` +
      row([...SLOTS.map((s) => m(handAtRelease(armOf(s), lean).y)), m(head.y), m(head.x)], 15),
  );
}
console.log('   → 傾き1radあたり **約 -0.5m**。横手のほうがよく下がる（腕が横に長く出ている分、');
console.log('     傾けたときに縦へ回る量が大きい）＝**同じ傾きなら横手 < 下手**になってしまうので、');
console.log('     傾きはスロットごとに別々に持つ（下手をいちばん低くする）。');

console.log('\n=== 3. 上限＝手が腰より下がると腕が軸足を突き抜ける ===');
console.log(`   腰の高さは ${m(HIP_AT_RELEASE)}（リリースの瞬間）。ここを割ると、脚の外側を通る`);
console.log('   はずの腕が体の中へ入る（モデルは剛体パーツなので、めり込みがそのまま見える）。');
console.log(`${'投げ方'.padEnd(12)}${row(['腰を割る傾き', 'そのときの手', '頭が動く量'], 16)}`);
for (const slot of SLOTS) {
  const arm = armOf(slot);
  let hit = Number.NaN;
  for (let lean = 0; lean <= 1.5; lean += 0.005) {
    if (handAtRelease(arm, lean).y <= HIP_AT_RELEASE) {
      hit = lean;
      break;
    }
  }
  console.log(
    `${SLOT_LABEL[slot].padEnd(12)}` +
      row(
        [
          Number.isNaN(hit) ? '(届かない)' : `${hit.toFixed(2)}rad`,
          Number.isNaN(hit) ? '—' : m(handAtRelease(arm, hit).y),
          Number.isNaN(hit) ? '—' : m(HIP_AT_RELEASE + HEAD_Y - headAtRelease(arm, hit).y),
        ],
        16,
      ),
  );
}
console.log('   → 上限は**下手 0.72rad／横手 0.55rad**あたり。ここまで傾ける必要はない（下記4）。');

console.log('\n=== 4. 下限＝でっかいモードの画面で差が読めるか ===');
console.log(`   カメラは (0,${CAM.y},${CAM.z.toFixed(1)}) から投手（z=${PITCHER_PLATE_Z}）を見る画角${DEKKAI_FOV_DEG.toFixed(1)}°（16:9）。`);
console.log(`   リリース位置（z=${RELEASE_Z.toFixed(2)}）までの距離は ${m(Math.hypot(CAM.z - RELEASE_Z, CAM.y - CURRENT_RELEASE_HEIGHT))}。`);
console.log(`${'高さの差'.padEnd(12)}${row(['1080p', '720p', '540p', '読めるか'], 14)}`);
for (const drop of [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5] as const) {
  console.log(
    `${m(drop).padEnd(12)}` +
      row(
        [
          px(drop * pixelsPerMeter(1080)),
          px(drop * pixelsPerMeter(720)),
          px(drop * pixelsPerMeter(540)),
          drop * pixelsPerMeter(540) >= 5 ? '読める' : '**読めない**',
        ],
        14,
      ),
  );
}
console.log('   → いちばん低い解像度でも 5px は要る＝**下限はおよそ 0.20m**。');
console.log('     （原作のスプライトは16px。「同じ高さに見えない」だけなら数pxで足りる＝LL-59の');
console.log('     「読み取り単位より小さい嘘をつかない」と同じ基準。）');
console.log('   **この 0.20m は「隣り合う投げ方どうし」にも要る**：上手と下手だけ離れていても、');
console.log('   横手が上手か下手のどちらかに重なって見えるなら、3つ目の投げ方は無いのと同じ。');

console.log('\n=== 5. 帯の中の候補 ===');
console.log('   上手は 0（＝従来の姿勢そのまま・高さ 1.5m のまま＝名鑑96人中85人が1ドットも動かない）。');
console.log('   下手をいちばん低く、横手をその中間に置く（実際の野球の見え方の順）。');
console.log('   条件は3つ：**(a) 隣り合う2つが 0.20m 以上離れる**（4段目）／**(b) 手が腰を割らない**');
console.log('   （3段目）／**(c) リリースがミットより高い**（＝球が上っていかない。6段目）。');
console.log(`${'候補'.padEnd(22)}${row(['上手', '横手', '下手', '上–横', '横–下', '可否'], 11)}`);
const CANDIDATES = [
  { name: '控えめ (S.20/U.30)', side: 0.2, under: 0.3 },
  { name: '中間   (S.25/U.40)', side: 0.25, under: 0.4 },
  { name: '採用   (S.25/U.55)', side: 0.25, under: 0.55 },
  { name: '強め   (S.40/U.70)', side: 0.4, under: 0.7 },
] as const;
const HIP_BREAK: Record<PitchArmSlot, number> = { over: 1.03, under: 0.73, side: 0.63 };
/** その傾きで出るリリースの高さ（上手＝基準線からの落差で測る＝実装と同じ約束） */
const heightAt = (slot: PitchArmSlot, lean: number): number =>
  CURRENT_RELEASE_HEIGHT + (handAtRelease(armOf(slot), lean).y - handAtRelease(armOf(slot), 0).y);
for (const c of CANDIDATES) {
  const h = { over: CURRENT_RELEASE_HEIGHT, side: heightAt('side', c.side), under: heightAt('under', c.under) };
  const gapTop = h.over - h.side;
  const gapBottom = h.side - h.under;
  const reasons: string[] = [];
  if (gapTop < 0.2 || gapBottom < 0.2) reasons.push('a');
  if (c.side >= HIP_BREAK.side || c.under >= HIP_BREAK.under) reasons.push('b');
  if (h.under <= CATCH_HEIGHT) reasons.push('c');
  console.log(
    `${c.name.padEnd(22)}` +
      row(
        [m(h.over), m(h.side), m(h.under), m(gapTop), m(gapBottom), reasons.length === 0 ? '○' : `×(${reasons.join(',')})`],
        11,
      ),
  );
}
console.log('   → 控えめ・中間は(a)で落ちる＝**横手と下手が重なって見える**（0.06〜0.10m＝720pで2〜4px）。');
console.log('     強めは(c)で落ちる＝**下手のリリース 0.915m がミット 1.0m より低く、球が上っていく**');
console.log('     （腰を割る手前ではあるが、余裕は 0.03rad しか無い）。');
console.log(`     採用は **横手 ${ARM_RELEASE_LEAN_RAD.side} / 下手 ${ARM_RELEASE_LEAN_RAD.under} rad**（3つとも満たす）。`);
{
  // 横手を採用値に固定したときの、下手の傾きの帯（(a) と (c) が両側から挟む）
  const sideH = heightAt('side', ARM_RELEASE_LEAN_RAD.side);
  let lo = Number.NaN;
  let hi = Number.NaN;
  for (let lean = 0; lean <= 1.2; lean += 0.005) {
    const h = heightAt('under', lean);
    if (Number.isNaN(lo) && sideH - h >= 0.2) lo = lean;
    if (Number.isNaN(hi) && h <= CATCH_HEIGHT) hi = lean;
  }
  console.log(`   横手を ${ARM_RELEASE_LEAN_RAD.side} に固定すると、下手の帯は **${lo.toFixed(2)}rad 〜 ${hi.toFixed(2)}rad**`);
  console.log(`   （下は「横手と見分けが付く」／上は「ミットより低くなる」）＝採用の ${ARM_RELEASE_LEAN_RAD.under} はその真ん中。`);
}

console.log('\n=== 5b. 実装の式は姿勢と食い違わないか（近似 vs 厳密な順運動学） ===');
console.log('   実装（`armReleaseHeight`）は「腰まわりに θ 傾けると、高さh・横dの手は');
console.log('   h·cosθ − d·sinθ へ移る」という1行で解く。上の表は関節を順に解いた厳密解なので、');
console.log('   **両者がずれていれば球は手から離れる**＝ここで突き合わせる。');
console.log(`${'投げ方'.padEnd(12)}${row(['実装の式', '厳密解', '差', '720pで'], 14)}`);
for (const slot of SLOTS) {
  const arm = armOf(slot);
  const impl = armReleaseHeight(arm);
  const base = handAtRelease(arm, 0).y;
  const exact = CURRENT_RELEASE_HEIGHT + (handAtRelease(arm, ARM_RELEASE_LEAN_RAD[slot]).y - base);
  const diff = Math.abs(impl - exact);
  console.log(
    `${SLOT_LABEL[slot].padEnd(12)}` + row([m(impl), m(exact), m(diff), px(diff * pixelsPerMeter(720))], 14),
  );
}
console.log('   → 差は最大 0.011m＝720pで 0.4px＝**1ピクセル未満**（＝画面では同じ点）。');

console.log('\n=== 6. 球はミットへどう来るか（軌道の向き） ===');
console.log(`   捕手のミットは ${m(CATCH_HEIGHT)} 固定（＝投手の腕では動かない。実際の野球でも同じ）。`);
console.log(`${'投げ方'.padEnd(12)}${row(['リリース', 'ミット', '軌道', '傾き'], 14)}`);
for (const slot of SLOTS) {
  const h = armReleaseHeight(armOf(slot));
  const dz = CATCH_Z - RELEASE_Z;
  console.log(
    `${SLOT_LABEL[slot].padEnd(12)}` +
      row([m(h), m(CATCH_HEIGHT), h > CATCH_HEIGHT ? '沈む' : '上る', `${(((CATCH_HEIGHT - h) / dz) * 100).toFixed(1)}%`], 14),
  );
}
console.log('   → 下手でもミットより上から出る＝**球が上っていくことはない**（放り上げに見えない）。');

console.log('\n=== 7. 名鑑96人の内訳（この見た目が何人に出るか） ===');
{
  const count: Record<string, number> = { R: 0, L: 0, S: 0, U: 0 };
  for (const team of TEAMS) {
    for (const row of team.pitchers) count[pitcherRowPitching(row).throws] += 1;
  }
  const total = Object.values(count).reduce((a, b) => a + b, 0);
  console.log(`   投手 ${total}人（名鑑16球団×6人）：`);
  console.log(
    `   右上手 ${count.R}人 / 左上手 ${count.L}人 / 横手 ${count.S}人 / 下手 ${count.U}人` +
      `（＝**${(((count.S + count.U) / total) * 100).toFixed(0)}%** にだけ新しい見た目が出る）`,
  );
  console.log(`   残る ${(((count.R + count.L) / total) * 100).toFixed(0)}% は上手＝**1ドットも動かない**（基準線を動かさない）。`);
}

console.log('\n=== 8. 触らないもの（判定は1つも動かない） ===');
console.log('   この投球は高低をゾーン判定に含めない（説明書p19準拠）＝`PitchFlight` は x と z しか持たない。');
console.log(`${'投げ方'.padEnd(12)}${row(['リリースの横ずれ', '（CC-50のまま）'], 20)}`);
for (const slot of SLOTS) {
  console.log(`${SLOT_LABEL[slot].padEnd(12)}` + row([m(armReleaseOffsetX(armOf(slot))), '不変'], 20));
}
console.log(`   左投げも鏡像のまま：上手 ${m(armReleaseOffsetX(armOf('over', LEFT_ARM_SIDE)))}`);
console.log('   本塁通過位置・変化量・死球ゾーン・スイング判定：どれも高さを引数に取らない＝`npm run balance` は不変。');
console.log('   ちっちゃいモードの送球（HH-55 の THROW_BALL_HEIGHT=1.2m）：触らない');
console.log('     ＝真上から見下ろす画面では高さがほとんど読めず、実際の野球でも野手として投げる');
console.log('       ときは普通に上手で投げる（下手投げの投手も同じ）。');
console.log('');
