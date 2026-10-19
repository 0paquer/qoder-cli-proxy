import {
  ClearOutlined,
  DownloadOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { Button, Input, Select, Space, Tooltip, message } from 'antd';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PageHeader, SectionCard } from '@/components/QpCard';
import { clearLogs, getLogs, type LogEntry } from '@/services/qoderproxy';

const LEVEL_OPTIONS = [
  { value: 'all', label: '全部级别' },
  { value: 'info', label: '信息' },
  { value: 'warn', label: '警告' },
  { value: 'error', label: '错误' },
];

const LEVEL_COLOR: Record<string, string> = {
  warn: '#d46b08',
  error: '#cf1322',
};

/** 单条日志行：时间戳（HH:mm:ss）+ 等宽正文，按级别着色。 */
function LogLine({ entry }: { entry: LogEntry }) {
  const ts = entry.ts ? entry.ts.slice(11, 23) : '';
  return (
    <div
      className="flex gap-2 py-0.5 leading-5 border-b border-black/[0.04]"
      style={entry.level !== 'info' ? { color: LEVEL_COLOR[entry.level] } : undefined}
    >
      <span className="shrink-0 select-none text-black/35">{ts}</span>
      <span className="break-all whitespace-pre-wrap">{entry.text}</span>
    </div>
  );
}

export default function LogsPage() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [level, setLevel] = useState<'all' | 'info' | 'warn' | 'error'>('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [polling, setPolling] = useState(false); // 自动刷新开关
  const boxRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef(search);
  searchRef.current = search;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getLogs({ limit: 1000, level, search: searchRef.current });
      setEntries(r.entries);
      setTotal(r.total);
    } catch {
      // 请求失败保留现有内容，不打断查看
    } finally {
      setLoading(false);
    }
  }, [level]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 自动刷新：追加式拉取（since 增量），避免整屏闪动
  useEffect(() => {
    if (!polling) return undefined;
    const timer = setInterval(async () => {
      try {
        const lastSeq = entries.length ? entries[entries.length - 1].seq : 0;
        const r = await getLogs({ limit: 1000, level, search: searchRef.current, since: lastSeq });
        if (r.entries.length) {
          setEntries((prev) => [...prev, ...r.entries].slice(-2000));
          setTotal(r.total);
        }
      } catch {
        // 静默重试
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [polling, level, entries]);

  // 新日志到达时自动滚到底部
  const lastSeq = entries.length ? entries[entries.length - 1].seq : 0;
  useEffect(() => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [lastSeq]);

  const handleClear = async () => {
    await clearLogs();
    setEntries([]);
    setTotal(0);
    message.success('日志缓冲已清空');
  };

  const handleDownload = () => {
    const lines = entries.map((e) => `${e.ts} [${e.level}] ${e.text}`);
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `qoder-proxy-logs-${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-6">
      <PageHeader title="系统日志" description="服务端运行输出（内存保留最近 2000 条），用于排查问题" />
      <SectionCard
        title="运行日志"
        accent="#4f46e5"
        extra={
          <Space wrap>
            <Input.Search
              allowClear
              placeholder="搜索日志内容"
              className="w-56"
              onSearch={(v) => setSearch(v.trim())}
            />
            <Select
              className="w-32"
              value={level}
              options={LEVEL_OPTIONS}
              onChange={(v) => setLevel(v)}
            />
            <Button type={polling ? 'primary' : 'default'} onClick={() => setPolling((p) => !p)}>
              {polling ? '自动刷新中' : '自动刷新'}
            </Button>
            <Tooltip title="下载当前过滤结果">
              <Button icon={<DownloadOutlined />} onClick={handleDownload} />
            </Tooltip>
            <Tooltip title="清空服务端日志缓冲">
              <Button icon={<ClearOutlined />} danger onClick={handleClear} />
            </Tooltip>
            <Button
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={refresh}
            />
          </Space>
        }
      >
        <div
          ref={boxRef}
          className="overflow-auto rounded-md border border-black/[0.06] bg-white px-3 py-2 font-mono text-xs"
          style={{ maxHeight: 'calc(100vh - 320px)', minHeight: 320 }}
        >
          {entries.length === 0 ? (
            <div className="py-16 text-center text-black/35">暂无匹配日志</div>
          ) : (
            entries.map((e) => <LogLine key={e.seq} entry={e} />)
          )}
        </div>
        <div className="mt-2 text-xs text-black/45">
          显示 {entries.length} 条 / 缓冲共 {total} 条{polling ? '，每 3 秒自动追加新日志' : ''}
        </div>
      </SectionCard>
    </div>
  );
}
