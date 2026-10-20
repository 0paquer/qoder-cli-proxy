import {
  ApiOutlined,
  ClearOutlined,
  FieldTimeOutlined,
  MessageOutlined,
  RobotOutlined,
  SendOutlined,
  UserSwitchOutlined,
} from '@ant-design/icons';
import { Button, Collapse, Segmented, Select, Spin, Tag, Tooltip, message } from 'antd';
import React, { useEffect, useRef, useState } from 'react';
import { PageHeader, SectionCard } from '@/components/QpCard';
import {
  listAccounts,
  listModels,
  prewarmChat,
  streamTestChat,
  testChat,
  type Account,
  type ChatTurn,
} from '@/services/qoderproxy';

interface ChatMsg extends ChatTurn {
  id: number;
  /** reasoning 模型的思考过程（reasoning_effort 开启时 CLI 返回）。 */
  thinking?: string;
  /** 仅 assistant 消息携带：耗时 / token 用量 / 错误信息。 */
  meta?: {
    durationMs?: number;
    usage?: { inputTokens: number; outputTokens: number };
    error?: string;
    code?: string;
  };
}

/** 思考过程折叠区：默认收起，流式生成中展开并跟随。 */
const ThinkingBlock: React.FC<{ thinking?: string; streaming: boolean; hasContent: boolean }> = ({
  thinking,
  streaming,
  hasContent,
}) => {
  if (!thinking) return null;
  return (
    <Collapse
      ghost
      size="small"
      className="mb-1 -ml-2"
      defaultActiveKey={streaming && !hasContent ? ['think'] : undefined}
      items={[
        {
          key: 'think',
          label: (
            <span className="text-[12px] text-gray-400">
              {streaming && !hasContent ? '思考中…' : '思考过程'}
            </span>
          ),
          children: (
            <div className="max-h-[200px] overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-indigo-100 pl-2.5 text-[13px] leading-relaxed text-gray-400">
              {thinking}
              {streaming && !hasContent && (
                <span className="ml-0.5 inline-block h-[12px] w-[2px] animate-pulse bg-indigo-300 align-middle" />
              )}
            </div>
          ),
        },
      ]}
    />
  );
};

let msgSeq = 0;
const nextMsgId = () => (msgSeq += 1);

const verifyTag = (s: Account['verifyStatus']) => {
  if (s === 'verified') return <Tag color="success">已验证</Tag>;
  if (s === 'failed') return <Tag color="error">验证失败</Tag>;
  return <Tag>未验证</Tag>;
};

/** 模型内部代号（与 CLI 交互用）：优先 modelId，兼容旧条目 value，静态表取 id。 */
const codeOf = (m: { modelId?: unknown; id?: string; value?: string }) =>
  String(m.modelId ?? '').trim() || String(m.id ?? m.value ?? '').trim();

/** 模型下拉标签：单行显示名称，免费为附加标签，右侧恒显 credit 倍率。 */
const modelOptionLabel = (m: {
  value?: string;
  id?: string;
  name?: string;
  displayName?: string;
  priceFactor?: number | null;
  isFree?: boolean;
}) => {
  const name = m.displayName || m.name || m.value || m.id;
  const rate = m.priceFactor ?? null;
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="min-w-0 truncate text-sm">
        {name}
        {m.isFree ? (
          <span className="ml-2 rounded bg-emerald-50 px-1.5 py-0.5 align-middle text-xs text-emerald-600">
            免费
          </span>
        ) : null}
      </span>
      <span className="shrink-0 text-xs text-gray-400">{rate != null ? `${rate}x` : ''}</span>
    </div>
  );
};

/** 默认选中：优先免费模型，其次 credit 倍率最低者；无倍率数据取第一个。返回内部代号。 */
const pickDefaultModel = (list: {
  id?: string;
  value: string;
  modelId?: unknown;
  priceFactor?: number | null;
  isFree?: boolean;
}[]) => {
  const rated = list.filter((m) => m.priceFactor != null);
  if (!rated.length) return list[0] ? codeOf(list[0]) : undefined;
  const best = [...rated].sort((a, b) => {
    if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
    return (a.priceFactor ?? 0) - (b.priceFactor ?? 0);
  })[0];
  return codeOf(best);
};

