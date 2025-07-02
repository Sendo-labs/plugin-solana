import { type IAgentRuntime, Service, logger } from '@elizaos/core';
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  VersionedMessage,
  Transaction,
  TransactionMessage,
  TransactionInstruction,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import BigNumber from 'bignumber.js';
import { SOLANA_SERVICE_NAME, SOLANA_WALLET_DATA_CACHE_KEY } from './constants';
import { getWalletKey, KeypairResult } from './keypairUtils';
import type { Item, Prices, WalletPortfolio } from './types';
import bs58 from 'bs58';

const PROVIDER_CONFIG = {
  BIRDEYE_API: 'https://public-api.birdeye.so',
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000,
  DEFAULT_RPC: 'https://api.mainnet-beta.solana.com',
  TOKEN_ADDRESSES: {
    SOL: 'So11111111111111111111111111111111111111112',
    BTC: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
    ETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  },
};

const METADATA_PROGRAM_ID = new PublicKey(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s' // Metaplex Token Metadata Program ID
);


/**
 * Service class for interacting with the Solana blockchain and accessing wallet data.
 * @extends Service
 */
export class SolanaService extends Service {
  static serviceType: string = SOLANA_SERVICE_NAME;
  capabilityDescription =
    'The agent is able to interact with the Solana blockchain, and has access to the wallet data';

  private updateInterval: NodeJS.Timer | null = null;
  private lastUpdate = 0;
  private readonly UPDATE_INTERVAL = 120000; // 2 minutes
  private connection: Connection;
  private publicKey: PublicKey | null = null;
  private exchangeRegistry: Record<number, any> = {};
  private subscriptions: Map<string, number> = new Map();

  jupiterService: any;

  // always multiple these
  static readonly LAMPORTS2SOL = 1 / LAMPORTS_PER_SOL;
  static readonly SOL2LAMPORTS = LAMPORTS_PER_SOL;

  /**
   * Constructor for creating an instance of the class.
   * @param {IAgentRuntime} runtime - The runtime object that provides access to agent-specific functionality.
   */
  constructor(protected runtime: IAgentRuntime) {
    super();
    this.exchangeRegistry = {};
    const connection = new Connection(
      runtime.getSetting('SOLANA_RPC_URL') || PROVIDER_CONFIG.DEFAULT_RPC
    );
    this.connection = connection;

    const asking = 'Solana service'
    const serviceType = 'JUPITER_SERVICE'

    const getJup = async () => {
      this.jupiterService = this.runtime.getService(serviceType) as any;
      while (!this.jupiterService) {
        runtime.logger.debug(asking, 'waiting for', serviceType, 'service...');
        this.jupiterService = this.runtime.getService(serviceType) as any;
        if (!this.jupiterService) {
          await new Promise((waitResolve) => setTimeout(waitResolve, 1000));
        } else {
          runtime.logger.debug(asking, 'Acquired', serviceType, 'service...');
        }
      }
    }
    getJup() // no wait

    // Initialize publicKey using getWalletKey
    getWalletKey(runtime, false)
      .then(({ publicKey }) => {
        if (!publicKey) {
          throw new Error('Failed to initialize public key');
        }
        this.publicKey = publicKey;
      })
      .catch((error) => {
        logger.error('Error initializing public key:', error);
      });
    this.subscriptions = new Map();
  }

  /**
   * Gets the wallet keypair for operations requiring private key access
   * @returns {Promise<Keypair>} The wallet keypair
   * @throws {Error} If private key is not available
   */
  private async getWalletKeypair(): Promise<Keypair> {
    const { keypair } = await getWalletKey(this.runtime, true);
    if (!keypair) {
      throw new Error('Failed to get wallet keypair');
    }
    return keypair;
  }

