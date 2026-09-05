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
 *   renderGroupDetails(group, titleElement, contentElement, nodeId)
 *   renderPersonDetails(person, titleElement, contentElement, nodeId)
 *   renderReleaseDetails(release, titleElement, contentElement)
 *   _renderEditionSwitcher(release)                 → HTMLElement | null
 *   showReleaseDetailsInInfoPanel(release)              entry from overlay
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
     * @param {Object} deps
     * @param {Object} deps.inlineEditor
     *   InlineEditor instance — used by renderGroupDetails / renderPersonDetails
     *   for the per-field edit buttons + the post-render listener wiring.
     * @param {Object} deps.callbacks
     * @param {(container: Element) => void} deps.callbacks.attachNavLinkListeners
     *   Wire `.info-nav-link` clicks to graph navigation. Stays as a callback
     *   because the implementation lives on MusicGraph (it calls into JIT
     *   navigation which the renderer doesn't own).
     * @param {(releaseId: string) => void} deps.callbacks.navigateToRelease
     * @param {(op: Object) => void} deps.callbacks.selectCurateOperation
     * @param {(op: Object, val: number) => void} deps.callbacks.voteFromDetail
     * @param {(releaseId: string, trackId: string) => void} deps.callbacks.playTrack
     *   Point the player at one track of a release. Lives on MusicGraph because
     *   the player instance does.
     * @param {(releaseId: string) => void} deps.callbacks.switchToEdition
     *   Swap the panel to a sibling edition of the release it is showing.
     *   Distinct from navigateToRelease: editions share a performing group, so
     *   graph navigation would re-centre on the node already centred and reset
     *   the orbit overlay under the reader.
     */
    constructor({ inlineEditor, callbacks }) {
        this.inlineEditor = inlineEditor;
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
    /**
     * Parse a timestamp that may be unix seconds or a naive ISO string.
     *
     * These two shapes reach the same renderer from different places, and one
     * of them was silently broken: the contract stores anchors.ts as a uint32
     * of unix SECONDS, so `new Date(ts + 'Z')` built the string "1787608856Z"
     * and every row in the Curate feed read "Invalid Date". The `+ 'Z'` idiom
     * is for a naive datetime like 2026-05-05T00:00:00, which needs a zone;
     * applied to a number it produces nonsense.
     *
     * Returns null rather than an Invalid Date for anything unparseable, so an
     * absent timestamp renders as absent instead of as an error string.
     *
     * @param {number|string|null|undefined} ts
     * @returns {Date|null}
     */
    parseTimestamp(ts) {
        if (ts == null || ts === '') return null;

        // Unix seconds, as a number or an all-digit string.
        if (typeof ts === 'number' || /^\d+$/.test(String(ts))) {
            const date = new Date(Number(ts) * 1000);
            return Number.isNaN(date.getTime()) ? null : date;
        }

        const raw = String(ts);
        // A naive ISO datetime carries no zone; the chain emits UTC.
        const date = new Date(/T/.test(raw) && !/[Zz]|[+-]\d{2}:?\d{2}$/.test(raw)
            ? `${raw}Z`
            : raw);
        return Number.isNaN(date.getTime()) ? null : date;
    }

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

    /**
     * Append the InlineEditor's edit-button HTML to a parent element.
     * editableRowHtml returns a trusted, internally-escaped fragment;
     * insertAdjacentHTML is the right pass-through (it's not user data).
     */
    _appendEditableRow(parent, ...args) {
        parent.insertAdjacentHTML('beforeend', this.inlineEditor.editableRowHtml(...args));
    }

    /**
     * Render Group details in info panel.
     */
    renderGroupDetails(group, titleElement, contentElement, nodeId) {
        titleElement.textContent = group.name || group.group_name || 'Unknown Group';
        contentElement.replaceChildren();

        if (group.photo) {
            contentElement.appendChild(this._el('div', { className: 'info-photo' },
                this._el('img', { src: group.photo, alt: group.name })));
        }
        this._appendEditableRow(contentElement, 'group', nodeId, 'photo', group.photo || '', 'Photo URL');

        const formed = group.formed_date || '';
        const disbanded = group.disbanded_date || 'present';
        if (formed) {
            contentElement.appendChild(this._el('p', { className: 'info-meta' },
                this._el('strong', null, 'Active:'), ` ${formed}–${disbanded}`));
        }

        // Show inferred active range from release dates when claimed dates are missing
        const inferFirst = group.inferred_first_release_date;
        const inferLast = group.inferred_last_release_date;
        if (inferFirst && !formed) {
            const inferRange = inferLast && inferLast !== inferFirst
                ? `${inferFirst}–${inferLast}`
                : inferFirst;
            contentElement.appendChild(this._el('p', { className: 'info-meta info-inferred' },
                this._el('strong', null, 'Active (from releases):'), ' ', inferRange));
        }
        this._appendEditableRow(contentElement, 'group', nodeId, 'formed_date', formed, 'Formed');
        this._appendEditableRow(contentElement, 'group', nodeId, 'disbanded_date', group.disbanded_date || '', 'Disbanded');

        if (group.members && group.members.length > 0) {
            const list = this._el('ul', { className: 'info-list' });
            for (const member of group.members) {
                const role = member.role || '';
                const personId = member.person_id || '';
                const name = personId
                    ? this._el('a', {
                        href: '#', className: 'info-nav-link', 'data-node-id': personId,
                    }, this._el('strong', null, member.person))
                    : this._el('strong', null, member.person);
                const roleSuffix = role ? ` - ${role}` : null;
                list.appendChild(this._el('li', null, name, roleSuffix));
            }
            contentElement.appendChild(this._el('div', { className: 'info-section' },
                this._el('h4', null, 'Members'), list));
        }

        if (group.bio || group.description) {
            contentElement.appendChild(this._el('div', { className: 'info-section' },
                this._el('h4', null, 'Biography'),
                this._el('p', null, group.bio || group.description)));
        }
        this._appendEditableRow(contentElement, 'group', nodeId, 'bio', group.bio || group.description || '', 'Biography', true);

        if (group.trivia) {
            contentElement.appendChild(this._el('div', { className: 'info-section' },
                this._el('h4', null, 'Trivia'),
                this._el('p', null, group.trivia)));
        }
        this._appendEditableRow(contentElement, 'group', nodeId, 'trivia', group.trivia || '', 'Trivia', true);

        this.inlineEditor.attach(contentElement);
        this.callbacks.attachNavLinkListeners(contentElement);
    }

    /**
     * Render Person details in info panel.
     */
    renderPersonDetails(person, titleElement, contentElement, nodeId) {
        titleElement.textContent = person.name || person.person_name || 'Unknown Person';
        contentElement.replaceChildren();

        if (person.photo) {
            contentElement.appendChild(this._el('div', { className: 'info-photo' },
                this._el('img', { src: person.photo, alt: person.name })));
        }
        this._appendEditableRow(contentElement, 'person', nodeId, 'photo', person.photo || '', 'Photo URL');

        const currentColor = person.color || '#888888';
        contentElement.appendChild(this._el('div', { className: 'info-color-row' },
            this._el('strong', null, 'Color:'),
            this._el('span', {
                className: 'info-color-swatch',
                style: `background:${currentColor}`,
            }),
            this._el('span', { className: 'info-color-hex' }, currentColor),
            this._el('input', {
                type: 'color',
                className: 'color-picker-input',
                'data-node-id': nodeId,
                value: currentColor,
                title: 'Edit color',
            })));

        if (person.city) {
            contentElement.appendChild(this._el('p', { className: 'info-meta' },
                this._el('strong', null, 'Location:'), ' ', person.city));
        }
        this._appendEditableRow(contentElement, 'person', nodeId, 'city', person.city || '', 'City');

        if (person.groups && person.groups.length > 0) {
            const list = this._el('ul', { className: 'info-list' });
            for (const grp of person.groups) {
                const role = grp.role || '';
                const groupId = grp.group_id || '';
                const name = groupId
                    ? this._el('a', {
                        href: '#', className: 'info-nav-link', 'data-node-id': groupId,
                    }, this._el('strong', null, grp.group))
                    : this._el('strong', null, grp.group);
                const roleSuffix = role ? ` - ${role}` : null;
                list.appendChild(this._el('li', null, name, roleSuffix));
            }
            contentElement.appendChild(this._el('div', { className: 'info-section' },
                this._el('h4', null, 'Groups'), list));
        }

        if (person.bio) {
            contentElement.appendChild(this._el('div', { className: 'info-section' },
                this._el('h4', null, 'Biography'),
                this._el('p', null, person.bio)));
        }
        this._appendEditableRow(contentElement, 'person', nodeId, 'bio', person.bio || '', 'Biography', true);

        if (person.trivia) {
            contentElement.appendChild(this._el('div', { className: 'info-section' },
                this._el('h4', null, 'Trivia'),
                this._el('p', null, person.trivia)));
        }
        this._appendEditableRow(contentElement, 'person', nodeId, 'trivia', person.trivia || '', 'Trivia', true);

        this.inlineEditor.attach(contentElement);
        this.callbacks.attachNavLinkListeners(contentElement);
    }

    /**
     * Display release details in the info viewer (called from overlay).
     * Reads the `#info-title` and `#info-content` elements directly.
     */
    showReleaseDetailsInInfoPanel(release) {
        const infoTitle = document.getElementById('info-title');
        const infoContent = document.getElementById('info-content');
        if (!infoTitle || !infoContent) return;
        this.renderReleaseDetails(release, infoTitle, infoContent);
    }

    /**
     * Build the edition switcher for a release, or null when there is nothing
     * to switch between.
     *
     * Editions of one album — original pressing, CD remaster, deluxe reissue —
     * are separate Release nodes with separate tracklists, joined by IN_MASTER.
     * The backend returns them ordered oldest-first in `release.versions`, each
     * already carrying an `edition_label` naming what makes it different, so
     * this only has to render position and wire the arrows.
     *
     * @param {Object} release
     * @returns {HTMLElement|null}
     */
    _renderEditionSwitcher(release) {
        const versions = Array.isArray(release.versions) ? release.versions : [];
        // One edition is not a set. Showing "1 of 1" with two dead arrows is
        // worse than showing nothing.
        if (versions.length < 2) return null;

        const index = versions.findIndex(v => v.release_id === release.release_id);
        if (index === -1) return null;

        const go = (delta) => {
            const target = versions[index + delta];
            if (target) this.callbacks.switchToEdition(target.release_id);
        };

        const arrow = (delta, glyph, label) => {
            const target = versions[index + delta];
            return this._el('button', {
                className: 'info-edition__arrow',
                type: 'button',
                disabled: !target,
                title: target ? `${label}: ${target.edition_label}` : `No ${label.toLowerCase()}`,
                'aria-label': target ? `${label}: ${target.edition_label}` : `No ${label.toLowerCase()}`,
                onClick: (e) => { e.stopPropagation(); go(delta); }
            }, glyph);
        };

        const current = versions[index];
        return this._el('div', {
            className: 'info-edition',
            role: 'group',
            'aria-label': 'Release edition'
        },
            arrow(-1, '\u2039', 'Earlier edition'),
            this._el('span', { className: 'info-edition__label' },
                this._el('span', { className: 'info-edition__count' },
                    `Edition ${index + 1} of ${versions.length}`),
                current.edition_label
                    ? this._el('span', { className: 'info-edition__detail' }, current.edition_label)
                    : null),
            arrow(1, '\u203A', 'Later edition')
        );
    }

    /**
     * Render Release details in info panel.
     */
    renderReleaseDetails(release, titleElement, contentElement) {
        titleElement.textContent = release.name || 'Unknown Release';
        contentElement.replaceChildren();

        // Edition switcher, before the artwork so it reads as a control over
        // everything below it — the whole body is re-rendered when it moves.
        // Built inside the rendered body rather than into the static
        // .info-header, so it is torn down automatically when a non-release
        // node is selected next.
        const switcher = this._renderEditionSwitcher(release);
        if (switcher) contentElement.appendChild(switcher);

        if (release.album_art) {
            contentElement.appendChild(this._el('div', { className: 'info-photo' },
                this._el('img', { src: release.album_art, alt: release.name })));
        }

        if (release.release_date) {
            contentElement.appendChild(this._el('p', { className: 'info-meta' },
                this._el('strong', null, 'Released:'), ' ', release.release_date));
        }

        if (release.format) {
            contentElement.appendChild(this._el('p', { className: 'info-meta' },
                this._el('strong', null, 'Format:'), ' ', release.format));
        }

        // Labels
        if (release.labels && release.labels.length > 0) {
            const labelText = release.labels.map(l => l.label || l.name).join(', ');
            contentElement.appendChild(this._el('p', { className: 'info-meta' },
                this._el('strong', null, 'Label:'), ' ', labelText));
        }

        // Groups
        if (release.groups && release.groups.length > 0) {
            const list = this._el('ul', { className: 'info-list' });
            for (const g of release.groups) {
                list.appendChild(this._el('li', null, this._el('strong', null, g.name)));
            }
            contentElement.appendChild(this._el('div', { className: 'info-section' },
                this._el('h4', null, 'Performed by'), list));
        }

        // Tracks
        if (release.tracks && release.tracks.length > 0) {
            const list = this._el('ol', { className: 'info-list info-tracklist' });
            const sorted = [...release.tracks].sort((a, b) => {
                const da = (a.disc_number || 1);
                const db = (b.disc_number || 1);
                if (da !== db) return da - db;
                return (a.track_number || 0) - (b.track_number || 0);
            });
            for (const t of sorted) {
                const side = t.side ? `${t.side}-` : '';
                const num = t.track_number ? `${side}${t.track_number}. ` : '';
                const label = `${num}${t.track || t.title || 'Untitled'}`;
                const row = this._el('li', { className: 'info-track' });

                // Only tracks we can identify get a control. A button that
                // loads nothing is worse than no button.
                if (t.track_id && release.release_id) {
                    row.appendChild(this._el('button', {
                        className: 'info-track__play',
                        // Says what it does. Spotify's embed is a plain iframe
                        // with no controller, so this points the player at the
                        // track and the visitor presses play inside it —
                        // claiming to play it would be a lie.
                        title: 'Load in player',
                        'aria-label': `Load ${label} in player`,
                        onClick: (e) => {
                            e.stopPropagation();
                            this.callbacks.playTrack(release.release_id, t.track_id);
                        },
                    }, '\u25B6'));
                }

                row.appendChild(this._el('span', { className: 'info-track__label' }, label));
                list.appendChild(row);
            }
            contentElement.appendChild(this._el('div', { className: 'info-section' },
                this._el('h4', null, 'Tracks'), list));
        }

        // Guests
        if (release.guests && release.guests.length > 0) {
            const list = this._el('ul', { className: 'info-list' });
            for (const g of release.guests) {
                const roles = g.roles && g.roles.length > 0
                    ? ` - ${g.roles.join(', ')}`
                    : null;
                list.appendChild(this._el('li', null,
                    this._el('strong', null, g.name), roles));
            }
            contentElement.appendChild(this._el('div', { className: 'info-section' },
                this._el('h4', null, 'Guests'), list));
        }

        if (release.liner_notes) {
            contentElement.appendChild(this._el('div', { className: 'info-section' },
                this._el('h4', null, 'Liner Notes'),
                this._el('p', null, release.liner_notes)));
        }
    }

    renderCurateRow(op) {
        // Human labels, not the contract's enum names — a display concern, so
        // this map is deliberately separate from backend/src/constants/eventTypes.js.
        // 22 and 23 were missing, which is why those rows read "TYPE 22".
        const typeNames = {
            21: 'Release', 22: 'Mint Entity', 23: 'Resolve ID',
            30: 'Add Claim', 31: 'Edit Claim',
            40: 'Vote', 41: 'Like', 50: 'Finalize', 60: 'Merge',
        };
        const typeName = typeNames[op.type] || `Type ${op.type}`;

        const summary = op.event_summary;
        const title = summary?.release_name || summary?.group_name || op.hash.substring(0, 12) + '...';

        const ts = this.parseTimestamp(op.ts);
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
                this._el('span', null, this.parseTimestamp(operation.ts)?.toLocaleString() ?? ''),
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

        // The curator's reason, sent with the vote. Declared before the buttons
        // so their handlers can read it.
        //
        // Deliberately NOT prefilled from viewer_vote.memo. That was meant to
        // stop a reason being dropped when a vote is changed, but with the
        // comment shown directly below it put the same sentence on screen twice
        // and the copy in the editable box read as stray example text. An empty
        // box says "write a comment"; the existing one stays visible underneath,
        // attributed. Voting again without retyping produces a vote with no
        // reason, which is accurate — the old vote is being replaced regardless.
        let memoInput = null;

        if (!operation.finalized) {
            memoInput = this._el('textarea', {
                className: 'curate-memo-input',
                rows: '2',
                maxlength: '280',
                placeholder: 'Why? (optional, 280 chars) — e.g. "track 7 credits the wrong Lennon"',
            });

            // Clicking the vote you already hold clears it. The contract erases
            // the row on val === 0 (polaris.music.cpp:667), but these buttons
            // always re-sent the same value, so a vote could be changed and
            // never withdrawn — the label read "Downvoted" and clicking it did
            // nothing visible, because re-asserting a vote is a no-op on chain.
            votingDiv.appendChild(this._el('button', {
                className: 'curate-vote-btn curate-vote-up' + (viewerVote?.val === 1 ? ' curate-vote-btn--active' : ''),
                title: viewerVote?.val === 1 ? 'Click to remove your upvote' : 'Upvote',
                onClick: (e) => {
                    e.stopPropagation();
                    this.callbacks.voteFromDetail(op, viewerVote?.val === 1 ? 0 : 1, memoInput.value);
                },
            }, viewerVote?.val === 1 ? 'Upvoted' : 'Upvote'));

            votingDiv.appendChild(this._el('button', {
                className: 'curate-vote-btn curate-vote-down' + (viewerVote?.val === -1 ? ' curate-vote-btn--active' : ''),
                title: viewerVote?.val === -1 ? 'Click to remove your downvote' : 'Downvote',
                onClick: (e) => {
                    e.stopPropagation();
                    this.callbacks.voteFromDetail(op, viewerVote?.val === -1 ? 0 : -1, memoInput.value);
                },
            }, viewerVote?.val === -1 ? 'Downvoted' : 'Downvote'));
        }
        container.appendChild(votingDiv);
        if (memoInput) container.appendChild(memoInput);

        // Comments, which are the point of the memo: a reviewer should be able
        // to see why something was downvoted without re-deriving it. Votes
        // without a comment are left out — a list of bare names says nothing.
        const commented = (resp.votes ?? []).filter(v => v.memo);
        if (commented.length) {
            const comments = this._el('div', { className: 'curate-comments' },
                this._el('h4', null, `Comments (${commented.length})`));

            for (const v of commented) {
                comments.appendChild(this._el('div', { className: 'curate-comment' },
                    this._el('span', {
                        className: 'curate-comment__voter'
                            + (v.val > 0 ? ' curate-up' : v.val < 0 ? ' curate-down' : ''),
                    }, `${v.voter} ${v.val > 0 ? '▲' : v.val < 0 ? '▼' : '—'}`),
                    this._el('span', { className: 'curate-comment__text' }, v.memo)));
            }
            container.appendChild(comments);
        }

        // Body: type-specific rendering
        const body = this._el('div', { className: 'curate-detail-body' });

        if (detail?.type === 'release_bundle') {
            this.renderReleaseBundleDetail(body, detail);
        } else if (detail?.type === 'add_claim' || detail?.type === 'edit_claim') {
            this.renderClaimDetail(body, detail);
        } else if (detail?.type === 'mint_entity') {
            this.renderMintEntityDetail(body, detail);
        } else if (detail?.type === 'resolve_id') {
            this.renderResolveIdDetail(body, detail);
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
     * MINT_ENTITY (type 22): the creation of a canonical entity.
     *
     * @param {Element} container
     * @param {Object} detail - As shaped by parseOperationDetail.
     */
    renderMintEntityDetail(container, detail) {
        const section = this._el('div', { className: 'curate-section' },
            this._el('h4', null, 'Mint Entity'));

        const fields = [
            this.detailField('Entity Type', detail.entity_type),
            this.detailField('Canonical ID', detail.canonical_id),
        ];

        if (detail.provenance) {
            const prov = typeof detail.provenance === 'object'
                ? (detail.provenance.source || JSON.stringify(detail.provenance))
                : detail.provenance;
            fields.push(this.detailField('Provenance', prov));
        }

        for (const f of fields) if (f) section.appendChild(f);

        // Initial claims are the entity's opening facts, so they are the
        // substance of the operation rather than a footnote to it.
        if (detail.initial_claims?.length) {
            section.appendChild(this._el('h4', null, 'Initial Claims'));
            for (const claim of detail.initial_claims) {
                const value = typeof claim.value === 'object'
                    ? JSON.stringify(claim.value)
                    : claim.value;
                const field = this.detailField(claim.field ?? 'Claim', value);
                if (field) section.appendChild(field);
            }
        }

        container.appendChild(section);
    }

    /**
     * RESOLVE_ID (type 23): mapping a provisional or external id to a canonical one.
     *
     * @param {Element} container
     * @param {Object} detail - As shaped by parseOperationDetail.
     */
    renderResolveIdDetail(container, detail) {
        const section = this._el('div', { className: 'curate-section' },
            this._el('h4', null, 'Resolve ID'));

        const fields = [
            this.detailField('Subject ID', detail.subject_id),
            this.detailField('Canonical ID', detail.canonical_id),
            this.detailField('Method', detail.method),
            // Not detailField: a confidence of 0 is a real, and rather
            // important, claim about the mapping, and detailField drops falsy
            // values.
            detail.confidence == null ? null : this._el('div', { className: 'curate-field' },
                this._el('span', { className: 'curate-field-label' }, 'Confidence'),
                this._el('span', { className: 'curate-field-value' }, String(detail.confidence))),
            this.detailField('Evidence', detail.evidence),
        ];

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
