/**
 * フェーズW-44：**制球を疲労とスキルへ広げる**。
 *
 * 着手前の実態はT-41が明示的に残した2つ：
 * - **疲労は制球に効かない**（B-11がユーザー判断で確定した「疲労で効くのは球速・変化量・
 *   球威の3つ」のまま。制球という軸そのものがT-41まで無かったので書けなかった）。
 * - **制球を上げ下げするスキルが書けない**（ERAが `effectivePitching` の補正対象外だった）。
 *
 * 着手前の計測（`npm run balance:control` の8〜10段目）が、このセッションの設計を1つ
 * 変えている：**CPU限定では発火しない**。J-30の自動継投がCPU投手を残量0.5（＝疲労が
 * 0を超えた瞬間）で必ず代えるので、16球団の実測最大疲労は 0.029〜0.123（平均0.091）。
 * 疲労が実際に高くなるのは**自動継投しない人間の投手**のほう（無傷でも120球で1.00／
 * V-43の持ち越しで残量0.6から始まれば80球で1.00）。そこでユーザー判断で
 * **人間側にも「狙える幅が痩せる」形で効かせた**（誤差は足さない＝T-41の判断は不変）。
 *
 * ここで固定するのは7つ。
 * 1. **渡さない呼び出しはW-44の前と完全に同じ**（疲労0・スキル無しで一切動かない）
 * 2. **疲労は制球を単調に削る**（`fatiguedSpeed` と同じ引き算・同じ 0.35）
 * 3. **制球の補正はERAそのものへ書き戻る**＝HUDの防御率が一緒に動く（ユーザー判断）
 * 4. **人間側は「効き幅」であって「誤差」ではない**＝向きは常に入力どおり
 * 5. **`COURSE_VX_PER_CONTROL` は計測が決めた**（制球+0.20でCPUの決め球の隅にちょうど届く）
 * 6. **T-41の不変条件は保たれる**（打席から離れれば、疲れ切った投手の球でも必ず避けられる）
 * 7. **新しい札3枚の構造**（上位互換にしない／デュオの前提は同系統・投手専用）
 */
import { describe, expect, it } from 'vitest';
import {
  BATTER_STANCE_RANGE,
  COURSE_RELEASE_VX,
  COURSE_VX_PER_CONTROL,
  FATIGUE_CONTROL_LOSS,
  FATIGUE_SPEED_DROP,
  NEUTRAL_RATING,
  PLATE_Z,
  RELEASE_Z,
  RIGHT_BATTER_SIDE,
  STRIKE_ZONE_HALF_WIDTH,
  courseReleaseVxFor,
  fatiguedControl,
  judgePitch,
  speedForPitchSelection,
} from '../src/core/pitch';
import {
  CPU_CONTROL_MAX_TARGET,
  chooseCpuPitchPlan,
  cpuPitcherStyle,
} from '../src/core/cpuPitcher';
import {
  CONTROL_ERA_SPAN,
  controlBonusOf,
  createTeamRoster,
  effectivePitching,
  eraWithControl,
  formatEra,
  grantSkill,
  pitcherControl,
} from '../src/core/roster';
import { DUO_RARITY, SKILLS } from '../src/core/skills';
import { pitcherCardText } from '../src/ui/hud/hud';
import { teamById } from '../src/core/teams';

const TEST_TEAM = teamById('foresters');

/** 基準球速でのリリース→本塁の飛行時間（コース入力のズレ幅がここで決まる） */
const FLIGHT_SEC = (PLATE_Z - RELEASE_Z) / speedForPitchSelection(0);
/** ど真ん中のプレート位置から、コース入力だけで届くX */
const reachOf = (vx: number): number => vx * FLIGHT_SEC;
/** CPUの決め球が狙う隅（`cpuPitcher.ts` の CORNER_MARGIN と同じ値。T-41から） */
const CPU_PUTAWAY_CORNER = STRIKE_ZONE_HALF_WIDTH + 0.05;

/** その球団の先発（名鑑の先頭の投手）を持つロスター */
function rosterWithStarter() {
  const roster = createTeamRoster(TEST_TEAM);
  return { roster, pitcher: roster.pitcher };
}

