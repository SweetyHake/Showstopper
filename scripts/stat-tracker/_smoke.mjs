// Stat tracker smoke test outside Foundry: verifies attacks, AoE damage,
// healing (overheal/tempHP/midi-undo), summon attribution (dnd5e/CAT/CPR),
// death saves, unlinked token key dedup, weapon flags, and StatsApp aggregation.
// Run: node scripts/stat-tracker/_smoke.mjs

import assert from 'node:assert/strict';

/* ------------------------------ Foundry stubs ------------------------------ */

function getProperty(obj, path) {
  if (!obj || !path) return undefined;
  return path.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

function setProperty(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
  return true;
}

function hasProperty(obj, path) {
  return getProperty(obj, path) !== undefined;
}

function deepClone(val) {
  if (val == null || typeof val !== 'object') return val;
  return structuredClone(val);
}

const hooksMap = new Map();
globalThis.Hooks = {
  on(name, fn) {
    if (!hooksMap.has(name)) hooksMap.set(name, []);
    hooksMap.get(name).push(fn);
  },
  once(name, fn) {
    this.on(name, fn);
  },
  call(name, ...args) {
    for (const fn of hooksMap.get(name) || []) {
      if (fn(...args) === false) return false;
    }
    return true;
  }
};

globalThis.window = { addEventListener() {} };
globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { OBSERVER: 2 } };

class D20Roll {
  constructor({ total = 15, result = 10, isCritical = false, isFumble = false, hasAdvantage = false, hasDisadvantage = false, options = {}, formula = '1d20 + 5' } = {}) {
    this.total = total;
    this.formula = formula;
    this.isCritical = isCritical;
    this.isFumble = isFumble;
    this.hasAdvantage = hasAdvantage;
    this.hasDisadvantage = hasDisadvantage;
    this.options = options;
    this.validD20Roll = true;
    this.dice = [{ faces: 20, results: [{ result, active: true }] }];
  }
}

class DamageRoll {
  constructor({ total = 10, type = 'slashing', types = null, formula = '2d6 + 3' } = {}) {
    this.total = total;
    this.formula = formula;
    this.options = types ? { types } : (type ? { type } : {});
    this.dice = [{ faces: 6, results: [{ result: 4, active: true }] }];
  }
}

globalThis.CONFIG = {
  Dice: { D20Roll, DamageRoll },
  DND5E: {
    healingTypes: { healing: { label: 'Healing' }, temphp: { label: 'Temp HP' } },
    damageTypes: {
      slashing: { label: 'Slashing' },
      piercing: { label: 'Piercing' },
      fire: { label: 'Fire' }
    },
    abilities: { con: { label: 'Constitution' }, dex: { label: 'Dexterity' } },
    skills: { prc: { label: 'Perception' } },
    spellLevels: { 0: 'Cantrip', 3: '3rd Level', 4: '4th Level' }
  }
};

const uuidRegistry = new Map();

class FakeItem {
  constructor({ id, uuid, name, type = 'weapon', level = 0, baseItem = '', actor = null }) {
    this.id = id;
    this.uuid = uuid;
    this.documentName = 'Item';
    this.name = name;
    this.type = type;
    this.actor = actor;
    this.parent = actor;
    this.flags = {};
    this.system = { level, type: { baseItem } };
    uuidRegistry.set(uuid, this);
  }
  getFlag(scope, key) { return getProperty(this.flags?.[scope], key); }
  async setFlag(scope, key, val) {
    this.flags[scope] ??= {};
    setProperty(this.flags[scope], key, deepClone(val));
    return this;
  }
  async unsetFlag(scope, key) {
    if (this.flags?.[scope]) delete this.flags[scope][key];
    return this;
  }
}

