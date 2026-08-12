import assert from 'node:assert/strict';
import test from 'node:test';

import { createSourceTraceReport } from '../modules/MobileKeyboardSourceTrace.js';

test('exports the source timing trace without chat or input content', () => {
    const report = JSON.parse(createSourceTraceReport({
        schema: 1,
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
    assert.equal(report.recordedEvents, 1);
    assert.equal(report.events[0].type, 'browser-fix-root-fixed');
    assert.equal(JSON.stringify(report).includes('message-'), false);
    assert.equal(JSON.stringify(report).includes('inputValue'), false);
});
