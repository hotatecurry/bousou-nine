/**
 * ボールの見かけの大きさ（フェーズNN-61）の計測。
 *
 *   npm run balance:ball
 *
 * LL-59（ちっちゃいモードの選手の縮尺）と同じ**判定を1つも測らない計測**＝決めるのは
 * 「読めるか」だけ。ボールの大きさは捕球半径・送球・盗塁の窓のどれにも引数として
 * 渡らない（すべてワールド座標の純粋関数）ので、いくつにしても試合の帰結は動かない。
 *
 * 決めたいのは2つ、確かめたいのは3つ：
 *
 * - 決めたい：**でっかいモードの基準点**（＝画面上の大きさを一定に保つときの分母。
 *   ユーザー判断で「実寸」「距離補正して一定」の2つが決まっているので、残るのは
 *   「どの距離で実寸に見せるか」1つ）と、**ちっちゃいモードの倍率**。
 * - 確かめたい：(1) いまの球が**何を隠しているか**（MM-60のリリースの高さの差・
 *   ストライクゾーン・O-36の立ち位置の可動幅）、(2) **上限**＝見かけを大きくするほど
 *   MM-60の段差が球に隠れる、(3) **下限**＝いちばん狭い窓（800x600）で何pxになるか。
 *
 * 幾何は `src/core/camera.ts` と `src/core/pitch.ts` の値をそのまま読む（このファイルに
 * カメラの置き場所や球の大きさを書かない）＝定数を動かせば計測結果も一緒に動く。
 */
import {
  BALL_RADIUS,
  CHICCHAI_BALL_SCALE,
  CHICCHAI_FOV_DEG,
  CHICCHAI_PLAYER_SCALE,
  CHICCHAI_TILT_DEG,
  CHICCHAI_VIEW_HALF_WIDTH,
  DEKKAI_BALL_ANCHOR,
  DEKKAI_BALL_ANCHOR_DISTANCE,
  DEKKAI_BALL_SCALE,
  DEKKAI_FOV_DEG,
  dekkaiBallScale,
  dekkaiViewDepth,
} from '../../src/core/camera';
import {
  ARM_RELEASE_LEAN_RAD,
  BATTER_STANCE_RANGE,
  CATCH_HEIGHT,
  CATCH_Z,
  PLATE_Z,
  RELEASE_Z,
  STRIKE_ZONE_HALF_WIDTH,
  armReleaseHeight,
} from '../../src/core/pitch';

const DEG = Math.PI / 180;
const row = (cells: readonly string[], w = 13): string => cells.map((c) => c.padStart(w)).join('');
const m = (v: number): string => `${v.toFixed(3)}m`;
const px = (v: number): string => `${v.toFixed(1)}px`;

/** 実機で確かめる窓（LL-59・FF-53 と同じ4つ） */
const WINDOWS = [
  { w: 1920, h: 1080 },
  { w: 1280, h: 720 },
  { w: 960, h: 540 },
  { w: 800, h: 600 },
] as const;

/** 従来の描き方（NN-61の前）：半径0.4mのジオメトリ × ちっちゃいでは1.5倍 */
const OLD_GEOMETRY_RADIUS = 0.4;
const OLD_CHICCHAI_SCALE = 1.5;

/**
 * 原作（ファミコン）のスプライトは 8x8px。ボールはその1枚に収まるので、
 * **どんなに大きくても 256px 幅の画面の 3.1%** が上限になる（LL-59が選手に使った
 * 「256pxに16px」と同じ出どころの、球の側の目安）。
 */
const ORIGINAL_BALL_PX = 8;
const ORIGINAL_SCREEN_PX = 256;

/**
 * 実際の野球の本塁ベースの幅 m（17インチ）。`DEKKAI_BALL_SCALE` の出どころ
 * （＝このゲームのゾーン 0.9m は実物の何倍か）を、ここでも読める形で持つ。
 */
const REAL_PLATE_WIDTH = 0.4318;

/**
 * カメラから見た奥行き（`dekkaiViewDepth`）。**直線距離ではない**＝遠近投影で画面上の
 * 大きさを決めるのはこちら（実機で確かめた。`core/camera.ts` のコメント参照）。
 */
const dist = (p: { x: number; y: number; z: number }): number => dekkaiViewDepth(p);

/** 奥行き d にある長さ 1m が画面で何pxになるか（垂直画角から） */
const ppmAt = (d: number, screenH: number, fovDeg = DEKKAI_FOV_DEG): number =>
  screenH / (2 * d * Math.tan((fovDeg / 2) * DEG));

