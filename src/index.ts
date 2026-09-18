#!/usr/bin/env node
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config, configFilePath } from './config.js';
import { watchConfig } from './config-watch.js';
import { createServer } from './server.js';
import { McpLoader } from './mcp/loader.js';
import { loadSkills } from './skills/loader.js';
import { ProcessManager } from './process.js';
import { secureWriteFile } from './security.js';

async function ensureInitialized(force=false){
  const {access,cp,mkdir}=await import('node:fs/promises');
  const {dirname,resolve}=await import('node:path');
  const {homedir}=await import('node:os');

  const packageRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const home=resolve(homedir());
  const configDir=resolve(home,'.localmcp');
  const target=resolve(configDir,'localmcp.json');
  const skillsTarget=resolve(configDir,'skills');

  await mkdir(configDir,{recursive:true,mode:0o700});

  let created=false;

  try{
    await access(target);
  }catch(error:any){
    if(error.code!=='ENOENT')throw error;

    let workspaceRoot=resolve(process.cwd());

    if(workspaceRoot.toLowerCase()===home.toLowerCase()){
      workspaceRoot=resolve(configDir,'workspace');
      await mkdir(workspaceRoot,{recursive:true,mode:0o700});
    }

    const initialConfig={
      workspaces:{
        project:workspaceRoot
      },
      defaultWorkspace:'project',
      features:{
        files:{
          read:true,
          write:false,
          delete:false
        },
        shell:false,
        processes:false,
        externalMcp:false
      },
      skills:{
        dir:'skills',
        enabled:['local-development']
      },
      mcpServers:{}
    };

    await secureWriteFile(target,JSON.stringify(initialConfig,null,2)+'\n');
    created=true;
  }

  try{
    await access(skillsTarget);
  }catch(error:any){
    if(error.code!=='ENOENT')throw error;
    await cp(resolve(packageRoot,'skills'),skillsTarget,{recursive:true});
    created=true;
  }

  if(created||force){
    console.log(
      created
        ? `Initialized ${configDir} with secure defaults.`
        : `Already initialized: ${configDir}`
    );
  }
}

function parseUnlockMinutes(args:string[]){
  const index=args.indexOf('--minutes');

  if(index<0)return 30;

  const raw=args[index+1];
  const minutes=Number(raw);

  if(!raw||!Number.isInteger(minutes)||minutes<1||minutes>480){
    throw new Error('--minutes must be an integer from 1 to 480');
  }

  return minutes;
}

