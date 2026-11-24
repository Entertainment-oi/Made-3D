use crate::error::{ErrorCode, OptimizeError, Result};

/// Lector secuencial seguro sobre un slice de bytes con verificación de límites.
pub struct ByteReader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> ByteReader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    #[inline]
    pub fn position(&self) -> usize {
        self.pos
    }

    #[inline]
    pub fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.pos)
    }

    #[inline]
    pub fn read_u8(&mut self) -> Result<u8> {
        let v = self
            .data
            .get(self.pos)
            .copied()
            .ok_or_else(|| OptimizeError::eof("read_u8"))?;
        self.pos += 1;
        Ok(v)
    }

    #[inline]
    pub fn read_i8(&mut self) -> Result<i8> {
        Ok(self.read_u8()? as i8)
    }

    #[inline]
    pub fn read_u16_le(&mut self) -> Result<u16> {
        let b = self.read_bytes(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    #[inline]
    pub fn read_u32_le(&mut self) -> Result<u32> {
        let b = self.read_bytes(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    #[inline]
    pub fn read_i32_le(&mut self) -> Result<i32> {
        let b = self.read_bytes(4)?;
        Ok(i32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    #[inline]
    pub fn read_f32_le(&mut self) -> Result<f32> {
        let b = self.read_bytes(4)?;
        Ok(f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    #[inline]
    pub fn read_bytes(&mut self, len: usize) -> Result<&'a [u8]> {
        if self.remaining() < len {
            return Err(OptimizeError::eof("read_bytes"));
        }
        let slice = &self.data[self.pos..self.pos + len];
        self.pos += len;
        Ok(slice)
    }

    pub fn read_varint_u32(&mut self) -> Result<u32> {
        let mut out: u32 = 0;
        let mut shift: u32 = 0;
        for _ in 0..5 {
            let b = self.read_u8()?;
            out |= ((b & 0x7F) as u32) << shift;
            if (b & 0x80) == 0 {
                return Ok(out);
            }
            shift += 7;
        }
        Err(OptimizeError::new(
            ErrorCode::CorruptBitstream,
            "Varint u32 excede 5 bytes",
        ))
    }

    pub fn read_varint_u64(&mut self) -> Result<u64> {
        let mut out: u64 = 0;
        let mut shift: u32 = 0;
        for _ in 0..10 {
            let b = self.read_u8()?;
            out |= ((b & 0x7F) as u64) << shift;
            if (b & 0x80) == 0 {
                return Ok(out);
            }
            shift += 7;
        }
        Err(OptimizeError::new(
            ErrorCode::CorruptBitstream,
            "Varint u64 excede 10 bytes",
        ))
    }
}

/// Escritor secuencial para construir bitstreams Draco y salidas optimizadas.
pub struct ByteWriter {
    pub buf: Vec<u8>,
}

impl ByteWriter {
    pub fn with_capacity(cap: usize) -> Self {
        Self {
            buf: Vec::with_capacity(cap),
        }
    }

    #[inline]
    pub fn write_u8(&mut self, v: u8) {
        self.buf.push(v);
    }

    #[inline]
    pub fn write_i8(&mut self, v: i8) {
        self.buf.push(v as u8);
    }

    #[inline]
    pub fn write_u16_le(&mut self, v: u16) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    #[inline]
    pub fn write_u32_le(&mut self, v: u32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    #[inline]
    pub fn write_i32_le(&mut self, v: i32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    #[inline]
    pub fn write_f32_le(&mut self, v: f32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    #[inline]
    pub fn write_bytes(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    pub fn write_varint_u32(&mut self, mut v: u32) {
        loop {
            let mut byte = (v & 0x7F) as u8;
            v >>= 7;
            if v != 0 {
                byte |= 0x80;
            }
            self.buf.push(byte);
            if v == 0 {
                break;
            }
        }
    }

    pub fn write_varint_u64(&mut self, mut v: u64) {
        loop {
            let mut byte = (v & 0x7F) as u8;
            v >>= 7;
            if v != 0 {
                byte |= 0x80;
            }
            self.buf.push(byte);
            if v == 0 {
                break;
            }
        }
    }
}

/// Lector de bits LSB-first sobre un slice de bytes.
pub struct BitReader<'a> {
    data: &'a [u8],
    bit_offset: usize,
}

impl<'a> BitReader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self {
            data,
            bit_offset: 0,
        }
    }

    pub fn read_bits(&mut self, num_bits: u32) -> Result<u32> {
        if num_bits == 0 {
            return Ok(0);
        }
        if num_bits > 32 {
            return Err(OptimizeError::corrupt("read_bits > 32 no soportado"));
        }
        let total_bits = self.data.len() * 8;
        if self.bit_offset + (num_bits as usize) > total_bits {
            return Err(OptimizeError::eof("BitReader::read_bits"));
        }

        let mut val: u32 = 0;
        for i in 0..num_bits {
            let byte_idx = self.bit_offset >> 3;
            let bit_idx = self.bit_offset & 7;
            let bit = ((self.data[byte_idx] >> bit_idx) & 1) as u32;
            val |= bit << i;
            self.bit_offset += 1;
        }
        Ok(val)
    }
}

/// Decodificación ZigZag de u32 -> i32.
#[inline]
pub fn decode_zigzag_u32(val: u32) -> i32 {
    ((val >> 1) as i32) ^ (-((val & 1) as i32))
}

/// Codificación ZigZag de i32 -> u32.
#[inline]
pub fn encode_zigzag_i32(val: i32) -> u32 {
    ((val << 1) ^ (val >> 31)) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varint_and_zigzag_roundtrip() {
        let mut w = ByteWriter::with_capacity(16);
        w.write_varint_u32(300);
        w.write_varint_u32(5);
        w.write_varint_u64(123456789);
        let mut r = ByteReader::new(&w.buf);
        assert_eq!(r.read_varint_u32().unwrap(), 300);
        assert_eq!(r.read_varint_u32().unwrap(), 5);
        assert_eq!(r.read_varint_u64().unwrap(), 123456789);

        for v in [-1000, -2, -1, 0, 1, 2, 1000] {
            assert_eq!(decode_zigzag_u32(encode_zigzag_i32(v)), v);
        }
    }
}
