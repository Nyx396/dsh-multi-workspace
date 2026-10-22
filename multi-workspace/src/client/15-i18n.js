/**
 * Locale dictionaries for dsh-multi-workspace.
 *
 * The plugin registers `MW_DICTS` through `ctx.locale.register(ns, locale, dict)`
 * (the wiring lives in 90-apply.js) and receives a bound `t(key, params)` from
 * there. Components never create their own translator: they use the injected
 * function, and fall back to this table only when no `t` is available (for
 * example while a fragment is rendered by the unit smoke harness).
 *
 * Keys are dotted, English-complete and use `{name}` placeholders. Both
 * dictionaries must keep the same key set; the smoke test enforces that.
 */

/** Locale namespace shared by every string this plugin contributes. */
const MW_I18N_NS = 'multi-workspace';

/** Simplified Chinese dictionary: the key-set source of truth. */
const MW_DICTS_ZH = {
  // Dialog chrome and fields.
  'dialog.create.title': '创建工作区',
  'dialog.modify.title': '修改工作区',
  'dialog.loading': '正在读取工作区…',
  'dialog.eyebrow': 'DSH / 工作台',
  'dialog.footnote': '文件夹保留在原位置',
  'overview.title': '一个工作区，多个文件夹',
  'overview.description': '把相关代码、文档与资源组织在一起。',
  'overview.summary': '工作区概览',
  'overview.folders': '个文件夹',
  'section.workspace': '工作区信息',
  'field.name.hint': '留空时使用主文件夹的名称。',
  'field.name.modifyHint': '留空时保留工作区的原名称。',
  'source.emptyTitle': '从第一个文件夹开始',
  'source.addMore': '继续关联项目文件夹',
  'source.count': '{n} 个',
  'source.reorderHint': '首项为主文件夹，拖动可调整顺序。',
  'source.lockedHint': '主文件夹已固定，成员文件夹可随时调整。',
  'field.name.label': '工作区名称',
  'field.name.placeholder': '工作区名称',
  'section.sourceFolder': '源文件夹',
  'badge.primary': '主文件夹',
  'source.addPrompt': '在此电脑上添加文件夹',
  'source.noSelection': '未选择文件夹',
  'source.removePrimaryHint': '主文件夹是会话的工作目录，不能移除；如需更换请重新创建工作区。',
  'source.primaryHint': '列表第一项是主文件夹；拖动文件夹行可调整顺序。',

  // Shared actions.
  'action.add': '添加',
  'action.addFolder': '添加文件夹',
  'action.addSelected': '添加所选',
  'action.cancel': '取消',
  'action.close': '关闭',
  'action.create': '创建',
  'action.creating': '正在创建…',
  'action.open': '打开',
  'action.remove': '移除',
  'action.removeFolder': '移除文件夹',
  'action.removeFolder.aria': '移除文件夹“{path}”',
  'action.dragFolder': '拖动调整顺序',
  'action.retry': '重试',
  'action.save': '保存',
  'action.saving': '正在保存…',

  // Stacked folder browser.
  'browser.title': '添加文件夹',
  'browser.path': '路径',
  'browser.up': '上一级',
  'browser.loading': '正在加载…',
  'browser.empty': '这个文件夹里没有可添加的子文件夹',
  'browser.truncated': '文件夹过多，仅显示开头部分。',
  'browser.showHidden': '显示隐藏文件夹',
  'browser.selectedCount': '已选择 {n} 个文件夹',
  'browser.noSelection': '未选择文件夹',
  'browser.selectFolder': '选择文件夹“{name}”',
  'browser.openFolder': '打开文件夹“{name}”',
  'browser.crumbs': '路径导航',
  'browser.newFolder': '新建文件夹',
  'browser.folderName': '文件夹名称',
  'browser.createFolder': '创建文件夹',
  'browser.cancelCreate': '取消新建',
  'browser.error': '无法读取文件夹：{message}',
  'browser.errorPath': '无法打开路径：{message}',
  'browser.errorCreate': '无法新建文件夹：{message}',
  'browser.nameRequired': '请输入文件夹名称',

  // Failures surfaced inside a dialog (role=alert), never thrown.
  'error.noFolder': '请至少添加一个文件夹',
  'error.noWorkspace': '找不到要修改的工作区',
  'error.submit': '无法创建工作区，请重试',
  'error.save': '无法保存工作区，请重试',
  'error.load': '无法读取工作区信息：{message}',
  'error.noAction': '当前界面无法执行该操作',

  // Workspace row menu augmentation (50-menu.js consumes these through t).
  'menu.modify': '修改工作区',
  'menu.modify.aria': '修改工作区“{name}”',
  'menu.modifyWorkspace': '修改工作区',
  'menu.modifyWorkspace.aria': '修改工作区“{name}”',
};

