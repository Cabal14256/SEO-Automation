import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ request: mocks.request }));
import { downloadLingxingImage } from './lingxing-image.js';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
function response(bytes = pixel, headers: Record<string, string> = { 'content-type': 'image/png' }, statusCode = 200) {
  mocks.request.mockImplementation((_url, _options, callback) => {
    const request = new EventEmitter() as EventEmitter & { end: () => void };
    request.end = () => {
      const stream = Object.assign(new EventEmitter(), { headers, statusCode, destroy: vi.fn() });
      callback(stream); queueMicrotask(() => { stream.emit('data', bytes); stream.emit('end'); });
    };
    return request;
  });
}
beforeEach(() => { mocks.lookup.mockReset(); mocks.request.mockReset(); mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]); response(); });
afterEach(() => vi.useRealTimers());
describe('safe HTTPS image download transport', () => {
  it('pins the checked DNS address while keeping the original hostname for HTTPS verification', async () => {
    expect(await downloadLingxingImage('https://images.example/product.png')).toEqual({ imageBase64: pixel.toString('base64'), imageExtension: 'png' });
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    const [url, options] = mocks.request.mock.calls[0]!;
    expect(url.hostname).toBe('images.example'); expect(options.signal).toBeInstanceOf(AbortSignal);
    const callback = vi.fn(); options.lookup('images.example', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    expect(options.rejectUnauthorized).not.toBe(false);
  });
  it('rejects mixed public/private DNS answers without requesting any address', async () => {
    mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    await expect(downloadLingxingImage('https://images.example/a.png')).rejects.toThrow('内网或保留');
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('bounds DNS resolution time without starting a request', async () => {
    vi.useFakeTimers(); mocks.lookup.mockImplementation(() => new Promise(() => {}));
    const result = expect(downloadLingxingImage('https://images.example/a.png')).rejects.toThrow('域名解析超时');
    await vi.advanceTimersByTimeAsync(5000); await result;
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it.each([
    [{ 'content-type': 'image/png', location: 'https://127.0.0.1/private' }, 302],
    [{ 'content-type': 'text/html' }, 200],
    [{ 'content-type': 'image/png', 'content-length': String(2 * 1024 * 1024 + 1) }, 200],
  ] as const)('rejects redirects, unexpected MIME or oversized declared bodies', async (headers, status) => {
    response(pixel, headers, status);
    await expect(downloadLingxingImage('https://images.example/a.png')).rejects.toThrow('不超过 2 MiB');
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it('enforces the actual streaming byte limit even when content-length is missing', async () => {
    response(Buffer.alloc(2 * 1024 * 1024 + 1));
    await expect(downloadLingxingImage('https://images.example/a.png')).rejects.toThrow('超过 2 MiB');
  });
  it('rejects a truncated PNG despite a trusted MIME header and PNG signature', async () => {
    response(pixel.subarray(0, 24));
    await expect(downloadLingxingImage('https://images.example/a.png')).rejects.toThrow('完整有效');
  });
});
