import { pgflowDispatcher } from "./workers/pgflow.worker";

// Optional HTTP workers only. Process workers own their recovery loop.
pgflowDispatcher.start();
const keepAlive = setInterval(() => {}, 60_000);
let stopping = false;
async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    await pgflowDispatcher.stop();
    clearInterval(keepAlive);
    process.exit(0);
}
process.once("SIGINT", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });
