use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TextureError {
    InvalidHeader(&'static str),
    InvalidDfd(&'static str),
    Truncated(&'static str),
    UnsupportedFormat(String),
    CorruptStream(String),
    OutOfBounds(&'static str),
}

impl fmt::Display for TextureError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TextureError::InvalidHeader(s) => write!(f, "MadeTexture: cabecera KTX2 inválida: {s}"),
            TextureError::InvalidDfd(s) => write!(f, "MadeTexture: DFD inválido: {s}"),
            TextureError::Truncated(s) => write!(f, "MadeTexture: buffer truncado ({s})"),
            TextureError::UnsupportedFormat(s) => write!(f, "MadeTexture: formato no soportado: {s}"),
            TextureError::CorruptStream(s) => write!(f, "MadeTexture: flujo corrupto: {s}"),
            TextureError::OutOfBounds(s) => write!(f, "MadeTexture: índice fuera de rango ({s})"),
        }
    }
}

impl std::error::Error for TextureError {}
