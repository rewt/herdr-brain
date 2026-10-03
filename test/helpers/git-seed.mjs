import fs from 'node:fs';
import path from 'node:path';

// Share only initial immutable bytes. Each copy owns its complete .git directory
// (including objects); no clone remotes, alternates, hardlinks or shared refs.
export function repositorySeed(parent, initialize) {
  let seed;
  return target => {
    if (!seed) {
      const directory = fs.mkdtempSync(path.join(parent, 'git-seed-'));
      try { initialize(directory); seed = directory; }
      catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
    }
    fs.cpSync(seed, target, { recursive: true, errorOnExist: true, force: false });
  };
}