// ============================================================
describe('基準線：渡さなければW-44の前と完全に同じ（B-8以来の約束）', () => {
  it('fatiguedControl は疲労0で入力をそのまま返す', () => {
    for (const control of [0, 0.25, 0.5, 0.75, 1]) {
      expect(fatiguedControl(control, 0)).toBeCloseTo(control, 10);
    }
  });

  it('courseReleaseVxFor は引数なしで従来の COURSE_RELEASE_VX', () => {
    expect(courseReleaseVxFor()).toBeCloseTo(COURSE_RELEASE_VX, 10);
    expect(courseReleaseVxFor(0, 0)).toBeCloseTo(COURSE_RELEASE_VX, 10);
  });

  it('補正なしの届くXはゾーン半幅とほぼ同じ（COURSE_RELEASE_VX の元の役割）', () => {
    const reach = reachOf(courseReleaseVxFor());
    expect(Math.abs(reach - STRIKE_ZONE_HALF_WIDTH)).toBeLessThan(0.02);
  });

  it('eraWithControl は補正0でERAを1mmも動かさない（名鑑の値そのまま）', () => {
    for (const era of [1.95, 2.5, 3.1, 4.3]) {
      expect(eraWithControl(era, 0)).toBe(era);
    }
  });

  it('スキルを持たない投手の制球の上乗せは必ず0（人間の投球の手触りは不変）', () => {
    const { roster, pitcher } = rosterWithStarter();
    expect(controlBonusOf(roster, pitcher)).toBe(0);
    expect(courseReleaseVxFor(controlBonusOf(roster, pitcher))).toBeCloseTo(COURSE_RELEASE_VX, 10);
  });

  it('名鑑のERAは人間のコース入力に効かない（差だけを渡すから）', () => {
    // ERAがまるで違う2人でも、スキルが無ければ上乗せは同じ0
    const roster = createTeamRoster(TEST_TEAM);
    const staff = [roster.pitcher, ...roster.bullpen];
    const eras = staff.map((id) => effectivePitching(roster, id)?.era ?? 0);
    expect(new Set(eras).size).toBeGreaterThan(1); // 前提：ERAは人によって違う
    for (const id of staff) expect(controlBonusOf(roster, id)).toBe(0);
  });
});

