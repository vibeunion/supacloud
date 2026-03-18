import {} from "bun";

async function run() {
  try {
    const projectRes = await fetch("https://studio.esgfarm.cn/v1/projects/pyayjnscjk");
    const project = await projectRes.json();
    console.log("JWT Secret:", project.jwt_secret);
    
    // Check if the service key is valid with this secret
    const jwt = require("jsonwebtoken");
    try {
      const decoded = jwt.verify(project.service_key, project.jwt_secret);
      console.log("Service key is valid for this secret:", decoded);
    } catch (e) {
      console.error("Service key verification failed with this secret:", e.message);
    }
    
    try {
      const decodedAnon = jwt.verify(project.anon_key, project.jwt_secret);
      console.log("Anon key is valid for this secret:", decodedAnon);
    } catch (e) {
      console.error("Anon key verification failed with this secret:", e.message);
    }
  } catch (err) {
    console.error(err);
  }
}
run();
