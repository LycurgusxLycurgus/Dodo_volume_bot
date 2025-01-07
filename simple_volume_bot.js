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
            slippageBps: config.slippageBps || 100, // e.g. 10% slippage if 1000 = 100%
            priorityFee: config.priorityFee || 0.001, // default 0.001 SOL
            tradeAmountUSD: config.tradeAmountUSD || 0.01,
            minInterval: config.minInterval || 15000, // 15s
            maxInterval: config.maxInterval || 45000, // 45s
            confirmationStrategy: config.confirmationStrategy || {
                maxRetries: 40,
                commitment: 'confirmed',
                subscribeTimeoutMs: 45000,
                statusCheckInterval: 2000,
                maxBlockHeightAge: 150,
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
        this.isStopped = false; // Additional flag if needed
        this.pumpTester = new PumpPortalSwapTester();
        this.jupiterTester = new JupiterSwapTester();

        // Connection and wallets
        this.connection = new Connection(this.config.rpcEndpoint, 'confirmed');
        this.wallets = {
            main: null,
            traders: []
        };

        // Local DB folder
        this.DB_DIR = path.join(__dirname, 'wallets');

        // Confirmation manager
        this.confirmationManager = new TransactionConfirmationManager(
            this.connection,
            this.config.confirmationStrategy
        );

        // Forward events from confirmation manager if you wish
        this.confirmationManager.on('confirmationStarted', (signature) => {
            this.emit('confirmationStarted', signature);
        });
        this.confirmationManager.on('confirmationProgress', (status) => {
            this.emit('confirmationProgress', status);
        });
        this.confirmationManager.on('confirmationSuccess', () => {
            this.emit('tradeConfirmed');
        });

        // Track active confirmations for cleanup
        this.activeConfirmationManagers = new Set();

        // Track intervals so we can clear them on stop
        this.intervals = new Set();

        // Initialize Supabase
        this.supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_KEY
        );
    }

    async start(tokenAddress, duration, tokenType) {
        if (this.isRunning) {
            throw new Error('Bot is already running');
        }

        // Make sure trader wallets exist
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
        logger.info(
          `- Trade Interval: Random ${this.config.minInterval/1000}-${this.config.maxInterval/1000} seconds`
        );
        logger.info(`- Duration: ${duration / 1000 / 60} minutes`);
        logger.info(`- Number of parallel traders: ${this.wallets.traders.length}`);

        // Create wallet groups of size 5
        const walletGroups = [];
        for (let i = 0; i < this.wallets.traders.length; i += 5) {
            walletGroups.push(this.wallets.traders.slice(i, i + 5));
        }

        // Optional: track block height in an interval
        const blockHeightInterval = setInterval(async () => {
            try {
                await this._updateBlockHeight();
            } catch (err) {
                logger.warn(`Failed to update block height: ${err.message}`);
            }
        }, 1000);
        this.intervals.add(blockHeightInterval);

        try {
            // Main loop
            while (this.isRunning && Date.now() < this.stats.endTime) {
                try {
                    // For each group, do a group trade cycle in parallel
                    await Promise.all(
                        walletGroups.map(group => this._executeGroupTradeCycle(group, tokenAddress, tokenType))
                    );

                    // After parallel group cycles finish, emit status
                    this._emitStatus();

                    // Random delay
                    const delay = Math.floor(
                        Math.random() * (this.config.maxInterval - this.config.minInterval)
                        + this.config.minInterval
                    );
                    await new Promise(res => setTimeout(res, delay));

                } catch (err) {
                    logger.error('Error executing trade cycles:', err);
                    // In case of catastrophic error, increment total trades so it won't freeze stats
                    this.stats.totalTrades += walletGroups.length * 5;
                    this._emitStatus();
                    await new Promise(res => setTimeout(res, 5000));
                }
            }

            // End
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
            // Buy
            logger.info(`Executing parallel buys for ${walletGroup.length} wallets`);
            const buyResults = await Promise.all(
                walletGroup.map(async (wallet, idx) => {
                    // Space out RPC calls by 1s
                    if (idx > 0) {
                        await new Promise(res => setTimeout(res, 1000));
                    }
                    return this._executeSingleTrade(tokenAddress, tokenType, wallet, 'buy');
                })
            );

            // Wait before selling
            await new Promise(res => setTimeout(res, 5000));

            // Sell
            logger.info(`Executing parallel sells for ${walletGroup.length} wallets`);
            const sellResults = await Promise.all(
                walletGroup.map(async (wallet, idx) => {
                    if (idx > 0) {
                        await new Promise(res => setTimeout(res, 1000));
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

    async _executeSingleTrade(tokenAddress, tokenType, wallet, action) {
        try {
            if (!wallet) {
                throw new Error('No wallet provided for trade execution');
            }

            // For Jupiter swaps
            if (tokenType === 'jupiter') {
                const tester = new JupiterSwapTester(this.connection, wallet);

                // Use our queue-based confirmation
                tester.confirmTransaction = async (signature) => {
                    return await this._confirmTransaction(signature);
                };

                if (action === 'buy') {
                    // Convert USD to SOL
                    const solPrice = await this.fetchSolPrice();
                    const solAmount = this.config.tradeAmountUSD / solPrice;

                    await tester.testSwap(
                        tokenAddress, // outputMint (token to buy)
                        solAmount,    // amount in SOL
                        'So11111111111111111111111111111111111111112', // inputMint (SOL)
                        {
                            slippageBps: this.config.slippageBps,
                            priorityFee: this.config.priorityFee
                        }
                    );

                } else if (action === 'sell') {
                    // Check if user even has tokens
                    const accountInfo = await this._checkTokenAccount(tokenAddress, wallet.publicKey);
                    if (!accountInfo.exists || accountInfo.balance === 0) {
                        logger.warn(`No token balance for wallet ${wallet.publicKey.toString()}`);
                        return false;
                    }

                    // Sell 99% of the token to avoid rounding issues
                    await tester.testSwap(
                        'So11111111111111111111111111111111111111112', // outputMint (SOL)
                        accountInfo.balance * 0.99,                 // amount in token units
                        tokenAddress,                                // inputMint (token)
                        {
                            slippageBps: this.config.slippageBps,
                            priorityFee: this.config.priorityFee,
                            swapMode: 'ExactIn'
                        }
                    );
                }

            // For PumpPortal swaps
            } else if (tokenType === 'pump') {
                const tester = new PumpPortalSwapTester();
                // The PumpPortalSwapTester internally references process.env.PRIVATE_KEY
                // but let's override if needed:
                tester.wallet = wallet; // or setPriorityFee, etc.
                tester.setPriorityFee(this.config.priorityFee);

                if (action === 'buy') {
                    await tester.executeTrade(tokenAddress, 'buy', this.config.tradeAmountUSD);
                } else if (action === 'sell') {
                    await tester.executeTrade(tokenAddress, 'sell', this.config.tradeAmountUSD);
                }
            }

            return true;

        } catch (error) {
            logger.error(`Trade failed for wallet ${wallet.publicKey.toString()}: ${error.message}`);
            return false;
        }
    }

    async fetchSolPrice() {
        try {
            const response = await fetch(
                'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'
            );
            const data = await response.json();
            return data.solana.usd;
        } catch (error) {
            logger.error('Error fetching SOL price:', error);
            return 230; // fallback if coingecko fails
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

    async stop() {
        try {
            logger.info('Stopping bot...');

            // This line ensures the while(...) condition breaks:
            this.isRunning = false;

            // Clear all intervals
            for (const interval of this.intervals) {
                clearInterval(interval);
            }
            this.intervals.clear();

            // Stop any active confirmation managers
            if (this.activeConfirmationManagers) {
                for (const manager of this.activeConfirmationManagers) {
                    manager.stop();
                }
                this.activeConfirmationManagers.clear();
            }

            this.isStopped = true;
            logger.info('Bot finished running');

        } catch (error) {
            logger.error('Error stopping bot:', error);
            throw error;
        }
    }

    // --------------
    // WALLET METHODS
    // --------------

    async createTraderWallets(count) {
        try {
            this.wallets.traders = [];
            const mainWalletPubkey = this.wallets.main.publicKey.toString();
            
            for (let i = 0; i < count; i++) {
                const wallet = web3.Keypair.generate();
                this.wallets.traders.push(wallet);

                // Example writing to Supabase if desired
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
                        walletIndex: i
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

    async loadExistingWallets() {
        try {
            const { data: wallets, error } = await this.supabase
                .from('trader_wallets')
                .select('*')
                .order('wallet_index');

            if (error) {
                logger.error('Failed to load trader wallets:', {
                    error: error.message
                });
                throw error;
            }
            if (!wallets?.length) {
                throw new Error('No existing wallets found in database');
            }

            this.wallets.traders = wallets.map(record => {
                return web3.Keypair.fromSecretKey(
                    bs58.decode(record.private_key)
                );
            });

            logger.info('Loaded trader wallets from DB:', {
                count: this.wallets.traders.length
            });
        } catch (error) {
            logger.error('Error loading existing wallets:', error);
            throw error;
        }
    }

    async checkWalletBalance(wallet) {
        try {
            const balance = await this.connection.getBalance(wallet.publicKey);
            return balance / LAMPORTS_PER_SOL;
        } catch (error) {
            logger.error(`Error checking balance: ${error.message}`);
            throw error;
        }
    }

    async fundTraderWallet(traderWallet, amount) {
        const lamports = Math.round(amount * LAMPORTS_PER_SOL);

        const transaction = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: this.wallets.main.publicKey,
                toPubkey: traderWallet.publicKey,
                lamports
            })
        );

        const signature = await this.connection.sendTransaction(
            transaction,
            [this.wallets.main]
        );

        logger.info(`Transaction sent: funding wallet with ${amount} SOL, sig=${signature}`);
        const confirmed = await this._confirmTransaction(signature);
        if (!confirmed) {
            throw new Error('Transaction confirmation failed during funding');
        }
        logger.info(
            `Funded wallet ${traderWallet.publicKey.toString()} with ${amount} SOL`
        );
        return signature;
    }

    async initializeTraderWallets(solPerWallet = 0.01) {
        logger.info('Initializing trader wallets...');

        if (!this.wallets.main || this.wallets.traders.length === 0) {
            throw new Error('Wallets not properly initialized');
        }

        // Check each trader's balance
        const traderBalances = await Promise.all(
            this.wallets.traders.map(async w => {
                const bal = await this.checkWalletBalance(w);
                return { wallet: w, balance: bal };
            })
        );

        // Calculate total needed
        const totalNeeded = traderBalances.reduce((sum, { balance }) => {
            return balance < solPerWallet ? sum + (solPerWallet - balance) : sum;
        }, 0);

        // Check main wallet
        const mainBalance = await this.checkWalletBalance(this.wallets.main);
        if (mainBalance < totalNeeded) {
            throw new Error(`Main wallet has ${mainBalance} SOL, needs ${totalNeeded} SOL`);
        }

        // Fund those that need it
        for (const { wallet, balance } of traderBalances) {
            if (balance < solPerWallet) {
                const needed = solPerWallet - balance;
                await this.fundTraderWallet(wallet, needed);
                await new Promise(res => setTimeout(res, 1000));
            } else {
                logger.info(
                    `Trader wallet ${wallet.publicKey.toString()} already funded: ${balance} SOL`
                );
            }
        }
        logger.info('All trader wallets initialized successfully');
    }

    // -------------
    // CONFIRMATION
    // -------------

    async _confirmTransaction(signature) {
        try {
            const confirmed = await this.confirmationManager.confirmTransaction(signature);
            if (confirmed) {
                logger.info(`Transaction confirmed: ${signature}`);
                return true;
            }
            throw new Error('Transaction confirmation failed');
        } catch (error) {
            logger.error(`Confirmation failed for ${signature}: ${error.message}`);
            throw error;
        }
    }

    // -------------
    // TOKEN HELPERS
    // -------------

    async _checkTokenAccount(tokenAddress, walletPubkey) {
        try {
            const mintPubkey = new web3.PublicKey(tokenAddress);
            const ownerPubkey = new web3.PublicKey(walletPubkey);

            const accounts = await this.connection.getTokenAccountsByOwner(ownerPubkey, {
                mint: mintPubkey
            });

            if (accounts.value.length > 0) {
                const balance = await this.connection.getTokenAccountBalance(accounts.value[0].pubkey);
                return {
                    exists: true,
                    balance: parseFloat(balance.value.amount),
                    account: accounts.value[0].pubkey
                };
            }
            return { exists: false, balance: 0, account: null };

        } catch (error) {
            logger.error(`Error checking token account: ${error.message}`);
            return { exists: false, balance: 0, account: null };
        }
    }

    // -------------
    // BLOCK HEIGHT
    // -------------

    async _updateBlockHeight() {
        if (this.isStopped) return;
        try {
            const slot = await this.connection.getSlot();
            this.currentBlockHeight = slot;
        } catch (error) {
            if (error.message.includes('429')) {
                // If rate-limited, we just skip
                logger.warn('Rate-limited while updating block height');
            } else {
                throw error;
            }
        }
    }
}

module.exports = SimpleVolumeBot;
