#!/usr/bin/env node

import { Command } from 'commander';
import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { Keypair, Connection, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createTransferInstruction, TOKEN_PROGRAM_ID, getMint, getAccount } from '@solana/spl-token';
import { BN } from '@coral-xyz/anchor';
import Table from 'cli-table3';
import chalk from 'chalk';
import ora from 'ora';

// Load environment variables
dotenv.config();

// ============================================
// CONFIGURATION
// ============================================

interface Config {
  // Core
  rpcUrl: string;
  apiBaseUrl: string;
  nlc9Url: string;
  walletsDir: string;
  mainWalletPath: string;
  
  // NLC9 Bot Config
  nlc9Port: number;
  nlc9ExecuteTransactions: boolean;
  nlc9UsdcMint: string;
  nlc9MyTokenMint: string;
  nlc9PoolAddress: string;
  
  // Market Making Parameters
  nlc9MinOrderUsd: number;
  nlc9MaxOrderUsd: number;
  nlc9TotalVolumeUsd: number;
  nlc9MinOrders: number;
  nlc9MaxOrders: number;
  nlc9OrderDelayMs: number;
  nlc9CycleIntervalMs: number;
  
  // Profit & Rebalancing
  nlc9ProfitTargetPercent: number;
  nlc9ProfitReinvestRatio: number;
  nlc9RebalanceThreshold: number;
  nlc9MaxPositionRatio: number;
  nlc9ProfitCheckCycles: number;
  nlc9VolumeBoostOnProfit: number;
  
  // Spread & Market Dynamics
  nlc9MinSpreadPercent: number;
  nlc9AdaptiveSpread: boolean;
  nlc9CompoundProfits: boolean;
}

const config: Config = {
  rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
  apiBaseUrl: `http://localhost:${process.env.NLC9_PORT || 3009}`,
  nlc9Url: process.env.NLC9_PROTOCOL_URL || 'http://localhost:8000',
  walletsDir: process.env.WALLETS_DIR || './solana',
  mainWalletPath: process.env.MAIN_WALLET_PATH || './solana/main.json',
  
  // NLC9 Configuration
  nlc9Port: parseInt(process.env.NLC9_PORT || '3009'),
  nlc9ExecuteTransactions: process.env.NLC9_EXECUTE_TRANSACTIONS === 'true',
  nlc9UsdcMint: process.env.NLC9_USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  nlc9MyTokenMint: process.env.NLC9_MYTOKEN_MINT || '',
  nlc9PoolAddress: process.env.NLC9_POOL_ADDRESS || '',
  
  nlc9MinOrderUsd: parseFloat(process.env.NLC9_MIN_ORDER_USD || '0.10'),
  nlc9MaxOrderUsd: parseFloat(process.env.NLC9_MAX_ORDER_USD || '25'),
  nlc9TotalVolumeUsd: parseFloat(process.env.NLC9_TOTAL_VOLUME_USD || '54'),
  nlc9MinOrders: parseInt(process.env.NLC9_MIN_ORDERS || '1'),
  nlc9MaxOrders: parseInt(process.env.NLC9_MAX_ORDERS || '10'),
  nlc9OrderDelayMs: parseInt(process.env.NLC9_ORDER_DELAY_MS || '100'),
  nlc9CycleIntervalMs: parseInt(process.env.NLC9_CYCLE_INTERVAL_MS || '60000'),
  
  nlc9ProfitTargetPercent: parseFloat(process.env.NLC9_PROFIT_TARGET_PERCENT || '0.3'),
  nlc9ProfitReinvestRatio: parseFloat(process.env.NLC9_PROFIT_REINVEST_RATIO || '0.7'),
  nlc9RebalanceThreshold: parseFloat(process.env.NLC9_REBALANCE_THRESHOLD || '0.15'),
  nlc9MaxPositionRatio: parseFloat(process.env.NLC9_MAX_POSITION_RATIO || '0.6'),
  nlc9ProfitCheckCycles: parseInt(process.env.NLC9_PROFIT_CHECK_CYCLES || '5'),
  nlc9VolumeBoostOnProfit: parseFloat(process.env.NLC9_VOLUME_BOOST_ON_PROFIT || '1.5'),
  
  nlc9MinSpreadPercent: parseFloat(process.env.NLC9_MIN_SPREAD_PERCENT || '0.1'),
  nlc9AdaptiveSpread: process.env.NLC9_ADAPTIVE_SPREAD === 'true',
  nlc9CompoundProfits: process.env.NLC9_COMPOUND_PROFITS === 'true',
};

