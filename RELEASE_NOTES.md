# v1.0.0 — Hive SiGR MCP Server

First public release of `hive-mcp-sigr`, the remote MCP surface for the **Signed inference Guarantee Receipt (SiGR™)** suite.

## What's in it

Six tools, Streamable-HTTP, JSON-RPC 2.0, MCP `2024-11-05`:

- **`sign_chain`** (flagship, HC-2026-006) — seals a multi-step agent run, each step bound to its causal parents with a `causal_root`.
- **`sign_bill`** (HC-2026-004) — signs an inference cost / billing receipt.
- **`sign_bond`** (HC-2026-005) — signs an SLA performance bond.
- **`sign_consensus`** (HC-2026-007) — signs a model-panel verdict.
- **`verify_receipt`** — verifies any SiGR envelope offline. Always free.
- **`get_pubkey`** — returns the ML-DSA-65 (NIST FIPS 204) public key.

## How it works

Every receipt is signed with ML-DSA-65 (NIST FIPS 204) by the Hive typed signer in roughly 7 ms and returned as a self-contained envelope. Anyone can verify it offline with the public key — no secret, no callback. The receipt is the record.

## Pricing

Build tier (first 1M receipts) free. Verify always free. Full ladder at [thehiveryiq.com/sigr/](https://www.thehiveryiq.com/sigr/). Settlement in USDC on Base.

Patent Pending. Hive Civilization.
