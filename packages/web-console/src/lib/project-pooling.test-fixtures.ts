import { buildProjectPoolingState } from "../../../management-api/src/services/project-pooling-state";

export function poolingFixture(ref = "a", config: Record<string, unknown> = {}) {
  return buildProjectPoolingState({
    ref, config, database: { host: "db.example.test", name: `db_${ref}`, user: `user_${ref}` },
  }, { pgPort: 5544, poolerHost: "pool.example.test", poolerPort: 6644 });
}