// ============================================
// NLC-9 PROTOCOL INTEGRATION
// ============================================

class NLC9Client {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async encodeCommand(verb: string, object: string, params?: any): Promise<any> {
    try {
      const response = await axios.post(`${this.baseUrl}/encode`, {
        verb,
        object,
        params,
        flags: ['ACK'],
        domain: 'wizbot.solana',
      });
      return response.data;
    } catch (error) {
      console.error('NLC9 encode error:', error);
      throw error;
    }
  }

  async decodeCommand(data: { numbers?: number[], base64?: string, hex?: string }): Promise<any> {
    try {
      const response = await axios.post(`${this.baseUrl}/decode`, data);
      return response.data;
    } catch (error) {
      console.error('NLC9 decode error:', error);
      throw error;
    }
  }

  async registerSchema(verb: string, object: string, params: any[]): Promise<void> {
    try {
      await axios.post(`${this.baseUrl}/schema/register`, {
        verb,
        object,
        params,
      });
    } catch (error) {
      console.error('NLC9 schema registration error:', error);
    }
  }
}

// ============================================
// WALLET MANAGEMENT
// ============================================

interface WalletMetadata {
  lastWalletNumber: number;
  wallets: Record<string, {
    publicKey: string;
    createdAt: string;
    path: string;
  }>;
}

class WalletManager {
  private walletsDir: string;
  private metadataPath: string;
  private metadata: WalletMetadata;

  constructor(walletsDir: string) {
    this.walletsDir = walletsDir;
    this.metadataPath = path.join(walletsDir, 'metadata.json');
    this.metadata = { lastWalletNumber: 0, wallets: {} }; // Initialize with default
    this.ensureWalletsDir();
    this.loadMetadata();
  }

  private ensureWalletsDir(): void {
    if (!fs.existsSync(this.walletsDir)) {
      fs.mkdirSync(this.walletsDir, { recursive: true });
    }
  }

  private loadMetadata(): void {
    if (fs.existsSync(this.metadataPath)) {
      this.metadata = JSON.parse(fs.readFileSync(this.metadataPath, 'utf-8'));
    } else {
      this.metadata = { lastWalletNumber: 0, wallets: {} };
      this.saveMetadata();
    }
  }

  private saveMetadata(): void {
    fs.writeFileSync(this.metadataPath, JSON.stringify(this.metadata, null, 2));
  }

  createWallets(count: number): string[] {
    const spinner = ora('Creating wallets...').start();
    const walletPaths: string[] = [];
    
    for (let i = 0; i < count; i++) {
      const walletNumber = this.metadata.lastWalletNumber + 1;
      const keypair = Keypair.generate();
      const walletPath = path.join(this.walletsDir, `${walletNumber}.json`);
      
      // Save wallet
      fs.writeFileSync(walletPath, JSON.stringify(Array.from(keypair.secretKey)));
      
      // Update metadata
      this.metadata.wallets[walletNumber.toString()] = {
        publicKey: keypair.publicKey.toString(),
        createdAt: new Date().toISOString(),
        path: walletPath,
      };
      this.metadata.lastWalletNumber = walletNumber;
      
      walletPaths.push(walletPath);
      spinner.text = `Creating wallet ${i + 1}/${count}...`;
    }
    
    this.saveMetadata();
    spinner.succeed(`Created ${count} wallet(s)`);
    
    return walletPaths;
  }

