use crate::bit::{extract_bits_128, write_bits_128};
use crate::error::TextureError;
use crate::etc1s::{ETC1_INTEN_TABLES, EndpointEntry, SelectorEntry, decode_etc1s_block_rgba, pack_etc1s_block_hardware};
use crate::uastc::decode_uastc_block_rgba;

/// IDs de formato compatibles con `transcoder_texture_format` de Basis Universal / `KTX2Loader.js`.
#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetFormat {
    Etc1Rgb = 0,
    Etc2Rgba = 1,
    Bc1Rgb = 2,
    Bc3Rgba = 3,
    Bc7Rgba = 6,
    Astc4x4Rgba = 10,
    Rgba32 = 13,
}

impl TargetFormat {
    pub fn from_u32(val: u32) -> Result<Self, TextureError> {
        match val {
            0 => Ok(Self::Etc1Rgb),
            1 => Ok(Self::Etc2Rgba),
            2 => Ok(Self::Bc1Rgb),
            3 => Ok(Self::Bc3Rgba),
            6 => Ok(Self::Bc7Rgba),
            10 => Ok(Self::Astc4x4Rgba),
            13 => Ok(Self::Rgba32),
            _ => Err(TextureError::UnsupportedFormat(format!("target_format={val}"))),
        }
    }

    #[inline]
    pub fn block_byte_size(self) -> usize {
        match self {
            Self::Etc1Rgb | Self::Bc1Rgb => 8,
            Self::Etc2Rgba | Self::Bc3Rgba | Self::Bc7Rgba | Self::Astc4x4Rgba => 16,
            Self::Rgba32 => 4,
        }
    }

    #[inline]
    pub fn is_compressed(self) -> bool {
        !matches!(self, Self::Rgba32)
    }

    pub fn transcoded_size_bytes(self, width: u32, height: u32) -> Result<usize, TextureError> {
        if width == 0 || height == 0 {
            return Err(TextureError::InvalidHeader("dimensión 0"));
        }
        if self == Self::Rgba32 {
            (width as usize)
                .checked_mul(height as usize)
                .and_then(|p| p.checked_mul(4))
                .ok_or(TextureError::OutOfBounds("overflow tamaño RGBA32"))
        } else {
            let bw = ((width as usize) + 3) / 4;
            let bh = ((height as usize) + 3) / 4;
            bw.checked_mul(bh)
                .and_then(|b| b.checked_mul(self.block_byte_size()))
                .ok_or(TextureError::OutOfBounds("overflow tamaño de bloques GPU"))
        }
    }
}

#[inline]
fn extract_4x4_rgba_block(src: &[u8], width: usize, height: usize, bx: usize, by: usize) -> [u8; 64] {
    let mut blk = [0u8; 64];
    for py in 0..4usize {
        let sy = (by * 4 + py).min(height - 1);
        for px in 0..4usize {
            let sx = (bx * 4 + px).min(width - 1);
            let s_off = (sy * width + sx) * 4;
            let d_off = (py * 4 + px) * 4;
            blk[d_off..d_off + 4].copy_from_slice(&src[s_off..s_off + 4]);
        }
    }
    blk
}

#[inline]
fn write_4x4_rgba_block(dst: &mut [u8], width: usize, height: usize, bx: usize, by: usize, blk: &[u8; 64]) {
    let py_base = by * 4;
    let px_base = bx * 4;
    let max_y = 4.min(height.saturating_sub(py_base));
    let max_x = 4.min(width.saturating_sub(px_base));
    for y in 0..max_y {
        let dst_row = ((py_base + y) * width + px_base) * 4;
        let src_row = y * 16;
        dst[dst_row..dst_row + max_x * 4].copy_from_slice(&blk[src_row..src_row + max_x * 4]);
    }
}

#[inline]
fn is_solid_rgba(blk: &[u8; 64]) -> Option<[u8; 4]> {
    let first = [blk[0], blk[1], blk[2], blk[3]];
    for i in 1..16 {
        if blk[i * 4..i * 4 + 4] != first {
            return None;
        }
    }
    Some(first)
}

#[inline]
fn all_opaque_alpha(blk: &[u8; 64]) -> bool {
    (0..16).all(|i| blk[i * 4 + 3] == 255)
}

/// Calcula extremos RGB usando el eje principal de la caja / covarianza (método de potencias).
fn find_endpoints_rgb(blk: &[u8; 64]) -> ([u8; 3], [u8; 3]) {
    let mut min_c = [255i32; 3];
    let mut max_c = [0i32; 3];
    let mut sum = [0i32; 3];
    for i in 0..16 {
        for c in 0..3 {
            let v = blk[i * 4 + c] as i32;
            min_c[c] = min_c[c].min(v);
            max_c[c] = max_c[c].max(v);
            sum[c] += v;
        }
    }
    if min_c == max_c {
        let p = [min_c[0] as u8, min_c[1] as u8, min_c[2] as u8];
        return (p, p);
    }

    let mut dir = [
        (max_c[0] - min_c[0]) as f32,
        (max_c[1] - min_c[1]) as f32,
        (max_c[2] - min_c[2]) as f32,
    ];
    let mean = [sum[0] as f32 / 16.0, sum[1] as f32 / 16.0, sum[2] as f32 / 16.0];
    for _ in 0..4 {
        let mut acc = [0.0f32; 3];
        for i in 0..16 {
            let dx = blk[i * 4] as f32 - mean[0];
            let dy = blk[i * 4 + 1] as f32 - mean[1];
            let dz = blk[i * 4 + 2] as f32 - mean[2];
            let dot = dx * dir[0] + dy * dir[1] + dz * dir[2];
            acc[0] += dx * dot;
            acc[1] += dy * dot;
            acc[2] += dz * dot;
        }
        let len2 = acc[0] * acc[0] + acc[1] * acc[1] + acc[2] * acc[2];
        if len2 > 1e-6 {
            let inv = 1.0 / len2.sqrt();
            dir = [acc[0] * inv, acc[1] * inv, acc[2] * inv];
        }
    }

    let mut min_dot = f32::INFINITY;
    let mut max_dot = f32::NEG_INFINITY;
    let mut min_idx = 0usize;
    let mut max_idx = 0usize;
    for i in 0..16 {
        let d = (blk[i * 4] as f32 - mean[0]) * dir[0]
            + (blk[i * 4 + 1] as f32 - mean[1]) * dir[1]
            + (blk[i * 4 + 2] as f32 - mean[2]) * dir[2];
        if d < min_dot {
            min_dot = d;
            min_idx = i;
        }
        if d > max_dot {
            max_dot = d;
            max_idx = i;
        }
    }

    (
        [blk[max_idx * 4], blk[max_idx * 4 + 1], blk[max_idx * 4 + 2]],
        [blk[min_idx * 4], blk[min_idx * 4 + 1], blk[min_idx * 4 + 2]],
    )
}

