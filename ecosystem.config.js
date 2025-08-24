// ecosystem.config.js
module.exports = {
  apps: [
    // ========== Core Trading API ==========
    {
      name: 'trading-api',
      script: './dist/trading-api.js',
      instances: 2,
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'development',
        PORT2: 3001,
        SOLANA_RPC_URL: 'https://api.devnet.solana.com',
        WALLET_KEYPAIR_PATH: './wallets/main.json',
      },
      env_production: {
        NODE_ENV: 'production',
        PORT2: 3001,
        SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com',
        WALLET_KEYPAIR_PATH: './wallets/main.json',
      },
      error_file: './logs/trading-api-error.log',
      out_file: './logs/trading-api-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      watch: false,
    },

    // ========== NLC-9 Protocol Server ==========
    {
      name: 'nlc9-server',
      script: 'python3',
      args: 'src/nlc9-api.py',
      interpreter: 'none',
      env: {
        NLC9_HOST: '0.0.0.0',
        NLC9_PORT: 8000,
        NLC9_ENABLE_PERSISTENCE: 'false',
        NLC9_ENABLE_METRICS: 'true',
        NLC9_DEBUG: 'false',
        NLC9_LOG_LEVEL: 'info',
      },
      env_production: {
        NLC9_HOST: '0.0.0.0',
        NLC9_PORT: 8000,
        NLC9_ENABLE_PERSISTENCE: 'true',
        NLC9_REDIS_URL: 'redis://localhost:6379',
        NLC9_ENABLE_METRICS: 'true',
        NLC9_DEBUG: 'false',
        NLC9_LOG_LEVEL: 'warning',
      },
      error_file: './logs/nlc9-error.log',
      out_file: './logs/nlc9-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
    },

    // ========== Multi-Agent System ==========
    {
      name: 'multi-agent',
      script: './dist/multi-agent.js',
      args: 'start --preset FULL_ECOSYSTEM',
      instances: 1,
      env: {
        NODE_ENV: 'development',
        AGENTS_ENABLED: 'true',
        CONSENSUS_THRESHOLD: '0.6',
        EMERGENCY_STOP_ENABLED: 'true',
        PROFIT_SHARING: 'true',
      },
      env_production: {
        NODE_ENV: 'production',
        AGENTS_ENABLED: 'true',
        CONSENSUS_THRESHOLD: '0.6',
        EMERGENCY_STOP_ENABLED: 'true',
        PROFIT_SHARING: 'true',
      },
      error_file: './logs/multi-agent-error.log',
      out_file: './logs/multi-agent-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      autorestart: true,
      max_restarts: 5,
      min_uptime: '30s',
      cron_restart: '0 */6 * * *', // Restart every 6 hours
    },

    // ========== Market Maker Bot ==========
    {
      name: 'market-maker',
      script: './dist/market-maker.js',
      instances: 1,
      env: {
        NODE_ENV: 'development',
        NLC9_EXECUTE_TRANSACTIONS: 'false',
        NLC9_MIN_ORDER_USD: '0.10',
        NLC9_MAX_ORDER_USD: '25',
        NLC9_TOTAL_VOLUME_USD: '54',
        NLC9_PROFIT_TARGET_PERCENT: '0.3',
        NLC9_PROFIT_REINVEST_RATIO: '0.7',
        NLC9_ADAPTIVE_SPREAD: 'true',
        NLC9_COMPOUND_PROFITS: 'true',
      },
      env_production: {
        NODE_ENV: 'production',
        NLC9_EXECUTE_TRANSACTIONS: 'true',
        NLC9_MIN_ORDER_USD: '1',
        NLC9_MAX_ORDER_USD: '100',
        NLC9_TOTAL_VOLUME_USD: '500',
        NLC9_PROFIT_TARGET_PERCENT: '0.5',
        NLC9_PROFIT_REINVEST_RATIO: '0.8',
        NLC9_ADAPTIVE_SPREAD: 'true',
        NLC9_COMPOUND_PROFITS: 'true',
      },
      error_file: './logs/market-maker-error.log',
      out_file: './logs/market-maker-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '60s',
      cron_restart: '0 0 * * *', // Daily restart at midnight
    },

    // ========== Monitoring Service ==========
    {
      name: 'monitoring',
      script: './dist/monitoring.js',
      instances: 1,
      env: {
        NODE_ENV: 'development',
        MONITOR_INTERVAL_MS: '30000',
        ALERT_WEBHOOK_URL: '',
        METRICS_PORT: 9090,
      },
      env_production: {
        NODE_ENV: 'production',
        MONITOR_INTERVAL_MS: '10000',
        ALERT_WEBHOOK_URL: process.env.ALERT_WEBHOOK_URL,
        METRICS_PORT: 9090,
        SENTRY_DSN: process.env.SENTRY_DSN,
      },
      error_file: './logs/monitoring-error.log',
      out_file: './logs/monitoring-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
    },

    // ========== Redis Cache (Optional) ==========
    {
      name: 'redis',
      script: 'redis-server',
      interpreter: 'none',
      args: '--port 6379 --maxmemory 256mb --maxmemory-policy allkeys-lru',
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '10s',
    },
  ],

  // ========== Deploy Configuration ==========
  deploy: {
    production: {
      user: 'deploy',
      host: ['server1.trading.ecosystem', 'server2.trading.ecosystem'],
      ref: 'origin/main',
      repo: 'git@github.com:OneAInetwork/NLC-9.git',
      path: '/var/www/trading-ecosystem',
      'pre-deploy-local': 'npm test',
      'post-deploy': 'npm install && npm run build && pm2 reload ecosystem.config.js --env production',
      'pre-setup': 'apt-get update && apt-get install -y python3 python3-pip redis-server',
      env: {
        NODE_ENV: 'production',
      },
    },
    
    staging: {
      user: 'deploy',
      host: 'one.trading.ecosystem',
      ref: 'origin/develop',
      repo: 'git@github.com:OneAInetwork/NLC-9.git',
      path: '/var/www/trading-ecosystem-staging',
      'post-deploy': 'npm install && npm run build && pm2 reload ecosystem.config.js --env development',
      env: {
        NODE_ENV: 'development',
      },
    },
  },
};