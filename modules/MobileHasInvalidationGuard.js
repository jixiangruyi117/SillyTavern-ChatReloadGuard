const MOBILE_QUERY = '(max-width: 1000px)';
const DRAWER_SELECTOR = '#top-settings-holder:has(.drawer-content.openDrawer:not(.fillLeft):not(.fillRight))';
const PROBLEM_ANCHORS = [
    'body:has(.drawer-content.maximized)',
    'body:has(.drawer-content.open)',
    'body:has(#character_popup.open)',
];

function normalizeSelector(selectorText) {
    return String(selectorText ?? '').replace(/\s+/g, ' ').trim();
}

function getCssRules(container) {
    try {
        return container?.cssRules ?? null;
    } catch {
        // A cross-origin stylesheet cannot be inspected and is outside this extension's scope.
        return null;
    }
}

function isMediaContainer(rule) {
    if (typeof CSSMediaRule === 'function' && rule instanceof CSSMediaRule) return true;
    return Boolean(rule?.media && typeof rule.media.mediaText === 'string');
}

function isCurrentMediaContainer(rule, matchMediaFn) {
    try {
        return Boolean(matchMediaFn(rule.media.mediaText).matches);
    } catch {
        return false;
    }
}

function removeProblematicRules(container, matchMediaFn) {
    const rules = getCssRules(container);
    if (!rules || typeof container?.deleteRule !== 'function') return 0;

    let removed = 0;
    for (let index = rules.length - 1; index >= 0; index--) {
        const rule = rules[index];
        if (isProblematicMobileHasSelector(rule?.selectorText)) {
            try {
                container.deleteRule(index);
                removed++;
            } catch {
                // A stylesheet can become unavailable while SillyTavern is changing themes.
            }
            continue;
        }

        if (!getCssRules(rule)) continue;
        if (isMediaContainer(rule) && !isCurrentMediaContainer(rule, matchMediaFn)) continue;
        removed += removeProblematicRules(rule, matchMediaFn);
    }
    return removed;
}

export function isProblematicMobileHasSelector(selectorText) {
    const normalizedSelector = normalizeSelector(selectorText);
    return normalizedSelector.includes(DRAWER_SELECTOR)
        && PROBLEM_ANCHORS.some(anchor => normalizedSelector.includes(anchor));
}

export function installMobileHasInvalidationGuard({
    documentRef = globalThis.document,
    matchMediaFn = globalThis.matchMedia?.bind(globalThis),
} = {}) {
    if (!documentRef || typeof matchMediaFn !== 'function') return { enabled: false, removed: 0 };

    try {
        if (!matchMediaFn(MOBILE_QUERY).matches) return { enabled: false, removed: 0 };
    } catch {
        return { enabled: false, removed: 0 };
    }

    let removed = 0;
    for (const styleSheet of Array.from(documentRef.styleSheets ?? [])) {
        removed += removeProblematicRules(styleSheet, matchMediaFn);
    }
    return { enabled: true, removed };
}
