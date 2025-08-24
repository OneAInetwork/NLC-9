import axios from 'axios';
import dotenv from 'dotenv';
import { Connection, PublicKey } from '@solana/web3.js';

// Load environment variables
dotenv.config();

// Configuration
const API_BASE_URL = `http://localhost:${process.env.NLC9_PORT || 3009}`;
const EXECUTE_TRANSACTIONS = process.env.NLC9_EXECUTE_TRANSACTIONS === 'true';

// Market Making Configuration
const MIN_ORDER_USD = parseFloat(process.env.NLC9_MIN_ORDER_USD || '0.10');
const MAX_ORDER_USD = parseFloat(process.env.NLC9_MAX_ORDER_USD || '25');
const TOTAL_VOLUME_USD = parseFloat(process.env.NLC9_TOTAL_VOLUME_USD || '54');
const MIN_ORDERS = parseInt(process.env.NLC9_MIN_ORDERS || '1');
const MAX_ORDERS = parseInt(process.env.NLC9_MAX_ORDERS || '10');
const ORDER_DELAY_MS = parseInt(process.env.NLC9_ORDER_DELAY_MS || '100');
const CYCLE_INTERVAL_MS = parseInt(process.env.NLC9_CYCLE_INTERVAL_MS || '60000');

// NLC9 Enhanced Profit & Rebalancing Configuration
const NLC9_PROFIT_TARGET_PERCENT = parseFloat(process.env.NLC9_PROFIT_TARGET_PERCENT || '0.3'); // 0.3% profit target per cycle
const NLC9_PROFIT_REINVEST_RATIO = parseFloat(process.env.NLC9_PROFIT_REINVEST_RATIO || '0.7'); // 70% of profit reinvested
const NLC9_REBALANCE_THRESHOLD = parseFloat(process.env.NLC9_REBALANCE_THRESHOLD || '0.15'); // Rebalance when 15% imbalanced
const NLC9_MAX_POSITION_RATIO = parseFloat(process.env.NLC9_MAX_POSITION_RATIO || '0.6'); // Max 60% in one asset
const NLC9_PROFIT_CHECK_CYCLES = parseInt(process.env.NLC9_PROFIT_CHECK_CYCLES || '5'); // Check profit every 5 cycles
const NLC9_VOLUME_BOOST_ON_PROFIT = parseFloat(process.env.NLC9_VOLUME_BOOST_ON_PROFIT || '1.5'); // 1.5x volume when profitable
const NLC9_MIN_SPREAD_PERCENT = parseFloat(process.env.NLC9_MIN_SPREAD_PERCENT || '0.1'); // Min 0.1% spread for orders
const NLC9_ADAPTIVE_SPREAD = process.env.NLC9_ADAPTIVE_SPREAD === 'true'; // Enable adaptive spread
const NLC9_COMPOUND_PROFITS = process.env.NLC9_COMPOUND_PROFITS === 'true'; // Compound profits into base capital

// Token configuration
const USDC_MINT = process.env.NLC9_USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MYTOKEN_MINT = process.env.NLC9_MYTOKEN_MINT || '8P4sBQQrAePwpxmDTeE7SKvzxSkxTe1FwdwfzevRfpaD';
const POOL_ADDRESS = process.env.NLC9_POOL_ADDRESS || 'H7SXKFC8LxBFgduSx1vQQdE7JNqphzP1axF23G3xpoFj';

interface Order {
  type: 'buy' | 'sell';
  amount: number;
  price: number;
  timestamp: Date;
  success: boolean;
  txHash?: string;
  error?: string;
  targetPrice?: number; // Price we aimed for
  slippage?: number; // Actual slippage
}

interface MarketState {
  currentPrice: number;
  mytokenPerUsdc: number;
  spread: number;
  volume24h: number;
  lastUpdate: Date;
  priceHistory: Array<{ price: number; timestamp: Date }>;
  volatility: number; // Price volatility percentage
}

interface Position {
  usdcBalance: number;
  mytokenBalance: number;
  totalUsdcSpent: number;
  totalUsdcReceived: number;
  totalMytokenBought: number;
  totalMytokenSold: number;
  netProfit: number;
  orders: Order[];
  cycleCount: number;
  profitableCycles: number;
  cycleProfit: Map<number, number>; // Track profit per cycle
  baseCapital: number; // Initial capital for tracking returns
  compoundedCapital: number; // Capital including reinvested profits
}