fn find_endpoints_rgba(blk: &[u8; 64]) -> ([u8; 4], [u8; 4]) {
    let mut min_c = [255i32; 4];
    let mut max_c = [0i32; 4];
    let mut sum = [0i32; 4];
    for i in 0..16 {
        for c in 0..4 {
            let v = blk[i * 4 + c] as i32;
            min_c[c] = min_c[c].min(v);
            max_c[c] = max_c[c].max(v);
            sum[c] += v;
        }
    }
    if min_c == max_c {
        let p = [min_c[0] as u8, min_c[1] as u8, min_c[2] as u8, min_c[3] as u8];
        return (p, p);
    }

    let mut dir = [
        (max_c[0] - min_c[0]) as f32,
        (max_c[1] - min_c[1]) as f32,
        (max_c[2] - min_c[2]) as f32,
        (max_c[3] - min_c[3]) as f32,
    ];
    let mean = [
        sum[0] as f32 / 16.0,
        sum[1] as f32 / 16.0,
        sum[2] as f32 / 16.0,
        sum[3] as f32 / 16.0,
    ];
    for _ in 0..4 {
        let mut acc = [0.0f32; 4];
        for i in 0..16 {
            let d = [
                blk[i * 4] as f32 - mean[0],
                blk[i * 4 + 1] as f32 - mean[1],
                blk[i * 4 + 2] as f32 - mean[2],
                blk[i * 4 + 3] as f32 - mean[3],
            ];
            let dot = d[0] * dir[0] + d[1] * dir[1] + d[2] * dir[2] + d[3] * dir[3];
            for c in 0..4 {
                acc[c] += d[c] * dot;
            }
        }
        let len2 = acc[0] * acc[0] + acc[1] * acc[1] + acc[2] * acc[2] + acc[3] * acc[3];
        if len2 > 1e-6 {
            let inv = 1.0 / len2.sqrt();
            dir = [acc[0] * inv, acc[1] * inv, acc[2] * inv, acc[3] * inv];
        }
    }

    let mut min_dot = f32::INFINITY;
    let mut max_dot = f32::NEG_INFINITY;
    let mut min_idx = 0usize;
    let mut max_idx = 0usize;
    for i in 0..16 {
        let dot = (blk[i * 4] as f32 - mean[0]) * dir[0]
            + (blk[i * 4 + 1] as f32 - mean[1]) * dir[1]
            + (blk[i * 4 + 2] as f32 - mean[2]) * dir[2]
            + (blk[i * 4 + 3] as f32 - mean[3]) * dir[3];
        if dot < min_dot {
            min_dot = dot;
            min_idx = i;
        }
        if dot > max_dot {
            max_dot = dot;
            max_idx = i;
        }
    }

    (
        [blk[max_idx * 4], blk[max_idx * 4 + 1], blk[max_idx * 4 + 2], blk[max_idx * 4 + 3]],
        [blk[min_idx * 4], blk[min_idx * 4 + 1], blk[min_idx * 4 + 2], blk[min_idx * 4 + 3]],
    )
}

#[inline]
fn quantize_565(rgb: [u8; 3]) -> u16 {
    let r = ((rgb[0] as u16 * 31 + 127) / 255) & 31;
    let g = ((rgb[1] as u16 * 63 + 127) / 255) & 63;
    let b = ((rgb[2] as u16 * 31 + 127) / 255) & 31;
    (r << 11) | (g << 5) | b
}

#[inline]
fn expand_565(c: u16) -> [i32; 3] {
    let r = ((c >> 11) & 31) as i32;
    let g = ((c >> 5) & 63) as i32;
    let b = (c & 31) as i32;
    [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)]
}

pub fn encode_bc1_block(blk: &[u8; 64]) -> [u8; 8] {
    let (ep_a, ep_b) = find_endpoints_rgb(blk);
    let mut c0 = quantize_565(ep_a);
    let mut c1 = quantize_565(ep_b);

    if c0 == c1 {
        let mut out = [0u8; 8];
        out[0..2].copy_from_slice(&c0.to_le_bytes());
        out[2..4].copy_from_slice(&c1.to_le_bytes());
        return out;
    }

    if c0 < c1 {
        std::mem::swap(&mut c0, &mut c1);
    }

    let p0 = expand_565(c0);
    let p1 = expand_565(c1);
    let pal = [
        p0,
        p1,
        [(2 * p0[0] + p1[0]) / 3, (2 * p0[1] + p1[1]) / 3, (2 * p0[2] + p1[2]) / 3],
        [(p0[0] + 2 * p1[0]) / 3, (p0[1] + 2 * p1[1]) / 3, (p0[2] + 2 * p1[2]) / 3],
    ];

    let mut sel_bits = 0u32;
    for i in 0..16usize {
        let r = blk[i * 4] as i32;
        let g = blk[i * 4 + 1] as i32;
        let b = blk[i * 4 + 2] as i32;
        let mut best_idx = 0u32;
        let mut best_err = i32::MAX;
        for (idx, c) in pal.iter().enumerate() {
            let dr = r - c[0];
            let dg = g - c[1];
            let db = b - c[2];
            let err = dr * dr + dg * dg + db * db;
            if err < best_err {
                best_err = err;
                best_idx = idx as u32;
            }
        }
        sel_bits |= best_idx << (i * 2);
    }

    let mut out = [0u8; 8];
    out[0..2].copy_from_slice(&c0.to_le_bytes());
    out[2..4].copy_from_slice(&c1.to_le_bytes());
    out[4..8].copy_from_slice(&sel_bits.to_le_bytes());
    out
}

