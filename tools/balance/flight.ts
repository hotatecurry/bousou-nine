/**
 * 投球の見え方（フェーズPP-63）の計測＝**弧（フォークの落ち方）と残像（速球の伸び）**。
 *
 *   npm run balance:flight
 *
 * LL-59（選手の縮尺）・NN-61（ボールの大きさ）と同じ**判定を1つも測らない計測**＝
 * 決めるのは「読めるか」だけ。**高低はゾーン判定に無関係**（説明書p19準拠。`PitchFlight` は
 * x と z しか持たない）ので、ここで動かす値は試合の帰結を1つも動かさない
 * （`npm run balance` は完全に不変）。
 *
 * 決めたいのは2つ、確かめたいのは4つ：
 *
 * - 決めたい：**弧の重力**（ユーザー判断で「放物線」「遅い球だけ」が決まっているので、
 *   残るのは大きさ＝実際の重力 9.8 で成り立つのか）と、**残像の長さ**。
 * - 確かめたい：(1) 旧実装が何をしていたか（**地面へ潜る**）、(2) 弧が**画面から出ない**、
 *   (3) **落差が読める**（画面px）／**打者が振るころには下っている**（P-37の「見てから
 *   振れる」と同じ基準）、(4) **基準速・速球の見え方が1ドットも動かない**。
 *
 * 幾何と式は `src/core/camera.ts` / `src/core/pitch.ts` をそのまま読む（このファイルに
 * 弧の式やカメラの置き場所を書かない）＝定数を動かせば計測結果も一緒に動く。
 */
import {
  BALL_RADIUS,
  DEKKAI_BALL_ANCHOR_DISTANCE,
  DEKKAI_BALL_SCALE,
  DEKKAI_CAMERA_POS,
  dekkaiFovFor,
  DEKKAI_TRAIL_FRAME_SEC,
  dekkaiBallLook,
  dekkaiBallScale,
  dekkaiScreenMotionAxis,
  dekkaiViewDepth,
  pitchArcPath,
} from '../../src/core/camera';
import { GRAVITY } from '../../src/core/batting';
import { TEAMS, pitcherRowPitching } from '../../src/core/teams';
import {
  CATCH_HEIGHT,
  CATCH_Z,
  PLATE_Z,
  RELEASE_Z,
  SPEED_FAST_DELTA,
  SPEED_SLOW_DELTA,
  armReleaseHeight,
  neutralSpeedFor,
  pitchFastness,
  pitchSlowness,
} from '../../src/core/pitch';

const DEG = Math.PI / 180;
const row = (cells: readonly string[], w = 12): string => cells.map((c) => c.padStart(w)).join('');
const m = (v: number): string => `${v.toFixed(3)}m`;
const px = (v: number): string => `${v.toFixed(1)}px`;
const sec = (v: number): string => `${v.toFixed(3)}s`;

/** 実機で確かめる窓（LL-59・NN-61 と同じ4つ） */
const WINDOWS = [
  { w: 1920, h: 1080 },
  { w: 1280, h: 720 },
  { w: 960, h: 540 },
  { w: 800, h: 600 },
] as const;

/** 旧実装（PP-63の前。`dekkaiScene.ts` にあった式） */
const OLD_FORK_DROP_MAX = 1.5;
const OLD_FAST_STRETCH_MAX = 1.4;

/** 上手投げ（名鑑96人中85人）＝基準線。リリースの高さは MM-60 の導出をそのまま読む */
const OVER_ARM = { side: 1 as const, slot: 'over' as const };
const FROM = armReleaseHeight(OVER_ARM);
const SPAN = CATCH_Z - RELEASE_Z;

/** 緩急3段階（基準の投手＝SPD0.5。名鑑の中央でもある） */
const NEUTRAL = neutralSpeedFor();
const SPEEDS = [
  { name: 'フォーク', vz: NEUTRAL - SPEED_SLOW_DELTA },
  { name: '基準速', vz: NEUTRAL },
  { name: '速球', vz: NEUTRAL + SPEED_FAST_DELTA },
] as const;

