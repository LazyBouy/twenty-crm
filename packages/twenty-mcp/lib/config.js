"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = void 0;
const zod_1 = require("zod");
const ConfigSchema = zod_1.z.object({
    twentyBaseUrl: zod_1.z.string().url(),
    twentyApiKey: zod_1.z.string().min(1, 'TWENTY_API_KEY is required'),
    mcpBind: zod_1.z.string().default('127.0.0.1'),
    mcpPort: zod_1.z.coerce.number().int().positive().default(4441),
});
const loadConfig = (env = process.env) => {
    const parsed = ConfigSchema.safeParse({
        twentyBaseUrl: env.TWENTY_BASE_URL,
        twentyApiKey: env.TWENTY_API_KEY,
        mcpBind: env.MCP_BIND,
        mcpPort: env.MCP_PORT,
    });
    if (!parsed.success) {
        const issues = parsed.error.issues
            .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('\n');
        throw new Error(`Invalid twenty-mcp configuration:\n${issues}\n\n` +
            `Set TWENTY_BASE_URL, TWENTY_API_KEY, and optionally MCP_BIND / MCP_PORT in the environment or a .env file.`);
    }
    return parsed.data;
};
exports.loadConfig = loadConfig;
//# sourceMappingURL=config.js.map