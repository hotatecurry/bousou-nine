import { describe, expect, it } from 'vitest';
import {
  BALLPARKS,
  DEFAULT_BALLPARK,
  DEFAULT_BALLPARK_ID,
  FALLBACK_DOUBLE_MAX,
  FALLBACK_SINGLE_MAX,
  FENCE_ANGLE_LIMIT_DEG,
  FENCE_HEIGHT_STANDARD,
  ballparkById,
  deepestFence,
  fallbackHit,
  fenceAngleDeg,
  fenceAt,
  fenceAtPoint,
} from '../src/core/ballpark';
import { GROUND_RADIUS } from '../src/scenes/field';

const park = (id: string) => BALLPARKS.find((p) => p.id === id)!;

/** その方角の点（フェンスのすぐ内側）を作る */
function pointAt(deg: number, distance: number): { x: number; z: number } {
  const rad = (deg * Math.PI) / 180;
  return { x: distance * Math.sin(rad), z: -distance * Math.cos(rad) };
}

describe('fenceAngleDeg（打球の方角）', () => {
  it('センターが0、一塁線が+45、三塁線が-45', () => {
    expect(fenceAngleDeg(0, -100)).toBeCloseTo(0, 10);
    expect(fenceAngleDeg(70, -70)).toBeCloseTo(45, 10);
    expect(fenceAngleDeg(-70, -70)).toBeCloseTo(-45, 10);
  });

  it('ファウル地域・本塁の後ろは両翼線まで丸められる（フェンスはそこまでしか無い）', () => {
    expect(fenceAngleDeg(100, -10)).toBe(FENCE_ANGLE_LIMIT_DEG);
    expect(fenceAngleDeg(-100, -10)).toBe(-FENCE_ANGLE_LIMIT_DEG);
    expect(fenceAngleDeg(1, 50)).toBe(FENCE_ANGLE_LIMIT_DEG);
  });
});

describe('fenceAt（説明書p24-25の数値）', () => {
  it('6球場すべてで、センター・両翼が説明書の数値どおりになる', () => {
    for (const p of BALLPARKS) {
      expect(fenceAt(p, 0).distance).toBeCloseTo(p.center, 6);
      expect(fenceAt(p, FENCE_ANGLE_LIMIT_DEG).distance).toBeCloseTo(p.wing, 6);
      expect(fenceAt(p, -FENCE_ANGLE_LIMIT_DEG).distance).toBeCloseTo(p.wing, 6);
    }
  });

  it('中間（左中間・右中間）は両翼より深く中堅より浅い＝実在の球場と同じ形', () => {
    for (const p of BALLPARKS) {
      const alley = fenceAt(p, 22.5).distance;
      expect(alley).toBeGreaterThan(p.wing);
      expect(alley).toBeLessThan(p.center);
    }
  });

  it('例外区間を持たない球場は左右対称（形は2つの数値だけで決まる）', () => {
    for (const p of BALLPARKS.filter((b) => b.id !== 'fueifuei')) {
      for (const deg of [5, 15, 25, 35, 44]) {
        expect(fenceAt(p, deg).distance).toBeCloseTo(fenceAt(p, -deg).distance, 6);
        expect(fenceAt(p, deg).height).toBeCloseTo(fenceAt(p, -deg).height, 6);
      }
    }
  });

  it('6球場は狭い順に かせんじき < たからづか < ところざわ ≒ ふえいふえい < どうむ < だいそうげん', () => {
    const byCenter = [...BALLPARKS].sort((a, b) => a.center - b.center).map((p) => p.id);
    expect(byCenter[0]).toBe('kasenjiki');
    expect(byCenter[byCenter.length - 1]).toBe('daisougen');
    // 両翼でも順序が入れ替わらない＝「広い球場」「狭い球場」の印象が方角で裏返らない
    const byWing = [...BALLPARKS].sort((a, b) => a.wing - b.wing).map((p) => p.id);
    expect(byWing[0]).toBe('kasenjiki');
    expect(byWing[byWing.length - 1]).toBe('daisougen');
  });

  it('どの球場のフェンスも、描かれた地面（GROUND_RADIUS）の内側に収まる', () => {
    for (const p of BALLPARKS) {
      const outer = p.luckyZone ? p.luckyZone.outerOffset : 0;
      expect(deepestFence(p) + outer).toBeLessThan(GROUND_RADIUS);
    }
  });
});

describe('ふえいふえい（いびつな形＋高いレフトフェンス）', () => {
  const p = park('fueifuei');

  it('レフト方向のフェンスは標準よりずっと高い（レフトへのHRは至難）', () => {
    expect(fenceAt(p, -25).height).toBeGreaterThan(FENCE_HEIGHT_STANDARD * 2);
    // ライト方向は標準のまま＝高さが左右で違うことが「くせもの」の中身
    expect(fenceAt(p, 25).height).toBe(FENCE_HEIGHT_STANDARD);
  });

  it('レフト中間はライト中間より深い（左右非対称＝いびつな形）', () => {
    expect(fenceAt(p, -25).distance).toBeGreaterThan(fenceAt(p, 25).distance);
  });

  it('それでも両翼線は説明書どおり96mのまま（区間を両翼にかけていない）', () => {
    expect(fenceAt(p, -FENCE_ANGLE_LIMIT_DEG).distance).toBeCloseTo(96, 6);
    expect(fenceAt(p, -FENCE_ANGLE_LIMIT_DEG).height).toBe(FENCE_HEIGHT_STANDARD);
  });

  it('同じ高さの打球が、レフトでは越えずライトでは越える', () => {
    const height = 6; // 標準の4mより高く、レフトの壁10mより低い
    const left = fenceAt(p, -25);
    const right = fenceAt(p, 25);
    expect(height).toBeLessThan(left.height);
    expect(height).toBeGreaterThan(right.height);
  });
});

