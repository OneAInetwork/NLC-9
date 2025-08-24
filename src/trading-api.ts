import express from 'express';
import cors from 'cors';
import { clusterApiUrl, Connection, Keypair, PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  CpAmm,
  getPriceFromSqrtPrice,
  getSqrtPriceFromPrice,
} from "@meteora-ag/cp-amm-sdk";
import {
  getMint,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const app = express();
const PORT2 = process.env.PORT2 || 3009;

// Environment variables with defaults
const DEFAULT_RPC_URL = process.env.SOLANA_RPC_URL || clusterApiUrl(process.env.SOLANA_NETWORK as any || "devnet");
const DEFAULT_KEYPAIR_PATH = process.env.WALLET_KEYPAIR_PATH || "./solana/main.json";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const DEFAULT_SLIPPAGE_BPS = parseInt(process.env.DEFAULT_SLIPPAGE_BPS || "100"); // 1%

// Common token addresses (can be extended via environment variables)
const KNOWN_TOKENS: { [key: string]: { mint: string, symbol: string, name: string, decimals?: number } } = {
  SOL: {
    mint: NATIVE_MINT.toString(),
    symbol: 'SOL',
    name: 'Solana',
    decimals: 9,
  },
  USDC: {
    mint: process.env.USDC_MINT || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
  },
  // Add more tokens via environment variables
  ...(process.env.CUSTOM_TOKENS ? JSON.parse(process.env.CUSTOM_TOKENS) : {})
};

// Middleware
app.use(cors({
  origin: CORS_ORIGIN,
  credentials: true
}));
app.use(express.json());

// Types
interface SwapRequest {
  poolAddress: string;
  inputMint: string;
  outputMint: string;
  inputAmount: number;
  slippageBps?: number;
  rpcUrl?: string;
  keypairPath?: string;
  executeTransaction?: boolean;
}

interface AddLiquidityRequest {
  poolAddress: string;
  positionAddress: string;
  inputAmount: number;
  inputMint?: string; // Now accepts mint address directly
  inputToken?: 'A' | 'B'; // Or specify by position
  slippageBps?: number;
  rpcUrl?: string;
  keypairPath?: string;
  executeTransaction?: boolean;
}

interface RemoveLiquidityRequest {
  poolAddress: string;
  positionAddress: string;
  liquidityPercent: number;
  slippageBps?: number;
  rpcUrl?: string;
  keypairPath?: string;
  executeTransaction?: boolean;
}

interface CreatePoolRequest {
  tokenAMint: string;
  tokenBMint: string;
  tokenAAmount: number;
  tokenBAmount: number;
  initialPrice?: number;
  slippageBps?: number;
  rpcUrl?: string;
  keypairPath?: string;
  executeTransaction?: boolean;
}

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// Helper function to load wallet
function loadWallet(keypairPath: string): Keypair {
  try {
    const resolvedPath = keypairPath.startsWith('~') 
      ? path.join(process.env.HOME || '', keypairPath.slice(2))
      : keypairPath;
    
    const secretKey = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    return Keypair.fromSecretKey(Uint8Array.from(secretKey));
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load wallet from ${keypairPath}: ${errorMessage}`);
  }
}

// Helper function to get token program
async function getTokenProgram(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  const accountInfo = await connection.getAccountInfo(mint);
  if (!accountInfo) {
    throw new Error(`Token mint ${mint.toString()} not found`);
  }
  return accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

// Helper function to resolve token mint from symbol or address
function resolveTokenMint(tokenIdentifier: string): PublicKey {
  // Check if it's a known token symbol
  const knownToken = KNOWN_TOKENS[tokenIdentifier.toUpperCase()];
  if (knownToken) {
    return new PublicKey(knownToken.mint);
  }
  
  // Otherwise treat it as a mint address
  try {
    return new PublicKey(tokenIdentifier);
  } catch (error) {
    throw new Error(`Invalid token identifier: ${tokenIdentifier}. Must be a valid mint address or known token symbol.`);
  }
}

// Enhanced swap function supporting any token pair
async function swapTokens(config: SwapRequest): Promise<ApiResponse<any>> {
  try {
    const swapConfig = {
      poolAddress: new PublicKey(config.poolAddress),
      inputMint: new PublicKey(config.inputMint),
      outputMint: new PublicKey(config.outputMint),
      inputAmount: config.inputAmount,
      slippageBps: config.slippageBps || DEFAULT_SLIPPAGE_BPS,
      rpcUrl: config.rpcUrl || DEFAULT_RPC_URL,
      keypairPath: config.keypairPath || DEFAULT_KEYPAIR_PATH,
      executeTransaction: config.executeTransaction ?? false,
    };

    const wallet = loadWallet(swapConfig.keypairPath);
    const connection = new Connection(swapConfig.rpcUrl);
    const cpAmm = new CpAmm(connection);

    // Fetch pool state
    const poolState = await cpAmm.fetchPoolState(swapConfig.poolAddress);
    
    // Verify tokens match pool
    const inputIsTokenA = swapConfig.inputMint.equals(poolState.tokenAMint);
    const inputIsTokenB = swapConfig.inputMint.equals(poolState.tokenBMint);
    const outputIsTokenA = swapConfig.outputMint.equals(poolState.tokenAMint);
    const outputIsTokenB = swapConfig.outputMint.equals(poolState.tokenBMint);
    
    if ((!inputIsTokenA && !inputIsTokenB) || (!outputIsTokenA && !outputIsTokenB)) {
      throw new Error('Input or output token does not match pool tokens');
    }
    
    if ((inputIsTokenA && outputIsTokenA) || (inputIsTokenB && outputIsTokenB)) {
      throw new Error('Cannot swap token to itself');
    }

    // Get mint info and convert amount
    const inputMintInfo = await getMint(connection, swapConfig.inputMint);
    const outputMintInfo = await getMint(connection, swapConfig.outputMint);
    const inputAmountInTokens = new BN(swapConfig.inputAmount * Math.pow(10, inputMintInfo.decimals));

    // Get swap quote
    const currentSlot = await connection.getSlot();
    const blockTime = await connection.getBlockTime(currentSlot);
    
    const swapQuote = cpAmm.getQuote({
      inAmount: inputAmountInTokens,
      inputTokenMint: swapConfig.inputMint,
      slippage: swapConfig.slippageBps / 10000,
      poolState: poolState,
      currentTime: blockTime || Date.now() / 1000,
      currentSlot: currentSlot,
    });

    // Calculate slippage protection
    const slippageMultiplier = (10000 - swapConfig.slippageBps) / 10000;
    const minOutputAmount = swapQuote.swapOutAmount.mul(new BN(Math.floor(slippageMultiplier * 1000))).div(new BN(1000));

    // Get token programs
    const inputTokenProgram = await getTokenProgram(connection, swapConfig.inputMint);
    const outputTokenProgram = await getTokenProgram(connection, swapConfig.outputMint);

    // Build swap transaction
    const swapTx = await cpAmm.swap({
      payer: wallet.publicKey,
      pool: swapConfig.poolAddress,
      inputTokenMint: swapConfig.inputMint,
      outputTokenMint: swapConfig.outputMint,
      amountIn: inputAmountInTokens,
      minimumAmountOut: minOutputAmount,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAProgram: inputIsTokenA ? inputTokenProgram : outputTokenProgram,
      tokenBProgram: inputIsTokenB ? inputTokenProgram : outputTokenProgram,
      referralTokenAccount: null,
    });

    // Prepare transaction
    const { blockhash } = await connection.getLatestBlockhash();
    swapTx.recentBlockhash = blockhash;
    swapTx.feePayer = wallet.publicKey;
    
    // Sign transaction
    swapTx.partialSign(wallet);

    // Simulate transaction
    const simulation = await connection.simulateTransaction(swapTx);
    
    if (simulation.value.err) {
      throw new Error(`Swap simulation failed: ${JSON.stringify(simulation.value.err)}`);
    }

    const result = {
      quote: {
        inputAmount: swapConfig.inputAmount,
        inputMint: swapConfig.inputMint.toString(),
        outputAmount: (Number(swapQuote.swapOutAmount) / Math.pow(10, outputMintInfo.decimals)).toFixed(outputMintInfo.decimals),
        outputMint: swapConfig.outputMint.toString(),
        minimumOutputAmount: (Number(minOutputAmount) / Math.pow(10, outputMintInfo.decimals)).toFixed(outputMintInfo.decimals),
        priceImpact: swapQuote.priceImpact?.toString() || "0",
        fee: swapQuote.totalFee?.toString() || "0",
      },
      simulation: simulation.value,
    };

    if (swapConfig.executeTransaction) {
      const signature = await connection.sendRawTransaction(swapTx.serialize());
      await connection.confirmTransaction(signature);
      
      return {
        success: true,
        data: {
          ...result,
          signature,
          explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=${process.env.SOLANA_NETWORK || 'devnet'}`,
        },
      };
    } else {
      return {
        success: true,
        data: result,
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: errorMessage,
    };
  }
}