/** ちっちゃいモードは寄り具合そのものが px/m を決める（カメラ距離によらない） */
const chicchaiPpm = (screenW: number): number => screenW / (2 * CHICCHAI_VIEW_HALF_WIDTH);

/** 球の通り道の代表点（上手投げの投手。高さは MM-60 の導出をそのまま使う） */
const overArm = { side: 1 as const, slot: 'over' as const };
const RELEASE_POINT = { x: 0, y: armReleaseHeight(overArm), z: RELEASE_Z };
const PLATE_POINT = { x: 0, y: CATCH_HEIGHT, z: PLATE_Z };
const MITT_POINT = { x: 0, y: CATCH_HEIGHT, z: CATCH_Z };
const PATH = [
  { name: 'リリース', p: RELEASE_POINT },
  { name: '中間', p: { x: 0, y: 1.2, z: (RELEASE_Z + CATCH_Z) / 2 } },
  { name: '本塁', p: PLATE_POINT },
  { name: 'ミット', p: MITT_POINT },
] as const;

/** MM-60 の隣り合う投げ方の段差（＝球に隠れてはいけない差） */
const LEAN_STEPS = (() => {
  const heights = (['over', 'side', 'under'] as const).map((slot) => ({
    slot,
    y: armReleaseHeight({ side: 1, slot }),
  }));
  const steps: { label: string; d: number }[] = [];
  for (let i = 0; i + 1 < heights.length; i += 1) {
    steps.push({
      label: `${heights[i].slot}–${heights[i + 1].slot}`,
      d: Math.abs(heights[i].y - heights[i + 1].y),
    });
  }
  return steps;
})();
const SMALLEST_STEP = Math.min(...LEAN_STEPS.map((s) => s.d));

console.log('\n=== 1. いまの球はどれだけ大きいか（でっかいモード・従来＝半径0.4m） ===');
console.log(`   実寸は半径 ${m(BALL_RADIUS)}（直径 ${(BALL_RADIUS * 200).toFixed(1)}cm）なので、従来の描き方は **実寸の ${(OLD_GEOMETRY_RADIUS / BALL_RADIUS).toFixed(1)}倍**。`);
console.log(`${'通過点'.padEnd(10)}${row(['奥行き', '従来(720p)', '実寸(720p)', '実寸/従来'])}`);
for (const { name, p } of PATH) {
  const d = dist(p);
  const old = 2 * OLD_GEOMETRY_RADIUS * ppmAt(d, 720);
  const real = 2 * BALL_RADIUS * ppmAt(d, 720);
  console.log(`${name.padEnd(10)}${row([m(d), px(old), px(real), `${((real / old) * 100).toFixed(1)}%`])}`);
}

console.log('\n=== 2. 従来の球が隠していたもの ===');
console.log('   「球1個ぶん」より小さい差は、画面では球に埋もれて読めない。');
console.log(`${'読みたい差'.padEnd(26)}${row(['大きさ', '従来の球比', '実寸の球比'], 14)}`);
const READABLES: readonly { label: string; d: number }[] = [
  ...LEAN_STEPS.map((s) => ({ label: `MM-60 リリースの段差 ${s.label}`, d: s.d })),
  { label: 'ストライクゾーンの幅', d: 2 * STRIKE_ZONE_HALF_WIDTH },
  { label: 'O-36 立ち位置の可動幅', d: 2 * BATTER_STANCE_RANGE },
];
for (const r of READABLES) {
  console.log(
    `${r.label.padEnd(26)}` +
      row(
        [
          m(r.d),
          `${(r.d / (2 * OLD_GEOMETRY_RADIUS)).toFixed(2)}個`,
          `${(r.d / (2 * BALL_RADIUS)).toFixed(2)}個`,
        ],
        14,
      ),
  );
}
console.log(`   → 従来はMM-60の段差が **球 ${(SMALLEST_STEP / (2 * OLD_GEOMETRY_RADIUS)).toFixed(2)}個ぶん**＝完全に球の中に隠れていた。`);

console.log('\n=== 3. 実寸のままでは追えない（＝距離補正が要る理由） ===');
console.log('   でっかいモードはカメラからの距離がリリースと本塁で2.6倍違うので、素の3Dだと');
console.log('   **いちばん見たいリリースの瞬間がいちばん小さい**（LL-59とまったく同じ形の問題）。');
console.log(`${'窓'.padEnd(12)}${row(['リリース', '本塁', 'ミット', '育つ倍率'])}`);
for (const win of WINDOWS) {
  const at = (p: { x: number; y: number; z: number }) => 2 * BALL_RADIUS * ppmAt(dist(p), win.h);
  console.log(
    `${`${win.w}x${win.h}`.padEnd(12)}` +
      row([
        px(at(RELEASE_POINT)),
        px(at(PLATE_POINT)),
        px(at(MITT_POINT)),
        `${(at(MITT_POINT) / at(RELEASE_POINT)).toFixed(2)}倍`,
      ]),
  );
}

