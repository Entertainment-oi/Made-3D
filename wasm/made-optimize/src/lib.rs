pub mod bitstream;
pub mod connectivity;
pub mod corner_table;
pub mod decoder;
pub mod encoder;
pub mod error;
pub mod meshopt;
pub mod metadata;
pub mod optimize;
pub mod prediction;
pub mod rans;
pub mod transform;

use core::slice;
use std::alloc::{alloc, dealloc, Layout};

use decoder::{decode_draco, DecodedGeometry, GeometryType};
use encoder::{encode_draco_mesh, EncodeAttributeInput, EncodeMeshInput};
use error::ErrorCode;
use meshopt::{
    decode_index_buffer, decode_index_sequence, decode_vertex_buffer, MeshoptFilter, MeshoptMode,
};
use optimize::{optimize_mesh, optimize_mesh_with_attributes, OptimizedMesh};

pub struct DecodeHandle {
    status: i32,
    error_message: String,
    geometry: Option<DecodedGeometry>,
    indices_u16: Vec<u16>,
}

pub struct BytesHandle {
    status: i32,
    error_message: String,
    data: Vec<u8>,
}

pub struct EncodeAttrStorage {
    attribute_type: u8,
    num_components: u8,
    unique_id: u32,
    quantization_bits: u8,
    values: Vec<f32>,
}

pub struct EncodeBuilder {
    num_points: usize,
    indices: Vec<u32>,
    attrs: Vec<EncodeAttrStorage>,
}

pub struct OptimizeHandle {
    mesh: OptimizedMesh,
}

#[no_mangle]
pub extern "C" fn mo_alloc(size: usize) -> *mut u8 {
    if size == 0 {
        return core::ptr::null_mut();
    }
    let Ok(layout) = Layout::from_size_align(size, 8) else {
        return core::ptr::null_mut();
    };
    unsafe { alloc(layout) }
}

#[no_mangle]
pub extern "C" fn mo_free(ptr: *mut u8, size: usize) {
    if ptr.is_null() || size == 0 {
        return;
    }
    if let Ok(layout) = Layout::from_size_align(size, 8) {
        unsafe { dealloc(ptr, layout) };
    }
}

// ============================================================================
// 1. DECODIFICADOR DRACO
// ============================================================================

#[no_mangle]
pub extern "C" fn mo_draco_decode(input_ptr: *const u8, input_len: usize) -> *mut DecodeHandle {
    if input_ptr.is_null() || input_len == 0 {
        return Box::into_raw(Box::new(DecodeHandle {
            status: ErrorCode::InvalidHeader as i32,
            error_message: String::from("Buffer de entrada vacío o nulo"),
            geometry: None,
            indices_u16: Vec::new(),
        }));
    }

    let bytes = unsafe { slice::from_raw_parts(input_ptr, input_len) };
    let handle = match decode_draco(bytes) {
        Ok(geo) => {
            let indices_u16 = if geo.num_points <= 65535 {
                geo.indices.iter().map(|&v| v as u16).collect()
            } else {
                Vec::new()
            };
            Box::new(DecodeHandle {
                status: ErrorCode::Ok as i32,
                error_message: String::new(),
                geometry: Some(geo),
                indices_u16,
            })
        }
        Err(err) => Box::new(DecodeHandle {
            status: err.code as i32,
            error_message: err.message,
            geometry: None,
            indices_u16: Vec::new(),
        }),
    };
    Box::into_raw(handle)
}

#[no_mangle]
pub extern "C" fn mo_result_status(handle: *const DecodeHandle) -> i32 {
    let Some(h) = (unsafe { handle.as_ref() }) else {
        return ErrorCode::AllocationFailed as i32;
    };
    h.status
}

#[no_mangle]
pub extern "C" fn mo_result_error_ptr(handle: *const DecodeHandle) -> *const u8 {
    let Some(h) = (unsafe { handle.as_ref() }) else {
        return core::ptr::null();
    };
    h.error_message.as_ptr()
}

#[no_mangle]
pub extern "C" fn mo_result_error_len(handle: *const DecodeHandle) -> usize {
    let Some(h) = (unsafe { handle.as_ref() }) else {
        return 0;
    };
    h.error_message.len()
}