pub fn encode_bc4_channel(blk: &[u8; 64], channel_offset: usize) -> [u8; 8] {
    let mut min_v = 255u8;
    let mut max_v = 0u8;
    for i in 0..16 {
        let v = blk[i * 4 + channel_offset];
        min_v = min_v.min(v);
        max_v = max_v.max(v);
    }
    if min_v == max_v {
        return [max_v, max_v, 0, 0, 0, 0, 0, 0];
    }

    let a0 = max_v as i32;
    let a1 = min_v as i32;
    let pal = [
        a0,
        a1,
        (6 * a0 + a1) / 7,
        (5 * a0 + 2 * a1) / 7,
        (4 * a0 + 3 * a1) / 7,
        (3 * a0 + 4 * a1) / 7,
        (2 * a0 + 5 * a1) / 7,
        (a0 + 6 * a1) / 7,
    ];

    let mut idx_bits = 0u64;
    for i in 0..16usize {
        let v = blk[i * 4 + channel_offset] as i32;
        let mut best_idx = 0u64;
        let mut best_err = i32::MAX;
        for (idx, &p) in pal.iter().enumerate() {
            let err = (v - p).abs();
            if err < best_err {
                best_err = err;
                best_idx = idx as u64;
            }
        }
        idx_bits |= best_idx << (i * 3);
    }

    let mut out = [0u8; 8];
    out[0] = max_v;
    out[1] = min_v;
    let idx_le = idx_bits.to_le_bytes();
    out[2..8].copy_from_slice(&idx_le[0..6]);
    out
}

pub fn encode_bc3_block(blk: &[u8; 64]) -> [u8; 16] {
    let a = encode_bc4_channel(blk, 3);
    let rgb = encode_bc1_block(blk);
    let mut out = [0u8; 16];
    out[0..8].copy_from_slice(&a);
    out[8..16].copy_from_slice(&rgb);
    out
}

const BC7_WEIGHTS4: [i32; 16] = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];

pub fn encode_bc7_block(blk: &[u8; 64]) -> [u8; 16] {
    let opaque = all_opaque_alpha(blk);
    let (ep0_init, ep1_init) = if opaque {
        let (c0, c1) = find_endpoints_rgb(blk);
        ([c0[0], c0[1], c0[2], 255], [c1[0], c1[1], c1[2], 255])
    } else {
        find_endpoints_rgba(blk)
    };

    let mut best_err = u64::MAX;
    let mut best_q0 = [0u8; 4];
    let mut best_q1 = [0u8; 4];
    let mut best_p0 = 0u32;
    let mut best_p1 = 0u32;
    let mut best_weights = [0u8; 16];

    for p0 in 0..=1u32 {
        for p1 in 0..=1u32 {
            let mut q0 = [0u8; 4];
            let mut q1 = [0u8; 4];
            let mut e0 = [0i32; 4];
            let mut e1 = [0i32; 4];
            for c in 0..4 {
                let s0 = ((ep0_init[c] as i32 - p0 as i32 + 1) >> 1).clamp(0, 127);
                let s1 = ((ep1_init[c] as i32 - p1 as i32 + 1) >> 1).clamp(0, 127);
                q0[c] = s0 as u8;
                q1[c] = s1 as u8;
                e0[c] = (s0 << 1) | (p0 as i32);
                e1[c] = (s1 << 1) | (p1 as i32);
            }

            let mut w_idx = [0u8; 16];
            let mut total_err = 0u64;
            for i in 0..16 {
                let px = [
                    blk[i * 4] as i32,
                    blk[i * 4 + 1] as i32,
                    blk[i * 4 + 2] as i32,
                    blk[i * 4 + 3] as i32,
                ];
                let mut bw = 0u8;
                let mut b_err = i32::MAX;
                for (wi, &w) in BC7_WEIGHTS4.iter().enumerate() {
                    let dr = (((64 - w) * e0[0] + w * e1[0] + 32) >> 6) - px[0];
                    let dg = (((64 - w) * e0[1] + w * e1[1] + 32) >> 6) - px[1];
                    let db = (((64 - w) * e0[2] + w * e1[2] + 32) >> 6) - px[2];
                    let da = if opaque {
                        0
                    } else {
                        (((64 - w) * e0[3] + w * e1[3] + 32) >> 6) - px[3]
                    };
                    let err = dr * dr + dg * dg + db * db + da * da;
                    if err < b_err {
                        b_err = err;
                        bw = wi as u8;
                    }
                }
                w_idx[i] = bw;
                total_err += b_err as u64;
            }

            if total_err < best_err {
                best_err = total_err;
                best_q0 = q0;
                best_q1 = q1;
                best_p0 = p0;
                best_p1 = p1;
                best_weights = w_idx;
            }
        }
    }

    if best_weights[0] >= 8 {
        std::mem::swap(&mut best_q0, &mut best_q1);
        std::mem::swap(&mut best_p0, &mut best_p1);
        for w in best_weights.iter_mut() {
            *w = 15 - *w;
        }
    }

    // Empacar BC7 Mode 6 (128 bits LSB-first)
    let mut v = 0u128;
    write_bits_128(&mut v, 0, 7, 0b100_0000);
    write_bits_128(&mut v, 7, 7, best_q0[0] as u32);
    write_bits_128(&mut v, 14, 7, best_q1[0] as u32);
    write_bits_128(&mut v, 21, 7, best_q0[1] as u32);
    write_bits_128(&mut v, 28, 7, best_q1[1] as u32);
    write_bits_128(&mut v, 35, 7, best_q0[2] as u32);
    write_bits_128(&mut v, 42, 7, best_q1[2] as u32);
    write_bits_128(&mut v, 49, 7, best_q0[3] as u32);
    write_bits_128(&mut v, 56, 7, best_q1[3] as u32);
    write_bits_128(&mut v, 63, 1, best_p0);
    write_bits_128(&mut v, 64, 1, best_p1);
    write_bits_128(&mut v, 65, 3, (best_weights[0] & 7) as u32);
    for i in 1..16 {
        write_bits_128(&mut v, 68 + ((i - 1) as u32) * 4, 4, best_weights[i] as u32);
    }
    v.to_le_bytes()
}

