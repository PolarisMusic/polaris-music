/**
 * InfoPanelRenderer — DOM rendering for the info panel sections that were
 * previously private methods on MusicGraph (the 2,562-line god class).
 *
 * Each method writes content into a caller-provided container element. The
 * renderer is dependency-injected with the small set of MusicGraph callbacks
 * its handlers need (graph navigation, release navigation, curate row
 * selection, voting), so the module has no implicit `this` coupling to
 * MusicGraph beyond the explicit `callbacks` object.
 *
 * Stage L (PR-L): all `innerHTML += <template literal>` patterns have been
 * replaced with explicit DOM construction via the `_el` helper. User-supplied
 * values now flow through `Text` nodes (auto-escaped by the browser) instead
 * of being interpolated into HTML strings, removing the implicit XSS surface
 * that lived in every escapeHtml call site. The snapshot suite at
 * `backend/test/visualization/musicGraphRenders.snapshot.test.js` locks the
 * serialized output. The previous template-literal whitespace text nodes
 * (between sibling block elements) are gone — semantically identical, byte-
 * different. Snapshots updated in the same PR; reviewed for whitespace-only
 * drift.
 *
 * Public API:
 *   renderSongDetails(song, titleElement, contentElement)
 *   renderCurateRow(op)                             → HTMLElement
 *   renderCurateDetail(container, resp, op)
 *   renderReleaseBundleDetail(container, detail)
 *   renderClaimDetail(container, detail)
 *   detailField(label, value)                       → HTMLElement | null
 *   escapeHtml(str)                                 → string  (legacy, retained
 *                                                    for any external caller; no
 *                                                    longer used internally)
 *
 * @module visualization/InfoPanelRenderer
 */

export class InfoPanelRenderer {
    /**
     * @param {Object} callbacks
     * @param {(container: Element) => void} callbacks.attachNavLinkListeners
     *   Wire `.info-nav-link` clicks to graph navigation. Lives on MusicGraph
     *   because it's also used by render methods that haven't been moved here
     *   (renderGroupDetails, renderPersonDetails).
     * @param {(releaseId: string) => void} callbacks.navigateToRelease
     * @param {(op: Object) => void} callbacks.selectCurateOperation
     * @param {(op: Object, val: number) => void} callbacks.voteFromDetail
     */
    constructor(callbacks) {
        this.callbacks = callbacks;
    }

    /**
     * DOM-builder helper. Builds a single element with attributes and
     * children in one call.
     *
     *   _el('div', {className: 'foo'}, 'hello', _el('span', null, 'world'))
     *
     * Attribute keys:
     *   - 'className'                      → assigned to el.className
     *   - 'style'   (string)               → setAttribute('style', value).
     *                                        Strings are preferred over objects
     *                                        because jsdom normalizes any value
     *                                        set through el.style.* (e.g.,
     *                                        '#666' → 'rgb(102, 102, 102)') and
     *                                        we want byte-stable snapshots.
     *   - 'dataset' (object)               → Object.assign(el.dataset, value)
     *   - 'onClick' (function)             → addEventListener('click', value)
     *   - everything else                  → setAttribute(key, value)
     *   - value === false / null / undefined → attribute skipped
     *
     * Children:
     *   - strings / numbers → wrapped in a Text node (auto-escapes)
     *   - Element / DocumentFragment → appended as-is
     *   - false / null / undefined  → skipped (so conditional children
     *     can be inlined: `cond && _el(...)`)
     *   - arrays are flattened
     */
    _el(tag, attrs, ...children) {
        const el = document.createElement(tag);
        if (attrs) {
            for (const [key, value] of Object.entries(attrs)) {
                if (value == null || value === false) continue;
                if (key === 'className') {
                    el.className = value;
                } else if (key === 'dataset' && typeof value === 'object') {
                    Object.assign(el.dataset, value);
                } else if (key.startsWith('on') && typeof value === 'function') {
                    el.addEventListener(key.slice(2).toLowerCase(), value);
                } else {
                    el.setAttribute(key, value);
                }
            }
        }
        for (const child of children.flat()) {
            if (child == null || child === false) continue;
            if (typeof child === 'string' || typeof child === 'number') {
                el.appendChild(document.createTextNode(String(child)));
            } else {
                el.appendChild(child);
            }
        }
        return el;
    }

