use crate::bitstream::{BitReader, ByteReader, ByteWriter};
use crate::error::{OptimizeError, Result};

const DRACO_ANS_IO_BASE: u32 = 256;
const L_RANS_BIT_BASE: u32 = 0x1000;

#[derive(Clone, Copy)]
struct AnsState<'a> {
    buf: &'a [u8],
    buf_offset: usize,
    state: u32,
    l_base: u32,
}

impl<'a> AnsState<'a> {
    fn init(buf: &'a [u8], l_base: u32) -> Result<Self> {
        if buf.is_empty() {
            return Err(OptimizeError::corrupt("Buffer rANS vacío"));
        }
        let offset = buf.len();
        let top = buf[offset - 1] >> 6;
        let (buf_offset, raw_state) = match top {
            0 => (offset - 1, (buf[offset - 1] & 0x3F) as u32),
            1 => {
                if offset < 2 {
                    return Err(OptimizeError::eof("AnsState::init(1)"));
                }
                let v = u16::from_le_bytes([buf[offset - 2], buf[offset - 1]]) as u32;
                (offset - 2, v & 0x3FFF)
            }
            2 => {
                if offset < 3 {
                    return Err(OptimizeError::eof("AnsState::init(2)"));
                }
                let v = (buf[offset - 3] as u32)
                    | ((buf[offset - 2] as u32) << 8)
                    | ((buf[offset - 1] as u32) << 16);
                (offset - 3, v & 0x3F_FFFF)
            }
            _ => {
                if offset < 4 {
                    return Err(OptimizeError::eof("AnsState::init(3)"));
                }
                let v = u32::from_le_bytes([
                    buf[offset - 4],
                    buf[offset - 3],
                    buf[offset - 2],
                    buf[offset - 1],
                ]);
                (offset - 4, v & 0x3FFF_FFFF)
            }
        };

        Ok(Self {
            buf,
            buf_offset,
            state: raw_state + l_base,
            l_base,
        })
    }

    #[inline]
    fn empty(l_base: u32) -> Self {
        Self {
            buf: &[],
            buf_offset: 0,
            state: l_base,
            l_base,
        }
    }

    #[inline]
    fn refill(&mut self) {
        while self.state < self.l_base && self.buf_offset > 0 {
            self.buf_offset -= 1;
            self.state = self.state * DRACO_ANS_IO_BASE + (self.buf[self.buf_offset] as u32);
        }
    }

    #[inline]
    fn read_bit(&mut self, p0: u8) -> bool {
        if self.buf.is_empty() {
            return false;
        }
        if self.state < L_RANS_BIT_BASE && self.buf_offset > 0 {
            self.buf_offset -= 1;
            self.state = (self.state << 8) | (self.buf[self.buf_offset] as u32);
        }
        let quot = self.state >> 8;
        let rem = self.state & 0xFF;
        let p0_u = p0 as u32;
        let p = 256 - p0_u;
        if rem < p {
            self.state = quot * p + rem;
            true
        } else {
            self.state = quot * p0_u + rem - p;
            false
        }
    }
}

/// Decodificador binario rANS con probabilidad fija `prob_zero`.
pub struct RAnsBitDecoder<'a> {
    prob_zero: u8,
    ans: AnsState<'a>,
}

impl<'a> RAnsBitDecoder<'a> {
    pub fn start_decoding(reader: &mut ByteReader<'a>) -> Result<Self> {
        let prob_zero = reader.read_u8()?;
        let size_in_bytes = reader.read_u32_le()? as usize;
        if size_in_bytes == 0 {
            return Ok(Self {
                prob_zero,
                ans: AnsState::empty(L_RANS_BIT_BASE),
            });
        }
        let buf = reader.read_bytes(size_in_bytes)?;
        let ans = AnsState::init(buf, L_RANS_BIT_BASE)?;
        Ok(Self { prob_zero, ans })
    }

    #[inline]
    pub fn decode_next_bit(&mut self) -> bool {
        self.ans.read_bit(self.prob_zero)
    }
}

/// Decodificador binario rANS adaptativo (EdgeBreaker Predictive).
pub struct AdaptiveRAnsBitDecoder<'a> {
    p0_f: f64,
    ans: AnsState<'a>,
}

