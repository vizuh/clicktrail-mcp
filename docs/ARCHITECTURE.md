# ClickTrail MCP architecture

ClickTrail MCP is the agent-facing control plane for a local, evidence-first
ClickTrail workflow. It has two modes.

## Modes

### Snapshot mode

`inspect_project`, `detect_attribution_gaps`, and the other existing tools accept
caller-supplied, secret-free values. They do not read a repository or open a
browser. Their results are useful diagnostics, not runtime proof.

### Verify mode

`verify_project` runs the locally configured `clicktrail-verify` executable for
an explicit absolute repository path and an HTTP(S) synthetic or staging URL.
It uses a temporary declarative contract and temporary report directory. The
child process is spawned with `shell: false`; forms are not submitted, provider
APIs are not called, and `--no-sandbox` is never added by MCP.

The executable is selected by `CLICKTRAIL_VERIFY_BIN`, or by the
`clicktrail-verify` command on `PATH`.

## Agent flow

```mermaid
sequenceDiagram
  participant A as Agent
  participant S as ClickTrail skill
  participant M as MCP
  participant V as Verify
  participant T as TypeSafe

  A->>S: Describe attribution problem
  S->>M: inspect_project or verify_project
  M->>V: Run bounded local verification
  V-->>M: 0.3.0 report and evidence envelope
  M-->>A: Deterministic findings
  A->>M: advise_report(evidence)
  M->>T: Redacted summaries and typed questions
  T-->>M: Skill choice, priority, review probability
  M-->>A: Advisory only; factual statuses unchanged
```

## TypeSafe boundary

The advisor uses the TypeSafe System One HTTP contract with model
`jev-latest`. It asks one `Choice`, one `Score`, and one `Noul` question over a
single structured state. The state contains only finding IDs, statuses, owners,
evidence-reference counts, and the allowlisted skill catalog.

TypeSafe is optional. Without `TYPESAFE_API_KEY`, MCP returns a deterministic
fallback. Network failures and malformed responses also return the fallback.
No API key or provider response is returned to the caller.

TypeSafe cannot:

- create an observation or evidence reference;
- turn `UNKNOWN` into `PASS`;
- establish consent, CRM writes, revenue attribution, or provider acceptance;
- select an executable adapter or perform an external action.

## Tool contract

The intended sequence is:

1. Use `inspect_project` when only a source snapshot is available.
2. Use `verify_project` when the caller explicitly authorizes local repository
   and staging/localhost access.
3. Pass `result.report.evidence` to `advise_report` when semantic routing or
   prioritization is useful.
4. Follow the selected skill and the exact evidence references.

All tools remain read-only. `send_*` tools build payloads only. Provider status
is `UNKNOWN` unless an independently verifiable receipt exists outside MCP.
