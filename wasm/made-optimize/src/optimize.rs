use std::collections::HashMap;

/// Resultado completo de la optimización GPU de una malla.
#[derive(Debug, Clone)]
pub struct OptimizedMesh {
    pub num_points: usize,
    pub indices: Vec<u32>,
    /// Remapeo de cada vértice nuevo -> índice en el buffer de entrada original
    /// (`new_vertex_i` debe copiar los atributos de `remap[new_vertex_i]`).
    pub vertex_remap: Vec<u32>,
    /// Buffer de posiciones optimizado y compactado (stride 3 * f32).
    pub positions: Vec<f32>,
}

/// Deduplica vértices idénticos por posición (cuantizada opcionalmente o exacta)
/// devolviendo `(num_unique_vertices, new_indices, unique_to_old_vertex)`.
pub fn deduplicate_positions(
    positions: &[f32],
    indices: Option<&[u32]>,
    quantize_step: f32,
) -> (usize, Vec<u32>, Vec<u32>) {
    let raw_count = positions.len() / 3;
    let src_indices: Vec<u32> = match indices {
        Some(idx) => idx.to_vec(),
        None => (0..raw_count as u32).collect(),
    };

    let inv_step = if quantize_step > 0.0 {
        1.0 / quantize_step
    } else {
        0.0
    };

    let mut map: HashMap<(u32, u32, u32), u32> = HashMap::with_capacity(raw_count);
    let mut remap = Vec::with_capacity(raw_count);
    let mut out_indices = Vec::with_capacity(src_indices.len());

    for &old_idx in &src_indices {
        let base = (old_idx as usize) * 3;
        if base + 2 >= positions.len() {
            continue;
        }
        let key = if inv_step > 0.0 {
            (
                (positions[base] * inv_step).round() as i32 as u32,
                (positions[base + 1] * inv_step).round() as i32 as u32,
                (positions[base + 2] * inv_step).round() as i32 as u32,
            )
        } else {
            (
                positions[base].to_bits(),
                positions[base + 1].to_bits(),
                positions[base + 2].to_bits(),
            )
        };

        let new_idx = match map.get(&key) {
            Some(&idx) => idx,
            None => {
                let idx = remap.len() as u32;
                map.insert(key, idx);
                remap.push(old_idx);
                idx
            }
        };
        out_indices.push(new_idx);
    }

    (remap.len(), out_indices, remap)
}

/// Optimizador de caché de vértices GPU (algoritmo de Tom Forsyth).
/// Minimiza la tasa de fallos de caché post-transformación (ACMR) manteniendo complejidad lineal O(V + F).
pub fn optimize_vertex_cache(indices: &[u32], vertex_count: usize) -> Vec<u32> {
    const CACHE_SIZE: usize = 32;
    let face_count = indices.len() / 3;
    if face_count == 0 || vertex_count == 0 {
        return indices.to_vec();
    }

    let mut valence = vec![0u32; vertex_count];
    for &idx in indices {
        if (idx as usize) < vertex_count {
            valence[idx as usize] += 1;
        }
    }

    let mut offsets = vec![0usize; vertex_count + 1];
    for i in 0..vertex_count {
        offsets[i + 1] = offsets[i] + valence[i] as usize;
    }

    let mut adj_faces = vec![0u32; offsets[vertex_count]];
    let mut cursor = offsets.clone();
    for f in 0..face_count {
        for k in 0..3 {
            let v = indices[f * 3 + k] as usize;
            if v < vertex_count {
                adj_faces[cursor[v]] = f as u32;
                cursor[v] += 1;
            }
        }
    }

    let mut cache_pos = vec![-1i32; vertex_count];
    let mut vertex_score = vec![0.0f32; vertex_count];
    for v in 0..vertex_count {
        vertex_score[v] = compute_vertex_score(-1, valence[v]);
    }

    let mut face_emitted = vec![false; face_count];
    let mut face_score = vec![0.0f32; face_count];
    for f in 0..face_count {
        let mut s = 0.0f32;
        for k in 0..3 {
            let v = indices[f * 3 + k] as usize;
            if v < vertex_count {
                s += vertex_score[v];
            }
        }
        face_score[f] = s;
    }

    let mut lru: Vec<usize> = Vec::with_capacity(CACHE_SIZE + 3);
    let mut out = Vec::with_capacity(indices.len());
    let mut scan_pos = 0usize;

    let mut best_face: Option<usize> = (0..face_count).max_by(|&a, &b| {
        face_score[a]
            .partial_cmp(&face_score[b])
            .unwrap_or(core::cmp::Ordering::Equal)
    });

    while out.len() < face_count * 3 {
        let f = match best_face {
            Some(f) if !face_emitted[f] => f,
            _ => {
                while scan_pos < face_count && face_emitted[scan_pos] {
                    scan_pos += 1;
                }
                if scan_pos >= face_count {
                    break;
                }
                scan_pos
            }
        };

        face_emitted[f] = true;
        for k in 0..3 {
            let v = indices[f * 3 + k] as usize;
            out.push(v as u32);
            if v >= vertex_count {
                continue;
            }
            if valence[v] > 0 {
                valence[v] -= 1;
            }
            if let Some(pos) = lru.iter().position(|&x| x == v) {
                lru.remove(pos);
            }
            lru.insert(0, v);
        }

        if lru.len() > CACHE_SIZE {
            for &evicted in &lru[CACHE_SIZE..] {
                cache_pos[evicted] = -1;
                vertex_score[evicted] = compute_vertex_score(-1, valence[evicted]);
            }
            lru.truncate(CACHE_SIZE);
        }

        for (pos, &v) in lru.iter().enumerate() {
            cache_pos[v] = pos as i32;
            vertex_score[v] = compute_vertex_score(pos as i32, valence[v]);
        }

        // Actualizar puntajes de caras vecinas y elegir la mejor siguiente
        let mut next_best: Option<usize> = None;
        let mut next_best_score = -1.0f32;

        for &v in &lru {
            let start = offsets[v];
            let end = offsets[v + 1];
            for &nf in &adj_faces[start..end] {
                let nfu = nf as usize;
                if face_emitted[nfu] {
                    continue;
                }
                let mut s = 0.0f32;
                for k in 0..3 {
                    let nv = indices[nfu * 3 + k] as usize;
                    if nv < vertex_count {
                        s += vertex_score[nv];
                    }
                }
                face_score[nfu] = s;
                if s > next_best_score {
                    next_best_score = s;
                    next_best = Some(nfu);
                }
            }
        }
        best_face = next_best;
    }

    out
}