const EAC_ALPHA_MODIFIERS: [[i16; 8]; 16] = [
    [-3, -6, -9, -15, 2, 5, 8, 14],
    [-3, -7, -10, -13, 2, 6, 9, 12],
    [-2, -5, -8, -13, 1, 4, 7, 12],
    [-2, -4, -6, -13, 1, 3, 5, 12],
    [-3, -6, -8, -12, 2, 5, 7, 11],
    [-3, -7, -9, -11, 2, 6, 8, 10],
    [-4, -7, -8, -11, 3, 6, 7, 10],
    [-3, -5, -8, -11, 2, 4, 7, 10],
    [-2, -6, -8, -10, 1, 5, 7, 9],
    [-2, -5, -8, -10, 1, 4, 7, 9],
    [-2, -4, -8, -10, 1, 3, 7, 9],
    [-2, -5, -7, -10, 1, 4, 6, 9],
    [-3, -4, -7, -10, 2, 3, 6, 9],
    [-1, -2, -3, -10, 0, 1, 2, 9],
    [-4, -6, -8, -9, 3, 5, 7, 8],
    [-3, -5, -7, -9, 2, 4, 6, 8],
];

pub fn encode_eac_a8_block(blk: &[u8; 64]) -> [u8; 8] {
    let mut min_a = 255i32;
    let mut max_a = 0i32;
    for i in 0..16 {
        let a = blk[i * 4 + 3] as i32;
        min_a = min_a.min(a);
        max_a = max_a.max(a);
    }
    if min_a == max_a {
        return [min_a as u8, 0, 0, 0, 0, 0, 0, 0];
    }

    let mut best_err = i32::MAX;
    let mut best_base = 0u8;
    let mut best_mult = 0u8;
    let mut best_tbl = 0u8;
    let mut best_idx = [0u8; 16];

    let mid = (min_a + max_a) / 2;
    let span = (max_a - min_a).max(1);

    for (ti, tbl) in EAC_ALPHA_MODIFIERS.iter().enumerate() {
        let t_min = tbl[3] as i32;
        let t_max = tbl[7] as i32;
        let t_span = (t_max - t_min).max(1);
        let mult_est = ((span * 2 + t_span) / (2 * t_span)).clamp(1, 15);
        for m in [mult_est, (mult_est - 1).max(1), (mult_est + 1).min(15)] {
            let base = (mid - (t_max + t_min) * m / 2).clamp(0, 255);
            let mut cand = [0i32; 8];
            for (k, &mv) in tbl.iter().enumerate() {
                cand[k] = (base + (mv as i32) * m).clamp(0, 255);
            }
            let mut err_sum = 0i32;
            let mut cur_idx = [0u8; 16];
            for y in 0..4 {
                for x in 0..4 {
                    let target = blk[(y * 4 + x) * 4 + 3] as i32;
                    let mut b_i = 0u8;
                    let mut b_e = i32::MAX;
                    for (k, &cv) in cand.iter().enumerate() {
                        let e = (target - cv) * (target - cv);
                        if e < b_e {
                            b_e = e;
                            b_i = k as u8;
                        }
                    }
                    // Orden a..p: col = x, row = y -> slot = x * 4 + y
                    cur_idx[x * 4 + y] = b_i;
                    err_sum += b_e;
                }
            }
            if err_sum < best_err {
                best_err = err_sum;
                best_base = base as u8;
                best_mult = m as u8;
                best_tbl = ti as u8;
                best_idx = cur_idx;
            }
        }
    }

    let mut word = ((best_base as u64) << 56) | ((best_mult as u64 & 0xF) << 52) | ((best_tbl as u64 & 0xF) << 48);
    for (slot, &idx) in best_idx.iter().enumerate() {
        word |= (idx as u64 & 7) << (45 - slot * 3);
    }
    word.to_be_bytes()
}

const ETC1_PIXEL_SELECTOR_MAP: [u8; 4] = [3, 2, 0, 1];

fn fit_etc1_subblock(blk: &[u8; 64], coords: &[(usize, usize); 8], is_5bit: bool) -> ([u8; 3], usize, [u8; 8], i32) {
    let mut sum = [0i32; 3];
    for &(x, y) in coords {
        let p = (y * 4 + x) * 4;
        sum[0] += blk[p] as i32;
        sum[1] += blk[p + 1] as i32;
        sum[2] += blk[p + 2] as i32;
    }
    let avg = [(sum[0] + 4) / 8, (sum[1] + 4) / 8, (sum[2] + 4) / 8];
    let (q, base) = if is_5bit {
        let q5 = [
            ((avg[0] * 31 + 127) / 255).clamp(0, 31) as u8,
            ((avg[1] * 31 + 127) / 255).clamp(0, 31) as u8,
            ((avg[2] * 31 + 127) / 255).clamp(0, 31) as u8,
        ];
        (
            q5,
            [
                ((q5[0] << 3) | (q5[0] >> 2)) as i32,
                ((q5[1] << 3) | (q5[1] >> 2)) as i32,
                ((q5[2] << 3) | (q5[2] >> 2)) as i32,
            ],
        )
    } else {
        let q4 = [
            ((avg[0] * 15 + 127) / 255).clamp(0, 15) as u8,
            ((avg[1] * 15 + 127) / 255).clamp(0, 15) as u8,
            ((avg[2] * 15 + 127) / 255).clamp(0, 15) as u8,
        ];
        (
            q4,
            [
                ((q4[0] << 4) | q4[0]) as i32,
                ((q4[1] << 4) | q4[1]) as i32,
                ((q4[2] << 4) | q4[2]) as i32,
            ],
        )
    };

    let mut best_tbl = 0usize;
    let mut best_sel = [0u8; 8];
    let mut best_err = i32::MAX;
    for (ti, tbl) in ETC1_INTEN_TABLES.iter().enumerate() {
        let mut err_sum = 0i32;
        let mut sels = [0u8; 8];
        for (pi, &(x, y)) in coords.iter().enumerate() {
            let off = (y * 4 + x) * 4;
            let pr = blk[off] as i32;
            let pg = blk[off + 1] as i32;
            let pb = blk[off + 2] as i32;
            let mut bs = 0u8;
            let mut be = i32::MAX;
            for (si, &m) in tbl.iter().enumerate() {
                let dr = (base[0] + m as i32).clamp(0, 255) - pr;
                let dg = (base[1] + m as i32).clamp(0, 255) - pg;
                let db = (base[2] + m as i32).clamp(0, 255) - pb;
                let e = dr * dr + dg * dg + db * db;
                if e < be {
                    be = e;
                    bs = si as u8;
                }
            }
            sels[pi] = bs;
            err_sum += be;
        }
        if err_sum < best_err {
            best_err = err_sum;
            best_tbl = ti;
            best_sel = sels;
        }
    }

    (q, best_tbl, best_sel, best_err)
}

