-- Supacloud Global Extensions Bootstrap
-- This script runs once when the database container initializes

-- Enable commonly used extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pgjwt";

-- Enable PostGIS if available (optional)
-- CREATE EXTENSION IF NOT EXISTS "postgis";

-- Enable pg_stat_statements for query analysis
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";
