import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, basename } from 'node:path';
import { Store } from '../server/store.ts';
import { PayPalAdapter, ProviderError } from '../server/payments.ts';
import type { Acceptance, Payment } from '../server/types.ts';

// Payment-boundary tests use an explicit accepted-record fixture and mocked HTTP,
// avoiding unrelated AI/browser work. They do not execute PayPal or hold secrets.
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'scopeproof-followup-payment-'));
  const store = new Store(directory);
  const project = store.createProject({ title: 'Payment boundary', brief: 'Accepted fixture', amount: '120.00' });
  const acceptance: Acceptance = {
    id: 'accepted-fixture', projectId: project.id, scopeId: 'scope-fixture',
    artifactId: 'artifact-fixture', hash: 'accepted-hash', amount: '120.00', currency: 'USD', createdAt: new Date().toISOString(),
  };
  store.insert('acceptance', acceptance);
  return {
    store, project, acceptance, directory,
    cleanup(current = store) {
      current.close();
      const target = realpathSync(directory), inside = relative(realpathSync(tmpdir()), target);
      if (!inside || isAbsolute(inside) || inside.startsWith('..') || !basename(target).startsWith('scopeproof-followup-payment-')) throw new Error('Unsafe temporary cleanup path.');
      rmSync(target, { recursive: true, force: true });
    },
  };
}

