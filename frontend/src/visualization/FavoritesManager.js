/**
 * FavoritesManager — owns the on-chain favorites cluster previously
 * smeared across MusicGraph: the `chainFavorites` Set, the loaded
 * flag, the panel-open flag, and the four methods that read or
 * mutate them.
 *
 * Extracted from MusicGraph (Stage J.2). Storage shape is unchanged
 * so the snapshot tests in
 * `backend/test/visualization/favoritesManager.snapshot.test.js`
 * still match byte-for-byte.
 *
 * Public state (read by MusicGraph for like-button/like-flow code):
 *   chainFavorites          Set<checksum256>
 *   chainFavoritesLoaded    boolean
 *   favoritesPanelOpen      boolean
 *
 * Public API:
 *   updateFavoritesCount()         — writes count to #favorites-count
 *   refreshFavoritesFromChain()    — fetches account likes, replaces Set
 *   toggleFavoritesPanel()         — flips panel visibility
 *   renderFavoritesPanel()         — renders <li> rows into #favorites-list
 *
 * @module visualization/FavoritesManager
 */

export class FavoritesManager {
    /**
     * @param {Object} deps
     * @param {Object} deps.walletManager  - WharfKit wallet manager (.isConnected())
     * @param {Object} deps.likeManager    - exposes fetchAccountLikes(limit)
     * @param {Map}    deps.hashIndex      - shared Map<hash, {nodeId,name,type}>
     *                                       owned by GraphDataLoader; we hold
     *                                       a stable reference because the
     *                                       loader clears+repopulates in place
     * @param {Object} deps.callbacks
     * @param {(s:string)=>string} deps.callbacks.escapeHtml
     * @param {(nodeId:string)=>void} deps.callbacks.navigate
     */
    constructor({ walletManager, likeManager, hashIndex, callbacks }) {
        this.walletManager = walletManager;
        this.likeManager = likeManager;
        this.hashIndex = hashIndex;
        this.callbacks = callbacks;

        // State previously on MusicGraph
        this.chainFavorites = new Set();
        this.chainFavoritesLoaded = false;
        this.favoritesPanelOpen = false;
    }

    updateFavoritesCount() {
        const el = document.getElementById('favorites-count');
        if (el) el.textContent = String(this.chainFavorites.size);
    }

    async refreshFavoritesFromChain() {
        const rows = await this.likeManager.fetchAccountLikes(200);
        this.chainFavorites = new Set(rows.map(r => r.node_id));
        this.chainFavoritesLoaded = true;
        this.updateFavoritesCount();
        return rows;
    }

    toggleFavoritesPanel() {
        this.favoritesPanelOpen = !this.favoritesPanelOpen;
        const panel = document.getElementById('favorites-panel');
        if (!panel) return;

        if (this.favoritesPanelOpen) {
            panel.style.display = 'flex';
            this.renderFavoritesPanel();
        } else {
            panel.style.display = 'none';
        }
    }

    async renderFavoritesPanel() {
        const list = document.getElementById('favorites-list');
        if (!list) return;

        if (!this.walletManager?.isConnected()) {
            list.innerHTML = '<li class="history-empty">Login to see your favorites.</li>';
            return;
        }

        list.innerHTML = '<li class="history-empty">Loading favorites...</li>';

        try {
            const rows = await this.refreshFavoritesFromChain();

            if (!rows.length) {
                list.innerHTML = '<li class="history-empty">No favorites yet.</li>';
                return;
            }

            list.innerHTML = rows.map(r => {
                const meta = this.hashIndex.get(r.node_id);
                const name = meta?.name || (r.node_id.slice(0, 8) + '…');
                const nodeId = meta?.nodeId || '';
                const type = (meta?.type || 'unknown').toLowerCase();

                const disabled = nodeId ? '' : ' style="opacity:0.6; cursor:not-allowed;" ';
                return `<li class="history-item" ${disabled} data-node-id="${this.callbacks.escapeHtml(nodeId)}">
                    <span class="history-type-badge history-type-${type}">${type}</span>
                    <span class="history-name">${this.callbacks.escapeHtml(name)}</span>
                    <span class="history-time"></span>
                </li>`;
            }).join('');

            list.querySelectorAll('.history-item').forEach(li => {
                const nodeId = li.dataset.nodeId;
                if (!nodeId) return;
                li.addEventListener('click', () => this.callbacks.navigate(nodeId));
            });
        } catch (error) {
            console.error('Failed to load favorites:', error);
            list.innerHTML = '<li class="history-empty">Failed to load favorites.</li>';
        }
    }
}
