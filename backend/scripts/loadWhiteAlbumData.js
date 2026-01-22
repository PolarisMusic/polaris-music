/**
 * Load White Album Release Bundle into Neo4j
 *
 * This script processes a full release bundle matching the Polaris event format
 * and creates all necessary nodes and relationships in Neo4j.
 */

import neo4j from 'neo4j-driver';
import { createHash } from 'crypto';

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
    // Using UI Avatars as placeholder
    const encodedName = encodeURIComponent(name);
    return `https://ui-avatars.com/api/?name=${encodedName}&size=200&background=random`;
}

function getBoilerplateBio(name, role = 'musician') {
    return `${name} is an acclaimed ${role} known for their contributions to rock and roll history. Their innovative approach and technical skill have influenced generations of musicians.`;
}

function getBoilerplateTrivia(name) {
    return `${name} has recorded numerous albums and performed at venues worldwide. Their work continues to be celebrated by fans and critics alike.`;
}

// White Album Release Bundle
const whiteAlbumBundle = {
    v: 1,
    type: "CREATE_RELEASE_BUNDLE",
    created_at: Math.floor(Date.now() / 1000),
    body: {
        release: {
            release_id: "rel-white-album-1968",
            release_name: "The Beatles",
            release_altnames: ["The White Album"],
            release_date: "1968-11-22",
            release_format: ["LP"],
            liner_notes: "The ninth studio album by the English rock band the Beatles, released on 22 November 1968. A double album, its plain white sleeve contains no graphics or text other than the band's name embossed.",
            master_release: [true, null],
            bio: "The White Album is widely regarded as one of the greatest and most influential albums in the history of popular music.",
            trivia: "The album's minimalist cover was designed by Richard Hamilton. It was the first Beatles album released on their own Apple Records label.",

            labels: [{
                label_id: "57230498f3982de",
                label_name: "Apple Records",
                label_altnames: ["Apple Corps"],
                label_parents: "",
                bio: "Apple Records is a record label founded by the Beatles in 1968 as a division of Apple Corps Ltd.",
                trivia: "The label's first release was 'Hey Jude' in August 1968.",
                label_city: [{
                    city_id: "d857a85e07f2344290",
                    city_name: "London",
                    city_lat: 51.50735,
                    city_lon: -0.12776
                }]
            }],

            tracks: [
                {
                    track_id: "8d0b789a634ac54",
                    title: "Back in the U.S.S.R.",
                    listen_link: ["https://open.spotify.com/track/0j3p1p06deJ7f9xmJ9yG22"],
                    trivia: "Written as a parody of Chuck Berry's 'Back in the U.S.A.' and the Beach Boys' California songs.",

                    songwriters: [
                        {
                            person_id: "d36547078b701635a7412",
                            person_name: "Paul McCartney",
                            person_roles: [
                                { role_id: "96e96770c07b0707a07e078f078", role_name: "Lyrics" },
                                { role_id: "9a96c96e78fac74e765876b", role_name: "Songwriter" }
                            ],
                            person_city: { city_id: "d857a85e07f2344290", city_name: "London", city_lat: 51.50735, city_lon: -0.12776 }
                        },
                        {
                            person_id: "347a746e8c9606f78978fd",
                            person_name: "John Lennon",
                            person_roles: [
                                { role_id: "9a96c96e78fac74e765876b", role_name: "Songwriter" }
                            ],
                            person_city: { city_id: "d857a85e07f2344290", city_name: "London", city_lat: 51.50735, city_lon: -0.12776 }
                        }
                    ],

                    producers: [{
                        person_id: "436a765c764e73567978b6979e97f97",
                        person_name: "George Martin",
                        person_roles: [{ role_id: "c976b975aa254354665e9", role_name: "Producer" }],
                        person_city: { city_id: "d857a85e07f2344290", city_name: "London", city_lat: 51.50735, city_lon: -0.12776 }
                    }],

                    groups: [{
                        group_id: "875a968e0d079c90766544",
                        group_name: "The Beatles",
                        group_altnames: ["The Fab Four"],
                        members: [
                            {
                                person_id: "347a746e8c9606f78978fd",
                                person_name: "John Lennon",
                                person_roles: [
                                    { role_id: "007697d63b680e6ac254365", role_name: "Backing Vocals" },
                                    { role_id: "53429f698e98a789c635", role_name: "Electric Guitar" }
                                ],
                                person_city: { city_id: "d857a85e07f2344290", city_name: "London", city_lat: 51.50735, city_lon: -0.12776 }
                            },
                            {
                                person_id: "d36547078b701635a7412",
                                person_name: "Paul McCartney",
                                person_roles: [
                                    { role_id: "969e63c089a465", role_name: "Lead Vocals" },
                                    { role_id: "007697d63b680e6ac254365", role_name: "Backing Vocals" },
                                    { role_id: "7e4a648c57697089f2653a8796b", role_name: "Bass Guitar" },
                                    { role_id: "a123456c234567890e9987", role_name: "Drum Kit" },
                                    { role_id: "70a3654eb7654c67bbc", role_name: "Piano" }
                                ],
                                person_city: { city_id: "d857a85e07f2344290", city_name: "London", city_lat: 51.50735, city_lon: -0.12776 }
                            },
                            {
                                person_id: "2c689b96a8960e79f0d",
                                person_name: "George Harrison",
                                person_roles: [
                                    { role_id: "007697d63b680e6ac254365", role_name: "Backing Vocals" },
                                    { role_id: "53429f698e98a789c635", role_name: "Electric Guitar" }
                                ],
                                person_city: { city_id: "d857a85e07f2344290", city_name: "London", city_lat: 51.50735, city_lon: -0.12776 }
                            }
                        ]
                    }],
                    guests: []
                },
                {
                    track_id: "c63b233ae432ccf8544",
                    title: "Glass Onion",
                    listen_link: ["https://open.spotify.com/track/2jAojvUaPoHPFSPpF0UNRo"],
                    trivia: "Contains references to several earlier Beatles songs including 'Strawberry Fields Forever', 'I Am the Walrus', and 'Lady Madonna'.",

                    songwriters: [
                        {
                            person_id: "347a746e8c9606f78978fd",
                            person_name: "John Lennon",
                            person_roles: [
                                { role_id: "96e96770c07b0707a07e078f078", role_name: "Lyrics" },
                                { role_id: "9a96c96e78fac74e765876b", role_name: "Songwriter" }
                            ],
                            person_city: { city_id: "d857a85e07f2344290", city_name: "London", city_lat: 51.50735, city_lon: -0.12776 }
                        }
                    ],

                    producers: [{
                        person_id: "436a765c764e73567978b6979e97f97",
                        person_name: "George Martin",
                        person_roles: [{ role_id: "c976b975aa254354665e9", role_name: "Producer" }],
                        person_city: { city_id: "d857a85e07f2344290", city_name: "London", city_lat: 51.50735, city_lon: -0.12776 }
                    }],

                    groups: [{
                        group_id: "875a968e0d079c90766544",
                        group_name: "The Beatles",
                        group_altnames: ["The Fab Four"],
                        members: [
                            {
                                person_id: "347a746e8c9606f78978fd",
                                person_name: "John Lennon",
                                person_roles: [
                                    { role_id: "969e63c089a465", role_name: "Lead Vocals" },
                                    { role_id: "53429f698e98a789c635", role_name: "Acoustic Guitar" }
                                ],
                                person_city: { city_id: "d857a85e07f2344290", city_name: "London", city_lat: 51.50735, city_lon: -0.12776 }
                            },
                            {
                                person_id: "d36547078b701635a7412",
                                person_name: "Paul McCartney",
                                person_roles: [
                                    { role_id: "7e4a648c57697089f2653a8796b", role_name: "Bass Guitar" },
                                    { role_id: "070f0786a078c08e7a0b7074325", role_name: "Recorder" },
                                    { role_id: "70a3654eb7654c67bbc", role_name: "Piano" }
                                ],
                                person_city: { city_id: "d857a85e07f2344290", city_name: "London", city_lat: 51.50735, city_lon: -0.12776 }
                            },
                            {
                                person_id: "2c689b96a8960e79f0d",
                                person_name: "George Harrison",
                                person_roles: [
                                    { role_id: "53429f698e98a789c635", role_name: "Electric Guitar" }
                                ],
                                person_city: { city_id: "d857a85e07f2344290", city_name: "London", city_lat: 51.50735, city_lon: -0.12776 }
                            },
                            {
                                person_id: "a13248576c56746e89980d",
                                person_name: "Ringo Starr",
                                person_roles: [
                                    { role_id: "a123456c234567890e9987", role_name: "Drum Kit" },
                                    { role_id: "c745a1b27389e897468a654c8", role_name: "Tambourine" }
                                ],
                                person_city: { city_id: "d857a85e07f2344290", city_name: "London", city_lat: 51.50735, city_lon: -0.12776 }
                            }
                        ]
                    }],
                    guests: []
                }
            ]
        },
        tracklist: [
            { track_id: "8d0b789a634ac54", disc_side: 1, track_number: 1 },
            { track_id: "c63b233ae432ccf8544", disc_side: 1, track_number: 3 }
        ]
    }
};

