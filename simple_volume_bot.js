require('dotenv').config();
const PumpPortalSwapTester = require('./test_pump_portal_swap');
const JupiterSwapTester = require('./test_jupiter_swap');
const logger = require('./logger');
const EventEmitter = require('events');
const {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const bs58 = require('bs58');
const path = require('path');
const web3 = require('@solana/web3.js');
const fetch = require('cross-fetch');
const TransactionConfirmationManager = require('./transaction_confirmation_manager');
const { createClient } = require('@supabase/supabase-js');

class SimpleVolumeBot extends EventEmitter {
  constructor(config = {}) {
    super();

    if (!config.privateKey) {
      throw new Error('Private key is required (though we won’t actually use it if loading from Supabase).');
    }

    this.config = {
      privateKey: config.privateKey,
      rpcEndpoint: config.rpcEndpoint || process.env.SOLANA_RPC_URL,
      slippageBps: config.slippageBps || 500, // default 5% slippage if not set
      priorityFee: config.priorityFee || 0.0001, // default very low fee
      tradeAmountUSD: config.tradeAmountUSD || 0.01,
      minInterval: 15000, // 15 seconds min between trades
      maxInterval: 45000, // 45 seconds max between trades
      confirmationStrategy: config.confirmationStrategy || {
        maxRetries: 40,
        initialBackoffMs: 250,
        maxBackoffMs: 5000,
        commitment: 'confirmed',
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      },
    };

    this.stats = {
      successfulTrades: 0,
      totalTrades: 0,
      startTime: null,
      endTime: null,
    };

    this.isRunning = false;
    this.isStopped = false; // will set true when we fully stop

    // Pump & Jupiter testers
    this.pumpTester = new PumpPortalSwapTester();
    this.jupiterTester = new JupiterSwapTester();

    // Wallet array (loaded from Supabase)
    this.wallets = {
      traders: [],
    };

    // Solana connection
    this.connection = new Connection(this.config.rpcEndpoint, 'confirmed');

    // Confirmation manager
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
          cooldownMs: 2000,
        },
      }
    );

    // Forward confirmation events
    this.confirmationManager.on('confirmationStarted', (signature) => {
      this.emit('confirmationStarted', signature);
    });
    this.confirmationManager.on('confirmationProgress', (status) => {
      this.emit('confirmationProgress', status);
    });
    this.confirmationManager.on('confirmationSuccess', () => {
      this.emit('tradeConfirmed');
    });

    // Supabase client
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_KEY
    );

    // Track intervals so we can clear them on stop
    this.intervals = new Set();
  }

  /**
   * Load existing trader wallets from Supabase
   * and populate `this.wallets.traders` array.
   */
  async loadExistingWallets() {
    try {
      const { data: wallets, error } = await this.supabase
        .from('trader_wallets')
        .select('*')
        .order('wallet_index');

      if (error) {
        logger.error('Failed to load trader wallets from Supabase:', error);
        throw error;
      }
      if (!wallets?.length) {
        throw new Error('No existing wallets found in Supabase');
      }

      // Convert each row to a Keypair
      this.wallets.traders = wallets.map((record) => {
        const kpair = web3.Keypair.fromSecretKey(bs58.decode(record.private_key));
        return kpair;
      });

      logger.info(
        `Successfully loaded ${this.wallets.traders.length} trader wallets from Supabase`
      );
    } catch (err) {
      logger.error('Error loading existing wallets:', err);
      throw err;
    }
  }

  /**
   * Start the bot: run trades in a loop until the duration ends
   * or until user calls stop().
   */
  async start(tokenAddress, duration, tokenType) {
    if (this.isRunning) {
      throw new Error('Bot is already running');
    }
    this.isRunning = true;
    this.isStopped = false; // reset if previously stopped
    this.stats.startTime = Date.now();
    this.stats.endTime = this.stats.startTime + duration;

    logger.info('Starting SimpleVolumeBot with config:');
    logger.info(`- Token Address: ${tokenAddress}`);
    logger.info(`- Platform: ${tokenType}`);
    logger.info(`- Trade Amount: $${this.config.tradeAmountUSD}`);
    logger.info(`- Slippage: ${this.config.slippageBps / 100}%`);
    logger.info(`- Priority Fee: ${this.config.priorityFee} SOL`);
    logger.info(`- Interval: random ${this.config.minInterval / 1000}–${this.config.maxInterval / 1000} s`);
    logger.info(`- Duration: ${duration / 1000 / 60} min`);
    logger.info(`- # Trader Wallets: ${this.wallets.traders.length}`);

    // Divide into groups of 5 for parallel trading
    const walletGroups = [];
    for (let i = 0; i < this.wallets.traders.length; i += 5) {
      walletGroups.push(this.wallets.traders.slice(i, i + 5));
    }

    // Kick off a block height update interval (optional).
    const blockHeightInterval = setInterval(async () => {
      try {
        await this._updateBlockHeight();
      } catch (error) {
        logger.warn(`Failed to update block height: ${error.message}`);
      }
    }, 2000);
    this.intervals.add(blockHeightInterval);

    try {
      while (this.isRunning && Date.now() < this.stats.endTime) {
        await Promise.all(
          walletGroups.map((group) =>
            this._executeGroupTradeCycle(group, tokenAddress, tokenType)
          )
        );

        this._emitStatus();

        // random delay
        const delay =
          Math.floor(Math.random() * (this.config.maxInterval - this.config.minInterval)) +
          this.config.minInterval;
        await this._sleep(delay);
      }
    } catch (err) {
      logger.error('Error in main trading loop:', err);
    }

    this.isRunning = false;
    logger.info('Bot finished running');
    return this.stats;
  }

  /**
   * Stop the bot gracefully.
   * Clears intervals and prevents further RPC calls.
   */
  async stop() {
    logger.info('Stopping bot...');
    this.isRunning = false;
    this.isStopped = true;

    // Clear all setInterval timers
    for (const interval of this.intervals) {
      clearInterval(interval);
    }
    this.intervals.clear();

    logger.info('Bot has been fully stopped');
  }

  /**
   * One group cycle = all wallets in group do a BUY in parallel,
   * then wait 5s, then SELL in parallel.
   */
  async _executeGroupTradeCycle(walletGroup, tokenAddress, tokenType) {
    if (!this.isRunning) return false;

    logger.info(`Executing parallel buys for ${walletGroup.length} wallets`);
    const buyResults = await Promise.all(
      walletGroup.map(async (wallet, index) => {
        // small sequential delay to avoid 429
        if (index > 0) {
          await this._sleep(1000);
        }
        return this._executeSingleTrade(tokenAddress, tokenType, wallet, 'buy');
      })
    );

    // Wait 5s before sells
    await this._sleep(5000);
    if (!this.isRunning) return false;

    logger.info(`Executing parallel sells for ${walletGroup.length} wallets`);
    const sellResults = await Promise.all(
      walletGroup.map(async (wallet, index) => {
        if (index > 0) {
          await this._sleep(1000);
        }
        return this._executeSingleTrade(tokenAddress, tokenType, wallet, 'sell');
      })
    );

    // Tally stats
    const successfulBuys = buyResults.filter(Boolean).length;
    const successfulSells = sellResults.filter(Boolean).length;
    this.stats.successfulTrades += successfulBuys + successfulSells;
    this.stats.totalTrades += walletGroup.length * 2;

    return true;
  }

  /**
   * Execute a single BUY or SELL for a single wallet.
   */
  async _executeSingleTrade(tokenAddress, tokenType, wallet, action) {
    if (!this.isRunning) return false;

    try {
      if (tokenType === 'pump') {
        // PumpPortalSwapTester
        // re-bind the wallet so it uses *this specific trader*
        this.pumpTester.wallet = {
          publicKey: wallet.publicKey,
          secretKey: wallet.secretKey,
          payer: wallet,
        };
        // set priority fee
        this.pumpTester.setPriorityFee(this.config.priorityFee);

        // “buy” or “sell” an approximate USD amount
        await this.pumpTester.executeTrade(tokenAddress, action, this.config.tradeAmountUSD);
      } else {
        // JupiterSwapTester
        this.jupiterTester.wallet = {
          payer: wallet,
          publicKey: wallet.publicKey,
          signTransaction: async (tx) => {
            tx.sign([wallet]);
            return tx;
          },
        };

        // override confirmTransaction with our queue-based manager
        this.jupiterTester.confirmTransaction = async (signature) => {
          return await this._confirmTransaction(signature);
        };

        if (action === 'buy') {
          // convert USD to SOL
          const solPrice = await this.fetchSolPrice();
          const solAmount = this.config.tradeAmountUSD / solPrice;

          await this.jupiterTester.testSwap(
            tokenAddress, // output token
            solAmount,
            'So11111111111111111111111111111111111111112' // inputMint = SOL
          );
        } else {
          // SELL
          // check token balance first
          const accountInfo = await this._checkTokenAccount(tokenAddress, wallet.publicKey);
          if (!accountInfo.exists || accountInfo.balance === 0) {
            logger.warn(`No token balance for wallet ${wallet.publicKey.toString()}`);
            return false;
          }

          // Sell all (or 99%)
          const sellAmount = Math.floor(accountInfo.balance * 1);
          await this.jupiterTester.testSwap(
            'So11111111111111111111111111111111111111112', // outputMint = SOL
            sellAmount, // token units
            tokenAddress,
            { swapMode: 'ExactIn' }
          );
        }
      }

      return true;
    } catch (error) {
      logger.error(
        `Trade failed for wallet ${wallet.publicKey.toString()}: ${error.message}`
      );
      return false;
    }
  }

  /**
   * Confirmation via the transaction confirmation manager.
   */
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

  /**
   * Check token account presence & balance
   */
  async _checkTokenAccount(tokenAddress, walletAddress) {
    try {
      const mintPubkey = new web3.PublicKey(tokenAddress);
      const walletPubkey = new web3.PublicKey(walletAddress);

      const accounts = await this.connection.getTokenAccountsByOwner(walletPubkey, {
        mint: mintPubkey,
      });

      if (accounts.value.length > 0) {
        const balanceInfo = await this.connection.getTokenAccountBalance(accounts.value[0].pubkey);
        return {
          exists: true,
          balance: parseInt(balanceInfo.value.amount, 10),
          account: accounts.value[0].pubkey,
        };
      }
      return { exists: false, balance: 0, account: null };
    } catch (error) {
      logger.error(`Error checking token account: ${error.message}`);
      return { exists: false, balance: 0, account: null };
    }
  }

  /**
   * Fetch SOL price (Coingecko).
   */
  async fetchSolPrice() {
    try {
      const response = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'
      );
      const data = await response.json();
      return data.solana.usd;
    } catch (error) {
      logger.error('Error fetching SOL price:', error);
      // fallback price
      return 230;
    }
  }

  /**
   * Update block height caching to avoid repeated calls
   */
  async _updateBlockHeight() {
    if (this.isStopped) return; // no updates if we've fully stopped

    const blockHeight = await this.connection.getSlot();
    this.currentBlockHeight = blockHeight;
  }

  /**
   * Emit a status log line with how many trades succeeded.
   */
  _emitStatus() {
    const remainingTime = Math.max(0, this.stats.endTime - Date.now());
    const status = {
      successRate: `${this.stats.successfulTrades}/${this.stats.totalTrades}`,
      remainingTime: Math.floor(remainingTime / 1000),
      isRunning: this.isRunning,
    };

    this.emit('status', status);
    logger.info(
      `Status: ${status.successRate} successful trades, ${status.remainingTime}s remaining`
    );
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = SimpleVolumeBot;
