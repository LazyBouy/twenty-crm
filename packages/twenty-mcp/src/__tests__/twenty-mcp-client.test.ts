import { TwentyMcpClient, TwentyMcpClientError } from '../twenty-mcp-client';

const okResponse = (result: unknown): Response =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: '1', result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const errorResponse = (code: number, message: string): Response =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: '1', error: { code, message } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('TwentyMcpClient', () => {
  it('posts a JSON-RPC tools/call with Bearer auth and the given args', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(okResponse({ content: [{ type: 'text', text: 'ok' }] }));
    const client = new TwentyMcpClient({
      baseUrl: 'http://twenty.local',
      apiKey: 'secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.toolsCall('foo', { a: 1 });

    const block = result.content[0];
    if (block.type !== 'text') throw new Error('expected text block');
    expect(block.text).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://twenty.local/mcp');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer secret');
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.method).toBe('tools/call');
    expect(body.params).toEqual({ name: 'foo', arguments: { a: 1 } });
    expect(typeof body.id).toBe('string');
  });

  it('strips trailing slashes from baseUrl', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(okResponse({ content: [] }));
    const client = new TwentyMcpClient({
      baseUrl: 'http://twenty.local/',
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.toolsCall('foo', {});
    expect(fetchImpl.mock.calls[0][0]).toBe('http://twenty.local/mcp');
  });

  it('translates JSON-RPC errors into TwentyMcpClientError', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(errorResponse(-32601, 'Method not found'));
    const client = new TwentyMcpClient({
      baseUrl: 'http://twenty.local',
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.toolsCall('nope', {})).rejects.toMatchObject({
      name: 'TwentyMcpClientError',
      code: -32601,
      message: 'Method not found',
    });
  });

  it('translates HTTP failures into TwentyMcpClientError', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(new Response('boom', { status: 502, statusText: 'Bad Gateway' }));
    const client = new TwentyMcpClient({
      baseUrl: 'http://twenty.local',
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.toolsCall('foo', {})).rejects.toBeInstanceOf(TwentyMcpClientError);
    await expect(client.toolsCall('foo', {})).rejects.toMatchObject({ code: 502 });
  });
});