/**
 * Process and load the White Album release bundle into Neo4j
 */
async function loadWhiteAlbumData() {
    const session = driver.session();

    try {
        console.log('🎵 Loading White Album data into Neo4j...\n');

        const { release, tracklist } = whiteAlbumBundle.body;

        // Track all unique persons to assign colors
        const personsMap = new Map();

        // 1. Create Cities
        console.log('📍 Creating cities...');
        const citiesSet = new Set();

        // Collect all cities
        release.labels?.forEach(label => {
            label.label_city?.forEach(city => {
                citiesSet.add(JSON.stringify(city));
            });
        });

        release.tracks?.forEach(track => {
            [...(track.songwriters || []), ...(track.producers || [])].forEach(person => {
                if (person.person_city) {
                    citiesSet.add(JSON.stringify(person.person_city));
                }
            });

            track.groups?.forEach(group => {
                group.members?.forEach(member => {
                    if (member.person_city) {
                        citiesSet.add(JSON.stringify(member.person_city));
                    }
                });
            });
        });

        for (const cityJson of citiesSet) {
            const city = JSON.parse(cityJson);
            await session.run(`
                MERGE (c:City {city_id: $city_id})
                SET c.name = $name,
                    c.lat = $lat,
                    c.lon = $lon
            `, {
                city_id: city.city_id,
                name: city.city_name,
                lat: city.city_lat,
                lon: city.city_lon
            });
        }
        console.log(`✓ Created ${citiesSet.size} cities\n`);

        // 2. Create Labels
        console.log('🏷️  Creating labels...');
        for (const label of release.labels || []) {
            await session.run(`
                MERGE (l:Label {label_id: $label_id})
                SET l.name = $name,
                    l.altnames = $altnames,
                    l.bio = $bio,
                    l.trivia = $trivia,
                    l.status = 'canonical'
            `, {
                label_id: label.label_id,
                name: label.label_name,
                altnames: Array.isArray(label.label_altnames) ? label.label_altnames : [label.label_altnames],
                bio: label.bio || getBoilerplateBio(label.label_name, 'record label'),
                trivia: label.trivia || getBoilerplateTrivia(label.label_name)
            });

            // Link label to city
            if (label.label_city && label.label_city.length > 0) {
                await session.run(`
                    MATCH (l:Label {label_id: $label_id})
                    MATCH (c:City {city_id: $city_id})
                    MERGE (l)-[:BASED_IN]->(c)
                `, {
                    label_id: label.label_id,
                    city_id: label.label_city[0].city_id
                });
            }
        }
        console.log(`✓ Created ${release.labels?.length || 0} labels\n`);

        // 3. Create Roles
        console.log('🎭 Creating roles...');
        const rolesSet = new Set();

        release.tracks?.forEach(track => {
            [...(track.songwriters || []), ...(track.producers || [])].forEach(person => {
                person.person_roles?.forEach(role => {
                    rolesSet.add(JSON.stringify(role));
                });
            });

            track.groups?.forEach(group => {
                group.members?.forEach(member => {
                    member.person_roles?.forEach(role => {
                        rolesSet.add(JSON.stringify(role));
                    });
                });
            });
        });

        for (const roleJson of rolesSet) {
            const role = JSON.parse(roleJson);
            await session.run(`
                MERGE (r:Role {role_id: $role_id})
                SET r.name = $name
            `, {
                role_id: role.role_id,
                name: role.role_name
            });
        }
        console.log(`✓ Created ${rolesSet.size} roles\n`);

        // 4. Create Persons with colors
        console.log('👤 Creating persons with colors...');
        release.tracks?.forEach(track => {
            [...(track.songwriters || []), ...(track.producers || [])].forEach(person => {
                if (!personsMap.has(person.person_id)) {
                    personsMap.set(person.person_id, {
                        ...person,
                        color: generatePersonColor(),
                        photo: getPlaceholderPhoto(person.person_name),
                        bio: getBoilerplateBio(person.person_name),
                        trivia: getBoilerplateTrivia(person.person_name)
                    });
                }
            });

            track.groups?.forEach(group => {
                group.members?.forEach(member => {
                    if (!personsMap.has(member.person_id)) {
                        personsMap.set(member.person_id, {
                            ...member,
                            color: generatePersonColor(),
                            photo: getPlaceholderPhoto(member.person_name),
                            bio: getBoilerplateBio(member.person_name),
                            trivia: getBoilerplateTrivia(member.person_name)
                        });
                    }
                });
            });
        });

        for (const [personId, person] of personsMap) {
            await session.run(`
                MERGE (p:Person {person_id: $person_id})
                SET p.name = $name,
                    p.color = $color,
                    p.photo = $photo,
                    p.bio = $bio,
                    p.trivia = $trivia,
                    p.status = 'canonical'
            `, {
                person_id: personId,
                name: person.person_name,
                color: person.color,
                photo: person.photo,
                bio: person.bio,
                trivia: person.trivia
            });

            // Link person to city
            if (person.person_city) {
                await session.run(`
                    MATCH (p:Person {person_id: $person_id})
                    MATCH (c:City {city_id: $city_id})
                    MERGE (p)-[:ORIGIN]->(c)
                `, {
                    person_id: personId,
                    city_id: person.person_city.city_id
                });
            }
        }
        console.log(`✓ Created ${personsMap.size} persons with random colors\n`);

        // 5. Create Group
        console.log('🎸 Creating groups...');
        const groupsSet = new Set();
        release.tracks?.forEach(track => {
            track.groups?.forEach(group => {
                groupsSet.add(JSON.stringify({
                    group_id: group.group_id,
                    group_name: group.group_name,
                    group_altnames: group.group_altnames
                }));
            });
        });

        for (const groupJson of groupsSet) {
            const group = JSON.parse(groupJson);
            await session.run(`
                MERGE (g:Group {group_id: $group_id})
                SET g.name = $name,
                    g.altnames = $altnames,
                    g.photo = $photo,
                    g.bio = $bio,
                    g.trivia = $trivia,
                    g.status = 'canonical'
            `, {
                group_id: group.group_id,
                name: group.group_name,
                altnames: Array.isArray(group.group_altnames) ? group.group_altnames : [group.group_altnames],
                photo: getPlaceholderPhoto(group.group_name),
                bio: getBoilerplateBio(group.group_name, 'band'),
                trivia: "The Beatles are widely regarded as the most influential band in the history of popular music."
            });
        }
        console.log(`✓ Created ${groupsSet.size} groups\n`);

        // 6. Create Release
        console.log('💿 Creating release...');
        await session.run(`
            MERGE (r:Release {release_id: $release_id})
            SET r.name = $name,
                r.altnames = $altnames,
                r.date = date($date),
                r.format = $format,
                r.liner_notes = $liner_notes,
                r.bio = $bio,
                r.trivia = $trivia,
                r.photo = $photo,
                r.status = 'canonical'
        `, {
            release_id: release.release_id,
            name: release.release_name,
            altnames: release.release_altnames || [],
            date: release.release_date,
            format: release.release_format || [],
            liner_notes: release.liner_notes || '',
            bio: release.bio || '',
            trivia: release.trivia || '',
            photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6a/The_Beatles_-_A_Collection_of_Beatles_Oldies_%28recto%29.jpg/440px-The_Beatles_-_A_Collection_of_Beatles_Oldies_%28recto%29.jpg'
        });

        // Link release to labels
        for (const label of release.labels || []) {
            await session.run(`
                MATCH (r:Release {release_id: $release_id})
                MATCH (l:Label {label_id: $label_id})
                MERGE (r)-[:RELEASED_BY]->(l)
            `, {
                release_id: release.release_id,
                label_id: label.label_id
            });
        }
        console.log('✓ Created release\n');

        // 7. Create Tracks and Songs
        console.log('🎵 Creating tracks and songs...');
        for (const track of release.tracks || []) {
            // Create Song
            const songId = `song-${track.track_id}`;
            await session.run(`
                MERGE (s:Song {song_id: $song_id})
                SET s.name = $name
            `, {
                song_id: songId,
                name: track.title
            });

            // Create Track
            await session.run(`
                MERGE (t:Track {track_id: $track_id})
                SET t.title = $title,
                    t.trivia = $trivia,
                    t.listen_links = $listen_links
            `, {
                track_id: track.track_id,
                title: track.title,
                trivia: track.trivia || '',
                listen_links: track.listen_link || []
            });

            // Link Track to Song
            await session.run(`
                MATCH (t:Track {track_id: $track_id})
                MATCH (s:Song {song_id: $song_id})
                MERGE (t)-[:RECORDING_OF]->(s)
            `, {
                track_id: track.track_id,
                song_id: songId
            });

            // Link songwriters to Song
            for (const writer of track.songwriters || []) {
                await session.run(`
                    MATCH (p:Person {person_id: $person_id})
                    MATCH (s:Song {song_id: $song_id})
                    MERGE (p)-[:WROTE]->(s)
                `, {
                    person_id: writer.person_id,
                    song_id: songId
                });

                // Link songwriter roles
                for (const role of writer.person_roles || []) {
                    await session.run(`
                        MATCH (t:Track {track_id: $track_id})
                        MATCH (p:Person {person_id: $person_id})
                        MATCH (r:Role {role_id: $role_id})
                        MERGE (t)-[:HAS_ROLE {person_id: $person_id}]->(r)
                    `, {
                        track_id: track.track_id,
                        person_id: writer.person_id,
                        role_id: role.role_id
                    });
                }
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

                // Link producer roles
                for (const role of producer.person_roles || []) {
                    await session.run(`
                        MATCH (t:Track {track_id: $track_id})
                        MATCH (p:Person {person_id: $person_id})
                        MATCH (r:Role {role_id: $role_id})
                        MERGE (t)-[:HAS_ROLE {person_id: $person_id}]->(r)
                    `, {
                        track_id: track.track_id,
                        person_id: producer.person_id,
                        role_id: role.role_id
                    });
                }
            }

            // Link groups and members
            for (const group of track.groups || []) {
                // Group performed on track
                await session.run(`
                    MATCH (g:Group {group_id: $group_id})
                    MATCH (t:Track {track_id: $track_id})
                    MERGE (g)-[:PERFORMED_ON]->(t)
                `, {
                    group_id: group.group_id,
                    track_id: track.track_id
                });

                // Member relationships
                for (const member of group.members || []) {
                    // Person MEMBER_OF Group
                    await session.run(`
                        MATCH (p:Person {person_id: $person_id})
                        MATCH (g:Group {group_id: $group_id})
                        MERGE (p)-[m:MEMBER_OF]->(g)
                        ON CREATE SET m.from_date = '1960',
                                     m.to_date = '1970'
                    `, {
                        person_id: member.person_id,
                        group_id: group.group_id
                    });

                    // Member roles on track
                    for (const role of member.person_roles || []) {
                        await session.run(`
                            MATCH (t:Track {track_id: $track_id})
                            MATCH (p:Person {person_id: $person_id})
                            MATCH (r:Role {role_id: $role_id})
                            MERGE (t)-[:HAS_ROLE {person_id: $person_id}]->(r)
                        `, {
                            track_id: track.track_id,
                            person_id: member.person_id,
                            role_id: role.role_id
                        });
                    }
                }
            }
        }
        console.log(`✓ Created ${release.tracks?.length || 0} tracks and songs\n`);

        // 8. Link tracks to release via tracklist
        console.log('📀 Linking tracks to release...');
        for (const trackEntry of tracklist || []) {
            await session.run(`
                MATCH (t:Track {track_id: $track_id})
                MATCH (r:Release {release_id: $release_id})
                MERGE (t)-[ir:IN_RELEASE]->(r)
                SET ir.disc_number = $disc_side,
                    ir.track_number = $track_number
            `, {
                track_id: trackEntry.track_id,
                release_id: release.release_id,
                disc_side: trackEntry.disc_side,
                track_number: trackEntry.track_number
            });
        }
        console.log(`✓ Linked ${tracklist?.length || 0} tracks to release\n`);

        console.log('✨ White Album data loaded successfully!\n');
        console.log('Summary:');
        console.log(`  - ${citiesSet.size} cities`);
        console.log(`  - ${release.labels?.length || 0} labels`);
        console.log(`  - ${rolesSet.size} roles`);
        console.log(`  - ${personsMap.size} persons (with colors, photos, bios, trivia)`);
        console.log(`  - ${groupsSet.size} groups`);
        console.log(`  - 1 release`);
        console.log(`  - ${release.tracks?.length || 0} tracks and songs`);

    } catch (error) {
        console.error('Error loading data:', error);
        throw error;
    } finally {
        await session.close();
    }
}

// Run the loader
loadWhiteAlbumData()
    .then(() => {
        console.log('\n🎉 Done!');
        process.exit(0);
    })
    .catch(error => {
        console.error('\n❌ Fatal error:', error);
        process.exit(1);
    });
