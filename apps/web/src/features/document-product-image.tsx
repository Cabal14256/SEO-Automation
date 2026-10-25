import { useEffect, useId, useMemo, useState } from 'react';
import { ImagePlus, Link, RotateCcw, Trash2 } from 'lucide-react';
import { DOCUMENT_PRODUCT_IMAGE_MAX_BYTES, documentProductImageInfo } from '@scm/contracts';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { messageOf } from './batch-shared';

export type ProductImageSnapshot = { imageBase64: string; imageExtension: 'png' | 'jpeg' };

function imageSource(base64: string) {
  const image = documentProductImageInfo(base64);
  return image ? `data:image/${image.extension};base64,${image.base64}` : '';
}

async function readImage(file: File): Promise<ProductImageSnapshot> {
  if (!file.size || file.size > DOCUMENT_PRODUCT_IMAGE_MAX_BYTES) throw new Error('请选择不超过 2 MiB 的 PNG 或 JPEG 图片。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!png && !jpeg) throw new Error('图片内容须为 PNG 或 JPEG，请重新选择。');
  const imageBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' && reader.result.includes(',') ? resolve(reader.result.split(',')[1]!) : reject(new Error('无法读取图片，请重新选择。'));
    reader.onerror = () => reject(new Error('无法读取图片，请重新选择。'));
    reader.readAsDataURL(file);
  });
  const imageExtension = png ? 'png' : 'jpeg';
  return { imageBase64, imageExtension };
}

export function DocumentProductImage({ imageBase64, disabled, ticket = false, hasOverride = false, change, restore, fetchFromUrl, onBusyChange }: {
  imageBase64: string;
  disabled: boolean;
  ticket?: boolean;
  hasOverride?: boolean;
  change: (image: ProductImageSnapshot | null) => void;
  restore?: () => void;
  fetchFromUrl?: (url: string) => Promise<ProductImageSnapshot>;
  onBusyChange: (busy: boolean) => void;
}) {
  const id = useId();
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [previewFailed, setPreviewFailed] = useState(false);
  useEffect(() => setPreviewFailed(false), [imageBase64]);
  const source = useMemo(() => imageSource(imageBase64), [imageBase64]), hasImage = Boolean(source && !previewFailed);
  const run = async (load: () => Promise<ProductImageSnapshot>) => {
    setError(''); setNotice(''); setLoading(true); onBusyChange(true);
    try {
      const image = await load();
      const info = documentProductImageInfo(image.imageBase64);
      if (!info || info.extension !== image.imageExtension) throw new Error('图片内容无效，请重新导出为 PNG 或 JPEG 后上传。');
      const preview = new Image(); preview.src = `data:image/${info.extension};base64,${info.base64}`;
      await preview.decode().catch(() => { throw new Error('图片无法解码，请重新导出为 PNG 或 JPEG 后上传。'); });
      change({ imageBase64: info.base64, imageExtension: info.extension });
      setNotice(ticket ? '图片已加入本票修改，请保存资料修订。' : '图片已读取，请保存资料版本。');
    } catch (cause) { setError(messageOf(cause)); }
    finally { setLoading(false); onBusyChange(false); }
  };
  return <section className="document-product-image" aria-labelledby={`${id}-heading`}>
    <div className="document-product-image-controls">
      <h4 id={`${id}-heading`}>商品图片（可选）</h4>
      <p className="mapping-help">PNG 或 JPEG，单张不超过 2 MiB。{ticket ? '本票手动图片合计不超过 8 MiB，同一商品应用于全部 FBA，保存修订后生效。' : '图片随公共资料版本保存。'}</p>
      <div className="field"><label htmlFor={`${id}-file`}><ImagePlus size={15} aria-hidden="true" />选择商品图片</label><input id={`${id}-file`} className="document-file-input" type="file" accept="image/png,image/jpeg" disabled={disabled || loading} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void run(() => readImage(file)); }} /></div>
      {fetchFromUrl && <div className="field document-image-url"><label htmlFor={`${id}-url`}>图片直链 URL</label><div><Input id={`${id}-url`} type="url" value={url} maxLength={4000} placeholder="https://…/product.png" disabled={disabled || loading} onChange={(event) => setUrl(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }} /><Button type="button" icon={Link} loading={loading} disabled={disabled || loading || !url.trim()} onClick={() => void run(() => fetchFromUrl(url.trim()))}>读取图片</Button></div><p className="mapping-help">填写可公开访问的 HTTPS 图片直链，点击读取后保存图片快照。</p></div>}
      <div className="document-footer-actions"><Button type="button" icon={Trash2} variant="text" disabled={disabled || loading || !imageBase64} onClick={() => { change(null); setError(''); setNotice(ticket ? '已移除本票图片，公共资料保持原图；保存修订后生效。' : '已清空图片，请保存资料版本。'); }}>{ticket ? '移除本票图片' : '清空图片'}</Button>{restore && <Button type="button" icon={RotateCcw} variant="text" disabled={disabled || loading || !hasOverride} onClick={() => { restore(); setError(''); setNotice('已恢复采用引用资料中的图片，请保存资料修订。'); }}>恢复引用图片</Button>}</div>
      {!hasImage && <p className="mapping-help">{imageBase64 ? '当前图片无法用于出单，可重新上传或读取。' : '暂无图片。'}仍可生成待复核 XLSX，图片列将留空。</p>}
      {error && <p className="form-note error-note" role="alert">{error} 原有图片未更改。</p>}
      {notice && <p className="form-note" role="status">{notice}</p>}
    </div>
    {hasImage && <img src={source} alt="商品申报图片预览" onError={() => setPreviewFailed(true)} />}
  </section>;
}
