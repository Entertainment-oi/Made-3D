use crate::bitstream::ByteReader;
use crate::error::Result;

#[derive(Debug, Clone, Default)]
pub struct MetadataEntry {
    pub key: Vec<u8>,
    pub value: Vec<u8>,
}

#[derive(Debug, Clone, Default)]
pub struct Metadata {
    pub entries: Vec<MetadataEntry>,
    pub sub_metadata: Vec<(Vec<u8>, Metadata)>,
}

#[derive(Debug, Clone, Default)]
pub struct GeometryMetadata {
    pub attribute_metadata: Vec<(u32, Metadata)>,
    pub file_metadata: Metadata,
}

fn read_metadata_block(reader: &mut ByteReader<'_>) -> Result<Metadata> {
    let num_entries = reader.read_varint_u32()? as usize;
    let mut entries = Vec::with_capacity(num_entries.min(256));
    for _ in 0..num_entries {
        let key_len = reader.read_u8()? as usize;
        let key = reader.read_bytes(key_len)?.to_vec();
        let val_len = reader.read_u8()? as usize;
        let value = reader.read_bytes(val_len)?.to_vec();
        entries.push(MetadataEntry { key, value });
    }

    let num_sub = reader.read_varint_u32()? as usize;
    let mut sub_metadata = Vec::with_capacity(num_sub.min(64));
    for _ in 0..num_sub {
        let name_len = reader.read_u8()? as usize;
        let name = reader.read_bytes(name_len)?.to_vec();
        let sub = read_metadata_block(reader)?;
        sub_metadata.push((name, sub));
    }

    Ok(Metadata {
        entries,
        sub_metadata,
    })
}

pub fn decode_geometry_metadata(reader: &mut ByteReader<'_>) -> Result<GeometryMetadata> {
    let num_att = reader.read_varint_u32()? as usize;
    let mut attribute_metadata = Vec::with_capacity(num_att.min(64));
    for _ in 0..num_att {
        let att_unique_id = reader.read_varint_u32()?;
        let meta = read_metadata_block(reader)?;
        attribute_metadata.push((att_unique_id, meta));
    }
    let file_metadata = read_metadata_block(reader)?;
    Ok(GeometryMetadata {
        attribute_metadata,
        file_metadata,
    })
}
