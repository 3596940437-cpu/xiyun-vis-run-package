# 戏韵千秋可视化网站运行包

## 环境要求

- Windows 10/11
- Python 3.14（64 位；随包提供的离线依赖按此版本构建）

本包已包含前端构建产物、后端离线依赖包、全文切片和预构建向量索引；不需要 Node.js，也不需要运行 `npm install`。

## 启动方式

双击 `start-web.bat`。

或在 PowerShell 中执行：

```powershell
.\start-web.ps1
```

脚本会自动创建 `backend\.venv`，从 `backend\wheels` 安装 Python 依赖，启动后端和前端静态站点，并打开网页。

## 完整下载

向量索引中的大文件由 Git LFS 保存。为获得与本地一致的完整功能，请使用安装了 Git LFS 的 Git 克隆仓库：

```powershell
git lfs install
git clone https://github.com/3596940437-cpu/xiyun-vis-run-package.git
```

克隆完成后，确认 `backend\vector_indexes\rag_chunks_bge_m3\embeddings.npy` 的文件大小约为 156 MB；若它只有几百字节，请在项目目录执行 `git lfs pull`。

不使用 Git 的情况下，直接下载并解压[完整运行包 v1.0.0](https://github.com/3596940437-cpu/xiyun-vis-run-package/releases/download/v1.0.0/xiyun-vis-run-package-full-v1.0.0.zip)，然后运行 `start-web.bat`。

## 重装依赖

如果换了 Python 版本或依赖损坏：

```powershell
.\start-web.ps1 -Reinstall
```

## AI 问答配置

普通图谱、剧目详情、版本比较和结构化搜索不需要 API Key。

如果需要 AI 问答，复制 `backend\.env.example` 为 `backend\.env`，填写 API Key 和模型名，然后重新运行启动脚本。

普通图谱、搜索、剧目详情、版本比较和完整文本检索不需要 API Key。AI 问答仍需在 `backend\.env` 中填写自己的 API Key；公开仓库不会包含个人密钥。

## 停止服务

关闭脚本启动的 PowerShell 窗口，或在任务管理器结束对应的 `python` 进程。
