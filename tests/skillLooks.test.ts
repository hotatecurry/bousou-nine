/**
 * スキルの見た目・音・効く瞬間（フェーズYY-73）。テストプレイ「スキルが全く作れていない」＝
 * **数字が足されているだけで画面のどこにも出ない札**を二度と作らないための約束を固定する。
 */
import { describe, expect, it } from 'vitest';
import { SKILL_SOUND } from '../src/audio/skillSounds';
import { ALL_SKILL_IDS, SKILLS, sightOf, skillMomentsOf, skillsAtMoment } from '../src/core/skills';
import { skillLookParts } from '../src/entities/skillLooks';

describe('全札に見た目・音・効く瞬間がある', () => {
  it('どの札も体に付く物がある（見た目の無い札は無い）', () => {
    for (const id of ALL_SKILL_IDS) {
      const parts = skillLookParts(id);
      expect(parts.length, id).toBeGreaterThan(0);
      for (const p of parts) expect(p.obj.children.length + (p.obj.type === 'Mesh' ? 1 : 0), id).toBeGreaterThan(0);
    }
  });

  it('どの札も音がある', () => {
    for (const id of ALL_SKILL_IDS) expect(SKILL_SOUND[id], id).toBeTruthy();
  });

  it('どの札も効く瞬間がある（＝その瞬間に閃いて鳴る）', () => {
    for (const id of ALL_SKILL_IDS) {
      // チャージを増やすだけの強化デュオは、前提の札の瞬間に効く
      const def = SKILLS[id];
      const moments = def.chargeBonus && def.requires ? skillMomentsOf(def.requires[0]) : skillMomentsOf(id);
      expect(moments.length, id).toBeGreaterThan(0);
    }
  });
});

describe('効く瞬間は効果の中身から導かれる', () => {
  it('投球・打撃・走塁・守備・給油・乱闘・動詞', () => {
    expect(skillMomentsOf('haguruma')).toContain('pitch');
    expect(skillMomentsOf('kinniku')).toContain('contact');
    expect(skillMomentsOf('sukebo')).toContain('run');
    expect(skillMomentsOf('usagi')).toContain('lead');
    expect(skillMomentsOf('inu')).toContain('catch');
    expect(skillMomentsOf('fushicho')).toContain('refill');
    expect(skillMomentsOf('shoryuken')).toContain('brawl');
    expect(skillMomentsOf('ju')).toContain('verb');
    expect(skillMomentsOf('zettaiyochi')).toContain('atBat');
  });

  it('その瞬間の札だけを選ぶ', () => {
    expect(skillsAtMoment(['haguruma', 'kinniku', 'inu'], 'contact')).toEqual(['kinniku']);
  });
});

describe('名前どおりの効き方（YY-73）', () => {
  it('読みの札が見せるものは名前どおり', () => {
    expect(sightOf(['terepashi'])).toEqual({ speed: true, course: true });
    expect(sightOf(['miraishi']).crossing).toBe(true);
    expect(sightOf(['shingan']).path).toBe(true);
    expect(sightOf(['jikanteishi']).slow).toBe(true);
    expect(sightOf(['taka']).landing).toBe(true);
    // 重ねれば合わさる
    expect(sightOf(['yochi', 'reikan'])).toEqual({ speed: true, course: true });
    // 読みの札は数字の補正を残している（CPUの打者にも同じだけ効く＝判定の手触りは不変）
    expect(SKILLS.terepashi.modifier?.average).toBeGreaterThan(0);
  });

  it('熊はスクリュー、猿はサマーソルトを配る（乱闘の技がどの札にも配られていない、を無くした）', () => {
    expect(SKILLS.kuma.brawl?.special).toBe('screw');
    expect(SKILLS.saru.brawl?.special).toBe('somersault');
  });

  it('予備タンク・不死鳥は一度だけの給油（足す総量は旧実装と同じ球数）', () => {
    expect(SKILLS.yobitanku.refill).toBe(20);
    expect(SKILLS.fushicho.refill).toBe(50);
    expect(SKILLS.yobitanku.modifier?.stamina).toBeUndefined();
  });

  it('火事場の力は負けているときだけ', () => {
    expect(SKILLS.kajibanochikara.when).toBe('trailing');
  });
});
