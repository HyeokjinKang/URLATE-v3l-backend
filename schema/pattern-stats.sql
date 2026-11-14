-- This repo has no migration tool. Apply once to the production DB before deploying,
-- then fill it with: node dist/scripts/sync-pattern-stats.js --apply

CREATE TABLE IF NOT EXISTS patternStats (
  fileName VARCHAR(255) NOT NULL,
  difficulty TINYINT UNSIGNED NOT NULL,
  notes INT UNSIGNED NOT NULL,
  judges INT UNSIGNED NOT NULL,
  requiredJudges INT UNSIGNED NOT NULL,
  bullets INT UNSIGNED NOT NULL,
  holdTicks INT UNSIGNED NOT NULL,
  holdTickWeight DOUBLE NOT NULL,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (fileName, difficulty)
);
