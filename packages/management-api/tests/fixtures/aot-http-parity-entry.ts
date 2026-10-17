import { app } from "./aot-http-parity-app";

app.listen({ hostname: "127.0.0.1", port: 0 });
console.log(`PARITY_READY=${app.server!.port}`);
