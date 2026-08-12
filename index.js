import {
    installReloadGuard,
    inspectCompatibility,
} from './modules/ChatReloadGuardCore.js';
import {
    createMobileKeyboardDiagnostics,
    createMobileKeyboardViewportFix,
} from './modules/MobileKeyboardViewport.js';

const EXTENSION_FOLDER = 'third-party/SillyTavern-ChatReloadGuard';
const EXTENSION_VERSION = '0.3.1';
const SETTINGS_KEY = 'sillyTavernChatReloadGuard';
const STATUS_ID = 'chat-reload-guard-status';
const DETAIL_ID = 'chat-reload-guard-detail';
const MOBILE_FIX_ID = 'chat-reload-guard-mobile-fix';
const MOBILE_FIX_STATUS_ID = 'chat-reload-guard-mobile-fix-status';
const DIAGNOSTICS_ID = 'chat-reload-guard-mobile-diagnostics';
const DIAGNOSTICS_STATUS_ID = 'chat-reload-guard-mobile-diagnostics-status';

function showToast(level, message, title, persistent = false) {
    const toast = globalThis.toastr?.[level];
    if (typeof toast !== 'function') return;
    toast(message, title, persistent
        ? { timeOut: 0, extendedTimeOut: 0, closeButton: true, preventDuplicates: true }
        : { timeOut: 8000, closeButton: true, preventDuplicates: true });
}

async function mountStatusPanel(context) {
    if (document.getElementById(STATUS_ID)) return;
    const container = document.getElementById('extensions_settings2');
    if (!container || typeof context.renderExtensionTemplateAsync !== 'function') return;
    const html = await context.renderExtensionTemplateAsync(EXTENSION_FOLDER, 'settings', {});
    container.insertAdjacentHTML('beforeend', html);
}

function updateStatus(status, label, detail) {
    const statusElement = document.getElementById(STATUS_ID);
    const detailElement = document.getElementById(DETAIL_ID);
    if (statusElement) {
        statusElement.dataset.status = status;
        statusElement.textContent = label;
    }
    if (detailElement) detailElement.textContent = detail;
}

async function getVersionInfo() {
    const response = await fetch('/version', { cache: 'no-store' });
    if (!response.ok) throw new Error(`version_http_${response.status}`);
    return await response.json();
}

function formatVersion(versionInfo) {
    const revision = versionInfo?.gitRevision ? ` (${String(versionInfo.gitRevision).slice(0, 7)})` : '';
    return `${versionInfo?.pkgVersion ?? '未知版本'}${revision}`;
}

function getExtensionSettings(context) {
    if (!context.extensionSettings) return { mobileKeyboardFix: false, mobileKeyboardDiagnostics: false };
    context.extensionSettings[SETTINGS_KEY] ??= {};
    return context.extensionSettings[SETTINGS_KEY];
}

function saveExtensionSetting(context, key, value) {
    const settings = getExtensionSettings(context);
    settings[key] = value;
    context.saveSettingsDebounced?.();
}

function setText(id, text) {
    const element = document.getElementById(id);
    if (element) element.textContent = text;
}

