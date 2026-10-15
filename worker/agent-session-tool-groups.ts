// Single source of truth for request validation and owner-only tool presets.
// UI All/group controls expand to explicit tool names at approval time.
// The backend separately supports '*' as a deliberately open-ended grant
// for all current and future enabled tools (independent of that UI shortcut).
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
export function validAgentSessionTools(value:unknown):value is string[]{
  return Array.isArray(value)
    && value.length>=1
    && value.length<=OWNER_GRANT_TOOLS.length
    && value.every(item=>typeof item==='string'&&(item==='*'||known.has(item)))
    && !(value.includes('*')&&value.length!==1)
    && new Set(value).size===value.length;
}
