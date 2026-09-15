const CLICK_IDS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'fbc', 'fbp', 'msclkid', 'ttclid', 'li_fat_id', 'twclid'];
const LIFECYCLE = ['CAPTURE', 'PERSIST', 'CARRY', 'ATTACH', 'REPORT', 'DEDUPE', 'VERIFY'];

export function captureClickIdSchema() {
  return {
    clickIds: CLICK_IDS.map((name) => ({ name, type: 'string', maxLength: 512, sensitive: true })),
    cookieDefaults: { attribution: 'ct_attribution', consent: 'ct_consent', maxAgeSeconds: 60 * 60 * 24 * 90 },
    lifecycle: LIFECYCLE,
    rules: ['Allowlist keys', 'Normalize before storing', 'Gate storage and delivery on consent', 'Never trust browser identity or tenant fields']
  };
}

export function generateNextjsIntegration(input = {}) {
  const cookieName = typeof input.cookieName === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(input.cookieName) ? input.cookieName : 'ct_attribution';
  return {
    framework: 'nextjs-app-router',
    files: {
      'middleware.ts': `import { NextResponse } from 'next/server';

const IDS = ['gclid','gbraid','wbraid','fbclid','msclkid','ttclid','li_fat_id','twclid'];
export function middleware(request) {
  const response = NextResponse.next();
  const consentGranted = request.cookies.get('ct_consent')?.value === 'granted';
  const alreadyCaptured = request.cookies.has('${cookieName}');
  const captured = Object.fromEntries(IDS.flatMap((key) => { const value = request.nextUrl.searchParams.get(key)?.trim().slice(0, 512); return value ? [[key, value]] : []; }));
  // Fail closed: connect ct_consent to the host CMP before enabling persistence.
  if (consentGranted && !alreadyCaptured && Object.keys(captured).length) response.cookies.set('${cookieName}', JSON.stringify(captured), { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 7776000, path: '/' });
  return response;
}`,
      'server-action.ts': `import { cookies } from 'next/headers';
export async function getAttribution() { const value = (await cookies()).get('${cookieName}')?.value; return value ? JSON.parse(value) : {}; }`
    },
    notes: ['Add consent gating before setting the cookie.', 'Attach the returned record to a server-owned lead/order ID.', 'Use a deterministic destination event ID for retries.']
  };
}

export function generateShopifyIntegration(input = {}) {
  const eventName = typeof input.eventName === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(input.eventName) ? input.eventName : 'clicktrail_attribution';
  return {
    platform: 'shopify',
    files: {
      'web-pixel.js': `analytics.subscribe('${eventName}', (event) => { const consentGranted = event?.data?.consent?.advertising === true || globalThis.__CLICKTRAIL_CONSENT__?.advertising === true; if (!consentGranted) return; const url = new URL(event.context.document.location.href); const ids = {}; for (const key of ['gclid','gbraid','wbraid','fbclid','twclid']) { const value = url.searchParams.get(key)?.trim().slice(0, 512); if (value) ids[key] = value; } if (Object.keys(ids).length && !localStorage.getItem('ct_attribution')) localStorage.setItem('ct_attribution', JSON.stringify(ids)); });`,
      'order-webhook.js': `export function attributionFromOrder(order) { const attrs = Object.fromEntries((order.note_attributes || []).map(({ name, value }) => [name, value])); return { gclid: attrs.gclid, gbraid: attrs.gbraid, wbraid: attrs.wbraid, fbclid: attrs.fbclid }; }`
    },
    notes: ['Do not treat Shopify note attributes as trusted identity.', 'Use order.id as the idempotency source.', 'Verify browser/server Meta event_id equality before sending CAPI.']
  };
}

export function validateAttributionPipeline(payload = {}) {
  const errors = [];
  const warnings = [];
  const stages = payload.stages && typeof payload.stages === 'object' ? payload.stages : {};
  for (const stage of LIFECYCLE) if (stages[stage.toLowerCase()] !== true && stages[stage] !== true) errors.push(`Missing completed stage: ${stage}`);
  if (!payload.eventId || typeof payload.eventId !== 'string') errors.push('eventId is required');
  if (payload.consent?.advertising !== true && payload.consent?.analytics !== true) warnings.push('No affirmative analytics or advertising consent was declared');
  if (payload.clickIds && typeof payload.clickIds === 'object' && Object.keys(payload.clickIds).some((key) => !CLICK_IDS.includes(key))) warnings.push('Payload contains non-standard click ID keys');
  return { valid: errors.length === 0, lifecycle: LIFECYCLE, errors, warnings };
}

