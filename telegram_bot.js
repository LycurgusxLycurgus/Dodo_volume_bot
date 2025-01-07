/*******************************************************************
 * File: telegram_bot.js
 * 
 * Telegram Bot that replicates the UX from app_simple_volume_bot.js
 * using node-telegram-bot-api. It asks the user all the same 
 * questions and, once confirmed, starts the trading logic from
 * SimpleVolumeBot.
 *
 * CHANGES:
 * - Added /stop command and inline "Stop Bot" button to stop trading.
 * - Added setMyCommands() so the menu (left of chat box) shows commands.
 * - Added dynamic message that updates with how many trades have passed.
 *******************************************************************/

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const SimpleVolumeBot = require('./simple_volume_bot');
const logger = require('./logger');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const express = require('express');
const app = express();
const port = process.env.PORT || 10000;
const { createClient } = require('@supabase/supabase-js');

// Env variables we need:
// - TG_BOT_TOKEN (your Telegram Bot token from BotFather)
// - PRIVATE_KEY
// - SOLANA_RPC_URL
// (Already in .env for the trading logic; just add TG_BOT_TOKEN)

if (!process.env.TG_BOT_TOKEN) {
  throw new Error('TG_BOT_TOKEN is not defined in your .env');
}

// Create Telegram bot instance
// If you want to use webhook, remove polling: true.
const bot = new TelegramBot(process.env.TG_BOT_TOKEN, {
  polling: true,
});

// === [NEW] Set up commands so they appear in the Telegram menu. ===
bot.setMyCommands([
  { command: '/start', description: 'Start the bot (greeting)' },
  { command: '/begin', description: 'Begin volume trading setup' },
  { command: '/stop',  description: 'Stop the current volume bot' },
]);

// We'll store per-user state in memory. For production, use a DB.
const userSessions = {};

// "wallets" DB directory for loading/writing trader wallets
const DB_DIR = path.join(__dirname, 'wallets');

// === Helper to get or create session for each chatId ===
function getSession(chatId) {
  if (!userSessions[chatId]) {
    userSessions[chatId] = {
      // We'll replicate the question flow from the CLI
      useExisting: null,
      numWallets: 5,
      solPerWallet: 0.01,
      platform: 'pump',      // or 'jupiter'
      tokenAddress: '',
      tradeAmountUSD: 0.01,
      priorityFee: 0.0001,
      slippage: 5,           // in percent
      duration: 6,           // in hours
      confirmation: false,
      step: 0,               // track which step of the wizard
      volumeBot: null,       // We'll store the active volumeBot here
      statusMessageId: null, // For dynamic edit of status
    };
  }
  return userSessions[chatId];
}

// === Command: /stop ===
// Allows the user to stop the volume bot manually.
bot.onText(/\/stop/, async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  if (session.volumeBot && session.volumeBot.isRunning) {
    session.volumeBot.stop();
    await bot.sendMessage(chatId, 'Volume bot has been stopped.');
  } else {
    await bot.sendMessage(chatId, 'No active volume bot to stop.');
  }
});

// === Command: /start ===
// This is the entrypoint. We'll greet the user and begin the wizard.
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  // Reset session each time /start is called
  userSessions[chatId] = {
    ...session,
    step: 0,
    volumeBot: null,
    statusMessageId: null
  };

  await bot.sendMessage(
    chatId,
    `Welcome to the Volume Trader Telegram Bot!\n` +
    `I will guide you through the same flow as the CLI-based prompts.\n\n` +
    `Type /begin to start setting up your trader configuration.`
  );
});

// === Command: /begin ===
// Start step 1. Check existing wallets:
bot.onText(/\/begin/, async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  // Count existing wallets from Supabase
  let existingWalletCount = 0;
  try {
    // Query Supabase for trader wallets
    const { data: wallets, error } = await supabase
      .from('wallets')
      .select('*')
      .like('name', 'trader_%');

    if (error) {
      throw error;
    }

    existingWalletCount = wallets.length;
    
    // Store the wallets data for later use
    session.existingWallets = wallets;
    
  } catch (error) {
    logger.warn('Error checking existing wallets in Supabase:', error);
  }

  // Store the count in the session
  session.existingWalletCount = existingWalletCount;
  session.step = 1;

  await bot.sendMessage(
    chatId,
    `Found ${existingWalletCount} existing trader wallet(s).\n` +
    `Would you like to use them?`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Yes, use existing', callback_data: 'useExisting_yes' },
            { text: 'No, create new', callback_data: 'useExisting_no' },
          ],
        ],
      },
    }
  );
});