class Actor {
  constructor({ id, uuid, name, type = 'character', hp = 30, maxHp = 30, temp = 0, hasPlayerOwner = true, isToken = false, token = null, flags = {} }) {
    this.id = id;
    this.uuid = uuid || `Actor.${id}`;
    this.name = name;
    this.type = type;
    this.hasPlayerOwner = hasPlayerOwner;
    this.isToken = isToken;
    this.token = token;
    this.flags = deepClone(flags);
    this.items = [];
    this.img = 'portraits/hero.webp';
    this.sheet = { render() {} };
    this.system = {
      attributes: {
        hp: { value: hp, max: maxHp, effectiveMax: maxHp, temp },
        concentration: { ability: 'con' }
      }
    };
    uuidRegistry.set(this.uuid, this);
  }
  addItem(opts) {
    const item = new FakeItem({ ...opts, uuid: opts.uuid || `${this.uuid}.Item.${opts.id}`, actor: this });
    this.items.push(item);
    return item;
  }
  testUserPermission() { return true; }
  getFlag(scope, key) {
    if (this.isToken && this.token) {
      return getProperty(this.token.actorData?.flags?.[scope], key) ?? getProperty(this.flags?.[scope], key);
    }
    return getProperty(this.flags?.[scope], key);
  }
  async setFlag(scope, key, val) {
    const cloned = deepClone(val);
    if (this.isToken && this.token) {
      this.token.actorData.flags[scope] ??= {};
      setProperty(this.token.actorData.flags[scope], key, cloned);
    } else {
      this.flags[scope] ??= {};
      setProperty(this.flags[scope], key, cloned);
    }
    return this;
  }
  async unsetFlag(scope, key) {
    if (this.isToken && this.token?.actorData?.flags?.[scope]) {
      delete this.token.actorData.flags[scope][key];
    }
    if (this.flags?.[scope]) delete this.flags[scope][key];
    return this;
  }
}

globalThis.Actor = Actor;
globalThis.fromUuidSync = (uuid) => uuidRegistry.get(uuid) ?? null;

class FakeApplicationV2 {
  constructor() { this.element = null; }
  async render() { return this; }
  async close() {}
}

const appInstances = new Map();
globalThis.foundry = {
  utils: { getProperty, setProperty, hasProperty, deepClone },
  applications: {
    instances: appInstances,
    api: {
      ApplicationV2: FakeApplicationV2,
      HandlebarsApplicationMixin: (Base) => class extends Base {},
      DialogV2: { confirm: async () => true }
    }
  }
};

const settingsStore = new Map([
  ['showstopper.stats', {}],
  ['showstopper.statsEnabled', true],
  ['showstopper.statsLog', []]
]);

const actorsMap = new Map();
actorsMap[Symbol.iterator] = function* () { yield* this.values(); };

const messagesList = [];
let midiActive = false;

globalThis.ChatMessage = {
  create: async (msg) => { messagesList.push(msg); return msg; },
  getWhisperRecipients: () => [{ id: 'gm1' }]
};

globalThis.ui = { notifications: { info() {}, warn() {} } };

globalThis.game = {
  user: { id: 'gm1', isGM: true, active: true },
  users: Object.assign([{ id: 'gm1', isGM: true, active: true }], {
    activeGM: { id: 'gm1', isGM: true, active: true }
  }),
  system: { id: 'dnd5e', version: '6.0.6' },
  dnd5e: { config: CONFIG.DND5E },
  modules: {
    get(id) {
      if (id === 'midi-qol') return { active: midiActive };
      return undefined;
    }
  },
  settings: {
    register() {},
    registerMenu() {},
    get(scope, key) { return settingsStore.get(`${scope}.${key}`); },
    async set(scope, key, val) { settingsStore.set(`${scope}.${key}`, deepClone(val)); return val; }
  },
  i18n: {
    lang: 'ru',
    localize: (k) => k,
    format: (k, d) => `${k}:${JSON.stringify(d)}`
  },
  actors: {
    get: (id) => actorsMap.get(id),
    [Symbol.iterator]: function* () { yield* actorsMap.values(); }
  },
  scenes: [],
  messages: { contents: messagesList, [Symbol.iterator]: function* () { yield* messagesList; } },
  socket: { on() {}, emit() {} }
};

/* ------------------------------ Load modules ------------------------------ */

const { RollStats } = await import('./roll-stats.mjs');
const { StatsApp } = await import('./stats-app.mjs');
await RollStats.init();

/* ------------------------------ Fixtures ------------------------------ */

