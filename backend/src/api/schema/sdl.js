/**
 * GraphQL Schema Definition for the Polaris API.
 *
 * Defines all types, queries, and mutations available via GraphQL.
 * Extracted from `api/server.js` (Stage I) so the SDL string and the
 * compiled schema have a single canonical location.
 *
 * @module api/schema/sdl
 */

import { buildSchema } from 'graphql';

export const typeDefs = `
  """
  A person in the music industry (musician, producer, engineer, etc.)
  """
  type Person {
    person_id: String!
    name: String!
    alt_names: [String!]
    bio: String
    status: String!
    groups: [GroupMembership!]
    songsWritten: [Song!]
    tracksProduced: [Track!]
    guestAppearances: [Track!]
  }

  """
  Group membership details with dates and roles
  """
  type GroupMembership {
    group: Group!
    role: String
    from_date: String
    to_date: String
    instruments: [String!]
  }

  """
  A musical group (band, orchestra, ensemble, or solo project)
  """
  type Group {
    group_id: String!
    name: String!
    alt_names: [String!]
    bio: String
    formed_date: String
    disbanded_date: String
    inferred_first_release_date: String
    inferred_last_release_date: String
    status: String!
    members: [Member!]
    releases: [Release!]
    tracks: [Track!]
  }

  """
  Member participation data for RGraph visualization
  """
  type Member {
    person: Person!
    role: String
    from_date: String
    to_date: String
    instruments: [String!]
    participation_percentage: Float
    track_count: Int
    release_count: Int
  }

  """
  A musical composition (the written work)
  """
  type Song {
    song_id: String!
    title: String!
    alt_titles: [String!]
    iswc: String
    year: Int
    lyrics: String
    writers: [Person!]
    recordings: [Track!]
  }

  """
  A specific recording/performance of a song
  """
  type Track {
    track_id: String!
    title: String!
    isrc: String
    duration: Int
    recording_date: String
    recording_location: String
    listen_links: [String!]
    status: String!
    performedBy: [Group!]
    guests: [Person!]
    recordingOf: Song
    releases: [Release!]
  }

  """
  An album, EP, single, or other release package
  """
  type Release {
    release_id: String!
    name: String!
    alt_names: [String!]
    release_date: String
    format: [String!]
    country: String
    catalog_number: String
    liner_notes: String
    album_art: String
    status: String!
    tracks: [TrackInRelease!]
    labels: [Label!]
    master: Master
  }

  """
  Track position in a release with ordering
  """
  type TrackInRelease {
    track: Track!
    disc_number: Int
    track_number: Int!
    side: String
    is_bonus: Boolean
  }

  """
  Record label
  """
  type Label {
    label_id: String!
    name: String!
    alt_names: [String!]
    status: String!
  }

  """
  Canonical album grouping for re-releases
  """
  type Master {
    master_id: String!
    name: String!
  }

  """
  Search result union type
  """
  union SearchResult = Person | Group | Release | Track | Song

  """
  Statistics about the database
  """
  type Stats {
    nodes: NodeStats!
    enabled_services: EnabledServices!
  }

  type NodeStats {
    Person: Int
    Group: Int
    Track: Int
    Song: Int
    Release: Int
    Label: Int
    total: Int
  }

  type EnabledServices {
    ipfs: Boolean!
    s3: Boolean!
    redis: Boolean!
  }

  """
  Root Query type
  """
  type Query {
    """Get person by ID"""
    person(person_id: String!): Person

    """Get group by ID"""
    group(group_id: String!): Group

    """Get group member participation data (for RGraph)"""
    groupParticipation(group_id: String!): [Member!]

    """Get release by ID"""
    release(release_id: String!): Release

    """Get track by ID"""
    track(track_id: String!): Track

    """Get song by ID"""
    song(song_id: String!): Song

    """Search across all entity types"""
    search(query: String!, limit: Int): [SearchResult!]

    """Get database statistics"""
    stats: Stats!

    """Test database connectivity"""
    testConnectivity: Boolean!
  }
`;

export const schema = buildSchema(typeDefs);
