/**
 * ちっちゃいモードの選手の見かけの大きさ（フェーズLL-59）の計測。
 *
 *   npm run balance:scale
 *
 * E-24（追従カメラ）以来、**作った見た目がいちばん映るはずの局面でいちばん小さい**という
 * 記録が3回続いている（E-24「原作ほどの存在感が無い」／E-25-(e)「車体も倒れた野手も
 * 数ピクセルで、何が起きたかは色と位置でしか読めない」／HH-55「送球のモーションでも同じ」）。
 * CLAUDE.md「バランス調整の方針＝勘で動かさず必ず計測してから決める」に従って、
 * **入れる前に帯を測ってから倍率を決める**。
 *
 * 決めたいのは1つ、確かめたいのは3つ：
 *
 * - 決めたい：**`CHICCHAI_PLAYER_SCALE`（ちっちゃいモードで選手を実寸の何倍で描くか）**。
 *   判定はモデルの大きさを引数に取らない（捕球半径・送球・盗塁の窓はすべてワールド座標の
 *   純粋関数）ので、**この値をいくつにしても試合の帰結は1つも動かない**＝
 *   決めるのは「読めるか」だけ。
 * - 確かめたい：(1) **カメラを寄せるてこでは届かない**こと（テストが固定している
 *   「一塁・三塁が両方入る」に触れる）、(2) **上限**＝描かれた体が捕球半径を覆い尽くすと
 *   「触れているのに捕れない」が読めなくなる、(3) **下限**＝いちばん狭い窓（800x600。
 *   FF-53がHUDの実測に使った窓）でも原作のスプライト（16px）を下回らないこと。
 *
 * 幾何は `src/core/camera.ts` の純粋関数をそのまま呼ぶ（このファイルに寄り具合の式は
 * 書かない）＝定数を動かせば計測結果も一緒に動く。
 */
import {
  CHICCHAI_FOV_DEG,
  CHICCHAI_PLAYER_SCALE,
  CHICCHAI_TILT_DEG,
  CHICCHAI_VIEW_HALF_WIDTH,
  cameraDistance,
} from '../../src/core/camera';
import { BASE_POSITIONS, CATCH_RADIUS, FIELDER_HOME_POSITIONS } from '../../src/core/fielding';

const DEG = Math.PI / 180;
const row = (cells: readonly string[], w = 14): string => cells.map((c) => c.padStart(w)).join('');
const m = (v: number): string => `${v.toFixed(2)}m`;
const px = (v: number): string => `${v.toFixed(1)}px`;

/** 選手モデルの実寸（`entities/player.ts` の作り＝全高1.8m・肩幅およそ0.5m） */
const PLAYER_HEIGHT = 1.8;

/** 原作のスプライト＝256px幅の画面に16px（＝画面幅の 1/16） */
const ORIGINAL_SPRITE_PX = 16;
const ORIGINAL_SCREEN_PX = 256;
const ORIGINAL_RATIO = ORIGINAL_SPRITE_PX / ORIGINAL_SCREEN_PX;

/** 実機で確かめる窓（FF-53がHUDの折り返しを実測したときと同じ3つ＋高解像度） */
const WINDOWS = [
  { w: 1920, h: 1080 },
  { w: 1280, h: 720 },
  { w: 960, h: 540 },
  { w: 800, h: 600 },
] as const;

/**
 * 直立した高さ h の見かけの伸び（m）。見下ろし角 θ だけ傾いたカメラから見ると、
 * 鉛直方向は視軸に対して cos θ だけしか残らない（＝真上から見ると背丈は消える）。
 */
const apparentHeight = (h: number, tiltDeg = CHICCHAI_TILT_DEG): number =>
  h * Math.cos(tiltDeg * DEG);

/**
 * 高さ h の頭が、地面のどれだけ手前（カメラ側）に重なって見えるか（m）＝**体が覆う地面**。
 * 足元は真実の位置のままなので、拡大するとこの覆いだけが伸びていく。
 */
const groundFootprint = (h: number, tiltDeg = CHICCHAI_TILT_DEG): number =>
  h / Math.tan(tiltDeg * DEG);

/** 追従点の位置での 1m あたりのピクセル数（映る横幅は寄り具合そのもの） */
const pixelsPerMeter = (screenW: number, halfWidth = CHICCHAI_VIEW_HALF_WIDTH): number =>
  screenW / (2 * halfWidth);

