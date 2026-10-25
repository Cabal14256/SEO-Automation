import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { DOCUMENT_PRODUCT_IMAGE_MAX_BYTES, documentProductImageInfo } from '@scm/contracts';

const maxBytes = DOCUMENT_PRODUCT_IMAGE_MAX_BYTES;
const denied = new BlockList();
for (const [network, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) denied.addSubnet(network, bits, 'ipv4');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
const deniedV6 = new BlockList();
for (const [network, bits] of [['2001:db8::', 32], ['2001::', 32], ['2001:2::', 48], ['2001:20::', 28], ['2002::', 16]] as const) deniedV6.addSubnet(network, bits, 'ipv6');

export function isPublicImageAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !denied.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6') && !deniedV6.check(address, 'ipv6');
}

/** Downloads once while preparing a reviewed snapshot. DNS is checked and the
 * connection is pinned to a checked address, retaining hostname TLS validation.
 * Redirects, credentials and private-network image URLs are never followed. */
export async function downloadLingxingImage(value: string): Promise<{ imageBase64: string; imageExtension: 'png' | 'jpeg' }> {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('图片地址须为公开 HTTPS 地址。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || url.hash || value.length > 4000) throw new Error('图片地址须为公开 HTTPS 地址。');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || hostname.toLowerCase() === 'localhost' || hostname.toLowerCase().endsWith('.localhost')) throw new Error('图片地址不允许访问本机。');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const records = await Promise.race([
    isIP(hostname) ? Promise.resolve([{ address: hostname, family: isIP(hostname) }]) : lookup(hostname, { all: true, verbatim: true }),
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('图片域名解析超时。')), 5000); }),
  ]).finally(() => clearTimeout(timer));
  if (!records.length || records.some((record) => !isPublicImageAddress(record.address))) throw new Error('图片地址不允许访问内网或保留地址。');
  const pinned = records[0]!;
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const req = request(url, {
      method: 'GET', signal: AbortSignal.timeout(10_000), family: pinned.family,
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
      headers: { Accept: 'image/png,image/jpeg', 'User-Agent': 'SCM-document-image/1.0' },
    }, (response) => {
      if (response.statusCode !== 200 || !['image/png', 'image/jpeg'].includes(String(response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()) || Number(response.headers['content-length'] ?? 0) > maxBytes) {
        response.destroy(); reject(new Error('图片响应须为不超过 2 MiB 的 PNG/JPEG。')); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) { response.destroy(); reject(new Error('图片超过 2 MiB。')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject); req.end();
  });
  const image = documentProductImageInfo(bytes.toString('base64'));
  if (!image) throw new Error('图片内容不是完整有效的 PNG/JPEG。');
  return { imageBase64: image.base64, imageExtension: image.extension };
}
