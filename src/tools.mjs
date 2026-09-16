import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { typeSafeAdvisory } from './advisor.mjs';
import { verifyProject as runVerifier, validateVerifierReport } from './verify.mjs';

const CLICK_IDS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'fbc', 'fbp', 'msclkid', 'ttclid', 'li_fat_id', 'twclid'];
const LIFECYCLE = ['CAPTURE', 'PERSIST', 'CARRY', 'ATTACH', 'REPORT', 'DEDUPE', 'VERIFY'];
const EVIDENCE_SECRET = randomBytes(32);

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
  const captured = Object.fromEntries(IDS.flatMap((key) => { const value = request.nextUrl.searchParams.get(key)?.trim().slice(0, 128); return value ? [[key, value]] : []; }));
  const serialized = JSON.stringify(captured);
  // Fail closed: connect ct_consent to the host CMP before enabling persistence.
  // Keep below common browser cookie limits; use server-owned storage for larger state.
  if (consentGranted && !alreadyCaptured && Object.keys(captured).length && serialized.length <= 3000) response.cookies.set('${cookieName}', serialized, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 7776000, path: '/' });
  return response;
}`,
      'server-action.ts': `'use server';
import { cookies } from 'next/headers';
const IDS = ['gclid','gbraid','wbraid','fbclid','msclkid','ttclid','li_fat_id','twclid'];
export async function getAttribution() {
  const value = (await cookies()).get('${cookieName}')?.value;
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return Object.fromEntries(IDS.flatMap((key) => typeof parsed?.[key] === 'string' && parsed[key] ? [[key, parsed[key].slice(0, 128)]] : []));
  } catch { return {}; }
}`,
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
      'order-webhook.js': `export function attributionFromOrder(order) { const attrs = Object.fromEntries((order.note_attributes || []).map(({ name, value }) => [name, value])); const consentGranted = attrs.ct_consent === 'granted' || attrs.clicktrail_consent === 'granted'; if (!consentGranted) return {}; return { gclid: attrs.gclid, gbraid: attrs.gbraid, wbraid: attrs.wbraid, fbclid: attrs.fbclid }; }`
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

function provenanceSignature(status, reason, provenance) {
  return createHmac('sha256', EVIDENCE_SECRET)
    .update(JSON.stringify([status, reason, provenance.source, provenance.mode]))
    .digest('hex');
}

function stageStatus(value, reason = '', provenance = { source: 'clicktrail-mcp', mode: 'synthetic-local' }) {
  const normalized = { source: String(provenance.source || ''), mode: String(provenance.mode || '') };
  const effectiveReason = value === 'pass' ? '' : reason;
  return { status: value, ...(effectiveReason ? { reason: effectiveReason } : {}), provenance: { ...normalized, signature: provenanceSignature(value, effectiveReason, normalized) } };
}

function hasProvenance(value) {
  if (!value || typeof value !== 'object' || !value.provenance || typeof value.provenance !== 'object' || Array.isArray(value.provenance)) return false;
  const provenance = value.provenance;
  if (typeof provenance.source !== 'string' || typeof provenance.mode !== 'string' || typeof provenance.signature !== 'string') return false;
  const expected = provenanceSignature(value.status, value.reason || '', provenance);
  const supplied = Buffer.from(provenance.signature, 'hex');
  const actual = Buffer.from(expected, 'hex');
  return supplied.length === actual.length && timingSafeEqual(supplied, actual);
}

function trustedStatus(value) {
  const status = typeof value === 'string' ? value : value?.status;
  if (!['pass', 'fail'].includes(status)) return status || 'unknown';
  return hasProvenance(value) ? status : 'unknown';
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
    capture: stageStatus(has(/gclid|gbraid|wbraid|fbclid|captureAttribution|createClickTrail/i) ? 'pass' : 'fail', 'No allowlisted click-ID capture found', { source: 'clicktrail-mcp', mode: 'source-inspection' }),
    persist: stageStatus(has(/cookie|localStorage|sessionStorage|persist|storage/i) ? 'pass' : 'fail', 'No persistence boundary found', { source: 'clicktrail-mcp', mode: 'source-inspection' }),
    carry: stageStatus(has(/redirect|cross.?domain|middleware|linker|query/i) ? 'pass' : 'unknown', 'Carry boundary was not proven by the snapshot', { source: 'clicktrail-mcp', mode: 'source-inspection' }),
    attach: stageStatus(has(/attachAttribution|crm|lead|account|contact|form/i) ? 'pass' : 'fail', 'No lead/account attachment boundary found', { source: 'clicktrail-mcp', mode: 'source-inspection' }),
    report: stageStatus(has(/uploadClickConversions|datamanager|conversion|offline/i) ? 'pass' : 'unknown', 'No destination reporting code found', { source: 'clicktrail-mcp', mode: 'source-inspection' }),
    dedupe: stageStatus(has(/dedupe|idempot|orderId|eventId|event_id/i) ? 'pass' : 'unknown', 'No deduplication key found', { source: 'clicktrail-mcp', mode: 'source-inspection' }),
    verify: stageStatus(Array.isArray(input.tests) && input.tests.length > 0 ? 'pass' : 'unknown', 'No test evidence was supplied', { source: 'clicktrail-mcp', mode: 'source-inspection' }),
  };
  return { framework, evidence, clickTrailDetected: Boolean(dependencies['@vizuh/clicktrail-next'] || dependencies['@vizuh/clicktrail-browser'] || has(/clicktrail/i)), filesInspected: Object.keys(files).sort() };
}

export function detectAttributionGaps(input = {}) {
  const evidence = input.evidence && typeof input.evidence === 'object' ? input.evidence : inspectProject(input).evidence;
  const gaps = [];
  for (const stage of STAGES) {
    const state = evidence[stage];
    const status = trustedStatus(state);
    if (status === 'fail') gaps.push({ code: `${stage.toUpperCase()}_MISSING`, severity: stage === 'capture' || stage === 'attach' ? 'high' : 'medium', fix: `Implement and test the ${stage} boundary before moving to the next stage.` });
    else if (status !== 'pass') gaps.push({ code: `${stage.toUpperCase()}_UNPROVEN`, severity: 'medium', fix: `Supply runnable evidence for the ${stage} boundary with provenance; do not mark it complete from generated code alone.` });
  }
  return { gaps, status: gaps.some((gap) => gap.severity === 'high') ? 'blocked' : gaps.length ? 'needs-review' : 'ready' };
}

export function planInstallation(input = {}) {
  const framework = FRAMEWORKS.includes(input.framework) ? input.framework : 'generic';
  const plans = {
    nextjs: { install: 'npm install @vizuh/clicktrail @vizuh/clicktrail-browser', files: ['middleware.ts', 'app/actions/identify-account.ts'], steps: ['Capture at the server request boundary.', 'Persist first touch with an explicit consent gate.', 'Use a shared parent-domain cookie only for same-site subdomains.', 'Attach attribution to a server-owned account or lead ID.', 'Run the synthetic journey and project tests.'] },
    node: { install: 'npm install @vizuh/clicktrail', files: ['src/attribution.ts', 'src/conversions.ts'], steps: ['Capture from the trusted request boundary.', 'Persist only after consent.', 'Attach to the server-owned lead record.', 'Use a stable event or order ID for deduplication.', 'Verify destination receipts separately.'] },
    shopify: { install: 'No published Shopify adapter; use the generated source only after host review.', files: ['web-pixel.js', 'order-webhook.js'], steps: ['Capture in the Web Pixel after consent.', 'Carry allowlisted IDs through cart attributes.', 'Read attributes from the server webhook.', 'Use the order ID as the deduplication key.', 'Verify provider delivery with a real receipt.'] },
    generic: { install: 'npm install @vizuh/clicktrail', files: ['attribution-capture.js', 'lead-attachment.js'], steps: ['Capture and normalize at the first trusted boundary.', 'Persist with consent and an explicit expiry.', 'Carry the record through redirects and forms.', 'Attach to a server-owned record.', 'Run local simulation before provider delivery.'] },
  };  return { framework, ...plans[framework], evidenceBoundary: 'Generated code is not runtime proof; provider delivery remains unknown without a receipt.' };
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
  const checkedKeys = keys.filter((key) => attribution[key]);
  if (!checkedKeys.length) return { status: 'unknown', checkedKeys: [], missing: [], reason: 'No non-empty canonical attribution fields were supplied.' };
  const missing = checkedKeys.filter((key) => fields[key] !== attribution[key]);
  return { status: missing.length ? 'fail' : 'pass', checkedKeys, missing, reason: missing.length ? 'Attached form fields differ from canonical attribution.' : '' };
}

export function verifyCrmAttachment(input = {}) {
  const expected = input.expected && typeof input.expected === 'object' ? input.expected : {};
  const record = input.record && typeof input.record === 'object' ? input.record : {};
  const checkedKeys = Object.keys(expected);
  if (!checkedKeys.length) return { status: 'unknown', missing: [], checkedKeys: [], reason: 'No expected canonical fields were supplied.' };
  const missing = checkedKeys.filter((key) => record[key] !== expected[key]);
  return { status: missing.length ? 'fail' : 'pass', missing, checkedKeys, reason: missing.length ? 'CRM record does not contain the expected attribution values.' : '' };
}

export function verifyConversionDelivery(input = {}) {
  const receipt = input.providerReceipt;
  if (!receipt || typeof receipt !== 'object') return { status: 'unknown', reason: 'No provider receipt was supplied; local payload construction is not delivery proof.' };
  return { status: 'unknown', reason: 'Provider delivery requires a verified provider receipt; caller-supplied receipt data is not delivery proof.' };
}

export async function verifyProject(input = {}) {
  return runVerifier(input);
}

export async function adviseReport(input = {}) {
  const evidence = input.evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return { status: 'unavailable', reason: 'evidence must be a verifier evidence envelope.' };
  const errors = validateVerifierReport({ schemaVersion: '0.3.0', findings: evidence.findings, evidence });
  if (errors.length) return { status: 'unavailable', reason: 'evidence must come from a valid clicktrail-verify report.' };
  return typeSafeAdvisory(evidence);
}

export function attributionHealth(input = {}) {
  const statuses = input.statuses && typeof input.statuses === 'object' ? input.statuses : input.stages || {};
  const normalized = Object.fromEntries(STAGES.map((stage) => {
    const value = statuses[stage];
    if (value === true || value === false) return [stage, 'unknown'];
    return [stage, trustedStatus(value)];
  }));
  const pass = STAGES.filter((stage) => normalized[stage] === 'pass').length;
  const fail = STAGES.filter((stage) => normalized[stage] === 'fail').length;
  return { score: Math.round((pass / STAGES.length) * 100), pass, fail, unknown: STAGES.length - pass - fail, statuses: normalized, evidence: 'local-declared-or-synthetic' };
}

export const TOOL_SCHEMAS = Object.freeze({
  capture_click_id_schema: { type: 'object', additionalProperties: false, properties: {} },
  generate_nextjs_integration: { type: 'object', additionalProperties: false, properties: { cookieName: { description: "Cookie name; defaults to ct_attribution. Must match the declared pattern.", type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } } },
  generate_shopify_integration: { type: 'object', additionalProperties: false, properties: { eventName: { description: "Custom Shopify event to subscribe to; defaults to clicktrail_attribution. Must match the declared pattern.", type: 'string', pattern: '^[A-Za-z0-9_.-]{1,64}$' } } },
  validate_attribution_pipeline: { type: 'object', additionalProperties: false, required: ['eventId'], properties: { eventId: { description: "Nonempty caller-owned event identifier; omitted or non-string input is rejected and an empty string produces valid=false.", type: 'string' }, stages: { description: "Completion flags for capture, persist, carry, attach, report, dedupe, verify; lowercase or uppercase keys with value true count as completed.", type: 'object' }, consent: { description: "Declared analytics and advertising boolean flags. Neither affirmative flag produces a warning, not a validation error.", type: 'object' }, clickIds: { description: "Map of declared click ID names to values; nonstandard keys produce a warning. Values are not validated or transformed.", type: 'object' } } },
  diagnose_missing_click_ids: { type: 'object', additionalProperties: false, properties: { landingQuery: { description: "Query parameter map from the landing request, for example {gclid: \"synthetic\"}; omit when the query was not observed.", type: 'object' }, redirectDroppedQuery: { description: "True when a redirect discarded the query string; omitted means not reported.", type: 'boolean' }, cookieMissing: { description: "True when expected attribution storage is missing; omitted means not reported.", type: 'boolean' }, crossDomain: { description: "True when the journey crosses domains and needs a linker review.", type: 'boolean' }, safari: { description: "True when Safari storage restrictions should be included in the diagnosis.", type: 'boolean' } } },
  calculate_click_id_coverage: { type: 'object', additionalProperties: false, properties: { sessions: { description: "Array of session objects: {captured: {gclid: \"synthetic\"}, persisted: true, attached: true}. Omitted or empty returns zero counts and ratios.", type: 'array', "items": {"type": "object", "properties": {"captured": {"type": "object", "description": "Captured click ID map; recognized key presence counts as capture."}, "persisted": {"type": "boolean", "description": "Only true counts as persisted."}, "attached": {"type": "boolean", "description": "Only true counts as attached."}}} } } },
  reconcile_conversions: { type: 'object', additionalProperties: false, properties: { crm: { description: "CRM rows shaped as {eventId: \"evt_demo_1\", value: 10}; use numeric values in one shared currency. Omitted means an empty list.", type: 'array', "items": {"type": "object", "properties": {"eventId": {"type": "string", "description": "Stable identifier used for matching; missing or empty IDs are excluded from matching."}, "value": {"type": "number", "description": "Amount in the common comparison currency; omitted defaults to zero."}}} }, destination: { description: "Destination rows shaped as {eventId: \"evt_demo_1\", value: 10}; same currency as CRM rows. Omitted means an empty list.", type: 'array', "items": {"type": "object", "properties": {"eventId": {"type": "string", "description": "Stable identifier used for matching; missing or empty IDs are excluded from matching."}, "value": {"type": "number", "description": "Amount in the common comparison currency; omitted defaults to zero."}}} } } },
  send_conversion: { type: 'object', additionalProperties: false, required: ['eventId'], properties: { eventId: { description: "Nonempty caller-owned stable conversion identifier, for example evt_demo_1; omission or an empty string is an error.", type: 'string' }, eventName: { description: "Custom conversion event name; omitted or empty defaults to Conversion.", type: 'string' }, value: { description: "Conversion amount in major currency units, for example 19.95; defaults to 0.", type: 'number' }, currency: { description: "Currency code for the amount, for example EUR; defaults to USD and is uppercased. No currency conversion occurs.", type: 'string' }, clickIds: { description: "Map of supported click ID names to values, for example {gclid: \"synthetic\"}. Payload builders allowlist keys and truncate values to 512 characters.", type: 'object' } } },
  send_qualified_lead: { type: 'object', additionalProperties: false, required: ['eventId'], properties: { eventId: { description: "Nonempty caller-owned stable conversion identifier, for example evt_demo_1; omission or an empty string is an error.", type: 'string' }, value: { description: "Conversion amount in major currency units, for example 19.95; defaults to 0.", type: 'number' }, currency: { description: "Currency code for the amount, for example EUR; defaults to USD and is uppercased. No currency conversion occurs.", type: 'string' }, clickIds: { description: "Map of supported click ID names to values, for example {gclid: \"synthetic\"}. Payload builders allowlist keys and truncate values to 512 characters.", type: 'object' } } },
  send_sale: { type: 'object', additionalProperties: false, required: ['eventId'], properties: { eventId: { description: "Nonempty caller-owned stable conversion identifier, for example evt_demo_1; omission or an empty string is an error.", type: 'string' }, value: { description: "Conversion amount in major currency units, for example 19.95; defaults to 0.", type: 'number' }, currency: { description: "Currency code for the amount, for example EUR; defaults to USD and is uppercased. No currency conversion occurs.", type: 'string' }, clickIds: { description: "Map of supported click ID names to values, for example {gclid: \"synthetic\"}. Payload builders allowlist keys and truncate values to 512 characters.", type: 'object' } } },
  check_conversion_status: { type: 'object', additionalProperties: false, properties: { eventId: { description: "Optional event identifier echoed in the result. Omitted or empty returns null; it is never looked up.", type: 'string' } } },
  inspect_project: { type: 'object', additionalProperties: false, properties: { framework: { description: "Explicit framework hint; when omitted it is inferred from dependencies and source, falling back to generic.", type: 'string', enum: FRAMEWORKS }, files: { description: "Map of relative filenames to source text strings. Supply only relevant, secret-free snippets; no files are read from disk.", type: 'object' }, packageJson: { description: "Parsed package.json object; dependencies, devDependencies, and type are inspected.", type: 'object' }, tests: { description: "Array naming available tests; a nonempty array is a declared signal only. Tests are never executed.", type: 'array' } } },
  detect_attribution_gaps: { type: 'object', additionalProperties: false, properties: { evidence: { description: "Map of seven lowercase lifecycle stages to pass/fail/unknown strings or {status, reason} objects; pass only the evidence field returned by inspect_project. Omit to inspect the source snapshot.", type: 'object' }, framework: { description: "Framework hint used only when evidence is omitted and the supplied snapshot is inspected.", type: 'string', enum: FRAMEWORKS }, files: { description: "Map of relative filenames to source text strings. Supply only relevant, secret-free snippets; no files are read from disk.", type: 'object' }, packageJson: { description: "Parsed package.json object; dependencies, devDependencies, and type are inspected.", type: 'object' } } },
  plan_installation: { type: 'object', additionalProperties: false, properties: { framework: { description: "Framework to plan for; defaults to generic.", type: 'string', enum: FRAMEWORKS } } },
  simulate_ad_click: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { description: "Synthetic landing URL, for example https://example.test/?gclid=synthetic. Only the first 512 characters are parsed; invalid URLs produce no IDs.", type: 'string' }, consent: { description: "Affirmative consent for modeled capture and persistence; omitted defaults to false. Parsed IDs may still appear in the result without consent, but are not stored.", type: 'boolean' }, redirectPreservesQuery: { description: "Whether the simulated redirect preserves query parameters; defaults to true.", type: 'boolean' }, accountId: { description: "Synthetic account identifier; a nonempty accountId, leadId, or truthy formFields enables modeled attachment.", type: 'string' }, leadId: { description: "Synthetic lead identifier used as an alternative to accountId for modeled attachment.", type: 'string' }, formFields: { description: "Synthetic form field object; its presence enables modeled attachment, but contents are not validated by simulation.", type: 'object' }, eventId: { description: "Synthetic event identifier; a nonempty eventId or orderId marks modeled deduplication.", type: 'string' }, orderId: { description: "Synthetic order identifier; a nonempty eventId or orderId marks modeled deduplication.", type: 'string' } } },
  verify_capture: { type: 'object', additionalProperties: false, required: ['expectedClickId', 'captured'], properties: { expectedClickId: { description: "Expected synthetic click ID; must be nonempty to pass and is truncated to 512 characters before comparison.", type: 'string' }, key: { description: "Click ID key to compare, default gclid.", type: 'string', enum: CLICK_IDS }, captured: { description: "Observed click ID map, for example {gclid: \"synthetic\"}; compared to expectedClickId.", type: 'object' }, consent: { description: "Must be true for verification to pass; omission returns fail.", type: 'boolean' } } },
  verify_form_attachment: { type: 'object', additionalProperties: false, required: ['attribution', 'fields'], properties: { attribution: { description: "Canonical click ID map; only truthy source values are checked.", type: 'object' }, fields: { description: "Observed form field map; relevant values must strictly equal canonical attribution values.", type: 'object' }, requiredKeys: { description: "Array of click ID key strings to check. Omitted or empty uses the canonical allowlist; absent source values are not required.", type: 'array', "items": {"type": "string", "description": "Attribution key to compare when its source value is truthy."} } } },
  verify_crm_attachment: { type: 'object', additionalProperties: false, required: ['expected', 'record'], properties: { expected: { description: "Flat map of expected CRM field values. Empty means no keys are checked.", type: 'object' }, record: { description: "Caller-supplied flat CRM record snapshot compared against expected; no CRM connection is made.", type: 'object' } } },
  verify_conversion_delivery: { type: 'object', additionalProperties: false, properties: { providerReceipt: { description: "Caller-supplied receipt object with accepted boolean, status string, and/or error string. Omit for unknown; an empty object fails. No receipt provenance or event identity is verified.", type: 'object', "properties": {"accepted": {"type": "boolean", "description": "True is sufficient for pass even when status conflicts."}, "status": {"type": "string", "description": "The exact string accepted is sufficient for pass; other values fail unless accepted is true."}, "error": {"type": "string", "description": "Failure detail used when neither acceptance signal is present."}} } } },
  attribution_health: { type: 'object', additionalProperties: false, properties: { stages: { description: "Seven lowercase lifecycle keys mapped to booleans, pass/fail/unknown strings, or {status} objects. Missing keys are unknown; ignored when statuses is supplied.", type: 'object' }, statuses: { description: "Seven lowercase lifecycle keys mapped to pass/fail/unknown, booleans, or {status} objects. Overrides stages when supplied; omitted stages become unknown.", type: 'object' } } },
  verify_project: { type: 'object', additionalProperties: false, required: ['repo', 'url'], properties: { repo: { type: 'string', description: 'Absolute local repository path. The verifier reads source files in this explicit path only.' }, url: { type: 'string', description: 'Synthetic or staging http(s) URL. Forms are not submitted.' }, secondUrl: { type: 'string', description: 'Optional second synthetic or staging http(s) URL for a two-touch journey.' }, contract: { type: 'object', description: 'Declarative project contract; no selectors or executable adapters.' }, clicktrailRoot: { type: 'string', description: 'Optional absolute ClickTrail source root for repository mapping.' }, executablePath: { type: 'string', description: 'Optional browser executable path.' } } },
  advise_report: { type: 'object', additionalProperties: false, required: ['evidence'], properties: { evidence: { type: 'object', description: 'The evidence envelope returned by verify_project. It is used for advisory routing only.' } } },
});

// These two tools have fully specified outputs; keep schemas tied to their wire results.
export const TOOL_OUTPUT_SCHEMAS = Object.freeze({
  check_conversion_status: {
    type: 'object', additionalProperties: false,
    required: ['eventId', 'status', 'reason', 'nextChecks'],
    properties: {
      eventId: { type: ['string', 'null'], description: 'Supplied identifier, or null when omitted or empty.' },
      status: { type: 'string', const: 'unknown', description: 'No provider lookup is performed.' },
      reason: { type: 'string', description: 'Why delivery cannot be established locally.' },
      nextChecks: { type: 'array', items: { type: 'string' }, description: 'Manual checks to perform outside this server.' },
    },
  },
  simulate_ad_click: {
    type: 'object', additionalProperties: false,
    required: ['url', 'clickIds', 'consent', 'stages', 'statuses', 'evidence'],
    properties: {
      url: { type: 'string', description: 'Input URL truncated to 512 characters.' },
      clickIds: { type: 'object', additionalProperties: { type: 'string' }, description: 'Allowlisted IDs parsed from the URL, even when consent is false; no storage occurs.' },
      consent: { type: 'boolean', description: 'Whether affirmative consent was supplied.' },
      stages: { type: 'object', additionalProperties: false, required: STAGES,
        properties: Object.fromEntries(STAGES.map((stage) => [stage, { type: 'boolean', description: `Synthetic ${stage} completion flag; not runtime evidence.` }])) },
      statuses: { type: 'object', additionalProperties: false, required: STAGES,
        properties: Object.fromEntries(STAGES.map((stage) => [stage, {
          type: 'object', additionalProperties: false, required: ['status'],
          properties: {
            status: { type: 'string', enum: ['pass', 'unknown'], description: `Synthetic ${stage} result.` },
            reason: { type: 'string', description: 'Why this boundary remains unproven.' },
          },
        }])) },
      evidence: { type: 'string', const: 'synthetic-local-only', description: 'Results do not establish browser or provider behavior.' },
    },
  },
  verify_project: {
    type: 'object', required: ['status'],
    properties: {
      status: { type: 'string', enum: ['complete', 'unknown'] },
      report: { type: 'object', description: 'Canonical clicktrail-verify report when status is complete.' },
      evidenceAuthority: { type: 'string', const: 'clicktrail-verify-deterministic' },
      reason: { type: 'string' },
    },
  },
  advise_report: {
    type: 'object', required: ['status'],
    properties: {
      status: { type: 'string', enum: ['available', 'unavailable'] },
      provider: { type: 'string', const: 'typesafe-system-one' },
      model: { type: 'string', const: 'jev-latest' },
      answers: { type: 'object', description: 'Typed advisory answers; never factual findings.' },
      fallback: { type: 'object', description: 'Deterministic advisory fallback.' },
      reason: { type: 'string' },
    },
  },
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
  ["capture_click_id_schema", "Return the supported click ID names, cookie defaults, seven lifecycle stages, and consent rules. Call without arguments when choosing attribution keys or designing a record; this is reference data, not a project audit.", captureClickIdSchema],
  ["generate_nextjs_integration", "Generate Next.js middleware and server-action source strings for consent-gated first-touch attribution. Optional cookieName defaults to ct_attribution. Returns files and integration notes; does not write or install files. Review and test the snippets in the host app; use plan_installation for a checklist only.", generateNextjsIntegration],
  ["generate_shopify_integration", "Generate Shopify Web Pixel and order-webhook source strings. Optional eventName defaults to clicktrail_attribution. Returns files and safety notes without writing files or configuring Shopify. The host must wire the custom event and attribution handoff; generated snippets are not runtime proof.", generateShopifyIntegration],
  ["validate_attribution_pipeline", "Check a declared completion checklist for one eventId. Returns valid, errors for missing lifecycle stages, and warnings for consent or nonstandard click ID keys. This validates declarations only; use detect_attribution_gaps for pass/fail/unknown evidence or attribution_health for a numeric summary.", validateAttributionPipeline],
  ["diagnose_missing_click_ids", "Diagnose click ID loss from landing-query presence and boolean redirect, cookie, cross-domain, and Safari observations. Returns checks with code, severity, fix, and an overall status. Use for transport or storage symptoms; detect_attribution_gaps instead covers the complete lifecycle. Does not inspect a browser.", diagnoseMissingClickIds],
  ["calculate_click_id_coverage", "Calculate capture, persistence, and attachment proportions across supplied sessions. Returns totals, counts, and coverage ratios from 0 to 1, rounded to four decimals; an empty sample returns zeros. Capture counts a recognized key even if its value is empty. Use attribution_health for a single lifecycle score.", calculateClickIdCoverage],
  ["reconcile_conversions", "Compare supplied CRM and destination rows by eventId. Returns unique matched count, missing and orphaned IDs, row counts, and CRM minus destination value total rounded to two decimals. Duplicate IDs are collapsed for matching but all rows contribute to values. Supply one currency; no provider is queried.", reconcileConversions],
  ["send_conversion", "Build a destination-neutral payload for a custom conversion; despite the name, nothing is sent. Requires eventId; eventName defaults to Conversion, value to 0, currency to USD. Returns action, payload, and sideEffects=false. Use send_sale for Purchase or send_qualified_lead for QualifiedLead. The caller owns consent and delivery.", sendConversion],
  ["send_qualified_lead", "Build a destination-neutral QualifiedLead payload without sending it. Requires eventId; value defaults to 0 and currency to USD. Returns action, payload, and sideEffects=false. Use send_conversion for a custom event name; the caller must configure consent and provider delivery.", sendQualifiedLead],
  ["send_sale", "Build a destination-neutral Purchase payload without sending it. Requires eventId; value defaults to 0 and currency to USD. Returns action, payload, and sideEffects=false. Use send_conversion for other event names. The caller must configure consent and delivery; payload creation is not acceptance proof.", sendSale],
  ["check_conversion_status", "Return a manual verification checklist for an optional eventId, echoed unchanged; omitted or empty IDs return null. Always returns status=unknown, a reason, and nextChecks for request logs, provider diagnostics, and CRM reconciliation. Use when no provider receipt is available; use verify_conversion_delivery to classify a supplied receipt, or reconcile_conversions to compare record sets. Makes no network calls, requires no credentials, and changes no state.", checkConversionStatus],
  ["inspect_project", "Inspect caller-supplied source strings and package metadata using keyword heuristics. Returns inferred framework, lifecycle evidence, ClickTrail detection, and inspected filenames. Does not read the filesystem or execute tests; pass means a textual signal was found, not runtime verification. Feed only the returned evidence into detect_attribution_gaps.", inspectProject],
  ["detect_attribution_gaps", "Turn seven-stage pass/fail/unknown evidence into prioritized gaps with code, severity, and fix. Accept the evidence field from inspect_project; if omitted, inspect the supplied files and packageJson. Returns blocked, needs-review, or ready based on declarations. Use diagnose_missing_click_ids for specific query or cookie symptoms.", detectAttributionGaps],
  ["plan_installation", "Return a framework-specific install command, suggested file paths, steps, and evidence boundary. Framework defaults to generic. Produces a checklist only and runs no commands; use generate_nextjs_integration or generate_shopify_integration for source snippets.", planInstallation],
  ["simulate_ad_click", "Model a synthetic click-to-record journey from a URL and explicit consent. Returns parsed clickIds, boolean stages, pass/unknown statuses, and synthetic-local-only evidence. Invalid URLs yield no IDs; report and verify remain unproven. Does not open a browser, store cookies, submit forms, or call providers.", simulateAdClick],
  ["verify_capture", "Compare expectedClickId with captured[key], defaulting key to gclid, and require consent=true. Returns pass/fail, expected, actual, and reason; missing consent or mismatch fails. Checks supplied values only; use verify_form_attachment for the later form-copy boundary.", verifyCapture],
  ["verify_form_attachment", "Compare truthy attribution values against matching fields using strict equality. Optional nonempty requiredKeys limits the check; omitted or empty uses all supported click ID keys. Returns pass/fail, checkedKeys, missing, and reason. An empty source passes with no checked keys and proves no handoff; use verify_crm_attachment for record comparison.", verifyFormAttachment],
  ["verify_crm_attachment", "Compare every supplied expected field with record using strict equality. Returns pass/fail, missing keys, checkedKeys, and reason. Empty expected passes with no checked keys and proves no attachment. Reads no CRM; supply flat snapshots and use verify_form_attachment for browser form fields.", verifyCrmAttachment],
  ["verify_conversion_delivery", "Classify a caller-supplied providerReceipt: accepted=true or status=accepted returns pass; other supplied objects return fail; no receipt returns unknown. Returns status and reason only. Does not query or authenticate the provider or match receipts to event IDs; caller must establish provenance. Use check_conversion_status for a verification checklist.", verifyConversionDelivery],
  ["attribution_health", "Summarize seven declared lifecycle stages as score 0\u2013100, pass/fail/unknown counts, and normalized statuses. statuses takes precedence over stages; missing stages are unknown and booleans map to pass/fail. This is not measured session coverage or live proof. Use calculate_click_id_coverage for cohort ratios and detect_attribution_gaps for remediation.", attributionHealth],
  ["verify_project", "Run the local clicktrail-verify binary against an explicit absolute repository path and synthetic or staging URL. Returns the canonical deterministic evidence report when CLICKTRAIL_VERIFY_BIN or clicktrail-verify is available. No forms are submitted, no provider APIs are called, and browser sandboxing remains enabled by default.", verifyProject],
  ["advise_report", "Use optional TypeSafe System One judgments to route a valid clicktrail-verify evidence envelope to the narrowest skill and rank remediation. TypeSafe receives only redacted finding summaries. It cannot change deterministic PASS, FAIL, UNKNOWN, WARN, or NOT_RUN results; without TYPESAFE_API_KEY, a deterministic advisory fallback is returned.", adviseReport],
];
