/**
 * ランダンプレイ（説明書p25）が**成立する余地があるか**の計測（フェーズJ-30）。
 *
 *   npm run balance:rundown
 *
 * CPU守備のランダムを「送球で刺せないときだけ追う」規則で入れるにあたり、
 * **そもそもその場面が存在するのか**を先に測るためのもの。CLAUDE.md の
 * 「数値の手応えは勘で動かさず必ず計測してから決める」（I-29で確定した方針）に従う。
 *
 * ## なぜ測る必要があったか
 *
 * 送球（THROW_SPEED）と野手の足（FIELDER_SPEED）の比が大きいほど、「送球では刺せないが
 * 走れば追える」という帯は狭くなる。極端には送球が十分速ければ帯は**空**になり、
 * 「送球で刺せないときだけ追う」というCPUの規則は一度も発火しない（＝実装しても
 * 何も起きない）。逆に送球を遅くすれば帯は広がるが、**内野ゴロのアウト・犠牲フライ・
 * 盗塁・けん制の境界がすべて同時に動く**（どれも送球の時間競争で決まっているため）。
 *
 * このスクリプトは、その2つを**同じ表の中で**見せる：
 * - 上段：フィールドを格子で舐めて「送球で刺せる／走れば追える／どちらも無理」の割合
 * - 下段：送球速度が動かしてしまう既存の境界（内野ゴロ・犠飛・盗塁・けん制）
 *
 * 判定は `src/core` の純粋関数（`canTagByRunning`）をそのまま呼ぶので、定数を動かせば
 * ここの数字も一緒に動く（I-29のシミュレータと同じ約束）。
 *
 * ## 3段目：タッチプレーを入れると何が変わるか（フェーズK-31）
 *
 * J-30 が「送球速度では帯が開かない」と結論した後、**そもそも塁へ投げるだけで
 * 刺せるのがおかしい**（実際の野球では非フォースの走者はタッチしないとアウトにならない）
 * という別の入口が残っていた。3段目はその効き目を測る：
 *
 * - **フォース模型**（現行）：走者は「行き先の塁への送球」に負けたらアウト。逃げ道は無い。
 * - **タッチ模型**（K-31）：走者は前後どちらの塁へ向かってもよく、**どちらか一方でも
 *   送球より先に着ければ助かる**（着いた塁を踏めばタッチされない）。
 *
 * 測るのは3つ。(a) 現行アウトのうちタッチ模型で助かる割合＝**新しく生まれる走者の判断**、
 * (b) それでもアウトの割合＝守備が取れていたアウトが減りすぎていないか、
 * (c) 「どちらの塁へ投げても刺せない」割合＝**守備が追うしかない場面**（ランダン／
 * ドロップキックの出番があるか）。
 *
 * ## 4段目：塁間で止まれると何が変わるか（フェーズN-34）
 *
 * 3段目の「どちらも×」＝**前へ行っても戻っても刺される**場面には、いま手が1つも無い
 * （押しても助からない）。ここで走者が止まれると、非フォースの走者には
 * `throwRetiresRunner` が false を返す＝**塁へ投げても触れない**ので、守備は走って
 * 追うしかなくなる。測るのは2つ：
 *
 * - **稼げる時間**（走り続ければアウトになるまでの時間 → 野手が走ってタッチするまでの時間）。
 *   これがそのまま**他の走者が進める距離**になる＝実際の野球で挟殺が持っている値打ち。
 * - **逃げ切れるか**（野手が走者へ寄るほど、野手が離れた塁への送球は間に合わなくなる。
 *   その瞬間に走り出せば助かる場面が実在するか）＝**止まることが自分の生存にも効くか**。
 */
import {
  BASE_PATH,
  BASE_POSITIONS,
  FIELDER_HOME_POSITIONS,
  FIELDER_SPEED,
  FLY_CATCH_RELEASE_SEC,
  RUNNER_SPEED,
  TAG_RADIUS,
  THROW_SPEED,
  advancedBase,
  canTagByRunning,
  distance,
  pickoffOutLead,
  stealSafeJumpSec,
  type Vec2,
} from '../../src/core/fielding';

