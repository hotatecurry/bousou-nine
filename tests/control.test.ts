/**
 * フェーズT-41：配球のコースに持ち味＝**制球**。
 *
 * 着手前の実態：S-40 で「何を投げるか」には持ち味が乗ったが、**どこへ投げるかは
 * 全投手が同じ**だった（`chooseCpuPitchPlan` はカウントだけを見る）＝制球の良い投手も
 * 悪い投手もまったく同じ隅を、まったく同じ精度で突いていた。S-40 が
 * 「今回は意図的に触っていない」として明示的に残した最後の1つ。
 *
 * 出どころは **ERA**（D-18でHUDに出して以来「判定に効かない唯一の項目」だった96人ぶんの
 * 数値）＝**新しい能力値は増やしていない**（O-35がFでやったのと同じ埋め方）。
 *
 * ここで固定するのは6つ。
 * 1. **制球0.5（名鑑の中央値）はT-41の前と完全に同じ狙い**（B-8以来の基準線。
 *    既存1296件が1件も変わっていない）
 * 2. **効き方は「狙いが外へ膨らむ」1つだけ**（ズレの仕組みを持たない＝開ループのまま）
 * 3. **打席から離れれば、どんな荒れ球でも必ず避けられる**（設計不変条件。
 *    回避手段が実在することが、死球を理不尽にしない条件）
 * 4. **置きにいく球（3ボール以降）は誰が投げても真ん中**＝待った側への報酬
 * 5. **曲線は計測が決めた**（`npm run balance:control` の3段目。P-37が
 *    `CPU_BREAK_STEER_SEC` を「頭打ち0人の最大値」で決めたのとまったく同じ基準）
 * 6. **持ち味（S-40）とは別の軸**＝狙う位置は style を見ない／球速は制球を見ない
 */
import { describe, expect, it } from 'vitest';
import {
  BATTER_STANCE_RANGE,
  BATTER_ZONE_MIN_X,
  LEFT_BATTER_SIDE,
  NEUTRAL_RATING,
  RIGHT_BATTER_SIDE,
  STRIKE_ZONE_HALF_WIDTH,
  batterFrameX,
  judgePitch,
} from '../src/core/pitch';
import {
  CORNER_MARGIN,
  CPU_CONTROL_CURVE,
  CPU_CONTROL_EDGE,
  CPU_CONTROL_MAX_TARGET,
  type CpuPitcherStyle,
  chooseCpuPitchPlan,
  cpuControlSpray,
} from '../src/core/cpuPitcher';
import {
  CONTROL_ERA_BEST,
  CONTROL_ERA_WORST,
  pitcherControl,
} from '../src/core/roster';
import { TEAMS, pitcherRowPitching } from '../src/core/teams';
import type { Count } from '../src/core/rules';

/** 名鑑96人（16球団×6人）＝S-40の `balance:identity` と同じ母集団 */
const PITCHERS = TEAMS.flatMap((t) =>
  t.pitchers.map((r) => ({ name: r[0] as string, team: t.short, ...pitcherRowPitching(r) })),
);

/** 起こりうるカウント12通り */
const ALL_COUNTS: Count[] = [];
for (let balls = 0; balls <= 3; balls += 1) {
  for (let strikes = 0; strikes <= 2; strikes += 1) ALL_COUNTS.push({ balls, strikes });
}

const STYLES: CpuPitcherStyle[] = ['power', 'breaking', 'balanced'];

