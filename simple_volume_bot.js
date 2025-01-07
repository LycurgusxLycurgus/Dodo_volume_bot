require('dotenv').config();
const PumpPortalSwapTester = require('./test_pump_portal_swap');
const JupiterSwapTester = require('./test_jupiter_swap');
const logger = require('./logger');
const EventEmitter = require('events');
const { 
  Connection, 
  Keypair, 
  LAMPORTS_PER_SOL, 
  SystemProgram, 
  Transaction 
} = require('@solana/web3.js');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');
const web3 = require('@solana/web3.js');
const fetch = require('cross-fetch'); // Ensure cross-fetch is imported if needed
const TransactionConfirmationManager = require('./transaction_confirmation_manager');
const { createClient } = require('@supabase/supabase-js');

class SimpleVolumeBot extends EventEmitter {
    constructor(config = {}) {
        super();
        
        if (!config.privateKey) {
            throw new Error('Private key is required');
        }

        this.config = {
            privateKey: config.privateKey,
            rpcEndpoint: config.rpcEndpoint || process.env.SOLANA_RPC_URL,
            slippageBps: 100, // 10% slippage
            priorityFee: config.priorityFee || 0.001, // Updated to 0.001 SOL default
            tradeAmountUSD: config.tradeAmountUSD || 0.01,
            minInterval: 15000, // 15 seconds minimum between trades
            maxInterval: 45000, // 45 seconds maximum between trades
            confirmationStrategy: config.confirmationStrategy || {
                maxRetries: 40,
                initialBackoffMs: 250,
                maxBackoffMs: 5000,
                commitment: 'confirmed',
                skipPreflight: false,
                preflightCommitment: 'confirmed'
            }
        };

        this.stats = {
            successfulTrades: 0,
            totalTrades: 0,
            startTime: null,
            endTime: null
        };

        this.isRunning = false;
        this.isStopped = false; // We'll set this in stop(), too.
        this.pumpTester = new PumpPortalSwapTester();
        this.jupiterTester = new JupiterSwapTester();

        // Add new wallet management properties
        this.connection = new Connection(this.config.rpcEndpoint, 'confirmed');
        this.wallets = {
            main: null,
            traders: []
        };
        this.DB_DIR = path.join(__dirname, 'wallets');

        // Replace the old confirmation queue with the new manager
        this.confirmationManager = new TransactionConfirmationManager(
            this.connection,
            config.confirmationStrategy || {
                maxRetries: 40,
                commitment: 'confirmed',
                subscribeTimeoutMs: 45000,
                statusCheckInterval: 2000,
                maxBlockHeightAge: 150,
                rateLimits: {
                    maxParallelRequests: 2,
                    cooldownMs: 2000
                }
            }
        );

        // Add confirmation event forwarding
        this.confirmationManager.on('confirmationStarted', (signature) => {
            this.emit('confirmationStarted', signature);
        });

        this.confirmationManager.on('confirmationProgress', (status) => {
            this.emit('confirmationProgress', status);
        });

        this.confirmationManager.on('confirmationSuccess', () => {
            this.emit('tradeConfirmed');
        });

        // Initialize Supabase client
        this.supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_KEY
        );

        // Add tracking for active confirmation managers
        this.activeConfirmationManagers = new Set();