impl<'a> AdaptiveRAnsBitDecoder<'a> {
    pub fn start_decoding(reader: &mut ByteReader<'a>) -> Result<Self> {
        let size_in_bytes = reader.read_u32_le()? as usize;
        if size_in_bytes == 0 {
            return Ok(Self {
                p0_f: 0.5,
                ans: AnsState::empty(L_RANS_BIT_BASE),
            });
        }
        let buf = reader.read_bytes(size_in_bytes)?;
        let ans = AnsState::init(buf, L_RANS_BIT_BASE)?;
        Ok(Self { p0_f: 0.5, ans })
    }

    #[inline]
    pub fn decode_next_bit(&mut self) -> bool {
        let mut p0 = (self.p0_f * 256.0 + 0.5) as i32;
        if p0 < 1 {
            p0 = 1;
        } else if p0 > 255 {
            p0 = 255;
        }
        let bit = self.ans.read_bit(p0 as u8);
        self.p0_f = (self.p0_f * 127.0 + if bit { 0.0 } else { 1.0 }) / 128.0;
        bit
    }
}

#[derive(Clone, Copy)]
struct SymbolEntry {
    prob: u32,
    cum_prob: u32,
}

/// Decodificador rANS multi-símbolo con tabla de frecuencias y LUT rápida.
pub struct RAnsSymbolDecoder<'a> {
    precision_bits: u32,
    rans_precision: u32,
    probability_table: Vec<SymbolEntry>,
    lut_table: Vec<u32>,
    ans: Option<AnsState<'a>>,
}

impl<'a> RAnsSymbolDecoder<'a> {
    pub fn compute_precision_bits(max_bit_length: u32) -> u32 {
        let p = (3 * max_bit_length) / 2;
        p.clamp(12, 20)
    }

    pub fn create(max_bit_length: u32, reader: &mut ByteReader<'a>) -> Result<Self> {
        let precision_bits = Self::compute_precision_bits(max_bit_length);
        let rans_precision = 1u32 << precision_bits;
        let num_symbols = reader.read_varint_u32()? as usize;

        let mut probability_table = vec![
            SymbolEntry {
                prob: 0,
                cum_prob: 0
            };
            num_symbols
        ];
        let mut lut_table = vec![0u32; rans_precision as usize];

        let mut cum_prob: u32 = 0;
        let mut i = 0usize;
        while i < num_symbols {
            let prob_data = reader.read_u8()?;
            let token = prob_data & 3;
            if token == 3 {
                let offset = (prob_data >> 2) as usize;
                if i + offset >= num_symbols {
                    return Err(OptimizeError::corrupt(
                        "RLE de tabla rANS fuera de rango",
                    ));
                }
                i += offset + 1;
            } else {
                let mut prob = (prob_data >> 2) as u32;
                for j in 0..token {
                    let eb = reader.read_u8()? as u32;
                    prob |= eb << (8 * (j as u32) + 6);
                }
                if cum_prob + prob > rans_precision {
                    return Err(OptimizeError::corrupt(
                        "La suma de probabilidades rANS excede rans_precision",
                    ));
                }
                probability_table[i] = SymbolEntry { prob, cum_prob };
                for k in cum_prob..(cum_prob + prob) {
                    lut_table[k as usize] = i as u32;
                }
                cum_prob += prob;
                i += 1;
            }
        }

        if cum_prob != rans_precision && num_symbols > 0 {
            return Err(OptimizeError::corrupt(
                "La tabla de probabilidades rANS no suma rans_precision",
            ));
        }

        Ok(Self {
            precision_bits,
            rans_precision,
            probability_table,
            lut_table,
            ans: None,
        })
    }

    pub fn start_decoding(&mut self, reader: &mut ByteReader<'a>) -> Result<()> {
        let bytes_encoded = reader.read_varint_u64()? as usize;
        let buf = reader.read_bytes(bytes_encoded)?;
        let l_base = self.rans_precision * 4;
        self.ans = Some(AnsState::init(buf, l_base)?);
        Ok(())
    }

