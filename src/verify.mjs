import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const STATUSES = new Set(['PASS', 'FAIL', 'WARN', 'NOT_RUN', 'UNKNOWN']);
const EVIDENCE_SCHEMA_VERSION = '1.0.0';
const MAX_OUTPUT_BYTES = 32 * 1024;
const validUrl = (value) => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol); } catch { return false; } };
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

export function validateVerifierReport(report) {
  const errors = [];
  if (!isObject(report)) return ['report must be an object'];
  if (report.schemaVersion !== '0.3.0') errors.push('unsupported verifier report schema');
  if (!Array.isArray(report.findings)) errors.push('report findings must be an array');
  const evidence = report.evidence;
  if (!isObject(evidence) || evidence.schemaVersion !== EVIDENCE_SCHEMA_VERSION || evidence.producer !== 'clicktrail-verify') errors.push('report evidence envelope is invalid');
  const observationIds = new Set((evidence?.observations || []).map(observation => observation?.id));
  for (const finding of report.findings || []) {
    if (!isObject(finding) || typeof finding.id !== 'string' || !STATUSES.has(finding.status) || !Array.isArray(finding.evidenceRefs)) errors.push('report finding shape is invalid');
    for (const ref of finding?.evidenceRefs || []) if (!observationIds.has(ref)) errors.push(`report finding references missing observation: ${ref}`);
  }
  return errors;
}

function runProcess(command, args, cwd) {
  return new Promise((resolve) => {
    const script = /\.(?:c|m)?js$/.test(command);
    const child = spawn(script ? process.execPath : command, script ? [command, ...args] : args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    let truncated = false;
    child.stdout.on('data', chunk => {
      if (stdout.length >= MAX_OUTPUT_BYTES) { truncated = true; return; }
      stdout += chunk.toString('utf8', 0, Math.max(0, MAX_OUTPUT_BYTES - stdout.length));
    });
    child.on('error', () => resolve({ code: null, stdout: '', truncated: false }));
    child.on('close', code => resolve({ code, stdout, truncated }));
  });
}

export async function verifyProject(input = {}, { verifyBin = process.env.CLICKTRAIL_VERIFY_BIN || 'clicktrail-verify', tempRoot = os.tmpdir() } = {}) {
  if (typeof input.repo !== 'string' || !path.isAbsolute(input.repo)) return { status: 'unknown', reason: 'repo must be an absolute local path.' };
  if (!validUrl(input.url)) return { status: 'unknown', reason: 'url must be an http or https URL.' };
  if (input.secondUrl !== undefined && !validUrl(input.secondUrl)) return { status: 'unknown', reason: 'secondUrl must be an http or https URL.' };
  if (input.clicktrailRoot !== undefined && (typeof input.clicktrailRoot !== 'string' || !path.isAbsolute(input.clicktrailRoot))) return { status: 'unknown', reason: 'clicktrailRoot must be an absolute local path.' };
  if (typeof verifyBin !== 'string' || !verifyBin) return { status: 'unknown', reason: 'CLICKTRAIL_VERIFY_BIN is not configured.' };
  const tempDir = await mkdtemp(path.join(tempRoot, 'clicktrail-mcp-'));
  const contractPath = path.join(tempDir, 'contract.json');
  const outputPath = path.join(tempDir, 'report');
  try {
    await writeFile(contractPath, JSON.stringify(isObject(input.contract) ? input.contract : {}));
    const args = ['--repo', input.repo, '--url', input.url, '--contract', contractPath, '--output', outputPath];
    if (input.secondUrl) args.push('--second-url', input.secondUrl);
    if (input.clicktrailRoot) args.push('--clicktrail-root', input.clicktrailRoot);
    if (input.executablePath) args.push('--executable-path', input.executablePath);
    const result = await runProcess(verifyBin, args, process.cwd());
    if (result.code !== 0 || result.truncated) return { status: 'unknown', reason: result.truncated ? 'Verifier output exceeded the safety limit.' : 'Verifier did not produce a report.' };
    let report;
    try { report = JSON.parse(await readFile(path.join(outputPath, 'report.json'), 'utf8')); } catch { return { status: 'unknown', reason: 'Verifier report was missing or malformed.' }; }
    const errors = validateVerifierReport(report);
    if (errors.length) return { status: 'unknown', reason: 'Verifier report failed the evidence contract.' };
    return { status: 'complete', report, evidenceAuthority: 'clicktrail-verify-deterministic' };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
