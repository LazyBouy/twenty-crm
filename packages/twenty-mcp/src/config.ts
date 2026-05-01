import { z } from 'zod';

const TRUTHY = new Set(['1', 'true', 'TRUE', 'yes', 'on']);

const ConfigSchema = z.object({
  twentyBaseUrl: z.string().url(),
  twentyApiKey: z.string().min(1, 'TWENTY_API_KEY is required'),
  mcpBind: z.string().default('127.0.0.1'),
  mcpPort: z.coerce.number().int().positive().default(4441),
  // When true, the proxy registers the metadata_* tool family (metadata_query,
  // metadata_create_object, metadata_create_field, metadata_create_relation,
  // metadata_apply_plan). Default false so existing deployments are
  // unchanged until explicitly opted in.
  enableMetadata: z.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const parsed = ConfigSchema.safeParse({
    twentyBaseUrl: env.TWENTY_BASE_URL,
    twentyApiKey: env.TWENTY_API_KEY,
    mcpBind: env.MCP_BIND,
    mcpPort: env.MCP_PORT,
    enableMetadata: env.TWENTY_MCP_ENABLE_METADATA
      ? TRUTHY.has(env.TWENTY_MCP_ENABLE_METADATA)
      : undefined,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid twenty-mcp configuration:\n${issues}\n\n` +
        `Set TWENTY_BASE_URL, TWENTY_API_KEY, and optionally MCP_BIND / MCP_PORT / TWENTY_MCP_ENABLE_METADATA in the environment or a .env file.`,
    );
  }

  return parsed.data;
};
