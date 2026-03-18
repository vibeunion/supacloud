import {} from "bun";

async function run() {
  try {
    const projectRes = await fetch("https://studio.esgfarm.cn/v1/projects/pyayjnscjk");
    const project = await projectRes.json();
    console.log("Endpoint:", project.endpoint);
    console.log("Service Key:", project.service_key);

    const storageRes = await fetch(`${project.endpoint}/storage/v1/bucket`, {
      headers: {
        "Authorization": `Bearer ${project.service_key}`,
        "apikey": project.service_key
      }
    });
    console.log("Storage Status:", storageRes.status);
    console.log("Storage Response:", await storageRes.text());
  } catch (err) {
    console.error(err);
  }
}
run();
