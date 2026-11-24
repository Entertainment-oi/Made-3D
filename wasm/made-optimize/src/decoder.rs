use crate::bitstream::ByteReader;
use crate::connectivity::{
    decode_edgebreaker_connectivity, decode_sequential_connectivity, DecodedConnectivity,
};
use crate::error::{ErrorCode, OptimizeError, Result};
use crate::metadata::{decode_geometry_metadata, GeometryMetadata};
use crate::prediction::{
    decode_predicted_integers, PredictionMethod, PredictionTransformType,
};
use crate::transform::{
    decode_attribute_transform, decode_octahedral_normals, dequantize_to_f32,
    normalize_gltf_integers, normalize_skin_weights, AttributeTransform, AttributeTransformType,
};

pub const DRACO_MAGIC: [u8; 5] = *b"DRACO";

#[repr(u32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeometryType {
    PointCloud = 0,
    TriangularMesh = 1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DracoDataType {
    Invalid = 0,
    Int8 = 1,
    Uint8 = 2,
    Int16 = 3,
    Uint16 = 4,
    Int32 = 5,
    Uint32 = 6,
    Int64 = 7,
    Uint64 = 8,
    Float32 = 9,
    Float64 = 10,
    Bool = 11,
}

impl DracoDataType {
    pub fn from_u8(v: u8) -> Result<Self> {
        match v {
            1 => Ok(Self::Int8),
            2 => Ok(Self::Uint8),
            3 => Ok(Self::Int16),
            4 => Ok(Self::Uint16),
            5 => Ok(Self::Int32),
            6 => Ok(Self::Uint32),
            7 => Ok(Self::Int64),
            8 => Ok(Self::Uint64),
            9 => Ok(Self::Float32),
            10 => Ok(Self::Float64),
            11 => Ok(Self::Bool),
            _ => Err(OptimizeError::new(
                ErrorCode::InvalidAttribute,
                format!("Tipo de dato Draco desconocido: {v}"),
            )),
        }
    }
}

#[derive(Debug, Clone)]
pub struct DecodedAttribute {
    pub attribute_type: u8,
    pub data_type: DracoDataType,
    pub num_components: u8,
    pub normalized: bool,
    pub unique_id: u32,
    pub values_f32: Vec<f32>,
}

#[derive(Debug, Clone)]
pub struct DecodedGeometry {
    pub geometry_type: GeometryType,
    pub major_version: u8,
    pub minor_version: u8,
    pub num_points: u32,
    pub num_faces: u32,
    pub indices: Vec<u32>,
    pub attributes: Vec<DecodedAttribute>,
    pub metadata: Option<GeometryMetadata>,
}

impl DecodedGeometry {
    pub fn postprocess_gltf_attribute(
        &mut self,
        unique_id: u32,
        gltf_component_type: u32,
        gltf_normalized: bool,
        is_weights: bool,
    ) {
        if let Some(attr) = self.attributes.iter_mut().find(|a| a.unique_id == unique_id) {
            if gltf_normalized && gltf_component_type != 0 {
                normalize_gltf_integers(&mut attr.values_f32, gltf_component_type);
            }
            if is_weights {
                normalize_skin_weights(&mut attr.values_f32);
            }
        }
    }
}

#[derive(Debug, Clone)]
struct AttrHeader {
    attribute_type: u8,
    data_type: DracoDataType,
    num_components: u8,
    normalized: bool,
    unique_id: u32,
    seq_decoder_type: u8,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy)]
struct AttrDecoderMeta {
    data_id: u8,
    decoder_type: u8,
    traversal_method: u8,
}

enum PortableAttributeData {
    Float32Raw(Vec<f32>),
    Ints(Vec<i32>),
}

