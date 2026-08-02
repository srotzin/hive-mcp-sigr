#!/usr/bin/env node
/**
 * hive-mcp-sigr: Signed inference Guarantee Receipt (SiGR™) MCP Server
 *
 * Signing tools for the SiGR product family plus their offline verifiers.
 * Every receipt is signed with ML-DSA-65 (NIST FIPS 204) by the Hive typed
 * signer and is verifiable offline with the returned envelope. Signing the
 * exact state an AI saw before it acted, so the receipt is the record.
 * Patent Pending. Hive Civilization.
 *
 * Streamable-HTTP, JSON-RPC 2.0, MCP 2024-11-05. Inbound only.
 * Build tier (first 1M receipts) free. MIT.
 *
 * Tool set is reconciled against the live upstream signer's advertised
 * routes (GET / on HIVE_SIGNER_URL). We only expose a tool here if the
 * matching upstream POST route actually exists. See README "Tool <->
 * upstream route map" for the audit trail.
 */
import express from 'express';

const SERVICE    = 'hive-mcp-sigr';
const VERSION    = '1.1.0';
const PORT       = process.env.PORT || 3000;
const ENABLE     = (process.env.ENABLE ?? 'true') !== 'false';
const BRAND_GOLD = '#C08D23';
const SIGNER_BASE = process.env.HIVE_SIGNER_URL || 'https://hive-typed-signer.onrender.com';

// ─── Environment validation (fail closed) ──────────────────────────────────
// A malformed HIVE_SIGNER_URL would silently break every tool call at
// request time. Validate eagerly at boot and refuse to serve traffic on a
// bad config instead of returning confusing per-call errors forever.
function validateEnv() {
  const errors = [];
  try {
    const u = new URL(SIGNER_BASE);
    if (!/^https?:$/.test(u.protocol)) errors.push(`HIVE_SIGNER_URL must be http(s): got "${SIGNER_BASE}"`);
  } catch {
    errors.push(`HIVE_SIGNER_URL is not a valid URL: "${SIGNER_BASE}"`);
  }
  const portNum = Number(PORT);
  if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) {
    errors.push(`PORT must be a valid TCP port: got "${PORT}"`);
  }
  return errors;
}

const ENV_ERRORS = validateEnv();
if (ENV_ERRORS.length > 0) {
  console.error(`[${SERVICE}] FATAL: invalid environment, refusing to start:`);
  for (const e of ENV_ERRORS) console.error(`  - ${e}`);
  process.exit(1);
}

