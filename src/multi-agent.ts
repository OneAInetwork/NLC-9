#!/usr/bin/env node

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import axios from 'axios';
import { Keypair, Connection, PublicKey } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import Table from 'cli-table3';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();

// ============================================
// TYPES & INTERFACES
// ============================================

type AgentRole = 'LEADER' | 'FOLLOWER' | 'ARBITRAGE' | 'MARKET_MAKER' | 'SCOUT' | 'LIQUIDATOR';
type StrategyType = 'AGGRESSIVE' | 'CONSERVATIVE' | 'BALANCED' | 'ADAPTIVE' | 'COPY_TRADE';
type AgentState = 'IDLE' | 'TRADING' | 'ANALYZING' | 'WAITING' | 'EMERGENCY_STOP';

interface AgentConfig {
  id: string;
  name: string;
  role: AgentRole;
  strategy: StrategyType;
  walletPath: string;
  riskLevel: number; // 0-1
  capital: number;
  maxPositionSize: number;
  profitTarget: number;
  stopLoss: number;
  tradingPairs: string[];
  autonomyLevel: number; // 0-1 (0 = full manual, 1 = full auto)
}

interface StrategyParameters {
  // Market Making
  spreadPercent: number;
  orderDepth: number;
  volumePerCycle: number;
  rebalanceThreshold: number;
  
  // Trading
  entryThreshold: number;
  exitThreshold: number;
  leverage: number;
  
  // Risk Management
  maxDrawdown: number;
  positionSizePercent: number;
  correlationLimit: number;
  
  // Timing
  cycleIntervalMs: number;
  cooldownPeriodMs: number;
  maxTradesPerHour: number;
}

interface MarketSignal {
  type: 'BUY' | 'SELL' | 'HOLD' | 'ALERT';
  strength: number; // 0-1
  confidence: number; // 0-1
  token: string;
  price: number;
  volume: number;
  source: string; // agent ID
  timestamp: number;
  metadata?: any;
}

interface AgentMessage {
  from: string;
  to: string | 'BROADCAST';
  type: 'SIGNAL' | 'COMMAND' | 'STATUS' | 'COORDINATION' | 'EMERGENCY';
  payload: any;
  timestamp: number;
  nlc9?: string; // Base64 encoded NLC-9 message
}

interface SwarmConfig {
  name: string;
  agents: AgentConfig[];
  coordinationMode: 'CENTRALIZED' | 'DECENTRALIZED' | 'HYBRID';
  consensusThreshold: number; // 0-1 (percentage of agents needed to agree)
  emergencyStopEnabled: boolean;
  profitSharing: boolean;
  communicationProtocol: 'NLC9' | 'HYBRID';
}

// ============================================
// NLC-9 ENHANCED CLIENT
// ============================================

class NLC9EnhancedClient {
  private baseUrl: string;
  private ws: WebSocket | null = null;
  private messageHandlers: Map<string, (data: any) => void> = new Map();

  constructor(baseUrl: string = 'http://localhost:8000') {
    this.baseUrl = baseUrl;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://localhost:8000/ws`);
      
      this.ws.on('open', () => {
        console.log(chalk.green('✓ Connected to NLC-9 protocol'));
        resolve();
      });
      
      this.ws.on('message', (data: string) => {
        try {
          const message = JSON.parse(data);
          this.handleMessage(message);
        } catch (error) {
          console.error('NLC-9 message parse error:', error);
        }
      });
      
      this.ws.on('error', reject);
    });
  }

  private handleMessage(message: any): void {
    if (message.decoded) {
      const handler = this.messageHandlers.get(message.decoded.correlation_id);
      if (handler) {
        handler(message);
      }
    }
  }

  async encodeAgentMessage(
    verb: string,
    object: string,
    params: any,
    flags: string[] = []
  ): Promise<string> {
    const response = await axios.post(`${this.baseUrl}/encode`, {
      verb,
      object,
      params,
      flags,
      domain: 'multiagent.system',
      correlation_id: Math.floor(Math.random() * 0xFFFFFFFF),
    });
    return response.data.base64;
  }

  async broadcast(message: string): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(message);
    }
  }

  onMessage(correlationId: string, handler: (data: any) => void): void {
    this.messageHandlers.set(correlationId, handler);
  }

  async registerAgentSchema(): Promise<void> {
    // Register schemas for agent communication
    const schemas = [
      {
        verb: 'SIGNAL',
        object: 'MARKET',
        params: [
          { name: 'strength', type: 'float', scale: 1000 },
          { name: 'confidence', type: 'float', scale: 1000 },
          { name: 'token_id', type: 'id' },
        ],
      },
      {
        verb: 'COORD',
        object: 'SWARM',
        params: [
          { name: 'action_id', type: 'id' },
          { name: 'consensus', type: 'float', scale: 1000 },
          { name: 'priority', type: 'int' },
        ],
      },
      {
        verb: 'EXEC',
        object: 'TRADE',
        params: [
          { name: 'pool_id', type: 'id' },
          { name: 'amount', type: 'float', scale: 1000000 },
          { name: 'slippage', type: 'int' },
        ],
      },
    ];

    for (const schema of schemas) {
      await axios.post(`${this.baseUrl}/schema/register`, schema);
    }
  }
}

// ============================================
// TRADING AGENT CLASS
// ============================================

class TradingAgent extends EventEmitter {
  public config: AgentConfig;
  public strategy: StrategyParameters;
  public state: AgentState = 'IDLE';
  public performance: {
    totalTrades: number;
    successfulTrades: number;
    totalProfit: number;
    currentPosition: number;
    startTime: number;
    lastTradeTime: number;
  };
  
  private wallet: Keypair;
  private nlc9Client: NLC9EnhancedClient;
  private messageQueue: AgentMessage[] = [];
  private tradeHistory: any[] = [];
  private isRunning: boolean = false;