/** 走者の走る区間（塁→次の塁）。本塁への生還も含めて全部見る */
const LEGS = ['first', 'second', 'third'] as const;

/** 走者が区間のどこまで来ているか（0=出たところ / 1=塁の直前）の刻み */
const PROGRESS_STEPS = 20;

/** 野手の位置を舐める格子（内野〜外野。ファウル地域は守備がほぼ起きないので除く） */
const GRID_STEP = 4;
const GRID_X = 60;
const GRID_Z = 110;

interface Tally {
  /** 送球で刺せる（＝CPUは従来どおり投げる） */
  throwGets: number;
  /** 送球では刺せないが、走れば触れる（＝ランダンが意味を持つ帯） */
  chaseOnly: number;
  /** どちらでも刺せない（走者の勝ち） */
  neither: number;
}

function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

/** 打球のプレー中に起こりうる（野手の位置 × 走者の位置）を格子で舐める */
function tally(throwSpeed: number, runnerSpeed: number = RUNNER_SPEED): Tally {
  const t: Tally = { throwGets: 0, chaseOnly: 0, neither: 0 };
  for (const from of LEGS) {
    const origin = BASE_POSITIONS[from];
    const base = BASE_POSITIONS[advancedBase(from)];
    for (let s = 1; s <= PROGRESS_STEPS; s += 1) {
      const runner = lerp(origin, base, s / PROGRESS_STEPS);
      const runnerTime = distance(runner, base) / runnerSpeed;
      for (let x = -GRID_X; x <= GRID_X; x += GRID_STEP) {
        for (let z = 0; z >= -GRID_Z; z -= GRID_STEP) {
          const carrier = { x, z };
          // ファウル地域は除く（|x| > |z| のあたりは打球がほぼ来ない）
          if (Math.abs(x) > Math.abs(z) + 5) continue;
          if (distance(carrier, base) / throwSpeed < runnerTime) {
            t.throwGets += 1;
          } else if (canTagByRunning(carrier, { pos: runner, target: base, speed: runnerSpeed })) {
            t.chaseOnly += 1;
          } else {
            t.neither += 1;
          }
        }
      }
    }
  }
  return t;
}

function pct(n: number, total: number): string {
  return `${((n / total) * 100).toFixed(1)}%`;
}

/**
 * タッチプレー（K-31）を入れたときの帰結の内訳。
 *
 * 走者は塁間のどこかにいて、前の塁（ahead）と後ろの塁（behind）のどちらへでも走れる。
 * 守備はボールを持っていて、走者が向かった塁へ投げるか、走って追うかを選べる。
 * **守備は走者の選択に即応できる**ものとして見る（＝走者に有利な読みを与えない）ので、
 * 走者が助かるのは「送球より先に着ける塁が1つでもある」ときだけ。
 */
interface TagTally {
  /** 前の塁へそのまま行っても助かる（フォース模型でもセーフ＝現行と同じ） */
  safeAhead: number;
  /** 前は刺されるが**戻れば助かる**＝K-31で新しく生まれる走者の判断 */
  savedByRetreat: number;
  /** どちらへ行っても送球に負ける（＝アウトのまま。挟殺の手順を踏むだけ） */
  caughtEither: number;
  /** そのうち、送球では刺せず**走って追わないと触れない**（＝ランダンの出番） */
  chaseNeeded: number;
}