interface RebalanceStrategy {
  shouldRebalance: boolean;
  targetUsdcRatio: number;
  targetMytokenRatio: number;
  rebalanceAmount: number;
  rebalanceType: 'buy' | 'sell' | null;
}

class MarketMakerBot {
  private apiClient = axios.create({
    baseURL: API_BASE_URL,
    timeout: 30000,
    headers: {
      'Content-Type': 'application/json',
    },
  });

  private position: Position = {
    usdcBalance: 0,
    mytokenBalance: 0,
    totalUsdcSpent: 0,
    totalUsdcReceived: 0,
    totalMytokenBought: 0,
    totalMytokenSold: 0,
    netProfit: 0,
    orders: [],
    cycleCount: 0,
    profitableCycles: 0,
    cycleProfit: new Map(),
    baseCapital: TOTAL_VOLUME_USD * 2, // Assume starting capital
    compoundedCapital: TOTAL_VOLUME_USD * 2,
  };

  private marketState: MarketState = {
    currentPrice: 0,
    mytokenPerUsdc: 0,
    spread: 0,
    volume24h: 0,
    lastUpdate: new Date(),
    priceHistory: [],
    volatility: 0,
  };

  private poolAddress: string = '';
  private running: boolean = false;
  private tokenPositions: { usdcIsTokenA: boolean } = { usdcIsTokenA: true };
  private lastRebalanceCycle: number = 0;

  // Calculate position value in USDC
  private getPortfolioValueUSDC(): number {
    const tokenValueInUsdc = this.position.mytokenBalance * this.marketState.currentPrice;
    return this.position.usdcBalance + tokenValueInUsdc;
  }

  // Calculate position ratios
  private getPositionRatios(): { usdcRatio: number; mytokenRatio: number } {
    const totalValue = this.getPortfolioValueUSDC();
    if (totalValue === 0) return { usdcRatio: 0.5, mytokenRatio: 0.5 };
    
    const tokenValueInUsdc = this.position.mytokenBalance * this.marketState.currentPrice;
    return {
      usdcRatio: this.position.usdcBalance / totalValue,
      mytokenRatio: tokenValueInUsdc / totalValue,
    };
  }

  // Calculate price volatility
  private calculateVolatility(): number {
    if (this.marketState.priceHistory.length < 10) return 0;
    
    const recentPrices = this.marketState.priceHistory.slice(-20);
    const avgPrice = recentPrices.reduce((sum, p) => sum + p.price, 0) / recentPrices.length;
    const variance = recentPrices.reduce((sum, p) => sum + Math.pow(p.price - avgPrice, 2), 0) / recentPrices.length;
    const stdDev = Math.sqrt(variance);
    
    return (stdDev / avgPrice) * 100; // Volatility as percentage
  }

  // Determine rebalancing strategy
  private determineRebalanceStrategy(): RebalanceStrategy {
    const ratios = this.getPositionRatios();
    const imbalance = Math.abs(ratios.usdcRatio - 0.5);
    
    const strategy: RebalanceStrategy = {
      shouldRebalance: false,
      targetUsdcRatio: 0.5,
      targetMytokenRatio: 0.5,
      rebalanceAmount: 0,
      rebalanceType: null,
    };
    
    // Check if rebalancing is needed
    if (imbalance > NLC9_REBALANCE_THRESHOLD) {
      strategy.shouldRebalance = true;
      
      // Adjust target ratios based on market conditions
      if (this.marketState.volatility > 5) {
        // Higher volatility: hold more USDC for stability
        strategy.targetUsdcRatio = 0.55;
        strategy.targetMytokenRatio = 0.45;
      } else if (this.marketState.volatility < 2) {
        // Lower volatility: can hold more tokens
        strategy.targetUsdcRatio = 0.45;
        strategy.targetMytokenRatio = 0.55;
      }
      
      // Calculate rebalance amount
      const totalValue = this.getPortfolioValueUSDC();
      const targetUsdcValue = totalValue * strategy.targetUsdcRatio;
      const currentUsdcValue = this.position.usdcBalance;
      
      if (currentUsdcValue < targetUsdcValue) {
        // Need more USDC, sell tokens
        strategy.rebalanceType = 'sell';
        strategy.rebalanceAmount = (targetUsdcValue - currentUsdcValue) / this.marketState.currentPrice;
      } else {
        // Need more tokens, buy with USDC
        strategy.rebalanceType = 'buy';
        strategy.rebalanceAmount = currentUsdcValue - targetUsdcValue;
      }
    }
    
    return strategy;
  }

