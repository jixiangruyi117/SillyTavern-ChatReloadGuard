const ROOT_CLASS = 'chat-reload-guard-mobile-viewport';
const HEIGHT_VARIABLE = '--chat-reload-guard-app-height';
const KEYBOARD_MIN_HEIGHT = 120;
const MAX_DIAGNOSTIC_EVENTS = 120;
const MAX_EXPORTED_EVENTS = 18;

function isEditable(element) {
    if (!element) return false;
    if (element.isContentEditable) return true;
    const tag = String(element.tagName ?? '').toLowerCase();
    return tag === 'textarea' || tag === 'input' || tag === 'select';
}

function isMobileViewport(windowHost) {
    const coarsePointer = windowHost.matchMedia?.('(pointer: coarse)')?.matches;
    return Boolean(windowHost.visualViewport && (coarsePointer || Number(windowHost.navigator?.maxTouchPoints ?? 0) > 0));
}

function finiteHeight(value) {
    const number = Math.round(Number(value));
    return Number.isFinite(number) && number > 0 ? number : 0;
}

function readHeights(windowHost, documentHost) {
    return {
        inner: finiteHeight(windowHost.innerHeight),
        visual: finiteHeight(windowHost.visualViewport?.height),
        client: finiteHeight(documentHost.documentElement?.clientHeight),
    };
}

function readWidth(windowHost) {
    return Math.round(Number(windowHost.visualViewport?.width ?? windowHost.innerWidth ?? 0));
}

function maximumHeight(heights) {
    return Math.max(heights.inner, heights.visual, heights.client);
}

function minimumHeight(heights) {
    const values = [heights.inner, heights.visual, heights.client].filter(value => value > 0);
    return values.length ? Math.min(...values) : 0;
}

function readRect(documentHost, id) {
    const rect = documentHost.getElementById?.(id)?.getBoundingClientRect?.();
    if (!rect) return null;
    return {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        height: Math.round(rect.height),
    };
}

function activeElementLabel(documentHost) {
    const active = documentHost.activeElement;
    if (!active) return null;
    const tag = String(active.tagName ?? '').toLowerCase();
    const id = String(active.id ?? '');
    return id ? `${tag}#${id}` : tag || null;
}

function readComputedLayout(windowHost, element) {
    if (!element || typeof windowHost.getComputedStyle !== 'function') return null;
    const style = windowHost.getComputedStyle(element);
    return {
        height: style.height || null,
        maxHeight: style.maxHeight || null,
        position: style.position || null,
    };
}