console.log('\n=== 4. 上限＝どこまで大きくできるか（MM-60の段差が球に埋もれない） ===');
console.log('   距離補正で見かけを一定にすると、球の大きさは「基準点までの距離 × 倍率」で決まる。');
console.log(`   大きくするほど**リリース地点での段差（${m(SMALLEST_STEP)}）**を覆い隠す。`);
const releaseDist = dist(RELEASE_POINT);
const stepPxAt720 = SMALLEST_STEP * ppmAt(releaseDist, 720);
const anchorFloor = (releaseDist * 2 * BALL_RADIUS) / SMALLEST_STEP;
console.log(`${'基準点の候補'.padEnd(16)}${row(['奥行き', '素の一定px', '段差/球', '可否'])}`);
for (const { name, p } of PATH) {
  const a = dist(p);
  const constPx = 2 * BALL_RADIUS * ppmAt(a, 720);
  const ratio = stepPxAt720 / constPx;
  console.log(
    `${name.padEnd(16)}` +
      row([m(a), px(constPx), `${ratio.toFixed(2)}個`, ratio > 1 ? '○' : '×(隠れる)']),
  );
}
console.log(`   リリース地点での段差は ${px(stepPxAt720)}（720p）。`);
console.log(`   → 基準点は **${m(anchorFloor)} より遠い**必要がある＝**ミット基準は不可・本塁が限度**。`);
const stepRatioAt1x = stepPxAt720 / (2 * BALL_RADIUS * ppmAt(DEKKAI_BALL_ANCHOR_DISTANCE, 720));
console.log(`   本塁を基準にしたまま倍率で大きくする場合の上限（基準点は動かさない）：`);
console.log(`     段差が球1個ぶん  → ${stepRatioAt1x.toFixed(2)}倍まで（NN-61の当初の条件）`);
console.log(`     段差が球の半分   → ${(stepRatioAt1x * 2).toFixed(2)}倍まで（中心の高さの違いは読める）`);
console.log(`   MM-60自身の読み取り条件（いちばん低い解像度で5px以上離れる）は球の大きさに依らない：`);
console.log(`     800x600 での段差 ${px(SMALLEST_STEP * ppmAt(releaseDist, 600))}＝倍率をいくつにしても不変。`);

console.log('\n=== 5. 採用（本塁基準 × ゾーンと同じ倍率）の帰結 ===');
console.log(`   基準点 = 本塁上のミットの高さ（z=${DEKKAI_BALL_ANCHOR.z}, y=${DEKKAI_BALL_ANCHOR.y}）＝奥行き ${m(DEKKAI_BALL_ANCHOR_DISTANCE)}。`);
console.log(`   倍率 = **${DEKKAI_BALL_SCALE.toFixed(2)}倍**（＝ゾーン幅 ${m(2 * STRIKE_ZONE_HALF_WIDTH)} ÷ 実際の本塁ベース ${m(REAL_PLATE_WIDTH)}）`);
console.log(`   ＝**ゾーンが実物より広いのと同じ倍率**なので、ゾーン幅に対する球の比は実際の野球と同じ`);
console.log(`     （実物 ${((2 * BALL_RADIUS) / REAL_PLATE_WIDTH * 100).toFixed(1)}% ／ このゲーム ${((2 * BALL_RADIUS * DEKKAI_BALL_SCALE) / (2 * STRIKE_ZONE_HALF_WIDTH) * 100).toFixed(1)}%）。`);
console.log(`   **画面上の直径は飛行中ずっと一定**（下の各窓の値）。リリースでは実寸の ${dekkaiBallScale(RELEASE_POINT).toFixed(2)}倍に描いて見かけを保つ。`);
console.log(`${'窓'.padEnd(12)}${row(['一定の直径', '実寸1.0倍', '従来の本塁', 'ゾーン幅比', '原作比'], 11)}`);
for (const win of WINDOWS) {
  const constPx = 2 * BALL_RADIUS * DEKKAI_BALL_SCALE * ppmAt(DEKKAI_BALL_ANCHOR_DISTANCE, win.h);
  const rawPx = 2 * BALL_RADIUS * ppmAt(DEKKAI_BALL_ANCHOR_DISTANCE, win.h);
  const oldAtPlate = 2 * OLD_GEOMETRY_RADIUS * ppmAt(dist(PLATE_POINT), win.h);
  const zonePx = 2 * STRIKE_ZONE_HALF_WIDTH * ppmAt(dist(PLATE_POINT), win.h);
  const originalPx = (ORIGINAL_BALL_PX / ORIGINAL_SCREEN_PX) * win.w;
  console.log(
    `${`${win.w}x${win.h}`.padEnd(12)}` +
      row(
        [
          px(constPx),
          px(rawPx),
          px(oldAtPlate),
          `${((constPx / zonePx) * 100).toFixed(1)}%`,
          `1/${(originalPx / constPx).toFixed(1)}`,
        ],
        11,
      ),
  );
}
console.log('   飛行中ずっと同じ大きさであることの確認（720p。補正込み）：');
for (const { name, p } of PATH) {
  const k = dekkaiBallScale(p);
  console.log(`     ${name.padEnd(8)} 拡大 ${k.toFixed(3)}倍 → 直径 ${px(2 * BALL_RADIUS * k * ppmAt(dist(p), 720))}`);
}
console.log(`   段差/球 = ${(stepRatioAt1x / DEKKAI_BALL_SCALE).toFixed(2)}個ぶん（上限の「半分」の内側）。`);
console.log('   → さらに大きくするなら倍率だけを上げる（上の上限まで）。基準点は動かさない。');

