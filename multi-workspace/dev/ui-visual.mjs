// Real Chromium checks against the isolated genuine-React preview.
// Run `node dev/ui-visual.mjs`. Requests are supplied from local source through
// Playwright routing; no web server or network access is needed.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { previewResponse, closePreviewAssets } from './preview-server.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.MW_PLAYWRIGHT_PATH||'C:/Users/曹智皓/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const dev=path.dirname(fileURLToPath(import.meta.url));
const base=process.env.MW_PREVIEW_URL || 'http://127.0.0.1:64791';
const browser=await chromium.launch({headless:true,executablePath:process.env.MW_PREVIEW_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-first-run','--disable-extensions']});
const page=await browser.newPage({viewport:{width:1280,height:860},deviceScaleFactor:1});
const errors=[];
await page.route(base+'/**',async route=>{await route.fulfill(previewResponse(route.request().url()));});
page.on('pageerror',error=>errors.push(String(error.stack||error)));
page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('favicon'))errors.push(message.text());});
const results=[];
function check(condition,message){if(!condition)throw new Error(message);results.push(message);}
async function visit(mode,theme='dark',extra='') {
  await page.goto(base+'/?mode='+mode+'&theme='+theme+'&controls=0'+extra);
  await page.waitForFunction(()=>globalThis.__mwPreview?.ready===true);
  await page.locator('.mw-dialog').first().waitFor();
  await page.waitForTimeout(220);
}
async function screenshot(name){await page.screenshot({path:path.join(dev,'preview-'+name+'.png'),fullPage:true});}
async function layoutCheck(label){
  const bounds=await page.locator('.mw-dialog').last().boundingBox();
  const viewport=page.viewportSize();
  check(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=viewport.width+1&&bounds.y+bounds.height<=viewport.height+1,label+': dialog fits viewport');
  const clipped=await page.locator('.mw-dialog').last().evaluate(node=>node.scrollWidth>node.clientWidth+1);
  check(!clipped,label+': no horizontal overflow');
}
try {
  for(const theme of ['dark','light']) {
    for(const mode of ['create-empty','create-filled','modify','browser']) {
      await visit(mode,theme);await layoutCheck(theme+' '+mode);await screenshot(theme+'-'+mode);
    }
  }
  for(const size of [{width:390,height:844},{width:390,height:600},{width:390,height:430},{width:360,height:640},{width:320,height:568},{width:1024,height:500}]) {
    await page.setViewportSize(size);
    for(const mode of ['create-filled','browser']){
      await visit(mode,'dark');await layoutCheck(size.width+'×'+size.height+' '+mode);await screenshot('narrow-'+size.width+'x'+size.height+'-'+mode);
      if(mode==='create-filled'&&size.height<=600) {
        const reachable=await page.locator('.mw-workbench').evaluate(body=>{
          body.scrollTop=body.scrollHeight;
          const last=body.querySelector('.mw-source__add-row button').getBoundingClientRect();
          const box=body.getBoundingClientRect();
          return last.top>=box.top-1&&last.bottom<=box.bottom+1;
        });
        check(reachable,size.width+'×'+size.height+': source list bottom reachable by scrolling');
        await screenshot('narrow-'+size.width+'x'+size.height+'-scrolled');
      }
    }
  }
  await page.setViewportSize({width:1280,height:860});
  await visit('create-empty','dark','&picker=native');
  check(await page.locator('.mw-dialog__footer .mw-btn--primary').isDisabled(),'empty create disabled');
  check(await page.getByRole('textbox',{name:'工作区名称',exact:true}).evaluate(el=>el===document.activeElement),'name input receives initial focus');
  const add=()=>page.getByRole('button',{name:'添加文件夹',exact:true}).click();
  await add();await add();await add();
  check(await page.locator('.mw-folder').count()===3,'native picker adds three source folders');
  const originalPaths=await page.locator('.mw-folder__path').allTextContents();
  await page.locator('.mw-folder').nth(2).dragTo(page.locator('.mw-folder').nth(0));
  const reordered=await page.locator('.mw-folder__path').allTextContents();
  check(reordered[0]===originalPaths[2],'dragging third folder makes it primary');
  await page.locator('.mw-folder .mw-icon-button--danger').first().click();
  check(await page.locator('.mw-folder').count()===2,'primary folder can be removed while creating');
  await page.getByRole('textbox',{name:'工作区名称',exact:true}).fill('真实 React UI 验证');
  await page.locator('.mw-dialog__footer .mw-btn--primary').click();
  const created=await page.evaluate(()=>globalThis.__mwPreview.getState().lastSubmit);
  check(created?.kind==='create'&&created.name==='真实 React UI 验证'&&created.roots.length===1,'create submits correct primary and members');
  await visit('modify');
  check(await page.locator('.mw-folder').count()===3,'modify loads primary and members');
  check(await page.locator('.mw-folder').first().locator('.mw-icon-button--danger').count()===0,'modify primary folder is locked');
  await page.locator('.mw-folder .mw-icon-button--danger').first().click();
  await page.getByRole('textbox',{name:'工作区名称',exact:true}).fill('工作区新名称');
  await page.locator('.mw-dialog__footer .mw-btn--primary').click();
  const modified=await page.evaluate(()=>globalThis.__mwPreview.getState().lastSubmit);
  check(modified?.kind==='modify'&&modified.name==='工作区新名称'&&modified.roots.length===1,'modify saves renamed workspace and remaining members');
  await visit('browser');
  check(await page.locator('.mw-browser__row').count()===4,'hidden folder omitted initially');
  await page.locator('.mw-browser__hidden input').check();
  check(await page.locator('.mw-browser__row').count()===5,'hidden folder toggle works');
  await page.locator('.mw-browser__checkbox').nth(0).check();
  await page.locator('.mw-browser__enter').nth(1).click();
  check((await page.locator('.mw-browser__status').innerText()).includes('1'),'selection survives directory navigation');
  await page.getByRole('button',{name:'新建文件夹',exact:true}).click();
  await page.getByRole('textbox',{name:'文件夹名称',exact:true}).fill('UI-preview-folder');
  await page.getByRole('button',{name:'创建文件夹',exact:true}).click();
  await page.locator('.mw-newfolder').waitFor({state:'hidden'});
  check((await page.locator('.mw-browser__status').innerText()).includes('2'),'new folder is selected automatically');
  await page.locator('.mw-browser__footer .mw-btn--primary').click();
  const picked=await page.evaluate(()=>globalThis.__mwPreview.getState().lastSubmit);
  check(picked?.kind==='browser'&&picked.paths.length===2,'browser confirms folders selected across directories');
  await visit('create-filled');
  await page.getByRole('button',{name:'添加文件夹',exact:true}).click();
  check(await page.locator('.mw-dialog').count()===2,'folder browser stacks over workspace form');
  for(let step=0;step<24;step++) await page.keyboard.press('Tab');
  check(await page.locator('.mw-dialog').last().evaluate(dialog=>dialog.contains(document.activeElement)),'keyboard focus stays inside upper modal');
  await page.keyboard.press('Escape');
  check(await page.locator('.mw-dialog').count()===1,'Escape closes only upper browser dialog');
  await page.keyboard.press('Escape');
  check(await page.locator('.mw-dialog').count()===0,'second Escape closes workspace form');
  await visit('create-filled','light','&lang=en');
  await layoutCheck('English light');await screenshot('light-english');
  check((await page.getByRole('dialog').innerText()).includes('New Workspace'),'English dictionary renders');
  check(errors.length===0,'no browser errors');
  const report={date:new Date().toISOString(),checks:results.length,results,errors};
  console.log(JSON.stringify(report,null,2));
} finally {await browser.close();closePreviewAssets();}
