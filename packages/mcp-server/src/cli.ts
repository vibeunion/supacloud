export async function runCli(
    cliTools: Record<string, { schema: any; callback: (args: any) => Promise<any> }>,
    args: string[]
) {
    const toolName = args[0];
    const tool = cliTools[toolName];
    
    if (!tool) {
        console.error(`❌ Unknown command: ${toolName}`);
        console.error(`Available commands: \n  ${Object.keys(cliTools).filter(k => !['setup_help', 'deploy_web_console'].includes(k)).join("\n  ")}`);
        process.exit(1);
    }
    
    const parsedArgs: Record<string, any> = {};
    let startIdx = 1;

    // Check if there is an action argument (assuming index 1 is action if not starting with '--')
    if (args.length > 1 && !args[1].startsWith("--")) {
        parsedArgs.action = args[1];
        startIdx = 2;
    }
    
    for (let i = startIdx; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith("--") && arg.length > 2) {
            const key = arg.slice(2);
            let val: any = true;
            if (i + 1 < args.length && !args[i+1].startsWith("--")) {
                val = args[++i];
                // basic coercion
                if (val === "true") val = true;
                else if (val === "false") val = false;
                else if (!isNaN(Number(val)) && val.trim() !== '') val = Number(val);
            }
            parsedArgs[key] = val;
        }
    }
    
    try {
        const result = await tool.callback(parsedArgs);
        if (result && result.content && Array.isArray(result.content)) {
            for (const c of result.content) {
                if (c.type === "text") {
                    console.log(c.text);
                }
            }
        } else {
            console.log(JSON.stringify(result, null, 2));
        }
        process.exit(0);
    } catch (err: any) {
        console.error(`❌ Error: ${err.message}`);
        if (err.message?.includes("required")) {
            console.error(`Hint: Pass arguments like --ref YOUR_REF`);
        }
        process.exit(1);
    }
}
