import { randomBytes, createHash } from 'node:crypto';
import { keccak256, toBytes } from 'viem';
import { paymentNetwork, nonzeroAddress } from './payment-networks.js';

export const CIRCLE_FACILITATOR_URL = 'https://api.circle.com/v1/facilitator/x402';
const sellerTypes = { SellerRequest: [
  { name: 'purpose', type: 'string' }, { name: 'method', type: 'string' }, { name: 'bodyHash', type: 'bytes32' },
  { name: 'network', type: 'string' }, { name: 'payTo', type: 'address' }, { name: 'nonce', type: 'bytes32' },
  { name: 'issuedAt', type: 'uint64' }, { name: 'expiresAt', type: 'uint64' }
] };
export async function circleSellerProof({ signer, network, payTo, purpose, method, body = '', now = Date.now }) {
  const config = paymentNetwork(network);
  if (!['verify', 'settle', 'status'].includes(purpose) || !nonzeroAddress(payTo) || signer.address?.toLowerCase() !== payTo.toLowerCase()) throw Error('Invalid Circle seller proof context.');
  const nonce = '0x' + randomBytes(32).toString('hex'), issuedAt = Math.floor(now() / 1000), expiresAt = issuedAt + 300;
  const signature = await signer.signTypedData({ domain: { name: 'Circle Facilitator Seller Request', version: '1', chainId: config.chainId }, types: sellerTypes, primaryType: 'SellerRequest', message: { purpose, method: method.toUpperCase(), bodyHash: keccak256(toBytes(body)), network, payTo, nonce, issuedAt: BigInt(issuedAt), expiresAt: BigInt(expiresAt) } });
  return Buffer.from(JSON.stringify({ version: 1, signature, network, payTo, nonce, issuedAt, expiresAt })).toString('base64url');
}
export function paymentIdentifier(payload) {
  const a = payload?.payload?.authorization;
  if (!a || !/^0x[a-fA-F0-9]{64}$/.test(a.nonce ?? '') || !nonzeroAddress(a.from)) throw Error('Missing payment identity.');
  return 'speedbot_' + createHash('sha256').update(payload.accepted.network + ':' + a.from.toLowerCase() + ':' + a.nonce.toLowerCase()).digest('hex');
}
// Circle's status protocol is intentionally separate from PayAI. A timeout
// never means a failed transfer; callers persist the authorization before
// settle and retain both their identifier and Circle's paymentId.
export function createCircleFacilitator({ apiKey, sellerSigner, keylessTrial = false, network, payTo, fetchImpl = fetch, timeoutMs = 15000, now = Date.now } = {}) {
  const config = paymentNetwork(network);
  if (!config.systemEmitter || !nonzeroAddress(payTo) || (!apiKey && !sellerSigner)) throw Error('Circle Arc settlement needs API access or a matching seller proof signer.');
  if (!config.testnet && !apiKey && !keylessTrial) throw Error('Circle production settlement requires an API key or an explicitly selected limited keyless trial.');
  const proofs = new Map();
  async function request(path, purpose, method, data) {
    const body = data ? JSON.stringify(data) : '';
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    else {
      const cacheKey = purpose + ':' + method + ':' + path + ':' + keccak256(toBytes(body));
      let proof = proofs.get(cacheKey);
      if (!proof || proof.expiresAt <= Math.floor(now() / 1000) + 10) {
        const header = await circleSellerProof({ signer: sellerSigner, network, payTo, purpose, method, body, now });
        proof = { header, expiresAt: JSON.parse(Buffer.from(header, 'base64url').toString()).expiresAt };
        // Bound auth capabilities in memory; none are logged or exported.
        if (proofs.size >= 128) proofs.delete(proofs.keys().next().value);
        proofs.set(cacheKey, proof);
      }
      headers['Facilitator-Seller-Proof'] = proof.header;
    }
    let response;
    try { response = await fetchImpl(CIRCLE_FACILITATOR_URL + path, { method, headers, ...(body ? { body } : {}), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' }); }
    catch { throw Object.assign(Error('Circle provider outcome unavailable.'), { code: 'circle_outcome_unknown' }); }
    if (!response.ok) throw Object.assign(Error('Circle request rejected; retain the original payment identity.'), { code: 'circle_request_rejected', httpStatus: response.status });
    let value;
    try { const text = await response.text(); if (text.length > 262144) throw Error(); value = JSON.parse(text); }
    catch { throw Object.assign(Error('Circle response invalid; retain the original payment identity.'), { code: 'circle_response_invalid' }); }
    return value;
  }
  function bodyFor(payload, requirements) {
    if (requirements.network !== network || requirements.payTo?.toLowerCase() !== payTo.toLowerCase() || requirements.asset?.toLowerCase() !== config.token.toLowerCase() || payload.accepted.network !== network) throw Error('Circle payment context mismatch.');
    return { x402Version: 2, paymentPayload: { ...payload, extensions: { ...payload.extensions, 'payment-identifier': { info: { required: true, id: paymentIdentifier(payload) } } } }, paymentRequirements: requirements };
  }
  async function settle(payload, requirements) {
    const value = await request('/settle', 'settle', 'POST', bodyFor(payload, requirements));
    if (value.network !== network || value.success === true && !/^0x[a-fA-F0-9]{64}$/.test(value.transaction ?? '')) throw Error('Circle settlement evidence mismatch.');
    return value;
  }
  async function status(paymentId) {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(paymentId ?? '')) throw Error('Invalid Circle payment ID.');
    const value = await request('/status/' + paymentId, 'status', 'GET');
    if (value.paymentId !== paymentId || value.network !== network || !['pending', 'completed', 'failed'].includes(value.status)) throw Error('Circle status context mismatch.');
    return value;
  }
  return { provider: 'circle-facilitator', url: CIRCLE_FACILITATOR_URL, network,
    verify: (payload, requirements) => request('/verify', 'verify', 'POST', bodyFor(payload, requirements)), settle, status };
}
