/**
 * Load Smoke Test Release Bundles into Neo4j
 *
 * This script processes all smoke test release bundles from backend/smoke-tests/releases/
 * and creates all necessary nodes and relationships in Neo4j.
 *
 * Usage:
 *   node backend/scripts/loadSmokeTests.js [--file <filename>] [--clear]
 *
 * Options:
 *   --file    Load a specific file only (e.g., --file create-release-bundle-nevermind.tmpl.json)
 *   --clear   Clear existing graph data before loading (WARNING: deletes all data!)
 *
 * Environment Variables:
 *   GRAPH_URI       Neo4j connection URI (default: bolt://localhost:7687)
 *   GRAPH_USER      Neo4j username (default: neo4j)
 *   GRAPH_PASSWORD  Neo4j password (default: polarisdev)
 */

import neo4j from 'neo4j-driver';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
    file: null,
    clear: false
};

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && i + 1 < args.length) {
        options.file = args[i + 1];
        i++;
    } else if (args[i] === '--clear') {
        options.clear = true;
    }
}

// Database connection
const driver = neo4j.driver(
    process.env.GRAPH_URI || 'bolt://localhost:7687',
    neo4j.auth.basic(
        process.env.GRAPH_USER || 'neo4j',
        process.env.GRAPH_PASSWORD || 'polarisdev'
    )
);

// Helper: Generate random color for person
function generatePersonColor() {
    const colors = [
        '#FF6B6B', // Red
        '#4ECDC4', // Cyan
        '#45B7D1', // Blue
        '#FFA07A', // Light Salmon
        '#98D8C8', // Mint
        '#F7DC6F', // Yellow
        '#BB8FCE', // Purple
        '#85C1E2', // Sky Blue
        '#F8B195', // Peach
        '#C06C84', // Mauve
    ];
    return colors[Math.floor(Math.random() * colors.length)];
}

// Helper: Generate placeholder URLs
function getPlaceholderPhoto(name) {
    const encodedName = encodeURIComponent(name);
    return `https://ui-avatars.com/api/?name=${encodedName}&size=200&background=random`;
}

function getBoilerplateBio(name, role = 'musician') {
    return `${name} is an acclaimed ${role} known for their contributions to rock and roll history.`;
}

function getBoilerplateTrivia(name) {
    return `${name} has recorded numerous albums and performed at venues worldwide.`;
}

/**
 * Clear all graph data (WARNING: destructive!)
 */
async function clearGraphData() {
    const session = driver.session();
    try {
        console.log('⚠️  Clearing all graph data...');
        await session.run('MATCH (n) DETACH DELETE n');
        console.log('✓ Graph data cleared\n');
    } finally {
        await session.close();
    }
}

/**
 * Process a single release bundle
 */