describe('pitcherControl（ERA→制球。判定に効かない唯一の項目だったERAの接続）', () => {
  it('ERAが小さいほど制球が良い（単調減少）', () => {
    const eras = [2.0, 2.5, 3.0, 3.5, 4.0];
    for (let i = 1; i < eras.length; i += 1) {
      expect(pitcherControl(eras[i])).toBeLessThan(pitcherControl(eras[i - 1]));
    }
  });

  it('換算の両端でちょうど 1.0 / 0.0 になり、外側はクランプされる', () => {
    expect(pitcherControl(CONTROL_ERA_BEST)).toBeCloseTo(1, 10);
    expect(pitcherControl(CONTROL_ERA_WORST)).toBeCloseTo(0, 10);
    // 名鑑の最小1.95・最大4.30は換算の外側にあるので、はみ出さずに止まる
    expect(pitcherControl(1.0)).toBe(1);
    expect(pitcherControl(9.99)).toBe(0);
  });

  it('名鑑96人の中央値がちょうど基準値0.5に乗る（B-8以来の「基準値0.5＝従来の定数」）', () => {
    const sorted = PITCHERS.map((p) => pitcherControl(p.era)).sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length / 2)]).toBeCloseTo(NEUTRAL_RATING, 2);
  });

  it('名鑑96人が制球の全域に散らばる（＝規則が死んでいない）', () => {
    const values = PITCHERS.map((p) => pitcherControl(p.era));
    expect(Math.min(...values)).toBeLessThan(0.05);
    expect(Math.max(...values)).toBeGreaterThan(0.95);
    // 上下に偏っていない（どちらの側にも実在する）
    expect(values.filter((v) => v > 0.7).length).toBeGreaterThan(5);
    expect(values.filter((v) => v < 0.3).length).toBeGreaterThan(5);
  });
});

describe('cpuControlSpray（狙いが外へ膨らむ幅）', () => {
  it('制球0.5（名鑑の中央値）では膨らまない＝T-41の前と完全に同じ', () => {
    expect(cpuControlSpray(NEUTRAL_RATING)).toBeCloseTo(0, 10);
  });

  it('制球が良いほど内へ、悪いほど外へ（単調増加）', () => {
    const controls = [1, 0.75, 0.5, 0.25, 0];
    for (let i = 1; i < controls.length; i += 1) {
      expect(cpuControlSpray(controls[i])).toBeGreaterThan(cpuControlSpray(controls[i - 1]));
    }
    expect(cpuControlSpray(1)).toBeLessThan(0);
    expect(cpuControlSpray(0)).toBeGreaterThan(0);
  });

  it('制球1.0では決め球がゾーンの内側に入る（＝制球の値打ちが実在する）', () => {
    const putaway = chooseCpuPitchPlan({ balls: 0, strikes: 2 }, 'balanced', 1).targetX;
    expect(Math.abs(putaway)).toBeLessThan(STRIKE_ZONE_HALF_WIDTH);
    expect(judgePitch(putaway)).toBe('strike');
    // 縁ちょうどにしないのは丸め誤差でストライク/ボールが裏返らないため
    expect(STRIKE_ZONE_HALF_WIDTH - Math.abs(putaway)).toBeCloseTo(-CPU_CONTROL_EDGE, 10);
  });

  it('範囲外の制球を渡してもクランプされる（呼び出し側の事故で暴走しない）', () => {
    expect(cpuControlSpray(2)).toBe(cpuControlSpray(1));
    expect(cpuControlSpray(-1)).toBe(cpuControlSpray(0));
  });
});

describe('chooseCpuPitchPlan：制球を渡さなければT-41の前と完全に同じ（基準線）', () => {
  it('既定の引数は制球0.5と同じ狙いを返す', () => {
    for (const count of ALL_COUNTS) {
      for (const style of STYLES) {
        expect(chooseCpuPitchPlan(count, style).targetX).toBe(
          chooseCpuPitchPlan(count, style, NEUTRAL_RATING).targetX,
        );
      }
    }
  });

  it('制球0.5の狙いは「隅の内側／隅の外側」の梯子そのもの（TT-68で通常も隅の1つ内側へ）', () => {
    const normal = chooseCpuPitchPlan({ balls: 0, strikes: 0 }, 'balanced', NEUTRAL_RATING);
    expect(Math.abs(normal.targetX)).toBeCloseTo(STRIKE_ZONE_HALF_WIDTH - CORNER_MARGIN, 10);
    const putaway = chooseCpuPitchPlan({ balls: 0, strikes: 2 }, 'balanced', NEUTRAL_RATING);
    expect(Math.abs(putaway.targetX)).toBeCloseTo(STRIKE_ZONE_HALF_WIDTH + CORNER_MARGIN, 10);
    // 通常と決め球はゾーンを挟んで対称＝**新しい定数を持たない1刻みの梯子**（TT-68）
    expect(STRIKE_ZONE_HALF_WIDTH - Math.abs(normal.targetX)).toBeCloseTo(
      Math.abs(putaway.targetX) - STRIKE_ZONE_HALF_WIDTH,
      10,
    );
  });

  it('制球が中央値以上の投手は「通常の球」も同じ狙い（内へ寄せて甘くしない）', () => {
    for (const control of [0.5, 0.75, 1]) {
      const plan = chooseCpuPitchPlan({ balls: 0, strikes: 0 }, 'balanced', control);
      expect(Math.abs(plan.targetX)).toBeCloseTo(STRIKE_ZONE_HALF_WIDTH - CORNER_MARGIN, 10);
    }
  });
});

