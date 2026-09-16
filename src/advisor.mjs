const MODEL = 'jev-latest';
const API_URL = 'https://api.typesafe.ai/v1/systemone';
const SKILLS = [
  'click-tracking-audit', 'attribution-debugging', 'click-id-debugging',
  'utm-and-click-id-persistence', 'click-to-crm-attribution',
  'offline-conversion-tracking', 'conversion-reconciliation',
  'cross-domain-attribution', 'meta-capi-deduplication', 'preserve-click-ids',
];
const SKILL_BY_FINDING = {
  CONSENT_APP_EVENTS: 'utm-and-click-id-persistence',
  GRANTED_PAGE_VIEW: 'click-tracking-audit',
  BROWSER_ERRORS: 'attribution-debugging',
  PRECONSENT_PROVIDER_ACTIVITY: 'utm-and-click-id-persistence',
  SOURCE_RUNTIME_EVENT_DRIFT: 'click-tracking-audit',
  FORM_CONVERSION: 'click-to-crm-attribution',
  PAGE_VIEW_DEDUPE: 'meta-capi-deduplication',
  ATTRIBUTION_HANDOFF: 'click-to-crm-attribution',
};

const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const bounded = (value, max = 160) => typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max) : '';

export function buildAdvisoryState(evidence) {
  const safe = object(evidence);
  const findings = Array.isArray(safe.findings) ? safe.findings : [];
  return {
    evidenceSchemaVersion: bounded(safe.schemaVersion, 32),
    producer: bounded(safe.producer, 64),
    findingCount: findings.length,
    findings: findings.slice(0, 32).map((finding) => ({
      id: bounded(finding?.id, 80),
      status: ['PASS', 'FAIL', 'WARN', 'NOT_RUN', 'UNKNOWN'].includes(finding?.status) ? finding.status : 'UNKNOWN',
      owner: bounded(finding?.owner, 80),
      evidenceRefCount: Array.isArray(finding?.evidenceRefs) ? finding.evidenceRefs.length : 0,
    })),
    availableSkills: SKILLS,
    policy: 'This is advisory routing only. Deterministic verifier findings remain authoritative; provider delivery and legal compliance are never inferred.',
  };
}

export function deterministicAdvisory(evidence) {
  const findings = Array.isArray(evidence?.findings) ? evidence.findings : [];
  const ranked = findings
    .filter(finding => finding?.status !== 'PASS')
    .map((finding) => ({
      findingId: bounded(finding?.id, 80),
      skill: SKILL_BY_FINDING[finding?.id] || 'attribution-debugging',
      priority: finding?.status === 'FAIL' ? 3 : finding?.status === 'UNKNOWN' ? 2 : 1,
      reason: finding?.status === 'FAIL' ? 'Deterministic finding failed.' : 'Evidence is incomplete or needs review.',
    }))
    .sort((a, b) => b.priority - a.priority || a.findingId.localeCompare(b.findingId));
  return { nextSkill: ranked[0]?.skill || 'click-tracking-audit', rankedFindings: ranked.slice(0, 12), humanReview: ranked.some(item => item.priority >= 2) };
}

function questions() {
  return {
    nextSkill: {
      type: 'choice',
      instructions: 'Which one skill is the best next remediation guide for the observed findings? Choose only from the available skills. This is routing, not a factual verdict.',
      criteria: Object.fromEntries(SKILLS.map(skill => [skill, `Use for the primary remediation surface named by the findings; choose ${skill} only when it is the narrowest useful guide.`])),
    },
    repairPriority: {
      type: 'score',
      instructions: 'How urgent is the next remediation relative to the other observed findings, considering consent leaks and broken attribution handoffs more serious than missing optional evidence?',
      criteria: ['No actionable remediation', 'Useful follow-up', 'Important remediation', 'High-risk remediation', 'Immediate human-led remediation'],
    },
    humanReview: {
      type: 'noul',
      instructions: 'Does this evidence require human review before any implementation or external action?',
      criteria: { true: 'The evidence is ambiguous, high-risk, or lacks the authority needed for an external action.', false: 'A bounded, local, reversible remediation can proceed without external action.' },
    },
  };
}

function validAnswers(body) {
  const answers = object(body?.answers);
  const nextSkill = object(answers.nextSkill);
  const priority = object(answers.repairPriority);
  const humanReview = object(answers.humanReview);
  if (!SKILLS.includes(nextSkill.choice) || typeof nextSkill.confidence !== 'number' || nextSkill.confidence < 0 || nextSkill.confidence > 1) return null;
  if (typeof priority.score !== 'number' || !Number.isFinite(priority.score) || priority.score < 0 || priority.score > 4 || typeof priority.confidence !== 'number' || priority.confidence < 0 || priority.confidence > 1) return null;
  if (typeof humanReview.noul !== 'number' || humanReview.noul < 0 || humanReview.noul > 1) return null;
  return {
    nextSkill: { choice: nextSkill.choice, confidence: nextSkill.confidence },
    repairPriority: { score: priority.score, confidence: priority.confidence },
    humanReview: { probability: humanReview.noul },
  };
}

export async function typeSafeAdvisory(evidence, { apiKey = process.env.TYPESAFE_API_KEY, endpoint = process.env.TYPESAFE_ENDPOINT || API_URL, fetchImpl = globalThis.fetch } = {}) {
  const fallback = deterministicAdvisory(evidence);
  if (typeof apiKey !== 'string' || !apiKey) return { status: 'unavailable', reason: 'TYPESAFE_API_KEY is not configured.', fallback };
  if (typeof fetchImpl !== 'function') return { status: 'unavailable', reason: 'Fetch is unavailable in this runtime.', fallback };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, state: buildAdvisoryState(evidence), questions: questions() }),
      signal: controller.signal,
    });
    if (!response.ok) return { status: 'unavailable', reason: 'TypeSafe request failed.', fallback };
    const answers = validAnswers(await response.json());
    if (!answers) return { status: 'unavailable', reason: 'TypeSafe returned an invalid advisory shape.', fallback };
    return { status: 'available', provider: 'typesafe-system-one', model: MODEL, answers, fallback };
  } catch {
    return { status: 'unavailable', reason: 'TypeSafe request could not be completed.', fallback };
  } finally {
    clearTimeout(timeout);
  }
}