  constructor(config: AgentConfig, nlc9Client: NLC9EnhancedClient) {
    super();
    this.config = config;
    this.nlc9Client = nlc9Client;
    this.strategy = this.initializeStrategy(config.strategy);
    this.performance = {
      totalTrades: 0,
      successfulTrades: 0,
      totalProfit: 0,
      currentPosition: 0,
      startTime: Date.now(),
      lastTradeTime: 0,
    };
    
    this.wallet = this.loadWallet(config.walletPath);
  }

  private initializeStrategy(type: StrategyType): StrategyParameters {
    const strategies: Record<StrategyType, StrategyParameters> = {
      AGGRESSIVE: {
        spreadPercent: 0.05,
        orderDepth: 10,
        volumePerCycle: 100,
        rebalanceThreshold: 0.2,
        entryThreshold: 0.02,
        exitThreshold: 0.05,
        leverage: 3,
        maxDrawdown: 0.15,
        positionSizePercent: 0.3,
        correlationLimit: 0.7,
        cycleIntervalMs: 30000,
        cooldownPeriodMs: 5000,
        maxTradesPerHour: 20,
      },
      CONSERVATIVE: {
        spreadPercent: 0.15,
        orderDepth: 3,
        volumePerCycle: 20,
        rebalanceThreshold: 0.1,
        entryThreshold: 0.05,
        exitThreshold: 0.02,
        leverage: 1,
        maxDrawdown: 0.05,
        positionSizePercent: 0.1,
        correlationLimit: 0.5,
        cycleIntervalMs: 120000,
        cooldownPeriodMs: 30000,
        maxTradesPerHour: 5,
      },
      BALANCED: {
        spreadPercent: 0.1,
        orderDepth: 5,
        volumePerCycle: 50,
        rebalanceThreshold: 0.15,
        entryThreshold: 0.03,
        exitThreshold: 0.03,
        leverage: 1.5,
        maxDrawdown: 0.1,
        positionSizePercent: 0.2,
        correlationLimit: 0.6,
        cycleIntervalMs: 60000,
        cooldownPeriodMs: 15000,
        maxTradesPerHour: 10,
      },
      ADAPTIVE: {
        spreadPercent: 0.1,
        orderDepth: 7,
        volumePerCycle: 75,
        rebalanceThreshold: 0.15,
        entryThreshold: 0.025,
        exitThreshold: 0.035,
        leverage: 2,
        maxDrawdown: 0.12,
        positionSizePercent: 0.25,
        correlationLimit: 0.65,
        cycleIntervalMs: 45000,
        cooldownPeriodMs: 10000,
        maxTradesPerHour: 15,
      },
      COPY_TRADE: {
        spreadPercent: 0.1,
        orderDepth: 5,
        volumePerCycle: 50,
        rebalanceThreshold: 0.15,
        entryThreshold: 0.03,
        exitThreshold: 0.03,
        leverage: 1,
        maxDrawdown: 0.08,
        positionSizePercent: 0.15,
        correlationLimit: 0.8,
        cycleIntervalMs: 5000, // Fast to copy trades
        cooldownPeriodMs: 1000,
        maxTradesPerHour: 30,
      },
    };
    
    return strategies[type];
  }

  private loadWallet(walletPath: string): Keypair {
    if (!fs.existsSync(walletPath)) {
      // Create new wallet if doesn't exist
      const keypair = Keypair.generate();
      fs.writeFileSync(walletPath, JSON.stringify(Array.from(keypair.secretKey)));
      return keypair;
    }
    
    const secretKey = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
    return Keypair.fromSecretKey(Uint8Array.from(secretKey));
  }

  async start(): Promise<void> {
    this.isRunning = true;
    this.state = 'ANALYZING';
    
    console.log(chalk.cyan(`🤖 Agent ${this.config.name} starting...`));
    console.log(chalk.gray(`   Role: ${this.config.role}`));
    console.log(chalk.gray(`   Strategy: ${this.config.strategy}`));
    console.log(chalk.gray(`   Risk Level: ${(this.config.riskLevel * 100).toFixed(0)}%`));
    
    // Start main loop
    this.runTradingLoop();
    
    // Start message processing
    this.processMessageQueue();
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    this.state = 'IDLE';
    console.log(chalk.yellow(`🛑 Agent ${this.config.name} stopping...`));
  }

  private async runTradingLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        // Analyze market
        const signals = await this.analyzeMarket();
        
        // Make decisions based on role
        await this.makeDecisions(signals);
        
        // Execute trades if needed
        await this.executeTrades();
        
        // Report status
        await this.reportStatus();
        
