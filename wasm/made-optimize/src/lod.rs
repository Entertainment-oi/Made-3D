use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};

use crate::optimize::{deduplicate_positions, optimize_vertex_cache, optimize_vertex_fetch};

#[derive(Debug, Clone)]
pub struct SimplifiedMesh {
    pub num_points: usize,
    pub positions: Vec<f32>,
    pub indices: Vec<u32>,
    pub vertex_remap: Vec<u32>,
    pub max_error_reached: f32,
}

#[derive(Debug, Clone)]
pub struct MeshletsResult {
    pub meshlet_count: usize,
    /// `[cx, cy, cz, radius]` × `meshlet_count`
    pub bounds: Vec<f32>,
    /// `[axis_x, axis_y, axis_z, cone_cutoff]` × `meshlet_count`
    pub cones: Vec<f32>,
    /// `[first_index, index_count, vertex_offset, vertex_count]` × `meshlet_count`
    pub ranges: Vec<u32>,
    /// Índices globales ordenados por meshlet (`sum(index_count)`).
    pub indices: Vec<u32>,
}

#[derive(Clone, Copy, Debug)]
struct Quadric {
    m: [f64; 10], // a2, ab, ac, ad, b2, bc, bd, c2, cd, d2
}

impl Quadric {
    fn zero() -> Self {
        Self { m: [0.0; 10] }
    }

    fn from_plane(a: f64, b: f64, c: f64, d: f64, weight: f64) -> Self {
        Self {
            m: [
                a * a * weight,
                a * b * weight,
                a * c * weight,
                a * d * weight,
                b * b * weight,
                b * c * weight,
                b * d * weight,
                c * c * weight,
                c * d * weight,
                d * d * weight,
            ],
        }
    }

    fn add(self, o: Self) -> Self {
        let mut m = [0.0; 10];
        for i in 0..10 {
            m[i] = self.m[i] + o.m[i];
        }
        Self { m }
    }

    fn evaluate(&self, x: f64, y: f64, z: f64) -> f64 {
        let m = &self.m;
        let v = m[0] * x * x
            + 2.0 * m[1] * x * y
            + 2.0 * m[2] * x * z
            + 2.0 * m[3] * x
            + m[4] * y * y
            + 2.0 * m[5] * y * z
            + 2.0 * m[6] * y
            + m[7] * z * z
            + 2.0 * m[8] * z
            + m[9];
        v.max(0.0)
    }