/** English dictionary, key-complete against the Chinese source of truth. */
const MW_DICTS_EN = {
  'dialog.create.title': 'New Workspace',
  'dialog.modify.title': 'Edit Workspace',
  'dialog.loading': 'Loading workspace…',
  'dialog.eyebrow': 'DSH / WORKBENCH',
  'dialog.footnote': 'Folders stay in their original location',
  'overview.title': 'One workspace. Connected folders.',
  'overview.description': 'Bring related code, documents and resources together.',
  'overview.summary': 'WORKSPACE OVERVIEW',
  'overview.folders': 'folders',
  'section.workspace': 'Workspace details',
  'field.name.hint': 'Leave blank to use the primary folder’s name.',
  'field.name.modifyHint': 'Leave blank to keep the current workspace name.',
  'source.emptyTitle': 'Start with your first folder',
  'source.addMore': 'Connect another project folder',
  'source.count': '{n} total',
  'source.reorderHint': 'The first folder is primary. Drag to reorder.',
  'source.lockedHint': 'The primary folder is fixed. Member folders can be changed.',
  'field.name.label': 'Workspace name',
  'field.name.placeholder': 'Workspace name',
  'section.sourceFolder': 'Source folders',
  'badge.primary': 'Primary folder',
  'source.addPrompt': 'Add a folder on this computer',
  'source.noSelection': 'No folders selected',
  'source.removePrimaryHint': 'The primary folder is the session working directory and cannot be removed. Create a new workspace to change it.',
  'source.primaryHint': 'The first row is the primary folder; drag folder rows to reorder them.',

  'action.add': 'Add',
  'action.addFolder': 'Add folder',
  'action.addSelected': 'Add selected',
  'action.cancel': 'Cancel',
  'action.close': 'Close',
  'action.create': 'Create',
  'action.creating': 'Creating…',
  'action.open': 'Open',
  'action.remove': 'Remove',
  'action.removeFolder': 'Remove folder',
  'action.removeFolder.aria': 'Remove folder "{path}"',
  'action.dragFolder': 'Drag to reorder',
  'action.retry': 'Retry',
  'action.save': 'Save',
  'action.saving': 'Saving…',

  'browser.title': 'Add folders',
  'browser.path': 'Path',
  'browser.up': 'Up one level',
  'browser.loading': 'Loading…',
  'browser.empty': 'This folder has no subfolders to add',
  'browser.truncated': 'Too many folders; only the beginning is shown.',
  'browser.showHidden': 'Show hidden folders',
  'browser.selectedCount': 'Selected {n} folder(s)',
  'browser.noSelection': 'No folders selected',
  'browser.selectFolder': 'Select folder "{name}"',
  'browser.openFolder': 'Open folder "{name}"',
  'browser.crumbs': 'Path',
  'browser.newFolder': 'New folder',
  'browser.folderName': 'Folder name',
  'browser.createFolder': 'Create folder',
  'browser.cancelCreate': 'Cancel',
  'browser.error': 'Could not read the folder: {message}',
  'browser.errorPath': 'Could not open the path: {message}',
  'browser.errorCreate': 'Could not create the folder: {message}',
  'browser.nameRequired': 'Enter a folder name',

  'error.noFolder': 'Add at least one folder',
  'error.noWorkspace': 'The workspace to edit was not found',
  'error.submit': 'Could not create the workspace. Try again.',
  'error.save': 'Could not save the workspace. Try again.',
  'error.load': 'Could not load workspace details: {message}',
  'error.noAction': 'This action is not available on this screen',

  'menu.modify': 'Edit Workspace',
  'menu.modify.aria': 'Edit workspace "{name}"',
  'menu.modifyWorkspace': 'Edit Workspace',
  'menu.modifyWorkspace.aria': 'Edit workspace "{name}"',
};

/** All dictionaries handed to `ctx.locale.register`. */
const MW_DICTS = Object.freeze({
  zh: Object.freeze(MW_DICTS_ZH),
  en: Object.freeze(MW_DICTS_EN),
});

/** Keys of the Chinese dictionary; useful to assert locale completeness. */
const MW_I18N_KEYS = Object.freeze(Object.keys(MW_DICTS_ZH));

/** Replace `{name}` placeholders without throwing on missing/odd values. */
function mwI18nFormat(template, params) {
  if (typeof template !== 'string') return '';
  if (!params || typeof params !== 'object') return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match);
}

/** Pick the dictionary for a BCP 47-ish locale id, defaulting to Chinese. */
function mwI18nDictionary(locale) {
  return /^en\b/i.test(String(locale || '')) ? MW_DICTS.en : MW_DICTS.zh;
}

/** Translate one key with `MW_DICTS`; used only when no injected `t` exists. */
function mwI18nTranslator(locale) {
  const primary = mwI18nDictionary(locale);
  return function translate(key, params) {
    const text = Object.prototype.hasOwnProperty.call(primary, key)
      ? primary[key]
      : MW_DICTS.zh[key];
    return mwI18nFormat(typeof text === 'string' ? text : key, params);
  };
}