// === Callback for step 1: use existing wallets or not ===
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const session = getSession(chatId);

  // [NEW] If user clicked "Stop Bot"
  if (data === 'stop_bot') {
    if (session.volumeBot && session.volumeBot.isRunning) {
      session.volumeBot.stop();
      await bot.sendMessage(chatId, 'Volume bot has been stopped via inline button.');
    } else {
      await bot.sendMessage(chatId, 'No active volume bot to stop.');
    }
    await bot.answerCallbackQuery(query.id);
    return; // Stop processing further
  }

  // If the user is in step 1
  if (session.step === 1) {
    if (data === 'useExisting_yes') {
      session.useExisting = true;
      // Set numWallets to the actual count of existing wallets
      session.numWallets = session.existingWalletCount;
    } else if (data === 'useExisting_no') {
      session.useExisting = false;
    } else {
      return; // ignore other callbacks not relevant here
    }

    // Acknowledge the button press
    await bot.answerCallbackQuery(query.id, { text: 'Got it!' });

    // Next step: if user selected NO, we must ask how many wallets
    if (!session.useExisting) {
      session.step = 2;
      await bot.sendMessage(
        chatId,
        `Great! How many trader wallets do you want to create? (2-10)`,
        { reply_markup: { force_reply: true } }
      );
    } else {
      // If user selected YES, skip step 2 and go straight to step 3
      session.step = 3;
      await bot.sendMessage(
        chatId,
        `How much SOL per trader wallet do you want to allocate?\n(e.g. 0.01)`,
        { reply_markup: { force_reply: true } }
      );
    }
  }
});

// === Step 2 & Step 3: numeric inputs (numWallets, solPerWallet) ===
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  const text = msg.text?.trim();

  // Step 2: "How many trader wallets do you want to create?"
  if (session.step === 2 && !isNaN(text)) {
    // Validate
    const numVal = parseInt(text);
    if (numVal < 2 || numVal > 10) {
      await bot.sendMessage(
        chatId,
        `Invalid. Please enter a number between 2 and 10.`
      );
      return;
    }
    session.numWallets = numVal;
    session.step = 3;
    await bot.sendMessage(
      chatId,
      `How much SOL per trader wallet do you want to allocate?\n(e.g. 0.01)`
    );
    return;
  }

  // Step 3: "How much SOL per trader wallet?"
  if (session.step === 3 && !isNaN(text)) {
    const solVal = parseFloat(text);
    if (solVal < 0.001) {
      await bot.sendMessage(
        chatId,
        `Please enter a value >= 0.001 SOL. Try again.`
      );
      return;
    }
    session.solPerWallet = solVal;

    // Next step: ask for platform
    session.step = 4;
    await bot.sendMessage(chatId, `Which trading platform do you want to use?`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'PumpFun (Bonding Curve)', callback_data: 'platform_pump' },
            { text: 'Raydium/Jupiter', callback_data: 'platform_jupiter' },
          ],
        ],
      },
    });
    return;
  }

  // Step 5: token address
  if (session.step === 5) {
    // Simple check for something that looks like a Solana address
    if (text.length < 32) {
      await bot.sendMessage(chatId, `That doesn't look like a valid Solana mint. Try again:`);
      return;
    }
    session.tokenAddress = text;

    // Next step: trade amount
    session.step = 6;
    await bot.sendMessage(chatId, `Enter trade amount in USD (e.g. 0.01):`);
    return;
  }

  // Step 6: tradeAmountUSD
  if (session.step === 6) {
    if (isNaN(text)) {
      await bot.sendMessage(chatId, `Please enter a valid number:`);
      return;
    }
    session.tradeAmountUSD = parseFloat(text);

    // Next: priority fee selection
    session.step = 7;
    await bot.sendMessage(chatId, `Select priority fee:`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Very Low (0.0001)', callback_data: 'pf_0.0001' }],
          [{ text: 'Low (0.0005)', callback_data: 'pf_0.0005' }],
          [{ text: 'Medium (0.001)', callback_data: 'pf_0.001' }],
          [{ text: 'High (0.002)', callback_data: 'pf_0.002' }],
        ],
      },
    });
    return;
  }
});