// ============================================================
describe('疲労は制球を削る（B-11の3つ目の軸に4つ目が並ぶ）', () => {
  it('`fatiguedSpeed` と同じ引き算・同じ量（新しい自由変数を作らない）', () => {
    expect(FATIGUE_CONTROL_LOSS).toBe(FATIGUE_SPEED_DROP);
    expect(fatiguedControl(1, 1)).toBeCloseTo(1 - FATIGUE_CONTROL_LOSS, 10);
  });

  it('疲労について単調に減る（途中で得になる領域が無い）', () => {
    let prev = Infinity;
    for (const fatigue of [0, 0.25, 0.5, 0.75, 1]) {
      const c = fatiguedControl(0.8, fatigue);
      expect(c).toBeLessThanOrEqual(prev);
      prev = c;
    }
  });

  it('0..1 の外へ出ない（下流の cpuControlSpray がそのまま受け取れる）', () => {
    expect(fatiguedControl(0, 1)).toBe(0);
    expect(fatiguedControl(1, 0)).toBe(1);
    expect(fatiguedControl(-5, 0.5)).toBe(0);
    expect(fatiguedControl(5, 0)).toBe(1);
  });

  it('疲れた投手の決め球は外れる（見逃し三振の値打ちが失われる）', () => {
    // 制球の良い投手（0.8）は無傷なら見逃せばストライク、疲れ切ると外れる
    const fresh = chooseCpuPitchPlan({ balls: 0, strikes: 2 }, 'balanced', fatiguedControl(0.8, 0));
    const tired = chooseCpuPitchPlan({ balls: 0, strikes: 2 }, 'balanced', fatiguedControl(0.8, 1));
    expect(Math.abs(fresh.targetX)).toBeLessThanOrEqual(STRIKE_ZONE_HALF_WIDTH);
    expect(Math.abs(tired.targetX)).toBeGreaterThan(Math.abs(fresh.targetX));
  });

  it('どれだけ疲れても狙いは上限を越えない（T-41の CPU_CONTROL_MAX_TARGET）', () => {
    for (const control of [0, 0.25, 0.5, 0.75, 1]) {
      for (let balls = 0; balls <= 3; balls += 1) {
        for (let strikes = 0; strikes <= 2; strikes += 1) {
          const plan = chooseCpuPitchPlan(
            { balls, strikes },
            'balanced',
            fatiguedControl(control, 1),
          );
          expect(Math.abs(plan.targetX)).toBeLessThanOrEqual(CPU_CONTROL_MAX_TARGET + 1e-9);
        }
      }
    }
  });

  /**
   * **T-41の設計不変条件をそのまま延長する**：荒れの出どころが制球の悪さでも疲労でも、
   * 上限は同じ `CPU_CONTROL_MAX_TARGET` なので、**打席から離れて立てば必ず避けられる**
   * （桜井ノウハウ「人に反応できない動作をするとすっごい理不尽感がある」＝回避手段が
   * 実在することが、死球を理不尽にしない条件）。
   */
  it('疲れ切った投手の球でも、打席から離れれば死球にならない', () => {
    for (const control of [0, 0.25, 0.5, 0.75, 1]) {
      for (let balls = 0; balls <= 3; balls += 1) {
        for (let strikes = 0; strikes <= 2; strikes += 1) {
          const plan = chooseCpuPitchPlan(
            { balls, strikes },
            'balanced',
            fatiguedControl(control, 1),
          );
          expect(judgePitch(plan.targetX, RIGHT_BATTER_SIDE, BATTER_STANCE_RANGE)).not.toBe(
            'hitByPitch',
          );
        }
      }
    }
  });

  it('打席の中央では、疲れ切ると死球がありうる（ユーザー判断：荒れは死球まで届く）', () => {
    // 隅の向きはボール数の偶奇で入れ替わる（cornerSign）ので、**体側に来るカウント**が
    // あることを見る（どちらの偶奇が体側かは打席の位置で決まる。フェーズBB-49）
    const hbp = [0, 1].some(
      (balls) =>
        judgePitch(
          chooseCpuPitchPlan({ balls, strikes: 2 }, 'balanced', fatiguedControl(0.2, 1)).targetX,
          RIGHT_BATTER_SIDE,
          0,
        ) === 'hitByPitch',
    );
    expect(hbp).toBe(true);
  });
});

