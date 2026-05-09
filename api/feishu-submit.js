const axios = require('axios');

// 飞书配置 - 从环境变量读取
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const FEISHU_TABLE_APP_TOKEN = process.env.FEISHU_TABLE_APP_TOKEN || '';
const FEISHU_TABLE_ID = process.env.FEISHU_TABLE_ID || '';

let cachedToken = null;
let cachedExpireTime = 0;

const TOKEN_REFRESH_BUFFER = 5 * 60 * 1000;

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

async function getFeishuToken() {
  const now = Date.now();
  if (cachedToken && now < cachedExpireTime - TOKEN_REFRESH_BUFFER) {
    return cachedToken;
  }

  try {
    const response = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: FEISHU_APP_ID,
      app_secret: FEISHU_APP_SECRET
    });

    if (response.data.code === 0) {
      cachedToken = response.data.tenant_access_token;
      cachedExpireTime = now + response.data.expire * 1000;
      return cachedToken;
    } else {
      throw new Error(`获取Token失败: ${response.data.msg}`);
    }
  } catch (error) {
    console.error('获取飞书Token失败:', error.response?.data || error.message);
    throw error;
  }
}

async function batchCreateRecords(token, records) {
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_TABLE_APP_TOKEN}/tables/${FEISHU_TABLE_ID}/records/batch_create`;

  try {
    const response = await axios.post(url, {
      records: records.map(r => ({ fields: r }))
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    return response.data;
  } catch (error) {
    console.error('批量插入失败:', error.response?.data || error.message);
    throw error;
  }
}

module.exports = async (req, res) => {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const startTime = Date.now();

  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, error: '只支持POST请求' });
    }

    const { data } = req.body;

    if (!data || !Array.isArray(data) || data.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: '请求数据无效，data必须是非空数组' 
      });
    }

    if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
      return res.status(500).json({ 
        success: false, 
        error: '飞书应用配置未设置，请检查环境变量 FEISHU_APP_ID 和 FEISHU_APP_SECRET' 
      });
    }

    if (!FEISHU_TABLE_APP_TOKEN || !FEISHU_TABLE_ID) {
      return res.status(500).json({ 
        success: false, 
        error: '多维表格配置未设置，请检查环境变量 FEISHU_TABLE_APP_TOKEN 和 FEISHU_TABLE_ID' 
      });
    }

    console.log(`[${new Date().toLocaleTimeString()}] 收到同步请求，共 ${data.length} 条数据`);

    const token = await getFeishuToken();
    console.log('成功获取飞书Token');

    const batchSize = 50;
    const results = [];
    let successCount = 0;
    let failCount = 0;
    const errors = [];

    for (let i = 0; i < data.length; i += batchSize) {
      const batch = data.slice(i, i + batchSize);
      console.log(`处理批次 ${Math.floor(i / batchSize) + 1}，共 ${batch.length} 条数据`);

      const response = await batchCreateRecords(token, batch);

      if (response.code === 0 && response.data?.records) {
        response.data.records.forEach((record, idx) => {
          if (record.record_id) {
            successCount++;
            results.push(record);
          } else {
            failCount++;
            errors.push({ 
              index: i + idx, 
              error: record.msg || '插入失败',
              data: batch[idx]
            });
          }
        });
      } else {
        failCount += batch.length;
        errors.push({ 
          index: i, 
          error: response.msg || '批量插入失败',
          count: batch.length 
        });
      }
    }

    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;

    console.log(`同步完成: 成功 ${successCount} 条, 失败 ${failCount} 条, 耗时 ${duration.toFixed(2)}s`);

    if (failCount > 0) {
      res.status(200).json({ 
        success: true, 
        data: results,
        successCount,
        failCount,
        errors,
        duration: duration.toFixed(2),
        message: `部分数据插入成功，成功 ${successCount} 条，失败 ${failCount} 条`
      });
    } else {
      res.status(200).json({ 
        success: true, 
        data: results,
        successCount,
        failCount,
        duration: duration.toFixed(2),
        message: `成功插入 ${successCount} 条记录，耗时 ${duration.toFixed(2)}s`
      });
    }

  } catch (error) {
    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;

    console.error(`同步失败 (耗时 ${duration.toFixed(2)}s):`, error.response?.data || error.message);

    const errorMsg = error.response?.data?.msg || error.response?.data?.error?.message || error.message;
    const errorCode = error.response?.data?.code || error.response?.status || 500;

    res.status(500).json({ 
      success: false, 
      error: errorMsg,
      code: errorCode,
      duration: duration.toFixed(2),
      details: error.response?.data
    });
  }
};let cachedToken = null;
let cachedExpireTime = 0;

const TOKEN_REFRESH_BUFFER = 5 * 60 * 1000;
const MAX_RECORDS_PER_REQUEST = 500;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function setCorsHeaders(request, response) {
  const origin = request.headers.origin || '*';

  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Vary', 'Origin');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Feishu-Client-Key');
}

function json(response, status, payload) {
  response.status(status).json(payload);
}

function assertEnv() {
  const required = [
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'FEISHU_APP_TOKEN',
    'FEISHU_TABLE_ID',
  ];

  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`缺少环境变量：${missing.join(', ')}`);
  }
}

function validateRecords(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return 'records 必须是非空数组';
  }

  if (records.length > MAX_RECORDS_PER_REQUEST) {
    return `一次最多提交 ${MAX_RECORDS_PER_REQUEST} 条记录`;
  }

  const invalidIndex = records.findIndex((record) => {
    return (
      !record ||
      typeof record !== 'object' ||
      !record.fields ||
      typeof record.fields !== 'object' ||
      Array.isArray(record.fields)
    );
  });

  if (invalidIndex !== -1) {
    return `第 ${invalidIndex + 1} 条记录格式错误，需要形如 { fields: { 字段名: 字段值 } }`;
  }

  return null;
}

function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return 'data 必须是非空数组';
  }

  if (items.length > MAX_RECORDS_PER_REQUEST) {
    return `一次最多提交 ${MAX_RECORDS_PER_REQUEST} 条数据`;
  }

  return null;
}

function toTransactionTime(value) {
  if (!value || value === '-') {
    return Math.floor(Date.now() / 1000);
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return Math.floor(Date.now() / 1000);
  }

  return Math.floor(date.getTime() / 1000);
}

async function parseJson(response) {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw new Error('飞书返回了无法解析的内容');
  }
}

async function fetchJson(url, options, retries = 2) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, options);
      const data = await parseJson(response);

      if (!response.ok) {
        const error = new Error(data.msg || `请求失败：HTTP ${response.status}`);
        error.status = response.status;
        error.data = data;
        throw error;
      }

      return data;
    } catch (error) {
      lastError = error;

      const retryable =
        !error.status || error.status === 429 || (error.status >= 500 && error.status < 600);

      if (!retryable || attempt === retries) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }

  throw lastError;
}

async function getTenantAccessToken() {
  assertEnv();

  if (cachedToken && Date.now() < cachedExpireTime - TOKEN_REFRESH_BUFFER) {
    return cachedToken;
  }

  const data = await fetchJson(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: process.env.FEISHU_APP_ID,
        app_secret: process.env.FEISHU_APP_SECRET,
      }),
    },
    1
  );

  if (data.code !== 0) {
    throw new Error(data.msg || '获取飞书 token 失败');
  }

  cachedToken = data.tenant_access_token;
  cachedExpireTime = Date.now() + data.expire * 1000;

  return cachedToken;
}

async function uploadImageToFeishu(imageUrl, accessToken) {
  if (!imageUrl) return null;

  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) {
    throw new Error(`图片下载失败：HTTP ${imageResponse.status}`);
  }

  const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';
  const arrayBuffer = await imageResponse.arrayBuffer();

  if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
    throw new Error('图片超过 20MB，飞书不支持直接上传');
  }

  const extension = contentType.includes('png') ? 'png' : 'jpg';
  const fileName = `thumbnail_${Date.now()}.${extension}`;
  const form = new FormData();

  form.append('file_name', fileName);
  form.append('parent_type', 'bitable_image');
  form.append('parent_node', process.env.FEISHU_APP_TOKEN);
  form.append('size', String(arrayBuffer.byteLength));
  form.append('file', new Blob([arrayBuffer], { type: contentType }), fileName);

  const data = await fetchJson(
    'https://open.feishu.cn/open-apis/drive/v1/medias/upload_all',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: form,
    }
  );

  if (data.code !== 0) {
    throw new Error(data.msg || '图片上传飞书失败');
  }

  return {
    fileToken: data.data?.file_token,
    fileName,
    size: arrayBuffer.byteLength,
  };
}

async function buildRecordsFromItems(items, accessToken) {
  const records = [];

  for (const item of items) {
    let image = null;

    if (item.thumbnail) {
      try {
        image = await uploadImageToFeishu(item.thumbnail, accessToken);
      } catch (error) {
        console.warn(`图片上传失败，继续写入文字数据：${error.message}`);
      }
    }

    records.push({
      fields: {
        '小区名称': item.propertyName || '-',
        '面积': item.area || '-',
        '楼层': item.floorInfo || '-',
        '成交总价': item.totalPrice || '-',
        '成交时间': toTransactionTime(item.transactionTime),
        '成交人': item.agent || '-',
        '品牌': item.brand || '-',
        '电话': item.phone || '-',
        '门店': item.store || '-',
        '缩略图': image?.fileToken
          ? [
              {
                file_token: image.fileToken,
                name: image.fileName,
                size: image.size,
                type: image.fileName.endsWith('.png') ? 'image/png' : 'image/jpeg',
              },
            ]
          : [],
      },
    });
  }

  return records;
}

export default async function handler(request, response) {
  setCorsHeaders(request, response);

  if (request.method === 'OPTIONS') {
    return response.status(204).end();
  }

  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return json(response, 405, {
      success: false,
      error: '只支持 POST 请求',
    });
  }

  try {
    if (
      process.env.FEISHU_CLIENT_KEY &&
      request.headers['x-feishu-client-key'] !== process.env.FEISHU_CLIENT_KEY
    ) {
      return json(response, 401, {
        success: false,
        error: '无权限提交',
      });
    }

    const accessToken = await getTenantAccessToken();
    const items = request.body?.data;
    let records = request.body?.records;
    let validationError = items ? validateItems(items) : validateRecords(records);

    if (validationError) {
      return json(response, 400, {
        success: false,
        error: validationError,
      });
    }

    if (items) {
      records = await buildRecordsFromItems(items, accessToken);
    }

    const result = await fetchJson(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${process.env.FEISHU_APP_TOKEN}/tables/${process.env.FEISHU_TABLE_ID}/records/batch_create`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ records }),
      }
    );

    if (result.code !== 0) {
      return json(response, 400, {
        success: false,
        error: result.msg || '写入飞书失败',
        code: result.code,
      });
    }

    return json(response, 200, {
      success: true,
      data: result.data,
    });
  } catch (error) {
    return json(response, 500, {
      success: false,
      error: error.message || '服务器错误',
    });
  }
}
