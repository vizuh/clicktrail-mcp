# ClickTrail MCP

> **ClickTrail is the open-source attribution handoff layer that keeps observed acquisition context attached to conversion records inside the stack you own.**

ClickTrail MCP makes that handoff inspectable and completable by coding agents.
It supports a safe snapshot mode and a bounded Verify mode. Agents can inspect a
supplied project snapshot, run `clicktrail-verify` against an explicit local
repository and synthetic/staging URL, receive a canonical evidence report, and
optionally ask TypeSafe to route and prioritize the next remediation.

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

This manual setup is intentional while `@vizuh/clicktrail-mcp@0.3.0` is not
published on npm. Do not copy an `npx` command into a distributable plugin until
that exact package version is reachable from the public registry. xAI's
Responses API remote MCP surface is separate and accepts streaming HTTP or SSE,
not this stdio process.

The server reads newline-delimited JSON-RPC messages from stdin and writes responses to stdout. Snapshot tools do not read project files. The explicit `verify_project` tool invokes a local verifier against a caller-selected repository and URL; it does not submit forms, call ad platforms, transmit customer data, or claim live provider verification.

## Workflow tools

- `inspect_project` → `detect_attribution_gaps` → `plan_installation`
- `generate_nextjs_integration` / `generate_shopify_integration`
- `simulate_ad_click` → `verify_capture` → `verify_form_attachment` → `verify_crm_attachment`
- `verify_conversion_delivery` → `attribution_health`
- `verify_project` → `advise_report` (optional TypeSafe routing and prioritization)

The server also provides `capture_click_id_schema`, `validate_attribution_pipeline`, `diagnose_missing_click_ids`, `calculate_click_id_coverage`, `reconcile_conversions`, `send_conversion`, `send_qualified_lead`, `send_sale`, and `check_conversion_status`. Delivery tools build payloads only. `check_conversion_status` always returns `unknown`; `verify_conversion_delivery` classifies a caller-supplied receipt without authenticating it.


## Choosing tools and interpreting results

Snapshot tools operate locally on supplied data, need no credentials, and perform
no external writes or provider calls. `verify_project` is an explicit local
subprocess boundary and may access the selected repository and URL. `advise_report`
uses TypeSafe only when configured and sends redacted summaries. Discovery
includes parameter descriptions and read-only annotations; initialization
includes workflow guidance.

| Question | Tool | Result boundary |
| --- | --- | --- |
| What does this source snapshot contain? | `inspect_project` | Keyword signals, not executed tests |
| Which lifecycle stages need work? | `detect_attribution_gaps` | Pass only `{ "evidence": inspection.evidence }` |
| Why were click IDs lost? | `diagnose_missing_click_ids` | Query, redirect, cookie, and browser observations |
| What fraction of sessions carried attribution? | `calculate_click_id_coverage` | Ratios over supplied sessions |
| How many declared stages pass? | `attribution_health` | Seven-stage summary, not traffic measurement |
| How should I verify an event without a receipt? | `check_conversion_status` | Always `unknown`, with manual next checks |
| Does this supplied receipt report acceptance? | `verify_conversion_delivery` | No receipt provenance or event-ID verification |
| Do CRM and destination records match? | `reconcile_conversions` | Event-ID matching and same-currency totals |
| Can I run the deterministic verifier? | `verify_project` | Canonical `0.3.0` report and evidence envelope |
| Which skill should handle the findings? | `advise_report` | Optional TypeSafe advice; factual statuses remain unchanged |

`check_conversion_status` and `simulate_ad_click` expose output schemas and return
both `structuredContent` and equivalent JSON text for older clients. For example:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check_conversion_status","arguments":{"eventId":"evt_demo_1"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"simulate_ad_click","arguments":{"url":"https://example.test/?gclid=synthetic","consent":true,"accountId":"acct_demo","eventId":"evt_demo_1"}}}
```

The status call echoes the event ID with `status: "unknown"`, a reason, and
`nextChecks`. The simulation returns `evidence: "synthetic-local-only"`; reporting
and verification remain unproven. Parsed IDs can appear in its result without
consent, but no storage occurs. Empty form or CRM expectations check no keys and
must not be treated as handoff proof.
