/**
 * ReleaseOrbitOverlay - Contextual release browser around selected group nodes.
 *
 * Renders release tiles as square album-art thumbnails in a radial orbit around
 * the selected group's screen position. Clicking a tile expands it, shows guest
 * nodes radially around it, and populates the info viewer with release details.
 *
 * This is a DOM overlay, not part of the Hypertree canvas. It sits above the
 * canvas with pointer-events:none on the container, pointer-events:auto on
 * interactive children.
 */

import { canHover } from './pointerCapability.js';

export class ReleaseOrbitOverlay {
    /**
     * @param {Object} options
     * @param {Object} options.api - GraphAPI instance
     * @param {Function} options.onReleaseSelect - Called with release details when a tile is clicked
     * @param {Function} options.onGuestSelect - Called with (guest, release)
     *        when a guest chip is clicked. The chip is the guest's node here;
     *        selecting it marks it and fills the panel rather than moving the
     *        graph, because a guest with no membership has nothing to arrive
     *        at — navigating to one landed on a bare node joined to nothing.
     */
    constructor({ api, onReleaseSelect, onGuestSelect }) {
        this.api = api;
        this.onReleaseSelect = onReleaseSelect || (() => {});
        this.onGuestSelect = onGuestSelect || (() => {});

        /** The guest chip currently marked, by person_id. */
        this.selectedGuestId = null;

        // State
        this.anchorNodeId = null;
        this.anchorScreenPos = null;
        this.releases = [];
        this.activeReleaseId = null;
        this.activeReleaseDetails = null;
        this.visible = false;

        /**
         * Which show() call owns the overlay.
         *
         * Bumped by every show() and every hide(), captured by show() before it
         * awaits, and compared afterwards. Without it a slow response for one
         * group lands after a faster response for the next and assigns its
         * releases to this.releases — which is not a cosmetic flicker, because
         * selectRelease() and every tile's click handler read that array. The
         * overlay would be holding one group's discography while the graph shows
         * another, and a tap would navigate to a release the selected group does
         * not have.
         */
        this._showEpoch = 0;

        /**
         * Whether a show() has finished for the group now displayed.
         *
         * Not the same as `visible`, which is true from the moment a show()
         * starts: the discography is still a spinner then, and `releases` is
         * empty. Callers that need the orbit itself wait on ready().
         */
        this._loaded = false;

        /** Callers parked in ready(), each resolved by the next show(). */
        this._readyWaiters = [];

        // Layout constants
        this.TILE_SIZE = 34;
        this.TILE_SIZE_ACTIVE = 84;
        this.ORBIT_PADDING = 24;
        this.GUEST_CHIP_SIZE = 22;
        this.GUEST_ORBIT_PADDING = 20;
        this.MAX_SINGLE_RING = 12;
        this.MAX_GUEST_SINGLE_RING = 8;

        /**
         * Smallest thing worth asking a finger to hit, and the gap between two
         * of them.
         *
         * The tiles stay 34px and the chips 22px — the orbit reads as an orbit
         * because the marks are small. What grows is the area that answers a
         * press, and the ring it sits on, because twelve 44px targets do not
         * fit on a circle sized for twelve 34px ones: at the old radius their
         * hit areas would overlap by about 7px on each side and a tap near a
         * boundary would open the wrong record.
         */
        this.MIN_HIT_SIZE_TOUCH = 44;
        this.HIT_GAP = 6;

        // Create DOM
        this.root = document.getElementById('release-orbit-overlay');
        if (!this.root) {
            this.root = document.createElement('div');
            this.root.id = 'release-orbit-overlay';
            document.body.appendChild(this.root);
        }
        this.cluster = null;
    }

    /**
     * Show the release orbit for a given group, anchored at screen coordinates.
     * @param {string} groupId - Group node ID
     * @param {{x:number, y:number}} screenPos - Anchor position in viewport coords
     * @param {number} nodeRadius - Visual radius of the group node on screen
     */
    async show(groupId, screenPos, nodeRadius) {
        const epoch = ++this._showEpoch;
        this.anchorNodeId = groupId;
        this.anchorScreenPos = screenPos;
        this.activeReleaseId = null;
        this.activeReleaseDetails = null;
        this.visible = true;
        this._lastNodeRadius = nodeRadius;

        // Show loading spinner while fetching
        this._showLoading(screenPos);

        let resp;
        try {
            resp = await this.api.fetchGroupReleases(groupId);
        } catch (error) {
            // Only the current request may report its own failure; a stale one
            // would blank an overlay that is busy showing something else.
            if (epoch !== this._showEpoch) return;
            throw error;
        }

        // Someone selected another node, or hid the overlay, while this was in
        // flight. Drop the response rather than let it become the state.
        if (epoch !== this._showEpoch) return;

        this.releases = (resp && resp.releases) || [];

        this._render(nodeRadius);
        this._loaded = true;
        const waiters = this._readyWaiters;
        this._readyWaiters = [];
        waiters.forEach((resolve) => resolve(true));
    }