  // Calculate adaptive spread based on volatility
  private calculateAdaptiveSpread(): number {
    if (!NLC9_ADAPTIVE_SPREAD) {
      return NLC9_MIN_SPREAD_PERCENT / 100;
    }
    
    const baseSpread = NLC9_MIN_SPREAD_PERCENT / 100;
    const volatilityMultiplier = 1 + (this.marketState.volatility / 100);
    
    return Math.min(baseSpread * volatilityMultiplier, 0.01); // Cap at 1%
  }

  // Update market state with enhanced metrics
  private async updateMarketState(): Promise<void> {
    try {
      const response = await this.apiClient.get(`/pool/${this.poolAddress}/price`);
      const priceData = response.data.data;
      
      let usdcPerMytoken: number;
      let mytokenPerUsdc: number;
      
      if (priceData.tokenAMint === USDC_MINT && priceData.tokenBMint === MYTOKEN_MINT) {
        usdcPerMytoken = priceData.price.aPerB;
        mytokenPerUsdc = priceData.price.bPerA;
      } else if (priceData.tokenAMint === MYTOKEN_MINT && priceData.tokenBMint === USDC_MINT) {
        mytokenPerUsdc = priceData.price.bPerA;
        usdcPerMytoken = priceData.price.aPerB;
      } else {
        usdcPerMytoken = priceData.price.aPerB;
        mytokenPerUsdc = priceData.price.bPerA;
      }
      
      // Update price history
      this.marketState.priceHistory.push({
        price: usdcPerMytoken,
        timestamp: new Date(),
      });
      
      // Keep only last 100 price points
      if (this.marketState.priceHistory.length > 100) {
        this.marketState.priceHistory = this.marketState.priceHistory.slice(-100);
      }
      
      this.marketState.currentPrice = usdcPerMytoken;
      this.marketState.mytokenPerUsdc = mytokenPerUsdc;
      this.marketState.lastUpdate = new Date();
      this.marketState.volatility = this.calculateVolatility();
      this.marketState.spread = this.calculateAdaptiveSpread();
      
    } catch (error) {
      console.error('Error updating market state:', error);
    }
  }

  // Find or verify pool
  private async findPool(): Promise<string> {
    try {
      if (POOL_ADDRESS) {
        console.log(`Verifying pool: ${POOL_ADDRESS}`);
        const response = await this.apiClient.get(`/pool/exists/${POOL_ADDRESS}`);
        if (response.data.data) {
          console.log('✅ Pool verified');
          
          const poolInfo = await this.apiClient.get(`/pool/${POOL_ADDRESS}/price`);
          this.tokenPositions.usdcIsTokenA = poolInfo.data.data.tokenAMint === USDC_MINT;
          
          return POOL_ADDRESS;
        }
      }

      console.log('Searching for USDC-MYTOKEN pool...');
      const response = await this.apiClient.get('/pools/find', {
        params: {
          tokenA: USDC_MINT,
          tokenB: MYTOKEN_MINT,
        },
      });

      const pools = response.data.data.pools;
      if (pools.length === 0) {
        throw new Error('No pool found for USDC-MYTOKEN pair');
      }

      const activePool = pools.find((p: any) => p.hasLiquidity) || pools[0];
      console.log(`✅ Found pool: ${activePool.address}`);
      
      this.tokenPositions.usdcIsTokenA = activePool.tokenAMint === USDC_MINT;
      
      return activePool.address;
    } catch (error) {
      console.error('Error finding pool:', error);
      throw error;
    }
  }