async function copyText(text) {
    if (typeof navigator.clipboard?.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
}

function installMobileKeyboardTools(context, sillyTavernVersion, repairSupported) {
    const fixToggle = document.getElementById(MOBILE_FIX_ID);
    const diagnosticsToggle = document.getElementById(DIAGNOSTICS_ID);
    const copyButton = document.getElementById('chat-reload-guard-copy-diagnostics');
    const clearButton = document.getElementById('chat-reload-guard-clear-diagnostics');
    if (!fixToggle || !diagnosticsToggle || !copyButton || !clearButton) return;

    const settings = getExtensionSettings(context);
    const diagnostics = createMobileKeyboardDiagnostics({
        extensionVersion: EXTENSION_VERSION,
        getSillyTavernVersion: () => sillyTavernVersion,
        onUpdate: count => setText(DIAGNOSTICS_STATUS_ID, count ? `已在内存记录 ${count} 条事件。` : '诊断记录已清空。'),
    });
    const viewportFix = createMobileKeyboardViewportFix({
        onEvent: (type, details) => diagnostics.record(`fix:${type}`, details),
    });

    const applyFix = enabled => {
        const result = viewportFix.setEnabled(enabled);
        fixToggle.checked = result.enabled;
        setText(MOBILE_FIX_STATUS_ID, !result.supported
            ? '当前环境不支持移动端可视视口修复；设置仅会在兼容移动浏览器生效。'
            : result.enabled
                ? `已启用，当前稳定高度 ${viewportFix.baselineHeight}px。`
                : '未启用，不改变酒馆原始布局。');
    };

    fixToggle.disabled = !repairSupported;
    fixToggle.checked = repairSupported && settings.mobileKeyboardFix === true;
    diagnosticsToggle.checked = settings.mobileKeyboardDiagnostics === true;
    diagnostics.setEnabled(diagnosticsToggle.checked);
    if (repairSupported) {
        applyFix(fixToggle.checked);
    } else {
        setText(MOBILE_FIX_STATUS_ID, `${sillyTavernVersion} 尚未审计此项修复，开关已停用；只读诊断仍可使用。`);
    }

    fixToggle.addEventListener('change', () => {
        saveExtensionSetting(context, 'mobileKeyboardFix', fixToggle.checked);
        applyFix(fixToggle.checked);
    });
    diagnosticsToggle.addEventListener('change', () => {
        saveExtensionSetting(context, 'mobileKeyboardDiagnostics', diagnosticsToggle.checked);
        diagnostics.setEnabled(diagnosticsToggle.checked);
        setText(DIAGNOSTICS_STATUS_ID, diagnostics.enabled ? `已启用，当前 ${diagnostics.eventCount} 条事件。` : '未记录。');
    });
    copyButton.addEventListener('click', async () => {
        try {
            await copyText(diagnostics.exportReport());
            setText(DIAGNOSTICS_STATUS_ID, `已从 ${diagnostics.eventCount} 条内存记录中复制最近一次键盘过程的精简诊断。`);
        } catch (error) {
            setText(DIAGNOSTICS_STATUS_ID, `复制失败：${String(error?.message ?? error)}`);
        }
    });
    clearButton.addEventListener('click', () => diagnostics.clear());

    return {
        setSillyTavernVersion(value) {
            diagnostics.record('sillytavern-version', { value });
        },
    };
}

export async function activate() {
    const context = globalThis.SillyTavern?.getContext?.();
    if (!context) {
        showToast('error', '无法取得 SillyTavern 上下文，插件未启用。', '聊天重载保护器', true);
        return;
    }

    await mountStatusPanel(context);
    try {
        const [versionInfo, scriptModule] = await Promise.all([
            getVersionInfo(),
            import('/script.js'),
        ]);
        const compatibility = inspectCompatibility({ versionInfo, moduleNamespace: scriptModule });
        const versionLabel = formatVersion(versionInfo);
        const mobileKeyboardTools = installMobileKeyboardTools(context, versionLabel, versionInfo?.pkgVersion === '1.18.0');
        mobileKeyboardTools?.setSillyTavernVersion(versionLabel);

        if (compatibility.status === 'unsupported') {
            updateStatus('unsupported', '未启用', `${versionLabel}：${compatibility.reason}`);
            showToast(
                'warning',
                `${compatibility.reason} 插件已安全停用，请更新插件；确认前避免切换正则预设。`,
                '聊天重载保护器未验证',
                true,
            );
            return;
        }

        if (compatibility.status === 'changed') {
            updateStatus('native', '未接管', `${versionLabel}：${compatibility.reason}`);
            showToast(
                'info',
                `${compatibility.reason} 如果新版酒馆已原生修复，可以停用或卸载本插件。`,
                '聊天重载实现已变化',
                true,
            );
            return;
        }

        if (compatibility.status === 'active') {
            updateStatus('active', '保护中', `${versionLabel}：插件已经启用。`);
            return;
        }

        installReloadGuard({
            mutex: compatibility.mutex,
            getContext: () => ({
                ...globalThis.SillyTavern.getContext(),
                clearChat: scriptModule.clearChat,
                printMessages: scriptModule.printMessages,
                updateChatMetadata: scriptModule.updateChatMetadata,
            }),
            fetchHost: globalThis,
            onProtection: report => {
                const event = report.events?.[0];
                const detail = event
                    ? `消息数 ${event.beforeCount} → ${event.afterCount}，原因：${event.reason}`
                    : `消息数 ${report.beforeCount}，重载回调异常：${report.callbackError ?? '未知'}`;
                updateStatus('protected', '已阻止一次危险重载', `${versionLabel}：${detail}`);
                showToast(
                    'error',
                    `已保留当前聊天并阻止覆盖。${detail}。建议检查服务器状态和聊天备份。`,
                    '聊天记录已保护',
                    true,
                );
            },
        });

        updateStatus('active', '保护中', `${versionLabel}：已检测并接管危险重载流程。`);
        console.info(`[ChatReloadGuard] Active for SillyTavern ${versionLabel}`);
    } catch (error) {
        console.error('[ChatReloadGuard] Activation failed', error);
        updateStatus('error', '启用失败', String(error?.message ?? error));
        showToast(
            'error',
            '兼容检查或保护器初始化失败。本次不会修改酒馆重载逻辑，请更新插件后再试。',
            '聊天重载保护器启用失败',
            true,
        );
    }
}
