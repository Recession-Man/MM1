//multi w/o fees

// src/bot.ts
import { Connection, Keypair, VersionedTransaction, SendTransactionError, PublicKey } from '@solana/web3.js';
import * as dotenv from 'dotenv';
import bs58 from 'bs58';
import fetch from 'node-fetch';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';

dotenv.config();

const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_API = 'https://quote-api.jup.ag/v6/swap';
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '';
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || '';
const SLIPPAGE_BPS = parseInt(process.env.SLIPPAGE_BPS || '1000');
const INPUT_MINT = 'So11111111111111111111111111111111111111112'; // SOL
const OUTPUT_MINT = process.env.OUTPUT_MINT!; // Target token mint
const WALLET_KEYS = (process.env.WALLET_KEYS || '').split(',');
const MIN_AMOUNT = parseInt(process.env.MIN_SWAP_AMOUNT!);
const MAX_AMOUNT = parseInt(process.env.MAX_SWAP_AMOUNT!);
const PAUSE_MS = parseInt(process.env.PAUSE_MS || '2000');
const PRIORITY_FEE_LAMPORTS = parseInt(process.env.PRIORITY_FEE_LAMPORTS || '100000');
const ROUND_DELAY_MS = 30000; // 30 seconds between full rounds

const randomAmount = () => Math.floor(Math.random() * (MAX_AMOUNT - MIN_AMOUNT) + MIN_AMOUNT);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const lamportsToSol = (lamports: number) => lamports / 1e9;
const msToSeconds = (ms: number) => ms / 1000;

const getQuote = async (inputMint: string, outputMint: string, amount: number) => {
    const url = `${JUPITER_QUOTE_API}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${SLIPPAGE_BPS}`;
    const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${JUPITER_API_KEY}` }
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Quote error: ${res.status} - ${text}`);
    }
    return res.json();
};

const getSwapTransaction = async (quote: any, pubkey: string) => {
    const body = {
        quoteResponse: quote,
        userPublicKey: pubkey,
        wrapAndUnwrapSol: true,
        prioritizationFeeLamports: PRIORITY_FEE_LAMPORTS,
        apiKey: JUPITER_API_KEY
    };
    const res = await fetch(JUPITER_SWAP_API, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${JUPITER_API_KEY}`
        },
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Swap error: ${res.status} - ${text}`);
    }
    const data = await res.json();
    if (!data.swapTransaction) {
        throw new Error(`No swapTransaction found in swap response.`);
    }
    return data.swapTransaction;
};

const signAndSendTransaction = async (serializedTx: string, keypair: Keypair, connection: Connection) => {
    const txBuffer = Buffer.from(serializedTx, 'base64');
    const transaction = VersionedTransaction.deserialize(txBuffer);
    transaction.sign([keypair]);
    const signature = await connection.sendTransaction(transaction, { skipPreflight: true });
    await connection.confirmTransaction(signature, 'finalized');
    return signature;
};

const main = async () => {
    const connection = new Connection(RPC_ENDPOINT, 'confirmed');

    while (true) {
        const completedWallets: { keypair: Keypair, pubkey: string }[] = [];

        // First: all wallets do 2 buys
        for (const key of WALLET_KEYS) {
            const keypair = Keypair.fromSecretKey(bs58.decode(key));
            const pubkey = keypair.publicKey.toBase58();

            for (let i = 0; i < 2; i++) {
                const amount = randomAmount();
                console.log(`\nWallet: ${pubkey} | Buy ${i + 1}: Swapping ${amount} lamports (${lamportsToSol(amount)} SOL)`);
                try {
                    const balance = await connection.getBalance(keypair.publicKey);
                    if (balance < amount + 105000) {
                        console.warn(`⚠️ Skipping buy for ${pubkey} due to low balance (${balance} lamports)`);
                        continue;
                    }
                    const quote = await getQuote(INPUT_MINT, OUTPUT_MINT, amount);
                    const tx = await getSwapTransaction(quote, pubkey);
                    const sig = await signAndSendTransaction(tx, keypair, connection);
                    console.log(`✅ Buy ${i + 1} complete for ${pubkey}, signature: ${sig}`);
                    await sleep(PAUSE_MS);
                } catch (e) {
                    console.error(`❌ Buy ${i + 1} failed for ${pubkey}:`, e);
                }
            }

            completedWallets.push({ keypair, pubkey });
        }

        // Then: all wallets sell 90% of token
        for (const { keypair, pubkey } of completedWallets) {
            try {
                const tokenAccount = await getAssociatedTokenAddress(new PublicKey(OUTPUT_MINT), keypair.publicKey);
                const tokenInfo = await getAccount(connection, tokenAccount);
                const sellAmount = Math.floor(Number(tokenInfo.amount) * 0.9);
                if (sellAmount === 0) {
                    console.log(`⚠️ No tokens to sell for ${pubkey}`);
                    continue;
                }
                console.log(`\nWallet: ${pubkey} | Selling 90% of token balance: ${sellAmount} units`);
                const quote = await getQuote(OUTPUT_MINT, INPUT_MINT, sellAmount);
                const tx = await getSwapTransaction(quote, pubkey);
                const sig = await signAndSendTransaction(tx, keypair, connection);
                console.log(`✅ Sell complete for ${pubkey}, signature: ${sig}`);
            } catch (e) {
                console.error(`❌ Sell failed for ${pubkey}:`, e);
            }

            await sleep(PAUSE_MS);
        }

        console.log(`\n🔁 Waiting ${msToSeconds(ROUND_DELAY_MS)} seconds before starting next round...\n`);
        await sleep(ROUND_DELAY_MS);
    }
};

main().catch(console.error);
