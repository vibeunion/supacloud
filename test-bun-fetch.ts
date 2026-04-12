try {
  await fetch("http://127.0.0.1:23456/test");
} catch(e) {
  console.log("ERROR MESSAGE IS:", e.message);
}
