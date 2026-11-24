# MadeTexture (`made_texture.wasm`)

Motor WebAssembly **100% propio en Rust puro** para Made3D que reemplaza completamente a `basis_transcoder.js` + `basis_transcoder.wasm` (sin Emscripten, sin `eval` y sin `new Function`).

## Capacidades
- **Contenedor KTX2 + DFD completo**: cabecera KTX2, `LevelIndex`, detección de alfa (`channelType` UASTC/ASTC y muestras ETC1S/RGBSDA), espacio de color (`srgb` / `linear`), texturas 2D, mipmaps, arrays y cubemaps.
- **Supercompresión**: `None`, `BasisLZ (ETC1S)`, `Zstandard` (`ruzstd` en Rust puro) y `Zlib` (`miniz_oxide` en Rust puro).
- **Decodificador UASTC LDR 4×4 completo**: los 19 modos (0..18), particiones de 1, 2 y 3 subconjuntos, dual-plane, anclas, BISE y tablas de descuantización ASTC.
- **Decodificador ETC1S / BasisLZ completo**: tablas Huffman canónicas, libros globales de endpoints y selectores (DPCM / raw), predicción 2×2 + historial MTF + RLE + canal alfa por slice.
- **Transcodificador GPU**: `RGBA32`, `ASTC 4×4`, `BC7`, `ETC2 RGBA`, `ETC2/ETC1 RGB`, `BC3`, `BC1` (además de pass-through directo para KTX2 ya codificados en formatos GPU estándar).

## Cómo compilar

### Linux / macOS
```bash
cd wasm/made-texture
./build.sh
```

### Windows (PowerShell)
```powershell
cd wasm\made-texture
.\build.ps1
```

El archivo compilado queda en `wasm/made-texture/dist/made_texture.wasm`. Copiarlo a `src/libs/made-texture/made_texture.wasm` para activarlo en Made3D.
