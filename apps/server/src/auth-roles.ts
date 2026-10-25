import { createAccessControl } from 'better-auth/plugins/access';
import { adminAc, defaultStatements } from 'better-auth/plugins/admin/access';

const ac = createAccessControl(defaultStatements);

export const authRoles = {
  admin: ac.newRole(adminAc.statements),
};

export { ac };
