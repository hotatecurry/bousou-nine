/**
 * **CPU投手の内外角と、立ち位置という手がかり（フェーズBBB-84）**＝`npm run balance:tell`
 *
 * 部品（打席の回し方・打者の打ち方）は `tell.ts`。ここはその出力。
 *
 * 段の並びは、このフェーズが形を決めた順：
 * 1. BBB-83 までの規則（読みが外れない＋寄っている打者に当てる）
 * 2. 最初に入れた形（内外角を引き、どちらの側に立っても逆を突く）＝**読まずに寄るほうが強い**
 * 3. 死球のもらい得を消す（当てない／投げた後に踏み込んだ球は死球にしない）
 * 4. 逆を突く向きと割合（外角側に立ったときだけ内角へ）＝**読まずに寄る打者が、立ち位置を
 *    信じる打者を上回らなくなる**
 * 5〜8. 球の形・見分け・CPU同士の水準・球速も読む打者
 */
import { pitchArmOf } from '../../src/core/roster';
import {
  type PitchFlight,
  BATTER_STANCE_MOVE_SPEED,
  BATTER_STANCE_RANGE,
  COURSE_RELEASE_VX,
  LEFT_BATTER_SIDE,
  NEUTRAL_PITCH_PROFILE,
  NEUTRAL_RATING,
  PLATE_Z,
  RIGHT_BATTER_SIDE,
  STRIKE_ZONE_HALF_WIDTH,
  batterFrameX,
  clampStance,
  flightSecondsUntil,
  judgePitch,
  neutralSpeedFor,
  releasePitchFlight,
} from '../../src/core/pitch';
import { CONTACT_PLANE_Z, SWING_IDEAL_SEC } from '../../src/core/batting';
import { CPU_SWING_SIGMA_SEC } from '../../src/core/cpuBatter';
import {
  type CpuPitchShape,
  type CpuSpeedMode,
  CPU_CROSS_CHANCE,
  NORMAL_TARGET_X,
  avoidCrowdingBatter,
  planCpuPitchShape,
} from '../../src/core/cpuPitcher';
import { BALL_RADIUS, DEKKAI_BALL_SCALE, dekkaiFovFor, dekkaiPitchLook, dekkaiViewDepth } from '../../src/core/camera';
import { type AtBatOptions, controlOf, pitchProfileOf, planCpuPitch, shapeCpuPitch } from './atbat';
import {
  type League,
  COUNTS,
  CROWD,
  FIRST_CUT,
  HEAD,
  HITS_CROWDERS,
  HUMAN_REACTION_SEC,
  REPS,
  STAFF,
  center,
  crossXOf,
  crowd,
  crowdOnOutsideTell,
  f2,
  flightAfter,
  halfCrowd,
  insideBallComing,
  leanTruth,
  league,
  line,
  pct,
  row,
  standOff,
  stepIntoInsideBall,
  stepIntoInsideBallLate,
  trustTell,
  trustThenReact,
} from './tell';

/** 打者の打ち方（`league` へ渡す引数） */
interface Way {
  label: string;
  opts: AtBatOptions;
}

/** 同じ規則×同じ打ち方は一度だけ回す */
const memo = new Map<string, League>();
function run(rule: string, ruleOpts: AtBatOptions, way: Way, chance: number | null = CPU_CROSS_CHANCE): League {
  const key = `${rule}|${chance}|${way.label}`;
  let hit = memo.get(key);
  if (!hit) {
    hit = league({ ...way.opts, ...ruleOpts }, chance);
    memo.set(key, hit);
  }
  return hit;
}