const PlaygroundPage: React.FC = () => {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [models, setModels] = useState<
    {
      id?: string;
      modelId?: string;
      value: string;
      name?: string;
      displayName?: string;
      priceFactor?: number | null;
      isFree?: boolean;
    }[]
  >([]);
  const [accountId, setAccountId] = useState<number | undefined>(undefined);
  const [model, setModel] = useState<string>('qoder-cn');
  const [turns, setTurns] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [mode, setMode] = useState<'stream' | 'nonstream'>('stream');
  const [streamingId, setStreamingId] = useState<number | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsSource, setModelsSource] = useState<'account' | 'static'>('static');
  // 用户手动选过模型后，列表刷新不再覆盖其选择
  const userPickedRef = useRef(false);
  // 流式请求的中止控制器（"停止"按钮用）
  const abortRef = useRef<AbortController | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);

  // 按需预热：切换模型/账号即后台补位该指纹的热进程，随后的首条消息走热路径。
  // fire-and-forget：服务端有冷却/池满门控，失败静默，绝不打扰操作。
  const firePrewarm = (accId: number | undefined, mdl: string) => {
    if (!accId) return;
    prewarmChat({ accountId: accId, model: mdl, stream: mode === 'stream' }).catch(() => {});
  };

  useEffect(() => {
    listAccounts()
      .then((r) => {
        setAccounts(r.accounts);
        const first = r.accounts.find((a) => a.enabled);
        if (first) setAccountId(first.id);
      })
      .catch((e) => message.error(e?.message || '账号加载失败'));
  }, []);

  // 按所选账号拉取真实模型列表（SDK 模型目录，零 token 消耗）
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false; // 快速切换账号时旧响应后到，不再覆盖新列表
    setLoadingModels(true);
    // 切换账号先清空旧列表：未缓存账号拉目录需数秒，避免残留上一账号的模型误导选择
    setModels([]);
    listModels(accountId)
      .then((r) => {
        if (cancelled) return;
        setModels(r.models);
        setModelsSource(r.source ?? 'static');
        // 默认选中低倍率模型（免费优先，省 credits）；用户手动选过则保留
        setModel((cur) =>
          userPickedRef.current && r.models.some((m) => codeOf(m) === cur)
            ? cur
            : (pickDefaultModel(r.models) ?? cur),
        );
      })
      .catch(() => {
        // 失败同样清空：宁空勿错，配合「静态表」提示说明原因
        if (!cancelled) {
          setModels([]);
          setModelsSource('static');
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns, sending]);

  const send = async () => {
    const text = input.trim();
    if (!text || !accountId || sending) return;
    const history: ChatMsg[] = [...turns, { id: nextMsgId(), role: 'user', content: text }];
    setTurns(history);
    setInput('');
    setSending(true);
    const payload = history.map(({ role, content }) => ({ role, content }));

    if (mode === 'nonstream') {
      try {
        const res = await testChat({ accountId, model, messages: payload });
        if (res.ok) {
          setTurns((prev) => [
            ...prev,
            {
              id: nextMsgId(),
              role: 'assistant',
              content: res.content ?? '',
              thinking: res.thinking,
              meta: { durationMs: res.durationMs, usage: res.usage ?? undefined },
            },
          ]);
        } else {
          setTurns((prev) => [
            ...prev,
            {
              id: nextMsgId(),
              role: 'assistant',
              content: '',
              meta: { error: res.error || '调用失败', code: res.code, durationMs: res.durationMs },
            },
          ]);
        }
      } catch (e: any) {
        const detail = e?.data?.error?.message || e?.message || '网络错误';
        setTurns((prev) => [
          ...prev,
          {
            id: nextMsgId(),
            role: 'assistant',
            content: '',
            meta: { error: detail, code: e?.data?.error?.code },
          },
        ]);
      } finally {
        setSending(false);
      }
      return;
    }

    // 流式：先挂出空的 assistant 气泡，增量内容实时追加。
    const assistantId = nextMsgId();
    setStreamingId(assistantId);
    setTurns((prev) => [...prev, { id: assistantId, role: 'assistant', content: '' }]);
    const patch = (updater: (t: ChatMsg) => ChatMsg) =>
      setTurns((prev) => prev.map((t) => (t.id === assistantId ? updater(t) : t)));
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const done = await streamTestChat(
        { accountId, model, messages: payload },
        (delta) => {
          patch((t) => ({ ...t, content: t.content + delta }));
        },
        // 思考增量：实时追加；done 兜底覆盖（CLI 聚合行为差异时补全文）
        (delta) => {
          patch((t) => ({ ...t, thinking: (t.thinking ?? '') + delta }));
        },
        controller.signal,
      );
      if (done.ok) {
        patch((t) => ({
          ...t,
          content: done.content ?? t.content,
          thinking: done.thinking ?? t.thinking,
          meta: { durationMs: done.durationMs, usage: done.usage ?? undefined },
        }));
      } else {
        patch((t) => ({
          ...t,
          meta: { error: done.error || '调用失败', code: done.code, durationMs: done.durationMs },
        }));
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        patch((t) => ({ ...t, meta: { error: '已手动停止', durationMs: t.meta?.durationMs } }));
      } else {
        const detail = e?.data?.error?.message || e?.message || '网络错误';
        patch((t) => ({
          ...t,
          meta: { error: detail, code: e?.data?.error?.code },
        }));
      }
    } finally {
      abortRef.current = null;
      setStreamingId(null);
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const currentAccount = accounts.find((a) => a.id === accountId);

  return (
    <div className="p-6">
      <PageHeader
        title="测试对话"
        description="指定账号直连调用，绕过调度与配额，用于验证账号可用性"
      />
      <SectionCard
        title="会话"
        accent="#4f46e5"
        extra={
          <div className="flex items-center gap-2">
            <Segmented
              size="small"
              value={mode}
              disabled={sending}
              onChange={(v) => setMode(v as 'stream' | 'nonstream')}
              options={[
                { label: '流式', value: 'stream' },
                { label: '非流式', value: 'nonstream' },
              ]}
            />
            {sending && mode === 'stream' && (
              <Tooltip title="中止当前流式请求">
                <Button danger size="small" onClick={() => abortRef.current?.abort()}>
                  停止
                </Button>
              </Tooltip>
            )}
            <Tooltip title="清空会话">
              <Button
                icon={<ClearOutlined />}
                disabled={!turns.length || sending}
                onClick={() => setTurns([])}
              >
                清空
              </Button>
            </Tooltip>
          </div>
        }
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <div className="mb-1 flex items-center gap-1.5 text-[13px] font-medium text-gray-500">
              <UserSwitchOutlined className="text-indigo-400" />
              Qoder 账号
            </div>
            <Select
              className="w-full"
              placeholder="选择账号"
              value={accountId}
              onChange={(v) => {
                setAccountId(v);
                firePrewarm(v, model);
              }}
              disabled={sending}
              options={accounts.map((a) => ({
                value: a.id,
                disabled: !a.enabled,
                label: (
                  <span className="flex items-center gap-2">
                    <span>{a.name}</span>
                    {verifyTag(a.verifyStatus)}
                    {!a.enabled && <Tag>已停用</Tag>}
                  </span>
                ),
              }))}
            />
          </div>
          <div>
            <div className="mb-1 flex items-center gap-1.5 text-[13px] font-medium text-gray-500">
              <RobotOutlined className="text-indigo-400" />
              模型
              {modelsSource === 'static' && !loadingModels && (
                <span className="text-[11px] font-normal text-gray-400">（静态表，真实列表获取失败）</span>
              )}
            </div>
            <Select
              className="w-full"
              placeholder={loadingModels ? '正在加载模型列表…' : '选择模型'}
              value={loadingModels ? undefined : model}
              notFoundContent={loadingModels ? <Spin size="small" /> : undefined}
              onChange={(v) => {
                userPickedRef.current = true;
                setModel(v);
                firePrewarm(accountId, v);
              }}
              disabled={sending}
              loading={loadingModels}
              showSearch
              filterOption={(input, option) =>
                String((option as { searchText?: string })?.searchText ?? '').includes(
                  input.toLowerCase(),
                )
              }
              options={models.map((m) => ({
                value: codeOf(m),
                label: modelOptionLabel(m),
                searchText: `${m.displayName ?? ''} ${m.modelId ?? ''} ${m.value}`.toLowerCase(),
              }))}
            />
          </div>
        </div>

        <div className="mt-4 flex h-[calc(100vh-380px)] min-h-[320px] flex-col overflow-hidden rounded-xl border border-gray-100 bg-gradient-to-b from-[#f8f9fe] to-[#f4f6fb]">
          <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
            {!turns.length && !sending && (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-500 text-[22px] text-white shadow-[0_8px_20px_rgba(99,102,241,0.35)]">
                  <MessageOutlined />
                </div>
                <div>
                  <div className="text-[14px] font-medium text-gray-600">
                    {currentAccount ? '开始一段测试对话' : '请先选择一个 Qoder 账号'}
                  </div>
                  <div className="mt-1 text-[12px] text-gray-400">
                    {currentAccount
                      ? '请求将直接使用所选账号的 PAT 调用 Qoder，不经过调度与配额'
                      : '在上方选择账号后即可发送消息'}
                  </div>
                </div>
              </div>
            )}
            {turns.map((t) =>
              t.role === 'user' ? (
                <div key={t.id} className="flex justify-end">
                  <div className="max-w-[75%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-gradient-to-r from-indigo-600 to-purple-600 px-4 py-2.5 text-[14px] leading-relaxed text-white shadow-[0_2px_10px_rgba(79,70,229,0.28)]">
                    {t.content}
                  </div>
                </div>
              ) : (
                <div key={t.id} className="flex justify-start gap-2.5">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-purple-600 text-[12px] font-bold text-white shadow-[0_2px_8px_rgba(79,70,229,0.25)]">
                    Q
                  </div>
                  <div className="max-w-[75%] min-w-0">
                    <ThinkingBlock
                      thinking={t.thinking}
                      streaming={t.id === streamingId}
                      hasContent={Boolean(t.content)}
                    />
                    {t.content && (
                      <div className="whitespace-pre-wrap break-words rounded-2xl rounded-tl-md border border-gray-100 bg-white px-4 py-2.5 text-[14px] leading-relaxed text-gray-800 shadow-[0_1px_4px_rgba(15,23,42,0.05)]">
                        {t.content}
                        {t.id === streamingId && (
                          <span className="ml-0.5 inline-block h-[14px] w-[2px] animate-pulse bg-indigo-500 align-middle" />
                        )}
                      </div>
                    )}
                    {t.meta?.error && (
                      <div
                        className={`flex items-start gap-2 whitespace-pre-wrap break-words rounded-xl border border-red-100 bg-red-50 px-3.5 py-2.5 text-[14px] text-red-600 ${
                          t.content ? 'mt-2' : ''
                        }`}
                      >
                        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-100 text-[11px] font-bold text-red-500">
                          !
                        </span>
                        <span>
                          {t.meta.code ? <span className="font-mono">{t.meta.code}: </span> : null}
                          {t.meta.error}
                        </span>
                      </div>
                    )}
                    {t.meta && !t.meta.error && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {t.id === streamingId ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-500">
                            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-400" />
                            生成中
                          </span>
                        ) : (
                          <>
                            <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500">
                              <FieldTimeOutlined />
                              {((t.meta.durationMs ?? 0) / 1000).toFixed(1)}s
                            </span>
                            {t.meta.usage && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500">
                                <ApiOutlined />
                                输入 {t.meta.usage.inputTokens} / 输出 {t.meta.usage.outputTokens}
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ),
            )}
            {sending && turns[turns.length - 1]?.role === 'user' && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-2xl rounded-tl-md border border-gray-100 bg-white px-4 py-2.5 text-[14px] text-gray-400 shadow-[0_1px_4px_rgba(15,23,42,0.05)]">
                  正在请求 Qoder
                  <span className="flex gap-1">
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-indigo-300"
                        style={{ animationDelay: `${i * 0.15}s` }}
                      />
                    ))}
                  </span>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
          <div className="border-t border-gray-100 bg-white/90 p-3.5 backdrop-blur">
            <div className="flex items-end gap-2">
              <textarea
                className="max-h-[120px] min-h-[42px] flex-1 resize-none rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-[14px] text-gray-800 outline-none transition-all focus:border-indigo-400 focus:shadow-[0_0_0_3px_rgba(99,102,241,0.12)]"
                placeholder="输入消息，Enter 发送，Shift+Enter 换行"
                rows={1}
                value={input}
                disabled={sending || !accountId}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
              />
              <Button
                type="primary"
                icon={<SendOutlined />}
                loading={sending}
                disabled={!input.trim() || !accountId}
                onClick={send}
              >
                发送
              </Button>
            </div>
          </div>
        </div>
      </SectionCard>
    </div>
  );
};

export default PlaygroundPage;
