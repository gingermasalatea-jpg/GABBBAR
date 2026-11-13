/** Google Sheets A1-notation helpers (pure). */

export function columnLetter(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Quote a sheet (tab) name for use in a range: 'My Sheet'!A1 */
export function quoteSheet(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

export function cellRange(sheet, colIndex, rowNumber) {
  return `${quoteSheet(sheet)}!${columnLetter(colIndex)}${rowNumber}`;
}

/** Stable fingerprint of the mapped values in a row. */
export function rowFingerprint(values) {
  return JSON.stringify(values.map((v) => (v === null || v === undefined ? '' : String(v).trim())));
}
