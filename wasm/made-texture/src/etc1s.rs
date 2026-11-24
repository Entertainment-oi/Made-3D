use crate::bit::BitReader;
use crate::error::TextureError;

pub const ETC1_INTEN_TABLES: [[i16; 4]; 8] = [
    [-8, -2, 2, 8],
    [-17, -5, 5, 17],
    [-29, -9, 9, 29],
    [-42, -13, 13, 42],
    [-60, -18, 18, 60],
    [-80, -24, 24, 80],
    [-106, -33, 33, 106],
    [-183, -47, 47, 183],
];

const HUFFMAN_MAX_CODE_SIZE: usize = 16;
const HUFFMAN_MAX_SYMS: usize = 1 << 14;
const HUFFMAN_FAST_BITS: usize = 10;
const HUFFMAN_FAST_SIZE: usize = 1 << HUFFMAN_FAST_BITS;
const HUFFMAN_TOTAL_CODELENGTH_CODES: usize = 21;
const HUFFMAN_SMALL_ZERO_RUN_CODE: usize = 17;
const HUFFMAN_BIG_ZERO_RUN_CODE: usize = 18;
const HUFFMAN_SMALL_REPEAT_CODE: usize = 19;
const HUFFMAN_BIG_REPEAT_CODE: usize = 20;

const CODELENGTH_ORDER: [usize; HUFFMAN_TOTAL_CODELENGTH_CODES] = [
    17, 18, 19, 20, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15, 16,
];

const SELECTOR_INDEX_TO_ETC1: [u8; 4] = [3, 2, 0, 1];

#[derive(Clone, Debug)]
pub struct HuffmanTable {
    fast: Vec<u32>,
    min_code: [i32; 17],
    max_code: [i32; 17],
    offset: [i32; 17],
    long_syms: Vec<u16>,
}

impl HuffmanTable {
    pub fn from_code_sizes(code_sizes: &[u8]) -> Result<Self, TextureError> {
        let mut bl_count = [0u32; 17];
        let mut non_zero = 0usize;
        for &len in code_sizes {
            if (len as usize) > HUFFMAN_MAX_CODE_SIZE {
                return Err(TextureError::CorruptStream("longitud de código Huffman > 16".into()));
            }
            if len > 0 {
                bl_count[len as usize] += 1;
                non_zero += 1;
            }
        }

        let mut fast = vec![0u32; HUFFMAN_FAST_SIZE];
        let mut min_code = [0i32; 17];
        let mut max_code = [-1i32; 17];
        let mut offset = [0i32; 17];
        let mut long_syms = Vec::new();

        if non_zero == 0 {
            return Ok(Self {
                fast,
                min_code,
                max_code,
                offset,
                long_syms,
            });
        }

        let mut next_code = [0u32; 17];
        let mut code = 0u32;
        for bits in 1..=HUFFMAN_MAX_CODE_SIZE {
            code = (code + bl_count[bits - 1]) << 1;
            next_code[bits] = code;
        }

        let mut long_buckets: [Vec<(u16, u16)>; 17] = Default::default();
        for (sym, &len_u8) in code_sizes.iter().enumerate() {
            let len = len_u8 as usize;
            if len == 0 {
                continue;
            }
            let c = next_code[len];
            next_code[len] += 1;
            if len <= HUFFMAN_FAST_BITS {
                let rev = (c.reverse_bits()) >> (32 - len);
                let step = 1usize << len;
                let entry = ((len as u32) << 24) | (sym as u32);
                let mut idx = rev as usize;
                while idx < HUFFMAN_FAST_SIZE {
                    fast[idx] = entry;
                    idx += step;
                }
            } else {
                long_buckets[len].push((c as u16, sym as u16));
            }
        }

        for len in (HUFFMAN_FAST_BITS + 1)..=HUFFMAN_MAX_CODE_SIZE {
            let bucket = &mut long_buckets[len];
            if bucket.is_empty() {
                continue;
            }
            bucket.sort_unstable_by_key(|&(c, _)| c);
            min_code[len] = bucket[0].0 as i32;
            max_code[len] = bucket[bucket.len() - 1].0 as i32;
            offset[len] = long_syms.len() as i32;
            for &(_, sym) in bucket.iter() {
                long_syms.push(sym);
            }
        }

        Ok(Self {
            fast,
            min_code,
            max_code,
            offset,
            long_syms,
        })
    }