export function diagnoseMissingClickIds(input = {}) {
  const checks = [];
  if (!input.landingQuery) checks.push({ code: 'NO_LANDING_QUERY', severity: 'high', fix: 'Inspect the first request and ad redirect for click ID query parameters.' });
  if (input.landingQuery && !Object.keys(input.landingQuery).some((key) => CLICK_IDS.includes(key))) checks.push({ code: 'ID_NOT_CAPTURED', severity: 'high', fix: 'Use an allowlisted capture path before client navigation.' });
  if (input.redirectDroppedQuery) checks.push({ code: 'REDIRECT_DROPPED_QUERY', severity: 'high', fix: 'Preserve the query string in every redirect Location header.' });
  if (input.cookieMissing) checks.push({ code: 'COOKIE_NOT_PERSISTED', severity: 'high', fix: 'Check consent, Secure, SameSite, domain, expiry, and server response Set-Cookie.' });
  if (input.crossDomain) checks.push({ code: 'CROSS_DOMAIN_BOUNDARY', severity: 'medium', fix: 'Use a signed, short-lived linker parameter and validate it at the destination.' });
  if (input.safari) checks.push({ code: 'PRIVACY_STORAGE_LIMIT', severity: 'medium', fix: 'Capture at a server boundary and use first-party storage with an explicit expiry.' });
  return { checks, status: checks.some((c) => c.severity === 'high') ? 'blocked' : checks.length ? 'needs-review' : 'no-known-failure' };
}

export function calculateClickIdCoverage(input = {}) {
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  const withCaptured = sessions.filter((s) => s && Object.keys(s.captured || {}).some((k) => CLICK_IDS.includes(k))).length;
  const withPersisted = sessions.filter((s) => s?.persisted === true).length;
  const withAttached = sessions.filter((s) => s?.attached === true).length;
  const ratio = (n) => sessions.length ? Number((n / sessions.length).toFixed(4)) : 0;
  return { total: sessions.length, captured: withCaptured, persisted: withPersisted, attached: withAttached, coverage: { capture: ratio(withCaptured), persist: ratio(withPersisted), attach: ratio(withAttached) } };
}

export function reconcileConversions(input = {}) {
  const crm = Array.isArray(input.crm) ? input.crm : [];
  const destination = Array.isArray(input.destination) ? input.destination : [];
  const destinationIds = new Set(destination.map((row) => row?.eventId).filter(Boolean));
  const crmIds = new Set(crm.map((row) => row?.eventId).filter(Boolean));
  const matched = [...crmIds].filter((id) => destinationIds.has(id));
  const missing = [...crmIds].filter((id) => !destinationIds.has(id));
  const orphaned = [...destinationIds].filter((id) => !crmIds.has(id));
  return { crmCount: crm.length, destinationCount: destination.length, matchedCount: matched.length, missingFromDestination: missing, destinationWithoutCrm: orphaned, valueDifference: Number((crm.reduce((s, r) => s + Number(r?.value || 0), 0) - destination.reduce((s, r) => s + Number(r?.value || 0), 0)).toFixed(2)) };
}

export function buildConversion(input = {}, eventName = 'Purchase') {
  const eventId = typeof input.eventId === 'string' && input.eventId ? input.eventId : null;
  if (!eventId) throw new TypeError('eventId is required');
  return { eventId, eventName, value: Number(input.value || 0), currency: String(input.currency || 'USD').toUpperCase(), clickIds: Object.fromEntries(CLICK_IDS.flatMap((key) => input.clickIds?.[key] ? [[key, String(input.clickIds[key]).slice(0, 512)]] : [])), delivery: 'caller-must-configure-destination-and-consent' };
}
export function sendConversion(input = {}) { return { action: 'send_conversion', payload: buildConversion(input, input.eventName || 'Conversion'), sideEffects: false }; }
export function sendQualifiedLead(input = {}) { return { action: 'send_qualified_lead', payload: buildConversion(input, 'QualifiedLead'), sideEffects: false }; }
export function sendSale(input = {}) { return { action: 'send_sale', payload: buildConversion(input, 'Purchase'), sideEffects: false }; }
export function checkConversionStatus(input = {}) { return { eventId: input.eventId || null, status: 'unknown', reason: 'This local MCP server does not call destination APIs', nextChecks: ['Inspect the destination request log', 'Query the destination conversion diagnostics', 'Reconcile the event ID against the CRM record'] }; }