  loadWallet(identifier: string): Keypair {
    let walletPath: string;
    
    if (identifier === 'main') {
      walletPath = config.mainWalletPath;
    } else if (fs.existsSync(identifier)) {
      walletPath = identifier;
    } else {
      walletPath = path.join(this.walletsDir, `${identifier}.json`);
    }
    
    if (!fs.existsSync(walletPath)) {
      throw new Error(`Wallet not found: ${walletPath}`);
    }
    
    const secretKey = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
    return Keypair.fromSecretKey(Uint8Array.from(secretKey));
  }

  listWallets(): void {
    const table = new Table({
      head: ['#', 'Public Key', 'Created', 'Path'],
      style: { head: ['cyan'] },
    });
    
    Object.entries(this.metadata.wallets).forEach(([num, info]) => {
      table.push([
        num,
        info.publicKey.substring(0, 20) + '...',
        new Date(info.createdAt).toLocaleString(),
        info.path,
      ]);
    });
    
    console.log(table.toString());
  }

  async getBalance(wallet: Keypair, connection: Connection): Promise<{ sol: number; tokens: Record<string, number> }> {
    const solBalance = await connection.getBalance(wallet.publicKey);
    const tokens: Record<string, number> = {};
    
    // Get USDC balance if configured
    if (config.nlc9UsdcMint) {
      try {
        const usdcMint = new PublicKey(config.nlc9UsdcMint);
        const usdcAccount = await getAssociatedTokenAddress(usdcMint, wallet.publicKey);
        
        // Check if the token account exists first
        const accountInfo = await connection.getAccountInfo(usdcAccount);
        if (accountInfo) {
          // Account exists, try to get the balance
          try {
            const tokenAccount = await getAccount(connection, usdcAccount);
            const mintInfo = await getMint(connection, usdcMint);
            tokens['USDC'] = Number(tokenAccount.amount) / Math.pow(10, mintInfo.decimals);
          } catch (e) {
            // Error getting account details
            tokens['USDC'] = 0;
          }
        } else {
          // Account doesn't exist
          tokens['USDC'] = 0;
        }
      } catch (e) {
        // Error with mint or other issues
        tokens['USDC'] = 0;
      }
    }
    
    return {
      sol: solBalance / LAMPORTS_PER_SOL,
      tokens,
    };
  }

  getMetadata(): WalletMetadata {
    return this.metadata;
  }
}

// ============================================
// TRANSFER MANAGER
// ============================================

class TransferManager {
  private connection: Connection;
  private walletManager: WalletManager;

  constructor(connection: Connection, walletManager: WalletManager) {
    this.connection = connection;
    this.walletManager = walletManager;
  }

