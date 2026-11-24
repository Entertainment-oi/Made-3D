/// BVH + Frustum Culling + Selección de LOD en memoria lineal para escenas y chunks masivos.
///
/// Diseñado para cero asignaciones por cuadro durante consultas (`query_frustum`),
/// con construcción rápida sobre esferas envolventes `[cx, cy, cz, radius]`.

#[derive(Debug, Clone, Copy)]
pub struct BvhNode {
    pub min: [f32; 3],
    pub max: [f32; 3],
    /// Si `count > 0`: índice inicial en `item_order`. Si `count == 0`: índice del hijo izquierdo.
    pub left_or_first: u32,
    /// Si `count == 0`: índice del hijo derecho.
    pub right: u32,
    /// Número de elementos en hoja (`> 0`), o `0` si es nodo interno.
    pub count: u32,
}

#[derive(Debug, Clone)]
pub struct SceneBvh {
    /// Esferas originales `[cx, cy, cz, r]` × `item_count` (indexadas por `item_id`).
    pub spheres: Vec<f32>,
    pub item_count: usize,
    /// Permutación de IDs de ítems agrupados por hojas del BVH.
    pub item_order: Vec<u32>,
    /// Posición inversa `item_id -> slot en item_order` (útil para refit/update rápido).
    pub nodes: Vec<BvhNode>,
    /// Buffers reutilizables de salida (sin re-alocar cada frame).
    pub visible_indices: Vec<u32>,
    pub visible_lods: Vec<u32>,
    query_stack: Vec<u32>,
}

const LEAF_MAX_ITEMS: usize = 4;

impl SceneBvh {
    pub fn empty() -> Self {
        Self {
            spheres: Vec::new(),
            item_count: 0,
            item_order: Vec::new(),
            nodes: Vec::new(),
            visible_indices: Vec::new(),
            visible_lods: Vec::new(),
            query_stack: Vec::with_capacity(64),
        }
    }

    pub fn from_spheres(spheres_slice: &[f32], item_count: usize) -> Self {
        let count = item_count.min(spheres_slice.len() / 4);
        let mut bvh = Self {
            spheres: spheres_slice[..count * 4].to_vec(),
            item_count: count,
            item_order: (0..count as u32).collect(),
            nodes: Vec::with_capacity(count.saturating_mul(2).max(1)),
            visible_indices: Vec::with_capacity(count.min(1024)),
            visible_lods: Vec::with_capacity(count.min(1024)),
            query_stack: Vec::with_capacity(64),
        };
        if count > 0 {
            bvh.build_tree();
        }
        bvh
    }

    pub fn rebuild(&mut self, spheres_slice: &[f32], item_count: usize) {
        let count = item_count.min(spheres_slice.len() / 4);
        self.spheres.clear();
        self.spheres.extend_from_slice(&spheres_slice[..count * 4]);
        self.item_count = count;
        self.item_order.clear();
        self.item_order.extend(0..count as u32);
        self.nodes.clear();
        self.visible_indices.clear();
        self.visible_lods.clear();
        if count > 0 {
            self.build_tree();
        }
    }

    pub fn update_item(&mut self, index: usize, cx: f32, cy: f32, cz: f32, radius: f32) -> bool {
        if index >= self.item_count {
            return false;
        }
        let base = index * 4;
        self.spheres[base] = cx;
        self.spheres[base + 1] = cy;
        self.spheres[base + 2] = cz;
        self.spheres[base + 3] = radius.max(0.0);
        true
    }

    /// Recalcula los AABB de todo el árbol de abajo hacia arriba (`O(N)`) tras mover ítems
    /// sin reconstruir la topología.
    pub fn refit(&mut self) {
        if self.nodes.is_empty() {
            return;
        }
        // Como el árbol se construye en pre-orden, los hijos siempre tienen índice > padre.
        // Recorriendo en orden inverso garantizamos que ambos hijos ya están actualizados.
        for i in (0..self.nodes.len()).rev() {
            let node = self.nodes[i];
            if node.count > 0 {
                let first = node.left_or_first as usize;
                let end = first + node.count as usize;
                let (min, max) = self.compute_range_bounds(first, end);
                self.nodes[i].min = min;
                self.nodes[i].max = max;
            } else {
                let l = self.nodes[node.left_or_first as usize];
                let r = self.nodes[node.right as usize];
                self.nodes[i].min = [
                    l.min[0].min(r.min[0]),
                    l.min[1].min(r.min[1]),
                    l.min[2].min(r.min[2]),
                ];
                self.nodes[i].max = [
                    l.max[0].max(r.max[0]),
                    l.max[1].max(r.max[1]),
                    l.max[2].max(r.max[2]),
                ];
            }
        }
    }