describe('chooseCpuPitchPlan：制球が動かすのは狙いだけ（S-40の持ち味とは別の軸）', () => {
  it('狙う位置は持ち味（style）を見ない', () => {
    for (const count of ALL_COUNTS) {
      for (const control of [0, 0.25, 0.5, 0.75, 1]) {
        const base = chooseCpuPitchPlan(count, 'balanced', control).targetX;
        for (const style of STYLES) {
          expect(chooseCpuPitchPlan(count, style, control).targetX).toBe(base);
        }
      }
    }
  });

  it('球速（決め球の緩急）は制球を見ない', () => {
    for (const count of ALL_COUNTS) {
      for (const style of STYLES) {
        const base = chooseCpuPitchPlan(count, style, NEUTRAL_RATING).speed;
        for (const control of [0, 0.25, 0.75, 1]) {
          expect(chooseCpuPitchPlan(count, style, control).speed).toBe(base);
        }
      }
    }
  });

  it('内外角を交互に突く周期（ボール数の偶奇）は制球によらない', () => {
    for (const control of [0, 0.5, 1]) {
      const even = chooseCpuPitchPlan({ balls: 0, strikes: 0 }, 'balanced', control);
      const odd = chooseCpuPitchPlan({ balls: 1, strikes: 0 }, 'balanced', control);
      expect(Math.sign(odd.targetX)).toBe(-Math.sign(even.targetX));
    }
  });
});

describe('置きにいく球は誰が投げても真ん中（待った側への報酬）', () => {
  it('3ボール以降（2ストライク未満）は制球によらずど真ん中', () => {
    for (const control of [0, 0.25, 0.5, 0.75, 1]) {
      for (const strikes of [0, 1]) {
        expect(chooseCpuPitchPlan({ balls: 3, strikes }, 'balanced', control).targetX).toBe(0);
      }
    }
  });

  it('いちばん荒れた投手でも、3ボールからの2球はストライクになる（＝置きにくる）', () => {
    for (const strikes of [0, 1]) {
      const plan = chooseCpuPitchPlan({ balls: 3, strikes }, 'balanced', 0);
      expect(judgePitch(plan.targetX)).toBe('strike');
    }
  });
});