  async transferSOL(
    fromWallet: Keypair,
    toAddresses: PublicKey[],
    totalAmount: number
  ): Promise<string[]> {
    const amountPerWallet = totalAmount / toAddresses.length;
    const lamportsPerWallet = Math.floor(amountPerWallet * LAMPORTS_PER_SOL);
    const signatures: string[] = [];
    
    for (const toAddress of toAddresses) {
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: fromWallet.publicKey,
          toPubkey: toAddress,
          lamports: lamportsPerWallet,
        })
      );
      
      const signature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [fromWallet]
      );
      
      signatures.push(signature);
      console.log(chalk.green(`✓ Sent ${amountPerWallet} SOL to ${toAddress.toString()}`));
    }
    
    return signatures;
  }

  async transferToken(
    fromWallet: Keypair,
    toAddresses: PublicKey[],
    tokenMint: PublicKey,
    totalAmount: number
  ): Promise<string[]> {
    const signatures: string[] = [];
    
    try {
      // Get mint info first
      const mintInfo = await getMint(this.connection, tokenMint);
      const amountPerWallet = totalAmount / toAddresses.length;
      const tokenAmountPerWallet = Math.floor(amountPerWallet * Math.pow(10, mintInfo.decimals));
      
      // Get or create the source token account
      const fromTokenAccount = await getAssociatedTokenAddress(tokenMint, fromWallet.publicKey);
      
      // Check if source account exists and has sufficient balance
      const fromAccountInfo = await this.connection.getAccountInfo(fromTokenAccount);
      if (!fromAccountInfo) {
        throw new Error(`Source wallet doesn't have a token account for this mint`);
      }
      
      // Get the actual token account to check balance
      const fromTokenAccountData = await getAccount(this.connection, fromTokenAccount);
      const totalNeeded = BigInt(tokenAmountPerWallet) * BigInt(toAddresses.length);
      
      if (fromTokenAccountData.amount < totalNeeded) {
        const available = Number(fromTokenAccountData.amount) / Math.pow(10, mintInfo.decimals);
        throw new Error(`Insufficient token balance. Available: ${available}, Needed: ${totalAmount}`);
      }
      
      // Process each transfer
      for (const toAddress of toAddresses) {
        const toTokenAccount = await getAssociatedTokenAddress(tokenMint, toAddress);
        
        // Check if destination account exists, create if not
        const accountInfo = await this.connection.getAccountInfo(toTokenAccount);
        const transaction = new Transaction();
        
        if (!accountInfo) {
          console.log(chalk.yellow(`Creating token account for ${toAddress.toString().substring(0, 8)}...`));
          transaction.add(
            createAssociatedTokenAccountInstruction(
              fromWallet.publicKey,
              toTokenAccount,
              toAddress,
              tokenMint
            )
          );
        }
        
        transaction.add(
          createTransferInstruction(
            fromTokenAccount,
            toTokenAccount,
            fromWallet.publicKey,
            tokenAmountPerWallet
          )
        );
        
        const signature = await sendAndConfirmTransaction(
          this.connection,
          transaction,
          [fromWallet]
        );
        
        signatures.push(signature);
        console.log(chalk.green(`✓ Sent ${amountPerWallet} tokens to ${toAddress.toString()}`));
      }
    } catch (error: any) {
      console.error(chalk.red(`Token transfer error: ${error.message}`));
      throw error;
    }
    
    return signatures;
  }

  async distributeAssets(options: {
    from: string;
    to: string[];
    sol?: number;
    usdc?: number;
    token?: { mint: string; amount: number };
  }): Promise<void> {
    const spinner = ora('Distributing assets...').start();
    
    try {
      const fromWallet = this.walletManager.loadWallet(options.from);
      const toWallets = options.to.map(id => this.walletManager.loadWallet(id));
      const toAddresses = toWallets.map(w => w.publicKey);
      
      if (options.sol) {
        spinner.text = `Sending ${options.sol} SOL to ${toAddresses.length} wallets...`;
        await this.transferSOL(fromWallet, toAddresses, options.sol);
      }
      
      if (options.usdc) {
        spinner.text = `Sending ${options.usdc} USDC to ${toAddresses.length} wallets...`;
        const usdcMint = new PublicKey(config.nlc9UsdcMint);
        await this.transferToken(fromWallet, toAddresses, usdcMint, options.usdc);
      }
      
      if (options.token) {
        spinner.text = `Sending ${options.token.amount} tokens to ${toAddresses.length} wallets...`;
        const tokenMint = new PublicKey(options.token.mint);
        await this.transferToken(fromWallet, toAddresses, tokenMint, options.token.amount);
      }
      
      spinner.succeed('Asset distribution complete');
    } catch (error) {
      spinner.fail('Distribution failed');
      throw error;
    }
  }
}

// ============================================
// TRADING API CLIENT
// ============================================

class TradingClient {
  private apiClient = axios.create({
    baseURL: config.apiBaseUrl,
    timeout: 30000,
  });

