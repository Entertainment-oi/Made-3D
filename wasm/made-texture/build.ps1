$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "[MadeTexture] Ejecutando tests unitarios en Rust..."
cargo test

Write-Host "[MadeTexture] Verificando target wasm32-unknown-unknown..."
rustup target add wasm32-unknown-unknown | Out-Null

Write-Host "[MadeTexture] Compilando release WebAssembly..."
cargo build --target wasm32-unknown-unknown --release

New-Item -ItemType Directory -Force -Path "dist" | Out-Null
$wasmSrc = "target/wasm32-unknown-unknown/release/made_texture.wasm"
$wasmDst = "dist/made_texture.wasm"
Copy-Item $wasmSrc $wasmDst -Force

if (Get-Command wasm-opt -ErrorAction SilentlyContinue) {
  Write-Host "[MadeTexture] Optimizando con wasm-opt -Oz..."
  wasm-opt -Oz $wasmDst -o $wasmDst
}

$size = (Get-Item $wasmDst).Length
Write-Host "[MadeTexture] Listo: $wasmDst ($size bytes)"