pub fn encode_etc1_block(blk: &[u8; 64]) -> [u8; 8] {
    const SUB_VERT_0: [(usize, usize); 8] = [(0, 0), (0, 1), (0, 2), (0, 3), (1, 0), (1, 1), (1, 2), (1, 3)];
    const SUB_VERT_1: [(usize, usize); 8] = [(2, 0), (2, 1), (2, 2), (2, 3), (3, 0), (3, 1), (3, 2), (3, 3)];
    const SUB_HORZ_0: [(usize, usize); 8] = [(0, 0), (1, 0), (2, 0), (3, 0), (0, 1), (1, 1), (2, 1), (3, 1)];
    const SUB_HORZ_1: [(usize, usize); 8] = [(0, 2), (1, 2), (2, 2), (3, 2), (0, 3), (1, 3), (2, 3), (3, 3)];

    let mut best_err = i32::MAX;
    let mut best_block = [0u8; 8];

    for (flip, c0_list, c1_list) in [(0u8, &SUB_VERT_0, &SUB_VERT_1), (1u8, &SUB_HORZ_0, &SUB_HORZ_1)] {
        // Primero intentar modo diferencial 555 si la diferencia entra en [-4..3]
        let (q5_0, t5_0, s5_0, e5_0) = fit_etc1_subblock(blk, c0_list, true);
        let (q5_1, t5_1, s5_1, e5_1) = fit_etc1_subblock(blk, c1_list, true);
        let dr = q5_1[0] as i32 - q5_0[0] as i32;
        let dg = q5_1[1] as i32 - q5_0[1] as i32;
        let db = q5_1[2] as i32 - q5_0[2] as i32;
        if (-4..=3).contains(&dr) && (-4..=3).contains(&dg) && (-4..=3).contains(&db) {
            let err = e5_0 + e5_1;
            if err < best_err {
                best_err = err;
                let mut out = [0u8; 8];
                out[0] = (q5_0[0] << 3) | ((dr as u8) & 7);
                out[1] = (q5_0[1] << 3) | ((dg as u8) & 7);
                out[2] = (q5_0[2] << 3) | ((db as u8) & 7);
                out[3] = ((t5_0 as u8) << 5) | ((t5_1 as u8) << 2) | 0x02 | flip;
                for (i, &(x, y)) in c0_list.iter().enumerate() {
                    pack_etc1_pixel(&mut out, x, y, s5_0[i]);
                }
                for (i, &(x, y)) in c1_list.iter().enumerate() {
                    pack_etc1_pixel(&mut out, x, y, s5_1[i]);
                }
                best_block = out;
            }
        }

        // Modo individual 444 (siempre válido para contrastes altos)
        let (q4_0, t4_0, s4_0, e4_0) = fit_etc1_subblock(blk, c0_list, false);
        let (q4_1, t4_1, s4_1, e4_1) = fit_etc1_subblock(blk, c1_list, false);
        let err = e4_0 + e4_1;
        if err < best_err {
            best_err = err;
            let mut out = [0u8; 8];
            out[0] = (q4_0[0] << 4) | q4_1[0];
            out[1] = (q4_0[1] << 4) | q4_1[1];
            out[2] = (q4_0[2] << 4) | q4_1[2];
            out[3] = ((t4_0 as u8) << 5) | ((t4_1 as u8) << 2) | flip;
            for (i, &(x, y)) in c0_list.iter().enumerate() {
                pack_etc1_pixel(&mut out, x, y, s4_0[i]);
            }
            for (i, &(x, y)) in c1_list.iter().enumerate() {
                pack_etc1_pixel(&mut out, x, y, s4_1[i]);
            }
            best_block = out;
        }
    }

    best_block
}

#[inline]
fn pack_etc1_pixel(out: &mut [u8; 8], x: usize, y: usize, sel: u8) {
    let etc1_bit_index = x * 4 + y;
    let byte_idx = 7 - (etc1_bit_index >> 3);
    let bit_ofs = etc1_bit_index & 7;
    let etc1_val = ETC1_PIXEL_SELECTOR_MAP[sel as usize & 3];
    let lsb = etc1_val & 1;
    let msb = etc1_val >> 1;
    out[byte_idx] |= lsb << bit_ofs;
    out[byte_idx - 2] |= msb << bit_ofs;
}

pub fn encode_etc2_rgba_block(blk: &[u8; 64]) -> [u8; 16] {
    let a = encode_eac_a8_block(blk);
    let rgb = encode_etc1_block(blk);
    let mut out = [0u8; 16];
    out[0..8].copy_from_slice(&a);
    out[8..16].copy_from_slice(&rgb);
    out
}

const ASTC_WEIGHTS2: [i32; 4] = [0, 21, 43, 64];
const ASTC_WEIGHTS3: [i32; 8] = [0, 9, 18, 27, 37, 46, 55, 64];