function makeLinkedActor(id, name, opts = {}) {
  const a = new Actor({ id, name, ...opts });
  actorsMap.set(id, a);
  return a;
}

function makeUnlinkedToken(sceneId, tokenId, baseActorId, name, opts = {}) {
  const tokenDoc = {
    id: tokenId,
    uuid: `Scene.${sceneId}.Token.${tokenId}`,
    actorId: baseActorId,
    actorLink: false,
    actorData: { flags: deepClone(opts.actorDataFlags || {}) },
    flags: deepClone(opts.tokenFlags || {}),
    texture: { src: 'tokens/goblin.webp' },
    actor: null
  };
  const synth = new Actor({
    id: baseActorId,
    uuid: `${tokenDoc.uuid}.Actor.${baseActorId}`,
    name,
    type: 'npc',
    hasPlayerOwner: false,
    isToken: true,
    token: tokenDoc,
    ...opts
  });
  tokenDoc.actor = synth;
  uuidRegistry.set(tokenDoc.uuid, tokenDoc);
  let scene = game.scenes.find(s => s.id === sceneId);
  if (!scene) {
    scene = { id: sceneId, tokens: [] };
    game.scenes.push(scene);
  }
  scene.tokens.push(tokenDoc);
  return { tokenDoc, actor: synth };
}

function applyHpUpdate(actor, updates) {
  const oldHp = actor.system.attributes.hp.value;
  const newHp = updates['system.attributes.hp.value'];
  if (newHp !== undefined) {
    RollStats._onPreUpdateActor(actor, { system: { attributes: { hp: { value: newHp } } } }, {}, 'gm1');
    actor.system.attributes.hp.value = newHp;
  }
  if (updates['system.attributes.hp.temp'] !== undefined) {
    actor.system.attributes.hp.temp = updates['system.attributes.hp.temp'];
  }
  return oldHp;
}

/* ------------------------------ 1. Weapon Attacks & Kills ------------------------------ */

const fighter = makeLinkedActor('fighter1', 'Fighter', { hp: 40, maxHp: 40 });
const greatsword = fighter.addItem({ id: 'gs1', name: 'Greatsword', type: 'weapon', baseItem: 'greatsword' });

const { actor: goblin1 } = makeUnlinkedToken('sc1', 'tokGob1', 'baseGob', 'Goblin 1', { hp: 20, maxHp: 20, temp: 5 });

// 1a. Activity attack roll + dnd5e 6.0 attack message (must deduplicate to 1 attack)
const atkRoll1 = new D20Roll({ total: 25, result: 20, isCritical: true });
RollStats._onAttackRoll([atkRoll1], { subject: { actor: fighter, item: greatsword } });
RollStats._onPreCreateChatMessage({
  id: null,
  type: 'attack',
  author: { id: 'gm1' },
  speaker: { actor: fighter.id },
  system: { item: { uuid: greatsword.uuid } },
  getAssociatedItem: () => greatsword,
  rolls: [new D20Roll({ total: 25, result: 20, isCritical: true })]
}, {}, 'gm1');

assert.equal(RollStats._getPeriodData(fighter.uuid, 'session').attacks.total, 1, 'Activity + preCreate attack must dedup to 1');
assert.equal(RollStats._getPeriodData(fighter.uuid, 'session').attacks.crits, 1, 'Crit recorded');

// 1b. Two identical standalone attacks via preCreateChatMessage (message.id === null) must BOTH count
RollStats._onPreCreateChatMessage({
  id: null,
  type: 'attack',
  author: { id: 'gm1' },
  speaker: { actor: fighter.id },
  system: { item: { uuid: greatsword.uuid } },
  getAssociatedItem: () => greatsword,
  rolls: [new D20Roll({ total: 14, result: 9 })]
}, {}, 'gm1');
RollStats._onPreCreateChatMessage({
  id: null,
  type: 'attack',
  author: { id: 'gm1' },
  speaker: { actor: fighter.id },
  system: { item: { uuid: greatsword.uuid } },
  getAssociatedItem: () => greatsword,
  rolls: [new D20Roll({ total: 14, result: 9 })]
}, {}, 'gm1');
assert.equal(RollStats._getPeriodData(fighter.uuid, 'session').attacks.total, 3, 'Two identical standalone attacks must not collapse on null id');

