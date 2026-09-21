import { uiI18nClient } from '../src/ui-i18n';

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
<meta name="color-scheme" content="dark light">
<title>Easy Local MCP · Secure Local Relay</title>
<script>
try{document.documentElement.dataset.theme=localStorage.getItem('easy-local-mcp.ui-theme')==='light'?'light':'dark'}catch{document.documentElement.dataset.theme='dark'}
</script>
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
.nav-actions{display:flex;gap:9px;align-items:center}
.language-menu{position:relative}
.language-trigger{
  height:40px;min-width:112px;display:inline-flex;align-items:center;justify-content:center;gap:8px;
  padding:0 13px;border-radius:999px;border:1px solid rgba(255,255,255,.10);
  background:rgba(255,255,255,.035);color:#dce2f2;font:inherit;font-size:14px;cursor:pointer;
  backdrop-filter:blur(14px);box-shadow:inset 0 1px 0 rgba(255,255,255,.035);
  transition:background .16s ease,border-color .16s ease,box-shadow .16s ease
}
.language-trigger:hover,.language-menu[data-open="true"] .language-trigger{
  background:rgba(255,255,255,.075);border-color:rgba(168,181,255,.23);
  box-shadow:0 10px 30px rgba(0,0,0,.20),inset 0 1px 0 rgba(255,255,255,.06)
}
.language-trigger svg{width:15px;height:15px;opacity:.78;flex:none}
.language-chevron{width:10px!important;height:10px!important;opacity:.55!important;transition:transform .16s ease}
.language-menu[data-open="true"] .language-chevron{transform:rotate(180deg)}
.language-popover{
  position:absolute;right:0;top:calc(100% + 9px);z-index:20;width:164px;padding:6px;border-radius:16px;
  border:1px solid rgba(170,183,255,.15);background:rgba(12,16,31,.92);backdrop-filter:blur(22px);
  box-shadow:0 20px 55px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.045)
}
.language-popover[hidden]{display:none}
.language-option{
  width:100%;height:38px;border:0;border-radius:11px;padding:0 10px;display:flex;align-items:center;justify-content:space-between;
  background:transparent;color:#cdd5e8;font:inherit;font-size:13px;cursor:pointer;text-align:left
}
.language-option:hover,.language-option:focus-visible{outline:none;background:rgba(125,137,255,.12);color:#fff}
.language-option[aria-checked="true"]{background:rgba(125,137,255,.16);color:#f4f6ff}
.language-check{opacity:0;color:#a8b7ff;font-weight:800}
.language-option[aria-checked="true"] .language-check{opacity:1}
.theme-toggle{
  width:40px;height:40px;border-radius:50%;border:1px solid rgba(255,255,255,.10);
  display:grid;place-items:center;background:rgba(255,255,255,.035);color:#dce2f2;cursor:pointer;
  backdrop-filter:blur(14px);box-shadow:inset 0 1px 0 rgba(255,255,255,.035);
  transition:background .16s ease,border-color .16s ease,box-shadow .16s ease,transform .16s ease
}
.theme-toggle:hover{background:rgba(255,255,255,.075);border-color:rgba(168,181,255,.23);box-shadow:0 10px 30px rgba(0,0,0,.20),inset 0 1px 0 rgba(255,255,255,.06);transform:translateY(-1px)}
.theme-toggle:focus-visible{outline:2px solid rgba(145,168,255,.7);outline-offset:2px}
.theme-toggle svg{width:17px;height:17px}
.theme-icon-sun{display:none}
html[data-theme="light"] .theme-icon-sun{display:block}
html[data-theme="light"] .theme-icon-moon{display:none}
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
  max-width:720px;margin:22px 0 20px;font-size:clamp(42px,5.2vw,74px);
  line-height:1.06;letter-spacing:-.045em;font-weight:800
}
.gradient{
  background:linear-gradient(100deg,#fff 7%,#bbcaff 49%,#bd8bff 94%);
  -webkit-background-clip:text;background-clip:text;color:transparent
}
.hero-line2-accent{color:inherit}
html[lang="en"] .hero-line2-accent{margin-left:.18em}
html[lang="zh-CN"] .hero-line2{background:none;color:#f4f7ff}
html[lang="zh-CN"] .hero-line2-accent{
  margin-left:0;background:linear-gradient(100deg,#bbcaff 10%,#bd8bff 58%,#e28cff 100%);
  -webkit-background-clip:text;background-clip:text;color:transparent
}
.lead{max-width:600px;margin:0;color:#aeb6ca;font-size:clamp(15px,1.3vw,18px);line-height:1.72}
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
.footer-link{color:#687087;text-decoration:none;transition:color .16s ease}
.footer-link:hover{color:#aeb8d2}
.footer-link:focus-visible{outline:2px solid rgba(145,168,255,.65);outline-offset:3px;border-radius:4px}
html[data-theme="light"]{color:#15192b;background:#f7f8ff}
html[data-theme="light"] body{
  color:#15192b;
  background:
    radial-gradient(circle at 50% 34%,rgba(105,102,255,.16),transparent 30rem),
    radial-gradient(circle at 12% 16%,rgba(54,184,255,.13),transparent 26rem),
    radial-gradient(circle at 89% 83%,rgba(180,94,255,.12),transparent 30rem),
    #f7f8ff
}
html[data-theme="light"] body:before{
  opacity:.42;
  background-image:linear-gradient(rgba(66,76,120,.055) 1px,transparent 1px),linear-gradient(90deg,rgba(66,76,120,.055) 1px,transparent 1px)
}
html[data-theme="light"] .brand{color:#171b2d}
html[data-theme="light"] .language-trigger,
html[data-theme="light"] .theme-toggle{
  color:#424a67;background:rgba(255,255,255,.68);border-color:rgba(81,91,140,.14);
  box-shadow:0 8px 24px rgba(64,72,118,.07),inset 0 1px 0 rgba(255,255,255,.86)
}
html[data-theme="light"] .language-trigger:hover,
html[data-theme="light"] .language-menu[data-open="true"] .language-trigger,
html[data-theme="light"] .theme-toggle:hover{background:rgba(255,255,255,.92);border-color:rgba(105,111,190,.24);box-shadow:0 12px 32px rgba(74,82,130,.12)}
html[data-theme="light"] .language-popover{background:rgba(251,252,255,.94);border-color:rgba(86,94,145,.14);box-shadow:0 22px 55px rgba(63,70,110,.16),inset 0 1px 0 #fff}
html[data-theme="light"] .language-option{color:#4d5672}
html[data-theme="light"] .language-option:hover,
html[data-theme="light"] .language-option:focus-visible{background:rgba(103,111,224,.09);color:#1d2340}
html[data-theme="light"] .language-option[aria-checked="true"]{background:rgba(103,111,224,.12);color:#232945}
html[data-theme="light"] .language-check{color:#6f73df}
html[data-theme="light"] .eyebrow{color:#5c65a2;border-color:rgba(95,107,190,.16);background:rgba(108,118,224,.07)}
html[data-theme="light"] .dot{background:#28b78c;box-shadow:0 0 13px rgba(40,183,140,.45)}
html[data-theme="light"] h1{color:#151a2f}
html[data-theme="light"] .gradient{background:linear-gradient(100deg,#283657 4%,#6874e8 48%,#a05be7 94%);-webkit-background-clip:text;background-clip:text;color:transparent}
html[data-theme="light"][lang="zh-CN"] .hero-line2{background:none;color:#151a2f}
html[data-theme="light"][lang="zh-CN"] .hero-line2-accent{background:linear-gradient(100deg,#6578ed 6%,#8d63eb 52%,#c050d8 100%);-webkit-background-clip:text;background-clip:text;color:transparent}
html[data-theme="light"] .lead{color:#606a83}
html[data-theme="light"] .button.primary{background:linear-gradient(120deg,#303953,#4e5a86);color:#fff;box-shadow:0 12px 34px rgba(75,86,139,.22)}
html[data-theme="light"] .button.secondary{border-color:rgba(70,80,124,.14);color:#3f4864;background:rgba(255,255,255,.62);box-shadow:0 8px 26px rgba(69,78,120,.07)}
html[data-theme="light"] .meta{color:#7b849d}
html[data-theme="light"] .meta i{background:#929bb3}
html[data-theme="light"] .halo{background:radial-gradient(circle,rgba(103,110,246,.14),rgba(104,89,200,.045) 46%,transparent 70%)}
html[data-theme="light"] .orbit{border-color:rgba(91,106,190,.20)}
html[data-theme="light"] .orbit.three{border-color:rgba(70,169,215,.15)}
html[data-theme="light"] .orbit:before{background:#7382e4;box-shadow:0 0 16px rgba(91,105,222,.55)}
html[data-theme="light"] .node{color:#414b70;background:rgba(255,255,255,.72);border-color:rgba(97,107,178,.16);box-shadow:0 12px 34px rgba(67,74,113,.14)}
html[data-theme="light"] .node:before{background:#7180e9;box-shadow:0 0 11px rgba(98,112,229,.45)}
html[data-theme="light"] .face{border-color:rgba(102,113,183,.18);background:linear-gradient(145deg,rgba(255,255,255,.82),rgba(126,127,244,.07) 52%,rgba(217,222,247,.44));box-shadow:inset 0 0 42px rgba(111,126,212,.08),0 24px 70px rgba(82,88,139,.14)}
html[data-theme="light"] .core-icon{background:radial-gradient(circle at 36% 28%,#fff,rgba(145,145,255,.12) 44%,rgba(226,230,247,.78));border-color:rgba(98,110,184,.17);box-shadow:0 0 40px rgba(96,101,218,.17)}
html[data-theme="light"] .core-icon svg path{stroke:#53609b!important}
html[data-theme="light"] .core-icon svg path:last-child{stroke:#7180db!important}
html[data-theme="light"] .signal{border-color:rgba(96,108,190,.14)}
html[data-theme="light"] footer{color:#8b93a8;border-top-color:rgba(69,78,116,.08)}
html[data-theme="light"] footer b{color:#666f88}
html[data-theme="light"] .footer-link{color:#7b849d}
html[data-theme="light"] .footer-link:hover{color:#4f5a78}
@keyframes float{0%,100%{transform:translateY(-5px)}50%{transform:translateY(10px)}}
@keyframes pulse{0%,100%{opacity:.7;transform:scale(.98)}50%{opacity:1;transform:scale(1.04)}}
@keyframes spin1{to{transform:rotateX(70deg) rotateZ(377deg)}}
@keyframes spin2{to{transform:rotateY(72deg) rotateZ(340deg)}}
@keyframes signal{0%{transform:scale(.74);opacity:.56}85%,100%{transform:scale(1.35);opacity:0}}
@media(min-width:1200px){
  h1{font-size:62px;max-width:680px;line-height:1.08}
  .lead{font-size:16px;max-width:560px;line-height:1.7}
}
@media(max-width:900px){
  .shell{padding:22px 20px}
  main{grid-template-columns:1fr;padding-top:58px}.copy{text-align:center}.lead{margin-inline:auto}.actions,.meta{justify-content:center}
  .stage{min-height:520px}.scene{transform:scale(.82) rotateX(var(--rx)) rotateY(var(--ry))}
  footer{flex-direction:column;text-align:center}
}
@media(max-width:560px){
  .shell{padding-inline:16px}.brand{gap:9px}.brand .mark{width:31px;height:31px}.nav-actions{gap:7px}
  .language-trigger{min-width:96px;padding:0 10px}.theme-toggle{width:38px;height:38px}
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
      <div class="language-menu" data-ui-language-menu data-open="false">
        <button class="language-trigger" type="button" data-ui-language-trigger aria-label="Language" aria-haspopup="menu" aria-expanded="false">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.6"/><path d="M3.8 12h16.4M12 3.5c2.2 2.3 3.2 5.2 3.2 8.5S14.2 18.2 12 20.5M12 3.5C9.8 5.8 8.8 8.7 8.8 12s1 6.2 3.2 8.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          <span data-ui-language-current>English</span>
          <svg class="language-chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m2.3 4.4 3.7 3.4 3.7-3.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="language-popover" data-ui-language-popover role="menu" hidden>
          <button class="language-option" type="button" role="menuitemradio" aria-checked="false" data-ui-language-option="en"><span>English</span><span class="language-check">✓</span></button>
          <button class="language-option" type="button" role="menuitemradio" aria-checked="false" data-ui-language-option="zh-CN"><span>中文</span><span class="language-check">✓</span></button>
        </div>
      </div>
      <button class="theme-toggle" type="button" data-ui-theme-toggle aria-label="Switch to light theme" title="Switch to light theme">
        <svg class="theme-icon-moon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 15.4A8.4 8.4 0 0 1 8.6 4a8.5 8.5 0 1 0 11.4 11.4Z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <svg class="theme-icon-sun" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="3.8" stroke="currentColor" stroke-width="1.7"/><path d="M12 2.4v2.1M12 19.5v2.1M4.5 12H2.4M21.6 12h-2.1M5.2 5.2l1.5 1.5M17.3 17.3l1.5 1.5M18.8 5.2l-1.5 1.5M6.7 17.3l-1.5 1.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
      </button>
    </div>
  </nav>
  <main>
    <section class="copy">
      <div class="eyebrow"><span class="dot"></span> Secure local relay</div>
      <h1>Your local tools.<br><span class="gradient hero-line2"><span>Connected,</span><span class="hero-line2-accent">not exposed.</span></span></h1>
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
    <a class="footer-link" href="https://github.com/Ryanma-YX/easy-local-mcp" target="_blank" rel="noreferrer noopener">© 2026 Ryanma-YX · MIT License</a>
  </footer>
</div>
<script>
${uiI18nClient('home')}
(function(){
  var toggle=document.querySelector('[data-ui-theme-toggle]');
  if(!toggle)return;
  var storageKey='easy-local-mcp.ui-theme';
  function currentTheme(){return document.documentElement.dataset.theme==='light'?'light':'dark'}
  function syncThemeButton(){
    var next=currentTheme()==='light'?'themeToDark':'themeToLight';
    var label=window.uiT?window.uiT(next):(next==='themeToDark'?'Switch to dark theme':'Switch to light theme');
    toggle.setAttribute('aria-label',label);
    toggle.setAttribute('title',label);
  }
  toggle.addEventListener('click',function(){
    var next=currentTheme()==='light'?'dark':'light';
    document.documentElement.dataset.theme=next;
    try{localStorage.setItem(storageKey,next)}catch{}
    syncThemeButton();
  });
  syncThemeButton();
})();
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