    #[inline]
    pub fn read_symbol(&mut self) -> Result<u32> {
        let ans = self
            .ans
            .as_mut()
            .ok_or_else(|| OptimizeError::corrupt("RAnsSymbolDecoder no inicializado"))?;
        ans.refill();
        let mask = self.rans_precision - 1;
        let rem = ans.state & mask;
        let sym = self.lut_table[rem as usize];
        let entry = self.probability_table[sym as usize];
        let quot = ans.state >> self.precision_bits;
        ans.state = quot * entry.prob + rem - entry.cum_prob;
        Ok(sym)
    }
}

/// Decodifica `num_values` símbolos u32 usando el esquema Draco (`TAGGED = 0` o `RAW = 1`).
pub fn decode_symbols_exact(
    num_values: usize,
    num_components: usize,
    reader: &mut ByteReader<'_>,
) -> Result<Vec<u32>> {
    if num_values == 0 {
        return Ok(Vec::new());
    }
    let scheme = reader.read_u8()?;
    match scheme {
        0 => decode_tagged_symbols_exact(num_values, num_components.max(1), reader),
        1 => decode_raw_symbols(num_values, reader),
        _ => Err(OptimizeError::unsupported(format!(
            "Esquema de símbolos Draco desconocido: {scheme}"
        ))),
    }
}

fn decode_tagged_symbols_exact(
    num_values: usize,
    num_components: usize,
    reader: &mut ByteReader<'_>,
) -> Result<Vec<u32>> {
    let mut sym_decoder = RAnsSymbolDecoder::create(5, reader)?;
    sym_decoder.start_decoding(reader)?;

    let total_tags = (num_values + num_components - 1) / num_components;
    let mut bit_lengths = Vec::with_capacity(total_tags);
    let mut total_bits: usize = 0;
    let mut rem_vals = num_values;

    for _ in 0..total_tags {
        let bl = sym_decoder.read_symbol()?;
        if bl > 32 {
            return Err(OptimizeError::corrupt("Longitud de bit etiquetada > 32"));
        }
        let count_in_tuple = rem_vals.min(num_components);
        total_bits += (bl as usize) * count_in_tuple;
        rem_vals -= count_in_tuple;
        bit_lengths.push(bl);
    }

    let bytes_needed = (total_bits + 7) >> 3;
    let raw_slice = reader.read_bytes(bytes_needed)?;
    let mut br = BitReader::new(raw_slice);
    let mut out = Vec::with_capacity(num_values);

    let mut k = 0;
    for bl in bit_lengths {
        for _ in 0..num_components {
            if k >= num_values {
                break;
            }
            out.push(br.read_bits(bl)?);
            k += 1;
        }
    }
    Ok(out)
}

fn decode_raw_symbols(num_values: usize, reader: &mut ByteReader<'_>) -> Result<Vec<u32>> {
    let max_bit_length = reader.read_u8()? as u32;
    let mut sym_decoder = RAnsSymbolDecoder::create(max_bit_length, reader)?;
    sym_decoder.start_decoding(reader)?;
    let mut out = Vec::with_capacity(num_values);
    for _ in 0..num_values {
        out.push(sym_decoder.read_symbol()?);
    }
    Ok(out)
}

/// Codifica símbolos u32 usando el formato estándar Draco (`TAGGED_SYMBOLS = 0` o `RAW_SYMBOLS = 1`).
/// El esquema Tagged (rANS de longitudes de bit + bits empacados LSB) soporta símbolos de hasta 32 bits
/// sin límite de alfabeto y es 100% compatible con todos los decodificadores Draco.
pub fn encode_symbols(
    symbols: &[u32],
    num_components: usize,
    writer: &mut ByteWriter,
) {
    if symbols.is_empty() {
        return;
    }

    let max_sym = symbols.iter().copied().max().unwrap_or(0);
    // Si el alfabeto es compacto (<= 4096 símbolos únicos), RAW_SYMBOLS es muy eficiente;
    // si tiene valores más grandes, TAGGED_SYMBOLS soporta hasta 32 bits sin límites.
    if max_sym < 4096 {
        encode_raw_symbols(symbols, max_sym, writer);
    } else {
        encode_tagged_symbols(symbols, num_components.max(1), writer);
    }
}

