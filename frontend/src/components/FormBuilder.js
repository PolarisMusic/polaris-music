/**
 * Form Builder - Dynamic form generation for nested structures
 * Handles creating and managing complex nested forms for tracks, labels, members, etc.
 */

import { HashGenerator } from '../utils/hashGenerator.js';

export class FormBuilder {
    constructor() {
        this.counters = {
            label: 0,
            track: 0,
            person: 0,
            group: 0,
            role: 0,
        };
    }

    /**
     * Create a label form group
     */
    createLabelForm(index = null) {
        if (index === null) {
            index = this.counters.label++;
        }

        const div = document.createElement('div');
        div.className = 'nested-item';
        div.dataset.type = 'label';
        div.dataset.index = index;

        div.innerHTML = `
            <div class="nested-item-header">
                <span class="nested-item-title">Label ${index + 1}</span>
                <button type="button" class="btn-remove remove-label">Remove</button>
            </div>

            <div class="form-group">
                <label>Label Name *</label>
                <input type="text" name="label-name-${index}" required placeholder="Apple Records">
                <small>UNIMPLEMENTED: Add autocomplete search for existing labels</small>
            </div>

            <div class="form-group">
                <label>Alternative Names</label>
                <input type="text" name="label-altnames-${index}" placeholder="Apple Corps (comma-separated)">
            </div>

            <div class="form-group">
                <label>Parent Label (if subsidiary)</label>
                <input type="text" name="label-parent-${index}" placeholder="EMI Records">
                <small>UNIMPLEMENTED: Add search for parent label</small>
            </div>

            <div class="subsection">
                <h4>Label City</h4>
                <div class="form-row">
                    <div class="form-group">
                        <label>City Name</label>
                        <input type="text" name="label-city-name-${index}" placeholder="London">
                        <small>UNIMPLEMENTED: Add autocomplete for cities</small>
                    </div>
                    <div class="form-row">
                        <div class="form-group">
                            <label>Latitude</label>
                            <input type="number" step="0.00001" name="label-city-lat-${index}" placeholder="51.50735">
                        </div>
                        <div class="form-group">
                            <label>Longitude</label>
                            <input type="number" step="0.00001" name="label-city-lon-${index}" placeholder="-0.12776">
                        </div>
                    </div>
                </div>
            </div>
        `;

        // Add remove handler
        div.querySelector('.remove-label').addEventListener('click', () => {
            div.remove();
        });

        return div;
    }

    /**
     * Create a person form group (for songwriters, producers, members, guests)
     */
    createPersonForm(index, type = 'person', parentIndex = 0) {
        const div = document.createElement('div');
        div.className = 'nested-item';
        div.dataset.type = type;
        div.dataset.index = index;

        const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);

        div.innerHTML = `
            <div class="nested-item-header">
                <span class="nested-item-title">${typeLabel} ${index + 1}</span>
                <button type="button" class="btn-remove remove-person">Remove</button>
            </div>

            <div class="form-group">
                <label>Name *</label>
                <input type="text" name="${type}-name-${parentIndex}-${index}" required placeholder="Paul McCartney">
                <small>UNIMPLEMENTED: Add autocomplete search for existing persons</small>
            </div>

            <div class="form-group">
                <label>Roles *</label>
                <div class="roles-container" data-person="${type}-${parentIndex}-${index}">
                    <input type="text" name="${type}-roles-${parentIndex}-${index}"
                           placeholder="Add roles (comma-separated): Lead Vocals, Bass Guitar">
                    <small>Separate multiple roles with commas. UNIMPLEMENTED: Add role autocomplete/chips</small>
                </div>
            </div>

            <div class="subsection">
                <h4>City</h4>
                <div class="form-row">
                    <div class="form-group">
                        <label>City Name</label>
                        <input type="text" name="${type}-city-name-${parentIndex}-${index}" placeholder="London">
                    </div>
                    <div class="form-row">
                        <div class="form-group">
                            <label>Latitude</label>
                            <input type="number" step="0.00001" name="${type}-city-lat-${parentIndex}-${index}" placeholder="51.50735">
                        </div>
                        <div class="form-group">
                            <label>Longitude</label>
                            <input type="number" step="0.00001" name="${type}-city-lon-${parentIndex}-${index}" placeholder="-0.12776">
                        </div>
                    </div>
                </div>
            </div>
        `;

        div.querySelector('.remove-person').addEventListener('click', () => {
            div.remove();
        });