        // Wait for next cycle
        await this.sleep(this.strategy.cycleIntervalMs);
        
      } catch (error) {
        console.error(chalk.red(`Agent ${this.config.name} error:`), error);
        this.state = 'EMERGENCY_STOP';
        await this.broadcastEmergency(error);
      }
    }
  }

  private async analyzeMarket(): Promise<MarketSignal[]> {
    this.state = 'ANALYZING';
    const signals: MarketSignal[] = [];
    
    // Simulate market analysis based on role
    switch (this.config.role) {
      case 'SCOUT':
        // Scout for opportunities
        for (const pair of this.config.tradingPairs) {
          const signal = await this.scanForOpportunity(pair);
          if (signal) signals.push(signal);
        }
        break;
        
      case 'ARBITRAGE':
        // Look for arbitrage opportunities
        const arbSignals = await this.findArbitrageOpportunities();
        signals.push(...arbSignals);
        break;
        
      case 'MARKET_MAKER':
        // Generate market making signals
        const mmSignals = await this.generateMarketMakingSignals();
        signals.push(...mmSignals);
        break;
        
      case 'LEADER':
        // Analyze and generate leader signals
        const leaderSignals = await this.generateLeaderSignals();
        signals.push(...leaderSignals);
        break;
        
      case 'FOLLOWER':
        // Wait for leader signals
        // Signals come from message queue
        break;
        
      case 'LIQUIDATOR':
        // Look for liquidation opportunities
        const liqSignals = await this.findLiquidationTargets();
        signals.push(...liqSignals);
        break;
    }
    
    return signals;
  }

  private async scanForOpportunity(pair: string): Promise<MarketSignal | null> {
    // Simulate opportunity scanning
    const random = Math.random();
    if (random > 0.7) {
      return {
        type: random > 0.85 ? 'BUY' : 'SELL',
        strength: Math.random(),
        confidence: Math.random(),
        token: pair,
        price: 100 + Math.random() * 50,
        volume: Math.random() * 10000,
        source: this.config.id,
        timestamp: Date.now(),
      };
    }
    return null;
  }

  private async findArbitrageOpportunities(): Promise<MarketSignal[]> {
    // Simulate arbitrage detection
    const signals: MarketSignal[] = [];
    const random = Math.random();
    
    if (random > 0.8) {
      signals.push({
        type: 'BUY',
        strength: 0.9,
        confidence: 0.85,
        token: 'ARB_OPPORTUNITY',
        price: 100,
        volume: 5000,
        source: this.config.id,
        timestamp: Date.now(),
        metadata: {
          poolA: 'pool_123',
          poolB: 'pool_456',
          profitPercent: 2.5,
        },
      });
    }
    
    return signals;
  }

  private async generateMarketMakingSignals(): Promise<MarketSignal[]> {
    // Generate buy and sell orders around mid price
    const signals: MarketSignal[] = [];
    const midPrice = 100; // Simulated mid price
    
    // Buy orders
    for (let i = 0; i < this.strategy.orderDepth; i++) {
      const priceOffset = (i + 1) * this.strategy.spreadPercent * midPrice;
      signals.push({
        type: 'BUY',
        strength: 0.5,
        confidence: 0.7,
        token: this.config.tradingPairs[0],
        price: midPrice - priceOffset,
        volume: this.strategy.volumePerCycle / this.strategy.orderDepth,
        source: this.config.id,
        timestamp: Date.now(),
      });
    }
    
    // Sell orders
    for (let i = 0; i < this.strategy.orderDepth; i++) {
      const priceOffset = (i + 1) * this.strategy.spreadPercent * midPrice;
      signals.push({
        type: 'SELL',
        strength: 0.5,
        confidence: 0.7,
        token: this.config.tradingPairs[0],
        price: midPrice + priceOffset,
        volume: this.strategy.volumePerCycle / this.strategy.orderDepth,
        source: this.config.id,
        timestamp: Date.now(),
      });
    }
    
    return signals;
  }

  private async generateLeaderSignals(): Promise<MarketSignal[]> {
    // Leader makes strategic decisions
    const signals: MarketSignal[] = [];
    const marketCondition = this.assessMarketCondition();
    
    if (marketCondition === 'BULLISH') {
      signals.push({
        type: 'BUY',
        strength: 0.8,
        confidence: 0.75,
        token: this.config.tradingPairs[0],
        price: 100,
        volume: this.config.capital * this.strategy.positionSizePercent,
        source: this.config.id,
        timestamp: Date.now(),
        metadata: { reason: 'Bullish market conditions detected' },
      });
    } else if (marketCondition === 'BEARISH') {
      signals.push({
        type: 'SELL',
        strength: 0.8,
        confidence: 0.75,
        token: this.config.tradingPairs[0],
        price: 100,
        volume: this.performance.currentPosition * 0.5,
        source: this.config.id,
        timestamp: Date.now(),
        metadata: { reason: 'Bearish market conditions detected' },
      });
    }
    
    return signals;
  }

  private async findLiquidationTargets(): Promise<MarketSignal[]> {
    // Simulate liquidation opportunity detection
    const signals: MarketSignal[] = [];
    const random = Math.random();
    
    if (random > 0.95) {
      signals.push({
        type: 'BUY',
        strength: 1.0,
        confidence: 0.9,
        token: 'LIQUIDATION',
        price: 90, // Below market for liquidation
        volume: 10000,
        source: this.config.id,
        timestamp: Date.now(),
        metadata: {
          targetPosition: 'position_789',
          healthFactor: 0.95,
          estimatedProfit: 500,
        },
      });
    }
    
    return signals;
  }

  private assessMarketCondition(): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
    // Simulate market condition assessment
    const random = Math.random();
    if (random > 0.6) return 'BULLISH';
    if (random < 0.4) return 'BEARISH';
    return 'NEUTRAL';
  }

  private async makeDecisions(signals: MarketSignal[]): Promise<void> {
    this.state = 'ANALYZING';
    
    // Filter signals based on confidence and strength
    const validSignals = signals.filter(
      s => s.confidence >= 0.5 && s.strength >= this.strategy.entryThreshold
    );
    
    // Apply strategy-specific decision making
    for (const signal of validSignals) {
      // Check risk management
      if (this.shouldTakePosition(signal)) {
        // Broadcast signal to other agents if leader
        if (this.config.role === 'LEADER') {
          await this.broadcastSignal(signal);
        }
        
        // Queue trade for execution
        this.queueTrade(signal);
      }
    }
  }

  private shouldTakePosition(signal: MarketSignal): boolean {
    // Risk checks
    if (this.performance.currentPosition >= this.config.maxPositionSize) {
      return false;
    }
    
    // Check drawdown
    const currentDrawdown = this.calculateDrawdown();
    if (currentDrawdown > this.strategy.maxDrawdown) {
      return false;
    }
    
    // Check trade frequency
    const tradesThisHour = this.getTradesInLastHour();
    if (tradesThisHour >= this.strategy.maxTradesPerHour) {
      return false;
    }
    
    // Check cooldown
    if (Date.now() - this.performance.lastTradeTime < this.strategy.cooldownPeriodMs) {
      return false;
    }
    
    return true;
  }

  private calculateDrawdown(): number {
    // Calculate current drawdown
    if (this.performance.totalProfit >= 0) return 0;
    return Math.abs(this.performance.totalProfit) / this.config.capital;
  }

  private getTradesInLastHour(): number {
    const hourAgo = Date.now() - 3600000;
    return this.tradeHistory.filter(t => t.timestamp > hourAgo).length;
  }

  private queueTrade(signal: MarketSignal): void {
    this.tradeHistory.push({
      signal,
      timestamp: Date.now(),
      status: 'PENDING',
    });
  }

  private async executeTrades(): Promise<void> {
    if (this.tradeHistory.length === 0) return;
    
    this.state = 'TRADING';
    
    const pendingTrades = this.tradeHistory.filter(t => t.status === 'PENDING');
    
    for (const trade of pendingTrades) {
      try {
        // Encode trade command in NLC-9
        const nlc9Message = await this.nlc9Client.encodeAgentMessage(
          'EXEC',
          'TRADE',
          {
            pool_id: 'pool_' + trade.signal.token,
            amount: trade.signal.volume,
            slippage: 50, // 0.5%
          },
          ['ACK', 'URGENT']
        );
        
        // Simulate trade execution
        const success = Math.random() > 0.3; // 70% success rate
        
        if (success) {
          trade.status = 'SUCCESS';
          this.performance.successfulTrades++;
          this.performance.totalProfit += Math.random() * 100 - 40; // Random P&L
          
          if (trade.signal.type === 'BUY') {
            this.performance.currentPosition += trade.signal.volume;
          } else {
            this.performance.currentPosition -= trade.signal.volume;
          }
        } else {
          trade.status = 'FAILED';
        }
        
        this.performance.totalTrades++;
        this.performance.lastTradeTime = Date.now();
        
        // Log trade
        console.log(
          chalk[success ? 'green' : 'red'](
            `${this.config.name}: ${trade.signal.type} ${trade.signal.volume.toFixed(2)} @ ${trade.signal.price.toFixed(2)} - ${trade.status}`
          )
        );
        
      } catch (error) {
        console.error(`Trade execution error for ${this.config.name}:`, error);
        trade.status = 'ERROR';
      }
    }
  }

  private async broadcastSignal(signal: MarketSignal): Promise<void> {
    const message: AgentMessage = {
      from: this.config.id,
      to: 'BROADCAST',
      type: 'SIGNAL',
      payload: signal,
      timestamp: Date.now(),
      nlc9: await this.nlc9Client.encodeAgentMessage(
        'SIGNAL',
        'MARKET',
        {
          strength: signal.strength,
          confidence: signal.confidence,
          token_id: signal.token,
        }
      ),
    };
    
    this.emit('message', message);
    await this.nlc9Client.broadcast(message.nlc9!);
  }

  private async broadcastEmergency(error: any): Promise<void> {
    const message: AgentMessage = {
      from: this.config.id,
      to: 'BROADCAST',
      type: 'EMERGENCY',
      payload: {
        error: error.message || error,
        agent: this.config.name,
        timestamp: Date.now(),
      },
      timestamp: Date.now(),
    };
    
    this.emit('emergency', message);
  }

  private async reportStatus(): Promise<void> {
    const status = {
      agent: this.config.name,
      state: this.state,
      performance: this.performance,
      position: this.performance.currentPosition,
      profit: this.performance.totalProfit,
      successRate: this.performance.totalTrades > 0 
        ? (this.performance.successfulTrades / this.performance.totalTrades * 100).toFixed(1)
        : '0',
    };
    
    this.emit('status', status);
  }

  public receiveMessage(message: AgentMessage): void {
    this.messageQueue.push(message);
  }

  private async processMessageQueue(): Promise<void> {
    while (this.isRunning) {
      if (this.messageQueue.length > 0) {
        const message = this.messageQueue.shift()!;
        await this.handleMessage(message);
      }
      await this.sleep(100);
    }
  }

  private async handleMessage(message: AgentMessage): Promise<void> {
    switch (message.type) {
      case 'SIGNAL':
        if (this.config.role === 'FOLLOWER' && this.config.strategy === 'COPY_TRADE') {
          // Copy the trade signal
          const signal = message.payload as MarketSignal;
          if (this.shouldCopyTrade(signal)) {
            this.queueTrade(signal);
          }
        }
        break;
        
      case 'COMMAND':
        await this.executeCommand(message.payload);
        break;
        
      case 'COORDINATION':
        await this.handleCoordination(message.payload);
        break;
        
      case 'EMERGENCY':
        this.state = 'EMERGENCY_STOP';
        await this.stop();
        break;
    }
  }

  private shouldCopyTrade(signal: MarketSignal): boolean {
    // Check if should copy based on confidence and own risk parameters
    return signal.confidence >= 0.7 && this.shouldTakePosition(signal);
  }

  private async executeCommand(command: any): Promise<void> {
    // Execute commands from coordinator
    console.log(`${this.config.name} executing command:`, command);
  }

  private async handleCoordination(coordination: any): Promise<void> {
    // Handle coordination messages
    console.log(`${this.config.name} coordination:`, coordination);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  public getPerformanceSummary(): any {
    return {
      name: this.config.name,
      role: this.config.role,
      strategy: this.config.strategy,
      trades: this.performance.totalTrades,
      successRate: this.performance.totalTrades > 0
        ? (this.performance.successfulTrades / this.performance.totalTrades * 100).toFixed(1) + '%'
        : '0%',
      profit: this.performance.totalProfit.toFixed(2),
      position: this.performance.currentPosition.toFixed(2),
      runtime: ((Date.now() - this.performance.startTime) / 60000).toFixed(1) + ' min',
    };
  }
}

