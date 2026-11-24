use std::io::{Cursor, Read};

use crate::error::TextureError;
use crate::etc1s::BasisLzGlobalData;
use crate::transcode::{
    TargetFormat, transcode_etc1s_level, transcode_rgba_level, transcode_uastc_level,
};

pub const KTX2_MAGIC: [u8; 12] = [0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A];

const KTX2_SS_NONE: u32 = 0;
const KTX2_SS_BASISLZ: u32 = 1;
const KTX2_SS_ZSTANDARD: u32 = 2;
const KTX2_SS_ZLIB: u32 = 3;

const KTX2_DF_TRANSFER_SRGB: u8 = 2;
const KTX2_DF_MODEL_ASTC: u8 = 162;
const KTX2_DF_MODEL_ETC1S: u8 = 163;
const KTX2_DF_MODEL_UASTC: u8 = 166;
const KTX2_DF_CHANNEL_UASTC_RGBA: u32 = 3;
const KTX2_DF_CHANNEL_UASTC_RRRG: u32 = 5;

const KTX2_IMAGE_IS_P_FRAME: u32 = 2;
const MAX_UNCOMPRESSED_LEVEL_BYTES: usize = 256 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceFormat {
    Etc1s = 0,
    Uastc4x4 = 1,
    Rgba8 = 2,
    Rgb8 = 3,
    Rg8 = 4,
    R8 = 5,
    Astc4x4 = 6,
    Bc7 = 7,
    Bc1 = 8,
    Bc3 = 9,
    Etc2Rgb = 10,
    Etc2Rgba = 11,
}

#[derive(Clone, Copy, Debug)]
pub struct LevelEntry {
    pub byte_offset: usize,
    pub byte_length: usize,
    pub uncompressed_byte_length: usize,
}

pub struct Ktx2Container {
    raw: Vec<u8>,
    pub vk_format: u32,
    pub width: u32,
    pub height: u32,
    pub depth: u32,
    pub layers: u32,
    pub faces: u32,
    pub levels: u32,
    pub supercompression: u32,
    pub is_srgb: bool,
    pub has_alpha: bool,
    pub source_format: SourceFormat,
    level_index: Vec<LevelEntry>,
    basislz_sgd: Option<BasisLzGlobalData>,
}

#[inline]
fn read_u32(b: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}

#[inline]
fn read_u64(b: &[u8], off: usize) -> u64 {
    u64::from_le_bytes([
        b[off],
        b[off + 1],
        b[off + 2],
        b[off + 3],
        b[off + 4],
        b[off + 5],
        b[off + 6],
        b[off + 7],
    ])
}

fn vk_format_info(vk_format: u32) -> Option<(SourceFormat, bool, bool)> {
    match vk_format {
        9 => Some((SourceFormat::R8, false, false)),
        16 => Some((SourceFormat::Rg8, false, false)),
        23 => Some((SourceFormat::Rgb8, false, false)),
        29 => Some((SourceFormat::Rgb8, true, false)),
        37 => Some((SourceFormat::Rgba8, false, true)),
        43 => Some((SourceFormat::Rgba8, true, true)),
        131 => Some((SourceFormat::Bc1, false, false)),
        132 => Some((SourceFormat::Bc1, true, false)),
        133 => Some((SourceFormat::Bc1, false, true)),
        134 => Some((SourceFormat::Bc1, true, true)),
        137 => Some((SourceFormat::Bc3, false, true)),
        138 => Some((SourceFormat::Bc3, true, true)),
        145 => Some((SourceFormat::Bc7, false, true)),
        146 => Some((SourceFormat::Bc7, true, true)),
        147 => Some((SourceFormat::Etc2Rgb, false, false)),
        148 => Some((SourceFormat::Etc2Rgb, true, false)),
        151 => Some((SourceFormat::Etc2Rgba, false, true)),
        152 => Some((SourceFormat::Etc2Rgba, true, true)),
        157 => Some((SourceFormat::Astc4x4, false, true)),
        158 => Some((SourceFormat::Astc4x4, true, true)),
        _ => None,
    }
}

