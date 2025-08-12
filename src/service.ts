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
  SendTransactionError,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import { MintLayout, getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import BigNumber from 'bignumber.js';
import { SOLANA_SERVICE_NAME, SOLANA_WALLET_DATA_CACHE_KEY } from './constants';
import { getWalletKey, KeypairResult } from './keypairUtils';
import type { Item, Prices, WalletPortfolio } from './types';
import bs58 from 'bs58';
import nacl from "tweetnacl";

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

// CA: { }

// hack these in here
async function getCacheExp(runtime: IAgentRuntime, key: string) {
  const wrapper = await runtime.getCache<any>(key);
  if (!wrapper) return false
  // if exp is in the past
  if (wrapper.exp < Date.now()) {
    // no data
    return false
  }
  return wrapper.data
}
async function setCacheExp(runtime: IAgentRuntime, key: string, val: any, ttlInSecs: number) {
  const exp = Date.now() + ttlInSecs * 1_000
  return runtime.setCache<any>(key, {
    exp,
    data: val,
  });
}

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

  // Token decimals cache
  private decimalsCache = new Map<string, number>([
    ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6], // USDC
    ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 6], // USDT
    ['So11111111111111111111111111111111111111112', 9], // SOL
  ]);

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
   * Retrieves the connection object.
   *
   * @returns {Connection} The connection object.
   */
  public getConnection(): Connection {
    return this.connection;
  }

  /**
   * Registers a swap provider to execute swaps
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
   * Fetches data from the provided URL with retry logic.
   * @param {string} url - The URL to fetch data from.
   * @param {RequestInit} [options={}] - The options for the fetch request.
   * @returns {Promise<unknown>} - A promise that resolves to the fetched data.
   */
  private async birdeyeFetchWithRetry(url: string, options: RequestInit = {}): Promise<unknown> {
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

  async batchGetMultipleAccountsInfo(pubkeys: PublicKey[], label: string): Promise<(AccountInfo<Buffer> | null)[]> {
    const results: (AccountInfo<Buffer> | null)[] = [];
    // do it in serial, why?
    for (let i = 0; i < pubkeys.length; i += 100) {
      const slice = pubkeys.slice(i, i + 100);
      console.log('batchGetMultipleAccountsInfo(' + label + ') - getMultipleAccountsInfo', slice.length + '/' + pubkeys.length)
      const infos = await this.connection.getMultipleAccountsInfo(slice);
      results.push(...infos);
    }
    return results;
  }

  verifySolanaSignature({
    message, signatureBase64, publicKeyBase58
  }: {
    message: string; signatureBase64: string; publicKeyBase58: string;
  }): boolean {
    const signature = Buffer.from(signatureBase64, "base64");
    const messageUint8 = new TextEncoder().encode(message);
    const publicKeyBytes = bs58.decode(publicKeyBase58);

    return nacl.sign.detached.verify(messageUint8, signature, publicKeyBytes);
  }

  //
  // MARK: Addresses
  //

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
      //logger.log(`Solana address validation: ${address}`, { isValid });
      return isValid;
    } catch (error) {
      logger.error(`Address validation error: ${address}`, { error });
      return false;
    }
  }

  // getParsedAccountInfo
  private static readonly TOKEN_ACCOUNT_DATA_LENGTH = 165;
  private static readonly TOKEN_MINT_DATA_LENGTH   = 82;

  // could use batchGetMultipleAccountsInfo to get multiple
  async getAddressType(address: string): Promise<string> {
    let dataLength = -1
    try {
      const key = 'solana_' + address + '_addressType'
      const check = await this.runtime.getCache<any>(key)
      if (check) {
        console.log('getAddressType - HIT')
        return check
      }

      const pubkey = new PublicKey(address);
      console.log('getAddressType - getAccountInfo')
      const accountInfo = await this.connection.getAccountInfo(pubkey);

      if (!accountInfo) {
        return 'Account does not exist';
      }

      //console.log('accountInfo', accountInfo)

      dataLength = accountInfo.data.length;

      if (dataLength === 0) {
        await this.runtime.setCache<any>(key, 'Wallet')
        return 'Wallet';
      }

      // SPL Token accounts are always 165 bytes
      // User's balance of a specified token
      if (dataLength === SolanaService.TOKEN_ACCOUNT_DATA_LENGTH) {
        await this.runtime.setCache<any>(key, 'Token Account')
        return 'Token Account';
      }

      // Token mint account
      if (dataLength === SolanaService.TOKEN_MINT_DATA_LENGTH) {
        await this.runtime.setCache<any>(key, 'Token')
        return 'Token';
      }
    } catch(e) {
      // likely bad address
      console.error('solsrv:getAddressType - err', e)
    }
    return `Unknown (Data length: ${dataLength})`;
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
   * ⚠️ SECURITY WARNING: This method handles sensitive private key material.
   * - Never log or expose the returned bytes
   * - Clear sensitive data from memory after use
   * - Consider if this method should be public
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
    const results: Array<{
      format: 'base58' | 'hex';
      match: string;
      bytes: Uint8Array;
    }> = [];

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

  //
  // MARK: tokens
  //

  async getCirculatingSupply(mint: string) {

   //const mintPublicKey = new PublicKey(mint);
    // 1. Fetch all token accounts holding this token
    const accounts = await this.connection.getParsedProgramAccounts(
      TOKEN_PROGRAM_ID,
      {
        filters: [
          { dataSize: 165 }, // size of token account
          { memcmp: { offset: 0, bytes: mint } } // filter by mint
        ]
      }
    );

    const KNOWN_EXCLUDED_ACCOUNTS = [
      "MINT_AUTHORITY_WALLET",
      "TREASURY_WALLET",
      "BURN_ADDRESS"
    ];

    // 2. Sum balances
    let circulating = 0;
    for (const acc of accounts) {
      const info = acc.account.data.parsed.info;
      const owner = info.owner;

      // Optional: exclude burn address or known treasury/mint holding
      if (owner === "11111111111111111111111111111111") continue;
      if (KNOWN_EXCLUDED_ACCOUNTS.includes(owner)) continue;

      const amount = Number(info.tokenAmount.amount);
      const decimals = info.tokenAmount.decimals;
      circulating += amount / 10 ** decimals;
    }

    return circulating;
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
      const response = await this.birdeyeFetchWithRetry(
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

   public async getDecimal(mintPublicKey: PublicKey): Promise<number> {
     try {
      const key = mintPublicKey.toString()
      if (this.decimalsCache.has(key)) {
        console.log('getDecimal - HIT', key)
        return this.decimalsCache.get(key)!;
      }

      console.log('getDecimal - MISS getParsedAccountInfo', key)
      const acc = await this.connection.getParsedAccountInfo(mintPublicKey);
      const owner = acc.value?.owner.toString();

      if (owner === TOKEN_PROGRAM_ID.toString()) {
        //const mintPublicKey = new PublicKey(mintAddress);
        console.log('getDecimal - MISS getMint', key)
        const mintInfo = await getMint(this.connection, mintPublicKey);
        //console.log('getDecimal - mintInfo', mintInfo)
        this.decimalsCache.set(key, mintInfo.decimals);
        return mintInfo.decimals;
      } else if (owner === TOKEN_2022_PROGRAM_ID.toString()) {
        const mintInfo = await getMint(
          this.connection,
          mintPublicKey,
          undefined,                // optional commitment
          TOKEN_2022_PROGRAM_ID     // specify the extensions token program
        );
        console.log('getDecimal - mintInfo2022', mintInfo)
        this.decimalsCache.set(key, mintInfo.decimals);
        return mintInfo.decimals;
      }
      console.error('Unknown owner type', owner, acc)
      return -1
    } catch (error) {
      // this will fail on a token2022 token
      console.error('Failed to fetch token decimals:', error);
      //throw error;
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
    console.log('getTokenSymbol - getAccountInfo')
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

  public async getSupply(CAs) {
    const mintKeys: PublicKey[] = CAs.map(ca => new PublicKey(ca));
    const mintInfos = await this.batchGetMultipleAccountsInfo(mintKeys, 'getSupply')

    const results = mintInfos.map((accountInfo, idx) => {
      if (!accountInfo) {
        return { address: CAs[idx], error: 'Account not found' };
      }

      const data = Buffer.from(accountInfo.data);
      const mint = MintLayout.decode(data);
      // mintAuthority, supply, decimals, isInitialized, freezeAuthorityOption, freezeAuthority
      //console.log('mint', mint)

      // Convert Buffer (little endian) to BigNumber
      const supply = mint.supply;
      const decimals = mint.decimals;

      return {
        address: CAs[idx],
        biSupply: supply,  // or divide by 10**decimals if you want human-readable
        // BigNumber is good for price for MCAP
        human: new BigNumber((supply / BigInt(10 ** decimals)).toString()),
        // maybe it should be a string... and they w/e use can cast it as such
        decimals,
      };
    });

    // then convert to object
    const out = Object.fromEntries(results.map(r => [r.address, {
      supply: r.biSupply,
      decimals: r.decimals,
      human: r.human
    }]));
    // realSupply = supply / Math.pow(10, decimals)
    return out
  }

  public async parseTokenAccounts(heldTokens) {
    // decimalsCache means we don't need all I think
    // stil need them for symbol
    const mintKeys: PublicKey[] = heldTokens.map(t => new PublicKey(t.account.data.parsed.info.mint));
    const metadataAddresses: PublicKey[] = await Promise.all(mintKeys.map(mk => this.getMetadataAddress(mk)))
    //console.log('parseTokenAccounts - getMultipleAccountsInfo')
    //const accountInfos = await this.connection.getMultipleAccountsInfo(metadataAddresses);
    const accountInfos = await this.batchGetMultipleAccountsInfo(metadataAddresses, 'parseTokenAccounts')
    //console.log('accountInfos', accountInfos) // works

    const results = heldTokens.map((token, i) => {
      const metadataInfo = accountInfos[i];      // raw AccountInfo | null
      const mintKey      = mintKeys[i];

      // ----- Metaplex metadata deserialisation -----
      let symbol: string | null = null;
      if (metadataInfo?.data?.length) {
        const data = metadataInfo.data;

        let offset = 1 + 32 + 32;        // key + updateAuthority + mint
        const nameLen   = data.readUInt32LE(offset);  offset += 4 + nameLen;
        const symbolLen = data.readUInt32LE(offset);  offset += 4;

        symbol = data
          .slice(offset, offset + symbolLen)
          .toString("utf8")
          .replace(/\0/g, "");           // trim right-padding
      }

      // ----- Token-account figures (already parsed) -----
      const { amount: raw, decimals } = token.account.data.parsed.info.tokenAmount;
      this.decimalsCache.set(token.account.data.parsed.info.mint, decimals);
      const balanceUi = Number(raw) / 10 ** decimals;

      return {
        mint: mintKey.toBase58(),
        symbol,
        decimals,
        balanceUi,
      };
    });
    //console.log('results', results)

    // then convert to object
    const out = Object.fromEntries(results.map(r => [r.mint, {
      symbol: r.symbol,
      decimals: r.decimals,
      balanceUi: r.balanceUi,
    }]));
    //console.log('out', out)
    return out
  }

  //
  // MARK: wallets
  //

    //
    // MARK: agent wallet
    //

    /**
     * Asynchronously fetches token accounts for a specific owner.
     *
     * @returns {Promise<any[]>} A promise that resolves to an array of token accounts.
     */
    private async getTokenAccounts() {
      if (this.publicKey) {
        return this.getTokenAccountsByKeypair(this.publicKey)
      }
      return null
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
            const walletData = await this.birdeyeFetchWithRetry(
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
        accounts.forEach((acc) => {
          this.decimalsCache.set(acc.account.data.parsed.info.mint, acc.account.data.parsed.info.tokenAmount.decimals);
        });
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
    public getPublicKey(): PublicKey | null {
      return this.publicKey;
    }

    //
    // MARK: any wallet
    //

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

/*
  for (const t of haveTokens) {
      const amountRaw = t.account.data.parsed.info.tokenAmount.amount;
      const ca = new PublicKey(t.account.data.parsed.info.mint);
      const decimals = t.account.data.parsed.info.tokenAmount.decimals;
      const balance = Number(amountRaw) / (10 ** decimals);
      const symbol = await solanaService.getTokenSymbol(ca);
*/
  public async getTokenAccountsByKeypair(walletAddress: PublicKey, options = {}) {
    //console.log('getTokenAccountsByKeypair', walletAddress.toString())
    //console.log('publicKey', this.publicKey, 'vs', walletAddress)
    const key = 'solana_' + walletAddress.toString() + '_tokens'
    //console.trace('whos checking jj')
    try {
      const now = Date.now()
      let check = false
      if (options.ttl !== 0) {
        check = await this.runtime.getCache<any>(key)
        if (check) {
          // how old is this data, do we care
          const diff = now - check.fetchedAt
          // 1s - 5min cache?
          if (diff < 60_000) {
            console.log('getTokenAccountsByKeypair cache HIT, its', diff.toLocaleString() + 'ms old')
            return check.data
          }
          console.log('getTokenAccountsByKeypair cache MISS, its', diff.toLocaleString() + 'ms old')
        }
      }
      console.log('getTokenAccountsByKeypair - getParsedTokenAccountsByOwner', walletAddress.toString())
      const accounts = await this.connection.getParsedTokenAccountsByOwner(walletAddress, {
        programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      });
      const haveTokens = accounts.value.filter(account => account.account.data.parsed.info.tokenAmount.uiAmount > 0)
      // do we have old data
      if (check) {
        // should we compare haveTokens with the old data we have
        // and generate events?
      }
      await this.runtime.setCache<any>(key, {
        fetchedAt: now,
        data: haveTokens
      })
      return haveTokens
    } catch (error) {
      logger.error('Error fetching token accounts:', error);
      return [];
    }
  }

  // deprecated
  /*
  public async getBalanceByAddr(walletAddressStr: string): Promise<number> {
    try {
      const publicKey = new PublicKey(walletAddressStr)
      console.log('getBalanceByAddr - getBalance')
      const lamports = await this.connection.getBalance(publicKey);
      return lamports * SolanaService.LAMPORTS2SOL
    } catch (error) {
      this.runtime.logger.error('solSrv:getBalanceByAddr - Error fetching wallet balance:', error);
      return -1;
    }
  }
  */

  // only get SOL balance
  public async getBalancesByAddrs(walletAddressArr: string[]) {
    try {
      //console.log('walletAddressArr', walletAddressArr)
      const publicKeyObjs = walletAddressArr.map(k => new PublicKey(k));
      //console.log('getBalancesByAddrs - getMultipleAccountsInfo')
      //const accounts = await this.connection.getMultipleAccountsInfo(publicKeyObjs);
      const accounts = await this.batchGetMultipleAccountsInfo(publicKeyObjs, 'getBalancesByAddrs');

      //console.log('getBalancesByAddrs - accounts', accounts)
      const out: Record<string, number> = {}
      for(const i in accounts) {
        const a = accounts[i]
        // lamports, data, owner, executable, rentEpoch, space
        //console.log('a', a)
        const pk = walletAddressArr[i]
        if (a?.lamports) {
          out[pk] = a.lamports * SolanaService.LAMPORTS2SOL
        } else {
          console.log('no lamports? a', a)
          // null means there is no balance or the account is closed
          out[pk] = 0
        }
      }
      return out
    } catch (error) {
      const msg = error.message || '';
      if (msg.includes('429')) {
        this.runtime.logger.warn('RPC rate limit hit, pausing before retry');
        // FIXME: retry counter, exponential backoff
        await new Promise((waitResolve) => setTimeout(waitResolve, 1000));
        return this.getBalancesByAddrs(walletAddressArr)
      }
      //this.runtime.logger.error('solSrv:getBalancesByAddrs - Error fetching wallet balances:', error);
      this.runtime.logger.error('solSrv:getBalancesByAddrs - unexpected error:', error);
      return -1;
    }
  }

  // we might want USD price and other info...
  async walletAddressToHumanString(pubKey: string): Promise<string> {
    let balanceStr = ''
    // get wallet contents
    const pubKeyObj = new PublicKey(pubKey)

    const [balances, heldTokens] = await Promise.all([
      this.getBalancesByAddrs([pubKey]),
      this.getTokenAccountsByKeypair(pubKeyObj),
    ]);
    const solBal = balances[pubKey]

    balanceStr += 'Wallet Address: ' + pubKey + '\n'
    balanceStr += '  Token Address (Symbol)\n'
    balanceStr += '  So11111111111111111111111111111111111111111 ($sol) balance: ' + (solBal ?? 'unknown') + '\n'
    const tokens = await this.parseTokenAccounts(heldTokens)
    for (const ca in tokens) {
      const t = tokens[ca]
      balanceStr += '  ' + ca + ' ($' + t.symbol + ') balance: ' + t.balanceUi + '\n'
    }
    balanceStr += '\n'
    return balanceStr
  }

  async walletAddressToLLMString(pubKey: string): Promise<string> {
    let balanceStr = ''
    // get wallet contents
    const pubKeyObj = new PublicKey(pubKey)
    const [balances, heldTokens] = await Promise.all([
      this.getBalancesByAddrs([pubKey]),
      this.getTokenAccountsByKeypair(pubKeyObj),
    ]);
    //console.log('balances', balances)
    const solBal = balances[pubKey]
    balanceStr += 'Wallet Address: ' + pubKey + '\n'
    balanceStr += 'Current wallet contents in csv format:\n'
    balanceStr += 'Token Address,Symbol,Balance\n'
    balanceStr += 'So11111111111111111111111111111111111111111,sol,' + (solBal ?? 'unknown') + '\n'
    const tokens = await this.parseTokenAccounts(heldTokens)
    for (const ca in tokens) {
      const t = tokens[ca]
      balanceStr += ca + ',' + t.symbol + ',' + t.balanceUi + '\n'
    }
    balanceStr += '\n'
    return balanceStr
  }

  //
  // MARK: wallet Associated Token Account (ATA)
  //

  // 5 calls to get a balance for 500 wallets
  public async getTokenBalanceForWallets(mint: PublicKey, walletAddresses: string[]): Promise<Record<string, number>> {
    const walletPubkeys = walletAddresses.map(a => new PublicKey(a));
    const atAs = walletPubkeys.map(w => getAssociatedTokenAddressSync(mint, w));
    const balances: Record<string, number> = {};

    // fetch mint decimals once
    const decimals = await this.getDecimal(mint);

    // fetch ATAs in batches
    const infos = await this.batchGetMultipleAccountsInfo(atAs, 'getTokenBalanceForWallets');

    infos.forEach((info, idx) => {
      const walletKey = walletPubkeys[idx].toBase58();
      let uiAmount = 0;

      if (info?.data) {
        const account = unpackAccount(atAs[idx], info);
        // address, mint, owner, amount, delegate, delegatedAmount, isInitiailized, isFrozen, isNative
        // rentExemptReserve, closeAuthority, tlvData
        const raw = account.amount; // bigint
        uiAmount = Number(raw) / 10 ** decimals;
      }

      balances[walletKey] = uiAmount;
    });

    return balances;
  }

  /**
   * Subscribes to account changes for the given public key
   * @param {string} accountAddress - The account address to subscribe to
   * @returns {Promise<number>} Subscription ID
   */
  // needs to take a handler...
  public async subscribeToAccount(accountAddress: string, handler): Promise<number> {
    try {
      if (!this.validateAddress(accountAddress)) {
        throw new Error('Invalid account address');
      }

      // Check if already subscribed
      if (this.subscriptions.has(accountAddress)) {
        return this.subscriptions.get(accountAddress)!;
      }

      /*
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
      */
      const accountPubkeyObj = new PublicKey(accountAddress);
      const subscriptionId = this.connection.onAccountChange(accountPubkeyObj, (accountInfo, context) => {
        handler(accountAddress, accountInfo, context)
      }, 'finalized')


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

      // quote.priceImpactPct
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

  public async calculateOptimalBuyAmount2(quote: any, availableAmount: number): Promise<{ amount: number; slippage: number }> {
    try {
      // Get price impact for the trade

      // quote.priceImpactPct
      const priceImpact = Number(quote.priceImpactPct);

      // If price impact is too high, reduce the amount
      let optimalAmount = availableAmount;
      if (priceImpact > 5) {
        // 5% price impact threshold
        optimalAmount = availableAmount * 0.5; // Reduce amount by half
        console.log('calculateOptimalBuyAmount2 - too much price impact halving', optimalAmount)
      }

      let recommendedSlippage: number;
      if (priceImpact < 0.5) {
        recommendedSlippage = 50; // 0.5%
      } else if (priceImpact < 1) {
        recommendedSlippage = 100; // 1%
      } else {
        recommendedSlippage = 200; // 2%
      }

      //console.log('calculateOptimalBuyAmount - optimal slippage', slippage)
      return { amount: optimalAmount, slippage: recommendedSlippage };
    } catch (error) {
      logger.error('calculateOptimalBuyAmount2 - Error calculating optimal buy amount:', error);
      throw error;
    }
  }

  /**
   * Executes buy/sell orders for multiple wallets
   * @param {Array<{ keypair: any; amount: number }>} wallets - Array of buy information
   * @param {any} signal - Trading signal information
   * @returns {Promise<Array<{ success: boolean; outAmount?: number; fees?: any; swapResponse?: any }>>}
   */
  public async executeSwap(wallets: Array<{ keypair: any; amount: number }>, signal: any) {
    // do it in serial to avoid hitting rate limits
    const swapResponses = {}
    for(const wallet of wallets) {
      const pubKey = wallet.keypair.publicKey.toString()
      try {

        // validate amount
        const intAmount: number = parseInt(wallet.amount)
        if (isNaN(intAmount) || intAmount <= 0) {
          console.warn('solana::executeSwap - Amount in', wallet.amount, 'become', intAmount)
          swapResponses[pubKey] = {
            success: false,
            error: 'bad amount'
          };
          continue
        }

        // FIXME: pass in balance to avoid this check

        // balance check to protect quote rate limit
        const balances = await this.getBalancesByAddrs([pubKey])
        const bal = balances[pubKey]
        //console.log('executeSwap -', wallet.keypair.publicKey, 'bal', bal)

        // 0.000748928
        // might need to be 0.004

        const baseLamports = this.jupiterService.estimateLamportsNeeded({ inputMint: signal.sourceTokenCA, inAmount: intAmount })
        const ourLamports = bal * 1e9
        //console.log('baseLamports', baseLamports.toLocaleString(), 'weHave', ourLamports.toLocaleString())
        // avoid wasting jupiter quote rate limit
        if (baseLamports > ourLamports) {
          console.log('executeSwap - wallet', wallet.keypair.publicKey, 'SOL is too low to swap', 'baseLamports', baseLamports.toLocaleString(), 'weHave', ourLamports.toLocaleString())
          swapResponses[pubKey] = {
            success: false,
            error: 'not enough SOL'
          };
          continue
        }

        /*
        if (bal < 0.001) {
          console.log('executeSwap - wallet', wallet.keypair.publicKey, 'SOL is too low to do anything', bal)
          swapResponses[pubKey] = {
            success: false,
            error: 'not enough SOL'
          };
          continue
        }
        */

        console.log('signal.sourceTokenCA', signal.sourceTokenCA, 'signal.targetTokenCA', signal.targetTokenCA, 'wallet.amount', wallet.amount.toLocaleString())

        // is this reusable if there's a bunch of wallets with the same amount

        // Get initial quote to determine input mint and other parameters
        const initialQuote = await this.jupiterService.getQuote({
          inputMint: signal.sourceTokenCA,
          outputMint: signal.targetTokenCA,
          slippageBps: 200,
          amount: intAmount, // in atomic units of the token
        });
        // no decimals
        console.log('initialQuote', initialQuote)

        const availableLamports = bal * 1e9
        //console.log('availableLamports', availableLamports.toLocaleString())
        if (initialQuote.totalLamportsNeeded > availableLamports) {
          // we can't afford as is
          console.log('executeSwap - wallet', wallet.keypair.publicKey, 'SOL is too low, has', availableLamports.toLocaleString(), 'needs', initialQuote.totalLamportsNeeded.toLocaleString())
          // lets make sure
          swapResponses[pubKey] = {
            success: false,
            error: 'not enough SOL'
          };
          continue
        }

        /*
        const fees = {
          lamports: initialQuote.otherAmountThreshold,
          sol: initialQuote.otherAmountThreshold * SolanaService.LAMPORTS2SOL
        }
        */

        // outAmount, minOutAmount, priceImpactPct
        const impliedSlippageBps = ((initialQuote.outAmount - initialQuote.otherAmountThreshold) / initialQuote.outAmount) * 10_000;
        console.log('impliedSlippageBps', impliedSlippageBps, 'jupSlip', initialQuote.slippageBps)

        // Calculate optimal buy amount using the input mint from quote
        // slippage is drived by price impact
        const { amount, slippage } = await this.calculateOptimalBuyAmount2(initialQuote, wallet.amount)
        /*
        const { amount, slippage } = await this.calculateOptimalBuyAmount(
          initialQuote.inputMint,
          initialQuote.outputMint,
          wallet.amount
        );
        */
        // amount is in atomic units (input token)
        //
        console.log('adjusted amount', amount.toLocaleString(), 'price impact slippage', slippage)
        // adjust amount in initialQuote
        initialQuote.inAmount = "" + amount // in input atomic units
        delete initialQuote.swapUsdValue // invalidate

        /*
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
        */

        // why were we doing this?
        // partially to understand but we have docs now: https://dev.jup.ag/docs/api/swap-api/swap
        /*
        const quoteResponse = {
          inputMint: initialQuote.inputMint,
          inAmount: initialQuote.inAmount,
          outputMint: initialQuote.outputMint,
          outAmount: initialQuote.outAmount,
          otherAmountThreshold: initialQuote.otherAmountThreshold, // minimum amount after slippage
          swapMode: initialQuote.swapMode,
          slippageBps: initialQuote.slippageBps,
          platformFee: initialQuote.platformFee,
          priceImpactPct: initialQuote.priceImpactPct,
          routePlan: initialQuote.routePlan,
          contextSlot: initialQuote.contextSlot,
          timeTaken: initialQuote.timeTaken,
        }
        */

        // Execute the swap
        let swapResponse
        const executeSwap = async (impliedSlippageBps) => {
          console.log('executingSwap', pubKey, signal.sourceTokenCA, signal.targetTokenCA, 'with', impliedSlippageBps + 'bps slippage')
          // convert quote into instructions
          swapResponse = await this.jupiterService.executeSwap({
            quoteResponse: initialQuote,
            userPublicKey: pubKey,
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

          /*
          // just verify the quote is matching up
          const inner = transaction.meta.innerInstructions || [];
          let totalReceived = 0;
          inner.forEach(({ instructions }) => {
            instructions.forEach((ix: any) => {
              if (ix.program === 'spl-token' && ix.parsed.type === 'transfer') {
                const info = ix.parsed.info;
                if (info.destination === YOUR_TOKEN_ACCOUNT) {
                  totalReceived += Number(info.amount) / (10 ** DECIMALS);
                }
              }
            });
          });
          */

          // Send and confirm
          let txid = ''
          try {
            txid = await this.connection.sendRawTransaction(transaction.serialize());
          } catch (err) {
            if (err instanceof SendTransactionError) {
              // getLogs expects param?
              const logs = err.logs || await err.getLogs(this.connection);

              let showLogs = true

              if (logs) {
                if (logs.some(l => l.includes('custom program error: 0x1771'))) {
                  console.log('Swap failed: slippage tolerance exceeded.', parseInt(impliedSlippageBps));
                  // handle slippage
                  // 🎯 You could retry with higher slippage or log for the user

                  // increment the slippage? and try again?
                  if (signal.targetTokenCA === 'So11111111111111111111111111111111111111112') {
                    // sell parameters
                    if (impliedSlippageBps < 3000) {
                      // let jupiter swap api rest
                      await new Promise((resolve) => setTimeout(resolve, 1000));
                      // double and try again
                      return executeSwap(impliedSlippageBps * 2)
                    }
                    // just fail
                  } else {
                    // buy parameters
                    // we don't need to pay more
                    // but we can retry
                    showLogs = false
                  }
                }

                if (logs.some(l => l.includes('insufficient lamports'))) {
                  console.log('Transaction failed: insufficient lamports in the account.');
                  // optionally prompt user to top up SOL
                }

                if (logs.some(l => l.includes('Program X failed: custom program error'))) {
                  console.log('Custom program failure detected.');
                  // further custom program handling
                }

                if (showLogs) {
                  console.log('logs', logs)
                }
              }

            }
            throw err;
          }
          console.log(pubKey, signal.sourceTokenCA, signal.targetTokenCA, 'txid', txid) // should probably always log this
          // swapResponse is of value
          return txid
        }

        const txid = await executeSwap(impliedSlippageBps)

        // only adding this back to slow down quoting
        await this.connection.confirmTransaction(txid, 'finalized');
        //console.log('finalized')

        // Get transaction details including fees
        const txDetails = await this.connection.getTransaction(txid, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0
        });
        //console.log('txDetails', txDetails)

        //const JUPITER_AGGREGATOR_V6 = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
        /*
        const swapIxIndex = txDetails.transaction.message.instructions
          .findIndex(ix => txDetails.transaction.message.accountKeys[ix.programIdIndex] === "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
        */
        /*
        const swapIxIndex = txDetails.transaction.message.instructions.findIndex(ix =>
          txDetails.transaction.message.accountKeys[ix.programIdIndex].equals(JUPITER_AGGREGATOR_V6)
        );

        const inner = txDetails.meta.innerInstructions?.find(i => i.index === swapIxIndex);
        let totalReceivedRaw = 0;

        inner?.instructions.forEach(ix => {
          if (ix.program === 'spl-token' && ix.parsed.type === 'transfer') {
            const info = ix.parsed.info;
            if (info.destination === YOUR_TOKEN_ACCOUNT) {
              totalReceivedRaw += Number(info.amount);
            }
          }
        });
        const decimals = DECIMALS; // fetch or store elsewhere
        const totalReceived = totalReceivedRaw / (10 ** decimals);
        console.log('Total tokens received:', totalReceived);
        */
        let outAmount = initialQuote.outAmount
        console.log('going to report', initialQuote.outAmount)
        //console.log('postTokenBalances', txDetails.meta.postTokenBalances)

        if (txDetails.meta.preTokenBalances && txDetails.meta.postTokenBalances) {
          // find only returns the first match
          const inBal = txDetails.meta.preTokenBalances.find(tb => tb.owner === pubKey && tb.mint === signal.targetTokenCA)
          const outBal = txDetails.meta.postTokenBalances.find(tb => tb.owner === pubKey && tb.mint === signal.targetTokenCA)
          console.log('inBal', inBal?.uiTokenAmount?.uiAmount, 'outBal', outBal?.uiTokenAmount?.uiAmount)

          // if selling to SOL, there won't be an account change

          if (outBal?.uiTokenAmount.decimals) {
            this.decimalsCache.set(signal.targetTokenCA, outBal.uiTokenAmount.decimals)
          }

          if (inBal && outBal) {
            const lamDiff = outBal.uiTokenAmount.uiAmount - inBal.uiTokenAmount.uiAmount
            const diff = Number(outBal.uiTokenAmount.amount) - Number(inBal.uiTokenAmount.amount)
            // we definitely didn't swap for nothing
            if (diff) {
              outAmount = diff
              console.log('changing report to', outAmount, '(', lamDiff, ')')
            }
          } else if (outBal) {
            // just means we weren't already holding the token
            const amt = Number(outBal.uiTokenAmount.amount)
            // we definitely didn't swap for nothing
            if (amt) {
              outAmount = amt
              console.log('changing report to', outAmount)
            }
          } else {
            console.log('no balances? wallet', pubKey, 'token', signal.targetTokenCA)
            //console.log('preTokenBalances', txDetails.meta.preTokenBalances, '=>', txDetails.meta.postTokenBalances)
            console.log('wallet', txDetails.meta.preTokenBalances.find(tb => tb.owner === pubKey), '=>', txDetails.meta.postTokenBalances.find(tb => tb.owner === pubKey))
          }
        }

        const fee = txDetails.meta.fee;
        console.log(`Transaction fee: ${fee.toLocaleString()} lamports`);
        const fees = {
          /*
          quote: {
            lamports: initialQuote.platformFee.amount,
            bps: initialQuote.platformFee.feeBps,
          },
          */
          lamports: fee,
          sol: fee * SolanaService.LAMPORTS2SOL
        }

        /*
        // Calculate final amounts including fees
        const fees = await this.jupiterService.estimateGasFees({
          inputMint: initialQuote.inputMint,
          outputMint: initialQuote.outputMint,
          amount,
        });
        */

        swapResponses[pubKey] = {
          success: true,
          outAmount,
          outDecimal: await this.getDecimal(signal.targetTokenCA),
          signature: txid,
          fees,
          swapResponse,
        };
      } catch (error) {
        logger.error('Error in swap execution:', error);
        swapResponses[pubKey] = { success: false };
      }
    }

    return swapResponses;
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