  // Execute order with enhanced tracking
  private async executeOrder(
    type: 'buy' | 'sell',
    amount: number,
    execute: boolean = false,
    targetPrice?: number
  ): Promise<Order> {
    try {
      const inputMint = type === 'buy' ? USDC_MINT : MYTOKEN_MINT;
      const outputMint = type === 'buy' ? MYTOKEN_MINT : USDC_MINT;
      
      const endpoint = execute ? '/swap' : '/swap/simulate';
      const response = await this.apiClient.post(endpoint, {
        poolAddress: this.poolAddress,
        inputMint,
        outputMint,
        inputAmount: amount,
        executeTransaction: execute,
        slippageBps: 50,
      });

      if (response.data.success) {
        const outputAmount = parseFloat(response.data.data.quote.outputAmount);
        
        // Update position tracking
        if (type === 'buy') {
          this.position.totalUsdcSpent += amount;
          this.position.totalMytokenBought += outputAmount;
          this.position.mytokenBalance += outputAmount;
          this.position.usdcBalance -= amount;
        } else {
          this.position.totalMytokenSold += amount;
          this.position.totalUsdcReceived += outputAmount;
          this.position.usdcBalance += outputAmount;
          this.position.mytokenBalance -= amount;
        }
        
        const actualPrice = type === 'buy' ? amount / outputAmount : outputAmount / amount;
        const slippage = targetPrice ? ((actualPrice - targetPrice) / targetPrice) * 100 : 0;
        
        const order: Order = {
          type,
          amount,
          price: actualPrice,
          timestamp: new Date(),
          success: true,
          txHash: response.data.data.signature,
          targetPrice,
          slippage,
        };
        
        this.position.orders.push(order);
        return order;
      } else {
        const order: Order = {
          type,
          amount,
          price: 0,
          timestamp: new Date(),
          success: false,
          error: response.data.error,
        };
        
        this.position.orders.push(order);
        return order;
      }
    } catch (error: any) {
      const order: Order = {
        type,
        amount,
        price: 0,
        timestamp: new Date(),
        success: false,
        error: error.message,
      };
      
      this.position.orders.push(order);
      return order;
    }
  }

  // Generate smart order sequence with spread
  private generateSmartOrders(
    totalUsdAmount: number, 
    useSpread: boolean = true
  ): Array<{type: 'buy' | 'sell', amountUsd: number, targetPrice?: number}> {
    const orders: Array<{type: 'buy' | 'sell', amountUsd: number, targetPrice?: number}> = [];
    
    // Adjust order counts based on volatility
    const volatilityFactor = Math.max(0.5, Math.min(2, 1 + this.marketState.volatility / 10));
    const adjustedMinOrders = Math.max(1, Math.floor(MIN_ORDERS * volatilityFactor));
    const adjustedMaxOrders = Math.min(20, Math.floor(MAX_ORDERS * volatilityFactor));
    
    const numBuyOrders = Math.floor(Math.random() * (adjustedMaxOrders - adjustedMinOrders)) + adjustedMinOrders;
    const numSellOrders = Math.floor(Math.random() * (adjustedMaxOrders - adjustedMinOrders)) + adjustedMinOrders;
    
    const spread = this.marketState.spread;
    const midPrice = this.marketState.currentPrice;
    
    // Generate buy orders (below mid price if using spread)
    let remainingBuyAmount = totalUsdAmount;
    for (let i = 0; i < numBuyOrders && remainingBuyAmount > MIN_ORDER_USD; i++) {
      const isLast = i === numBuyOrders - 1;
      const maxAmount = isLast ? remainingBuyAmount : Math.min(MAX_ORDER_USD, remainingBuyAmount);
      const minAmount = isLast ? remainingBuyAmount : Math.min(MIN_ORDER_USD, remainingBuyAmount);
      const amount = Math.random() * (maxAmount - minAmount) + minAmount;
      
      const targetPrice = useSpread ? midPrice * (1 - spread * (0.5 + Math.random() * 0.5)) : midPrice;
      
      orders.push({ 
        type: 'buy', 
        amountUsd: Math.min(amount, remainingBuyAmount),
        targetPrice 
      });
      remainingBuyAmount -= amount;
    }
    
    // Generate sell orders (above mid price if using spread)
    let remainingSellAmount = totalUsdAmount;
    for (let i = 0; i < numSellOrders && remainingSellAmount > MIN_ORDER_USD; i++) {
      const isLast = i === numSellOrders - 1;
      const maxAmount = isLast ? remainingSellAmount : Math.min(MAX_ORDER_USD, remainingSellAmount);
      const minAmount = isLast ? remainingSellAmount : Math.min(MIN_ORDER_USD, remainingSellAmount);
      const amount = Math.random() * (maxAmount - minAmount) + minAmount;
      
      const targetPrice = useSpread ? midPrice * (1 + spread * (0.5 + Math.random() * 0.5)) : midPrice;
      
      orders.push({ 
        type: 'sell', 
        amountUsd: Math.min(amount, remainingSellAmount),
        targetPrice 
      });
      remainingSellAmount -= amount;
    }
    
    // Shuffle orders
    for (let i = orders.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [orders[i], orders[j]] = [orders[j], orders[i]];
    }
    
    return orders;
  }

