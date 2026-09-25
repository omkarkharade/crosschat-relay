// A stand-in for an agent harness: reads the task prompt on stdin (or from the
// file given as the first argument) and behaves according to a MODE marker.
import { readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const fromFile = process.argv[2];
const prompt = fromFile ? readFileSync(fromFile, 'utf8') : readFileSync(0, 'utf8');
const mode = /MODE:(\w+)/.exec(prompt)?.[1] ?? 'done';

switch (mode) {
  case 'block':
    console.log('BLOCKED: I need the API key for the image service.');
    break;
  case 'fail':
    console.error('harness crashed: out of memory');
    process.exit(3);
    break;
  case 'sleep':
    setTimeout(() => console.log('too late'), 60_000);
    break;
  case 'write': {
    // Writes files the way a script would, without telling the worker.
    writeFileSync('made-by-run.txt', 'hello');
    for (const dir of (process.env.CROSSCHAT_EXTRA_DIRS ?? '').split(delimiter).filter(Boolean)) writeFileSync(join(dir, 'delivered.png'), 'png');
    console.log('Wrote the files.');
    break;
  }
  case 'chatty':
    console.log('step one');
    console.error(`warning: token ${process.env.CROSSCHAT_TOKEN}`);
    console.log('All done.');
    break;
  case 'file':
    writeFileSync(process.env.CROSSCHAT_RESULT_FILE, 'Answer written to the result file.');
    console.log('noise on stdout');
    break;
  default:
    console.log(`Done by ${process.env.CROSSCHAT_AGENT} in ${process.cwd()}`);
    console.log(`token:${process.env.CROSSCHAT_TOKEN?.startsWith('ccr_') ? 'run' : 'missing'}`);
    console.log(`prompt-has-title:${prompt.includes('## Task:')}`);
}
