import { describe, expect, it } from 'vitest';
import { formatReportCodeRanges, reportTicketKey } from '@scm/contracts';

describe('report ticket presentation', () => {
  it('compresses only actual contiguous codes and retains missing allocations', () => {
    expect(formatReportCodeRanges(['A10', 'A1', 'A3', 'A4', 'A4', 'B2', 'B1', 'A9']))
      .toBe('A1、A3-A4、A9-A10、B1-B2');
    expect(formatReportCodeRanges(Array.from({ length: 10 }, (_, index) => `A${index + 1}`))).toBe('A1-A10');
    expect(formatReportCodeRanges([])).toBe('');
  });

  it('orders alphabetic prefixes like allocated codes and preserves unusual codes', () => {
    expect(formatReportCodeRanges(['AA1', 'Z1', 'AB2', 'B1', 'A10', 'A2', 'legacy-box', 'A01', '']))
      .toBe('A2、A10、B1、Z1、AA1、AB2、A01、legacy-box');
    expect(formatReportCodeRanges(['A9007199254740993', 'A9007199254740992'])).toBe('A9007199254740992-A9007199254740993');
  });

  it('joins internal groups by ticket identity, supports legacy ticket numbers and separates runs', () => {
    const row = { groupId: 'group-a', shippingRunId: 'run-a', ticketId: 'ticket-a', ticketNumber: 'number-a' };
    expect(reportTicketKey(row)).toBe(reportTicketKey({ ...row, groupId: 'group-b' }));
    expect(reportTicketKey(row)).not.toBe(reportTicketKey({ ...row, shippingRunId: 'run-b' }));
    expect(reportTicketKey({ groupId: 'group-a', ticketNumber: 'number-a' }))
      .toBe(reportTicketKey({ groupId: 'group-b', ticketNumber: 'number-a' }));
    expect(reportTicketKey({ groupId: 'group-a' })).not.toBe(reportTicketKey({ groupId: 'group-b' }));
    expect(reportTicketKey({ groupId: 'group-a', ticketId: 'number-a' }))
      .not.toBe(reportTicketKey({ groupId: 'group-a', ticketNumber: 'number-a' }));
  });
});
