# WizBot CLI - Unified Solana Trading & Wallet Management System

A comprehensive command-line interface for Solana wallet management, token trading, and automated market making with NLC-9 protocol integration.

## Features

- **Wallet Management**: Create, list, and manage multiple Solana wallets
- **Asset Distribution**: Transfer SOL and tokens between wallets with automatic splitting
- **Token Swaps**: Execute and simulate token swaps via Meteora pools
- **Market Making Bot**: Automated market maker with profit optimization
- **NLC-9 Protocol**: Standardized command encoding for agent communication
- **Configuration Management**: Environment-based configuration with NLC9_ prefix

## Installation

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Create wallets directory
mkdir -p solana

# Copy environment configuration
cp .env.example .env

# Edit .env with your settings
nano .env
```

## Quick Start

### 1. Create Main Wallet

```bash
# Generate main wallet first
solana-keygen new -o wallets/main.json
```

### 2. Create Multiple Wallets

```bash
# Create 3 new wallets (numbered 1.json, 2.json, 3.json)
wizbot wallet:create 3

# List all wallets
wizbot wallet:list

# Check wallet balance
wizbot wallet:balance main
wizbot wallet:balance 1
```

### 3. Distribute Assets

```bash
# Simple distribution: Send 2 SOL from main wallet, split equally to wallets 1, 2, 3
wizbot transfer --from main --to 1 2 --sol 0.025 --split

# Complex distribution: Create 3 wallets and distribute assets
wizbot distribute --create 2 --from main --sol 0.0.025 --usdc 15

# This command:
# - Creates 3 new wallets
# - Sends 0.1 SOL to each (0.3 total / 3)
# - Sends 30 USDC to each (90 total / 3)
```

## Command Reference

### Wallet Commands

```bash
# Create wallets
wizbot wallet:create <count>

# List all wallets
wizbot wallet:list

# Check balance
wizbot wallet:balance <wallet_id>
# Examples:
wizbot wallet:balance main
wizbot wallet:balance 1
wizbot wallet:balance /path/to/wallet.json
```

### Transfer Commands

```bash
# Basic transfer
wizbot transfer --from <wallet> --to <wallet1> [wallet2...] --sol <amount>

# Transfer with multiple assets
wizbot transfer \
  --from main \
  --to 1 2 3 \
  --sol 0.3 \
  --usdc 90 \
  --split

# Custom token transfer
wizbot transfer \
  --from main \
  --to 1 2 3 \
  --token EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:100 \
  --split
```

### Swap Commands

```bash
# Simulate swap
wizbot swap \
  --wallet main \
  --pool <pool_address> \
  --input <mint_address> \
  --output <mint_address> \
  --amount 10

# Execute swap
wizbot swap \
  --wallet main \
  --pool <pool_address> \
  --input <mint_address> \
  --output <mint_address> \
  --amount 10 \
  --execute
```

### Market Maker Commands

```bash
# Start market maker bot with main wallet
wizbot mm:start --wallet main

# Run for specific number of cycles
wizbot mm:start --wallet 1 --cycles 100

# Show configuration
wizbot config:show
```

### NLC-9 Protocol Commands

```bash
# Encode a command
wizbot nlc9:encode \
  --verb EXEC \
  --object TASK \
  --params '{"task_id": "trade_1", "priority": 5}'

# The NLC-9 protocol automatically encodes all market maker commands
```

## Complex Usage Examples

### Example 1: Full Wallet Setup and Distribution

```bash
# Create and fund multiple trading wallets
wizbot distribute --create 2 --from main --sol 0.02 --usdc 10

# This single command:
# 1. Creates 5 new wallets (numbered sequentially)
# 2. Transfers 0.2 SOL to each wallet (1 SOL / 5)
# 3. Transfers 100 USDC to each wallet (500 USDC / 5)
```

### Example 2: Market Making Setup

```bash
# 1. Create dedicated MM wallet
wizbot wallet:create 1

# 2. Fund the MM wallet
wizbot transfer --from main --to 1 --sol 0.5 --usdc 1000

# 3. Start market making
wizbot mm:start --wallet 1
```

### Example 3: Multi-Wallet Trading Strategy

```bash
# Create 10 trading wallets
wizbot wallet:create 10

# Distribute initial capital
wizbot transfer --from main --to 1 2 3 4 5 6 7 8 9 10 --sol 5 --usdc 10000 --split

# Each wallet gets:
# - 0.5 SOL (5 / 10)
# - 1000 USDC (10000 / 10)

# Start market makers on different wallets
wizbot mm:start --wallet 1 &
wizbot mm:start --wallet 2 &
wizbot mm:start --wallet 3 &
```

## Environment Configuration

Create a `.env` file with the following NLC9 variables:

```bash
# Core Configuration
NLC9_PORT=3001
NLC9_EXECUTE_TRANSACTIONS=false
SOLANA_RPC_URL=https://api.devnet.solana.com
WALLETS_DIR=./wallets
MAIN_WALLET_PATH=./wallets/main.json

