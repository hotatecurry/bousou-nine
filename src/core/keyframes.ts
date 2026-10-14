/**
 * 原作の「絵の切り替え」の時間割（フェーズBBB-76）。
 *
 * テストプレイ「バットを振ってから振り切った後のアニメーション絵が全然イメージと違う」
 * 「ピッチャーが球を投げてからヒットを打つまでの間が原作と違う」。原作（ファミスタ'90）の
 * 映像を1フレームずつ測ると、投球モーションもスイングも**決まった数枚の絵を、決まった
 * フレーム数ずつ切り替えている**。ここはその時間割だけを持つ（ユーザー判断 2026-10-07：
 * **原作の絵を切り替える＝コマ送り**。絵の間を補間しない）。
 *
 * **Three.js を知らない純粋な時間割**なので、どの絵をいつ出すかはテストで固定できる
 * （`core/tempo.ts` が「間」の長さだけを持つのと同じ立て方）。絵そのもの（関節の角度）は
 * `entities/player.ts` が持つ。
 *
 * ## 投球モーション（どの球・どの投手でも同じ）
 *
 * | フレーム | 絵 |
 * |---|---|
 * | 構えている間 | `set`（グラブを胸の前で合わせる） |
 * | 0〜11 | `raise`（両手を顔の前へ上げる） |
 * | 12〜23 | `overhead`（両手を頭上へ） |
 * | 24〜43 | `kick`（足を高く上げる） |
 * | 44〜59 | `back`（腕を後ろへ引いて踏み出す） |
 * | 60〜69 | `cock`（腕を頭の上へ担ぐ） |
 * | 70〜73 | `release`（リリース＝球が手を離れる） |
 * | 74〜85 | `follow`（前へ倒れ込む） |
 * | 86〜 | `field`（守備の構え） |
 *
 * 原作のリリースの絵（16フレーム）は低く倒れ込んだ1枚だが、**このゲームの球はリリースの
 * 形の手から出る**（MM-60・CC-50 の `armReleaseHeight`／`armReleaseOffsetX`）ので、
 * 最初の4フレームはその形（腕が前方水平）で見せ、残りを倒れ込みにした。
 *
 * 70フレーム目がリリース（`PITCH_WINDUP_SEC`）。原作の7球すべてで同じだった。
 *
 * ## スイング
 *
 * 原作は5枚（後ろへ寝かせる→斜め下→本塁の上で水平→斜め上→肩越しに背中へ）を
 * **3フレームずつ**切り替え、最後の形で**41フレーム**止まってから、**逆順に2フレームずつ**で
 * 構えへ戻る（素振りの映像で実測）。打った映像では**3枚目（水平）の最初のフレームで
 * 球がバットに来ている**ので、3枚目の始まりを判定の芯（`SWING_IDEAL_SEC`）に揃える
 * ＝**ちょうどのタイミングで当たれば、当たった絵は必ず「本塁の上で水平」**。
 * 早く当たれば（振り遅れ＝流し打ち）2枚目の「斜め下」、遅く当たれば（引っ張り）4枚目
 * になる＝**当たった瞬間の絵がそのまま打球の向きを語る**。
 */
import { SWING_IDEAL_SEC } from './batting';
import { PITCH_WINDUP_SEC } from './pitch';

/** 原作の1フレーム（60fps） */
export const ORIGINAL_FRAME_SEC = 1 / 60;

// ---------------------------------------------------------------------------
// 投球モーション
// ---------------------------------------------------------------------------

/**
 * 投手の絵（原作の8枚。原作のリリースの絵は「球が手を離れた形」と「前へ倒れ込んだ形」を
 * 2つに分けて持つ＝`release`（球が出る1枚。MM-60の形）と `follow`）。
 */
export type PitchKey =
  | 'set'
  | 'raise'
  | 'overhead'
  | 'kick'
  | 'back'
  | 'cock'
  | 'release'
  | 'follow'
  | 'field';

/** 振りかぶりの絵と、それが始まるフレーム（モーション開始＝0。リリースは70） */
export const PITCH_WINDUP_KEYS: readonly { key: PitchKey; fromFrame: number }[] = [
  { key: 'raise', fromFrame: 0 },
  { key: 'overhead', fromFrame: 12 },
  { key: 'kick', fromFrame: 24 },
  { key: 'back', fromFrame: 44 },
  { key: 'cock', fromFrame: 60 },
];

/** リリースの後、守備の構えに変わるまでのフレーム数（原作：16フレーム） */
export const PITCH_RELEASE_FRAMES = 16;
/** そのうち、球が手を離れた形（`release`）を見せるフレーム数（残りは倒れ込み＝`follow`） */
export const PITCH_RELEASE_HAND_FRAMES = 4;

/**
 * 振りかぶりの途中の絵。`elapsedSec` はモーションに入ってからの経過（0〜`PITCH_WINDUP_SEC`）。
 * 境目の判定はフレームの切れ目ちょうどで次の絵へ移る（原作の切り替えと同じ）。
 */