// === Step 4: Platform selection ===
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const session = getSession(chatId);

  // If user is in step 4 (platform)
  if (session.step === 4) {
    if (data === 'platform_pump') {
      session.platform = 'pump';
    } else if (data === 'platform_jupiter') {
      session.platform = 'jupiter';
    } else {
      return;
    }
    await bot.answerCallbackQuery(query.id, { text: 'Platform selected' });

    // Next step: ask for token mint address
    session.step = 5;
    await bot.sendMessage(chatId, `Enter the token mint address:`, {
      reply_markup: { force_reply: true },
    });
  }
});

// === Step 7: Priority fee selection ===
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const session = getSession(chatId);

  if (session.step === 7 && data.startsWith('pf_')) {
    session.priorityFee = parseFloat(data.replace('pf_', ''));
    await bot.answerCallbackQuery(query.id, { text: 'Priority fee selected' });

    // Next step: slippage selection
    session.step = 8;
    await bot.sendMessage(chatId, `Select slippage tolerance:`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '5%', callback_data: 'slippage_5' }],
          [{ text: '10%', callback_data: 'slippage_10' }],
          [{ text: '15%', callback_data: 'slippage_15' }],
        ],
      },
    });
  }
});

// === Step 8: Slippage selection ===
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const session = getSession(chatId);

  if (session.step === 8 && data.startsWith('slippage_')) {
    session.slippage = parseFloat(data.replace('slippage_', ''));
    await bot.answerCallbackQuery(query.id, { text: 'Slippage selected' });

    // Next: duration
    session.step = 9;
    await bot.sendMessage(chatId, `Select trading duration:`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '6 hours', callback_data: 'dur_6' }],
          [{ text: '12 hours', callback_data: 'dur_12' }],
          [{ text: '24 hours', callback_data: 'dur_24' }],
        ],
      },
    });
  }
});

// === Step 9: Duration selection ===
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const session = getSession(chatId);

  if (session.step === 9 && data.startsWith('dur_')) {
    session.duration = parseFloat(data.replace('dur_', ''));
    await bot.answerCallbackQuery(query.id, { text: 'Duration selected' });

    // Next: show summary and confirm
    session.step = 10;

    const summary = 
      `Configuration Summary:\n` +
      `-----------------------\n` +
      `Use Existing Wallets: ${session.useExisting}\n` +
      `Number of Trader Wallets: ${session.numWallets}\n` +
      `SOL per Trader Wallet: ${session.solPerWallet}\n` +
      `Platform: ${session.platform}\n` +
      `Token Address: ${session.tokenAddress}\n` +
      `Trade Amount (USD): ${session.tradeAmountUSD}\n` +
      `Priority Fee (SOL): ${session.priorityFee}\n` +
      `Slippage: ${session.slippage}%\n` +
      `Duration: ${session.duration} hours\n`;

    await bot.sendMessage(chatId, summary);
    await bot.sendMessage(chatId, `Start trading with these settings?`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Yes, start now!', callback_data: 'confirm_start' },
            { text: 'No, cancel.', callback_data: 'confirm_cancel' },
          ],
        ],
      },
    });
  }
});