/** 能力値の両端（SPD 0.0 / 1.0）も見る＝いちばん遅い球といちばん速い球 */
const SLOWEST = neutralSpeedFor(0) - SPEED_SLOW_DELTA;
const FASTEST = neutralSpeedFor(1) + SPEED_FAST_DELTA;

/** 名鑑96人（16球団×6人）＝実際に画面に出てくる球速の分布 */
const ROSTER_PITCHERS = TEAMS.flatMap((t) =>
  t.pitchers.map((r) => ({ name: r[0] as string, team: t.short, ...pitcherRowPitching(r) })),
);

/** スイングを決める時点＝接触の何秒前か（P-37 が変化球に置いた基準と同じ） */
const DECIDE_SEC = 0.25;

const ROSTER_SPD_MIN = Math.min(...ROSTER_PITCHERS.map((p) => p.speed));
const ROSTER_SPD_MAX = Math.max(...ROSTER_PITCHERS.map((p) => p.speed));
const SLOWEST_ROSTER_FORK = neutralSpeedFor(ROSTER_SPD_MIN) - SPEED_SLOW_DELTA;
const FASTEST_ROSTER_FORK = neutralSpeedFor(ROSTER_SPD_MAX) - SPEED_SLOW_DELTA;

/** 旧実装の高さ（直線から q² で引く。q は本塁を1とする進み） */
function oldHeight(z: number, vz: number, neutral: number): number {
  const progress = (z - RELEASE_Z) / SPAN;
  const slowness = pitchSlowness(vz, neutral);
  const q = Math.max(0, Math.min(1, (z - RELEASE_Z) / (PLATE_Z - RELEASE_Z)));
  const drop = OLD_FORK_DROP_MAX * slowness * q * q;
  return FROM + (CATCH_HEIGHT - FROM) * progress - drop;
}

/** 新実装の高さ（弧。`core/camera.ts` の式をそのまま呼ぶ） */
function arcHeight(z: number, vz: number, neutral: number): number {
  return pitchArcPath(z, vz, FROM, pitchSlowness(vz, neutral)).y;
}

/** 奥行き d にある長さ1mが画面で何pxか */
const fovAtHeight = (screenH: number): number => {
  // 画角は窓の形で変わる（一・三塁の走者が画面に収まる広さ＝`dekkaiFovFor`）
  const win = WINDOWS.find((w) => w.h === screenH);
  return dekkaiFovFor(win ? win.w / win.h : 16 / 9);
};
const ppmAt = (d: number, screenH: number): number =>
  screenH / (2 * d * Math.tan((fovAtHeight(screenH) / 2) * DEG));

/** 画面の縦方向の位置（NDC。+1=上端 / -1=下端）＝画面から出るかを見る */
const forward = (() => {
  const d = dekkaiViewDepth({ x: 0, y: 0, z: 0 });
  // DEKKAI_FORWARD は camera.ts の内部なので、奥行き関数から復元する（差分で向きが出る）
  const ax = dekkaiViewDepth({ x: 1, y: 0, z: 0 }) - d;
  const ay = dekkaiViewDepth({ x: 0, y: 1, z: 0 }) - d;
  const az = dekkaiViewDepth({ x: 0, y: 0, z: 1 }) - d;
  return { x: ax, y: ay, z: az };
})();
/** 画面の上向き（視線に垂直で y-z 面内） */
const up = (() => {
  const len = Math.hypot(forward.y, forward.z);
  return { x: 0, y: -forward.z / len, z: forward.y / len };
})();
function ndcY(p: { x: number; y: number; z: number }): number {
  const dx = p.x - DEKKAI_CAMERA_POS.x;
  const dy = p.y - DEKKAI_CAMERA_POS.y;
  const dz = p.z - DEKKAI_CAMERA_POS.z;
  const along = dx * up.x + dy * up.y + dz * up.z;
  const depth = dekkaiViewDepth(p);
  return along / (depth * Math.tan((dekkaiFovFor(16 / 9) / 2) * DEG));
}

