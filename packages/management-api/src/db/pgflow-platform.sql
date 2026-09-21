CREATE TABLE pgflow._supacloud_state (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    version text NOT NULL,
    bundle_sha256 text NOT NULL,
    enabled boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Persist full events; NOTIFY contains only a small identifier, never business data.
CREATE TABLE pgflow._supacloud_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    topic text NOT NULL,
    event text NOT NULL,
    payload jsonb NOT NULL,
    private boolean NOT NULL
);

CREATE FUNCTION pgflow._supacloud_emit(payload jsonb, event text, topic text, private boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE event_id bigint;
BEGIN
    INSERT INTO pgflow._supacloud_events(topic, event, payload, private)
    VALUES (topic, event, payload, private) RETURNING id INTO event_id;
    PERFORM pg_catalog.pg_notify('supacloud_pgflow', event_id::text);
END;
$$;
