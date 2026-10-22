// Browser-only harness. All dialogs and controls inside them are real src/client
// components; directory and submit actions remain in this local fixture.
const previewQuery = new URLSearchParams(location.search);
const previewFolders = [
  'D:\\Projects\\DeepSeek Harness',
  'F:\\AIwork\\DSH custom plugin',
  'D:\\Projects\\设计资源与共享组件\\design-system\\packages\\components\\very-long-project-folder-name-for-responsive-layout',
];
let previewLastSubmit = null;
let previewClosed = false;
let previewPickIndex = 0;
let previewMode = previewQuery.get('mode') || 'create-filled';
let previewTheme = previewQuery.get('theme') || 'dark';
let previewLanguage = previewQuery.get('lang') || 'zh';
let previewRender;
const previewDirectory = new Map();
const previewList = async (input) => {
  const directory = input || 'D:\\Projects';
  if (/error/i.test(directory)) throw new Error('Preview folder is unavailable');
  const names = ['DeepSeek Harness','DSH custom plugin','设计资源与共享组件','very-long-project-folder-name-for-responsive-layout','.private'];
  const custom = previewDirectory.get(directory) || [];
  return {path:directory,home:'D:\\Projects',separator:'\\',entries:[...names,...custom].map(name => ({name,path:directory.replace(/\\$/,'')+'\\'+name,hidden:name.startsWith('.')}))};
};
const previewCreateDirectory = async (parent,name) => {
  previewDirectory.set(parent,[...(previewDirectory.get(parent)||[]),name]);
  return parent.replace(/\\$/,'')+'\\'+name;
};
const previewWorkspace = {workspaceId:'preview-workspace',title:'DSH 插件开发',path:previewFolders[0]};
const previewActions = {
  async loadState() {return {version:1,workspaces:{'preview-workspace':{path:previewFolders[0],roots:previewFolders.slice(1)}}};},
  listDirectory:previewList,
  createDirectory:previewCreateDirectory,
  pickDirectory:previewQuery.get('picker') === 'native' ? async () => previewFolders[previewPickIndex++ % previewFolders.length] : undefined,
  async submitCreate(value) {previewLastSubmit={kind:'create',...value};},
  async submitModify(value) {previewLastSubmit={kind:'modify',...value};},
  cancelDialog() {previewClosed=true;previewRender();},
};
const previewStyle = document.createElement('style');
previewStyle.textContent = MW_CSS + `
html,body,#root{width:100%;height:100%;margin:0}body{font:14px/1.6 "Segoe UI","Microsoft YaHei UI",sans-serif;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary)}
.preview-backdrop{position:fixed;inset:0;display:grid;grid-template-columns:220px 1fr;opacity:.75}.preview-sidebar{border-right:1px solid var(--dsw-alias-border-l2);padding:28px 20px}.preview-brand{font-size:17px;font-weight:650;letter-spacing:.12em;margin-bottom:42px}.preview-nav{margin:14px 0;font-size:13px;color:var(--dsw-alias-label-secondary)}.preview-content{padding:36px}.preview-ghost{height:12px;border-radius:3px;background:var(--dsw-alias-border-l2);margin:20px 0;max-width:520px}.preview-controls{position:fixed;z-index:3000;bottom:10px;right:12px;display:flex;flex-wrap:wrap;gap:7px;padding:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l3);border-radius:8px}.preview-controls button{font:12px "Segoe UI",sans-serif;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:5px;padding:5px 9px;cursor:pointer}.preview-controls button[aria-pressed=true]{border-color:#249bb8}.preview-reopen{position:fixed;z-index:1;inset:45% 35%;border:1px solid #249bb8;border-radius:8px}
`;
document.head.appendChild(previewStyle);
function PreviewForm() {
  const [name,setName] = React.useState('DSH 插件开发');
  const [folders,setFolders] = React.useState(previewFolders);
  const [browserOpen,setBrowserOpen] = React.useState(false);
  const [busy,setBusy] = React.useState(false);
  const nameRef = React.useRef(null);
  const text = mwI18nTranslator(previewLanguage);
  return h(Fragment,null,h(MwWorkspaceForm,{
    title:text('dialog.create.title'),name,nameRef,onNameChange:setName,folders,text,
    onAdd:() => setBrowserOpen(true),onRemove:index=>setFolders(previous=>previous.filter((_,at)=>at!==index)),
    onReorder:(from,to)=>setFolders(previous=>{const next=previous.slice();next.splice(to,0,next.splice(from,1)[0]);return next;}),
    lockPrimary:false,draggable:true,busy,submitDisabled:folders.length===0,
    busyLabel:text('action.creating'),submitLabel:text('action.create'),
    errors:previewQuery.has('error')?[text('error.submit')]:[],
    onCancel:()=>previewActions.cancelDialog(),
    onSubmit:()=>{setBusy(true);previewLastSubmit={kind:'form',name,primaryPath:folders[0],roots:folders.slice(1)};setTimeout(()=>setBusy(false),250);},
  }),h(FolderBrowser,{open:browserOpen,initialPath:'D:\\Projects',listDirectory:previewList,createDirectory:previewCreateDirectory,t:text,onClose:()=>setBrowserOpen(false),onConfirm:paths=>{setFolders(previous=>mwDlgMergeFolders(previous,paths));setBrowserOpen(false);}}));
}
function Preview() {
  const text=mwI18nTranslator(previewLanguage);
  const base = h('div',{className:'preview-backdrop','aria-hidden':true},h('aside',{className:'preview-sidebar'},h('div',{className:'preview-brand'},'DEEPSEEK HARNESS'),h('div',{className:'preview-nav'},'工作台'),h('div',{className:'preview-nav'},'工作区'),h('div',{className:'preview-nav'},'DSH 插件开发')),h('main',{className:'preview-content'},h('p',null,'Workspace / Projects'),h('div',{className:'preview-ghost'}),h('div',{className:'preview-ghost',style:{maxWidth:340}})));
  let dialog = null;
  if(!previewClosed) {
    if(previewMode==='create-empty') dialog=h(CreateWorkspaceDialog,{actions:previewActions,t:text,dialog:{mode:'create'}});
    else if(previewMode==='modify') dialog=h(ModifyWorkspaceDialog,{actions:previewActions,t:text,dialog:{mode:'modify',workspace:previewWorkspace}});
    else if(previewMode==='browser') dialog=h(FolderBrowser,{open:true,initialPath:'D:\\Projects',listDirectory:previewList,createDirectory:previewCreateDirectory,t:text,onClose:()=>previewActions.cancelDialog(),onConfirm:paths=>{previewLastSubmit={kind:'browser',paths};previewActions.cancelDialog();}});
    else dialog=h(PreviewForm);
  }
  const controls = previewQuery.get('controls')==='0'?null:h('div',{className:'preview-controls'},
    ...['create-empty','create-filled','modify','browser'].map(mode=>h('button',{key:mode,onClick:()=>globalThis.__mwPreview.setMode(mode),'aria-pressed':previewMode===mode},mode)),
    h('button',{onClick:()=>globalThis.__mwPreview.setTheme(previewTheme==='dark'?'light':'dark')},previewTheme),h('button',{onClick:()=>globalThis.__mwPreview.setLanguage(previewLanguage==='zh'?'en':'zh')},previewLanguage));
  return h(Fragment,null,base,dialog,controls);
}
const previewRoot=createRoot(document.getElementById('root'));
let previewRevision=0;
previewRender=()=>{document.body.toggleAttribute('data-ds-dark-theme',previewTheme==='dark');document.documentElement.style.colorScheme=previewTheme;previewRoot.render(h(Preview,{key:++previewRevision}));};
globalThis.__mwPreview={
  ready:true,
  setMode(mode){previewMode=mode;previewClosed=false;previewLastSubmit=null;previewPickIndex=0;previewRender();},
  setTheme(theme){previewTheme=theme;previewRender();},
  setLanguage(language){previewLanguage=language;previewRender();},
  getState(){return {mode:previewMode,theme:previewTheme,language:previewLanguage,closed:previewClosed,lastSubmit:previewLastSubmit};},
};
previewRender();
