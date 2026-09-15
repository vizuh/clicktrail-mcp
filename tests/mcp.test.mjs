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
  assert.equal(inspection.evidence.capture.reason, undefined);
  assert.match(inspection.evidence.attach.reason, /No lead/);
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
  for (const tool of responses[2].result.tools) {
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    for (const [key, property] of Object.entries(tool.inputSchema.properties)) {
      assert.ok(property.description?.trim(), `${tool.name}.${key} needs parameter guidance`);
    }
  }
  const statusTool = responses[2].result.tools.find((tool) => tool.name === 'check_conversion_status');
  assert.match(statusTool.description, /status=unknown/);
  assert.match(statusTool.description, /verify_conversion_delivery/);
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


test('publishes workflow instructions and matching structured status and simulation results', async () => {
  const calls = [
    ['check_conversion_status', {}],
    ['check_conversion_status', { eventId: '' }],
    ['check_conversion_status', { eventId: 'evt_demo_1' }],
    ['simulate_ad_click', { url: 'https://example.test/?gclid=synthetic', consent: true, accountId: 'acct_demo', eventId: 'evt_demo_1' }],
    ['simulate_ad_click', { url: 'https://example.test/?gclid=synthetic' }],
    ['simulate_ad_click', { url: 'not a URL', consent: true }],
  ];
  const messages = [
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2099-01-01' } },
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    ...calls.map(([name, args], i) => ({ jsonrpc: '2.0', id: i + 2, method: 'tools/call', params: { name, arguments: args } })),
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'check_conversion_status', arguments: { eventId: 3 } } },
  ];
  const result = await runServer(messages.map((message) => JSON.stringify(message)).join('\n') + '\n');
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  const responses = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(responses[0].result.protocolVersion, '2025-06-18');
  assert.match(responses[0].result.instructions, /send_\* tools only build payloads/);
  assert.match(responses[0].result.instructions, /evidence field/);
  const definitions = responses[1].result.tools;
  for (const [i, [name]] of calls.entries()) {
    const response = responses[i + 2].result;
    assert.equal(response.isError, false);
    assert.deepEqual(response.structuredContent, JSON.parse(response.content[0].text));
    const schema = definitions.find((tool) => tool.name === name).outputSchema;
    assert.deepEqual(Object.keys(response.structuredContent).sort(), schema.required.slice().sort());
  }
  assert.deepEqual(responses.slice(2, 5).map(({ result }) => [result.structuredContent.eventId, result.structuredContent.status]), [[null, 'unknown'], [null, 'unknown'], ['evt_demo_1', 'unknown']]);
  const successful = responses[5].result.structuredContent;
  assert.equal(successful.evidence, 'synthetic-local-only');
  assert.deepEqual(successful.stages, { capture: true, persist: true, carry: true, attach: true, report: false, dedupe: true, verify: false });
  assert.equal(successful.statuses.report.status, 'unknown');
  const denied = responses[6].result.structuredContent;
  assert.equal(denied.consent, false);
  assert.equal(denied.stages.capture, false);
  assert.deepEqual(denied.clickIds, { gclid: 'synthetic' });
  assert.deepEqual(responses[7].result.structuredContent.clickIds, {});
  assert.equal(responses[8].result.isError, true);
  assert.equal(responses[8].result.structuredContent, undefined);
});