console.log('\n=== 1. 旧実装は何をしていたか（直線から q² で引く） ===');
console.log('   高さは判定に一切効かないが、**いちばん見たい本塁の直前で球が地面へ潜る**。');
console.log(`   NN-61 は下限（球の半径 ${m(BALL_RADIUS)}）を置いただけで、沈み方は触っていない。`);
console.log(`${'球'.padEnd(12)}${row(['球速', '本塁の高さ', 'ミットの高さ', 'y<0 になるz', '潜る距離'])}`);
for (const s of [...SPEEDS, { name: 'いちばん遅い', vz: SLOWEST }]) {
  let zero = NaN;
  for (let z = RELEASE_Z; z <= CATCH_Z; z += 0.01) {
    if (Number.isNaN(zero) && oldHeight(z, s.vz, NEUTRAL) < 0) zero = z;
  }
  console.log(
    `${s.name.padEnd(12)}` +
      row([
        `${s.vz.toFixed(1)}m/s`,
        m(oldHeight(PLATE_Z, s.vz, NEUTRAL)),
        m(oldHeight(CATCH_Z, s.vz, NEUTRAL)),
        Number.isNaN(zero) ? '—' : `z=${zero.toFixed(2)}`,
        Number.isNaN(zero) ? '—' : m(CATCH_Z - zero),
      ]),
  );
}
console.log('   → 遅い球はミットの高さ（1.000m）へ収束しない＝**ミットの下を通って到着する**。');

console.log('\n=== 2. 弧（放物線）＝リリースの高さからミットの高さへ落ちる ===');
console.log(`   飛行時間 T の放物線は、両端を結ぶ直線に \`g T²/2 × p(1-p)\` を足したもの（頂点はその1/4）。`);
console.log(`   重力は打球の飛行と同じ **${GRAVITY} m/s²**（＝「見た目の重力」という自由変数を作らない）。`);
console.log('   弧は slowness に比例させるので、基準速以上の球は直線のまま（基準線を動かさない）。');
console.log(`${'球'.padEnd(14)}${row(['球速', '飛行時間', '頂点の高さ', '頂点のz', '本塁', 'ミット'], 11)}`);
for (const s of [...SPEEDS, { name: 'いちばん遅い', vz: SLOWEST }, { name: 'いちばん速い', vz: FASTEST }]) {
  const neutral = s.name === 'いちばん遅い' ? neutralSpeedFor(0) : s.name === 'いちばん速い' ? neutralSpeedFor(1) : NEUTRAL;
  let apexY = -Infinity;
  let apexZ = RELEASE_Z;
  for (let z = RELEASE_Z; z <= CATCH_Z; z += 0.01) {
    const y = arcHeight(z, s.vz, neutral);
    if (y > apexY) {
      apexY = y;
      apexZ = z;
    }
  }
  console.log(
    `${s.name.padEnd(14)}` +
      row(
        [
          `${s.vz.toFixed(1)}m/s`,
          sec(SPAN / s.vz),
          m(apexY),
          `z=${apexZ.toFixed(1)}`,
          m(arcHeight(PLATE_Z, s.vz, neutral)),
          m(arcHeight(CATCH_Z, s.vz, neutral)),
        ],
        11,
      ),
  );
}
console.log('   → **基準速・速球は直線ちょうど**（頂点＝リリース＝弧なし）＝PP-63の前と完全に同じ。');
console.log('   → 遅い球はミットの高さで終わる＝**地面の下限は構造的に発火しない**。');

console.log('\n=== 3. 弧は画面から出ないか（頂点の縦位置。NDC +1=上端 / -1=下端） ===');
console.log('   球を見失わないことが上限の条件。参考：リリースと本塁の縦位置も並べる。');
console.log(`${'球'.padEnd(14)}${row(['リリース', '頂点', '本塁', 'ミット', '画面内'])}`);
for (const s of [...SPEEDS, { name: 'いちばん遅い', vz: SLOWEST }]) {
  const neutral = s.name === 'いちばん遅い' ? neutralSpeedFor(0) : NEUTRAL;
  let worst = -Infinity;
  for (let z = RELEASE_Z; z <= CATCH_Z; z += 0.01) {
    worst = Math.max(worst, ndcY({ x: 0, y: arcHeight(z, s.vz, neutral), z }));
  }
  const at = (z: number) => ndcY({ x: 0, y: arcHeight(z, s.vz, neutral), z });
  console.log(
    `${s.name.padEnd(14)}` +
      row([
        at(RELEASE_Z).toFixed(3),
        worst.toFixed(3),
        at(PLATE_Z).toFixed(3),
        at(CATCH_Z).toFixed(3),
        worst < 1 ? '○' : '×(はみ出す)',
      ]),
  );
}
console.log('   （画面の縦は -1..+1。0=中央、-0.6 あたりが「画面の8割ほど下」）');

