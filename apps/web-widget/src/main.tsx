import './host.css';
import { mountWidget } from './widget/mount';

/**
 * 演示入口：模拟"商家宿主页"。
 * 真实接入时，宿主页只需引入挂件 SDK 产物（P2 提供 vite lib 构建的 IIFE/ESM bundle），
 * 调用方式与这里的 mountWidget 一致。
 */
const host = document.getElementById('cs-widget-root');
if (host) {
  mountWidget(host);
}
