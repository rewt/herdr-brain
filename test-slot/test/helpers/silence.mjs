import fs from 'node:fs';

// The payload stays alive until its observer acknowledges the durable notice.
// The alarm bounds a broken handshake, rather than scheduling a successful exit.
export const silenceCommand = () => [process.execPath, '-e', `
  const alarm=setTimeout(()=>{console.error('silence fixture handshake expired');process.exit(1);},10000);
  let pending='';process.stdin.setEncoding('utf8');process.stdin.on('data',data=>{
    pending+=data;let end;
    while((end=pending.indexOf('\\n'))!==-1){
      const command=pending.slice(0,end);pending=pending.slice(end+1);
      if(command==='progress')console.log('still working');
      if(command==='finish'){clearTimeout(alarm);process.exit(0);}
    }
  });
`];

export function inboxNotices(inbox) {
  if (!fs.existsSync(inbox)) return [];
  // An append may be in flight; only complete records are durable witnesses.
  return fs.readFileSync(inbox, 'utf8').split('\n').slice(0, -1).filter(Boolean).map(JSON.parse).filter(row => row.type === 'notice');
}

export async function finishAfterSilence(child, { inbox, seenIds = [], quietMs = 450, waitMs = 5000 }) {
  const seen = new Set(seenIds), deadline = performance.now() + waitMs;
  let stdout = '', stderr = '', exited = false;
  const output = data => { stdout = (stdout + data).slice(-128); };
  const error = data => { stderr = (stderr + data).slice(-2048); };
  const exit = () => { exited = true; };
  child.stdout.on('data', output); child.stderr.on('data', error); child.once('exit', exit);
  const until = async (predicate, message) => {
    while (!predicate()) {
      if (exited || performance.now() >= deadline) throw Error(`${message}\n${stderr}`);
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
    await new Promise(resolve => setTimeout(resolve, quietMs));
    child.stdin.end('finish\n');
    return notice;
  } finally {
    child.stdout.off('data', output); child.stderr.off('data', error); child.off('exit', exit);
  }
}