// ============================================================
describe('人間側は「効き幅」であって「誤差」ではない（T-41の判断を崩さない）', () => {
  it('疲労で狙える幅が痩せる（隅に届かなくなる）', () => {
    const fresh = reachOf(courseReleaseVxFor(0, 0));
    const tired = reachOf(courseReleaseVxFor(0, 1));
    expect(tired).toBeLessThan(fresh);
    expect(tired).toBeLessThan(STRIKE_ZONE_HALF_WIDTH);
  });

  it('疲労について単調（途中で広がる領域が無い）', () => {
    let prev = Infinity;
    for (const fatigue of [0, 0.25, 0.5, 0.75, 1]) {
      const vx = courseReleaseVxFor(0, fatigue);
      expect(vx).toBeLessThanOrEqual(prev);
      prev = vx;
    }
  });

  /**
   * **これがユーザー判断の芯**：どれだけ疲れても押した向きへは動く（0で下げ止める）。
   * 負にすると押した側と逆へ動く＝「自分の入力が裏切られる」になり、T-41が
   * 人間の投球に制球を効かせなかった理由そのものに触れてしまう。
   */
  it('どれだけ疲れても向きは入力どおり（負にならない＝コースは常に選べる）', () => {
    for (const fatigue of [0, 0.5, 1]) {
      expect(courseReleaseVxFor(0, fatigue)).toBeGreaterThan(0);
    }
    // 極端な補正を入れても逆流しない
    expect(courseReleaseVxFor(-10, 1)).toBe(0);
  });

  it('疲労は 0..1 の外の入力でも壊れない', () => {
    expect(courseReleaseVxFor(0, -1)).toBeCloseTo(COURSE_RELEASE_VX, 10);
    expect(courseReleaseVxFor(0, 5)).toBeCloseTo(courseReleaseVxFor(0, 1), 10);
  });

  /**
   * **`COURSE_VX_PER_CONTROL` を決めた基準**（`npm run balance:control` の10段目）。
   * 新しい数値を持ち込まず、既にある隅（T-41の CORNER_MARGIN）に合わせてある。
   */
  it('制球+0.20 で、CPUの決め球と同じ隅（0.50）へちょうど届く', () => {
    const reach = reachOf(courseReleaseVxFor(0.2, 0));
    expect(reach).toBeGreaterThanOrEqual(CPU_PUTAWAY_CORNER - 1e-3);
    expect(reach).toBeLessThan(CPU_PUTAWAY_CORNER + 0.02);
  });

  it('補正で広がるのはゾーンの外まで（＝ボール球で釣れるのが値打ち）', () => {
    expect(reachOf(courseReleaseVxFor(0.2, 0))).toBeGreaterThan(STRIKE_ZONE_HALF_WIDTH);
  });

  it('札を3枚積んでも、ど真ん中からは死球ゾーンに届かない', () => {
    const stacked =
      (SKILLS.shinenseigyo.modifier?.control ?? 0) +
      (SKILLS.zazen.modifier?.control ?? 0) +
      (SKILLS.mushin.modifier?.control ?? 0);
    expect(reachOf(courseReleaseVxFor(stacked, 0))).toBeLessThan(0.9);
  });
});

// ============================================================
describe('制球の補正はERAそのものへ書き戻る（HUDの防御率が一緒に動く）', () => {
  it('換算はERA→制球の逆（制球+0.2 は ERA -0.44）', () => {
    expect(eraWithControl(3.1, 0.2)).toBeCloseTo(3.1 - 0.2 * CONTROL_ERA_SPAN, 10);
    expect(pitcherControl(eraWithControl(3.1, 0.2))).toBeCloseTo(pitcherControl(3.1) + 0.2, 10);
  });

  it('ERAは負にならない（表示できる値にとどまる）', () => {
    expect(eraWithControl(1.0, 1)).toBe(0);
  });

  it('スキルを付けると effectivePitching のERAが下がる', () => {
    const { roster, pitcher } = rosterWithStarter();
    const before = effectivePitching(roster, pitcher)!.era;
    const granted = grantSkill(roster, pitcher, 'shinenseigyo');
    expect(granted.ok).toBe(true);
    const after = effectivePitching(granted.roster, pitcher)!.era;
    expect(after).toBeCloseTo(before - 0.2 * CONTROL_ERA_SPAN, 10);
  });

  it('HUDに出す防御率の文字列も動く（表示と判定が同じ1か所から出る）', () => {
    const { roster, pitcher } = rosterWithStarter();
    const before = formatEra(effectivePitching(roster, pitcher)!.era);
    const granted = grantSkill(roster, pitcher, 'shinenseigyo').roster;
    const after = formatEra(effectivePitching(granted, pitcher)!.era);
    expect(after).not.toBe(before);
  });

  /**
   * **W-44で実際に踏んだ穴**：投手カードは素の `player.pitching` を読んでいたので、
   * ERAが補正対象になった瞬間に「隅を突いてくるのにカードの防御率は名鑑のまま」という
   * 食い違いが生まれていた（打者カードは D-18 以来 `effectiveBatting` を通っていた）。
   */
  it('投手カードの防御率がスキルで動く（⑧「HUDの表示も自動で追従する」）', () => {
    const { roster, pitcher } = rosterWithStarter();
    const before = pitcherCardText(roster);
    const after = pitcherCardText(grantSkill(roster, pitcher, 'shinenseigyo').roster);
    expect(after).not.toBe(before);
    const eraOf = (text: string) => text.match(/ERA\s*([\d.]+)/)?.[1];
    expect(Number(eraOf(after))).toBeLessThan(Number(eraOf(before)));
  });

  it('制球の札を持たない投手のカードはW-44の前と同じ（平常時の表示は不変）', () => {
    const { roster, pitcher } = rosterWithStarter();
    const era = roster.players[pitcher].pitching!.era;
    expect(pitcherCardText(roster)).toContain(`ERA${formatEra(era)}`);
  });

  it('制球の補正を持たない札はERAを動かさない（他の軸に漏れない）', () => {
    const { roster, pitcher } = rosterWithStarter();
    const before = effectivePitching(roster, pitcher)!.era;
    const granted = grantSkill(roster, pitcher, 'nenriki').roster;
    expect(effectivePitching(granted, pitcher)!.era).toBe(before);
  });

  it('controlBonusOf はスキルの補正そのものを返す（クランプを通らない）', () => {
    const { roster, pitcher } = rosterWithStarter();
    const granted = grantSkill(roster, pitcher, 'shinenseigyo').roster;
    expect(controlBonusOf(granted, pitcher)).toBeCloseTo(0.2, 10);
  });

  /**
   * 名鑑最小のERA（1.95）は `pitcherControl` が既に 1.0 へクランプしている。
   * **差をERAの側から取っている**ので、その投手でも上乗せがちゃんと出る
   * （制球レーティングの引き算で取ると 0 になって効かない＝死に札になる）。
   */
  it('もともと制球が上限の投手でも、上乗せは0にならない', () => {
    const roster = createTeamRoster(teamById('galaxies'));
    const staff = [roster.pitcher, ...roster.bullpen];
    const best = staff.find((id) => pitcherControl(effectivePitching(roster, id)!.era) >= 1);
    expect(best).toBeDefined();
    const granted = grantSkill(roster, best!, 'shinenseigyo').roster;
    expect(controlBonusOf(granted, best!)).toBeCloseTo(0.2, 10);
  });

  it('投球能力を持たない選手でも読み出しで止まらない', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const fielder = roster.lineup.find((id) => !roster.players[id].pitching);
    expect(fielder).toBeDefined();
    expect(controlBonusOf(roster, fielder!)).toBe(0);
    expect(controlBonusOf(roster, 'no-such-player')).toBe(0);
  });
});