  /**
   * Fetches data from the provided URL with retry logic.
   * @param {string} url - The URL to fetch data from.
   * @param {RequestInit} [options={}] - The options for the fetch request.
   * @returns {Promise<unknown>} - A promise that resolves to the fetched data.
   */
  private async fetchWithRetry(url: string, options: RequestInit = {}): Promise<unknown> {
    let lastError: Error;

    for (let i = 0; i < PROVIDER_CONFIG.MAX_RETRIES; i++) {
      try {
        const response = await fetch(url, {
          ...options,
          headers: {
            Accept: 'application/json',
            'x-chain': 'solana',
            'X-API-KEY': this.runtime.getSetting('BIRDEYE_API_KEY'),
            ...options.headers,
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
        }

        return await response.json();
      } catch (error) {
        logger.error(`Attempt ${i + 1} failed:`, error);
        lastError = error as Error;
        if (i < PROVIDER_CONFIG.MAX_RETRIES - 1) {
          await new Promise((resolve) => setTimeout(resolve, PROVIDER_CONFIG.RETRY_DELAY * 2 ** i));
        }
      }
    }

    if (lastError) throw lastError;
  }

  /**
   * Asynchronously fetches the prices of SOL, BTC, and ETH tokens.
   * Uses cache to store and retrieve prices if available.
   * @returns A Promise that resolves to an object containing the prices of SOL, BTC, and ETH tokens.
   */
  private async fetchPrices(): Promise<Prices> {
    const cacheKey = 'prices';
    const cachedValue = await this.runtime.getCache<Prices>(cacheKey);

    // if cachedValue is JSON, parse it
    if (cachedValue) {
      logger.log('Cache hit for fetchPrices');
      return cachedValue;
    }

    logger.log('Cache miss for fetchPrices');
    const { SOL, BTC, ETH } = PROVIDER_CONFIG.TOKEN_ADDRESSES;
    const tokens = [SOL, BTC, ETH];
    const prices: Prices = {
      solana: { usd: '0' },
      bitcoin: { usd: '0' },
      ethereum: { usd: '0' },
    };

    for (const token of tokens) {
      const response = await this.fetchWithRetry(
        `${PROVIDER_CONFIG.BIRDEYE_API}/defi/price?address=${token}`
      );

      if (response?.data?.value) {
        const price = response.data.value.toString();
        prices[token === SOL ? 'solana' : token === BTC ? 'bitcoin' : 'ethereum'].usd = price;
      }
    }

    await this.runtime.setCache<Prices>(cacheKey, prices);
    return prices;
  }

  /**
   * Asynchronously fetches token accounts for a specific owner.
   *
   * @returns {Promise<any[]>} A promise that resolves to an array of token accounts.
   */
  private async getTokenAccounts() {
    return this.getTokenAccountsByKeypair(this.publicKey as PublicKey)
  }

/*
  for (const t of haveTokens) {
      const amountRaw = t.account.data.parsed.info.tokenAmount.amount;
      const ca = new PublicKey(t.account.data.parsed.info.mint);
      const decimals = t.account.data.parsed.info.tokenAmount.decimals;
      const balance = Number(amountRaw) / (10 ** decimals);
      const symbol = await solanaService.getTokenSymbol(ca);
*/
  public async getTokenAccountsByKeypair(walletAddress: PublicKey) {
    //console.log('publicKey', this.publicKey, 'vs', walletAddress)
    try {
      const accounts = await this.connection.getParsedTokenAccountsByOwner(walletAddress, {
        programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      });
      const haveTokens = accounts.value.filter(account => account.account.data.parsed.info.tokenAmount.uiAmount > 0)
      return haveTokens
    } catch (error) {
      logger.error('Error fetching token accounts:', error);
      return [];
    }
  }

  // getParsedAccountInfo
  private static readonly TOKEN_ACCOUNT_DATA_LENGTH = 165;
  private static readonly TOKEN_MINT_DATA_LENGTH   = 82;

  async getAddressType(address: string) {
    const pubkey = new PublicKey(address);
    const accountInfo = await this.connection.getAccountInfo(pubkey);

    if (!accountInfo) {
      return 'Account does not exist';
    }

    //console.log('accountInfo', accountInfo)

    const dataLength = accountInfo.data.length;

    if (dataLength === 0) {
      return 'Wallet';
    }

    // SPL Token accounts are always 165 bytes
    // User's balance of a specified token
    if (dataLength === SolanaService.TOKEN_ACCOUNT_DATA_LENGTH) {
      return 'Token Account';
    }

    // Token mint account
    if (dataLength === SolanaService.TOKEN_MINT_DATA_LENGTH) {
      return 'Token';
    }

    return `Unknown (Data length: ${dataLength})`;
  }

  public async getBalanceByAddr(walletAddressStr: string) {
    try {
      const publicKey = new PublicKey(walletAddressStr)
      const lamports = await this.connection.getBalance(publicKey);
      return lamports * SolanaService.LAMPORTS2SOL
    } catch (error) {
      this.runtime.logger.error('solSrv:getBalanceByAddr - Error fetching wallet balance:', error);
      return -1;
    }
  }

  public async getMetadataAddress(mint: PublicKey): Promise<PublicKey> {
    const [metadataPDA] = await PublicKey.findProgramAddress(
      [
        Buffer.from("metadata"),
        METADATA_PROGRAM_ID.toBuffer(),
        mint.toBuffer(),
      ],
      METADATA_PROGRAM_ID
    );
    return metadataPDA;
  }

  public async getTokenSymbol(mint: PublicKey): Promise<string | null> {
    const metadataAddress = await this.getMetadataAddress(mint);
    const accountInfo = await this.connection.getAccountInfo(metadataAddress);

    if (!accountInfo || !accountInfo.data) return null;

    const data = accountInfo.data;

    // Skip the 1-byte key and 32+32+4+len name fields (you can parse these if needed)
    let offset = 1 + 32 + 32;

    // Name (length-prefixed string)
    const nameLen = data.readUInt32LE(offset);
    offset += 4 + nameLen;

    // Symbol (length-prefixed string)
    const symbolLen = data.readUInt32LE(offset);
    offset += 4;
    const symbol = data.slice(offset, offset + symbolLen).toString("utf8").replace(/\0/g, '');
    return symbol;
  }

  /**
   * Update wallet data including fetching wallet portfolio information, prices, and caching the data.
   * @param {boolean} [force=false] - Whether to force update the wallet data even if the update interval has not passed
   * @returns {Promise<WalletPortfolio>} The updated wallet portfolio information
   */
  private async updateWalletData(force = false): Promise<WalletPortfolio> {
    //console.log('updateWalletData - start')
    const now = Date.now();

    if (!this.publicKey) {
      // can't be warn if we fire every start up
      // maybe we just get the pubkey here proper
      // or fall back to SOLANA_PUBLIC_KEY
      logger.log('solana::updateWalletData - no Public Key yet');
      return {};
    }

    //console.log('updateWalletData - force', force, 'last', this.lastUpdate, 'UPDATE_INTERVAL', this.UPDATE_INTERVAL)
    // Don't update if less than interval has passed, unless forced
    if (!force && now - this.lastUpdate < this.UPDATE_INTERVAL) {
      const cached = await this.getCachedData();
      if (cached) return cached;
    }
    //console.log('updateWalletData - fetch')

    try {
      // Try Birdeye API first
      const birdeyeApiKey = this.runtime.getSetting('BIRDEYE_API_KEY');
      if (birdeyeApiKey) {
        try {
          const walletData = await this.fetchWithRetry(
            `${PROVIDER_CONFIG.BIRDEYE_API}/v1/wallet/token_list?wallet=${this.publicKey.toBase58()}`
          );
          //console.log('walletData', walletData)

          if (walletData?.success && walletData?.data) {
            const data = walletData.data;
            const totalUsd = new BigNumber(data.totalUsd.toString());
            const prices = await this.fetchPrices();
            const solPriceInUSD = new BigNumber(prices.solana.usd);

            const portfolio: WalletPortfolio = {
              totalUsd: totalUsd.toString(),
              totalSol: totalUsd.div(solPriceInUSD).toFixed(6),
              prices,
              lastUpdated: now,
              items: data.items.map((item: Item) => ({
                ...item,
                valueSol: new BigNumber(item.valueUsd || 0).div(solPriceInUSD).toFixed(6),
                name: item.name || 'Unknown',
                symbol: item.symbol || 'Unknown',
                priceUsd: item.priceUsd || '0',
                valueUsd: item.valueUsd || '0',
              })),
            };

            //console.log('saving portfolio', portfolio.items.length, 'tokens')

            // maybe should be keyed by public key
            await this.runtime.setCache<WalletPortfolio>(SOLANA_WALLET_DATA_CACHE_KEY, portfolio);
            this.lastUpdate = now;
            return portfolio;
          }
        } catch (e) {
          console.log('solana wallet exception err', e);
        }
      }

      // Fallback to basic token account info
      const accounts = await this.getTokenAccounts();
      const items: Item[] = accounts.map((acc) => ({
        name: 'Unknown',
        address: acc.account.data.parsed.info.mint,
        symbol: 'Unknown',
        decimals: acc.account.data.parsed.info.tokenAmount.decimals,
        balance: acc.account.data.parsed.info.tokenAmount.amount,
        uiAmount: acc.account.data.parsed.info.tokenAmount.uiAmount.toString(),
        priceUsd: '0',
        valueUsd: '0',
        valueSol: '0',
      }));

      const portfolio: WalletPortfolio = {
        totalUsd: '0',
        totalSol: '0',
        items,
      };

      await this.runtime.setCache<WalletPortfolio>(SOLANA_WALLET_DATA_CACHE_KEY, portfolio);
      this.lastUpdate = now;
      return portfolio;
    } catch (error) {
      logger.error('Error updating wallet data:', error);
      throw error;
    }
  }

  /**
   * Retrieves cached wallet portfolio data from the database adapter.
   * @returns A promise that resolves with the cached WalletPortfolio data if available, otherwise resolves with null.
   */
  public async getCachedData(): Promise<WalletPortfolio | null> {
    const cachedValue = await this.runtime.getCache<WalletPortfolio>(SOLANA_WALLET_DATA_CACHE_KEY);
    if (cachedValue) {
      return cachedValue;
    }
    return null;
  }

  /**
   * Forces an update of the wallet data and returns the updated WalletPortfolio object.
   * @returns A promise that resolves with the updated WalletPortfolio object.
   */
  public async forceUpdate(): Promise<WalletPortfolio> {
    return await this.updateWalletData(true);
  }

  /**
   * Retrieves the public key of the instance.
   *
   * @returns {PublicKey} The public key of the instance.
   */
  public getPublicKey(): PublicKey {
    return this.publicKey;
  }

  /**
   * Retrieves the connection object.
   *
   * @returns {Connection} The connection object.
   */
  public getConnection(): Connection {
    return this.connection;
  }

  /**
   * Detect Solana public keys (Base58) in a string
   * @param input arbitrary text
   * @param checkCurve whether to verify the key is on the Ed25519 curve via @solana/web3.js
   * @returns list of detected public key strings
   */
  public detectPubkeysFromString(input: string, checkCurve = false): Array<string> {
    const results = new Set<string>();
    const regex = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(input)) !== null) {
      const s = match[0];
      try {
        const buf = bs58.decode(s);
        if (buf.length === 32) {
          if (checkCurve) {
            if (PublicKey.isOnCurve(buf)) {
              results.add(s);
            }
          } else {
            results.add(s);
          }
        }
      } catch {
        // Not valid Base58
      }
    }

    return Array.from(results);
  }

