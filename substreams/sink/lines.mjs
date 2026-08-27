/**
 * @fileoverview Classification of lines arriving on the substreams CLI's stdout.
 *
 * Lives in its own module so tests can import it without loading
 * http-sink.mjs, which starts streaming as soon as it is imported.
 *
 * @module sink/lines
 */

/**
 * Does this line look like it was meant to be JSON?
 *
 * The CLI interleaves human-readable chatter with the JSONL stream — progress
 * updates, block markers, and a `Completed …` line at the end of a bounded run.
 * Those are normal output, not failures, and reporting them as parse errors
 * makes a healthy run look broken.
 *
 * This replaces an allowlist of known prefixes (`Progress:`, `Block:`), which
 * had to grow every time the CLI printed something new — the `Completed …`
 * line appeared the first time the sink was given a stop block and was
 * immediately announced as `Error processing line`.
 *
 * A line that does not open with `{` or `[` was never JSON, so it can be
 * skipped without inspecting its content. A line that *does* open that way and
 * still fails to parse is a genuine problem and must stay loud.
 *
 * @param {string} line - A single line of CLI stdout
 * @returns {boolean} true when the line was intended as JSON
 */
export function isLikelyJsonLine(line) {
    if (typeof line !== 'string') return false;
    const trimmed = line.trim();
    return trimmed.startsWith('{') || trimmed.startsWith('[');
}
