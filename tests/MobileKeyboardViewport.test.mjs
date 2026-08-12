import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createMobileKeyboardDiagnostics,
    createMobileKeyboardViewportFix,
} from '../modules/MobileKeyboardViewport.js';

class FakeStyle {
    constructor() {
        this.properties = new Map();
    }

    getPropertyValue(property) {
        return this.properties.get(property) ?? '';
    }

    setProperty(property, value) {
        this.properties.set(property, value);
    }

    removeProperty(property) {
        this.properties.delete(property);
    }
}

class FakeClassList {
    constructor() {
        this.values = new Set();
    }

    add(value) { this.values.add(value); }
    remove(value) { this.values.delete(value); }
    contains(value) { return this.values.has(value); }
}

function createEventTarget(extra = {}) {
    const listeners = new Map();
    return {
        ...extra,
        addEventListener(type, listener) {
            const entries = listeners.get(type) ?? [];
            entries.push(listener);
            listeners.set(type, entries);
        },
        removeEventListener(type, listener) {
            listeners.set(type, (listeners.get(type) ?? []).filter(entry => entry !== listener));
        },
        dispatch(type, target) {
            for (const listener of [...(listeners.get(type) ?? [])]) listener({ type, target });
        },
    };
}

function makeEnvironment() {
    let now = 0;
    let timerId = 0;
    const timers = new Map();
    const root = {
        clientHeight: 844,
        style: new FakeStyle(),
        classList: new FakeClassList(),
        getBoundingClientRect: () => ({ top: 0, bottom: 844, height: 844 }),
    };
    const body = { tagName: 'BODY' };
    const textarea = { tagName: 'TEXTAREA', id: 'send_textarea' };
    const elements = {
        sheld: { getBoundingClientRect: () => ({ top: 50, bottom: 844, height: 794 }) },
        chat: { getBoundingClientRect: () => ({ top: 50, bottom: 780, height: 730 }) },
        form_sheld: { getBoundingClientRect: () => ({ top: 780, bottom: 844, height: 64 }) },
    };
    const visualViewport = createEventTarget({ width: 390, height: 844 });
    const windowHost = createEventTarget({
        innerHeight: 844,
        innerWidth: 390,
        visualViewport,
        navigator: { maxTouchPoints: 1, userAgent: 'Fake Android', platform: 'Linux arm' },
        screen: { width: 390, height: 844, availHeight: 820 },
        devicePixelRatio: 3,
        performance: { now: () => now },
        matchMedia: () => ({ matches: true }),
        requestAnimationFrame(callback) { callback(); return 0; },
        cancelAnimationFrame() {},
        setTimeout(callback, delay) {
            const id = ++timerId;
            timers.set(id, { callback, delay });
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        getComputedStyle: () => ({ position: 'static' }),
    });
    const documentHost = createEventTarget({
        documentElement: root,
        body,
        activeElement: body,
        createElement() {
            return {
                style: {},
                setAttribute() {},
                getBoundingClientRect: () => ({ height: 844 }),
                remove() {},
            };
        },
        getElementById: id => elements[id] ?? null,
    });
    body.appendChild = () => {};
    return {
        body,
        documentHost,
        root,
        textarea,
        visualViewport,
        windowHost,
        advance(value) { now += value; },
        flushTimers() {
            const pending = [...timers.entries()].sort(([, left], [, right]) => left.delay - right.delay);
            for (const [id, timer] of pending) {
                if (!timers.has(id)) continue;
                timers.delete(id);
                timer.callback();
            }
        },
    };
}

test('restores the pre-keyboard stable height on blur even while viewport values are stale', () => {
    const env = makeEnvironment();
    const fix = createMobileKeyboardViewportFix({ windowHost: env.windowHost, documentHost: env.documentHost });

    assert.equal(fix.setEnabled(true).supported, true);
    assert.equal(env.root.style.getPropertyValue('--chat-reload-guard-app-height'), '844px');

    env.documentHost.activeElement = env.textarea;
    env.documentHost.dispatch('focusin', env.textarea);
    env.windowHost.innerHeight = 520;
    env.visualViewport.height = 520;
    // The fixed root can stay stale even though the visual viewport shrank.
    env.root.clientHeight = 844;
    env.visualViewport.dispatch('resize');
    assert.equal(env.root.style.getPropertyValue('--chat-reload-guard-app-height'), '520px');

    // Android can fire focusout before innerHeight/visualViewport recover.
    env.documentHost.activeElement = env.body;
    env.documentHost.dispatch('focusout', env.textarea);
    assert.equal(env.windowHost.innerHeight, 520);
    assert.equal(env.visualViewport.height, 520);
    assert.equal(env.root.style.getPropertyValue('--chat-reload-guard-app-height'), '844px');

    fix.setEnabled(false);
    assert.equal(env.root.style.getPropertyValue('--chat-reload-guard-app-height'), '');
    assert.equal(env.root.classList.contains('chat-reload-guard-mobile-viewport'), false);

    env.visualViewport.height = 400;
    env.visualViewport.dispatch('resize');
    env.documentHost.dispatch('focusout', env.textarea);
    assert.equal(env.root.style.getPropertyValue('--chat-reload-guard-app-height'), '');
});

test('diagnostics are bounded and contain geometry but no chat or input content', () => {
    const env = makeEnvironment();
    const diagnostics = createMobileKeyboardDiagnostics({
        windowHost: env.windowHost,
        documentHost: env.documentHost,
        extensionVersion: '0.3.0',
        getSillyTavernVersion: () => '1.18.0',
    });
    diagnostics.setEnabled(true);
    assert.equal(diagnostics.eventCount, 0);
    const copyButton = { tagName: 'BUTTON', id: 'chat-reload-guard-copy-diagnostics' };
    env.documentHost.activeElement = copyButton;
    env.documentHost.dispatch('focusin', copyButton);
    assert.equal(diagnostics.eventCount, 0);
    const fixToggle = { tagName: 'INPUT', type: 'checkbox', id: 'chat-reload-guard-mobile-fix' };
    env.documentHost.activeElement = fixToggle;
    env.documentHost.dispatch('focusin', fixToggle);
    assert.equal(diagnostics.eventCount, 0);
    env.documentHost.activeElement = env.textarea;
    env.documentHost.dispatch('focusin', env.textarea);
    for (let index = 0; index < 130; index++) {
        env.advance(1);
        diagnostics.record('test-event', { index });
    }
    for (let index = 0; index < 10; index++) diagnostics.record('visual-resize', { index });
    env.documentHost.activeElement = env.body;
    env.documentHost.dispatch('focusout', env.textarea);
    for (let index = 0; index < 20; index++) diagnostics.record('settled', { index });

    const reportText = diagnostics.exportReport();
    const report = JSON.parse(reportText);
    assert.equal(report.recordedEvents, 120);
    assert.equal(report.exportedEvents, 18);
    assert.equal(report.events[0].e, 'keyboard-focusin');
    assert.equal(report.events.at(-1).r[3], 844);
    assert.equal(report.events.at(-1).h[3], 844);
    assert.equal(report.events.at(-1).a, 'body');
    assert.ok(reportText.length < 6000);
    assert.equal(reportText.includes('chat-a'), false);
    assert.equal(reportText.includes('message'), false);
    assert.equal(reportText.includes('inputValue'), false);
});

test('diagnostics stops capturing after a keyboard cycle settles', () => {
    const env = makeEnvironment();
    const diagnostics = createMobileKeyboardDiagnostics({ windowHost: env.windowHost, documentHost: env.documentHost });
    diagnostics.setEnabled(true);
    env.documentHost.activeElement = env.textarea;
    env.documentHost.dispatch('focusin', env.textarea);
    env.documentHost.activeElement = env.body;
    env.documentHost.dispatch('focusout', env.textarea);
    env.flushTimers();
    const eventCount = diagnostics.eventCount;

    diagnostics.record('after-copy-button-long-task', { duration: 120 });
    assert.equal(diagnostics.eventCount, eventCount);
    assert.equal(JSON.parse(diagnostics.exportReport()).events.some(event => event.e === 'after-copy-button-long-task'), false);
});
