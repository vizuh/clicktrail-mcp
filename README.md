# ClickTrail MCP

> **ClickTrail is the open-source attribution handoff layer that keeps observed acquisition context attached to conversion records inside the stack you own.**

ClickTrail MCP makes that handoff inspectable and completable by coding agents.
It helps agents inspect a supplied project snapshot, detect attribution gaps,
plan and generate consent-aware integrations, simulate synthetic journeys,
verify each lifecycle boundary, calculate coverage, and reconcile conversion
records.

## Build and test

```sh
npm run typecheck
npm test
npm run build
```

## Run

Use the published package when available:

```sh
npx -y @vizuh/clicktrail-mcp
```

Or run the checked-out server:

```sh
npm run build
node dist/index.mjs
```

Example Codex configuration:

```sh
codex mcp add clicktrail -- npx -y @vizuh/clicktrail-mcp
```

Grok Build can use the same local stdio server after a checked-out build:

```sh
grok mcp add --scope project clicktrail -- node /path/to/clicktrail-mcp/dist/index.mjs
grok inspect
```

This manual setup is intentional while `@vizuh/clicktrail-mcp@0.2.0` is not
published on npm. Do not copy an `npx` command into a distributable plugin until
that exact package version is reachable from the public registry. xAI's
Responses API remote MCP surface is separate and accepts streaming HTTP or SSE,
not this stdio process.

The server reads newline-delimited JSON-RPC messages from stdin and writes responses to stdout. It does not read project files, call ad platforms, transmit customer data, or claim live verification without an explicit provider receipt.

## Workflow tools

- `inspect_project` → `detect_attribution_gaps` → `plan_installation`
- `generate_nextjs_integration` / `generate_shopify_integration`
- `simulate_ad_click` → `verify_capture` → `verify_form_attachment` → `verify_crm_attachment`
- `verify_conversion_delivery` → `attribution_health`

The server also provides `capture_click_id_schema`, `validate_attribution_pipeline`, `diagnose_missing_click_ids`, `calculate_click_id_coverage`, `reconcile_conversions`, `send_conversion`, `send_qualified_lead`, `send_sale`, and `check_conversion_status`. Delivery tools build payloads only. Provider status is `unknown` unless a caller supplies a receipt.