const FRAMEWORKS = Object.freeze(['nextjs', 'node', 'shopify', 'generic']);
const STAGES = Object.freeze(['capture', 'persist', 'carry', 'attach', 'report', 'dedupe', 'verify']);

function boundedString(value, maxLength = 512) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, maxLength) : '';
}

function queryClickIds(url) {
  try {
    const parsed = new URL(url);
    return Object.fromEntries(CLICK_IDS.filter((key) => parsed.searchParams.get(key)).map((key) => [key, parsed.searchParams.get(key).slice(0, 512)]));
  } catch {
    return {};
  }
}

function stageStatus(value, reason = '') {
  return { status: value, ...(reason ? { reason } : {}) };
}

/** Inspect a caller-provided project snapshot without reading the filesystem. */
export function inspectProject(input = {}) {
  const files = input.files && typeof input.files === 'object' ? input.files : {};
  const packageJson = input.packageJson && typeof input.packageJson === 'object' ? input.packageJson : {};
  const source = Object.values(files).filter((value) => typeof value === 'string').join('\n');
  const dependencies = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) };
  const framework = FRAMEWORKS.includes(input.framework) ? input.framework
    : dependencies.next || source.includes('next/server') ? 'nextjs'
    : dependencies.shopify || source.includes('shopify') ? 'shopify'
    : packageJson.type === 'module' || source.includes('node:') ? 'node' : 'generic';
  const has = (pattern) => pattern.test(source);
  const evidence = {
    capture: stageStatus(has(/gclid|gbraid|wbraid|fbclid|captureAttribution|createClickTrail/i) ? 'pass' : 'fail', 'No allowlisted click-ID capture found'),
    persist: stageStatus(has(/cookie|localStorage|sessionStorage|persist|storage/i) ? 'pass' : 'fail', 'No persistence boundary found'),
    carry: stageStatus(has(/redirect|cross.?domain|middleware|linker|query/i) ? 'pass' : 'unknown', 'Carry boundary was not proven by the snapshot'),
    attach: stageStatus(has(/attachAttribution|crm|lead|account|contact|form/i) ? 'pass' : 'fail', 'No lead/account attachment boundary found'),
    report: stageStatus(has(/uploadClickConversions|datamanager|conversion|offline/i) ? 'pass' : 'unknown', 'No destination reporting code found'),
    dedupe: stageStatus(has(/dedupe|idempot|orderId|eventId|event_id/i) ? 'pass' : 'unknown', 'No deduplication key found'),
    verify: stageStatus(Array.isArray(input.tests) && input.tests.length > 0 ? 'pass' : 'unknown', 'No test evidence was supplied'),
  };
  return { framework, evidence, clickTrailDetected: Boolean(dependencies['@vizuh/clicktrail-next'] || dependencies['@vizuh/clicktrail-browser'] || has(/clicktrail/i)), filesInspected: Object.keys(files).sort() };
}

export function detectAttributionGaps(input = {}) {
  const evidence = input.evidence && typeof input.evidence === 'object' ? input.evidence : inspectProject(input).evidence;
  const gaps = [];
  for (const stage of STAGES) {
    const state = evidence[stage];
    const status = typeof state === 'string' ? state : state?.status;
    if (status === 'fail') gaps.push({ code: `${stage.toUpperCase()}_MISSING`, severity: stage === 'capture' || stage === 'attach' ? 'high' : 'medium', fix: `Implement and test the ${stage} boundary before moving to the next stage.` });
    else if (status !== 'pass') gaps.push({ code: `${stage.toUpperCase()}_UNPROVEN`, severity: 'medium', fix: `Supply runnable evidence for the ${stage} boundary; do not mark it complete from generated code alone.` });
  }
  return { gaps, status: gaps.some((gap) => gap.severity === 'high') ? 'blocked' : gaps.length ? 'needs-review' : 'ready' };
}

