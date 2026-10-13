import { createPublicClient, defineChain, http, isAddress, parseAbi, parseEventLogs, hashDomain } from 'viem';
import { base } from 'viem/chains';

// Verified 2026-10-12 against Arc connect-to-arc, Circle supported-networks,
// Arc USDC system events and Circle EIP-3009 signing docs. SDK RPC defaults
// are deliberately not used: the installed Arc mainnet definition has none.
const arcChain = (id, name, rpc, explorer, testnet = false) => defineChain({
  id, name, nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [rpc] } }, blockExplorers: { default: { name: 'Arc Explorer', url: explorer } }, testnet
});
const arcUSDC = '0x3600000000000000000000000000000000000000';
export const ARC_SYSTEM_EMITTER = '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE';
const entry = value => Object.freeze({ tokenDecimals: 6, domainVersion: '2', ...value });
export const PAYMENT_NETWORKS = Object.freeze({
  'eip155:8453': entry({ network: 'eip155:8453', chainId: 8453, name: 'Base', token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', domainName: 'USD Coin', gasSymbol: 'ETH', gasDecimals: 18, rpcUrl: 'https://mainnet.base.org', explorer: 'https://basescan.org', chain: base, testnet: false }),
  'eip155:5042': entry({ network: 'eip155:5042', chainId: 5042, name: 'Arc', token: arcUSDC, domainName: 'USDC', gasSymbol: 'USDC', gasDecimals: 18, rpcUrl: 'https://rpc.mainnet.arc.io', explorer: 'https://explorer.arc.io', systemEmitter: ARC_SYSTEM_EMITTER, chain: arcChain(5042, 'Arc', 'https://rpc.mainnet.arc.io', 'https://explorer.arc.io'), testnet: false }),
  'eip155:5042002': entry({ network: 'eip155:5042002', chainId: 5042002, name: 'Arc Testnet', token: arcUSDC, domainName: 'USDC', gasSymbol: 'USDC', gasDecimals: 18, rpcUrl: 'https://rpc.testnet.arc.io', explorer: 'https://explorer.testnet.arc.io', systemEmitter: ARC_SYSTEM_EMITTER, chain: arcChain(5042002, 'Arc Testnet', 'https://rpc.testnet.arc.io', 'https://explorer.testnet.arc.io', true), testnet: true })
});
export const PAYMENT_FLOWS = Object.freeze(['pro', 'paid_api', 'marketplace', 'fixed_services', 'escrow', 'paid_jobs', 'funded_tasks', 'sponsor_deposits', 'fees', 'payouts', 'refunds', 'rewards']);
export function paymentNetwork(network) {
  const config = PAYMENT_NETWORKS[network];
  if (!config) throw Error('Unsupported payment network.');
  return config;
}
export const paymentDomain = config => ({ name: config.domainName, version: config.domainVersion, chainId: config.chainId, verifyingContract: config.token });
export const paymentDomainSeparator = config => hashDomain({ domain: paymentDomain(config), types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }] } });
export const networkClient = (config, rpcUrl = config.rpcUrl) => createPublicClient({ chain: config.chain, transport: http(rpcUrl, { timeout: 10000, retryCount: 0 }) });
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
export const nonzeroAddress = value => isAddress(value ?? '', { strict: false }) && !/^0x0{40}$/i.test(value);
const tokenAbi = parseAbi(['function decimals() view returns (uint8)', 'function name() view returns (string)', 'function version() view returns (string)', 'function DOMAIN_SEPARATOR() view returns (bytes32)', 'function balanceOf(address) view returns (uint256)']);
export async function inspectPaymentNetwork(config, client, address) {
  if (!nonzeroAddress(address)) throw Error('A nonzero receiving address is required.');
  if (await client.getChainId() !== config.chainId) throw Error('RPC chain mismatch.');
  const [decimals, name, version, separator, code, native, token] = await Promise.all([
    ...['decimals', 'name', 'version', 'DOMAIN_SEPARATOR'].map(functionName => client.readContract({ address: config.token, abi: tokenAbi, functionName })),
    client.getBytecode({ address }), client.getBalance({ address }), client.readContract({ address: config.token, abi: tokenAbi, functionName: 'balanceOf', args: [address] })
  ]);
  if (Number(decimals) !== 6 || name !== config.domainName || version !== config.domainVersion || !same(separator, paymentDomainSeparator(config))) throw Error('USDC contract or signing domain mismatch.');
  return { network: config.network, chain_id: config.chainId, address, wallet_type: code && code !== '0x' ? 'deployed_contract' : 'eoa_or_undeployed_contract', ownership: 'requires_chain_specific_control_proof', token: config.token, token_balance_atomic: token.toString(), native_balance_atomic: native.toString(), gas_currency: config.gasSymbol, native_decimals: 18, token_decimals: 6, arc_shared_balance: !!config.systemEmitter, checked: true };
}
const transferAbi = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)', 'event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)']);
// ERC-20 is the canonical evidence for application payments. Arc's second,
// native log must never credit the same movement again. Native-only deposits
// require an explicit policy and an exactly representable six-decimal amount.
export function matchingTransfer(config, receipt, { payer, recipient, amount, nonce, allowNative = false }) {
  if (!nonzeroAddress(payer) || !nonzeroAddress(recipient) || !/^[1-9]\d*$/.test(String(amount))) return null;
  const logs = parseEventLogs({ abi: transferAbi, logs: receipt.logs.filter(l => !l.removed && same(l.address, config.token)), strict: true });
  if (nonce && !logs.some(l => l.eventName === 'AuthorizationUsed' && same(l.args.authorizer, payer) && same(l.args.nonce, nonce))) return null;
  const matches = logs.filter(l => l.eventName === 'Transfer' && same(l.args.from, payer) && same(l.args.to, recipient) && l.args.value === BigInt(amount));
  if (matches.length === 1 && Number.isInteger(matches[0].logIndex) && matches[0].logIndex>=0) return { ...matches[0], amount: String(amount), network: config.network, token: config.token, evidence_interface: 'erc20' };
  if (matches.length || !allowNative || nonce || !config.systemEmitter) return null;
  const native = parseEventLogs({ abi: transferAbi, logs: receipt.logs.filter(l => !l.removed && same(l.address, config.systemEmitter)), strict: true }).filter(l => l.eventName === 'Transfer' && same(l.args.from, payer) && same(l.args.to, recipient) && l.args.value === BigInt(amount) * 1000000000000n);
  return native.length === 1 && Number.isInteger(native[0].logIndex) && native[0].logIndex>=0 ? { ...native[0], amount: String(amount), network: config.network, token: config.token, evidence_interface: 'native' } : null;
}
export async function verifyNetworkReceipt(config, client, transaction, expected, { baseFinality = 'safe' } = {}) {
  if (!/^0x[a-fA-F0-9]{64}$/.test(transaction ?? '')) return null;
  if (await client.getChainId() !== config.chainId) throw Error('RPC chain mismatch.');
  const receipt = await client.getTransactionReceipt({ hash: transaction });
  if (receipt.status !== 'success' || !same(receipt.transactionHash, transaction)) return null;
  const [block, head] = await Promise.all([client.getBlock({ blockNumber: receipt.blockNumber }), config.systemEmitter ? client.getBlockNumber({ cacheTime: 0 }) : baseFinality === 'safe' ? client.getBlock({ blockTag: 'safe' }).then(b => b.number) : client.getBlockNumber({ cacheTime: 0 }).then(n => n - 2n)]);
  if (!same(block.hash, receipt.blockHash) || head < receipt.blockNumber) return null;
  const transfer = matchingTransfer(config, receipt, expected);
  return transfer ? { transaction: transaction.toLowerCase(), block_number: receipt.blockNumber.toString(), block_hash: receipt.blockHash, log_index: transfer.logIndex, network: config.network, token: config.token, amount: transfer.amount, recipient: expected.recipient, payer: expected.payer, evidence_interface: transfer.evidence_interface } : null;
}
// USDC gas and principal are one Arc balance. Reserve at native precision;
// do not approve a payout against balanceOf while ignoring its gas cost.
export function canCoverPayment(config, { nativeBalance, tokenBalance, principalAtomic, reservedAtomic = 0n, gasLimit, maxFeePerGas, gasBudgetNative }) {
  const principal = BigInt(principalAtomic) + BigInt(reservedAtomic), gas = BigInt(gasLimit) * BigInt(maxFeePerGas);
  if (principal < 0n || gas < 0n || gas > BigInt(gasBudgetNative)) return false;
  return config.systemEmitter ? BigInt(nativeBalance) >= principal * 1000000000000n + gas : BigInt(tokenBalance) >= principal && BigInt(nativeBalance) >= gas;
}
