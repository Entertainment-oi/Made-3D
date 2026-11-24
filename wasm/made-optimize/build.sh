#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "[MadeOptimize] Ejecutando tests unitarios en Rust..."
cargo test

echo "[MadeOptimize] Verificando target wasm32-unknown-unknown..."
rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true

echo "[MadeOptimize] Compilando release WebAssembly..."
cargo build --target wasm32-unknown-unknown --release

mkdir -p dist
WASM_SRC="target/wasm32-unknown-unknown/release/made_optimize.wasm"
WASM_DST="dist/made_optimize.wasm"
cp "$WASM_SRC" "$WASM_DST"

if command -v wasm-opt >/dev/null 2>&1; then
  echo "[MadeOptimize] Optimizando con wasm-opt -Oz..."
  wasm-opt -Oz "$WASM_DST" -o "$WASM_DST"
fi

SIZE=$(wc -c < "$WASM_DST" | tr -d ' ')
echo "[MadeOptimize] Listo: $WASM_DST (${SIZE} bytes)"