export function planInstallation(input = {}) {
  const framework = FRAMEWORKS.includes(input.framework) ? input.framework : 'generic';
  const plans = {
    nextjs: { install: 'npm install @vizuh/clicktrail-next', files: ['middleware.ts', 'app/actions/identify-account.ts'], steps: ['Capture at the server request boundary.', 'Persist first touch with an explicit consent gate.', 'Use a shared parent-domain cookie only for same-site subdomains.', 'Attach attribution to a server-owned account or lead ID.', 'Run the synthetic journey and project tests.'] },
    node: { install: 'npm install @vizuh/clicktrail-node', files: ['src/attribution.ts', 'src/conversions.ts'], steps: ['Capture from the trusted request boundary.', 'Persist only after consent.', 'Attach to the server-owned lead record.', 'Use a stable event or order ID for deduplication.', 'Verify destination receipts separately.'] },
    shopify: { install: 'npm install @vizuh/clicktrail-shopify', files: ['web-pixel.js', 'order-webhook.js'], steps: ['Capture in the Web Pixel after consent.', 'Carry allowlisted IDs through cart attributes.', 'Read attributes from the server webhook.', 'Use the order ID as the deduplication key.', 'Verify provider delivery with a real receipt.'] },
    generic: { install: 'npm install @vizuh/clicktrail', files: ['attribution-capture.js', 'lead-attachment.js'], steps: ['Capture and normalize at the first trusted boundary.', 'Persist with consent and an explicit expiry.', 'Carry the record through redirects and forms.', 'Attach to a server-owned record.', 'Run local simulation before provider delivery.'] },
  };
  return { framework, ...plans[framework], evidenceBoundary: 'Generated code is not runtime proof; provider delivery remains unknown without a receipt.' };
}

export function simulateAdClick(input = {}) {
  const url = boundedString(input.url);
  const clickIds = queryClickIds(url);
  const consent = input.consent === true;
  const captured = consent && Object.keys(clickIds).length > 0;
  const carried = captured && input.redirectPreservesQuery !== false;
  const attached = carried && Boolean(input.accountId || input.leadId || input.formFields);
  const stages = {
    capture: captured,
    persist: captured && consent,
    carry: carried,
    attach: attached,
    report: false,
    dedupe: Boolean(input.eventId || input.orderId),
    verify: false,
  };
  return { url, clickIds, consent, stages, statuses: Object.fromEntries(STAGES.map((stage) => [stage, stageStatus(stages[stage] ? 'pass' : 'unknown', stages[stage] ? '' : stage === 'report' || stage === 'verify' ? 'Provider/runtime evidence is not available in this local simulation.' : 'Synthetic input did not prove this boundary.')])) , evidence: 'synthetic-local-only' };
}

export function verifyCapture(input = {}) {
  const expected = boundedString(input.expectedClickId);
  const captured = input.captured && typeof input.captured === 'object' ? input.captured : {};
  const actual = expected ? captured[input.key || 'gclid'] : undefined;
  const passed = input.consent === true && Boolean(expected) && actual === expected;
  return { status: passed ? 'pass' : 'fail', expected, actual: actual || '', reason: passed ? '' : input.consent !== true ? 'Consent was not affirmative.' : 'Expected click ID was not captured intact.' };
}

export function verifyFormAttachment(input = {}) {
  const attribution = input.attribution && typeof input.attribution === 'object' ? input.attribution : {};
  const fields = input.fields && typeof input.fields === 'object' ? input.fields : {};
  const keys = Array.isArray(input.requiredKeys) && input.requiredKeys.length ? input.requiredKeys : CLICK_IDS;
  const missing = keys.filter((key) => attribution[key] && fields[key] !== attribution[key]);
  return { status: missing.length ? 'fail' : 'pass', checkedKeys: keys.filter((key) => attribution[key]), missing, reason: missing.length ? 'Attached form fields differ from canonical attribution.' : '' };
}

export function verifyCrmAttachment(input = {}) {
  const expected = input.expected && typeof input.expected === 'object' ? input.expected : {};
  const record = input.record && typeof input.record === 'object' ? input.record : {};
  const missing = Object.keys(expected).filter((key) => record[key] !== expected[key]);
  return { status: missing.length ? 'fail' : 'pass', missing, checkedKeys: Object.keys(expected), reason: missing.length ? 'CRM record does not contain the expected attribution values.' : '' };
}

