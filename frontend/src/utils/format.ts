import dayjs from 'dayjs';

const compactFmt = new Intl.NumberFormat('zh-CN', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** 紧凑数字显示（12.3万 / 1.2M 风格）。 */
export const fmtNum = (n?: number | null): string => compactFmt.format(Number(n ?? 0));

/**
 * SQLite CURRENT_TIMESTAMP 是 UTC 的 "YYYY-MM-DD HH:MM:SS"，
 * ISO 字符串则已带时区信息。统一转为本地时间显示。
 */
export const fmtTime = (value?: string | null, withSeconds = false): string => {
  if (!value) return '—';
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const d = dayjs(normalized);
  return d.isValid() ? d.format(withSeconds ? 'YYYY-MM-DD HH:mm:ss' : 'MM-DD HH:mm') : value;
};

export const fmtDuration = (ms?: number | null): string => {
  if (ms === null || ms === undefined) return '—';
  return Number(ms) >= 1000 ? `${(Number(ms) / 1000).toFixed(1)}s` : `${ms}ms`;
};

/** 把 SQLite/ISO 时间解析为本地时间（用于过期判断）。 */
export const parseDbTime = (value?: string | null): Date | null => {
  if (!value) return null;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
};
