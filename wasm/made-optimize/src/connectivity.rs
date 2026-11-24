use crate::bitstream::{ByteReader, ByteWriter};
use crate::corner_table::{CornerTable, INVALID_CORNER};
use crate::error::{OptimizeError, Result};
use crate::rans::{decode_symbols_exact, encode_symbols, AdaptiveRAnsBitDecoder, RAnsBitDecoder};

#[derive(Debug, Clone)]
pub struct DecodedConnectivity {
    pub num_points: usize,
    pub num_faces: usize,
    pub indices: Vec<u32>,
    pub corner_table: Option<CornerTable>,
    pub vertex_to_point_map: Vec<u32>,
}

#[inline]
fn encode_seq_index_delta(delta: i32) -> u32 {
    if delta >= 0 {
        (delta as u32) << 1
    } else {
        (delta.unsigned_abs() << 1) | 1
    }
}

#[inline]
fn decode_seq_index_delta(sym: u32) -> i32 {
    let mag = (sym >> 1) as i32;
    if (sym & 1) != 0 {
        -mag
    } else {
        mag
    }
}

/// Codifica conectividad secuencial comprimida (delta + sign-bit Draco + rANS).
pub fn encode_sequential_connectivity(
    indices: &[u32],
    num_points: usize,
    writer: &mut ByteWriter,
) {
    let num_faces = indices.len() / 3;
    writer.write_varint_u32(num_faces as u32);
    writer.write_varint_u32(num_points as u32);
    writer.write_u8(0); // método 0 = comprimido

    let mut syms = Vec::with_capacity(indices.len());
    let mut prev: i64 = 0;
    for &idx in indices {
        let delta = (idx as i64) - prev;
        syms.push(encode_seq_index_delta(delta as i32));
        prev = idx as i64;
    }
    encode_symbols(&syms, 1, writer);
}

/// Decodifica conectividad secuencial (método 0 = comprimido, método 1 = sin comprimir).
pub fn decode_sequential_connectivity(reader: &mut ByteReader<'_>) -> Result<DecodedConnectivity> {
    let num_faces = reader.read_varint_u32()? as usize;
    let num_points = reader.read_varint_u32()? as usize;
    let method = reader.read_u8()?;

    let num_indices = num_faces * 3;
    let mut indices = Vec::with_capacity(num_indices);

    match method {
        0 => {
            let symbols = decode_symbols_exact(num_indices, 1, reader)?;
            let mut prev: i64 = 0;
            for s in symbols {
                let delta = decode_seq_index_delta(s) as i64;
                let val = prev + delta;
                if val < 0 {
                    return Err(OptimizeError::corrupt(
                        "Índice negativo en conectividad secuencial comprimida",
                    ));
                }
                indices.push(val as u32);
                prev = val;
            }
        }
        1 => {
            if num_points < 256 {
                for _ in 0..num_indices {
                    indices.push(reader.read_u8()? as u32);
                }
            } else if num_points < (1 << 16) {
                for _ in 0..num_indices {
                    indices.push(reader.read_u16_le()? as u32);
                }
            } else if num_points < (1 << 21) {
                for _ in 0..num_indices {
                    indices.push(reader.read_varint_u32()?);
                }
            } else {
                for _ in 0..num_indices {
                    indices.push(reader.read_u32_le()?);
                }
            }
        }
        _ => {
            return Err(OptimizeError::unsupported(format!(
                "Método de conectividad secuencial desconocido: {method}"
            )));
        }
    }

    let mut ct = CornerTable::with_capacity(num_faces, num_points);
    for (i, &idx) in indices.iter().enumerate() {
        ct.corner_to_vertex[i] = idx as i32;
    }
    ct.compute_opposites_from_faces();

    Ok(DecodedConnectivity {
        num_points,
        num_faces,
        indices,
        corner_table: Some(ct),
        vertex_to_point_map: (0..num_points as u32).collect(),
    })
}

const TOPOLOGY_C: u8 = 0;
const TOPOLOGY_S: u8 = 1;
const TOPOLOGY_L: u8 = 3;
const TOPOLOGY_R: u8 = 5;
const TOPOLOGY_E: u8 = 7;

