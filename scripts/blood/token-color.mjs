/**
 * Token blood color — SINGLE resolution point.
 *
 * The canonical flag `flags.showstopper.bloodColor` is written by the field in
 * TokenConfig (alongside the "does not bleed" checkbox). The legacy Splatter
 * flag `flags.splatter.bloodColor` is read as a backward-compatible fallback:
 * colors previously configured via Splatter or older system versions continue
 * to work until our flag is set. There is no runtime interop with Splatter:
 * the built-in creature-type palette (Bloodsheet) is our own and authoritative,
 * and creature-type property paths are configured through our settings.
 */
import { MODULE_ID } from '../config.mjs';
import { parseColor } from './colors.mjs';
/** Showstopper's built-in creature physiology palette: creature type → #rrggbbaa
 *  (dnd5e / pf2e taxonomy). */
const CREATURE_ICHOR_PALETTE = {
    aberration: '#9e22ccd8',
    beast: '#a10e14dc',
    celestial: '#5ec2e6d4',
    construct: '#524436d4',
    dragon: '#940c12e0',
    elemental: '#686c73b8',
    fey: '#88db38d6',
    fiend: '#b31426e0',
    giant: '#960f14dc',
    humanoid: '#a81016d9',
    monstrosity: '#8f0c13dc',
    ooze: '#e68619d6',
    plant: '#236914d9',
    undead: '#3d0b0fd9'
};
function _get(key, fallback) {
    try {
        return game.settings.get(MODULE_ID, key) ?? fallback;
    }
    catch {
        return fallback;
    }
}
function _defaultColor() {
    return parseColor(_get('bloodColor', '#a51414d8')) ?? parseColor('#a51414d8');
}
/** Creature-type color table — built-in, no external sources. */
function _bloodSheet() {
    if (!_get('bloodUseBloodsheet', true))
        return null;
    return CREATURE_ICHOR_PALETTE;
}
function _creatureTypePaths() {
    return {
        type: _get('bloodCreatureTypePath', 'details.type.value'),
        custom: _get('bloodCreatureTypeCustomPath', '')
    };
}
function _creatureTypeOf(token) {
    const actor = token?.actor ?? token?.document?.actor;
    if (!actor)
        return null;
    const { type: typePath, custom: customPath } = _creatureTypePaths();
    let value = null;
    try {
        if (customPath)
            value = foundry.utils.getProperty(actor.system, customPath);
        if (!value && typePath)
            value = foundry.utils.getProperty(actor.system, typePath);
    }
    catch { /* noop */ }
    if (Array.isArray(value))
        return value.map(v => String(v).toLowerCase());
    return value ? String(value).toLowerCase() : null;
}
function _sheetColorFor(creatureType) {
    const sheet = _bloodSheet();
    if (!sheet || !creatureType)
        return null;
    const types = Array.isArray(creatureType) ? creatureType : [creatureType];
    for (const t of types) {
        if (sheet[t])
            return sheet[t];
    }
    // substring match ("humanoid (orc)" → humanoid)
    for (const t of types) {
        const key = Object.keys(sheet).find(k => t.includes(k));
        if (key)
            return sheet[key];
    }
    return null;
}
/**
 * Resolve token blood color. Priority:
 *   1. flags.showstopper.bloodColor (our canonical flag)
 *   2. flags.splatter.bloodColor (legacy — colors set prior to our field)
 *   3. Bloodsheet by creature type (built-in palette)
 *   4. world default bloodColor
 */
