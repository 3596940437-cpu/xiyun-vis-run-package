'''
1. 创建 FastAPI 后端应用
2. 允许前端跨域访问后端
3. 把 graph / play / cluster / search 这些接口模块挂载到统一路径
4. 提供 /health 测试接口
'''

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import graph, play, cluster, search, ai, report

app = FastAPI(title="戏韵千秋 API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 联调阶段先放开，提交前可改成前端域名
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(graph.router, prefix="/api/graph", tags=["graph"])
app.include_router(play.router, prefix="/api/play", tags=["play"])
app.include_router(cluster.router, prefix="/api/cluster", tags=["cluster"])
app.include_router(search.router, prefix="/api/search", tags=["search"])
app.include_router(ai.router, prefix="/api/ai", tags=["ai"])
app.include_router(report.router, prefix="/api/report", tags=["report"])

@app.get("/health")
def health():
    return {"status": "ok"}
