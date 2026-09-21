export function homePage():Response{
  return new Response(HOME_HTML,{
    status:200,
    headers:{
      'Content-Type':'text/html; charset=utf-8',
      'Cache-Control':'public, max-age=300',
      'X-Content-Type-Options':'nosniff',
      'Referrer-Policy':'no-referrer',
      'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    }
  });
}

const HOME_HTML=String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Easy Local MCP · Secure Local Relay</title>
<style>
:root{
  font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  color:#f7f9ff;background:#05070d
}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:#05070d}
body{
  min-height:100vh;overflow-x:hidden;
  background:
    radial-gradient(circle at 50% 34%,rgba(86,94,255,.22),transparent 29rem),
    radial-gradient(circle at 12% 16%,rgba(24,198,255,.11),transparent 25rem),
    radial-gradient(circle at 89% 83%,rgba(162,77,255,.11),transparent 29rem),
    #05070d;
  color:#f7f9ff
}
body:before{
  content:"";position:fixed;inset:0;pointer-events:none;opacity:.24;
  background-image:
    linear-gradient(rgba(255,255,255,.024) 1px,transparent 1px),
    linear-gradient(90deg,rgba(255,255,255,.024) 1px,transparent 1px);
  background-size:42px 42px;
  mask-image:linear-gradient(to bottom,#000,transparent 86%)
}
.shell{
  position:relative;min-height:100vh;max-width:1280px;margin:auto;padding:28px 34px 24px;
  display:grid;grid-template-rows:auto 1fr auto
}
nav{display:flex;align-items:center;justify-content:space-between;gap:22px;position:relative;z-index:5}
.brand{display:flex;align-items:center;gap:12px;font-weight:780;letter-spacing:-.025em}
.mark{
  position:relative;width:34px;height:34px;border-radius:11px;
  background:linear-gradient(145deg,#91d5ff,#756fff 56%,#d172ff);
  box-shadow:0 0 34px rgba(116,119,255,.38)
}
.mark:before,.mark:after{content:"";position:absolute;border:1px solid rgba(255,255,255,.82);border-radius:50%}
.mark:before{inset:8px 6px}.mark:after{inset:6px 11px}
.nav-actions{display:flex;gap:9px}
.nav-link{
  height:40px;display:inline-flex;align-items:center;padding:0 15px;border-radius:999px;
  text-decoration:none;color:#dce2f2;font-size:14px;border:1px solid rgba(255,255,255,.10);
  background:rgba(255,255,255,.035);backdrop-filter:blur(12px)
}
.nav-link:hover{background:rgba(255,255,255,.07)}
main{
  display:grid;grid-template-columns:minmax(0,.9fr) minmax(470px,1.1fr);
  align-items:center;gap:26px;padding:48px 0 34px
}
.copy{position:relative;z-index:4}
.eyebrow{
  display:inline-flex;align-items:center;gap:8px;padding:7px 11px;border-radius:999px;
  border:1px solid rgba(143,164,255,.18);background:rgba(119,133,255,.06);
  color:#bacaff;font-size:12px;font-weight:780;letter-spacing:.08em;text-transform:uppercase
}
.dot{width:7px;height:7px;border-radius:50%;background:#79e8c3;box-shadow:0 0 15px #70dfbd}
h1{
  max-width:720px;margin:22px 0 18px;font-size:clamp(48px,6vw,86px);
  line-height:.98;letter-spacing:-.055em;font-weight:800
}
.gradient{
  background:linear-gradient(100deg,#fff 7%,#bbcaff 49%,#bd8bff 94%);
  -webkit-background-clip:text;background-clip:text;color:transparent
}
.lead{max-width:600px;margin:0;color:#aeb6ca;font-size:clamp(17px,1.55vw,21px);line-height:1.65}
.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:30px}
.button{
  display:inline-flex;align-items:center;gap:9px;padding:13px 18px;border-radius:13px;
  text-decoration:none;font-size:14px;font-weight:740
}
.button.primary{background:linear-gradient(120deg,#f2f6ff,#ced8ff);color:#101526;box-shadow:0 12px 42px rgba(101,117,255,.20)}
.button.secondary{border:1px solid rgba(255,255,255,.11);color:#dbe1f1;background:rgba(255,255,255,.035)}
.meta{display:flex;gap:22px;flex-wrap:wrap;margin-top:34px;color:#747e96;font-size:12px}
.meta span{display:flex;align-items:center;gap:7px}.meta i{width:5px;height:5px;border-radius:50%;background:#69728b}
.stage{position:relative;min-height:590px;display:grid;place-items:center;perspective:1100px;isolation:isolate}
.halo{
  position:absolute;width:460px;aspect-ratio:1;border-radius:50%;
  background:radial-gradient(circle,rgba(104,112,255,.17),rgba(71,66,180,.04) 46%,transparent 70%);
  filter:blur(7px);animation:pulse 5s ease-in-out infinite
}
.scene{
  --rx:-11deg;--ry:-18deg;position:relative;width:510px;height:510px;
  transform-style:preserve-3d;transform:rotateX(var(--rx)) rotateY(var(--ry));
  transition:transform .16s ease-out
}
.orbit{
  position:absolute;left:50%;top:50%;width:410px;height:410px;margin:-205px;
  border:1px solid rgba(146,163,255,.20);border-radius:50%;transform-style:preserve-3d
}
.orbit:before{
  content:"";position:absolute;width:7px;height:7px;border-radius:50%;top:-4px;left:50%;
  background:#b8c3ff;box-shadow:0 0 18px #7c8fff
}
.orbit.one{transform:rotateX(70deg) rotateZ(17deg);animation:spin1 18s linear infinite}
.orbit.two{
  width:330px;height:330px;margin:-165px;transform:rotateY(72deg) rotateZ(-20deg);
  animation:spin2 14s linear infinite reverse
}
.orbit.three{
  width:470px;height:470px;margin:-235px;transform:rotateX(63deg) rotateY(30deg);
  border-color:rgba(113,212,255,.12)
}
.node{
  position:absolute;display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:12px;
  background:rgba(13,18,34,.82);border:1px solid rgba(175,190,255,.18);
  box-shadow:0 10px 36px rgba(0,0,0,.35);backdrop-filter:blur(12px);
  font-size:11px;color:#dce4ff;white-space:nowrap
}
.node:before{content:"";width:7px;height:7px;border-radius:50%;background:#91a8ff;box-shadow:0 0 12px #7f91ff}
.n1{left:25px;top:112px;transform:translateZ(58px)}
.n2{right:14px;top:80px;transform:translateZ(42px)}
.n3{right:0;bottom:108px;transform:translateZ(78px)}
.n4{left:24px;bottom:83px;transform:translateZ(28px)}
.core-wrap{position:absolute;inset:0;display:grid;place-items:center;transform-style:preserve-3d;animation:float 5s ease-in-out infinite}
.core{
  position:relative;width:176px;height:176px;transform-style:preserve-3d;
  transform:rotateX(-12deg) rotateY(24deg) rotateZ(-4deg)
}
.face{
  position:absolute;inset:0;border:1px solid rgba(203,216,255,.27);border-radius:38px;
  background:linear-gradient(145deg,rgba(255,255,255,.13),rgba(108,103,255,.07) 50%,rgba(20,25,47,.32));
  box-shadow:inset 0 0 42px rgba(160,174,255,.08),0 24px 80px rgba(54,48,174,.24);
  backdrop-filter:blur(13px)
}
.face.front{transform:translateZ(48px)}
.face.back{transform:translateZ(-48px)}
.face.left{transform:rotateY(90deg) translateZ(48px)}
.face.right{transform:rotateY(-90deg) translateZ(48px)}
.face.top{transform:rotateX(90deg) translateZ(48px)}
.face.bottom{transform:rotateX(-90deg) translateZ(48px)}
.core-icon{
  position:absolute;left:50%;top:50%;width:86px;height:86px;transform:translate(-50%,-50%) translateZ(54px);
  display:grid;place-items:center;border-radius:28px;
  background:radial-gradient(circle at 36% 28%,rgba(255,255,255,.25),rgba(126,120,255,.12) 43%,rgba(19,25,47,.6));
  border:1px solid rgba(212,220,255,.28);box-shadow:0 0 44px rgba(104,101,255,.28)
}
.core-icon svg{width:48px;height:48px;filter:drop-shadow(0 0 12px rgba(160,184,255,.38))}
.signal{position:absolute;inset:50% auto auto 50%;width:254px;height:254px;margin:-127px;border-radius:50%;border:1px solid rgba(143,158,255,.13);animation:signal 3.4s ease-out infinite}
footer{
  display:flex;justify-content:space-between;gap:20px;align-items:center;
  color:#687087;font-size:12px;border-top:1px solid rgba(255,255,255,.055);padding-top:18px
}
footer b{color:#9ba5bd;font-weight:650}
@keyframes float{0%,100%{transform:translateY(-5px)}50%{transform:translateY(10px)}}
@keyframes pulse{0%,100%{opacity:.7;transform:scale(.98)}50%{opacity:1;transform:scale(1.04)}}
@keyframes spin1{to{transform:rotateX(70deg) rotateZ(377deg)}}
@keyframes spin2{to{transform:rotateY(72deg) rotateZ(340deg)}}
@keyframes signal{0%{transform:scale(.74);opacity:.56}85%,100%{transform:scale(1.35);opacity:0}}
@media(max-width:900px){
  .shell{padding:22px 20px}.nav-actions .nav-link:first-child{display:none}
  main{grid-template-columns:1fr;padding-top:58px}.copy{text-align:center}.lead{margin-inline:auto}.actions,.meta{justify-content:center}
  .stage{min-height:520px}.scene{transform:scale(.82) rotateX(var(--rx)) rotateY(var(--ry))}
  footer{flex-direction:column;text-align:center}
}
@media(max-width:560px){
  h1{font-size:48px}.lead{font-size:16px}.stage{min-height:430px;margin-inline:-60px}
  .scene{transform:scale(.68) rotateX(var(--rx)) rotateY(var(--ry))}
}
@media(prefers-reduced-motion:reduce){
  *,*:before,*:after{animation:none!important;transition:none!important}.scene{transform:rotateX(-10deg) rotateY(-16deg)}
}
</style>
</head>
<body>
<div class="shell">
  <nav>
    <div class="brand"><span class="mark" aria-hidden="true"></span><span>Easy Local MCP</span></div>
    <div class="nav-actions">
      <a class="nav-link" href="/healthz">Health</a>
      <a class="nav-link" href="/admin">Relay Admin</a>
    </div>
  </nav>
  <main>
    <section class="copy">
      <div class="eyebrow"><span class="dot"></span> Secure local relay</div>
      <h1>Your local tools.<br><span class="gradient">Connected, not exposed.</span></h1>
      <p class="lead">Bridge AI clients to files, shells, processes, skills and private MCP servers through a credentialed relay—while execution stays on your machine.</p>
      <div class="actions">
        <a class="button primary" href="/admin">Open Relay Admin <span>→</span></a>
        <a class="button secondary" href="/healthz">Check service health</a>
      </div>
      <div class="meta">
        <span><i></i> WebSocket relay</span>
        <span><i></i> Local execution</span>
        <span><i></i> Zone-aware access</span>
      </div>
    </section>
    <section class="stage" aria-label="3D illustration of a secure MCP relay">
      <div class="halo"></div>
      <div class="scene" id="scene">
        <div class="orbit one"></div>
        <div class="orbit two"></div>
        <div class="orbit three"></div>
        <div class="signal"></div>
        <div class="node n1">AI Client</div>
        <div class="node n2">Secure Relay</div>
        <div class="node n3">Local Tools</div>
        <div class="node n4">Private MCP</div>
        <div class="core-wrap">
          <div class="core">
            <div class="face front"></div><div class="face back"></div>
            <div class="face left"></div><div class="face right"></div>
            <div class="face top"></div><div class="face bottom"></div>
            <div class="core-icon" aria-hidden="true">
              <svg viewBox="0 0 64 64" fill="none">
                <path d="M18 19.5a9 9 0 0 1 9-9h10a9 9 0 0 1 9 9v4.7" stroke="#EAF0FF" stroke-width="4" stroke-linecap="round"/>
                <path d="M46 44.5a9 9 0 0 1-9 9H27a9 9 0 0 1-9-9v-4.7" stroke="#EAF0FF" stroke-width="4" stroke-linecap="round"/>
                <path d="M10 32h44M18 24l-8 8 8 8M46 24l8 8-8 8" stroke="#9DB2FF" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
          </div>
        </div>
      </div>
    </section>
  </main>
  <footer>
    <span><b>Easy Local MCP</b> · the relay is the path, not the destination.</span>
    <span>No external assets · privacy-first landing page</span>
  </footer>
</div>
<script>
(function(){
  var scene=document.getElementById('scene');
  if(!scene||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  var targetX=-11,targetY=-18,currentX=-11,currentY=-18,raf=0;
  function draw(){
    currentX+=(targetX-currentX)*.08;
    currentY+=(targetY-currentY)*.08;
    scene.style.setProperty('--rx',currentX.toFixed(2)+'deg');
    scene.style.setProperty('--ry',currentY.toFixed(2)+'deg');
    if(Math.abs(targetX-currentX)>.02||Math.abs(targetY-currentY)>.02)raf=requestAnimationFrame(draw);
    else raf=0;
  }
  window.addEventListener('pointermove',function(e){
    targetY=-18+(e.clientX/window.innerWidth-.5)*12;
    targetX=-11-(e.clientY/window.innerHeight-.5)*8;
    if(!raf)raf=requestAnimationFrame(draw);
  },{passive:true});
})();
</script>
</body>
</html>`;
