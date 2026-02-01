/**
 * Wallet Manager for Polaris Music Registry
 *
 * Handles WharfKit SessionKit integration for wallet connection and transaction signing.
 */

import { SessionKit } from '@wharfkit/session';
import { WebRenderer } from '@wharfkit/web-renderer';
import { WalletPluginAnchor } from '@wharfkit/wallet-plugin-anchor';
import { WalletPluginCloudWallet } from '@wharfkit/wallet-plugin-cloudwallet';
import { POLARIS_ABI } from '../contracts/polarisAbi.js'; // Local ABI fallback for test/dev only
import { CHAIN_ID, RPC_URL, CONTRACT_ACCOUNT, USE_LOCAL_ABI } from '../config/chain.js';

export class WalletManager {
    constructor(config = {}) {
        // Use centralized chain config (prevents config drift between components)
        const chainId = config.chainId || CHAIN_ID;
        const rpcUrl = config.rpcUrl || RPC_URL;
        const contractAccount = config.contractAccount || CONTRACT_ACCOUNT;

        // Runtime guard: ensure config is present when not using local ABI fallback
        if (!USE_LOCAL_ABI && !contractAccount) {
            throw new Error(
                'CONTRACT_ACCOUNT must be set when USE_LOCAL_ABI is false. ' +
                'Set VITE_CONTRACT_ACCOUNT in .env or docker-compose.yml'
            );
        }

        this.config = {
            appName: config.appName || 'Polaris Music Registry',
            chainId,
            rpcUrl,
            contractAccount,
            useLocalAbi: config.useLocalAbi !== undefined ? config.useLocalAbi : USE_LOCAL_ABI,
            ...config
        };

        this.sessionKit = null;
        this.session = null;
        this.publicKey = null; // Cached public key from blockchain
        this.listeners = {
            onConnect: [],
            onDisconnect: [],
            onError: []
        };

        this.init();
    }

    /**
     * Initialize SessionKit
     */
    init() {
        // Define blockchain chains
        const chains = [{
            id: this.config.chainId,
            url: this.config.rpcUrl
        }];

        // Configure wallet plugins
        const walletPlugins = [
            new WalletPluginAnchor(),
            new WalletPluginCloudWallet()
        ];

        // Create SessionKit instance
        this.sessionKit = new SessionKit({
            appName: this.config.appName,
            chains,
            ui: new WebRenderer(),
            walletPlugins
        });

        console.log('WalletManager initialized:', {
            chainId: this.config.chainId,
            rpcUrl: this.config.rpcUrl,
            contractAccount: this.config.contractAccount
        });
    }