describe('たからづか（ラッキーゾーン）', () => {
  const p = park('takarazuka');

  it('ラッキーゾーンの区間は柵が低い＝ライナー性の打球でも越える', () => {
    expect(fenceAt(p, 30).height).toBeLessThan(FENCE_HEIGHT_STANDARD);
    expect(fenceAt(p, -30).height).toBeLessThan(FENCE_HEIGHT_STANDARD);
  });

  it('中堅は標準の高さ（ラッキーゾーンは両翼側だけ）', () => {
    expect(fenceAt(p, 0).height).toBe(FENCE_HEIGHT_STANDARD);
  });

  it('両翼はところざわより近い＝説明書の「少し狭い感じ」', () => {
    expect(p.wing).toBeLessThan(park('tokorozawa').wing);
  });

  it('外壁は柵の外側にあり、地面の内側に収まる（描画用の情報）', () => {
    expect(p.luckyZone).not.toBeNull();
    expect(p.luckyZone!.outerOffset).toBeGreaterThan(0);
  });

  it('ラッキーゾーンを持つのはたからづかだけ', () => {
    expect(BALLPARKS.filter((b) => b.luckyZone !== null).map((b) => b.id)).toEqual([
      'takarazuka',
    ]);
  });
});

describe('fallbackHit（拾われなかった打球の距離分類）', () => {
  it('従来の境界（75m/90m）は球場によらず同じ＝野手の定位置が変わらないから', () => {
    for (const p of BALLPARKS) {
      expect(fallbackHit(p, 0, -(FALLBACK_SINGLE_MAX - 1))).toBe('single');
      expect(fallbackHit(p, 0, -FALLBACK_SINGLE_MAX)).toBe('double');
      expect(fallbackHit(p, 0, -(FALLBACK_DOUBLE_MAX - 1))).toBe('double');
      expect(fallbackHit(p, 0, -FALLBACK_DOUBLE_MAX)).toBe('triple');
    }
  });

  it('だいそうげんだけ、奥深くまで転がるとランニングホームラン（説明書p25）', () => {
    const p = park('daisougen');
    expect(p.runningHomerDistance).not.toBeNull();
    expect(fallbackHit(p, 0, -(p.runningHomerDistance! - 1))).toBe('triple');
    expect(fallbackHit(p, 0, -p.runningHomerDistance!)).toBe('homerun');
  });

  it('ほかの5球場では同じ距離でも三塁打どまり', () => {
    const deep = park('daisougen').runningHomerDistance!;
    for (const p of BALLPARKS.filter((b) => b.runningHomerDistance === null)) {
      expect(fallbackHit(p, 0, -deep)).toBe('triple');
    }
  });

  it('ランニングホームランの境界は外野の定位置よりはるかに後ろ（＝そらしたときだけ）', () => {
    // 外野のホームポジションは約80m（fielding.ts の FIELDER_HOME_POSITIONS）
    expect(park('daisougen').runningHomerDistance!).toBeGreaterThan(80 + 30);
  });
});

describe('球場のデータ', () => {
  it('既定はところざわ（説明書「最も平均的な球場」）', () => {
    expect(DEFAULT_BALLPARK_ID).toBe('tokorozawa');
    expect(DEFAULT_BALLPARK.id).toBe('tokorozawa');
  });

  it('説明書どおり6球場ある（IDは重複しない）', () => {
    expect(BALLPARKS).toHaveLength(6);
    expect(new Set(BALLPARKS.map((p) => p.id)).size).toBe(6);
  });

  it('ballparkById は全球場を引ける／未知のIDは例外', () => {
    for (const p of BALLPARKS) expect(ballparkById(p.id)).toBe(p);
    // @ts-expect-error 未知のIDを渡したときに黙って既定へ落ちないことの確認
    expect(() => ballparkById('nonexistent')).toThrow();
  });

  it('両翼が説明書に無いのはだいそうげんだけ（そこだけこちらの数値）', () => {
    expect(BALLPARKS.filter((p) => p.wingIsOurs).map((p) => p.id)).toEqual(['daisougen']);
  });

  it('名前と紹介文は選択画面の1セルに収まる長さ（カタカナ・ひらがな）', () => {
    for (const p of BALLPARKS) {
      expect(p.name.length).toBeLessThanOrEqual(6);
      expect(p.note.length).toBeLessThanOrEqual(34);
    }
  });
});

describe('fenceAtPoint（打球物理から呼ばれる形）', () => {
  it('その地点の方角のフェンスを返す（fenceAt と一致する）', () => {
    for (const p of BALLPARKS) {
      for (const deg of [-40, -20, 0, 20, 40]) {
        const point = pointAt(deg, 50);
        expect(fenceAtPoint(p, point.x, point.z)).toEqual(fenceAt(p, deg));
      }
    }
  });
});