console.log('\n=== 1. いまの見かけの大きさ（実寸1.0倍） ===');
console.log(`   寄り具合は半幅 ${CHICCHAI_VIEW_HALF_WIDTH}m（＝横に ${2 * CHICCHAI_VIEW_HALF_WIDTH}m 映る）・`);
console.log(`   見下ろし ${CHICCHAI_TILT_DEG}° なので、直立 ${PLAYER_HEIGHT}m は`);
console.log(`   見かけ ${m(apparentHeight(PLAYER_HEIGHT))}（背丈の ${(Math.cos(CHICCHAI_TILT_DEG * DEG) * 100).toFixed(0)}% しか残らない）。`);
console.log(`${'窓'.padEnd(14)}${row(['カメラ距離', 'px/m', '選手の高さ', '画面幅比', '原作比'])}`);
for (const win of WINDOWS) {
  const aspect = win.w / win.h;
  const d = cameraDistance(CHICCHAI_FOV_DEG, aspect, CHICCHAI_VIEW_HALF_WIDTH);
  const ppm = pixelsPerMeter(win.w);
  const tall = apparentHeight(PLAYER_HEIGHT) * ppm;
  console.log(
    `${`${win.w}x${win.h}`.padEnd(14)}` +
      row([
        m(d),
        ppm.toFixed(1),
        px(tall),
        `${((tall / win.w) * 100).toFixed(2)}%`,
        `1/${(ORIGINAL_RATIO / (tall / win.w)).toFixed(1)}`,
      ]),
  );
}
console.log(`   → 原作は画面幅の ${(ORIGINAL_RATIO * 100).toFixed(2)}%（${ORIGINAL_SCREEN_PX}px に ${ORIGINAL_SPRITE_PX}px）。いまはその 1/7。`);

console.log('\n=== 2. カメラを寄せるてこでは届かない ===');
console.log('   半幅を縮めれば選手は大きくなるが、**一塁・三塁のx=±19.4mが両方入る**という');
console.log('   不変条件（tests/camera.test.ts）が下限を決める＝どこへ投げるかの判断が画面の外へ出る。');
console.log(`${'半幅'.padEnd(10)}${row(['映る横幅', '選手の高さ', '画面幅比', '内野が一かたまり'], 16)}`);
for (const hw of [34, 30, 26, 22, 20, 19.4, 16] as const) {
  const tall = apparentHeight(PLAYER_HEIGHT) * pixelsPerMeter(1280, hw);
  console.log(
    `${`${hw}m`.padEnd(10)}` +
      row([`${(hw * 2).toFixed(0)}m`, px(tall), `${((tall / 1280) * 100).toFixed(2)}%`, hw > 19.4 ? '入る' : '**割る**'], 16),
  );
}
console.log('   → 限界の半幅20mでも 19.7px＝1.7倍止まり。原作の存在感には半幅5m弱が要る（塁が映らない）。');

console.log('\n=== 3. 上限＝描かれた体が捕球半径を覆い尽くす倍率 ===');
console.log('   見下ろしているので、頭は足元から `高さ / tan(70°)` だけ手前の地面に重なって見える。');
console.log(`   これが捕球半径（${CATCH_RADIUS}m）に届くと、**触れているのに捕れない／離れて見えるのに捕れる**が読めなくなる。`);
console.log(`${'倍率'.padEnd(10)}${row(['全高', '体が覆う地面', '捕球半径比'], 16)}`);
let footprintCeiling = Infinity;
for (const s of [1, 2, 2.5, 3, 3.5, 4, 5] as const) {
  const foot = groundFootprint(PLAYER_HEIGHT * s);
  if (foot >= CATCH_RADIUS && footprintCeiling === Infinity) footprintCeiling = s;
  console.log(
    `${`${s.toFixed(1)}倍`.padEnd(10)}` +
      row([m(PLAYER_HEIGHT * s), m(foot), `${((foot / CATCH_RADIUS) * 100).toFixed(0)}%`], 16),
  );
}
const ceiling = CATCH_RADIUS / groundFootprint(PLAYER_HEIGHT);
console.log(`   → 覆いが捕球半径ちょうどになるのは **${ceiling.toFixed(2)}倍**（ここが上限）。`);

console.log('\n=== 4. 下限＝いちばん狭い窓でも原作のスプライト（16px）を下回らない ===');
console.log('   800x600 は FF-53 がHUDの折り返しを実測した窓（＝実際に遊ばれうるいちばん狭い形）。');
console.log(`${'窓'.padEnd(14)}${row(['1.0倍', '16pxに要る倍率', '20pxに要る倍率'], 18)}`);
let scaleFloor = 0;
for (const win of WINDOWS) {
  const one = apparentHeight(PLAYER_HEIGHT) * pixelsPerMeter(win.w);
  const need = ORIGINAL_SPRITE_PX / one;
  scaleFloor = Math.max(scaleFloor, need);
  console.log(
    `${`${win.w}x${win.h}`.padEnd(14)}` +
      row([px(one), `${need.toFixed(2)}倍`, `${(20 / one).toFixed(2)}倍`], 18),
  );
}
console.log(`   → いちばん狭い窓が決める下限は **${scaleFloor.toFixed(2)}倍**。`);

