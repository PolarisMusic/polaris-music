/**
 * The curate detail pane must scroll, not crop.
 *
 * The panel has no height of its own — only `max-height` — so it is sized by
 * its content, while the columns inside are sized by stretching back to it.
 * `.curate-detail-body` carried `flex: 1`, meaning `flex-basis: 0`, so it
 * contributed almost nothing to the column's max-content height; the panel
 * could settle shorter than the content needed and `overflow: hidden` cropped
 * the rest before the column's own `overflow-y: auto` decided it had anything
 * to scroll.
 *
 * Adding the vote memo box and the comment list is what pushed it over: the box
 * appeared cut in half and the comments below it were invisible entirely, which
 * read as "memos are not being recorded" rather than as a layout bug.
 *
 * Measured in a real browser because this is a layout question. jsdom performs
 * no layout, so the unit suites cannot see it, and reasoning about flexbox
 * sizing from the stylesheet is exactly how it was missed.
 */

import { test, expect } from '@playwright/test';

/** The detail content as InfoPanelRenderer builds it, tall enough to overflow. */
const DETAIL_HTML = `
  <div class="curate-detail-header">
    <h3>CREATE_RELEASE_BUNDLE</h3>
    <div class="curate-detail-meta"><span>by polaristests</span><span>Open</span></div>
  </div>
  <div class="curate-detail-voting">
    <span class="curate-score curate-score--negative">-3</span>
    <button class="curate-vote-btn curate-vote-up">Upvote</button>
    <button class="curate-vote-btn curate-vote-down">Downvote</button>
  </div>
  <textarea class="curate-memo-input" id="memo" rows="2" maxlength="280"></textarea>
  <div class="curate-comments">
    <h4>Comments (3)</h4>
    <div class="curate-comment"><span class="curate-comment__voter">alice</span>
      <span class="curate-comment__text">track 7 credits the wrong Lennon</span></div>
    <div class="curate-comment"><span class="curate-comment__voter">bob</span>
      <span class="curate-comment__text">verified against the liner notes</span></div>
    <div class="curate-comment" id="last-comment"><span class="curate-comment__voter">carol</span>
      <span class="curate-comment__text">release date is the reissue, not the original</span></div>
  </div>
  <div class="curate-detail-body">
    ${Array.from({ length: 30 }, (_, i) =>
        `<div class="curate-field"><span class="curate-field-label">Field ${i}</span>
         <span class="curate-field-value">A value long enough to take a line</span></div>`).join('')}
  </div>
`;

/**
 * Open the curate panel on the real page with a tall detail in it.
 *
 * Uses the shipped stylesheet via the built page rather than a copy, so the
 * assertions track whatever CSS is actually deployed.
 */
async function openPanelWithTallDetail(page) {
    await page.goto('/');
    await page.evaluate((html) => {
        const panel = document.getElementById('curate-panel');
        panel.style.display = 'flex';
        document.getElementById('curate-detail').innerHTML = html;
    }, DETAIL_HTML);
}

test.describe('curate detail pane', () => {
    test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await openPanelWithTallDetail(page);
    });

    test('the column scrolls rather than overflowing its panel', async ({ page }) => {
        const { scrollable, overflowsPanel } = await page.evaluate(() => {
            const column = document.getElementById('curate-detail');
            const panel = document.getElementById('curate-panel');
            return {
                scrollable: column.scrollHeight > column.clientHeight,
                // The column must not be taller than the panel that clips it.
                overflowsPanel: column.getBoundingClientRect().height
                    > panel.getBoundingClientRect().height + 1,
            };
        });

        expect(scrollable).toBe(true);
        expect(overflowsPanel).toBe(false);
    });

    test('the memo box is fully visible, not halved', async ({ page }) => {
        // The specific symptom: only the top half of the textarea was on screen.
        const cropped = await page.evaluate(() => {
            const memo = document.getElementById('memo').getBoundingClientRect();
            const panel = document.getElementById('curate-panel').getBoundingClientRect();
            return memo.bottom > panel.bottom + 1;
        });

        expect(cropped).toBe(false);
    });

    test('the last comment is reachable by scrolling', async ({ page }) => {
        // Comments render below the memo box, so whatever hid the box hid these.
        const visibleAfterScroll = await page.evaluate(() => {
            const column = document.getElementById('curate-detail');
            column.scrollTop = column.scrollHeight;
            const comment = document.getElementById('last-comment').getBoundingClientRect();
            const box = column.getBoundingClientRect();
            return comment.top >= box.top - 1 && comment.bottom <= box.bottom + 1;
        });

        expect(visibleAfterScroll).toBe(true);
    });

    test('a short detail does not leave the panel stretched empty', async ({ page }) => {
        // Giving the panel a definite height must not turn a one-line detail
        // into a full-height column of blank background.
        const hasContent = await page.evaluate(() => {
            const column = document.getElementById('curate-detail');
            column.innerHTML = '<div class="curate-detail-empty"><p>Select an operation</p></div>';
            const empty = column.querySelector('.curate-detail-empty').getBoundingClientRect();
            return empty.height > 0 && empty.width > 0;
        });

        expect(hasContent).toBe(true);
    });
});

