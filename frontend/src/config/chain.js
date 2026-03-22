/**
 * Centralized chain configuration for Polaris Music Registry
 *
 * Sources chain profile defaults from shared/config/chainProfiles.js,
 * the single source of truth for chain configuration across all components.
 *
 * Environment variables (set in .env or docker-compose.yml):
 * - VITE_CHAIN_PROFILE: Chain profile name — 'jungle4' | 'local' | 'mainnet'
 * - VITE_CHAIN_ID: Chain ID override
 * - VITE_RPC_URL: RPC endpoint URL override
 * - VITE_CONTRACT_ACCOUNT: Contract account name override
 * - VITE_USE_LOCAL_ABI: Whether to use local ABI fallback (default per profile)
 * - VITE_INGEST_MODE: Ingestion mode — 'dev' | 'chain'
 *
 * For backwards compatibility, VITE_CHAIN_MODE is also supported as an alias
 * for VITE_CHAIN_PROFILE.
 */

import { CHAIN_PROFILES } from '../../../shared/config/chainProfiles.js';

/**
 * Chain profile name — determines which blockchain environment the UI targets.
 * Values: 'jungle4' | 'local' | 'mainnet'
 */
export const CHAIN_MODE =
    import.meta.env.VITE_CHAIN_PROFILE ||
    import.meta.env.VITE_CHAIN_MODE ||
    'jungle4';

const preset = CHAIN_PROFILES[CHAIN_MODE] || CHAIN_PROFILES.jungle4;

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
 */
export const CONTRACT_ACCOUNT =
    import.meta.env.VITE_CONTRACT_ACCOUNT || preset.contractAccount;

/**
 * Whether to use local ABI fallback for development/testing
 * In production, set to 'false' to let WharfKit fetch ABI from deployed contract
 */
export const USE_LOCAL_ABI =
    (import.meta.env.VITE_USE_LOCAL_ABI || String(preset.useLocalAbi)) === 'true';

/**
 * Ingestion mode — controls how events reach the graph database after
 * a blockchain transaction is broadcast.
 *
 * 'dev'   (default for local/jungle4): UI calls /api/ingest/anchored-event
 *         directly after tx for fast feedback during development.
 * 'chain': UI broadcasts tx only; Substreams/SHiP sink handles
 *          ingestion from on-chain data. No direct ingest call.
 */
export const INGEST_MODE =
    import.meta.env.VITE_INGEST_MODE || preset.ingestMode;

// Log config in development mode for debugging
if (import.meta.env.DEV) {
    console.log('Chain config:', {
        CHAIN_MODE,
        CHAIN_ID,
        RPC_URL,
        CONTRACT_ACCOUNT,
        USE_LOCAL_ABI,
        INGEST_MODE,
        source: 'shared/config/chainProfiles.js',
    });
}
