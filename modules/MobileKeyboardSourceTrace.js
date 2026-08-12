export const SOURCE_TRACE_STORAGE_KEY = 'srl.mobileKeyboardTrace.enabled';
export const SOURCE_TRACE_GLOBAL = '__srlMobileKeyboardTrace';

export function createSourceTraceReport(trace, { sillyTavernVersion = 'unknown' } = {}) {
    const events = Array.isArray(trace?.events) ? trace.events : [];
    return JSON.stringify({
        schema: 1,
        source: 'SillyTavern browser-fixes.js',
        sillyTavernVersion,
        recordedEvents: events.length,
        eventKeys: 't=performance.now毫秒,type=源码事件,cycle=同一次键盘过程,heights=[innerHeight,visualViewport.height],active=焦点元素,details=长任务毫秒',
        note: '仅由酒馆源码记录键盘焦点、resize、根节点定位写入/恢复与长任务；不包含聊天或输入内容。',
        events,
    });
}