    fn compute_range_bounds(&self, start: usize, end: usize) -> ([f32; 3], [f32; 3]) {
        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        for slot in start..end {
            let id = self.item_order[slot] as usize;
            let b = id * 4;
            let cx = self.spheres[b];
            let cy = self.spheres[b + 1];
            let cz = self.spheres[b + 2];
            let r = self.spheres[b + 3].max(0.0);
            if !cx.is_finite() || !cy.is_finite() || !cz.is_finite() || !r.is_finite() {
                continue;
            }
            if cx - r < min[0] { min[0] = cx - r; }
            if cy - r < min[1] { min[1] = cy - r; }
            if cz - r < min[2] { min[2] = cz - r; }
            if cx + r > max[0] { max[0] = cx + r; }
            if cy + r > max[1] { max[1] = cy + r; }
            if cz + r > max[2] { max[2] = cz + r; }
        }
        if !min[0].is_finite() {
            return ([0.0; 3], [0.0; 3]);
        }
        (min, max)
    }

    fn build_tree(&mut self) {
        self.nodes.clear();
        self.nodes.push(BvhNode {
            min: [0.0; 3],
            max: [0.0; 3],
            left_or_first: 0,
            right: 0,
            count: 0,
        });
        self.subdivide(0, 0, self.item_count);
    }

    fn subdivide(&mut self, node_idx: usize, start: usize, end: usize) {
        let (min, max) = self.compute_range_bounds(start, end);
        let count = end - start;
        if count <= LEAF_MAX_ITEMS {
            self.nodes[node_idx] = BvhNode {
                min,
                max,
                left_or_first: start as u32,
                right: 0,
                count: count as u32,
            };
            return;
        }

        // Centroide AABB para escoger el eje de mayor dispersión.
        let mut cmin = [f32::INFINITY; 3];
        let mut cmax = [f32::NEG_INFINITY; 3];
        for slot in start..end {
            let b = (self.item_order[slot] as usize) * 4;
            for axis in 0..3 {
                let c = self.spheres[b + axis];
                if c.is_finite() {
                    if c < cmin[axis] { cmin[axis] = c; }
                    if c > cmax[axis] { cmax[axis] = c; }
                }
            }
        }
        let ex = cmax[0] - cmin[0];
        let ey = cmax[1] - cmin[1];
        let ez = cmax[2] - cmin[2];
        let axis = if ex >= ey && ex >= ez {
            0
        } else if ey >= ez {
            1
        } else {
            2
        };

        let mid = start + count / 2;
        if (cmax[axis] - cmin[axis]) > 1e-7 {
            let spheres = &self.spheres;
            self.item_order[start..end].select_nth_unstable_by(mid - start, |&a, &b| {
                let ca = spheres[(a as usize) * 4 + axis];
                let cb = spheres[(b as usize) * 4 + axis];
                ca.total_cmp(&cb)
            });
        }

        let left_idx = self.nodes.len() as u32;
        self.nodes.push(BvhNode {
            min: [0.0; 3],
            max: [0.0; 3],
            left_or_first: 0,
            right: 0,
            count: 0,
        });
        self.subdivide(left_idx as usize, start, mid);

        let right_idx = self.nodes.len() as u32;
        self.nodes.push(BvhNode {
            min: [0.0; 3],
            max: [0.0; 3],
            left_or_first: 0,
            right: 0,
            count: 0,
        });
        self.subdivide(right_idx as usize, mid, end);

        self.nodes[node_idx] = BvhNode {
            min,
            max,
            left_or_first: left_idx,
            right: right_idx,
            count: 0,
        };
    }

    /// Ejecuta Frustum Culling sobre el BVH y calcula el nivel LOD de cada ítem visible.
    ///
    /// - `planes`: 6 planos normalizados `[nx, ny, nz, d]` × 6 (24 floats), mismo formato que `Frustum.js`.
    /// - `cam_pos`: posición mundial `[x, y, z]` de la cámara.
    /// - `lod_thresholds`: distancias ascendentes (ej. `[0.0, 80.0, 200.0]`).
    ///
    /// Devuelve la cantidad de ítems visibles; sus IDs quedan en `visible_indices` y su LOD en `visible_lods`.
    pub fn query_frustum(
        &mut self,
        planes: &[f32],
        cam_pos: [f32; 3],
        lod_thresholds: &[f32],
    ) -> usize {
        self.visible_indices.clear();
        self.visible_lods.clear();
        if self.nodes.is_empty() || planes.len() < 24 {
            return 0;
        }

        self.query_stack.clear();
        self.query_stack.push(0);

        let last_lod = lod_thresholds.len().saturating_sub(1);

        while let Some(node_idx) = self.query_stack.pop() {
            let node = self.nodes[node_idx as usize];
            if !aabb_intersects_frustum(&node.min, &node.max, planes) {
                continue;
            }

            if node.count > 0 {
                let first = node.left_or_first as usize;
                let end = first + node.count as usize;
                for slot in first..end {
                    let id = self.item_order[slot];
                    let b = (id as usize) * 4;
                    let cx = self.spheres[b];
                    let cy = self.spheres[b + 1];
                    let cz = self.spheres[b + 2];
                    let r = self.spheres[b + 3].max(0.0);

                    if !sphere_intersects_frustum(cx, cy, cz, r, planes) {
                        continue;
                    }

                    let lod = if lod_thresholds.is_empty() {
                        0
                    } else {
                        let dx = cx - cam_pos[0];
                        let dy = cy - cam_pos[1];
                        let dz = cz - cam_pos[2];
                        let dist = ((dx * dx + dy * dy + dz * dz).sqrt() - r).max(0.0);
                        let mut k = 0usize;
                        for lvl in (1..=last_lod).rev() {
                            if dist >= lod_thresholds[lvl] {
                                k = lvl;
                                break;
                            }
                        }
                        k as u32
                    };

                    self.visible_indices.push(id);
                    self.visible_lods.push(lod);
                }
            } else {
                self.query_stack.push(node.right);
                self.query_stack.push(node.left_or_first);
            }
        }

        self.visible_indices.len()
    }
}

