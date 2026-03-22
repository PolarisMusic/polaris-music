/**
 * @fileoverview Contract ABI Registry for SHiP Action Decoding
 *
 * Manages contract ABIs needed to decode action data from SHiP traces.
 * SHiP delivers action data as raw bytes; to convert them into plain JS
 * objects, we need the contract's ABI definition.
 *
 * Features:
 * - Fetch ABI from chain via RPC (/v1/chain/get_abi)
 * - Cache ABIs by account name
 * - Support local ABI fallback for dev/testing
 * - Track setabi actions to refresh cached ABIs
 * - Decode action data bytes using cached ABI
 *
 * @module indexer/ship/shipAbiRegistry
 */

import { ABI, Serializer, APIClient } from '@wharfkit/antelope';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('indexer.ship.abiRegistry');

export class ShipAbiRegistry {
    /**
     * @param {Object} config
     * @param {string} config.rpcUrl - RPC endpoint for fetching ABIs
     * @param {boolean} [config.useLocalAbi=false] - Prefer local ABI files
     * @param {string} [config.localAbiDir] - Directory containing local ABI JSON files
     * @param {string} [config.contractAccount] - Primary contract to pre-load
     */
    constructor(config) {
        this.rpcUrl = config.rpcUrl;
        this.useLocalAbi = config.useLocalAbi || false;
        this.localAbiDir = config.localAbiDir || '';
        this.contractAccount = config.contractAccount || 'polarismusic';
        this.contractAbiPath = config.contractAbiPath || '';

        /** @type {Map<string, ABI>} Account name -> parsed ABI */
        this.abiCache = new Map();

        this.apiClient = new APIClient({ url: this.rpcUrl });
    }

    /**
     * Bootstrap the registry on startup.
     * Pre-loads the primary contract ABI.
     */
    async bootstrap() {
        log.info('ship_abi_bootstrap', { contract: this.contractAccount, rpc: this.rpcUrl });

        try {
            await this.loadAbi(this.contractAccount);
            log.info('ship_abi_loaded', { account: this.contractAccount });
        } catch (error) {
            log.warn('ship_abi_bootstrap_failed', {
                account: this.contractAccount,
                error: error.message,
            });

            // Try local fallback
            if (this.useLocalAbi) {
                try {
                    await this.loadLocalAbi(this.contractAccount);
                    log.info('ship_abi_local_fallback', { account: this.contractAccount });
                } catch (localError) {
                    log.error('ship_abi_no_fallback', {
                        account: this.contractAccount,
                        error: localError.message,
                    });
                    throw new Error(
                        `Cannot load ABI for ${this.contractAccount}: RPC failed (${error.message}), local fallback failed (${localError.message})`
                    );
                }
            } else {
                throw error;
            }
        }
    }

    /**
     * Load ABI for an account from chain via RPC.
     *
     * @param {string} account - Account name
     * @returns {ABI} The loaded ABI
     */
    async loadAbi(account) {
        log.debug('ship_abi_fetch', { account, rpc: this.rpcUrl });

        const response = await this.apiClient.v1.chain.get_abi(account);

        if (!response.abi) {
            throw new Error(`No ABI found for account '${account}'`);
        }

        const abi = ABI.from(response.abi);
        this.abiCache.set(account, abi);
        return abi;
    }