    /**
     * Resolve once the orbit is actually built, not merely on its way.
     *
     * The overlay is not opened by the click that selects a group: it is
     * opened by the callback that runs when the recentring animation has put
     * that group where the tiles are drawn around, roughly 700ms later. Code
     * that acts on a group and then wants its discography — restoring a shared
     * link, say — therefore arrives too early by construction, and found an
     * empty `releases` and returned quietly.
     *
     * Waiting here rather than calling show() again matters: show() clears
     * activeReleaseId, so a second one landing behind the first would wipe a
     * release this had just opened.
     *
     * @param {Object} [options]
     * @param {number} [options.timeout] - Give up after this many ms.
     * @returns {Promise<boolean>} Whether the orbit arrived.
     */
    ready({ timeout = 8000 } = {}) {
        if (this.visible && this._loaded) return Promise.resolve(true);

        return new Promise((resolve) => {
            this._readyWaiters.push(resolve);
            setTimeout(() => {
                const at = this._readyWaiters.indexOf(resolve);
                // Already settled by a show(); nothing owed.
                if (at === -1) return;
                this._readyWaiters.splice(at, 1);
                resolve(false);
            }, timeout);
        });
    }

    /**
     * Programmatically select a release tile in the overlay (e.g. from search navigation).
     * @param {string} releaseId - Release to select
     * @param {Object|null} releaseDetails - Pre-fetched release details (avoids re-fetch)
     */
    selectRelease(releaseId, releaseDetails = null) {
        if (!this.visible || this.releases.length === 0) return;

        // Check if this release is in the overlay
        const found = this.releases.find(r => r.release_id === releaseId);
        if (!found) return;

        this.activeReleaseId = releaseId;
        this.activeReleaseDetails = releaseDetails;
        this.selectedGuestId = null;
        this._render(this._lastNodeRadius);

        if (releaseDetails) {
            this.onReleaseSelect(releaseDetails);
        }
    }

    /**
     * Open a release by id, fetching its details the way a tap does, and mark
     * a guest in it if asked.
     *
     * selectRelease above expects the caller to have the details already,
     * which the tap path does and a share link does not.
     *
     * @param {string} releaseId
     * @param {string|null} [guestId] - A guest chip to mark once it exists.
     * @returns {Promise<boolean>} Whether the release was found in this orbit.
     */
    async openRelease(releaseId, guestId = null) {
        if (!this.visible || !releaseId) return false;

        const release = this.releases.find((r) => r.release_id === releaseId);
        if (!release) return false;

        if (this.activeReleaseId !== releaseId) {
            await this._handleTileClick(release, null);
        }

        if (!guestId) return true;

        const guest = (this.activeReleaseDetails?.guests || [])
            .find((g) => g.person_id === guestId);
        // A link to a guest who is no longer credited opens the release,
        // which is the nearest true thing it can do.
        if (guest) this._selectGuest(guest);
        return true;
    }

    /** Hide and clear the overlay. */
    hide() {
        // Any show() still in flight is now stale: it was asked for a node that
        // is no longer displayed.
        this._showEpoch += 1;
        this.visible = false;
        this._loaded = false;
        this.anchorNodeId = null;
        this.releases = [];
        this.activeReleaseId = null;
        this.activeReleaseDetails = null;
        this.root.innerHTML = '';
        this.cluster = null;
    }

    /**
     * Update anchor position (call after graph re-center, pan, resize).
     * @param {{x:number, y:number}} screenPos
     * @param {number} nodeRadius
     */
    updatePosition(screenPos, nodeRadius) {
        if (!this.visible || !this.cluster) return;
        this.anchorScreenPos = screenPos;
        // Reposition the cluster container
        this.cluster.style.left = screenPos.x + 'px';
        this.cluster.style.top = screenPos.y + 'px';
    }

    // ========== Internal rendering ==========

