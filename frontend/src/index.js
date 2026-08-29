/**
 * Polaris Music Registry - Frontend
 * Main entry point for the release submission form
 */

import { FormBuilder } from './components/FormBuilder.js';
import { FormLookupManager } from './components/FormLookupManager.js';
import { api } from './utils/api.js';
import { WalletManager } from './wallet/WalletManager.js';
import { TransactionBuilder } from './utils/transactionBuilder.js';
import { discogsClient } from './utils/discogsClient.js';
import { searchNodes } from './utils/searchClient.js';
import { INGEST_MODE, CONTRACT_ACCOUNT } from './config/chain.js';
import { canonicalizeListenLink, sameTarget, normalizeListenLink } from './utils/listenLinks.js';

class PolarisApp {
    constructor() {
        this.formBuilder = new FormBuilder();
        this.currentReleaseData = null;
        this.currentTransaction = null;

        // Set by the first edit; gates the navigate-away confirmation. Tracked
        // as a flag rather than inferred from field values, because a fresh
        // form is not empty — is-master is checked and every track number is
        // prefilled, so a value-based test calls an untouched form dirty.
        this.formDirty = false;

        // Initialize wallet manager
        this.walletManager = new WalletManager();
        this.transactionBuilder = new TransactionBuilder();

        this.init();
    }

