/**
 * 乱闘v3のHUD（フェーズXX-72）。ストIIの画面の約束をそのまま持ち込む：
 *
 * - **上端に体力ゲージ2本**（打者＝左／投手＝右。右のゲージは右から減る）。**減った直後は
 *   黄色い「減りしろ」が残り、少し遅れて追いつく**＝どれだけ食らったかが一目で分かる。
 * - その下に**名前と取ったラウンドの印**（2本先取）、真ん中に**残り時間**（10秒を切ると赤）。
 * - **超必殺のゲージ**（超必殺を持っている選手だけ。満タンで明滅して `超必殺OK`）。
 * - **連続技の数**（2ヒット目から、当てている側に `3ヒット!`）。
 * - **大きな呼び出し**（`第1ラウンド`／`ファイト！`／`K.O.`／`タイムアップ`／`〇〇の勝ち`）。
 *
 * 文字はすべて canvas のドット文字（WW-71の約束）。**真実は `core/brawl.ts` の状態**で、
 * ここは毎フレーム渡された形を描くだけ（減りしろの遅れだけが見た目の時計）。
 */
import type { BrawlHudFighter, BrawlHudView } from '../../scenes/brawlScene';
import { createPixelLabel, uiScale } from './pixelText';

export type BrawlCalloutTone = 'round' | 'fight' | 'ko' | 'timeUp' | 'win' | 'super' | 'info';

const CALLOUT_STYLE: Record<BrawlCalloutTone, { color: string; scale: number; sec: number }> = {
  round: { color: '#ffffff', scale: 4, sec: 1.1 },
  fight: { color: '#ffd23a', scale: 6, sec: 0.9 },
  ko: { color: '#ff4a3a', scale: 7, sec: 1.8 },
  timeUp: { color: '#ffd23a', scale: 5, sec: 1.4 },
  win: { color: '#ffffff', scale: 4, sec: 2.2 },
  super: { color: '#ffe066', scale: 3, sec: 0.9 },
  info: { color: '#9fe0ff', scale: 3, sec: 1.0 },
};

export interface BrawlHud {
  update(view: BrawlHudView, dt: number): void;
  callout(text: string, tone: BrawlCalloutTone): void;
  setVisible(visible: boolean): void;
}

interface SidePanel {
  root: HTMLElement;
  trail: HTMLElement;
  fill: HTMLElement;
  name: ReturnType<typeof createPixelLabel>;
  pips: HTMLElement[];
  meterWrap: HTMLElement;
  meterFill: HTMLElement;
  meterLabel: ReturnType<typeof createPixelLabel>;
  combo: ReturnType<typeof createPixelLabel>;
  trailRatio: number;
  lastRatio: number;
  trailHold: number;
  comboShown: number;
  comboLinger: number;
}

function css(el: HTMLElement, text: string): HTMLElement {
  el.style.cssText = text;
  return el;
}

