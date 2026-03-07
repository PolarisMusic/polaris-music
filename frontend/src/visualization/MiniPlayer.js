/**
 * @fileoverview Persistent bottom mini-player for Polaris Music Registry
 *
 * Loads track queues for selected releases, groups, or persons.
 * Supports inline audio playback for direct audio URLs and
 * external listen link actions for streaming service links.
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
        this.audio.pause();
        this.audio.src = '';

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

        this.container.appendChild(barEl);
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

    // ========== PLAYBACK LOGIC ==========

    _togglePlay() {
        const track = this.queue[this.currentIndex];
        if (!track) return;

        if (track.listen.can_inline_play) {
            if (this._isPlaying) {
                this.audio.pause();
            } else {
                // Set source if needed
                if (this.audio.src !== track.listen.playable_url) {
                    this.audio.src = track.listen.playable_url;
                }
                this.audio.play().catch(() => {});
            }
        } else if (track.listen.preferred_link) {
            // For non-playable tracks, open external link
            window.open(track.listen.preferred_link, '_blank');
        }
    }

    _prev() {
        if (this.currentIndex > 0) {
            this.currentIndex--;
            this._loadCurrentTrack();
        }
    }

    _next() {
        if (this.currentIndex < this.queue.length - 1) {
            this.currentIndex++;
            this._loadCurrentTrack();
        }
    }

    _autoAdvance() {
        // Find next inline-playable track
        for (let i = this.currentIndex + 1; i < this.queue.length; i++) {
            if (this.queue[i].listen.can_inline_play) {
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
        this.audio.pause();
        this.audio.src = '';
        this._duration = 0;
        this._currentTime = 0;
        this._isPlaying = false;

        if (track && track.listen.can_inline_play && autoplay) {
            this.audio.src = track.listen.playable_url;
            this.audio.play().catch(() => {});
        }

        this._updateTrackDisplay();
        this._highlightQueueRow();
    }

    // ========== UI UPDATES ==========

    _show() {
        this.container.style.display = 'flex';
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

        // Scrubber visibility
        const canPlay = track && track.listen.can_inline_play;
        this._scrubberEl.style.visibility = canPlay ? 'visible' : 'hidden';

        // External link
        const linkEl = this._externalEl.querySelector('.mp-open-link');
        if (track && track.listen.preferred_link && !canPlay) {
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

        if (track.listen.can_inline_play) {
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
            const playableIcon = t.listen.can_inline_play ? '' : '<span class="mp-ext-icon" title="External only">&#128279;</span>';
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
                    const track = this.queue[idx];
                    this._loadCurrentTrack(track.listen.can_inline_play);
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
