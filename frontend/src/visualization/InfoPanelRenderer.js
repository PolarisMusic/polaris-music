/**
 * InfoPanelRenderer — DOM rendering for the info panel sections that were
 * previously private methods on MusicGraph (the 2,562-line god class).
 *
 * Each method writes HTML into a caller-provided container element. The
 * renderer is dependency-injected with the small set of MusicGraph callbacks
 * its handlers need (graph navigation, release navigation, curate row
 * selection, voting), so the module has no implicit `this` coupling to
 * MusicGraph beyond the explicit `callbacks` object.
 *
 * Public API:
 *   renderSongDetails(song, titleElement, contentElement)
 *   renderCurateRow(op)                             → HTMLElement
 *   renderCurateDetail(container, resp, op)
 *   renderReleaseBundleDetail(container, detail)
 *   renderClaimDetail(container, detail)
 *   escapeHtml(str)                                 → string
 *   detailField(label, value)                       → string (HTML)
 *
 * Snapshot contract: the HTML produced by these methods is locked by
 * `backend/test/visualization/musicGraphRenders.snapshot.test.js`. If you
 * change the markup, snapshots will diff — investigate before updating.
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
     * Render song details in the info panel.
     * Shows songwriters, lyrics, and clickable releases.
     */
    renderSongDetails(song, titleElement, contentElement) {
        const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        titleElement.textContent = song.title || song.name || 'Unknown Song';

        let html = '';
        html += `<p class="info-meta"><strong>Type:</strong> Song (Composition)</p>`;

        // Songwriters
        const writers = song.writers || [];
        if (writers.length > 0) {
            html += `<div class="info-section"><h4>Songwriters</h4><ul class="info-list">`;
            writers.forEach(w => {
                const nameHtml = w.person_id
                    ? `<a href="#" class="info-nav-link" data-node-id="${esc(w.person_id)}">${esc(w.writer)}</a>`
                    : esc(w.writer);
                html += `<li>${nameHtml}</li>`;
            });
            html += `</ul></div>`;
        }

        // Lyrics
        if (song.lyrics) {
            html += `<div class="info-section"><h4>Lyrics</h4><pre class="info-lyrics">${esc(song.lyrics)}</pre></div>`;
        }

        // Releases (clickable)
        const releases = song.releases || [];
        if (releases.length > 0) {
            html += `<div class="info-section"><h4>Appears On</h4><ul class="info-list">`;
            releases.forEach(r => {
                const date = r.release_date ? ` (${esc(r.release_date.substring(0, 4))})` : '';
                html += `<li><a href="#" class="info-nav-link song-release-link" data-release-id="${esc(r.release_id)}">${esc(r.release)}</a>${date}</li>`;
            });
            html += `</ul></div>`;
        }

        contentElement.innerHTML = html;

        // Attach click handlers for songwriter navigation
        this.callbacks.attachNavLinkListeners(contentElement);

        // Attach click handlers for release navigation
        contentElement.querySelectorAll('.song-release-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const releaseId = link.dataset.releaseId;
                if (releaseId) this.callbacks.navigateToRelease(releaseId);
            });
        });
    }

    renderCurateRow(op) {
        const row = document.createElement('div');
        row.className = 'curate-row';
        row.dataset.hash = op.hash;

        const typeNames = {
            21: 'Release', 30: 'Add Claim', 31: 'Edit Claim',
            40: 'Vote', 41: 'Like', 50: 'Finalize', 60: 'Merge'
        };
        const typeName = typeNames[op.type] || `Type ${op.type}`;

        const summary = op.event_summary;
        let title = summary?.release_name || summary?.group_name || op.hash.substring(0, 12) + '...';

        const ts = op.ts ? new Date(op.ts + 'Z') : null;
        const timeStr = ts ? ts.toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';

        const tally = op.tally || { up_weight: 0, down_weight: 0, up_voter_count: 0, down_voter_count: 0 };
        const netScore = tally.up_weight - tally.down_weight;

        const statusClass = op.finalized ? 'curate-status--finalized' : '';
        const statusLabel = op.finalized ? 'Finalized' : 'Open';

        row.innerHTML = `
            <div class="curate-row__header">
                <span class="curate-type-badge curate-type-${op.type}">${typeName}</span>
                <span class="curate-row__title">${this.escapeHtml(title)}</span>
                <span class="curate-row__time">${timeStr}</span>
            </div>
            <div class="curate-row__author">by ${this.escapeHtml(op.author)}</div>
            <div class="curate-row__tally">
                <span class="curate-score ${netScore > 0 ? 'curate-score--positive' : netScore < 0 ? 'curate-score--negative' : ''}">
                    ${netScore > 0 ? '+' : ''}${netScore}
                </span>
                <span class="curate-voters">
                    <span class="curate-up">${tally.up_weight} (${tally.up_voter_count})</span>
                    /
                    <span class="curate-down">${tally.down_weight} (${tally.down_voter_count})</span>
                </span>
                <span class="curate-status ${statusClass}">${statusLabel}</span>
            </div>
        `;

        // Click row to show detail (not the vote buttons)
        row.addEventListener('click', () => this.callbacks.selectCurateOperation(op));

        return row;
    }

    renderCurateDetail(container, resp, op) {
        container.innerHTML = '';

        const operation = resp.operation || {};
        const tally = resp.tally || { up_weight: 0, down_weight: 0, up_voter_count: 0, down_voter_count: 0 };
        const detail = resp.detail;
        const event = resp.event;
        const viewerVote = resp.viewer_vote;

        // Header
        const header = document.createElement('div');
        header.className = 'curate-detail-header';
        header.innerHTML = `
            <h3>${this.escapeHtml(operation.type_name || 'Operation')}</h3>
            <div class="curate-detail-meta">
                <span>by ${this.escapeHtml(operation.author || '?')}</span>
                <span>${operation.ts ? new Date(operation.ts + 'Z').toLocaleString() : ''}</span>
                <span>${operation.finalized ? 'Finalized' : 'Open'}</span>
            </div>
        `;
        container.appendChild(header);

        // Voting controls in detail pane
        const netScore = tally.up_weight - tally.down_weight;
        const votingDiv = document.createElement('div');
        votingDiv.className = 'curate-detail-voting';
        votingDiv.innerHTML = `
            <span class="curate-score ${netScore > 0 ? 'curate-score--positive' : netScore < 0 ? 'curate-score--negative' : ''}">
                ${netScore > 0 ? '+' : ''}${netScore}
            </span>
            <span class="curate-voters">
                <span class="curate-up">${tally.up_weight} (${tally.up_voter_count})</span> /
                <span class="curate-down">${tally.down_weight} (${tally.down_voter_count})</span>
            </span>
        `;

        if (!operation.finalized) {
            const upBtn = document.createElement('button');
            upBtn.className = 'curate-vote-btn curate-vote-up' + (viewerVote?.val === 1 ? ' curate-vote-btn--active' : '');
            upBtn.textContent = viewerVote?.val === 1 ? 'Upvoted' : 'Upvote';
            upBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.callbacks.voteFromDetail(op, 1);
            });

            const downBtn = document.createElement('button');
            downBtn.className = 'curate-vote-btn curate-vote-down' + (viewerVote?.val === -1 ? ' curate-vote-btn--active' : '');
            downBtn.textContent = viewerVote?.val === -1 ? 'Downvoted' : 'Downvote';
            downBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.callbacks.voteFromDetail(op, -1);
            });

            votingDiv.appendChild(upBtn);
            votingDiv.appendChild(downBtn);
        }
        container.appendChild(votingDiv);

        // Body: type-specific rendering
        const body = document.createElement('div');
        body.className = 'curate-detail-body';

        if (detail?.type === 'release_bundle') {
            this.renderReleaseBundleDetail(body, detail);
        } else if (detail?.type === 'add_claim' || detail?.type === 'edit_claim') {
            this.renderClaimDetail(body, detail);
        } else if (detail) {
            body.innerHTML = '<p style="color:#888">Unsupported operation type for detailed view.</p>';
        } else {
            body.innerHTML = '<p style="color:#888">No event payload available.</p>';
        }

        container.appendChild(body);

        // Raw JSON toggle
        if (event) {
            const rawSection = document.createElement('div');
            rawSection.className = 'curate-raw-json';
            rawSection.innerHTML = `
                <details>
                    <summary>Raw Event JSON</summary>
                    <pre>${this.escapeHtml(JSON.stringify(event, null, 2))}</pre>
                </details>
            `;
            body.appendChild(rawSection);
        }
    }

    renderReleaseBundleDetail(container, detail) {
        const rel = detail.release || {};

        // Release info section
        const releaseSection = document.createElement('div');
        releaseSection.className = 'curate-section';
        let releaseHtml = '<h4>Release</h4>';
        releaseHtml += this.detailField('Name', rel.name);
        if (rel.release_date) releaseHtml += this.detailField('Date', rel.release_date);
        if (rel.format) releaseHtml += this.detailField('Format', rel.format);
        if (rel.alt_names?.length) releaseHtml += this.detailField('Alt Names', rel.alt_names.join(', '));
        if (rel.master_id) releaseHtml += this.detailField('Master ID', rel.master_id);
        releaseSection.innerHTML = releaseHtml;
        container.appendChild(releaseSection);

        // Labels
        if (rel.labels?.length) {
            const labelsSection = document.createElement('div');
            labelsSection.className = 'curate-section';
            let html = '<h4>Labels</h4>';
            for (const l of rel.labels) {
                html += `<div class="curate-field-value">${this.escapeHtml(l.name)}${l.label_id ? ` <span style="color:#666">(${this.escapeHtml(l.label_id)})</span>` : ''}</div>`;
            }
            labelsSection.innerHTML = html;
            container.appendChild(labelsSection);
        }

        // Groups
        if (detail.groups?.length) {
            const groupsSection = document.createElement('div');
            groupsSection.className = 'curate-section';
            let html = '<h4>Groups</h4>';
            for (const g of detail.groups) {
                html += `<div class="curate-field-value" style="margin-bottom:6px"><strong>${this.escapeHtml(g.name)}</strong>${g.group_id ? ` <span style="color:#666">(${this.escapeHtml(g.group_id)})</span>` : ''}</div>`;
                if (g.members?.length) {
                    html += '<div class="curate-person-list">';
                    for (const m of g.members) {
                        html += `<span class="curate-person-chip">${this.escapeHtml(m.name)}${m.roles?.length ? ` <span class="curate-role">${this.escapeHtml(m.roles.join(', '))}</span>` : ''}</span>`;
                    }
                    html += '</div>';
                }
            }
            groupsSection.innerHTML = html;
            container.appendChild(groupsSection);
        }

        // Release guests
        if (rel.guests?.length) {
            const guestsSection = document.createElement('div');
            guestsSection.className = 'curate-section';
            let html = '<h4>Release Personnel</h4><div class="curate-person-list">';
            for (const g of rel.guests) {
                html += `<span class="curate-person-chip">${this.escapeHtml(g.name)}${g.roles?.length ? ` <span class="curate-role">${this.escapeHtml(g.roles.join(', '))}</span>` : ''}</span>`;
            }
            html += '</div>';
            guestsSection.innerHTML = html;
            container.appendChild(guestsSection);
        }

        // Tracklist / tracks
        if (detail.tracks?.length) {
            const tracksSection = document.createElement('div');
            tracksSection.className = 'curate-section';
            let html = '<h4>Tracks</h4>';
            for (let i = 0; i < detail.tracks.length; i++) {
                const t = detail.tracks[i];
                const pos = detail.tracklist?.[i]?.position || (i + 1);
                html += '<div class="curate-track-item">';
                html += `<div class="curate-track-title">${pos}. ${this.escapeHtml(t.title || 'Untitled')}${t.track_id ? ` <span style="color:#666;font-size:10px">${this.escapeHtml(t.track_id)}</span>` : ''}</div>`;

                // Track groups
                if (t.performed_by_groups?.length) {
                    for (const g of t.performed_by_groups) {
                        html += `<div class="curate-track-credits">Group: ${this.escapeHtml(g.name)}`;
                        if (g.members?.length) {
                            html += ' (' + g.members.map(m => this.escapeHtml(m.name)).join(', ') + ')';
                        }
                        html += '</div>';
                    }
                }

                // Track guests
                if (t.guests?.length) {
                    html += `<div class="curate-track-credits">Guests: ${t.guests.map(g => this.escapeHtml(g.name) + (g.roles?.length ? ` (${this.escapeHtml(g.roles.join(', '))})` : '')).join(', ')}</div>`;
                }

                // Producers
                if (t.producers?.length) {
                    html += `<div class="curate-track-credits">Producers: ${t.producers.map(p => this.escapeHtml(p.name)).join(', ')}</div>`;
                }

                // Cover / Samples
                if (t.cover_of_song_id) {
                    html += `<div class="curate-track-credits">Cover of: ${this.escapeHtml(t.cover_of_song_id)}</div>`;
                }
                if (t.samples?.length) {
                    html += `<div class="curate-track-credits">Samples: ${t.samples.map(s => this.escapeHtml(s.sampled_track_id || '')).join(', ')}</div>`;
                }

                // Listen links
                if (t.listen_links?.length) {
                    html += `<div class="curate-track-credits">Listen: ${t.listen_links.map(l => `<a href="${this.escapeHtml(l)}" target="_blank" style="color:#5c9cef">${this.escapeHtml(new URL(l).hostname)}</a>`).join(', ')}</div>`;
                }

                html += '</div>';
            }
            tracksSection.innerHTML = html;
            container.appendChild(tracksSection);
        }

        // Songs
        if (detail.songs?.length) {
            const songsSection = document.createElement('div');
            songsSection.className = 'curate-section';
            let html = '<h4>Songs (Compositions)</h4>';
            for (const s of detail.songs) {
                html += `<div class="curate-field-value" style="margin-bottom:4px">${this.escapeHtml(s.title)}`;
                if (s.writers?.length) {
                    html += ` — ${s.writers.map(w => this.escapeHtml(w.name)).join(', ')}`;
                }
                html += '</div>';
            }
            songsSection.innerHTML = html;
            container.appendChild(songsSection);
        }

        // Sources
        if (detail.sources?.length) {
            const srcSection = document.createElement('div');
            srcSection.className = 'curate-section';
            let html = '<h4>Sources</h4>';
            for (const s of detail.sources) {
                html += `<div class="curate-field-value"><a href="${this.escapeHtml(s.url || '')}" target="_blank" style="color:#5c9cef">${this.escapeHtml(s.url || '')}</a></div>`;
            }
            srcSection.innerHTML = html;
            container.appendChild(srcSection);
        }
    }

    renderClaimDetail(container, detail) {
        const section = document.createElement('div');
        section.className = 'curate-section';
        let html = `<h4>${detail.type === 'edit_claim' ? 'Edit Claim' : 'Add Claim'}</h4>`;
        if (detail.target_type) html += this.detailField('Target Type', detail.target_type);
        if (detail.target_id) html += this.detailField('Target ID', detail.target_id);
        if (detail.field) html += this.detailField('Field', detail.field);
        if (detail.value !== undefined && detail.value !== null) {
            const valStr = typeof detail.value === 'object' ? JSON.stringify(detail.value, null, 2) : String(detail.value);
            html += this.detailField('Value', valStr);
        }
        if (detail.source) html += this.detailField('Source', typeof detail.source === 'object' ? detail.source.url || JSON.stringify(detail.source) : detail.source);
        section.innerHTML = html;
        container.appendChild(section);
    }

    detailField(label, value) {
        if (!value) return '';
        return `<div class="curate-field"><span class="curate-field-label">${this.escapeHtml(label)}</span><span class="curate-field-value">${this.escapeHtml(String(value))}</span></div>`;
    }

    escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
}
