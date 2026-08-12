import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import {
    createChatSnapshot,
    createGuardedFetch,
    inspectCompatibility,
    installReloadGuard,
} from '../modules/ChatReloadGuardCore.js';
import {
    createMobileKeyboardJankGuard,
    isLikelyVirtualKeyboardTransition,
} from '../modules/MobileKeyboardJankGuard.js';

class FakeRoot {
    constructor() {
        this.observers = new Set();
        let position = '';
        this.style = {};
        Object.defineProperty(this.style, 'position', {
            get: () => position,
            set: value => {
                position = value;
                for (const observer of this.observers) observer.callback();
            },
        });
    }
}

class FakeMutationObserver {
    constructor(callback) {
        this.callback = callback;
        this.root = null;
    }

    observe(root) {
        this.root = root;
        root.observers.add(this);
    }

    disconnect() {
        this.root?.observers.delete(this);
        this.root = null;
    }
}

function makeKeyboardGuardEnvironment() {
    const listeners = new Map();
    const root = new FakeRoot();
    const windowHost = {
        innerWidth: 390,
        innerHeight: 844,
        visualViewport: { width: 390, height: 844 },
        navigator: { maxTouchPoints: 1 },
        MutationObserver: FakeMutationObserver,
        matchMedia: () => ({ matches: true }),
        addEventListener(type, listener, capture) {
            const entries = listeners.get(type) ?? [];
            entries.push({ listener, capture: Boolean(capture) });
            listeners.set(type, entries);
        },
        removeEventListener(type, listener, capture) {
            const entries = listeners.get(type) ?? [];
            listeners.set(type, entries.filter(entry => entry.listener !== listener || entry.capture !== Boolean(capture)));
        },
        dispatch(type) {
            const entries = [...(listeners.get(type) ?? [])].sort((a, b) => Number(b.capture) - Number(a.capture));
            for (const entry of entries) entry.listener();
        },
    };
    const documentHost = { documentElement: root, activeElement: { tagName: 'TEXTAREA' } };
    return { windowHost, documentHost, root };
}

function vulnerableReload() {
    clearChat({ clearData: true });
    return getChat();
}

function vulnerableGetChat() {
    try {
        return fetch('/api/chats/get');
    } catch (error) {
        return getChatResult();
    }
}

function makeContext(messageCount = 3) {
    const context = {
        chatId: 'chat-a',
        groupId: null,
        characterId: 0,
        characters: [{ avatar: 'char.png' }],
        chatMetadata: { integrity: 'same-integrity' },
        chat: Array.from({ length: messageCount }, (_, index) => ({ mes: `message-${index}` })),
        clearChat: async ({ clearData }) => {
            if (clearData) context.chat.length = 0;
        },
        updateChatMetadata: metadata => {
            context.chatMetadata = metadata;
        },
        printMessages: async () => {},
    };
    return context;
}

function chatRequest(path = '/api/chats/get') {
    return [path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_name: 'chat-a', avatar_url: 'char.png' }),
    }];
}

test('only enables on the audited vulnerable 1.18.0 flow', () => {
    const mutex = { update() {}, callback: vulnerableReload };
    const compatible = inspectCompatibility({
        versionInfo: { pkgVersion: '1.18.0' },
        moduleNamespace: { reloadChatMutex: mutex, getChat: vulnerableGetChat },
    });
    assert.equal(compatible.status, 'compatible');

    const future = inspectCompatibility({
        versionInfo: { pkgVersion: '1.19.0' },
        moduleNamespace: { reloadChatMutex: mutex, getChat: vulnerableGetChat },
    });
    assert.equal(future.status, 'unsupported');

    const fixed = inspectCompatibility({
        versionInfo: { pkgVersion: '1.18.0' },
        moduleNamespace: { reloadChatMutex: mutex, getChat: async function getChat() {} },
    });
    assert.equal(fixed.status, 'changed');
});

test('recognizes opening and closing virtual keyboards but not an orientation resize', () => {
    const input = { tagName: 'TEXTAREA' };
    assert.equal(isLikelyVirtualKeyboardTransition({
        previousViewport: { width: 390, height: 844 },
        currentViewport: { width: 390, height: 520 },
        activeElement: input,
        wasKeyboardVisible: false,
    }), true);
    assert.equal(isLikelyVirtualKeyboardTransition({
        previousViewport: { width: 390, height: 520 },
        currentViewport: { width: 390, height: 844 },
        activeElement: input,
        wasKeyboardVisible: true,
        keyboardBaselineHeight: 844,
    }), true);
    assert.equal(isLikelyVirtualKeyboardTransition({
        previousViewport: { width: 390, height: 844 },
        currentViewport: { width: 844, height: 390 },
        activeElement: input,
        wasKeyboardVisible: false,
    }), false);
});

