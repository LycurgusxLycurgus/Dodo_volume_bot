const { Connection, PublicKey } = require('@solana/web3.js');
const EventEmitter = require('events');
const logger = require('./logger');

class TransactionConfirmationManager extends EventEmitter {
    constructor(connection, config = {}) {
        super();
        this.connection = connection;
        this.config = {
            maxRetries: config.maxRetries || 40,
            commitment: config.commitment || 'confirmed',
            subscribeTimeoutMs: config.subscribeTimeoutMs || 45000,
            statusCheckInterval: config.statusCheckInterval || 2000,
            maxBlockHeightAge: config.maxBlockHeightAge || 150,
            rateLimits: {
                maxParallelRequests: config.maxParallelRequests || 2,
                cooldownMs: config.cooldownMs || 2000
            }
        };

        // Track rate limits
        this.rateLimitState = {
            methodRemaining: 10,
            rpsRemaining: 100,
            nextReset: Date.now() + 1000,
            retryAfter: 0
        };

        // Websocket subscriptions
        this.subscriptions = new Map();
        
        // Active confirmations
        this.pendingConfirmations = new Map();
        
        // Block height tracking
        this.lastKnownBlockHeight = 0;
        this.startBlockHeightTracking();
    }

    async confirmTransaction(signature) {
        return new Promise((resolve, reject) => {
            const confirmation = {
                signature,
                startTime: Date.now(),
                resolve,
                reject,
                attempts: 0,
                subscribed: false,
                statusChecked: false
            };

            this.pendingConfirmations.set(signature, confirmation);
            
            // Start parallel confirmation methods
            this.startWebsocketSubscription(signature);
            this.checkTransactionStatus(signature);
            
            // Set timeout
            setTimeout(() => {
                this.handleConfirmationTimeout(signature);
            }, this.config.subscribeTimeoutMs);
        });
    }

    async startWebsocketSubscription(signature) {
        try {
            const sub = await this.connection.onSignature(
                signature,
                (result) => this.handleWebsocketConfirmation(signature, result),
                this.config.commitment
            );
            this.subscriptions.set(signature, sub);
        } catch (error) {
            logger.warn(`Websocket subscription failed for ${signature}: ${error.message}`);
        }
    }

    async checkTransactionStatus(signature) {
        const confirmation = this.pendingConfirmations.get(signature);
        if (!confirmation) return;

        try {
            // Check rate limits before making request
            if (!this.canMakeRequest()) {
                setTimeout(() => this.checkTransactionStatus(signature), this.rateLimitState.retryAfter);
                return;
            }

            const status = await this.connection.getSignatureStatus(signature);
            this.updateRateLimitsFromHeaders();

            if (status?.value?.err) {
                this.completeConfirmation(signature, new Error(JSON.stringify(status.value.err)));
                return;
            }

            if (status?.value?.confirmationStatus === 'confirmed' || 
                status?.value?.confirmationStatus === 'finalized') {
                this.completeConfirmation(signature, null, true);
                return;
            }

            // Check block height expiration
            if (this.isTransactionExpired(signature)) {
                this.completeConfirmation(signature, new Error('Transaction expired'));
                return;
            }

            // Schedule next check if not confirmed
            setTimeout(
                () => this.checkTransactionStatus(signature),
                this.config.statusCheckInterval
            );

        } catch (error) {
            if (error.message.includes('429')) {
                this.handleRateLimitError(error);
                setTimeout(() => this.checkTransactionStatus(signature), this.rateLimitState.retryAfter);
            } else {
                logger.error(`Status check failed for ${signature}: ${error.message}`);
            }
        }
    }

    updateRateLimitsFromHeaders(headers) {
        if (headers) {
            this.rateLimitState.methodRemaining = parseInt(headers['x-ratelimit-method-remaining'] || 10);
            this.rateLimitState.rpsRemaining = parseInt(headers['x-ratelimit-rps-remaining'] || 100);
            this.rateLimitState.retryAfter = parseInt(headers['retry-after'] || 0) * 1000;
        }
    }

    handleRateLimitError(error) {
        const retryAfter = parseInt(error.headers?.['retry-after'] || 2) * 1000;
        this.rateLimitState.retryAfter = Math.max(retryAfter, 2000);
        logger.warn(`Rate limited. Waiting ${this.rateLimitState.retryAfter}ms`);
    }

    canMakeRequest() {
        return this.rateLimitState.methodRemaining > 0 && 
               this.rateLimitState.rpsRemaining > 0 && 
               Date.now() > this.rateLimitState.nextReset;
    }

    completeConfirmation(signature, error, success = false) {
        const confirmation = this.pendingConfirmations.get(signature);
        if (!confirmation) return;

        // Cleanup
        this.pendingConfirmations.delete(signature);
        const sub = this.subscriptions.get(signature);
        if (sub) {
            this.connection.removeSignatureListener(sub);
            this.subscriptions.delete(signature);
        }

        // Complete the promise
        if (error) {
            confirmation.reject(error);
        } else {
            confirmation.resolve(success);
        }
    }

    async startBlockHeightTracking() {
        try {
            this.lastKnownBlockHeight = await this.connection.getBlockHeight();
            setInterval(async () => {
                try {
                    this.lastKnownBlockHeight = await this.connection.getBlockHeight();
                } catch (error) {
                    logger.warn(`Failed to update block height: ${error.message}`);
                }
            }, 1000);
        } catch (error) {
            logger.error(`Failed to start block height tracking: ${error.message}`);
        }
    }

    isTransactionExpired(signature) {
        const confirmation = this.pendingConfirmations.get(signature);
        if (!confirmation) return true;

        const blocksPassed = this.lastKnownBlockHeight - confirmation.startBlockHeight;
        return blocksPassed > this.config.maxBlockHeightAge;
    }

    handleWebsocketConfirmation(signature, result) {
        if (result.err) {
            this.completeConfirmation(signature, new Error(JSON.stringify(result.err)));
        } else {
            this.completeConfirmation(signature, null, true);
        }
    }

    handleConfirmationTimeout(signature) {
        const confirmation = this.pendingConfirmations.get(signature);
        if (confirmation && Date.now() - confirmation.startTime >= this.config.subscribeTimeoutMs) {
            this.completeConfirmation(signature, new Error('Confirmation timeout'));
        }
    }
}

module.exports = TransactionConfirmationManager; 