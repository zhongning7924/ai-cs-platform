import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchFeedbackOptions, sendFeedback, type FeedbackReasonOption, type FeedbackRating } from './api';
import { ThumbDownIcon, ThumbUpIcon } from './icons';

/**
 * 消息级评价（ADR-0009）。
 *
 * 交互上刻意做成两段：
 *   👍 一键完成——满意的人不该被迫走流程；
 *   👎 才展开原因——差评必须说清原因，否则这条数据除了拉低分数没有任何用途。
 *
 * 「正确答案应该是……」（选填）是整个闭环里最贵的一个输入：
 * 它把一条差评同时变成一条带标签的回归用例，不需要标注团队介入。
 */

const STORAGE_PREFIX = 'cs_fb:';

type Mode = 'idle' | 'reasons' | 'sending' | 'done';

function readStored(traceId: string): FeedbackRating | null {
  try {
    const v = window.localStorage.getItem(STORAGE_PREFIX + traceId);
    return v === 'up' || v === 'down' ? v : null;
  } catch {
    return null; // 隐私模式下 localStorage 会抛异常，不能因此让组件挂掉
  }
}

export function FeedbackBar({ traceId }: { traceId: string }) {
  const [mode, setMode] = useState<Mode>(() => (readStored(traceId) ? 'done' : 'idle'));
  const [submitted, setSubmitted] = useState<FeedbackRating | null>(() => readStored(traceId));
  const [options, setOptions] = useState<FeedbackReasonOption[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [correction, setCorrection] = useState('');
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /**
   * 展开差评面板后要把「提交」带进视野。
   * 消息列表会随新消息自动滚到底，但面板是原地展开的——列表高度突然长出来，
   * 滚动位置不动，提交按钮就被挤到可视区外了。用户会以为卡住。
   *
   * 依赖里必须带 options.length：首次展开时候选原因还没拉回来，
   * 面板是短的，等 chips 渲染完又长高一截，只滚一次仍然会切掉底部。
   */
  useEffect(() => {
    if (mode !== 'reasons') return;
    panelRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [mode, options.length]);

  useEffect(() => {
    if (mode !== 'reasons' || options.length) return;
    let alive = true;
    void fetchFeedbackOptions().then((list) => {
      if (alive) setOptions(list);
    });
    return () => {
      alive = false;
    };
  }, [mode, options.length]);

  const submit = useCallback(
    async (rating: FeedbackRating, reasons: string[]) => {
      setMode('sending');
      setError(null);
      try {
        await sendFeedback({
          traceId,
          rating,
          reasons,
          comment: comment.trim() || undefined,
          correctedAnswer: correction.trim() || undefined,
        });
        try {
          window.localStorage.setItem(STORAGE_PREFIX + traceId, rating);
        } catch {
          /* 存不下不影响这一次的提交结果 */
        }
        setSubmitted(rating);
        setMode('done');
      } catch (err) {
        setError((err as Error).message);
        setMode(rating === 'down' ? 'reasons' : 'idle');
      }
    },
    [traceId, comment, correction],
  );

  const toggle = (value: string) => {
    setPicked((prev) => {
      if (prev.includes(value)) return prev.filter((v) => v !== value);
      // 后端限制最多 4 个：原因标得太多等于没标，聚合时一条差评会同时进所有桶
      return prev.length >= 4 ? prev : [...prev, value];
    });
  };

  if (mode === 'done') {
    return (
      <div className="cs-fb cs-fb--done">
        <span className="cs-fb__thanks">
          {submitted === 'down' ? '收到，已转给产品和知识库同学' : '感谢反馈'}
        </span>
        <button
          type="button"
          className="cs-fb__undo"
          onClick={() => {
            // 同时清掉本地标记：否则刷新后又会显示"已反馈"，
            // 而库里其实已经追加了一条新的评价，两边对不上
            try {
              window.localStorage.removeItem(STORAGE_PREFIX + traceId);
            } catch {
              /* localStorage 不可用时忽略 */
            }
            setMode('idle');
            setSubmitted(null);
            setPicked([]);
            setComment('');
            setCorrection('');
          }}
        >
          改一下
        </button>
      </div>
    );
  }

  return (
    <div className="cs-fb">
      <div className="cs-fb__row">
        <button
          type="button"
          className={`cs-fb__btn ${submitted === 'up' ? 'is-active' : ''}`}
          disabled={mode === 'sending'}
          onClick={() => void submit('up', [])}
        >
          <ThumbUpIcon />
          有帮助
        </button>
        <button
          type="button"
          className={`cs-fb__btn ${mode === 'reasons' ? 'is-active' : ''}`}
          disabled={mode === 'sending'}
          onClick={() => setMode(mode === 'reasons' ? 'idle' : 'reasons')}
        >
          <ThumbDownIcon />
          没解决
        </button>
      </div>

      {mode === 'reasons' || mode === 'sending' ? (
        <div className="cs-fb__panel" ref={panelRef}>
          <div className="cs-fb__hint">哪里不对？（至少选一个）</div>
          <div className="cs-fb__chips">
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                className={`cs-fb__chip ${picked.includes(o.value) ? 'is-on' : ''}`}
                onClick={() => toggle(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>

          <textarea
            className="cs-fb__textarea"
            rows={2}
            maxLength={500}
            placeholder="正确答案应该是……（选填，但这条最有用：填了就会变成回归测试用例）"
            value={correction}
            onChange={(e) => setCorrection(e.target.value)}
          />
          <textarea
            className="cs-fb__textarea"
            rows={1}
            maxLength={200}
            placeholder="补充说明（选填）"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />

          {error ? <div className="cs-fb__error">{error}</div> : null}

          <div className="cs-fb__actions">
            <button
              type="button"
              className="cs-fb__cancel"
              onClick={() => setMode('idle')}
              disabled={mode === 'sending'}
            >
              取消
            </button>
            <button
              type="button"
              className="cs-fb__submit"
              disabled={picked.length === 0 || mode === 'sending'}
              onClick={() => void submit('down', picked)}
            >
              {mode === 'sending' ? '提交中…' : '提交'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