export function createMobileKeyboardViewportFix({
    windowHost = globalThis.window,
    documentHost = globalThis.document,
    onEvent,
} = {}) {
    const root = documentHost?.documentElement;
    const visualViewport = windowHost?.visualViewport;
    const supported = Boolean(root && isMobileViewport(windowHost));
    const timers = new Set();
    let enabled = false;
    let baselineHeight = 0;
    let baselineWidth = 0;
    let keyboardVisible = false;
    let animationFrame = 0;

    function report(type, extra = {}) {
        onEvent?.(type, { baselineHeight, keyboardVisible, ...extra });
    }

    function applyHeight(height, reason) {
        if (!enabled || height < 100) return;
        root.style.setProperty(HEIGHT_VARIABLE, `${height}px`);
        report('height-applied', { height, reason });
    }

    function updateFromViewport(reason) {
        animationFrame = 0;
        if (!enabled) return;

        const heights = readHeights(windowHost, documentHost);
        const width = readWidth(windowHost);
        const currentMaximum = maximumHeight(heights);
        const widthChanged = baselineWidth && Math.abs(width - baselineWidth) > 40;
        const editableFocused = isEditable(documentHost.activeElement);
        const currentMinimum = minimumHeight(heights);

        if (widthChanged) {
            baselineWidth = width;
            baselineHeight = currentMaximum;
            keyboardVisible = false;
            applyHeight(baselineHeight, 'width-changed');
            return;
        }

        if (!editableFocused) {
            if (currentMaximum > baselineHeight) baselineHeight = currentMaximum;
            keyboardVisible = false;
            applyHeight(baselineHeight, `${reason}-keyboard-closed`);
            return;
        }

        if (currentMinimum >= baselineHeight - KEYBOARD_MIN_HEIGHT) {
            baselineHeight = Math.max(baselineHeight, currentMaximum);
            keyboardVisible = false;
            applyHeight(currentMaximum, `${reason}-focused-full-height`);
            return;
        }

        keyboardVisible = true;
        const visibleHeight = currentMinimum;
        applyHeight(visibleHeight, `${reason}-keyboard-open`);
    }

    function scheduleUpdate(reason) {
        if (!enabled || animationFrame) return;
        if (typeof windowHost.requestAnimationFrame !== 'function') {
            updateFromViewport(reason);
            return;
        }
        animationFrame = windowHost.requestAnimationFrame(() => updateFromViewport(reason));
    }

    function scheduleSettledUpdates(reason) {
        scheduleUpdate(reason);
        if (typeof windowHost.setTimeout !== 'function') return;
        for (const delay of [100, 300, 600]) {
            const timer = windowHost.setTimeout(() => {
                timers.delete(timer);
                scheduleUpdate(`${reason}-${delay}ms`);
            }, delay);
            timers.add(timer);
        }
    }

    function onFocusIn() {
        const heights = readHeights(windowHost, documentHost);
        const currentMaximum = maximumHeight(heights);
        if (!keyboardVisible) baselineHeight = Math.max(baselineHeight, currentMaximum);
        report('focusin');
        scheduleSettledUpdates('focusin');
    }

    function onFocusOut() {
        keyboardVisible = false;
        applyHeight(baselineHeight, 'focusout-stable-baseline');
        report('focusout');
        scheduleSettledUpdates('focusout');
    }

    const onWindowResize = () => scheduleUpdate('window-resize');
    const onVisualResize = () => scheduleUpdate('visual-resize');

    function setEnabled(nextEnabled) {
        if (!supported) {
            enabled = false;
            return { enabled, supported };
        }
        if (Boolean(nextEnabled) === enabled) return { enabled, supported };

        enabled = Boolean(nextEnabled);
        if (enabled) {
            const heights = readHeights(windowHost, documentHost);
            baselineHeight = maximumHeight(heights);
            baselineWidth = readWidth(windowHost);
            keyboardVisible = false;
            root.classList.add(ROOT_CLASS);
            windowHost.addEventListener('resize', onWindowResize);
            visualViewport.addEventListener('resize', onVisualResize);
            documentHost.addEventListener('focusin', onFocusIn);
            documentHost.addEventListener('focusout', onFocusOut);
            applyHeight(baselineHeight, 'enabled-baseline');
        } else {
            // Reloading the page is the only supported extension unload path in
            // SillyTavern, but the switch itself must still restore the page.
            windowHost.removeEventListener('resize', onWindowResize);
            visualViewport.removeEventListener('resize', onVisualResize);
            documentHost.removeEventListener('focusin', onFocusIn);
            documentHost.removeEventListener('focusout', onFocusOut);
            root.classList.remove(ROOT_CLASS);
            root.style.removeProperty(HEIGHT_VARIABLE);
            for (const timer of timers) windowHost.clearTimeout?.(timer);
            timers.clear();
            if (animationFrame) windowHost.cancelAnimationFrame?.(animationFrame);
            animationFrame = 0;
            keyboardVisible = false;
            report('disabled');
        }

        return { enabled, supported };
    }

    return {
        get enabled() { return enabled; },
        get supported() { return supported; },
        get baselineHeight() { return baselineHeight; },
        setEnabled,
    };
}

