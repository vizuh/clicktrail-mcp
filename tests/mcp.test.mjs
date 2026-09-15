import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { captureClickIdSchema, calculateClickIdCoverage, diagnoseMissingClickIds, reconcileConversions, validateAttributionPipeline, inspectProject, detectAttributionGaps, planInstallation, simulateAdClick, verifyCapture, verifyFormAttachment, verifyCrmAttachment, verifyConversionDelivery, attributionHealth, TOOL_DEFINITIONS, TOOL_SCHEMAS } from '../src/tools.mjs';

test('exposes attribution tools', () => assert.deepEqual(TOOL_DEFINITIONS.map(([name]) => name), ['capture_click_id_schema','generate_nextjs_integration','generate_shopify_integration','validate_attribution_pipeline','diagnose_missing_click_ids','calculate_click_id_coverage','reconcile_conversions','send_conversion','send_qualified_lead','send_sale','check_conversion_status','inspect_project','detect_attribution_gaps','plan_installation','simulate_ad_click','verify_capture','verify_form_attachment','verify_crm_attachment','verify_conversion_delivery','attribution_health']));
test('returns canonical click IDs and lifecycle', () => { const s = captureClickIdSchema(); assert.ok(s.clickIds.some((x) => x.name === 'gclid')); assert.deepEqual(s.lifecycle, ['CAPTURE','PERSIST','CARRY','ATTACH','REPORT','DEDUPE','VERIFY']); });
test('validates complete pipeline', () => { const stages = Object.fromEntries(['capture','persist','carry','attach','report','dedupe','verify'].map((x) => [x, true])); assert.equal(validateAttributionPipeline({ eventId: 'evt_1', stages, consent: { advertising: true } }).valid, true); });
test('diagnoses dropped redirects and missing cookies', () => { const result = diagnoseMissingClickIds({ landingQuery: { gclid: 'x' }, redirectDroppedQuery: true, cookieMissing: true }); assert.equal(result.status, 'blocked'); assert.equal(result.checks.length, 2); });
test('calculates coverage', () => { const result = calculateClickIdCoverage({ sessions: [{ captured: { gclid: 'x' }, persisted: true, attached: true }, { captured: {}, persisted: false }] }); assert.equal(result.coverage.capture, 0.5); assert.equal(result.coverage.persist, 0.5); });
test('reconciles stable event IDs', () => { const result = reconcileConversions({ crm: [{ eventId: 'a', value: 10 }, { eventId: 'b', value: 5 }], destination: [{ eventId: 'a', value: 10 }] }); assert.deepEqual(result.missingFromDestination, ['b']); assert.equal(result.matchedCount, 1); });

test('builds delivery-neutral conversion payloads', async () => { const { sendSale, checkConversionStatus } = await import('../src/tools.mjs'); assert.equal(sendSale({ eventId: 'evt_1', value: 8 }).payload.eventName, 'Purchase'); assert.equal(checkConversionStatus({ eventId: 'evt_1' }).status, 'unknown'); });


test('generates consent-gated and first-touch-safe snippets', async () => {
  const { generateNextjsIntegration, generateShopifyIntegration } = await import('../src/tools.mjs');
  const next = generateNextjsIntegration().files['middleware.ts'];
  const shopify = generateShopifyIntegration().files['web-pixel.js'];
  assert.match(next, /consentGranted/);
  assert.match(next, /alreadyCaptured/);
  assert.match(next, /twclid/);
  assert.match(shopify, /consentGranted/);
  assert.match(shopify, /!localStorage\.getItem/);
});

test('inspects a project and reports unproven runtime evidence', () => {
  const inspection = inspectProject({ framework: 'nextjs', packageJson: { dependencies: { next: '16' } }, files: { 'middleware.ts': 'capture gclid into cookie' } });
  assert.equal(inspection.framework, 'nextjs');
  assert.equal(inspection.evidence.capture.status, 'pass');
  assert.equal(detectAttributionGaps(inspection).status, 'blocked');
});

test('plans and simulates a consented synthetic journey', () => {
  const plan = planInstallation({ framework: 'nextjs' });
  assert.equal(plan.install, 'npm install @vizuh/clicktrail-next');
  const simulation = simulateAdClick({ url: 'https://example.test/pricing?gclid=synthetic', consent: true, accountId: 'acct_1', eventId: 'evt_1' });
  assert.equal(simulation.stages.capture, true);
  assert.equal(simulation.stages.attach, true);
  assert.equal(simulation.evidence, 'synthetic-local-only');
  assert.equal(attributionHealth(simulation).score, 71);
});

test('verifies capture, form, CRM, and provider evidence separately', () => {
  assert.equal(verifyCapture({ expectedClickId: 'x', captured: { gclid: 'x' }, consent: true }).status, 'pass');
  assert.equal(verifyFormAttachment({ attribution: { gclid: 'x' }, fields: { gclid: 'x' } }).status, 'pass');
  assert.equal(verifyCrmAttachment({ expected: { gclid: 'x' }, record: { gclid: 'x' } }).status, 'pass');
  assert.equal(verifyConversionDelivery({}).status, 'unknown');
});

test('exposes closed tool schemas and rejects unknown fields', async () => {
  assert.equal(TOOL_SCHEMAS.simulate_ad_click.additionalProperties, false);
  const { validateToolInput } = await import('../src/tools.mjs');
  assert.deepEqual(validateToolInput('simulate_ad_click', { url: 'x', unsafe: true }), ['Unknown field: unsafe']);
});

test('stdio server returns protocol errors without crashing', async () => {
  const result = await runServer([
    '{bad-json',
    '{}',
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'simulate_ad_click', arguments: { url: 'https://x.test/?gclid=x', consent: true } } }),
  ].join('\n') + '\n');
  const responses = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(result.code, 0);
  assert.deepEqual(responses.slice(0, 2).map((response) => response.error.code), [-32700, -32600]);
  assert.equal(responses[2].result.tools.length, 20);
  assert.equal(responses[3].result.isError, false);
});

function runServer(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/index.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
