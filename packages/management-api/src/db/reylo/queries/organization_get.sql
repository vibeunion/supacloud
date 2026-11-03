select
  id,
  name,
  slug,
  plan,
  created_at,
  updated_at
from organizations
where id = :id::uuid