/// Decodifica un buffer binario Draco completo (`.drc` o `KHR_draco_mesh_compression`).
pub fn decode_draco(data: &[u8]) -> Result<DecodedGeometry> {
    let mut reader = ByteReader::new(data);

    let magic = reader.read_bytes(5)?;
    if magic != DRACO_MAGIC {
        return Err(OptimizeError::new(
            ErrorCode::InvalidHeader,
            "Cabecera inválida: no comienza con 'DRACO'",
        ));
    }

    let major_version = reader.read_u8()?;
    let minor_version = reader.read_u8()?;
    if !(1..=2).contains(&major_version) {
        return Err(OptimizeError::new(
            ErrorCode::UnsupportedVersion,
            format!("Versión Draco no soportada: {major_version}.{minor_version}"),
        ));
    }

    let encoder_type = reader.read_u8()?;
    let encoder_method = reader.read_u8()?;
    let flags = reader.read_u16_le()?;

    let geometry_type = match encoder_type {
        0 => GeometryType::PointCloud,
        1 => GeometryType::TriangularMesh,
        _ => {
            return Err(OptimizeError::unsupported(format!(
                "encoder_type Draco desconocido: {encoder_type}"
            )));
        }
    };

    let metadata = if (flags & 0x8000) != 0 {
        Some(decode_geometry_metadata(&mut reader)?)
    } else {
        None
    };

    let connectivity = match geometry_type {
        GeometryType::PointCloud => {
            let num_points = reader.read_varint_u32()? as usize;
            DecodedConnectivity {
                num_points,
                num_faces: 0,
                indices: Vec::new(),
                corner_table: None,
                vertex_to_point_map: (0..num_points as u32).collect(),
            }
        }
        GeometryType::TriangularMesh => match encoder_method {
            0 => decode_sequential_connectivity(&mut reader)?,
            1 => decode_edgebreaker_connectivity(&mut reader, major_version, minor_version)?,
            _ => {
                return Err(OptimizeError::unsupported(format!(
                    "encoder_method de malla desconocido: {encoder_method}"
                )));
            }
        },
    };

    // ParseAttributeDecodersData según especificación estándar Draco
    let num_attr_decoders = reader.read_u8()? as usize;
    let mut decoder_metas = Vec::with_capacity(num_attr_decoders);
    if geometry_type == GeometryType::TriangularMesh && encoder_method == 1 && major_version >= 2 {
        for _ in 0..num_attr_decoders {
            let data_id = reader.read_u8()?;
            let decoder_type = reader.read_u8()?;
            let traversal_method = reader.read_u8()?;
            decoder_metas.push(AttrDecoderMeta {
                data_id,
                decoder_type,
                traversal_method,
            });
        }
    }

    let mut decoder_groups: Vec<Vec<AttrHeader>> = Vec::with_capacity(num_attr_decoders);
    for _ in 0..num_attr_decoders {
        let num_attrs = reader.read_varint_u32()? as usize;
        let mut headers = Vec::with_capacity(num_attrs);
        for _ in 0..num_attrs {
            let attribute_type = reader.read_u8()?;
            let data_type = DracoDataType::from_u8(reader.read_u8()?)?;
            let num_components = reader.read_u8()?;
            let normalized = reader.read_u8()? != 0;
            let unique_id = reader.read_varint_u32()?;
            headers.push(AttrHeader {
                attribute_type,
                data_type,
                num_components,
                normalized,
                unique_id,
                seq_decoder_type: 0,
            });
        }

        if major_version >= 2 {
            for h in &mut headers {
                if reader.remaining() > 0 {
                    h.seq_decoder_type = reader.read_u8()?;
                }
            }
        }
        decoder_groups.push(headers);
    }

    let _ = &decoder_metas;
    let num_points = connectivity.num_points;
    let mut all_attributes = Vec::new();

    for headers in decoder_groups {
        // Fase 1: DecodePortableAttributes para todos los atributos del decodificador
        let mut portables = Vec::with_capacity(headers.len());
        for h in &headers {
            let comps = h.num_components as usize;
            let portable = decode_portable_attribute(h, num_points, comps, &connectivity, &mut reader)?;
            portables.push(portable);
        }

        // Fase 2: DecodeDataNeededByPortableTransforms para todos los atributos del decodificador
        let mut transforms = Vec::with_capacity(headers.len());
        for h in &headers {
            let comps = h.num_components as usize;
            let transform_type = match h.seq_decoder_type {
                2 => AttributeTransformType::Quantization,
                3 => AttributeTransformType::NormalOctahedron,
                _ => AttributeTransformType::None,
            };
            let transform = if transform_type != AttributeTransformType::None && num_points > 0 && comps > 0 {
                decode_attribute_transform(transform_type, comps, &mut reader)?
            } else {
                AttributeTransform::None
            };
            transforms.push(transform);
        }

        // Fase 3: TransformAttributesToOriginalFormat
        for ((h, portable), transform) in headers
            .into_iter()
            .zip(portables.into_iter())
            .zip(transforms.into_iter())
        {
            let comps = h.num_components as usize;
            let mut values_f32 = match portable {
                PortableAttributeData::Float32Raw(v) => v,
                PortableAttributeData::Ints(ints) => match transform {
                    AttributeTransform::Quantization {
                        min_values,
                        range,
                        quantization_bits,
                    } => dequantize_to_f32(&ints, comps, &min_values, range, quantization_bits),
                    AttributeTransform::NormalOctahedron { quantization_bits } => {
                        decode_octahedral_normals(&ints, quantization_bits)
                    }
                    AttributeTransform::None => ints.into_iter().map(|v| v as f32).collect(),
                },
            };

            if h.normalized {
                let gltf_ct = match h.data_type {
                    DracoDataType::Int8 => 5120,
                    DracoDataType::Uint8 => 5121,
                    DracoDataType::Int16 => 5122,
                    DracoDataType::Uint16 => 5123,
                    DracoDataType::Uint32 => 5125,
                    _ => 0,
                };
                if gltf_ct != 0 {
                    normalize_gltf_integers(&mut values_f32, gltf_ct);
                }
            }

            all_attributes.push(DecodedAttribute {
                attribute_type: h.attribute_type,
                data_type: h.data_type,
                num_components: h.num_components,
                normalized: h.normalized,
                unique_id: h.unique_id,
                values_f32,
            });
        }
    }

    Ok(DecodedGeometry {
        geometry_type,
        major_version,
        minor_version,
        num_points: connectivity.num_points as u32,
        num_faces: connectivity.num_faces as u32,
        indices: connectivity.indices,
        attributes: all_attributes,
        metadata,
    })
}

