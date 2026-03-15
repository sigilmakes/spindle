/**
 * Incremental scanner for <episode> blocks in accumulated agent text.
 *
 * Instead of rescanning the entire accumulated string on every append (O(N×T)),
 * this tracks a scan offset and only examines new text. When an unclosed
 * `<episode>` tag is detected, the scanner remembers its position and rescans
 * from there on the next append, so blocks split across chunks are handled.
 *
 * Total regex work is O(N) — each byte is scanned at most a constant number
 * of times.
 */
export class EpisodeScanner {
    private buffer = "";
    private scanOffset = 0;
    /** Absolute position of an unclosed `<episode>` tag, or -1 if none. */
    private openTagOffset = -1;

    /** Length of `</episode>` — the max partial tag that could straddle a boundary. */
    private static readonly OVERLAP = "</episode>".length; // 10

    /**
     * Append new text and return any newly-discovered `<episode>…</episode>` blocks.
     * Each returned string includes the surrounding tags.
     */
    append(text: string): string[] {
        const prevOffset = this.scanOffset;
        this.buffer += text;

        // If there's an unclosed <episode> from a prior append, scan from there
        // so we can match the full block once the closing tag arrives.
        // Otherwise, back up by OVERLAP to catch a closing tag split at the boundary.
        const searchFrom = this.openTagOffset >= 0
            ? this.openTagOffset
            : Math.max(0, prevOffset - EpisodeScanner.OVERLAP);

        const slice = this.buffer.slice(searchFrom);
        const matches = [...slice.matchAll(/<episode>[\s\S]*?<\/episode>/g)];

        const results: string[] = [];
        for (const m of matches) {
            const absEnd = searchFrom + m.index! + m[0].length;
            // Only emit blocks whose end falls beyond the previous scan offset
            // — anything that ended before was already emitted.
            if (absEnd > prevOffset) {
                results.push(m[0]);
            }
        }

        // Detect unclosed <episode> for next call.
        // If the last <episode> in the buffer comes after the last </episode>,
        // the block is still open and we need to rescan from there next time.
        const lastOpen = this.buffer.lastIndexOf("<episode>");
        const lastClose = this.buffer.lastIndexOf("</episode>");
        if (lastOpen >= 0 && (lastClose < 0 || lastOpen > lastClose)) {
            this.openTagOffset = lastOpen;
        } else {
            this.openTagOffset = -1;
        }

        this.scanOffset = this.buffer.length;
        return results;
    }

    /** Full accumulated text (read-only). */
    get text(): string {
        return this.buffer;
    }
}
