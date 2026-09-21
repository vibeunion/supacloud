import { publicProjectList } from "../../../management-api/src/services/project-list-response";
import type { ProjectResponse } from "../../../management-api/src/services/project.service";

export function projectRecord(ref = "a"): ProjectResponse {
  return {
    id: `id-${ref}`, ref, name: `Project ${ref}`, region: "local", status: "active", organization_id: "default",
    created_at: new Date("2026-09-01T00:00:00.000Z"), updated_at: new Date("2026-09-01T00:00:00.000Z"),
    database: { host: "db.example.test", name: `db_${ref}`, user: `user_${ref}` },
    api: { url: `https://${ref}.api.example.test` }, studio: { url: `https://${ref}.studio.example.test` },
  };
}
export function projectListFixture(refs: string[] = ["a"]) {
  return publicProjectList(refs.map(ref => projectRecord(ref)));
}
