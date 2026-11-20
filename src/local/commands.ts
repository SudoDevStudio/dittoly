import { defaultHome } from '../home.js';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { cleanupLocal, previewLocal } from './cleanup.js';
import { askPassphrase, backup, MaintenanceError, MIN_PASSPHRASE, restore, rotateLocalKey } from './maintenance.js';

export const MAINTENANCE_COMMANDS = new Set(['backup', 'restore', 'rotate-key', 'cleanup']);

/** `dittoly backup|restore|rotate-key|cleanup ...` for the local install. */
export async function runMaintenance(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { home: { type: 'string' }, yes: { type: 'boolean', short: 'y' } } });
  const [command, file] = positionals;
  const home = path.resolve(values.home ?? defaultHome());

  if (command === 'backup') {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const target = path.resolve(file ?? path.join(home, '..', `dittoly-backup-${stamp}.dtybackup`));
    process.stdout.write(`The backup holds your data and the key to your stored credentials, encrypted with a passphrase.\nWithout the passphrase it cannot be restored.\n`);
    const passphrase = await askPassphrase(`Passphrase (at least ${MIN_PASSPHRASE} characters): `);
    if (process.stdin.isTTY && (await askPassphrase('Repeat it: ')) !== passphrase) throw new MaintenanceError('the passphrases do not match');
    await backup(home, target, passphrase);
    process.stdout.write(`Backup written to ${target}\n`);
  } else if (command === 'restore') {
    if (!file) throw new MaintenanceError('usage: dittoly restore <file> [--home <dir>]');
    await restore(home, path.resolve(file), await askPassphrase('Passphrase: '));
    process.stdout.write(`Restored into ${home}. Start Dittoly to use it.\n`);
  } else if (command === 'rotate-key') {
    const { values: n } = await rotateLocalKey(home);
    process.stdout.write(`New master key in ${path.join(home, 'master.key')}; ${n} stored values re-encrypted.\nBackups made earlier still contain the old key, so they keep working; delete them if the old key was exposed.\n`);
  } else if (command === 'cleanup') {
    const before = await previewLocal(home);
    process.stdout.write(
      `This deletes ${before.modules} module(s), ${before.flows} Flow(s) and Super Flow(s), ${before.runs} run(s), and all apps, plans,\n` +
        `data tables, git sync, the audit log and AI usage history in ${home}, and removes what the sandboxes left on\n` +
        `this computer (Docker containers, networks, temporary folders and the images Dittoly pulled).\n` +
        `Kept: your account, teams, stored credentials, the master key and your settings.\n` +
        `It cannot be undone; \`dittoly backup\` first if you may want any of it back.\n`,
    );
    if (!values.yes) {
      if (!process.stdin.isTTY) throw new MaintenanceError('no terminal to confirm; run `dittoly cleanup --yes` to confirm without one');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question('Type "cleanup" to continue: ')).trim();
      rl.close();
      if (answer !== 'cleanup') throw new MaintenanceError('cancelled; nothing was deleted');
    }
    const r = await cleanupLocal(home);
    process.stdout.write(
      `Done: ${r.modules} module(s) and ${r.flows} Flow(s) deleted; removed ${r.containers} container(s), ${r.networks} network(s), ` +
        `${r.folders} temporary folder(s) and ${r.images.length} image(s).\n`,
    );
  } else {
    throw new MaintenanceError(`unknown command '${command}'`);
  }
}
