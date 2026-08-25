/**
 * @fileoverview Persistent bottom mini-player for Polaris Music Registry
 *
 * Loads track queues for selected releases, groups, or persons.
 *
 * Three playback modes, decided per track by the backend's normalized
 * `listen` object (see api/playerService.js):
 *   - 'audio'    direct audio file, played through an <audio> element
 *   - 'embed'    Spotify link, played through Spotify's embed iframe
 *   - 'external' any other streaming link, opened in a new tab
 *
 * @module visualization/MiniPlayer
 */

export class MiniPlayer {
    /**
     * @param {Object} opts
     * @param {HTMLElement} opts.container - Element to mount the player bar into
     * @param {Object} opts.api - GraphAPI instance with fetchPlaybackQueue()
     */
    constructor({ container, api }) {
        this.container = container;
        this.api = api;

        this.queue = [];
        this.currentIndex = -1;
        this.context = null;
        this.drawerOpen = false;

        /** @type {HTMLAudioElement} */
        this.audio = new Audio();
        this.audio.preload = 'metadata';

        // Spotify embed state. The controller is created lazily the first
        // time an embeddable track is selected, then reused via loadUri().
        this._embedApiPromise = null;
        this._embedController = null;
        this._embedUri = null;
        this._embedMode = false;
        this._embedEnded = false;
        this._embedFailed = false;

        this._isPlaying = false;
        this._duration = 0;
        this._currentTime = 0;
        this._seeking = false;

        this._render();
        this._bindAudioEvents();
    }

    // ========== PUBLIC API ==========

    /**
     * Load a queue from the backend for the given context.
     * Does NOT autoplay.
     */
    async loadQueue(contextType, contextId) {
        const data = await this.api.fetchPlaybackQueue(contextType, contextId);
        if (!data.success || !data.queue) return;

        this.context = data.context;
        this.queue = data.queue;
        this.currentIndex = this.queue.length > 0 ? 0 : -1;
        this._isPlaying = false;
        this._stopAudio();
        this._exitEmbedMode();

        this._show();
        this._updateTrackDisplay();
        this._updateQueueDrawer();
    }

    /**
     * Check if the player has a loaded queue.
     */
    hasQueue() {
        return this.queue.length > 0;
    }

    // ========== RENDERING ==========

    _render() {
        this.container.innerHTML = '';
        this.container.className = 'mini-player';
        this.container.style.display = 'none';

        // Album art
        this._artEl = document.createElement('div');
        this._artEl.className = 'mp-art';
        this._artEl.innerHTML = '<div class="mp-art-placeholder"></div>';

        // Track info
        this._infoEl = document.createElement('div');
        this._infoEl.className = 'mp-info';
        this._infoEl.innerHTML = `
            <div class="mp-track-name">No track loaded</div>
            <div class="mp-release-name"></div>
        `;

        // Controls
        this._controlsEl = document.createElement('div');
        this._controlsEl.className = 'mp-controls';
        this._controlsEl.innerHTML = `
            <button class="mp-btn mp-prev" title="Previous">&#9664;&#9664;</button>
            <button class="mp-btn mp-play" title="Play">&#9654;</button>
            <button class="mp-btn mp-next" title="Next">&#9654;&#9654;</button>
        `;

        // Scrubber area
        this._scrubberEl = document.createElement('div');
        this._scrubberEl.className = 'mp-scrubber-area';
        this._scrubberEl.innerHTML = `
            <span class="mp-time mp-time-current">0:00</span>
            <input type="range" class="mp-scrubber" min="0" max="100" value="0" step="0.1">
            <span class="mp-time mp-time-duration">0:00</span>
        `;

        // External link button (shown when track is not inline-playable)
        this._externalEl = document.createElement('div');
        this._externalEl.className = 'mp-external';
        this._externalEl.innerHTML = `<a class="mp-btn mp-open-link" href="#" target="_blank" title="Open link" style="display:none;">&#128279;</a>`;

        // Queue toggle
        this._queueToggleEl = document.createElement('button');
        this._queueToggleEl.className = 'mp-btn mp-queue-toggle';
        this._queueToggleEl.title = 'Queue';
        this._queueToggleEl.textContent = '\u2630'; // hamburger icon

        // Queue drawer
        this._drawerEl = document.createElement('div');
        this._drawerEl.className = 'mp-drawer';
        this._drawerEl.style.display = 'none';

        // Right side wrapper
        const rightEl = document.createElement('div');
        rightEl.className = 'mp-right';
        rightEl.appendChild(this._externalEl);
        rightEl.appendChild(this._queueToggleEl);

        // Assemble bar
        const barEl = document.createElement('div');
        barEl.className = 'mp-bar';
        barEl.appendChild(this._artEl);
        barEl.appendChild(this._infoEl);
        barEl.appendChild(this._controlsEl);
        barEl.appendChild(this._scrubberEl);
        barEl.appendChild(rightEl);

        // Spotify embed row. .mini-player is a flex column anchored to the
        // bottom of the viewport, so this row grows the player upward.
        this._embedEl = document.createElement('div');
        this._embedEl.className = 'mp-embed';
        this._embedEl.style.display = 'none';
        this._embedHostEl = document.createElement('div');
        this._embedEl.appendChild(this._embedHostEl);

        this.container.appendChild(barEl);
        this.container.appendChild(this._embedEl);
        this.container.appendChild(this._drawerEl);

        this._bindControlEvents();
    }