console.log('\n=== 4. 落差は読めるか／打者が振るころには下っているか ===');
console.log('   (a) 落差＝**スイングを決める時点（接触の0.25秒前）から本塁まで**の下がり方。');
console.log(`       球の見かけの直径（${px(2 * BALL_RADIUS * DEKKAI_BALL_SCALE * ppmAt(DEKKAI_BALL_ANCHOR_DISTANCE, 720))}／720p）より大きければ画面で読める。`);
console.log('   (b) 頂点を過ぎるのがその時点より前なら、**見てから振る**ときには必ず下っている');
console.log('       （P-37が変化球に置いた「スイングを決める時点にはもう曲がり終わっている」と同じ基準）。');
console.log(`${'球'.padEnd(14)}${row(['決める地点', '落差(m)', '落差(720p)', '頂点の時刻', '決める時刻', '(b)'], 11)}`);
for (const s of [...SPEEDS, { name: 'いちばん遅い', vz: SLOWEST }]) {
  const neutral = s.name === 'いちばん遅い' ? neutralSpeedFor(0) : NEUTRAL;
  const tPlate = (PLATE_Z - RELEASE_Z) / s.vz;
  const tDecide = Math.max(0, tPlate - DECIDE_SEC);
  const zDecide = RELEASE_Z + s.vz * tDecide;
  const drop = arcHeight(zDecide, s.vz, neutral) - arcHeight(PLATE_Z, s.vz, neutral);
  // 頂点の時刻（弧の式から解析的に：slope=0 になる p）
  const slowness = pitchSlowness(s.vz, neutral);
  const arc = slowness * GRAVITY * (SPAN / s.vz) ** 2 * 0.5;
  const fall = CATCH_HEIGHT - FROM;
  const pApex = arc > 0 ? Math.max(0, Math.min(1, (arc + fall) / (2 * arc))) : 0;
  const tApex = (pApex * SPAN) / s.vz;
  const dropPx = Math.abs(drop) * ppmAt(dekkaiViewDepth({ x: 0, y: CATCH_HEIGHT, z: PLATE_Z }), 720);
  console.log(
    `${s.name.padEnd(14)}` +
      row(
        [
          `z=${zDecide.toFixed(1)}`,
          m(drop),
          px(dropPx),
          sec(tApex),
          sec(tDecide),
          tApex <= tDecide ? '○' : '×',
        ],
        11,
      ),
  );
}
console.log('   （落差が正＝下っている。速球・基準速は直線ぶんだけ下がる＝従来と同じ）');

