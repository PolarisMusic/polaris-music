/**
 * Centralized chain configuration for Polaris Music Registry
 *
 * Single source of truth for chain ID, RPC endpoint, contract account, and ABI provider settings.
 * Prevents config drift between components (WalletManager, TransactionBuilder, etc.).
 *
 * Environment variables (set in .env or docker-compose.yml):
 * - VITE_CHAIN_ID: Chain ID (default: Jungle4 testnet)
 * - VITE_RPC_URL: RPC endpoint URL (default: Jungle4 Greymass)
 * - VITE_CONTRACT_ACCOUNT: Contract account name (default: 'polarismusic')
 * - VITE_USE_LOCAL_ABI: Whether to use local ABI fallback (default: 'true' for dev)
 * - VITE_CHAIN_MODE: Target chain environment — 'jungle4' | 'local' | 'mainnet'
 *     jungle4 (default): Jungle4 public testnet
 *     local: Local nodeos instance (see contracts/README.md "Testing Locally")
 *     mainnet: EOS mainnet (production)
 */

/**
 * Chain mode — determines which blockchain environment the UI targets.
 * Values: 'jungle4' | 'local' | 'mainnet'
 */
export const CHAIN_MODE =
    import.meta.env.VITE_CHAIN_MODE || 'jungle4';

// Presets per chain mode (used as defaults when env vars are not set)
const CHAIN_PRESETS = {
    jungle4: {
        chainId: '73e4385a2708e6d7048834fbc1079f2fabb17b3c125b146af438971e90716c4d',
        rpcUrl: 'https://jungle4.greymass.com',
    },
    local: {
        chainId: '8a34ec7df1b8cd06ff4a8abbaa7cc50300823350cadc59ab296cb00d104d2b8f',
        rpcUrl: 'http://localhost:8888',
    },
    mainnet: {
        chainId: 'aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906',
        rpcUrl: 'https://eos.greymass.com',
    },
};

const preset = CHAIN_PRESETS[CHAIN_MODE] || CHAIN_PRESETS.jungle4;

/**
 * Chain ID for the target blockchain network
 */
export const CHAIN_ID =
    import.meta.env.VITE_CHAIN_ID || preset.chainId;

/**
 * RPC endpoint URL for blockchain queries and transactions
 */
export const RPC_URL =
    import.meta.env.VITE_RPC_URL || preset.rpcUrl;

/**
 * Contract account name for the Polaris smart contract
 * Default: 'polarismusic'
 */
export const CONTRACT_ACCOUNT =
    import.meta.env.VITE_CONTRACT_ACCOUNT ||
    'polarismusic';

/**
 * Whether to use local ABI fallback for development/testing
 * In production, set to 'false' to let WharfKit fetch ABI from deployed contract
 * In dev/testnet, set to 'true' for resilience when contract ABI not yet deployed
 * Default: 'true' (dev-friendly)
 */
export const USE_LOCAL_ABI =
    (import.meta.env.VITE_USE_LOCAL_ABI || 'true') === 'true';

/**
 * Ingestion mode — controls how events reach the graph database after
 * a blockchain transaction is broadcast.
 *
 * 'dev'   (default): UI calls /api/ingest/anchored-event directly after tx
 *                     for fast feedback during development.
 * 'chain':           UI broadcasts tx only; Substreams/SHiP sink handles
 *                     ingestion from on-chain data. No direct ingest call.
 *
 * In 'chain' mode the UI will poll the backend to confirm the event was
 * ingested by the sink rather than pushing it directly.
 */
export const INGEST_MODE =
    import.meta.env.VITE_INGEST_MODE || 'dev';

// Log config in development mode for debugging
if (import.meta.env.DEV) {
    console.log('Chain config:', {
        CHAIN_MODE,
        CHAIN_ID,
        RPC_URL,
        CONTRACT_ACCOUNT,
        USE_LOCAL_ABI,
        INGEST_MODE
    });
}
