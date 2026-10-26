import { createRoot } from 'react-dom/client';
import widgetCss from './widget.css?inline';
import { Widget } from './Widget';

/**
 * 挂件挂载：Shadow DOM 样式隔离 + React root。
 * P2 演进为 SDK bundle：对外暴露 window.CSWidget.mount(host, options)。
 */
export function mountWidget(host: HTMLElement, title = '智能客服小智'): void {
  const shadow = host.attachShadow({ mode: 'open' });

  const styleEl = document.createElement('style');
  styleEl.textContent = widgetCss;
  shadow.appendChild(styleEl);

  const container = document.createElement('div');
  container.className = 'cs-widget-container';
  shadow.appendChild(container);

  createRoot(container).render(<Widget title={title} />);
}