#[inline]
fn aabb_intersects_frustum(min: &[f32; 3], max: &[f32; 3], planes: &[f32]) -> bool {
    for p in 0..6 {
        let o = p * 4;
        let nx = planes[o];
        let ny = planes[o + 1];
        let nz = planes[o + 2];
        let d = planes[o + 3];
        // Vértice más positivo (p-vertex) respecto a la normal del plano
        let px = if nx >= 0.0 { max[0] } else { min[0] };
        let py = if ny >= 0.0 { max[1] } else { min[1] };
        let pz = if nz >= 0.0 { max[2] } else { min[2] };
        if nx * px + ny * py + nz * pz + d < 0.0 {
            return false;
        }
    }
    true
}

#[inline]
fn sphere_intersects_frustum(cx: f32, cy: f32, cz: f32, r: f32, planes: &[f32]) -> bool {
    for p in 0..6 {
        let o = p * 4;
        let dist = planes[o] * cx + planes[o + 1] * cy + planes[o + 2] * cz + planes[o + 3];
        if dist < -r {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frustum_box_planes(half_x: f32, half_y: f32, near: f32, far: f32) -> [f32; 24] {
        // Frustum ortográfico centrado mirando hacia -Z desde el origen:
        // x in [-half_x, half_x], y in [-half_y, half_y], z in [-far, -near]
        [
            1.0, 0.0, 0.0, half_x,   // left: x >= -half_x
            -1.0, 0.0, 0.0, half_x,  // right: x <= half_x
            0.0, 1.0, 0.0, half_y,   // bottom
            0.0, -1.0, 0.0, half_y,  // top
            0.0, 0.0, -1.0, -near,   // near: z <= -near
            0.0, 0.0, 1.0, far,      // far: z >= -far
        ]
    }

    #[test]
    fn bvh_frustum_culls_and_selects_lod() {
        // 500 ítems distribuidos en profundidad -Z
        let mut spheres = Vec::new();
        for i in 0..500 {
            let x = ((i % 20) as f32 - 10.0) * 5.0;
            let y = 0.0;
            let z = -(i as f32) * 1.5 - 5.0;
            spheres.extend_from_slice(&[x, y, z, 1.0]);
        }

        let mut bvh = SceneBvh::from_spheres(&spheres, 500);
        let planes = frustum_box_planes(12.0, 12.0, 1.0, 120.0);
        let thresholds = [0.0f32, 40.0, 90.0];
        let count = bvh.query_frustum(&planes, [0.0, 0.0, 0.0], &thresholds);

        assert!(count > 0 && count < 500);

        // Validar exactamente contra fuerza bruta
        let mut brute = Vec::new();
        for i in 0..500 {
            let b = i * 4;
            if sphere_intersects_frustum(spheres[b], spheres[b + 1], spheres[b + 2], spheres[b + 3], &planes) {
                brute.push(i as u32);
            }
        }
        let mut got = bvh.visible_indices.clone();
        got.sort();
        assert_eq!(got, brute);

        // Comprobar LODs asignados
        for idx in 0..count {
            let id = bvh.visible_indices[idx] as usize;
            let lod = bvh.visible_lods[idx];
            let cz = spheres[id * 4 + 2];
            if cz > -30.0 {
                assert_eq!(lod, 0);
            }
            if cz < -100.0 {
                assert_eq!(lod, 2);
            }
        }
    }

    #[test]
    fn bvh_refit_updates_bounds() {
        let spheres = vec![
            0.0, 0.0, -10.0, 1.0,
            2.0, 0.0, -10.0, 1.0,
            4.0, 0.0, -10.0, 1.0,
            6.0, 0.0, -10.0, 1.0,
            8.0, 0.0, -10.0, 1.0,
        ];
        let mut bvh = SceneBvh::from_spheres(&spheres, 5);
        let planes = frustum_box_planes(5.0, 5.0, 1.0, 50.0);
        assert_eq!(bvh.query_frustum(&planes, [0.0, 0.0, 0.0], &[]), 3);

        // Mover ítem 4 al centro del frustum
        assert!(bvh.update_item(4, 0.0, 0.0, -12.0, 1.0));
        bvh.refit();
        assert_eq!(bvh.query_frustum(&planes, [0.0, 0.0, 0.0], &[]), 4);
    }
}