export function createMobileKeyboardDiagnostics({
    windowHost = globalThis.window,
    documentHost = globalThis.document,
    extensionVersion = 'unknown',
    getSillyTavernVersion = () => 'unknown',
    onUpdate,
} = {}) {
    const events = [];
    const timers = new Set();
    let enabled = false;
    let startedAt = 0;
    let longTaskObserver = null;
    let dynamicViewportProbe = null;

    function snapshot(type, details = {}) {
        if (!enabled) return;
        const heights = readHeights(windowHost, documentHost);
        const rootStyle = windowHost.getComputedStyle?.(documentHost.documentElement);
        const body = documentHost.body;
        const sheld = documentHost.getElementById?.('sheld');
        const chat = documentHost.getElementById?.('chat');
        const form = documentHost.getElementById?.('form_sheld');
        const event = {
            ms: Math.round((windowHost.performance?.now?.() ?? Date.now()) - startedAt),
            type,
            heights,
            width: readWidth(windowHost),
            screen: {
                width: Math.round(Number(windowHost.screen?.width ?? 0)),
                height: Math.round(Number(windowHost.screen?.height ?? 0)),
                availableHeight: Math.round(Number(windowHost.screen?.availHeight ?? 0)),
            },
            active: activeElementLabel(documentHost),
            rootPosition: rootStyle?.position ?? null,
            appliedHeight: documentHost.documentElement?.style?.getPropertyValue?.(HEIGHT_VARIABLE) || null,
            css100dvh: Math.round(dynamicViewportProbe?.getBoundingClientRect?.().height ?? 0),
            rects: {
                sheld: readRect(documentHost, 'sheld'),
                chat: readRect(documentHost, 'chat'),
                form: readRect(documentHost, 'form_sheld'),
            },
            computed: {
                body: readComputedLayout(windowHost, body),
                sheld: readComputedLayout(windowHost, sheld),
                chat: readComputedLayout(windowHost, chat),
                form: readComputedLayout(windowHost, form),
            },
            details,
        };
        events.push(event);
        if (events.length > MAX_DIAGNOSTIC_EVENTS) events.splice(0, events.length - MAX_DIAGNOSTIC_EVENTS);
        onUpdate?.(events.length, event);
    }

    function snapshotSequence(type) {
        snapshot(type);
        if (typeof windowHost.setTimeout !== 'function') return;
        for (const delay of [100, 300, 600]) {
            const timer = windowHost.setTimeout(() => {
                timers.delete(timer);
                snapshot(`${type}-${delay}ms`);
            }, delay);
            timers.add(timer);
        }
    }

    const handlers = {
        windowResize: () => snapshotSequence('window-resize'),
        visualResize: () => snapshotSequence('visual-resize'),
        focusIn: () => snapshotSequence('focusin'),
        focusOut: () => snapshotSequence('focusout'),
    };

    function setEnabled(nextEnabled) {
        if (Boolean(nextEnabled) === enabled) return enabled;
        enabled = Boolean(nextEnabled);
        if (enabled) {
            startedAt = windowHost.performance?.now?.() ?? Date.now();
            events.length = 0;
            if (typeof documentHost.createElement === 'function' && documentHost.body) {
                dynamicViewportProbe = documentHost.createElement('div');
                dynamicViewportProbe.setAttribute('aria-hidden', 'true');
                dynamicViewportProbe.style.cssText = 'position:fixed;pointer-events:none;visibility:hidden;width:1px;height:100dvh;';
                documentHost.body.appendChild(dynamicViewportProbe);
            }
            windowHost.addEventListener('resize', handlers.windowResize);
            windowHost.visualViewport?.addEventListener('resize', handlers.visualResize);
            documentHost.addEventListener('focusin', handlers.focusIn);
            documentHost.addEventListener('focusout', handlers.focusOut);
            if (typeof windowHost.PerformanceObserver === 'function') {
                try {
                    longTaskObserver = new windowHost.PerformanceObserver(list => {
                        for (const entry of list.getEntries()) {
                            snapshot('long-task', { duration: Math.round(entry.duration), name: entry.name });
                        }
                    });
                    longTaskObserver.observe({ type: 'longtask', buffered: true });
                } catch {
                    longTaskObserver = null;
                }
            }
            snapshot('diagnostics-enabled');
        } else {
            windowHost.removeEventListener('resize', handlers.windowResize);
            windowHost.visualViewport?.removeEventListener('resize', handlers.visualResize);
            documentHost.removeEventListener('focusin', handlers.focusIn);
            documentHost.removeEventListener('focusout', handlers.focusOut);
            longTaskObserver?.disconnect();
            longTaskObserver = null;
            for (const timer of timers) windowHost.clearTimeout?.(timer);
            timers.clear();
            dynamicViewportProbe?.remove();
            dynamicViewportProbe = null;
        }
        return enabled;
    }

    function clear() {
        events.length = 0;
        onUpdate?.(0, null);
    }

    function selectRecentKeyboardCycle() {
        if (events.length <= MAX_EXPORTED_EVENTS) return [...events];

        let start = -1;
        for (let index = events.length - 1; index >= 0; index--) {
            if (events[index].type === 'focusin') {
                start = index;
                break;
            }
        }
        const recent = events.slice(start >= 0 ? start : -MAX_EXPORTED_EVENTS);
        if (recent.length <= MAX_EXPORTED_EVENTS) return recent;
        return [...recent.slice(0, 4), ...recent.slice(-(MAX_EXPORTED_EVENTS - 4))];
    }

    function compactEvent(event) {
        const details = event.details ?? {};
        const compactDetails = {};
        if (details.baselineHeight != null) compactDetails.b = details.baselineHeight;
        if (details.keyboardVisible != null) compactDetails.k = details.keyboardVisible;
        if (details.height != null) compactDetails.h = details.height;
        if (details.reason != null) compactDetails.r = details.reason;
        if (details.duration != null) compactDetails.ms = details.duration;
        if (details.name != null) compactDetails.n = details.name;
        return {
            t: event.ms,
            e: event.type,
            h: [event.heights.inner, event.heights.visual, event.heights.client, event.css100dvh],
            w: event.width,
            a: event.active,
            ah: event.appliedHeight || null,
            r: [event.rects.sheld?.bottom ?? null, event.rects.chat?.bottom ?? null, event.rects.form?.top ?? null, event.rects.form?.bottom ?? null],
            d: compactDetails,
        };
    }

    function exportReport() {
        const selectedEvents = selectRecentKeyboardCycle();
        const lastEvent = selectedEvents.at(-1) ?? events.at(-1) ?? null;
        return JSON.stringify({
            schema: 2,
            mode: 'compact-latest-keyboard-cycle',
            extensionVersion,
            sillyTavernVersion: getSillyTavernVersion(),
            userAgent: String(windowHost.navigator?.userAgent ?? ''),
            platform: String(windowHost.navigator?.platform ?? ''),
            devicePixelRatio: Number(windowHost.devicePixelRatio ?? 1),
            recordedEvents: events.length,
            exportedEvents: selectedEvents.length,
            eventKeys: 't=毫秒,e=事件,h=[inner,visual,client,100dvh],w=宽度,a=焦点,ah=修复高度,r=[外壳底,聊天底,输入栏顶,输入栏底],d={b:基线,k:键盘,h:高度,r:原因,ms:长任务,n:名称}',
            screen: lastEvent?.screen ?? null,
            layout: lastEvent ? {
                rootPosition: lastEvent.rootPosition,
                body: lastEvent.computed.body,
                sheld: lastEvent.computed.sheld,
                chat: lastEvent.computed.chat,
                form: lastEvent.computed.form,
            } : null,
            note: '从内存记录中自动提取最近一次键盘过程；不包含聊天或输入内容。',
            events: selectedEvents.map(compactEvent),
        });
    }

    return {
        get enabled() { return enabled; },
        get eventCount() { return events.length; },
        clear,
        exportReport,
        record: snapshot,
        setEnabled,
    };
}