    /**
     * Fetch public key from blockchain for the given account and permission
     * @param {string} accountName - Account name
     * @param {string} permission - Permission name (e.g., "active")
     * @returns {Promise<string>} Public key (e.g., "EOS6...")
     * @throws {Error} If account not found or permission not found
     */
    async fetchPublicKey(accountName, permission) {
        try {
            const response = await fetch(`${this.config.rpcUrl}/v1/chain/get_account`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ account_name: accountName })
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch account: ${response.status} ${response.statusText}`);
            }

            const accountData = await response.json();

            // Find the matching permission
            const perm = accountData.permissions.find(p => p.perm_name === permission);
            if (!perm) {
                throw new Error(`Permission '${permission}' not found for account '${accountName}'`);
            }

            // Get the first key from required_auth
            if (!perm.required_auth?.keys?.length) {
                throw new Error(`No keys found in permission '${permission}' for account '${accountName}'`);
            }

            const publicKey = perm.required_auth.keys[0].key;
            console.log(`Fetched public key for ${accountName}@${permission}:`, publicKey);

            return publicKey;
        } catch (error) {
            console.error('Failed to fetch public key:', error);
            throw new Error(`Cannot fetch public key for ${accountName}@${permission}: ${error.message}`);
        }
    }

    /**
     * Connect wallet (login)
     * @returns {Promise<Object>} Session information
     */
    async connect() {
        try {
            console.log('Initiating wallet connection...');
            const response = await this.sessionKit.login();

            if (response && response.session) {
                this.session = response.session;

                const accountName = this.session.actor.toString();
                const permission = this.session.permission.toString();
                const chainId = this.session.chain.id.toString();

                // CRITICAL: Fetch the actual public key from the blockchain
                // This is required for cryptographic signature verification
                this.publicKey = await this.fetchPublicKey(accountName, permission);

                const accountInfo = {
                    accountName,
                    permission,
                    chainId,
                    publicKey: this.publicKey  // Real public key, not account name
                };

                console.log('Wallet connected:', accountInfo);
                this.emit('onConnect', accountInfo);

                return accountInfo;
            }
        } catch (error) {
            console.error('Wallet connection failed:', error);
            this.emit('onError', error);
            throw error;
        }
    }

    /**
     * Disconnect wallet (logout)
     */
    async disconnect() {
        try {
            if (this.session) {
                await this.sessionKit.logout(this.session);
                this.session = null;
                this.publicKey = null;
                console.log('Wallet disconnected');
                this.emit('onDisconnect');
            }
        } catch (error) {
            console.error('Wallet disconnection failed:', error);
            this.emit('onError', error);
        }
    }

    /**
     * Restore session from storage
     * @returns {Promise<Object|null>} Session information if restored
     */
    async restore() {
        try {
            console.log('Attempting to restore session...');
            const response = await this.sessionKit.restore();

            if (response) {
                this.session = response;

                const accountName = this.session.actor.toString();
                const permission = this.session.permission.toString();
                const chainId = this.session.chain.id.toString();

                // CRITICAL: Fetch the actual public key from the blockchain
                // This is required for cryptographic signature verification
                this.publicKey = await this.fetchPublicKey(accountName, permission);

                const accountInfo = {
                    accountName,
                    permission,
                    chainId,
                    publicKey: this.publicKey  // Real public key, not account name
                };

                console.log('Session restored:', accountInfo);
                this.emit('onConnect', accountInfo);

                return accountInfo;
            }

            console.log('No session to restore');
            return null;
        } catch (error) {
            console.error('Session restoration failed:', error);
            return null;
        }
    }

    /**
     * Get current session information
     * @returns {Object|null} Session information or null if not connected
     */
    getSessionInfo() {
        if (!this.session) {
            return null;
        }

        return {
            accountName: this.session.actor.toString(),
            permission: this.session.permission.toString(),
            chainId: this.session.chain.id.toString(),
            publicKey: this.publicKey  // Real public key from blockchain
        };
    }

    /**
     * Check if wallet is connected
     * @returns {boolean}
     */
    isConnected() {
        return this.session !== null;
    }

    /**
     * Get the active session for transactions
     * @returns {Session|null}
     */
    getSession() {
        return this.session;
    }

    /**
     * Perform a transaction
     * @param {Object|Array<Object>} actionsOrAction - Single action or array of actions
     * @returns {Promise<Object>} Transaction result
     */
    async transact(actionsOrAction) {
        if (!this.session) {
            throw new Error('No active session. Please connect your wallet first.');
        }

        // Normalize to array — WharfKit expects { actions: [...] }
        const actions = Array.isArray(actionsOrAction)
            ? actionsOrAction
            : [actionsOrAction];

        try {
            console.log('Transact:', {
                actionCount: actions.length,
                account: actions[0]?.account,
                name: actions[0]?.name,
                actor: actions[0]?.authorization?.[0]?.actor
            });

            // Conditionally provide ABI based on USE_LOCAL_ABI flag
            // Production: WharfKit fetches ABI from deployed contract (no abiProvider)
            // Dev/Test: Use local ABI fallback for resilience
            const transactOptions = this.config.useLocalAbi
                ? {
                    abiProvider: {
                        getAbi: async (account) => {
                            // Convert to string to handle WharfKit Name objects
                            const accountStr = typeof account === 'string'
                                ? account : String(account);
                            if (accountStr === this.config.contractAccount) {
                                return POLARIS_ABI;
                            }
                            return null;
                        }
                    }
                }
                : {}; // No abiProvider - WharfKit fetches from chain

            const result = await this.session.transact({ actions }, transactOptions);

            console.log('Transaction successful:', result);
            return result;
        } catch (error) {
            console.error('Transaction failed:', error);
            this.emit('onError', error);
            throw error;
        }
    }

    /**
     * Sign a message with the wallet's private key
     *
     * Returns an object with both the signature and the public key that
     * produced it (when the wallet provides one). This lets callers detect
     * whether the signing key differs from the pre-fetched author_pubkey
     * (e.g. multi-key permissions where Anchor picks a different key).
     *
     * @param {string} message - Message to sign (typically canonical payload)
     * @returns {Promise<{signature: string, signingKey: string|null}>}
     */
    async signMessage(message) {
        if (!this.session) {
            throw new Error('No active session. Please connect your wallet first.');
        }

        try {
            console.log('Signing message with wallet...');

            // WharfKit's signMessage — some wallet plugins return an object
            // with { signature, publicKey } while others return just the signature.
            const result = await this.session.signMessage(message);

            let signature;
            let signingKey = null;

            if (result && typeof result === 'object' && result.signature) {
                signature = result.signature.toString();
                signingKey = result.publicKey ? result.publicKey.toString() : null;
            } else {
                signature = result.toString();
            }

            console.log('Message signed successfully', {
                signingKey: signingKey || '(not returned by wallet)'
            });

            return { signature, signingKey };
        } catch (error) {
            console.error('Message signing failed:', error);
            this.emit('onError', error);
            throw error;
        }
    }

    /**
     * Add event listener
     * @param {string} event - Event name (onConnect, onDisconnect, onError)
     * @param {Function} callback - Callback function
     */
    on(event, callback) {
        if (this.listeners[event]) {
            this.listeners[event].push(callback);
        }
    }

    /**
     * Remove event listener
     * @param {string} event - Event name
     * @param {Function} callback - Callback function
     */
    off(event, callback) {
        if (this.listeners[event]) {
            this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
        }
    }

    /**
     * Emit event to listeners
     * @param {string} event - Event name
     * @param {*} data - Event data
     */
    emit(event, data) {
        if (this.listeners[event]) {
            this.listeners[event].forEach(callback => callback(data));
        }
    }
}

// Export singleton instance
export const walletManager = new WalletManager();