// 1c. Damage application in dnd5e 6.0 (no legacy flags.dnd5e.item.uuid; 5 tempHP + 7 HP = 12)
const dmgMsg1 = {
  type: 'damage',
  speaker: { actor: fighter.id },
  system: { item: { uuid: greatsword.uuid } },
  getAssociatedItem: () => greatsword,
  rolls: [new DamageRoll({ total: 12, type: 'slashing' })]
};
const upd1 = { 'system.attributes.hp.temp': 0, 'system.attributes.hp.value': 13 };
RollStats._onPreApplyDamage(goblin1, 12, upd1, { originatingMessage: dmgMsg1 });
applyHpUpdate(goblin1, upd1);

assert.equal(RollStats._getPeriodData(fighter.uuid, 'session').damage.dealt, 12, 'Hit damage includes tempHP + HP lost');
assert.equal(RollStats._getPeriodData(goblin1.uuid, 'session').damage.taken, 12, 'Goblin taken matches dealt');

// Immediate weapon stats BEFORE 5s debounce flush
const preFlushWeapons = RollStats._getWeaponEntries(fighter);
assert.equal(preFlushWeapons.length, 1);
assert.equal(preFlushWeapons[0].total, 3);
assert.equal(preFlushWeapons[0].damage, 12, 'Weapon damage available immediately from pending repository');

// 1d. Lethal blow with overkill (40 raw damage into 13 remaining HP -> 13 effective damage + 1 kill)
const updKill = { 'system.attributes.hp.temp': 0, 'system.attributes.hp.value': 0 };
RollStats._onPreApplyDamage(goblin1, 40, updKill, { originatingMessage: dmgMsg1 });
applyHpUpdate(goblin1, updKill);

assert.equal(RollStats._getPeriodData(fighter.uuid, 'session').damage.dealt, 25, 'Overkill clamped to remaining 13 HP');
assert.equal(RollStats._getPeriodData(fighter.uuid, 'session').kills, 1, 'Kill counted in core dnd5e');

// Hitting already dead corpse (0 HP -> 0 HP) adds 0 damage and 0 kills
RollStats._onPreApplyDamage(goblin1, 20, { 'system.attributes.hp.temp': 0, 'system.attributes.hp.value': 0 }, { originatingMessage: dmgMsg1 });
assert.equal(RollStats._getPeriodData(fighter.uuid, 'session').damage.dealt, 25, 'Corpse hit ignored');
assert.equal(RollStats._getPeriodData(fighter.uuid, 'session').kills, 1, 'Corpse kill ignored');

// Unlinked token key deduplication across flush + subsequent mutation
await RollStats._flushFlags();
RollStats._track(goblin1, 'save', { ability: 'dex', total: 10, dieResult: 8 });
const gobIds = RollStats._getAllCharIds().filter(id => id.includes('tokGob1'));
assert.equal(gobIds.length, 1, 'Unlinked token must have exactly one canonical stat key');

/* ------------------------------ 2. AoE Damage & Upcast ------------------------------ */

const wizard = makeLinkedActor('wizard1', 'Wizard', { hp: 28, maxHp: 28 });
const fireball = wizard.addItem({ id: 'fb1', name: 'Fireball', type: 'spell', level: 3 });

const usageCard = {
  id: 'msgFbUsage',
  type: 'usage',
  speaker: { actor: wizard.id },
  system: { level: 4, item: { uuid: fireball.uuid } },
  getAssociatedItem: () => fireball,
  rolls: [new D20Roll({ total: 18, result: 12 })], // e.g. merged card d20 roll must NOT pollute types.unknown
  getAssociatedRolls: (kind) => (kind === 'damage' ? [new DamageRoll({ total: 28, type: 'fire' })] : [])
};

RollStats._onPostUseActivity({ item: fireball, actor: wizard, type: 'save' }, {}, { message: usageCard });
assert.equal(RollStats._getPeriodData(wizard.uuid, 'session').spells.byLevel['4'], 1, 'Upcast 4th-level slot recorded');

