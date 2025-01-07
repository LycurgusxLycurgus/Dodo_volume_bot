const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

let supabase;

try {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    throw new Error('Missing required environment variables: SUPABASE_URL and/or SUPABASE_KEY');
  }

  logger.info('Initializing Supabase client with URL:', process.env.SUPABASE_URL);
  
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY,
    {
      auth: {
        persistSession: false
      },
      db: {
        schema: 'public'
      }
    }
  );

  // Test the connection
  supabase.from('trader_wallets').select('count').then(({ error }) => {
    if (error) {
      logger.error('Failed to connect to Supabase:', {
        error: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint
      });
    } else {
      logger.info('Successfully connected to Supabase');
    }
  });

} catch (error) {
  logger.error('Failed to initialize Supabase client:', {
    error: error.message,
    stack: error.stack
  });
  throw error;
}

module.exports = supabase; 