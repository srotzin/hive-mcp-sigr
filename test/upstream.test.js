// Test suite for hive-mcp-sigr upstream fail-closed behavior.
//
// Uses Node's built in test runner and assert module (no new dependency).
// Run with: npm test (invokes `node --test test/`)
//
// The relay must never fabricate or pass through a success result the
// upstream signer did not actually produce. These tests stub the global
// fetch used by server.js (callSigner and get_pubkey both call the global
// fetch) so no real network call to hive-typed-signer.onrender.com happens
// from this suite.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.HIVE_SIGNER_URL = process.env.HIVE_SIGNER_URL || 'https://hive-typed-signer.example.invalid';

let app;
let server;
let baseUrl;
let originalFetch;

before(async () => {
  originalFetch = globalThis.fetch;
  const mod = await import('../server.js');
  app = mod.default;
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  globalThis.fetch = originalFetch;
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function jrpc(method, params) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

async function callTool(name, args) {
  return jrpc('tools/call', { name, arguments: args });
}

const SAMPLE_RUN = {
  run_id: 'run-1',
  agent_ref: 'agent-1',
  steps: [{ step_id: 's1', kind: 'tool_call', seq: 1, parents: [], input: {}, output: {} }],
};

// Only intercepts calls aimed at the upstream signer (HIVE_SIGNER_URL);
// calls to the local test server (baseUrl, used by jrpc()/fetch() in the
// tests themselves) pass through to the real network stack untouched.
function stubFetchOnce(handler) {
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith(baseUrl)) return originalFetch(url, opts);
    return handler(String(url), opts);
  };
}

// ─── positive path ──────────────────────────────────────────────────────────

