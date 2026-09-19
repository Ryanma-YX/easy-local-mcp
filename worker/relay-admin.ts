interface AdminSession {
  expiresAt:string;
  createdAt:string;
}

interface ZoneRegistryEntry {
  zoneId:string;
  name:string;
  createdAt:string;
  registeredAt:string;
}

const json=(data:unknown,status=200)=>Response.json(
  data,
  {
    status,
    headers:{
      'Cache-Control':'no-store'
    }
  }
);

function internal(request:Request){
  return request.headers.get('x-localmcp-internal')==='1';
}

function validHash(value:string|null){
  return !!value&&/^[a-f0-9]{64}$/.test(value);
}

function validUuid(value:string){
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export class RelayAdmin {
  constructor(private ctx:DurableObjectState){}

  private async pruneSessions(){
    const sessions=await this.ctx.storage.list<AdminSession>({
      prefix:'session:'
    });
    const now=Date.now();
    const expired:string[]=[];

    for(const [key,session] of sessions){
      if(Date.parse(session.expiresAt)<=now){
        expired.push(key);
      }
    }

    if(expired.length){
      await this.ctx.storage.delete(expired);
    }
  }

  async fetch(request:Request):Promise<Response>{
    if(!internal(request)){
      return new Response(null,{status:404});
    }

    const url=new URL(request.url);

    if(url.pathname==='/session/create'&&request.method==='POST'){
      const hash=request.headers.get('x-session-hash');
      const expiresAt=request.headers.get('x-session-expires-at');

      if(!validHash(hash)||!expiresAt){
        return json({error:'Invalid session'},400);
      }

      const expiry=Date.parse(expiresAt);
      const now=Date.now();

      if(
        !Number.isFinite(expiry)
        || expiry<=now
        || expiry>now+24*60*60*1000
      ){
        return json({error:'Invalid session expiry'},400);
      }

      await this.pruneSessions();

      const sessions=await this.ctx.storage.list<AdminSession>({
        prefix:'session:'
      });

      if(sessions.size>=32){
        const ordered=Array.from(sessions.entries())
          .sort(
            (left,right)=>
              Date.parse(left[1].createdAt)-Date.parse(right[1].createdAt)
          );

        const remove=ordered
          .slice(0,Math.max(1,ordered.length-31))
          .map(([key])=>key);

        if(remove.length){
          await this.ctx.storage.delete(remove);
        }
      }

      const session:AdminSession={
        expiresAt:new Date(expiry).toISOString(),
        createdAt:new Date().toISOString()
      };

      await this.ctx.storage.put(`session:${hash}`,session);

      return json({
        ok:true,
        expiresAt:session.expiresAt
      },201);
    }

    if(url.pathname==='/session/check'&&request.method==='GET'){
      const hash=request.headers.get('x-session-hash');
      if(!validHash(hash)){
        return new Response(null,{status:404});
      }

      const key=`session:${hash}`;
      const session=await this.ctx.storage.get<AdminSession>(key);

      if(!session){
        return new Response(null,{status:404});
      }

      if(Date.parse(session.expiresAt)<=Date.now()){
        await this.ctx.storage.delete(key);
        return new Response(null,{status:404});
      }

      return json({
        ok:true,
        expiresAt:session.expiresAt
      });
    }

    if(url.pathname==='/session/delete'&&request.method==='POST'){
      const hash=request.headers.get('x-session-hash');
      if(validHash(hash)){
        await this.ctx.storage.delete(`session:${hash}`);
      }

      return json({ok:true});
    }

    if(url.pathname==='/zones'&&request.method==='GET'){
      const entries=await this.ctx.storage.list<ZoneRegistryEntry>({
        prefix:'zone:'
      });

      const zones=Array.from(entries.values())
        .sort((left,right)=>left.name.localeCompare(right.name));

      return json({zones});
    }

    const zoneMatch=/^\/zones\/([0-9a-f-]{36})$/.exec(url.pathname);

    if(zoneMatch&&request.method==='PUT'){
      const zoneId=zoneMatch[1];
      if(!validUuid(zoneId)){
        return json({error:'Invalid Zone ID'},400);
      }

      let body:Record<string,unknown>;
      try{
        body=await request.json() as Record<string,unknown>;
      }catch{
        return json({error:'Invalid JSON'},400);
      }

      const name=
        typeof body.name==='string'
          ? body.name.trim()
          : '';

      const createdAt=
        typeof body.createdAt==='string'
          ? body.createdAt
          : '';

      if(
        !name
        || name.length>80
        || !Number.isFinite(Date.parse(createdAt))
      ){
        return json({error:'Invalid Zone metadata'},400);
      }

      const existing=await this.ctx.storage.get<ZoneRegistryEntry>(
        `zone:${zoneId}`
      );

      const entry:ZoneRegistryEntry={
        zoneId,
        name,
        createdAt:new Date(Date.parse(createdAt)).toISOString(),
        registeredAt:existing?.registeredAt??new Date().toISOString()
      };

      await this.ctx.storage.put(`zone:${zoneId}`,entry);
      return json({ok:true,zone:entry});
    }

    if(zoneMatch&&request.method==='DELETE'){
      await this.ctx.storage.delete(`zone:${zoneMatch[1]}`);
      return json({ok:true});
    }

    return json({error:'Not found'},404);
  }
}