export function tokenBloodColor(token) {
    const fromFlag = _tokenFlagColor(token);
    if (fromFlag)
        return fromFlag;
    const sheetColor = parseColor(_sheetColorFor(_creatureTypeOf(token)));
    if (sheetColor)
        return sheetColor;
    return _defaultColor();
}
/** Our canonical color flag (written by the TokenConfig field). */
const OUR_COLOR_FLAG = Object.freeze({ scope: MODULE_ID, key: 'bloodColor' });
/** Legacy source: Splatter flag, read when our flag is unset. */
const LEGACY_COLOR_FLAG = Object.freeze({ scope: 'splatter', key: 'bloodColor' });
function _tokenFlagColor(token) {
    const doc = token?.document ?? token;
    const actor = token?.actor ?? doc?.actor;
    const read = (flag) => parseColor(doc?.flags?.[flag.scope]?.[flag.key]
        ?? actor?.flags?.[flag.scope]?.[flag.key]);
    return read(OUR_COLOR_FLAG) ?? read(LEGACY_COLOR_FLAG);
}
/* --------------------- footprint archetypes by creature type --------------------- */
export const FOOTPRINT_STYLE_OPTIONS = Object.freeze([
    'auto',
    'boot',
    'paw',
    'claw',
    'hoof',
    'slither',
    'none'
]);
const VALID_EXPLICIT_STYLES = new Set(['boot', 'paw', 'claw', 'hoof', 'slither', 'none']);
const GHOST_CREATURE_RE = /(?:^|[^\p{L}])(?:(?:ghost|specter|spectre|wraith|banshee|spirit|phantom|poltergeist|wisp|air\s*elemental|fire\s*elemental)s?|призрак[а-яё]{0,3}|привидени[а-яё]{0,3}|дух(?:а|у|ом|е|и|ов)?|банши|полтергейст[а-яё]{0,3}|блуждающ[а-яё]{1,4}\s*ог[а-яё]{1,4}|элементал[а-яё]{1,3}\s*воздух[а-яё]{0,2}|элементал[а-яё]{1,3}\s*огн[а-яё]{1,2}|бесплотн[а-яё]{1,4})(?=$|[^\p{L}])/iu;
const SLITHER_CREATURE_RE = /(?:^|[^\p{L}])(?:(?:ooze|slime|jelly|jellies|pudding|gelatinous|worm|snake|serpent|viper|constrictor|python|cobra|anaconda|boa|naga|slug|snail|leech|leeches|tentacle|roper|swarm)s?|слиз(?:ь|и|ью|ей|ень|ня|ни|ней)|желе|пудинг[а-яё]{0,3}|студенист[а-яё]{1,4}|черв(?:ь|я|ю|ем|ём|е|и|ей)|зме(?:я|и|е|ю|ей|ёй|й)|гадюк[а-яё]{0,3}|удав[а-яё]{0,3}|питон[а-яё]{0,3}|кобр[а-яё]{0,3}|наг(?:а|и|е|у|ой)|улитк[а-яё]{0,3}|пиявк[а-яё]{0,3}|щупальц[а-яё]{0,3}|рой|роя|рою|роем|рои|роёв|стая|стаи|стае|стаю|стаей)(?=$|[^\p{L}])/iu;
const HOOF_CREATURE_RE = /(?:^|[^\p{L}])(?:(?:horse|warhorse|pony|ponies|stallion|mare|foal|mule|donkey|camel|elk|deer|stag|doe|moose|reindeer|caribou|boar|pig|hog|goat|ram|sheep|bull|ox|oxen|cow|cattle|bison|buffalo|aurochs|yak|minotaur|centaur|satyr|faun|unicorn|pegasus|pegasi|nightmare|gorgon|bulezau)s?|кон(?:ь|я|ю|ем|ём|е|и|ей)|лошад[а-яё]{1,3}|скакун[а-яё]{0,3}|пони|жереб[а-яё]{1,4}|кобыл[а-яё]{0,3}|мул(?:а|у|ом|е|ы|ов)?|ос(?:ел|ёл|ла|лу|лом|ле|лы|лов)|верблюд[а-яё]{0,3}|лос(?:ь|я|ю|ем|е|и|ей)|олен[а-яё]{1,3}|лан(?:ь|и|ью|ей)|косул[а-яё]{1,3}|кабан[а-яё]{0,3}|вепр[а-яё]{1,3}|свин(?:ья|ьи|ье|ью|ьей|ей)|коз(?:ел|ёл|ла|лу|лом|лы|лов|а|ы|е|у|ой)|баран[а-яё]{0,3}|овц(?:а|ы|е|у|ой|ец)|бык(?:а|у|ом|е|и|ов)?|вол(?:а|у|ом|е|ы|ов)?|коров[а-яё]{0,3}|бизон[а-яё]{0,3}|зубр[а-яё]{0,3}|буйвол[а-яё]{0,3}|як(?:а|у|ом|е|и|ов)?|минотавр[а-яё]{0,3}|кентавр[а-яё]{0,3}|сатир[а-яё]{0,3}|фавн[а-яё]{0,3}|единорог[а-яё]{0,3}|пегас[а-яё]{0,3}|кошмар[а-яё]{0,3}|горгон[а-яё]{0,3})(?=$|[^\p{L}])/iu;
const CLAW_CREATURE_RE = /(?:^|[^\p{L}])(?:(?:dragon|wyvern|drake|wyrm|dragonborn|kobold|lizard|lizardfolk|troglodyte|dinosaur|raptor|velociraptor|allosaurus|tyrannosaurus|rex|ankylosaurus|triceratops|pteranodon|crocodile|alligator|turtle|tortoise|frog|toad|bullywug|grung|bird|eagle|hawk|falcon|owl|raven|crow|vulture|condor|roc|aarakocra|kenku|owlin|harpy|harpies|griffon|hippogriff|owlbear|cockatrice|basilisk|peryton|manticore|chimera|hydra|tarrasque|gargoyle|grell|hook\s*horror|ettercap|ankheg|chuul|umber\s*hulk|thri-kreen|kruthik|spider|scorpion|beetle|crab|mantis|centipede|ghoul|ghast|skeleton|deathlock|boneclaw|dracolich|vrock|hezrou|glabrezu|nabassu|barlgura|imp|quasit|devil|demon|abishai|sahuagin|kuo-toa|merrow|treant|blight)s?|дракон[а-яё]{0,3}|виверн[а-яё]{0,3}|дрейк[а-яё]{0,3}|драконорожден[а-яё]{1,4}|кобольд[а-яё]{0,3}|ящер[а-яё]{0,4}|людоящер[а-яё]{0,3}|троглодит[а-яё]{0,3}|динозавр[а-яё]{0,3}|раптор[а-яё]{0,3}|велоцираптор[а-яё]{0,3}|аллозавр[а-яё]{0,3}|тираннозавр[а-яё]{0,3}|крокодил[а-яё]{0,3}|аллигатор[а-яё]{0,3}|черепах[а-яё]{1,3}|лягушк[а-яё]{1,3}|жаб(?:а|ы|е|у|ой)|жаболюд[а-яё]{0,3}|булливуг[а-яё]{0,3}|грунг[а-яё]{0,3}|птиц[а-яё]{1,3}|ор(?:ел|ёл|ла|лу|лом|лы|лов)|ястреб[а-яё]{0,3}|сокол[а-яё]{0,3}|сов(?:а|ы|е|у|ой)|ворон[а-яё]{0,3}|гриф(?:а|у|ом|е|ы|ов)?|рок(?:а|у|ом|и|ов)?|ааракокр[а-яё]{0,3}|кенку|гарпи[а-яё]{1,3}|грифон[а-яё]{0,3}|гиппогриф[а-яё]{0,3}|совух[а-яё]{0,3}|сова-медвед[а-яё]{1,3}|кокатрис[а-яё]{0,3}|василиск[а-яё]{0,3}|перитон[а-яё]{0,3}|мантикор[а-яё]{0,3}|химер[а-яё]{0,3}|гидр[а-яё]{0,3}|тарраск[а-яё]{0,3}|гаргуль[а-яё]{1,3}|эттеркап[а-яё]{0,3}|анкхег[а-яё]{0,3}|чуул[а-яё]{0,3}|паук[а-яё]{0,3}|скорпион[а-яё]{0,3}|жук(?:а|у|ом|е|и|ов)?|краб[а-яё]{0,3}|сколопендр[а-яё]{0,3}|упыр[а-яё]{1,3}|вурдалак[а-яё]{0,3}|скелет[а-яё]{0,3}|врок[а-яё]{0,3}|хезру|глабрезу|имп(?:а|у|ом|е|ы|ов)?|квазит[а-яё]{0,3}|дьявол[а-яё]{0,3}|демон[а-яё]{0,3}|сахуагин[а-яё]{0,3}|куо-тоа|мерроу|древен[а-яё]{1,3})(?=$|[^\p{L}])/iu;
const PAW_CREATURE_RE = /(?:^|[^\p{L}])(?:(?:wolf|wolves|warg|worg|dog|hound|mastiff|fox|foxes|jackal|coyote|hyena|gnoll|bear|cat|lion|tiger|saber-toothed|panther|leopard|jaguar|cougar|puma|lynx|lynxes|cheetah|displacer|badger|wolverine|rat|wererat|mouse|mice|weasel|ferret|otter|beaver|squirrel|rabbit|hare|ape|gorilla|baboon|monkey|werewolf|werewolves|werebear|weretiger|tabaxi|leonin|harengon|khenra)s?|волк[а-яё]{0,3}|лютоволк[а-яё]{0,3}|варг[а-яё]{0,3}|ворг[а-яё]{0,3}|п(?:ес|ёс|са|су|сом|сы|сов)|собак[а-яё]{1,3}|мастиф[а-яё]{0,3}|гонч[а-яё]{2,3}|шакал[а-яё]{0,3}|койот[а-яё]{0,3}|лис(?:а|ы|е|у|ой|ица|ицы)?|гиен[а-яё]{0,3}|гнолл[а-яё]{0,3}|медвед[а-яё]{1,3}|кот(?:а|у|ом|е|ы|ов)?|кошк[а-яё]{1,3}|л(?:ев|ьва|ьву|ьвом|ьвы|ьвов)|тигр[а-яё]{0,3}|саблезуб[а-яё]{0,4}|пантер[а-яё]{0,3}|леопард[а-яё]{0,3}|ягуар[а-яё]{0,3}|пум(?:а|ы|е|у|ой)|рыс(?:ь|и|ью|ей)|гепард[а-яё]{0,3}|ускользающ[а-яё]{2,4}|барсук[а-яё]{0,3}|росомах[а-яё]{1,3}|крыс[а-яё]{0,3}|мыш(?:ь|и|ью|ей)|ласк(?:а|и|е|у|ой)|хор(?:ек|ёк|ька|ьку|ьком|ьки|ьков)|выдр[а-яё]{0,3}|бобр[а-яё]{0,3}|белк[а-яё]{1,3}|кролик[а-яё]{0,3}|за(?:яц|йца|йцу|йцем|йцы|йцев)|обезьян[а-яё]{0,3}|горилл[а-яё]{0,3}|бабуин[а-яё]{0,3}|оборотен[а-яё]{1,3}|вервольф[а-яё]{0,3}|табакси|леонин[а-яё]{0,3}|харенгон[а-яё]{0,3})(?=$|[^\p{L}])/iu;
/**
 * Subtype code `fp` for `STAIN.FOOTPRINT`:
 *  - `'boot'` → `0` (`footprint`)
 *  - `'paw'`  → `1` (`pawprint`)
 *  - `'claw'` → `2` (`clawprint`)
 *  - `'hoof'` → `3` (`hoofprint`)
 */