// Enhanced add liquidity function supporting any token
async function addLiquidityToPosition(config: AddLiquidityRequest): Promise<ApiResponse<any>> {
  try {
    const liquidityConfig = {
      poolAddress: new PublicKey(config.poolAddress),
      positionAddress: new PublicKey(config.positionAddress),
      inputAmount: config.inputAmount,
      inputMint: config.inputMint ? new PublicKey(config.inputMint) : undefined,
      inputToken: config.inputToken,
      slippageBps: config.slippageBps || DEFAULT_SLIPPAGE_BPS,
      rpcUrl: config.rpcUrl || DEFAULT_RPC_URL,
      keypairPath: config.keypairPath || DEFAULT_KEYPAIR_PATH,
      executeTransaction: config.executeTransaction ?? false,
    };

    const wallet = loadWallet(liquidityConfig.keypairPath);
    const connection = new Connection(liquidityConfig.rpcUrl);
    const cpAmm = new CpAmm(connection);

    // Fetch pool and position states
    const poolState = await cpAmm.fetchPoolState(liquidityConfig.poolAddress);
    const positionState = await cpAmm.fetchPositionState(liquidityConfig.positionAddress);

    // Determine input mint
    let inputMint: PublicKey;
    let isTokenA: boolean;
    
    if (liquidityConfig.inputMint) {
      // Direct mint address provided
      inputMint = liquidityConfig.inputMint;
      if (poolState.tokenAMint.equals(inputMint)) {
        isTokenA = true;
      } else if (poolState.tokenBMint.equals(inputMint)) {
        isTokenA = false;
      } else {
        throw new Error('Input mint does not match pool tokens');
      }
    } else if (liquidityConfig.inputToken) {
      // Token position specified
      if (liquidityConfig.inputToken === 'A') {
        inputMint = poolState.tokenAMint;
        isTokenA = true;
      } else {
        inputMint = poolState.tokenBMint;
        isTokenA = false;
      }
    } else {
      throw new Error('Must specify either inputMint or inputToken');
    }

    // Get mint info and convert amount
    const inputMintInfo = await getMint(connection, inputMint);
    const inputAmountInTokens = new BN(liquidityConfig.inputAmount * Math.pow(10, inputMintInfo.decimals));

    // Get deposit quote
    const depositQuote = cpAmm.getDepositQuote({
      inAmount: inputAmountInTokens,
      isTokenA,
      minSqrtPrice: poolState.sqrtMinPrice,
      maxSqrtPrice: poolState.sqrtMaxPrice,
      sqrtPrice: poolState.sqrtPrice,
    });

    // Calculate slippage protection
    const slippageMultiplier = (10000 - liquidityConfig.slippageBps) / 10000;
    const maxAmountTokenA = isTokenA ? inputAmountInTokens : depositQuote.outputAmount.mul(new BN(Math.floor((1/slippageMultiplier) * 1000))).div(new BN(1000));
    const maxAmountTokenB = !isTokenA ? inputAmountInTokens : depositQuote.outputAmount.mul(new BN(Math.floor((1/slippageMultiplier) * 1000))).div(new BN(1000));
    const tokenAAmountThreshold = maxAmountTokenA.mul(new BN(Math.floor(slippageMultiplier * 1000))).div(new BN(1000));
    const tokenBAmountThreshold = maxAmountTokenB.mul(new BN(Math.floor(slippageMultiplier * 1000))).div(new BN(1000));

    // Get position NFT account
    const positionNftAccount = await getAssociatedTokenAddress(
      liquidityConfig.positionAddress,
      wallet.publicKey
    );

    // Get token programs
    const tokenAProgram = await getTokenProgram(connection, poolState.tokenAMint);
    const tokenBProgram = await getTokenProgram(connection, poolState.tokenBMint);

    // Build add liquidity transaction
    const addLiquidityTx = await cpAmm.addLiquidity({
      owner: wallet.publicKey,
      pool: liquidityConfig.poolAddress,
      position: liquidityConfig.positionAddress,
      positionNftAccount: positionNftAccount,
      liquidityDelta: depositQuote.liquidityDelta,
      maxAmountTokenA,
      maxAmountTokenB,
      tokenAAmountThreshold,
      tokenBAmountThreshold,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAProgram,
      tokenBProgram,
    });

    // Prepare and simulate transaction
    const { blockhash } = await connection.getLatestBlockhash();
    addLiquidityTx.recentBlockhash = blockhash;
    addLiquidityTx.feePayer = wallet.publicKey;
    
    addLiquidityTx.partialSign(wallet);

    const simulation = await connection.simulateTransaction(addLiquidityTx);
    
    if (simulation.value.err) {
      throw new Error(`Add liquidity simulation failed: ${JSON.stringify(simulation.value.err)}`);
    }

    const result = {
      quote: {
        inputAmount: liquidityConfig.inputAmount,
        inputMint: inputMint.toString(),
        liquidityDelta: depositQuote.liquidityDelta.toString(),
        tokenAAmount: (Number(maxAmountTokenA) / Math.pow(10, 9)).toFixed(9),
        tokenBAmount: (Number(maxAmountTokenB) / Math.pow(10, 9)).toFixed(9),
      },
      simulation: simulation.value,
    };

    if (liquidityConfig.executeTransaction) {
      const signature = await connection.sendRawTransaction(addLiquidityTx.serialize());
      await connection.confirmTransaction(signature);
      
      return {
        success: true,
        data: {
          ...result,
          signature,
          explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=${process.env.SOLANA_NETWORK || 'devnet'}`,
        },
      };
    } else {
      return {
        success: true,
        data: result,
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: errorMessage,
    };
  }
}

// Keep the original removeLiquidityFromPosition function
async function removeLiquidityFromPosition(config: RemoveLiquidityRequest): Promise<ApiResponse<any>> {
  try {
    const liquidityConfig = {
      poolAddress: new PublicKey(config.poolAddress),
      positionAddress: new PublicKey(config.positionAddress),
      liquidityPercent: Math.max(0, Math.min(100, config.liquidityPercent)),
      slippageBps: config.slippageBps || DEFAULT_SLIPPAGE_BPS,
      rpcUrl: config.rpcUrl || DEFAULT_RPC_URL,
      keypairPath: config.keypairPath || DEFAULT_KEYPAIR_PATH,
      executeTransaction: config.executeTransaction ?? false,
    };

    const wallet = loadWallet(liquidityConfig.keypairPath);
    const connection = new Connection(liquidityConfig.rpcUrl);
    const cpAmm = new CpAmm(connection);

    // Fetch pool and position states
    const poolState = await cpAmm.fetchPoolState(liquidityConfig.poolAddress);
    const positionState = await cpAmm.fetchPositionState(liquidityConfig.positionAddress);

    // Calculate liquidity to remove
    const liquidityToRemove = positionState.unlockedLiquidity
      .mul(new BN(liquidityConfig.liquidityPercent))
      .div(new BN(100));

    if (liquidityToRemove.eq(new BN(0))) {
      throw new Error('No unlocked liquidity to remove');
    }

    // Get withdraw quote
    const withdrawQuote = cpAmm.getWithdrawQuote({
      liquidityDelta: liquidityToRemove,
      sqrtPrice: poolState.sqrtPrice,
      minSqrtPrice: poolState.sqrtMinPrice,
      maxSqrtPrice: poolState.sqrtMaxPrice,
    });

    // Calculate slippage protection
    const slippageMultiplier = (10000 - liquidityConfig.slippageBps) / 10000;
    
    const estimatedTokenAAmount = liquidityToRemove.div(new BN(1000));
    const estimatedTokenBAmount = liquidityToRemove.div(new BN(1000));
    
    const tokenAAmountThreshold = estimatedTokenAAmount.mul(new BN(Math.floor(slippageMultiplier * 1000))).div(new BN(1000));
    const tokenBAmountThreshold = estimatedTokenBAmount.mul(new BN(Math.floor(slippageMultiplier * 1000))).div(new BN(1000));

    // Get position NFT account
    const positionNftAccount = await getAssociatedTokenAddress(
      liquidityConfig.positionAddress,
      wallet.publicKey
    );

    // Get token programs
    const tokenAProgram = await getTokenProgram(connection, poolState.tokenAMint);
    const tokenBProgram = await getTokenProgram(connection, poolState.tokenBMint);

    // Build remove liquidity transaction
    const removeLiquidityTx = await cpAmm.removeLiquidity({
      owner: wallet.publicKey,
      pool: liquidityConfig.poolAddress,
      position: liquidityConfig.positionAddress,
      positionNftAccount: positionNftAccount,
      liquidityDelta: liquidityToRemove,
      tokenAAmountThreshold,
      tokenBAmountThreshold,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAProgram,
      tokenBProgram,
      vestings: [],
      currentPoint: new BN(0),
    });

    // Prepare and simulate transaction
    const { blockhash } = await connection.getLatestBlockhash();
    removeLiquidityTx.recentBlockhash = blockhash;
    removeLiquidityTx.feePayer = wallet.publicKey;
    
    removeLiquidityTx.partialSign(wallet);

    const simulation = await connection.simulateTransaction(removeLiquidityTx);
    
    if (simulation.value.err) {
      throw new Error(`Remove liquidity simulation failed: ${JSON.stringify(simulation.value.err)}`);
    }

    const result = {
      quote: {
        liquidityPercent: liquidityConfig.liquidityPercent,
        liquidityToRemove: liquidityToRemove.toString(),
        estimatedTokenAAmount: estimatedTokenAAmount.toString(),
        estimatedTokenBAmount: estimatedTokenBAmount.toString(),
        totalLiquidityBefore: positionState.unlockedLiquidity.toString(),
        remainingLiquidity: positionState.unlockedLiquidity.sub(liquidityToRemove).toString(),
      },
      simulation: simulation.value,
    };

    if (liquidityConfig.executeTransaction) {
      const signature = await connection.sendRawTransaction(removeLiquidityTx.serialize());
      await connection.confirmTransaction(signature);
      
      return {
        success: true,
        data: {
          ...result,
          signature,
          explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=${process.env.SOLANA_NETWORK || 'devnet'}`,
        },
      };
    } else {
      return {
        success: true,
        data: result,
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: errorMessage,
    };
  }
}

// Routes

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'Token Trading API',
    timestamp: new Date().toISOString() 
  });
});