    _showLoading(screenPos) {
        this.root.innerHTML = '';
        this.cluster = document.createElement('div');
        this.cluster.className = 'release-orbit-cluster';
        this.cluster.style.left = screenPos.x + 'px';
        this.cluster.style.top = screenPos.y + 'px';

        const spinner = document.createElement('div');
        spinner.className = 'release-orbit-spinner';
        this.cluster.appendChild(spinner);
        this.root.appendChild(this.cluster);
    }

    /**
     * The smallest hit box for a mark of this visual size.
     *
     * On a mouse the mark is the target: a cursor is precise and a 34px square
     * is a generous click. A fingertip covers about 8mm of glass and arrives
     * with nothing to aim by.
     *
     * @param {number} visualSize
     * @returns {number}
     */
    _hitSize(visualSize) {
        if (canHover()) return visualSize;
        return Math.max(visualSize, this.MIN_HIT_SIZE_TOUCH);
    }

    /**
     * A ring radius big enough that n marks do not crowd each other.
     *
     * Taken from the spacing each mark needs rather than from a fixed padding,
     * so the ring grows to fit its contents instead of packing them tighter as
     * a discography gets longer. The old formula was padding-only, which is why
     * a twelve-release group already overlapped slightly on a mouse before any
     * of this.
     *
     * Solved on the chord, not the circumference. What must not overlap is the
     * straight-line distance between two centres, and the chord between
     * adjacent points is shorter than the arc between them: sizing the
     * circumference to n·spacing leaves the centres 1.1% short at twelve marks
     * and 17% short at three, so a short discography would be the one that
     * overlapped.
     *
     * @param {number} count
     * @param {number} preferredRadius - what padding alone would give
     * @param {number} visualSize
     * @returns {number}
     */
    _ringRadius(count, preferredRadius, visualSize) {
        if (count < 2) return preferredRadius;
        const spacing = this._hitSize(visualSize) + this.HIT_GAP;
        // chord = 2r·sin(π/n) ≥ spacing
        const needed = spacing / (2 * Math.sin(Math.PI / count));
        return Math.max(preferredRadius, needed);
    }

    _render(nodeRadius) {
        this.root.innerHTML = '';
        this._lastNodeRadius = nodeRadius;

        if (this.releases.length === 0) {
            this.visible = false;
            return;
        }

        // Cluster container centered on anchor
        this.cluster = document.createElement('div');
        this.cluster.className = 'release-orbit-cluster';
        this.cluster.style.left = this.anchorScreenPos.x + 'px';
        this.cluster.style.top = this.anchorScreenPos.y + 'px';

        // Calculate orbit radius based on node radius + donut thickness + padding
        const baseOrbitRadius = (nodeRadius || 30) + this.ORBIT_PADDING + this.TILE_SIZE / 2;

        // Determine ring layout
        const useDoubleRing = this.releases.length > this.MAX_SINGLE_RING;
        const ring1 = useDoubleRing
            ? this.releases.slice(0, this.MAX_SINGLE_RING)
            : this.releases;
        const ring2 = useDoubleRing
            ? this.releases.slice(this.MAX_SINGLE_RING)
            : [];

        const ring1Radius = this._ringRadius(ring1.length, baseOrbitRadius, this.TILE_SIZE);
        this._renderRing(ring1, ring1Radius);
        if (ring2.length > 0) {
            const ring2Preferred = ring1Radius + this._hitSize(this.TILE_SIZE) + 10;
            this._renderRing(ring2, this._ringRadius(ring2.length, ring2Preferred, this.TILE_SIZE));
        }

        // Shared hover tooltip element
        this._tooltip = document.createElement('div');
        this._tooltip.className = 'release-orbit-tooltip';
        this._tooltip.style.display = 'none';
        this.cluster.appendChild(this._tooltip);

        this.root.appendChild(this.cluster);
    }

