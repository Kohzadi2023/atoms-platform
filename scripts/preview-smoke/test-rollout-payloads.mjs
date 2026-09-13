import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import module from "node:module";
import vm from "node:vm";
import { once } from "node:events";
import { pathToFileURL, fileURLToPath } from "node:url";
const input=JSON.parse(await new Promise(resolve=>{
  let data="";process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>data+=chunk);process.stdin.on("end",()=>resolve(data));
}));
const bundle=fileURLToPath(new URL("../../apps/preview-gateway/", import.meta.url)).replace(/\/$/u, "");
const appRequire=module.createRequire(bundle+"/package.json");
const previewPath=appRequire.resolve("@atoms/preview");
const preview=await import(pathToFileURL(previewPath).href);
const {buildPreviewGateway}=await import(pathToFileURL(bundle+"/dist/gateway.js").href);
const secret="offline-only-signing-secret-012345678901234567890";
const host="fixture.canadacentral.redis.azure.net",nonce="0123456789abcdef0123456789abcdef";
const env={PREVIEW_SIGNING_SECRET:secret,PREVIEW_BASE_DOMAIN:"preview.invalid",PREVIEW_PUBLIC_PROTOCOL:"https",
  PREVIEW_REDIS_MODE:"oss-cluster",PREVIEW_UI_ORIGIN:"https://offline.invalid",REDIS_URL:"rediss://default:offline-only-password@"+host+":10000/0"};
let assertions=0;
const check=(condition,label)=>{assert.ok(condition,label);assertions++;};
async function evaluate(source,context){
  const output=[],timers=new Set();
  let resolveExit;const exited=new Promise(resolve=>resolveExit=resolve);
  const fakeProcess={env:context.env,getuid:context.getuid,exit(code){for(const t of timers)clearTimeout(t);resolveExit(code);}};
  const fakeSetTimeout=(fn,ms)=>{const id=setTimeout(fn,ms);timers.add(id);return id;};
  vm.runInNewContext(source,{
    require:context.require,process:fakeProcess,Buffer,URL,
    fetch:context.fetch,AbortSignal,
    setTimeout:fakeSetTimeout,clearTimeout:id=>{timers.delete(id);clearTimeout(id);},
    console:{log:line=>output.push(String(line))}
  },{importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
  const code=await Promise.race([exited,new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error("offline VM exceeded 10 seconds")),10000);t.unref();})]);
  return {code,output};
}
for(const mode of ["success","root-rejected","dns-mismatch","tls-connect-failed","ping-failed","unexpected-record","health-failed"]){
  const operations=[];let closed=false;
  class MockCluster {
    constructor(nodes,options){check(nodes[0].host===host,"Uses production canonical cluster helper");check(options.redisOptions.tls.rejectUnauthorized===true,"TLS remains validated");}
    on(){return this;}
    async connect(){if(mode==="tls-connect-failed")throw new Error("OFFLINE_SECRET_DO_NOT_PRINT");}
    nodes(){return [1,2,3].map(()=>({ping:async()=>{operations.push("PING");return mode==="ping-failed"?"NOPE":"PONG";}}));}
    async get(){operations.push("GET");return mode==="unexpected-record"?"unexpected-existing-record":null;}
    async quit(){operations.push("QUIT");closed=true;}
    disconnect(){closed=true;}
  }
  const server=buildPreviewGateway({
    signer:new preview.PreviewTicketSigner({secret,baseDomain:"preview.invalid",publicProtocol:"https"}),
    store:{get:async()=>null},uiOrigin:env.PREVIEW_UI_ORIGIN
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");const port=server.address().port;
  const localHttp={...http,request(options,callback){return http.request({...options,port},callback);},get(options,callback){return http.get({...options,port},callback);}};
  const localFetch=async(url,options)=>{
    check(url==="http://127.0.0.1:3002/healthz","Runtime probes only fixed localhost health");
    if(mode==="health-failed")return new Response("unavailable",{status:503,headers:{"cache-control":"no-store"}});
    return fetch("http://127.0.0.1:"+port+"/healthz",options);
  };
  const packageRequire=Object.assign(name=>name==="ioredis"?{Cluster:MockCluster}:appRequire(name),{resolve:name=>appRequire.resolve(name)});
  const mockModule={...module,createRequire:()=>packageRequire};
  const mockFs={...fs,existsSync:path=>path==="/app/dist/main.js",readFileSync:()=>Buffer.from("node\0dist/main.js\0")};
  const mockRequire=name=>{
    if(name==="node:module")return mockModule;
    if(name==="node:fs")return mockFs;
    if(name==="node:http")return localHttp;
    if(name==="node:dns")return {promises:{lookup:async()=>[{address:mode==="dns-mismatch"?"10.0.0.9":"10.0.0.4"}]}};
    return appRequire(name);
  };
  const source="const K="+JSON.stringify({host,ips:["10.0.0.4"],nonce})+";"+input.runtime;
  try{
    const result=await evaluate(source,{require:mockRequire,fetch:localFetch,env,getuid:()=>mode==="root-rejected"?0:1000});
    if(mode==="success"){
      check(result.code===0,"Actual production library, Redis adapter and exact local health pass");
      check(result.output.length===7&&result.output.at(-1)==="ATOMS_PVRT_RUNTIME_OK:"+nonce,"All nonce-bound success stages");
      check(operations.filter(x=>x==="GET").length===1,"Production store performs one read-only missing-key probe");
      check(closed,"Probe clients closed");
    }else{
      check(result.code===1,"Negative runtime case cannot pass: "+mode);
      check(!result.output.some(x=>x.includes("RUNTIME_OK")),"No false success token");
      check(!result.output.join("\n").includes("OFFLINE_SECRET_DO_NOT_PRINT"),"No raw secret/error printed");
    }
    check(operations.every(x=>["PING","GET","QUIT"].includes(x)),"No Redis data-changing operation");
    if(mode==="unexpected-record")check(operations.filter(x=>x==="GET").length===1,"Existing unexpected record stops before store deserialization");
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
for(const mode of ["exact","extra-whitespace","bad-status"]){
  const server=http.createServer((_,response)=>{response.statusCode=mode==="bad-status"?503:200;response.end(mode==="extra-whitespace"?'{"status":"ok"} ':'{"status":"ok"}');});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  let validated=false;
  const mockHttps={get(url,options,callback){
    check(url==="https://offline.internal/healthz","Health Job only configured target");
    validated=options.rejectUnauthorized===true;
    return http.get({hostname:"127.0.0.1",port:server.address().port,path:"/healthz",timeout:options.timeout},callback);
  }};
  try{
    const result=await evaluate(input.health,{require:name=>{assert.equal(name,"node:https");return mockHttps;},env:{TARGET_URL:"https://offline.internal/healthz"}});
    check(validated,"Health Job never disables TLS certificate checks");
    check(result.code===(mode==="exact"?0:1),"Job requires exact body and HTTP 200: "+mode);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
console.log("OFFLINE NODE PAYLOADS PASSED: "+assertions+" assertions; production packages/Gateway with mocked DNS/Redis/TLS transport, 7 short-runtime + 3 Job cases. No Azure/provider/Redis infrastructure contacted.");
