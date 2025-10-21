#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-solana using standardized build utilities
 */

import { createBuildRunner } from '../../build-utils';

// Create and run the standardized build runner
const run = createBuildRunner({
  packageName: '@elizaos/plugin-solana',
  buildOptions: {
    entrypoints: ['src/index.ts'],
    outdir: 'dist',
    target: 'bun',  // instead of 'node'
    format: 'esm',
    strict: true,
    clean: true,
    external: [
      // keep third-party externals
      'dotenv','@reflink/reflink','@node-llama-cpp',
      'agentkeepalive','safe-buffer','base-x','bs58','borsh',
      '@solana/buffer-layout','querystring',
      '@elizaos/core','@elizaos/service-interfaces','zod',
      'node:stream/web', // optional if you reference it; bun-types has it
      'fs','path','https','http','stream','buffer'
    ],
    sourcemap: true,
    minify: false,
    generateDts: false,
  },
});


// Execute the build
run().catch((error) => {
  //console.error('Build script error:', error);
  process.exit(1);
});