#[no_mangle]
pub extern "C" fn mo_result_geometry_type(handle: *const DecodeHandle) -> u32 {
    let Some(h) = (unsafe { handle.as_ref() }) else {
        return 0;
    };
    h.geometry
        .as_ref()
        .map(|g| match g.geometry_type {
            GeometryType::PointCloud => 0,
            GeometryType::TriangularMesh => 1,
        })
        .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn mo_result_num_points(handle: *const DecodeHandle) -> u32 {
    let Some(h) = (unsafe { handle.as_ref() }) else {
        return 0;
    };
    h.geometry.as_ref().map(|g| g.num_points).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn mo_result_num_faces(handle: *const DecodeHandle) -> u32 {
    let Some(h) = (unsafe { handle.as_ref() }) else {
        return 0;
    };
    h.geometry.as_ref().map(|g| g.num_faces).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn mo_result_indices_is_u16(handle: *const DecodeHandle) -> u32 {
    let Some(h) = (unsafe { handle.as_ref() }) else {
        return 0;
    };
    if h.indices_u16.is_empty() { 0 } else { 1 }
}

#[no_mangle]
pub extern "C" fn mo_result_indices_len(handle: *const DecodeHandle) -> usize {
    let Some(h) = (unsafe { handle.as_ref() }) else {
        return 0;
    };
    h.geometry.as_ref().map(|g| g.indices.len()).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn mo_result_indices_u16_ptr(handle: *const DecodeHandle) -> *const u16 {
    let Some(h) = (unsafe { handle.as_ref() }) else {
        return core::ptr::null();
    };
    h.indices_u16.as_ptr()
}

#[no_mangle]
pub extern "C" fn mo_result_indices_u32_ptr(handle: *const DecodeHandle) -> *const u32 {
    let Some(h) = (unsafe { handle.as_ref() }) else {
        return core::ptr::null();
    };
    h.geometry
        .as_ref()
        .map(|g| g.indices.as_ptr())
        .unwrap_or(core::ptr::null())
}

#[no_mangle]
pub extern "C" fn mo_result_attr_count(handle: *const DecodeHandle) -> usize {
    let Some(h) = (unsafe { handle.as_ref() }) else {
        return 0;
    };
    h.geometry.as_ref().map(|g| g.attributes.len()).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn mo_result_attr_unique_id(handle: *const DecodeHandle, idx: usize) -> u32 {
    let Some(h) = (unsafe { handle.as_ref() }) else {
        return 0;
    };
    h.geometry
        .as_ref()
        .and_then(|g| g.attributes.get(idx))
        .map(|a| a.unique_id)
        .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn mo_result_attr_type(handle: *const DecodeHandle, idx: usize) -> u32 {
    let Some(h) = (unsafe { handle.as_ref() }) else {
        return 0;
    };
    h.geometry
        .as_ref()
        .and_then(|g| g.attributes.get(idx))
        .map(|a| a.attribute_type as u32)
        .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn mo_result_attr_components(handle: *const DecodeHandle, idx: usize) -> u32 {
    let Some(h) = (unsafe { handle.as_ref() }) else {
        return 0;
    };
    h.geometry
        .as_ref()
        .and_then(|g| g.attributes.get(idx))
        .map(|a| a.num_components as u32)
        .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn mo_result_attr_f32_len(handle: *const DecodeHandle, idx: usize) -> usize {
    let Some(h) = (unsafe { handle.as_ref() }) else {
        return 0;
    };
    h.geometry
        .as_ref()
        .and_then(|g| g.attributes.get(idx))
        .map(|a| a.values_f32.len())
        .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn mo_result_attr_f32_ptr(handle: *const DecodeHandle, idx: usize) -> *const f32 {
    let Some(h) = (unsafe { handle.as_ref() }) else {
        return core::ptr::null();
    };
    h.geometry
        .as_ref()
        .and_then(|g| g.attributes.get(idx))
        .map(|a| a.values_f32.as_ptr())
        .unwrap_or(core::ptr::null())
}

#[no_mangle]
pub extern "C" fn mo_result_postprocess_gltf(
    handle: *mut DecodeHandle,
    unique_id: u32,
    gltf_component_type: u32,
    gltf_normalized: u32,
    is_weights: u32,
) {
    let Some(h) = (unsafe { handle.as_mut() }) else {
        return;
    };
    if let Some(geo) = h.geometry.as_mut() {
        geo.postprocess_gltf_attribute(
            unique_id,
            gltf_component_type,
            gltf_normalized != 0,
            is_weights != 0,
        );
    }
}

#[no_mangle]
pub extern "C" fn mo_result_free(handle: *mut DecodeHandle) {
    if !handle.is_null() {
        unsafe { drop(Box::from_raw(handle)) };
    }
}

// ============================================================================
// 2. CODIFICADOR / COMPRESOR DRACO
// ============================================================================

#[no_mangle]
pub extern "C" fn mo_draco_encode_begin(
    num_points: usize,
    indices_ptr: *const u32,
    indices_len: usize,
) -> *mut EncodeBuilder {
    let indices = if !indices_ptr.is_null() && indices_len > 0 {
        unsafe { slice::from_raw_parts(indices_ptr, indices_len) }.to_vec()
    } else {
        (0..num_points as u32).collect()
    };
    Box::into_raw(Box::new(EncodeBuilder {
        num_points,
        indices,
        attrs: Vec::new(),
    }))
}

#[no_mangle]
pub extern "C" fn mo_draco_encode_add_attr(
    builder: *mut EncodeBuilder,
    attribute_type: u8,
    num_components: u8,
    unique_id: u32,
    quantization_bits: u8,
    values_ptr: *const f32,
    values_len: usize,
) {
    if values_ptr.is_null() || values_len == 0 {
        return;
    }
    let Some(b) = (unsafe { builder.as_mut() }) else {
        return;
    };
    let values = unsafe { slice::from_raw_parts(values_ptr, values_len) }.to_vec();
    b.attrs.push(EncodeAttrStorage {
        attribute_type,
        num_components,
        unique_id,
        quantization_bits,
        values,
    });
}

#[no_mangle]
pub extern "C" fn mo_draco_encode_finish(builder: *mut EncodeBuilder) -> *mut BytesHandle {
    if builder.is_null() {
        return Box::into_raw(Box::new(BytesHandle {
            status: ErrorCode::AllocationFailed as i32,
            error_message: String::from("EncodeBuilder nulo"),
            data: Vec::new(),
        }));
    }
    let b = unsafe { Box::from_raw(builder) };
    let attrs: Vec<EncodeAttributeInput<'_>> = b
        .attrs
        .iter()
        .map(|a| EncodeAttributeInput {
            attribute_type: a.attribute_type,
            num_components: a.num_components,
            unique_id: a.unique_id,
            quantization_bits: a.quantization_bits,
            values: &a.values,
        })
        .collect();

    let res = encode_draco_mesh(&EncodeMeshInput {
        num_points: b.num_points,
        indices: &b.indices,
        attributes: attrs,
    });

    match res {
        Ok(data) => Box::into_raw(Box::new(BytesHandle {
            status: ErrorCode::Ok as i32,
            error_message: String::new(),
            data,
        })),
        Err(err) => Box::into_raw(Box::new(BytesHandle {
            status: err.code as i32,
            error_message: err.message,
            data: Vec::new(),
        })),
    }
}

// ============================================================================
// 3. DECODIFICADOR MESHOPT (EXT_meshopt_compression)
// ============================================================================

#[no_mangle]
pub extern "C" fn mo_meshopt_decode(
    src_ptr: *const u8,
    src_len: usize,
    count: usize,
    stride: usize,
    mode: u32,
    filter: u32,
) -> *mut BytesHandle {
    if src_ptr.is_null() || src_len == 0 {
        return Box::into_raw(Box::new(BytesHandle {
            status: ErrorCode::InvalidHeader as i32,
            error_message: String::from("Buffer Meshopt vacío o nulo"),
            data: Vec::new(),
        }));
    }
    let src = unsafe { slice::from_raw_parts(src_ptr, src_len) };
    let m = match mode {
        0 => MeshoptMode::Attributes,
        1 => MeshoptMode::Triangles,
        _ => MeshoptMode::Indices,
    };
    let f = match filter {
        1 => MeshoptFilter::Octahedral,
        2 => MeshoptFilter::Quaternion,
        3 => MeshoptFilter::Exponential,
        _ => MeshoptFilter::None,
    };

    let res = match m {
        MeshoptMode::Attributes => decode_vertex_buffer(count, stride, src, f),
        MeshoptMode::Triangles => decode_index_buffer(count, stride, src),
        MeshoptMode::Indices => decode_index_sequence(count, stride, src),
    };

    match res {
        Ok(data) => Box::into_raw(Box::new(BytesHandle {
            status: ErrorCode::Ok as i32,
            error_message: String::new(),
            data,
        })),
        Err(err) => Box::into_raw(Box::new(BytesHandle {
            status: err.code as i32,
            error_message: err.message,
            data: Vec::new(),
        })),
    }
}

#[no_mangle]
pub extern "C" fn mo_bytes_status(handle: *const BytesHandle) -> i32 {
    let Some(h) = (unsafe { handle.as_ref() }) else {
        return ErrorCode::AllocationFailed as i32;
    };
    h.status
}

#[no_mangle]
pub extern "C" fn mo_bytes_ptr(handle: *const BytesHandle) -> *const u8 {
    let Some(h) = (unsafe { handle.as_ref() }) else {
        return core::ptr::null();
    };
    h.data.as_ptr()
}

#[no_mangle]
pub extern "C" fn mo_bytes_len(handle: *const BytesHandle) -> usize {
    let Some(h) = (unsafe { handle.as_ref() }) else {
        return 0;
    };
    h.data.len()
}

#[no_mangle]
pub extern "C" fn mo_bytes_error_ptr(handle: *const BytesHandle) -> *const u8 {
    let Some(h) = (unsafe { handle.as_ref() }) else {
        return core::ptr::null();
    };
    h.error_message.as_ptr()
}

#[no_mangle]
pub extern "C" fn mo_bytes_error_len(handle: *const BytesHandle) -> usize {
    let Some(h) = (unsafe { handle.as_ref() }) else {
        return 0;
    };
    h.error_message.len()
}

#[no_mangle]
pub extern "C" fn mo_bytes_free(handle: *mut BytesHandle) {
    if !handle.is_null() {
        unsafe { drop(Box::from_raw(handle)) };
    }
}

// ============================================================================
// 4. OPTIMIZADOR GPU DE MALLAS (Deduplicación + Vertex Cache + Vertex Fetch)
// ============================================================================

#[no_mangle]
pub extern "C" fn mo_mesh_optimize(
    pos_ptr: *const f32,
    pos_len: usize,
    indices_ptr: *const u32,
    indices_len: usize,
    dedup_step: f32,
) -> *mut OptimizeHandle {
    let positions = if pos_ptr.is_null() || pos_len == 0 {
        &[]
    } else {
        unsafe { slice::from_raw_parts(pos_ptr, pos_len) }
    };
    let indices = if indices_ptr.is_null() || indices_len == 0 {
        None
    } else {
        Some(unsafe { slice::from_raw_parts(indices_ptr, indices_len) })
    };

    let mesh = optimize_mesh(positions, indices, dedup_step);
    Box::into_raw(Box::new(OptimizeHandle { mesh }))
}

#[no_mangle]
pub extern "C" fn mo_mesh_optimize_attrs(
    pos_ptr: *const f32,
    pos_len: usize,
    extra_ptr: *const f32,
    extra_len: usize,
    extra_stride: usize,
    indices_ptr: *const u32,
    indices_len: usize,
    dedup_step: f32,
) -> *mut OptimizeHandle {
    let positions = if pos_ptr.is_null() || pos_len == 0 {
        &[]
    } else {
        unsafe { slice::from_raw_parts(pos_ptr, pos_len) }
    };
    let extra_attrs = if extra_ptr.is_null() || extra_len == 0 || extra_stride == 0 {
        &[]
    } else {
        unsafe { slice::from_raw_parts(extra_ptr, extra_len) }
    };
    let indices = if indices_ptr.is_null() || indices_len == 0 {
        None
    } else {
        Some(unsafe { slice::from_raw_parts(indices_ptr, indices_len) })
    };

    let mesh = optimize_mesh_with_attributes(positions, extra_attrs, extra_stride, indices, dedup_step);
    Box::into_raw(Box::new(OptimizeHandle { mesh }))
}

#[no_mangle]
pub extern "C" fn mo_opt_num_points(handle: *const OptimizeHandle) -> usize {
    let Some(h) = (unsafe { handle.as_ref() }) else {
        return 0;
    };
    h.mesh.num_points
}

#[no_mangle]
pub extern "C" fn mo_opt_indices_len(handle: *const OptimizeHandle) -> usize {
    let Some(h) = (unsafe { handle.as_ref() }) else {
        return 0;
    };
    h.mesh.indices.len()
}

#[no_mangle]
pub extern "C" fn mo_opt_indices_ptr(handle: *const OptimizeHandle) -> *const u32 {
    let Some(h) = (unsafe { handle.as_ref() }) else {
        return core::ptr::null();
    };
    h.mesh.indices.as_ptr()
}

#[no_mangle]
pub extern "C" fn mo_opt_remap_ptr(handle: *const OptimizeHandle) -> *const u32 {
    let Some(h) = (unsafe { handle.as_ref() }) else {
        return core::ptr::null();
    };
    h.mesh.vertex_remap.as_ptr()
}

#[no_mangle]
pub extern "C" fn mo_opt_positions_ptr(handle: *const OptimizeHandle) -> *const f32 {
    let Some(h) = (unsafe { handle.as_ref() }) else {
        return core::ptr::null();
    };
    h.mesh.positions.as_ptr()
}

#[no_mangle]
pub extern "C" fn mo_opt_free(handle: *mut OptimizeHandle) {
    if !handle.is_null() {
        unsafe { drop(Box::from_raw(handle)) };
    }
}
