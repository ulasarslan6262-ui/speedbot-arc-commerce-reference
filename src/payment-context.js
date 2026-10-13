import { randomUUID, createHash } from 'node:crypto';
import { paymentNetwork, nonzeroAddress, PAYMENT_FLOWS } from './payment-networks.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const error = code => { throw Object.assign(Error(code), { code }); };
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const states = new Set(['prepared', 'submitting', 'pending', 'settled', 'delivered', 'refund_pending', 'refunded', 'failed']);
const transitions = { prepared: ['submitting', 'failed'], submitting: ['pending', 'settled'], pending: ['settled', 'failed'], settled: ['delivered', 'refund_pending'], delivered: ['refund_pending'], refund_pending: ['refunded'], refunded: [], failed: [] };

// An additive, independent ledger. Legacy Base tables retain their original
// rows and recovery semantics; adapters opt in only once their full flow is
// verified. No backfill invents a historical provider or receiver.
export function createPaymentContext(store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS payment_operations_v2 (
    id TEXT PRIMARY KEY, operation_key TEXT NOT NULL UNIQUE, flow TEXT NOT NULL, owner_id TEXT NOT NULL,
    network TEXT NOT NULL, token TEXT NOT NULL, provider TEXT NOT NULL, receiver TEXT NOT NULL,
    payer TEXT NOT NULL, nonce TEXT NOT NULL, amount TEXT NOT NULL, terms TEXT NOT NULL, terms_hash TEXT NOT NULL,
    state TEXT NOT NULL, provider_payment_id TEXT, transaction_hash TEXT, receipt TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(network,token,payer,nonce));
    CREATE UNIQUE INDEX IF NOT EXISTS payment_v2_transaction ON payment_operations_v2(network,transaction_hash) WHERE transaction_hash IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS payment_v2_pro_pending ON payment_operations_v2(owner_id) WHERE flow='pro' AND state IN ('prepared','submitting','pending');
    CREATE TABLE IF NOT EXISTS payment_operation_events_v2 (id INTEGER PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES payment_operations_v2(id),state TEXT NOT NULL,evidence TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS payment_v2_identity_immutable BEFORE UPDATE OF operation_key,flow,owner_id,network,token,provider,receiver,payer,nonce,amount,terms,terms_hash ON payment_operations_v2 BEGIN SELECT RAISE(ABORT,'payment_identity_immutable'); END;
    CREATE TABLE IF NOT EXISTS payment_budgets_v2 (network TEXT NOT NULL,token TEXT NOT NULL,wallet TEXT NOT NULL,bucket TEXT NOT NULL,allocated TEXT NOT NULL DEFAULT '0',PRIMARY KEY(network,token,wallet,bucket));
    CREATE TABLE IF NOT EXISTS payment_budget_entries_v2 (allocation_key TEXT PRIMARY KEY,network TEXT NOT NULL,token TEXT NOT NULL,wallet TEXT NOT NULL,bucket TEXT NOT NULL,amount TEXT NOT NULL,source TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS payment_reservations_v2 (id TEXT PRIMARY KEY,network TEXT NOT NULL,token TEXT NOT NULL,wallet TEXT NOT NULL,bucket TEXT NOT NULL,amount TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL);`);
  const get = id => store.q('SELECT * FROM payment_operations_v2 WHERE id=?', id);
  function prepare(input) {
    const config = paymentNetwork(input.network);
    if (!PAYMENT_FLOWS.includes(input.flow) || !/^[a-zA-Z0-9:_-]{1,200}$/.test(input.operationKey ?? '') || !input.ownerId || !input.provider || !nonzeroAddress(input.receiver) || !nonzeroAddress(input.payer) || !/^0x[a-fA-F0-9]{64}$/.test(input.nonce ?? '') || !/^[1-9]\d*$/.test(input.amount ?? '')) error('invalid_payment_context');
    if (typeof (input.contractTerms ?? '') !== 'string' || (input.contractTerms ?? '').length > 16384) error('invalid_contract_terms');
    const terms = canonical({ network: config.network, token: config.token.toLowerCase(), provider: input.provider, receiver: input.receiver.toLowerCase(), payer: input.payer.toLowerCase(), amount: input.amount, fee_bps: input.feeBps ?? 0, policy_version: input.policyVersion ?? '1', fulfillment_id: input.fulfillmentId ?? input.operationKey, contract_terms: input.contractTerms ?? '' });
    if (!Number.isInteger(input.feeBps ?? 0) || (input.feeBps ?? 0) < 0 || (input.feeBps ?? 0) > 10000) error('invalid_fee');
    return store.tx(() => {
      const previous = store.q('SELECT * FROM payment_operations_v2 WHERE operation_key=?', input.operationKey);
      if (previous) {
        if (previous.terms_hash !== digest(terms) || previous.owner_id !== input.ownerId || previous.flow !== input.flow || previous.nonce !== input.nonce.toLowerCase()) error('payment_context_changed');
        return previous;
      }
      if (input.flow === 'pro' && (store.getAgent(input.ownerId).paid_at || store.getAgent(input.ownerId).pro_granted_at || store.q("SELECT 1 FROM payments WHERE agent_id=? AND state='pending'", input.ownerId))) error('pro_already_paid_or_pending');
      const id = 'pay_' + randomUUID().replaceAll('-', '');
      store.run("INSERT INTO payment_operations_v2(id,operation_key,flow,owner_id,network,token,provider,receiver,payer,nonce,amount,terms,terms_hash,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?)", id, input.operationKey, input.flow, input.ownerId, config.network, config.token.toLowerCase(), input.provider, input.receiver.toLowerCase(), input.payer.toLowerCase(), input.nonce.toLowerCase(), input.amount, terms, digest(terms), store.now(), store.now());
      store.run('INSERT INTO payment_operation_events_v2(operation_id,state,evidence,created_at) VALUES(?,?,?,?)', id, 'prepared', '{}', store.now());
      return get(id);
    });
  }
  function transition(id, state, evidence = {}) {
    if (!states.has(state)) error('invalid_payment_state');
    return store.tx(() => {
      const current = get(id);
      if (!current) error('payment_not_found');
      // Concurrent terminal callbacks are idempotent only with the same proof.
      if (current.state === state) {
        if (evidence.transaction && current.transaction_hash !== evidence.transaction.toLowerCase()) error('payment_proof_changed');
        if (evidence.providerPaymentId && current.provider_payment_id !== evidence.providerPaymentId) error('provider_payment_id_changed');
        return current;
      }
      if (!transitions[current.state].includes(state)) error('invalid_payment_transition');
      if (['settled', 'delivered', 'refund_pending', 'refunded'].includes(state) && state === 'settled') {
        const r = evidence.receipt;
        if (!r || r.network !== current.network || r.token?.toLowerCase() !== current.token || r.amount !== current.amount || r.payer?.toLowerCase() !== current.payer || r.recipient?.toLowerCase() !== current.receiver || r.transaction !== evidence.transaction?.toLowerCase()) error('payment_receipt_mismatch');
      }
      if (state === 'failed' && current.state === 'pending' && evidence.nonceUnusedFinal !== true) error('ambiguous_payment_cannot_fail');
      if (state === 'refunded' && (!evidence.refundReceipt || evidence.refundReceipt.network !== current.network || evidence.refundReceipt.token?.toLowerCase() !== current.token || evidence.refundReceipt.recipient?.toLowerCase() !== current.payer || evidence.refundReceipt.payer?.toLowerCase() !== current.receiver || evidence.refundReceipt.amount !== current.amount || !/^0x[a-fA-F0-9]{64}$/.test(evidence.refundReceipt.transaction ?? ''))) error('refund_receipt_mismatch');
      if (evidence.providerPaymentId && current.provider_payment_id && evidence.providerPaymentId !== current.provider_payment_id) error('provider_payment_id_changed');
      const safeEvidence = { transaction: evidence.transaction ?? null, providerPaymentId: evidence.providerPaymentId ?? null, receipt: evidence.receipt ?? null, refundReceipt: evidence.refundReceipt ?? null, nonceUnusedFinal: evidence.nonceUnusedFinal === true };
      store.run('UPDATE payment_operations_v2 SET state=?,provider_payment_id=COALESCE(provider_payment_id,?),transaction_hash=COALESCE(transaction_hash,?),receipt=COALESCE(receipt,?),updated_at=? WHERE id=?', state, safeEvidence.providerPaymentId, safeEvidence.transaction?.toLowerCase() ?? null, safeEvidence.receipt ? JSON.stringify(safeEvidence.receipt) : null, store.now(), id);
      store.run('INSERT INTO payment_operation_events_v2(operation_id,state,evidence,created_at) VALUES(?,?,?,?)', id, state, JSON.stringify(safeEvidence), store.now());
      return get(id);
    });
  }
  const budgetKey = input => {
    const config = paymentNetwork(input.network);
    if (!nonzeroAddress(input.wallet) || !['revenue', 'fees', 'sponsors', 'escrow', 'royalties', 'rewards'].includes(input.bucket)) error('invalid_budget');
    return [config.network, config.token.toLowerCase(), input.wallet.toLowerCase(), input.bucket];
  };
  function budget(input) {
    const key = budgetKey(input), row = store.q('SELECT allocated FROM payment_budgets_v2 WHERE network=? AND token=? AND wallet=? AND bucket=?', ...key);
    const allocated = BigInt(row?.allocated ?? '0');
    const committed = store.all("SELECT amount FROM payment_reservations_v2 WHERE network=? AND token=? AND wallet=? AND bucket=? AND state IN ('reserved','paid')", ...key).reduce((n, r) => n + BigInt(r.amount), 0n);
    return { network: key[0], token: key[1], wallet: key[2], bucket: key[3], allocated: allocated.toString(), committed: committed.toString(), available: (allocated - committed).toString() };
  }
  function allocate(input) {
    const key = budgetKey(input);
    if (!/^[1-9]\d*$/.test(input.amount ?? '') || !input.allocationKey || !['verified_sponsor_deposit', 'operator_allocation', 'settled_revenue', 'earned_fee'].includes(input.source) || input.bucket === 'rewards' && !['verified_sponsor_deposit', 'operator_allocation'].includes(input.source)) error('invalid_budget_allocation');
    return store.tx(() => {
      const old = store.q('SELECT * FROM payment_budget_entries_v2 WHERE allocation_key=?', input.allocationKey);
      if (old) {
        if (old.network !== key[0] || old.token !== key[1] || old.wallet !== key[2] || old.bucket !== key[3] || old.amount !== input.amount || old.source !== input.source) error('allocation_changed');
        return budget(input);
      }
      const value = BigInt(budget(input).allocated) + BigInt(input.amount);
      store.run('INSERT INTO payment_budget_entries_v2 VALUES(?,?,?,?,?,?,?,?)', input.allocationKey, ...key, input.amount, input.source, store.now());
      store.run('INSERT INTO payment_budgets_v2 VALUES(?,?,?,?,?) ON CONFLICT(network,token,wallet,bucket) DO UPDATE SET allocated=excluded.allocated', ...key, value.toString());
      return budget(input);
    });
  }
  function reserve(input) {
    const key = budgetKey(input);
    if (!input.id || !/^[1-9]\d*$/.test(input.amount ?? '')) error('invalid_reservation');
    return store.tx(() => {
      const old = store.q('SELECT * FROM payment_reservations_v2 WHERE id=?', input.id);
      if (old) {
        if (old.network !== key[0] || old.token !== key[1] || old.wallet !== key[2] || old.bucket !== key[3] || old.amount !== input.amount) error('reservation_changed');
        return old;
      }
      if (BigInt(budget(input).available) < BigInt(input.amount)) error('insufficient_chain_budget');
      store.run("INSERT INTO payment_reservations_v2 VALUES(?,?,?,?,?,?,'reserved',?)", input.id, ...key, input.amount, store.now());
      return store.q('SELECT * FROM payment_reservations_v2 WHERE id=?', input.id);
    });
  }
  return { prepare, get, transition, budget, allocate, reserve };
}
