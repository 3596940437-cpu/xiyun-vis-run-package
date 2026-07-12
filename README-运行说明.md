# 戏韵千秋可视化网站运行包

## 环境要求

- Windows 10/11
- Python 3.14（64 位；随包提供的离线依赖按此版本构建）

本包已包含前端构建产物、后端离线依赖包及运行所需的结构化数据；不需要 Node.js，也不需要运行 `npm install`。

## 启动方式

双击 `start-web.bat`。

或在 PowerShell 中执行：

```powershell
.\start-web.ps1
```

脚本会自动创建 `backend\.venv`，从 `backend\wheels` 安装 Python 依赖，启动后端和前端静态站点，并打开网页。

## 重装依赖

如果换了 Python 版本或依赖损坏：

```powershell
.\start-web.ps1 -Reinstall
```

## AI 问答配置

普通图谱、剧目详情、版本比较和结构化搜索不需要 API Key。

如果需要 AI 问答，复制 `backend\.env.example` 为 `backend\.env`，填写 API Key 和模型名，然后重新运行启动脚本。

为控制仓库体积，公开仓库不包含 `backend/vector_indexes` 和 `data/derived/v3_final/text_chunks.json`。下载后可直接启动并使用图谱、剧目详情、版本比较、结构化搜索和缓存问答。逐句全文命中与完整向量检索需要额外的原始文本切片数据。

如已从项目数据源取得 `text_chunks.json`，请在安装兼容版本的 `faiss-cpu` 后，将它放入 `data/derived/v3_final/`，并在配置 `backend\.env` 后执行以下命令，即可在本地重建完整向量索引：

```powershell
Set-Location backend
.\.venv\Scripts\python.exe scripts\build_rag_index.py --input ..\data\derived\v3_final\text_chunks.json --out vector_indexes\rag_chunks_bge_m3
```

该命令会调用配置的 embedding 模型，并在本地生成向量索引；生成的索引保存在本地，不需要提交到 GitHub。

## 停止服务

关闭脚本启动的 PowerShell 窗口，或在任务管理器结束对应的 `python` 进程。