test('keeps resize listeners intact while removing only the keyboard-transition root fixed mutation', () => {
    const { windowHost, documentHost, root } = makeKeyboardGuardEnvironment();
    let nativeResizeHandlerRuns = 0;
    windowHost.addEventListener('resize', () => {
        nativeResizeHandlerRuns++;
        root.style.position = 'fixed';
    });

    const guard = createMobileKeyboardJankGuard({ windowHost, documentHost });
    assert.equal(guard.supported, true);
    guard.setEnabled(true);
    windowHost.visualViewport.height = 520;
    windowHost.dispatch('resize');

    assert.equal(nativeResizeHandlerRuns, 1);
    assert.equal(root.style.position, '');

    root.style.position = '';
    windowHost.visualViewport.width = 844;
    windowHost.visualViewport.height = 390;
    windowHost.dispatch('resize');
    assert.equal(nativeResizeHandlerRuns, 2);
    assert.equal(root.style.position, 'fixed');

    guard.setEnabled(false);
    windowHost.visualViewport.height = 844;
    windowHost.dispatch('resize');
    assert.equal(nativeResizeHandlerRuns, 3);
    assert.equal(root.style.position, 'fixed');
});

test('creates a detached in-memory snapshot', () => {
    const context = makeContext();
    const snapshot = createChatSnapshot(context);
    context.chat[0].mes = 'changed';
    context.chatMetadata.integrity = 'changed';
    assert.equal(snapshot.messages[0].mes, 'message-0');
    assert.equal(snapshot.metadata.integrity, 'same-integrity');
});

test('returns the snapshot when chat loading fails with HTTP error', async () => {
    const snapshot = createChatSnapshot(makeContext());
    let protections = 0;
    const { guardedFetch } = createGuardedFetch({
        snapshot,
        downstreamFetch: async () => new Response('failure', { status: 500 }),
        onProtection: () => protections++,
    });

    const response = await guardedFetch(...chatRequest());
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-ST-Chat-Reload-Guard'), 'http-500');
    assert.equal(data.length, 4);
    assert.equal(protections, 1);
});

test('returns the snapshot for malformed or unexpectedly shorter chat data', async () => {
    const snapshot = createChatSnapshot(makeContext());
    const malformed = createGuardedFetch({
        snapshot,
        downstreamFetch: async () => new Response('{broken', { status: 200 }),
    });
    const malformedResponse = await malformed.guardedFetch(...chatRequest());
    assert.equal((await malformedResponse.json()).length, 4);

    const short = createGuardedFetch({
        snapshot,
        downstreamFetch: async () => Response.json([
            { chat_metadata: { integrity: 'same-integrity' } },
            { mes: 'only-one' },
        ]),
    });
    const shortResponse = await short.guardedFetch(...chatRequest());
    assert.equal(shortResponse.headers.get('X-ST-Chat-Reload-Guard'), 'unexpected-chat-shrink');
    assert.equal((await shortResponse.json()).length, 4);
});

test('passes through a valid chat load and unrelated requests', async () => {
    const snapshot = createChatSnapshot(makeContext());
    let calls = 0;
    const downstreamFetch = async input => {
        calls++;
        if (String(input).includes('/api/chats/get')) {
            return Response.json([
                { chat_metadata: { integrity: 'same-integrity' } },
                ...snapshot.messages,
            ]);
        }
        return new Response('ok');
    };
    const { guardedFetch } = createGuardedFetch({ snapshot, downstreamFetch });

    const chatResponse = await guardedFetch(...chatRequest());
    assert.equal(chatResponse.headers.has('X-ST-Chat-Reload-Guard'), false);
    assert.equal((await chatResponse.json()).length, 4);
    assert.equal(await (await guardedFetch('/api/settings/get')).text(), 'ok');
    assert.equal(calls, 2);
});

test('blocks a save that would replace the current chat with one message', async () => {
    const snapshot = createChatSnapshot(makeContext());
    let downstreamCalls = 0;
    const { guardedFetch, events } = createGuardedFetch({
        snapshot,
        downstreamFetch: async () => {
            downstreamCalls++;
            return Response.json({ ok: true });
        },
    });
    const response = await guardedFetch('/api/chats/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            file_name: 'chat-a',
            avatar_url: 'char.png',
            chat: [
                { chat_metadata: { integrity: 'same-integrity' } },
                { mes: 'opening' },
            ],
        }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-ST-Chat-Reload-Guard'), 'blocked-save');
    assert.equal(downstreamCalls, 0);
    assert.equal(events[0].type, 'save-blocked');
});

test('blocks the same dangerous save when request compression is enabled', async () => {
    const snapshot = createChatSnapshot(makeContext());
    const compressedBody = gzipSync(JSON.stringify({
        file_name: 'chat-a',
        avatar_url: 'char.png',
        chat: [
            { chat_metadata: { integrity: 'same-integrity' } },
            { mes: 'opening' },
        ],
    }));
    let downstreamCalls = 0;
    const { guardedFetch } = createGuardedFetch({
        snapshot,
        downstreamFetch: async () => {
            downstreamCalls++;
            return Response.json({ ok: true });
        },
    });

    const response = await guardedFetch('/api/chats/save', {
        method: 'POST',
        headers: { 'Content-Encoding': 'gzip' },
        body: compressedBody,
    });

    assert.equal(response.headers.get('X-ST-Chat-Reload-Guard'), 'blocked-save');
    assert.equal(downstreamCalls, 0);
});