    _renderRing(releases, radius) {
        const startAngle = -Math.PI / 2; // top
        const angleStep = (2 * Math.PI) / releases.length;

        releases.forEach((rel, i) => {
            const angle = startAngle + i * angleStep;
            const x = Math.cos(angle) * radius;
            const y = Math.sin(angle) * radius;

            const tile = document.createElement('button');
            tile.className = 'release-tile';
            tile.dataset.releaseId = rel.release_id;
            tile.title = `${rel.name || 'Untitled'}${rel.release_date ? ' (' + rel.release_date.substring(0, 4) + ')' : ''}`;

            // Position relative to cluster center
            const isActive = rel.release_id === this.activeReleaseId;
            const size = isActive ? this.TILE_SIZE_ACTIVE : this.TILE_SIZE;
            tile.style.width = size + 'px';
            tile.style.height = size + 'px';
            tile.style.left = (x - size / 2) + 'px';
            tile.style.top = (y - size / 2) + 'px';

            // The visual stays `size`; the press target is a pseudo-element of
            // its own size, centred on it, so nothing in the layout above moves.
            tile.style.setProperty('--hit-size', `${this._hitSize(size)}px`);

            if (isActive) {
                tile.classList.add('release-tile--active');
            }

            // Album art or placeholder
            if (rel.album_art) {
                const img = document.createElement('img');
                img.className = 'release-tile__image';
                img.src = rel.album_art;
                img.alt = rel.name || '';
                img.loading = 'lazy';
                tile.appendChild(img);
            } else {
                const placeholder = document.createElement('span');
                placeholder.className = 'release-tile__placeholder';
                placeholder.textContent = this._initials(rel.name || '?');
                tile.appendChild(placeholder);
            }

            // What kind of record this is, where the data says so. Without it
            // the only text on a sleeveless tile is two letters of its title,
            // which reads as a format code — "LP", "TD" — and names nothing.
            if (rel.type) {
                const typeEl = document.createElement('span');
                typeEl.className = 'release-tile__type';
                typeEl.textContent = String(rel.type).toUpperCase();
                tile.appendChild(typeEl);
            }

            // The active tile says what it is in words. A hover tooltip cannot
            // do this on a phone: there is no hover, so before this the only
            // way to learn a release's name was to open it and read the panel.
            if (isActive) {
                const caption = document.createElement('span');
                caption.className = 'release-tile__caption';
                caption.textContent = this._captionFor(rel);
                tile.appendChild(caption);
            }

            // Hover tooltip
            tile.addEventListener('mouseenter', () => {
                this._showTooltip(tile, rel);
            });
            tile.addEventListener('mouseleave', () => {
                this._hideTooltip();
            });

            tile.addEventListener('click', (e) => {
                e.stopPropagation();
                this._handleTileClick(rel, radius);
            });

            this.cluster.appendChild(tile);

            // If this is the active release, render guest chips around it
            if (isActive && this.activeReleaseDetails) {
                this._renderGuestOrbit(x, y, this.activeReleaseDetails.guests || []);
            }
        });
    }

    /**
     * Name and year, for the caption and the tooltip alike.
     *
     * @param {object} release
     * @returns {string}
     */
    _captionFor(release) {
        const name = release.name || 'Untitled';
        const year = release.release_date ? String(release.release_date).substring(0, 4) : '';
        return year ? `${name} (${year})` : name;
    }

    async _handleTileClick(release, orbitRadius) {
        const wasActive = this.activeReleaseId === release.release_id;
        // The radius this tile sits on is no longer derived from the node's
        // radius by padding alone — a crowded ring grows past it — so inverting
        // the formula no longer recovers the node. _render stored it; use that.
        const nodeRadius = this._lastNodeRadius;

        if (wasActive) {
            this.activeReleaseId = null;
            this.activeReleaseDetails = null;
            this._render(nodeRadius);
            this.onReleaseSelect(null);
            return;
        }

        this.activeReleaseId = release.release_id;
        this.activeReleaseDetails = null;

        // Show tile as loading (expanded but with spinner)
        this._render(nodeRadius);

        // Add spinner to the active tile
        const activeTile = this.cluster && this.cluster.querySelector('.release-tile--active');
        if (activeTile) {
            const spinner = document.createElement('div');
            spinner.className = 'release-tile-spinner';
            activeTile.appendChild(spinner);
        }

        const resp = await this.api.fetchReleaseDetails(release.release_id);
        this.activeReleaseDetails = resp && resp.data ? resp.data : null;
        this.selectedGuestId = null;

        // Re-render with guest orbit
        this._render(nodeRadius);
        this.onReleaseSelect(this.activeReleaseDetails);
    }