  /**
   * Detect Solana private keys in a string.
   *
   * Supports:
   * - Base58 (≈88 chars, representing 64 bytes → 512 bits)
   * - Hexadecimal (128 hex chars → 64 bytes)
   *
   * Returns an array of objects with the original match and decoded bytes.
   */
  public detectPrivateKeysFromString(input: string): Array<{
    format: 'base58' | 'hex',
    match: string,
    bytes: Uint8Array
  }> {
    const results = [];

    // Base58 regex (no 0,O,I,l)
    const base58Regex = /\b[1-9A-HJ-NP-Za-km-z]{86,90}\b/g;
    // Hex regex: 128 hex chars
    const hexRegex = /\b[a-fA-F0-9]{128}\b/g;

    let m: RegExpExecArray | null;

    // Check Base58 matches
    while ((m = base58Regex.exec(input)) !== null) {
      const s = m[0];
      try {
        const buf = bs58.decode(s);
        if (buf.length === 64) {
          results.push({ format: 'base58', match: s, bytes: Uint8Array.from(buf) });
        }
      } catch {
        // invalid base58 — ignore
      }
    }

    // Check hex matches
    while ((m = hexRegex.exec(input)) !== null) {
      const s = m[0];
      const buf = Buffer.from(s, 'hex');
      if (buf.length === 64) {
        results.push({ format: 'hex', match: s, bytes: Uint8Array.from(buf) });
      }
    }

    return results;
  }