const { actor: orc1 } = makeUnlinkedToken('sc1', 'tokOrc1', 'baseOrc', 'Orc 1', { hp: 30, maxHp: 30 });
const { actor: orc2 } = makeUnlinkedToken('sc1', 'tokOrc2', 'baseOrc', 'Orc 2', { hp: 30, maxHp: 30 });
const { actor: fireElem } = makeUnlinkedToken('sc1', 'tokElem', 'baseElem', 'Fire Elemental', { hp: 40, maxHp: 40 });
const { actor: kobold } = makeUnlinkedToken('sc1', 'tokKob', 'baseKob', 'Kobold', { hp: 6, maxHp: 6 });

// Failed save (28), half save (14), immune (0), lethal clamp (6 + kill)
RollStats._onPreApplyDamage(orc1, 28, { 'system.attributes.hp.value': 2, 'system.attributes.hp.temp': 0 }, { origin: usageCard });
applyHpUpdate(orc1, { 'system.attributes.hp.value': 2, 'system.attributes.hp.temp': 0 });

RollStats._onPreApplyDamage(orc2, 14, { 'system.attributes.hp.value': 16, 'system.attributes.hp.temp': 0 }, { origin: usageCard });
applyHpUpdate(orc2, { 'system.attributes.hp.value': 16, 'system.attributes.hp.temp': 0 });

RollStats._onPreApplyDamage(fireElem, 0, { 'system.attributes.hp.value': 40, 'system.attributes.hp.temp': 0 }, { origin: usageCard });

RollStats._onPreApplyDamage(kobold, 28, { 'system.attributes.hp.value': 0, 'system.attributes.hp.temp': 0 }, { origin: usageCard });
applyHpUpdate(kobold, { 'system.attributes.hp.value': 0, 'system.attributes.hp.temp': 0 });

const wizStats = RollStats._getPeriodData(wizard.uuid, 'session');
assert.equal(wizStats.damage.dealt, 48, 'AoE total dealt = 28 + 14 + 0 + 6');
assert.equal(wizStats.damage.byType.fire, 48, 'AoE fire damage matches dealt without D20Roll unknown pollution');
assert.equal(wizStats.damage.byType.unknown, undefined, 'No unknown damage from D20Roll');
assert.equal(wizStats.spells.byName['Fireball'].damage, 48, 'Spell damage attributed to Fireball');
assert.equal(wizStats.kills, 1, 'AoE kill counted');

/* ------------------------------ 3. Healing & Midi-QOL Undo ------------------------------ */

const cleric = makeLinkedActor('cleric1', 'Cleric', { hp: 35, maxHp: 35 });
const cureWounds = cleric.addItem({ id: 'cw1', name: 'Cure Wounds', type: 'spell', level: 1 });
const healCard = {
  id: 'msgHeal1',
  uuid: 'ChatMessage.msgHeal1',
  type: 'damage',
  speaker: { actor: cleric.id },
  system: { item: { uuid: cureWounds.uuid } },
  getAssociatedItem: () => cureWounds,
  getAssociatedActivity: () => ({ type: 'heal' }),
  rolls: [new DamageRoll({ total: 25, type: 'healing' })]
};
uuidRegistry.set(healCard.uuid, healCard);

// 3a. Fighter at 38/40 healed for raw -25 -> actual healed must be strictly 2!
fighter.system.attributes.hp.value = 38;
RollStats._onPreApplyDamage(fighter, -25, { 'system.attributes.hp.value': 40, 'system.attributes.hp.temp': 0 }, { originatingMessage: healCard });
applyHpUpdate(fighter, { 'system.attributes.hp.value': 40, 'system.attributes.hp.temp': 0 });

assert.equal(RollStats._getPeriodData(fighter.uuid, 'session').healing.received, 2, 'Overheal clamped to 2 actual HP');
assert.equal(RollStats._getPeriodData(cleric.uuid, 'session').healing.given, 2, 'Healer given clamped to 2 actual HP');