export function footprintSubtypeOfStyle(style) {
    if (style === 'paw')
        return 1;
    if (style === 'claw')
        return 2;
    if (style === 'hoof')
        return 3;
    return 0;
}
/**
 * Resolve token footprint style (`'boot' | 'paw' | 'claw' | 'hoof' | 'slither' | 'none'`).
 * Priority:
 *  1. Explicit `flags.showstopper.footprintStyle` on the token or actor (when not `'auto'`).
 *  2. Auto-detection from actor data (`hover`/incorporeal → `'none'`, swarm/ooze/snake → `'slither'`,
 *     ungulates → `'hoof'`, dragons/reptiles/birds/monstrosities/skeletons → `'claw'`, beasts → `'paw'`,
 *     humanoids/giants and others → `'boot'`).
 */
export function resolveTokenFootprintStyle(tokenOrDoc) {
    const doc = tokenOrDoc?.document ?? tokenOrDoc;
    const actor = tokenOrDoc?.actor ?? doc?.actor;
    let rawFlag = null;
    try {
        rawFlag = doc?.getFlag?.(MODULE_ID, 'footprintStyle')
            ?? doc?.flags?.[MODULE_ID]?.footprintStyle
            ?? actor?.getFlag?.(MODULE_ID, 'footprintStyle')
            ?? actor?.flags?.[MODULE_ID]?.footprintStyle
            ?? null;
    }
    catch { /* noop */ }
    if (typeof rawFlag === 'string') {
        const norm = rawFlag.trim().toLowerCase();
        if (VALID_EXPLICIT_STYLES.has(norm))
            return norm;
    }
    const rawCtype = _creatureTypeOf(tokenOrDoc);
    const ctypes = Array.isArray(rawCtype) ? rawCtype : (rawCtype ? [rawCtype] : []);
    const sys = actor?.system;
    const typeObj = sys?.details?.type;
    const subtype = typeof typeObj?.subtype === 'string' ? typeObj.subtype : '';
    const customType = typeof typeObj?.custom === 'string' ? typeObj.custom : '';
    const swarm = Boolean(typeObj?.swarm && String(typeObj.swarm).trim() !== '' && String(typeObj.swarm) !== 'false');
    const race = typeof sys?.details?.race === 'string'
        ? sys.details.race
        : (typeof sys?.details?.race?.name === 'string' ? sys.details.race.name : '');
    const tokenName = typeof doc?.name === 'string' ? doc.name : '';
    const actorName = typeof actor?.name === 'string' ? actor.name : '';
    const bioTag = `${tokenName} ${actorName} ${subtype} ${customType} ${race} ${ctypes.join(' ')}`.trim();
    // 1) Hovering / incorporeal creatures leave no ground footprints
    if (sys?.attributes?.movement?.hover === true)
        return 'none';
    if (actor?.statuses?.size) {
        for (const s of actor.statuses) {
            if (s === 'hover' || s === 'incorporeal' || s === 'ethereal')
                return 'none';
        }
    }
    if (bioTag && GHOST_CREATURE_RE.test(bioTag))
        return 'none';
    // 2) Oozes, swarms, snakes, worms, and tentacles leave a wavy slither trail
    if (swarm || ctypes.some(t => t.includes('ooze')))
        return 'slither';
    if (bioTag && SLITHER_CREATURE_RE.test(bioTag))
        return 'slither';
    // 3) Ungulates (horses, boars, deer, minotaurs, centaurs)
    if (bioTag && HOOF_CREATURE_RE.test(bioTag))
        return 'hoof';
    // 4) Three-toed clawed feet (dragons, monstrosities, reptiles, birds, spiders, skeletons, ghouls, fiends)
    if (bioTag && CLAW_CREATURE_RE.test(bioTag))
        return 'claw';
    if (ctypes.some(t => t.includes('dragon') || t.includes('monstrosity') || t.includes('fiend') || t.includes('aberration'))) {
        // Exception: if a monstrosity/fiend is explicitly named as a wolf/hound/cat/bear/gnoll, give it paws
        if (bioTag && PAW_CREATURE_RE.test(bioTag))
            return 'paw';
        return 'claw';
    }
    // 5) Soft padded animal paws (wolves, bears, cats, dogs, gnolls, tabaxi, lycanthropes)
    if (bioTag && PAW_CREATURE_RE.test(bioTag))
        return 'paw';
    if (ctypes.some(t => t.includes('beast')))
        return 'paw';
    // 6) Default — humanoid boot / foot
    return 'boot';
}
/* --------------------------- blood color field in token config --------------------------- */
/**
 * Inject "blood color" input + "does not bleed" checkbox + footprint style select
 * into TokenConfig (and PrototypeTokenConfig). Writes OUR flags
 * `flags.showstopper.bloodColor` / `flags.showstopper.bloodDisabled`; initial color
 * value falls back to the legacy Splatter flag when unset.
 */
