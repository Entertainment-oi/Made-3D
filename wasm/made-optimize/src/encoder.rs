use crate::bitstream::ByteWriter;
use crate::connectivity::encode_sequential_connectivity;
use crate::decoder::{DracoDataType, DRACO_MAGIC};
use crate::error::{OptimizeError, Result};
use crate::prediction::{encode_predicted_integers_wrap, encode_unpredicted_integers};
use crate::transform::{encode_octahedral_normals, quantize_from_f32};

#[derive(Debug, Clone)]
pub struct EncodeAttributeInput<'a> {
    pub attribute_type: u8,
    pub num_components: u8,
    pub unique_id: u32,
    /// `0` = sin cuantización (Float32 directo), `> 0` = bits de cuantización (p. ej. 14 para pos, 10 para normales, 12 para UV).
    pub quantization_bits: u8,
    pub values: &'a [f32],
}

#[derive(Debug, Clone)]
pub struct EncodeMeshInput<'a> {
    pub num_points: usize,
    pub indices: &'a [u32],
    pub attributes: Vec<EncodeAttributeInput<'a>>,
}

enum EncodedTransformData {
    None,
    Quantization {
        min_values: Vec<f32>,
        range: f32,
        bits: u8,
    },
    NormalOctahedron {
        bits: u8,
    },
}

