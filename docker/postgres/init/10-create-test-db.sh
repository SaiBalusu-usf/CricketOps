#!/bin/sh
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
SELECT 'CREATE DATABASE ${POSTGRES_TEST_DB:-icat_cricket_test}'
WHERE NOT EXISTS (
  SELECT FROM pg_database WHERE datname = '${POSTGRES_TEST_DB:-icat_cricket_test}'
)\gexec
SQL