#[inline]
fn compute_vertex_score(cache_pos: i32, active_valence: u32) -> f32 {
    if active_valence == 0 {
        return -1.0;
    }
    let cache_score = if cache_pos < 0 {
        0.0
    } else if cache_pos < 3 {
        0.75
    } else {
        let scaler = 1.0 / (32.0 - 3.0);
        (1.0 - ((cache_pos - 3) as f32) * scaler).max(0.0).powf(1.5)
    };
    let valence_score = 2.0 * (active_valence as f32).powf(-0.5);
    cache_score + valence_score
}

/// Reordena vértices en orden de primera aparición para maximizar localidad de *Vertex Fetch*.
/// Devuelve `(reordered_indices, new_to_old_vertex_remap)`.
pub fn optimize_vertex_fetch(indices: &[u32], vertex_count: usize) -> (Vec<u32>, Vec<u32>) {
    let mut old_to_new = vec![u32::MAX; vertex_count];
    let mut new_to_old = Vec::with_capacity(vertex_count);
    let mut out_indices = Vec::with_capacity(indices.len());

    for &old in indices {
        let ou = old as usize;
        if ou >= vertex_count {
            out_indices.push(old);
            continue;
        }
        let mapped = if old_to_new[ou] == u32::MAX {
            let idx = new_to_old.len() as u32;
            old_to_new[ou] = idx;
            new_to_old.push(old);
            idx
        } else {
            old_to_new[ou]
        };
        out_indices.push(mapped);
    }

    (out_indices, new_to_old)
}

#[inline]
fn quantize_attr_key_val(v: f32) -> u64 {
    if v.is_finite() && v.abs() < 1.0e9 {
        ((v as f64) * 100_000.0).round() as i64 as u64
    } else if v == 0.0 {
        0
    } else {
        v.to_bits() as u64
    }
}

