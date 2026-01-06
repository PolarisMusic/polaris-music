/**
 * Centralized chain configuration for Polaris Music Registry
 *
 * Single source of truth for chain ID, RPC endpoint, contract account, and ABI provider settings.
 * Prevents config drift between components (WalletManager, TransactionBuilder, etc.).
 *
 * Environment variables (set in .env or docker-compose.yml):
 * - VITE_CHAIN_ID: Chain ID (default: Jungle4 testnet)
 * - VITE_RPC_URL: RPC endpoint URL (default: Jungle4 Greymass)
 * - VITE_CONTRACT_ACCOUNT: Contract account name (default: 'polaris')
 * - VITE_USE_LOCAL_ABI: Whether to use local ABI fallback (default: 'true' for dev)
 */

/**
 * Chain ID for the target blockchain network
 * Default: Jungle4 testnet chain ID
 */
export const CHAIN_ID =
    import.meta.env.VITE_CHAIN_ID ||
    '73e4385a2708e6d7048834fbc1079f2fabb17b3c125b146af438971e90716c4d';

/**
 * RPC endpoint URL for blockchain queries and transactions
 * Default: Jungle4 Greymass public endpoint
 */
export const RPC_URL =
    import.meta.env.VITE_RPC_URL ||
    'https://jungle4.greymass.com';

/**
 * Contract account name for the Polaris smart contract
 * Default: 'polaris'
 */
export const CONTRACT_ACCOUNT =
    import.meta.env.VITE_CONTRACT_ACCOUNT ||
    'polaris';

/**
 * Whether to use local ABI fallback for development/testing
 * In production, set to 'false' to let WharfKit fetch ABI from deployed contract
 * In dev/testnet, set to 'true' for resilience when contract ABI not yet deployed
 * Default: 'true' (dev-friendly)
 */
export const USE_LOCAL_ABI =
    (import.meta.env.VITE_USE_LOCAL_ABI || 'true') === 'true';

// Log config in development mode for debugging
if (import.meta.env.DEV) {
    console.log('Chain config:', {
        CHAIN_ID,
        RPC_URL,
        CONTRACT_ACCOUNT,
        USE_LOCAL_ABI
    });
}