describe('設計不変条件：打者に避ける手が実在する（O-36の立ち位置）', () => {
  it('打席から離れれば、名鑑96人のどの投手・どのカウント・どちらの打席でも死球にならない', () => {
    for (const p of PITCHERS) {
      const control = pitcherControl(p.era);
      for (const count of ALL_COUNTS) {
        const { targetX } = chooseCpuPitchPlan(count, 'balanced', control);
        for (const side of [RIGHT_BATTER_SIDE, LEFT_BATTER_SIDE] as const) {
          expect(judgePitch(targetX, side, BATTER_STANCE_RANGE)).not.toBe('hitByPitch');
        }
      }
    }
  });

  it('狙いは上限（死球ゾーンの手前の縁＋可動幅の半分）を越えない', () => {
    for (const control of [0, 0.1, 0.5, 1]) {
      for (const count of ALL_COUNTS) {
        const { targetX } = chooseCpuPitchPlan(count, 'balanced', control);
        expect(Math.abs(targetX)).toBeLessThanOrEqual(CPU_CONTROL_MAX_TARGET + 1e-9);
      }
    }
    expect(CPU_CONTROL_MAX_TARGET).toBeLessThan(BATTER_ZONE_MIN_X + BATTER_STANCE_RANGE);
  });

  it('どれだけ荒れてもストライクゾーンの球で死球にはならない（O-36の不変条件の延長）', () => {
    for (const control of [0, 0.5, 1]) {
      for (const count of ALL_COUNTS) {
        const { targetX } = chooseCpuPitchPlan(count, 'balanced', control);
        if (Math.abs(targetX) > STRIKE_ZONE_HALF_WIDTH) continue;
        for (const stance of [-BATTER_STANCE_RANGE, 0, BATTER_STANCE_RANGE]) {
          for (const side of [RIGHT_BATTER_SIDE, LEFT_BATTER_SIDE] as const) {
            expect(judgePitch(targetX, side, stance)).toBe('strike');
          }
        }
      }
    }
  });

  it('プレートに寄ると死球が増える＝O-36の立ち位置の選択に重みが増す', () => {
    const hitAt = (stance: number) =>
      PITCHERS.filter((p) =>
        ALL_COUNTS.some(
          (count) =>
            judgePitch(
              chooseCpuPitchPlan(count, 'balanced', pitcherControl(p.era)).targetX,
              RIGHT_BATTER_SIDE,
              stance,
            ) === 'hitByPitch',
        ),
      ).length;
    expect(hitAt(BATTER_STANCE_RANGE)).toBe(0);
    expect(hitAt(0)).toBeGreaterThan(0);
    expect(hitAt(-BATTER_STANCE_RANGE)).toBeGreaterThan(hitAt(0));
  });
});

describe('曲線（CPU_CONTROL_CURVE）は計測が決めた（npm run balance:control の3段目）', () => {
  const worstPutaway = (curve: number) =>
    Math.min(
      STRIKE_ZONE_HALF_WIDTH + 0.05 + cpuControlSpray(0, curve),
      CPU_CONTROL_MAX_TARGET,
    );

  it('採用した曲線では、いちばん荒れた投手でも上限に頭打ちにならない（P-37と同じ基準）', () => {
    expect(worstPutaway(CPU_CONTROL_CURVE)).toBeLessThan(CPU_CONTROL_MAX_TARGET);
  });

  it('これより急な曲線は上限に張り付く＝荒れの差がそこで消える', () => {
    expect(worstPutaway(CPU_CONTROL_CURVE + 0.5)).toBeCloseTo(CPU_CONTROL_MAX_TARGET, 10);
  });

  it('これより緩い曲線では死球ゾーンに誰も届かない＝ユーザー判断が死文になる', () => {
    const reaches = (curve: number) =>
      PITCHERS.some((p) => {
        const spray = cpuControlSpray(pitcherControl(p.era), curve);
        const target = Math.min(
          STRIKE_ZONE_HALF_WIDTH + 0.05 + spray,
          CPU_CONTROL_MAX_TARGET,
        );
        // target は「体側の隅からの距離」＝打者ローカル。ワールドへ読み替えてから判定する
        return judgePitch(batterFrameX(target, RIGHT_BATTER_SIDE), RIGHT_BATTER_SIDE, 0) ===
          'hitByPitch';
      });
    expect(reaches(CPU_CONTROL_CURVE)).toBe(true);
    // **1段緩い曲線では届かない**＝採用値が「届く最小」であることの確認。
    // フェーズRR-66で打者が本塁へ寄った（死球ゾーンが 0.9〜1.7 → 0.65〜1.45）ぶん
    // **同じ荒れでも体に近づく**ので、曲線は 3→2 で足りるようになった（上限も
    // `BATTER_ZONE_MIN_X` から導出されるので一緒に下がる）。
    expect(reaches(CPU_CONTROL_CURVE - 1)).toBe(false);
  });

  it('死球ゾーンへ届くのは「例外」の範囲にとどまる（名鑑96人のうち一握り）', () => {
    const count = PITCHERS.filter((p) =>
      ALL_COUNTS.some(
        (c) =>
          judgePitch(
            chooseCpuPitchPlan(c, 'balanced', pitcherControl(p.era)).targetX,
            RIGHT_BATTER_SIDE,
            0,
          ) === 'hitByPitch',
      ),
    ).length;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(10);
  });
});

