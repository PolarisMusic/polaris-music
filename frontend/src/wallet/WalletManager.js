/**
 * Wallet Manager for Polaris Music Registry
 *
 * Handles WharfKit SessionKit integration for wallet connection and transaction signing.
 */

import { SessionKit } from '@wharfkit/session';
import { WebRenderer } from '@wharfkit/web-renderer';
import { WalletPluginAnchor } from '@wharfkit/wallet-plugin-anchor';
import { WalletPluginCloudWallet } from '@wharfkit/wallet-plugin-cloudwallet';
import { POLARIS_ABI } from '../contracts/polarisAbi.js';

export class WalletManager {
    constructor(config = {}) {
        // Read from environment variables with Jungle4 testnet as default
        const chainId = config.chainId
            || import.meta.env.VITE_CHAIN_ID
            || '73e4385a2708e6d7048834fbc1079f2fabb17b3c125b146af438971e90716c4d'; // Jungle4 testnet

        const rpcUrl = config.rpcUrl
            || import.meta.env.VITE_RPC_URL
            || 'https://jungle4.greymass.com';

        const contractAccount = config.contractAccount
            || import.meta.env.VITE_CONTRACT_ACCOUNT
            || 'polaris';

        this.config = {
            appName: config.appName || 'Polaris Music Registry',
            chainId,
            rpcUrl,
            contractAccount,
            ...config
        };

        this.sessionKit = null;
        this.session = null;
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
     * Connect wallet (login)
     * @returns {Promise<Object>} Session information
     */
    async connect() {
        try {
            console.log('Initiating wallet connection...');
            const response = await this.sessionKit.login();

            if (response && response.session) {
                this.session = response.session;

                const accountInfo = {
                    accountName: this.session.actor.toString(),
                    permission: this.session.permission.toString(),
                    chainId: this.session.chain.id.toString()
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

                const accountInfo = {
                    accountName: this.session.actor.toString(),
                    permission: this.session.permission.toString(),
                    chainId: this.session.chain.id.toString()
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
            chainId: this.session.chain.id.toString()
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
     * @param {Object} action - Transaction action
     * @returns {Promise<Object>} Transaction result
     */
    async transact(action) {
        if (!this.session) {
            throw new Error('No active session. Please connect your wallet first.');
        }

        try {
            // Provide the ABI directly in the transaction
            const result = await this.session.transact({
                action
            }, {
                abiProvider: {
                    getAbi: async (account) => {
                        // Provide Polaris ABI if requested for configured contract account
                        if (account === this.config.contractAccount) {
                            return POLARIS_ABI;
                        }
                        // Otherwise fetch from blockchain
                        return null;
                    }
                }
            });

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
     * @param {string} message - Message to sign (typically a hash)
     * @returns {Promise<string>} Signature string (e.g., SIG_K1_...)
     */
    async signMessage(message) {
        if (!this.session) {
            throw new Error('No active session. Please connect your wallet first.');
        }

        try {
            console.log('Signing message with wallet...');

            // WharfKit's signMessage method
            const signature = await this.session.signMessage(message);

            console.log('Message signed successfully');
            return signature.toString();
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