function tagTally(throwSpeed: number, runnerSpeed: number = RUNNER_SPEED): TagTally {
  const t: TagTally = { safeAhead: 0, savedByRetreat: 0, caughtEither: 0, chaseNeeded: 0 };
  for (const from of LEGS) {
    const behind = BASE_POSITIONS[from];
    const ahead = BASE_POSITIONS[advancedBase(from)];
    for (let s = 1; s <= PROGRESS_STEPS; s += 1) {
      const runner = lerp(behind, ahead, s / PROGRESS_STEPS);
      for (let x = -GRID_X; x <= GRID_X; x += GRID_STEP) {
        for (let z = 0; z >= -GRID_Z; z -= GRID_STEP) {
          const carrier = { x, z };
          if (Math.abs(x) > Math.abs(z) + 5) continue;
          // その塁へ向かったときに刺されるか（送球で先着される／走って追いつかれる）。
          // シーン層の releaseThrow・updateRundown と同じ2通りの決着の仕方を見る。
          const caught = (to: Vec2): boolean =>
            distance(carrier, to) / throwSpeed < distance(runner, to) / runnerSpeed ||
            canTagByRunning(carrier, { pos: runner, target: to, speed: runnerSpeed });
          const throwGets = (to: Vec2): boolean =>
            distance(carrier, to) / throwSpeed < distance(runner, to) / runnerSpeed;
          if (!caught(ahead)) {
            t.safeAhead += 1;
          } else if (!caught(behind)) {
            t.savedByRetreat += 1;
          } else {
            t.caughtEither += 1;
            if (!throwGets(ahead) && !throwGets(behind)) t.chaseNeeded += 1;
          }
        }
      }
    }
  }
  return t;
}

/**
 * 「止まる」（N-34）の効き目。3段目の**「どちらも×」の場面だけ**を対象に測る
 * （前へ行くか戻るかで助かる場面には、止まる理由がそもそも無い）。
 */
interface HoldTally {
  /** 対象になった場面の数（＝3段目の caughtEither と同じ集合） */
  cases: number;
  /** 止まると野手のタッチまで時間が延びる場面 */
  gains: number;
  /** 延びる時間の合計 s（平均を出すため） */
  gainedSec: number;
  /** そのうち、他の走者が1つ塁を進める（BASE_PATH 以上を走れる）だけ稼げる場面 */
  fullBase: number;
  /** 野手が寄ってきた隙に走り出せば助かる場面＝**止まった本人が逃げ切れる** */
  escapes: number;
}

/** from から to へ最大 dist だけ進んだ点（到達したら to そのもの） */
function stepToward(from: Vec2, to: Vec2, dist: number): Vec2 {
  const len = distance(from, to);
  if (len <= dist || len === 0) return { ...to };
  return { x: from.x + ((to.x - from.x) / len) * dist, z: from.z + ((to.z - from.z) / len) * dist };
}

/**
 * 止まった走者が逃げ切れるか。**野手が走者へ寄るほど、野手が離れた塁への送球は
 * 遅くなる**ので、詰められている途中に走り出せば助かる瞬間がありうる（＝実際の
 * 挟殺で守備が「投げるか、詰めるか」を迫られる理由そのもの）。
 *
 * 守備は最短で走者へ寄る（タッチしにいく）ものとして見る。走者は止まったまま待ち、
 * どこかの時点で前後どちらかへ走り出せる。走り出した先で送球にもタッチにも負けない
 * 瞬間が1つでもあれば「逃げ切れる」と数える。
 */
function holdEscapes(runner: Vec2, carrier: Vec2, ahead: Vec2, behind: Vec2, speed: number): boolean {
  for (let t = 0; t <= 6; t += 0.05) {
    const at = stepToward(carrier, runner, FIELDER_SPEED * t);
    if (distance(at, runner) <= TAG_RADIUS) return false; // 逃げ出す前に触られた
    for (const to of [ahead, behind]) {
      const throwTime = distance(at, to) / THROW_SPEED;
      const runnerTime = distance(runner, to) / speed;
      // 送球は同着なら走者有利（releaseThrow と同じ）。走って追われても触れないこと。
      if (throwTime >= runnerTime && !canTagByRunning(at, { pos: runner, target: to, speed })) {
        return true;
      }
    }
  }
  return false;
}