impl Ktx2Container {
    pub fn open(data: Vec<u8>) -> Result<Self, TextureError> {
        if data.len() < 80 {
            return Err(TextureError::InvalidHeader("archivo menor a 80 bytes"));
        }
        if data[0..12] != KTX2_MAGIC {
            return Err(TextureError::InvalidHeader("firma KTX2 inválida"));
        }

        let vk_format = read_u32(&data, 12);
        let _type_size = read_u32(&data, 16);
        let width = read_u32(&data, 20);
        let height = read_u32(&data, 24).max(1);
        let depth = read_u32(&data, 28);
        let layer_count = read_u32(&data, 32);
        let face_count = read_u32(&data, 36);
        let level_count = read_u32(&data, 40);
        let supercompression = read_u32(&data, 44);
        let dfd_off = read_u32(&data, 48) as usize;
        let dfd_len = read_u32(&data, 52) as usize;
        let _kvd_off = read_u32(&data, 56) as usize;
        let _kvd_len = read_u32(&data, 60) as usize;
        let sgd_off = read_u64(&data, 64);
        let sgd_len = read_u64(&data, 72);

        if width == 0 {
            return Err(TextureError::InvalidHeader("pixelWidth == 0"));
        }
        if depth > 1 {
            return Err(TextureError::UnsupportedFormat("texturas 3D (pixelDepth > 1) no soportadas".into()));
        }
        if !matches!(supercompression, KTX2_SS_NONE | KTX2_SS_BASISLZ | KTX2_SS_ZSTANDARD | KTX2_SS_ZLIB) {
            return Err(TextureError::UnsupportedFormat(format!(
                "supercompresión KTX2 no soportada: {supercompression}"
            )));
        }

        let levels = level_count.max(1);
        let layers = layer_count.max(1);
        let faces = face_count.max(1);

        let level_table_bytes = (levels as usize)
            .checked_mul(24)
            .ok_or(TextureError::InvalidHeader("overflow levelCount"))?;
        let level_table_end = 80usize
            .checked_add(level_table_bytes)
            .ok_or(TextureError::InvalidHeader("overflow tabla de niveles"))?;
        if level_table_end > data.len() {
            return Err(TextureError::Truncated("tabla de niveles KTX2"));
        }

        let mut level_index = Vec::with_capacity(levels as usize);
        for lv in 0..(levels as usize) {
            let off = 80 + lv * 24;
            let byte_offset = usize::try_from(read_u64(&data, off))
                .map_err(|_| TextureError::OutOfBounds("byteOffset de nivel"))?;
            let byte_length = usize::try_from(read_u64(&data, off + 8))
                .map_err(|_| TextureError::OutOfBounds("byteLength de nivel"))?;
            let uncompressed_byte_length = usize::try_from(read_u64(&data, off + 16))
                .map_err(|_| TextureError::OutOfBounds("uncompressedByteLength de nivel"))?;
            let end = byte_offset
                .checked_add(byte_length)
                .ok_or(TextureError::Truncated("nivel KTX2"))?;
            if end > data.len() {
                return Err(TextureError::Truncated("datos de nivel fuera de rango"));
            }
            level_index.push(LevelEntry {
                byte_offset,
                byte_length,
                uncompressed_byte_length,
            });
        }

        // Parsear DFD básico
        if dfd_len < 28 || dfd_off.checked_add(dfd_len).map_or(true, |e| e > data.len()) {
            return Err(TextureError::InvalidDfd("DFD fuera de límites o menor a 28 bytes"));
        }
        let dfd = &data[dfd_off..dfd_off + dfd_len];
        let color_model = dfd[12];
        let transfer_func = dfd[14];
        let mut is_srgb = transfer_func == KTX2_DF_TRANSFER_SRGB;

        let mut basislz_sgd = None;
        let total_images = (levels as usize)
            .checked_mul(layers as usize)
            .and_then(|n| n.checked_mul(faces as usize))
            .ok_or(TextureError::InvalidHeader("overflow número de imágenes KTX2"))?;

        if supercompression == KTX2_SS_BASISLZ {
            let sgd_off_us = usize::try_from(sgd_off)
                .map_err(|_| TextureError::OutOfBounds("sgdByteOffset"))?;
            let sgd_len_us = usize::try_from(sgd_len)
                .map_err(|_| TextureError::OutOfBounds("sgdByteLength"))?;
            let sgd_end = sgd_off_us
                .checked_add(sgd_len_us)
                .ok_or(TextureError::Truncated("BasisLZ SGD"))?;
            if sgd_end > data.len() {
                return Err(TextureError::Truncated("BasisLZ SGD fuera de rango"));
            }
            basislz_sgd = Some(BasisLzGlobalData::parse_ktx2_sgd(&data[sgd_off_us..sgd_end], total_images)?);
        }

        let (source_format, has_alpha) = if vk_format == 0 {
            if supercompression == KTX2_SS_BASISLZ || color_model == KTX2_DF_MODEL_ETC1S {
                let sgd_alpha = basislz_sgd.as_ref().map_or(false, |s| s.has_alpha);
                let dfd_alpha = dfd_len >= 60;
                (SourceFormat::Etc1s, sgd_alpha || dfd_alpha)
            } else if color_model == KTX2_DF_MODEL_UASTC {
                if dfd.len() < 32 {
                    return Err(TextureError::InvalidDfd("DFD UASTC incompleto"));
                }
                let channel_type = (read_u32(dfd, 28) >> 24) & 0x0F;
                let has_alpha = channel_type == KTX2_DF_CHANNEL_UASTC_RGBA || channel_type == KTX2_DF_CHANNEL_UASTC_RRRG;
                (SourceFormat::Uastc4x4, has_alpha)
            } else if color_model == KTX2_DF_MODEL_ASTC {
                let channel_type = if dfd.len() >= 32 {
                    (read_u32(dfd, 28) >> 24) & 0x0F
                } else {
                    KTX2_DF_CHANNEL_UASTC_RGBA
                };
                let has_alpha = channel_type == KTX2_DF_CHANNEL_UASTC_RGBA || channel_type == KTX2_DF_CHANNEL_UASTC_RRRG;
                (SourceFormat::Astc4x4, has_alpha)
            } else {
                return Err(TextureError::UnsupportedFormat(format!(
                    "DFD colorModel={color_model} con vkFormat=0 no soportado"
                )));
            }
        } else {
            let (fmt, fmt_srgb, fmt_alpha) = vk_format_info(vk_format)
                .ok_or_else(|| TextureError::UnsupportedFormat(format!("vkFormat={vk_format}")))?;
            if fmt_srgb {
                is_srgb = true;
            }
            // Comprobar canal alfa explícito en muestras RGBSDA (colorModel == 1, channelType == 15)
            let mut dfd_alpha = false;
            if dfd[12] == 1 && dfd.len() >= 44 {
                let mut soff = 28usize;
                while soff + 16 <= dfd.len() {
                    if ((read_u32(dfd, soff) >> 24) & 0x0F) == 15 {
                        dfd_alpha = true;
                        break;
                    }
                    soff += 16;
                }
            }
            (fmt, fmt_alpha || dfd_alpha)
        };

        Ok(Self {
            raw: data,
            vk_format,
            width,
            height,
            depth: depth.max(1),
            layers,
            faces,
            levels,
            supercompression,
            is_srgb,
            has_alpha,
            source_format,
            level_index,
            basislz_sgd,
        })
    }

