import {
    installReloadGuard,
    inspectCompatibility,
} from './modules/ChatReloadGuardCore.js';
import { installMobileHasInvalidationGuard } from './modules/MobileHasInvalidationGuard.js';

const EXTENSION_FOLDER = 'third-party/SillyTavern-ChatReloadGuard';
const STATUS_ID = 'chat-reload-guard-status';
const DETAIL_ID = 'chat-reload-guard-detail';

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

export async function activate() {
    installMobileHasInvalidationGuard();
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
