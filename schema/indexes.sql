-- URLATE-v3l-backend 권장 인덱스
--
-- 이 저장소에는 마이그레이션 도구가 없어 스키마를 코드로 관리하지 않습니다.
-- 아래는 소스의 실제 쿼리 패턴에서 도출한 인덱스이며, 운영 DB에 한 번 적용하는
-- 것을 전제로 합니다. 이미 있는 인덱스는 건너뛰어도 됩니다.
--
-- 적용 전 확인:
--   SHOW INDEX FROM trackRecords;
--   SHOW INDEX FROM users;
--
-- 큰 테이블에 인덱스를 추가하면 잠금이 걸릴 수 있습니다. MySQL 8은 대부분
-- ALGORITHM=INPLACE로 온라인 처리하지만, 트래픽이 적은 시간대를 권합니다.

-- ---------------------------------------------------------------------------
-- trackRecords
-- ---------------------------------------------------------------------------

-- 순위표 조회입니다. 가장 자주 쓰이고 가장 무거운 경로입니다.
--   GET /records/:fileName/:difficulty/:order/:sort/:nickname
--   WHERE filename = ? AND difficulty = ? AND isBest = 1 ORDER BY <col> LIMIT 100
-- 앞의 세 컬럼으로 대상을 좁힌 뒤 record로 정렬까지 인덱스로 해결합니다.
-- (order 파라미터는 화이트리스트로 5종이지만, 실제 사용은 record가 대부분입니다.)
CREATE INDEX idx_trackrecords_board
  ON trackRecords (filename, difficulty, isBest, record);

-- 개인 최고 기록 조회입니다.
--   GET /trackRecords/:nickname   WHERE nickname = ? AND isBest = 1
--   GET /record/:filename/:nickname
CREATE INDEX idx_trackrecords_user_best
  ON trackRecords (nickname, isBest, filename, difficulty);

-- rating 기준 개인 최고 기록입니다.
--   GET /bestRecords/:nickname  WHERE nickname = ? AND rating <> 0 ORDER BY rating DESC
--   기록 저장 시 같은 곡·난이도의 최고 rating 조회
CREATE INDEX idx_trackrecords_user_rating
  ON trackRecords (nickname, filename, difficulty, rating);

-- 단건 조회와 최근 플레이 목록입니다.
--   GET /record/:index          WHERE index = ?
--   GET /recentPlays/:uid       WHERE index IN (...)
-- index는 uuid 기반이라 중복이 없으므로 UNIQUE가 맞습니다.
-- 기존 데이터에 중복이 있으면 UNIQUE 생성이 실패하므로, 아래로 먼저 확인하세요.
--   SELECT `index`, COUNT(*) c FROM trackRecords GROUP BY `index` HAVING c > 1;
CREATE UNIQUE INDEX idx_trackrecords_index
  ON trackRecords (`index`);

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------

-- 세션의 userid로 조회하는 거의 모든 경로에서 쓰입니다.
--   GET /user, /auth/status, /profile/:uid, /recentPlays/:uid, 업적 처리 등
CREATE UNIQUE INDEX idx_users_userid ON users (userid);

-- 닉네임으로 조회하는 경로입니다.
--   GET /profilePic/:username, 기록 저장 시 사용자 행 잠금, 가입 시 중복 확인
CREATE UNIQUE INDEX idx_users_nickname ON users (nickname);

-- 랭킹과 rating 인덱스 재구축입니다.
--   GET /ranking/:sort/:limit   ORDER BY rating DESC LIMIT 100
--   일일 랭크 갱신            ORDER BY rating DESC (전체)
--   rating 인덱스가 비었을 때의 DB 폴백  WHERE rating > ?
CREATE INDEX idx_users_rating ON users (rating);

-- ---------------------------------------------------------------------------
-- codes
-- ---------------------------------------------------------------------------

-- 쿠폰 사용 시 행 잠금과 함께 조회합니다.
--   PUT /coupon   WHERE code = ? FOR UPDATE
CREATE UNIQUE INDEX idx_codes_code ON codes (code);

-- ---------------------------------------------------------------------------
-- 그 외
-- ---------------------------------------------------------------------------

-- CREATE INDEX idx_tracks_filename ON tracks (fileName);
-- CREATE INDEX idx_patterninfo_filename ON patternInfo (filename);
-- CREATE INDEX idx_achievements_index ON achievements (`index`);
-- CREATE INDEX idx_teamprofiles_name ON teamProfiles (name);
-- 위 네 테이블은 행 수가 적어 인덱스 없이도 문제가 되지 않습니다.
-- 곡 수가 늘어나면 앞의 둘부터 적용하세요.
