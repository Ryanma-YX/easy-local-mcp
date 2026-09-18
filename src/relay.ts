export const DEFAULT_PUBLIC_WORKER_URL='https://localmcp-relay.daodao973597.workers.dev';

export function validatedWorkerOrigin(value:string){
  const parsed=new URL(value);

  if(
    parsed.protocol!=='https:'
    && !(parsed.protocol==='http:'&&['localhost','127.0.0.1'].includes(parsed.hostname))
  ){
    throw new Error('Worker URL must use HTTPS');
  }

  if(
    parsed.username
    || parsed.password
    || parsed.pathname!=='/'
    || parsed.search
    || parsed.hash
  ){
    throw new Error('Worker URL must be an origin');
  }

  return parsed;
}
