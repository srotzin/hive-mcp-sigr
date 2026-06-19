# hive-mcp-sigr — Signed inference Guarantee Receipt (SiGR™)

A remote [MCP](https://modelcontextprotocol.io) server that signs the things AI agents do — runs, billing, SLA bonds, and model-panel verdicts — with **ML-DSA-65 (NIST FIPS 204)**. Every receipt is returned as a self-contained envelope you can verify **offline**, with no secret and no callback to us.

Most of what an AI agent does today is unsigned. When a run goes wrong, reconstruction takes weeks because nobody has the exact, ordered state the model saw before it acted. SiGR signs that state at the moment of the call. The receipt is the record.

**Patent Pending. Hive Civilization.**

- Remote endpoint: `https://hive-mcp-sigr.onrender.com/mcp`
- Transport: Streamable-HTTP, JSON-RPC 2.0, MCP `2024-11-05`
- Upstream signer: `https://hive-typed-signer.onrender.com`
- Signature scheme: ML-DSA-65 (NIST FIPS 204), ~7 ms per signature
- Pricing: **Build tier (first 1M receipts) free.** Verify is always free. Full ladder at [thehiveryiq.com/sigr/](https://www.thehiveryiq.com/sigr/)

---

## Tools

| Tool | What it signs | Docket | Required input |
|---|---|---|---|
| `sign_chain` | A multi-step agent run, each step sealed to its causal parents with a `causal_root` (flagship) | HC-2026-006 | `run` |
| `sign_bill` | An inference cost / billing receipt (tokens, backend, prices) | HC-2026-004 | `request` |
| `sign_bond` | An SLA performance bond (latency ceiling, uptime floor, penalty) | HC-2026-005 | `terms` |
| `sign_consensus` | A model-panel verdict (member digests, scores, method) | HC-2026-007 | `panel`, `method`, `members` |
| `verify_receipt` | Verifies any SiGR envelope offline (always free) | — | `product`, `envelope` |
| `get_pubkey` | Returns the ML-DSA-65 public key + issuer metadata | — | — |

Each sign tool returns the full signed envelope (`ok`, `product`, `patent_pending`, `envelope`, `timing_us`). The `envelope` carries the `public_key`, `payload_digest`, and `envelope_signature` needed to verify it later with `verify_receipt` or directly against the signer.

---

## Endpoints (upstream signer)

| Endpoint | Method | Purpose |
|---|---|---|
| `/sigr/chain` | POST | Sign an agent run |
| `/sigr/bill` | POST | Sign a billing receipt |
| `/sigr/bond` | POST | Sign an SLA bond |
| `/sigr/consensus` | POST | Sign a panel verdict |
| `/sigr/{product}/verify` | POST | Verify an envelope (free) |
| `/pubkey` | GET | ML-DSA-65 public key |

---

## Connect

### Claude Desktop / MCP client (remote)

```json
{
  "mcpServers": {
    "hive-sigr": {
      "type": "streamable-http",
      "url": "https://hive-mcp-sigr.onrender.com/mcp"
    }
  }
}
```

### List tools

```bash
curl -s -X POST https://hive-mcp-sigr.onrender.com/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### Call `sign_chain` (flagship)

```bash
curl -s -X POST https://hive-mcp-sigr.onrender.com/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"sign_chain","arguments":{"run":{"run_id":"run-1","agent_ref":"research-agent-v2","steps":[{"step_id":"s1","kind":"plan","seq":0,"parents":[],"input":{"goal":"compare"},"output":{"plan":["a","b"]}},{"step_id":"s2","kind":"final","seq":1,"parents":["s1"],"input":{"r":"A"},"output":{"answer":"done"}}]}}}}'
```

### Verify a receipt (free)

```bash
curl -s -X POST https://hive-mcp-sigr.onrender.com/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"verify_receipt","arguments":{"product":"chain","envelope":{ /* paste the envelope from sign_chain */ }}}}'
```

---

## Run it yourself

```bash
npm install
node server.js
# -> [hive-mcp-sigr] v1.0.0 listening on :3000 -> https://hive-typed-signer.onrender.com
```

Environment:

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `ENABLE` | `true` | Set `false` to run health-only |
| `HIVE_SIGNER_URL` | `https://hive-typed-signer.onrender.com` | Upstream signer base |

---

## Policy

Inbound only. Never takes custody of keys or funds. Signing only — your payload is signed and returned; we do not store it.

Settlement for paid tiers is USDC on Base. Verify is always free.

---

MIT © 2026 Steve Rotzin / Hive Civilization · [thehiveryiq.com](https://www.thehiveryiq.com)
