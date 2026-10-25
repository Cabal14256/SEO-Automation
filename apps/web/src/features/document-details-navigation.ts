/** Scroll the editor, keeping the modal heading and footer in place. */
export function scrollDocumentFieldIntoView(element: HTMLElement) {
  const container = element.closest<HTMLElement>('.import-dialog-body');
  if (!container) return;
  // Browser focus/click scrolling can still move an overflow-hidden dialog.
  const dialog = container.closest('dialog');
  if (dialog) { dialog.scrollTop = 0; dialog.scrollLeft = 0; }
  const horizontal = element.closest<HTMLElement>('.document-box-table-scroll');
  if (horizontal) {
    const viewport = horizontal.getBoundingClientRect(), bounds = element.getBoundingClientRect();
    if (bounds.right > viewport.right) horizontal.scrollLeft += bounds.right - viewport.right + 8;
    else if (bounds.left < viewport.left) horizontal.scrollLeft -= viewport.left - bounds.left + 8;
  }
  const navigation = container.querySelector('.document-details-progress');
  const offset = (navigation?.getBoundingClientRect().height ?? 0) + 16;
  container.scrollTo({ top: container.scrollTop + element.getBoundingClientRect().top - container.getBoundingClientRect().top - offset, behavior: 'instant' });
}
