import { documentCountryCode, hasCompleteDocumentAddress, hasDocumentAddressConflict, resolveDocumentLingxingAddress, type DocumentRevisionData } from '@scm/contracts';

export type DocumentAddressCodeCatalog = {
  sha256: string;
  sourceLabel: string;
  rows: Array<{ sourceRow: number; values: Record<string, string>; issues: string[]; hasFormula: boolean }>;
};
export type DocumentAddressCodeResolution = {
  status: 'resolved' | 'needs_review';
  code: string;
  source: 'lingxing_fc' | 'lingxing_explicit' | 'freight_reference' | 'manual' | 'unresolved';
  reason: string;
  sourceSnapshotIds: string[];
  sourceRows: number[];
  catalogSha256?: string;
};

const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const normalized = (value: unknown) => text(value).normalize('NFKC').replace(/\s+/g, ' ').toUpperCase();
const country = (value: unknown) => documentCountryCode(normalized(value));
const geographicFields = ['countryCode', 'addressLine1', 'addressLine2', 'addressLine3', 'city', 'state', 'postalCode'] as const;
const geographicKey = (values: Readonly<Record<string, unknown>>) => JSON.stringify(geographicFields.map((key) => key === 'countryCode' ? country(values[key]) ?? normalized(values[key]) : normalized(values[key])));
const completeGeography = (values: Readonly<Record<string, unknown>>) => ['addressLine1', 'city', 'postalCode'].every((key) => Boolean(normalized(values[key]))) && Boolean(country(values.countryCode));
const unique = (values: string[]) => [...new Set(values)].sort();

