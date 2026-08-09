export const GUARD_MARKER = Symbol.for('sillytavern.chatReloadGuard.v1');

const SUPPORTED_VERSIONS = new Set(['1.18.0']);
const CHARACTER_GET_PATH = '/api/chats/get';
const CHARACTER_SAVE_PATH = '/api/chats/save';
const GROUP_GET_PATH = '/api/chats/group/get';
const GROUP_SAVE_PATH = '/api/chats/group/save';

function cloneValue(value) {
    if (typeof structuredClone === 'function') {
        return structuredClone(value);
    }

    return JSON.parse(JSON.stringify(value));
}

function compactSource(callback) {
    return typeof callback === 'function'
        ? Function.prototype.toString.call(callback).replace(/\s+/gu, '')
        : '';
}

/**
 * Only activates against the exact vulnerable control flow that was audited.
 * Unknown versions or changed internals are deliberately rejected.
 */
export function inspectCompatibility({ versionInfo, moduleNamespace }) {
    const version = String(versionInfo?.pkgVersion ?? '');
    const mutex = moduleNamespace?.reloadChatMutex;
    const getChat = moduleNamespace?.getChat;

    if (!version) {
        return { status: 'unsupported', reason: '无法读取 SillyTavern 版本。' };
    }

    if (!SUPPORTED_VERSIONS.has(version)) {
        return {
            status: 'unsupported',
            reason: `SillyTavern ${version} 尚未经过本插件兼容验证。`,
        };
    }

    if (!mutex || typeof mutex.update !== 'function' || typeof mutex.callback !== 'function') {
        return {
            status: 'changed',
            reason: '聊天重载接口已经变化，可能已由酒馆原生修复。',
        };
    }

    if (mutex[GUARD_MARKER]) {
        return { status: 'active', reason: '聊天重载保护器已经启用。', mutex };
    }

    const reloadSource = compactSource(mutex.callback);
    const getChatSource = compactSource(getChat);
    const clearIndex = reloadSource.indexOf('clearChat({clearData:true})');
    const loadIndex = reloadSource.indexOf('getChat()');
    const clearsBeforeLoad = clearIndex >= 0 && loadIndex > clearIndex;
    const recreatesAfterFailure = getChatSource.includes('catch(')
        && getChatSource.includes('getChatResult()');

    if (!clearsBeforeLoad || !recreatesAfterFailure) {
        return {
            status: 'changed',
            reason: '未检测到已知的危险重载流程，插件不会重复接管。',
        };
    }

    return { status: 'compatible', reason: '检测到已知危险重载流程。', mutex };
}

export function createChatSnapshot(context) {
    if (!context || !Array.isArray(context.chat) || !context.chatId) {
        return null;
    }

    const character = context.groupId ? null : context.characters?.[context.characterId];
    return {
        chatId: String(context.chatId),
        groupId: context.groupId ? String(context.groupId) : null,
        avatarUrl: character?.avatar ? String(character.avatar) : null,
        metadata: cloneValue(context.chatMetadata ?? {}),
        messages: cloneValue(context.chat),
    };
}

export function buildSnapshotPayload(snapshot) {
    return [
        {
            chat_metadata: cloneValue(snapshot.metadata),
            user_name: 'unused',
            character_name: 'unused',
        },
        ...cloneValue(snapshot.messages),
    ];
}

function getHeader(headers, name) {
    if (!headers) return '';
    if (typeof headers.get === 'function') return headers.get(name) ?? '';
    const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
    return entry ? String(entry[1]) : '';
}

async function bodyToText(body, headers) {
    if (body === undefined || body === null) return '';
    if (typeof body === 'string') return body;
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();

    let bytes;
    if (body instanceof ArrayBuffer) {
        bytes = new Uint8Array(body);
    } else if (ArrayBuffer.isView(body)) {
        bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    } else if (typeof Blob !== 'undefined' && body instanceof Blob) {
        bytes = new Uint8Array(await body.arrayBuffer());
    } else {
        return '';
    }

    if (getHeader(headers, 'content-encoding').toLowerCase() === 'gzip') {
        if (typeof DecompressionStream !== 'function') return '';
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        return await new Response(stream).text();
    }

    return new TextDecoder().decode(bytes);
}

