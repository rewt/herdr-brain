import fs from 'node:fs';

// The payload stays alive until its observer acknowledges the durable notice.
export const silenceCommand = () => [process.execPath, '-e', `
  let pending='';process.stdin.setEncoding('utf8');process.stdin.on('data',data=>{
    pending+=data;let end;
    while((end=pending.indexOf('\\n'))!==-1){
      const command=pending.slice(0,end);pending=pending.slice(end+1);
      if(command==='progress')console.log('still working');
      if(command==='finish')process.exit(0);
    }
  });
`];

export function inboxNotices(inbox) {
  if (!fs.existsSync(inbox)) return [];
  // An append may be in flight; only complete records are durable witnesses.
  return fs.readFileSync(inbox, 'utf8').split('\n').slice(0, -1).filter(Boolean).map(JSON.parse).filter(row => row.type === 'notice');
}

export async function finishAfterSilence(child, { inbox, seenIds = [], quietMs = 450, waitMs: _waitMs }) {
  // Legacy waitMs is accepted without imposing an execution deadline.
  const seen = new Set(seenIds);
  let stdout = '', stderr = '', failure, quietTimer, rejectQuiet;
  let code = child.exitCode, signal = child.signalCode, exited = code != null || signal != null;
  const output = data => { stdout = (stdout + data).slice(-128); };
  const error = data => { stderr = (stderr + data).slice(-2048); };
  const exitError = message => Error(`${message}; child exited ${signal ? `on ${signal}` : `with code ${code}`}\n${stderr}`);
  const exit = (exitCode, exitSignal) => {
    exited = true; code = exitCode; signal = exitSignal;
    rejectQuiet?.(exitError('silence fixture exited before finish'));
  };
  const failed = cause => { failure ??= cause; rejectQuiet?.(failure); };
  child.stdout.on('data', output); child.stderr.on('data', error); child.once('exit', exit); child.on('error', failed);
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', failed);
  const until = async (predicate, message) => {
    for (;;) {
      if (failure) throw failure;
      if (exited) throw exitError(message);
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  try {
    let notice;
    await until(() => (notice = inboxNotices(inbox).find(row => !seen.has(row.id))), 'no new durable silence notice');
    child.stdin.write('progress\n');
    await until(() => stdout.includes('still working'), 'silence fixture progress was not forwarded');
    // The wrapper observes output before forwarding it. Start the later silent
    // interval only after that acknowledgement, never at payload startup.
    await new Promise((resolve, reject) => {
      rejectQuiet = reject;
      quietTimer = setTimeout(resolve, quietMs);
    });
    rejectQuiet = undefined;
    if (failure) throw failure;
    if (exited) throw exitError('silence fixture exited before finish');
    child.stdin.end('finish\n');
    if (failure) throw failure;
    return notice;
  } finally {
    clearTimeout(quietTimer);
    child.stdout.off('data', output); child.stderr.off('data', error); child.off('exit', exit); child.off('error', failed);
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.off('error', failed);
  }
}