// Get pool information with token details
app.get('/pool/:address', async (req, res) => {
  try {
    const connection = new Connection(DEFAULT_RPC_URL);
    const cpAmm = new CpAmm(connection);
    const poolAddress = new PublicKey(req.params.address);
    
    const poolState = await cpAmm.fetchPoolState(poolAddress);
    
    // Get token mint info
    const tokenAMintInfo = await getMint(connection, poolState.tokenAMint);
    const tokenBMintInfo = await getMint(connection, poolState.tokenBMint);
    
    // Use the proper price conversion function
    const humanReadablePrice = getPriceFromSqrtPrice(
      poolState.sqrtPrice,
      tokenAMintInfo.decimals,
      tokenBMintInfo.decimals
    );
    
    // Calculate both directions
    const priceAPerB = parseFloat(humanReadablePrice);
    const priceBPerA = priceAPerB > 0 ? 1 / priceAPerB : 0;
    
    res.json({
      success: true,
      data: {
        address: poolAddress.toString(),
        tokenA: {
          mint: poolState.tokenAMint.toString(),
          vault: poolState.tokenAVault.toString(),
          decimals: tokenAMintInfo.decimals,
          supply: tokenAMintInfo.supply.toString(),
        },
        tokenB: {
          mint: poolState.tokenBMint.toString(),
          vault: poolState.tokenBVault.toString(),
          decimals: tokenBMintInfo.decimals,
          supply: tokenBMintInfo.supply.toString(),
        },
        sqrtPrice: poolState.sqrtPrice.toString(),
        sqrtPriceQ64: poolState.sqrtPrice.toString(),
        liquidity: poolState.liquidity.toString(),
        price: {
          humanReadable: humanReadablePrice,
          aPerB: priceAPerB.toFixed(18),
          bPerA: priceBPerA.toFixed(18),
        },
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(400).json({
      success: false,
      error: errorMessage,
    });
  }
});

// Get pool price only (lightweight endpoint) - THIS WAS MISSING!
app.get('/pool/:address/price', async (req, res) => {
  try {
    const connection = new Connection(DEFAULT_RPC_URL);
    const cpAmm = new CpAmm(connection);
    const poolAddress = new PublicKey(req.params.address);
    
    const poolState = await cpAmm.fetchPoolState(poolAddress);
    
    // Get token decimals
    const tokenAMintInfo = await getMint(connection, poolState.tokenAMint);
    const tokenBMintInfo = await getMint(connection, poolState.tokenBMint);
    
    // Convert sqrt price to human readable
    const humanReadablePrice = getPriceFromSqrtPrice(
      poolState.sqrtPrice,
      tokenAMintInfo.decimals,
      tokenBMintInfo.decimals
    );
    
    const priceAPerB = parseFloat(humanReadablePrice);
    const priceBPerA = priceAPerB > 0 ? 1 / priceAPerB : 0;
    
    res.json({
      success: true,
      data: {
        poolAddress: poolAddress.toString(),
        tokenAMint: poolState.tokenAMint.toString(),
        tokenBMint: poolState.tokenBMint.toString(),
        sqrtPriceQ64: poolState.sqrtPrice.toString(),
        price: {
          humanReadable: humanReadablePrice,
          aPerB: priceAPerB,
          bPerA: priceBPerA,
          displayAPerB: priceAPerB.toFixed(9),
          displayBPerA: priceBPerA.toFixed(9),
        },
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(400).json({
      success: false,
      error: errorMessage,
    });
  }
});

// Find pools by token pair
app.get('/pools/find', async (req, res) => {
  try {
    const { tokenA, tokenB } = req.query;
    
    if (!tokenA || !tokenB) {
      return res.status(400).json({
        success: false,
        error: 'tokenA and tokenB query parameters are required',
      });
    }

    const tokenAMint = resolveTokenMint(tokenA as string);
    const tokenBMint = resolveTokenMint(tokenB as string);
    
    const connection = new Connection(DEFAULT_RPC_URL);
    const cpAmm = new CpAmm(connection);
    
    // Get all pools and filter by token pair
    const allPools = await cpAmm.getAllPools();
    const matchingPools = allPools.filter(pool => {
      const hasTokenA = pool.account.tokenAMint.equals(tokenAMint) || pool.account.tokenBMint.equals(tokenAMint);
      const hasTokenB = pool.account.tokenAMint.equals(tokenBMint) || pool.account.tokenBMint.equals(tokenBMint);
      return hasTokenA && hasTokenB;
    });
    
    const poolsData = matchingPools.map(pool => ({
      address: pool.publicKey.toString(),
      tokenAMint: pool.account.tokenAMint.toString(),
      tokenBMint: pool.account.tokenBMint.toString(),
      liquidity: pool.account.liquidity.toString(),
      sqrtPrice: pool.account.sqrtPrice.toString(),
      hasLiquidity: !pool.account.liquidity.isZero(),
    }));
    
    res.json({
      success: true,
      data: {
        pools: poolsData,
        count: poolsData.length,
        tokenA: tokenAMint.toString(),
        tokenB: tokenBMint.toString(),
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(400).json({
      success: false,
      error: errorMessage,
    });
  }
});

// Get position information
app.get('/position/:address', async (req, res) => {
  try {
    const connection = new Connection(DEFAULT_RPC_URL);
    const cpAmm = new CpAmm(connection);
    const positionAddress = new PublicKey(req.params.address);
    
    const positionState = await cpAmm.fetchPositionState(positionAddress);
    
    res.json({
      success: true,
      data: {
        address: positionAddress.toString(),
        pool: positionState.pool.toString(),
        nftMint: positionState.nftMint.toString(),
        unlockedLiquidity: positionState.unlockedLiquidity.toString(),
        feeAPending: positionState.feeAPending.toString(),
        feeBPending: positionState.feeBPending.toString(),
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(400).json({
      success: false,
      error: errorMessage,
    });
  }
});

// Swap tokens with flexible input (mint address or symbol)
app.post('/swap', async (req, res) => {
  try {
    // Allow input/output to be symbols or addresses
    const config = { ...req.body };
    if (config.inputToken) {
      config.inputMint = resolveTokenMint(config.inputToken).toString();
    }
    if (config.outputToken) {
      config.outputMint = resolveTokenMint(config.outputToken).toString();
    }
    
    const result = await swapTokens(config);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      success: false,
      error: `Internal server error: ${errorMessage}`,
    });
  }
});

// Simulate swap
app.post('/swap/simulate', async (req, res) => {
  try {
    const config = { ...req.body, executeTransaction: false };
    if (config.inputToken) {
      config.inputMint = resolveTokenMint(config.inputToken).toString();
    }
    if (config.outputToken) {
      config.outputMint = resolveTokenMint(config.outputToken).toString();
    }
    
    const result = await swapTokens(config);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      success: false,
      error: `Internal server error: ${errorMessage}`,
    });
  }
});

// Add liquidity
app.post('/liquidity/add', async (req, res) => {
  try {
    const result = await addLiquidityToPosition(req.body);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      success: false,
      error: `Internal server error: ${errorMessage}`,
    });
  }
});

// Simulate add liquidity
app.post('/liquidity/add/simulate', async (req, res) => {
  try {
    const config = { ...req.body, executeTransaction: false };
    const result = await addLiquidityToPosition(config);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      success: false,
      error: `Internal server error: ${errorMessage}`,
    });
  }
});

// Remove liquidity
app.post('/liquidity/remove', async (req, res) => {
  try {
    const result = await removeLiquidityFromPosition(req.body);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      success: false,
      error: `Internal server error: ${errorMessage}`,
    });
  }
});

// Simulate remove liquidity
app.post('/liquidity/remove/simulate', async (req, res) => {
  try {
    const config = { ...req.body, executeTransaction: false };
    const result = await removeLiquidityFromPosition(config);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      success: false,
      error: `Internal server error: ${errorMessage}`,
    });
  }
});

