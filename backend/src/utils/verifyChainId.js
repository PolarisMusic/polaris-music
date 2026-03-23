/**
 * @fileoverview Chain ID verification utility
 *
 * Verifies that the configured chain ID matches the chain reported by the
 * RPC endpoint. Prevents accidental mainnet/testnet/local mismatches that
 * could corrupt the graph database.
 *
 * Used by both the API server and the chain-source worker.
 *
 * @module utils/verifyChainId
 */

import { createLogger } from './logger.js';

const log = createLogger('utils.verifyChainId');

/**
 * Verify the configured chain ID matches the RPC endpoint.
 *
 * @param {Object} chainConfig - Resolved chain configuration
 * @param {string} chainConfig.rpcUrl - RPC endpoint URL
 * @param {string} chainConfig.chainId - Expected chain ID
 * @param {string} chainConfig.name - Profile name
 * @param {Object} [options]
 * @param {boolean} [options.fatal=true] - Exit process on mismatch
 * @param {number} [options.timeoutMs=5000] - RPC request timeout
 * @throws {Error} If fatal=false and chain ID mismatches
 */
export async function verifyChainId(chainConfig, options = {}) {
    const { rpcUrl, chainId, name: profileName } = chainConfig;
    const { fatal = true, timeoutMs = 5000 } = options;

    // Skip if no RPC URL or chain ID configured
    if (!rpcUrl || !chainId) {
        log.info('chain_id_verify_skip', { reason: 'no rpcUrl or chainId' });
        return;
    }

    // Skip for dev mode without explicit chain config
    const ingestMode = process.env.INGEST_MODE || chainConfig.ingestMode;
    if (ingestMode === 'dev' && !process.env.CHAIN_ID && !process.env.CHAIN_PROFILE) {
        log.info('chain_id_verify_skip', { reason: 'dev mode without explicit config' });
        return;
    }

    log.info('chain_id_verify_start', {
        profile: profileName,
        rpc_url: rpcUrl,
        expected: chainId.substring(0, 16) + '...',
    });

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(`${rpcUrl}/v1/chain/get_info`, {
            signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!response.ok) {
            log.warn('chain_id_verify_skip', { reason: `RPC returned ${response.status}` });
            return;
        }

        const info = await response.json();
        const remoteChainId = info.chain_id;

        if (remoteChainId !== chainId) {
            const msg = `Chain ID mismatch: configured ${chainId}, RPC reports ${remoteChainId} (profile: ${profileName}, RPC: ${rpcUrl})`;
            log.error('chain_id_mismatch', {
                configured: chainId,
                remote: remoteChainId,
                profile: profileName,
                rpc_url: rpcUrl,
            });

            if (fatal) {
                console.error('═══════════════════════════════════════════════════════════════');
                console.error('FATAL: Chain ID mismatch!');
                console.error(`  Configured: ${chainId}`);
                console.error(`  RPC reports: ${remoteChainId}`);
                console.error(`  Profile: ${profileName}, RPC: ${rpcUrl}`);
                console.error('  Check CHAIN_PROFILE, CHAIN_ID, and RPC_URL in your environment.');
                console.error('═══════════════════════════════════════════════════════════════');
                process.exit(1);
            }

            throw new Error(msg);
        }

        log.info('chain_id_verified', {
            chain_id: remoteChainId.substring(0, 16) + '...',
            profile: profileName,
            head_block: info.head_block_num,
            lib: info.last_irreversible_block_num,
        });
    } catch (error) {
        if (error.name === 'AbortError') {
            log.warn('chain_id_verify_skip', { reason: 'RPC timeout' });
        } else if (error.message?.includes('Chain ID mismatch')) {
            throw error; // Re-throw mismatch errors
        } else {
            log.warn('chain_id_verify_skip', { reason: error.message });
        }
    }
}