test('sign_chain: well formed upstream 2xx JSON response is relayed as the tool result', async () => {
  const envelope = { envelope: { sig: 'abc' }, fragments_canon: [{ text_hash: 'deadbeef' }] };
  stubFetchOnce(async () => new Response(JSON.stringify(envelope), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const { body } = await callTool('sign_chain', { run: SAMPLE_RUN });
  assert.ok(body.result, 'expected a JSON-RPC result, not an error, for a valid upstream response');
  const parsed = JSON.parse(body.result.content[0].text);
  assert.deepEqual(parsed, envelope);
});

test('get_pubkey: well formed upstream 2xx JSON response is relayed as the tool result', async () => {
  const pubkey = { pubkey: 'deadbeef', algorithm: 'ML-DSA-65' };
  stubFetchOnce(async () => new Response(JSON.stringify(pubkey), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const { body } = await callTool('get_pubkey', {});
  assert.ok(body.result, 'expected a JSON-RPC result for a healthy pubkey endpoint');
  const parsed = JSON.parse(body.result.content[0].text);
  assert.deepEqual(parsed, pubkey);
});

// ─── upstream non-2xx ───────────────────────────────────────────────────────

test('sign_chain: upstream non-2xx fails closed with an honest error, never a success shape', async () => {
  stubFetchOnce(async () => new Response(JSON.stringify({ error: 'signer overloaded' }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
  const { body } = await callTool('sign_chain', { run: SAMPLE_RUN });
  assert.ok(body.error, 'a 503 from the signer must never produce a JSON-RPC success result');
  assert.match(body.error.message, /503/);
});

test('get_pubkey: upstream non-2xx fails closed and does not return the error body as a pubkey', async () => {
  stubFetchOnce(async () => new Response(JSON.stringify({ error: 'internal error', code: 'boom' }), { status: 500, headers: { 'Content-Type': 'application/json' } }));
  const { body } = await callTool('get_pubkey', {});
  assert.ok(body.error, 'a 500 from /pubkey must never be relayed as a successful pubkey result');
  assert.match(body.error.message, /500/);
});

// ─── upstream non-JSON body ─────────────────────────────────────────────────

test('sign_chain: upstream 2xx non-JSON body fails closed instead of wrapping raw text as a signed envelope', async () => {
  stubFetchOnce(async () => new Response('<html>not json</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
  const { body } = await callTool('sign_chain', { run: SAMPLE_RUN });
  assert.ok(body.error, 'a non-JSON 200 body must never be fabricated into a signed envelope result');
  assert.match(body.error.message, /non-JSON/);
});

test('get_pubkey: upstream 2xx non-JSON body fails closed', async () => {
  stubFetchOnce(async () => new Response('not json at all', { status: 200, headers: { 'Content-Type': 'text/plain' } }));
  const { body } = await callTool('get_pubkey', {});
  assert.ok(body.error, 'a non-JSON pubkey body must not be relayed as a successful pubkey result');
  assert.match(body.error.message, /non-JSON/);
});

// ─── upstream empty body ────────────────────────────────────────────────────

test('sign_chain: upstream 2xx empty body fails closed instead of returning an empty envelope', async () => {
  stubFetchOnce(async () => new Response('', { status: 200 }));
  const { body } = await callTool('sign_chain', { run: SAMPLE_RUN });
  assert.ok(body.error, 'an empty 200 body must never be treated as a successful signed envelope');
  assert.match(body.error.message, /empty body/);
});

test('get_pubkey: upstream 2xx empty body fails closed', async () => {
  stubFetchOnce(async () => new Response('', { status: 200 }));
  const { body } = await callTool('get_pubkey', {});
  assert.ok(body.error, 'an empty pubkey body must never be relayed as a successful pubkey result');
  assert.match(body.error.message, /empty body/);
});

// ─── upstream unreachable / network error ───────────────────────────────────

test('sign_chain: unreachable upstream fails closed with an honest error', async () => {
  stubFetchOnce(async () => { throw new Error('getaddrinfo ENOTFOUND hive-typed-signer.example.invalid'); });
  const { body } = await callTool('sign_chain', { run: SAMPLE_RUN });
  assert.ok(body.error, 'a network failure must never produce a fabricated success result');
  assert.match(body.error.message, /unreachable/);
});

test('get_pubkey: unreachable upstream fails closed with an honest error', async () => {
  stubFetchOnce(async () => { throw new Error('network error'); });
  const { body } = await callTool('get_pubkey', {});
  assert.ok(body.error, 'a network failure on /pubkey must never produce a fabricated success result');
});

test('verify_receipt: unreachable upstream fails closed', async () => {
  stubFetchOnce(async () => { throw new Error('connect ETIMEDOUT'); });
  const { body } = await callTool('verify_receipt', { product: 'bill', envelope: { any: 'thing' } });
  assert.ok(body.error);
});

test('upstream_gate: unreachable upstream fails closed', async () => {
  stubFetchOnce(async () => { throw new Error('connect ETIMEDOUT'); });
  const { body } = await callTool('upstream_gate', { required: [{ type: 'pbs.manifest', receipt: {} }] });
  assert.ok(body.error);
});

test('get_upstream_catalog: unreachable upstream fails closed', async () => {
  stubFetchOnce(async () => { throw new Error('connect ETIMEDOUT'); });
  const { body } = await callTool('get_upstream_catalog', {});
  assert.ok(body.error);
});

// ─── fabricated-success regression ──────────────────────────────────────────

test('regression: a non-2xx response body that itself looks success-shaped must still fail closed', async () => {
  // Guards against a relay that checks the body shape (e.g. presence of an
  // "envelope" key) instead of the actual HTTP status. If someone
  // reintroduced that shortcut, this response would be wrongly accepted.
  const successShapedButFailed = { envelope: { sig: 'forged' }, fragments_canon: [{ text_hash: 'ff' }], ok: true };
  stubFetchOnce(async () => new Response(JSON.stringify(successShapedButFailed), { status: 500, headers: { 'Content-Type': 'application/json' } }));
  const { body } = await callTool('sign_chain', { run: SAMPLE_RUN });
  assert.ok(body.error, 'a success-shaped body accompanying a 500 status must still fail closed');
  assert.equal(body.result, undefined);
});

test('regression: verify_receipt never reports valid on a broken upstream', async () => {
  stubFetchOnce(async () => new Response('Service Unavailable', { status: 503 }));
  const { body } = await callTool('verify_receipt', { product: 'bill', envelope: { any: 'thing' } });
  assert.ok(body.error);
  assert.equal(body.result, undefined, 'verify_receipt must not synthesize a {valid:...} result when the upstream call itself failed');
});

// ─── input validation still applies before any upstream call ──────────────

test('sign_chain: missing run object is rejected before contacting the upstream', async () => {
  let fetchCalled = false;
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith(baseUrl)) return originalFetch(url, opts);
    fetchCalled = true;
    return new Response('{}', { status: 200 });
  };
  const { body } = await callTool('sign_chain', {});
  assert.ok(body.error);
  assert.equal(fetchCalled, false, 'invalid input must be rejected before any upstream network call');
});

test('unknown tool name returns a JSON-RPC error, not a fabricated result', async () => {
  const { body } = await callTool('sign_does_not_exist', {});
  assert.ok(body.error);
  assert.equal(body.error.code, -32000);
});

test('unknown MCP method returns method_not_found', async () => {
  const { body } = await jrpc('does/not/exist', {});
  assert.equal(body.error.code, -32601);
});

test('GET /health reports service status without contacting the upstream', async () => {
  const res = await fetch(`${baseUrl}/health`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'hive-mcp-sigr');
});

test('unknown route returns a real 404, not a fabricated 200', async () => {
  const res = await fetch(`${baseUrl}/this-path-does-not-exist`);
  const body = await res.json();
  assert.equal(res.status, 404);
  assert.equal(body.error, 'not_found');
});

test('user facing text has no em dash, en dash, or double hyphen', async () => {
  const paths = ['/health', '/.well-known/mcp.json', '/.well-known/agent.json'];
  for (const path of paths) {
    const res = await fetch(`${baseUrl}${path}`);
    const text = await res.text();
    assert.ok(!text.includes('\u2014'), `${path} must not contain an em dash`);
    assert.ok(!text.includes('\u2013'), `${path} must not contain an en dash`);
  }
});
