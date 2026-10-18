// Single source of truth for request snapshots and owner-selected tool grants.
// All and Read request presets are expanded to explicit currently known names
// before storage. Existing approved '*' sessions remain valid, but new
// wildcard requests, approvals and edits are intentionally unsupported.
export const OWNER_TOOL_GROUPS={
  Read:[
    'workspace_info','list_workspaces','list_directory','workspace_tree',
    'stat_path','find_files','search_files','read_file','read_file_lines',
    'list_skills','read_skill'
  ],
  Write:[
    'write_file','edit_file','apply_patch','create_directory'
  ],
  Delete:[
    'delete_path','move_path'
  ],
  Execute:[
    'run_command','start_process','read_process','write_process',
    'stop_process','list_processes'
  ],
  'External MCP':[
    'list_mcp_servers','list_mcp_tools','call_mcp_tool'
  ]
} as const;

export const OWNER_GRANT_TOOLS=[...new Set(
  Object.values(OWNER_TOOL_GROUPS).flat()
)];
const known=new Set<string>(OWNER_GRANT_TOOLS);
// Only explicit current tool names can be newly stored as a grant.
export function validAgentSessionTools(value:unknown):value is string[]{
  return Array.isArray(value)
    && value.length>=1
    && value.length<=OWNER_GRANT_TOOLS.length
    && value.every(item=>typeof item==='string'&&known.has(item))
    && new Set(value).size===value.length;
}

// Presets never survive into storage: even when tools is omitted, approval
// grants exactly the tool names captured when the request was received.
export function normalizeRequestedAgentSessionTools(value:unknown):string[]|null{
  if(value===undefined)return [...OWNER_GRANT_TOOLS];
  if(Array.isArray(value)&&value.length===1){
    if(value[0]==='all')return [...OWNER_GRANT_TOOLS];
    if(value[0]==='read')return [...OWNER_TOOL_GROUPS.Read];
  }
  return validAgentSessionTools(value)?[...value]:null;
}
