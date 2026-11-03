select
  id,
  ref,
  organization_id,
  name,
  status,
  region,
  created_at,
  updated_at,
  deleted_at
from projects
where ref = :ref::text
