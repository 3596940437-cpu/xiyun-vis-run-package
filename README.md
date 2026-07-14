请进入仓库的 Releases，下载 xiyun-vis-run-package-full-v1.0.0.zip，解压后双击 start-web.bat。

完整向量索引通过 Git LFS 保存；Release 压缩包已包含全部数据。

所以main 可以用，但要用 Git LFS 克隆：
git lfs install
git clone https://github.com/3596940437-cpu/xiyun-vis-run-package.git

直接点 GitHub 的 Code -> Download ZIP 不行，它不会带上 LFS 中的完整向量索引。推荐直接下载 Release 的完整运行包。
