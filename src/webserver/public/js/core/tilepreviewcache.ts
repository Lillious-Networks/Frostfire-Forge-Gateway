// Caches the tile editor's multi-tile brush preview.
//
// Drawn tile by tile, a picked region costs a drawImage and a strokeRect per
// tile on every frame, which for a few thousand tiles is more than a whole
// frame's budget. The picked tiles only change when the pick does, so they are
// baked once into canvas blocks and a frame becomes one blit per block on
// screen.
//
// Blocks rather than one canvas: a region copied from the map has no size
// limit, and blocks are only built once they come into view.

/** Target edge of one block, in pixels. Small enough that baking one does not cost a frame. */
const BLOCK_PX = 256;
/** Blocks kept before the ones off screen are dropped (about 256 KB each). */
const MAX_BLOCKS = 256;
/** Blocks baked per frame, so a screen-sized pick fills in over a few frames instead of stalling one. */
const BUILDS_PER_FRAME = 2;
/** How far a tile's outline reaches past the tile's own edge, in pixels. */
const OUTLINE_BLEED = 1;

/**
 * Draws one tile with its outline at (x, y). Returns false while the tile's
 * image is still loading, so the block is baked again once it has arrived.
 */
export type PreviewTileDrawer = (target: CanvasRenderingContext2D, tileId: number, x: number, y: number) => boolean;

export class TilePreviewCache {
  private tiles: number[][] | null = null;
  private stamp: unknown = null;
  private tileWidth = 0;
  private tileHeight = 0;
  private alpha = 1;
  private cols = 0;
  private blockTiles = 1;
  private blockCols = 0;
  private blocks: Map<number, HTMLCanvasElement> = new Map();

  /** Forgets every block. Needed when the picked tiles are changed in place, which a new array is not. */
  public invalidate(): void {
    this.tiles = null;
    this.stamp = null;
    this.blocks.clear();
  }

  /**
   * Draws `tiles` with their top left corner at (originX, originY).
   *
   * `stamp` is whatever the tiles' appearance depends on besides their ids
   * (the map they belong to); a different one starts the cache over. Tiles are
   * baked at `alpha`, so outlines that overlap blend exactly as they would
   * drawn straight onto the target. Expects the target's transform to be
   * axis-aligned, which the map renderer's always is.
   */
  public draw(
    target: CanvasRenderingContext2D,
    tiles: number[][],
    stamp: unknown,
    originX: number, originY: number,
    tileWidth: number, tileHeight: number,
    alpha: number,
    drawTile: PreviewTileDrawer
  ): void {
    if (tiles !== this.tiles || stamp !== this.stamp || tileWidth !== this.tileWidth || tileHeight !== this.tileHeight || alpha !== this.alpha) {
      this.blocks.clear();
      this.tiles = tiles;
      this.stamp = stamp;
      this.tileWidth = tileWidth;
      this.tileHeight = tileHeight;
      this.alpha = alpha;
      this.cols = 0;
      for (const row of tiles) this.cols = Math.max(this.cols, row.length);
      this.blockTiles = Math.max(1, Math.floor(BLOCK_PX / Math.max(tileWidth, tileHeight)));
      this.blockCols = Math.ceil(this.cols / this.blockTiles);
    }

    const rows = tiles.length;
    if (rows === 0 || this.cols === 0) return;

    // The part of the target that is on screen, in the same space as the origin.
    const m = target.getTransform();
    const viewLeft = -m.e / m.a;
    const viewTop = -m.f / m.d;
    const viewRight = (target.canvas.width - m.e) / m.a;
    const viewBottom = (target.canvas.height - m.f) / m.d;

    const blockWidth = this.blockTiles * tileWidth;
    const blockHeight = this.blockTiles * tileHeight;
    const blockRows = Math.ceil(rows / this.blockTiles);
    const firstCol = Math.max(0, Math.floor((viewLeft - originX - OUTLINE_BLEED) / blockWidth));
    const lastCol = Math.min(this.blockCols - 1, Math.floor((viewRight - originX + OUTLINE_BLEED) / blockWidth));
    const firstRow = Math.max(0, Math.floor((viewTop - originY - OUTLINE_BLEED) / blockHeight));
    const lastRow = Math.min(blockRows - 1, Math.floor((viewBottom - originY + OUTLINE_BLEED) / blockHeight));
    if (firstCol > lastCol || firstRow > lastRow) return;

    target.save();
    target.globalAlpha = 1;
    target.imageSmoothingEnabled = false;

    let built = 0;
    for (let by = firstRow; by <= lastRow; by++) {
      for (let bx = firstCol; bx <= lastCol; bx++) {
        const key = by * this.blockCols + bx;
        let block = this.blocks.get(key);
        // The outermost blocks carry the outline that hangs over the region's edge.
        const left = bx * blockWidth - (bx === 0 ? OUTLINE_BLEED : 0);
        const top = by * blockHeight - (by === 0 ? OUTLINE_BLEED : 0);

        if (!block) {
          if (built >= BUILDS_PER_FRAME) continue;
          built++;
          const baked = this.bake(bx, by, left, top, drawTile);
          block = baked.canvas;
          if (baked.complete) this.blocks.set(key, block);
        }

        target.drawImage(block, originX + left, originY + top);
      }
    }

    target.restore();

    if (this.blocks.size > MAX_BLOCKS) {
      for (const key of this.blocks.keys()) {
        const bx = key % this.blockCols;
        const by = Math.floor(key / this.blockCols);
        if (bx < firstCol || bx > lastCol || by < firstRow || by > lastRow) this.blocks.delete(key);
      }
    }
  }

  private bake(bx: number, by: number, left: number, top: number, drawTile: PreviewTileDrawer): { canvas: HTMLCanvasElement, complete: boolean } {
    const tiles = this.tiles as number[][];
    const rows = tiles.length;
    const col0 = bx * this.blockTiles;
    const row0 = by * this.blockTiles;
    const col1 = Math.min(this.cols, col0 + this.blockTiles);
    const row1 = Math.min(rows, row0 + this.blockTiles);
    const right = col1 * this.tileWidth + (col1 === this.cols ? OUTLINE_BLEED : 0);
    const bottom = row1 * this.tileHeight + (row1 === rows ? OUTLINE_BLEED : 0);

    const canvas = document.createElement('canvas');
    canvas.width = right - left;
    canvas.height = bottom - top;
    const blockCtx = canvas.getContext('2d') as CanvasRenderingContext2D;
    blockCtx.translate(-left, -top);
    blockCtx.globalAlpha = this.alpha;
    blockCtx.imageSmoothingEnabled = false;

    // One tile further out on every side: the neighbours' outlines reach into
    // this block, and leaving them out would show as seams between blocks.
    let complete = true;
    for (let row = Math.max(0, row0 - 1); row < Math.min(rows, row1 + 1); row++) {
      const line = tiles[row];
      for (let col = Math.max(0, col0 - 1); col < Math.min(line.length, col1 + 1); col++) {
        if (!drawTile(blockCtx, line[col], col * this.tileWidth, row * this.tileHeight)) complete = false;
      }
    }

    return { canvas, complete };
  }
}