/** Resolve only B3. Shipment streets and local address profiles are never changed. */
export function resolveDocumentAddressCode(data: Pick<DocumentRevisionData, 'fields' | 'members'>, catalog: DocumentAddressCodeCatalog | null = null): DocumentAddressCodeResolution {
  const trusted = data.members.map((member) => (member.sourceCandidates?.addresses ?? []).filter((candidate) => ['listShipments', 'getShipmentDetails'].includes(candidate.source)));
  const sourceSnapshotIds = unique(trusted.flat().map((candidate) => candidate.snapshotId));
  const result = (status: DocumentAddressCodeResolution['status'], code: string, source: DocumentAddressCodeResolution['source'], reason: string, sourceRows: number[] = []): DocumentAddressCodeResolution => ({
    status, code, source, reason, sourceSnapshotIds, sourceRows: [...new Set(sourceRows)].sort((left, right) => left - right), ...(catalog ? { catalogSha256: catalog.sha256 } : {}),
  });
  const review = (reason: string, sourceRows: number[] = []) => result('needs_review', '', 'unresolved', reason, sourceRows);

  if (data.fields.addressSelectionMode === 'manual') {
    if (text(data.fields.addressCode) && data.fields.addressConfirmed === 'true' && text(data.fields.addressConfirmationReason) && hasCompleteDocumentAddress(data.fields)) {
      return result('resolved', text(data.fields.addressCode), 'manual', `保留本票人工核实的地址代码：${text(data.fields.addressConfirmationReason)}`);
    }
    return review('本票采用人工地址，请补齐地址代码、完整收件地址和核对原因后明确确认；系统不会代为确认。');
  }
  if (!data.members.length || trusted.some((candidates) => !candidates.some((candidate) => normalized(candidate.data.destinationFc)))) {
    return review('每个 FBA 都须有可核验的领星原始物流中心编码，请刷新来源或人工核实本票地址代码。');
  }
  const memberCountries = data.members.map((member) => country(member.demand.snapshot.country));
  if (memberCountries.some((value) => !value) || new Set(memberCountries).size !== 1) return review('本票来源国家缺失、无法识别或跨国家，不能自动填写地址代码。');
  const expectedCountry = memberCountries[0]!;
  if (normalized(data.fields.countryCode) && country(data.fields.countryCode) !== expectedCountry) return review('本票收件国家与货件国家不一致，请人工核实地址代码。');
  if (trusted.some((candidates) => !candidates.some((candidate) => country(candidate.data.countryCode) === expectedCountry)
    || candidates.some((candidate) => normalized(candidate.data.countryCode) && country(candidate.data.countryCode) !== expectedCountry))) {
    return review('领星地址国家缺失或与本票范围不一致，不能自动填写地址代码。');
  }
  const candidates = trusted.flat(), codes = unique(candidates.map((candidate) => normalized(candidate.data.destinationFc)).filter(Boolean));
  if (codes.length !== 1) return review('领星列表、详情或不同 FBA 的物流中心编码不一致，请拆票或人工核实。');
  if (hasDocumentAddressConflict(candidates.map((candidate) => candidate.data))) return review('领星来源的完整地址存在不同非空值，请先核实本票采用地址。');
  const sourceAddress = resolveDocumentLingxingAddress(data.members);
  if (!sourceAddress) return review('每个 FBA 都须有自身完整且无冲突的领星收件地址，不能借用另一货件的街道或地址资料补齐。');
  if (geographicKey(data.fields) !== geographicKey(sourceAddress)) return review('本票最终地理地址与完整领星来源不一致，请采用领星地址，或按人工地址方式核实编码并明确确认。');
  const fc = codes[0]!, explicit = unique(candidates.map((candidate) => normalized(candidate.data.addressCode)).filter(Boolean));
  if (explicit.length > 1) return review('领星来源返回了不同地址代码，请人工核实本票采用值。');
  const group = catalog?.rows.filter((row) => country(row.values.countryCode) === expectedCountry && (normalized(row.values.destinationFc) || normalized(row.values.fc)) === fc) ?? [];
  const groupRows = group.map((row) => row.sourceRow);
  // Multiple addresses for one FC are valid reference candidates. Formula/error
  // rows remain uncertain evidence and must not silently fall back to the FC.
  if (group.some((row) => row.hasFormula || row.issues.some((issue) => issue !== 'ADDRESS_FC_CONFLICT'))) return review('对应货代参考地址含公式或未解决资料问题，请核对原始参考行后人工确认。', groupRows);
  const special = group.some((row) => normalized(row.values.addressCode) !== fc || !completeGeography(row.values)) || new Set(group.map((row) => geographicKey(row.values))).size > 1 || Boolean(explicit[0] && explicit[0] !== fc);
  if (!special) return result('resolved', explicit[0] ?? fc, explicit.length ? 'lingxing_explicit' : 'lingxing_fc', explicit.length ? '采用与领星物流中心编码一致的显式地址代码。' : '采用经领星原始快照核验且所有货件一致的物流中心编码。');
  if (!group.length) return review('领星显式地址代码不同于物流中心编码，缺少可核验的货代参考映射，请人工确认。');
  if (!completeGeography(data.fields)) return review('该物流中心对应特殊编码或多个地址，须先补齐完整本票地址以核对货代参考记录。', groupRows);
  const matched = group.filter((row) => completeGeography(row.values) && geographicKey(row.values) === geographicKey(data.fields));
  const matchedCodes = unique(matched.map((row) => normalized(row.values.addressCode)).filter(Boolean));
  if (matched.some((row) => !normalized(row.values.addressCode)) || matchedCodes.length !== 1) return review('完整本票地址未唯一匹配到一个货代地址代码，请人工核实；不会回退物流中心编码。', matched.length ? matched.map((row) => row.sourceRow) : groupRows);
  if (explicit[0] && explicit[0] !== matchedCodes[0]) return review('领星显式地址代码与完整地址匹配的货代参考编码不一致，请人工确认。', matched.map((row) => row.sourceRow));
  return result('resolved', matchedCodes[0]!, 'freight_reference', `按完整领星地址唯一匹配已指定版本的货代参考编码：${catalog!.sourceLabel}`, matched.map((row) => row.sourceRow));
}
