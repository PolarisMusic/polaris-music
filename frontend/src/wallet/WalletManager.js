/**
 * Wallet Manager for Polaris Music Registry
 *
 * Handles WharfKit SessionKit integration for wallet connection and transaction signing.
 */

import { SessionKit } from '@wharfkit/session';
import { WebRenderer } from '@wharfkit/web-renderer';
import { WalletPluginAnchor } from '@wharfkit/wallet-plugin-anchor';
import { WalletPluginCloudWallet } from '@wharfkit/wallet-plugin-cloudwallet';

export class WalletManager {
    constructor(config = {}) {
        this.config = {
            appName: config.appName || 'Polaris Music Registry',
            chainId: config.chainId || 'aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906', // EOS mainnet
            rpcUrl: config.rpcUrl || 'https://eos.greymass.com',
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

        console.log('WalletManager initialized');
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
            const result = await this.session.transact({
                action
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
