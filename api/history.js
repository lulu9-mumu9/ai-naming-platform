/**
 * 历史记录接口：GET /api/history  → 返回最近 20 条起名记录
 * 前端进入页面、以及每轮生成结束后调用一次
 */
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: '只支持 GET 请求' });
    return;
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    res.status(200).json({ records: [], warning: 'Supabase 环境变量未配置' });
    return;
  }

  try {
    const supabase = createClient(url, key);
    const { data, error } = await supabase
      .from('name_history')
      .select('id, user_requirement, name_result, model_name, created_at')
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      res.status(500).json({ error: error.message, records: [] });
      return;
    }
    res.status(200).json({ records: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message, records: [] });
  }
};
