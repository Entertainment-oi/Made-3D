pub mod bit;
pub mod error;
pub mod etc1s;
pub mod ktx2;
pub mod transcode;
pub mod uastc;

use core::slice;
use std::alloc::{alloc, dealloc, Layout};

use error::TextureError;
use ktx2::Ktx2Container;
use transcode::{TargetFormat, transcode_rgba_level, transcode_uastc_level};

pub struct Ktx2Handle {
    status: i32,
    error_message: String,
    container: Option<Ktx2Container>,
}

pub struct BytesHandle {
    status: i32,
    error_message: String,
    data: Vec<u8>,
}

fn error_code(err: &TextureError) -> i32 {
    match err {
        TextureError::InvalidHeader(_) => 1,
        TextureError::InvalidDfd(_) => 2,
        TextureError::Truncated(_) => 3,
        TextureError::UnsupportedFormat(_) => 4,
        TextureError::CorruptStream(_) => 5,
        TextureError::OutOfBounds(_) => 6,
    }
}

fn make_bytes_err(code: i32, msg: String) -> *mut BytesHandle {
    Box::into_raw(Box::new(BytesHandle {
        status: code,
        error_message: msg,
        data: Vec::new(),
    }))
}

#[no_mangle]
pub extern "C" fn mt_version() -> u32 {
    0x000100
}

#[no_mangle]
pub extern "C" fn mt_alloc(size: usize) -> *mut u8 {
    if size == 0 {
        return core::ptr::null_mut();
    }
    let Ok(layout) = Layout::from_size_align(size, 8) else {
        return core::ptr::null_mut();
    };
    unsafe { alloc(layout) }
}

#[no_mangle]
pub extern "C" fn mt_free(ptr: *mut u8, size: usize) {
    if ptr.is_null() || size == 0 {
        return;
    }
    if let Ok(layout) = Layout::from_size_align(size, 8) {
        unsafe { dealloc(ptr, layout) };
    }
}

#[no_mangle]
pub extern "C" fn mt_ktx2_open(input_ptr: *const u8, input_len: usize) -> *mut Ktx2Handle {
    if input_ptr.is_null() || input_len == 0 {
        return Box::into_raw(Box::new(Ktx2Handle {
            status: 1,
            error_message: String::from("MadeTexture: buffer KTX2 vacío o nulo"),
            container: None,
        }));
    }
    let bytes = unsafe { slice::from_raw_parts(input_ptr, input_len) }.to_vec();
    match Ktx2Container::open(bytes) {
        Ok(container) => Box::into_raw(Box::new(Ktx2Handle {
            status: 0,
            error_message: String::new(),
            container: Some(container),
        })),
        Err(err) => Box::into_raw(Box::new(Ktx2Handle {
            status: error_code(&err),
            error_message: err.to_string(),
            container: None,
        })),
    }
}

#[no_mangle]
pub extern "C" fn mt_ktx2_close(handle: *mut Ktx2Handle) {
    if !handle.is_null() {
        unsafe { drop(Box::from_raw(handle)) };
    }
}

#[no_mangle]
pub extern "C" fn mt_ktx2_status(handle: *const Ktx2Handle) -> i32 {
    if handle.is_null() {
        return 1;
    }
    unsafe { (*handle).status }
}

#[no_mangle]
pub extern "C" fn mt_ktx2_error_ptr(handle: *const Ktx2Handle) -> *const u8 {
    if handle.is_null() {
        return core::ptr::null();
    }
    let h = unsafe { &*handle };
    if h.error_message.is_empty() {
        core::ptr::null()
    } else {
        h.error_message.as_ptr()
    }
}

#[no_mangle]
pub extern "C" fn mt_ktx2_error_len(handle: *const Ktx2Handle) -> usize {
    if handle.is_null() {
        return 0;
    }
    unsafe { (*handle).error_message.len() }
}

#[no_mangle]
pub extern "C" fn mt_ktx2_width(handle: *const Ktx2Handle) -> u32 {
    if handle.is_null() {
        return 0;
    }
    unsafe { (*handle).container.as_ref().map_or(0, |c| c.width) }
}