fn encode_raw_symbols(symbols: &[u32], max_sym: u32, writer: &mut ByteWriter) {
    writer.write_u8(1); // RAW_SYMBOLS
    let max_bit_length = if max_sym == 0 {
        1u32
    } else {
        (32 - max_sym.leading_zeros()).max(1)
    };
    writer.write_u8(max_bit_length as u8);

    let num_symbols = (max_sym as usize) + 1;
    let mut counts = vec![0u64; num_symbols];
    for &s in symbols {
        counts[s as usize] += 1;
    }

    let precision_bits = RAnsSymbolDecoder::compute_precision_bits(max_bit_length);
    let rans_precision = 1u32 << precision_bits;
    let probs = normalize_probabilities(&counts, rans_precision);

    write_rans_table_and_stream(symbols, &probs, precision_bits, writer);
}

fn encode_tagged_symbols(symbols: &[u32], num_components: usize, writer: &mut ByteWriter) {
    writer.write_u8(0); // TAGGED_SYMBOLS

    let num_values = symbols.len();
    let total_tags = (num_values + num_components - 1) / num_components;
    let mut bit_lengths = Vec::with_capacity(total_tags);

    for chunk in symbols.chunks(num_components) {
        let max_v = chunk.iter().copied().max().unwrap_or(0);
        let bl = if max_v == 0 {
            0u32
        } else {
            32 - max_v.leading_zeros()
        };
        bit_lengths.push(bl);
    }

    let mut counts = vec![0u64; 33];
    for &bl in &bit_lengths {
        counts[bl as usize] += 1;
    }

    let precision_bits = RAnsSymbolDecoder::compute_precision_bits(5);
    let rans_precision = 1u32 << precision_bits;
    let probs = normalize_probabilities(&counts, rans_precision);

    write_rans_table_and_stream(&bit_lengths, &probs, precision_bits, writer);

    // Empacar los bits LSB-first
    let mut bit_bytes = Vec::new();
    let mut cur_byte: u8 = 0;
    let mut bit_pos: u32 = 0;

    let mut sym_idx = 0;
    for bl in bit_lengths {
        for _ in 0..num_components {
            if sym_idx >= num_values {
                break;
            }
            let val = symbols[sym_idx];
            sym_idx += 1;
            for b in 0..bl {
                if ((val >> b) & 1) != 0 {
                    cur_byte |= 1 << bit_pos;
                }
                bit_pos += 1;
                if bit_pos == 8 {
                    bit_bytes.push(cur_byte);
                    cur_byte = 0;
                    bit_pos = 0;
                }
            }
        }
    }
    if bit_pos > 0 {
        bit_bytes.push(cur_byte);
    }
    writer.write_bytes(&bit_bytes);
}

fn normalize_probabilities(counts: &[u64], rans_precision: u32) -> Vec<u32> {
    let total: u64 = counts.iter().sum();
    let mut probs = vec![0u32; counts.len()];
    if total == 0 {
        if !probs.is_empty() {
            probs[0] = rans_precision;
        }
        return probs;
    }

    let mut sum_probs: u32 = 0;
    let mut max_idx = 0usize;
    let mut max_prob = 0u32;

    for (i, &c) in counts.iter().enumerate() {
        if c == 0 {
            continue;
        }
        let p = (((c as u128) * (rans_precision as u128)) / (total as u128)) as u32;
        let p = p.max(1);
        probs[i] = p;
        sum_probs += p;
        if p >= max_prob {
            max_prob = p;
            max_idx = i;
        }
    }

    if sum_probs < rans_precision {
        probs[max_idx] += rans_precision - sum_probs;
    } else if sum_probs > rans_precision {
        let mut excess = sum_probs - rans_precision;
        // Reducir primero del símbolo con mayor frecuencia, luego de otros > 1
        if probs[max_idx] > excess + 1 {
            probs[max_idx] -= excess;
        } else {
            for p in probs.iter_mut() {
                if excess == 0 {
                    break;
                }
                if *p > 1 {
                    let take = (*p - 1).min(excess);
                    *p -= take;
                    excess -= take;
                }
            }
        }
    }
    probs
}