    #[inline]
    pub fn level_width(&self, level: u32) -> u32 {
        (self.width >> level).max(1)
    }

    #[inline]
    pub fn level_height(&self, level: u32) -> u32 {
        (self.height >> level).max(1)
    }

    pub fn transcode_size(&self, level: u32, target: TargetFormat) -> Result<usize, TextureError> {
        if level >= self.levels {
            return Err(TextureError::OutOfBounds("nivel mip fuera de rango"));
        }
        target.transcoded_size_bytes(self.level_width(level), self.level_height(level))
    }

    fn decompress_level(&self, level: u32) -> Result<Vec<u8>, TextureError> {
        let entry = self
            .level_index
            .get(level as usize)
            .ok_or(TextureError::OutOfBounds("nivel fuera de rango"))?;
        let payload = &self.raw[entry.byte_offset..entry.byte_offset + entry.byte_length];
        let limit = if entry.uncompressed_byte_length > 0 {
            entry.uncompressed_byte_length.min(MAX_UNCOMPRESSED_LEVEL_BYTES)
        } else {
            MAX_UNCOMPRESSED_LEVEL_BYTES
        };

        match self.supercompression {
            KTX2_SS_NONE => Ok(payload.to_vec()),
            KTX2_SS_ZLIB => {
                let out = miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(payload, limit)
                    .map_err(|e| TextureError::CorruptStream(format!("Zlib error: {e:?}")))?;
                if entry.uncompressed_byte_length > 0 && out.len() != entry.uncompressed_byte_length {
                    return Err(TextureError::CorruptStream("tamaño descomprimido Zlib no coincide".into()));
                }
                Ok(out)
            }
            KTX2_SS_ZSTANDARD => {
                let mut dec = ruzstd::decoding::StreamingDecoder::new(Cursor::new(payload))
                    .map_err(|e| TextureError::CorruptStream(format!("Zstd init error: {e}")))?;
                let mut out = if entry.uncompressed_byte_length > 0 {
                    Vec::with_capacity(entry.uncompressed_byte_length.min(MAX_UNCOMPRESSED_LEVEL_BYTES))
                } else {
                    Vec::new()
                };
                let mut chunk = [0u8; 16384];
                loop {
                    let n = dec
                        .read(&mut chunk)
                        .map_err(|e| TextureError::CorruptStream(format!("Zstd read error: {e}")))?;
                    if n == 0 {
                        break;
                    }
                    if out.len() + n > MAX_UNCOMPRESSED_LEVEL_BYTES {
                        return Err(TextureError::OutOfBounds("nivel Zstd excede 256 MB"));
                    }
                    out.extend_from_slice(&chunk[..n]);
                }
                if entry.uncompressed_byte_length > 0 && out.len() != entry.uncompressed_byte_length {
                    return Err(TextureError::CorruptStream("tamaño descomprimido Zstd no coincide".into()));
                }
                Ok(out)
            }
            _ => Err(TextureError::UnsupportedFormat("esquema de supercompresión inesperado".into())),
        }
    }

