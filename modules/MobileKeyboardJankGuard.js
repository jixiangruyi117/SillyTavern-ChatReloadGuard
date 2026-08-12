function supportsMobileViewportSync(windowHost) {
    if (typeof windowHost?.visualViewport?.addEventListener !== 'function') return false;

    const coarsePointer = windowHost.matchMedia?.('(pointer: coarse)')?.matches;
    return coarsePointer || Number(windowHost.navigator?.maxTouchPoints ?? 0) > 0;
}

function readViewportHeight(windowHost) {
    return Math.round(Number(windowHost.visualViewport?.height ?? 0));
}

function saveStyleProperty(element, property) {
    return {
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
    };
}

function restoreStyleProperty(element, property, saved) {
    if (saved.value) {
        element.style.setProperty(property, saved.value, saved.priority);
    } else {
        element.style.removeProperty(property);
    }
}

/**
 * Synchronizes the application shell to visualViewport pixels while a mobile
 * virtual keyboard changes size. It bypasses stale 100dvh calculations that
 * leave #sheld and #bg1 at keyboard-open height after the keyboard closes.
 */
export function createMobileKeyboardJankGuard({ windowHost = globalThis.window, documentHost = globalThis.document } = {}) {
    const root = documentHost?.documentElement;
    const body = documentHost?.body;
    const sheld = documentHost?.getElementById?.('sheld');
    const background = documentHost?.getElementById?.('bg1');
    const supported = Boolean(root && body && sheld && background && supportsMobileViewportSync(windowHost));
    const savedStyles = new Map();
    let enabled = false;
    let animationFrame = 0;
    const delayedSyncs = new Set();

    function remember(element, property) {
        const key = `${element.id}:${property}`;
        if (!savedStyles.has(key)) savedStyles.set(key, { element, property, saved: saveStyleProperty(element, property) });
    }

    function syncViewportHeight() {
        animationFrame = 0;
        const height = readViewportHeight(windowHost);
        if (!enabled || height < 100) return;

        remember(body, 'height');
        remember(sheld, 'height');
        remember(sheld, 'max-height');
        remember(background, 'height');

        const heightValue = `${height}px`;
        root.style.setProperty('--chat-reload-guard-viewport-height', heightValue);
        body.style.setProperty('height', heightValue, 'important');
        background.style.setProperty('height', heightValue, 'important');
        sheld.style.setProperty('height', 'calc(var(--chat-reload-guard-viewport-height) - var(--topBarBlockSize) - 1px)', 'important');
        sheld.style.setProperty('max-height', 'calc(var(--chat-reload-guard-viewport-height) - var(--topBarBlockSize) - 1px)', 'important');
    }

    function scheduleViewportSync() {
        if (!enabled || animationFrame) return;
        if (typeof windowHost.requestAnimationFrame !== 'function') {
            syncViewportHeight();
            return;
        }
        animationFrame = windowHost.requestAnimationFrame(syncViewportHeight);
    }

    function scheduleSettledViewportSync() {
        scheduleViewportSync();
        if (typeof windowHost.setTimeout !== 'function') return;

        for (const delay of [120, 360]) {
            const timer = windowHost.setTimeout(() => {
                delayedSyncs.delete(timer);
                scheduleViewportSync();
            }, delay);
            delayedSyncs.add(timer);
        }
    }

    function setEnabled(nextEnabled) {
        if (!supported) {
            enabled = false;
            return { enabled, supported };
        }
        if (Boolean(nextEnabled) === enabled) return { enabled, supported };

        enabled = Boolean(nextEnabled);
        if (enabled) {
            windowHost.addEventListener('resize', scheduleViewportSync);
            windowHost.visualViewport.addEventListener('resize', scheduleViewportSync);
            documentHost.addEventListener('focusin', scheduleSettledViewportSync);
            documentHost.addEventListener('focusout', scheduleSettledViewportSync);
            syncViewportHeight();
        } else {
            windowHost.removeEventListener('resize', scheduleViewportSync);
            windowHost.visualViewport.removeEventListener('resize', scheduleViewportSync);
            documentHost.removeEventListener('focusin', scheduleSettledViewportSync);
            documentHost.removeEventListener('focusout', scheduleSettledViewportSync);
            if (animationFrame && typeof windowHost.cancelAnimationFrame === 'function') {
                windowHost.cancelAnimationFrame(animationFrame);
            }
            animationFrame = 0;
            for (const timer of delayedSyncs) windowHost.clearTimeout?.(timer);
            delayedSyncs.clear();
            for (const { element, property, saved } of savedStyles.values()) {
                restoreStyleProperty(element, property, saved);
            }
            savedStyles.clear();
            root.style.removeProperty('--chat-reload-guard-viewport-height');
        }

        return { enabled, supported };
    }

    return {
        get supported() {
            return supported;
        },
        get enabled() {
            return enabled;
        },
        setEnabled,
    };
}