// === Step 10: Confirm or Cancel ===
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const session = getSession(chatId);

  if (session.step === 10) {
    if (data === 'confirm_start') {
      session.confirmation = true;
      await bot.answerCallbackQuery(query.id, { text: 'Starting...' });

      // Enhanced configuration with proper confirmation strategy
      const config = {
        privateKey: process.env.PRIVATE_KEY,
        rpcEndpoint: process.env.SOLANA_RPC_URL,
        tradeAmountUSD: session.tradeAmountUSD,
        priorityFee: session.priorityFee,
        slippageBps: session.slippage * 100,
        confirmationStrategy: {
          // Following confirmation_tips.md recommendations
          commitment: 'confirmed',
          preflightCommitment: 'confirmed',
          maxRetries: 40,
          skipPreflight: false,
          // Enhanced parallel confirmation strategy
          parallelConfirmation: {
            useSignatureSubscribe: true,
            useGetSignatureStatus: true,
            subscribeTimeoutMs: 45000,
            statusCheckInterval: 2000,
          },
          // Block height tracking
          blockHeightTracking: {
            enabled: true,
            maxBlockHeightAge: 150,
            checkInterval: 1000,
          },
          // Rate limiting protection
          rateLimiting: {
            maxParallelRequests: 2,
            cooldownMs: 2000,
            requestsPerInterval: 4,
            intervalMs: 1000,
          },
          // Enhanced backoff for 429s
          backoff: {
            initialDelayMs: 1000,
            maxDelayMs: 15000,
            multiplier: 1.5,
            jitter: true,
            maxAttempts: 40,
          },
          // Durable transaction settings
          durableTransaction: {
            enabled: true,
            createNonceAccount: true,
            nonceAccountReuseCount: 5,
            autoAdvanceNonce: true,
          }
        }
      };

      // Create an instance with enhanced confirmation
      const volumeBot = new SimpleVolumeBot(config);
      session.volumeBot = volumeBot;

      // Enhanced confirmation event handlers with better progress tracking
      volumeBot.on('confirmationStarted', (signature) => {
        logger.info(`Starting parallel confirmation methods for: ${signature}`);
      });

      volumeBot.on('confirmationProgress', (status) => {
        logger.info(`Confirmation progress: ${JSON.stringify(status)}`);
        if (session.statusMessageId) {
          const progressText = `Confirmation Progress:\n` +
                             `Block Height Age: ${status.blockHeightAge || 'N/A'}\n` +
                             `Subscribe Status: ${status.subscribeStatus || 'pending'}\n` +
                             `Get Status: ${status.getStatusResult || 'pending'}\n` +
                             `Attempts: ${status.attempts || 0}/${status.maxAttempts || 40}\n` +
                             `Rate Limit State: ${status.rateLimitState || 'OK'}\n` +
                             `Durable Nonce: ${status.durableNonceStatus || 'N/A'}`;
          bot.editMessageText(progressText, {
            chat_id: chatId,
            message_id: session.statusMessageId,
            parse_mode: 'Markdown'
          }).catch(logger.warn);
        }
      });

      volumeBot.on('confirmationSuccess', (signature) => {
        logger.info(`Transaction confirmed: ${signature}`);
      });

      volumeBot.on('confirmationError', (error) => {
        logger.error(`Confirmation error: ${error.message}`);
      });

      // Rest of the existing initialization code
      volumeBot.wallets.main = Keypair.fromSecretKey(bs58.decode(config.privateKey));

      if (session.useExisting) {
        await volumeBot.loadExistingWallets();
      } else {
        await volumeBot.createTraderWallets(session.numWallets);
      }

      await volumeBot.initializeTraderWallets(session.solPerWallet);

      const durationMs = session.duration * 60 * 60 * 1000;
      
      // Status message handling
      const statusMsg = await bot.sendMessage(chatId, 'Starting trades, 0 successful so far...');
      session.statusMessageId = statusMsg.message_id;

      volumeBot.on('status', (status) => {
        const newText = `Trades so far: ${status.successRate}\n` +
                       `Time remaining: ${status.remainingTime}s\n` +
                       `Bot running: ${status.isRunning}`;
        bot.editMessageText(newText, {
          chat_id: chatId,
          message_id: session.statusMessageId
        }).catch(logger.warn);
      });

      // Start trading with enhanced error handling
      volumeBot.start(session.tokenAddress, durationMs, session.platform)
        .then((stats) => {
          bot.sendMessage(
            chatId,
            `Bot finished!\n` +
            `Successful Trades: ${stats.successfulTrades}\n` +
            `Total Trades: ${stats.totalTrades}`
          );
        })
        .catch((err) => {
          logger.error('Error in volumeBot.start:', err);
          bot.sendMessage(chatId, `Error: ${err.message}`);
        });

      await bot.sendMessage(
        chatId,
        `Trading has started! I will notify you via status updates.\n` +
        `You can stop the bot at any time using the button below or via /stop.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Stop Bot', callback_data: 'stop_bot' }]
            ]
          }
        }
      );
    } else if (data === 'confirm_cancel') {
      session.confirmation = false;
      await bot.answerCallbackQuery(query.id, { text: 'Cancelled' });
      await bot.sendMessage(chatId, `Trading cancelled. Type /begin to start again.`);
    }
  }
});

bot.on('polling_error', (error) => {
  logger.error(`Telegram polling error: ${error.message}`);
});

// Simple health check endpoint
app.get('/', (req, res) => {
  res.send('Telegram bot is running!');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    botRunning: bot !== null
  });
});

// Add after other environment checks
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_KEY must be defined in your .env');
}

// Initialize Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Start Express server
app.listen(port, '0.0.0.0', () => {
  logger.info(`Health check server listening at http://0.0.0.0:${port}`);
});