#[no_mangle]
pub extern "C" fn mt_ktx2_height(handle: *const Ktx2Handle) -> u32 {
    if handle.is_null() {
        return 0;
    }
    unsafe { (*handle).container.as_ref().map_or(0, |c| c.height) }
}

#[no_mangle]
pub extern "C" fn mt_ktx2_levels(handle: *const Ktx2Handle) -> u32 {
    if handle.is_null() {
        return 0;
    }
    unsafe { (*handle).container.as_ref().map_or(0, |c| c.levels) }
}

#[no_mangle]
pub extern "C" fn mt_ktx2_layers(handle: *const Ktx2Handle) -> u32 {
    if handle.is_null() {
        return 0;
    }
    unsafe { (*handle).container.as_ref().map_or(0, |c| c.layers) }
}

#[no_mangle]
pub extern "C" fn mt_ktx2_faces(handle: *const Ktx2Handle) -> u32 {
    if handle.is_null() {
        return 0;
    }
    unsafe { (*handle).container.as_ref().map_or(0, |c| c.faces) }
}

#[no_mangle]
pub extern "C" fn mt_ktx2_has_alpha(handle: *const Ktx2Handle) -> u32 {
    if handle.is_null() {
        return 0;
    }
    unsafe { (*handle).container.as_ref().map_or(0, |c| u32::from(c.has_alpha)) }
}

#[no_mangle]
pub extern "C" fn mt_ktx2_is_srgb(handle: *const Ktx2Handle) -> u32 {
    if handle.is_null() {
        return 0;
    }
    unsafe { (*handle).container.as_ref().map_or(0, |c| u32::from(c.is_srgb)) }
}

#[no_mangle]
pub extern "C" fn mt_ktx2_source_format(handle: *const Ktx2Handle) -> u32 {
    if handle.is_null() {
        return u32::MAX;
    }
    unsafe {
        (*handle)
            .container
            .as_ref()
            .map_or(u32::MAX, |c| c.source_format as u32)
    }
}

#[no_mangle]
pub extern "C" fn mt_ktx2_level_width(handle: *const Ktx2Handle, level: u32) -> u32 {
    if handle.is_null() {
        return 0;
    }
    unsafe { (*handle).container.as_ref().map_or(0, |c| c.level_width(level)) }
}

#[no_mangle]
pub extern "C" fn mt_ktx2_level_height(handle: *const Ktx2Handle, level: u32) -> u32 {
    if handle.is_null() {
        return 0;
    }
    unsafe { (*handle).container.as_ref().map_or(0, |c| c.level_height(level)) }
}