// Get all supported tokens
app.get('/tokens', (req, res) => {
  res.json({
    success: true,
    data: KNOWN_TOKENS,
  });
});

// Add new token to known tokens (runtime only)
app.post('/tokens/add', (req, res) => {
  try {
    const { symbol, mint, name, decimals } = req.body;
    
    if (!symbol || !mint || !name) {
      return res.status(400).json({
        success: false,
        error: 'symbol, mint, and name are required',
      });
    }
    
    // Validate mint address
    try {
      new PublicKey(mint);
    } catch {
      return res.status(400).json({
        success: false,
        error: 'Invalid mint address',
      });
    }
    
    KNOWN_TOKENS[symbol.toUpperCase()] = {
      mint,
      symbol: symbol.toUpperCase(),
      name,
      decimals: decimals || undefined,
    };
    
    res.json({
      success: true,
      data: {
        message: `Token ${symbol} added successfully`,
        token: KNOWN_TOKENS[symbol.toUpperCase()],
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      success: false,
      error: errorMessage,
    });
  }
});

// Get token info by mint or symbol
app.get('/token/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;
    
    // Check if it's a known token
    const knownToken = KNOWN_TOKENS[identifier.toUpperCase()];
    if (knownToken) {
      return res.json({
        success: true,
        data: knownToken,
      });
    }
    
    // Try to fetch from blockchain
    try {
      const mint = new PublicKey(identifier);
      const connection = new Connection(DEFAULT_RPC_URL);
      const mintInfo = await getMint(connection, mint);
      
      res.json({
        success: true,
        data: {
          mint: mint.toString(),
          decimals: mintInfo.decimals,
          supply: mintInfo.supply.toString(),
          freezeAuthority: mintInfo.freezeAuthority?.toString() || null,
          mintAuthority: mintInfo.mintAuthority?.toString() || null,
        },
      });
    } catch {
      res.status(404).json({
        success: false,
        error: `Token ${identifier} not found`,
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      success: false,
      error: errorMessage,
    });
  }
});

