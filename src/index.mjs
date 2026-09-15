#!/usr/bin/env node
import readline from 'node:readline';
import { TOOL_DEFINITIONS, TOOL_SCHEMAS, TOOL_OUTPUT_SCHEMAS, validateToolInput } from './tools.mjs';

const SUPPORTED_PROTOCOL_VERSION = '2025-06-18';
const INSTRUCTIONS = 'ClickTrail operates on caller-supplied, secret-free snapshots and synthetic data only. No tool reads files, calls providers, requires credentials, or changes external state. Start with inspect_project, pass its evidence field to detect_attribution_gaps, then use plan_installation. Use diagnose_missing_click_ids for query/cookie loss and calculate_click_id_coverage for session ratios. Use simulate_ad_click for a local model, verify_* for supplied boundary evidence, and attribution_health for a declared-stage summary. The send_* tools only build payloads: send_conversion supports custom event names, send_sale fixes Purchase, and send_qualified_lead fixes QualifiedLead. check_conversion_status always returns unknown plus a checklist; verify_conversion_delivery classifies an unverified caller receipt. No result proves live delivery, consent compliance, or provider provenance.';
const definitions = TOOL_DEFINITIONS.map(([name, description]) => ({ name, description, inputSchema: TOOL_SCHEMAS[name], ...(TOOL_OUTPUT_SCHEMAS[name] ? { outputSchema: TOOL_OUTPUT_SCHEMAS[name] } : {}), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }));
const handlers = new Map(TOOL_DEFINITIONS.map(([name, , handler]) => [name, handler]));
const negotiateProtocolVersion = (requested) => requested === SUPPORTED_PROTOCOL_VERSION ? requested : SUPPORTED_PROTOCOL_VERSION;
function write(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function result(id, body) { write({ jsonrpc: '2.0', id, result: body }); }
function error(id, code, message) { write({ jsonrpc: '2.0', id, error: { code, message } }); }
function toolError(message) { return { content: [{ type: 'text', text: message }], isError: true }; }

async function handle(message) {
  const validObject = message !== null && typeof message === 'object' && !Array.isArray(message);
  if (!validObject || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return error(null, -32600, 'Invalid Request');
  }
  const isNotification = !Object.hasOwn(message, 'id');
  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return;
  if (message.method === 'initialize') return isNotification ? undefined : result(message.id, { protocolVersion: negotiateProtocolVersion(message.params?.protocolVersion), capabilities: { tools: {} }, serverInfo: { name: 'clicktrail-mcp', version: '0.2.0' }, instructions: INSTRUCTIONS });
  if (message.method === 'ping') return isNotification ? undefined : result(message.id, {});
  if (message.method === 'tools/list') return isNotification ? undefined : result(message.id, { tools: definitions });
  if (message.method === 'tools/call') {
    if (isNotification) return;
    const name = message.params?.name;
    const handler = handlers.get(name);
    if (!handler) return error(message.id, -32602, `Unknown tool: ${name}`);
    const validationErrors = validateToolInput(name, message.params?.arguments || {});
    if (validationErrors.length) return result(message.id, toolError(JSON.stringify({ error: 'invalid_tool_input', details: validationErrors })));
    try {
      const output = await handler(message.params?.arguments || {});
      return result(message.id, { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], ...(TOOL_OUTPUT_SCHEMAS[name] ? { structuredContent: output } : {}), isError: false });
    }
    catch (e) { return result(message.id, toolError(e instanceof Error ? e.message : 'Tool failed')); }
  }
  if (!isNotification) return error(message.id, -32601, `Unknown method: ${message.method}`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  try { await handle(JSON.parse(line)); }
  catch { error(null, -32700, 'Parse error'); }
}
