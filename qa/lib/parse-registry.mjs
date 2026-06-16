export function parseAnimatableRaster(src) {
  const block = sliceBlock(src, 'animatableLayersGlobe');
  const out = [];
  // Match single-line objects with type:'wms' and an explicit gsLayerName string literal.
  // Handles both synthetic (type: 'wms') and real-file (type: 'wms' followed by ,) formats.
  // Uses [^}] to skip the `as const` and any extra fields before gsLayerName.
  const re = /\{\s*key:\s*'([^']+)',\s*label:\s*'([^']+)',\s*type:\s*'wms'(?:\s*as\s+const)?[^}]*?gsLayerName:\s*'([a-z0-9-]+:[a-z0-9-]+)'\s*\}/g;
  for (const m of block.matchAll(re)) {
    out.push({ key: m[1], label: m[2], gsLayerName: m[3] });
  }
  return out;
}

export function parseSatProducts(src) {
  // In the real file: "const SAT_PRODUCTS: SatProduct[] = ["
  // In the synthetic test: "const SAT_PRODUCTS = ["
  // Both contain "SAT_PRODUCTS" followed (possibly with type annotation) by "= ["
  // sliceBlock finds the last '=' followed by '[' after the ident.
  const block = sliceBlock(src, 'SAT_PRODUCTS');
  const out = [];
  // Each product is a single-line object with key, gsName, workspace, kind fields.
  const re = /\{\s*key:\s*'([^']+)'[^}]*?gsName:\s*'([a-z0-9-]+)'[^}]*?workspace:\s*'([a-z-]+)'[^}]*?kind:\s*'([a-z-]+)'[^}]*?\}/g;
  for (const m of block.matchAll(re)) {
    const [, key, gsName, workspace, kind] = m;
    out.push({
      key,
      gsLayerName: `${workspace}:${gsName}`,
      workspace,
      upstreamDependent: kind === 'cascade-realtime',
    });
  }
  return out;
}

/** Slice from `ident` to the closing `];`.
 *  Finds the first occurrence of `ident`, then the next `= [` to locate the
 *  actual array start (skipping TypeScript type annotations like
 *  `: SatProduct[] =` or `: Array<...> =`).
 */
function sliceBlock(src, ident) {
  const identStart = src.indexOf(ident);
  if (identStart === -1) throw new Error(`registry block not found: ${ident}`);
  const eqBracket = src.indexOf('= [', identStart);
  if (eqBracket === -1) throw new Error(`array start not found after: ${ident}`);
  const arrayStart = eqBracket + 2; // position of '['
  const end = src.indexOf('];', arrayStart);
  if (end === -1) throw new Error(`unterminated block: ${ident}`);
  return src.slice(arrayStart, end);
}