async function processReleaseBundle(bundle, filename) {
    const session = driver.session();

    try {
        console.log(`\n📀 Processing: ${filename}`);
        console.log('─'.repeat(60));

        const { release, labels, groups, songs, tracks, tracklist } = bundle.body;

        // Track all unique persons to assign colors
        const personsMap = new Map();
        const citiesSet = new Set();
        const rolesSet = new Set();

        // 1. Collect all cities
        labels?.forEach(label => {
            if (label.city) {
                citiesSet.add(JSON.stringify({
                    city_id: label.city.id || label.city.city_id,
                    name: label.city.name || label.city.city_name,
                    lat: label.city.lat || label.city.city_lat,
                    lon: label.city.lon || label.city.city_lon
                }));
            }
        });

        // Collect persons and cities from groups
        groups?.forEach(group => {
            group.members?.forEach(member => {
                if (!personsMap.has(member.person_id)) {
                    personsMap.set(member.person_id, {
                        person_id: member.person_id,
                        name: member.name,
                        role: member.role,
                        color: generatePersonColor(),
                        photo: getPlaceholderPhoto(member.name),
                        bio: getBoilerplateBio(member.name),
                        trivia: getBoilerplateTrivia(member.name)
                    });
                }
            });
        });

        // Collect persons from songs (writers)
        songs?.forEach(song => {
            song.writers?.forEach(writer => {
                if (!personsMap.has(writer.person_id)) {
                    personsMap.set(writer.person_id, {
                        person_id: writer.person_id,
                        name: writer.name,
                        roles: writer.roles || [],
                        color: generatePersonColor(),
                        photo: getPlaceholderPhoto(writer.name),
                        bio: getBoilerplateBio(writer.name, 'songwriter'),
                        trivia: getBoilerplateTrivia(writer.name)
                    });
                }
            });
        });

        // Collect persons from tracks (producers, guests)
        tracks?.forEach(track => {
            track.producers?.forEach(producer => {
                if (!personsMap.has(producer.person_id)) {
                    personsMap.set(producer.person_id, {
                        person_id: producer.person_id,
                        name: producer.name,
                        color: generatePersonColor(),
                        photo: getPlaceholderPhoto(producer.name),
                        bio: getBoilerplateBio(producer.name, 'producer'),
                        trivia: getBoilerplateTrivia(producer.name)
                    });
                }
            });

            track.guests?.forEach(guest => {
                if (!personsMap.has(guest.person_id)) {
                    personsMap.set(guest.person_id, {
                        person_id: guest.person_id,
                        name: guest.name,
                        role: guest.role,
                        color: generatePersonColor(),
                        photo: getPlaceholderPhoto(guest.name),
                        bio: getBoilerplateBio(guest.name),
                        trivia: getBoilerplateTrivia(guest.name)
                    });
                }
            });
        });

        // Create Cities
        if (citiesSet.size > 0) {
            console.log(`📍 Creating ${citiesSet.size} cities...`);
            for (const cityJson of citiesSet) {
                const city = JSON.parse(cityJson);
                await session.run(`
                    MERGE (c:City {city_id: $city_id})
                    SET c.name = $name,
                        c.lat = $lat,
                        c.lon = $lon
                `, city);
            }
        }

        // Create Labels
        if (labels?.length > 0) {
            console.log(`🏷️  Creating ${labels.length} labels...`);
            for (const label of labels) {
                await session.run(`
                    MERGE (l:Label {label_id: $label_id})
                    SET l.name = $name,
                        l.altnames = $altnames,
                        l.bio = $bio,
                        l.trivia = $trivia,
                        l.status = 'ACTIVE'
                `, {
                    label_id: label.label_id,
                    name: label.name,
                    altnames: label.alt_names ? (Array.isArray(label.alt_names) ? label.alt_names : [label.alt_names]) : [],
                    bio: label.bio || getBoilerplateBio(label.name, 'record label'),
                    trivia: label.trivia || getBoilerplateTrivia(label.name)
                });
            }
        }

        // Create Persons
        if (personsMap.size > 0) {
            console.log(`👤 Creating ${personsMap.size} persons...`);
            for (const [personId, person] of personsMap) {
                await session.run(`
                    MERGE (p:Person {person_id: $person_id})
                    SET p.name = $name,
                        p.color = $color,
                        p.photo = $photo,
                        p.bio = $bio,
                        p.trivia = $trivia,
                        p.status = 'ACTIVE'
                `, person);
            }
        }

        // Create Groups
        if (groups?.length > 0) {
            console.log(`🎸 Creating ${groups.length} groups...`);
            for (const group of groups) {
                await session.run(`
                    MERGE (g:Group {group_id: $group_id})
                    SET g.name = $name,
                        g.altnames = $altnames,
                        g.photo = $photo,
                        g.bio = $bio,
                        g.trivia = $trivia,
                        g.status = 'ACTIVE'
                `, {
                    group_id: group.group_id,
                    name: group.name,
                    altnames: group.alt_names ? (Array.isArray(group.alt_names) ? group.alt_names : [group.alt_names]) : [],
                    photo: getPlaceholderPhoto(group.name),
                    bio: group.bio || getBoilerplateBio(group.name, 'band'),
                    trivia: group.trivia || getBoilerplateTrivia(group.name)
                });

                // Create MEMBER_OF relationships
                for (const member of group.members || []) {
                    await session.run(`
                        MATCH (p:Person {person_id: $person_id})
                        MATCH (g:Group {group_id: $group_id})
                        MERGE (p)-[m:MEMBER_OF]->(g)
                        ON CREATE SET m.role = $role
                    `, {
                        person_id: member.person_id,
                        group_id: group.group_id,
                        role: member.role || 'member'
                    });
                }
            }
        }

        // Create Release
        console.log(`💿 Creating release: ${release.name}...`);
        await session.run(`
            MERGE (r:Release {release_id: $release_id})
            SET r.name = $name,
                r.altnames = $altnames,
                r.date = date($date),
                r.format = $format,
                r.country = $country,
                r.catalog_number = $catalog_number,
                r.trivia = $trivia,
                r.photo = $photo,
                r.status = 'ACTIVE'
        `, {
            release_id: release.release_id,
            name: release.name,
            altnames: release.alt_names ? (Array.isArray(release.alt_names) ? release.alt_names : [release.alt_names]) : [],
            date: release.release_date || '1900-01-01',
            format: release.format || '',
            country: release.country || '',
            catalog_number: release.catalog_number || '',
            trivia: release.trivia || '',
            photo: getPlaceholderPhoto(release.name)
        });

        // Link release to labels
        if (labels?.length > 0) {
            for (const label of labels) {
                await session.run(`
                    MATCH (r:Release {release_id: $release_id})
                    MATCH (l:Label {label_id: $label_id})
                    MERGE (r)-[:RELEASED_BY]->(l)
                `, {
                    release_id: release.release_id,
                    label_id: label.label_id
                });
            }
        }

        // Create Songs
        if (songs?.length > 0) {
            console.log(`🎵 Creating ${songs.length} songs...`);
            for (const song of songs) {
                await session.run(`
                    MERGE (s:Song {song_id: $song_id})
                    SET s.name = $title,
                        s.status = 'ACTIVE'
                `, {
                    song_id: song.song_id,
                    title: song.title
                });

                // Link writers to songs
                for (const writer of song.writers || []) {
                    await session.run(`
                        MATCH (p:Person {person_id: $person_id})
                        MATCH (s:Song {song_id: $song_id})
                        MERGE (p)-[:WROTE]->(s)
                    `, {
                        person_id: writer.person_id,
                        song_id: song.song_id
                    });
                }
            }
        }

        // Create Tracks
        if (tracks?.length > 0) {
            console.log(`🎧 Creating ${tracks.length} tracks...`);
            for (const track of tracks) {
                await session.run(`
                    MERGE (t:Track {track_id: $track_id})
                    SET t.title = $title,
                        t.duration = $duration
                `, {
                    track_id: track.track_id,
                    title: track.title,
                    duration: track.duration || 0
                });

                // Link track to song (using recording_of field)
                const songId = track.recording_of || track.song_id;
                if (songId) {
                    await session.run(`
                        MATCH (t:Track {track_id: $track_id})
                        MATCH (s:Song {song_id: $song_id})
                        MERGE (t)-[:RECORDING_OF]->(s)
                    `, {
                        track_id: track.track_id,
                        song_id: songId
                    });
                }

                // Link producers
                for (const producer of track.producers || []) {
                    await session.run(`
                        MATCH (p:Person {person_id: $person_id})
                        MATCH (t:Track {track_id: $track_id})
                        MERGE (p)-[:PRODUCED]->(t)
                    `, {
                        person_id: producer.person_id,
                        track_id: track.track_id
                    });
                }

                // Link performing groups (handle both groups array and single group_id)
                const performingGroups = track.groups || (track.group_id ? [{group_id: track.group_id}] : []);
                for (const group of performingGroups) {
                    await session.run(`
                        MATCH (g:Group {group_id: $group_id})
                        MATCH (t:Track {track_id: $track_id})
                        MERGE (g)-[:PERFORMED_ON]->(t)
                    `, {
                        group_id: group.group_id,
                        track_id: track.track_id
                    });
                }

                // Link guests
                for (const guest of track.guests || []) {
                    await session.run(`
                        MATCH (p:Person {person_id: $person_id})
                        MATCH (t:Track {track_id: $track_id})
                        MERGE (p)-[g:GUEST_ON]->(t)
                        ON CREATE SET g.role = $role
                    `, {
                        person_id: guest.person_id,
                        track_id: track.track_id,
                        role: guest.role || 'guest'
                    });
                }
            }
        }

        // Link tracks to release
        if (tracklist?.length > 0) {
            console.log(`📀 Linking ${tracklist.length} tracks to release...`);
            for (const trackEntry of tracklist) {
                // Handle both track_id and track_title formats
                if (trackEntry.track_id) {
                    await session.run(`
                        MATCH (t:Track {track_id: $track_id})
                        MATCH (r:Release {release_id: $release_id})
                        MERGE (t)-[ir:IN_RELEASE]->(r)
                        SET ir.disc_number = $disc_number,
                            ir.track_number = $track_number
                    `, {
                        track_id: trackEntry.track_id,
                        release_id: release.release_id,
                        disc_number: trackEntry.disc_number || 1,
                        track_number: parseInt(trackEntry.position || trackEntry.track_number || 0)
                    });
                } else if (trackEntry.track_title) {
                    // Match by title if track_id not provided
                    await session.run(`
                        MATCH (t:Track {title: $title})
                        MATCH (r:Release {release_id: $release_id})
                        MERGE (t)-[ir:IN_RELEASE]->(r)
                        SET ir.disc_number = $disc_number,
                            ir.track_number = $track_number
                    `, {
                        title: trackEntry.track_title,
                        release_id: release.release_id,
                        disc_number: trackEntry.disc_number || 1,
                        track_number: parseInt(trackEntry.position || trackEntry.track_number || 0)
                    });
                }
            }
        }

        console.log(`✓ Successfully loaded: ${release.name}`);
        console.log('─'.repeat(60));

    } catch (error) {
        console.error(`✗ Error loading ${filename}:`, error.message);
        throw error;
    } finally {
        await session.close();
    }
}