test.describe('the column must not compress its children', () => {
    /**
     * `.curate-detail-column` is a column flex container, so every child is a
     * flex item with the default `flex-shrink: 1`. Once the detail is taller
     * than the column — true of any release bundle — the browser compresses
     * whatever it can before allowing overflow, and a <textarea>'s automatic
     * minimum height is about one line regardless of `rows`. The memo box is
     * therefore the most compressible thing present and absorbs the shrinkage:
     * it rendered roughly ten pixels tall with its placeholder clipped through
     * the middle of the line, and the comment list directly below it was
     * squeezed out of existence.
     *
     * The earlier assertions in this file checked POSITION — that the box sat
     * inside the panel — and a crushed box does. Measuring height is what
     * catches this.
     */
    test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await openPanelWithTallDetail(page);
    });

    test('the memo box keeps its natural height', async ({ page }) => {
        const { inColumn, natural } = await page.evaluate(() => {
            const memo = document.getElementById('memo');
            const inColumn = memo.getBoundingClientRect().height;

            // Same element, same styles, outside the flex column — so the
            // comparison is against whatever two rows actually measure rather
            // than a hard-coded pixel count that a font change would break.
            const probe = memo.cloneNode(true);
            probe.removeAttribute('id');
            document.body.appendChild(probe);
            const natural = probe.getBoundingClientRect().height;
            probe.remove();

            return { inColumn, natural };
        });

        expect(natural).toBeGreaterThan(30);
        expect(inColumn).toBeGreaterThanOrEqual(natural - 1);
    });

    test('the comment list is not squeezed away', async ({ page }) => {
        const { listHeight, rowsHeight } = await page.evaluate(() => {
            const list = document.querySelector('.curate-comments');
            const rows = [...list.querySelectorAll('.curate-comment')];
            return {
                listHeight: list.getBoundingClientRect().height,
                rowsHeight: rows.reduce((sum, r) => sum + r.getBoundingClientRect().height, 0),
            };
        });

        // The block must be at least as tall as the rows it contains.
        expect(listHeight).toBeGreaterThanOrEqual(rowsHeight);
    });

    test('every comment row has real height', async ({ page }) => {
        const heights = await page.evaluate(() =>
            [...document.querySelectorAll('.curate-comment')]
                .map(r => r.getBoundingClientRect().height));

        expect(heights).toHaveLength(3);
        for (const height of heights) expect(height).toBeGreaterThan(10);
    });

    test('the header and voting row are not compressed either', async ({ page }) => {
        // Same class of failure, less visible: these are short and text-based,
        // so their min-content height is close to their natural one and the
        // squeeze never showed.
        const { header, voting } = await page.evaluate(() => ({
            header: document.querySelector('.curate-detail-header').getBoundingClientRect().height,
            voting: document.querySelector('.curate-detail-voting').getBoundingClientRect().height,
        }));

        expect(header).toBeGreaterThan(40);
        expect(voting).toBeGreaterThan(30);
    });
});

test.describe('curate panel on a phone', () => {
    // The panel had no responsive rules at all: a 340px feed column inside a
    // panel capped at 90vw leaves roughly 11px for the detail, so the memo box
    // measured 18px wide and the detail column was a sliver against the edge.
    // Measured across the desktop sizes it scrolls correctly, so this is where
    // "the curation area is cut off" actually comes from.
    test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await openPanelWithTallDetail(page);
    });

    test('the detail column has usable width', async ({ page }) => {
        const width = await page.evaluate(() =>
            document.getElementById('curate-detail').getBoundingClientRect().width);

        // Anything under a couple of hundred pixels cannot show a release
        // bundle's fields, let alone a comment.
        expect(width).toBeGreaterThan(240);
    });

    test('the memo box is wide enough to type in', async ({ page }) => {
        const width = await page.evaluate(() =>
            document.getElementById('memo').getBoundingClientRect().width);

        expect(width).toBeGreaterThan(200);
    });

    test('the panel fits the screen width', async ({ page }) => {
        const overflow = await page.evaluate(() =>
            document.getElementById('curate-panel').getBoundingClientRect().right
                - window.innerWidth);

        expect(overflow).toBeLessThanOrEqual(1);
    });

    test('both the feed and the detail are on screen', async ({ page }) => {
        // Stacked rather than side by side: neither is useful at 175px each.
        const { feed, detail } = await page.evaluate(() => {
            const box = el => el.getBoundingClientRect();
            return {
                feed: box(document.querySelector('.curate-feed-column')).height,
                detail: box(document.getElementById('curate-detail')).height,
            };
        });

        expect(feed).toBeGreaterThan(80);
        expect(detail).toBeGreaterThan(200);
    });

    test('the detail still scrolls rather than cropping', async ({ page }) => {
        const scrollable = await page.evaluate(() => {
            const col = document.getElementById('curate-detail');
            return col.scrollHeight > col.clientHeight;
        });

        expect(scrollable).toBe(true);
    });
});
