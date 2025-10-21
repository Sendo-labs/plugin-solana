#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-solana
 */

const externalDeps = [
  "@elizaos/core",
  "@elizaos/service-interfaces",
  "dotenv",
  "@reflink/reflink",
  "@node-llama-cpp",
  "agentkeepalive",
  "safe-buffer",
  "base-x",
  "bs58",
  "borsh",
  "@solana/buffer-layout",
  "querystring",
  "zod",
];

async function build() {
  const totalStart = Date.now();

  // ESM build
  const esmStart = Date.now();
  console.log("🔨 Building @elizaos/plugin-solana...");
  const esmResult = await Bun.build({
    entrypoints: ["src/index.ts"],
    outdir: "dist",
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: externalDeps,
  });
  if (!esmResult.success) {
    console.error(esmResult.logs);
    throw new Error("ESM build failed");
  }
  console.log(
    `✅ Build complete in ${((Date.now() - esmStart) / 1000).toFixed(2)}s`
  );

  // TypeScript declarations
  const dtsStart = Date.now();
  console.log("📝 Generating TypeScript declarations...");
  const { $ } = await import("bun");
  await $`tsc --project tsconfig.build.json`;
  console.log(
    `✅ Declarations generated in ${((Date.now() - dtsStart) / 1000).toFixed(2)}s`
  );

  console.log(
    `🎉 All builds finished in ${((Date.now() - totalStart) / 1000).toFixed(2)}s`
  );
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
