use crate::bitstream::{decode_zigzag_u32, encode_zigzag_i32, ByteReader, ByteWriter};
use crate::corner_table::{CornerTable, INVALID_CORNER};
use crate::error::{OptimizeError, Result};
use crate::rans::{decode_symbols_exact, encode_symbols, RAnsBitDecoder};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PredictionMethod {
    None = -2,
    Difference = 0,
    Parallelogram = 1,
    MultiParallelogram = 2,
    ConstrainedMultiParallelogram = 4,
    TexCoordsPortable = 5,
    GeometricNormal = 6,
}

impl PredictionMethod {
    pub fn from_i8(v: i8) -> Result<Self> {
        match v {
            -2 | -1 => Ok(Self::None),
            0 => Ok(Self::Difference),
            1 => Ok(Self::Parallelogram),
            2 => Ok(Self::MultiParallelogram),
            4 => Ok(Self::ConstrainedMultiParallelogram),
            5 => Ok(Self::TexCoordsPortable),
            6 => Ok(Self::GeometricNormal),
            _ => Err(OptimizeError::unsupported(format!(
                "Método de predicción Draco desconocido: {v}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PredictionTransformType {
    Delta = 0,
    Wrap = 1,
    NormalOctahedron = 2,
    NormalOctahedronCanonicalized = 3,
}

impl PredictionTransformType {
    pub fn from_i8(v: i8) -> Result<Self> {
        match v {
            0 | -1 => Ok(Self::Delta),
            1 => Ok(Self::Wrap),
            2 => Ok(Self::NormalOctahedron),
            3 => Ok(Self::NormalOctahedronCanonicalized),
            _ => Err(OptimizeError::unsupported(format!(
                "Transformación de predicción desconocida: {v}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct PredictionTransformData {
    pub kind_code: i8,
    pub min_value: i32,
    pub max_value: i32,
    pub center_x: i32,
    pub center_y: i32,
    pub max_quantized_value: i32,
}

pub fn decode_prediction_transform_header(
    transform_type: PredictionTransformType,
    reader: &mut ByteReader<'_>,
) -> Result<PredictionTransformData> {
    let mut data = PredictionTransformData {
        kind_code: transform_type as i8,
        ..Default::default()
    };
    match transform_type {
        PredictionTransformType::Delta => {}
        PredictionTransformType::Wrap => {
            data.min_value = reader.read_i32_le()?;
            data.max_value = reader.read_i32_le()?;
            if data.min_value > data.max_value {
                return Err(OptimizeError::corrupt(
                    "Rango inválido en WrapPredictionTransform",
                ));
            }
        }
        PredictionTransformType::NormalOctahedron => {
            data.max_quantized_value = reader.read_i32_le()?;
            data.center_x = reader.read_i32_le()?;
            data.center_y = reader.read_i32_le()?;
        }
        PredictionTransformType::NormalOctahedronCanonicalized => {
            data.max_quantized_value = reader.read_i32_le()?;
            data.center_x = reader.read_i32_le()?;
            data.center_y = data.center_x;
        }
    }
    Ok(data)
}

#[inline]
fn apply_wrap_clamp(val: i64, min_v: i64, max_v: i64) -> i32 {
    let range = max_v - min_v + 1;
    if range <= 0 {
        return val as i32;
    }
    let mut v = val;
    if v > max_v {
        v -= range;
    } else if v < min_v {
        v += range;
    }
    v as i32
}

#[inline]
fn compute_correction(pred: i64, corr: i32, transform: &PredictionTransformData) -> i32 {
    if transform.kind_code == PredictionTransformType::Wrap as i8 {
        let min_v = transform.min_value as i64;
        let max_v = transform.max_value as i64;
        let clamped = pred.clamp(min_v, max_v);
        apply_wrap_clamp(clamped + (corr as i64), min_v, max_v)
    } else {
        (pred + (corr as i64)) as i32
    }
}

/// Codifica enteros usando predicción diferencial + transformación Wrap (`[min_value, max_value]`) + rANS.
/// Totalmente compatible con `PredictionSchemeDeltaDecoder<Wrap>` de Google Draco.
pub fn encode_predicted_integers_wrap(
    values: &[i32],
    num_components: usize,
    min_value: i32,
    max_value: i32,
    writer: &mut ByteWriter,
) {
    let num_points = if num_components > 0 {
        values.len() / num_components
    } else {
        0
    };
    writer.write_i8(PredictionMethod::Difference as i8);
    writer.write_i8(PredictionTransformType::Wrap as i8);
    writer.write_u8(1); // compressed = true

    let range = (max_value as i64) - (min_value as i64) + 1;
    let half_range = range / 2;
    let mut syms = Vec::with_capacity(values.len());

    if num_points > 0 && num_components > 0 {
        for c in 0..num_components {
            syms.push(encode_zigzag_i32(values[c]));
        }
        for p in 1..num_points {
            let base = p * num_components;
            let prev = (p - 1) * num_components;
            for c in 0..num_components {
                let mut diff = (values[base + c] as i64) - (values[prev + c] as i64);
                if range > 1 {
                    if diff > half_range {
                        diff -= range;
                    } else if diff < -half_range {
                        diff += range;
                    }
                }
                syms.push(encode_zigzag_i32(diff as i32));
            }
        }
    }
    encode_symbols(&syms, num_components, writer);
    writer.write_i32_le(min_value);
    writer.write_i32_le(max_value);
}

/// Codifica enteros sin predicción (`PREDICTION_NONE = -2`) + ZigZag + rANS.
pub fn encode_unpredicted_integers(
    values: &[i32],
    num_components: usize,
    writer: &mut ByteWriter,
) {
    writer.write_i8(PredictionMethod::None as i8);
    writer.write_u8(1); // compressed = true
    let syms: Vec<u32> = values.iter().map(|&v| encode_zigzag_i32(v)).collect();
    encode_symbols(&syms, num_components, writer);
}

/// Decodifica y revierte la predicción sobre `num_points * num_components` enteros.
pub fn decode_predicted_integers(
    method: PredictionMethod,
    transform_type: PredictionTransformType,
    num_points: usize,
    num_components: usize,
    corner_table: Option<&CornerTable>,
    vertex_to_point: &[u32],
    reader: &mut ByteReader<'_>,
) -> Result<Vec<i32>> {
    if method == PredictionMethod::None {
        let total = num_points * num_components;
        let syms = decode_symbols_exact(total, num_components, reader)?;
        return Ok(syms.into_iter().map(decode_zigzag_u32).collect());
    }

    let total = num_points * num_components;
    let raw_syms = decode_symbols_exact(total, num_components, reader)?;
    let corrections: Vec<i32> = raw_syms.into_iter().map(decode_zigzag_u32).collect();

    let mut constrained_modes: Vec<(usize, Vec<bool>)> = Vec::new();
    match method {
        PredictionMethod::Difference
        | PredictionMethod::Parallelogram
        | PredictionMethod::MultiParallelogram => {}
        PredictionMethod::ConstrainedMultiParallelogram => {
            let max_num_preds = reader.read_u8()? as usize;
            for _ in 0..max_num_preds {
                let nbits = reader.read_varint_u32()? as usize;
                let mut bit_dec = RAnsBitDecoder::start_decoding(reader)?;
                let mut flags = Vec::with_capacity(nbits);
                for _ in 0..nbits {
                    flags.push(bit_dec.decode_next_bit());
                }
                constrained_modes.push((nbits, flags));
            }
        }
        PredictionMethod::TexCoordsPortable | PredictionMethod::GeometricNormal => {
            let count = reader.read_varint_u32()? as usize;
            let mut bit_dec = RAnsBitDecoder::start_decoding(reader)?;
            for _ in 0..count {
                let _ = bit_dec.decode_next_bit();
            }
        }
        PredictionMethod::None => {}
    }

    let transform = decode_prediction_transform_header(transform_type, reader)?;

    let mut out = vec![0i32; total];
    if num_points == 0 || num_components == 0 {
        return Ok(out);
    }

    match method {
        PredictionMethod::Difference
        | PredictionMethod::TexCoordsPortable
        | PredictionMethod::GeometricNormal => {
            for c in 0..num_components {
                out[c] = compute_correction(0, corrections[c], &transform);
            }
            for p in 1..num_points {
                let base = p * num_components;
                let prev = (p - 1) * num_components;
                for c in 0..num_components {
                    out[base + c] =
                        compute_correction(out[prev + c] as i64, corrections[base + c], &transform);
                }
            }
        }
        PredictionMethod::Parallelogram
        | PredictionMethod::MultiParallelogram
        | PredictionMethod::ConstrainedMultiParallelogram => {
            reconstruct_parallelogram(
                method,
                num_points,
                num_components,
                corner_table,
                vertex_to_point,
                &corrections,
                &transform,
                &constrained_modes,
                &mut out,
            );
        }
        PredictionMethod::None => {}
    }

    Ok(out)
}

#[allow(clippy::too_many_arguments)]
fn reconstruct_parallelogram(
    method: PredictionMethod,
    num_points: usize,
    num_components: usize,
    corner_table: Option<&CornerTable>,
    vertex_to_point: &[u32],
    corrections: &[i32],
    transform: &PredictionTransformData,
    constrained_modes: &[(usize, Vec<bool>)],
    out: &mut [i32],
) {
    for c in 0..num_components {
        out[c] = compute_correction(0, corrections[c], transform);
    }

    let Some(ct) = corner_table else {
        for p in 1..num_points {
            let base = p * num_components;
            let prev = (p - 1) * num_components;
            for c in 0..num_components {
                out[base + c] =
                    compute_correction(out[prev + c] as i64, corrections[base + c], transform);
            }
        }
        return;
    };

    let mut visited = vec![false; num_points];
    visited[0] = true;
    let mut mode_cursor = vec![0usize; constrained_modes.len()];

    for p in 1..num_points {
        let base = p * num_components;
        let corner = if p < ct.vertex_corners.len() {
            ct.vertex_corners[p]
        } else {
            INVALID_CORNER
        };

        let mut pred_accum = vec![0i64; num_components];
        let mut pred_count = 0i64;

        if corner >= 0 {
            let mut curr = corner;
            let mut steps = 0;
            while curr >= 0 && steps < 16 {
                let c_next = CornerTable::next(curr);
                let c_prev = CornerTable::previous(curr);
                let c_opp = ct.opposite(curr);
                if c_opp >= 0 {
                    let va = map_vertex(ct.vertex(c_next), vertex_to_point);
                    let vb = map_vertex(ct.vertex(c_prev), vertex_to_point);
                    let vc = map_vertex(ct.vertex(c_opp), vertex_to_point);
                    if let (Some(ia), Some(ib), Some(ic)) = (va, vb, vc) {
                        if ia < num_points
                            && ib < num_points
                            && ic < num_points
                            && visited[ia]
                            && visited[ib]
                            && visited[ic]
                        {
                            let use_pred = if method == PredictionMethod::ConstrainedMultiParallelogram
                                && !constrained_modes.is_empty()
                            {
                                let idx = pred_count.min((constrained_modes.len() - 1) as i64) as usize;
                                let (_, flags) = &constrained_modes[idx];
                                let cur = mode_cursor[idx];
                                mode_cursor[idx] = cur + 1;
                                flags.get(cur).copied().unwrap_or(true)
                            } else {
                                true
                            };

                            if use_pred {
                                for c in 0..num_components {
                                    let pa = out[ia * num_components + c] as i64;
                                    let pb = out[ib * num_components + c] as i64;
                                    let pc = out[ic * num_components + c] as i64;
                                    pred_accum[c] += pa + pb - pc;
                                }
                                pred_count += 1;
                                if method == PredictionMethod::Parallelogram {
                                    break;
                                }
                            }
                        }
                    }
                }
                curr = ct.swing_left(curr);
                if curr == corner {
                    break;
                }
                steps += 1;
            }
        }

        if pred_count > 0 {
            for c in 0..num_components {
                let pred = pred_accum[c] / pred_count;
                out[base + c] = compute_correction(pred, corrections[base + c], transform);
            }
        } else {
            let prev = (p - 1) * num_components;
            for c in 0..num_components {
                out[base + c] =
                    compute_correction(out[prev + c] as i64, corrections[base + c], transform);
            }
        }
        visited[p] = true;
    }
}

#[inline]
fn map_vertex(v: i32, vertex_to_point: &[u32]) -> Option<usize> {
    if v < 0 {
        return None;
    }
    let vu = v as usize;
    vertex_to_point.get(vu).map(|&p| p as usize).or(Some(vu))
}
