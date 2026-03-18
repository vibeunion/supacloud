import {} from "bun";

async function run() {
  try {
    const res = await fetch("https://studio.esgfarm.cn/v1/storage/pyayjnscjk/buckets");
    console.log("Buckets:", await res.text());
  } catch (err) {
    console.error(err);
  }
}
run();