  public isValidSolanaAddress(address: string, onCurveOnly = false): boolean {
    try {
      const pubkey = new PublicKey(address);
      if (onCurveOnly) {
        return PublicKey.isOnCurve(pubkey.toBuffer());
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Validates a Solana address.
   * @param {string | undefined} address - The address to validate.
   * @returns {boolean} True if the address is valid, false otherwise.
   */
  public validateAddress(address: string | undefined): boolean {
    if (!address) return false;
    try {
      // Handle Solana addresses
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
        logger.warn(`Invalid Solana address format: ${address}`);
        return false;
      }

      const pubKey = new PublicKey(address);
      const isValid = Boolean(pubKey.toBase58());
      logger.log(`Solana address validation: ${address}`, { isValid });
      return isValid;
    } catch (error) {
      logger.error(`Address validation error: ${address}`, { error });
      return false;
    }
  }

  /**
   * Creates a new Solana wallet by generating a keypair
   * @returns {Promise<{publicKey: string, privateKey: string}>} Object containing base58-encoded public and private keys
   */
  public async createWallet(): Promise<{ publicKey: string; privateKey: string }> {
    try {
      // Generate new keypair
      const newKeypair = Keypair.generate();

      // Convert to base58 strings for secure storage
      const publicKey = newKeypair.publicKey.toBase58();
      const privateKey = bs58.encode(newKeypair.secretKey);

      // Clear the keypair from memory
      newKeypair.secretKey.fill(0);

      return {
        publicKey,
        privateKey,
      };
    } catch (error) {
      logger.error('Error creating wallet:', error);
      throw new Error('Failed to create new wallet');
    }
  }

  /**
   * Registers a provider with the service.
   * @param {any} provider - The provider to register
   * @returns {Promise<number>} The ID assigned to the registered provider
   */
  async registerExchange(provider: any) {
    const id = Object.values(this.exchangeRegistry).length + 1;
    logger.log('Registered', provider.name, 'as Solana provider #' + id);
    this.exchangeRegistry[id] = provider;
    return id;
  }

  /**
   * Subscribes to account changes for the given public key
   * @param {string} accountAddress - The account address to subscribe to
   * @returns {Promise<number>} Subscription ID
   */
  public async subscribeToAccount(accountAddress: string): Promise<number> {
    try {
      if (!this.validateAddress(accountAddress)) {
        throw new Error('Invalid account address');
      }

      // Check if already subscribed
      if (this.subscriptions.has(accountAddress)) {
        return this.subscriptions.get(accountAddress)!;
      }

      // Create WebSocket connection if needed
      const ws = this.connection.connection._rpcWebSocket;

      const subscriptionId = await ws.call('accountSubscribe', [
        accountAddress,
        {
          encoding: 'jsonParsed',
          commitment: 'finalized',
        },
      ]);

      // Setup notification handler
      ws.subscribe(subscriptionId, 'accountNotification', async (notification: any) => {
        try {
          const { result } = notification;
          if (result?.value) {
            // Force update wallet data to reflect changes
            await this.updateWalletData(true);

            // Emit an event that can be handled by the agent
            this.runtime.emit('solana:account:update', {
              address: accountAddress,
              data: result.value,
            });
          }
        } catch (error) {
          logger.error('Error handling account notification:', error);
        }
      });

      this.subscriptions.set(accountAddress, subscriptionId);
      logger.log(`Subscribed to account ${accountAddress} with ID ${subscriptionId}`);
      return subscriptionId;
    } catch (error) {
      logger.error('Error subscribing to account:', error);
      throw error;
    }
  }

  /**
   * Unsubscribes from account changes
   * @param {string} accountAddress - The account address to unsubscribe from
   * @returns {Promise<boolean>} Success status
   */
  public async unsubscribeFromAccount(accountAddress: string): Promise<boolean> {
    try {
      const subscriptionId = this.subscriptions.get(accountAddress);
      if (!subscriptionId) {
        logger.warn(`No subscription found for account ${accountAddress}`);
        return false;
      }

      const ws = this.connection.connection._rpcWebSocket;
      const success = await ws.call('accountUnsubscribe', [subscriptionId]);

      if (success) {
        this.subscriptions.delete(accountAddress);
        logger.log(`Unsubscribed from account ${accountAddress}`);
      }

      return success;
    } catch (error) {
      logger.error('Error unsubscribing from account:', error);
      throw error;
    }
  }

  /**
   * Calculates the optimal buy amount and slippage based on market conditions
   * @param {string} inputMint - Input token mint address
   * @param {string} outputMint - Output token mint address
   * @param {number} availableAmount - Available amount to trade
   * @returns {Promise<{ amount: number; slippage: number }>} Optimal amount and slippage
   */
  public async calculateOptimalBuyAmount(
    inputMint: string,
    outputMint: string,
    availableAmount: number
  ): Promise<{ amount: number; slippage: number }> {
    try {
      // Get price impact for the trade
      const priceImpact = await this.jupiterService.getPriceImpact({
        inputMint,
        outputMint,
        amount: availableAmount,
      });

      // Find optimal slippage based on market conditions
      const slippage = await this.jupiterService.findBestSlippage({
        inputMint,
        outputMint,
        amount: availableAmount,
      });

      // FIXME: would be good to know how much volume in the last hour...

      //console.log('calculateOptimalBuyAmount - optimal slippage', slippage)

      // If price impact is too high, reduce the amount
      let optimalAmount = availableAmount;
      if (priceImpact > 5) {
        // 5% price impact threshold
        optimalAmount = availableAmount * 0.5; // Reduce amount by half
        console.log('calculateOptimalBuyAmount - too much price impact halving', optimalAmount)
      }

      return { amount: optimalAmount, slippage };
    } catch (error) {
      logger.error('Error calculating optimal buy amount:', error);
      throw error;
    }
  }

  /**
   * Executes buy/sell orders for multiple wallets
   * @param {Array<{ keypair: any; balance: number }>} wallets - Array of wallet information
   * @param {any} signal - Trading signal information
   * @returns {Promise<Array<{ success: boolean; outAmount?: number; fees?: any; swapResponse?: any }>>}
   */
  public async executeSwap(wallets: Array<{ keypair: any; amount: number }>, signal: any) {
    const swapPromises = wallets.map(async (wallet) => {
      try {
        console.log('signal.sourceTokenCA', signal.sourceTokenCA, 'signal.targetTokenCA', signal.targetTokenCA, 'wallet.amount', wallet.amount)
        // Get initial quote to determine input mint and other parameters
        const initialQuote = await this.jupiterService.getQuote({
          inputMint: signal.sourceTokenCA,
          outputMint: signal.targetTokenCA,
          slippageBps: 200,
          amount: wallet.amount,
        });
        //console.log('initialQuote', initialQuote)

        // outAmount, minOutAmount, priceImpactPct
        const impliedSlippageBps = ((initialQuote.outAmount - initialQuote.otherAmountThreshold) / initialQuote.outAmount) * 10_000;
        console.log('impliedSlippageBps', impliedSlippageBps)

        // Calculate optimal buy amount using the input mint from quote
        const { amount, slippage } = await this.calculateOptimalBuyAmount(
          initialQuote.inputMint,
          initialQuote.outputMint,
          wallet.amount
        );
        // amount is in lamports
        console.log('amount', amount, 'slippage', slippage)

        // is this jupiter specific?

        // Get final quote with optimized amount
        const quoteResponse = await this.jupiterService.getQuote({
          inputMint: initialQuote.inputMint,
          outputMint: initialQuote.outputMint,
          amount,
          slippageBps: slippage,
        });
        console.log('quoteResponse', quoteResponse)
        const fees = {
          lamports: quoteResponse.otherAmountThreshold,
          sol: quoteResponse.otherAmountThreshold * SolanaService.LAMPORTS2SOL
        }

        // Execute the swap
        const swapResponse = await this.jupiterService.executeSwap({
          quoteResponse,
          userPublicKey: wallet.keypair.publicKey.toString(),
          slippageBps: parseInt(impliedSlippageBps),
        });
        //console.log('swapResponse', swapResponse)
        //console.log('keypair', wallet.keypair)

        const secretKey = bs58.decode(wallet.keypair.privateKey);
        const keypair = Keypair.fromSecretKey(secretKey);
        //const signature = await this.executeSwap(keypair, swapResponse)
        //console.log('keypair', keypair)

        // Deserialize, sign, and send
        const txBuffer = Buffer.from(swapResponse.swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(txBuffer);
        transaction.sign([keypair]);

        // Getting recent blockhash too slow for Solana/Jupiter
        /*
        const { blockhash } = await this.connection.getLatestBlockhash('finalized');
        console.log('blockhash', blockhash)
        transaction.message.recentBlockhash = blockhash;
        */

        // Send and confirm
        const txid = await this.connection.sendRawTransaction(transaction.serialize());
        //console.log('txid', txid)
        //await this.connection.confirmTransaction(txid, 'finalized');
        //console.log('finalized')

        /*
        // Calculate final amounts including fees
        const fees = await this.jupiterService.estimateGasFees({
          inputMint: initialQuote.inputMint,
          outputMint: initialQuote.outputMint,
          amount,
        });
        */

        return {
          success: true,
          outAmount: Number(quoteResponse.outAmount),
          signature: txid,
          fees,
          swapResponse,
        };
      } catch (error) {
        logger.error('Error in buy execution:', error);
        return { success: false };
      }
    });

    return Promise.all(swapPromises);
  }

  /**
   * Starts the Solana service with the given agent runtime.
   *
   * @param {IAgentRuntime} runtime - The agent runtime to use for the Solana service.
   * @returns {Promise<SolanaService>} The initialized Solana service.
   */
  static async start(runtime: IAgentRuntime): Promise<SolanaService> {
    logger.log('SolanaService start for', runtime.character.name);

    const solanaService = new SolanaService(runtime);

    solanaService.updateInterval = setInterval(async () => {
      logger.log('Updating wallet data');
      await solanaService.updateWalletData();
    }, solanaService.UPDATE_INTERVAL);

    // Initial update
    // won't matter because pubkey isn't set yet
    //solanaService.updateWalletData().catch(console.error);

    return solanaService;
  }

  /**
   * Stops the Solana service.
   *
   * @param {IAgentRuntime} runtime - The agent runtime.
   * @returns {Promise<void>} - A promise that resolves once the Solana service has stopped.
   */
  static async stop(runtime: IAgentRuntime) {
    const client = runtime.getService(SOLANA_SERVICE_NAME);
    if (!client) {
      logger.error('SolanaService not found');
      return;
    }
    await client.stop();
  }

  /**
   * Stops the update interval if it is currently running.
   * @returns {Promise<void>} A Promise that resolves when the update interval is stopped.
   */
  async stop(): Promise<void> {
    // Unsubscribe from all accounts
    for (const [address] of this.subscriptions) {
      await this.unsubscribeFromAccount(address);
    }

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }
}
