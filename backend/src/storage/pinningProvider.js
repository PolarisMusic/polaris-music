/**
 * External IPFS Pinning Provider (Pinata, Web3.Storage, etc.)
 *
 * Provides best-effort pinning to external services for additional redundancy.
 * Failures do NOT fail event creation - this is purely opportunistic.
 *
 * Supported providers:
 * - none: No external pinning (local IPFS nodes only)
 * - pinata: Pinata.cloud (https://www.pinata.cloud/)
 * - web3storage: Web3.Storage (https://web3.storage/)
 * - custom: Custom pinning endpoint
 */

import fetch from 'node-fetch';

export class PinningProvider {
    /**
     * Create a new pinning provider client
     *
     * @param {Object} config - Configuration
     * @param {string} config.provider - Provider type (none|pinata|web3storage|custom)
     * @param {string} config.token - API token/JWT for provider
     * @param {string} config.endpoint - Custom endpoint URL (for custom provider)
     * @param {number} config.timeout - Request timeout in ms (default: 8000)
     */
    constructor(config = {}) {
        this.provider = config.provider || process.env.PIN_PROVIDER || 'none';
        this.token = config.token || process.env.PIN_PROVIDER_TOKEN;
        this.endpoint = config.endpoint || process.env.PIN_PROVIDER_ENDPOINT;
        this.timeout = config.timeout || parseInt(process.env.PIN_PROVIDER_TIMEOUT_MS || '8000', 10);

        // Validate configuration
        if (this.provider !== 'none') {
            if (['pinata', 'web3storage'].includes(this.provider) && !this.token) {
                console.warn(`⚠️  PIN_PROVIDER=${this.provider} requires PIN_PROVIDER_TOKEN`);
                this.provider = 'none'; // Disable if misconfigured
            }
            if (this.provider === 'custom' && !this.endpoint) {
                console.warn(`⚠️  PIN_PROVIDER=custom requires PIN_PROVIDER_ENDPOINT`);
                this.provider = 'none'; // Disable if misconfigured
            }
        }

        this.stats = {
            attempted: 0,
            succeeded: 0,
            failed: 0
        };
    }

    /**
     * Check if external pinning is enabled
     * @returns {boolean} True if provider is not 'none'
     */
    isEnabled() {
        return this.provider !== 'none';
    }

    /**
     * Pin a CID to the configured external provider (best-effort)
     *
     * @param {string} cid - IPFS CID to pin
     * @param {Object} metadata - Optional metadata about the content
     * @returns {Promise<boolean>} True if pinned successfully, false otherwise
     */
    async pinCid(cid, metadata = {}) {
        if (this.provider === 'none') {
            return false; // No provider configured, skip silently
        }

        this.stats.attempted++;

        try {
            switch (this.provider) {
                case 'pinata':
                    await this.pinToPinata(cid, metadata);
                    break;
                case 'web3storage':
                    await this.pinToWeb3Storage(cid, metadata);
                    break;
                case 'custom':
                    await this.pinToCustom(cid, metadata);
                    break;
                default:
                    throw new Error(`Unknown provider: ${this.provider}`);
            }

            this.stats.succeeded++;
            console.log(`✓ Pinned ${cid} to ${this.provider}`);
            return true;
        } catch (error) {
            this.stats.failed++;
            console.warn(`⚠️  Failed to pin ${cid} to ${this.provider}: ${error.message}`);
            return false;
        }
    }

    /**
     * Pin to Pinata.cloud
     * @private
     */
    async pinToPinata(cid, metadata) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        try {
            const response = await fetch('https://api.pinata.cloud/pinning/pinByHash', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify({
                    hashToPin: cid,
                    pinataMetadata: {
                        name: metadata.name || `polaris-${cid}`,
                        keyvalues: metadata
                    }
                }),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`Pinata API error: ${response.status} ${error}`);
            }

            return await response.json();
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new Error(`Request timeout after ${this.timeout}ms`);
            }
            throw error;
        }
    }

    /**
     * Pin to Web3.Storage
     * @private
     */
    async pinToWeb3Storage(cid, metadata) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        try {
            const response = await fetch('https://api.web3.storage/pins', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify({
                    cid,
                    name: metadata.name || `polaris-${cid}`,
                    meta: metadata
                }),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`Web3.Storage API error: ${response.status} ${error}`);
            }

            return await response.json();
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new Error(`Request timeout after ${this.timeout}ms`);
            }
            throw error;
        }
    }

    /**
     * Pin to custom endpoint
     * @private
     */
    async pinToCustom(cid, metadata) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        try {
            const headers = {
                'Content-Type': 'application/json'
            };

            // Add authorization if token provided
            if (this.token) {
                headers['Authorization'] = `Bearer ${this.token}`;
            }

            const response = await fetch(this.endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify({ cid, ...metadata }),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`Custom endpoint error: ${response.status} ${error}`);
            }

            return await response.json();
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new Error(`Request timeout after ${this.timeout}ms`);
            }
            throw error;
        }
    }

    /**
     * Get pinning statistics
     * @returns {Object} Stats object
     */
    getStats() {
        return {
            ...this.stats,
            provider: this.provider,
            successRate: this.stats.attempted > 0
                ? (this.stats.succeeded / this.stats.attempted * 100).toFixed(2) + '%'
                : '0%'
        };
    }
}

export default PinningProvider;
