import { git, printReport } from './core.mjs';

try {
  await git(process.cwd(), ['config', 'core.hooksPath', 'scripts/privacy/hooks']);
  printReport({ result: 'passed', hook: 'scripts/privacy/hooks/pre-push', checksHistory: true });
} catch (error) { printReport({ result: 'failed', error: error.message }); process.exitCode = 1; }
