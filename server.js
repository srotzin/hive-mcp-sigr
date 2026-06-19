#!/usr/bin/env node
/**
 * hive-mcp-sigr — Signed inference Guarantee Receipt (SiGR™) MCP Server
 *
 * Four signing tools — sign_bill, sign_bond, sign_chain, sign_consensus —
 * plus their offline verifiers. Every receipt is signed with ML-DSA-65
 * (NIST FIPS 204) by the Hive typed signer and is verifiable offline with the
 * returned envelope. Signing the exact state an AI saw before it acted, so the
 * receipt is the record. Patent Pending. Hive Civilization.
 *
 * Streamable-HTTP, JSON-RPC 2.0, MCP 2024-11-05. Inbound only.
 * Build tier (first 1M receipts) free. MIT.
 */
import express from 'express';

const SERVICE    = 'hive-mcp-sigr';
const VERSION    = '1.0.0';
const PORT       = process.env.PORT || 3000;
const ENABLE     = (process.env.ENABLE ?? 'true') !== 'false';
const BRAND_GOLD = '#C08D23';
const SIGNER_BASE = process.env.HIVE_SIGNER_URL || 'https://hive-typed-signer.onrender.com';

const PRODUCTS = {
  bill:      { path: '/sigr/bill',      label: 'SiGR-Bill',      docket: 'HC-2026-004', arg: 'request' },
  bond:      { path: '/sigr/bond',      label: 'SiGR-Bond',      docket: 'HC-2026-005', arg: 'terms'   },
  chain:     { path: '/sigr/chain',     label: 'SiGR Chain',     docket: 'HC-2026-006', arg: 'run'     },
  consensus: { path: '/sigr/consensus', label: 'SiGR-Consensus', docket: 'HC-2026-007', arg: 'panel'   },
};
const PUBKEY_URL = `${SIGNER_BASE}/pubkey`;

