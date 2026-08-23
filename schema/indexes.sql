-- Recommended indexes for URLATE-v3l-backend
--
-- This repo has no migration tool, so the schema isn't managed as code.
-- These are derived from the actual query patterns in the source and are
-- meant to be applied once to the production DB. Skip any that already exist.
--
-- Check before applying:
--   SHOW INDEX FROM trackRecords;
--   SHOW INDEX FROM users;
--
-- Adding an index to a large table can take a lock. MySQL 8 handles most of
-- these online via ALGORITHM=INPLACE, but a low-traffic window is still recommended.

-- ---------------------------------------------------------------------------
-- trackRecords
-- ---------------------------------------------------------------------------

-- Leaderboard lookup. The most frequent and heaviest query path.
--   GET /records/:fileName/:difficulty/:order/:sort/:nickname
--   WHERE filename = ? AND difficulty = ? AND isBest = 1 ORDER BY <col> LIMIT 100
-- Narrows to the target with the first three columns, then resolves the
-- record sort via the index too.
-- (order is a 5-value whitelist, but record accounts for most real usage.)
CREATE INDEX idx_trackrecords_board
  ON trackRecords (filename, difficulty, isBest, record);

-- Personal best lookup.
--   GET /trackRecords/:nickname   WHERE nickname = ? AND isBest = 1
--   GET /record/:filename/:nickname
CREATE INDEX idx_trackrecords_user_best
  ON trackRecords (nickname, isBest, filename, difficulty);

-- Personal best by rating.
--   GET /bestRecords/:nickname  WHERE nickname = ? AND rating <> 0 ORDER BY rating DESC
--   Looking up the best rating for the same track/difficulty on record submission
CREATE INDEX idx_trackrecords_user_rating
  ON trackRecords (nickname, filename, difficulty, rating);

-- Single-record lookup and recent play list.
--   GET /record/:index          WHERE index = ?
--   GET /recentPlays/:uid       WHERE index IN (...)
-- index is uuid-based with no duplicates, so UNIQUE is correct.
-- Creating UNIQUE fails if existing data already has duplicates -- check first with:
--   SELECT `index`, COUNT(*) c FROM trackRecords GROUP BY `index` HAVING c > 1;
CREATE UNIQUE INDEX idx_trackrecords_index
  ON trackRecords (`index`);

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------

-- Used by nearly every route that looks up by the session's userid.
--   GET /user, /auth/status, /profile/:uid, /recentPlays/:uid, achievement processing, etc.
CREATE UNIQUE INDEX idx_users_userid ON users (userid);

-- Routes that look up by nickname.
--   GET /profilePic/:username, the user row lock on record submission, duplicate check on join
CREATE UNIQUE INDEX idx_users_nickname ON users (nickname);

-- Ranking and rating index rebuild.
--   GET /ranking/:sort/:limit   ORDER BY rating DESC LIMIT 100
--   Daily rank update            ORDER BY rating DESC (all rows)
--   DB fallback when the rating index is empty  WHERE rating > ?
CREATE INDEX idx_users_rating ON users (rating);

-- ---------------------------------------------------------------------------
-- codes
-- ---------------------------------------------------------------------------

-- Looked up together with a row lock when a coupon is used.
--   PUT /coupon   WHERE code = ? FOR UPDATE
CREATE UNIQUE INDEX idx_codes_code ON codes (code);

-- ---------------------------------------------------------------------------
-- Other
-- ---------------------------------------------------------------------------

-- CREATE INDEX idx_tracks_filename ON tracks (fileName);
-- CREATE INDEX idx_patterninfo_filename ON patternInfo (filename);
-- CREATE INDEX idx_achievements_index ON achievements (`index`);
-- CREATE INDEX idx_teamprofiles_name ON teamProfiles (name);
-- The four tables above have few enough rows that skipping an index isn't a
-- problem. If the track count grows, apply the first two above first.
