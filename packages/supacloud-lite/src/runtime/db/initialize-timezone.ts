/** Keep every Lite database and engine session on the UTC baseline. */
export const INITIALIZE_TIMEZONE_SQL = `
do $$
begin
  execute format('alter database %I set timezone to %L', current_database(), 'UTC');
  perform set_config('TimeZone', 'UTC', false);
end $$;
`