export function windupKeyAt(elapsedSec: number): PitchKey {
  const frame = Math.max(0, elapsedSec) / ORIGINAL_FRAME_SEC;
  let key: PitchKey = PITCH_WINDUP_KEYS[0].key;
  for (const k of PITCH_WINDUP_KEYS) {
    // 浮動小数の誤差で境目の1フレームが前の絵に残らないよう、わずかに許容する
    if (frame + 1e-6 >= k.fromFrame) key = k.key;
  }
  return key;
}

/** リリースの後の絵。`sinceReleaseSec` はリリースからの経過 */
export function afterReleaseKeyAt(sinceReleaseSec: number): PitchKey {
  const frame = sinceReleaseSec / ORIGINAL_FRAME_SEC + 1e-6;
  if (frame < PITCH_RELEASE_HAND_FRAMES) return 'release';
  return frame < PITCH_RELEASE_FRAMES ? 'follow' : 'field';
}

/** 振りかぶりの長さ（フレーム）。時間割の最後の絵の終わり＝リリース */
export const PITCH_WINDUP_FRAMES = Math.round(PITCH_WINDUP_SEC / ORIGINAL_FRAME_SEC);

/**
 * **走者がスタートを切れるいちばん早い瞬間**（モーションに入ってからの秒。フェーズBBB-76）
 * ＝投手が**腕を後ろへ引いて本塁へ踏み出す絵**（`back`。44フレーム目）。それより早く
 * 盗塁を押しても、走り出すのはここ（実際の野球の「投手が本塁へ踏み出したらスタート」）。
 *
 * **これが無いと、原作どおり長くなったモーション（0.35秒→1.17秒）がそのまま走者の
 * 持ち時間に足される**：モーションの頭で押せば、本塁への盗塁（L-32が「捕手が本塁に
 * 立っている＝必ず刺される」とした）まで遅い球なら間に合い、リード0の走者（L-32の
 * 「戻る＝安全だが走れない」）もどの球にでも走れてしまう。踏み出しからリリースまでは
 * 26フレーム（0.43秒）で、**それまでのモーション（0.35秒）とほぼ同じ持ち時間**になる
 * ＝A-7以来の盗塁の窓（速球0.82／普通0.90秒 → 0.80／0.86秒）が保たれる。
 */
export const STEAL_GO_SEC =
  (PITCH_WINDUP_KEYS.find((k) => k.key === 'back')?.fromFrame ?? 0) * ORIGINAL_FRAME_SEC;

// ---------------------------------------------------------------------------
// スイング
// ---------------------------------------------------------------------------

/** 打者の絵（構え＋原作の5枚） */
export type SwingKey = 'stance' | 'load' | 'lag' | 'contact' | 'follow' | 'finish';

/** 1枚の絵を見せる時間（原作：振り出しから振り切りまで3フレームずつ） */
export const SWING_KEY_SEC = 3 * ORIGINAL_FRAME_SEC;
/** 振り切った形（`finish`）で止まっている時間（原作：41フレーム） */
export const SWING_FINISH_HOLD_SEC = 41 * ORIGINAL_FRAME_SEC;
/** 構えへ戻るときの1枚の時間（原作：逆順に2フレームずつ） */
export const SWING_RETURN_KEY_SEC = 2 * ORIGINAL_FRAME_SEC;

/** 3枚目（本塁の上で水平＝当たる絵）が始まる時刻＝判定の芯 */
export const SWING_CONTACT_KEY_FROM = SWING_IDEAL_SEC;
/** 振り切った形に入る時刻（ここからは振り直せる＝次の球のほうが先に来ても振れなくならない） */
export const SWING_FINISH_FROM = SWING_CONTACT_KEY_FROM + 2 * SWING_KEY_SEC;
/** 構えへ戻り始める時刻 */
export const SWING_RETURN_FROM = SWING_FINISH_FROM + SWING_FINISH_HOLD_SEC;
/** 構えへ戻り切る時刻（＝スイングの長さ） */
export const SWING_TOTAL_SEC = SWING_RETURN_FROM + 4 * SWING_RETURN_KEY_SEC;

/** 戻るときの並び（振り切った形から逆順） */
const RETURN_KEYS: readonly SwingKey[] = ['follow', 'contact', 'lag', 'load'];

/**
 * スイングの経過 `swingSec`（押した瞬間＝0）でどの絵を出すか。
 * 振り出す前（CPUがフレームの途中で振り出したとき、フレームの先頭では負になる）は構え。
 */
export function swingKeyAt(swingSec: number): SwingKey {
  if (swingSec < 0) return 'stance';
  const eps = 1e-9;
  if (swingSec + eps < SWING_CONTACT_KEY_FROM - SWING_KEY_SEC) return 'load';
  if (swingSec + eps < SWING_CONTACT_KEY_FROM) return 'lag';
  if (swingSec + eps < SWING_CONTACT_KEY_FROM + SWING_KEY_SEC) return 'contact';
  if (swingSec + eps < SWING_FINISH_FROM) return 'follow';
  if (swingSec + eps < SWING_RETURN_FROM) return 'finish';
  const i = Math.floor((swingSec - SWING_RETURN_FROM + eps) / SWING_RETURN_KEY_SEC);
  return i < RETURN_KEYS.length ? RETURN_KEYS[i] : 'stance';
}
