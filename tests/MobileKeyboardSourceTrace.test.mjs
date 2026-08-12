import assert from 'node:assert/strict';
import test from 'node:test';

import { createSourceTraceReport, probeServedBrowserFixes } from '../modules/MobileKeyboardSourceTrace.js';

test('exports the source timing trace without chat or input content', () => {
    const report = JSON.parse(createSourceTraceReport({
        schema: 1,
        recorder: { installed: true, enabled: true },
        events: [{
            t: 120,
            type: 'browser-fix-root-fixed',
            cycle: 3,
            heights: [765, 765],
            active: 'textarea#send_textarea',
            details: { duration: 88 },
        }],
    }, { sillyTavernVersion: '1.18.0' }));

    assert.equal(report.source, 'SillyTavern browser-fixes.js');
    assert.deepEqual(report.recorder, { installed: true, enabled: true });
    assert.equal(report.recordedEvents, 1);
    assert.equal(report.events[0].type, 'browser-fix-root-fixed');
    assert.equal(JSON.stringify(report).includes('message-'), false);
    assert.equal(JSON.stringify(report).includes('inputValue'), false);
});

test('checks the browser-fixes script returned by the active Tavern server', async () => {
    const probe = await probeServedBrowserFixes(async () => new Response('const MOBILE_KEYBOARD_TRACE_GLOBAL = true;', { status: 200 }));

    assert.deepEqual(probe, {
        checked: true,
        status: 200,
        hasRecorderMarker: true,
        bytes: 42,
    });
});
