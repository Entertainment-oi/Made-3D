use crate::bitstream::ByteReader;
use crate::error::{OptimizeError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttributeTransformType {
    None = 0,
    Quantization = 1,
    NormalOctahedron = 2,
    NormalOctahedronCanonicalized = 3,
}

impl AttributeTransformType {
    pub fn from_u8(v: u8) -> Result<Self> {
        match v {
            0 => Ok(Self::None),
            1 => Ok(Self::Quantization),
            2 => Ok(Self::NormalOctahedron),
            3 => Ok(Self::NormalOctahedronCanonicalized),
            _ => Err(OptimizeError::unsupported(format!(
                "Transformación de atributo desconocida: {v}"
            ))),
        }
    }
}

#[derive(Debug, Clone)]
pub enum AttributeTransform {
    None,
    Quantization {
        min_values: Vec<f32>,
        range: f32,
        quantization_bits: u8,
    },
    NormalOctahedron {
        quantization_bits: u8,
    },
}

pub fn decode_attribute_transform(
    transform_type: AttributeTransformType,
    num_components: usize,
    reader: &mut ByteReader<'_>,
) -> Result<AttributeTransform> {
    match transform_type {
        AttributeTransformType::None => Ok(AttributeTransform::None),
        AttributeTransformType::Quantization => {
            let mut min_values = Vec::with_capacity(num_components);
            for _ in 0..num_components {
                min_values.push(reader.read_f32_le()?);
            }
            let range = reader.read_f32_le()?;
            let quantization_bits = reader.read_u8()?;
            if quantization_bits == 0 || quantization_bits > 31 {
                return Err(OptimizeError::corrupt(format!(
                    "quantization_bits inválido: {quantization_bits}"
                )));
            }
            Ok(AttributeTransform::Quantization {
                min_values,
                range,
                quantization_bits,
            })
        }
        AttributeTransformType::NormalOctahedron
        | AttributeTransformType::NormalOctahedronCanonicalized => {
            let quantization_bits = reader.read_u8()?;
            Ok(AttributeTransform::NormalOctahedron { quantization_bits })
        }
    }
}

/// Cuantiza un atributo `f32` a enteros `i32` devolviendo `(quantized, min_values, range)`.
pub fn quantize_from_f32(
    values: &[f32],
    num_components: usize,
    quantization_bits: u8,
) -> (Vec<i32>, Vec<f32>, f32) {
    if values.is_empty() || num_components == 0 {
        return (Vec::new(), vec![0.0; num_components], 0.0);
    }

    let mut min_values = vec![f32::INFINITY; num_components];
    let mut max_values = vec![f32::NEG_INFINITY; num_components];

    for (i, &v) in values.iter().enumerate() {
        let c = i % num_components;
        if v < min_values[c] {
            min_values[c] = v;
        }
        if v > max_values[c] {
            max_values[c] = v;
        }
    }

    let mut range = 0.0f32;
    for c in 0..num_components {
        let r = max_values[c] - min_values[c];
        if r > range {
            range = r;
        }
    }

    let max_quant_i32 = (1i32 << quantization_bits.clamp(1, 30)) - 1;
    let max_quant = max_quant_i32 as f32;
    let inv_delta = if range > 1e-12 { max_quant / range } else { 0.0 };

    let mut quantized = Vec::with_capacity(values.len());
    for (i, &v) in values.iter().enumerate() {
        let c = i % num_components;
        let q = (((v - min_values[c]) * inv_delta).round() as i32).clamp(0, max_quant_i32);
        quantized.push(q);
    }
    (quantized, min_values, range)
}

/// Decuantiza enteros cuantizados a `f32`.
pub fn dequantize_to_f32(
    quantized: &[i32],
    num_components: usize,
    min_values: &[f32],
    range: f32,
    quantization_bits: u8,
) -> Vec<f32> {
    let max_quant_value = ((1u32 << quantization_bits) - 1) as f32;
    let delta = if max_quant_value > 0.0 {
        range / max_quant_value
    } else {
        0.0
    };
    let mut out = Vec::with_capacity(quantized.len());
    for (i, &q) in quantized.iter().enumerate() {
        let comp = i % num_components;
        let min_v = min_values.get(comp).copied().unwrap_or(0.0);
        out.push(min_v + (q as f32) * delta);
    }
    out
}

/// Codifica normales 3D unitarias a pares octaédricos cuantizados `(s, t)` según `OctahedronToolBox` de Draco.
pub fn encode_octahedral_normals(normals: &[f32], quantization_bits: u8) -> Vec<i32> {
    let num_points = normals.len() / 3;
    let max_value = ((1i32 << quantization_bits.clamp(2, 16)) - 2).max(2) as f32;
    let center = max_value * 0.5;
    let mut out = Vec::with_capacity(num_points * 2);

    for p in 0..num_points {
        let mut x = normals[p * 3];
        let mut y = normals[p * 3 + 1];
        let mut z = normals[p * 3 + 2];
        let len = (x * x + y * y + z * z).sqrt();
        if len > 1e-8 {
            x /= len;
            y /= len;
            z /= len;
        } else {
            x = 1.0;
            y = 0.0;
            z = 0.0;
        }

        let l1 = x.abs() + y.abs() + z.abs();
        let mut ox = y / l1;
        let mut oy = z / l1;
        if x < 0.0 {
            let old_ox = ox;
            ox = (1.0 - oy.abs()) * if old_ox >= 0.0 { 1.0 } else { -1.0 };
            oy = (1.0 - old_ox.abs()) * if oy >= 0.0 { 1.0 } else { -1.0 };
        }

        let s = (ox * center + center).round().clamp(0.0, max_value) as i32;
        let t = (oy * center + center).round().clamp(0.0, max_value) as i32;
        out.push(s);
        out.push(t);
    }
    out
}

/// Decodifica normales octaédricas cuantizadas (2 enteros por punto -> 3 floats normalizados).
pub fn decode_octahedral_normals(quantized: &[i32], quantization_bits: u8) -> Vec<f32> {
    let num_points = quantized.len() / 2;
    let max_value = ((1i32 << quantization_bits) - 2).max(1) as f32;
    let center = max_value * 0.5;
    let mut out = Vec::with_capacity(num_points * 3);

    for p in 0..num_points {
        let s = ((quantized[p * 2] as f32) - center) / center;
        let t = ((quantized[p * 2 + 1] as f32) - center) / center;

        let mut y = s;
        let mut z = t;
        let x = 1.0 - y.abs() - z.abs();
        if x < 0.0 {
            let old_y = y;
            y = (1.0 - z.abs()) * if old_y >= 0.0 { 1.0 } else { -1.0 };
            z = (1.0 - old_y.abs()) * if z >= 0.0 { 1.0 } else { -1.0 };
        }
        let len = (x * x + y * y + z * z).sqrt();
        if len > 1e-8 {
            out.push(x / len);
            out.push(y / len);
            out.push(z / len);
        } else {
            out.push(1.0);
            out.push(0.0);
            out.push(0.0);
        }
    }
    out
}

/// Normaliza valores enteros glTF al rango `[0, 1]` o `[-1, 1]`.
pub fn normalize_gltf_integers(values: &mut [f32], gltf_component_type: u32) {
    let (div, signed) = match gltf_component_type {
        5120 => (127.0f32, true),
        5121 => (255.0f32, false),
        5122 => (32767.0f32, true),
        5123 => (65535.0f32, false),
        5125 => (4294967295.0f32, false),
        _ => return,
    };

    let mut max_abs = 0.0f32;
    for &v in values.iter() {
        let a = v.abs();
        if a > max_abs {
            max_abs = a;
        }
    }
    if max_abs > 1.001 {
        for v in values.iter_mut() {
            let scaled = *v / div;
            *v = if signed { scaled.max(-1.0) } else { scaled };
        }
    }
}

/// Normaliza pesos de skinning (`WEIGHTS_0`, VEC4) en una sola pasada dentro de WASM.
pub fn normalize_skin_weights(values: &mut [f32]) {
    for chunk in values.chunks_exact_mut(4) {
        let sum = chunk[0] + chunk[1] + chunk[2] + chunk[3];
        if sum > 0.0 && (sum - 1.0).abs() > 1e-4 {
            let inv = 1.0 / sum;
            chunk[0] *= inv;
            chunk[1] *= inv;
            chunk[2] *= inv;
            chunk[3] *= inv;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantize_and_octahedral_roundtrip() {
        let pts = vec![-1.0, 0.25, 0.5, 1.0, -0.5, 2.0];
        let (q, mins, range) = quantize_from_f32(&pts, 3, 14);
        let deq = dequantize_to_f32(&q, 3, &mins, range, 14);
        for (a, b) in pts.iter().zip(deq.iter()) {
            assert!((a - b).abs() < 1e-3);
        }

        let normals = vec![0.0, 0.0, 1.0, 0.57735, -0.57735, -0.57735];
        let oct = encode_octahedral_normals(&normals, 10);
        let dec = decode_octahedral_normals(&oct, 10);
        for (a, b) in normals.iter().zip(dec.iter()) {
            assert!((a - b).abs() < 0.015);
        }
    }
}