pub fn encode_astc_block(blk: &[u8; 64]) -> [u8; 16] {
    if let Some([r, g, b, a]) = is_solid_rgba(blk) {
        return [0xFC, 0xFD, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, r, r, g, g, b, b, a, a];
    }

    if all_opaque_alpha(blk) {
        // 1-partition CEM=8 (RGB Direct, 8-bit) con grilla 4x4 de pesos de 3 bits (blockmode=0x053)
        let (mut e0, mut e1) = find_endpoints_rgb(blk);
        let s0 = e0[0] as u32 + e0[1] as u32 + e0[2] as u32;
        let s1 = e1[0] as u32 + e1[1] as u32 + e1[2] as u32;
        if s1 < s0 {
            std::mem::swap(&mut e0, &mut e1);
        }

        let mut v = 0u128;
        write_bits_128(&mut v, 0, 11, 0x053);
        write_bits_128(&mut v, 11, 2, 0);
        write_bits_128(&mut v, 13, 4, 8);
        write_bits_128(&mut v, 17, 8, e0[0] as u32);
        write_bits_128(&mut v, 25, 8, e1[0] as u32);
        write_bits_128(&mut v, 33, 8, e0[1] as u32);
        write_bits_128(&mut v, 41, 8, e1[1] as u32);
        write_bits_128(&mut v, 49, 8, e0[2] as u32);
        write_bits_128(&mut v, 57, 8, e1[2] as u32);

        for i in 0..16 {
            let pr = blk[i * 4] as i32;
            let pg = blk[i * 4 + 1] as i32;
            let pb = blk[i * 4 + 2] as i32;
            let mut bw = 0u32;
            let mut b_err = i32::MAX;
            for (wi, &w) in ASTC_WEIGHTS3.iter().enumerate() {
                let dr = (((64 - w) * e0[0] as i32 + w * e1[0] as i32 + 32) >> 6) - pr;
                let dg = (((64 - w) * e0[1] as i32 + w * e1[1] as i32 + 32) >> 6) - pg;
                let db = (((64 - w) * e0[2] as i32 + w * e1[2] as i32 + 32) >> 6) - pb;
                let err = dr * dr + dg * dg + db * db;
                if err < b_err {
                    b_err = err;
                    bw = wi as u32;
                }
            }
            for bit in 0..3 {
                let bval = ((bw >> bit) & 1) as u128;
                v |= bval << (127 - (i * 3 + bit));
            }
        }
        v.to_le_bytes()
    } else {
        // 1-partition CEM=12 (RGBA Direct, 8-bit) con grilla 4x4 de pesos de 2 bits (blockmode=0x042)
        let (mut e0, mut e1) = find_endpoints_rgba(blk);
        let s0 = e0[0] as u32 + e0[1] as u32 + e0[2] as u32;
        let s1 = e1[0] as u32 + e1[1] as u32 + e1[2] as u32;
        if s1 < s0 {
            std::mem::swap(&mut e0, &mut e1);
        }

        let mut v = 0u128;
        write_bits_128(&mut v, 0, 11, 0x042);
        write_bits_128(&mut v, 11, 2, 0);
        write_bits_128(&mut v, 13, 4, 12);
        write_bits_128(&mut v, 17, 8, e0[0] as u32);
        write_bits_128(&mut v, 25, 8, e1[0] as u32);
        write_bits_128(&mut v, 33, 8, e0[1] as u32);
        write_bits_128(&mut v, 41, 8, e1[1] as u32);
        write_bits_128(&mut v, 49, 8, e0[2] as u32);
        write_bits_128(&mut v, 57, 8, e1[2] as u32);
        write_bits_128(&mut v, 65, 8, e0[3] as u32);
        write_bits_128(&mut v, 73, 8, e1[3] as u32);

        for i in 0..16 {
            let pr = blk[i * 4] as i32;
            let pg = blk[i * 4 + 1] as i32;
            let pb = blk[i * 4 + 2] as i32;
            let pa = blk[i * 4 + 3] as i32;
            let mut bw = 0u32;
            let mut b_err = i32::MAX;
            for (wi, &w) in ASTC_WEIGHTS2.iter().enumerate() {
                let dr = (((64 - w) * e0[0] as i32 + w * e1[0] as i32 + 32) >> 6) - pr;
                let dg = (((64 - w) * e0[1] as i32 + w * e1[1] as i32 + 32) >> 6) - pg;
                let db = (((64 - w) * e0[2] as i32 + w * e1[2] as i32 + 32) >> 6) - pb;
                let da = (((64 - w) * e0[3] as i32 + w * e1[3] as i32 + 32) >> 6) - pa;
                let err = dr * dr + dg * dg + db * db + da * da;
                if err < b_err {
                    b_err = err;
                    bw = wi as u32;
                }
            }
            for bit in 0..2 {
                let bval = ((bw >> bit) & 1) as u128;
                v |= bval << (127 - (i * 2 + bit));
            }
        }
        v.to_le_bytes()
    }
}

#[inline]
pub fn encode_rgba_block_to_target(blk: &[u8; 64], target: TargetFormat, dst: &mut [u8]) {
    match target {
        TargetFormat::Bc1Rgb => dst.copy_from_slice(&encode_bc1_block(blk)),
        TargetFormat::Bc3Rgba => dst.copy_from_slice(&encode_bc3_block(blk)),
        TargetFormat::Bc7Rgba => dst.copy_from_slice(&encode_bc7_block(blk)),
        TargetFormat::Etc1Rgb => dst.copy_from_slice(&encode_etc1_block(blk)),
        TargetFormat::Etc2Rgba => dst.copy_from_slice(&encode_etc2_rgba_block(blk)),
        TargetFormat::Astc4x4Rgba => dst.copy_from_slice(&encode_astc_block(blk)),
        TargetFormat::Rgba32 => {}
    }
}

