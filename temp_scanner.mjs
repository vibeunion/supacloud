import { execSync } from "child_process";
import fs from "fs";

try {
    // 获取 e2e-test.yml 的所有历史修改补丁
    const log = execSync('git log -p -n 100 -- .github/workflows/e2e-test.yml').toString();
    fs.writeFileSync('c:\\_temp_log.txt', log);
    console.log("Log saved to temp file. Length: " + log.length);
} catch (e) {
    console.error(e);
}
