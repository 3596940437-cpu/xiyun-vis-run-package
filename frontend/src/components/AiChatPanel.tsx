import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { api } from '../api/client';
import type { AiChatContext, AiChatHistoryTurn, AiChatResponse } from '../api/client';
import { COLORS } from '../constants/theme';

const EXPLORATION_PATHS = [
  '浏览星云总览，观察剧目聚类分布',
  '点选星团，查看代表剧目与聚合解释',
  '搜索并打开《空城计》，进入版本传承页',
  '查看版本河流、距离矩阵与情节差异',
  '向 AI 提问版本差异，点击证据引用高亮',
];

const DEMO_QUESTIONS = [
  '《空城计》的几个版本有什么不同？',
  '《空城计》的主要角色有哪些？',
  '我想从三国戏入门，推荐哪些剧目？',
  '包公戏有哪些共同特征？',
];

type AiPayloadObject = {
  answer?: unknown;
  evidence?: unknown;
  highlight_targets?: unknown;
  suggested_questions?: unknown;
  meta?: unknown;
};

function decodeLooseJsonString(value: string): string {
  return value
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .trim();
}

function tryExtractLooseAnswer(value: string): string | null {
  const text = value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  if (!text.includes('"answer"') && !text.includes("'answer'")) return null;

  const answerMatch = text.match(/["']answer["']\s*:\s*["']([\s\S]*?)(?=["']\s*,\s*["'](?:used_evidence_numbers|evidence|highlight_targets|suggested_questions|meta)["']\s*:|["']\s*\}\s*$)/);
  if (!answerMatch) return null;

  return decodeLooseJsonString(answerMatch[1]);
}

function tryParseJsonObject(value: string): AiPayloadObject | null {
  const text = value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  if (!text.startsWith('{') || !text.endsWith('}')) return null;

  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as AiPayloadObject : null;
  } catch {
    const looseAnswer = tryExtractLooseAnswer(text);
    return looseAnswer ? { answer: looseAnswer } : null;
  }
}

function normalizeAnswerText(value: unknown): string {
  if (value == null) return '';

  if (typeof value === 'string') {
    const parsed = tryParseJsonObject(value);
    if (parsed && 'answer' in parsed) return normalizeAnswerText(parsed.answer);

    return value
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  if (typeof value === 'object' && !Array.isArray(value) && 'answer' in value) {
    return normalizeAnswerText((value as AiPayloadObject).answer);
  }

  return String(value).trim();
}

function isEvidenceArray(value: unknown): value is AiChatResponse['evidence'] {
  return Array.isArray(value);
}

function isSuggestedQuestionArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function normalizeResponse(response: AiChatResponse) {
  const nested = typeof response.answer === 'string' ? tryParseJsonObject(response.answer) : null;
  const evidence = isEvidenceArray(response.evidence)
    ? response.evidence
    : isEvidenceArray(nested?.evidence)
      ? nested.evidence
      : [];
  const suggestedQuestions = isSuggestedQuestionArray(response.suggested_questions)
    ? response.suggested_questions
    : isSuggestedQuestionArray(nested?.suggested_questions)
      ? nested.suggested_questions
      : [];

  return {
    answer: normalizeAnswerText(response.answer),
    evidence,
    suggestedQuestions,
    meta: response.meta ?? {},
  };
}

export interface HighlightOptions {
  focus?: boolean;
}

interface AiExchange {
  id: number;
  question: string;
  response: AiChatResponse | null;
  loadingStage: 'retrieving' | 'generating' | null;
  error: string | null;
}

interface AiChatPanelProps {
  context?: AiChatContext;
  playTitle?: string;
  expanded?: boolean;
  collapsible?: boolean;
  defaultExpanded?: boolean;
  resizable?: boolean;
  initialHeight?: number;
  minHeight?: number;
  maxHeight?: number;
  onHighlight: (ids: string[], type?: string, options?: HighlightOptions) => void;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function AiChatPanel({
  context,
  playTitle,
  expanded = false,
  collapsible = true,
  defaultExpanded = false,
  resizable = false,
  initialHeight = 340,
  minHeight = 220,
  maxHeight = 620,
  onHighlight,
}: AiChatPanelProps) {
  const [open, setOpen] = useState(defaultExpanded);
  const [panelHeight, setPanelHeight] = useState(initialHeight);
  const [message, setMessage] = useState('');
  const [exchanges, setExchanges] = useState<AiExchange[]>([]);
  const [history, setHistory] = useState<AiChatHistoryTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeEvidence, setActiveEvidence] = useState<string | null>(null);
  const scrollBodyRef = useRef<HTMLDivElement | null>(null);

  const triggerHighlight = (ids: string[], type?: string) => {
    onHighlight(ids, type, { focus: true });
  };

  const startVerticalResize = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    if (!resizable || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    const startY = event.clientY;
    const startHeight = panelHeight;

    const move = (moveEvent: globalThis.PointerEvent) => {
      setPanelHeight(clamp(startHeight + startY - moveEvent.clientY, minHeight, maxHeight));
    };

    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
    window.addEventListener('pointercancel', stop, { once: true });
  }, [maxHeight, minHeight, panelHeight, resizable]);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q) return;
    setLoading(true);
    setMessage('');
    setActiveEvidence(null);
    const exchangeId = Date.now();
    setExchanges((items) => [
      ...items,
      {
        id: exchangeId,
        question: q,
        response: null,
        loadingStage: 'retrieving',
        error: null,
      },
    ]);
    let stageTimer: number | undefined;
    try {
      stageTimer = window.setTimeout(() => {
        setExchanges((items) => items.map((item) => (
          item.id === exchangeId
            ? { ...item, loadingStage: 'generating' }
            : item
        )));
      }, 1500);

      const recentHistory = history.slice(-6);
      const res = await api.aiChat(q, context, recentHistory);
      setExchanges((items) => items.map((item) => (
        item.id === exchangeId
          ? { ...item, response: res, loadingStage: null, error: null }
          : item
      )));
      setHistory((items) => {
        const next: AiChatHistoryTurn[] = [
          ...items,
          { role: 'user', content: q },
          { role: 'assistant', content: normalizeAnswerText(res.answer).slice(0, 800) },
        ];

        return next.slice(-8);
      });
    } catch (e) {
      setExchanges((items) => items.map((item) => (
        item.id === exchangeId
          ? {
              ...item,
              loadingStage: null,
              error: e instanceof Error ? e.message : 'AI 请求失败',
            }
          : item
      )));
    } finally {
      if (stageTimer) window.clearTimeout(stageTimer);
      setLoading(false);
    }
  };

  const handleEvidenceClick = (exchangeId: number, evidenceNo: number, target?: string, type?: string) => {
    setActiveEvidence(`${exchangeId}-${evidenceNo}`);
    if (target) triggerHighlight([target], type);
  };

  useEffect(() => {
    const body = scrollBodyRef.current;
    if (!body || exchanges.length === 0) return;
    body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' });
  }, [exchanges]);

  const toggleBtnStyle = {
    background: 'none',
    border: 'none',
    color: COLORS.sidebarAccent,
    fontSize: 12,
    cursor: 'pointer',
    padding: '2px 6px',
    fontWeight: 600,
  } as const;

  const contextLabel = context?.play_title
    ? `当前上下文：《${context.play_title}》`
    : context?.cluster_name
      ? `当前上下文：${context.cluster_name}`
      : '';

  if (collapsible && !open) {
    return (
      <div
        className="ai-panel-collapsed"
        style={{
          borderTop: `1px solid ${COLORS.sidebarBorder}`,
          background: COLORS.paper,
          padding: '10px 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 12, color: COLORS.sidebarAccent, fontWeight: 600 }}>AI 京剧导览</span>
        <button type="button" onClick={() => setOpen(true)} style={toggleBtnStyle} title="展开 AI 导览">
          ▲ 展开
        </button>
      </div>
    );
  }

  return (
    <div
      className="ai-panel-expanded"
      style={{
        borderTop: expanded ? 'none' : `1px solid ${COLORS.sidebarBorder}`,
        background: COLORS.paper,
        padding: collapsible ? '12px 16px 16px' : 16,
        height: resizable ? panelHeight : undefined,
        maxHeight: resizable ? `min(${maxHeight}px, calc(100vh - 120px))` : expanded ? '100%' : 'min(48vh, 420px)',
        minHeight: resizable ? minHeight : undefined,
        flex: expanded && !resizable ? 1 : undefined,
        flexShrink: resizable ? 0 : expanded ? 1 : 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {resizable && (
        <button
          type="button"
          className="ai-vertical-resize-handle"
          onPointerDown={startVerticalResize}
          aria-label="上下调整 AI 导览高度"
          title="拖动调整 AI 导览高度"
        />
      )}

      {!(expanded && !collapsible) && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h4 style={{ margin: 0, fontSize: 12, color: COLORS.sidebarAccent, fontWeight: 600 }}>AI 京剧导览</h4>
          {collapsible && (
            <button type="button" onClick={() => setOpen(false)} style={toggleBtnStyle} title="收起 AI 导览">
              ▼ 收起
            </button>
          )}
        </div>
      )}

      <div
        ref={scrollBodyRef}
        style={{ overflowY: 'auto', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        <div>
          <div style={{ fontSize: 11, color: COLORS.sidebarAccent, fontWeight: 600, marginBottom: 6 }}>推荐探索路径</div>
          <ol style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: COLORS.sidebarTextMuted, lineHeight: 1.55 }}>
            {EXPLORATION_PATHS.map((step) => (
              <li key={step} style={{ marginBottom: 2 }}>{step}</li>
            ))}
          </ol>
        </div>

        {contextLabel && (
          <div
            style={{
              fontSize: 11,
            }}
            className="paper-note"
          >
            {contextLabel}
          </div>
        )}

        <div>
          <div style={{ fontSize: 11, color: COLORS.sidebarAccent, fontWeight: 600, marginBottom: 6 }}>快捷提问</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {DEMO_QUESTIONS.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => send(q)}
                className="paper-mini-btn"
              >
                {q.length > 18 ? `${q.slice(0, 16)}…` : q}
              </button>
            ))}
          </div>
        </div>

        {exchanges.map((exchange) => {
          const normalizedResponse = exchange.response ? normalizeResponse(exchange.response) : null;
          return (
            <div key={exchange.id} className="ai-exchange">
              <div className="ai-user-question-row">
                <div className="ai-user-question-bubble">{exchange.question}</div>
              </div>

              {normalizedResponse && (
                <>
                  {normalizedResponse.meta.fallback && (
                    <p style={{ margin: '0 0 6px', fontSize: 10, color: COLORS.sidebarTextMuted }}>已使用缓存回答</p>
                  )}
                  <pre
                    className="paper-card-soft"
                    style={{
                      margin: 0,
                      whiteSpace: 'pre-wrap',
                      fontFamily: 'inherit',
                      fontSize: 12,
                      lineHeight: 1.55,
                      color: COLORS.sidebarText,
                      padding: '10px 12px',
                    }}
                  >
                    {normalizedResponse.answer}
                  </pre>

                  {normalizedResponse.evidence.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 11, color: COLORS.sidebarAccent, marginBottom: 6, fontWeight: 600 }}>
                        证据引用 · 点击高亮星云
                      </div>
                      {normalizedResponse.evidence.map((ev) => (
                        <button
                          key={`${exchange.id}-${ev.evidence_no}`}
                          type="button"
                          onClick={() => handleEvidenceClick(exchange.id, ev.evidence_no, ev.highlight_target, ev.highlight_type)}
                          style={{
                            display: 'block',
                            width: '100%',
                            textAlign: 'left',
                            marginBottom: 6,
                            fontSize: 11,
                            cursor: ev.highlight_target ? 'pointer' : 'default',
                          }}
                          className={`paper-evidence${activeEvidence === `${exchange.id}-${ev.evidence_no}` ? ' active' : ''}`}
                        >
                          <span style={{ color: COLORS.sidebarAccent, fontWeight: 600 }}>#{ev.evidence_no}</span>{' '}
                          {ev.display_text.slice(0, 100)}
                          {ev.display_text.length > 100 ? '…' : ''}
                          {ev.highlight_target && (
                            <span style={{ display: 'block', marginTop: 4, fontSize: 10, color: COLORS.sidebarAccent }}>
                              点击高亮并定位
                              {ev.highlight_type === 'play_group' ? '版本组' : ev.highlight_type === 'version' ? '版本' : ev.highlight_type === 'cluster' ? '星团' : '节点'}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}

                  {normalizedResponse.suggestedQuestions.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <div style={{ fontSize: 11, color: COLORS.sidebarAccent, marginBottom: 6, fontWeight: 600 }}>继续探索</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {normalizedResponse.suggestedQuestions.map((q) => (
                          <button
                            key={`${exchange.id}-${q}`}
                            type="button"
                            onClick={() => send(q)}
                            className="paper-secondary-btn"
                          >
                            {q}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}

              {exchange.loadingStage && (
                <div
                  className="ai-loading-line"
                  style={{
                    fontSize: 11,
                    color: COLORS.sidebarTextMuted,
                    lineHeight: 1.4,
                  }}
                >
                  {exchange.loadingStage === 'retrieving'
                    ? '正在检索证据…'
                    : '正在生成回答…'}
                </div>
              )}

              {exchange.error && <p style={{ margin: 0, fontSize: 12, color: '#c0392b' }}>{exchange.error}</p>}
            </div>
          );
        })}
      </div>

      <div className="ai-panel-input-dock">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(message);
          }}
          style={{ display: 'flex', gap: 8 }}
        >
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={playTitle ? `询问《${playTitle}》…` : '输入问题，探索京剧宇宙…'}
            style={{
              flex: 1,
              padding: '8px 12px',
              borderRadius: 8,
              fontSize: 13,
            }}
            className="paper-input"
          />
          <button
            type="submit"
            disabled={loading}
            style={{
              padding: '8px 14px',
              fontWeight: 700,
              cursor: loading ? 'wait' : 'pointer',
            }}
            className="paper-action"
          >
            {loading ? '…' : '问'}
          </button>
        </form>
      </div>
    </div>
  );
}