enum TraversalBitDecoder<'a> {
    Standard(RAnsBitDecoder<'a>),
    Predictive(AdaptiveRAnsBitDecoder<'a>),
}

impl<'a> TraversalBitDecoder<'a> {
    fn decode_bit(&mut self) -> bool {
        match self {
            Self::Standard(d) => d.decode_next_bit(),
            Self::Predictive(d) => d.decode_next_bit(),
        }
    }

    fn decode_symbol(&mut self) -> u8 {
        if !self.decode_bit() {
            return TOPOLOGY_C;
        }
        let b1 = self.decode_bit() as u8;
        let b2 = self.decode_bit() as u8;
        (b2 << 2) | (b1 << 1) | 1
    }
}

#[allow(dead_code)]
struct TopologySplitEvent {
    source_symbol_id: u32,
    split_symbol_id: u32,
    source_edge: u8,
}

/// Decodifica conectividad EdgeBreaker (Standard = 0, Predictive = 1, Valence = 2).
pub fn decode_edgebreaker_connectivity(
    reader: &mut ByteReader<'_>,
    _major_version: u8,
    _minor_version: u8,
) -> Result<DecodedConnectivity> {
    let traversal_type = reader.read_u8()?;
    let num_new_vertices = reader.read_varint_u32()? as usize;
    let num_faces = reader.read_varint_u32()? as usize;
    let num_attribute_data = reader.read_u8()? as usize;
    let num_encoded_symbols = reader.read_varint_u32()? as usize;
    let num_encoded_split_symbols = reader.read_varint_u32()? as usize;

    let mut symbol_stream: Vec<u8> = Vec::with_capacity(num_encoded_symbols);
    let mut valence_contexts: Vec<Vec<u8>> = Vec::new();
    match traversal_type {
        0 => {
            let mut dec = TraversalBitDecoder::Standard(RAnsBitDecoder::start_decoding(reader)?);
            for _ in 0..num_encoded_symbols {
                symbol_stream.push(dec.decode_symbol());
            }
        }
        1 => {
            let mut dec =
                TraversalBitDecoder::Predictive(AdaptiveRAnsBitDecoder::start_decoding(reader)?);
            for _ in 0..num_encoded_symbols {
                symbol_stream.push(dec.decode_symbol());
            }
        }
        2 => {
            let mut fallback =
                TraversalBitDecoder::Standard(RAnsBitDecoder::start_decoding(reader)?);
            let num_contexts = 6usize;
            for _ in 0..num_contexts {
                let count = reader.read_varint_u32()? as usize;
                let syms = if count > 0 {
                    decode_symbols_exact(count, 1, reader)?
                } else {
                    Vec::new()
                };
                let mapped: Vec<u8> = syms
                    .into_iter()
                    .map(|s| match s {
                        0 => TOPOLOGY_C,
                        1 => TOPOLOGY_S,
                        2 => TOPOLOGY_L,
                        3 => TOPOLOGY_R,
                        4 => TOPOLOGY_E,
                        _ => TOPOLOGY_C,
                    })
                    .collect();
                valence_contexts.push(mapped);
            }
            if valence_contexts.iter().all(|c| c.is_empty()) {
                for _ in 0..num_encoded_symbols {
                    symbol_stream.push(fallback.decode_symbol());
                }
            }
        }
        _ => {
            return Err(OptimizeError::unsupported(format!(
                "Traversal EdgeBreaker desconocido: {traversal_type}"
            )));
        }
    }

    let mut start_face_dec = RAnsBitDecoder::start_decoding(reader)?;

    for _ in 0..num_attribute_data {
        let _seam_dec = RAnsBitDecoder::start_decoding(reader)?;
    }

    if num_encoded_split_symbols > 0 {
        let mut split_events = Vec::with_capacity(num_encoded_split_symbols);
        let mut last_id = 0u32;
        for _ in 0..num_encoded_split_symbols {
            let source_delta = reader.read_varint_u32()?;
            let split_delta = reader.read_varint_u32()?;
            let source_id = last_id + source_delta;
            last_id = source_id;
            let split_id = source_id + split_delta;
            split_events.push((source_id, split_id));
        }
        let mut edge_bits = RAnsBitDecoder::start_decoding(reader)?;
        let mut ordered = Vec::with_capacity(split_events.len());
        for (source_symbol_id, split_symbol_id) in split_events {
            let source_edge = if edge_bits.decode_next_bit() { 1 } else { 0 };
            ordered.push(TopologySplitEvent {
                source_symbol_id,
                split_symbol_id,
                source_edge,
            });
        }
        ordered.sort_by_key(|e| (e.split_symbol_id, e.source_symbol_id, e.source_edge));
    }

    let max_verts = (num_new_vertices + num_encoded_symbols + 3).max(num_faces * 3);
    let mut ct = CornerTable::with_capacity(num_faces, max_verts);
    let mut vertex_valences = vec![0i32; max_verts];
    let mut active_corners: Vec<i32> = Vec::with_capacity(64);
    let mut next_face = 0usize;
    let mut next_vertex = 0i32;

    let use_valence = traversal_type == 2 && valence_contexts.iter().any(|c| !c.is_empty());
    let reverse_symbols = !use_valence
        && symbol_stream.first() != Some(&TOPOLOGY_E)
        && symbol_stream.last() == Some(&TOPOLOGY_E);
    let mut active_context: i32 = -1;

    for step in 0..num_encoded_symbols {
        if next_face >= num_faces {
            break;
        }
        let sym = if use_valence {
            if active_context >= 0 {
                let ctx_idx = (active_context as usize).min(valence_contexts.len() - 1);
                valence_contexts[ctx_idx].pop().unwrap_or(TOPOLOGY_E)
            } else {
                TOPOLOGY_E
            }
        } else if reverse_symbols {
            symbol_stream[num_encoded_symbols - 1 - step]
        } else {
            symbol_stream[step]
        };

        let c0 = (next_face * 3) as i32;
        let c1 = c0 + 1;
        let c2 = c0 + 2;
        next_face += 1;

        match sym {
            TOPOLOGY_E => {
                let _ = start_face_dec.decode_next_bit();
                let v0 = next_vertex;
                let v1 = next_vertex + 1;
                let v2 = next_vertex + 2;
                ct.corner_to_vertex[c0 as usize] = v0;
                ct.corner_to_vertex[c1 as usize] = v1;
                ct.corner_to_vertex[c2 as usize] = v2;
                vertex_valences[v0 as usize] += 2;
                vertex_valences[v1 as usize] += 2;
                vertex_valences[v2 as usize] += 2;
                next_vertex += 3;
                active_corners.push(c0);
            }
            TOPOLOGY_C => {
                if let Some(corner_a) = active_corners.pop() {
                    let mut corner_b = CornerTable::previous(corner_a);
                    let mut guard = 0;
                    while ct.opposite(corner_b) >= 0 && guard < num_faces {
                        corner_b = CornerTable::previous(ct.opposite(corner_b));
                        guard += 1;
                    }
                    let va = ct.vertex(CornerTable::next(corner_a));
                    let vb = ct.vertex(CornerTable::previous(corner_a));
                    let vc = ct.vertex(CornerTable::next(corner_b));
                    ct.corner_to_vertex[c0 as usize] = va.max(0);
                    ct.corner_to_vertex[c1 as usize] = vc.max(0);
                    ct.corner_to_vertex[c2 as usize] = vb.max(0);
                    ct.set_opposite(corner_a, c1);
                    ct.set_opposite(corner_b, c2);
                    if va >= 0 {
                        vertex_valences[va as usize] += 1;
                    }
                    if vb >= 0 {
                        vertex_valences[vb as usize] += 1;
                    }
                    if vc >= 0 {
                        vertex_valences[vc as usize] += 2;
                    }
                    active_corners.push(c0);
                }
            }
            TOPOLOGY_L => {
                if let Some(active) = active_corners.pop() {
                    let va = ct.vertex(CornerTable::next(active));
                    let vb = ct.vertex(CornerTable::previous(active));
                    let vc = next_vertex;
                    next_vertex += 1;
                    ct.corner_to_vertex[c0 as usize] = vc;
                    ct.corner_to_vertex[c1 as usize] = vb.max(0);
                    ct.corner_to_vertex[c2 as usize] = va.max(0);
                    ct.set_opposite(active, c0);
                    if va >= 0 {
                        vertex_valences[va as usize] += 1;
                    }
                    if vb >= 0 {
                        vertex_valences[vb as usize] += 1;
                    }
                    vertex_valences[vc as usize] += 2;
                    active_corners.push(c1);
                }
            }
            TOPOLOGY_R => {
                if let Some(active) = active_corners.pop() {
                    let va = ct.vertex(CornerTable::next(active));
                    let vb = ct.vertex(CornerTable::previous(active));
                    let vc = next_vertex;
                    next_vertex += 1;
                    ct.corner_to_vertex[c0 as usize] = vc;
                    ct.corner_to_vertex[c1 as usize] = vb.max(0);
                    ct.corner_to_vertex[c2 as usize] = va.max(0);
                    ct.set_opposite(active, c0);
                    if va >= 0 {
                        vertex_valences[va as usize] += 1;
                    }
                    if vb >= 0 {
                        vertex_valences[vb as usize] += 1;
                    }
                    vertex_valences[vc as usize] += 2;
                    active_corners.push(c2);
                }
            }
            TOPOLOGY_S => {
                if active_corners.len() >= 2 {
                    let active_r = active_corners.pop().unwrap_or(INVALID_CORNER);
                    let active_l = active_corners.pop().unwrap_or(INVALID_CORNER);
                    let va = ct.vertex(CornerTable::next(active_r));
                    let vb = ct.vertex(CornerTable::previous(active_r));
                    let vc = ct.vertex(CornerTable::next(active_l));
                    ct.corner_to_vertex[c0 as usize] = vc.max(0);
                    ct.corner_to_vertex[c1 as usize] = vb.max(0);
                    ct.corner_to_vertex[c2 as usize] = va.max(0);
                    ct.set_opposite(active_r, c0);
                    ct.set_opposite(active_l, c1);
                    active_corners.push(c2);
                } else if let Some(active) = active_corners.pop() {
                    let va = ct.vertex(CornerTable::next(active));
                    let vb = ct.vertex(CornerTable::previous(active));
                    let vc = next_vertex;
                    next_vertex += 1;
                    ct.corner_to_vertex[c0 as usize] = vc;
                    ct.corner_to_vertex[c1 as usize] = vb.max(0);
                    ct.corner_to_vertex[c2 as usize] = va.max(0);
                    ct.set_opposite(active, c0);
                    active_corners.push(c2);
                }
            }
            _ => {}
        }

        if let Some(&top_c) = active_corners.last() {
            let next_v = ct.vertex(CornerTable::next(top_c));
            if next_v >= 0 && (next_v as usize) < vertex_valences.len() {
                let val = vertex_valences[next_v as usize].clamp(2, 7);
                active_context = val - 2;
            } else {
                active_context = -1;
            }
        } else {
            active_context = -1;
        }
    }

    let final_vertices = (next_vertex as usize).max(num_new_vertices);
    ct.num_vertices = final_vertices;
    ct.vertex_corners.resize(final_vertices, INVALID_CORNER);
    let indices = ct.to_triangle_indices();

    Ok(DecodedConnectivity {
        num_points: final_vertices,
        num_faces,
        indices,
        corner_table: Some(ct),
        vertex_to_point_map: (0..final_vertices as u32).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sequential_compressed_connectivity_roundtrip() {
        let indices = vec![0, 1, 2, 0, 2, 3, 4, 5, 6];
        let mut w = ByteWriter::with_capacity(64);
        encode_sequential_connectivity(&indices, 7, &mut w);
        let mut r = ByteReader::new(&w.buf);
        let dec = decode_sequential_connectivity(&mut r).unwrap();
        assert_eq!(dec.num_faces, 3);
        assert_eq!(dec.num_points, 7);
        assert_eq!(dec.indices, indices);
        assert_eq!(r.remaining(), 0);
    }
}
