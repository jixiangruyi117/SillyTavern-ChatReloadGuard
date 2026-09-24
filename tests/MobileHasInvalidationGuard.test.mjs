import assert from 'node:assert/strict';
import test from 'node:test';

import {
    installMobileHasInvalidationGuard,
    isProblematicMobileHasSelector,
} from '../modules/MobileHasInvalidationGuard.js';

const DRAWER_SELECTOR = '#top-settings-holder:has(.drawer-content.openDrawer:not(.fillLeft):not(.fillRight))';
const PROBLEM_SELECTOR = `body:has(.drawer-content.open) ${DRAWER_SELECTOR}`;

function makeStyleRule(selectorText) {
    return { selectorText };
}

function makeContainer(rules, extra = {}) {
    return {
        ...extra,
        cssRules: rules,
        deleteRule(index) {
            this.cssRules.splice(index, 1);
        },
    };
}

function mobileMatchMedia(query) {
    return { matches: query === '(max-width: 1000px)' };
}

test('identifies each confirmed problematic selector', () => {
    for (const anchor of [
        'body:has(.drawer-content.maximized)',
        'body:has(.drawer-content.open)',
        'body:has(#character_popup.open)',
    ]) {
        assert.equal(isProblematicMobileHasSelector(`${anchor} ${DRAWER_SELECTOR}`), true);
    }
    assert.equal(isProblematicMobileHasSelector(`body:has(.drawer-content.open) #top-settings-holder`), false);
});

test('removes the problematic CSSOM rule on mobile', () => {
    const styleSheet = makeContainer([
        makeStyleRule(PROBLEM_SELECTOR),
        makeStyleRule('body { color: white; }'),
    ]);

    const result = installMobileHasInvalidationGuard({
        documentRef: { styleSheets: [styleSheet] },
        matchMediaFn: mobileMatchMedia,
    });

    assert.deepEqual(result, { enabled: true, removed: 1 });
    assert.equal(styleSheet.cssRules.length, 1);
    assert.equal(styleSheet.cssRules[0].selectorText, 'body { color: white; }');
});

test('does not remove rules on desktop', () => {
    const styleSheet = makeContainer([makeStyleRule(PROBLEM_SELECTOR)]);

    const result = installMobileHasInvalidationGuard({
        documentRef: { styleSheets: [styleSheet] },
        matchMediaFn: () => ({ matches: false }),
    });

    assert.deepEqual(result, { enabled: false, removed: 0 });
    assert.equal(styleSheet.cssRules.length, 1);
});

test('does not enter a desktop-only media container on mobile', () => {
    const desktopOnlyMedia = makeContainer([makeStyleRule(PROBLEM_SELECTOR)], {
        media: { mediaText: '(min-width: 1001px)' },
    });
    const styleSheet = makeContainer([desktopOnlyMedia]);

    const result = installMobileHasInvalidationGuard({
        documentRef: { styleSheets: [styleSheet] },
        matchMediaFn: mobileMatchMedia,
    });

    assert.deepEqual(result, { enabled: true, removed: 0 });
    assert.equal(desktopOnlyMedia.cssRules.length, 1);
});

test('returns safely when no matching rule exists', () => {
    const styleSheet = makeContainer([makeStyleRule('body { color: white; }')]);

    const result = installMobileHasInvalidationGuard({
        documentRef: { styleSheets: [styleSheet] },
        matchMediaFn: mobileMatchMedia,
    });

    assert.deepEqual(result, { enabled: true, removed: 0 });
    assert.equal(styleSheet.cssRules.length, 1);
});