function provider() {
  let capturePosts = 0, createPosts = 0;
  let captureIds: string[] = [];
  let createdUnit: any;
  let phase: 'HEALTHY' | 'PRE_GET_NETWORK' | 'PRE_OAUTH_HTTP' | 'PRE_POST_OAUTH_HTTP' | 'BINDING' | 'POST_NETWORK' | 'POST_HTTP' | 'POST_GET_NETWORK' | 'PENDING' | 'MALFORMED_HISTORY' | 'MALFORMED_NULL_HISTORY' | 'NULL_CAPTURE_ENTRY' | 'MALFORMED_CAPTURE_AMOUNT' | 'COMPLETED_WITHOUT_HISTORY' | 'BINDING_WITH_CAPTURE' | 'BINDING_WITH_COMPLETED_EMPTY' | 'AMOUNT_WITH_CAPTURE' | 'MULTIUNIT_WITH_CAPTURE' = 'HEALTHY';
  let completed = false, capturePosted = false, statusObserved = false;
  const diagnostics: unknown[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/token')) {
      if (phase === 'PRE_OAUTH_HTTP' && !capturePosted) return Response.json({ name: 'RAW_PROVIDER_SECRET_NOT_FOR_DISPLAY' }, { status: 503 });
      if (phase === 'PRE_POST_OAUTH_HTTP' && statusObserved && !capturePosted) return Response.json({ name: 'RAW_PROVIDER_SECRET_NOT_FOR_DISPLAY' }, { status: 503 });
      return Response.json({ access_token: 'mock-only-token', expires_in: phase === 'PRE_POST_OAUTH_HTTP' ? 30 : 3600 });
    }
    if (url.endsWith('/v2/checkout/orders') && init?.method === 'POST') {
      createPosts++; createdUnit = JSON.parse(String(init.body)).purchase_units[0];
      return Response.json({ id: 'ORDER-FIXTURE', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/approve' }] });
    }
    if (url.endsWith('/capture')) {
      capturePosts++; capturePosted = true;
      captureIds.push((init!.headers as Record<string, string>)['PayPal-Request-Id']);
      if (phase === 'POST_NETWORK') throw new Error('Untrusted raw network details');
      if (phase === 'POST_HTTP') return Response.json({ details: [{ issue: 'INSTRUMENT_DECLINED' }], message: 'RAW_PROVIDER_SECRET_NOT_FOR_DISPLAY' }, { status: 503 });
      if (phase === 'PENDING') return Response.json({ status: 'PENDING' });
      completed = true; return Response.json({ status: 'COMPLETED' });
    }
    if (phase === 'PRE_GET_NETWORK' && !capturePosted) throw new Error('Transient preflight network failure');
    if (phase === 'POST_GET_NETWORK' && capturePosted) throw new Error('Transient retrieval failure after capture');
    const unit = structuredClone(createdUnit);
    if (phase === 'BINDING' || phase === 'BINDING_WITH_COMPLETED_EMPTY') unit.custom_id = 'unrelated-acceptance';
    if (completed || (phase === 'PENDING' && capturePosted)) unit.payments = { captures: [{ id: 'CAPTURE-FIXTURE', status: completed ? 'COMPLETED' : 'PENDING', amount: { value: '120.00', currency_code: 'USD' }, final_capture: true }] };
    if (phase === 'MALFORMED_HISTORY') unit.payments = { captures: {} };
    if (phase === 'MALFORMED_NULL_HISTORY') unit.payments = { captures: null };
    if (phase === 'NULL_CAPTURE_ENTRY') unit.payments = { captures: [null] };
    if (phase === 'MALFORMED_CAPTURE_AMOUNT') unit.payments = { captures: [{ id: 'CAPTURE-FIXTURE', status: 'PENDING', amount: { value: 'invalid-amount', currency_code: 'USD' }, final_capture: true }] };
    if (['BINDING_WITH_CAPTURE','AMOUNT_WITH_CAPTURE','MULTIUNIT_WITH_CAPTURE'].includes(phase)) {
      unit.payments = { captures: [{ id: 'CAPTURE-FIXTURE', status: 'PENDING', amount: { value: '120.00', currency_code: 'USD' }, final_capture: true }] };
      if (phase === 'BINDING_WITH_CAPTURE') unit.custom_id = 'unrelated-acceptance';
      if (phase === 'AMOUNT_WITH_CAPTURE') unit.amount.value = 'invalid-amount';
    }
    // A short-lived mock token expires before request() prepares the financial
    // POST, after the successful status response. No real network delay occurs.
    if (phase === 'PRE_POST_OAUTH_HTTP') await new Promise(resolve => setTimeout(resolve, 5));
    statusObserved = true;
    return Response.json({ id: 'ORDER-FIXTURE', status: ['COMPLETED_WITHOUT_HISTORY','BINDING_WITH_COMPLETED_EMPTY'].includes(phase) ? 'COMPLETED' : 'APPROVED', purchase_units: phase === 'MULTIUNIT_WITH_CAPTURE' ? [structuredClone(createdUnit),unit] : [unit] });
  };
  const adapter = () => new PayPalAdapter({ clientId: 'mock-id', secret: 'mock-secret', merchantId: 'MERCHANT-FIXTURE', publicUrl: 'http://localhost', diagnostic: event => diagnostics.push(event) }, fetcher);
  return {
    adapter, setPhase(value: typeof phase) { phase = value; statusObserved = false; }, complete() { completed = true; },
    get capturePosts() { return capturePosts; }, get createPosts() { return createPosts; },
    get captureIds() { return captureIds; }, get diagnostics() { return diagnostics; },
  };
}

for (const failure of ['PRE_GET_NETWORK', 'PRE_OAUTH_HTTP', 'PRE_POST_OAUTH_HTTP', 'BINDING'] as const) {
  test(`FUP001: ${failure} before capture submission remains retryable with exactly one eventual POST`, async () => {
    const f = fixture(), upstream = provider();
    try {
      const p = await f.store.createPayment(f.project.id, upstream.adapter());
      upstream.setPhase(failure);
      // Fresh adapter requires OAuth; binding/GET failures occur in capture's preflight.
      const adapter = upstream.adapter();
      const failed = await f.store.capture(p.id, adapter);
      assert.equal(upstream.capturePosts, 0);
      assert.equal(failed.status, 'ORDER_CREATED', 'failure before the financial POST must not strand an unsubmitted order as UNKNOWN');
      assert.equal(f.store.entitlement(f.project.id), undefined);
      assert.ok(!failed.error?.includes('RAW_PROVIDER_SECRET'));
      assert.equal(failed.id, p.id); assert.equal(failed.createKey, p.createKey); assert.equal(failed.captureKey, p.captureKey);
      upstream.setPhase('HEALTHY');
      const paid = await f.store.capture(p.id, adapter);
      assert.equal(paid.status, 'PAID'); assert.equal(upstream.capturePosts, 1); assert.equal(upstream.createPosts, 1);
      assert.deepEqual(upstream.captureIds, [p.captureKey]);
      assert.equal(f.store.list('payment', f.project.id).length, 1);
      assert.equal(f.store.entitlement(f.project.id).acceptance_id, f.acceptance.id);
    } finally { f.cleanup(); }
  });
}

for (const failure of ['POST_NETWORK', 'POST_HTTP', 'POST_GET_NETWORK', 'PENDING'] as const) {
  test(`FUP001: ${failure} during/after submitted capture stays UNKNOWN and repeated capture only retrieves`, async () => {
    const f = fixture(), upstream = provider();
    try {
      const adapter = upstream.adapter(), p = await f.store.createPayment(f.project.id, adapter);
      upstream.setPhase(failure);
      assert.equal((await f.store.capture(p.id, adapter)).status, 'UNKNOWN');
      assert.equal(upstream.capturePosts, 1); assert.equal(f.store.entitlement(f.project.id), undefined);
      for (let i = 0; i < 3; i++) {
        const value = await f.store.capture(p.id, adapter);
        assert.equal(value.status, 'UNKNOWN'); assert.ok(!value.error?.includes('RAW_PROVIDER_SECRET'));
      }
      assert.equal(upstream.capturePosts, 1); assert.equal(upstream.createPosts, 1);
      upstream.setPhase('HEALTHY'); upstream.complete();
      assert.equal((await f.store.capture(p.id, adapter)).status, 'PAID');
      assert.equal(upstream.capturePosts, 1);
      assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM entitlements').get() as any).n, 1);
    } finally { f.cleanup(); }
  });
}

test('FUP001: prior UNKNOWN, legacy FAILED and restart CAPTURING never become retryable from a preflight error', async () => {
  for (const previous of ['UNKNOWN', 'FAILED', 'CAPTURING'] as const) {
    const f = fixture(), upstream = provider(); let store = f.store;
    try {
      const p = await store.createPayment(f.project.id, upstream.adapter());
      store.update('payment', { ...p, status: previous }); store.close(); store = new Store(f.directory);
      assert.equal(store.get<Payment>('payment', p.id).status, 'UNKNOWN');
      const adapter = upstream.adapter(); upstream.setPhase('PRE_GET_NETWORK');
      assert.equal((await store.capture(p.id, adapter)).status, 'UNKNOWN');
      upstream.setPhase('HEALTHY');
      assert.equal((await store.capture(p.id, adapter)).status, 'UNKNOWN');
      assert.equal(upstream.capturePosts, 0);
      assert.equal(store.get<Payment>('payment', p.id).captureKey, p.captureKey);
      assert.equal(store.entitlement(f.project.id), undefined);
    } finally { f.cleanup(store); }
  }
});

test('FUP001: generic definitive error does not establish capture was NOT_SUBMITTED', async () => {
  const f = fixture(), upstream = provider();
  try {
    const adapter = upstream.adapter(), p = await f.store.createPayment(f.project.id, adapter);
    adapter.capture = async () => { throw new ProviderError('Legacy definitive HTTP classification', true); };
    assert.equal((await f.store.capture(p.id, adapter)).status, 'UNKNOWN');
    assert.equal(f.store.entitlement(f.project.id), undefined);
  } finally { f.cleanup(); }
});

for (const history of ['MALFORMED_HISTORY', 'MALFORMED_NULL_HISTORY', 'NULL_CAPTURE_ENTRY', 'MALFORMED_CAPTURE_AMOUNT', 'COMPLETED_WITHOUT_HISTORY', 'BINDING_WITH_CAPTURE', 'BINDING_WITH_COMPLETED_EMPTY', 'AMOUNT_WITH_CAPTURE', 'MULTIUNIT_WITH_CAPTURE'] as const) {
  test(`FUP001: ${history} is ambiguous financial evidence, not permission to resubmit`, async () => {
    const f = fixture(), upstream = provider();
    try {
      const adapter = upstream.adapter(), p = await f.store.createPayment(f.project.id, adapter);
      upstream.setPhase(history);
      for (let i = 0; i < 3; i++) {
        assert.equal((await f.store.capture(p.id, adapter)).status, 'UNKNOWN');
        assert.equal(upstream.capturePosts, 0); assert.equal(f.store.entitlement(f.project.id), undefined);
      }
      // A later APPROVED/no-history response cannot erase previously ambiguous
      // financial evidence or restore permission for another capture attempt.
      upstream.setPhase('HEALTHY');
      assert.equal((await f.store.capture(p.id, adapter)).status, 'UNKNOWN');
      assert.equal(upstream.capturePosts, 0); assert.equal(f.store.entitlement(f.project.id), undefined);
      upstream.complete();
      assert.equal((await f.store.reconcile(p.id, adapter)).status, 'PAID');
      assert.equal(upstream.capturePosts, 0);
      assert.equal(f.store.get<Payment>('payment', p.id).captureKey, p.captureKey);
    } finally { f.cleanup(); }
  });
}
