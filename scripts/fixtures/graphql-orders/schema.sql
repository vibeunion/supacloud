CREATE EXTENSION pg_graphql;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
GRANT anon, authenticated TO authenticator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
COMMENT ON SCHEMA public IS '@graphql({"inflect_names":true,"introspection":true,"max_rows":100})';

CREATE TABLE public.customers (
  id integer PRIMARY KEY,
  tenant_id text NOT NULL,
  name text NOT NULL,
  email text NOT NULL,
  internal_notes text NOT NULL DEFAULT 'PRIVATE'
);
CREATE TABLE public.orders (
  id integer PRIMARY KEY,
  tenant_id text NOT NULL,
  customer_id integer NOT NULL REFERENCES public.customers(id),
  number text NOT NULL,
  status text NOT NULL DEFAULT 'processing',
  total_cents integer NOT NULL,
  internal_margin_cents integer NOT NULL DEFAULT 500
);
CREATE TABLE public.order_items (
  id integer PRIMARY KEY,
  tenant_id text NOT NULL,
  order_id integer NOT NULL REFERENCES public.orders(id),
  sku text NOT NULL,
  description text NOT NULL,
  quantity integer NOT NULL,
  unit_price_cents integer NOT NULL
);
CREATE TABLE public.deliveries (
  id integer PRIMARY KEY,
  tenant_id text NOT NULL,
  order_id integer NOT NULL REFERENCES public.orders(id),
  carrier text NOT NULL,
  tracking text NOT NULL,
  status text NOT NULL
);
COMMENT ON CONSTRAINT orders_customer_id_fkey ON public.orders
  IS '@graphql({"foreign_name":"customer","local_name":"orders"})';
COMMENT ON CONSTRAINT order_items_order_id_fkey ON public.order_items
  IS '@graphql({"foreign_name":"order","local_name":"items"})';
COMMENT ON CONSTRAINT deliveries_order_id_fkey ON public.deliveries
  IS '@graphql({"foreign_name":"order","local_name":"deliveries"})';

CREATE INDEX ON public.customers(tenant_id, id);
CREATE INDEX ON public.orders(tenant_id, id);
CREATE INDEX ON public.order_items(tenant_id, order_id);
CREATE INDEX ON public.deliveries(tenant_id, order_id);
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers FORCE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders FORCE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items FORCE ROW LEVEL SECURITY;
ALTER TABLE public.deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON public.customers FOR SELECT TO authenticated
  USING (tenant_id = current_setting('request.jwt.claims', true)::jsonb->>'tenant_id');
CREATE POLICY tenant_read ON public.orders FOR SELECT TO authenticated
  USING (tenant_id = current_setting('request.jwt.claims', true)::jsonb->>'tenant_id');
CREATE POLICY tenant_read ON public.order_items FOR SELECT TO authenticated
  USING (tenant_id = current_setting('request.jwt.claims', true)::jsonb->>'tenant_id');
CREATE POLICY tenant_read ON public.deliveries FOR SELECT TO authenticated
  USING (tenant_id = current_setting('request.jwt.claims', true)::jsonb->>'tenant_id');
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT(id, tenant_id, name, email) ON public.customers TO authenticated;
GRANT SELECT(id, tenant_id, customer_id, number, status, total_cents) ON public.orders TO authenticated;
GRANT SELECT ON public.order_items, public.deliveries TO authenticated;

CREATE SCHEMA graphql_public;
GRANT USAGE ON SCHEMA graphql, graphql_public TO anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA graphql TO anon, authenticated;
CREATE FUNCTION graphql_public.graphql(
  "operationName" text DEFAULT NULL,
  query text DEFAULT NULL,
  variables jsonb DEFAULT NULL,
  extensions jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE sql SECURITY INVOKER
AS $$ SELECT graphql.resolve(query, variables, "operationName", extensions); $$;
REVOKE ALL ON FUNCTION graphql_public.graphql(text, text, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION graphql_public.graphql(text, text, jsonb, jsonb) TO anon, authenticated;

INSERT INTO public.customers(id, tenant_id, name, email) VALUES
  (1, 'tenant-a', 'Northwind Devices', 'orders@northwind.example'),
  (2, 'tenant-b', 'Contoso Robotics', 'orders@contoso.example');
INSERT INTO public.orders(id, tenant_id, customer_id, number, total_cents)
SELECT n, CASE WHEN n <= 1000 THEN 'tenant-a' ELSE 'tenant-b' END,
  CASE WHEN n <= 1000 THEN 1 ELSE 2 END,
  'SO-' || lpad(n::text, 6, '0'), 55000
FROM generate_series(1, 2000) AS n;
INSERT INTO public.order_items(id, tenant_id, order_id, sku, description, quantity, unit_price_cents)
SELECT (o.id - 1) * 10 + n, o.tenant_id, o.id, 'MOD-' || lpad(n::text, 3, '0'),
  (ARRAY['Control board','Power module','Interface board','Sensor module','Connector kit'])[1 + (n - 1) % 5],
  n, 1000
FROM public.orders o CROSS JOIN generate_series(1, 10) AS n;
INSERT INTO public.deliveries(id, tenant_id, order_id, carrier, tracking, status)
SELECT (o.id - 1) * 2 + n, o.tenant_id, o.id, 'Demo Logistics',
  'DEMO-' || o.id || '-' || n, CASE WHEN n = 1 THEN 'delivered' ELSE 'in_transit' END
FROM public.orders o CROSS JOIN generate_series(1, 2) AS n;

-- Intentionally inconsistent synthetic relationships exercise nested RLS, not just root filters.
INSERT INTO public.order_items VALUES (90001, 'tenant-b', 1, 'PRIVATE-B', 'Other tenant item', 1, 9999);
INSERT INTO public.orders(id, tenant_id, customer_id, number, total_cents)
VALUES (90001, 'tenant-a', 2, 'CROSS-LINK-FIXTURE', 0);
ANALYZE;