test('protects group-chat reloads with the same in-memory snapshot', async () => {
    const context = makeContext();
    context.groupId = 'group-a';
    context.chatId = 'group-chat-a';
    const snapshot = createChatSnapshot(context);
    const { guardedFetch } = createGuardedFetch({
        snapshot,
        downstreamFetch: async () => new Response('offline', { status: 502 }),
    });

    const response = await guardedFetch('/api/chats/group/get', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'group-chat-a' }),
    });

    assert.equal(response.headers.get('X-ST-Chat-Reload-Guard'), 'http-502');
    assert.equal((await response.json()).length, 4);
});

test('wraps the mutex callback, restores fetch, and survives a failed reload', async () => {
    const context = makeContext();
    const fetchHost = {
        fetch: async input => {
            if (String(input).includes('/api/chats/get')) {
                return new Response('failure', { status: 503 });
            }
            throw new Error(`Unexpected request: ${input}`);
        },
    };
    const originalFetch = fetchHost.fetch;
    const mutex = {
        async update(...args) {
            await this.callback(...args);
        },
        async callback() {
            context.chat.length = 0;
            const response = await fetchHost.fetch(...chatRequest());
            const data = await response.json();
            data.shift();
            context.chat.splice(0, context.chat.length, ...data);
        },
    };
    let report = null;
    installReloadGuard({
        mutex,
        getContext: () => context,
        fetchHost,
        onProtection: value => { report = value; },
    });

    await mutex.update();
    assert.equal(context.chat.length, 3);
    assert.equal(context.chat[2].mes, 'message-2');
    assert.equal(fetchHost.fetch, originalFetch);
    assert.equal(report.events[0].reason, 'http-503');
});

test('prevents the exact failed reload from creating and saving an opening-only chat', async () => {
    const context = makeContext(4);
    const originalMessages = structuredClone(context.chat);
    let loadCalls = 0;
    let saveCalls = 0;
    const fetchHost = {
        fetch: async input => {
            const pathname = new URL(String(input), 'http://localhost').pathname;
            if (pathname === '/api/chats/get') {
                loadCalls++;
                return new Response('temporary failure', { status: 503 });
            }
            if (pathname === '/api/chats/save') {
                saveCalls++;
                return Response.json({ ok: true });
            }
            throw new Error(`Unexpected request: ${input}`);
        },
    };
    const mutex = {
        async update() {
            await this.callback();
        },
        async callback() {
            context.chat.length = 0;
            const response = await fetchHost.fetch(...chatRequest());
            const data = await response.json();
            data.shift();
            context.chat.splice(0, context.chat.length, ...data);

            // Mirrors SillyTavern getChatResult(): a failed load used to be
            // mistaken for a new chat and the opening message was saved.
            if (context.chat.length === 0) {
                context.chat.push({ mes: 'opening' });
                await fetchHost.fetch('/api/chats/save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        file_name: 'chat-a',
                        avatar_url: 'char.png',
                        chat: [
                            { chat_metadata: context.chatMetadata },
                            ...context.chat,
                        ],
                    }),
                });
            }
        },
    };

    installReloadGuard({ mutex, getContext: () => context, fetchHost });
    await mutex.update();

    assert.equal(loadCalls, 1);
    assert.equal(saveCalls, 0);
    assert.deepEqual(context.chat, originalMessages);
});

test('does not block another plugin saving a different chat during a guarded reload', async () => {
    const snapshot = createChatSnapshot(makeContext());
    let downstreamCalls = 0;
    const { guardedFetch, events } = createGuardedFetch({
        snapshot,
        downstreamFetch: async () => {
            downstreamCalls++;
            return Response.json({ ok: true });
        },
    });

    const response = await guardedFetch('/api/chats/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            file_name: 'chat-b',
            avatar_url: 'other-character.png',
            chat: [
                { chat_metadata: { integrity: 'other-integrity' } },
                { mes: 'opening' },
            ],
        }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.has('X-ST-Chat-Reload-Guard'), false);
    assert.equal(downstreamCalls, 1);
    assert.equal(events.length, 0);
});

test('restores the in-memory chat if the reload callback throws after clearing it', async () => {
    const context = makeContext(1);
    const fetchHost = { fetch: async () => Response.json({ ok: true }) };
    const mutex = {
        async update() {
            await this.callback();
        },
        async callback() {
            context.chat.length = 0;
            throw new TypeError('reload failed before fetch');
        },
    };
    let report = null;
    installReloadGuard({
        mutex,
        getContext: () => context,
        fetchHost,
        onProtection: value => { report = value; },
    });

    await assert.rejects(() => mutex.update(), /reload failed before fetch/u);
    assert.equal(context.chat.length, 1);
    assert.equal(context.chat[0].mes, 'message-0');
    assert.equal(report.restored, true);
    assert.equal(report.callbackError, 'TypeError');
});