    /**
     * Render song details in the info panel.
     * Shows songwriters, lyrics, and clickable releases.
     */
    renderSongDetails(song, titleElement, contentElement) {
        titleElement.textContent = song.title || song.name || 'Unknown Song';
        contentElement.replaceChildren();

        contentElement.appendChild(
            this._el('p', { className: 'info-meta' },
                this._el('strong', null, 'Type:'), ' Song (Composition)'));

        const writers = song.writers || [];
        if (writers.length > 0) {
            const ul = this._el('ul', { className: 'info-list' });
            for (const w of writers) {
                const inner = w.person_id
                    ? this._el('a', {
                        href: '#',
                        className: 'info-nav-link',
                        'data-node-id': w.person_id,
                    }, w.writer)
                    : w.writer;
                ul.appendChild(this._el('li', null, inner));
            }
            contentElement.appendChild(this._el('div', { className: 'info-section' },
                this._el('h4', null, 'Songwriters'),
                ul));
        }

        if (song.lyrics) {
            contentElement.appendChild(this._el('div', { className: 'info-section' },
                this._el('h4', null, 'Lyrics'),
                this._el('pre', { className: 'info-lyrics' }, song.lyrics)));
        }

        const releases = song.releases || [];
        if (releases.length > 0) {
            const ul = this._el('ul', { className: 'info-list' });
            for (const r of releases) {
                const link = this._el('a', {
                    href: '#',
                    className: 'info-nav-link song-release-link',
                    'data-release-id': r.release_id,
                }, r.release);
                const dateText = r.release_date
                    ? ` (${r.release_date.substring(0, 4)})`
                    : null;
                ul.appendChild(this._el('li', null, link, dateText));
            }
            contentElement.appendChild(this._el('div', { className: 'info-section' },
                this._el('h4', null, 'Appears On'),
                ul));
        }

        // Songwriter nav handlers
        this.callbacks.attachNavLinkListeners(contentElement);

        // Release nav handlers (specific to .song-release-link — separate flow)
        contentElement.querySelectorAll('.song-release-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const releaseId = link.dataset.releaseId;
                if (releaseId) this.callbacks.navigateToRelease(releaseId);
            });
        });
    }

    renderCurateRow(op) {
        const typeNames = {
            21: 'Release', 30: 'Add Claim', 31: 'Edit Claim',
            40: 'Vote', 41: 'Like', 50: 'Finalize', 60: 'Merge',
        };
        const typeName = typeNames[op.type] || `Type ${op.type}`;

        const summary = op.event_summary;
        const title = summary?.release_name || summary?.group_name || op.hash.substring(0, 12) + '...';

        const ts = op.ts ? new Date(op.ts + 'Z') : null;
        const timeStr = ts ? ts.toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';

        const tally = op.tally || { up_weight: 0, down_weight: 0, up_voter_count: 0, down_voter_count: 0 };
        const netScore = tally.up_weight - tally.down_weight;

        const scoreClass = 'curate-score' +
            (netScore > 0 ? ' curate-score--positive'
                : netScore < 0 ? ' curate-score--negative' : '');

        const row = this._el('div', {
            className: 'curate-row',
            dataset: { hash: op.hash },
        },
            this._el('div', { className: 'curate-row__header' },
                this._el('span', { className: `curate-type-badge curate-type-${op.type}` }, typeName),
                this._el('span', { className: 'curate-row__title' }, title),
                this._el('span', { className: 'curate-row__time' }, timeStr)),
            this._el('div', { className: 'curate-row__author' }, 'by ', op.author),
            this._el('div', { className: 'curate-row__tally' },
                this._el('span', { className: scoreClass },
                    (netScore > 0 ? '+' : '') + netScore),
                this._el('span', { className: 'curate-voters' },
                    this._el('span', { className: 'curate-up' },
                        `${tally.up_weight} (${tally.up_voter_count})`),
                    ' / ',
                    this._el('span', { className: 'curate-down' },
                        `${tally.down_weight} (${tally.down_voter_count})`)),
                this._el('span', {
                    className: 'curate-status' + (op.finalized ? ' curate-status--finalized' : ''),
                }, op.finalized ? 'Finalized' : 'Open'))
        );

        row.addEventListener('click', () => this.callbacks.selectCurateOperation(op));
        return row;
    }

    renderCurateDetail(container, resp, op) {
        container.replaceChildren();

        const operation = resp.operation || {};
        const tally = resp.tally || { up_weight: 0, down_weight: 0, up_voter_count: 0, down_voter_count: 0 };
        const detail = resp.detail;
        const event = resp.event;
        const viewerVote = resp.viewer_vote;

        // Header
        container.appendChild(this._el('div', { className: 'curate-detail-header' },
            this._el('h3', null, operation.type_name || 'Operation'),
            this._el('div', { className: 'curate-detail-meta' },
                this._el('span', null, 'by ', operation.author || '?'),
                this._el('span', null, operation.ts ? new Date(operation.ts + 'Z').toLocaleString() : ''),
                this._el('span', null, operation.finalized ? 'Finalized' : 'Open'))));

        // Voting controls
        const netScore = tally.up_weight - tally.down_weight;
        const scoreClass = 'curate-score' +
            (netScore > 0 ? ' curate-score--positive'
                : netScore < 0 ? ' curate-score--negative' : '');

        const votingDiv = this._el('div', { className: 'curate-detail-voting' },
            this._el('span', { className: scoreClass },
                (netScore > 0 ? '+' : '') + netScore),
            this._el('span', { className: 'curate-voters' },
                this._el('span', { className: 'curate-up' },
                    `${tally.up_weight} (${tally.up_voter_count})`),
                ' / ',
                this._el('span', { className: 'curate-down' },
                    `${tally.down_weight} (${tally.down_voter_count})`)));

        if (!operation.finalized) {
            votingDiv.appendChild(this._el('button', {
                className: 'curate-vote-btn curate-vote-up' + (viewerVote?.val === 1 ? ' curate-vote-btn--active' : ''),
                onClick: (e) => { e.stopPropagation(); this.callbacks.voteFromDetail(op, 1); },
            }, viewerVote?.val === 1 ? 'Upvoted' : 'Upvote'));

            votingDiv.appendChild(this._el('button', {
                className: 'curate-vote-btn curate-vote-down' + (viewerVote?.val === -1 ? ' curate-vote-btn--active' : ''),
                onClick: (e) => { e.stopPropagation(); this.callbacks.voteFromDetail(op, -1); },
            }, viewerVote?.val === -1 ? 'Downvoted' : 'Downvote'));
        }
        container.appendChild(votingDiv);

        // Body: type-specific rendering
        const body = this._el('div', { className: 'curate-detail-body' });

        if (detail?.type === 'release_bundle') {
            this.renderReleaseBundleDetail(body, detail);
        } else if (detail?.type === 'add_claim' || detail?.type === 'edit_claim') {
            this.renderClaimDetail(body, detail);
        } else if (detail) {
            body.appendChild(this._el('p', { style: 'color:#888' },
                'Unsupported operation type for detailed view.'));
        } else {
            body.appendChild(this._el('p', { style: 'color:#888' },
                'No event payload available.'));
        }

        container.appendChild(body);

        // Raw JSON toggle
        if (event) {
            body.appendChild(this._el('div', { className: 'curate-raw-json' },
                this._el('details', null,
                    this._el('summary', null, 'Raw Event JSON'),
                    this._el('pre', null, JSON.stringify(event, null, 2)))));
        }
    }

    renderReleaseBundleDetail(container, detail) {
        const rel = detail.release || {};

        // Release info section
        const releaseSection = this._el('div', { className: 'curate-section' },
            this._el('h4', null, 'Release'));
        const releaseFields = [
            this.detailField('Name', rel.name),
            rel.release_date && this.detailField('Date', rel.release_date),
            rel.format && this.detailField('Format', rel.format),
            rel.alt_names?.length && this.detailField('Alt Names', rel.alt_names.join(', ')),
            rel.master_id && this.detailField('Master ID', rel.master_id),
        ];
        for (const f of releaseFields) if (f) releaseSection.appendChild(f);
        container.appendChild(releaseSection);

        // Labels
        if (rel.labels?.length) {
            const labelsSection = this._el('div', { className: 'curate-section' },
                this._el('h4', null, 'Labels'));
            for (const l of rel.labels) {
                const idSuffix = l.label_id
                    ? [' ', this._el('span', { style: 'color:#666' }, `(${l.label_id})`)]
                    : null;
                labelsSection.appendChild(this._el('div', { className: 'curate-field-value' },
                    l.name, idSuffix));
            }
            container.appendChild(labelsSection);
        }

        // Groups
        if (detail.groups?.length) {
            const groupsSection = this._el('div', { className: 'curate-section' },
                this._el('h4', null, 'Groups'));
            for (const g of detail.groups) {
                const idSuffix = g.group_id
                    ? [' ', this._el('span', { style: 'color:#666' }, `(${g.group_id})`)]
                    : null;
                groupsSection.appendChild(this._el('div', {
                    className: 'curate-field-value',
                    style: 'margin-bottom:6px',
                },
                    this._el('strong', null, g.name), idSuffix));

                if (g.members?.length) {
                    const list = this._el('div', { className: 'curate-person-list' });
                    for (const m of g.members) {
                        const roleSuffix = m.roles?.length
                            ? [' ', this._el('span', { className: 'curate-role' }, m.roles.join(', '))]
                            : null;
                        list.appendChild(this._el('span', { className: 'curate-person-chip' },
                            m.name, roleSuffix));
                    }
                    groupsSection.appendChild(list);
                }
            }
            container.appendChild(groupsSection);
        }

        // Release guests
        if (rel.guests?.length) {
            const guestsSection = this._el('div', { className: 'curate-section' },
                this._el('h4', null, 'Release Personnel'));
            const list = this._el('div', { className: 'curate-person-list' });
            for (const g of rel.guests) {
                const roleSuffix = g.roles?.length
                    ? [' ', this._el('span', { className: 'curate-role' }, g.roles.join(', '))]
                    : null;
                list.appendChild(this._el('span', { className: 'curate-person-chip' },
                    g.name, roleSuffix));
            }
            guestsSection.appendChild(list);
            container.appendChild(guestsSection);
        }

        // Tracklist / tracks
        if (detail.tracks?.length) {
            const tracksSection = this._el('div', { className: 'curate-section' },
                this._el('h4', null, 'Tracks'));
            for (let i = 0; i < detail.tracks.length; i++) {
                const t = detail.tracks[i];
                const pos = detail.tracklist?.[i]?.position || (i + 1);
                const item = this._el('div', { className: 'curate-track-item' });

                const titleEl = this._el('div', { className: 'curate-track-title' },
                    `${pos}. ${t.title || 'Untitled'}`,
                    t.track_id
                        ? [' ', this._el('span', { style: 'color:#666;font-size:10px' }, t.track_id)]
                        : null);
                item.appendChild(titleEl);

                // Track groups
                if (t.performed_by_groups?.length) {
                    for (const g of t.performed_by_groups) {
                        const memberText = g.members?.length
                            ? ` (${g.members.map(m => m.name).join(', ')})`
                            : '';
                        item.appendChild(this._el('div', { className: 'curate-track-credits' },
                            'Group: ', g.name, memberText));
                    }
                }

                // Track guests
                if (t.guests?.length) {
                    const guestsText = t.guests.map(g => {
                        const roles = g.roles?.length ? ` (${g.roles.join(', ')})` : '';
                        return `${g.name}${roles}`;
                    }).join(', ');
                    item.appendChild(this._el('div', { className: 'curate-track-credits' },
                        'Guests: ', guestsText));
                }

                // Producers
                if (t.producers?.length) {
                    item.appendChild(this._el('div', { className: 'curate-track-credits' },
                        'Producers: ', t.producers.map(p => p.name).join(', ')));
                }

                // Cover / Samples
                if (t.cover_of_song_id) {
                    item.appendChild(this._el('div', { className: 'curate-track-credits' },
                        'Cover of: ', t.cover_of_song_id));
                }
                if (t.samples?.length) {
                    item.appendChild(this._el('div', { className: 'curate-track-credits' },
                        'Samples: ', t.samples.map(s => s.sampled_track_id || '').join(', ')));
                }

                // Listen links — anchor href is a URL; routing through Text nodes
                // means the URL never reaches an HTML parser, so a `javascript:`
                // URI in the data would still bind to href via setAttribute.
                // Validate scheme to prevent that.
                if (t.listen_links?.length) {
                    const linkRow = this._el('div', { className: 'curate-track-credits' }, 'Listen: ');
                    const safeLinks = t.listen_links.filter(l => /^https?:\/\//i.test(l));
                    safeLinks.forEach((url, idx) => {
                        if (idx > 0) linkRow.appendChild(document.createTextNode(', '));
                        let host;
                        try { host = new URL(url).hostname; } catch { host = url; }
                        linkRow.appendChild(this._el('a', {
                            href: url,
                            target: '_blank',
                            style: 'color:#5c9cef',
                        }, host));
                    });
                    if (safeLinks.length > 0) item.appendChild(linkRow);
                }

                tracksSection.appendChild(item);
            }
            container.appendChild(tracksSection);
        }

        // Songs
        if (detail.songs?.length) {
            const songsSection = this._el('div', { className: 'curate-section' },
                this._el('h4', null, 'Songs (Compositions)'));
            for (const s of detail.songs) {
                const writerText = s.writers?.length
                    ? ' — ' + s.writers.map(w => w.name).join(', ')
                    : null;
                songsSection.appendChild(this._el('div', {
                    className: 'curate-field-value',
                    style: 'margin-bottom:4px',
                }, s.title, writerText));
            }
            container.appendChild(songsSection);
        }

        // Sources — same javascript: URI guard as listen_links above.
        if (detail.sources?.length) {
            const srcSection = this._el('div', { className: 'curate-section' },
                this._el('h4', null, 'Sources'));
            for (const s of detail.sources) {
                const url = s.url || '';
                const safe = /^https?:\/\//i.test(url);
                srcSection.appendChild(this._el('div', { className: 'curate-field-value' },
                    safe
                        ? this._el('a', { href: url, target: '_blank', style: 'color:#5c9cef' }, url)
                        : url));
            }
            container.appendChild(srcSection);
        }
    }

    renderClaimDetail(container, detail) {
        const section = this._el('div', { className: 'curate-section' },
            this._el('h4', null, detail.type === 'edit_claim' ? 'Edit Claim' : 'Add Claim'));

        const fields = [
            detail.target_type && this.detailField('Target Type', detail.target_type),
            detail.target_id && this.detailField('Target ID', detail.target_id),
            detail.field && this.detailField('Field', detail.field),
        ];

        if (detail.value !== undefined && detail.value !== null) {
            const valStr = typeof detail.value === 'object'
                ? JSON.stringify(detail.value, null, 2)
                : String(detail.value);
            fields.push(this.detailField('Value', valStr));
        }
        if (detail.source) {
            const sourceStr = typeof detail.source === 'object'
                ? (detail.source.url || JSON.stringify(detail.source))
                : detail.source;
            fields.push(this.detailField('Source', sourceStr));
        }

        for (const f of fields) if (f) section.appendChild(f);
        container.appendChild(section);
    }

    /**
     * Build a labeled detail field. Now returns an Element instead of an HTML
     * string (it used to be string-concatenated into innerHTML). Returns null
     * for falsy values so callers can `if (f) parent.appendChild(f)`.
     */
    detailField(label, value) {
        if (!value) return null;
        return this._el('div', { className: 'curate-field' },
            this._el('span', { className: 'curate-field-label' }, label),
            this._el('span', { className: 'curate-field-value' }, String(value)));
    }

    /**
     * Legacy HTML-encoder. No internal callers after PR-L; retained because
     * external code (MusicGraph render methods that haven't yet moved here)
     * may still depend on it.
     */
    escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
}
