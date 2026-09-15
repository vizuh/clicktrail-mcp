#!/usr/bin/env node
import readline from 'node:readline';
import { TOOL_DEFINITIONS } from './tools.mjs';

const definitions = TOOL_DEFINITIONS.map(([name, description]) => ({ name, description, inputSchema: { type: 'object', additionalProperties: true } }));
const handlers = new Map(TOOL_DEFINITIONS.map(([name, , handler]) => [name, handler]));
function result(id, body) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: body }) + String.fromCharCode(10)); }
function error(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + String.fromCharCode(10)); }
async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return;
  if (message.method === 'initialize') return result(message.id, { protocolVersion: message.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'clicktrail-mcp', version: '0.1.0' } });
  if (message.method === 'ping') return result(message.id, {});
  if (message.method === 'tools/list') return result(message.id, { tools: definitions });
  if (message.method === 'tools/call') {
    const name = message.params?.name;
    const handler = handlers.get(name);
    if (!handler) return error(message.id, -32602, `Unknown tool: ${name}`);
    try { return result(message.id, { content: [{ type: 'text', text: JSON.stringify(handler(message.params?.arguments || {}), null, 2) }], isError: false }); }
    catch (e) { return result(message.id, { content: [{ type: 'text', text: e instanceof Error ? e.message : 'Tool failed' }], isError: true }); }
  }
  if (message.id !== undefined) return error(message.id, -32601, `Unknown method: ${message.method}`);
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) { if (line.trim()) await handle(JSON.parse(line)); }