  async swap(params: {
    poolAddress: string;
    inputMint: string;
    outputMint: string;
    inputAmount: number;
    walletPath: string;
    execute?: boolean;
  }): Promise<any> {
    const endpoint = params.execute ? '/swap' : '/swap/simulate';
    const response = await this.apiClient.post(endpoint, {
      ...params,
      keypairPath: params.walletPath,
      executeTransaction: params.execute || false,
      slippageBps: 50,
    });
    return response.data;
  }

  async findPool(tokenA: string, tokenB: string): Promise<any> {
    const response = await this.apiClient.get('/pools/find', {
      params: { tokenA, tokenB },
    });
    return response.data;
  }

  async getPoolPrice(poolAddress: string): Promise<any> {
    const response = await this.apiClient.get(`/pool/${poolAddress}/price`);
    return response.data;
  }
}

// ============================================
// MARKET MAKER BOT MANAGER
// ============================================

class MarketMakerManager {
  private tradingClient: TradingClient;
  private nlc9Client: NLC9Client;
  private running: boolean = false;

  constructor(tradingClient: TradingClient, nlc9Client: NLC9Client) {
    this.tradingClient = tradingClient;
    this.nlc9Client = nlc9Client;
  }

  async start(walletPath: string, options: any = {}): Promise<void> {
    console.log(chalk.cyan('\n🤖 Starting NLC9 Market Maker Bot'));
    console.log(chalk.gray('================================'));
    
    // Register NLC9 schema for market making
    await this.nlc9Client.registerSchema('EXEC', 'MARKETMAKER', [
      { name: 'volume_usd', type: 'float', scale: 100 },
      { name: 'cycles', type: 'int' },
      { name: 'profit_target', type: 'float', scale: 10000 },
    ]);
    
    // Encode start command
    const encoded = await this.nlc9Client.encodeCommand('EXEC', 'MARKETMAKER', {
      volume_usd: config.nlc9TotalVolumeUsd,
      cycles: options.cycles || 0,
      profit_target: config.nlc9ProfitTargetPercent,
    });
    
    console.log(chalk.gray(`NLC9 Command: ${encoded.base64}`));
    
    // Display configuration
    const configTable = new Table({
      head: ['Parameter', 'Value'],
      style: { head: ['cyan'] },
    });
    
    configTable.push(
      ['Mode', config.nlc9ExecuteTransactions ? chalk.red('LIVE TRADING') : chalk.blue('SIMULATION')],
      ['Volume/Cycle', `$${config.nlc9TotalVolumeUsd}`],
      ['Order Range', `$${config.nlc9MinOrderUsd} - $${config.nlc9MaxOrderUsd}`],
      ['Orders/Batch', `${config.nlc9MinOrders} - ${config.nlc9MaxOrders}`],
      ['Profit Target', `${config.nlc9ProfitTargetPercent}%`],
      ['Reinvest Ratio', `${(config.nlc9ProfitReinvestRatio * 100).toFixed(0)}%`],
      ['Cycle Interval', `${config.nlc9CycleIntervalMs / 1000}s`],
      ['Wallet', walletPath],
    );
    
    console.log(configTable.toString());
    
    if (config.nlc9ExecuteTransactions) {
      console.log(chalk.yellow('\n⚠️  WARNING: Live trading mode - real transactions will be executed!'));
      console.log(chalk.yellow('Press Ctrl+C to cancel within 5 seconds...\n'));
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    this.running = true;
    
    // Import and run the market maker bot
    // Note: This would import your optimized market maker bot module
    console.log(chalk.green('\n✅ Market maker bot started'));
    console.log(chalk.gray('Press Ctrl+C to stop\n'));
    
    // Here you would actually run the bot logic
    // For now, we'll simulate with a placeholder
    while (this.running) {
      await this.executeCycle(walletPath);
      await new Promise(resolve => setTimeout(resolve, config.nlc9CycleIntervalMs));
    }
  }

  private async executeCycle(walletPath: string): Promise<void> {
    // This would execute one market making cycle
    console.log(chalk.gray(`[${new Date().toISOString()}] Executing market making cycle...`));
  }

  stop(): void {
    this.running = false;
    console.log(chalk.yellow('\n🛑 Stopping market maker bot...'));
  }
}

// ============================================
// CLI COMMAND HANDLER
// ============================================

class WizBotCLI {
  private program: Command;
  private walletManager: WalletManager;
  private transferManager: TransferManager;
  private tradingClient: TradingClient;
  private marketMakerManager: MarketMakerManager;
  private nlc9Client: NLC9Client;
  private connection: Connection;

