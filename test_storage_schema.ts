import {} from "bun";

async function run() {
  const res = await fetch("https://studio.esgfarm.cn/v1/projects/pyayjnscjk/database/sql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql: "SELECT * FROM information_schema.tables WHERE table_schema = 'storage';" })
  });
  console.log(await res.json());
}
run();
