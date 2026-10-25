import { describe, expect, it } from 'vitest';
import { canCreateDemoTask, knownRole } from './permissions.js';

describe('server role boundary', () => {
  it('allows only administrators and rejects legacy or unknown roles', () => {
    expect(canCreateDemoTask('admin')).toBe(true);
    expect(knownRole('admin')).toBe('admin');
    expect(canCreateDemoTask('operations')).toBe(false);
    expect(canCreateDemoTask('documentation')).toBe(false);
    expect(canCreateDemoTask('finance')).toBe(false);
    expect(canCreateDemoTask('user')).toBe(false);
    expect(canCreateDemoTask(undefined)).toBe(false);
    for (const role of ['operations', 'documentation', 'finance', 'admin,operations', null, undefined]) {
      expect(knownRole(role)).toBeNull();
    }
    expect(knownRole('user')).toBeNull();
  });
});
