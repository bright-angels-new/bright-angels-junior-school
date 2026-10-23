const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const SESSION_SECONDS = 60 * 60 * 8;
const MAX_IMAGE = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
function json(data, status=200, headers={}) { return new Response(JSON.stringify(data), {status, headers:{...JSON_HEADERS,...headers}}); }
function htmlError(message,status=400){return new Response(message,{status,headers:{"content-type":"text/plain; charset=utf-8","x-content-type-options":"nosniff"}});}
function randomHex(n=32){const b=new Uint8Array(n);crypto.getRandomValues(b);return [...b].map(x=>x.toString(16).padStart(2,"0")).join("");}
function b64url(bytes){return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}
async function hmac(secret,data){const k=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);return b64url(await crypto.subtle.sign("HMAC",k,new TextEncoder().encode(data)));}
async function signSession(env, payload){const body=b64url(new TextEncoder().encode(JSON.stringify(payload)));return body+"."+await hmac(env.SESSION_SECRET,body);}
async function verifySession(request,env){const cookie=request.headers.get("Cookie")||"";const raw=cookie.split(";").map(x=>x.trim()).find(x=>x.startsWith("ba_admin="))?.slice(9);if(!raw)return null;const [body,sig]=raw.split(".");if(!body||!sig)return null;const expected=await hmac(env.SESSION_SECRET,body);if(sig.length!==expected.length)return null;let diff=0;for(let i=0;i<sig.length;i++)diff|=sig.charCodeAt(i)^expected.charCodeAt(i);if(diff)return null;try{const p=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body.replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0))));if(p.exp<Date.now()/1000||p.email!==env.ADMIN_EMAIL)return null;return p}catch{return null}}
function cookie(value,maxAge){return `ba_admin=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;}
async function requireAdmin(req,env){const session=await verifySession(req,env);if(!session)return {error:json({error:"Please sign in as the administrator."},401)};if(req.method!=="GET"&&req.method!=="HEAD"){const csrf=req.headers.get("X-CSRF-Token");if(!csrf||csrf!==session.csrf)return {error:json({error:"Security check failed. Refresh the administrator session and try again."},403)};}return {session};}
function safeText(v,max=2000){return String(v??"").trim().slice(0,max);}
async function settings(env){const {results=[]}=await env.DB.prepare("SELECT key,value FROM settings").all();return Object.fromEntries(results.map(x=>[x.key,x.value]));}
async function listNews(env){const {results=[]}=await env.DB.prepare("SELECT id,title,body,date,created_at AS createdAt FROM announcements ORDER BY COALESCE(date,created_at) DESC,id DESC LIMIT 50").all();return results;}
async function listGallery(env){const {results=[]}=await env.DB.prepare("SELECT id,object_key AS objectKey,caption,content_type AS contentType,created_at AS createdAt FROM gallery ORDER BY id DESC LIMIT 60").all();return results.map(g=>({...g,url:`/api/gallery-image/${g.id}`}));}
async function listFeedback(env){const {results=[]}=await env.DB.prepare("SELECT id,parent_name AS parentName,email,phone,rating,message,created_at AS createdAt FROM feedback ORDER BY id DESC LIMIT 300").all();return results;}
async function sendSchoolEmail(env,subject,textBody){
 if(!env.RESEND_API_KEY||!env.MAIL_FROM)return false;
 try { const response=await fetch("https://api.resend.com/emails",{method:"POST",headers:{"Authorization":`Bearer ${env.RESEND_API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({from:env.MAIL_FROM,to:["brightangels26@gmail.com"],subject,text:textBody})});
 if(!response.ok){console.error("Email provider returned",response.status,await response.text());return false;}return true; } catch(e) { console.error("Email notification failed",e); return false; }
}
async function getApplications(env){const {results=[]}=await env.DB.prepare("SELECT id,reference,child_name AS childName,dob,gender,class_applying AS classApplying,previous_school AS previousSchool,guardian_name AS guardianName,relationship,phone,guardian_email AS guardianEmail,district,address,notes,passport_key AS passportKey,created_at AS createdAt FROM applications ORDER BY id DESC LIMIT 300").all();return results.map(a=>({...a,passportUrl:`/api/admin/passport/${a.id}`}));}
function validImage(file){return file&&file.size>0&&file.size<=MAX_IMAGE&&ALLOWED_TYPES.has(file.type);}
async function apiRoute(request,env,url){
 const path=url.pathname.replace(/^\/api/,"");
 if(path==="/public"&&request.method==="GET"){return json({settings:await settings(env),news:await listNews(env),gallery:(await listGallery(env)).map(({id,caption,url,createdAt})=>({id,caption,url,createdAt}))});}
 if(path==="/admissions"&&request.method==="POST"){
  let f;
  try {
    f=await request.formData();
  } catch {
    return json({error:"Invalid form submission."},400);
  }
const child=safeText(f.get("childName"),120);
  const dob=safeText(f.get("dob"),20);
  const gender=safeText(f.get("gender"),30);
  const cls=safeText(f.get("classApplying"),60);
  const guardian=safeText(f.get("guardianName"),120);
  const rel=safeText(f.get("relationship"),50);
  const phone=safeText(f.get("phone"),40);
  const district=safeText(f.get("district"),120);
  const address=safeText(f.get("address"),500);

  if(!child||!dob||!gender||!cls||!guardian||!rel||!phone||!district||!address){
    return json({error:"Please complete all required fields."},400);
  }

  const reference="BAJS-"+new Date().getFullYear()+"-"+randomHex(4).toUpperCase();

  await env.DB.prepare(
    "INSERT INTO applications (reference,child_name,dob,gender,class_applying,previous_school,guardian_name,relationship,phone,guardian_email,district,address,notes,passport_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(
    reference,
    child,
    dob,
    gender,
    cls,
    safeText(f.get("previousSchool"),160),
    guardian,
    rel,
    phone,
    safeText(f.get("guardianEmail"),160),
    district,
    address,
    safeText(f.get("notes"),1000),
    ""
  ).run();

  const emailSent=await sendSchoolEmail(
    env,
    `New admission application: ${reference}`,
    `A new admission application was received on the Bright Angels Junior School website.

Reference: ${reference}
Child: ${child}
Date of birth: ${dob}
Gender: ${gender}
Class applying for: ${cls}
Parent/guardian: ${guardian}
Phone: ${phone}
District: ${district}
Address: ${address}

Please sign in to the school administrator dashboard to review the application.`
  );

  return json({ok:true,reference,emailSent},201);
 }
if(path==="/feedback"&&request.method==="POST"){
  let b;
  try {
    b=await request.json();
  } catch {
    return json({error:"Invalid feedback submission."},400);
  }

  const name=safeText(b.name,120);
  const email=safeText(b.email,160);
  const phone=safeText(b.phone,40);
  const rating=safeText(b.rating,30);
  const message=safeText(b.message,2000);

  if(!name||!message){
    return json({error:"Please enter your name and message."},400);
  }

  if(message.length<5){
    return json({error:"Please provide a little more detail in your message."},400);
  }

  await env.DB.prepare(
    "INSERT INTO feedback(parent_name,email,phone,rating,message) VALUES(?,?,?,?,?)"
  ).bind(name,email,phone,rating,message).run();

  const emailSent=await sendSchoolEmail(
    env,
    "Website feedback from "+name,
    `New feedback received on the Bright Angels Junior School website.

Name: ${name}
Email: ${email||"Not supplied"}
Phone: ${phone||"Not supplied"}
Rating: ${rating||"Not supplied"}

Message:
${message}`
  );

  return json({ok:true,emailSent},201);
}
if(path.startsWith("/gallery-image/")&&request.method==="GET"){
  const id=Number(path.split("/").pop());
  if(!Number.isInteger(id))return htmlError("Not found",404);

  const row=await env.DB.prepare(
    "SELECT object_key,content_type FROM gallery WHERE id=?"
  ).bind(id).first();

  if(!row)return htmlError("Not found",404);

  const obj=await env.UPLOADS.get(row.object_key);
  if(!obj)return htmlError("Not found",404);

  return new Response(obj.body,{
    headers:{
      "content-type":row.content_type,
      "cache-control":"public, max-age=300",
      "x-content-type-options":"nosniff"
    }
  });
}
 if(path==="/admin/login"&&request.method==="POST"){
   const ip=request.headers.get("CF-Connecting-IP")||"unknown";
   let body;try{body=await request.json()}catch{return json({error:"Invalid login request."},400)}
   if(safeText(body.email,320).toLowerCase()!==String(env.ADMIN_EMAIL||"").toLowerCase()||!env.ADMIN_PASSWORD_HASH||!body.password)return json({error:"Invalid email or password."},401);
   const ok=await verifyPassword(body.password,env.ADMIN_PASSWORD_HASH);
   if(!ok)return json({error:"Invalid email or password."},401);
   const csrf=randomHex(24),value=await signSession(env,{email:env.ADMIN_EMAIL,csrf,ipHash:await hmac(env.SESSION_SECRET,ip),exp:Math.floor(Date.now()/1000)+SESSION_SECONDS});
   return json({ok:true,csrf},200,{"set-cookie":cookie(value,SESSION_SECONDS)});
 }
 if(path==="/admin/logout"&&request.method==="POST"){return json({ok:true},200,{"set-cookie":cookie("",0)});}
 if(path.startsWith("/admin/")||path==="/admin/data"){
   const auth=await requireAdmin(request,env);if(auth.error)return auth.error;
   if(path==="/admin/data"&&request.method==="GET")return json({settings:await settings(env),news:await listNews(env),gallery:await listGallery(env),applications:await getApplications(env),feedback:await listFeedback(env)});
   if(path==="/admin/settings"&&request.method==="PUT"){
     let b;try{b=await request.json()}catch{return json({error:"Invalid settings."},400)}
     const fields=["headline","welcome","aboutText","vision","mission","phone","address"];
     const stmts=fields.map(k=>env.DB.prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(k,safeText(b[k],k==="welcome"||k==="aboutText"?2000:1000)));
     await env.DB.batch(stmts);return json({ok:true});
   }
   if(path==="/admin/news"&&request.method==="POST"){
     let b;try{b=await request.json()}catch{return json({error:"Invalid announcement."},400)}
     const title=safeText(b.title,150),body=safeText(b.body,2000),date=safeText(b.date,20);if(!title||!body)return json({error:"Title and announcement details are required."},400);
     await env.DB.prepare("INSERT INTO announcements(title,body,date) VALUES(?,?,?)").bind(title,body,date||null).run();return json({ok:true},201);
   }
   const delNews=path.match(/^\/admin\/news\/(\d+)$/);if(delNews&&request.method==="DELETE"){await env.DB.prepare("DELETE FROM announcements WHERE id=?").bind(Number(delNews[1])).run();return json({ok:true});}
   if(path==="/admin/gallery"&&request.method==="POST"){
     const f=await request.formData(),file=f.get("photo"),caption=safeText(f.get("caption"),180);if(!(file instanceof File)||!validImage(file))return json({error:"Choose a JPG, PNG or WebP image no larger than 5 MB."},400);
     const ext=file.type==="image/png"?"png":file.type==="image/webp"?"webp":"jpg",key=`gallery/${randomHex(20)}.${ext}`;
     await env.UPLOADS.put(key,file.stream(),{httpMetadata:{contentType:file.type,cacheControl:"public, max-age=300"}});
     await env.DB.prepare("INSERT INTO gallery(object_key,caption,content_type) VALUES(?,?,?)").bind(key,caption,file.type).run();return json({ok:true},201);
   }
   const delGallery=path.match(/^\/admin\/gallery\/(\d+)$/);if(delGallery&&request.method==="DELETE"){const row=await env.DB.prepare("SELECT object_key FROM gallery WHERE id=?").bind(Number(delGallery[1])).first();if(row){await env.UPLOADS.delete(row.object_key);await env.DB.prepare("DELETE FROM gallery WHERE id=?").bind(Number(delGallery[1])).run();}return json({ok:true});}
   const delFeedback=path.match(/^\/admin\/feedback\/(\d+)$/);if(delFeedback&&request.method==="DELETE"){await env.DB.prepare("DELETE FROM feedback WHERE id=?").bind(Number(delFeedback[1])).run();return json({ok:true});}
   const delApp=path.match(/^\/admin\/admissions\/(\d+)$/);if(delApp&&request.method==="DELETE"){const row=await env.DB.prepare("SELECT passport_key FROM applications WHERE id=?").bind(Number(delApp[1])).first();if(row){await env.UPLOADS.delete(row.passport_key);await env.DB.prepare("DELETE FROM applications WHERE id=?").bind(Number(delApp[1])).run();}return json({ok:true});}
   const passport=path.match(/^\/admin\/passport\/(\d+)$/);if(passport&&request.method==="GET"){const row=await env.DB.prepare("SELECT passport_key FROM applications WHERE id=?").bind(Number(passport[1])).first();if(!row)return htmlError("Not found",404);const obj=await env.UPLOADS.get(row.passport_key);if(!obj)return htmlError("Not found",404);return new Response(obj.body,{headers:{"content-type":obj.httpMetadata?.contentType||"application/octet-stream","cache-control":"private, no-store","x-content-type-options":"nosniff","content-disposition":"inline"}});}
 }
 return json({error:"Not found."},404);
}
async function verifyPassword(password,stored){
 // Format: pbkdf2-sha256$iterations$saltBase64$hashBase64
 const [alg,it,saltB64,hashB64]=String(stored).split("$");if(alg!=="pbkdf2-sha256")return false;
 const iterations=Number(it);if(!Number.isInteger(iterations)||iterations<100000||iterations>2000000)return false;
 try{const dec=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));const salt=dec(saltB64),expected=dec(hashB64);const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(password),"PBKDF2",false,["deriveBits"]);const actual=new Uint8Array(await crypto.subtle.deriveBits({name:"PBKDF2",salt,iterations,hash:"SHA-256"},key,expected.length*8));if(actual.length!==expected.length)return false;let diff=0;for(let i=0;i<actual.length;i++)diff|=actual[i]^expected[i];return diff===0}catch{return false}
}
export default {
 async fetch(request,env,ctx){
  const url=new URL(request.url);
  if(url.pathname.startsWith("/api/")){try{return await apiRoute(request,env,url)}catch(e){console.error("API error",e);return json({error:"A server error occurred. Please try again later."},500)}}
  // Static assets are served by Cloudflare's Assets binding.
  if(env.ASSETS)return env.ASSETS.fetch(request);
  return htmlError("Static assets binding is missing.",500);
 }
};