/**
 * Main loader function
 */
async function loadSmokeTests() {
    try {
        console.log('🎵 Polaris Smoke Test Loader');
        console.log('═'.repeat(60));

        // Clear data if requested
        if (options.clear) {
            await clearGraphData();
        }

        const smokeTestDir = join(__dirname, '../smoke-tests/releases');

        // Get list of files to process
        let files;
        if (options.file) {
            files = [options.file];
            console.log(`Loading single file: ${options.file}\n`);
        } else {
            const allFiles = await readdir(smokeTestDir);
            files = allFiles.filter(f => f.endsWith('.tmpl.json'));
            console.log(`Found ${files.length} smoke test bundles\n`);
        }

        let loaded = 0;
        let failed = 0;

        // Process each file
        for (const file of files) {
            try {
                const filePath = join(smokeTestDir, file);
                const content = await readFile(filePath, 'utf8');

                // Replace template placeholders with current timestamp
                // Handle all timestamp formats:
                // - __TIMESTAMP__ (double underscore, unquoted)
                // - "TIMESTAMP" (quoted string)
                // - TIMESTAMP (unquoted, no underscores)
                const timestamp = Math.floor(Date.now() / 1000);
                const processedContent = content
                    .replace(/__TIMESTAMP__/g, timestamp)
                    .replace(/"TIMESTAMP"/g, timestamp)
                    .replace(/:\s*TIMESTAMP\s*,/g, `: ${timestamp},`);  // Unquoted TIMESTAMP
                const bundle = JSON.parse(processedContent);

                await processReleaseBundle(bundle, file);
                loaded++;
            } catch (error) {
                console.error(`Failed to load ${file}:`, error.message);
                failed++;
            }
        }

        console.log('\n' + '═'.repeat(60));
        console.log('📊 Summary');
        console.log('═'.repeat(60));
        console.log(`✓ Successfully loaded: ${loaded} bundles`);
        if (failed > 0) {
            console.log(`✗ Failed: ${failed} bundles`);
        }
        console.log('\n🎉 Done!');

    } catch (error) {
        console.error('\n❌ Fatal error:', error);
        throw error;
    }
}

// Run the loader
loadSmokeTests()
    .then(() => {
        process.exit(0);
    })
    .catch(error => {
        console.error('\n❌ Fatal error:', error);
        process.exit(1);
    })
    .finally(() => {
        driver.close();
    });
