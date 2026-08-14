import { describe, expect, it } from 'vitest';
import {
  BATTER_STAND_X,
  BATTER_ZONE_MAX_X,
  BATTER_ZONE_MIN_X,
  LEFT_BATTER_SIDE,
  STRIKE_ZONE_HALF_WIDTH,
} from '../src/core/pitch';
import {
  GUN_AIM_HALF_RANGE,
  GUN_AIM_MOVE_SPEED,
  batterAimX,
  clampAimX,
  judgeShot,
  stepAimX,
} from '../src/core/gun';

const DT = 1 / 60;

describe('clampAimX', () => {
  it('可動範囲内はそのまま', () => {
    expect(clampAimX(1.0)).toBeCloseTo(1.0);
    expect(clampAimX(-1.0)).toBeCloseTo(-1.0);
  });

  it('可動範囲を超えたら端でクランプされる', () => {
    expect(clampAimX(GUN_AIM_HALF_RANGE + 5)).toBeCloseTo(GUN_AIM_HALF_RANGE);
    expect(clampAimX(-GUN_AIM_HALF_RANGE - 5)).toBeCloseTo(-GUN_AIM_HALF_RANGE);
  });
});

describe('stepAimX', () => {
  it('右入力で+X方向へ移動速度どおりに進む', () => {
    const next = stepAimX(0, 1, DT);
    expect(next).toBeCloseTo(GUN_AIM_MOVE_SPEED * DT);
  });

  it('左入力で-X方向へ進む', () => {
    const next = stepAimX(0, -1, DT);
    expect(next).toBeCloseTo(-GUN_AIM_MOVE_SPEED * DT);
  });

  it('無入力では動かない', () => {
    expect(stepAimX(0.5, 0, DT)).toBeCloseTo(0.5);
  });

  it('端に達したらそれ以上進まない（クランプされる）', () => {
    const atEdge = stepAimX(GUN_AIM_HALF_RANGE, 1, DT);
    expect(atEdge).toBeCloseTo(GUN_AIM_HALF_RANGE);
  });

  it('連続入力を積み重ねると等速で移動する（純粋性・決定性）', () => {
    let x = 0;
    for (let i = 0; i < 30; i++) x = stepAimX(x, 1, DT);
    expect(x).toBeCloseTo(GUN_AIM_MOVE_SPEED * DT * 30);
  });
});

describe('judgeShot: 命中・見逃し・外れの判定', () => {
  it('打者ゾーン内は必中（死球扱い）', () => {
    // 既定の右打者は三塁側（-X）に立つ（フェーズBB-49）
    expect(judgeShot(-BATTER_ZONE_MIN_X)).toBe('hitByPitch');
    expect(judgeShot(-BATTER_ZONE_MAX_X)).toBe('hitByPitch');
    expect(judgeShot(-(BATTER_ZONE_MIN_X + BATTER_ZONE_MAX_X) / 2)).toBe('hitByPitch');
  });

  it('ストライクゾーン内はストライク（見逃し）', () => {
    expect(judgeShot(0)).toBe('strike');
    expect(judgeShot(STRIKE_ZONE_HALF_WIDTH)).toBe('strike');
    expect(judgeShot(-STRIKE_ZONE_HALF_WIDTH)).toBe('strike');
  });

  it('ゾーンの狭間（ストライクゾーン外・打者ゾーン手前）はボール', () => {
    const between = (STRIKE_ZONE_HALF_WIDTH + BATTER_ZONE_MIN_X) / 2;
    expect(judgeShot(between)).toBe('ball');
  });

  it('打者ゾーンより外側（大きく外した）もボール', () => {
    expect(judgeShot(BATTER_ZONE_MAX_X + 1)).toBe('ball');
    expect(judgeShot(-3)).toBe('ball');
  });

  it('乱数なしの純関数（同じ入力は常に同じ結果）', () => {
    const results = new Set(
      Array.from({ length: 20 }, () => judgeShot((BATTER_ZONE_MIN_X + BATTER_ZONE_MAX_X) / 2)),
    );
    expect(results.size).toBe(1);
  });
});

describe('judgeShot: 打席の左右（フェーズB-9）', () => {
  it('左打者には命中ゾーンが反対側へ移る（同じ照準では当たらない）', () => {
    expect(judgeShot(-BATTER_STAND_X, LEFT_BATTER_SIDE)).toBe('ball');
    expect(judgeShot(BATTER_STAND_X, LEFT_BATTER_SIDE)).toBe('hitByPitch');
  });

  it('照準の可動範囲は左打席にも届く（狙えない打者を作らない）', () => {
    expect(GUN_AIM_HALF_RANGE).toBeGreaterThan(BATTER_ZONE_MAX_X);
    expect(judgeShot(clampAimX(BATTER_ZONE_MAX_X), LEFT_BATTER_SIDE)).toBe('hitByPitch');
  });

  it('外したときの扱いは打席の左右で変わらない（通常の投球判定と同じ）', () => {
    expect(judgeShot(0, LEFT_BATTER_SIDE)).toBe('strike');
    expect(judgeShot((STRIKE_ZONE_HALF_WIDTH + BATTER_ZONE_MIN_X) / 2, LEFT_BATTER_SIDE)).toBe(
      'ball',
    );
  });
});

// ---- CPUの狙い（フェーズF-26-2） ----
//
// CPU投手は照準を動かさず、構えた時点で打者に狙いを定めている（＝必中）。
// だからこそ予兆（GUN_TELEGRAPH_SEC）とセットになる（CLAUDE.md ⑧）。

describe('batterAimX: CPUが狙う位置', () => {
  it('右打者・左打者のどちらにも必ず当たる', () => {
    expect(judgeShot(batterAimX())).toBe('hitByPitch');
    expect(judgeShot(batterAimX(LEFT_BATTER_SIDE), LEFT_BATTER_SIDE)).toBe('hitByPitch');
  });

  it('打席の左右で狙いが鏡像になる（左打者には反対側を狙う）', () => {
    expect(batterAimX(LEFT_BATTER_SIDE)).toBeCloseTo(-batterAimX());
  });

  it('立ち位置の定数から求まる（見た目の打者の真ん中を狙う）', () => {
    // 右打者は三塁側（-X）なので狙いも -X（フェーズBB-49）
    expect(batterAimX()).toBeCloseTo(-BATTER_STAND_X);
    expect(Math.abs(batterAimX())).toBeCloseTo(BATTER_STAND_X);
  });

  it('照準の可動範囲の内側にある（人間が同じ位置へ合わせることもできる）', () => {
    expect(Math.abs(batterAimX())).toBeLessThanOrEqual(GUN_AIM_HALF_RANGE);
  });

  it('狙いを外した側の打席では当たらない（打者が入れ替われば合わせ直しが要る）', () => {
    expect(judgeShot(batterAimX(), LEFT_BATTER_SIDE)).not.toBe('hitByPitch');
  });
});