fn write_rans_table_and_stream(
    symbols: &[u32],
    probs: &[u32],
    precision_bits: u32,
    writer: &mut ByteWriter,
) {
    let rans_precision = 1u32 << precision_bits;
    // Recortar ceros finales opcionalmente o emitir todos los símbolos usados
    let mut active_len = probs.len();
    while active_len > 1 && probs[active_len - 1] == 0 {
        active_len -= 1;
    }

    writer.write_varint_u32(active_len as u32);
    let mut i = 0usize;
    while i < active_len {
        let p = probs[i];
        if p == 0 {
            let mut run = 0usize;
            while i + run + 1 < active_len && probs[i + run + 1] == 0 && run < 63 {
                run += 1;
            }
            writer.write_u8(((run as u8) << 2) | 3);
            i += run + 1;
        } else if p < 64 {
            writer.write_u8(((p as u8) << 2) | 0);
            i += 1;
        } else if p < (1 << 14) {
            writer.write_u8((((p & 0x3F) as u8) << 2) | 1);
            writer.write_u8(((p >> 6) & 0xFF) as u8);
            i += 1;
        } else {
            writer.write_u8((((p & 0x3F) as u8) << 2) | 2);
            writer.write_u8(((p >> 6) & 0xFF) as u8);
            writer.write_u8(((p >> 14) & 0xFF) as u8);
            i += 1;
        }
    }

    // Construir cum_probs
    let mut cum_probs = vec![0u32; active_len];
    let mut cum = 0u32;
    for k in 0..active_len {
        cum_probs[k] = cum;
        cum += probs[k];
    }

    let l_base = rans_precision * 4;
    let mut state: u64 = l_base as u64;
    let mut stream = Vec::with_capacity(symbols.len() + 8);

    for &s in symbols.iter().rev() {
        let idx = s as usize;
        let prob = probs[idx] as u64;
        let cum_prob = cum_probs[idx] as u64;
        let x_max = ((l_base as u64 >> precision_bits) << 8) * prob;
        while state >= x_max {
            stream.push((state & 0xFF) as u8);
            state >>= 8;
        }
        state = ((state / prob) << precision_bits) + (state % prob) + cum_prob;
    }

    let rem = (state - (l_base as u64)) as u32;
    if rem < (1 << 6) {
        stream.push((rem & 0x3F) as u8);
    } else if rem < (1 << 14) {
        let tagged = rem | (1 << 14);
        stream.push((tagged & 0xFF) as u8);
        stream.push(((tagged >> 8) & 0xFF) as u8);
    } else if rem < (1 << 22) {
        let tagged = rem | (2 << 22);
        stream.push((tagged & 0xFF) as u8);
        stream.push(((tagged >> 8) & 0xFF) as u8);
        stream.push(((tagged >> 16) & 0xFF) as u8);
    } else {
        let tagged = rem | (3 << 30);
        stream.extend_from_slice(&tagged.to_le_bytes());
    }

    writer.write_varint_u64(stream.len() as u64);
    writer.write_bytes(&stream);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_decode_raw_and_tagged_roundtrip() {
        let raw_syms = vec![0, 1, 2, 1, 0, 5, 12, 5, 0, 0, 3, 2, 1];
        let mut w1 = ByteWriter::with_capacity(64);
        encode_symbols(&raw_syms, 1, &mut w1);
        let mut r1 = ByteReader::new(&w1.buf);
        let dec1 = decode_symbols_exact(raw_syms.len(), 1, &mut r1).unwrap();
        assert_eq!(dec1, raw_syms);
        assert_eq!(r1.remaining(), 0);

        let large_syms = vec![0, 5000, 12, 99999, 3, 42000, 7, 1, 88888];
        let mut w2 = ByteWriter::with_capacity(64);
        encode_symbols(&large_syms, 3, &mut w2);
        let mut r2 = ByteReader::new(&w2.buf);
        let dec2 = decode_symbols_exact(large_syms.len(), 3, &mut r2).unwrap();
        assert_eq!(dec2, large_syms);
        assert_eq!(r2.remaining(), 0);
    }
}
