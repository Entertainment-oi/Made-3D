use core::fmt;

#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    Ok = 0,
    InvalidHeader = -1,
    UnsupportedVersion = -2,
    UnexpectedEof = -3,
    CorruptBitstream = -4,
    UnsupportedMethod = -5,
    InvalidAttribute = -6,
    AllocationFailed = -7,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OptimizeError {
    pub code: ErrorCode,
    pub message: String,
}

impl OptimizeError {
    pub fn new(code: ErrorCode, msg: impl Into<String>) -> Self {
        Self {
            code,
            message: msg.into(),
        }
    }

    pub fn eof(ctx: &str) -> Self {
        Self::new(
            ErrorCode::UnexpectedEof,
            format!("Fin inesperado del bitstream en: {ctx}"),
        )
    }

    pub fn corrupt(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::CorruptBitstream, msg)
    }

    pub fn unsupported(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::UnsupportedMethod, msg)
    }
}

impl fmt::Display for OptimizeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{:?}] {}", self.code, self.message)
    }
}

impl std::error::Error for OptimizeError {}

pub type Result<T> = core::result::Result<T, OptimizeError>;