#[no_mangle]
pub extern "C" fn mt_ktx2_transcode_size(
    handle: *const Ktx2Handle,
    level: u32,
    target_format: u32,
) -> usize {
    if handle.is_null() {
        return 0;
    }
    let h = unsafe { &*handle };
    let Some(c) = h.container.as_ref() else {
        return 0;
    };
    let Ok(tf) = TargetFormat::from_u32(target_format) else {
        return 0;
    };
    c.transcode_size(level, tf).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn mt_ktx2_transcode_level(
    handle: *const Ktx2Handle,
    level: u32,
    layer: u32,
    face: u32,
    target_format: u32,
) -> *mut BytesHandle {
    if handle.is_null() {
        return make_bytes_err(1, String::from("MadeTexture: handle KTX2 nulo"));
    }
    let h = unsafe { &*handle };
    let Some(c) = h.container.as_ref() else {
        return make_bytes_err(h.status.max(1), h.error_message.clone());
    };
    let tf = match TargetFormat::from_u32(target_format) {
        Ok(t) => t,
        Err(e) => return make_bytes_err(error_code(&e), e.to_string()),
    };
    match c.transcode_level(level, layer, face, tf) {
        Ok(data) => Box::into_raw(Box::new(BytesHandle {
            status: 0,
            error_message: String::new(),
            data,
        })),
        Err(err) => make_bytes_err(error_code(&err), err.to_string()),
    }
}

#[no_mangle]
pub extern "C" fn mt_transcode_uastc(
    input_ptr: *const u8,
    input_len: usize,
    width: u32,
    height: u32,
    target_format: u32,
) -> *mut BytesHandle {
    if input_ptr.is_null() || input_len == 0 {
        return make_bytes_err(1, String::from("MadeTexture: buffer UASTC vacío"));
    }
    let tf = match TargetFormat::from_u32(target_format) {
        Ok(t) => t,
        Err(e) => return make_bytes_err(error_code(&e), e.to_string()),
    };
    let bytes = unsafe { slice::from_raw_parts(input_ptr, input_len) };
    match transcode_uastc_level(bytes, width, height, tf) {
        Ok(data) => Box::into_raw(Box::new(BytesHandle {
            status: 0,
            error_message: String::new(),
            data,
        })),
        Err(err) => make_bytes_err(error_code(&err), err.to_string()),
    }
}

#[no_mangle]
pub extern "C" fn mt_transcode_rgba(
    input_ptr: *const u8,
    input_len: usize,
    width: u32,
    height: u32,
    target_format: u32,
) -> *mut BytesHandle {
    if input_ptr.is_null() || input_len == 0 {
        return make_bytes_err(1, String::from("MadeTexture: buffer RGBA vacío"));
    }
    let tf = match TargetFormat::from_u32(target_format) {
        Ok(t) => t,
        Err(e) => return make_bytes_err(error_code(&e), e.to_string()),
    };
    let bytes = unsafe { slice::from_raw_parts(input_ptr, input_len) };
    match transcode_rgba_level(bytes, width, height, tf) {
        Ok(data) => Box::into_raw(Box::new(BytesHandle {
            status: 0,
            error_message: String::new(),
            data,
        })),
        Err(err) => make_bytes_err(error_code(&err), err.to_string()),
    }
}

#[no_mangle]
pub extern "C" fn mt_bytes_status(handle: *const BytesHandle) -> i32 {
    if handle.is_null() {
        return 1;
    }
    unsafe { (*handle).status }
}

#[no_mangle]
pub extern "C" fn mt_bytes_ptr(handle: *const BytesHandle) -> *const u8 {
    if handle.is_null() {
        return core::ptr::null();
    }
    let h = unsafe { &*handle };
    if h.data.is_empty() {
        core::ptr::null()
    } else {
        h.data.as_ptr()
    }
}

#[no_mangle]
pub extern "C" fn mt_bytes_len(handle: *const BytesHandle) -> usize {
    if handle.is_null() {
        return 0;
    }
    unsafe { (*handle).data.len() }
}

#[no_mangle]
pub extern "C" fn mt_bytes_error_ptr(handle: *const BytesHandle) -> *const u8 {
    if handle.is_null() {
        return core::ptr::null();
    }
    let h = unsafe { &*handle };
    if h.error_message.is_empty() {
        core::ptr::null()
    } else {
        h.error_message.as_ptr()
    }
}

#[no_mangle]
pub extern "C" fn mt_bytes_error_len(handle: *const BytesHandle) -> usize {
    if handle.is_null() {
        return 0;
    }
    unsafe { (*handle).error_message.len() }
}

#[no_mangle]
pub extern "C" fn mt_bytes_free(handle: *mut BytesHandle) {
    if !handle.is_null() {
        unsafe { drop(Box::from_raw(handle)) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn c_abi_rgba_roundtrip_and_invalid_handle() {
        assert_eq!(mt_version(), 0x000100);
        let bad = mt_ktx2_open(core::ptr::null(), 0);
        assert_ne!(mt_ktx2_status(bad), 0);
        assert!(mt_ktx2_error_len(bad) > 0);
        mt_ktx2_close(bad);

        let rgba = vec![255u8; 4 * 4 * 4];
        let bh = mt_transcode_rgba(rgba.as_ptr(), rgba.len(), 4, 4, TargetFormat::Astc4x4Rgba as u32);
        assert_eq!(mt_bytes_status(bh), 0);
        assert_eq!(mt_bytes_len(bh), 16);
        let slice = unsafe { slice::from_raw_parts(mt_bytes_ptr(bh), mt_bytes_len(bh)) };
        assert_eq!(slice, &[0xFC, 0xFD, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 255, 255, 255, 255, 255, 255, 255, 255]);
        mt_bytes_free(bh);
    }
}