export function verifyConversionDelivery(input = {}) {
  const receipt = input.providerReceipt;
  if (!receipt || typeof receipt !== 'object') return { status: 'unknown', reason: 'No provider receipt was supplied; local payload construction is not delivery proof.' };
  if (receipt.accepted === true || receipt.status === 'accepted') return { status: 'pass', reason: 'Provider receipt reports acceptance.' };
  return { status: 'fail', reason: boundedString(receipt.error || receipt.status || 'Provider rejected or did not accept the conversion.') };
}

export function attributionHealth(input = {}) {
  const statuses = input.statuses && typeof input.statuses === 'object' ? input.statuses : input.stages || {};
  const normalized = Object.fromEntries(STAGES.map((stage) => {
    const value = statuses[stage];
    return [stage, typeof value === 'string' ? value : value === true ? 'pass' : value === false ? 'fail' : value?.status || 'unknown'];
  }));
  const pass = STAGES.filter((stage) => normalized[stage] === 'pass').length;
  const fail = STAGES.filter((stage) => normalized[stage] === 'fail').length;
  return { score: Math.round((pass / STAGES.length) * 100), pass, fail, unknown: STAGES.length - pass - fail, statuses: normalized, evidence: 'local-declared-or-synthetic' };
}

export const TOOL_SCHEMAS = Object.freeze({
  capture_click_id_schema: { type: 'object', additionalProperties: false, properties: {} },
  generate_nextjs_integration: { type: 'object', additionalProperties: false, properties: { cookieName: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } } },
  generate_shopify_integration: { type: 'object', additionalProperties: false, properties: { eventName: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,64}$' } } },
  validate_attribution_pipeline: { type: 'object', additionalProperties: false, required: ['eventId'], properties: { eventId: { type: 'string' }, stages: { type: 'object' }, consent: { type: 'object' }, clickIds: { type: 'object' } } },
  diagnose_missing_click_ids: { type: 'object', additionalProperties: false, properties: { landingQuery: { type: 'object' }, redirectDroppedQuery: { type: 'boolean' }, cookieMissing: { type: 'boolean' }, crossDomain: { type: 'boolean' }, safari: { type: 'boolean' } } },
  calculate_click_id_coverage: { type: 'object', additionalProperties: false, properties: { sessions: { type: 'array' } } },
  reconcile_conversions: { type: 'object', additionalProperties: false, properties: { crm: { type: 'array' }, destination: { type: 'array' } } },
  send_conversion: { type: 'object', additionalProperties: false, required: ['eventId'], properties: { eventId: { type: 'string' }, eventName: { type: 'string' }, value: { type: 'number' }, currency: { type: 'string' }, clickIds: { type: 'object' } } },
  send_qualified_lead: { type: 'object', additionalProperties: false, required: ['eventId'], properties: { eventId: { type: 'string' }, value: { type: 'number' }, currency: { type: 'string' }, clickIds: { type: 'object' } } },
  send_sale: { type: 'object', additionalProperties: false, required: ['eventId'], properties: { eventId: { type: 'string' }, value: { type: 'number' }, currency: { type: 'string' }, clickIds: { type: 'object' } } },
  check_conversion_status: { type: 'object', additionalProperties: false, properties: { eventId: { type: 'string' } } },
  inspect_project: { type: 'object', additionalProperties: false, properties: { framework: { type: 'string', enum: FRAMEWORKS }, files: { type: 'object' }, packageJson: { type: 'object' }, tests: { type: 'array' } } },
  detect_attribution_gaps: { type: 'object', additionalProperties: false, properties: { evidence: { type: 'object' }, framework: { type: 'string', enum: FRAMEWORKS }, files: { type: 'object' }, packageJson: { type: 'object' } } },
  plan_installation: { type: 'object', additionalProperties: false, properties: { framework: { type: 'string', enum: FRAMEWORKS } } },
  simulate_ad_click: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string' }, consent: { type: 'boolean' }, redirectPreservesQuery: { type: 'boolean' }, accountId: { type: 'string' }, leadId: { type: 'string' }, formFields: { type: 'object' }, eventId: { type: 'string' }, orderId: { type: 'string' } } },
  verify_capture: { type: 'object', additionalProperties: false, required: ['expectedClickId', 'captured'], properties: { expectedClickId: { type: 'string' }, key: { type: 'string', enum: CLICK_IDS }, captured: { type: 'object' }, consent: { type: 'boolean' } } },
  verify_form_attachment: { type: 'object', additionalProperties: false, required: ['attribution', 'fields'], properties: { attribution: { type: 'object' }, fields: { type: 'object' }, requiredKeys: { type: 'array' } } },
  verify_crm_attachment: { type: 'object', additionalProperties: false, required: ['expected', 'record'], properties: { expected: { type: 'object' }, record: { type: 'object' } } },
  verify_conversion_delivery: { type: 'object', additionalProperties: false, properties: { providerReceipt: { type: 'object' } } },
  attribution_health: { type: 'object', additionalProperties: false, properties: { stages: { type: 'object' }, statuses: { type: 'object' } } },
});