console.log('\n=== 5. 帯の中の候補 ===');
console.log(`   帯は **${scaleFloor.toFixed(2)}倍 〜 ${ceiling.toFixed(2)}倍**。原作の存在感（画面幅の6.25%）に`);
console.log('   いちばん近いのは上限寄り（3.0倍）だが、**帯の中のどこを採るかは実機が決める**');
console.log('   ＝テストプレイで3.0倍は大きすぎると出たので、1段下げて 2.5倍を採った（2026-08-16）。');
console.log(`${'倍率'.padEnd(8)}${row(['1920', '1280', '960', '800x600', '幅比(1280)', '覆い/捕球'], 12)}`);
for (const s of [2, 2.5, 3, 3.5, 4] as const) {
  const cells = WINDOWS.map((win) => px(apparentHeight(PLAYER_HEIGHT * s) * pixelsPerMeter(win.w)));
  const tall1280 = apparentHeight(PLAYER_HEIGHT * s) * pixelsPerMeter(1280);
  const inBand = s >= scaleFloor && s < ceiling;
  console.log(
    `${`${s.toFixed(1)}倍${inBand ? '' : '×'}`.padEnd(8)}` +
      row(
        [
          ...cells,
          `${((tall1280 / 1280) * 100).toFixed(2)}%`,
          `${((groundFootprint(PLAYER_HEIGHT * s) / CATCH_RADIUS) * 100).toFixed(0)}%`,
        ],
        12,
      ),
  );
}
console.log(`   → 採用値 **${CHICCHAI_PLAYER_SCALE.toFixed(1)}倍**（`);
console.log(`      1280x720 で ${px(apparentHeight(PLAYER_HEIGHT * CHICCHAI_PLAYER_SCALE) * pixelsPerMeter(1280))}・`);
console.log(`      800x600 でも ${px(apparentHeight(PLAYER_HEIGHT * CHICCHAI_PLAYER_SCALE) * pixelsPerMeter(800))}＝原作の16pxを上回る・`);
console.log(`      覆いは捕球半径の ${((groundFootprint(PLAYER_HEIGHT * CHICCHAI_PLAYER_SCALE) / CATCH_RADIUS) * 100).toFixed(0)}%）。`);

console.log('\n=== 6. 拡大しても重ならないもの（選手どうしの間隔） ===');
console.log('   拡大は肩幅（およそ0.5m）にも効くので、定位置の野手が団子にならないかを見る。');
const homes = Object.entries(FIELDER_HOME_POSITIONS);
let nearest = { a: '', b: '', d: Infinity };
for (let i = 0; i < homes.length; i += 1) {
  for (let j = i + 1; j < homes.length; j += 1) {
    const [an, ap] = homes[i];
    const [bn, bp] = homes[j];
    const d = Math.hypot(ap.x - bp.x, ap.z - bp.z);
    if (d < nearest.d) nearest = { a: an, b: bn, d };
  }
}
console.log(`   定位置でいちばん近い2人：${nearest.a}–${nearest.b} = ${m(nearest.d)}`);
console.log(`   採用値での肩幅：${m(0.5 * CHICCHAI_PLAYER_SCALE)}（間隔の ${((0.5 * CHICCHAI_PLAYER_SCALE) / nearest.d * 100).toFixed(1)}%）＝団子にならない。`);
const baseGap = Math.hypot(
  BASE_POSITIONS.first.x - BASE_POSITIONS.second.x,
  BASE_POSITIONS.first.z - BASE_POSITIONS.second.z,
);
console.log(`   塁間 ${m(baseGap)} に対しては ${((0.5 * CHICCHAI_PLAYER_SCALE) / baseGap * 100).toFixed(1)}%＝塁上の走者と塁カバーが`);
console.log('   別々に見える（もともと同じ点に立つ場面は拡大の前から重なっている）。');

console.log('\n=== 7. 触らないもの ===');
console.log(`   映る範囲：半幅 ${CHICCHAI_VIEW_HALF_WIDTH}m のまま（＝送球先の塁が見える条件は不変）。`);
console.log(`   見下ろし角：${CHICCHAI_TILT_DEG}° のまま（＝塁の位置関係の読みやすさは不変）。`);
console.log('   判定：捕球半径・送球・盗塁の窓はモデルの大きさを引数に取らない（ワールド座標の純粋関数）。');
console.log('   でっかいモード・乱闘：元から寄っているので実寸のまま（下は概算）。');
{
  // でっかいモードは (0,4.5,10.2) から (0,1.5,-18.44) を見る画角40°。
  const camZ = 2.2 + 8;
  const toPitcher = Math.hypot(camZ - -18.44, 4.5 - 1.5);
  const toBatter = Math.hypot(camZ - 0, 4.5 - 1.5);
  const ppmAt = (d: number) => 720 / (2 * d * Math.tan(20 * DEG));
  console.log(`     でっかいモードの投手 ≒ ${px(PLAYER_HEIGHT * ppmAt(toPitcher))}／打者 ≒ ${px(PLAYER_HEIGHT * ppmAt(toBatter))}（720p）`);
  console.log(`     ちっちゃいモードは拡大後で ${px(apparentHeight(PLAYER_HEIGHT * CHICCHAI_PLAYER_SCALE) * pixelsPerMeter(1280))}＝まだいちばん小さい。`);
}
console.log('');
