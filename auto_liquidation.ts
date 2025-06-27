import dotenv from 'dotenv';
dotenv.config();

import WebSocket from 'ws';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import bs58 from 'bs58';
import fetch from 'node-fetch';

const JUPITER_QUOTE_API = 'https://jupiter-swap-lb.solanatracker.io/jupiter/quote';
const JUPITER_SWAP_API = 'https://jupiter-swap-lb.solanatracker.io/jupiter/swap';
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '';
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || '';
const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT || '';
const OUTPUT_MINT = process.env.OUTPUT_MINT || '';
const INPUT_MINT = 'So11111111111111111111111111111111111111112';
const SLIPPAGE_BPS = parseInt(process.env.SLIPPAGE_BPS || '1000');
const PRIORITY_FEE_LAMPORTS = parseInt(process.env.PRIORITY_FEE_LAMPORTS || '150000');
const VOLUME_BOT_WALLETS = (process.env.VOLUME_BOT_WALLETS || '').split(',');
const LIQUIDATION_WALLETS = (process.env.LIQUIDATION_WALLETS || '').split(',');
const MIN_BUY_THRESHOLD = 69000000; // 0.069 SOL in lamports

if (!JUPITER_API_KEY || !RPC_ENDPOINT || !WEBSOCKET_ENDPOINT || !OUTPUT_MINT || LIQUIDATION_WALLETS.length !== 5) {
  console.error('Missing or invalid .env configuration');
  process.exit(1);
}

const connection = new Connection(RPC_ENDPOINT, 'confirmed');
const liquidationKeypairs = LIQUIDATION_WALLETS.map(key => Keypair.fromSecretKey(bs58.decode(key)));

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = () => Math.floor(Math.random() * 4000) + 1000;
const randomAmount = (min: number, max: number) => Math.floor(Math.random() * (max - min) + min);

async function getQuote(inputMint: string, outputMint: string, amount: number) {
  const url = `${JUPITER_QUOTE_API}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${SLIPPAGE_BPS}&api_key=${JUPITER_API_KEY}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Quote error: ${await response.text()}`);
  return await response.json();
}

