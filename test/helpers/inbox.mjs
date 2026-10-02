import fs from 'node:fs';

// Keep scratch transport available until its finite owner has exited. A failed
// bounded wait preserves evidence; it never licenses a broad process signal.
export async function waitForInboxIdle(file) {
  const deadline = Date.now() + 5000;
  while (fs.existsSync(`${file}.owner.lock`) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  if (fs.existsSync(`${file}.owner.lock`)) throw new Error(`fixture inbox owner did not exit: ${file}`);
}