  // Execute rebalancing
  private async executeRebalancing(): Promise<void> {
    const strategy = this.determineRebalanceStrategy();
    
    if (!strategy.shouldRebalance || this.position.cycleCount - this.lastRebalanceCycle < 3) {
      return;
    }
    
    console.log('\n⚖️ REBALANCING PORTFOLIO');
    console.log('========================');
    const ratios = this.getPositionRatios();
    console.log(`Current: USDC ${(ratios.usdcRatio * 100).toFixed(1)}% | TOKEN ${(ratios.mytokenRatio * 100).toFixed(1)}%`);
    console.log(`Target: USDC ${(strategy.targetUsdcRatio * 100).toFixed(1)}% | TOKEN ${(strategy.targetMytokenRatio * 100).toFixed(1)}%`);
    
    if (strategy.rebalanceType && strategy.rebalanceAmount > MIN_ORDER_USD) {
      const result = await this.executeOrder(
        strategy.rebalanceType,
        strategy.rebalanceAmount,
        EXECUTE_TRANSACTIONS
      );
      
      if (result.success) {
        console.log(`✅ Rebalanced: ${strategy.rebalanceType} ${strategy.rebalanceAmount.toFixed(4)}`);
        this.lastRebalanceCycle = this.position.cycleCount;
      } else {
        console.log(`❌ Rebalancing failed: ${result.error}`);
      }
    }
  }

  // Calculate and handle cycle profit
  private async handleCycleProfit(): Promise<number> {
    const cycleStartValue = this.position.compoundedCapital;
    const currentValue = this.getPortfolioValueUSDC();
    const cycleProfit = currentValue - cycleStartValue;
    const cycleReturn = (cycleProfit / cycleStartValue) * 100;
    
    this.position.cycleProfit.set(this.position.cycleCount, cycleProfit);
    
    if (cycleReturn >= NLC9_PROFIT_TARGET_PERCENT) {
      this.position.profitableCycles++;
      console.log(`\n💰 PROFITABLE CYCLE! Return: ${cycleReturn.toFixed(3)}%`);
      
      // Calculate reinvestment
      const profitToReinvest = cycleProfit * NLC9_PROFIT_REINVEST_RATIO;
      const profitToKeep = cycleProfit * (1 - NLC9_PROFIT_REINVEST_RATIO);
      
      if (NLC9_COMPOUND_PROFITS) {
        this.position.compoundedCapital = currentValue;
        console.log(`📈 Compounding full profit: $${cycleProfit.toFixed(4)}`);
      } else {
        this.position.compoundedCapital = cycleStartValue + profitToReinvest;
        console.log(`💵 Keeping profit: $${profitToKeep.toFixed(4)}`);
        console.log(`🔄 Reinvesting: $${profitToReinvest.toFixed(4)}`);
      }
      
      return profitToReinvest;
    }
    
    return 0;
  }