function holdTally(throwSpeed: number, runnerSpeed: number = RUNNER_SPEED): HoldTally {
  const t: HoldTally = { cases: 0, gains: 0, gainedSec: 0, fullBase: 0, escapes: 0 };
  for (const from of LEGS) {
    const behind = BASE_POSITIONS[from];
    const ahead = BASE_POSITIONS[advancedBase(from)];
    for (let s = 1; s <= PROGRESS_STEPS; s += 1) {
      const runner = lerp(behind, ahead, s / PROGRESS_STEPS);
      for (let x = -GRID_X; x <= GRID_X; x += GRID_STEP) {
        for (let z = 0; z >= -GRID_Z; z -= GRID_STEP) {
          const carrier = { x, z };
          if (Math.abs(x) > Math.abs(z) + 5) continue;
          const caught = (to: Vec2): boolean =>
            distance(carrier, to) / throwSpeed < distance(runner, to) / runnerSpeed ||
            canTagByRunning(carrier, { pos: runner, target: to, speed: runnerSpeed });
          // 3段目の「どちらも×」だけが対象（＝いま走者に手が1つも無い場面）
          if (!caught(ahead) || !caught(behind)) continue;
          t.cases += 1;
          // 走り続けた場合：塁に着いた瞬間、そこで待つ野手にタッチされる。
          const keepGoing = distance(runner, ahead) / runnerSpeed;
          // 止まった場合：送球では触れないので、野手が走ってタッチしに来るまで生きている。
          const held = Math.max(0, (distance(carrier, runner) - TAG_RADIUS) / FIELDER_SPEED);
          const gained = held - keepGoing;
          if (gained > 0) {
            t.gains += 1;
            t.gainedSec += gained;
            if (gained * runnerSpeed >= BASE_PATH) t.fullBase += 1;
          }
          if (holdEscapes(runner, carrier, ahead, behind, runnerSpeed)) t.escapes += 1;
        }
      }
    }
  }
  return t;
}

/**
 * 内野ゴロの一塁送球が間に合うか（＝この守備モデルでいちばん壊れると困る帰結）。
 * 遊撃手が定位置で捕り、`fieldSec` かけて捕ってから投げる、という単純化。
 */
function groundOutMargin(throwSpeed: number, fieldSec: number): number {
  const throwTime = distance(FIELDER_HOME_POSITIONS.SS, BASE_POSITIONS.first) / throwSpeed;
  const runnerTime = BASE_PATH / RUNNER_SPEED;
  return runnerTime - (fieldSec + throwTime);
}

