import { roleSchema, type Role } from '@scm/contracts';

export function knownRole(role: unknown): Role | null {
  const parsed = roleSchema.safeParse(role);
  return parsed.success ? parsed.data : null;
}

export function canCreateDemoTask(role: unknown): boolean {
  return role === 'admin';
}
