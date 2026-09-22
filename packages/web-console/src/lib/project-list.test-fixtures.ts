export interface ProjectFixtureRecord {
  id: string;
  ref: string;
  name: string;
  region: string;
  status: "active" | "paused" | "creating" | "deleted";
  organization_id: string;
  created_at: Date;
  updated_at: Date;
  database: { host: string; name: string; user: string };
  api: { url: string };
  studio: { url: string };
}

export function projectRecord(ref = "a"): ProjectFixtureRecord {
  return {
    id: `id-${ref}`, ref, name: `Project ${ref}`, region: "local", status: "active", organization_id: "default",
    created_at: new Date("2026-09-01T00:00:00.000Z"), updated_at: new Date("2026-09-01T00:00:00.000Z"),
    database: { host: "db.example.test", name: `db_${ref}`, user: `user_${ref}` },
    api: { url: `https://${ref}.api.example.test` }, studio: { url: `https://${ref}.studio.example.test` },
  };
}

function publicStatus(status: ProjectFixtureRecord["status"]): "ACTIVE_HEALTHY" | "INACTIVE" | "COMING_UP" {
  if (status === "creating") return "COMING_UP";
  if (status === "paused" || status === "deleted") return "INACTIVE";
  return "ACTIVE_HEALTHY";
}

export function projectListFixture(refs: string[] = ["a"]) {
  return refs.map(ref => {
    const project = projectRecord(ref);
    return {
      id: project.id, ref: project.ref, organization_id: project.organization_id,
      organization_slug: project.organization_id, name: project.name, region: project.region,
      created_at: project.created_at.toISOString(), status: publicStatus(project.status),
    };
  });
}