    _bindControlEvents() {
        // Play/pause
        const playBtn = this._controlsEl.querySelector('.mp-play');
        playBtn.addEventListener('click', () => this._togglePlay());

        // Prev / Next
        this._controlsEl.querySelector('.mp-prev').addEventListener('click', () => this._prev());
        this._controlsEl.querySelector('.mp-next').addEventListener('click', () => this._next());

        // Scrubber seek
        const scrubber = this._scrubberEl.querySelector('.mp-scrubber');
        scrubber.addEventListener('input', () => {
            this._seeking = true;
        });
        scrubber.addEventListener('change', () => {
            if (this._duration > 0) {
                this.audio.currentTime = (scrubber.value / 100) * this._duration;
            }
            this._seeking = false;
        });

        // Queue toggle
        this._queueToggleEl.addEventListener('click', () => this._toggleDrawer());
    }

    _bindAudioEvents() {
        this.audio.addEventListener('timeupdate', () => {
            this._currentTime = this.audio.currentTime;
            if (!this._seeking) {
                this._updateScrubber();
            }
        });

        this.audio.addEventListener('loadedmetadata', () => {
            this._duration = this.audio.duration;
            this._updateScrubber();
        });

        this.audio.addEventListener('ended', () => {
            this._autoAdvance();
        });

        this.audio.addEventListener('play', () => {
            this._isPlaying = true;
            this._updatePlayButton();
        });

        this.audio.addEventListener('pause', () => {
            this._isPlaying = false;
            this._updatePlayButton();
        });

        this.audio.addEventListener('error', () => {
            console.warn('MiniPlayer: audio error for current track');
            this._isPlaying = false;
            this._updatePlayButton();
        });
    }

    // ========== SPOTIFY EMBED ==========

    /**
     * Load Spotify's iFrame API exactly once. Injected lazily so that
     * visitors who never touch a Spotify-linked track never fetch it.
     *
     * @returns {Promise<Object>} resolves with the IFrameAPI object
     */
    _loadEmbedApi() {
        if (this._embedApiPromise) return this._embedApiPromise;

        this._embedApiPromise = new Promise((resolve, reject) => {
            // Another MiniPlayer instance may already have loaded it.
            if (window.__spotifyIframeApi) {
                resolve(window.__spotifyIframeApi);
                return;
            }

            const script = document.createElement('script');
            script.src = 'https://open.spotify.com/embed/iframe-api/v1';
            script.async = true;

            // The API calls this global once it has finished initializing.
            window.onSpotifyIframeApiReady = (IFrameAPI) => {
                window.__spotifyIframeApi = IFrameAPI;
                resolve(IFrameAPI);
            };

            script.addEventListener('error', () => {
                reject(new Error('Spotify iFrame API failed to load'));
            });

            document.head.appendChild(script);
        }).catch((err) => {
            // Reset so a later attempt can retry rather than being stuck on a
            // permanently rejected promise.
            this._embedApiPromise = null;
            throw err;
        });

        return this._embedApiPromise;
    }