function createSide(align: 'left' | 'right'): SidePanel {
  const right = align === 'right';
  const root = css(
    document.createElement('div'),
    `display:flex;flex-direction:column;align-items:${right ? 'flex-end' : 'flex-start'};gap:4px;width:40%;`,
  );
  const bar = css(
    document.createElement('div'),
    `position:relative;width:100%;height:22px;background:#3a0000;border:3px solid #f4f4f4;` +
      `box-shadow:3px 3px 0 0 rgba(0,0,0,0.55);overflow:hidden;`,
  );
  const anchor = right ? 'right:0;' : 'left:0;';
  const trail = css(document.createElement('div'), `position:absolute;top:0;bottom:0;${anchor}width:100%;background:#ffcf33;`);
  const fill = css(document.createElement('div'), `position:absolute;top:0;bottom:0;${anchor}width:100%;background:#2fd35a;`);
  bar.append(trail, fill);

  const row = css(
    document.createElement('div'),
    `display:flex;flex-direction:${right ? 'row-reverse' : 'row'};align-items:center;gap:8px;`,
  );
  const name = createPixelLabel('', { scale: 2, color: '#ffffff', outline: '#10101c', paddingX: 0, paddingY: 0 });
  const pipsWrap = css(document.createElement('div'), `display:flex;gap:4px;`);
  const pips: HTMLElement[] = [];
  for (let i = 0; i < 2; i++) {
    const pip = css(
      document.createElement('div'),
      `width:14px;height:14px;border:2px solid #f4f4f4;background:#222;box-shadow:2px 2px 0 rgba(0,0,0,0.5);`,
    );
    pips.push(pip);
    pipsWrap.appendChild(pip);
  }
  row.append(name.el, pipsWrap);

  const meterWrap = css(
    document.createElement('div'),
    `display:flex;flex-direction:${right ? 'row-reverse' : 'row'};align-items:center;gap:6px;width:60%;`,
  );
  const meterBar = css(
    document.createElement('div'),
    `position:relative;flex:1;height:10px;background:#1a1a30;border:2px solid #f4f4f4;overflow:hidden;`,
  );
  const meterFill = css(document.createElement('div'), `position:absolute;top:0;bottom:0;${anchor}width:0%;background:#3fb8ff;`);
  meterBar.appendChild(meterFill);
  const meterLabel = createPixelLabel('', { scale: 1, color: '#ffe066', outline: '#10101c', paddingX: 0, paddingY: 0 });
  meterWrap.append(meterBar, meterLabel.el);

  const combo = createPixelLabel('', { scale: 3, color: '#ffe066', outline: '#10101c', paddingX: 0, paddingY: 0 });
  combo.el.style.display = 'none';

  root.append(bar, row, meterWrap, combo.el);
  return {
    root,
    trail,
    fill,
    name,
    pips,
    meterWrap,
    meterFill,
    meterLabel,
    combo,
    trailRatio: 1,
    lastRatio: 1,
    trailHold: 0,
    comboShown: 0,
    comboLinger: 0,
  };
}

