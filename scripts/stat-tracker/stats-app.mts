import { RollStats } from './roll-stats.mjs';

const MODULE_ID = 'showstopper';
const COMPACT_THRESHOLD = 1_000_000;
const DAMAGE_TYPE_COLORS: Record<string, string> = {
  acid: '#84cc16',
  bludgeoning: '#94a3b8',
  cold: '#38bdf8',
  fire: '#f97316',
  force: '#e879f9',
  lightning: '#60a5fa',
  necrotic: '#a78bfa',
  piercing: '#cbd5e1',
  poison: '#4ade80',
  psychic: '#f472b6',
  radiant: '#facc15',
  slashing: '#fca5a5',
  thunder: '#818cf8',
  unknown: '#94a3b8'
};

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function t(key: string, fallback?: string): string {
  const v = game.i18n.localize(key);
  return v !== key ? v : (fallback || key);
}

function tf(key: string, data: Record<string, string>): string {
  return game.i18n.format(key, data);
}

/**
 * Native Foundry VTT v14 Statistics ApplicationV2 window.
 */
class StatsApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: 'showstopper-stats',
    tag: 'div',
    classes: ['ss-stats-app'],
    position: { width: 960, height: 640 },
    window: {
      title: 'showstopper.Stats.Title',
      icon: 'fa-solid fa-chart-column',
      resizable: true
    },
    actions: {
      // `this` === the class inside a static initializer; referencing StatsApp.#x
      // makes tsc emit a `var _a` pattern that breaks static initialization order.
      switchTab: this.#onSwitchTab,
      setPeriod: this.#onSetPeriod,
      setFilter: this.#onSetFilter,
      clearSearch: this.#onClearSearch,
      sortTable: this.#onSortTable,
      selectChar: this.#onSelectChar,
      openSheet: this.#onOpenSheet,
      exportChar: this.#onExportChar,
      exportSummary: this.#onExportSummary,
      newSession: this.#onNewSession,
      resetStats: this.#onResetStats
    }
  };

  static PARTS = {
    toolbar: {
      template: `modules/${MODULE_ID}/templates/stats-toolbar.hbs`
    },
    body: {
      template: `modules/${MODULE_ID}/templates/stats-body.hbs`,
      scrollable: [
        '.ss-st-overview-scroll',
        '.ss-st-sidebar-list',
        '.ss-st-detail-scroll',
        '.ss-st-log-scroll'
      ]
    }
  };

  activeTab: 'overview' | 'characters' | 'log' = 'overview';
  selectedCharId: string | null = null;
  expandedChars = new Set<string>();
  pcOnly = false;
  period: 'session' | 'all' = 'session';
  searchQuery = '';
  sortKey = 'dmgDealt';
  sortDir: 'asc' | 'desc' = 'desc';

  #aggCache: { rev: number; period: string; list: any[] } | null = null;
  #dataTimer: any = null;
  #searchTimer: any = null;

  constructor(charId?: string, options?: any) {
    super(options || {});
    if (charId) {
      this.selectedCharId = charId;
      this.expandedChars.add(charId);
      this.activeTab = 'characters';
    }
    const unsubscribe = RollStats.onDataRevChange(() => {
      if (foundry.applications.instances.get('showstopper-stats') !== this) {
        unsubscribe();
        return;
      }
      this.#scheduleDataRender();
    });
  }

  /** Switch to a character's detailed profile and open the Characters tab. */
  async selectCharacter(charId: string) {
    if (!charId) return;
    this.selectedCharId = charId;
    this.expandedChars.add(charId);
    this.activeTab = 'characters';
    await this.render({ force: true });
    const detail = this.element?.querySelector('.ss-st-detail-scroll');
    if (detail) detail.scrollTop = 0;
  }

  #scheduleDataRender() {
    if (this.#dataTimer) return;
    this.#dataTimer = setTimeout(() => {
      this.#dataTimer = null;
      if (foundry.applications.instances.get('showstopper-stats') !== this) return;
      const durationEl = this.element?.querySelector('.ss-st-duration');
      if (durationEl) durationEl.textContent = this.#formatSessionDuration();
      this.render({ parts: ['body'] });
    }, 500);
  }

  async close(options: any = {}) {
    if (this.#dataTimer) {
      clearTimeout(this.#dataTimer);
      this.#dataTimer = null;
    }
    if (this.#searchTimer) {
      clearTimeout(this.#searchTimer);
      this.#searchTimer = null;
    }
    return super.close(options);
  }

  #fmtExact(value: number): string {
    const rounded = Math.round((Number(value) || 0) * 10) / 10;
    return new Intl.NumberFormat(game.i18n?.lang || undefined).format(rounded);
  }

  #fmtStat(value: number): { text: string; tip: string; raw: number } {
    const num = Number(value) || 0;
    const rounded = Math.round(num * 10) / 10;
    const exact = this.#fmtExact(rounded);
    if (Math.abs(rounded) >= COMPACT_THRESHOLD) {
      const compact = new Intl.NumberFormat(game.i18n?.lang || undefined, {
        notation: 'compact',
        maximumFractionDigits: 1
      }).format(rounded);
      return { text: compact, tip: exact, raw: rounded };
    }
    return { text: exact, tip: '', raw: rounded };
  }

  #formatSessionDuration(): string {
    if (this.period !== 'session') return '';
    const start = RollStats._store?.sessionStart || Date.now();
    const elapsed = Math.max(0, Math.floor((Date.now() - start) / 60000));
    const hours = Math.floor(elapsed / 60);
    const mins = elapsed % 60;
    const hUnit = t('showstopper.Stats.HoursShort', 'h');
    const mUnit = t('showstopper.Stats.MinutesShort', 'm');
    return hours > 0 ? `${hours}${hUnit} ${mins}${mUnit}` : `${mins}${mUnit}`;
  }

  /** Build character list for the current period, cached by data revision. */
  #buildCharList(): any[] {
    const rev = RollStats.dataRev;
    if (this.#aggCache?.rev === rev && this.#aggCache.period === this.period) {
      return this.#aggCache.list;
    }
    const list = RollStats._getAllCharIds().map(id => {
      const name = RollStats._getCharName(id);
      const isPC = RollStats._isCharPC(id);
      const portrait = RollStats._getCharPortrait(id);
      const data = RollStats._getPeriodData(id, this.period);
      const actor = RollStats._resolveStatActor(id);
      const summonInfo = actor ? RollStats._getSummonInfo(actor) : null;
      const summonerId = summonInfo?.summoner?.uuid ?? data?.summonerId ?? null;
      const atkTotal = data?.attacks?.total || 0;
      const crits = data?.attacks?.crits || 0;
      const dmgDealt = data?.damage?.dealt || 0;
      const summonDealt = data?.damage?.summonDealt || 0;
      const dmgTaken = data?.damage?.taken || 0;
      const healingGiven = data?.healing?.given || 0;
      const healingReceived = data?.healing?.received ?? data?.healing?.total ?? 0;
      const healing = healingGiven;
      const kills = data?.kills || 0;
      const saveTotal = data?.saveSummary?.total || 0;
      const saveSucc = data?.saveSummary?.successes || 0;
      const nat20 = data?.nat20 || 0;
      const nat1 = data?.nat1 || 0;
      const saveSortVal = saveTotal > 0 ? (saveSucc / saveTotal) + saveTotal * 0.0001 : -1;
      const luckSortVal = (nat20 > 0 || nat1 > 0) ? (nat20 * 1000 - nat1) : -100000;
      return {
        id,
        name,
        nameLower: String(name || '').toLowerCase(),
        isPC,
        summonerId,
        portrait,
        data,
        atkTotal,
        crits,
        dmgDealt,
        summonDealt,
        dmgTaken,
        healing,
        healingGiven,
        healingReceived,
        kills,
        saveTotal,
        saveSucc,
        saveSortVal,
        nat20,
        nat1,
        luckSortVal
      };
    }).filter(entry => entry.data);

    this.#aggCache = { rev, period: this.period, list };
    return list;
  }

  #filterAndSortChars(charList: any[]): any[] {
    const q = this.searchQuery.trim().toLowerCase();
    const filtered = charList.filter(c => {
      if (this.pcOnly && !c.isPC) return false;
      if (q && !c.nameLower.includes(q)) return false;
      return true;
    });

    const collator = new Intl.Collator(game.i18n?.lang || undefined, { numeric: true, sensitivity: 'base' });
    const dir = this.sortDir === 'asc' ? 1 : -1;
    filtered.sort((a, b) => {
      let cmp = 0;
      switch (this.sortKey) {
        case 'name': cmp = collator.compare(a.name, b.name); break;
        case 'atkTotal': cmp = a.atkTotal - b.atkTotal; break;
        case 'crits': cmp = a.crits - b.crits; break;
        case 'dmgTaken': cmp = a.dmgTaken - b.dmgTaken; break;
        case 'healing': cmp = a.healing - b.healing; break;
        case 'kills': cmp = a.kills - b.kills; break;
        case 'saves': cmp = a.saveSortVal - b.saveSortVal; break;
        case 'luck': cmp = a.luckSortVal - b.luckSortVal; break;
        case 'dmgDealt':
        default:
          cmp = a.dmgDealt - b.dmgDealt;
          break;
      }
      if (cmp !== 0) return cmp * dir;
      return collator.compare(a.name, b.name);
    });
    return filtered;
  }

  #buildSummaryCards(view: any[]): any[] {
    let attacks = 0;
    let nat20 = 0;
    let nat1 = 0;
    let dmgDealt = 0;
    let kills = 0;
    let dmgTaken = 0;
    let downs = 0;
    let healing = 0;
    let healedGiven = 0;

    const viewIds = new Set(view.map(c => c.id));
    for (const c of view) {
      const d = c.data;
      if (!d) continue;
      // When both a summon and its summoner are present in `view` (e.g. "All" filter),
      // the summoner's dealt/kills/healing.given already include the summon's output.
      const attributedToOwnerInView = Boolean(c.summonerId && viewIds.has(c.summonerId));
      attacks += d.attacks?.total || 0;
      nat20 += d.nat20 || 0;
      nat1 += d.nat1 || 0;
      if (!attributedToOwnerInView) {
        dmgDealt += d.damage?.dealt || 0;
        kills += d.kills || 0;
        healedGiven += d.healing?.given || 0;
      }
      dmgTaken += d.damage?.taken || 0;
      downs += d.damage?.downs || 0;
      healing += d.healing?.received ?? d.healing?.total ?? 0;
    }

    const fAtk = this.#fmtStat(attacks);
    const fDealt = this.#fmtStat(dmgDealt);
    const fTaken = this.#fmtStat(dmgTaken);
    const fHeal = this.#fmtStat(healing);

    return [
      {
        tone: 'neutral',
        icon: 'fa-solid fa-crosshairs',
        label: t('DND5E.AttackPl', 'Attacks'),
        value: fAtk.text,
        tooltip: fAtk.tip,
        sub: (nat20 || nat1)
          ? `${t('showstopper.Stats.Nat20')}: ${nat20} · ${t('showstopper.Stats.Nat1')}: ${nat1}`
          : ''
      },
      {
        tone: 'warm',
        icon: 'fa-solid fa-bolt',
        label: t('showstopper.Stats.DamageDealt'),
        value: fDealt.text,
        tooltip: fDealt.tip,
        sub: kills > 0 ? `${t('showstopper.Stats.Kills')}: ${this.#fmtExact(kills)}` : ''
      },
      {
        tone: 'danger',
        icon: 'fa-solid fa-shield-halved',
        label: t('showstopper.Stats.Taken'),
        value: fTaken.text,
        tooltip: fTaken.tip,
        sub: downs > 0 ? `${t('showstopper.Stats.Downs')}: ${this.#fmtExact(downs)}` : ''
      },
      {
        tone: 'heal',
        icon: 'fa-solid fa-heart-pulse',
        label: t('DND5E.HEAL.Type.HealingShort', 'Healing'),
        value: fHeal.text,
        tooltip: fHeal.tip,
        sub: healedGiven > 0 ? `${t('showstopper.Stats.HealingGiven')}: ${this.#fmtStat(healedGiven).text}` : ''
      }
    ];
  }

  #buildOverviewCols(): any[] {
    const defs = [
      { key: 'name', type: 'text', alignClass: '', label: t('showstopper.Stats.Character') },
      { key: 'atkTotal', type: 'number', alignClass: 'ss-st-num', label: t('DND5E.AttackPl') },
      { key: 'crits', type: 'number', alignClass: 'ss-st-num', label: t('showstopper.Stats.Crits') },
      { key: 'dmgDealt', type: 'number', alignClass: 'ss-st-num', label: t('showstopper.Stats.DamageDealt') },
      { key: 'dmgTaken', type: 'number', alignClass: 'ss-st-num', label: t('showstopper.Stats.Taken') },
      { key: 'healing', type: 'number', alignClass: 'ss-st-num', label: t('DND5E.HEAL.Type.HealingShort') },
      { key: 'kills', type: 'number', alignClass: 'ss-st-num', label: t('showstopper.Stats.Kills') },
      { key: 'saves', type: 'number', alignClass: 'ss-st-num', label: t('DND5E.SAVE.Title.other') },
      { key: 'luck', type: 'number', alignClass: 'ss-st-num', label: t('showstopper.Stats.LuckCol', '20 / 1') }
    ];

    return defs.map((col, idx) => {
      const isSorted = this.sortKey === col.key;
      const ariaSort = isSorted ? (this.sortDir === 'asc' ? 'ascending' : 'descending') : '';
      const icon = isSorted
        ? (this.sortDir === 'asc' ? 'fa-sort-up' : 'fa-sort-down')
        : 'fa-sort';
      return { ...col, idx, ariaSort, icon };
    });
  }

  #buildOverviewRows(view: any[]): any[] {
    return view.map(c => {
      const d = c.data || {};
      const fAtk = this.#fmtStat(c.atkTotal);
      const fCrits = this.#fmtStat(c.crits);
      const fDealt = this.#fmtStat(c.dmgDealt);
      const fTaken = this.#fmtStat(c.dmgTaken);
      const fHeal = this.#fmtStat(c.healing);
      const fKills = this.#fmtStat(c.kills);
      const downs = d.damage?.downs || 0;

      const conc = d.concentration || {};
      const saveTipParts: string[] = [];
      if (d.checks?.save) {
        for (const [abl, v] of Object.entries(d.checks.save) as [string, any][]) {
          if (v?.total > 0) saveTipParts.push(`${RollStats._locAbl(abl)}: ${v.successes}/${v.total}`);
        }
      }
      if (conc.total > 0) saveTipParts.push(`${t('showstopper.Stats.Concentration')}: ${conc.successes}/${conc.total}`);

      return {
        id: c.id,
        name: c.name,
        portrait: c.portrait,
        isPC: c.isPC,
        atkRaw: c.atkTotal,
        atkFmt: fAtk.text,
        atkTip: fAtk.tip,
        critsRaw: c.crits,
        critsFmt: fCrits.text,
        hasCrits: c.crits > 0,
        critsPct: c.atkTotal > 0 ? RollStats._pct(c.crits, c.atkTotal) : 0,
        dmgDealtRaw: c.dmgDealt,
        dmgDealtFmt: fDealt.text,
        dmgDealtTip: [
          fDealt.tip,
          c.summonDealt > 0 ? `${t('showstopper.Stats.SummonDamage')}: ${this.#fmtExact(c.summonDealt)}` : ''
        ].filter(Boolean).join(' · '),
        dmgTakenRaw: c.dmgTaken,
        dmgTakenFmt: fTaken.text,
        dmgTakenTip: fTaken.tip,
        downs,
        downsTip: downs > 0 ? `${t('showstopper.Stats.Downs')}: ${downs}` : '',
        healingRaw: c.healing,
        healingFmt: fHeal.text,
        healingTip: [
          fHeal.tip,
          c.healingReceived > 0 ? `${t('showstopper.Stats.HealingReceived')}: ${this.#fmtExact(c.healingReceived)}` : ''
        ].filter(Boolean).join(' · '),
        killsRaw: c.kills,
        killsFmt: fKills.text,
        kills: c.kills,
        killsTip: fKills.tip,
        savesRaw: c.saveSortVal,
        savesDisplay: c.saveTotal > 0 ? `${c.saveSucc}/${c.saveTotal}` : '\u2014',
        savesTip: saveTipParts.join(' · '),
        luckRaw: c.luckSortVal,
        nat20: c.nat20,
        nat1: c.nat1,
        hasLuck: c.nat20 > 0 || c.nat1 > 0
      };
    });
  }

  #buildDetailContext(charEntry: any): any {
    if (!charEntry?.data) return null;
    const s = charEntry.data;
    const atk = s.attacks || {};
    const dmg = s.damage || {};
    const heal = s.healing || {};
    const ss = s.saveSummary || {};
    const ds = s.deathSaves || {};
    const conc = s.concentration || {};

    const actor = RollStats._resolveStatActor(charEntry.id);
    const canOpenSheet = Boolean(actor?.sheet && actor.testUserPermission?.(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER));

    const chips: string[] = [];
    if (charEntry.summonerId) {
      chips.push(`${t('showstopper.Stats.Summoner')}: ${RollStats._getCharName(charEntry.summonerId)}`);
    }
    if ((s.advantageCount || 0) > 0) chips.push(`${t('DND5E.Advantage')}: ${this.#fmtExact(s.advantageCount)}`);
    if ((s.disadvantageCount || 0) > 0) chips.push(`${t('DND5E.Disadvantage')}: ${this.#fmtExact(s.disadvantageCount)}`);
    if ((s.dcCount || 0) > 0) chips.push(`${t('showstopper.Stats.AvgDC')}: ${RollStats._avg(s.dcSum || 0, s.dcCount)}`);

    const fAtk = this.#fmtStat(atk.total || 0);
    const fCrits = this.#fmtStat(atk.crits || 0);
    const fFumbles = this.#fmtStat(atk.fumbles || 0);
    const fKills = this.#fmtStat(s.kills || 0);
    const fDealt = this.#fmtStat(dmg.dealt || 0);
    const dealtTip = [
      fDealt.tip,
      (dmg.summonDealt || 0) > 0 ? `${t('showstopper.Stats.SummonDamage')}: ${this.#fmtExact(dmg.summonDealt)}` : ''
    ].filter(Boolean).join(' · ');
    const fTaken = this.#fmtStat(dmg.taken || 0);
    const fHealRecv = this.#fmtStat(heal.received ?? heal.total ?? 0);
    const fHealGiven = this.#fmtStat(heal.given || 0);

    const critRate = atk.total > 0 ? ` (${RollStats._pct(atk.crits || 0, atk.total)}%)` : '';
    const fumbleRate = atk.total > 0 ? ` (${RollStats._pct(atk.fumbles || 0, atk.total)}%)` : '';

    const statGroups = [
      {
        title: t('showstopper.Stats.SectionCombat'),
        icon: 'fa-solid fa-crosshairs',
        metrics: [
          { label: t('DND5E.AttackPl'), value: fAtk.text, tooltip: fAtk.tip, toneClass: '' },
          { label: t('DND5E.CriticalHit'), value: `${fCrits.text}${critRate}`, tooltip: fCrits.tip, toneClass: (atk.crits || 0) > 0 ? 'ss-st-tone-crit' : '' },
          { label: t('showstopper.Stats.Fumbles'), value: `${fFumbles.text}${fumbleRate}`, tooltip: fFumbles.tip, toneClass: (atk.fumbles || 0) > 0 ? 'ss-st-tone-fail' : '' },
          { label: t('showstopper.Stats.Kills'), value: fKills.text, tooltip: fKills.tip, toneClass: (s.kills || 0) > 0 ? 'ss-st-tone-emph' : '' }
        ]
      },
      {
        title: t('showstopper.Stats.SectionSurvival'),
        icon: 'fa-solid fa-shield-halved',
        metrics: [
          { label: t('showstopper.Stats.DamageDealt'), value: fDealt.text, tooltip: dealtTip, toneClass: '' },
          { label: t('showstopper.Stats.Taken'), value: fTaken.text, tooltip: fTaken.tip, toneClass: '' },
          { label: t('showstopper.Stats.HealingReceived'), value: fHealRecv.text, tooltip: fHealRecv.tip, toneClass: (heal.received || 0) > 0 ? 'ss-st-tone-heal' : '' },
          { label: t('showstopper.Stats.HealingGiven'), value: fHealGiven.text, tooltip: fHealGiven.tip, toneClass: (heal.given || 0) > 0 ? 'ss-st-tone-heal' : '' },
          ...((dmg.downs || 0) > 0 ? [{ label: t('showstopper.Stats.Downs'), value: this.#fmtExact(dmg.downs), tooltip: '', toneClass: 'ss-st-tone-fail' }] : [])
        ]
      },
      {
        title: t('showstopper.Stats.SectionSaves'),
        icon: 'fa-solid fa-dice-d20',
        metrics: [
          { label: t('DND5E.SAVE.Title.other'), value: ss.total ? `${ss.successes}/${ss.total}` : '\u2014', tooltip: '', toneClass: '' },
          { label: t('showstopper.Stats.Concentration'), value: conc.total ? `${conc.successes}/${conc.total}` : '\u2014', tooltip: '', toneClass: '' },
          {
            label: t('DND5E.DeathSave'),
            value: ds.total ? `${ds.successes}/${ds.total}` : '\u2014',
            tooltip: ds.critSuccess || ds.critFail
              ? [
                  ds.critSuccess ? `${t('showstopper.Stats.CritSave')}: ${ds.critSuccess}` : '',
                  ds.critFail ? `${t('showstopper.Stats.CritFail')}: ${ds.critFail}` : ''
                ].filter(Boolean).join(' · ')
              : '',
            toneClass: ''
          },
          {
            label: `${t('showstopper.Stats.Nat20')} / ${t('showstopper.Stats.Nat1')}`,
            value: `${s.nat20 || 0} / ${s.nat1 || 0}`,
            tooltip: '',
            toneClass: (s.nat20 || 0) > 0 ? 'ss-st-tone-nat20' : ''
          }
        ]
      }
    ];

    // Weapons breakdown (merges pending repository writes with saved flags)
    const weaponEntries: any[] = RollStats._getWeaponEntries(actor);
    weaponEntries.sort((a, b) => (b.damage || 0) - (a.damage || 0) || (b.total || 0) - (a.total || 0));
    const weapons = weaponEntries.map(w => {
      const fDmg = this.#fmtStat(w.damage || 0);
      return {
        name: w.name,
        total: this.#fmtExact(w.total || 0),
        crits: this.#fmtExact(w.crits || 0),
        damage: w.damage ? fDmg.text : '\u2014',
        dmgTip: fDmg.tip
      };
    });

    // Spells breakdown (include spells with damage > 0 even if count === 0)
    const spells = (Object.entries(s.spells?.byName || {}) as [string, any][])
      .filter(([, v]) => (v?.count || 0) > 0 || (v?.damage || 0) > 0)
      .sort((a, b) => (b[1].count || 0) - (a[1].count || 0) || (b[1].damage || 0) - (a[1].damage || 0))
      .slice(0, 12)
      .map(([name, v]) => {
        const fDmg = this.#fmtStat(v.damage || 0);
        return {
          name,
          countDisplay: v.count > 0 ? this.#fmtExact(v.count) : '\u2014',
          dmgDisplay: v.damage > 0 ? fDmg.text : '\u2014',
          dmgTip: fDmg.tip
        };
      });

    // Damage types bars
    const rawDmgTypes = (Object.entries(dmg.byType || {}) as [string, any][])
      .filter(([, v]) => Number(v) > 0)
      .sort((a, b) => Number(b[1]) - Number(a[1]));
    const totalTypedDmg = rawDmgTypes.reduce((sum, [, v]) => sum + Number(v), 0);
    const maxTypedDmg = rawDmgTypes.length ? Number(rawDmgTypes[0][1]) : 0;
    const damageTypes = rawDmgTypes.map(([type, val]) => {
      const fVal = this.#fmtStat(Number(val));
      const pct = totalTypedDmg > 0 ? Math.round((Number(val) / totalTypedDmg) * 100) : 0;
      const barWidth = maxTypedDmg > 0 ? Math.max(4, Math.round((Number(val) / maxTypedDmg) * 100)) : 0;
      return {
        label: RollStats._locDamageType(type),
        val: fVal.text,
        valTip: fVal.tip,
        pct,
        barWidth,
        color: DAMAGE_TYPE_COLORS[type] || '#60a5fa'
      };
    });

    // Spell levels bars
    const rawSpellLevels = (Object.entries(s.spells?.byLevel || {}) as [string, any][])
      .filter(([, v]) => Number(v) > 0)
      .sort((a, b) => Number(a[0]) - Number(b[0]));
    const totalLevelCasts = rawSpellLevels.reduce((sum, [, v]) => sum + Number(v), 0);
    const maxLevelCasts = rawSpellLevels.reduce((m, [, v]) => Math.max(m, Number(v)), 0);
    const spellLevels = rawSpellLevels.map(([lvl, val], idx) => {
      const pct = totalLevelCasts > 0 ? Math.round((Number(val) / totalLevelCasts) * 100) : 0;
      const barWidth = maxLevelCasts > 0 ? Math.max(4, Math.round((Number(val) / maxLevelCasts) * 100)) : 0;
      return {
        label: RollStats._locSpellLevel(lvl),
        val: this.#fmtExact(Number(val)),
        pct,
        barWidth,
        color: `hsl(${215 + idx * 18}, 75%, 60%)`
      };
    });

    // Skills, saves, tools + raw ability checks
    const skills = (Object.entries(s.checks?.skill || {}) as [string, any][])
      .filter(([, v]) => (v?.total || 0) > 0)
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 12)
      .map(([sk, v]) => ({
        label: RollStats._locSkill(sk),
        total: this.#fmtExact(v.total),
        best: v.best || '\u2014'
      }));

    const saves = (Object.entries(s.checks?.save || {}) as [string, any][])
      .filter(([, v]) => (v?.total || 0) > 0)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([abl, v]) => ({
        label: RollStats._locAbl(abl),
        total: this.#fmtExact(v.total),
        successDisplay: `${v.successes || 0}/${v.total}`
      }));

    const otherChecks: any[] = [];
    for (const [tl, v] of (Object.entries(s.checks?.tool || {}) as [string, any][])) {
      if ((v?.total || 0) <= 0) continue;
      otherChecks.push({
        label: RollStats._locTool(tl),
        total: this.#fmtExact(v.total),
        best: v.best || '\u2014'
      });
    }
    if ((s.checks?.abilityCheck?.total || 0) > 0) {
      otherChecks.push({
        label: t('showstopper.Stats.AbilityChecks'),
        total: this.#fmtExact(s.checks.abilityCheck.total),
        best: s.checks.abilityCheck.best || '\u2014'
      });
    }

    const hasBreakdowns = weapons.length > 0
      || spells.length > 0
      || damageTypes.length > 0
      || spellLevels.length > 0
      || skills.length > 0
      || saves.length > 0
      || otherChecks.length > 0;

    return {
      id: charEntry.id,
      name: charEntry.name,
      portrait: charEntry.portrait,
      isPC: charEntry.isPC,
      canOpenSheet,
      chips,
      statGroups,
      hasBreakdowns,
      weapons,
      spells,
      damageTypes,
      spellLevels,
      skills,
      saves,
      otherChecks,
      labels: {
        weapon: t('TYPES.Item.weapon', 'Weapon'),
        weapons: t('TYPES.Item.weaponPl', t('TYPES.Item.weapon', 'Weapons'))
      }
    };
  }

  #buildRollLogRows(): any[] {
    const entries = RollStats._rollLog.slice(-100).reverse();
    const q = this.searchQuery.trim().toLowerCase();
    const timeFmt = new Intl.DateTimeFormat(game.i18n?.lang || undefined, {
      hour: '2-digit',
      minute: '2-digit'
    });

    const catMeta: Record<string, { icon: string; label: string }> = {
      attack: { icon: 'fa-solid fa-crosshairs', label: t('DND5E.Attack') },
      save: { icon: 'fa-solid fa-shield-halved', label: t('DND5E.SAVE.Title.one', t('DND5E.SAVE.Title.other')) },
      skill: { icon: 'fa-solid fa-compass', label: t('DND5E.Skill') },
      abilityCheck: { icon: 'fa-solid fa-chart-simple', label: t('showstopper.Stats.AbilityChecks') },
      tool: { icon: 'fa-solid fa-screwdriver-wrench', label: t('showstopper.Stats.Tools') },
      deathSave: { icon: 'fa-solid fa-skull', label: t('DND5E.DeathSave') },
      concentration: { icon: 'fa-solid fa-brain', label: t('showstopper.Stats.Concentration') }
    };

    const rows: any[] = [];
    for (const e of entries) {
      if (this.pcOnly && !RollStats._isCharPC(e.actorId)) continue;
      const actorName = RollStats._getCharName(e.actorId);
      const portrait = RollStats._getCharPortrait(e.actorId);

      let rollLabel = '';
      if (e.cat === 'skill') rollLabel = RollStats._locSkill(e.name);
      else if (e.cat === 'save' || e.cat === 'abilityCheck') rollLabel = RollStats._locAbl(e.name);
      else if (e.cat === 'tool') rollLabel = RollStats._locTool(e.name);
      else if (e.cat === 'deathSave') rollLabel = t('DND5E.DeathSave');
      else if (e.cat === 'concentration') rollLabel = e.name ? `${t('showstopper.Stats.Concentration')} (${RollStats._locAbl(e.name)})` : t('showstopper.Stats.Concentration');
      else rollLabel = e.name || catMeta[e.cat]?.label || t('DND5E.Roll');

      if (q && !String(actorName).toLowerCase().includes(q) && !String(rollLabel).toLowerCase().includes(q)) {
        continue;
      }

      const badges: { tone: string; label: string }[] = [];
      if (e.nat20) badges.push({ tone: 'nat20', label: t('showstopper.Stats.Nat20') });
      if (e.nat1) badges.push({ tone: 'nat1', label: t('showstopper.Stats.Nat1') });
      if (e.crit) badges.push({ tone: 'crit', label: t('DND5E.CriticalHit') });
      if (e.fumble) badges.push({ tone: 'fail', label: t('showstopper.Stats.Fumbles') });
      if (e.success === true) badges.push({ tone: 'success', label: t('showstopper.Stats.Success') });
      else if (e.success === false) badges.push({ tone: 'fail', label: t('showstopper.Stats.Fail') });

      const hasTotal = e.total !== undefined && e.total !== null;
      const totalDisplay = hasTotal ? e.total : (e.result ?? '\u2014');
      const d20Sub = (hasTotal && e.result && e.result !== e.total) ? `d20: ${e.result}` : '';

      rows.push({
        time: e.time ? timeFmt.format(new Date(e.time)) : '',
        actorId: e.actorId,
        actorName,
        portrait,
        icon: catMeta[e.cat]?.icon || 'fa-solid fa-dice-d20',
        catLabel: catMeta[e.cat]?.label || t('DND5E.Roll'),
        rollLabel,
        totalDisplay,
        d20Sub,
        badges
      });
    }
    return rows;
  }

  async _prepareContext(_options?: any) {
    const allChars = this.#buildCharList();
    const view = this.#filterAndSortChars(allChars);

    if (view.length && (!this.selectedCharId || !view.some(c => c.id === this.selectedCharId))) {
      this.selectedCharId = view[0].id;
    } else if (!view.length) {
      this.selectedCharId = null;
    }

    const selectedEntry = view.find(c => c.id === this.selectedCharId) || null;
    const characterList = view.map(c => {
      const dealt = this.#fmtStat(c.dmgDealt).text;
      const dmgSuffix = t('showstopper.Stats.DamageUnits', 'dmg');
      return {
        id: c.id,
        name: c.name,
        portrait: c.portrait,
        isPC: c.isPC,
        selected: c.id === this.selectedCharId,
        metaLine: c.dmgDealt > 0
          ? `${dealt} ${dmgSuffix} · ${this.#fmtExact(c.atkTotal)} ${t('DND5E.AttackPl').toLowerCase()}`
          : `${this.#fmtExact(c.atkTotal)} ${t('DND5E.AttackPl').toLowerCase()}`
      };
    });

    return {
      isGM: Boolean(game.user?.isGM),
      statsEnabled: Boolean(game.settings.get(MODULE_ID, 'statsEnabled')),
      isSession: this.period === 'session',
      isAllTime: this.period === 'all',
      sessionDuration: this.#formatSessionDuration(),
      pcOnly: this.pcOnly,
      searchQuery: this.searchQuery,
      isTabOverview: this.activeTab === 'overview',
      isTabCharacters: this.activeTab === 'characters',
      isTabLog: this.activeTab === 'log',
      hasAnyStats: allChars.length > 0 || RollStats._rollLog.length > 0,
      summaryCards: this.#buildSummaryCards(view),
      overviewCols: this.#buildOverviewCols(),
      overviewRows: this.#buildOverviewRows(view),
      characterList,
      detail: this.#buildDetailContext(selectedEntry),
      logRows: this.#buildRollLogRows()
    };
  }

  _onRender(_context: any, options: any) {
    const parts = options?.parts || [];
    if (parts.includes('toolbar') || !parts.length) {
      const searchInput = this.element?.querySelector('.ss-st-search__input');
      const clearBtn = this.element?.querySelector('.ss-st-search__clear');
      if (searchInput) {
        searchInput.addEventListener('input', () => {
          this.searchQuery = searchInput.value || '';
          if (clearBtn) clearBtn.hidden = !this.searchQuery;
          if (this.#searchTimer) clearTimeout(this.#searchTimer);
          this.#searchTimer = setTimeout(() => {
            this.#searchTimer = null;
            this.render({ parts: ['body'] });
          }, 120);
        });
      }

      const enabledInput = this.element?.querySelector('.ss-st-enabled__input');
      if (enabledInput) {
        enabledInput.addEventListener('change', async () => {
          if (!game.user?.isGM) return;
          await game.settings.set(MODULE_ID, 'statsEnabled', Boolean(enabledInput.checked));
        });
      }

      const tabList = this.element?.querySelector('.ss-st-tabs');
      if (tabList) {
        tabList.addEventListener('keydown', (e: any) => {
          const tabs = [...tabList.querySelectorAll('[role="tab"]')];
          const idx = tabs.indexOf(e.target);
          if (idx === -1) return;
          let nextIdx = -1;
          if (e.key === 'ArrowRight') nextIdx = (idx + 1) % tabs.length;
          else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + tabs.length) % tabs.length;
          else if (e.key === 'Home') nextIdx = 0;
          else if (e.key === 'End') nextIdx = tabs.length - 1;
          if (nextIdx === -1) return;
          e.preventDefault();
          const nextTab = tabs[nextIdx];
          nextTab.focus();
          this.activateTab(nextTab.dataset.tab);
        });
      }
    }
  }

  activateTab(tabId: 'overview' | 'characters' | 'log') {
    if (!tabId || tabId === this.activeTab) return;
    this.activeTab = tabId;
    const root = this.element;
    if (!root) return;

    root.querySelectorAll('.ss-st-tab[role="tab"]').forEach(btn => {
      const active = btn.dataset.tab === tabId;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
      btn.setAttribute('tabindex', active ? '0' : '-1');
    });

    root.querySelectorAll('.ss-st-panel[role="tabpanel"]').forEach(panel => {
      panel.hidden = panel.dataset.tabPanel !== tabId;
    });
  }

  clearSearch() {
    if (this.#searchTimer) {
      clearTimeout(this.#searchTimer);
      this.#searchTimer = null;
    }
    this.searchQuery = '';
    const input = this.element?.querySelector('.ss-st-search__input');
    const clearBtn = this.element?.querySelector('.ss-st-search__clear');
    if (input) {
      input.value = '';
      input.focus();
    }
    if (clearBtn) clearBtn.hidden = true;
    this.render({ parts: ['body'] });
  }

  static #onSwitchTab(this: StatsApp, _event: any, target: any) {
    const tabId = target?.dataset?.tab;
    if (tabId) this.activateTab(tabId);
  }

  static #onSetPeriod(this: StatsApp, _event: any, target: any) {
    const period = target?.dataset?.period;
    if (!period || period === this.period) return;
    this.period = period;
    this.render({ force: true });
  }

  static #onSetFilter(this: StatsApp, _event: any, target: any) {
    const pcOnly = target?.dataset?.filter === 'pc';
    if (pcOnly === this.pcOnly) return;
    this.pcOnly = pcOnly;
    this.render({ force: true });
  }

  static #onClearSearch(this: StatsApp) {
    this.clearSearch();
  }

  static #onSortTable(this: StatsApp, _event: any, target: any) {
    const sortKey = target?.dataset?.sortKey;
    const sortType = target?.dataset?.sortType || 'number';
    const th = target?.closest('th');
    const table = th?.closest('table');
    const tbody = table?.tBodies?.[0];
    if (!sortKey || !th || !table || !tbody) return;

    const colIdx = th.cellIndex;
    const nextDir: 'asc' | 'desc' = this.sortKey === sortKey
      ? (this.sortDir === 'asc' ? 'desc' : 'asc')
      : (sortType === 'text' ? 'asc' : 'desc');

    this.sortKey = sortKey;
    this.sortDir = nextDir;

    table.querySelectorAll('thead th[scope="col"]').forEach(header => {
      header.removeAttribute('aria-sort');
      const icon = header.querySelector('.ss-st-sort-icon');
      if (icon) icon.className = 'fa-solid fa-sort ss-st-sort-icon';
    });
    th.setAttribute('aria-sort', nextDir === 'asc' ? 'ascending' : 'descending');
    const activeIcon = th.querySelector('.ss-st-sort-icon');
    if (activeIcon) activeIcon.className = `fa-solid ${nextDir === 'asc' ? 'fa-sort-up' : 'fa-sort-down'} ss-st-sort-icon`;

    const rows = [...tbody.rows];
    const collator = new Intl.Collator(game.i18n?.lang || undefined, { numeric: true, sensitivity: 'base' });
    const dir = nextDir === 'asc' ? 1 : -1;

    rows.sort((a, b) => {
      const av = a.cells[colIdx]?.dataset.value ?? a.cells[colIdx]?.textContent?.trim() ?? '';
      const bv = b.cells[colIdx]?.dataset.value ?? b.cells[colIdx]?.textContent?.trim() ?? '';
      if (sortType === 'number') {
        const na = Number(av);
        const nb = Number(bv);
        if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return (na - nb) * dir;
      } else {
        const cmp = collator.compare(av, bv);
        if (cmp !== 0) return cmp * dir;
      }
      const nameA = a.cells[0]?.dataset.value ?? '';
      const nameB = b.cells[0]?.dataset.value ?? '';
      return collator.compare(nameA, nameB);
    });

    for (const row of rows) {
      if (typeof (tbody as any).moveBefore === 'function') {
        (tbody as any).moveBefore(row, null);
      } else {
        tbody.appendChild(row);
      }
    }

    const status = this.element?.querySelector('[data-sort-status]');
    if (status) {
      const colLabel = target.querySelector('span')?.textContent?.trim() || sortKey;
      status.textContent = tf(nextDir === 'asc' ? 'showstopper.Stats.SortedAsc' : 'showstopper.Stats.SortedDesc', {
        column: colLabel
      });
    }
  }

  static #onSelectChar(this: StatsApp, _event: any, target: any) {
    const charId = target?.closest('[data-char]')?.dataset.char;
    if (!charId) return;
    this.selectCharacter(charId);
  }

  static #onOpenSheet(this: StatsApp, _event: any, target: any) {
    const charId = target?.closest('[data-char]')?.dataset.char || this.selectedCharId;
    if (!charId) return;
    const actor = RollStats._resolveStatActor(charId);
    actor?.sheet?.render({ force: true });
  }

  static #onExportChar(this: StatsApp, _event: any, target: any) {
    const charId = target?.closest('[data-char]')?.dataset.char || this.selectedCharId;
    if (charId) RollStats._exportToChat(charId, this.period);
  }

  static #onExportSummary(this: StatsApp) {
    RollStats._exportSummaryToChat(this.period, this.pcOnly);
  }

  static async #onNewSession(this: StatsApp) {
    await RollStats.newSession();
    this.expandedChars.clear();
    this.render({ force: true });
  }

  static async #onResetStats(this: StatsApp) {
    await RollStats.resetStats();
    this.expandedChars.clear();
    this.selectedCharId = null;
    this.render({ force: true });
  }
}

export { StatsApp };