console.log('\n=== 4b. 名鑑96人のフォークはどう見えるか（重力の候補ごと） ===');
console.log('   弧は飛行時間の2乗で効くので、**球速の遅い投手のフォークほど大きく膨らむ**。');
console.log('   見たいのは「本塁（打者の手元）で、球がリリースより高いところを通らないか」');
console.log('   ＝上を押した球が「高く来た」ようには見えないこと。');
console.log(
  `   名鑑の球速の幅：フォーク ${SLOWEST_ROSTER_FORK.toFixed(1)}〜${FASTEST_ROSTER_FORK.toFixed(1)}m/s（SPD ${ROSTER_SPD_MIN.toFixed(2)}〜${ROSTER_SPD_MAX.toFixed(2)}）`,
);
console.log(`${'重力'.padEnd(12)}${row(['頂点(最大)', '本塁(最大)', 'リリース超', '超過(最大)', '落差(最小)', '画面外'], 11)}`);
for (const g of [9.8, 8, 6, 5, 4, 2]) {
  let apexMax = -Infinity;
  let plateMax = -Infinity;
  let over = 0;
  let dropMinPx = Infinity;
  let offScreen = 0;
  const platePpm = ppmAt(dekkaiViewDepth({ x: 0, y: CATCH_HEIGHT, z: PLATE_Z }), 720);
  for (const p of ROSTER_PITCHERS) {
    const neutral = neutralSpeedFor(p.speed);
    const vz = neutral - SPEED_SLOW_DELTA;
    const T = SPAN / vz;
    const arc = g * T * T * 0.5;
    const height = (z: number): number => {
      const q = Math.max(0, Math.min(1, (z - RELEASE_Z) / SPAN));
      return FROM + (CATCH_HEIGHT - FROM) * q + arc * q * (1 - q);
    };
    const apex = FROM + (CATCH_HEIGHT - FROM) * 0.5 + arc * 0.25;
    apexMax = Math.max(apexMax, apex);
    const atPlate = height(PLATE_Z);
    plateMax = Math.max(plateMax, atPlate);
    if (atPlate > FROM) over += 1;
    const tPlate = (PLATE_Z - RELEASE_Z) / vz;
    const zDecide = RELEASE_Z + vz * Math.max(0, tPlate - DECIDE_SEC);
    dropMinPx = Math.min(dropMinPx, (height(zDecide) - atPlate) * platePpm);
    // 頂点は z のちょうど中間あたりに出るので、そこの縦位置で画面内かを見る
    const zApex = RELEASE_Z + SPAN * 0.5;
    if (ndcY({ x: 0, y: height(zApex), z: zApex }) >= 1) offScreen += 1;
  }
  console.log(
    `${`${g === GRAVITY ? '★' : ' '}${g.toFixed(1)}`.padEnd(12)}` +
      row(
        [
          m(apexMax),
          m(plateMax),
          `${over}/96人`,
          `${Math.max(0, (plateMax - FROM) * 1000).toFixed(0)}mm`,
          px(dropMinPx),
          `${offScreen}/96人`,
        ],
        11,
      ),
  );
}
console.log(`   ★＝実際の重力（打球の飛行と同じ ${GRAVITY}）。`);

