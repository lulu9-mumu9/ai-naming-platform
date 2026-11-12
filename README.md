# AI 起名平台（多模型 · 流式输出 · 历史记录）

练习三的可运行代码。结构对应实验文档的四个阶段：

| 实验阶段 | 本项目里的对应物 |
| --- | --- |
| 阶段1 单模型跑通 | `api/name.js` 里的 `modelConfigMap.doubao` 一项 + 同一套调用代码 |
| 阶段2 多模型切换 | `modelConfigMap` 四个配置项 + 前端下拉框，主调用代码一行没改 |
| 阶段3 建表 | `supabase.sql` |
| 阶段4 上线 | `.gitignore` + `vercel.json` + 本文最后一节 |

## 文件说明

```
ai-naming-platform/
├─ package.json        依赖：@supabase/supabase-js、dotenv
├─ .gitignore          把 .env 挡在 GitHub 之外
├─ .env.example        环境变量模板（复制成 .env 再填密钥）
├─ vercel.json         函数超时时间 60s（流式输出需要）
├─ supabase.sql        建表 + 索引 + RLS 权限说明
├─ index.html          前端：需求输入、模型下拉框、流式结果、历史记录
└─ api/
   ├─ name.js          核心接口：统一 OpenAI 兼容请求 + SSE 转发 + 入库
   └─ history.js       历史记录查询接口
```

## 本地运行

```bash
npm install                     # 安装依赖
cp .env.example .env            # 然后编辑 .env，填 Supabase 与至少一个大模型的密钥
npm i -g vercel                 # 如果云电脑里还没有 vercel CLI
vercel dev                      # 启动预览，默认 http://localhost:3000
```

打开预览页 → 输入「男孩、国风、简约」→ 选模型 → 点「开始起名」，文字会逐字出现；
生成结束后打开 Supabase Table Editor，`name_history` 里会多一条记录。

## 关键实现（答辩/报告可引用）

1. **SSE 流式**：后端 `fetch` 上游时带 `stream: true`，逐块读取分片，把 `delta.content`
   以 `data: {...}` 事件转发给浏览器；前端用 `response.body.getReader()` 边读边渲染。
2. **一套代码适配四个模型**：四家平台都提供 OpenAI 兼容接口（`/chat/completions`、
   `Authorization: Bearer`、`messages` 入参），所以只要一个 `modelConfigMap` 存
   `baseURL / apiKeyEnv / model`，请求逻辑循环复用即可。
3. **密钥安全**：密钥只从 `process.env` 读取，`.env` 已写进 `.gitignore`；
   线上在 Vercel 面板里配置同一批变量。
4. **入库时机**：流式过程中边转发边拼接全文，流结束后一次性 `insert`，
   避免每个分片写一次数据库。

## 各平台接口地址（踩坑对照表）

| 模型 | baseURL | 备注 |
| --- | --- | --- |
| 豆包（火山方舟） | `https://ark.cn-beijing.volces.com/api/v3` | 若报 404，把 `v3` 换成 `v1` 试一次 |
| DeepSeek | `https://api.deepseek.com/v1` | 模型 `deepseek-chat` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | **必须带 compatible-mode** |
| Kimi | `https://api.moonshot.cn/v1` | 模型 `moonshot-v1-8k` |

地址都能用 `DOUBAO_BASE_URL` 这类环境变量覆盖，不用改代码。

## 部署到 GitHub + Vercel

1. `git status` 确认 `.env` 没被跟踪（`.gitignore` 已处理）。
2. 全部提交并推送到 GitHub `main` 分支（云电脑里让豆包执行
   「提交当前全部代码，推送到 GitHub main 分支，不要提交 .env」即可）。
3. Vercel → Add New → Project → 导入该仓库 → Framework 选 **Other**，不用改构建命令。
4. Settings → Environment Variables，把 `.env` 里的每一条都加进去（Production / Preview / Development 都勾）。
5. Deploy → 拿到 `https://xxx.vercel.app` 公网地址，外网可直接访问。

## 常见报错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `环境变量 XXX 未配置` | `.env` 没填或 Vercel 没加 | 补变量后重启 `vercel dev` / 重新部署 |
| `模型接口返回 401` | 密钥错或复制多了空格 | 重新复制官方 Key |
| `模型接口返回 404` | baseURL 不对 | 按上表核对，或用 `*_BASE_URL` 覆盖 |
| 页面有结果但历史为空 | 表没建 / RLS 未关 / 变量没配 | 执行 `supabase.sql`，检查 `SUPABASE_URL`、`ANON_KEY` |
| 部署后文字一次性出现 | Vercel 函数超时或代理缓冲 | 确认 `vercel.json` 生效，`X-Accel-Buffering: no` 已设置 |
| 通义千问报 unsupported | 用了普通地址 | 换成 `compatible-mode/v1` |