    /**
     * Ensure a controller exists and is pointed at the given Spotify URI.
     *
     * @param {string} uri - spotify:track:ID
     * @param {boolean} autoplay
     */
    async _ensureEmbedController(uri, autoplay) {
        let IFrameAPI;
        try {
            IFrameAPI = await this._loadEmbedApi();
        } catch {
            // Blocked by CSP, an extension, or offline. Fall back to the
            // external link so the track is still reachable.
            this._embedFailed = true;
            this._exitEmbedMode();
            this._updateTrackDisplay();
            return;
        }

        if (!this._embedController) {
            this._embedController = await new Promise((resolve) => {
                IFrameAPI.createController(
                    this._embedHostEl,
                    { uri, width: '100%', height: 80 },
                    (controller) => resolve(controller)
                );
            });

            this._embedUri = uri;
            this._embedController.addListener('playback_update', (e) => {
                this._onEmbedPlaybackUpdate(e?.data);
            });
        } else if (this._embedUri !== uri) {
            this._embedUri = uri;
            this._embedEnded = false;
            this._embedController.loadUri(uri);
        }

        if (autoplay) {
            // May be refused by autoplay policy — the click happened on our
            // page, not inside Spotify's cross-origin frame — in which case
            // the visitor presses play on the embed itself.
            try { this._embedController.play(); } catch { /* ignore */ }
        }
    }

    /**
     * Mirror embed playback state onto our own bar, and auto-advance the
     * queue when a track finishes.
     */
    _onEmbedPlaybackUpdate(data) {
        if (!data || !this._embedMode) return;

        this._isPlaying = !data.isPaused;
        this._updatePlayButton();

        // Positions are milliseconds. Spotify reports position === duration
        // on completion; guard so we advance only once per track.
        const { position, duration } = data;
        if (duration > 0 && position >= duration) {
            if (!this._embedEnded) {
                this._embedEnded = true;
                this._autoAdvance();
            }
        } else if (position > 0) {
            this._embedEnded = false;
        }
    }

    _enterEmbedMode() {
        this._stopAudio();
        if (this._embedMode) return;
        this._embedMode = true;
        this._embedEl.style.display = 'block';
        document.body.classList.add('mini-player-embed');
        this._notifyHeightChange();
    }

    _exitEmbedMode() {
        this._embedUri = null;
        this._embedEnded = false;
        if (this._embedController) {
            try { this._embedController.pause(); } catch { /* ignore */ }
        }
        if (!this._embedMode) return;
        this._embedMode = false;
        this._embedEl.style.display = 'none';
        document.body.classList.remove('mini-player-embed');
        this._notifyHeightChange();
    }

    // ========== PLAYBACK LOGIC ==========

    /**
     * Which playback mode a queue entry uses.
     *
     * @returns {'audio'|'embed'|'external'|'none'}
     */
    _modeFor(track) {
        if (!track || !track.listen) return 'none';
        if (track.listen.can_inline_play) return 'audio';
        if (track.listen.embed_uri && !this._embedFailed) return 'embed';
        if (track.listen.preferred_link) return 'external';
        return 'none';
    }

    /**
     * Clear the <audio> element without pointing it at the current document.
     *
     * Assigning '' resolves against the page URL, so the browser tries to
     * load the page itself as audio and fires a spurious 'error'.
     */
    _stopAudio() {
        this.audio.pause();
        this.audio.removeAttribute('src');
        this.audio.load();
    }

