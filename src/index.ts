import type { IAgentRuntime, Plugin } from '@elizaos/core';
import { logger } from '@elizaos/core';
import { executeSwap } from './actions/swap';
import transferToken from './actions/transfer';
import { SOLANA_SERVICE_NAME } from './constants';
import { walletProvider } from './providers/wallet';
import { SolanaService } from './service';

export const solanaPlugin: Plugin = {
  name: SOLANA_SERVICE_NAME,
  description: 'Solana Plugin for Eliza',
  actions: [transferToken, executeSwap],
  evaluators: [],
  providers: [walletProvider],
  services: [SolanaService],
  init: async (_, runtime: IAgentRuntime) => {
    logger.debug('solana init');

    new Promise<void>(async (resolve) => {
      resolve();
      const asking = 'solana';
      const serviceType = 'TRADER_CHAIN';
      const maxRetries = 10;
      let retries = 0;

      let traderChainService = runtime.getService(serviceType) as any;
      while (!traderChainService && retries < maxRetries) {
        logger.debug(`${asking} waiting for ${serviceType} service... (${retries + 1}/${maxRetries})`);
        traderChainService = runtime.getService(serviceType) as any;
        if (!traderChainService) {
          await new Promise((waitResolve) => setTimeout(waitResolve, 1000));
          retries++;
        } else {
          logger.debug(`${asking} Acquired ${serviceType} service...`);
        }
      }

      if (traderChainService) {
        const me = {
          name: 'Solana services',
          chain: 'solana',
          service: SOLANA_SERVICE_NAME,
        };
        traderChainService.registerChain(me);
        logger.debug('solana init done');
      } else {
        logger.debug('solana init done (standalone mode - TRADER_CHAIN service not available)');
      }
    });
  },
};
export default solanaPlugin;
