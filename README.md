# DSH 多文件夹工作区

非官方社区插件，包名 dsh-multi-workspace，版本 **1.0.0**。适配 Windows x64 / DeepSeek Harness Desktop **0.2.1-rc.2**。
为 DSH 添加多文件夹工作区。创建时可添加多个目录并拖动排序；已有工作区可改名、添加或移除成员目录。

## 安装

普通用户从 Releases 下载完整安装 ZIP 并解压。完全退出 DSH（包括托盘），先运行“检查环境.cmd”，再运行“安装.cmd”，完成后重启 DSH。卸载同样先退出 DSH，再运行“卸载.cmd”。

本源码目录已包含运行所需的预构建 lib/，可在完成必要依赖恢复后直接使用根目录的同名 CMD。无需另外安装 Node、Python 或 npm 运行依赖；安装器使用本机 DSH 自带 CLI，离线注册。

安装位置为 <DSH_HOME>/custom-plugins/dsh-multi-workspace/<profile>；默认 profile 为 desktop。安装前备份，失败尝试回滚，备份位于 <DSH_HOME>/backups/dsh-multi-workspace/。不主动关闭用户进程。

自定义路径可执行 `tools/portable.ps1 -Mode Check -DshPath <DSH安装目录> -DshHome <DSH数据目录> -Profile desktop`，确认后将 Check 改为 Install 或 Uninstall。Check 为只读。

## 使用与范围

使用 Ctrl+O 或侧栏“添加工作区”打开创建界面；已有工作区通过右侧菜单的“修改工作区”管理。第一项为主文件夹，修改已有工作区时主文件夹固定。

成员目录会写入该工作区会话的提示词。主文件夹外的写入仍使用 DSH 原生提权审批；@file 补全、右侧文件树及变更统计仍以主文件夹为准。插件不复制、移动或删除用户文件。

## 公开源码

本目录保留预构建运行文件、必要说明、安装器和许可证。测试、构建分片、内部设计、上传备忘、日志、截图和本机验收记录留在维护工作区。package.json 不保留未分发的开发脚本。根目录 SHA256SUMS.txt 校验随源码分发的文件；安装 ZIP 另有独立的整包校验。

MIT，见 LICENSE。