    fn optimal_point(&self, p0: [f64; 3], p1: [f64; 3]) -> ([f64; 3], f64) {
        let m = &self.m;
        // Sistema 3x3 simétrico:
        // [ m0 m1 m2 ] [x]   [-m3]
        // [ m1 m4 m5 ] [y] = [-m6]
        // [ m2 m5 m7 ] [z]   [-m8]
        let a00 = m[0];
        let a01 = m[1];
        let a02 = m[2];
        let a11 = m[4];
        let a12 = m[5];
        let a22 = m[7];

        let c00 = a11 * a22 - a12 * a12;
        let c01 = a02 * a12 - a01 * a22;
        let c02 = a01 * a12 - a02 * a11;
        let det = a00 * c00 + a01 * c01 + a02 * c02;

        let mid = [
            0.5 * (p0[0] + p1[0]),
            0.5 * (p0[1] + p1[1]),
            0.5 * (p0[2] + p1[2]),
        ];
        let edge_len = ((p1[0] - p0[0]).powi(2)
            + (p1[1] - p0[1]).powi(2)
            + (p1[2] - p0[2]).powi(2))
        .sqrt();

        if det.abs() > 1e-12 {
            let b0 = -m[3];
            let b1 = -m[6];
            let b2 = -m[8];

            let c11 = a00 * a22 - a02 * a02;
            let c12 = a01 * a02 - a00 * a12;
            let c22 = a00 * a11 - a01 * a01;

            let inv_det = 1.0 / det;
            let x = (c00 * b0 + c01 * b1 + c02 * b2) * inv_det;
            let y = (c01 * b0 + c11 * b1 + c12 * b2) * inv_det;
            let z = (c02 * b0 + c12 * b1 + c22 * b2) * inv_det;

            if x.is_finite() && y.is_finite() && z.is_finite() {
                let d_mid = ((x - mid[0]).powi(2) + (y - mid[1]).powi(2) + (z - mid[2]).powi(2))
                    .sqrt();
                if d_mid <= edge_len.max(1e-4) * 1.5 {
                    let err = self.evaluate(x, y, z);
                    return ([x, y, z], err);
                }
            }
        }

        let e0 = self.evaluate(p0[0], p0[1], p0[2]);
        let e1 = self.evaluate(p1[0], p1[1], p1[2]);
        let em = self.evaluate(mid[0], mid[1], mid[2]);
        if em <= e0 && em <= e1 {
            (mid, em)
        } else if e0 <= e1 {
            (p0, e0)
        } else {
            (p1, e1)
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct CollapseCandidate {
    cost: f64,
    u: u32,
    v: u32,
    ver_u: u32,
    ver_v: u32,
}

impl PartialEq for CollapseCandidate {
    fn eq(&self, other: &Self) -> bool {
        self.cost == other.cost && self.u == other.u && self.v == other.v
    }
}
impl Eq for CollapseCandidate {}
impl PartialOrd for CollapseCandidate {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for CollapseCandidate {
    fn cmp(&self, other: &Self) -> Ordering {
        // Min-heap: menor costo primero
        other
            .cost
            .total_cmp(&self.cost)
            .then_with(|| other.u.cmp(&self.u))
            .then_with(|| other.v.cmp(&self.v))
    }
}

#[inline]
fn tri_normal(p0: [f64; 3], p1: [f64; 3], p2: [f64; 3]) -> Option<([f64; 3], f64)> {
    let e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    let e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
    let cx = e1[1] * e2[2] - e1[2] * e2[1];
    let cy = e1[2] * e2[0] - e1[0] * e2[2];
    let cz = e1[0] * e2[1] - e1[1] * e2[0];
    let len = (cx * cx + cy * cy + cz * cz).sqrt();
    if !len.is_finite() || len <= 1e-12 {
        return None;
    }
    Some(([cx / len, cy / len, cz / len], 0.5 * len))
}

/// Simplifica una malla mediante Quadric Error Metrics (QEM) preservando opcionalmente bordes abiertos.
/// Devuelve una malla compactada y optimizada para caché GPU (Forsyth + Vertex Fetch).
pub fn simplify_mesh_qem(
    positions: &[f32],
    indices: Option<&[u32]>,
    target_index_count: usize,
    max_error: f32,
    preserve_borders: bool,
) -> SimplifiedMesh {
    let raw_vcount = positions.len() / 3;
    if raw_vcount == 0 {
        return SimplifiedMesh {
            num_points: 0,
            positions: Vec::new(),
            indices: Vec::new(),
            vertex_remap: Vec::new(),
            max_error_reached: 0.0,
        };
    }

    // Soldar topológicamente por posición para que cubos/mallas con costuras UV no se abran al simplificar.
    let (vcount, welded_indices, weld_remap) = deduplicate_positions(positions, indices, 1e-6);
    let orig_tri_count = welded_indices.len() / 3;
    let target_tris = (target_index_count / 3).max(1);

    if orig_tri_count <= target_tris || vcount <= 3 {
        let out_pos: Vec<f32> = weld_remap
            .iter()
            .flat_map(|&orig| {
                let b = (orig as usize) * 3;
                [positions[b], positions[b + 1], positions[b + 2]]
            })
            .collect();
        return SimplifiedMesh {
            num_points: vcount,
            positions: out_pos,
            indices: welded_indices,
            vertex_remap: weld_remap,
            max_error_reached: 0.0,
        };
    }

    let mut pos: Vec<[f64; 3]> = Vec::with_capacity(vcount);
    for &orig in &weld_remap {
        let b = (orig as usize) * 3;
        pos.push([
            positions[b] as f64,
            positions[b + 1] as f64,
            positions[b + 2] as f64,
        ]);
    }

    let mut tri_verts: Vec<[u32; 3]> = Vec::with_capacity(orig_tri_count);
    let mut tri_alive: Vec<bool> = Vec::with_capacity(orig_tri_count);
    let mut vert_tris: Vec<Vec<u32>> = vec![Vec::new(); vcount];
    let mut quadrics: Vec<Quadric> = vec![Quadric::zero(); vcount];
    let mut edge_counts: HashMap<(u32, u32), (u32, [f64; 3])> =
        HashMap::with_capacity(orig_tri_count * 2);

    for t in 0..orig_tri_count {
        let i0 = welded_indices[t * 3];
        let i1 = welded_indices[t * 3 + 1];
        let i2 = welded_indices[t * 3 + 2];
        if i0 == i1 || i1 == i2 || i0 == i2 {
            continue;
        }
        let ti = tri_verts.len() as u32;
        tri_verts.push([i0, i1, i2]);
        tri_alive.push(true);
        vert_tris[i0 as usize].push(ti);
        vert_tris[i1 as usize].push(ti);
        vert_tris[i2 as usize].push(ti);

        if let Some((n, area)) = tri_normal(pos[i0 as usize], pos[i1 as usize], pos[i2 as usize]) {
            let p = pos[i0 as usize];
            let d = -(n[0] * p[0] + n[1] * p[1] + n[2] * p[2]);
            let q = Quadric::from_plane(n[0], n[1], n[2], d, area);
            quadrics[i0 as usize] = quadrics[i0 as usize].add(q);
            quadrics[i1 as usize] = quadrics[i1 as usize].add(q);
            quadrics[i2 as usize] = quadrics[i2 as usize].add(q);

            let pairs = [(i0, i1), (i1, i2), (i2, i0)];
            for &(a, b) in &pairs {
                let key = if a < b { (a, b) } else { (b, a) };
                edge_counts
                    .entry(key)
                    .and_modify(|e| e.0 += 1)
                    .or_insert((1, n));
            }
        }
    }

    if preserve_borders {
        for (&(u, v), &(cnt, n)) in &edge_counts {
            if cnt == 1 {
                let pu = pos[u as usize];
                let pv = pos[v as usize];
                let e = [pv[0] - pu[0], pv[1] - pu[1], pv[2] - pu[2]];
                let bx = e[1] * n[2] - e[2] * n[1];
                let by = e[2] * n[0] - e[0] * n[2];
                let bz = e[0] * n[1] - e[1] * n[0];
                let blen = (bx * bx + by * by + bz * bz).sqrt();
                if blen > 1e-12 {
                    let bn = [bx / blen, by / blen, bz / blen];
                    let d = -(bn[0] * pu[0] + bn[1] * pu[1] + bn[2] * pu[2]);
                    let edge_sq = e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
                    let qb = Quadric::from_plane(bn[0], bn[1], bn[2], d, edge_sq.max(1e-6) * 100.0);
                    quadrics[u as usize] = quadrics[u as usize].add(qb);
                    quadrics[v as usize] = quadrics[v as usize].add(qb);
                }
            }
        }
    }

    let mut vert_alive = vec![true; vcount];
    let mut vert_version = vec![0u32; vcount];
    let mut heap: BinaryHeap<CollapseCandidate> = BinaryHeap::with_capacity(edge_counts.len());

    for &(u, v) in edge_counts.keys() {
        let q = quadrics[u as usize].add(quadrics[v as usize]);
        let (_, cost) = q.optimal_point(pos[u as usize], pos[v as usize]);
        heap.push(CollapseCandidate {
            cost,
            u,
            v,
            ver_u: 0,
            ver_v: 0,
        });
    }

    let mut active_tris = tri_verts.len();
    let max_err_f64 = if max_error > 0.0 {
        max_error as f64
    } else {
        f64::INFINITY
    };
    let mut max_error_reached = 0.0f64;

    let mut combined_tris: Vec<u32> = Vec::with_capacity(32);
    let mut neighbors: Vec<u32> = Vec::with_capacity(32);

    while active_tris > target_tris {
        let Some(cand) = heap.pop() else {
            break;
        };
        if cand.cost > max_err_f64 {
            break;
        }
        let u = cand.u as usize;
        let v = cand.v as usize;
        if !vert_alive[u]
            || !vert_alive[v]
            || u == v
            || vert_version[u] != cand.ver_u
            || vert_version[v] != cand.ver_v
        {
            continue;
        }

        let q_sum = quadrics[u].add(quadrics[v]);
        let (p_new, _) = q_sum.optimal_point(pos[u], pos[v]);

        // Reunir triángulos vivos incidentes en u o v sin duplicar
        combined_tris.clear();
        for &t in &vert_tris[u] {
            if tri_alive[t as usize] && !combined_tris.contains(&t) {
                combined_tris.push(t);
            }
        }
        for &t in &vert_tris[v] {
            if tri_alive[t as usize] && !combined_tris.contains(&t) {
                combined_tris.push(t);
            }
        }

        // Comprobar inversión de normales en triángulos no compartidos
        let mut flips = false;
        let mut collapsed_shared = 0usize;
        for &t in &combined_tris {
            let tv = tri_verts[t as usize];
            let has_u = tv[0] == cand.u || tv[1] == cand.u || tv[2] == cand.u;
            let has_v = tv[0] == cand.v || tv[1] == cand.v || tv[2] == cand.v;
            if has_u && has_v {
                collapsed_shared += 1;
                continue;
            }
            let old_n = tri_normal(pos[tv[0] as usize], pos[tv[1] as usize], pos[tv[2] as usize]);
            let np0 = if tv[0] == cand.u || tv[0] == cand.v { p_new } else { pos[tv[0] as usize] };
            let np1 = if tv[1] == cand.u || tv[1] == cand.v { p_new } else { pos[tv[1] as usize] };
            let np2 = if tv[2] == cand.u || tv[2] == cand.v { p_new } else { pos[tv[2] as usize] };
            let new_n = tri_normal(np0, np1, np2);
            match (old_n, new_n) {
                (Some((on, _)), Some((nn, _))) => {
                    let dot = on[0] * nn[0] + on[1] * nn[1] + on[2] * nn[2];
                    if dot < 0.2 {
                        flips = true;
                        break;
                    }
                }
                _ => {
                    flips = true;
                    break;
                }
            }
        }
        if flips || collapsed_shared == 0 {
            continue;
        }

        // Ejecutar colapso v -> u
        pos[u] = p_new;
        quadrics[u] = q_sum;
        vert_alive[v] = false;
        vert_version[u] = vert_version[u].wrapping_add(1);
        if cand.cost > max_error_reached {
            max_error_reached = cand.cost;
        }

        vert_tris[u].clear();
        neighbors.clear();

        for &t in &combined_tris {
            let ti = t as usize;
            let tv = &mut tri_verts[ti];
            let has_u = tv[0] == cand.u || tv[1] == cand.u || tv[2] == cand.u;
            let has_v = tv[0] == cand.v || tv[1] == cand.v || tv[2] == cand.v;
            if has_u && has_v {
                tri_alive[ti] = false;
                active_tris -= 1;
                continue;
            }
            if has_v {
                for slot in tv.iter_mut() {
                    if *slot == cand.v {
                        *slot = cand.u;
                    }
                }
            }
            if tv[0] == tv[1] || tv[1] == tv[2] || tv[0] == tv[2] {
                tri_alive[ti] = false;
                active_tris -= 1;
                continue;
            }
            vert_tris[u].push(t);
            for &w in tv.iter() {
                if w != cand.u && vert_alive[w as usize] && !neighbors.contains(&w) {
                    neighbors.push(w);
                }
            }
        }
        vert_tris[v].clear();

        for &w in &neighbors {
            let (eu, ev) = if cand.u < w { (cand.u, w) } else { (w, cand.u) };
            let q = quadrics[eu as usize].add(quadrics[ev as usize]);
            let (_, cost) = q.optimal_point(pos[eu as usize], pos[ev as usize]);
            heap.push(CollapseCandidate {
                cost,
                u: eu,
                v: ev,
                ver_u: vert_version[eu as usize],
                ver_v: vert_version[ev as usize],
            });
        }
    }

    // Compactar vértices vivos e índices vivos
    let mut new_id = vec![u32::MAX; vcount];
    let mut compact_pos: Vec<f32> = Vec::with_capacity(vcount * 3);
    let mut compact_remap: Vec<u32> = Vec::with_capacity(vcount);
    let mut compact_indices: Vec<u32> = Vec::with_capacity(active_tris * 3);

    for (ti, alive) in tri_alive.iter().enumerate() {
        if !*alive {
            continue;
        }
        for &vid in &tri_verts[ti] {
            let mut dst = new_id[vid as usize];
            if dst == u32::MAX {
                dst = compact_remap.len() as u32;
                new_id[vid as usize] = dst;
                compact_remap.push(weld_remap[vid as usize]);
                let p = pos[vid as usize];
                compact_pos.push(p[0] as f32);
                compact_pos.push(p[1] as f32);
                compact_pos.push(p[2] as f32);
            }
            compact_indices.push(dst);
        }
    }

    let out_vcount = compact_remap.len();
    let vcache = optimize_vertex_cache(&compact_indices, out_vcount);
    let (final_indices, fetch_remap) = optimize_vertex_fetch(&vcache, out_vcount);

    let mut final_positions = Vec::with_capacity(fetch_remap.len() * 3);
    let mut final_remap = Vec::with_capacity(fetch_remap.len());
    for &mid in &fetch_remap {
        let m = mid as usize;
        final_remap.push(compact_remap[m]);
        final_positions.push(compact_pos[m * 3]);
        final_positions.push(compact_pos[m * 3 + 1]);
        final_positions.push(compact_pos[m * 3 + 2]);
    }

    SimplifiedMesh {
        num_points: final_remap.len(),
        positions: final_positions,
        indices: final_indices,
        vertex_remap: final_remap,
        max_error_reached: max_error_reached.sqrt() as f32,
    }
}

/// Divide una malla indexada en clusters / meshlets compactos con esfera envolvente y cono de normales
/// para culling en GPU (`WebGPU` compute / `drawIndexedIndirect`) o BVH en WASM.
pub fn build_meshlets(
    positions: &[f32],
    indices: Option<&[u32]>,
    max_vertices: usize,
    max_triangles: usize,
) -> MeshletsResult {
    let vcount = positions.len() / 3;
    if vcount == 0 {
        return MeshletsResult {
            meshlet_count: 0,
            bounds: Vec::new(),
            cones: Vec::new(),
            ranges: Vec::new(),
            indices: Vec::new(),
        };
    }

    let owned_indices: Vec<u32>;
    let src_indices: &[u32] = match indices {
        Some(idx) => idx,
        None => {
            owned_indices = (0..vcount as u32).collect();
            &owned_indices
        }
    };

    let tri_count = src_indices.len() / 3;
    if tri_count == 0 {
        return MeshletsResult {
            meshlet_count: 0,
            bounds: Vec::new(),
            cones: Vec::new(),
            ranges: Vec::new(),
            indices: Vec::new(),
        };
    }

    let max_v = max_vertices.clamp(3, 256);
    let max_t = max_triangles.clamp(1, 256);

    // Adyacencia vértice -> triángulos
    let mut vert_tris: Vec<Vec<u32>> = vec![Vec::new(); vcount];
    for t in 0..tri_count {
        for k in 0..3 {
            let v = src_indices[t * 3 + k] as usize;
            if v < vcount {
                vert_tris[v].push(t as u32);
            }
        }
    }

    let mut tri_used = vec![false; tri_count];
    let mut vert_stamp = vec![0u32; vcount];
    let mut cur_stamp = 1u32;

    let mut bounds = Vec::new();
    let mut cones = Vec::new();
    let mut ranges = Vec::new();
    let mut out_indices = Vec::with_capacity(src_indices.len());

    let mut cluster_verts: Vec<u32> = Vec::with_capacity(max_v);
    let mut cluster_tris: Vec<u32> = Vec::with_capacity(max_t);
    let mut seed_cursor = 0usize;

    loop {
        while seed_cursor < tri_count && tri_used[seed_cursor] {
            seed_cursor += 1;
        }
        if seed_cursor >= tri_count {
            break;
        }

        cur_stamp = cur_stamp.wrapping_add(1);
        if cur_stamp == 0 {
            vert_stamp.fill(0);
            cur_stamp = 1;
        }
        cluster_verts.clear();
        cluster_tris.clear();

        // Iniciar cluster con el triángulo semilla
        let mut current = seed_cursor as u32;
        loop {
            let ti = current as usize;
            tri_used[ti] = true;
            cluster_tris.push(current);

            for k in 0..3 {
                let v = src_indices[ti * 3 + k];
                if (v as usize) < vcount && vert_stamp[v as usize] != cur_stamp {
                    vert_stamp[v as usize] = cur_stamp;
                    cluster_verts.push(v);
                }
            }

            if cluster_tris.len() >= max_t {
                break;
            }

            // Buscar siguiente triángulo adyacente que agregue menos vértices nuevos
            let mut best_tri: Option<u32> = None;
            let mut best_added = usize::MAX;
            for &v in &cluster_verts {
                for &cand in &vert_tris[v as usize] {
                    if tri_used[cand as usize] {
                        continue;
                    }
                    let mut added = 0usize;
                    let cb = (cand as usize) * 3;
                    for k in 0..3 {
                        let cv = src_indices[cb + k] as usize;
                        if cv < vcount && vert_stamp[cv] != cur_stamp {
                            added += 1;
                        }
                    }
                    if cluster_verts.len() + added <= max_v && added < best_added {
                        best_added = added;
                        best_tri = Some(cand);
                        if added == 0 {
                            break;
                        }
                    }
                }
                if best_added == 0 {
                    break;
                }
            }

            match best_tri {
                Some(next) => current = next,
                None => break,
            }
        }

        // Emitir meshlet: esfera envolvente + cono de normales
        let first_index = out_indices.len() as u32;
        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        for &v in &cluster_verts {
            let b = (v as usize) * 3;
            for a in 0..3 {
                let val = positions[b + a];
                if val < min[a] { min[a] = val; }
                if val > max[a] { max[a] = val; }
            }
        }
        let cx = 0.5 * (min[0] + max[0]);
        let cy = 0.5 * (min[1] + max[1]);
        let cz = 0.5 * (min[2] + max[2]);
        let mut radius_sq = 0.0f32;
        for &v in &cluster_verts {
            let b = (v as usize) * 3;
            let dx = positions[b] - cx;
            let dy = positions[b + 1] - cy;
            let dz = positions[b + 2] - cz;
            let d2 = dx * dx + dy * dy + dz * dz;
            if d2 > radius_sq {
                radius_sq = d2;
            }
        }

        let mut avg_n = [0.0f64; 3];
        let mut tri_normals: Vec<[f64; 3]> = Vec::with_capacity(cluster_tris.len());
        for &t in &cluster_tris {
            let tb = (t as usize) * 3;
            let i0 = src_indices[tb];
            let i1 = src_indices[tb + 1];
            let i2 = src_indices[tb + 2];
            out_indices.push(i0);
            out_indices.push(i1);
            out_indices.push(i2);

            if (i0 as usize) < vcount && (i1 as usize) < vcount && (i2 as usize) < vcount {
                let p0 = [positions[i0 as usize * 3] as f64, positions[i0 as usize * 3 + 1] as f64, positions[i0 as usize * 3 + 2] as f64];
                let p1 = [positions[i1 as usize * 3] as f64, positions[i1 as usize * 3 + 1] as f64, positions[i1 as usize * 3 + 2] as f64];
                let p2 = [positions[i2 as usize * 3] as f64, positions[i2 as usize * 3 + 1] as f64, positions[i2 as usize * 3 + 2] as f64];
                if let Some((n, _)) = tri_normal(p0, p1, p2) {
                    avg_n[0] += n[0];
                    avg_n[1] += n[1];
                    avg_n[2] += n[2];
                    tri_normals.push(n);
                }
            }
        }

        let nlen = (avg_n[0] * avg_n[0] + avg_n[1] * avg_n[1] + avg_n[2] * avg_n[2]).sqrt();
        let (ax, ay, az, cutoff) = if nlen > 1e-9 && !tri_normals.is_empty() {
            let axis = [avg_n[0] / nlen, avg_n[1] / nlen, avg_n[2] / nlen];
            let mut min_dot = 1.0f64;
            for tn in &tri_normals {
                let dot = tn[0] * axis[0] + tn[1] * axis[1] + tn[2] * axis[2];
                if dot < min_dot {
                    min_dot = dot;
                }
            }
            let c = if min_dot <= 0.1 {
                -1.0f32 // Cono muy abierto: no apto para backface culling por cluster
            } else {
                // sin(acos(min_dot)) = sqrt(1 - min_dot^2)
                (1.0 - min_dot * min_dot).max(0.0).sqrt() as f32
            };
            (axis[0] as f32, axis[1] as f32, axis[2] as f32, c)
        } else {
            (0.0, 1.0, 0.0, -1.0)
        };

        let idx_count = (cluster_tris.len() * 3) as u32;
        bounds.extend_from_slice(&[cx, cy, cz, radius_sq.sqrt()]);
        cones.extend_from_slice(&[ax, ay, az, cutoff]);
        ranges.extend_from_slice(&[first_index, idx_count, 0, cluster_verts.len() as u32]);
    }

    let meshlet_count = ranges.len() / 4;
    MeshletsResult {
        meshlet_count,
        bounds,
        cones,
        ranges,
        indices: out_indices,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_uv_grid(nx: usize, nz: usize) -> (Vec<f32>, Vec<u32>) {
        let mut pos = Vec::new();
        let mut idx = Vec::new();
        for z in 0..=nz {
            for x in 0..=nx {
                let fx = x as f32 / nx as f32 * 4.0 - 2.0;
                let fz = z as f32 / nz as f32 * 4.0 - 2.0;
                let fy = (fx * 1.2).sin() * 0.25;
                pos.extend_from_slice(&[fx, fy, fz]);
            }
        }
        let stride = nx + 1;
        for z in 0..nz {
            for x in 0..nx {
                let a = (z * stride + x) as u32;
                let b = a + 1;
                let c = a + stride as u32;
                let d = c + 1;
                idx.extend_from_slice(&[a, c, b, b, c, d]);
            }
        }
        (pos, idx)
    }

    #[test]
    fn qem_simplifies_grid_preserving_shape() {
        let (pos, idx) = make_uv_grid(12, 12);
        let orig_tris = idx.len() / 3; // 288
        let lod = simplify_mesh_qem(&pos, Some(&idx), 120 * 3, 0.0, true);
        let new_tris = lod.indices.len() / 3;
        assert!(new_tris <= 125 && new_tris >= 80, "new_tris={new_tris}, orig={orig_tris}");
        assert!(lod.num_points < pos.len() / 3);
        assert_eq!(lod.vertex_remap.len(), lod.num_points);
    }

    #[test]
    fn meshlets_partition_grid_cleanly() {
        let (pos, idx) = make_uv_grid(16, 16); // 512 triángulos
        let m = build_meshlets(&pos, Some(&idx), 64, 64);
        assert!(m.meshlet_count >= 8);
        assert_eq!(m.indices.len(), idx.len());
        assert_eq!(m.bounds.len(), m.meshlet_count * 4);
        assert_eq!(m.cones.len(), m.meshlet_count * 4);
        assert_eq!(m.ranges.len(), m.meshlet_count * 4);
        for i in 0..m.meshlet_count {
            assert!(m.bounds[i * 4 + 3] > 0.0);
            assert!(m.ranges[i * 4 + 1] <= 64 * 3);
        }
    }
}
