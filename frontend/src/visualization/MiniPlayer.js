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
        this._embedUri = null;
        this._embedMode = false;
        this._embedEnded = false;

        this._isPlaying = false;
        this._duration = 0;
        this._currentTime = 0;
        this._seeking = false;

        // Hidden until asked for. The panel takes its height from the info
        // sheet, and for what it currently does that is not a trade worth
        // making by default — present enough to know it exists, not occupying
        // the space you are reading in.
        this._collapsed = true;

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

        // Selecting a node used to stop whatever was playing, because loading a
        // queue tore down the audio element and the embed. Browsing the graph
        // and listening to it are separate activities, and navigating is the
        // main thing you do here — so if something is sounding, the new queue
        // waits rather than interrupting it.
        if (this._isSounding()) {
            this._pendingQueue = { context: data.context, queue: data.queue };
            this._updatePlayButton();
            return;
        }

        this._applyQueue(data.context, data.queue);
    }

    /**
     * Load a context and go straight to one track in it.
     *
     * Deliberately does NOT defer the way loadQueue() does. Deferring exists so
     * that browsing the graph cannot interrupt what someone is listening to —
     * selecting a node is navigation, not a request to change the music. This
     * is the opposite: pressing play on a specific track IS the request, so it
     * takes effect immediately even if something is already sounding.
     *
     * What it cannot do is start the audio. Spotify's embed is a plain iframe
     * with no controller (see _showEmbed), so this points the embed at the
     * track and reveals the player; the visitor presses play once inside it.
     * The control that calls this is labelled accordingly.
     *
     * @param {string} contextType - e.g. 'release'
     * @param {string} contextId
     * @param {string} trackId - Which track in that context to select.
     * @returns {Promise<boolean>} Whether the track was found and selected.
     */
    async playTrackById(contextType, contextId, trackId) {
        const sameContext = this.context?.id === contextId && this.queue.length > 0;

        if (!sameContext) {
            const data = await this.api.fetchPlaybackQueue(contextType, contextId);
            if (!data.success || !data.queue?.length) return false;
            this._applyQueue(data.context, data.queue);
        }

        const index = this.queue.findIndex(t => t.track_id === trackId);
        if (index === -1) return false;

        this.currentIndex = index;
        this._loadCurrentTrack(false);

        // Pointless to load a track into a player the visitor cannot see.
        this.expand();
        return true;
    }

    /**
     * Whether audio is actually coming out.
     *
     * `_isPlaying` only tracks the <audio> element. In embed mode Spotify plays
     * inside an iframe we cannot query, so the embed being on screen is the
     * best available signal that the user may be listening.
     *
     * @returns {boolean}
     */
    _isSounding() {
        return this._isPlaying || this._embedMode;
    }

    /**
     * Replace the queue and reset to its first track.
     *
     * @param {Object} context
     * @param {Array} queue
     * @private
     */
    _applyQueue(context, queue) {
        this._pendingQueue = null;
        this.context = context;
        this.queue = queue;
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

        // Album art, inside a frame.
        //
        // The frame exists because _updateTrackDisplay() replaces .mp-art's
        // innerHTML wholesale on every track change. Anything nested inside it
        // would be destroyed; the play overlay is therefore a SIBLING of the
        // art, positioned over it by CSS.
        this._artFrameEl = document.createElement('div');
        this._artFrameEl.className = 'mp-art-frame';

        this._artEl = document.createElement('div');
        this._artEl.className = 'mp-art';
        this._artEl.innerHTML = '<div class="mp-art-placeholder"></div>';
        this._artFrameEl.appendChild(this._artEl);

        // Track info
        this._infoEl = document.createElement('div');
        this._infoEl.className = 'mp-info';
        this._infoEl.innerHTML = `
            <div class="mp-track-name">No track loaded</div>
            <div class="mp-release-name"></div>
        `;

        // Transport. The play button is NOT here: it sits over the album art
        // (see _artFrameEl above), which is what makes the phone layout a
        // single tappable tile rather than a row of small buttons.
        this._controlsEl = document.createElement('div');
        this._controlsEl.className = 'mp-controls';
        this._controlsEl.innerHTML = `
            <button class="mp-btn mp-prev" title="Previous">&#9664;&#9664;</button>
            <button class="mp-btn mp-next" title="Next">&#9654;&#9654;</button>
        `;

        const playBtn = document.createElement('button');
        playBtn.className = 'mp-btn mp-play';
        playBtn.title = 'Play';
        playBtn.innerHTML = '&#9654;';
        this._artFrameEl.appendChild(playBtn);

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

        // Collapse toggle. The player sits above the info sheet and takes its
        // height from the sheet's, so hiding it is how you get that space back
        // for reading. Collapsed it keeps a strip showing what is playing —
        // vanishing entirely would leave no way back.
        this._collapseToggleEl = document.createElement('button');
        this._collapseToggleEl.className = 'mp-btn mp-collapse-toggle';
        this._collapseToggleEl.title = 'Hide player';
        this._collapseToggleEl.textContent = '\u25BE'; // down triangle

        // Queue drawer
        this._drawerEl = document.createElement('div');
        this._drawerEl.className = 'mp-drawer';
        this._drawerEl.style.display = 'none';

        // Right side wrapper
        const rightEl = document.createElement('div');
        rightEl.className = 'mp-right';
        rightEl.appendChild(this._externalEl);
        rightEl.appendChild(this._queueToggleEl);
        rightEl.appendChild(this._collapseToggleEl);

        // Assemble bar
        const barEl = document.createElement('div');
        barEl.className = 'mp-bar';
        barEl.appendChild(this._artFrameEl);
        barEl.appendChild(this._infoEl);
        barEl.appendChild(this._controlsEl);
        barEl.appendChild(this._scrubberEl);
        barEl.appendChild(rightEl);

        // Spotify embed row. .mini-player is a flex column anchored to the
        // bottom of the viewport, so this row grows the player upward.
        // Visibility is CSS's, keyed off body.mini-player-embed. It used to be
        // set inline here and in _enter/_exitEmbedMode, and an inline style
        // beats any selector — so the collapsed rule that hides the embed could
        // never win, and hiding the player left Spotify's card covering the
        // sheet.
        this._embedEl = document.createElement('div');
        this._embedEl.className = 'mp-embed';
        this._embedHostEl = document.createElement('div');
        this._embedEl.appendChild(this._embedHostEl);

        this.container.appendChild(barEl);
        this.container.appendChild(this._embedEl);
        this.container.appendChild(this._drawerEl);

        this._bindControlEvents();
        this._applyCollapsedState();
    }

    _bindControlEvents() {
        // Play/pause
        const playBtn = this.container.querySelector('.mp-play');
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
        this._collapseToggleEl.addEventListener('click', () => this._toggleCollapsed());
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
     * Point the embed row at a Spotify URI using a plain iframe.
     *
     * This deliberately does NOT use Spotify's iFrame API. That API's
     * implementation calls eval() internally:
     *
     *   Uncaught EvalError: Evaluating a string as JavaScript violates the
     *   following Content Security Policy directive because 'unsafe-eval' is
     *   not an allowed source of script
     *
     * Allowing 'unsafe-eval' would re-open the whole class of injection the
     * strict script-src exists to prevent, across the entire page, to gain a
     * play button. Not a trade worth making, so the fallback documented when
     * the embed work started is what ships: a plain iframe, which needs only
     * frame-src.
     *
     * What that costs: our transport cannot drive playback, so there is no
     * programmatic play and no auto-advance at track end. The visitor presses
     * play inside the embed. Prev/next still work — they swap which track the
     * embed shows.
     *
     * @param {string} uri - spotify:track:ID
     */
    _showEmbed(uri) {
        const id = uri.split(':').pop();
        const type = uri.split(':')[1] || 'track';
        const src = `https://open.spotify.com/embed/${type}/${id}`;

        if (this._embedUri === uri && this._embedEl.querySelector('iframe')) return;
        this._embedUri = uri;

        // Rebuild rather than reuse: assigning src on an existing iframe leaves
        // a history entry, so Back inside the page would step through tracks.
        this._embedEl.innerHTML = '';

        // The tile wraps the iframe so the transport can be positioned over its
        // edges without the iframe itself needing to know about them.
        const tile = document.createElement('div');
        tile.className = 'mp-embed-tile';

        const frame = document.createElement('iframe');
        frame.src = src;
        // Square. Spotify picks its layout from the aspect ratio it is given:
        // a wide box gets the horizontal card, a square one gets the cover-art
        // tile with a play button over it — which is the shape asked for, and
        // it comes from Spotify rather than from us faking a transport we
        // cannot drive. The size lives in --mp-embed-size so it can be tuned,
        // or reverted to the wide card, without touching this.
        frame.width = '100%';
        frame.height = '100%';
        frame.frameBorder = '0';
        frame.loading = 'lazy';
        frame.allow = 'encrypted-media; clipboard-write; picture-in-picture';
        frame.title = 'Spotify player';
        tile.appendChild(frame);

        // Prev / next over the artwork. Disabled at the ends of the queue
        // rather than hidden, so the tile does not reflow on hover.
        for (const [dir, cls, glyph, label] of [
            [-1, 'prev', '\u25C0', 'Previous track'],
            [1, 'next', '\u25B6', 'Next track'],
        ]) {
            const btn = document.createElement('button');
            btn.className = `mp-embed-nav mp-embed-nav--${cls}`;
            btn.title = label;
            btn.setAttribute('aria-label', label);
            btn.textContent = glyph;
            btn.disabled = dir < 0
                ? this.currentIndex <= 0
                : this.currentIndex >= this.queue.length - 1;
            btn.addEventListener('click', () => (dir < 0 ? this._prev() : this._next()));
            tile.appendChild(btn);
        }

        this._embedEl.appendChild(tile);
    }

    /**
     * Which Spotify URI to embed for a track.
     *
     * Prefers the album, because a track embed cannot advance — a plain iframe
     * exposes nothing to call, so playback stops at every boundary. An album
     * embed carries Spotify's own queue and continues by itself.
     *
     * Falls back to the track when the release has no album link, which is the
     * case for a loose track or a release nobody has added one to.
     *
     * @param {Object} track - Queue entry.
     * @returns {string|null}
     */
    _embedUriFor(track) {
        return track?.release_embed_uri || track?.listen?.embed_uri || null;
    }

    /**
     * Whether the embed currently on screen is an album, and therefore owns its
     * own queue.
     *
     * @returns {boolean}
     */
    _albumEmbedActive() {
        return this._embedMode && !!this._embedUri?.startsWith('spotify:album:');
    }

    _enterEmbedMode() {
        this._stopAudio();
        if (this._embedMode) return;
        this._embedMode = true;
        document.body.classList.add('mini-player-embed');
        this._notifyHeightChange();
    }

    _exitEmbedMode() {
        this._embedUri = null;
        // Removing the iframe stops playback; there is no controller to pause.
        if (this._embedEl) this._embedEl.innerHTML = '';
        if (!this._embedMode) return;
        this._embedMode = false;
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
        if (track.listen.embed_uri) return 'embed';
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
        // A queue that arrived while something was playing is adopted here:
        // pressing play is the moment the user says they want the thing they
        // selected, rather than the thing still sounding.
        if (this._pendingQueue) {
            const { context, queue } = this._pendingQueue;
            this._applyQueue(context, queue);
        }

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
            // Show the embed; playback is started from inside it. A plain
            // iframe exposes no API to call, and adding 'unsafe-eval' to reach
            // Spotify's would weaken the whole page's CSP.
            this._enterEmbedMode();
            this._showEmbed(track.listen.embed_uri);
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
            this._showEmbed(this._embedUriFor(track));
        } else {
            this._exitEmbedMode();
        }

        this._updateTrackDisplay();
        this._highlightQueueRow();
    }

    // ========== UI UPDATES ==========

    /**
     * Collapse the player to a strip, or restore it.
     *
     * The class goes on body because the sheet's height is derived from
     * --mini-player-height, which is republished here once the new height has
     * rendered.
     */
    /**
     * Open the player if it is hidden.
     *
     * Distinct from _toggleCollapsed so callers that want it *shown* cannot
     * accidentally hide it — playTrackById() would otherwise close the player
     * for anyone who already had it open.
     */
    expand() {
        if (!this._collapsed) return;
        this._collapsed = false;
        this._applyCollapsedState();
        this._notifyHeightChange();
    }

    _toggleCollapsed() {
        this._collapsed = !this._collapsed;
        this._applyCollapsedState();
        // A drawer left open under a collapsed player would keep its height.
        if (this._collapsed && this.drawerOpen) this._toggleDrawer();
        this._notifyHeightChange();
    }

    /**
     * Reflect the collapsed flag in the DOM.
     *
     * Separate from the toggle so the initial state can be applied during
     * render, before the first height is published — otherwise the sheet is
     * laid out against an expanded player and visibly resizes a frame later.
     *
     * @private
     */
    _applyCollapsedState() {
        document.body.classList.toggle('mini-player-collapsed', this._collapsed);
        this._collapseToggleEl.textContent = this._collapsed ? '\u25B4 Player' : '\u25BE';
        this._collapseToggleEl.title = this._collapsed ? 'Show player' : 'Hide player';
    }

    _show() {
        this.container.style.display = 'flex';
        document.body.classList.add('mini-player-visible');
        // The player appearing changes the layout as much as the embed opening
        // does; without this the graph and the info sheet keep sizing against a
        // player height of zero until something else happens to notify them.
        this._notifyHeightChange();
    }

    _hide() {
        this._stopAudio();
        this._exitEmbedMode();
        this.container.style.display = 'none';
        document.body.classList.remove('mini-player-visible');
        this._notifyHeightChange();
    }

    /**
     * Publish the player's real height, then tell the graph to re-measure.
     *
     * On mobile the info sheet is positioned against --mini-player-height and
     * the graph's bottom inset is computed from it, so a wrong value shows up
     * directly as a gap or an overlap. It used to be a hand-summed constant in
     * CSS (54px bar, 138px with the embed) that was already a pixel out from
     * what rendered, because .mp-bar is height:auto on mobile. Measuring is the
     * only way it stays right as paddings change.
     *
     * Read after a frame: the class that grows the player is applied in the
     * same tick, so measuring immediately returns the old height.
     */
    _notifyHeightChange() {
        requestAnimationFrame(() => {
            const height = this.container?.offsetHeight ?? 0;

            // On body, not documentElement: the .mini-player-visible class
            // rules define this same variable on body, and a value set on the
            // nearer ancestor wins for everything inside it.
            document.body.style.setProperty('--mini-player-height', `${height}px`);
            window.dispatchEvent(new CustomEvent('miniplayer:resize'));
        });
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

        // Inside an album embed Spotify owns the queue: our prev/next would
        // move this display without moving what is actually sounding, since
        // _showEmbed early-returns for a URI already on screen. Better to say
        // they do not apply than to let them lie.
        const albumEmbed = this._albumEmbedActive();
        for (const cls of ['.mp-prev', '.mp-next']) {
            const btn = this._controlsEl.querySelector(cls);
            if (!btn) continue;
            btn.disabled = albumEmbed;
            btn.title = albumEmbed
                ? 'Spotify controls the queue while an album is playing'
                : (cls === '.mp-prev' ? 'Previous' : 'Next');
        }

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
        const playBtn = this.container.querySelector('.mp-play');

        // A queue is waiting because something is still playing. Say what the
        // button will do, so switching is a choice rather than a surprise.
        if (this._pendingQueue) {
            playBtn.disabled = false;
            playBtn.innerHTML = '&#9654;';
            playBtn.title = `Play ${this._pendingQueue.context?.name ?? 'selection'}`;
            return;
        }

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
