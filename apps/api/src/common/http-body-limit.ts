/**
 * The observed preview payload is 135,898 bytes for 2,000 rows (~68 bytes/row).
 * At 100,000 rows that is ~6.8 MB, so 16 MiB leaves more than 2x headroom for
 * normal email and mapped-column variation while still bounding request memory.
 */
export const JSON_BODY_LIMIT_BYTES = 16 * 1024 * 1024;