describe('見逃し続けたときの帰結が投手で分かれる（T-41の前は全員が四球だった）', () => {
  /** 1球も振らない打者。決定的なので1打席回せば決まる */
  const takeEverything = (control: number, side = RIGHT_BATTER_SIDE, stance = 0) => {
    const count: Count = { balls: 0, strikes: 0 };
    for (let pitch = 1; pitch <= 12; pitch += 1) {
      const { targetX } = chooseCpuPitchPlan(count, 'balanced', control);
      const call = judgePitch(targetX, side, stance);
      if (call === 'hitByPitch') return 'hitByPitch';
      if (call === 'strike') {
        count.strikes += 1;
        if (count.strikes >= 3) return 'strikeout';
      } else {
        count.balls += 1;
        if (count.balls >= 4) return 'walk';
      }
    }
    return 'walk';
  };

  it('制球の良い投手は見逃し続ける打者から三振を取れる', () => {
    expect(takeEverything(1)).toBe('strikeout');
    expect(takeEverything(0.75)).toBe('strikeout');
  });

  it('中央値の投手は従来どおり四球（＝基準線が動いていない）', () => {
    expect(takeEverything(NEUTRAL_RATING)).toBe('walk');
  });

  it('名鑑96人が三振と四球の両方に分かれる（規則が死んでいない）', () => {
    const outcomes = PITCHERS.map((p) => takeEverything(pitcherControl(p.era)));
    expect(outcomes.filter((o) => o === 'strikeout').length).toBeGreaterThan(0);
    expect(outcomes.filter((o) => o === 'walk').length).toBeGreaterThan(0);
  });

  it('打席から離れて立てば、96人の誰からも死球を受けない', () => {
    for (const p of PITCHERS) {
      for (const side of [RIGHT_BATTER_SIDE, LEFT_BATTER_SIDE] as const) {
        expect(takeEverything(pitcherControl(p.era), side, BATTER_STANCE_RANGE)).not.toBe(
          'hitByPitch',
        );
      }
    }
  });
});

describe('左打者は鏡像（B-9の符号1つに畳む整理がそのまま効く）', () => {
  it('狙いの絶対値は打席の左右によらない（狙うのはワールドXなので当然）', () => {
    for (const control of [0, 0.5, 1]) {
      for (const count of ALL_COUNTS) {
        const plan = chooseCpuPitchPlan(count, 'balanced', control);
        // 打者ローカルへ畳むと符号だけが入れ替わる
        expect(Math.abs(plan.targetX * RIGHT_BATTER_SIDE)).toBeCloseTo(
          Math.abs(plan.targetX * LEFT_BATTER_SIDE),
          10,
        );
      }
    }
  });

  it('体に来るカウントが左右で入れ替わる（内角の向きが逆なので）', () => {
    // いちばん荒れた投手の決め球。**左打者**にはボール数が偶数のときに、
    // 右打者には奇数のときに内角へ来る（cornerSign は打席の左右を見ない＝ワールドの
    // 符号で決まるので、どちらの体に来るかは打席の位置で決まる。フェーズBB-49）
    const even = chooseCpuPitchPlan({ balls: 0, strikes: 2 }, 'balanced', 0).targetX;
    const odd = chooseCpuPitchPlan({ balls: 1, strikes: 2 }, 'balanced', 0).targetX;
    expect(judgePitch(even, LEFT_BATTER_SIDE, 0)).toBe('hitByPitch');
    expect(judgePitch(even, RIGHT_BATTER_SIDE, 0)).toBe('ball');
    expect(judgePitch(odd, RIGHT_BATTER_SIDE, 0)).toBe('hitByPitch');
    expect(judgePitch(odd, LEFT_BATTER_SIDE, 0)).toBe('ball');
  });
});
