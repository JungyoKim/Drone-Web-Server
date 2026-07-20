/**
 * Generates a printable marker image for the web-drawn 4x4 custom marker
 * feature. Pixel-for-pixel matches AR.Dictionary.prototype.generateSVG in
 * js-aruco2/src/aruco.js (see src/tracking.ts's registerCustomMarker on the
 * backend, which registers the SAME pattern for detection) -- what you print
 * from here is exactly what the backend is configured to look for. Kept
 * dependency-free (no js-aruco2 import) since this is the only piece of that
 * library's behavior the frontend needs.
 */

/** Interior grid dimension (4x4 = 16 data cells), matching the backend's
 * CUSTOM_MARKER_GRID_SIZE. */
export const MARKER_GRID_SIZE = 4;
/** Total data cells, matching the backend's CUSTOM_MARKER_BITS. */
export const MARKER_BITS = MARKER_GRID_SIZE * MARKER_GRID_SIZE;

/** A blank (all-black) starting pattern for the designer grid. */
export function emptyMarkerPattern(): boolean[] {
  return new Array(MARKER_BITS).fill(false);
}

/**
 * Renders the printable marker as an SVG string: a white quiet-zone margin,
 * a solid black marker body (border + interior), with white squares cut out
 * for each `true` cell. `pattern` is row-major (index 0 = top-left interior
 * cell), matching src/tracking.ts's patternToCode exactly.
 *
 * `sizeMm` sets the physical print size (both width and height, marker is
 * always square) via the SVG's width/height attributes, in millimeters --
 * printing the SVG directly (e.g. via the browser's print dialog) then comes
 * out true-to-size without extra scaling steps.
 */
export function generateMarkerSvg(pattern: readonly boolean[], sizeMm = 80): string {
  if (pattern.length !== MARKER_BITS) {
    throw new Error(`marker pattern must be exactly ${MARKER_BITS} cells, got ${pattern.length}`);
  }
  const size = MARKER_GRID_SIZE;
  const total = size + 4; // 1 white margin + 1 black border + `size` interior + 1 black border + 1 white margin, per edge

  const cells: string[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (pattern[y * size + x]) {
        cells.push(`<rect x="${x + 2}" y="${y + 2}" width="1" height="1" fill="white"/>`);
      }
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
    `width="${sizeMm}mm" height="${sizeMm}mm">` +
    `<rect x="0" y="0" width="${total}" height="${total}" fill="white"/>` +
    `<rect x="1" y="1" width="${total - 2}" height="${total - 2}" fill="black"/>` +
    cells.join("") +
    `</svg>`
  );
}

/** Toggles one cell (immutable -- returns a new array) for the designer grid. */
export function toggleCell(pattern: readonly boolean[], index: number): boolean[] {
  const next = pattern.slice();
  next[index] = !next[index];
  return next;
}