# Token Configuration
NLC9_USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
NLC9_MYTOKEN_MINT=YourTokenMintAddressHere
NLC9_POOL_ADDRESS=

# Market Making Parameters
NLC9_MIN_ORDER_USD=0.10
NLC9_MAX_ORDER_USD=25
NLC9_TOTAL_VOLUME_USD=54
NLC9_MIN_ORDERS=1
NLC9_MAX_ORDERS=10
NLC9_ORDER_DELAY_MS=100
NLC9_CYCLE_INTERVAL_MS=60000

# Profit & Rebalancing
NLC9_PROFIT_TARGET_PERCENT=0.3
NLC9_PROFIT_REINVEST_RATIO=0.7
NLC9_REBALANCE_THRESHOLD=0.15
NLC9_MAX_POSITION_RATIO=0.6
NLC9_PROFIT_CHECK_CYCLES=5
NLC9_VOLUME_BOOST_ON_PROFIT=1.5

# Spread & Market Dynamics
NLC9_MIN_SPREAD_PERCENT=0.1
NLC9_ADAPTIVE_SPREAD=true
NLC9_COMPOUND_PROFITS=true
```

## Running Services

### 1. Start Trading API Server

```bash
npm run api
# or
ts-node trading-api.ts
```

### 2. Start NLC-9 Protocol Server

```bash
npm run nlc9
# or
python3 nlc9-server.py
```

### 3. Start Market Maker Bot

```bash
npm run mm
# or
wizbot mm:start --wallet main
```

## Architecture

```
WizBot CLI System
├── Wallet Manager
│   ├── Create/Load wallets
│   ├── Track metadata
│   └── Balance checking
├── Transfer Manager
│   ├── SOL transfers
│   ├── Token transfers
│   └── Multi-wallet distribution
├── Trading Client
│   ├── Token swaps
│   ├── Pool discovery
│   └── Price queries
├── Market Maker Manager
│   ├── Automated trading
│   ├── Profit optimization
│   └── Position rebalancing
└── NLC-9 Client
    ├── Command encoding
    ├── Schema registration
    └── Protocol compliance
```

## Safety Features

- **Simulation Mode**: All operations simulate by default
- **Confirmation Prompts**: Live trading requires confirmation
- **Slippage Protection**: Configurable slippage tolerance
- **Position Limits**: Maximum position ratios enforced
- **Graceful Shutdown**: Ctrl+C handling for safe stops

## Advanced Usage

### Custom Trading Strategies

```bash
# Conservative strategy
export NLC9_MIN_ORDER_USD=0.10
export NLC9_MAX_ORDER_USD=5
export NLC9_TOTAL_VOLUME_USD=10
export NLC9_PROFIT_TARGET_PERCENT=0.2
wizbot mm:start --wallet main

# Aggressive strategy
export NLC9_MIN_ORDER_USD=1
export NLC9_MAX_ORDER_USD=50
export NLC9_TOTAL_VOLUME_USD=100
export NLC9_PROFIT_TARGET_PERCENT=0.5
wizbot mm:start --wallet main

# High-frequency strategy
export NLC9_MIN_ORDERS=10
export NLC9_MAX_ORDERS=30
export NLC9_CYCLE_INTERVAL_MS=30000
wizbot mm:start --wallet main
```

### Batch Operations

```bash
# Create 100 wallets for testing
for i in {1..10}; do
  wizbot wallet:create 10
done

# Fund all wallets
WALLETS=$(seq 1 100)
wizbot transfer --from main --to $WALLETS --sol 100 --usdc 10000 --split
```

## Troubleshooting

### Common Issues

1. **Wallet not found**
   ```bash
   # Check wallet exists
   ls wallets/
   # Check metadata
   cat wallets/metadata.json
   ```

2. **Insufficient balance**
   ```bash
   # Check source wallet balance
   wizbot wallet:balance main
   ```

3. **API connection error**
   ```bash
   # Verify API is running
   curl http://localhost:3001/health
   ```

4. **NLC-9 encoding error**
   ```bash
   # Check NLC-9 server
   curl http://localhost:8000/ping
   ```

## Development

```bash
# Run in development mode
npm run dev

# Run tests
npm test

# Lint code
npm run lint

# Format code
npm run format
```

## Contributing

1. Fork the repository
2. Create feature branch
3. Commit changes
4. Push to branch
5. Create Pull Request

## License

MIT License - see LICENSE file for details

## Support

For issues and questions:
- GitHub Issues: [wizbot-cli/issues](https://github.com/wizbot-cli/issues)
- Documentation: [wizbot-cli/wiki](https://github.com/wizbot-cli/wiki)

## Credits

Built with:
- Solana Web3.js
- Meteora CP-AMM SDK
- NLC-9 Protocol
- TypeScript & Node.js