export function createBrawlHud(parent: HTMLElement): BrawlHud {
  const overlay = css(
    document.createElement('div'),
    `position:fixed;inset:0;display:none;pointer-events:none;`,
  );
  const top = css(
    document.createElement('div'),
    `position:absolute;top:14px;left:0;right:0;display:flex;justify-content:space-between;align-items:flex-start;padding:0 20px;`,
  );
  const left = createSide('left');
  const right = createSide('right');
  const timer = createPixelLabel('60', { scale: 4, color: '#ffffff', outline: '#10101c', paddingX: 0, paddingY: 0, align: 'center' });
  const timerWrap = css(document.createElement('div'), `display:flex;flex-direction:column;align-items:center;`);
  const roundLabel = createPixelLabel('', { scale: 1, color: '#b8c0d8', outline: '#10101c', paddingX: 0, paddingY: 0, align: 'center' });
  timerWrap.append(timer.el, roundLabel.el);
  top.append(left.root, timerWrap, right.root);

  const callout = createPixelLabel('', {
    scale: 4,
    color: '#ffffff',
    outline: '#10101c',
    align: 'center',
    paddingX: 0,
    paddingY: 0,
    shadows: [{ dx: 2, dy: 2, color: '#10101c' }],
  });
  css(callout.el, `position:absolute;left:50%;top:38%;transform:translate(-50%,-50%);display:none;image-rendering:pixelated;`);
  overlay.append(top, callout.el);
  parent.appendChild(overlay);

  let calloutLeft = 0;
  let calloutTotal = 1;
  let realTime = 0;

  function applySide(p: SidePanel, f: BrawlHudFighter, dt: number, roundsToWin: number): void {
    const ratio = Math.max(0, Math.min(1, f.hp / Math.max(1, f.maxHp)));
    // 減りしろ：減った直後は0.5秒そのまま、そこからゆっくり追いつく（回復したらすぐ揃える）
    if (ratio < p.lastRatio) p.trailHold = 0.5;
    if (ratio > p.trailRatio) p.trailRatio = ratio;
    if (p.trailHold > 0) p.trailHold -= dt;
    else p.trailRatio = Math.max(ratio, p.trailRatio - dt * 0.6);
    p.lastRatio = ratio;
    p.fill.style.width = `${ratio * 100}%`;
    p.trail.style.width = `${p.trailRatio * 100}%`;
    p.fill.style.background = ratio <= 0.25 ? (Math.floor(realTime * 6) % 2 === 0 ? '#ff4a3a' : '#c02a20') : '#2fd35a';
    p.name.setText(f.raging ? `${f.name} 怒` : f.name, { color: f.raging ? '#ff7a6a' : '#ffffff' });
    p.pips.forEach((pip, i) => {
      pip.style.display = i < roundsToWin ? 'block' : 'none';
      pip.style.background = i < f.roundWins ? '#ffd23a' : '#222';
    });
    p.meterWrap.style.display = f.hasSuper ? 'flex' : 'none';
    if (f.hasSuper) {
      const m = Math.max(0, Math.min(1, f.meter / f.meterMax));
      p.meterFill.style.width = `${m * 100}%`;
      const full = m >= 1;
      p.meterFill.style.background = full ? (Math.floor(realTime * 8) % 2 === 0 ? '#ffe066' : '#ff9a2a') : '#3fb8ff';
      p.meterLabel.setText(full ? '超必殺OK' : '超必殺');
    }
    // 連続技：途切れても少しだけ残す（「何ヒットだったか」を読む時間）
    if (f.combo >= 2) {
      p.comboShown = f.combo;
      p.comboLinger = 0.9;
    } else if (p.comboLinger > 0) {
      p.comboLinger -= dt;
    }
    const show = p.comboLinger > 0 && p.comboShown >= 2;
    if (show) p.combo.setText(`${p.comboShown}ヒット!`);
    p.combo.el.style.display = show ? 'block' : 'none';
  }

  return {
    update(view, dt) {
      realTime += dt;
      applySide(left, view.batter, dt, view.roundsToWin);
      applySide(right, view.pitcher, dt, view.roundsToWin);
      if (view.timer === null) {
        timer.setText('--', { color: '#ffffff' });
        roundLabel.setText('練習');
      } else {
        timer.setText(String(Math.max(0, view.timer)).padStart(2, '0'), {
          color: view.timer <= 10 ? '#ff5a4a' : '#ffffff',
        });
        roundLabel.setText(`第${view.round}ラウンド`);
      }
      if (calloutLeft > 0) {
        calloutLeft -= dt;
        const k = 1 - calloutLeft / calloutTotal;
        // 出だしだけ少し大きく見せて、すっと収まる（整数倍の拡大は保ったまま、CSSの縮尺で弾ませる）
        const pop = k < 0.12 ? 1.25 - (k / 0.12) * 0.25 : 1;
        callout.el.style.transform = `translate(-50%,-50%) scale(${pop})`;
        callout.el.style.opacity = calloutLeft < 0.25 ? String(Math.max(0, calloutLeft / 0.25)) : '1';
        if (calloutLeft <= 0) callout.el.style.display = 'none';
      }
    },

    callout(text, tone) {
      const style = CALLOUT_STYLE[tone];
      // 狭い画面でも呼び出しが画面からはみ出さないよう、整数倍のまま拡大率を落とす
      const maxScale = Math.max(2, Math.floor(window.innerWidth / (Math.max(1, text.length) * 16 * uiScale() * 1.2)));
      callout.setText(text, { color: style.color, scale: Math.min(style.scale, maxScale) });
      callout.el.style.display = 'block';
      calloutLeft = style.sec;
      calloutTotal = style.sec;
    },

    setVisible(visible) {
      overlay.style.display = visible ? 'block' : 'none';
      if (!visible) {
        callout.el.style.display = 'none';
        calloutLeft = 0;
      }
    },
  };
}
