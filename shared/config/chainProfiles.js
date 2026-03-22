/**
 * @fileoverview Shared chain profile definitions for all Polaris components.
 *
 * Single source of truth for chain configuration across frontend, backend,
 * substreams sink, and deployment manifests.
 *
 * Usage (backend / Node.js):
 *   import { getChainProfile, resolveChainConfig } from '../../shared/config/chainProfiles.js';
 *   const profile = resolveChainConfig();
 *
 * Usage (frontend / Vite):
 *   import { CHAIN_PROFILES } from '../../shared/config/chainProfiles.js';
 *   const preset = CHAIN_PROFILES[import.meta.env.VITE_CHAIN_PROFILE || 'jungle4'];
 */

/**
 * @typedef {Object} ChainProfile
 * @property {string} name - Profile name
 * @property {string} chainId - Chain ID hex string
 * @property {string} rpcUrl - HTTP RPC endpoint
 * @property {string} shipUrl - SHiP WebSocket endpoint (empty if not available)
 * @property {string} substreamsEndpoint - Substreams gRPC endpoint (empty if not available)
 * @property {string} contractAccount - Polaris contract account name
 * @property {string} tokenContractAccount - Token contract account name
 * @property {boolean} useLocalAbi - Whether to prefer local ABI over on-chain
 * @property {string} ingestMode - 'dev' (direct API) or 'chain' (event-sourced)
 * @property {string} chainSource - 'substreams' or 'ship'
 * @property {boolean} irreversibleOnly - Only process irreversible blocks
 */

export const CHAIN_PROFILES = {
    local: {
        name: 'local',
        chainId: '8a34ec7df1b8cd06ff4a8abbaa7cc50300823350cadc59ab296cb00d104d2b8f',
        rpcUrl: 'http://localhost:8888',
        shipUrl: 'ws://localhost:8080',
        substreamsEndpoint: '',
        contractAccount: 'polarismusic',
        tokenContractAccount: 'eosio.token',
        useLocalAbi: true,
        ingestMode: 'dev',
        chainSource: 'ship',
        irreversibleOnly: false,
    },
    jungle4: {
        name: 'jungle4',
        chainId: '73e4385a2708e6d7048834fbc1079f2fabb17b3c125b146af438971e90716c4d',
        rpcUrl: 'https://jungle4.greymass.com',
        shipUrl: '',
        substreamsEndpoint: 'jungle4.substreams.pinax.network:443',
        contractAccount: 'polarismusic',
        tokenContractAccount: 'polaristoken',
        useLocalAbi: false,
        ingestMode: 'chain',
        chainSource: 'substreams',
        irreversibleOnly: false,
    },
    mainnet: {
        name: 'mainnet',
        chainId: 'aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906',
        rpcUrl: 'https://eos.greymass.com',
        shipUrl: '',
        substreamsEndpoint: 'eos.substreams.pinax.network:443',
        contractAccount: 'polarismusic',
        tokenContractAccount: 'polaristoken',
        useLocalAbi: false,
        ingestMode: 'chain',
        chainSource: 'substreams',
        irreversibleOnly: true,
    },
};

/**
 * Get a chain profile by name.
 * @param {string} name - Profile name ('local', 'jungle4', 'mainnet')
 * @returns {ChainProfile}
 */
export function getChainProfile(name) {
    const profile = CHAIN_PROFILES[name];
    if (!profile) {
        throw new Error(
            `Unknown chain profile: '${name}'. Valid profiles: ${Object.keys(CHAIN_PROFILES).join(', ')}`
        );
    }
    return { ...profile };
}

/**
 * Resolve chain configuration from environment variables, falling back to profile defaults.
 *
 * Environment variables take precedence over profile defaults. This allows
 * operators to override individual settings without changing the profile.
 *
 * @param {Object} [env] - Environment object (defaults to process.env in Node.js)
 * @returns {ChainProfile} Resolved configuration
 */
export function resolveChainConfig(env) {
    // Support both Node.js process.env and Vite import.meta.env
    const e = env || (typeof process !== 'undefined' ? process.env : {});

    const profileName = e.CHAIN_PROFILE || e.VITE_CHAIN_PROFILE || 'jungle4';
    const profile = getChainProfile(profileName);

    return {
        name: profileName,
        chainId: e.CHAIN_ID || e.VITE_CHAIN_ID || profile.chainId,
        rpcUrl: e.RPC_URL || e.VITE_RPC_URL || profile.rpcUrl,
        shipUrl: e.SHIP_URL || profile.shipUrl,
        substreamsEndpoint: e.SUBSTREAMS_ENDPOINT || profile.substreamsEndpoint,
        contractAccount: e.CONTRACT_ACCOUNT || e.VITE_CONTRACT_ACCOUNT || profile.contractAccount,
        tokenContractAccount: e.TOKEN_CONTRACT_ACCOUNT || profile.tokenContractAccount,
        useLocalAbi: parseBool(e.USE_LOCAL_ABI ?? e.VITE_USE_LOCAL_ABI, profile.useLocalAbi),
        ingestMode: e.INGEST_MODE || e.VITE_INGEST_MODE || profile.ingestMode,
        chainSource: e.CHAIN_SOURCE || profile.chainSource,
        irreversibleOnly: parseBool(e.IRREVERSIBLE_ONLY, profile.irreversibleOnly),
        startBlock: parseInt(e.START_BLOCK || '0', 10),
        endBlock: parseInt(e.END_BLOCK || '4294967295', 10),
    };
}

/**
 * Parse a boolean-like env var string.
 * @param {string|boolean|undefined} value
 * @param {boolean} defaultValue
 * @returns {boolean}
 */
function parseBool(value, defaultValue) {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    return value === 'true' || value === '1';
}
