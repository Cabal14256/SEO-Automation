import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { admin } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';
import { ac, authRoles } from './auth-roles.js';
import { readConfig } from './config.js';
import { db } from './db/client.js';
import * as schema from './db/schema.js';
import { logError } from './errors.js';

const config = readConfig();

export const auth = betterAuth({
  appName: '发货全流程自动化系统',
  database: drizzleAdapter(db, { provider: 'pg', schema }),
  baseURL: config.BETTER_AUTH_URL,
  basePath: '/api/v1/auth',
  secret: config.BETTER_AUTH_SECRET,
  logger: {
    level: 'warn',
    log: (level, _message, ...args) => logError(`Authentication ${level}`, args.find((arg) => arg instanceof Error)),
  },
  trustedOrigins: [config.WEB_ORIGIN, config.BETTER_AUTH_URL],
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 12,
  },
  databaseHooks: {
    user: {
      create: { before: async (data) => {
        const role = (data as { role?: unknown }).role ?? 'admin';
        if (role !== 'admin') throw new APIError('FORBIDDEN', { code: 'ADMIN_ONLY', message: '系统仅支持管理员账户。' });
        return { data: { ...data, role: 'admin' } };
      } },
      update: { before: async (data, context) => {
        const update = data as { role?: unknown; banned?: unknown };
        if (update.role !== undefined && update.role !== 'admin') throw new APIError('FORBIDDEN', { code: 'ADMIN_ONLY', message: '系统仅支持管理员账户。' });
        const targetId = context?.body?.userId;
        if (update.banned === false && typeof targetId === 'string' && update.role !== 'admin') {
          const [target] = await db.select({ role: schema.user.role }).from(schema.user).where(eq(schema.user.id, targetId));
          if (target && target.role !== 'admin') throw new APIError('FORBIDDEN', { code: 'ADMIN_ONLY', message: '非管理员历史账户不能重新启用。' });
        }
        return { data };
      } },
    },
    session: { create: { before: async (data) => {
      const [account] = await db.select({ role: schema.user.role, banned: schema.user.banned }).from(schema.user).where(eq(schema.user.id, data.userId));
      if (!account || account.banned || account.role !== 'admin') throw new APIError('FORBIDDEN', { code: 'ADMIN_ONLY', message: '仅有效管理员账户可以登录。' });
      return { data };
    } } },
  },
  plugins: [admin({ defaultRole: 'admin', ac, roles: authRoles, bannedUserMessage: '账户已停用；系统仅保留管理员账户。' })],
});
