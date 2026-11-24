use crate::error::{OptimizeError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeshoptMode {
    Attributes = 0,
    Triangles = 1,
    Indices = 2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeshoptFilter {
    None = 0,
    Octahedral = 1,
    Quaternion = 2,
    Exponential = 3,
}

const VERTEX_HEADER: u8 = 0xa0;
const INDEX_HEADER: u8 = 0xe0;
const INDEX_SEQUENCE_HEADER: u8 = 0xd0;

#[inline]
fn unzigzag8(v: u8) -> u8 {
    if (v & 1) != 0 {
        !((v >> 1))
    } else {
        v >> 1
    }
}

#[inline]
fn unzigzag32(v: u32) -> i32 {
    ((v >> 1) as i32) ^ (-((v & 1) as i32))
}

fn decode_vbyte(data: &[u8], pos: &mut usize) -> Result<u32> {
    let mut lead = *data.get(*pos).ok_or_else(|| OptimizeError::eof("meshopt vbyte"))? as u32;
    *pos += 1;
    if lead < 128 {
        return Ok(lead);
    }
    let mut res = lead & 0x7F;
    let mut shift = 7;
    for _ in 0..4 {
        lead = *data.get(*pos).ok_or_else(|| OptimizeError::eof("meshopt vbyte cont"))? as u32;
        *pos += 1;
        res |= (lead & 0x7F) << shift;
        if lead < 128 {
            return Ok(res);
        }
        shift += 7;
    }
    Err(OptimizeError::corrupt("meshopt vbyte excede 5 bytes"))
}

fn decode_vertex_group(
    data: &[u8],
    pos: &mut usize,
    dst: &mut [u8],
    bits: u8,
) -> Result<()> {
    match bits {
        0 => {
            dst.fill(0);
        }
        1 => {
            let need = (dst.len() + 3) / 4;
            if *pos + need > data.len() {
                return Err(OptimizeError::eof("meshopt vertex group 2-bit"));
            }
            for (i, d) in dst.iter_mut().enumerate() {
                let b = data[*pos + (i >> 2)];
                let shift = 6 - ((i & 3) * 2);
                let val = (b >> shift) & 3;
                *d = unzigzag8(val);
            }
            *pos += need;
        }
        2 => {
            let need = (dst.len() + 1) / 2;
            if *pos + need > data.len() {
                return Err(OptimizeError::eof("meshopt vertex group 4-bit"));
            }
            for (i, d) in dst.iter_mut().enumerate() {
                let b = data[*pos + (i >> 1)];
                let shift = if (i & 1) == 0 { 4 } else { 0 };
                let val = (b >> shift) & 0xF;
                *d = unzigzag8(val);
            }
            *pos += need;
        }
        3 => {
            let need = dst.len();
            if *pos + need > data.len() {
                return Err(OptimizeError::eof("meshopt vertex group 8-bit"));
            }
            for (i, d) in dst.iter_mut().enumerate() {
                *d = unzigzag8(data[*pos + i]);
            }
            *pos += need;
        }
        _ => unreachable!(),
    }
    Ok(())
}

/// Decodifica `EXT_meshopt_compression` modo `ATTRIBUTES` (`meshopt_decodeVertexBuffer`).
pub fn decode_vertex_buffer(
    count: usize,
    vertex_size: usize,
    src: &[u8],
    filter: MeshoptFilter,
) -> Result<Vec<u8>> {
    if vertex_size == 0 || vertex_size % 4 != 0 || vertex_size > 256 {
        return Err(OptimizeError::corrupt("vertex_size inválido para meshopt"));
    }
    if count == 0 {
        return Ok(Vec::new());
    }
    if src.len() < 1 + vertex_size {
        return Err(OptimizeError::eof("meshopt vertex buffer header/tail"));
    }
    if (src[0] & 0xF0) != VERTEX_HEADER || (src[0] & 0x0F) != 0 {
        return Err(OptimizeError::new(
            crate::error::ErrorCode::InvalidHeader,
            "Cabecera meshopt vertex buffer inválida",
        ));
    }

    let mut pos = 1usize;
    let payload_end = src.len() - vertex_size;
    let mut last_vertex = src[payload_end..].to_vec();
    let mut out = vec![0u8; count * vertex_size];

    let max_block = (8192 / vertex_size).min(256);
    let block_capacity = (max_block & !15).max(16);

    let mut offset = 0usize;
    while offset < count {
        let block_count = (count - offset).min(block_capacity);
        let group_count = (block_count + 15) / 16;
        let header_bytes = (group_count + 3) / 4;
        let aligned_count = (block_count + 15) & !15;
        let mut channel_buf = vec![0u8; aligned_count];

        for k in 0..vertex_size {
            if pos >= payload_end {
                return Err(OptimizeError::eof("meshopt block channel header"));
            }
            let mode = src[pos];
            // En meshoptimizer v0: 0..3 en los 2 bits bajos del primer byte o header por canal
            if mode == 0x03 && header_bytes == 1 && block_count <= 16 {
                // Verbatim byte stream
                pos += 1;
                if pos + block_count > payload_end {
                    return Err(OptimizeError::eof("meshopt verbatim channel"));
                }
                for v in 0..block_count {
                    let b = src[pos + v];
                    out[(offset + v) * vertex_size + k] = b;
                    last_vertex[k] = b;
                }
                pos += block_count;
                continue;
            }

            if pos + header_bytes > payload_end {
                return Err(OptimizeError::eof("meshopt channel header"));
            }
            let hdr_start = pos;
            pos += header_bytes;

            for g in 0..group_count {
                let h_byte = src[hdr_start + (g >> 2)];
                let bits = (h_byte >> ((g & 3) * 2)) & 3;
                let start = g * 16;
                let end = (start + 16).min(aligned_count);
                decode_vertex_group(src, &mut pos, &mut channel_buf[start..end], bits)?;
            }

            let mut acc = last_vertex[k];
            for v in 0..block_count {
                acc = acc.wrapping_add(channel_buf[v]);
                out[(offset + v) * vertex_size + k] = acc;
            }
            last_vertex[k] = acc;
        }
        offset += block_count;
    }

    apply_filter(&mut out, count, vertex_size, filter)?;
    Ok(out)
}

/// Decodifica `EXT_meshopt_compression` modo `TRIANGLES` (`meshopt_decodeIndexBuffer`).
pub fn decode_index_buffer(count: usize, index_size: usize, src: &[u8]) -> Result<Vec<u8>> {
    if count % 3 != 0 || (index_size != 2 && index_size != 4) {
        return Err(OptimizeError::corrupt("Parámetros inválidos en meshopt index buffer"));
    }
    if count == 0 {
        return Ok(Vec::new());
    }
    if src.len() < 17 {
        return Err(OptimizeError::eof("meshopt index buffer"));
    }
    if src[0] != INDEX_HEADER {
        return Err(OptimizeError::new(
            crate::error::ErrorCode::InvalidHeader,
            "Cabecera meshopt index buffer inválida",
        ));
    }

    let face_count = count / 3;
    let code_bytes = (face_count + 1) / 2;
    let codeaux_pos = src.len() - 16;
    if 1 + code_bytes > codeaux_pos {
        return Err(OptimizeError::eof("meshopt index codes"));
    }

    let codes = &src[1..1 + code_bytes];
    let codeaux_table = &src[codeaux_pos..];
    let mut data_pos = 1 + code_bytes;

    let mut edge_fifo = [(0u32, 0u32); 16];
    let mut edge_pos = 0usize;
    let mut vertex_fifo = [0u32; 16];
    let mut vert_pos = 0usize;
    let mut next = 0u32;
    let mut last = 0u32;

    let mut indices = Vec::with_capacity(count);

    for f in 0..face_count {
        let byte = codes[f >> 1];
        let code = if (f & 1) == 0 { byte >> 4 } else { byte & 0x0F };

        if code < 14 {
            // Reutiliza arista de edge_fifo y predice el tercer vértice
            let (a, b) = edge_fifo[(edge_pos + 15 - (code as usize)) & 15];
            let fec = codeaux_table[(code as usize) & 15];
            let c = if fec == 0 {
                let v = next;
                next += 1;
                v
            } else if fec < 15 {
                vertex_fifo[(vert_pos + 15 - (fec as usize)) & 15]
            } else {
                let d = decode_vbyte(src, &mut data_pos)?;
                let v = (last as i64 + unzigzag32(d) as i64) as u32;
                last = v;
                v
            };

            indices.extend_from_slice(&[a, b, c]);
            edge_fifo[edge_pos] = (c, b);
            edge_pos = (edge_pos + 1) & 15;
            edge_fifo[edge_pos] = (a, c);
            edge_pos = (edge_pos + 1) & 15;
            vertex_fifo[vert_pos] = c;
            vert_pos = (vert_pos + 1) & 15;
        } else {
            // Triángulo nuevo / explícito
            let mut tri = [0u32; 3];
            for slot in &mut tri {
                let d = decode_vbyte(src, &mut data_pos)?;
                let v = (last as i64 + unzigzag32(d) as i64) as u32;
                last = v;
                *slot = v;
                vertex_fifo[vert_pos] = v;
                vert_pos = (vert_pos + 1) & 15;
            }
            indices.extend_from_slice(&tri);
            edge_fifo[edge_pos] = (tri[2], tri[1]);
            edge_pos = (edge_pos + 1) & 15;
            edge_fifo[edge_pos] = (tri[0], tri[2]);
            edge_pos = (edge_pos + 1) & 15;
            edge_fifo[edge_pos] = (tri[1], tri[0]);
            edge_pos = (edge_pos + 1) & 15;
        }
    }

    Ok(pack_indices(&indices, index_size))
}

/// Decodifica `EXT_meshopt_compression` modo `INDICES` (`meshopt_decodeIndexSequence`).
pub fn decode_index_sequence(count: usize, index_size: usize, src: &[u8]) -> Result<Vec<u8>> {
    if index_size != 2 && index_size != 4 {
        return Err(OptimizeError::corrupt("index_size inválido"));
    }
    if count == 0 {
        return Ok(Vec::new());
    }
    if src.is_empty() || src[0] != INDEX_SEQUENCE_HEADER {
        return Err(OptimizeError::new(
            crate::error::ErrorCode::InvalidHeader,
            "Cabecera meshopt index sequence inválida",
        ));
    }
    let mut pos = 1usize;
    let mut last = 0i64;
    let mut indices = Vec::with_capacity(count);
    for _ in 0..count {
        let d = decode_vbyte(src, &mut pos)?;
        let val = last + unzigzag32(d) as i64;
        last = val;
        indices.push(val as u32);
    }
    Ok(pack_indices(&indices, index_size))
}

fn pack_indices(indices: &[u32], index_size: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(indices.len() * index_size);
    if index_size == 2 {
        for &v in indices {
            out.extend_from_slice(&(v as u16).to_le_bytes());
        }
    } else {
        for &v in indices {
            out.extend_from_slice(&v.to_le_bytes());
        }
    }
    out
}

fn apply_filter(
    data: &mut [u8],
    count: usize,
    stride: usize,
    filter: MeshoptFilter,
) -> Result<()> {
    match filter {
        MeshoptFilter::None => Ok(()),
        MeshoptFilter::Octahedral => {
            if stride == 4 {
                for i in 0..count {
                    let off = i * 4;
                    let x = (data[off] as i8) as f32;
                    let y = (data[off + 1] as i8) as f32;
                    let one = (data[off + 2] as i8) as f32;
                    let w = data[off + 3];
                    let (nx, ny, nz) = oct_decode_vec3(x, y, one);
                    data[off] = (nx * 127.0).round().clamp(-127.0, 127.0) as i8 as u8;
                    data[off + 1] = (ny * 127.0).round().clamp(-127.0, 127.0) as i8 as u8;
                    data[off + 2] = (nz * 127.0).round().clamp(-127.0, 127.0) as i8 as u8;
                    data[off + 3] = w;
                }
            } else if stride == 8 {
                for i in 0..count {
                    let off = i * 8;
                    let x = i16::from_le_bytes([data[off], data[off + 1]]) as f32;
                    let y = i16::from_le_bytes([data[off + 2], data[off + 3]]) as f32;
                    let one = i16::from_le_bytes([data[off + 4], data[off + 5]]) as f32;
                    let (nx, ny, nz) = oct_decode_vec3(x, y, one);
                    let rx = (nx * 32767.0).round().clamp(-32767.0, 32767.0) as i16;
                    let ry = (ny * 32767.0).round().clamp(-32767.0, 32767.0) as i16;
                    let rz = (nz * 32767.0).round().clamp(-32767.0, 32767.0) as i16;
                    data[off..off + 2].copy_from_slice(&rx.to_le_bytes());
                    data[off + 2..off + 4].copy_from_slice(&ry.to_le_bytes());
                    data[off + 4..off + 6].copy_from_slice(&rz.to_le_bytes());
                }
            }
            Ok(())
        }
        MeshoptFilter::Quaternion => {
            if stride == 8 {
                let scale = core::f32::consts::FRAC_1_SQRT_2;
                for i in 0..count {
                    let off = i * 8;
                    let x = i16::from_le_bytes([data[off], data[off + 1]]);
                    let y = i16::from_le_bytes([data[off + 2], data[off + 3]]);
                    let z = i16::from_le_bytes([data[off + 4], data[off + 5]]);
                    let w = i16::from_le_bytes([data[off + 6], data[off + 7]]);
                    let max_idx = (w & 3) as usize;
                    let bits = ((w >> 2) & 15).max(1) as i32;
                    let range = ((1 << bits) - 1) as f32;
                    let fx = (x as f32 / range) * scale;
                    let fy = (y as f32 / range) * scale;
                    let fz = (z as f32 / range) * scale;
                    let fw = (1.0 - fx * fx - fy * fy - fz * fz).max(0.0).sqrt();
                    let mut q = [0.0f32; 4];
                    let mut src_q = [fx, fy, fz];
                    let mut si = 0;
                    for qi in 0..4 {
                        if qi == max_idx {
                            q[qi] = fw;
                        } else {
                            q[qi] = src_q[si];
                            si += 1;
                        }
                    }
                    let _ = &mut src_q;
                    for (qi, &qv) in q.iter().enumerate() {
                        let enc = (qv * 32767.0).round().clamp(-32767.0, 32767.0) as i16;
                        data[off + qi * 2..off + qi * 2 + 2].copy_from_slice(&enc.to_le_bytes());
                    }
                }
            }
            Ok(())
        }
        MeshoptFilter::Exponential => {
            for i in 0..(count * (stride / 4)) {
                let off = i * 4;
                let v = u32::from_le_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]]);
                let exp = ((v as i32) >> 24) as f32;
                let mant = (((v << 8) as i32) >> 8) as f32;
                let f = mant * (2.0f32).powf(exp);
                data[off..off + 4].copy_from_slice(&f.to_le_bytes());
            }
            Ok(())
        }
    }
}

#[inline]
fn oct_decode_vec3(x: f32, y: f32, one: f32) -> (f32, f32, f32) {
    let nz = one - x.abs() - y.abs();
    let (mut nx, mut ny) = (x, y);
    if nz < 0.0 {
        nx = (one - y.abs()) * if x >= 0.0 { 1.0 } else { -1.0 };
        ny = (one - x.abs()) * if y >= 0.0 { 1.0 } else { -1.0 };
    }
    let len = (nx * nx + ny * ny + nz * nz).sqrt().max(1e-8);
    (nx / len, ny / len, nz / len)
}
