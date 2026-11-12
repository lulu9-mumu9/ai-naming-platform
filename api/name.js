/**
 * AI 起名平台 —— 后端接口（Vercel Serverless Function）
 * 功能：接收起名需求 → 调用所选大模型（流式）→ 边生成边返回 → 结束后写入 Supabase
 *
 * 核心思想：所有平台都提供 OpenAI 兼容接口（/chat/completions + stream:true），
 *          所以只写一套 fetch，靠 modelConfigMap 换地址、密钥、模型名即可切换模型。
 */
const { createClient } = require('@supabase/supabase-js');

/* ============ 1. 模型配置表：只改这里就能换模型 ============ */
const modelConfigMap = {
  doubao: {
    label: '豆包（火山方舟）',
    baseURL: process.env.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
    apiKeyEnv: 'DOUBAO_API_KEY',
    model: process.env.DOUBAO_MODEL || 'doubao-seed-1-6-250615'
  },
  deepseek: {
    label: 'DeepSeek',
    baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat'
  },
  qwen: {
    label: '通义千问 DashScope',
    baseURL: process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    model: process.env.QWEN_MODEL || 'qwen-plus'
  },
  kimi: {
    label: 'Kimi（月之暗面）',
    baseURL: process.env.KIMI_BASE_URL || 'https://api.moonshot.cn/v1',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    model: process.env.KIMI_MODEL || 'moonshot-v1-8k'
  }
};

/* ============ 2. Supabase 客户端（未配置时返回 null，便于本地空跑） ============ */
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

/* ============ 3. 提示词 ============ */
function buildMessages(requirement) {
  return [
    {
      role: 'system',
      content:
        '你是一位专业的中文起名顾问，擅长结合姓氏、性别、风格、寓意等要求起名。' +
        '回答要求：给出 3 组名字方案，每组用“**名字**”开头，后接一句话寓意解释（30 字以内），' +
        '最后补一句整体风格总结。语言简洁，不要客套话，不要重复用户的问题。'
    },
    {
      role: 'user',
      content: `起名需求：${requirement}\n请给出 3 组名字及寓意。`
    }
  ];
}

/* ============ 4. 主处理函数 ============ */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: '只支持 POST 请求' });
    return;
  }

  const body = req.body || {};
  const requirement = typeof body.requirement === 'string' ? body.requirement.trim() : '';
  const modelKey = body.modelKey || 'doubao';

  if (!requirement) {
    res.status(400).json({ error: '请先填写起名需求，例如：男孩、国风、简约' });
    return;
  }
  if (requirement.length > 500) {
    res.status(400).json({ error: '起名需求太长了，请控制在 500 字以内' });
    return;
  }

  const config = modelConfigMap[modelKey];
  if (!config) {
    res.status(400).json({ error: `未知模型：${modelKey}` });
    return;
  }

  const apiKey = process.env[config.apiKeyEnv];
  if (!apiKey) {
    res.status(400).json({ error: `环境变量 ${config.apiKeyEnv} 未配置，请检查 .env / Vercel 环境变量` });
    return;
  }

  /* ---- 4.1 先建 SSE 连接，前端才能“边生成边显示” ---- */
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write(': connected\n\n');

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  let fullText = '';
  try {
    /* ---- 4.2 统一的 OpenAI 兼容请求：所有模型共用这一段 ---- */
    const upstream = await fetch(`${config.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        stream: true,
        temperature: 0.7,
        messages: buildMessages(requirement)
      })
    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => '');
      send({ type: 'error', message: `模型接口返回 ${upstream.status}：${errText.slice(0, 300)}` });
      res.end();
      return;
    }

    /* ---- 4.3 读取上游 SSE 分片：原样转发 + 顺手拼接全文用于入库 ---- */
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith(':') || !line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content || '';
          if (delta) {
            fullText += delta;
            send({ type: 'delta', content: delta });
          }
        } catch {
          /* 单个分片解析失败不影响整体输出，跳过即可 */
        }
      }
    }

    /* ---- 4.4 本轮生成结束，写入 Supabase 历史记录 ---- */
    let saved = false;
    const supabase = getSupabase();
    if (supabase && fullText.trim()) {
      const { error } = await supabase.from('name_history').insert({
        user_requirement: requirement,
        name_result: fullText,
        model_name: config.label
      });
      saved = !error;
      if (error) console.error('[supabase insert error]', error.message);
    }

    send({ type: 'done', saved, model: config.label });
    res.end();
  } catch (err) {
    console.error('[name api error]', err);
    send({ type: 'error', message: `请求失败：${err.message || err}` });
    res.end();
  }
};
