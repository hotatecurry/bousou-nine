/**
 * シード付き擬似乱数（フェーズF-26-1）。**ローグライトのスキル抽選だけが使う**。
 *
 * このゲームの `core/*.ts` は一貫して「乱数は一切使わない＝判定はすべて決定的」で
 * 書かれている（`brawl.ts` / `gun.ts` / `cpuPitcher.ts` の冒頭コメント）。ローグライトは
 * 乱数が本体なので、この方針とどう両立させるかを最初に決める必要があった。
 *
 * 答えは **「乱数を引くのは抽選だけ。判定は今までどおり決定的なまま」**（CLAUDE.md ⑧）：
 * - 打撃・投球・守備・走塁・乱闘の判定は、**スキルが付いた後のパラメータ**で今までどおり
 *   動く。同じ状況で同じ操作をすれば必ず同じ結果になる、という手触りは変わらない。
 * - 納得できないのは「何が候補に出たか」だけで、それはローグライトとして正しい。
 *
 * そのうえで **乱数の状態も値として持ち回る**（グローバルな `Math.random` は使わない）。
 * 状態は `GameContext.rngState` にあり、引くたびに次の状態が返る純粋関数なので：
 * - **シードを固定すれば試合まるごと再現できる**（テストは従来どおり決定的に書ける）。
 * - 「いつ誰が何回引いたか」が状態遷移として追える（Math.random だと追えない）。
 *
 * アルゴリズムは mulberry32（32bit・状態1ワード・分布は用途に対して十分）。暗号用途では
 * ないので強度は要らず、**状態が数値1つで済む＝そのままコンテキストに置ける**ことを取った。
 */

/** 乱数の状態。数値1つなので、そのまま `GameContext` に持てて構造的複製もいらない */
export type RngState = number;

/** 引いた結果と、次に引くための状態。**状態を書き換えず必ず新しい状態を返す**（純粋関数） */
export interface RngDraw {
  /** 0 以上 1 未満 */
  value: number;
  state: RngState;
}

/** 既定のシード。テストと「シード未指定の起動」がここに落ちる（＝毎回同じ試合になる） */
export const DEFAULT_SEED = 20260727;

/**
 * シードから初期状態を作る。0 は mulberry32 が縮退しうるので避け、32bit に丸める
 * （`Date.now()` のような大きい値をそのまま渡せるようにするため）。
 */
export function createRngState(seed: number): RngState {
  const normalized = Math.floor(Math.abs(seed)) % 0x100000000;
  return normalized === 0 ? DEFAULT_SEED : normalized;
}

/** 1つ引く（mulberry32）。 */
export function nextRng(state: RngState): RngDraw {
  let t = (state + 0x6d2b79f5) | 0;
  const nextState = t >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: ((t ^ (t >>> 14)) >>> 0) / 0x100000000, state: nextState };
}

/** 0..count-1 の整数を1つ引く。count が 0 以下なら 0 を返す（呼び出し側で止めないための保険） */
export function nextIndex(state: RngState, count: number): { index: number; state: RngState } {
  if (count <= 0) return { index: 0, state };
  const draw = nextRng(state);
  return { index: Math.min(count - 1, Math.floor(draw.value * count)), state: draw.state };
}

/**
 * 重み付きで1つ引く（レアリティの出現率に使う）。重みの合計が0以下なら先頭を返す。
 * 重みは「合計に対する比」としてのみ意味を持つので、呼び出し側で正規化しなくてよい。
 */
export function nextWeightedIndex(
  state: RngState,
  weights: readonly number[],
): { index: number; state: RngState } {
  const total = weights.reduce((sum, w) => sum + Math.max(0, w), 0);
  if (total <= 0) return { index: 0, state };
  const draw = nextRng(state);
  let threshold = draw.value * total;
  for (let i = 0; i < weights.length; i += 1) {
    threshold -= Math.max(0, weights[i]);
    if (threshold < 0) return { index: i, state: draw.state };
  }
  return { index: weights.length - 1, state: draw.state };
}

/**
 * 配列から重複なく count 個引く（3択の生成に使う）。候補が足りなければあるだけ返す。
 * 元の配列は変更しない。
 */
export function sampleWithoutReplacement<T>(
  state: RngState,
  items: readonly T[],
  count: number,
): { picked: T[]; state: RngState } {
  const pool = [...items];
  const picked: T[] = [];
  let s = state;
  const n = Math.min(count, pool.length);
  for (let i = 0; i < n; i += 1) {
    const drawn = nextIndex(s, pool.length);
    s = drawn.state;
    picked.push(pool[drawn.index]);
    pool.splice(drawn.index, 1);
  }
  return { picked, state: s };
}