export function validateToolInput(name, input) {
  const schema = TOOL_SCHEMAS[name];
  if (!schema) return [`Unknown tool schema: ${name}`];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ['Input must be an object'];
  const errors = [];
  for (const key of schema.required || []) if (!(key in input)) errors.push(`Missing required field: ${key}`);
  if (schema.additionalProperties === false) for (const key of Object.keys(input)) if (!schema.properties[key]) errors.push(`Unknown field: ${key}`);
  for (const [key, definition] of Object.entries(schema.properties || {})) {
    if (!(key in input)) continue;
    const value = input[key];
    const validType = definition.type === 'array' ? Array.isArray(value) : definition.type === 'object' ? typeof value === 'object' && value !== null && !Array.isArray(value) : typeof value === definition.type;
    if (!validType) errors.push(`Field ${key} must be ${definition.type}`);
    if (definition.enum && !definition.enum.includes(value)) errors.push(`Field ${key} must be one of: ${definition.enum.join(', ')}`);
    if (definition.pattern && typeof value === 'string' && !new RegExp(definition.pattern).test(value)) errors.push(`Field ${key} has an invalid format`);
  }
  return errors;
}

export const TOOL_DEFINITIONS = [
  ['capture_click_id_schema', 'Return the canonical click ID allowlist and lifecycle schema.', captureClickIdSchema],
  ['generate_nextjs_integration', 'Generate a consent-gated Next.js attribution integration.', generateNextjsIntegration],
  ['generate_shopify_integration', 'Generate a consent-gated Shopify Web Pixel and order webhook attribution integration.', generateShopifyIntegration],
  ['validate_attribution_pipeline', 'Validate declared attribution lifecycle stages and consent.', validateAttributionPipeline],
  ['diagnose_missing_click_ids', 'Diagnose common click ID loss boundaries.', diagnoseMissingClickIds],
  ['calculate_click_id_coverage', 'Calculate capture, persistence, and attachment coverage.', calculateClickIdCoverage],
  ['reconcile_conversions', 'Reconcile CRM conversions against destination conversion records.', reconcileConversions],
  ['send_conversion', 'Build a destination-neutral conversion payload without network side effects.', sendConversion],
  ['send_qualified_lead', 'Build a qualified lead conversion payload without network side effects.', sendQualifiedLead],
  ['send_sale', 'Build a sale conversion payload without network side effects.', sendSale],
  ['check_conversion_status', 'Explain how to verify a conversion without querying a provider.', checkConversionStatus],
  ['inspect_project', 'Inspect a caller-provided project snapshot for attribution capabilities.', inspectProject],
  ['detect_attribution_gaps', 'Find unproven or missing attribution lifecycle stages.', detectAttributionGaps],
  ['plan_installation', 'Create a framework-specific, evidence-aware installation plan.', planInstallation],
  ['simulate_ad_click', 'Simulate a synthetic click-to-account attribution journey locally.', simulateAdClick],
  ['verify_capture', 'Verify that a click ID was captured intact after consent.', verifyCapture],
  ['verify_form_attachment', 'Verify that attribution was copied into form fields.', verifyFormAttachment],
  ['verify_crm_attachment', 'Verify that attribution reached a CRM/account record.', verifyCrmAttachment],
  ['verify_conversion_delivery', 'Classify provider delivery from an explicit receipt or return unknown.', verifyConversionDelivery],
  ['attribution_health', 'Score the seven attribution lifecycle stages without inventing runtime proof.', attributionHealth],
];
