import { MODULE_ID } from '../../config.mjs';
import { resizeImageTo1024, isAnimatedImage } from '../../utils/image-utils.mjs';
export function getActorDisplayName(actor, token = null) {
    const flagName = actor.getFlag(MODULE_ID, 'introDisplayName');
    if (flagName)
        return flagName;
    let name = token?.name || actor.name;
    name = name.replace(/\s*\[[^\]]*\]/g, '');
    name = name.split('/')[0].trim();
    return name;
}
export function getActorDisplayPortrait(actor, token = null) {
    const flagPortrait = actor.getFlag(MODULE_ID, 'introPortrait');
    if (flagPortrait)
        return flagPortrait;
    try {
        if (game.system?.id === 'dnd5e') {
            const showTokenPortrait = actor.getFlag('dnd5e', 'showTokenPortrait');
            if (showTokenPortrait) {
                return token?.texture?.src || actor.prototypeToken?.texture?.src || actor.img;
            }
        }
    }
    catch (e) {
    }
    return actor.img;
}
export async function getActorDisplayPortraitProcessed(actor, token = null) {
    const portrait = getActorDisplayPortrait(actor, token);
    const isAnimated = await isAnimatedImage(portrait);
    if (isAnimated) {
        return portrait;
    }
    // Pass the animation check result downstream so resizeImageTo1024 doesn't
    // perform a SECOND fetch+scan of the same WebP
    return resizeImageTo1024(portrait, { isAnimated });
}
function processSecretSections(html) {
    if (typeof document !== 'undefined') {
        const container = document.createElement('div');
        if (container && typeof container.querySelectorAll === 'function') {
            container.innerHTML = html;
            const secretSections = container.querySelectorAll('section.secret');
            secretSections.forEach(section => {
                if (section.classList.contains('revealed')) {
                    const content = document.createElement('div');
                    content.innerHTML = section.innerHTML;
                    section.replaceWith(content);
                }
                else {
                    section.remove();
                }
            });
            return container.innerHTML;
        }
    }
    return String(html ?? '').replace(/<section\b[^>]*\bsecret\b[^>]*>[\s\S]*?<\/section>/gi, '');
}
async function enrichBiographyHtml(bio, actor) {
    const editor = globalThis.foundry?.applications?.ux?.TextEditor?.implementation
        ?? globalThis.foundry?.applications?.ux?.TextEditor
        ?? globalThis.TextEditor;
    if (!editor?.enrichHTML)
        return bio;
    try {
        // secrets: false is MANDATORY: intro payloads are broadcast to all players,
        // so GM-only secret blocks must never leak into them.
        return await editor.enrichHTML(bio, {
            async: true,
            relativeTo: actor,
            secrets: false
        });
    }
    catch (e) {
        console.warn(`${MODULE_ID} | Error enriching bio:`, e);
        return bio;
    }
}
export function stripBracketTranslation(str) {
    return String(str ?? '')
        .replace(/\s*\[[^\]]*\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
export function getLocalizedCreatureType(actor) {
    if (!actor)
        return '';
    const rawType = actor.system?.details?.type;
    const typeKey = typeof rawType === 'string' ? rawType : rawType?.value;
    if (typeKey === 'custom' && rawType?.custom) {
        return stripBracketTranslation(rawType.custom);
    }
    if (typeof typeKey === 'string' && typeKey) {
        const cfg = globalThis.CONFIG?.DND5E?.creatureTypes?.[typeKey];
        const labelKey = typeof cfg === 'string' ? cfg : cfg?.label;
        if (labelKey && globalThis.game?.i18n?.has?.(labelKey)) {
            return stripBracketTranslation(globalThis.game.i18n.localize(labelKey));
        }
        const fallbackI18nKey = `DND5E.Creature${typeKey.charAt(0).toUpperCase() + typeKey.slice(1)}`;
        if (globalThis.game?.i18n?.has?.(fallbackI18nKey)) {
            return stripBracketTranslation(globalThis.game.i18n.localize(fallbackI18nKey));
        }
    }
    if (typeof actor.labels?.creatureType === 'string' && actor.labels.creatureType.trim()) {
        return stripBracketTranslation(actor.labels.creatureType);
    }
    if (typeof typeKey === 'string' && typeKey) {
        return stripBracketTranslation(typeKey.charAt(0).toUpperCase() + typeKey.slice(1));
    }
    return '';
}
function htmlFragmentToPlainText(html) {
    // Strip section headings (<h2>Childhood</h2>, etc.) so they don't run into the first paragraph sentence
    const withoutHeadings = String(html ?? '')
        .replace(/<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>/gi, ' ')
        .replace(/<(?:\/p|\/div|\/li|\/blockquote|br\b[^>]*)>/gi, ' ');
    let text = '';
    if (typeof document !== 'undefined') {
        const tmp = document.createElement('div');
        if (tmp && 'innerHTML' in tmp) {
            tmp.innerHTML = withoutHeadings;
            text = tmp.textContent || '';
        }
    }
    if (!text) {
        text = withoutHeadings
            .replace(/<[^>]*>/g, ' ')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&mdash;/gi, '—')
            .replace(/&ndash;/gi, '–')
            .replace(/&laquo;/gi, '«')
            .replace(/&raquo;/gi, '»')
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/gi, "'")
            .replace(/&amp;/gi, '&');
    }
    return text
        .replace(/\s+/g, ' ')
        .replace(/^[.,;:!?\s—–-]+/, '')
        .trim();
}
function truncateAutoBio(text, maxChars = 250) {
    if (!text || maxChars <= 0 || text.length <= maxChars)
        return text;
    const windowText = text.slice(0, maxChars + 1);
    const minSentenceCut = Math.floor(maxChars * 0.52);
    // Prefer cutting cleanly at a sentence boundary
    let bestSentenceEnd = -1;
    const sentenceRe = /[.!?…](?=\s|$)/g;
    let m;
    while ((m = sentenceRe.exec(windowText)) !== null) {
        const idx = m.index + m[0].length;
        if (idx >= minSentenceCut && idx <= maxChars) {
            bestSentenceEnd = idx;
        }
    }
    if (bestSentenceEnd > 0) {
        return windowText.slice(0, bestSentenceEnd).trim();
    }
    // Otherwise cut at the last word boundary and append an ellipsis
    const lastSpace = windowText.lastIndexOf(' ', maxChars);
    const cut = lastSpace > minSentenceCut ? windowText.slice(0, lastSpace) : windowText.slice(0, maxChars);
    return `${cut.replace(/[,;:\s—–-]+$/, '').trim()}…`;
}
const MAX_AUTO_TITLE_LENGTH = 75;
export async function getActorIntroTitle(actor) {
    const flagTitle = actor.getFlag(MODULE_ID, 'introTitle');
    if (flagTitle)
        return flagTitle;
    const bio = actor.system?.details?.biography?.value || '';
    if (!bio)
        return '';
    const enrichedBio = processSecretSections(await enrichBiographyHtml(bio, actor));
    const emMatch = enrichedBio.match(/<em[^>]*>([\s\S]*?)<\/em>/i);
    if (emMatch) {
        const candidate = emMatch[1]
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .replace(/^[«"“”„'']+|[»"“”„'']+$/g, '')
            .trim();
        if (candidate && candidate.length <= MAX_AUTO_TITLE_LENGTH) {
            return candidate;
        }
    }
    return '';
}
export async function getActorIntroDescription(actor, maxAutoChars = 250) {
    const flagDesc = actor.getFlag(MODULE_ID, 'introDescription');
    if (flagDesc)
        return flagDesc;
    const bio = actor.system?.details?.biography?.value || '';
    if (!bio)
        return '';
    const enrichedBio = processSecretSections(await enrichBiographyHtml(bio, actor));
    let sourceHtml = enrichedBio;
    const emMatch = enrichedBio.match(/<em[^>]*>([\s\S]*?)<\/em>/i);
    if (emMatch) {
        const candidate = emMatch[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        if (candidate && candidate.length <= MAX_AUTO_TITLE_LENGTH) {
            const emEndIndex = enrichedBio.indexOf(emMatch[0]) + emMatch[0].length;
            sourceHtml = enrichedBio.substring(emEndIndex);
        }
    }
    const plain = htmlFragmentToPlainText(sourceHtml);
    return truncateAutoBio(plain, maxAutoChars);
}
export function getActorPortraitOffsetX(actor) {
    return actor.getFlag(MODULE_ID, 'introPortraitOffsetX') ?? 0;
}
export function getActorPortraitOffsetY(actor) {
    return actor.getFlag(MODULE_ID, 'introPortraitOffsetY') ?? 0;
}
export function getActorPortraitScale(actor) {
    return actor.getFlag(MODULE_ID, 'introPortraitScale') ?? 1;
}
export function getPortraitConfig(actor) {
    return {
        offsetX: getActorPortraitOffsetX(actor),
        offsetY: getActorPortraitOffsetY(actor),
        scale: getActorPortraitScale(actor)
    };
}
export function buildPortraitInlineStyle(config = {}, options = {}) {
    const { offsetX = 0, offsetY = 0, scale = 1 } = config ?? {};
    const fit = options?.fit || config?.fit || 'cover';
    const position = options?.position || config?.position || (fit === 'contain' ? '50% 100%' : '50% 15%');
    const styles = [
        `object-fit: ${fit}`,
        `object-position: ${position}`
    ];
    // Use independent CSS translate/scale properties instead of transform + animation: none
    // so portrait framing composes cleanly with @keyframes animations (breathing, zoom, glitch).
    if (offsetX !== 0 || offsetY !== 0) {
        styles.push(`translate: ${offsetX}% ${offsetY}%`);
    }
    if (scale !== 1) {
        styles.push(`scale: ${scale}`);
    }
    return styles.join('; ');
}
export function getActorPreferredIntroId(actor) {
    try {
        return actor?.getFlag?.(MODULE_ID, 'introEffectId') || '';
    }
    catch {
        return '';
    }
}
/**
 * Universal target resolver for introductions:
 * accepts boolean `localOnly` or `{ localOnly, token, tokenId, actor, actorId, silent, ...overrides }`.
 * Supports launching from either a controlled/targeted scene token or directly from an Actor in the sidebar/macro.
 */
export function resolveIntroTarget(optionsOrLocalOnly = false) {
    const opts = typeof optionsOrLocalOnly === 'boolean'
        ? { localOnly: optionsOrLocalOnly }
        : (optionsOrLocalOnly && typeof optionsOrLocalOnly === 'object' ? optionsOrLocalOnly : {});
    const localOnly = Boolean(opts.localOnly);
    let token = opts.token ?? null;
    if (!token && opts.tokenId) {
        token = globalThis.canvas?.tokens?.get?.(opts.tokenId) ?? null;
    }
    if (!token && !opts.actor && !opts.actorId) {
        token = globalThis.canvas?.tokens?.controlled?.[0]
            ?? [...(globalThis.game?.user?.targets ?? [])][0]
            ?? null;
    }
    let actor = opts.actor ?? null;
    if (!actor && opts.actorId) {
        actor = globalThis.game?.actors?.get?.(opts.actorId) ?? null;
    }
    if (!actor && token?.actor) {
        actor = token.actor;
    }
    const tokenDoc = token?.document ?? (token?.texture ? token : null);
    if (!actor && !opts.silent) {
        const msg = globalThis.game?.i18n?.localize?.(`${MODULE_ID}.cut-ins.ui.selectToken`) ?? 'Select a token first';
        globalThis.ui?.notifications?.warn?.(msg);
    }
    return {
        actor,
        token,
        tokenDoc,
        localOnly,
        overrides: opts.overrides && typeof opts.overrides === 'object' ? opts.overrides : opts
    };
}
export async function getActorIntroData(actor, token = null) {
    const [title, description, portrait] = await Promise.all([
        getActorIntroTitle(actor),
        getActorIntroDescription(actor),
        getActorDisplayPortraitProcessed(actor, token)
    ]);
    return {
        displayName: getActorDisplayName(actor, token),
        portrait,
        title,
        description,
        portraitConfig: getPortraitConfig(actor)
    };
}
