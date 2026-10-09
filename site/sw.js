const C="hohfamily-v8";const CORE=["./","index.html","manifest.webmanifest","icon-192.png","icon-512.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()));});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener("fetch",e=>{const r=e.request;if(r.method!=="GET")return;const u=new URL(r.url);
  const cacheable=u.origin===location.origin||/gstatic\.com|fonts\.googleapis|fonts\.gstatic|cdnjs\.cloudflare/.test(u.host);
  if(!cacheable||u.pathname.endsWith("data.json"))return;
  e.respondWith(fetch(r).then(res=>{if(res&&res.status===200){const cp=res.clone();caches.open(C).then(c=>c.put(r,cp));}return res;}).catch(()=>caches.match(r).then(m=>m||caches.match("index.html"))));});
self.addEventListener("notificationclick",e=>{e.notification.close();const page=(e.notification.data&&e.notification.data.page)||"alerts";
  e.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(cs=>{for(const c of cs){if("focus" in c){c.postMessage({page});return c.focus();}}return self.clients.openWindow("./#"+page);}));});
self.addEventListener("push",e=>{let d={};try{d=e.data?e.data.json():{};}catch(x){d={data:{title:"HOH Family",body:e.data?e.data.text():""}};}
  const dd=d.data||{},nn=d.notification||{};const title=nn.title||dd.title||"HOH Family",body=nn.body||dd.body||"",page=dd.page||"alerts";
  e.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(cs=>{const front=cs.find(c=>c.visibilityState==="visible"&&c.focused);if(front){front.postMessage({chime:1});return;}
    return self.registration.showNotification(title,{body,icon:"icon-192.png",badge:"icon-192.png",vibrate:[140,70,140],tag:"hoh-"+Date.now(),data:{page}});}));});