// ============================================
// SWARM COORDINATOR
// ============================================

class SwarmCoordinator extends EventEmitter {
  private config: SwarmConfig;
  private agents: Map<string, TradingAgent> = new Map();
  private nlc9Client: NLC9EnhancedClient;
  private consensusVotes: Map<string, Map<string, any>> = new Map(); // actionId -> agentId -> vote
  private isRunning: boolean = false;
  private performanceTracker: Map<string, any> = new Map();

  constructor(config: SwarmConfig) {
    super();
    this.config = config;
    this.nlc9Client = new NLC9EnhancedClient();
  }

  async initialize(): Promise<void> {
    console.log(chalk.cyan('\n🌐 Initializing Swarm Coordinator'));
    console.log(chalk.gray('================================'));
    
    // Connect to NLC-9
    await this.nlc9Client.connect();
    await this.nlc9Client.registerAgentSchema();
    
    // Create agents
    for (const agentConfig of this.config.agents) {
      const agent = new TradingAgent(agentConfig, this.nlc9Client);
      
      // Set up event listeners
      agent.on('message', (msg) => this.handleAgentMessage(agent, msg));
      agent.on('status', (status) => this.updateAgentStatus(agent, status));
      agent.on('emergency', (msg) => this.handleEmergency(agent, msg));
      
      this.agents.set(agentConfig.id, agent);
    }
    
    console.log(chalk.green(`✅ Initialized ${this.agents.size} agents`));
  }

