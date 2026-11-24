$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "[MadeOptimize] Ejecutando tests unitarios en Rust..."
cargo test

Write-Host "[MadeOptimize] Verificando target wasm32-unknown-unknown..."
rustup target add wasm32-unknown-unknown | Out-Null

Write-Host "[MadeOptimize] Compilando release WebAssembly..."
cargo build --target wasm32-unknown-unknown --release

New-Item -ItemType Directory -Force -Path "dist" | Out-Null
$wasmSrc = "target/wasm32-unknown-unknown/release/made_optimize.wasm"
$wasmDst = "dist/made_optimize.wasm"
Copy-Item $wasmSrc $wasmDst -Force

if (Get-Command wasm-opt -ErrorAction SilentlyContinue) {
  Write-Host "[MadeOptimize] Optimizando con wasm-opt -Oz..."
  wasm-opt -Oz $wasmDst -o $wasmDst
}

$size = (Get-Item $wasmDst).Length
Write-Host "[MadeOptimize] Listo: $wasmDst ($size bytes)"
