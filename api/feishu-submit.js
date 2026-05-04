let cachedToken = null;
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
