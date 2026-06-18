#!/usr/bin/env bash
set -euo pipefail

STEP=0
step() { STEP=$((STEP+1)); echo "---> [$STEP] $1"; }

START=$(date +%s)

step "Checking wasm-pack version..."
WASM_PACK_VERSION=$(wasm-pack --version)
echo "    Found: $WASM_PACK_VERSION"

step "Building WebAssembly with wasm-pack..."
RUSTFLAGS="-C target-feature=-reference-types" wasm-pack build --target nodejs

step "Patching JavaScript glue code..."
python3 src/patch_glue.py pkg/html_rewriter.js

step "Copying required files to dist..."
mkdir -p dist
cp pkg/html_rewriter.js dist/html_rewriter.js
cp pkg/html_rewriter_bg.wasm dist/html_rewriter_bg.wasm
cp src/asyncify.js dist/asyncify.js
cp src/html_rewriter.d.ts dist/html_rewriter.d.ts

step "Build summary"
WASM_SIZE=$(du -h dist/html_rewriter_bg.wasm | cut -f1)
JS_SIZE=$(du -h dist/html_rewriter.js | cut -f1)
END=$(date +%s)
ELAPSED=$((END - START))
echo "    WASM: $WASM_SIZE | JS: $JS_SIZE | Time: ${ELAPSED}s"