console.log('\n=== 6. ちっちゃいモードは倍率のまま（実寸では追えない） ===');
console.log(`   鳥瞰なのでカメラからの距離はほぼ一定＝**距離補正のてこが無い**（px/m は寄り具合だけで決まる）。`);
const playerPx = (screenW: number): number =>
  1.8 * CHICCHAI_PLAYER_SCALE * Math.cos(CHICCHAI_TILT_DEG * DEG) * chicchaiPpm(screenW);
console.log(
  `${'窓'.padEnd(12)}${row([
    '実寸の球',
    `採用(${CHICCHAI_BALL_SCALE}倍)`,
    '従来(0.4x1.5)',
    `選手(${CHICCHAI_PLAYER_SCALE}倍)`,
  ])}`,
);
for (const win of WINDOWS) {
  const ppm = chicchaiPpm(win.w);
  console.log(
    `${`${win.w}x${win.h}`.padEnd(12)}` +
      row([
        px(2 * BALL_RADIUS * ppm),
        px(2 * BALL_RADIUS * CHICCHAI_BALL_SCALE * ppm),
        px(2 * OLD_GEOMETRY_RADIUS * OLD_CHICCHAI_SCALE * ppm),
        px(playerPx(win.w)),
      ]),
  );
}
const drawn = BALL_RADIUS * CHICCHAI_BALL_SCALE;
const old = OLD_GEOMETRY_RADIUS * OLD_CHICCHAI_SCALE;
console.log(`   採用の描画半径 ${m(drawn)} vs 従来 ${m(old)}＝差 ${(Math.abs(drawn - old) * 1000).toFixed(1)}mm（1280x720 で ${px(Math.abs(drawn - old) * 2 * chicchaiPpm(1280))}）＝**見かけは不変**。`);
console.log(`   球/選手の比は ${((2 * drawn * chicchaiPpm(1280)) / playerPx(1280)).toFixed(2)}（球は据え置きなので、選手の縮尺を下げたぶんだけ上がる。1未満＝選手より小さい）。`);

console.log('\n=== 7. 触らないもの ===');
console.log('   判定：ストライク/ボール・捕球半径・送球・盗塁の窓は球の描画サイズを引数に取らない');
console.log('         （`npm run balance` は完全に不変）。');
console.log(`   カメラ：でっかい ${DEKKAI_FOV_DEG}°・ちっちゃい ${CHICCHAI_FOV_DEG}°／半幅 ${CHICCHAI_VIEW_HALF_WIDTH}m／見下ろし ${CHICCHAI_TILT_DEG}° はすべて据え置き。`);
console.log(`   MM-60：リリースの高さ（上手 ${m(armReleaseHeight({ side: 1, slot: 'over' }))}／横手 ${m(armReleaseHeight({ side: 1, slot: 'side' }))}／下手 ${m(armReleaseHeight({ side: 1, slot: 'under' }))}）と`);
console.log(`         上体の傾き（横手 ${ARM_RELEASE_LEAN_RAD.side} / 下手 ${ARM_RELEASE_LEAN_RAD.under} rad）は1つも動かない。`);
console.log('');