// ============================================================
describe('新しい札3枚（チョウノウリョク＝投球と読み）', () => {
  it('シネンセイギョ は★2の投手専用で、制球だけを動かす', () => {
    const def = SKILLS.shinenseigyo;
    expect(def.lineage).toBe('psychic');
    expect(def.rarity).toBe(2);
    expect(def.target).toBe('pitcher');
    expect(def.modifier).toEqual({ control: 0.2 });
    expect(def.charges).toBeUndefined(); // 常設
  });

  it('ザゼン はトレードオフ（制球は上だが球速が落ちる）', () => {
    const def = SKILLS.zazen;
    expect(def.rarity).toBe(2);
    expect(def.target).toBe('pitcher');
    expect(def.modifier?.control).toBeGreaterThan(SKILLS.shinenseigyo.modifier!.control!);
    expect(def.modifier?.speed).toBeLessThan(0);
  });

  /** F-26-7の配分方針：同じ軸に2枚置くとき、どちらかが上位互換になってはいけない */
  it('どちらも上位互換にならない（片方は制球が低いぶん代償が無い）', () => {
    expect(SKILLS.shinenseigyo.modifier?.speed).toBeUndefined();
    expect(SKILLS.zazen.modifier?.speed).toBeLessThan(0);
  });

  it('ムシン は★4のデュオで、前提はその2枚（同系統・投手専用）', () => {
    const def = SKILLS.mushin;
    expect(def.rarity).toBe(DUO_RARITY);
    expect(def.target).toBe('pitcher');
    expect(def.lineage).toBe('psychic');
    expect(def.requires).toEqual(['shinenseigyo', 'zazen']);
    for (const req of def.requires!) expect(SKILLS[req].lineage).toBe('psychic');
  });

  it('ザゼン の球速の代償はS-40の持ち味まで動かしうる（同じ経路で効く）', () => {
    const base = { speed: 0.7, breakLeft: 0.5, breakRight: 0.5, fork: 0.5 };
    expect(cpuPitcherStyle(base)).toBe('power');
    const withZazen = { ...base, speed: base.speed + SKILLS.zazen.modifier!.speed! };
    expect(cpuPitcherStyle(withZazen)).not.toBe('power');
  });

  it('3枚とも投手にだけ付けられる（野手に配って死に札にしない）', () => {
    const roster = createTeamRoster(TEST_TEAM);
    const fielder = roster.lineup.find((id) => !roster.players[id].pitching)!;
    for (const id of ['shinenseigyo', 'zazen', 'mushin'] as const) {
      expect(grantSkill(roster, fielder, id).ok, id).toBe(false);
    }
    expect(grantSkill(roster, roster.pitcher, 'shinenseigyo').ok).toBe(true);
  });

  it('制球の札を積むほどCPUの狙いは縁の内側へ寄る（単調）', () => {
    const { roster, pitcher } = rosterWithStarter();
    let current = roster;
    let prev = Infinity;
    for (const id of ['shinenseigyo', 'zazen'] as const) {
      const control = pitcherControl(effectivePitching(current, pitcher)!.era);
      const target = Math.abs(
        chooseCpuPitchPlan({ balls: 0, strikes: 2 }, 'balanced', control).targetX,
      );
      expect(target).toBeLessThanOrEqual(prev);
      prev = target;
      current = grantSkill(current, pitcher, id).roster;
    }
  });
});