        // Add interval tracking
        this.intervals = new Set();
    }

    async promptForTokenType() {
        // Note: In a real implementation, this would be handled by the frontend
        return new Promise(resolve => {
            logger.info('Please specify the token type:');
            logger.info('1. PumpFun (Bonding Curve)');
            logger.info('2. Raydium/Jupiter');
            // Frontend would handle this input
            resolve('pump'); // or 'jupiter'
        });
    }

    async promptForDuration() {
        // Note: In a real implementation, this would be handled by the frontend
        return new Promise(resolve => {
            logger.info('Please select duration:');
            logger.info('1. 5 minutes');
            logger.info('2. 1 hour');
            logger.info('3. 4 hours');
            // Frontend would handle this input
            resolve(5 * 60 * 1000); // Duration in milliseconds
        });
    }

    async start(tokenAddress, duration, tokenType) {
        if (this.isRunning) {
            throw new Error('Bot is already running');
        }

        // Initialize trader wallets if not already done
        if (this.wallets.traders.length === 0) {
            await this.initializeTraderWallets();
        }

        this.isRunning = true;
        this.stats.startTime = Date.now();
        this.stats.endTime = this.stats.startTime + duration;

        logger.info('Starting SimpleVolumeBot with configuration:');
        logger.info(`- Token Address: ${tokenAddress}`);
        logger.info(`- Platform: ${tokenType}`);
        logger.info(`- Trade Amount: $${this.config.tradeAmountUSD}`);
        logger.info(`- Slippage: ${this.config.slippageBps / 100}%`);
        logger.info(`- Priority Fee: ${this.config.priorityFee} SOL`);
        logger.info(`- Trade Interval: Random ${this.config.minInterval/1000}-${this.config.maxInterval/1000} seconds`);
        logger.info(`- Duration: ${duration / 1000 / 60} minutes`);
        logger.info(`- Number of parallel traders: ${this.wallets.traders.length}`);

        // Create trading groups (5 wallets per group)
        const walletGroups = [];
        for (let i = 0; i < this.wallets.traders.length; i += 5) {
            walletGroups.push(this.wallets.traders.slice(i, i + 5));
        }

        try {
            // Track the block height update interval
            const blockHeightInterval = setInterval(async () => {
                try {
                    await this._updateBlockHeight();
                } catch (error) {
                    logger.warn(`Failed to update block height: ${error.message}`);
                }
            }, this.config.blockHeightUpdateInterval || 1000);
            
            this.intervals.add(blockHeightInterval);

            while (this.isRunning && Date.now() < this.stats.endTime) {
                try {
                    // Execute trades in parallel for each group
                    await Promise.all(
                        walletGroups.map(group => this._executeGroupTradeCycle(group, tokenAddress, tokenType))
                    );
                    
                    // Update and emit stats
                    this._emitStatus();
                    
                    // Random delay between group trades
                    const delay = Math.floor(
                        Math.random() * (this.config.maxInterval - this.config.minInterval) 
                        + this.config.minInterval
                    );
                    await new Promise(resolve => setTimeout(resolve, delay));
                } catch (error) {
                    logger.error('Error executing trade cycles:', error);
                    this.stats.totalTrades += walletGroups.length * 5; // Count failed attempts
                    this._emitStatus();
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }

            this.isRunning = false;
            logger.info('Bot finished running');
            return this.stats;
        } catch (error) {
            logger.error('Error starting bot:', error);
            throw error;
        }
    }

    async _executeGroupTradeCycle(walletGroup, tokenAddress, tokenType) {
        try {
            // Execute buys in parallel but with delay between requests
            logger.info(`Executing parallel buys for ${walletGroup.length} wallets`);
            const buyResults = await Promise.all(
                walletGroup.map(async (wallet, index) => {
                    // Add delay between requests
                    if (index > 0) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                    return this._executeSingleTrade(tokenAddress, tokenType, wallet, 'buy');
                })
            );

            // Wait 5 seconds before selling
            await new Promise(resolve => setTimeout(resolve, 5000));

            // Execute sells in parallel but with delay between requests
            logger.info(`Executing parallel sells for ${walletGroup.length} wallets`);
            const sellResults = await Promise.all(
                walletGroup.map(async (wallet, index) => {
                    // Add delay between requests
                    if (index > 0) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                    return this._executeSingleTrade(tokenAddress, tokenType, wallet, 'sell');
                })
            );

            // Update stats
            this.stats.successfulTrades +=
                buyResults.filter(Boolean).length + sellResults.filter(Boolean).length;
            this.stats.totalTrades += walletGroup.length * 2;

            return true;
        } catch (error) {
            logger.error('Trade cycle failed:', error);
            return false;
        }
    }

    // New helper method to execute a single trade
    async _executeSingleTrade(tokenAddress, tokenType, wallet, action) {
        try {
            if (!wallet) {
                throw new Error('No wallet provided for trade execution');
            }

            // For Jupiter swaps
            if (tokenType === 'jupiter') {
                const tester = new JupiterSwapTester(this.connection, wallet);
                
                // Set proper confirmation strategy
                tester.confirmTransaction = async (signature) => {
                    return await this._confirmTransaction(signature);
                };

                // --- FIX #1: use lowercase checks for action ---
                if (action === 'buy') {
                    // Get SOL price for USD conversion
                    const solPrice = await this.fetchSolPrice();
                    const solAmount = this.config.tradeAmountUSD / solPrice;
                    
                    await tester.testSwap(
                        tokenAddress, // Output mint (token we're buying)
                        solAmount,    // Amount in SOL
                        'So11111111111111111111111111111111111111112', // Input mint (SOL)
                        {
                            slippageBps: this.config.slippageBps,
                            priorityFee: this.config.priorityFee
                        }
                    );
                } else if (action === 'sell') {
                    // Check token balance before selling
                    const accountInfo = await this._checkTokenAccount(tokenAddress, wallet.publicKey);
                    if (!accountInfo.exists || accountInfo.balance === 0) {
                        logger.warn(`No token balance for wallet ${wallet.publicKey.toString()}`);
                        return false;
                    }

                    await tester.testSwap(
                        'So11111111111111111111111111111111111111112', // Output mint (SOL)
                        accountInfo.balance * 0.99, // Sell 99% of balance
                        tokenAddress, // Input mint (token)
                        {
                            slippageBps: this.config.slippageBps,
                            priorityFee: this.config.priorityFee,
                            swapMode: 'ExactIn'
                        }
                    );
                }
            } 
            // For PumpPortal swaps
            else if (tokenType === 'pump') {
                // Reuse the PumpPortalSwapTester
                const tester = new PumpPortalSwapTester();
                // The constructor picks up PRIVATE_KEY from the .env, but we want to override with the trader's wallet
                tester.wallet = {
                    publicKey: wallet.publicKey,
                    secretKey: wallet.secretKey,
                    payer: wallet
                };
                // Also set custom priority fee
                tester.setPriorityFee(this.config.priorityFee);

                if (action === 'buy') {
                    await tester.executeTrade(tokenAddress, 'buy', this.config.tradeAmountUSD);
                } else if (action === 'sell') {
                    await tester.executeTrade(tokenAddress, 'sell', this.config.tradeAmountUSD);
                }
            }
            // If more swap types in future, handle here.

            return true;
        } catch (error) {
            logger.error(`Trade failed for wallet ${wallet.publicKey.toString()}: ${error.message}`);
            return false;
        }
    }

    // Add helper method to fetch SOL price
    async fetchSolPrice() {
        try {
            const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
            const data = await response.json();
            return data.solana.usd;
        } catch (error) {
            logger.error('Error fetching SOL price:', error);
            return 230; // Fallback price
        }
    }

    // Update _executeTradeCycle to use the new pattern
    async _executeTradeCycle(tokenAddress, tokenType, wallet = null) {
        this.stats.totalTrades++;
        
        try {
            // Execute buy and sell sequentially for single wallet
            await this._executeSingleTrade(tokenAddress, tokenType, wallet, 'buy');
            await new Promise(resolve => setTimeout(resolve, 5000));
            await this._executeSingleTrade(tokenAddress, tokenType, wallet, 'sell');
            
            return true;
        } catch (error) {
            logger.error(`Trade cycle failed for wallet ${wallet?.publicKey.toString()}: ${error.message}`);
            return false;
        }
    }

    _emitStatus() {
        const remainingTime = Math.max(0, this.stats.endTime - Date.now());
        const status = {
            successRate: `${this.stats.successfulTrades}/${this.stats.totalTrades}`,
            remainingTime: Math.floor(remainingTime / 1000),
            isRunning: this.isRunning
        };
        
        this.emit('status', status);
        logger.info(
            `Status: ${status.successRate} successful trades, ` +
            `${status.remainingTime}s remaining`
        );
    }

    // --- FIX #2: set isRunning = false so the while() loop can end ---
    async stop() {
        try {
            logger.info('Stopping bot...');
            
            // Clear all intervals
            for (const interval of this.intervals) {
                clearInterval(interval);
            }
            this.intervals.clear();

            // Clear any active confirmation managers
            if (this.activeConfirmationManagers) {
                for (const manager of this.activeConfirmationManagers) {
                    manager.stop();
                }
                this.activeConfirmationManagers.clear();
            }

            // Add a flag to indicate the bot is stopped
            this.isStopped = true;
            this.isRunning = false;  // <-- This ensures the main loop in start() breaks
            
            logger.info('Bot finished running');
        } catch (error) {
            logger.error('Error stopping bot:', error);
            throw error;
        }
    }

    // New method to create trader wallets
    async createTraderWallets(count) {
        try {
            this.wallets.traders = [];
            const mainWalletPubkey = this.wallets.main.publicKey.toString();
            
            for (let i = 0; i < count; i++) {
                const wallet = web3.Keypair.generate();
                this.wallets.traders.push(wallet);

                // Save to Supabase with new schema
                const { error } = await this.supabase
                    .from('trader_wallets')
                    .insert({
                        trader_pubkey: wallet.publicKey.toString(),
                        wallet_index: i,
                        private_key: bs58.encode(wallet.secretKey),
                        main_wallet_pubkey: mainWalletPubkey
                    });

                if (error) {
                    logger.error('Failed to save trader wallet:', {
                        error: error.message,
                        walletIndex: i,
                        traderPubkey: wallet.publicKey.toString()
                    });
                    throw error;
                }
            }

            logger.info(`Created ${count} new trader wallets and saved to Supabase`);
        } catch (error) {
            logger.error('Error creating and saving trader wallets:', error);
            throw error;
        }
    }

    // New method to check wallet balance
    async checkWalletBalance(wallet) {
        try {
            const balance = await this.connection.getBalance(wallet.publicKey);
            return balance / LAMPORTS_PER_SOL;
        } catch (error) {
            logger.error(`Error checking balance: ${error.message}`);
            throw error;
        }
    }

    // New method to fund a trader wallet with retry logic
    async fundTraderWallet(traderWallet, amount) {
        const maxRetries = 3;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const lamports = Math.round(amount * LAMPORTS_PER_SOL);
                
                const transaction = new Transaction().add(
                    SystemProgram.transfer({
                        fromPubkey: this.wallets.main.publicKey,
                        toPubkey: traderWallet.publicKey,
                        lamports: lamports,
                    })
                );

                const signature = await this.connection.sendTransaction(
                    transaction,
                    [this.wallets.main]
                );

                logger.info(`Funding attempt ${attempt}: Transaction sent with signature ${signature}`);

                // Use new confirmation method
                const confirmed = await this._confirmTransaction(signature);
                
                if (confirmed) {
                    logger.info(
                        `Funded wallet ${traderWallet.publicKey.toString()} with ${amount} SOL`
                    );
                    return signature;
                }

            } catch (error) {
                if (attempt === maxRetries) {
                    logger.error(`All funding attempts failed: ${error.message}`);
                    throw error;
                }
                logger.warn(`Attempt ${attempt} failed: ${error.message}, retrying...`);
                await new Promise(resolve => setTimeout(resolve, attempt * 2000));
            }
        }
    }

    // New method to initialize all trader wallets with funds
    async initializeTraderWallets(solPerWallet = 0.01) {
        logger.info('Initializing trader wallets...');
        
        if (!this.wallets.main || this.wallets.traders.length === 0) {
            throw new Error('Wallets not properly initialized');
        }

        // First check all trader wallet balances
        const traderBalances = await Promise.all(
            this.wallets.traders.map(async wallet => {
                const balance = await this.checkWalletBalance(wallet);
                return { wallet, balance };
            })
        );

        // Calculate how much total SOL needed
        const fundingNeeded = traderBalances.reduce((total, { balance }) => {
            const needed = balance < solPerWallet ? solPerWallet - balance : 0;
            return total + needed;
        }, 0);

        if (fundingNeeded > 0) {
            // Check main wallet balance
            const mainBalance = await this.checkWalletBalance(this.wallets.main);
            
            if (mainBalance < fundingNeeded) {
                throw new Error(
                    `Insufficient balance in main wallet. Need ${fundingNeeded} SOL, has ${mainBalance} SOL`
                );
            }

            // Fund only wallets that need it
            for (const { wallet, balance } of traderBalances) {
                if (balance < solPerWallet) {
                    const needed = solPerWallet - balance;
                    await this.fundTraderWallet(wallet, needed);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } else {
                    logger.info(
                        `Trader wallet ${wallet.publicKey.toString()} already has sufficient balance: ${balance} SOL`
                    );
                }
            }
        } else {
            logger.info('All trader wallets already have sufficient balance');
        }

        logger.info('All trader wallets initialized successfully');
    }

    // Add new method to load existing wallets
    async loadExistingWallets() {
        try {
            const { data: wallets, error } = await this.supabase
                .from('trader_wallets')
                .select('*')
                .order('wallet_index');

            if (error) {
                logger.error('Failed to load trader wallets:', {
                    error: error.message,
                    code: error.code,
                    details: error.details
                });
                throw error;
            }

            if (!wallets?.length) {
                throw new Error('No existing wallets found in database');
            }

            this.wallets.traders = wallets.map(record => {
                try {
                    return web3.Keypair.fromSecretKey(
                        bs58.decode(record.private_key)
                    );
                } catch (err) {
                    logger.error('Failed to decode wallet private key:', {
                        walletIndex: record.wallet_index,
                        error: err.message
                    });
                    throw err;
                }
            });

            logger.info('Successfully loaded trader wallets:', {
                count: this.wallets.traders.length,
                indexes: wallets.map(w => w.wallet_index),
                pubkeys: wallets.map(w => w.trader_pubkey)
            });
        } catch (error) {
            logger.error('Error loading existing wallets from Supabase:', error);
            throw error;
        }
    }

    // Add helper method to get token balance
    async _getTokenBalance(tokenAddress, walletAddress) {
        try {
            const mintPubkey = new web3.PublicKey(tokenAddress);
            const walletPubkey = new web3.PublicKey(walletAddress);

            const response = await this.connection.getTokenAccountsByOwner(walletPubkey, {
                mint: mintPubkey
            });

            if (response.value.length === 0) {
                return 0;
            }

            const tokenAccount = response.value[0];
            const accountInfo = await this.connection.getTokenAccountBalance(tokenAccount.pubkey);
            return accountInfo.value.amount;
        } catch (error) {
            logger.error(`Error getting token balance: ${error.message}`);
            throw error;
        }
    }

    // Replace _confirmTransaction with queue-based version
    async _confirmTransaction(signature) {
        try {
            // Use exponential backoff for confirmations
            const maxRetries = 5;
            let attempt = 0;
            let delay = 1000;

            while (attempt < maxRetries) {
                try {
                    const confirmed = await this.confirmationManager.confirmTransaction(signature);
                    if (confirmed) {
                        logger.info(`Transaction confirmed: ${signature}`);
                        return true;
                    }
                } catch (error) {
                    if (error.message.includes('429')) {
                        attempt++;
                        await new Promise(resolve => setTimeout(resolve, delay));
                        delay *= 2; // Exponential backoff
                        continue;
                    }
                    throw error;
                }
            }
            throw new Error('Transaction confirmation failed after retries');
        } catch (error) {
            logger.error(`Confirmation failed for ${signature}: ${error.message}`);
            throw error;
        }
    }

    // Add token account check before selling
    async _checkTokenAccount(tokenAddress, walletAddress) {
        try {
            const mintPubkey = new web3.PublicKey(tokenAddress);
            const walletPubkey = new web3.PublicKey(walletAddress);
            
            // Get token accounts
            const accounts = await this.connection.getTokenAccountsByOwner(
                walletPubkey,
                { mint: mintPubkey }
            );

            // Return if account exists and has balance
            if (accounts.value.length > 0) {
                const balance = await this.connection.getTokenAccountBalance(accounts.value[0].pubkey);
                return {
                    exists: true,
                    balance: balance.value.amount,
                    account: accounts.value[0].pubkey
                };
            }

            return { exists: false, balance: 0, account: null };
        } catch (error) {
            logger.error(`Error checking token account: ${error.message}`);
            return { exists: false, balance: 0, account: null };
        }
    }

    // Modify _updateBlockHeight to respect the stopped state
    async _updateBlockHeight() {
        if (this.isStopped) {
            return;
        }

        try {
            // Use cached block height if available and recent
            const now = Date.now();
            if (this.lastBlockHeightUpdate && 
                now - this.lastBlockHeightUpdate < 2000 && 
                this.currentBlockHeight) {
                return this.currentBlockHeight;
            }

            const blockHeight = await this.connection.getSlot();
            this.currentBlockHeight = blockHeight;
            this.lastBlockHeightUpdate = now;
            return blockHeight;
        } catch (error) {
            if (error.message.includes('429')) {
                // Use cached value if rate limited
                if (this.currentBlockHeight) {
                    return this.currentBlockHeight;
                }
            }
            throw error;
        }
    }
}

module.exports = SimpleVolumeBot;