// 3b. Heal at full HP (40/40) -> 0
RollStats._onPreApplyDamage(fighter, -15, { 'system.attributes.hp.value': 40, 'system.attributes.hp.temp': 0 }, { originatingMessage: healCard });
assert.equal(RollStats._getPeriodData(cleric.uuid, 'session').healing.given, 2, 'Full HP overheal adds 0');

// 3c. Pure TempHP grant (40/40, temp 0 -> 10) -> 0 healing
RollStats._onPreApplyDamage(fighter, 0, { 'system.attributes.hp.value': 40, 'system.attributes.hp.temp': 10 }, { originatingMessage: healCard });
applyHpUpdate(fighter, { 'system.attributes.hp.value': 40, 'system.attributes.hp.temp': 10 });
assert.equal(RollStats._getPeriodData(fighter.uuid, 'session').healing.received, 2, 'TempHP grant is not healing');

// 3d. Manual multiplier -1 on a weapon damage card must NOT credit attacker with healing.given
orc1.system.attributes.hp.value = 10;
RollStats._onPreApplyDamage(orc1, -5, { 'system.attributes.hp.value': 15, 'system.attributes.hp.temp': 0 }, { originatingMessage: dmgMsg1, multiplier: -1 });
applyHpUpdate(orc1, { 'system.attributes.hp.value': 15, 'system.attributes.hp.temp': 0 });
assert.equal(RollStats._getPeriodData(fighter.uuid, 'session').healing.given, 0, 'Negative multiplier on weapon card does not make attacker a healer');

// 3e. Midi-QOL Undo of damage and Undo of 0->8 healing (no fake healing, no fake down)
midiActive = true;
const midiUndoCard = {
  id: 'midiDmgCard',
  flags: {
    'midi-qol': {
      itemCardUuid: 'ChatMessage.fbCard',
      undoDamage: [{
        actorUuid: orc2.uuid,
        oldHP: 30,
        newHP: 16,
        oldTempHP: 0,
        newTempHP: 0,
        calcDamageOptions: { midi: { sourceActorUuid: wizard.uuid, itemCardUuid: 'ChatMessage.fbCard' } }
      }]
    }
  }
};
messagesList.push(midiUndoCard);

// Revert orc2 from 16 back to 30
RollStats._onPreApplyDamage(
  orc2,
  16 - 30,
  { 'system.attributes.hp.value': 30, 'system.attributes.hp.temp': 0 },
  { origin: usageCard, midi: { sourceActorUuid: wizard.uuid, itemCardUuid: 'ChatMessage.fbCard' } }
);
applyHpUpdate(orc2, { 'system.attributes.hp.value': 30, 'system.attributes.hp.temp': 0 });

assert.equal(RollStats._getPeriodData(orc2.uuid, 'session').healing.received, 0, 'Midi Undo of damage must NOT log healing');
assert.equal(RollStats._getPeriodData(orc2.uuid, 'session').damage.taken, 0, 'Midi Undo rolled back orc2 taken damage');
assert.equal(RollStats._getPeriodData(wizard.uuid, 'session').damage.dealt, 34, 'Midi Undo rolled back wizard dealt damage (48 - 14 = 34)');

// Heal downed fighter 0 -> 8, then Midi Undo 8 -> 0 (must not trigger fake down)
fighter.system.attributes.hp.value = 0;
fighter.system.attributes.hp.temp = 0;
const downsBefore = RollStats._getPeriodData(fighter.uuid, 'session').damage.downs;
RollStats._onPreApplyDamage(
  fighter,
  -8,
  { 'system.attributes.hp.value': 8, 'system.attributes.hp.temp': 0 },
  { origin: healCard, midi: { sourceActorUuid: cleric.uuid, itemCardUuid: healCard.uuid } }
);
applyHpUpdate(fighter, { 'system.attributes.hp.value': 8, 'system.attributes.hp.temp': 0 });
assert.equal(RollStats._getPeriodData(cleric.uuid, 'session').healing.given, 10, 'Cleric healing given = 2 + 8');