    pub fn transcode_level(
        &self,
        level: u32,
        layer: u32,
        face: u32,
        target: TargetFormat,
    ) -> Result<Vec<u8>, TextureError> {
        if level >= self.levels || layer >= self.layers || face >= self.faces {
            return Err(TextureError::OutOfBounds("índice level/layer/face fuera de rango"));
        }

        let w = self.level_width(level);
        let h = self.level_height(level);

        if self.source_format == SourceFormat::Etc1s {
            let sgd = self
                .basislz_sgd
                .as_ref()
                .ok_or(TextureError::InvalidHeader("falta BasisLZ SGD"))?;
            let entry = &self.level_index[level as usize];
            let bw = ((w as usize) + 3) / 4;
            let bh = ((h as usize) + 3) / 4;

            let image_idx_for = |l: u32| -> usize {
                (level as usize) * (self.layers as usize) * (self.faces as usize)
                    + (l as usize) * (self.faces as usize)
                    + (face as usize)
            };

            let target_idx = image_idx_for(layer);
            let target_desc = sgd
                .image_descs
                .get(target_idx)
                .ok_or(TextureError::OutOfBounds("image_desc BasisLZ"))?;

            // Si es P-frame de video, decodificamos secuencialmente los frames 0..=layer previos para reconstruir `prev_frame`.
            let start_layer = if (target_desc.image_flags & KTX2_IMAGE_IS_P_FRAME) != 0 {
                0
            } else {
                layer
            };

            let mut prev_rgb: Option<Vec<(u16, u16)>> = None;
            let mut prev_alpha: Option<Vec<(u16, u16)>> = None;
            let mut cur_rgb = Vec::new();
            let mut cur_alpha: Option<Vec<(u16, u16)>> = None;

            for l in start_layer..=layer {
                let idx = image_idx_for(l);
                let desc = sgd
                    .image_descs
                    .get(idx)
                    .ok_or(TextureError::OutOfBounds("image_desc BasisLZ"))?;
                let is_video = (desc.image_flags & KTX2_IMAGE_IS_P_FRAME) != 0;

                let rgb_start = entry
                    .byte_offset
                    .checked_add(desc.rgb_slice_byte_offset as usize)
                    .ok_or(TextureError::Truncated("slice RGB BasisLZ"))?;
                let rgb_end = rgb_start
                    .checked_add(desc.rgb_slice_byte_length as usize)
                    .ok_or(TextureError::Truncated("slice RGB BasisLZ"))?;
                if rgb_end > self.raw.len() {
                    return Err(TextureError::Truncated("slice RGB fuera de rango"));
                }
                cur_rgb = sgd.decode_slice_indices(
                    &self.raw[rgb_start..rgb_end],
                    bw,
                    bh,
                    is_video,
                    prev_rgb.as_deref(),
                )?;
                prev_rgb = Some(cur_rgb.clone());

                if desc.alpha_slice_byte_length > 0 {
                    let a_start = entry
                        .byte_offset
                        .checked_add(desc.alpha_slice_byte_offset as usize)
                        .ok_or(TextureError::Truncated("slice Alpha BasisLZ"))?;
                    let a_end = a_start
                        .checked_add(desc.alpha_slice_byte_length as usize)
                        .ok_or(TextureError::Truncated("slice Alpha BasisLZ"))?;
                    if a_end > self.raw.len() {
                        return Err(TextureError::Truncated("slice Alpha fuera de rango"));
                    }
                    let decoded_a = sgd.decode_slice_indices(
                        &self.raw[a_start..a_end],
                        bw,
                        bh,
                        is_video,
                        prev_alpha.as_deref(),
                    )?;
                    prev_alpha = Some(decoded_a.clone());
                    cur_alpha = Some(decoded_a);
                } else {
                    cur_alpha = None;
                }
            }

            return transcode_etc1s_level(
                &cur_rgb,
                cur_alpha.as_deref(),
                &sgd.endpoints,
                &sgd.selectors,
                w,
                h,
                target,
            );
        }

        let level_bytes = self.decompress_level(level)?;
        let total_images_in_level = (self.layers as usize) * (self.faces as usize);
        let image_slot = (layer as usize) * (self.faces as usize) + (face as usize);

        let image_slice_size = match self.source_format {
            SourceFormat::Uastc4x4 | SourceFormat::Astc4x4 | SourceFormat::Bc7 | SourceFormat::Bc3 | SourceFormat::Etc2Rgba => {
                (((w as usize) + 3) / 4) * (((h as usize) + 3) / 4) * 16
            }
            SourceFormat::Bc1 | SourceFormat::Etc2Rgb => {
                (((w as usize) + 3) / 4) * (((h as usize) + 3) / 4) * 8
            }
            SourceFormat::Rgba8 => (w as usize) * (h as usize) * 4,
            SourceFormat::Rgb8 => (w as usize) * (h as usize) * 3,
            SourceFormat::Rg8 => (w as usize) * (h as usize) * 2,
            SourceFormat::R8 => (w as usize) * (h as usize),
            SourceFormat::Etc1s => unreachable!(),
        };

        let slice_off = image_slot
            .checked_mul(image_slice_size)
            .ok_or(TextureError::OutOfBounds("offset imagen KTX2"))?;
        let slice_end = slice_off
            .checked_add(image_slice_size)
            .ok_or(TextureError::OutOfBounds("fin imagen KTX2"))?;
        if slice_end > level_bytes.len() || image_slot >= total_images_in_level {
            return Err(TextureError::Truncated("datos de imagen KTX2 insuficientes"));
        }
        let img = &level_bytes[slice_off..slice_end];

        match self.source_format {
            SourceFormat::Uastc4x4 => transcode_uastc_level(img, w, h, target),
            SourceFormat::Rgba8 => transcode_rgba_level(img, w, h, target),
            SourceFormat::Rgb8 => {
                let mut rgba = Vec::with_capacity((w as usize) * (h as usize) * 4);
                for rgb in img.chunks_exact(3) {
                    rgba.extend_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
                }
                transcode_rgba_level(&rgba, w, h, target)
            }
            SourceFormat::Rg8 => {
                let mut rgba = Vec::with_capacity((w as usize) * (h as usize) * 4);
                for rg in img.chunks_exact(2) {
                    rgba.extend_from_slice(&[rg[0], rg[1], 0, 255]);
                }
                transcode_rgba_level(&rgba, w, h, target)
            }
            SourceFormat::R8 => {
                let mut rgba = Vec::with_capacity((w as usize) * (h as usize) * 4);
                for &r in img {
                    rgba.extend_from_slice(&[r, r, r, 255]);
                }
                transcode_rgba_level(&rgba, w, h, target)
            }
            SourceFormat::Astc4x4 if target == TargetFormat::Astc4x4Rgba => Ok(img.to_vec()),
            SourceFormat::Bc7 if target == TargetFormat::Bc7Rgba => Ok(img.to_vec()),
            SourceFormat::Bc1 if target == TargetFormat::Bc1Rgb => Ok(img.to_vec()),
            SourceFormat::Bc3 if target == TargetFormat::Bc3Rgba => Ok(img.to_vec()),
            SourceFormat::Etc2Rgb if target == TargetFormat::Etc1Rgb => Ok(img.to_vec()),
            SourceFormat::Etc2Rgba if target == TargetFormat::Etc2Rgba => Ok(img.to_vec()),
            other => Err(TextureError::UnsupportedFormat(format!(
                "conversión directa de {other:?} a {target:?} no requerida"
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::etc1s::test_helpers::*;

    fn build_minimal_dfd(color_model: u8, transfer: u8, channel_type: u32, extra_samples: bool) -> Vec<u8> {
        let total = if extra_samples { 60usize } else { 44usize };
        let mut dfd = vec![0u8; total];
        dfd[0..4].copy_from_slice(&(total as u32).to_le_bytes());
        dfd[8..12].copy_from_slice(&((total - 4) as u32).to_le_bytes());
        dfd[12] = color_model;
        dfd[13] = 1; // BT.709
        dfd[14] = transfer;
        dfd[28..32].copy_from_slice(&(channel_type << 24).to_le_bytes());
        dfd
    }

    fn build_ktx2_single_level(
        vk_format: u32,
        w: u32,
        h: u32,
        ss: u32,
        dfd: &[u8],
        sgd: &[u8],
        level_data: &[u8],
        uncompressed_len: u64,
    ) -> Vec<u8> {
        let dfd_off = 80 + 24;
        let sgd_off = dfd_off + dfd.len();
        let lvl_off = sgd_off + sgd.len();

        let mut out = vec![0u8; lvl_off + level_data.len()];
        out[0..12].copy_from_slice(&KTX2_MAGIC);
        out[12..16].copy_from_slice(&vk_format.to_le_bytes());
        out[16..20].copy_from_slice(&1u32.to_le_bytes());
        out[20..24].copy_from_slice(&w.to_le_bytes());
        out[24..28].copy_from_slice(&h.to_le_bytes());
        out[36..40].copy_from_slice(&1u32.to_le_bytes()); // faces
        out[40..44].copy_from_slice(&1u32.to_le_bytes()); // levels
        out[44..48].copy_from_slice(&ss.to_le_bytes());
        out[48..52].copy_from_slice(&(dfd_off as u32).to_le_bytes());
        out[52..56].copy_from_slice(&(dfd.len() as u32).to_le_bytes());
        if !sgd.is_empty() {
            out[64..72].copy_from_slice(&(sgd_off as u64).to_le_bytes());
            out[72..80].copy_from_slice(&(sgd.len() as u64).to_le_bytes());
        }
        out[80..88].copy_from_slice(&(lvl_off as u64).to_le_bytes());
        out[88..96].copy_from_slice(&(level_data.len() as u64).to_le_bytes());
        out[96..104].copy_from_slice(&uncompressed_len.to_le_bytes());

        out[dfd_off..dfd_off + dfd.len()].copy_from_slice(dfd);
        if !sgd.is_empty() {
            out[sgd_off..sgd_off + sgd.len()].copy_from_slice(sgd);
        }
        out[lvl_off..].copy_from_slice(level_data);
        out
    }

    fn zlib_stored(data: &[u8]) -> Vec<u8> {
        // Zlib header CMF=0x78 FLG=0x01 + stored block BFINAL=1 BTYPE=00
        let mut out = vec![0x78, 0x01, 0x01];
        let len = data.len() as u16;
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&(!len).to_le_bytes());
        out.extend_from_slice(data);
        // Adler-32
        let mut s1 = 1u32;
        let mut s2 = 0u32;
        for &b in data {
            s1 = (s1 + b as u32) % 65521;
            s2 = (s2 + s1) % 65521;
        }
        let adler = (s2 << 16) | s1;
        out.extend_from_slice(&adler.to_be_bytes());
        out
    }

    #[test]
    fn ktx2_uastc_zlib_and_rgba_roundtrip() {
        // Bloque UASTC Mode 8 (sólido R=10, G=200, B=40, A=255)
        let mut blk = 0u128;
        blk |= 23; // 0x17 -> UASTC_HUFF_MODES[23] == 8
        blk |= (10u128) << 5;
        blk |= (200u128) << 13;
        blk |= (40u128) << 21;
        blk |= (255u128) << 29;
        let uastc_block = blk.to_le_bytes();
        let compressed = zlib_stored(&uastc_block);

        let dfd = build_minimal_dfd(KTX2_DF_MODEL_UASTC, KTX2_DF_TRANSFER_SRGB, 2, false);
        let ktx2_bytes = build_ktx2_single_level(0, 4, 4, KTX2_SS_ZLIB, &dfd, &[], &compressed, 16);

        let ktx = Ktx2Container::open(ktx2_bytes).unwrap();
        assert_eq!(ktx.width, 4);
        assert_eq!(ktx.height, 4);
        assert!(ktx.is_srgb);
        assert!(!ktx.has_alpha);

        let rgba = ktx.transcode_level(0, 0, 0, TargetFormat::Rgba32).unwrap();
        assert_eq!(rgba.len(), 64);
        assert_eq!(&rgba[0..4], &[10, 200, 40, 255]);

        let astc = ktx.transcode_level(0, 0, 0, TargetFormat::Astc4x4Rgba).unwrap();
        assert_eq!(astc, [0xFC, 0xFD, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 10, 10, 200, 200, 40, 40, 255, 255]);

        let bc7 = ktx.transcode_level(0, 0, 0, TargetFormat::Bc7Rgba).unwrap();
        assert_eq!(bc7.len(), 16);
    }

    #[test]
    fn ktx2_basislz_etc1s_with_alpha_roundtrip() {
        let mut ep_w = BitWriter::new();
        for _ in 0..4 {
            write_single_sym_huffman(&mut ep_w, 0);
        }
        ep_w.write_bits(0, 1);
        ep_w.write_bits(0, 4); // ep[0]: color5=[16,16,16] -> 132, inten=0
        let ep_bytes = ep_w.finish();

        let mut sel_w = BitWriter::new();
        sel_w.write_bits(0, 1);
        sel_w.write_bits(0, 1);
        sel_w.write_bits(1, 1);
        // selector index 2 (+2 en tabla 0) en todos los píxeles -> 0b10_10_10_10 = 0xAA
        for _ in 0..4 {
            sel_w.write_bits(0xAA, 8);
        }
        let sel_bytes = sel_w.finish();

        let mut tbl_w = BitWriter::new();
        write_single_sym_huffman(&mut tbl_w, 0b11_11_11_11);
        write_single_sym_huffman(&mut tbl_w, 0);
        write_single_sym_huffman(&mut tbl_w, 0);
        write_single_sym_huffman(&mut tbl_w, 0);
        tbl_w.write_bits(64, 13);
        let tbl_bytes = tbl_w.finish();

        let slice = [0u8; 2];
        let mut level_blob = Vec::new();
        level_blob.extend_from_slice(&slice);
        level_blob.extend_from_slice(&slice);

        let mut sgd = Vec::new();
        sgd.extend_from_slice(&1u16.to_le_bytes());
        sgd.extend_from_slice(&1u16.to_le_bytes());
        sgd.extend_from_slice(&(ep_bytes.len() as u32).to_le_bytes());
        sgd.extend_from_slice(&(sel_bytes.len() as u32).to_le_bytes());
        sgd.extend_from_slice(&(tbl_bytes.len() as u32).to_le_bytes());
        sgd.extend_from_slice(&0u32.to_le_bytes());
        // image_desc[0]: RGB at 0, Alpha at 2
        sgd.extend_from_slice(&0u32.to_le_bytes());
        sgd.extend_from_slice(&0u32.to_le_bytes());
        sgd.extend_from_slice(&(slice.len() as u32).to_le_bytes());
        sgd.extend_from_slice(&(slice.len() as u32).to_le_bytes());
        sgd.extend_from_slice(&(slice.len() as u32).to_le_bytes());
        sgd.extend_from_slice(&ep_bytes);
        sgd.extend_from_slice(&sel_bytes);
        sgd.extend_from_slice(&tbl_bytes);

        let dfd = build_minimal_dfd(KTX2_DF_MODEL_ETC1S, 1, 0, true);
        let ktx2_bytes = build_ktx2_single_level(0, 4, 4, KTX2_SS_BASISLZ, &dfd, &sgd, &level_blob, 0);

        let ktx = Ktx2Container::open(ktx2_bytes).unwrap();
        assert!(ktx.has_alpha);
        assert!(!ktx.is_srgb);
        assert_eq!(ktx.source_format, SourceFormat::Etc1s);

        let rgba = ktx.transcode_level(0, 0, 0, TargetFormat::Rgba32).unwrap();
        assert_eq!(&rgba[0..4], &[134, 134, 134, 134]);

        let etc2 = ktx.transcode_level(0, 0, 0, TargetFormat::Etc2Rgba).unwrap();
        assert_eq!(etc2[0], 134); // EAC base alpha exacto
        assert_eq!(etc2[8], 16 << 3); // ETC1 base R exacto
    }
}
