pub const INVALID_CORNER: i32 = -1;
pub const INVALID_VERTEX: i32 = -1;

/// Tabla topológica de esquinas (CornerTable) para navegación de mallas triangulares.
#[derive(Debug, Clone)]
pub struct CornerTable {
    pub corner_to_vertex: Vec<i32>,
    pub opposite_corners: Vec<i32>,
    pub vertex_corners: Vec<i32>,
    pub num_vertices: usize,
    pub num_faces: usize,
}

impl CornerTable {
    pub fn with_capacity(num_faces: usize, num_vertices: usize) -> Self {
        Self {
            corner_to_vertex: vec![INVALID_VERTEX; num_faces * 3],
            opposite_corners: vec![INVALID_CORNER; num_faces * 3],
            vertex_corners: vec![INVALID_CORNER; num_vertices],
            num_vertices,
            num_faces,
        }
    }

    #[inline]
    pub fn next(corner: i32) -> i32 {
        if corner < 0 {
            return INVALID_CORNER;
        }
        let local = corner % 3;
        if local == 2 {
            corner - 2
        } else {
            corner + 1
        }
    }

    #[inline]
    pub fn previous(corner: i32) -> i32 {
        if corner < 0 {
            return INVALID_CORNER;
        }
        let local = corner % 3;
        if local == 0 {
            corner + 2
        } else {
            corner - 1
        }
    }

    #[inline]
    pub fn opposite(&self, corner: i32) -> i32 {
        if corner < 0 || (corner as usize) >= self.opposite_corners.len() {
            INVALID_CORNER
        } else {
            self.opposite_corners[corner as usize]
        }
    }

    #[inline]
    pub fn vertex(&self, corner: i32) -> i32 {
        if corner < 0 || (corner as usize) >= self.corner_to_vertex.len() {
            INVALID_VERTEX
        } else {
            self.corner_to_vertex[corner as usize]
        }
    }

    #[inline]
    pub fn set_opposite(&mut self, c0: i32, c1: i32) {
        if c0 >= 0 && (c0 as usize) < self.opposite_corners.len() {
            self.opposite_corners[c0 as usize] = c1;
        }
        if c1 >= 0 && (c1 as usize) < self.opposite_corners.len() {
            self.opposite_corners[c1 as usize] = c0;
        }
    }

    #[inline]
    pub fn swing_left(&self, corner: i32) -> i32 {
        let prev = Self::previous(corner);
        let opp = self.opposite(prev);
        if opp < 0 {
            INVALID_CORNER
        } else {
            Self::previous(opp)
        }
    }

    pub fn compute_opposites_from_faces(&mut self) {
        self.opposite_corners.fill(INVALID_CORNER);
        if self.vertex_corners.len() < self.num_vertices {
            self.vertex_corners.resize(self.num_vertices, INVALID_CORNER);
        }
        self.vertex_corners.fill(INVALID_CORNER);

        let num_corners = self.num_faces * 3;
        let mut edges: Vec<((i32, i32), i32)> = Vec::with_capacity(num_corners);

        for c in 0..num_corners {
            let v = self.corner_to_vertex[c];
            if v >= 0 && (v as usize) < self.vertex_corners.len() {
                self.vertex_corners[v as usize] = c as i32;
            }
            let c_next = Self::next(c as i32) as usize;
            let c_prev = Self::previous(c as i32) as usize;
            let va = self.corner_to_vertex[c_next];
            let vb = self.corner_to_vertex[c_prev];
            if va >= 0 && vb >= 0 {
                edges.push(((va, vb), c as i32));
            }
        }

        edges.sort_unstable_by(|a, b| a.0.cmp(&b.0));

        for &((va, vb), c) in &edges {
            if self.opposite_corners[c as usize] != INVALID_CORNER {
                continue;
            }
            if let Ok(idx) = edges.binary_search_by(|probe| probe.0.cmp(&(vb, va))) {
                let opp = edges[idx].1;
                if opp != c && self.opposite_corners[opp as usize] == INVALID_CORNER {
                    self.opposite_corners[c as usize] = opp;
                    self.opposite_corners[opp as usize] = c;
                }
            }
        }
    }

    pub fn to_triangle_indices(&self) -> Vec<u32> {
        self.corner_to_vertex[..self.num_faces * 3]
            .iter()
            .map(|&v| v.max(0) as u32)
            .collect()
    }
}