    _renderGuestOrbit(centerX, centerY, guests) {
        if (!guests || guests.length === 0) return;

        const baseGuestRadius = this.TILE_SIZE_ACTIVE / 2 + this.GUEST_ORBIT_PADDING;

        // Split into rings if too many guests
        const useDoubleRing = guests.length > this.MAX_GUEST_SINGLE_RING;
        const ring1 = useDoubleRing ? guests.slice(0, this.MAX_GUEST_SINGLE_RING) : guests;
        const ring2 = useDoubleRing ? guests.slice(this.MAX_GUEST_SINGLE_RING) : [];

        const ring1Radius = this._ringRadius(ring1.length, baseGuestRadius, this.GUEST_CHIP_SIZE);
        this._renderGuestRing(centerX, centerY, ring1, ring1Radius);
        if (ring2.length > 0) {
            const ring2Preferred = ring1Radius + this._hitSize(this.GUEST_CHIP_SIZE) + 6;
            this._renderGuestRing(centerX, centerY, ring2,
                this._ringRadius(ring2.length, ring2Preferred, this.GUEST_CHIP_SIZE));
        }
    }

    _renderGuestRing(centerX, centerY, guests, radius) {
        const startAngle = -Math.PI / 2;
        const angleStep = (2 * Math.PI) / guests.length;

        guests.forEach((guest, i) => {
            const angle = startAngle + i * angleStep;
            const gx = centerX + Math.cos(angle) * radius;
            const gy = centerY + Math.sin(angle) * radius;

            const chip = document.createElement('button');
            chip.className = 'release-guest-chip';
            chip.style.width = this.GUEST_CHIP_SIZE + 'px';
            chip.style.height = this.GUEST_CHIP_SIZE + 'px';
            chip.style.left = (gx - this.GUEST_CHIP_SIZE / 2) + 'px';
            chip.style.top = (gy - this.GUEST_CHIP_SIZE / 2) + 'px';

            // 22px is half a fingertip. Same treatment as the tiles: the mark
            // stays small, the press target does not.
            chip.style.setProperty('--hit-size', `${this._hitSize(this.GUEST_CHIP_SIZE)}px`);

            if (guest.color) {
                chip.style.borderColor = guest.color;
                chip.style.boxShadow = `0 0 4px ${guest.color}`;
            }

            chip.title = guest.name + (guest.roles && guest.roles.length > 0 ? ' (' + guest.roles.join(', ') + ')' : '');

            const initials = document.createElement('span');
            initials.className = 'release-guest-chip__initials';
            initials.textContent = this._initials(guest.name || '?');
            chip.appendChild(initials);

            chip.dataset.personId = guest.person_id || '';
            if (guest.person_id && guest.person_id === this.selectedGuestId) {
                chip.classList.add('release-guest-chip--selected');
            }

            chip.addEventListener('click', (e) => {
                e.stopPropagation();
                this._selectGuest(guest);
            });

            this.cluster.appendChild(chip);
        });
    }

    /**
     * Mark a guest chip and hand the guest to the panel.
     *
     * No navigation. The chip already is the guest, drawn in the one context
     * that explains it — this release — and a guest whose only edges are
     * credits has no neighbourhood to arrive in, so navigating produced a
     * bare node joined to nothing.
     *
     * @private
     * @param {Object} guest
     */
    _selectGuest(guest) {
        this.selectedGuestId = guest?.person_id || null;

        for (const chip of this.cluster.querySelectorAll('.release-guest-chip')) {
            chip.classList.toggle('release-guest-chip--selected',
                !!this.selectedGuestId && chip.dataset.personId === this.selectedGuestId);
        }

        this.onGuestSelect(guest, this.activeReleaseDetails);
    }

    _showTooltip(tileEl, release) {
        if (!this._tooltip) return;
        const name = release.name || 'Untitled';
        const year = release.release_date ? release.release_date.substring(0, 4) : '';
        const format = release.format || '';
        let text = name;
        if (year) text += ` (${year})`;
        if (format) text += ` \u2022 ${format}`;
        this._tooltip.textContent = text;

        // Position above the tile
        const tileLeft = parseFloat(tileEl.style.left);
        const tileTop = parseFloat(tileEl.style.top);
        const tileW = parseFloat(tileEl.style.width);
        this._tooltip.style.left = (tileLeft + tileW / 2) + 'px';
        this._tooltip.style.top = (tileTop - 8) + 'px';
        this._tooltip.style.display = '';
    }

    _hideTooltip() {
        if (this._tooltip) {
            this._tooltip.style.display = 'none';
        }
    }

    _initials(name) {
        return name.split(/\s+/).filter(Boolean).map(w => w[0] || '').join('').substring(0, 2).toUpperCase();
    }
}
