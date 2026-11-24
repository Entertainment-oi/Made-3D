use crate::error::TextureError;

/// Lector de bits LSB-first sobre un slice de bytes.
pub struct BitReader<'a> {
    data: &'a [u8],
    byte_pos: usize,
    bit_buf: u64,
    bit_count: u32,
}

impl<'a> BitReader<'a> {
    #[inline]
    pub fn new(data: &'a [u8]) -> Self {
        Self {
            data,
            byte_pos: 0,
            bit_buf: 0,
            bit_count: 0,
        }
    }

    #[inline]
    fn refill(&mut self, needed: u32) {
        while self.bit_count < needed && self.byte_pos < self.data.len() {
            self.bit_buf |= (self.data[self.byte_pos] as u64) << self.bit_count;
            self.byte_pos += 1;
            self.bit_count += 8;
        }
    }

    /// Mira hasta 32 bits sin consumirlos (rellena con 0s si el stream terminó).
    #[inline]
    pub fn peek_bits_padded(&mut self, n: u32) -> u32 {
        debug_assert!(n <= 32);
        if n == 0 {
            return 0;
        }
        self.refill(n);
        let mask = if n == 32 { u32::MAX as u64 } else { (1u64 << n) - 1 };
        (self.bit_buf & mask) as u32
    }

    /// Consume `n` bits previamente inspeccionados.
    #[inline]
    pub fn consume_bits(&mut self, n: u32) -> Result<(), TextureError> {
        if n > self.bit_count {
            self.refill(n);
            if n > self.bit_count {
                return Err(TextureError::Truncated("fin de bitstream"));
            }
        }
        self.bit_buf >>= n;
        self.bit_count -= n;
        Ok(())
    }

    /// Lee `n` bits (0..=32) LSB-first con verificación de fin de stream.
    #[inline]
    pub fn read_bits(&mut self, n: u32) -> Result<u32, TextureError> {
        debug_assert!(n <= 32);
        if n == 0 {
            return Ok(0);
        }
        self.refill(n);
        if self.bit_count < n {
            return Err(TextureError::Truncated("fin inesperado al leer bits"));
        }
        let mask = if n == 32 { u32::MAX as u64 } else { (1u64 << n) - 1 };
        let val = (self.bit_buf & mask) as u32;
        if n == 64 {
            self.bit_buf = 0;
        } else {
            self.bit_buf >>= n;
        }
        self.bit_count -= n;
        Ok(val)
    }
}

/// Extrae `count` bits (1..=32) LSB-first a partir de `bit_offset` en un bloque de 128 bits.
#[inline]
pub fn extract_bits_128(block: u128, bit_offset: u32, count: u32) -> u32 {
    if count == 0 {
        return 0;
    }
    let mask = if count == 32 { u128::MAX >> 96 } else { (1u128 << count) - 1 };
    ((block >> bit_offset) & mask) as u32
}

/// Escritor de bits LSB-first dentro de un bloque de 128 bits.
#[inline]
pub fn write_bits_128(block: &mut u128, bit_offset: u32, count: u32, value: u32) {
    if count == 0 {
        return;
    }
    let mask = if count == 32 {
        0xFFFF_FFFFu128
    } else {
        (1u128 << count) - 1
    };
    *block &= !(mask << bit_offset);
    *block |= ((value as u128) & mask) << bit_offset;
}