messagesList.push({
  id: 'midiHealUndoCard',
  flags: {
    'midi-qol': {
      itemCardUuid: healCard.uuid,
      undoDamage: [{
        actorUuid: fighter.uuid,
        oldHP: 0,
        newHP: 8,
        oldTempHP: 0,
        newTempHP: 0,
        calcDamageOptions: { midi: { sourceActorUuid: cleric.uuid, itemCardUuid: healCard.uuid } }
      }]
    }
  }
});

RollStats._onPreApplyDamage(
  fighter,
  8,
  { 'system.attributes.hp.value': 0, 'system.attributes.hp.temp': 0 },
  { origin: healCard, midi: { sourceActorUuid: cleric.uuid, itemCardUuid: healCard.uuid } }
);
applyHpUpdate(fighter, { 'system.attributes.hp.value': 0, 'system.attributes.hp.temp': 0 });

assert.equal(RollStats._getPeriodData(cleric.uuid, 'session').healing.given, 2, 'Midi Undo rolled back cleric healing given');
assert.equal(RollStats._getPeriodData(fighter.uuid, 'session').damage.downs, downsBefore, 'Midi Undo of 0->8 heal did NOT add a fake down');
midiActive = false;

/* ------------------------------ 4. Summoned Creatures ------------------------------ */

const druid = makeLinkedActor('druid1', 'Druid', { hp: 32, maxHp: 32 });
const conjureAnimals = druid.addItem({ id: 'ca1', name: 'Conjure Animals', type: 'spell', level: 3 });
const animateDead = druid.addItem({ id: 'ad1', name: 'Animate Dead', type: 'spell', level: 3 });

// 4a. Native dnd5e summon (with player ownership = true, must still NOT be treated as PC)
const { actor: wolf } = makeUnlinkedToken('sc1', 'tokWolf', 'baseWolf', 'Dire Wolf (Summon)', {
  hp: 37,
  maxHp: 37,
  hasPlayerOwner: true,
  actorDataFlags: {
    dnd5e: { summon: { origin: `${conjureAnimals.uuid}.Activity.sum1`, level: 3 } }
  }
});

assert.equal(RollStats._isCharPC(wolf.uuid), false, 'Summon with player ownership must NOT be classified as PC');

const wolfBiteMsg = {
  type: 'damage',
  speaker: { scene: 'sc1', token: 'tokWolf', actor: 'baseWolf' },
  rolls: [new DamageRoll({ total: 15, type: 'piercing' })]
};
orc1.system.attributes.hp.value = 11;
RollStats._onPreApplyDamage(orc1, 15, { 'system.attributes.hp.value': 0, 'system.attributes.hp.temp': 0 }, { originatingMessage: wolfBiteMsg });
applyHpUpdate(orc1, { 'system.attributes.hp.value': 0, 'system.attributes.hp.temp': 0 });

// 4b. CAT summon (temporary actor deleted afterwards)
const catSkeleton = new Actor({
  id: 'tempSkel',
  name: 'Skeleton (CAT)',
  type: 'npc',
  hasPlayerOwner: true,
  flags: {
    cat: { summon: { owner: druid.uuid, sourceDocument: animateDead.uuid } }
  }
});
actorsMap.set(catSkeleton.id, catSkeleton);
const skelMsg = {
  type: 'damage',
  speaker: { actor: catSkeleton.id },
  rolls: [new DamageRoll({ total: 7, type: 'piercing' })]
};
RollStats._onPreApplyDamage(fireElem, 7, { 'system.attributes.hp.value': 33, 'system.attributes.hp.temp': 0 }, { originatingMessage: skelMsg });
applyHpUpdate(fireElem, { 'system.attributes.hp.value': 33, 'system.attributes.hp.temp': 0 });

// Delete CAT temporary summon actor — Druid keeps all attributed stats!
actorsMap.delete(catSkeleton.id);
uuidRegistry.delete(catSkeleton.uuid);