  constructor() {
    this.program = new Command();
    this.connection = new Connection(config.rpcUrl);
    this.walletManager = new WalletManager(config.walletsDir);
    this.transferManager = new TransferManager(this.connection, this.walletManager);
    this.tradingClient = new TradingClient();
    this.nlc9Client = new NLC9Client(config.nlc9Url);
    this.marketMakerManager = new MarketMakerManager(this.tradingClient, this.nlc9Client);
    
    this.setupCommands();
  }

  private setupCommands(): void {
    this.program
      .name('wizbot')
      .description('WizBot - Unified Solana Trading & Wallet Management CLI')
      .version('1.0.0');

    // Wallet Commands
    const walletCmd = this.program
      .command('wallet')
      .description('Wallet management commands');

    walletCmd
      .command('create <count>')
      .description('Create new wallets')
      .action(async (count: string) => {
        const walletCount = parseInt(count);
        const wallets = this.walletManager.createWallets(walletCount);
        const metadata = this.walletManager.getMetadata();
        
        const table = new Table({
          head: ['Wallet #', 'Path', 'Public Key'],
          style: { head: ['cyan'] },
        });
        
        wallets.forEach((path, index) => {
          const wallet = this.walletManager.loadWallet(path);
          table.push([
            metadata.lastWalletNumber - walletCount + index + 1,
            path,
            wallet.publicKey.toString(),
          ]);
        });
        
        console.log(table.toString());
      });

    walletCmd
      .command('list')
      .description('List all wallets')
      .action(() => {
        this.walletManager.listWallets();
      });

    walletCmd
      .command('balance <wallet>')
      .description('Check wallet balance')
      .option('--mint <address>', 'Check specific token mint balance')
      .action(async (walletId: string, options) => {
        const wallet = this.walletManager.loadWallet(walletId);
        const balance = await this.walletManager.getBalance(wallet, this.connection);
        
        console.log(chalk.cyan(`\nWallet: ${wallet.publicKey.toString()}`));
        console.log(chalk.green(`SOL: ${balance.sol}`));
        
        // Show standard tokens
        Object.entries(balance.tokens).forEach(([token, amount]) => {
          console.log(chalk.green(`${token}: ${amount}`));
        });
        
        // Check specific mint if provided
        if (options.mint) {
          try {
            const mint = new PublicKey(options.mint);
            const tokenAccount = await getAssociatedTokenAddress(mint, wallet.publicKey);
            const accountInfo = await this.connection.getAccountInfo(tokenAccount);
            
            if (accountInfo) {
              const account = await getAccount(this.connection, tokenAccount);
              const mintInfo = await getMint(this.connection, mint);
              const balance = Number(account.amount) / Math.pow(10, mintInfo.decimals);
              console.log(chalk.green(`Custom Token (${options.mint.substring(0, 8)}...): ${balance}`));
            } else {
              console.log(chalk.yellow(`No token account found for mint: ${options.mint}`));
            }
          } catch (e: any) {
            console.log(chalk.red(`Error checking token: ${e.message}`));
          }
        }
      });

    // Transfer Commands
    this.program
      .command('transfer')
      .description('Transfer assets between wallets')
      .option('--from <wallet>', 'Source wallet (default: main)', 'main')
      .option('--to <wallets...>', 'Destination wallet IDs')
      .option('--sol <amount>', 'SOL amount to transfer')
      .option('--usdc <amount>', 'USDC amount to transfer')
      .option('--token <mint:amount>', 'Token mint and amount')
      .option('--split', 'Split amount equally among destinations')
      .action(async (options) => {
        if (!options.to || options.to.length === 0) {
          console.error(chalk.red('Error: Must specify destination wallets with --to'));
          return;
        }
        
        const transferOptions: any = {
          from: options.from,
          to: options.to,
        };
        
        if (options.sol) {
          transferOptions.sol = parseFloat(options.sol);
        }
        
        if (options.usdc) {
          transferOptions.usdc = parseFloat(options.usdc);
        }
        
        if (options.token) {
          const [mint, amount] = options.token.split(':');
          transferOptions.token = {
            mint,
            amount: parseFloat(amount),
          };
        }
        
        await this.transferManager.distributeAssets(transferOptions);
      });

    // Initialize token account command
    this.program
      .command('init-token')
      .description('Initialize token account for a wallet')
      .requiredOption('--wallet <wallet>', 'Wallet to initialize token account for')
      .requiredOption('--mint <address>', 'Token mint address')
      .option('--payer <wallet>', 'Payer wallet (default: main)', 'main')
      .action(async (options) => {
        const spinner = ora('Initializing token account...').start();
        
        try {
          const targetWallet = this.walletManager.loadWallet(options.wallet);
          const payerWallet = this.walletManager.loadWallet(options.payer);
          const mint = new PublicKey(options.mint);
          
          // Get the associated token address
          const tokenAccount = await getAssociatedTokenAddress(mint, targetWallet.publicKey);
          
          // Check if account already exists
          const accountInfo = await this.connection.getAccountInfo(tokenAccount);
          if (accountInfo) {
            spinner.warn('Token account already exists');
            console.log(chalk.yellow(`Token account: ${tokenAccount.toString()}`));
            return;
          }
          
          // Create the account
          const transaction = new Transaction().add(
            createAssociatedTokenAccountInstruction(
              payerWallet.publicKey,
              tokenAccount,
              targetWallet.publicKey,
              mint
            )
          );
          
          const signature = await sendAndConfirmTransaction(
            this.connection,
            transaction,
            [payerWallet]
          );
          
          spinner.succeed('Token account created');
          console.log(chalk.green(`Token account: ${tokenAccount.toString()}`));
          console.log(chalk.gray(`Transaction: ${signature}`));
        } catch (error: any) {
          spinner.fail('Failed to initialize token account');
          console.error(chalk.red(`Error: ${error.message}`));
        }
      });

    // Swap Commands
    this.program
      .command('swap')
      .description('Swap tokens')
      .requiredOption('--wallet <wallet>', 'Wallet to use')
      .requiredOption('--pool <address>', 'Pool address')
      .requiredOption('--input <mint>', 'Input token mint')
      .requiredOption('--output <mint>', 'Output token mint')
      .requiredOption('--amount <amount>', 'Input amount')
      .option('--execute', 'Execute transaction (default: simulate)')
      .action(async (options) => {
        const wallet = this.walletManager.loadWallet(options.wallet);
        const walletPath = path.join(this.walletManager['walletsDir'], `${options.wallet}.json`);
        
        const result = await this.tradingClient.swap({
          poolAddress: options.pool,
          inputMint: options.input,
          outputMint: options.output,
          inputAmount: parseFloat(options.amount),
          walletPath: walletPath,
          execute: options.execute,
        });
        
        console.log(chalk.cyan('\nSwap Result:'));
        console.log(JSON.stringify(result, null, 2));
      });

    // Market Maker Commands
    const mmCmd = this.program
      .command('mm')
      .description('Market maker bot commands');

    mmCmd
      .command('start')
      .description('Start market maker bot')
      .option('--wallet <wallet>', 'Wallet to use', 'main')
      .option('--cycles <number>', 'Number of cycles (0 = infinite)', '0')
      .action(async (options) => {
        const walletPath = path.join(config.walletsDir, `${options.wallet}.json`);
        await this.marketMakerManager.start(walletPath, {
          cycles: parseInt(options.cycles),
        });
      });

    // Config Commands
    const configCmd = this.program
      .command('config')
      .description('Configuration commands');

    configCmd
      .command('show')
      .description('Show current configuration')
      .action(() => {
        const table = new Table({
          head: ['Parameter', 'Value'],
          style: { head: ['cyan'] },
        });
        
        Object.entries(config).forEach(([key, value]) => {
          if (key.startsWith('nlc9')) {
            table.push([key, String(value)]);
          }
        });
        
        console.log(chalk.cyan('\nNLC9 Configuration:'));
        console.log(table.toString());
      });

    // Complex command example
    this.program
      .command('distribute')
      .description('Create wallets and distribute assets')
      .requiredOption('--create <count>', 'Number of wallets to create')
      .option('--from <wallet>', 'Source wallet', 'main')
      .option('--sol <amount>', 'Total SOL to distribute')
      .option('--usdc <amount>', 'Total USDC to distribute')
      .action(async (options) => {
        // Create wallets
        const count = parseInt(options.create);
        const walletPaths = this.walletManager.createWallets(count);
        const metadata = this.walletManager.getMetadata();
        
        // Get wallet IDs
        const startNum = metadata.lastWalletNumber - count + 1;
        const walletIds = Array.from({ length: count }, (_, i) => String(startNum + i));
        
        // Distribute assets
        if (options.sol || options.usdc) {
          await this.transferManager.distributeAssets({
            from: options.from,
            to: walletIds,
            sol: options.sol ? parseFloat(options.sol) : undefined,
            usdc: options.usdc ? parseFloat(options.usdc) : undefined,
          });
        }
        
        console.log(chalk.green(`\n✅ Created ${count} wallets and distributed assets`));
      });

    // NLC9 Commands
    const nlc9Cmd = this.program
      .command('nlc9')
      .description('NLC9 protocol commands');

    nlc9Cmd
      .command('encode')
      .description('Encode command to NLC9 format')
      .requiredOption('--verb <verb>', 'Command verb')
      .requiredOption('--object <object>', 'Command object')
      .option('--params <json>', 'Parameters as JSON')
      .action(async (options) => {
        const params = options.params ? JSON.parse(options.params) : undefined;
        const result = await this.nlc9Client.encodeCommand(
          options.verb,
          options.object,
          params
        );
        
        console.log(chalk.cyan('\nNLC9 Encoded:'));
        console.log(chalk.gray(`Base64: ${result.base64}`));
        console.log(chalk.gray(`Hex: ${result.hex}`));
        console.log(chalk.gray(`Numbers: [${result.numbers.join(', ')}]`));
      });
  }

  async run(): Promise<void> {
    try {
      await this.program.parseAsync(process.argv);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  }
}

// ============================================
// MAIN EXECUTION
// ============================================

async function main() {
  console.log(chalk.cyan(`
╦ ╦╦╔═╗╔╗ ╔═╗╔╦╗
║║║║╔═╝╠╩╗║ ║ ║ 
╚╩╝╩╚═╝╚═╝╚═╝ ╩ 
  `));
  
  const cli = new WizBotCLI();
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log(chalk.yellow('\n\nShutting down gracefully...'));
    process.exit(0);
  });
  
  await cli.run();
}

// Run if executed directly
if (require.main === module) {
  main().catch(error => {
    console.error(chalk.red('Fatal error:'), error);
    process.exit(1);
  });
}

export default WizBotCLI;