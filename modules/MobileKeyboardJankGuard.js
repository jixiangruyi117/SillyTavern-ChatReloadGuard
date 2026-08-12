const DEFAULT_KEYBOARD_HEIGHT_THRESHOLD = 120;

function isEditableElement(element) {
    if (!element) return false;
    if (element.isContentEditable) return true;

    const tagName = String(element.tagName ?? '').toLowerCase();
    return tagName === 'textarea' || tagName === 'input';
}

/**
 * Identifies viewport changes caused by opening or closing a virtual keyboard.
 * Width changes are intentionally excluded so orientation and split-screen
 * resizes continue through SillyTavern's original browser fixes unchanged.
 */
export function isLikelyVirtualKeyboardTransition({
    previousViewport,
    currentViewport,
    activeElement,
    wasKeyboardVisible,
    keyboardBaselineHeight = previousViewport?.height,
    keyboardHeightThreshold = DEFAULT_KEYBOARD_HEIGHT_THRESHOLD,
}) {
    if (!previousViewport || !currentViewport) return false;

    const widthChanged = Math.abs(currentViewport.width - previousViewport.width) > 1;
    if (widthChanged) return false;

    const keyboardVisible = isEditableElement(activeElement)
        && keyboardBaselineHeight - currentViewport.height >= keyboardHeightThreshold;

    return keyboardVisible || wasKeyboardVisible;
}

function readViewport(windowHost) {
    const viewport = windowHost.visualViewport;
    return {
        width: Number(viewport?.width ?? windowHost.innerWidth ?? 0),
        height: Number(viewport?.height ?? windowHost.innerHeight ?? 0),
    };
}

function supportsMobileViewportGuard(windowHost) {
    if (!windowHost?.visualViewport || typeof windowHost.MutationObserver !== 'function') {
        return false;
    }

    const coarsePointer = windowHost.matchMedia?.('(pointer: coarse)')?.matches;
    return coarsePointer || Number(windowHost.navigator?.maxTouchPoints ?? 0) > 0;
}

/**
 * Avoids the single-frame root `position: fixed` workaround used by the
 * audited SillyTavern mobile resize handler only during a keyboard transition.
 * It observes that mutation instead of stopping resize propagation, so native
 * and third-party resize listeners continue to run normally.
 */
export function createMobileKeyboardJankGuard({ windowHost = globalThis.window, documentHost = globalThis.document } = {}) {
    const root = documentHost?.documentElement;
    let enabled = false;
    let observer = null;
    let previousViewport = null;
    let keyboardBaselineHeight = 0;
    let wasKeyboardVisible = false;
    let keyboardTransitionPending = false;
    let keyboardTransitionToken = 0;

    const supported = Boolean(root && supportsMobileViewportGuard(windowHost));

    function onResize() {
        const currentViewport = readViewport(windowHost);
        const widthChanged = previousViewport && Math.abs(currentViewport.width - previousViewport.width) > 1;
        keyboardTransitionPending = isLikelyVirtualKeyboardTransition({
            previousViewport,
            currentViewport,
            activeElement: documentHost.activeElement,
            wasKeyboardVisible,
            keyboardBaselineHeight,
        });

        const activeElement = documentHost.activeElement;
        wasKeyboardVisible = isEditableElement(activeElement)
            && previousViewport
            && keyboardBaselineHeight - currentViewport.height >= DEFAULT_KEYBOARD_HEIGHT_THRESHOLD;
        previousViewport = currentViewport;
        if (widthChanged || currentViewport.height > keyboardBaselineHeight) {
            keyboardBaselineHeight = currentViewport.height;
        }

        if (keyboardTransitionPending && typeof windowHost.setTimeout === 'function') {
            const transitionToken = ++keyboardTransitionToken;
            windowHost.setTimeout(() => {
                if (keyboardTransitionToken === transitionToken) {
                    keyboardTransitionPending = false;
                }
            }, 0);
        }
    }

    function onRootStyleMutation() {
        if (!enabled || !keyboardTransitionPending || root.style.position !== 'fixed') {
            return;
        }

        root.style.position = '';
        keyboardTransitionPending = false;
        keyboardTransitionToken++;
    }

    function setEnabled(nextEnabled) {
        if (!supported) {
            enabled = false;
            return { enabled, supported };
        }

        if (Boolean(nextEnabled) === enabled) {
            return { enabled, supported };
        }

        enabled = Boolean(nextEnabled);
        if (enabled) {
            previousViewport = readViewport(windowHost);
            keyboardBaselineHeight = previousViewport.height;
            wasKeyboardVisible = false;
            keyboardTransitionPending = false;
            keyboardTransitionToken++;
            observer = new windowHost.MutationObserver(onRootStyleMutation);
            observer.observe(root, { attributes: true, attributeFilter: ['style'] });
            windowHost.addEventListener('resize', onResize, true);
        } else {
            windowHost.removeEventListener('resize', onResize, true);
            observer?.disconnect();
            observer = null;
            keyboardTransitionPending = false;
            keyboardTransitionToken++;
            wasKeyboardVisible = false;
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