async function describeRequest(input, init) {
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const url = isRequest ? input.url : String(input);
    const pathname = new URL(url, 'http://localhost').pathname;
    const headers = init?.headers ?? (isRequest ? input.headers : undefined);
    let body = init?.body;

    if (body === undefined && isRequest) {
        body = await input.clone().arrayBuffer();
    }

    const text = await bodyToText(body, headers);
    let json = null;
    if (text) {
        try {
            json = JSON.parse(text);
        } catch {
            json = null;
        }
    }

    return { pathname, json };
}

function isMatchingLoad(details, snapshot) {
    if (snapshot.groupId) {
        return details.pathname === GROUP_GET_PATH
            && String(details.json?.id ?? '') === snapshot.chatId;
    }

    return details.pathname === CHARACTER_GET_PATH
        && String(details.json?.file_name ?? '') === snapshot.chatId
        && (!snapshot.avatarUrl || String(details.json?.avatar_url ?? '') === snapshot.avatarUrl);
}

function isMatchingSave(details, snapshot) {
    if (snapshot.groupId) {
        return details.pathname === GROUP_SAVE_PATH
            && String(details.json?.id ?? '') === snapshot.chatId;
    }

    return details.pathname === CHARACTER_SAVE_PATH
        && String(details.json?.file_name ?? '') === snapshot.chatId
        && (!snapshot.avatarUrl || String(details.json?.avatar_url ?? '') === snapshot.avatarUrl);
}

function validateLoadedChat(data, snapshot) {
    if (!Array.isArray(data) || data.length === 0) {
        return { valid: false, reason: 'invalid-load-response', receivedCount: 0 };
    }

    const header = data[0];
    if (!header || typeof header !== 'object' || !Object.hasOwn(header, 'chat_metadata')) {
        return { valid: false, reason: 'missing-chat-header', receivedCount: Math.max(0, data.length - 1) };
    }

    const receivedCount = data.length - 1;
    if (receivedCount < snapshot.messages.length) {
        return { valid: false, reason: 'unexpected-chat-shrink', receivedCount };
    }

    const incomingIntegrity = header.chat_metadata?.integrity;
    const snapshotIntegrity = snapshot.metadata?.integrity;
    if (incomingIntegrity && snapshotIntegrity && incomingIntegrity !== snapshotIntegrity) {
        return { valid: false, reason: 'integrity-conflict', receivedCount };
    }

    return { valid: true, receivedCount };
}

function snapshotResponse(snapshot, reason) {
    return new Response(JSON.stringify(buildSnapshotPayload(snapshot)), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            'X-ST-Chat-Reload-Guard': reason,
        },
    });
}

function blockedSaveResponse() {
    return new Response(JSON.stringify({ ok: true, guarded: true }), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            'X-ST-Chat-Reload-Guard': 'blocked-save',
        },
    });
}