// ============================================================
describe('制球という1つの軸が、投げる側によって違う場所に出る', () => {
  /**
   * **同じ出どころ（ERA）から、CPUは「狙いのズレ」、人間は「狙える幅」を受け取る。**
   * 片方だけ効くと「制球スキルを取ったのに自分が投げると何も起きない」＝⑧が禁じる
   * 死に札になる（このセッションで人間側の出口を作った理由）。
   */
  it('同じスキルが、CPUの狙いと人間の効き幅の両方を動かす', () => {
    const { roster, pitcher } = rosterWithStarter();
    const granted = grantSkill(roster, pitcher, 'shinenseigyo').roster;

    const cpuBefore = Math.abs(
      chooseCpuPitchPlan(
        { balls: 0, strikes: 2 },
        'balanced',
        pitcherControl(effectivePitching(roster, pitcher)!.era),
      ).targetX,
    );
    const cpuAfter = Math.abs(
      chooseCpuPitchPlan(
        { balls: 0, strikes: 2 },
        'balanced',
        pitcherControl(effectivePitching(granted, pitcher)!.era),
      ).targetX,
    );
    expect(cpuAfter).toBeLessThan(cpuBefore); // 縁の内側へ寄る

    const humanBefore = courseReleaseVxFor(controlBonusOf(roster, pitcher));
    const humanAfter = courseReleaseVxFor(controlBonusOf(granted, pitcher));
    expect(humanAfter).toBeGreaterThan(humanBefore); // 狙える幅が広がる
  });

  it('疲労も同じ定数で両方へ効く（重さが2か所に分かれない）', () => {
    const control = 0.6;
    expect(fatiguedControl(control, 1)).toBeCloseTo(control - FATIGUE_CONTROL_LOSS, 10);
    expect(courseReleaseVxFor(0, 1)).toBeCloseTo(
      COURSE_RELEASE_VX - COURSE_VX_PER_CONTROL * FATIGUE_CONTROL_LOSS,
      10,
    );
  });

  it('CPUの球にはコース入力の幅が関係しない（リリース位置で狙うため）', () => {
    // `chooseCpuPitchPlan` は制球しか受け取らない＝人間側の定数を変えても狙いは動かない
    const plan = chooseCpuPitchPlan({ balls: 0, strikes: 2 }, 'balanced', NEUTRAL_RATING);
    expect(plan.targetX).toBeCloseTo(
      chooseCpuPitchPlan({ balls: 0, strikes: 2 }, 'balanced', 0.5).targetX,
      10,
    );
  });
});
