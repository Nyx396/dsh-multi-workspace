// Isolated preview of the real plugin React components, using the installed
// DSH's own React 18 and theme tokens. No profile, workspace or host API opens.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

function openAsar(filename=process.env.DSH_TEST_ASAR || path.join(os.homedir(),'AppData/Local/Programs/DeepSeek Harness/resources/app.asar')) {
  const fd=fs.openSync(filename,'r');
  const prefix=Buffer.alloc(16);fs.readSync(fd,prefix,0,prefix.length,0);
  const bytes=Buffer.alloc(prefix.readUInt32LE(12));fs.readSync(fd,bytes,0,bytes.length,16);
  const header=JSON.parse(bytes.toString('utf8'));
  const offset=8+prefix.readUInt32LE(4);
  const members=[];
  function visit(node,parent='') {for(const [name,entry] of Object.entries(node.files||{})){const member=parent?parent+'/'+name:name;if(entry.files)visit(entry,member);else members.push(member);}}
  visit(header);
  return {members,read(member){let node=header;for(const part of member.split('/'))node=node.files?.[part];if(!node||node.unpacked)throw new Error('Missing packed fixture: '+member);const bytes=Buffer.alloc(node.size);fs.readSync(fd,bytes,0,bytes.length,offset+Number(node.offset));return bytes;},close(){fs.closeSync(fd);}};
}

const dev = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(dev);
const asar = openAsar();
const prefix = 'dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/';
const frontend = asar.members.find(name => name.startsWith(prefix) && /\/index-[^/]+\.js$/.test(name));
const original = asar.read(frontend).toString('utf8');
const seedFunction = original.match(/function ([\w$]+)\(\)\{return\{react:/)?.[1];
const bootStart = original.search(/const [\w$]+=globalThis\.dshDesktopBoot,/);
if (!seedFunction || bootStart < 0) throw new Error('DSH frontend seed layout changed');
const seeds = original.slice(0, bootStart) + '\nglobalThis.__mwPreviewSeeds=' + seedFunction + '();';
const themeSource = asar.read('dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js').toString('utf8');
const theme = [...themeSource.matchAll(/(?:var|const) [\w$]+ = ("(?:\\.|[^"\\])*");/g)]
  .map(match => JSON.parse(match[1])).filter(value => value.includes('--dsw-')).join('\n');
if (!theme.includes('--dsw-alias-bg-layer-2:')) throw new Error('DSH theme token fixture missing');
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH Multi Workspace · UI Preview</title><link rel="stylesheet" href="/theme.css"></head><body><div id="root"></div><script type="module" src="/preview.js"></script></body></html>`;
const types = { '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.woff2':'font/woff2' };
export function previewResponse(url) {
    const pathname = new URL(url, 'http://127.0.0.1').pathname;
    let body;
    let type = 'text/javascript; charset=utf-8';
    if (pathname === '/') {body = html; type = 'text/html; charset=utf-8';}
    else if (pathname === '/theme.css') {body = theme; type = 'text/css; charset=utf-8';}
    else if (pathname === '/preview.js') {
      const source = ['10-api.js','15-i18n.js','20-ui-kit.js','30-browser.js','40-dialogs.js']
        .map(name => fs.readFileSync(path.join(root,'src/client',name),'utf8')).join('\n');
      body = `import '/assets/seeds.js';\nconst React=globalThis.__mwPreviewSeeds.react;const {createPortal}=globalThis.__mwPreviewSeeds['react-dom'];const {createRoot}=globalThis.__mwPreviewSeeds['react-dom/client'];const h=React.createElement;const Fragment=React.Fragment;\n` + source + '\n' + fs.readFileSync(path.join(dev,'preview-app.js'),'utf8');
    } else if (pathname === '/assets/seeds.js') body = seeds;
    else if (/^\/assets\/[\w./-]+\.(?:js|css|woff2)$/.test(pathname) && !pathname.includes('..')) {
      body = asar.read(prefix + pathname.slice('/assets/'.length)); type = types[path.extname(pathname)];
    } else return {status:404,body:''};
    return {status:200,body,contentType:type};
}
export function closePreviewAssets() {asar.close();}
const server = http.createServer((req,res) => {
  try {
    const {status,body,contentType:type}=previewResponse(req.url);
    res.writeHead(status, {'Content-Type':type||'text/plain','Cache-Control':'no-store'});res.end(body);
  } catch(error) {res.writeHead(500);res.end(String(error.stack));}
});
if(path.resolve(process.argv[1]||'')===fileURLToPath(import.meta.url)) {
  const port = Number(process.env.MW_PREVIEW_PORT || 64791);
  await new Promise(resolve => server.listen(port,'127.0.0.1',resolve));
  console.log('MW_PREVIEW_URL=http://127.0.0.1:' + server.address().port);
  const close = () => {server.close();asar.close();};
  process.on('SIGINT',close);process.on('SIGTERM',close);
}
