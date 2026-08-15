import { parseAbiItem } from 'viem';

/**
 * Event signatures, kept in sync with contracts/ by hand.
 *
 * These must match the Solidity exactly. An earlier version listened for `Sealed` and
 * `Graduated` on the factory; neither is emitted there — graduation is a curve event and
 * migration is a migrator event — so those subscriptions were silently dead.
 */

export const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

/** HexaFactory */
export const FACTORY_EVENTS = [
  parseAbiItem('event Committed(bytes32 indexed commitHash, address indexed creator, uint64 blockNo)'),
  parseAbiItem(
    'event Launched(bytes32 indexed commitHash, address indexed token, address indexed curve, address creator, string name, string symbol, string metadataURI)',
  ),
] as const;

/**
 * HexaCurve. One curve is deployed per coin, so these are subscribed by topic with no
 * address filter and validated against the known-curve set — otherwise every new launch
 * would require tearing down and re-establishing the subscription.
 */
export const CURVE_EVENTS = [
  parseAbiItem(
    'event Bought(address indexed buyer, address indexed to, uint256 nativeIn, uint256 tokensOut, uint256 fee)',
  ),
  parseAbiItem(
    'event Sold(address indexed seller, address indexed to, uint256 tokensIn, uint256 nativeOut, uint256 fee, uint256 tax)',
  ),
  parseAbiItem('event ReferrerBound(address indexed trader, address indexed referrer)'),
  parseAbiItem('event Graduated(uint256 realUsdc, uint256 lpTokens)'),
] as const;

/** LiquidityMigrator */
export const MIGRATOR_EVENTS = [
  parseAbiItem(
    'event Migrated(address indexed token, address indexed pool, uint256 usdcIn, uint256 tokensIn, uint128 liquidity)',
  ),
] as const;

export const ERC20_META = [
  { name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;