    _togglePlay() {
        const track = this.queue[this.currentIndex];
        const mode = this._modeFor(track);

        if (mode === 'audio') {
            this._exitEmbedMode();
            if (this._isPlaying) {
                this.audio.pause();
            } else {
                if (this.audio.src !== track.listen.playable_url) {
                    this.audio.src = track.listen.playable_url;
                }
                this.audio.play().catch(() => {});
            }
        } else if (mode === 'embed') {
            this._enterEmbedMode();
            if (this._embedController && this._embedUri === track.listen.embed_uri) {
                try { this._embedController.togglePlay(); } catch { /* ignore */ }
            } else {
                this._ensureEmbedController(track.listen.embed_uri, true);
            }
        } else if (mode === 'external') {
            window.open(track.listen.preferred_link, '_blank', 'noopener');
        }
    }

    _prev() {
        if (this.currentIndex > 0) {
            this.currentIndex--;
            this._loadCurrentTrack(this._isPlaying);
        }
    }

    _next() {
        if (this.currentIndex < this.queue.length - 1) {
            this.currentIndex++;
            this._loadCurrentTrack(this._isPlaying);
        }
    }

    _autoAdvance() {
        // Find the next track we can actually sound — inline audio or embed.
        for (let i = this.currentIndex + 1; i < this.queue.length; i++) {
            const mode = this._modeFor(this.queue[i]);
            if (mode === 'audio' || mode === 'embed') {
                this.currentIndex = i;
                this._loadCurrentTrack(true);
                return;
            }
        }
        // No more playable tracks — just advance to next and stop
        if (this.currentIndex < this.queue.length - 1) {
            this.currentIndex++;
            this._loadCurrentTrack(false);
        } else {
            this._isPlaying = false;
            this._updatePlayButton();
        }
    }

    _loadCurrentTrack(autoplay = false) {
        const track = this.queue[this.currentIndex];
        const mode = this._modeFor(track);

        this._stopAudio();
        this._duration = 0;
        this._currentTime = 0;
        this._isPlaying = false;

        if (mode === 'audio') {
            this._exitEmbedMode();
            if (autoplay) {
                this.audio.src = track.listen.playable_url;
                this.audio.play().catch(() => {});
            }
        } else if (mode === 'embed') {
            this._enterEmbedMode();
            this._ensureEmbedController(track.listen.embed_uri, autoplay);
        } else {
            this._exitEmbedMode();
        }

        this._updateTrackDisplay();
        this._highlightQueueRow();
    }

    // ========== UI UPDATES ==========

    _show() {
        this.container.style.display = 'flex';
        document.body.classList.add('mini-player-visible');
    }

    _hide() {
        this._stopAudio();
        this._exitEmbedMode();
        this.container.style.display = 'none';
        document.body.classList.remove('mini-player-visible');
        this._notifyHeightChange();
    }

    /**
     * The graph canvas sizes itself against the player's height, so tell it
     * to re-measure whenever the player grows or shrinks. Without this the
     * canvas keeps its old size and node hit-testing drifts.
     */
    _notifyHeightChange() {
        window.dispatchEvent(new CustomEvent('miniplayer:resize'));
    }

    _updateTrackDisplay() {
        const track = this.queue[this.currentIndex];

        // Track name & release
        const nameEl = this._infoEl.querySelector('.mp-track-name');
        const releaseEl = this._infoEl.querySelector('.mp-release-name');

        if (track) {
            nameEl.textContent = track.track_name || 'Unknown Track';
            releaseEl.textContent = track.release_name || '';
        } else {
            nameEl.textContent = this.context ? `${this.context.name} — no tracks` : 'No track loaded';
            releaseEl.textContent = '';
        }

        // Album art
        if (track && track.album_art) {
            this._artEl.innerHTML = `<img src="${this._escapeAttr(track.album_art)}" alt="Album art" class="mp-art-img">`;
        } else {
            this._artEl.innerHTML = '<div class="mp-art-placeholder"></div>';
        }

        // Play button state
        this._updatePlayButton();

        // Scrubber is ours only in audio mode; the Spotify embed owns its own
        // progress bar, so we hide ours rather than keep two out of sync.
        const mode = this._modeFor(track);
        this._scrubberEl.style.visibility = mode === 'audio' ? 'visible' : 'hidden';

        // External link — always offered when one exists and we are not
        // playing the track ourselves, including in embed mode so the visitor
        // can open the full track in the Spotify app.
        const linkEl = this._externalEl.querySelector('.mp-open-link');
        if (track && track.listen.preferred_link && mode !== 'audio') {
            linkEl.href = track.listen.preferred_link;
            linkEl.style.display = '';
        } else {
            linkEl.style.display = 'none';
        }

        this._updateScrubber();
    }