        return div;
    }

    /**
     * Create a group form (for track performers)
     */
    createGroupForm(trackIndex, groupIndex) {
        const div = document.createElement('div');
        div.className = 'nested-item';
        div.dataset.type = 'group';
        div.dataset.index = groupIndex;

        div.innerHTML = `
            <div class="nested-item-header">
                <span class="nested-item-title">Group ${groupIndex + 1}</span>
                <button type="button" class="btn-remove remove-group">Remove</button>
            </div>

            <div class="form-group">
                <label>Group Name *</label>
                <input type="text" name="group-name-${trackIndex}-${groupIndex}" required placeholder="The Beatles">
                <small>UNIMPLEMENTED: Add autocomplete search for existing groups</small>
            </div>

            <div class="form-group">
                <label>Alternative Names</label>
                <input type="text" name="group-altnames-${trackIndex}-${groupIndex}" placeholder="The Fab Four">
            </div>

            <div class="subsection">
                <h4>Group Members on This Track</h4>
                <div class="members-container" data-track="${trackIndex}" data-group="${groupIndex}"></div>
                <button type="button" class="btn-add add-member" data-track="${trackIndex}" data-group="${groupIndex}">
                    + Add Member
                </button>
            </div>
        `;

        // Add member button handler
        const addMemberBtn = div.querySelector('.add-member');
        addMemberBtn.addEventListener('click', () => {
            const container = div.querySelector('.members-container');
            const memberIndex = container.children.length;
            const memberForm = this.createPersonForm(memberIndex, 'member', `${trackIndex}-${groupIndex}`);
            container.appendChild(memberForm);
        });

        // Remove group handler
        div.querySelector('.remove-group').addEventListener('click', () => {
            div.remove();
        });

        return div;
    }

    /**
     * Create a release guest form (for release-level personnel)
     */
    createReleaseGuestForm(index) {
        const div = document.createElement('div');
        div.className = 'nested-item';
        div.dataset.type = 'release-guest';
        div.dataset.index = index;

        div.innerHTML = `
            <div class="nested-item-header">
                <span class="nested-item-title">Release Guest ${index + 1}</span>
                <button type="button" class="btn-remove remove-release-guest">Remove</button>
            </div>

            <div class="form-group">
                <label>Name *</label>
                <input type="text" name="release-guest-name-${index}" required placeholder="George Martin">
                <small>UNIMPLEMENTED: Add autocomplete search for existing persons</small>
            </div>

            <div class="form-group">
                <label>Roles *</label>
                <div class="roles-container" data-person="release-guest-${index}">
                    <input type="text" name="release-guest-roles-${index}"
                           placeholder="Add roles (comma-separated): Mastering Engineer, Producer">
                    <small>Separate multiple roles with commas. UNIMPLEMENTED: Add role autocomplete/chips</small>
                </div>
            </div>

            <div class="subsection">
                <h4>City</h4>
                <div class="form-row">
                    <div class="form-group">
                        <label>City Name</label>
                        <input type="text" name="release-guest-city-name-${index}" placeholder="London">
                    </div>
                    <div class="form-row">
                        <div class="form-group">
                            <label>Latitude</label>
                            <input type="number" step="0.00001" name="release-guest-city-lat-${index}" placeholder="51.50735">
                        </div>
                        <div class="form-group">
                            <label>Longitude</label>
                            <input type="number" step="0.00001" name="release-guest-city-lon-${index}" placeholder="-0.12776">
                        </div>
                    </div>
                </div>
            </div>
        `;

        div.querySelector('.remove-release-guest').addEventListener('click', () => {
            div.remove();
        });

        return div;
    }

    /**
     * Create a release-level group form (groups performing on the entire release)
     * Includes a members subsection for specifying the group roster.
     */
    createReleaseGroupForm(index) {
        const div = document.createElement('div');
        div.className = 'nested-item release-group-item';
        div.dataset.type = 'release-group';
        div.dataset.index = index;

        div.innerHTML = `
            <div class="nested-item-header">
                <span class="nested-item-title">Release Group ${index + 1}</span>
                <button type="button" class="btn-remove remove-release-group">Remove</button>
            </div>

            <div class="form-group">
                <label>Group Name *</label>
                <input type="text" name="release-group-name-${index}" required placeholder="The Beatles" data-group-index="${index}">
                <small>This group will be added to all tracks. You can remove it from individual tracks if needed.</small>
            </div>

            <div class="form-group">
                <label>Alternative Names</label>
                <input type="text" name="release-group-altnames-${index}" placeholder="The Fab Four">
            </div>

            <div class="subsection">
                <h4>Members (Release-Level Roster)</h4>
                <p class="section-note">Add the members of this group for this release. Track-level overrides can be made per-track if needed.</p>
                <div class="release-members-container" data-release-group="${index}"></div>
                <button type="button" class="btn-add add-release-member" data-release-group="${index}">+ Add Member</button>
            </div>
        `;

        // Add member button handler
        const addMemberBtn = div.querySelector('.add-release-member');
        addMemberBtn.addEventListener('click', () => {
            const container = div.querySelector('.release-members-container');
            const memberIndex = container.children.length;
            const memberForm = this.createPersonForm(memberIndex, 'release-member', index);
            container.appendChild(memberForm);
        });

        div.querySelector('.remove-release-group').addEventListener('click', () => {
            div.remove();
        });

        return div;
    }

    /**
     * Create a complete track form
     */
    createTrackForm(index = null) {
        if (index === null) {
            index = this.counters.track++;
        }

        const div = document.createElement('div');
        div.className = 'track-item';
        div.dataset.index = index;

        div.innerHTML = `
            <div class="track-header">
                <h4>Track ${index + 1}</h4>
                <button type="button" class="btn-remove remove-track">Remove Track</button>
            </div>

            <div class="form-group">
                <label>Track Title *</label>
                <input type="text" name="track-title-${index}" required placeholder="Back in the U.S.S.R.">
            </div>

            <div class="form-group">
                <label>Listen Links</label>
                <input type="url" name="track-listen-link-${index}"
                       placeholder="https://open.spotify.com/track/... (comma-separated)">
                <small>Add streaming links (Spotify, Apple Music, etc.), separated by commas</small>
            </div>

            <div class="form-row">
                <div class="form-group">
                    <label>Disc/Side</label>
                    <input type="number" name="track-disc-${index}" min="1" value="1">
                </div>
                <div class="form-group">
                    <label>Track Number</label>
                    <input type="number" name="track-number-${index}" min="1" value="${index + 1}">
                </div>
            </div>

            <!-- Songwriters -->
            <div class="subsection">
                <h4>Songwriters</h4>
                <div class="songwriters-container" data-track="${index}"></div>
                <button type="button" class="btn-add add-songwriter" data-track="${index}">+ Add Songwriter</button>
            </div>

            <!-- Producers -->
            <div class="subsection">
                <h4>Producers</h4>
                <div class="producers-container" data-track="${index}"></div>
                <button type="button" class="btn-add add-producer" data-track="${index}">+ Add Producer</button>
            </div>

            <!-- Performing Groups -->
            <div class="subsection">
                <h4>Performing Groups *</h4>
                <p class="section-note">Add the group(s) that performed on this track, with their members and roles.</p>
                <div class="groups-container" data-track="${index}"></div>
                <button type="button" class="btn-add add-group" data-track="${index}">+ Add Group</button>
            </div>

            <!-- Guest Musicians -->
            <div class="subsection">
                <h4>Guest Musicians</h4>
                <p class="section-note">Add musicians who appeared as guests (not regular group members).</p>
                <div class="guests-container" data-track="${index}"></div>
                <button type="button" class="btn-add add-guest" data-track="${index}">+ Add Guest</button>
            </div>

            <!-- Cover/Sample Info -->
            <div class="subsection">
                <h4>Cover & Sample Information</h4>
                <div class="form-group">
                    <label>Cover of (original track ID)</label>
                    <input type="text" name="track-cover-${index}" placeholder="Original track hash (if this is a cover)">
                    <small>UNIMPLEMENTED: Add search for original tracks</small>
                </div>
                <div class="form-group">
                    <label>Samples (sampled track IDs)</label>
                    <input type="text" name="track-samples-${index}" placeholder="Comma-separated sampled track IDs (polaris:track:...)">
                    <small>UNIMPLEMENTED: Add multi-select search for sampled tracks</small>
                </div>
            </div>
        `;

        // Add event handlers for adding nested items
        const trackIndex = index;

        // Songwriters
        div.querySelector('.add-songwriter').addEventListener('click', () => {
            const container = div.querySelector('.songwriters-container');
            const swIndex = container.children.length;
            container.appendChild(this.createPersonForm(swIndex, 'songwriter', trackIndex));
        });

        // Producers
        div.querySelector('.add-producer').addEventListener('click', () => {
            const container = div.querySelector('.producers-container');
            const prodIndex = container.children.length;
            container.appendChild(this.createPersonForm(prodIndex, 'producer', trackIndex));
        });

        // Groups
        div.querySelector('.add-group').addEventListener('click', () => {
            const container = div.querySelector('.groups-container');
            const groupIndex = container.children.length;
            container.appendChild(this.createGroupForm(trackIndex, groupIndex));
        });

        // Guests
        div.querySelector('.add-guest').addEventListener('click', () => {
            const container = div.querySelector('.guests-container');
            const guestIndex = container.children.length;
            container.appendChild(this.createPersonForm(guestIndex, 'guest', trackIndex));
        });

        // Remove track
        div.querySelector('.remove-track').addEventListener('click', () => {
            if (confirm('Remove this track?')) {
                div.remove();
            }
        });

        return div;
    }
}
