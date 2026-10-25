import { backup, readKey, restore, verify } from './core.mjs';
import { packageRelease } from './package.mjs';

const [command, ...args] = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index += 2) {
  if (!args[index].startsWith('--') || args[index + 1] === undefined) throw new Error('Options require --name value');
  options[args[index].slice(2)] = args[index + 1];
}
function required(name) { if (!options[name]) throw new Error(`Missing --${name}`); return options[name]; }
try {
  let result;
  if (command === 'package') result = await packageRelease({ repo: required('repo'), target: required('target') });
  else if (command === 'key-init') { await readKey(required('key'), true); result = { result: 'passed', keyInitialized: true, keyNotPrinted: true }; }
  else if (command === 'backup') result = await backup(required('config'));
  else if (command === 'restore') result = await restore({ configPath: required('config'), backupPath: required('backup'), target: required('target'), port: Number(required('port')), database: required('database') });
  else if (command === 'verify') result = await verify(required('config'));
  else throw new Error('Usage: cli.mjs package|key-init|backup|restore|verify --name value');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  // Never echo command environment, DATABASE_URL, password, key or raw driver errors.
  console.error(JSON.stringify({ result: 'failed', message: error.message.startsWith('Command ') ? error.message : error.code ? `Operation failed (${error.code})` : error.message }, null, 2));
  process.exitCode = 1;
}