    async init() {
        // Tab navigation
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                const tabName = e.target.dataset.tab;

                // Special handling for Browse Registry tab
                if (tabName === 'browse') {
                    if (this.formDirty && !confirm(
                        'Are you sure you want to navigate away from this page? '
                        + 'Any unsaved changes will be lost.')) {
                        return;
                    }
                    window.location.href = '/';
                    return;
                }

                this.switchTab(tabName);
            });
        });

        // Any edit anywhere in the form counts, including in dynamically added
        // track rows — these are delegated from the form element, so rows added
        // later are covered without rebinding.
        const releaseForm = document.getElementById('release-form');
        if (releaseForm) {
            const markDirty = () => { this.formDirty = true; };
            releaseForm.addEventListener('input', markDirty);
            releaseForm.addEventListener('change', markDirty);
            // Adding an empty track or label fires neither, but it is still
            // work the submitter would not want to lose silently.
            releaseForm.addEventListener('click', (e) => {
                if (e.target.closest('.btn-add')) markDirty();
            });
        }

        // Initialize form handlers
        this.initializeForm();

        // Initialize entity lookup manager (binds autocomplete to dynamic form fields)
        const formEl = document.getElementById('release-form');
        if (formEl) {
            this.lookupManager = new FormLookupManager(formEl);
        }

        // Try to restore wallet session
        try {
            const sessionInfo = await this.walletManager.restore();
            if (sessionInfo) {
                console.log('Wallet session restored:', sessionInfo);
                this.showToast('Wallet connected: ' + sessionInfo.accountName, 'success');
            } else {
                console.log('No wallet session to restore');
            }
        } catch (error) {
            console.error('Failed to restore wallet session:', error);
        }

        // Check API health
        this.checkAPIHealth();
    }

    switchTab(tabName) {
        // Update tab buttons
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelector(`.tab[data-tab="${tabName}"]`).classList.add('active');

        // Update tab content
        document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
        document.getElementById(`${tabName}-tab`).classList.add('active');
    }

    async checkAPIHealth() {
        const healthy = await api.healthCheck();
        if (!healthy) {
            this.showToast('Warning: Cannot connect to backend API', 'error');
        }
    }

    initializeForm() {
        const form = document.getElementById('release-form');

        // Master release checkbox
        const isMasterCheckbox = document.getElementById('is-master');
        const masterReleaseGroup = document.getElementById('master-release-group');

        isMasterCheckbox.addEventListener('change', (e) => {
            masterReleaseGroup.style.display = e.target.checked ? 'none' : 'block';
        });

        // Add label button
        document.getElementById('add-label').addEventListener('click', () => {
            const container = document.getElementById('labels-container');
            container.appendChild(this.formBuilder.createLabelForm());
        });

        // Add release group button
        document.getElementById('add-release-group').addEventListener('click', () => {
            const container = document.getElementById('release-groups-container');
            const index = container.children.length;
            const groupForm = this.formBuilder.createReleaseGroupForm(index);
            container.appendChild(groupForm);
            // Tracks pick this up through their "same as release" checkbox at
            // extraction time, so there is nothing to copy into them here.
        });

        // Add release guest button
        document.getElementById('add-release-guest').addEventListener('click', () => {
            const container = document.getElementById('release-guests-container');
            const index = container.children.length;
            container.appendChild(this.formBuilder.createReleaseGuestForm(index));
        });

        // Add release songwriter button
        document.getElementById('add-release-songwriter').addEventListener('click', () => {
            const container = document.getElementById('release-songwriters-container');
            const index = container.children.length;
            container.appendChild(
                this.formBuilder.createPersonForm(index, 'release-songwriter'));
        });

        // Pull track links up to the release, flagging any that disagree
        document.getElementById('import-track-links').addEventListener('click', () => {
            this.importTrackListenLinks();
        });

        // A required control inside a collapsed <details> cannot be focused,
        // and Chrome then aborts submission with "An invalid form control is
        // not focusable" and no visible cause. Open its ancestors so the
        // browser can show the message where the problem is. `invalid` does
        // not bubble, hence capture.
        form.addEventListener('invalid', (e) => {
            for (let el = e.target; el; el = el.parentElement) {
                if (el.tagName === 'DETAILS') el.open = true;
            }
        }, true);

        // Add track button
        document.getElementById('add-track').addEventListener('click', () => {
            const container = document.getElementById('tracks-container');
            container.appendChild(this.formBuilder.createTrackForm());
        });

        // Preview JSON button
        document.getElementById('preview-json').addEventListener('click', (e) => {
            e.preventDefault();
            this.previewJSON();
        });

        // Form submission
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            this.previewJSON();
        });

        // Modal close
        document.querySelector('.close').addEventListener('click', () => {
            this.closeModal();
        });

        // Copy JSON button
        document.getElementById('copy-json').addEventListener('click', () => {
            this.copyJSON();
        });

        // Confirm submit button
        document.getElementById('confirm-submit').addEventListener('click', () => {
            this.submitRelease();
        });

        // Close modal on background click
        document.getElementById('json-modal').addEventListener('click', (e) => {
            if (e.target.id === 'json-modal') {
                this.closeModal();
            }
        });

        // Discogs fetch button
        document.getElementById('fetch-discogs-btn').addEventListener('click', () => {
            this.fetchFromDiscogs();
        });

        // Allow Enter key in Discogs input
        document.getElementById('discogs-input').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.fetchFromDiscogs();
            }
        });
    }

    /**
     * Extract form data and build full canonical release bundle
     * Returns the complete bundle matching backend/src/schema/releaseBundle.schema.json
     */
    buildReleaseData() {
        const form = document.getElementById('release-form');
        const formData = new FormData(form);

        // Release-level values are gathered first, because any track set to
        // "same as release" copies them into its own payload.
        const releaseDefaults = {
            groups: this.extractReleaseGroups(),
            guests: this.extractReleaseGuests(),
            producers: [],
            songwriters: this.extractReleaseSongwriters(),
        };

        // Extract tracks first (needed for tracklist, songs)
        const tracks = this.extractTracks(releaseDefaults);

        // Release metadata (canonical keys)
        const release = {
            name: formData.get('release_name'),
            labels: this.extractLabels(),
            guests: releaseDefaults.guests,
        };

        const releaseListenLinks = this.parseCommaSeparated(
            formData.get('release_listen_links'))
            .map(canonicalizeListenLink)
            .filter(Boolean);
        if (releaseListenLinks.length > 0) release.listen_links = releaseListenLinks;

        // Optional release fields
        const altNames = this.parseCommaSeparated(formData.get('release_altnames'));
        if (altNames.length > 0) release.alt_names = altNames;

        const releaseDate = formData.get('release_date');
        if (releaseDate) release.release_date = releaseDate;

        const format = formData.get('release_format');
        if (format) release.format = format; // string, not array

        const linerNotes = formData.get('liner_notes');
        if (linerNotes) release.liner_notes = linerNotes;

        // Master release. The id is set only when the submitter picked an
        // existing Release from the lookup; otherwise keep the typed name so a
        // master that is not in the registry yet is still recorded rather than
        // silently dropped.
        const isMaster = document.getElementById('is-master').checked;
        if (!isMaster) {
            const masterId = formData.get('master_release_id');
            const masterName = formData.get('master_release_name');
            if (masterId) release.master_id = masterId;
            if (masterName) release.master_name = masterName;
        }

        // Release-level groups (with members)
        const groups = releaseDefaults.groups;

        // Build canonical tracklist from tracks
        const tracklist = tracks.map((track, index) => {
            const item = {
                position: `${track._disc || 1}.${track._trackNumber || index + 1}`,
                track_title: track.title,
            };
            if (track.track_id) item.track_id = track.track_id;
            return item;
        });

        // Build songs from track songwriters (deduplicated by title)
        const songs = this.buildSongsFromTracks(tracks);

        // Build sources from source links
        const sourceLinks = this.parseCommaSeparated(formData.get('source_links'));
        const sources = sourceLinks.map(url => ({
            type: 'web',
            url,
            accessed_at: new Date().toISOString().split('T')[0]
        }));

        // Strip internal fields from tracks before output
        const canonicalTracks = tracks.map(track => {
            const { _disc, _trackNumber, _songwriters, ...canonical } = track;
            return canonical;
        });

        // Assemble full bundle
        const bundle = {
            release,
            groups,
            tracks: canonicalTracks,
            tracklist,
        };

        if (songs.length > 0) bundle.songs = songs;
        if (sources.length > 0) bundle.sources = sources;

        return bundle;
    }

    /**
     * Extract release-level groups with their members
     * Reads from the release-groups section of the form.
     */
    extractReleaseGroups() {
        const groups = [];
        const groupItems = document.querySelectorAll('[data-type="release-group"]');

        groupItems.forEach(item => {
            const index = item.dataset.index;
            const groupName = this.getInputValue(item, `release-group-name-${index}`);

            if (!groupName) return;

            const group = { name: groupName };

            // Emit existing group_id if bound via autocomplete
            const groupId = this.getInputValue(item, `release-group-id-${index}`);
            if (groupId) group.group_id = groupId;

            // Alt names
            const altNamesStr = this.getInputValue(item, `release-group-altnames-${index}`);
            const altNames = this.parseCommaSeparated(altNamesStr);
            if (altNames.length > 0) group.alt_names = altNames;

            // Extract members from release-group member forms
            const members = [];
            const memberItems = item.querySelectorAll('[data-type="release-member"]');
            memberItems.forEach(memberItem => {
                const memberData = this.extractPersonData(memberItem, 'release-member', index);
                if (memberData) members.push(memberData);
            });

            if (members.length > 0) group.members = members;

            groups.push(group);
        });

        return groups;
    }

    /**
     * Build canonical songs array from track songwriters
     * Deduplicates songs by title and merges writers.
     */
    buildSongsFromTracks(tracks) {
        const songMap = new Map();

        for (const track of tracks) {
            // Key songs by song_id if available, otherwise by title
            const songKey = track.song_id || track.recording_of || track.title;
            if (!songKey) continue;

            // Songwriters stored as internal _songwriters field
            const writers = (track._songwriters || []).map(sw => {
                const writer = { name: sw.name };
                if (sw.person_id) writer.person_id = sw.person_id;
                if (sw.roles && sw.roles.length > 0) {
                    writer.roles = sw.roles;
                    writer.role = sw.roles[0];
                }
                return writer;
            });

            if (writers.length === 0) continue;

            if (!songMap.has(songKey)) {
                const song = { title: track.recording_of || track.title, writers };
                // Emit existing song_id if track was bound to an existing song
                if (track.song_id) song.song_id = track.song_id;
                songMap.set(songKey, song);
            }
            // If key already exists, skip (first occurrence wins)
        }

        return Array.from(songMap.values());
    }

    /**
     * Extract labels from form (canonical format)
     * Emits: { name, alt_names?, parent_label?, origin_city? }
     * Backend will generate deterministic prov: IDs during normalization.
     */
    extractLabels() {
        const labels = [];
        const labelItems = document.querySelectorAll('[data-type="label"]');

        labelItems.forEach(item => {
            const index = item.dataset.index;
            const labelName = this.getInputValue(item, `label-name-${index}`);

            if (!labelName) return;

            const label = { name: labelName };

            // Emit existing label_id if bound via autocomplete
            const labelId = this.getInputValue(item, `label-id-${index}`);
            if (labelId) label.label_id = labelId;

            // Alt names
            const altNames = this.parseCommaSeparated(this.getInputValue(item, `label-altnames-${index}`));
            if (altNames.length > 0) label.alt_names = altNames;

            // Parent label - emit as object with ID if bound, otherwise string
            const parentLabel = this.getInputValue(item, `label-parent-${index}`);
            const parentLabelId = this.getInputValue(item, `label-parent-id-${index}`);
            if (parentLabel) {
                if (parentLabelId) {
                    label.parent_label = { name: parentLabel, label_id: parentLabelId };
                } else {
                    label.parent_label = parentLabel;
                }
            }

            // Origin city (optional)
            const cityName = this.getInputValue(item, `label-city-name-${index}`);
            if (cityName) {
                const lat = parseFloat(this.getInputValue(item, `label-city-lat-${index}`));
                const lon = parseFloat(this.getInputValue(item, `label-city-lon-${index}`));
                label.origin_city = { name: cityName };
                if (!isNaN(lat)) label.origin_city.lat = lat;
                if (!isNaN(lon)) label.origin_city.lon = lon;
            }

            labels.push(label);
        });

        return labels;
    }

    /**
     * Extract release-level guests from form (canonical format)
     * Emits: { name, roles: string[], origin_city? }
     * These are producers, engineers, etc. persisted as GUEST_ON→Release.
     */
    extractReleaseGuests() {
        const guests = [];
        const guestItems = document.querySelectorAll('[data-type="release-guest"]');

        guestItems.forEach(item => {
            const index = item.dataset.index;
            const name = this.getInputValue(item, `release-guest-name-${index}`);

            if (!name) return;

            const rolesStr = this.getInputValue(item, `release-guest-roles-${index}`);
            const roles = this.parseRoles(rolesStr);

            const guest = { name };

            // Emit existing person_id if bound via autocomplete
            const personId = this.getInputValue(item, `release-guest-person-id-${index}`);
            if (personId) guest.person_id = personId;

            if (roles.length > 0) guest.roles = roles;

            // Origin city (optional)
            const cityName = this.getInputValue(item, `release-guest-city-name-${index}`);
            if (cityName) {
                const lat = parseFloat(this.getInputValue(item, `release-guest-city-lat-${index}`));
                const lon = parseFloat(this.getInputValue(item, `release-guest-city-lon-${index}`));
                guest.origin_city = { name: cityName };
                if (!isNaN(lat)) guest.origin_city.lat = lat;
                if (!isNaN(lon)) guest.origin_city.lon = lon;
            }

            guests.push(guest);
        });

        return guests;
    }

    /**
     * Try to attach an existing registry node to a field the Discogs import
     * just filled in.
     *
     * Binding is deliberately conservative: exactly one result, matching the
     * name exactly bar case. A wrong id is far worse than no id — it merges
     * two different artists into one node, and the graph has no cheap way back
     * from that. Anything short of certain is left for a human, marked so it
     * can be found.
     *
     * @param {HTMLInputElement} hiddenInput - The data-lookup-type field.
     * @param {string} name - The name Discogs supplied.
     * @param {string[]} types - Node labels to search.
     * @returns {Promise<boolean>} Whether a binding was made.
     */
    async reconcileField(hiddenInput, name, types) {
        if (!hiddenInput || !name || !this.lookupManager) return false;

        const field = this.lookupManager.getInstance(hiddenInput);
        if (!field) return false;

        let results;
        try {
            results = await searchNodes(name, { types, limit: 5 });
        } catch (error) {
            console.warn('Reconciliation lookup failed for', name, error);
            return false;
        }

        const wanted = name.trim().toLowerCase();
        const exact = results.filter(
            r => (r.display_name || '').trim().toLowerCase() === wanted);

        if (exact.length === 1) {
            field.bind(exact[0]);
            return true;
        }

        // Ambiguous or absent: keep the typed name, flag for review.
        hiddenInput.closest('.form-group')?.classList.add('needs-review');
        return false;
    }

    /**
     * Reconcile every name the Discogs import filled in, in one pass.
     *
     * Runs after the form is fully built rather than per field, so the lookup
     * manager's MutationObserver has attached instances to the new rows.
     * Lookups run sequentially: searchNodes has no request cancellation and
     * the backend is a shared instance, so a burst of parallel queries for one
     * import is not worth the few hundred milliseconds it would save.
     */
    async reconcileImportedFields() {
        const form = document.getElementById('release-form');
        if (!form) return;

        const targets = form.querySelectorAll('input[data-lookup-type]');
        let bound = 0;

        for (const hiddenInput of targets) {
            if (hiddenInput.value) continue;   // already bound

            const pairName = hiddenInput.dataset.lookupPair;
            const visible = pairName ? form.querySelector(`[name="${pairName}"]`) : null;
            const name = visible?.value?.trim();
            if (!name) continue;

            const lookupType = hiddenInput.dataset.lookupType;
            if (await this.reconcileField(hiddenInput, name, [lookupType])) bound++;
        }

        if (bound > 0) {
            this.showToast(`Matched ${bound} entit${bound === 1 ? 'y' : 'ies'} to existing registry nodes`, 'success');
        }
    }

    /**
     * Collect the listen links entered on individual tracks and offer them at
     * the release level, flagging any that disagree.
     *
     * This is the Discogs cross-check: an imported tracklist can carry links
     * belonging to a different edition, and the giveaway is a track pointing at
     * an album other than the one its neighbours point at. Those are reported
     * rather than merged in — the whole point is that a human looks.
     */
    importTrackListenLinks() {
        const report = document.getElementById('listen-link-report');
        const target = document.getElementById('release-listen-links');
        report.innerHTML = '';

        /** @type {{track: string, link: string, parsed: object|null}[]} */
        const entries = [];
        document.querySelectorAll('.track-item').forEach(item => {
            const index = item.dataset.index;
            const title = this.getInputValue(item, `track-title-${index}`)
                || `Track ${Number(index) + 1}`;
            this.parseCommaSeparated(this.getInputValue(item, `track-listen-link-${index}`))
                .forEach(link => entries.push({
                    track: title, link, parsed: normalizeListenLink(link)
                }));
        });

        if (entries.length === 0) {
            report.textContent = 'No track links to import yet.';
            return;
        }

        // The album every track ought to belong to: the most common album id
        // among track links that carry one.
        const albumCounts = new Map();
        for (const entry of entries) {
            const album = entry.parsed?.type === 'album' ? entry.parsed.id : null;
            if (album) albumCounts.set(album, (albumCounts.get(album) || 0) + 1);
        }
        const [dominantAlbum] = [...albumCounts.entries()]
            .sort((a, b) => b[1] - a[1])[0] || [];

        const accepted = [];
        const mismatches = [];
        for (const entry of entries) {
            const canonical = canonicalizeListenLink(entry.link);
            if (!canonical) {
                mismatches.push({ ...entry, reason: 'not a usable URL' });
                continue;
            }
            if (!entry.parsed) {
                mismatches.push({ ...entry, reason: 'unrecognized service — kept, but unverified' });
                accepted.push(canonical);
                continue;
            }
            if (dominantAlbum && entry.parsed.type === 'album'
                && entry.parsed.id !== dominantAlbum) {
                mismatches.push({ ...entry, reason: 'points at a different album' });
                continue;
            }
            accepted.push(canonical);
        }

        // De-duplicate on identity, not on string, so a locale-prefixed link
        // and its plain twin collapse to one entry.
        const unique = [];
        for (const link of accepted) {
            if (!unique.some(existing => sameTarget(existing, link))) unique.push(link);
        }

        const existing = this.parseCommaSeparated(target.value);
        for (const link of unique) {
            if (!existing.some(current => sameTarget(current, link))) existing.push(link);
        }
        target.value = existing.join(', ');

        this.renderListenLinkReport(report, unique.length, mismatches);
    }

    /**
     * Render the outcome of a link import.
     *
     * @param {HTMLElement} report
     * @param {number} importedCount
     * @param {{track: string, link: string, reason: string}[]} mismatches
     */
    renderListenLinkReport(report, importedCount, mismatches) {
        const summary = document.createElement('p');
        summary.textContent = `Imported ${importedCount} link(s).`;
        report.appendChild(summary);

        if (mismatches.length === 0) return;

        const heading = document.createElement('p');
        heading.className = 'link-mismatch-heading';
        heading.textContent = `${mismatches.length} link(s) need a look:`;
        report.appendChild(heading);

        const list = document.createElement('ul');
        list.className = 'link-mismatch-list';
        for (const mismatch of mismatches) {
            const row = document.createElement('li');
            row.className = 'link-mismatch';
            row.textContent = `${mismatch.track}: ${mismatch.link} — ${mismatch.reason}`;
            list.appendChild(row);
        }
        report.appendChild(list);
    }

    /**
     * Extract release-level songwriters.
     *
     * Songwriters are canonically Song.writers, not a Release property, so
     * these are defaults: buildSongsFromTracks() materializes them onto each
     * song whose track has not overridden them. Same shape as track-level
     * songwriters so the two are interchangeable.
     *
     * @returns {Array<{name: string, person_id?: string, roles?: string[]}>}
     */
    extractReleaseSongwriters() {
        const writers = [];

        document.querySelectorAll('[data-type="release-songwriter"]').forEach(item => {
            const index = item.dataset.index;
            // createPersonForm() names fields `${type}-name-${parent}-${index}`
            // and is called with the default parent of 0, so the leading 0 is
            // part of the contract, not a stray literal.
            const name = this.getInputValue(item, `release-songwriter-name-0-${index}`);
            if (!name) return;

            const writer = { name };

            const personId = this.getInputValue(item, `release-songwriter-person-id-0-${index}`);
            if (personId) writer.person_id = personId;

            const roles = this.parseRoles(
                this.getInputValue(item, `release-songwriter-roles-0-${index}`));
            if (roles.length > 0) writer.roles = roles;

            writers.push(writer);
        });

        return writers;
    }

    /**
     * Whether a track section is set to inherit from the release.
     *
     * Absent checkbox means "not inheriting" so that any markup predating the
     * inherit toggles keeps its own values rather than silently adopting the
     * release's.
     *
     * @param {Element} trackItem
     * @param {string|number} index
     * @param {string} key - groups | guests | producers | songwriters
     * @returns {boolean}
     */
    isInherited(trackItem, index, key) {
        const checkbox = trackItem.querySelector(`[name="track-same-${key}-${index}"]`);
        return Boolean(checkbox && checkbox.checked);
    }

    /**
     * Extract tracks from form (canonical format)
     * Emits canonical Track shape: { title, performed_by_groups, guests, producers, ... }
     * Internal fields (_disc, _trackNumber, _songwriters) are stripped before final output.
     */
    extractTracks(releaseDefaults = {}) {
        const tracks = [];
        const trackItems = document.querySelectorAll('.track-item');

        trackItems.forEach((item, trackIndex) => {
            const index = item.dataset.index;
            const title = this.getInputValue(item, `track-title-${index}`);

            if (!title) return;

            const track = {
                title: title,
                recording_of: title, // Links Track to Song by title
            };

            // Emit existing track_id if bound via autocomplete
            const trackId = this.getInputValue(item, `track-id-${index}`);
            if (trackId) track.track_id = trackId;

            // Song lookup: if user selected an existing song, use its ID
            const songId = this.getInputValue(item, `track-song-id-${index}`);
            const songTitle = this.getInputValue(item, `track-song-title-${index}`);
            if (songId) {
                track.song_id = songId;
                if (songTitle) track.recording_of = songTitle;
            } else if (songTitle) {
                track.recording_of = songTitle;
            }

            // Performing groups, guests and producers each either come from
            // this track's own fields or are inherited from the release.
            //
            // Inheriting COPIES the release-level values, node ids and all, into
            // this track's payload — the bundle stays as explicit as one filled
            // in by hand. This replaces addReleaseGroupToAllTracks(), which
            // copied only the name string and so dropped the bound group_id,
            // leaving every track pointing at a new provisional group instead
            // of the one the submitter picked.
            const performedByGroups = this.isInherited(item, index, 'groups')
                ? structuredClone(releaseDefaults.groups || [])
                : this.extractGroups(item, index);
            if (performedByGroups.length > 0) track.performed_by_groups = performedByGroups;

            const guests = this.isInherited(item, index, 'guests')
                ? structuredClone(releaseDefaults.guests || [])
                : this.extractPersons(item, 'guest', index);
            if (guests.length > 0) track.guests = guests;

            const producers = this.isInherited(item, index, 'producers')
                ? structuredClone(releaseDefaults.producers || [])
                : this.extractPersons(item, 'producer', index);
            if (producers.length > 0) track.producers = producers;

            // Listen links (comma-separated URLs), reduced to the part that
            // identifies the recording — share tokens and locale prefixes
            // describe whoever copied the link, not the music.
            const listenLinks = this.parseCommaSeparated(
                this.getInputValue(item, `track-listen-link-${index}`))
                .map(canonicalizeListenLink)
                .filter(Boolean);
            if (listenLinks.length > 0) track.listen_links = listenLinks;

            const lyrics = this.getInputValue(item, `track-lyrics-${index}`);
            if (lyrics) track.lyrics = lyrics;

            const trivia = this.getInputValue(item, `track-trivia-${index}`);
            if (trivia) track.trivia = trivia;

            // Cover of (original song) - prefer hidden ID from lookup
            const coverOfSongId = this.getInputValue(item, `track-cover-song-id-${index}`)
                || this.getInputValue(item, `track-cover-${index}`);
            if (coverOfSongId) track.cover_of_song_id = coverOfSongId;

            // Samples - parse from hidden serialized field or chips
            const samplesJson = this.getInputValue(item, `track-samples-${index}`);
            if (samplesJson) {
                try {
                    const sampleIds = JSON.parse(samplesJson);
                    if (Array.isArray(sampleIds) && sampleIds.length > 0) {
                        track.samples = sampleIds.map(id => ({ sampled_track_id: id }));
                    }
                } catch {
                    // Fallback: treat as comma-separated IDs
                    const ids = this.parseCommaSeparated(samplesJson);
                    if (ids.length > 0) {
                        track.samples = ids.map(id => ({ sampled_track_id: id }));
                    }
                }
            }

            // Internal fields (used by buildReleaseData for tracklist/songs, stripped before output)
            track._disc = parseInt(this.getInputValue(item, `track-disc-${index}`) || 1);
            track._trackNumber = parseInt(this.getInputValue(item, `track-number-${index}`) || trackIndex + 1);
            track._songwriters = this.isInherited(item, index, 'songwriters')
                ? structuredClone(releaseDefaults.songwriters || [])
                : this.extractPersons(item, 'songwriter', index);

            tracks.push(track);
        });

        return tracks;
    }

    /**
     * Get first group name from track (for track ID generation)
     */
    getFirstGroupName(trackItem) {
        const firstGroup = trackItem.querySelector('[name^="group-name"]');
        return firstGroup ? firstGroup.value : null;
    }

    /**
     * Extract persons (songwriters, producers, guests) from track
     */
    extractPersons(trackItem, type, trackIndex) {
        const persons = [];
        const personItems = trackItem.querySelectorAll(`[data-type="${type}"]`);

        personItems.forEach(item => {
            const personData = this.extractPersonData(item, type, trackIndex);
            if (personData) persons.push(personData);
        });

        return persons;
    }

    /**
     * Extract a single person's data (canonical format)
     * Emits: { name, roles: string[], origin_city?: { name, lat?, lon? } }
     * Backend will generate deterministic prov: IDs during normalization.
     */
    extractPersonData(item, type, parentIndex) {
        const index = item.dataset.index;
        const name = this.getInputValue(item, `${type}-name-${parentIndex}-${index}`);

        if (!name) return null;

        const rolesStr = this.getInputValue(item, `${type}-roles-${parentIndex}-${index}`);
        const roles = this.parseRoles(rolesStr);

        const person = { name };

        // Emit existing person_id if bound via autocomplete
        const personId = this.getInputValue(item, `${type}-person-id-${parentIndex}-${index}`);
        if (personId) person.person_id = personId;

        if (roles.length > 0) person.roles = roles;

        // Build origin_city if city name is provided
        const cityName = this.getInputValue(item, `${type}-city-name-${parentIndex}-${index}`);
        if (cityName) {
            const lat = parseFloat(this.getInputValue(item, `${type}-city-lat-${parentIndex}-${index}`));
            const lon = parseFloat(this.getInputValue(item, `${type}-city-lon-${parentIndex}-${index}`));
            person.origin_city = { name: cityName };
            if (!isNaN(lat)) person.origin_city.lat = lat;
            if (!isNaN(lon)) person.origin_city.lon = lon;
        }

        return person;
    }

    /**
     * Extract groups and their members from track (canonical format)
     * Emits: { name, alt_names?, members: Person[] }
     * These become track.performed_by_groups in the canonical bundle.
     */
    extractGroups(trackItem, trackIndex) {
        const groups = [];
        const groupItems = trackItem.querySelectorAll('[data-type="group"]');

        groupItems.forEach(item => {
            const groupIndex = item.dataset.index;
            const groupName = this.getInputValue(item, `group-name-${trackIndex}-${groupIndex}`);

            if (!groupName) return;

            const group = {
                name: groupName,
                role: 'performer'
            };

            // Emit existing group_id if bound via autocomplete
            const groupId = this.getInputValue(item, `group-id-${trackIndex}-${groupIndex}`);
            if (groupId) group.group_id = groupId;

            // Alt names
            const altNamesStr = this.getInputValue(item, `group-altnames-${trackIndex}-${groupIndex}`);
            const altNames = this.parseCommaSeparated(altNamesStr);
            if (altNames.length > 0) group.alt_names = altNames;

            // Extract members (canonical Person objects)
            const members = [];
            const memberItems = item.querySelectorAll('[data-type="member"]');

            memberItems.forEach(memberItem => {
                const memberData = this.extractPersonData(memberItem, 'member', `${trackIndex}-${groupIndex}`);
                if (memberData) members.push(memberData);
            });

            if (members.length > 0) group.members = members;

            groups.push(group);
        });

        return groups;
    }

    /**
     * Parse comma-separated values
     */
    parseCommaSeparated(value) {
        if (!value) return [];
        return value.split(',').map(v => v.trim()).filter(v => v);
    }

    /**
     * Parse roles string into string array (canonical format)
     * Backend expects roles: string[] (e.g., ["drums", "vocals"])
     */
    parseRoles(rolesStr) {
        if (!rolesStr) return [];
        return this.parseCommaSeparated(rolesStr);
    }

    /**
     * Get input value from within an element
     */
    getInputValue(element, name) {
        const input = element.querySelector(`[name="${name}"]`);
        return input ? input.value : '';
    }

    /**
     * Preview JSON before submission
     */
    async previewJSON() {
        try {
            // Check if wallet is connected
            if (!this.walletManager.isConnected()) {
                this.showToast('Please connect your wallet first', 'error');
                return;
            }

            // Build release data
            const releaseData = this.buildReleaseData();

            // Validate release data
            const validation = this.transactionBuilder.validateReleaseData(releaseData);
            if (!validation.valid) {
                this.showToast('Validation failed:\n' + validation.errors.join('\n'), 'error');
                return;
            }

            this.currentReleaseData = releaseData;

            // Get wallet session info
            const sessionInfo = this.walletManager.getSessionInfo();

            // Build transaction (event only, no hash yet)
            const sourceLinks = this.parseCommaSeparated(
                document.querySelector('[name="source_links"]')?.value || ''
            );

            this.currentTransaction = this.transactionBuilder.buildReleaseTransaction(
                releaseData,
                sessionInfo.accountName,
                sessionInfo.publicKey || sessionInfo.accountName, // Account name as fallback for author_pubkey metadata
                sourceLinks
            );

            // Get canonical hash from server (this normalizes and validates)
            console.log('Getting canonical hash from server...');
            const prepareResult = await api.prepareEvent(this.currentTransaction.event);

            // Validate that we received the normalized event (guardrail)
            if (!prepareResult.normalizedEvent) {
                throw new Error(
                    'Backend /api/events/prepare did not return normalizedEvent. ' +
                    'This is required for pipeline integrity.'
                );
            }

            // CRITICAL: Replace event with normalized version from server
            // This ensures the stored event matches the hash-canonical event
            // Without this, the signed/stored event could drift from the hashed event
            this.currentTransaction.event = prepareResult.normalizedEvent;

            // Store the canonical hash (action will be built after storage to include event_cid)
            this.currentTransaction.eventHash = prepareResult.hash;

            // CRITICAL: Store canonical payload for signing
            // Frontend must sign this exact payload, not the hash
            // This ensures signature verification succeeds in backend
            this.currentTransaction.canonicalPayload = prepareResult.canonical_payload;

            this.currentTransaction.authorAccount = sessionInfo.accountName;

            console.log('Canonical hash:', prepareResult.hash);

            // Show preview with event data (action will be built after storage)
            const jsonPreview = document.getElementById('json-preview');
            jsonPreview.textContent = JSON.stringify({
                event: this.currentTransaction.event,
                eventHash: this.currentTransaction.eventHash,
                note: 'Blockchain action will be built after storage to include event_cid'
            }, null, 2);

            document.getElementById('json-modal').classList.add('show');
        } catch (error) {
            this.showToast('Error building release data: ' + error.message, 'error');
            console.error('Build error:', error);
        }
    }

    /**
     * Copy JSON to clipboard
     */
    copyJSON() {
        const jsonText = document.getElementById('json-preview').textContent;
        navigator.clipboard.writeText(jsonText).then(() => {
            this.showToast('JSON copied to clipboard!', 'success');
        });
    }

    /**
     * Submit release via blockchain transaction and off-chain storage
     */
    async submitRelease() {
        if (!this.currentTransaction) {
            this.showToast('No transaction to submit', 'error');
            return;
        }

        if (!this.walletManager.isConnected()) {
            this.showToast('Wallet not connected', 'error');
            return;
        }

        this.closeModal();
        this.showLoading(true);

        try {
            // Anchor-auth flow: store event without off-chain signature,
            // then anchor on-chain via transact(). The authenticated blockchain
            // transaction serves as proof of authorship (replaces signMessage
            // which is not supported by WharfKit sessions).

            const sessionInfo = this.walletManager.getSessionInfo();

            console.log('\n=== STEP 1: Store event off-chain (anchor-auth) ===');

            // Store event WITHOUT sig using anchor-auth flow
            console.log('Storing event to off-chain storage (anchor-auth mode)...');
            const storageResult = await api.storeEventForAnchor(
                this.currentTransaction.event,
                sessionInfo.accountName,
                sessionInfo.permission,
                this.currentTransaction.eventHash
            );

            console.log('Storage result:', storageResult);

            // Verify hash matches (should always match since we used server hash)
            if (storageResult.hash !== this.currentTransaction.eventHash) {
                throw new Error(
                    `Hash mismatch: expected ${this.currentTransaction.eventHash}, got ${storageResult.hash}. ` +
                    `This should never happen when using /api/events/prepare.`
                );
            }

            // Extract event_cid from storage result (required for blockchain action)
            const eventCid = storageResult?.stored?.event_cid;
            if (!eventCid) {
                throw new Error(
                    'Missing stored.event_cid from /api/events/create response. ' +
                    'Cannot submit to blockchain without event_cid.'
                );
            }

            // Show storage locations
            const storageInfo = [];
            if (storageResult.stored.canonical_cid) {
                storageInfo.push(`IPFS canonical CID: ${storageResult.stored.canonical_cid}`);
            }
            if (storageResult.stored.event_cid) {
                storageInfo.push(`IPFS full event CID: ${storageResult.stored.event_cid}`);
            }
            if (storageResult.stored.s3) {
                storageInfo.push(`S3: ${storageResult.stored.s3}`);
            }
            if (storageResult.stored.redis) {
                storageInfo.push('Redis: ✓');
            }

            console.log('Event stored:', storageInfo.join(', '));

            console.log('\n=== STEP 2: Build blockchain action with event_cid ===');

            // Build the blockchain action now that we have event_cid
            const action = this.transactionBuilder.buildActionFromHash(
                this.currentTransaction.eventHash,
                this.currentTransaction.authorAccount,
                eventCid
            );

            console.log('\n=== STEP 3: Anchor hash on blockchain ===');

            console.log('Submitting blockchain transaction:', action);

            // Sign and broadcast transaction using WharfKit transact()
            // This is the authoritative proof of authorship (replaces signMessage)
            const txResult = await this.walletManager.transact(action);

            const transactionId = txResult?.resolved?.transaction?.id
                || txResult?.transaction_id || '';

            console.log('Blockchain transaction result:', txResult);

            // Confirm anchor with backend (links stored event to blockchain tx)
            console.log('\n=== STEP 3b: Confirm anchor with backend ===');
            try {
                await api.confirmAnchor({
                    hash: this.currentTransaction.eventHash,
                    event_cid: eventCid,
                    trx_id: transactionId,
                    author_account: sessionInfo.accountName,
                    author_permission: sessionInfo.permission
                });
                console.log('Anchor confirmed with backend');
            } catch (confirmErr) {
                // Non-fatal: tx already succeeded on chain
                console.warn('Anchor confirmation failed (non-fatal):', confirmErr.message);
            }

            // In dev mode, ingest the anchored event directly into Neo4j
            // so the graph updates immediately without needing Substreams
            let ingestResult = null;
            if (INGEST_MODE === 'dev') {
                console.log('\n=== STEP 4: Dev-mode ingestion into graph ===');
                try {
                    const actionData = {
                        author: this.currentTransaction.authorAccount,
                        type: 21,
                        hash: this.currentTransaction.eventHash,
                        event_cid: eventCid,
                        parent: null,
                        ts: Math.floor(Date.now() / 1000),
                        tags: ['release', 'submission'],
                    };

                    const anchoredEvent = {
                        content_hash: this.currentTransaction.eventHash,
                        payload: JSON.stringify(actionData),
                        contract_account: CONTRACT_ACCOUNT,
                        action_name: 'put',
                        trx_id: transactionId,
                        timestamp: Math.floor(Date.now() / 1000),
                        block_num: txResult?.resolved?.transaction?.block_num || 0,
                        block_id: '',
                        action_ordinal: 0,
                        source: 'ui-dev',
                    };
                    ingestResult = await api.ingestAnchoredEvent(anchoredEvent);
                    console.log('Dev-mode ingestion result:', ingestResult);
                } catch (ingestError) {
                    console.error('Dev-mode ingestion failed:', ingestError);
                    // Don't fail the overall submission — tx already succeeded
                    ingestResult = { error: ingestError.message };
                }
            }

            this.showLoading(false);

            // Build ingestion status line for dev mode
            const ingestStatus = INGEST_MODE === 'dev'
                ? (ingestResult?.error
                    ? `\nIngestion: FAILED — ${ingestResult.error}`
                    : '\nIngested into graph: ✓')
                : '';

            // Show success with storage details
            const successMessage = `
                Release submitted successfully!

                Event Hash: ${this.currentTransaction.eventHash.substring(0, 16)}...
                Transaction ID: ${transactionId || 'pending'}

                Stored in:
                ${storageInfo.join('\n')}${ingestStatus}
            `.trim();

            this.showToast(successMessage, 'success');

            console.log('\n=== SUBMISSION COMPLETE ===');
            console.log('Event hash:', this.currentTransaction.eventHash);
            console.log('IPFS canonical CID:', storageResult.stored.canonical_cid);
            console.log('IPFS full event CID:', storageResult.stored.event_cid);
            console.log('S3 location:', storageResult.stored.s3);
            console.log('Blockchain TX:', txResult.resolved?.transaction?.id);

            // Reset form after successful submission
            setTimeout(() => {
                document.getElementById('release-form').reset();
                document.getElementById('labels-container').innerHTML = '';
                document.getElementById('release-groups-container').innerHTML = '';
                document.getElementById('release-guests-container').innerHTML = '';
                document.getElementById('tracks-container').innerHTML = '';
                document.getElementById('release-songwriters-container').innerHTML = '';
                document.getElementById('listen-link-report').innerHTML = '';
                this.formBuilder.counters = { label: 0, track: 0, person: 0, group: 0, role: 0 };
                this.currentTransaction = null;
                this.currentReleaseData = null;
                // Submitted work is no longer unsaved.
                this.formDirty = false;
            }, 5000);

        } catch (error) {
            this.showLoading(false);
            this.showToast('Submission failed: ' + error.message, 'error');
            console.error('Submission error:', error);
        }
    }

    /**
     * Close JSON preview modal
     */
    closeModal() {
        document.getElementById('json-modal').classList.remove('show');
    }

    /**
     * Show/hide loading overlay
     */
    showLoading(show) {
        document.getElementById('loading-overlay').style.display = show ? 'flex' : 'none';
    }

    /**
     * Parse Discogs tracks field (e.g., "3, 5, 6, 8 to 14" or "" for all)
     * @param {string} tracksField - The tracks field from Discogs extraartist
     * @returns {Array<string>} Array of track positions this applies to (or ['*ALL*'] for all tracks)
     */
    parseTracksField(tracksField) {
        if (!tracksField || tracksField.trim() === '') {
            // Empty means all tracks
            return ['*ALL*'];
        }

        const positions = [];
        const parts = tracksField.split(',').map(p => p.trim());

        for (const part of parts) {
            if (part.includes(' to ')) {
                // Range: "8 to 14"
                const [start, end] = part.split(' to ').map(s => s.trim());
                const startNum = parseInt(start);
                const endNum = parseInt(end);
                for (let i = startNum; i <= endNum; i++) {
                    positions.push(String(i));
                }
            } else {
                // Single track: "3"
                positions.push(part);
            }
        }

        return positions;
    }

    /**
     * Show toast notification
     */
    showToast(message, type = 'success') {
        const container = document.getElementById('toast-container');

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;

        container.appendChild(toast);

        setTimeout(() => {
            toast.remove();
        }, 5000);
    }

    /**
     * Fetch release data from Discogs and populate form
     */
    async fetchFromDiscogs() {
        const input = document.getElementById('discogs-input').value.trim();
        const statusDiv = document.getElementById('discogs-status');

        if (!input) {
            this.showDiscogsStatus('Please enter a Discogs release ID or URL', 'error');
            return;
        }

        // Extract release ID or master ID
        const idInfo = discogsClient.extractReleaseId(input);
        if (!idInfo) {
            this.showDiscogsStatus('Invalid Discogs release ID or URL', 'error');
            return;
        }

        try {
            this.showDiscogsStatus(`Fetching ${idInfo.type} ${idInfo.id} from Discogs...`, 'loading');

            // Fetch release data (handles both release and master)
            const releaseData = idInfo.type === 'master'
                ? await discogsClient.fetchMaster(idInfo.id)
                : await discogsClient.fetchRelease(idInfo.id);

            // Populate form
            await this.populateFormFromDiscogs(releaseData);

            this.showDiscogsStatus(`✓ Successfully imported: ${releaseData.title}`, 'success');
            this.showToast(`Imported from Discogs: ${releaseData.title}`, 'success');

        } catch (error) {
            console.error('Discogs fetch error:', error);
            this.showDiscogsStatus(`Error: ${error.message}`, 'error');
            this.showToast('Failed to fetch from Discogs: ' + error.message, 'error');
        }
    }

    /**
     * Populate form fields from Discogs release data
     */
    async populateFormFromDiscogs(discogsRelease) {
        console.log('Populating form from Discogs data:', discogsRelease);

        // Clear existing dynamic fields
        document.getElementById('labels-container').innerHTML = '';
        document.getElementById('release-groups-container').innerHTML = '';
        document.getElementById('release-guests-container').innerHTML = '';
        document.getElementById('tracks-container').innerHTML = '';
        this.formBuilder.counters = { label: 0, track: 0, person: 0, group: 0, role: 0 };

        // Populate basic release info
        document.getElementById('release-name').value = discogsRelease.title || '';

        // Handle flexible date formats (YYYY, YYYY/MM, or YYYY/MM/DD)
        let releaseDate = '';
        if (discogsRelease.released) {
            // Discogs may provide YYYY-MM-DD or just YYYY
            // Convert to YYYY/MM/DD format or keep as-is if just year
            releaseDate = discogsRelease.released.replace(/-/g, '/');
        } else if (discogsRelease.year) {
            // If only year available, just use the year
            releaseDate = String(discogsRelease.year);
        }
        document.getElementById('release-date').value = releaseDate;

        document.getElementById('liner-notes').value = discogsRelease.notes || '';

        // Set format
        if (discogsRelease.formats && discogsRelease.formats.length > 0) {
            const format = discogsRelease.formats[0].name;
            const formatSelect = document.getElementById('release-format');
            // Try to match format
            const formatMap = {
                'Vinyl': 'LP',
                'CD': 'CD',
                'Cassette': 'Cassette',
                'Digital': 'Digital'
            };
            formatSelect.value = formatMap[format] || 'Other';
        }

        // Add ALL labels (not just first one)
        if (discogsRelease.labels && discogsRelease.labels.length > 0) {
            for (const label of discogsRelease.labels) {
                const labelForm = this.formBuilder.createLabelForm();
                document.getElementById('labels-container').appendChild(labelForm);

                // Populate label name
                const labelIndex = this.formBuilder.counters.label - 1;
                const labelNameInput = labelForm.querySelector(`input[name="label-name-${labelIndex}"]`);
                if (labelNameInput) {
                    labelNameInput.value = label.name || '';
                }
            }
        }

        // ===== EXTRACT PERFORMERS FROM EXTRAARTISTS =====
        // Separate performance roles from production/technical roles
        const performanceRoleKeywords = ['performer', 'drums', 'guitar', 'bass', 'vocals', 'keyboards',
                                         'piano', 'percussion', 'synthesizer', 'organ', 'harmonica',
                                         'saxophone', 'trumpet', 'violin', 'cello', 'flute'];

        const isPerformanceRole = (role) => {
            const roleLower = (role || '').toLowerCase();
            return performanceRoleKeywords.some(keyword => roleLower.includes(keyword));
        };

        const performers = [];
        const performerIds = new Set();

        if (discogsRelease.extraartists && discogsRelease.extraartists.length > 0) {
            // First pass: identify all performers and collect their IDs
            for (const extraArtist of discogsRelease.extraartists) {
                if (extraArtist.role && extraArtist.role.toLowerCase().includes('performer')) {
                    performerIds.add(extraArtist.id);
                }
            }

            // Second pass: for each performer, collect ONLY performance roles (instruments, vocals)
            for (const performerId of performerIds) {
                const performerEntries = discogsRelease.extraartists.filter(ea => ea.id === performerId);

                if (performerEntries.length > 0) {
                    const cleanName = performerEntries[0].name.replace(/\s*\(\d+\)$/, '');

                    // Collect ONLY performance-related roles (instruments, vocals, etc.)
                    const performanceRoles = [];
                    for (const entry of performerEntries) {
                        const role = entry.role || '';
                        // Only include performance roles, skip production/technical roles
                        if (isPerformanceRole(role) && role !== 'Performer') {
                            performanceRoles.push(role);
                        }
                    }

                    // Use specific performance roles if available, otherwise use generic "Performer"
                    const finalRole = performanceRoles.length > 0 ? performanceRoles.join(', ') : 'Performer';

                    performers.push({
                        name: cleanName,
                        id: performerId,
                        role: finalRole
                    });
                }
            }
        }

        console.log('Found performers with performance roles:', performers);

        // ===== RELEASE-LEVEL GROUPS =====
        // Add main performing groups to release-level groups section
        const releaseGroupsContainer = document.getElementById('release-groups-container');
        const mainGroups = [];

        if (discogsRelease.artists && discogsRelease.artists.length > 0) {
            for (let i = 0; i < discogsRelease.artists.length; i++) {
                const artist = discogsRelease.artists[i];
                const cleanName = artist.name.replace(/\s*\(\d+\)$/, ''); // Remove Discogs numbering

                // Add to release groups container
                const groupForm = this.formBuilder.createReleaseGroupForm(i);
                releaseGroupsContainer.appendChild(groupForm);

                // Populate group name
                const groupNameInput = groupForm.querySelector(`input[name="release-group-name-${i}"]`);
                if (groupNameInput) {
                    groupNameInput.value = cleanName;
                }

                mainGroups.push({
                    name: cleanName,
                    id: artist.id,
                    index: i,
                    members: performers  // Store performers as group members
                });
            }
        }

        // ===== EXTRACT RELEASE-LEVEL SONGWRITERS =====
        // Parse release-level "Written-By" credits and their track assignments
        const releaseSongwriters = new Map(); // Map of track position -> songwriter names

        if (discogsRelease.extraartists && discogsRelease.extraartists.length > 0) {
            for (const extraArtist of discogsRelease.extraartists) {
                const role = extraArtist.role || '';
                if (role.toLowerCase().includes('written') || role.toLowerCase().includes('composer')) {
                    const cleanName = extraArtist.name.replace(/\s*\(\d+\)$/, '');
                    const tracksField = extraArtist.tracks || '';

                    // Parse tracks field: "" = all tracks, "3, 5, 6, 8 to 14" = specific tracks
                    const trackPositions = this.parseTracksField(tracksField);

                    for (const position of trackPositions) {
                        if (!releaseSongwriters.has(position)) {
                            releaseSongwriters.set(position, []);
                        }
                        releaseSongwriters.get(position).push(cleanName);
                    }
                }
            }
        }

        console.log('Release-level songwriters by track:', releaseSongwriters);

        // ===== TRACKS =====
        // Add tracks with all data (groups will be auto-populated after tracks are created)
        if (discogsRelease.tracklist && discogsRelease.tracklist.length > 0) {
            for (const discogsTrack of discogsRelease.tracklist) {
                // Skip if not a regular track (e.g., heading)
                if (discogsTrack.type_ && discogsTrack.type_ !== 'track') {
                    continue;
                }

                const trackForm = this.formBuilder.createTrackForm();
                document.getElementById('tracks-container').appendChild(trackForm);

                const trackIndex = this.formBuilder.counters.track - 1;

                // ===== BASIC TRACK INFO =====
                // Track title (FIXED: was song-name, should be track-title)
                const trackTitleInput = trackForm.querySelector(`input[name="track-title-${trackIndex}"]`);
                if (trackTitleInput) {
                    trackTitleInput.value = discogsTrack.title || '';
                }

                // Track number - parse from position (may be like "A1", "1", etc.)
                const trackNumberInput = trackForm.querySelector(`input[name="track-number-${trackIndex}"]`);
                if (trackNumberInput && discogsTrack.position) {
                    // Extract numeric part from position (e.g., "A1" -> "1", "12" -> "12")
                    const numMatch = discogsTrack.position.match(/\d+/);
                    if (numMatch) {
                        trackNumberInput.value = numMatch[0];
                    }
                }

                // ===== SONGWRITERS =====
                // Merge release-level and track-level songwriters
                const trackLevelSongwriters = discogsClient.extractSongwriters(discogsTrack);
                const releaseLevelForThisTrack = releaseSongwriters.get(discogsTrack.position) || [];
                const allTrackSongwriters = releaseSongwriters.get('*ALL*') || [];

                // Combine all songwriters, removing duplicates
                const allSongwriters = new Set([
                    ...allTrackSongwriters,      // Release-level (all tracks)
                    ...releaseLevelForThisTrack, // Release-level (this track)
                    ...trackLevelSongwriters     // Track-level (co-writers)
                ]);

                const songwritersContainer = trackForm.querySelector('.songwriters-container');
                if (songwritersContainer && allSongwriters.size > 0) {
                    Array.from(allSongwriters).forEach((songwriter, idx) => {
                        const songwriterForm = this.formBuilder.createPersonForm(idx, 'songwriter', trackIndex);
                        songwritersContainer.appendChild(songwriterForm);

                        // Populate songwriter name
                        const songwriterNameInput = songwriterForm.querySelector(`input[name="songwriter-name-${trackIndex}-${idx}"]`);
                        if (songwriterNameInput) {
                            songwriterNameInput.value = songwriter;
                        }
                    });
                }
            }
        }

        // Parse release-level extra artists (producers, engineers, etc.)
        const releaseGuestsContainer = document.getElementById('release-guests-container');
        let guestIndex = 0;

        if (discogsRelease.extraartists && discogsRelease.extraartists.length > 0) {
            const credits = discogsClient.parseCredits(discogsRelease.extraartists, performerIds);

            // Add producers
            for (const producer of credits.producers) {
                const guestForm = this.formBuilder.createReleaseGuestForm(guestIndex++);
                releaseGuestsContainer.appendChild(guestForm);

                const guestNameInput = guestForm.querySelector(`input[name="release-guest-name-${guestIndex - 1}"]`);
                const guestRolesInput = guestForm.querySelector(`input[name="release-guest-roles-${guestIndex - 1}"]`);

                if (guestNameInput) {
                    guestNameInput.value = producer.name;
                }
                if (guestRolesInput) {
                    guestRolesInput.value = 'Producer';
                }
            }

            // Add engineers
            for (const engineer of credits.engineers) {
                const guestForm = this.formBuilder.createReleaseGuestForm(guestIndex++);
                releaseGuestsContainer.appendChild(guestForm);

                const guestNameInput = guestForm.querySelector(`input[name="release-guest-name-${guestIndex - 1}"]`);
                const guestRolesInput = guestForm.querySelector(`input[name="release-guest-roles-${guestIndex - 1}"]`);

                if (guestNameInput) {
                    guestNameInput.value = engineer.name;
                }
                if (guestRolesInput) {
                    guestRolesInput.value = engineer.role || 'Engineer';
                }
            }

            // Add mixing engineers
            for (const mixer of credits.mixedBy) {
                const guestForm = this.formBuilder.createReleaseGuestForm(guestIndex++);
                releaseGuestsContainer.appendChild(guestForm);

                const guestNameInput = guestForm.querySelector(`input[name="release-guest-name-${guestIndex - 1}"]`);
                const guestRolesInput = guestForm.querySelector(`input[name="release-guest-roles-${guestIndex - 1}"]`);

                if (guestNameInput) {
                    guestNameInput.value = mixer.name;
                }
                if (guestRolesInput) {
                    guestRolesInput.value = 'Mix Engineer';
                }
            }

            // Add mastering engineers
            for (const masterer of credits.masteredBy) {
                const guestForm = this.formBuilder.createReleaseGuestForm(guestIndex++);
                releaseGuestsContainer.appendChild(guestForm);

                const guestNameInput = guestForm.querySelector(`input[name="release-guest-name-${guestIndex - 1}"]`);
                const guestRolesInput = guestForm.querySelector(`input[name="release-guest-roles-${guestIndex - 1}"]`);

                if (guestNameInput) {
                    guestNameInput.value = masterer.name;
                }
                if (guestRolesInput) {
                    guestRolesInput.value = 'Mastering Engineer';
                }
            }

            // Add guest performers from release-level credits
            for (const guest of credits.guests) {
                const guestForm = this.formBuilder.createReleaseGuestForm(guestIndex++);
                releaseGuestsContainer.appendChild(guestForm);

                const guestNameInput = guestForm.querySelector(`input[name="release-guest-name-${guestIndex - 1}"]`);
                const guestRolesInput = guestForm.querySelector(`input[name="release-guest-roles-${guestIndex - 1}"]`);

                if (guestNameInput) {
                    guestNameInput.value = guest.name;
                }
                if (guestRolesInput) {
                    guestRolesInput.value = guest.role || 'Guest Performer';
                }
            }
        }

        // Extract recording location from companies (entity_type "23" is "Recorded At")
        if (discogsRelease.companies && discogsRelease.companies.length > 0) {
            for (const company of discogsRelease.companies) {
                if (company.entity_type === '23' || company.entity_type_name === 'Recorded At') {
                    const locationInput = document.getElementById('recording-location');
                    if (locationInput) {
                        // Append if there are multiple recording locations
                        const currentValue = locationInput.value;
                        const newValue = company.name;
                        locationInput.value = currentValue
                            ? `${currentValue}, ${newValue}`
                            : newValue;
                    }
                }
            }
        }

        // Add source link
        const sourceLink = `https://www.discogs.com/release/${discogsRelease.id}`;
        document.getElementById('source-links').value = sourceLink;

        console.log('Form populated successfully');
        console.log(`Added: ${mainGroups.length} groups, ${guestIndex} release guests`);

        // An import is unsaved work like any other.
        this.formDirty = true;

        // Attach registry ids to the names Discogs supplied. Deferred a tick so
        // the lookup manager's observer (50ms debounce) has bound the rows this
        // import just created — without instances there is nothing to bind to.
        setTimeout(() => {
            this.reconcileImportedFields().catch(error =>
                console.warn('Reconciliation pass failed:', error));
        }, 150);
    }

    /**
     * Show Discogs import status message
     */
    showDiscogsStatus(message, type = 'success') {
        const statusDiv = document.getElementById('discogs-status');
        statusDiv.textContent = message;
        statusDiv.className = `import-status ${type} show`;
    }
}

// Initialize app when DOM is ready.
// Exposed on window so the e2e suite can call buildReleaseData() and assert on
// the bundle directly; there is no other way to check what a form submission
// would actually contain without signing a real transaction.
document.addEventListener('DOMContentLoaded', () => {
    window.polarisApp = new PolarisApp();
});
