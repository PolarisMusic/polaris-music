/**
 * Polaris Music Registry - Frontend
 * Main entry point for the release submission form
 */

import { FormBuilder } from './components/FormBuilder.js';
import { HashGenerator } from './utils/hashGenerator.js';
import { api } from './utils/api.js';

class PolarisApp {
    constructor() {
        this.formBuilder = new FormBuilder();
        this.currentReleaseData = null;

        this.init();
    }

    init() {
        // Tab navigation
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                const tabName = e.target.dataset.tab;
                this.switchTab(tabName);
            });
        });

        // Initialize form handlers
        this.initializeForm();

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
    previewJSON() {
        try {
            const releaseData = this.buildReleaseData();
            this.currentReleaseData = releaseData;

            const jsonPreview = document.getElementById('json-preview');
            jsonPreview.textContent = JSON.stringify(releaseData, null, 2);

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
     * Submit release to backend
     */
    async submitRelease() {
        if (!this.currentReleaseData) {
            this.showToast('No release data to submit', 'error');
            return;
        }

        this.closeModal();
        this.showLoading(true);

        try {
            const result = await api.submitRelease(this.currentReleaseData);

            this.showLoading(false);
            this.showToast('Release submitted successfully!', 'success');

            console.log('Submission result:', result);

            // Reset form after successful submission
            setTimeout(() => {
                document.getElementById('release-form').reset();
                document.getElementById('labels-container').innerHTML = '';
                document.getElementById('tracks-container').innerHTML = '';
                this.formBuilder.counters = { label: 0, track: 0, person: 0, group: 0, role: 0 };
            }, 2000);

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
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new PolarisApp();
});