  // Execute enhanced market making cycle
  private async executeMarketMakingCycle(volumeMultiplier: number = 1): Promise<void> {
    this.position.cycleCount++;
    
    console.log(`\n🔄 MARKET MAKING CYCLE ${this.position.cycleCount}`);
    console.log('=====================================');
    console.log(`Volume Target: $${(TOTAL_VOLUME_USD * volumeMultiplier).toFixed(2)} per side`);
    console.log(`Current Price: ${this.marketState.currentPrice.toFixed(9)} USDC per MYTOKEN`);
    console.log(`Volatility: ${this.marketState.volatility.toFixed(2)}%`);
    console.log(`Spread: ${(this.marketState.spread * 100).toFixed(3)}%`);
    
    const ratios = this.getPositionRatios();
    console.log(`Position: USDC ${(ratios.usdcRatio * 100).toFixed(1)}% | TOKEN ${(ratios.mytokenRatio * 100).toFixed(1)}%`);
    console.log(`Portfolio Value: $${this.getPortfolioValueUSDC().toFixed(4)}`);
    console.log('=====================================\n');
    
    // Check if rebalancing needed
    if (this.position.cycleCount % NLC9_PROFIT_CHECK_CYCLES === 0) {
      await this.executeRebalancing();
    }
    
    // Generate smart orders with spread
    const orders = this.generateSmartOrders(TOTAL_VOLUME_USD * volumeMultiplier, true);
    
    console.log(`📋 Order Queue: ${orders.filter(o => o.type === 'buy').length} buys, ${orders.filter(o => o.type === 'sell').length} sells`);
    console.log(`📊 Total: $${orders.reduce((sum, o) => sum + o.amountUsd, 0).toFixed(2)}\n`);
    
    let successfulBuys = 0;
    let successfulSells = 0;
    let totalBuyVolume = 0;
    let totalSellVolume = 0;
    let totalSlippage = 0;
    let slippageCount = 0;
    
    // Execute orders
    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      const orderNumber = i + 1;
      
      process.stdout.write(`\r⚡ Order ${orderNumber}/${orders.length} (${order.type})... `);
      
      let orderAmount = order.amountUsd;
      if (order.type === 'sell') {
        orderAmount = order.amountUsd / this.marketState.currentPrice;
      }
      
      const result = await this.executeOrder(
        order.type, 
        orderAmount, 
        EXECUTE_TRANSACTIONS,
        order.targetPrice
      );
      
      if (result.success) {
        if (order.type === 'buy') {
          successfulBuys++;
          totalBuyVolume += order.amountUsd;
          process.stdout.write(`✅ @ ${result.price.toFixed(6)}`);
        } else {
          successfulSells++;
          totalSellVolume += order.amountUsd;
          process.stdout.write(`✅ @ ${result.price.toFixed(6)}`);
        }
        
        if (result.slippage !== undefined) {
          totalSlippage += Math.abs(result.slippage);
          slippageCount++;
          process.stdout.write(` (slip: ${result.slippage.toFixed(3)}%)\n`);
        } else {
          process.stdout.write('\n');
        }
      } else {
        process.stdout.write(`❌ ${result.error}\n`);
      }
      
      if (i < orders.length - 1) {
        await new Promise(resolve => setTimeout(resolve, ORDER_DELAY_MS));
      }
      
      if (i % 5 === 0) {
        await this.updateMarketState();
      }
    }
    
    // Calculate cycle results
    const avgSlippage = slippageCount > 0 ? totalSlippage / slippageCount : 0;
    
    console.log('\n📊 Cycle Summary:');
    console.log(`  Successful: ${successfulBuys + successfulSells}/${orders.length}`);
    console.log(`  Buy Volume: $${totalBuyVolume.toFixed(2)} (${successfulBuys} orders)`);
    console.log(`  Sell Volume: $${totalSellVolume.toFixed(2)} (${successfulSells} orders)`);
    console.log(`  Avg Slippage: ${avgSlippage.toFixed(3)}%`);
    
    // Update profit tracking
    this.position.netProfit = this.position.totalUsdcReceived - this.position.totalUsdcSpent;
    const portfolioValue = this.getPortfolioValueUSDC();
    const totalReturn = ((portfolioValue - this.position.baseCapital) / this.position.baseCapital) * 100;
    
    console.log(`  Portfolio Value: $${portfolioValue.toFixed(4)}`);
    console.log(`  Net P&L: ${this.position.netProfit >= 0 ? '+' : ''}$${this.position.netProfit.toFixed(4)}`);
    console.log(`  Total Return: ${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%`);
    