/// Codifica una malla triangular en un bitstream Draco v2.2 estándar (modo Sequential comprimido),
/// 100% compatible con decodificadores Google Draco externos y con `MadeOptimize`.
pub fn encode_draco_mesh(input: &EncodeMeshInput<'_>) -> Result<Vec<u8>> {
    if input.indices.len() % 3 != 0 {
        return Err(OptimizeError::corrupt(
            "La cantidad de índices debe ser múltiplo de 3",
        ));
    }

    let mut writer = ByteWriter::with_capacity(256 + input.indices.len() * 2);

    // 1. Cabecera estándar Draco v2.2
    writer.write_bytes(&DRACO_MAGIC);
    writer.write_u8(2); // major
    writer.write_u8(2); // minor
    writer.write_u8(1); // TRIANGULAR_MESH
    writer.write_u8(0); // SEQUENTIAL
    writer.write_u16_le(0); // flags = 0

    // 2. Conectividad secuencial comprimida
    encode_sequential_connectivity(input.indices, input.num_points, &mut writer);

    // 3. Cabeceras de atributos (MeshSequentialDecoder no escribe data_id/decoder_type/traversal_method)
    writer.write_u8(1); // num_attributes_decoders
    writer.write_varint_u32(input.attributes.len() as u32);

    let mut seq_types = Vec::with_capacity(input.attributes.len());
    for attr in &input.attributes {
        let comps = attr.num_components as usize;
        if attr.values.len() != input.num_points * comps {
            return Err(OptimizeError::corrupt(format!(
                "Longitud inválida en atributo unique_id={}: esperado {}, recibido {}",
                attr.unique_id,
                input.num_points * comps,
                attr.values.len()
            )));
        }

        let is_octahedral_normal =
            attr.attribute_type == 1 && attr.num_components == 3 && attr.quantization_bits > 0;
        let seq_type = if attr.quantization_bits == 0 {
            0u8
        } else if is_octahedral_normal {
            3u8
        } else {
            2u8
        };
        seq_types.push(seq_type);

        writer.write_u8(attr.attribute_type);
        writer.write_u8(DracoDataType::Float32 as u8);
        writer.write_u8(attr.num_components);
        writer.write_u8(0); // normalized = false
        writer.write_varint_u32(attr.unique_id);
    }

    for &st in &seq_types {
        writer.write_u8(st);
    }

    // 4. Fase 1 (EncodePortableAttributes): todos los valores portables/predichos primero
    let mut deferred_transforms = Vec::with_capacity(input.attributes.len());
    for (attr, &seq_type) in input.attributes.iter().zip(seq_types.iter()) {
        let comps = attr.num_components as usize;
        if input.num_points == 0 || comps == 0 {
            deferred_transforms.push(EncodedTransformData::None);
            continue;
        }
        match seq_type {
            0 => {
                for &v in attr.values {
                    writer.write_f32_le(v);
                }
                deferred_transforms.push(EncodedTransformData::None);
            }
            2 => {
                let bits = attr.quantization_bits.clamp(2, 24);
                let (quantized, min_values, range) = quantize_from_f32(attr.values, comps, bits);
                let max_quant = ((1u32 << bits) - 1) as i32;
                encode_predicted_integers_wrap(&quantized, comps, 0, max_quant, &mut writer);
                deferred_transforms.push(EncodedTransformData::Quantization {
                    min_values,
                    range,
                    bits,
                });
            }
            3 => {
                let bits = attr.quantization_bits.clamp(4, 16);
                let oct = encode_octahedral_normals(attr.values, bits);
                encode_unpredicted_integers(&oct, 2, &mut writer);
                deferred_transforms.push(EncodedTransformData::NormalOctahedron { bits });
            }
            _ => unreachable!(),
        }
    }

    // 5. Fase 2 (EncodeDataNeededByPortableTransform): parámetros de cuantización/octaedro al final
    for td in deferred_transforms {
        match td {
            EncodedTransformData::None => {}
            EncodedTransformData::Quantization {
                min_values,
                range,
                bits,
            } => {
                for mv in min_values {
                    writer.write_f32_le(mv);
                }
                writer.write_f32_le(range);
                writer.write_u8(bits);
            }
            EncodedTransformData::NormalOctahedron { bits } => {
                writer.write_u8(bits);
            }
        }
    }

    Ok(writer.buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decoder::{decode_draco, GeometryType};

    #[test]
    fn draco_encode_decode_full_roundtrip() {
        let positions: [f32; 12] = [
            0.0, 0.0, 0.0,
            1.0, 0.0, 0.0,
            1.0, 1.0, 0.0,
            0.0, 1.0, 0.0,
        ];
        let normals: [f32; 12] = [
            0.0, 0.0, 1.0,
            0.0, 0.0, 1.0,
            0.0, 0.0, 1.0,
            0.0, 0.0, 1.0,
        ];
        let uvs: [f32; 8] = [0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0];
        let indices: [u32; 6] = [0, 1, 2, 0, 2, 3];

        let encoded = encode_draco_mesh(&EncodeMeshInput {
            num_points: 4,
            indices: &indices,
            attributes: vec![
                EncodeAttributeInput {
                    attribute_type: 0, // POSITION
                    num_components: 3,
                    unique_id: 0,
                    quantization_bits: 14,
                    values: &positions,
                },
                EncodeAttributeInput {
                    attribute_type: 1, // NORMAL (octahedral)
                    num_components: 3,
                    unique_id: 1,
                    quantization_bits: 10,
                    values: &normals,
                },
                EncodeAttributeInput {
                    attribute_type: 3, // TEX_COORD
                    num_components: 2,
                    unique_id: 2,
                    quantization_bits: 12,
                    values: &uvs,
                },
            ],
        })
        .unwrap();

        let decoded = decode_draco(&encoded).unwrap();
        assert_eq!(decoded.geometry_type, GeometryType::TriangularMesh);
        assert_eq!(decoded.num_points, 4);
        assert_eq!(decoded.num_faces, 2);
        assert_eq!(decoded.indices, indices);
        assert_eq!(decoded.attributes.len(), 3);

        for (a, b) in positions.iter().zip(decoded.attributes[0].values_f32.iter()) {
            assert!((a - b).abs() < 1e-3);
        }
        for (a, b) in normals.iter().zip(decoded.attributes[1].values_f32.iter()) {
            assert!((a - b).abs() < 0.01);
        }
        for (a, b) in uvs.iter().zip(decoded.attributes[2].values_f32.iter()) {
            assert!((a - b).abs() < 1e-3);
        }
    }
}
