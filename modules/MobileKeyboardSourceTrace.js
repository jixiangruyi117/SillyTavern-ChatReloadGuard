export const SOURCE_TRACE_STORAGE_KEY = 'srl.mobileKeyboardTrace.enabled';
export const SOURCE_TRACE_GLOBAL = '__srlMobileKeyboardTrace';

export async function probeServedBrowserFixes(fetchFn = globalThis.fetch?.bind(globalThis)) {
    if (typeof fetchFn !== 'function') return { checked: false, reason: 'fetch-unavailable' };
    try {
        const response = await fetchFn(`/scripts/browser-fixes.js?sourceTrace=${Date.now()}`, { cache: 'no-store' });
        const source = await response.text();
        return {
            checked: true,
            status: response.status,
            hasRecorderMarker: source.includes('MOBILE_KEYBOARD_TRACE_GLOBAL'),
            bytes: source.length,
        };
    } catch (error) {
        return { checked: false, reason: String(error?.message ?? error) };
    }
}

export function createSourceTraceReport(trace, { sillyTavernVersion = 'unknown', servedSource = null } = {}) {
    const events = Array.isArray(trace?.events) ? trace.events : [];
    const interactionEvents = Array.isArray(trace?.interactionEvents) ? trace.interactionEvents : [];
    const longAnimationFrames = Array.isArray(trace?.longAnimationFrames) ? trace.longAnimationFrames : [];
    const recorder = {
        installed: trace?.recorder?.installed === true,
        enabled: trace?.recorder?.enabled === true,
    };
    return JSON.stringify({
        schema: 1,
        source: 'SillyTavern browser-fixes.js',
        sillyTavernVersion,
        recorder,
        servedSource,
        recordedEvents: events.length,
        recordedInteractionEvents: interactionEvents.length,
        recordedLongAnimationFrames: longAnimationFrames.length,
        eventKeys: 'events=源码时序；interactionEvents=点击/展开/焦点及长任务；longAnimationFrames=含脚本路径的长动画帧；均不记录文本内容',
        note: '源码时序来自酒馆 browser-fixes.js；交互和长动画帧由扩展只读记录，用于关联全局卡顿；不包含聊天或输入内容。',
        events,
        interactionEvents,
        longAnimationFrames,
    });
}