/// Deduplica vértices idénticos por posición + atributos extra (normales, UVs, colores, etc.),
/// preservando las costuras donde la posición coincide pero los atributos difieren.
pub fn deduplicate_with_attributes(
    positions: &[f32],
    extra_attrs: &[f32],
    extra_stride: usize,
    indices: Option<&[u32]>,
    quantize_step: f32,
) -> (usize, Vec<u32>, Vec<u32>) {
    if extra_stride == 0 || extra_attrs.is_empty() {
        return deduplicate_positions(positions, indices, quantize_step);
    }

    let raw_count = positions.len() / 3;
    let src_indices: Vec<u32> = match indices {
        Some(idx) => idx.to_vec(),
        None => (0..raw_count as u32).collect(),
    };

    let inv_step = if quantize_step > 0.0 {
        1.0 / quantize_step
    } else {
        0.0
    };

    let mut map: HashMap<Vec<u64>, u32> = HashMap::with_capacity(raw_count);
    let mut remap = Vec::with_capacity(raw_count);
    let mut out_indices = Vec::with_capacity(src_indices.len());

    for &old_idx in &src_indices {
        let base = (old_idx as usize) * 3;
        if base + 2 >= positions.len() {
            continue;
        }
        let mut key = Vec::with_capacity(3 + extra_stride);
        if inv_step > 0.0 {
            key.push((positions[base] * inv_step).round() as i32 as u32 as u64);
            key.push((positions[base + 1] * inv_step).round() as i32 as u32 as u64);
            key.push((positions[base + 2] * inv_step).round() as i32 as u32 as u64);
        } else {
            key.push(if positions[base] == 0.0 { 0 } else { positions[base].to_bits() as u64 });
            key.push(if positions[base + 1] == 0.0 { 0 } else { positions[base + 1].to_bits() as u64 });
            key.push(if positions[base + 2] == 0.0 { 0 } else { positions[base + 2].to_bits() as u64 });
        }

        let ebase = (old_idx as usize) * extra_stride;
        for c in 0..extra_stride {
            let val = if ebase + c < extra_attrs.len() {
                extra_attrs[ebase + c]
            } else {
                0.0
            };
            key.push(quantize_attr_key_val(val));
        }

        let new_idx = match map.get(&key) {
            Some(&idx) => idx,
            None => {
                let idx = remap.len() as u32;
                map.insert(key, idx);
                remap.push(old_idx);
                idx
            }
        };
        out_indices.push(new_idx);
    }

    (remap.len(), out_indices, remap)
}

/// Pipeline completo: deduplica -> optimiza Vertex Cache -> optimiza Vertex Fetch.
pub fn optimize_mesh(
    positions: &[f32],
    indices: Option<&[u32]>,
    dedup_step: f32,
) -> OptimizedMesh {
    optimize_mesh_with_attributes(positions, &[], 0, indices, dedup_step)
}

/// Pipeline completo respetando costuras de atributos (normales, UVs, colores).
pub fn optimize_mesh_with_attributes(
    positions: &[f32],
    extra_attrs: &[f32],
    extra_stride: usize,
    indices: Option<&[u32]>,
    dedup_step: f32,
) -> OptimizedMesh {
    let (dedup_count, dedup_indices, dedup_remap) =
        deduplicate_with_attributes(positions, extra_attrs, extra_stride, indices, dedup_step);
    let vcache_indices = optimize_vertex_cache(&dedup_indices, dedup_count);
    let (final_indices, fetch_remap) = optimize_vertex_fetch(&vcache_indices, dedup_count);

    let mut combined_remap = Vec::with_capacity(fetch_remap.len());
    let mut out_positions = Vec::with_capacity(fetch_remap.len() * 3);
    for &mid in &fetch_remap {
        let orig = dedup_remap[mid as usize];
        combined_remap.push(orig);
        let b = (orig as usize) * 3;
        out_positions.push(positions[b]);
        out_positions.push(positions[b + 1]);
        out_positions.push(positions[b + 2]);
    }

    OptimizedMesh {
        num_points: combined_remap.len(),
        indices: final_indices,
        vertex_remap: combined_remap,
        positions: out_positions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optimize_dedup_cache_fetch() {
        // Dos triángulos formando un quad con vértices duplicados (6 vértices -> 4 únicos)
        let positions = vec![
            0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0,
            0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0,
        ];
        let opt = optimize_mesh(&positions, None, 0.0);
        assert_eq!(opt.num_points, 4);
        assert_eq!(opt.indices.len(), 6);
        assert_eq!(opt.vertex_remap.len(), 4);
    }

    #[test]
    fn optimize_preserves_attribute_seams() {
        // Dos triángulos compartiendo arista en posición pero con normales distintas (arista dura)
        let positions = vec![
            0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0,
            1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 1.0,
        ];
        let normals = vec![
            0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0,
            0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0,
        ];
        let opt = optimize_mesh_with_attributes(&positions, &normals, 3, None, 0.0);
        assert_eq!(opt.num_points, 6);
        assert_eq!(opt.indices.len(), 6);
    }
}