// Check if pool exists
app.get('/pool/exists/:address', async (req, res) => {
  try {
    const connection = new Connection(DEFAULT_RPC_URL);
    const cpAmm = new CpAmm(connection);
    const poolAddress = new PublicKey(req.params.address);
    
    const exists = await cpAmm.isPoolExist(poolAddress);
    
    res.json({
      success: true,
      data: exists,
      poolAddress: poolAddress.toString(),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(400).json({
      success: false,
      error: errorMessage,
      poolAddress: req.params.address,
    });
  }
});

// Get detailed pool state (only using properties that actually exist)
app.get('/pool/state/:address', async (req, res) => {
  try {
    const connection = new Connection(DEFAULT_RPC_URL);
    const cpAmm = new CpAmm(connection);
    const poolAddress = new PublicKey(req.params.address);
    
    const poolState = await cpAmm.fetchPoolState(poolAddress);
    
    // Get additional mint information
    const tokenAMintInfo = await getMint(connection, poolState.tokenAMint);
    const tokenBMintInfo = await getMint(connection, poolState.tokenBMint);
    
    // Use proper price conversion
    const humanReadablePrice = getPriceFromSqrtPrice(
      poolState.sqrtPrice,
      tokenAMintInfo.decimals,
      tokenBMintInfo.decimals
    );
    
    res.json({
      success: true,
      data: {
        address: poolAddress.toString(),
        tokenAMint: poolState.tokenAMint.toString(),
        tokenBMint: poolState.tokenBMint.toString(),
        tokenAVault: poolState.tokenAVault.toString(),
        tokenBVault: poolState.tokenBVault.toString(),
        sqrtPrice: poolState.sqrtPrice.toString(),
        sqrtPriceQ64: poolState.sqrtPrice.toString(),
        liquidity: poolState.liquidity.toString(),
        sqrtMinPrice: poolState.sqrtMinPrice.toString(),
        sqrtMaxPrice: poolState.sqrtMaxPrice.toString(),
        tokenADecimals: tokenAMintInfo.decimals,
        tokenBDecimals: tokenBMintInfo.decimals,
        price: {
          humanReadable: humanReadablePrice,
          aPerB: parseFloat(humanReadablePrice).toFixed(18),
          bPerA: (1 / parseFloat(humanReadablePrice)).toFixed(18),
        },
        // Only include properties that definitely exist
        protocolAFee: poolState.protocolAFee?.toString() || '0',
        protocolBFee: poolState.protocolBFee?.toString() || '0',
        // Basic pool info
        isActive: true, // If we can fetch it, it's active
        lastUpdated: new Date().toISOString(),
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(400).json({
      success: false,
      error: errorMessage,
      poolAddress: req.params.address,
    });
  }
});

// Debug endpoint to check API sync status
app.get('/debug/sync-status', async (req, res) => {
  try {
    const connection = new Connection(DEFAULT_RPC_URL);
    const cpAmm = new CpAmm(connection);
    
    // Get all pools
    const allPools = await cpAmm.getAllPools();
    
    res.json({
      success: true,
      data: {
        totalPools: allPools.length,
        rpcUrl: DEFAULT_RPC_URL,
        networkCluster: process.env.SOLANA_NETWORK || 'devnet',
        recentPools: allPools.slice(-5).map(pool => ({
          address: pool.publicKey.toString(),
          tokenA: pool.account.tokenAMint.toString(),
          tokenB: pool.account.tokenBMint.toString(),
          liquidity: pool.account.liquidity.toString(),
        })),
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      success: false,
      error: errorMessage,
    });
  }
});

// Simple health check for pool lookup
app.get('/pool/:address/health', async (req, res) => {
  try {
    const connection = new Connection(DEFAULT_RPC_URL);
    const cpAmm = new CpAmm(connection);
    const poolAddress = new PublicKey(req.params.address);
    
    // Quick health check
    const exists = await cpAmm.isPoolExist(poolAddress);
    
    if (exists) {
      const poolState = await cpAmm.fetchPoolState(poolAddress);
      res.json({
        success: true,
        data: {
          poolAddress: poolAddress.toString(),
          exists: true,
          hasLiquidity: !poolState.liquidity.isZero(),
          liquidity: poolState.liquidity.toString(),
          canTrade: !poolState.liquidity.isZero(),
        },
      });
    } else {
      res.json({
        success: true,
        data: {
          poolAddress: poolAddress.toString(),
          exists: false,
          hasLiquidity: false,
          canTrade: false,
        },
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(400).json({
      success: false,
      error: errorMessage,
      poolAddress: req.params.address,
    });
  }
});

// Convert human price to sqrt price
app.post('/utils/price-to-sqrt', (req, res) => {
  try {
    const { price, tokenADecimals, tokenBDecimals } = req.body;
    
    if (!price || tokenADecimals === undefined || tokenBDecimals === undefined) {
      return res.status(400).json({
        success: false,
        error: 'price, tokenADecimals, and tokenBDecimals are required',
      });
    }
    
    const sqrtPrice = getSqrtPriceFromPrice(
      price.toString(),
      tokenADecimals,
      tokenBDecimals
    );
    
    res.json({
      success: true,
      data: {
        price: price.toString(),
        sqrtPriceQ64: sqrtPrice.toString(),
        tokenADecimals,
        tokenBDecimals,
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(400).json({
      success: false,
      error: errorMessage,
    });
  }
});

// Convert sqrt price to human price
app.post('/utils/sqrt-to-price', (req, res) => {
  try {
    const { sqrtPrice, tokenADecimals, tokenBDecimals } = req.body;
    
    if (!sqrtPrice || tokenADecimals === undefined || tokenBDecimals === undefined) {
      return res.status(400).json({
        success: false,
        error: 'sqrtPrice, tokenADecimals, and tokenBDecimals are required',
      });
    }
    
    const humanPrice = getPriceFromSqrtPrice(
      new BN(sqrtPrice),
      tokenADecimals,
      tokenBDecimals
    );
    
    res.json({
      success: true,
      data: {
        sqrtPriceQ64: sqrtPrice,
        humanReadablePrice: humanPrice,
        numericPrice: parseFloat(humanPrice),
        tokenADecimals,
        tokenBDecimals,
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(400).json({
      success: false,
      error: errorMessage,
    });
  }
});

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
});

// Start server
app.listen(PORT2, () => {
  console.log(`🚀 Enhanced Token Trading API running on port ${PORT2}`);
  console.log(`📊 Health check: http://localhost:${PORT2}/health`);
  console.log(`💱 Swap tokens: POST http://localhost:${PORT2}/swap`);
  console.log(`🔍 Find pools: GET http://localhost:${PORT2}/pools/find?tokenA=SOL&tokenB=USDC`);
  console.log(`💲 Get price: GET http://localhost:${PORT2}/pool/:address/price`);
  console.log(`💧 Add liquidity: POST http://localhost:${PORT2}/liquidity/add`);
  console.log(`🪙 Token info: GET http://localhost:${PORT2}/token/:identifier`);
});

export default app;