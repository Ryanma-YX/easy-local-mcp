// MCP-only relay framing. Never accepts a destination URL from the edge.
export const MAX_BYTES = 8 * 1024 * 1024;
export const CHUNK_SIZE = 24000;
export const MAX_CONCURRENT_REQUESTS = 8;
export const MAX_CONTROL_REQUESTS = 64;
export const AGENT_SUPERSEDED_CLOSE_CODE = 4009;
export const AGENT_SUPERSEDED_CLOSE_REASON = 'Superseded by a newer agent connection';
export const CONCURRENT_READ_TOOLS = [
  'workspace_info',
  'list_workspaces',
  'list_directory',
  'workspace_tree',
  'stat_path',
  'find_files',
  'search_files',
  'read_file',
  'read_file_lines',
  'list_mcp_servers',
  'list_skills',
  'read_skill',
  'read_process',
  'list_processes'
] as const;
const concurrentReadTools=new Set<string>(CONCURRENT_READ_TOOLS);
export function isConcurrentReadRequest(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request=value as {method?:unknown;params?:{name?:unknown}};
  return request.method === 'tools/call'
    && typeof request.params?.name === 'string'
    && concurrentReadTools.has(request.params.name);
}
export interface Frame { id: string; index: number; total: number; data: string }
export function frames(id: string, value: unknown): string[] {
  const data = JSON.stringify(value);
  if (new TextEncoder().encode(data).length > MAX_BYTES) throw new Error('Relay payload exceeds 8 MiB');
  const total = Math.max(1, Math.ceil(data.length / CHUNK_SIZE));
  return Array.from({length: total}, (_, index) => JSON.stringify({id,index,total,data:data.slice(index * CHUNK_SIZE,(index + 1)*CHUNK_SIZE)}));
}
export function parseFrame(raw: string): Frame {
  if (raw.length > CHUNK_SIZE * 6 + 200) throw new Error('Oversized frame');
  const f = JSON.parse(raw);
  if (!f || typeof f.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(f.id) || !Number.isInteger(f.index) || !Number.isInteger(f.total) || f.total < 1 || f.total > 512 || f.index < 0 || f.index >= f.total || typeof f.data !== 'string' || f.data.length > CHUNK_SIZE) throw new Error('Invalid relay frame');
  return f;
}
export class Assembly {
  private parts: string[] = [];
  private total = 0;
  private bytes = 0;
  push(frame: Frame): {value: unknown} | undefined {
    if (frame.index !== this.parts.length || (this.total && this.total !== frame.total)) throw new Error('Out-of-order relay frame');
    this.total = frame.total;
    this.bytes += new TextEncoder().encode(frame.data).length;
    if (this.bytes > MAX_BYTES) throw new Error('Relay payload exceeds 8 MiB');
    this.parts.push(frame.data);
    if (this.parts.length === this.total) return {value: JSON.parse(this.parts.join(''))};
  }
}
