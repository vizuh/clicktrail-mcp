import test from 'node:test';
import assert from 'node:assert/strict';
import { captureClickIdSchema, calculateClickIdCoverage, diagnoseMissingClickIds, reconcileConversions, validateAttributionPipeline, TOOL_DEFINITIONS } from '../src/tools.mjs';

test('exposes attribution tools', () => assert.deepEqual(TOOL_DEFINITIONS.map(([name]) => name), ['capture_click_id_schema','generate_nextjs_integration','generate_shopify_integration','validate_attribution_pipeline','diagnose_missing_click_ids','calculate_click_id_coverage','reconcile_conversions','send_conversion','send_qualified_lead','send_sale','check_conversion_status']));
test('returns canonical click IDs and lifecycle', () => { const s = captureClickIdSchema(); assert.ok(s.clickIds.some((x) => x.name === 'gclid')); assert.deepEqual(s.lifecycle, ['CAPTURE','PERSIST','CARRY','ATTACH','REPORT','DEDUPE','VERIFY']); });
test('validates complete pipeline', () => { const stages = Object.fromEntries(['capture','persist','carry','attach','report','dedupe','verify'].map((x) => [x, true])); assert.equal(validateAttributionPipeline({ eventId: 'evt_1', stages, consent: { advertising: true } }).valid, true); });
test('diagnoses dropped redirects and missing cookies', () => { const result = diagnoseMissingClickIds({ landingQuery: { gclid: 'x' }, redirectDroppedQuery: true, cookieMissing: true }); assert.equal(result.status, 'blocked'); assert.equal(result.checks.length, 2); });
test('calculates coverage', () => { const result = calculateClickIdCoverage({ sessions: [{ captured: { gclid: 'x' }, persisted: true, attached: true }, { captured: {}, persisted: false }] }); assert.equal(result.coverage.capture, 0.5); assert.equal(result.coverage.persist, 0.5); });
test('reconciles stable event IDs', () => { const result = reconcileConversions({ crm: [{ eventId: 'a', value: 10 }, { eventId: 'b', value: 5 }], destination: [{ eventId: 'a', value: 10 }] }); assert.deepEqual(result.missingFromDestination, ['b']); assert.equal(result.matchedCount, 1); });

test('builds delivery-neutral conversion payloads', async () => { const { sendSale, checkConversionStatus } = await import('../src/tools.mjs'); assert.equal(sendSale({ eventId: 'evt_1', value: 8 }).payload.eventName, 'Purchase'); assert.equal(checkConversionStatus({ eventId: 'evt_1' }).status, 'unknown'); });