function main(): void {
  const speeds = [THROW_SPEED, 30, 26, 22, 18, 14, 10];
  console.log('\n=== 1. 「送球で刺せない／走れば追える」帯の広さ（打球のプレーの格子） ===');
  console.log('走者は基準速 7.5m/s、野手の足は 8.5m/s。割合は格子点に対するもの。\n');
  const widths = [10, 12, 14, 12];
  const row = (cells: (string | number)[]): void =>
    console.log(cells.map((c, i) => String(c).padStart(widths[i])).join(' '));
  row(['送球m/s', '送球で刺せる', 'ランダンの帯', '刺せない']);
  for (const s of speeds) {
    const t = tally(s);
    const total = t.throwGets + t.chaseOnly + t.neither;
    row([s, pct(t.throwGets, total), pct(t.chaseOnly, total), pct(t.neither, total)]);
  }

  console.log('\n=== 2. 送球速度が同時に動かしてしまう既存の境界 ===');
  console.log('内野ゴロ余裕 = 走者の塁間時間 −（捕るまで + 一塁送球）。正なら守備が間に合う＝アウト、負なら内野安打。');
  console.log('犠飛の分岐点 = この深さより深いフライなら三塁走者が還れる（fielding.ts の式）。');
  console.log('盗塁の窓 = 一塁走者が間に合う「投球の残り時間」（大きいほど盗塁しやすい）。');
  console.log('けん制の境界 = この距離より深くリードすると刺される（一塁）。\n');
  const w2 = [10, 14, 14, 12, 14];
  const row2 = (cells: (string | number)[]): void =>
    console.log(cells.map((c, i) => String(c).padStart(w2[i])).join(' '));
  row2(['送球m/s', '内野ゴロ余裕', '犠飛の分岐点', '盗塁の窓', 'けん制の境界']);
  for (const s of speeds) {
    // 捕るまでの時間は「よくある内野ゴロ」として 1.9 秒に置く（実測の代用。
    // 速度どうしの比較が目的なので、どの速度でも同じ値を使えば十分）。
    const margin = groundOutMargin(s, 1.9);
    const sacFly = (BASE_PATH / RUNNER_SPEED - FLY_CATCH_RELEASE_SEC) * s;
    const steal =
      (BASE_PATH - 3.5) / RUNNER_SPEED -
      distance(BASE_POSITIONS.home, BASE_POSITIONS.second) / s -
      1.6;
    const lead = (distance(FIELDER_HOME_POSITIONS.P, BASE_POSITIONS.first) / s) * RUNNER_SPEED;
    row2([
      s,
      `${margin >= 0 ? '+' : ''}${margin.toFixed(2)}秒`,
      `${sacFly.toFixed(0)}m`,
      `${steal.toFixed(2)}秒`,
      `${lead.toFixed(1)}m`,
    ]);
  }
  console.log(
    `\n参考：現在値 THROW_SPEED=${THROW_SPEED} / FIELDER_SPEED=${FIELDER_SPEED} / ` +
      `盗塁の実際の窓=${stealSafeJumpSec('first').toFixed(2)}秒 / ` +
      `けん制の実際の境界=${pickoffOutLead('first', FIELDER_HOME_POSITIONS.P).toFixed(2)}m`,
  );

  console.log('\n=== 3. タッチプレー（K-31）を入れると帰結がどう変わるか ===');
  console.log('走者は前後どちらの塁へも走れ、送球より先に踏めば助かる（＝タッチされない）。');
  console.log('「戻れば助かる」が、現行のフォース模型ではアウトだった場面＝新しく生まれる判断。\n');
  const w3 = [8, 12, 14, 12, 14];
  const row3 = (cells: (string | number)[]): void =>
    console.log(cells.map((c, i) => String(c).padStart(w3[i])).join(' '));
  row3(['走力', '前へ行けば安全', '戻れば助かる', 'どちらも×', '追わないと×']);
  for (const rs of [6.8, RUNNER_SPEED, 8.2]) {
    const t = tagTally(THROW_SPEED, rs);
    const total = t.safeAhead + t.savedByRetreat + t.caughtEither;
    row3([
      rs,
      pct(t.safeAhead, total),
      pct(t.savedByRetreat, total),
      pct(t.caughtEither, total),
      pct(t.chaseNeeded, total),
    ]);
  }
  console.log(
    '\n「前へ行けば安全」はフォース模型でもセーフなので帰結は変わらない。' +
      '\n「戻れば助かる」の分だけ守備が取れていたアウトが減り、そこが走者の判断になる。',
  );

  console.log('\n=== 4. 塁間で止まれると何が変わるか（フェーズN-34） ===');
  console.log('対象は3段目の「どちらも×」＝前へ行っても戻っても刺される場面（いま手が1つも無い帯）。');
  console.log('止まると非フォースの走者には送球が届かない＝野手が走ってタッチしに来るまで生きている。');
  console.log('稼げる時間 = その「タッチまでの時間」−「走り続けて塁で刺されるまでの時間」。\n');
  const w4 = [8, 10, 12, 14, 14, 12];
  const row4 = (cells: (string | number)[]): void =>
    console.log(cells.map((c, i) => String(c).padStart(w4[i])).join(' '));
  row4(['走力', '対象の数', '時間を稼ぐ', '平均で稼ぐ時間', '他の走者が1塁分', '逃げ切れる']);
  for (const rs of [6.8, RUNNER_SPEED, 8.2]) {
    const t = holdTally(THROW_SPEED, rs);
    row4([
      rs,
      t.cases,
      pct(t.gains, t.cases),
      `${(t.gainedSec / Math.max(1, t.gains)).toFixed(2)}秒`,
      pct(t.fullBase, t.cases),
      pct(t.escapes, t.cases),
    ]);
  }
  console.log(
    '\n「他の走者が1塁分」＝稼いだ時間で別の走者が塁間(27.4m)を走り切れる場面＝' +
      '\n**1人を差し出して1つ進める**という、実際の野球の挟殺の値打ちがそのまま出る場面。' +
      '\n「逃げ切れる」＝野手が寄ってくるほど、野手が離れた塁への送球は間に合わなくなる' +
      '\n（その瞬間に走り出せば助かる）＝止まった本人にも生存の目が残るか。',
  );
}

main();
