CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] AS $$
  WITH parts AS (
    SELECT string_to_array(name, '/') AS arr
  )
  SELECT arr[1:array_length(arr, 1)-1] FROM parts;
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text AS $$
  WITH parts AS (
    SELECT string_to_array(name, '/') AS arr
  )
  SELECT arr[array_length(arr, 1)] FROM parts;
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION storage.extension(name text) RETURNS text AS $$
  WITH parts AS (
    SELECT string_to_array(name, '/') AS arr
  ),
  filename AS (
    SELECT arr[array_length(arr, 1)] AS f FROM parts
  )
  SELECT substring(f FROM '\.([^\.]*)$') FROM filename;
$$ LANGUAGE SQL STABLE;
