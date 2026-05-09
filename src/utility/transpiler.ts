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

            const envVars = [
                { key: "__VAR.GATEWAY_PORT__", value: process.env.GATEWAY_PORT as string, defaultvalue: "9999" },
                { key: "__VAR.VERSION__", value: process.env.VERSION as string, defaultvalue: "" },
                { key: "__VAR.GATEWAY_ENABLED__", value: process.env.GATEWAY_ENABLED as string, defaultvalue: "true" },
                { key: "__VAR.GATEWAY_URL__", value: process.env.GATEWAY_URL as string, defaultvalue: "http://localhost:9999" },
                { key: "__VAR.PLAYER_Z_INDEX__", value: process.env.PLAYER_Z_INDEX as string, defaultvalue: "4" },
            ];
            let replacedResult = result;
            envVars.forEach((env) => replacedResult = replacedResult.replaceAll(env.key, env.value || env.defaultvalue) );

            fs.writeFileSync(outputFile, replacedResult);
        } else {
            console.error(`Failed to transpile ${script}`);
        }
    }
}

const directories = [
    path.join(import.meta.dir, "..", "webserver", "public", "js", "web"),
];

for (const dir of directories) {
    transpileDirectory(dir);
}
