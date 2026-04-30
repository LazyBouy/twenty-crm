import { loadConfig } from '../config';

describe('loadConfig', () => {
  it('returns parsed config with defaults when only required vars are set', () => {
    const cfg = loadConfig({
      TWENTY_BASE_URL: 'http://localhost:4440',
      TWENTY_API_KEY: 'k',
    } as NodeJS.ProcessEnv);

    expect(cfg).toEqual({
      twentyBaseUrl: 'http://localhost:4440',
      twentyApiKey: 'k',
      mcpBind: '127.0.0.1',
      mcpPort: 4441,
    });
  });

  it('respects MCP_BIND and MCP_PORT overrides', () => {
    const cfg = loadConfig({
      TWENTY_BASE_URL: 'https://crm.example.com',
      TWENTY_API_KEY: 'k',
      MCP_BIND: '0.0.0.0',
      MCP_PORT: '7000',
    } as NodeJS.ProcessEnv);

    expect(cfg.mcpBind).toBe('0.0.0.0');
    expect(cfg.mcpPort).toBe(7000);
  });

  it('throws a helpful error when TWENTY_API_KEY is missing', () => {
    expect(() =>
      loadConfig({ TWENTY_BASE_URL: 'http://localhost:4440' } as NodeJS.ProcessEnv),
    ).toThrow(/TWENTY_API_KEY/);
  });

  it('throws when TWENTY_BASE_URL is not a URL', () => {
    expect(() =>
      loadConfig({ TWENTY_BASE_URL: 'not-a-url', TWENTY_API_KEY: 'k' } as NodeJS.ProcessEnv),
    ).toThrow(/twentyBaseUrl/);
  });
});
