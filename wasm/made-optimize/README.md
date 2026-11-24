# MadeOptimize (`made_optimize.wasm`) v0.3.0

Motor WebAssembly **100% propio en Rust** para **Made3D**, diseñado para unificar y superar a `draco_decoder.wasm` y `meshopt_decoder.module.js` en un solo binario compacto sin Emscripten ni `eval`:

1. **Decodificador Draco (`KHR_draco_mesh_compression` / `.drc`):**
   - Lectura de cabecera, metadatos, conectividad secuencial y EdgeBreaker (Standard, Predictive y Valence con 6 contextos reales), orden estándar de 2 pasadas (`EncodePortableAttributes` + `EncodeDataNeededByPortableTransform`), entropía rANS (Tagged y Raw), predictores inversos, decuantización, normales octaédricas y normalización glTF/skinning en una sola pasada.
2. **Codificador / Compresor Draco estándar (`encode_draco`):**
   - Genera bitstreams `"DRACO"` v2.2 compatibles byte a byte con `draco_decoder.wasm` / Google Draco estándar.
3. **Decodificador Meshopt (`EXT_meshopt_compression`):**
   - Soporte para bloques `ATTRIBUTES`, `TRIANGLES`, `INDICES` y filtros `NONE`, `OCTAHEDRAL`, `QUATERNION` y `EXPONENTIAL`.
4. **Optimizador GPU de mallas (`optimize.rs`):**
   - Deduplicación por posición o respetando costuras multi-atributo (`mo_mesh_optimize_attrs`), caché de vértices Forsyth y *Vertex Fetch*.
5. **BVH + Frustum Culling + Selección de LOD (`bvh.rs`):**
   - Árbol BVH sobre esferas envolventes (`[cx, cy, cz, radius]`), consulta iterativa con cero asignaciones por cuadro (`mo_bvh_query_frustum`), actualización dinámica con `mo_bvh_refit` y selección automática de nivel LOD por distancia.
6. **Simplificación QEM para LODs y Meshlets (`lod.rs`):**
   - Generación automática de LODs mediante Quadric Error Metrics (`mo_lod_simplify`) preservando bordes y optimizando el resultado para caché GPU.
   - Particionado en **Meshlets / Clusters** (`mo_meshlets_build`) con esfera envolvente y cono de normales para culling en WebGPU.

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

Cuando compile v0.3.0, pásame el nuevo **`dist/made_optimize.wasm`** para integrarlo en `src/libs/made-optimize/made_optimize.wasm` y activar la ruta nativa WASM para BVH, Frustum Culling, LODs QEM y Meshlets.
