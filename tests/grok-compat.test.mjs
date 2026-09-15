import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { TOOL_DEFINITIONS, TOOL_SCHEMAS } from "../src/tools.mjs";

const SERVER_PATH = fileURLToPath(new URL("../src/index.mjs", import.meta.url));
const GROK_SERVER = "clicktrail";

function runServer(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_PATH], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test("uses names that Grok Build can namespace without ambiguity", async () => {
  const server = JSON.parse(await fs.readFile(new URL("../server.json", import.meta.url), "utf8"));
  assert.equal(server.packages[0].transport.type, "stdio");
  assert.equal(server.packages[0].identifier, "@vizuh/clicktrail-mcp");
  assert.ok(server.description.length <= 100);
  const packageJson = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.mcpName, server.name);
  for (const [name, description] of TOOL_DEFINITIONS) {
    assert.match(name, /^[a-z][a-z0-9_]*$/);
    assert.doesNotMatch(name, /__/);
    assert.ok(description.length > 0);
    assert.ok(TOOL_SCHEMAS[name]);
    assert.match(`${GROK_SERVER}__${name}`, /^clicktrail__[a-z][a-z0-9_]*$/);
  }
});

test("completes a synthetic Grok-shaped MCP discovery and audit call locally", async () => {
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2099-01-01" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "inspect_project", arguments: {
      framework: "nextjs",
      packageJson: { dependencies: { next: "16.0.0" } },
      files: { "middleware.ts": "capture gclid into a consent-gated cookie" },
      tests: ["synthetic boundary test"],
    } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "detect_attribution_gaps", arguments: {
      evidence: { capture: "pass", persist: "pass", carry: "unknown", attach: "fail", report: "unknown", dedupe: "unknown", verify: "unknown" },
    } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "verify_conversion_delivery", arguments: {} } },
  ].map((message) => JSON.stringify(message)).join("\n") + "\n";
  const result = await runServer(input);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const responses = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const byId = new Map(responses.map((response) => [response.id, response]));
  assert.equal(byId.get(1).result.serverInfo.name, "clicktrail-mcp");
  assert.equal(byId.get(1).result.protocolVersion, "2025-06-18");
  assert.equal(byId.get(2).result.tools.length, TOOL_DEFINITIONS.length);
  assert.deepEqual(byId.get(2).result.tools.map(({ name }) => name), TOOL_DEFINITIONS.map(([name]) => name));
  assert.equal(byId.get(3).result.isError, false);
  assert.equal(byId.get(4).result.isError, false);
  assert.equal(byId.get(5).result.isError, false);
  const delivery = JSON.parse(byId.get(5).result.content[0].text);
  assert.equal(delivery.status, "unknown");
  assert.match(delivery.reason, /receipt|delivery/i);
  assert.ok(!result.stdout.includes("@example.com"));
});
