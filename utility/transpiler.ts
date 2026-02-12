import path from "path";
import fs from "fs";

const transpiler = new Bun.Transpiler({
    loader: "tsx",
});

function transpileDirectory(sourceDir: string) {
    const scripts = fs.readdirSync(sourceDir).filter((file) => file.endsWith(".ts"));

    for (const script of scripts) {
        const filePath = path.join(sourceDir, script);
        const fileContent = fs.readFileSync(filePath, "utf-8");
        const result = transpiler.transformSync(fileContent);

        if (result) {
            const outputFile = path.join(sourceDir, script.replace(".ts", ".js"));
            console.log(`✅ Transpiled ${script} → ${path.basename(outputFile)}`);

            // Token-replace known variables in script
            const envVars = [
                { key: "__VAR.GATEWAY_PORT__", value: process.env.GATEWAY_PORT as string, defaultvalue: "9999" },
                { key: "__VAR.VERSION__", value: process.env.VERSION as string, defaultvalue: "" },
                { key: "__VAR.GATEWAY_ENABLED__", value: process.env.GATEWAY_ENABLED as string, defaultvalue: "true" },
                { key: "__VAR.GATEWAY_URL__", value: process.env.GATEWAY_URL as string, defaultvalue: "http://localhost:9999" },
            ];
            let replacedResult = result; // copy result to new variable to edit it
            envVars.forEach((env) => replacedResult = replacedResult.replaceAll(env.key, env.value || env.defaultvalue) );

            fs.writeFileSync(outputFile, replacedResult);
        } else {
            console.error(`Failed to transpile ${script}`);
        }
    }
}

// Define directories to transpile
const directories = [
    path.join(import.meta.dir, "..", "public", "js", "web"),
];

// Transpile each directory
for (const dir of directories) {
    transpileDirectory(dir);
}
