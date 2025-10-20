import type { IAgentRuntime, Plugin, ServiceTypeName } from '@elizaos/core';
import { parseBooleanFromText } from '@elizaos/core';

// actions
import { executeSwap } from './actions/swap';
import transferToken from './actions/transfer';

// providers
import { walletProvider } from './providers/wallet';

// service
import { SolanaService, SolanaWalletService } from './service';

import { SOLANA_SERVICE_NAME } from './constants';

export const solanaPlugin: Plugin = {
  name: SOLANA_SERVICE_NAME,
  description: 'Solana blockchain plugin',
  services: [SolanaService, SolanaWalletService],
  init: async (_, runtime: IAgentRuntime) => {

    // Validation
    if (!runtime.getSetting('SOLANA_RPC_URL')) {
      runtime.logger.log('no SOLANA_RPC_URL, skipping plugin-solana init')
      return
    }

    const noActions = parseBooleanFromText(runtime.getSetting("SOLANA_NO_ACTIONS"));
    if (!noActions) {
      runtime.registerAction(transferToken)
      runtime.registerAction(executeSwap)
    } else {
      runtime.logger.log('SOLANA_NO_ACTIONS is set, skipping solana actions')
    }

    runtime.registerProvider(walletProvider)

    // extensions
    runtime.getServiceLoadPromise('INTEL_CHAIN' as ServiceTypeName).then( () => {
      //runtime.logger.log('solana INTEL_CHAIN LOADED')
      const traderChainService = runtime.getService('INTEL_CHAIN') as any;
      const me = {
        name: 'Solana services',
        chain: 'solana',
        service: SOLANA_SERVICE_NAME,
      };
      traderChainService.registerChain(me);
    })

  },
};
export default solanaPlugin;

// Export additional items for use by other plugins
export { SOLANA_SERVICE_NAME } from './constants';
export { SolanaService, SolanaWalletService } from './service';
export type { SolanaService as ISolanaService } from './service';