/// Transcodifica un nivel UASTC 4x4 al formato objetivo.
pub fn transcode_uastc_level(
    uastc_bytes: &[u8],
    width: u32,
    height: u32,
    target: TargetFormat,
) -> Result<Vec<u8>, TextureError> {
    let bw = ((width as usize) + 3) / 4;
    let bh = ((height as usize) + 3) / 4;
    let needed = bw
        .checked_mul(bh)
        .and_then(|n| n.checked_mul(16))
        .ok_or(TextureError::OutOfBounds("overflow UASTC"))?;
    if uastc_bytes.len() < needed {
        return Err(TextureError::Truncated("nivel UASTC truncado"));
    }

    let out_size = target.transcoded_size_bytes(width, height)?;
    let mut out = vec![0u8; out_size];
    let mut rgba_blk = [0u8; 64];

    if target == TargetFormat::Rgba32 {
        for by in 0..bh {
            for bx in 0..bw {
                let off = (by * bw + bx) * 16;
                let src: &[u8; 16] = uastc_bytes[off..off + 16].try_into().unwrap();
                decode_uastc_block_rgba(src, &mut rgba_blk);
                write_4x4_rgba_block(&mut out, width as usize, height as usize, bx, by, &rgba_blk);
            }
        }
        return Ok(out);
    }

    let bsize = target.block_byte_size();
    for (idx, src_chunk) in uastc_bytes[..needed].chunks_exact(16).enumerate() {
        let src: &[u8; 16] = src_chunk.try_into().unwrap();
        let dst_blk = &mut out[idx * bsize..(idx + 1) * bsize];
        if target == TargetFormat::Astc4x4Rgba && crate::uastc::UASTC_HUFF_MODES[(src[0] & 0x7F) as usize] == 8 {
            let val = u128::from_le_bytes(*src);
            let r = extract_bits_128(val, 5, 8) as u8;
            let g = extract_bits_128(val, 13, 8) as u8;
            let b = extract_bits_128(val, 21, 8) as u8;
            let a = extract_bits_128(val, 29, 8) as u8;
            dst_blk.copy_from_slice(&[0xFC, 0xFD, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, r, r, g, g, b, b, a, a]);
            continue;
        }
        decode_uastc_block_rgba(src, &mut rgba_blk);
        encode_rgba_block_to_target(&rgba_blk, target, dst_blk);
    }

    Ok(out)
}

/// Transcodifica un nivel ETC1S (pares de índices RGB y opcionalmente Alpha) al formato objetivo.
pub fn transcode_etc1s_level(
    rgb_blocks: &[(u16, u16)],
    alpha_blocks: Option<&[(u16, u16)]>,
    endpoints: &[EndpointEntry],
    selectors: &[SelectorEntry],
    width: u32,
    height: u32,
    target: TargetFormat,
) -> Result<Vec<u8>, TextureError> {
    let bw = ((width as usize) + 3) / 4;
    let bh = ((height as usize) + 3) / 4;
    let total = bw * bh;
    if rgb_blocks.len() < total {
        return Err(TextureError::Truncated("bloques ETC1S RGB insuficientes"));
    }
    if let Some(ab) = alpha_blocks {
        if ab.len() < total {
            return Err(TextureError::Truncated("bloques ETC1S Alpha insuficientes"));
        }
    }

    let out_size = target.transcoded_size_bytes(width, height)?;
    let mut out = vec![0u8; out_size];
    let mut rgba_blk = [0u8; 64];
    let bsize = target.block_byte_size();

    for idx in 0..total {
        let (ep_i, sel_i) = rgb_blocks[idx];
        let ep = endpoints
            .get(ep_i as usize)
            .ok_or_else(|| TextureError::CorruptStream("endpoint ETC1S inválido".into()))?;
        let sel = selectors
            .get(sel_i as usize)
            .ok_or_else(|| TextureError::CorruptStream("selector ETC1S inválido".into()))?;

        let alpha_pair = if let Some(ab) = alpha_blocks {
            let (aep_i, asel_i) = ab[idx];
            let aep = endpoints
                .get(aep_i as usize)
                .ok_or_else(|| TextureError::CorruptStream("endpoint Alpha ETC1S inválido".into()))?;
            let asel = selectors
                .get(asel_i as usize)
                .ok_or_else(|| TextureError::CorruptStream("selector Alpha ETC1S inválido".into()))?;
            Some((aep, asel))
        } else {
            None
        };

        if target == TargetFormat::Etc1Rgb {
            out[idx * 8..(idx + 1) * 8].copy_from_slice(&pack_etc1s_block_hardware(ep, sel));
            continue;
        }

        decode_etc1s_block_rgba(ep, sel, alpha_pair, &mut rgba_blk);
        if target == TargetFormat::Rgba32 {
            let bx = idx % bw;
            let by = idx / bw;
            write_4x4_rgba_block(&mut out, width as usize, height as usize, bx, by, &rgba_blk);
        } else if target == TargetFormat::Etc2Rgba {
            let dst = &mut out[idx * 16..(idx + 1) * 16];
            if alpha_pair.is_some() {
                dst[0..8].copy_from_slice(&encode_eac_a8_block(&rgba_blk));
            } else {
                dst[0..8].copy_from_slice(&[255, 0, 0, 0, 0, 0, 0, 0]);
            }
            dst[8..16].copy_from_slice(&pack_etc1s_block_hardware(ep, sel));
        } else {
            encode_rgba_block_to_target(&rgba_blk, target, &mut out[idx * bsize..(idx + 1) * bsize]);
        }
    }

    Ok(out)
}

