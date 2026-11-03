import { posix } from "node:path";
import reylo from "reylo/esbuild";

const querySuffix = "/src/db/reylo/queries/";

/** Limit Reylo to the control-plane query directory. Other `.sql` imports keep Bun's text loader. */
export default function scopedReylo() {
  const plugin = reylo();
  return {
    name: "reylo-control-plane",
    setup(build: Parameters<typeof plugin.setup>[0]) {
      plugin.setup({
        ...build,
        onLoad(filter, callback) {
          build.onLoad(filter, async (args) => {
            const path = args.path.replaceAll("\\", "/");
            if (!posix.normalize(path).includes(querySuffix)) return undefined;
            return callback(args);
          });
        },
      });
    },
  };
}