async function main(){
  const mode=process.argv[2]||'start';

  if(mode==='init'){
    await ensureInitialized(true);
    return;
  }

  if(['start','stop','reload','status','url','unlock','lock','rotate'].includes(mode)){
    const {
      control,
      status,
      printStatus,
      printUrl,
      request
    }=await import('./lifecycle.js');

    if(mode==='status'){
      printStatus(await status());
      return;
    }

    if(mode==='url'){
      printUrl(await status());
      return;
    }

    if(mode==='unlock'){
      const current=await status();

      if(current.status!=='running'){
        throw new Error('LocalMCP is stopped; start it before unlocking');
      }

      const minutes=parseUnlockMinutes(process.argv.slice(3));
      printStatus(await request('unlock',{minutes}));
      return;
    }

    if(mode==='lock'){
      const current=await status();

      if(current.status!=='running'){
        throw new Error('LocalMCP is stopped');
      }

      printStatus(await request('lock'));
      return;
    }

    if(mode==='rotate'){
      const current=await status();

      if(current.status!=='running'){
        throw new Error('LocalMCP is stopped');
      }

      printStatus(await request('rotate'));
      return;
    }

    await control(
      mode as 'start'|'stop'|'reload',
      ensureInitialized
    );
    return;
  }

  if(mode==='agent'){
    await ensureInitialized();
    await import('./agent.js');
    return;
  }

  const cfg=await config();

  if(!['stdio','http'].includes(mode)){
    throw new Error(
      'Usage: localmcp [start|status|url|unlock|lock|rotate|stop|reload|init|agent|stdio|http]'
    );
  }

  if(mode==='http'&&(!cfg.token||cfg.token.length<32)){
    throw new Error('HTTP requires LOCALMCP_TOKEN with at least 32 characters');
  }

  const mcp=new McpLoader(cfg.mcpServers);
  const skills=await loadSkills(cfg.skillsDir,cfg.enabledSkills);
  const processes=new ProcessManager();

  let runtime={
    config:cfg,
    mcp,
    skills
  };

  const retired=new Set<Promise<void>>();

  const closeWatcher=watchConfig(
    configFilePath(),
    async content=>{
      const nextConfig=await config({
        content,
        path:configFilePath()
      });

      if(JSON.stringify(nextConfig)===JSON.stringify(runtime.config)){
        return;
      }

      const nextSkills=await loadSkills(
        nextConfig.skillsDir,
        nextConfig.enabledSkills
      );

      const changedMcp=
        JSON.stringify(nextConfig.mcpServers)
        !==JSON.stringify(runtime.config.mcpServers);

      const nextMcp=changedMcp
        ? new McpLoader(nextConfig.mcpServers)
        : runtime.mcp;

      const previous=runtime;

      runtime={
        config:nextConfig,
        mcp:nextMcp,
        skills:nextSkills
      };

      if(changedMcp){
        const closing=previous.mcp
          .close()
          .finally(()=>retired.delete(closing));

        retired.add(closing);
      }

      console.error('LocalMCP configuration hot-reloaded.');
    },
    error=>console.error(
      'LocalMCP config hot-reload rejected; keeping current configuration:',
      error instanceof Error?error.message:String(error)
    )
  );

  const shutdown:Array<()=>Promise<unknown>>=[];

  if(mode==='stdio'){
    const server=await createServer(
      cfg,
      mcp,
      skills,
      processes,
      ()=>runtime
    );

    await server.connect(new StdioServerTransport());
    shutdown.push(()=>server.close());
  }else{
    const app=express();

    app.disable('x-powered-by');

    app.get('/healthz',(_req,res)=>{
      res.json({ok:true});
    });

    app.use((req,res,next)=>{
      if(req.headers.origin){
        res.sendStatus(403);
        return;
      }

      const pathToken=
        /^\/mcp\/([A-Za-z0-9_-]+)$/.exec(req.path)?.[1];

      const supplied=Buffer.from(
        pathToken
          ? `Bearer ${pathToken}`
          : req.headers.authorization||''
      );

      const expected=Buffer.from(`Bearer ${cfg.token}`);

      if(
        supplied.length!==expected.length
        || !timingSafeEqual(supplied,expected)
      ){
        res.sendStatus(404);
        return;
      }

      res.setHeader('Cache-Control','no-store');
      next();
    });

    app.use(express.json({limit:'2mb'}));

    let gate=Promise.resolve();

    app.post(['/mcp','/mcp/:token'],async(req,res)=>{
      const previous=gate;
      let release!:()=>void;

      gate=new Promise<void>(resolveGate=>{
        release=resolveGate;
      });

      await previous;

      let server:Awaited<ReturnType<typeof createServer>>|undefined;
      let transport:StreamableHTTPServerTransport|undefined;

      try{
        const active=runtime;

        server=await createServer(
          active.config,
          active.mcp,
          active.skills,
          processes,
          ()=>runtime
        );

        transport=new StreamableHTTPServerTransport({
          sessionIdGenerator:undefined,
          enableJsonResponse:true
        });

        await server.connect(transport);
        await transport.handleRequest(req,res,req.body);
      }catch{
        if(!res.headersSent){
          res.status(500).json({
            error:'MCP request failed'
          });
        }
      }finally{
        await transport?.close();
        await server?.close();
        release();
      }
    });

    app.all(['/mcp','/mcp/:token'],(_req,res)=>{
      res.setHeader('Allow','POST');
      res.sendStatus(405);
    });

    const listener=app.listen(
      cfg.port,
      '127.0.0.1',
      ()=>{
        if(process.env.LOCALMCP_INTERNAL!=='1'){
          console.error(
            `localmcp listening on http://127.0.0.1:${cfg.port}/mcp`
          );
        }
      }
    );

    listener.on('error',error=>{
      console.error(error.message);
      process.exit(1);
    });

    shutdown.push(
      ()=>new Promise<void>(
        resolveClose=>listener.close(()=>resolveClose())
      )
    );
  }

  const stop=async()=>{
    await closeWatcher();

    for(const fn of shutdown){
      await fn();
    }

    await processes.close();
    await runtime.mcp.close();
    await Promise.allSettled([...retired]);

    process.exit(0);
  };

  process.once('SIGINT',stop);
  process.once('SIGTERM',stop);
}

main().catch(error=>{
  console.error(error.message);
  process.exit(1);
});