function main(): void {
  console.log('CPU投手の内外角と、立ち位置という手がかり（フェーズBBB-84）');
  console.log(
    `土台：tools/balance/atbat.ts／先発16人×打線9人×${REPS}回／球場＝ところざわ／タイミングはCPU打者と同じ（σ${(CPU_SWING_SIGMA_SEC * 1000).toFixed(0)}ms）`,
  );
  console.log('得点は四球・死球を押し出しの進塁として数えた打線の得点期待。');

  // ============================================================
  // 球の形と見分けを先に解く（「見てから戻る」打者が、見分けの付くフレームを使う）
  // ============================================================

  const shapeLines: string[] = [];
  {
    const vx: Record<CpuSpeedMode, number[]> = { fast: [], neutral: [], slow: [] };
    let sided = 0;
    let outsideStands = 0;
    let crosses = 0;
    let worstMiss = 0;
    let worstStance = 0;
    let worstHonestMiss = 0;
    let hitsLeaner = 0;
    let avoided = 0;
    let avoidStance = 0;
    let avoidMiss = 0;
    let stillHits = 0;
    const crossers = new Set<number>();
    const wild = new Set<number>();
    STAFF.forEach((stats, who) => {
      const profile = pitchProfileOf(stats);
      const control = controlOf(stats);
      const arm = pitchArmOf(stats.throws);
      for (const count of COUNTS) {
        for (const side of [1, -1] as const) {
          for (const batterSide of [RIGHT_BATTER_SIDE, LEFT_BATTER_SIDE]) {
            const honest = planCpuPitch(profile, control, arm, count, {
              sides: { side, cross: false },
              batterSide,
            });
            if (honest.plan.targetX === 0) continue;
            sided += 1;
            worstHonestMiss = Math.max(
              worstHonestMiss,
              Math.abs(crossXOf(honest.shape, honest.flight) - honest.plan.targetX),
            );
            // 寄り切った打者に当たる球は、リリースの瞬間に反対側へ投げ直す
            const answer = avoidCrowdingBatter(honest.plan, batterSide, CROWD);
            if (answer !== honest.plan) {
              avoided += 1;
              const again = shapeCpuPitch(answer, profile, arm);
              avoidStance = Math.max(avoidStance, Math.abs(again.shape.plateX - honest.shape.plateX));
              avoidMiss = Math.max(avoidMiss, Math.abs(crossXOf(again.shape, again.flight) - answer.targetX));
            } else if (judgePitch(honest.plan.targetX, batterSide, CROWD) === 'hitByPitch') {
              // 打席の中央でも当たる球＝荒れ球はそのまま（T-41）
              stillHits += 1;
              wild.add(who);
            }
            if (batterFrameX(side, batterSide) < 0) outsideStands += 1;
            const cross = planCpuPitch(profile, control, arm, count, {
              sides: { side, cross: true },
              batterSide,
            });
            if (!cross.plan.cross) continue;
            crosses += 1;
            crossers.add(who);
            // 逆を突く球の立ち位置＝立っている側の隅へ、立ち位置どおりに投げるときの立ち位置
            worstStance = Math.max(worstStance, Math.abs(cross.shape.plateX - honest.shape.plateX));
            worstMiss = Math.max(worstMiss, Math.abs(crossXOf(cross.shape, cross.flight) - cross.plan.targetX));
            vx[cross.plan.speed].push(Math.abs(cross.shape.releaseVx));
            // 立ち位置（外角）を信じてプレートへ寄り切った打者に、内角へ来たこの球は当たるか
            if (judgePitch(cross.plan.targetX, batterSide, CROWD) === 'hitByPitch') hitsLeaner += 1;
          }
        }
      }
    });
    shapeLines.push(
      `   側を持つ球 ${sided} 通り（立つ側×打席の左右）。外角側に立つのは ${outsideStands} 通りで、そのうち逆を突けるのは ${crosses} 通り`,
    );
    shapeLines.push(
      `   （${pct(crosses / outsideStands)}＝内角のストライクへ投げられる球だけ）・逆を突ける投手 ${crossers.size}/${STAFF.length}人。`,
    );
    shapeLines.push(
      `   ・立ち位置のずれ（立っている側の隅へ、立ち位置どおりに投げるときとの差）：最大 ${worstStance.toFixed(4)}m ＝**投げる前には見分けが付かない**`,
    );
    shapeLines.push(
      `   ・本塁を通る場所の誤差：逆を突く球 最大 ${worstMiss.toFixed(4)}m／立ち位置どおりの球 最大 ${worstHonestMiss.toFixed(4)}m ＝狙いどおり届く`,
    );
    shapeLines.push(
      `   ・外角を信じて寄り切った打者に当たる「逆を突く球」：${hitsLeaner} 通り ＝**逆を突かれて当たることは無い**`,
    );
    shapeLines.push(
      `   ・寄り切った打者に当たる球（内角のボール球）：${avoided + stillHits} 通り。うち ${avoided} 通りは**リリースの瞬間に反対側へ投げ直す**`,
    );
    shapeLines.push(
      `     （立ち位置のずれ 最大 ${avoidStance.toFixed(4)}m・届く場所の誤差 最大 ${avoidMiss.toFixed(4)}m）。残る ${stillHits} 通りは**打席の中央でも当たる球**`,
    );
    shapeLines.push(`     ＝荒れた投手 ${wild.size}/${STAFF.length}人の球だけ（T-41。避ける手は「離れて立つ」）。`);
    shapeLines.push(`${'球種'.padEnd(12)}${row(['通り', '横速度 最小', '中央', '最大', '人間の入力比'], 12)}`);
    for (const [mode, label] of [
      ['fast', '速球'],
      ['neutral', '基準速'],
      ['slow', 'フォーク'],
    ] as const) {
      const v = [...vx[mode]].sort((a, b) => a - b);
      if (v.length === 0) continue;
      const mid = v[Math.floor(v.length / 2)];
      shapeLines.push(
        `${label.padEnd(12)}${row(
          [
            String(v.length),
            `${v[0].toFixed(2)}m/s`,
            `${mid.toFixed(2)}m/s`,
            `${v[v.length - 1].toFixed(2)}m/s`,
            `${(mid / COURSE_RELEASE_VX).toFixed(2)}倍`,
          ],
          12,
        )}`,
      );
    }
  }

  const seeLines: string[] = [];
  let framesToSee = 5;
  {
    const W = 1280;
    const H = 720;
    const fov = dekkaiFovFor(W / H);
    const ppm = (depth: number): number => H / (2 * depth * Math.tan((fov / 2) * (Math.PI / 180)));
    const ballPx = 2 * BALL_RADIUS * DEKKAI_BALL_SCALE * ppm(dekkaiViewDepth({ x: 0, y: 1, z: PLATE_Z }));
    seeLines.push(`   球の見かけの直径 ${ballPx.toFixed(1)}px。差が直径を越えれば、斜めの球筋としてはっきり読める。`);
    seeLines.push(
      `${'球種'.padEnd(12)}${row(['打撃面まで', '差:3f後', '6f後', '9f後', '直径を越える', '動ける時間', '戻れる幅'], 12)}`,
    );
    const seen: number[] = [];
    for (const [mode, label] of [
      ['fast', '速球'],
      ['neutral', '基準速'],
      ['slow', 'フォーク'],
    ] as const) {
      // 基準値の投手。同じ立ち位置から出る2球＝立ち位置どおり（立っている側の隅へ）と、逆を突く球（反対の隅へ）
      const start = (shape: CpuPitchShape): PitchFlight =>
        releasePitchFlight(shape.releaseX, shape.speed, shape.releaseVx, neutralSpeedFor(NEUTRAL_RATING), NEUTRAL_RATING);
      const honest = planCpuPitchShape({ targetX: NORMAL_TARGET_X, speed: mode }, NEUTRAL_PITCH_PROFILE);
      const cross = planCpuPitchShape({ targetX: -NORMAL_TARGET_X, speed: mode, cross: true }, NEUTRAL_PITCH_PROFILE);
      const toContact = flightSecondsUntil(start(honest), CONTACT_PLANE_Z);
      const px = (shape: CpuPitchShape, frames: number): number => {
        const c = dekkaiPitchLook(flightAfter(shape, start(shape), frames)).center;
        return c.x * ppm(dekkaiViewDepth(c));
      };
      const diff = (frames: number): number => Math.abs(px(honest, frames) - px(cross, frames));
      let frames = 0;
      while (frames < 60 && diff(frames) < ballPx) frames += 1;
      seen.push(frames);
      const avail = Math.max(0, toContact - SWING_IDEAL_SEC - HUMAN_REACTION_SEC - frames / 60);
      seeLines.push(
        `${label.padEnd(12)}${row(
          [
            `${(toContact * 60).toFixed(1)}f`,
            `${diff(3).toFixed(1)}px`,
            `${diff(6).toFixed(1)}px`,
            `${diff(9).toFixed(1)}px`,
            `${frames}f後`,
            `${avail.toFixed(2)}秒`,
            `${Math.min(2 * BATTER_STANCE_RANGE, BATTER_STANCE_MOVE_SPEED * avail).toFixed(2)}m`,
          ],
          12,
        )}`,
      );
    }
    framesToSee = Math.max(...seen);
  }
  const seeAndReact = HUMAN_REACTION_SEC + framesToSee / 60;

  // ---- 打者の打ち方 ----
  const WAY = {
    center: { label: '中央のまま', opts: { stanceFor: center } },
    trust: { label: '立ち位置を信じる（外角なら寄る／内角なら離れる）', opts: { stanceFor: trustTell } },
    react: {
      label: `　＋逆を突かれたら見てから戻る（${seeAndReact.toFixed(2)}秒後）`,
      opts: { stanceFor: trustThenReact(seeAndReact) },
    },
    outIn: { label: '外角と示されたら寄る／内角なら中央', opts: { stanceFor: crowdOnOutsideTell } },
    crowd: { label: 'いつもプレートへ寄り切る（読まない）', opts: { stanceFor: crowd } },
    half: { label: 'いつも半分だけ寄る', opts: { stanceFor: halfCrowd } },
    off: { label: 'いつも離れて立つ', opts: { stanceFor: standOff } },
    stepPre: { label: '信じる＋内角のボール球へ投げる前に踏み込む', opts: { stanceFor: stepIntoInsideBall } },
    stepLate: {
      label: '信じる＋内角のボール球へ投げた後に踏み込む',
      opts: { stanceAtReleaseFor: trustTell, stanceFor: stepIntoInsideBallLate },
    },
    cpu: { label: 'CPU打者の規則（直前のストライクへ）', opts: {} },
  } satisfies Record<string, Way>;

  // ============================================================
  // 1. BBB-83 までの規則：読みが外れない＋寄っている打者に当てる
  // ============================================================

  console.log('\n=== 1. BBB-83 までの規則（内外角＝ボール数＋ファウル数の偶奇・必ず立ち位置どおり・寄っている打者にも当てる） ===');
  console.log(`${'打者の打ち方'.padEnd(34)}${HEAD}`);
  const before = {
    cpu: run('old', HITS_CROWDERS, WAY.cpu, null),
    center: run('old', HITS_CROWDERS, WAY.center, null),
    right: run('old', HITS_CROWDERS, { label: '来る側へ寄り切る（読みは外れない）', opts: { stanceFor: leanTruth(1) } }, null),
    step: run(
      'old',
      HITS_CROWDERS,
      {
        label: '来る側へ寄る＋内角のボール球へ踏み込む',
        opts: { stanceFor: (_l, p) => (insideBallComing(p) ? CROWD : clampStance(p)) },
      },
      null,
    ),
    crowd: run('old', HITS_CROWDERS, WAY.crowd, null),
    wrong: run('old', HITS_CROWDERS, { label: '（参考）必ず逆へ寄り切る', opts: { stanceFor: leanTruth(-1) } }, null),
  };
  console.log(line('CPU打者の規則（直前のストライクへ）', before.cpu));
  console.log(line('中央のまま', before.center));
  console.log(line('来る側へ寄り切る（読みは外れない）', before.right));
  console.log(line('来る側へ寄る＋内角のボール球へ踏み込む', before.step));
  console.log(line('いつもプレートへ寄り切る（読まない）', before.crowd));
  console.log(line('（参考）必ず逆へ寄り切る', before.wrong));
  console.log('   ＝穴は2つあった。**①内外角が投げる前に分かる**（読んで寄れば外れない）。');
  console.log('     **②寄っている打者に、内角のボール球をそのまま当てる**（O-36：寄ると内角のボール球が死球になる）＝');
  console.log('     外す球はカウントと制球から来ると分かるので、踏み込めば一塁をもらえた。');

  // ============================================================
  // 2. 最初に入れた形：内外角を引き、どちらの側に立っても逆を突く
  // ============================================================

  console.log(
    `\n=== 2. 最初に入れた形（内外角を引く・どちらの側に立っても ${f2(CPU_CROSS_CHANCE)} で逆を突く・寄っている打者にも当てる） ===`,
  );
  console.log(`${'打者の打ち方'.padEnd(34)}${HEAD}`);
  for (const way of [WAY.center, WAY.trust, WAY.outIn, WAY.crowd, WAY.half, WAY.off, WAY.stepPre, WAY.stepLate, WAY.cpu]) {
    console.log(line(way.label, run('first', FIRST_CUT, way)));
  }
  console.log('   ＝①は塞がった（立ち位置を信じても3回に1回は外れる）が、**読まずに寄り切るほうがはるかに強い**。');
  console.log('     理由は2つ：死球のもらい得（②）がそのまま残っていた／外角を芯で捉えると長打・内角を芯で捉えても単打');
  console.log('     （打ち上げ角＝21°−コース×30°）なので、**内角と読めて離れる値打ちが小さい**＝読みが外れても損をしない。');

  // ============================================================
  // 3. 死球のもらい得を消す
  // ============================================================

  console.log('\n=== 3. 死球のもらい得を消す（逆を突く向きは最初の形のまま。得点/試合・死球/打席） ===');
  {
    const bothWays: AtBatOptions['aims'] = { crossBothWays: true };
    const rules: Array<[string, string, AtBatOptions]> = [
      ['first', '何もしない（最初の形）', FIRST_CUT],
      ['A', 'CPU投手が、踏み込んでいる打者の体へ投げない', { aims: bothWays, noAwardIfSteppedIn: false }],
      ['B', '投げた後に踏み込んで当たった球は死球にしない', { aims: bothWays, avoidCrowder: false }],
      ['AB', '両方', { aims: bothWays }],
    ];
    const ways = [WAY.crowd, WAY.stepPre, WAY.stepLate, WAY.trust, WAY.cpu];
    console.log(`${'対策'.padEnd(26)}${row(['寄り切る', '前に踏み込む', '後に踏み込む', '信じる', 'CPU打者'], 16)}`);
    for (const [key, label, opts] of rules) {
      console.log(
        `${label.padEnd(26)}${row(
          ways.map((w) => {
            const r = run(key, opts, w);
            return `${f2(r.runs)}点/${pct(r.hbp)}`;
          }),
          16,
        )}`,
      );
    }
    console.log('   ＝**当てない**だけでは、投げた後に踏み込む打者が残る（CPU投手はリリースの後は何もできない）。');
    console.log('     **死球にしない**だけでは、最初から寄っている打者が残る。両方そろえて、死球のもらい得は消える。');
    console.log('     CPU打者（直前のストライクへ寄る）への死球も、同じ規則で消える。');
  }

  // ============================================================
  // 4. 逆を突く向きと割合（死球のもらい得を消した上で）
  // ============================================================

  console.log('\n=== 4. 逆を突く向きと割合（当てない＋踏み込んだ球は死球にしない、の上で） ===');
  const blocks: Array<[string, string, AtBatOptions, number]> = [
    ['AB', `どちらの側に立っても逆を突く・${f2(CPU_CROSS_CHANCE)}（採らず）`, { aims: { crossBothWays: true } }, CPU_CROSS_CHANCE],
    ['adopted', '外角側に立ったときだけ内角へ・0（立ち位置は必ず本当）', {}, 0],
    ['adopted', '外角側に立ったときだけ内角へ・1/4', {}, 1 / 4],
    ['adopted', '外角側に立ったときだけ内角へ・1/3', {}, 1 / 3],
    ['adopted', '外角側に立ったときだけ内角へ・1/2', {}, 1 / 2],
  ];
  for (const [key, label, opts, chance] of blocks) {
    const adopted = key === 'adopted' && chance === CPU_CROSS_CHANCE;
    console.log(`--- ${label}${adopted ? '【採用】' : ''} ---`);
    console.log(`${'打者の打ち方'.padEnd(34)}${HEAD}`);
    for (const way of [WAY.trust, WAY.react, WAY.outIn, WAY.crowd, WAY.half, WAY.center, WAY.off, WAY.stepLate, WAY.cpu]) {
      console.log(line(way.label, run(key, opts, way, chance)));
    }
  }
  console.log('   実際の野球は 打率.250 / 出塁率.320 / 単打14.5% / 二塁打+4.9% / HR3.0% / 三振22% / 四球8.5% / 約4.5点。');
  console.log('   ＝どちらの側に立っても逆を突くと、内角側に立って外角へ逆を突いた球が**寄り切った打者の芯へ行く**');
  console.log('     ＝読まずに寄るほうが、立ち位置を信じるより得のまま。**外角側に立ったときだけ内角へ**逆を突けば、');
  console.log('     寄り切った打者は逆を突かれるたびに詰まり、内角側に立たれたら必ず内角へ来る＝**読まずに寄る打者が、');
  console.log('     立ち位置を信じる打者を上回らなくなる**（外角と示されて寄るのは賭け・内角と示されたら離れて単打）。');
  console.log('     打率・出塁率は信じる打者がはっきり上。得点は同じかやや上（得点期待は打線ごとの揺れが大きく、');
  console.log('     同じ打ち方でも標本で1点ほど動く＝6912打席では 信じる 7.2点・寄り切る 6.9点）。');
  console.log('     割合 0 では読みが外れない。上げるほど信じる値打ちが薄れる。**信じるのが得のまま、');
  console.log('     外角と示された球の3回に1回は内角へ食い込む**のが 1/3。');
  console.log('     寄ること自体の得（外角を捉えると長打）は残る：寄り切る打者は中央のままの打者の1.5倍の点を取る。');

  // ============================================================
  // 5. 逆を突く球・投げ直す球の形（名鑑96人×全カウント×立つ側×打席の左右）
  // ============================================================

  console.log('\n=== 5. 逆を突く球・投げ直す球の形（名鑑96人×12カウント×立つ側×打席の左右） ===');
  for (const l of shapeLines) console.log(l);
  console.log(`   人間のコース入力（投げる瞬間の左右）は ${COURSE_RELEASE_VX}m/s。人間は同じ立ち位置から同じ隅へ、`);
  console.log('   コース入力＋曲げ続けることで届く（曲がりながら入る）。CPUは**曲げ続ける代わりに最初から斜めに投げる**');
  console.log('   ＝曲がりは3割のまま（BBB-77）で、球筋は投げた瞬間から直線として読める。');
  console.log(`   逆を突けるのは狙いがゾーンの中（|x| ≦ ${STRIKE_ZONE_HALF_WIDTH}）の球だけ＝**制球の悪い投手ほど逆を突けない**。`);

  // ============================================================
  // 6. 投げた後は見分けられるか（画面上の差）と、打者が動ける時間
  // ============================================================

  console.log('\n=== 6. 投げた後の見分け（1280x720。同じ立ち位置から出た「立ち位置どおり」と「逆を突く球」の横の差） ===');
  for (const l of seeLines) console.log(l);
  console.log(
    `   動ける時間＝打撃面まで − 見分けが付くまで − 人の反応 ${HUMAN_REACTION_SEC}秒 − スイングを押す時刻 ${SWING_IDEAL_SEC}秒。`,
  );
  console.log(
    `   寄り切った所から逆の端までは ${(2 * BATTER_STANCE_RANGE).toFixed(2)}m（${((2 * BATTER_STANCE_RANGE) / BATTER_STANCE_MOVE_SPEED).toFixed(2)}秒）。`,
  );
  console.log('   ＝**速球・基準速は見てからでは間に合わない（立ち位置を信じるか、寄らずに待つか）・フォークは見てから戻れる**。');

  // ============================================================
  // 7. CPU同士への影響と、打席の左右の偏り
  // ============================================================

  console.log('\n=== 7. CPU打者 vs CPU投手（BBB-83 までの規則 → 最初の形 → 採用）と、打席の左右 ===');
  {
    const first = run('first', FIRST_CUT, WAY.cpu);
    const after = run('adopted', {}, WAY.cpu, CPU_CROSS_CHANCE);
    console.log(`${'規則'.padEnd(34)}${HEAD}`);
    console.log(line('BBB-83 まで（偶奇・立ち位置どおり）', before.cpu));
    console.log(line('最初の形（両方向へ逆・当てる）', first));
    console.log(line('採用（外角側から内角へ・当てない）', after));
    const sideRow = (label: string, r: League): string =>
      (['R', 'L'] as const)
        .map((h) => {
          const s = r.bySide[h];
          return `${label}・${h === 'R' ? '右打者' : '左打者'}（${s.n}打席）：単打 ${pct(s.single / s.n)}・二塁打+ ${pct(s.extra / s.n)}・HR ${pct(s.hr / s.n)}`;
        })
        .join('\n   ');
    console.log(`   ${sideRow('BBB-83 まで', before.cpu)}`);
    console.log(`   ${sideRow('採用', after)}`);
    console.log('   ＝BBB-83 までは初球が必ず一塁側（右打者には外角＝高いフライ・左打者には内角＝ゴロ）だった。');
    console.log('     立つ側を五分五分に引き、逆を突く向きを打者から見た内角にそろえると、打席の左右で内訳が偏る理由が無くなる。');
    console.log('     内角へ来る球が増える（ゾーンの球の3分の2）ぶん、単打が増えて長打が減る。');
  }

  // ============================================================
  // 8. 参考：球速も読む打者（残っている穴の大きさ）
  // ============================================================

  console.log('\n=== 8. 参考：球速も読む打者（CPU投手の球速はカウントから決まる＝今回は触っていない） ===');
  {
    console.log(`${'打者の打ち方'.padEnd(34)}${HEAD}`);
    console.log(line('立ち位置を信じる', run('adopted', {}, WAY.trust, CPU_CROSS_CHANCE)));
    console.log(line('立ち位置を信じる＋球速も読む', league({ stanceFor: trustTell, readsPace: true })));
    console.log(line('中央のまま＋球速も読む', league({ stanceFor: center, readsPace: true })));
    console.log('   ＝球速（0-0は速球・ストライクの後はフォーク…）はいまも投げる前に分かる。待つ速さを外さない打者の');
    console.log('     上積みがここに出る（次に塞ぐならここ）。');
  }
}

main();
