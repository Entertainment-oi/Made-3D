# MadeOptimize (`made_optimize.wasm`) v0.2.0

Motor WebAssembly **100% propio en Rust** para **Made3D**, diseñado para unificar y superar a `draco_decoder.wasm` y `meshopt_decoder.module.js` en un solo binario compacto sin Emscripten ni `eval`:

1. **Decodificador Draco (`KHR_draco_mesh_compression` / `.drc`):**
   - Lectura de cabecera, metadatos, conectividad secuencial y EdgeBreaker (Standard, Predictive y Valence con 6 contextos reales), orden estándar de 2 pasadas (`EncodePortableAttributes` + `EncodeDataNeededByPortableTransform`), entropía rANS (Tagged y Raw), predictores inversos, decuantización, normales octaédricas y normalización glTF/skinning en una sola pasada.
2. **Codificador / Compresor Draco estándar (`encode_draco`):**
   - Genera bitstreams `"DRACO"` v2.2 compatibles byte a byte con `draco_decoder.wasm` / Google Draco estándar (conectividad secuencial comprimida, separación de fases portable/transform, cuantización por atributo, predicción diferencial, normales octaédricas y entropía rANS).
3. **Decodificador Meshopt (`EXT_meshopt_compression`):**
   - Soporte para bloques `ATTRIBUTES`, `TRIANGLES`, `INDICES` y filtros `NONE`, `OCTAHEDRAL`, `QUATERNION` y `EXPONENTIAL`.
4. **Optimizador GPU de mallas (`optimize.rs`):**
   - Deduplicación por posición o respetando costuras multi-atributo (`mo_mesh_optimize_attrs`: normales, UVs, colores).
   - Reordenamiento de índices para caché de vértices GPU (algoritmo de Forsyth).
   - Reordenamiento de *Vertex Fetch* para lecturas secuenciales en memoria de video.

## Requisitos para compilar

1. Tener instalado Rust (`rustup`): https://rustup.rs/
2. El script agrega automáticamente `wasm32-unknown-unknown`.
3. *(Opcional)* `wasm-opt` (`binaryen`) para comprimir aún más el tamaño del `.wasm`.

## Compilación rápida

### Linux / macOS
```bash
chmod +x build.sh
./build.sh
```

### Windows (PowerShell)
```powershell
.\build.ps1
```

El binario compilado quedará en `dist/made_optimize.wasm`.

## Qué archivos devolver a Made3D

Cuando compile v0.2.0, pásame el nuevo **`made_optimize.wasm`** para verificar compatibilidad cruzada con `.glb`/`.drc` externos y eliminar `src/libs/draco/`.