/// Transcodifica un buffer RGBA8 descomprimido a cualquier formato objetivo.
pub fn transcode_rgba_level(
    rgba_bytes: &[u8],
    width: u32,
    height: u32,
    target: TargetFormat,
) -> Result<Vec<u8>, TextureError> {
    let needed = (width as usize)
        .checked_mul(height as usize)
        .and_then(|p| p.checked_mul(4))
        .ok_or(TextureError::OutOfBounds("overflow RGBA"))?;
    if rgba_bytes.len() < needed {
        return Err(TextureError::Truncated("nivel RGBA8 truncado"));
    }
    if target == TargetFormat::Rgba32 {
        return Ok(rgba_bytes[..needed].to_vec());
    }

    let bw = ((width as usize) + 3) / 4;
    let bh = ((height as usize) + 3) / 4;
    let out_size = target.transcoded_size_bytes(width, height)?;
    let mut out = vec![0u8; out_size];
    let bsize = target.block_byte_size();

    for by in 0..bh {
        for bx in 0..bw {
            let blk = extract_4x4_rgba_block(rgba_bytes, width as usize, height as usize, bx, by);
            let idx = by * bw + bx;
            encode_rgba_block_to_target(&blk, target, &mut out[idx * bsize..(idx + 1) * bsize]);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_astc_test_block(blk: &[u8; 16]) -> [u8; 64] {
        let v = u128::from_le_bytes(*blk);
        let mut out = [0u8; 64];
        if (v & 0x1FF) == 0x1FC {
            let r = blk[9];
            let g = blk[11];
            let b = blk[13];
            let a = blk[15];
            for px in out.chunks_exact_mut(4) {
                px.copy_from_slice(&[r, g, b, a]);
            }
            return out;
        }
        let cem = extract_bits_128(v, 13, 4);
        let r0 = extract_bits_128(v, 17, 8) as i32;
        let r1 = extract_bits_128(v, 25, 8) as i32;
        let g0 = extract_bits_128(v, 33, 8) as i32;
        let g1 = extract_bits_128(v, 41, 8) as i32;
        let b0 = extract_bits_128(v, 49, 8) as i32;
        let b1 = extract_bits_128(v, 57, 8) as i32;
        assert!(r1 + g1 + b1 >= r0 + g0 + b0, "blue-contract no debe activarse");
        if cem == 8 {
            for i in 0..16 {
                let mut wi = 0usize;
                for bit in 0..3 {
                    wi |= (((v >> (127 - (i * 3 + bit))) & 1) as usize) << bit;
                }
                let w = ASTC_WEIGHTS3[wi];
                out[i * 4] = (((64 - w) * r0 + w * r1 + 32) >> 6) as u8;
                out[i * 4 + 1] = (((64 - w) * g0 + w * g1 + 32) >> 6) as u8;
                out[i * 4 + 2] = (((64 - w) * b0 + w * b1 + 32) >> 6) as u8;
                out[i * 4 + 3] = 255;
            }
        } else if cem == 12 {
            let a0 = extract_bits_128(v, 65, 8) as i32;
            let a1 = extract_bits_128(v, 73, 8) as i32;
            for i in 0..16 {
                let mut wi = 0usize;
                for bit in 0..2 {
                    wi |= (((v >> (127 - (i * 2 + bit))) & 1) as usize) << bit;
                }
                let w = ASTC_WEIGHTS2[wi];
                out[i * 4] = (((64 - w) * r0 + w * r1 + 32) >> 6) as u8;
                out[i * 4 + 1] = (((64 - w) * g0 + w * g1 + 32) >> 6) as u8;
                out[i * 4 + 2] = (((64 - w) * b0 + w * b1 + 32) >> 6) as u8;
                out[i * 4 + 3] = (((64 - w) * a0 + w * a1 + 32) >> 6) as u8;
            }
        } else {
            panic!("CEM inesperado: {cem}");
        }
        out
    }

    fn decode_bc7_mode6_test(blk: &[u8; 16]) -> [u8; 64] {
        let v = u128::from_le_bytes(*blk);
        assert_eq!(extract_bits_128(v, 0, 7), 0x40);
        let p0 = extract_bits_128(v, 63, 1) as i32;
        let p1 = extract_bits_128(v, 64, 1) as i32;
        let e0 = [
            ((extract_bits_128(v, 7, 7) as i32) << 1) | p0,
            ((extract_bits_128(v, 21, 7) as i32) << 1) | p0,
            ((extract_bits_128(v, 35, 7) as i32) << 1) | p0,
            ((extract_bits_128(v, 49, 7) as i32) << 1) | p0,
        ];
        let e1 = [
            ((extract_bits_128(v, 14, 7) as i32) << 1) | p1,
            ((extract_bits_128(v, 28, 7) as i32) << 1) | p1,
            ((extract_bits_128(v, 42, 7) as i32) << 1) | p1,
            ((extract_bits_128(v, 56, 7) as i32) << 1) | p1,
        ];
        let mut out = [0u8; 64];
        for i in 0..16 {
            let wi = if i == 0 {
                extract_bits_128(v, 65, 3) as usize
            } else {
                extract_bits_128(v, 68 + ((i - 1) as u32) * 4, 4) as usize
            };
            let w = BC7_WEIGHTS4[wi];
            for c in 0..4 {
                out[i * 4 + c] = (((64 - w) * e0[c] + w * e1[c] + 32) >> 6) as u8;
            }
        }
        out
    }

    #[test]
    fn encodes_solid_and_gradient_blocks_cleanly() {
        let mut solid = [0u8; 64];
        for px in solid.chunks_exact_mut(4) {
            px.copy_from_slice(&[120, 200, 40, 180]);
        }

        let astc_solid = encode_astc_block(&solid);
        assert_eq!(decode_astc_test_block(&astc_solid), solid);

        let bc7_solid = encode_bc7_block(&solid);
        let bc7_dec = decode_bc7_mode6_test(&bc7_solid);
        for (a, b) in bc7_dec.iter().zip(solid.iter()) {
            assert!((*a as i32 - *b as i32).abs() <= 2);
        }

        // Bloque degradado opaco (CEM=8 con pesos de 3 bits)
        let mut grad_opaque = [0u8; 64];
        for i in 0..16 {
            grad_opaque[i * 4] = (i as u8) * 16;
            grad_opaque[i * 4 + 1] = 240 - (i as u8) * 12;
            grad_opaque[i * 4 + 2] = (i as u8) * 8 + 40;
            grad_opaque[i * 4 + 3] = 255;
        }
        let astc_opaque = encode_astc_block(&grad_opaque);
        let astc_opaque_dec = decode_astc_test_block(&astc_opaque);
        for (a, b) in astc_opaque_dec.iter().zip(grad_opaque.iter()) {
            assert!((*a as i32 - *b as i32).abs() <= 24);
        }

        // Bloque degradado con alfa (CEM=12 con pesos de 2 bits)
        let mut grad = grad_opaque;
        for i in 0..16 {
            grad[i * 4 + 3] = if i < 8 { 255 } else { 100 };
        }

        let astc_grad = encode_astc_block(&grad);
        let astc_dec = decode_astc_test_block(&astc_grad);
        for (a, b) in astc_dec.iter().zip(grad.iter()) {
            assert!((*a as i32 - *b as i32).abs() <= 52);
        }

        let bc3 = encode_bc3_block(&grad);
        assert!(bc3[0] > bc3[1]);

        let etc2 = encode_etc2_rgba_block(&grad);
        assert_eq!(etc2[0..8].len(), 8);
        assert_eq!(etc2[8..16].len(), 8);
    }
}
