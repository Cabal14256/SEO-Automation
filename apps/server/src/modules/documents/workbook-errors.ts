/** Messages from our controlled workbook checks are safe to show; library/runtime errors are not. */
export class DocumentWorkbookError extends Error {
  readonly code = 'DOCUMENT_WORKBOOK_INVALID';
  constructor(message = '发票文件生成校验未通过。') { super(message); this.name = 'DocumentWorkbookError'; }
}
