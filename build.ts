#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-solana
 */

import { $ } from "bun";

async function build() {
  const totalStart = Date.now();

  // Load package.json and auto-generate externals from dependencies
  const pkg = await Bun.file("package.json").json();
  const externalDeps = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ];

  // Clean previous build
  await $`rm -rf dist`;

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
