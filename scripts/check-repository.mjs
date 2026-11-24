import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean);
if (!files.length) throw new Error('No project files were found.');
const forbidden =
  /^(?:docs\/|design\/|CollabBoard-Design-.*\.(?:zip|sha256)$)|(?:^|\/)node_modules\/|\.(?:pem|key)$/;
const excluded = files.filter(
  (file) =>
    forbidden.test(file) ||
    (/(?:^|\/)\.env(?:\.|$)/.test(file) && !file.endsWith('.env.example')),
);
if (excluded.length)
  throw new Error(
    `Private reference files or generated dependencies are tracked: ${excluded.join(', ')}`,
  );
const nonEnglish = files.filter(
  (file) =>
    /\.(?:tsx?|m?js|json|md|css|html|ya?ml|sql)$/.test(file) &&
    existsSync(file) &&
    /[\u3400-\u9fff]/u.test(readFileSync(file, 'utf8')),
);
if (nonEnglish.length)
  throw new Error(
    `Project-provided text must be English: ${nonEnglish.join(', ')}`,
  );
console.info(
  `Repository audit passed: ${files.length} tracked or unignored files; no local requirements, design references, or secret files are included.`,
);
