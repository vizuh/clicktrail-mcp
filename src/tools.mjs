const CLICK_IDS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'fbc', 'fbp', 'msclkid', 'ttclid', 'li_fat_id'];
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

const IDS = ['gclid','gbraid','wbraid','fbclid','msclkid','ttclid','li_fat_id'];
export function middleware(request) {
  const response = NextResponse.next();
  const captured = Object.fromEntries(IDS.flatMap((key) => { const value = request.nextUrl.searchParams.get(key); return value ? [[key, value]] : []; }));
  if (Object.keys(captured).length) response.cookies.set('${cookieName}', JSON.stringify(captured), { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 7776000, path: '/' });
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
      'web-pixel.js': `analytics.subscribe('${eventName}', (event) => { const url = new URL(event.context.document.location.href); const ids = {}; for (const key of ['gclid','gbraid','wbraid','fbclid']) { const value = url.searchParams.get(key); if (value) ids[key] = value; } if (Object.keys(ids).length) localStorage.setItem('ct_attribution', JSON.stringify(ids)); });`,
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

export const TOOL_DEFINITIONS = [
  ['capture_click_id_schema', 'Return the canonical click ID allowlist and lifecycle schema.', captureClickIdSchema],
  ['generate_nextjs_integration', 'Generate a minimal Next.js attribution integration.', generateNextjsIntegration],
  ['generate_shopify_integration', 'Generate Shopify Web Pixel and order webhook attribution helpers.', generateShopifyIntegration],
  ['validate_attribution_pipeline', 'Validate declared attribution lifecycle stages and consent.', validateAttributionPipeline],
  ['diagnose_missing_click_ids', 'Diagnose common click ID loss boundaries.', diagnoseMissingClickIds],
  ['calculate_click_id_coverage', 'Calculate capture, persistence, and attachment coverage.', calculateClickIdCoverage],
  ['reconcile_conversions', 'Reconcile CRM conversions against destination conversion records.', reconcileConversions]
];