// ─── Tools ──────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'sign_chain',
    description: 'Sign a multi-step agent run (the flagship SiGR product, docket HC-2026-006). Seals each step and its causal parents into one ML-DSA-65 (FIPS 204) envelope with a causal_root, so the exact ordered state the agent saw is provable after the fact. Returns the full signed envelope, verifiable offline. Pass a "run" object: {run_id, agent_ref, steps:[{step_id, kind, seq, parents[], input, output}]}. Build tier (first 1M receipts) free.',
    inputSchema: {
      type: 'object',
      properties: {
        run: {
          type: 'object',
          description: 'The agent run to seal: {run_id, agent_ref, steps:[{step_id, kind, seq, parents[], input, output}]}.',
        },
      },
      required: ['run'],
    },
  },
  {
    name: 'sign_bill',
    description: 'Sign an inference cost/billing receipt (SiGR-Bill, docket HC-2026-004). Signs token counts, backend, and per-token prices into an ML-DSA-65 (FIPS 204) envelope so usage and cost are provable, not just self-reported. Returns the signed envelope, verifiable offline. Pass a "request" object: {request_id, model_id, backend, input_tokens, output_tokens, cached_tokens, tokenizer_hash, price_input_micro_usd, price_output_micro_usd, price_cached_micro_usd}. Build tier free.',
    inputSchema: {
      type: 'object',
      properties: {
        request: {
          type: 'object',
          description: 'The billing record: {request_id, model_id, backend, input_tokens, output_tokens, cached_tokens, tokenizer_hash, price_input_micro_usd, price_output_micro_usd, price_cached_micro_usd}.',
        },
      },
      required: ['request'],
    },
  },
  {
    name: 'sign_bond',
    description: 'Sign an SLA performance bond (SiGR-Bond, docket HC-2026-005). Signs latency ceiling, uptime floor, tolerance, and penalty terms into an ML-DSA-65 (FIPS 204) envelope so the committed SLA is provable when a measurement window closes. Returns the signed envelope, verifiable offline. Pass a "terms" object: {bond_id, customer_ref, service_ref, window_start, window_end, latency_ceiling_ms, uptime_floor_ppm, slow_tolerance_ppm, penalty_micro_usd}. Build tier free.',
    inputSchema: {
      type: 'object',
      properties: {
        terms: {
          type: 'object',
          description: 'The bond terms: {bond_id, customer_ref, service_ref, window_start, window_end, latency_ceiling_ms, uptime_floor_ppm, slow_tolerance_ppm, penalty_micro_usd}.',
        },
      },
      required: ['terms'],
    },
  },
  {
    name: 'sign_consensus',
    description: 'Sign a model-panel verdict (SiGR-Consensus, docket HC-2026-007). Signs each panel member output digest and score plus the aggregation method into an ML-DSA-65 (FIPS 204) envelope so a multi-model decision is provable. Returns the signed envelope, verifiable offline. Pass "panel" {panel_id}, "method", and "members" [{panel_id, model_id, output_digest, score, seq}]. Build tier free.',
    inputSchema: {
      type: 'object',
      properties: {
        panel:   { type: 'object', description: 'Panel descriptor: {panel_id}.' },
        method:  { type: 'string', description: 'Aggregation method, e.g. "majority".' },
        members: {
          type: 'array',
          description: 'Panel members [{panel_id, model_id, output_digest, score, seq}].',
          items: { type: 'object' },
        },
      },
      required: ['panel', 'method', 'members'],
    },
  },
  {
    name: 'verify_receipt',
    description: 'Verify a signed SiGR receipt offline (always free). Pass the product ("bill" | "bond" | "chain" | "consensus") and the "envelope" object returned by the matching sign tool. Returns {valid, reasons[], ...}. No secret required — anyone can verify with the public key.',
    inputSchema: {
      type: 'object',
      properties: {
        product:  { type: 'string', enum: ['bill', 'bond', 'chain', 'consensus'], description: 'Which SiGR product the envelope came from.' },
        envelope: { type: 'object', description: 'The signed envelope returned by the matching sign tool.' },
      },
      required: ['product', 'envelope'],
    },
  },
  {
    name: 'get_pubkey',
    description: 'Get the Hive typed-signer public key and algorithm metadata for offline verification (free). Returns the ML-DSA-65 (NIST FIPS 204) public key, issuer DID, and spec.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callSigner(path, body) {
  const r = await fetch(`${SIGNER_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(`signer ${path} -> ${r.status}: ${typeof data === 'object' ? JSON.stringify(data) : text}`);
  return data;
}

async function executeTool(name, args) {
  // Sign tools
  if (name === 'sign_chain') {
    if (!args.run || typeof args.run !== 'object') throw new Error('Provide a "run" object.');
    const data = await callSigner(PRODUCTS.chain.path, { run: args.run });
    return { type: 'text', text: JSON.stringify(data, null, 2) };
  }
  if (name === 'sign_bill') {
    if (!args.request || typeof args.request !== 'object') throw new Error('Provide a "request" object.');
    const data = await callSigner(PRODUCTS.bill.path, { request: args.request });
    return { type: 'text', text: JSON.stringify(data, null, 2) };
  }
  if (name === 'sign_bond') {
    if (!args.terms || typeof args.terms !== 'object') throw new Error('Provide a "terms" object.');
    const data = await callSigner(PRODUCTS.bond.path, { terms: args.terms });
    return { type: 'text', text: JSON.stringify(data, null, 2) };
  }
  if (name === 'sign_consensus') {
    if (!args.panel || !Array.isArray(args.members)) throw new Error('Provide "panel", "method", and "members[]".');
    const body = { panel: args.panel, method: args.method ?? 'majority', members: args.members };
    const data = await callSigner(PRODUCTS.consensus.path, body);
    return { type: 'text', text: JSON.stringify(data, null, 2) };
  }
  // Verify
  if (name === 'verify_receipt') {
    const p = PRODUCTS[args.product];
    if (!p) throw new Error('product must be one of: bill, bond, chain, consensus.');
    if (!args.envelope || typeof args.envelope !== 'object') throw new Error('Provide the "envelope" object.');
    const data = await callSigner(`${p.path}/verify`, { envelope: args.envelope });
    return { type: 'text', text: JSON.stringify(data, null, 2) };
  }
  // Pubkey
  if (name === 'get_pubkey') {
    const r = await fetch(PUBKEY_URL, { signal: AbortSignal.timeout(15_000) });
    const data = await r.json();
    return { type: 'text', text: JSON.stringify(data, null, 2) };
  }
  throw new Error(`Unknown tool: ${name}`);
}

// ─── HTTP / MCP ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '8mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: SERVICE, version: VERSION, enabled: ENABLE }));

app.get('/', (_req, res) => res.json({
  service: SERVICE,
  version: VERSION,
  description: 'Signed inference Guarantee Receipt (SiGR) MCP server. Sign agent runs, billing, SLA bonds, and model-panel verdicts with ML-DSA-65 (FIPS 204). The receipt is the record. Patent Pending. Hive Civilization.',
  endpoints: { mcp: '/mcp', well_known: '/.well-known/mcp.json', health: '/health' },
  upstream: SIGNER_BASE,
  products: Object.fromEntries(Object.entries(PRODUCTS).map(([k, v]) => [k, { label: v.label, docket: v.docket, endpoint: v.path }])),
  brand_color: BRAND_GOLD,
}));

app.post('/mcp', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};
  if (jsonrpc !== '2.0') {
    return res.status(400).json({ jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } });
  }
  try {
    switch (method) {
      case 'initialize':
        return res.json({
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVICE, version: VERSION, description: 'Signed inference Guarantee Receipt (SiGR). ML-DSA-65 signed, verifiable offline. Patent Pending. Hive Civilization.' },
          },
        });
      case 'tools/list':
        return res.json({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      case 'tools/call': {
        const { name, arguments: args } = params || {};
        if (!ENABLE) return res.json({ jsonrpc: '2.0', id, error: { code: 503, message: 'service_disabled' } });
        try {
          const out = await executeTool(name, args || {});
          return res.json({ jsonrpc: '2.0', id, result: { content: [out] } });
        } catch (err) {
          return res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: err.message } });
        }
      }
      case 'ping':
        return res.json({ jsonrpc: '2.0', id, result: {} });
      default:
        return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    return res.json({ jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message: err.message } });
  }
});

app.get('/.well-known/mcp.json', (_req, res) => res.json({
  name: SERVICE,
  version: VERSION,
  protocol: '2024-11-05',
  transport: 'streamable-http',
  endpoint: '/mcp',
  description: 'Signed inference Guarantee Receipt (SiGR). Sign agent runs, billing, SLA bonds, model-panel verdicts with ML-DSA-65 (FIPS 204). Verifiable offline. Patent Pending. Hive Civilization.',
  tools: TOOLS.map(t => ({ name: t.name, description: t.description })),
  brand_color: BRAND_GOLD,
}));

app.get('/.well-known/agent.json', (_req, res) => res.json({
  name: SERVICE,
  description: 'Signed inference Guarantee Receipt surface for the Hive agent economy. Every receipt ML-DSA-65 signed (FIPS 204) and verifiable offline.',
  url: `https://${SERVICE}.onrender.com`,
  provider: { organization: 'Hive Civilization', url: 'https://www.thehiveryiq.com', contact: 'steve@thehiveryiq.com' },
  capabilities: ['signed-receipts', 'agent-run-sealing', 'sla-bonds', 'consensus-verdicts', 'provenance'],
  tools: TOOLS.map(t => t.name),
  brand_color: BRAND_GOLD,
}));

if (!ENABLE) console.log(`[${SERVICE}] ENABLE=false — dormant (health only)`);

app.listen(PORT, () => console.log(`[${SERVICE}] v${VERSION} listening on :${PORT} -> ${SIGNER_BASE}`));
