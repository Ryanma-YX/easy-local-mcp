import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

interface ManagedProcess {
  id: string;
  child: ChildProcess;
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  stdoutOffset: number;
  stderrOffset: number;
  startedAt: string;
  running: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  leaderStartTicks: string | null;
}

function linuxStartTicks(pid:number):string|null{
  try{
    const stat=readFileSync('/proc/'+pid+'/stat','utf8');
    // Fields after the parenthesized command start at field 3. Field 22 is
    // the process creation time in clock ticks since boot.
    return stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/)[19]??null;
  }catch{
    return null;
  }
}

const MAX_BUFFER = 1024 * 1024;

export class ProcessManager {
  private processes = new Map<string, ManagedProcess>();
  private shuttingDown = false;
  private cleanup?: Promise<void>;

  start(command: string, cwd: string) {
    // An in-flight MCP request must not create a new orphan during shutdown.
    if (this.shuttingDown) throw new Error('Process manager is shutting down');
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH','HOME','USER','TMPDIR','LANG','SHELL','SystemRoot']) if (process.env[key]) env[key] = process.env[key];
    const child = spawn(command, {cwd, shell: true, detached: process.platform !== 'win32', env, stdio: ['pipe','pipe','pipe'], windowsHide: process.platform === 'win32'});
    const proc: ManagedProcess = {id: randomUUID(), child, command, cwd, stdout: '', stderr: '', stdoutOffset: 0, stderrOffset: 0, startedAt: new Date().toISOString(), running: true, exitCode: null, signal: null, leaderStartTicks:process.platform==='linux'&&child.pid?linuxStartTicks(child.pid):null};
    const collect = (stream: 'stdout'|'stderr', chunk: Buffer) => {
      const text = chunk.toString('utf8');
      proc[stream] += text;
      if (Buffer.byteLength(proc[stream]) > MAX_BUFFER) {
        const excess = Buffer.byteLength(proc[stream]) - MAX_BUFFER;
        proc[stream] = Buffer.from(proc[stream]).subarray(excess).toString('utf8');
        if (stream === 'stdout') proc.stdoutOffset += excess; else proc.stderrOffset += excess;
      }
    };
    child.stdout?.on('data', c => collect('stdout', c));
    child.stderr?.on('data', c => collect('stderr', c));
    const markExited = (code: number | null, signal: NodeJS.Signals | null) => {
      proc.running = false;
      proc.exitCode = code;
      proc.signal = signal;
    };
    // Use exit for process state. On Windows, close can be delayed indefinitely
    // when descendants inherit the shell's stdio handles after the shell exits.
    child.on('exit', markExited);
    child.on('close', markExited);
    child.on('error', () => { proc.running = false; });
    this.processes.set(proc.id, proc);
    return {processId: proc.id, pid: child.pid, running: true, startedAt: proc.startedAt};
  }

  read(id: string, stdoutCursor = 0, stderrCursor = 0) {
    const proc = this.mustGet(id);
    const readOne = (text: string, base: number, cursor: number) => {
      const effective = Math.max(cursor, base);
      const data = Buffer.from(text);
      const local = Math.min(Math.max(0, effective - base), data.length);
      return {text: data.subarray(local).toString('utf8'), nextCursor: base + data.length, truncatedBeforeCursor: cursor < base};
    };
    const out = readOne(proc.stdout, proc.stdoutOffset, stdoutCursor);
    const err = readOne(proc.stderr, proc.stderrOffset, stderrCursor);
    return {processId: id, stdout: out.text, stderr: err.text, nextStdoutCursor: out.nextCursor, nextStderrCursor: err.nextCursor, stdoutTruncated: out.truncatedBeforeCursor, stderrTruncated: err.truncatedBeforeCursor, running: proc.running, exitCode: proc.exitCode, signal: proc.signal};
  }

  write(id: string, input: string) {
    const proc = this.mustGet(id);
    if (!proc.running || !proc.child.stdin || proc.child.stdin.destroyed) throw new Error('Process stdin is not available');
    proc.child.stdin.write(input);
    return {processId: id, bytes: Buffer.byteLength(input)};
  }

  stop(id: string) {
    const proc = this.mustGet(id);
    if (!proc.running) {
      // Stop any surviving background members even after the shell exited.
      if (process.platform === 'linux') this.terminate(proc, false);
      return {processId: id, running: false, exitCode: proc.exitCode, signal: proc.signal};
    }
    this.terminate(proc, false);
    return {processId: id, stopping: true};
  }

  list() {
    return [...this.processes.values()].map(proc => ({processId: proc.id, pid: proc.child.pid, command: proc.command, cwd: proc.cwd, startedAt: proc.startedAt, running: proc.running, exitCode: proc.exitCode, signal: proc.signal}));
  }

  close(): Promise<void> {
    if (this.cleanup) return this.cleanup;
    this.shuttingDown = true;
    const pending: Promise<void>[] = [];
    for (const proc of this.processes.values()) {
      // Linux shells can exit while descendants keep their original group
      // alive. Other platforms keep their previous exited-shell behavior.
      if (!proc.running && process.platform !== 'linux') continue;
      if (proc.running) pending.push(this.waitForExit(proc));
      this.terminate(proc, true);
    }
    this.cleanup = Promise.allSettled(pending).then(()=>{});
    return this.cleanup;
  }

  private terminate(proc: ManagedProcess, force: boolean) {
    try {
      if (process.platform === 'linux' && !proc.running && proc.child.pid) {
        // A dead shell's PID can eventually be recycled. Do not send a
        // process-group signal if that number now names a different leader.
        const current=linuxStartTicks(proc.child.pid);
        if(current!==null&&current!==proc.leaderStartTicks)return;
      }
      if (process.platform === 'win32' && proc.child.pid) {
        const killer = spawn(
          'taskkill',
          ['/PID', String(proc.child.pid), '/T', '/F'],
          {windowsHide: true, stdio: 'ignore'}
        );
        killer.once('error', () => {
          try { proc.child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch {}
        });
      } else if (proc.child.pid) {
        process.kill(-proc.child.pid, force ? 'SIGKILL' : 'SIGTERM');
      } else {
        proc.child.kill(force ? 'SIGKILL' : 'SIGTERM');
      }
    } catch {}
  }

  private async waitForExit(proc: ManagedProcess) {
    if (!proc.running) return;
    await new Promise<void>(resolveExit => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveExit();
      };
      const timer = setTimeout(finish, 3000);
      proc.child.once('exit', finish);
      proc.child.once('close', finish);
    });
  }

  private mustGet(id: string) {
    const proc = this.processes.get(id);
    if (!proc) throw new Error('Unknown processId');
    return proc;
  }
}
