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

export class ReleaseOrbitOverlay {
    /**
     * @param {Object} options
     * @param {Object} options.api - GraphAPI instance
     * @param {Function} options.onReleaseSelect - Called with release details when a tile is clicked
     * @param {Function} options.onGuestClick - Called with personId when a guest chip is clicked
     */
    constructor({ api, onReleaseSelect, onGuestClick }) {
        this.api = api;
        this.onReleaseSelect = onReleaseSelect || (() => {});
        this.onGuestClick = onGuestClick || (() => {});

        // State
        this.anchorNodeId = null;
        this.anchorScreenPos = null;
        this.releases = [];
        this.activeReleaseId = null;
        this.activeReleaseDetails = null;
        this.visible = false;

        // Layout constants
        this.TILE_SIZE = 34;
        this.TILE_SIZE_ACTIVE = 84;
        this.ORBIT_PADDING = 24;
        this.GUEST_CHIP_SIZE = 22;
        this.GUEST_ORBIT_PADDING = 20;
        this.MAX_SINGLE_RING = 12;

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
        this.anchorNodeId = groupId;
        this.anchorScreenPos = screenPos;
        this.activeReleaseId = null;
        this.activeReleaseDetails = null;
        this.visible = true;

        // Fetch releases
        const resp = await this.api.fetchGroupReleases(groupId);
        this.releases = (resp && resp.releases) || [];

        this._render(nodeRadius);
    }

    /** Hide and clear the overlay. */
    hide() {
        this.visible = false;
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

    _render(nodeRadius) {
        this.root.innerHTML = '';

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

        this._renderRing(ring1, baseOrbitRadius);
        if (ring2.length > 0) {
            this._renderRing(ring2, baseOrbitRadius + this.TILE_SIZE + 10);
        }

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

    async _handleTileClick(release, orbitRadius) {
        const wasActive = this.activeReleaseId === release.release_id;

        if (wasActive) {
            // Deselect
            this.activeReleaseId = null;
            this.activeReleaseDetails = null;
            this._render(orbitRadius - this.ORBIT_PADDING - this.TILE_SIZE / 2);
            // Notify parent to restore group details
            this.onReleaseSelect(null);
            return;
        }

        this.activeReleaseId = release.release_id;

        // Fetch details
        const resp = await this.api.fetchReleaseDetails(release.release_id);
        this.activeReleaseDetails = resp && resp.data ? resp.data : null;

        // Re-render with expanded tile
        this._render(orbitRadius - this.ORBIT_PADDING - this.TILE_SIZE / 2);

        // Notify parent
        this.onReleaseSelect(this.activeReleaseDetails);
    }

    _renderGuestOrbit(centerX, centerY, guests) {
        if (!guests || guests.length === 0) return;

        const guestRadius = this.TILE_SIZE_ACTIVE / 2 + this.GUEST_ORBIT_PADDING;
        const startAngle = -Math.PI / 2;
        const angleStep = (2 * Math.PI) / guests.length;

        guests.forEach((guest, i) => {
            const angle = startAngle + i * angleStep;
            const gx = centerX + Math.cos(angle) * guestRadius;
            const gy = centerY + Math.sin(angle) * guestRadius;

            const chip = document.createElement('button');
            chip.className = 'release-guest-chip';
            chip.style.width = this.GUEST_CHIP_SIZE + 'px';
            chip.style.height = this.GUEST_CHIP_SIZE + 'px';
            chip.style.left = (gx - this.GUEST_CHIP_SIZE / 2) + 'px';
            chip.style.top = (gy - this.GUEST_CHIP_SIZE / 2) + 'px';

            if (guest.color) {
                chip.style.borderColor = guest.color;
                chip.style.boxShadow = `0 0 4px ${guest.color}`;
            }

            chip.title = guest.name + (guest.roles && guest.roles.length > 0 ? ' (' + guest.roles.join(', ') + ')' : '');

            const initials = document.createElement('span');
            initials.className = 'release-guest-chip__initials';
            initials.textContent = this._initials(guest.name || '?');
            chip.appendChild(initials);

            chip.addEventListener('click', (e) => {
                e.stopPropagation();
                this.onGuestClick(guest.person_id);
            });

            this.cluster.appendChild(chip);
        });
    }

    _initials(name) {
        return name.split(/\s+/).filter(Boolean).map(w => w[0] || '').join('').substring(0, 2).toUpperCase();
    }
}