  async start(): Promise<void> {
    this.isRunning = true;
    console.log(chalk.cyan('\n🚀 Starting Agent Swarm'));
    
    // Start all agents
    const startPromises = Array.from(this.agents.values()).map(agent => agent.start());
    await Promise.all(startPromises);
    
    // Start coordination loop
    this.runCoordinationLoop();
    
    // Start performance monitoring
    this.startPerformanceMonitoring();
  }

  async stop(): Promise<void> {
    console.log(chalk.yellow('\n🛑 Stopping Agent Swarm'));
    this.isRunning = false;
    
    // Stop all agents
    const stopPromises = Array.from(this.agents.values()).map(agent => agent.stop());
    await Promise.all(stopPromises);
    
    // Show final performance
    this.showPerformanceSummary();
  }

  private async runCoordinationLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        // Check for consensus actions
        await this.processConsensusActions();
        
        // Rebalance swarm if needed
        await this.rebalanceSwarm();
        
        // Share profits if enabled
        if (this.config.profitSharing) {
          await this.distributeProfits();
        }
        
        await this.sleep(5000); // Check every 5 seconds
        
      } catch (error) {
        console.error('Coordination error:', error);
      }
    }
  }

  private async processConsensusActions(): Promise<void> {
    for (const [actionId, votes] of this.consensusVotes.entries()) {
      const totalAgents = this.agents.size;
      const votesReceived = votes.size;
      
      if (votesReceived / totalAgents >= this.config.consensusThreshold) {
        // Consensus reached, execute action
        await this.executeConsensusAction(actionId, votes);
        this.consensusVotes.delete(actionId);
      }
    }
  }

  private async executeConsensusAction(actionId: string, votes: Map<string, any>): Promise<void> {
    console.log(chalk.green(`\n✅ Consensus reached for action: ${actionId}`));
    
    // Aggregate votes and determine action
    const voteArray = Array.from(votes.values());
    const action = this.aggregateVotes(voteArray);
    
    // Broadcast coordinated action to all agents
    const message: AgentMessage = {
      from: 'COORDINATOR',
      to: 'BROADCAST',
      type: 'COORDINATION',
      payload: {
        actionId,
        action,
        consensus: votes.size / this.agents.size,
      },
      timestamp: Date.now(),
    };
    
    // Send to all agents
    for (const agent of this.agents.values()) {
      agent.receiveMessage(message);
    }
  }

  private aggregateVotes(votes: any[]): any {
    // Simple majority vote aggregation
    const voteCount = new Map();
    
    for (const vote of votes) {
      const key = JSON.stringify(vote);
      voteCount.set(key, (voteCount.get(key) || 0) + 1);
    }
    
    // Find majority vote
    let maxVotes = 0;
    let majorityVote = null;
    
    for (const [vote, count] of voteCount.entries()) {
      if (count > maxVotes) {
        maxVotes = count;
        majorityVote = JSON.parse(vote);
      }
    }
    
    return majorityVote;
  }

  private async rebalanceSwarm(): Promise<void> {
    // Check if any agent needs help
    const agents = Array.from(this.agents.values());
    const performanceData = agents.map(a => a.getPerformanceSummary());
    
    // Find underperforming agents
    const avgProfit = performanceData.reduce((sum, p) => sum + parseFloat(p.profit), 0) / agents.length;
    const underperformers = performanceData.filter(p => parseFloat(p.profit) < avgProfit * 0.5);
    
    if (underperformers.length > 0) {
      console.log(chalk.yellow(`\n⚠️ Rebalancing ${underperformers.length} underperforming agents`));
      
      // Send help from successful agents
      for (const underperformer of underperformers) {
        const agent = this.agents.get(underperformer.name);
        if (agent) {
          // Adjust strategy parameters
          agent.strategy.positionSizePercent *= 0.8; // Reduce risk
          agent.strategy.maxTradesPerHour = Math.max(1, agent.strategy.maxTradesPerHour - 2);
        }
      }
    }
  }

  private async distributeProfits(): Promise<void> {
    const agents = Array.from(this.agents.values());
    const totalProfit = agents.reduce((sum, a) => sum + a.performance.totalProfit, 0);
    
    if (totalProfit > 0) {
      const profitPerAgent = totalProfit / agents.length;
      
      // Redistribute profits equally
      for (const agent of agents) {
        const adjustment = profitPerAgent - agent.performance.totalProfit;
        // This would involve actual token transfers in production
        console.log(chalk.gray(`Profit adjustment for ${agent.config.name}: ${adjustment.toFixed(2)}`));
      }
    }
  }

  private handleAgentMessage(agent: TradingAgent, message: AgentMessage): void {
    // Route messages between agents
    if (message.to === 'BROADCAST') {
      // Send to all other agents
      for (const [id, otherAgent] of this.agents.entries()) {
        if (id !== agent.config.id) {
          otherAgent.receiveMessage(message);
        }
      }
    } else if (message.to) {
      // Send to specific agent
      const targetAgent = this.agents.get(message.to);
      if (targetAgent) {
        targetAgent.receiveMessage(message);
      }
    }
    
    // Check for consensus voting
    if (message.type === 'SIGNAL' && message.payload.confidence > 0.8) {
      this.addConsensusVote(message.payload.token, agent.config.id, message.payload);
    }
  }

  private addConsensusVote(actionId: string, agentId: string, vote: any): void {
    if (!this.consensusVotes.has(actionId)) {
      this.consensusVotes.set(actionId, new Map());
    }
    this.consensusVotes.get(actionId)!.set(agentId, vote);
  }

  private updateAgentStatus(agent: TradingAgent, status: any): void {
    this.performanceTracker.set(agent.config.id, status);
  }

  private async handleEmergency(agent: TradingAgent, message: AgentMessage): Promise<void> {
    console.log(chalk.red(`\n🚨 EMERGENCY from ${agent.config.name}: ${message.payload.error}`));
    
    if (this.config.emergencyStopEnabled) {
      console.log(chalk.red('🛑 EMERGENCY STOP TRIGGERED - Stopping all agents'));
      await this.stop();
    }
  }

  private startPerformanceMonitoring(): void {
    setInterval(() => {
      if (this.isRunning) {
        this.showPerformanceSummary();
      }
    }, 30000); // Every 30 seconds
  }

  private showPerformanceSummary(): void {
    console.log(chalk.cyan('\n📊 Swarm Performance Summary'));
    console.log(chalk.gray('================================'));
    
    const table = new Table({
      head: ['Agent', 'Role', 'Strategy', 'Trades', 'Success', 'Profit', 'Position', 'Runtime'],
      style: { head: ['cyan'] },
    });
    
    let totalProfit = 0;
    let totalTrades = 0;
    
    for (const agent of this.agents.values()) {
      const summary = agent.getPerformanceSummary();
      totalProfit += parseFloat(summary.profit);
      totalTrades += summary.trades;
      
      table.push([
        summary.name,
        summary.role,
        summary.strategy,
        summary.trades,
        summary.successRate,
        chalk[parseFloat(summary.profit) >= 0 ? 'green' : 'red'](summary.profit),
        summary.position,
        summary.runtime,
      ]);
    }
    
    console.log(table.toString());
    
    console.log(chalk.cyan('\n📈 Aggregate Metrics:'));
    console.log(chalk.gray(`   Total Profit: ${chalk[totalProfit >= 0 ? 'green' : 'red'](totalProfit.toFixed(2))}`));
    console.log(chalk.gray(`   Total Trades: ${totalTrades}`));
    console.log(chalk.gray(`   Active Agents: ${this.agents.size}`));
    console.log(chalk.gray(`   Consensus Actions: ${this.consensusVotes.size} pending`));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================
// PRESET SWARM CONFIGURATIONS
// ============================================

const PRESET_SWARMS = {
  BASIC_TRADING_TEAM: {
    name: 'Basic Trading Team',
    agents: [
      {
        id: uuidv4(),
        name: 'Leader-1',
        role: 'LEADER' as AgentRole,
        strategy: 'BALANCED' as StrategyType,
        walletPath: './wallets/agent_leader.json',
        riskLevel: 0.5,
        capital: 1000,
        maxPositionSize: 500,
        profitTarget: 5,
        stopLoss: 2,
        tradingPairs: ['SOL/USDC'],
        autonomyLevel: 0.8,
      },
      {
        id: uuidv4(),
        name: 'Follower-1',
        role: 'FOLLOWER' as AgentRole,
        strategy: 'COPY_TRADE' as StrategyType,
        walletPath: './wallets/agent_follower1.json',
        riskLevel: 0.3,
        capital: 500,
        maxPositionSize: 200,
        profitTarget: 3,
        stopLoss: 1,
        tradingPairs: ['SOL/USDC'],
        autonomyLevel: 0.5,
      },
      {
        id: uuidv4(),
        name: 'Scout-1',
        role: 'SCOUT' as AgentRole,
        strategy: 'AGGRESSIVE' as StrategyType,
        walletPath: './wallets/agent_scout.json',
        riskLevel: 0.7,
        capital: 300,
        maxPositionSize: 150,
        profitTarget: 10,
        stopLoss: 5,
        tradingPairs: ['SOL/USDC', 'BONK/USDC', 'JUP/USDC'],
        autonomyLevel: 0.9,
      },
    ],
    coordinationMode: 'CENTRALIZED' as any,
    consensusThreshold: 0.6,
    emergencyStopEnabled: true,
    profitSharing: false,
    communicationProtocol: 'NLC9' as any,
  },
  
  MARKET_MAKING_SQUAD: {
    name: 'Market Making Squad',
    agents: Array.from({ length: 5 }, (_, i) => ({
      id: uuidv4(),
      name: `MM-Agent-${i + 1}`,
      role: 'MARKET_MAKER' as AgentRole,
      strategy: i % 2 === 0 ? 'CONSERVATIVE' as StrategyType : 'BALANCED' as StrategyType,
      walletPath: `./wallets/agent_mm_${i + 1}.json`,
      riskLevel: 0.3 + (i * 0.1),
      capital: 2000,
      maxPositionSize: 1000,
      profitTarget: 2,
      stopLoss: 1,
      tradingPairs: ['SOL/USDC'],
      autonomyLevel: 0.7,
    })),
    coordinationMode: 'DECENTRALIZED' as any,
    consensusThreshold: 0.5,
    emergencyStopEnabled: true,
    profitSharing: true,
    communicationProtocol: 'NLC9' as any,
  },
  
  ARBITRAGE_HUNTERS: {
    name: 'Arbitrage Hunters',
    agents: Array.from({ length: 3 }, (_, i) => ({
      id: uuidv4(),
      name: `Arb-Hunter-${i + 1}`,
      role: 'ARBITRAGE' as AgentRole,
      strategy: 'AGGRESSIVE' as StrategyType,
      walletPath: `./wallets/agent_arb_${i + 1}.json`,
      riskLevel: 0.8,
      capital: 5000,
      maxPositionSize: 4000,
      profitTarget: 3,
      stopLoss: 0.5,
      tradingPairs: ['SOL/USDC', 'SOL/USDT', 'USDC/USDT'],
      autonomyLevel: 1.0,
    })),
    coordinationMode: 'DECENTRALIZED' as any,
    consensusThreshold: 0.3,
    emergencyStopEnabled: false,
    profitSharing: false,
    communicationProtocol: 'NLC9' as any,
  },
  
  FULL_ECOSYSTEM: {
    name: 'Full Trading Ecosystem',
    agents: [
      // Leaders
      ...Array.from({ length: 2 }, (_, i) => ({
        id: uuidv4(),
        name: `Leader-${i + 1}`,
        role: 'LEADER' as AgentRole,
        strategy: 'ADAPTIVE' as StrategyType,
        walletPath: `./wallets/agent_leader_${i + 1}.json`,
        riskLevel: 0.6,
        capital: 10000,
        maxPositionSize: 5000,
        profitTarget: 8,
        stopLoss: 3,
        tradingPairs: ['SOL/USDC', 'ETH/USDC', 'BTC/USDC'],
        autonomyLevel: 0.9,
      })),
      // Followers
      ...Array.from({ length: 4 }, (_, i) => ({
        id: uuidv4(),
        name: `Follower-${i + 1}`,
        role: 'FOLLOWER' as AgentRole,
        strategy: 'COPY_TRADE' as StrategyType,
        walletPath: `./wallets/agent_follower_${i + 1}.json`,
        riskLevel: 0.4,
        capital: 2000,
        maxPositionSize: 1000,
        profitTarget: 5,
        stopLoss: 2,
        tradingPairs: ['SOL/USDC'],
        autonomyLevel: 0.5,
      })),
      // Market Makers
      ...Array.from({ length: 3 }, (_, i) => ({
        id: uuidv4(),
        name: `MM-${i + 1}`,
        role: 'MARKET_MAKER' as AgentRole,
        strategy: 'BALANCED' as StrategyType,
        walletPath: `./wallets/agent_mm_${i + 1}.json`,
        riskLevel: 0.3,
        capital: 5000,
        maxPositionSize: 2500,
        profitTarget: 2,
        stopLoss: 1,
        tradingPairs: ['SOL/USDC'],
        autonomyLevel: 0.7,
      })),
      // Arbitrage
      ...Array.from({ length: 2 }, (_, i) => ({
        id: uuidv4(),
        name: `Arb-${i + 1}`,
        role: 'ARBITRAGE' as AgentRole,
        strategy: 'AGGRESSIVE' as StrategyType,
        walletPath: `./wallets/agent_arb_${i + 1}.json`,
        riskLevel: 0.8,
        capital: 8000,
        maxPositionSize: 6000,
        profitTarget: 3,
        stopLoss: 0.5,
        tradingPairs: ['SOL/USDC', 'SOL/USDT'],
        autonomyLevel: 1.0,
      })),
      // Scouts
      ...Array.from({ length: 3 }, (_, i) => ({
        id: uuidv4(),
        name: `Scout-${i + 1}`,
        role: 'SCOUT' as AgentRole,
        strategy: 'AGGRESSIVE' as StrategyType,
        walletPath: `./wallets/agent_scout_${i + 1}.json`,
        riskLevel: 0.7,
        capital: 1000,
        maxPositionSize: 500,
        profitTarget: 15,
        stopLoss: 7,
        tradingPairs: ['SOL/USDC', 'BONK/USDC', 'JUP/USDC', 'WIF/USDC'],
        autonomyLevel: 0.9,
      })),
      // Liquidator
      {
        id: uuidv4(),
        name: 'Liquidator-1',
        role: 'LIQUIDATOR' as AgentRole,
        strategy: 'AGGRESSIVE' as StrategyType,
        walletPath: './wallets/agent_liquidator.json',
        riskLevel: 0.9,
        capital: 20000,
        maxPositionSize: 15000,
        profitTarget: 5,
        stopLoss: 1,
        tradingPairs: ['LIQUIDATION'],
        autonomyLevel: 1.0,
      },
    ],
    coordinationMode: 'HYBRID' as any,
    consensusThreshold: 0.5,
    emergencyStopEnabled: true,
    profitSharing: true,
    communicationProtocol: 'NLC9' as any,
  },
};

// ============================================
// CLI INTERFACE
// ============================================

import { Command } from 'commander';

const program = new Command();

program
  .name('multi-agent')
  .description('Multi-Agent Trading System with NLC-9 Communication')
  .version('1.0.0');

program
  .command('start')
  .description('Start a multi-agent trading swarm')
  .option('-p, --preset <preset>', 'Use preset configuration', 'BASIC_TRADING_TEAM')
  .option('-c, --config <path>', 'Path to custom configuration file')
  .option('-d, --duration <minutes>', 'Run duration in minutes (0 = infinite)', '0')
  .action(async (options) => {
    console.log(chalk.cyan(`
╔═╗╔═╗╔═╗╔╗╔╔╦╗  ╔═╗╦ ╦╔═╗╦═╗╔╦╗
╠═╣║ ╦║╣ ║║║ ║   ╚═╗║║║╠═╣╠╦╝║║║
╩ ╩╚═╝╚═╝╝╚╝ ╩   ╚═╝╚╩╝╩ ╩╩╚═╩ ╩
    `));
    
    let config: SwarmConfig;
    
    if (options.config) {
      // Load custom config
      config = JSON.parse(fs.readFileSync(options.config, 'utf-8'));
    } else {
      // Use preset
      config = PRESET_SWARMS[options.preset as keyof typeof PRESET_SWARMS];
      if (!config) {
        console.error(chalk.red(`Unknown preset: ${options.preset}`));
        console.log('Available presets:', Object.keys(PRESET_SWARMS).join(', '));
        process.exit(1);
      }
    }
    
    console.log(chalk.cyan(`\n📋 Configuration: ${config.name}`));
    console.log(chalk.gray(`   Agents: ${config.agents.length}`));
    console.log(chalk.gray(`   Coordination: ${config.coordinationMode}`));
    console.log(chalk.gray(`   Consensus: ${(config.consensusThreshold * 100).toFixed(0)}%`));
    console.log(chalk.gray(`   Protocol: ${config.communicationProtocol}`));
    
    // Create swarm coordinator
    const swarm = new SwarmCoordinator(config);
    
    // Initialize
    await swarm.initialize();
    
    // Start swarm
    await swarm.start();
    
    // Set duration if specified
    if (options.duration && parseInt(options.duration) > 0) {
      const durationMs = parseInt(options.duration) * 60000;
      console.log(chalk.yellow(`\n⏱️ Running for ${options.duration} minutes...`));
      
      setTimeout(async () => {
        await swarm.stop();
        process.exit(0);
      }, durationMs);
    }
    
    // Handle shutdown
    process.on('SIGINT', async () => {
      console.log(chalk.yellow('\n\nReceived interrupt signal...'));
      await swarm.stop();
      process.exit(0);
    });
  });

program
  .command('list-presets')
  .description('List available preset configurations')
  .action(() => {
    console.log(chalk.cyan('\n📚 Available Presets:'));
    console.log(chalk.gray('====================\n'));
    
    for (const [key, preset] of Object.entries(PRESET_SWARMS)) {
      console.log(chalk.yellow(`${key}:`));
      console.log(chalk.gray(`  Name: ${preset.name}`));
      console.log(chalk.gray(`  Agents: ${preset.agents.length}`));
      console.log(chalk.gray(`  Mode: ${preset.coordinationMode}`));
      
      // Count agent roles
      const roleCounts = preset.agents.reduce((acc, agent) => {
        acc[agent.role] = (acc[agent.role] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      
      console.log(chalk.gray(`  Composition:`));
      for (const [role, count] of Object.entries(roleCounts)) {
        console.log(chalk.gray(`    - ${role}: ${count}`));
      }
      console.log();
    }
  });

program
  .command('generate-config')
  .description('Generate a custom swarm configuration')
  .option('-n, --name <name>', 'Swarm name', 'Custom Swarm')
  .option('-l, --leaders <count>', 'Number of leader agents', '1')
  .option('-f, --followers <count>', 'Number of follower agents', '2')
  .option('-m, --market-makers <count>', 'Number of market maker agents', '1')
  .option('-a, --arbitrage <count>', 'Number of arbitrage agents', '0')
  .option('-s, --scouts <count>', 'Number of scout agents', '1')
  .option('-o, --output <path>', 'Output file path', './swarm-config.json')
  .action((options) => {
    const agents: AgentConfig[] = [];
    
    // Generate leaders
    for (let i = 0; i < parseInt(options.leaders); i++) {
      agents.push({
        id: uuidv4(),
        name: `Leader-${i + 1}`,
        role: 'LEADER',
        strategy: 'ADAPTIVE',
        walletPath: `./wallets/agent_leader_${i + 1}.json`,
        riskLevel: 0.6,
        capital: 5000,
        maxPositionSize: 2500,
        profitTarget: 8,
        stopLoss: 3,
        tradingPairs: ['SOL/USDC'],
        autonomyLevel: 0.9,
      });
    }
    
    // Generate followers
    for (let i = 0; i < parseInt(options.followers); i++) {
      agents.push({
        id: uuidv4(),
        name: `Follower-${i + 1}`,
        role: 'FOLLOWER',
        strategy: 'COPY_TRADE',
        walletPath: `./wallets/agent_follower_${i + 1}.json`,
        riskLevel: 0.4,
        capital: 2000,
        maxPositionSize: 1000,
        profitTarget: 5,
        stopLoss: 2,
        tradingPairs: ['SOL/USDC'],
        autonomyLevel: 0.5,
      });
    }
    
    // Generate market makers
    for (let i = 0; i < parseInt(options.marketMakers); i++) {
      agents.push({
        id: uuidv4(),
        name: `MM-${i + 1}`,
        role: 'MARKET_MAKER',
        strategy: 'BALANCED',
        walletPath: `./wallets/agent_mm_${i + 1}.json`,
        riskLevel: 0.3,
        capital: 3000,
        maxPositionSize: 1500,
        profitTarget: 2,
        stopLoss: 1,
        tradingPairs: ['SOL/USDC'],
        autonomyLevel: 0.7,
      });
    }
    
    // Generate arbitrage agents
    for (let i = 0; i < parseInt(options.arbitrage); i++) {
      agents.push({
        id: uuidv4(),
        name: `Arb-${i + 1}`,
        role: 'ARBITRAGE',
        strategy: 'AGGRESSIVE',
        walletPath: `./wallets/agent_arb_${i + 1}.json`,
        riskLevel: 0.8,
        capital: 5000,
        maxPositionSize: 4000,
        profitTarget: 3,
        stopLoss: 0.5,
        tradingPairs: ['SOL/USDC', 'SOL/USDT'],
        autonomyLevel: 1.0,
      });
    }
    
    // Generate scouts
    for (let i = 0; i < parseInt(options.scouts); i++) {
      agents.push({
        id: uuidv4(),
        name: `Scout-${i + 1}`,
        role: 'SCOUT',
        strategy: 'AGGRESSIVE',
        walletPath: `./wallets/agent_scout_${i + 1}.json`,
        riskLevel: 0.7,
        capital: 1000,
        maxPositionSize: 500,
        profitTarget: 15,
        stopLoss: 7,
        tradingPairs: ['SOL/USDC', 'BONK/USDC'],
        autonomyLevel: 0.9,
      });
    }
    
    const config: SwarmConfig = {
      name: options.name,
      agents,
      coordinationMode: agents.length > 5 ? 'HYBRID' : 'CENTRALIZED',
      consensusThreshold: 0.5,
      emergencyStopEnabled: true,
      profitSharing: agents.length > 3,
      communicationProtocol: 'NLC9',
    };
    
    fs.writeFileSync(options.output, JSON.stringify(config, null, 2));
    
    console.log(chalk.green(`✅ Configuration saved to ${options.output}`));
    console.log(chalk.gray(`   Total agents: ${agents.length}`));
  });

// Parse command line arguments
program.parse(process.argv);

// If no command specified, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}