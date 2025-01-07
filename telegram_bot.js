/*******************************************************************
 * File: telegram_bot.js
 *
 * Telegram Bot that replicates the UX from app_simple_volume_bot.js
 * using node-telegram-bot-api. We ask the user the same questions
 * and call methods on SimpleVolumeBot.
 *
 * CHANGES for your request:
 * - Removed references to main wallet or funding.
 * - We ONLY load wallets from Supabase.
 * - The /stop command actually stops trades immediately.
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

if (!process.env.TG_BOT_TOKEN) {
  throw new Error('TG_BOT_TOKEN is not defined in .env');
}

// Create Telegram bot instance
const bot = new TelegramBot(process.env.TG_BOT_TOKEN, {
  polling: true,
});

// Register commands for the Telegram menu
bot.setMyCommands([
  { command: '/start', description: 'Start the bot (greeting)' },
  { command: '/begin', description: 'Begin volume trading setup' },
  { command: '/stop', description: 'Stop the current volume bot' },
]);

// We'll store per-user state in memory. For production, use a DB.
const userSessions = {};

// Helper to get or create session for each chatId
function getSession(chatId) {
  if (!userSessions[chatId]) {
    userSessions[chatId] = {
      platform: 'pump',
      tokenAddress: '',
      tradeAmountUSD: 0.01,
      priorityFee: 0.0001,
      slippage: 5,
      duration: 6, // in hours
      volumeBot: null,
      statusMessageId: null,
      step: 0,
    };
  }
  return userSessions[chatId];
}

// === /stop command ===
bot.onText(/\/stop/, async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  if (session.volumeBot && session.volumeBot.isRunning) {
    await bot.sendMessage(chatId, 'Stopping volume bot... Please wait.');
    try {
      await session.volumeBot.stop();

      // If we had a status message, update it
      if (session.statusMessageId) {
        await bot.editMessageText('Volume bot has been stopped.', {
          chat_id: chatId,
          message_id: session.statusMessageId,
        });
      } else {
        await bot.sendMessage(chatId, 'Volume bot has been stopped.');
      }
    } catch (error) {
      logger.error('Error stopping bot:', error);
      await bot.sendMessage(chatId, 'Error occurred while stopping the bot.');
    }
  } else {
    await bot.sendMessage(chatId, 'No active volume bot to stop.');
  }
});

// === /start command ===
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  userSessions[chatId] = {}; // reset
  getSession(chatId); // re-init

  await bot.sendMessage(
    chatId,
    `Welcome to the Volume Trader Telegram Bot!\n` +
      `Use /begin to configure and start a volume trading session.\n` +
      `Use /stop anytime to stop an ongoing session.`
  );
});

// === /begin command ===
bot.onText(/\/begin/, async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  // We'll prompt for each piece of config in sequence
  // but for brevity, let's do inline keyboards quickly:
  session.step = 1;
  await bot.sendMessage(
    chatId,
    `Select the trading platform:`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'PumpFun (Bonding Curve)', callback_data: 'platform_pump' },
            { text: 'Raydium/Jupiter', callback_data: 'platform_jupiter' },
          ],
        ],
      },
    }
  );
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const session = getSession(chatId);

  // "Stop Bot" inline button
  if (data === 'stop_bot') {
    await bot.answerCallbackQuery(query.id);
    await bot.editMessageText('Stopping volume bot... Please wait.', {
      chat_id: chatId,
      message_id: query.message.message_id,
    });
    if (session.volumeBot) {
      try {
        await session.volumeBot.stop();
        await bot.editMessageText('Volume bot has been stopped.', {
          chat_id: chatId,
          message_id: query.message.message_id,
        });
      } catch (error) {
        logger.error('Error stopping bot:', error);
        await bot.editMessageText('Error occurred while stopping the bot.', {
          chat_id: chatId,
          message_id: query.message.message_id,
        });
      }
    }
    return;
  }

  // Step 1: platform
  if (session.step === 1 && (data === 'platform_pump' || data === 'platform_jupiter')) {
    session.platform = data === 'platform_pump' ? 'pump' : 'jupiter';
    await bot.answerCallbackQuery(query.id, { text: 'Platform selected' });

    session.step = 2;
    await bot.sendMessage(chatId, `Enter the token mint address:`, {
      reply_markup: { force_reply: true },
    });
    return;
  }
});

// Step 2: token address (text input)
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  const text = msg.text?.trim();

  if (session.step === 2) {
    // naive check for a valid mint
    if (text.length < 32) {
      await bot.sendMessage(chatId, `Invalid mint. Please try again:`);
      return;
    }
    session.tokenAddress = text;

    // next
    session.step = 3;
    await bot.sendMessage(chatId, `Enter trade amount in USD, e.g. 0.01:`);
    return;
  }

  // Step 3: trade amount
  if (session.step === 3) {
    if (isNaN(text)) {
      await bot.sendMessage(chatId, `Invalid. Please enter a number:`);
      return;
    }
    session.tradeAmountUSD = parseFloat(text);

    // next
    session.step = 4;
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

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const session = getSession(chatId);

  // Step 4: priority fee
  if (session.step === 4 && data.startsWith('pf_')) {
    session.priorityFee = parseFloat(data.replace('pf_', ''));
    await bot.answerCallbackQuery(query.id, { text: 'Priority fee selected' });

    // next
    session.step = 5;
    await bot.sendMessage(chatId, `Select slippage tolerance:`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '5%', callback_data: 'slippage_5' }],
          [{ text: '10%', callback_data: 'slippage_10' }],
          [{ text: '15%', callback_data: 'slippage_15' }],
        ],
      },
    });
    return;
  }

  // Step 5: slippage
  if (session.step === 5 && data.startsWith('slippage_')) {
    session.slippage = parseInt(data.replace('slippage_', ''), 10);
    await bot.answerCallbackQuery(query.id, { text: 'Slippage selected' });

    // next
    session.step = 6;
    await bot.sendMessage(chatId, `Select trading duration:`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '6 hours', callback_data: 'dur_6' }],
          [{ text: '12 hours', callback_data: 'dur_12' }],
          [{ text: '24 hours', callback_data: 'dur_24' }],
        ],
      },
    });
    return;
  }

  // Step 6: duration
  if (session.step === 6 && data.startsWith('dur_')) {
    session.duration = parseInt(data.replace('dur_', ''), 10);
    await bot.answerCallbackQuery(query.id, { text: 'Duration selected' });

    // summary
    session.step = 7;
    const summary =
      `Configuration Summary:\n` +
      `---------------------\n` +
      `Platform: ${session.platform}\n` +
      `Token: ${session.tokenAddress}\n` +
      `Trade Amount: $${session.tradeAmountUSD}\n` +
      `Priority Fee: ${session.priorityFee} SOL\n` +
      `Slippage: ${session.slippage}%\n` +
      `Duration: ${session.duration} hours\n`;

    await bot.sendMessage(chatId, summary);
    await bot.sendMessage(chatId, `Start trading now?`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Yes, start now!', callback_data: 'confirm_start' },
            { text: 'No, cancel.', callback_data: 'confirm_cancel' },
          ],
        ],
      },
    });
    return;
  }

  // Step 7: confirm or cancel
  if (session.step === 7) {
    if (data === 'confirm_start') {
      await bot.answerCallbackQuery(query.id, { text: 'Starting...' });

      // Build a new volume bot instance
      const config = {
        privateKey: process.env.PRIVATE_KEY, // not used if we load from supabase, but required
        rpcEndpoint: process.env.SOLANA_RPC_URL,
        tradeAmountUSD: session.tradeAmountUSD,
        priorityFee: session.priorityFee,
        slippageBps: session.slippage * 100,
      };
      const volumeBot = new SimpleVolumeBot(config);
      session.volumeBot = volumeBot;

      // Listen for status updates
      volumeBot.on('status', async (status) => {
        const newText =
          `Trades so far: ${status.successRate}\n` +
          `Time remaining: ${status.remainingTime}s\n` +
          `Running: ${status.isRunning}`;
        if (session.statusMessageId) {
          try {
            await bot.editMessageText(newText, {
              chat_id: chatId,
              message_id: session.statusMessageId,
            });
          } catch (err) {
            logger.warn(`Failed to edit status message: ${err.message}`);
          }
        }
      });

      // Load existing wallets from supabase
      try {
        await volumeBot.loadExistingWallets();
      } catch (err) {
        await bot.sendMessage(chatId, `Error loading wallets:\n${err.message}`);
        return;
      }

      // Start trading
      const durationMs = session.duration * 60 * 60 * 1000;
      const statusMsg = await bot.sendMessage(chatId, 'Starting trades, 0 successful so far...');
      session.statusMessageId = statusMsg.message_id;

      volumeBot
        .start(session.tokenAddress, durationMs, session.platform)
        .then((stats) => {
          bot.sendMessage(
            chatId,
            `Bot finished!\n` +
              `Successful Trades: ${stats.successfulTrades}\n` +
              `Total Trades: ${stats.totalTrades}\n` +
              `Stopped or ended by duration.`
          );
        })
        .catch((err) => {
          logger.error('Error in volumeBot.start:', err);
          bot.sendMessage(chatId, `Error: ${err.message}`);
        });

      await bot.sendMessage(
        chatId,
        `Trading started!\nYou can stop the bot at any time with /stop or the button below.`,
        {
          reply_markup: {
            inline_keyboard: [[{ text: 'Stop Bot', callback_data: 'stop_bot' }]],
          },
        }
      );
    } else if (data === 'confirm_cancel') {
      await bot.answerCallbackQuery(query.id, { text: 'Cancelled' });
      await bot.sendMessage(chatId, `Trading cancelled. Type /begin to start again.`);
    }
  }
});

// Handle polling errors
bot.on('polling_error', (error) => {
  logger.error(`Telegram polling error: ${error.message}`);
});

// Basic Express server for Render / health checks
app.get('/', (req, res) => {
  res.send('Telegram bot is running!');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    botRunning: bot !== null,
  });
});

// Initialize Supabase (unchanged)
let supabase;
try {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_KEY must be defined in .env');
  }
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  logger.info('Supabase client initialized successfully');
} catch (error) {
  logger.error('Failed to initialize Supabase client:', {
    error: error.message,
    stack: error.stack,
  });
  throw error;
}

// Start Express server
app.listen(port, '0.0.0.0', () => {
  logger.info(`Telegram bot server listening at http://0.0.0.0:${port}`);
});