export function createGuardedFetch({ downstreamFetch, snapshot, onProtection }) {
    const events = [];
    const record = (event) => {
        events.push(event);
        onProtection?.(event);
    };

    const guardedFetch = async (input, init) => {
        let details;
        try {
            details = await describeRequest(input, init);
        } catch {
            return await downstreamFetch(input, init);
        }

        if (isMatchingSave(details, snapshot)) {
            const payload = details.json?.chat;
            const outgoingCount = Array.isArray(payload) ? Math.max(0, payload.length - 1) : null;
            if (outgoingCount !== null && outgoingCount < snapshot.messages.length) {
                record({
                    type: 'save-blocked',
                    reason: 'unexpected-chat-shrink',
                    beforeCount: snapshot.messages.length,
                    afterCount: outgoingCount,
                });
                return blockedSaveResponse();
            }
        }

        if (!isMatchingLoad(details, snapshot)) {
            return await downstreamFetch(input, init);
        }

        try {
            const response = await downstreamFetch(input, init);
            if (!response.ok) {
                record({
                    type: 'load-fallback',
                    reason: `http-${response.status}`,
                    beforeCount: snapshot.messages.length,
                    afterCount: 0,
                });
                return snapshotResponse(snapshot, `http-${response.status}`);
            }

            let data;
            try {
                data = await response.clone().json();
            } catch {
                record({
                    type: 'load-fallback',
                    reason: 'invalid-json',
                    beforeCount: snapshot.messages.length,
                    afterCount: 0,
                });
                return snapshotResponse(snapshot, 'invalid-json');
            }

            const validation = validateLoadedChat(data, snapshot);
            if (!validation.valid) {
                record({
                    type: 'load-fallback',
                    reason: validation.reason,
                    beforeCount: snapshot.messages.length,
                    afterCount: validation.receivedCount,
                });
                return snapshotResponse(snapshot, validation.reason);
            }

            return response;
        } catch (error) {
            record({
                type: 'load-fallback',
                reason: 'network-error',
                beforeCount: snapshot.messages.length,
                afterCount: 0,
                errorName: error?.name ?? 'Error',
            });
            return snapshotResponse(snapshot, 'network-error');
        }
    };

    return { guardedFetch, events };
}

async function restoreSnapshot(getContext, snapshot, force = false) {
    const context = getContext();
    if (!context || String(context.chatId ?? '') !== snapshot.chatId || !Array.isArray(context.chat)) {
        return false;
    }

    if (!force && context.chat.length >= snapshot.messages.length) {
        return false;
    }

    if (typeof context.clearChat !== 'function' || typeof context.printMessages !== 'function') {
        return false;
    }

    await context.clearChat({ clearData: true });
    context.chat.splice(0, context.chat.length, ...cloneValue(snapshot.messages));
    context.updateChatMetadata?.(cloneValue(snapshot.metadata), true);
    await context.printMessages();
    return true;
}

export function installReloadGuard({ mutex, getContext, fetchHost = globalThis, onProtection }) {
    if (!mutex || typeof mutex.callback !== 'function') {
        throw new TypeError('reloadChatMutex.callback is unavailable');
    }
    if (typeof getContext !== 'function') {
        throw new TypeError('getContext must be a function');
    }
    if (typeof fetchHost.fetch !== 'function') {
        throw new TypeError('fetch is unavailable');
    }

    if (mutex[GUARD_MARKER]) {
        return mutex[GUARD_MARKER];
    }

    const originalCallback = mutex.callback;
    const controller = {
        active: true,
        uninstall() {
            if (mutex.callback === guardedCallback) {
                mutex.callback = originalCallback;
            }
            delete mutex[GUARD_MARKER];
            controller.active = false;
        },
    };

    async function guardedCallback(...args) {
        const snapshot = createChatSnapshot(getContext());
        if (!snapshot || snapshot.messages.length === 0) {
            return await originalCallback.apply(this, args);
        }

        const previousFetch = fetchHost.fetch;
        const protectionEvents = [];
        const { guardedFetch, events } = createGuardedFetch({
            downstreamFetch: previousFetch.bind(fetchHost),
            snapshot,
            onProtection: event => protectionEvents.push(event),
        });

        fetchHost.fetch = guardedFetch;
        let callbackError = null;
        try {
            await originalCallback.apply(this, args);
        } catch (error) {
            callbackError = error;
        } finally {
            if (fetchHost.fetch === guardedFetch) {
                fetchHost.fetch = previousFetch;
            }
        }

        const restored = await restoreSnapshot(getContext, snapshot, Boolean(callbackError));
        if (events.length || callbackError) {
            onProtection?.({
                chatId: snapshot.chatId,
                beforeCount: snapshot.messages.length,
                events: protectionEvents,
                restored,
                callbackError: callbackError?.name ?? null,
            });
        }

        if (callbackError) {
            throw callbackError;
        }
    }

    mutex.callback = guardedCallback;
    mutex[GUARD_MARKER] = controller;
    return controller;
}