    /**
     * Load ABI from a local JSON file.
     * Looks for <localAbiDir>/<account>.abi.json or falls back to
     * the substreams/abi directory.
     *
     * @param {string} account - Account name
     * @returns {ABI} The loaded ABI
     */
    async loadLocalAbi(account) {
        const searchPaths = [];

        // Explicit path from CONTRACT_ABI_PATH takes priority
        if (this.contractAbiPath && account === this.contractAccount) {
            searchPaths.push(this.contractAbiPath);
        }

        if (this.localAbiDir) {
            searchPaths.push(path.join(this.localAbiDir, `${account}.abi.json`));
        }

        // Standard locations - try multiple naming conventions
        // Account names may differ from file names (e.g. "polarismusic" vs "polaris.music")
        const projectRoot = path.resolve(import.meta.dirname, '../../../../');
        const dotName = account.replace(/([a-z])([A-Z])/g, '$1.$2').toLowerCase();
        const names = [account, dotName];
        // Also try the common Antelope convention: account with dots (polaris.music)
        if (!names.includes('polaris.music') && account === 'polarismusic') {
            names.push('polaris.music');
        }

        for (const name of names) {
            searchPaths.push(
                path.join(projectRoot, 'substreams', 'abi', `${name}.abi.json`),
                path.join(projectRoot, 'substreams', 'abi', `${name}.json`),
                path.join(projectRoot, 'contracts', `${name}.abi.json`),
                path.join(projectRoot, 'contracts', `${name}.abi`),
            );
        }

        for (const abiPath of searchPaths) {
            try {
                if (fs.existsSync(abiPath)) {
                    const abiJson = JSON.parse(fs.readFileSync(abiPath, 'utf-8'));
                    const abi = ABI.from(abiJson);
                    this.abiCache.set(account, abi);
                    log.info('ship_abi_local_loaded', { account, path: abiPath });
                    return abi;
                }
            } catch {
                // Try next path
            }
        }

        throw new Error(`No local ABI file found for '${account}'`);
    }

    /**
     * Get the cached ABI for an account, fetching if not cached.
     *
     * @param {string} account - Account name
     * @returns {ABI}
     */
    async getAbi(account) {
        if (this.abiCache.has(account)) {
            return this.abiCache.get(account);
        }

        // Try RPC first, then local
        try {
            return await this.loadAbi(account);
        } catch (rpcError) {
            if (this.useLocalAbi) {
                return await this.loadLocalAbi(account);
            }
            throw rpcError;
        }
    }

    /**
     * Handle a setabi action observed in the trace stream.
     * Refreshes the cached ABI for the affected account.
     *
     * @param {string} account - Account whose ABI was updated
     */
    async handleSetAbi(account) {
        log.info('ship_abi_setabi', { account });
        try {
            await this.loadAbi(account);
            log.info('ship_abi_refreshed', { account });
        } catch (error) {
            log.warn('ship_abi_refresh_failed', { account, error: error.message });
        }
    }

    /**
     * Decode action data bytes using the cached ABI for the given account.
     *
     * @param {string} account - Contract account name
     * @param {string} actionName - Action name (e.g., 'put', 'vote')
     * @param {Uint8Array|string} data - Raw action data bytes (or hex string)
     * @returns {Object} Decoded action data as plain JS object
     */
    async decodeActionData(account, actionName, data) {
        // Already decoded (object format) - return as-is
        // This happens when action data was pre-decoded by the node or test fixtures
        if (typeof data === 'object' && data !== null && !(data instanceof Uint8Array) && !Buffer.isBuffer(data) && !data.array) {
            return data;
        }

        const abi = await this.getAbi(account);

        // Convert to Uint8Array if hex string
        let bytes;
        if (typeof data === 'string') {
            const hex = data.startsWith('0x') ? data.slice(2) : data;
            bytes = new Uint8Array(hex.length / 2);
            for (let i = 0; i < bytes.length; i++) {
                bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
            }
        } else if (data instanceof Uint8Array) {
            bytes = data;
        } else if (data && data.array) {
            // Wharfkit Bytes type
            bytes = data.array;
        } else if (Buffer.isBuffer(data)) {
            bytes = new Uint8Array(data);
        } else {
            throw new Error(`Unsupported action data type: ${typeof data}`);
        }

        const decoded = Serializer.decode({
            type: actionName,
            abi,
            data: bytes,
        });

        return Serializer.objectify(decoded);
    }

    /**
     * Check if an ABI is cached for the given account.
     *
     * @param {string} account
     * @returns {boolean}
     */
    hasAbi(account) {
        return this.abiCache.has(account);
    }

    /**
     * Clear all cached ABIs.
     */
    clearCache() {
        this.abiCache.clear();
    }
}

export default ShipAbiRegistry;