export function registerTokenColorField() {
    const inject = (app, html) => {
        const el = html instanceof HTMLElement ? html : html?.[0];
        // skip if already injected (by us or Splatter)
        if (!el || el.querySelector('[name="flags.showstopper.bloodColor"]')
            || el.querySelector('[name="flags.splatter.bloodColor"]'))
            return;
        const anchor = el.querySelector('[name="texture.tint"]')?.closest('.form-group');
        if (!anchor)
            return;
        // value: our flag, falling back to legacy Splatter flag
        let current = '';
        try {
            current = app.token?.getFlag?.(OUR_COLOR_FLAG.scope, OUR_COLOR_FLAG.key)
                ?? app.token?.getFlag?.(LEGACY_COLOR_FLAG.scope, LEGACY_COLOR_FLAG.key) ?? '';
        }
        catch { /* noop */ }
        if (typeof current !== 'string')
            current = '';
        const group = document.createElement('div');
        group.className = 'form-group ss-blood-token-color';
        const label = document.createElement('label');
        label.textContent = game.i18n.localize(`${MODULE_ID}.blood.tokenColorLabel`);
        const fields = document.createElement('div');
        fields.className = 'form-fields';
        const text = document.createElement('input');
        text.type = 'text';
        text.name = `flags.${OUR_COLOR_FLAG.scope}.${OUR_COLOR_FLAG.key}`;
        text.dataset.dtype = 'String';
        text.value = current;
        text.placeholder = '#a51414d8';
        const color = document.createElement('input');
        color.type = 'color';
        const rgb = parseColor(current) ?? parseColor('#a51414');
        color.value = `#${[rgb.r, rgb.g, rgb.b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
        color.addEventListener('input', () => {
            const parsed = parseColor(text.value) ?? parseColor('#a51414d8');
            text.value = color.value + Math.round(parsed.a * 255).toString(16).padStart(2, '0');
        });
        text.addEventListener('change', () => {
            const parsed = parseColor(text.value);
            if (parsed)
                color.value = `#${[parsed.r, parsed.g, parsed.b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
        });
        fields.append(color, text);
        group.append(label, fields);
        anchor.insertAdjacentElement('afterend', group);
        // per-token toggle: ghosts/constructs/elementals do not bleed
        // (splats/trail/pools/droplets); ground footprint interaction still applies
        let noBlood = false;
        try {
            noBlood = app.token?.getFlag?.(MODULE_ID, 'bloodDisabled') === true;
        }
        catch { /* noop */ }
        const disGroup = document.createElement('div');
        disGroup.className = 'form-group ss-blood-token-color';
        const disLabel = document.createElement('label');
        disLabel.textContent = game.i18n.localize(`${MODULE_ID}.blood.tokenNoBloodLabel`);
        const disFields = document.createElement('div');
        disFields.className = 'form-fields';
        const dis = document.createElement('input');
        dis.type = 'checkbox';
        dis.name = `flags.${MODULE_ID}.bloodDisabled`;
        dis.dataset.dtype = 'Boolean';
        dis.checked = noBlood;
        disFields.appendChild(dis);
        disGroup.append(disLabel, disFields);
        group.insertAdjacentElement('afterend', disGroup);
        // token footprint style selector: Auto (by creature type) / Boot / Paw / Claw / Hoof / Slither / None
        let currentFpStyle = 'auto';
        try {
            const savedFp = app.token?.getFlag?.(MODULE_ID, 'footprintStyle');
            if (typeof savedFp === 'string' && FOOTPRINT_STYLE_OPTIONS.includes(savedFp)) {
                currentFpStyle = savedFp;
            }
        }
        catch { /* noop */ }
        const fpGroup = document.createElement('div');
        fpGroup.className = 'form-group ss-blood-token-color';
        const fpLabel = document.createElement('label');
        fpLabel.textContent = game.i18n.localize(`${MODULE_ID}.blood.tokenFootprintLabel`);
        const fpFields = document.createElement('div');
        fpFields.className = 'form-fields';
        const fpSelect = document.createElement('select');
        fpSelect.name = `flags.${MODULE_ID}.footprintStyle`;
        fpSelect.dataset.dtype = 'String';
        for (const optKey of FOOTPRINT_STYLE_OPTIONS) {
            const opt = document.createElement('option');
            opt.value = optKey;
            opt.textContent = game.i18n.localize(`${MODULE_ID}.blood.footprintStyles.${optKey}`);
            if (optKey === currentFpStyle)
                opt.selected = true;
            fpSelect.appendChild(opt);
        }
        fpFields.appendChild(fpSelect);
        fpGroup.append(fpLabel, fpFields);
        disGroup.insertAdjacentElement('afterend', fpGroup);
        try {
            app.setPosition({ height: 'auto' });
        }
        catch { /* noop */ }
    };
    Hooks.on('renderTokenConfig', inject);
    Hooks.on('renderPrototypeTokenConfig', inject);
}