async function getSwapTransaction(quoteResponse: any, wallet: Keypair) {
  const body = {
    quoteResponse,
    userPublicKey: wallet.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    prioritizationFeeLamports: PRIORITY_FEE_LAMPORTS,
    apiKey: JUPITER_API_KEY,
  };
  const response = await fetch(JUPITER_SWAP_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Swap error: ${await response.text()}`);
  const data = await response.json();
  if (!data.swapTransaction) throw new Error('No swapTransaction in response');
  return data.swapTransaction;
}

async function signAndSendTransaction(serializedTx: string, wallet: Keypair) {
  const txBuffer = Buffer.from(serializedTx, 'base64');
  const transaction = VersionedTransaction.deserialize(txBuffer);
  transaction.sign([wallet]);
  const signature = await connection.sendTransaction(transaction, { skipPreflight: true });
  await connection.confirmTransaction(signature, 'finalized');
  return signature;
}

async function executeTrade(wallet: Keypair, inputMint: string, outputMint: string, amount: number, action: 'buy' | 'sell') {
  const quote = await getQuote(inputMint, outputMint, amount);
  const serializedTx = await getSwapTransaction(quote, wallet);
  const signature = await signAndSendTransaction(serializedTx, wallet);
  console.log(`✅ ${action} ${amount / 1e9} SOL | ${wallet.publicKey.toBase58()} | ${signature}`);
}

async function getTokenBalance(wallet: Keypair): Promise<number> {
  try {
    const tokenAccount = await getAssociatedTokenAddress(new PublicKey(OUTPUT_MINT), wallet.publicKey);
    const accountInfo = await getAccount(connection, tokenAccount);
    return Number(accountInfo.amount);
  } catch (error) {
    console.warn(`⚠️ No token balance for ${wallet.publicKey.toBase58()}: ${error}`);
    return 0;
  }
}

async function executeLiquidation(tokenAmount: number, signer: string) {
  console.log(`Detected retail buy by ${signer}. Tokens bought: ${tokenAmount}. Initiating liquidation...`);

  // Check if any wallet has tokens
  const walletBalances = await Promise.all(liquidationKeypairs.map(wallet => getTokenBalance(wallet)));
  const hasTokens = walletBalances.some(balance => balance > 0);
  if (!hasTokens) {
    console.warn(`⚠️ All liquidation wallets are empty for ${OUTPUT_MINT}. Skipping liquidation sequence.`);
    return;
  }

  const availableWallets = [...liquidationKeypairs];
  const usedWallets: Keypair[] = [];

  const selectWallet = () => {
    if (availableWallets.length === 0) return usedWallets[Math.floor(Math.random() * usedWallets.length)];
    const wallet = availableWallets.splice(Math.floor(Math.random() * availableWallets.length), 1)[0];
    usedWallets.push(wallet);
    return wallet;
  };

  // Step 1: Sell 50%
  let sell1Amount = Math.floor(tokenAmount * 0.5);
  const wallet1 = selectWallet();
  const balance1 = await getTokenBalance(wallet1);
  if (balance1 === 0) {
    console.warn(`⚠️ Wallet is liquidated - Rotate wallet: ${wallet1.publicKey.toBase58()}`);
  } else {
    sell1Amount = Math.min(sell1Amount, balance1);
    await executeTrade(wallet1, OUTPUT_MINT, INPUT_MINT, sell1Amount, 'sell');
  }
  await sleep(randomDelay());

  // Step 2: Small Buy (0.01-0.015 SOL)
  const buy1Amount = randomAmount(10000000, 15000000);
  const wallet2 = selectWallet();
  const balance2 = await getTokenBalance(wallet2);
  if (balance2 === 0 && balance1 === 0) {
    console.warn(`⚠️ Wallet is liquidated - Rotate wallet: ${wallet2.publicKey.toBase58()}. Skipping buy due to empty wallets.`);
    return;
  }
  await executeTrade(wallet2, INPUT_MINT, OUTPUT_MINT, buy1Amount, 'buy');
  await sleep(randomDelay());

  // Step 3: Sell 45%
  let sell2Amount = Math.floor(tokenAmount * 0.45);
  const wallet3 = selectWallet();
  const balance3 = await getTokenBalance(wallet3);
  if (balance3 === 0) {
    console.warn(`⚠️ Wallet is liquidated - Rotate wallet: ${wallet3.publicKey.toBase58()}`);
  } else {
    sell2Amount = Math.min(sell2Amount, balance3);
    await executeTrade(wallet3, OUTPUT_MINT, INPUT_MINT, sell2Amount, 'sell');
  }
  await sleep(randomDelay());

  // Step 4: Two Small Buys (0.002-0.005 SOL each)
  const buy2Amount = randomAmount(2000000, 5000000);
  const wallet4 = selectWallet();
  const balance4 = await getTokenBalance(wallet4);
  if (balance4 === 0 && balance3 === 0 && balance2 === 0 && balance1 === 0) {
    console.warn(`⚠️ Wallet is liquidated - Rotate wallet: ${wallet4.publicKey.toBase58()}. Skipping buy due to empty wallets.`);
    return;
  }
  await executeTrade(wallet4, INPUT_MINT, OUTPUT_MINT, buy2Amount, 'buy');
  await sleep(randomDelay());

  const buy3Amount = randomAmount(2000000, 5000000);
  const wallet5 = selectWallet();
  const balance5 = await getTokenBalance(wallet5);
  if (balance5 === 0 && balance4 === 0 && balance3 === 0 && balance2 === 0 && balance1 === 0) {
    console.warn(`⚠️ Wallet is liquidated - Rotate wallet: ${wallet5.publicKey.toBase58()}. Skipping buy due to empty wallets.`);
    return;
  }
  await executeTrade(wallet5, INPUT_MINT, OUTPUT_MINT, buy3Amount, 'buy');

  console.log(`Liquidation sequence completed for buy by ${signer}`);
}

function setupWebSocket() {
  const ws = new WebSocket(WEBSOCKET_ENDPOINT);

  ws.on('open', () => {
    console.log('Connected to Solana Tracker WebSocket');
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'transactionSubscribe',
      params: [{ accountInclude: [OUTPUT_MINT] }, { commitment: 'confirmed' }]
    }));
  });

  ws.on('message', async (data: string) => {
    const message = JSON.parse(data);
    if (message.method !== 'transactionNotification') return;

    const tx = message.params.result.transaction.transaction;
    const meta = message.params.result.transaction.meta;
    const signer = tx.message.accountKeys[0];
    if (VOLUME_BOT_WALLETS.includes(signer)) return;

    const signerPubkey = new PublicKey(signer);
    const tokenAccount = await getAssociatedTokenAddress(new PublicKey(OUTPUT_MINT), signerPubkey);
    const tokenAccountStr = tokenAccount.toBase58();
    const tokenAccountIndex = tx.message.accountKeys.indexOf(tokenAccountStr);
    if (tokenAccountIndex === -1) return;

    const preBalance = meta.preTokenBalances.find((b: any) => b.accountIndex === tokenAccountIndex);
    const postBalance = meta.postTokenBalances.find((b: any) => b.accountIndex === tokenAccountIndex);

    if (preBalance && postBalance) {
      const preAmount = BigInt(preBalance.amount);
      const postAmount = BigInt(postBalance.amount);
      const tokenBalanceChange = Number(postAmount - preAmount);
      if (tokenBalanceChange > 0) {
        const solSpent = meta.preBalances[0] - meta.postBalances[0] - meta.fee;
        if (solSpent >= MIN_BUY_THRESHOLD) {
          await executeLiquidation(tokenBalanceChange, signer);
        }
      }
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    ws.close();
    setTimeout(setupWebSocket, 5000);
  });

  ws.on('close', () => console.log('WebSocket closed'));
}

setupWebSocket();
