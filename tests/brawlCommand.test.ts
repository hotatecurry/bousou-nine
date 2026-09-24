/**
 * 乱闘v3のコマンド入力（ストII準拠。フェーズXX-72）。1フレーム＝1/60秒の時計で、
 * 波動・竜巻・昇龍・溜め・一回転・連打・ダッシュを判定する。
 */
import { describe, expect, it } from 'vitest';
import {
  type FrameInput,
  type InputHistory,
  type MotionId,
  CHARGE_FRAMES,
  MASH_PRESSES,
  MOTION_TAIL,
  MOTION_SEQUENCE,
  NEUTRAL_INPUT,
  consumeInput,
  createInputHistory,
  detectMotion,
  motionNotation,
  numpadOf,
  stepInput,
} from '../src/core/brawlCommand';

type Step = Partial<FrameInput>;

/** 入力の列を1フレームずつ流す（`facing` は前が +x の打者側） */
function feed(steps: readonly Step[], facing: 1 | -1 = 1, h: InputHistory = createInputHistory()): InputHistory {
  let out = h;
  for (const st of steps) out = stepInput(out, { ...NEUTRAL_INPUT, ...st }, facing).history;
  return out;
}

const down: Step = { y: -1 };
const downFwd: Step = { y: -1, x: 1 };
const fwd: Step = { x: 1 };
const back: Step = { x: -1 };
const downBack: Step = { y: -1, x: -1 };
const up: Step = { y: 1 };

describe('テンキー表記', () => {
  it('向きで前後が入れ替わる（画面右の投手は ← が前）', () => {
    expect(numpadOf(1, 0, 1)).toBe(6);
    expect(numpadOf(1, 0, -1)).toBe(4);
    expect(numpadOf(-1, -1, -1)).toBe(3);
    expect(numpadOf(0, 1, 1)).toBe(8);
  });
});

describe('コマンドの判定', () => {
  it('波動（↓↘→）', () => {
    expect(detectMotion(feed([down, downFwd, fwd]), 'qcf')).toBe(true);
    // 途中を飛ばすと出ない（↓→）
    expect(detectMotion(feed([down, {}, fwd]), 'qcf')).toBe(false);
  });

  it('波動は画面右の投手なら ↓↙← で出る（向きで読み替える）', () => {
    expect(detectMotion(feed([down, downBack, back], -1), 'qcf')).toBe(true);
    expect(detectMotion(feed([down, downFwd, fwd], -1), 'qcf')).toBe(false);
  });

  it('竜巻（↓↙←）', () => {
    expect(detectMotion(feed([down, downBack, back]), 'qcb')).toBe(true);
  });

  it('昇龍（→↓↘）', () => {
    expect(detectMotion(feed([fwd, down, downFwd]), 'dp')).toBe(true);
    expect(detectMotion(feed([down, downFwd]), 'dp')).toBe(false);
  });

  it('受付時間を過ぎたコマンドは出ない', () => {
    const slow = [down, ...Array(30).fill(down), downFwd, fwd];
    // ↓を押しっぱなしで長く待っても、最後に↓へ入った時刻は古い＝窓の外
    expect(detectMotion(feed([down, ...Array(40).fill({}), downFwd, fwd]), 'qcf')).toBe(false);
    expect(detectMotion(feed(slow), 'qcf')).toBe(true);
  });

  it('溜め（後ろを溜めて前）。溜めが足りなければ出ない', () => {
    expect(detectMotion(feed([...Array(CHARGE_FRAMES).fill(back), fwd]), 'chargeBF')).toBe(true);
    expect(detectMotion(feed([...Array(CHARGE_FRAMES - 10).fill(back), fwd]), 'chargeBF')).toBe(false);
    // キーボードでは←を離してから→を押すまでにニュートラルを挟む＝それでも出る
    expect(detectMotion(feed([...Array(CHARGE_FRAMES).fill(back), {}, {}, fwd]), 'chargeBF')).toBe(true);
    // 斜め後ろ下でも溜まる
    expect(detectMotion(feed([...Array(CHARGE_FRAMES).fill(downBack), fwd]), 'chargeBF')).toBe(true);
  });

  it('下溜め→上', () => {
    expect(detectMotion(feed([...Array(CHARGE_FRAMES).fill(down), up]), 'chargeDU')).toBe(true);
  });

  it('一回転（上下左右を順に）。どちら回りでもよい', () => {
    expect(detectMotion(feed([fwd, down, back, up]), 'spin')).toBe(true);
    expect(detectMotion(feed([back, down, fwd, up]), 'spin')).toBe(true);
    expect(detectMotion(feed([fwd, down, back]), 'spin')).toBe(false);
  });

  it('連打（受付の窓の中で同じボタンを4回）', () => {
    const presses: Step[] = [];
    for (let i = 0; i < MASH_PRESSES; i++) presses.push({ p: true }, {});
    expect(detectMotion(feed(presses), 'mash', 'p')).toBe(true);
    expect(detectMotion(feed(presses.slice(0, -2)), 'mash', 'p')).toBe(false);
  });

  it('ダッシュ（→ ニュートラル →）', () => {
    expect(detectMotion(feed([fwd, {}, fwd]), 'dashF')).toBe(true);
    expect(detectMotion(feed([fwd, fwd]), 'dashF')).toBe(false);
    expect(detectMotion(feed([back, {}, back]), 'dashB')).toBe(true);
  });

  it('成立したコマンドは使ったら消える（同じ入力で2回出ない）', () => {
    const h = feed([down, downFwd, fwd]);
    expect(detectMotion(h, 'qcf')).toBe(true);
    expect(detectMotion(consumeInput(h), 'qcf')).toBe(false);
  });

  it('押した瞬間だけを「押した」と返す（押しっぱなしは1回）', () => {
    let h = createInputHistory();
    const a = stepInput(h, { ...NEUTRAL_INPUT, p: true }, 1);
    h = a.history;
    const b = stepInput(h, { ...NEUTRAL_INPUT, p: true }, 1);
    expect(a.pressed.p).toBe(true);
    expect(b.pressed.p).toBe(false);
  });
});

describe('表示', () => {
  it('表示は判定と同じ数列から起こす（押す向きで出す）', () => {
    const ids: MotionId[] = ['qcf', 'qcb', 'dp'];
    for (const id of ids) expect(motionNotation(id, 1).length).toBe(MOTION_SEQUENCE[id].length);
    expect(motionNotation('qcf', 1)).toBe('↓↘→');
    expect(motionNotation('qcf', -1)).toBe('↓↙←');
    expect(motionNotation('chargeBF', 1)).toBe('←溜め→');
    expect(motionNotation('chargeBF', -1)).toBe('→溜め←');
    expect(motionNotation('mash', 1)).toBe('連打');
  });
});

describe('キーボードの猶予（XX-72 の実機で分かった）', () => {
  it('最後の方向を離してからボタンを押しても、数フレーム以内なら出る（↓↘→ と叩いてから押す）', () => {
    const h = feed([down, down, downFwd, downFwd, fwd, fwd, {}, {}, {}]);
    expect(detectMotion(h, 'qcf')).toBe(true);
  });

  it('離してから長く待つと出ない（猶予は MOTION_TAIL フレームまで）', () => {
    const h = feed([down, downFwd, fwd, ...Array(MOTION_TAIL + 2).fill({})]);
    expect(detectMotion(h, 'qcf')).toBe(false);
  });

  it('昇龍も同じ（→↓↘ と叩いてから押す）', () => {
    expect(detectMotion(feed([fwd, fwd, down, down, downFwd, downFwd, {}, {}]), 'dp')).toBe(true);
  });
});
