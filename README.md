# ClickTrail MCP

A dependency-light Model Context Protocol stdio server for attribution engineering. It helps coding agents inspect click ID schemas, generate small integrations, diagnose loss, validate lifecycle declarations, calculate coverage, and reconcile conversion records.

## Build and test

```sh
npm run typecheck
npm test
npm run build
```

## Run

```sh
npm run build
node dist/index.mjs
```

The server reads newline-delimited JSON-RPC messages from stdin and writes responses to stdout. It does not call ad platforms or transmit customer data.

## Tools

`capture_click_id_schema`, `generate_nextjs_integration`, `generate_shopify_integration`, `validate_attribution_pipeline`, `diagnose_missing_click_ids`, `calculate_click_id_coverage`, and `reconcile_conversions`.
