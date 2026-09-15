#!/usr/bin/env node
import readline from 'node:readline';
import { TOOL_DEFINITIONS, TOOL_SCHEMAS, validateToolInput } from './tools.mjs';

const definitions = TOOL_DEFINITIONS.map(([name, description]) => ({ name, description, inputSchema: TOOL_SCHEMAS[name] }));
const handlers = new Map(TOOL_DEFINITIONS.map(([name, , handler]) => [name, handler]));
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
  if (message.method === 'initialize') return isNotification ? undefined : result(message.id, { protocolVersion: message.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'clicktrail-mcp', version: '0.2.0' } });
  if (message.method === 'ping') return isNotification ? undefined : result(message.id, {});
  if (message.method === 'tools/list') return isNotification ? undefined : result(message.id, { tools: definitions });
  if (message.method === 'tools/call') {
    if (isNotification) return;
    const name = message.params?.name;
    const handler = handlers.get(name);
    if (!handler) return error(message.id, -32602, `Unknown tool: ${name}`);
    const validationErrors = validateToolInput(name, message.params?.arguments || {});
    if (validationErrors.length) return result(message.id, toolError(JSON.stringify({ error: 'invalid_tool_input', details: validationErrors })));
    try { return result(message.id, { content: [{ type: 'text', text: JSON.stringify(await handler(message.params?.arguments || {}), null, 2) }], isError: false }); }
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