// Real upstream product routes (verified live against hive-typed-signer):
//   POST /sigr/bill        POST /sigr/bill/verify
//   POST /sigr/bond        POST /sigr/bond/verify
//   POST /sigr/chain       POST /sigr/chain/verify
//   POST /sigr/consensus   POST /sigr/consensus/verify
//   POST /sigr/mir         POST /sigr/mir/verify
//   POST /sigr/upstream/gate     (GET /sigr/upstream = catalog)
//   POST /sigr/gca         POST /sigr/gca/verify
//   POST /sigr/gitm        POST /sigr/gitm/verify
//   POST /sigr/cachesign   POST /sigr/cachesign/verify
//   POST /sigr/manifest    POST /sigr/manifest/verify
//   GET  /pubkey
// Every tool below maps 1:1 to a route in this list. No advertised tool may
// call a path that isn't in this list.
const PRODUCTS = {
  bill:      { path: '/sigr/bill',      label: 'SiGR-Bill',      docket: 'HC-2026-004', arg: 'request' },
  bond:      { path: '/sigr/bond',      label: 'SiGR-Bond',      docket: 'HC-2026-005', arg: 'terms'   },
  chain:     { path: '/sigr/chain',     label: 'SiGR Chain',     docket: 'HC-2026-006', arg: 'run'     },
  consensus: { path: '/sigr/consensus', label: 'SiGR-Consensus', docket: 'HC-2026-007', arg: 'panel'   },
  mir:       { path: '/sigr/mir',       label: 'MiR',            docket: 'HC-2026-023', arg: 'mir'     },
  gca:       { path: '/sigr/gca',       label: 'GCA',            docket: 'HC-2026-024', arg: 'grounding_claims' },
  gitm:      { path: '/sigr/gitm',      label: 'GiTM',           docket: 'HC-2026-025', arg: 'gitm'    },
  cachesign: { path: '/sigr/cachesign', label: 'AFiR KV Cache Signing', docket: 'HC-2026-026', arg: 'cache' },
  manifest:  { path: '/sigr/manifest',  label: 'AFiR Model Manifest',   docket: 'HC-2026-027', arg: 'manifest' },
};
const PUBKEY_URL = `${SIGNER_BASE}/pubkey`;
const GATE_PATH = '/sigr/upstream/gate';
const UPSTREAM_CATALOG_PATH = '/sigr/upstream';

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
    name: 'sign_mir',
    description: 'Sign a Model-Identity & Relineage receipt (MiR, docket HC-2026-023). Binds the served-model lineage across steps and detects substitution. Asserts identity only, not correctness. Returns the signed envelope, verifiable offline. Pass a "mir" object: {subject_id?, expected_model?, steps:[{model_id, weights_sha3, config_hash, endpoint, manifest_nullifier?}]}.',
    inputSchema: {
      type: 'object',
      properties: {
        mir: {
          type: 'object',
          description: 'MiR payload: {subject_id?, expected_model?, steps:[{model_id, weights_sha3, config_hash, endpoint, manifest_nullifier?}]}.',
        },
      },
      required: ['mir'],
    },
  },
  {
    name: 'sign_gca',
    description: 'Sign a Grounding-Claim Attestation (GCA, docket HC-2026-024). Per-claim receipt that proves a claim was supported by cited evidence at generation time. Proves support, not truth. Pass a "grounding_claims" object: {method_hash, answer_id?, claims:[{claim_id?, claim?|claim_hash, support:"0x..."|null, support_strength?|support_strength_bp?}]}.',
    inputSchema: {
      type: 'object',
      properties: {
        grounding_claims: {
          type: 'object',
          description: '{method_hash, answer_id?, claims:[{claim_id?, claim?|claim_hash, support:"0x..."|null, support_strength?|support_strength_bp?}]}.',
        },
      },
      required: ['grounding_claims'],
    },
  },
  {
    name: 'sign_gitm',
    description: 'Sign a Ghost-in-the-Machine cross-signal anomaly flag (GiTM, docket HC-2026-025). Asserts a provenance anomaly only, not a verdict of misbehavior. Pass a "gitm" object: {subject_id?, claims_root_ref?, signals:{grounding_anomaly, identity_flicker, chain_irregularity, cross_run_divergence, under_attested_high_stakes}, trigger_bp?}, or pass "mir_receipt" to source identity_flicker from a signed MiR receipt.',
    inputSchema: {
      type: 'object',
      properties: {
        gitm: { type: 'object', description: '{subject_id?, claims_root_ref?, signals:{...}, trigger_bp?}.' },
        mir_receipt: { type: 'object', description: 'Optional signed MiR receipt to source identity_flicker from.' },
      },
      required: [],
    },
  },
  {
    name: 'sign_cachesign',
    description: 'Sign a KV-cache write receipt (AFiR KV Cache Signing, docket HC-2026-026). Signs vLLM prefix cache entries at write time so cache reuse across requests is provable. Pass a "cache" object: {model_id, prefix_hash, block_ids?:[], token_span?:{start,end}, parent_cache_receipt?}.',
    inputSchema: {
      type: 'object',
      properties: {
        cache: { type: 'object', description: '{model_id, prefix_hash, block_ids?:[], token_span?:{start,end}, parent_cache_receipt?}.' },
      },
      required: ['cache'],
    },
  },
  {
    name: 'sign_manifest',
    description: 'Sign a streaming model manifest (AFiR Model Manifest, docket HC-2026-027). TEE-less attestation of which model weights/config are actually being served. Pass a "manifest" object: {model_id, weights_sha3, config_hash, endpoint, nullifier?}.',
    inputSchema: {
      type: 'object',
      properties: {
        manifest: { type: 'object', description: '{model_id, weights_sha3, config_hash, endpoint, nullifier?}.' },
      },
      required: ['manifest'],
    },
  },
  {
    name: 'verify_receipt',
    description: 'Verify a signed SiGR receipt offline (always free). Pass the product ("bill" | "bond" | "chain" | "consensus" | "mir" | "gca" | "gitm" | "cachesign" | "manifest") and the "envelope" object returned by the matching sign tool. Returns {valid, reasons[], ...}. No secret required; anyone can verify with the public key.',
    inputSchema: {
      type: 'object',
      properties: {
        product:  { type: 'string', enum: Object.keys(PRODUCTS), description: 'Which SiGR product the envelope came from.' },
        envelope: { type: 'object', description: 'The signed envelope returned by the matching sign tool.' },
      },
      required: ['product', 'envelope'],
    },
  },
  {
    name: 'upstream_gate',
    description: 'Refuse an action unless every required upstream pre-effect receipt verifies fresh (docket HC-2026-016 through HC-2026-022 suite; endpoint POST /sigr/upstream/gate). Pass "required": [{type, receipt}, ...] where type is one of the fifteen upstream receipt types (e.g. pbs.manifest, refusal.mutation, howler.drift, perimeter.attempt, diurnal.attestation, egress.measurement, forensic.analysis). Use get_upstream_catalog to see the full list of types and their body shapes before calling this.',
    inputSchema: {
      type: 'object',
      properties: {
        required: {
          type: 'array',
          description: 'Array of {type, receipt} pairs, one per required upstream pre-effect receipt.',
          items: { type: 'object' },
        },
      },
      required: ['required'],
    },
  },
  {
    name: 'get_upstream_catalog',
    description: 'Get the Upstream Signed Pre-Effect Attestation (USAP) catalog: the seven pre-effect primitives (Provenance-Bonded Sandbox, Refusal Ledger, Howler, Perimeter Bond, Diurnal Bond, Egress Bond, Forensic Rail), their fifteen receipt types, sign/verify routes, TTLs, and body shapes. Free. Read this before calling upstream_gate.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_pubkey',
    description: 'Get the Hive typed-signer public key and algorithm metadata for offline verification (free). Returns the ML-DSA-65 (NIST FIPS 204) public key, issuer DID, and spec.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callSigner(path, body, method = 'POST') {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
  };
  if (method !== 'GET') opts.body = JSON.stringify(body ?? {});
  const r = await fetch(`${SIGNER_BASE}${path}`, opts);
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
  if (name === 'sign_mir') {
    if (!args.mir || typeof args.mir !== 'object') throw new Error('Provide a "mir" object.');
    const data = await callSigner(PRODUCTS.mir.path, { mir: args.mir });
    return { type: 'text', text: JSON.stringify(data, null, 2) };
  }
  if (name === 'sign_gca') {
    if (!args.grounding_claims || typeof args.grounding_claims !== 'object') throw new Error('Provide a "grounding_claims" object.');
    const data = await callSigner(PRODUCTS.gca.path, { grounding_claims: args.grounding_claims });
    return { type: 'text', text: JSON.stringify(data, null, 2) };
  }
  if (name === 'sign_gitm') {
    if (!args.gitm && !args.mir_receipt) throw new Error('Provide a "gitm" object or a "mir_receipt".');
    const body = {};
    if (args.gitm) body.gitm = args.gitm;
    if (args.mir_receipt) body.mir_receipt = args.mir_receipt;
    const data = await callSigner(PRODUCTS.gitm.path, body);
    return { type: 'text', text: JSON.stringify(data, null, 2) };
  }
  if (name === 'sign_cachesign') {
    if (!args.cache || typeof args.cache !== 'object') throw new Error('Provide a "cache" object.');
    const data = await callSigner(PRODUCTS.cachesign.path, { cache: args.cache });
    return { type: 'text', text: JSON.stringify(data, null, 2) };
  }
  if (name === 'sign_manifest') {
    if (!args.manifest || typeof args.manifest !== 'object') throw new Error('Provide a "manifest" object.');
    const data = await callSigner(PRODUCTS.manifest.path, { manifest: args.manifest });
    return { type: 'text', text: JSON.stringify(data, null, 2) };
  }
  // Verify
  if (name === 'verify_receipt') {
    const p = PRODUCTS[args.product];
    if (!p) throw new Error(`product must be one of: ${Object.keys(PRODUCTS).join(', ')}.`);
    if (!args.envelope || typeof args.envelope !== 'object') throw new Error('Provide the "envelope" object.');
    const data = await callSigner(`${p.path}/verify`, { envelope: args.envelope });
    return { type: 'text', text: JSON.stringify(data, null, 2) };
  }
  // Upstream pre-effect gate
  if (name === 'upstream_gate') {
    if (!Array.isArray(args.required)) throw new Error('Provide "required": [{type, receipt}, ...].');
    const data = await callSigner(GATE_PATH, { required: args.required });
    return { type: 'text', text: JSON.stringify(data, null, 2) };
  }
  if (name === 'get_upstream_catalog') {
    const data = await callSigner(UPSTREAM_CATALOG_PATH, null, 'GET');
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
  description: 'Signed inference Guarantee Receipt (SiGR) MCP server. Sign agent runs, billing, SLA bonds, model-panel verdicts, model-identity relineage, grounding attestations, anomaly flags, cache signing, and model manifests with ML-DSA-65 (FIPS 204). The receipt is the record. Patent Pending. Hive Civilization.',
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
  description: 'Signed inference Guarantee Receipt (SiGR). Sign agent runs, billing, SLA bonds, model-panel verdicts, model-identity relineage, grounding attestations, anomaly flags, cache signing, and model manifests with ML-DSA-65 (FIPS 204). Verifiable offline. Patent Pending. Hive Civilization.',
  tools: TOOLS.map(t => ({ name: t.name, description: t.description })),
  brand_color: BRAND_GOLD,
}));

app.get('/.well-known/agent.json', (_req, res) => res.json({
  name: SERVICE,
  description: 'Signed inference Guarantee Receipt surface for the Hive agent economy. Every receipt ML-DSA-65 signed (FIPS 204) and verifiable offline.',
  url: `https://${SERVICE}.onrender.com`,
  provider: { organization: 'Hive Civilization', url: 'https://www.thehiveryiq.com', contact: 'steve@thehiveryiq.com' },
  capabilities: ['signed-receipts', 'agent-run-sealing', 'sla-bonds', 'consensus-verdicts', 'model-identity-relineage', 'grounding-attestation', 'anomaly-flagging', 'cache-signing', 'model-manifest', 'upstream-pre-effect-gate', 'provenance'],
  tools: TOOLS.map(t => t.name),
  brand_color: BRAND_GOLD,
}));

// Honest 404: no fabricated success on unknown routes.
app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.path, service: SERVICE });
});

if (!ENABLE) console.log(`[${SERVICE}] ENABLE=false (dormant, health only)`);

app.listen(PORT, () => console.log(`[${SERVICE}] v${VERSION} listening on :${PORT} -> ${SIGNER_BASE}`));
