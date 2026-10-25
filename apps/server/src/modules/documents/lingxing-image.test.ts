import { describe, expect, it } from 'vitest';
import { downloadLingxingImage, isPublicImageAddress } from './lingxing-image.js';

describe('remote image snapshot boundary', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.2.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::'])('rejects private/reserved target %s', (address) => expect(isPublicImageAddress(address)).toBe(false));
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700::1111', '2a05:d018::1'])('allows publicly routable target %s', (address) => expect(isPublicImageAddress(address)).toBe(true));
  it.each(['http://images.example/a.png', `https://${['user:password', 'images.example/a.png'].join('@')}`, 'https://images.example:8443/a.png', 'https://localhost/a.png', 'https://127.0.0.1/a.png', 'https://[::1]/a.png', 'https://169.254.169.254/latest/meta-data'])('refuses forbidden URLs before issuing a request: %s', async (url) => await expect(downloadLingxingImage(url)).rejects.toThrow());
});