    #[inline]
    pub fn decode(&self, reader: &mut BitReader<'_>) -> Result<u16, TextureError> {
        let peek16 = reader.peek_bits_padded(16);
        let entry = self.fast[(peek16 as usize) & (HUFFMAN_FAST_SIZE - 1)];
        if entry != 0 {
            let len = entry >> 24;
            reader.consume_bits(len)?;
            return Ok((entry & 0xFFFF) as u16);
        }

        let rev16 = (peek16 as u16).reverse_bits();
        for len in (HUFFMAN_FAST_BITS + 1)..=HUFFMAN_MAX_CODE_SIZE {
            if self.max_code[len] < 0 {
                continue;
            }
            let prefix = (rev16 >> (16 - len)) as i32;
            if prefix >= self.min_code[len] && prefix <= self.max_code[len] {
                let idx = (self.offset[len] + (prefix - self.min_code[len])) as usize;
                if let Some(&sym) = self.long_syms.get(idx) {
                    reader.consume_bits(len as u32)?;
                    return Ok(sym);
                }
            }
        }

        Err(TextureError::CorruptStream("código Huffman inválido en stream ETC1S".into()))
    }

    pub fn read(reader: &mut BitReader<'_>) -> Result<Self, TextureError> {
        let total_used_syms = reader.read_bits(14)? as usize;
        if total_used_syms > HUFFMAN_MAX_SYMS {
            return Err(TextureError::CorruptStream("demasiados símbolos Huffman".into()));
        }
        let num_codelength_codes = reader.read_bits(5)? as usize;
        if num_codelength_codes == 0 || num_codelength_codes > HUFFMAN_TOTAL_CODELENGTH_CODES {
            return Err(TextureError::CorruptStream("número inválido de códigos de longitud Huffman".into()));
        }

        let mut cl_code_sizes = [0u8; HUFFMAN_TOTAL_CODELENGTH_CODES];
        for i in 0..num_codelength_codes {
            cl_code_sizes[CODELENGTH_ORDER[i]] = reader.read_bits(3)? as u8;
        }
        let cl_table = Self::from_code_sizes(&cl_code_sizes)?;

        let mut code_sizes = vec![0u8; total_used_syms];
        let mut cur = 0usize;
        while cur < total_used_syms {
            let sym = cl_table.decode(reader)? as usize;
            if sym <= HUFFMAN_MAX_CODE_SIZE {
                code_sizes[cur] = sym as u8;
                cur += 1;
            } else if sym == HUFFMAN_SMALL_ZERO_RUN_CODE {
                let run = (reader.read_bits(3)? as usize) + 3;
                if cur + run > total_used_syms {
                    return Err(TextureError::CorruptStream("run de ceros corto excede tabla Huffman".into()));
                }
                cur += run;
            } else if sym == HUFFMAN_BIG_ZERO_RUN_CODE {
                let run = (reader.read_bits(7)? as usize) + 11;
                if cur + run > total_used_syms {
                    return Err(TextureError::CorruptStream("run de ceros largo excede tabla Huffman".into()));
                }
                cur += run;
            } else if sym == HUFFMAN_SMALL_REPEAT_CODE || sym == HUFFMAN_BIG_REPEAT_CODE {
                if cur == 0 || code_sizes[cur - 1] == 0 {
                    return Err(TextureError::CorruptStream("repeat Huffman inválido al inicio o tras 0".into()));
                }
                let prev = code_sizes[cur - 1];
                let run = if sym == HUFFMAN_SMALL_REPEAT_CODE {
                    (reader.read_bits(2)? as usize) + 3
                } else {
                    (reader.read_bits(7)? as usize) + 7
                };
                if cur + run > total_used_syms {
                    return Err(TextureError::CorruptStream("repeat Huffman excede tabla".into()));
                }
                for _ in 0..run {
                    code_sizes[cur] = prev;
                    cur += 1;
                }
            } else {
                return Err(TextureError::CorruptStream("símbolo de longitud Huffman desconocido".into()));
            }
        }

        Self::from_code_sizes(&code_sizes)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EndpointEntry {
    pub color5: [u8; 3],
    pub inten5: u8,
}

impl EndpointEntry {
    #[inline]
    pub fn color8(&self) -> [u8; 3] {
        [
            (self.color5[0] << 3) | (self.color5[0] >> 2),
            (self.color5[1] << 3) | (self.color5[1] >> 2),
            (self.color5[2] << 3) | (self.color5[2] >> 2),
        ]
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SelectorEntry {
    /// Índices `0..=3` en orden fila por fila (`y * 4 + x`), directos a `ETC1_INTEN_TABLES`.
    pub indices: [u8; 16],
    /// Bytes `[4..8]` listos para bloque ETC1 hardware (`p[0]` LSB, `p[-2]` MSB).
    pub etc1_bytes: [u8; 4],
}

impl SelectorEntry {
    pub fn from_raw_rows(rows: [u8; 4]) -> Self {
        let mut indices = [0u8; 16];
        let mut etc1_bytes = [0u8; 4];
        for (y, &cur_byte) in rows.iter().enumerate() {
            for x in 0..4usize {
                let val = (cur_byte >> (x * 2)) & 3;
                indices[y * 4 + x] = val;
                let etc1_bit_index = x * 4 + y;
                let byte_idx = 3 - (etc1_bit_index >> 3);
                let bit_ofs = etc1_bit_index & 7;
                let etc1_val = SELECTOR_INDEX_TO_ETC1[val as usize];
                let lsb = etc1_val & 1;
                let msb = etc1_val >> 1;
                etc1_bytes[byte_idx] |= lsb << bit_ofs;
                etc1_bytes[byte_idx - 2] |= msb << bit_ofs;
            }
        }
        Self { indices, etc1_bytes }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Ktx2BasisLzImageDesc {
    pub image_flags: u32,
    pub rgb_slice_byte_offset: u32,
    pub rgb_slice_byte_length: u32,
    pub alpha_slice_byte_offset: u32,
    pub alpha_slice_byte_length: u32,
}

#[derive(Clone, Debug)]
pub struct BasisLzGlobalData {
    pub image_descs: Vec<Ktx2BasisLzImageDesc>,
    pub endpoints: Vec<EndpointEntry>,
    pub selectors: Vec<SelectorEntry>,
    pub endpoint_pred_model: HuffmanTable,
    pub delta_endpoint_model: HuffmanTable,
    pub selector_model: HuffmanTable,
    pub selector_history_buf_rle_model: HuffmanTable,
    pub selector_history_buf_size: usize,
    pub has_alpha: bool,
}

impl BasisLzGlobalData {
    pub fn parse_ktx2_sgd(sgd: &[u8], image_count: usize) -> Result<Self, TextureError> {
        if sgd.len() < 20 {
            return Err(TextureError::InvalidHeader("BasisLZ SGD truncado (<20 bytes)"));
        }
        let endpoint_count = u16::from_le_bytes([sgd[0], sgd[1]]) as usize;
        let selector_count = u16::from_le_bytes([sgd[2], sgd[3]]) as usize;
        let endpoints_byte_len = u32::from_le_bytes([sgd[4], sgd[5], sgd[6], sgd[7]]) as usize;
        let selectors_byte_len = u32::from_le_bytes([sgd[8], sgd[9], sgd[10], sgd[11]]) as usize;
        let tables_byte_len = u32::from_le_bytes([sgd[12], sgd[13], sgd[14], sgd[15]]) as usize;
        let _extended_byte_len = u32::from_le_bytes([sgd[16], sgd[17], sgd[18], sgd[19]]) as usize;

        let descs_bytes = image_count
            .checked_mul(20)
            .ok_or(TextureError::InvalidHeader("overflow image_descs BasisLZ"))?;
        let mut cursor = 20usize;
        if cursor + descs_bytes > sgd.len() {
            return Err(TextureError::Truncated("image_descs BasisLZ"));
        }

        let mut image_descs = Vec::with_capacity(image_count);
        let mut has_alpha = false;
        for i in 0..image_count {
            let b = &sgd[cursor + i * 20..cursor + (i + 1) * 20];
            let desc = Ktx2BasisLzImageDesc {
                image_flags: u32::from_le_bytes([b[0], b[1], b[2], b[3]]),
                rgb_slice_byte_offset: u32::from_le_bytes([b[4], b[5], b[6], b[7]]),
                rgb_slice_byte_length: u32::from_le_bytes([b[8], b[9], b[10], b[11]]),
                alpha_slice_byte_offset: u32::from_le_bytes([b[12], b[13], b[14], b[15]]),
                alpha_slice_byte_length: u32::from_le_bytes([b[16], b[17], b[18], b[19]]),
            };
            if desc.alpha_slice_byte_length > 0 {
                has_alpha = true;
            }
            image_descs.push(desc);
        }
        cursor += descs_bytes;

        let end_endpoints = cursor
            .checked_add(endpoints_byte_len)
            .ok_or(TextureError::Truncated("endpoints BasisLZ"))?;
        let end_selectors = end_endpoints
            .checked_add(selectors_byte_len)
            .ok_or(TextureError::Truncated("selectors BasisLZ"))?;
        let end_tables = end_selectors
            .checked_add(tables_byte_len)
            .ok_or(TextureError::Truncated("tables BasisLZ"))?;
        if end_tables > sgd.len() {
            return Err(TextureError::Truncated("bloques BasisLZ SGD"));
        }

        let endpoints = decode_endpoint_codebook(&sgd[cursor..end_endpoints], endpoint_count)?;
        let selectors = decode_selector_codebook(&sgd[end_endpoints..end_selectors], selector_count)?;

        let mut tr = BitReader::new(&sgd[end_selectors..end_tables]);
        let endpoint_pred_model = HuffmanTable::read(&mut tr)?;
        let delta_endpoint_model = HuffmanTable::read(&mut tr)?;
        let selector_model = HuffmanTable::read(&mut tr)?;
        let selector_history_buf_rle_model = HuffmanTable::read(&mut tr)?;
        let selector_history_buf_size = tr.read_bits(13)? as usize;

        Ok(Self {
            image_descs,
            endpoints,
            selectors,
            endpoint_pred_model,
            delta_endpoint_model,
            selector_model,
            selector_history_buf_rle_model,
            selector_history_buf_size,
            has_alpha,
        })
    }

    pub fn decode_slice_indices(
        &self,
        slice_bytes: &[u8],
        num_blocks_x: usize,
        num_blocks_y: usize,
        is_video: bool,
        prev_frame: Option<&[(u16, u16)]>,
    ) -> Result<Vec<(u16, u16)>, TextureError> {
        let total_blocks = num_blocks_x
            .checked_mul(num_blocks_y)
            .ok_or(TextureError::OutOfBounds("overflow bloques slice ETC1S"))?;
        let num_endpoints = self.endpoints.len();
        let num_selectors = self.selectors.len();
        if num_endpoints == 0 || num_selectors == 0 {
            return Err(TextureError::CorruptStream("codebook ETC1S vacío".into()));
        }

        const ENDPOINT_PRED_REPEAT_LAST_SYMBOL: u32 = 256;
        const ENDPOINT_PRED_MIN_REPEAT_COUNT: u32 = 3;
        const SELECTOR_HISTORY_BUF_RLE_COUNT_THRESH: usize = 3;
        const SELECTOR_HISTORY_BUF_RLE_COUNT_TOTAL: usize = 64;

        let selector_history_buf_first_sym = num_selectors;
        let selector_history_buf_rle_sym = num_selectors + self.selector_history_buf_size;

        let mut reader = BitReader::new(slice_bytes);
        let mut block_preds = vec![(0u16, 0u8); 2 * num_blocks_x];
        let mut history = ApproxMoveToFront::new(self.selector_history_buf_size);

        let mut cur_selector_rle_count = 0usize;
        let mut cur_pred_bits = 0u32;
        let mut prev_endpoint_pred_sym = 0u32;
        let mut endpoint_pred_repeat_count = 0u32;
        let mut prev_endpoint_index = 0usize;

        let mut out = vec![(0u16, 0u16); total_blocks];

        for by in 0..num_blocks_y {
            let cur_row = by & 1;
            let prev_row = cur_row ^ 1;
            for bx in 0..num_blocks_x {
                if (bx & 1) == 0 {
                    if (by & 1) == 0 {
                        if endpoint_pred_repeat_count > 0 {
                            endpoint_pred_repeat_count -= 1;
                            cur_pred_bits = prev_endpoint_pred_sym;
                        } else {
                            let sym = self.endpoint_pred_model.decode(&mut reader)? as u32;
                            if sym == ENDPOINT_PRED_REPEAT_LAST_SYMBOL {
                                endpoint_pred_repeat_count =
                                    decode_vlc(&mut reader, 4)? + ENDPOINT_PRED_MIN_REPEAT_COUNT - 1;
                                cur_pred_bits = prev_endpoint_pred_sym;
                            } else {
                                cur_pred_bits = sym;
                                prev_endpoint_pred_sym = sym;
                            }
                        }
                        block_preds[prev_row * num_blocks_x + bx].1 = (cur_pred_bits >> 4) as u8;
                    } else {
                        cur_pred_bits = block_preds[cur_row * num_blocks_x + bx].1 as u32;
                    }
                }

                let pred = cur_pred_bits & 3;
                cur_pred_bits >>= 2;

                let mut endpoint_index: usize;
                let mut selector_index: usize = 0;

                if pred == 0 {
                    if bx == 0 {
                        return Err(TextureError::CorruptStream("predictor izquierdo inválido en bx=0".into()));
                    }
                    endpoint_index = prev_endpoint_index;
                } else if pred == 1 {
                    if by == 0 {
                        return Err(TextureError::CorruptStream("predictor superior inválido en by=0".into()));
                    }
                    endpoint_index = block_preds[prev_row * num_blocks_x + bx].0 as usize;
                } else if pred == 2 {
                    if is_video {
                        let pf = prev_frame.ok_or_else(|| {
                            TextureError::CorruptStream("skip block sin frame previo en ETC1S".into())
                        })?;
                        let pair = pf[by * num_blocks_x + bx];
                        endpoint_index = pair.0 as usize;
                        selector_index = pair.1 as usize;
                    } else {
                        if bx == 0 || by == 0 {
                            return Err(TextureError::CorruptStream("predictor diag inválido en borde".into()));
                        }
                        endpoint_index = block_preds[prev_row * num_blocks_x + (bx - 1)].0 as usize;
                    }
                } else {
                    let delta = self.delta_endpoint_model.decode(&mut reader)? as usize;
                    endpoint_index = delta + prev_endpoint_index;
                    if endpoint_index >= num_endpoints {
                        endpoint_index -= num_endpoints;
                    }
                }

                if endpoint_index >= num_endpoints {
                    return Err(TextureError::CorruptStream("índice endpoint ETC1S fuera de rango".into()));
                }
                block_preds[cur_row * num_blocks_x + bx].0 = endpoint_index as u16;
                prev_endpoint_index = endpoint_index;

                if !is_video || pred != 2 {
                    let selector_sym: usize;
                    if cur_selector_rle_count > 0 {
                        cur_selector_rle_count -= 1;
                        selector_sym = selector_history_buf_first_sym;
                    } else {
                        let decoded = self.selector_model.decode(&mut reader)? as usize;
                        if decoded == selector_history_buf_rle_sym {
                            let run_sym = self.selector_history_buf_rle_model.decode(&mut reader)? as usize;
                            let run = if run_sym == SELECTOR_HISTORY_BUF_RLE_COUNT_TOTAL - 1 {
                                (decode_vlc(&mut reader, 7)? as usize) + SELECTOR_HISTORY_BUF_RLE_COUNT_THRESH
                            } else {
                                run_sym + SELECTOR_HISTORY_BUF_RLE_COUNT_THRESH
                            };
                            if run == 0 {
                                return Err(TextureError::CorruptStream("RLE selector nulo".into()));
                            }
                            cur_selector_rle_count = run - 1;
                            selector_sym = selector_history_buf_first_sym;
                        } else {
                            selector_sym = decoded;
                        }
                    }

                    if selector_sym >= selector_history_buf_first_sym {
                        let hist_idx = selector_sym - selector_history_buf_first_sym;
                        if hist_idx >= history.values.len() {
                            return Err(TextureError::CorruptStream("índice MTF selector fuera de rango".into()));
                        }
                        selector_index = history.values[hist_idx] as usize;
                        if hist_idx != 0 {
                            history.use_entry(hist_idx);
                        }
                    } else {
                        selector_index = selector_sym;
                        if !history.values.is_empty() {
                            history.add(selector_index as i32);
                        }
                    }
                }

                if selector_index >= num_selectors {
                    return Err(TextureError::CorruptStream("índice selector ETC1S fuera de rango".into()));
                }
                out[by * num_blocks_x + bx] = (endpoint_index as u16, selector_index as u16);
            }
        }

        Ok(out)
    }
}

pub fn decode_endpoint_codebook(data: &[u8], num_endpoints: usize) -> Result<Vec<EndpointEntry>, TextureError> {
    let mut reader = BitReader::new(data);
    let color5_delta_model0 = HuffmanTable::read(&mut reader)?;
    let color5_delta_model1 = HuffmanTable::read(&mut reader)?;
    let color5_delta_model2 = HuffmanTable::read(&mut reader)?;
    let inten_delta_model = HuffmanTable::read(&mut reader)?;
    let is_grayscale = reader.read_bits(1)? != 0;

    let mut prev_color5 = [16i32; 3];
    let mut prev_inten = 0u32;
    let mut out = Vec::with_capacity(num_endpoints);
    let comps = if is_grayscale { 1 } else { 3 };

    for _ in 0..num_endpoints {
        let inten_delta = inten_delta_model.decode(&mut reader)? as u32;
        let inten5 = (inten_delta + prev_inten) & 7;
        prev_inten = inten5;

        let mut color5 = [0u8; 3];
        for c in 0..comps {
            let delta = if prev_color5[c] <= 9 {
                color5_delta_model0.decode(&mut reader)? as i32
            } else if prev_color5[c] <= 21 {
                color5_delta_model1.decode(&mut reader)? as i32
            } else {
                color5_delta_model2.decode(&mut reader)? as i32
            };
            let v = (prev_color5[c] + delta) & 31;
            color5[c] = v as u8;
            prev_color5[c] = v;
        }
        if is_grayscale {
            color5[1] = color5[0];
            color5[2] = color5[0];
        }
        out.push(EndpointEntry {
            color5,
            inten5: inten5 as u8,
        });
    }

    Ok(out)
}

pub fn decode_selector_codebook(data: &[u8], num_selectors: usize) -> Result<Vec<SelectorEntry>, TextureError> {
    let mut reader = BitReader::new(data);
    let is_global = reader.read_bits(1)? != 0;
    let is_hybrid = reader.read_bits(1)? != 0;
    let is_raw = reader.read_bits(1)? != 0;
    if is_global || is_hybrid {
        return Err(TextureError::UnsupportedFormat(
            "codebooks globales/híbridos ETC1S no soportados".into(),
        ));
    }

    let mut out = Vec::with_capacity(num_selectors);
    if num_selectors == 0 {
        return Ok(out);
    }

    if is_raw {
        for _ in 0..num_selectors {
            let mut rows = [0u8; 4];
            for r in rows.iter_mut() {
                *r = reader.read_bits(8)? as u8;
            }
            out.push(SelectorEntry::from_raw_rows(rows));
        }
        return Ok(out);
    }

    let delta_model = HuffmanTable::read(&mut reader)?;
    let mut prev_bytes = [0u8; 4];
    for i in 0..num_selectors {
        let mut rows = [0u8; 4];
        for j in 0..4 {
            let cur_byte = if i == 0 {
                reader.read_bits(8)? as u8
            } else {
                let delta = delta_model.decode(&mut reader)? as u8;
                delta ^ prev_bytes[j]
            };
            prev_bytes[j] = cur_byte;
            rows[j] = cur_byte;
        }
        out.push(SelectorEntry::from_raw_rows(rows));
    }

    Ok(out)
}

struct ApproxMoveToFront {
    values: Vec<i32>,
    rover: usize,
}

impl ApproxMoveToFront {
    fn new(n: usize) -> Self {
        Self {
            values: vec![0; n],
            rover: n / 2,
        }
    }

    fn add(&mut self, val: i32) {
        if self.values.is_empty() {
            return;
        }
        self.values[self.rover] = val;
        self.rover += 1;
        if self.rover >= self.values.len() {
            self.rover = self.values.len() / 2;
        }
    }

    fn use_entry(&mut self, index: usize) {
        if index > 0 && index < self.values.len() {
            self.values.swap(index / 2, index);
        }
    }
}

#[inline]
fn decode_vlc(reader: &mut BitReader<'_>, chunk_bits: u32) -> Result<u32, TextureError> {
    let chunk_size = 1u32 << chunk_bits;
    let chunk_mask = chunk_size - 1;
    let mut v = 0u32;
    let mut ofs = 0u32;
    loop {
        let s = reader.read_bits(chunk_bits + 1)?;
        v |= (s & chunk_mask) << ofs;
        ofs += chunk_bits;
        if (s & chunk_size) == 0 {
            break;
        }
        if ofs >= 32 {
            return Err(TextureError::CorruptStream("overflow VLC ETC1S".into()));
        }
    }
    Ok(v)
}

#[inline]
pub fn decode_etc1s_block_rgba(
    rgb_ep: &EndpointEntry,
    rgb_sel: &SelectorEntry,
    alpha_pair: Option<(&EndpointEntry, &SelectorEntry)>,
    out_rgba: &mut [u8; 64],
) {
    let base = rgb_ep.color8();
    let tbl = &ETC1_INTEN_TABLES[rgb_ep.inten5 as usize & 7];
    let (a_base, a_tbl) = match alpha_pair {
        Some((ep, _)) => (
            (ep.color5[1] << 3) | (ep.color5[1] >> 2),
            Some(&ETC1_INTEN_TABLES[ep.inten5 as usize & 7]),
        ),
        None => (255, None),
    };

    for i in 0..16 {
        let modi = tbl[rgb_sel.indices[i] as usize & 3] as i32;
        out_rgba[i * 4] = (base[0] as i32 + modi).clamp(0, 255) as u8;
        out_rgba[i * 4 + 1] = (base[1] as i32 + modi).clamp(0, 255) as u8;
        out_rgba[i * 4 + 2] = (base[2] as i32 + modi).clamp(0, 255) as u8;
        out_rgba[i * 4 + 3] = match (alpha_pair, a_tbl) {
            (Some((_, asel)), Some(at)) => {
                (a_base as i32 + at[asel.indices[i] as usize & 3] as i32).clamp(0, 255) as u8
            }
            _ => 255,
        };
    }
}

#[inline]
pub fn pack_etc1s_block_hardware(ep: &EndpointEntry, sel: &SelectorEntry) -> [u8; 8] {
    [
        ep.color5[0] << 3,
        ep.color5[1] << 3,
        ep.color5[2] << 3,
        ((ep.inten5 & 7) << 5) | ((ep.inten5 & 7) << 2) | 0x02,
        sel.etc1_bytes[0],
        sel.etc1_bytes[1],
        sel.etc1_bytes[2],
        sel.etc1_bytes[3],
    ]
}

#[cfg(test)]
pub(crate) mod test_helpers {
    pub struct BitWriter {
        pub bytes: Vec<u8>,
        cur_byte: u8,
        bit_pos: u8,
    }

    impl BitWriter {
        pub fn new() -> Self {
            Self {
                bytes: Vec::new(),
                cur_byte: 0,
                bit_pos: 0,
            }
        }

        pub fn write_bits(&mut self, val: u32, mut count: u32) {
            let mut v = val;
            while count > 0 {
                let take = (8 - self.bit_pos as u32).min(count);
                let mask = (1u32 << take) - 1;
                self.cur_byte |= ((v & mask) as u8) << self.bit_pos;
                self.bit_pos += take as u8;
                v >>= take;
                count -= take;
                if self.bit_pos == 8 {
                    self.bytes.push(self.cur_byte);
                    self.cur_byte = 0;
                    self.bit_pos = 0;
                }
            }
        }

        pub fn finish(mut self) -> Vec<u8> {
            if self.bit_pos > 0 {
                self.bytes.push(self.cur_byte);
            }
            self.bytes
        }
    }

    /// Escribe una tabla Huffman de 1 símbolo activo `sym` con longitud 1 (código = 0).
    pub fn write_single_sym_huffman(w: &mut BitWriter, sym: usize) {
        let total = sym + 1;
        w.write_bits(total as u32, 14);
        w.write_bits(19, 5); // hasta el slot 18 (= longitud 1 en CODELENGTH_ORDER)
        // CODELENGTH_ORDER: [17,18,19,20, 0,8,7,9, 6,10,5,11, 4,12,3,13, 2,14,1,...]
        // Asignamos len=2 a símbolo 0 (slot 4), len=2 a símbolo 1 (slot 18), len=2 a 17 (slot 0), len=2 a 18 (slot 1)
        for slot in 0..19 {
            let cl = match slot {
                0 | 1 | 4 | 18 => 2u32,
                _ => 0u32,
            };
            w.write_bits(cl, 3);
        }
        // Códigos canónicos de longitud 2 para [0, 1, 17, 18]:
        // sym 0 -> 00 (rev 0b00), sym 1 -> 01 (rev 0b10), sym 17 -> 10 (rev 0b01), sym 18 -> 11 (rev 0b11)
        let mut left = sym;
        while left > 0 {
            if left >= 11 {
                let run = left.min(138);
                w.write_bits(0b11, 2); // sym 18
                w.write_bits((run - 11) as u32, 7);
                left -= run;
            } else if left >= 3 {
                let run = left.min(10);
                w.write_bits(0b01, 2); // sym 17
                w.write_bits((run - 3) as u32, 3);
                left -= run;
            } else {
                w.write_bits(0b00, 2); // sym 0
                left -= 1;
            }
        }
        w.write_bits(0b10, 2); // sym 1 (longitud 1 bit para `sym`)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use test_helpers::*;

    #[test]
    fn huffman_single_symbol_and_etc1s_block_decode() {
        let mut bw = BitWriter::new();
        write_single_sym_huffman(&mut bw, 0);
        let bytes = bw.finish();
        let mut br = BitReader::new(&bytes);
        let tbl = HuffmanTable::read(&mut br).unwrap();
        let mut r2 = BitReader::new(&[0u8]);
        assert_eq!(tbl.decode(&mut r2).unwrap(), 0);

        let ep = EndpointEntry {
            color5: [20, 10, 5],
            inten5: 1, // [-17, -5, 5, 17]
        };
        // Selector row 0..3: pixel (0,0)=0 (-17), pixel (1,0)=3 (+17), rest = 1 (-5)
        let sel = SelectorEntry::from_raw_rows([0b01_01_11_00, 0b01_01_01_01, 0b01_01_01_01, 0b01_01_01_01]);
        let mut rgba = [0u8; 64];
        decode_etc1s_block_rgba(&ep, &sel, None, &mut rgba);
        let c8 = ep.color8(); // [165, 82, 41]
        assert_eq!(rgba[0], (c8[0] as i32 - 17) as u8);
        assert_eq!(rgba[4], (c8[0] as i32 + 17) as u8);
        assert_eq!(rgba[8], (c8[0] as i32 - 5) as u8);
        assert_eq!(rgba[3], 255);

        let hw = pack_etc1s_block_hardware(&ep, &sel);
        assert_eq!(hw[0], 20 << 3);
        assert_eq!(hw[3] & 2, 2);
        // En pixel a (x=0, y=0): selector 0 -> s_selector_index_to_etc1[0] = 3 (lsb=1, msb=1)
        assert_eq!(hw[7] & 1, 1);
        assert_eq!(hw[5] & 1, 1);
    }

    #[test]
    fn basiz_sgd_and_slice_roundtrip() {
        // Construir SGD mínimo con 1 endpoint (delta 0 respecto a (16,16,16), inten 0) y 1 selector
        let mut ep_w = BitWriter::new();
        for _ in 0..4 {
            write_single_sym_huffman(&mut ep_w, 0);
        }
        ep_w.write_bits(0, 1); // RGB
        // 4 símbolos Huffman de valor 0 (código 0, 1 bit cada uno)
        ep_w.write_bits(0, 4);
        let ep_bytes = ep_w.finish();

        let mut sel_w = BitWriter::new();
        sel_w.write_bits(0, 1); // global=0
        sel_w.write_bits(0, 1); // hybrid=0
        sel_w.write_bits(1, 1); // is_raw=1
        sel_w.write_bits(0xFF, 8);
        sel_w.write_bits(0xFF, 8);
        sel_w.write_bits(0xFF, 8);
        sel_w.write_bits(0xFF, 8);
        let sel_bytes = sel_w.finish();

        let mut tbl_w = BitWriter::new();
        write_single_sym_huffman(&mut tbl_w, 0b11_11_11_11); // endpoint_pred = NO_PRED (3) para 2x2
        write_single_sym_huffman(&mut tbl_w, 0); // delta_endpoint = 0
        write_single_sym_huffman(&mut tbl_w, 0); // selector_sym = 0
        write_single_sym_huffman(&mut tbl_w, 0); // rle = 0
        tbl_w.write_bits(64, 13); // selector_history_buf_size
        let tbl_bytes = tbl_w.finish();

        // Slice 4x4 (1 bloque): 1 pred sym (0, 1 bit), 1 delta_endpoint (0, 1 bit), 1 selector (0, 1 bit)
        let slice_bytes = [0u8; 2];

        let mut sgd = Vec::new();
        sgd.extend_from_slice(&1u16.to_le_bytes()); // endpoint_count
        sgd.extend_from_slice(&1u16.to_le_bytes()); // selector_count
        sgd.extend_from_slice(&(ep_bytes.len() as u32).to_le_bytes());
        sgd.extend_from_slice(&(sel_bytes.len() as u32).to_le_bytes());
        sgd.extend_from_slice(&(tbl_bytes.len() as u32).to_le_bytes());
        sgd.extend_from_slice(&0u32.to_le_bytes()); // extended
        // 1 image desc
        sgd.extend_from_slice(&0u32.to_le_bytes());
        sgd.extend_from_slice(&0u32.to_le_bytes());
        sgd.extend_from_slice(&(slice_bytes.len() as u32).to_le_bytes());
        sgd.extend_from_slice(&0u32.to_le_bytes());
        sgd.extend_from_slice(&0u32.to_le_bytes());
        sgd.extend_from_slice(&ep_bytes);
        sgd.extend_from_slice(&sel_bytes);
        sgd.extend_from_slice(&tbl_bytes);

        let parsed = BasisLzGlobalData::parse_ktx2_sgd(&sgd, 1).unwrap();
        assert_eq!(parsed.endpoints[0].color5, [16, 16, 16]);
        let blocks = parsed.decode_slice_indices(&slice_bytes, 1, 1, false, None).unwrap();
        assert_eq!(blocks, vec![(0, 0)]);
    }
}
