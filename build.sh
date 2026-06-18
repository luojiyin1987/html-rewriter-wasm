#!/usr/bin/env bash
set -e

echo "---> Checking wasm-pack version..."
# We need wasm-pack that uses Binaryen version_92+ (exports asyncify_get_state)
# Official wasm-pack >= 0.12.0 ships wasm-opt version_92+, no fork needed
WASM_PACK_VERSION=$(wasm-pack --version)
echo "Found: $WASM_PACK_VERSION"

echo "---> Building WebAssembly with wasm-pack..."
# Disable reference types in WASM output: asyncify doesn't support them yet
# See: https://github.com/WebAssembly/binaryen/issues/3739
RUSTFLAGS="-C target-feature=-reference-types" wasm-pack build --target nodejs

echo "---> Patching JavaScript glue code..."
# Apply transformations to wasm-bindgen output:
# 1. Import setWasmExports and wrap from asyncify.js
# 2. Make mutation methods return this (for chaining)
# 3. Make write/end async using wrap()
# 4. Fix attributes to return iterator
# 5. Fix onEndTag to bind this
python3 src/patch_glue.py pkg/html_rewriter.js

echo "---> Copying required files to dist..."
mkdir -p dist
cp pkg/html_rewriter.js dist/html_rewriter.js
cp pkg/html_rewriter_bg.wasm dist/html_rewriter_bg.wasm
cp src/asyncify.js dist/asyncify.js
cp src/html_rewriter.d.ts dist/html_rewriter.d.ts