    // Handle profit reinvestment
    const reinvestAmount = await this.handleCycleProfit();
    if (reinvestAmount > 0 && this.position.cycleCount < 100) { // Limit bonus cycles
      const bonusMultiplier = Math.min(NLC9_VOLUME_BOOST_ON_PROFIT, 1 + reinvestAmount / TOTAL_VOLUME_USD);
      console.log(`\n🎯 Executing bonus volume (${bonusMultiplier.toFixed(1)}x) from profits...`);
      
      const bonusOrders = this.generateSmartOrders(TOTAL_VOLUME_USD * (bonusMultiplier - 1), false);
      for (const order of bonusOrders.slice(0, 10)) { // Limit to 10 bonus orders
        const amount = order.type === 'sell' ? 
          order.amountUsd / this.marketState.currentPrice : 
          order.amountUsd;
        
        await this.executeOrder(order.type, amount, EXECUTE_TRANSACTIONS);
        await new Promise(resolve => setTimeout(resolve, ORDER_DELAY_MS));
      }
    }
  }

  // Main loop
  public async run(): Promise<void> {
    console.log('🤖 NLC9 ENHANCED MARKET MAKER BOT');
    console.log('=====================================');
    console.log(`Mode: ${EXECUTE_TRANSACTIONS ? '⚠️ LIVE TRADING' : '🔵 SIMULATION'}`);
    console.log('\n📊 NLC9 Configuration:');
    console.log(`  Profit Target: ${NLC9_PROFIT_TARGET_PERCENT}% per cycle`);
    console.log(`  Reinvest Ratio: ${(NLC9_PROFIT_REINVEST_RATIO * 100).toFixed(0)}%`);
    console.log(`  Rebalance Threshold: ${(NLC9_REBALANCE_THRESHOLD * 100).toFixed(0)}%`);
    console.log(`  Max Position Ratio: ${(NLC9_MAX_POSITION_RATIO * 100).toFixed(0)}%`);
    console.log(`  Profit Check: Every ${NLC9_PROFIT_CHECK_CYCLES} cycles`);
    console.log(`  Volume Boost: ${NLC9_VOLUME_BOOST_ON_PROFIT}x on profit`);
    console.log(`  Adaptive Spread: ${NLC9_ADAPTIVE_SPREAD ? 'Enabled' : 'Disabled'}`);
    console.log(`  Compound Profits: ${NLC9_COMPOUND_PROFITS ? 'Yes' : 'No'}`);
    console.log('=====================================\n');
    
    try {
      this.poolAddress = await this.findPool();
      await this.updateMarketState();
      
      console.log(`📍 Initial Market State:`);
      console.log(`  Price: ${this.marketState.currentPrice.toFixed(9)} USDC per MYTOKEN`);
      console.log(`  1 USDC = ${this.marketState.mytokenPerUsdc.toFixed(2)} MYTOKEN\n`);
      
      this.running = true;
      
      while (this.running) {
        const cycleStart = Date.now();
        
        // Determine volume multiplier based on performance
        let volumeMultiplier = 1;
        if (this.position.profitableCycles > this.position.cycleCount * 0.3) {
          // If more than 30% cycles profitable, increase volume
          volumeMultiplier = 1 + (this.position.profitableCycles / this.position.cycleCount) * 0.5;
        }
        
        await this.executeMarketMakingCycle(volumeMultiplier);
        
        const timeElapsed = Date.now() - cycleStart;
        const waitTime = Math.max(0, CYCLE_INTERVAL_MS - timeElapsed);
        
        if (waitTime > 0) {
          console.log(`\n⏳ Next cycle in ${Math.floor(waitTime / 60000)} minutes...`);
          console.log(`   Success Rate: ${((this.position.profitableCycles / this.position.cycleCount) * 100).toFixed(1)}%\n`);
          
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
      
    } catch (error) {
      console.error('\n❌ Bot Error:', error);
      throw error;
    } finally {
      this.printFinalReport();
    }
  }

  // Stop the bot
  public stop(): void {
    console.log('\n🛑 Stopping market maker bot...');
    this.running = false;
  }

  // Enhanced final report
  private printFinalReport(): void {
    console.log('\n\n🏁 NLC9 FINAL MARKET MAKING REPORT');
    console.log('=====================================');
    
    const portfolioValue = this.getPortfolioValueUSDC();
    const totalReturn = ((portfolioValue - this.position.baseCapital) / this.position.baseCapital) * 100;
    const ratios = this.getPositionRatios();
    
    console.log('\n💼 Portfolio Performance:');
    console.log(`  Initial Capital: $${this.position.baseCapital.toFixed(2)}`);
    console.log(`  Final Value: $${portfolioValue.toFixed(4)}`);
    console.log(`  Total Return: ${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%`);
    console.log(`  Net P&L: ${this.position.netProfit >= 0 ? '+' : ''}$${this.position.netProfit.toFixed(4)}`);
    
    console.log('\n📊 Trading Statistics:');
    console.log(`  Total Cycles: ${this.position.cycleCount}`);
    console.log(`  Profitable Cycles: ${this.position.profitableCycles} (${((this.position.profitableCycles / this.position.cycleCount) * 100).toFixed(1)}%)`);
    console.log(`  Total Orders: ${this.position.orders.length}`);
    console.log(`  Success Rate: ${((this.position.orders.filter(o => o.success).length / this.position.orders.length) * 100).toFixed(1)}%`);
    console.log(`  Total Volume: $${(this.position.totalUsdcSpent + this.position.totalUsdcReceived).toFixed(2)}`);
    
    console.log('\n⚖️ Final Position:');
    console.log(`  USDC: ${this.position.usdcBalance.toFixed(4)} (${(ratios.usdcRatio * 100).toFixed(1)}%)`);
    console.log(`  MYTOKEN: ${this.position.mytokenBalance.toFixed(2)} (${(ratios.mytokenRatio * 100).toFixed(1)}%)`);
    console.log(`  Token Value: $${(this.position.mytokenBalance * this.marketState.currentPrice).toFixed(4)}`);
    
    console.log('\n📈 Market Metrics:');
    console.log(`  Final Price: ${this.marketState.currentPrice.toFixed(9)} USDC`);
    console.log(`  Volatility: ${this.marketState.volatility.toFixed(2)}%`);
    
    // Calculate average profit per cycle
    let totalCycleProfit = 0;
    this.position.cycleProfit.forEach(profit => totalCycleProfit += profit);
    const avgCycleProfit = totalCycleProfit / this.position.cycleCount;
    
    console.log('\n💰 Profit Analysis:');
    console.log(`  Avg Profit/Cycle: ${avgCycleProfit >= 0 ? '+' : ''}$${avgCycleProfit.toFixed(4)}`);
    console.log(`  Best Cycle: $${Math.max(...Array.from(this.position.cycleProfit.values())).toFixed(4)}`);
    console.log(`  Worst Cycle: $${Math.min(...Array.from(this.position.cycleProfit.values())).toFixed(4)}`);
    
    // Calculate Sharpe ratio approximation
    const profits = Array.from(this.position.cycleProfit.values());
    const avgProfit = profits.reduce((a, b) => a + b, 0) / profits.length;
    const variance = profits.reduce((sum, p) => sum + Math.pow(p - avgProfit, 2), 0) / profits.length;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev > 0 ? (avgProfit / stdDev) * Math.sqrt(365 * 24 * 60 / (CYCLE_INTERVAL_MS / 60000)) : 0;
    
    console.log(`  Sharpe Ratio: ${sharpeRatio.toFixed(2)}`);
    
    console.log('\n=====================================');
    console.log('NLC9 Market Making Session Complete!');
    console.log('=====================================\n');
  }
}

// Main execution
async function main() {
  const bot = new MarketMakerBot();
  
  const args = process.argv.slice(2);
  const executeMode = args[0] === 'execute';
  
  if (executeMode || EXECUTE_TRANSACTIONS) {
    console.log('⚠️  WARNING: Running in EXECUTE mode - real transactions!');
    console.log('Press Ctrl+C within 5 seconds to cancel...\n');
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  process.on('SIGINT', () => {
    console.log('\n\n⚠️ Shutting down gracefully...');
    bot.stop();
    setTimeout(() => process.exit(0), 2000);
  });

  try {
    await bot.run();
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}

export default MarketMakerBot;