    _updatePlayButton() {
        const playBtn = this._controlsEl.querySelector('.mp-play');
        const track = this.queue[this.currentIndex];

        if (!track) {
            playBtn.disabled = true;
            playBtn.innerHTML = '&#9654;';
            return;
        }

        playBtn.disabled = false;

        const mode = this._modeFor(track);
        if (mode === 'audio' || mode === 'embed') {
            playBtn.innerHTML = this._isPlaying ? '&#9646;&#9646;' : '&#9654;';
            playBtn.title = this._isPlaying ? 'Pause' : 'Play';
        } else {
            playBtn.innerHTML = '&#128279;';
            playBtn.title = 'Open link';
        }
    }

    _updateScrubber() {
        const currentEl = this._scrubberEl.querySelector('.mp-time-current');
        const durationEl = this._scrubberEl.querySelector('.mp-time-duration');
        const scrubber = this._scrubberEl.querySelector('.mp-scrubber');

        currentEl.textContent = this._formatTime(this._currentTime);
        durationEl.textContent = this._formatTime(this._duration);

        if (!this._seeking && this._duration > 0) {
            scrubber.value = (this._currentTime / this._duration) * 100;
        }
    }

    // ========== QUEUE DRAWER ==========

    _toggleDrawer() {
        this.drawerOpen = !this.drawerOpen;
        this._drawerEl.style.display = this.drawerOpen ? 'block' : 'none';
        this._queueToggleEl.classList.toggle('active', this.drawerOpen);
        if (this.drawerOpen) this._updateQueueDrawer();
    }

    _updateQueueDrawer() {
        if (!this.drawerOpen) return;

        const contextLabel = this.context
            ? `<div class="mp-drawer-header">${this._escapeHtml(this.context.name)} <span class="mp-drawer-type">${this.context.type}</span></div>`
            : '';

        const rows = this.queue.map((t, i) => {
            const active = i === this.currentIndex ? ' mp-queue-active' : '';
            const mode = this._modeFor(t);
            const playableIcon = (mode === 'audio' || mode === 'embed')
                ? ''
                : '<span class="mp-ext-icon" title="External only">&#128279;</span>';
            return `<div class="mp-queue-row${active}" data-index="${i}">
                <span class="mp-queue-num">${t.track_number || (i + 1)}</span>
                <span class="mp-queue-title">${this._escapeHtml(t.track_name)}</span>
                <span class="mp-queue-release">${this._escapeHtml(t.release_name)}</span>
                ${playableIcon}
            </div>`;
        }).join('');

        this._drawerEl.innerHTML = contextLabel + (rows || '<div class="mp-drawer-empty">No tracks in queue</div>');

        // Click handler on rows
        this._drawerEl.querySelectorAll('.mp-queue-row').forEach(row => {
            row.addEventListener('click', () => {
                const idx = parseInt(row.dataset.index);
                if (idx >= 0 && idx < this.queue.length) {
                    this.currentIndex = idx;
                    const mode = this._modeFor(this.queue[idx]);
                    this._loadCurrentTrack(mode === 'audio' || mode === 'embed');
                    this._updateQueueDrawer();
                }
            });
        });
    }

    _highlightQueueRow() {
        if (!this.drawerOpen) return;
        this._drawerEl.querySelectorAll('.mp-queue-row').forEach((row, i) => {
            row.classList.toggle('mp-queue-active', i === this.currentIndex);
        });
    }

    // ========== HELPERS ==========

    _formatTime(seconds) {
        if (!seconds || !isFinite(seconds)) return '0:00';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    }

    _escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    _escapeAttr(str) {
        return this._escapeHtml(str);
    }
}
