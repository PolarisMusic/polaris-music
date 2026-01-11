/**
 * Polaris Music Registry - Frontend
 * Main entry point for the release submission form
 */

import { FormBuilder } from './components/FormBuilder.js';
import { HashGenerator } from './utils/hashGenerator.js';
import { api } from './utils/api.js';
import { WalletManager } from './wallet/WalletManager.js';
import { TransactionBuilder } from './utils/transactionBuilder.js';
import { discogsClient } from './utils/discogsClient.js';

class PolarisApp {
    constructor() {
        this.formBuilder = new FormBuilder();
        this.currentReleaseData = null;
        this.currentTransaction = null;

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
                    const confirmed = confirm('Are you sure you want to navigate away from this page? Any unsaved changes will be lost.');
                    if (confirmed) {
                        window.location.href = '/visualization.html';
                    }
                    return;
                }

                this.switchTab(tabName);
            });
        });

        // Initialize form handlers
        this.initializeForm();

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

            // Auto-populate this group to all existing tracks
            this.addReleaseGroupToAllTracks(index);
        });

        // Add release guest button
        document.getElementById('add-release-guest').addEventListener('click', () => {
            const container = document.getElementById('release-guests-container');
            const index = container.children.length;
            container.appendChild(this.formBuilder.createReleaseGuestForm(index));
        });

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
     * Extract form data and build release bundle
     */
    buildReleaseData() {
        const form = document.getElementById('release-form');
        const formData = new FormData(form);

        // Release metadata
        const release = {
            release_name: formData.get('release_name'),
            release_altnames: this.parseCommaSeparated(formData.get('release_altnames')),
            release_date: formData.get('release_date'),
            release_format: [formData.get('release_format')],
            liner_notes: formData.get('liner_notes') || '',
            master_release: [
                document.getElementById('is-master').checked,
                formData.get('master_release_id') || null
            ],
            labels: this.extractLabels(),
            release_guests: this.extractReleaseGuests(),
            tracks: this.extractTracks(),
        };

        // Proofs object (source attribution)
        const proofs = {
            source_links: this.parseCommaSeparated(formData.get('source_links'))
        };

        // Build tracklist from tracks
        const tracklist = release.tracks.map((track, index) => ({
            track_id: track.track_id,
            disc_side: track.disc_side || 1,
            track_number: track.track_number || index + 1,
        }));

        return {
            release,
            tracklist,
            proofs,
        };
    }

    /**
     * Extract labels from form
     */
    extractLabels() {
        const labels = [];
        const labelItems = document.querySelectorAll('[data-type="label"]');

        labelItems.forEach(item => {
            const index = item.dataset.index;
            const labelName = this.getInputValue(item, `label-name-${index}`);
            const cityName = this.getInputValue(item, `label-city-name-${index}`);
            const lat = this.getInputValue(item, `label-city-lat-${index}`);
            const lon = this.getInputValue(item, `label-city-lon-${index}`);

            if (!labelName || !cityName) return;

            const cityId = HashGenerator.generateCityId(cityName, lat, lon);
            const labelId = HashGenerator.generateLabelId(labelName, cityId);

            labels.push({
                label_id: labelId,
                label_name: labelName,
                label_altnames: this.parseCommaSeparated(this.getInputValue(item, `label-altnames-${index}`)),
                label_parents: this.getInputValue(item, `label-parent-${index}`) || '',
                label_city: [{
                    city_id: cityId,
                    city_name: cityName,
                    city_lat: parseFloat(lat) || 0,
                    city_lon: parseFloat(lon) || 0,
                }],
            });
        });

        return labels;
    }

    /**
     * Extract release-level guests from form
     */
    extractReleaseGuests() {
        const guests = [];
        const guestItems = document.querySelectorAll('[data-type="release-guest"]');

        guestItems.forEach(item => {
            const index = item.dataset.index;
            const name = this.getInputValue(item, `release-guest-name-${index}`);

            if (!name) return;

            const cityName = this.getInputValue(item, `release-guest-city-name-${index}`);
            const lat = this.getInputValue(item, `release-guest-city-lat-${index}`);
            const lon = this.getInputValue(item, `release-guest-city-lon-${index}`);

            let cityData = null;
            if (cityName) {
                const cityId = HashGenerator.generateCityId(cityName, lat, lon);
                cityData = {
                    city_id: cityId,
                    city_name: cityName,
                    city_lat: parseFloat(lat) || 0,
                    city_lon: parseFloat(lon) || 0,
                };
            }

            const personId = HashGenerator.generatePersonId(name, cityData?.city_id);
            const rolesStr = this.getInputValue(item, `release-guest-roles-${index}`);
            const roles = this.parseRoles(rolesStr);

            guests.push({
                person_id: personId,
                person_name: name,
                person_roles: roles,
                person_city: cityData,
            });
        });

        return guests;
    }

    /**
     * Extract tracks from form
     */
    extractTracks() {
        const tracks = [];
        const trackItems = document.querySelectorAll('.track-item');

        trackItems.forEach((item, trackIndex) => {
            const index = item.dataset.index;
            const title = this.getInputValue(item, `track-title-${index}`);

            if (!title) return;

            const groupName = this.getFirstGroupName(item);
            const trackId = HashGenerator.generateTrackId(title, groupName);

            tracks.push({
                track_id: trackId,
                title: title,
                listen_link: this.parseCommaSeparated(this.getInputValue(item, `track-listen-link-${index}`)),
                cover_song: this.parseCommaSeparated(this.getInputValue(item, `track-cover-${index}`)),
                sampled_songs: this.parseCommaSeparated(this.getInputValue(item, `track-samples-${index}`)),
                songwriters: this.extractPersons(item, 'songwriter', index),
                producers: this.extractPersons(item, 'producer', index),
                groups: this.extractGroups(item, index),
                guests: this.extractPersons(item, 'guest', index),
                disc_side: parseInt(this.getInputValue(item, `track-disc-${index}`) || 1),
                track_number: parseInt(this.getInputValue(item, `track-number-${index}`) || trackIndex + 1),
            });
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
     * Extract a single person's data
     */
    extractPersonData(item, type, parentIndex) {
        const index = item.dataset.index;
        const name = this.getInputValue(item, `${type}-name-${parentIndex}-${index}`);

        if (!name) return null;

        const cityName = this.getInputValue(item, `${type}-city-name-${parentIndex}-${index}`);
        const lat = this.getInputValue(item, `${type}-city-lat-${parentIndex}-${index}`);
        const lon = this.getInputValue(item, `${type}-city-lon-${parentIndex}-${index}`);

        let cityData = null;
        if (cityName) {
            const cityId = HashGenerator.generateCityId(cityName, lat, lon);
            cityData = {
                city_id: cityId,
                city_name: cityName,
                city_lat: parseFloat(lat) || 0,
                city_lon: parseFloat(lon) || 0,
            };
        }

        const personId = HashGenerator.generatePersonId(name, cityData?.city_id);
        const rolesStr = this.getInputValue(item, `${type}-roles-${parentIndex}-${index}`);
        const roles = this.parseRoles(rolesStr);

        return {
            person_id: personId,
            person_name: name,
            person_roles: roles,
            person_city: cityData,
        };
    }

    /**
     * Extract groups and their members from track
     */
    extractGroups(trackItem, trackIndex) {
        const groups = [];
        const groupItems = trackItem.querySelectorAll('[data-type="group"]');

        groupItems.forEach(item => {
            const groupIndex = item.dataset.index;
            const groupName = this.getInputValue(item, `group-name-${trackIndex}-${groupIndex}`);

            if (!groupName) return;

            const groupId = HashGenerator.generateGroupId(groupName);

            // Extract members
            const members = [];
            const memberItems = item.querySelectorAll('[data-type="member"]');

            memberItems.forEach(memberItem => {
                const memberData = this.extractPersonData(memberItem, 'member', `${trackIndex}-${groupIndex}`);
                if (memberData) members.push(memberData);
            });

            groups.push({
                group_id: groupId,
                group_name: groupName,
                group_altnames: this.getInputValue(item, `group-altnames-${trackIndex}-${groupIndex}`) || '',
                members: members,
            });
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
     * Parse roles string into role objects
     */
    parseRoles(rolesStr) {
        if (!rolesStr) return [];

        return this.parseCommaSeparated(rolesStr).map(roleName => ({
            role_id: HashGenerator.generateRoleId(roleName),
            role_name: roleName,
        }));
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
                sessionInfo.accountName, // Will be replaced with actual pubkey from session
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
            console.log('=== STEP 0: Sign event with wallet ===');

            // Sign the event hash with wallet private key
            console.log('Signing event hash:', this.currentTransaction.eventHash);
            const signature = await this.walletManager.signMessage(this.currentTransaction.eventHash);
            console.log('Signature:', signature);

            // Create signed event
            const eventWithSig = {
                ...this.currentTransaction.event,
                sig: signature
            };

            console.log('\n=== STEP 1: Store event off-chain ===');

            // Store event to IPFS + S3 + Redis
            // Pass expected hash from /api/events/prepare for verification
            console.log('Storing signed event to off-chain storage...');
            const storageResult = await api.storeEvent(eventWithSig, this.currentTransaction.eventHash);

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

            // Sign and broadcast transaction using WharfKit
            const txResult = await this.walletManager.transact(action);

            console.log('Blockchain transaction result:', txResult);

            this.showLoading(false);

            // Show success with storage details
            const successMessage = `
                Release submitted successfully!

                Event Hash: ${this.currentTransaction.eventHash.substring(0, 16)}...
                Transaction ID: ${txResult.resolved?.transaction?.id || 'pending'}

                Stored in:
                ${storageInfo.join('\n')}
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
                document.getElementById('release-guests-container').innerHTML = '';
                document.getElementById('tracks-container').innerHTML = '';
                this.formBuilder.counters = { label: 0, track: 0, person: 0, group: 0, role: 0 };
                this.currentTransaction = null;
                this.currentReleaseData = null;
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
     * Add a release-level group to all existing tracks
     * @param {number} releaseGroupIndex - Index of the release group
     * @param {Array} members - Optional array of group members to add
     */
    addReleaseGroupToAllTracks(releaseGroupIndex, members = []) {
        const tracksContainer = document.getElementById('tracks-container');
        const trackItems = tracksContainer.querySelectorAll('.track-item');

        // Get the group name from the release-level group form
        const releaseGroupForm = document.querySelector(`.release-group-item[data-index="${releaseGroupIndex}"]`);
        if (!releaseGroupForm) return;

        const groupNameInput = releaseGroupForm.querySelector(`input[name="release-group-name-${releaseGroupIndex}"]`);
        const groupName = groupNameInput ? groupNameInput.value : '';

        // Add this group to each track
        trackItems.forEach((trackItem) => {
            const trackIndex = parseInt(trackItem.dataset.index);
            const groupsContainer = trackItem.querySelector('.groups-container');
            if (!groupsContainer) return;

            // Get the next group index for this track
            const existingGroups = groupsContainer.querySelectorAll('.nested-item');
            const groupIndex = existingGroups.length;

            // Create and add the group form
            const groupForm = this.formBuilder.createGroupForm(trackIndex, groupIndex);
            groupsContainer.appendChild(groupForm);

            // Populate the group name
            const trackGroupNameInput = groupForm.querySelector(`input[name="group-name-${trackIndex}-${groupIndex}"]`);
            if (trackGroupNameInput && groupName) {
                trackGroupNameInput.value = groupName;
            }

            // Add members if provided
            if (members && members.length > 0) {
                const membersContainer = groupForm.querySelector('.members-container');
                if (membersContainer) {
                    members.forEach((member, memberIndex) => {
                        const memberForm = this.formBuilder.createPersonForm(memberIndex, 'member', `${trackIndex}-${groupIndex}`);
                        membersContainer.appendChild(memberForm);

                        // Populate member name
                        const memberNameInput = memberForm.querySelector(`input[name="member-name-${trackIndex}-${groupIndex}-${memberIndex}"]`);
                        if (memberNameInput) {
                            memberNameInput.value = member.name;
                        }

                        // Populate member role if available
                        const memberRolesInput = memberForm.querySelector(`input[name="member-roles-${trackIndex}-${groupIndex}-${memberIndex}"]`);
                        if (memberRolesInput && member.role) {
                            memberRolesInput.value = member.role;
                        }
                    });
                }
            }
        });
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

        // ===== AUTO-POPULATE RELEASE GROUPS TO TRACKS =====
        // After all tracks are created, add release groups to each track
        for (const group of mainGroups) {
            this.addReleaseGroupToAllTracks(group.index, group.members);
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

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new PolarisApp();
});
