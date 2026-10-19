const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');

/**
 * 读取 .env 文件，返回所有配置项
 * @returns {Object} 配置对象 { KEY: value, ... }
 */
function readEnv() {
  try {
    if (!fs.existsSync(ENV_PATH)) {
      return {};
    }
    const content = fs.readFileSync(ENV_PATH, 'utf-8');
    const config = {};
    const lines = content.split('\n');
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      
      if (key) {
        config[key] = value;
      }
    }
    
    return config;
  } catch (err) {
    console.error('[env-manager] Failed to read .env:', err.message);
    return {};
  }
}

/**
 * 写入单个环境变量到 .env
 * @param {string} key - 环境变量名
 * @param {string} value - 环境变量值
 */
function writeEnv(key, value) {
  try {
    let content = '';
    
    if (fs.existsSync(ENV_PATH)) {
      content = fs.readFileSync(ENV_PATH, 'utf-8');
    }
    
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^${escapedKey}=.*`, 'm');
    
    if (regex.test(content)) {
      // 更新已有配置
      content = content.replace(regex, `${key}=${value}`);
    } else {
      // 添加新配置
      if (content && !content.endsWith('\n')) {
        content += '\n';
      }
      content += `${key}=${value}\n`;
    }
    
    fs.writeFileSync(ENV_PATH, content);
    return { ok: true };
  } catch (err) {
    console.error('[env-manager] Failed to write .env:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * 批量写入环境变量到 .env
 * @param {Object} updates - { KEY: value, ... }
 */
function writeEnvBatch(updates) {
  try {
    let content = '';
    
    if (fs.existsSync(ENV_PATH)) {
      content = fs.readFileSync(ENV_PATH, 'utf-8');
    }
    
    for (const [key, value] of Object.entries(updates)) {
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`^${escapedKey}=.*`, 'm');
      
      if (regex.test(content)) {
        content = content.replace(regex, `${key}=${value}`);
      } else {
        if (content && !content.endsWith('\n')) {
          content += '\n';
        }
        content += `${key}=${value}\n`;
      }
    }
    
    fs.writeFileSync(ENV_PATH, content);
    return { ok: true };
  } catch (err) {
    console.error('[env-manager] Failed to write batch .env:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * 获取掩码后的 key（用于前端显示）
 * @param {string} key - 原始 key
 * @returns {string} 掩码后的 key
 */
function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '****' + key.slice(-4);
}

/**
 * 获取敏感字段列表（用于前端判断是否隐藏）
 * @param {string} key - 环境变量名
 * @returns {boolean} 是否敏感
 */
function isSensitiveKey(key) {
  const sensitivePatterns = ['TOKEN', 'KEY', 'SECRET', 'PASSWORD', 'PAT'];
  return sensitivePatterns.some(pattern => key.includes(pattern));
}

module.exports = {
  readEnv,
  writeEnv,
  writeEnvBatch,
  maskKey,
  isSensitiveKey,
  ENV_PATH,
};