fn decode_portable_attribute(
    h: &AttrHeader,
    num_points: usize,
    comps: usize,
    connectivity: &DecodedConnectivity,
    reader: &mut ByteReader<'_>,
) -> Result<PortableAttributeData> {
    if num_points == 0 || comps == 0 {
        return Ok(PortableAttributeData::Float32Raw(Vec::new()));
    }

    if h.seq_decoder_type == 0 {
        let total = num_points * comps;
        if h.data_type == DracoDataType::Float32 {
            let mut out = Vec::with_capacity(total);
            for _ in 0..total {
                out.push(reader.read_f32_le()?);
            }
            return Ok(PortableAttributeData::Float32Raw(out));
        }
        return Ok(PortableAttributeData::Ints(read_raw_integers(
            total,
            h.data_type,
            reader,
        )?));
    }

    let pred_method_raw = reader.read_i8()?;
    let pred_method = PredictionMethod::from_i8(pred_method_raw)?;
    let pred_transform = if pred_method != PredictionMethod::None {
        PredictionTransformType::from_i8(reader.read_i8()?)?
    } else {
        PredictionTransformType::Delta
    };

    let compressed = reader.read_u8()? != 0;
    let effective_comps = if h.seq_decoder_type == 3 { 2 } else { comps };

    let ints = if compressed {
        decode_predicted_integers(
            pred_method,
            pred_transform,
            num_points,
            effective_comps,
            connectivity.corner_table.as_ref(),
            &connectivity.vertex_to_point_map,
            reader,
        )?
    } else {
        read_raw_integers(num_points * effective_comps, h.data_type, reader)?
    };

    Ok(PortableAttributeData::Ints(ints))
}

fn read_raw_integers(
    count: usize,
    data_type: DracoDataType,
    reader: &mut ByteReader<'_>,
) -> Result<Vec<i32>> {
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let v = match data_type {
            DracoDataType::Int8 => reader.read_i8()? as i32,
            DracoDataType::Uint8 | DracoDataType::Bool => reader.read_u8()? as i32,
            DracoDataType::Int16 => {
                let b = reader.read_bytes(2)?;
                i16::from_le_bytes([b[0], b[1]]) as i32
            }
            DracoDataType::Uint16 => reader.read_u16_le()? as i32,
            DracoDataType::Int32 => reader.read_i32_le()?,
            DracoDataType::Uint32 => reader.read_u32_le()? as i32,
            DracoDataType::Float32 => reader.read_f32_le()?.to_bits() as i32,
            _ => {
                return Err(OptimizeError::unsupported(format!(
                    "Tipo entero crudo no soportado: {data_type:?}"
                )));
            }
        };
        out.push(v);
    }
    Ok(out)
}
