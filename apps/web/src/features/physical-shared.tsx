import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { CircleAlert, CircleCheck } from 'lucide-react';
import { ApiError, type SessionResponse } from '../api';
import { messageOf, newOperation } from './batch-shared';

export function usePhysicalIdentity() {
  const client = useQueryClient();
  return client.getQueryData<SessionResponse>(['session'])?.user?.id ?? 'session';
}

export function usePhysicalAction(scope: string) {
  const userId = usePhysicalIdentity();
  const storageKey = `scm-physical-operations:${userId}:${scope}`;
  const operations = useRef<Record<string, string> | null>(null);
  if (operations.current === null) {
    try { const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? '{}'); operations.current = typeof saved === 'object' && saved !== null && !Array.isArray(saved) ? saved as Record<string, string> : {}; }
    catch { operations.current = {}; }
  }
  const client = useQueryClient();
  const [notice, setNotice] = useState('');
  const persist = () => { try { sessionStorage.setItem(storageKey, JSON.stringify(operations.current)); } catch { /* In-memory retry remains available. */ } };
  const mutation = useMutation({
    networkMode: 'always',
    mutationFn: async ({ key, action }: { key: string; action: (operationId: string) => Promise<unknown>; success: string }) => {
      if (!operations.current![key]) { operations.current![key] = newOperation(); persist(); }
      return action(operations.current![key]!);
    },
    onSuccess: async (_result, input) => {
      delete operations.current![input.key]; persist(); setNotice(input.success);
      await Promise.all([client.invalidateQueries({ queryKey: ['physical-review'] }), client.invalidateQueries({ queryKey: ['physical-history'] }), client.invalidateQueries({ queryKey: ['physical-exports'] })]);
    },
    onError: (error) => { setNotice(''); if (error instanceof ApiError && error.status === 401) void client.invalidateQueries({ queryKey: ['session'] }); },
  });
  const run = async <T,>(key: string, action: (operationId: string) => Promise<T>, success = '已保存。'): Promise<T | undefined> => {
    setNotice('');
    try { return await mutation.mutateAsync({ key, action, success }) as T; } catch { return undefined; }
  };
  return { run, hasOperation: (key: string) => Boolean(operations.current![key]), busy: mutation.isPending, pendingKey: mutation.isPending ? mutation.variables.key : undefined,
    feedback: <>{mutation.isError && <p className="form-note error-note" role="alert"><CircleAlert size={16} aria-hidden="true" />{messageOf(mutation.error)} 输入已保留；相同内容重试沿用原操作编号。</p>}{notice && <p className="form-note success-note" role="status"><CircleCheck size={16} aria-hidden="true" />{notice}</p>}</> };
}