console.log('\n=== 5. 残像＝1フレームで画面上に動く距離 ===');
console.log('   旧実装はワールドZ方向へ引き伸ばしていた＝**視線に沿うので画面にほとんど出ない**。');
console.log(`   まず、旧実装の伸び（最大 ${OLD_FAST_STRETCH_MAX}）が画面でどれだけ見えていたか：`);
{
  const vz = FASTEST;
  const neutral = neutralSpeedFor(1);
  const p = { x: 0, y: arcHeight(PLATE_Z, vz, neutral), z: PLATE_Z };
  const k = dekkaiBallScale(p);
  const diameter = 2 * BALL_RADIUS * k;
  // ワールドZへ伸ばしたとき、画面（視線に垂直）に出るのは z 軸の垂直成分ぶんだけ
  const zPerp = Math.hypot(0 - forward.z * forward.x, 0 - forward.z * forward.y, 1 - forward.z * forward.z);
  console.log(`     Z方向へ ${OLD_FAST_STRETCH_MAX}倍ぶん伸ばしても、画面に出るのは ${(zPerp * 100).toFixed(1)}%`);
  console.log(`     ＝見かけの伸び ${px(diameter * OLD_FAST_STRETCH_MAX * zPerp * ppmAt(dekkaiViewDepth(p), 720))}（720p。球の直径は ${px(diameter * ppmAt(dekkaiViewDepth(p), 720))}）。`);
}
console.log(`   新実装は**画面上の進行方向**へ、**1フレーム（${DEKKAI_TRAIL_FRAME_SEC.toFixed(4)}秒）で動く距離**ぶん伸ばす。`);
console.log(`${'球'.padEnd(14)}${row(['通過点', '画面の速さ', '1フレーム', '伸び', '長さ(720p)'], 12)}`);
for (const s of [{ name: '速球(SPD0.5)', vz: NEUTRAL + SPEED_FAST_DELTA, neutral: NEUTRAL }, { name: 'いちばん速い', vz: FASTEST, neutral: neutralSpeedFor(1) }]) {
  for (const [label, z] of [['リリース', RELEASE_Z + 0.5] as const, ['中間', (RELEASE_Z + PLATE_Z) / 2] as const, ['本塁', PLATE_Z] as const]) {
    const path = pitchArcPath(z, s.vz, FROM, pitchSlowness(s.vz, s.neutral));
    const pos = { x: 0, y: path.y, z };
    const vel = { x: 0, y: path.slope * s.vz, z: s.vz };
    const look = dekkaiBallLook(pos, vel, pitchFastness(s.vz, s.neutral));
    const axis = dekkaiScreenMotionAxis(vel);
    const screenSpeed = axis ? vel.x * axis.x + vel.y * axis.y + vel.z * axis.z : 0;
    const diameter = 2 * BALL_RADIUS * look.scale;
    const ppm = ppmAt(dekkaiViewDepth(pos), 720);
    console.log(
      `${(label === 'リリース' ? s.name : '').padEnd(14)}` +
        row(
          [
            label,
            `${screenSpeed.toFixed(2)}m/s`,
            m(screenSpeed * DEKKAI_TRAIL_FRAME_SEC),
            `${look.trail.toFixed(2)}倍`,
            `  ${px(diameter * ppm)}→${px(diameter * (1 + look.trail) * ppm)}`,
          ],
          12,
        ),
    );
  }
}
console.log('   → 近づくほど画面上の動きが速くなるので**残像も伸びる**＝NN-61 が見かけの大きさを');
console.log('     一定にして手放した「近づいてくる」手がかりが、この形で少し戻る。');
console.log('   → 残像は必ず**後ろ**へ伸ばす（先端は実際の位置）＝見た目が判定より先に行かない。');

console.log('\n=== 6. 基準線は動かない（基準速以下の球・上手以外の腕） ===');
{
  let worst = 0;
  for (const vz of [NEUTRAL, NEUTRAL + 1, NEUTRAL + SPEED_FAST_DELTA]) {
    for (let z = RELEASE_Z; z <= CATCH_Z; z += 0.01) {
      const straight = FROM + (CATCH_HEIGHT - FROM) * ((z - RELEASE_Z) / SPAN);
      worst = Math.max(worst, Math.abs(arcHeight(z, vz, NEUTRAL) - straight));
    }
  }
  console.log(`   基準速以上の球と直線との差：最大 ${m(worst)}（＝弧なし。PP-63の前と完全に同じ）`);
}
for (const slot of ['over', 'side', 'under'] as const) {
  const from = armReleaseHeight({ side: 1, slot });
  const y = pitchArcPath(PLATE_Z, SLOWEST, from, 1).y;
  console.log(
    `   ${slot.padEnd(6)} リリース ${m(from)} → 本塁 ${m(y)} → ミット ${m(pitchArcPath(CATCH_Z, SLOWEST, from, 1).y)}`,
  );
}
console.log('   （MM-60 のリリースの高さはそのまま弧の始点になる＝腕ごとの差は保たれる）');

console.log('\n=== 7. 触らないもの ===');
console.log('   判定：ストライク/ボール・死球・接触・捕球はどれも高さを引数に取らない');
console.log('         （`PitchFlight` は x と z だけ＝`npm run balance` は完全に不変）。');
console.log(`   大きさ：NN-61 の ${DEKKAI_BALL_SCALE.toFixed(2)}倍・基準点（奥行き ${m(DEKKAI_BALL_ANCHOR_DISTANCE)}）はどちらも据え置き。`);
for (const win of WINDOWS) {
  const diameter = 2 * BALL_RADIUS * DEKKAI_BALL_SCALE * ppmAt(DEKKAI_BALL_ANCHOR_DISTANCE, win.h);
  console.log(`     ${`${win.w}x${win.h}`.padEnd(10)} 直径 ${px(diameter)}（飛行中ずっと一定）`);
}
console.log('');