// 4c. CPR healing spirit summon (token flag)
const { actor: healSpirit } = makeUnlinkedToken('sc1', 'tokSpirit', 'baseSpirit', 'Healing Spirit', {
  hp: 10,
  maxHp: 10,
  hasPlayerOwner: true,
  tokenFlags: { 'chris-premades': { summonerUuid: druid.uuid } }
});
const spiritHealMsg = {
  type: 'damage',
  speaker: { scene: 'sc1', token: 'tokSpirit', actor: 'baseSpirit' },
  getAssociatedActivity: () => ({ type: 'heal' }),
  rolls: [new DamageRoll({ total: 9, type: 'healing' })]
};
fighter.system.attributes.hp.value = 10;
RollStats._onPreApplyDamage(fighter, -9, { 'system.attributes.hp.value': 19, 'system.attributes.hp.temp': 0 }, { originatingMessage: spiritHealMsg });
applyHpUpdate(fighter, { 'system.attributes.hp.value': 19, 'system.attributes.hp.temp': 0 });

const druidStats = RollStats._getPeriodData(druid.uuid, 'session');
assert.equal(druidStats.damage.dealt, 18, 'Druid dealt includes Wolf (11) + CAT Skeleton (7)');
assert.equal(druidStats.damage.summonDealt, 18, 'Druid summonDealt tracks summon portion');
assert.equal(druidStats.kills, 1, 'Wolf kill credited to Druid');
assert.equal(druidStats.spells.byName['Conjure Animals'].damage, 11, 'Wolf damage credited to Conjure Animals');
assert.equal(druidStats.spells.byName['Animate Dead'].damage, 7, 'Skeleton damage credited to Animate Dead');
assert.equal(druidStats.healing.given, 9, 'Healing Spirit heal credited to Druid');
assert.equal(druidStats.healing.summonGiven, 9, 'Druid summonGiven tracks summon healing');

/* ------------------------------ 5. Death Saves, Zero Total & StatsApp UI ------------------------------ */

// Nat 1 death save with +9 bonus (total 10 >= 10) MUST still be a failure!
RollStats._onDeathSave([new D20Roll({ total: 10, result: 1, options: { target: 10 } })], { subject: fighter });
const fDs = RollStats._getPeriodData(fighter.uuid, 'session').deathSaves;
assert.equal(fDs.failures, 1, 'Nat 1 death save with +9 bonus must fail');
assert.equal(fDs.successes, 0, 'Nat 1 death save must not succeed');
assert.equal(fDs.critFail, 1, 'Nat 1 death save increments critFail');

// Skill check with total === 0 (d20 = 2, modifier -2) must display 0 in log, not 2
RollStats._onSkillCheck([new D20Roll({ total: 0, result: 2 })], { subject: fighter, skill: 'prc' });

const app = new StatsApp();
app.pcOnly = false;
const ctxAll = await app._prepareContext();

// Cleric overview row must show healingGiven (2) in Healing column, even though cleric received 0 healing!
const clericRow = ctxAll.overviewRows.find(r => r.id === cleric.uuid);
assert.equal(clericRow.healingRaw, 2, 'Overview Healing column shows healing.given for healer');

// Druid overview row shows summon damage tooltip
const druidRow = ctxAll.overviewRows.find(r => r.id === druid.uuid);
assert.ok(druidRow.dmgDealtTip.includes('18'), 'Druid damage tooltip shows summon damage');

// KPI summary card under "All" filter must NOT double-count Wolf's 11 damage & 1 kill alongside Druid
// Expected total dealt across all actors: Fighter (25) + Wizard (34) + Druid (18, includes Wolf 11 + deleted Skel 7) = 77
assert.equal(ctxAll.summaryCards[1].value, '77', 'KPI Damage Dealt does not double-count summon when summoner is in view');
assert.ok(ctxAll.summaryCards[1].sub.includes('3'), 'KPI Kills = Fighter(1) + Wizard(1) + Druid(1) = 3 without Wolf double-count');

// Zero-total roll log check
const zeroLogRow = ctxAll.logRows[0];
assert.equal(zeroLogRow.totalDisplay, 0, 'Roll with total === 0 displays 0 instead of falling back to die result');
assert.equal(zeroLogRow.d20Sub, 'd20: 2', 'd20 subtitle shown when total is 0 and die was 2');

console.log('stat-tracker smoke: ALL ASSERTIONS PASSED');
process.exit(0);
